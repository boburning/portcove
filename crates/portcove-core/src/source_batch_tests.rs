use super::*;
use crate::{Catalog, ErrorCode, Library, SourceClassification};

fn fixture() -> (tempfile::TempDir, PortcoveService, SourceRecord) {
    let temporary = tempfile::tempdir().unwrap();
    let bytes = b"inert registered-input fixture";
    let path = temporary.path().join("input.z64");
    std::fs::write(&path, bytes).unwrap();
    let mut service =
        PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
    service.replace_catalog_for_test(Catalog::from_json(&serde_json::json!({
        "schema_version":1,
        "source_profiles":[{"id":"fixture-a","label":"Fixture A","accepted_extensions":["z64"]},
            {"id":"fixture-b","label":"Fixture B","accepted_extensions":["z64"]}],
        "ports":[{"id":"fixture","name":"Fixture","summary":"Inert batch fixture",
            "project_url":"https://example.invalid/fixture","support_tier":"beta",
            "channels":["stable"],"platforms":["linux-x86-64"],"adapter":"libultraship-portable",
            "release":{"repository":"fixture/fixture"},"source_profile":"fixture-a",
            "executable_hints":{"linux-x86-64":["fixture"]}}]
    }).to_string()).unwrap());
    let hash = hex::encode(Sha256::digest(bytes));
    let record = SourceRecord {
        profile_id: "fixture-a".into(),
        path,
        sha256: hash.clone(),
        size: bytes.len() as u64,
        storage_sha256: hash,
        storage_size: bytes.len() as u64,
        updated_at: 1,
        observed_identity: None,
    };
    service.library().register_source(&record).unwrap();
    (temporary, service, record)
}

fn limits() -> RegisteredSourceInspectionLimits {
    RegisteredSourceInspectionLimits {
        max_file_bytes: 1024,
        max_hash_bytes: 1024,
        max_elapsed_ms: 30_000,
    }
}

fn operation() -> OperationCoordinator {
    OperationCoordinator::new("registered-input-test", None)
}

fn report(batch: &RegisteredSourceInspectionBatch) -> &SourceInspectionReport {
    match &batch.observations[0] {
        RegisteredSourceObservation::Inspected { report } => report,
        _ => panic!("expected inspected registration"),
    }
}

#[test]
fn batch_preserves_legacy_unknown_identity_and_registration_without_writes() {
    let (_temporary, service, record) = fixture();
    let before = serde_json::to_vec(&service.library().sources().unwrap()).unwrap();
    let batch = service
        .inspect_registered_sources_bounded(
            &["fixture-a".into(), "fixture-b".into()],
            &limits(),
            &operation(),
        )
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::Current);
    assert!(report(&batch).legacy.registration_identity_not_recorded);
    assert_eq!(
        report(&batch)
            .inspection
            .as_ref()
            .unwrap()
            .assessment
            .classification,
        SourceClassification::NotEvaluated
    );
    assert!(
        matches!(&batch.observations[1], RegisteredSourceObservation::Unregistered { profile_id } if profile_id=="fixture-b")
    );
    assert_eq!(batch.hash_bytes, record.size);
    assert_eq!(batch.library, service.library().identity_record().unwrap());
    assert_eq!(
        batch.catalog_sha256,
        fingerprint(&service.catalog().authoritative_document()).unwrap()
    );
    assert_eq!(
        before,
        serde_json::to_vec(&service.library().sources().unwrap()).unwrap()
    );
    assert_eq!(
        std::fs::read(&record.path).unwrap(),
        b"inert registered-input fixture"
    );
}

#[test]
fn batch_distinguishes_changed_missing_and_unsupported_container() {
    let (_temporary, service, mut record) = fixture();
    std::fs::write(&record.path, b"changed inert source").unwrap();
    let batch = service
        .inspect_registered_sources_bounded(&["fixture-a".into()], &limits(), &operation())
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::Changed);
    std::fs::remove_file(&record.path).unwrap();
    let batch = service
        .inspect_registered_sources_bounded(&["fixture-a".into()], &limits(), &operation())
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::Missing);
    record.path.set_extension("zip");
    std::fs::write(&record.path, b"malformed ZIP must not reach a parser").unwrap();
    service.library().register_source(&record).unwrap();
    let batch = service
        .inspect_registered_sources_bounded(&["fixture-a".into()], &limits(), &operation())
        .unwrap();
    assert_eq!(batch.hash_bytes, 0);
    assert_eq!(report(&batch).health, SourceHealth::NotChecked);
    assert_eq!(report(&batch).problem.as_ref().unwrap().code, "unsupported");
    assert!(report(&batch).inspection.is_none());
}

