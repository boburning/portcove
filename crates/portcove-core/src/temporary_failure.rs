//! Temporary failures and their bounded retry schedule.
//!
//! Unattended work (standing setup, folder setup) limits how often it repeats
//! an unchanged plan that keeps failing, so a lasting problem does not recur on
//! every pass. A network outage, a provider's rate limit or server error, a
//! full disk or an interrupted run says nothing lasting about the plan,
//! though. Those failures are recorded here instead: they never count toward
//! the attempt limit, and the work runs again after a bounded back-off without
//! needing a new upstream release. A lasting failure (a rejected digest, a
//! missing asset, an unsupported format) keeps its limit and its own reason.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ErrorCode, PortcoveError,
    failure::{KnownFailureCause, UpstreamObservation},
};

/// The first wait after a temporary failure; each further one doubles it.
pub const TEMPORARY_RETRY_FIRST_DELAY_SECONDS: i64 = 5 * 60;
/// The longest wait between retries of one temporary failure.
pub const TEMPORARY_RETRY_MAX_DELAY_SECONDS: i64 = 6 * 60 * 60;
/// A provider-stated reset beyond this is not believed; the work waits this long.
const RATE_LIMIT_RESET_MAX_SECONDS: i64 = 24 * 60 * 60;

/// Why unattended work stopped for now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TemporaryCause {
    /// The connection failed, stalled or was too slow to finish.
    Network,
    /// The provider asked Portcove to wait before sending more requests.
    RateLimited,
    /// The provider answered with a server error.
    ServerUnavailable,
    /// The disk was full.
    StorageFull,
    /// Another task was using the game.
    GameBusy,
    /// Another program had a file Portcove needed open.
    FileInUse,
    /// Portcove stopped before the work finished.
    Interrupted,
}

/// What a temporary failure was, as recorded where it happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TemporaryFailure {
    pub cause: TemporaryCause,
    /// Unix seconds the provider said its limit resets, when it said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stated_reset: Option<i64>,
}

impl TemporaryFailure {
    pub(crate) fn of(error: &PortcoveError) -> Option<Self> {
        error.temporary_cause().map(|(cause, stated_reset)| Self {
            cause,
            stated_reset,
        })
    }

    pub(crate) const INTERRUPTED: Self = Self {
        cause: TemporaryCause::Interrupted,
        stated_reset: None,
    };
}

/// Consecutive interruptions after which the explanation says setup keeps
/// stopping. Wording only: the work still retries on its back-off.
const REPEATED_INTERRUPTIONS: u32 = 3;

/// A temporary failure's retry schedule. Clears when the work succeeds, its
/// plan changes or the player chooses again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TemporaryRetry {
    pub cause: TemporaryCause,
    /// Consecutive temporary failures of the same plan; sets the back-off.
    pub attempts: u32,
    /// Unix seconds before which the work is not tried again.
    pub retry_after: i64,
}

impl TemporaryRetry {
    /// The schedule after one more temporary failure of the same plan.
    pub(crate) fn after(
        previous: Option<&TemporaryRetry>,
        TemporaryFailure {
            cause,
            stated_reset,
        }: TemporaryFailure,
        now: i64,
    ) -> Self {
        let attempts = previous
            .map_or(0, |previous| previous.attempts)
            .saturating_add(1);
        // A run that stopped (Portcove closed, restarted or was stopped)
        // continues on the next pass; repeated stops then back off, so a
        // setup that keeps ending its own run cannot repeat without pause.
        let waits = match cause {
            TemporaryCause::Interrupted => attempts.saturating_sub(1),
            _ => attempts,
        };
        let delay = if waits == 0 {
            0
        } else {
            TEMPORARY_RETRY_FIRST_DELAY_SECONDS
                .saturating_mul(1_i64 << (waits - 1).min(16))
                .min(TEMPORARY_RETRY_MAX_DELAY_SECONDS)
        };
        let mut retry_after = now.saturating_add(delay);
        // A provider's own stated reset is honored when it is later, within reason.
        if let Some(reset) = stated_reset {
            retry_after =
                retry_after.max(reset.min(now.saturating_add(RATE_LIMIT_RESET_MAX_SECONDS)));
        }
        Self {
            cause,
            attempts,
            retry_after,
        }
    }

    pub(crate) fn waiting(&self, now: i64) -> bool {
        now < self.retry_after
    }

    /// Player explanation at `now` while the work waits to run again.
    pub fn explanation(&self, now: i64) -> String {
        let situation = match self.cause {
            TemporaryCause::Network => {
                "Setup stopped because the connection failed or became too slow."
            }
            TemporaryCause::RateLimited => {
                "Setup stopped because the download site asked Portcove to wait."
            }
            TemporaryCause::ServerUnavailable => {
                "Setup stopped because the download site had a problem."
            }
            TemporaryCause::StorageFull => {
                "Setup stopped because the disk was full. Free some space."
            }
            TemporaryCause::GameBusy => "Setup waited because another task was using this game.",
            TemporaryCause::FileInUse => {
                "Setup stopped because another program had a needed file open."
            }
            TemporaryCause::Interrupted if self.attempts >= REPEATED_INTERRUPTIONS => {
                "Setup keeps stopping before it finishes."
            }
            TemporaryCause::Interrupted => "Setup stopped before it finished.",
        };
        format!(
            "{situation} Portcove will try again automatically {}.",
            wait_phrase(self.retry_after.saturating_sub(now))
        )
    }
}

