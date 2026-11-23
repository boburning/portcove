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
/// The one ceiling on any provider-stated wait (`Retry-After`, a rate-limit
/// reset, an incomplete inventory's reset): a stated wait beyond it is not
/// believed and the work waits this long instead. One day keeps a misreported
/// or hostile reset from parking unattended work indefinitely while honoring
/// every documented provider window (GitHub's hourly and secondary limits).
pub const STATED_WAIT_CEILING_SECONDS: i64 = 24 * 60 * 60;

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
    /// One unattended pass gave this game its whole time budget and moved on
    /// so other games get a turn; kept bytes continue on the next pass.
    TimeBudget,
    /// A list Portcove needed (releases, assets, packages) could not be read
    /// completely yet. Incomplete is never treated as absent.
    InventoryIncomplete,
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
const REPEATED_INTERRUPTIONS: u32 = 2;

/// Consecutive unclean stops (Portcove ended without settling the run) of one
/// unchanged plan after which the failure becomes lasting. A setup that
/// deterministically ends Portcove must not repeat forever; a clean stop,
/// cancellation or any other temporary cause never counts here.
pub const MAX_CONSECUTIVE_UNCLEAN_STOPS: u32 = 3;

/// How one failed unattended attempt is recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FailedAttempt {
    /// Retry the same plan after the schedule; no attempt is spent.
    Temporary(TemporaryRetry),
    /// Spend one lasting attempt.
    Lasting,
    /// The same plan ended Portcove too many times in a row: lasting, and the
    /// attempt limit is reached at once.
    RepeatedUncleanStops,
}

impl FailedAttempt {
    pub(crate) fn of(
        previous: Option<&TemporaryRetry>,
        temporary: Option<TemporaryFailure>,
        now: i64,
    ) -> Self {
        let Some(failure) = temporary else {
            return Self::Lasting;
        };
        let next = TemporaryRetry::after(previous, failure, now);
        if failure.cause == TemporaryCause::Interrupted
            && next.attempts >= MAX_CONSECUTIVE_UNCLEAN_STOPS
        {
            Self::RepeatedUncleanStops
        } else {
            Self::Temporary(next)
        }
    }
}

/// A temporary failure's retry schedule. Clears when the work succeeds, its
/// plan changes or the player chooses again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TemporaryRetry {
    pub cause: TemporaryCause,
    /// Consecutive temporary failures of the same plan with the same cause;
    /// sets the back-off. A different cause starts the count again.
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
            .filter(|previous| previous.cause == cause)
            .map_or(0, |previous| previous.attempts)
            .saturating_add(1);
        // A run that stopped (Portcove closed, restarted or was stopped)
        // continues on the next pass; repeated stops then back off, so a
        // setup that keeps ending its own run cannot repeat without pause.
        // A spent time budget is fair scheduling, not a failure: the game
        // continues on the very next pass, with no growing wait.
        let waits = match cause {
            TemporaryCause::TimeBudget => 0,
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
                retry_after.max(reset.min(now.saturating_add(STATED_WAIT_CEILING_SECONDS)));
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

    /// Player explanation while the work waits to run again. It names the
    /// situation only; the next attempt is a separate instant (`retry_after`)
    /// that each surface shows in its own form, so no stored text goes stale.
    pub fn explanation(&self) -> &'static str {
        match self.cause {
            TemporaryCause::Network => {
                "Setup stopped because the connection failed or became too slow. Portcove will try again automatically."
            }
            TemporaryCause::RateLimited => {
                "Setup stopped because the download site asked Portcove to wait. Portcove will try again automatically."
            }
            TemporaryCause::ServerUnavailable => {
                "Setup stopped because the download site had a problem. Portcove will try again automatically."
            }
            TemporaryCause::StorageFull => {
                "Setup stopped because the drive ran out of space. Free up space, and Portcove will try again automatically."
            }
            TemporaryCause::GameBusy => {
                "Setup waited because another task was using this game. Portcove will try again automatically."
            }
            TemporaryCause::FileInUse => {
                "Setup stopped because another program had a needed file open. Portcove will try again automatically."
            }
            TemporaryCause::TimeBudget => {
                "Setup paused because this game's download was taking a long time, so other games could go first. Portcove will continue it automatically."
            }
            TemporaryCause::InventoryIncomplete => {
                "Setup waited because Portcove could not read everything it needs from the download site yet. Portcove will try again automatically."
            }
            TemporaryCause::Interrupted if self.attempts >= REPEATED_INTERRUPTIONS => {
                "Setup keeps stopping before it finishes. Portcove will try again automatically."
            }
            TemporaryCause::Interrupted => {
                "Setup stopped before it finished. Portcove will try again automatically."
            }
        }
    }
}

/// Parses an HTTP `Retry-After` value into a Unix-second instant, capped at
/// [`STATED_WAIT_CEILING_SECONDS`] after `now`. Accepts delay-seconds and all
/// three HTTP-date forms (IMF-fixdate, obsolete RFC 850 and asctime). The one
/// parser for every caller; `None` for anything else.
pub(crate) fn parse_retry_after(value: &str, now: i64) -> Option<i64> {
    let value = value.trim();
    let instant = if let Ok(seconds) = value.parse::<u64>() {
        now.saturating_add(i64::try_from(seconds).unwrap_or(i64::MAX))
    } else {
        http_date(value)?
    };
    Some(instant.min(now.saturating_add(STATED_WAIT_CEILING_SECONDS)))
}

