use std::path::PathBuf;

use portcove_core::{LibrarySelection, ReleaseChannel, SourceVerification};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub(crate) type DesktopError = portcove_core::FailureReport;

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct BatchOutcome<T> {
    pub(crate) port_id: String,
    pub(crate) ok: bool,
    pub(crate) result: Option<T>,
    pub(crate) error: Option<DesktopError>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct SourceBatchOutcome {
    pub(crate) profile_id: String,
    pub(crate) ok: bool,
    pub(crate) result: Option<SourceVerification>,
    pub(crate) error: Option<DesktopError>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub(crate) struct BootstrapStatus {
    pub(crate) ready: bool,
    pub(crate) library_root: Option<PathBuf>,
    pub(crate) selection: Option<LibrarySelection>,
    pub(crate) generation: u64,
    pub(crate) error: Option<DesktopError>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct BackupReview {
    pub(crate) preview: portcove_core::BackupActionPreview,
    pub(crate) persistent_data_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallInput {
    pub(crate) port_id: String,
    pub(crate) channel: Option<ReleaseChannel>,
    pub(crate) source: Option<PathBuf>,
    pub(crate) bios: Option<PathBuf>,
    pub(crate) stage: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchResult {
    pub(crate) process_id: Option<u32>,
    pub(crate) session_id: String,
}

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
        ] {
            assert!(serde_json::from_value::<InstallInput>(invalid).is_err());
        }
    }
}
