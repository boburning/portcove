//! Explicit privacy projections for user-requested support exports.
//!
//! Keep source DTO patterns exhaustive: a new field must receive an export
//! decision here instead of inheriting permission from Serialize. Approved
//! diagnostic text is re-redacted, but is not anonymous or necessarily path-free.

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    ActivityDiagnostic, ActivityOperation, ActivityRecord, ActivityStatus, ActivityTargetKind,
    CancellationPhase, CancellationState, DiagnosticStream, DoctorReport, ErrorCode,
    FailurePresentation, FailureRecoveryTarget, FailureReport, FailureTone, HostToolSource,
    HostToolState, HostToolStatus, MutationState, Platform, RecoveryAction, RepairItem,
    RepairItemKind, RepairPlan, StorageSummary, redact_diagnostic_text,
};

/// Classified support content. Raw DTOs and arbitrary JSON cannot construct it.
///
/// Serialization is deliberately one-way; this is an export view, never domain
/// state, recovery authority, or a replacement for the original diagnostics.
#[derive(Serialize)]
#[serde(transparent)]
pub struct SupportBundleData(Value);

impl SupportBundleData {
    /// Startup can be collected without a library. Only closed facts from the
    /// failure are admitted; startup errors can contain arbitrary path/context
    /// payloads and are not required to be bounded by a database reader.
    pub(crate) fn startup(available: bool, failure: Option<&FailureReport>) -> Self {
        Self(json!({
            "schema_version": 1,
            "library_available": available,
            "failure_code": failure.map(|report| error_code(&report.code)),
            "mutation_state": failure.map(|report| mutation_state(&report.presentation.mutation_state)),
            "failure_text_omitted": failure.is_some(),
        }))
    }

    /// These existing reads do not enumerate installs, sources, repair items,
    /// or executable contents. Unknown doctor facts are deliberately null.
    pub(crate) fn doctor_snapshot(library: &crate::Library) -> crate::Result<Self> {
        let StorageSummary {
            library_root: _,
            volume_total_bytes,
            volume_available_bytes,
        } = library.storage_summary()?;
        Ok(Self(json!({
            "schema_version": 1,
            "platform": platform_value(&Platform::current()?),
            "catalog_port_count": null,
            "volume_total_bytes": volume_total_bytes,
            "volume_available_bytes": volume_available_bytes,
            "installed_port_count": null,
            "registered_source_count": null,
            "repair_items": null,
            "host_tools": null,
        })))
    }

    pub(crate) fn activities(activities: &[ActivityRecord]) -> Self {
        Self(json!({
            "schema_version": 1,
            "activities": activities.iter().map(activity).collect::<Vec<_>>(),
        }))
    }

    pub fn summary(
        doctor: &DoctorReport,
        activities: &[ActivityRecord],
        created_at_ms: u128,
    ) -> Self {
        let DoctorReport {
            platform,
            library,
            catalog_port_count,
            catalog_provenance: _,
            installed_port_count,
            registered_source_count,
            host_tools,
            repair,
        } = doctor;
        let StorageSummary {
            library_root: _,
            volume_total_bytes,
            volume_available_bytes,
        } = library;
        let RepairPlan {
            generated_at: _,
            items,
            journal_diagnostics: _, // Preserve attention items; omit untrusted row observations.
        } = repair;
        Self(json!({
            "schema_version": 2,
            "created_at_ms": created_at_ms,
            "platform": platform_value(platform),
            "catalog_port_count": catalog_port_count,
            "installed_port_count": installed_port_count,
            "registered_source_count": registered_source_count,
            "volume_total_bytes": volume_total_bytes,
            "volume_available_bytes": volume_available_bytes,
            "repair_items": items.iter().map(repair_item).collect::<Vec<_>>(),
            "host_tools": host_tools.iter().map(host_tool).collect::<Vec<_>>(),
            "activities": activities.iter().map(activity).collect::<Vec<_>>(),
        }))
    }

