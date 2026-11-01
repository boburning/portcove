//! Settings use only a verified installation's retained declaration. The live
//! catalog cannot enroll an older installation into a new write capability.

use super::*;
use crate::{
    GameSettingChange, GameSettingReview, GameSettingView, GameSettingsFile, GameSettingsFileView,
    GameSettingsView,
};

#[cfg(all(test, windows))]
mod tests;
#[cfg(windows)]
mod transaction;

struct SettingsContext {
    install: InstallRecord,
    port: PortDefinition,
    #[cfg(windows)]
    definition_sha256: String,
    runtime_root: PathBuf,
    direct: bool,
}

impl PortcoveService {
    // Caller holds ordinary port ownership, or the exact settings recovery
    // owner lock. This never reacquires a public operation's lock recursively.
    fn settings_context_already_locked(&self, port_id: &str) -> Result<SettingsContext> {
        let platform = Platform::current()?;
        if platform != Platform::WindowsX86_64 {
            return Err(PortcoveError::unsupported(
                "game settings are qualified only for Windows x86-64",
            ));
        }
        self.require_completed_backup_restore(port_id)?;
        self.require_completed_backup_deletion(port_id)?;
        let install = self.status(port_id)?.active.ok_or_else(|| {
            PortcoveError::not_found("no active managed installation offers settings")
        })?;
        self.managed_install_root(port_id, &install.path)?;
        let installer = Installer::new(self.library.clone())?;
        // Do not use installed_catalog's historical current-catalog fallback.
        // Absent retained authority remains absent even when today's catalog
        // advertises optional settings for this port.
        let catalog = installer.retained_catalog(&install)?.ok_or_else(|| PortcoveError::unsupported("this installation has no retained settings authority; basic behavior remains separately assessed"))?;
        let port = catalog.port(port_id)?.clone();
        let descriptor = port.game_settings.as_ref().ok_or_else(|| {
            PortcoveError::unsupported(
                "this retained installation does not offer optional settings",
            )
        })?;
        descriptor.validate(&port.persistent_paths)?;
        if !descriptor.releases.iter().any(|release| {
            release.platform == platform
                && release.version == install.version
                && release.archive_sha256 == install.artifact.sha256
        }) {
            return Err(PortcoveError::unsupported(
                "this installed release/artifact has no verified settings contract",
            ));
        }
        let qualification = InstallQualification::from_catalog(&catalog, port_id, platform)?;
        installer.verify_critical(&install, &qualification)?;
        self.require_definition_operation(
            &catalog,
            &port,
            DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true),
        )?;
        let contract = self.persistence_contract_for_install(&install)?;
        let runtime_root = self.persistence_root(&contract.port, &install.path)?;
        Ok(SettingsContext {
            install,
            #[cfg(windows)]
            definition_sha256: hex::encode(Sha256::digest(serde_json::to_vec(&port)?)),
            port,
            runtime_root,
            direct: contract.writes_directly,
        })
    }

    pub fn get_game_settings(&self, port_id: &str) -> Result<GameSettingsView> {
        let _ownership = self.library.try_lock_port(port_id, "read-game-settings")?;
        let context = match self.settings_context_already_locked(port_id) {
            Ok(context) => context,
            Err(error) => {
                return Ok(GameSettingsView {
                    port_id: port_id.into(),
                    install_id: None,
                    available: false,
                    reason: Some(error.message),
                    files: Vec::new(),
                });
            }
        };
        self.settings_view_already_locked(&context)
    }

    fn settings_view_already_locked(&self, context: &SettingsContext) -> Result<GameSettingsView> {
        let files = context
            .port
            .game_settings
            .as_ref()
            .expect("checked descriptor")
            .files
            .iter()
            .map(|file| match self.read_settings_file(context, file) {
                Ok(values) => GameSettingsFileView {
                    id: file.id.clone(),
                    path: file.path.clone(),
                    available: true,
                    reason: None,
                    configuration_sha256: Some(values.0),
                    settings: file
                        .settings
                        .iter()
                        .zip(values.1)
                        .map(|(setting, value)| GameSettingView {
                            id: setting.id.clone(),
                            label: setting.label.clone(),
                            value_type: setting.value.clone(),
                            value,
                        })
                        .collect(),
                },
                Err(error) => GameSettingsFileView {
                    id: file.id.clone(),
                    path: file.path.clone(),
                    available: false,
                    reason: Some(error.message),
                    configuration_sha256: None,
                    settings: Vec::new(),
                },
            })
            .collect();
        Ok(GameSettingsView {
            port_id: context.port.id.clone(),
            install_id: Some(context.install.id.clone()),
            available: true,
            reason: None,
            files,
        })
    }

    fn read_settings_file(
        &self,
        context: &SettingsContext,
        file: &GameSettingsFile,
    ) -> Result<(String, Vec<Option<serde_json::Value>>)> {
        let canonical = self.library.user_dir(&context.port.id).join(&file.path);
        let bytes = crate::external_runtime::read_single_link_metadata(&canonical, file.maximum_bytes)
            .map_err(|_| PortcoveError::conflict("configuration is not readable yet; complete a normal game launch and synchronization before editing"))?;
        if !context.direct {
            let runtime = context.runtime_root.join(&file.path);
            let runtime_bytes =
                crate::external_runtime::read_single_link_metadata(&runtime, file.maximum_bytes)?;
            if bytes != runtime_bytes {
                return Err(PortcoveError::conflict(
                    "runtime and canonical configuration differ; preserve both and complete normal synchronization before editing",
                ));
            }
        }
        let values = crate::game_settings::document::read(file, &bytes)?;
        Ok((hex::encode(Sha256::digest(&bytes)), values))
    }

    pub fn review_game_setting(
        &self,
        port_id: &str,
        file_id: &str,
        setting_id: &str,
        change: GameSettingChange,
    ) -> Result<GameSettingReview> {
        let _ownership = self.library.try_lock_port(port_id, "review-game-setting")?;
        let context = self.settings_context_already_locked(port_id)?;
        #[cfg(windows)]
        {
            Ok(self
                .prepare_settings_change(&context, file_id, setting_id, change)?
                .review)
        }
        #[cfg(not(windows))]
        {
            let _ = (context, file_id, setting_id, change);
            Err(PortcoveError::unsupported(
                "game settings review requires Windows",
            ))
        }
    }

    #[cfg(not(windows))]
    pub fn apply_game_setting(
        &self,
        _port_id: &str,
        _file_id: &str,
        _setting_id: &str,
        _change: GameSettingChange,
        _review_sha256: &str,
    ) -> Result<GameSettingsView> {
        Err(PortcoveError::unsupported(
            "game settings changes require Windows x86-64",
        ))
    }

    #[cfg(not(windows))]
    pub(super) fn recover_settings_change(
        &self,
        _store: &OperationStore,
        _operation: &mut LifecycleOperation,
    ) -> Result<()> {
        Err(PortcoveError::unsupported(
            "configuration custody requires recovery on its Windows host; retained files were not changed",
        ))
    }
}

