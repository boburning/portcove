//! Host transport for reviewed game updates, separate from saved policy.
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use portcove_core::{GameUpdatePlan, InstallRecord, OperationEvent};

#[tauri::command]
pub(crate) async fn plan_game_update(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    activate: bool,
    generation: u64,
) -> DesktopResult<GameUpdatePlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        tauri::async_runtime::block_on(service.plan_game_update(&port_id, activate))
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_game_update(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    activate: bool,
    expected_plan: String,
    generation: u64,
    on_event: tauri::ipc::Channel<OperationEvent>,
) -> DesktopResult<InstallRecord> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        tauri::async_runtime::block_on(async {
            let authorization = service
                .authorize_game_update(&port_id, activate, &expected_plan)
                .await?;
            service
                .apply_game_update(&port_id, activate, &authorization.token, |event| {
                    let _ = on_event.send(event);
                })
                .await
        })
        .map_err(Into::into)
    })
    .await
}
