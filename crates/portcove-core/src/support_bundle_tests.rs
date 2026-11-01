use std::collections::BTreeMap;

use super::*;
use crate::{CatalogOrigin, CatalogProvenance, sensitive_diagnostic_field};

fn doctor_fixture() -> DoctorReport {
    DoctorReport {
        platform: Platform::WindowsX86_64,
        library: StorageSummary {
            library_root: "private-library-location".into(),
            volume_total_bytes: 1000,
            volume_available_bytes: 250,
        },
        catalog_port_count: 12,
        catalog_provenance: CatalogProvenance {
            origin: CatalogOrigin::Embedded,
            catalog_sha256: "private-unexported-provenance".into(),
            sequence: None,
            key_id: None,
            expires_at: None,
            fallback_reasons: vec![],
        },
        installed_port_count: 3,
        registered_source_count: 4,
        host_tools: vec![HostToolStatus {
            id: "cmake".into(),
            display_name: "private-unexported-display-name".into(),
            state: HostToolState::Available,
            path: Some("private-tool-location".into()),
            source: Some(HostToolSource::Saved),
            configuration_variable: "PORTCOVE_CMAKE".into(),
            purpose: "Build reviewed sources".into(),
            official_url: "https://private-unexported-url.example/".into(),
        }],
        repair: RepairPlan {
            journal_diagnostics: None,
            generated_at: 10,
            items: vec![RepairItem {
                kind: RepairItemKind::CleanupPending,
                operation_id: Some("repair-operation".into()),
                port_id: Some("example-port".into()),
                path: Some("private-repair-location".into()),
                message: "cleanup failed token=repair-canary".into(),
                proposed_action: "Review current state".into(),
            }],
        },
    }
}

fn activity_fixture() -> ActivityRecord {
    ActivityRecord {
        liveness: None,
        id: "activity-1".into(),
        operation: ActivityOperation::Prepare,
        target_kind: ActivityTargetKind::Source,
        target_id: Some("private-source-location".into()),
        status: ActivityStatus::Failed,
        message: Some("Authorization: Bearer activity-canary safe=visible".into()),
        failure: Some(FailureReport {
            code: ErrorCode::State,
            message: "failed password=failure-canary".into(),
            details: BTreeMap::from([("memo".into(), "unmarked-value-761".into())]),
            presentation: Box::new(FailurePresentation {
                presentation_key: "preparation_failed".into(),
                summary: "failed secret=summary-canary".into(),
                tone: FailureTone::Error,
                mutation_state: MutationState::RecoveryRequired,
                phase: Some("preparation.setup".into()),
                recovery_actions: vec![RecoveryAction::ReviewPreparation],
                recovery_target: Some(FailureRecoveryTarget::Preparation {
                    port_id: "example-port".into(),
                }),
                technical_message: "failed github_pat_technical-canary".into(),
                technical_context: BTreeMap::from([(
                    "additional".into(),
                    "unmarked-value-852".into(),
                )]),
            }),
        }),
        started_at: 11,
        finished_at: Some(12),
        cancellation: Some(CancellationState {
            phase: CancellationPhase::Finishing,
            requested: true,
        }),
    }
}

#[test]
fn summary_classifies_nested_dtos_without_exporting_paths_or_arbitrary_maps() {
    let doctor = doctor_fixture();
    let activities = vec![activity_fixture()];
    let original = serde_json::to_value((&doctor, &activities)).unwrap();
    let data = serde_json::to_value(SupportBundleData::summary(&doctor, &activities, 13)).unwrap();
    let exported = serde_json::to_string(&data).unwrap();
    for canary in [
        "private-library-location",
        "private-unexported-provenance",
        "private-unexported-display-name",
        "private-tool-location",
        "private-unexported-url",
        "private-repair-location",
        "private-source-location",
        "repair-canary",
        "activity-canary",
        "failure-canary",
        "summary-canary",
        "technical-canary",
        "unmarked-value-761",
        "unmarked-value-852",
    ] {
        assert!(!exported.contains(canary), "export leaked {canary}");
    }
    // These names/values deliberately evade the old marker-based redactor.
    assert!(!sensitive_diagnostic_field("memo"));
    assert_eq!(text("unmarked-value-761"), "unmarked-value-761");
    assert!(
        serde_json::to_string(&original)
            .unwrap()
            .contains("unmarked-value-761")
    );
    assert_eq!(data["schema_version"], 2);
    assert_eq!(data["platform"], "windows-x86-64");
    assert_eq!(data["created_at_ms"], 13);
    assert_eq!(data["volume_available_bytes"], 250);
    assert_eq!(data["host_tools"][0]["state"], "available");
    assert_eq!(data["repair_items"][0]["kind"], "cleanup_pending");
    let activity = &data["activities"][0];
    assert_eq!(activity["id"], "activity-1");
    assert_eq!(activity["target_id"], Value::Null);
    assert_eq!(activity["target_id_omitted"], true);
    assert_eq!(activity["status"], "failed");
    assert_eq!(
        activity["cancellation"],
        json!({ "phase": "finishing", "requested": true })
    );
    assert_eq!(activity["failure"]["details_omitted"], 1);
    assert_eq!(
        activity["failure"]["presentation"]["technical_context_omitted"],
        1
    );
    assert_eq!(
        activity["failure"]["presentation"]["mutation_state"],
        "recovery_required"
    );
    assert_eq!(
        activity["failure"]["presentation"]["recovery_target"],
        json!({ "kind": "preparation", "port_id": "example-port" })
    );
    assert!(exported.contains("safe=visible"));
    assert_eq!(
        serde_json::to_value((&doctor, &activities)).unwrap(),
        original
    );
}

