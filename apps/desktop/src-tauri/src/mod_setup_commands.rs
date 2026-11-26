//! Library-bound adapter for game mod setups. Core owns support, identity,
//! revisions, deployment, locking and recovery; these commands only forward.
//! Changes, which can copy archives or move saves, check the library generation
//! before and after opening the service instead of holding the desktop state
//! lock for the whole operation, like other file-moving commands.
use std::path::PathBuf;

use crate::{
    DesktopResult, DesktopState, blocking_worker,
    desktop_contract::{RecipeAcquisitionStep, RecipeImportReview},
    game_settings_commands::read_at_generation,
    service_at_generation,
};
use portcove_core::{
    ModSetupsView, PortcoveError, Profile, ProfileProgressCopy, ProfileRecipe, ProfileRecoveryPlan,
    ProfileRevision, ProfileUpdatePolicy, ProviderUpdateObservation,
};

impl RecipeImportReview {
    pub(crate) fn new(mut plan: portcove_core::RecipeImportPlan) -> portcove_core::Result<Self> {
        let serialized_plan = serde_json::to_string(&plan)?;
        // The provider plans travel once, inside the authoritative serialized
        // plan. The display copy keeps only which packages are staged.
        plan.staging.provider_plans.clear();
        let setting_values = plan
            .recipe
            .settings
            .iter()
            .map(|setting| match &setting.value {
                portcove_core::RecipeModSettingValue::Number(value) => value.to_string(),
                portcove_core::RecipeModSettingValue::Choice(value) => value.clone(),
            })
            .collect();
        Ok(Self {
            plan,
            serialized_plan,
            setting_values,
        })
    }

    /// Decoding is transport only. The command still performs the ordinary
    /// generation, port, plan-digest, consent and current-input checks in Core.
    pub(crate) fn decode(
        serialized_plan: &str,
    ) -> portcove_core::Result<portcove_core::RecipeImportPlan> {
        serde_json::from_str(serialized_plan).map_err(Into::into)
    }
}

#[tauri::command]
pub(crate) async fn get_mod_setups(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    browse_only: Option<bool>,
) -> DesktopResult<ModSetupsView> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            if browse_only == Some(true) {
                service.preview_mod_handoff(&port_id)
            } else {
                service.preview_mod_setups(&port_id)
            }
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_mod_portal_preferences(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    expected_revision: u64,
    choices: portcove_core::ModPortalChoices,
) -> DesktopResult<portcove_core::ModPortalsView> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .set_mod_portal_preferences(&port_id, expected_revision, choices)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_default_mod_setup(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
) -> DesktopResult<Profile> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .ensure_default_profile(&port_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn copy_mod_setup(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    display_name: String,
    current_build: bool,
    progress: Option<ProfileProgressCopy>,
) -> DesktopResult<Profile> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        if let Some(progress) = progress {
            service.copy_profile_with_progress(
                &port_id,
                &profile_id,
                &display_name,
                current_build,
                &progress,
            )
        } else if current_build {
            service.copy_profile_onto_current_build(&port_id, &profile_id, &display_name)
        } else {
            service.copy_profile(&port_id, &profile_id, &display_name)
        }
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_clean_mod_setup(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    display_name: String,
    expected_revision: u64,
) -> DesktopResult<Profile> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .create_clean_profile(&port_id, &profile_id, &display_name, expected_revision)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_mod_setup_revisions(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
) -> DesktopResult<Vec<ProfileRevision>> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            service.profile_revisions(&port_id, &profile_id)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn plan_profile_recovery(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    revision: u64,
) -> DesktopResult<ProfileRecoveryPlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            service.plan_profile_recovery(&port_id, &profile_id, revision)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_profile_recovery(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    revision: u64,
    expected_plan_sha256: String,
) -> DesktopResult<ProfileRevision> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .apply_profile_recovery(&port_id, &profile_id, revision, &expected_plan_sha256)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_mod_setup_recovery_builds(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
) -> DesktopResult<Vec<portcove_core::RetainedBuildHistoryResolution>> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            service
                .resolve_retained_build(&port_id, &profile_id)
                .map(|setup| setup.history)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_mod_setup_retirement(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    revision: u64,
) -> DesktopResult<portcove_core::RetainedBuildRetirementPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            service.preview_retained_build_revision_retirement(&port_id, &profile_id, revision)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn retire_mod_setup_recovery_build(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    revision: u64,
    expected_preview_sha256: String,
) -> DesktopResult<portcove_core::RetainedBuildRevision> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let approval = service.authorize_retained_build_revision_retirement(
            &port_id,
            &profile_id,
            revision,
            &expected_preview_sha256,
        )?;
        service
            .retire_retained_build_revision(&port_id, &profile_id, revision, &approval.token)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn use_mod_setup(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
) -> DesktopResult<ProfileRevision> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .activate_profile(&port_id, &profile_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn export_mod_recipe(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    path: PathBuf,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .write_profile_recipe(&port_id, &profile_id, &path)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn inspect_mod_recipe(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    path: PathBuf,
) -> DesktopResult<RecipeImportReview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            let recipe = ProfileRecipe::read_file(&path)?;
            require_recipe_port(&port_id, &recipe)?;
            RecipeImportReview::new(service.plan_recipe_import(&recipe)?)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn acquire_mod_recipe_package(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    native_id: String,
    serialized_plan: String,
) -> DesktopResult<RecipeImportReview> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            let plan = RecipeImportReview::decode(&serialized_plan)?;
            require_recipe_port(&port_id, &plan.recipe)?;
            RecipeImportReview::new(
                service
                    .acquire_recipe_package(&plan, &profile_id, &native_id)
                    .await?,
            )
            .map_err(Into::into)
        },
    )
    .await
}

