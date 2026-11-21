use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

fn target(bytes: &[u8]) -> String {
    format!("sha256/{}.json", hex::encode(Sha256::digest(bytes)))
}

fn projection() -> Value {
    let catalog = crate::test_fixture::indexed_fixture_document(&Catalog::embedded().unwrap());
    json!({
        "contract_schema": 1, "representation": "catalog_projection",
        "catalog": catalog
    })
}

#[test]
fn canonical_projection_materializes_typed_defaults_and_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("projection.json");
    let mut sparse = generic_projection();
    sparse["catalog"]["ports"]
        .as_array_mut()
        .unwrap()
        .truncate(1);
    sparse["catalog"]["source_catalog"]["contracts"]
        .as_array_mut()
        .unwrap()
        .truncate(1);
    let port = sparse["catalog"]["ports"][0].as_object_mut().unwrap();
    port.remove("launch_arguments");
    port.remove("launch_environment");
    port["release"].as_object_mut().unwrap().remove("provider");
    std::fs::write(&path, serde_json::to_vec(&sparse).unwrap()).unwrap();

    let canonical = canonical_definition_projection(&path).unwrap();
    let document: Value = serde_json::from_str(&canonical).unwrap();
    assert_eq!(
        document["catalog"]["ports"][0]["launch_arguments"],
        json!([])
    );
    assert_eq!(
        document["catalog"]["ports"][0]["release"]["provider"],
        "github"
    );
    let contract = canonical.as_bytes();
    assert!(inspect(&entry(&document, contract, 0), contract).is_ok());

    std::fs::write(&path, contract).unwrap();
    assert_eq!(canonical_definition_projection(&path).unwrap(), canonical);

    sparse["catalog"]["ports"][0]["unsupported_authored_field"] = json!(true);
    std::fs::write(&path, serde_json::to_vec(&sparse).unwrap()).unwrap();
    assert!(canonical_definition_projection(&path).is_err());
}

#[test]
fn legacy_chameleon_projection_adds_only_its_reviewed_contract_to_schema_three() {
    // The retained qualification bundle contains the exact published index,
    // entry and terminal contract, before it was applied to a schema-3 client.
    let index = DefinitionContentIndex::parse(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/qualification/chameleon-twist-jp-managed-bundle-2026-10-30/bundle/definitions/index.json",
    )))
    .unwrap();
    let entry = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/qualification/chameleon-twist-jp-managed-bundle-2026-10-30/bundle/sha256/7094da5e80069bcd2ce69c6a6ac31027fce2e6d24172e0c21712ecfd4c8ef6b4.json",
    ));
    let contract = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/qualification/chameleon-twist-jp-managed-bundle-2026-10-30/bundle/sha256/beaf84046b4bcbda4cf4ba79246faa688f643e134f35bd4a7cbfa38101624e8d.json",
    ));
    let port_id = "chameleon-twist-jp-recompiled";
    let projection = index
        .inspect_catalog_projection("official", port_id, entry, contract)
        .unwrap();
    assert_eq!(projection.catalog().document().schema_version, 2);
    assert_eq!(projection.catalog().ports().len(), 1);

    let baseline = Catalog::embedded().unwrap();
    assert_eq!(baseline.document().schema_version, 3);
    let effective = projection.catalog_for_selection(&baseline).unwrap();
    assert_eq!(effective.document().schema_version, 3);
    assert_eq!(effective.ports().len(), baseline.ports().len() + 1);
    assert_eq!(
        serde_json::to_value(&effective.ports()[..baseline.ports().len()]).unwrap(),
        serde_json::to_value(baseline.ports()).unwrap(),
    );
    assert_eq!(
        serde_json::to_value(effective.port(port_id).unwrap()).unwrap(),
        serde_json::to_value(projection.entry().port()).unwrap(),
    );
    assert!(std::ptr::eq(
        projection.snapshot(),
        effective.definition_snapshot(port_id).unwrap(),
    ));

    // A sparse older projection cannot replace an ID already in the baseline.
    let error = projection.catalog_for_selection(&effective).unwrap_err();
    assert!(error.message.contains("catalog schema changed"));

    let mut colliding = baseline.authoritative_document();
    let duplicate = projection.catalog().source_catalog().unwrap().evidence[0].clone();
    colliding
        .source_catalog
        .as_mut()
        .unwrap()
        .evidence
        .push(duplicate);
    let colliding = Catalog::from_document(colliding).unwrap();
    let error = projection.catalog_for_selection(&colliding).unwrap_err();
    assert!(error.message.contains("duplicate evidence id"), "{error}");
}

#[test]
fn exact_schema_three_crawl_projection_adds_and_replaces_only_its_port() {
    // Keep the exact initial public bodies independent of active bundle revisions.
    let entry =
        include_bytes!("../tests/fixtures/definition-projection/crawl-initial-entry.json.txt");
    let contract =
        include_bytes!("../tests/fixtures/definition-projection/crawl-initial-contract.json.txt");
    assert_eq!(
        hex::encode(Sha256::digest(entry)),
        "19c3c379ae5fa5c852fc4d216bd7af2cdd2bc72560f5b7a5c7d89f344d86ccec",
    );
    assert_eq!(
        hex::encode(Sha256::digest(contract)),
        "73517c5ddcce5db85571b70712ed3892d2048c5e4aa41adec91268cdba3efc62",
    );
    let parsed_entry: Value = serde_json::from_slice(entry).unwrap();
    let port_id = "dungeon-crawl-stone-soup";
    let projection = index(&[(&parsed_entry, entry)], contract)
        .inspect_catalog_projection("official", port_id, entry, contract)
        .unwrap();
    assert_eq!(projection.catalog().document().schema_version, 3);
    assert_eq!(projection.catalog().ports().len(), 1);

    // Preview.9 did not embed Crawl. Keep the actual catalog's other records.
    let mut document = Catalog::embedded().unwrap().authoritative_document();
    document.ports.retain(|port| port.id != port_id);
    let baseline = Catalog::from_document(document).unwrap();
    let effective = projection.catalog_for_selection(&baseline).unwrap();
    assert_eq!(effective.ports().len(), baseline.ports().len() + 1);
    assert_eq!(
        serde_json::to_value(&effective.ports()[..baseline.ports().len()]).unwrap(),
        serde_json::to_value(baseline.ports()).unwrap(),
    );
    assert_eq!(baseline.source_catalog(), effective.source_catalog());
    assert!(std::ptr::eq(
        projection.snapshot(),
        effective.definition_snapshot(port_id).unwrap(),
    ));

    // An existing implementation may also receive an executable-path repair.
    let mut existing = effective.authoritative_document();
    let port = existing.ports.last_mut().unwrap();
    assert_eq!(port.id, port_id);
    port.executable_hints.insert(
        crate::Platform::WindowsX86_64,
        vec!["obsolete-crawl.exe".into()],
    );
    let existing = Catalog::from_document(existing).unwrap();
    let replaced = projection.catalog_for_selection(&existing).unwrap();
    assert_eq!(
        serde_json::to_value(replaced.authoritative_document()).unwrap(),
        serde_json::to_value(effective.authoritative_document()).unwrap(),
    );

    // A scoped override must not erase an already-reviewed package layout.
    let mut held = effective.authoritative_document();
    held.ports
        .last_mut()
        .unwrap()
        .reviewed_package_layouts
        .insert(
            crate::Platform::WindowsX86_64,
            crate::ReviewedPackageLayout {
                directories: vec!["dat".into(), "docs".into(), "settings".into()],
                executables: vec!["crawl.exe".into()],
                ignore_verified_macos_libraries: false,
                classify_linux_programs_by_format: false,
            },
        );
    let held = Catalog::from_document(held).unwrap();
    let error = projection.catalog_for_selection(&held).unwrap_err();
    assert!(
        error
            .message
            .contains("reviewed package layout was removed")
    );
}

