use crate::{ChildProcessClass, ChildProcessPolicy};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn definition_requirements(
    port: &crate::PortDefinition,
    default_version: u32,
) -> Vec<serde_json::Value> {
    use serde_json::json;
    if port
        .release
        .managed_build
        .values()
        .any(|r| *r == crate::CartridgeBuildRecipe::CvlodSourceV1)
    {
        return vec![
            json!({"template":"n64-recomp-portable","minimum_version":3,"maximum_version":3}),
            json!({"template":"staged-source-portable","minimum_version":11,"maximum_version":11}),
        ];
    }
    vec![
        json!({"template":port.adapter,"minimum_version":default_version,"maximum_version":default_version}),
    ]
}

/// Preserve the last entered test phase when nextest terminates a slow process.
/// Labels contain fixture operations, never user paths or source contents.
pub(crate) fn phase<T>(label: &str, action: impl FnOnce() -> T) -> T {
    let started = std::time::Instant::now();
    eprintln!("test phase started: {label}");
    let result = action();
    eprintln!("test phase finished: {label} ({:?})", started.elapsed());
    result
}

/// Freeze the old direct-policy inputs independently of today's release rules.
/// The reviewed fixture is source-bound to the catalog before GitHub adoption;
/// current dynamic/provider tests must keep using the current embedded catalog.
pub(crate) fn historical_managed_policy_catalog() -> crate::Catalog {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../tests/fixtures/managed-direct-policies-historical.json"
    ))
    .unwrap();
    let ports: Vec<crate::PortDefinition> =
        serde_json::from_value(fixture["ports"].clone()).unwrap();
    let mut document = crate::Catalog::embedded().unwrap().authoritative_document();
    for port in ports {
        let existing = document
            .ports
            .iter_mut()
            .find(|current| current.id == port.id)
            .unwrap();
        *existing = port;
    }
    crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

/// Give synthetic installer fixtures the same complete retention input as a
/// production catalog operation, with their explicitly modified port contract.
pub(crate) fn retained_qualification(
    port: &crate::PortDefinition,
    platform: crate::Platform,
) -> crate::Result<crate::InstallQualification> {
    crate::InstallQualification::from_port(port, platform)?;
    let mut document = crate::Catalog::embedded()?.authoritative_document();
    if let Some(existing) = document.ports.iter_mut().find(|value| value.id == port.id) {
        *existing = port.clone();
    } else {
        document.ports.push(port.clone());
    }
    // A fixture may intentionally exercise only one host. Do not attach another
    // platform's historical qualification to that synthetic definition.
    if let Some(source) = &mut document.source_catalog {
        source.contracts.retain(|contract| {
            contract.port_id != port.id
                || match contract.role {
                    crate::PortSourceRole::Game => port.source_profile.as_ref(),
                    crate::PortSourceRole::Bios => port.bios_source_profile.as_ref(),
                }
                .is_some_and(|profile| *profile == contract.profile_id)
        });
        source.qualification.retain(|record| {
            record.scope.port_id != port.id
                || (port.platforms.contains(&record.scope.platform)
                    && record.scope.contract_id.as_ref().is_none_or(|id| {
                        source.contracts.iter().any(|contract| contract.id == *id)
                    }))
        });
    }
    let catalog = crate::Catalog::from_json(&serde_json::to_string(&document)?)?;
    crate::InstallQualification::from_catalog(&catalog, &port.id, platform)
}

/// Supply exact successor bytes for a synthetic lifecycle contract, without
/// publisher or artifact authority. No network or source acquisition occurs.
pub(crate) struct IndexedCatalogBundle {
    pub(crate) index: Vec<u8>,
    pub(crate) contents: Vec<(String, Vec<u8>)>,
}

pub(crate) fn indexed_catalog_bundle(
    catalog: &crate::Catalog,
    port_id: &str,
) -> IndexedCatalogBundle {
    indexed_catalog_bundle_at_revision(catalog, port_id, 7)
}

pub(crate) fn indexed_catalog_bundle_at_revision(
    catalog: &crate::Catalog,
    port_id: &str,
    revision: u64,
) -> IndexedCatalogBundle {
    IndexedCatalogFixture::new(catalog, port_id).at_revision(revision)
}

