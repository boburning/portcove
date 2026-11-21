//! Recovery of an exact earlier setup with the current save group.

use std::{fs, io::Read};

use rusqlite::Connection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    OriginalStatus, PortcoveError, PortcoveService, ProfileRevision, ProfileUpdatePolicy,
    ResolvedPackage, Result, RetainedBuildGap, profile,
};

use super::{
    Layout, NativeModListStatus, mark_restore_pending, native_status, observe, require_clean,
    require_code_allowed, require_dfu_basename_stability, require_projectable,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProfileRecoveryProgress {
    KeepCurrent,
}

/// The exact setup change for review. Applying it preserves the current save group.
/// Recovery does not restore an old save or claim save compatibility.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileRecoveryPlan {
    pub current: ProfileRevision,
    pub target: ProfileRevision,
    pub selected_revision: Option<u64>,
    pub progress: ProfileRecoveryProgress,
    pub update_policy: ProfileUpdatePolicy,
    pub originals: Vec<OriginalStatus>,
    pub holds: Vec<RetainedBuildGap>,
    pub plan_sha256: String,
}

impl PortcoveService {
    pub fn plan_profile_recovery(
        &self,
        port_id: &str,
        profile_id: &str,
        revision: u64,
    ) -> Result<ProfileRecoveryPlan> {
        let layout = self.deploy_layout(port_id)?;
        let _guard = self
            .library
            .try_read_lock_port(port_id, "plan-profile-recovery")?;
        self.profile_recovery_plan(
            &layout,
            &self.library.connection()?,
            port_id,
            profile_id,
            revision,
        )
    }

    /// Rechecks the reviewed plan under the port lock and appends a successor.
    /// If live deployment is interrupted, the stored successor and earlier
    /// materialized revision let Activate Profile retry without restoring saves.
    pub fn apply_profile_recovery(
        &self,
        port_id: &str,
        profile_id: &str,
        revision: u64,
        expected_plan_sha256: &str,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let _guard = self.library.try_lock_port(port_id, "recover-profile")?;
        let connection = self.library.connection()?;
        let plan =
            self.profile_recovery_plan(&layout, &connection, port_id, profile_id, revision)?;
        if plan.plan_sha256 != expected_plan_sha256 || !plan.holds.is_empty() {
            return Err(PortcoveError::conflict(
                "This setup recovery is held or changed. Review the current recovery plan before applying it.",
            ));
        }
        if plan.selected_revision.is_some() {
            // Supervised play already collected the selected save group. Other
            // runtime copies may contain progress from a different setup.
            mark_restore_pending(&layout)?;
        }
        let next = self.publish_profile_successor_locked(port_id, &plan.current, plan.target)?;
        if plan.selected_revision.is_some() {
            self.reconcile_selected(port_id, &layout, &connection, &next)
                .map_err(|mut error| {
                    error.failure.mutation_state = crate::MutationState::Committed;
                    error.detail("recovery_revision", next.revision.to_string())
                })?;
        }
        Ok(next)
    }

