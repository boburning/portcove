use super::*;
use crate::{Catalog, ErrorCode, Library, SourceClassification};

fn fixture() -> (tempfile::TempDir, PortcoveService, SourceRecord) {
    let temporary = tempfile::tempdir().unwrap();
    let bytes = b"\x80\x37\x12\x40inert registered-input fixture\0\0";
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
        b"\x80\x37\x12\x40inert registered-input fixture\0\0"
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
fn relative_file_sets_remain_unchecked_in_the_quick_batch_without_opening_them() {
    let (temporary, service, mut record) = fixture();
    record.profile_id = "dark-forces-pc-complete-installed-data".into();
    for directory in [false, true] {
        record.path = temporary.path().join(if directory {
            "relative-directory"
        } else {
            "relative.zip"
        });
        if directory {
            std::fs::create_dir(&record.path).unwrap();
        } else {
            std::fs::write(&record.path, b"not a ZIP: quick batch must not parse it").unwrap();
        }
        service.library().register_source(&record).unwrap();
        let before = serde_json::to_vec(&service.library().sources().unwrap()).unwrap();
        let batch = service
            .inspect_registered_sources_bounded(
                &[record.profile_id.clone()],
                &limits(),
                &operation(),
            )
            .unwrap();
        assert_eq!(batch.hash_bytes, 0);
        assert_eq!(report(&batch).health, SourceHealth::NotChecked);
        assert!(report(&batch).inspection.is_none());
        assert_eq!(report(&batch).problem.as_ref().unwrap().code, "unsupported");
        assert_eq!(
            before,
            serde_json::to_vec(&service.library().sources().unwrap()).unwrap()
        );
    }
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
                            sha256: Some(hex::encode(Sha256::digest(variant.id.as_bytes()))),
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
fn raw_observation_reuses_schema_two_recognition_and_structural_unknown_logic() {
    let (_temporary, mut service, record) = fixture();
    service.replace_catalog_for_test(raw_fixture_catalog(&service, &record, false));
    for changed in [false, true] {
        if changed {
            std::fs::write(&record.path, b"\x80\x37\x12\x40different exact input\0\0\0").unwrap();
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
            assert_eq!(
                observed.assessment.classification,
                SourceClassification::Unrecognized
            );
            // The existing empty legacy digest allowlist preserves structural
            // compatibility; unknown exact identity is not a known mismatch.
            assert!(matches!(
                observed.assessment.admission,
                crate::SourceAdmission::Admitted {
                    mode: crate::SourceAdmissionMode::StructuralChecks
                }
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

fn directory_fixture() -> (tempfile::TempDir, PortcoveService, SourceRecord) {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("source-set");
    std::fs::create_dir(&directory).unwrap();
    let mut service =
        PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
    let mut document = service.catalog().authoritative_document();
    let profile = document
        .source_catalog
        .as_mut()
        .unwrap()
        .identities
        .iter_mut()
        .find(|profile| profile.id == "g-diffuser-source-set")
        .unwrap();
    let variant = profile
        .variants
        .iter_mut()
        .find(|variant| !variant.legacy_projection_only)
        .unwrap();
    let crate::SourceRepresentationKind::FileSet { members } = &mut variant.representations[0].kind
    else {
        panic!("fixture must consume an existing directory file-set representation");
    };
    for (index, member) in members.iter_mut().enumerate() {
        let bytes = format!("inert set member {index}").into_bytes();
        std::fs::write(directory.join(&member.filenames[0]), &bytes).unwrap();
        member.identities = vec![crate::DigestIdentity {
            scope: crate::DigestScope::FileSetMember,
            sha1: None,
            sha256: Some(hex::encode(Sha256::digest(&bytes))),
            crc32: None,
        }];
    }
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    let record =
        crate::source_inspection::inspect(service.catalog(), "g-diffuser-source-set", &directory)
            .unwrap()
            .record
            .unwrap();
    service.library().register_source(&record).unwrap();
    (temporary, service, record)
}

fn directory_inspection(
    service: &PortcoveService,
    record: &SourceRecord,
    bounded: &RegisteredSourceInspectionLimits,
    budget: &mut HashBudget,
    cache: &mut RawCache,
    directories: &mut DirectoryCache,
    inventory: &mut InventoryBudget,
) -> Result<crate::SourceInspection> {
    inspect_directory_set(
        record,
        InspectionScope {
            service,
            limits: bounded,
            started: Instant::now(),
        },
        budget,
        cache,
        directories,
        inventory,
    )
}

fn hash_budget(maximum: u64) -> HashBudget {
    HashBudget {
        operation: Some(operation()),
        limit: maximum,
        hashed: 0,
        max_zip_entries: 0,
    }
}

#[test]
fn directory_batch_reader_reuses_exact_complete_set_matcher_and_keeps_registration() {
    let (_temporary, service, record) = directory_fixture();
    let before = serde_json::to_vec(&service.library().sources().unwrap()).unwrap();
    let mut budget = hash_budget(record.size);
    let mut cache = RawCache::new();
    let mut directories = DirectoryCache::new();
    let mut inventory = InventoryBudget::default();
    let observed = directory_inspection(
        &service,
        &record,
        &limits(),
        &mut budget,
        &mut cache,
        &mut directories,
        &mut inventory,
    )
    .unwrap();
    let reference =
        crate::source_inspection::inspect(service.catalog(), &record.profile_id, &record.path)
            .unwrap();
    assert_eq!(observed.assessment, reference.assessment);
    assert_eq!(observed.observed_digests, reference.observed_digests);
    assert_eq!(observed.components, reference.components);
    assert!(matches!(
        observed.assessment.classification,
        SourceClassification::Recognized { .. }
    ));
    assert_eq!(budget.hashed, record.size);
    let repeated = directory_inspection(
        &service,
        &record,
        &limits(),
        &mut budget,
        &mut cache,
        &mut directories,
        &mut inventory,
    )
    .unwrap();
    assert_eq!(repeated.assessment, observed.assessment);
    assert_eq!(
        budget.hashed, record.size,
        "same complete baseline shares hashes within batch"
    );
    assert_eq!(directories.len(), 1);
    assert_eq!(cache.len(), observed.components.len());
    assert_eq!(
        before,
        serde_json::to_vec(&service.library().sources().unwrap()).unwrap()
    );
}

#[test]
fn directory_set_incomplete_and_incompatible_members_never_become_admitted() {
    for missing in [false, true] {
        let (_temporary, service, record) = directory_fixture();
        let member = std::fs::read_dir(&record.path)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        if missing {
            std::fs::remove_file(member).unwrap();
        } else {
            std::fs::write(member, b"incompatible set member").unwrap();
        }
        let mut budget = hash_budget(1024);
        let observed = directory_inspection(
            &service,
            &record,
            &limits(),
            &mut budget,
            &mut RawCache::new(),
            &mut DirectoryCache::new(),
            &mut InventoryBudget::default(),
        )
        .unwrap();
        assert!(matches!(
            observed.assessment.admission,
            crate::SourceAdmission::Rejected { .. }
        ));
        assert!(observed.record.is_none());
        if missing {
            assert_eq!(budget.hashed, 0, "complete inventory precedes hashing");
        }
    }
}

#[test]
fn directory_set_limits_and_unbounded_shapes_fail_without_ambient_fallback() {
    let (_temporary, service, record) = directory_fixture();
    let mut budget = hash_budget(record.size - 1);
    assert!(
        directory_inspection(
            &service,
            &record,
            &limits(),
            &mut budget,
            &mut RawCache::new(),
            &mut DirectoryCache::new(),
            &mut InventoryBudget::default()
        )
        .is_err()
    );
    assert!(budget.hashed < record.size);
    let mut budget = hash_budget(1024);
    let mut inventory = InventoryBudget {
        entries: MAX_DIRECTORY_ENTRIES,
        name_bytes: 0,
    };
    assert!(
        directory_inspection(
            &service,
            &record,
            &limits(),
            &mut budget,
            &mut RawCache::new(),
            &mut DirectoryCache::new(),
            &mut inventory
        )
        .is_err()
    );
    assert_eq!(budget.hashed, 0);
    let mut zip = record.clone();
    zip.path = record.path.with_extension("zip");
    std::fs::write(&zip.path, b"not a ZIP parser input").unwrap();
    let error = directory_inspection(
        &service,
        &zip,
        &limits(),
        &mut budget,
        &mut RawCache::new(),
        &mut DirectoryCache::new(),
        &mut InventoryBudget::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
    assert_eq!(budget.hashed, 0);
}

#[test]
fn uncompressed_gamecube_batch_reader_preserves_shared_identity_interpretation() {
    let (_temporary, mut service, mut record) = fixture();
    record.path.set_extension("iso");
    // Use an actual current schema-2 normalized-disc profile, without inventing an adapter.
    let profile = service
        .catalog()
        .document()
        .source_profiles
        .iter()
        .find(|profile| profile.kind == SourceKind::GamecubeDisc)
        .unwrap();
    record.profile_id = profile.id.clone();
    let bytes = b"inert normalized image";
    std::fs::write(&record.path, bytes).unwrap();
    record.sha256 = hex::encode(Sha256::digest(bytes));
    record.storage_sha256 = record.sha256.clone();
    record.size = bytes.len() as u64;
    record.storage_size = record.size;
    let mut document = service.catalog().authoritative_document();
    let identity = document
        .source_catalog
        .as_mut()
        .unwrap()
        .identities
        .iter_mut()
        .find(|identity| identity.id == record.profile_id)
        .unwrap();
    let representation = identity
        .variants
        .iter_mut()
        .filter(|variant| !variant.legacy_projection_only)
        .flat_map(|variant| &mut variant.representations)
        .find(|representation| {
            matches!(
                representation.kind,
                crate::SourceRepresentationKind::GamecubeNormalizedIso { .. }
            )
        })
        .unwrap();
    let crate::SourceRepresentationKind::GamecubeNormalizedIso { identities } =
        &mut representation.kind
    else {
        unreachable!()
    };
    *identities = vec![crate::DigestIdentity {
        scope: crate::DigestScope::GamecubeNormalizedIso,
        sha1: None,
        sha256: Some(record.sha256.clone()),
        crc32: None,
    }];
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    let observed = inspect_raw(
        &service,
        &record,
        &limits(),
        Instant::now(),
        &mut hash_budget(1024),
        &mut RawCache::new(),
    )
    .unwrap();
    let reference =
        crate::source_inspection::inspect(service.catalog(), &record.profile_id, &record.path)
            .unwrap();
    assert_eq!(observed.assessment, reference.assessment);
    assert_eq!(observed.observed_digests, reference.observed_digests);
    assert!(matches!(
        observed.assessment.classification,
        SourceClassification::Recognized { .. }
    ));
}

#[test]
fn unrecognized_directory_batch_is_read_only_and_bound_to_real_selected_catalog() {
    let (_temporary, service, record) = directory_fixture();
    let service = PortcoveService::new(service.library().clone()).unwrap();
    let before = serde_json::to_vec(&service.library().sources().unwrap()).unwrap();
    let activity_before = serde_json::to_vec(&service.library().activities(100).unwrap()).unwrap();
    let batch = service
        .inspect_registered_sources_bounded(
            std::slice::from_ref(&record.profile_id),
            &limits(),
            &operation(),
        )
        .unwrap();
    assert_eq!(report(&batch).health, SourceHealth::Current);
    assert!(matches!(
        report(&batch)
            .inspection
            .as_ref()
            .unwrap()
            .assessment
            .classification,
        SourceClassification::Unrecognized
    ));
    assert_eq!(batch.hash_bytes, record.size);
    assert_eq!(
        before,
        serde_json::to_vec(&service.library().sources().unwrap()).unwrap()
    );
    assert_eq!(
        activity_before,
        serde_json::to_vec(&service.library().activities(100).unwrap()).unwrap()
    );
    std::fs::remove_file(
        std::fs::read_dir(&record.path)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path(),
    )
    .unwrap();
    let incomplete = service
        .inspect_registered_sources_bounded(
            std::slice::from_ref(&record.profile_id),
            &limits(),
            &operation(),
        )
        .unwrap();
    assert_eq!(report(&incomplete).health, SourceHealth::NotChecked);
    assert_ne!(
        report(&incomplete).health,
        SourceHealth::Missing,
        "directory still exists; incomplete set is not confirmed missing storage"
    );
    assert!(matches!(
        report(&incomplete)
            .inspection
            .as_ref()
            .unwrap()
            .assessment
            .admission,
        crate::SourceAdmission::Rejected { .. }
    ));
}

#[test]
fn late_directory_inventory_member_and_location_changes_discard_batch() {
    for change in ["inventory", "member", "location"] {
        let (_temporary, service, record) = directory_fixture();
        let service = PortcoveService::new(service.library().clone()).unwrap();
        let result = service.inspect_registered_sources_bounded_before_accept(
            std::slice::from_ref(&record.profile_id),
            &limits(),
            &operation(),
            || {
                match change {
                    "inventory" => std::fs::write(record.path.join("extra.dat"), b"new")?,
                    "member" => std::fs::write(
                        std::fs::read_dir(&record.path)?.next().unwrap()?.path(),
                        b"changed",
                    )?,
                    "location" => {
                        std::fs::rename(&record.path, record.path.with_extension("retained"))?;
                        std::fs::create_dir(&record.path)?;
                    }
                    _ => unreachable!(),
                }
                Ok(())
            },
        );
        assert!(result.is_err(), "late {change} change must not be accepted");
        assert_eq!(
            service.library().sources().unwrap()[0].sha256,
            record.sha256
        );
    }
}

#[test]
fn ambiguous_unchanged_complete_set_is_current_without_admission() {
    let (_temporary, service, record) = directory_fixture();
    let mut inspection = directory_inspection(
        &service,
        &record,
        &limits(),
        &mut hash_budget(1024),
        &mut RawCache::new(),
        &mut DirectoryCache::new(),
        &mut InventoryBudget::default(),
    )
    .unwrap();
    let SourceClassification::Recognized { identity } =
        inspection.assessment.classification.clone()
    else {
        panic!("complete fixture must establish exact byte observations");
    };
    // Exercise health independently of admission. Catalog validation itself refuses
    // duplicate file-set declarations, so do not bypass it to create ambiguity.
    inspection.assessment.classification = SourceClassification::Ambiguous {
        candidates: vec![identity],
    };
    inspection.assessment.admission = crate::SourceAdmission::Rejected {
        reason: crate::SourceRejectionReason::AmbiguousIdentity,
    };
    inspection.record = None;
    assert!(matches!(
        inspection.assessment.classification,
        SourceClassification::Ambiguous { .. }
    ));
    assert!(matches!(
        inspection.assessment.admission,
        crate::SourceAdmission::Rejected { .. }
    ));
    assert!(inspection.record.is_none());
    let report =
        crate::source_report::available_report(service.catalog(), Some(record), inspection)
            .unwrap();
    assert_eq!(report.health, SourceHealth::Current);
}

#[test]
fn legacy_compressed_gamecube_is_refused_before_hashing() {
    let (_temporary, mut service, mut record) = fixture();
    let mut document = service.catalog().document().clone();
    document.schema_version = 1;
    document.source_catalog = None;
    let profile = document
        .source_profiles
        .iter_mut()
        .find(|profile| profile.kind == SourceKind::GamecubeDisc)
        .unwrap();
    profile.accepted_extensions.push("rvz".into());
    record.profile_id = profile.id.clone();
    record.path.set_extension("rvz");
    std::fs::write(&record.path, b"inert compressed disc").unwrap();
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    let mut budget = hash_budget(1024);
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

#[test]
fn redirected_directory_root_is_refused_before_inventory_and_hashing() {
    let (temporary, service, mut record) = directory_fixture();
    let redirect = temporary.path().join("redirect");
    #[cfg(windows)]
    {
        let output = crate::ChildProcessPolicy::native_command(
            crate::ChildProcessClass::HostTool,
            std::path::Path::new("cmd.exe"),
        )
        .unwrap()
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&redirect)
        .arg(&record.path)
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "owned junction fixture creation failed"
        );
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&record.path, &redirect).unwrap();
    for path in [redirect.clone(), redirect.join("child")] {
        record.path = path;
        let mut budget = hash_budget(1024);
        let mut inventory = InventoryBudget::default();
        assert!(
            directory_inspection(
                &service,
                &record,
                &limits(),
                &mut budget,
                &mut RawCache::new(),
                &mut DirectoryCache::new(),
                &mut inventory
            )
            .is_err()
        );
        assert_eq!(budget.hashed, 0);
        assert_eq!(inventory.entries, 0);
    }
}
