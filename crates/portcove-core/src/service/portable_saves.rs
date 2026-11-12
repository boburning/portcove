//! Reviewed portable-save export and import.
//!
//! Export reads a classified, collected snapshot under the port lock and
//! publishes a new bundle without replacing any existing file. Import never
//! writes live data itself: under the port lock it publishes an ordinary backup
//! of current data with the reviewed portable change applied, then hands that
//! snapshot to the existing restore lifecycle, which repeats the state-bound
//! consent check, creates the safety backup and owns interruption recovery.

use std::path::Path;

use super::PortcoveService;
use crate::{
    BackupAction, DestructiveAuthorization, Platform, PortableSaveBlocker,
    PortableSaveExportPreview, PortableSaveExportResult, PortableSaveFileChange,
    PortableSaveFileEffect, PortableSaveIdentity, PortableSaveImportOptions,
    PortableSaveImportPreview, PortableSaveImportResult, PortableSaveRelation, PortcoveError,
    Result,
    portable_saves::{self, Bundle, Classification, PortableSaveContract},
};

const IMPORT_AUTHORIZATION_ACTION: &str = "import-portable-saves";

fn import_authorization_target(port_id: &str) -> String {
    format!("portable-saves\n{port_id}")
}

struct LocalState {
    contract: Option<&'static PortableSaveContract>,
    identity: Option<PortableSaveIdentity>,
    blockers: Vec<PortableSaveBlocker>,
    classification: Classification,
    bytes: std::collections::BTreeMap<String, Vec<u8>>,
    lineage: Option<String>,
}

impl PortcoveService {
    /// Classify current canonical data and identify this side of a transfer.
    /// `busy` is the caller's observation of the port lock.
    fn portable_local_state(&self, port_id: &str, busy: bool) -> Result<LocalState> {
        self.catalog.port(port_id)?;
        let mut blockers = Vec::new();
        if busy {
            blockers.push(PortableSaveBlocker::Busy);
        }
        let Some(contract) = portable_saves::contract_for(port_id) else {
            blockers.push(PortableSaveBlocker::Unqualified);
            return Ok(LocalState {
                contract: None,
                identity: None,
                blockers,
                classification: Classification::default(),
                bytes: Default::default(),
                lineage: None,
            });
        };
        let platform = Platform::current()?;
        let identity = self
            .status_without_rollback_assessment(port_id)?
            .active
            .map(|active| PortableSaveIdentity {
                port_id: port_id.into(),
                contract_id: contract.id.into(),
                version: active.version,
                platform,
            });
        match &identity {
            None => blockers.push(PortableSaveBlocker::NotInstalled),
            Some(identity) => {
                if !contract.versions.contains(&identity.version.as_str()) {
                    blockers.push(PortableSaveBlocker::UnsupportedVersion);
                }
                if !contract.platforms.contains(&platform) {
                    blockers.push(PortableSaveBlocker::UnsupportedPlatform);
                }
            }
        }
        let root = self.library.user_dir(port_id);
        let (classification, bytes) = portable_saves::classify(contract, &root)?;
        Ok(LocalState {
            contract: Some(contract),
            identity,
            blockers,
            classification,
            bytes,
            lineage: portable_saves::read_lineage(contract, &root),
        })
    }

    /// This device's last synchronization point for the game, if recorded.
    pub(super) fn portable_lineage(&self, port_id: &str) -> Option<String> {
        let contract = portable_saves::contract_for(port_id)?;
        portable_saves::read_lineage(contract, &self.library.user_dir(port_id))
    }

    fn port_busy(&self, port_id: &str) -> Result<bool> {
        Ok(self.library.try_probe_port_lock(port_id)?.is_none())
    }

    fn export_preview_from(port_id: &str, local: &LocalState) -> PortableSaveExportPreview {
        let mut blockers = local.blockers.clone();
        if local.contract.is_some() && local.classification.portable.is_empty() {
            blockers.push(PortableSaveBlocker::NoPortableProgress);
        }
        let content_sha256 = local.classification.content_sha256();
        PortableSaveExportPreview {
            port_id: port_id.into(),
            identity: local.identity.clone(),
            files: local.classification.portable.clone(),
            stays_local: local.classification.local.clone(),
            base_sha256: export_base(local, content_sha256.as_deref()),
            content_sha256,
            blockers,
        }
    }

