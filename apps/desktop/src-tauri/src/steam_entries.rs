//! Controlled, profile-scoped Steam shortcut planning and durable publication.
//!
//! Steam documents user-created non-Steam shortcuts, but does not document a
//! supported shortcut-writing API. This module therefore treats the local
//! `shortcuts.vdf` format as a reverse-engineered compatibility boundary: it
//! fails closed on unknown encodings, preserves fields it does not own, and
//! requires actual Steam-client qualification before any compatibility claim.

use fs2::FileExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use thiserror::Error;

const PLAN_SCHEMA_VERSION: u32 = 1;
const JOURNAL_SCHEMA_VERSION: u32 = 1;
const MAX_SHORTCUTS_BYTES: u64 = 8 * 1024 * 1024;
const MAX_VDF_DEPTH: usize = 8;
const MAX_VDF_FIELDS: usize = 32_768;
const SHORTCUTS_FILE: &str = "shortcuts.vdf";
const LOCK_FILE: &str = "shortcuts.vdf.portcove-lock";
const JOURNAL_FILE: &str = "shortcuts.vdf.portcove-journal.json";
const JOURNAL_TEMPORARY_FILE: &str = "shortcuts.vdf.portcove-journal.tmp";
const REPLACEMENT_TEMPORARY_FILE: &str = "shortcuts.vdf.portcove-replace.tmp";
const ORIGINAL_SWAP_FILE: &str = "shortcuts.vdf.portcove-original.tmp";

