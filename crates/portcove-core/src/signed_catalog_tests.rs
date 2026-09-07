use ed25519_dalek::{Signer, SigningKey};

use super::*;
use crate::{Catalog, CatalogOrigin, ErrorCode, SignedCatalogEnvelope, SignedCatalogPayload};

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

fn fixture(sequence: i64, now: i64) -> SignedCatalogPayload {
    let mut catalog = Catalog::embedded().unwrap().document().clone();
    catalog.ports[0].summary = format!("Synthetic signed metadata {sequence}");
    SignedCatalogPayload {
        sequence,
        issued_at: now - 60,
        expires_at: now + 3600,
        catalog,
    }
}

fn sign(payload: &SignedCatalogPayload) -> Vec<u8> {
    let key = signing_key();
    let key_id = signed_catalog::digest(key.verifying_key().as_bytes());
    let payload = serde_json::to_string(payload).unwrap();
    let signature = key.sign(&signed_catalog::signing_message(&key_id, &payload));
    serde_json::to_vec(&SignedCatalogEnvelope {
        format_version: 1,
        key_id,
        payload,
        signature: hex::encode(signature.to_bytes()),
    })
    .unwrap()
}

fn trusted(library: &Library) {
    library
        .trust_catalog_key(&hex::encode(signing_key().verifying_key().as_bytes()))
        .unwrap();
}

fn append_exact_qualification(payload: &mut SignedCatalogPayload) -> crate::SourceEvidence {
    let source_catalog = payload.catalog.source_catalog.as_mut().unwrap();
    let contract_index = source_catalog
        .contracts
        .iter()
        .position(|contract| !contract.supported_variant_ids.is_empty())
        .unwrap();
    let contract = source_catalog.contracts[contract_index].clone();
    let variant_id = contract.supported_variant_ids[0].clone();
    let representation_id = source_catalog
        .identities
        .iter()
        .find(|profile| profile.id == contract.profile_id)
        .unwrap()
        .variants
        .iter()
        .find(|variant| variant.id == variant_id)
        .unwrap()
        .representations[0]
        .id
        .clone();
    let artifact = "d".repeat(64);
    source_catalog.contracts[contract_index].applicability.push(
        crate::SourceContractApplicability {
            upstream_ref: "qualification-fixture-v1".into(),
            artifact_sha256: Some(artifact.clone()),
        },
    );
    let platform = payload
        .catalog
        .ports
        .iter()
        .find(|port| port.id == contract.port_id)
        .unwrap()
        .platforms[0];
    let qualification_evidence_id = "signed-qualification-fixture";
    let qualification_ref = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    source_catalog.evidence.push(crate::CatalogEvidence {
        id: qualification_evidence_id.into(),
        role: crate::CatalogEvidenceRole::PortcoveQualification,
        authority: "Portcove".into(),
        authority_ref: qualification_ref.into(),
        reviewed_at: "2026-09-05".into(),
        claim: "Records the exact isolated signed-catalog fixture".into(),
        immutable_url: format!(
            "https://github.com/boburning/portcove/blob/{qualification_ref}/qualification.json"
        ),
        live_url: None,
    });
    let record = crate::SourceEvidence {
        scope: crate::SourceEvidenceScope {
            port_id: contract.port_id,
            platform,
            artifact_sha256: Some(artifact),
            upstream_ref: Some("qualification-fixture-v1".into()),
            contract_id: Some(contract.id),
            variant: crate::SourceVariantScope::Exact {
                identity: crate::SourceIdentity {
                    game_id: contract.profile_id,
                    variant_id,
                    representation_id,
                },
            },
            check_version: Some("qualification-check-v1".into()),
        },
        kind: crate::SourceEvidenceKind::AutomatedLifecycle,
        outcome: crate::SourceEvidenceOutcome::Passed,
        observed_at: 1_799_999_900,
        portcove_version: Some("0.1.0-alpha.1".into()),
        portcove_commit: Some("a".repeat(40)),
        method: "isolated signed-catalog fixture".into(),
        evidence_ids: vec![qualification_evidence_id.into()],
    };
    source_catalog.qualification.push(record.clone());
    record
}

fn write_candidate(root: &std::path::Path, sequence: i64) -> CatalogUpdateSource {
    let path = root.join(format!("catalog-{sequence}.json"));
    std::fs::write(&path, sign(&fixture(sequence, Library::now()))).unwrap();
    CatalogUpdateSource::File(path)
}

