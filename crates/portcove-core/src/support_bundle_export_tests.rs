use std::{cell::Cell, collections::BTreeMap, io::Cursor};

use serde_json::{Value, json};

use super::*;
use crate::{
    ActivityDiagnostic, ActivityOperation, ActivityStatus, ActivityTargetKind, DiagnosticStream,
    Library,
};

fn members(path: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut members = BTreeMap::new();
    for index in 0..archive.len() {
        let mut member = archive.by_index(index).unwrap();
        assert!(member.enclosed_name().is_some());
        let name = member.name().unwrap().into_owned();
        let mut bytes = Vec::new();
        member.read_to_end(&mut bytes).unwrap();
        assert!(
            members.insert(name, bytes).is_none(),
            "duplicate archive member"
        );
    }
    members
}

fn document(members: &BTreeMap<String, Vec<u8>>, name: &str) -> Value {
    serde_json::from_slice(members.get(name).unwrap()).unwrap()
}

fn section_for<'a>(manifest: &'a Value, kind: &str) -> &'a Value {
    manifest["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|section| section["kind"] == kind)
        .unwrap()
}

fn log_fixture(directory: &Path, message: &str) {
    fs::create_dir_all(directory).unwrap();
    let record = json!({
        "timestamp_ms": 1,
        "level": "ERROR",
        "target": "portcove_desktop::diagnostics",
        "fields": { "message": message },
    });
    fs::write(directory.join(LOG_NAME), format!("{record}\n")).unwrap();
}

