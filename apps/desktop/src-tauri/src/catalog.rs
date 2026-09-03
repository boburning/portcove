use crate::{
    DesktopResult, DesktopState, blocking_async_service, blocking_service, confirm_destructive,
};
use portcove_core::{
    CatalogStatus, CatalogTrustKey, CatalogUpdatePlan, CatalogUpdateSource, OperationEvent,
};

#[tauri::command]
pub(crate) async fn get_catalog_status(
    state: tauri::State<'_, DesktopState>,
) -> DesktopResult<CatalogStatus> {
    blocking_service(state.inner().clone(), |service| {
        service.library().catalog_status().map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn trust_catalog_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    public_key: String,
) -> DesktopResult<Option<CatalogStatus>> {
    let key = CatalogTrustKey::from_public_key(&public_key)?;
    let message = format!(
        "Trust this catalog publisher?\n\nPublic key: {}\nFingerprint: {}\n\nThe publisher can change release download locations. Verify this key with the publisher first.",
        key.public_key, key.key_id
    );
    if !confirm_destructive(&app, "Trust catalog publisher", message, "Trust publisher").await {
        return Ok(None);
    }
    blocking_service(state.inner().clone(), move |service| {
        service
            .library()
            .trust_catalog_key(&key.public_key)
            .map(Some)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn revoke_catalog_key(
    state: tauri::State<'_, DesktopState>,
    key_id: String,
    expected_state: String,
) -> DesktopResult<CatalogStatus> {
    blocking_service(state.inner().clone(), move |service| {
        service
            .library()
            .revoke_catalog_key(&key_id, &expected_state)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn plan_catalog_update(
    state: tauri::State<'_, DesktopState>,
    source: CatalogUpdateSource,
) -> DesktopResult<CatalogUpdatePlan> {
    blocking_async_service(state.inner().clone(), move |service| async move {
        service
            .plan_catalog_update(&source)
            .await
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_catalog_update(
    state: tauri::State<'_, DesktopState>,
    source: CatalogUpdateSource,
    expected_plan: String,
    on_event: tauri::ipc::Channel<OperationEvent>,
) -> DesktopResult<CatalogStatus> {
    blocking_async_service(state.inner().clone(), move |service| async move {
        service
            .apply_catalog_update(&source, &expected_plan, |event| {
                let _ = on_event.send(event);
            })
            .await
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn rollback_catalog(
    state: tauri::State<'_, DesktopState>,
    expected_state: String,
) -> DesktopResult<CatalogStatus> {
    blocking_service(state.inner().clone(), move |service| {
        service
            .library()
            .rollback_catalog(&expected_state)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn use_embedded_catalog(
    state: tauri::State<'_, DesktopState>,
    expected_state: String,
) -> DesktopResult<CatalogStatus> {
    blocking_service(state.inner().clone(), move |service| {
        service
            .library()
            .use_embedded_catalog(&expected_state)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn use_cached_catalog(
    state: tauri::State<'_, DesktopState>,
    expected_state: String,
) -> DesktopResult<CatalogStatus> {
    blocking_service(state.inner().clone(), move |service| {
        service
            .library()
            .use_cached_catalog(&expected_state)
            .map_err(Into::into)
    })
    .await
}
