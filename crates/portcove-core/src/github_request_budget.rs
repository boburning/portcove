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
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    /// The provider's reset instant in Unix seconds, by the provider's clock.
    pub(crate) reset: Option<u64>,
    pub(crate) resource: Option<String>,
    /// The `retry-after` wait (delta-seconds or HTTP-date), already capped.
    pub(crate) retry_after: Option<Duration>,
    /// The response `Date` in Unix seconds: the provider's clock at the answer.
    pub(crate) date: Option<u64>,
}

impl RateLimitHeaders {
    /// `local_now` (Unix seconds) stands in for the provider's clock only when
    /// the answer carries no usable `Date`.
    pub(crate) fn parse(headers: &header::HeaderMap, local_now: u64) -> Self {
        let text = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
        };
        let number = |name: &str| text(name).and_then(|value| value.parse::<u64>().ok());
        let date = text(header::DATE.as_str()).and_then(http_date);
        Self {
            limit: number("x-ratelimit-limit"),
            remaining: number("x-ratelimit-remaining"),
            used: number("x-ratelimit-used"),
            reset: number("x-ratelimit-reset"),
            resource: text("x-ratelimit-resource").map(str::to_owned),
            retry_after: text(header::RETRY_AFTER.as_str())
                .and_then(|value| retry_after_wait(value, date.unwrap_or(local_now))),
            date,
        }
    }
}

/// The longest wait Portcove believes from any provider answer: GitHub's primary
/// window is one hour, so a later reset or `retry-after` (or a clock that is far
/// off) never blocks requests for longer.
pub(crate) const PROVIDER_WAIT_CEILING: Duration = Duration::from_secs(60 * 60);

/// Parse a `Retry-After` value: delta-seconds, or an HTTP-date measured against
/// `server_now` (the provider's `Date`, Unix seconds). Capped at
/// [`PROVIDER_WAIT_CEILING`]; a date in the past means no wait. Shared parser for
/// provider throttling answers.
pub(crate) fn retry_after_wait(value: &str, server_now: u64) -> Option<Duration> {
    let value = value.trim();
    let seconds = match value.parse::<u64>() {
        Ok(seconds) => seconds,
        Err(_) => http_date(value)?.saturating_sub(server_now),
    };
    Some(Duration::from_secs(seconds).min(PROVIDER_WAIT_CEILING))
}

/// The wait until a reported reset instant, measured on the provider's clock and
/// capped at [`PROVIDER_WAIT_CEILING`].
pub(crate) fn reset_wait(reset: u64, server_now: u64) -> Duration {
    Duration::from_secs(reset.saturating_sub(server_now)).min(PROVIDER_WAIT_CEILING)
}

/// An HTTP-date (IMF-fixdate) in Unix seconds.
fn http_date(value: &str) -> Option<u64> {
    let parsed =
        time::OffsetDateTime::parse(value.trim(), &time::format_description::well_known::Rfc2822)
            .ok()?;
    u64::try_from(parsed.unix_timestamp()).ok()
}

/// Without a usable `retry-after`, GitHub asks clients to wait at least a minute
/// after a secondary limit.
const SECONDARY_LIMIT_DEFAULT_WAIT: Duration = Duration::from_secs(60);
/// Every metadata request Portcove sends is a REST `core` resource request.
const CORE_RESOURCE: &str = "core";

/// Why requests of one credential are paused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AllowanceStop {
    /// The primary allowance is spent until its reset.
    Exhausted,
    /// The provider asked the client to wait (a secondary limit or throttle).
    Throttled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Block {
    /// Monotonic: a wall-clock change cannot shorten or extend it.
    until: Instant,
    stop: AllowanceStop,
    /// When requests may resume, in Unix seconds, for presentation.
    resets_at: u64,
    /// Whether the provider reported that time, or Portcove estimated it.
    reported: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Allowance {
    limit: Option<u64>,
    remaining: Option<u64>,
    used: Option<u64>,
    /// The provider's reset value, used to tell its windows apart.
    reset: Option<u64>,
    /// When this window ends on the monotonic clock.
    window_ends: Option<Instant>,
    blocked: Option<Block>,
}

/// What the running budget currently knows about one credential's allowance.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AllowanceSnapshot {
    pub(crate) limit: Option<u64>,
    pub(crate) remaining: Option<u64>,
    pub(crate) used: Option<u64>,
    pub(crate) reset: Option<u64>,
    pub(crate) blocked: Option<AllowanceStop>,
}

