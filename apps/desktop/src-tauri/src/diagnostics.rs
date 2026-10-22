use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use portcove_core::{
    ErrorCode, FailureReport, Library, PortcoveError, Result, SupportBundleExport,
    SupportBundleRequest, export_support_bundle,
};
use tracing_subscriber::{Layer, layer::SubscriberExt};

use crate::diagnostics_writer::{Guard, Limits};

const SHUTDOWN_FLUSH: Duration = Duration::from_secs(2);

static NEXT_GITHUB_AUTH_OBSERVATION: AtomicU64 = AtomicU64::new(1);

pub(crate) struct GithubAuthObservation(u64);

impl GithubAuthObservation {
    pub(crate) fn begin() -> Self {
        let observation = Self(NEXT_GITHUB_AUTH_OBSERVATION.fetch_add(1, Ordering::Relaxed));
        tracing::debug!(
            command = "get_github_auth_status",
            request_id = observation.0,
            phase = "start",
            message = "GitHub auth status observation"
        );
        observation
    }

    pub(crate) fn finish<T>(self, result: crate::DesktopResult<T>) -> crate::DesktopResult<T> {
        // Only the closed error-code enum is recorded, never a payload or error report.
        tracing::debug!(
            command = "get_github_auth_status",
            request_id = self.0,
            phase = "complete",
            success = result.is_ok(),
            code = error_code_label(result.as_ref().err().map(|error| error.code)),
            message = "GitHub auth status observation"
        );
        result
    }
}

/// This host-owned location survives library initialization/replacement. It
/// carries no library state and never grants recovery or sharing authority.
#[derive(Clone)]
pub(crate) struct HostDiagnostics {
    pub(crate) directory: crate::DesktopResult<PathBuf>,
    shared: portcove_diagnostics::HostDiagnostics,
}

impl HostDiagnostics {
    fn from_shared(shared: portcove_diagnostics::HostDiagnostics) -> Self {
        Self {
            directory: shared.directory().map(Path::to_path_buf).ok_or_else(|| {
                PortcoveError::state("host diagnostics location is unavailable").report()
            }),
            shared,
        }
    }

    pub(crate) fn start() -> (Self, Option<Guard>) {
        let (shared, mut guard) = portcove_diagnostics::HostDiagnostics::start(
            portcove_diagnostics::Surface::Desktop,
            portcove_diagnostics::debug_requested(),
        );
        let subscriber =
            tracing_subscriber::registry().with(shared.layer().with_filter(shared.filter()));
        if tracing::subscriber::set_global_default(subscriber).is_err() {
            // Subscriber conflicts cannot change otherwise valid startup.
            shutdown(&mut guard);
        }
        (Self::from_shared(shared), guard)
    }

    pub(crate) fn health(&self) -> String {
        let health = self.shared.health();
        let sessions = self.shared.sessions();
        // Live independent readback: fixed copy and numeric/closed values only.
        // This command does not open a library, read a log, or emit an event.
        format!(
            "Runtime diagnostics: {:?}\n\
             admitted={} written={} dropped={} queue={}/{} peak={}\n\
             full={} closed={} formatting={} oversized={} truncated_fields={} opaque_fields={}\n\
             open_errors={} write_errors={} rotation_errors={} retention_errors={} lease_errors={}\n\
             permission_errors={} disk_full_errors={} flush_errors={}\n\
             record_limit={} field_limit={} value_budget={} producer_limit={}\n\
             field_count_limit={} field_name_limit={} target_limit={}\n\
             segment_limit={} retained_generations={} max_age_days=7 shutdown_deadline_ms=2000\n\
             session_limit=8 active_sessions={} unavailable_sessions={} previous_unclean_sessions={} pruned_sessions={}\n\
             inactive_bytes_observed={} inactive_target_bytes=67108864 managed_payload_bound_bytes=201326592 fallback={}\n\
             bootstrap_deadline_ms={} bootstrap_timed_out={}\n\
             Best effort; abrupt exit can lose queued or unsynchronized records.",
            health.flush_state,
            health.admitted,
            health.written,
            health.dropped,
            health.queue_depth,
            Limits::default().queue_capacity,
            health.queue_high_water,
            health.dropped_full,
            health.dropped_closed,
            health.dropped_formatting,
            health.dropped_oversized,
            health.truncated_fields,
            health.opaque_fields,
            health.open_errors,
            health.write_errors,
            health.rotation_errors,
            health.retention_errors,
            health.lease_errors,
            health.permission_errors,
            health.disk_full_errors,
            health.flush_errors,
            Limits::default().max_record_bytes,
            crate::diagnostics_events::MAX_FIELD_BYTES,
            crate::diagnostics_events::MAX_VALUE_BYTES,
            crate::diagnostics_events::MAX_FORMATTING_PRODUCERS,
            crate::diagnostics_events::MAX_FIELDS,
            crate::diagnostics_events::MAX_FIELD_NAME_BYTES,
            crate::diagnostics_events::MAX_TARGET_BYTES,
            Limits::default().max_file_bytes,
            Limits::default().retained_files,
            sessions.active_sessions,
            sessions.unavailable_sessions,
            sessions.previous_unclean_sessions,
            sessions.pruned_sessions,
            sessions.retained_inactive_bytes,
            self.shared.used_fallback(),
            portcove_diagnostics::BOOTSTRAP_TIMEOUT_MS,
            self.shared.bootstrap_timed_out(),
        )
    }
}

