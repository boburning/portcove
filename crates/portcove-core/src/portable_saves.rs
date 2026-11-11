//! Portable-save contracts, classification and the bounded bundle format.
//!
//! A portable-save contract is a finite, evidence-bound statement that named
//! files in one game's canonical player-data root are portable progress for an
//! exact version on named platforms. Everything else in that root keeps its
//! local role: device configuration, mods, generated content, data derived from
//! the player's originals, Portcove metadata and unknown entries never move.
//! This module reads and encodes; the service owns locking, review, consent and
//! publication through the existing backup and restore lifecycle.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Platform, PortcoveError, Result};

/// Portcove's own lineage record inside the canonical player-data root. It
/// travels with that data through backup and restore, so a restored snapshot
/// also restores the synchronization point its progress descended from.
pub(crate) const LINEAGE_FILE: &str = "portcove-portable-saves.json";
const BUNDLE_FORMAT: &str = "portcove-portable-saves";
const LINEAGE_FORMAT: &str = "portcove-portable-save-lineage";
/// Bounds keep review and decoding finite. One Shipwright save is far smaller.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 64;
pub(crate) const MAX_BUNDLE_BYTES: u64 = 2 * (MAX_FILE_BYTES * 4) + 1024 * 1024;
const MAX_LINEAGE_BYTES: u64 = 64 * 1024;

/// Role of one entry in a canonical player-data root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PersistentDataRole {
    /// Game progress qualified to move under this exact contract.
    PortableProgress,
    /// Settings, controls, window layout or other per-device choices.
    DeviceConfiguration,
    Mods,
    /// Logs, generated seeds or other data the game recreates.
    GeneratedContent,
    /// Data derived from the player's own original files; never exported.
    OriginalDerived,
    /// Player data that is not qualified to move under this contract.
    LocalPlayerData,
    /// Portcove's own synchronization record.
    PortcoveMetadata,
    /// Not classified; it stays on this device and is shown for review.
    Unknown,
}

#[derive(Debug, Clone, Copy)]
enum Rule {
    Role(PersistentDataRole),
    /// A directory whose direct children are classified by exact name. Any
    /// other child, and any nested directory, is unknown.
    Directory(&'static [(&'static str, PersistentDataRole)]),
}

/// One finite reviewed contract. The registry is intentionally small and
/// explicit: a new family, version or platform needs its own evidence.
#[derive(Debug)]
pub(crate) struct PortableSaveContract {
    pub(crate) id: &'static str,
    pub(crate) port_id: &'static str,
    pub(crate) versions: &'static [&'static str],
    pub(crate) platforms: &'static [Platform],
    entries: &'static [(&'static str, Rule)],
}

use PersistentDataRole as R;

/// Shipwright 9.3.1 writes `Save/file<N>.sav` (N = 1..3) through its
/// SaveManager as JSON, beside `Save/global.sav` file-select options. Linux uses
/// the canonical root as `SHIP_HOME`; the qualified Windows package's working
/// directory is collected into the same canonical coordinates. Upstream source:
/// HarbourMasters/Shipwright f0599f96 `soh/soh/SaveManager.cpp`.
const SHIPWRIGHT_SAVE_DIRECTORY: &[(&str, PersistentDataRole)] = &[
    ("file1.sav", R::PortableProgress),
    ("file2.sav", R::PortableProgress),
    ("file3.sav", R::PortableProgress),
    ("global.sav", R::DeviceConfiguration),
];

const CONTRACTS: &[PortableSaveContract] = &[PortableSaveContract {
    id: "shipwright-save-files-v1",
    port_id: "shipwright",
    versions: &["9.3.1"],
    platforms: &[Platform::WindowsX86_64, Platform::LinuxX86_64],
    entries: &[
        ("Save", Rule::Directory(SHIPWRIGHT_SAVE_DIRECTORY)),
        ("saves", Rule::Role(R::LocalPlayerData)),
        ("SoHTimeSplitData.json", Rule::Role(R::LocalPlayerData)),
        ("shipofharkinian.json", Rule::Role(R::DeviceConfiguration)),
        ("imgui.ini", Rule::Role(R::DeviceConfiguration)),
        ("mods", Rule::Role(R::Mods)),
        ("randomizer", Rule::Role(R::GeneratedContent)),
        ("logs", Rule::Role(R::GeneratedContent)),
        ("oot.o2r", Rule::Role(R::OriginalDerived)),
        ("oot-mq.o2r", Rule::Role(R::OriginalDerived)),
        (LINEAGE_FILE, Rule::Role(R::PortcoveMetadata)),
    ],
}];