/// Stages the next missing recipe packages in one bounded step. The app
/// repeats it until no package is left to check or a step stops at a failure.
#[tauri::command]
pub(crate) async fn acquire_mod_recipe_packages(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    serialized_plan: String,
) -> DesktopResult<RecipeAcquisitionStep> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            let plan = RecipeImportReview::decode(&serialized_plan)?;
            require_recipe_port(&port_id, &plan.recipe)?;
            let batch = service.acquire_recipe_packages(&plan, &profile_id).await?;
            Ok(RecipeAcquisitionStep {
                review: RecipeImportReview::new(batch.plan)?,
                acquired: batch.acquired,
                failure: batch.failure,
            })
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn discard_mod_recipe_review(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    serialized_plan: String,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let plan = RecipeImportReview::decode(&serialized_plan)?;
        require_recipe_port(&port_id, &plan.recipe)?;
        service.discard_recipe_review(&plan).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_mod_recipe(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    display_name: String,
    serialized_plan: String,
    allow_code: bool,
) -> DesktopResult<Profile> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let plan = RecipeImportReview::decode(&serialized_plan)?;
        require_recipe_port(&port_id, &plan.recipe)?;
        if !plan.can_apply {
            return Err(PortcoveError::conflict("this recipe still needs exact inputs").into());
        }
        let authorization = if allow_code {
            service.authorize_recipe_import_allowing_code(&plan, &display_name)?
        } else {
            service.authorize_recipe_import(&plan, &display_name)?
        };
        service
            .apply_recipe_import(&plan, &display_name, &authorization.token)
            .map_err(Into::into)
    })
    .await
}

fn require_recipe_port(port_id: &str, recipe: &ProfileRecipe) -> portcove_core::Result<()> {
    if recipe.port_id == port_id {
        Ok(())
    } else {
        Err(PortcoveError::conflict(
            "this recipe is for a different game. Open that game's setups to review it",
        )
        .detail("recipe_game", &recipe.port_id))
    }
}