#[test]
fn host_session_logs_export_typed_surfaces_before_legacy_and_omit_unselected_files() {
    let temporary = tempfile::tempdir().unwrap();
    let logs = temporary.path().join("logs");
    let mut originals = Vec::new();
    for (slot, surface, session) in [
        (0, "desktop", "9505cf6e-559d-4b40-a77e-d9176e6b426c"),
        (7, "cli", "7daf2f0b-df14-4f8c-a541-f06659acb3e9"),
    ] {
        let directory = logs.join(format!("session-{slot:02}"));
        fs::create_dir_all(&directory).unwrap();
        let record = json!({
            "schema_version": 1,
            "timestamp_ms": 42,
            "elapsed_ms": 3,
            "session_id": session,
            "process_id": 17,
            "surface": surface,
            "build": "0.1.0-alpha.2",
            "level": "INFO",
            "target": "portcove_host_diagnostics",
            "context_complete": true,
            "omitted_fields": 0,
            "spans": [],
            "error": null,
            "fields": {
                "component": "startup",
                "phase": "start",
                "success": false,
                "message": "host startup token=session-private-canary safe=visible"
            }
        });
        let path = directory.join(LOG_NAME);
        let bytes = format!("{record}\n").into_bytes();
        fs::write(&path, &bytes).unwrap();
        originals.push((path, bytes));
        for name in [
            ".portcove-session.json",
            "arbitrary.jsonl",
            "portcove-desktop.jsonl.6",
        ] {
            fs::write(directory.join(name), b"unselected-session-canary").unwrap();
        }
    }
    let malformed = logs.join("session-01");
    fs::create_dir(&malformed).unwrap();
    fs::write(
        malformed.join(LOG_NAME),
        b"{invalid\n{\"fields\":{\"message\":\"retained session record\"}}\n{\"partial\":\"trailing-session-canary",
    )
    .unwrap();
    log_fixture(&logs.join("session-08"), "outside-session-inventory-canary");
    log_fixture(&logs, "retained legacy host record");
    let exported = export_support_bundle(SupportBundleRequest {
        destination_dir: &temporary.path().join("exports"),
        logs_dir: Some(&logs),
        library: None,
        startup_failure: None,
    })
    .unwrap();
    let files = members(&exported.path);
    let manifest = document(&files, "manifest.json");
    let included: Vec<_> = manifest["sections"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|section| section["kind"] == "runtime_log" && section["entry"].is_string())
        .collect();
    assert_eq!(
        included
            .iter()
            .map(|section| section["entry"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "logs/session-00/portcove-desktop.jsonl",
            "logs/session-01/portcove-desktop.jsonl",
            "logs/session-07/portcove-desktop.jsonl",
            "logs/portcove-desktop.jsonl",
        ]
    );
    assert!(
        included[..3]
            .iter()
            .all(|section| section["provenance"] == "host_runtime_log")
    );
    assert_eq!(included[3]["provenance"], "desktop_runtime_log");
    assert_eq!(included[1]["status"], "partial");
    assert_eq!(
        included[1]["reasons"],
        json!(["invalid_record", "incomplete_record"])
    );
    for (name, surface, session) in [
        (
            "logs/session-00/portcove-desktop.jsonl",
            "desktop",
            "9505cf6e-559d-4b40-a77e-d9176e6b426c",
        ),
        (
            "logs/session-07/portcove-desktop.jsonl",
            "cli",
            "7daf2f0b-df14-4f8c-a541-f06659acb3e9",
        ),
    ] {
        let record = document(&files, name);
        assert_eq!(record["surface"], surface);
        assert_eq!(record["session_id"], session);
        assert_eq!(record["fields"]["success"], false);
        assert_eq!(record["context_complete"], true);
    }
    assert_eq!(
        manifest["sections"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|section| section["kind"] == "runtime_log")
            .count(),
        54
    );
    for bytes in files.values() {
        let text = String::from_utf8_lossy(bytes);
        for canary in [
            "session-private-canary",
            "unselected-session-canary",
            "outside-session-inventory-canary",
            "trailing-session-canary",
        ] {
            assert!(!text.contains(canary), "host export leaked {canary}");
        }
    }
    for (path, bytes) in originals {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn session_log_input_budget_bounds_invalid_record_scanning_across_all_slots() {
    let temporary = tempfile::tempdir().unwrap();
    let logs = temporary.path().join("logs");
    for slot in 0..8 {
        let directory = logs.join(format!("session-{slot:02}"));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(LOG_NAME), b"{\n".repeat(512)).unwrap();
    }
    log_fixture(
        &logs,
        "legacy input must remain uncollected after the input cap",
    );
    let limits = SupportBundleLimits {
        log_bytes: 128,
        log_input_bytes: 192,
        ..Default::default()
    };
    let exported = export(
        &temporary.path().join("exports"),
        Some(&logs),
        None,
        None,
        limits,
        &mut |_, _| Ok(()),
    )
    .unwrap();
    let files = members(&exported.path);
    let logs: Vec<_> = exported
        .manifest
        .sections
        .iter()
        .filter(|section| section.kind == SupportBundleSectionKind::RuntimeLog)
        .collect();
    assert_eq!(
        logs.iter()
            .filter_map(|section| section.bytes_read)
            .sum::<usize>(),
        192
    );
    assert!(
        logs.iter()
            .all(|section| section.bytes_read.unwrap_or(0) <= 128)
    );
    assert!(logs.iter().all(|section| section.records.unwrap_or(0) == 0));
    let stopped = logs.last().unwrap();
    assert_eq!(stopped.status, SupportBundleSectionStatus::Omitted);
    assert_eq!(stopped.reasons, [SupportBundleReason::SectionLimit]);
    assert!(!files.contains_key("logs/session-02/portcove-desktop.jsonl"));
    assert!(!files.contains_key("logs/portcove-desktop.jsonl"));
    assert_eq!(exported.manifest.limits.log_input_bytes, 192);
}

#[test]
fn unsafe_session_file_and_directory_candidates_preserve_available_legacy_logs() {
    let temporary = tempfile::tempdir().unwrap();
    let logs = temporary.path().join("logs");
    log_fixture(&logs, "retained safe legacy diagnostics");
    let private = temporary.path().join("private-file");
    fs::write(&private, b"private-session-link-canary\n").unwrap();
    let slot = logs.join("session-00");
    fs::create_dir(&slot).unwrap();
    fs::hard_link(&private, slot.join(LOG_NAME)).unwrap();
    fs::write(
        logs.join("session-01"),
        b"private-session-nondirectory-canary",
    )
    .unwrap();
    #[cfg(unix)]
    {
        let outside = temporary.path().join("outside-session");
        log_fixture(&outside, "private-session-directory-link-canary");
        std::os::unix::fs::symlink(&outside, logs.join("session-02")).unwrap();
    }
    let exported = export_support_bundle(SupportBundleRequest {
        destination_dir: &temporary.path().join("exports"),
        logs_dir: Some(&logs),
        library: None,
        startup_failure: None,
    })
    .unwrap();
    let files = members(&exported.path);
    assert!(files.contains_key("logs/portcove-desktop.jsonl"));
    assert!(!files.keys().any(|name| name.starts_with("logs/session-")));
    let unsafe_section = exported
        .manifest
        .sections
        .iter()
        .find(|section| {
            section.kind == SupportBundleSectionKind::RuntimeLog
                && section.reasons.contains(&SupportBundleReason::UnsafeFile)
        })
        .unwrap();
    assert_eq!(unsafe_section.status, SupportBundleSectionStatus::Omitted);
    assert_eq!(
        fs::read(&private).unwrap(),
        b"private-session-link-canary\n"
    );
    assert_eq!(
        fs::read(logs.join("session-01")).unwrap(),
        b"private-session-nondirectory-canary"
    );
    for bytes in files.values() {
        let text = String::from_utf8_lossy(bytes);
        assert!(!text.contains("private-session-"));
    }
}

#[test]
fn support_bundle_survives_unavailable_and_corrupt_library_with_host_diagnostics() {
    let temporary = tempfile::tempdir().unwrap();
    let logs = temporary.path().join("logs");
    log_fixture(
        &logs,
        "host diagnostics remain available token=runtime-private-canary",
    );
    let failure = PortcoveError::state("password=startup-private-canary")
        .detail("memo", "startup-context-canary")
        .report();
    let unavailable = export_support_bundle(SupportBundleRequest {
        destination_dir: &temporary.path().join("unavailable-export"),
        logs_dir: Some(&logs),
        library: None,
        startup_failure: Some(&failure),
    })
    .unwrap();
    let unavailable_members = members(&unavailable.path);
    let manifest = document(&unavailable_members, "manifest.json");
    assert_eq!(manifest["library_available"], false);
    for kind in ["doctor", "activities", "activity_capture"] {
        let section = section_for(&manifest, kind);
        assert_eq!(section["status"], "omitted");
        assert_eq!(section["reasons"], json!(["unavailable"]));
        assert!(section["entry"].is_null());
    }
    let startup = document(&unavailable_members, "startup.json");
    assert_eq!(startup["failure_code"], "state");
    assert_eq!(startup["failure_text_omitted"], true);
    assert!(
        String::from_utf8_lossy(&unavailable_members["logs/portcove-desktop.jsonl"])
            .contains("host diagnostics remain available")
    );

    let library = Library::open(temporary.path().join("library")).unwrap();
    let database = library.root().join("portcove.sqlite3");
    fs::write(&database, b"corrupt-database-private-canary").unwrap();
    let corrupt = export_support_bundle(SupportBundleRequest {
        destination_dir: &temporary.path().join("corrupt-export"),
        logs_dir: Some(&logs),
        library: Some(&library),
        startup_failure: Some(&failure),
    })
    .unwrap();
    let corrupt_members = members(&corrupt.path);
    let manifest = document(&corrupt_members, "manifest.json");
    assert_eq!(
        section_for(&manifest, "activities")["reasons"],
        json!(["read_failed"])
    );
    assert_eq!(
        section_for(&manifest, "activity_capture")["reasons"],
        json!(["capture_not_collected"])
    );
    assert_eq!(
        section_for(&manifest, "doctor")["reasons"],
        json!(["bounded_snapshot"])
    );
    let doctor = document(&corrupt_members, "doctor.json");
    for unknown in [
        "catalog_port_count",
        "installed_port_count",
        "registered_source_count",
        "repair_items",
        "host_tools",
    ] {
        assert!(doctor.get(unknown).unwrap().is_null());
    }
    assert!(corrupt_members.contains_key("startup.json"));
    assert!(corrupt_members.contains_key("logs/portcove-desktop.jsonl"));
    assert_eq!(
        fs::read(&database).unwrap(),
        b"corrupt-database-private-canary"
    );

    for bytes in unavailable_members.values().chain(corrupt_members.values()) {
        let exported = String::from_utf8_lossy(bytes);
        for canary in [
            "runtime-private-canary",
            "startup-private-canary",
            "startup-context-canary",
            "corrupt-database-private-canary",
        ] {
            assert!(
                !exported.contains(canary),
                "support archive leaked {canary}"
            );
        }
    }
}

fn activity_fixture() -> ActivityRecord {
    ActivityRecord {
        id: "activity-1".into(),
        operation: ActivityOperation::Prepare,
        target_kind: ActivityTargetKind::Source,
        target_id: Some("private-source-target-canary".into()),
        status: ActivityStatus::Failed,
        message: Some("setup failed token=activity-message-canary safe=visible".into()),
        failure: Some(
            PortcoveError::state("password=activity-error-canary")
                .detail("memo", "unmarked-activity-detail-canary")
                .report(),
        ),
        started_at: 1,
        finished_at: Some(2),
        cancellation: None,
    }
}

struct FailedSections;

impl Source for FailedSections {
    fn doctor(&self) -> Result<SupportBundleData> {
        Err(PortcoveError::state("unmarked-doctor-error-canary"))
    }

    fn activities(&self) -> Result<Vec<ActivityRecord>> {
        Ok(vec![activity_fixture()])
    }

    fn captures(&self, _: &str, _: usize, _: usize) -> Result<BoundedCaptures> {
        Err(PortcoveError::state("unmarked-capture-error-canary"))
    }
}

#[test]
fn doctor_and_capture_failures_preserve_independent_sections_and_closed_reasons() {
    let temporary = tempfile::tempdir().unwrap();
    let logs = temporary.path().join("logs");
    log_fixture(&logs, "host log survives independent section failures");
    let exported = export(
        &temporary.path().join("exports"),
        Some(&logs),
        Some(&FailedSections),
        None,
        SupportBundleLimits::default(),
        &mut |_, _| Ok(()),
    )
    .unwrap();
    let members = members(&exported.path);
    let manifest = document(&members, "manifest.json");
    for kind in ["doctor", "activity_capture"] {
        let section = section_for(&manifest, kind);
        assert_eq!(section["status"], "omitted");
        assert_eq!(section["reasons"], json!(["read_failed"]));
    }
    assert_eq!(
        document(&members, "activities.json")["activities"][0]["id"],
        "activity-1"
    );
    assert!(members.contains_key("startup.json"));
    assert!(members.contains_key("logs/portcove-desktop.jsonl"));
    for bytes in members.values() {
        let text = String::from_utf8_lossy(bytes);
        for canary in [
            "unmarked-doctor-error-canary",
            "unmarked-capture-error-canary",
            "private-source-target-canary",
            "activity-message-canary",
            "activity-error-canary",
            "unmarked-activity-detail-canary",
        ] {
            assert!(!text.contains(canary), "support archive leaked {canary}");
        }
    }
}

struct RepeatedFailedCaptures(Cell<usize>);

impl Source for RepeatedFailedCaptures {
    fn doctor(&self) -> Result<SupportBundleData> {
        FailedSections.doctor()
    }
    fn activities(&self) -> Result<Vec<ActivityRecord>> {
        Ok((0..100)
            .map(|index| {
                let mut activity = activity_fixture();
                activity.id = format!("activity-{index}");
                activity
            })
            .collect())
    }
    fn captures(&self, _: &str, bytes: usize, records: usize) -> Result<BoundedCaptures> {
        assert!(bytes <= SUPPORT_BUNDLE_CAPTURE_BYTES);
        assert!(records <= SUPPORT_BUNDLE_CAPTURE_LIMIT);
        self.0.set(self.0.get() + 1);
        // A real decoder may fail after reading a valid prefix; the caller
        // cannot count that failed attempt as zero input and restart its budget.
        Err(PortcoveError::state("invalid later capture"))
    }
}

#[test]
fn failed_capture_attempts_cannot_reset_the_aggregate_read_budget() {
    let temporary = tempfile::tempdir().unwrap();
    let source = RepeatedFailedCaptures(Cell::new(0));
    let exported = export(
        temporary.path(),
        None,
        Some(&source),
        None,
        SupportBundleLimits::default(),
        &mut |_, _| Ok(()),
    )
    .unwrap();
    assert_eq!(source.0.get(), 1);
    assert!(
        exported
            .manifest
            .sections
            .iter()
            .any(|section| section.reasons.contains(&SupportBundleReason::RecordLimit))
    );
    assert!(members(&exported.path).contains_key("activities.json"));
}

#[test]
fn real_database_archive_uses_closed_members_and_redacts_every_supported_diagnostic_surface() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("private-library-location-canary")).unwrap();
    let mut activity = activity_fixture();
    activity.id = "../../private-activity-member-name".into();
    activity
        .failure
        .as_mut()
        .unwrap()
        .presentation
        .technical_context
        .insert(
            "new_unknown_key".into(),
            "unmarked-technical-context-canary".into(),
        );
    let capture = ActivityDiagnostic {
        activity_id: activity.id.clone(),
        phase: "../../private-phase-member-name".into(),
        stdout: DiagnosticStream {
            text: "compiler progress token=capture-stdout-canary".into(),
            observed_bytes: 9_000_000,
            truncated: true,
        },
        stderr: DiagnosticStream {
            text: "Authorization: Bearer capture-stderr-canary".into(),
            observed_bytes: 100,
            truncated: false,
        },
        complete: false,
        updated_at: 3,
        stream_limit_bytes: 2 * 1024 * 1024,
    };
    {
        let connection = library.connection().unwrap();
        connection.execute(
            "INSERT INTO activity_history(id,operation,target_kind,target_id,status,message,started_at,finished_at,failure_json)
             VALUES(?1,'prepare','source',?2,'failed',?3,1,2,?4)",
            rusqlite::params![activity.id, activity.target_id, activity.message, serde_json::to_string(&activity.failure).unwrap()],
        ).unwrap();
        connection.execute(
            "INSERT INTO activity_diagnostics(activity_id,phase,payload,updated_at,payload_bytes) VALUES(?1,?2,?3,3,1)",
            rusqlite::params![capture.activity_id, capture.phase, serde_json::to_string(&capture).unwrap()],
        ).unwrap();
        connection.execute(
            "INSERT INTO sources(profile_id,path,sha256,size,updated_at) VALUES('private-source-inventory-canary','private-source-file-canary','private-source-checksum-canary',123,1)",
            [],
        ).unwrap();
    }
    for (name, bytes) in [
        ("game.rom", "private-game-file-canary"),
        ("credentials.json", "private-credential-file-canary"),
        ("environment.txt", "private-environment-file-canary"),
    ] {
        fs::write(library.root().join(name), bytes).unwrap();
    }
    let logs = temporary.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    let envelope = json!({
        "timestamp_ms": 42,
        "level": "ERROR",
        "target": "portcove_desktop::diagnostics",
        "memo": "unmarked-envelope-canary",
        "spans": [{ "memo": "unmarked-span-canary" }],
        "fields": {
            "message": "request failed token=runtime-text-canary safe=visible",
            "operation_id": "operation-1",
            "sequence": "7",
            "success": "false",
            "memo": "unmarked-field-canary",
            "unmarked-field-name-canary": "unmarked-field-value-canary",
            "event": { "memo": "unmarked-event-canary" },
            "error": { "additional": "unmarked-error-canary" },
            "target": { "id": "unmarked-target-canary" },
            "component_stack": "unmarked-frontend-canary",
            "environment": { "VALUE": "unmarked-environment-canary" },
            "library_root": "unmarked-location-canary",
            "url": "https://example.invalid/?signature=unmarked-query-canary",
            "Authorization": "unmarked-header-canary"
        }
    });
    fs::write(
        logs.join(LOG_NAME),
        format!("{envelope}\nlegacy progress password=legacy-secret-canary\n"),
    )
    .unwrap();
    for name in [
        "arbitrary-private-log.jsonl",
        "portcove-desktop.jsonl.6",
        "portcove.sqlite3",
    ] {
        fs::write(logs.join(name), "private-unselected-file-canary").unwrap();
    }
    let exported = export_support_bundle(SupportBundleRequest {
        destination_dir: &temporary.path().join("exports"),
        logs_dir: Some(&logs),
        library: Some(&library),
        startup_failure: None,
    })
    .unwrap();
    let members = members(&exported.path);
    assert_eq!(
        members.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "activities.json",
            "doctor.json",
            "logs/activity-0.json",
            "logs/portcove-desktop.jsonl",
            "manifest.json",
            "startup.json",
        ]
    );
    let manifest = document(&members, "manifest.json");
    let section = section_for(&manifest, "activity_capture");
    assert_eq!(section["status"], "partial");
    assert_eq!(
        section["reasons"],
        json!(["capture_incomplete", "capture_truncated"])
    );
    let captured = document(&members, "logs/activity-0.json");
    assert_eq!(captured[0]["complete"], false);
    assert_eq!(captured[0]["stdout"]["observed_bytes"], 9_000_000);
    assert_eq!(captured[0]["stdout"]["truncated"], true);
    assert!(
        captured[0]["stdout"]["text"]
            .as_str()
            .unwrap()
            .contains("compiler progress")
    );
    let activities = document(&members, "activities.json");
    assert!(activities["activities"][0]["target_id"].is_null());
    assert_eq!(activities["activities"][0]["target_id_omitted"], true);
    let runtime: Vec<Value> =
        serde_json::Deserializer::from_slice(&members["logs/portcove-desktop.jsonl"])
            .into_iter::<Value>()
            .map(|record| record.unwrap())
            .collect();
    assert_eq!(runtime[0]["fields"]["sequence"], 7);
    assert_eq!(runtime[0]["fields"]["success"], false);
    assert!(
        runtime[1]["legacy_text"]
            .as_str()
            .unwrap()
            .contains("legacy progress")
    );

    for bytes in members.values() {
        let text = String::from_utf8_lossy(bytes);
        for canary in [
            "private-library-location-canary",
            "private-source-target-canary",
            "activity-message-canary",
            "activity-error-canary",
            "unmarked-activity-detail-canary",
            "unmarked-technical-context-canary",
            "capture-stdout-canary",
            "capture-stderr-canary",
            "private-source-inventory-canary",
            "private-source-file-canary",
            "private-source-checksum-canary",
            "private-game-file-canary",
            "private-credential-file-canary",
            "private-environment-file-canary",
            "unmarked-envelope-canary",
            "unmarked-span-canary",
            "runtime-text-canary",
            "unmarked-field-canary",
            "unmarked-field-name-canary",
            "unmarked-field-value-canary",
            "unmarked-event-canary",
            "unmarked-error-canary",
            "unmarked-target-canary",
            "unmarked-frontend-canary",
            "unmarked-environment-canary",
            "unmarked-location-canary",
            "unmarked-query-canary",
            "unmarked-header-canary",
            "legacy-secret-canary",
            "private-unselected-file-canary",
        ] {
            assert!(!text.contains(canary), "support archive leaked {canary}");
        }
    }
    assert_eq!(
        library.activity_diagnostic(&activity.id).unwrap(),
        [capture]
    );
    assert_eq!(library.activities(1).unwrap(), [activity]);
    assert_eq!(
        fs::read(logs.join(LOG_NAME)).unwrap(),
        format!("{envelope}\nlegacy progress password=legacy-secret-canary\n").as_bytes()
    );
}