pub(crate) fn shutdown(guard: &mut Option<Guard>) {
    if let Some(mut guard) = guard.take() {
        let _ = guard.shutdown(SHUTDOWN_FLUSH);
    }
}

// The closed domain enum has bounded fixed labels. Never format a whole error
// or call an arbitrary Debug implementation to recover this useful field.
pub(crate) fn error_code_label(code: Option<ErrorCode>) -> &'static str {
    match code {
        None => "None",
        Some(ErrorCode::Usage) => "Some(Usage)",
        Some(ErrorCode::Unsupported) => "Some(Unsupported)",
        Some(ErrorCode::NotFound) => "Some(NotFound)",
        Some(ErrorCode::SourceInvalid) => "Some(SourceInvalid)",
        Some(ErrorCode::Network) => "Some(Network)",
        Some(ErrorCode::Verification) => "Some(Verification)",
        Some(ErrorCode::Install) => "Some(Install)",
        Some(ErrorCode::State) => "Some(State)",
        Some(ErrorCode::Launch) => "Some(Launch)",
        Some(ErrorCode::Conflict) => "Some(Conflict)",
        Some(ErrorCode::Cancelled) => "Some(Cancelled)",
    }
}

pub fn create_support_bundle(
    library: Option<&Library>,
    startup_failure: Option<&FailureReport>,
    directory: &Path,
) -> Result<SupportBundleExport> {
    export_support_bundle(SupportBundleRequest {
        destination_dir: directory,
        logs_dir: Some(directory),
        library,
        startup_failure,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics_events::DiagnosticLayer;
    use crate::diagnostics_writer::{
        EnqueueOutcome, FlushState, LOG_FILE_NAME, Producer, RuntimeWriter,
    };
    use portcove_core::{
        HostPreferenceStore, PortcoveService, redact_diagnostic_text as redact_text,
        redact_diagnostic_value, sensitive_diagnostic_field as is_sensitive_field,
    };
    use serde_json::{Value, json};
    use std::{
        collections::BTreeMap,
        fs::{self, File},
        io::Read,
    };

    fn append_fixture(producer: &Producer, mut value: Value) {
        redact_diagnostic_value(&mut value);
        let mut record = serde_json::to_vec(&value).unwrap();
        record.push(b'\n');
        assert_eq!(producer.try_record(record), EnqueueOutcome::Accepted);
    }

    #[test]
    fn support_export_uses_host_location_without_a_ready_library() {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let preferences = HostPreferenceStore::new(root.join("preferences.json")).unwrap();
        let (shared, mut host_guard) = portcove_diagnostics::HostDiagnostics::start_in(
            &preferences.diagnostics_directory(),
            portcove_diagnostics::Surface::Desktop,
            false,
        );
        let session = shared
            .session_directory()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let subscriber =
            tracing_subscriber::registry().with(shared.layer().with_filter(shared.filter()));
        let host = HostDiagnostics::from_shared(shared);
        let directory = host.directory.as_ref().unwrap();
        assert_eq!(directory, &root.join("diagnostics"));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(
                target: "portcove_desktop",
                message = "startup host log remains available"
            );
        });
        shutdown(&mut host_guard);
        assert_eq!(host.shared.health().flush_state, FlushState::Complete);
        let failure = PortcoveError::state("unavailable library token=startup-canary").report();
        let original = failure.clone();
        let exported = create_support_bundle(None, Some(&failure), directory).unwrap();
        assert!(!exported.manifest.library_available);
        assert_eq!(failure, original);
        assert!(exported.path.is_file());
        let mut archive = zip::ZipArchive::new(File::open(exported.path).unwrap()).unwrap();
        let mut log = String::new();
        archive
            .by_name(&format!("logs/{session}/{LOG_FILE_NAME}"))
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        assert!(log.contains("startup host log remains available"));
        assert!(!root.join("preferences.json").exists());
    }

    #[test]
    fn auth_observation_preserves_results_and_records_only_fixed_safe_fields() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join(LOG_FILE_NAME);
        let (producer, mut guard) = RuntimeWriter::start(path.clone(), Limits::default()).unwrap();
        let subscriber = tracing_subscriber::registry().with(DiagnosticLayer::new(producer));
        let value = Box::new("github_pat_success_payload".to_owned());
        let value_address = std::ptr::from_ref(value.as_ref());
        let failure = crate::DesktopError::from(
            PortcoveError::network("private_transport_message")
                .detail("Authorization", "Bearer private_header_value"),
        );
        tracing::subscriber::with_default(subscriber, || {
            let forwarded = GithubAuthObservation::begin().finish(Ok(value)).unwrap();
            assert_eq!(std::ptr::from_ref(forwarded.as_ref()), value_address);
            assert_eq!(forwarded.as_str(), "github_pat_success_payload");
            let forwarded = GithubAuthObservation::begin()
                .finish::<()>(Err(failure.clone()))
                .unwrap_err();
            assert_eq!(forwarded, failure);
        });
        assert_eq!(
            guard.shutdown(Duration::from_secs(2)).flush_state,
            FlushState::Complete
        );
        let text = fs::read_to_string(path).unwrap();
        for secret in [
            "github_pat_success_payload",
            "private_transport_message",
            "Authorization",
            "private_header_value",
        ] {
            assert!(!text.contains(secret));
        }
        let events: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events.len(), 4);
        for (pair_index, pair) in events.as_chunks::<2>().0.iter().enumerate() {
            let start = pair[0]["fields"].as_object().unwrap();
            let complete = pair[1]["fields"].as_object().unwrap();
            assert_eq!(start["command"], "get_github_auth_status");
            assert_eq!(start["phase"], "start");
            assert_eq!(start.len(), 4);
            assert_eq!(complete["command"], "get_github_auth_status");
            assert_eq!(complete["phase"], "complete");
            assert_eq!(complete.len(), 6);
            assert_eq!(complete["request_id"], start["request_id"]);
            assert_eq!(complete["success"], pair_index == 0);
            assert_eq!(
                complete["code"],
                if pair_index == 0 {
                    Value::Null
                } else {
                    json!("network")
                }
            );
        }
        assert_ne!(
            events[0]["fields"]["request_id"],
            events[2]["fields"]["request_id"]
        );
    }

    #[test]
    fn redaction_covers_structured_fields_and_common_inline_credentials() {
        assert!(is_sensitive_field("github_token"));
        assert!(is_sensitive_field("Authorization"));
        let redacted = redact_text(
            "Authorization: Bearer abc-123 token=top_secret PASSWORD=CapsSecret github_pat_long-value safe=visible",
        );
        assert!(!redacted.contains("abc-123"));
        assert!(!redacted.contains("top_secret"));
        assert!(!redacted.contains("CapsSecret"));
        assert!(!redacted.contains("github_pat_long-value"));
        assert!(redacted.contains("safe=visible"));
    }

    #[test]
    fn unsafe_existing_host_log_cannot_be_enabled_for_startup_writes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let foreign = root.join("private-file");
        fs::write(&foreign, b"preserve foreign data").unwrap();
        let directory = root.join("diagnostics");
        fs::create_dir(&directory).unwrap();
        fs::hard_link(&foreign, directory.join(LOG_FILE_NAME)).unwrap();
        // Root preparation still validates legacy logs before a session slot
        // is allocated. A foreign alias must never be adopted for writing.
        let (shared, guard) = portcove_diagnostics::HostDiagnostics::start_in(
            &directory,
            portcove_diagnostics::Surface::Desktop,
            false,
        );
        assert!(guard.is_none());
        assert!(shared.session_directory().is_none());
        assert_eq!(shared.health().flush_state, FlushState::Unavailable);
        let host = HostDiagnostics::from_shared(shared);
        assert!(host.directory.is_err());
        assert_eq!(fs::read(&foreign).unwrap(), b"preserve foreign data");
        assert_eq!(
            fs::read(directory.join(LOG_FILE_NAME)).unwrap(),
            b"preserve foreign data"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_host_ancestor_cannot_redirect_early_logging() {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        let foreign = root.join("foreign");
        fs::create_dir(&foreign).unwrap();
        let alias = root.join("aliased-host");
        std::os::unix::fs::symlink(&foreign, &alias).unwrap();
        let (shared, guard) = portcove_diagnostics::HostDiagnostics::start_in(
            &alias.join("diagnostics"),
            portcove_diagnostics::Surface::Desktop,
            false,
        );
        assert!(guard.is_none());
        assert!(shared.session_directory().is_none());
        assert_eq!(shared.health().flush_state, FlushState::Unavailable);
        let host = HostDiagnostics::from_shared(shared);
        assert!(host.directory.is_err());
        assert_eq!(fs::read_link(alias).unwrap(), foreign);
        assert!(!foreign.join("diagnostics").exists());
    }

    #[test]
    fn log_rotation_retains_prior_output_and_restart_appends() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join(LOG_FILE_NAME);
        let limits = Limits {
            max_record_bytes: 80,
            max_file_bytes: 80,
            retained_files: 2,
            ..Limits::default()
        };
        let (first, mut guard) = RuntimeWriter::start(path.clone(), limits).unwrap();
        append_fixture(
            &first,
            json!({ "message": "first event with enough content to rotate shortly" }),
        );
        append_fixture(
            &first,
            json!({ "message": "second event with enough content to rotate now" }),
        );
        assert_eq!(
            guard.shutdown(Duration::from_secs(2)).flush_state,
            FlushState::Complete
        );
        assert!(
            temporary
                .path()
                .join(format!("{LOG_FILE_NAME}.1"))
                .is_file()
        );

        let limits = Limits {
            max_record_bytes: 1_000,
            max_file_bytes: 1_000,
            retained_files: 2,
            ..Limits::default()
        };
        let (restarted, mut guard) = RuntimeWriter::start(path.clone(), limits).unwrap();
        append_fixture(&restarted, json!({ "message": "after restart" }));
        assert_eq!(
            guard.shutdown(Duration::from_secs(2)).flush_state,
            FlushState::Complete
        );
        let active = fs::read_to_string(path).unwrap();
        assert!(active.contains("second event"));
        assert!(active.contains("after restart"));
    }

    #[test]
    fn live_health_is_independent_of_logs_and_a_ready_library() {
        let temporary = tempfile::tempdir().unwrap();
        let blocked = temporary.path().join("private-path-token-health-canary");
        fs::write(&blocked, b"preserved").unwrap();
        let (shared, guard) = portcove_diagnostics::HostDiagnostics::start_in(
            &blocked,
            portcove_diagnostics::Surface::Desktop,
            false,
        );
        assert!(guard.is_none());
        let host = HostDiagnostics::from_shared(shared);
        let first = host.health();
        assert_eq!(first, host.health());
        assert!(first.contains("Unavailable"));
        assert!(first.contains("record_limit=32768"));
        assert!(!first.contains("private-path"));
        assert!(!first.contains("health-canary"));
        assert_eq!(host.shared.health().admitted, 0);
    }

    #[test]
    fn support_bundle_redacts_logs_and_omits_source_payloads() {
        let temporary = tempfile::tempdir().unwrap();
        let library = portcove_core::Library::open(temporary.path().join("library")).unwrap();
        let runtime = json!({
            "timestamp_ms": 1,
            "level": "ERROR",
            "target": "portcove_desktop",
            "memo": "unmarked-envelope-canary",
            "fields": {
                "message": "diagnostic token=runtime-canary safe=structured",
                "operation_id": "operation-1",
                "memo": "unmarked-runtime-canary",
                "event": { "memo": "unmarked-nested-canary" },
                "library_root": "unmarked-location-canary",
                "component_stack": "unmarked-frontend-canary"
            }
        });
        fs::write(
            library.logs_dir().join(LOG_FILE_NAME),
            format!("request Authorization: Bearer private-token safe=visible\n{runtime}\n"),
        )
        .unwrap();
        fs::write(
            library.logs_dir().join(format!("{LOG_FILE_NAME}.1")),
            "{\"memo\":\"unmarked-incomplete-canary\"",
        )
        .unwrap();
        fs::write(
            library
                .logs_dir()
                .join(format!("{LOG_FILE_NAME}.private-canary")),
            "unmarked-extra-file-canary",
        )
        .unwrap();
        let source_payload = library.root().join("private-source-payload.bin");
        fs::write(&source_payload, "unmarked-source-payload-canary").unwrap();
        fs::create_dir(library.root().join("private-credentials")).unwrap();
        fs::write(
            library.root().join("private-credentials/account.json"),
            "{\"memo\":\"unmarked-credential-store-canary\"}",
        )
        .unwrap();
        // Owned persisted fixtures exercise the real activity/capture readers.
        let failure = PortcoveError::state("failed password=failure-canary")
            .detail("memo", "unmarked-failure-canary")
            .report();
        let activity_id = "../not-an-archive-path";
        let capture = portcove_core::ActivityDiagnostic {
            activity_id: activity_id.into(),
            phase: "preparation.setup".into(),
            stdout: portcove_core::DiagnosticStream {
                text: "compiler progress token=capture-stdout-canary".into(),
                observed_bytes: 3_000_000,
                truncated: true,
            },
            stderr: portcove_core::DiagnosticStream {
                text: "Bearer capture-stderr-canary".into(),
                observed_bytes: 100,
                truncated: false,
            },
            complete: false,
            updated_at: 3,
            stream_limit_bytes: 2 * 1024 * 1024,
        };
        let payload = serde_json::to_string(&capture).unwrap();
        let failure_json = serde_json::to_string(&failure).unwrap();
        let connection =
            rusqlite::Connection::open(library.root().join("portcove.sqlite3")).unwrap();
        connection.execute(
            "INSERT INTO activity_history(id,operation,target_kind,target_id,status,message,started_at,finished_at,failure_json)
             VALUES(?1,'prepare','source',?2,'failed','retained failure',1,2,?3)",
            rusqlite::params![activity_id, source_payload.to_string_lossy(), failure_json],
        ).unwrap();
        connection.execute(
            "INSERT INTO activity_diagnostics(activity_id,phase,payload,updated_at,payload_bytes)
             VALUES(?1,'preparation.setup',?2,3,?3)",
            rusqlite::params![activity_id, payload, payload.len()],
        ).unwrap();
        drop(connection);
        let service = PortcoveService::new(library).unwrap();

        let bundle =
            create_support_bundle(Some(service.library()), None, &service.library().logs_dir())
                .unwrap();
        let mut archive = zip::ZipArchive::new(File::open(&bundle.path).unwrap()).unwrap();
        let mut entries = BTreeMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().unwrap().into_owned();
            let mut contents = String::new();
            entry.read_to_string(&mut contents).unwrap();
            entries.insert(name, contents);
        }
        assert_eq!(
            entries.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "activities.json",
                "doctor.json",
                "logs/activity-0.json",
                "logs/portcove-desktop.jsonl",
                "logs/portcove-desktop.jsonl.1",
                "manifest.json",
                "startup.json",
            ]
        );
        let exported = serde_json::to_string(&entries).unwrap();
        for canary in [
            "unmarked",
            "private-canary",
            "private-source-payload",
            "private-token",
            "runtime-canary",
            "failure-canary",
            "capture-stdout-canary",
            "capture-stderr-canary",
        ] {
            assert!(!exported.contains(canary), "archive leaked {canary}");
        }
        assert!(exported.contains("[REDACTED]"));
        assert!(exported.contains("safe=visible"));
        assert!(exported.contains("safe=structured"));
        let summary: Value = serde_json::from_str(&entries["activities.json"]).unwrap();
        assert_eq!(summary["schema_version"], 1);
        assert_eq!(summary["activities"][0]["failure"]["details_omitted"], 1);
        assert_eq!(summary["activities"][0]["target_id_omitted"], true);
        let captures: Value = serde_json::from_str(&entries["logs/activity-0.json"]).unwrap();
        assert_eq!(captures[0]["complete"], false);
        assert_eq!(captures[0]["stdout"]["truncated"], true);
        assert_eq!(captures[0]["stdout"]["observed_bytes"], 3_000_000);
        assert_eq!(
            service.library().activity_diagnostic(activity_id).unwrap(),
            vec![capture]
        );
        assert_eq!(
            service.library().activities(1).unwrap()[0].failure.as_ref(),
            Some(&failure)
        );
        assert_eq!(
            fs::read_to_string(source_payload).unwrap(),
            "unmarked-source-payload-canary"
        );
    }
}
