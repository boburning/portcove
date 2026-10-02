use crate::{
    ActivityOperation, ActivityTargetKind, Catalog, GameFileRootAvailability,
    GameFileScanFreshness, GameFileScanSnapshot, PortcoveError, PortcoveService, Result,
    SourceProfile, SourceRecord,
    source_file::{HashBudget, read_identity},
};

#[cfg(test)]
#[path = "source_discovery_tests.rs"]
mod tests;
#[path = "source_discovery_zip.rs"]
mod zip_file_sets;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

const CURRENT_SCAN_FORMAT_VERSION: u32 = 7;

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
            max_file_bytes: 2 * 1024 * 1024 * 1024,
            max_hash_bytes: 16 * 1024 * 1024 * 1024,
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
        let result = self.finish_activity(
            activity,
            scan_with_events(self.catalog(), request, &operation, vec![], None, &mut emit),
        );
        emit(operation.finished(crate::OperationResult::from_result(&result)));
        result
    }

    pub fn scan_game_file_roots(
        &self,
        limits: &SourceDiscoveryLimits,
    ) -> Result<GameFileScanSnapshot> {
        self.scan_game_file_roots_with_progress(limits, |_| {})
    }

    pub fn scan_game_file_roots_with_progress(
        &self,
        limits: &SourceDiscoveryLimits,
        mut emit: impl FnMut(crate::OperationEvent),
    ) -> Result<GameFileScanSnapshot> {
        validate_limits(limits)?;
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::DiscoverSources,
            ActivityTargetKind::Library,
            None,
        )?;
        emit(operation.started());
        let result = self.finish_activity(
            activity,
            build_game_file_scan_with_registry_events(
                self.catalog(),
                self.library(),
                limits,
                &operation,
                &mut emit,
            )
            .and_then(|(snapshot, expected_outputs)| {
                publish_game_file_scan(self.library(), &operation, &snapshot, &expected_outputs)?;
                current_game_file_scan(self.catalog(), self.library())?.ok_or_else(|| {
                    PortcoveError::state("game-file scan snapshot disappeared after publication")
                })
            }),
        );
        emit(operation.finished(crate::OperationResult::from_result(&result)));
        result
    }

    pub fn game_file_scan_snapshot(&self) -> Result<Option<GameFileScanSnapshot>> {
        current_game_file_scan(self.catalog(), self.library())
    }
}

fn publish_game_file_scan(
    library: &crate::Library,
    operation: &crate::OperationCoordinator,
    snapshot: &GameFileScanSnapshot,
    expected_outputs: &[crate::library::OutputRootRecord],
) -> Result<()> {
    operation.begin_publication()?;
    library.replace_game_file_scan_snapshot_if_outputs_match(snapshot, expected_outputs)
}

#[cfg(test)]
fn build_game_file_scan(
    catalog: &Catalog,
    library: &crate::Library,
    limits: &SourceDiscoveryLimits,
    operation: &crate::OperationCoordinator,
) -> Result<GameFileScanSnapshot> {
    build_game_file_scan_with_registry(catalog, library, limits, operation)
        .map(|(snapshot, _)| snapshot)
}

#[cfg(test)]
fn build_game_file_scan_with_registry(
    catalog: &Catalog,
    library: &crate::Library,
    limits: &SourceDiscoveryLimits,
    operation: &crate::OperationCoordinator,
) -> Result<(GameFileScanSnapshot, Vec<crate::library::OutputRootRecord>)> {
    build_game_file_scan_with_registry_events(catalog, library, limits, operation, &mut |_| {})
}