#[derive(Debug, Error)]
pub enum SteamEntryError {
    #[error("invalid Steam entry request: {0}")]
    InvalidInput(String),
    #[error("unsupported or malformed Steam shortcuts file: {0}")]
    Malformed(String),
    #[error("Steam entry state changed or is ambiguous: {0}")]
    Conflict(String),
    #[error("an interrupted Steam entry operation requires recovery: {0}")]
    RecoveryRequired(String),
    #[error("Steam entry I/O failed while {context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("Steam entry serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

type Result<T> = std::result::Result<T, SteamEntryError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamGameEntryTarget {
    pub port_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamCliIdentity {
    pub path: PathBuf,
    pub sha256: String,
    pub product_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum SteamEntryPlanRequest {
    AddOrRepair {
        steam_root: PathBuf,
        steam_user_id: String,
        library_id: String,
        library_root: PathBuf,
        cli: SteamCliIdentity,
        games: Vec<SteamGameEntryTarget>,
    },
    Remove {
        steam_root: PathBuf,
        steam_user_id: String,
        library_id: String,
        port_ids: Vec<String>,
    },
}

impl SteamEntryPlanRequest {
    pub(crate) fn steam_root(&self) -> &Path {
        match self {
            Self::AddOrRepair { steam_root, .. } | Self::Remove { steam_root, .. } => steam_root,
        }
    }

    pub(crate) fn steam_user_id(&self) -> &str {
        match self {
            Self::AddOrRepair { steam_user_id, .. } | Self::Remove { steam_user_id, .. } => {
                steam_user_id
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamEntryChangeKind {
    Add,
    Repair,
    Remove,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamEntryChange {
    pub port_id: String,
    pub display_name: Option<String>,
    pub kind: SteamEntryChangeKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamEntryPlan {
    pub schema_version: u32,
    pub request: SteamEntryPlanRequest,
    pub shortcuts_path: PathBuf,
    pub snapshot_sha256: Option<String>,
    pub proposed_sha256: String,
    pub plan_sha256: String,
    pub changes: Vec<SteamEntryChange>,
}

impl SteamEntryPlan {
    pub fn changes_required(&self) -> bool {
        self.changes
            .iter()
            .any(|change| change.kind != SteamEntryChangeKind::Unchanged)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamClientState {
    Closed,
    Running,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SteamEntryApplyResult {
    pub plan_sha256: String,
    pub shortcuts_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub changes: Vec<SteamEntryChange>,
    pub wrote: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SteamEntryRecoveryOutcome {
    NoJournal,
    AbandonedBeforeCommit,
    CompletedCommit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SteamEntryJournal {
    schema_version: u32,
    plan_sha256: String,
    shortcuts_path: PathBuf,
    before_sha256: Option<String>,
    after_sha256: String,
    backup_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum VdfValue {
    Object(Vec<VdfField>),
    String(String),
    Int(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VdfField {
    key: String,
    value: VdfValue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VdfDocument {
    fields: Vec<VdfField>,
}

struct VdfParser<'a> {
    bytes: &'a [u8],
    offset: usize,
    fields: usize,
}

impl<'a> VdfParser<'a> {
    fn parse(bytes: &'a [u8]) -> Result<VdfDocument> {
        let mut parser = Self {
            bytes,
            offset: 0,
            fields: 0,
        };
        let fields = parser.parse_object(0)?;
        if parser.offset != bytes.len() {
            return Err(SteamEntryError::Malformed(
                "trailing bytes follow the top-level object".into(),
            ));
        }
        Ok(VdfDocument { fields })
    }

    fn parse_object(&mut self, depth: usize) -> Result<Vec<VdfField>> {
        if depth > MAX_VDF_DEPTH {
            return Err(SteamEntryError::Malformed(format!(
                "object nesting exceeds {MAX_VDF_DEPTH} levels"
            )));
        }
        let mut fields = Vec::new();
        loop {
            let kind = self.read_byte("value type")?;
            if kind == 0x08 {
                return Ok(fields);
            }
            self.fields += 1;
            if self.fields > MAX_VDF_FIELDS {
                return Err(SteamEntryError::Malformed(format!(
                    "field count exceeds {MAX_VDF_FIELDS}"
                )));
            }
            let key = self.read_string("field name")?;
            let value = match kind {
                0x00 => VdfValue::Object(self.parse_object(depth + 1)?),
                0x01 => VdfValue::String(self.read_string("string value")?),
                0x02 => {
                    let end = self.offset.checked_add(4).ok_or_else(|| {
                        SteamEntryError::Malformed("integer offset overflow".into())
                    })?;
                    let raw = self.bytes.get(self.offset..end).ok_or_else(|| {
                        SteamEntryError::Malformed("truncated 32-bit integer".into())
                    })?;
                    self.offset = end;
                    VdfValue::Int(u32::from_le_bytes(raw.try_into().expect("four-byte slice")))
                }
                other => {
                    return Err(SteamEntryError::Malformed(format!(
                        "unsupported binary VDF value type 0x{other:02x}"
                    )));
                }
            };
            fields.push(VdfField { key, value });
        }
    }

    fn read_byte(&mut self, label: &str) -> Result<u8> {
        let value = self.bytes.get(self.offset).copied().ok_or_else(|| {
            SteamEntryError::Malformed(format!("missing {label} at byte {}", self.offset))
        })?;
        self.offset += 1;
        Ok(value)
    }

    fn read_string(&mut self, label: &str) -> Result<String> {
        let tail = self.bytes.get(self.offset..).ok_or_else(|| {
            SteamEntryError::Malformed(format!("missing {label} at byte {}", self.offset))
        })?;
        let length = tail.iter().position(|byte| *byte == 0).ok_or_else(|| {
            SteamEntryError::Malformed(format!("unterminated {label} at byte {}", self.offset))
        })?;
        let value = std::str::from_utf8(&tail[..length])
            .map_err(|_| SteamEntryError::Malformed(format!("{label} is not valid UTF-8")))?;
        self.offset += length + 1;
        Ok(value.to_owned())
    }
}

impl VdfDocument {
    fn empty_shortcuts() -> Self {
        Self {
            fields: vec![VdfField {
                key: "shortcuts".into(),
                value: VdfValue::Object(Vec::new()),
            }],
        }
    }

    fn parse(bytes: &[u8]) -> Result<Self> {
        let document = VdfParser::parse(bytes)?;
        document.shortcuts_index()?;
        Ok(document)
    }

    fn encode(&self) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        encode_object(&self.fields, &mut bytes)?;
        Ok(bytes)
    }

    fn shortcuts_index(&self) -> Result<usize> {
        unique_field_index(&self.fields, "shortcuts")?.ok_or_else(|| {
            SteamEntryError::Malformed("top-level shortcuts object is missing".into())
        })
    }

    fn shortcuts(&self) -> Result<&[VdfField]> {
        let field = &self.fields[self.shortcuts_index()?];
        match &field.value {
            VdfValue::Object(entries) => Ok(entries),
            _ => Err(SteamEntryError::Malformed(
                "top-level shortcuts value is not an object".into(),
            )),
        }
    }

    fn shortcuts_mut(&mut self) -> Result<&mut Vec<VdfField>> {
        let index = self.shortcuts_index()?;
        match &mut self.fields[index].value {
            VdfValue::Object(entries) => Ok(entries),
            _ => Err(SteamEntryError::Malformed(
                "top-level shortcuts value is not an object".into(),
            )),
        }
    }
}

fn encode_object(fields: &[VdfField], output: &mut Vec<u8>) -> Result<()> {
    for field in fields {
        reject_nul(&field.key, "VDF field name")?;
        let kind = match &field.value {
            VdfValue::Object(_) => 0x00,
            VdfValue::String(_) => 0x01,
            VdfValue::Int(_) => 0x02,
        };
        output.push(kind);
        output.extend_from_slice(field.key.as_bytes());
        output.push(0);
        match &field.value {
            VdfValue::Object(children) => encode_object(children, output)?,
            VdfValue::String(value) => {
                reject_nul(value, "VDF string")?;
                output.extend_from_slice(value.as_bytes());
                output.push(0);
            }
            VdfValue::Int(value) => output.extend_from_slice(&value.to_le_bytes()),
        }
    }
    output.push(0x08);
    Ok(())
}

fn unique_field_index(fields: &[VdfField], name: &str) -> Result<Option<usize>> {
    let mut matches = fields
        .iter()
        .enumerate()
        .filter(|(_, field)| field.key.eq_ignore_ascii_case(name));
    let first = matches.next().map(|(index, _)| index);
    if matches.next().is_some() {
        return Err(SteamEntryError::Conflict(format!(
            "multiple case-insensitive {name} fields are present"
        )));
    }
    Ok(first)
}

fn field_string<'a>(fields: &'a [VdfField], name: &str) -> Result<Option<&'a str>> {
    let Some(index) = unique_field_index(fields, name)? else {
        return Ok(None);
    };
    match &fields[index].value {
        VdfValue::String(value) => Ok(Some(value)),
        _ => Err(SteamEntryError::Malformed(format!(
            "shortcut field {name} is not a string"
        ))),
    }
}

fn field_int(fields: &[VdfField], name: &str) -> Result<Option<u32>> {
    let Some(index) = unique_field_index(fields, name)? else {
        return Ok(None);
    };
    match fields[index].value {
        VdfValue::Int(value) => Ok(Some(value)),
        _ => Err(SteamEntryError::Malformed(format!(
            "shortcut field {name} is not a 32-bit integer"
        ))),
    }
}

fn set_string(fields: &mut Vec<VdfField>, name: &str, value: String) -> Result<bool> {
    reject_nul(&value, name)?;
    if let Some(index) = unique_field_index(fields, name)? {
        let changed = fields[index].value != VdfValue::String(value.clone());
        fields[index].value = VdfValue::String(value);
        Ok(changed)
    } else {
        fields.push(VdfField {
            key: name.into(),
            value: VdfValue::String(value),
        });
        Ok(true)
    }
}

fn validate_shortcut_entries(entries: &[VdfField]) -> Result<()> {
    let mut keys = BTreeSet::new();
    for entry in entries {
        if entry.key.is_empty() || !entry.key.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(SteamEntryError::Malformed(format!(
                "shortcut key {:?} is not a non-negative integer",
                entry.key
            )));
        }
        if !keys.insert(entry.key.as_str()) {
            return Err(SteamEntryError::Conflict(format!(
                "shortcut key {} is duplicated",
                entry.key
            )));
        }
        if !matches!(entry.value, VdfValue::Object(_)) {
            return Err(SteamEntryError::Malformed(format!(
                "shortcut {} is not an object",
                entry.key
            )));
        }
    }
    Ok(())
}

fn shortcut_fields(entry: &VdfField) -> Result<&[VdfField]> {
    match &entry.value {
        VdfValue::Object(fields) => Ok(fields),
        _ => Err(SteamEntryError::Malformed(format!(
            "shortcut {} is not an object",
            entry.key
        ))),
    }
}

fn shortcut_fields_mut(entry: &mut VdfField) -> Result<&mut Vec<VdfField>> {
    match &mut entry.value {
        VdfValue::Object(fields) => Ok(fields),
        _ => Err(SteamEntryError::Malformed(format!(
            "shortcut {} is not an object",
            entry.key
        ))),
    }
}

fn owned_entry_index(entries: &[VdfField], marker: &str) -> Result<Option<usize>> {
    let mut found = None;
    for (index, entry) in entries.iter().enumerate() {
        if field_string(shortcut_fields(entry)?, "DevkitGameID")? == Some(marker)
            && found.replace(index).is_some()
        {
            return Err(SteamEntryError::Conflict(format!(
                "multiple shortcuts carry ownership marker {marker}"
            )));
        }
    }
    Ok(found)
}

fn ownership_marker(library_id: &str, port_id: &str) -> Result<String> {
    validate_identity(library_id, "library identity")?;
    validate_port_id(port_id)?;
    Ok(format!("portcove:v1:{library_id}:{port_id}"))
}

fn validate_identity(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(SteamEntryError::InvalidInput(format!(
            "{label} must contain only ASCII letters, digits, or hyphens"
        )));
    }
    Ok(())
}

fn validate_port_id(port_id: &str) -> Result<()> {
    if port_id.is_empty()
        || !port_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(SteamEntryError::InvalidInput(format!(
            "port ID {port_id:?} is not lowercase kebab-case"
        )));
    }
    Ok(())
}

fn quote_path(path: &Path, label: &str) -> Result<String> {
    if !path.is_absolute() {
        return Err(SteamEntryError::InvalidInput(format!(
            "{label} must be absolute"
        )));
    }
    let value = path
        .to_str()
        .ok_or_else(|| SteamEntryError::InvalidInput(format!("{label} is not valid Unicode")))?;
    if value.contains(['\0', '"']) {
        return Err(SteamEntryError::InvalidInput(format!(
            "{label} contains a character Steam launch fields cannot represent safely"
        )));
    }
    Ok(format!("\"{value}\""))
}

fn build_shortcut(
    key: String,
    target: &SteamGameEntryTarget,
    marker: String,
    app_id: u32,
    executable: &str,
    start_directory: &str,
    launch_options: &str,
) -> Result<VdfField> {
    reject_nul(&target.display_name, "display name")?;
    if target.display_name.trim().is_empty() {
        return Err(SteamEntryError::InvalidInput(
            "display name cannot be blank".into(),
        ));
    }
    Ok(VdfField {
        key,
        value: VdfValue::Object(vec![
            VdfField {
                key: "appid".into(),
                value: VdfValue::Int(app_id),
            },
            string_field("appname", &target.display_name),
            string_field("Exe", executable),
            string_field("StartDir", start_directory),
            string_field("icon", ""),
            string_field("ShortcutPath", ""),
            string_field("LaunchOptions", launch_options),
            int_field("IsHidden", 0),
            int_field("AllowDesktopConfig", 1),
            int_field("AllowOverlay", 1),
            int_field("openvr", 0),
            int_field("Devkit", 0),
            string_field("DevkitGameID", &marker),
            int_field("DevkitOverrideAppID", 0),
            int_field("LastPlayTime", 0),
            VdfField {
                key: "tags".into(),
                value: VdfValue::Object(Vec::new()),
            },
        ]),
    })
}

fn shortcut_app_id(executable: &str, display_name: &str) -> u32 {
    steam_crc32(executable.as_bytes().iter().chain(display_name.as_bytes())) | 0x8000_0000
}

fn require_unique_app_id(
    entries: &[VdfField],
    app_id: u32,
    owned_index: Option<usize>,
    port_id: &str,
) -> Result<()> {
    for (index, entry) in entries.iter().enumerate() {
        if Some(index) == owned_index {
            continue;
        }
        if field_int(shortcut_fields(entry)?, "appid")? == Some(app_id) {
            return Err(SteamEntryError::Conflict(format!(
                "Steam AppID {app_id} for {port_id} is already used by shortcut {}; choose a distinct Steam display name before adding or repairing this route",
                entry.key
            )));
        }
    }
    Ok(())
}

fn string_field(key: &str, value: &str) -> VdfField {
    VdfField {
        key: key.into(),
        value: VdfValue::String(value.into()),
    }
}

fn int_field(key: &str, value: u32) -> VdfField {
    VdfField {
        key: key.into(),
        value: VdfValue::Int(value),
    }
}

fn steam_crc32<'a>(bytes: impl IntoIterator<Item = &'a u8>) -> u32 {
    let mut value = u32::MAX;
    for byte in bytes {
        value ^= u32::from(*byte);
        for _ in 0..8 {
            let polynomial = 0xedb8_8320 & (value & 1).wrapping_neg();
            value = (value >> 1) ^ polynomial;
        }
    }
    !value
}

fn renumber(entries: &mut [VdfField]) {
    for (index, entry) in entries.iter_mut().enumerate() {
        entry.key = index.to_string();
    }
}

fn reject_nul(value: &str, label: &str) -> Result<()> {
    if value.contains('\0') {
        return Err(SteamEntryError::InvalidInput(format!(
            "{label} contains a null character"
        )));
    }
    Ok(())
}

fn profile_paths(request: &SteamEntryPlanRequest) -> Result<(PathBuf, PathBuf)> {
    let steam_root = request.steam_root();
    if !steam_root.is_absolute() {
        return Err(SteamEntryError::InvalidInput(
            "Steam installation path must be absolute".into(),
        ));
    }
    let steam_user_id = request.steam_user_id();
    if steam_user_id.is_empty() || !steam_user_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(SteamEntryError::InvalidInput(
            "Steam profile ID must contain only decimal digits".into(),
        ));
    }
    let canonical_root = fs::canonicalize(steam_root)
        .map_err(|source| io_error("resolving the selected Steam installation", source))?;
    let profile_config = steam_root
        .join("userdata")
        .join(steam_user_id)
        .join("config");
    let canonical_config = fs::canonicalize(&profile_config)
        .map_err(|source| io_error("resolving the selected Steam profile", source))?;
    if !canonical_config.starts_with(&canonical_root) {
        return Err(SteamEntryError::InvalidInput(
            "selected Steam profile resolves outside the selected installation".into(),
        ));
    }
    if !canonical_config.is_dir() {
        return Err(SteamEntryError::InvalidInput(
            "selected Steam profile config path is not a directory".into(),
        ));
    }
    let shortcuts = canonical_config.join(SHORTCUTS_FILE);
    if let Ok(metadata) = fs::symlink_metadata(&shortcuts) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(SteamEntryError::InvalidInput(
                "selected shortcuts.vdf is not a regular file".into(),
            ));
        }
        if metadata.len() > MAX_SHORTCUTS_BYTES {
            return Err(SteamEntryError::Malformed(format!(
                "shortcuts.vdf exceeds the {MAX_SHORTCUTS_BYTES}-byte safety limit"
            )));
        }
    }
    Ok((canonical_config, shortcuts))
}

fn read_snapshot(path: &Path) -> Result<(Option<Vec<u8>>, Option<String>)> {
    let Some(bytes) = read_regular_file(path, "selected shortcuts.vdf")? else {
        return Ok((None, None));
    };
    let digest = sha256(&bytes);
    Ok((Some(bytes), Some(digest)))
}

fn validate_candidate_bytes(bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 > MAX_SHORTCUTS_BYTES {
        return Err(SteamEntryError::InvalidInput(format!(
            "planned shortcuts.vdf exceeds the {MAX_SHORTCUTS_BYTES}-byte safety limit"
        )));
    }
    let document = VdfDocument::parse(bytes)?;
    validate_shortcut_entries(document.shortcuts()?)
}

fn require_regular_file(path: &Path, label: &str) -> Result<()> {
    if !path.is_absolute() {
        return Err(SteamEntryError::InvalidInput(format!(
            "{label} must be absolute"
        )));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| io_error(format!("inspecting {label}"), source))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SteamEntryError::InvalidInput(format!(
            "{label} is not a regular file"
        )));
    }
    Ok(())
}

fn require_directory(path: &Path, label: &str) -> Result<()> {
    if !path.is_absolute() {
        return Err(SteamEntryError::InvalidInput(format!(
            "{label} must be absolute"
        )));
    }
    let metadata =
        fs::metadata(path).map_err(|source| io_error(format!("inspecting {label}"), source))?;
    if !metadata.is_dir() {
        return Err(SteamEntryError::InvalidInput(format!(
            "{label} is not a directory"
        )));
    }
    Ok(())
}

fn plan_document(
    request: &SteamEntryPlanRequest,
    document: &mut VdfDocument,
) -> Result<Vec<SteamEntryChange>> {
    validate_shortcut_entries(document.shortcuts()?)?;
    let mut changes = Vec::new();
    match request {
        SteamEntryPlanRequest::AddOrRepair {
            library_id,
            library_root,
            cli,
            games,
            ..
        } => {
            validate_identity(library_id, "library identity")?;
            if games.is_empty() {
                return Err(SteamEntryError::InvalidInput(
                    "select at least one installed game".into(),
                ));
            }
            require_directory(library_root, "Portcove library")?;
            require_regular_file(&cli.path, "standalone Portcove CLI")?;
            let observed_cli = crate::cli_context::inspect_cli(&cli.path).map_err(|source| {
                SteamEntryError::InvalidInput(format!(
                    "standalone Portcove CLI identity could not be verified: {source}"
                ))
            })?;
            if observed_cli.sha256 != cli.sha256
                || observed_cli.product_version != cli.product_version
            {
                return Err(SteamEntryError::Conflict(
                    "the standalone Portcove CLI changed after review".into(),
                ));
            }
            let executable = quote_path(&cli.path, "standalone Portcove CLI")?;
            let start_directory = quote_path(
                cli.path.parent().ok_or_else(|| {
                    SteamEntryError::InvalidInput(
                        "standalone Portcove CLI has no parent directory".into(),
                    )
                })?,
                "standalone Portcove CLI parent",
            )?;
            let library = quote_path(library_root, "Portcove library")?;
            let mut port_ids = BTreeSet::new();
            for target in games {
                validate_port_id(&target.port_id)?;
                if !port_ids.insert(target.port_id.as_str()) {
                    return Err(SteamEntryError::InvalidInput(format!(
                        "port ID {} is selected more than once",
                        target.port_id
                    )));
                }
                let marker = ownership_marker(library_id, &target.port_id)?;
                let launch_options = format!("--library {library} exec {} --", target.port_id);
                let entries = document.shortcuts_mut()?;
                if let Some(index) = owned_entry_index(entries, &marker)? {
                    let existing_fields = shortcut_fields(&entries[index])?;
                    let existing_app_id =
                        field_int(existing_fields, "appid")?.ok_or_else(|| {
                            SteamEntryError::Malformed(format!(
                                "owned shortcut {} has no Steam AppID",
                                entries[index].key
                            ))
                        })?;
                    require_unique_app_id(entries, existing_app_id, Some(index), &target.port_id)?;
                    let fields = shortcut_fields_mut(&mut entries[index])?;
                    let existing_display_name = field_string(fields, "appname")?.map(str::to_owned);
                    let display_name = existing_display_name
                        .clone()
                        .unwrap_or_else(|| target.display_name.clone());
                    let repaired = (existing_display_name.is_none()
                        && set_string(fields, "appname", target.display_name.clone())?)
                        | set_string(fields, "Exe", executable.clone())?
                        | set_string(fields, "StartDir", start_directory.clone())?
                        | set_string(fields, "LaunchOptions", launch_options)?;
                    changes.push(SteamEntryChange {
                        port_id: target.port_id.clone(),
                        display_name: Some(display_name),
                        kind: if repaired {
                            SteamEntryChangeKind::Repair
                        } else {
                            SteamEntryChangeKind::Unchanged
                        },
                    });
                } else {
                    reject_nul(&target.display_name, "display name")?;
                    if target.display_name.trim().is_empty() {
                        return Err(SteamEntryError::InvalidInput(
                            "display name cannot be blank".into(),
                        ));
                    }
                    let app_id = shortcut_app_id(&executable, &target.display_name);
                    require_unique_app_id(entries, app_id, None, &target.port_id)?;
                    let key = entries.len().to_string();
                    entries.push(build_shortcut(
                        key,
                        target,
                        marker,
                        app_id,
                        &executable,
                        &start_directory,
                        &launch_options,
                    )?);
                    changes.push(SteamEntryChange {
                        port_id: target.port_id.clone(),
                        display_name: Some(target.display_name.clone()),
                        kind: SteamEntryChangeKind::Add,
                    });
                }
            }
        }
        SteamEntryPlanRequest::Remove {
            library_id,
            port_ids,
            ..
        } => {
            validate_identity(library_id, "library identity")?;
            if port_ids.is_empty() {
                return Err(SteamEntryError::InvalidInput(
                    "select at least one owned Steam entry".into(),
                ));
            }
            let mut unique = BTreeSet::new();
            for port_id in port_ids {
                validate_port_id(port_id)?;
                if !unique.insert(port_id.as_str()) {
                    return Err(SteamEntryError::InvalidInput(format!(
                        "port ID {port_id} is selected more than once"
                    )));
                }
                let marker = ownership_marker(library_id, port_id)?;
                let entries = document.shortcuts_mut()?;
                if let Some(index) = owned_entry_index(entries, &marker)? {
                    let display_name = field_string(shortcut_fields(&entries[index])?, "appname")?
                        .map(str::to_owned);
                    entries.remove(index);
                    changes.push(SteamEntryChange {
                        port_id: port_id.clone(),
                        display_name,
                        kind: SteamEntryChangeKind::Remove,
                    });
                } else {
                    changes.push(SteamEntryChange {
                        port_id: port_id.clone(),
                        display_name: None,
                        kind: SteamEntryChangeKind::Unchanged,
                    });
                }
            }
        }
    }
    renumber(document.shortcuts_mut()?);
    Ok(changes)
}

pub fn plan_steam_entries(request: SteamEntryPlanRequest) -> Result<SteamEntryPlan> {
    let (config, shortcuts_path) = profile_paths(&request)?;
    let journal_path = config.join(JOURNAL_FILE);
    let staged_path = config.join(REPLACEMENT_TEMPORARY_FILE);
    let swap_path = config.join(ORIGINAL_SWAP_FILE);
    if [&journal_path, &staged_path, &swap_path]
        .iter()
        .any(|path| fs::symlink_metadata(path).is_ok())
    {
        return Err(SteamEntryError::RecoveryRequired(
            journal_path.display().to_string(),
        ));
    }
    let (snapshot, snapshot_sha256) = read_snapshot(&shortcuts_path)?;
    let mut document = match snapshot {
        Some(bytes) => VdfDocument::parse(&bytes)?,
        None => VdfDocument::empty_shortcuts(),
    };
    let changes = plan_document(&request, &mut document)?;
    let proposed = document.encode()?;
    validate_candidate_bytes(&proposed)?;
    let proposed_sha256 = sha256(&proposed);
    let plan_sha256 = hash_plan(
        &request,
        &shortcuts_path,
        snapshot_sha256.as_deref(),
        &proposed_sha256,
        &changes,
    )?;
    Ok(SteamEntryPlan {
        schema_version: PLAN_SCHEMA_VERSION,
        request,
        shortcuts_path,
        snapshot_sha256,
        proposed_sha256,
        plan_sha256,
        changes,
    })
}

pub fn apply_steam_entry_plan(
    reviewed: &SteamEntryPlan,
    client_state: SteamClientState,
) -> Result<SteamEntryApplyResult> {
    apply_steam_entry_plan_with_hook(reviewed, client_state, |_| {})
}

fn apply_steam_entry_plan_with_hook<F>(
    reviewed: &SteamEntryPlan,
    client_state: SteamClientState,
    before_evacuation: F,
) -> Result<SteamEntryApplyResult>
where
    F: FnOnce(&Path),
{
    if reviewed.schema_version != PLAN_SCHEMA_VERSION {
        return Err(SteamEntryError::InvalidInput(format!(
            "Steam entry plan schema {} is unsupported",
            reviewed.schema_version
        )));
    }
    match client_state {
        SteamClientState::Closed => {}
        SteamClientState::Running => {
            return Err(SteamEntryError::Conflict(
                "Steam is running; close it and review the plan again".into(),
            ));
        }
        SteamClientState::Unknown => {
            return Err(SteamEntryError::Conflict(
                "Steam process state is unknown; no shortcut file was changed".into(),
            ));
        }
    }
    let (config, shortcuts_path) = profile_paths(&reviewed.request)?;
    let _lock = lock_profile(&config)?;
    let journal_path = config.join(JOURNAL_FILE);
    let staged_path = config.join(REPLACEMENT_TEMPORARY_FILE);
    let swap_path = config.join(ORIGINAL_SWAP_FILE);
    if [&journal_path, &staged_path, &swap_path]
        .iter()
        .any(|path| fs::symlink_metadata(path).is_ok())
    {
        return Err(SteamEntryError::RecoveryRequired(
            journal_path.display().to_string(),
        ));
    }
    let current = plan_steam_entries(reviewed.request.clone())?;
    if current.plan_sha256 != reviewed.plan_sha256
        || current.shortcuts_path != reviewed.shortcuts_path
        || current.proposed_sha256 != reviewed.proposed_sha256
    {
        return Err(SteamEntryError::Conflict(
            "the Steam profile, shortcuts, runtime, library, or selection changed after preview"
                .into(),
        ));
    }
    if !current.changes_required() {
        return Ok(SteamEntryApplyResult {
            plan_sha256: current.plan_sha256,
            shortcuts_path,
            backup_path: None,
            changes: current.changes,
            wrote: false,
        });
    }
    let (before, before_sha256) = read_snapshot(&shortcuts_path)?;
    let mut proposed_document = match before.as_deref() {
        Some(bytes) => VdfDocument::parse(bytes)?,
        None => VdfDocument::empty_shortcuts(),
    };
    plan_document(&reviewed.request, &mut proposed_document)?;
    let proposed = proposed_document.encode()?;
    validate_candidate_bytes(&proposed)?;
    if sha256(&proposed) != reviewed.proposed_sha256 || before_sha256 != reviewed.snapshot_sha256 {
        return Err(SteamEntryError::Conflict(
            "shortcuts.vdf changed after the reviewed plan was confirmed".into(),
        ));
    }
    let backup_path = match before.as_deref() {
        Some(bytes) => Some(write_backup(
            &config,
            bytes,
            before_sha256.as_deref().unwrap(),
        )?),
        None => None,
    };
    let journal = SteamEntryJournal {
        schema_version: JOURNAL_SCHEMA_VERSION,
        plan_sha256: reviewed.plan_sha256.clone(),
        shortcuts_path: shortcuts_path.clone(),
        before_sha256,
        after_sha256: reviewed.proposed_sha256.clone(),
        backup_path: backup_path.clone(),
    };
    crate::application_update_storage::write_bytes_atomically(
        &config,
        JOURNAL_TEMPORARY_FILE,
        JOURNAL_FILE,
        &serde_json::to_vec_pretty(&journal)?,
    )
    .map_err(|source| io_error("publishing the Steam entry recovery journal", source))?;
    write_staged_file(&staged_path, &proposed)?;
    before_evacuation(&shortcuts_path);

    if let Some(expected_before) = reviewed.snapshot_sha256.as_deref() {
        create_swap_placeholder(&swap_path)?;
        if let Err(source) = crate::application_update_storage::replace_file_atomically(
            &config,
            SHORTCUTS_FILE,
            ORIGINAL_SWAP_FILE,
        ) {
            return Err(SteamEntryError::RecoveryRequired(format!(
                "could not evacuate the reviewed shortcuts file without losing recovery state: {source}; {} was preserved",
                journal_path.display()
            )));
        }
        let (_, evacuated_sha256) = read_snapshot(&swap_path)?;
        if evacuated_sha256.as_deref() != Some(expected_before) {
            if let Err(source) = rename_noreplace(&swap_path, &shortcuts_path) {
                return Err(SteamEntryError::RecoveryRequired(format!(
                    "shortcuts.vdf changed during publication and the changed file could not be restored without clobbering another writer: {source}; {} was preserved",
                    journal_path.display()
                )));
            }
            remove_regular_file(&staged_path, "staged Steam shortcut replacement")?;
            remove_regular_file(&journal_path, "Steam entry recovery journal")?;
            sync_directory_if_supported(&config)?;
            return Err(SteamEntryError::Conflict(
                "shortcuts.vdf changed during publication; the external bytes were restored and no Portcove change was committed".into(),
            ));
        }
    } else if fs::symlink_metadata(&shortcuts_path).is_ok() {
        return Err(SteamEntryError::RecoveryRequired(format!(
            "shortcuts.vdf appeared during publication; {} and the staged candidate were preserved",
            journal_path.display()
        )));
    }

    if let Err(source) = rename_noreplace(&staged_path, &shortcuts_path) {
        return Err(SteamEntryError::RecoveryRequired(format!(
            "could not publish the reviewed Steam shortcut bytes without clobbering a concurrent writer: {source}; {} was preserved",
            journal_path.display()
        )));
    }
    let (_, committed_sha256) = read_snapshot(&shortcuts_path)?;
    if committed_sha256.as_deref() != Some(reviewed.proposed_sha256.as_str()) {
        return Err(SteamEntryError::RecoveryRequired(
            journal_path.display().to_string(),
        ));
    }
    if let Some(expected_before) = reviewed.snapshot_sha256.as_deref() {
        remove_regular_file_with_hash(
            &swap_path,
            expected_before,
            "evacuated original Steam shortcuts file",
        )?;
    }
    remove_regular_file(&journal_path, "Steam entry recovery journal")?;
    sync_directory_if_supported(&config)?;
    Ok(SteamEntryApplyResult {
        plan_sha256: current.plan_sha256,
        shortcuts_path,
        backup_path,
        changes: current.changes,
        wrote: true,
    })
}

pub fn recover_steam_entries(
    steam_root: &Path,
    steam_user_id: &str,
) -> Result<SteamEntryRecoveryOutcome> {
    let request = SteamEntryPlanRequest::Remove {
        steam_root: steam_root.to_path_buf(),
        steam_user_id: steam_user_id.into(),
        library_id: "recovery-probe".into(),
        port_ids: Vec::new(),
    };
    let (config, shortcuts_path) = profile_paths(&request)?;
    let _lock = lock_profile(&config)?;
    let journal_path = config.join(JOURNAL_FILE);
    let staged_path = config.join(REPLACEMENT_TEMPORARY_FILE);
    let swap_path = config.join(ORIGINAL_SWAP_FILE);
    let bytes = match read_regular_file(&journal_path, "Steam entry recovery journal")? {
        Some(bytes) => bytes,
        None => {
            if fs::symlink_metadata(&staged_path).is_ok()
                || fs::symlink_metadata(&swap_path).is_ok()
            {
                return Err(SteamEntryError::RecoveryRequired(
                    "orphaned Steam entry operation files exist without a journal".into(),
                ));
            }
            return Ok(SteamEntryRecoveryOutcome::NoJournal);
        }
    };
    let journal: SteamEntryJournal = serde_json::from_slice(&bytes)?;
    if journal.schema_version != JOURNAL_SCHEMA_VERSION || journal.shortcuts_path != shortcuts_path
    {
        return Err(SteamEntryError::RecoveryRequired(format!(
            "{} has an unsupported identity",
            journal_path.display()
        )));
    }
    verify_journal_backup(&config, &journal)?;
    let (_, current_sha256) = read_snapshot(&shortcuts_path)?;
    let (_, staged_sha256) = read_snapshot(&staged_path)?;
    let (_, swap_sha256) = read_snapshot(&swap_path)?;
    let staged_known =
        staged_sha256.is_none() || staged_sha256.as_deref() == Some(journal.after_sha256.as_str());
    let empty_sha256 = sha256(&[]);
    let swap_is_unconsumed_reservation = journal.before_sha256.is_some()
        && current_sha256 == journal.before_sha256
        && swap_sha256.as_deref() == Some(empty_sha256.as_str());
    let swap_known = swap_sha256.is_none()
        || swap_sha256 == journal.before_sha256
        || swap_is_unconsumed_reservation;
    if !staged_known || !swap_known {
        return Err(SteamEntryError::RecoveryRequired(
            "Steam entry operation files do not match the journal; every file was preserved".into(),
        ));
    }
    let outcome = if current_sha256.as_deref() == Some(journal.after_sha256.as_str()) {
        SteamEntryRecoveryOutcome::CompletedCommit
    } else if current_sha256 == journal.before_sha256 {
        SteamEntryRecoveryOutcome::AbandonedBeforeCommit
    } else if current_sha256.is_none()
        && journal.before_sha256.is_some()
        && swap_sha256 == journal.before_sha256
    {
        rename_noreplace(&swap_path, &shortcuts_path).map_err(|source| {
            SteamEntryError::RecoveryRequired(format!(
                "the evacuated original could not be restored without clobbering another writer: {source}"
            ))
        })?;
        SteamEntryRecoveryOutcome::AbandonedBeforeCommit
    } else {
        return Err(SteamEntryError::RecoveryRequired(format!(
            "{} does not match the pre-operation or committed shortcut identity; the journal, backup, staged candidate and evacuated original were preserved",
            shortcuts_path.display()
        )));
    };
    if let Some(expected) = staged_sha256.as_deref() {
        remove_regular_file_with_hash(&staged_path, expected, "staged Steam shortcut replacement")?;
    }
    if let Some(expected) = swap_sha256.as_deref() {
        remove_regular_file_with_hash(
            &swap_path,
            expected,
            "evacuated original Steam shortcuts file",
        )?;
    }
    remove_regular_file(&journal_path, "Steam entry recovery journal")?;
    sync_directory_if_supported(&config)?;
    Ok(outcome)
}

fn lock_profile(config: &Path) -> Result<File> {
    let path = config.join(LOCK_FILE);
    if let Ok(metadata) = fs::symlink_metadata(&path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(SteamEntryError::Conflict(format!(
            "Steam profile mutation lock {} is not a regular file",
            path.display()
        )));
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|source| io_error("opening the Steam profile mutation lock", source))?;
    file.try_lock_exclusive().map_err(|source| {
        SteamEntryError::Conflict(format!(
            "another Portcove Steam operation owns {}: {source}",
            path.display()
        ))
    })?;
    Ok(file)
}

fn read_regular_file(path: &Path, label: &str) -> Result<Option<Vec<u8>>> {
    let file = match open_read_nofollow(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            if fs::symlink_metadata(path)
                .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
                .unwrap_or(false)
            {
                return Err(SteamEntryError::Conflict(format!(
                    "{label} {} is not an independent regular file",
                    path.display()
                )));
            }
            return Err(io_error(
                format!("opening {label} without link traversal"),
                source,
            ));
        }
    };
    let metadata = file
        .metadata()
        .map_err(|source| io_error(format!("inspecting opened {label}"), source))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(SteamEntryError::Conflict(format!(
            "{label} {} is not an independent regular file",
            path.display()
        )));
    }
    if metadata.len() > MAX_SHORTCUTS_BYTES {
        return Err(SteamEntryError::Conflict(format!(
            "{label} {} exceeds the safety limit",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(MAX_SHORTCUTS_BYTES) as usize);
    file.take(MAX_SHORTCUTS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| io_error(format!("reading opened {label}"), source))?;
    if bytes.len() as u64 > MAX_SHORTCUTS_BYTES {
        return Err(SteamEntryError::Conflict(format!(
            "{label} {} grew beyond the safety limit while it was read",
            path.display()
        )));
    }
    Ok(Some(bytes))
}

#[cfg(windows)]
fn open_read_nofollow(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(unix)]
fn open_read_nofollow(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(not(any(windows, unix)))]
fn open_read_nofollow(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

fn write_staged_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| io_error("creating the staged Steam shortcut replacement", source))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|source| io_error("writing the staged Steam shortcut replacement", source))?;
    sync_directory_if_supported(path.parent().expect("staged file has a parent"))
}

fn create_swap_placeholder(path: &Path) -> Result<()> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| io_error("reserving the evacuated-original path", source))?;
    file.sync_all()
        .map_err(|source| io_error("flushing the evacuated-original reservation", source))?;
    sync_directory_if_supported(path.parent().expect("swap file has a parent"))
}

#[cfg(windows)]
fn rename_noreplace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

    fn wide(path: &Path) -> std::io::Result<Vec<u16>> {
        let mut value = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if value.contains(&0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path contains a null character",
            ));
        }
        value.push(0);
        Ok(value)
    }

    let source = wide(source)?;
    let destination = wide(destination)?;
    // SAFETY: both buffers are valid, null-terminated UTF-16 for the call.
    // Omitting MOVEFILE_REPLACE_EXISTING is the no-clobber precondition.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn rename_noreplace(source: &Path, destination: &Path) -> std::io::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("destination has no parent"))?;
    fs::hard_link(source, destination)?;
    File::open(parent)?.sync_all()?;
    fs::remove_file(source)?;
    File::open(parent)?.sync_all()
}

