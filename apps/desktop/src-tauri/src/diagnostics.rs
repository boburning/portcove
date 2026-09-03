use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use portcove_core::{PortcoveError, PortcoveService, Result};
use serde_json::{Value, json};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::SubscriberExt};

const LOG_FILE_NAME: &str = "portcove-desktop.jsonl";
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
const RETAINED_LOG_FILES: usize = 5;

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
    let summary = json!({
        "schema_version": 1,
        "created_at_ms": timestamp,
        "platform": doctor.platform,
        "catalog_port_count": doctor.catalog_port_count,
        "installed_port_count": doctor.installed_port_count,
        "registered_source_count": doctor.registered_source_count,
        "volume_total_bytes": doctor.library.volume_total_bytes,
        "volume_available_bytes": doctor.library.volume_available_bytes,
        "repair_items": doctor.repair.items,
        "host_tools": doctor.host_tools.into_iter().map(|tool| json!({
            "id": tool.id,
            "state": tool.state,
            "source": tool.source,
            "configuration_variable": tool.configuration_variable,
            "purpose": tool.purpose,
        })).collect::<Vec<_>>(),
        "activities": activities,
    });

    let log_files = support_log_files(&logs_dir)?;
    let file = File::create(&output)?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    archive
        .start_file("diagnostics.json", options)
        .map_err(zip_error)?;
    archive.write_all(redact_text(&serde_json::to_string_pretty(&summary)?).as_bytes())?;
    archive.write_all(b"\n")?;
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
        archive.write_all(redact_text(&contents).as_bytes())?;
    }
    archive.finish().map_err(zip_error)?.sync_all()?;
    Ok(output)
}

fn support_log_files(logs_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = fs::read_dir(logs_dir)?
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            (entry.file_type().ok()?.is_file() && name.starts_with(LOG_FILE_NAME))
                .then(|| entry.path())
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
        let mut line = redact_text(&serde_json::to_string(event)?);
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

fn is_sensitive_field(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "credential",
        "authorization",
        "device_code",
        "user_code",
    ]
    .iter()
    .any(|part| name.contains(part))
}

fn redact_text(input: &str) -> String {
    let mut output = input.to_owned();
    for marker in [
        "Bearer ",
        "ghp_",
        "github_pat_",
        "glpat-",
        "token=",
        "password=",
        "secret=",
        "authorization=",
    ] {
        output = redact_after_marker(&output, marker);
    }
    output
}

fn redact_after_marker(input: &str, marker: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    let marker_lower = marker.to_ascii_lowercase();
    while let Some(index) = remaining.to_ascii_lowercase().find(&marker_lower) {
        let (before, matched) = remaining.split_at(index);
        output.push_str(before);
        output.push_str(&matched[..marker.len()]);
        output.push_str("[REDACTED]");
        let after = &matched[marker.len()..];
        let secret_len = after
            .char_indices()
            .take_while(|(_, character)| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            })
            .map(|(index, character)| index + character.len_utf8())
            .last()
            .unwrap_or_default();
        remaining = &after[secret_len..];
    }
    output.push_str(remaining);
    output
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
        fs::write(
            library.logs_dir().join(LOG_FILE_NAME),
            "request Authorization: Bearer private-token safe=visible\n",
        )
        .unwrap();
        let service = PortcoveService::new(library).unwrap();

        let bundle = create_support_bundle(&service).unwrap();
        let mut archive = zip::ZipArchive::new(File::open(bundle).unwrap()).unwrap();
        assert!(archive.by_name("diagnostics.json").is_ok());
        let mut log = String::new();
        archive
            .by_name("logs/portcove-desktop.jsonl")
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        assert!(!log.contains("private-token"));
        assert!(log.contains("[REDACTED]"));
        assert!(log.contains("safe=visible"));
        assert!(archive.file_names().all(|name| !name.contains("sources/")));
    }
}
