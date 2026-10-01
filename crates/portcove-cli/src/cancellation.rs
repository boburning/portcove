//! Signals request core cancellation and keep the foreground operation supervised.
use portcove_core::{PortcoveService, Result};
use std::sync::Arc;

pub(crate) struct CancellationSignals(tokio::task::JoinHandle<()>);

impl CancellationSignals {
    pub fn start(service: Arc<PortcoveService>) -> Result<Self> {
        // Register before entering any synchronous core work.
        #[cfg(windows)]
        let mut interrupt = tokio::signal::windows::ctrl_c()?;
        #[cfg(unix)]
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
        #[cfg(unix)]
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        Ok(Self(tokio::spawn(async move {
            loop {
                #[cfg(windows)]
                if interrupt.recv().await.is_none() {
                    return;
                }
                #[cfg(unix)]
                tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
                match service.request_owned_cancellations() {
                    Ok((requested, finishing)) => eprintln!(
                        "Cancellation requested for {requested} operation(s); {finishing} operation(s) already finishing. Waiting for a safe terminal result."
                    ),
                    Err(error) => eprintln!("{}", cancellation_warning(&error)),
                }
            }
        })))
    }
}

impl Drop for CancellationSignals {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn cancellation_warning(error: &portcove_core::PortcoveError) -> String {
    format!(
        "Could not request cancellation: {} Waiting for the operation to finish safely.",
        error.presentation().summary
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_failure_does_not_disclose_raw_diagnostics_or_claim_stoppage() {
        let fixture = tempfile::tempdir().unwrap();
        let private_path = fixture.path().join("library").display().to_string();
        let error = portcove_core::PortcoveError::state(format!(
            "database {private_path} unavailable password=fixture-secret\u{1b}[2J\rhidden",
        ))
        .detail("token", "fixture-token");
        let before = error.report();
        let output = cancellation_warning(&error);
        assert!(output.starts_with("Could not request cancellation: "));
        assert!(output.contains("The current operation state could not be confirmed."));
        assert!(output.ends_with("Waiting for the operation to finish safely."));
        for private in [
            private_path.as_str(),
            "fixture-secret",
            "fixture-token",
            "hidden",
        ] {
            assert!(!output.contains(private));
        }
        assert!(!output.chars().any(char::is_control));
        assert!(!output.contains("No files were changed"));
        assert!(!output.contains("operation was cancelled"));
        assert_eq!(
            serde_json::to_value(error.report()).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }

    #[test]
    fn cancellation_warning_keeps_the_core_reason_and_original_error() {
        let error = portcove_core::PortcoveError::conflict("private internal conflict details");
        let output = cancellation_warning(&error);
        assert!(output.contains(&error.presentation().summary));
        assert!(output.contains("Review its current state."));
        assert!(!output.contains(&error.message));
        assert_eq!(error.code, portcove_core::ErrorCode::Conflict);
        assert_eq!(error.message, "private internal conflict details");
    }
}
