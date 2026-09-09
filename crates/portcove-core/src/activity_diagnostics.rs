//! Bounded, redacted tool output owned by the existing activity ledger.
use std::sync::{Arc, Mutex};

use rusqlite::{OptionalExtension, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Library, PortcoveError, Result, redact_diagnostic_text};

const STREAM_LIMIT: usize = 2 * 1024 * 1024;
const RETAINED_LIMIT: i64 = 64 * 1024 * 1024;

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

    pub(crate) fn snapshot(
        &self,
        activity_id: &str,
        final_capture: bool,
    ) -> Result<ActivityDiagnostic> {
        // Clone bounded bytes under the lock, then decode/redact outside it so
        // persistence and redaction cannot block the pipe readers.
        let streams = self
            .0
            .lock()
            .map_err(|_| PortcoveError::state("setup diagnostic capture is unavailable"))?
            .clone();
        let project = |stream: &StreamBuffer| DiagnosticStream {
            // Re-project the entire retained stream on every snapshot. Markers,
            // quoted values and UTF-8 characters may cross arbitrary reads.
            text: redact_diagnostic_text(&String::from_utf8_lossy(&stream.bytes)),
            observed_bytes: stream.observed,
            truncated: stream.observed > stream.bytes.len() as u64,
        };
        Ok(ActivityDiagnostic {
            activity_id: activity_id.into(),
            phase: "preparation.setup".into(),
            stdout: project(&streams[0]),
            stderr: project(&streams[1]),
            complete: final_capture && streams.iter().all(|stream| stream.closed),
            updated_at: Library::now(),
            stream_limit_bytes: STREAM_LIMIT as u64,
        })
    }
}

impl Library {
    /// Read one explicitly requested diagnostic capture; normal activity lists
    /// never load large tool output. No caller-supplied filesystem path is used.
    pub fn activity_diagnostic(&self, activity_id: &str) -> Result<Option<ActivityDiagnostic>> {
        let stored: Option<Option<String>> = self
            .connection()?
            .query_row(
                "SELECT d.payload FROM activity_history AS a
             LEFT JOIN activity_diagnostics AS d ON d.activity_id=a.id WHERE a.id=?1",
                [activity_id],
                |row| row.get(0),
            )
            .optional()?;
        stored
            .ok_or_else(|| {
                PortcoveError::not_found("the requested activity is no longer retained")
            })?
            .map(|json| {
                serde_json::from_str(&json).map_err(|_| {
                    PortcoveError::state("the retained diagnostic capture could not be read")
                        .detail("activity_id", activity_id)
                })
            })
            .transpose()
    }

    pub(crate) fn record_activity_diagnostic(&self, capture: &ActivityDiagnostic) -> Result<()> {
        let payload = serde_json::to_string(capture)?;
        let mut connection = self.connection()?;
        connection.busy_timeout(std::time::Duration::from_millis(250))?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "INSERT INTO activity_diagnostics(activity_id,payload,updated_at)
             SELECT id,?2,?3 FROM activity_history WHERE id=?1 AND status='running' AND operation='prepare'
             ON CONFLICT(activity_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
            params![capture.activity_id, payload, capture.updated_at],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "diagnostic capture requires its running preparation activity",
            ));
        }
        let mut retained: i64 = transaction.query_row(
            "SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM activity_diagnostics",
            [],
            |row| row.get(0),
        )?;
        if retained > RETAINED_LIMIT {
            let candidates = {
                let mut statement = transaction.prepare(
                    "SELECT d.activity_id,length(CAST(d.payload AS BLOB)) FROM activity_diagnostics AS d
                     JOIN activity_history AS a ON a.id=d.activity_id
                     WHERE a.status!='running' AND d.activity_id!=?1 ORDER BY d.updated_at,d.rowid",
                )?;
                statement
                    .query_map([&capture.activity_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            };
            for (id, bytes) in candidates {
                if retained <= RETAINED_LIMIT {
                    break;
                }
                transaction.execute(
                    "DELETE FROM activity_diagnostics WHERE activity_id=?1",
                    [id],
                )?;
                retained -= bytes;
            }
            if retained > RETAINED_LIMIT {
                return Err(PortcoveError::state(
                    "running diagnostic captures reached the library retention limit",
                ));
            }
        }
        transaction.commit()?;
        Ok(())
    }
}