async fn publish(service: &PortcoveService, source: &CatalogUpdateSource) -> CatalogStatus {
    let plan = service.plan_catalog_update(source).await.unwrap();
    service
        .apply_catalog_update(source, &plan.plan_sha256, |_| {})
        .await
        .unwrap()
}

#[test]
fn signatures_reject_untrusted_tampered_weak_and_invalid_documents() {
    let now = 1_800_000_000;
    let key = crate::CatalogTrustKey::from_public_key(&hex::encode(
        signing_key().verifying_key().as_bytes(),
    ))
    .unwrap();
    let keys = [key.clone()];
    let valid = sign(&fixture(1, now));
    assert!(signed_catalog::verify(&valid, &keys, now).is_ok());
    assert!(signed_catalog::verify(&valid, &[], now).is_err());
    assert!(crate::CatalogTrustKey::from_public_key(&"00".repeat(32)).is_err());
    let mut envelope: SignedCatalogEnvelope = serde_json::from_slice(&valid).unwrap();
    envelope.payload.push(' ');
    assert!(signed_catalog::verify(&serde_json::to_vec(&envelope).unwrap(), &keys, now).is_err());
    envelope = serde_json::from_slice(&valid).unwrap();
    envelope.format_version = 2;
    assert!(signed_catalog::verify(&serde_json::to_vec(&envelope).unwrap(), &keys, now).is_err());
    envelope.format_version = 1;
    envelope.signature = "00".repeat(64);
    assert!(signed_catalog::verify(&serde_json::to_vec(&envelope).unwrap(), &keys, now).is_err());
    let mut wrong_key = key;
    wrong_key.public_key = hex::encode(SigningKey::from_bytes(&[8; 32]).verifying_key().as_bytes());
    assert!(signed_catalog::verify(&valid, &[wrong_key], now).is_err());
    for change in [0, 1, 2, 3, 4, 5, 6] {
        let mut payload = fixture(1, now);
        match change {
            0 => payload.expires_at = now,
            1 => payload.issued_at = now + 1,
            2 => payload.sequence = 0,
            3 => payload.catalog.schema_version = 3,
            4 => payload.catalog.source_profiles[0].accepted_sha256.clear(),
            5 => payload.catalog.ports[0]
                .persistent_paths
                .push("new-save-owner".into()),
            _ => {
                payload.catalog.ports.pop();
            }
        }
        // The first embedded profile may use SHA-1 only; force an actual identity change.
        if change == 4 {
            payload.catalog.source_profiles[0]
                .accepted_sha1
                .push("00".repeat(20));
        }
        assert!(
            signed_catalog::verify(&sign(&payload), &keys, now).is_err(),
            "case {change}"
        );
    }
    assert!(signed_catalog::verify(&vec![b' '; MAX_CATALOG_BYTES + 1], &keys, now).is_err());
}

#[test]
fn concurrent_reviewed_updates_have_one_atomic_winner() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path().join("library")).unwrap();
    trusted(&library);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut workers = Vec::new();
    for sequence in [1, 2] {
        let service = PortcoveService::new(library.clone()).unwrap();
        let source = write_candidate(root.path(), sequence);
        let reviewed = runtime
            .block_on(service.plan_catalog_update(&source))
            .unwrap();
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            barrier.wait();
            runtime
                .block_on(service.apply_catalog_update(&source, &reviewed.plan_sha256, |_| {}))
                .is_ok()
        }));
    }
    let successes = workers
        .into_iter()
        .filter_map(|worker| worker.join().unwrap().then_some(()))
        .count();
    assert_eq!(successes, 1);
    let ledger = library.activities(10).unwrap();
    assert_eq!(
        ledger
            .iter()
            .filter(|row| row.status == ActivityStatus::Succeeded)
            .count(),
        1
    );
    assert_eq!(
        ledger
            .iter()
            .filter(|row| row.status == ActivityStatus::Failed)
            .count(),
        1
    );
    let status = library.catalog_status().unwrap();
    assert_eq!(status.provenance.sequence, Some(status.highest_sequence));
}