#[tauri::command]
pub(crate) async fn set_mod_update_policy(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    policy: ProfileUpdatePolicy,
) -> DesktopResult<Profile> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .set_profile_update_policy(&port_id, &profile_id, policy)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn check_provider_mod_updates(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
) -> DesktopResult<Vec<ProviderUpdateObservation>> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            service
                .check_provider_updates(&port_id, &profile_id)
                .await
                .map_err(Into::into)
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_mod_package_enabled(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    native_id: String,
    enabled: bool,
    expected_revision: u64,
) -> DesktopResult<ProfileRevision> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .set_mod_package_enabled(
                &port_id,
                &profile_id,
                &native_id,
                enabled,
                expected_revision,
            )
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn remove_mod_package(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    native_id: String,
    expected_revision: u64,
) -> DesktopResult<ProfileRevision> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .remove_mod_package(&port_id, &profile_id, &native_id, expected_revision)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn add_mod_package(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    path: PathBuf,
    expected_revision: u64,
    allow_code_sha256: Option<String>,
) -> DesktopResult<ProfileRevision> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        match allow_code_sha256 {
            Some(sha256) => service.install_mod_package_allowing_code(
                &port_id,
                &profile_id,
                &path,
                expected_revision,
                &sha256,
            ),
            None => service.install_mod_package(&port_id, &profile_id, &path, expected_revision),
        }
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn plan_local_mod_package(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    path: PathBuf,
    expected_revision: u64,
    workspace: Option<bool>,
) -> DesktopResult<portcove_core::LocalModPackagePlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            if workspace.unwrap_or(false) {
                service.plan_workspace_local_mod_package(
                    &port_id,
                    &profile_id,
                    &path,
                    expected_revision,
                )
            } else {
                service.plan_local_mod_package(&port_id, &profile_id, &path, expected_revision)
            }
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_local_mod_package(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    path: PathBuf,
    expected_plan_sha256: String,
    allow_code: bool,
) -> DesktopResult<ProfileRevision> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .apply_local_mod_package(
                &port_id,
                &profile_id,
                &path,
                &expected_plan_sha256,
                allow_code,
            )
            .map_err(Into::into)
    })
    .await
}

/// Read-only: what a chosen package would run, shown before the player allows it.
#[tauri::command]
pub(crate) async fn review_mod_package_code(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    path: PathBuf,
) -> DesktopResult<Option<portcove_core::ModCodeReview>> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .review_mod_package_code(&port_id, &path)
            .map_err(Into::into)
    })
    .await
}

/// Opens the canonical URL of a project admitted for this game's provider.
#[tauri::command]
pub(crate) async fn open_provider_mod_project(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    project_id: String,
    provider: Option<String>,
) -> DesktopResult<()> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            let reviewed = service
                .provider_project_for_provider(&port_id, &project_id, provider.as_deref())
                .await?;
            crate::open_host_target(std::ffi::OsStr::new(&reviewed.project.profile_url))
        },
    )
    .await
}

/// Checks the selected port's reviewed community source without contacting it.
#[tauri::command]
pub(crate) async fn jakmods_setup_url(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
) -> DesktopResult<Option<String>> {
    crate::blocking_service_at_generation(state.inner().clone(), generation, move |service| {
        Ok(
            portcove_core::jakmods_game(service.catalog().port(&port_id)?)
                .map(|_| portcove_core::JAKMODS_SETUP_URL.to_owned()),
        )
    })
    .await
}

/// Reads the community catalog only after the player chooses to browse.
#[tauri::command]
pub(crate) async fn get_jakmods_catalog(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
) -> DesktopResult<portcove_core::JakModsCatalog> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            service
                .jakmods_catalog(&port_id, portcove_core::Platform::current()?)
                .await
                .map_err(Into::into)
        },
    )
    .await
}

/// The renderer can select a displayed source link, but cannot supply a new destination.
#[tauri::command]
pub(crate) async fn open_jakmods_resource(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    project_id: Option<String>,
    expected_url: String,
) -> DesktopResult<()> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            let port = service.catalog().port(&port_id)?;
            if portcove_core::jakmods_game(port).is_none() {
                return Err(portcove_core::PortcoveError::unsupported(
                    "JakMods is unavailable for this game",
                )
                .into());
            }
            let matches = if let Some(id) = project_id {
                service
                    .jakmods_catalog(&port_id, portcove_core::Platform::current()?)
                    .await?
                    .projects
                    .iter()
                    .any(|project| {
                        project.id == id
                            && (project.external_url.as_deref() == Some(expected_url.as_str())
                                || project.website_url.as_deref() == Some(expected_url.as_str()))
                    })
            } else {
                expected_url == portcove_core::JAKMODS_SETUP_URL
            };
            if !matches {
                return Err(portcove_core::PortcoveError::conflict(
                    "The JakMods link changed. Refresh the catalog before opening it.",
                )
                .into());
            }
            crate::open_host_target(std::ffi::OsStr::new(&expected_url))
        },
    )
    .await
}