#[test]
fn legacy_crawl_layout_correction_preserves_historical_and_current_presentation() {
    let contract = include_bytes!(
        "../tests/fixtures/definition-projection/crawl-reviewed-layout-contract.json.txt"
    );
    assert_eq!(
        hex::encode(Sha256::digest(contract)),
        "ff36ac51cacb397fa1d006fecc1223fb1d2ba7b47ee9a611bf7a119a0ef7f90f",
    );
    let legacy: Value = serde_json::from_slice(contract).unwrap();
    let selected = "dungeon-crawl-stone-soup";
    let select = |legacy: &Value, baseline: &Catalog| {
        let bytes = serde_json::to_vec(legacy).unwrap();
        inspect(&entry(legacy, &bytes, 0), &bytes)?.catalog_for_selection(baseline)
    };
    let mut document = Catalog::embedded().unwrap().authoritative_document();
    let previous = document
        .ports
        .iter_mut()
        .find(|port| port.id == selected)
        .unwrap();
    previous.reviewed_package_layouts.clear();
    let current_baseline = Catalog::from_document(document.clone()).unwrap();
    let current_title = current_baseline
        .port(selected)
        .unwrap()
        .presentation
        .as_ref()
        .unwrap()
        .original_game_title
        .as_deref()
        .unwrap();
    assert_eq!(current_title, "Dungeon Crawl Stone Soup");
    // The immutable legacy contract describes the historical title. Its layout
    // correction must not gain authority to replace newer presentation.
    document
        .ports
        .iter_mut()
        .find(|port| port.id == selected)
        .unwrap()
        .presentation
        .as_mut()
        .unwrap()
        .original_game_title = Some(
        legacy["catalog"]["ports"][0]["presentation"]["original_game_title"]
            .as_str()
            .unwrap()
            .to_owned(),
    );
    let baseline = Catalog::from_document(document).unwrap();
    let effective = inspect(&entry(&legacy, contract, 0), contract)
        .unwrap()
        .catalog_for_selection(&baseline)
        .unwrap();
    assert_eq!(effective.source_catalog(), baseline.source_catalog());
    assert_eq!(effective.ports().len(), baseline.ports().len());
    assert_eq!(
        effective.port(selected).unwrap().reviewed_package_layouts[&crate::Platform::WindowsX86_64]
            .executables,
        ["crawl.exe"],
    );
    for (before, after) in baseline.ports().iter().zip(effective.ports()) {
        if before.id != selected {
            assert_eq!(
                serde_json::to_value(before).unwrap(),
                serde_json::to_value(after).unwrap()
            );
        }
    }
    let mut changed = legacy.clone();
    changed["catalog"]["ports"][0]["summary"] = json!("Different valid description");
    let changed_bytes = serde_json::to_vec(&changed).unwrap();
    let changed_projection = inspect(&entry(&changed, &changed_bytes, 0), &changed_bytes).unwrap();
    assert!(changed_projection.catalog_for_selection(&baseline).is_err());
    changed = legacy.clone();
    changed["catalog"]["ports"][0]["reviewed_package_layouts"] = json!({});
    assert!(select(&changed, &effective).is_err());

    assert!(select(&legacy, &current_baseline).is_err());
    let mut corrected = legacy.clone();
    corrected["catalog"]["ports"][0]["presentation"]["original_game_title"] = json!(current_title);
    let corrected_effective = select(&corrected, &current_baseline).unwrap();
    assert_eq!(
        corrected_effective.source_catalog(),
        current_baseline.source_catalog()
    );
    assert_eq!(
        corrected_effective.ports().len(),
        current_baseline.ports().len()
    );
    let mut expected_port = current_baseline.port(selected).unwrap().clone();
    expected_port.reviewed_package_layouts = effective
        .port(selected)
        .unwrap()
        .reviewed_package_layouts
        .clone();
    assert_eq!(
        serde_json::to_value(corrected_effective.port(selected).unwrap()).unwrap(),
        serde_json::to_value(expected_port).unwrap()
    );
    for (before, after) in current_baseline
        .ports()
        .iter()
        .zip(corrected_effective.ports())
    {
        if before.id != selected {
            assert_eq!(
                serde_json::to_value(before).unwrap(),
                serde_json::to_value(after).unwrap()
            );
        }
    }
}

#[test]
fn sparse_schema_three_reuses_exact_shared_source_records_and_rejects_conflicts() {
    let mut full = generic_projection();
    full["catalog"]["schema_version"] = json!(3);
    let graph = &mut full["catalog"]["source_catalog"];
    let mut sibling_evidence = graph["evidence"][0].clone();
    sibling_evidence["id"] = json!("sibling-source-byte-evidence");
    graph["evidence"]
        .as_array_mut()
        .unwrap()
        .push(sibling_evidence);
    graph["contracts"][1]["evidence_ids"] = json!(["sibling-source-byte-evidence"]);
    graph["validators"] = json!([{
        "id": "shared-fixture-validator", "tool_id": "fixture-check",
        "protocol_version": "1", "evidence_ids": ["fixture-bytes"]
    }]);
    for contract in graph["contracts"].as_array_mut().unwrap() {
        contract["validator_contract_id"] = json!("shared-fixture-validator");
    }
    let baseline = Catalog::from_json(&full["catalog"].to_string()).unwrap();

    let mut sparse = full.clone();
    sparse["catalog"]["ports"]
        .as_array_mut()
        .unwrap()
        .truncate(1);
    sparse["catalog"]["ports"][0]["summary"] = json!("Reviewed fixture correction");
    let graph = &mut sparse["catalog"]["source_catalog"];
    graph["evidence"].as_array_mut().unwrap().truncate(1);
    graph["contracts"].as_array_mut().unwrap().truncate(1);
    let mut selected_evidence = graph["evidence"][0].clone();
    selected_evidence["id"] = json!("new-selected-source-byte-evidence");
    graph["evidence"]
        .as_array_mut()
        .unwrap()
        .push(selected_evidence);
    graph["contracts"][0]["evidence_ids"] =
        json!(["fixture-bytes", "new-selected-source-byte-evidence"]);

    let select = |document: &Value| {
        let bytes = serde_json::to_vec(document).unwrap();
        inspect(&entry(document, &bytes, 0), &bytes)?.catalog_for_selection(&baseline)
    };
    let effective = select(&sparse).unwrap();
    let before = baseline.source_catalog().unwrap();
    let after = effective.source_catalog().unwrap();
    assert_eq!(
        &after.evidence[..before.evidence.len()],
        before.evidence.as_slice()
    );
    assert_eq!(
        after.evidence.last().unwrap().id,
        "new-selected-source-byte-evidence"
    );
    assert_eq!(after.identities, before.identities);
    assert_eq!(after.validators, before.validators);
    assert_eq!(
        after
            .contracts
            .iter()
            .find(|row| row.port_id == "projection-sibling"),
        before
            .contracts
            .iter()
            .find(|row| row.port_id == "projection-sibling"),
    );
    assert_eq!(
        effective.port("projection-fixture").unwrap().summary,
        "Reviewed fixture correction",
    );

    for (collection, field, value) in [
        ("evidence", "claim", "Changed evidence"),
        ("identities", "label", "Changed identity"),
        ("validators", "protocol_version", "2"),
    ] {
        let mut conflicting = sparse.clone();
        conflicting["catalog"]["source_catalog"][collection][0][field] = json!(value);
        let error = select(&conflicting).unwrap_err();
        assert!(
            error.message.contains("projected source record conflicts"),
            "{error}"
        );
    }
}

