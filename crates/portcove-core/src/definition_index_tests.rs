use super::*;
use serde_json::{Value, json};

fn fixture() -> Value {
    let sha256 = hex::encode(Sha256::digest(b"{}"));
    let target = format!("sha256/{sha256}.json");
    json!({
        "index_schema": 1,
        "definitions": [{"namespace":"official", "stable_id":"fixture-port", "revision":1, "target":target}],
        "contents": [{"target":target, "sha256":sha256, "length":2}]
    })
}

fn parse(value: &Value) -> Result<DefinitionContentIndex> {
    DefinitionContentIndex::parse(&serde_json::to_vec(value).unwrap())
}

#[test]
fn preserves_exact_index_and_verifies_only_indexed_bytes() {
    let bytes = serde_json::to_vec_pretty(&fixture()).unwrap();
    let index = DefinitionContentIndex::parse(&bytes).unwrap();
    assert_eq!(index.bytes(), bytes);
    let definition = &index.definitions()[0];
    assert_eq!(definition.namespace(), "official");
    assert_eq!(definition.stable_id(), "fixture-port");
    assert_eq!(definition.revision(), 1);
    assert_eq!(index.content_length(definition.target()).unwrap(), 2);
    index.verify_content(definition.target(), b"{}").unwrap();
    for changed in [b"[]".as_slice(), b"{ }", b""] {
        assert!(index.verify_content(definition.target(), changed).is_err());
    }
    assert!(
        index
            .content_length("https://untrusted.invalid/entry")
            .is_err()
    );
    assert!(index.verify_content("../entry", b"{}").is_err());
}

#[test]
fn rejects_unknown_and_duplicate_fields_at_each_index_boundary() {
    for path in [vec![], vec!["definitions", "0"], vec!["contents", "0"]] {
        let mut value = fixture();
        let object = if path.is_empty() {
            &mut value
        } else {
            &mut value[path[0]][0]
        };
        object["future_authority"] = json!(true);
        assert!(parse(&value).is_err());
    }
    let text = serde_json::to_string(&fixture()).unwrap();
    for (field, replacement) in [
        (
            "\"index_schema\":1",
            "\"index_schema\":1,\"index_schema\":1",
        ),
        ("\"revision\":1", "\"revision\":1,\"revision\":2"),
        ("\"length\":2", "\"length\":2,\"length\":3"),
    ] {
        let duplicate = text.replace(field, replacement);
        assert_ne!(duplicate, text);
        assert!(DefinitionContentIndex::parse(duplicate.as_bytes()).is_err());
    }
}

#[test]
fn rejects_conflicting_identity_even_with_different_revisions() {
    for revision in [1, 2] {
        let mut value = fixture();
        let mut duplicate = value["definitions"][0].clone();
        duplicate["revision"] = json!(revision);
        value["definitions"].as_array_mut().unwrap().push(duplicate);
        assert_eq!(parse(&value).unwrap_err().code, crate::ErrorCode::Conflict);
    }
    let mut value = fixture();
    let duplicate = value["contents"][0].clone();
    value["contents"].as_array_mut().unwrap().push(duplicate);
    assert_eq!(parse(&value).unwrap_err().code, crate::ErrorCode::Conflict);
}

#[test]
fn enforces_namespaces_and_revision_identity_without_rewriting_official_ids() {
    let mut value = fixture();
    let mut community = value["definitions"][0].clone();
    community["namespace"] = json!("community-example");
    value["definitions"].as_array_mut().unwrap().push(community);
    assert_eq!(parse(&value).unwrap().definitions().len(), 2);
    for key in ["namespace", "stable_id"] {
        for invalid in [
            "".to_string(),
            "a".repeat(256),
            "../port".into(),
            "PORT".into(),
            "a:b".into(),
            "é".into(),
        ] {
            let mut invalid_value = value.clone();
            invalid_value["definitions"][0][key] = json!(invalid);
            assert!(parse(&invalid_value).is_err());
        }
    }
    value["definitions"][0]["revision"] = json!(0);
    assert!(parse(&value).is_err());
}

