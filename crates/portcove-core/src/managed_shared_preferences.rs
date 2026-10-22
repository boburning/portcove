//! Reviewed GB Recompiled scope. Account-wide preferences are never owned data.
use crate::{
    AcceptedSharedPreferencesBinding, ManagedSharedPreferencesReview, PortDefinition,
    PortcoveError, PreparedSharedPreferencesContract, Result,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) const SHA: &str = "d16ba320c75a23765ef1e84c6f70f551612834914c70fd4c542e20ae7ce5dcc6";
const NAME: &str = "Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip";
const ORIGINAL: &str = "9a97678cbd8da02c8763e977674e17f460c06ea8b73bad35c52fe6817f506d44";

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let Some(contract) = port.managed_shared_preferences else {
        if port.runtime_source_materialization
            == Some(crate::RuntimeSourceMaterialization::RegaidenGbc)
            || port.managed_shared_preferences_save_id.is_some()
            || (port.release.provider == crate::ReleaseSource::DirectManifest
                && port
                    .release
                    .direct
                    .values()
                    .any(|release| release.sha256.eq_ignore_ascii_case(SHA)))
        {
            return Err(PortcoveError::usage(
                "managed ReGaiden requires its explicit shared-preferences contract",
            ));
        }
        return Ok(());
    };
    let release = port.release.direct.get(&crate::Platform::WindowsX86_64);
    let legacy = contract == PreparedSharedPreferencesContract::Regaiden041Windows;
    let reviewed = contract == PreparedSharedPreferencesContract::GbRecompiledWindowsV1;
    if reviewed {
        crate::managed_runtime_policy::artifact(port)?;
        let save_id = port
            .managed_shared_preferences_save_id
            .as_deref()
            .ok_or_else(|| {
                PortcoveError::verification(
                    "managed GB preferences require the reviewed upstream save identifier",
                )
            })?;
        crate::archive::validate_relative_path(save_id, false)?;
        if save_id.is_empty() || save_id.len() > 128 || save_id.contains('/') || !save_id.is_ascii()
        {
            return Err(PortcoveError::verification(
                "managed GB save identifier must be one bounded portable ASCII name",
            ));
        }
    }
    if (!legacy && !reviewed)
        || (!reviewed && port.managed_shared_preferences_save_id.is_some())
        || port.platforms != [crate::Platform::WindowsX86_64]
        || port.adapter != crate::AdapterKind::StagedSourcePortable
        || port.release.provider != crate::ReleaseSource::DirectManifest
        || !port.release.user_prepared.is_empty()
        || (legacy
            && release.is_none_or(|release| {
                release.version != "v0.4.1" || release.size != 33_085_815 || release.sha256 != SHA
            }))
        || (legacy && port.source_profile.as_deref() != Some("resident-evil-gaiden-gbc-usa"))
        || port.source_profile.as_deref().is_none_or(str::is_empty)
        || port.windows_runtime_path_policy
            != Some(crate::WindowsRuntimePathPolicy::PrintableAsciiMaxPath)
        || port.runtime_source_filename.as_deref() != Some("game.gbc")
        || port.runtime_source_materialization
            != Some(crate::RuntimeSourceMaterialization::RegaidenGbc)
        || port.runtime_source_hashes.len() != 1
        || (legacy
            && port
                .runtime_source_hashes
                .get("game.gbc")
                .map(String::as_str)
                != Some(ORIGINAL))
        || port
            .runtime_source_hashes
            .get("game.gbc")
            .is_none_or(|hash| {
                hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        || !port.runtime_source_set.is_empty()
        || port.runtime_subdirectory.is_some()
        || !port.launch_from_install_root
        || port.launch_arguments != ["--rom", "game.gbc", "--save-dir", "saves"]
        || port.source_environment.is_some()
        || port.user_data_environment.is_some()
        || !port.launch_environment.is_empty()
        || !port.bundled_runtime.is_empty()
        || port.managed_initialization.is_some()
        || port.runtime_data_policy.is_some()
        || port.persistent_paths
            != [
                "game.gbc",
                "config.ini",
                "runtime_prefs.ini",
                "imgui.ini",
                "saves",
                "snapshots",
            ]
        || !port.persistent_file_patterns.is_empty()
        || !port.runtime_mutable_paths.is_empty()
        || !port.runtime_mutable_file_patterns.is_empty()
        || port
            .executable_hints
            .get(&crate::Platform::WindowsX86_64)
            .is_none_or(|hints| {
                if legacy {
                    hints != &["Resident_Evil_Gaiden__USA_.exe"]
                } else {
                    hints.len() != 1 || !hints[0].to_ascii_lowercase().ends_with(".exe")
                }
            })
    {
        return Err(PortcoveError::usage(
            "managed shared preferences require the reviewed GB Recompiled Windows artifact, local data and fixed launch route",
        ));
    }
    Ok(())
}

pub(crate) fn require_artifact(
    port: &PortDefinition,
    version: &str,
    artifact: &crate::ArtifactIdentity,
    platform: Option<crate::Platform>,
) -> Result<()> {
    validate(port)?;
    if port.managed_shared_preferences
        == Some(PreparedSharedPreferencesContract::GbRecompiledWindowsV1)
    {
        return crate::managed_runtime_policy::require_artifact(port, version, artifact, platform);
    }
    if port.managed_shared_preferences.is_some() || artifact.sha256.eq_ignore_ascii_case(SHA) {
        if port.managed_shared_preferences.is_none()
            || version != "v0.4.1"
            || platform != Some(crate::Platform::WindowsX86_64)
            || artifact.sha256 != SHA
            || artifact.size != 33_085_815
            || artifact.asset_name != NAME
        {
            return Err(PortcoveError::verification(
                "shared-preferences acceptance requires the actual reviewed ReGaiden Windows package",
            ));
        }
    }
    Ok(())
}

pub(crate) fn review(
    port: &PortDefinition,
    root: &Path,
) -> Result<Option<ManagedSharedPreferencesReview>> {
    validate(port)?;
    if port.managed_shared_preferences.is_none() {
        return Ok(None);
    }
    crate::path::refuse_symlink_ancestors(root)?;
    let root = crate::path::normalized_absolute(root, "managed ReGaiden installation")?;
    let scope = crate::external_runtime::shared_preferences::inspect_managed(&root, port)?;
    Ok(Some(ManagedSharedPreferencesReview {
        binding: scope.binding,
        local_fallback_path: scope
            .local_fallback_path
            .ok_or_else(|| PortcoveError::verification("shared review has no local fallback"))?,
        shared_present: scope.present,
        local_fallback_present: scope.local_fallback_present,
    }))
}

/// This private carrier is constructed only after exact reviewed authorization.
/// Its serialized form belongs to the hashed installation manifest, not catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Acceptance {
    binding: AcceptedSharedPreferencesBinding,
    local_fallback_path: PathBuf,
}

