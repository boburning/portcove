//! Deterministic, profile-scoped Source Inbox paths and resolution.

use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ActivityOperation, ActivityTargetKind, OperationCoordinator, PortcoveError, PortcoveService,
    Result, SourceAdmission, SourceAdmissionMode, SourceDiscoveryIssue, SourceDiscoveryLimit,
    SourceDiscoveryLimits, SourceInspection, SourceKind, SourceProfile, SourceRecord,
    source_file::HashBudget,
};

#[cfg(test)]
#[path = "source_inbox_tests.rs"]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceInboxPaths {
    pub root: PathBuf,
    pub profile_id: Option<String>,
    pub profile: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceInboxResolutionState {
    Registered,
    ExactMatch,
    ApprovalRequired,
    Unresolved,
    Conflict,
    Incomplete,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceInboxCandidate {
    pub inspection: SourceInspection,
    pub automatically_reusable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct SourceInboxScanStats {
    pub entries_examined: u32,
    pub candidates_inspected: u32,
    /// Bytes charged to the scan's hashing budget. Specialized disc estimates
    /// are conservative because their established tools materialize normalized bytes.
    pub hash_bytes: u64,
    pub symlinks_skipped: u32,
    pub limits_reached: Vec<SourceDiscoveryLimit>,
    pub issues: Vec<SourceDiscoveryIssue>,
    pub issues_omitted: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceInboxResolution {
    pub profile_id: String,
    pub paths: SourceInboxPaths,
    pub state: SourceInboxResolutionState,
    pub selected: Option<SourceRecord>,
    pub candidates: Vec<SourceInboxCandidate>,
    pub stats: SourceInboxScanStats,
}

impl PortcoveService {
    pub fn source_inbox_paths(&self, profile_id: Option<&str>) -> Result<SourceInboxPaths> {
        let root = self.library().source_inbox_dir();
        crate::path::refuse_symlink_ancestors(&root)?;
        let metadata = fs::symlink_metadata(&root)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(PortcoveError::conflict(
                "the Source Inbox root must be a real directory",
            ));
        }
        let profile = profile_id
            .map(|profile_id| {
                self.catalog().source_profile(profile_id)?;
                self.library().source_inbox_profile_dir(profile_id)
            })
            .transpose()?;
        Ok(SourceInboxPaths {
            root,
            profile_id: profile_id.map(str::to_owned),
            profile,
        })
    }

    /// Scan only the selected profile's deterministic inbox. This records an
    /// activity like explicit source discovery but never registers or mutates a source.
    pub fn scan_source_inbox(
        &self,
        profile_id: &str,
        limits: &SourceDiscoveryLimits,
    ) -> Result<SourceInboxResolution> {
        crate::source_discovery::validate_limits(limits)?;
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::DiscoverSources,
            ActivityTargetKind::Source,
            Some(profile_id),
        )?;
        self.finish_activity(
            activity,
            self.scan_source_inbox_untracked(profile_id, limits, &operation),
        )
    }

    pub(crate) fn scan_source_inbox_untracked(
        &self,
        profile_id: &str,
        limits: &SourceDiscoveryLimits,
        operation: &OperationCoordinator,
    ) -> Result<SourceInboxResolution> {
        crate::source_discovery::validate_limits(limits)?;
        let paths = self.source_inbox_paths(Some(profile_id))?;
        if let Some(registered) = self.library().source(profile_id)? {
            self.verify_source_record(&registered)?;
            return Ok(SourceInboxResolution {
                profile_id: profile_id.into(),
                paths,
                state: SourceInboxResolutionState::Registered,
                selected: Some(registered),
                candidates: Vec::new(),
                stats: SourceInboxScanStats::default(),
            });
        }
        let profile = self.catalog().source_profile(profile_id)?;
        let profile_path = paths
            .profile
            .as_ref()
            .expect("a profile was requested for Source Inbox resolution");
        if !profile_path.try_exists()? {
            return Ok(empty_resolution(profile_id, paths));
        }
        let profile_root = fs::canonicalize(profile_path)?;
        let inbox_root = fs::canonicalize(&paths.root)?;
        if !profile_root.starts_with(&inbox_root) {
            return Err(PortcoveError::conflict(
                "the profile Source Inbox resolved outside the Source Inbox root",
            )
            .detail("profile_id", profile_id));
        }

        let mut scan = InboxScan {
            service: self,
            profile,
            limits,
            operation,
            profile_root,
            candidates: Vec::new(),
            stats: SourceInboxScanStats::default(),
            reached: BTreeSet::new(),
            hash_budget: HashBudget {
                operation: Some(operation.clone()),
                limit: limits.max_hash_bytes,
                hashed: 0,
                max_zip_entries: 4096,
            },
        };
        scan.run()?;
        scan.finish(profile_id, paths)
    }
}

fn empty_resolution(profile_id: &str, paths: SourceInboxPaths) -> SourceInboxResolution {
    SourceInboxResolution {
        profile_id: profile_id.into(),
        paths,
        state: SourceInboxResolutionState::Unresolved,
        selected: None,
        candidates: Vec::new(),
        stats: SourceInboxScanStats::default(),
    }
}

struct InboxScan<'a> {
    service: &'a PortcoveService,
    profile: &'a SourceProfile,
    limits: &'a SourceDiscoveryLimits,
    operation: &'a OperationCoordinator,
    profile_root: PathBuf,
    candidates: Vec<SourceInboxCandidate>,
    stats: SourceInboxScanStats,
    reached: BTreeSet<SourceDiscoveryLimit>,
    hash_budget: HashBudget,
}