#[test]
fn complete_schema_three_one_port_keeps_graph_order_checks() {
    let mut full = generic_projection();
    full["catalog"]["schema_version"] = json!(3);
    full["catalog"]["ports"].as_array_mut().unwrap().truncate(1);
    let graph = &mut full["catalog"]["source_catalog"];
    graph["contracts"].as_array_mut().unwrap().truncate(1);
    let mut additional = graph["evidence"][0].clone();
    additional["id"] = json!("additional-fixture-bytes");
    graph["evidence"].as_array_mut().unwrap().push(additional);
    graph["contracts"][0]["evidence_ids"] = json!(["fixture-bytes", "additional-fixture-bytes"]);
    let baseline = Catalog::from_json(&full["catalog"].to_string()).unwrap();

    let select = |document: &Value| {
        let bytes = serde_json::to_vec(document).unwrap();
        inspect(&entry(document, &bytes, 0), &bytes)?.catalog_for_selection(&baseline)
    };
    let effective = select(&full).unwrap();
    assert_eq!(effective.source_catalog(), baseline.source_catalog());
    full["catalog"]["source_catalog"]["evidence"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let error = select(&full).unwrap_err();
    assert!(error.message.contains("source evidence order"), "{error}");
}

#[test]
fn indexed_upstream_review_requires_matching_new_schemas() {
    let mut document = generic_projection();
    document["catalog"]["ports"][0]["upstream_active_reviewed"] = json!(true);
    let contract = serde_json::to_vec(&document).unwrap();
    let mut selected = entry(&document, &contract, 0);
    assert!(
        inspect(&selected, &contract)
            .unwrap_err()
            .message
            .contains("schema 2")
    );
    selected["definition_schema"] = json!(2);
    assert!(inspect(&selected, &contract).is_err());

    document["contract_schema"] = json!(2);
    let contract = serde_json::to_vec(&document).unwrap();
    let mut selected = entry(&document, &contract, 0);
    selected["definition_schema"] = json!(2);
    let projected = inspect(&selected, &contract).unwrap();
    assert_eq!(
        projected
            .catalog()
            .port("projection-fixture")
            .unwrap()
            .declared_upstream_status(),
        Some(crate::UpstreamStatus::Active)
    );
}

#[test]
fn retained_indexed_selection_uses_current_unrelated_upstream_review() {
    let legacy = generic_projection();
    let contract = serde_json::to_vec(&legacy).unwrap();
    let entry = entry(&legacy, &contract, 0);
    let projection = inspect(&entry, &contract).unwrap();
    let mut baseline = legacy["catalog"].clone();
    baseline["ports"][1]["upstream_active_reviewed"] = json!(true);
    let baseline = Catalog::from_json(&baseline.to_string()).unwrap();
    assert!(
        crate::definition_loader::validate_definition_transition(
            &baseline,
            projection.catalog(),
            "projection-fixture"
        )
        .is_err()
    );
    let retained = projection.catalog_for_selection(&baseline).unwrap();
    assert_eq!(
        retained
            .port("projection-sibling")
            .unwrap()
            .declared_upstream_status(),
        Some(crate::UpstreamStatus::Active)
    );
    assert!(
        retained
            .port("projection-fixture")
            .unwrap()
            .declared_upstream_status()
            .is_none()
    );
}

#[test]
fn indexed_projection_cannot_supply_reviewed_package_choices() {
    let mut document = projection();
    let port_index = document["catalog"]["ports"]
        .as_array()
        .unwrap()
        .iter()
        .position(|port| port["id"] == "jagged-alliance-2-ja2-stracciatella")
        .unwrap();
    let untreated = serde_json::to_vec(&document).unwrap();
    assert!(inspect(&entry(&document, &untreated, port_index), &untreated).is_ok());
    document["catalog"]["ports"][port_index]["release"]["reviewed_package_choices_v2"] = json!({
        "repository_id": 51_711_866,
        "prefix": "ja2-stracciatella_",
        "choices": {
            "mingw64-cross": "_win-mingw64-cross.zip",
            "msvc64-142": "_win-msvc64-142.zip"
        },
    });
    let contract = serde_json::to_vec(&document).unwrap();
    let error = inspect(&entry(&document, &contract, port_index), &contract).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported);
    assert!(
        error
            .message
            .contains("cannot deliver reviewed package choices")
    );
}

#[test]
fn catalog_projection_refuses_embedded_only_patterns_in_sibling_ports() {
    let catalog = Catalog::embedded().unwrap();
    let document = json!({
        "contract_schema": 1, "representation": "catalog_projection",
        "catalog": catalog.authoritative_document()
    });
    let contract = serde_json::to_vec(&document).unwrap();
    let selected = entry(&document, &contract, 0);
    assert_ne!(selected["stable_id"], "opentyrian-opentyrian");
    let error = inspect(&selected, &contract).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported);
    assert!(error.message.contains("embedded-only"));
}