struct CountedRead<'a> {
    input: Cursor<Vec<u8>>,
    read: &'a Cell<usize>,
}

impl Read for CountedRead<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.input.read(buffer)?;
        self.read.set(self.read.get() + count);
        Ok(count)
    }
}

#[test]
fn newline_free_oversize_log_has_bounded_consuming_reads_and_no_partial_record() {
    let limits = SupportBundleLimits {
        log_bytes: 512,
        record_bytes: 64,
        ..Default::default()
    };
    let read = Cell::new(0);
    let log = read_log(
        CountedRead {
            input: Cursor::new(vec![b'x'; 1024 * 1024]),
            read: &read,
        },
        &limits,
        4096,
        Instant::now(),
    );
    assert!(read.get() <= limits.log_bytes);
    assert!(log.read <= limits.log_bytes);
    assert!(log.bytes.is_empty());
    assert_eq!(log.records, 0);
    assert_eq!(log.reasons, [SupportBundleReason::RecordLimit]);
}

#[test]
fn invalid_records_and_incomplete_utf8_tail_preserve_only_complete_valid_records() {
    let limits = SupportBundleLimits::default();
    let mut input = b"{\"fields\":{\"message\":\"first record\"}}\n".to_vec();
    input.extend_from_slice(b"{\"broken\":\n");
    input.extend_from_slice(b"invalid-utf8-\xff\n");
    input.extend_from_slice(b"{\"fields\":{\"message\":\"second record\"}}\n");
    input.extend_from_slice(b"{\"fields\":{\"message\":\"partial-private-canary-\xe2\x82");
    let log = read_log(Cursor::new(input), &limits, 4096, Instant::now());
    assert_eq!(log.records, 2);
    assert_eq!(
        log.reasons,
        [
            SupportBundleReason::InvalidRecord,
            SupportBundleReason::IncompleteRecord
        ]
    );
    let records: Vec<Value> = serde_json::Deserializer::from_slice(&log.bytes)
        .into_iter::<Value>()
        .map(|record| record.unwrap())
        .collect();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["fields"]["message"], "first record");
    assert_eq!(records[1]["fields"]["message"], "second record");
    assert!(!String::from_utf8_lossy(&log.bytes).contains("partial-private-canary"));
}

