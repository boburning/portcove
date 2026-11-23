//! GitHub REST request accounting shared by the update-check forecast, the running
//! client budget and bulk update checks.
//!
//! GitHub documents (REST API "Rate limits for the REST API" and "Best practices for
//! using the REST API") that a `304 Not Modified` answer to a conditional request is
//! exempt from the primary rate limit only when the request was correctly
//! authorized. An anonymous conditional request still counts. Anonymous and
//! authenticated requests also draw from different allowances, so every count here
//! is kept per credential. Forecasts are estimates; the running budget follows the
//! `x-ratelimit-*` and `retry-after` headers GitHub actually returns.
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::{StatusCode, header};
use sha2::{Digest, Sha256};

use crate::{
    PortcoveError, Result,
    failure::{FailureProvider, KnownFailureCause},
};

/// The allowance a GitHub API request draws from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum RequestCredential {
    /// No `Authorization` header: the per-address anonymous allowance. Managed
    /// scoped acquisition always sends this way, whatever the player's sign-in.
    Anonymous,
    /// A token's allowance, identified by an in-memory fingerprint, never the token.
    Authenticated(u64),
}

impl RequestCredential {
    pub(crate) fn for_token(token: Option<&str>) -> Self {
        match token {
            None => Self::Anonymous,
            Some(token) => {
                let digest = Sha256::digest(token.as_bytes());
                let mut fingerprint = [0_u8; 8];
                fingerprint.copy_from_slice(&digest[..8]);
                Self::Authenticated(u64::from_be_bytes(fingerprint))
            }
        }
    }

    pub(crate) fn is_authenticated(self) -> bool {
        matches!(self, Self::Authenticated(_))
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Anonymous => "anonymous",
            Self::Authenticated(_) => "authenticated",
        }
    }
}

/// Whether a request is expected to count against the primary limit before it is
/// sent. Only an authenticated request carrying a cache validator may be answered
/// with an exempt `304`; a changed resource still costs one counted request.
pub(crate) fn expected_to_count(credential: RequestCredential, conditional: bool) -> bool {
    !(credential.is_authenticated() && conditional)
}

/// Whether an answered request counted against the primary limit, by GitHub's
/// documented rule. Simulated providers in tests apply it to their own counts.
#[cfg(test)]
pub(crate) fn counted_against_primary_limit(
    credential: RequestCredential,
    status: StatusCode,
) -> bool {
    !(credential.is_authenticated() && status == StatusCode::NOT_MODIFIED)
}

/// The estimated cost of one ordinary GitHub check. `cached` lists, for every
/// metadata resource the check is expected to read, whether a validator for it is
/// persisted. Anonymous requests all count; an authenticated request counts unless
/// a validator lets GitHub answer `304`. The estimate assumes cached resources are
/// unchanged: each one that did change costs one more authenticated request.
pub(crate) fn ordinary_request_cost(
    credential: RequestCredential,
    cached: &[bool],
) -> crate::RequestCostForecast {
    let counted = cached
        .iter()
        .filter(|cached| expected_to_count(credential, **cached))
        .count();
    let counted = u32::try_from(counted).unwrap_or(u32::MAX);
    crate::RequestCostForecast {
        counted_requests: counted,
        // Signing in moves every ordinary anonymous request to the larger allowance.
        sign_in_relief_requests: if credential.is_authenticated() {
            0
        } else {
            counted
        },
    }
}

/// Managed scoped acquisition sends unconditional, unauthenticated requests by
/// contract: each counts against the anonymous allowance and sign-in never helps.
pub(crate) fn scoped_request_cost(requests: u32) -> crate::RequestCostForecast {
    crate::RequestCostForecast {
        counted_requests: requests,
        sign_in_relief_requests: 0,
    }
}

/// A budgeted path whose length does not depend on the persisted cache.
pub(crate) fn budgeted_request_cost(
    credential: RequestCredential,
    requests: u32,
) -> crate::RequestCostForecast {
    crate::RequestCostForecast {
        counted_requests: requests,
        sign_in_relief_requests: if credential.is_authenticated() {
            0
        } else {
            requests
        },
    }
}