// Malformed-contract checks need a complete source graph and two siblings,
// not title-specific catalog contents. Keep projection() for real catalog contracts.
fn generic_projection() -> Value {
    let mut document = json!({
        "schema_version": 2,
        "source_catalog": {
            "evidence": [{
                "id": "fixture-bytes", "role": "byte_identity",
                "authority": "Synthetic projection fixture", "authority_ref": "fixture-1",
                "reviewed_at": "2026-09-30", "claim": "Synthetic source byte identity",
                "immutable_url": "https://example.invalid/fixtures/source-v1"
            }],
            "identities": [{
                "id": "projection-source", "label": "Synthetic source",
                "kind": "file", "variants": [{
                    "id": "fixture-1", "title": "Synthetic source",
                    "representations": [{
                        "id": "raw", "extensions": ["bin"], "kind": "raw-file",
                        "identities": [{"scope": "original-file", "sha256": "8".repeat(64)}],
                        "evidence_ids": ["fixture-bytes"]
                    }], "evidence_ids": ["fixture-bytes"]
                }]
            }],
            "contracts": [{
                "id": "projection-fixture-game", "port_id": "projection-fixture",
                "role": "game", "profile_id": "projection-source",
                "admission_mode": "enforced", "supported_variant_ids": ["fixture-1"],
                "evidence_ids": ["fixture-bytes"], "authority_ref": "fixture-1",
                "reviewed_at": "2026-09-30",
                "immutable_review_url": "https://example.invalid/fixtures/source-v1"
            }], "validators": []
        },
        "ports": [{
            "id": "projection-fixture", "name": "Projection fixture",
            "summary": "Synthetic malformed-contract fixture",
            "project_url": "https://example.invalid/fixtures/projection", "support_tier": "stable",
            "channels": ["stable"], "platforms": ["linux-x86-64"],
            "adapter": "libultraship-portable",
            "release": {"repository": "fixture/projection"},
            "source_profile": "projection-source",
            "executable_hints": {"linux-x86-64": ["fixture"]},
            "persistent_paths": ["saves", "config.json"]
        }]
    });
    let mut sibling = document["ports"][0].clone();
    sibling["id"] = json!("projection-sibling");
    sibling["name"] = json!("Projection sibling");
    document["ports"].as_array_mut().unwrap().push(sibling);
    let mut contract = document["source_catalog"]["contracts"][0].clone();
    contract["id"] = json!("projection-sibling-game");
    contract["port_id"] = json!("projection-sibling");
    document["source_catalog"]["contracts"]
        .as_array_mut()
        .unwrap()
        .push(contract);
    let catalog = Catalog::from_json(&document.to_string()).unwrap();
    json!({
        "contract_schema": 1, "representation": "catalog_projection",
        "catalog": catalog.authoritative_document()
    })
}

#[test]
fn original_recognition_projection_requires_the_explicit_reader_capability() {
    let mut document = generic_projection();
    let source = &mut document["catalog"]["source_catalog"]["contracts"][0];
    source["admission_mode"] = json!("informational");
    source["evidence_gap"] = json!("Optional upstream recognition for this artifact.");
    source["variant_list_recognition_only"] = json!(true);
    source["applicability"] = json!([{
        "upstream_ref": "fixture-1", "artifact_sha256": "a".repeat(64)
    }]);
    let contract = serde_json::to_vec(&document).unwrap();
    let mut selected = entry(&document, &contract, 0);
    let error = inspect(&selected, &contract).unwrap_err();
    assert!(
        error
            .message
            .contains("libultraship-portable capability version 7")
    );
    selected["required_capabilities"] = json!([{
        "template": "libultraship-portable", "minimum_version": 7, "maximum_version": 7
    }]);
    inspect(&selected, &contract).unwrap();
    let sibling = entry(&document, &contract, 1);
    assert!(
        inspect(&sibling, &contract)
            .unwrap_err()
            .message
            .contains("selected definition")
    );
}

#[test]
fn exact_n64_release_input_projection_requires_its_own_reader_and_port() {
    let mut document = generic_projection();
    let port = &mut document["catalog"]["ports"][0];
    port["adapter"] = json!("n64-recomp-portable");
    port["runtime_source_filename"] = json!("fixture.us.z64");
    port["persistent_paths"] = json!(["saves", "config.json", "fixture.us.z64"]);
    let sources = &mut document["catalog"]["source_catalog"];
    sources["evidence"].as_array_mut().unwrap().push(json!({
        "id": "fixture-upstream-input",
        "role": "upstream_support",
        "authority": "Synthetic runtime input fixture",
        "authority_ref": "test-release",
        "reviewed_at": "2026-09-30",
        "claim": "Synthetic upstream input requirement",
        "immutable_url": "https://example.invalid/fixtures/runtime-v1",
        "live_url": null
    }));
    let source = &mut sources["contracts"][0];
    source["evidence_ids"] = json!(["fixture-upstream-input"]);
    source["admission_mode"] = json!("informational");
    source["evidence_gap"] = json!("Requires the upstream release input check.");
    source["supported_variant_ids"] = json!([]);
    source["n64_recomp_inputs_v1"] = json!([{
        "upstream_ref": "test-release",
        "artifact_sha256": "a".repeat(64),
        "game_id": "fixture.us",
        "rom_xxh3_64": "0123456789abcdef"
    }]);
    let contract = serde_json::to_vec(&document).unwrap();
    let mut selected = entry(&document, &contract, 0);
    selected["required_capabilities"] = json!([{
        "template": "n64-recomp-portable", "minimum_version": 9, "maximum_version": 9
    }]);
    assert!(
        inspect(&selected, &contract)
            .unwrap_err()
            .message
            .contains("release-input reader")
    );
    selected["required_capabilities"] = json!([{
        "template": "n64-recomp-portable", "minimum_version": 10, "maximum_version": 10
    }]);
    inspect(&selected, &contract).unwrap();
    selected["definition_schema"] = json!(3);
    selected["required_features"] = json!([]);
    assert!(
        inspect(&selected, &contract)
            .unwrap_err()
            .message
            .contains("n64.release-inputs-v1")
    );
    selected["required_features"] = json!(["n64.release-inputs-v1"]);
    inspect(&selected, &contract).unwrap();
    let sibling = entry(&document, &contract, 1);
    assert!(
        inspect(&sibling, &contract)
            .unwrap_err()
            .message
            .contains("selected definition")
    );
}

fn entry(document: &Value, contract: &[u8], port_index: usize) -> Value {
    entry_with_reference(document, &target(contract), port_index)
}