struct FailAfterBytes(Cursor<Vec<u8>>);

impl Read for FailAfterBytes {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.0.position() as usize == self.0.get_ref().len() {
            Err(std::io::Error::other("unmarked-read-error-canary"))
        } else {
            self.0.read(buffer)
        }
    }
}

#[test]
fn read_fault_retains_completed_records_and_does_not_export_the_io_error() {
    let log = read_log(
        FailAfterBytes(Cursor::new(b"retained legacy progress\n".to_vec())),
        &SupportBundleLimits::default(),
        4096,
        Instant::now(),
    );
    assert_eq!(log.records, 1);
    assert_eq!(log.reasons, [SupportBundleReason::ReadFailed]);
    let record: Value = serde_json::from_slice(&log.bytes).unwrap();
    assert_eq!(record["legacy_text"], "retained legacy progress");
    assert!(!String::from_utf8_lossy(&log.bytes).contains("unmarked-read-error-canary"));
}

#[test]
fn raw_output_and_cooperative_time_limits_leave_explicit_omission_reasons() {
    let input = b"first complete record\nsecond incomplete record\n";
    let raw_limit = b"first complete record\n".len() + 3;
    let limits = SupportBundleLimits {
        log_bytes: raw_limit,
        ..Default::default()
    };
    let limited = read_log(Cursor::new(input), &limits, 4096, Instant::now());
    assert_eq!(limited.read, raw_limit);
    assert_eq!(limited.records, 1);
    assert!(limited.reasons.contains(&SupportBundleReason::SectionLimit));
    assert!(
        limited
            .reasons
            .contains(&SupportBundleReason::IncompleteRecord)
    );
    assert!(limited.bytes.len() <= 4096);

    let output_limited = read_log(
        Cursor::new(input),
        &SupportBundleLimits::default(),
        1,
        Instant::now(),
    );
    assert!(output_limited.bytes.is_empty());
    assert_eq!(output_limited.records, 0);
    assert_eq!(output_limited.reasons, [SupportBundleReason::SectionLimit]);

    let read = Cell::new(0);
    let deadline = read_log(
        CountedRead {
            input: Cursor::new(input.to_vec()),
            read: &read,
        },
        &SupportBundleLimits {
            collection_seconds: 0,
            ..Default::default()
        },
        4096,
        Instant::now(),
    );
    assert_eq!(read.get(), 0);
    assert_eq!(deadline.reasons, [SupportBundleReason::Deadline]);
    assert!(deadline.bytes.is_empty());
}