#[test]
fn rejects_external_alias_and_missing_target_references() {
    let directory = tempfile::tempdir().unwrap();
    let absolute_target = directory.path().join("entry.json");
    assert!(absolute_target.is_absolute());
    for target in [
        "../entry.json",
        absolute_target.to_str().unwrap(),
        "https://host/entry.json",
        "sha256\\entry.json",
        "sha256/%2e%2e.json",
    ] {
        let mut value = fixture();
        value["contents"][0]["target"] = json!(target);
        value["definitions"][0]["target"] = json!(target);
        assert!(parse(&value).is_err());
    }
    let mut value = fixture();
    value["definitions"][0]["target"] = json!(format!("sha256/{}.json", "a".repeat(64)));
    assert!(parse(&value).is_err());
    for digest in ["A".repeat(64), "g".repeat(64), "a".repeat(63)] {
        let mut value = fixture();
        let target = format!("sha256/{digest}.json");
        value["definitions"][0]["target"] = json!(target);
        value["contents"][0]["target"] = json!(target);
        value["contents"][0]["sha256"] = json!(digest);
        assert!(parse(&value).is_err());
    }
}

#[test]
fn enforces_schema_and_all_resource_bounds() {
    let mut value = fixture();
    value["index_schema"] = json!(2);
    assert_eq!(
        parse(&value).unwrap_err().code,
        crate::ErrorCode::Unsupported
    );
    for length in [0, MAX_CONTENT_BYTES + 1, u64::MAX] {
        let mut value = fixture();
        value["contents"][0]["length"] = json!(length);
        assert!(parse(&value).is_err());
    }
    let mut value = fixture();
    value["definitions"] = json!(
        (0..MAX_DEFINITIONS)
            .map(|n| {
                let mut entry = value["definitions"][0].clone();
                entry["stable_id"] = json!(format!("port-{n}"));
                entry
            })
            .collect::<Vec<_>>()
    );
    assert_eq!(parse(&value).unwrap().definitions().len(), MAX_DEFINITIONS);
    let mut extra = value["definitions"][0].clone();
    extra["stable_id"] = json!("port-over-count-bound");
    value["definitions"].as_array_mut().unwrap().push(extra);
    assert!(parse(&value).is_err());
    let mut bytes = serde_json::to_vec(&fixture()).unwrap();
    bytes.resize(MAX_INDEX_BYTES, b' ');
    assert!(DefinitionContentIndex::parse(&bytes).is_ok());
    bytes.push(b' ');
    assert!(DefinitionContentIndex::parse(&bytes).is_err());
}

#[test]
fn aggregate_bound_counts_unique_contracts_and_rejects_oversized_inventory() {
    let mut value = json!({"index_schema":1,"definitions":[],"contents":[]});
    for n in 0..8 {
        let digest = format!("{n:064x}");
        value["contents"].as_array_mut().unwrap().push(json!({
            "target":format!("sha256/{digest}.json"),"sha256":digest,"length":MAX_CONTENT_BYTES
        }));
    }
    assert!(parse(&value).is_ok());
    let digest = "f".repeat(64);
    value["contents"].as_array_mut().unwrap().push(json!({
        "target":format!("sha256/{digest}.json"),"sha256":digest,"length":1
    }));
    assert!(parse(&value).is_err());
}

#[test]
fn content_integrity_does_not_parse_entries_or_establish_eligibility() {
    let unsupported = b"{\"definition_schema\":999,\"run_script\":true}";
    let digest = hex::encode(Sha256::digest(unsupported));
    let target = format!("sha256/{digest}.json");
    let mut value = fixture();
    value["definitions"][0]["target"] = json!(target);
    value["contents"][0] = json!({"target":target,"sha256":digest,"length":unsupported.len()});
    let index = parse(&value).unwrap();
    index.verify_content(&target, unsupported).unwrap();
    // Semantic validation is a subsequent independent gate; this API returns no Catalog.
    assert_eq!(index.definitions()[0].stable_id(), "fixture-port");
}

#[test]
fn embedded_port_identities_fit_without_renaming_or_reordering() {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut value = json!({"index_schema":1,"definitions":[],"contents":[]});
    let mut payloads = Vec::new();
    for port in catalog.ports() {
        let bytes = serde_json::to_vec(port).unwrap();
        let digest = hex::encode(Sha256::digest(&bytes));
        let target = format!("sha256/{digest}.json");
        value["definitions"].as_array_mut().unwrap().push(json!({
            "namespace":"official","stable_id":port.id,"revision":1,"target":target
        }));
        value["contents"].as_array_mut().unwrap().push(json!({
            "target":target,"sha256":digest,"length":bytes.len()
        }));
        payloads.push(bytes);
    }
    let index = parse(&value).unwrap();
    assert_eq!(index.definitions().len(), catalog.ports().len());
    for ((definition, port), bytes) in index
        .definitions()
        .iter()
        .zip(catalog.ports())
        .zip(payloads)
    {
        assert_eq!(definition.stable_id(), port.id);
        assert_eq!(definition.namespace(), "official");
        index.verify_content(definition.target(), &bytes).unwrap();
    }
    // This proves identity representation, not successor entry admission or migration.
}
