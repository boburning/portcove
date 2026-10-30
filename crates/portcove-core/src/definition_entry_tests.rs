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

#[test]
fn native_ascii_paths_require_version7_instead_of_silently_using_an_older_reader() {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut port = catalog.port("opentyrian-opentyrian").unwrap().clone();
    port.windows_runtime_path_policy = Some(crate::WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
    let mut entry = entry_for_port(&port);
    for version in 1..=6 {
        entry["required_capabilities"][0]["minimum_version"] = json!(version);
        entry["required_capabilities"][0]["maximum_version"] = json!(7);
        assert!(inspect(&entry).unwrap_err().message.contains("version 7"));
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(7);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
}

#[test]
fn n64_executable_parent_requires_a_new_reader_and_nonconflicting_root() {
    let mut document = crate::Catalog::embedded().unwrap().authoritative_document();
    let port = document
        .ports
        .iter_mut()
        .find(|p| p.id == "road-rash-64-recompiled")
        .unwrap();
    port.n64_runtime_at_executable_parent = true;
    if let Some(root) = port.runtime_subdirectory.take() {
        let prefix = format!("{root}/");
        port.persistent_paths = port
            .persistent_paths
            .iter()
            .map(|p| p.strip_prefix(&prefix).unwrap().to_owned())
            .collect();
    }
    port.portable_marker = true;
    let catalog = crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let mut entry = entry_for_port(catalog.port("road-rash-64-recompiled").unwrap());
    for version in [1, 2, 3] {
        entry["required_capabilities"][0]["minimum_version"] = json!(version);
        entry["required_capabilities"][0]["maximum_version"] = json!(4);
        assert!(inspect(&entry).unwrap_err().message.contains("version 4"));
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(4);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
    for (field, value) in [
        ("runtime_subdirectory", json!("old-version")),
        ("launch_from_install_root", json!(true)),
        ("user_data_environment", json!("EXTERNAL_DATA")),
        ("adapter", json!("native-portable")),
    ] {
        let mut changed = serde_json::to_value(&document).unwrap();
        let changed_port = changed["ports"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|port| port["id"] == "road-rash-64-recompiled")
            .unwrap();
        changed_port[field] = value;
        assert!(
            crate::Catalog::from_json(&changed.to_string()).is_err(),
            "{field}"
        );
    }
}

#[test]
fn native_manual_progress_requires_its_reader_and_owned_data_boundary() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("re-rac-rerac").unwrap();
    let mut entry = entry_for_port(port);
    entry["required_capabilities"][0]["minimum_version"] = json!(1);
    entry["required_capabilities"][0]["maximum_version"] = json!(2);
    assert!(inspect(&entry).unwrap_err().message.contains("version 2"));
    entry["required_capabilities"][0]["minimum_version"] = json!(2);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
    for marker in [
        "../outside.json",
        "outside.json",
        "game-data",
        "game-data/result.txt",
    ] {
        let mut changed = catalog.authoritative_document().clone();
        changed
            .ports
            .iter_mut()
            .find(|p| p.id == port.id)
            .unwrap()
            .setup_marker = Some(marker.into());
        assert!(crate::Catalog::from_json(&serde_json::to_string(&changed).unwrap()).is_err());
    }
}

#[test]
fn ready_staged_archive_entries_require_prelaunch_preservation_reader() {
    let catalog = crate::Catalog::embedded().unwrap();
    for id in [
        "alariq-mc2",
        "crash-team-racing-ctr-native",
        "f-zero-snes-recomp",
    ] {
        let mut entry = entry_for_port(catalog.port(id).unwrap());
        for version in [1, 20, 21, 22] {
            entry["required_capabilities"][0]["minimum_version"] = json!(version);
            entry["required_capabilities"][0]["maximum_version"] = json!(23);
            assert!(inspect(&entry).unwrap_err().message.contains("version 23"));
        }
        entry["required_capabilities"][0]["minimum_version"] = json!(23);
        assert!(inspect(&entry).unwrap().capabilities().compatible);
    }
}

#[test]
fn fresh_direct_entries_require_v25_without_reinterpreting_retained_or_exact_old_readers() {
    let catalog = crate::Catalog::embedded().unwrap();
    let packet: Value = serde_json::from_str(include_str!(
        "../../../docs/qualification/retained-direct-decisions-2026-10-27.json"
    ))
    .unwrap();
    for id in [
        "sonic-3-and-knuckles-recomp",
        "sonic-the-hedgehog-recomp",
        "mega-man-x2-snes-recomp",
    ] {
        let mut port = catalog.port(id).unwrap().clone();
        // Synthetic successor identity selects the guard; no artifact is run.
        port.release.provider = crate::ReleaseSource::Github;
        port.release.repository = "fixture/guarded-reader".into();
        port.release.direct.clear();
        let mut entry = entry_for_port(&port);
        for minimum in [1, 23, 24] {
            entry["required_capabilities"][0]["minimum_version"] = json!(minimum);
            entry["required_capabilities"][0]["maximum_version"] = json!(25);
            assert!(
                inspect(&entry).unwrap_err().message.contains("version 25"),
                "{id}"
            );
        }
        entry["required_capabilities"][0]["minimum_version"] = json!(23);
        entry["required_capabilities"][0]["maximum_version"] = json!(23);
        let bytes = serde_json::to_vec(&entry).unwrap();
        let retained = index(&bytes, id)
            .inspect_retained_entry("official", id, &bytes)
            .unwrap();
        assert_eq!(
            serde_json::to_value(retained.port()).unwrap(),
            entry["port"]
        );
        entry["required_capabilities"][0]["minimum_version"] = json!(25);
        entry["required_capabilities"][0]["maximum_version"] = json!(25);
        assert!(inspect(&entry).unwrap().capabilities().compatible);
        entry["required_capabilities"][0]["minimum_version"] = json!(26);
        entry["required_capabilities"][0]["maximum_version"] = json!(26);
        assert!(!inspect(&entry).unwrap().capabilities().compatible);
        let old = packet["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == id)
            .unwrap();
        let mut old_value = old["old"]["integration"].clone();
        for name in ["id", "name", "summary", "project_url"] {
            old_value[name] = serde_json::to_value(&port).unwrap()[name].clone();
        }
        let old_port: crate::PortDefinition = serde_json::from_value(old_value).unwrap();
        let mut old_entry = entry_for_port(&old_port);
        old_entry["required_capabilities"][0]["minimum_version"] = json!(23);
        old_entry["required_capabilities"][0]["maximum_version"] = json!(23);
        assert!(
            inspect(&old_entry).unwrap().capabilities().compatible,
            "{id}"
        );
    }
}

#[test]
fn versioned_mod_package_entries_require_their_reader_even_when_retained() {
    let catalog = crate::test_fixture::versioned_mod_catalog();
    let mut entry = entry_for_port(&catalog.ports()[0]);
    entry["required_capabilities"][0]["maximum_version"] = json!(24);
    for minimum in [1, 22, 23] {
        entry["required_capabilities"][0]["minimum_version"] = json!(minimum);
        assert!(inspect(&entry).unwrap_err().message.contains("version 24"));
        let bytes = serde_json::to_vec(&entry).unwrap();
        assert!(
            index(&bytes, "versioned-mod-fixture")
                .inspect_retained_entry("official", "versioned-mod-fixture", &bytes)
                .unwrap_err()
                .message
                .contains("version 24")
        );
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(24);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
}

#[test]
fn prepared_source_directory_requires_v18_and_preserves_its_projection() {
    let catalog = crate::Catalog::from_json(include_str!(
        "../tests/fixtures/prepared-source-directory.json"
    ))
    .unwrap();
    let mut entry = entry_for_port(&catalog.ports()[0]);
    for minimum in [1, 17] {
        entry["required_capabilities"][0]["minimum_version"] = json!(minimum);
        entry["required_capabilities"][0]["maximum_version"] = json!(18);
        assert!(inspect(&entry).unwrap_err().message.contains("version 18"));
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(18);
    let inspected = inspect(&entry).unwrap();
    assert!(inspected.capabilities().compatible);
    assert_eq!(
        serde_json::to_value(inspected.port()).unwrap(),
        entry["port"]
    );
    entry["port"]["release"]["user_prepared"]["windows-x86-64"]["source_directory_environment"] =
        json!("true");
    assert!(inspect(&entry).is_err());
}

#[test]
fn runtime_credential_policy_requires_the_exact_new_reader_floor() {
    let catalog = crate::test_fixture::historical_managed_policy_catalog();
    let port = catalog.port("wave-race-64-racewave46").unwrap();
    let mut entry = entry_for_port(port);
    assert!(inspect(&entry).unwrap_err().message.contains("version 19"));
    entry["required_capabilities"][0]["maximum_version"] = json!(14);
    entry["required_capabilities"][0]["minimum_version"] = json!(14);
    assert!(inspect(&entry).unwrap_err().message.contains("version 19"));
    entry["required_capabilities"][0]["maximum_version"] = json!(15);
    assert!(inspect(&entry).unwrap_err().message.contains("version 19"));
    entry["required_capabilities"][0]["minimum_version"] = json!(15);
    assert!(inspect(&entry).unwrap_err().message.contains("version 19"));
    entry["required_capabilities"][0]["minimum_version"] = json!(19);
    entry["required_capabilities"][0]["maximum_version"] = json!(19);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
    entry["port"]["runtime_data_policy"] = json!("racewave46-v1.0.0-windows");
    entry["required_capabilities"][0]["minimum_version"] = json!(15);
    entry["required_capabilities"][0]["maximum_version"] = json!(15);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
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
fn psx_package_preserving_activation_requires_new_admission_floor_but_retains_v1() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog
        .ports()
        .iter()
        .find(|port| port.adapter == crate::AdapterKind::PsxRecompManaged)
        .unwrap();
    let mut entry = entry_for_port(port);
    assert!(
        inspect(&entry)
            .unwrap_err()
            .message
            .contains("capability version 2")
    );
    let bytes = serde_json::to_vec(&entry).unwrap();
    let retained = index(&bytes, &port.id)
        .inspect_retained_entry("official", &port.id, &bytes)
        .unwrap();
    assert!(retained.capabilities().compatible);
    assert_eq!(
        serde_json::to_value(retained.port()).unwrap(),
        entry["port"]
    );
    entry["required_capabilities"][0]["minimum_version"] = json!(2);
    entry["required_capabilities"][0]["maximum_version"] = json!(2);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
    entry["required_capabilities"][0]["minimum_version"] = json!(3);
    entry["required_capabilities"][0]["maximum_version"] = json!(3);
    assert!(!inspect(&entry).unwrap().capabilities().compatible);
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
fn initial_renderer_requires_an_entry_window_that_excludes_v1() {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut entry = entry_for_port(catalog.port("dr-mario-64-recomp").unwrap());
    assert!(inspect(&entry).is_err());
    entry["required_capabilities"][0]["maximum_version"] = 2.into();
    assert!(inspect(&entry).is_err());
    entry["required_capabilities"][0]["minimum_version"] = 2.into();
    assert!(inspect(&entry).unwrap().capabilities().compatible);
}

#[test]
fn managed_shared_preferences_require_a_window_excluding_older_readers() {
    let catalog = crate::test_fixture::historical_managed_policy_catalog();
    let mut entry = entry_for_port(catalog.port("resident-evil-gaiden-recomp").unwrap());
    assert!(inspect(&entry).unwrap_err().message.contains("version 19"));
    entry["required_capabilities"][0]["maximum_version"] = json!(15);
    entry["required_capabilities"][0]["minimum_version"] = json!(15);
    assert!(inspect(&entry).unwrap_err().message.contains("version 19"));
    entry["required_capabilities"][0]["maximum_version"] = json!(16);
    assert!(inspect(&entry).unwrap_err().message.contains("version 19"));
    entry["required_capabilities"][0]["minimum_version"] = json!(16);
    assert!(inspect(&entry).unwrap_err().message.contains("version 19"));
    entry["required_capabilities"][0]["maximum_version"] = json!(19);
    entry["required_capabilities"][0]["minimum_version"] = json!(19);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
    entry["port"]["managed_shared_preferences"] = json!("regaiden041-windows");
    entry["port"]
        .as_object_mut()
        .unwrap()
        .remove("managed_shared_preferences_save_id");
    entry["required_capabilities"][0]["minimum_version"] = json!(16);
    entry["required_capabilities"][0]["maximum_version"] = json!(16);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
}

#[test]
fn provider_bound_runtime_policies_exclude_older_readers_without_reinterpreting_direct_entries() {
    let current = crate::Catalog::embedded().unwrap();
    let historical = crate::test_fixture::historical_managed_policy_catalog();
    for id in [
        "the-force-engine-dark-forces",
        "resident-evil-gaiden-recomp",
        "wave-race-64-racewave46",
    ] {
        let mut entry = entry_for_port(current.port(id).unwrap());
        for version in [1, 19, 20] {
            entry["required_capabilities"][0]["minimum_version"] = json!(version);
            entry["required_capabilities"][0]["maximum_version"] = json!(version);
            assert!(
                inspect(&entry).unwrap_err().message.contains("version 21"),
                "{id}: v{version}"
            );
        }
        entry["required_capabilities"][0]["minimum_version"] = json!(21);
        entry["required_capabilities"][0]["maximum_version"] = json!(21);
        assert!(inspect(&entry).unwrap().capabilities().compatible, "{id}");
        entry["port"] = serde_json::to_value(historical.port(id).unwrap()).unwrap();
        entry["required_capabilities"][0]["minimum_version"] = json!(19);
        entry["required_capabilities"][0]["maximum_version"] = json!(19);
        assert!(
            inspect(&entry).unwrap().capabilities().compatible,
            "historical direct {id}"
        );
    }
}

#[test]
fn every_existing_official_projection_keeps_its_complete_fields() {
    let mut value = fixture();
    for port in crate::Catalog::embedded().unwrap().ports() {
        value["stable_id"] = json!(port.id);
        value["port"] = serde_json::to_value(port).unwrap();
        value["required_capabilities"][0]["template"] = json!(port.adapter);
        // These synthetic envelopes must declare the semantics of the real port.
        // Keep entry_for_port at v1 for the explicit older-reader refusal tests.
        let version = if crate::preparation::source::native(port) {
            6
        } else if port.windows_temp_directory.is_some() {
            5
        } else if port.adapter == crate::AdapterKind::NativePortable
            && port.release.provider == crate::ReleaseSource::DirectManifest
        {
            if port.windows_runtime_path_policy.is_some() {
                crate::runtime_path_policy::minimum_capability(port)
            } else {
                3
            }
        } else if port.adapter == crate::AdapterKind::PsxRecompManaged {
            2
        } else if port
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.trust == crate::ExternalRuntimeTrust::UserSelected)
        {
            20
        } else if crate::preparation::has_manual_marker(port) {
            2
        } else if crate::persistence::requires_fresh_direct_data_guard(port) {
            25
        } else if port.mod_package_policy.is_some() {
            24
        } else if crate::persistence::ready_staged_archive(port) {
            23
        } else if crate::managed_runtime_policy::requires_provider_resolution(port) {
            21
        } else if port.managed_initialization
            == Some(crate::ManagedInitialization::TfeDarkForcesPortableV1)
            || port.runtime_data_policy
                == Some(crate::RuntimeDataPolicy::VersionLocalRetroAchievementsV1)
            || port.managed_shared_preferences
                == Some(crate::PreparedSharedPreferencesContract::GbRecompiledWindowsV1)
        {
            19
        } else if port.managed_shared_preferences.is_some() {
            16
        } else if port.runtime_data_policy.is_some() {
            15
        } else if port.managed_initialization.is_some() {
            12
        } else if port.windows_runtime_path_policy.is_some() {
            crate::runtime_path_policy::minimum_capability(port)
        } else if let Some(minimum) = port
            .release
            .user_prepared
            .values()
            .filter_map(|runtime| {
                runtime
                    .shared_preferences
                    .map(|contract| contract.minimum_template_version())
            })
            .max()
        {
            minimum
        } else if let Some(version) = port
            .release
            .managed_build
            .values()
            .map(|recipe| recipe.minimum_template_version())
            .max()
        {
            version
        } else if port
            .release
            .user_prepared
            .values()
            .any(|r| r.settings_contract.is_some())
        {
            5
        } else if port
            .release
            .user_prepared
            .values()
            .any(|r| !r.required_mutable_files.is_empty())
        {
            4
        } else if port.release.provider == crate::ReleaseSource::UserPrepared
            && port.runtime_subdirectory.is_some()
        {
            3
        } else if port.n64_runtime_at_executable_parent {
            4
        } else if port.n64_windows_initial_d3d12
            || port
                .release
                .user_prepared
                .values()
                .any(|r| r.library_user_data)
        {
            2
        } else {
            1
        };
        value["required_capabilities"] =
            json!(crate::test_fixture::definition_requirements(port, version));
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

fn historical_prepared_catalog() -> crate::Catalog {
    crate::Catalog::from_json(include_str!(
        "../tests/fixtures/dkc3-006-prepared-historical.json"
    ))
    .unwrap()
}

#[test]
fn prepared_windows_path_semantics_refuse_pre_v17_envelopes() {
    let mut port = historical_prepared_catalog()
        .port("dkc3-recomp")
        .unwrap()
        .clone();
    port.platforms = vec![crate::Platform::WindowsX86_64];
    port.release
        .user_prepared
        .retain(|platform, _| *platform == crate::Platform::WindowsX86_64);
    port.windows_runtime_path_policy = Some(crate::WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
    let mut entry = entry_for_port(&port);
    entry["required_capabilities"][0]["maximum_version"] = json!(17);
    for version in [1, 11, 14, 15, 16] {
        entry["required_capabilities"][0]["minimum_version"] = json!(version);
        assert!(inspect(&entry).is_err());
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(17);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
}

#[test]
fn prepared_private_data_requires_version_two_without_widening_legacy_entries() {
    let mut port = historical_prepared_catalog()
        .port("dkc3-recomp")
        .unwrap()
        .clone();
    let legacy = entry_for_port(&port);
    assert!(inspect(&legacy).is_ok());
    port.user_data_environment = Some("FIXTURE_USER_DIR".into());
    port.release
        .user_prepared
        .values_mut()
        .for_each(|runtime| runtime.library_user_data = true);
    let mut entry = entry_for_port(&port);
    assert!(inspect(&entry).is_err());
    entry["required_capabilities"][0]["maximum_version"] = json!(2);
    assert!(inspect(&entry).is_err());
    entry["required_capabilities"][0]["minimum_version"] = json!(2);
    assert!(inspect(&entry).is_ok());
}

#[test]
fn shared_preferences_require_v8_and_preserve_unknown_variant_refusal() {
    let mut port = historical_prepared_catalog()
        .port("dkc3-recomp")
        .unwrap()
        .clone();
    for runtime in port.release.user_prepared.values_mut() {
        runtime.shared_preferences =
            Some(crate::PreparedSharedPreferencesContract::Regaiden041Windows);
    }
    let mut entry = entry_for_port(&port);
    entry["required_capabilities"][0]["maximum_version"] = json!(8);
    for minimum in 1..8 {
        entry["required_capabilities"][0]["minimum_version"] = json!(minimum);
        assert!(inspect(&entry).is_err());
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(8);
    assert!(inspect(&entry).is_ok());
    entry["port"]["release"]["user_prepared"]["windows-x86-64"]["shared_preferences"] =
        json!("arbitrary-path");
    assert!(inspect(&entry).is_err());
}

#[test]
fn prepared_nested_directory_requires_version_three_and_staged_adapter() {
    let mut port = historical_prepared_catalog()
        .port("dkc3-recomp")
        .unwrap()
        .clone();
    port.runtime_subdirectory = Some("Install/Base".into());
    let mut entry = entry_for_port(&port);
    for minimum in [1, 2] {
        entry["required_capabilities"][0]["minimum_version"] = json!(minimum);
        entry["required_capabilities"][0]["maximum_version"] = json!(3);
        assert!(inspect(&entry).is_err());
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(3);
    assert!(inspect(&entry).is_ok());
    port.adapter = crate::AdapterKind::N64RecompPortable;
    let mut document = historical_prepared_catalog().authoritative_document();
    *document
        .ports
        .iter_mut()
        .find(|candidate| candidate.id == "dkc3-recomp")
        .unwrap() = port;
    let error = crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap_err();
    assert!(
        error
            .message
            .contains("prepared runtime subdirectory requires staged-source")
    );
}

#[test]
fn prepared_settings_require_version_five_and_narrow_declaration() {
    let catalog = historical_prepared_catalog();
    let mut port = catalog.port("dkc3-recomp").unwrap().clone();
    for runtime in port.release.user_prepared.values_mut() {
        runtime.version = "1.22.420".into();
        runtime.source_argument_extension = None;
        runtime.mutable_paths.push("settings.ini".into());
        runtime.required_mutable_files.push("settings.ini".into());
        runtime.settings_contract =
            Some(crate::PreparedRuntimeSettingsContract::TfeDarkForces122420);
    }
    let mut entry = entry_for_port(&port);
    entry["required_capabilities"][0]["maximum_version"] = json!(5);
    for minimum in 1..5 {
        entry["required_capabilities"][0]["minimum_version"] = json!(minimum);
        assert!(inspect(&entry).is_err());
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(5);
    assert!(inspect(&entry).is_ok());
    let mut document = catalog.authoritative_document();
    *document
        .ports
        .iter_mut()
        .find(|p| p.id == "dkc3-recomp")
        .unwrap() = port;
    let valid = serde_json::to_value(document).unwrap();
    assert!(crate::Catalog::from_json(&valid.to_string()).is_ok());
    let index = valid["ports"]
        .as_array()
        .unwrap()
        .iter()
        .position(|p| p["id"] == "dkc3-recomp")
        .unwrap();
    for (field, value) in [
        ("version", json!("1.22.419")),
        ("executable", json!("bin/DKC3Recomp.exe")),
        ("source_argument_extension", json!("gob")),
        ("library_user_data", json!(true)),
        ("required_mutable_files", json!([])),
        (
            "mutable_paths",
            json!(["settings.ini", "GameData/DARK.GOB"]),
        ),
    ] {
        let mut changed = valid.clone();
        changed["ports"][index]["release"]["user_prepared"]["windows-x86-64"][field] = value;
        assert!(
            crate::Catalog::from_json(&changed.to_string()).is_err(),
            "{field}"
        );
    }
    for (field, value) in [
        ("runtime_subdirectory", json!("bin")),
        ("launch_arguments", json!(["-gOUTLAWS"])),
    ] {
        let mut changed = valid.clone();
        changed["ports"][index][field] = value;
        assert!(
            crate::Catalog::from_json(&changed.to_string()).is_err(),
            "{field}"
        );
    }
}

#[test]
fn prepared_required_mutable_files_require_version_four_and_complete_projection() {
    let mut port = historical_prepared_catalog()
        .port("dkc3-recomp")
        .unwrap()
        .clone();
    let legacy = entry_for_port(&port);
    assert!(inspect(&legacy).is_ok());
    for runtime in port.release.user_prepared.values_mut() {
        runtime.mutable_paths.push("settings.ini".into());
        runtime.required_mutable_files.push("settings.ini".into());
    }
    let mut entry = entry_for_port(&port);
    for minimum in [1, 2, 3] {
        entry["required_capabilities"][0]["minimum_version"] = json!(minimum);
        entry["required_capabilities"][0]["maximum_version"] = json!(4);
        assert!(inspect(&entry).is_err());
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(4);
    assert!(inspect(&entry).is_ok());
    let platform = serde_json::to_value(port.platforms[0]).unwrap();
    let platform = platform.as_str().unwrap();
    entry["port"]["release"]["user_prepared"][platform]["unimplemented_selector_semantics"] =
        json!(true);
    assert!(inspect(&entry).is_err());
    assert!(inspect(&legacy).is_ok());
    port.adapter = crate::AdapterKind::N64RecompPortable;
    let mut document = historical_prepared_catalog().authoritative_document();
    *document
        .ports
        .iter_mut()
        .find(|candidate| candidate.id == "dkc3-recomp")
        .unwrap() = port;
    assert!(crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).is_err());
}

#[test]
fn pinned_native_entries_require_v3_for_new_and_retained_readers() {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut port = catalog.port("marathon-aleph-one").unwrap().clone();
    port.windows_runtime_path_policy = None;
    let mut entry = entry_for_port(&port);
    entry["required_capabilities"][0]["maximum_version"] = json!(3);
    for minimum in [1, 2] {
        entry["required_capabilities"][0]["minimum_version"] = json!(minimum);
        assert!(inspect(&entry).unwrap_err().message.contains("version 3"));
        let bytes = serde_json::to_vec(&entry).unwrap();
        assert!(
            index(&bytes, &port.id)
                .inspect_retained_entry("official", &port.id, &bytes)
                .unwrap_err()
                .message
                .contains("version 3")
        );
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(3);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
    let bytes = serde_json::to_vec(&entry).unwrap();
    assert!(
        index(&bytes, &port.id)
            .inspect_retained_entry("official", &port.id, &bytes)
            .unwrap()
            .capabilities()
            .compatible
    );
    let ordinary = entry_for_port(catalog.port("openrct2-openrct2").unwrap());
    assert!(inspect(&ordinary).unwrap().capabilities().compatible);
}

#[test]
fn native_packaged_path_policy_requires_v4_for_new_and_retained_entries() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("marathon-aleph-one").unwrap();
    let mut entry = entry_for_port(port);
    entry["required_capabilities"][0]["maximum_version"] = json!(4);
    for minimum in [1, 2, 3] {
        entry["required_capabilities"][0]["minimum_version"] = json!(minimum);
        assert!(inspect(&entry).unwrap_err().message.contains("version"));
        let bytes = serde_json::to_vec(&entry).unwrap();
        assert!(
            index(&bytes, &port.id)
                .inspect_retained_entry("official", &port.id, &bytes)
                .is_err()
        );
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(4);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
    let bytes = serde_json::to_vec(&entry).unwrap();
    assert!(
        index(&bytes, &port.id)
            .inspect_retained_entry("official", &port.id, &bytes)
            .unwrap()
            .capabilities()
            .compatible
    );
}

#[test]
fn windows_temporary_data_requires_native5_in_fresh_and_retained_interpretation() {
    let port = crate::native_temp::tests::port();
    let mut entry = entry_for_port(&port);
    for version in 1..5 {
        entry["required_capabilities"][0]["minimum_version"] = json!(version);
        entry["required_capabilities"][0]["maximum_version"] = json!(5);
        assert!(inspect(&entry).unwrap_err().message.contains("version 5"));
        let bytes = serde_json::to_vec(&entry).unwrap();
        assert!(
            index(&bytes, &port.id)
                .inspect_retained_entry("official", &port.id, &bytes)
                .unwrap_err()
                .message
                .contains("version 5")
        );
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(5);
    entry["required_capabilities"][0]["maximum_version"] = json!(5);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
    let bytes = serde_json::to_vec(&entry).unwrap();
    assert!(
        index(&bytes, &port.id)
            .inspect_retained_entry("official", &port.id, &bytes)
            .unwrap()
            .capabilities()
            .compatible
    );
    entry["required_capabilities"][0]["maximum_version"] = json!(4);
    assert!(inspect(&entry).is_err());
    // Native7 is now implemented; retain refusal for an unimplemented future reader.
    entry["required_capabilities"][0]["minimum_version"] = json!(8);
    entry["required_capabilities"][0]["maximum_version"] = json!(8);
    assert!(!inspect(&entry).unwrap().capabilities().compatible);
}

#[test]
fn native_originals_require_native6_in_fresh_and_retained_readers() {
    let mut port = crate::native_temp::tests::port();
    port.source_profile = Some("owned-file-set".into());
    let mut entry = entry_for_port(&port);
    for version in 1..6 {
        entry["required_capabilities"][0]["minimum_version"] = json!(version);
        entry["required_capabilities"][0]["maximum_version"] = json!(6);
        assert!(inspect(&entry).unwrap_err().message.contains("version 6"));
        let bytes = serde_json::to_vec(&entry).unwrap();
        assert!(
            index(&bytes, &port.id)
                .inspect_retained_entry("official", &port.id, &bytes)
                .unwrap_err()
                .message
                .contains("version 6")
        );
    }
    entry["required_capabilities"][0]["minimum_version"] = json!(6);
    assert!(inspect(&entry).unwrap().capabilities().compatible);
    let bytes = serde_json::to_vec(&entry).unwrap();
    assert!(
        index(&bytes, &port.id)
            .inspect_retained_entry("official", &port.id, &bytes)
            .unwrap()
            .capabilities()
            .compatible
    );
}
