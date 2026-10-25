//! Bounded container observations for the existing source inspector.
#[cfg(test)]
#[path = "source_disc_tests.rs"]
mod tests;
use std::{
    cell::Cell,
    collections::BTreeSet,
    fs,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    time::{Duration, Instant},
};

use crate::{
    Library, PortcoveError, Result, SourceKind, SourceRecord,
    adapter::{
        GAMECUBE_DISC_CAPACITY_BYTES, ObservedDiscSource, ObservedOpticalDisc, inspect_psx_cue,
        inspect_psx_volume_id, materialize_gamecube_iso_for_discovery,
        materialize_psx_chd_for_discovery,
    },
    source_file::{HashBudget, read_raw_identity_from_reader},
    source_inspection::verify_open_source_location,
};

const CISO_HEADER_BYTES: usize = 0x8000;
const MAX_DECODER_BLOCK_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CONTAINER_METADATA_BYTES: u64 = 4 * 1024 * 1024;
// Explicit selection has no scan batch/hash allowance. Its individual original
// and decoded disc still have a fixed boundary, independent of scan settings.
#[cfg(any(windows, target_os = "linux"))]
const MAX_SELECTED_DISC_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn observe_selected_with_checkpoint(
    catalog: &crate::Catalog,
    profile: &crate::SourceProfile,
    path: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<ObservedDiscSource> {
    checkpoint()?;
    let canonical = fs::canonicalize(path)?;
    let directory = if canonical.is_dir() {
        let handle = crate::external_runtime::open_identity_handle(&canonical)?;
        let initial = handle.metadata()?;
        crate::source_inspection::verify_open_source_directory(&canonical, &handle, &initial)?;
        Some((handle, initial))
    } else {
        None
    };
    let mut counts = catalog
        .source_catalog()
        .into_iter()
        .flat_map(|source| &source.identities)
        .filter(|identity| identity.id == profile.id)
        .flat_map(|identity| &identity.variants)
        .filter(|variant| !variant.legacy_projection_only)
        .flat_map(|variant| &variant.representations)
        .filter_map(|representation| match &representation.kind {
            crate::SourceRepresentationKind::OpticalTrackSet { .. }
            | crate::SourceRepresentationKind::VolumeId { .. } => Some(1),
            crate::SourceRepresentationKind::MultiDiscSet { discs } if !discs.is_empty() => {
                Some(discs.len())
            }
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let paths = if profile.kind == SourceKind::PsxDisc {
        let count = profile
            .disc
            .as_ref()
            .ok_or_else(|| PortcoveError::state("PS1 profile is missing its disc identity"))?
            .discs
            .len()
            .max(1);
        counts.insert(count);
        selected_psx_paths(&canonical, &counts)?
    } else {
        vec![canonical.clone()]
    };
    let temporary_parent = std::env::var_os("PORTCOVE_TEMP_DIR")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    fs::create_dir_all(&temporary_parent)?;
    let parent = InspectionDirectory::new(
        tempfile::Builder::new()
            .prefix("portcove-selected-disc-")
            .tempdir_in(temporary_parent)?,
    );
    let mut budget = HashBudget {
        checkpoint: Some(checkpoint),
        operation: None,
        limit: u64::MAX,
        hashed: 0,
        max_zip_entries: 4096,
    };
    let mut members = Vec::with_capacity(paths.len());
    for member in &paths {
        let observed = observe(
            &profile.id,
            profile.kind,
            member,
            &parent,
            MAX_SELECTED_DISC_BYTES,
            &mut budget,
        )
        .map_err(|error| {
            if error.details.contains_key("retained_inspection") {
                error.detail(
                    "retained_inspection_parent",
                    parent.path().display().to_string(),
                )
            } else {
                error
            }
        })?;
        members.push(observed.source);
    }
    if let Some((handle, initial)) = &directory {
        crate::source_inspection::verify_open_source_directory(&canonical, handle, initial)?;
        if selected_psx_paths(&canonical, &counts)? != paths {
            return Err(PortcoveError::conflict(
                "selected disc inventory changed during inspection",
            ));
        }
    }
    // An earlier member can change while a later decoder runs. Recheck every
    // original from the same ordered inventory, never a new storage enumeration.
    for (member, observed) in paths.iter().zip(&members) {
        let mut input = crate::external_runtime::open_identity_handle(member)?;
        let initial = input.metadata()?;
        verify_open_source_location(member, &input, &initial)?;
        let actual = read_raw_identity_from_reader(
            member,
            &mut input,
            initial.len(),
            MAX_SELECTED_DISC_BYTES,
            &mut budget,
        )?;
        verify_open_source_location(member, &input, &initial)?;
        if actual.sha256 != observed.record.storage_sha256
            || actual.size != observed.record.storage_size
        {
            return Err(PortcoveError::conflict(
                "selected original changed during disc inspection",
            ));
        }
    }
    if let Some((handle, initial)) = &directory {
        crate::source_inspection::verify_open_source_directory(&canonical, handle, initial)?;
    }
    if fs::canonicalize(path)? != canonical {
        return Err(PortcoveError::conflict(
            "selected disc location changed during inspection",
        ));
    }
    let mut result = if profile.kind == SourceKind::PsxDisc {
        aggregate(&profile.id, path, &members)?
    } else {
        members.pop().expect("one selected GameCube disc")
    };
    result.record.path = path.to_path_buf();
    Ok(result)
}

#[cfg(any(windows, target_os = "linux"))]
fn selected_psx_paths(path: &Path, counts: &BTreeSet<usize>) -> Result<Vec<std::path::PathBuf>> {
    let paths = if path.is_file() {
        vec![path.to_path_buf()]
    } else if path.is_dir() {
        // One complete inventory uses the existing order/count authority.
        let mut paths = Vec::new();
        for (index, entry) in fs::read_dir(path)?.enumerate() {
            if index >= 16_384 {
                return Err(PortcoveError::unsupported(
                    "selected disc directory exceeds its bounded inventory; select a directory containing only the required inputs",
                ));
            }
            let entry = entry?;
            let member = entry.path();
            crate::path::unicode(&member, "source member")?;
            if member
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("chd"))
            {
                if !entry.file_type()?.is_file() {
                    return Err(PortcoveError::source(
                        "complete disc sets require regular CHD members",
                    ));
                }
                paths.push(member);
            }
        }
        paths
    } else {
        return Err(PortcoveError::source("selected PS1 source is unavailable"));
    };
    if !counts.contains(&paths.len()) {
        return Err(PortcoveError::source(format!(
            "selected PS1 source requires one of {counts:?} complete CHD member counts; found {}",
            paths.len()
        )));
    }
    let count = paths.len();
    crate::adapter::order_psx_source_paths(paths, path, count)
}

/// The complete private observation tree shares the decoder's closure flag.
/// Normal errors and unwinding retain both child and parent until proof arrives.
pub(crate) struct InspectionDirectory {
    directory: Option<tempfile::TempDir>,
    quiesced: Cell<bool>,
}

impl InspectionDirectory {
    pub(crate) fn new(directory: tempfile::TempDir) -> Self {
        Self {
            directory: Some(directory),
            quiesced: Cell::new(true),
        }
    }
    pub(crate) fn path(&self) -> &Path {
        self.directory
            .as_ref()
            .expect("owned inspection directory")
            .path()
    }
    pub(crate) fn keep(mut self) -> std::path::PathBuf {
        self.directory
            .take()
            .expect("owned inspection directory")
            .keep()
    }
}

impl Drop for InspectionDirectory {
    fn drop(&mut self) {
        if !self.quiesced.get()
            && let Some(directory) = self.directory.take()
        {
            let _retained = directory.keep();
        }
    }
}

struct InspectionWorkspace<'a> {
    directory: Option<tempfile::TempDir>,
    quiesced: &'a Cell<bool>,
}

impl InspectionWorkspace<'_> {
    fn path(&self) -> &Path {
        self.directory
            .as_ref()
            .expect("owned inspection workspace")
            .path()
    }
    fn keep(mut self) -> std::path::PathBuf {
        self.directory
            .take()
            .expect("owned inspection workspace")
            .keep()
    }
}