pub(crate) fn contract_for(port_id: &str) -> Option<&'static PortableSaveContract> {
    CONTRACTS
        .iter()
        .find(|contract| contract.port_id == port_id)
}

impl PortableSaveContract {
    fn portable_path(&self, relative: &str) -> bool {
        let mut parts = relative.split('/');
        let (Some(first), second, None) = (parts.next(), parts.next(), parts.next()) else {
            return false;
        };
        self.entries.iter().any(|(name, rule)| {
            *name == first
                && match (rule, second) {
                    (Rule::Role(role), None) => *role == R::PortableProgress,
                    (Rule::Directory(children), Some(child)) => children
                        .iter()
                        .any(|(name, role)| *name == child && *role == R::PortableProgress),
                    _ => false,
                }
        })
    }
}

/// Exact identity of one side of a portable-save transfer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortableSaveIdentity {
    pub port_id: String,
    pub contract_id: String,
    /// Installed game version that produced or will read the progress.
    pub version: String,
    pub platform: Platform,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortableSaveFile {
    /// Relative path inside the game's player-data folder, `/` separated.
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// An entry that stays on this device, with the reason it does not move.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LocalDataEntry {
    pub path: String,
    pub role: PersistentDataRole,
    pub directory: bool,
}

/// Classified state of one canonical player-data root.
#[derive(Debug, Clone, Default)]
pub(crate) struct Classification {
    pub(crate) portable: Vec<PortableSaveFile>,
    pub(crate) local: Vec<LocalDataEntry>,
}

impl Classification {
    pub(crate) fn content_sha256(&self) -> Option<String> {
        content_sha256(&self.portable)
    }
}