/// Immutable projection bytes shared only within one synthetic fixture lifetime.
/// Each revision still receives a distinct entry/index and fresh authentication.
pub(crate) struct IndexedCatalogFixture<'a> {
    port: &'a crate::PortDefinition,
    contract: Vec<u8>,
}

impl<'a> IndexedCatalogFixture<'a> {
    pub(crate) fn new(catalog: &'a crate::Catalog, port_id: &str) -> Self {
        // Keep a noncanonical byte witness for exact retention tests without
        // repeating pretty-print whitespace throughout the complete projection.
        let mut contract = serde_json::to_vec(&serde_json::json!({
            "contract_schema":1,"representation":"catalog_projection",
            "catalog":catalog.authoritative_document()
        }))
        .unwrap();
        contract.push(b'\n');
        Self {
            port: catalog.port(port_id).unwrap(),
            contract,
        }
    }

    pub(crate) fn at_revision(&self, revision: u64) -> IndexedCatalogBundle {
        use serde_json::json;
        use sha2::{Digest, Sha256};
        let target = |bytes: &[u8]| format!("sha256/{}.json", hex::encode(Sha256::digest(bytes)));
        let contract = &self.contract;
        let leaf = target(contract);
        let port = self.port;
        let port_id = &port.id;
        let capability_version = if port.adapter == crate::AdapterKind::PsxRecompManaged {
            2
        } else if port
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.trust == crate::ExternalRuntimeTrust::UserSelected)
        {
            20
        } else if crate::persistence::standalone_staged_archive(port) {
            22
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
                    .map(|scope| scope.minimum_template_version())
            })
            .max()
        {
            minimum
        } else if let Some(minimum) = port
            .release
            .managed_build
            .values()
            .map(|recipe| recipe.minimum_template_version())
            .max()
        {
            minimum
        } else if port
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.settings_contract.is_some())
        {
            5
        } else if port
            .release
            .user_prepared
            .values()
            .any(|runtime| !runtime.required_mutable_files.is_empty())
        {
            4
        } else if !port.release.user_prepared.is_empty() && port.runtime_subdirectory.is_some() {
            3
        } else if port.n64_windows_initial_d3d12
            || port
                .release
                .user_prepared
                .values()
                .any(|runtime| runtime.library_user_data)
        {
            2
        } else {
            1
        };
        let entry = serde_json::to_vec_pretty(&json!({
        "definition_schema":1,"namespace":"official","stable_id":port_id,"revision":revision,
        "required_capabilities":definition_requirements(port, capability_version),
        "port":port,"source_contracts":[leaf],"execution_contract":leaf,"persistence_contract":leaf,
        "artifact_bindings":[],"evidence_references":[]
    }))
    .unwrap();
        let contents: Vec<_> = [&entry, contract].into_iter().map(|bytes| json!({
        "target":target(bytes),"sha256":hex::encode(Sha256::digest(bytes)),"length":bytes.len()
    })).collect();
        let index = serde_json::to_vec_pretty(&json!({
        "index_schema":1,"definitions":[{"namespace":"official","stable_id":port_id,"revision":revision,"target":target(&entry)}],
        "contents":contents
    }))
    .unwrap();
        IndexedCatalogBundle {
            index,
            contents: vec![
                (target(&entry), entry),
                (target(contract), contract.clone()),
            ],
        }
    }
}

#[test]
fn indexed_policy_fixtures_keep_delivered_reader_floors() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, version) in [
        ("resident-evil-gaiden-recomp", 19),
        ("wave-race-64-racewave46", 19),
        ("render96ex", 20),
    ] {
        let bundle = IndexedCatalogFixture::new(&catalog, id).at_revision(7);
        let entry: serde_json::Value = serde_json::from_slice(&bundle.contents[0].1).unwrap();
        assert_eq!(
            entry["required_capabilities"][0]["minimum_version"], version,
            "{id}"
        );
        assert_eq!(
            entry["required_capabilities"][0]["maximum_version"], version,
            "{id}"
        );
        let index = crate::DefinitionContentIndex::parse(&bundle.index).unwrap();
        index
            .inspect_catalog_projection(
                "official",
                id,
                &bundle.contents[0].1,
                &bundle.contents[1].1,
            )
            .unwrap();
    }
}

