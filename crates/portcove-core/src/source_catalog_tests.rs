use super::*;

fn identity() -> DigestIdentity {
    DigestIdentity {
        scope: DigestScope::CanonicalN64BigEndian,
        sha1: Some("1".repeat(40)),
        sha256: Some("2".repeat(64)),
        crc32: None,
    }
}

fn fixture() -> SourceCatalog {
    SourceCatalog {
        evidence: vec![
            CatalogEvidence {
                id: "upstream-source-table".into(),
                role: CatalogEvidenceRole::UpstreamSupport,
                authority: "Example upstream".into(),
                authority_ref: "0123456789abcdef0123456789abcdef01234567".into(),
                reviewed_at: "2026-09-05".into(),
                claim: "Lists the supported source revision".into(),
                immutable_url: "https://github.com/example/project/blob/0123456789abcdef0123456789abcdef01234567/supported.json".into(),
                live_url: Some("https://github.com/example/project/blob/main/supported.json".into()),
            },
            CatalogEvidence {
                id: "portcove-qualification-run".into(),
                role: CatalogEvidenceRole::PortcoveQualification,
                authority: "Portcove".into(),
                authority_ref: "fedcba9876543210fedcba9876543210fedcba98".into(),
                reviewed_at: "2026-09-05".into(),
                claim: "Records the exact isolated qualification run".into(),
                immutable_url: "https://github.com/example/project/blob/fedcba9876543210fedcba9876543210fedcba98/qualification.json".into(),
                live_url: None,
            },
        ],
        identities: vec![SourceIdentityProfile {
            id: "sample-game".into(),
            label: "Sample Game source".into(),
            kind: SourceIdentityKind::File,
            variants: vec![SourceVariant {
                id: "usa-1-0".into(),
                title: "Sample Game".into(),
                region: Some("USA".into()),
                revision: Some("1.0".into()),
                legacy_projection_only: false,
                product_codes: vec!["NSME".into()],
                representations: vec![SourceRepresentation {
                    id: "canonical-rom".into(),
                    extensions: vec!["z64".into(), "n64".into(), "v64".into()],
                    kind: SourceRepresentationKind::CanonicalN64 {
                        identities: vec![identity()],
                    },
                    evidence_ids: vec!["upstream-source-table".into()],
                }],
                evidence_ids: vec!["upstream-source-table".into()],
            }],
            aliases: vec!["sample-game-old".into()],
            tombstones: vec!["sample-game-withdrawn".into()],
            evidence_gap: None,
        }],
        contracts: vec![PortSourceContract {
            id: "sample-port-source".into(),
            port_id: "sample-port".into(),
            role: PortSourceRole::Game,
            profile_id: "sample-game".into(),
            admission_mode: CatalogAdmissionMode::Enforced,
            supported_variant_ids: vec!["usa-1-0".into()],
            validator_contract_id: None,
            evidence_ids: vec!["upstream-source-table".into()],
            authority_ref: "v1.0.0".into(),
            reviewed_at: "2026-09-05".into(),
            immutable_review_url: "https://github.com/example/project/blob/0123456789abcdef0123456789abcdef01234567/supported.json".into(),
            live_review_url: None,
            evidence_gap: None,
            applicability: vec![SourceContractApplicability {
                upstream_ref: "v1.0.0".into(),
                artifact_sha256: Some("3".repeat(64)),
            }],
            aliases: vec![],
            tombstones: vec![],
        }],
        validators: vec![],
        qualification: vec![],
    }
}

fn qualification(kind: SourceEvidenceKind, outcome: SourceEvidenceOutcome) -> SourceEvidence {
    SourceEvidence {
        scope: SourceEvidenceScope {
            port_id: "sample-port".into(),
            platform: crate::Platform::WindowsX86_64,
            artifact_sha256: Some("3".repeat(64)),
            upstream_ref: Some("v1.0.0".into()),
            contract_id: Some("sample-port-source".into()),
            variant: SourceVariantScope::Exact {
                identity: crate::SourceIdentity {
                    game_id: "sample-game".into(),
                    variant_id: "usa-1-0".into(),
                    representation_id: "canonical-rom".into(),
                },
            },
            check_version: Some("source-check-v1".into()),
        },
        kind,
        outcome,
        observed_at: 1_800_000_000,
        portcove_version: Some("0.1.0-alpha.1".into()),
        portcove_commit: Some("a".repeat(40)),
        method: "isolated lifecycle fixture".into(),
        evidence_ids: vec!["portcove-qualification-run".into()],
    }
}

