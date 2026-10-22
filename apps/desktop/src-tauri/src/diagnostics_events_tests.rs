use super::*;
use crate::diagnostics_writer::{
    DiagnosticSink, FlushState, HealthSnapshot, Limits, RuntimeWriter, SinkError,
};
use std::{fmt, time::Duration};
use tracing_subscriber::layer::SubscriberExt;

struct Captured(Arc<Mutex<Vec<Vec<u8>>>>);
impl DiagnosticSink for Captured {
    fn write_record(&mut self, bytes: &[u8]) -> Result<(), SinkError> {
        self.0.lock().unwrap().push(bytes.to_vec());
        Ok(())
    }
    fn flush(&mut self) -> Result<(), SinkError> {
        Ok(())
    }
}
fn capture(emit: impl FnOnce()) -> (Vec<Vec<u8>>, HealthSnapshot) {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let (producer, mut guard) =
        RuntimeWriter::start_with_sink(Limits::default(), Captured(captured.clone())).unwrap();
    let subscriber = tracing_subscriber::registry().with(DiagnosticLayer::new(producer));
    tracing::subscriber::with_default(subscriber, emit);
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.flush_state, FlushState::Complete);
    let records = captured.lock().unwrap().clone();
    (records, health)
}
struct RefusesFormatting;
impl fmt::Debug for RefusesFormatting {
    fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
        panic!("arbitrary Debug must never execute")
    }
}
impl fmt::Display for RefusesFormatting {
    fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
        panic!("arbitrary Display must never execute")
    }
}
impl std::error::Error for RefusesFormatting {}