/// Digest of the portable set alone: names, sizes and bytes, never timestamps.
pub(crate) fn content_sha256(files: &[PortableSaveFile]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let mut sorted = files.to_vec();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut hasher = Sha256::new();
    for file in sorted {
        hasher.update(file.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(file.size.to_le_bytes());
        hasher.update(file.sha256.as_bytes());
        hasher.update(b"\n");
    }
    Some(hex::encode(hasher.finalize()))
}

fn regular_file(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(PortcoveError::conflict(format!(
            "player data contains a link; preserve it and review it before moving saves: {}",
            path.display()
        ))),
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_portable(root: &Path, relative: &str) -> Result<(PortableSaveFile, Vec<u8>)> {
    use std::io::Read;
    // Open through the identity-checked, no-follow path: a link swapped in
    // after classification is refused instead of read.
    let path = fs::canonicalize(root)?.join(relative);
    let file = crate::external_runtime::open_object(&path, false).map_err(|error| {
        if matches!(
            error.code,
            crate::ErrorCode::Conflict | crate::ErrorCode::Verification
        ) {
            changed()
        } else {
            error
        }
    })?;
    // A hard link would let a file outside the save folder be exported.
    if crate::external_runtime::link_count(&file)? != 1 {
        return Err(PortcoveError::conflict(format!(
            "A save file is also linked from somewhere else, so Portcove will not move it: {relative}"
        )));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(PortcoveError::unsupported(format!(
            "A save is larger than Portcove can move ({} MiB): {relative}",
            MAX_FILE_BYTES / (1024 * 1024)
        )));
    }
    Ok((
        PortableSaveFile {
            path: relative.into(),
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(&bytes)),
        },
        bytes,
    ))
}

fn changed() -> PortcoveError {
    PortcoveError::conflict(
        "The game's saves changed while Portcove was reading them. Close the game and review again.",
    )
}

/// On case-insensitive file systems a differently spelled name is the same
/// file the game reads, so it can be neither left as unknown nor overwritten.
fn refuse_case_variant(name: &str, declared: &[&str], directory: &Path) -> Result<()> {
    if declared
        .iter()
        .any(|expected| *expected != name && expected.eq_ignore_ascii_case(name))
    {
        return Err(PortcoveError::conflict(format!(
            "A save file or folder uses different capital letters than the game expects ({name}). Rename or remove it, then review again.",
        ))
        .detail("directory", directory.display().to_string()));
    }
    Ok(())
}

/// Classify the root's direct entries and the contract's named directories.
/// Links fail closed. Directory contents other than named files are unknown and
/// are reported, never traversed into the portable set.
pub(crate) fn classify(
    contract: &PortableSaveContract,
    root: &Path,
) -> Result<(Classification, BTreeMap<String, Vec<u8>>)> {
    crate::path::refuse_symlink_ancestors(root)?;
    let mut result = Classification::default();
    let mut bytes = BTreeMap::new();
    let Some(metadata) = regular_file(root)? else {
        return Ok((result, bytes));
    };
    if !metadata.is_dir() {
        return Err(PortcoveError::conflict(format!(
            "persistent data root is not a directory: {}",
            root.display()
        )));
    }
    let mut names = sorted_names(root)?;
    names.sort();
    for name in names {
        let path = root.join(&name);
        let top: Vec<&str> = contract.entries.iter().map(|(name, _)| *name).collect();
        refuse_case_variant(&name, &top, root)?;
        let metadata = regular_file(&path)?.ok_or_else(changed)?;
        let rule = contract
            .entries
            .iter()
            .find(|(declared, _)| *declared == name)
            .map(|(_, rule)| *rule);
        match rule {
            Some(Rule::Directory(children)) if metadata.is_dir() => {
                for child in sorted_names(&path)? {
                    let relative = format!("{name}/{child}");
                    let names: Vec<&str> = children.iter().map(|(name, _)| *name).collect();
                    refuse_case_variant(&child, &names, &path)?;
                    let child_metadata = regular_file(&path.join(&child))?.ok_or_else(changed)?;
                    let role = children
                        .iter()
                        .find(|(declared, _)| *declared == child)
                        .map_or(R::Unknown, |(_, role)| *role);
                    if role == R::PortableProgress && child_metadata.is_file() {
                        let (file, content) = read_portable(root, &relative)?;
                        bytes.insert(relative, content);
                        result.portable.push(file);
                    } else {
                        result.local.push(LocalDataEntry {
                            path: relative,
                            role: if role == R::PortableProgress {
                                R::Unknown
                            } else {
                                role
                            },
                            directory: child_metadata.is_dir(),
                        });
                    }
                }
            }
            Some(Rule::Role(R::PortableProgress)) if metadata.is_file() => {
                let (file, content) = read_portable(root, &name)?;
                bytes.insert(name, content);
                result.portable.push(file);
            }
            Some(Rule::Role(role)) if role != R::PortableProgress => {
                result.local.push(LocalDataEntry {
                    path: name,
                    role,
                    directory: metadata.is_dir(),
                });
            }
            _ => result.local.push(LocalDataEntry {
                path: name,
                role: R::Unknown,
                directory: metadata.is_dir(),
            }),
        }
    }
    if result.portable.len() > MAX_FILES {
        return Err(PortcoveError::unsupported(
            "too many portable save files to review",
        ));
    }
    Ok((result, bytes))
}

fn sorted_names(directory: &Path) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| {
            PortcoveError::unsupported("player data contains a name that is not valid Unicode")
                .detail("directory", directory.display().to_string())
        })?;
        names.push(name);
    }
    names.sort();
    Ok(names)
}

/// Portable bundle document. File bytes are hex encoded so import never
/// extracts an archive, follows a link or interprets a path outside the
/// contract's exact named files.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleDocument {
    format: String,
    format_version: u32,
    identity: PortableSaveIdentity,
    content_sha256: String,
    /// The portable content this progress last synchronized from, if known.
    base_sha256: Option<String>,
    files: Vec<BundleFile>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleFile {
    path: String,
    size: u64,
    sha256: String,
    data_hex: String,
}

/// A decoded, fully verified bundle.
#[derive(Debug, Clone)]
pub(crate) struct Bundle {
    pub(crate) identity: PortableSaveIdentity,
    pub(crate) content_sha256: String,
    pub(crate) base_sha256: Option<String>,
    pub(crate) files: Vec<PortableSaveFile>,
    pub(crate) bytes: BTreeMap<String, Vec<u8>>,
    /// Digest of the exact document bytes the review read.
    pub(crate) document_sha256: String,
}

