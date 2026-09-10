use crate::{
    DesktopResult, DesktopState, blocking_async_service, blocking_service, confirm_destructive,
};
use portcove_core::{
    CatalogStatus, CatalogTrustKey, CatalogUpdatePlan, CatalogUpdateSource, OperationEvent,
};

#[tauri::command]
pub(crate) fn get_engine_capabilities() -> portcove_core::CapabilityDocument {
    portcove_core::CapabilityDocument::current()
}

#[tauri::command]
pub(crate) fn check_definition_capabilities(
    request: portcove_core::DefinitionCapabilityRequest,
) -> DesktopResult<portcove_core::DefinitionCapabilityReport> {
    portcove_core::check_definition_capabilities(&request).map_err(Into::into)
}

#[cfg(test)]
mod capability_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn desktop_negotiation_preserves_core_results_and_errors_without_a_library() {
        for template in ["n64-recomp-portable", "future-template"] {
            let request: portcove_core::DefinitionCapabilityRequest = serde_json::from_value(json!({
                "capability_contract_schema": 1,
                "required_capabilities": [{"template":template, "minimum_version":1, "maximum_version":1}]
            })).unwrap();
            let expected = portcove_core::check_definition_capabilities(&request).unwrap();
            assert_eq!(
                serde_json::to_value(check_definition_capabilities(request).unwrap()).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
        let invalid = portcove_core::DefinitionCapabilityRequest {
            capability_contract_schema: 2,
            required_capabilities: vec![],
        };
        let error = check_definition_capabilities(invalid).unwrap_err();
        assert_eq!(serde_json::to_value(error).unwrap()["code"], "unsupported");
        assert_eq!(
            serde_json::to_value(get_engine_capabilities()).unwrap(),
            serde_json::to_value(portcove_core::CapabilityDocument::current()).unwrap()
        );
    }
}

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
