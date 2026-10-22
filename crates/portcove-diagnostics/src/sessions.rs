//! Fixed-size session inventory. OS leases, never PID guesses, protect active files.

use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{
    Surface,
    writer::{
        self, DiagnosticSink, FailureStage, FileSink, Limits, SinkError, inspect_optional,
        open_owned, rotated_path, safe_remove, validate_held,
    },
};

pub const SESSION_LIMIT: usize = 8;
pub const SLOT_NAMES: [&str; SESSION_LIMIT] = [
    "session-00",
    "session-01",
    "session-02",
    "session-03",
    "session-04",
    "session-05",
    "session-06",
    "session-07",
];
pub const SESSION_MARKER: &str = ".portcove-session.json";
const MARKER_BYTES: u64 = 1024;
const INACTIVE_BYTE_TARGET: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default)]
pub struct SessionReport {
    pub active_sessions: u64,
    pub unavailable_sessions: u64,
    pub previous_unclean_sessions: u64,
    pub pruned_sessions: u64,
    /// Bytes in inactive namespaces positively read during startup, before the
    /// newly selected writer starts. This excludes active and inaccessible files.
    pub retained_inactive_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    schema_version: u32,
    session_id: uuid::Uuid,
    surface: Surface,
    process_id: u32,
    started_at_ms: u64,
    complete: bool,
}

struct Slot {
    directory: PathBuf,
    lease: File,
    marker: Option<Marker>,
    bytes: u64,
}

pub(crate) struct Allocation {
    pub(crate) directory: PathBuf,
    lease: File,
    marker: Marker,
}

impl Allocation {
    pub(crate) fn into_sink(self) -> impl DiagnosticSink {
        SessionSink {
            inner: FileSink::with_lease(
                self.directory.join(writer::LOG_FILE_NAME),
                Limits::default(),
                self.lease,
            ),
            directory: self.directory,
            marker: self.marker,
        }
    }
}

struct SessionSink {
    inner: FileSink,
    directory: PathBuf,
    marker: Marker,
}

impl DiagnosticSink for SessionSink {
    fn initialize(&mut self) -> Result<(), SinkError> {
        self.inner.initialize()
    }
    fn write_record(&mut self, record: &[u8]) -> Result<(), SinkError> {
        self.inner.write_record(record)
    }
    fn flush(&mut self) -> Result<(), SinkError> {
        self.inner.flush()
    }
    fn finish(&mut self, successful: bool) -> Result<(), SinkError> {
        if successful {
            self.inner
                .verify_lease()
                .map_err(|error| SinkError::from_io(FailureStage::Lease, error))?;
            if read_marker(&self.directory)
                .map_err(|error| SinkError::from_io(FailureStage::Flush, error))?
                .is_none_or(|marker| marker.session_id != self.marker.session_id)
            {
                return Err(SinkError {
                    stage: FailureStage::Flush,
                    kind: io::ErrorKind::InvalidData,
                });
            }
            self.marker.complete = true;
            write_marker(&self.directory, &self.marker)
                .map_err(|error| SinkError::from_io(FailureStage::Flush, error))?;
        }
        Ok(())
    }
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "diagnostic session inventory is unavailable",
    )
}

fn read_marker(directory: &Path) -> io::Result<Option<Marker>> {
    let path = directory.join(SESSION_MARKER);
    let Some(mut file) = inspect_optional(&path)? else {
        return Ok(None);
    };
    if file.metadata()?.len() > MARKER_BYTES {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MARKER_BYTES + 1)
        .read_to_end(&mut bytes)?;
    validate_held(&path, &file)?;
    if bytes.len() as u64 > MARKER_BYTES {
        return Err(invalid());
    }
    let marker: Marker = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if marker.schema_version != 1 || marker.process_id == 0 || marker.session_id.is_nil() {
        return Err(invalid());
    }
    Ok(Some(marker))
}

fn write_marker(directory: &Path, marker: &Marker) -> io::Result<()> {
    let path = directory.join(SESSION_MARKER);
    let mut file = open_owned(&path, false)?;
    let bytes = serde_json::to_vec(marker).map_err(|_| invalid())?;
    if bytes.len() as u64 > MARKER_BYTES {
        return Err(invalid());
    }
    validate_held(&path, &file)?;
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&bytes)?;
    file.sync_data()?;
    validate_held(&path, &file)
}

fn lock_slot(root: &Path, name: &str, create: bool) -> io::Result<Option<Slot>> {
    let directory = root.join(name);
    if !create {
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
            Ok(_) => {}
        }
    }
    let directory =
        portcove_core::prepare_support_log_directory(&directory).map_err(|_| invalid())?;
    let path = directory.join(writer::WRITER_LOCK_NAME);
    let lease = open_owned(&path, false)?;
    lease.try_lock().map_err(io::Error::from)?;
    validate_held(&path, &lease)?;
    let marker = read_marker(&directory)?;
    let mut bytes = 0_u64;
    let mut has_logs = false;
    for index in 0..=writer::DEFAULT_RETAINED_FILES {
        if let Some(file) =
            inspect_optional(&rotated_path(&directory.join(writer::LOG_FILE_NAME), index))?
        {
            has_logs = true;
            bytes = bytes.saturating_add(file.metadata()?.len());
        }
    }
    // An unmarked namespace may contain user/older-version files. Do not adopt
    // or erase them merely because their leaf names resemble ours.
    if marker.is_none() && has_logs {
        return Err(invalid());
    }
    Ok(Some(Slot {
        directory,
        lease,
        marker,
        bytes,
    }))
}