#[test]
fn held_log_handle_survives_rotation_without_reading_the_replacement_path() {
    let temporary = tempfile::tempdir().unwrap();
    log_fixture(temporary.path(), "original held log record");
    let path = temporary.path().join(LOG_NAME);
    let file = crate::external_runtime::open_single_link_file(&path).unwrap();
    fs::rename(&path, temporary.path().join(format!("{LOG_NAME}.1"))).unwrap();
    log_fixture(temporary.path(), "replacement-path-private-canary");
    let log = read_log(file, &SupportBundleLimits::default(), 4096, Instant::now());
    assert_eq!(log.records, 1);
    assert!(log.reasons.is_empty());
    let record: Value = serde_json::from_slice(&log.bytes).unwrap();
    assert_eq!(record["fields"]["message"], "original held log record");
    assert!(!String::from_utf8_lossy(&log.bytes).contains("replacement-path-private-canary"));
}

#[test]
fn hard_linked_and_non_regular_log_paths_are_omitted_without_reading_private_files() {
    let temporary = tempfile::tempdir().unwrap();
    let private = temporary.path().join("private-file");
    fs::write(&private, "private-hard-link-canary\n").unwrap();
    let logs = temporary.path().join("logs");
    fs::create_dir(&logs).unwrap();
    fs::hard_link(&private, logs.join(LOG_NAME)).unwrap();
    fs::create_dir(logs.join(format!("{LOG_NAME}.1"))).unwrap();
    let exported = export_support_bundle(SupportBundleRequest {
        destination_dir: &temporary.path().join("exports"),
        logs_dir: Some(&logs),
        library: None,
        startup_failure: None,
    })
    .unwrap();
    let members = members(&exported.path);
    assert!(!members.keys().any(|name| name.starts_with("logs/")));
    let manifest = document(&members, "manifest.json");
    assert!(
        manifest["sections"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|section| section["kind"] == "runtime_log")
            .all(|section| section["status"] == "omitted"
                && !section["reasons"].as_array().unwrap().is_empty())
    );
    assert_eq!(fs::read(&private).unwrap(), b"private-hard-link-canary\n");
    for bytes in members.values() {
        assert!(!String::from_utf8_lossy(bytes).contains("private-hard-link-canary"));
    }
}