#[test]
fn valid_typed_source_catalog_keeps_digest_pairs_conjunctive() {
    let catalog = fixture();
    catalog.validate(["sample-port"]).unwrap();
    let value = serde_json::to_value(&catalog).unwrap();
    let pair = &value["identities"][0]["variants"][0]["representations"][0]["identities"][0];
    assert_eq!(pair["scope"], "canonical-n64-big-endian");
    assert_eq!(pair["sha1"].as_str().unwrap().len(), 40);
    assert_eq!(pair["sha256"].as_str().unwrap().len(), 64);
}

#[test]
fn alternatives_are_objects_and_parallel_digest_arrays_are_rejected() {
    let catalog = fixture();
    let mut value = serde_json::to_value(catalog).unwrap();
    let representation = &mut value["identities"][0]["variants"][0]["representations"][0];
    representation.as_object_mut().unwrap().remove("identities");
    representation["accepted_sha1"] = serde_json::json!(["1".repeat(40)]);
    representation["accepted_sha256"] = serde_json::json!(["2".repeat(64)]);
    assert!(serde_json::from_value::<SourceCatalog>(value).is_err());

    let mut value = serde_json::to_value(fixture()).unwrap();
    value["identities"][0]["variants"][0]["representations"][0]["unexpected"] =
        serde_json::json!(true);
    assert!(serde_json::from_value::<SourceCatalog>(value).is_err());
}

#[test]
fn missing_references_duplicate_ids_and_ambiguous_aliases_fail_closed() {
    let mut catalog = fixture();
    catalog.contracts[0].supported_variant_ids = vec!["unknown".into()];
    assert!(catalog.validate(["sample-port"]).is_err());

    let mut catalog = fixture();
    catalog.evidence.push(catalog.evidence[0].clone());
    assert!(catalog.validate(["sample-port"]).is_err());

    let mut catalog = fixture();
    catalog.identities[0].tombstones = vec!["sample-game-old".into()];
    assert!(catalog.validate(["sample-port"]).is_err());

    let mut catalog = fixture();
    let mut second = catalog.identities[0].clone();
    second.id = "another-game".into();
    second.aliases = vec!["sample-game-old".into()];
    catalog.identities.push(second);
    assert!(catalog.validate(["sample-port"]).is_err());
}

#[test]
fn informational_and_enforced_contracts_require_honest_admission_inputs() {
    let mut catalog = fixture();
    catalog.contracts[0].admission_mode = CatalogAdmissionMode::Informational;
    assert!(catalog.validate(["sample-port"]).is_err());
    catalog.contracts[0].evidence_gap = Some("Upstream accepts plausible files by format".into());
    catalog.validate(["sample-port"]).unwrap();

    catalog.contracts[0].admission_mode = CatalogAdmissionMode::Enforced;
    catalog.contracts[0].supported_variant_ids.clear();
    assert!(catalog.validate(["sample-port"]).is_err());
}

#[test]
fn unsafe_evidence_urls_and_incomplete_scopes_fail_closed() {
    for url in [
        "http://example.com/evidence",
        "https://user@example.com/evidence",
        "https://127.0.0.1/evidence",
        "https://10.0.0.1/evidence",
        "https://example.com:8443/evidence",
        "https://example.com/evidence#mutable-fragment",
        "https://github.com/example/project/blob/main/supported.json",
    ] {
        let mut catalog = fixture();
        catalog.evidence[0].immutable_url = url.into();
        assert!(catalog.validate(["sample-port"]).is_err(), "{url}");
    }

    let mut catalog = fixture();
    catalog.evidence[0].authority_ref = "f".repeat(40);
    assert!(catalog.validate(["sample-port"]).is_err());

    let mut catalog = fixture();
    catalog.contracts.push(catalog.contracts[0].clone());
    catalog.contracts[1].id = "sample-port-other-source".into();
    assert!(catalog.validate(["sample-port"]).is_err());

    let mut catalog = fixture();
    catalog.identities[0].variants[0].representations[0].kind = SourceRepresentationKind::RawFile {
        identities: vec![DigestIdentity {
            scope: DigestScope::OriginalFile,
            sha1: None,
            sha256: None,
            crc32: None,
        }],
    };
    assert!(catalog.validate(["sample-port"]).is_err());
}

