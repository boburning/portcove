use crate::{
    ActivityOperation, ActivityTargetKind, Catalog, PortcoveError, PortcoveService, Result,
    SourceKind, SourceProfile, SourceRecord,
    source_file::{HashBudget, read_identity},
};

#[cfg(test)]
#[path = "source_discovery_tests.rs"]
mod tests;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceDiscoveryLimits {
    pub max_entries: u32,
    pub max_depth: u32,
    pub max_file_bytes: u64,
    pub max_hash_bytes: u64,
    pub max_candidates: u32,
}

impl Default for SourceDiscoveryLimits {
    fn default() -> Self {
        Self {
            max_entries: 10_000,
            max_depth: 6,
            max_file_bytes: 512 * 1024 * 1024,
            max_hash_bytes: 8 * 1024 * 1024 * 1024,
            max_candidates: 64,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceDiscoveryRequest {
    pub roots: Vec<PathBuf>,
    pub profile_ids: Vec<String>,
    #[serde(default)]
    pub limits: SourceDiscoveryLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceDiscoveryIssue {
    pub path: Option<PathBuf>,
    pub profile_id: Option<String>,
    pub message: String,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum SourceDiscoveryLimit {
    Entries,
    Depth,
    FileSize,
    HashBytes,
    Candidates,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceDiscoveryReport {
    pub searched_roots: Vec<PathBuf>,
    pub searched_profiles: Vec<String>,
    pub candidates: Vec<SourceRecord>,
    pub entries_examined: u32,
    pub files_hashed: u32,
    pub hash_bytes: u64,
    pub symlinks_skipped: u32,
    pub limits_reached: Vec<SourceDiscoveryLimit>,
    pub issues: Vec<SourceDiscoveryIssue>,
    pub issues_omitted: u32,
}

impl PortcoveService {
    /// No defaults choose personal folders; source registration requires a separate acceptance.
    pub fn discover_sources(
        &self,
        request: &SourceDiscoveryRequest,
    ) -> Result<SourceDiscoveryReport> {
        self.discover_sources_with_progress(request, |_| {})
    }

    pub fn discover_sources_with_progress(
        &self,
        request: &SourceDiscoveryRequest,
        mut emit: impl FnMut(crate::OperationEvent),
    ) -> Result<SourceDiscoveryReport> {
        validate_request(request)?;
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::DiscoverSources,
            ActivityTargetKind::Library,
            None,
        )?;
        emit(operation.started());
        let result = self.finish_activity(activity, scan(self.catalog(), request, &operation));
        emit(operation.finished(crate::OperationResult::from_result(&result)));
        result
    }
}

fn validate_request(request: &SourceDiscoveryRequest) -> Result<()> {
    let limits = &request.limits;
    if request.roots.is_empty()
        || request.roots.len() > 8
        || request.profile_ids.is_empty()
        || request.profile_ids.len() > 256
        || limits.max_entries == 0
        || limits.max_entries > 100_000
        || limits.max_depth > 16
        || limits.max_file_bytes == 0
        || limits.max_file_bytes > 2 * 1024 * 1024 * 1024
        || limits.max_hash_bytes == 0
        || limits.max_hash_bytes > 32 * 1024 * 1024 * 1024
        || limits.max_candidates == 0
        || limits.max_candidates > 512
    {
        return Err(PortcoveError::usage(
            "source discovery needs 1-8 explicit roots, 1-256 profiles, and bounded positive scan limits",
        ));
    }
    Ok(())
}

struct Discovery<'a> {
    report: SourceDiscoveryReport,
    profiles: Vec<&'a SourceProfile>,
    limits: &'a SourceDiscoveryLimits,
    reached: BTreeSet<SourceDiscoveryLimit>,
    budget: HashBudget,
}

fn scan(
    catalog: &Catalog,
    request: &SourceDiscoveryRequest,
    operation: &crate::OperationCoordinator,
) -> Result<SourceDiscoveryReport> {
    validate_request(request)?;
    let mut roots = Vec::new();
    for root in &request.roots {
        operation.checkpoint()?;
        crate::path::unicode(root, "source discovery root")?;
        let root = fs::canonicalize(root)?;
        if !root.is_dir() {
            return Err(PortcoveError::usage(
                "source discovery roots must be directories",
            ));
        }
        roots.push(root);
    }
    roots.sort();
    roots.dedup();
    let mut selected = Vec::<PathBuf>::new();
    for root in roots {
        if !selected.iter().any(|parent| root.starts_with(parent)) {
            selected.push(root);
        }
    }
    let mut discovery = Discovery {
        report: SourceDiscoveryReport {
            searched_roots: selected,
            searched_profiles: Vec::new(),
            candidates: Vec::new(),
            entries_examined: 0,
            files_hashed: 0,
            hash_bytes: 0,
            symlinks_skipped: 0,
            limits_reached: Vec::new(),
            issues: Vec::new(),
            issues_omitted: 0,
        },
        profiles: Vec::new(),
        limits: &request.limits,
        reached: BTreeSet::new(),
        budget: HashBudget {
            operation: Some(operation.clone()),
            limit: request.limits.max_hash_bytes,
            hashed: 0,
            max_zip_entries: 4096,
        },
    };
    for id in request.profile_ids.iter().collect::<BTreeSet<_>>() {
        let profile = catalog.source_profile(id)?;
        if profile.kind != SourceKind::File
            || profile.accepted_extensions.is_empty()
            || (profile.accepted_sha1.is_empty() && profile.accepted_sha256.is_empty())
        {
            discovery.issue(None, Some(profile.id.clone()), "This profile needs manual source selection; discovery supports exact-hash original files and cartridge ZIPs.".into());
        } else {
            discovery.profiles.push(profile);
            discovery.report.searched_profiles.push(profile.id.clone());
        }
    }
    if !discovery.profiles.is_empty() {
        discovery.walk()?;
    }
    discovery.report.hash_bytes = discovery.budget.hashed;
    discovery.report.limits_reached = discovery.reached.into_iter().collect();
    discovery.report.candidates.sort_by(|left, right| {
        (&left.profile_id, &left.path).cmp(&(&right.profile_id, &right.path))
    });
    Ok(discovery.report)
}

impl Discovery<'_> {
    fn walk(&mut self) -> Result<()> {
        let mut pending = self
            .report
            .searched_roots
            .iter()
            .map(|root| (root.clone(), 0))
            .collect::<VecDeque<_>>();
        while let Some((directory, depth)) = pending.pop_front() {
            let metadata = match fs::symlink_metadata(&directory) {
                Ok(metadata) => metadata,
                Err(error) => {
                    self.issue(Some(directory), None, error.to_string());
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                self.report.symlinks_skipped += 1;
                continue;
            }
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) => {
                    self.issue(Some(directory), None, error.to_string());
                    continue;
                }
            };
            for entry in entries {
                if let Some(operation) = &self.budget.operation {
                    operation.checkpoint()?;
                }
                if self.report.entries_examined >= self.limits.max_entries {
                    self.reached.insert(SourceDiscoveryLimit::Entries);
                    return Ok(());
                }
                self.report.entries_examined += 1;
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        self.issue(Some(directory.clone()), None, error.to_string());
                        continue;
                    }
                };
                let kind = match entry.file_type() {
                    Ok(kind) => kind,
                    Err(error) => {
                        self.issue(Some(entry.path()), None, error.to_string());
                        continue;
                    }
                };
                if kind.is_symlink() {
                    self.report.symlinks_skipped += 1;
                    continue;
                }
                let path = entry.path();
                let canonical = match fs::canonicalize(&path) {
                    Ok(canonical) => canonical,
                    Err(error) => {
                        self.issue(Some(path), None, error.to_string());
                        continue;
                    }
                };
                if !self
                    .report
                    .searched_roots
                    .iter()
                    .any(|root| canonical.starts_with(root))
                {
                    self.issue(
                        Some(path),
                        None,
                        "Entry moved outside the selected search roots.".into(),
                    );
                    continue;
                }
                if kind.is_dir() {
                    if depth < self.limits.max_depth {
                        pending.push_back((canonical, depth + 1));
                    } else {
                        self.reached.insert(SourceDiscoveryLimit::Depth);
                    }
                } else if kind.is_file() {
                    if let Err(error) = self.file(&canonical) {
                        if error.code == crate::ErrorCode::Cancelled {
                            return Err(error);
                        }
                        self.issue(Some(canonical), None, error.message);
                    }
                    if self.report.candidates.len() >= self.limits.max_candidates as usize {
                        self.reached.insert(SourceDiscoveryLimit::Candidates);
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }

    fn file(&mut self, path: &Path) -> Result<()> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        // Group equal file/ZIP contracts so all matching profiles share one hashing pass.
        let mut groups = BTreeMap::<Vec<String>, Vec<&SourceProfile>>::new();
        for profile in &self.profiles {
            if extension.eq_ignore_ascii_case("zip")
                || profile
                    .accepted_extensions
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(extension))
            {
                let mut extensions = profile
                    .accepted_extensions
                    .iter()
                    .map(|value| value.to_ascii_lowercase())
                    .collect::<Vec<_>>();
                extensions.sort();
                extensions.dedup();
                groups.entry(extensions).or_default().push(profile);
            }
        }
        if groups.is_empty() {
            return Ok(());
        }
        let size = fs::metadata(path)?.len();
        if size == 0 {
            return Ok(());
        }
        if size > self.limits.max_file_bytes {
            self.reached.insert(SourceDiscoveryLimit::FileSize);
            return Ok(());
        }
        let before = self.budget.hashed;
        for (extensions, profiles) in groups {
            match read_identity(
                path,
                &extensions,
                self.limits.max_file_bytes,
                &mut self.budget,
            ) {
                Ok(identity) => {
                    for profile in profiles {
                        if let Ok(candidate) = identity.record(profile, path) {
                            self.report.candidates.push(candidate);
                            if self.report.candidates.len() >= self.limits.max_candidates as usize {
                                break;
                            }
                        }
                    }
                }
                Err(error) if error.code == crate::ErrorCode::Cancelled => return Err(error),
                Err(error) if error.details.contains_key("scan_limit") => {
                    self.reached
                        .insert(if error.details["scan_limit"] == "file_size" {
                            SourceDiscoveryLimit::FileSize
                        } else {
                            SourceDiscoveryLimit::HashBytes
                        });
                }
                Err(error)
                    if error
                        .details
                        .get("zip_match_count")
                        .is_some_and(|count| count == "0") => {}
                Err(error) => self.issue(Some(path.into()), None, error.message),
            }
            if self.report.candidates.len() >= self.limits.max_candidates as usize {
                break;
            }
        }
        if self.budget.hashed > before {
            self.report.files_hashed += 1;
        }
        Ok(())
    }

    fn issue(&mut self, path: Option<PathBuf>, profile_id: Option<String>, message: String) {
        if self.report.issues.len() < 64 {
            self.report.issues.push(SourceDiscoveryIssue {
                path,
                profile_id,
                message,
            });
        } else {
            self.report.issues_omitted += 1;
        }
    }
}
