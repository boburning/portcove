//! Bounded, transient registered-input observations. No registration or acceptance writes.

use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::PathBuf,
    time::{Duration, Instant},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    OperationCoordinator, PortcoveError, PortcoveService, Result, SourceHealth,
    SourceInspectionReport, SourceKind, SourceRecord,
    source_file::{FileIdentity, HashBudget, read_raw_identity_from_reader},
};

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RegisteredSourceInspectionLimits {
    pub max_file_bytes: u64,
    pub max_hash_bytes: u64,
    /// Cooperative deadline, checked between reads; does not interrupt blocked filesystem calls.
    pub max_elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RegisteredSourceObservation {
    Unregistered { profile_id: String },
    Inspected { report: Box<SourceInspectionReport> },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RegisteredSourceInspectionBatch {
    pub schema_version: u32,
    pub library: crate::LibraryIdentity,
    pub catalog_sha256: String,
    pub registration_sha256: String,
    pub profile_ids: Vec<String>,
    pub limits: RegisteredSourceInspectionLimits,
    pub observed_at: i64,
    pub hash_bytes: u64,
    pub observations: Vec<RegisteredSourceObservation>,
}

impl PortcoveService {
    /// Explicit work outside query evaluation. Callers must await the blocking worker
    /// before terminal settlement and bind their request/library generation on acceptance.
    /// Only ordinary raw files are supported here; other readers remain NotChecked.
    pub fn inspect_registered_sources_bounded(
        &self,
        profile_ids: &[String],
        limits: &RegisteredSourceInspectionLimits,
        operation: &OperationCoordinator,
    ) -> Result<RegisteredSourceInspectionBatch> {
        self.inspect_registered_sources_bounded_before_accept(
            profile_ids,
            limits,
            operation,
            || Ok(()),
        )
    }

    fn inspect_registered_sources_bounded_before_accept(
        &self,
        profile_ids: &[String],
        limits: &RegisteredSourceInspectionLimits,
        operation: &OperationCoordinator,
        before_accept: impl FnOnce() -> Result<()>,
    ) -> Result<RegisteredSourceInspectionBatch> {
        if profile_ids.is_empty()
            || profile_ids.len() > 256
            || limits.max_file_bytes == 0
            || limits.max_file_bytes > 2 * 1024 * 1024 * 1024
            || limits.max_hash_bytes == 0
            || limits.max_hash_bytes > 32 * 1024 * 1024 * 1024
            || limits.max_elapsed_ms == 0
            || limits.max_elapsed_ms > 30_000
        {
            return Err(PortcoveError::usage(
                "registered-source inspection needs 1-256 unique profiles and bounded file/hash/time limits",
            ));
        }
        let mut ids = profile_ids.to_vec();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() != profile_ids.len() {
            return Err(PortcoveError::usage(
                "registered-source inspection profile IDs must be unique",
            ));
        }
        for id in &ids {
            self.catalog().source_profile(id)?;
        }
        let started = Instant::now();
        checkpoint(operation, started, limits)?;
        let library = self.library().identity_record()?;
        let catalog_sha256 = fingerprint(&self.catalog().authoritative_document())?;
        let registrations = self.library().sources_for(&ids)?;
        let registration_sha256 = fingerprint(&registrations)?;
        let mut budget = HashBudget {
            operation: Some(operation.clone()),
            limit: limits.max_hash_bytes,
            hashed: 0,
            max_zip_entries: 0,
        };
        // Share byte observations only for the same pathname and full storage/content baseline.
        // Each profile is still interpreted independently by the authoritative matcher.
        let mut cache = RawCache::new();
        let mut observations = Vec::new();
        let mut response_bytes = 0usize;
        for profile_id in &ids {
            checkpoint(operation, started, limits)?;
            let observation = match registrations
                .iter()
                .find(|record| &record.profile_id == profile_id)
            {
                None => RegisteredSourceObservation::Unregistered {
                    profile_id: profile_id.clone(),
                },
                Some(record) => {
                    let report =
                        match inspect_raw(self, record, limits, started, &mut budget, &mut cache) {
                            Ok(inspection) => crate::source_report::available_report(
                                self.catalog(),
                                Some(record.clone()),
                                inspection,
                            )?,
                            Err(error) => {
                                checkpoint(operation, started, limits)?;
                                let health = if error
                                    .details
                                    .get("observed_health")
                                    .map(String::as_str)
                                    == Some("changed")
                                {
                                    SourceHealth::Changed
                                } else if error.details.get("observed_health").map(String::as_str)
                                    == Some("current")
                                {
                                    SourceHealth::Current
                                } else if error.code == crate::ErrorCode::Unsupported {
                                    SourceHealth::NotChecked
                                } else {
                                    match record.path.try_exists() {
                                        Ok(false) => SourceHealth::Missing,
                                        _ => SourceHealth::Unreadable,
                                    }
                                };
                                crate::source_report::unavailable_report(
                                    self.catalog(),
                                    record.clone(),
                                    health,
                                    &error,
                                )?
                            }
                        };
                    RegisteredSourceObservation::Inspected {
                        report: Box::new(report),
                    }
                }
            };
            checkpoint(operation, started, limits)?;
            response_bytes = response_bytes.saturating_add(serde_json::to_vec(&observation)?.len());
            if response_bytes > MAX_RESPONSE_BYTES {
                return Err(PortcoveError::unsupported(
                    "registered-source inspection response budget reached",
                ));
            }
            observations.push(observation);
        }
        // Registration changes invalidate the whole observation set, including unregistered rows.
        before_accept()?;
        for (key, observed) in &cache {
            checkpoint(operation, started, limits)?;
            if std::fs::canonicalize(&key.0)? != observed.path {
                return Err(PortcoveError::conflict(
                    "registered-source location changed during inspection",
                ));
            }
            crate::source_inspection::verify_open_source_location(
                &observed.path,
                &observed.file,
                &observed.metadata,
            )?;
        }
        if library != self.library().identity_record()?
            || registration_sha256 != fingerprint(&self.library().sources_for(&ids)?)?
            || catalog_sha256 != fingerprint(&self.catalog().authoritative_document())?
        {
            return Err(PortcoveError::conflict(
                "registered-source inspection inputs changed",
            ));
        }
        checkpoint(operation, started, limits)?;
        let batch = RegisteredSourceInspectionBatch {
            schema_version: 1,
            library,
            catalog_sha256,
            registration_sha256,
            profile_ids: ids,
            limits: limits.clone(),
            observed_at: crate::Library::now(),
            hash_bytes: budget.hashed,
            observations,
        };
        if serde_json::to_vec(&batch)?.len() > MAX_RESPONSE_BYTES {
            return Err(PortcoveError::unsupported(
                "registered-source inspection response budget reached",
            ));
        }
        checkpoint(operation, started, limits)?;
        Ok(batch)
    }
}

fn fingerprint(value: &impl Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn checkpoint(
    operation: &OperationCoordinator,
    started: Instant,
    limits: &RegisteredSourceInspectionLimits,
) -> Result<()> {
    operation.checkpoint()?;
    if started.elapsed() >= Duration::from_millis(limits.max_elapsed_ms) {
        return Err(PortcoveError::unsupported(
            "registered-source inspection cooperative time budget reached",
        ));
    }
    Ok(())
}

struct RawObservation {
    identity: FileIdentity,
    file: File,
    metadata: std::fs::Metadata,
    path: PathBuf,
}

type RawCache = HashMap<(PathBuf, String, u64, String, u64), RawObservation>;

fn inspect_raw(
    service: &PortcoveService,
    record: &SourceRecord,
    limits: &RegisteredSourceInspectionLimits,
    started: Instant,
    budget: &mut HashBudget,
    cache: &mut RawCache,
) -> Result<crate::SourceInspection> {
    let profile = service.catalog().source_profile(&record.profile_id)?;
    let extension = record
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    // Refuse before a ZIP parser, compound validator, disc helper or external tool can run.
    if profile.kind != SourceKind::File
        || extension.eq_ignore_ascii_case("zip")
        || crate::source_inspection::compound_scan_eligible(
            service.catalog(),
            &record.profile_id,
            Some(extension),
        )
    {
        return Err(PortcoveError::unsupported(
            "this source shape has no bounded registered-input reader yet",
        ));
    }
    let (raw_extensions, _) =
        crate::source_inspection::file_scan_extensions(service.catalog(), profile);
    if !raw_extensions.is_empty()
        && !raw_extensions
            .iter()
            .any(|accepted| accepted.eq_ignore_ascii_case(extension))
    {
        return Err(PortcoveError::unsupported(
            "registered source extension has no bounded reader for this profile",
        ));
    }
    let key = (
        record.path.clone(),
        record.sha256.clone(),
        record.size,
        record.storage_sha256.clone(),
        record.storage_size,
    );
    if !cache.contains_key(&key) {
        let path = std::fs::canonicalize(&record.path)?;
        let mut file = File::open(&path)?;
        let metadata = file.metadata()?;
        crate::source_inspection::verify_open_source_location(&path, &file, &metadata)?;
        if !metadata.is_file() {
            return Err(PortcoveError::source(
                "registered source is not an ordinary file",
            ));
        }
        if metadata.len() > limits.max_file_bytes {
            return Err(PortcoveError::unsupported(
                "registered source exceeds its file budget",
            ));
        }
        let identity = read_raw_identity_from_reader(
            &record.path,
            DeadlineReader {
                file: &mut file,
                started,
                maximum: Duration::from_millis(limits.max_elapsed_ms),
            },
            metadata.len(),
            limits.max_file_bytes,
            budget,
        )?;
        crate::source_inspection::verify_open_source_location(&path, &file, &metadata)?;
        cache.insert(
            key.clone(),
            RawObservation {
                identity,
                file,
                metadata,
                path,
            },
        );
    }
    let identity = &cache.get(&key).expect("raw identity was retained").identity;
    crate::source_inspection::inspect_file_identity(
        service.catalog(),
        &record.profile_id,
        &record.path,
        identity,
    )
    .map_err(|error| {
        error.detail(
            "observed_health",
            if identity.sha256.eq_ignore_ascii_case(&record.sha256)
                && identity.size == record.size
                && identity
                    .storage_sha256
                    .eq_ignore_ascii_case(&record.storage_sha256)
                && identity.storage_size == record.storage_size
            {
                "current"
            } else {
                "changed"
            },
        )
    })
}

struct DeadlineReader<'a> {
    file: &'a mut File,
    started: Instant,
    maximum: Duration,
}

impl Read for DeadlineReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.started.elapsed() >= self.maximum {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "registered-source inspection time budget reached",
            ));
        }
        self.file.read(buffer)
    }
}

#[cfg(test)]
#[path = "source_batch_tests.rs"]
mod tests;
