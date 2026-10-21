//! Additional read budgets for an explicit support export. Ordinary activity
//! readers and retained capture limits remain owned by their existing APIs.
//! These connections perform no logical domain writes. SQLite may still create
//! or update its own WAL/SHM locking bookkeeping in the selected library.

use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags, limits::Limit, params};

use crate::{
    ActivityDiagnostic, ActivityRecord, Library, PortcoveError, Result,
    activity_diagnostics::decode_activity_diagnostic,
};

pub(crate) const SUPPORT_BUNDLE_ACTIVITY_LIMIT: usize = 100;
pub(crate) const SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES: usize = 128 * 1024;
pub(crate) const SUPPORT_BUNDLE_CAPTURE_LIMIT: usize = 32;
pub(crate) const SUPPORT_BUNDLE_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

// SQLite also accounts for the identity columns and record header. Their
// allowance must not reduce the admitted JSON payload budget at its boundary.
const CAPTURE_SQLITE_ROW_BYTES: usize =
    SUPPORT_BUNDLE_CAPTURE_BYTES + 2 * SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES + 1024;
const SQLITE_SIDECAR_SUFFIXES: [&str; 3] = ["-wal", "-shm", "-journal"];

#[derive(Debug, Default)]
pub(crate) struct BoundedCaptures {
    pub(crate) captures: Vec<ActivityDiagnostic>,
    pub(crate) truncated: bool,
    /// Actual UTF-8 JSON bytes fetched, independent of stored `payload_bytes`.
    pub(crate) bytes_read: usize,
}

fn verify_database_identity(path: &Path, held: &File) -> Result<()> {
    let current = crate::external_runtime::open_single_link_file(path)?;
    if !crate::external_runtime::same_file(held, &current)? {
        return Err(PortcoveError::state(
            "the library database or sidecar changed during support collection",
        ));
    }
    Ok(())
}

fn admit_existing_sidecars(root: &Path) -> Result<Vec<(PathBuf, File)>> {
    let mut sidecars = Vec::with_capacity(SQLITE_SIDECAR_SUFFIXES.len());
    for suffix in SQLITE_SIDECAR_SUFFIXES {
        let path = root.join(format!("portcove.sqlite3{suffix}"));
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                let held = crate::external_runtime::open_single_link_file(&path)?;
                sidecars.push((path, held));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(sidecars)
}

fn verify_sidecar_identities(sidecars: &[(PathBuf, File)]) -> Result<()> {
    for (path, held) in sidecars {
        verify_database_identity(path, held)?;
    }
    Ok(())
}

fn support_read<T>(
    library: &Library,
    length_limit: usize,
    read: impl FnOnce(&mut Connection) -> Result<T>,
) -> Result<T> {
    // Diagnostics must not initialize a replacement database if the selected
    // library disappeared after startup. Hold a no-follow, single-link identity
    // across the SQLite read and refuse changed paths before accepting results.
    // Ordinary WAL writes may change contents without changing that identity.
    let path = library.root().join("portcove.sqlite3");
    let held = crate::external_runtime::open_single_link_file(&path)?;
    // Inspect only fixed SQLite-owned names. A read-only connection can touch
    // existing locking files, so admit them before SQLite can open them. Names
    // absent here may be created for ordinary SQLite bookkeeping.
    let sidecars = admit_existing_sidecars(library.root())?;
    let mut connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_millis(250))?;
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, length_limit as i32)?;
    verify_database_identity(&path, &held)?;
    verify_sidecar_identities(&sidecars)?;
    let result = read(&mut connection)?;
    verify_database_identity(&path, &held)?;
    verify_sidecar_identities(&sidecars)?;
    Ok(result)
}

fn length_limited(error: &rusqlite::Error) -> bool {
    error.sqlite_error_code() == Some(rusqlite::ErrorCode::TooBig)
}

impl Library {
    pub(crate) fn support_bundle_activities(&self) -> Result<Vec<ActivityRecord>> {
        support_read(self, SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES, |connection| {
            Self::activities_from(connection, SUPPORT_BUNDLE_ACTIVITY_LIMIT)
        })
    }