#[test]
fn indexed_fixture_revisions_preserve_full_catalog_projection() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port_id = &catalog.ports()[0].id;
    let fixture = IndexedCatalogFixture::new(&catalog, port_id);
    let first = fixture.at_revision(8);
    let second = fixture.at_revision(9);
    assert_eq!(first.contents[1], second.contents[1]);
    assert_ne!(first.contents[0], second.contents[0]);
    for (revision, bundle) in [(8, first), (9, second)] {
        let index = crate::DefinitionContentIndex::parse(&bundle.index).unwrap();
        let projection = index
            .inspect_catalog_projection(
                "official",
                port_id,
                &bundle.contents[0].1,
                &bundle.contents[1].1,
            )
            .unwrap();
        assert_eq!(projection.entry().revision(), revision);
        assert_eq!(
            serde_json::to_value(projection.catalog().authoritative_document()).unwrap(),
            serde_json::to_value(catalog.authoritative_document()).unwrap()
        );
    }
}

pub(crate) fn indexed_catalog(catalog: &crate::Catalog, port_id: &str) -> crate::Catalog {
    let bundle = indexed_catalog_bundle(catalog, port_id);
    let index = crate::DefinitionContentIndex::parse(&bundle.index).unwrap();
    let entry = &bundle.contents[0].1;
    let contract = &bundle.contents[1].1;
    index
        .inspect_catalog_projection("official", port_id, entry, contract)
        .unwrap()
        .catalog()
        .clone()
}

pub(crate) fn admitted_indexed_catalog(catalog: &crate::Catalog, port_id: &str) -> crate::Catalog {
    use std::sync::Arc;

    let mut catalog = indexed_catalog(catalog, port_id);
    let snapshot = catalog.definition_snapshot(port_id).unwrap();
    let selection = crate::DefinitionSelectionIdentity {
        namespace: snapshot.namespace().into(),
        stable_id: snapshot.port_id().into(),
        definition_revision: snapshot.projection().unwrap().entry().revision(),
        repository_root_sha256: "a".repeat(64),
        grant_id: "test-portability-grant".into(),
        policy_revision: 7,
        provenance: crate::AuthenticatedDefinitionProvenance {
            root_version: 1,
            root_sha256: "a".repeat(64),
            timestamp_version: 2,
            timestamp_sha256: "b".repeat(64),
            snapshot_version: 3,
            snapshot_sha256: "c".repeat(64),
            targets_version: 4,
            targets_sha256: "d".repeat(64),
            definitions_version: 5,
            definitions_sha256: "e".repeat(64),
            earliest_expiration: "2099-01-01T00:00:00Z".into(),
            index_sha256: snapshot.index_sha256(),
        },
    };
    catalog
        .retain_definition_selection(Arc::new(selection))
        .unwrap();
    catalog
}

/// Create a valid catalog with one source-backed port that did not exist when
/// the embedded client catalog was built.
pub(crate) fn post_client_catalog() -> (crate::Catalog, String) {
    let mut document = crate::Catalog::embedded().unwrap().authoritative_document();
    let mut port = document
        .ports
        .iter()
        .find(|port| port.bios_source_profile.is_none() && port.source_profile.is_some())
        .unwrap()
        .clone();
    let original_port_id = port.id.clone();
    let original_profile_id = port.source_profile.clone().unwrap();
    let port_id = "post-client-definition-fixture".to_string();
    let profile_id = "post-client-definition-fixture-source".to_string();
    let source = document.source_catalog.as_mut().unwrap();

    let mut identity = source
        .identities
        .iter()
        .find(|identity| identity.id == original_profile_id)
        .unwrap()
        .clone();
    identity.id = profile_id.clone();
    identity.aliases.clear();
    identity.tombstones.clear();
    source.identities.push(identity);

    let mut contract = source
        .contracts
        .iter()
        .find(|contract| {
            contract.port_id == original_port_id && contract.role == crate::PortSourceRole::Game
        })
        .unwrap()
        .clone();
    contract.id = "post-client-definition-fixture-game".to_string();
    contract.port_id = port_id.clone();
    contract.profile_id = profile_id.clone();
    contract.aliases.clear();
    contract.tombstones.clear();
    source.contracts.push(contract);

    port.id = port_id.clone();
    port.name = "Post-client definition fixture".to_string();
    port.summary = "A valid port definition published after this client was built.".to_string();
    port.source_profile = Some(profile_id);
    port.presentation
        .as_mut()
        .unwrap()
        .source_requirements
        .iter_mut()
        .find(|requirement| requirement.role == crate::PortSourceRole::Game)
        .unwrap()
        .profile_id = port.source_profile.clone().unwrap();
    port.automated_tested_platforms.clear();
    port.manually_validated_platforms.clear();
    document.ports.push(port);

    let catalog = crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    (catalog, port_id)
}

