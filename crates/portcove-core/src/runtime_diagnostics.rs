//! Privacy projection for versioned, best-effort runtime observations.
//!
//! This is a log format, not operation, recovery, or capture authority. The
//! emitting host and support export use the same closed field policy.

use serde_json::{Map, Value, json};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_FIELDS: usize = 16;
pub const MAX_FIELD_BYTES: usize = 1_024;
pub const MAX_VALUE_BYTES: usize = 4_096;
pub const MAX_SPANS: usize = 4;
pub const MAX_SPAN_FIELDS: usize = 8;
pub const MAX_SPAN_BYTES: usize = 512;
pub const MAX_TARGET_BYTES: usize = 256;

pub fn target(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TARGET_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':'))
        && crate::redact_diagnostic_text(value) == value
}

pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+'))
        && crate::redact_diagnostic_text(value) == value
}

fn label(value: &Value, labels: &[&str]) -> Option<Value> {
    value
        .as_str()
        .filter(|value| labels.contains(value))
        .map(|value| json!(value))
}

/// Project one approved scalar. Unknown fields and all nested caller objects
/// are omitted, including their names. Numeric strings are a legacy export
/// concern and are deliberately not accepted by this version.
pub fn field(name: &str, value: &Value) -> Option<Value> {
    match name {
        "operation_id"
        | "parent_operation_id"
        | "activity_id"
        | "port_id"
        | "release"
        | "install_id" => value
            .as_str()
            .filter(|value| identifier(value))
            .map(|value| json!(value)),
        "message" => value
            .as_str()
            .filter(|value| value.len() <= MAX_FIELD_BYTES)
            .map(|value| {
                // Runtime messages remain redacted human diagnostics, not anonymous
                // text. New span/frontend context never admits arbitrary messages.
                let value = crate::redact_diagnostic_text(value);
                if value.len() <= MAX_FIELD_BYTES {
                    json!(value)
                } else {
                    json!("[OMITTED]")
                }
            }),
        "request_id"
        | "sequence"
        | "event_schema_version"
        | "elapsed_ms"
        | "completed"
        | "total"
        | "install_count"
        | "port_count"
        | "sqlite_query_count"
        | "settings_row_count"
        | "install_row_count"
        | "launch_history_row_count"
        | "update_snapshot_row_count"
        | "consistency_attempt"
        | "report_id"
        | "message_bytes"
        | "stack_bytes" => value.as_u64().map(|value| json!(value)),
        "stdout_bytes" | "stderr_bytes" => value.as_u64().map(|value| json!(value)),
        "exit_code" => value.as_i64().map(|value| json!(value)),
        "success" | "truncated" | "activity_recorded" | "capture_recorded" | "stream_complete"
        | "context_complete" => value.as_bool().map(|value| json!(value)),
        "operation" => label(
            value,
            &[
                "install",
                "update",
                "prepare",
                "launch",
                "adopt",
                "activate",
                "remove",
                "restore",
                "backup",
                "delete_backup",
                "relocate",
                "import_source",
            ],
        ),
        "component" => label(
            value,
            &[
                "operation",
                "activity",
                "capture",
                "launch",
                "frontend",
                "startup",
                "github_auth",
            ],
        ),
        "command" => label(value, &["get_github_auth_status", "report_frontend_error"]),
        "phase" => label(
            value,
            &[
                "start",
                "complete",
                "started",
                "finished",
                "download",
                "extract",
                "validate",
                "prepare",
                "preparing",
                "setup",
                "preparation.setup",
                "preparation.extract",
                "source_conversion",
                "source.conversion",
                "activate",
                "activation",
                "accepted",
                "spawning",
                "running",
                "collecting",
                "returned",
                "render",
                "activity_record",
                "resolved",
            ],
        ),
        "observed_result" => label(value, &["succeeded", "failed", "cancelled", "unknown"]),
        "mutation_state" => label(
            value,
            &[
                "not_started",
                "no_changes",
                "committed",
                "recovery_required",
                "unknown",
            ],
        ),
        "observation" => label(
            value,
            &["event", "activity", "capture", "launch_session", "renderer"],
        ),
        "code" | "error_code" if value.is_null() => Some(Value::Null),
        "code" | "error_code" => value.as_str().and_then(|value| {
            // Closed enum only. Never serialize a PortcoveError/FailureReport.
            let canonical = value
                .strip_prefix("Some(")
                .and_then(|value| value.strip_suffix(')'))
                .unwrap_or(value);
            if canonical == "None" {
                return Some(Value::Null);
            }
            let canonical = match canonical {
                "NotFound" => "not_found".to_owned(),
                "SourceInvalid" => "source_invalid".to_owned(),
                value => value.to_ascii_lowercase(),
            };
            serde_json::from_value::<crate::ErrorCode>(json!(canonical))
                .ok()
                .and_then(|code| serde_json::to_value(code).ok())
        }),
        "error_kind" => label(
            value,
            &[
                "error",
                "type_error",
                "range_error",
                "reference_error",
                "syntax_error",
                "unknown",
            ],
        ),
        _ => None,
    }
}