impl Drop for InspectionWorkspace<'_> {
    fn drop(&mut self) {
        if !self.quiesced.get()
            && let Some(directory) = self.directory.take()
        {
            let _retained = directory.keep();
        }
    }
}

/// Current accepted representations, never informational or legacy projections.
pub(crate) fn scan_extensions(
    catalog: &crate::Catalog,
    profile: &crate::SourceProfile,
) -> Vec<String> {
    let Some(identity) = catalog.source_catalog().and_then(|source| {
        source
            .identities
            .iter()
            .find(|identity| identity.id == profile.id)
    }) else {
        return Vec::new();
    };
    identity
        .variants
        .iter()
        .filter(|variant| !variant.legacy_projection_only)
        .flat_map(|variant| &variant.representations)
        .filter(
            |representation| match (&profile.kind, &representation.kind) {
                (
                    SourceKind::GamecubeDisc,
                    crate::SourceRepresentationKind::GamecubeNormalizedIso { identities },
                ) => !identities.is_empty(),
                (
                    SourceKind::PsxDisc,
                    crate::SourceRepresentationKind::OpticalTrackSet { .. }
                    | crate::SourceRepresentationKind::MultiDiscSet { .. }
                    | crate::SourceRepresentationKind::VolumeId { .. },
                ) => true,
                _ => false,
            },
        )
        .flat_map(|representation| {
            if representation.extensions.is_empty() {
                &profile.accepted_extensions
            } else {
                &representation.extensions
            }
        })
        .map(|extension| extension.to_ascii_lowercase())
        .filter(|extension| match profile.kind {
            SourceKind::GamecubeDisc => {
                matches!(extension.as_str(), "ciso" | "gcz" | "rvz" | "wia")
            }
            SourceKind::PsxDisc => extension == "chd",
            _ => false,
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(crate) fn set_sizes(catalog: &crate::Catalog, profile_id: &str) -> BTreeSet<usize> {
    let Ok(profile) = catalog.source_profile(profile_id) else {
        return BTreeSet::new();
    };
    catalog
        .source_catalog()
        .into_iter()
        .flat_map(|catalog| &catalog.identities)
        .filter(|identity| identity.id == profile_id)
        .flat_map(|identity| &identity.variants)
        .filter(|variant| !variant.legacy_projection_only)
        .flat_map(|variant| &variant.representations)
        .filter(|representation| {
            let extensions = if representation.extensions.is_empty() {
                &profile.accepted_extensions
            } else {
                &representation.extensions
            };
            extensions
                .iter()
                .any(|extension| extension.eq_ignore_ascii_case("chd"))
        })
        .filter_map(|representation| match &representation.kind {
            crate::SourceRepresentationKind::MultiDiscSet { discs } => Some(discs.len()),
            _ => None,
        })
        .collect()
}

pub(crate) fn aggregate(
    profile_id: &str,
    path: &Path,
    members: &[ObservedDiscSource],
) -> Result<ObservedDiscSource> {
    let normalized = members
        .iter()
        .map(|member| member.record.sha256.clone())
        .collect::<Vec<_>>();
    let stored = members
        .iter()
        .map(|member| member.record.storage_sha256.clone())
        .collect::<Vec<_>>();
    let mut normalized_size = 0_u64;
    let mut storage_size = 0_u64;
    let mut discs = Vec::with_capacity(members.len());
    for member in members {
        normalized_size = normalized_size
            .checked_add(member.record.size)
            .ok_or_else(|| PortcoveError::source("normalized disc set size overflowed"))?;
        storage_size = storage_size
            .checked_add(member.record.storage_size)
            .ok_or_else(|| PortcoveError::source("stored disc set size overflowed"))?;
        let [disc] = member.discs.as_slice() else {
            return Err(PortcoveError::source(
                "disc set member is not one complete disc",
            ));
        };
        discs.push(disc.clone());
    }
    Ok(ObservedDiscSource {
        record: SourceRecord {
            profile_id: profile_id.into(),
            path: path.into(),
            sha256: crate::adapter::aggregate_sha256(&normalized),
            size: normalized_size,
            storage_sha256: crate::adapter::aggregate_sha256(&stored),
            storage_size,
            updated_at: Library::now(),
            observed_identity: None,
        },
        discs,
    })
}

pub(crate) fn observe(
    profile_id: &str,
    kind: SourceKind,
    path: &Path,
    parent: &InspectionDirectory,
    maximum_size: u64,
    budget: &mut HashBudget,
) -> Result<DiscObservation> {
    if kind == SourceKind::GamecubeDisc
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("ciso"))
    {
        return observe_ciso_facts(profile_id, path, maximum_size, budget);
    }
    // Windows jobs and Linux decoder namespaces prove descendant closure.
    // Other Unix process groups cannot safely admit generated decoder output.
    if !cfg!(any(windows, target_os = "linux")) {
        return Err(PortcoveError::unsupported(
            "normalized disc inspection needs verified decoder-tree closure on this platform; choose an accepted normalized input directly",
        ));
    }
    fs::create_dir_all(parent.path())?;
    let directory = tempfile::Builder::new()
        .prefix("portcove-disc-inspection-")
        .tempdir_in(parent.path())?;
    let quiesced = &parent.quiesced;
    let workspace = InspectionWorkspace {
        directory: Some(directory),
        quiesced,
    };
    let result = observe_converted_disc(
        DiscInput {
            profile_id,
            kind,
            path,
            maximum_size,
        },
        workspace.path(),
        budget,
        quiesced,
        None,
    );
    if !quiesced.get() {
        let retained = workspace.keep();
        return Err(result
            .err()
            .unwrap_or_else(|| PortcoveError::state("disc decoder closure is unproved"))
            .detail("retained_inspection", retained.display().to_string()));
    }
    result
}

/// The caller owns and excludes this fresh private workspace. No generated
/// path becomes a registered source. Unproved tool closure forbids cleanup.
struct DiscInput<'a> {
    profile_id: &'a str,
    kind: SourceKind,
    path: &'a Path,
    maximum_size: u64,
}

pub(crate) struct DiscObservation {
    pub(crate) source: ObservedDiscSource,
    pub(crate) original: crate::source_file::FileIdentity,
}

fn observe_converted_disc(
    source: DiscInput<'_>,
    workspace: &Path,
    budget: &mut HashBudget,
    quiesced: &Cell<bool>,
    pinned_tool: Option<&Path>,
) -> Result<DiscObservation> {
    let DiscInput {
        profile_id,
        kind,
        path,
        maximum_size,
    } = source;
    let operation = budget.operation.clone();
    let supplied_checkpoint = budget.checkpoint;
    let checkpoint = || {
        if let Some(checkpoint) = supplied_checkpoint {
            checkpoint()?;
        }
        if let Some(operation) = &operation {
            operation.checkpoint()?;
        }
        Ok(())
    };
    checkpoint()?;
    let mut file = crate::external_runtime::open_identity_handle(path)?;
    let initial = file.metadata()?;
    verify_open_source_location(path, &file, &initial)?;
    let extension = if kind == SourceKind::PsxDisc {
        // The selected-input contract can leave extensions unconstrained. CHD
        // magic/preflight, rather than the original filename, selects its codec.
        "chd".to_owned()
    } else {
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
    };
    let decoded_bytes = container_decoded_bytes(&mut file, &extension, &checkpoint)?;
    if initial.len() > maximum_size || decoded_bytes > maximum_size {
        return Err(PortcoveError::unsupported(
            "disc container exceeds its per-file inspection boundary",
        )
        .detail("scan_limit", "file_size"));
    }
    budget.reserve(
        initial
            .len()
            .checked_mul(2)
            .and_then(|bytes| bytes.checked_add(decoded_bytes))
            .ok_or_else(|| PortcoveError::source("disc inspection size overflowed"))?,
    )?;
    file.seek(SeekFrom::Start(0))?;
    let snapshot_path = workspace.join(format!("input.{extension}"));
    let snapshot = File::create_new(&snapshot_path)?;
    let stored = read_raw_identity_from_reader(
        path,
        SnapshotReader {
            input: &mut file,
            output: snapshot,
        },
        initial.len(),
        maximum_size,
        budget,
    )?;
    verify_open_source_location(path, &file, &initial)?;
    let mut snapshot = File::open(&snapshot_path)?;
    if container_decoded_bytes(&mut snapshot, &extension, &checkpoint)? != decoded_bytes {
        return Err(PortcoveError::conflict(
            "disc container header changed while taking its inspection snapshot",
        ));
    }
    let output = workspace.join("decoded");
    fs::create_dir(&output)?;
    let user_directory = workspace.join("decoder-user");
    fs::create_dir(&user_directory)?;
    let output_limit = decoded_bytes
        .checked_add(MAX_CONTAINER_METADATA_BYTES)
        .ok_or_else(|| PortcoveError::source("disc output size overflowed"))?;
    let started = Instant::now();
    let conversion_checkpoint = || {
        checkpoint()?;
        if started.elapsed() > Duration::from_secs(600) {
            return Err(PortcoveError::unsupported(
                "disc inspection exceeded its execution bound; the input was not inspected",
            ));
        }
        check_output_tree(
            workspace,
            output_limit
                .checked_add(initial.len())
                .ok_or_else(|| PortcoveError::source("disc workspace size overflowed"))?,
        )
    };
    let mut confirm = || {
        quiesced.set(true);
        Ok(())
    };
    let observer = crate::tool_process::ToolProcessObserver {
        diagnostics: None,
        quiesced: Some(&mut confirm),
    };
    let limits = crate::process::DecoderLimits {
        memory_bytes: 512 * 1024 * 1024,
        file_bytes: output_limit,
    };
    let inspection = crate::adapter::DecoderInspection {
        limits,
        quiesced,
        user_directory: Some(&user_directory),
    };
    let (normalized_path, track_count, volume_id) = if kind == SourceKind::PsxDisc {
        let cue = materialize_psx_chd_for_discovery(
            &snapshot_path,
            &output,
            pinned_tool,
            &conversion_checkpoint,
            observer,
            inspection,
        )?;
        require_decoder_quiescence(quiesced)?;
        conversion_checkpoint()?;
        let (count, track) = inspect_psx_cue(&cue)?;
        let canonical = fs::canonicalize(&track)?;
        if !fs::symlink_metadata(&track)?.is_file()
            || !canonical.starts_with(fs::canonicalize(&output)?)
        {
            return Err(PortcoveError::source(
                "decoded track escaped its private inspection folder",
            ));
        }
        let volume_id = inspect_psx_volume_id(&canonical).ok();
        (canonical, count, volume_id)
    } else {
        let iso = output.join("disc.iso");
        materialize_gamecube_iso_for_discovery(
            &snapshot_path,
            &iso,
            pinned_tool,
            &conversion_checkpoint,
            observer,
            inspection,
        )?;
        require_decoder_quiescence(quiesced)?;
        conversion_checkpoint()?;
        if fs::metadata(&iso)?.len() != decoded_bytes {
            return Err(PortcoveError::source(
                "decoded image disagrees with the bounded container size",
            ));
        }
        (fs::canonicalize(iso)?, 1, None)
    };
    let mut decoded = File::open(&normalized_path)?;
    let decoded_initial = decoded.metadata()?;
    verify_open_source_location(&normalized_path, &decoded, &decoded_initial)?;
    if decoded_initial.len() > decoded_bytes {
        return Err(PortcoveError::source(
            "decoded track exceeds the bounded container size",
        ));
    }
    let normalized = read_raw_identity_from_reader(
        &normalized_path,
        &mut decoded,
        decoded_initial.len(),
        maximum_size,
        budget,
    )?;
    verify_open_source_location(&normalized_path, &decoded, &decoded_initial)?;
    file.seek(SeekFrom::Start(0))?;
    let after =
        read_raw_identity_from_reader(path, &mut file, initial.len(), maximum_size, budget)?;
    verify_open_source_location(path, &file, &initial)?;
    if stored.sha256 != after.sha256 {
        return Err(PortcoveError::conflict(
            "disc container changed during normalization",
        ));
    }
    Ok(DiscObservation {
        source: ObservedDiscSource {
            record: SourceRecord {
                profile_id: profile_id.into(),
                path: path.into(),
                sha256: if kind == SourceKind::PsxDisc {
                    crate::adapter::aggregate_sha256(std::slice::from_ref(&normalized.sha256))
                } else {
                    normalized.sha256.clone()
                },
                size: normalized.size,
                storage_sha256: stored.sha256.clone(),
                storage_size: stored.size,
                updated_at: Library::now(),
                observed_identity: None,
            },
            discs: vec![ObservedOpticalDisc {
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned),
                sha1: normalized.sha1,
                sha256: normalized.sha256,
                size: normalized.size,
                track_count,
                volume_id,
            }],
        },
        original: stored,
    })
}