/// Bounded read-only catalog for one of the port's reviewed sources.
#[tauri::command]
pub(crate) async fn get_mod_provider_catalog(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    source: String,
    start_page: Option<u32>,
) -> DesktopResult<portcove_core::ProviderCatalog> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            service
                .mod_provider_catalog_from(&port_id, &source, start_page.unwrap_or(1))
                .await
                .map_err(Into::into)
        },
    )
    .await
}

/// One provider mod's files or versions. Reads only.
#[tauri::command]
pub(crate) async fn get_provider_project(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    project_id: String,
    provider: Option<String>,
) -> DesktopResult<portcove_core::ProviderProjectView> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            service
                .provider_project_for_provider(&port_id, &project_id, provider.as_deref())
                .await
                .map_err(Into::into)
        },
    )
    .await
}

/// Reviews one provider file for a setup: downloads it privately and inspects
/// it, changing nothing but private staging.
#[tauri::command]
pub(crate) async fn plan_provider_install(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    project_id: String,
    file_id: String,
    provider: Option<String>,
    expected_game_id: Option<String>,
) -> DesktopResult<portcove_core::ProviderInstallPlan> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            if let Some(expected_game_id) = expected_game_id {
                let source = provider.as_deref().ok_or_else(|| {
                    portcove_core::PortcoveError::usage(
                        "Choose a mod source before reviewing the file",
                    )
                })?;
                return service
                    .plan_workspace_provider_install(
                        &port_id,
                        &profile_id,
                        source,
                        &project_id,
                        &file_id,
                        &expected_game_id,
                    )
                    .await
                    .map_err(Into::into);
            }
            service
                .plan_provider_install_for_provider(
                    &port_id,
                    &profile_id,
                    &project_id,
                    &file_id,
                    provider.as_deref(),
                )
                .await
                .map_err(Into::into)
        },
    )
    .await
}

/// Refuses a plan that is not the one the player saw for this game and setup.
fn require_displayed_plan(
    plan: &portcove_core::ProviderInstallPlan,
    port_id: &str,
    profile_id: &str,
    expected_plan_sha256: &str,
) -> DesktopResult<()> {
    if plan.port_id != port_id
        || plan.profile_id != profile_id
        || plan.plan_sha256 != expected_plan_sha256
    {
        return Err(portcove_core::PortcoveError::conflict(
            "this review is for a different setup or has changed; review the file again",
        )
        .into());
    }
    Ok(())
}