fn clear_slot(slot: &mut Slot) -> io::Result<()> {
    for index in 0..=writer::DEFAULT_RETAINED_FILES {
        validate_held(&slot.directory.join(writer::WRITER_LOCK_NAME), &slot.lease)?;
        safe_remove(&rotated_path(
            &slot.directory.join(writer::LOG_FILE_NAME),
            index,
        ))?;
    }
    validate_held(&slot.directory.join(writer::WRITER_LOCK_NAME), &slot.lease)?;
    safe_remove(&slot.directory.join(SESSION_MARKER))?;
    slot.bytes = 0;
    slot.marker = None;
    Ok(())
}

pub(crate) fn allocate(
    root: &Path,
    session_id: uuid::Uuid,
    surface: Surface,
) -> (Option<Allocation>, SessionReport, Vec<String>) {
    allocate_at(root, session_id, surface, SystemTime::now())
}

fn allocate_at(
    root: &Path,
    session_id: uuid::Uuid,
    surface: Surface,
    now: SystemTime,
) -> (Option<Allocation>, SessionReport, Vec<String>) {
    let now_ms: u64 = now
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    let max_age_ms = writer::DEFAULT_MAX_AGE.as_millis() as u64;
    let mut report = SessionReport::default();
    let mut previous = Vec::new();
    let mut candidates = Vec::new();
    // At most one lease is held at a time. A concurrent process can claim other
    // slots immediately; retention never monopolizes every session's authority.
    for name in SLOT_NAMES {
        match lock_slot(root, name, false) {
            Ok(None) => candidates.push((0, name, None)),
            Ok(Some(mut slot)) => {
                if let Some(marker) = &slot.marker {
                    if !marker.complete {
                        previous.push(marker.session_id.to_string());
                    }
                    let identity = marker.session_id;
                    let started = marker.started_at_ms;
                    if now_ms.saturating_sub(started) > max_age_ms {
                        if clear_slot(&mut slot).is_err() {
                            report.unavailable_sessions += 1;
                            continue;
                        }
                        report.pruned_sessions += 1;
                        candidates.push((0, name, None));
                    } else {
                        report.retained_inactive_bytes += slot.bytes;
                        candidates.push((started, name, Some(identity)));
                    }
                } else {
                    candidates.push((0, name, None));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => report.active_sessions += 1,
            Err(_) => report.unavailable_sessions += 1,
        }
    }
    report.previous_unclean_sessions = previous.len() as u64;
    candidates.sort_unstable_by_key(|candidate| (candidate.0, candidate.1));
    // Trim inactive sessions oldest-first to the 64 MiB target. Active and
    // inaccessible namespaces are preserved. Eight capped writers give a
    // separate 192 MiB maximum for managed runtime payloads across active slots.
    for (_, name, expected) in &mut candidates {
        if report.retained_inactive_bytes <= INACTIVE_BYTE_TARGET {
            break;
        }
        let Some(expected_id) = *expected else {
            continue;
        };
        let Ok(Some(mut slot)) = lock_slot(root, name, false) else {
            continue;
        };
        if slot.marker.as_ref().map(|marker| marker.session_id) != Some(expected_id) {
            continue;
        }
        let bytes = slot.bytes;
        if clear_slot(&mut slot).is_ok() {
            report.retained_inactive_bytes = report.retained_inactive_bytes.saturating_sub(bytes);
            report.pruned_sessions += 1;
            *expected = None;
        } else {
            report.unavailable_sessions += 1;
        }
    }
    for (_, name, expected) in candidates {
        let Ok(Some(mut slot)) = lock_slot(root, name, true) else {
            continue;
        };
        // A newer owner may have used this slot since inventory collection.
        if slot.marker.as_ref().map(|marker| marker.session_id) != expected {
            continue;
        }
        if expected.is_some() {
            let bytes = slot.bytes;
            if clear_slot(&mut slot).is_err() {
                continue;
            }
            report.retained_inactive_bytes = report.retained_inactive_bytes.saturating_sub(bytes);
            report.pruned_sessions += 1;
        }
        let marker = Marker {
            schema_version: 1,
            session_id,
            surface,
            process_id: std::process::id(),
            started_at_ms: now_ms,
            complete: false,
        };
        if write_marker(&slot.directory, &marker).is_err() {
            continue;
        }
        return (
            Some(Allocation {
                directory: slot.directory,
                lease: slot.lease,
                marker,
            }),
            report,
            previous,
        );
    }
    (None, report, previous)
}

#[cfg(test)]
mod tests;
