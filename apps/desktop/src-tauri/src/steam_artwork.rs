//! Reviewed, owned Steam destination artwork for Portcove shortcuts.
//!
//! Steam reads custom library art for a non-Steam shortcut from the selected
//! profile's `config/grid` folder, named from the shortcut AppID. Like
//! `shortcuts.vdf`, that layout is a reverse-engineered compatibility boundary
//! rather than a documented Valve writing API. This module therefore:
//!
//! - writes only for a shortcut carrying this library and port's ownership
//!   marker, and only from validated local original bytes supplied by Core's
//!   destination artwork handoff (never a cache path or provider URL);
//! - fills missing roles by default and replaces existing art only when the
//!   review explicitly asked for replacement;
//! - records each file it publishes in a small destination-local ownership
//!   record, and cleans up only a recorded file whose bytes are unchanged;
//! - publishes through no-clobber evacuation and renames with a recovery
//!   journal and content-addressed backups of every file it displaces.

pub use crate::desktop_contract::SteamArtworkRecovery;
use crate::desktop_contract::{
    SteamArtworkApplyResult, SteamArtworkOperation, SteamArtworkRoleAction, SteamArtworkRoleChange,
    SteamClientState,
};
use crate::steam_entries::{
    Result, SteamEntryError, io_error, lock_profile, owned_shortcut_app_id, ownership_marker,
    read_regular_file_bounded, rename_noreplace, sha256, shortcut_operation_pending,
    steam_profile_config, sync_directory_if_supported, validate_identity, validate_port_id,
    write_named_backup,
};
use portcove_core::{
    ArtworkImageFormat, DestinationArtworkRole, DestinationArtworkUnavailableReason,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub const ARTWORK_PLAN_SCHEMA_VERSION: u32 = 1;
const OWNERSHIP_SCHEMA_VERSION: u32 = 1;
const JOURNAL_SCHEMA_VERSION: u32 = 1;
const GRID_DIRECTORY: &str = "grid";
const OWNERSHIP_FILE: &str = "portcove-steam-artwork.json";
const OWNERSHIP_TEMPORARY_FILE: &str = "portcove-steam-artwork.json.tmp";
const JOURNAL_FILE: &str = "portcove-steam-artwork.journal.json";
const JOURNAL_TEMPORARY_FILE: &str = "portcove-steam-artwork.journal.tmp";
const STAGED_SUFFIX: &str = ".portcove-staged.tmp";
const SWAP_SUFFIX: &str = ".portcove-original.tmp";
/// Matches Core's bounded accepted-original limit.
const MAX_ARTWORK_BYTES: u64 = 16 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_OWNERSHIP_RECORDS: usize = 4096;
/// Extensions Steam is known to read for grid art; any of them occupies a role.
const KNOWN_EXTENSIONS: [&str; 3] = ["png", "jpg", "jpeg"];
pub const ROLES: [DestinationArtworkRole; 3] = [
    DestinationArtworkRole::PortraitCover,
    DestinationArtworkRole::LandscapeCover,
    DestinationArtworkRole::HeroBanner,
];

/// Role content observed through Core's destination handoff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SteamArtworkRoleContent {
    Available {
        asset_sha256: String,
        format: ArtworkImageFormat,
        bytes: Vec<u8>,
    },
    Unavailable {
        reason: DestinationArtworkUnavailableReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SteamArtworkPlanRequest {
    pub steam_root: PathBuf,
    pub steam_user_id: String,
    pub library_id: String,
    pub port_id: String,
    pub operation: SteamArtworkOperation,
    /// One entry per role for Update; ignored by the removal operations.
    pub roles: Vec<(DestinationArtworkRole, SteamArtworkRoleContent)>,
    /// For Update reviewed together with a shortcut Add: the AppID that the
    /// reviewed shortcut plan gives this game's owned entry. The shortcut file
    /// itself is then bound by that plan, not by this one.
    pub planned_app_id: Option<u32>,
    /// Set after the reviewed shortcut was written: the planned AppID must now
    /// belong to an existing owned shortcut.
    pub require_written_shortcut: bool,
}

/// A byte-free reviewed plan. Apply re-derives it from fresh inputs and
/// requires exact equality before writing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SteamArtworkPlan {
    pub schema_version: u32,
    pub steam_root: PathBuf,
    pub steam_user_id: String,
    pub library_id: String,
    pub port_id: String,
    pub operation: SteamArtworkOperation,
    pub grid_path: PathBuf,
    pub app_id: Option<u32>,
    pub shortcuts_sha256: Option<String>,
    pub ownership_sha256: Option<String>,
    pub roles: Vec<SteamArtworkRoleChange>,
    pub plan_sha256: String,
    /// This entry's records after the change; records for other games and
    /// AppIDs are neither bound nor rewritten, so selected games can be
    /// updated one after another from separately reviewed plans.
    #[serde(skip)]
    ownership_after: Vec<OwnershipRecord>,
    #[serde(skip)]
    ownership_scope: Vec<u32>,
    /// Every observed destination variant and digest, including roles whose
    /// reported state is a preserved ambiguity; equality binds them all.
    #[serde(skip)]
    observed_variants: Vec<ObservedVariant>,
    /// For each planned role whose Portcove-owned file is still exactly the
    /// recorded bytes: the Core image it was written from. Derived only from
    /// the bound records and observed digests, so it never changes the plan.
    #[serde(skip)]
    owned_sources: Vec<(DestinationArtworkRole, String)>,
}

impl SteamArtworkPlan {
    pub fn writes_required(&self) -> bool {
        self.roles.iter().any(|role| {
            matches!(
                role.action,
                SteamArtworkRoleAction::Write
                    | SteamArtworkRoleAction::Replace
                    | SteamArtworkRoleAction::Remove
            )
        }) || self.ownership_changes()
    }

    fn ownership_changes(&self) -> bool {
        self.roles.iter().any(|role| role.forget_ownership)
    }

    /// The source image of each planned, still-unchanged Portcove-owned file.
    pub fn owned_sources(&self) -> &[(DestinationArtworkRole, String)] {
        &self.owned_sources
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnershipRecord {
    marker: String,
    app_id: u32,
    role: DestinationArtworkRole,
    file_name: String,
    sha256: String,
    source_asset_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnershipDocument {
    schema_version: u32,
    records: Vec<OwnershipRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalStep {
    role: DestinationArtworkRole,
    app_id: u32,
    before_path: Option<PathBuf>,
    before_sha256: Option<String>,
    backup_path: Option<PathBuf>,
    swap_path: PathBuf,
    staged_path: Option<PathBuf>,
    after_path: Option<PathBuf>,
    after_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtworkJournal {
    schema_version: u32,
    plan_sha256: String,
    marker: String,
    grid_path: PathBuf,
    steps: Vec<JournalStep>,
    ownership_before: Vec<OwnershipRecord>,
    ownership_after: Vec<OwnershipRecord>,
}

/// An observed destination path and its digest when it is readable.
type ObservedVariant = (PathBuf, Option<String>);

struct ExistingVariant {
    path: PathBuf,
    /// `None` when the path is not an independent bounded regular file.
    sha256: Option<String>,
}

pub fn plan_steam_artwork(request: &SteamArtworkPlanRequest) -> Result<SteamArtworkPlan> {
    validate_identity(&request.library_id, "library identity")?;
    validate_port_id(&request.port_id)?;
    let config = steam_profile_config(&request.steam_root, &request.steam_user_id)?;
    require_settled(&config)?;
    let grid_path = config.join(GRID_DIRECTORY);
    require_grid_directory(&grid_path)?;
    let marker = ownership_marker(&request.library_id, &request.port_id)?;
    let (_, ownership_before) = read_ownership(&config)?;
    let mut ownership_after = ownership_before.clone();
    let mut roles = Vec::new();
    let mut observed_variants = Vec::new();
    let (shortcuts_sha256, app_id) = match request.operation {
        SteamArtworkOperation::Update { replace_existing } => {
            let (shortcuts_sha256, current_app_id) =
                owned_shortcut_app_id(&config, &request.library_id, &request.port_id)?;
            let app_id = match (request.planned_app_id, current_app_id) {
                (Some(planned), None) if !request.require_written_shortcut => planned,
                (Some(_), None) => {
                    return Err(SteamEntryError::Conflict(
                        "this game's new Steam shortcut is no longer present".into(),
                    ));
                }
                (Some(planned), Some(current)) if planned == current => current,
                (Some(_), Some(_)) => {
                    return Err(SteamEntryError::Conflict(
                        "this game's Steam shortcut changed after review".into(),
                    ));
                }
                (None, Some(current)) => current,
                (None, None) => {
                    return Err(SteamEntryError::InvalidInput(
                        "this game has no Portcove shortcut in the selected Steam profile; add the shortcut before updating its artwork".into(),
                    ));
                }
            };
            let shortcuts_sha256 = shortcuts_sha256.filter(|_| request.planned_app_id.is_none());
            require_complete_roles(&request.roles)?;
            for (role, content) in &request.roles {
                let (change, observed) = plan_update_role(
                    &grid_path,
                    app_id,
                    *role,
                    content,
                    replace_existing,
                    &marker,
                    &mut ownership_after,
                )?;
                roles.push(change);
                observed_variants.extend(observed);
            }
            (shortcuts_sha256, Some(app_id))
        }
        SteamArtworkOperation::RemoveOwned => {
            for role in ROLES {
                roles.push(plan_remove_role(
                    &grid_path,
                    role,
                    &marker,
                    &mut ownership_after,
                )?);
            }
            let app_id = ownership_before
                .iter()
                .find(|record| record.marker == marker)
                .map(|record| record.app_id);
            (None, app_id)
        }
        SteamArtworkOperation::RemoveOwnedRole { role } => {
            roles.push(plan_remove_role(
                &grid_path,
                role,
                &marker,
                &mut ownership_after,
            )?);
            let app_id = ownership_before
                .iter()
                .find(|record| record.marker == marker && record.role == role)
                .map(|record| record.app_id);
            (None, app_id)
        }
    };
    let owned_sources = roles
        .iter()
        .filter_map(|change| {
            let record = ownership_before
                .iter()
                .find(|record| record.marker == marker && record.role == change.role)?;
            let path = grid_path.join(&record.file_name);
            (change.existing_sha256.as_deref() == Some(record.sha256.as_str())
                && change
                    .existing_paths
                    .iter()
                    .any(|existing| *existing == path))
            .then(|| (change.role, record.source_asset_sha256.clone()))
        })
        .collect::<Vec<_>>();
    let mut ownership_scope = ownership_before
        .iter()
        .filter(|record| record.marker == marker)
        .map(|record| record.app_id)
        .chain(app_id)
        .collect::<Vec<_>>();
    ownership_scope.sort_unstable();
    ownership_scope.dedup();
    let in_scope = |record: &OwnershipRecord| in_ownership_scope(record, &marker, &ownership_scope);
    let relevant_before = ownership_before
        .iter()
        .filter(|record| in_scope(record))
        .collect::<Vec<_>>();
    let ownership_sha256 = (!relevant_before.is_empty())
        .then(|| serde_json::to_vec(&relevant_before).map(|bytes| sha256(&bytes)))
        .transpose()?;
    let ownership_after = ownership_after
        .into_iter()
        .filter(|record| in_scope(record))
        .collect::<Vec<_>>();
    let mut plan = SteamArtworkPlan {
        schema_version: ARTWORK_PLAN_SCHEMA_VERSION,
        steam_root: request.steam_root.clone(),
        steam_user_id: request.steam_user_id.clone(),
        library_id: request.library_id.clone(),
        port_id: request.port_id.clone(),
        operation: request.operation,
        grid_path,
        app_id,
        shortcuts_sha256,
        ownership_sha256,
        roles,
        plan_sha256: String::new(),
        ownership_after,
        ownership_scope,
        observed_variants,
        owned_sources,
    };
    // The reviewed hash also binds the internal ownership result and every
    // observed destination variant, not only the reported role changes.
    plan.plan_sha256 = sha256(&serde_json::to_vec(&(
        &plan,
        &plan.ownership_after,
        &plan.observed_variants,
    ))?);
    Ok(plan)
}

fn in_ownership_scope(record: &OwnershipRecord, marker: &str, app_ids: &[u32]) -> bool {
    record.marker == marker || app_ids.contains(&record.app_id)
}

pub fn apply_steam_artwork_plan(
    reviewed: &SteamArtworkPlan,
    request: &SteamArtworkPlanRequest,
    client_state: SteamClientState,
) -> Result<SteamArtworkApplyResult> {
    if reviewed.schema_version != ARTWORK_PLAN_SCHEMA_VERSION {
        return Err(SteamEntryError::InvalidInput(format!(
            "Steam artwork plan schema {} is unsupported",
            reviewed.schema_version
        )));
    }
    match client_state {
        SteamClientState::Closed => {}
        SteamClientState::Running => {
            return Err(SteamEntryError::Conflict(
                "Steam is running; close it and review the artwork plan again".into(),
            ));
        }
        SteamClientState::Unknown => {
            return Err(SteamEntryError::Conflict(
                "Steam process state is unknown; no Steam artwork was changed".into(),
            ));
        }
    }
    let config = steam_profile_config(&request.steam_root, &request.steam_user_id)?;
    let _lock = lock_profile(&config)?;
    let current = plan_steam_artwork(request)?;
    if current != *reviewed {
        return Err(SteamEntryError::Conflict(
            "the Steam profile, owned shortcut, existing artwork, or selected Portcove artwork changed after review".into(),
        ));
    }
    if !current.writes_required() {
        return Ok(SteamArtworkApplyResult {
            plan_sha256: current.plan_sha256,
            roles: current.roles,
            backup_paths: Vec::new(),
            wrote: false,
        });
    }
    let journal = prepare_publication(&config, &current, request)?;
    let journal_path = config.join(JOURNAL_FILE);
    for step in &journal.steps {
        if let Err(error) = execute_step(step) {
            // Settle any completed steps and restore an evacuated original.
            return match settle_journal(&config, &journal) {
                Ok(_) => Err(error),
                Err(settle_error) => Err(SteamEntryError::RecoveryRequired(format!(
                    "{error}; settling the interrupted artwork publication also failed: {settle_error}; {} was preserved",
                    journal_path.display()
                ))),
            };
        }
    }
    write_ownership(&config, &journal.ownership_after)?;
    remove_journal(&config)?;
    Ok(SteamArtworkApplyResult {
        plan_sha256: current.plan_sha256,
        roles: current.roles,
        backup_paths: journal
            .steps
            .iter()
            .filter_map(|step| step.backup_path.clone())
            .collect(),
        wrote: true,
    })
}

/// Settles an interrupted artwork publication for the selected profile. Each
/// role either completed or is returned to its exact prior file; anything that
/// matches neither is preserved and reported.
pub fn recover_steam_artwork(
    steam_root: &Path,
    steam_user_id: &str,
) -> Result<Option<SteamArtworkRecovery>> {
    let config = steam_profile_config(steam_root, steam_user_id)?;
    if [JOURNAL_FILE, JOURNAL_TEMPORARY_FILE]
        .iter()
        .all(|name| fs::symlink_metadata(config.join(name)).is_err())
    {
        return Ok(None);
    }
    let _lock = lock_profile(&config)?;
    // An unpublished journal temporary precedes every staged or destination
    // write, so discarding it changes no artwork.
    let journal_temporary = config.join(JOURNAL_TEMPORARY_FILE);
    if read_regular_file_bounded(
        &journal_temporary,
        "Steam artwork journal temporary file",
        MAX_METADATA_BYTES,
    )?
    .is_some()
    {
        fs::remove_file(&journal_temporary)
            .map_err(|source| io_error("removing the unpublished Steam artwork journal", source))?;
        sync_directory_if_supported(&config)?;
    }
    let Some(bytes) = read_regular_file_bounded(
        &config.join(JOURNAL_FILE),
        "Steam artwork recovery journal",
        MAX_METADATA_BYTES,
    )?
    else {
        return Ok(None);
    };
    let journal: ArtworkJournal = serde_json::from_slice(&bytes)?;
    if journal.schema_version != JOURNAL_SCHEMA_VERSION
        || journal.grid_path != config.join(GRID_DIRECTORY)
    {
        return Err(SteamEntryError::RecoveryRequired(
            "the Steam artwork recovery journal has an unsupported identity".into(),
        ));
    }
    settle_journal(&config, &journal).map(Some)
}

fn require_settled(config: &Path) -> Result<()> {
    if shortcut_operation_pending(config) {
        return Err(SteamEntryError::RecoveryRequired(
            "an interrupted Steam shortcut change must be recovered first".into(),
        ));
    }
    if fs::symlink_metadata(config.join(JOURNAL_FILE)).is_ok()
        || fs::symlink_metadata(config.join(JOURNAL_TEMPORARY_FILE)).is_ok()
    {
        return Err(SteamEntryError::RecoveryRequired(
            "an interrupted Steam artwork change must be recovered first".into(),
        ));
    }
    Ok(())
}

fn require_grid_directory(grid: &Path) -> Result<()> {
    match fs::symlink_metadata(grid) {
        Ok(metadata) if metadata.is_dir() && !is_link_like(&metadata) => Ok(()),
        Ok(_) => Err(SteamEntryError::Conflict(format!(
            "Steam artwork folder {} is not an independent directory",
            grid.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(io_error("inspecting the Steam artwork folder", source)),
    }
}

fn is_link_like(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn require_complete_roles(
    roles: &[(DestinationArtworkRole, SteamArtworkRoleContent)],
) -> Result<()> {
    if roles.len() != ROLES.len() || roles.iter().map(|(role, _)| *role).ne(ROLES) {
        return Err(SteamEntryError::InvalidInput(
            "Steam artwork review must describe portrait, landscape and hero roles in order".into(),
        ));
    }
    for (_, content) in roles {
        if let SteamArtworkRoleContent::Available {
            asset_sha256,
            bytes,
            ..
        } = content
            && (bytes.is_empty()
                || bytes.len() as u64 > MAX_ARTWORK_BYTES
                || sha256(bytes) != *asset_sha256)
        {
            return Err(SteamEntryError::InvalidInput(
                "Steam artwork bytes do not match their accepted Portcove original".into(),
            ));
        }
    }
    Ok(())
}

fn role_stem(app_id: u32, role: DestinationArtworkRole) -> String {
    match role {
        DestinationArtworkRole::PortraitCover => format!("{app_id}p"),
        DestinationArtworkRole::LandscapeCover => app_id.to_string(),
        DestinationArtworkRole::HeroBanner => format!("{app_id}_hero"),
    }
}

fn format_extension(format: ArtworkImageFormat) -> &'static str {
    match format {
        ArtworkImageFormat::Png => "png",
        ArtworkImageFormat::Jpeg => "jpg",
    }
}

fn observe_variants(grid: &Path, stem: &str) -> Result<Vec<ExistingVariant>> {
    let mut variants = Vec::new();
    for extension in KNOWN_EXTENSIONS {
        let path = grid.join(format!("{stem}.{extension}"));
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                let sha256 = if metadata.is_file()
                    && !is_link_like(&metadata)
                    && metadata.len() <= MAX_ARTWORK_BYTES
                {
                    read_regular_file_bounded(&path, "existing Steam artwork", MAX_ARTWORK_BYTES)?
                        .map(|bytes| sha256(&bytes))
                } else {
                    None
                };
                // Case-insensitive file systems report one file under each
                // spelling; keep it once. Only lower-case extensions are probed.
                if !variants
                    .iter()
                    .any(|existing: &ExistingVariant| same_file(&existing.path, &path))
                {
                    variants.push(ExistingVariant { path, sha256 });
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(io_error("inspecting existing Steam artwork", source)),
        }
        for suffix in [STAGED_SUFFIX, SWAP_SUFFIX] {
            let leftover = grid.join(format!(".{stem}.{extension}{suffix}"));
            if fs::symlink_metadata(&leftover).is_ok() {
                return Err(SteamEntryError::RecoveryRequired(format!(
                    "orphaned Steam artwork operation file {} exists without a journal",
                    leftover.display()
                )));
            }
        }
    }
    Ok(variants)
}

#[cfg(unix)]
fn same_inode(left: &Path, right: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(left), fs::symlink_metadata(right)) {
        (Ok(left), Ok(right)) => left.dev() == right.dev() && left.ino() == right.ino(),
        _ => false,
    }
}

/// Windows publication is a single atomic move, so a remaining staged name
/// never aliases the destination.
#[cfg(not(unix))]
fn same_inode(_left: &Path, _right: &Path) -> bool {
    false
}

fn same_file(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn plan_update_role(
    grid: &Path,
    app_id: u32,
    role: DestinationArtworkRole,
    content: &SteamArtworkRoleContent,
    replace_existing: bool,
    marker: &str,
    ownership: &mut Vec<OwnershipRecord>,
) -> Result<(SteamArtworkRoleChange, Vec<ObservedVariant>)> {
    if let Some(previous) = ownership
        .iter()
        .find(|record| record.marker == marker && record.role == role && record.app_id != app_id)
    {
        return Err(SteamEntryError::Conflict(format!(
            "Portcove artwork {} belongs to an earlier shortcut for this game; review artwork removal first",
            previous.file_name
        )));
    }
    let stem = role_stem(app_id, role);
    let variants = observe_variants(grid, &stem)?;
    let observed = variants
        .iter()
        .map(|variant| (variant.path.clone(), variant.sha256.clone()))
        .collect::<Vec<_>>();
    let mut change = SteamArtworkRoleChange {
        role,
        action: SteamArtworkRoleAction::Unavailable,
        destination_path: None,
        existing_paths: variants
            .iter()
            .map(|variant| variant.path.clone())
            .collect(),
        existing_sha256: match variants.as_slice() {
            [only] => only.sha256.clone(),
            _ => None,
        },
        proposed_sha256: None,
        unavailable_reason: None,
        forget_ownership: false,
    };
    let (asset_sha256, format) = match content {
        SteamArtworkRoleContent::Unavailable { reason } => {
            change.unavailable_reason = Some(*reason);
            return Ok((change, observed));
        }
        SteamArtworkRoleContent::Available {
            asset_sha256,
            format,
            ..
        } => (asset_sha256, *format),
    };
    let file_name = format!("{stem}.{}", format_extension(format));
    let destination = grid.join(&file_name);
    change.destination_path = Some(destination.clone());
    change.proposed_sha256 = Some(asset_sha256.clone());
    change.action = match variants.as_slice() {
        [] => SteamArtworkRoleAction::Write,
        [only]
            if only.sha256.as_deref() == Some(asset_sha256.as_str())
                && same_file(&only.path, &destination) =>
        {
            SteamArtworkRoleAction::Unchanged
        }
        [only] if replace_existing && only.sha256.is_some() => SteamArtworkRoleAction::Replace,
        _ => SteamArtworkRoleAction::Preserve,
    };
    if matches!(
        change.action,
        SteamArtworkRoleAction::Write | SteamArtworkRoleAction::Replace
    ) {
        ownership.retain(|record| !(record.marker == marker && record.role == role));
        ownership.retain(|record| !(record.app_id == app_id && record.role == role));
        ownership.push(OwnershipRecord {
            marker: marker.into(),
            app_id,
            role,
            file_name,
            sha256: asset_sha256.clone(),
            source_asset_sha256: asset_sha256.clone(),
        });
    }
    Ok((change, observed))
}

fn plan_remove_role(
    grid: &Path,
    role: DestinationArtworkRole,
    marker: &str,
    ownership: &mut Vec<OwnershipRecord>,
) -> Result<SteamArtworkRoleChange> {
    let record = ownership
        .iter()
        .find(|record| record.marker == marker && record.role == role)
        .cloned();
    let mut change = SteamArtworkRoleChange {
        role,
        action: SteamArtworkRoleAction::Absent,
        destination_path: None,
        existing_paths: Vec::new(),
        existing_sha256: None,
        proposed_sha256: None,
        unavailable_reason: None,
        forget_ownership: false,
    };
    let Some(record) = record else {
        return Ok(change);
    };
    // Every remaining record for this entry and role is forgotten: an unchanged
    // file is removed, while a missing or modified file is no longer Portcove's.
    ownership.retain(|candidate| !(candidate.marker == marker && candidate.role == role));
    change.forget_ownership = true;
    let path = grid.join(&record.file_name);
    // Scan this role's variants only to refuse orphaned operation files.
    observe_variants(grid, &role_stem(record.app_id, role))?;
    change.destination_path = Some(path.clone());
    let observed = match fs::symlink_metadata(&path) {
        Ok(metadata)
            if metadata.is_file()
                && !is_link_like(&metadata)
                && metadata.len() <= MAX_ARTWORK_BYTES =>
        {
            read_regular_file_bounded(&path, "owned Steam artwork", MAX_ARTWORK_BYTES)?
                .map(|bytes| sha256(&bytes))
        }
        Ok(_) => Some(String::new()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(change);
        }
        Err(source) => return Err(io_error("inspecting owned Steam artwork", source)),
    };
    change.existing_paths = vec![path];
    change.existing_sha256 = observed.clone().filter(|digest| !digest.is_empty());
    change.action = if observed.as_deref() == Some(record.sha256.as_str()) {
        SteamArtworkRoleAction::Remove
    } else {
        SteamArtworkRoleAction::PreserveModified
    };
    Ok(change)
}

fn validate_record(record: &OwnershipRecord) -> Result<()> {
    let invalid =
        || SteamEntryError::Malformed("the Portcove Steam artwork record is invalid".into());
    if !record.marker.starts_with("portcove:v1:")
        || record.sha256.len() != 64
        || record.source_asset_sha256.len() != 64
    {
        return Err(invalid());
    }
    let stem = role_stem(record.app_id, record.role);
    let valid_name = KNOWN_EXTENSIONS
        .iter()
        .any(|extension| record.file_name == format!("{stem}.{extension}"));
    if !valid_name {
        return Err(invalid());
    }
    Ok(())
}

fn read_ownership(config: &Path) -> Result<(Option<String>, Vec<OwnershipRecord>)> {
    let Some(bytes) = read_regular_file_bounded(
        &config.join(OWNERSHIP_FILE),
        "Portcove Steam artwork record",
        MAX_METADATA_BYTES,
    )?
    else {
        return Ok((None, Vec::new()));
    };
    let document: OwnershipDocument = serde_json::from_slice(&bytes).map_err(|_| {
        SteamEntryError::Malformed("the Portcove Steam artwork record is invalid".into())
    })?;
    if document.schema_version != OWNERSHIP_SCHEMA_VERSION
        || document.records.len() > MAX_OWNERSHIP_RECORDS
    {
        return Err(SteamEntryError::Malformed(
            "the Portcove Steam artwork record has an unsupported version or size".into(),
        ));
    }
    for (index, record) in document.records.iter().enumerate() {
        validate_record(record)?;
        if document.records[..index].iter().any(|earlier| {
            earlier.role == record.role
                && (earlier.marker == record.marker || earlier.app_id == record.app_id)
        }) {
            return Err(SteamEntryError::Malformed(
                "the Portcove Steam artwork record claims one role twice".into(),
            ));
        }
    }
    Ok((Some(sha256(&bytes)), document.records))
}

fn write_ownership(config: &Path, records: &[OwnershipRecord]) -> Result<()> {
    if records.len() > MAX_OWNERSHIP_RECORDS {
        return Err(SteamEntryError::Conflict(
            "the Portcove Steam artwork record would exceed its size limit".into(),
        ));
    }
    let document = OwnershipDocument {
        schema_version: OWNERSHIP_SCHEMA_VERSION,
        records: records.to_vec(),
    };
    crate::application_update_storage::write_bytes_atomically(
        config,
        OWNERSHIP_TEMPORARY_FILE,
        OWNERSHIP_FILE,
        &serde_json::to_vec_pretty(&document)?,
    )
    .map_err(|source| io_error("publishing the Portcove Steam artwork record", source))
}

fn remove_journal(config: &Path) -> Result<()> {
    fs::remove_file(config.join(JOURNAL_FILE))
        .map_err(|source| io_error("removing the Steam artwork recovery journal", source))?;
    sync_directory_if_supported(config)
}

fn prepare_publication(
    config: &Path,
    plan: &SteamArtworkPlan,
    request: &SteamArtworkPlanRequest,
) -> Result<ArtworkJournal> {
    let grid = &plan.grid_path;
    let publishes = plan.roles.iter().any(|role| {
        matches!(
            role.action,
            SteamArtworkRoleAction::Write | SteamArtworkRoleAction::Replace
        )
    });
    if publishes {
        match fs::create_dir(grid) {
            Ok(()) => sync_directory_if_supported(config)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(source) => return Err(io_error("creating the Steam artwork folder", source)),
        }
        require_grid_directory(grid)?;
    }
    let (_, ownership_before) = read_ownership(config)?;
    let marker = ownership_marker(&plan.library_id, &plan.port_id)?;
    let mut steps = Vec::new();
    let mut staged = Vec::new();
    for change in &plan.roles {
        let (before_path, before_sha256) = match change.action {
            SteamArtworkRoleAction::Replace | SteamArtworkRoleAction::Remove => (
                change.existing_paths.first().cloned(),
                change.existing_sha256.clone(),
            ),
            SteamArtworkRoleAction::Write => (None, None),
            _ => continue,
        };
        let backup_path = match (&before_path, &before_sha256) {
            (Some(path), Some(digest)) => {
                let bytes = read_regular_file_bounded(path, "Steam artwork", MAX_ARTWORK_BYTES)?
                    .ok_or_else(|| {
                        SteamEntryError::Conflict(format!(
                            "{} disappeared after review",
                            path.display()
                        ))
                    })?;
                if sha256(&bytes) != *digest {
                    return Err(SteamEntryError::Conflict(format!(
                        "{} changed after review",
                        path.display()
                    )));
                }
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("bin");
                Some(write_named_backup(
                    config,
                    &format!("portcove-steam-artwork-backup-{digest}.{extension}"),
                    &bytes,
                )?)
            }
            _ => None,
        };
        let name_source = before_path
            .as_ref()
            .or(change.destination_path.as_ref())
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                SteamEntryError::InvalidInput("Steam artwork path has no file name".into())
            })?
            .to_owned();
        let swap_path = grid.join(format!(".{name_source}{SWAP_SUFFIX}"));
        let (staged_path, after_path, after_sha256) = match change.action {
            SteamArtworkRoleAction::Write | SteamArtworkRoleAction::Replace => {
                let destination = change.destination_path.clone().ok_or_else(|| {
                    SteamEntryError::InvalidInput("Steam artwork plan has no destination".into())
                })?;
                let destination_name = destination
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned();
                let bytes = role_bytes(request, change.role)?;
                let staged_path = grid.join(format!(".{destination_name}{STAGED_SUFFIX}"));
                staged.push((staged_path.clone(), bytes));
                (
                    Some(staged_path),
                    Some(destination),
                    change.proposed_sha256.clone(),
                )
            }
            _ => (None, None, None),
        };
        let app_id = match change.action {
            SteamArtworkRoleAction::Remove => ownership_before
                .iter()
                .find(|record| record.marker == marker && record.role == change.role)
                .map(|record| record.app_id),
            _ => plan.app_id,
        }
        .ok_or_else(|| {
            SteamEntryError::InvalidInput("Steam artwork plan has no shortcut AppID".into())
        })?;
        steps.push(JournalStep {
            role: change.role,
            app_id,
            before_path,
            before_sha256,
            backup_path,
            swap_path,
            staged_path,
            after_path,
            after_sha256,
        });
    }
    // Merge this entry's reviewed records into the record as it is now; the
    // re-plan under the lock already proved the in-scope part is unchanged.
    let ownership_after = ownership_before
        .iter()
        .filter(|record| !in_ownership_scope(record, &marker, &plan.ownership_scope))
        .cloned()
        .chain(plan.ownership_after.iter().cloned())
        .collect();
    let journal = ArtworkJournal {
        schema_version: JOURNAL_SCHEMA_VERSION,
        plan_sha256: plan.plan_sha256.clone(),
        marker,
        grid_path: grid.clone(),
        steps,
        ownership_before,
        ownership_after,
    };
    crate::application_update_storage::write_bytes_atomically(
        config,
        JOURNAL_TEMPORARY_FILE,
        JOURNAL_FILE,
        &serde_json::to_vec_pretty(&journal)?,
    )
    .map_err(|source| io_error("publishing the Steam artwork recovery journal", source))?;
    for (path, bytes) in staged {
        let result = write_staged(&path, bytes);
        if let Err(error) = result {
            return match settle_journal(config, &journal) {
                Ok(_) => Err(error),
                Err(settle_error) => Err(SteamEntryError::RecoveryRequired(format!(
                    "{error}; settling the interrupted artwork publication also failed: {settle_error}"
                ))),
            };
        }
    }
    Ok(journal)
}

fn role_bytes(request: &SteamArtworkPlanRequest, role: DestinationArtworkRole) -> Result<&[u8]> {
    request
        .roles
        .iter()
        .find_map(|(candidate, content)| match content {
            SteamArtworkRoleContent::Available { bytes, .. } if *candidate == role => {
                Some(bytes.as_slice())
            }
            _ => None,
        })
        .ok_or_else(|| {
            SteamEntryError::InvalidInput("reviewed Steam artwork bytes are unavailable".into())
        })
}

fn write_staged(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| io_error("creating staged Steam artwork", source))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|source| io_error("writing staged Steam artwork", source))?;
    sync_directory_if_supported(path.parent().expect("staged artwork has a parent"))
}

fn file_digest(path: &Path) -> Result<Option<String>> {
    Ok(
        read_regular_file_bounded(path, "Steam artwork", MAX_ARTWORK_BYTES)?
            .map(|bytes| sha256(&bytes)),
    )
}

fn execute_step(step: &JournalStep) -> Result<()> {
    if let (Some(before), Some(expected)) = (&step.before_path, &step.before_sha256) {
        rename_noreplace(before, &step.swap_path)
            .map_err(|source| io_error("setting aside reviewed Steam artwork", source))?;
        if file_digest(&step.swap_path)?.as_deref() != Some(expected.as_str()) {
            return Err(SteamEntryError::Conflict(format!(
                "{} changed during publication; no Portcove artwork replaced it",
                before.display()
            )));
        }
    }
    if let (Some(staged), Some(after), Some(expected)) =
        (&step.staged_path, &step.after_path, &step.after_sha256)
    {
        rename_noreplace(staged, after).map_err(|source| {
            SteamEntryError::Conflict(format!(
                "could not publish {} without replacing a file written by another program: {source}",
                after.display()
            ))
        })?;
        if file_digest(after)?.as_deref() != Some(expected.as_str()) {
            return Err(SteamEntryError::RecoveryRequired(format!(
                "published Steam artwork {} does not match its reviewed bytes",
                after.display()
            )));
        }
    }
    if let Some(expected) = &step.before_sha256 {
        remove_with_hash(&step.swap_path, expected)?;
    }
    Ok(())
}

fn remove_with_hash(path: &Path, expected: &str) -> Result<()> {
    match file_digest(path)? {
        None => Ok(()),
        Some(digest) if digest == expected => fs::remove_file(path)
            .map_err(|source| io_error("removing set-aside Steam artwork", source)),
        Some(_) => Err(SteamEntryError::RecoveryRequired(format!(
            "{} changed; it was preserved",
            path.display()
        ))),
    }
}

/// A write completed only when Portcove's staged file became the destination:
/// identical bytes that another program placed there are never claimed.
fn step_completed(step: &JournalStep) -> Result<bool> {
    match (&step.after_path, &step.after_sha256) {
        (Some(after), Some(expected)) => {
            if file_digest(after)?.as_deref() != Some(expected) {
                return Ok(false);
            }
            Ok(match &step.staged_path {
                Some(staged) => match fs::symlink_metadata(staged) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                    Err(source) => {
                        return Err(io_error("inspecting staged Steam artwork", source));
                    }
                    // A no-clobber link published it but the staged name remains.
                    Ok(_) => same_inode(staged, after),
                },
                None => true,
            })
        }
        _ => Ok(step
            .before_path
            .as_ref()
            .is_some_and(|before| fs::symlink_metadata(before).is_err())),
    }
}

fn settle_journal(config: &Path, journal: &ArtworkJournal) -> Result<SteamArtworkRecovery> {
    let mut recovery = SteamArtworkRecovery {
        completed: Vec::new(),
        abandoned: Vec::new(),
    };
    let mut ownership = journal.ownership_after.clone();
    for step in &journal.steps {
        let swap_digest = file_digest(&step.swap_path)?;
        if swap_digest.is_some() && swap_digest != step.before_sha256 {
            return Err(SteamEntryError::RecoveryRequired(format!(
                "set-aside Steam artwork {} does not match the journal; it was preserved",
                step.swap_path.display()
            )));
        }
        if step_completed(step)? {
            recovery.completed.push(step.role);
        } else {
            if let (Some(before), Some(expected)) = (&step.before_path, &step.before_sha256) {
                match file_digest(before)? {
                    Some(digest) if digest == *expected => {}
                    None if swap_digest.as_deref() == Some(expected.as_str()) => {
                        rename_noreplace(&step.swap_path, before).map_err(|source| {
                            SteamEntryError::RecoveryRequired(format!(
                                "the set-aside original could not be restored to {} without replacing another file: {source}",
                                before.display()
                            ))
                        })?;
                    }
                    _ => {
                        return Err(SteamEntryError::RecoveryRequired(format!(
                            "{} matches neither the reviewed original nor the published artwork; every file was preserved",
                            before.display()
                        )));
                    }
                }
            }
            if let Some(after) = &step.after_path
                && step.before_path.as_ref() != Some(after)
                && fs::symlink_metadata(after).is_ok()
                && file_digest(after)? != step.after_sha256
            {
                return Err(SteamEntryError::RecoveryRequired(format!(
                    "{} was written by another program during publication; it was preserved",
                    after.display()
                )));
            }
            // Identical bytes another program placed are preserved but never claimed.
            let affected = |record: &OwnershipRecord| {
                record.role == step.role
                    && (record.marker == journal.marker || record.app_id == step.app_id)
            };
            ownership.retain(|record| !affected(record));
            ownership.extend(
                journal
                    .ownership_before
                    .iter()
                    .filter(|record| affected(record))
                    .cloned(),
            );
            recovery.abandoned.push(step.role);
        }
        // The staged name is reserved by the published journal and was absent
        // at review, so any regular file there, even truncated, is Portcove's.
        if let Some(staged) = &step.staged_path
            && file_digest(staged)?.is_some()
        {
            fs::remove_file(staged)
                .map_err(|source| io_error("removing staged Steam artwork", source))?;
        }
        if let Some(expected) = &step.before_sha256 {
            remove_with_hash(&step.swap_path, expected)?;
        }
    }
    write_ownership(config, &ownership)?;
    remove_journal(config)?;
    sync_directory_if_supported(&journal.grid_path).ok();
    Ok(recovery)
}

#[cfg(test)]
#[path = "steam_artwork_tests.rs"]
mod tests;