/// A rounded, relative wait a player can read at a glance.
fn wait_phrase(seconds: i64) -> String {
    let minutes = (seconds.max(0) + 59) / 60;
    match minutes {
        0..=1 => "in about a minute".to_owned(),
        2..=59 => format!("in about {minutes} minutes"),
        _ => {
            let hours = (minutes + 30) / 60;
            if hours == 1 {
                "in about an hour".to_owned()
            } else {
                format!("in about {hours} hours")
            }
        }
    }
}

/// `Retry-After` as seconds or an HTTP date, relative to `now`.
fn retry_after_reset(value: &str, now: i64) -> Option<i64> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u32>() {
        return Some(now.saturating_add(i64::from(seconds)));
    }
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc2822)
        .ok()
        .map(time::OffsetDateTime::unix_timestamp)
}

impl PortcoveError {
    /// Whether this failure comes from a passing condition, from recorded facts
    /// only (never message text), and any reset time the provider stated.
    /// `None` is a lasting failure that keeps its attempt limit. Temporary is
    /// opt-in: a network-coded error with neither a transport observation, a
    /// status nor the transport-interruption marker stays lasting.
    pub(crate) fn temporary_cause(&self) -> Option<(TemporaryCause, Option<i64>)> {
        let now = crate::Library::now();
        let retry_after = self
            .details
            .get("retry_after")
            .and_then(|value| retry_after_reset(value, now));
        match self.known_cause() {
            Some(KnownFailureCause::StorageFull) => {
                return Some((TemporaryCause::StorageFull, None));
            }
            Some(KnownFailureCause::Busy) => return Some((TemporaryCause::GameBusy, None)),
            Some(KnownFailureCause::RetainedDownloadUnreadable) => {
                return Some((TemporaryCause::FileInUse, None));
            }
            Some(KnownFailureCause::OperationInterrupted) => {
                return Some((TemporaryCause::Interrupted, None));
            }
            Some(KnownFailureCause::ProviderRequest {
                status,
                rate_limited,
                resets_at,
                ..
            }) => {
                // GitHub's secondary limit answers 403 with Retry-After while
                // quota remains; any stated wait marks a rate limit.
                let limited =
                    *rate_limited || *status == 429 || (*status == 403 && retry_after.is_some());
                return if limited {
                    Some((TemporaryCause::RateLimited, retry_after.max(*resets_at)))
                } else {
                    status_cause(*status).map(|cause| (cause, retry_after))
                };
            }
            _ => {}
        }
        match self.upstream_observation() {
            Some(UpstreamObservation::Transport { .. }) => Some((TemporaryCause::Network, None)),
            Some(UpstreamObservation::Status(403)) if retry_after.is_some() => {
                Some((TemporaryCause::RateLimited, retry_after))
            }
            Some(UpstreamObservation::Status(status)) => {
                status_cause(status).map(|cause| (cause, retry_after))
            }
            None if self.code == ErrorCode::Network && self.is_transient_transport() => {
                Some((TemporaryCause::Network, None))
            }
            None => None,
        }
    }
}

