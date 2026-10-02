use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

// Generic entry inspection needs one valid port, not the embedded source graph.
// Real-port byte/projection and catalog semantic contracts keep catalog_fixture().
fn fixture_catalog() -> crate::Catalog {
    crate::Catalog::from_json(
        &json!({
            "schema_version": 1,
            "ports": [{
                "id": "definition-entry-fixture",
                "name": "Definition entry fixture",
                "summary": "Synthetic indexed entry inspection fixture",
                "project_url": "https://example.invalid/definition-entry-fixture",
                "support_tier": "beta",
                "channels": ["stable"],
                "platforms": ["linux-x86-64"],
                "adapter": "libultraship-portable",
                "release": {"repository": "fixture/definition-entry"},
                "executable_hints": {"linux-x86-64": ["fixture"]}
            }]
        })
        .to_string(),
    )
    .unwrap()
}

fn fixture() -> Value {
    entry_for_port(&fixture_catalog().ports()[0])
}

fn catalog_fixture() -> Value {
    entry_for_port(&crate::Catalog::embedded().unwrap().ports()[0])
}

fn entry_for_port(port: &crate::PortDefinition) -> Value {
    let contract = target(b"{}");
    json!({
        "definition_schema": 1, "namespace": "official", "stable_id": port.id,
        "revision": 1, "required_capabilities": [{"template":port.adapter,"minimum_version":1,"maximum_version":1}],
        "port": port, "source_contracts": [], "execution_contract": contract,
        "persistence_contract": contract, "artifact_bindings": [], "evidence_references": []
    })
}

fn target(bytes: &[u8]) -> String {
    format!("sha256/{}.json", hex::encode(Sha256::digest(bytes)))
}

fn index(bytes: &[u8], stable_id: &str) -> DefinitionContentIndex {
    inventory(&[(bytes, stable_id)])
}

fn inventory(entries: &[(&[u8], &str)]) -> DefinitionContentIndex {
    let contents: Vec<_> = entries.iter().map(|(bytes, _)| *bytes).chain([b"{}".as_slice()]).map(|content| json!({
        "target":target(content), "sha256":hex::encode(Sha256::digest(content)), "length":content.len()
    })).collect();
    let definitions: Vec<_> = entries
        .iter()
        .map(|(bytes, stable_id)| {
            json!({
                "namespace":"official","stable_id":stable_id,"revision":1,"target":target(bytes)
            })
        })
        .collect();
    DefinitionContentIndex::parse(
        &serde_json::to_vec(&json!({
            "index_schema": 1,
            "definitions": definitions,
            "contents":contents
        }))
        .unwrap(),
    )
    .unwrap()
}

fn inspect(value: &Value) -> Result<DefinitionEntryInspection> {
    let bytes = serde_json::to_vec(value).unwrap();
    let stable_id = value["port"]["id"].as_str().unwrap();
    index(&bytes, stable_id).inspect_entry("official", stable_id, &bytes)
}

#[test]
fn exact_bytes_and_existing_port_projection_survive_inspection() {
    let value = catalog_fixture();
    let stable_id = value["stable_id"].as_str().unwrap();
    let bytes = serde_json::to_vec_pretty(&value).unwrap();
    let inventory = index(&bytes, stable_id);
    let entry = inventory
        .inspect_entry("official", stable_id, &bytes)
        .unwrap();
    assert_eq!(entry.bytes(), bytes);
    assert_eq!(entry.namespace(), "official");
    assert_eq!(entry.revision(), 1);
    assert_eq!(serde_json::to_value(entry.port()).unwrap(), value["port"]);
    assert!(entry.capabilities().compatible);
    assert_eq!(
        entry.referenced_targets().collect::<Vec<_>>(),
        [target(b"{}"), target(b"{}")]
    );
    assert!(entry.source_contracts().is_empty());
    assert_eq!(entry.execution_contract(), target(b"{}"));
    assert_eq!(entry.persistence_contract(), target(b"{}"));
    assert!(entry.artifact_bindings().is_empty());
    assert!(entry.evidence_references().is_empty());
    let mut changed = bytes.clone();
    changed.push(b' ');
    assert!(
        inventory
            .inspect_entry("official", stable_id, &changed)
            .is_err()
    );
    assert!(
        inventory
            .inspect_entry("community", stable_id, &bytes)
            .is_err()
    );
}