fn build_game_file_scan_with_registry_events(
    catalog: &Catalog,
    library: &crate::Library,
    limits: &SourceDiscoveryLimits,
    operation: &crate::OperationCoordinator,
    emit: &mut dyn FnMut(crate::OperationEvent),
) -> Result<(GameFileScanSnapshot, Vec<crate::library::OutputRootRecord>)> {
    let roots = library.game_file_roots()?;
    let available = roots
        .iter()
        .filter(|root| root.availability == GameFileRootAvailability::Available)
        .map(|root| root.path.clone())
        .collect::<Vec<_>>();
    if available.len() > 8 {
        return Err(PortcoveError::usage(
            "game-file discovery currently supports at most eight available saved roots per scan",
        ));
    }
    if available.is_empty() {
        return Err(PortcoveError::source(
            "no saved game-file root is currently available",
        ));
    }
    let request = SourceDiscoveryRequest {
        roots: available,
        profile_ids: catalog
            .document()
            .source_profiles
            .iter()
            .map(|profile| profile.id.clone())
            .collect(),
        limits: limits.clone(),
    };
    let mut exclusions = vec![DiscoveryExclusion {
        path: fs::canonicalize(library.root())?,
        kind: DiscoveryExclusionKind::Library,
    }];
    // Claimed custom roots are stored under their canonical identity. Retain
    // the exclusion even when the volume is temporarily unavailable.
    let expected_outputs = library.output_roots()?;
    exclusions.extend(expected_outputs.iter().map(|record| DiscoveryExclusion {
        path: fs::canonicalize(&record.path).unwrap_or_else(|_| record.path.clone()),
        kind: DiscoveryExclusionKind::ManagedOutput,
    }));
    let mut report = scan_with_events(
        catalog,
        &request,
        operation,
        exclusions,
        Some(library),
        emit,
    )?;
    for root in roots
        .iter()
        .filter(|root| root.availability == GameFileRootAvailability::Unavailable)
    {
        if report.issues.len() < 64 {
            report.issues.push(SourceDiscoveryIssue {
                path: Some(root.path.clone()),
                profile_id: None,
                message: "Saved game-file root is currently unavailable; prior scan evidence is not treated as deleted.".into(),
            });
        } else {
            report.issues_omitted += 1;
        }
    }
    Ok((
        GameFileScanSnapshot {
            format_version: CURRENT_SCAN_FORMAT_VERSION,
            catalog_sha256: catalog_sha256(catalog)?,
            roots,
            limits: Some(limits.clone()),
            report,
            completed_at: crate::Library::now(),
            freshness: GameFileScanFreshness::InputsMatch,
        },
        expected_outputs,
    ))
}

fn current_game_file_scan(
    catalog: &Catalog,
    library: &crate::Library,
) -> Result<Option<GameFileScanSnapshot>> {
    let Some(mut snapshot) = library.stored_game_file_scan_snapshot()? else {
        return Ok(None);
    };
    match snapshot.format_version {
        1 => snapshot.limits = None,
        2..=CURRENT_SCAN_FORMAT_VERSION => {
            let Some(limits) = snapshot.limits.as_ref() else {
                return Err(PortcoveError::state(
                    "stored game-file scan snapshot is missing its scan limits",
                ));
            };
            validate_limits(limits).map_err(|error| {
                PortcoveError::state("stored game-file scan snapshot has invalid scan limits")
                    .detail("reason", error.to_string())
            })?;
        }
        _ => {
            return Err(PortcoveError::state(
                "stored game-file scan snapshot version is not supported",
            )
            .detail("format_version", snapshot.format_version.to_string()));
        }
    }
    let current_roots = library.game_file_roots()?;
    snapshot.freshness = if snapshot.format_version == CURRENT_SCAN_FORMAT_VERSION
        && snapshot.catalog_sha256 == catalog_sha256(catalog)?
        && snapshot.roots == current_roots
    {
        GameFileScanFreshness::InputsMatch
    } else {
        GameFileScanFreshness::InputsChanged
    };
    Ok(Some(snapshot))
}

fn catalog_sha256(catalog: &Catalog) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(
        &catalog.authoritative_document(),
    )?)))
}

fn validate_request(request: &SourceDiscoveryRequest) -> Result<()> {
    let limits = &request.limits;
    if request.roots.is_empty()
        || request.roots.len() > 8
        || request.profile_ids.is_empty()
        || request.profile_ids.len() > 256
    {
        return Err(PortcoveError::usage(
            "source discovery needs 1-8 explicit roots and 1-256 profiles",
        ));
    }
    validate_limits(limits)
}

pub(crate) fn validate_limits(limits: &SourceDiscoveryLimits) -> Result<()> {
    if limits.max_entries == 0
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
            "source discovery needs bounded positive scan limits",
        ));
    }
    Ok(())
}

struct Discovery<'a> {
    catalog: &'a Catalog,
    report: SourceDiscoveryReport,
    raw_profiles_by_extension: BTreeMap<String, Vec<&'a SourceProfile>>,
    zip_profile_groups: BTreeMap<Vec<String>, Vec<&'a SourceProfile>>,
    directory_profiles: Vec<&'a SourceProfile>,
    compound_profiles: Vec<&'a SourceProfile>,
    hashed_paths: BTreeSet<PathBuf>,
    limits: &'a SourceDiscoveryLimits,
    reached: BTreeSet<SourceDiscoveryLimit>,
    budget: HashBudget,
    exclusions: Vec<DiscoveryExclusion>,
    output_library: Option<&'a crate::Library>,
    emit: &'a mut dyn FnMut(crate::OperationEvent),
}