    /// Read-only review of what a portable-save export contains and what stays here.
    pub fn preview_portable_save_export(&self, port_id: &str) -> Result<PortableSaveExportPreview> {
        let busy = self.port_busy(port_id)?;
        let local = self.portable_local_state(port_id, busy)?;
        Ok(Self::export_preview_from(port_id, &local))
    }

    /// Export the reviewed portable progress to a new file. The export must match
    /// `expected_content_sha256` after current runtime data is collected; any
    /// change refuses so the player reviews again. Existing files are never replaced.
    pub fn export_portable_saves(
        &self,
        port_id: &str,
        destination: &Path,
        expected_content_sha256: &str,
    ) -> Result<PortableSaveExportResult> {
        self.catalog.port(port_id)?;
        let destination = self.export_destination(destination)?;
        self.export_portable_saves_with(port_id, expected_content_sha256, &|encoded, _| {
            crate::path::refuse_symlink_ancestors(&destination)?;
            crate::durability::write_bytes_atomically(&destination, encoded, false)?;
            Ok(destination.clone())
        })
    }

    /// Shared export: lock, collect, recheck the reviewed content, then let the
    /// caller publish the encoded bundle (given its content digest) before the
    /// lineage record advances. A publication failure leaves lineage unchanged.
    pub(super) fn export_portable_saves_with(
        &self,
        port_id: &str,
        expected_content_sha256: &str,
        publish: &dyn Fn(&[u8], &str) -> Result<std::path::PathBuf>,
    ) -> Result<PortableSaveExportResult> {
        super::validate_reviewed_fingerprint("portable save export", expected_content_sha256)?;
        self.catalog.port(port_id)?;
        let _operation = self
            .library
            .try_lock_port(port_id, "export-portable-saves")?;
        // Export records its synchronization point in canonical data; never do
        // that while a restore or backup deletion still needs recovery.
        self.require_completed_restore(port_id)?;
        self.require_completed_backup_deletion(port_id)?;
        self.collect_active_user_data_if_launched(port_id)?;
        let local = self.portable_local_state(port_id, false)?;
        let preview = Self::export_preview_from(port_id, &local);
        if let Some(blocker) = preview.blockers.first() {
            return Err(blocked("export", *blocker));
        }
        let (Some(content_sha256), Some(identity), Some(contract)) = (
            preview.content_sha256.clone(),
            preview.identity.clone(),
            local.contract,
        ) else {
            return Err(PortcoveError::state(
                "an unblocked export lost its identity",
            ));
        };
        if content_sha256 != expected_content_sha256 {
            return Err(PortcoveError::conflict(
                "The saves changed after review. Review the export again.",
            ));
        }
        let encoded = portable_saves::encode_bundle(
            &identity,
            &preview.files,
            &local.bytes,
            preview.base_sha256.clone(),
        )?;
        let path = publish(&encoded, &content_sha256)?;
        // The exported content is now this device's known synchronization point.
        // The record lives with the data, so backups and restores carry it too.
        if local.lineage.as_deref() != Some(content_sha256.as_str()) {
            crate::durability::write_bytes_atomically(
                &self
                    .library
                    .user_dir(port_id)
                    .join(portable_saves::LINEAGE_FILE),
                &portable_saves::lineage_bytes(contract, &content_sha256)?,
                true,
            )?;
        }
        Ok(PortableSaveExportResult {
            path,
            identity,
            files: preview.files,
            content_sha256,
            base_sha256: preview.base_sha256,
        })
    }

    /// Exports go outside the library: an absolute path whose parent exists,
    /// never inside Portcove's own data, installs or backups.
    fn export_destination(&self, destination: &Path) -> Result<std::path::PathBuf> {
        let absolute = std::path::absolute(destination)?;
        let (Some(parent), Some(name)) = (absolute.parent(), absolute.file_name()) else {
            return Err(PortcoveError::usage(
                "choose a file name for the exported saves",
            ));
        };
        crate::path::refuse_symlink_ancestors(&absolute)?;
        let parent = std::fs::canonicalize(parent).map_err(|_| {
            PortcoveError::not_found("The folder for the exported saves does not exist.")
        })?;
        let library = std::fs::canonicalize(self.library.root())?;
        if parent.starts_with(&library) {
            return Err(PortcoveError::usage(
                "Save the exported saves outside the Portcove library folder.",
            ));
        }
        Ok(parent.join(name))
    }

