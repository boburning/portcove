use super::*;
use crate::{Catalog, ErrorCode, Library, SourceClassification};

fn fixture() -> (tempfile::TempDir, PortcoveService, SourceRecord) {
    let temporary = tempfile::tempdir().unwrap();
    let bytes = b"inert registered-input fixture";
    let path = temporary.path().join("input.z64");
    std::fs::write(&path, bytes).unwrap();
    let service =
        PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
    let hash = hex::encode(Sha256::digest(bytes));
    let record = SourceRecord {
        profile_id: "ocarina-of-time".into(),
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
            &["ocarina-of-time".into(), "star-fox-64".into()],
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
        SourceClassification::Unrecognized
    );
    assert!(
        matches!(&batch.observations[1], RegisteredSourceObservation::Unregistered { profile_id } if profile_id=="star-fox-64")
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
        .inspect_registered_sources_bounded(&["ocarina-of-time".into()], &limits(), &operation())
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::Changed);
    std::fs::remove_file(&record.path).unwrap();
    let batch = service
        .inspect_registered_sources_bounded(&["ocarina-of-time".into()], &limits(), &operation())
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::Missing);
    record.path.set_extension("zip");
    std::fs::write(&record.path, b"malformed ZIP must not reach a parser").unwrap();
    service.library().register_source(&record).unwrap();
    let batch = service
        .inspect_registered_sources_bounded(&["ocarina-of-time".into()], &limits(), &operation())
        .unwrap();
    assert_eq!(batch.hash_bytes, 0);
    assert_eq!(report(&batch).health, SourceHealth::NotChecked);
    assert_eq!(report(&batch).problem.as_ref().unwrap().code, "unsupported");
    assert!(report(&batch).inspection.is_none());
}

#[test]
fn batch_shares_bytes_only_for_matching_complete_input_baselines() {
    let (_temporary, service, mut record) = fixture();
    record.profile_id = "star-fox-64".into();
    service.library().register_source(&record).unwrap();
    let mut bounded = limits();
    bounded.max_hash_bytes = record.size;
    let batch = service
        .inspect_registered_sources_bounded(
            &["ocarina-of-time".into(), "star-fox-64".into()],
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
            &["ocarina-of-time".into(), "star-fox-64".into()],
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
        .inspect_registered_sources_bounded(&["ocarina-of-time".into()], &bounded, &operation())
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::NotChecked);
    assert_eq!(batch.hash_bytes, 0);
    bounded = limits();
    bounded.max_hash_bytes = record.size - 1;
    let batch = service
        .inspect_registered_sources_bounded(&["ocarina-of-time".into()], &bounded, &operation())
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
                &["ocarina-of-time".into(), "ocarina-of-time".into()],
                &limits(),
                &operation()
            )
            .is_err()
    );
    let mut bounded = limits();
    bounded.max_elapsed_ms = 30_001;
    assert!(
        service
            .inspect_registered_sources_bounded(&["ocarina-of-time".into()], &bounded, &operation())
            .is_err()
    );
}