#[cfg(windows)]
#[derive(Serialize)]
struct ReviewObjects<'a> {
    canonical: (&'a str, &'a str),
    runtime: Option<(&'a str, &'a str)>,
}

#[cfg(windows)]
fn review_binding(
    context: &SettingsContext,
    file: &GameSettingsFile,
    review: &GameSettingReview,
    proposed_sha256: &str,
    objects: ReviewObjects<'_>,
) -> Result<String> {
    let mut unsigned = review.clone();
    unsigned.review_sha256.clear();
    let binding = serde_json::json!({ "format_version": 1, "install": context.install,
        "definition_sha256": context.definition_sha256, "file": file,
        "review": unsigned, "proposed_sha256": proposed_sha256, "objects": objects });
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&binding)?)))
}

#[cfg(windows)]
struct PreparedSettingsChange {
    review: GameSettingReview,
    bytes: Vec<u8>,
    canonical: crate::game_settings::windows::HeldFile,
    runtime: Option<crate::game_settings::windows::HeldFile>,
}

#[cfg(windows)]
impl PortcoveService {
    fn prepare_settings_change(
        &self,
        context: &SettingsContext,
        file_id: &str,
        setting_id: &str,
        change: GameSettingChange,
    ) -> Result<PreparedSettingsChange> {
        use crate::game_settings::{document, windows::HeldFile};
        let file = context
            .port
            .game_settings
            .as_ref()
            .expect("checked descriptor")
            .files
            .iter()
            .find(|file| file.id == file_id)
            .ok_or_else(|| {
                PortcoveError::usage("configuration file is absent from the retained descriptor")
            })?;
        let index = file
            .settings
            .iter()
            .position(|setting| setting.id == setting_id)
            .ok_or_else(|| {
                PortcoveError::usage("setting is absent from the retained descriptor")
            })?;
        let setting = &file.settings[index];
        let mut canonical =
            HeldFile::open(&self.library.user_dir(&context.port.id).join(&file.path))?;
        canonical.require_editable_security()?;
        let before = canonical.bytes(file.maximum_bytes)?;
        let runtime = if context.direct {
            None
        } else {
            let mut runtime = HeldFile::open(&context.runtime_root.join(&file.path))?;
            runtime.require_editable_security()?;
            if runtime.bytes(file.maximum_bytes)? != before {
                return Err(PortcoveError::conflict(
                    "runtime and canonical configuration differ; synchronize and review again",
                ));
            }
            Some(runtime)
        };
        let previous_value = document::read(file, &before)?.remove(index);
        let proposed = match &change {
            GameSettingChange::Set { value } => value.clone(),
            GameSettingChange::Reset => setting.value.default_value(),
        };
        let bytes = document::edit(file, &before, setting_id, &proposed)?;
        let proposed_value = document::read(file, &bytes)?
            .remove(index)
            .expect("edited declared value");
        let configuration_sha256 = hex::encode(Sha256::digest(&before));
        let mut review = GameSettingReview {
            port_id: context.port.id.clone(),
            install_id: context.install.id.clone(),
            file_id: file_id.into(),
            setting_id: setting_id.into(),
            label: setting.label.clone(),
            path: file.path.clone(),
            change,
            previous_value,
            proposed_value,
            configuration_sha256,
            review_sha256: String::new(),
        };
        review.review_sha256 = review_binding(
            context,
            file,
            &review,
            &hex::encode(Sha256::digest(&bytes)),
            ReviewObjects {
                canonical: (&canonical.identity, &canonical.parent_identity),
                runtime: runtime
                    .as_ref()
                    .map(|held| (held.identity.as_str(), held.parent_identity.as_str())),
            },
        )?;
        Ok(PreparedSettingsChange {
            review,
            bytes,
            canonical,
            runtime,
        })
    }
}
