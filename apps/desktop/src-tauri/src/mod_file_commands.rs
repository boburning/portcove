use crate::{
    DesktopResult, DesktopState, blocking_worker, game_settings_commands::read_at_generation,
    service_at_generation,
};
use portcove_core::{ModFilePreservationPlan, ModFilePreservationResult};

#[tauri::command]
pub(crate) async fn inspect_mod_file(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    file_name: String,
) -> DesktopResult<ModFilePreservationPlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        read_at_generation(&state, generation, |service| {
            service.inspect_mod_file(&port_id, &file_name)
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn preserve_mod_file(
    state: tauri::State<'_, DesktopState>,
    generation: u64,
    port_id: String,
    file_name: String,
    expected_plan: String,
) -> DesktopResult<ModFilePreservationResult> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .preserve_mod_file(&port_id, &file_name, &expected_plan)
            .map_err(Into::into)
    })
    .await
}
