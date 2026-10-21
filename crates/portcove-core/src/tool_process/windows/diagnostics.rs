//! Bounded observations only: none of these fields grants closure authority.
use super::{CLOSURE_BOUND, Identity};
use serde_json::{Value, json};
use std::time::Instant;

const IDENTITIES: usize = 16;
const EVENTS: usize = 8;

#[derive(Clone)]
pub(super) struct IdentitySample {
    total: usize,
    items: [Option<Identity>; IDENTITIES],
}

impl Default for IdentitySample {
    fn default() -> Self {
        Self {
            total: 0,
            items: [None; IDENTITIES],
        }
    }
}

impl IdentitySample {
    pub(super) fn push(&mut self, identity: Identity) {
        if self.total < IDENTITIES {
            self.items[self.total] = Some(identity);
        }
        self.total = self.total.saturating_add(1);
    }

    fn value(&self) -> Value {
        json!({
            "total": self.total,
            "truncated": self.total > IDENTITIES,
            "identities": self.items.iter().flatten().map(|id| json!({
                "pid": id.pid, "created_filetime": id.created.to_string()
            })).collect::<Vec<_>>()
        })
    }
}

#[derive(Clone, Copy, serde::Serialize)]
struct DebugEvent {
    sequence: u64,
    code: u32,
    pid: u32,
    thread_id: u32,
    before_closure_ms: Option<u64>,
    classified: bool,
    classified_closure_ms: Option<u64>,
    stop_handled: bool,
    after_stop_closure_ms: Option<u64>,
    observer_sample_us: Option<u64>,
    continuation: Option<i32>,
    continuation_succeeded: Option<bool>,
    continuation_error: Option<u32>,
    after_closure_ms: Option<u64>,
}

#[derive(Clone)]
pub(super) struct ClosureDiagnostics {
    next_sequence: u64,
    events: [Option<DebugEvent>; EVENTS],
    pub(super) nonsignaled: Option<IdentitySample>,
    pub(super) pending_debug: Option<IdentitySample>,
    deadline_latch_ms: Option<u64>,
    member_sample_ms: Option<u64>,
}

impl Default for ClosureDiagnostics {
    fn default() -> Self {
        Self {
            next_sequence: 0,
            events: [None; EVENTS],
            nonsignaled: None,
            pending_debug: None,
            deadline_latch_ms: None,
            member_sample_ms: None,
        }
    }
}

fn elapsed(deadline: Option<Instant>, now: Instant) -> Option<u64> {
    deadline
        .and_then(|end| end.checked_sub(CLOSURE_BOUND))
        .map(|start| {
            u64::try_from(now.saturating_duration_since(start).as_millis()).unwrap_or(u64::MAX)
        })
}

impl ClosureDiagnostics {
    pub(super) fn begin(
        &mut self,
        code: u32,
        pid: u32,
        thread_id: u32,
        deadline: Option<Instant>,
        now: Instant,
    ) -> u64 {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.events[(sequence % EVENTS as u64) as usize] = Some(DebugEvent {
            sequence,
            code,
            pid,
            thread_id,
            before_closure_ms: elapsed(deadline, now),
            classified: false,
            classified_closure_ms: None,
            stop_handled: false,
            after_stop_closure_ms: None,
            observer_sample_us: None,
            continuation: None,
            continuation_succeeded: None,
            continuation_error: None,
            after_closure_ms: None,
        });
        sequence
    }

    pub(super) fn classified(
        &mut self,
        sequence: u64,
        continuation: i32,
        deadline: Option<Instant>,
        now: Instant,
    ) {
        if let Some(event) = self.events[(sequence % EVENTS as u64) as usize].as_mut()
            && event.sequence == sequence
        {
            event.classified = true;
            event.continuation = Some(continuation);
            event.classified_closure_ms = elapsed(deadline, now);
        }
    }

    pub(super) fn stop_handled(&mut self, sequence: u64, deadline: Option<Instant>, now: Instant) {
        if let Some(event) = self.events[(sequence % EVENTS as u64) as usize].as_mut()
            && event.sequence == sequence
        {
            event.stop_handled = true;
            event.after_stop_closure_ms = elapsed(deadline, now);
        }
    }

    pub(super) fn members(
        &mut self,
        nonsignaled: IdentitySample,
        pending: IdentitySample,
        deadline: Option<Instant>,
        now: Instant,
    ) {
        self.nonsignaled = Some(nonsignaled);
        self.pending_debug = Some(pending);
        self.member_sample_ms = elapsed(deadline, now);
    }

