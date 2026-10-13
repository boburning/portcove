//! Bounded read diagnostics for the qualification executable, never stage authority.
use std::{
    collections::VecDeque,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use serde::Serialize;

const MAX_RECORDS: usize = 8;
const MAX_MARKS: usize = 8;
static RECORDS: Mutex<VecDeque<Record>> = Mutex::new(VecDeque::new());
static OMITTED: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
struct Mark {
    phase: &'static str,
    elapsed_ms: u64,
}

#[derive(Serialize)]
struct Record {
    operation_id: String,
    scope: &'static str,
    phase: &'static str,
    completed: bool,
    elapsed_ms: u64,
    entries: u64,
    files_hashed: u64,
    bytes_hashed: u64,
    hashing_ms: u64,
    verification_costs: VerificationCosts,
    marks_omitted: u64,
    marks: Vec<Mark>,
}

pub(super) struct Trace {
    started: Instant,
    starting_costs: VerificationCosts,
    record: Record,
}

fn milliseconds(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

impl Trace {
    pub(super) fn new(operation_id: &str, scope: &'static str) -> Self {
        Self {
            started: Instant::now(),
            starting_costs: current_costs(),
            record: Record {
                // Core operation IDs are UUIDs. Refuse to retain unbounded caller text.
                operation_id: if operation_id.len() <= 128 {
                    operation_id.into()
                } else {
                    String::new()
                },
                scope,
                phase: "entered",
                completed: false,
                elapsed_ms: 0,
                entries: 0,
                files_hashed: 0,
                bytes_hashed: 0,
                hashing_ms: 0,
                verification_costs: VerificationCosts::default(),
                marks_omitted: 0,
                marks: Vec::with_capacity(MAX_MARKS),
            },
        }
    }

    pub(super) fn phase(&mut self, phase: &'static str) {
        self.record.phase = phase;
        if self.record.marks.len() < MAX_MARKS {
            self.record.marks.push(Mark {
                phase,
                elapsed_ms: milliseconds(self.started),
            });
        } else {
            self.record.marks_omitted = self.record.marks_omitted.saturating_add(1);
        }
    }

    pub(super) fn entries(&mut self, entries: usize) {
        self.record.entries = u64::try_from(entries).unwrap_or(u64::MAX);
    }

    pub(super) fn hashing(&mut self) {
        // Per-file changes update one fixed field, never append an event or callback.
        self.record.phase = "file_hashing";
    }

    pub(super) fn hashed(&mut self, bytes: u64, started: Instant) {
        self.record.files_hashed = self.record.files_hashed.saturating_add(1);
        self.record.bytes_hashed = self.record.bytes_hashed.saturating_add(bytes);
        self.record.hashing_ms = self.record.hashing_ms.saturating_add(milliseconds(started));
        self.record.phase = "enumeration";
    }

    pub(super) fn complete(&mut self) {
        self.record.completed = true;
        self.phase("completed");
    }
}

impl Drop for Trace {
    fn drop(&mut self) {
        // Cancellation/error still publishes the last entered phase, but never
        // changes the original Result or waits for a diagnostic lock.
        self.record.elapsed_ms = milliseconds(self.started);
        self.record.verification_costs = current_costs().since(&self.starting_costs);
        let Ok(mut records) = RECORDS.try_lock() else {
            OMITTED.fetch_add(1, Ordering::Relaxed);
            return;
        };
        if self.record.operation_id.is_empty() {
            OMITTED.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if records.len() == MAX_RECORDS {
            records.pop_front();
            OMITTED.fetch_add(1, Ordering::Relaxed);
        }
        // Moving the bounded record avoids any serialization inside inventory fences.
        let record = std::mem::replace(
            &mut self.record,
            Record {
                operation_id: String::new(),
                scope: "discarded",
                phase: "discarded",
                completed: false,
                elapsed_ms: 0,
                entries: 0,
                files_hashed: 0,
                bytes_hashed: 0,
                hashing_ms: 0,
                verification_costs: VerificationCosts::default(),
                marks_omitted: 0,
                marks: Vec::new(),
            },
        );
        records.push_back(record);
    }
}

/// Feature-gated harness readback only. Missing/omitted records prove no completion.
pub fn qualification_psx_preparation_diagnostics(operation_id: &str) -> serde_json::Value {
    let mut selected = Vec::new();
    let mut available = true;
    if let Ok(mut records) = RECORDS.try_lock() {
        let mut retained = VecDeque::new();
        while let Some(record) = records.pop_front() {
            if record.operation_id == operation_id {
                selected.push(record);
            } else {
                retained.push_back(record);
            }
        }
        *records = retained;
    } else {
        available = false;
    }
    serde_json::json!({"available": available, "records": selected,
        "records_omitted_global": OMITTED.load(Ordering::Relaxed),
        "qualification": "not granted by diagnostics"})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maximum_diagnostic_records_fit_the_existing_projection_budget() {
        let mut trace = Trace::new(&"\0".repeat(128), "generation_entry");
        for _ in 0..MAX_MARKS {
            trace.phase("preparation_contracts");
        }
        trace.record.elapsed_ms = u64::MAX;
        trace.record.entries = u64::MAX;
        trace.record.files_hashed = u64::MAX;
        trace.record.bytes_hashed = u64::MAX;
        trace.record.hashing_ms = u64::MAX;
        trace.record.marks_omitted = u64::MAX;
        for cost in [
            &mut trace.record.verification_costs.ancestry,
            &mut trace.record.verification_costs.checked_open,
            &mut trace.record.verification_costs.content_open,
            &mut trace.record.verification_costs.metadata_open,
            &mut trace.record.verification_costs.metadata,
            &mut trace.record.verification_costs.identity,
            &mut trace.record.verification_costs.canonical_name,
            &mut trace.record.verification_costs.content,
            &mut trace.record.verification_costs.final_fence,
        ] {
            cost.calls = u64::MAX;
            cost.nanos = u64::MAX;
        }
        for mark in &mut trace.record.marks {
            mark.elapsed_ms = u64::MAX;
        }
        let records = vec![&trace.record; MAX_RECORDS];
        // The outer receipt retains both stdout diagnostics and output. Reserve
        // room in its unchanged64-KiB projection for both copies and events.
        assert!(serde_json::to_vec(&records).unwrap().len() < 24 * 1024);
        trace.record.operation_id.clear();
    }

    #[test]
    fn unfinished_trace_retains_fixed_counters_and_bounded_marks() {
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut trace = Trace::new(&id, "test");
            for _ in 0..40 {
                trace.phase("enumeration");
            }
            trace.entries(3);
            trace.hashing();
            trace.hashed(123, Instant::now());
            trace.hashing();
            // No complete call: represent an error during the next hash.
        }
        let output = qualification_psx_preparation_diagnostics(&id);
        let records = output["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["completed"], false);
        assert_eq!(records[0]["phase"], "file_hashing");
        assert_eq!(records[0]["files_hashed"], 1);
        assert_eq!(records[0]["bytes_hashed"], 123);
        assert_eq!(records[0]["entries"], 3);
        assert_eq!(records[0]["marks"].as_array().unwrap().len(), MAX_MARKS);
        assert_eq!(records[0]["marks_omitted"], 32);
        assert!(
            qualification_psx_preparation_diagnostics(&id)["records"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}

// Thread-local aggregate costs contain no paths, bytes or execution authority.
// Inclusive scopes are reported separately; their times must not be summed.
#[derive(Clone, Default, Serialize)]
pub(crate) struct VerificationCosts {
    pub(crate) ancestry: Cost,
    pub(crate) checked_open: Cost,
    pub(crate) content_open: Cost,
    pub(crate) metadata_open: Cost,
    pub(crate) metadata: Cost,
    pub(crate) identity: Cost,
    pub(crate) canonical_name: Cost,
    pub(crate) content: Cost,
    pub(crate) final_fence: Cost,
}
#[derive(Clone, Default, Serialize)]
pub(crate) struct Cost {
    pub(crate) calls: u64,
    nanos: u64,
}
thread_local! {
    static COSTS: std::cell::RefCell<VerificationCosts> = std::cell::RefCell::new(VerificationCosts::default());
}
pub(crate) struct CostScope {
    started: Instant,
    select: fn(&mut VerificationCosts) -> &mut Cost,
}
pub(crate) fn cost(select: fn(&mut VerificationCosts) -> &mut Cost) -> CostScope {
    CostScope {
        started: Instant::now(),
        select,
    }
}
impl Drop for CostScope {
    fn drop(&mut self) {
        COSTS.with(|costs| {
            let mut costs = costs.borrow_mut();
            let value = (self.select)(&mut costs);
            value.calls = value.calls.saturating_add(1);
            value.nanos = value.nanos.saturating_add(
                u64::try_from(self.started.elapsed().as_nanos()).unwrap_or(u64::MAX),
            );
        });
    }
}
#[cfg(test)]
pub(crate) fn take_costs() -> VerificationCosts {
    COSTS.with(|costs| std::mem::take(&mut *costs.borrow_mut()))
}

fn current_costs() -> VerificationCosts {
    COSTS.with(|costs| costs.borrow().clone())
}
impl VerificationCosts {
    fn since(mut self, before: &Self) -> Self {
        for (value, previous) in [
            (&mut self.ancestry, &before.ancestry),
            (&mut self.checked_open, &before.checked_open),
            (&mut self.content_open, &before.content_open),
            (&mut self.metadata_open, &before.metadata_open),
            (&mut self.metadata, &before.metadata),
            (&mut self.identity, &before.identity),
            (&mut self.canonical_name, &before.canonical_name),
            (&mut self.content, &before.content),
            (&mut self.final_fence, &before.final_fence),
        ] {
            value.calls = value.calls.saturating_sub(previous.calls);
            value.nanos = value.nanos.saturating_sub(previous.nanos);
        }
        self
    }
}
