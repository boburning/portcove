//! Optional user-selected folder transport for classified portable saves.
//!
//! The folder is any location the player chooses: removable storage, a network
//! share or a folder another sync tool mirrors. Portcove keeps no account,
//! service or standing permission; each push or pull is an explicit request with
//! the folder named by the caller. Bundles are immutable and content addressed
//! (`portcove-saves/v1/<port-id>/<content-sha256>.json`), so retries and
//! duplicate observations are idempotent and no device ever overwrites or
//! deletes another device's progress. A resolution that keeps one branch adds an
//! empty `superseded/<content-sha256>` marker; the superseded bundle stays in
//! the folder and remains importable. Import goes through the same reviewed,
//! locked, safety-backed path as a file import. When the folder is offline or
//! removed, status says so and local play and backups are unaffected.
//!
//! Folder contents are untrusted. Each bundle's bytes are verified against its
//! name, but its recorded base is only a claim: it can at most make status
//! recommend a pull, and the per-file import review still shows what changes.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use super::PortcoveService;
use crate::{
    DestructiveAuthorization, PortableSaveFile, PortableSaveFileEffect, PortableSaveIdentity,
    PortableSaveImportOptions, PortableSaveImportPreview, PortableSaveImportResult,
    PortableSaveRelation, PortcoveError, Result, SaveFolderEntry, SaveFolderNextStep,
    SaveFolderPushResult, SaveFolderStatus,
    portable_saves::{self, Bundle},
};

const FOLDER_ROOT: &str = "portcove-saves";
const FORMAT_DIRECTORY: &str = "v1";
const SUPERSEDED: &str = "superseded";
/// Saves files and set-aside markers Portcove reviews per game. Beyond this the
/// status is incomplete rather than computed from an arbitrary subset.
const MAX_BUNDLES: usize = 256;
/// Raw directory entries read before giving up, counting names of any kind.
const MAX_DIRECTORY_ENTRIES: usize = 4096;
/// Total saves-file bytes one status read may decode.
const MAX_SCAN_BYTES: u64 = 256 * 1024 * 1024;

fn digest_name(name: &str) -> Option<&str> {
    let digest = name.strip_suffix(".json")?;
    valid_digest(digest).then_some(digest)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// What status needs from one verified bundle; file bytes are not retained.
struct Summary {
    identity: PortableSaveIdentity,
    content_sha256: String,
    base_sha256: Option<String>,
    files: Vec<PortableSaveFile>,
}

struct FolderScan {
    directory: PathBuf,
    bundles: BTreeMap<String, Summary>,
    superseded: BTreeSet<String>,
    problems: Vec<String>,
    /// False when limits stopped the read; history and heads are then unknown.
    complete: bool,
}

impl FolderScan {
    /// Latest on each branch: not the recorded base of another bundle that is
    /// still offered, and not set aside.
    fn heads(&self) -> BTreeSet<String> {
        let bases: BTreeSet<&String> = self
            .bundles
            .values()
            .filter(|bundle| !self.superseded.contains(&bundle.content_sha256))
            .filter_map(|bundle| bundle.base_sha256.as_ref())
            .collect();
        let candidates: BTreeSet<String> = self
            .bundles
            .keys()
            .filter(|content| !bases.contains(content) && !self.superseded.contains(*content))
            .cloned()
            .collect();
        // Through a set-aside bundle an older one can lose its only successor;
        // it is still history of the offered head beyond it, not a new branch.
        let covered: BTreeSet<String> = candidates
            .iter()
            .flat_map(|head| self.ancestors(head))
            .collect();
        candidates.difference(&covered).cloned().collect()
    }

    /// Recorded history of a bundle, following bases present in the folder.
    fn ancestors(&self, content: &str) -> Vec<String> {
        let mut found = Vec::new();
        let mut next = self
            .bundles
            .get(content)
            .and_then(|bundle| bundle.base_sha256.clone());
        while let Some(base) = next {
            if found.contains(&base) || found.len() >= MAX_BUNDLES {
                break;
            }
            next = self
                .bundles
                .get(&base)
                .and_then(|bundle| bundle.base_sha256.clone());
            found.push(base);
        }
        found
    }
}

/// The selected folder must already exist: Portcove never creates the player's
/// chosen location, so an unplugged drive or unmounted share reads as offline.
fn port_directory(folder: &Path, port_id: &str) -> Result<PathBuf> {
    crate::path::refuse_symlink_ancestors(folder)?;
    match fs::symlink_metadata(folder) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(PortcoveError::conflict(
                "The selected save folder is not a folder.",
            ));
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            return Err(PortcoveError::not_found(
                "The selected save folder is not available. Connect it and try again; saves on this device are unchanged.",
            )
            .detail("folder", folder.display().to_string()));
        }
        Err(error) => return Err(error.into()),
    }
    Ok(folder
        .join(FOLDER_ROOT)
        .join(FORMAT_DIRECTORY)
        .join(port_id))
}

