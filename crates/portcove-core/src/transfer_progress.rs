//! Progress-based bounds for streamed transfers.
//!
//! A streamed download has no whole-transfer deadline: a large file on a slow
//! link that keeps delivering bytes must be allowed to finish. Two bounds keep
//! a worker from being held forever instead:
//!
//! - the transport's read-idle timeout cuts a connection that goes silent;
//! - this floor cuts a connection that trickles bytes just often enough to
//!   defeat the idle timeout but too slowly to ever be useful.
//!
//! Together they bound one transfer's hold time by its size divided by the
//! floor rate, without penalizing size or ordinary slow links. Cancellation
//! remains the caller's own control.

use std::time::{Duration, Instant};

use crate::PortcoveError;

/// Detail key carried by a transfer cut for lack of progress.
pub(crate) const PROGRESS_FLOOR_DETAIL: &str = "transfer_progress_floor";

/// The minimum useful progress over a sliding observation window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProgressFloor {
    pub window: Duration,
    pub minimum_bytes: u64,
}

/// About 273 bytes per second: below any link a player could use, so only a
/// deliberately or pathologically starved connection reaches it.
pub const PROGRESS_FLOOR: ProgressFloor = ProgressFloor {
    window: Duration::from_secs(60),
    minimum_bytes: 16 * 1024,
};

/// Tracks one connection's bytes against a [`ProgressFloor`].
#[derive(Debug)]
pub struct ProgressWatch {
    floor: ProgressFloor,
    window_start: Instant,
    window_bytes: u64,
}

impl ProgressWatch {
    pub fn new(floor: ProgressFloor) -> Self {
        Self {
            floor,
            window_start: Instant::now(),
            window_bytes: 0,
        }
    }

    /// Records received bytes. Each completed window must have carried at least
    /// the floor's bytes; a window that did not cuts the connection.
    pub fn record(&mut self, bytes: u64) -> std::result::Result<(), PortcoveError> {
        self.record_at(bytes, Instant::now())
    }

    fn record_at(&mut self, bytes: u64, now: Instant) -> std::result::Result<(), PortcoveError> {
        self.window_bytes = self.window_bytes.saturating_add(bytes);
        let elapsed = now.saturating_duration_since(self.window_start);
        if elapsed < self.floor.window {
            return Ok(());
        }
        if self.window_bytes < self.floor.minimum_bytes {
            return Err(PortcoveError::network(
                "the download was receiving data too slowly to finish and was stopped",
            )
            .detail(PROGRESS_FLOOR_DETAIL, self.window_bytes.to_string())
            .detail(
                "transfer_progress_window_seconds",
                elapsed.as_secs().to_string(),
            )
            .transient_transport());
        }
        self.window_start = now;
        self.window_bytes = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FLOOR: ProgressFloor = ProgressFloor {
        window: Duration::from_secs(60),
        minimum_bytes: 1000,
    };

    #[test]
    fn steady_slow_progress_never_reaches_the_floor_regardless_of_total_time() {
        let start = Instant::now();
        let mut watch = ProgressWatch {
            floor: FLOOR,
            window_start: start,
            window_bytes: 0,
        };
        // Twelve hours at 20 bytes per second: far longer than any former
        // whole-transfer deadline, still above the floor in every window.
        for second in 1..=12 * 60 * 60 {
            watch
                .record_at(20, start + Duration::from_secs(second))
                .unwrap();
        }
    }

    #[test]
    fn a_trickle_below_the_floor_is_cut_after_one_window() {
        let start = Instant::now();
        let mut watch = ProgressWatch {
            floor: FLOOR,
            window_start: start,
            window_bytes: 0,
        };
        for second in (14..60).step_by(14) {
            watch
                .record_at(1, start + Duration::from_secs(second))
                .unwrap();
        }
        let error = watch
            .record_at(1, start + Duration::from_secs(70))
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(error.details.contains_key(PROGRESS_FLOOR_DETAIL));
    }

    #[test]
    fn a_fast_window_does_not_excuse_a_later_starved_one() {
        let start = Instant::now();
        let mut watch = ProgressWatch {
            floor: FLOOR,
            window_start: start,
            window_bytes: 0,
        };
        watch
            .record_at(1_000_000, start + Duration::from_secs(61))
            .unwrap();
        watch
            .record_at(10, start + Duration::from_secs(100))
            .unwrap();
        assert!(
            watch
                .record_at(10, start + Duration::from_secs(125))
                .is_err()
        );
    }
}