#[test]
fn signed_runtime_updates_can_change_artifacts_but_not_execution_or_mutable_ownership() {
    let now = 1_800_000_000;
    let key = crate::CatalogTrustKey::from_public_key(&hex::encode(
        signing_key().verifying_key().as_bytes(),
    ))
    .unwrap();
    let mut payload = fixture(1, now);
    let index = payload
        .catalog
        .ports
        .iter()
        .position(|port| port.id == "severed-chains")
        .unwrap();
    for runtime in payload.catalog.ports[index].bundled_runtime.values_mut() {
        runtime.asset.sha256 = "a".repeat(64);
        runtime.asset.url = "https://example.invalid/next-runtime.zip".into();
        runtime.archive_root = "next-runtime".into();
    }
    assert!(signed_catalog::verify(&sign(&payload), std::slice::from_ref(&key), now).is_ok());
    for case in 0..5 {
        let mut changed = payload.clone();
        let port = &mut changed.catalog.ports[index];
        match case {
            0 => {
                port.bundled_runtime
                    .values_mut()
                    .next()
                    .unwrap()
                    .target_directory = "different-root".into()
            }
            1 => {
                port.bundled_runtime.values_mut().next().unwrap().executable =
                    "different-executable".into()
            }
            2 => port.persistent_paths.push("jdk25".into()),
            3 => port
                .persistent_file_patterns
                .push(crate::PersistentFilePattern {
                    prefix: "profile_".into(),
                    suffix: ".sav".into(),
                }),
            _ => port.bundled_runtime.clear(),
        }
        assert!(
            signed_catalog::verify(&sign(&changed), std::slice::from_ref(&key), now).is_err(),
            "case {case}"
        );
    }
}

#[test]
fn signed_format_one_allows_additive_artifact_qualification_only() {
    let now = 1_800_000_000;
    let key = crate::CatalogTrustKey::from_public_key(&hex::encode(
        signing_key().verifying_key().as_bytes(),
    ))
    .unwrap();
    let mut payload = fixture(1, now);
    let record = append_exact_qualification(&mut payload);
    assert!(signed_catalog::verify(&sign(&payload), std::slice::from_ref(&key), now).is_ok());

    let mut unreferenced = payload.clone();
    unreferenced
        .catalog
        .source_catalog
        .as_mut()
        .unwrap()
        .qualification
        .clear();
    assert!(signed_catalog::verify(&sign(&unreferenced), std::slice::from_ref(&key), now).is_err());

    let mut changed_legacy = fixture(1, now);
    let port = changed_legacy
        .catalog
        .ports
        .iter_mut()
        .find(|port| port.id == record.scope.port_id)
        .unwrap();
    if port
        .automated_tested_platforms
        .contains(&record.scope.platform)
    {
        port.automated_tested_platforms
            .retain(|platform| *platform != record.scope.platform);
        port.manually_validated_platforms
            .retain(|platform| *platform != record.scope.platform);
    } else {
        port.automated_tested_platforms.push(record.scope.platform);
    }
    assert!(
        signed_catalog::verify(&sign(&changed_legacy), std::slice::from_ref(&key), now).is_err()
    );

    let mut baseline = fixture(1, now).catalog.source_catalog.unwrap();
    let mut document = fixture(1, now);
    append_exact_qualification(&mut document);
    let with_record = document.catalog.source_catalog.unwrap();
    baseline.contracts = with_record.contracts.clone();
    baseline.qualification = with_record.qualification.clone();
    let mut removed = baseline.clone();
    removed.qualification.clear();
    assert!(
        signed_catalog::validate_source_update_contract(Some(&removed), Some(&baseline)).is_err()
    );
    let mut removed_binding = baseline.clone();
    removed_binding
        .contracts
        .iter_mut()
        .find(|contract| contract.id == record.scope.contract_id.as_deref().unwrap())
        .unwrap()
        .applicability
        .clear();
    assert!(
        signed_catalog::validate_source_update_contract(Some(&removed_binding), Some(&baseline))
            .is_err()
    );
}

#[test]
fn signed_format_one_freezes_source_meaning_and_identity_evidence() {
    let now = 1_800_000_000;
    let key = crate::CatalogTrustKey::from_public_key(&hex::encode(
        signing_key().verifying_key().as_bytes(),
    ))
    .unwrap();
    for case in 0..6 {
        let mut payload = fixture(1, now);
        let source = payload.catalog.source_catalog.as_mut().unwrap();
        match case {
            0 => source.identities[0].id.push_str("-reused"),
            1 => source.identities[0].variants[0].id.push_str("-changed"),
            2 => source.identities[0].variants[0].representations[0]
                .id
                .push_str("-changed"),
            3 => {
                source.contracts[0].admission_mode = match source.contracts[0].admission_mode {
                    crate::CatalogAdmissionMode::Enforced => {
                        crate::CatalogAdmissionMode::Informational
                    }
                    crate::CatalogAdmissionMode::Informational => {
                        crate::CatalogAdmissionMode::Enforced
                    }
                }
            }
            4 => source.evidence[0].claim.push_str(" changed"),
            _ => source.contracts[0].aliases.push("new-meaning".into()),
        }
        assert!(
            signed_catalog::verify(&sign(&payload), std::slice::from_ref(&key), now).is_err(),
            "case {case}"
        );
    }
}