fn entry_with_reference(document: &Value, reference: &str, port_index: usize) -> Value {
    let port = &document["catalog"]["ports"][port_index];
    // Declare the semantics of each complete port in this synthetic envelope.
    let typed: crate::PortDefinition = serde_json::from_value(port.clone()).unwrap();
    let version = if let Some((_, minimum)) =
        crate::managed_runtime_policy::exact_exclusion_capability(&typed)
    {
        minimum
    } else if typed.optional_game_source {
        // An optional game source needs staged-source capability version 31. Keep this
        // branch first: a later capability chain that matched earlier would silently
        // skip the requirement.
        31
    } else if typed.runtime_disc_image.is_some() {
        // Disc-image unpacking needs staged-source capability version 30. Keep this branch
        // directly after the optional-source one (version 31) and before every other chain:
        // a later chain that matched first would silently skip the requirement.
        30
    } else if crate::package_layout::layout_capability(&typed)
        > crate::package_layout::NATIVE_CAPABILITY
    {
        crate::package_layout::layout_capability(&typed)
    } else if typed.linux_portable_data_directory.is_some() {
        crate::native_portable_data::NATIVE_CAPABILITY
    } else if !typed.release.tar_xz_platforms.is_empty() {
        if typed.adapter == crate::AdapterKind::NativePortable {
            crate::runtime::NATIVE_MAC_BUNDLE_TAR_XZ_CAPABILITY
        } else {
            crate::runtime::GENERATED_CACHE_TAR_XZ_CAPABILITY
        }
    } else if !typed.runtime_subdirectory_by_platform.is_empty() {
        crate::runtime::N64_PLATFORM_RUNTIME_SUBDIRECTORY_CAPABILITY
    } else if typed.release.grant_declared_executable {
        crate::test_fixture::grant_declared_executable_capability(&typed)
    } else if typed.portable_marker_file.is_some() {
        19
    } else if !typed.reviewed_package_layouts.is_empty() {
        crate::package_layout::NATIVE_CAPABILITY.max(
            typed
                .external_profile_policy
                .map_or(0, crate::native_external_profile::minimum_capability),
        )
    } else if typed.release.archive_file_links {
        crate::test_fixture::archive_file_links_capability(&typed)
    } else if crate::native_temp::has_sibling_platforms(&typed) {
        10
    } else if let Some(policy) = typed.external_profile_policy {
        crate::native_external_profile::minimum_capability(policy)
    } else if typed.release.linux_tar_xz {
        8
    } else if crate::preparation::source::native(&typed) {
        6
    } else if typed.windows_shipwright_persistence {
        3
    } else if typed.windows_temp_directory.is_some() {
        5
    } else if typed.adapter == crate::AdapterKind::NativePortable
        && typed.release.provider == crate::ReleaseSource::DirectManifest
    {
        if typed.windows_runtime_path_policy.is_some() {
            crate::runtime_path_policy::minimum_capability(&typed)
        } else {
            3
        }
    } else if crate::preparation::has_manual_marker(&typed)
        || typed.adapter == crate::AdapterKind::PsxRecompManaged
    {
        2
    } else if typed
        .release
        .user_prepared
        .values()
        .any(|runtime| runtime.trust == crate::ExternalRuntimeTrust::UserSelected)
    {
        20
    } else if let Some(version) = crate::persistence::fresh_direct_data_guard_capability(&typed) {
        version
    } else if typed.mod_package_policy.is_some() {
        24
    } else if crate::managed_chocolate::applies(&typed) {
        crate::managed_chocolate::CAPABILITY
    } else if crate::persistence::ready_staged_archive(&typed) {
        23
    } else if crate::managed_runtime_policy::requires_provider_resolution(&typed) {
        21
    } else if typed.managed_initialization
        == Some(crate::ManagedInitialization::TfeDarkForcesPortableV1)
        || typed.runtime_data_policy
            == Some(crate::RuntimeDataPolicy::VersionLocalRetroAchievementsV1)
        || typed.managed_shared_preferences
            == Some(crate::PreparedSharedPreferencesContract::GbRecompiledWindowsV1)
    {
        19
    } else if typed.managed_shared_preferences.is_some() {
        16
    } else if typed.runtime_data_policy.is_some() {
        15
    } else if typed.managed_initialization.is_some() {
        12
    } else if typed.windows_runtime_path_policy.is_some() {
        crate::runtime_path_policy::minimum_capability(&typed)
    } else if let Some(minimum) = typed
        .release
        .user_prepared
        .values()
        .filter_map(|runtime| {
            runtime
                .shared_preferences
                .map(|scope| scope.minimum_template_version())
        })
        .max()
    {
        minimum
    } else if let Some(version) = typed
        .release
        .managed_build
        .values()
        .map(|recipe| recipe.minimum_template_version())
        .max()
    {
        version
    } else if typed
        .release
        .user_prepared
        .values()
        .any(|r| r.settings_contract.is_some())
    {
        5
    } else if typed
        .release
        .user_prepared
        .values()
        .any(|r| !r.required_mutable_files.is_empty())
    {
        4
    } else if typed.release.provider == crate::ReleaseSource::UserPrepared
        && typed.runtime_subdirectory.is_some()
    {
        3
    } else if typed.n64_runtime_at_executable_parent {
        4
    } else if typed.n64_windows_initial_d3d12
        || typed
            .release
            .user_prepared
            .values()
            .any(|r| r.library_user_data)
    {
        2
    } else {
        1
    };
    json!({
        "definition_schema": 1, "namespace": "official", "stable_id": port["id"],
        "revision": 1, "port": port,
        "required_capabilities": crate::test_fixture::definition_requirements(&typed, version),
        "source_contracts": [reference], "execution_contract": reference,
        "persistence_contract": reference, "artifact_bindings": [], "evidence_references": []
    })
}

fn index(entries: &[(&Value, &[u8])], contract: &[u8]) -> DefinitionContentIndex {
    let definitions: Vec<_> = entries
        .iter()
        .map(|(value, bytes)| {
            json!({
                "namespace":value["namespace"], "stable_id":value["stable_id"],
                "revision":value["revision"], "target":target(bytes)
            })
        })
        .collect();
    let contents: Vec<_> = entries.iter().map(|(_, bytes)| *bytes).chain([contract]).map(|bytes| json!({
        "target":target(bytes), "sha256":hex::encode(Sha256::digest(bytes)), "length":bytes.len()
    })).collect();
    DefinitionContentIndex::parse(
        &serde_json::to_vec(&json!({
            "index_schema":1, "definitions":definitions, "contents":contents
        }))
        .unwrap(),
    )
    .unwrap()
}

fn inspect(value: &Value, contract: &[u8]) -> Result<DefinitionCatalogProjection> {
    let bytes = serde_json::to_vec(value).unwrap();
    index(&[(value, &bytes)], contract).inspect_catalog_projection(
        value["namespace"].as_str().unwrap(),
        value["stable_id"].as_str().unwrap(),
        &bytes,
        contract,
    )
}

#[test]
fn indexed_package_shape_enforcement_uses_the_negotiated_template_version() {
    let document = generic_projection();
    let contract = serde_json::to_vec(&document).unwrap();
    let mut selected = entry(&document, &contract, 0);
    for (maximum, expected) in [(4, None), (5, Some(5))] {
        selected["required_capabilities"] = json!([{
            "template": "libultraship-portable", "minimum_version": 4, "maximum_version": maximum
        }]);
        let projection = inspect(&selected, &contract).unwrap();
        assert_eq!(
            crate::package_shape::selected_enforcement_capability(
                projection.catalog(),
                projection.entry().port(),
            )
            .unwrap(),
            expected
        );
    }
}