/// 404/410 (asset gone), 401/403 (authorization) and other client answers are
/// lasting until something changes; throttling and server errors pass.
fn status_cause(status: u16) -> Option<TemporaryCause> {
    match status {
        429 => Some(TemporaryCause::RateLimited),
        408 => Some(TemporaryCause::Network),
        500..=599 => Some(TemporaryCause::ServerUnavailable),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(cause: TemporaryCause, stated_reset: Option<i64>) -> TemporaryFailure {
        TemporaryFailure {
            cause,
            stated_reset,
        }
    }

    #[test]
    fn back_off_doubles_to_its_ceiling_and_honors_a_later_stated_reset() {
        let now = 1_800_000_000;
        let mut retry = None;
        let mut delays = Vec::new();
        for _ in 0..9 {
            let next =
                TemporaryRetry::after(retry.as_ref(), failure(TemporaryCause::Network, None), now);
            delays.push(next.retry_after - now);
            retry = Some(next);
        }
        assert_eq!(
            delays,
            [300, 600, 1200, 2400, 4800, 9600, 19200, 21600, 21600]
        );
        let limited = TemporaryRetry::after(
            None,
            failure(TemporaryCause::RateLimited, Some(now + 3600)),
            now,
        );
        assert_eq!(limited.retry_after, now + 3600);
        let implausible = TemporaryRetry::after(
            None,
            failure(TemporaryCause::RateLimited, Some(i64::MAX)),
            now,
        );
        assert_eq!(implausible.retry_after, now + RATE_LIMIT_RESET_MAX_SECONDS);
        assert!(limited.waiting(now) && !limited.waiting(now + 3600));
        let mut stopped = None;
        let mut delays = Vec::new();
        for _ in 0..3 {
            let next = TemporaryRetry::after(stopped.as_ref(), TemporaryFailure::INTERRUPTED, now);
            delays.push(next.retry_after - now);
            stopped = Some(next);
        }
        assert_eq!(delays, [0, 300, 600]);
    }

    #[test]
    fn classification_uses_recorded_facts_and_keeps_lasting_failures_lasting() {
        // Temporary is opt-in: only a marked interruption, a transport
        // observation or a temporary status qualifies.
        let interrupted = PortcoveError::network("connection reset").transient_transport();
        assert_eq!(
            interrupted.temporary_cause(),
            Some((TemporaryCause::Network, None))
        );
        for unmarked in [
            "download redirect has no location",
            "too many download redirects",
            "checksum download returned 404 Not Found",
        ] {
            assert_eq!(
                PortcoveError::network(unmarked).temporary_cause(),
                None,
                "{unmarked}"
            );
        }
        let timed_out = PortcoveError::network("timed out")
            .with_upstream(Some(UpstreamObservation::Transport { timed_out: true }));
        assert_eq!(
            timed_out.temporary_cause(),
            Some((TemporaryCause::Network, None))
        );
        for (status, cause) in [
            (429, Some(TemporaryCause::RateLimited)),
            (503, Some(TemporaryCause::ServerUnavailable)),
            (404, None),
            (410, None),
            (403, None),
        ] {
            let error = PortcoveError::network(format!("download returned {status}"))
                .with_upstream(Some(UpstreamObservation::Status(status)));
            assert_eq!(
                error.temporary_cause().map(|(cause, _)| cause),
                cause,
                "{status}"
            );
        }
        let full = PortcoveError::from(std::io::Error::from(std::io::ErrorKind::StorageFull));
        assert_eq!(
            full.temporary_cause(),
            Some((TemporaryCause::StorageFull, None))
        );
        assert_eq!(
            PortcoveError::state("busy")
                .with_known_cause(KnownFailureCause::Busy)
                .temporary_cause(),
            Some((TemporaryCause::GameBusy, None))
        );
        assert_eq!(
            PortcoveError::verification("digest mismatch").temporary_cause(),
            None
        );
        assert_eq!(
            PortcoveError::unsupported("unsupported format").temporary_cause(),
            None
        );
        assert_eq!(PortcoveError::state("bad record").temporary_cause(), None);
    }

    fn provider(status: u16, rate_limited: bool, resets_at: Option<i64>) -> PortcoveError {
        PortcoveError::network(format!("GitHub API returned {status}")).with_known_cause(
            KnownFailureCause::ProviderRequest {
                provider: crate::failure::FailureProvider::Github,
                status,
                rate_limited,
                resets_at,
            },
        )
    }

    #[test]
    fn retry_after_and_secondary_rate_limits_wait_instead_of_becoming_lasting() {
        let now = crate::Library::now();
        // A 429 with Retry-After waits at least that long.
        let (cause, reset) = provider(429, true, None)
            .detail("retry_after", "3600")
            .temporary_cause()
            .unwrap();
        assert_eq!(cause, TemporaryCause::RateLimited);
        assert!((now + 3600..=now + 3605).contains(&reset.unwrap()));
        // GitHub's secondary limit: 403 with Retry-After while quota remains.
        let (cause, reset) = provider(403, false, Some(now + 10))
            .detail("retry_after", "120")
            .temporary_cause()
            .unwrap();
        assert_eq!(cause, TemporaryCause::RateLimited);
        assert!(reset.unwrap() >= now + 120);
        // An HTTP-date Retry-After on a plain status observation.
        let (cause, reset) = PortcoveError::network("download returned 403")
            .with_upstream(Some(UpstreamObservation::Status(403)))
            .detail("retry_after", "Wed, 21 Oct 2037 07:28:00 GMT")
            .temporary_cause()
            .unwrap();
        assert_eq!(cause, TemporaryCause::RateLimited);
        assert_eq!(reset, Some(2_139_722_880));
        // A 403 without a stated wait is an authorization refusal: lasting.
        assert_eq!(provider(403, false, None).temporary_cause(), None);
    }

    #[test]
    fn explanation_says_why_and_when_without_internal_codes() {
        let now = 1_800_000_000;
        let retry = TemporaryRetry {
            cause: TemporaryCause::RateLimited,
            attempts: 1,
            retry_after: now + 2 * 60 * 60,
        };
        assert_eq!(
            retry.explanation(now),
            "Setup stopped because the download site asked Portcove to wait. Portcove will try again automatically in about 2 hours."
        );
        let stopping = TemporaryRetry {
            cause: TemporaryCause::Interrupted,
            attempts: REPEATED_INTERRUPTIONS,
            retry_after: now + 10 * 60,
        };
        assert_eq!(
            stopping.explanation(now),
            "Setup keeps stopping before it finishes. Portcove will try again automatically in about 10 minutes."
        );
        assert_eq!(wait_phrase(0), "in about a minute");
        assert_eq!(wait_phrase(65 * 60), "in about an hour");
    }
}
