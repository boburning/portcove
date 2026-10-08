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

const CURRENT_SCAN_FORMAT_VERSION: u32 = 8;
const MAX_CONTINUATION_RECORDS: usize = 16_384;
const MAX_CONTINUATION_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESUME_CHECKS: u32 = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScanDirectory {
    path: PathBuf,
    depth: u32,
    seen: BTreeSet<String>,
    complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScanEntryStamp {
    kind: u8,
    size: u64,
    modified: String,
    created: Option<String>,
    object: Option<(u64, u64, i64, i64)>,
}

impl ScanEntryStamp {
    fn read(path: &Path) -> Result<Option<Self>> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => return Ok(None),
        };
        #[cfg(unix)]
        let object = {
            use std::os::unix::fs::MetadataExt;
            Some((
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ))
        };
        #[cfg(not(unix))]
        let object = None;
        Ok(Some(Self {
            kind: if metadata.is_file() {
                0
            } else if metadata.is_dir() {
                1
            } else if metadata.file_type().is_symlink() {
                2
            } else {
                3
            },
            size: metadata.len(),
            modified: format!("{:?}", metadata.modified()?),
            created: metadata.created().ok().map(|time| format!("{time:?}")),
            object,
        }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScanContinuation {
    format_version: u32,
    platform: String,
    outputs_sha256: String,
    report_sha256: String,
    pending: VecDeque<ScanDirectory>,
    observed: BTreeMap<PathBuf, Option<ScanEntryStamp>>,
    retained_bytes: usize,
}

impl ScanContinuation {
    fn new(roots: &[PathBuf], outputs_sha256: String) -> Self {
        Self {
            format_version: 1,
            platform: std::env::consts::OS.into(),
            outputs_sha256,
            report_sha256: String::new(),
            pending: roots
                .iter()
                .map(|path| ScanDirectory {
                    path: path.clone(),
                    depth: 0,
                    seen: BTreeSet::new(),
                    complete: true,
                })
                .collect(),
            observed: BTreeMap::new(),
            retained_bytes: 1024,
        }
    }

    fn remember(&mut self, path: &Path) -> Result<()> {
        let stamp = ScanEntryStamp::read(path)?;
        if let Some(previous) = self.observed.get(path) {
            if previous != &stamp {
                return Err(PortcoveError::conflict(
                    "game-file entry changed during the scan",
                ));
            }
            return Ok(());
        }
        // Charge both the path/stamp and the directory's seen-name/frontier before insertion.
        let bytes = serde_json::to_vec(&(path, &stamp))?.len() * 2 + 256;
        if self.observed.len() >= MAX_CONTINUATION_RECORDS
            || bytes > MAX_CONTINUATION_BYTES.saturating_sub(self.retained_bytes)
        {
            return Err(PortcoveError::state(
                "game-file scan continuation reached its bounded storage limit; select narrower folders",
            ).detail("continuation_limit", "storage"));
        }
        self.retained_bytes += bytes;
        self.observed.insert(path.to_path_buf(), stamp);
        Ok(())
    }
}

struct ScanBatch {
    report: SourceDiscoveryReport,
    continuation: Option<ScanContinuation>,
    entries_relisted: u32,
    metadata_checks: u32,
    prior_member_rechecks: u32,
    terminal_limited: bool,
}

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
        let scan = discovery_exclusions(self.library()).and_then(|(exclusions, _)| {
            scan_with_events(
                self.catalog(),
                request,
                &operation,
                exclusions,
                Some(self.library()),
                &mut emit,
            )
        });
        let result = self.finish_activity(activity, scan);
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
            .and_then(|(snapshot, expected_outputs, expected_payload)| {
                publish_game_file_scan(
                    self.library(),
                    &operation,
                    &snapshot,
                    &expected_outputs,
                    expected_payload.as_deref(),
                )?;
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

fn discovery_exclusions(
    library: &crate::Library,
) -> Result<(
    Vec<DiscoveryExclusion>,
    Vec<crate::library::OutputRootRecord>,
)> {
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
    Ok((exclusions, expected_outputs))
}

fn publish_game_file_scan(
    library: &crate::Library,
    operation: &crate::OperationCoordinator,
    snapshot: &GameFileScanSnapshot,
    expected_outputs: &[crate::library::OutputRootRecord],
    expected_payload: Option<&str>,
) -> Result<()> {
    operation.begin_publication()?;
    library.replace_game_file_scan_snapshot_if_outputs_match(
        snapshot,
        expected_outputs,
        &snapshot.roots,
        expected_payload,
    )
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
        .map(|(snapshot, outputs, _)| (snapshot, outputs))
}

fn build_game_file_scan_with_registry_events(
    catalog: &Catalog,
    library: &crate::Library,
    limits: &SourceDiscoveryLimits,
    operation: &crate::OperationCoordinator,
    emit: &mut dyn FnMut(crate::OperationEvent),
) -> Result<(
    GameFileScanSnapshot,
    Vec<crate::library::OutputRootRecord>,
    Option<String>,
)> {
    let roots = library.game_file_roots()?;
    let expected_payload = library.stored_game_file_scan_payload()?;
    // An explicit scan can replace an unreadable old report. Keep its raw bytes
    // for publication CAS, but never reuse undecodable state. A valid report
    // with malformed optional checkpoint data decodes to the refusal sentinel.
    let previous = expected_payload
        .as_deref()
        .map(prior_scan_for_reuse)
        .transpose()?
        .flatten();
    let (exclusions, expected_outputs) = discovery_exclusions(library)?;
    let catalog_identity = catalog_sha256(catalog)?;
    let outputs_identity = output_registry_sha256(&expected_outputs)?;
    if previous.as_ref().is_some_and(|snapshot| {
        !(1..=CURRENT_SCAN_FORMAT_VERSION).contains(&snapshot.format_version)
    }) {
        return Err(PortcoveError::state(
            "stored game-file scan snapshot version is not supported",
        ));
    }
    let mut initial_checks = 0;
    let resumed = previous
        .as_ref()
        .filter(|snapshot| snapshot.continuation.is_some());
    let continuation = if let Some(snapshot) = resumed {
        let validated = validate_continuation(
            snapshot,
            &roots,
            limits,
            &catalog_identity,
            &outputs_identity,
            operation,
            &mut initial_checks,
        );
        match validated {
            Ok(continuation) => Some(continuation),
            Err(error) if error.code == crate::ErrorCode::Cancelled => return Err(error),
            Err(error) => {
                let mut invalidated = snapshot.clone();
                invalidated.continuation = None;
                let coverage = invalidated.coverage.get_or_insert_with(Default::default);
                coverage.can_resume = false;
                coverage.restart_required = true;
                coverage.remaining_entries = None;
                invalidated.freshness = GameFileScanFreshness::InputsChanged;
                operation.begin_publication()?;
                library.replace_game_file_scan_snapshot_if_outputs_match(
                    &invalidated,
                    &expected_outputs,
                    &roots,
                    expected_payload.as_deref(),
                )?;
                return Err(PortcoveError::conflict(
                    "saved scan continuation is stale or invalid; repeat the scan to start fresh",
                )
                .detail("reason", error.message));
            }
        }
    } else {
        None
    };
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
    let previous_report = resumed.map(|snapshot| snapshot.report.clone());
    let initial_entries = previous_report
        .as_ref()
        .map_or(0, |report| report.entries_examined);
    let mut batch = scan_with_continuation(
        catalog,
        &request,
        operation,
        exclusions,
        Some(library),
        emit,
        previous_report,
        continuation.or_else(|| Some(ScanContinuation::new(&request.roots, outputs_identity))),
        initial_checks,
    )?;
    let report = &mut batch.report;
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
    let frontier_exhausted = batch
        .continuation
        .as_ref()
        .is_none_or(|cursor| cursor.pending.is_empty());
    let can_resume = !frontier_exhausted
        && !batch.terminal_limited
        && !report.limits_reached.iter().any(|limit| {
            matches!(
                limit,
                SourceDiscoveryLimit::HashBytes | SourceDiscoveryLimit::Candidates
            )
        });
    let pending_directories = batch
        .continuation
        .as_ref()
        .map_or(0, |cursor| cursor.pending.len() as u32);
    let remaining_entries = (frontier_exhausted
        && report.limits_reached.is_empty()
        && report.issues.is_empty()
        && report.issues_omitted == 0)
        .then_some(0);
    let coverage = crate::GameFileScanCoverage {
        batches: resumed
            .and_then(|snapshot| snapshot.coverage.as_ref())
            .map_or(1, |coverage| coverage.batches.saturating_add(1)),
        batch_entries_examined: report.entries_examined - initial_entries,
        entries_relisted: batch.entries_relisted,
        metadata_checks: batch.metadata_checks,
        prior_member_rechecks: batch.prior_member_rechecks,
        pending_directories,
        remaining_entries,
        frontier_exhausted,
        can_resume,
        restart_required: false,
    };
    let continuation = if can_resume {
        let cursor = batch.continuation.as_mut().unwrap();
        cursor.report_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&batch.report)?));
        Some(serde_json::to_value(cursor)?)
    } else {
        None
    };
    Ok((
        GameFileScanSnapshot {
            format_version: CURRENT_SCAN_FORMAT_VERSION,
            catalog_sha256: catalog_identity,
            roots,
            limits: Some(limits.clone()),
            report: batch.report,
            completed_at: crate::Library::now(),
            freshness: GameFileScanFreshness::InputsMatch,
            coverage: Some(coverage),
            continuation,
        },
        expected_outputs,
        expected_payload,
    ))
}

// A malformed optional checkpoint must not make an otherwise valid prior report unreadable.
// Keep the raw payload for CAS; a sentinel forces the normal refusal/invalidation path.
fn prior_scan_for_reuse(payload: &str) -> Result<Option<GameFileScanSnapshot>> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return Ok(None);
    };
    if let Some(version) = value.get("format_version")
        && version
            .as_u64()
            .is_none_or(|version| !(1..=u64::from(CURRENT_SCAN_FORMAT_VERSION)).contains(&version))
    {
        return Err(PortcoveError::state(
            "stored game-file scan snapshot version is not supported",
        ));
    }
    match decode_game_file_scan(payload) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(error)
            if value.get("report").is_some_and(|report| {
                serde_json::from_value::<SourceDiscoveryReport>(report.clone()).is_ok()
            }) =>
        {
            Err(PortcoveError::state(
                "stored scan metadata is invalid; the readable prior report was preserved",
            )
            .detail("reason", error.message))
        }
        Err(_) => Ok(None),
    }
}