    pub fn activity_captures(captures: &[ActivityDiagnostic]) -> Self {
        Self(Value::Array(captures.iter().map(capture).collect()))
    }

    /// Existing JSONL envelopes have a closed field policy. Unknown/nested
    /// fields are counted and omitted, including their names. Legacy text has
    /// a separate, explicit re-redacted-text policy. Malformed JSON-shaped
    /// records cannot escape classification through the legacy-text route.
    pub fn runtime_log_line(line: &str) -> Self {
        Self(match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(record)) => runtime_record(&record),
            Ok(_) => json!({ "omitted_record": "unclassified_json" }),
            Err(_) if line.trim_start().starts_with(['{', '[']) => {
                json!({ "omitted_record": "invalid_structured_json" })
            }
            Err(_) => json!({ "legacy_text": text(line) }),
        })
    }
}

// Only closed, payload-free enum variants are public facts. Adding a variant
// or a payload also requires a classification decision at compile time.
macro_rules! public_enum {
    ($function:ident, $kind:ident, $($variant:ident),+ $(,)?) => {
        fn $function(value: &$kind) -> Value {
            match value {
                $($kind::$variant)|+ => json!(value),
            }
        }
    };
}

public_enum!(
    platform_value,
    Platform,
    WindowsX86_64,
    LinuxX86_64,
    MacosX86_64,
    MacosAarch64
);
public_enum!(
    tool_state,
    HostToolState,
    Available,
    Missing,
    Misconfigured,
    Unsupported
);
public_enum!(tool_source, HostToolSource, Environment, Saved, Discovery);
public_enum!(
    repair_kind,
    RepairItemKind,
    MalformedJournal,
    RetainedPreparation,
    PartialOperation,
    CleanupPending,
    OrphanedFinalDirectory,
    MissingRegisteredPath,
    DegradedBackup,
    BackupRecoveryRequired
);
public_enum!(
    operation,
    ActivityOperation,
    SettingsChange,
    DownloadPackage,
    Prepare,
    UpdateCatalog,
    DiscoverSources,
    ImportSource,
    ImportLibrary,
    MoveLibrary,
    RelocateOutput,
    Launch,
    CheckUpdate,
    Backup,
    Restore,
    DeleteBackup,
    Install,
    Update,
    Reconcile,
    VerifyInstall,
    Activate,
    Rollback,
    Adopt,
    Remove,
    RemoveSource,
    RegisterExternal,
    RelinkExternal,
    RemoveExternal,
    RegisterSource,
    VerifySource
);
public_enum!(target_kind, ActivityTargetKind, Port, Source, Library);
public_enum!(
    status,
    ActivityStatus,
    Running,
    Succeeded,
    Failed,
    Cancelled
);
public_enum!(
    error_code,
    ErrorCode,
    Usage,
    Unsupported,
    NotFound,
    SourceInvalid,
    Network,
    Verification,
    Install,
    State,
    Launch,
    Conflict,
    Cancelled
);
public_enum!(tone, FailureTone, Neutral, Error);
public_enum!(
    mutation_state,
    MutationState,
    NotStarted,
    NoChanges,
    Committed,
    RecoveryRequired,
    Unknown
);
public_enum!(
    recovery_action,
    RecoveryAction,
    ReviewCurrentState,
    ReviewPreparation,
    ViewTechnicalDetails
);
public_enum!(cancellation_phase, CancellationPhase, Preparing, Finishing);

fn text(value: &str) -> String {
    redact_diagnostic_text(value)
}

fn optional_text(value: &Option<String>) -> Option<String> {
    value.as_deref().map(text)
}

fn repair_item(item: &RepairItem) -> Value {
    let RepairItem {
        kind,
        operation_id,
        port_id,
        path: _,
        message,
        proposed_action,
    } = item;
    json!({
        "kind": repair_kind(kind),
        "operation_id": optional_text(operation_id),
        "port_id": optional_text(port_id),
        "message": text(message),
        "proposed_action": text(proposed_action),
    })
}