/// Installs exactly the reviewed plan after the player confirmed it for the
/// setup shown. Core checks the plan's digest and the setup's revision again
/// under its lock.
#[tauri::command]
pub(crate) async fn apply_provider_install(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    expected_plan_sha256: String,
    plan: portcove_core::ProviderInstallPlan,
    allow_code: bool,
) -> DesktopResult<ProfileRevision> {
    require_displayed_plan(&plan, &port_id, &profile_id, &expected_plan_sha256)?;
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        // Code is allowed only when the player chose to after seeing which
        // reviewed packages run it; Core binds that to the plan's digest.
        let authorization = if allow_code {
            service.authorize_provider_install_allowing_code(&plan)?
        } else {
            service.authorize_provider_install(&plan)?
        };
        service
            .apply_provider_install(&plan, &authorization.token)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_mod_setup_draft(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    expected_revision: u64,
    plans: Vec<portcove_core::ProviderInstallPlan>,
    edits: portcove_core::ModSetupEdits,
) -> DesktopResult<portcove_core::ModSetupDraftPreview> {
    crate::blocking_service_at_generation(state.inner().clone(), generation, move |service| {
        service
            .preview_mod_setup_draft(&port_id, &profile_id, expected_revision, &plans, &edits)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_mod_setup_draft(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    expected_revision: u64,
    plans: Vec<portcove_core::ProviderInstallPlan>,
    edits: portcove_core::ModSetupEdits,
    allow_code: bool,
) -> DesktopResult<ProfileRevision> {
    crate::blocking_service_at_generation(state.inner().clone(), generation, move |service| {
        service
            .apply_mod_setup_draft(
                &port_id,
                &profile_id,
                expected_revision,
                &plans,
                &edits,
                allow_code,
            )
            .map_err(Into::into)
    })
    .await
}

/// Discards a reviewed plan's private staging when the player cancels or leaves.
#[tauri::command]
pub(crate) async fn discard_provider_install(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    plan: portcove_core::ProviderInstallPlan,
) -> DesktopResult<()> {
    if plan.port_id != port_id {
        return Err(
            portcove_core::PortcoveError::conflict("this review is for another game").into(),
        );
    }
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .discard_provider_install(&plan)
            .map_err(Into::into)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_draft_capacity_is_cores_setup_capacity() {
        // React bounds drafts with this literal; it must stay Core's number.
        let draft = include_str!("../../src/features/mod-setups/mod-draft.ts");
        let expected = format!(
            "export const MOD_SETUP_CAPACITY = {};",
            portcove_core::MAX_SETUP_PACKAGES
        );
        assert!(
            draft.contains(&expected),
            "mod-draft.ts must declare {expected}"
        );
    }

    #[test]
    fn a_plan_must_match_the_displayed_game_setup_and_digest() {
        let plan: portcove_core::ProviderInstallPlan = serde_json::from_value(serde_json::json!({
            "port_id": "shipwright", "profile_id": "a", "expected_revision": 1,
            "provider": {"provider": "gamebanana", "project": "1", "file": "2"},
            "project_name": "x",
            "file": {"file_id": "2", "file_name": "x.zip", "size": 1, "added_at": 0,
                "download_url": "", "claimed_md5": null, "archived": false, "claimed_scan": null},
            "download_sha256": "a", "download_size": 1, "members": [], "ignored_entries": 0,
            "replaces": [], "conflicts": [], "conflicts_truncated": false,
            "unverified_claims": [], "plan_sha256": "d"
        }))
        .unwrap();
        assert!(require_displayed_plan(&plan, "shipwright", "a", "d").is_ok());
        assert!(require_displayed_plan(&plan, "shipwright", "b", "d").is_err());
        assert!(require_displayed_plan(&plan, "other", "a", "d").is_err());
        assert!(require_displayed_plan(&plan, "shipwright", "a", "e").is_err());
    }
}

#[cfg(test)]
#[path = "mod_recipe_review_tests.rs"]
mod mod_recipe_review_tests;

#[tauri::command]
pub(crate) async fn get_quaddicted_catalog(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    filename_search: Option<String>,
    page: u32,
) -> DesktopResult<portcove_core::Observed<portcove_core::QuaddictedPage>> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            Ok(service
                .quaddicted_catalog(
                    &port_id,
                    portcove_core::Platform::current()?,
                    filename_search.as_deref(),
                    page,
                )
                .await?)
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_moddb_file_notices(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
) -> DesktopResult<portcove_core::Observed<portcove_core::ModDbFileNotices>> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            Ok(service
                .moddb_file_notices(&port_id, portcove_core::Platform::current()?)
                .await?)
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn open_upstream_mod_notice(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    source: String,
    page_url: String,
) -> DesktopResult<()> {
    let selection = state.inner().clone();
    crate::blocking_async_service_at_generation(
        selection.clone(),
        generation,
        move |service| async move {
            let reviewed = service
                .review_external_mod_source_page(&port_id, &source, &page_url)
                .await?;
            crate::require_library_generation(crate::state_generation(&selection), generation)?;
            crate::open_host_target(std::ffi::OsStr::new(&reviewed))
        },
    )
    .await
}
