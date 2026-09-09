use crate::{AboutDocument, ApiResponse, PortBatchOutcome, SourceBatchOutcome};
use clap::ValueEnum;
use portcove_core::{
    ActivityRecord, AdoptionPreview, BackupActionPreview, BackupInventory, BackupRecord,
    CapabilityDocument, CatalogDocument, DoctorReport, GithubAuthStatus, GithubDeviceLogin,
    GithubDeviceLoginResult, InstallPlan, InstallRecord, LibraryMetadata, LibraryMetadataFile,
    OperationEvent, PortDefinition, PortPaths, PortRemovalPreview, PortStatus, ReconcileResult,
    RestoreResult, SourceInspectionReport, SourceRecord, SourceRelinkPlan, SourceRemovalPreview,
    SourceVerification, StorageSummary, UpdateCheck, UpdateSnapshot,
};
use schemars::{JsonSchema, Schema, generate::SchemaSettings};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum SchemaContract {
    /// Values accepted when deserializing a request or stored document.
    Input,
    /// Values emitted when serializing a response or stored document.
    Output,
}

fn schema_for_contract<T: JsonSchema>(contract: SchemaContract) -> Schema {
    let settings = match contract {
        SchemaContract::Input => SchemaSettings::default(),
        SchemaContract::Output => SchemaSettings::default().for_serialize(),
    };
    settings.into_generator().into_root_schema_for::<T>()
}