    pub(super) fn sample_timing(&mut self, sequence: u64, microseconds: u64) {
        if let Some(event) = self.events[(sequence % EVENTS as u64) as usize].as_mut()
            && event.sequence == sequence
        {
            event.observer_sample_us = Some(microseconds);
        }
    }

    pub(super) fn continued(
        &mut self,
        sequence: u64,
        continuation: i32,
        error: Option<u32>,
        deadline: Option<Instant>,
        now: Instant,
    ) {
        // A delayed completion cannot overwrite a newer ring occupant.
        if let Some(event) = self.events[(sequence % EVENTS as u64) as usize].as_mut()
            && event.sequence == sequence
        {
            event.continuation = Some(continuation);
            event.continuation_succeeded = Some(error.is_none());
            event.continuation_error = error;
            event.after_closure_ms = elapsed(deadline, now);
        }
    }

    pub(super) fn expired(&mut self, deadline: Option<Instant>, now: Instant) {
        if self.deadline_latch_ms.is_none() {
            self.deadline_latch_ms = elapsed(deadline, now);
        }
    }

    pub(super) fn fields(&self) -> [(&'static str, String); 3] {
        let mut events = self.events.iter().flatten().collect::<Vec<_>>();
        events.sort_by_key(|event| event.sequence);
        [
            (
                "process_tree_nonsignaled_members",
                self.nonsignaled
                    .as_ref()
                    .map(IdentitySample::value)
                    .unwrap_or(Value::Null)
                    .to_string(),
            ),
            (
                "process_tree_pending_debug_members",
                self.pending_debug
                    .as_ref()
                    .map(IdentitySample::value)
                    .unwrap_or(Value::Null)
                    .to_string(),
            ),
            (
                "process_tree_closure_trace",
                json!({"capacity":EVENTS,"recorded_events":self.next_sequence,
                "truncated":self.next_sequence>EVENTS as u64,"events":events,
                "deadline_latch_elapsed_ms":self.deadline_latch_ms,
                "member_sample_closure_elapsed_ms":self.member_sample_ms})
                .to_string(),
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn closure_diagnostics_distinguish_unknown_empty_and_truncated_identity_samples() {
        let mut diagnostic = ClosureDiagnostics::default();
        assert_eq!(diagnostic.fields()[0].1, "null");
        diagnostic.nonsignaled = Some(IdentitySample::default());
        let empty: Value = serde_json::from_str(&diagnostic.fields()[0].1).unwrap();
        assert_eq!(empty["total"], 0);
        assert_eq!(empty["truncated"], false);
        let mut sample = IdentitySample::default();
        for pid in 1..=20 {
            sample.push(Identity {
                pid,
                created: 134370148154127421 + u64::from(pid),
            });
        }
        diagnostic.pending_debug = Some(sample);
        let sample: Value = serde_json::from_str(&diagnostic.fields()[1].1).unwrap();
        assert_eq!(sample["total"], 20);
        assert_eq!(sample["truncated"], true);
        assert_eq!(sample["identities"].as_array().unwrap().len(), 16);
        assert_eq!(
            sample["identities"][0]["created_filetime"],
            "134370148154127422"
        );
    }

    #[test]
    fn closure_diagnostics_bound_event_order_and_preserve_uncontinued_and_first_expiry() {
        let start = Instant::now();
        let deadline = start + CLOSURE_BOUND;
        let mut diagnostic = ClosureDiagnostics::default();
        let old = diagnostic.begin(3, 1, 2, None, start);
        for pid in 2..=10 {
            diagnostic.begin(5, pid, pid + 100, Some(deadline), start);
        }
        diagnostic.continued(old, 0x10002, None, Some(deadline), start);
        let latest = diagnostic.begin(5, 11, 111, Some(deadline), start);
        diagnostic.continued(
            latest,
            0x10002,
            Some(6),
            Some(deadline),
            start + Duration::from_millis(12),
        );
        diagnostic.expired(Some(deadline), deadline);
        diagnostic.expired(Some(deadline), deadline + CLOSURE_BOUND);
        let trace: Value = serde_json::from_str(&diagnostic.fields()[2].1).unwrap();
        assert_eq!(trace["recorded_events"], 11);
        assert_eq!(trace["truncated"], true);
        let events = trace["events"].as_array().unwrap();
        assert_eq!(events.len(), 8);
        assert_eq!(events[0]["sequence"], 3);
        assert_eq!(events[0]["continuation"], Value::Null);
        assert_eq!(events[7]["sequence"], 10);
        assert_eq!(events[7]["continuation_succeeded"], false);
        assert_eq!(events[7]["continuation_error"], 6);
        assert_eq!(events[7]["after_closure_ms"], 12);
        assert_eq!(trace["deadline_latch_elapsed_ms"], 2000);
    }
}