    fn portable_import_review(
        &self,
        port_id: &str,
        bundle: &Bundle,
        options: PortableSaveImportOptions,
        busy: bool,
        ancestors: &[String],
    ) -> Result<PortableSaveImportPreview> {
        let local = self.portable_local_state(port_id, busy)?;
        let mut blockers = local.blockers.clone();
        if bundle.identity.port_id != port_id {
            blockers.push(PortableSaveBlocker::DifferentGame);
        }
        if let Some(contract) = local.contract {
            if !contract
                .versions
                .contains(&bundle.identity.version.as_str())
            {
                blockers.push(PortableSaveBlocker::UnsupportedVersion);
            }
            if !contract.platforms.contains(&bundle.identity.platform) {
                blockers.push(PortableSaveBlocker::UnsupportedPlatform);
            }
        }
        if let Some(destination) = &local.identity
            && destination.version != bundle.identity.version
        {
            blockers.push(PortableSaveBlocker::VersionMismatch);
        }
        let local_content = local.classification.content_sha256();
        let relation = match &local_content {
            None => PortableSaveRelation::NoLocalProgress,
            Some(current) if *current == bundle.content_sha256 => {
                PortableSaveRelation::AlreadyCurrent
            }
            Some(current)
                if bundle.base_sha256.as_ref() == Some(current) || ancestors.contains(current) =>
            {
                PortableSaveRelation::Continues
            }
            Some(_) => PortableSaveRelation::Diverged,
        };

        let mut changes = Vec::new();
        for incoming in &bundle.files {
            let current = local
                .classification
                .portable
                .iter()
                .find(|file| file.path == incoming.path);
            changes.push(PortableSaveFileChange {
                path: incoming.path.clone(),
                effect: match current {
                    None => PortableSaveFileEffect::Add,
                    Some(current) if current.sha256 == incoming.sha256 => {
                        PortableSaveFileEffect::Unchanged
                    }
                    Some(_) => PortableSaveFileEffect::Replace,
                },
                incoming: Some(incoming.clone()),
                local: current.cloned(),
            });
        }
        for current in &local.classification.portable {
            if bundle.bytes.contains_key(&current.path) {
                continue;
            }
            changes.push(PortableSaveFileChange {
                path: current.path.clone(),
                effect: if options.remove_local_only_saves {
                    PortableSaveFileEffect::Remove
                } else {
                    PortableSaveFileEffect::KeepLocal
                },
                incoming: None,
                local: Some(current.clone()),
            });
        }
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        // Without known history, a choice is needed only when a save on this
        // device would be replaced; adding new slots never loses progress.
        let replaces = changes
            .iter()
            .any(|change| change.effect == PortableSaveFileEffect::Replace);
        match relation {
            PortableSaveRelation::AlreadyCurrent => {
                blockers.push(PortableSaveBlocker::AlreadyCurrent)
            }
            PortableSaveRelation::Diverged if replaces && !options.replace_diverged_progress => {
                blockers.push(PortableSaveBlocker::ConflictNeedsChoice);
            }
            _ => {}
        }
        blockers.sort_by_key(|blocker| *blocker as u8);
        blockers.dedup();
        let user_root = self.library.user_dir(port_id);
        let safety_backup_will_be_created = self.safety_backup_would_be_created(port_id)?;
        let installed = self.status_without_rollback_assessment(port_id)?.active;
        let preview_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
            &bundle.document_sha256,
            ancestors,
            port_id,
            &local.identity,
            installed
                .as_ref()
                .map(|install| (&install.id, &install.manifest_sha256)),
            relation,
            &changes,
            options,
            &blockers,
            self.player_data_review_sha256(port_id)?,
            user_root,
        ))?);
        Ok(PortableSaveImportPreview {
            port_id: port_id.into(),
            source: bundle.identity.clone(),
            destination: local.identity,
            relation,
            changes,
            stays_local: local.classification.local,
            incoming_content_sha256: bundle.content_sha256.clone(),
            local_content_sha256: local_content,
            options,
            safety_backup_will_be_created,
            blockers,
            preview_sha256,
        })
    }

    /// Read-only review of importing a portable-save file into this game.
    pub fn preview_portable_save_import(
        &self,
        port_id: &str,
        bundle_path: &Path,
        options: PortableSaveImportOptions,
    ) -> Result<PortableSaveImportPreview> {
        let bundle = portable_saves::read_bundle(bundle_path)?;
        self.preview_bundle_import(port_id, &bundle, &[], options)
    }

    pub(super) fn preview_bundle_import(
        &self,
        port_id: &str,
        bundle: &Bundle,
        ancestors: &[String],
        options: PortableSaveImportOptions,
    ) -> Result<PortableSaveImportPreview> {
        let busy = self.port_busy(port_id)?;
        self.portable_import_review(port_id, bundle, options, busy, ancestors)
    }

    /// Issue one-use consent bound to the reviewed import and current data.
    pub fn authorize_portable_save_import(
        &self,
        port_id: &str,
        bundle_path: &Path,
        options: PortableSaveImportOptions,
        expected_preview_sha256: &str,
    ) -> Result<DestructiveAuthorization> {
        let bundle = portable_saves::read_bundle(bundle_path)?;
        self.authorize_bundle_import(port_id, &bundle, &[], options, expected_preview_sha256)
    }

    pub(super) fn authorize_bundle_import(
        &self,
        port_id: &str,
        bundle: &Bundle,
        ancestors: &[String],
        options: PortableSaveImportOptions,
        expected_preview_sha256: &str,
    ) -> Result<DestructiveAuthorization> {
        super::validate_reviewed_fingerprint("portable save import", expected_preview_sha256)?;
        let preview = self.preview_bundle_import(port_id, bundle, ancestors, options)?;
        if let Some(blocker) = preview.blockers.first() {
            return Err(blocked("import", *blocker));
        }
        if preview.preview_sha256 != expected_preview_sha256 {
            return Err(PortcoveError::conflict(
                "The saves or the selected file changed after review. Review the import again.",
            ));
        }
        self.library.issue_authorization(
            IMPORT_AUTHORIZATION_ACTION,
            &import_authorization_target(port_id),
            expected_preview_sha256,
        )
    }

    /// Apply a reviewed, authorized import. Current data is preserved in a safety
    /// backup and the imported state in its own snapshot; both stay restorable.
    pub fn import_portable_saves(
        &self,
        port_id: &str,
        bundle_path: &Path,
        options: PortableSaveImportOptions,
        authorization_token: &str,
    ) -> Result<PortableSaveImportResult> {
        let bundle = portable_saves::read_bundle(bundle_path)?;
        self.import_bundle(port_id, &bundle, &[], options, authorization_token)
    }

    pub(super) fn import_bundle(
        &self,
        port_id: &str,
        bundle: &Bundle,
        ancestors: &[String],
        options: PortableSaveImportOptions,
        authorization_token: &str,
    ) -> Result<PortableSaveImportResult> {
        let (snapshot, restore_token) = {
            let _operation = self
                .library
                .try_lock_port(port_id, "import-portable-saves")?;
            self.require_completed_restore(port_id)?;
            self.require_completed_backup_deletion(port_id)?;
            self.library.consume_authorization_with_state(
                authorization_token,
                IMPORT_AUTHORIZATION_ACTION,
                &import_authorization_target(port_id),
                || {
                    Ok(self
                        .portable_import_review(port_id, bundle, options, false, ancestors)?
                        .preview_sha256)
                },
            )?;
            let reviewed =
                self.portable_import_review(port_id, bundle, options, false, ancestors)?;
            if let Some(blocker) = reviewed.blockers.first() {
                return Err(blocked("import", *blocker));
            }
            // Bring the game's latest writes into canonical data. If that changes
            // anything the player reviewed, stop before any snapshot is made.
            self.collect_active_user_data_if_launched(port_id)?;
            if self
                .portable_import_review(port_id, bundle, options, false, ancestors)?
                .preview_sha256
                != reviewed.preview_sha256
            {
                return Err(PortcoveError::conflict(
                    "The game's latest saves changed what this import would do. Review the import again.",
                ));
            }
            let contract = portable_saves::contract_for(port_id)
                .ok_or_else(|| PortcoveError::state("the reviewed save contract is missing"))?;
            let removals = reviewed
                .changes
                .iter()
                .filter(|change| change.effect == PortableSaveFileEffect::Remove)
                .map(|change| change.path.clone())
                .collect::<Vec<_>>();
            // A first import has no canonical root yet. An empty root is the
            // same player-data state and gives the snapshot a consistent base.
            let user_root = self.library.user_dir(port_id);
            crate::path::refuse_symlink_ancestors(&user_root)?;
            if !user_root.exists() {
                std::fs::create_dir_all(&user_root)?;
            }
            let snapshot = self.create_overlay_backup_locked(port_id, &|copy| {
                portable_saves::apply_to_copy(contract, copy, bundle, &removals)
            })?;
            // Bind restore consent while the port is still locked, so any later
            // change to live data refuses the restore instead of being replaced.
            let restore_review =
                self.preview_backup_action(port_id, &snapshot.id, BackupAction::Restore)?;
            let restore_token = self.authorize_backup_action(
                port_id,
                &snapshot.id,
                BackupAction::Restore,
                &restore_review.preview_sha256,
            )?;
            (snapshot, restore_token.token)
        };
        let restored = self
            .restore_backup(port_id, &snapshot.id, &restore_token)
            .map_err(|error| error.detail("imported_progress_snapshot", snapshot.id.clone()))?;
        Ok(PortableSaveImportResult {
            import_snapshot: restored.restored_backup,
            safety_backup: restored.safety_backup,
            content_sha256: bundle.content_sha256.clone(),
        })
    }
}

