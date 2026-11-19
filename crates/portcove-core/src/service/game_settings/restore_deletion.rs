//! Exact settings deletion evidence from the existing reviewed backup restore.
//! Retained evidence records an observed outcome. It does not authorize an
//! activation to remove an incoming file or treat later absence as unchanged.

use super::*;
use crate::game_settings::observe_player_settings_copy;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RestoreDeletion {
    port_id: String,
    install_id: String,
    install_manifest_sha256: String,
    archive_sha256: String,
    file_id: String,
    format: crate::GameSettingsFormat,
    relative_path: String,
    scope: RestoreSettingsScope,
    reviewed_manifest_sha256: String,
    shipped_sha256: String,
    player_sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RestoreSettingsScope {
    Partitioned { policy_sha256: String },
    Native { policy_sha256: String },
}

struct RestoreCoordinate {
    active: InstallRecord,
    file: GameSettingsFile,
    shipped_sha256: String,
    runtime_root: Option<PathBuf>,
    policy_sha256: String,
}

impl PortcoveService {
    fn settings_restore_coordinate(
        &self,
        port_id: &str,
        partitioned: bool,
    ) -> Result<Option<RestoreCoordinate>> {
        if Platform::current()? != Platform::WindowsX86_64 {
            return Ok(None);
        }
        let Some(active) = self.library.status(port_id, ReleaseChannel::Stable)?.active else {
            return Ok(None);
        };
        if !active.verified || active.manifest_sha256.is_empty() {
            return Ok(None);
        }
        let installer = Installer::new(self.library.clone())?;
        let Some(defaults) = installer.retained_settings_defaults(&active)? else {
            return Ok(None);
        };
        let mut files = defaults
            .contract
            .files
            .iter()
            .filter(|file| defaults.shipped.contains_key(&file.path));
        let (Some(file), None) = (files.next(), files.next()) else {
            return Ok(None);
        };
        let policy = self.persistence_contract_for_install(&active)?;
        let port = &policy.port;
        let scoped = if partitioned {
            port.archive_data_compatibility_v1
                .as_ref()
                .is_some_and(|policy| policy.shared_paths.contains(&file.path))
        } else {
            port.adapter == AdapterKind::NativePortable
                && port.archive_data_compatibility_v1.is_none()
                && !crate::persistence::requires_restore_receipt(port)
        };
        if !scoped
            || port.runtime_data_policy.is_some()
            || !port.persistent_paths.contains(&file.path)
            || port
                .persistent_paths
                .iter()
                .any(|path| file.path.starts_with(&format!("{path}/")))
        {
            return Ok(None);
        }
        let shipped = defaults.shipped[&file.path].verified_bytes(file)?;
        let runtime_root = (!policy.writes_directly)
            .then(|| self.persistence_root(port, &active.path))
            .transpose()?;
        Ok(Some(RestoreCoordinate {
            active,
            file: file.clone(),
            shipped_sha256: digest(&shipped),
            runtime_root,
            policy_sha256: crate::archive_data::policy_sha256(port)?,
        }))
    }

    /// Bind an ordinary explicit full backup to the exact local producer.
    /// Portable and historical backups retain their existing restore scope.
    pub(in crate::service) fn record_native_settings_backup(
        &self,
        backup: &BackupRecord,
    ) -> Result<()> {
        let coverage = (|| {
            let Some(coordinate) = self.settings_restore_coordinate(&backup.port_id, false)? else {
                return Ok(None);
            };
            let file = &coordinate.file;
            if observe_player_settings_copy(&backup.path.join("data"), file)?.is_some()
                || observe_player_settings_copy(&self.library.user_dir(&backup.port_id), file)?
                    .is_some()
            {
                return Ok(None);
            }
            if let Some(runtime) = &coordinate.runtime_root
                && observe_player_settings_copy(runtime, file)?.is_some()
            {
                return Ok(None);
            }
            let manifest = crate::path::read_bounded_regular(
                &backup.path.join("backup.json"),
                crate::service::backups::BACKUP_MANIFEST_MAX_BYTES,
            )?;
            Ok::<_, PortcoveError>(Some(coordinate.native_coverage(&manifest)?))
        })();
        if let Ok(Some(coverage)) = coverage {
            self.library.connection()?.execute(
                "INSERT INTO settings_backup_coverage (backup_id, port_id, coverage_sha256)
                 VALUES (?1, ?2, ?3)",
                params![backup.id, backup.port_id, coverage],
            )?;
        }
        Ok(())
    }

    /// Called before the existing authorized restore publishes either tree, and
    /// after its backed-up payload and retained manifest have been verified.
    pub(in crate::service) fn prepare_restore_settings_deletion(
        &self,
        operation: &LifecycleOperation,
        staged: &Path,
        canonical: &Path,
        policy_sha256: Option<&str>,
        backup: &BackupRecord,
        reviewed_manifest: &[u8],
    ) -> Result<bool> {
        if !operation.activate
            || operation.kind != LifecycleOperationKind::Restore
            || operation.phase != LifecyclePhase::Preparing
        {
            return Ok(false);
        }
        let proof = (|| {
            let Some(coordinate) =
                self.settings_restore_coordinate(&operation.port_id, policy_sha256.is_some())?
            else {
                return Ok(None);
            };
            let scope = if let Some(policy_sha256) = policy_sha256 {
                if coordinate.policy_sha256 != policy_sha256 {
                    return Ok(None);
                }
                RestoreSettingsScope::Partitioned {
                    policy_sha256: coordinate.policy_sha256.clone(),
                }
            } else {
                let expected = coordinate.native_coverage(reviewed_manifest)?;
                let retained = self
                    .library
                    .connection()?
                    .query_row(
                        "SELECT coverage_sha256 FROM settings_backup_coverage
                     WHERE backup_id=?1 AND port_id=?2",
                        params![backup.id, operation.port_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                if retained.as_deref() != Some(&expected) {
                    return Ok(None);
                }
                RestoreSettingsScope::Native {
                    policy_sha256: coordinate.policy_sha256.clone(),
                }
            };
            let file = &coordinate.file;
            if observe_player_settings_copy(staged, file)?.is_some() {
                return Ok(None);
            }
            let Some(previous) = observe_player_settings_copy(canonical, file)? else {
                return Ok(None);
            };
            if let Some(root) = &coordinate.runtime_root
                && observe_player_settings_copy(root, file)?.as_ref() != Some(&previous)
            {
                return Ok(None);
            }
            Ok::<_, PortcoveError>(Some(RestoreDeletion {
                port_id: operation.port_id.clone(),
                install_id: coordinate.active.id,
                install_manifest_sha256: coordinate.active.manifest_sha256,
                archive_sha256: coordinate.active.artifact.sha256,
                file_id: file.id.clone(),
                format: file.format,
                relative_path: file.path.clone(),
                scope,
                reviewed_manifest_sha256: digest(reviewed_manifest),
                shipped_sha256: coordinate.shipped_sha256,
                player_sha256: digest(&previous),
            }))
        })();
        // Optional evidence cannot widen or prevent the already-reviewed
        // backup restore. Any unsupported preimage leaves settings unobserved.
        let Ok(Some(proof)) = proof else {
            return Ok(false);
        };
        self.library.connection()?.execute(
            "INSERT INTO settings_restore_deletions (restore_id, pending_id, port_id, install_id, file_id, evidence)
             VALUES (?1, ?1, ?2, ?3, ?4, ?5)",
            params![
                operation.id,
                proof.port_id,
                proof.install_id,
                proof.file_id,
                serde_json::to_vec(&proof)?,
            ],
        )?;
        Ok(true)
    }

    /// The existing restore verifies publication and projects persistent data
    /// before calling this in both normal execution and interrupted recovery.
    pub(crate) fn finish_restore_settings_deletion(
        &self,
        operation: &LifecycleOperation,
        previous: &Path,
        canonical: &Path,
        reviewed_manifest_path: Option<&Path>,
    ) -> Result<()> {
        if operation.kind != LifecycleOperationKind::Restore
            || operation.phase != LifecyclePhase::PayloadPublished
        {
            return Ok(());
        }
        let mut connection = self.library.connection()?;
        let evidence: Option<Vec<u8>> = connection
            .query_row(
                "SELECT evidence FROM settings_restore_deletions WHERE pending_id=?1 AND port_id=?2",
                params![operation.id, operation.port_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(evidence) = evidence else {
            return Ok(());
        };
        let proof: RestoreDeletion = serde_json::from_slice(&evidence)?;
        let unchanged = (|| {
            let Some(manifest) = reviewed_manifest_path else {
                return Ok(false);
            };
            if proof.port_id != operation.port_id
                || manifest.file_name().and_then(|name| name.to_str())
                    != Some(
                        format!("verified-backup-{}.json", proof.reviewed_manifest_sha256).as_str(),
                    )
            {
                return Ok(false);
            }
            let (partitioned, policy_sha256) = match &proof.scope {
                RestoreSettingsScope::Partitioned { policy_sha256 } => (true, policy_sha256),
                RestoreSettingsScope::Native { policy_sha256 } => (false, policy_sha256),
            };
            let Some(coordinate) =
                self.settings_restore_coordinate(&operation.port_id, partitioned)?
            else {
                return Ok(false);
            };
            if coordinate.policy_sha256 != *policy_sha256 {
                return Ok(false);
            }
            let file = &coordinate.file;
            if proof.install_id != coordinate.active.id
                || proof.install_manifest_sha256 != coordinate.active.manifest_sha256
                || proof.archive_sha256 != coordinate.active.artifact.sha256
                || proof.file_id != file.id
                || proof.format != file.format
                || proof.relative_path != file.path
                || proof.shipped_sha256 != coordinate.shipped_sha256
                || observe_player_settings_copy(previous, file)?
                    .is_none_or(|bytes| digest(&bytes) != proof.player_sha256)
                || observe_player_settings_copy(canonical, file)?.is_some()
            {
                return Ok(false);
            }
            if let Some(runtime_root) = &coordinate.runtime_root
                && observe_player_settings_copy(runtime_root, file)?.is_some()
            {
                return Ok(false);
            }
            Ok::<_, PortcoveError>(true)
        })();
        if !matches!(unchanged, Ok(true)) {
            return Ok(());
        }

        // Retain the most recent proof per installation/file. On recovery an
        // already-promoted row has no pending ID, so promotion is idempotent.
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM settings_restore_deletions
             WHERE pending_id IS NULL AND port_id=?1 AND install_id=?2 AND file_id=?3",
            params![proof.port_id, proof.install_id, proof.file_id],
        )?;
        let promoted = transaction.execute(
            "UPDATE settings_restore_deletions SET pending_id=NULL WHERE pending_id=?1 AND port_id=?2",
            params![operation.id, operation.port_id],
        )?;
        if promoted != 1 {
            return Err(PortcoveError::conflict(
                "the settings restore evidence changed before it could be retained",
            ));
        }
        transaction.commit()?;
        Ok(())
    }
}

impl RestoreCoordinate {
    fn native_coverage(&self, manifest: &[u8]) -> Result<String> {
        Ok(digest(&serde_json::to_vec(&(
            "native-settings-full-backup-v1",
            digest(manifest),
            &self.active.port_id,
            &self.active.id,
            &self.active.manifest_sha256,
            &self.active.artifact.sha256,
            &self.file,
            &self.shipped_sha256,
            &self.policy_sha256,
        ))?))
    }
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
