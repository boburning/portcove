use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use portcove_core::{
    PortcoveError, PortcoveService, Result, SupportBundleData,
    redact_diagnostic_text as redact_text, redact_diagnostic_value,
    sensitive_diagnostic_field as is_sensitive_field,
};
use serde_json::{Value, json};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::SubscriberExt};

const LOG_FILE_NAME: &str = "portcove-desktop.jsonl";
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
const RETAINED_LOG_FILES: usize = 5;

static NEXT_GITHUB_AUTH_OBSERVATION: AtomicU64 = AtomicU64::new(1);

pub(crate) struct GithubAuthObservation(u64);

impl GithubAuthObservation {
    pub(crate) fn begin() -> Self {
        let observation = Self(NEXT_GITHUB_AUTH_OBSERVATION.fetch_add(1, Ordering::Relaxed));
        tracing::debug!(
            command = "get_github_auth_status",
            request_id = observation.0,
            phase = "start",
            "GitHub auth status observation"
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
            code = ?result.as_ref().err().map(|error| error.code),
            "GitHub auth status observation"
        );
        result
    }
}

#[derive(Clone)]
struct DiagnosticLog {
    inner: Arc<DiagnosticLogInner>,
}

struct DiagnosticLogInner {
    path: PathBuf,
    max_bytes: u64,
    retained_files: usize,
    lock: Mutex<()>,
}

struct DiagnosticLayer {
    log: DiagnosticLog,
}

#[derive(Default)]
struct FieldVisitor {
    fields: BTreeMap<String, Value>,
}

pub fn initialize(logs_dir: &Path) -> Result<()> {
    fs::create_dir_all(logs_dir)?;
    let log = DiagnosticLog::new(
        logs_dir.join(LOG_FILE_NAME),
        MAX_LOG_BYTES,
        RETAINED_LOG_FILES,
    );
    let subscriber = tracing_subscriber::registry().with(DiagnosticLayer { log });
    tracing::subscriber::set_global_default(subscriber).map_err(|error| {
        PortcoveError::state("could not initialize desktop diagnostics")
            .detail("cause", error.to_string())
    })?;
    Ok(())
}

pub fn create_support_bundle(service: &PortcoveService) -> Result<PathBuf> {
    let logs_dir = service.library().logs_dir();
    fs::create_dir_all(&logs_dir)?;
    let timestamp = unix_timestamp_millis();
    let output = logs_dir.join(format!("portcove-support-{timestamp}.zip"));
    let doctor = service.doctor()?;
    let activities = service.library().activities(100)?;
    let summary = SupportBundleData::summary(&doctor, &activities, timestamp);

    let log_files = support_log_files(&logs_dir)?;
    let file = File::create(&output)?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    archive
        .start_file("diagnostics.json", options)
        .map_err(zip_error)?;
    write_support_data(&mut archive, &summary)?;
    for (index, activity) in activities.iter().enumerate() {
        let captures = service.library().activity_diagnostic(&activity.id)?;
        if !captures.is_empty() {
            archive
                .start_file(format!("logs/activity-{index}.json"), options)
                .map_err(zip_error)?;
            // Fixed archive names cannot turn a stored activity ID into a path.
            write_support_data(
                &mut archive,
                &SupportBundleData::activity_captures(&captures),
            )?;
        }
    }
    for path in log_files {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                PortcoveError::unsupported("diagnostic log name is not valid Unicode")
            })?;
        let mut contents = String::new();
        File::open(&path)?.read_to_string(&mut contents)?;
        archive
            .start_file(format!("logs/{name}"), options)
            .map_err(zip_error)?;
        for line in contents.lines() {
            serde_json::to_writer(&mut archive, &SupportBundleData::runtime_log_line(line))?;
            archive.write_all(b"\n")?;
        }
    }
    archive.finish().map_err(zip_error)?.sync_all()?;
    Ok(output)
}

fn write_support_data(writer: &mut impl Write, data: &SupportBundleData) -> Result<()> {
    serde_json::to_writer_pretty(&mut *writer, data)?;
    writer.write_all(b"\n")?;
    Ok(())
}

fn support_log_files(logs_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = fs::read_dir(logs_dir)?
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let approved_name = name == LOG_FILE_NAME
                || (1..=RETAINED_LOG_FILES).any(|index| name == format!("{LOG_FILE_NAME}.{index}"));
            (entry.file_type().ok()?.is_file() && approved_name).then(|| entry.path())
        })
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn zip_error(error: zip::result::ZipError) -> PortcoveError {
    PortcoveError::state("could not create the diagnostic support bundle")
        .detail("cause", error.to_string())
}