#[cfg(not(any(windows, unix)))]
fn rename_noreplace(_source: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no-clobber file publication is unavailable on this platform",
    ))
}

fn remove_regular_file(path: &Path, label: &str) -> Result<()> {
    let Some(_) = read_regular_file(path, label)? else {
        return Ok(());
    };
    fs::remove_file(path).map_err(|source| io_error(format!("removing {label}"), source))
}

fn remove_regular_file_with_hash(path: &Path, expected: &str, label: &str) -> Result<()> {
    let Some(bytes) = read_regular_file(path, label)? else {
        return Ok(());
    };
    if sha256(&bytes) != expected {
        return Err(SteamEntryError::RecoveryRequired(format!(
            "{label} {} changed; it was preserved",
            path.display()
        )));
    }
    fs::remove_file(path).map_err(|source| io_error(format!("removing {label}"), source))
}

fn verify_journal_backup(config: &Path, journal: &SteamEntryJournal) -> Result<()> {
    match journal.before_sha256.as_deref() {
        None if journal.backup_path.is_none() => Ok(()),
        None => Err(SteamEntryError::RecoveryRequired(
            "journal records a backup for a previously absent shortcut file".into(),
        )),
        Some(digest) => {
            let expected = config.join(format!("shortcuts.vdf.portcove-backup-{digest}"));
            if journal.backup_path.as_deref() != Some(expected.as_path()) {
                return Err(SteamEntryError::RecoveryRequired(
                    "journal backup path does not match the reviewed content identity".into(),
                ));
            }
            let bytes =
                read_regular_file(&expected, "Steam shortcuts backup")?.ok_or_else(|| {
                    SteamEntryError::RecoveryRequired(format!(
                        "required Steam shortcuts backup {} is missing",
                        expected.display()
                    ))
                })?;
            if sha256(&bytes) != digest {
                return Err(SteamEntryError::RecoveryRequired(format!(
                    "Steam shortcuts backup {} does not match its recorded identity",
                    expected.display()
                )));
            }
            Ok(())
        }
    }
}