#[test]
fn settings_are_complete_operational_projection_content_not_listing_metadata() {
    let mut document = projection();
    let position = document["catalog"]["ports"]
        .as_array()
        .unwrap()
        .iter()
        .position(|port| port["id"] == "shipwright")
        .unwrap();
    let authored: Value =
        serde_json::from_str(include_str!("../catalog/ports/shipwright.json")).unwrap();
    let expected = authored["integration"]["game_settings"].clone();
    document["catalog"]["ports"][position]["game_settings"] = expected.clone();
    let contract = serde_json::to_vec(&document).unwrap();
    let valid = entry(&document, &contract, position);
    let inspected = inspect(&valid, &contract).unwrap();
    assert_eq!(
        serde_json::to_value(
            inspected
                .catalog()
                .port("shipwright")
                .unwrap()
                .game_settings
                .as_ref()
                .unwrap()
        )
        .unwrap(),
        expected,
    );
    let mut changed = valid.clone();
    changed["port"]["game_settings"]["files"][0]["settings"][0]["value"]["default"] = json!(60);
    assert!(inspect(&changed, &contract).is_err());
    let mut absent = valid;
    absent["port"]
        .as_object_mut()
        .unwrap()
        .remove("game_settings");
    assert!(inspect(&absent, &contract).is_err());
}

#[test]
fn current_projection_routes_keep_distinct_capability_floors() {
    let document = projection();
    let contract = serde_json::to_vec(&document).unwrap();
    for (id, version) in [
        ("resident-evil-gaiden-recomp", 21),
        ("wave-race-64-racewave46", 21),
        ("render96ex", 20),
        (
            "f-zero-snes-recomp",
            crate::adapter::SNES_COPIER_HEADER_CAPABILITY,
        ),
        (
            "jgrennison-openttd-patches",
            crate::package_layout::NATIVE_CAPABILITY,
        ),
        (
            "gladiator-openglad",
            crate::package_layout::NATIVE_CAPABILITY,
        ),
        ("troyedwardsjr-z2rs", 20),
        ("body-harvest-recompiled", 21),
        ("dune-ii-dune-dynasty", 18),
        (
            "doom-3-classic-dhewm3",
            crate::preparation::source::NATIVE_RELATIVE_SOURCE_CAPABILITY,
        ),
        (
            "doom-3-resurrection-of-evil-classic-dhewm3",
            crate::preparation::source::NATIVE_RELATIVE_SOURCE_CAPABILITY,
        ),
        (
            "doom-3-classic-dude-doom-3-unified-development-engine",
            crate::package_layout::LINUX_PROGRAM_FORMAT_CAPABILITY,
        ),
        (
            "doom-3-resurrection-of-evil-classic-dude-doom-3-unified-development-engine",
            crate::package_layout::LINUX_PROGRAM_FORMAT_CAPABILITY,
        ),
    ] {
        let position = document["catalog"]["ports"]
            .as_array()
            .unwrap()
            .iter()
            .position(|port| port["id"] == id)
            .unwrap();
        let valid = entry(&document, &contract, position);
        assert_eq!(
            valid["required_capabilities"][0]["minimum_version"],
            version
        );
        assert_eq!(
            valid["required_capabilities"][0]["maximum_version"],
            version
        );
        inspect(&valid, &contract).unwrap();
        let mut stale = valid;
        stale["required_capabilities"][0]["minimum_version"] = json!(version - 1);
        stale["required_capabilities"][0]["maximum_version"] = json!(version - 1);
        assert!(inspect(&stale, &contract).is_err(), "{id}");
    }
}

#[test]
fn windows_runtime_path_policy_cannot_omit_its_engine_capability() {
    // The route as it was before #6212 (an exact raw file copied whole), whose
    // floor came from its Windows runtime path policy alone.
    let mut document = projection();
    for port in document["catalog"]["ports"].as_array_mut().unwrap() {
        if port["id"] == "f-zero-snes-recomp" {
            port["runtime_source_materialization"] = json!("copy");
        }
    }
    for identity in document["catalog"]["source_catalog"]["identities"]
        .as_array_mut()
        .unwrap()
    {
        if identity["id"] == "f-zero-snes-usa" {
            for variant in identity["variants"].as_array_mut().unwrap() {
                for representation in variant["representations"].as_array_mut().unwrap() {
                    representation["kind"] = json!("raw-file");
                    for digest in representation["identities"].as_array_mut().unwrap() {
                        digest["scope"] = json!("original-file");
                    }
                }
            }
        }
    }
    let position = document["catalog"]["ports"]
        .as_array()
        .unwrap()
        .iter()
        .position(|port| port["id"] == "f-zero-snes-recomp")
        .unwrap();
    let contract = serde_json::to_vec(&document).unwrap();
    let valid = entry(&document, &contract, position);
    inspect(&valid, &contract).unwrap();
    let retained = |value: &Value| {
        let bytes = serde_json::to_vec(value).unwrap();
        index(&[(value, &bytes)], &contract).inspect_retained_catalog_projection(
            value["namespace"].as_str().unwrap(),
            value["stable_id"].as_str().unwrap(),
            &bytes,
            &contract,
        )
    };
    let mut historical = valid.clone();
    historical["required_capabilities"][0]["minimum_version"] = json!(11);
    historical["required_capabilities"][0]["maximum_version"] = json!(11);
    retained(&historical).unwrap();
    assert!(
        inspect(&historical, &contract)
            .unwrap_err()
            .message
            .contains("version 23")
    );
    for (minimum, maximum) in [(10, 10), (1, 10)] {
        let mut stale = valid.clone();
        stale["required_capabilities"][0]["minimum_version"] = json!(minimum);
        stale["required_capabilities"][0]["maximum_version"] = json!(maximum);
        assert!(
            retained(&stale)
                .unwrap_err()
                .message
                .contains("capability version 11")
        );
        assert!(
            inspect(&stale, &contract)
                .unwrap_err()
                .message
                .contains("version 23")
        );
    }
}

#[test]
fn managed_tfe_cannot_omit_or_widen_its_capability_floor() {
    let document = projection();
    let position = document["catalog"]["ports"]
        .as_array()
        .unwrap()
        .iter()
        .position(|port| port["id"] == "the-force-engine-dark-forces")
        .unwrap();
    let contract = serde_json::to_vec(&document).unwrap();
    let valid = entry(&document, &contract, position);
    inspect(&valid, &contract).unwrap();
    for (minimum, maximum) in [(1, 1), (11, 11), (1, 12), (19, 19), (20, 20), (19, 21)] {
        let mut stale = valid.clone();
        stale["required_capabilities"][0]["minimum_version"] = json!(minimum);
        stale["required_capabilities"][0]["maximum_version"] = json!(maximum);
        assert!(
            inspect(&stale, &contract)
                .unwrap_err()
                .message
                .contains("capability version 21")
        );
    }
}