impl InboxScan<'_> {
    fn run(&mut self) -> Result<()> {
        let mut inspect = Vec::new();
        if self.accepts_directory() {
            inspect.push(self.profile_root.clone());
        }
        let mut pending = VecDeque::from([(self.profile_root.clone(), 0_u32)]);
        while let Some((directory, depth)) = pending.pop_front() {
            self.operation.checkpoint()?;
            let mut entries = fs::read_dir(&directory)?.collect::<std::io::Result<Vec<_>>>()?;
            entries.sort_by_key(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                (name.to_ascii_lowercase(), name)
            });
            for entry in entries {
                self.operation.checkpoint()?;
                if !self.charge_entry() {
                    break;
                }
                if entry.file_name().to_str().is_some_and(|name| {
                    name.starts_with(".portcove-import-") && name.ends_with(".staging")
                }) {
                    continue;
                }
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    self.stats.symlinks_skipped += 1;
                    continue;
                }
                let path = entry.path();
                let canonical = fs::canonicalize(&path)?;
                if !canonical.starts_with(&self.profile_root) {
                    self.issue(
                        Some(path),
                        "Source Inbox entry resolved outside its profile directory.",
                    );
                    continue;
                }
                if file_type.is_dir() {
                    if self.accepts_directory() {
                        inspect.push(canonical.clone());
                    }
                    if depth < self.limits.max_depth {
                        pending.push_back((canonical, depth + 1));
                    } else if fs::read_dir(&canonical)?.next().transpose()?.is_some() {
                        self.reached.insert(SourceDiscoveryLimit::Depth);
                    }
                } else if file_type.is_file() && self.accepts_file(&canonical) {
                    inspect.push(canonical);
                }
            }
            if self.reached.contains(&SourceDiscoveryLimit::Entries) {
                break;
            }
        }
        inspect.sort();
        inspect.dedup();
        for path in inspect {
            self.operation.checkpoint()?;
            if self.stats.candidates_inspected >= self.limits.max_candidates {
                self.reached.insert(SourceDiscoveryLimit::Candidates);
                break;
            }
            let Some(specialized_hash_charge) = self.preflight(&path)? else {
                continue;
            };
            match self.inspect(&path) {
                Ok(inspection) => {
                    self.stats.candidates_inspected += 1;
                    let automatically_reusable = matches!(
                        inspection.assessment.admission,
                        SourceAdmission::Admitted {
                            mode: SourceAdmissionMode::ExactIdentity
                        }
                    ) && inspection.record.is_some();
                    self.candidates.push(SourceInboxCandidate {
                        inspection,
                        automatically_reusable,
                    });
                }
                Err(error) if error.code == crate::ErrorCode::Cancelled => return Err(error),
                Err(error) => {
                    if let Some(limit) = error.details.get("scan_limit") {
                        self.reached.insert(if limit == "file_size" {
                            SourceDiscoveryLimit::FileSize
                        } else {
                            SourceDiscoveryLimit::HashBytes
                        });
                    } else {
                        self.issue(Some(path.clone()), &error.message);
                    }
                }
            }
            if specialized_hash_charge > 0 {
                self.hash_budget.hashed = self
                    .hash_budget
                    .hashed
                    .saturating_add(specialized_hash_charge);
            }
        }
        Ok(())
    }

    fn finish(
        mut self,
        profile_id: &str,
        paths: SourceInboxPaths,
    ) -> Result<SourceInboxResolution> {
        self.candidates.sort_by(|left, right| {
            left.inspection
                .path
                .cmp(&right.inspection.path)
                .then_with(|| left.inspection.message.cmp(&right.inspection.message))
        });
        self.stats.hash_bytes = self.hash_budget.hashed;
        self.stats.limits_reached = self.reached.into_iter().collect();
        let exact = self
            .candidates
            .iter()
            .filter(|candidate| candidate.automatically_reusable)
            .filter_map(|candidate| candidate.inspection.record.clone())
            .collect::<Vec<_>>();
        let approval_required = self.candidates.iter().any(|candidate| {
            matches!(
                candidate.inspection.assessment.admission,
                SourceAdmission::Admitted { mode }
                    if mode != SourceAdmissionMode::ExactIdentity
            ) && candidate.inspection.record.is_some()
        });
        let incomplete = !self.stats.limits_reached.is_empty() || !self.stats.issues.is_empty();
        let (state, selected) = if incomplete {
            (SourceInboxResolutionState::Incomplete, None)
        } else {
            match exact.as_slice() {
                [selected] => (
                    SourceInboxResolutionState::ExactMatch,
                    Some(selected.clone()),
                ),
                [] if approval_required => (SourceInboxResolutionState::ApprovalRequired, None),
                [] => (SourceInboxResolutionState::Unresolved, None),
                _ => (SourceInboxResolutionState::Conflict, None),
            }
        };
        Ok(SourceInboxResolution {
            profile_id: profile_id.into(),
            paths,
            state,
            selected,
            candidates: self.candidates,
            stats: self.stats,
        })
    }

    fn inspect(&mut self, path: &Path) -> Result<SourceInspection> {
        match self.profile.kind {
            SourceKind::File => crate::source_inspection::inspect_file(
                self.service.catalog(),
                &self.profile.id,
                path,
                self.limits.max_file_bytes,
                &mut self.hash_budget,
            ),
            SourceKind::UpstreamValidatedDisc => {
                crate::source_inspection::inspect_pinned_validator(
                    self.service.catalog(),
                    &self.profile.id,
                    path,
                    self.limits.max_file_bytes,
                    &mut self.hash_budget,
                )
            }
            SourceKind::FileSet => crate::source_inspection::inspect_file_set(
                self.service.catalog(),
                &self.profile.id,
                path,
            ),
            SourceKind::GamecubeDisc | SourceKind::PsxDisc => {
                crate::source_inspection::inspect_disc(
                    self.service.catalog(),
                    &self.profile.id,
                    path,
                )
            }
        }
    }

    fn accepts_directory(&self) -> bool {
        match self.profile.kind {
            SourceKind::FileSet => true,
            SourceKind::PsxDisc => self
                .profile
                .disc
                .as_ref()
                .is_some_and(|disc| disc.discs.len() > 1),
            _ => false,
        }
    }

    fn accepts_file(&self, path: &Path) -> bool {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        match self.profile.kind {
            SourceKind::File => {
                extension.eq_ignore_ascii_case("zip")
                    || self
                        .profile
                        .accepted_extensions
                        .iter()
                        .any(|allowed| allowed.eq_ignore_ascii_case(extension))
            }
            SourceKind::FileSet => extension.eq_ignore_ascii_case("zip"),
            SourceKind::PsxDisc => {
                !self.accepts_directory() && extension.eq_ignore_ascii_case("chd")
            }
            SourceKind::GamecubeDisc | SourceKind::UpstreamValidatedDisc => self
                .profile
                .accepted_extensions
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(extension)),
        }
    }

    fn preflight(&mut self, path: &Path) -> Result<Option<u64>> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            self.stats.symlinks_skipped += 1;
            return Ok(None);
        }
        let storage_bytes = if metadata.is_file() {
            if metadata.len() == 0 {
                return Ok(None);
            }
            if metadata.len() > self.limits.max_file_bytes {
                self.reached.insert(SourceDiscoveryLimit::FileSize);
                return Ok(None);
            }
            metadata.len()
        } else if metadata.is_dir() {
            let mut total = 0_u64;
            for entry in fs::read_dir(path)? {
                self.operation.checkpoint()?;
                if !self.charge_entry() {
                    return Ok(None);
                }
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    self.stats.symlinks_skipped += 1;
                    return Ok(None);
                }
                if kind.is_file() {
                    let size = entry.metadata()?.len();
                    if size > self.limits.max_file_bytes {
                        self.reached.insert(SourceDiscoveryLimit::FileSize);
                        return Ok(None);
                    }
                    total = total.saturating_add(size);
                }
            }
            total
        } else {
            return Ok(None);
        };
        let charge = match self.profile.kind {
            SourceKind::File | SourceKind::UpstreamValidatedDisc => 0,
            SourceKind::FileSet if metadata.is_file() => {
                let mut archive = zip::ZipArchive::new(fs::File::open(path)?).map_err(|error| {
                    PortcoveError::source(format!("invalid file-set ZIP: {error}"))
                })?;
                if archive.len() > 4096 {
                    self.reached.insert(SourceDiscoveryLimit::Entries);
                    return Ok(None);
                }
                let mut expanded = 0_u64;
                for index in 0..archive.len() {
                    let entry = archive.by_index(index).map_err(|error| {
                        PortcoveError::source(format!("invalid file-set ZIP entry: {error}"))
                    })?;
                    expanded = expanded.saturating_add(entry.size());
                }
                storage_bytes.saturating_add(expanded)
            }
            SourceKind::FileSet => storage_bytes,
            SourceKind::GamecubeDisc => {
                let raw = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|extension| {
                        matches!(extension.to_ascii_lowercase().as_str(), "iso" | "gcm")
                    });
                if raw {
                    storage_bytes.saturating_mul(3)
                } else {
                    storage_bytes.saturating_add(2 * 1_459_978_240)
                }
            }
            SourceKind::PsxDisc => {
                let discs = self
                    .profile
                    .disc
                    .as_ref()
                    .map_or(1_u64, |disc| disc.discs.len().max(1) as u64);
                storage_bytes.saturating_add(discs.saturating_mul(2 * 900 * 1024 * 1024))
            }
        };
        if self.hash_budget.hashed.saturating_add(charge) > self.limits.max_hash_bytes {
            self.reached.insert(SourceDiscoveryLimit::HashBytes);
            return Ok(None);
        }
        Ok(Some(charge))
    }

    fn charge_entry(&mut self) -> bool {
        if self.stats.entries_examined >= self.limits.max_entries {
            self.reached.insert(SourceDiscoveryLimit::Entries);
            return false;
        }
        self.stats.entries_examined += 1;
        true
    }

    fn issue(&mut self, path: Option<PathBuf>, message: &str) {
        if self.stats.issues.len() < 64 {
            self.stats.issues.push(SourceDiscoveryIssue {
                path,
                profile_id: Some(self.profile.id.clone()),
                message: message.into(),
            });
        } else {
            self.stats.issues_omitted += 1;
        }
    }
}
