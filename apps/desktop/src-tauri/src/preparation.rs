//! Generation-bound transport for core's reviewed preparation operation.
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use portcove_core::{
    InstallRecord, OperationEvent, Platform, PreparationMode, PreparationOptions, PreparationPlan,
};

fn options() -> portcove_core::Result<PreparationOptions> {
    Ok(PreparationOptions {
        target: Platform::current()?,
        mode: PreparationMode::Default,
    })
}

#[tauri::command]
pub(crate) async fn plan_preparation(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    generation: u64,
) -> DesktopResult<PreparationPlan> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .plan_preparation(&port_id, options()?)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn prepare_port(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_plan: String,
    generation: u64,
    on_event: tauri::ipc::Channel<OperationEvent>,
) -> DesktopResult<InstallRecord> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let service = service_at_generation(&state, generation)?;
        let options = options()?;
        let authorization = service.authorize_preparation(&port_id, options, &expected_plan)?;
        service
            .prepare(&port_id, options, &authorization.token, |event| {
                let _ = on_event.send(event);
            })
            .map_err(Into::into)
    })
    .await
}
