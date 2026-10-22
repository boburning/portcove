//! Bounded typed desktop observations. No filesystem work or arbitrary
//! Debug/Display/error formatting runs on the emitting thread.

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use portcove_core::runtime_diagnostics as policy;
use serde_json::{Value, json};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

use super::diagnostics_writer::Producer;

pub(crate) use policy::{MAX_FIELD_BYTES, MAX_FIELDS, MAX_TARGET_BYTES, MAX_VALUE_BYTES};
pub(crate) const MAX_FIELD_NAME_BYTES: usize = 64;
pub(crate) const MAX_FORMATTING_PRODUCERS: usize = 8;
pub(crate) const MAX_STORED_SPANS: usize = 256;
const OMITTED: &str = "[OMITTED]";

pub(crate) struct DiagnosticLayer {
    producer: Producer,
    formatting: AtomicUsize,
    spans: Arc<AtomicUsize>,
    session_id: String,
    started: Instant,
}

impl DiagnosticLayer {
    pub(crate) fn new(producer: Producer) -> Self {
        Self {
            producer,
            formatting: AtomicUsize::new(0),
            spans: Arc::new(AtomicUsize::new(0)),
            session_id: uuid::Uuid::new_v4().to_string(),
            started: Instant::now(),
        }
    }

    fn permit(&self) -> Option<FormattingPermit<'_>> {
        if !try_increment(&self.formatting, MAX_FORMATTING_PRODUCERS) {
            self.producer.note_dropped();
            return None;
        }
        Some(FormattingPermit(&self.formatting))
    }

    fn note(&self, visitor: &FieldVisitor) {
        self.producer.note_truncated(visitor.truncated);
        self.producer.note_opaque_omitted(visitor.opaque);
    }
}

fn try_increment(count: &AtomicUsize, maximum: usize) -> bool {
    let current = count.load(Ordering::Relaxed);
    current < maximum
        && count
            .compare_exchange(current, current + 1, Ordering::Acquire, Ordering::Relaxed)
            .is_ok()
}

struct FormattingPermit<'a>(&'a AtomicUsize);
impl Drop for FormattingPermit<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

struct SpanFields {
    fields: Mutex<FieldVisitor>,
    count: Arc<AtomicUsize>,
    invalidated: AtomicBool,
}
impl Drop for SpanFields {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::Release);
    }
}

impl<S> Layer<S> for DiagnosticLayer
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn on_new_span(&self, attributes: &Attributes<'_>, id: &Id, context: Context<'_, S>) {
        let Some(_permit) = self.permit() else {
            return;
        };
        if attributes.metadata().fields().len() > policy::MAX_SPAN_FIELDS {
            self.producer
                .note_truncated(attributes.metadata().fields().len() as u64);
            return;
        }
        let Some(span) = context.span(id) else {
            return;
        };
        if !try_increment(&self.spans, MAX_STORED_SPANS) {
            self.producer.note_dropped();
            return;
        }
        let mut visitor = FieldVisitor::span();
        attributes.record(&mut visitor);
        self.note(&visitor);
        // Only creation mutates the extension map. Updates use a nonblocking
        // inner lock, so one suspended recorder cannot stall another producer.
        span.extensions_mut().insert(SpanFields {
            fields: Mutex::new(visitor),
            count: self.spans.clone(),
            invalidated: AtomicBool::new(false),
        });
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, context: Context<'_, S>) {
        let Some(span) = context.span(id) else {
            return;
        };
        let extensions = span.extensions();
        let Some(stored) = extensions.get::<SpanFields>() else {
            return;
        };
        let Some(_permit) = self.permit() else {
            stored.invalidated.store(true, Ordering::Release);
            return;
        };
        let Ok(mut visitor) = stored.fields.try_lock() else {
            stored.invalidated.store(true, Ordering::Release);
            self.producer.note_dropped();
            return;
        };
        let before = (visitor.truncated, visitor.opaque);
        values.record(&mut *visitor);
        self.producer.note_truncated(visitor.truncated - before.0);
        self.producer.note_opaque_omitted(visitor.opaque - before.1);
    }

    fn on_event(&self, event: &Event<'_>, context: Context<'_, S>) {
        let Some(_permit) = self.permit() else {
            return;
        };
        let metadata = event.metadata();
        if metadata.fields().len() > MAX_FIELDS {
            self.producer.note_truncated(metadata.fields().len() as u64);
            self.producer.note_dropped();
            return;
        }
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let target = metadata.target();
        let target = if policy::target(target) {
            target
        } else {
            visitor.truncated += 1;
            OMITTED
        };
        let mut spans = Vec::new();
        let mut context_complete = true;
        if let Some(scope) = context.event_scope(event) {
            // Scope is leaf-first. Do not call from_root(), which traverses and
            // buffers an unbounded ancestry before the take() could apply.
            for (index, span) in scope.take(policy::MAX_SPANS + 1).enumerate() {
                if index == policy::MAX_SPANS {
                    context_complete = false;
                    break;
                }
                let extensions = span.extensions();
                let Some(stored) = extensions.get::<SpanFields>() else {
                    context_complete = false;
                    continue;
                };
                // A missed update permanently invalidates this span snapshot:
                // a later partial update cannot prove every old field current.
                if stored.invalidated.load(Ordering::Acquire) {
                    context_complete = false;
                    continue;
                }
                let Ok(fields) = stored.fields.try_lock() else {
                    context_complete = false;
                    continue;
                };
                context_complete &=
                    fields.omitted == 0 && fields.truncated == 0 && fields.opaque == 0;
                if stored.invalidated.load(Ordering::Acquire) {
                    context_complete = false;
                } else if !fields.fields.is_empty() {
                    spans.push(fields.fields.clone());
                }
            }
        }
        spans.reverse();
        self.note(&visitor);
        context_complete &= visitor.omitted == 0 && visitor.truncated == 0 && visitor.opaque == 0;
        let mut fields = visitor.fields;
        let error = fields
            .remove("error_code")
            .filter(|code| !code.is_null())
            .map(|code| {
                let mut context = serde_json::Map::new();
                context.insert("code".into(), code);
                if let Some(state) = fields.remove("mutation_state") {
                    context.insert("mutation_state".into(), state);
                }
                context
            });
        let entry = json!({
            "schema_version": policy::SCHEMA_VERSION,
            "timestamp_ms": millis(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()),
            "elapsed_ms": millis(self.started.elapsed()),
            "session_id": self.session_id,
            "process_id": std::process::id(),
            "surface": "desktop",
            "build": env!("CARGO_PKG_VERSION"),
            "level": metadata.level().as_str(),
            "target": target,
            "fields": fields,
            "error": error,
            "spans": spans,
            "context_complete": context_complete,
            "omitted_fields": visitor.omitted + visitor.truncated + visitor.opaque,
        });
        if let Ok(mut line) = serde_json::to_vec(&entry) {
            line.push(b'\n');
            self.producer.try_record(line);
        } else {
            self.producer.note_dropped();
        }
    }
}

