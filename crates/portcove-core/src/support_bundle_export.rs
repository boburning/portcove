//! Bounded, best-effort support collection. The archive is an observation, never
//! application state or recovery authority. Only classified data enters it.

use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use schemars::JsonSchema;
use serde::Serialize;

use crate::{
    ActivityRecord, FailureReport, Library, PortcoveError, Result, SupportBundleData,
    support_bundle_read::{
        BoundedCaptures, SUPPORT_BUNDLE_ACTIVITY_LIMIT, SUPPORT_BUNDLE_CAPTURE_BYTES,
        SUPPORT_BUNDLE_CAPTURE_LIMIT,
    },
};

const MIB: usize = 1024 * 1024;
const LOG_NAME: &str = "portcove-desktop.jsonl";
const ROTATIONS: usize = 5;
const SESSION_SLOTS: usize = 8;
const MANIFEST_BYTES: usize = 64 * 1024;

/// Prepare only the host's fixed log namespace. An existing alias or nonregular
/// log must not cause early startup logging to write into an unrelated file.
pub fn prepare_support_log_directory(directory: &Path) -> Result<PathBuf> {
    crate::path::refuse_symlink_ancestors(directory)?;
    fs::create_dir_all(directory)?;
    crate::path::refuse_symlink_ancestors(directory)?;
    let directory = fs::canonicalize(directory)?;
    for index in 0..=ROTATIONS {
        let name = if index == 0 {
            LOG_NAME.into()
        } else {
            format!("{LOG_NAME}.{index}")
        };
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                crate::external_runtime::open_single_link_file(&path)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(directory)
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SupportBundleExport {
    pub path: PathBuf,
    pub manifest: SupportBundleManifest,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SupportBundleManifest {
    pub schema_version: u32,
    pub created_at_ms: u64,
    pub product_version: String,
    pub target_os: String,
    pub target_arch: String,
    /// No source revision is invented when the build does not provide one.
    pub source_revision: Option<String>,
    pub scope: SupportBundleScope,
    pub library_available: bool,
    pub limits: SupportBundleLimits,
    pub sections: Vec<SupportBundleSection>,
}

#[derive(Debug, Clone, Copy, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SupportBundleScope {
    BoundedRecentDiagnostics,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SupportBundleLimits {
    pub total_bytes: usize,
    pub section_bytes: usize,
    pub log_bytes: usize,
    /// Aggregate raw runtime-log input across session and legacy candidates.
    pub log_input_bytes: usize,
    pub record_bytes: usize,
    pub activity_count: usize,
    pub capture_count: usize,
    /// Cooperative checkpoints; this does not time out a blocked OS call.
    pub collection_seconds: u64,
}

impl Default for SupportBundleLimits {
    fn default() -> Self {
        Self {
            total_bytes: 16 * MIB,
            section_bytes: 8 * MIB,
            log_bytes: 4 * MIB,
            log_input_bytes: 24 * MIB,
            record_bytes: 64 * 1024,
            activity_count: SUPPORT_BUNDLE_ACTIVITY_LIMIT,
            capture_count: SUPPORT_BUNDLE_CAPTURE_LIMIT,
            collection_seconds: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SupportBundleSection {
    pub kind: SupportBundleSectionKind,
    pub provenance: SupportBundleProvenance,
    pub entry: Option<String>,
    pub status: SupportBundleSectionStatus,
    /// Closed reasons only. OS/SQL errors, paths and payloads never enter here.
    pub reasons: Vec<SupportBundleReason>,
    pub bytes_read: Option<usize>,
    pub bytes_written: usize,
    pub records: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SupportBundleSectionKind {
    Startup,
    Doctor,
    Activities,
    ActivityCapture,
    RuntimeLog,
}

#[derive(Debug, Clone, Copy, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SupportBundleProvenance {
    DesktopStartup,
    LibraryDoctorSnapshot,
    ActivityHistory,
    ActivityDiagnostics,
    DesktopRuntimeLog,
    HostRuntimeLog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SupportBundleSectionStatus {
    Included,
    Partial,
    Omitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SupportBundleReason {
    Unavailable,
    ReadFailed,
    InvalidRecord,
    UnsafeFile,
    SectionLimit,
    TotalLimit,
    RecordLimit,
    Deadline,
    IncompleteRecord,
    CaptureIncomplete,
    CaptureTruncated,
    CaptureNotCollected,
    BoundedSnapshot,
}

/// The host selects its own diagnostics locations. No arbitrary file inventory
/// is accepted, and no path from a stored diagnostic becomes an archive member.
pub struct SupportBundleRequest<'a> {
    pub destination_dir: &'a Path,
    pub logs_dir: Option<&'a Path>,
    pub library: Option<&'a Library>,
    pub startup_failure: Option<&'a FailureReport>,
}

trait Source {
    fn doctor(&self) -> Result<SupportBundleData>;
    fn activities(&self) -> Result<Vec<ActivityRecord>>;
    fn captures(&self, id: &str, bytes: usize, records: usize) -> Result<BoundedCaptures>;
}

impl Source for Library {
    fn doctor(&self) -> Result<SupportBundleData> {
        SupportBundleData::doctor_snapshot(self)
    }
    fn activities(&self) -> Result<Vec<ActivityRecord>> {
        self.support_bundle_activities()
    }
    fn captures(&self, id: &str, bytes: usize, records: usize) -> Result<BoundedCaptures> {
        self.support_bundle_captures(id, bytes, records)
    }
}

#[derive(Clone, Copy)]
enum Checkpoint {
    Collected,
    Written,
    Publish,
}

pub fn export_support_bundle(request: SupportBundleRequest<'_>) -> Result<SupportBundleExport> {
    export(
        request.destination_dir,
        request.logs_dir,
        request.library.map(|library| library as &dyn Source),
        request.startup_failure,
        SupportBundleLimits::default(),
        &mut |_, _| Ok(()),
    )
}

fn export(
    destination_dir: &Path,
    logs_dir: Option<&Path>,
    source: Option<&dyn Source>,
    startup_failure: Option<&FailureReport>,
    limits: SupportBundleLimits,
    checkpoint: &mut dyn FnMut(Checkpoint, &Path) -> Result<()>,
) -> Result<SupportBundleExport> {
    crate::path::refuse_symlink_ancestors(destination_dir)?;
    fs::create_dir_all(destination_dir)?;
    crate::path::refuse_symlink_ancestors(destination_dir)?;
    let directory = fs::canonicalize(destination_dir)?;
    // A private same-directory staging file owns cleanup even on unwind. The
    // final .zip name appears only after finish, sync and no-replace publication.
    let (mut staged, file) = crate::support_bundle_stage::SupportStage::new(&directory)?;
    let output = directory.join(format!("portcove-support-{}.zip", uuid::Uuid::new_v4()));
    let started = Instant::now();
    let mut collector = Collector {
        archive: zip::ZipWriter::new(file),
        remaining: limits.total_bytes,
        manifest: SupportBundleManifest {
            schema_version: 1,
            created_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            product_version: env!("CARGO_PKG_VERSION").into(),
            target_os: std::env::consts::OS.into(),
            target_arch: std::env::consts::ARCH.into(),
            source_revision: None,
            scope: SupportBundleScope::BoundedRecentDiagnostics,
            library_available: source.is_some(),
            limits,
            sections: Vec::new(),
        },
        started,
    };
    let startup = SupportBundleData::startup(source.is_some(), startup_failure);
    collector.data(
        SupportBundleSectionKind::Startup,
        "startup.json",
        &startup,
        vec![],
        None,
        None,
    )?;

    // Runtime logs are independent of library reads and get an early bounded
    // allocation of the overall budget, including during startup recovery.
    collector.logs(logs_dir)?;
    collector.library(source)?;
    checkpoint(Checkpoint::Collected, &output)?;
    let manifest = limited_json(&collector.manifest, MANIFEST_BYTES)
        .map_err(|_| PortcoveError::state("support manifest exceeded its fixed budget"))?;
    write_entry(&mut collector.archive, "manifest.json", &manifest)?;
    checkpoint(Checkpoint::Written, &output)?;
    let completed = collector.archive.finish().map_err(zip_error)?;
    completed.sync_all()?;
    drop(completed);
    checkpoint(Checkpoint::Publish, &output)?;
    staged.publish(&output)?;
    Ok(SupportBundleExport {
        path: output,
        manifest: collector.manifest,
    })
}

struct Collector {
    archive: zip::ZipWriter<File>,
    manifest: SupportBundleManifest,
    remaining: usize,
    started: Instant,
}

impl Collector {
    fn stopped(&self) -> Option<SupportBundleReason> {
        if self.remaining == 0 {
            Some(SupportBundleReason::TotalLimit)
        } else if self.started.elapsed()
            >= Duration::from_secs(self.manifest.limits.collection_seconds)
        {
            Some(SupportBundleReason::Deadline)
        } else {
            None
        }
    }

    fn omitted(&mut self, kind: SupportBundleSectionKind, reason: SupportBundleReason) {
        self.omitted_section(section(kind), reason);
    }

    fn omitted_section(&mut self, mut section: SupportBundleSection, reason: SupportBundleReason) {
        section.status = SupportBundleSectionStatus::Omitted;
        section.reasons.push(reason);
        self.manifest.sections.push(section);
    }

    fn data(
        &mut self,
        kind: SupportBundleSectionKind,
        name: &str,
        data: &SupportBundleData,
        reasons: Vec<SupportBundleReason>,
        bytes_read: Option<usize>,
        records: Option<usize>,
    ) -> Result<()> {
        let limit = self.remaining.min(self.manifest.limits.section_bytes);
        let bytes = match limited_json(data, limit) {
            Ok(bytes) => bytes,
            Err(_) => {
                self.omitted(
                    kind,
                    if self.remaining < self.manifest.limits.section_bytes {
                        SupportBundleReason::TotalLimit
                    } else {
                        SupportBundleReason::SectionLimit
                    },
                );
                return Ok(());
            }
        };
        self.bytes(section(kind), name, &bytes, reasons, bytes_read, records)
    }

    fn bytes(
        &mut self,
        mut section: SupportBundleSection,
        name: &str,
        bytes: &[u8],
        reasons: Vec<SupportBundleReason>,
        bytes_read: Option<usize>,
        records: Option<usize>,
    ) -> Result<()> {
        write_entry(&mut self.archive, name, bytes)?;
        self.remaining -= bytes.len();
        section.entry = Some(name.into());
        section.status = if reasons.is_empty() {
            SupportBundleSectionStatus::Included
        } else {
            SupportBundleSectionStatus::Partial
        };
        section.reasons = reasons;
        section.bytes_read = bytes_read;
        section.bytes_written = bytes.len();
        section.records = records;
        self.manifest.sections.push(section);
        Ok(())
    }

    fn library(&mut self, source: Option<&dyn Source>) -> Result<()> {
        let Some(source) = source else {
            for kind in [
                SupportBundleSectionKind::Doctor,
                SupportBundleSectionKind::Activities,
                SupportBundleSectionKind::ActivityCapture,
            ] {
                self.omitted(kind, SupportBundleReason::Unavailable);
            }
            return Ok(());
        };
        if let Some(reason) = self.stopped() {
            for kind in [
                SupportBundleSectionKind::Doctor,
                SupportBundleSectionKind::Activities,
                SupportBundleSectionKind::ActivityCapture,
            ] {
                self.omitted(kind, reason);
            }
            return Ok(());
        }
        match source.doctor() {
            Ok(data) => self.data(
                SupportBundleSectionKind::Doctor,
                "doctor.json",
                &data,
                vec![SupportBundleReason::BoundedSnapshot],
                None,
                None,
            )?,
            Err(_) => self.omitted(
                SupportBundleSectionKind::Doctor,
                SupportBundleReason::ReadFailed,
            ),
        }
        if let Some(reason) = self.stopped() {
            self.omitted(SupportBundleSectionKind::Activities, reason);
            self.omitted(SupportBundleSectionKind::ActivityCapture, reason);
            return Ok(());
        }
        let activities = match source.activities() {
            Ok(activities) => activities,
            Err(_) => {
                self.omitted(
                    SupportBundleSectionKind::Activities,
                    SupportBundleReason::ReadFailed,
                );
                self.omitted(
                    SupportBundleSectionKind::ActivityCapture,
                    SupportBundleReason::CaptureNotCollected,
                );
                return Ok(());
            }
        };
        let count = activities.len().min(self.manifest.limits.activity_count);
        self.data(
            SupportBundleSectionKind::Activities,
            "activities.json",
            &SupportBundleData::activities(&activities[..count]),
            vec![SupportBundleReason::BoundedSnapshot],
            None,
            Some(count),
        )?;
        let mut capture_count = 0;
        let mut capture_bytes = 0;
        if activities.is_empty() {
            // An empty retained activity window says nothing about older captures.
            self.omitted(
                SupportBundleSectionKind::ActivityCapture,
                SupportBundleReason::CaptureNotCollected,
            );
        }
        for (index, activity) in activities[..count].iter().enumerate() {
            if let Some(reason) = self.stopped() {
                self.omitted(SupportBundleSectionKind::ActivityCapture, reason);
                break;
            }
            if capture_count >= self.manifest.limits.capture_count
                || capture_bytes >= self.manifest.limits.total_bytes
            {
                self.omitted(
                    SupportBundleSectionKind::ActivityCapture,
                    SupportBundleReason::RecordLimit,
                );
                break;
            }
            let admitted_bytes = (self.manifest.limits.total_bytes - capture_bytes)
                .min(SUPPORT_BUNDLE_CAPTURE_BYTES);
            let admitted_records = self.manifest.limits.capture_count - capture_count;
            match source.captures(&activity.id, admitted_bytes, admitted_records) {
                Ok(captures) => {
                    capture_count += captures.captures.len();
                    capture_bytes += captures.bytes_read;
                    let mut reasons = Vec::new();
                    if captures.truncated {
                        reasons.push(SupportBundleReason::SectionLimit);
                    }
                    if captures.captures.iter().any(|capture| !capture.complete) {
                        reasons.push(SupportBundleReason::CaptureIncomplete);
                    }
                    if captures
                        .captures
                        .iter()
                        .any(|capture| capture.stdout.truncated || capture.stderr.truncated)
                    {
                        reasons.push(SupportBundleReason::CaptureTruncated);
                    }
                    self.data(
                        SupportBundleSectionKind::ActivityCapture,
                        &format!("logs/activity-{index}.json"),
                        &SupportBundleData::activity_captures(&captures.captures),
                        reasons,
                        Some(captures.bytes_read),
                        Some(captures.captures.len()),
                    )?;
                }
                Err(_) => {
                    // A corrupt later row can fail after a valid prefix was
                    // read. Reserve the whole attempt, not zero consumed work.
                    capture_bytes += admitted_bytes;
                    capture_count += admitted_records;
                    self.omitted(
                        SupportBundleSectionKind::ActivityCapture,
                        SupportBundleReason::ReadFailed,
                    );
                }
            }
        }
        Ok(())
    }

    fn logs(&mut self, directory: Option<&Path>) -> Result<()> {
        let Some(directory) = directory else {
            self.omitted(
                SupportBundleSectionKind::RuntimeLog,
                SupportBundleReason::Unavailable,
            );
            return Ok(());
        };
        // No directory walk or name from log content: eight fixed session
        // namespaces, then the six legacy files. Preserve the legacy aggregate
        // raw-input budget even when many invalid records produce no payload.
        let candidates = (0..SESSION_SLOTS)
            .map(Some)
            .chain(std::iter::once(None))
            .flat_map(|slot| (0..=ROTATIONS).map(move |index| (slot, index)));
        let mut input_remaining = self.manifest.limits.log_input_bytes;
        for (slot, index) in candidates {
            let mut section = section(SupportBundleSectionKind::RuntimeLog);
            if slot.is_some() {
                section.provenance = SupportBundleProvenance::HostRuntimeLog;
            }
            if let Some(reason) = self.stopped() {
                self.omitted_section(section, reason);
                break;
            }
            if input_remaining == 0 {
                self.omitted_section(section, SupportBundleReason::SectionLimit);
                break;
            }
            let filename = if index == 0 {
                LOG_NAME.into()
            } else {
                format!("{LOG_NAME}.{index}")
            };
            let name = match slot {
                Some(slot) => format!("session-{slot:02}/{filename}"),
                None => filename,
            };
            let path = directory.join(&name);
            let file = match crate::external_runtime::open_single_link_file(&path) {
                Ok(file) => file,
                Err(error) => {
                    let reason = if error.code == crate::ErrorCode::Verification {
                        SupportBundleReason::UnsafeFile
                    } else if fs::symlink_metadata(&path)
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    {
                        SupportBundleReason::Unavailable
                    } else {
                        SupportBundleReason::ReadFailed
                    };
                    self.omitted_section(section, reason);
                    continue;
                }
            };
            let limit = self.remaining.min(self.manifest.limits.section_bytes);
            let mut limits = self.manifest.limits.clone();
            limits.log_bytes = limits.log_bytes.min(input_remaining);
            let log = read_log(file, &limits, limit, self.started);
            input_remaining -= log.read;
            self.bytes(
                section,
                &format!("logs/{name}"),
                &log.bytes,
                log.reasons,
                Some(log.read),
                Some(log.records),
            )?;
        }
        Ok(())
    }
}

fn section(kind: SupportBundleSectionKind) -> SupportBundleSection {
    let provenance = match kind {
        SupportBundleSectionKind::Startup => SupportBundleProvenance::DesktopStartup,
        SupportBundleSectionKind::Doctor => SupportBundleProvenance::LibraryDoctorSnapshot,
        SupportBundleSectionKind::Activities => SupportBundleProvenance::ActivityHistory,
        SupportBundleSectionKind::ActivityCapture => SupportBundleProvenance::ActivityDiagnostics,
        SupportBundleSectionKind::RuntimeLog => SupportBundleProvenance::DesktopRuntimeLog,
    };
    SupportBundleSection {
        kind,
        provenance,
        entry: None,
        status: SupportBundleSectionStatus::Included,
        reasons: Vec::new(),
        bytes_read: None,
        bytes_written: 0,
        records: None,
    }
}

struct LogRead {
    bytes: Vec<u8>,
    reasons: Vec<SupportBundleReason>,
    read: usize,
    records: usize,
}

struct CountedInput<R> {
    input: R,
    read: usize,
}
impl<R: Read> Read for CountedInput<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = self.input.read(bytes)?;
        self.read += count;
        Ok(count)
    }
}

fn read_log(
    file: impl Read,
    limits: &SupportBundleLimits,
    output_limit: usize,
    started: Instant,
) -> LogRead {
    let input = CountedInput {
        input: file,
        read: 0,
    };
    let mut reader = BufReader::with_capacity(
        8192.min(limits.record_bytes + 1),
        input.take(limits.log_bytes as u64),
    );
    let mut result = LogRead {
        bytes: Vec::new(),
        reasons: Vec::new(),
        read: 0,
        records: 0,
    };
    let mut line = Vec::new();
    loop {
        if started.elapsed() >= Duration::from_secs(limits.collection_seconds) {
            reason(&mut result.reasons, SupportBundleReason::Deadline);
            break;
        }
        // read_until itself is capped: even a corrupt newline-free file cannot
        // cause an unbounded allocation. An oversized record stops this file.
        line.clear();
        let read = (&mut reader)
            .take(limits.record_bytes as u64 + 1)
            .read_until(b'\n', &mut line);
        match read {
            Err(_) => {
                reason(&mut result.reasons, SupportBundleReason::ReadFailed);
                break;
            }
            Ok(0) => break,
            Ok(count) => result.read += count,
        }
        if line.len() > limits.record_bytes {
            reason(&mut result.reasons, SupportBundleReason::RecordLimit);
            break;
        }
        if line.last() != Some(&b'\n') {
            reason(&mut result.reasons, SupportBundleReason::IncompleteRecord);
            break;
        }
        let Ok(text) = std::str::from_utf8(&line) else {
            reason(&mut result.reasons, SupportBundleReason::InvalidRecord);
            continue;
        };
        let text = text.trim_end_matches(['\r', '\n']);
        if text.trim_start().starts_with(['{', '['])
            && serde_json::from_str::<serde_json::Value>(text).is_err()
        {
            reason(&mut result.reasons, SupportBundleReason::InvalidRecord);
            continue;
        }
        let available = output_limit.saturating_sub(result.bytes.len());
        let Ok(bytes) = limited_json(&SupportBundleData::runtime_log_line(text), available) else {
            reason(&mut result.reasons, SupportBundleReason::SectionLimit);
            break;
        };
        result.bytes.extend_from_slice(&bytes);
        result.records += 1;
    }
    // Count the consuming I/O, including bounded BufReader prefetch and bytes
    // retained before a later read failure, rather than just decoded records.
    result.read = reader.into_inner().into_inner().read;
    if result.read == limits.log_bytes {
        reason(&mut result.reasons, SupportBundleReason::SectionLimit);
    }
    result
}

fn reason(reasons: &mut Vec<SupportBundleReason>, value: SupportBundleReason) {
    if !reasons.contains(&value) {
        reasons.push(value);
    }
}

struct LimitedBytes {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for LimitedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other("support section exceeds byte budget"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn limited_json(value: &impl Serialize, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut writer = LimitedBytes {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut writer, value)?;
    writer.write_all(b"\n")?;
    Ok(writer.bytes)
}

fn write_entry(
    writer: &mut zip::ZipWriter<impl Write + std::io::Seek>,
    name: &str,
    bytes: &[u8],
) -> Result<()> {
    writer
        .start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(zip_error)?;
    writer.write_all(bytes)?;
    Ok(())
}

fn zip_error(_: zip::result::ZipError) -> PortcoveError {
    PortcoveError::state("could not finish the diagnostic support bundle")
}

#[cfg(test)]
#[path = "support_bundle_export_tests.rs"]
mod tests;