fn decode_game_file_scan(payload: &str) -> Result<GameFileScanSnapshot> {
    match serde_json::from_str(payload) {
        Ok(snapshot) => Ok(snapshot),
        Err(original) => {
            let mut value: serde_json::Value = serde_json::from_str(payload)?;
            let Some(object) = value.as_object_mut() else {
                return Err(
                    PortcoveError::state("stored game-file scan snapshot is invalid")
                        .detail("cause", original.to_string()),
                );
            };
            object.remove("coverage");
            object.remove("continuation");
            let mut snapshot: GameFileScanSnapshot = serde_json::from_value(value)?;
            snapshot.continuation = Some(serde_json::Value::Null);
            Ok(snapshot)
        }
    }
}

fn output_registry_sha256(outputs: &[crate::library::OutputRootRecord]) -> Result<String> {
    let records = outputs
        .iter()
        .map(|record| {
            (
                &record.path,
                &record.port_id,
                &record.marker_id,
                &record.volume_identity,
            )
        })
        .collect::<Vec<_>>();
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&records)?)))
}

fn validate_continuation(
    snapshot: &GameFileScanSnapshot,
    roots: &[crate::GameFileRoot],
    limits: &SourceDiscoveryLimits,
    catalog_identity: &str,
    outputs_identity: &str,
    operation: &crate::OperationCoordinator,
    checks: &mut u32,
) -> Result<ScanContinuation> {
    let value = snapshot.continuation.as_ref().unwrap();
    if snapshot.format_version != CURRENT_SCAN_FORMAT_VERSION
        || snapshot.catalog_sha256 != catalog_identity
        || snapshot.roots != roots
        || snapshot
            .limits
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?
            != Some(serde_json::to_value(limits)?)
        || snapshot
            .coverage
            .as_ref()
            .is_none_or(|coverage| !coverage.can_resume || coverage.restart_required)
        || snapshot.report.hash_bytes > limits.max_hash_bytes
        || snapshot.report.candidates.len() > limits.max_candidates as usize
        || value
            .get("observed")
            .and_then(serde_json::Value::as_object)
            .is_none_or(|items| items.len() > MAX_CONTINUATION_RECORDS)
        || value
            .get("pending")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|items| items.len() > MAX_CONTINUATION_RECORDS)
        || serde_json::to_vec(value)?.len() > MAX_CONTINUATION_BYTES
    {
        return Err(PortcoveError::state(
            "scan inputs or bounded continuation state changed",
        ));
    }
    let mut cursor: ScanContinuation = serde_json::from_value(value.clone())?;
    if cursor.format_version != 1
        || cursor.platform != std::env::consts::OS
        || cursor.outputs_sha256 != outputs_identity
        || cursor.report_sha256
            != hex::encode(Sha256::digest(serde_json::to_vec(&snapshot.report)?))
        || snapshot.report.candidates.len() >= limits.max_candidates as usize
        || snapshot.report.entries_examined as usize + snapshot.report.searched_roots.len()
            < cursor.observed.len()
        || cursor.pending.is_empty()
        || cursor.retained_bytes > MAX_CONTINUATION_BYTES
    {
        return Err(PortcoveError::state(
            "scan continuation identity is invalid",
        ));
    }
    let available = roots
        .iter()
        .filter(|root| root.availability == GameFileRootAvailability::Available)
        .map(|root| &root.path)
        .collect::<Vec<_>>();
    for (path, expected) in &cursor.observed {
        operation.checkpoint()?;
        *checks += 1;
        if *checks > MAX_RESUME_CHECKS
            || !available.iter().any(|root| path.starts_with(root))
            || path.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
            || expected.as_ref().is_some_and(|stamp| stamp.kind > 3)
            || ScanEntryStamp::read(path)? != *expected
            || expected.as_ref().is_some_and(|stamp| stamp.kind != 2)
                && fs::canonicalize(path)? != *path
        {
            return Err(PortcoveError::conflict(
                "a recorded game-file entry changed or is outside its saved folder",
            ));
        }
    }
    let mut pending_paths = BTreeSet::new();
    for directory in &cursor.pending {
        if !pending_paths.insert(&directory.path)
            || directory.depth > limits.max_depth
            || !snapshot.report.searched_roots.iter().any(|root| {
                directory
                    .path
                    .strip_prefix(root)
                    .is_ok_and(|relative| relative.components().count() == directory.depth as usize)
            })
            || directory.seen.len() > MAX_CONTINUATION_RECORDS
            || cursor
                .observed
                .get(&directory.path)
                .is_none_or(|stamp| stamp.as_ref().is_none_or(|stamp| stamp.kind != 1))
            || directory.seen.iter().any(|name| {
                name.is_empty()
                    || Path::new(name).components().count() != 1
                    || !matches!(
                        Path::new(name).components().next(),
                        Some(std::path::Component::Normal(_))
                    )
                    || !cursor.observed.contains_key(&directory.path.join(name))
            })
        {
            return Err(PortcoveError::state(
                "scan continuation directory frontier is invalid",
            ));
        }
    }
    for path in cursor.observed.keys() {
        if !snapshot
            .report
            .searched_roots
            .iter()
            .any(|root| path.starts_with(root))
        {
            return Err(PortcoveError::state(
                "scan continuation path is outside its recorded scope",
            ));
        }
        if let Some(parent) = path.parent() {
            for directory in cursor
                .pending
                .iter()
                .filter(|directory| directory.path == parent)
            {
                let name = path.file_name().and_then(|name| name.to_str());
                if name.is_none_or(|name| !directory.seen.contains(name)) {
                    return Err(PortcoveError::state(
                        "scan continuation lost an examined directory entry",
                    ));
                }
            }
        }
    }
    // Re-establish the conservative construction charge; never trust a stored smaller counter.
    cursor.retained_bytes = cursor.retained_bytes.max(
        1024 + cursor
            .observed
            .iter()
            .map(|(path, stamp)| {
                serde_json::to_vec(&(path, stamp)).map(|bytes| bytes.len() * 2 + 256)
            })
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .sum::<usize>(),
    );
    if cursor.retained_bytes > MAX_CONTINUATION_BYTES {
        return Err(PortcoveError::state(
            "scan continuation exceeds its construction charge",
        ));
    }
    Ok(cursor)
}