impl Acceptance {
    pub(crate) fn validate_for(&self, port: &PortDefinition) -> Result<()> {
        if port.managed_shared_preferences != Some(self.binding.contract)
            || !matches!(
                self.binding.contract,
                PreparedSharedPreferencesContract::Regaiden041Windows
                    | PreparedSharedPreferencesContract::GbRecompiledWindowsV1
            )
            || self.binding.account_sid_sha256.len() != 64
            || !self
                .binding
                .account_sid_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || !self.binding.path.is_absolute()
            || !self.local_fallback_path.is_absolute()
            || self
                .local_fallback_path
                .file_name()
                .and_then(|name| name.to_str())
                != Some("runtime_prefs.ini")
            || [&self.binding.path, &self.local_fallback_path]
                .iter()
                .any(|path| {
                    path.components().any(|part| {
                        matches!(
                            part,
                            std::path::Component::CurDir | std::path::Component::ParentDir
                        )
                    })
                })
        {
            return Err(PortcoveError::verification(
                "retained shared-preferences acceptance is inconsistent",
            ));
        }
        Ok(())
    }
    pub(crate) fn after_review(review: &ManagedSharedPreferencesReview) -> Self {
        Self {
            binding: review.binding.clone(),
            local_fallback_path: review.local_fallback_path.clone(),
        }
    }

    pub(crate) fn matches_current(&self, port: &PortDefinition, root: &Path) -> Result<bool> {
        self.validate_for(port)?;
        let current = review(port, root)?.ok_or_else(|| {
            PortcoveError::verification("retained shared acceptance has no matching contract")
        })?;
        Ok(self.binding == current.binding
            && self.local_fallback_path == current.local_fallback_path)
    }

