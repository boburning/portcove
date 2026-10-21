use std::collections::BTreeMap;

use portcove_core::{
    Catalog, CatalogProvenance, CatalogTrustKey, DefinitionCapabilityRequest,
    DefinitionCapabilityRequirement, DefinitionEligibility, DefinitionEligibilityOutcome,
    DefinitionEligibilityReason, DefinitionSelectionStatus,
};
use serde_json::json;

use super::*;

fn update_plan(count: usize) -> CatalogUpdatePlan {
    serde_json::from_value(json!({
        "source": {"kind": "file", "value": "catalog 更新.json"},
        "envelope_sha256": "e".repeat(64),
        "key_id": "publisher-key-完整",
        "sequence": 7,
        "issued_at": 0,
        "expires_at": 3600,
        "changed_port_ids": (0..count).map(|index| format!("port-{index}")).collect::<Vec<_>>(),
        "changed_ports": (0..count).map(|index| json!({"id": format!("port-{index}"), "name": format!("Long 游戏 name {index} \u{1b}[31m")})).collect::<Vec<_>>(),
        "current": {"origin": "embedded", "catalog_sha256": "c".repeat(64), "sequence": null, "key_id": null, "expires_at": null, "fallback_reasons": []},
        "plan_sha256": "p".repeat(64)
    })).unwrap()
}

#[test]
fn update_review_reports_zero_one_many_names_and_full_trust_bindings() {
    for count in [0, 1, 3] {
        let plan = update_plan(count);
        let output = catalog_update_plan(&plan);
        assert!(output.contains(&format!("New or changed port definitions: {count}")));
        for (index, port) in plan.changed_ports.iter().enumerate() {
            assert!(output.contains(&format!("Long 游戏 name {index}")));
            assert!(output.contains(&format!("({})", port.id)));
        }
        for hash in [
            &plan.plan_sha256,
            &plan.envelope_sha256,
            &plan.current.catalog_sha256,
        ] {
            assert!(output.contains(hash));
        }
        assert!(output.contains("publisher-key-完整"));
        assert!(output.contains("Issued: 1970-01-01T00:00:00Z"));
        assert!(output.contains("Expires: 1970-01-01T01:00:00Z"));
        assert!(output.contains("does not list removals"));
        assert!(output.contains("no catalog change has been applied"));
        assert!(!output.contains('\u{1b}'));
    }
}

#[test]
fn update_review_does_not_echo_url_credentials_or_invent_invalid_times() {
    let mut plan = update_plan(0);
    plan.source = CatalogUpdateSource::Https(
        "https://catalog.example/catalog.json?token=PRIVATE-QUERY-CANARY".into(),
    );
    plan.expires_at = i64::MAX;
    let output = catalog_update_plan(&plan);
    assert!(!output.contains("PRIVATE-QUERY-CANARY"));
    assert!(output.contains("[REDACTED]"));
    assert!(output.contains("Unknown time"));
    assert!(output.contains("Repeat the selected --file or --url"));
}

fn authority(configured: bool, installed: bool) -> DefinitionAuthorityReview {
    DefinitionAuthorityReview {
        provisioning_schema: 1,
        configured,
        library_id: "library-名称".into(),
        compiled_anchor_sha256: configured.then(|| "a".repeat(64)),
        installed_anchor_sha256: installed.then(|| "a".repeat(64)),
        installed,
        expected_plan: "f".repeat(64),
    }
}

#[test]
fn authority_review_and_apply_distinguish_unconfigured_unchanged_and_installed() {
    let absent = definition_authority_review(&authority(false, false));
    assert!(absent.contains("no configured definition authority"));
    assert!(!absent.contains("--apply --expected-plan"));
    let review = definition_authority_review(&authority(true, false));
    assert!(review.contains("--apply --expected-plan"));
    assert!(review.contains(&"a".repeat(64)));
    assert!(review.contains(&"f".repeat(64)));
    assert!(review.contains("no authority change has been applied"));
    for changed in [false, true] {
        let output = definition_authority_result(&DefinitionAuthorityProvisioning {
            changed,
            review: authority(true, true),
        });
        assert!(output.contains(if changed {
            "Definition authority installed"
        } else {
            "already installed; no authority change needed"
        }));
        assert!(!output.contains("Review only"));
        assert!(output.contains("does not select a definition or authorize a game operation"));
    }
}

#[test]
fn catalog_mutation_preserves_definition_origin_keys_floor_and_fallbacks() {
    let status = CatalogStatus {
        provenance: CatalogProvenance {
            origin: CatalogOrigin::DefinitionSelected,
            catalog_sha256: "d".repeat(64),
            sequence: Some(9),
            key_id: Some("publisher".into()),
            expires_at: Some(3600),
            fallback_reasons: vec!["Signed candidate expired".into()],
        },
        trusted_keys: vec![CatalogTrustKey {
            key_id: "publisher".into(),
            public_key: "b".repeat(64),
        }],
        highest_sequence: 12,
        updates_enabled: false,
        can_rollback: false,
        can_use_cached: true,
        state_sha256: "s".repeat(64),
    };
    let output = catalog_result(
        "Signed-catalog updates disabled; built-in fallback selected",
        &status,
    );
    assert!(output.contains("Active catalog: selected definition catalog"));
    for full in [
        &status.provenance.catalog_sha256,
        &status.trusted_keys[0].public_key,
        &status.state_sha256,
    ] {
        assert!(output.contains(full));
    }
    assert!(output.contains("12"));
    assert!(output.contains("Signed candidate expired"));
    assert!(output.contains("Installed game files were not updated"));
}