fn http_date(value: &str) -> Option<i64> {
    if let Ok(moment) =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc2822)
    {
        return Some(moment.unix_timestamp());
    }
    let month = |name: &str| -> Option<time::Month> {
        const NAMES: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        let index = NAMES.iter().position(|candidate| *candidate == name)?;
        time::Month::try_from(u8::try_from(index + 1).ok()?).ok()
    };
    let clock = |text: &str| -> Option<(u8, u8, u8)> {
        let mut parts = text.split(':').map(|part| part.parse::<u8>().ok());
        let parsed = (parts.next()??, parts.next()??, parts.next()??);
        parts.next().is_none().then_some(parsed)
    };
    let instant = |year: i32, month: time::Month, day: u8, (hour, minute, second): (u8, u8, u8)| {
        let date = time::Date::from_calendar_date(year, month, day).ok()?;
        let time = time::Time::from_hms(hour, minute, second).ok()?;
        Some(
            time::PrimitiveDateTime::new(date, time)
                .assume_utc()
                .unix_timestamp(),
        )
    };
    let words: Vec<&str> = value.split_whitespace().collect();
    match words.as_slice() {
        // RFC 850: "Sunday, 06-Nov-94 08:49:37 GMT"
        [_, date, time, "GMT"] => {
            let mut parts = date.split('-');
            let day = parts.next()?.parse().ok()?;
            let month = month(parts.next()?)?;
            let short: i32 = parts.next()?.parse().ok()?;
            let year = if short < 70 {
                2000 + short
            } else {
                1900 + short
            };
            instant(year, month, day, clock(time)?)
        }
        // asctime: "Sun Nov  6 08:49:37 1994"
        [_, month_name, day, time, year] => instant(
            year.parse().ok()?,
            month(month_name)?,
            day.parse().ok()?,
            clock(time)?,
        ),
        _ => None,
    }
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
            .and_then(|value| parse_retry_after(value, now));
        match self.known_cause() {
            // A full drive, or a capacity precheck that found too little
            // space: freeing space clears it, never a new upstream release.
            Some(
                KnownFailureCause::StorageFull
                | KnownFailureCause::DestinationCapacity
                | KnownFailureCause::DiscSpace { .. },
            ) => return Some((TemporaryCause::StorageFull, None)),
            Some(KnownFailureCause::InventoryIncomplete { resets_at }) => {
                return Some((TemporaryCause::InventoryIncomplete, *resets_at));
            }
            // Arm reserved for #8638: its
            // `KnownFailureCause::ProviderAllowanceExhausted { resets_at }`
            // classifies as `(TemporaryCause::RateLimited, *resets_at)` here.
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
        assert_eq!(implausible.retry_after, now + STATED_WAIT_CEILING_SECONDS);
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
        // A distant stated date is capped at the one ceiling.
        let reset = reset.unwrap();
        assert!(
            (now + STATED_WAIT_CEILING_SECONDS..=now + STATED_WAIT_CEILING_SECONDS + 5)
                .contains(&reset)
        );
        // A 403 without a stated wait is an authorization refusal: lasting.
        assert_eq!(provider(403, false, None).temporary_cause(), None);
    }

    #[test]
    fn explanation_names_the_situation_and_keeps_the_instant_separate() {
        let retry = TemporaryRetry {
            cause: TemporaryCause::RateLimited,
            attempts: 1,
            retry_after: 1_800_000_000,
        };
        assert_eq!(
            retry.explanation(),
            "Setup stopped because the download site asked Portcove to wait. Portcove will try again automatically."
        );
        let stopping = TemporaryRetry {
            cause: TemporaryCause::Interrupted,
            attempts: REPEATED_INTERRUPTIONS,
            retry_after: 1_800_000_000,
        };
        assert_eq!(
            stopping.explanation(),
            "Setup keeps stopping before it finishes. Portcove will try again automatically."
        );
    }

    #[test]
    fn retry_after_accepts_seconds_and_every_http_date_form_under_one_ceiling() {
        let now = 784_111_000; // 1994-11-06 08:36:40 UTC
        let expected = 784_111_777; // Sun, 06 Nov 1994 08:49:37 GMT
        assert_eq!(parse_retry_after("120", now), Some(now + 120));
        assert_eq!(
            parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", now),
            Some(expected)
        );
        assert_eq!(
            parse_retry_after("Sunday, 06-Nov-94 08:49:37 GMT", now),
            Some(expected)
        );
        assert_eq!(
            parse_retry_after("Sun Nov  6 08:49:37 1994", now),
            Some(expected)
        );
        assert_eq!(
            parse_retry_after("999999999", now),
            Some(now + STATED_WAIT_CEILING_SECONDS)
        );
        for invalid in ["", "-5", "soon", "Sun, 32 Nov 1994 08:49:37 GMT"] {
            assert_eq!(parse_retry_after(invalid, now), None, "{invalid}");
        }
    }

    #[test]
    fn capacity_and_incomplete_inventories_are_temporary() {
        for cause in [
            KnownFailureCause::DestinationCapacity,
            KnownFailureCause::DiscSpace {
                required_bytes: 2,
                available_bytes: 1,
                volume: "D:".into(),
            },
        ] {
            assert_eq!(
                PortcoveError::state("no space")
                    .with_known_cause(cause)
                    .temporary_cause(),
                Some((TemporaryCause::StorageFull, None))
            );
        }
        assert_eq!(
            PortcoveError::network("partial listing")
                .with_known_cause(KnownFailureCause::InventoryIncomplete {
                    resets_at: Some(42)
                })
                .temporary_cause(),
            Some((TemporaryCause::InventoryIncomplete, Some(42)))
        );
    }
}
