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
                    Err(error) => eprintln!(
                        "Could not request cancellation: {error}. Waiting for the operation to finish safely."
                    ),
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
