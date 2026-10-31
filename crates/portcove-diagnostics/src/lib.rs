//! Host-owned, best-effort diagnostics shared by Desktop and CLI.
//!
//! Executables install subscribers. Core owns classification and emits observations;
//! neither logs nor session markers grant library, operation or recovery authority.

use std::{
    io,
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tracing::level_filters::LevelFilter;
use tracing_subscriber::{filter::Targets, layer::SubscriberExt};

pub mod events;
mod sessions;
pub mod writer;

pub use sessions::{SESSION_LIMIT, SESSION_MARKER, SLOT_NAMES, SessionReport};

/// Maximum caller wait for diagnostic location/session filesystem preparation.
/// A stalled OS call may outlive this budget on its one bootstrap thread; it can
/// neither install a subscriber nor start a late writer after the caller leaves.
pub const BOOTSTRAP_TIMEOUT_MS: u64 = 250;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    Desktop,
    Cli,
}

impl Surface {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Cli => "cli",
        }
    }
}

/// This opt-in belongs only to the new process; it is never persisted in settings.
pub fn debug_requested() -> bool {
    std::env::var_os("PORTCOVE_DIAGNOSTICS_DEBUG").as_deref() == Some(std::ffi::OsStr::new("1"))
}

/// File diagnostics use application INFO / dependency WARN, with application-only
/// DEBUG for this session when explicitly requested. CLI stderr keeps its own filter.
pub fn file_filter(debug: bool) -> Targets {
    let application = if debug {
        LevelFilter::DEBUG
    } else {
        LevelFilter::INFO
    };
    Targets::new()
        .with_default(LevelFilter::WARN)
        .with_target("portcove_core", application)
        .with_target("portcove_cli", application)
        .with_target("portcove_desktop", application)
        .with_target("portcove_diagnostics", application)
}

pub fn code_label(code: portcove_core::ErrorCode) -> &'static str {
    use portcove_core::ErrorCode;
    match code {
        ErrorCode::Usage => "usage",
        ErrorCode::Unsupported => "unsupported",
        ErrorCode::NotFound => "not_found",
        ErrorCode::SourceInvalid => "source_invalid",
        ErrorCode::Network => "network",
        ErrorCode::Verification => "verification",
        ErrorCode::Install => "install",
        ErrorCode::State => "state",
        ErrorCode::Launch => "launch",
        ErrorCode::Conflict => "conflict",
        ErrorCode::Cancelled => "cancelled",
    }
}

#[derive(Clone)]
pub struct HostDiagnostics {
    directory: Option<PathBuf>,
    session_directory: Option<PathBuf>,
    session_id: uuid::Uuid,
    session_label: String,
    surface: Surface,
    debug: bool,
    started: std::time::Instant,
    producer: writer::Producer,
    sessions: SessionReport,
    fallback: bool,
    bootstrap_timed_out: bool,
    qualification_prepared: bool,
}

struct Prepared {
    directory: PathBuf,
    allocation: Option<sessions::Allocation>,
    report: SessionReport,
    previous: Vec<String>,
    fallback: bool,
}

impl HostDiagnostics {
    /// Resolve the configured preference *location*, without constructing or
    /// reading a preference store. A bad location falls back to the OS per-user
    /// configuration directory; a failure after choosing a root never switches it.
    pub fn start(surface: Surface, debug: bool) -> (Self, Option<writer::Guard>) {
        #[cfg(feature = "qualification-fixtures")]
        if Self::qualification_preparation_requested(
            std::env::var("PORTCOVE_DIAGNOSTICS_QUALIFICATION_PREPARED")
                .ok()
                .as_deref(),
        ) {
            let (configured, platform) = Self::configured_locations();
            return Self::start_with_locations(
                configured.as_deref(),
                platform.as_deref(),
                surface,
                debug,
            );
        }
        Self::bootstrap(surface, debug, |session, surface| {
            let (configured, platform) = Self::configured_locations();
            Self::prepare_locations(configured.as_deref(), platform.as_deref(), session, surface)
        })
    }