pub(crate) fn document(contract: SchemaContract) -> serde_json::Value {
    serde_json::Value::Object(
        [
            (
                "api_response_port_status",
                serde_json::json!(schema_for_contract::<ApiResponse<PortStatus>>(contract)),
            ),
            (
                "about",
                serde_json::json!(schema_for_contract::<AboutDocument>(contract)),
            ),
            (
                "catalog",
                serde_json::json!(schema_for_contract::<CatalogDocument>(contract)),
            ),
            (
                "source_intake_inspection",
                serde_json::json!(
                    schema_for_contract::<portcove_core::SourceIntakeInspection>(contract)
                ),
            ),
            (
                "upstream_observation_report",
                serde_json::json!(schema_for_contract::<
                    portcove_core::UpstreamObservationReport,
                >(contract)),
            ),
            (
                "catalog_status",
                serde_json::json!(schema_for_contract::<portcove_core::CatalogStatus>(
                    contract
                )),
            ),
            (
                "catalog_provenance",
                serde_json::json!(schema_for_contract::<portcove_core::CatalogProvenance>(
                    contract
                )),
            ),
            (
                "catalog_trust_key",
                serde_json::json!(schema_for_contract::<portcove_core::CatalogTrustKey>(
                    contract
                )),
            ),
            (
                "catalog_update_plan",
                serde_json::json!(schema_for_contract::<portcove_core::CatalogUpdatePlan>(
                    contract
                )),
            ),
            (
                "catalog_update_source",
                serde_json::json!(schema_for_contract::<portcove_core::CatalogUpdateSource>(
                    contract
                )),
            ),
            (
                "signed_catalog_envelope",
                serde_json::json!(schema_for_contract::<portcove_core::SignedCatalogEnvelope>(
                    contract
                )),
            ),
            (
                "signed_catalog_payload",
                serde_json::json!(schema_for_contract::<portcove_core::SignedCatalogPayload>(
                    contract
                )),
            ),
            (
                "port",
                serde_json::json!(schema_for_contract::<PortDefinition>(contract)),
            ),
            (
                "status",
                serde_json::json!(schema_for_contract::<PortStatus>(contract)),
            ),
            (
                "port_output_location",
                serde_json::json!(schema_for_contract::<portcove_core::PortOutputLocation>(
                    contract
                )),
            ),
            (
                "output_destination_preview",
                serde_json::json!(
                    schema_for_contract::<portcove_core::OutputDestinationPreview>(contract)
                ),
            ),
            (
                "update_check",
                serde_json::json!(schema_for_contract::<UpdateCheck>(contract)),
            ),
            (
                "update_snapshot",
                serde_json::json!(schema_for_contract::<UpdateSnapshot>(contract)),
            ),
            (
                "check_batch_outcome",
                serde_json::json!(schema_for_contract::<PortBatchOutcome<UpdateCheck>>(
                    contract
                )),
            ),
            (
                "reconcile_result",
                serde_json::json!(schema_for_contract::<ReconcileResult>(contract)),
            ),
            (
                "reconcile_batch_outcome",
                serde_json::json!(schema_for_contract::<PortBatchOutcome<ReconcileResult>>(
                    contract
                )),
            ),
            (
                "update_batch_outcome",
                serde_json::json!(schema_for_contract::<PortBatchOutcome<InstallRecord>>(
                    contract
                )),
            ),
            (
                "source",
                serde_json::json!(schema_for_contract::<SourceRecord>(contract)),
            ),
            (
                "source_relink_plan",
                serde_json::json!(schema_for_contract::<SourceRelinkPlan>(contract)),
            ),
            (
                "library_metadata",
                serde_json::json!(schema_for_contract::<LibraryMetadata>(contract)),
            ),
            (
                "library_metadata_file",
                serde_json::json!(schema_for_contract::<LibraryMetadataFile>(contract)),
            ),
            (
                "library_move_plan",
                serde_json::json!(schema_for_contract::<portcove_core::LibraryMovePlan>(
                    contract
                )),
            ),
            (
                "library_move_result",
                serde_json::json!(schema_for_contract::<portcove_core::LibraryMoveResult>(
                    contract
                )),
            ),
            (
                "library_import_plan",
                serde_json::json!(schema_for_contract::<portcove_core::LibraryImportPlan>(
                    contract
                )),
            ),
            (
                "library_import_result",
                serde_json::json!(schema_for_contract::<portcove_core::LibraryImportResult>(
                    contract
                )),
            ),
            (
                "library_selection",
                serde_json::json!(schema_for_contract::<portcove_core::LibrarySelection>(
                    contract
                )),
            ),
            (
                "source_discovery_request",
                serde_json::json!(
                    schema_for_contract::<portcove_core::SourceDiscoveryRequest>(contract)
                ),
            ),
            (
                "source_discovery_limits",
                serde_json::json!(schema_for_contract::<portcove_core::SourceDiscoveryLimits>(
                    contract
                )),
            ),
            (
                "source_discovery_report",
                serde_json::json!(schema_for_contract::<portcove_core::SourceDiscoveryReport>(
                    contract
                )),
            ),
            (
                "source_discovery_issue",
                serde_json::json!(schema_for_contract::<portcove_core::SourceDiscoveryIssue>(
                    contract
                )),
            ),
            (
                "source_discovery_limit",
                serde_json::json!(schema_for_contract::<portcove_core::SourceDiscoveryLimit>(
                    contract
                )),
            ),
            (
                "source_inbox_paths",
                serde_json::json!(schema_for_contract::<portcove_core::SourceInboxPaths>(
                    contract
                )),
            ),
            (
                "source_inbox_resolution",
                serde_json::json!(schema_for_contract::<portcove_core::SourceInboxResolution>(
                    contract
                )),
            ),
            (
                "source_import_plan",
                serde_json::json!(schema_for_contract::<portcove_core::SourceImportPlan>(
                    contract
                )),
            ),
            (
                "source_import_result",
                serde_json::json!(schema_for_contract::<portcove_core::SourceImportResult>(
                    contract
                )),
            ),
            (
                "source_removal_preview",
                serde_json::json!(schema_for_contract::<SourceRemovalPreview>(contract)),
            ),
            (
                "source_verification",
                serde_json::json!(schema_for_contract::<SourceVerification>(contract)),
            ),
            (
                "source_assessment",
                serde_json::json!(schema_for_contract::<portcove_core::SourceAssessment>(
                    contract
                )),
            ),
            (
                "source_inspection",
                serde_json::json!(schema_for_contract::<SourceInspectionReport>(contract)),
            ),
            (
                "source_catalog",
                serde_json::json!(schema_for_contract::<portcove_core::SourceCatalog>(
                    contract
                )),
            ),
            (
                "source_batch_outcome",
                serde_json::json!(schema_for_contract::<SourceBatchOutcome>(contract)),
            ),
            (
                "host_tool_status",
                serde_json::json!(schema_for_contract::<portcove_core::HostToolStatus>(
                    contract
                )),
            ),
            (
                "host_tool_probe_result",
                serde_json::json!(schema_for_contract::<portcove_core::HostToolProbeResult>(
                    contract
                )),
            ),
            (
                "activity",
                serde_json::json!(schema_for_contract::<ActivityRecord>(contract)),
            ),
            (
                "cancellation_state",
                serde_json::json!(schema_for_contract::<portcove_core::CancellationState>(
                    contract
                )),
            ),
            (
                "cancellation_phase",
                serde_json::json!(schema_for_contract::<portcove_core::CancellationPhase>(
                    contract
                )),
            ),
            (
                "backup",
                serde_json::json!(schema_for_contract::<BackupRecord>(contract)),
            ),
            (
                "backup_inventory",
                serde_json::json!(schema_for_contract::<BackupInventory>(contract)),
            ),
            (
                "backup_action_preview",
                serde_json::json!(schema_for_contract::<BackupActionPreview>(contract)),
            ),
            (
                "restore_result",
                serde_json::json!(schema_for_contract::<RestoreResult>(contract)),
            ),
            (
                "adoption_preview",
                serde_json::json!(schema_for_contract::<AdoptionPreview>(contract)),
            ),
            (
                "port_removal_preview",
                serde_json::json!(schema_for_contract::<PortRemovalPreview>(contract)),
            ),
            (
                "storage",
                serde_json::json!(schema_for_contract::<StorageSummary>(contract)),
            ),
            (
                "output_relocation_plan",
                serde_json::json!(schema_for_contract::<portcove_core::OutputRelocationPlan>(
                    contract
                )),
            ),
            (
                "output_relocation_result",
                serde_json::json!(
                    schema_for_contract::<portcove_core::OutputRelocationResult>(contract)
                ),
            ),
            (
                "output_relocation_status",
                serde_json::json!(
                    schema_for_contract::<portcove_core::OutputRelocationStatus>(contract)
                ),
            ),
            (
                "doctor",
                serde_json::json!(schema_for_contract::<DoctorReport>(contract)),
            ),
            (
                "install_plan",
                serde_json::json!(schema_for_contract::<InstallPlan>(contract)),
            ),
            (
                "preparation_plan",
                serde_json::json!(schema_for_contract::<portcove_core::PreparationPlan>(
                    contract
                )),
            ),
            (
                "preparation_options",
                serde_json::json!(schema_for_contract::<portcove_core::PreparationOptions>(
                    contract
                )),
            ),
            (
                "port_paths",
                serde_json::json!(schema_for_contract::<PortPaths>(contract)),
            ),
            (
                "operation_event",
                serde_json::json!(schema_for_contract::<OperationEvent>(contract)),
            ),
            (
                "github_auth_status",
                serde_json::json!(schema_for_contract::<GithubAuthStatus>(contract)),
            ),
            (
                "github_device_login",
                serde_json::json!(schema_for_contract::<GithubDeviceLogin>(contract)),
            ),
            (
                "github_device_login_result",
                serde_json::json!(schema_for_contract::<GithubDeviceLoginResult>(contract)),
            ),
            (
                "capabilities",
                serde_json::json!(schema_for_contract::<CapabilityDocument>(contract)),
            ),
        ]
        .into_iter()
        .map(|(name, schema)| (name.to_owned(), schema))
        .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use serde_json::{Value, json};

    #[derive(Serialize, Deserialize, JsonSchema)]
    struct DirectionFixture {
        #[serde(default)]
        count: u32,
        nullable: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        omitted: Option<String>,
        #[serde(skip_deserializing)]
        output_only: bool,
        #[serde(skip_serializing)]
        input_only: bool,
    }

    #[test]
    fn input_defaults_and_output_presence_follow_serde_in_each_direction() {
        let input = serde_json::to_value(schema_for_contract::<DirectionFixture>(
            SchemaContract::Input,
        ))
        .unwrap();
        let output = serde_json::to_value(schema_for_contract::<DirectionFixture>(
            SchemaContract::Output,
        ))
        .unwrap();
        assert!(
            !input["required"]
                .as_array()
                .unwrap()
                .contains(&json!("count"))
        );
        assert!(
            output["required"]
                .as_array()
                .unwrap()
                .contains(&json!("count"))
        );
        assert!(
            output["required"]
                .as_array()
                .unwrap()
                .contains(&json!("nullable"))
        );
        assert!(
            !output["required"]
                .as_array()
                .unwrap()
                .contains(&json!("omitted"))
        );
        assert!(input["properties"]["output_only"].is_null());
        assert!(output["properties"]["input_only"].is_null());
        let accepted: DirectionFixture =
            serde_json::from_value(json!({"input_only": true})).unwrap();
        assert!(accepted.input_only);
        let emitted = serde_json::to_value(accepted).unwrap();
        assert_eq!(
            emitted,
            json!({"count": 0, "nullable": null, "output_only": false})
        );
        for field in output["required"].as_array().unwrap() {
            assert!(emitted.get(field.as_str().unwrap()).is_some());
        }
        assert_eq!(
            output["properties"]["nullable"]["type"],
            json!(["string", "null"])
        );
        assert_eq!(
            output["properties"]["count"]["type"],
            Value::String("integer".into())
        );
    }
}