fn current_game_file_scan(
    catalog: &Catalog,
    library: &crate::Library,
) -> Result<Option<GameFileScanSnapshot>> {
    let Some(payload) = library.stored_game_file_scan_payload()? else {
        return Ok(None);
    };
    let mut snapshot = decode_game_file_scan(&payload)?;
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
    if snapshot.format_version < CURRENT_SCAN_FORMAT_VERSION {
        snapshot.coverage = None;
        snapshot.continuation = None;
    }
    snapshot.freshness = if snapshot.continuation.as_ref() != Some(&serde_json::Value::Null)
        && !snapshot
            .coverage
            .as_ref()
            .is_some_and(|coverage| coverage.restart_required)
        && snapshot.format_version == CURRENT_SCAN_FORMAT_VERSION
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
    continuation: Option<ScanContinuation>,
    initial_entries: u32,
    entries_relisted: u32,
    metadata_checks: u32,
    prior_member_rechecks: u32,
    prior_paths: BTreeSet<PathBuf>,
    terminal_limited: bool,
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
            Self::Library => "source discovery roots cannot be inside the Portcove library",
            Self::ManagedOutput => {
                "source discovery roots cannot be inside a Portcove-managed game output"
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
    scan_with_continuation(
        catalog,
        request,
        operation,
        exclusions,
        output_library,
        emit,
        None,
        None,
        0,
    )
    .map(|batch| batch.report)
}

#[allow(clippy::too_many_arguments)]
fn scan_with_continuation<'a>(
    catalog: &'a Catalog,
    request: &SourceDiscoveryRequest,
    operation: &crate::OperationCoordinator,
    exclusions: Vec<DiscoveryExclusion>,
    output_library: Option<&'a crate::Library>,
    emit: &'a mut dyn FnMut(crate::OperationEvent),
    previous: Option<SourceDiscoveryReport>,
    mut continuation: Option<ScanContinuation>,
    initial_checks: u32,
) -> Result<ScanBatch> {
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
    let initial_entries = previous
        .as_ref()
        .map_or(0, |report| report.entries_examined);
    let hash_bytes = previous.as_ref().map_or(0, |report| report.hash_bytes);
    let reached = previous
        .as_ref()
        .map(|report| {
            report
                .limits_reached
                .iter()
                .copied()
                .filter(|limit| *limit != SourceDiscoveryLimit::Entries)
                .collect()
        })
        .unwrap_or_default();
    let prior_paths = if previous.is_some() {
        continuation
            .as_ref()
            .map(|cursor| cursor.observed.keys().cloned().collect())
            .unwrap_or_default()
    } else {
        BTreeSet::new()
    };
    if previous.is_none()
        && let Some(cursor) = &mut continuation
    {
        cursor.pending = selected
            .iter()
            .map(|path| ScanDirectory {
                path: path.clone(),
                depth: 0,
                seen: BTreeSet::new(),
                complete: true,
            })
            .collect();
    }
    let mut report = previous.unwrap_or(SourceDiscoveryReport {
        searched_roots: selected.clone(),
        searched_profiles: Vec::new(),
        candidates: Vec::new(),
        entries_examined: 0,
        files_hashed: 0,
        hash_bytes: 0,
        symlinks_skipped: 0,
        limits_reached: Vec::new(),
        issues: Vec::new(),
        issues_omitted: 0,
    });
    if report.searched_roots != selected {
        return Err(PortcoveError::state("scan continuation roots changed"));
    }
    report.searched_profiles.clear();
    let mut discovery = Discovery {
        catalog,
        report,
        raw_profiles_by_extension: BTreeMap::new(),
        zip_profile_groups: BTreeMap::new(),
        directory_profiles: Vec::new(),
        compound_profiles: Vec::new(),
        hashed_paths: BTreeSet::new(),
        limits: &request.limits,
        reached,
        budget: HashBudget {
            operation: Some(operation.clone()),
            limit: request.limits.max_hash_bytes,
            hashed: hash_bytes,
            max_zip_entries: 4096,
        },
        exclusions,
        output_library,
        emit,
        continuation,
        initial_entries,
        entries_relisted: 0,
        metadata_checks: initial_checks,
        prior_member_rechecks: 0,
        prior_paths,
        terminal_limited: false,
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
    } else if let Some(cursor) = &mut discovery.continuation {
        cursor.pending.clear();
    }
    if let Some(cursor) = &discovery.continuation {
        for (path, expected) in &cursor.observed {
            operation.checkpoint()?;
            discovery.metadata_checks += 1;
            if discovery.metadata_checks + discovery.entries_relisted > MAX_RESUME_CHECKS {
                return Err(PortcoveError::state(
                    "scan continuation validation exceeds its work limit; select narrower folders",
                ));
            }
            if ScanEntryStamp::read(path)? != *expected {
                return Err(PortcoveError::conflict(
                    "game-file entry changed during the scan; checkpoint was preserved",
                ));
            }
        }
    }
    discovery.report.hash_bytes = discovery.budget.hashed;
    discovery.report.limits_reached = discovery.reached.into_iter().collect();
    discovery.report.candidates.sort_by(|left, right| {
        (&left.profile_id, &left.path).cmp(&(&right.profile_id, &right.path))
    });
    Ok(ScanBatch {
        report: discovery.report,
        continuation: discovery.continuation,
        entries_relisted: discovery.entries_relisted,
        metadata_checks: discovery.metadata_checks,
        prior_member_rechecks: discovery.prior_member_rechecks,
        terminal_limited: discovery.terminal_limited,
    })
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
        let mut pending = if let Some(cursor) = &mut self.continuation {
            std::mem::take(&mut cursor.pending)
        } else {
            self.report
                .searched_roots
                .iter()
                .map(|path| ScanDirectory {
                    path: path.clone(),
                    depth: 0,
                    seen: BTreeSet::new(),
                    complete: true,
                })
                .collect()
        };
        // All queued roots have a stamp before any checkpoint can be published.
        for directory in &pending {
            if !self.remember_entry(&directory.path)? {
                self.save_frontier(pending);
                return Ok(());
            }
        }
        while let Some(mut state) = pending.pop_front() {
            let directory = state.path.clone();
            let depth = state.depth;
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
            if !self.remember_entry(&directory)? {
                pending.push_front(state);
                self.save_frontier(pending);
                return Ok(());
            }
            // Names are traversal bookkeeping only. Previous hashes never cross batches.
            let mut members = state
                .seen
                .iter()
                .filter_map(|name| {
                    let path = directory.join(name);
                    self.continuation
                        .as_ref()
                        .and_then(|cursor| cursor.observed.get(&path))
                        .and_then(|stamp| stamp.as_ref())
                        .filter(|stamp| stamp.kind == 0)
                        .map(|_| (name.clone(), path))
                })
                .collect::<Vec<_>>();
            let mut observations = DirectoryObservations::default();
            let mut complete = state.complete;
            for entry in entries {
                if let Some(operation) = &self.budget.operation {
                    operation.checkpoint()?;
                }
                if self.continuation.is_some() {
                    self.entries_relisted += 1;
                    let final_checks = self
                        .continuation
                        .as_ref()
                        .map_or(0, |cursor| cursor.observed.len() as u32);
                    if self.entries_relisted + self.metadata_checks + final_checks
                        >= MAX_RESUME_CHECKS
                    {
                        self.limit_continuation("Scan continuation reached its bounded re-list work limit; select narrower folders.");
                        state.complete = complete;
                        pending.push_front(state);
                        self.save_frontier(pending);
                        return Ok(());
                    }
                }
                if entry
                    .as_ref()
                    .ok()
                    .and_then(|entry| entry.file_name().to_str().map(str::to_owned))
                    .is_some_and(|name| state.seen.contains(&name))
                {
                    continue;
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
                if self.report.entries_examined - self.initial_entries >= self.limits.max_entries {
                    self.reached.insert(SourceDiscoveryLimit::Entries);
                    state.complete = complete;
                    pending.push_front(state);
                    self.save_frontier(pending);
                    return Ok(());
                }
                self.report.entries_examined =
                    self.report.entries_examined.checked_add(1).ok_or_else(|| {
                        PortcoveError::state("scan entry counter reached its limit")
                    })?;
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        self.issue(Some(directory.clone()), None, error.to_string());
                        complete = false;
                        continue;
                    }
                };
                if self.continuation.is_some() {
                    let Ok(name) = entry.file_name().into_string() else {
                        self.limit_continuation("Saved scan continuation requires Unicode entry names; select narrower folders.");
                        state.complete = false;
                        pending.push_front(state);
                        self.save_frontier(pending);
                        return Ok(());
                    };
                    if !self.remember_entry(&entry.path())? {
                        state.complete = false;
                        pending.push_front(state);
                        self.save_frontier(pending);
                        return Ok(());
                    }
                    state.seen.insert(name);
                }
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
                        pending.push_back(ScanDirectory {
                            path: canonical,
                            depth: depth + 1,
                            seen: BTreeSet::new(),
                            complete: true,
                        });
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
                        state.complete = complete;
                        pending.push_front(state);
                        self.save_frontier(pending);
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
                    self.save_frontier(pending);
                    return Ok(());
                }
            }
        }
        self.save_frontier(pending);
        Ok(())
    }

    fn save_frontier(&mut self, pending: VecDeque<ScanDirectory>) {
        if let Some(cursor) = &mut self.continuation {
            cursor.pending = pending;
        }
    }

    fn remember_entry(&mut self, path: &Path) -> Result<bool> {
        let Some(cursor) = &mut self.continuation else {
            return Ok(true);
        };
        // Reserve final validation work before inspecting another entry.
        if self.metadata_checks + self.entries_relisted + cursor.observed.len() as u32 + 2
            >= MAX_RESUME_CHECKS
        {
            self.limit_continuation("Scan continuation reached its bounded metadata work limit; select narrower folders.");
            return Ok(false);
        }
        self.metadata_checks += 1;
        match cursor.remember(path) {
            Ok(()) => Ok(true),
            Err(error) if error.details.contains_key("continuation_limit") => {
                self.limit_continuation(
                    "Scan continuation reached its bounded storage limit; select narrower folders.",
                );
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    fn limit_continuation(&mut self, message: &str) {
        self.terminal_limited = true;
        self.issue(None, None, message.into());
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
            if self.prior_paths.contains(member_path) {
                self.prior_member_rechecks += 1;
            }
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
        if self.continuation.is_some()
            && self.report.issues.iter().any(|issue| {
                issue.path == path && issue.profile_id == profile_id && issue.message == message
            })
        {
            return;
        }
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