#[cfg(unix)]
#[test]
fn symlinked_log_file_is_omitted_without_following_its_target() {
    let temporary = tempfile::tempdir().unwrap();
    let private = temporary.path().join("private-file");
    fs::write(&private, "private-symlink-canary\n").unwrap();
    let logs = temporary.path().join("logs");
    fs::create_dir(&logs).unwrap();
    std::os::unix::fs::symlink(&private, logs.join(LOG_NAME)).unwrap();
    let exported = export_support_bundle(SupportBundleRequest {
        destination_dir: &temporary.path().join("exports"),
        logs_dir: Some(&logs),
        library: None,
        startup_failure: None,
    })
    .unwrap();
    let members = members(&exported.path);
    assert!(!members.keys().any(|name| name.starts_with("logs/")));
    assert_eq!(fs::read(&private).unwrap(), b"private-symlink-canary\n");
}

fn directory_names(directory: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn injected_collection_write_and_publish_failures_remove_only_owned_staging() {
    for target in [
        Checkpoint::Collected,
        Checkpoint::Written,
        Checkpoint::Publish,
    ] {
        let temporary = tempfile::tempdir().unwrap();
        fs::write(
            temporary.path().join("existing-user.zip"),
            b"preserve existing user archive",
        )
        .unwrap();
        fs::write(
            temporary.path().join(".portcove-support-unrelated.tmp"),
            b"preserve another writer's staging",
        )
        .unwrap();
        let mut reached = false;
        let result = export(
            temporary.path(),
            None,
            None,
            None,
            SupportBundleLimits::default(),
            &mut |current, output| {
                let matches = matches!(
                    (current, target),
                    (Checkpoint::Collected, Checkpoint::Collected)
                        | (Checkpoint::Written, Checkpoint::Written)
                        | (Checkpoint::Publish, Checkpoint::Publish)
                );
                if matches {
                    reached = true;
                    assert!(
                        !output.exists(),
                        "final archive appeared before publication"
                    );
                    return Err(PortcoveError::state("injected export failure"));
                }
                Ok(())
            },
        );
        assert!(reached && result.is_err());
        assert_eq!(
            directory_names(temporary.path()),
            [".portcove-support-unrelated.tmp", "existing-user.zip"]
        );
        assert_eq!(
            fs::read(temporary.path().join("existing-user.zip")).unwrap(),
            b"preserve existing user archive"
        );
        assert_eq!(
            fs::read(temporary.path().join(".portcove-support-unrelated.tmp")).unwrap(),
            b"preserve another writer's staging"
        );
    }
}

#[test]
fn replaced_destination_parent_cannot_redirect_staging_cleanup_into_foreign_files() {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("exports");
    let owned_old = temporary.path().join("owned-old");
    let foreign = temporary.path().join("foreign");
    fs::create_dir(&destination).unwrap();
    fs::create_dir(&foreign).unwrap();
    fs::write(destination.join("owned-user-file"), b"owned user canary").unwrap();
    fs::write(foreign.join("foreign-user-file"), b"foreign user canary").unwrap();
    let mut moved = false;
    let mut observed_stage = None;
    let result = export(
        &destination,
        None,
        None,
        None,
        SupportBundleLimits::default(),
        &mut |point, output| {
            if !matches!(point, Checkpoint::Collected) {
                return Ok(());
            }
            assert!(!output.exists());
            let staging = directory_names(&destination)
                .into_iter()
                .find(|name| name.starts_with(".portcove-support-") && name.ends_with(".tmp"))
                .expect("one private staging file must be present during collection");
            fs::write(foreign.join(&staging), b"foreign matching-name canary")?;
            observed_stage = Some(staging);
            if let Err(error) = fs::rename(&destination, &owned_old) {
                #[cfg(windows)]
                if matches!(error.raw_os_error(), Some(5 | 32 | 33)) {
                    // Windows holds the directory without delete sharing;
                    // rejecting the rename is the intended identity boundary.
                    return Err(PortcoveError::state(
                        "injected collection failure after blocked parent replacement",
                    ));
                }
                return Err(error.into());
            }
            moved = true;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&foreign, &destination)?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_dir(&foreign, &destination)?;
            Err(PortcoveError::state(
                "injected collection failure after parent replacement",
            ))
        },
    );
    assert!(result.is_err());
    let staging = observed_stage.expect("collection checkpoint must run");
    assert_eq!(
        fs::read(foreign.join(&staging)).unwrap(),
        b"foreign matching-name canary"
    );
    assert_eq!(
        fs::read(foreign.join("foreign-user-file")).unwrap(),
        b"foreign user canary"
    );
    assert_eq!(directory_names(&foreign).len(), 2);
    if moved {
        assert_eq!(directory_names(&owned_old), ["owned-user-file"]);
        assert_eq!(
            fs::read(owned_old.join("owned-user-file")).unwrap(),
            b"owned user canary"
        );
    } else {
        #[cfg(not(windows))]
        panic!("the owned destination replacement fixture did not run");
        #[cfg(windows)]
        {
            assert_eq!(directory_names(&destination), ["owned-user-file"]);
            assert_eq!(
                fs::read(destination.join("owned-user-file")).unwrap(),
                b"owned user canary"
            );
            assert!(!owned_old.exists());
        }
    }
}