    fn configured_locations() -> (Option<PathBuf>, Option<PathBuf>) {
        let configured = std::env::var_os("PORTCOVE_PREFERENCES")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        let platform = portcove_core::HostPreferenceStore::default_path().ok();
        (configured, platform)
    }

    #[cfg(any(test, feature = "qualification-fixtures"))]
    fn qualification_preparation_requested(value: Option<&str>) -> bool {
        cfg!(feature = "qualification-fixtures") && value == Some("1")
    }

    #[cfg(any(test, feature = "qualification-fixtures"))]
    fn start_with_locations(
        configured: Option<&Path>,
        platform: Option<&Path>,
        surface: Surface,
        debug: bool,
    ) -> (Self, Option<writer::Guard>) {
        // Available-sink fixtures own prepared sessions, not the production
        // deadline. Ordinary construction and blocked-bootstrap coverage retain
        // the real 250ms timeout and no-late-writer contract.
        let host = Self::disabled(surface, debug);
        let host = Self {
            qualification_prepared: true,
            ..host
        };
        let Some(prepared) =
            Self::prepare_locations(configured, platform, host.session_id, surface)
        else {
            return (host, None);
        };
        host.start_prepared(prepared)
    }

    fn prepare_locations(
        configured: Option<&Path>,
        platform: Option<&Path>,
        session: uuid::Uuid,
        surface: Surface,
    ) -> Option<Prepared> {
        for (index, preference) in [configured, platform].into_iter().enumerate() {
            let Some(preference) = preference else {
                continue;
            };
            if !preference.is_absolute() || preference.file_name().is_none() {
                continue;
            }
            let directory = preference.with_file_name("diagnostics");
            let Ok(directory) = portcove_core::prepare_support_log_directory(&directory) else {
                continue;
            };
            let mut prepared = Self::prepare_session(directory, session, surface);
            prepared.fallback = index == 1 && configured.is_some();
            return Some(prepared);
        }
        None
    }

    fn prepare_session(directory: PathBuf, session: uuid::Uuid, surface: Surface) -> Prepared {
        let (allocation, report, previous) = sessions::allocate(&directory, session, surface);
        Prepared {
            directory,
            allocation,
            report,
            previous,
            fallback: false,
        }
    }

    /// Explicit isolated root for owned fixtures and host integrations. No fallback
    /// is attempted; failures are health observations, never startup errors.
    pub fn start_in(
        directory: &Path,
        surface: Surface,
        debug: bool,
    ) -> (Self, Option<writer::Guard>) {
        #[cfg(feature = "qualification-fixtures")]
        if Self::qualification_preparation_requested(
            std::env::var("PORTCOVE_DIAGNOSTICS_QUALIFICATION_PREPARED")
                .ok()
                .as_deref(),
        ) {
            let host = Self {
                qualification_prepared: true,
                ..Self::disabled(surface, debug)
            };
            if !directory.is_absolute() {
                return (host, None);
            }
            let Ok(directory) = portcove_core::prepare_support_log_directory(directory) else {
                return (host, None);
            };
            let prepared = Self::prepare_session(directory, host.session_id, surface);
            return host.start_prepared(prepared);
        }
        let directory = directory.to_owned();
        Self::bootstrap(surface, debug, move |session, surface| {
            if !directory.is_absolute() {
                return None;
            }
            let directory = portcove_core::prepare_support_log_directory(&directory).ok()?;
            Some(Self::prepare_session(directory, session, surface))
        })
    }