#[test]
fn every_existing_official_projection_keeps_its_complete_fields() {
    let mut value = fixture();
    for port in crate::Catalog::embedded().unwrap().ports() {
        value["stable_id"] = json!(port.id);
        value["port"] = serde_json::to_value(port).unwrap();
        value["required_capabilities"][0]["template"] = json!(port.adapter);
        let entry = inspect(&value).unwrap();
        assert_eq!(serde_json::to_value(entry.port()).unwrap(), value["port"]);
        assert!(entry.capabilities().compatible);
    }
}

#[test]
fn unknown_or_missing_safety_fields_fail_at_each_typed_boundary() {
    for path in [vec![], vec!["port"], vec!["port", "release"]] {
        let mut value = fixture();
        let mut object = &mut value;
        for key in path {
            object = &mut object[key];
        }
        object["new_execution_authority"] = json!(true);
        assert!(inspect(&value).is_err());
    }
    let mut value = fixture();
    value["required_capabilities"][0]["future_semantics"] = json!(true);
    assert!(inspect(&value).is_err());
    let baseline = fixture();
    for key in baseline.as_object().unwrap().keys() {
        let mut value = baseline.clone();
        value.as_object_mut().unwrap().remove(key);
        let bytes = serde_json::to_vec(&value).unwrap();
        let stable_id = baseline["stable_id"].as_str().unwrap();
        assert!(
            index(&bytes, stable_id)
                .inspect_entry("official", stable_id, &bytes)
                .is_err()
        );
    }
    let mut value = fixture();
    value["port"]
        .as_object_mut()
        .unwrap()
        .remove("launch_arguments");
    assert!(inspect(&value).is_err());
}

#[test]
fn duplicate_keys_cannot_hide_inside_entry_objects_arrays_or_environment_maps() {
    let value = fixture();
    let stable_id = value["stable_id"].as_str().unwrap();
    let original = serde_json::to_string(&value).unwrap();
    for (field, duplicate) in [
        ("\"revision\":1", "\"revision\":1,\"revision\":1"),
        (
            "\"minimum_version\":1",
            "\"minimum_version\":1,\"minimum_version\":1",
        ),
        (
            "\"launch_environment\":{}",
            "\"launch_environment\":{\"MODE\":\"first\",\"MODE\":\"last\"}",
        ),
        (
            "\"launch_environment\":{}",
            "\"launch_environment\":{\"MODE\":\"first\",\"M\\u004fDE\":\"last\"}",
        ),
    ] {
        let changed = original.replace(field, duplicate);
        assert_ne!(changed, original);
        let inventory = index(changed.as_bytes(), stable_id);
        let error = inventory
            .inspect_entry("official", stable_id, changed.as_bytes())
            .unwrap_err();
        assert!(error.message.contains("duplicate definition object key"));
    }
}

#[test]
fn entry_schema_and_exact_index_identity_are_independent_checks() {
    let baseline = fixture();
    let stable_id = baseline["stable_id"].as_str().unwrap();
    for (key, changed) in [
        ("definition_schema", json!(2)),
        ("namespace", json!("community")),
        ("stable_id", json!("different-port")),
        ("revision", json!(2)),
    ] {
        let mut value = baseline.clone();
        value[key] = changed;
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(
            index(&bytes, stable_id)
                .inspect_entry("official", stable_id, &bytes)
                .is_err()
        );
    }
    let mut value = baseline.clone();
    value["port"]["id"] = json!("different-port");
    let bytes = serde_json::to_vec(&value).unwrap();
    assert!(
        index(&bytes, stable_id)
            .inspect_entry("official", stable_id, &bytes)
            .is_err()
    );
}