    /// Read a bounded prefix in the same phase-start order as the ordinary
    /// capture reader. Count/byte omissions are truncation; unavailable rows,
    /// malformed JSON and identity mismatches remain read failures.
    pub(crate) fn support_bundle_captures(
        &self,
        activity_id: &str,
        remaining_bytes: usize,
        max_records: usize,
    ) -> Result<BoundedCaptures> {
        if activity_id.len() > SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES {
            return Err(PortcoveError::usage(
                "the activity identity exceeds the support read limit",
            ));
        }
        let byte_limit = remaining_bytes.min(SUPPORT_BUNDLE_CAPTURE_BYTES);
        let record_limit = max_records.min(SUPPORT_BUNDLE_CAPTURE_LIMIT);
        support_read(self, CAPTURE_SQLITE_ROW_BYTES, |connection| {
            let transaction = connection.transaction()?;
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM activity_history WHERE id=?1)",
                [activity_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(PortcoveError::not_found(
                    "the requested activity is no longer retained",
                ));
            }

            // octet_length on a direct column reads its byte length without loading
            // its text. Keep admission and payload reads in one SQLite snapshot so
            // a concurrently updated capture cannot grow past the checked budget.
            let mut statement = transaction.prepare(
                "SELECT rowid,octet_length(phase),octet_length(payload)
             FROM activity_diagnostics WHERE activity_id=?1 ORDER BY rowid LIMIT ?2",
            )?;
            let mut rows = statement.query(params![activity_id, (record_limit + 1) as i64])?;
            let mut result = BoundedCaptures::default();
            loop {
                let row = match rows.next() {
                    Ok(Some(row)) => row,
                    Ok(None) => break,
                    Err(error) if length_limited(&error) => {
                        result.truncated = true;
                        break;
                    }
                    Err(error) => return Err(error.into()),
                };
                if result.captures.len() == record_limit {
                    result.truncated = true;
                    break;
                }
                let row_id: i64 = row.get(0)?;
                let phase_bytes: usize = row.get(1)?;
                let payload_bytes: usize = row.get(2)?;
                let remaining = byte_limit.saturating_sub(result.bytes_read);
                if phase_bytes > SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES || payload_bytes > remaining {
                    result.truncated = true;
                    break;
                }
                let payload = transaction.query_row(
                "SELECT phase,payload FROM activity_diagnostics WHERE rowid=?1 AND activity_id=?2",
                params![row_id, activity_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            );
                let (phase, json) = match payload {
                    Ok(payload) => payload,
                    Err(error) if length_limited(&error) => {
                        result.truncated = true;
                        break;
                    }
                    Err(error) => return Err(error.into()),
                };
                // Check the consuming UTF-8 view as well: a foreign SQLite text
                // encoding must not bypass the budget through byte conversion.
                if phase.len() > SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES || json.len() > remaining {
                    return Err(PortcoveError::state(
                        "the retained diagnostic capture exceeded its admitted byte length",
                    ));
                }
                let capture = decode_activity_diagnostic(activity_id, &phase, &json)?;
                result.bytes_read += json.len();
                result.captures.push(capture);
            }
            Ok(result)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DiagnosticStream, ErrorCode};

    fn activity(library: &Library, id: &str, started_at: i64) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO activity_history(id,operation,target_kind,status,started_at)
             VALUES(?1,'prepare','source','failed',?2)",
                params![id, started_at],
            )
            .unwrap();
    }

    fn capture(id: &str, phase: &str, text: &str) -> ActivityDiagnostic {
        ActivityDiagnostic {
            activity_id: id.into(),
            phase: phase.into(),
            stdout: DiagnosticStream {
                text: text.into(),
                observed_bytes: text.len() as u64,
                truncated: false,
            },
            stderr: DiagnosticStream {
                text: String::new(),
                observed_bytes: 0,
                truncated: false,
            },
            complete: true,
            updated_at: 1,
            stream_limit_bytes: 2 * 1024 * 1024,
        }
    }

