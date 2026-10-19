//! The exact historical data recovery route; not a generic migration framework.

use crate::{
    BackupRecord, Installer, LaunchSessionOutcome, LaunchSessionRecord, PortcoveError,
    PreparationMode, ReleaseChannel, Result,
    ghostship_data_store::{self, LegacyDataSeal},
};

use super::PortcoveService;

impl PortcoveService {
    pub fn plan_ghostship_legacy_recovery(
        &self,
        backup_id: &str,
    ) -> Result<crate::GhostshipRecoveryPlan> {
        let _guard = self
            .library
            .try_lock_port("ghostship", "review-legacy-recovery")?;
        self.plan_ghostship_legacy_recovery_locked(backup_id)
    }

    pub(super) fn plan_ghostship_legacy_recovery_locked(
        &self,
        backup_id: &str,
    ) -> Result<crate::GhostshipRecoveryPlan> {
        self.catalog.port("ghostship")?;
        if crate::Platform::current()? != crate::Platform::WindowsX86_64 {
            return Err(PortcoveError::unsupported(
                "legacy recovery is qualified only for the exact Windows 2.0.0 route",
            ));
        }
        let connection = self.library.connection()?;
        if ghostship_data_store::pending_legacy_work(&connection)? {
            return Err(PortcoveError::conflict(
                "legacy recovery awaits all unfinished Ghostship launch and lifecycle work",
            ));
        }
        let backup = self.load_backup("ghostship", backup_id)?;
        let (manifest_sha256, qualification_sha256, seal) = ghostship_data_store::qualified_backup(&connection, backup_id)?
            .ok_or_else(|| PortcoveError::conflict("this backup has no Core-owned legacy consumption qualification; ordinary backups and imported metadata cannot grant recovery"))?;
        if seal.format_version != 1
            || seal.install.port_id != "ghostship"
            || seal.install.version != "2.0.0"
            || seal.session.install_id != seal.install.id
            || seal.session.install_root != seal.install.path
            || seal.session.outcome != Some(LaunchSessionOutcome::Succeeded)
            || seal.session.exit_code != Some(0)
            || seal.session.child_identity.is_none()
            || seal.session.supervisor_identity.is_none()
            || seal.session.finished_at.is_none()
        {
            return Err(PortcoveError::verification(
                "legacy backup qualification has an invalid consumed-install identity",
            ));
        }
        let actual_manifest = crate::external_runtime::hash_stable_regular(
            &backup.path.join("backup.json"),
            1024 * 1024,
            &|| Ok(()),
        )?
        .0;
        let snapshot_data = ghostship_data_store::reviewed_data(&backup.path.join("data"))?;
        if actual_manifest != manifest_sha256 || snapshot_data != seal.data {
            return Err(PortcoveError::verification(
                "qualified backup content or manifest changed",
            ));
        }
        let status = self.library.status("ghostship", ReleaseChannel::Stable)?;
        if status.external_runtime.is_some() {
            return Err(PortcoveError::conflict(
                "legacy recovery requires managed installation history",
            ));
        }
        let active = status.active.ok_or_else(|| {
            PortcoveError::conflict("legacy recovery has no active newer installation")
        })?;
        let legacy = status.previous.ok_or_else(|| {
            PortcoveError::conflict("legacy recovery has no retained previous installation")
        })?;
        if active.port_id != "ghostship"
            || active.version != "3.0.0"
            || serde_json::to_value(&legacy)? != serde_json::to_value(&seal.install)?
        {
            return Err(PortcoveError::conflict(
                "legacy recovery requires active 3.0.0 and the exact qualified previous 2.0.0 installation",
            ));
        }
        let staged_count: u64 = connection.query_row(
            "SELECT count(*) FROM installs WHERE port_id='ghostship' AND staged=1",
            [],
            |row| row.get(0),
        )?;
        if staged_count != u64::from(status.staged.is_some()) {
            return Err(PortcoveError::verification(
                "legacy recovery cannot establish the complete staged-install tuple",
            ));
        }
        let installer = Installer::new(self.library.clone())?;
        for install in [&active, &legacy].into_iter().chain(status.staged.iter()) {
            self.managed_install_root("ghostship", &install.path)?;
            installer.require_curated_operation(
                install,
                crate::definition_repository::publisher_policy::CuratedArtifactOperation::LocalUse,
            )?;
            if !installer.verify(install)?.valid {
                return Err(PortcoveError::verification(
                    "legacy recovery installation changed after admission",
                ));
            }
        }
        if installer.retained_preparation_mode(&legacy)?
            != Some(PreparationMode::Ghostship200Legacy)
        {
            return Err(PortcoveError::verification(
                "legacy recovery target lacks its retained preparation mode",
            ));
        }
        let source = self
            .library
            .source("ghostship-source")?
            .ok_or_else(|| PortcoveError::source("legacy recovery original is not registered"))?;
        if serde_json::to_value(&source)? != serde_json::to_value(&seal.source)? {
            return Err(PortcoveError::source(
                "legacy recovery original registration changed after consumption",
            ));
        }
        let catalog = self.installed_catalog(&legacy)?;
        crate::source_inspection::verify_registered(&catalog, &source)?;
        self.require_ghostship_snapshot_compatibility(&legacy, &backup.path.join("data"))?;
        let receipt = crate::external_runtime::hash_stable_regular(
            &legacy.path.join(crate::preparation::RECEIPT_FILE),
            1024 * 1024,
            &|| Ok(()),
        )?
        .0;
        let generated = crate::external_runtime::hash_stable_regular(
            &crate::preparation::legacy_generated_path(&legacy.path),
            512 * 1024 * 1024,
            &|| Ok(()),
        )?
        .0;
        if receipt != seal.receipt_sha256 || generated != seal.generated_sha256 {
            return Err(PortcoveError::verification(
                "legacy recovery target no longer matches the consumed receipt and generated archive",
            ));
        }
        let canonical_data =
            ghostship_data_store::reviewed_data(&self.library.user_dir("ghostship"))?;
        let active_install_tree = ghostship_data_store::reviewed_data(&active.path)?;
        let legacy_install_tree = ghostship_data_store::reviewed_data(&legacy.path)?;
        let required_bytes = [
            legacy_install_tree.total_bytes,
            snapshot_data.total_bytes,
            snapshot_data.total_bytes,
            canonical_data.total_bytes,
            canonical_data.total_bytes,
            active_install_tree.total_bytes,
            64 * 1024 * 1024,
        ]
        .into_iter()
        .try_fold(0u64, |total, size| {
            total
                .checked_add(size)
                .ok_or_else(|| PortcoveError::state("legacy recovery capacity estimate overflowed"))
        })?;
        let checked_install =
            crate::output_root::validate_install_path(&self.library, "ghostship", &legacy.path)?;
        let output_root = checked_install.parent().ok_or_else(|| {
            PortcoveError::state("legacy recovery target has no owned output parent")
        })?;
        for root in [self.library.root(), output_root] {
            if fs2::available_space(root)? < required_bytes {
                return Err(PortcoveError::conflict(
                    "legacy recovery needs space for the checked derivative, staged data and independent safety snapshots",
                ));
            }
        }
        let mut plan = crate::GhostshipRecoveryPlan {
            format_version: 1,
            library_root: self.library.root().to_path_buf(),
            backup,
            qualification_sha256,
            legacy_install: legacy,
            active_install: active,
            staged_install: status.staged,
            source,
            channel: status.channel,
            update_policy: status.update_policy,
            canonical_data,
            active_install_tree,
            legacy_install_tree,
            snapshot_data,
            required_bytes,
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = recovery_plan_fingerprint(&plan)?;
        Ok(plan)
    }

    pub fn authorize_ghostship_legacy_recovery(
        &self,
        backup_id: &str,
        expected_plan_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        super::validate_reviewed_fingerprint("legacy recovery", expected_plan_sha256)?;
        let parsed = uuid::Uuid::parse_str(backup_id)
            .map_err(|_| PortcoveError::usage("legacy recovery requires a canonical backup ID"))?;
        if parsed.to_string() != backup_id {
            return Err(PortcoveError::usage(
                "legacy recovery requires a canonical backup ID",
            ));
        }
        self.library.issue_authorization(
            "ghostship_legacy_recovery",
            &format!("ghostship:{backup_id}"),
            expected_plan_sha256,
        )
    }

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

pub(super) fn recovery_plan_fingerprint(plan: &crate::GhostshipRecoveryPlan) -> Result<String> {
    let mut content = plan.clone();
    content.plan_sha256.clear();
    Ok(crate::signed_catalog::digest(&serde_json::to_vec(
        &content,
    )?))
}