fn write_backup(config: &Path, bytes: &[u8], digest: &str) -> Result<PathBuf> {
    let path = config.join(format!("shortcuts.vdf.portcove-backup-{digest}"));
    if let Some(existing) = read_regular_file(&path, "existing Steam shortcuts backup")? {
        if existing != bytes {
            return Err(SteamEntryError::Conflict(format!(
                "existing backup {} does not match its content identity",
                path.display()
            )));
        }
        return Ok(path);
    }
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(|source| io_error("writing the Steam shortcuts backup", source))?;
            sync_directory_if_supported(config)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing =
                read_regular_file(&path, "racing Steam shortcuts backup")?.ok_or_else(|| {
                    SteamEntryError::Conflict(format!(
                        "backup {} disappeared during collision handling",
                        path.display()
                    ))
                })?;
            if existing != bytes {
                return Err(SteamEntryError::Conflict(format!(
                    "racing backup {} does not match its content identity",
                    path.display()
                )));
            }
            return Ok(path);
        }
        Err(source) => return Err(io_error("creating the Steam shortcuts backup", source)),
    }
    Ok(path)
}

fn sync_directory_if_supported(directory: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(directory)
        .and_then(|handle| handle.sync_all())
        .map_err(|source| io_error("synchronizing the Steam profile directory", source))?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn hash_plan(
    request: &SteamEntryPlanRequest,
    shortcuts_path: &Path,
    snapshot_sha256: Option<&str>,
    proposed_sha256: &str,
    changes: &[SteamEntryChange],
) -> Result<String> {
    #[derive(Serialize)]
    struct Identity<'a> {
        schema_version: u32,
        request: &'a SteamEntryPlanRequest,
        shortcuts_path: &'a Path,
        snapshot_sha256: Option<&'a str>,
        proposed_sha256: &'a str,
        changes: &'a [SteamEntryChange],
    }
    Ok(sha256(&serde_json::to_vec(&Identity {
        schema_version: PLAN_SCHEMA_VERSION,
        request,
        shortcuts_path,
        snapshot_sha256,
        proposed_sha256,
        changes,
    })?))
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn io_error(context: impl Into<String>, source: std::io::Error) -> SteamEntryError {
    SteamEntryError::Io {
        context: context.into(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _root: tempfile::TempDir,
        steam_root: PathBuf,
        config: PathBuf,
        library_root: PathBuf,
        cli_path: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let steam_root = root.path().join("Steam root ü");
            let config = steam_root.join("userdata/12345/config");
            let library_root = root.path().join("Library games ü");
            let cli_path = root.path().join("CLI tools ü/portcove.exe");
            fs::create_dir_all(&config).unwrap();
            fs::create_dir_all(&library_root).unwrap();
            fs::create_dir_all(cli_path.parent().unwrap()).unwrap();
            write_cli(&cli_path, b"fixture cli");
            Self {
                _root: root,
                steam_root,
                config,
                library_root,
                cli_path,
            }
        }

        fn add_request(&self, games: Vec<SteamGameEntryTarget>) -> SteamEntryPlanRequest {
            SteamEntryPlanRequest::AddOrRepair {
                steam_root: self.steam_root.clone(),
                steam_user_id: "12345".into(),
                library_id: "library-123".into(),
                library_root: self.library_root.clone(),
                cli: cli_identity(&self.cli_path),
                games,
            }
        }

        fn remove_request(&self, port_ids: &[&str]) -> SteamEntryPlanRequest {
            SteamEntryPlanRequest::Remove {
                steam_root: self.steam_root.clone(),
                steam_user_id: "12345".into(),
                library_id: "library-123".into(),
                port_ids: port_ids.iter().map(|value| (*value).into()).collect(),
            }
        }

        fn shortcuts(&self) -> PathBuf {
            self.config.join(SHORTCUTS_FILE)
        }
    }

    fn write_cli(path: &Path, prefix: &[u8]) {
        let mut bytes = prefix.to_vec();
        bytes.extend_from_slice(&crate::cli_context::cli_steam_exec_identity());
        fs::write(path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    fn cli_identity(path: &Path) -> SteamCliIdentity {
        let identity = crate::cli_context::inspect_cli(path).unwrap();
        SteamCliIdentity {
            path: identity.path,
            sha256: identity.sha256,
            product_version: identity.product_version,
        }
    }

    fn game(port_id: &str, display_name: &str) -> SteamGameEntryTarget {
        SteamGameEntryTarget {
            port_id: port_id.into(),
            display_name: display_name.into(),
        }
    }

    fn document_entries(path: &Path) -> Vec<VdfField> {
        VdfDocument::parse(&fs::read(path).unwrap())
            .unwrap()
            .shortcuts()
            .unwrap()
            .to_vec()
    }

    #[test]
    fn binary_vdf_round_trip_preserves_unknown_fields_order_and_case() {
        let document = VdfDocument {
            fields: vec![
                VdfField {
                    key: "shortcuts".into(),
                    value: VdfValue::Object(vec![VdfField {
                        key: "0".into(),
                        value: VdfValue::Object(vec![
                            string_field("AppName", "Unrelated ü"),
                            int_field("FutureFlag", 0xfedc_ba98),
                            VdfField {
                                key: "FutureObject".into(),
                                value: VdfValue::Object(vec![string_field("Value", "kept")]),
                            },
                        ]),
                    }]),
                },
                string_field("FutureTopLevel", "kept"),
            ],
        };
        let bytes = document.encode().unwrap();
        assert_eq!(VdfDocument::parse(&bytes).unwrap().encode().unwrap(), bytes);
    }

    #[test]
    fn steam_app_id_checksum_uses_the_standard_ieee_crc32() {
        assert_eq!(steam_crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn selected_batch_add_is_duplicate_free_with_spaces_and_unicode() {
        let fixture = Fixture::new();
        let request = fixture.add_request(vec![
            game("starship", "Starship ü"),
            game("soh", "Ship of Harkinian"),
        ]);
        let plan = plan_steam_entries(request.clone()).unwrap();
        assert_eq!(
            plan.changes
                .iter()
                .map(|change| change.kind)
                .collect::<Vec<_>>(),
            vec![SteamEntryChangeKind::Add, SteamEntryChangeKind::Add]
        );
        let result = apply_steam_entry_plan(&plan, SteamClientState::Closed).unwrap();
        assert!(result.wrote);
        assert!(result.backup_path.is_none());
        let entries = document_entries(&fixture.shortcuts());
        assert_eq!(entries.len(), 2);
        for entry in &entries {
            let fields = shortcut_fields(entry).unwrap();
            assert_eq!(
                field_string(fields, "Exe").unwrap(),
                Some(format!("\"{}\"", fixture.cli_path.display()).as_str())
            );
            assert!(
                field_string(fields, "LaunchOptions")
                    .unwrap()
                    .unwrap()
                    .contains(&format!("\"{}\"", fixture.library_root.display()))
            );
        }
        let repeated = plan_steam_entries(request).unwrap();
        assert!(
            repeated
                .changes
                .iter()
                .all(|change| change.kind == SteamEntryChangeKind::Unchanged)
        );
        let bytes = fs::read(fixture.shortcuts()).unwrap();
        assert!(
            !apply_steam_entry_plan(&repeated, SteamClientState::Closed)
                .unwrap()
                .wrote
        );
        assert_eq!(fs::read(fixture.shortcuts()).unwrap(), bytes);
    }

    #[test]
    fn repair_changes_only_owned_routing_fields_and_preserves_customization() {
        let fixture = Fixture::new();
        let request = fixture.add_request(vec![game("starship", "Starship")]);
        let initial = plan_steam_entries(request.clone()).unwrap();
        apply_steam_entry_plan(&initial, SteamClientState::Closed).unwrap();
        let mut document = VdfDocument::parse(&fs::read(fixture.shortcuts()).unwrap()).unwrap();
        let fields = shortcut_fields_mut(&mut document.shortcuts_mut().unwrap()[0]).unwrap();
        set_string(fields, "appname", "My custom title".into()).unwrap();
        set_string(fields, "icon", "custom-icon.png".into()).unwrap();
        fields.push(int_field("CustomFlag", 77));
        fs::write(fixture.shortcuts(), document.encode().unwrap()).unwrap();
        let moved_cli = fixture
            .cli_path
            .parent()
            .unwrap()
            .join("moved portcove.exe");
        write_cli(&moved_cli, b"moved fixture cli");
        let moved_request = match request {
            SteamEntryPlanRequest::AddOrRepair {
                steam_root,
                steam_user_id,
                library_id,
                library_root,
                games,
                ..
            } => SteamEntryPlanRequest::AddOrRepair {
                steam_root,
                steam_user_id,
                library_id,
                library_root,
                cli: cli_identity(&moved_cli),
                games,
            },
            _ => unreachable!(),
        };
        let repair = plan_steam_entries(moved_request).unwrap();
        assert_eq!(repair.changes[0].kind, SteamEntryChangeKind::Repair);
        assert_eq!(
            repair.changes[0].display_name.as_deref(),
            Some("My custom title")
        );
        let applied = apply_steam_entry_plan(&repair, SteamClientState::Closed).unwrap();
        assert!(applied.backup_path.unwrap().is_file());
        let entries = document_entries(&fixture.shortcuts());
        let fields = shortcut_fields(&entries[0]).unwrap();
        assert_eq!(
            field_string(fields, "appname").unwrap(),
            Some("My custom title")
        );
        assert_eq!(
            field_string(fields, "icon").unwrap(),
            Some("custom-icon.png")
        );
        assert_eq!(
            field_string(fields, "Exe").unwrap(),
            Some(format!("\"{}\"", moved_cli.display()).as_str())
        );
        assert!(
            fields
                .iter()
                .any(|field| field.key == "CustomFlag" && field.value == VdfValue::Int(77))
        );
    }

    #[test]
    fn remove_is_scoped_to_the_selected_owned_entry() {
        let fixture = Fixture::new();
        let add = plan_steam_entries(fixture.add_request(vec![
            game("starship", "Starship"),
            game("soh", "Ship of Harkinian"),
        ]))
        .unwrap();
        apply_steam_entry_plan(&add, SteamClientState::Closed).unwrap();
        let mut document = VdfDocument::parse(&fs::read(fixture.shortcuts()).unwrap()).unwrap();
        document.shortcuts_mut().unwrap().push(VdfField {
            key: "2".into(),
            value: VdfValue::Object(vec![string_field("appname", "Unrelated")]),
        });
        fs::write(fixture.shortcuts(), document.encode().unwrap()).unwrap();
        let remove = plan_steam_entries(fixture.remove_request(&["starship"])).unwrap();
        assert_eq!(remove.changes[0].kind, SteamEntryChangeKind::Remove);
        apply_steam_entry_plan(&remove, SteamClientState::Closed).unwrap();
        let entries = document_entries(&fixture.shortcuts());
        assert_eq!(entries.len(), 2);
        let names = entries
            .iter()
            .map(|entry| field_string(shortcut_fields(entry).unwrap(), "appname").unwrap())
            .collect::<Vec<_>>();
        assert!(names.contains(&Some("Ship of Harkinian")));
        assert!(names.contains(&Some("Unrelated")));
        assert!(fixture.cli_path.is_file());
        assert!(fixture.library_root.is_dir());
    }

    #[test]
    fn stale_plan_and_non_closed_steam_never_write() {
        let fixture = Fixture::new();
        let plan =
            plan_steam_entries(fixture.add_request(vec![game("starship", "Starship")])).unwrap();
        assert!(matches!(
            apply_steam_entry_plan(&plan, SteamClientState::Running),
            Err(SteamEntryError::Conflict(_))
        ));
        assert!(!fixture.shortcuts().exists());
        fs::write(
            fixture.shortcuts(),
            VdfDocument::empty_shortcuts().encode().unwrap(),
        )
        .unwrap();
        assert!(matches!(
            apply_steam_entry_plan(&plan, SteamClientState::Closed),
            Err(SteamEntryError::Conflict(_))
        ));
        assert_eq!(document_entries(&fixture.shortcuts()).len(), 0);
    }

    #[test]
    fn reviewed_cli_bytes_must_still_match_before_writing() {
        let fixture = Fixture::new();
        let plan =
            plan_steam_entries(fixture.add_request(vec![game("starship", "Starship")])).unwrap();
        write_cli(&fixture.cli_path, b"replacement cli bytes");
        assert!(matches!(
            apply_steam_entry_plan(&plan, SteamClientState::Closed),
            Err(SteamEntryError::Conflict(message))
                if message.contains("standalone Portcove CLI changed")
        ));
        assert!(!fixture.shortcuts().exists());
    }

    #[test]
    fn recovery_classifies_precommit_and_committed_identity() {
        let fixture = Fixture::new();
        let plan =
            plan_steam_entries(fixture.add_request(vec![game("starship", "Starship")])).unwrap();
        let journal = SteamEntryJournal {
            schema_version: JOURNAL_SCHEMA_VERSION,
            plan_sha256: plan.plan_sha256.clone(),
            shortcuts_path: plan.shortcuts_path.clone(),
            before_sha256: None,
            after_sha256: plan.proposed_sha256.clone(),
            backup_path: None,
        };
        fs::write(
            fixture.config.join(JOURNAL_FILE),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            plan_steam_entries(fixture.remove_request(&["starship"])),
            Err(SteamEntryError::RecoveryRequired(_))
        ));
        assert_eq!(
            recover_steam_entries(&fixture.steam_root, "12345").unwrap(),
            SteamEntryRecoveryOutcome::AbandonedBeforeCommit
        );
        let plan =
            plan_steam_entries(fixture.add_request(vec![game("starship", "Starship")])).unwrap();
        let mut document = VdfDocument::empty_shortcuts();
        plan_document(&plan.request, &mut document).unwrap();
        fs::write(fixture.shortcuts(), document.encode().unwrap()).unwrap();
        let journal = SteamEntryJournal {
            schema_version: JOURNAL_SCHEMA_VERSION,
            plan_sha256: plan.plan_sha256,
            shortcuts_path: plan.shortcuts_path.clone(),
            before_sha256: None,
            after_sha256: plan.proposed_sha256,
            backup_path: None,
        };
        fs::write(
            fixture.config.join(JOURNAL_FILE),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        assert_eq!(
            recover_steam_entries(&fixture.steam_root, "12345").unwrap(),
            SteamEntryRecoveryOutcome::CompletedCommit
        );
    }

    #[test]
    fn recovery_discards_an_unconsumed_swap_reservation() {
        let fixture = Fixture::new();
        let add =
            plan_steam_entries(fixture.add_request(vec![game("starship", "Starship")])).unwrap();
        apply_steam_entry_plan(&add, SteamClientState::Closed).unwrap();
        let original = fs::read(fixture.shortcuts()).unwrap();

        let moved_cli = fixture.cli_path.parent().unwrap().join("moved.exe");
        write_cli(&moved_cli, b"moved fixture cli");
        let request = SteamEntryPlanRequest::AddOrRepair {
            steam_root: fixture.steam_root.clone(),
            steam_user_id: "12345".into(),
            library_id: "library-123".into(),
            library_root: fixture.library_root.clone(),
            cli: cli_identity(&moved_cli),
            games: vec![game("starship", "Starship")],
        };
        let plan = plan_steam_entries(request).unwrap();
        let config = plan.shortcuts_path.parent().unwrap().to_path_buf();
        let before_sha256 = plan.snapshot_sha256.clone().unwrap();
        let backup_path = write_backup(&config, &original, &before_sha256).unwrap();
        let mut proposed = VdfDocument::parse(&original).unwrap();
        plan_document(&plan.request, &mut proposed).unwrap();
        let proposed = proposed.encode().unwrap();
        assert_eq!(sha256(&proposed), plan.proposed_sha256);
        let journal = SteamEntryJournal {
            schema_version: JOURNAL_SCHEMA_VERSION,
            plan_sha256: plan.plan_sha256,
            shortcuts_path: plan.shortcuts_path,
            before_sha256: Some(before_sha256),
            after_sha256: plan.proposed_sha256,
            backup_path: Some(backup_path),
        };
        fs::write(
            config.join(JOURNAL_FILE),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        fs::write(config.join(REPLACEMENT_TEMPORARY_FILE), proposed).unwrap();
        fs::write(config.join(ORIGINAL_SWAP_FILE), []).unwrap();

        assert_eq!(
            recover_steam_entries(&fixture.steam_root, "12345").unwrap(),
            SteamEntryRecoveryOutcome::AbandonedBeforeCommit
        );
        assert_eq!(fs::read(fixture.shortcuts()).unwrap(), original);
        assert!(!config.join(JOURNAL_FILE).exists());
        assert!(!config.join(REPLACEMENT_TEMPORARY_FILE).exists());
        assert!(!config.join(ORIGINAL_SWAP_FILE).exists());
    }

    #[test]
    fn malformed_or_ambiguous_shortcuts_fail_closed() {
        let fixture = Fixture::new();
        fs::write(fixture.shortcuts(), [0x07, b'x', 0, 0x08]).unwrap();
        assert!(matches!(
            plan_steam_entries(fixture.remove_request(&["starship"])),
            Err(SteamEntryError::Malformed(_))
        ));
        let ambiguous = VdfDocument {
            fields: vec![
                VdfField {
                    key: "shortcuts".into(),
                    value: VdfValue::Object(Vec::new()),
                },
                VdfField {
                    key: "Shortcuts".into(),
                    value: VdfValue::Object(Vec::new()),
                },
            ],
        };
        fs::write(fixture.shortcuts(), ambiguous.encode().unwrap()).unwrap();
        assert!(matches!(
            plan_steam_entries(fixture.remove_request(&["starship"])),
            Err(SteamEntryError::Conflict(_))
        ));
    }

    #[test]
    fn mismatched_content_addressed_backup_blocks_replacement() {
        let fixture = Fixture::new();
        let add =
            plan_steam_entries(fixture.add_request(vec![game("starship", "Starship")])).unwrap();
        apply_steam_entry_plan(&add, SteamClientState::Closed).unwrap();
        let moved_cli = fixture.cli_path.parent().unwrap().join("moved.exe");
        write_cli(&moved_cli, b"moved fixture cli");
        let repair_request = match add.request {
            SteamEntryPlanRequest::AddOrRepair {
                steam_root,
                steam_user_id,
                library_id,
                library_root,
                games,
                ..
            } => SteamEntryPlanRequest::AddOrRepair {
                steam_root,
                steam_user_id,
                library_id,
                library_root,
                cli: cli_identity(&moved_cli),
                games,
            },
            _ => unreachable!(),
        };
        let repair = plan_steam_entries(repair_request).unwrap();
        let original = fs::read(fixture.shortcuts()).unwrap();
        let backup = fixture.config.join(format!(
            "shortcuts.vdf.portcove-backup-{}",
            repair.snapshot_sha256.as_deref().unwrap()
        ));
        fs::write(&backup, b"wrong bytes").unwrap();
        assert!(matches!(
            apply_steam_entry_plan(&repair, SteamClientState::Closed),
            Err(SteamEntryError::Conflict(_))
        ));
        assert_eq!(fs::read(fixture.shortcuts()).unwrap(), original);
        assert!(!fixture.config.join(JOURNAL_FILE).exists());
    }

    #[test]
    fn planned_candidate_must_remain_within_the_parser_byte_limit() {
        let fixture = Fixture::new();
        let oversized_name = "x".repeat(MAX_SHORTCUTS_BYTES as usize);
        assert!(matches!(
            plan_steam_entries(fixture.add_request(vec![game("starship", &oversized_name)])),
            Err(SteamEntryError::InvalidInput(message))
                if message.contains("byte safety limit")
        ));
        assert!(!fixture.shortcuts().exists());
    }

    #[test]
    fn planned_candidate_must_remain_within_the_parser_field_limit() {
        let fixture = Fixture::new();
        let entries = (0..(MAX_VDF_FIELDS - 1))
            .map(|index| VdfField {
                key: index.to_string(),
                value: VdfValue::Object(Vec::new()),
            })
            .collect();
        let document = VdfDocument {
            fields: vec![VdfField {
                key: "shortcuts".into(),
                value: VdfValue::Object(entries),
            }],
        };
        fs::write(fixture.shortcuts(), document.encode().unwrap()).unwrap();
        assert!(matches!(
            plan_steam_entries(
                fixture.add_request(vec![game("starship", "Starship")])
            ),
            Err(SteamEntryError::Malformed(message))
                if message.contains("field count exceeds")
        ));
    }

    #[test]
    fn colliding_canonical_app_ids_fail_before_any_write() {
        let fixture = Fixture::new();
        let request = fixture.add_request(vec![
            game("starship", "Shared Steam title"),
            game("soh", "Shared Steam title"),
        ]);
        assert!(matches!(
            plan_steam_entries(request),
            Err(SteamEntryError::Conflict(message)) if message.contains("AppID")
        ));
        assert!(!fixture.shortcuts().exists());
    }

    #[test]
    fn publication_restores_a_concurrent_external_edit_without_clobbering_it() {
        let fixture = Fixture::new();
        let add =
            plan_steam_entries(fixture.add_request(vec![game("starship", "Starship")])).unwrap();
        apply_steam_entry_plan(&add, SteamClientState::Closed).unwrap();

        let moved_cli = fixture.cli_path.parent().unwrap().join("moved.exe");
        write_cli(&moved_cli, b"moved fixture cli");
        let repair_request = SteamEntryPlanRequest::AddOrRepair {
            steam_root: fixture.steam_root.clone(),
            steam_user_id: "12345".into(),
            library_id: "library-123".into(),
            library_root: fixture.library_root.clone(),
            cli: cli_identity(&moved_cli),
            games: vec![game("starship", "Starship")],
        };
        let repair = plan_steam_entries(repair_request).unwrap();
        let mut external = VdfDocument::parse(&fs::read(fixture.shortcuts()).unwrap()).unwrap();
        shortcut_fields_mut(&mut external.shortcuts_mut().unwrap()[0])
            .unwrap()
            .push(string_field("ExternalEdit", "preserve me"));
        let external_bytes = external.encode().unwrap();

        let result =
            apply_steam_entry_plan_with_hook(&repair, SteamClientState::Closed, |shortcuts_path| {
                fs::write(shortcuts_path, &external_bytes).unwrap()
            });
        assert!(matches!(result, Err(SteamEntryError::Conflict(_))));
        assert_eq!(fs::read(fixture.shortcuts()).unwrap(), external_bytes);
        assert!(!fixture.config.join(JOURNAL_FILE).exists());
        assert!(!fixture.config.join(REPLACEMENT_TEMPORARY_FILE).exists());
        assert!(!fixture.config.join(ORIGINAL_SWAP_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_content_addressed_backup_is_never_followed() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let add =
            plan_steam_entries(fixture.add_request(vec![game("starship", "Starship")])).unwrap();
        apply_steam_entry_plan(&add, SteamClientState::Closed).unwrap();
        let original = fs::read(fixture.shortcuts()).unwrap();
        let moved_cli = fixture.cli_path.parent().unwrap().join("moved.exe");
        write_cli(&moved_cli, b"moved fixture cli");
        let repair = plan_steam_entries(SteamEntryPlanRequest::AddOrRepair {
            steam_root: fixture.steam_root.clone(),
            steam_user_id: "12345".into(),
            library_id: "library-123".into(),
            library_root: fixture.library_root.clone(),
            cli: cli_identity(&moved_cli),
            games: vec![game("starship", "Starship")],
        })
        .unwrap();
        let backup = fixture.config.join(format!(
            "shortcuts.vdf.portcove-backup-{}",
            repair.snapshot_sha256.as_deref().unwrap()
        ));
        symlink(fixture.shortcuts(), &backup).unwrap();

        assert!(matches!(
            apply_steam_entry_plan(&repair, SteamClientState::Closed),
            Err(SteamEntryError::Conflict(_))
        ));
        assert_eq!(fs::read(fixture.shortcuts()).unwrap(), original);
        assert!(!fixture.config.join(JOURNAL_FILE).exists());
    }
}