    fn store(library: &Library, capture: &ActivityDiagnostic) -> usize {
        let payload = serde_json::to_string(capture).unwrap();
        library.connection().unwrap().execute(
            "INSERT INTO activity_diagnostics(activity_id,phase,payload,updated_at,payload_bytes)
             VALUES(?1,?2,?3,1,1)",
            params![capture.activity_id, capture.phase, payload],
        ).unwrap();
        payload.len()
    }

    #[test]
    fn support_activity_read_reuses_order_and_decoder_with_a_fixed_count_limit() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        for index in 0..SUPPORT_BUNDLE_ACTIVITY_LIMIT + 5 {
            activity(&library, &format!("activity-{index}"), index as i64);
        }
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE activity_history SET failure_json='not JSON' WHERE id='activity-104'",
                [],
            )
            .unwrap();
        let ordinary = library
            .activities(SUPPORT_BUNDLE_ACTIVITY_LIMIT + 5)
            .unwrap();
        let bounded = library.support_bundle_activities().unwrap();
        assert_eq!(bounded.len(), SUPPORT_BUNDLE_ACTIVITY_LIMIT);
        assert_eq!(bounded, ordinary[..SUPPORT_BUNDLE_ACTIVITY_LIMIT]);
        assert_eq!(ordinary.len(), SUPPORT_BUNDLE_ACTIVITY_LIMIT + 5);
        assert!(bounded[0].failure.is_some());
    }

    #[test]
    fn support_activity_size_limit_is_enforced_without_changing_the_ordinary_reader() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        activity(&library, "owned", 1);
        let message = "x".repeat(SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES + 1);
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE activity_history SET message=?1 WHERE id='owned'",
                [&message],
            )
            .unwrap();
        assert!(library.support_bundle_activities().is_err());
        assert_eq!(
            library.activities(1).unwrap()[0].message.as_ref(),
            Some(&message)
        );
    }

    #[test]
    fn capture_budget_uses_actual_utf8_bytes_in_phase_order() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        activity(&library, "owned", 1);
        let first = capture("owned", "preparation.z-first", &"\u{03bb}".repeat(128));
        let second = capture("owned", "preparation.a-second", "second");
        let third = capture("owned", "preparation.third", "third");
        let budget = store(&library, &first) + store(&library, &second);
        store(&library, &third);
        let bounded = library
            .support_bundle_captures("owned", budget, usize::MAX)
            .unwrap();
        assert_eq!(bounded.captures, [first.clone(), second.clone()]);
        assert_eq!(bounded.bytes_read, budget);
        assert!(bounded.truncated);
        assert_eq!(
            library.activity_diagnostic("owned").unwrap(),
            [first, second, third]
        );
    }

    #[test]
    fn oversize_capture_is_omitted_before_decode_without_changing_the_ordinary_reader() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        activity(&library, "owned", 1);
        let oversized = capture(
            "owned",
            "preparation.setup",
            &"x".repeat(SUPPORT_BUNDLE_CAPTURE_BYTES),
        );
        assert!(store(&library, &oversized) > SUPPORT_BUNDLE_CAPTURE_BYTES);
        let bounded = library
            .support_bundle_captures("owned", usize::MAX, usize::MAX)
            .unwrap();
        assert!(bounded.captures.is_empty());
        assert_eq!(bounded.bytes_read, 0);
        assert!(bounded.truncated);
        assert_eq!(library.activity_diagnostic("owned").unwrap(), [oversized]);

        // Even invalid JSON beyond the admission budget is never parsed.
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE activity_diagnostics SET payload='not JSON' WHERE activity_id='owned'",
                [],
            )
            .unwrap();
        let omitted = library.support_bundle_captures("owned", 1, 1).unwrap();
        assert!(omitted.truncated && omitted.captures.is_empty());
        assert!(library.activity_diagnostic("owned").is_err());
    }

    #[test]
    fn excess_capture_phases_are_truncation_and_the_ordinary_reader_retains_them() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        activity(&library, "owned", 1);
        for index in 0..SUPPORT_BUNDLE_CAPTURE_LIMIT + 1 {
            store(
                &library,
                &capture("owned", &format!("phase-{index}"), "small"),
            );
        }
        let bounded = library
            .support_bundle_captures("owned", usize::MAX, usize::MAX)
            .unwrap();
        assert_eq!(bounded.captures.len(), SUPPORT_BUNDLE_CAPTURE_LIMIT);
        assert!(bounded.truncated);
        assert_eq!(
            library.activity_diagnostic("owned").unwrap().len(),
            SUPPORT_BUNDLE_CAPTURE_LIMIT + 1
        );
    }

    #[test]
    fn corrupt_and_mismatched_captures_are_failures_in_both_readers() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        activity(&library, "owned", 1);
        store(&library, &capture("owned", "preparation.setup", "small"));
        let payloads = [
            "not JSON".to_owned(),
            serde_json::to_string(&capture("other", "preparation.setup", "small")).unwrap(),
            serde_json::to_string(&capture("owned", "other-phase", "small")).unwrap(),
        ];
        for payload in payloads {
            library
                .connection()
                .unwrap()
                .execute(
                    "UPDATE activity_diagnostics SET payload=?1 WHERE activity_id='owned'",
                    [payload],
                )
                .unwrap();
            let bounded = library
                .support_bundle_captures(
                    "owned",
                    SUPPORT_BUNDLE_CAPTURE_BYTES,
                    SUPPORT_BUNDLE_CAPTURE_LIMIT,
                )
                .unwrap_err();
            let ordinary = library.activity_diagnostic("owned").unwrap_err();
            assert_eq!(bounded.message, ordinary.message);
            assert_eq!(bounded.details, ordinary.details);
            assert_eq!(bounded.code, ErrorCode::State);
        }
    }

    #[test]
    fn exact_budget_and_zero_budgets_distinguish_empty_complete_and_omitted() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        activity(&library, "owned", 1);
        let empty = library.support_bundle_captures("owned", 0, 0).unwrap();
        assert!(!empty.truncated && empty.captures.is_empty());
        assert_eq!(
            library
                .support_bundle_captures("missing", 0, 0)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );

        let saved = capture("owned", "preparation.setup", "small");
        let bytes = store(&library, &saved);
        let exact = library.support_bundle_captures("owned", bytes, 1).unwrap();
        assert_eq!(exact.captures, [saved]);
        assert_eq!(exact.bytes_read, bytes);
        assert!(!exact.truncated);
        for (remaining, count) in [(0, 1), (bytes, 0), (bytes - 1, 1)] {
            let omitted = library
                .support_bundle_captures("owned", remaining, count)
                .unwrap();
            assert!(omitted.truncated && omitted.captures.is_empty());
            assert_eq!(omitted.bytes_read, 0);
        }
    }

    #[test]
    fn unavailable_and_corrupt_databases_are_read_failures_without_reinitialization() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let database = library.root().join("portcove.sqlite3");
        std::fs::remove_file(&database).unwrap();
        assert!(library.support_bundle_activities().is_err());
        assert!(library.support_bundle_captures("owned", 1024, 1).is_err());
        assert!(!database.exists());

        std::fs::write(&database, b"not a SQLite database").unwrap();
        assert!(library.support_bundle_activities().is_err());
        assert!(library.support_bundle_captures("owned", 1024, 1).is_err());
        assert_eq!(std::fs::read(&database).unwrap(), b"not a SQLite database");
    }

    fn populated_library(root: &Path, id: &str) -> Library {
        let library = Library::open(root).unwrap();
        activity(&library, id, 1);
        store(
            &library,
            &capture(id, "preparation.setup", "retained fixture output"),
        );
        library
    }

    fn assert_support_reads_refused(library: &Library, id: &str) {
        assert!(library.support_bundle_activities().is_err());
        assert!(
            library
                .support_bundle_captures(
                    id,
                    SUPPORT_BUNDLE_CAPTURE_BYTES,
                    SUPPORT_BUNDLE_CAPTURE_LIMIT
                )
                .is_err()
        );
    }

    #[test]
    fn support_reads_refuse_hard_linked_databases_without_touching_the_foreign_data() {
        let temporary = tempfile::tempdir().unwrap();
        let library = populated_library(&temporary.path().join("owned"), "owned");
        let foreign =
            populated_library(&temporary.path().join("foreign"), "foreign-private-canary");
        let database = library.root().join("portcove.sqlite3");
        let foreign_database = foreign.root().join("portcove.sqlite3");
        let before = std::fs::read(&foreign_database).unwrap();
        std::fs::remove_file(&database).unwrap();
        std::fs::hard_link(&foreign_database, &database).unwrap();
        assert_support_reads_refused(&library, "foreign-private-canary");
        assert_eq!(std::fs::read(&foreign_database).unwrap(), before);
    }

    #[test]
    fn support_reads_refuse_hard_linked_sidecars_before_touching_foreign_files() {
        for suffix in SQLITE_SIDECAR_SUFFIXES {
            let temporary = tempfile::tempdir().unwrap();
            let library = populated_library(&temporary.path().join("owned"), "owned");
            let foreign = temporary.path().join("foreign-private-file");
            let before = format!("private {suffix} bookkeeping canary");
            fs::write(&foreign, &before).unwrap();
            let sidecar = library.root().join(format!("portcove.sqlite3{suffix}"));
            if sidecar.exists() {
                fs::remove_file(&sidecar).unwrap();
            }
            fs::hard_link(&foreign, &sidecar).unwrap();
            let mut invoked = false;
            let result = support_read(&library, SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES, |_| {
                invoked = true;
                Ok(())
            });
            assert!(
                result.is_err() && !invoked,
                "unsafe {suffix} must fail admission before SQLite reads"
            );
            assert_support_reads_refused(&library, "owned");
            assert_eq!(fs::read(&foreign).unwrap(), before.as_bytes());
            assert_eq!(fs::read(&sidecar).unwrap(), before.as_bytes());
        }
    }

    #[cfg(unix)]
    #[test]
    fn support_reads_refuse_symlinked_and_dangling_sidecars_without_touching_foreign_files() {
        for suffix in SQLITE_SIDECAR_SUFFIXES {
            let temporary = tempfile::tempdir().unwrap();
            let library = populated_library(&temporary.path().join("owned"), "owned");
            let foreign = temporary.path().join("foreign-private-file");
            let before = format!("private {suffix} bookkeeping canary");
            fs::write(&foreign, &before).unwrap();
            let sidecar = library.root().join(format!("portcove.sqlite3{suffix}"));
            if sidecar.exists() {
                fs::remove_file(&sidecar).unwrap();
            }
            std::os::unix::fs::symlink(&foreign, &sidecar).unwrap();
            assert_support_reads_refused(&library, "owned");
            assert_eq!(fs::read(&foreign).unwrap(), before.as_bytes());
            fs::remove_file(&foreign).unwrap();
            assert_support_reads_refused(&library, "owned");
            assert!(
                fs::symlink_metadata(&sidecar)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
        }
    }

    #[test]
    fn support_read_rejects_replaced_existing_sidecar_before_accepting_results() {
        let temporary = tempfile::tempdir().unwrap();
        let library = populated_library(&temporary.path().join("owned"), "owned");
        let sidecar = library.root().join("portcove.sqlite3-journal");
        let original = library.root().join("original-owned-journal");
        fs::write(&sidecar, b"original owned sidecar").unwrap();
        let mut replaced = false;
        let result = support_read(&library, SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES, |_| {
            // This owned callback requires no SQL statement. It changes only
            // the pathname after admission, while both file identities remain
            // available for the result-acceptance check.
            fs::rename(&sidecar, &original)?;
            fs::write(&sidecar, b"replacement sidecar canary")?;
            replaced = true;
            Ok(())
        });
        assert!(replaced && result.is_err());
        assert_eq!(fs::read(&original).unwrap(), b"original owned sidecar");
        assert_eq!(fs::read(&sidecar).unwrap(), b"replacement sidecar canary");
    }

    #[cfg(unix)]
    #[test]
    fn support_reads_refuse_symlinked_databases_and_symlinked_library_ancestors() {
        let temporary = tempfile::tempdir().unwrap();
        let library = populated_library(&temporary.path().join("owned"), "owned");
        let foreign =
            populated_library(&temporary.path().join("foreign"), "foreign-private-canary");
        let database = library.root().join("portcove.sqlite3");
        let foreign_database = foreign.root().join("portcove.sqlite3");
        let before = std::fs::read(&foreign_database).unwrap();
        std::fs::remove_file(&database).unwrap();
        std::os::unix::fs::symlink(&foreign_database, &database).unwrap();
        assert_support_reads_refused(&library, "foreign-private-canary");

        std::fs::rename(library.root(), temporary.path().join("owned-original")).unwrap();
        std::os::unix::fs::symlink(foreign.root(), library.root()).unwrap();
        assert_support_reads_refused(&library, "foreign-private-canary");
        assert_eq!(std::fs::read(&foreign_database).unwrap(), before);
    }

    #[test]
    fn support_read_rejects_database_replacement_before_accepting_the_result() {
        let temporary = tempfile::tempdir().unwrap();
        let library = populated_library(&temporary.path().join("owned"), "owned");
        let foreign =
            populated_library(&temporary.path().join("foreign"), "foreign-private-canary");
        let database = library.root().join("portcove.sqlite3");
        let owned_original = library.root().join("owned-original.sqlite3");
        let mut replaced = false;
        let result = support_read(&library, SUPPORT_BUNDLE_ACTIVITY_ROW_BYTES, |connection| {
            let records = Library::activities_from(connection, SUPPORT_BUNDLE_ACTIVITY_LIMIT)?;
            if let Err(error) = std::fs::rename(&database, &owned_original) {
                #[cfg(windows)]
                if matches!(error.raw_os_error(), Some(5 | 32 | 33)) {
                    // The Windows SQLite handle can deny deletion/renaming;
                    // that also prevents the attempted identity replacement.
                    return Ok(records);
                }
                return Err(error.into());
            }
            std::fs::copy(foreign.root().join("portcove.sqlite3"), &database)?;
            replaced = true;
            Ok(records)
        });
        if replaced {
            assert!(
                result.is_err(),
                "a changed database path must invalidate collected records"
            );
            assert!(owned_original.exists());
        } else {
            #[cfg(windows)]
            assert_eq!(result.unwrap()[0].id, "owned");
            #[cfg(not(windows))]
            panic!("the owned fixture could not replace its database");
        }
        assert_eq!(
            foreign.activities(1).unwrap()[0].id,
            "foreign-private-canary"
        );
    }

    #[test]
    fn support_reads_observe_committed_wal_rows_without_replacing_the_database() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let writer = library.connection().unwrap();
        writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        writer.execute(
            "INSERT INTO activity_history(id,operation,target_kind,status,started_at) VALUES('wal-owned','prepare','source','failed',1)",
            [],
        ).unwrap();
        let saved = capture("wal-owned", "preparation.setup", "committed WAL output");
        let payload = serde_json::to_string(&saved).unwrap();
        writer.execute(
            "INSERT INTO activity_diagnostics(activity_id,phase,payload,updated_at,payload_bytes) VALUES('wal-owned','preparation.setup',?1,1,?2)",
            params![payload, payload.len()],
        ).unwrap();
        assert!(
            std::fs::metadata(library.root().join("portcove.sqlite3-wal"))
                .unwrap()
                .len()
                > 0
        );
        assert_eq!(
            library.support_bundle_activities().unwrap()[0].id,
            "wal-owned"
        );
        assert_eq!(
            library
                .support_bundle_captures(
                    "wal-owned",
                    SUPPORT_BUNDLE_CAPTURE_BYTES,
                    SUPPORT_BUNDLE_CAPTURE_LIMIT
                )
                .unwrap()
                .captures,
            [saved]
        );
    }
}