    pub(crate) fn require_current(&self, port: &PortDefinition, root: &Path) -> Result<()> {
        if !self.matches_current(port, root)? {
            return Err(PortcoveError::conflict(
                "Shared preferences account or location changed. Remove the managed installation while keeping saves and settings, then review a fresh installation for this Windows account. Do not move, delete or edit the shared preferences file.",
            ));
        }
        Ok(())
    }
}

pub(crate) fn require_acceptance(
    port: &PortDefinition,
    accepted: Option<&Acceptance>,
    root: &Path,
) -> Result<()> {
    match (port.managed_shared_preferences, accepted) {
        (None, None) => Ok(()),
        (Some(_), Some(accepted)) => accepted.require_current(port, root),
        _ => Err(PortcoveError::verification(
            "explicit acceptance of this installation's shared preferences is missing; review installation again",
        )),
    }
}

pub(crate) fn refuse_scope_transfer(port: &PortDefinition) -> Result<()> {
    if port.managed_shared_preferences.is_some() {
        return Err(PortcoveError::unsupported(
            "ReGaiden shared-preferences acceptance belongs to this Windows account and installation folder. Remove managed versions while keeping saves and settings, choose the new location, then review a fresh installation. The shared preferences file is not part of the move.",
        ));
    }
    Ok(())
}