#[test]
fn activity_target_policy_keeps_port_identity_but_excludes_source_and_library_locations() {
    let mut record = activity_fixture();
    record.target_id = Some("example-port".into());
    record.target_kind = ActivityTargetKind::Port;
    assert_eq!(activity(&record)["target_id"], "example-port");
    assert_eq!(activity(&record)["target_id_omitted"], false);
    record.target_kind = ActivityTargetKind::Library;
    assert_eq!(activity(&record)["target_id"], Value::Null);
    assert_eq!(activity(&record)["target_id_omitted"], true);
    record.target_id = None;
    assert_eq!(activity(&record)["target_id_omitted"], false);
}

#[test]
fn capture_export_re_redacts_text_and_preserves_incomplete_truncated_evidence() {
    let captures = vec![ActivityDiagnostic {
        activity_id: "activity-1".into(),
        phase: "preparation.setup".into(),
        stdout: DiagnosticStream {
            text: "compiler progress token=capture-stdout-canary".into(),
            observed_bytes: 3_000_000,
            truncated: true,
        },
        stderr: DiagnosticStream {
            text: "Authorization: Bearer capture-stderr-canary".into(),
            observed_bytes: 100,
            truncated: false,
        },
        complete: false,
        updated_at: 20,
        stream_limit_bytes: 2 * 1024 * 1024,
    }];
    let original = captures.clone();
    let data = serde_json::to_value(SupportBundleData::activity_captures(&captures)).unwrap();
    let exported = serde_json::to_string(&data).unwrap();
    assert!(!exported.contains("capture-stdout-canary"));
    assert!(!exported.contains("capture-stderr-canary"));
    assert!(exported.contains("compiler progress"));
    assert_eq!(data[0]["stdout"]["observed_bytes"], 3_000_000);
    assert_eq!(data[0]["stdout"]["truncated"], true);
    assert_eq!(data[0]["stderr"]["truncated"], false);
    assert_eq!(data[0]["complete"], false);
    assert_eq!(data[0]["updated_at"], 20);
    assert_eq!(data[0]["stream_limit_bytes"], 2 * 1024 * 1024);
    assert_eq!(captures, original);
}

#[test]
fn runtime_export_omits_marker_free_new_fields_nested_payloads_and_their_names() {
    let original = json!({
        "timestamp_ms": 42,
        "level": "ERROR",
        "target": "portcove_desktop::diagnostics",
        "memo": "unmarked-envelope-193",
        "spans": [{ "memo": "unmarked-span-294" }],
        "fields": {
            "message": "request failed token=runtime-canary safe=visible",
            "operation_id": "operation-1",
            "sequence": "7",
            "success": "false",
            "memo": "unmarked-field-395",
            "unmarked-name-496": "unmarked-value-597",
            "event": { "memo": "unmarked-event-698" },
            "error": { "additional": "unmarked-error-799" },
            "target": { "id": "unmarked-target-810" },
            "component_stack": "unmarked-frontend-921",
            "library_root": "unmarked-location-132",
            "url": "https://example.invalid/?signature=unmarked-query-243",
            "Authorization": "unmarked-header-354",
        }
    });
    let line = serde_json::to_string(&original).unwrap();
    let data = serde_json::to_value(SupportBundleData::runtime_log_line(&line)).unwrap();
    let exported = serde_json::to_string(&data).unwrap();
    assert!(!exported.contains("unmarked"));
    assert!(!exported.contains("runtime-canary"));
    assert_eq!(data["timestamp_ms"], 42);
    assert_eq!(data["level"], "ERROR");
    assert_eq!(data["fields"]["operation_id"], "operation-1");
    assert_eq!(data["fields"]["sequence"], 7);
    assert_eq!(data["fields"]["success"], false);
    assert_eq!(data["omitted_envelope_fields"], 2);
    assert_eq!(data["omitted_fields"], 9);
    assert!(exported.contains("safe=visible"));
}