#[test]
fn unsupported_capabilities_remain_reportable_and_the_adapter_is_required() {
    let baseline = fixture();
    let mut value = baseline.clone();
    value["required_capabilities"][0]["minimum_version"] = json!(2);
    value["required_capabilities"][0]["maximum_version"] = json!(2);
    assert!(!inspect(&value).unwrap().capabilities().compatible);
    value["required_capabilities"]
        .as_array_mut()
        .unwrap()
        .push(json!({"template":"future-engine","minimum_version":1,"maximum_version":1}));
    assert_eq!(inspect(&value).unwrap().capabilities().checks.len(), 2);
    value["required_capabilities"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    assert!(
        inspect(&value).is_err(),
        "the port adapter cannot be omitted"
    );
    assert!(inspect(&baseline).unwrap().capabilities().compatible);
}

#[test]
fn references_stay_inside_inventory_and_obey_the_per_entry_bound() {
    for key in ["execution_contract", "persistence_contract"] {
        let mut value = fixture();
        value[key] = json!("https://untrusted.invalid/contract");
        assert!(inspect(&value).is_err());
    }
    for key in [
        "source_contracts",
        "artifact_bindings",
        "evidence_references",
    ] {
        let mut value = fixture();
        value[key] = json!([target(b"unlisted contract")]);
        assert!(inspect(&value).is_err());
    }
    let mut value = fixture();
    value["source_contracts"] = json!(vec![target(b"{}"); 1022]);
    assert_eq!(inspect(&value).unwrap().referenced_targets().count(), 1024);
    value["source_contracts"]
        .as_array_mut()
        .unwrap()
        .push(json!(target(b"{}")));
    assert!(inspect(&value).is_err());
    // Referenced bytes are deliberately not interpreted by this inspection stage.
    // A listed empty object does not establish an executable or persistence contract.
}

#[test]
fn an_unsupported_entry_does_not_discard_a_valid_sibling_or_change_the_index() {
    let supported_value = fixture();
    let stable_id = supported_value["stable_id"].as_str().unwrap();
    let mut unsupported = supported_value.clone();
    unsupported["definition_schema"] = json!(999);
    unsupported["stable_id"] = json!("future-port");
    unsupported["port"]["id"] = json!("future-port");
    let supported = serde_json::to_vec(&supported_value).unwrap();
    let unsupported = serde_json::to_vec(&unsupported).unwrap();
    let inventory = inventory(&[(&supported, stable_id), (&unsupported, "future-port")]);
    let original = inventory.bytes().to_vec();
    assert_eq!(
        inventory
            .inspect_entry("official", "future-port", &unsupported)
            .unwrap_err()
            .code,
        crate::ErrorCode::Unsupported
    );
    assert!(
        inventory
            .inspect_entry("official", stable_id, &supported)
            .unwrap()
            .capabilities()
            .compatible
    );
    assert_eq!(inventory.bytes(), original);
    assert_eq!(inventory.definitions().len(), 2);
}

#[test]
fn shape_inspection_does_not_bypass_existing_catalog_semantic_validation() {
    let mut value = catalog_fixture();
    value["port"]["persistent_paths"] = json!(["../outside"]);
    let inspected = inspect(&value).unwrap();
    let mut catalog = crate::Catalog::embedded().unwrap().authoritative_document();
    catalog.ports[0] = inspected.port().clone();
    assert!(crate::Catalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
}

#[test]
fn generic_entry_fixture_crosses_real_catalog_and_index_validation() {
    let catalog = fixture_catalog();
    assert_eq!(catalog.document().schema_version, 1);
    assert_eq!(catalog.ports().len(), 1);
    assert!(catalog.document().source_profiles.is_empty());
    assert!(catalog.document().source_catalog.is_none());
    let value = fixture();
    assert_eq!(value["stable_id"], "definition-entry-fixture");
    let inspected = inspect(&value).unwrap();
    assert_eq!(inspected.port().id, "definition-entry-fixture");
    assert!(inspected.capabilities().compatible);
    assert_eq!(
        serde_json::to_value(inspected.port()).unwrap(),
        value["port"]
    );

    let mut invalid = catalog.document().clone();
    invalid.ports[0].source_profile = Some("missing-source".into());
    assert!(crate::Catalog::from_json(&serde_json::to_string(&invalid).unwrap()).is_err());
    let mut invalid = catalog.document().clone();
    invalid.ports[0].persistent_paths = vec!["../outside".into()];
    assert!(crate::Catalog::from_json(&serde_json::to_string(&invalid).unwrap()).is_err());
}

#[test]
fn unrelated_catalog_port_does_not_change_generic_entry_or_index_bytes() {
    let catalog = fixture_catalog();
    let original = fixture();
    let mut extended = catalog.document().clone();
    let mut unrelated = extended.ports[0].clone();
    unrelated.id = "unrelated-port".into();
    unrelated.release.repository = "unrelated/release".into();
    extended.ports.push(unrelated);
    let extended = crate::Catalog::from_json(&serde_json::to_string(&extended).unwrap()).unwrap();
    let selected = extended.port("definition-entry-fixture").unwrap();
    let after = entry_for_port(selected);
    assert_eq!(after, original);
    let before_bytes = serde_json::to_vec(&original).unwrap();
    let after_bytes = serde_json::to_vec(&after).unwrap();
    let stable_id = selected.id.as_str();
    assert_eq!(
        index(&before_bytes, stable_id).bytes(),
        index(&after_bytes, stable_id).bytes()
    );
    assert_eq!(
        inspect(&after).unwrap().bytes(),
        inspect(&original).unwrap().bytes()
    );
    assert_eq!(fixture(), original);
}