/// GitHub's rate-limit response headers. Missing or malformed values stay unknown.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RateLimitHeaders {
    pub(crate) limit: Option<u64>,
    pub(crate) remaining: Option<u64>,
    pub(crate) used: Option<u64>,
    pub(crate) reset: Option<u64>,
    pub(crate) resource: Option<String>,
    pub(crate) retry_after: Option<u64>,
}

impl RateLimitHeaders {
    pub(crate) fn parse(headers: &header::HeaderMap) -> Self {
        let text = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
        };
        let number = |name: &str| text(name).and_then(|value| value.parse::<u64>().ok());
        Self {
            limit: number("x-ratelimit-limit"),
            remaining: number("x-ratelimit-remaining"),
            used: number("x-ratelimit-used"),
            reset: number("x-ratelimit-reset"),
            resource: text("x-ratelimit-resource").map(str::to_owned),
            // Only the delta-seconds form; an HTTP date is left to the defaults.
            retry_after: number(header::RETRY_AFTER.as_str()),
        }
    }
}

/// Without a usable `retry-after`, GitHub asks clients to wait at least a minute
/// after a secondary limit. A `retry-after` is honored up to an hour.
const SECONDARY_LIMIT_DEFAULT_WAIT: u64 = 60;
const RETRY_AFTER_MAX: u64 = 60 * 60;
/// Every metadata request Portcove sends is a REST `core` resource request.
const CORE_RESOURCE: &str = "core";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Allowance {
    limit: Option<u64>,
    remaining: Option<u64>,
    used: Option<u64>,
    reset: Option<u64>,
    blocked_until: Option<u64>,
}

/// What the running budget currently knows about one credential's allowance.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AllowanceSnapshot {
    pub(crate) limit: Option<u64>,
    pub(crate) remaining: Option<u64>,
    pub(crate) used: Option<u64>,
    pub(crate) reset: Option<u64>,
    pub(crate) blocked_until: Option<u64>,
}

/// The running GitHub request budget of one provider (and every clone of it),
/// kept separately for each credential. It starts unknown and learns only from
/// actual response headers; local reservations between answers are corrected by
/// the next answer. It lives in memory: after a restart GitHub's next answer
/// re-establishes it, and an exhausted allowance answers with its reset again.
#[derive(Clone, Debug, Default)]
pub(crate) struct GithubRequestBudget(Arc<Mutex<HashMap<RequestCredential, Allowance>>>);

impl GithubRequestBudget {
    /// Refuse a request locally when GitHub already reported the credential's
    /// allowance exhausted or asked the client to wait. Nothing is sent, and the
    /// refusal is a rate-limit failure, never an answer about the resource.
    ///
    /// An admitted request that is expected to count reserves one request until
    /// GitHub answers. Dropping the returned reservation without settling it (a
    /// transport failure, a deadline or a cancellation before any answer) returns
    /// the request to the allowance, so an unanswered request cannot shrink it.
    pub(crate) fn admit(
        &self,
        credential: RequestCredential,
        conditional: bool,
    ) -> Result<Reservation> {
        let reserved = self.admit_at(credential, conditional, unix_now())?;
        Ok(Reservation {
            budget: self.clone(),
            credential,
            reserved,
        })
    }

    /// Admits or refuses; returns the window of a reserved request, if any.
    fn admit_at(
        &self,
        credential: RequestCredential,
        conditional: bool,
        now: u64,
    ) -> Result<Option<u64>> {
        let mut allowances = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(allowance) = allowances.get_mut(&credential) else {
            return Ok(None);
        };
        if let Some(until) = allowance.blocked_until {
            if until > now {
                return Err(exhausted(credential, until));
            }
            allowance.blocked_until = None;
        }
        if allowance.reset.is_some_and(|reset| reset <= now) {
            // A new window: what is left is unknown until the next answer.
            allowance.remaining = None;
            allowance.used = None;
            allowance.reset = None;
        }
        match allowance.remaining {
            Some(0) => Err(exhausted(credential, allowance.reset.unwrap_or(now))),
            Some(remaining) => {
                if expected_to_count(credential, conditional) {
                    allowance.remaining = Some(remaining - 1);
                    return Ok(allowance.reset);
                }
                Ok(None)
            }
            None => Ok(None),
        }
    }

    /// Incorporate one actual GitHub answer.
    pub(crate) fn observe(
        &self,
        credential: RequestCredential,
        status: StatusCode,
        headers: &header::HeaderMap,
    ) {
        self.observe_at(
            credential,
            status,
            &RateLimitHeaders::parse(headers),
            unix_now(),
        );
    }