/// Register a verified synthetic install against an already authenticated
/// successor catalog. This exercises retained definition admission without
/// requiring proprietary source material or running a title-specific setup tool.
pub(crate) fn register_qualification_install(
    library: &crate::Library,
    catalog: &crate::Catalog,
    port_id: &str,
) -> crate::InstallRecord {
    use sha2::{Digest, Sha256};
    use std::collections::BTreeSet;

    let port = catalog.port(port_id).unwrap();
    if catalog.definition_selection(port_id).is_some() {
        crate::definition_candidate::selection::trust_catalog_selection_for_test(
            library, catalog, port_id,
        );
    }
    let platform = crate::Platform::current().unwrap();
    let version = "qualification-definition-1";
    let artifact_bytes = format!("{port_id}:{version}");
    let artifact = crate::ArtifactIdentity {
        asset_name: format!("{port_id}-{version}.zip"),
        sha256: hex::encode(Sha256::digest(artifact_bytes.as_bytes())),
        size: artifact_bytes.len() as u64,
    };
    let root = library.versions_dir().join(port_id).join(&artifact.sha256);
    fs::create_dir_all(&root).unwrap();

    let mut executables = BTreeSet::new();
    for hints in [
        port.executable_hints.get(&platform),
        port.setup_executable_hints.get(&platform),
    ]
    .into_iter()
    .flatten()
    {
        executables.extend(hints.iter().cloned());
    }
    assert!(!executables.is_empty());
    for relative in executables {
        let executable = root.join(relative);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"qualification definition executable").unwrap();
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
    }

    let id = uuid::Uuid::new_v4().to_string();
    let qualification =
        crate::InstallQualification::from_catalog(catalog, port_id, platform).unwrap();
    let (manifest_sha256, selected_executable, runtime) =
        crate::install::Installer::new(library.clone())
            .unwrap()
            .create_manifest(&id, port_id, version, &artifact, &qualification, &root)
            .unwrap();
    let install = crate::InstallRecord {
        id,
        port_id: port_id.into(),
        version: version.into(),
        path: root,
        channel: crate::ReleaseChannel::Stable,
        installed_at: crate::Library::now(),
        verified: true,
        staged: false,
        artifact,
        manifest_sha256,
        selected_executable,
        runtime,
    };
    library.register_install(&install, true).unwrap();
    install
}

pub(crate) fn build_probe(directory: &Path) -> PathBuf {
    let executable = directory.join(if cfg!(windows) {
        "host_tool_probe.exe"
    } else {
        "host_tool_probe"
    });
    if let Some(prepared) = std::env::var_os("PORTCOVE_HOST_TOOL_FIXTURE") {
        fs::copy(prepared, &executable).unwrap();
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
        return executable;
    }
    let source = directory.join("host_tool_probe.rs");
    fs::write(&source, include_str!("testdata/host_tool_probe.rs.txt")).unwrap();
    let mut rustc =
        ChildProcessPolicy::native_command(ChildProcessClass::ManagedBuilder, "rustc").unwrap();
    assert!(
        rustc
            .arg("--edition=2024")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .status()
            .unwrap()
            .success()
    );
    crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
    executable
}
pub(crate) fn library_file_snapshot(library: &crate::Library) -> Vec<(PathBuf, String)> {
    fn visit(root: &Path, current: &Path, files: &mut Vec<(PathBuf, String)>) {
        for entry in fs::read_dir(current).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            if metadata.is_dir() {
                visit(root, &path, files);
            } else if metadata.is_file()
                && !path.to_string_lossy().ends_with("portcove.sqlite3-shm")
            {
                files.push((
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    crate::service::sha256_file(&path).unwrap(),
                ));
            }
        }
    }

    let mut files = Vec::new();
    visit(library.root(), library.root(), &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}