fn host_tool(tool: &HostToolStatus) -> Value {
    let HostToolStatus {
        id,
        display_name: _,
        state,
        path: _,
        source,
        configuration_variable,
        purpose,
        official_url: _,
    } = tool;
    json!({
        "id": text(id),
        "state": tool_state(state),
        "source": source.as_ref().map(tool_source),
        "configuration_variable": text(configuration_variable),
        "purpose": text(purpose),
    })
}

fn activity(record: &ActivityRecord) -> Value {
    let ActivityRecord {
        id,
        operation: activity_operation,
        target_kind: kind,
        target_id,
        status: activity_status,
        message,
        failure,
        started_at,
        finished_at,
        cancellation,
        ..
    } = record;
    // Library/source targets may identify a private filesystem location.
    let exported_target = match kind {
        ActivityTargetKind::Port => optional_text(target_id),
        ActivityTargetKind::Source | ActivityTargetKind::Library => None,
    };
    json!({
        "id": text(id),
        "operation": operation(activity_operation),
        "target_kind": target_kind(kind),
        "target_id": exported_target,
        "target_id_omitted": target_id.is_some() && *kind != ActivityTargetKind::Port,
        "status": status(activity_status),
        "message": optional_text(message),
        "failure": failure.as_ref().map(failure_report),
        "started_at": started_at,
        "finished_at": finished_at,
        "cancellation": cancellation.as_ref().map(cancellation_state),
    })
}

fn cancellation_state(state: &CancellationState) -> Value {
    let CancellationState { phase, requested } = state;
    json!({ "phase": cancellation_phase(phase), "requested": requested })
}

fn failure_report(failure: &FailureReport) -> Value {
    let FailureReport {
        code,
        message,
        details,
        presentation,
    } = failure;
    json!({
        "code": error_code(code),
        "message": text(message),
        "details_omitted": details.len(),
        "presentation": failure_presentation(presentation),
    })
}

fn failure_presentation(presentation: &FailurePresentation) -> Value {
    let FailurePresentation {
        presentation_key,
        summary,
        tone: failure_tone,
        mutation_state: mutation,
        phase,
        recovery_actions,
        recovery_target,
        technical_message,
        technical_context,
    } = presentation;
    json!({
        "presentation_key": text(presentation_key),
        "summary": text(summary),
        "tone": tone(failure_tone),
        "mutation_state": mutation_state(mutation),
        "phase": optional_text(phase),
        "recovery_actions": recovery_actions.iter().map(recovery_action).collect::<Vec<_>>(),
        "recovery_target": recovery_target.as_ref().map(recovery_target_value),
        "technical_message": text(technical_message),
        "technical_context_omitted": technical_context.len(),
    })
}

fn recovery_target_value(target: &FailureRecoveryTarget) -> Value {
    match target {
        FailureRecoveryTarget::Preparation { port_id } => {
            json!({ "kind": "preparation", "port_id": text(port_id) })
        }
    }
}

fn capture(diagnostic: &ActivityDiagnostic) -> Value {
    let ActivityDiagnostic {
        activity_id,
        phase,
        stdout,
        stderr,
        complete,
        updated_at,
        stream_limit_bytes,
    } = diagnostic;
    json!({
        "activity_id": text(activity_id),
        "phase": text(phase),
        "stdout": stream(stdout),
        "stderr": stream(stderr),
        "complete": complete,
        "updated_at": updated_at,
        "stream_limit_bytes": stream_limit_bytes,
    })
}

fn stream(stream: &DiagnosticStream) -> Value {
    let DiagnosticStream {
        text: captured_text,
        observed_bytes,
        truncated,
    } = stream;
    json!({
        "text": text(captured_text),
        "observed_bytes": observed_bytes,
        "truncated": truncated,
    })
}

#[derive(Clone, Copy)]
enum RuntimeFieldPolicy {
    RedactedText,
    Number,
    Boolean,
    AuthCommand,
    AuthPhase,
    ErrorCode,
    Omit,
}