    fn bootstrap(
        surface: Surface,
        debug: bool,
        prepare: impl FnOnce(uuid::Uuid, Surface) -> Option<Prepared> + Send + 'static,
    ) -> (Self, Option<writer::Guard>) {
        let mut host = Self::disabled(surface, debug);
        let session = host.session_id;
        let deadline = Instant::now() + Duration::from_millis(BOOTSTRAP_TIMEOUT_MS);
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("portcove-diagnostic-bootstrap".into())
            .spawn(move || {
                let prepared = prepare(session, surface);
                // One owned value and one nonblocking send. A timed-out receiver
                // discards the allocation here, releasing its lease only after
                // blocked preparation has returned. No writer runs on this thread.
                let _ = sender.try_send(prepared);
            });
        if worker.is_err() {
            return (host, None);
        }
        // Never join a bootstrap thread that could still be inside an OS call.
        drop(worker);
        let result = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        if Instant::now() >= deadline || matches!(result, Err(mpsc::RecvTimeoutError::Timeout)) {
            host.bootstrap_timed_out = true;
            return (host, None);
        }
        match result {
            Ok(Some(prepared)) => host.start_prepared(prepared),
            Ok(None) | Err(_) => (host, None),
        }
    }

    fn disabled(surface: Surface, debug: bool) -> Self {
        let session_id = uuid::Uuid::new_v4();
        Self {
            directory: None,
            session_directory: None,
            session_id,
            session_label: session_id.to_string(),
            surface,
            debug,
            started: std::time::Instant::now(),
            producer: writer::Producer::disabled(io::ErrorKind::NotConnected),
            sessions: SessionReport::default(),
            fallback: false,
            bootstrap_timed_out: false,
            qualification_prepared: false,
        }
    }

    fn start_prepared(mut self, prepared: Prepared) -> (Self, Option<writer::Guard>) {
        self.directory = Some(prepared.directory);
        self.sessions = prepared.report;
        self.fallback = prepared.fallback;
        let Some(allocation) = prepared.allocation else {
            return (self, None);
        };
        self.session_directory = Some(allocation.directory.clone());
        let result =
            writer::RuntimeWriter::spawn(writer::Limits::default(), allocation.into_sink());
        let Ok((producer, guard)) = result else {
            return (self, None);
        };
        let mut host = self;
        let previous = prepared.previous;
        host.producer = producer;
        // The global subscriber is still executable-owned. These bounded initial
        // observations use the same approved layer and contain no paths/arguments.
        tracing::subscriber::with_default(
            tracing_subscriber::registry().with(host.layer()),
            || {
                tracing::info!(target: "portcove_diagnostics", component = "startup", phase = "start",
                message = "host diagnostic session started");
                #[cfg(feature = "qualification-fixtures")]
                if host.qualification_prepared {
                    tracing::info!(target: "portcove_diagnostics", component = "startup",
                        phase = "start", qualification_prepared = true,
                        message = "owned qualification prepared diagnostics; excludes production bootstrap availability and latency");
                }
                for session in previous {
                    tracing::warn!(target: "portcove_diagnostics", component = "startup",
                    phase = "unclean_session", previous_session_id = session.as_str(),
                    observed_result = "unknown", session_clean = false,
                    message = "previous diagnostic session has no completed-close record; cause unknown");
                }
            },
        );
        (host, Some(guard))
    }

    pub fn directory(&self) -> Option<&Path> {
        self.directory.as_deref()
    }
    pub fn session_directory(&self) -> Option<&Path> {
        self.session_directory.as_deref()
    }
    pub fn session_id(&self) -> &str {
        &self.session_label
    }
    pub fn producer(&self) -> writer::Producer {
        self.producer.clone()
    }
    pub fn health(&self) -> writer::HealthSnapshot {
        self.producer.health()
    }
    /// Snapshot of the bounded startup retention pass, separate from writer health.
    pub fn sessions(&self) -> SessionReport {
        self.sessions
    }
    pub fn used_fallback(&self) -> bool {
        self.fallback
    }
    /// Actual qualification-only constructor selection, never a latency claim.
    pub fn qualification_prepared(&self) -> bool {
        self.qualification_prepared
    }
    pub fn bootstrap_timed_out(&self) -> bool {
        self.bootstrap_timed_out
    }
    pub fn layer(&self) -> events::DiagnosticLayer {
        events::DiagnosticLayer::with_started_at(
            self.producer(),
            self.session_id,
            self.surface,
            self.started,
        )
    }
    pub fn filter(&self) -> Targets {
        file_filter(self.debug)
    }
}

#[cfg(test)]
mod tests;