#[tokio::test]
async fn publication_is_offline_snapshot_bound_and_replay_protected() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path().join("library")).unwrap();
    assert_eq!(
        library.catalog_status().unwrap().provenance.origin,
        CatalogOrigin::Embedded
    );
    trusted(&library);
    let service = PortcoveService::new(library.clone()).unwrap();
    let first = write_candidate(root.path(), 1);
    let original_catalog = service.catalog().document().ports[0].summary.clone();
    let one = publish(&service, &first).await;
    assert_eq!(one.provenance.sequence, Some(1));
    assert_eq!(
        service.catalog().document().ports[0].summary,
        original_catalog,
        "commands retain their initial snapshot"
    );
    let fresh = PortcoveService::new(library.clone()).unwrap();
    assert_eq!(
        fresh.catalog().document().ports[0].summary,
        "Synthetic signed metadata 1"
    );
    assert_eq!(fresh.doctor().unwrap().catalog_provenance.sequence, Some(1));
    assert_eq!(
        fresh.plan_catalog_update(&first).await.unwrap_err().code,
        ErrorCode::Verification
    );
}

#[tokio::test]
async fn rollback_keeps_the_replay_floor() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path().join("library")).unwrap();
    trusted(&library);
    let service = PortcoveService::new(library.clone()).unwrap();
    eprintln!("catalog rollback: first publication");
    publish(&service, &write_candidate(root.path(), 1)).await;
    // Snapshot refresh belongs to publication_is_offline_snapshot_bound_and_replay_protected.
    // This case tests two publications and rollback on the same durable library.
    eprintln!("catalog rollback: second publication");
    let second = write_candidate(root.path(), 2);
    let two = publish(&service, &second).await;
    assert!(two.can_rollback);
    eprintln!("catalog rollback: roll back");
    let rollback = library.rollback_catalog(&two.state_sha256).unwrap();
    assert_eq!(rollback.highest_sequence, 2);
    assert_eq!(rollback.provenance.sequence, Some(1));
    assert!(!rollback.can_rollback);
    eprintln!("catalog rollback: reject replay");
    assert!(service.plan_catalog_update(&second).await.is_err());
    assert!(
        library
            .activities(20)
            .unwrap()
            .iter()
            .all(|entry| entry.status == ActivityStatus::Succeeded)
    );
}

#[tokio::test]
async fn cache_selection_keeps_the_replay_floor() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path().join("library")).unwrap();
    trusted(&library);
    let service = PortcoveService::new(library.clone()).unwrap();
    publish(&service, &write_candidate(root.path(), 1)).await;
    // Model the durable replay floor after rollback. The public two-publication
    // rollback path is exercised separately; cache selection must not lower it.
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE catalog_state SET highest_sequence=2 WHERE singleton=1",
            [],
        )
        .unwrap();
    let rolled_back = library.catalog_status().unwrap();
    let embedded = library
        .use_embedded_catalog(&rolled_back.state_sha256)
        .unwrap();
    assert_eq!(embedded.provenance.origin, CatalogOrigin::Embedded);
    assert_eq!(embedded.highest_sequence, 2);
    let resumed = library.use_cached_catalog(&embedded.state_sha256).unwrap();
    assert_eq!(resumed.provenance.sequence, Some(1));
    assert_eq!(resumed.highest_sequence, 2);
    assert!(
        library
            .activities(20)
            .unwrap()
            .iter()
            .all(|entry| entry.status == ActivityStatus::Succeeded)
    );
}