#[test]
fn every_current_port_retains_exact_bytes_and_complete_validated_source_graph() {
    let clock = std::time::Instant::now();
    println!("full catalog projection setup begin: {:?}", clock.elapsed());
    let document = projection();
    println!("full catalog projection loaded: {:?}", clock.elapsed());
    // Use compact JSON for the full catalog so formatting does not consume the
    // content-addressed target budget. The exact serialized bytes are still verified.
    let contract = serde_json::to_vec(&document).unwrap();
    let reference = target(&contract);
    let entries: Vec<_> = (0..document["catalog"]["ports"].as_array().unwrap().len())
        .map(|port_index| {
            let value = entry_with_reference(&document, &reference, port_index);
            let bytes = serde_json::to_vec_pretty(&value).unwrap();
            (value, bytes)
        })
        .collect();
    let indexed: Vec<_> = entries
        .iter()
        .map(|(value, bytes)| (value, bytes.as_slice()))
        .collect();
    println!(
        "full catalog projection entries prepared: {}; {:?}",
        entries.len(),
        clock.elapsed()
    );
    let inventory = index(&indexed, &contract);
    println!("full catalog projection index ready: {:?}", clock.elapsed());

    for (position, (value, bytes)) in entries.iter().enumerate() {
        let inspected = inventory
            .inspect_entry("official", value["stable_id"].as_str().unwrap(), bytes)
            .unwrap();
        assert_eq!(inspected.bytes(), *bytes);
        assert_eq!(inspected.execution_contract(), reference.as_str());
        assert_eq!(
            serde_json::to_value(inspected.port()).unwrap(),
            value["port"]
        );
        if position % 25 == 0 || position + 1 == entries.len() {
            println!(
                "full catalog projection entry {}/{} {} verified: {:?}",
                position + 1,
                entries.len(),
                value["stable_id"].as_str().unwrap(),
                clock.elapsed()
            );
        }
    }

    // Full catalog validation is independent of the selected port. Exercise it
    // once while the loop above keeps exact entry coverage for every port.
    println!(
        "full catalog projection graph validation begin: {:?}",
        clock.elapsed()
    );
    let (value, bytes) = &entries[0];
    let result = inventory
        .inspect_catalog_projection(
            "official",
            value["stable_id"].as_str().unwrap(),
            bytes,
            &contract,
        )
        .unwrap();
    assert_eq!(result.entry().bytes(), *bytes);
    assert_eq!(result.contract_bytes(), contract);
    assert_eq!(result.contract_target(), reference.as_str());
    assert_eq!(
        serde_json::to_value(result.catalog().authoritative_document()).unwrap(),
        document["catalog"]
    );
}

#[test]
fn interpreted_semantics_survive_existing_manifest_capture() {
    let document = projection();
    let contract = serde_json::to_vec(&document).unwrap();
    let result = inspect(&entry(&document, &contract, 0), &contract).unwrap();
    let retained = crate::installed_contract::InstalledContract::capture(
        result.catalog(),
        &result.entry().port().id,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(
            retained
                .catalog(&result.entry().port().id)
                .unwrap()
                .authoritative_document()
        )
        .unwrap(),
        document["catalog"]
    );
    // This checks the existing canonical semantics, not successor-byte persistence.
    assert_eq!(result.contract_bytes(), contract);
}

#[test]
fn legacy_schema_one_keeps_its_original_source_profiles() {
    // Exercise the actual legacy authority; modern Native6 source contracts
    // cannot be represented by deleting schema-2 authority from today's catalog.
    let catalog = Catalog::from_json(include_str!("../catalog/catalog-schema1-fixture.json"))
        .unwrap()
        .document()
        .clone();
    let document =
        json!({"contract_schema":1,"representation":"catalog_projection","catalog":catalog});
    let contract = serde_json::to_vec(&document).unwrap();
    let result = inspect(&entry(&document, &contract, 0), &contract).unwrap();
    assert!(result.catalog().source_catalog().is_none());
    assert_eq!(
        serde_json::to_value(result.catalog().authoritative_document()).unwrap(),
        document["catalog"]
    );
}

