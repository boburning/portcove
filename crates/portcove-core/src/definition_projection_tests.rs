use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

fn target(bytes: &[u8]) -> String {
    format!("sha256/{}.json", hex::encode(Sha256::digest(bytes)))
}

fn projection() -> Value {
    json!({
        "contract_schema": 1, "representation": "catalog_projection",
        "catalog": Catalog::embedded().unwrap().authoritative_document()
    })
}

fn entry(document: &Value, contract: &[u8], port_index: usize) -> Value {
    let port = &document["catalog"]["ports"][port_index];
    let reference = target(contract);
    json!({
        "definition_schema": 1, "namespace": "official", "stable_id": port["id"],
        "revision": 1, "port": port,
        "required_capabilities": [{"template":port["adapter"],"minimum_version":1,"maximum_version":1}],
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
fn every_current_port_retains_exact_bytes_and_complete_validated_source_graph() {
    let document = projection();
    let contract = serde_json::to_vec_pretty(&document).unwrap();
    for port_index in 0..document["catalog"]["ports"].as_array().unwrap().len() {
        let value = entry(&document, &contract, port_index);
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        let inventory = index(&[(&value, &bytes)], &contract);
        let result = inventory
            .inspect_catalog_projection(
                "official",
                value["stable_id"].as_str().unwrap(),
                &bytes,
                &contract,
            )
            .unwrap();
        assert_eq!(result.entry().bytes(), bytes);
        assert_eq!(result.contract_bytes(), contract);
        assert_eq!(result.contract_target(), target(&contract));
        assert_eq!(
            serde_json::to_value(result.catalog().authoritative_document()).unwrap(),
            document["catalog"]
        );
        assert_eq!(
            serde_json::to_value(result.entry().port()).unwrap(),
            value["port"]
        );
    }
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
    let mut catalog = Catalog::embedded().unwrap().document().clone();
    catalog.schema_version = 1;
    catalog.source_catalog = None;
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
    let document = projection();
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
    let document = projection();
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
    let document = projection();
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
    let document = projection();
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
    let document = projection();
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
    let document = projection();
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