#[test]
fn runtime_export_does_not_promote_nested_objects_through_approved_scalar_names() {
    let data = serde_json::to_value(SupportBundleData::runtime_log_line(
        &json!({
            "timestamp_ms": {"memo": "unmarked-time"},
            "level": "unmarked-level",
            "target": {"memo": "unmarked-target"},
            "fields": {
                "message": {"memo": "unmarked-message"},
                "request_id": "unmarked-request",
                "success": {"memo": "unmarked-success"}
            }
        })
        .to_string(),
    ))
    .unwrap();
    assert!(!data.to_string().contains("unmarked"));
    assert_eq!(data["fields"], json!({}));
    assert_eq!(data["omitted_fields"], 3);
    assert_eq!(data["timestamp_ms"], Value::Null);
    assert_eq!(data["level"], Value::Null);
    assert_eq!(data["target"], Value::Null);
}

#[test]
fn auth_observation_exports_only_its_closed_labels_and_codes() {
    let data = serde_json::to_value(SupportBundleData::runtime_log_line(
        &json!({
            "timestamp_ms": 42,
            "level": "DEBUG",
            "target": "portcove_desktop::diagnostics",
            "fields": {
                "command": "get_github_auth_status",
                "request_id": "12",
                "phase": "complete",
                "success": "false",
                "code": "Some(Network)",
                "message": "GitHub auth status observation"
            }
        })
        .to_string(),
    ))
    .unwrap();
    assert_eq!(data["fields"]["command"], "get_github_auth_status");
    assert_eq!(data["fields"]["request_id"], 12);
    assert_eq!(data["fields"]["phase"], "complete");
    assert_eq!(data["fields"]["success"], false);
    assert_eq!(data["fields"]["code"], "network");
    assert_eq!(data["omitted_fields"], 0);

    for name in ["command", "phase", "code", "error_code"] {
        assert!(runtime_field(&json!("unmarked-value"), runtime_field_policy(name)).is_none());
    }
    assert_eq!(
        runtime_field(&json!("None"), RuntimeFieldPolicy::ErrorCode),
        Some(Value::Null)
    );
    for code in [
        ErrorCode::Usage,
        ErrorCode::Unsupported,
        ErrorCode::NotFound,
        ErrorCode::SourceInvalid,
        ErrorCode::Network,
        ErrorCode::Verification,
        ErrorCode::Install,
        ErrorCode::State,
        ErrorCode::Launch,
        ErrorCode::Conflict,
        ErrorCode::Cancelled,
    ] {
        let canonical = serde_json::to_value(code).unwrap();
        for value in [
            canonical.clone(),
            json!(format!("{code:?}")),
            json!(format!("Some({code:?})")),
        ] {
            assert_eq!(
                runtime_field(&value, RuntimeFieldPolicy::ErrorCode),
                Some(canonical.clone()),
                "classified code was lost: {value}"
            );
        }
    }
}

#[test]
fn legacy_text_and_incomplete_json_have_distinct_export_policies() {
    let legacy = serde_json::to_value(SupportBundleData::runtime_log_line(
        "request Authorization: Bearer legacy-canary safe=visible",
    ))
    .unwrap();
    assert!(
        legacy["legacy_text"]
            .as_str()
            .unwrap()
            .contains("safe=visible")
    );
    assert!(!legacy.to_string().contains("legacy-canary"));
    for line in [
        r#"{"memo": "unmarked-partial-value""#,
        r#"[{"memo": "unmarked-array-value"}"#,
        r#"{"fields":{"memo":"unmarked-complete-value"}}"#,
        r#""unmarked-json-string""#,
    ] {
        let data = serde_json::to_value(SupportBundleData::runtime_log_line(line)).unwrap();
        assert!(!data.to_string().contains("unmarked"), "exported {line}");
        assert!(data.get("legacy_text").is_none());
    }
}