pub(crate) fn encode_bundle(
    identity: &PortableSaveIdentity,
    files: &[PortableSaveFile],
    bytes: &BTreeMap<String, Vec<u8>>,
    base_sha256: Option<String>,
) -> Result<Vec<u8>> {
    let content_sha256 = content_sha256(files)
        .ok_or_else(|| PortcoveError::not_found("there is no portable progress to export"))?;
    let document = BundleDocument {
        format: BUNDLE_FORMAT.into(),
        format_version: 1,
        identity: identity.clone(),
        content_sha256,
        base_sha256,
        files: files
            .iter()
            .map(|file| BundleFile {
                path: file.path.clone(),
                size: file.size,
                sha256: file.sha256.clone(),
                data_hex: hex::encode(&bytes[&file.path]),
            })
            .collect(),
    };
    let mut encoded = serde_json::to_vec_pretty(&document)?;
    encoded.push(b'\n');
    Ok(encoded)
}

fn invalid(message: impl Into<String>) -> PortcoveError {
    PortcoveError::verification(message).detail("input_role", "portable save bundle")
}

pub(crate) fn read_bundle(path: &Path) -> Result<Bundle> {
    crate::path::refuse_symlink_ancestors(path)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Err(invalid(
                "the selected portable save file is not a regular file",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(PortcoveError::not_found(format!(
                "portable save file not found: {}",
                path.display()
            )));
        }
        Err(error) => return Err(error.into()),
    }
    let raw = crate::path::read_bounded_regular(path, MAX_BUNDLE_BYTES)?;
    decode_bundle(&raw)
}