fn require_decoder_quiescence(quiesced: &Cell<bool>) -> Result<()> {
    if !quiesced.get() {
        return Err(PortcoveError::state(
            "disc decoder tree closure is unproved; retain private inspection and leave the source uninspected",
        ));
    }
    Ok(())
}

fn check_output_tree(root: &Path, limit: u64) -> Result<()> {
    let canonical = fs::canonicalize(root)?;
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut entries = 0;
    let mut bytes = 0_u64;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 8 {
            return Err(PortcoveError::source(
                "disc decoder exceeded its private output structure boundary",
            ));
        }
        // Encoders atomically replace their own configuration and temporary
        // files. A disappeared entry has no extant output to account for; all
        // other errors remain failures, and the closed tree is checked again
        // before reading decoded bytes.
        let entries_in_directory = match fs::read_dir(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && directory != root => {
                continue;
            }
            result => result?,
        };
        for entry in entries_in_directory {
            entries += 1;
            if entries > 1024 {
                return Err(PortcoveError::source(
                    "disc decoder exceeded its private output structure boundary",
                ));
            }
            let entry = entry?;
            let metadata = match fs::symlink_metadata(entry.path()) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                result => result?,
            };
            let kind = metadata.file_type();
            if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) {
                return Err(PortcoveError::source(
                    "disc decoder produced a symlink or non-file output",
                ));
            }
            let location = match fs::canonicalize(entry.path()) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                result => result?,
            };
            if !location.starts_with(&canonical) {
                return Err(PortcoveError::source(
                    "disc decoder exceeded its private output structure boundary",
                ));
            }
            if kind.is_dir() {
                pending.push((entry.path(), depth + 1));
            } else if kind.is_file() {
                bytes = bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| PortcoveError::source("decoder output size overflowed"))?;
                if bytes > limit {
                    return Err(PortcoveError::source(
                        "disc decoder exceeded its private output size boundary",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn container_decoded_bytes(
    file: &mut File,
    extension: &str,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<u64> {
    file.seek(SeekFrom::Start(0))?;
    let mut header = [0_u8; 124];
    let length = match extension {
        "chd" => 124,
        "gcz" => 32,
        "rvz" | "wia" => 72,
        _ => {
            return Err(PortcoveError::source(
                "unsupported normalized disc container",
            ));
        }
    };
    file.read_exact(&mut header[..length])?;
    checkpoint()?;
    let size = match extension {
        "chd" => {
            if &header[..8] != b"MComprHD" {
                return Err(PortcoveError::source("invalid CHD header"));
            }
            let version = be32(&header, 12);
            let (expected, logical_offset, hunk_offset, parent, metadata_offset) = match version {
                3 => (120, 28, 76, 100..120, 36),
                4 => (108, 28, 44, 68..88, 36),
                5 => (124, 32, 56, 104..124, 48),
                _ => {
                    return Err(PortcoveError::source(
                        "CHD version is not supported by bounded discovery",
                    ));
                }
            };
            if be32(&header, 8) != expected
                || header[parent].iter().any(|byte| *byte != 0)
                || (version < 5 && be32(&header, 16) & 1 != 0)
            {
                return Err(PortcoveError::source(
                    "CHD has an invalid header or requires an unselected parent",
                ));
            }
            let logical = be64(&header, logical_offset);
            let hunk = be32(&header, hunk_offset) as u64;
            if hunk == 0 || hunk > 512 * 1024 || logical.div_ceil(hunk) > 4 * 1024 * 1024 {
                return Err(PortcoveError::source(
                    "CHD hunk map exceeds its structural boundary",
                ));
            }
            if version < 5 && be32(&header, 24) as u64 != logical.div_ceil(hunk) {
                return Err(PortcoveError::source(
                    "CHD hunk count disagrees with its logical size",
                ));
            }
            let file_bytes = file.metadata()?.len();
            if version < 5 {
                check_extent(expected as u64, logical.div_ceil(hunk) * 16, file_bytes)?;
            } else {
                let map_offset = be64(&header, 40);
                if map_offset < 124 {
                    return Err(PortcoveError::source("CHD map overlaps its header"));
                }
                if header[16..32].iter().all(|byte| *byte == 0) {
                    check_extent(map_offset, logical.div_ceil(hunk) * 4, file_bytes)?;
                } else {
                    check_extent(map_offset, 16, file_bytes)?;
                    file.seek(SeekFrom::Start(map_offset))?;
                    let mut map = [0; 16];
                    file.read_exact(&mut map)?;
                    let bytes = be32(&map, 0) as u64;
                    if bytes > MAX_CONTAINER_METADATA_BYTES {
                        return Err(PortcoveError::source(
                            "CHD compressed map exceeds its bounded metadata size",
                        ));
                    }
                    check_extent(map_offset + 16, bytes, file_bytes)?;
                }
            }
            let mut offset = be64(&header, metadata_offset);
            let mut seen = BTreeSet::new();
            let mut metadata_bytes = 0_u64;
            while offset != 0 {
                checkpoint()?;
                if seen.len() >= 4096 || !seen.insert(offset) {
                    return Err(PortcoveError::source(
                        "CHD metadata chain exceeds its structural boundary",
                    ));
                }
                check_extent(offset, 16, file.metadata()?.len())?;
                file.seek(SeekFrom::Start(offset))?;
                let mut entry = [0_u8; 16];
                file.read_exact(&mut entry)?;
                let bytes = (be32(&entry, 4) & 0x00ff_ffff) as u64;
                metadata_bytes += bytes;
                if bytes > 256 * 1024 || metadata_bytes > MAX_CONTAINER_METADATA_BYTES {
                    return Err(PortcoveError::source(
                        "CHD metadata exceeds its bounded size",
                    ));
                }
                check_extent(offset + 16, bytes, file.metadata()?.len())?;
                offset = be64(&entry, 8);
            }
            logical
        }
        "gcz" => {
            if le32(&header, 0) != 0xb10b_c001 {
                return Err(PortcoveError::source("invalid GCZ header"));
            }
            let logical = u64::from_le_bytes(header[16..24].try_into().unwrap());
            let block = le32(&header, 24) as u64;
            let count = le32(&header, 28) as u64;
            if block == 0
                || block > MAX_DECODER_BLOCK_BYTES
                || count != logical.div_ceil(block)
                || count > MAX_CONTAINER_METADATA_BYTES / 12
            {
                return Err(PortcoveError::source(
                    "GCZ block map exceeds its structural boundary",
                ));
            }
            check_extent(32, count * 12, file.metadata()?.len())?;
            logical
        }
        "rvz" | "wia" => {
            let magic = if extension == "rvz" {
                b"RVZ\x01"
            } else {
                b"WIA\x01"
            };
            if &header[..4] != magic {
                return Err(PortcoveError::source("invalid WIA/RVZ header"));
            }
            let header_bytes = be32(&header, 12) as u64;
            if !(220..=MAX_CONTAINER_METADATA_BYTES).contains(&header_bytes) {
                return Err(PortcoveError::source(
                    "WIA/RVZ metadata header exceeds its bounded size",
                ));
            }
            check_extent(72, header_bytes, file.metadata()?.len())?;
            let mut details = [0_u8; 220];
            file.read_exact(&mut details)?;
            if (be32(&details, 144) != 0 && be32(&details, 148) < 48) || details[212] > 7 {
                return Err(PortcoveError::source("WIA/RVZ metadata layout is invalid"));
            }
            let block = be32(&details, 12) as u64;
            if block == 0 || block > MAX_DECODER_BLOCK_BYTES {
                return Err(PortcoveError::source(
                    "WIA/RVZ decoding block exceeds its structural boundary",
                ));
            }
            for (count, item_size, offset, stored_bytes) in [
                (
                    be32(&details, 144) as u64,
                    be32(&details, 148) as u64,
                    be64(&details, 152),
                    None,
                ),
                (
                    be32(&details, 180) as u64,
                    24,
                    be64(&details, 184),
                    Some(be32(&details, 192) as u64),
                ),
                (
                    be32(&details, 196) as u64,
                    if extension == "rvz" { 12 } else { 8 },
                    be64(&details, 200),
                    Some(be32(&details, 208) as u64),
                ),
            ] {
                let bytes = count
                    .checked_mul(item_size)
                    .ok_or_else(|| PortcoveError::source("WIA/RVZ table size overflowed"))?;
                if bytes > MAX_CONTAINER_METADATA_BYTES
                    || stored_bytes.is_some_and(|size| size > MAX_CONTAINER_METADATA_BYTES)
                {
                    return Err(PortcoveError::source(
                        "WIA/RVZ table exceeds its bounded metadata size",
                    ));
                }
                check_extent(
                    offset,
                    stored_bytes.unwrap_or(bytes),
                    file.metadata()?.len(),
                )?;
            }
            be64(&header, 36)
        }
        _ => unreachable!(),
    };
    if size == 0 {
        return Err(PortcoveError::source(
            "disc container declares no decoded content",
        ));
    }
    Ok(size)
}

fn check_extent(offset: u64, bytes: u64, file_bytes: u64) -> Result<()> {
    if offset.checked_add(bytes).is_none_or(|end| end > file_bytes) {
        return Err(PortcoveError::source(
            "disc container metadata is truncated",
        ));
    }
    Ok(())
}
fn be32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn be64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(bytes[offset..offset + 8].try_into().unwrap())
}
fn le32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

/// CISO is a sparse block container, not a compressed stream. Read the standard
/// GameCube image directly instead of asking Dolphin to materialize its much
/// larger map-wide upper bound. No temporary output or host tool is needed.
pub(crate) fn observe_ciso(
    profile_id: &str,
    path: &Path,
    maximum_size: u64,
    budget: &mut HashBudget,
) -> Result<ObservedDiscSource> {
    observe_ciso_facts(profile_id, path, maximum_size, budget).map(|observation| observation.source)
}

fn observe_ciso_facts(
    profile_id: &str,
    path: &Path,
    maximum_size: u64,
    budget: &mut HashBudget,
) -> Result<DiscObservation> {
    let mut file = crate::external_runtime::open_identity_handle(path)?;
    let initial = file.metadata()?;
    verify_open_source_location(path, &file, &initial)?;
    if initial.len() > maximum_size || GAMECUBE_DISC_CAPACITY_BYTES > maximum_size {
        return Err(
            PortcoveError::unsupported("CISO exceeds its per-file inspection boundary")
                .detail("scan_limit", "file_size"),
        );
    }
    let work = initial
        .len()
        .checked_mul(2)
        .and_then(|bytes| bytes.checked_add(GAMECUBE_DISC_CAPACITY_BYTES))
        .ok_or_else(|| PortcoveError::source("CISO inspection size overflowed"))?;
    budget.reserve(work)?;
    // Reject malformed map/extent before spending any private storage. A second
    // validation binds the copied header and map to the exact bytes being hashed.
    CisoReader::new(file.try_clone()?)?;
    file.seek(SeekFrom::Start(0))?;
    let mut snapshot = tempfile::tempfile()?;
    let stored = read_raw_identity_from_reader(
        path,
        SnapshotReader {
            input: &mut file,
            output: &mut snapshot,
        },
        initial.len(),
        maximum_size,
        budget,
    )?;
    let mut reader = CisoReader::new(snapshot)?;
    let normalized = read_raw_identity_from_reader(
        path,
        &mut reader,
        GAMECUBE_DISC_CAPACITY_BYTES,
        maximum_size,
        budget,
    )?;
    file.seek(SeekFrom::Start(0))?;
    let after =
        read_raw_identity_from_reader(path, &mut file, initial.len(), maximum_size, budget)?;
    verify_open_source_location(path, &file, &initial)?;
    if stored.sha256 != after.sha256 {
        return Err(PortcoveError::conflict(
            "CISO changed while its normalized bytes were inspected",
        ));
    }
    Ok(DiscObservation {
        source: ObservedDiscSource {
            record: SourceRecord {
                profile_id: profile_id.into(),
                path: path.into(),
                sha256: normalized.sha256.clone(),
                size: normalized.size,
                storage_sha256: stored.sha256.clone(),
                storage_size: stored.size,
                updated_at: Library::now(),
                observed_identity: None,
            },
            discs: vec![ObservedOpticalDisc {
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned),
                sha1: normalized.sha1,
                sha256: normalized.sha256,
                size: normalized.size,
                track_count: 1,
                volume_id: None,
            }],
        },
        original: stored,
    })
}

struct CisoReader {
    file: File,
    block_bytes: u64,
    blocks: Vec<Option<u64>>,
    position: u64,
}

/// Hash exactly the bytes copied to an owned snapshot. The decoder never opens
/// mutable originals, and the second original hash guards candidate publication.
struct SnapshotReader<R, W> {
    input: R,
    output: W,
}

impl<R: Read, W: Write> Read for SnapshotReader<R, W> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.input.read(buffer)?;
        self.output.write_all(&buffer[..count])?;
        Ok(count)
    }
}

