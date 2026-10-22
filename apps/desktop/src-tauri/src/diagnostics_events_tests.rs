use super::*;
use crate::diagnostics_writer::{
    DiagnosticSink, FlushState, HealthSnapshot, Limits, RuntimeWriter, SinkError,
};
use std::{
    fmt,
    sync::{Arc, Mutex},
    time::Duration,
};
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
        panic!("arbitrary Debug must never execute on the producer")
    }
}

impl fmt::Display for RefusesFormatting {
    fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
        panic!("arbitrary Display must never execute on the producer")
    }
}

impl std::error::Error for RefusesFormatting {}

#[test]
fn opaque_debug_display_errors_and_span_values_are_never_formatted() {
    let (records, health) = capture(|| {
        let opaque = RefusesFormatting;
        let span = tracing::info_span!("owned-fixture", private = ?opaque);
        let _entered = span.enter();
        tracing::info!(
            object = ?opaque,
            display = %opaque,
            error = &opaque as &(dyn std::error::Error + 'static),
            message = "safe borrowed message",
        );
        tracing::info!("untrusted formatting: {opaque}");
    });
    assert_eq!(records.len(), 2);
    assert_eq!(health.opaque_fields, 4);
    let first: Value = serde_json::from_slice(&records[0]).unwrap();
    assert_eq!(first["fields"]["message"], "safe borrowed message");
    for field in ["object", "display", "error"] {
        assert_eq!(first["fields"][field], OMITTED);
    }
    assert!(!String::from_utf8_lossy(&records.concat()).contains("private"));
}

#[test]
fn privacy_and_multibyte_limits_apply_before_queue_admission() {
    let oversized = format!("{}token=boundary-canary", "界".repeat(342));
    let (records, health) = capture(|| {
        let span = tracing::info_span!("private-span", token = "span-canary");
        let _entered = span.enter();
        tracing::error!(
            message = "Authorization: Bearer message-canary token=inline-canary safe=visible",
            password = "field-canary",
            oversized = oversized.as_str(),
            error = ?portcove_core::PortcoveError::state("nested-error-canary")
                .detail("Authorization", "Bearer nested-header-canary"),
            operation_id = "owned-fixture",
        );
    });
    assert_eq!(records.len(), 1);
    assert_eq!(health.truncated_fields, 1);
    assert_eq!(health.opaque_fields, 1);
    let bytes = &records[0];
    let text = std::str::from_utf8(bytes).unwrap();
    for canary in [
        "message-canary",
        "inline-canary",
        "field-canary",
        "boundary-canary",
        "span-canary",
        "nested-error-canary",
        "nested-header-canary",
    ] {
        assert!(!text.contains(canary), "leaked {canary}");
    }
    let event: Value = serde_json::from_slice(bytes).unwrap();
    assert!(
        event["fields"]["message"]
            .as_str()
            .unwrap()
            .contains("safe=visible")
    );
    assert_eq!(event["fields"]["password"], "[REDACTED]");
    assert_eq!(event["fields"]["oversized"], OMITTED);
}

#[test]
fn aggregate_values_and_escaping_remain_bounded_valid_json() {
    let escaped = "\u{0001}".repeat(MAX_FIELD_BYTES);
    let multibyte = "é".repeat(MAX_FIELD_BYTES / 2);
    let (records, health) = capture(|| {
        tracing::info!(
            first = escaped.as_str(),
            second = escaped.as_str(),
            third = multibyte.as_str(),
            fourth = multibyte.as_str(),
            excess = "omitted-by-aggregate-budget",
        );
    });
    assert_eq!(health.truncated_fields, 1);
    let record = &records[0];
    assert!(record.len() <= Limits::default().max_record_bytes);
    let event: Value = serde_json::from_slice(record).unwrap();
    let fields = event["fields"].as_object().unwrap();
    assert_eq!(fields.len(), 4);
    assert_eq!(fields["first"], escaped);
    assert_eq!(fields["third"], multibyte);
    assert!(
        fields
            .values()
            .map(|value| value.as_str().unwrap().len())
            .sum::<usize>()
            <= MAX_VALUE_BYTES
    );
}

#[test]
fn too_many_fields_are_rejected_before_visiting_any_value() {
    let (records, health) = capture(|| {
        tracing::info!(
            a = ?RefusesFormatting, b = 1, c = 1, d = 1, e = 1, f = 1,
            g = 1, h = 1, i = 1, j = 1, k = 1, l = 1, m = 1, n = 1,
            o = 1, p = 1, q = 1,
        );
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
fn existing_core_operation_and_parent_identity_survive_without_debug() {
    let mut event = portcove_core::OperationEvent {
        schema_version: 2,
        operation_id: "owned-operation".into(),
        parent_operation_id: None,
        sequence: 3,
        timestamp_ms: 0,
        operation: "install".into(),
        target: None,
        event: portcove_core::OperationEventKind::Started,
    };
    let (records, _) = capture(|| {
        record_operation_event(&event);
        event.parent_operation_id = Some("owned-parent".into());
        record_operation_event(&event);
    });
    let first: Value = serde_json::from_slice(&records[0]).unwrap();
    let second: Value = serde_json::from_slice(&records[1]).unwrap();
    assert_eq!(first["fields"]["operation_id"], "owned-operation");
    assert_eq!(first["fields"]["operation"], "install");
    assert_eq!(first["fields"]["sequence"], "3");
    assert!(first["fields"].get("parent_operation_id").is_none());
    assert_eq!(second["fields"]["parent_operation_id"], "owned-parent");
}