struct DiscoveryExclusion {
    path: PathBuf,
    kind: DiscoveryExclusionKind,
}

enum DiscoveryExclusionKind {
    Library,
    ManagedOutput,
}

fn path_within(path: &Path, parent: &Path) -> bool {
    if path.starts_with(parent) {
        return true;
    }
    #[cfg(windows)]
    {
        let path_depth = path.components().count();
        let parent_depth = parent.components().count();
        if path_depth < parent_depth {
            return false;
        }
        let mut path_parts = path.components();
        if !parent.components().all(|expected| {
            path_parts.next().is_some_and(|actual| {
                actual == expected
                    || actual
                        .as_os_str()
                        .to_str()
                        .zip(expected.as_os_str().to_str())
                        .is_some_and(|(actual, expected)| {
                            actual.to_lowercase() == expected.to_lowercase()
                        })
            })
        }) {
            return false;
        }
        path.ancestors()
            .nth(path_depth - parent_depth)
            .is_some_and(|ancestor| same_file::is_same_file(ancestor, parent).unwrap_or(false))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

impl DiscoveryExclusionKind {
    fn root_error(&self) -> &'static str {
        match self {
            Self::Library => "saved game-file roots cannot be inside the Portcove library",
            Self::ManagedOutput => {
                "saved game-file roots cannot be inside a Portcove-managed game output"
            }
        }
    }

    fn omission(&self) -> &'static str {
        match self {
            Self::Library => "Portcove's own library is excluded from game-file discovery.",
            Self::ManagedOutput => {
                "Portcove-managed game output is excluded from game-file discovery."
            }
        }
    }
}

#[cfg(test)]
fn scan(
    catalog: &Catalog,
    request: &SourceDiscoveryRequest,
    operation: &crate::OperationCoordinator,
    exclusions: Vec<DiscoveryExclusion>,
    output_library: Option<&crate::Library>,
) -> Result<SourceDiscoveryReport> {
    scan_with_events(
        catalog,
        request,
        operation,
        exclusions,
        output_library,
        &mut |_| {},
    )
}