#[test]
fn capability_review_keeps_unsupported_and_unknown_versions_distinct() {
    let report = portcove_core::check_definition_capabilities(&DefinitionCapabilityRequest {
        capability_contract_schema: 1,
        required_capabilities: vec![
            DefinitionCapabilityRequirement {
                template: "n64-recomp-portable".into(),
                minimum_version: 1,
                maximum_version: 1,
            },
            DefinitionCapabilityRequirement {
                template: "future-template".into(),
                minimum_version: 1,
                maximum_version: 2,
            },
            DefinitionCapabilityRequirement {
                template: "generated-cache".into(),
                minimum_version: 99,
                maximum_version: 100,
            },
        ],
    })
    .unwrap();
    let output = definition_capabilities(&report);
    assert!(output.contains("Required versions unavailable"));
    assert!(output.contains("Requirements checked: 3"));
    assert!(output.contains("Template unavailable in this engine"));
    assert!(output.contains("Required version unavailable in this engine"));
    assert!(output.contains("installed version Unavailable"));
    assert!(!output.contains("installed compatible version"));
    assert!(output.contains("does not authenticate a publisher"));
}

#[test]
fn definition_refresh_distinguishes_policy_change_hold_and_no_selection() {
    let result = DefinitionRefresh {
        refresh_schema: 1,
        namespace: "official".into(),
        stable_id: "port-名称".into(),
        disposition: DefinitionRefreshDisposition::Ineligible,
        policy_changed: true,
        launch_assessment_changed: false,
        eligibility: Some(DefinitionEligibility {
            outcome: DefinitionEligibilityOutcome::Hold,
            reason: DefinitionEligibilityReason::MetadataStale,
        }),
        selection: DefinitionSelectionStatus {
            revision: 7,
            selected: None,
            replay_floor: None,
            can_rollback: false,
        },
    };
    let output = definition_refresh(&result);
    assert!(output.contains("existing selection retained"));
    assert!(output.contains("Publisher policy changed: Yes"));
    assert!(output.contains("Launch assessment changed: No"));
    assert!(output.contains("Eligibility: On hold"));
    assert!(output.contains("Selected definition: None"));
    assert!(output.contains("no selected-definition floor recorded"));
    assert!(!output.contains("Authenticated definition selected"));
}

#[test]
fn inert_publication_review_separates_summary_from_exact_file_details() {
    let files = BTreeMap::from([(
        "definitions/index.json".into(),
        br#"{"index_schema":1,"definitions":[],"contents":[]}"#.to_vec(),
    )]);
    let report = portcove_core::inspect_definition_publication_bytes(&files).unwrap();
    let summary = publication_inspection(&report, false);
    assert!(summary.contains("Definitions checked: 0"));
    assert!(summary.contains("Files checked: 1"));
    assert!(summary.contains(&report.index_sha256));
    assert!(summary.contains("No publisher authority was installed"));
    assert!(summary.contains("--technical-details"));
    let details = publication_inspection(&report, true);
    assert!(details.contains("File: definitions/index.json"));
    assert!(details.contains(&report.files[0].sha256));
}

#[test]
fn inert_observation_reports_no_candidate_without_implying_authentication() {
    let catalog = Catalog::embedded().unwrap();
    let port = catalog.port("shipwright").unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/upstream-observation.json");
    let report = portcove_core::inspect_upstream_observation(port, 472575717, &path).unwrap();
    let output = upstream_observation(&report, port);
    assert!(output.contains(&format!("{} (shipwright)", port.name)));
    assert!(output.contains("Latest observed release: None"));
    assert!(output.contains("Channel candidate: None"));
    assert!(output.contains("Provider authentication: Not established"));
    assert!(output.contains("Artifact bytes checked: No"));
    assert!(output.contains("Catalog admission assessed: No"));
    assert!(output.contains("2026-09-09T12:00:01.000Z"));
    assert!(output.contains(&report.facts_sha256));
    assert!(output.contains(&report.catalog_definition_sha256));
    assert!(output.contains("Windows (x64)"));
    assert!(!output.contains("windows-x64"));
}

#[test]
fn inert_proposal_summary_keeps_exact_binding_and_opt_in_definition_hashes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../portcove-core/catalog/catalog.json");
    let report = Catalog::inspect_proposal(&path).unwrap();
    assert!(!report.ports.is_empty());
    let summary = proposal_inspection(&report, false);
    assert!(summary.contains(&report.input_sha256));
    assert!(summary.contains(&format!(
        "Port declarations checked: {}",
        report.ports.len()
    )));
    assert!(summary.contains("--technical-details"));
    assert!(summary.contains("gameplay and publication were not checked"));
    let details = proposal_inspection(&report, true);
    for port in &report.ports {
        assert!(details.contains(&format!("Definition ID: {}", port.port_id)));
        assert!(details.contains(&port.definition_sha256));
        for hash in port.curated_record_sha256.values() {
            assert!(details.contains(hash));
        }
    }
}
