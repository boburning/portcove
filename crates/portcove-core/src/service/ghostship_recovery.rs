//! The exact historical data recovery route; not a generic migration framework.

use crate::{
    BackupRecord, Installer, LaunchSessionOutcome, LaunchSessionRecord, PortcoveError,
    PreparationMode, ReleaseChannel, Result,
    ghostship_data_store::{self, LegacyDataSeal},
};

use super::PortcoveService;

impl PortcoveService {
    pub(super) fn qualify_legacy_consumption(
        &self,
        session: &LaunchSessionRecord,
    ) -> Result<Option<LegacyDataSeal>> {
        if session.port_id != "ghostship"
            || session.child_identity.is_none()
            || session.supervisor_identity.is_none()
            || session.child_pid.is_none()
            || session.owner_kind != crate::LaunchOwnerKind::Managed
        {
            return Ok(None);
        }
        let active = self
            .library
            .status("ghostship", ReleaseChannel::Stable)?
            .active
            .ok_or_else(|| {
                PortcoveError::state("consumed legacy installation is no longer active")
            })?;
        if active.id != session.install_id || active.path != session.install_root {
            return Err(PortcoveError::verification(
                "consumed installation identity changed",
            ));
        }
        let installer = Installer::new(self.library.clone())?;
        if active.version != "2.0.0"
            || installer.retained_preparation_mode(&active)?
                != Some(PreparationMode::Ghostship200Legacy)
        {
            return Ok(None);
        }
        self.require_ghostship_install_data_compatibility(&active, None)?;
        self.require_ghostship_legacy_runtime_archive(&active, &active.path)?;
        if !installer.verify(&active)?.valid {
            return Err(PortcoveError::verification(
                "consumed legacy installation failed full verification",
            ));
        }
        let catalog = self.installed_catalog(&active)?;
        let source = self
            .library
            .source("ghostship-source")?
            .ok_or_else(|| PortcoveError::source("consumed legacy original is not registered"))?;
        crate::source_inspection::verify_registered(&catalog, &source)?;
        let receipt_sha256 = crate::external_runtime::hash_stable_regular(
            &active.path.join(crate::preparation::RECEIPT_FILE),
            1024 * 1024,
            &|| Ok(()),
        )?
        .0;
        let generated_sha256 = crate::external_runtime::hash_stable_regular(
            &crate::preparation::legacy_generated_path(&active.path),
            512 * 1024 * 1024,
            &|| Ok(()),
        )?
        .0;
        let Some(data) =
            ghostship_data_store::consumption_data(&self.library.user_dir("ghostship"))?
        else {
            return Ok(None);
        };
        let mut qualified = session.clone();
        qualified.outcome = Some(LaunchSessionOutcome::Succeeded);
        qualified.exit_code = Some(0);
        qualified.finished_at = Some(crate::Library::now());
        Ok(Some(LegacyDataSeal {
            format_version: 1,
            session: qualified,
            install: active,
            source,
            receipt_sha256,
            generated_sha256,
            data,
        }))
    }

    /// Called only after a backup has been copied, verified and published.
    /// A mismatching tree remains an ordinary backup, never a recovery grant.
    pub(super) fn qualify_legacy_backup(&self, backup: &BackupRecord) -> Result<()> {
        if backup.port_id != "ghostship" {
            return Ok(());
        }
        let connection = self.library.connection()?;
        let Some(seal) = ghostship_data_store::seal(&connection)? else {
            return Ok(());
        };
        if seal.format_version != 1
            || seal.install.port_id != "ghostship"
            || seal.install.version != "2.0.0"
            || seal.session.outcome != Some(LaunchSessionOutcome::Succeeded)
            || seal.session.exit_code != Some(0)
        {
            return Err(PortcoveError::verification(
                "invalid Core-owned legacy consumption seal",
            ));
        }
        if ghostship_data_store::pending_legacy_work(&connection)? {
            // Qualification cannot cross unfinished mutation or launch history.
            // Ordinary backup preservation still succeeds.
            return Ok(());
        }
        match self.legacy_backup_matches_consumption(backup, &seal) {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(error)
                if matches!(
                    error.code,
                    crate::ErrorCode::Unsupported
                        | crate::ErrorCode::Verification
                        | crate::ErrorCode::Conflict
                        | crate::ErrorCode::SourceInvalid
                        | crate::ErrorCode::NotFound
                ) =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        }
        let manifest_sha256 = crate::external_runtime::hash_stable_regular(
            &backup.path.join("backup.json"),
            1024 * 1024,
            &|| Ok(()),
        )?
        .0;
        // Qualification refusals above never turn a preserved ordinary backup
        // into an error. Database/storage write failures remain visible here.
        connection.execute(
            "INSERT INTO ghostship_qualified_backups(backup_id,port_id,manifest_sha256,seal_json)
             VALUES (?1,'ghostship',?2,?3)",
            rusqlite::params![backup.id, manifest_sha256, serde_json::to_string(&seal)?],
        )?;
        Ok(())
    }

    fn legacy_backup_matches_consumption(
        &self,
        backup: &BackupRecord,
        seal: &LegacyDataSeal,
    ) -> Result<bool> {
        let active = self
            .library
            .status("ghostship", ReleaseChannel::Stable)?
            .active;
        if serde_json::to_value(active.as_ref())? != serde_json::to_value(Some(&seal.install))?
            || serde_json::to_value(self.library.source("ghostship-source")?)?
                != serde_json::to_value(Some(&seal.source))?
            || ghostship_data_store::reviewed_data(&self.library.user_dir("ghostship"))?
                != seal.data
            || ghostship_data_store::reviewed_data(&backup.path.join("data"))? != seal.data
        {
            return Ok(false);
        }
        self.require_ghostship_install_data_compatibility(&seal.install, None)?;
        if !Installer::new(self.library.clone())?
            .verify(&seal.install)?
            .valid
        {
            return Err(PortcoveError::verification(
                "snapshot's legacy installation changed",
            ));
        }
        let receipt = crate::external_runtime::hash_stable_regular(
            &seal.install.path.join(crate::preparation::RECEIPT_FILE),
            1024 * 1024,
            &|| Ok(()),
        )?
        .0;
        let generated = crate::external_runtime::hash_stable_regular(
            &crate::preparation::legacy_generated_path(&seal.install.path),
            512 * 1024 * 1024,
            &|| Ok(()),
        )?
        .0;
        Ok(receipt == seal.receipt_sha256 && generated == seal.generated_sha256)
    }
}