fn runtime_field_policy(name: &str) -> RuntimeFieldPolicy {
    match name {
        "message" | "operation_id" | "activity_id" | "operation" | "port_id" => {
            RuntimeFieldPolicy::RedactedText
        }
        "request_id"
        | "sequence"
        | "install_count"
        | "port_count"
        | "sqlite_query_count"
        | "settings_row_count"
        | "install_row_count"
        | "launch_history_row_count"
        | "update_snapshot_row_count"
        | "consistency_attempt" => RuntimeFieldPolicy::Number,
        "success" | "truncated" => RuntimeFieldPolicy::Boolean,
        "command" => RuntimeFieldPolicy::AuthCommand,
        "phase" => RuntimeFieldPolicy::AuthPhase,
        "code" | "error_code" => RuntimeFieldPolicy::ErrorCode,
        // Opaque event/target/error Debug payloads, frontend stacks, spans,
        // paths, URLs, environments and all new fields need explicit policy.
        _ => RuntimeFieldPolicy::Omit,
    }
}

fn runtime_field(value: &Value, policy: RuntimeFieldPolicy) -> Option<Value> {
    match policy {
        RuntimeFieldPolicy::RedactedText => value.as_str().map(|value| json!(text(value))),
        RuntimeFieldPolicy::Number | RuntimeFieldPolicy::Boolean => {
            // The existing tracing visitor stores primitives as strings.
            let scalar = match value {
                Value::String(value) => serde_json::from_str::<Value>(value).ok()?,
                value => value.clone(),
            };
            match policy {
                RuntimeFieldPolicy::Number if scalar.is_u64() => Some(scalar),
                RuntimeFieldPolicy::Boolean if scalar.is_boolean() => Some(scalar),
                _ => None,
            }
        }
        RuntimeFieldPolicy::AuthCommand => value
            .as_str()
            .filter(|value| *value == "get_github_auth_status")
            .map(|value| json!(value)),
        RuntimeFieldPolicy::AuthPhase => value
            .as_str()
            .filter(|value| matches!(*value, "start" | "complete"))
            .map(|value| json!(value)),
        RuntimeFieldPolicy::ErrorCode => {
            let value = value.as_str()?;
            if value == "None" {
                return Some(Value::Null);
            }
            let value = value
                .strip_prefix("Some(")
                .and_then(|value| value.strip_suffix(')'))
                .unwrap_or(value);
            let canonical = match value {
                "NotFound" => "not_found".to_owned(),
                "SourceInvalid" => "source_invalid".to_owned(),
                value => value.to_ascii_lowercase(),
            };
            let code: ErrorCode = serde_json::from_value(json!(canonical)).ok()?;
            Some(error_code(&code))
        }
        RuntimeFieldPolicy::Omit => None,
    }
}

fn runtime_record(record: &Map<String, Value>) -> Value {
    if record.contains_key("schema_version") {
        return crate::runtime_diagnostics::project(record);
    }
    let mut fields = Map::new();
    let mut omitted_fields = 0;
    if let Some(Value::Object(values)) = record.get("fields") {
        for (name, value) in values {
            if let Some(value) = runtime_field(value, runtime_field_policy(name)) {
                fields.insert(name.clone(), value);
            } else {
                omitted_fields += 1;
            }
        }
    } else if record.contains_key("fields") {
        omitted_fields += 1;
    }
    let level = record
        .get("level")
        .and_then(Value::as_str)
        .and_then(|level| {
            matches!(level, "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR").then_some(level)
        });
    json!({
        "timestamp_ms": record.get("timestamp_ms").filter(|value| value.is_number()),
        "level": level,
        "target": record.get("target").and_then(Value::as_str).map(text),
        "fields": fields,
        "omitted_fields": omitted_fields,
        "omitted_envelope_fields": record.keys()
            .filter(|name| !matches!(name.as_str(), "timestamp_ms" | "level" | "target" | "fields"))
            .count(),
    })
}

#[cfg(test)]
#[path = "support_bundle_tests.rs"]
mod tests;
