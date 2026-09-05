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
        evidence: vec![CatalogEvidence {
            id: "upstream-source-table".into(),
            role: CatalogEvidenceRole::UpstreamSupport,
            authority: "Example upstream".into(),
            authority_ref: "0123456789abcdef0123456789abcdef01234567".into(),
            reviewed_at: "2026-09-05".into(),
            claim: "Lists the supported source revision".into(),
            immutable_url: "https://github.com/example/project/blob/0123456789abcdef0123456789abcdef01234567/supported.json".into(),
            live_url: Some("https://github.com/example/project/blob/main/supported.json".into()),
        }],
        identities: vec![SourceIdentityProfile {
            id: "sample-game".into(),
            label: "Sample Game source".into(),
            kind: SourceIdentityKind::File,
            variants: vec![SourceVariant {
                id: "usa-1-0".into(),
                title: "Sample Game".into(),
                region: Some("USA".into()),
                revision: Some("1.0".into()),
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