pub(crate) fn decode_bundle(raw: &[u8]) -> Result<Bundle> {
    let document: BundleDocument = serde_json::from_slice(raw).map_err(|error| {
        invalid(format!(
            "this is not a readable Portcove save file: {error}"
        ))
    })?;
    if document.format != BUNDLE_FORMAT {
        return Err(invalid("this is not a Portcove portable save file"));
    }
    if document.format_version != 1 {
        return Err(PortcoveError::unsupported(
            "this portable save file was made by a newer Portcove; update Portcove to read it",
        ));
    }
    let contract = contract_for(&document.identity.port_id)
        .filter(|contract| contract.id == document.identity.contract_id)
        .ok_or_else(|| {
            PortcoveError::unsupported(
                "this portable save file uses a save contract this Portcove does not support",
            )
            .detail("contract_id", document.identity.contract_id.clone())
        })?;
    if document.files.is_empty() || document.files.len() > MAX_FILES {
        return Err(invalid("the portable save file has no usable save list"));
    }
    let mut files = Vec::new();
    let mut bytes = BTreeMap::new();
    for file in document.files {
        if !contract.portable_path(&file.path) {
            return Err(invalid(format!(
                "the portable save file names a file outside its save contract: {}",
                file.path
            )));
        }
        if bytes.contains_key(&file.path) {
            return Err(invalid("the portable save file lists one save twice"));
        }
        if file.size > MAX_FILE_BYTES {
            return Err(invalid("a save in the portable save file is too large"));
        }
        let content = hex::decode(&file.data_hex)
            .map_err(|_| invalid("a save in the portable save file is damaged"))?;
        if content.len() as u64 != file.size || hex::encode(Sha256::digest(&content)) != file.sha256
        {
            return Err(invalid(format!(
                "a save in the portable save file does not match its checksum: {}",
                file.path
            )));
        }
        files.push(PortableSaveFile {
            path: file.path.clone(),
            size: file.size,
            sha256: file.sha256,
        });
        bytes.insert(file.path, content);
    }
    if content_sha256(&files).as_deref() != Some(document.content_sha256.as_str()) {
        return Err(invalid(
            "the portable save file's content checksum does not match",
        ));
    }
    for digest in std::iter::once(&document.content_sha256).chain(document.base_sha256.iter()) {
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid("the portable save file has a malformed checksum"));
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Bundle {
        identity: document.identity,
        content_sha256: document.content_sha256,
        base_sha256: document.base_sha256,
        files,
        bytes,
        document_sha256: hex::encode(Sha256::digest(raw)),
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LineageDocument {
    format: String,
    format_version: u32,
    contract_id: String,
    last_synchronized_sha256: String,
}

/// Read the root's last synchronized portable content. A damaged or foreign
/// record is treated as unknown lineage, which can only make review stricter.
pub(crate) fn read_lineage(contract: &PortableSaveContract, root: &Path) -> Option<String> {
    let path = root.join(LINEAGE_FILE);
    let raw = crate::path::read_bounded_regular(&path, MAX_LINEAGE_BYTES).ok()?;
    let document: LineageDocument = serde_json::from_slice(&raw).ok()?;
    (document.format == LINEAGE_FORMAT
        && document.format_version == 1
        && document.contract_id == contract.id)
        .then_some(document.last_synchronized_sha256)
}

pub(crate) fn lineage_bytes(
    contract: &PortableSaveContract,
    content_sha256: &str,
) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(&LineageDocument {
        format: LINEAGE_FORMAT.into(),
        format_version: 1,
        contract_id: contract.id.into(),
        last_synchronized_sha256: content_sha256.into(),
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Apply reviewed portable content to a private copy of the player-data root.
/// Only exact contract paths are written or removed; nothing else changes.
pub(crate) fn apply_to_copy(
    contract: &PortableSaveContract,
    copy: &Path,
    bundle: &Bundle,
    remove: &[String],
) -> Result<()> {
    for file in &bundle.files {
        write_contract_file(contract, copy, &file.path, &bundle.bytes[&file.path])?;
    }
    for relative in remove {
        if !contract.portable_path(relative) {
            return Err(PortcoveError::state(
                "refused to remove a non-portable file",
            ));
        }
        let path = copy.join(relative);
        if regular_file(&path)?.is_some_and(|metadata| metadata.is_file()) {
            fs::remove_file(&path)?;
        }
    }
    let lineage = copy.join(LINEAGE_FILE);
    if regular_file(&lineage)?.is_some_and(|metadata| !metadata.is_file()) {
        return Err(PortcoveError::conflict(
            "Portcove's save synchronization record is not a file; preserve it and review it",
        ));
    }
    fs::write(lineage, lineage_bytes(contract, &bundle.content_sha256)?)?;
    Ok(())
}

fn write_contract_file(
    contract: &PortableSaveContract,
    root: &Path,
    relative: &str,
    bytes: &[u8],
) -> Result<()> {
    if !contract.portable_path(relative) {
        return Err(PortcoveError::state("refused to write a non-portable file"));
    }
    let path: PathBuf = relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part));
    if let Some(parent) = path.parent() {
        match regular_file(parent)? {
            Some(metadata) if !metadata.is_dir() => {
                return Err(PortcoveError::conflict(format!(
                    "a save folder is not a directory: {}",
                    parent.display()
                )));
            }
            Some(_) => {}
            None => fs::create_dir_all(parent)?,
        }
    }
    if regular_file(&path)?.is_some_and(|metadata| !metadata.is_file()) {
        return Err(PortcoveError::conflict(format!(
            "a save path is not a regular file: {}",
            path.display()
        )));
    }
    fs::write(path, bytes)?;
    Ok(())
}

/// Why an export or import cannot proceed as reviewed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PortableSaveBlocker {
    /// No reviewed portable-save contract exists for this game.
    Unqualified,
    /// No active Portcove-managed installation identifies the game version.
    NotInstalled,
    /// The installed or exported version is outside the reviewed contract.
    UnsupportedVersion,
    /// This device's platform is outside the reviewed contract.
    UnsupportedPlatform,
    /// Source and destination versions differ; cross-version saves are not claimed.
    VersionMismatch,
    /// The file belongs to a different game.
    DifferentGame,
    /// The game is running or another operation holds this game.
    Busy,
    /// There is no portable progress to export.
    NoPortableProgress,
    /// Local and incoming progress both changed; choose explicitly.
    ConflictNeedsChoice,
    /// This device already has exactly this progress.
    AlreadyCurrent,
}

/// How incoming progress relates to this device's progress, by content only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PortableSaveRelation {
    NoLocalProgress,
    AlreadyCurrent,
    /// The incoming progress continued from exactly what this device has.
    Continues,
    /// Both sides changed, or their history is unknown. Timestamps never decide.
    Diverged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PortableSaveFileEffect {
    Add,
    Replace,
    Unchanged,
    /// Absent from the incoming progress and explicitly chosen for removal.
    Remove,
    /// Absent from the incoming progress and kept on this device.
    KeepLocal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortableSaveFileChange {
    pub path: String,
    pub effect: PortableSaveFileEffect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incoming: Option<PortableSaveFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<PortableSaveFile>,
}

/// Explicit player choices bound into the reviewed import.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortableSaveImportOptions {
    /// Remove local save slots that are absent from the incoming progress.
    #[serde(default)]
    pub remove_local_only_saves: bool,
    /// Replace diverged local progress. Local progress is still kept in the
    /// safety backup and the incoming progress in its own snapshot.
    #[serde(default)]
    pub replace_diverged_progress: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortableSaveExportPreview {
    pub port_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<PortableSaveIdentity>,
    /// Exactly the files the export would contain.
    pub files: Vec<PortableSaveFile>,
    /// Everything else in the game's player-data folder, which stays here.
    pub stays_local: Vec<LocalDataEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_sha256: Option<String>,
    pub blockers: Vec<PortableSaveBlocker>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortableSaveExportResult {
    pub path: PathBuf,
    pub identity: PortableSaveIdentity,
    pub files: Vec<PortableSaveFile>,
    pub content_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortableSaveImportPreview {
    pub port_id: String,
    pub source: PortableSaveIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<PortableSaveIdentity>,
    pub relation: PortableSaveRelation,
    pub changes: Vec<PortableSaveFileChange>,
    pub stays_local: Vec<LocalDataEntry>,
    pub incoming_content_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_content_sha256: Option<String>,
    pub options: PortableSaveImportOptions,
    /// Current player data is copied to a backup before anything changes.
    pub safety_backup_will_be_created: bool,
    pub blockers: Vec<PortableSaveBlocker>,
    pub preview_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortableSaveImportResult {
    /// Snapshot holding the imported state; restorable like any backup.
    pub import_snapshot: crate::BackupRecord,
    /// Snapshot of this device's data from immediately before the import.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety_backup: Option<crate::BackupRecord>,
    pub content_sha256: String,
}

/// What the player can usefully do next with a selected save folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SaveFolderNextStep {
    /// The folder is not connected; local play and saves are unaffected.
    Unavailable,
    /// Moving saves is not available for this game here (see export blockers).
    Blocked,
    /// The folder holds more than Portcove reviews; its history is unknown.
    Incomplete,
    UpToDate,
    /// This device has progress the folder does not have yet.
    Push,
    /// One newer set of saves continues from this device's progress.
    Pull,
    /// Devices have different progress; the player chooses which to keep.
    ChooseProgress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SaveFolderEntry {
    pub content_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_sha256: Option<String>,
    pub source: PortableSaveIdentity,
    pub files: Vec<PortableSaveFile>,
    /// Latest on its branch: no other saves in the folder continue from it.
    pub head: bool,
    /// Set aside by an explicit choice; still kept and importable.
    pub superseded: bool,
    /// This device's progress already includes these saves.
    pub already_included_here: bool,
    /// Same qualified game version and platform contract as this device.
    pub compatible: bool,
    pub relation: PortableSaveRelation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SaveFolderStatus {
    pub port_id: String,
    pub folder: PathBuf,
    pub available: bool,
    /// False when the folder exceeded review limits; history is then unknown.
    pub complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_content_sha256: Option<String>,
    pub local_published: bool,
    /// Another device set this device's current saves aside.
    pub local_set_aside: bool,
    pub entries: Vec<SaveFolderEntry>,
    /// Files in the folder that were ignored, with the reason.
    pub problems: Vec<String>,
    pub next_step: SaveFolderNextStep,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SaveFolderPushResult {
    pub content_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_sha256: Option<String>,
    pub path: PathBuf,
    /// The same saves were already in the folder; nothing was written.
    pub already_present: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shipwright() -> &'static PortableSaveContract {
        contract_for("shipwright").unwrap()
    }

    #[test]
    fn classification_separates_progress_from_local_data() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        fs::create_dir_all(root.join("Save")).unwrap();
        fs::create_dir_all(root.join("mods")).unwrap();
        fs::write(root.join("Save/file1.sav"), b"{\"progress\":1}").unwrap();
        fs::write(root.join("Save/global.sav"), b"{\"language\":0}").unwrap();
        fs::write(root.join("Save/file1-1700000000.bak"), b"quarantined").unwrap();
        fs::write(root.join("shipofharkinian.json"), b"{}").unwrap();
        fs::write(root.join("oot.o2r"), b"derived from the player's original").unwrap();
        fs::write(root.join("notes.txt"), b"unknown").unwrap();
        let (classification, bytes) = classify(shipwright(), root).unwrap();
        assert_eq!(
            classification
                .portable
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["Save/file1.sav"]
        );
        assert_eq!(bytes["Save/file1.sav"], b"{\"progress\":1}");
        let roles: BTreeMap<_, _> = classification
            .local
            .iter()
            .map(|entry| (entry.path.as_str(), entry.role))
            .collect();
        assert_eq!(roles["Save/global.sav"], R::DeviceConfiguration);
        assert_eq!(roles["Save/file1-1700000000.bak"], R::Unknown);
        assert_eq!(roles["shipofharkinian.json"], R::DeviceConfiguration);
        assert_eq!(roles["oot.o2r"], R::OriginalDerived);
        assert_eq!(roles["mods"], R::Mods);
        assert_eq!(roles["notes.txt"], R::Unknown);
    }

    #[test]
    fn nested_or_misnamed_progress_is_unknown_not_portable() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        fs::create_dir_all(root.join("Save/file2.sav")).unwrap();
        let (classification, _) = classify(shipwright(), root).unwrap();
        assert!(classification.portable.is_empty());
        assert!(
            classification
                .local
                .iter()
                .all(|entry| entry.role == R::Unknown)
        );
        // A differently capitalized name is the same file on Windows: refuse.
        fs::write(root.join("Save/FILE1.SAV"), b"other spelling").unwrap();
        assert_eq!(
            classify(shipwright(), root).unwrap_err().code,
            crate::ErrorCode::Conflict
        );
    }

    #[cfg(unix)]
    #[test]
    fn hard_linked_saves_are_refused() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("user");
        fs::create_dir_all(root.join("Save")).unwrap();
        fs::write(temporary.path().join("elsewhere"), b"outside").unwrap();
        fs::hard_link(
            temporary.path().join("elsewhere"),
            root.join("Save/file1.sav"),
        )
        .unwrap();
        assert_eq!(
            classify(shipwright(), &root).unwrap_err().code,
            crate::ErrorCode::Conflict
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_fail_closed() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("user");
        fs::create_dir_all(root.join("Save")).unwrap();
        fs::write(temporary.path().join("elsewhere"), b"outside").unwrap();
        std::os::unix::fs::symlink(
            temporary.path().join("elsewhere"),
            root.join("Save/file1.sav"),
        )
        .unwrap();
        assert!(classify(shipwright(), &root).is_err());
    }

    fn sample_bundle() -> Vec<u8> {
        let identity = PortableSaveIdentity {
            port_id: "shipwright".into(),
            contract_id: shipwright().id.into(),
            version: "9.3.1".into(),
            platform: Platform::WindowsX86_64,
        };
        let content = b"{\"progress\":2}".to_vec();
        let file = PortableSaveFile {
            path: "Save/file1.sav".into(),
            size: content.len() as u64,
            sha256: hex::encode(Sha256::digest(&content)),
        };
        encode_bundle(
            &identity,
            &[file],
            &BTreeMap::from([("Save/file1.sav".to_owned(), content)]),
            None,
        )
        .unwrap()
    }

    #[test]
    fn bundle_round_trip_verifies_every_file() {
        let raw = sample_bundle();
        let bundle = decode_bundle(&raw).unwrap();
        assert_eq!(bundle.files.len(), 1);
        assert_eq!(bundle.bytes["Save/file1.sav"], b"{\"progress\":2}");
    }

    #[test]
    fn bundle_rejects_tampering_and_paths_outside_the_contract() {
        let raw = String::from_utf8(sample_bundle()).unwrap();
        let tampered = raw.replace(
            &hex::encode(b"{\"progress\":2}"),
            &hex::encode(b"{\"progress\":9}"),
        );
        assert!(decode_bundle(tampered.as_bytes()).is_err());
        for path in [
            "../file1.sav",
            "Save/global.sav",
            "shipofharkinian.json",
            "Save/../x",
        ] {
            let escaped = raw.replace("\"Save/file1.sav\"", &format!("{path:?}"));
            let error = decode_bundle(escaped.as_bytes()).unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification, "{path}");
        }
        let unknown_contract = raw.replace(shipwright().id, "shipwright-save-files-v9");
        assert_eq!(
            decode_bundle(unknown_contract.as_bytes()).unwrap_err().code,
            crate::ErrorCode::Unsupported
        );
    }

    #[test]
    fn content_identity_ignores_order_and_has_no_timestamp() {
        let a = PortableSaveFile {
            path: "Save/file1.sav".into(),
            size: 1,
            sha256: "a".repeat(64),
        };
        let b = PortableSaveFile {
            path: "Save/file2.sav".into(),
            size: 1,
            sha256: "b".repeat(64),
        };
        assert_eq!(
            content_sha256(&[a.clone(), b.clone()]),
            content_sha256(&[b, a])
        );
        assert_eq!(content_sha256(&[]), None);
    }
}