    fn observe_at(
        &self,
        credential: RequestCredential,
        status: StatusCode,
        headers: &RateLimitHeaders,
        now: u64,
    ) {
        if headers
            .resource
            .as_deref()
            .is_some_and(|resource| resource != CORE_RESOURCE)
        {
            return;
        }
        let mut allowances = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let allowance = allowances.entry(credential).or_default();
        if let (Some(remaining), Some(reset)) = (headers.remaining, headers.reset) {
            match allowance.reset {
                // Answers can arrive out of order within one window; keep the lowest.
                Some(current) if current == reset => {
                    allowance.remaining = Some(
                        allowance
                            .remaining
                            .map_or(remaining, |known| known.min(remaining)),
                    );
                    allowance.used = headers.used.max(allowance.used);
                }
                Some(current) if current > reset => {}
                _ => {
                    allowance.remaining = Some(remaining);
                    allowance.used = headers.used;
                    allowance.reset = Some(reset);
                }
            }
            allowance.limit = headers.limit.or(allowance.limit);
        }
        let limited = status == StatusCode::TOO_MANY_REQUESTS
            || (status == StatusCode::FORBIDDEN
                && (headers.remaining == Some(0) || headers.retry_after.is_some()));
        if limited {
            let wait = match (headers.retry_after, headers.remaining, headers.reset) {
                (Some(seconds), _, _) => seconds.min(RETRY_AFTER_MAX),
                (None, Some(0), Some(reset)) => reset.saturating_sub(now),
                _ => SECONDARY_LIMIT_DEFAULT_WAIT,
            };
            let until = now.saturating_add(wait.max(1));
            allowance.blocked_until = Some(
                allowance
                    .blocked_until
                    .map_or(until, |known| known.max(until)),
            );
        }
    }

    #[cfg(test)]
    pub(crate) fn snapshot(&self, credential: RequestCredential) -> Option<AllowanceSnapshot> {
        let allowances = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        allowances
            .get(&credential)
            .map(|allowance| AllowanceSnapshot {
                limit: allowance.limit,
                remaining: allowance.remaining,
                used: allowance.used,
                reset: allowance.reset,
                blocked_until: allowance.blocked_until,
            })
    }

    /// Return a reservation that never reached GitHub, if its window is current.
    fn release(&self, credential: RequestCredential, window: u64) {
        let mut allowances = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(allowance) = allowances.get_mut(&credential)
            && allowance.reset == Some(window)
            && let Some(remaining) = allowance.remaining
        {
            let restored = remaining.saturating_add(1);
            allowance.remaining = Some(
                allowance
                    .limit
                    .map_or(restored, |limit| restored.min(limit)),
            );
        }
    }
}

/// One admitted request's reservation; see [`GithubRequestBudget::admit`].
#[must_use]
pub(crate) struct Reservation {
    budget: GithubRequestBudget,
    credential: RequestCredential,
    reserved: Option<u64>,
}

impl Reservation {
    /// GitHub answered: its headers, not the reservation, now describe the allowance.
    pub(crate) fn settle(mut self) {
        self.reserved = None;
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(window) = self.reserved.take() {
            self.budget.release(self.credential, window);
        }
    }
}

