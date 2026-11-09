pub(crate) use crate::desktop_contract::{
    BackupReview, BatchOutcome, BootstrapStatus, CliCommandContext, DesktopLocalePreference,
    DesktopWorkspaceSnapshot, InstallInput, LaunchResult, SourceBatchOutcome,
};

use serde::Serialize;
use tauri::Emitter;

/// The only webview that may invoke Portcove commands or receive Portcove events.
/// The invoke guard and the event audience share this one label.
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

pub(crate) use crate::desktop_contract::{
    DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE, DESKTOP_EVENT_LIBRARY_CHANGED, DESKTOP_EVENT_OPERATION,
};

/// Every Portcove event has one audience: the main window. `emit` would also reach
/// listeners targeted at any other window a build creates. The event families
/// (`library-changed`, `operation`, `application-update-notice`) are listened to
/// only by the main window, so no consumer needs a wider audience. Listeners with
/// Tauri's default `Any` target, which the frontend uses, still receive them; the
/// capability test below is what keeps every other webview from registering one.
pub(crate) fn emit_desktop_event<T: Serialize + Clone>(
    app: &tauri::AppHandle<impl tauri::Runtime>,
    event: &'static str,
    payload: T,
) -> tauri::Result<()> {
    app.emit_to(MAIN_WINDOW_LABEL, event, payload)
}

impl From<portcove_core::WorkspaceSnapshot> for DesktopWorkspaceSnapshot {
    fn from(snapshot: portcove_core::WorkspaceSnapshot) -> Self {
        Self {
            catalog: Some(snapshot.catalog),
            listing_catalog: snapshot.listing_catalog,
            catalog_digest: None,
            catalog_unchanged: false,
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

    #[test]
    fn desktop_events_are_targeted_at_the_main_window_and_reach_default_listeners() {
        use std::sync::{Arc, Mutex};
        use tauri::test::{mock_builder, mock_context, noop_assets};
        use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};

        const EVENTS: [&str; 3] = [
            DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE,
            DESKTOP_EVENT_LIBRARY_CHANGED,
            DESKTOP_EVENT_OPERATION,
        ];
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let handle = app.handle();
        let listen = |label: &str| {
            let window =
                WebviewWindowBuilder::new(handle, label, WebviewUrl::App("index.html".into()))
                    .build()
                    .unwrap();
            let received = Arc::new(Mutex::new(Vec::<String>::new()));
            for event in EVENTS {
                let received = Arc::clone(&received);
                window.listen(event, move |_| {
                    received.lock().unwrap().push(event.to_owned())
                });
            }
            (window, received)
        };
        let (_main, main_received) = listen(MAIN_WINDOW_LABEL);
        let (_other, other_received) = listen("secondary");
        // The frontend's `listen` registers with Tauri's default `Any` target and must
        // keep receiving every event.
        let any_received = Arc::new(Mutex::new(Vec::<String>::new()));
        for event in EVENTS {
            let any_received = Arc::clone(&any_received);
            handle.listen_any(event, move |_| {
                any_received.lock().unwrap().push(event.to_owned());
            });
        }

        for event in EVENTS {
            emit_desktop_event(handle, event, ()).unwrap();
        }

        assert_eq!(*main_received.lock().unwrap(), EVENTS);
        assert!(other_received.lock().unwrap().is_empty());
        assert_eq!(*any_received.lock().unwrap(), EVENTS);
    }

    #[test]
    fn production_capabilities_and_window_are_selected_for_the_main_window_only() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut reviewed = 0;
        for entry in std::fs::read_dir(manifest.join("capabilities")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let capability: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let name = path.display().to_string();
            assert_eq!(capability["windows"], json!([MAIN_WINDOW_LABEL]), "{name}");
            for widening in ["webviews", "remote", "platforms"] {
                assert!(
                    capability.get(widening).is_none(),
                    "{name} declares {widening}"
                );
            }
            reviewed += 1;
        }
        assert!(reviewed > 0, "no capability file was reviewed");

        // Tauri labels an unlabeled configured window "main"; keep exactly one window.
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(
            windows[0]
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("main"),
            MAIN_WINDOW_LABEL
        );
    }
}
