//! Two joined read-only checks, never a detached verifier or process grant.
use crate::{PortcoveError, Result};

/// Exactly one scoped thread plus the caller. Each check retains its existing
/// content, path, size and cancellation guards. Both are settled before any
/// result is returned, including an error or unwind in either check.
/// Callers must not nest this helper or pass a mutation/dispatch callback.
pub(super) fn joined_pair<A: Send, B: Send>(
    first: impl FnOnce() -> Result<A> + Send,
    second: impl FnOnce() -> Result<B>,
) -> Result<(A, B)> {
    std::thread::scope(|scope| {
        let first = std::thread::Builder::new()
            .name("psx-input-verification".into())
            .spawn_scoped(scope, first)
            .map_err(|error| {
                PortcoveError::state(format!("PS1 verification worker admission failed: {error}"))
            })?;
        // Catch the caller-side unwind so the admitted worker is explicitly
        // joined before converting either failure into a normal refusal.
        let second = std::panic::catch_unwind(std::panic::AssertUnwindSafe(second));
        let first = first.join();
        let first =
            first.map_err(|_| PortcoveError::state("PS1 input verification worker panicked"))?;
        let second =
            second.map_err(|_| PortcoveError::state("PS1 output verification worker panicked"))?;
        Ok((first?, second?))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::Duration;

    #[test]
    fn both_successful_checks_are_required_for_a_result() {
        assert_eq!(joined_pair(|| Ok(1), || Ok(2)).unwrap(), (1, 2));
        assert!(
            joined_pair(
                || Err::<(), _>(PortcoveError::verification("input drift")),
                || Ok(2)
            )
            .is_err()
        );
        assert!(
            joined_pair(
                || Ok(1),
                || Err::<(), _>(PortcoveError::verification("output drift"))
            )
            .is_err()
        );
    }

    #[test]
    fn refusal_waits_for_the_admitted_read_worker() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let owner = std::thread::spawn(move || {
            let result = joined_pair(
                move || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    Ok(())
                },
                || Err::<(), _>(PortcoveError::verification("output drift")),
            );
            result_tx.send(result.is_err()).unwrap();
        });
        let entered = entered_rx.recv_timeout(Duration::from_secs(2));
        let early = result_rx.recv_timeout(Duration::from_millis(20));
        // Release and join even if the assertion observations are unexpected.
        let _ = release_tx.send(());
        let refused = result_rx.recv_timeout(Duration::from_secs(2));
        owner.join().unwrap();
        assert!(entered.is_ok());
        assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)));
        assert_eq!(refused.unwrap(), true);
    }

    #[test]
    fn either_unwind_settles_the_other_check_before_refusal() {
        let completed = Arc::new(AtomicBool::new(false));
        let observed = completed.clone();
        let result = joined_pair(
            || -> Result<()> { panic!("inert input panic") },
            move || {
                observed.store(true, Ordering::SeqCst);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(completed.load(Ordering::SeqCst));

        let completed = Arc::new(AtomicBool::new(false));
        let observed = completed.clone();
        let result = joined_pair(
            move || {
                observed.store(true, Ordering::SeqCst);
                Ok(())
            },
            || -> Result<()> { panic!("inert output panic") },
        );
        assert!(result.is_err());
        assert!(completed.load(Ordering::SeqCst));
    }

    #[test]
    fn cancellation_refusal_preserves_its_code_after_both_checks_settle() {
        let settled = Arc::new(AtomicBool::new(false));
        let observed = settled.clone();
        let refused = joined_pair(
            || {
                Err::<(), _>(PortcoveError::new(
                    crate::ErrorCode::Cancelled,
                    "inert cancellation",
                ))
            },
            move || {
                observed.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(refused.code, crate::ErrorCode::Cancelled);
        assert!(settled.load(Ordering::SeqCst));
    }
}