#[test]
fn supported_new_id_needs_no_per_port_dispatch_and_does_not_mutate_embedded_catalog() {
    let original = Catalog::embedded().unwrap();
    let mut document = projection();
    let old_id = document["catalog"]["ports"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    document["catalog"]["ports"][0]["id"] = json!("redistributable-definition-fixture");
    // The synthetic ID has no official Shipwright persistence authority.
    document["catalog"]["ports"][0]
        .as_object_mut()
        .unwrap()
        .remove("windows_shipwright_persistence");
    for collection in ["contracts", "qualification"] {
        for record in document["catalog"]["source_catalog"][collection]
            .as_array_mut()
            .unwrap()
        {
            if record["port_id"] == old_id {
                record["port_id"] = json!("redistributable-definition-fixture");
            }
        }
    }
    let contract = serde_json::to_vec(&document).unwrap();
    let result = inspect(&entry(&document, &contract, 0), &contract).unwrap();
    assert_eq!(
        result.entry().port().id,
        "redistributable-definition-fixture"
    );
    assert!(original.port("redistributable-definition-fixture").is_err());
    assert_eq!(
        serde_json::to_value(Catalog::embedded().unwrap().authoritative_document()).unwrap(),
        serde_json::to_value(original.authoritative_document()).unwrap()
    );
}

#[test]
fn contract_digest_and_port_agreement_are_independent_requirements() {
    let document = generic_projection();
    let contract = serde_json::to_vec(&document).unwrap();
    let mut value = entry(&document, &contract, 0);
    let bytes = serde_json::to_vec(&value).unwrap();
    let inventory = index(&[(&value, &bytes)], &contract);
    let mut changed = contract.clone();
    changed.push(b' ');
    assert!(
        inventory
            .inspect_catalog_projection(
                "official",
                value["stable_id"].as_str().unwrap(),
                &bytes,
                &changed
            )
            .is_err()
    );
    value["port"]["summary"] = json!("A different but valid projection");
    assert!(
        inspect(&value, &contract)
            .unwrap_err()
            .message
            .contains("differs")
    );
}

#[test]
fn roles_must_name_the_single_terminal_contract_without_extra_edges() {
    let document = generic_projection();
    let contract = serde_json::to_vec(&document).unwrap();
    let value = entry(&document, &contract, 0);
    for field in [
        "source_contracts",
        "artifact_bindings",
        "evidence_references",
    ] {
        let mut changed = value.clone();
        changed[field] = if field == "source_contracts" {
            json!([])
        } else {
            json!([target(&contract)])
        };
        assert!(
            inspect(&changed, &contract)
                .unwrap_err()
                .message
                .contains("shared")
        );
    }
    let mut repeated = value.clone();
    repeated["source_contracts"] = json!([target(&contract), target(&contract)]);
    assert!(inspect(&repeated, &contract).is_err());
    // A declared edge inside the leaf is unsupported, even when it names valid content.
    let mut graph = document.clone();
    graph["references"] = json!([target(&contract)]);
    let graph_bytes = serde_json::to_vec(&graph).unwrap();
    assert!(inspect(&entry(&graph, &graph_bytes, 0), &graph_bytes).is_err());
}

#[test]
fn unsupported_contracts_and_unknown_nested_semantics_fail_closed() {
    let document = generic_projection();
    for field in ["contract_schema", "representation", "unexpected"] {
        let mut changed = document.clone();
        changed[field] = if field == "contract_schema" {
            json!(2)
        } else {
            json!("future")
        };
        let bytes = serde_json::to_vec(&changed).unwrap();
        assert!(inspect(&entry(&changed, &bytes, 0), &bytes).is_err());
    }
    for path in [
        vec!["catalog"],
        vec!["catalog", "source_catalog"],
        vec!["catalog", "ports", "0", "release"],
    ] {
        let mut changed = document.clone();
        let mut cursor = &mut changed;
        for key in path {
            cursor = if key == "0" {
                &mut cursor[0]
            } else {
                &mut cursor[key]
            };
        }
        cursor["unknown_safety_field"] = json!(true);
        let bytes = serde_json::to_vec(&changed).unwrap();
        // Keep the original entry port so entry shape checks cannot hide a leaf failure.
        assert!(inspect(&entry(&document, &bytes, 0), &bytes).is_err());
    }
    let mut incomplete = document.clone();
    incomplete["catalog"]["ports"][0]
        .as_object_mut()
        .unwrap()
        .remove("launch_arguments");
    let bytes = serde_json::to_vec(&incomplete).unwrap();
    assert!(
        inspect(&entry(&document, &bytes, 0), &bytes)
            .unwrap_err()
            .message
            .contains("incomplete")
    );
}

#[test]
fn duplicate_decoded_fields_are_rejected_inside_the_referenced_contract() {
    let document = generic_projection();
    let text = serde_json::to_string(&document).unwrap();
    for bytes in [
        text.replacen(
            "\"contract_schema\":1",
            "\"contract_schema\":1,\"contract_schema\":1",
            1,
        )
        .into_bytes(),
        text.replacen(
            "\"schema_version\":2",
            "\"schema_version\":2,\"schema_ver\\u0073ion\":2",
            1,
        )
        .into_bytes(),
    ] {
        assert_ne!(bytes, text.as_bytes());
        assert!(
            inspect(&entry(&document, &bytes, 0), &bytes)
                .unwrap_err()
                .message
                .contains("duplicate")
        );
    }
}

#[test]
fn existing_source_and_persistence_validators_reject_matching_unsafe_bytes() {
    let document = generic_projection();
    let mut unsafe_path = document.clone();
    unsafe_path["catalog"]["ports"][0]["persistent_paths"] = json!(["../outside"]);
    let bytes = serde_json::to_vec(&unsafe_path).unwrap();
    assert!(inspect(&entry(&unsafe_path, &bytes, 0), &bytes).is_err());
    let mut missing_source = document.clone();
    missing_source["catalog"]["source_catalog"]["contracts"][0]["profile_id"] =
        json!("missing-profile");
    let bytes = serde_json::to_vec(&missing_source).unwrap();
    assert!(inspect(&entry(&missing_source, &bytes, 0), &bytes).is_err());
}

#[test]
fn unsupported_entry_does_not_prevent_a_supported_sibling_using_the_same_leaf() {
    let document = generic_projection();
    let contract = serde_json::to_vec(&document).unwrap();
    let good = entry(&document, &contract, 0);
    let mut unsupported = entry(&document, &contract, 1);
    unsupported["required_capabilities"][0]["minimum_version"] = json!(99);
    unsupported["required_capabilities"][0]["maximum_version"] = json!(99);
    let good_bytes = serde_json::to_vec(&good).unwrap();
    let unsupported_bytes = serde_json::to_vec(&unsupported).unwrap();
    let inventory = index(
        &[(&good, &good_bytes), (&unsupported, &unsupported_bytes)],
        &contract,
    );
    assert!(
        inventory
            .inspect_catalog_projection(
                "official",
                unsupported["stable_id"].as_str().unwrap(),
                &unsupported_bytes,
                &contract
            )
            .is_err()
    );
    assert!(
        inventory
            .inspect_catalog_projection(
                "official",
                good["stable_id"].as_str().unwrap(),
                &good_bytes,
                &contract
            )
            .is_ok()
    );
}

#[test]
fn generic_projection_retains_complete_validated_source_graph_for_both_siblings() {
    let document = generic_projection();
    let catalog = Catalog::from_json(&document["catalog"].to_string()).unwrap();
    assert_eq!(catalog.ports().len(), 2);
    let source = catalog.source_catalog().unwrap();
    assert_eq!(source.identities.len(), 1);
    assert_eq!(source.contracts.len(), 2);
    assert_eq!(source.evidence.len(), 1);
    assert!(source.qualification.is_empty());
    let contract = serde_json::to_vec(&document).unwrap();
    for (port_index, id) in ["projection-fixture", "projection-sibling"]
        .iter()
        .enumerate()
    {
        assert_eq!(&catalog.ports()[port_index].id, id);
        let result = inspect(&entry(&document, &contract, port_index), &contract).unwrap();
        assert_eq!(result.entry().port().id, *id);
        assert_eq!(result.contract_bytes(), contract);
        assert_eq!(
            serde_json::to_value(result.catalog().authoritative_document()).unwrap(),
            document["catalog"]
        );
    }
}

#[test]
fn generic_projection_source_mutations_fail_after_valid_entry_inspection() {
    let document = generic_projection();
    for field in ["profile_id", "unknown_safety_field"] {
        let mut changed = document.clone();
        changed["catalog"]["source_catalog"]["contracts"][0][field] = json!("missing-profile");
        let contract = serde_json::to_vec(&changed).unwrap();
        let value = entry(&document, &contract, 0);
        let bytes = serde_json::to_vec(&value).unwrap();
        let inventory = index(&[(&value, &bytes)], &contract);
        assert!(
            inventory
                .inspect_entry("official", "projection-fixture", &bytes)
                .is_ok()
        );
        assert!(
            inventory
                .inspect_catalog_projection("official", "projection-fixture", &bytes, &contract)
                .is_err()
        );
    }
}

#[test]
fn multi_track_psx_disc_sets_require_their_reader_capability() {
    let document = projection();
    let position = document["catalog"]["ports"]
        .as_array()
        .unwrap()
        .iter()
        .position(|port| port["id"] == "alexbeav-alone-in-the-dark-the-new-nightmare-recomp")
        .unwrap();
    let contract = serde_json::to_vec(&document).unwrap();
    let valid = entry(&document, &contract, position);
    assert_eq!(
        valid["required_capabilities"],
        json!([{"template":"psx-recomp-managed","minimum_version":4,"maximum_version":4}])
    );
    inspect(&valid, &contract).unwrap();
    // A retained-scope reader would accept the entry alone; the projection's
    // source profile makes it refuse.
    let mut stale = valid.clone();
    stale["required_capabilities"][0]["minimum_version"] = json!(3);
    stale["required_capabilities"][0]["maximum_version"] = json!(3);
    let error = inspect(&stale, &contract).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Verification);
    assert!(error.message.contains("capability version 4"), "{error:?}");
}