#[test]
fn changed_registration_prevents_accepting_the_entire_batch() {
    let (_temporary, service, mut record) = fixture();
    let error = service
        .inspect_registered_sources_bounded_before_accept(
            &["ocarina-of-time".into(), "star-fox-64".into()],
            &limits(),
            &operation(),
            || {
                record.profile_id = "star-fox-64".into();
                service.library().register_source(&record)
            },
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}

#[test]
fn stale_service_catalog_is_refused_before_hashing() {
    let (_temporary, mut service, record) = fixture();
    let mut document = service.catalog().authoritative_document();
    document.ports[0].summary.push_str(" stale fixture");
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    std::fs::write(&record.path, b"known mismatching changed bytes").unwrap();
    let error = service
        .inspect_registered_sources_bounded(&["ocarina-of-time".into()], &limits(), &operation())
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}

#[test]
fn durable_catalog_selection_change_invalidates_the_batch() {
    let (_temporary, service, _record) = fixture();
    let error = service
        .inspect_registered_sources_bounded_before_accept(
            &["ocarina-of-time".into()],
            &limits(),
            &operation(),
            || {
                let state = service.library().catalog_status()?.state_sha256;
                service.library().use_embedded_catalog(&state)?;
                Ok(())
            },
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}

fn raw_fixture_catalog(
    service: &PortcoveService,
    record: &SourceRecord,
    archive_only: bool,
) -> Catalog {
    let mut document = service.catalog().authoritative_document();
    let identity = document
        .source_catalog
        .as_mut()
        .unwrap()
        .identities
        .iter_mut()
        .find(|identity| identity.id == record.profile_id)
        .unwrap();
    let variant = identity
        .variants
        .iter_mut()
        .find(|variant| !variant.legacy_projection_only)
        .unwrap();
    let representation = &mut variant.representations[0];
    representation.extensions = vec![if archive_only { "zip" } else { "z64" }.into()];
    let identities = vec![crate::DigestIdentity {
        scope: if archive_only {
            crate::DigestScope::ArchiveMember
        } else {
            crate::DigestScope::OriginalFile
        },
        sha1: None,
        sha256: Some(record.sha256.clone()),
        crc32: None,
    }];
    representation.kind = if archive_only {
        crate::SourceRepresentationKind::ArchiveMember {
            member_extensions: vec!["z64".into()],
            identities,
        }
    } else {
        crate::SourceRepresentationKind::RawFile { identities }
    };
    if archive_only {
        for variant in identity
            .variants
            .iter_mut()
            .filter(|variant| !variant.legacy_projection_only)
        {
            variant.representations.retain(|representation| {
                matches!(
                    &representation.kind,
                    crate::SourceRepresentationKind::ArchiveMember { .. }
                )
            });
            if variant.representations.is_empty() {
                variant.representations.push(crate::SourceRepresentation {
                    id: format!("{}-archive", variant.id),
                    extensions: vec!["zip".into()],
                    kind: crate::SourceRepresentationKind::ArchiveMember {
                        member_extensions: vec!["z64".into()],
                        identities: vec![crate::DigestIdentity {
                            scope: crate::DigestScope::ArchiveMember,
                            sha1: None,
                            sha256: Some(record.sha256.clone()),
                            crc32: None,
                        }],
                    },
                    evidence_ids: vec![],
                });
            }
        }
    }
    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

#[test]
fn raw_observation_reuses_schema_two_recognition_and_mismatch_logic() {
    let (_temporary, mut service, record) = fixture();
    service.replace_catalog_for_test(raw_fixture_catalog(&service, &record, false));
    for changed in [false, true] {
        if changed {
            std::fs::write(&record.path, b"different exact input").unwrap();
        }
        let mut budget = HashBudget {
            operation: Some(operation()),
            limit: 1024,
            hashed: 0,
            max_zip_entries: 0,
        };
        let observed = inspect_raw(
            &service,
            &record,
            &limits(),
            Instant::now(),
            &mut budget,
            &mut RawCache::new(),
        )
        .unwrap();
        let reference =
            crate::source_inspection::inspect(service.catalog(), &record.profile_id, &record.path)
                .unwrap();
        assert_eq!(observed.assessment, reference.assessment);
        assert_eq!(observed.observed_digests, reference.observed_digests);
        if changed {
            assert!(matches!(
                observed.assessment.admission,
                crate::SourceAdmission::Rejected { .. }
            ));
        } else {
            assert!(matches!(
                observed.assessment.classification,
                SourceClassification::Recognized { .. }
            ));
        }
    }
}

#[test]
fn archive_only_profile_cannot_use_an_empty_raw_inventory_as_a_wildcard() {
    let (_temporary, mut service, record) = fixture();
    service.replace_catalog_for_test(raw_fixture_catalog(&service, &record, true));
    let mut budget = HashBudget {
        operation: Some(operation()),
        limit: 1024,
        hashed: 0,
        max_zip_entries: 0,
    };
    let error = inspect_raw(
        &service,
        &record,
        &limits(),
        Instant::now(),
        &mut budget,
        &mut RawCache::new(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
    assert_eq!(budget.hashed, 0);
}

#[cfg(unix)]
#[test]
fn special_file_is_refused_without_opening_or_hashing() {
    use std::os::unix::ffi::OsStrExt;
    let (_temporary, service, record) = fixture();
    std::fs::remove_file(&record.path).unwrap();
    let path = std::ffi::CString::new(record.path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let batch = service
        .inspect_registered_sources_bounded(&["ocarina-of-time".into()], &limits(), &operation())
        .unwrap();
    assert_eq!(batch.hash_bytes, 0);
    assert_eq!(report(&batch).health, SourceHealth::NotChecked);
}

#[test]
fn cancellation_before_final_acceptance_discards_observations() {
    let (_temporary, service, _record) = fixture();
    let (activity, coordinator) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::CheckUpdate,
            crate::ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    let error = service
        .inspect_registered_sources_bounded_before_accept(
            &["ocarina-of-time".into()],
            &limits(),
            &coordinator,
            || {
                service.request_cancellation(&activity.id)?;
                Ok(())
            },
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
}

#[test]
fn changed_open_input_prevents_accepting_previously_observed_rows() {
    let (_temporary, service, record) = fixture();
    let result = service.inspect_registered_sources_bounded_before_accept(
        &["ocarina-of-time".into()],
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
        .inspect_registered_sources_bounded(&["ocarina-of-time".into()], &limits(), &operation)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
}