fn exhausted(credential: RequestCredential, resets_at: u64) -> PortcoveError {
    PortcoveError::network(
        "GitHub reported this client's request allowance used up, or asked it to wait, so Portcove did not send the request.",
    )
    .with_known_cause(KnownFailureCause::ProviderAllowanceExhausted {
        provider: FailureProvider::Github,
        resets_at: i64::try_from(resets_at).ok(),
    })
    .detail("rate_limit_deferred", "true")
    .detail("rate_limit_credential", credential.label())
    .detail("rate_reset", resets_at.to_string())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Upper bound on response bytes one bulk check retains for sharing.
const SHARED_OBSERVATION_MAX_BYTES: usize = 64 * 1024 * 1024;

type SharedBody = Arc<tokio::sync::OnceCell<Arc<str>>>;

/// One bulk update check's shared upstream observations. Ordinary (non-scoped)
/// GitHub metadata of a repository that several checked games name is read once
/// per credential and reused for the rest of the same bulk check. Nothing outlives
/// the check, and managed scoped acquisition never reads from or writes to it.
#[derive(Debug)]
pub(crate) struct SharedObservations {
    /// Lower-case `owner/name` of repositories named by more than one game.
    repositories: HashSet<String>,
    bodies: Mutex<HashMap<(RequestCredential, String), SharedBody>>,
    retained_bytes: Mutex<usize>,
}

tokio::task_local! {
    static SHARED_OBSERVATIONS: Arc<SharedObservations>;
}

impl SharedObservations {
    pub(crate) fn new(repositories: impl IntoIterator<Item = String>) -> Self {
        Self {
            repositories: repositories
                .into_iter()
                .map(|repository| repository.to_ascii_lowercase())
                .collect(),
            bodies: Mutex::new(HashMap::new()),
            retained_bytes: Mutex::new(0),
        }
    }

    /// Run `future` (one bulk check) with these observations shared.
    pub(crate) async fn scope<F: Future>(self, future: F) -> F::Output {
        SHARED_OBSERVATIONS.scope(Arc::new(self), future).await
    }

    /// The observations of the bulk check running on this task, if any.
    pub(crate) fn current() -> Option<Arc<Self>> {
        SHARED_OBSERVATIONS.try_with(Arc::clone).ok()
    }

    fn shares(&self, repository: &str) -> bool {
        self.repositories.contains(&repository.to_ascii_lowercase())
    }

    /// The body for `url`, read at most once per credential within this check.
    /// A failed read is not retained, so a later game may try again (subject to
    /// the running budget).
    pub(crate) async fn body<F, Fut>(
        &self,
        credential: RequestCredential,
        repository: &str,
        url: &str,
        read: F,
    ) -> Result<(Arc<str>, bool)>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Arc<str>>>,
    {
        if !self.shares(repository) {
            return read().await.map(|body| (body, false));
        }
        let cell = {
            let mut bodies = self
                .bodies
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Arc::clone(
                bodies
                    .entry((credential, url.to_owned()))
                    .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new())),
            )
        };
        let mut read_here = false;
        let body = cell
            .get_or_try_init(|| async {
                read_here = true;
                read().await
            })
            .await?
            .clone();
        if read_here {
            let mut retained = self
                .retained_bytes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *retained = retained.saturating_add(body.len());
            if *retained > SHARED_OBSERVATION_MAX_BYTES {
                // Over the bound: stop retaining this body; later games read it again.
                *retained = retained.saturating_sub(body.len());
                self.bodies
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&(credential, url.to_owned()));
            }
        }
        Ok((body, !read_here))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate(remaining: u64, reset: u64) -> RateLimitHeaders {
        RateLimitHeaders {
            limit: Some(60),
            remaining: Some(remaining),
            used: Some(60 - remaining),
            reset: Some(reset),
            resource: Some("core".into()),
            retry_after: None,
        }
    }

    #[test]
    fn documented_accounting_exempts_only_an_authenticated_not_modified_answer() {
        let token = RequestCredential::for_token(Some("fixture-token"));
        assert!(token.is_authenticated());
        assert!(!counted_against_primary_limit(
            token,
            StatusCode::NOT_MODIFIED
        ));
        assert!(counted_against_primary_limit(token, StatusCode::OK));
        assert!(counted_against_primary_limit(
            RequestCredential::Anonymous,
            StatusCode::NOT_MODIFIED
        ));
        assert!(!expected_to_count(token, true));
        assert!(expected_to_count(token, false));
        assert!(expected_to_count(RequestCredential::Anonymous, true));
    }

    #[test]
    fn forecasts_count_anonymous_cached_reads_and_relieve_only_anonymous_ones() {
        let token = RequestCredential::for_token(Some("fixture-token"));
        let cost = |credential, cached: &[bool]| {
            let value = ordinary_request_cost(credential, cached);
            (value.counted_requests, value.sign_in_relief_requests)
        };
        // Anonymous: a cached validator saves nothing.
        assert_eq!(cost(RequestCredential::Anonymous, &[false, false]), (2, 2));
        assert_eq!(cost(RequestCredential::Anonymous, &[true, true]), (2, 2));
        // Authenticated: only uncached reads are expected to count; nothing to relieve.
        assert_eq!(cost(token, &[false, false]), (2, 0));
        assert_eq!(cost(token, &[true, false]), (1, 0));
        assert_eq!(cost(token, &[true, true]), (0, 0));
        assert_eq!(scoped_request_cost(3).sign_in_relief_requests, 0);
        assert_eq!(budgeted_request_cost(token, 41).sign_in_relief_requests, 0);
        assert_eq!(
            budgeted_request_cost(RequestCredential::Anonymous, 41).sign_in_relief_requests,
            41
        );
    }

    #[test]
    fn rate_limit_headers_are_read_without_guessing_missing_values() {
        let mut headers = header::HeaderMap::new();
        for (name, value) in [
            ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-remaining", "4999"),
            ("x-ratelimit-used", "1"),
            ("x-ratelimit-reset", "1700000000"),
            ("x-ratelimit-resource", "core"),
            ("retry-after", "Wed, 21 Oct 2015 07:28:00 GMT"),
        ] {
            headers.insert(name, header::HeaderValue::from_static(value));
        }
        assert_eq!(
            RateLimitHeaders::parse(&headers),
            RateLimitHeaders {
                limit: Some(5000),
                remaining: Some(4999),
                used: Some(1),
                reset: Some(1_700_000_000),
                resource: Some("core".into()),
                retry_after: None,
            }
        );
        assert_eq!(
            RateLimitHeaders::parse(&header::HeaderMap::new()),
            RateLimitHeaders::default()
        );
    }

    #[test]
    fn the_running_budget_follows_answers_per_credential_and_reopens_after_reset() {
        let budget = GithubRequestBudget::default();
        let anonymous = RequestCredential::Anonymous;
        let token = RequestCredential::for_token(Some("fixture-token"));
        let now = 1_000;
        // Unknown allowances admit.
        budget.admit_at(anonymous, false, now).unwrap();
        budget.observe_at(anonymous, StatusCode::OK, &rate(2, now + 600), now);
        // Anonymous conditional requests reserve one each; the third is refused.
        budget.admit_at(anonymous, true, now).unwrap();
        budget.admit_at(anonymous, true, now).unwrap();
        let refused = budget.admit_at(anonymous, true, now).unwrap_err();
        assert_eq!(refused.details["rate_limit_deferred"], "true");
        assert_eq!(refused.details["rate_limit_credential"], "anonymous");
        assert_eq!(refused.details["rate_reset"], (now + 600).to_string());
        assert!(crate::failure::is_rate_limited(&refused));
        // Never an answer about the resource: it cannot trigger preserved-location
        // failover, which acts only on an unavailable resource.
        assert!(matches!(
            refused.upstream_failure(),
            crate::failure::UpstreamFailure::Forbidden
        ));
        assert_eq!(
            refused.presentation().presentation_key,
            "provider_rate_limited"
        );
        // The authenticated allowance is separate and unaffected.
        budget.admit_at(token, true, now).unwrap();
        budget.observe_at(token, StatusCode::NOT_MODIFIED, &rate(1, now + 600), now);
        // An authenticated conditional request reserves nothing: a 304 is exempt.
        budget.admit_at(token, true, now).unwrap();
        budget.admit_at(token, true, now).unwrap();
        // An unconditional one does.
        budget.admit_at(token, false, now).unwrap();
        assert!(budget.admit_at(token, false, now).is_err());
        // A later answer from an older window cannot raise what is left.
        budget.observe_at(anonymous, StatusCode::OK, &rate(50, now + 1), now);
        assert_eq!(budget.snapshot(anonymous).unwrap().remaining, Some(0));
        // After the reported reset the allowance is unknown again and admits.
        budget.admit_at(anonymous, true, now + 600).unwrap();
        assert_eq!(budget.snapshot(anonymous).unwrap().remaining, None);
    }

    #[test]
    fn an_unanswered_reservation_returns_to_the_allowance() {
        let budget = GithubRequestBudget::default();
        let anonymous = RequestCredential::Anonymous;
        let reset = unix_now() + 3_600;
        budget.observe_at(anonymous, StatusCode::OK, &rate(1, reset), unix_now());
        // A request that never reached GitHub (dropped reservation) costs nothing.
        drop(budget.admit(anonymous, true).unwrap());
        assert_eq!(budget.snapshot(anonymous).unwrap().remaining, Some(1));
        // An answered one is settled; its headers describe the allowance.
        budget.admit(anonymous, true).unwrap().settle();
        assert_eq!(budget.snapshot(anonymous).unwrap().remaining, Some(0));
        assert!(budget.admit(anonymous, true).is_err());
        // A reservation from an older window is not returned into a new one.
        budget.release(anonymous, reset - 1);
        assert_eq!(budget.snapshot(anonymous).unwrap().remaining, Some(0));
    }

    #[test]
    fn throttling_answers_block_until_retry_after_or_reset() {
        let budget = GithubRequestBudget::default();
        let anonymous = RequestCredential::Anonymous;
        let now = 5_000;
        let secondary = RateLimitHeaders {
            retry_after: Some(30),
            ..RateLimitHeaders::default()
        };
        budget.observe_at(anonymous, StatusCode::FORBIDDEN, &secondary, now);
        assert!(budget.admit_at(anonymous, true, now + 29).is_err());
        budget.admit_at(anonymous, true, now + 30).unwrap();
        // A primary-limit 403 without retry-after waits for the reported reset.
        budget.observe_at(anonymous, StatusCode::FORBIDDEN, &rate(0, now + 900), now);
        let refused = budget.admit_at(anonymous, true, now + 899).unwrap_err();
        assert_eq!(refused.details["rate_reset"], (now + 900).to_string());
        budget.admit_at(anonymous, true, now + 900).unwrap();
        // A 429 with nothing else waits the documented minimum minute.
        let token = RequestCredential::for_token(Some("fixture-token"));
        budget.observe_at(
            token,
            StatusCode::TOO_MANY_REQUESTS,
            &RateLimitHeaders::default(),
            now,
        );
        assert!(budget.admit_at(token, true, now + 59).is_err());
        budget.admit_at(token, true, now + 60).unwrap();
        // A plain 403 (no limit headers) is not a rate limit.
        budget.observe_at(
            anonymous,
            StatusCode::FORBIDDEN,
            &RateLimitHeaders::default(),
            now + 2_000,
        );
        budget.admit_at(anonymous, true, now + 2_000).unwrap();
        // Other resources (search, graphql) do not change the core allowance.
        let search = RateLimitHeaders {
            resource: Some("search".into()),
            ..rate(0, now + 5_000)
        };
        budget.observe_at(anonymous, StatusCode::FORBIDDEN, &search, now + 2_000);
        budget.admit_at(anonymous, true, now + 2_000).unwrap();
    }

    #[tokio::test]
    async fn shared_observations_read_a_shared_repository_once_per_credential() {
        let shared = SharedObservations::new(["Owner/Shared".to_owned()]);
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let read = || async {
            reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, PortcoveError>(Arc::<str>::from("{}"))
        };
        let anonymous = RequestCredential::Anonymous;
        let token = RequestCredential::for_token(Some("fixture-token"));
        let url = "https://api.example/repos/owner/shared";
        assert!(
            !shared
                .body(anonymous, "owner/shared", url, read)
                .await
                .unwrap()
                .1
        );
        assert!(
            shared
                .body(anonymous, "owner/shared", url, read)
                .await
                .unwrap()
                .1
        );
        // A different credential never reuses another credential's answer.
        assert!(
            !shared
                .body(token, "owner/shared", url, read)
                .await
                .unwrap()
                .1
        );
        // A repository only one game names is not retained.
        let single = "https://api.example/repos/owner/single";
        assert!(
            !shared
                .body(anonymous, "owner/single", single, read)
                .await
                .unwrap()
                .1
        );
        assert!(
            !shared
                .body(anonymous, "owner/single", single, read)
                .await
                .unwrap()
                .1
        );
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 4);
        // A failed read is not retained.
        let other = "https://api.example/repos/owner/shared/releases";
        assert!(
            shared
                .body(anonymous, "owner/shared", other, || async {
                    Err(PortcoveError::network("offline"))
                })
                .await
                .is_err()
        );
        assert!(
            !shared
                .body(anonymous, "owner/shared", other, read)
                .await
                .unwrap()
                .1
        );
        // Outside a bulk check there is nothing to share.
        assert!(SharedObservations::current().is_none());
        SharedObservations::new([])
            .scope(async { assert!(SharedObservations::current().is_some()) })
            .await;
    }
}