#[test]
fn typed_envelope_golden_retains_approved_nested_context() {
    let (records, health) = capture(|| {
        let parent = tracing::info_span!(
            "operation",
            operation_id = "parent-1",
            port_id = "owned-port",
            release = "v1.2"
        );
        let _parent = parent.enter();
        let child = tracing::info_span!(
            "phase",
            component = "operation",
            phase = "setup",
            request_id = 9_u64
        );
        let _child = child.enter();
        tracing::error!(
            sequence = 7_u64,
            success = false,
            exit_code = -2_i64,
            error_code = "network",
            mutation_state = "unknown",
            message = "Owned fixture failed"
        );
    });
    assert_eq!(health.dropped, 0);
    let mut event: Value = serde_json::from_slice(&records[0]).unwrap();
    assert!(event["timestamp_ms"].as_u64().unwrap() > 0);
    assert!(event["elapsed_ms"].is_u64());
    assert_eq!(event["process_id"], std::process::id());
    assert!(uuid::Uuid::parse_str(event["session_id"].as_str().unwrap()).is_ok());
    for key in [
        "timestamp_ms",
        "elapsed_ms",
        "process_id",
        "session_id",
        "target",
    ] {
        event.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(
        event,
        json!({
            "schema_version": 1, "surface": "desktop", "build": env!("CARGO_PKG_VERSION"), "level": "ERROR",
            "fields": {"sequence":7,"success":false,"exit_code":-2,"message":"Owned fixture failed"},
            "spans":[{"operation_id":"parent-1","port_id":"owned-port","release":"v1.2"},
                     {"component":"operation","phase":"setup","request_id":9}],
            "error":{"code":"network","mutation_state":"unknown"}, "context_complete":true,"omitted_fields":0
        })
    );
    let exported = serde_json::to_value(portcove_core::SupportBundleData::runtime_log_line(
        std::str::from_utf8(&records[0]).unwrap(),
    ))
    .unwrap();
    assert_eq!(exported["error"], event["error"]);
    assert_eq!(exported["spans"], event["spans"]);
    assert_eq!(exported["fields"], event["fields"]);
}

#[test]
fn opaque_debug_display_errors_and_span_values_are_never_formatted() {
    let (records, health) = capture(|| {
        let opaque = RefusesFormatting;
        let span = tracing::info_span!("owned-fixture", private = ?opaque);
        let _entered = span.enter();
        tracing::info!(object = ?opaque, display = %opaque, error = &opaque as &(dyn std::error::Error + 'static), message = "safe borrowed message");
        tracing::info!("untrusted formatting: {opaque}");
    });
    assert_eq!(records.len(), 2);
    assert_eq!(health.opaque_fields, 5);
    let first: Value = serde_json::from_slice(&records[0]).unwrap();
    assert_eq!(first["fields"], json!({"message":"safe borrowed message"}));
    assert_eq!(first["context_complete"], false);
    assert!(!String::from_utf8_lossy(&records.concat()).contains("private"));
}

#[test]
fn privacy_and_multibyte_limits_apply_before_queue_admission_and_export() {
    let oversized = format!("{}token=boundary-canary", "界".repeat(342));
    let (records, health) = capture(|| {
        let span = tracing::info_span!(
            "owned",
            token = "span-canary",
            port_id = "https://private-path-canary",
            operation_id = "owned-operation"
        );
        let _entered = span.enter();
        tracing::error!(message = "Authorization: Bearer message-canary token=inline-canary safe=visible",
            password = "field-canary", component_stack = oversized.as_str(), private_path = "/private/raw-path-canary",
            error = ?portcove_core::PortcoveError::state("nested-error-canary").detail("Authorization", "Bearer nested-header-canary"));
    });
    assert_eq!(records.len(), 1);
    assert_eq!(health.truncated_fields, 1);
    assert_eq!(health.opaque_fields, 1);
    let text = std::str::from_utf8(&records[0]).unwrap();
    let exported =
        serde_json::to_value(portcove_core::SupportBundleData::runtime_log_line(text)).unwrap();
    for content in [text.to_owned(), exported.to_string()] {
        for canary in [
            "message-canary",
            "inline-canary",
            "field-canary",
            "boundary-canary",
            "span-canary",
            "nested-error-canary",
            "nested-header-canary",
            "private-path-canary",
            "raw-path-canary",
        ] {
            assert!(!content.contains(canary), "leaked {canary}");
        }
        assert!(content.contains("safe=visible"));
    }
}

#[test]
fn credential_shaped_targets_are_omitted_before_persistence_and_export() {
    let (records, health) = capture(|| {
        tracing::info!(target: "ghp_target_canary", message = "safe");
        tracing::info!(target: "github_pat_target_canary", message = "safe");
    });
    assert_eq!(records.len(), 2);
    assert_eq!(health.truncated_fields, 2);
    for bytes in records {
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(!text.contains("target_canary"));
        let event: Value = serde_json::from_str(text).unwrap();
        assert_eq!(event["context_complete"], false);
        let exported =
            serde_json::to_value(portcove_core::SupportBundleData::runtime_log_line(text)).unwrap();
        assert!(!exported.to_string().contains("target_canary"));
        assert_eq!(exported["context_complete"], false);
        // An externally supplied schema-1 target receives the same rule.
        let mut supplied = event;
        supplied["target"] = json!("ghp_export_target_canary");
        let exported = serde_json::to_value(portcove_core::SupportBundleData::runtime_log_line(
            &supplied.to_string(),
        ))
        .unwrap();
        assert!(!exported.to_string().contains("target_canary"));
        assert_eq!(exported["target"], Value::Null);
    }
}

#[test]
fn escaped_values_and_oversized_messages_remain_bounded_valid_json() {
    let escaped = "\u{0001}".repeat(MAX_FIELD_BYTES);
    let (records, health) = capture(|| {
        tracing::info!(
            message = escaped.as_str(),
            sequence = u64::MAX,
            success = true
        );
        tracing::info!(message = "界".repeat(342).as_str());
    });
    assert_eq!(records.len(), 2);
    assert_eq!(health.truncated_fields, 1);
    for record in &records {
        assert!(record.len() <= Limits::default().max_record_bytes);
    }
    let first: Value = serde_json::from_slice(&records[0]).unwrap();
    assert_eq!(first["fields"]["message"], escaped);
    assert_eq!(first["fields"]["sequence"], u64::MAX);
    let exported = serde_json::to_value(portcove_core::SupportBundleData::runtime_log_line(
        std::str::from_utf8(&records[0]).unwrap(),
    ))
    .unwrap();
    assert_eq!(exported["fields"], first["fields"]);
    assert_eq!(exported["context_complete"], true);
    let second: Value = serde_json::from_slice(&records[1]).unwrap();
    assert_eq!(second["fields"]["message"], OMITTED);
}

#[test]
fn export_preserves_null_auth_code_and_refuses_unknown_or_malformed_envelopes() {
    let (records, _) = capture(|| {
        tracing::debug!(
            component = "github_auth",
            command = "get_github_auth_status",
            phase = "complete",
            request_id = 7_u64,
            success = true,
            code = "None"
        );
    });
    let original: Value = serde_json::from_slice(&records[0]).unwrap();
    let export = |value: &Value| {
        serde_json::to_value(portcove_core::SupportBundleData::runtime_log_line(
            &value.to_string(),
        ))
        .unwrap()
    };
    let projected = export(&original);
    assert_eq!(projected["fields"], original["fields"]);
    assert_eq!(projected["fields"]["code"], Value::Null);
    assert_eq!(projected["context_complete"], true);
    for version in [json!(2), json!("1"), Value::Null] {
        let mut changed = original.clone();
        changed["schema_version"] = version;
        changed["message"] = json!("future-schema-private-canary");
        assert_eq!(
            export(&changed),
            json!({"unrecognized_runtime_schema":true})
        );
    }
    for (name, value) in [
        ("timestamp_ms", json!("123")),
        ("elapsed_ms", json!(-1)),
        ("session_id", json!("https://private-session-canary")),
        ("process_id", json!(0)),
        ("surface", json!("private-surface-canary")),
        ("build", json!("/private/build-canary")),
        ("level", json!("private-level-canary")),
        ("target", json!("https://private-target-canary")),
        ("context_complete", json!("true")),
        ("omitted_fields", json!(-1)),
    ] {
        let mut changed = original.clone();
        changed[name] = value;
        let projected = export(&changed);
        assert_eq!(projected["context_complete"], false, "{name}");
        assert!(
            projected["omitted_envelope_fields"].as_u64().unwrap() > 0,
            "{name}"
        );
        assert!(!projected.to_string().contains("canary"));
    }
    let mut changed = original;
    changed["fields"]["operation_id"] = json!({"private-nested-canary":"value"});
    changed["error"] =
        json!({"code":"network", "mutation_state":"unknown", "message":"nested-error-canary"});
    changed["spans"] = json!([{"operation_id":"owned", "private-field-canary":"/private/path-canary"}, {"phase":{"url":"https://span-url-canary"}}]);
    changed["private-envelope-name-canary"] = json!("value");
    let projected = export(&changed);
    assert_eq!(projected["context_complete"], false);
    assert!(!projected.to_string().contains("canary"));
    assert_eq!(
        projected["error"],
        json!({"code":"network", "mutation_state":"unknown"})
    );
    assert_eq!(projected["spans"], json!([{"operation_id":"owned"}]));
}

#[test]
fn too_many_fields_are_rejected_before_visiting_any_value() {
    let (records, health) = capture(|| {
        tracing::info!(a = ?RefusesFormatting, b = 1, c = 1, d = 1, e = 1, f = 1, g = 1, h = 1, i = 1, j = 1, k = 1, l = 1, m = 1, n = 1, o = 1, p = 1, q = 1);
    });
    assert!(records.is_empty());
    assert_eq!(health.dropped_formatting, 1);
    assert_eq!(health.truncated_fields, 17);
    assert_eq!(health.opaque_fields, 0);
}

#[test]
fn formatting_admission_is_bounded_and_recovers_without_waiting() {
    let (producer, mut guard) = RuntimeWriter::start_with_sink(
        Limits::default(),
        Captured(Arc::new(Mutex::new(Vec::new()))),
    )
    .unwrap();
    let health = producer.clone();
    let layer = DiagnosticLayer::new(producer);
    let permits: Vec<_> = (0..MAX_FORMATTING_PRODUCERS)
        .map(|_| layer.permit().unwrap())
        .collect();
    assert!(layer.permit().is_none());
    assert_eq!(health.health().dropped_formatting, 1);
    drop(permits);
    assert!(layer.permit().is_some());
    guard.shutdown(Duration::from_secs(2));
}

#[test]
fn spans_are_bounded_updated_and_released_without_stale_context() {
    let (records, health) = capture(|| {
        let span = tracing::info_span!(
            "owned",
            operation_id = "old-identity",
            request_id = tracing::field::Empty
        );
        let _entered = span.enter();
        span.record("request_id", 4_u64);
        span.record("operation_id", "https://private-update-canary");
        tracing::info!(message = "updated");
        let spans: Vec<_> = (0..MAX_STORED_SPANS)
            .map(|_| tracing::info_span!("owned", operation_id = "bounded"))
            .collect();
        {
            let _last = spans.last().unwrap().enter();
            tracing::info!(message = "saturated");
        }
        drop(spans);
        let fresh = tracing::info_span!("owned", operation_id = "fresh");
        let _fresh = fresh.enter();
        tracing::info!(message = "recovered");
    });
    assert!(health.dropped_formatting > 0);
    let events: Vec<Value> = records
        .iter()
        .map(|bytes| serde_json::from_slice(bytes).unwrap())
        .collect();
    assert_eq!(events[0]["spans"], json!([{"request_id":4}]));
    assert_eq!(events[0]["context_complete"], false);
    assert_eq!(events[1]["context_complete"], false);
    assert_eq!(events[2]["spans"][1]["operation_id"], "fresh");
    assert!(!String::from_utf8_lossy(&records.concat()).contains("private-update-canary"));
}

#[test]
fn span_depth_is_bounded_without_walking_the_entire_parent_chain() {
    let (records, _) = capture(|| {
        let spans: Vec<_> = (0..20).fold(Vec::new(), |mut spans, _| {
            let span = if let Some(parent) = spans.last() {
                tracing::info_span!(parent: parent, "owned", operation_id = "owned")
            } else {
                tracing::info_span!("owned", operation_id = "owned")
            };
            spans.push(span);
            spans
        });
        let _entered = spans.last().unwrap().enter();
        tracing::info!(message = "depth fixture");
    });
    let event: Value = serde_json::from_slice(&records[0]).unwrap();
    assert_eq!(event["spans"].as_array().unwrap().len(), policy::MAX_SPANS);
    assert_eq!(event["context_complete"], false);
}

#[test]
fn missed_span_updates_omit_stale_context_after_admission_and_lock_contention() {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let (producer, mut guard) =
        RuntimeWriter::start_with_sink(Limits::default(), Captured(captured.clone())).unwrap();
    let dispatch =
        tracing::Dispatch::new(tracing_subscriber::registry().with(DiagnosticLayer::new(producer)));
    tracing::dispatcher::with_default(&dispatch, || {
        let layer = dispatch.downcast_ref::<DiagnosticLayer>().unwrap();
        let registry = dispatch
            .downcast_ref::<tracing_subscriber::Registry>()
            .unwrap();
        for contention in ["admission", "lock"] {
            let span =
                tracing::info_span!("owned", operation_id = "old-identity", request_id = 1_u64);
            let _entered = span.enter();
            if contention == "admission" {
                let permits: Vec<_> = (0..MAX_FORMATTING_PRODUCERS)
                    .map(|_| layer.permit().unwrap())
                    .collect();
                span.record("operation_id", "new-identity");
                drop(permits);
            } else {
                let id = span.id().unwrap();
                let stored_span = registry.span(&id).unwrap();
                let extensions = stored_span.extensions();
                let stored = extensions.get::<SpanFields>().unwrap();
                let _lock = stored.fields.lock().unwrap();
                span.record("operation_id", "new-identity");
            }
            // A subsequent update to another field cannot repair the missed ID.
            span.record("request_id", 2_u64);
            tracing::info!(message = "observed after missed update");
        }
    });
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.dropped_formatting, 2);
    let records = captured.lock().unwrap();
    assert_eq!(records.len(), 2);
    for bytes in records.iter() {
        let event: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(event["spans"], json!([]));
        assert_eq!(event["context_complete"], false);
        assert!(!String::from_utf8_lossy(bytes).contains("old-identity"));
    }
}

#[test]
fn existing_operation_parent_identity_and_monotonic_observation_survive_concurrency() {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let (producer, mut guard) =
        RuntimeWriter::start_with_sink(Limits::default(), Captured(captured.clone())).unwrap();
    let dispatch =
        tracing::Dispatch::new(tracing_subscriber::registry().with(DiagnosticLayer::new(producer)));
    let entered = Arc::new(std::sync::Barrier::new(4));
    // Keep all four operation/span lifetimes overlapping. Serialize just test
    // emissions so best-effort admission contention cannot hide the identities
    // this fixture checks; separate saturation tests exercise explicit loss.
    let emission = Arc::new(Mutex::new(()));
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let dispatch = dispatch.clone();
            let entered = entered.clone();
            let emission = emission.clone();
            std::thread::spawn(move || {
                tracing::dispatcher::with_default(&dispatch, || {
                    let parent = portcove_core::OperationCoordinator::new("install", None);
                    let child = parent.child("prepare", None);
                    let span = {
                        let _admission = emission.lock().unwrap();
                        tracing::info_span!("owned-operation", operation_id = child.operation_id())
                    };
                    let _span = span.enter();
                    entered.wait();
                    {
                        let _admission = emission.lock().unwrap();
                        child.started();
                    }
                    {
                        let _admission = emission.lock().unwrap();
                        child.progress("download", 0, Some(100));
                    }
                    for completed in 1..100 {
                        child.progress("download", completed, Some(100));
                    }
                    {
                        let _admission = emission.lock().unwrap();
                        child.finished(portcove_core::OperationResult::Succeeded);
                    }
                    (
                        child.operation_id().to_owned(),
                        parent.operation_id().to_owned(),
                    )
                })
            })
        })
        .collect();
    let identities: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let health = guard.shutdown(Duration::from_secs(2));
    assert_eq!(health.dropped, 0);
    let records: Vec<Value> = captured
        .lock()
        .unwrap()
        .iter()
        .map(|record| serde_json::from_slice(record).unwrap())
        .collect();
    assert_eq!(records.len(), 12, "progress ticks are not runtime records");
    for (id, parent) in identities {
        let events: Vec<_> = records
            .iter()
            .filter(|event| event["fields"]["operation_id"] == id)
            .collect();
        assert_eq!(events.len(), 3);
        assert!(
            events
                .iter()
                .all(|event| event["spans"] == json!([{"operation_id":id}]))
        );
        assert!(
            events
                .iter()
                .all(|event| event["fields"]["parent_operation_id"] == parent)
        );
        assert!(
            events
                .iter()
                .all(|event| event["fields"].get("activity_id").is_none())
        );
        assert!(
            events
                .windows(2)
                .all(|pair| pair[0]["fields"]["elapsed_ms"].as_u64()
                    <= pair[1]["fields"]["elapsed_ms"].as_u64())
        );
        assert_eq!(events[2]["fields"]["observed_result"], "succeeded");
        assert_eq!(events[2]["fields"]["sequence"], 101);
    }
}