    fn profile_recovery_plan(
        &self,
        layout: &Layout,
        connection: &Connection,
        port_id: &str,
        profile_id: &str,
        revision: u64,
    ) -> Result<ProfileRecoveryPlan> {
        let setup = profile::profile_by_id(connection, port_id, profile_id)?;
        let current = profile::revision_by_number(connection, profile_id, setup.current_revision)?;
        if revision >= current.revision {
            return Err(PortcoveError::usage(
                "Choose an earlier setup revision to recover.",
            ));
        }
        let target = profile::revision_by_number(connection, profile_id, revision)?;
        let selected_revision = profile::selection(connection, port_id)?
            .filter(|(id, _)| id == profile_id)
            .map(|(_, revision)| revision);
        let originals = profile::original_statuses(
            connection,
            &target.originals,
            &self.library.sources()?,
            setup.is_default,
            self.catalog(),
            &mut std::collections::BTreeMap::new(),
        )?;
        let mut holds = Vec::new();
        let mut check = |result: Result<()>| {
            if let Err(error) = result {
                holds.push(error.into());
            }
        };

        check(crate::profile_file_preservation::require_idle(
            &self.library,
            port_id,
        ));
        check(self.require_offered_profile_recovery(
            connection,
            port_id,
            &target,
            setup.is_default,
        ));
        check(require_dfu_basename_stability(&current, &target));
        check(self.require_dfu_target_clean(layout, &target));
        check(require_projectable(layout, &target));
        if setup.is_default && current.originals != target.originals {
            check(Err(PortcoveError::unsupported(
                "Default follows the registered original files. Copy the setup to choose an exact original before recovering this revision.",
            )));
        }
        for package in &target.packages {
            check(
                verify_retained_package(layout, package)
                    .map_err(|error| error.detail("package", &package.native_id)),
            );
        }
        check(require_code_allowed(layout, &target));
        let needs_loader = target.packages.iter().any(|package| package.enabled);
        if !needs_loader && target.loader.is_some() {
            check(
                self.profile_loader_binding(&target.build, target.loader.as_ref(), false)
                    .map(|_| ()),
            );
        }
        check(self.require_revision_loader(&target));
        if let Some(game) = layout.recomp_game() {
            check(crate::recomp_mod_settings::review_recovery(
                layout, game, &current, &target,
            ));
            if selected_revision.is_some() {
                check(crate::recomp_mod_settings::review_projection(
                    &layout.user,
                    layout,
                    game,
                    &target,
                ));
            }
        } else if current.settings != target.settings {
            check(Err(PortcoveError::unsupported(
                "This setup records a different consequential setting. Its loader needs a supported settings restore before this revision can be recovered.",
            )));
        }
        if layout.journal().try_exists()?
            || selected_revision.is_some_and(|rev| rev != current.revision)
        {
            check(Err(PortcoveError::conflict(
                "Finish the interrupted setup change before recovering a revision.",
            )));
        } else if selected_revision.is_some() {
            check(
                observe(layout, &[&current])
                    .and_then(|files| require_clean(&files, "recovering an earlier setup")),
            );
            if !matches!(
                native_status(layout, &current),
                NativeModListStatus::InSync
                    | NativeModListStatus::NotApplicable
                    | NativeModListStatus::NotWritten
            ) {
                check(Err(PortcoveError::conflict(
                    "The game’s mod list changed outside this setup. Review its current order and enabled mods before recovering a revision.",
                )));
            }
        }

        let mut plan = ProfileRecoveryPlan {
            current,
            target,
            selected_revision,
            progress: ProfileRecoveryProgress::KeepCurrent,
            update_policy: setup.intent.update_policy,
            originals,
            holds,
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&plan)?));
        Ok(plan)
    }

    fn require_offered_profile_recovery(
        &self,
        connection: &Connection,
        port_id: &str,
        target: &ProfileRevision,
        is_default: bool,
    ) -> Result<()> {
        if target.build.platform != crate::Platform::current()? {
            return Err(PortcoveError::unsupported(
                "This recovery runtime is for a different platform. Recover it on its supported platform.",
            ));
        }
        let reference =
            crate::retained_build::reference_from(connection, port_id, &target.profile_id)?;
        if !reference
            .as_ref()
            .is_some_and(|entry| entry.retained_builds().any(|build| build == &target.build))
        {
            return Err(PortcoveError::not_found(
                "This runtime is no longer offered for recovery by this setup.",
            )
            .detail("install_id", &target.build.install_id));
        }
        if is_default
            && profile::active_install_id(connection, port_id)?.as_deref()
                != Some(target.build.install_id.as_str())
        {
            return Err(PortcoveError::conflict(
                "Default follows the active runtime. Activate this exact runtime through game rollback before recovering the setup, if it is available there.",
            ));
        }
        // The retained-build verifier applies current definition and uploader
        // policy before comparing the exact installed identity.
        let actual = self.verified_retained_build(port_id, &target.build.install_id)?;
        if actual != target.build {
            return Err(PortcoveError::verification(
                "The retained runtime no longer matches this setup revision.",
            ));
        }
        Ok(())
    }

    /// Refuses a launch before resolving its executable when a reviewed recovery
    /// advanced the head but live materialization has yet to finish.
    pub(crate) fn require_materialized_profile_recovery(&self, port_id: &str) -> Result<()> {
        if !super::restore_pending(&self.library.user_dir(port_id)) {
            return Ok(());
        }
        let connection = self.library.connection()?;
        if let Some((profile_id, selected)) = profile::selection(&connection, port_id)?
            && profile::profile_by_id(&connection, port_id, &profile_id)?.current_revision
                != selected
        {
            return Err(PortcoveError::conflict(
                "This setup change still needs to finish. Activate the selected setup again before playing.",
            )
            .detail("profile_id", profile_id));
        }
        Ok(())
    }
}

fn verify_retained_package(layout: &Layout, package: &ResolvedPackage) -> Result<()> {
    let path = layout.package(&package.sha256, &package.native_id);
    crate::path::refuse_symlink_ancestors(&path)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            PortcoveError::not_found("The exact stored mod file is missing.")
        } else {
            error.into()
        }
    })?;
    let changed = || PortcoveError::verification("Stored mod bytes differ from the earlier setup.");
    if !metadata.is_file() || metadata.len() != package.size {
        return Err(changed());
    }
    if let Some(platform) = layout.dfu_platform {
        let inspection = crate::dfu_mod::inspect_data_only(&path, platform)?;
        return if inspection.package.sha256 == package.sha256
            && inspection.package.size == package.size
            && inspection.package.file_name == package.native_id
        {
            Ok(())
        } else {
            Err(changed())
        };
    }
    let file = fs::File::open(path)?;

    let mut input = file.take(package.size.saturating_add(1));
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        hash.update(&buffer[..read]);
    }
    if bytes != package.size || hex::encode(hash.finalize()) != package.sha256 {
        return Err(changed());
    }
    Ok(())
}