#[tokio::test]
async fn corruption_and_expiry_fall_back_without_trusting_bad_metadata() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path().join("library")).unwrap();
    trusted(&library);
    let service = PortcoveService::new(library.clone()).unwrap();
    publish(&service, &write_candidate(root.path(), 1)).await;
    publish(&service, &write_candidate(root.path(), 2)).await;
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE catalog_state SET active=?1",
            [b"bad signature".as_slice()],
        )
        .unwrap();
    let fallback = library.catalog_status().unwrap();
    assert_eq!(fallback.provenance.origin, CatalogOrigin::SignedPrevious);
    assert_eq!(fallback.provenance.sequence, Some(1));
    assert!(!fallback.provenance.fallback_reasons.is_empty());
    let now = Library::now();
    let state = CatalogState::read(&library.connection().unwrap()).unwrap();
    assert_eq!(
        state.resolve(now + 7200).unwrap().1.origin,
        CatalogOrigin::Embedded
    );
}

#[tokio::test]
async fn revoked_catalog_keys_preserve_the_replay_floor() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path().join("library")).unwrap();
    trusted(&library);
    let service = PortcoveService::new(library.clone()).unwrap();
    let next = publish(&service, &write_candidate(root.path(), 3)).await;
    let revoked = library
        .revoke_catalog_key(&next.trusted_keys[0].key_id, &next.state_sha256)
        .unwrap();
    assert_eq!(revoked.provenance.origin, CatalogOrigin::Embedded);
    assert_eq!(revoked.highest_sequence, 3);
    trusted(&library);
    assert!(
        service
            .plan_catalog_update(&write_candidate(root.path(), 3))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn stale_review_cancel_and_failed_commit_never_activate_a_candidate() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path().join("library")).unwrap();
    trusted(&library);
    let service = PortcoveService::new(library.clone()).unwrap();
    let source = write_candidate(root.path(), 1);
    let plan = service.plan_catalog_update(&source).await.unwrap();
    library
        .trust_catalog_key(&hex::encode(
            SigningKey::from_bytes(&[9; 32]).verifying_key().as_bytes(),
        ))
        .unwrap();
    assert_eq!(
        service
            .apply_catalog_update(&source, &plan.plan_sha256, |_| {})
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let plan = service.plan_catalog_update(&source).await.unwrap();
    let cancelled = service
        .apply_catalog_update(&source, &plan.plan_sha256, |event| {
            if matches!(event.event, crate::OperationEventKind::Started) {
                assert!(service.request_cancellation(&event.operation_id).is_ok());
            }
        })
        .await
        .unwrap_err();
    assert_eq!(cancelled.code, ErrorCode::Cancelled);
    assert!(
        library
            .activities(10)
            .unwrap()
            .iter()
            .any(|row| row.status == ActivityStatus::Cancelled)
    );
    library.connection().unwrap().execute_batch("CREATE TRIGGER reject_catalog_commit BEFORE UPDATE OF status ON activity_history WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;").unwrap();
    assert!(
        service
            .apply_catalog_update(&source, &plan.plan_sha256, |_| {})
            .await
            .is_err()
    );
    let status = library.catalog_status().unwrap();
    assert_eq!(status.highest_sequence, 0);
    assert_eq!(status.provenance.origin, CatalogOrigin::Embedded);
    assert!(
        library
            .activities(20)
            .unwrap()
            .iter()
            .all(|row| row.status != ActivityStatus::Running)
    );
}

#[tokio::test]
async fn candidate_changes_and_insecure_delivery_fail_before_publication() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path().join("library")).unwrap();
    trusted(&library);
    let service = PortcoveService::new(library.clone()).unwrap();
    let source = write_candidate(root.path(), 1);
    let plan = service.plan_catalog_update(&source).await.unwrap();
    let CatalogUpdateSource::File(path) = &source else {
        panic!()
    };
    std::fs::write(path, sign(&fixture(2, Library::now()))).unwrap();
    assert_eq!(
        service
            .apply_catalog_update(&source, &plan.plan_sha256, |_| {})
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    for url in [
        "http://127.0.0.1/catalog",
        "https://user:secret@example.com/catalog",
        "https://example.com/catalog#fragment",
    ] {
        let error = service
            .plan_catalog_update(&CatalogUpdateSource::Https(url.into()))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Usage);
        assert!(!error.message.contains("secret"));
    }
    let file = std::fs::File::create(path).unwrap();
    file.set_len((MAX_CATALOG_BYTES + 1) as u64).unwrap();
    assert!(service.plan_catalog_update(&source).await.is_err());
    assert_eq!(library.catalog_status().unwrap().highest_sequence, 0);
}
