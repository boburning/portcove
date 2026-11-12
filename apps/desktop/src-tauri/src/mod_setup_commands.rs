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
) -> DesktopResult<Profile> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .copy_profile(&port_id, &profile_id, &display_name)
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
) -> DesktopResult<ProfileRevision> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .install_mod_package(&port_id, &profile_id, &path, expected_revision)
            .map_err(Into::into)
    })
    .await
}