fn scan_with_events<'a>(
    catalog: &'a Catalog,
    request: &SourceDiscoveryRequest,
    operation: &crate::OperationCoordinator,
    exclusions: Vec<DiscoveryExclusion>,
    output_library: Option<&'a crate::Library>,
    emit: &'a mut dyn FnMut(crate::OperationEvent),
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
        if let Some(exclusion) = exclusions
            .iter()
            .find(|item| path_within(&root, &item.path))
        {
            return Err(PortcoveError::usage(exclusion.kind.root_error()));
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
        catalog,
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
        raw_profiles_by_extension: BTreeMap::new(),
        zip_profile_groups: BTreeMap::new(),
        directory_profiles: Vec::new(),
        compound_profiles: Vec::new(),
        hashed_paths: BTreeSet::new(),
        limits: &request.limits,
        reached: BTreeSet::new(),
        budget: HashBudget {
            operation: Some(operation.clone()),
            limit: request.limits.max_hash_bytes,
            hashed: 0,
            max_zip_entries: 4096,
        },
        exclusions,
        output_library,
        emit,
    };
    let omitted_owned_paths = discovery
        .exclusions
        .iter()
        .filter(|item| {
            discovery
                .report
                .searched_roots
                .iter()
                .any(|root| path_within(&item.path, root))
        })
        .map(|item| (item.path.clone(), item.kind.omission()))
        .collect::<Vec<_>>();
    for (path, message) in omitted_owned_paths {
        if discovery.report.issues.len() >= 64 {
            return Err(PortcoveError::usage(
                "too many owned paths to report in one game-file scan; select a narrower root",
            ));
        }
        discovery.issue(Some(path), None, message.into());
    }
    for id in request.profile_ids.iter().collect::<BTreeSet<_>>() {
        let profile = catalog.source_profile(id)?;
        if profile.kind == crate::SourceKind::FileSet && catalog.source_catalog().is_some() {
            discovery.directory_profiles.push(profile);
            discovery.report.searched_profiles.push(profile.id.clone());
            continue;
        }
        let (raw_extensions, zip_extensions) =
            crate::source_inspection::file_scan_extensions(catalog, profile);
        let compound = crate::source_inspection::compound_scan_eligible(catalog, &profile.id, None);
        if compound {
            discovery.compound_profiles.push(profile);
        }
        if raw_extensions.is_empty() && zip_extensions.is_empty() && !compound {
            discovery.issue(
                None,
                Some(profile.id.clone()),
                "Folder search can't find files for this requirement. Choose them directly.".into(),
            );
        } else {
            for extension in &raw_extensions {
                discovery
                    .raw_profiles_by_extension
                    .entry(extension.clone())
                    .or_default()
                    .push(profile);
            }
            if !zip_extensions.is_empty() {
                discovery
                    .zip_profile_groups
                    .entry(zip_extensions)
                    .or_default()
                    .push(profile);
            }
            discovery.report.searched_profiles.push(profile.id.clone());
        }
    }
    if !discovery.raw_profiles_by_extension.is_empty()
        || !discovery.zip_profile_groups.is_empty()
        || !discovery.directory_profiles.is_empty()
        || !discovery.compound_profiles.is_empty()
    {
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
    fn is_excluded(&self, path: &Path) -> bool {
        self.exclusions
            .iter()
            .any(|excluded| path_within(path, &excluded.path))
    }

    fn refresh_output_exclusions(&mut self, path: &Path, is_directory: bool) -> Result<()> {
        let Some(library) = self.output_library else {
            return Ok(());
        };
        // A claim records its directory before writing the marker. Recheck the
        // registry for directories before charging an entry; for files, the
        // marker must already exist before the installer can write payloads.
        let has_marker = path
            .ancestors()
            .any(|ancestor| ancestor.join(".portcove-game-output.json").is_file());
        let records = if has_marker {
            library.output_roots()?
        } else if is_directory {
            library.output_root(path)?.into_iter().collect()
        } else {
            return Ok(());
        };
        for record in records {
            let current_path = fs::canonicalize(&record.path).unwrap_or(record.path);
            if self.exclusions.iter().any(|excluded| {
                matches!(excluded.kind, DiscoveryExclusionKind::ManagedOutput)
                    && path_within(&current_path, &excluded.path)
                    && path_within(&excluded.path, &current_path)
            }) {
                continue;
            }
            if self
                .report
                .searched_roots
                .iter()
                .any(|root| path_within(&current_path, root))
            {
                if self.report.issues.len() >= 64 {
                    return Err(PortcoveError::usage(
                        "too many owned paths to report in one game-file scan; select a narrower root",
                    ));
                }
                self.issue(
                    Some(current_path.clone()),
                    None,
                    DiscoveryExclusionKind::ManagedOutput.omission().into(),
                );
            }
            self.exclusions.push(DiscoveryExclusion {
                path: current_path,
                kind: DiscoveryExclusionKind::ManagedOutput,
            });
        }
        Ok(())
    }

    fn walk(&mut self) -> Result<()> {
        let mut pending = self
            .report
            .searched_roots
            .iter()
            .map(|root| (root.clone(), 0))
            .collect::<VecDeque<_>>();
        while let Some((directory, depth)) = pending.pop_front() {
            if self.is_excluded(&directory) {
                continue;
            }
            self.refresh_output_exclusions(&directory, true)?;
            if self.is_excluded(&directory) {
                continue;
            }
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
            let mut members = Vec::new();
            let mut observations = DirectoryObservations::default();
            let mut complete = true;
            for entry in entries {
                if let Some(operation) = &self.budget.operation {
                    operation.checkpoint()?;
                }
                // Saved roots may contain owned library or custom output trees.
                // Skip each whole tree before charging entry or hash budgets.
                let owned_path = entry.as_ref().ok().map(|entry| entry.path());
                if let Some(path) = owned_path.as_deref() {
                    if self.is_excluded(path) {
                        continue;
                    }
                    let is_directory = entry
                        .as_ref()
                        .ok()
                        .and_then(|entry| entry.file_type().ok())
                        .is_none_or(|kind| kind.is_dir());
                    self.refresh_output_exclusions(path, is_directory)?;
                    if self.is_excluded(path) {
                        continue;
                    }
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
                        complete = false;
                        continue;
                    }
                };
                let kind = match entry.file_type() {
                    Ok(kind) => kind,
                    Err(error) => {
                        self.issue(Some(entry.path()), None, error.to_string());
                        complete = false;
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
                        complete = false;
                        continue;
                    }
                };
                if self.is_excluded(&canonical) {
                    continue;
                }
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
                    if let Some(name) = entry.file_name().to_str() {
                        members.push((name.to_owned(), canonical.clone()));
                    } else if !self.directory_profiles.is_empty() {
                        complete = false;
                        self.issue(
                            Some(canonical.clone()),
                            None,
                            "Directory file sets require Unicode member names.".into(),
                        );
                    }
                    if let Err(error) = self.file(&canonical, &mut observations) {
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
            if complete && !self.directory_profiles.is_empty() {
                self.refresh_output_exclusions(&directory, true)?;
                if !self.is_excluded(&directory) {
                    self.directory(&directory, &members, &mut observations)?;
                }
                if self.report.candidates.len() >= self.limits.max_candidates as usize {
                    self.reached.insert(SourceDiscoveryLimit::Candidates);
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn file(&mut self, path: &Path, observations: &mut DirectoryObservations) -> Result<()> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        // ZIP member selection remains contract-specific. Ordinary files share one immutable
        // identity across every profile that accepts their extension, without sharing admission.
        let groups = if extension.eq_ignore_ascii_case("zip") {
            self.zip_profile_groups
                .iter()
                .map(|(extensions, profiles)| (extensions.clone(), profiles.clone()))
                .collect::<Vec<_>>()
        } else {
            let extension = extension.to_ascii_lowercase();
            self.raw_profiles_by_extension
                .get(&extension)
                .map(|profiles| vec![(Vec::new(), profiles.clone())])
                .unwrap_or_default()
        };
        let compound_profiles = self
            .compound_profiles
            .iter()
            .copied()
            .filter(|profile| {
                !extension.eq_ignore_ascii_case("zip")
                    && crate::source_inspection::compound_scan_eligible(
                        self.catalog,
                        &profile.id,
                        Some(extension),
                    )
            })
            .collect::<Vec<_>>();
        if groups.is_empty()
            && compound_profiles.is_empty()
            && !(extension.eq_ignore_ascii_case("zip") && !self.directory_profiles.is_empty())
        {
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
        if !compound_profiles.is_empty() {
            let result = self.compound_file(path, &compound_profiles, observations);
            if self.budget.hashed > before && self.hashed_paths.insert(path.into()) {
                self.report.files_hashed += 1;
            }
            match result {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) if error.details.contains_key("scan_limit") => {
                    observations.failed.insert(path.into());
                    self.reached.insert(SourceDiscoveryLimit::HashBytes);
                    return Ok(());
                }
                Err(error) => {
                    observations.failed.insert(path.into());
                    return Err(error);
                }
            }
        }
        for (extensions, profiles) in groups {
            match read_identity(
                path,
                &extensions,
                self.limits.max_file_bytes,
                &mut self.budget,
            ) {
                Ok(identity) => {
                    if !identity.archive_member {
                        observations
                            .identities
                            .insert(path.into(), identity.clone());
                    }
                    for profile in profiles {
                        if let Ok(inspection) = crate::source_inspection::inspect_file_identity(
                            // Discovery and registration now share schema-2 matching.
                            // Only exact identities are eligible for automatic discovery.
                            self.catalog,
                            &profile.id,
                            path,
                            &identity,
                        ) && matches!(
                            inspection.assessment.admission,
                            crate::SourceAdmission::Admitted {
                                mode: crate::SourceAdmissionMode::ExactIdentity
                            }
                        ) && let Some(candidate) = inspection.record
                        {
                            (self.emit)(
                                self.budget
                                    .operation
                                    .as_ref()
                                    .expect("discovery always owns an operation")
                                    .source_candidate(&candidate),
                            );
                            self.report.candidates.push(candidate);
                            if self.report.candidates.len() >= self.limits.max_candidates as usize {
                                break;
                            }
                        }
                    }
                }
                Err(error) if error.code == crate::ErrorCode::Cancelled => return Err(error),
                Err(error) if error.details.contains_key("scan_limit") => {
                    if !extension.eq_ignore_ascii_case("zip") {
                        observations.failed.insert(path.into());
                    }
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
                Err(error) => {
                    if !extension.eq_ignore_ascii_case("zip") {
                        observations.failed.insert(path.into());
                    }
                    self.issue(Some(path.into()), None, error.message);
                }
            }
            if self.report.candidates.len() >= self.limits.max_candidates as usize {
                break;
            }
        }
        if extension.eq_ignore_ascii_case("zip")
            && !self.directory_profiles.is_empty()
            && self.report.candidates.len() < self.limits.max_candidates as usize
        {
            match self.zip_file_sets(path) {
                Ok(()) => {}
                Err(error) if error.code == crate::ErrorCode::Cancelled => return Err(error),
                Err(error) if error.details.contains_key("scan_limit") => {
                    self.reached
                        .insert(if error.details["scan_limit"] == "file_size" {
                            SourceDiscoveryLimit::FileSize
                        } else {
                            SourceDiscoveryLimit::HashBytes
                        });
                }
                Err(error) => self.issue(Some(path.into()), None, error.message),
            }
        }
        if self.budget.hashed > before && self.hashed_paths.insert(path.into()) {
            self.report.files_hashed += 1;
        }
        Ok(())
    }

    fn compound_file(
        &mut self,
        path: &Path,
        compound_profiles: &[&SourceProfile],
        observations: &mut DirectoryObservations,
    ) -> Result<bool> {
        let Some(observation) = crate::source_inspection::observe_compound_file(
            self.catalog,
            compound_profiles,
            path,
            self.limits.max_file_bytes,
            &mut self.budget,
        )?
        else {
            return Ok(false);
        };
        if let Some(issue) = observation.issue {
            self.issue(Some(path.into()), None, issue);
        }
        observations
            .identities
            .insert(path.into(), observation.identity.clone());
        let extension = observation.identity.content_extension.clone();
        let mut profiles = self
            .raw_profiles_by_extension
            .get(&extension)
            .cloned()
            .unwrap_or_default();
        profiles.extend_from_slice(compound_profiles);
        profiles.sort_by_key(|profile| &profile.id);
        profiles.dedup_by_key(|profile| &profile.id);
        for profile in profiles {
            let inspection = if profile.kind == crate::SourceKind::GamecubeDisc {
                crate::source_inspection::inspect_file_identity(
                    self.catalog,
                    &profile.id,
                    path,
                    &observation.identity,
                )
            } else {
                crate::source_inspection::inspect_file_identity_with_compound(
                    self.catalog,
                    &profile.id,
                    path,
                    &observation.identity,
                    observation.validated,
                )
            };
            if let Ok(inspection) = inspection
                && matches!(
                    inspection.assessment.admission,
                    crate::SourceAdmission::Admitted {
                        mode: crate::SourceAdmissionMode::ExactIdentity
                    }
                )
                && let Some(candidate) = inspection.record
            {
                let operation = self
                    .budget
                    .operation
                    .as_ref()
                    .expect("discovery owns operation");
                operation.checkpoint()?;
                (self.emit)(operation.source_candidate(&candidate));
                self.report.candidates.push(candidate);
                if self.report.candidates.len() >= self.limits.max_candidates as usize {
                    break;
                }
            }
        }
        Ok(true)
    }

    fn zip_file_sets(&mut self, path: &Path) -> Result<()> {
        let profile_ids = self
            .directory_profiles
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<Vec<_>>();
        let Some(mut archive) = zip_file_sets::ZipFileSet::open(
            path,
            self.catalog,
            &profile_ids,
            self.limits.max_file_bytes,
            &mut self.budget,
        )?
        else {
            return Ok(());
        };
        for profile in self.directory_profiles.clone() {
            let operation = self
                .budget
                .operation
                .as_ref()
                .expect("discovery owns operation");
            operation.checkpoint()?;
            let inspection = match archive.inspect(
                self.catalog,
                &profile.id,
                path,
                self.limits.max_file_bytes,
                &mut self.budget,
            ) {
                Ok(inspection) => inspection,
                Err(error) if error.code == crate::ErrorCode::Cancelled => return Err(error),
                Err(error) if error.details.contains_key("scan_limit") => {
                    self.reached
                        .insert(if error.details["scan_limit"] == "file_size" {
                            SourceDiscoveryLimit::FileSize
                        } else {
                            SourceDiscoveryLimit::HashBytes
                        });
                    continue;
                }
                Err(error) => {
                    self.issue(Some(path.into()), Some(profile.id.clone()), error.message);
                    continue;
                }
            };
            if matches!(
                inspection.assessment.admission,
                crate::SourceAdmission::Admitted {
                    mode: crate::SourceAdmissionMode::ExactIdentity
                }
            ) && let Some(candidate) = inspection.record
            {
                let operation = self
                    .budget
                    .operation
                    .as_ref()
                    .expect("discovery owns operation");
                (self.emit)(operation.source_candidate(&candidate));
                operation.checkpoint()?;
                self.report.candidates.push(candidate);
                if self.report.candidates.len() >= self.limits.max_candidates as usize {
                    break;
                }
            }
        }
        Ok(())
    }

    fn directory_member(
        &mut self,
        path: &Path,
        members: &[(String, PathBuf)],
        observations: &mut DirectoryObservations,
        names: &[String],
    ) -> Result<Option<crate::source_inspection::HashedNamedSource>> {
        let selected = members
            .iter()
            .filter(|(name, _)| {
                names
                    .iter()
                    .any(|expected| expected.eq_ignore_ascii_case(name))
            })
            .collect::<Vec<_>>();
        if selected.len() != 1 {
            return Ok(None);
        }
        let (name, member_path) = selected[0];
        let metadata = fs::symlink_metadata(member_path)?;
        if !metadata.is_file()
            || fs::canonicalize(member_path)? != *member_path
            || member_path.parent() != Some(path)
            || self.is_excluded(member_path)
        {
            return Err(PortcoveError::source(
                "source member moved outside its scanned directory",
            ));
        }
        if metadata.len() > self.limits.max_file_bytes {
            return Err(
                PortcoveError::unsupported("source member exceeds discovery size limit")
                    .detail("scan_limit", "file_size"),
            );
        }
        if observations.failed.contains(member_path) {
            return Err(PortcoveError::source(
                "source member could not be inspected during this scan",
            ));
        }
        if let Some(identity) = observations.identities.get(member_path) {
            if identity.size != metadata.len() {
                return Err(PortcoveError::source(
                    "source member changed after inspection",
                ));
            }
        } else {
            let before = self.budget.hashed;
            let result = crate::source_file::read_raw_identity(
                member_path,
                metadata.len(),
                self.limits.max_file_bytes,
                &mut self.budget,
            );
            if (result.is_ok() || self.budget.hashed > before)
                && self.hashed_paths.insert(member_path.clone())
            {
                self.report.files_hashed += 1;
            }
            match result {
                Ok(identity) => {
                    observations
                        .identities
                        .insert(member_path.clone(), identity);
                }
                Err(error) => {
                    observations.failed.insert(member_path.clone());
                    return Err(error);
                }
            }
        }
        let identity = &observations.identities[member_path];
        Ok(Some(crate::source_inspection::HashedNamedSource {
            name: name.clone(),
            sha1: identity.sha1.clone(),
            sha256: identity.sha256.clone(),
            crc32: identity.crc32.clone(),
            size: identity.size,
        }))
    }

    fn directory(
        &mut self,
        path: &Path,
        members: &[(String, PathBuf)],
        observations: &mut DirectoryObservations,
    ) -> Result<()> {
        let names = members
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        for profile in self.directory_profiles.clone() {
            self.budget
                .operation
                .as_ref()
                .expect("discovery owns operation")
                .checkpoint()?;
            let inspection = crate::source_inspection::inspect_directory_file_set(
                self.catalog,
                &profile.id,
                path,
                &names,
                &mut |names| self.directory_member(path, members, observations, names),
            );
            match inspection {
                Ok(inspection) => {
                    if matches!(
                        inspection.assessment.admission,
                        crate::SourceAdmission::Admitted {
                            mode: crate::SourceAdmissionMode::ExactIdentity
                        }
                    ) && let Some(candidate) = inspection.record
                    {
                        (self.emit)(
                            self.budget
                                .operation
                                .as_ref()
                                .expect("discovery owns operation")
                                .source_candidate(&candidate),
                        );
                        self.budget
                            .operation
                            .as_ref()
                            .expect("discovery owns operation")
                            .checkpoint()?;
                        self.report.candidates.push(candidate);
                        if self.report.candidates.len() >= self.limits.max_candidates as usize {
                            break;
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
                Err(error) => {
                    self.issue(Some(path.into()), Some(profile.id.clone()), error.message)
                }
            }
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

// Facts and failures are scan-local, never persisted or used as admission decisions.
#[derive(Default)]
struct DirectoryObservations {
    identities: BTreeMap<PathBuf, crate::source_file::FileIdentity>,
    failed: BTreeSet<PathBuf>,
}
