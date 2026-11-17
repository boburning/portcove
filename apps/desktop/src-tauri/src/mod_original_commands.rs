use std::path::PathBuf;

use crate::{
    DesktopResult, DesktopState, blocking_worker, game_settings_commands::read_at_generation,
    service_at_generation,
};
use portcove_core::ProfileOriginalReview;

#[tauri::command]
pub(crate) async fn review_mod_setup_original(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    expected_revision: u64,
    requirement_id: String,
) -> DesktopResult<ProfileOriginalReview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            service.review_profile_original(
                &port_id,
                &profile_id,
                expected_revision,
                &requirement_id,
            )
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn select_mod_setup_original(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    expected_revision: u64,
    requirement_id: String,
    instance_id: String,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .select_profile_original(
                &port_id,
                &profile_id,
                expected_revision,
                &requirement_id,
                &instance_id,
            )
            .map(|_| ())
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn relink_mod_setup_original(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    profile_id: String,
    expected_revision: u64,
    requirement_id: String,
    path: PathBuf,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .relink_profile_original(
                &port_id,
                &profile_id,
                expected_revision,
                &requirement_id,
                &path,
            )
            .map(|_| ())
            .map_err(Into::into)
    })
    .await
}
