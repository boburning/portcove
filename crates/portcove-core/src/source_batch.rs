//! Bounded, transient registered-input observations. No source registration or acceptance writes.

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
const MAX_DIRECTORY_ENTRIES: usize = 4096;
const MAX_DIRECTORY_NAME_BYTES: usize = 256 * 1024;
const MAX_RETAINED_FILES: usize = 4096;

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
    pub catalog_binding_sha256: String,
    pub registration_sha256: String,
    pub profile_ids: Vec<String>,
    pub limits: RegisteredSourceInspectionLimits,
    pub observed_at: i64,
    pub hash_bytes: u64,
    pub observations: Vec<RegisteredSourceObservation>,
}

impl RegisteredSourceInspectionLimits {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.max_file_bytes == 0
            || self.max_file_bytes > 2 * 1024 * 1024 * 1024
            || self.max_hash_bytes == 0
            || self.max_hash_bytes > 32 * 1024 * 1024 * 1024
            || self.max_elapsed_ms == 0
            || self.max_elapsed_ms > 30_000
        {
            return Err(PortcoveError::usage(
                "registered-source inspection needs bounded file/hash/time limits",
            ));
        }
        Ok(())
    }
}

impl PortcoveService {
    /// Explicit work outside query evaluation. Callers must await the blocking worker
    /// before terminal settlement and bind their request/library generation on acceptance.
    /// Supply this batch's own coordinator: final return admits publication of its transient result.
    /// Ordinary raw files, uncompressed GameCube images and schema-2 directory
    /// file sets reuse the shared inspectors; other readers remain NotChecked.
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
        if profile_ids.is_empty() {
            return Err(PortcoveError::usage(
                "registered-source inspection needs 1-256 unique profiles",
            ));
        }
        self.inspect_registered_sources_bounded_with_projection(
            profile_ids,
            limits,
            operation,
            |batch| {
                before_accept()?;
                Ok(batch)
            },
            |_| Ok(()),
        )
    }

    /// Internal composition keeps the inspection handles and inventories owned
    /// until the complete projected result passes final fences and publication.
    /// Only this Core-owned composition can use an empty profile selection.
    pub(crate) fn inspect_registered_sources_bounded_with_projection<T>(
        &self,
        profile_ids: &[String],
        limits: &RegisteredSourceInspectionLimits,
        operation: &OperationCoordinator,
        project: impl FnOnce(RegisteredSourceInspectionBatch) -> Result<T>,
        before_publish: impl FnOnce(&T) -> Result<()>,
    ) -> Result<T> {
        limits.validate()?;
        if profile_ids.len() > 256 {
            return Err(PortcoveError::usage(
                "registered-source inspection profile budget reached",
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
        let (effective, catalog_binding_sha256) = effective_binding(self.library())?;
        if matcher_binding(self.catalog())? != matcher_binding(&effective)? {
            return Err(PortcoveError::conflict(
                "registered-source inspection service has a stale catalog",
            ));
        }
        let registrations = self.library().sources_for(&ids)?;
        let registration_sha256 = fingerprint(&registrations)?;
        let mut budget = HashBudget {
            checkpoint: None,
            operation: Some(operation.clone()),
            limit: limits.max_hash_bytes,
            hashed: 0,
            max_zip_entries: 0,
        };
        // Share byte observations only for the same pathname and full storage/content baseline.
        // Each profile is still interpreted independently by the authoritative matcher.
        let mut cache = RawCache::new();
        let mut directories = DirectoryCache::new();
        let mut inventory_budget = InventoryBudget::default();
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
                    let inspection =
                        if self.catalog().source_profile(profile_id)?.kind == SourceKind::FileSet {
                            inspect_directory_set(
                                record,
                                InspectionScope {
                                    service: self,
                                    limits,
                                    started,
                                },
                                &mut budget,
                                &mut cache,
                                &mut directories,
                                &mut inventory_budget,
                            )
                        } else {
                            inspect_raw(self, record, limits, started, &mut budget, &mut cache)
                        };
                    let report = match inspection {
                        Ok(inspection) => crate::source_report::available_report(
                            self.catalog(),
                            Some(record.clone()),
                            inspection,
                        )?,
                        Err(error) => {
                            checkpoint(operation, started, limits)?;
                            let health = if error.details.get("observed_health").map(String::as_str)
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
        let batch = RegisteredSourceInspectionBatch {
            schema_version: 1,
            library: library.clone(),
            catalog_sha256,
            catalog_binding_sha256: catalog_binding_sha256.clone(),
            registration_sha256: registration_sha256.clone(),
            profile_ids: ids.clone(),
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
        // This batch is still private and unaccepted. Projection may read context,
        // but source fences below must pass before its result can be returned.
        let result = project(batch)?;
        checkpoint(operation, started, limits)?;
        // Registration changes invalidate the whole observation set, including unregistered rows.
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
        let mut final_inventory_budget = InventoryBudget::default();
        for (key, observed) in &directories {
            checkpoint(operation, started, limits)?;
            crate::path::refuse_symlink_ancestors(&key.0)?;
            if std::fs::canonicalize(&key.0)? != observed.path {
                return Err(PortcoveError::conflict(
                    "registered directory location changed during inspection",
                ));
            }
            crate::source_inspection::verify_open_source_directory(
                &observed.path,
                &observed.file,
                &observed.metadata,
            )?;
            if directory_inventory(
                &observed.path,
                operation,
                started,
                limits,
                &mut final_inventory_budget,
            )? != observed.inventory
            {
                return Err(PortcoveError::conflict(
                    "registered directory inventory changed during inspection",
                ));
            }
            crate::source_inspection::verify_open_source_directory(
                &observed.path,
                &observed.file,
                &observed.metadata,
            )?;
        }
        let (_, current_catalog_binding) = effective_binding(self.library())?;
        if library != self.library().identity_record()?
            || registration_sha256 != fingerprint(&self.library().sources_for(&ids)?)?
            || catalog_binding_sha256 != current_catalog_binding
        {
            return Err(PortcoveError::conflict(
                "registered-source inspection inputs changed",
            ));
        }
        checkpoint(operation, started, limits)?;
        before_publish(&result)?;
        checkpoint(operation, started, limits)?;
        // Atomically settle cancellation versus returning this transient observation set.
        // A throttled chunk checkpoint alone cannot establish that a late request lost.
        operation.begin_publication()?;
        Ok(result)
    }
}

pub(crate) fn fingerprint(value: &impl Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn matcher_binding(catalog: &crate::Catalog) -> Result<String> {
    let document = catalog.authoritative_document();
    let selections = document
        .ports
        .iter()
        .map(|port| catalog.definition_selection(&port.id))
        .collect::<Vec<_>>();
    fingerprint(&(document, selections))
}

pub(crate) fn effective_binding(library: &crate::Library) -> Result<(crate::Catalog, String)> {
    let before = library.catalog_status()?.state_sha256;
    let (catalog, provenance) = library.load_catalog()?;
    let after = library.catalog_status()?.state_sha256;
    if before != after {
        return Err(PortcoveError::conflict(
            "catalog selection changed during inspection binding",
        ));
    }
    let binding = fingerprint(&(matcher_binding(&catalog)?, provenance, after))?;
    Ok((catalog, binding))
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

struct DirectoryObservation {
    path: PathBuf,
    file: File,
    metadata: std::fs::Metadata,
    inventory: Vec<(String, bool)>,
}

type DirectoryCache = HashMap<(PathBuf, String, u64, String, u64), DirectoryObservation>;

#[derive(Default)]
struct InventoryBudget {
    entries: usize,
    name_bytes: usize,
}

fn directory_inventory(
    path: &std::path::Path,
    operation: &OperationCoordinator,
    started: Instant,
    limits: &RegisteredSourceInspectionLimits,
    budget: &mut InventoryBudget,
) -> Result<Vec<(String, bool)>> {
    if budget.entries >= MAX_DIRECTORY_ENTRIES || budget.name_bytes >= MAX_DIRECTORY_NAME_BYTES {
        return Err(PortcoveError::unsupported(
            "registered-source directory inventory budget reached",
        ));
    }
    let mut inventory = Vec::new();
    for entry in std::fs::read_dir(path)? {
        checkpoint(operation, started, limits)?;
        budget.entries += 1;
        if budget.entries > MAX_DIRECTORY_ENTRIES {
            return Err(PortcoveError::unsupported(
                "registered-source directory entry budget reached",
            ));
        }
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| {
            PortcoveError::unsupported("registered-source member names must be Unicode")
        })?;
        budget.name_bytes = budget.name_bytes.saturating_add(name.len());
        if budget.name_bytes > MAX_DIRECTORY_NAME_BYTES {
            return Err(PortcoveError::unsupported(
                "registered-source directory name budget reached",
            ));
        }
        let kind = entry.file_type()?;
        inventory.push((name, kind.is_file() && !kind.is_symlink()));
    }
    inventory.sort_unstable();
    Ok(inventory)
}

struct InspectionScope<'a> {
    service: &'a PortcoveService,
    limits: &'a RegisteredSourceInspectionLimits,
    started: Instant,
}

fn inspect_directory_set(
    record: &SourceRecord,
    scope: InspectionScope<'_>,
    budget: &mut HashBudget,
    cache: &mut RawCache,
    directories: &mut DirectoryCache,
    inventory_budget: &mut InventoryBudget,
) -> Result<crate::SourceInspection> {
    let InspectionScope {
        service,
        limits,
        started,
    } = scope;
    // ZIP file sets need a separately bounded container reader. Never open them here.
    crate::path::refuse_symlink_ancestors(&record.path)?;
    if !std::fs::symlink_metadata(&record.path)?.is_dir() {
        return Err(PortcoveError::unsupported(
            "bounded file-set inspection requires an ordinary directory",
        ));
    }
    let key = cache_key(record.path.clone(), record);
    if !directories.contains_key(&key) {
        let file = crate::external_runtime::open_identity_handle(&record.path)?;
        let path = std::fs::canonicalize(&record.path)?;
        crate::path::refuse_symlink_ancestors(&record.path)?;
        let metadata = file.metadata()?;
        crate::source_inspection::verify_open_source_directory(&path, &file, &metadata)?;
        let inventory = directory_inventory(
            &path,
            budget.operation.as_ref().expect("batch owns operation"),
            started,
            limits,
            inventory_budget,
        )?;
        crate::source_inspection::verify_open_source_directory(&path, &file, &metadata)?;
        directories.insert(
            key.clone(),
            DirectoryObservation {
                path,
                file,
                metadata,
                inventory,
            },
        );
    }
    let directory = &directories[&key];
    let names = directory
        .inventory
        .iter()
        .filter(|(_, regular)| *regular)
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    crate::source_inspection::inspect_directory_file_set(
        service.catalog(),
        &record.profile_id,
        &record.path,
        &names,
        &mut |aliases, maximum| {
            checkpoint(
                budget.operation.as_ref().expect("batch owns operation"),
                started,
                limits,
            )?;
            let matched = names
                .iter()
                .filter(|name| aliases.iter().any(|alias| alias.eq_ignore_ascii_case(name)))
                .collect::<Vec<_>>();
            if matched.len() != 1 {
                return Ok(None);
            }
            let name = matched[0];
            let member = record.path.join(name);
            crate::path::refuse_symlink_ancestors(&member)?;
            if std::fs::metadata(&member)?.len() > maximum {
                return Err(PortcoveError::source(
                    "file-set selected bytes exceed their size limit",
                ));
            }
            let identity = observe_raw_bytes(&member, record, limits, started, budget, cache)?;
            Ok(Some(crate::source_inspection::HashedNamedSource {
                name: name.clone(),
                sha1: identity.sha1.clone(),
                sha256: identity.sha256.clone(),
                crc32: identity.crc32.clone(),
                size: identity.size,
            }))
        },
    )
}

fn cache_key(path: PathBuf, record: &SourceRecord) -> (PathBuf, String, u64, String, u64) {
    (
        path,
        record.sha256.clone(),
        record.size,
        record.storage_sha256.clone(),
        record.storage_size,
    )
}

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
    if !matches!(profile.kind, SourceKind::File | SourceKind::GamecubeDisc)
        || (matches!(profile.kind, SourceKind::GamecubeDisc)
            && !extension.eq_ignore_ascii_case("iso")
            && !extension.eq_ignore_ascii_case("gcm"))
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
    if service.catalog().source_catalog().is_some() && raw_extensions.is_empty() {
        return Err(PortcoveError::unsupported(
            "this profile has no bounded raw representation",
        ));
    }
    let supported_extensions = if service.catalog().source_catalog().is_none() {
        &profile.accepted_extensions
    } else {
        &raw_extensions
    };
    if !supported_extensions.is_empty()
        && !supported_extensions
            .iter()
            .any(|accepted| accepted.eq_ignore_ascii_case(extension))
    {
        return Err(PortcoveError::unsupported(
            "registered source extension has no bounded reader for this profile",
        ));
    }
    let identity = observe_raw_bytes(&record.path, record, limits, started, budget, cache)?;
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

fn observe_raw_bytes<'a>(
    input: &std::path::Path,
    record: &SourceRecord,
    limits: &RegisteredSourceInspectionLimits,
    started: Instant,
    budget: &mut HashBudget,
    cache: &'a mut RawCache,
) -> Result<&'a FileIdentity> {
    let key = cache_key(input.to_path_buf(), record);
    if !cache.contains_key(&key) {
        if cache.len() >= MAX_RETAINED_FILES {
            return Err(PortcoveError::unsupported(
                "registered-source retained-file budget reached",
            ));
        }
        if !std::fs::symlink_metadata(input)?.is_file() {
            return Err(PortcoveError::unsupported(
                "registered source is not an ordinary raw file",
            ));
        }
        // The maintained identity opener refuses leaf redirects and cannot block on a raced FIFO.
        let mut file = crate::external_runtime::open_identity_handle(input)?;
        let path = std::fs::canonicalize(input)?;
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
            input,
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
    Ok(&cache.get(&key).expect("raw identity was retained").identity)
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