impl CisoReader {
    fn new(mut file: File) -> Result<Self> {
        file.seek(SeekFrom::Start(0))?;
        let mut header = [0_u8; CISO_HEADER_BYTES];
        file.read_exact(&mut header)?;
        if &header[..4] != b"CISO" {
            return Err(PortcoveError::source("invalid CISO container header"));
        }
        let block_bytes = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64;
        if block_bytes == 0
            || block_bytes > MAX_DECODER_BLOCK_BYTES
            || block_bytes * ((CISO_HEADER_BYTES - 8) as u64) < GAMECUBE_DISC_CAPACITY_BYTES
        {
            return Err(PortcoveError::source(
                "CISO block map does not describe a bounded GameCube image",
            ));
        }
        let logical_blocks = GAMECUBE_DISC_CAPACITY_BYTES.div_ceil(block_bytes);
        let mut stored_blocks = 0_u64;
        let mut minimum_storage_bytes = CISO_HEADER_BYTES as u64;
        let mut blocks = Vec::with_capacity(CISO_HEADER_BYTES - 8);
        for (index, present) in header[8..].iter().copied().enumerate() {
            match present {
                0 => blocks.push(None),
                1 if (index as u64) < logical_blocks => {
                    blocks.push(Some(CISO_HEADER_BYTES as u64 + stored_blocks * block_bytes));
                    minimum_storage_bytes = CISO_HEADER_BYTES as u64
                        + stored_blocks * block_bytes
                        + block_bytes
                            .min(GAMECUBE_DISC_CAPACITY_BYTES - index as u64 * block_bytes);
                    stored_blocks += 1;
                }
                _ => {
                    return Err(PortcoveError::source(
                        "CISO has invalid or out-of-image blocks",
                    ));
                }
            }
        }
        let storage_bytes = file.metadata()?.len();
        if storage_bytes < minimum_storage_bytes
            || storage_bytes > CISO_HEADER_BYTES as u64 + stored_blocks * block_bytes
        {
            return Err(PortcoveError::source(
                "CISO stored blocks are truncated or have unexpected trailing bytes",
            ));
        }
        Ok(Self {
            file,
            block_bytes,
            blocks,
            position: 0,
        })
    }
}

impl Read for CisoReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.position == GAMECUBE_DISC_CAPACITY_BYTES || buffer.is_empty() {
            return Ok(0);
        }
        let block = (self.position / self.block_bytes) as usize;
        let within = self.position % self.block_bytes;
        let count = buffer.len().min(
            (self.block_bytes - within).min(GAMECUBE_DISC_CAPACITY_BYTES - self.position) as usize,
        );
        if let Some(offset) = self.blocks[block] {
            self.file.seek(SeekFrom::Start(offset + within))?;
            self.file.read_exact(&mut buffer[..count])?;
        } else {
            buffer[..count].fill(0);
        }
        self.position += count as u64;
        Ok(count)
    }
}