pub(crate) fn code_label(code: crate::ErrorCode) -> &'static str {
    match code {
        crate::ErrorCode::Usage => "usage",
        crate::ErrorCode::Unsupported => "unsupported",
        crate::ErrorCode::NotFound => "not_found",
        crate::ErrorCode::SourceInvalid => "source_invalid",
        crate::ErrorCode::Network => "network",
        crate::ErrorCode::Verification => "verification",
        crate::ErrorCode::Install => "install",
        crate::ErrorCode::State => "state",
        crate::ErrorCode::Launch => "launch",
        crate::ErrorCode::Conflict => "conflict",
        crate::ErrorCode::Cancelled => "cancelled",
    }
}

pub(crate) fn mutation_label(state: crate::MutationState) -> &'static str {
    match state {
        crate::MutationState::NotStarted => "not_started",
        crate::MutationState::NoChanges => "no_changes",
        crate::MutationState::Committed => "committed",
        crate::MutationState::RecoveryRequired => "recovery_required",
        crate::MutationState::Unknown => "unknown",
    }
}

pub(crate) fn observe_activity(
    activity: &crate::ActivityRecord,
    status: crate::ActivityStatus,
    failure: Option<&crate::FailureReport>,
    recorded: bool,
) {
    let observed = match status {
        crate::ActivityStatus::Succeeded => "succeeded",
        crate::ActivityStatus::Failed => "failed",
        crate::ActivityStatus::Cancelled => "cancelled",
        crate::ActivityStatus::Running => "unknown",
    };
    // ActivityOperation is a closed enum. No error message, arguments, state,
    // or arbitrary nested context is formatted here.
    let operation = activity.operation.to_string();
    tracing::debug!(
        component = "activity",
        observation = "activity",
        phase = "finished",
        activity_id = activity.id.as_str(),
        operation_id = activity.id.as_str(),
        operation = operation.as_str(),
        observed_result = observed,
        activity_recorded = recorded,
        port_id = (activity.target_kind == crate::ActivityTargetKind::Port)
            .then_some(activity.target_id.as_deref())
            .flatten(),
        error_code = failure.map(|failure| code_label(failure.code)),
        mutation_state = failure.map(|failure| mutation_label(failure.presentation.mutation_state)),
    );
}

pub(crate) fn observe_capture(capture: &crate::ActivityDiagnostic, recorded: bool) {
    tracing::debug!(
        component = "capture",
        observation = "capture",
        activity_id = capture.activity_id.as_str(),
        phase = capture.phase.as_str(),
        capture_recorded = recorded,
        stream_complete = capture.complete,
        truncated = capture.stdout.truncated || capture.stderr.truncated,
        stdout_bytes = capture.stdout.observed_bytes,
        stderr_bytes = capture.stderr.observed_bytes,
    );
}

pub fn span_field(name: &str, value: &Value) -> Option<Value> {
    match name {
        "operation_id"
        | "parent_operation_id"
        | "activity_id"
        | "port_id"
        | "release"
        | "operation"
        | "component"
        | "phase"
        | "request_id"
        | "error_code"
        | "observed_result"
        | "mutation_state" => field(name, value),
        _ => None,
    }
}

/// Shared producer/export accounting; scalar overhead is conservatively fixed.
/// Final JSON escaping has the independent encoded-record limit.
pub fn value_bytes(value: &Value) -> usize {
    match value {
        Value::String(text) => text.len(),
        _ => 32,
    }
}

fn project_fields(values: &Map<String, Value>, span: bool) -> (Map<String, Value>, usize) {
    let mut projected = Map::new();
    let mut bytes = 0;
    let mut omitted = 0;
    let count_limit = if span { MAX_SPAN_FIELDS } else { MAX_FIELDS };
    let byte_limit = if span {
        MAX_SPAN_BYTES
    } else {
        MAX_VALUE_BYTES
    };
    for (name, value) in values {
        if projected.len() >= count_limit {
            omitted += 1;
            continue;
        }
        let projected_value = if span {
            span_field(name, value)
        } else {
            field(name, value)
        };
        if let Some(value) = projected_value {
            let size = value_bytes(&value);
            if bytes + size <= byte_limit {
                bytes += size;
                projected.insert(name.clone(), value);
                continue;
            }
        }
        omitted += 1;
    }
    (projected, omitted)
}

