pub(crate) use crate::desktop_contract::{
    BackupReview, BatchOutcome, BootstrapStatus, CliCommandContext, DesktopLocalePreference,
    DesktopWorkspaceSnapshot, InstallInput, LaunchResult, SourceBatchOutcome,
};

use serde::Serialize;
use tauri::Emitter;

pub(crate) use crate::desktop_contract::{
    DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE, DESKTOP_EVENT_LIBRARY_CHANGED, DESKTOP_EVENT_OPERATION,
};

pub(crate) fn emit_desktop_event<T: Serialize + Clone>(
    app: &tauri::AppHandle,
    event: &'static str,
    payload: T,
) -> tauri::Result<()> {
    app.emit(event, payload)
}

impl From<portcove_core::WorkspaceSnapshot> for DesktopWorkspaceSnapshot {
    fn from(snapshot: portcove_core::WorkspaceSnapshot) -> Self {
        Self {
            catalog: snapshot.catalog,
            listing_catalog: snapshot.listing_catalog,
            listing_statuses: snapshot.listing_statuses,
            pending_setups: snapshot.pending_setups,
            statuses: snapshot.statuses,
            sources: snapshot.sources,
            activities: snapshot.activities,
            browsing: snapshot.browsing,
        }
    }
}

pub(crate) use crate::desktop_contract::DesktopError;

#[cfg(test)]
mod tests {
    use super::*;
    use portcove_core::PortcoveError;
    use serde_json::{Value, json};

    #[test]
    fn desktop_responses_emit_explicit_nulls_and_camel_case_launch_identity() {
        let bootstrap = BootstrapStatus {
            ready: false,
            library_root: None,
            selection: None,
            generation: 7,
            error: Some(DesktopError::from(PortcoveError::state("unavailable"))),
        };
        let value = serde_json::to_value(bootstrap).unwrap();
        assert_eq!(value["generation"], 7);
        for name in ["library_root", "selection"] {
            assert_eq!(value.get(name), Some(&Value::Null));
        }
        assert_eq!(value["error"]["code"], "state");
        assert_eq!(value["error"]["details"], json!({}));
        assert_eq!(
            serde_json::to_value(LaunchResult {
                process_id: None,
                session_id: "session".into()
            })
            .unwrap(),
            json!({"processId": null, "sessionId": "session"}),
        );
        let outcome = BatchOutcome::<portcove_core::UpdateCheck> {
            port_id: "port".into(),
            ok: false,
            result: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            json!({"port_id": "port", "ok": false, "result": null, "error": null})
        );
    }

    #[test]
    fn desktop_install_request_keeps_camel_case_and_optional_source_defaults() {
        let input: InstallInput =
            serde_json::from_value(json!({"portId": "port", "stage": false})).unwrap();
        assert_eq!(input.port_id, "port");
        assert!(!input.stage);
        assert!(input.channel.is_none() && input.source.is_none() && input.bios.is_none());
        assert_eq!(
            serde_json::to_value(&input).unwrap(),
            json!({"portId": "port", "stage": false, "channel": null, "source": null, "bios": null}),
        );
        for invalid in [
            json!({"port_id": "port", "stage": false}),
            json!({"portId": "port"}),
            json!({"portId": "port", "stage": "false"}),
            json!({"portId": "port", "stage": false, "source_reference": {"profile_id": "game", "reference_sha256": "hash"}}),
            json!({"portId": "port", "stage": false, "sourceReference": {"profile_id": "game", "reference_sha256": "hash", "allow_changed_bytes": true}}),
        ] {
            assert!(serde_json::from_value::<InstallInput>(invalid).is_err());
        }
        let reviewed: InstallInput = serde_json::from_value(json!({
            "portId": "port", "stage": false,
            "sourceReference": { "profile_id": "game", "reference_sha256": "a".repeat(64) }
        }))
        .unwrap();
        assert_eq!(reviewed.source_reference.unwrap().profile_id, "game");
    }
}