#[test]
fn unwinding_during_collection_cleans_staging_without_touching_user_files() {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("user-file"), b"owned by user").unwrap();
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        export(
            temporary.path(),
            None,
            None,
            None,
            SupportBundleLimits::default(),
            &mut |point, output| {
                if matches!(point, Checkpoint::Collected) {
                    assert!(!output.exists());
                    panic!("injected support collection interruption");
                }
                Ok(())
            },
        )
    }));
    assert!(interrupted.is_err());
    assert_eq!(directory_names(temporary.path()), ["user-file"]);
    assert_eq!(
        fs::read(temporary.path().join("user-file")).unwrap(),
        b"owned by user"
    );
}

#[test]
fn final_name_collision_preserves_existing_bytes_and_removes_staging() {
    let temporary = tempfile::tempdir().unwrap();
    let mut collision = None;
    let result = export(
        temporary.path(),
        None,
        None,
        None,
        SupportBundleLimits::default(),
        &mut |point, output| {
            if matches!(point, Checkpoint::Publish) {
                fs::write(output, b"preexisting destination canary")?;
                collision = Some(output.to_owned());
            }
            Ok(())
        },
    );
    assert!(result.is_err());
    let collision = collision.unwrap();
    assert_eq!(
        fs::read(&collision).unwrap(),
        b"preexisting destination canary"
    );
    assert_eq!(
        directory_names(temporary.path()),
        [collision.file_name().unwrap().to_str().unwrap()]
    );
}

