use super::*;
use serde_json::{Value, json};

fn fixture(schema: u32) -> BTreeMap<String, Vec<u8>> {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("shipwright").unwrap();
    let leaf = serde_json::to_vec(&json!({"contract_schema":1,"representation":"catalog_projection","catalog":catalog.authoritative_document()})).unwrap();
    let leaf_target = format!("sha256/{}.json", hash(&leaf));
    let entry = serde_json::to_vec(&json!({"definition_schema":1,"namespace":"official","stable_id":port.id,"revision":1,"port":port,
        "required_capabilities":[{"template":"libultraship-portable","minimum_version":1,"maximum_version":1}],
        "source_contracts":[leaf_target],"execution_contract":leaf_target,"persistence_contract":leaf_target,"artifact_bindings":[],"evidence_references":[]})).unwrap();
    let entry_target = format!("sha256/{}.json", hash(&entry));
    let index = serde_json::to_vec(&json!({"index_schema":1,"definitions":[{"namespace":"official","stable_id":port.id,"revision":1,"target":entry_target}],
        "contents":[{"target":entry_target,"sha256":hash(&entry),"length":entry.len()},{"target":leaf_target,"sha256":hash(&leaf),"length":leaf.len()}]})).unwrap();
    let mut decision = json!({"status":"availability","definition_revision":1,"index_sha256":hash(&index),"definition_sha256":hash(&entry),"template":"libultraship-portable"});
    if schema >= 2 {
        decision["status"] = "managed_github".into();
        decision["repository_id"] = 123.into();
        decision["artifact_hosts"] = json!(["github.com", "release-assets.githubusercontent.com"]);
        decision["max_redirects"] = 2.into();
        decision["operations"] = json!(["install", "update", "prepare", "launch"]);
        if schema >= 3 {
            decision["scoped_launch_checks"] = 1.into();
        }
    }
    let policy = serde_json::to_vec(&json!({"policy_schema":schema,"namespace":"official","stable_id":port.id,"policy_revision":1,
        "grant_id":if schema==1 {"fixture-availability"}else{"managed-github-v1-fixture"},"decision":decision})).unwrap();
    let mut files = BTreeMap::from([
        (INDEX.into(), index),
        (leaf_target, leaf),
        (entry_target, entry),
        ("policy/official/shipwright.json".into(), policy.clone()),
    ]);
    if schema >= 3 {
        files.insert(
            "policy/official/shipwright.launch.json".into(),
            serde_json::to_vec(
                &json!({"assessment_schema":1,"namespace":"official","stable_id":port.id,
            "policy_sha256":hash(&policy),"revision":1,"assessments":[]}),
            )
            .unwrap(),
        );
    }
    files
}

fn replace_policy(files: &mut BTreeMap<String, Vec<u8>>, change: impl FnOnce(&mut Value)) {
    let bytes = files.get_mut("policy/official/shipwright.json").unwrap();
    let mut value: Value = serde_json::from_slice(bytes).unwrap();
    change(&mut value);
    *bytes = serde_json::to_vec(&value).unwrap();
}

#[test]
fn exact_managed_bundle_inspection_is_inert_and_binds_all_bytes() {
    for schema in [1, 2, 3] {
        let files = fixture(schema);
        let report = inspect_definition_publication_bytes(&files).unwrap();
        assert_eq!(report.publication_schema, 1);
        assert_eq!(report.authority, "none");
        assert_eq!(report.files.len(), files.len());
        assert_eq!(report.definitions.len(), 1);
        assert_eq!(report.definitions[0].policy_schema, schema);
        assert_eq!(
            report.definitions[0].launch_revision,
            if schema == 3 { Some(1) } else { None }
        );
        for file in report.files {
            assert_eq!(file.sha256, hash(&files[&file.target]));
        }
    }
}

#[test]
fn policy_substitution_unknown_fields_and_wrong_launch_linkage_refuse() {
    let changes: Vec<fn(&mut Value)> = vec![
        |v| v["decision"]["index_sha256"] = "0".repeat(64).into(),
        |v| v["decision"]["definition_sha256"] = "0".repeat(64).into(),
        |v| v["decision"]["definition_revision"] = 2.into(),
        |v| v["stable_id"] = "another".into(),
        |v| v["decision"]["template"] = "staged-source-portable".into(),
        |v| v["approved"] = true.into(),
    ];
    for change in changes {
        let mut files = fixture(1);
        replace_policy(&mut files, change);
        assert!(inspect_definition_publication_bytes(&files).is_err());
    }
    let mut files = fixture(3);
    let launch = files
        .get_mut("policy/official/shipwright.launch.json")
        .unwrap();
    let mut value: Value = serde_json::from_slice(launch).unwrap();
    value["policy_sha256"] = "0".repeat(64).into();
    *launch = serde_json::to_vec(&value).unwrap();
    assert!(inspect_definition_publication_bytes(&files).is_err());
    files.remove("policy/official/shipwright.launch.json");
    assert!(inspect_definition_publication_bytes(&files).is_err());
}