#[test]
fn batch_shares_bytes_only_for_matching_complete_input_baselines() {
    let (_temporary, service, mut record) = fixture();
    record.profile_id = "fixture-b".into();
    service.library().register_source(&record).unwrap();
    let mut bounded = limits();
    bounded.max_hash_bytes = record.size;
    let batch = service
        .inspect_registered_sources_bounded(
            &["fixture-a".into(), "fixture-b".into()],
            &bounded,
            &operation(),
        )
        .unwrap();
    assert_eq!(batch.hash_bytes, record.size);
    assert_eq!(batch.observations.len(), 2);
    record.storage_sha256 = "0".repeat(64);
    service.library().register_source(&record).unwrap();
    let batch = service
        .inspect_registered_sources_bounded(
            &["fixture-a".into(), "fixture-b".into()],
            &bounded,
            &operation(),
        )
        .unwrap();
    match &batch.observations[1] {
        RegisteredSourceObservation::Inspected { report } => {
            assert_eq!(report.health, SourceHealth::NotChecked)
        }
        _ => panic!("expected registration"),
    }
}

#[test]
fn bounded_refusal_does_not_become_missing_or_unreadable() {
    let (_temporary, service, record) = fixture();
    let mut bounded = limits();
    bounded.max_file_bytes = record.size - 1;
    let batch = service
        .inspect_registered_sources_bounded(&["fixture-a".into()], &bounded, &operation())
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::NotChecked);
    assert_eq!(batch.hash_bytes, 0);
    bounded = limits();
    bounded.max_hash_bytes = record.size - 1;
    let batch = service
        .inspect_registered_sources_bounded(&["fixture-a".into()], &bounded, &operation())
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::NotChecked);
    assert_eq!(batch.hash_bytes, 0);
    assert!(
        service
            .inspect_registered_sources_bounded(&[], &limits(), &operation())
            .is_err()
    );
    assert!(
        service
            .inspect_registered_sources_bounded(
                &["fixture-a".into(), "fixture-a".into()],
                &limits(),
                &operation()
            )
            .is_err()
    );
    let mut bounded = limits();
    bounded.max_elapsed_ms = 30_001;
    assert!(
        service
            .inspect_registered_sources_bounded(&["fixture-a".into()], &bounded, &operation())
            .is_err()
    );
}

#[test]
fn changed_registration_prevents_accepting_the_entire_batch() {
    let (_temporary, service, mut record) = fixture();
    let error = service
        .inspect_registered_sources_bounded_before_accept(
            &["fixture-a".into(), "fixture-b".into()],
            &limits(),
            &operation(),
            || {
                record.profile_id = "fixture-b".into();
                service.library().register_source(&record)
            },
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}

#[test]
fn changed_bytes_that_fail_the_legacy_contract_are_still_changed() {
    let (_temporary, mut service, record) = fixture();
    let mut document = service.catalog().authoritative_document();
    document.source_profiles[0].accepted_sha256 = vec![record.sha256.clone()];
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    std::fs::write(&record.path, b"known mismatching changed bytes").unwrap();
    let batch = service
        .inspect_registered_sources_bounded(&["fixture-a".into()], &limits(), &operation())
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::Changed);
    assert_eq!(report(&batch).state_code, "source_changed");
    assert!(report(&batch).inspection.is_none());
    assert!(report(&batch).problem.is_some());
}

#[test]
fn changed_open_input_prevents_accepting_previously_observed_rows() {
    let (_temporary, service, record) = fixture();
    let result = service.inspect_registered_sources_bounded_before_accept(
        &["fixture-a".into()],
        &limits(),
        &operation(),
        || {
            std::fs::write(&record.path, b"x")?;
            Ok(())
        },
    );
    assert!(result.is_err());
}

#[test]
fn expired_reader_refuses_before_reading_and_batch_cancellation_is_not_a_row() {
    let (_temporary, service, record) = fixture();
    let mut file = File::open(record.path).unwrap();
    let mut reader = DeadlineReader {
        file: &mut file,
        started: Instant::now() - Duration::from_secs(1),
        maximum: Duration::from_millis(1),
    };
    assert_eq!(
        reader.read(&mut [0u8; 1]).unwrap_err().kind(),
        std::io::ErrorKind::TimedOut
    );
    let (activity, operation) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::CheckUpdate,
            crate::ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    service.request_cancellation(&activity.id).unwrap();
    let error = service
        .inspect_registered_sources_bounded(&["fixture-a".into()], &limits(), &operation)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
}
