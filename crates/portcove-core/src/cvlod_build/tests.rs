use super::super::RECEIPT;
use super::*;

fn fixture() -> (crate::PortDefinition, crate::SourceProfile) {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut port = catalog.port("cvlod-recomp").unwrap().clone();
    port.release.managed_build = BTreeMap::from([(Platform::WindowsX86_64, RECIPE)]);
    port.runtime_source_hashes = BTreeMap::from([("rom.z64".into(), ORIGINAL.into())]);
    port.windows_runtime_path_policy = Some(crate::WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
    (
        port,
        catalog
            .source_profile("castlevania-legacy-of-darkness")
            .unwrap()
            .clone(),
    )
}

#[test]
fn cvlod_complete_catalog_and_retained_entry_bind_both_required_capabilities() {
    let (port, _) = fixture();
    let mut document = crate::Catalog::embedded().unwrap().authoritative_document();
    *document.ports.iter_mut().find(|p| p.id == port.id).unwrap() = port.clone();
    let catalog = crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    crate::test_fixture::retained_qualification(&port, Platform::WindowsX86_64).unwrap();
    let bundle = crate::test_fixture::indexed_catalog_bundle(&catalog, &port.id);
    let index = crate::DefinitionContentIndex::parse(&bundle.index).unwrap();
    let (_, bytes) = bundle
        .contents
        .iter()
        .find(|(_, bytes)| {
            serde_json::from_slice::<serde_json::Value>(bytes)
                .unwrap()
                .get("definition_schema")
                .is_some()
        })
        .unwrap();
    let entry = index.inspect_entry("official", &port.id, bytes).unwrap();
    assert!(entry.capabilities().compatible);
    let value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    assert_eq!(value["required_capabilities"].as_array().unwrap().len(), 2);
    assert_eq!(
        value["required_capabilities"][0]["template"],
        "n64-recomp-portable"
    );
    assert_eq!(value["required_capabilities"][0]["minimum_version"], 3);
    assert_eq!(
        value["required_capabilities"][1]["template"],
        "staged-source-portable"
    );
    assert_eq!(value["required_capabilities"][1]["minimum_version"], 11);
    assert_eq!(
        serde_json::to_value(entry.port()).unwrap(),
        serde_json::to_value(port).unwrap()
    );
}

#[test]
fn cvlod_fixed_contract_refuses_executable_original_or_mutable_authority_changes() {
    let (port, profile) = fixture();
    validate_port(&port, &profile).unwrap();
    assert_eq!(RECIPE.capability_template(), "n64-recomp-portable");
    assert_eq!(RECIPE.minimum_template_version(), 3);
    assert_eq!(
        RECIPE.original_filename(),
        ".portcove-cvlod-build-original.z64"
    );
    for change in 0..8 {
        let mut changed = port.clone();
        let mut original = profile.clone();
        match change {
            0 => changed
                .persistent_paths
                .push(RECIPE.original_filename().into()),
            1 => changed.runtime_mutable_paths.push(RECEIPT.into()),
            2 => changed
                .executable_hints
                .insert(Platform::WindowsX86_64, vec!["other.exe".into()])
                .map(|_| ())
                .unwrap(),
            3 => changed.release.repository = "other/runtime".into(),
            4 => original.accepted_sha1 = vec!["0".repeat(40)],
            5 => changed.launch_arguments.push("--other-source".into()),
            6 => changed
                .release
                .managed_build
                .insert(Platform::LinuxX86_64, RECIPE)
                .map(|_| ())
                .unwrap_or(()),
            _ => changed.windows_runtime_path_policy = None,
        }
        assert!(
            validate_port(&changed, &original).is_err(),
            "change {change}"
        );
    }
}

#[test]
fn cvlod_acquisition_is_fixed_and_release_replacement_cannot_select_publisher_binaries() {
    assert_eq!(archives().len(), 36);
    let blobs = blobs().unwrap();
    assert_eq!(blobs.len(), 1454);
    assert_eq!(RECIPE.acquisition_assets().unwrap().len(), 1490);
    let mut names = std::collections::BTreeSet::new();
    for blob in blobs {
        let url = reqwest::Url::parse(&blob.asset.url).unwrap();
        assert_eq!(url.host_str(), Some("raw.githubusercontent.com"));
        assert!(names.insert(blob.relative));
    }
    let release = resolve(crate::ReleaseChannel::Stable).unwrap();
    verify_release(&release).unwrap();
    assert!(resolve(crate::ReleaseChannel::Beta).is_err());
    let mut changed = release.clone();
    changed.asset.name = "LodRecomp-v0.2.27-windows-x64.zip".into();
    assert!(verify_release(&changed).is_err());
    changed = release;
    changed.asset.sha256 = "0".repeat(64);
    assert!(verify_release(&changed).is_err());
    assert!(
        serde_json::from_str::<CartridgeBuildRecipe>(
            "\"cvlod-n64-source-cb8548d145a1-ui-lifetime-v2\""
        )
        .is_err()
    );
}

#[test]
fn cvlod_new_template_preserves_the_existing_version_negotiations() {
    let request = crate::DefinitionCapabilityRequest {
        capability_contract_schema: 1,
        required_capabilities: vec![crate::DefinitionCapabilityRequirement {
            template: "n64-recomp-portable".into(),
            minimum_version: 3,
            maximum_version: 3,
        }],
    };
    assert!(
        crate::check_definition_capabilities(&request)
            .unwrap()
            .compatible
    );
    // Keep v1/v2 behavior available. A new recipe's grant does not reinterpret
    // the old template versions or publisher-scoped acquisition.
    for version in [1, 2] {
        let mut older = request.clone();
        older.required_capabilities[0].minimum_version = version;
        older.required_capabilities[0].maximum_version = version;
        assert!(
            crate::check_definition_capabilities(&older)
                .unwrap()
                .compatible
        );
    }
}