#[test]
fn extra_missing_changed_and_unreferenced_content_refuse() {
    let mut files = fixture(1);
    files.insert("unexpected.json".into(), b"{}".to_vec());
    assert!(inspect_definition_publication_bytes(&files).is_err());
    let mut files = fixture(1);
    files.remove("policy/official/shipwright.json");
    assert!(inspect_definition_publication_bytes(&files).is_err());
    let mut files = fixture(1);
    let name = files
        .keys()
        .find(|p| p.starts_with("sha256/"))
        .unwrap()
        .clone();
    files.get_mut(&name).unwrap().push(b' ');
    assert!(inspect_definition_publication_bytes(&files).is_err());
    let mut files = fixture(1);
    let extra = b"{}".to_vec();
    let target = format!("sha256/{}.json", hash(&extra));
    let mut index: Value = serde_json::from_slice(&files[INDEX]).unwrap();
    index["contents"]
        .as_array_mut()
        .unwrap()
        .push(json!({"target":target,"length":extra.len(),"sha256":hash(&extra)}));
    files.insert(INDEX.into(), serde_json::to_vec(&index).unwrap());
    files.insert(target, extra);
    let index_hash = hash(&files[INDEX]);
    replace_policy(&mut files, |v| {
        v["decision"]["index_sha256"] = index_hash.into()
    });
    assert!(inspect_definition_publication_bytes(&files).is_err());
}

#[test]
fn local_adapter_uses_fixed_exact_set_and_refuses_aliases() {
    let root = tempfile::tempdir().unwrap();
    let files = fixture(1);
    for (target, bytes) in &files {
        let path = root.path().join(target);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    let report = inspect_definition_publication(root.path()).unwrap();
    assert_eq!(report.files.len(), 4);
    fs::write(root.path().join("extra.json"), b"{}").unwrap();
    assert!(inspect_definition_publication(root.path()).is_err());
    fs::remove_file(root.path().join("extra.json")).unwrap();
    let aliases = tempfile::tempdir().unwrap();
    fs::hard_link(
        root.path().join(INDEX),
        aliases.path().join("retained-link"),
    )
    .unwrap();
    assert!(inspect_definition_publication(root.path()).is_err());
}

#[test]
fn unsupported_engine_is_not_reported_as_accepted_or_malformed() {
    let mut files = fixture(1);
    let index: Value = serde_json::from_slice(&files[INDEX]).unwrap();
    let old_target = index["definitions"][0]["target"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut entry: Value = serde_json::from_slice(&files[&old_target]).unwrap();
    entry["required_capabilities"][0]["minimum_version"] = 999.into();
    entry["required_capabilities"][0]["maximum_version"] = 999.into();
    let bytes = serde_json::to_vec(&entry).unwrap();
    let target = format!("sha256/{}.json", hash(&bytes));
    let mut index = index;
    index["definitions"][0]["target"] = target.clone().into();
    for item in index["contents"].as_array_mut().unwrap() {
        if item["target"] == old_target {
            item["target"] = target.clone().into();
            item["sha256"] = hash(&bytes).into();
            item["length"] = bytes.len().into();
        }
    }
    files.remove(&old_target);
    files.insert(target, bytes);
    files.insert(INDEX.into(), serde_json::to_vec(&index).unwrap());
    let error = inspect_definition_publication_bytes(&files).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported);
}

#[test]
fn producer_bounds_and_duplicate_json_refuse_without_extra_authority() {
    let mut files = fixture(1);
    files.insert(
        "policy/official/shipwright.json".into(),
        vec![b' '; MAX_POLICY + 1],
    );
    assert!(inspect_definition_publication_bytes(&files).is_err());
    let mut files = fixture(1);
    files.insert(
        INDEX.into(),
        br#"{"index_schema":1,"index_schema":1,"definitions":[],"contents":[]}"#.to_vec(),
    );
    assert!(inspect_definition_publication_bytes(&files).is_err());
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("definitions")).unwrap();
    let file = fs::File::create(root.path().join(INDEX)).unwrap();
    file.set_len((MAX_LEAF + 1) as u64).unwrap();
    assert!(inspect_definition_publication(root.path()).is_err());
}

#[test]
fn descriptive_directory_publication_is_exact_and_separate_from_managed_grants() {
    let mut files = BTreeMap::from([(
        INDEX.into(),
        br#"{"index_schema":1,"definitions":[],"contents":[]}"#.to_vec(),
    )]);
    let target = crate::definition_repository::publisher_policy::listing_delivery::TARGET;
    let bytes = serde_json::to_vec(&json!({"listing_delivery_schema":1,"revision":1,"withdrawn_ids":[],"directory":{"format_version":1,"listings":[]}})).unwrap();
    files.insert(target.into(), bytes.clone());
    let report = inspect_definition_publication_bytes(&files).unwrap();
    assert_eq!(report.publication_schema, 2);
    assert!(report.definitions.is_empty());
    assert_eq!(report.listings.unwrap().sha256, hash(&bytes));
    files.insert("policy/official/other.listings.json".into(), bytes);
    assert!(inspect_definition_publication_bytes(&files).is_err());
}