/// The running GitHub request budget of one provider (and every clone of it),
/// kept separately for each credential. It starts unknown and learns only from
/// actual response headers. Deadlines are monotonic and measured from the
/// provider's own `Date`, so a wrong or changed local clock cannot stretch or
/// cancel a wait, and no wait exceeds [`PROVIDER_WAIT_CEILING`]. It lives in
/// memory: after a restart GitHub's next answer re-establishes it.
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
        let reserved = self.admit_at(credential, conditional, Instant::now())?;
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
        now: Instant,
    ) -> Result<Option<u64>> {
        let mut allowances = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(allowance) = allowances.get_mut(&credential) else {
            return Ok(None);
        };
        if let Some(block) = allowance.blocked {
            if block.until > now {
                return Err(refusal(credential, &block));
            }
            allowance.blocked = None;
        }
        if allowance.window_ends.is_some_and(|ends| ends <= now) {
            // A new window: what is left is unknown until the next answer.
            allowance.remaining = None;
            allowance.used = None;
            allowance.reset = None;
            allowance.window_ends = None;
        }
        match allowance.remaining {
            Some(0) => Err(refusal(
                credential,
                &Block {
                    until: allowance.window_ends.unwrap_or(now),
                    stop: AllowanceStop::Exhausted,
                    resets_at: allowance.reset.unwrap_or_default(),
                    reported: allowance.reset.is_some(),
                },
            )),
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
        let wall = unix_now();
        self.observe_at(
            credential,
            status,
            &RateLimitHeaders::parse(headers, wall),
            Instant::now(),
            wall,
        );
    }

    /// `wall` is the local clock in Unix seconds, used only where the answer
    /// carries no `Date` and for estimated presentation times.
    fn observe_at(
        &self,
        credential: RequestCredential,
        status: StatusCode,
        headers: &RateLimitHeaders,
        now: Instant,
        wall: u64,
    ) {
        if headers
            .resource
            .as_deref()
            .is_some_and(|resource| resource != CORE_RESOURCE)
        {
            return;
        }
        let server_now = headers.date.unwrap_or(wall);
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
                    allowance.window_ends = Some(now + reset_wait(reset, server_now));
                }
            }
            allowance.limit = headers.limit.or(allowance.limit);
        }
        let limited = status == StatusCode::TOO_MANY_REQUESTS
            || (status == StatusCode::FORBIDDEN
                && (headers.remaining == Some(0) || headers.retry_after.is_some()));
        if limited {
            let (stop, wait, resets_at, reported) =
                match (headers.retry_after, headers.remaining, headers.reset) {
                    (Some(wait), _, _) => (
                        AllowanceStop::Throttled,
                        wait,
                        wall.saturating_add(wait.as_secs()),
                        true,
                    ),
                    (None, Some(0), Some(reset)) => (
                        AllowanceStop::Exhausted,
                        reset_wait(reset, server_now),
                        reset,
                        true,
                    ),
                    _ => (
                        AllowanceStop::Throttled,
                        SECONDARY_LIMIT_DEFAULT_WAIT,
                        wall.saturating_add(SECONDARY_LIMIT_DEFAULT_WAIT.as_secs()),
                        false,
                    ),
                };
            let block = Block {
                until: now + wait.max(Duration::from_secs(1)),
                stop,
                resets_at,
                reported,
            };
            if allowance
                .blocked
                .is_none_or(|known| known.until < block.until)
            {
                allowance.blocked = Some(block);
            }
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
                blocked: allowance.blocked.map(|block| block.stop),
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

fn refusal(credential: RequestCredential, block: &Block) -> PortcoveError {
    let resets_at = (block.resets_at > 0)
        .then(|| i64::try_from(block.resets_at).ok())
        .flatten();
    let mut error = PortcoveError::network(match block.stop {
        AllowanceStop::Exhausted => {
            "GitHub reported this client's request allowance used up, so Portcove did not send the request."
        }
        AllowanceStop::Throttled => {
            "GitHub asked this client to wait before more requests, so Portcove did not send the request."
        }
    })
    .with_known_cause(KnownFailureCause::ProviderAllowanceExhausted {
        provider: FailureProvider::Github,
        resets_at,
        throttled: block.stop == AllowanceStop::Throttled,
        reset_reported: block.reported,
    })
    .detail("rate_limit_deferred", "true")
    .detail("rate_limit_credential", credential.label());
    if let Some(resets_at) = resets_at {
        error = error.detail("rate_reset", resets_at.to_string());
    }
    error
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

    pub(crate) fn shares(&self, repository: &str) -> bool {
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

    /// A primary-limit answer whose `Date` is `date` and whose window resets at `reset`.
    fn rate(remaining: u64, reset: u64, date: u64) -> RateLimitHeaders {
        RateLimitHeaders {
            limit: Some(60),
            remaining: Some(remaining),
            used: Some(60 - remaining),
            reset: Some(reset),
            resource: Some("core".into()),
            retry_after: None,
            date: Some(date),
        }
    }

    fn secs(seconds: u64) -> Duration {
        Duration::from_secs(seconds)
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
            ("x-ratelimit-reset", "1445413080"),
            ("x-ratelimit-resource", "core"),
            ("date", "Wed, 21 Oct 2015 07:28:00 GMT"),
            ("retry-after", "Wed, 21 Oct 2015 07:30:00 GMT"),
        ] {
            headers.insert(name, header::HeaderValue::from_static(value));
        }
        assert_eq!(
            RateLimitHeaders::parse(&headers, 0),
            RateLimitHeaders {
                limit: Some(5000),
                remaining: Some(4999),
                used: Some(1),
                reset: Some(1_445_413_080),
                resource: Some("core".into()),
                // An HTTP-date is measured against the provider's own `Date`.
                retry_after: Some(secs(120)),
                date: Some(1_445_412_480),
            }
        );
        assert_eq!(
            RateLimitHeaders::parse(&header::HeaderMap::new(), 7),
            RateLimitHeaders::default()
        );
    }

    #[test]
    fn retry_after_and_reset_waits_are_capped_and_never_negative() {
        assert_eq!(retry_after_wait("30", 0), Some(secs(30)));
        assert_eq!(retry_after_wait(" 86400 ", 0), Some(PROVIDER_WAIT_CEILING));
        assert_eq!(
            retry_after_wait("Wed, 21 Oct 2015 07:28:00 GMT", 1_445_412_480 + 10),
            Some(Duration::ZERO),
            "a date in the past means no wait"
        );
        assert_eq!(retry_after_wait("soon", 0), None);
        assert_eq!(reset_wait(1_000, 400), secs(600));
        assert_eq!(reset_wait(1_000, 2_000), Duration::ZERO);
        assert_eq!(reset_wait(u64::MAX, 0), PROVIDER_WAIT_CEILING);
    }

    #[test]
    fn the_running_budget_follows_answers_per_credential_and_reopens_after_reset() {
        let budget = GithubRequestBudget::default();
        let anonymous = RequestCredential::Anonymous;
        let token = RequestCredential::for_token(Some("fixture-token"));
        let start = Instant::now();
        let wall = 1_000;
        // Unknown allowances admit.
        budget.admit_at(anonymous, false, start).unwrap();
        budget.observe_at(
            anonymous,
            StatusCode::OK,
            &rate(2, wall + 600, wall),
            start,
            wall,
        );
        // Anonymous conditional requests reserve one each; the third is refused.
        budget.admit_at(anonymous, true, start).unwrap();
        budget.admit_at(anonymous, true, start).unwrap();
        let refused = budget.admit_at(anonymous, true, start).unwrap_err();
        assert_eq!(refused.details["rate_limit_deferred"], "true");
        assert_eq!(refused.details["rate_limit_credential"], "anonymous");
        assert_eq!(refused.details["rate_reset"], (wall + 600).to_string());
        assert!(crate::failure::is_rate_limited(&refused));
        // Never an answer about the resource: it cannot trigger preserved-location
        // failover, which acts only on an unavailable resource.
        assert!(matches!(
            refused.upstream_failure(),
            crate::failure::UpstreamFailure::Forbidden
        ));
        let presentation = refused.presentation();
        assert_eq!(presentation.presentation_key, "provider_rate_limited");
        assert!(
            presentation
                .summary
                .contains("allowance for this computer is used up")
        );
        assert!(
            presentation
                .summary
                .contains("Resets: 1970-01-01T00:26:40Z.")
        );
        // The authenticated allowance is separate and unaffected.
        budget.admit_at(token, true, start).unwrap();
        budget.observe_at(
            token,
            StatusCode::NOT_MODIFIED,
            &rate(1, wall + 600, wall),
            start,
            wall,
        );
        // An authenticated conditional request reserves nothing: a 304 is exempt.
        budget.admit_at(token, true, start).unwrap();
        budget.admit_at(token, true, start).unwrap();
        // An unconditional one does.
        budget.admit_at(token, false, start).unwrap();
        assert!(budget.admit_at(token, false, start).is_err());
        // A later answer from an older window cannot raise what is left.
        budget.observe_at(
            anonymous,
            StatusCode::OK,
            &rate(50, wall + 1, wall),
            start,
            wall,
        );
        assert_eq!(budget.snapshot(anonymous).unwrap().remaining, Some(0));
        // After the window ends the allowance is unknown again and admits.
        budget.admit_at(anonymous, true, start + secs(600)).unwrap();
        assert_eq!(budget.snapshot(anonymous).unwrap().remaining, None);
    }

    #[test]
    fn an_unanswered_reservation_returns_to_the_allowance() {
        let budget = GithubRequestBudget::default();
        let anonymous = RequestCredential::Anonymous;
        let wall = unix_now();
        let reset = wall + 3_600;
        budget.observe_at(
            anonymous,
            StatusCode::OK,
            &rate(1, reset, wall),
            Instant::now(),
            wall,
        );
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
        let start = Instant::now();
        let wall = 5_000;
        let secondary = RateLimitHeaders {
            retry_after: Some(secs(30)),
            ..RateLimitHeaders::default()
        };
        budget.observe_at(anonymous, StatusCode::FORBIDDEN, &secondary, start, wall);
        let refused = budget
            .admit_at(anonymous, true, start + secs(29))
            .unwrap_err();
        assert_eq!(
            budget.snapshot(anonymous).unwrap().blocked,
            Some(AllowanceStop::Throttled)
        );
        assert!(
            refused
                .presentation()
                .summary
                .contains("asked this computer to wait")
        );
        budget.admit_at(anonymous, true, start + secs(30)).unwrap();
        // A primary-limit 403 without retry-after waits for the reported reset.
        budget.observe_at(
            anonymous,
            StatusCode::FORBIDDEN,
            &rate(0, wall + 900, wall),
            start,
            wall,
        );
        let refused = budget
            .admit_at(anonymous, true, start + secs(899))
            .unwrap_err();
        assert_eq!(refused.details["rate_reset"], (wall + 900).to_string());
        budget.admit_at(anonymous, true, start + secs(900)).unwrap();
        // A 429 with nothing else waits the documented minimum minute, and its
        // presentation says the time is Portcove's estimate.
        let token = RequestCredential::for_token(Some("fixture-token"));
        budget.observe_at(
            token,
            StatusCode::TOO_MANY_REQUESTS,
            &RateLimitHeaders::default(),
            start,
            wall,
        );
        let refused = budget.admit_at(token, true, start + secs(59)).unwrap_err();
        assert!(
            refused
                .presentation()
                .summary
                .contains("estimated by Portcove")
        );
        budget.admit_at(token, true, start + secs(60)).unwrap();
        // A plain 403 (no limit headers) is not a rate limit.
        let later = start + secs(2_000);
        budget.observe_at(
            anonymous,
            StatusCode::FORBIDDEN,
            &RateLimitHeaders::default(),
            later,
            wall + 2_000,
        );
        budget.admit_at(anonymous, true, later).unwrap();
        // Other resources (search, graphql) do not change the core allowance.
        let search = RateLimitHeaders {
            resource: Some("search".into()),
            ..rate(0, wall + 5_000, wall + 2_000)
        };
        budget.observe_at(
            anonymous,
            StatusCode::FORBIDDEN,
            &search,
            later,
            wall + 2_000,
        );
        budget.admit_at(anonymous, true, later).unwrap();
    }

    /// The local clock can be far behind or ahead of GitHub's. Waits are measured
    /// on GitHub's own `Date`, held on the monotonic clock, and capped at an hour.
    #[test]
    fn a_wrong_or_changing_local_clock_cannot_stretch_or_cancel_a_wait() {
        let start = Instant::now();
        let server = 1_700_000_000;
        // Local clock two hours ahead: the reset is in the local past, but the
        // provider's `Date` still says fifteen minutes remain.
        let ahead = GithubRequestBudget::default();
        let anonymous = RequestCredential::Anonymous;
        ahead.observe_at(
            anonymous,
            StatusCode::FORBIDDEN,
            &rate(0, server + 900, server),
            start,
            server + 7_200,
        );
        assert!(ahead.admit_at(anonymous, true, start + secs(899)).is_err());
        ahead.admit_at(anonymous, true, start + secs(900)).unwrap();
        // Local clock two hours behind and no `Date`: the believed wait is capped.
        let behind = GithubRequestBudget::default();
        let headers = RateLimitHeaders {
            date: None,
            ..rate(0, server, server)
        };
        behind.observe_at(
            anonymous,
            StatusCode::FORBIDDEN,
            &headers,
            start,
            server - 7_200,
        );
        assert!(
            behind
                .admit_at(anonymous, true, start + secs(3_599))
                .is_err()
        );
        behind
            .admit_at(anonymous, true, start + PROVIDER_WAIT_CEILING)
            .unwrap();
        // A wall-clock jump after the answer changes nothing: deadlines are
        // monotonic, so only elapsed time reopens the allowance.
        let jumped = GithubRequestBudget::default();
        jumped.observe_at(
            anonymous,
            StatusCode::FORBIDDEN,
            &rate(0, server + 600, server),
            start,
            server,
        );
        assert!(jumped.admit_at(anonymous, true, start + secs(1)).is_err());
        jumped.admit_at(anonymous, true, start + secs(600)).unwrap();
    }

    /// A reset that arrives while a walk is under way reopens the allowance for the
    /// remaining reads without any retry or restart.
    #[test]
    fn a_reset_during_a_walk_reopens_the_rest_of_it() {
        let budget = GithubRequestBudget::default();
        let anonymous = RequestCredential::Anonymous;
        let start = Instant::now();
        let server = 1_700_000_000;
        budget.observe_at(
            anonymous,
            StatusCode::OK,
            &rate(1, server + 60, server),
            start,
            server,
        );
        budget.admit_at(anonymous, true, start).unwrap();
        assert!(budget.admit_at(anonymous, true, start + secs(30)).is_err());
        // The next window's first answer replaces the spent one.
        budget.admit_at(anonymous, true, start + secs(60)).unwrap();
        budget.observe_at(
            anonymous,
            StatusCode::OK,
            &rate(59, server + 3_660, server + 60),
            start + secs(60),
            server + 60,
        );
        assert_eq!(budget.snapshot(anonymous).unwrap().remaining, Some(59));
        budget.admit_at(anonymous, true, start + secs(61)).unwrap();
    }

    /// Signing in or out between requests switches allowance without carrying the
    /// other credential's state over.
    #[test]
    fn a_credential_change_mid_check_switches_allowance() {
        let budget = GithubRequestBudget::default();
        let start = Instant::now();
        let server = 1_700_000_000;
        let first = RequestCredential::for_token(Some("first-token"));
        let second = RequestCredential::for_token(Some("second-token"));
        assert_ne!(first, second);
        budget.observe_at(
            first,
            StatusCode::FORBIDDEN,
            &rate(0, server + 600, server),
            start,
            server,
        );
        assert!(budget.admit_at(first, true, start).is_err());
        budget.admit_at(second, true, start).unwrap();
        budget
            .admit_at(RequestCredential::Anonymous, true, start)
            .unwrap();
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