fn millis(duration: std::time::Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

#[derive(Default)]
struct FieldVisitor {
    fields: BTreeMap<String, Value>,
    value_bytes: usize,
    truncated: u64,
    opaque: u64,
    omitted: u64,
    span: bool,
}
impl FieldVisitor {
    fn span() -> Self {
        Self {
            span: true,
            ..Self::default()
        }
    }

    fn record(&mut self, field: &Field, value: Value) {
        let name = field.name();
        if name.len() > MAX_FIELD_NAME_BYTES {
            self.truncated += 1;
            return;
        }
        let value = if self.span {
            policy::span_field(name, &value)
        } else {
            policy::field(name, &value)
        };
        let Some(value) = value else {
            self.remove(field);
            self.omitted += 1;
            return;
        };
        let bytes = policy::value_bytes(&value);
        let old = self.fields.get(name).map_or(0, policy::value_bytes);
        let limit = if self.span {
            policy::MAX_SPAN_BYTES
        } else {
            MAX_VALUE_BYTES
        };
        let count = if self.span {
            policy::MAX_SPAN_FIELDS
        } else {
            MAX_FIELDS
        };
        if self.value_bytes - old + bytes > limit
            || (!self.fields.contains_key(name) && self.fields.len() >= count)
        {
            // An invalid update must not leave an old context value pretending
            // to be current. Omit it until another accepted record supplies it.
            self.fields.remove(name);
            self.value_bytes -= old;
            self.truncated += 1;
            return;
        }
        self.value_bytes = self.value_bytes - old + bytes;
        self.fields.insert(name.to_owned(), value);
    }

    fn remove(&mut self, field: &Field) {
        if let Some(old) = self.fields.remove(field.name()) {
            self.value_bytes -= policy::value_bytes(&old);
        }
    }

    fn opaque(&mut self, field: &Field) {
        self.opaque += 1;
        self.record(field, json!(OMITTED));
    }
}
impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if value.len() > MAX_FIELD_BYTES {
            self.truncated += 1;
            self.record(field, json!(OMITTED));
        } else {
            self.record(field, json!(value));
        }
    }
    fn record_debug(&mut self, field: &Field, _value: &dyn std::fmt::Debug) {
        self.opaque(field);
    }
    fn record_error(&mut self, field: &Field, _value: &(dyn std::error::Error + 'static)) {
        self.opaque(field);
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record(field, json!(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record(field, json!(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record(field, json!(value));
    }
    fn record_i128(&mut self, field: &Field, value: i128) {
        if let Ok(value) = i64::try_from(value) {
            self.record_i64(field, value);
        } else {
            self.remove(field);
            self.truncated += 1;
        }
    }
    fn record_u128(&mut self, field: &Field, value: u128) {
        if let Ok(value) = u64::try_from(value) {
            self.record_u64(field, value);
        } else {
            self.remove(field);
            self.truncated += 1;
        }
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        if let Some(value) = serde_json::Number::from_f64(value) {
            self.record(field, Value::Number(value));
        } else {
            self.remove(field);
            self.truncated += 1;
        }
    }
}

#[cfg(test)]
#[path = "diagnostics_events_tests.rs"]
mod tests;