#[test]
fn pinned_validators_are_referenced_by_stable_contract_id() {
    let mut catalog = fixture();
    catalog.validators.push(SourceValidatorContract {
        id: "sample-validator-v1".into(),
        tool_id: "sample-tool".into(),
        protocol_version: "1".into(),
        evidence_ids: vec!["upstream-source-table".into()],
    });
    catalog.identities[0].variants[0].representations[0].kind =
        SourceRepresentationKind::PinnedValidator {
            validator_contract_id: "sample-validator-v1".into(),
        };
    catalog.contracts[0].supported_variant_ids.clear();
    catalog.contracts[0].validator_contract_id = Some("sample-validator-v1".into());
    catalog.validate(["sample-port"]).unwrap();

    catalog.validators.clear();
    assert!(catalog.validate(["sample-port"]).is_err());
}

#[test]
fn legacy_projection_variants_cannot_be_selected_by_schema_2_contracts() {
    let mut catalog = fixture();
    catalog.identities[0].variants[0].legacy_projection_only = true;
    assert!(catalog.validate(["sample-port"]).is_err());

    let mut current = catalog.identities[0].variants[0].clone();
    current.id = "usa-1-0-current".into();
    current.legacy_projection_only = false;
    let SourceRepresentationKind::CanonicalN64 { identities } =
        &mut current.representations[0].kind
    else {
        panic!("fixture uses canonical N64")
    };
    identities[0].sha256 = Some("3".repeat(64));
    catalog.identities[0].variants.push(current);
    catalog.contracts[0].supported_variant_ids = vec!["usa-1-0-current".into()];
    catalog.validate(["sample-port"]).unwrap();

    let projection = catalog.compatibility_profiles().unwrap();
    assert_eq!(projection[0].accepted_sha256, vec!["2".repeat(64)]);
}

#[test]
fn active_variants_cannot_share_a_deterministic_identity() {
    let mut catalog = fixture();
    let mut duplicate = catalog.identities[0].variants[0].clone();
    duplicate.id = "another-edition".into();
    catalog.identities[0].variants.push(duplicate);
    assert!(catalog.validate(["sample-port"]).is_err());

    catalog.identities[0].variants[1].legacy_projection_only = true;
    catalog.validate(["sample-port"]).unwrap();
}

#[test]
fn exact_qualification_validates_and_aggregates_each_evidence_kind_separately() {
    let mut catalog = fixture();
    for (kind, outcome) in [
        (
            SourceEvidenceKind::StructuralCheck,
            SourceEvidenceOutcome::Passed,
        ),
        (
            SourceEvidenceKind::AutomatedLifecycle,
            SourceEvidenceOutcome::Passed,
        ),
        (SourceEvidenceKind::HandsOn, SourceEvidenceOutcome::NotRun),
        (
            SourceEvidenceKind::KnownFailure,
            SourceEvidenceOutcome::Failed,
        ),
    ] {
        let mut record = qualification(kind, outcome);
        record.observed_at += catalog.qualification.len() as i64;
        catalog.qualification.push(record);
    }
    catalog.validate(["sample-port"]).unwrap();
    let aggregate = catalog.assess_qualification(
        &qualification(
            SourceEvidenceKind::AutomatedLifecycle,
            SourceEvidenceOutcome::Passed,
        )
        .scope,
    );
    assert_eq!(
        aggregate.structural_check,
        QualificationEvidenceState::Passed
    );
    assert_eq!(
        aggregate.automated_lifecycle,
        QualificationEvidenceState::Passed
    );
    assert_eq!(aggregate.hands_on, QualificationEvidenceState::NotRun);
    assert_eq!(aggregate.known_failure, QualificationEvidenceState::Failed);
    assert!(
        catalog
            .all_supported_sources_qualified(
                "sample-port-source",
                crate::Platform::WindowsX86_64,
                "v1.0.0",
                &"3".repeat(64),
                "source-check-v1",
                SourceEvidenceKind::AutomatedLifecycle,
            )
            .unwrap()
    );
}