impl DiagnosticLog {
    fn new(path: PathBuf, max_bytes: u64, retained_files: usize) -> Self {
        Self {
            inner: Arc::new(DiagnosticLogInner {
                path,
                max_bytes,
                retained_files,
                lock: Mutex::new(()),
            }),
        }
    }

    fn append(&self, event: &Value) -> Result<()> {
        let _guard = self
            .inner
            .lock
            .lock()
            .map_err(|_| PortcoveError::state("diagnostic log lock is unavailable"))?;
        let mut event = event.clone();
        redact_diagnostic_value(&mut event);
        let mut line = serde_json::to_string(&event)?;
        line.push('\n');
        if self.inner.path.metadata().is_ok_and(|metadata| {
            metadata.len().saturating_add(line.len() as u64) > self.inner.max_bytes
        }) {
            rotate_logs(&self.inner.path, self.inner.retained_files)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.inner.path)?;
        file.write_all(line.as_bytes())?;
        file.sync_data()?;
        Ok(())
    }
}

impl<S> Layer<S> for DiagnosticLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _context: tracing_subscriber::layer::Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let metadata = event.metadata();
        let entry = json!({
            "timestamp_ms": unix_timestamp_millis(),
            "level": metadata.level().to_string(),
            "target": metadata.target(),
            "fields": visitor.fields,
        });
        let _ = self.log.append(&entry);
    }
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field, value.to_owned());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.record(field, format!("{value:?}"));
    }
}

impl FieldVisitor {
    fn record(&mut self, field: &Field, value: String) {
        let value = if is_sensitive_field(field.name()) {
            "[REDACTED]".to_owned()
        } else {
            redact_text(&value)
        };
        self.fields
            .insert(field.name().to_owned(), Value::String(value));
    }
}

fn rotate_logs(path: &Path, retained_files: usize) -> Result<()> {
    if retained_files == 0 {
        if path.exists() {
            fs::remove_file(path)?;
        }
        return Ok(());
    }
    for index in (1..retained_files).rev() {
        let source = rotated_path(path, index);
        let destination = rotated_path(path, index + 1);
        if source.exists() {
            if destination.exists() {
                fs::remove_file(&destination)?;
            }
            fs::rename(source, destination)?;
        }
    }
    if path.exists() {
        let first = rotated_path(path, 1);
        if first.exists() {
            fs::remove_file(&first)?;
        }
        fs::rename(path, first)?;
    }
    Ok(())
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{index}", path.display()))
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_observation_preserves_results_and_records_only_fixed_safe_fields() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join(LOG_FILE_NAME);
        let subscriber = tracing_subscriber::registry().with(DiagnosticLayer {
            log: DiagnosticLog::new(path.clone(), MAX_LOG_BYTES, RETAINED_LOG_FILES),
        });
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
            assert_eq!(
                complete["success"],
                if pair_index == 0 { "true" } else { "false" }
            );
            assert_eq!(
                complete["code"],
                if pair_index == 0 {
                    "None"
                } else {
                    "Some(Network)"
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
    fn log_rotation_retains_prior_output_and_restart_appends() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join(LOG_FILE_NAME);
        let first = DiagnosticLog::new(path.clone(), 80, 2);
        first
            .append(&json!({ "message": "first event with enough content to rotate shortly" }))
            .unwrap();
        first
            .append(&json!({ "message": "second event with enough content to rotate now" }))
            .unwrap();
        assert!(rotated_path(&path, 1).is_file());

        let restarted = DiagnosticLog::new(path.clone(), 1_000, 2);
        restarted
            .append(&json!({ "message": "after restart" }))
            .unwrap();
        let active = fs::read_to_string(path).unwrap();
        assert!(active.contains("second event"));
        assert!(active.contains("after restart"));
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

        let bundle = create_support_bundle(&service).unwrap();
        let mut archive = zip::ZipArchive::new(File::open(bundle).unwrap()).unwrap();
        let mut entries = BTreeMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().unwrap().to_owned();
            let mut contents = String::new();
            entry.read_to_string(&mut contents).unwrap();
            entries.insert(name, contents);
        }
        assert_eq!(
            entries.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "diagnostics.json",
                "logs/activity-0.json",
                "logs/portcove-desktop.jsonl",
                "logs/portcove-desktop.jsonl.1",
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
        let summary: Value = serde_json::from_str(&entries["diagnostics.json"]).unwrap();
        assert_eq!(summary["schema_version"], 2);
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