/// Export only a recognized envelope. Unknown versions stay uninterpreted;
/// absence of a version is handled by the separate legacy export projection.
pub(crate) fn project(record: &Map<String, Value>) -> Value {
    if record.get("schema_version").and_then(Value::as_u64) != Some(u64::from(SCHEMA_VERSION)) {
        return json!({"unrecognized_runtime_schema": true});
    }
    let (fields, mut omitted) = record
        .get("fields")
        .and_then(Value::as_object)
        .map(|values| project_fields(values, false))
        .unwrap_or_else(|| (Map::new(), 1));
    let mut spans = Vec::new();
    if let Some(values) = record.get("spans").and_then(Value::as_array) {
        omitted += values.len().saturating_sub(MAX_SPANS);
        for value in values.iter().take(MAX_SPANS) {
            if let Some(values) = value.as_object() {
                let (fields, dropped) = project_fields(values, true);
                omitted += dropped;
                if !fields.is_empty() {
                    spans.push(fields);
                }
            } else {
                omitted += 1;
            }
        }
    } else {
        omitted += 1;
    }
    let mut error = Map::new();
    if let Some(values) = record.get("error").and_then(Value::as_object) {
        for (name, value) in values {
            let projected = match name.as_str() {
                "code" => field("error_code", value),
                "mutation_state" => field("mutation_state", value),
                _ => None,
            };
            if let Some(value) = projected {
                error.insert(name.clone(), value);
            } else {
                omitted += 1;
            }
        }
    } else if record.get("error").is_some_and(|value| !value.is_null()) {
        omitted += 1;
    }
    let session = record
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| uuid::Uuid::parse_str(value).is_ok());
    let build = record
        .get("build")
        .and_then(Value::as_str)
        .filter(|value| identifier(value));
    let level = record
        .get("level")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR"));
    let target = record
        .get("target")
        .and_then(Value::as_str)
        .filter(|value| target(value));
    let timestamp = record.get("timestamp_ms").and_then(Value::as_u64);
    let elapsed = record.get("elapsed_ms").and_then(Value::as_u64);
    let process = record
        .get("process_id")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= u64::from(u32::MAX));
    let surface = record
        .get("surface")
        .and_then(Value::as_str)
        .filter(|value| *value == "desktop");
    let complete = record.get("context_complete").and_then(Value::as_bool);
    let prior_omissions = record.get("omitted_fields").and_then(Value::as_u64);
    let invalid_metadata = [
        timestamp.is_none(),
        elapsed.is_none(),
        session.is_none(),
        process.is_none(),
        surface.is_none(),
        build.is_none(),
        level.is_none(),
        target.is_none(),
        complete.is_none(),
        prior_omissions.is_none(),
        !record.contains_key("error"),
    ]
    .into_iter()
    .filter(|invalid| *invalid)
    .count();
    let unknown_metadata = record
        .keys()
        .filter(|name| {
            !matches!(
                name.as_str(),
                "schema_version"
                    | "timestamp_ms"
                    | "elapsed_ms"
                    | "session_id"
                    | "process_id"
                    | "surface"
                    | "build"
                    | "level"
                    | "target"
                    | "fields"
                    | "spans"
                    | "error"
                    | "context_complete"
                    | "omitted_fields"
            )
        })
        .count();
    let omitted_metadata = invalid_metadata + unknown_metadata;
    let prior_omissions = prior_omissions.unwrap_or(0);
    json!({
        "schema_version": SCHEMA_VERSION,
        "timestamp_ms": timestamp,
        "elapsed_ms": elapsed,
        "session_id": session,
        "process_id": process,
        "surface": surface,
        "build": build,
        "level": level,
        "target": target,
        "fields": fields,
        "spans": spans,
        "error": if error.is_empty() { Value::Null } else { Value::Object(error) },
        "context_complete": complete.unwrap_or(false) && omitted == 0 && omitted_metadata == 0 && prior_omissions == 0,
        "omitted_fields": (omitted as u64).saturating_add(prior_omissions),
        "omitted_envelope_fields": omitted_metadata,
    })
}