#[test]
fn new_variant_representation_and_artifact_never_inherit_exact_qualification() {
    let mut catalog = fixture();
    catalog.qualification.push(qualification(
        SourceEvidenceKind::AutomatedLifecycle,
        SourceEvidenceOutcome::Passed,
    ));
    assert!(
        catalog
            .all_supported_sources_qualified(
                "sample-port-source",
                crate::Platform::WindowsX86_64,
                "v1.0.0",
                &"3".repeat(64),
                "source-check-v1",
                SourceEvidenceKind::AutomatedLifecycle,
            )
            .unwrap()
    );

    let mut new_representation = catalog.identities[0].variants[0].representations[0].clone();
    new_representation.id = "byte-swapped-rom".into();
    catalog.identities[0].variants[0]
        .representations
        .push(new_representation);
    assert!(
        !catalog
            .all_supported_sources_qualified(
                "sample-port-source",
                crate::Platform::WindowsX86_64,
                "v1.0.0",
                &"3".repeat(64),
                "source-check-v1",
                SourceEvidenceKind::AutomatedLifecycle,
            )
            .unwrap()
    );

    let mut catalog = fixture();
    catalog.qualification.push(qualification(
        SourceEvidenceKind::AutomatedLifecycle,
        SourceEvidenceOutcome::Passed,
    ));
    let mut new_variant = catalog.identities[0].variants[0].clone();
    new_variant.id = "usa-1-1".into();
    let SourceRepresentationKind::CanonicalN64 { identities } =
        &mut new_variant.representations[0].kind
    else {
        panic!("fixture uses canonical N64")
    };
    identities[0].sha1 = Some("4".repeat(40));
    identities[0].sha256 = Some("5".repeat(64));
    catalog.identities[0].variants.push(new_variant);
    catalog.contracts[0]
        .supported_variant_ids
        .push("usa-1-1".into());
    catalog.validate(["sample-port"]).unwrap();
    assert!(
        !catalog
            .all_supported_sources_qualified(
                "sample-port-source",
                crate::Platform::WindowsX86_64,
                "v1.0.0",
                &"3".repeat(64),
                "source-check-v1",
                SourceEvidenceKind::AutomatedLifecycle,
            )
            .unwrap()
    );

    let mut catalog = fixture();
    catalog.qualification.push(qualification(
        SourceEvidenceKind::AutomatedLifecycle,
        SourceEvidenceOutcome::Passed,
    ));
    assert!(
        !catalog
            .all_supported_sources_qualified(
                "sample-port-source",
                crate::Platform::WindowsX86_64,
                "v1.0.0",
                &"4".repeat(64),
                "source-check-v1",
                SourceEvidenceKind::AutomatedLifecycle,
            )
            .unwrap()
    );
}

#[test]
fn incomplete_or_misaligned_qualification_scopes_fail_closed() {
    for case in 0..8 {
        let mut catalog = fixture();
        let mut record = qualification(
            SourceEvidenceKind::AutomatedLifecycle,
            SourceEvidenceOutcome::Passed,
        );
        match case {
            0 => record.scope.artifact_sha256 = None,
            1 => record.scope.upstream_ref = Some("v2".into()),
            2 => record.scope.contract_id = Some("missing-contract".into()),
            3 => {
                let SourceVariantScope::Exact { identity } = &mut record.scope.variant else {
                    panic!()
                };
                identity.variant_id = "missing-variant".into();
            }
            4 => {
                let SourceVariantScope::Exact { identity } = &mut record.scope.variant else {
                    panic!()
                };
                identity.representation_id = "missing-representation".into();
            }
            5 => record.evidence_ids = vec!["missing-evidence".into()],
            6 => record.method.clear(),
            _ => {
                record.kind = SourceEvidenceKind::KnownFailure;
                record.outcome = SourceEvidenceOutcome::Passed;
            }
        }
        catalog.qualification.push(record);
        assert!(catalog.validate(["sample-port"]).is_err(), "case {case}");
    }
}