#[test]
fn concurrent_exports_publish_distinct_complete_archives_without_staging_leaks() {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("exports");
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("user-file"), b"concurrent user canary").unwrap();
    let barrier = std::sync::Barrier::new(4);
    let exports = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    export_support_bundle(SupportBundleRequest {
                        destination_dir: &destination,
                        logs_dir: None,
                        library: None,
                        startup_failure: None,
                    })
                    .unwrap()
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });
    let paths: std::collections::BTreeSet<_> = exports
        .iter()
        .map(|exported| exported.path.clone())
        .collect();
    assert_eq!(paths.len(), 4);
    assert_eq!(directory_names(&destination).len(), 5);
    assert!(
        !directory_names(&destination)
            .iter()
            .any(|name| name.ends_with(".tmp"))
    );
    for exported in exports {
        let members = members(&exported.path);
        assert_eq!(
            members.keys().map(String::as_str).collect::<Vec<_>>(),
            ["manifest.json", "startup.json"]
        );
        assert_eq!(
            document(&members, "manifest.json")["library_available"],
            false
        );
    }
    assert_eq!(
        fs::read(destination.join("user-file")).unwrap(),
        b"concurrent user canary"
    );
}

#[test]
fn unusable_destination_does_not_replace_the_user_file() {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("destination-is-a-file");
    fs::write(&destination, b"destination user file").unwrap();
    let result = export_support_bundle(SupportBundleRequest {
        destination_dir: &destination,
        logs_dir: None,
        library: None,
        startup_failure: None,
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"destination user file");
    assert_eq!(directory_names(temporary.path()), ["destination-is-a-file"]);
}

#[test]
fn total_payload_budget_accounts_for_every_archive_section() {
    let temporary = tempfile::tempdir().unwrap();
    let logs = temporary.path().join("logs");
    fs::create_dir(&logs).unwrap();
    fs::write(logs.join(LOG_NAME), "ordinary progress line\n".repeat(100)).unwrap();
    let limits = SupportBundleLimits {
        total_bytes: 256,
        section_bytes: 192,
        log_bytes: 128,
        record_bytes: 128,
        ..Default::default()
    };
    let exported = export(
        &temporary.path().join("exports"),
        Some(&logs),
        Some(&FailedSections),
        None,
        limits.clone(),
        &mut |_, _| Ok(()),
    )
    .unwrap();
    let members = members(&exported.path);
    let payload: usize = members
        .iter()
        .filter(|(name, _)| *name != "manifest.json")
        .map(|(_, bytes)| bytes.len())
        .sum();
    assert!(payload <= limits.total_bytes);
    assert!(members["manifest.json"].len() <= MANIFEST_BYTES);
    assert_eq!(
        exported
            .manifest
            .sections
            .iter()
            .map(|section| section.bytes_written)
            .sum::<usize>(),
        payload
    );
    assert!(
        exported
            .manifest
            .sections
            .iter()
            .all(|section| section.bytes_written <= limits.section_bytes)
    );
    assert!(exported.manifest.sections.iter().any(|section| {
        section.reasons.contains(&SupportBundleReason::TotalLimit)
            || section.reasons.contains(&SupportBundleReason::SectionLimit)
    }));
}

struct FailWrites;

impl Write for FailWrites {
    fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::other("injected destination write failure"))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl std::io::Seek for FailWrites {
    fn seek(&mut self, _: std::io::SeekFrom) -> std::io::Result<u64> {
        Ok(0)
    }
}

#[test]
fn archive_entry_write_reports_real_writer_failure() {
    let mut writer = zip::ZipWriter::new(FailWrites);
    assert!(write_entry(&mut writer, "startup.json", b"{}\n").is_err());
}
