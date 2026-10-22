//! Bounded, redacted desktop tracing events. No filesystem work runs here.
//!
//! A formatter supplied by a caller can block or allocate before it ever writes
//! to a capped buffer. Opaque Debug/Display/error values are therefore omitted
//! without calling them. Use a borrowed string or primitive field for useful
//! bounded diagnostics; large child output belongs to the Core capture owner.

use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicUsize, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use portcove_core::{redact_diagnostic_text, sensitive_diagnostic_field};
use serde_json::{Value, json};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::Layer;

use super::diagnostics_writer::Producer;

pub(crate) const MAX_FIELDS: usize = 16;
pub(crate) const MAX_FIELD_BYTES: usize = 1_024;
pub(crate) const MAX_VALUE_BYTES: usize = 4_096;
pub(crate) const MAX_FIELD_NAME_BYTES: usize = 64;
pub(crate) const MAX_TARGET_BYTES: usize = 256;
pub(crate) const MAX_FORMATTING_PRODUCERS: usize = 8;
const OMITTED: &str = "[OMITTED]";

pub(crate) fn record_operation_event(event: &portcove_core::OperationEvent) {
    tracing::info!(
        operation_id = event.operation_id.as_str(),
        parent_operation_id = event.parent_operation_id.as_deref(),
        sequence = event.sequence,
        operation = event.operation.as_str(),
        target = ?event.target,
        event = ?event.event,
        message = "operation event",
    );
}

pub(crate) struct DiagnosticLayer {
    producer: Producer,
    formatting: AtomicUsize,
}

impl DiagnosticLayer {
    pub(crate) fn new(producer: Producer) -> Self {
        Self {
            producer,
            formatting: AtomicUsize::new(0),
        }
    }

    fn permit(&self) -> Option<FormattingPermit<'_>> {
        // A single nonblocking attempt also bounds contention work. Losing a
        // concurrent admission is an explicit best-effort drop, not a retry.
        let active = self.formatting.load(Ordering::Relaxed);
        if active >= MAX_FORMATTING_PRODUCERS
            || self
                .formatting
                .compare_exchange(active, active + 1, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
        {
            self.producer.note_dropped();
            return None;
        }
        Some(FormattingPermit(&self.formatting))
    }
}

struct FormattingPermit<'a>(&'a AtomicUsize);

impl Drop for FormattingPermit<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

impl<S: Subscriber> Layer<S> for DiagnosticLayer {
    fn on_event(&self, event: &Event<'_>, _context: tracing_subscriber::layer::Context<'_, S>) {
        let Some(_permit) = self.permit() else {
            return;
        };
        let metadata = event.metadata();
        // Reject before visiting: a dynamic callsite can otherwise supply an
        // arbitrary number of fields even when each individual visit is cheap.
        if metadata.fields().len() > MAX_FIELDS {
            self.producer.note_truncated(metadata.fields().len() as u64);
            self.producer.note_dropped();
            return;
        }
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let target = if metadata.target().len() <= MAX_TARGET_BYTES {
            let target = redact_diagnostic_text(metadata.target());
            if target.len() <= MAX_TARGET_BYTES {
                target
            } else {
                visitor.truncated += 1;
                OMITTED.to_owned()
            }
        } else {
            visitor.truncated += 1;
            OMITTED.to_owned()
        };
        self.producer.note_truncated(visitor.truncated);
        self.producer.note_opaque_omitted(visitor.opaque);
        let entry = json!({
            "timestamp_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            "level": metadata.level().as_str(),
            "target": target,
            "fields": visitor.fields,
        });
        // Bounded admitted inputs also bound serialization, including JSON's
        // six-byte escaping expansion. The writer checks the encoded record cap
        // again and drops whole records, never a partial JSON/UTF-8 prefix.
        if let Ok(mut line) = serde_json::to_vec(&entry) {
            line.push(b'\n');
            self.producer.try_record(line);
        } else {
            self.producer.note_dropped();
        }
    }
}

#[derive(Default)]
struct FieldVisitor {
    fields: BTreeMap<String, Value>,
    value_bytes: usize,
    truncated: u64,
    opaque: u64,
}

impl FieldVisitor {
    fn record(&mut self, field: &Field, value: &str) {
        let name = field.name();
        if name.len() > MAX_FIELD_NAME_BYTES
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.'))
        {
            self.truncated += 1;
            return;
        }
        let value = if sensitive_diagnostic_field(name) {
            "[REDACTED]".to_owned()
        } else if value.len() > MAX_FIELD_BYTES {
            // Dropping the whole value avoids retaining a credential whose
            // identifying marker or closing quote straddles a clipping boundary.
            self.truncated += 1;
            OMITTED.to_owned()
        } else {
            let redacted = redact_diagnostic_text(value);
            if redacted.len() > MAX_FIELD_BYTES {
                self.truncated += 1;
                OMITTED.to_owned()
            } else {
                redacted
            }
        };
        if self.value_bytes + value.len() > MAX_VALUE_BYTES {
            self.truncated += 1;
            return;
        }
        self.value_bytes += value.len();
        self.fields.insert(name.to_owned(), Value::String(value));
    }

    fn opaque(&mut self, field: &Field) {
        self.opaque += 1;
        self.record(field, OMITTED);
    }
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field, value);
    }

    fn record_debug(&mut self, field: &Field, _value: &dyn std::fmt::Debug) {
        self.opaque(field);
    }

    fn record_error(&mut self, field: &Field, _value: &(dyn std::error::Error + 'static)) {
        self.opaque(field);
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record(field, if value { "true" } else { "false" });
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record(field, &value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record(field, &value.to_string());
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        self.record(field, &value.to_string());
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        self.record(field, &value.to_string());
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.record(field, &value.to_string());
    }
}

#[cfg(test)]
#[path = "diagnostics_events_tests.rs"]
mod tests;
