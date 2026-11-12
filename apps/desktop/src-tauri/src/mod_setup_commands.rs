//! Library-bound adapter for game mod setups. Core owns support, identity,
//! revisions, deployment, locking and recovery; these commands only forward.
//! Changes, which can copy archives or move saves, check the library generation
//! before and after opening the service instead of holding the desktop state
//! lock for the whole operation, like other file-moving commands.
use std::path::PathBuf;

use crate::{
    DesktopResult, DesktopState, blocking_worker, game_settings_commands::at_generation,
    service_at_generation,
};
use portcove_core::{ModSetupsView, Profile, ProfileRevision};

#[tauri::command]
pub(crate) async fn get_mod_setups(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
) -> DesktopResult<ModSetupsView> {
    let state = state.inner().clone();
    blocking_worker(move || {
        at_generation(&state, generation, |service| service.mod_setups(&port_id))
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
) -> DesktopResult<Profile> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        if current_build {
            service.copy_profile_onto_current_build(&port_id, &profile_id, &display_name)
        } else {
            service.copy_profile(&port_id, &profile_id, &display_name)
        }
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

/// One page of a bound game's GameBanana mods. Reads only.
#[tauri::command]
pub(crate) async fn browse_provider_mods(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    page: u32,
) -> DesktopResult<portcove_core::ProviderBrowsePage> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            service
                .browse_provider_mods(&port_id, page)
                .await
                .map_err(Into::into)
        },
    )
    .await
}

/// One GameBanana mod's files. Reads only.
#[tauri::command]
pub(crate) async fn get_provider_project(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    project_id: u64,
) -> DesktopResult<portcove_core::ProviderProjectView> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            service
                .provider_project(&port_id, &project_id.to_string())
                .await
                .map_err(Into::into)
        },
    )
    .await
}

/// Reviews one GameBanana file for a setup: downloads it privately and inspects
/// it, changing nothing but private staging.
#[tauri::command]
pub(crate) async fn plan_provider_install(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    project_id: u64,
    file_id: u64,
) -> DesktopResult<portcove_core::ProviderInstallPlan> {
    crate::blocking_async_service_at_generation(
        state.inner().clone(),
        generation,
        move |service| async move {
            service
                .plan_provider_install(
                    &port_id,
                    &profile_id,
                    &project_id.to_string(),
                    &file_id.to_string(),
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
) -> DesktopResult<ProfileRevision> {
    require_displayed_plan(&plan, &port_id, &profile_id, &expected_plan_sha256)?;
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let authorization = service.authorize_provider_install(&plan)?;
        service
            .apply_provider_install(&plan, &authorization.token)
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