/// The base of an export is the last synchronization point, unless the
/// content is unchanged since then (exporting the same content again).
fn export_base(local: &LocalState, content: Option<&str>) -> Option<String> {
    local
        .lineage
        .clone()
        .filter(|lineage| Some(lineage.as_str()) != content)
}

fn blocked(action: &str, blocker: PortableSaveBlocker) -> PortcoveError {
    let message = match blocker {
        PortableSaveBlocker::Unqualified => {
            "Portcove has not qualified moving saves for this game.".to_owned()
        }
        PortableSaveBlocker::NotInstalled => {
            "Install the game with Portcove first so the save version can be checked.".to_owned()
        }
        PortableSaveBlocker::UnsupportedVersion | PortableSaveBlocker::UnsupportedPlatform => {
            "Portcove has not qualified moving saves for this game version on this device."
                .to_owned()
        }
        PortableSaveBlocker::VersionMismatch => {
            "These saves come from a different game version. Install the same version on both devices first."
                .to_owned()
        }
        PortableSaveBlocker::DifferentGame => "These saves belong to a different game.".to_owned(),
        PortableSaveBlocker::Busy => {
            "Close the game and wait for other Portcove tasks for it to finish.".to_owned()
        }
        PortableSaveBlocker::NoPortableProgress => "There are no saves to export yet.".to_owned(),
        PortableSaveBlocker::ConflictNeedsChoice => {
            "Portcove can't confirm these saves continue from this device's saves. Choose whether to replace this device's saves; they stay in a backup."
                .to_owned()
        }
        PortableSaveBlocker::AlreadyCurrent => "This device already has these saves.".to_owned(),
    };
    let error = match blocker {
        PortableSaveBlocker::Busy
        | PortableSaveBlocker::ConflictNeedsChoice
        | PortableSaveBlocker::AlreadyCurrent => PortcoveError::conflict(message),
        PortableSaveBlocker::NotInstalled | PortableSaveBlocker::NoPortableProgress => {
            PortcoveError::not_found(message)
        }
        _ => PortcoveError::unsupported(message),
    };
    error.detail("portable_save_action", action).detail(
        "blocker",
        serde_json::to_value(blocker).map_or_else(
            |_| String::new(),
            |value| value.as_str().unwrap_or_default().to_owned(),
        ),
    )
}

#[cfg(test)]
#[path = "portable_saves_tests.rs"]
mod tests;
