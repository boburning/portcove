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
    app: tauri::AppHandle,
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
            let reviewed = service.plan_game_update(&port_id, activate).await?;
            if reviewed.plan_sha256 != expected_plan {
                return Err(portcove_core::PortcoveError::conflict(
                    "update inputs changed; review again",
                ));
            }
            let acknowledged = if let Some(scope) = &reviewed.plan.shared_preferences {
                let destination = scope.local_fallback_path.parent().ok_or_else(|| {
                    portcove_core::PortcoveError::verification(
                        "shared preferences installation location is missing",
                    )
                })?;
                if !crate::confirm_destructive(
                    &app,
                    "Allow ReGaiden's shared preferences?",
                    format!(
                        "Update {} to {}\nLocation: {}\n\n{}",
                        service.catalog().port(&port_id)?.name,
                        reviewed.plan.release.version,
                        destination.display(),
                        scope.write_scope_disclosure()
                    ),
                    "Accept scope and update",
                )
                .await
                {
                    return Err(portcove_core::PortcoveError::new(
                        portcove_core::ErrorCode::Cancelled,
                        "Shared preferences review cancelled. Nothing was changed.",
                    )
                    .with_mutation_state(portcove_core::MutationState::NotStarted));
                }
                Some(expected_plan.as_str())
            } else {
                None
            };
            let authorization = service
                .authorize_game_update_with_shared_preferences_ack(
                    &port_id,
                    activate,
                    &expected_plan,
                    acknowledged,
                )
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

/// Transfers verified archives only. A later prepare/apply always reviews again.
#[tauri::command]
pub(crate) async fn acquire_game_update(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_plan: String,
    generation: u64,
    on_event: tauri::ipc::Channel<OperationEvent>,
) -> DesktopResult<portcove_core::GameUpdateAcquisition> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        tauri::async_runtime::block_on(async {
            let authorization = service
                .authorize_game_update_acquisition(&port_id, &expected_plan)
                .await?;
            service
                .acquire_game_update(&port_id, &authorization.token, |event| {
                    let _ = on_event.send(event);
                })
                .await
        })
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn discard_game_update_acquisition(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    acquisition_id: String,
    generation: u64,
) -> DesktopResult<()> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        service
            .discard_game_update_acquisition(&port_id, &acquisition_id)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn plan_game_update_acquisition(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
) -> DesktopResult<GameUpdatePlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        tauri::async_runtime::block_on(service.plan_game_update_acquisition(&port_id))
            .map_err(Into::into)
    })
    .await
}
