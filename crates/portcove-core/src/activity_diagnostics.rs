//! Bounded, redacted tool output owned by the existing activity ledger.
#[cfg(test)]
use std::cell::Cell;
use std::sync::{Arc, Mutex};

use rusqlite::params;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Library, PortcoveError, Result, redact_diagnostic_text};

const STREAM_LIMIT: usize = 2 * 1024 * 1024;
const RETAINED_LIMIT: i64 = 64 * 1024 * 1024;

#[cfg(test)]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct DiagnosticWorkCounts {
    capture_clones: usize,
    redactions: usize,
    serializations: usize,
    database_writes: usize,
}

#[cfg(test)]
thread_local! {
    static DIAGNOSTIC_WORK: Cell<DiagnosticWorkCounts> = Cell::new(DiagnosticWorkCounts::default());
}

#[cfg(test)]
fn count_work(update: impl FnOnce(&mut DiagnosticWorkCounts)) {
    DIAGNOSTIC_WORK.with(|work| {
        let mut counts = work.get();
        update(&mut counts);
        work.set(counts);
    });
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DiagnosticStream {
    pub text: String,
    pub observed_bytes: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ActivityDiagnostic {
    pub activity_id: String,
    pub phase: String,
    pub stdout: DiagnosticStream,
    pub stderr: DiagnosticStream,
    /// Both streams reached EOF and the process owner recorded the final capture.
    pub complete: bool,
    pub updated_at: i64,
    pub stream_limit_bytes: u64,
}

#[derive(Default, Clone)]
struct StreamBuffer {
    bytes: Vec<u8>,
    observed: u64,
    closed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct StreamRevision {
    observed: u64,
    retained: usize,
    closed: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DiagnosticRevision {
    phase: String,
    final_capture: bool,
    streams: [StreamRevision; 2],
}

#[derive(Clone, Default)]
pub(crate) struct DiagnosticCapture(Arc<Mutex<[StreamBuffer; 2]>>);

impl DiagnosticCapture {
    pub(crate) fn record(&self, stream: usize, bytes: &[u8]) -> Result<()> {
        let mut streams = self
            .0
            .lock()
            .map_err(|_| PortcoveError::state("setup diagnostic capture is unavailable"))?;
        let buffer = &mut streams[stream];
        buffer.observed = buffer.observed.saturating_add(bytes.len() as u64);
        let count = bytes
            .len()
            .min(STREAM_LIMIT.saturating_sub(buffer.bytes.len()));
        buffer.bytes.extend_from_slice(&bytes[..count]);
        Ok(())
    }

    pub(crate) fn close(&self, stream: usize) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| PortcoveError::state("setup diagnostic capture is unavailable"))?
            [stream]
            .closed = true;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn snapshot(
        &self,
        activity_id: &str,
        phase: &str,
        final_capture: bool,
    ) -> Result<ActivityDiagnostic> {
        Ok(self
            .snapshot_if_changed(activity_id, phase, final_capture, None)?
            .expect("an unconditional diagnostic snapshot is always projected")
            .1)
    }

    pub(crate) fn snapshot_if_changed(
        &self,
        activity_id: &str,
        phase: &str,
        final_capture: bool,
        previous: Option<&DiagnosticRevision>,
    ) -> Result<Option<(DiagnosticRevision, ActivityDiagnostic)>> {
        // Clone bounded bytes under the lock, then decode/redact outside it so
        // persistence and redaction cannot block the pipe readers.
        let guard = self
            .0
            .lock()
            .map_err(|_| PortcoveError::state("setup diagnostic capture is unavailable"))?;
        let revisions = guard.each_ref().map(|stream| StreamRevision {
            observed: stream.observed,
            retained: stream.bytes.len(),
            closed: stream.closed,
        });
        if previous.is_some_and(|prior| {
            prior.phase == phase
                && prior.final_capture == final_capture
                && prior.streams == revisions
        }) {
            return Ok(None);
        }
        let streams = guard.clone();
        drop(guard);
        #[cfg(test)]
        count_work(|counts| counts.capture_clones += 1);
        let project = |stream: &StreamBuffer| DiagnosticStream {
            // Re-project the entire retained stream on every snapshot. Markers,
            // quoted values and UTF-8 characters may cross arbitrary reads.
            text: {
                #[cfg(test)]
                count_work(|counts| counts.redactions += 1);
                redact_diagnostic_text(&String::from_utf8_lossy(&stream.bytes))
            },
            observed_bytes: stream.observed,
            truncated: stream.observed > stream.bytes.len() as u64,
        };
        let revision = DiagnosticRevision {
            phase: phase.into(),
            final_capture,
            streams: revisions,
        };
        let snapshot = ActivityDiagnostic {
            activity_id: activity_id.into(),
            phase: phase.into(),
            stdout: project(&streams[0]),
            stderr: project(&streams[1]),
            complete: final_capture && streams.iter().all(|stream| stream.closed),
            updated_at: Library::now(),
            stream_limit_bytes: STREAM_LIMIT as u64,
        };
        Ok(Some((revision, snapshot)))
    }
}

impl Library {
    /// Read one activity's captures in phase-start order; normal activity lists
    /// never load large tool output. No caller-supplied filesystem path is used.
    pub fn activity_diagnostic(&self, activity_id: &str) -> Result<Vec<ActivityDiagnostic>> {
        let connection = self.connection()?;
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM activity_history WHERE id=?1)",
            [activity_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(PortcoveError::not_found(
                "the requested activity is no longer retained",
            ));
        }
        let mut statement = connection.prepare(
            "SELECT phase,payload FROM activity_diagnostics WHERE activity_id=?1 ORDER BY rowid",
        )?;
        let rows = statement.query_map([activity_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (phase, json) = row?;
            let invalid = || {
                PortcoveError::state("the retained diagnostic capture could not be read")
                    .detail("activity_id", activity_id)
            };
            let capture: ActivityDiagnostic = serde_json::from_str(&json).map_err(|_| invalid())?;
            if capture.activity_id != activity_id || capture.phase != phase {
                return Err(invalid());
            }
            Ok(capture)
        })
        .collect()
    }

    pub(crate) fn record_activity_diagnostic(&self, capture: &ActivityDiagnostic) -> Result<()> {
        self.record_activity_diagnostic_with_limit(capture, RETAINED_LIMIT)
    }

    fn record_activity_diagnostic_with_limit(
        &self,
        capture: &ActivityDiagnostic,
        retained_limit: i64,
    ) -> Result<()> {
        let payload = serde_json::to_string(capture)?;
        #[cfg(test)]
        count_work(|counts| counts.serializations += 1);
        let mut connection = self.connection()?;
        connection.busy_timeout(std::time::Duration::from_millis(250))?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "INSERT INTO activity_diagnostics(activity_id,payload,updated_at,payload_bytes,phase)
             SELECT id,?2,?3,?4,?5 FROM activity_history WHERE id=?1 AND status='running' AND operation='prepare'
             ON CONFLICT(activity_id,phase) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,payload_bytes=excluded.payload_bytes",
            params![capture.activity_id, payload, capture.updated_at, payload.len() as i64, capture.phase],
        )?;
        #[cfg(test)]
        count_work(|counts| counts.database_writes += 1);
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "diagnostic capture requires its running preparation activity",
            ));
        }
        let mut retained: i64 = transaction.query_row(
            "SELECT coalesce(sum(payload_bytes),0) FROM activity_diagnostics",
            [],
            |row| row.get(0),
        )?;
        if retained > retained_limit {
            let candidates = {
                let mut statement = transaction.prepare(
                    "SELECT d.activity_id,sum(d.payload_bytes) FROM activity_diagnostics AS d
                     JOIN activity_history AS a ON a.id=d.activity_id
                     WHERE a.status!='running' AND d.activity_id!=?1 GROUP BY d.activity_id ORDER BY min(d.updated_at),min(d.rowid)",
                )?;
                statement
                    .query_map([&capture.activity_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            };
            for (id, bytes) in candidates {
                if retained <= retained_limit {
                    break;
                }
                transaction.execute(
                    "DELETE FROM activity_diagnostics WHERE activity_id=?1",
                    [id],
                )?;
                retained -= bytes;
            }
            if retained > retained_limit {
                return Err(PortcoveError::state(
                    "running diagnostic captures reached the library retention limit",
                ));
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActivityOperation, ActivityStatus, ActivityTargetKind};

    fn activity(library: &Library) -> String {
        library
            .begin_activity(
                ActivityOperation::Prepare,
                ActivityTargetKind::Port,
                Some("owned"),
            )
            .unwrap()
            .id
    }

    #[test]
    fn counted_idle_capture_skips_unchanged_work() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let id = activity(&library);
        let capture = DiagnosticCapture::default();
        DIAGNOSTIC_WORK.with(|work| work.set(DiagnosticWorkCounts::default()));
        let mut revision = None;
        let mut skipped = 0;
        let mut publish = |final_capture| {
            if let Some((next, snapshot)) = capture
                .snapshot_if_changed(&id, "preparation.setup", final_capture, revision.as_ref())
                .unwrap()
            {
                library.record_activity_diagnostic(&snapshot).unwrap();
                revision = Some(next);
            } else {
                skipped += 1;
            }
        };
        publish(false);
        for _ in 0..3 {
            publish(false);
        }
        capture.record(0, b"progress\n").unwrap();
        publish(false);
        capture.close(0).unwrap();
        capture.close(1).unwrap();
        publish(true);
        let counts = DIAGNOSTIC_WORK.with(Cell::get);
        println!(
            "revision-aware diagnostic work: {counts:?}; skipped: {skipped}; heartbeat_writes: 0"
        );
        assert_eq!(
            counts,
            DiagnosticWorkCounts {
                capture_clones: 3,
                redactions: 6,
                serializations: 3,
                database_writes: 3,
            }
        );
        assert_eq!(skipped, 3);
        assert!(library.activity_diagnostic(&id).unwrap()[0].complete);
    }

    #[test]
    fn revision_covers_saturation_closure_phase_and_final_state() {
        let capture = DiagnosticCapture::default();
        capture.record(0, &vec![b'x'; STREAM_LIMIT]).unwrap();
        let (mut revision, first) = capture
            .snapshot_if_changed("owned", "preparation.setup", false, None)
            .unwrap()
            .unwrap();
        assert!(!first.stdout.truncated);
        assert!(
            capture
                .snapshot_if_changed("owned", "preparation.setup", false, Some(&revision))
                .unwrap()
                .is_none()
        );

        capture.record(0, b"beyond retained limit").unwrap();
        let (next, saturated) = capture
            .snapshot_if_changed("owned", "preparation.setup", false, Some(&revision))
            .unwrap()
            .unwrap();
        assert!(saturated.stdout.truncated);
        assert!(saturated.stdout.observed_bytes > first.stdout.observed_bytes);
        revision = next;
        capture.close(0).unwrap();
        revision = capture
            .snapshot_if_changed("owned", "preparation.setup", false, Some(&revision))
            .unwrap()
            .unwrap()
            .0;
        capture.close(1).unwrap();
        let (next, closed) = capture
            .snapshot_if_changed("owned", "preparation.setup", false, Some(&revision))
            .unwrap()
            .unwrap();
        assert!(!closed.complete);
        revision = next;
        let (next, changed_phase) = capture
            .snapshot_if_changed("owned", "preparation.extract", false, Some(&revision))
            .unwrap()
            .unwrap();
        assert_eq!(changed_phase.phase, "preparation.extract");
        let (final_revision, final_capture) = capture
            .snapshot_if_changed("owned", "preparation.extract", true, Some(&next))
            .unwrap()
            .unwrap();
        assert!(final_capture.complete);
        assert!(
            capture
                .snapshot_if_changed("owned", "preparation.extract", true, Some(&final_revision))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn phase_snapshots_preserve_previous_output_and_reject_mismatched_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let id = activity(&library);
        let conversion = DiagnosticCapture::default();
        conversion.record(0, b"earlier conversion output").unwrap();
        conversion.close(0).unwrap();
        conversion.close(1).unwrap();
        let first = conversion
            .snapshot(&id, "preparation.extract", true)
            .unwrap();
        library.record_activity_diagnostic(&first).unwrap();
        let setup = DiagnosticCapture::default();
        let initial = setup.snapshot(&id, "preparation.setup", false).unwrap();
        library.record_activity_diagnostic(&initial).unwrap();
        setup.record(1, b"later setup failure").unwrap();
        let latest = setup.snapshot(&id, "preparation.setup", false).unwrap();
        library.record_activity_diagnostic(&latest).unwrap();
        let reopened = Library::open(library.root()).unwrap();
        assert_eq!(
            reopened.activity_diagnostic(&id).unwrap(),
            vec![first, latest.clone()]
        );
        let mut mismatched = latest;
        mismatched.activity_id = "a different activity".into();
        reopened.connection().unwrap().execute(
            "UPDATE activity_diagnostics SET payload=?2 WHERE activity_id=?1 AND phase='preparation.setup'",
            params![id, serde_json::to_string(&mismatched).unwrap()],
        ).unwrap();
        assert!(reopened.activity_diagnostic(&id).is_err());
        assert_eq!(reopened.activities(1).unwrap()[0].id, id);
    }

    #[test]
    fn capture_redacts_split_markers_quoted_lines_and_utf8_before_every_snapshot() {
        let capture = DiagnosticCapture::default();
        let input = "safe password=\"fixture-private\nsecond-secret-line\" tail \u{03bb}\nBearer fixture-bearer\n";
        for byte in input.as_bytes() {
            capture.record(0, &[*byte]).unwrap();
            let view = capture
                .snapshot("owned", "preparation.setup", false)
                .unwrap();
            assert!(!view.stdout.text.contains("fixture-private"));
            assert!(!view.stdout.text.contains("second-secret-line"));
            assert!(!view.stdout.text.contains("fixture-bearer"));
            assert!(!view.complete);
        }
        capture.record(1, b"separate stderr").unwrap();
        capture.close(0).unwrap();
        capture.close(1).unwrap();
        let view = capture
            .snapshot("owned", "preparation.setup", true)
            .unwrap();
        assert!(view.complete);
        assert!(!view.stdout.truncated);
        assert!(view.stdout.text.contains("tail \u{03bb}"));
        assert_eq!(view.stderr.text, "separate stderr");
        assert_eq!(view.stdout.observed_bytes, input.len() as u64);
    }

    #[test]
    fn bounded_capture_drains_and_reports_omitted_output_without_losing_the_other_stream() {
        let capture = DiagnosticCapture::default();
        capture.record(0, &vec![b'x'; STREAM_LIMIT + 100]).unwrap();
        capture.record(1, b"stderr after a verbose stdout").unwrap();
        capture.close(0).unwrap();
        capture.close(1).unwrap();
        let view = capture
            .snapshot("owned", "preparation.setup", true)
            .unwrap();
        assert!(view.complete && view.stdout.truncated);
        assert_eq!(view.stdout.text.len(), STREAM_LIMIT);
        assert_eq!(view.stdout.observed_bytes, (STREAM_LIMIT + 100) as u64);
        assert_eq!(view.stderr.text, "stderr after a verbose stdout");
        assert!(!view.stderr.truncated);
    }

    #[test]
    fn incomplete_and_completed_diagnostics_survive_reconnect_without_eager_activity_payloads() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let id = activity(&library);
        let capture = DiagnosticCapture::default();
        capture
            .record(0, b"retained progress token=fixture-private")
            .unwrap();
        let partial = capture.snapshot(&id, "preparation.setup", false).unwrap();
        library.record_activity_diagnostic(&partial).unwrap();
        let reopened = Library::open(temporary.path()).unwrap();
        assert_eq!(reopened.activity_diagnostic(&id).unwrap(), vec![partial]);
        let stored: String = reopened
            .connection()
            .unwrap()
            .query_row(
                "SELECT payload FROM activity_diagnostics WHERE activity_id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("fixture-private"));
        assert!(
            !serde_json::to_string(&reopened.activities(1).unwrap())
                .unwrap()
                .contains("retained progress")
        );
        capture.record(1, b"exit 23").unwrap();
        capture.close(0).unwrap();
        capture.close(1).unwrap();
        let final_capture = capture.snapshot(&id, "preparation.setup", true).unwrap();
        reopened.record_activity_diagnostic(&final_capture).unwrap();
        reopened
            .finish_activity(&id, ActivityStatus::Failed, Some("setup failed"))
            .unwrap();
        assert_eq!(
            Library::open(temporary.path())
                .unwrap()
                .activity_diagnostic(&id)
                .unwrap(),
            vec![final_capture.clone()]
        );
        assert!(reopened.record_activity_diagnostic(&final_capture).is_err());
        assert_eq!(
            reopened.activity_diagnostic(&id).unwrap(),
            vec![final_capture]
        );
        let no_capture = activity(&reopened);
        assert_eq!(reopened.activity_diagnostic(&no_capture).unwrap(), vec![]);
        assert!(reopened.activity_diagnostic("../arbitrary-path").is_err());
    }

    #[test]
    fn retention_removes_only_old_terminal_logs_and_follows_activity_deletion() {
        const FIXTURE_STREAM_BYTES: usize = 16 * 1024;
        const FIXTURE_RETAINED_LIMIT: i64 = 48 * 1024;

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let running = activity(&library);
        let small = DiagnosticCapture::default();
        small.record(0, b"running work must remain").unwrap();
        library
            .record_activity_diagnostic_with_limit(
                &small
                    .snapshot(&running, "preparation.setup", false)
                    .unwrap(),
                FIXTURE_RETAINED_LIMIT,
            )
            .unwrap();
        let large = DiagnosticCapture::default();
        large.record(0, &vec![b'x'; FIXTURE_STREAM_BYTES]).unwrap();
        large.record(1, &vec![b'y'; FIXTURE_STREAM_BYTES]).unwrap();
        large.close(0).unwrap();
        large.close(1).unwrap();
        let mut ids = Vec::new();
        let mut snapshot = large
            .snapshot("retention-fixture", "preparation.setup", true)
            .unwrap();
        for _ in 0..3 {
            let id = activity(&library);
            snapshot.activity_id = id.clone();
            library
                .record_activity_diagnostic_with_limit(
                    &small.snapshot(&id, "preparation.extract", true).unwrap(),
                    FIXTURE_RETAINED_LIMIT,
                )
                .unwrap();
            library
                .record_activity_diagnostic_with_limit(&snapshot, FIXTURE_RETAINED_LIMIT)
                .unwrap();
            library
                .finish_activity(&id, ActivityStatus::Failed, Some("failed setup"))
                .unwrap();
            ids.push(id);
        }
        assert!(library.activity_diagnostic(&ids[0]).unwrap().is_empty());
        assert!(
            !library
                .activity_diagnostic(ids.last().unwrap())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            library
                .activity_diagnostic(ids.last().unwrap())
                .unwrap()
                .len(),
            2
        );
        assert!(!library.activity_diagnostic(&running).unwrap().is_empty());
        assert_eq!(library.activities(50).unwrap().len(), 4);
        let connection = library.connection().unwrap();
        let retained: i64 = connection
            .query_row(
                "SELECT sum(payload_bytes) FROM activity_diagnostics",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(retained <= FIXTURE_RETAINED_LIMIT);
        connection
            .execute("DELETE FROM activity_history WHERE id=?1", [&running])
            .unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM activity_diagnostics WHERE activity_id=?1",
                [&running],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn running_capture_quota_failure_preserves_all_prior_snapshots() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let capture = DiagnosticCapture::default();
        // JSON escaping makes this a large but valid bounded stream capture.
        capture.record(0, &vec![0; STREAM_LIMIT]).unwrap();
        capture.record(1, &vec![0; STREAM_LIMIT]).unwrap();
        let mut snapshot = capture
            .snapshot("quota-fixture", "preparation.setup", false)
            .unwrap();
        let first = activity(&library);
        let second = activity(&library);
        let denied = activity(&library);
        for id in [&first, &second] {
            snapshot.activity_id = id.clone();
            library.record_activity_diagnostic(&snapshot).unwrap();
        }
        snapshot.activity_id = denied.clone();
        assert!(library.record_activity_diagnostic(&snapshot).is_err());
        assert!(library.activity_diagnostic(&denied).unwrap().is_empty());
        assert!(!library.activity_diagnostic(&first).unwrap().is_empty());
        assert!(!library.activity_diagnostic(&second).unwrap().is_empty());
        let count: i64 = library
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM activity_diagnostics", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
    }
}