pub(crate) fn prepare_owned_saves(port: &PortDefinition, root: &Path) -> Result<()> {
    if port.managed_shared_preferences.is_none() {
        return Ok(());
    }
    validate(port)?;
    let saves = root.join("saves");
    crate::path::refuse_symlink_ancestors(&saves)?;
    match fs::create_dir(&saves) {
        Ok(()) => crate::durability::sync_publication(root)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    crate::path::refuse_symlink_ancestors(&saves)?;
    if !fs::symlink_metadata(&saves)?.is_dir() {
        return Err(PortcoveError::verification(
            "ReGaiden saves must be an owned directory",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PORT: &str = "resident-evil-gaiden-recomp";

    #[test]
    fn managed_command_builder_refuses_forwarded_original_and_save_paths() {
        use crate::Adapter;
        let temporary = tempfile::tempdir().unwrap();
        let library = crate::Library::open(temporary.path().join("library")).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port(PORT).unwrap();
        let root = temporary.path().join("runtime");
        fs::create_dir(&root).unwrap();
        let executable = root.join("Resident_Evil_Gaiden__USA_.exe");
        fs::write(&executable, b"not executed").unwrap();
        let spec = crate::adapter::standard(port.adapter)
            .launch_spec_with_executable(
                crate::LaunchSpecRequest {
                    library: &library,
                    port,
                    platform: crate::Platform::WindowsX86_64,
                    install_root: &root,
                    selected_executable: &executable,
                    source: None,
                    source_record: None,
                },
                &|| Ok(()),
            )
            .unwrap();
        assert!(spec.fixed_arguments_only);
        assert_eq!(spec.arguments, port.launch_arguments);
        for forwarded in [["--rom", "other.gbc"], ["--save-dir", "other"]] {
            assert!(
                crate::ChildProcessPolicy::game_command(
                    &spec.process_spec(),
                    &forwarded.map(str::to_owned)
                )
                .is_err()
            );
        }
        crate::ChildProcessPolicy::game_command(&spec.process_spec(), &[]).unwrap();
        assert!(
            !root.join("game.gbc").exists(),
            "planning and command construction must not prepare or spawn a game"
        );
    }

    #[test]
    fn exact_managed_route_refuses_weakened_artifact_and_historical_reinterpretation() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port(PORT).unwrap().clone();
        validate(&port).unwrap();
        let artifact = crate::ArtifactIdentity {
            asset_name: NAME.into(),
            sha256: SHA.into(),
            size: 33_085_815,
        };
        require_artifact(
            &port,
            "v0.4.1",
            &artifact,
            Some(crate::Platform::WindowsX86_64),
        )
        .unwrap();
        assert!(
            require_artifact(
                &port,
                "0.4.1",
                &artifact,
                Some(crate::Platform::WindowsX86_64)
            )
            .is_err()
        );
        assert!(
            require_artifact(
                &port,
                "v0.4.1",
                &artifact,
                Some(crate::Platform::LinuxX86_64)
            )
            .is_err()
        );
        for changed in [
            {
                let mut changed = port.clone();
                changed.managed_shared_preferences = None;
                changed
            },
            {
                let mut changed = port.clone();
                changed.runtime_source_materialization =
                    Some(crate::RuntimeSourceMaterialization::Copy);
                changed
            },
            {
                let mut changed = port.clone();
                changed.launch_arguments.push("--unsafe".into());
                changed
            },
            {
                let mut changed = port.clone();
                changed.persistent_paths.push("../shared".into());
                changed
            },
        ] {
            assert!(validate(&changed).is_err());
        }
        let historical = crate::Catalog::from_json(include_str!(
            "../tests/fixtures/regaiden-041-prepared-historical.json"
        ))
        .unwrap();
        let old = historical.port(PORT).unwrap();
        assert!(old.managed_shared_preferences.is_none());
        let mut weakened = port.clone();
        weakened.managed_shared_preferences = None;
        weakened.runtime_source_materialization = Some(crate::RuntimeSourceMaterialization::Copy);
        weakened
            .release
            .direct
            .get_mut(&crate::Platform::WindowsX86_64)
            .unwrap()
            .sha256
            .make_ascii_uppercase();
        assert!(validate(&weakened).is_err());
        let mut uppercase = artifact.clone();
        uppercase.sha256.make_ascii_uppercase();
        assert!(
            require_artifact(
                old,
                "v0.4.1",
                &uppercase,
                Some(crate::Platform::WindowsX86_64)
            )
            .unwrap_err()
            .message
            .contains("reviewed ReGaiden")
        );
        assert_eq!(old.release.provider, crate::ReleaseSource::UserPrepared);
        assert!(refuse_scope_transfer(&port).is_err());
        refuse_scope_transfer(old).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn acceptance_binds_account_and_both_paths_without_owning_shared_preferences() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port(PORT).unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("runtime");
        let scope = review(port, &root).unwrap().unwrap();
        assert!(
            !root.exists(),
            "review must not initialize an installation or global directory"
        );
        let accepted = Acceptance::after_review(&scope);
        require_acceptance(port, Some(&accepted), &root).unwrap();
        assert!(require_acceptance(port, None, &root).is_err());
        let mut changed = accepted.clone();
        changed.binding.account_sid_sha256 = "0".repeat(64);
        assert!(changed.require_current(port, &root).is_err());
        let mut changed = accepted.clone();
        changed.binding.path = temporary.path().join("other.ini");
        assert!(changed.require_current(port, &root).is_err());
        assert!(
            accepted
                .require_current(port, &temporary.path().join("moved"))
                .is_err()
        );
        fs::create_dir(&root).unwrap();
        prepare_owned_saves(port, &root).unwrap();
        assert!(root.join("saves").is_dir());
        assert!(!root.join("runtime_prefs.ini").exists());
        assert!(
            scope
                .write_scope_disclosure()
                .contains("never owns, moves, backs up, restores or deletes")
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn generic_install_authorization_does_not_accept_shared_scope() {
        let temporary = tempfile::tempdir().unwrap();
        let library = crate::Library::open(temporary.path().join("library")).unwrap();
        // Persisted-source fixture isolates authorization from intake. Applying
        // this token still has to validate the original before acquisition.
        library
            .register_source(&crate::SourceRecord {
                profile_id: "resident-evil-gaiden-gbc-usa".into(),
                path: temporary.path().join("original.gbc"),
                sha256: ORIGINAL.into(),
                size: 2_097_152,
                storage_sha256: ORIGINAL.into(),
                storage_size: 2_097_152,
                updated_at: 1,
                observed_identity: None,
            })
            .unwrap();
        let service = crate::PortcoveService::new(library).unwrap();
        let plan = service.plan_game_install(PORT).await.unwrap();
        assert!(plan.plan.shared_preferences.is_some());
        assert!(
            service
                .authorize_game_install(PORT, &plan.plan_sha256)
                .await
                .unwrap_err()
                .message
                .contains("acknowledgment")
        );
        assert!(
            service
                .authorize_game_install_with_shared_preferences_ack(
                    PORT,
                    &plan.plan_sha256,
                    Some(&"0".repeat(64))
                )
                .await
                .is_err()
        );
        service
            .authorize_game_install_with_shared_preferences_ack(
                PORT,
                &plan.plan_sha256,
                Some(&plan.plan_sha256),
            )
            .await
            .unwrap();
        assert!(
            !plan
                .plan
                .output_location
                .effective_output_directory
                .exists()
        );
    }
}