/// Read up to `MAX_DIRECTORY_ENTRIES` names; `None` when the limit was hit.
fn bounded_names(directory: &Path) -> Result<Option<Vec<String>>> {
    crate::path::refuse_symlink_ancestors(directory)?;
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(PortcoveError::conflict(format!(
                "A save-folder location is not a folder: {}",
                directory.display()
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Some(Vec::new())),
        Err(error) => return Err(error.into()),
    }
    let mut names = Vec::new();
    for (index, entry) in fs::read_dir(directory)?.enumerate() {
        if index >= MAX_DIRECTORY_ENTRIES {
            return Ok(None);
        }
        if let Some(name) = entry?.file_name().to_str() {
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(Some(names))
}

fn scan(folder: &Path, port_id: &str) -> Result<FolderScan> {
    let directory = port_directory(folder, port_id)?;
    let mut result = FolderScan {
        directory: directory.clone(),
        bundles: BTreeMap::new(),
        superseded: BTreeSet::new(),
        problems: Vec::new(),
        complete: true,
    };
    let Some(names) = bounded_names(&directory)? else {
        result.complete = false;
        result
            .problems
            .push("The save folder holds more files than Portcove reviews.".into());
        return Ok(result);
    };
    // Only names that can be bundles count toward the bundle limit; temporary
    // files from interrupted copies and unrelated files are not bundles.
    let candidates: Vec<&String> = names
        .iter()
        .filter(|name| digest_name(name).is_some())
        .collect();
    if candidates.len() > MAX_BUNDLES {
        result.complete = false;
        result.problems.push(format!(
            "The save folder holds more than {MAX_BUNDLES} saves files for this game; Portcove cannot review its history."
        ));
        return Ok(result);
    }
    let mut decoded = 0_u64;
    for name in candidates {
        let digest = digest_name(name).unwrap_or_default();
        let path = directory.join(name);
        decoded += fs::symlink_metadata(&path).map_or(0, |metadata| metadata.len());
        if decoded > MAX_SCAN_BYTES {
            result.complete = false;
            result
                .problems
                .push("The saves files in the folder are too large to review together.".into());
            return Ok(result);
        }
        match portable_saves::read_bundle(&path) {
            Ok(bundle) if bundle.content_sha256 == digest && bundle.identity.port_id == port_id => {
                let Bundle {
                    identity,
                    content_sha256,
                    base_sha256,
                    files,
                    ..
                } = bundle;
                result.bundles.insert(
                    content_sha256.clone(),
                    Summary {
                        identity,
                        content_sha256,
                        base_sha256,
                        files,
                    },
                );
            }
            Ok(_) => result
                .problems
                .push(format!("{name} does not match its name and was ignored.")),
            Err(error) => result.problems.push(format!(
                "{name} could not be used and was ignored: {}",
                error.message
            )),
        }
    }
    match bounded_names(&directory.join(SUPERSEDED))? {
        Some(markers) => {
            let markers: Vec<String> = markers
                .into_iter()
                .filter(|name| valid_digest(name))
                .collect();
            if markers.len() > MAX_BUNDLES {
                result.complete = false;
                result.problems.push(
                    "The save folder holds more set-aside records than Portcove reviews.".into(),
                );
            }
            result.superseded.extend(markers);
        }
        None => {
            result.complete = false;
            result
                .problems
                .push("The save folder holds more set-aside records than Portcove reviews.".into());
        }
    }
    Ok(result)
}

impl PortcoveService {
    fn require_folder_outside_library(&self, folder: &Path) -> Result<()> {
        if fs::canonicalize(folder)?.starts_with(fs::canonicalize(self.library.root())?) {
            return Err(PortcoveError::usage(
                "Choose a save folder outside the Portcove library folder.",
            ));
        }
        Ok(())
    }

    /// Read-only state of this game's saves in a selected folder. An unavailable
    /// folder is a normal offline answer, not an error.
    pub fn save_folder_status(&self, port_id: &str, folder: &Path) -> Result<SaveFolderStatus> {
        let export = self.preview_portable_save_export(port_id)?;
        let local = export.content_sha256.clone();
        let unavailable = || SaveFolderStatus {
            port_id: port_id.into(),
            folder: folder.to_path_buf(),
            available: false,
            complete: false,
            local_content_sha256: local.clone(),
            local_published: false,
            local_set_aside: false,
            entries: Vec::new(),
            problems: Vec::new(),
            next_step: SaveFolderNextStep::Unavailable,
        };
        let scan = match scan(folder, port_id) {
            Ok(scan) => scan,
            Err(error) if error.code == crate::ErrorCode::NotFound => return Ok(unavailable()),
            Err(error) => return Err(error),
        };
        let heads = scan.heads();
        // Content this device's progress already descends from: its last
        // synchronization point and that point's recorded history.
        let mut contained: BTreeSet<String> = BTreeSet::new();
        if let Some(lineage) = self.portable_lineage(port_id) {
            contained.extend(scan.ancestors(&lineage));
            contained.insert(lineage);
        }
        let contract = portable_saves::contract_for(port_id);
        let local_version = export
            .identity
            .as_ref()
            .map(|identity| identity.version.clone());
        let mut entries = Vec::new();
        for bundle in scan.bundles.values() {
            let ancestors = scan.ancestors(&bundle.content_sha256);
            let relation = match &local {
                None => PortableSaveRelation::NoLocalProgress,
                Some(current) if *current == bundle.content_sha256 => {
                    PortableSaveRelation::AlreadyCurrent
                }
                Some(current)
                    if bundle.base_sha256.as_ref() == Some(current)
                        || ancestors.contains(current) =>
                {
                    PortableSaveRelation::Continues
                }
                Some(_) => PortableSaveRelation::Diverged,
            };
            let compatible = contract.is_some_and(|contract| {
                contract
                    .versions
                    .contains(&bundle.identity.version.as_str())
                    && contract.platforms.contains(&bundle.identity.platform)
            }) && local_version.as_ref() == Some(&bundle.identity.version);
            entries.push(SaveFolderEntry {
                content_sha256: bundle.content_sha256.clone(),
                base_sha256: bundle.base_sha256.clone(),
                source: bundle.identity.clone(),
                files: bundle.files.clone(),
                head: heads.contains(&bundle.content_sha256),
                superseded: scan.superseded.contains(&bundle.content_sha256),
                already_included_here: local.is_some()
                    && contained.contains(&bundle.content_sha256),
                compatible,
                relation,
            });
        }
        entries.sort_by_key(|entry| (!entry.head, entry.content_sha256.clone()));
        let local_published = local
            .as_ref()
            .is_some_and(|content| scan.bundles.contains_key(content));
        let local_set_aside = local
            .as_ref()
            .is_some_and(|content| scan.superseded.contains(content));
        let incoming: Vec<&SaveFolderEntry> = entries
            .iter()
            .filter(|entry| {
                entry.head
                    && entry.compatible
                    && !entry.already_included_here
                    && entry.relation != PortableSaveRelation::AlreadyCurrent
            })
            .collect();
        let blocked = export
            .blockers
            .iter()
            .any(|blocker| *blocker != crate::PortableSaveBlocker::NoPortableProgress);
        let next_step = match incoming.as_slice() {
            _ if blocked => SaveFolderNextStep::Blocked,
            _ if !scan.complete => SaveFolderNextStep::Incomplete,
            // This device's progress was set aside elsewhere: never report it
            // as settled, even when no other branch is currently offered.
            _ if local_set_aside => SaveFolderNextStep::ChooseProgress,
            [] if local.is_some() && !local_published => SaveFolderNextStep::Push,
            [] => SaveFolderNextStep::UpToDate,
            [single]
                if matches!(
                    single.relation,
                    PortableSaveRelation::Continues | PortableSaveRelation::NoLocalProgress
                ) =>
            {
                SaveFolderNextStep::Pull
            }
            _ => SaveFolderNextStep::ChooseProgress,
        };
        Ok(SaveFolderStatus {
            port_id: port_id.into(),
            folder: folder.to_path_buf(),
            available: true,
            complete: scan.complete,
            local_content_sha256: local,
            local_published,
            local_set_aside,
            entries,
            problems: scan.problems,
            next_step,
        })
    }

    /// Publish this device's reviewed progress to the folder. Retrying the same
    /// content is idempotent; nothing in the folder is overwritten or deleted.
    pub fn push_portable_saves_to_folder(
        &self,
        port_id: &str,
        folder: &Path,
        expected_content_sha256: &str,
    ) -> Result<SaveFolderPushResult> {
        let directory = port_directory(folder, port_id)?;
        self.require_folder_outside_library(folder)?;
        let already_present = std::cell::Cell::new(false);
        let matches = |destination: &Path, content: &str| -> Result<bool> {
            match portable_saves::read_bundle(destination) {
                Ok(existing) if existing.content_sha256 == content => Ok(true),
                Ok(_) => Err(PortcoveError::conflict(
                    "A different file already uses this save's name in the folder. It was left unchanged.",
                )),
                Err(error) if error.code == crate::ErrorCode::NotFound => Ok(false),
                // A damaged leftover is preserved for inspection, never replaced.
                Err(error) => Err(error),
            }
        };
        let result = self.export_portable_saves_with(
            port_id,
            expected_content_sha256,
            &|encoded, content| {
                crate::path::refuse_symlink_ancestors(&directory)?;
                fs::create_dir_all(&directory)?;
                crate::path::refuse_symlink_ancestors(&directory)?;
                let destination = directory.join(format!("{content}.json"));
                if matches(&destination, content)? {
                    already_present.set(true);
                    return Ok(destination);
                }
                if let Err(error) =
                    crate::durability::write_bytes_atomically(&destination, encoded, false)
                {
                    // Another device or sync tool may have delivered the same
                    // saves at the same moment; identical content is success.
                    if matches(&destination, content).unwrap_or(false) {
                        already_present.set(true);
                        return Ok(destination);
                    }
                    return Err(error);
                }
                Ok(destination)
            },
        )?;
        Ok(SaveFolderPushResult {
            content_sha256: result.content_sha256,
            base_sha256: result.base_sha256,
            path: result.path,
            already_present: already_present.get(),
        })
    }

    /// The selected bundle, fully read and verified, with its recorded history.
    fn folder_bundle(
        &self,
        port_id: &str,
        folder: &Path,
        content_sha256: &str,
    ) -> Result<(Bundle, Vec<String>)> {
        if !valid_digest(content_sha256) {
            return Err(PortcoveError::usage(
                "select saves by their 64-character content SHA-256",
            ));
        }
        port_directory(folder, port_id)?;
        self.require_folder_outside_library(folder)?;
        let scan = scan(folder, port_id)?;
        if !scan.complete {
            return Err(PortcoveError::conflict(
                "Portcove cannot review this save folder's history completely. Import the saves file directly instead.",
            ));
        }
        if !scan.bundles.contains_key(content_sha256) {
            return Err(PortcoveError::not_found(
                "Those saves are no longer in the selected folder.",
            ));
        }
        let bundle =
            portable_saves::read_bundle(&scan.directory.join(format!("{content_sha256}.json")))?;
        if bundle.content_sha256 != content_sha256 || bundle.identity.port_id != port_id {
            return Err(PortcoveError::conflict(
                "The saves file changed in the folder. Review again.",
            ));
        }
        Ok((bundle, scan.ancestors(content_sha256)))
    }

    /// Review importing one set of saves from the folder. Its recorded history in
    /// the folder lets progress that continued on another device apply without a
    /// conflict choice; anything else follows the ordinary import review.
    pub fn preview_folder_save_import(
        &self,
        port_id: &str,
        folder: &Path,
        content_sha256: &str,
        options: PortableSaveImportOptions,
    ) -> Result<PortableSaveImportPreview> {
        let (bundle, ancestors) = self.folder_bundle(port_id, folder, content_sha256)?;
        self.preview_bundle_import(port_id, &bundle, &ancestors, options)
    }

    pub fn authorize_folder_save_import(
        &self,
        port_id: &str,
        folder: &Path,
        content_sha256: &str,
        options: PortableSaveImportOptions,
        expected_preview_sha256: &str,
    ) -> Result<DestructiveAuthorization> {
        let (bundle, ancestors) = self.folder_bundle(port_id, folder, content_sha256)?;
        self.authorize_bundle_import(
            port_id,
            &bundle,
            &ancestors,
            options,
            expected_preview_sha256,
        )
    }

    /// Apply reviewed saves from the folder. When this replaced or removed saves
    /// on this device, the branch this device had published is set aside so it is
    /// not offered again; its file stays in the folder and in the safety backup,
    /// and remains importable.
    pub fn import_folder_saves(
        &self,
        port_id: &str,
        folder: &Path,
        content_sha256: &str,
        options: PortableSaveImportOptions,
        authorization_token: &str,
    ) -> Result<PortableSaveImportResult> {
        let (bundle, ancestors) = self.folder_bundle(port_id, folder, content_sha256)?;
        let review = self.preview_bundle_import(port_id, &bundle, &ancestors, options)?;
        let replaced_local = review.changes.iter().any(|change| {
            matches!(
                change.effect,
                PortableSaveFileEffect::Replace | PortableSaveFileEffect::Remove
            )
        }) && review.relation == PortableSaveRelation::Diverged;
        // This device's own branch: its current saves or its last published point.
        let own_branch: Vec<String> = [
            review.local_content_sha256.clone(),
            self.portable_lineage(port_id),
        ]
        .into_iter()
        .flatten()
        .filter(|content| *content != bundle.content_sha256 && !ancestors.contains(content))
        .collect();
        let result =
            self.import_bundle(port_id, &bundle, &ancestors, options, authorization_token)?;
        if replaced_local && let Ok(scan) = scan(folder, port_id) {
            let heads = scan.heads();
            for previous in own_branch {
                if heads.contains(&previous) {
                    // Best effort: the import already succeeded. A missing marker
                    // only means the same choice may be offered again.
                    let _ = self.write_superseded_marker(&scan.directory, &previous);
                }
            }
        }
        Ok(result)
    }

    fn write_superseded_marker(&self, directory: &Path, content_sha256: &str) -> Result<()> {
        let markers = directory.join(SUPERSEDED);
        crate::path::refuse_symlink_ancestors(&markers)?;
        fs::create_dir_all(&markers)?;
        crate::path::refuse_symlink_ancestors(&markers)?;
        let marker = markers.join(content_sha256);
        if fs::symlink_metadata(&marker).is_ok() {
            return Ok(());
        }
        match crate::durability::write_bytes_atomically(&marker, b"", false) {
            // Recorded concurrently by another device: the outcome is the same.
            Err(_) if fs::symlink_metadata(&marker).is_ok() => Ok(()),
            other => other,
        }
    }

    /// Record that one set of saves in the folder should no longer be offered,
    /// for example after keeping this device's progress instead. The saves file
    /// itself is kept and can still be imported explicitly.
    pub fn mark_folder_saves_superseded(
        &self,
        port_id: &str,
        folder: &Path,
        content_sha256: &str,
    ) -> Result<()> {
        self.catalog.port(port_id)?;
        port_directory(folder, port_id)?;
        self.require_folder_outside_library(folder)?;
        let scan = scan(folder, port_id)?;
        if !scan.bundles.contains_key(content_sha256) {
            return Err(PortcoveError::not_found(
                "Those saves are not in the selected folder.",
            ));
        }
        if self
            .preview_portable_save_export(port_id)?
            .content_sha256
            .as_deref()
            == Some(content_sha256)
        {
            return Err(PortcoveError::conflict(
                "These are this device's current saves; they cannot be set aside here.",
            ));
        }
        self.write_superseded_marker(&scan.directory, content_sha256)
    }
}
