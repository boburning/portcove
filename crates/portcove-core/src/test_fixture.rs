use crate::{ChildProcessClass, ChildProcessPolicy};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(test)]
pub(crate) fn gitlab_listing_observation() -> serde_json::Value {
    serde_json::json!({
        "provider":"gitlab", "repository":"example/game", "repository_id":7,
        "status":"complete", "attempted_at":"2026-10-27T00:01:00Z",
        "observed_at":"2026-10-27T00:00:00Z", "fresh_until":"2026-10-27T12:00:00Z",
        "facts_sha256":"a".repeat(64), "release_limit":4,
        "releases":[{
            "id":{"provider":"gitlab","project_id":7,"tag":"v1.2.0"},
            "version":"v1.2.0", "release_url":"https://gitlab.com/example/game/-/releases/v1.2.0",
            "published_at":"2026-10-26T00:00:00Z", "provider_prerelease":false,
            "assets_complete":true, "assets":[]
        }]
    })
}

pub(crate) fn v26_diagnostic_port(id: &str) -> crate::PortDefinition {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/direct-diagnostic-v26.json")).unwrap();
    serde_json::from_value(
        value["ports"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .unwrap()
            .clone(),
    )
    .unwrap()
}

#[cfg(windows)]
pub(crate) fn v26_diagnostic_contract(id: &str) -> crate::PortSourceContract {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/direct-diagnostic-v26.json")).unwrap();
    serde_json::from_value(
        value["source_contracts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["port_id"] == id)
            .unwrap()
            .clone(),
    )
    .unwrap()
}

pub(crate) fn versioned_mod_catalog() -> crate::Catalog {
    crate::Catalog::from_json(
        &serde_json::json!({
            "schema_version": 1, "ports": [{
                "id": "versioned-mod-fixture", "name": "Versioned mod fixture",
                "summary": "Inert ready archive with explicit package preservation",
                "project_url": "https://example.invalid/versioned-mod-fixture",
                "support_tier": "beta", "channels": ["stable"],
                "platforms": ["windows-x86-64"], "adapter": "staged-source-portable",
                "release": {"repository": "fixture/versioned-mod"},
                "executable_hints": {"windows-x86-64": ["game.exe"]},
                "persistent_paths": ["saves", "settings.ini", "mods"],
                "runtime_mutable_paths": ["cache"],
                "mod_package_policy": "versioned-packages-v1"
            }]
        })
        .to_string(),
    )
    .unwrap()
}

/// The capability a port's declared-executable grant requires, by adapter.
pub(crate) fn grant_declared_executable_capability(port: &crate::PortDefinition) -> u32 {
    match port.adapter {
        crate::AdapterKind::LibultrashipPortable => 4,
        crate::AdapterKind::GeneratedCache => 2,
        _ => crate::package_layout::native_executable_grant_capability(port),
    }
}

/// A fixture using archive file links may also declare an external profile guard.
pub(crate) fn archive_file_links_capability(port: &crate::PortDefinition) -> u32 {
    let archive = match port.adapter {
        crate::AdapterKind::N64RecompPortable => 5,
        _ => 14,
    };
    port.external_profile_policy
        .map(crate::native_external_profile::minimum_capability)
        .map_or(archive, |profile| profile.max(archive))
}

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
    // A Windows tracked handoff needs a native-portable reader that tracks
    // successors whatever the adapter, listed beside the adapter's own floor.
    let handoff = crate::launch::TRACKED_HANDOFF_NATIVE_CAPABILITY;
    if port.windows_tracked_handoff && port.adapter == crate::AdapterKind::NativePortable {
        let version = default_version.max(handoff);
        return vec![
            json!({"template":port.adapter,"minimum_version":version,"maximum_version":version}),
        ];
    }
    let default_version = if crate::persistence::requires_psx_retained_scope(port) {
        default_version.max(crate::persistence::PSX_RETAINED_SCOPE_CAPABILITY)
    } else {
        default_version
    };
    // Track counts live in the embedded source profile, not on the port.
    let default_version = if port.adapter == crate::AdapterKind::PsxRecompManaged
        && crate::Catalog::embedded()
            .is_ok_and(|catalog| catalog.requires_psx_multi_track_set(port))
    {
        default_version.max(crate::adapter::PSX_MULTI_TRACK_SET_CAPABILITY)
    } else {
        default_version
    };
    let mut requirements = vec![
        json!({"template":port.adapter,"minimum_version":default_version,"maximum_version":default_version}),
    ];
    if port.windows_tracked_handoff {
        requirements.push(
            json!({"template":"native-portable","minimum_version":handoff,"maximum_version":handoff}),
        );
    }
    requirements
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

pub(crate) async fn async_phase<T>(label: &str, action: impl std::future::Future<Output = T>) -> T {
    let started = std::time::Instant::now();
    eprintln!("test phase started: {label}");
    let result = action.await;
    eprintln!("test phase finished: {label} ({:?})", started.elapsed());
    result
}

/// Immutable proposed metadata from the preserved rollout candidate. These
/// inputs exercise generic provider/presentation behavior without advertising
/// the corresponding routes as shipped catalog support.
pub(crate) fn proposed_rollout_port(id: &str) -> crate::PortDefinition {
    let document: serde_json::Value = serde_json::from_str(include_str!(
        "../tests/fixtures/installation-rollout-proposals-20261025.json"
    ))
    .unwrap();
    let port = document["ports"]
        .as_array()
        .unwrap()
        .iter()
        .find(|port| port["id"] == id)
        .unwrap_or_else(|| panic!("missing frozen proposed rollout definition: {id}"));
    serde_json::from_value(port.clone()).unwrap()
}

/// Freeze the old direct-policy inputs independently of today's release rules.
/// The reviewed fixture is source-bound to the catalog before GitHub adoption;
/// current dynamic/provider tests must keep using the current embedded catalog.
pub(crate) fn historical_managed_policy_catalog() -> crate::Catalog {
    historical_port_catalog(include_str!(
        "../tests/fixtures/managed-direct-policies-historical.json"
    ))
}

/// Keep captured pre-adoption data coordinates independent of today's catalog.
pub(crate) fn historical_runtime_maintenance_catalog() -> crate::Catalog {
    historical_port_catalog(include_str!(
        "../tests/fixtures/direct-runtime-maintenance-historical.json"
    ))
}

fn historical_port_catalog(snapshot: &str) -> crate::Catalog {
    let fixture: serde_json::Value = serde_json::from_str(snapshot).unwrap();
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

pub(crate) fn legacy_opentyrian_indexed_port(
    port: &crate::PortDefinition,
) -> crate::PortDefinition {
    let mut port = port.clone();
    for pattern in &mut port.persistent_file_patterns {
        pattern.allow_empty_middle = false;
    }
    port
}

pub(crate) fn indexed_fixture_document(catalog: &crate::Catalog) -> crate::CatalogDocument {
    let mut document = catalog.authoritative_document();
    if let Some(port) = document
        .ports
        .iter_mut()
        .find(|port| port.id == "opentyrian-opentyrian")
    {
        *port = legacy_opentyrian_indexed_port(port);
    }
    document
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
    port: std::borrow::Cow<'a, crate::PortDefinition>,
    contract: Vec<u8>,
    contract_sha256: String,
}

impl<'a> IndexedCatalogFixture<'a> {
    pub(crate) fn new(catalog: &'a crate::Catalog, port_id: &str) -> Self {
        use sha2::{Digest, Sha256};
        // Keep a noncanonical byte witness for exact retention tests without
        // repeating pretty-print whitespace throughout the complete projection.
        let mut contract = serde_json::to_vec(&serde_json::json!({
            "contract_schema":1,"representation":"catalog_projection",
            "catalog":indexed_fixture_document(catalog)
        }))
        .unwrap();
        contract.push(b'\n');
        let contract_sha256 = hex::encode(Sha256::digest(&contract));
        let port = catalog.port(port_id).unwrap();
        Self {
            port: if port_id == "opentyrian-opentyrian" {
                std::borrow::Cow::Owned(legacy_opentyrian_indexed_port(port))
            } else {
                std::borrow::Cow::Borrowed(port)
            },
            contract,
            contract_sha256,
        }
    }

    pub(crate) fn at_revision(&self, revision: u64) -> IndexedCatalogBundle {
        use serde_json::json;
        use sha2::{Digest, Sha256};
        let contract = &self.contract;
        let leaf = format!("sha256/{}.json", self.contract_sha256);
        let port = self.port.as_ref();
        let port_id = &port.id;
        let capability_version = if port.optional_game_source {
            // An optional game source needs staged-source capability version 31. Keep this
            // branch first: a later capability chain that matched earlier would silently
            // skip the requirement.
            31
        } else if port.runtime_disc_image.is_some() {
            // Disc-image unpacking needs staged-source capability version 30. Keep this branch
            // directly after the optional-source one (version 31) and before every other chain:
            // a later chain that matched first would silently skip the requirement.
            30
        } else if port.linux_portable_data_directory.is_some() {
            crate::native_portable_data::NATIVE_CAPABILITY
        } else if !port.release.tar_xz_platforms.is_empty() {
            if port.adapter == crate::AdapterKind::NativePortable {
                crate::runtime::NATIVE_MAC_BUNDLE_TAR_XZ_CAPABILITY
            } else {
                crate::runtime::GENERATED_CACHE_TAR_XZ_CAPABILITY
            }
        } else if !port.runtime_subdirectory_by_platform.is_empty() {
            crate::runtime::N64_PLATFORM_RUNTIME_SUBDIRECTORY_CAPABILITY
        } else if port.release.grant_declared_executable {
            crate::test_fixture::grant_declared_executable_capability(port)
        } else if port.portable_marker_file.is_some() {
            19
        } else if !port.reviewed_package_layouts.is_empty() {
            crate::package_layout::NATIVE_CAPABILITY.max(
                port.external_profile_policy
                    .map_or(0, crate::native_external_profile::minimum_capability),
            )
        } else if port.release.archive_file_links {
            archive_file_links_capability(port)
        } else if crate::native_temp::has_sibling_platforms(port) {
            10
        } else if let Some(policy) = port.external_profile_policy {
            crate::native_external_profile::minimum_capability(policy)
        } else if port.release.linux_tar_xz {
            8
        } else if crate::preparation::source::native(port) {
            6
        } else if port.windows_shipwright_persistence {
            3
        } else if port.windows_temp_directory.is_some() {
            5
        } else if port.adapter == crate::AdapterKind::NativePortable
            && port.windows_runtime_path_policy.is_some()
        {
            crate::runtime_path_policy::minimum_capability(port)
        } else if port.adapter == crate::AdapterKind::NativePortable
            && port.release.provider == crate::ReleaseSource::DirectManifest
        {
            3
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
        } else if let Some(version) = crate::persistence::fresh_direct_data_guard_capability(port) {
            version
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
        } else if port.n64_runtime_at_executable_parent {
            4
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
        let entry_sha256 = hex::encode(Sha256::digest(&entry));
        let entry_target = format!("sha256/{entry_sha256}.json");
        let contents = [
            json!({"target":entry_target,"sha256":entry_sha256,"length":entry.len()}),
            json!({"target":leaf,"sha256":self.contract_sha256,"length":contract.len()}),
        ];
        let index = serde_json::to_vec_pretty(&json!({
            "index_schema":1,"definitions":[{"namespace":"official","stable_id":port_id,"revision":revision,"target":entry_target}],
            "contents":contents
        }))
        .unwrap();
        IndexedCatalogBundle {
            index,
            contents: vec![(entry_target, entry), (leaf, contract.clone())],
        }
    }
}

#[test]
fn indexed_policy_fixtures_keep_delivered_reader_floors() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, version) in [
        ("re-rac-rerac", crate::package_layout::NATIVE_CAPABILITY),
        ("resident-evil-gaiden-recomp", 21),
        ("wave-race-64-racewave46", 21),
        ("render96ex", 20),
        (
            "star-wars-x-wing-openxw",
            crate::package_layout::NATIVE_CAPABILITY,
        ),
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
            serde_json::to_value(indexed_fixture_document(&catalog)).unwrap()
        );
    }
}

#[test]
fn indexed_fixture_returned_streams_cannot_reuse_mutated_identity() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port_id = &catalog.ports()[0].id;
    let fixture = IndexedCatalogFixture::new(&catalog, port_id);
    let original = fixture.at_revision(8);
    for stream in 0..2 {
        let mut changed = fixture.at_revision(8);
        let index = crate::DefinitionContentIndex::parse(&changed.index).unwrap();
        index
            .inspect_catalog_projection(
                "official",
                port_id,
                &changed.contents[0].1,
                &changed.contents[1].1,
            )
            .unwrap();
        let before: serde_json::Value =
            serde_json::from_slice(&changed.contents[stream].1).unwrap();
        // Same-length JSON whitespace isolates digest checking from length and parsing.
        let newline = changed.contents[stream]
            .1
            .iter()
            .position(|byte| *byte == b'\n')
            .unwrap();
        changed.contents[stream].1[newline] = b' ';
        let after: serde_json::Value = serde_json::from_slice(&changed.contents[stream].1).unwrap();
        assert_eq!(before, after);
        assert_eq!(
            changed.contents[stream].1.len(),
            original.contents[stream].1.len()
        );
        assert!(
            index
                .verify_content(&changed.contents[stream].0, &changed.contents[stream].1)
                .is_err()
        );
        assert!(
            index
                .inspect_catalog_projection(
                    "official",
                    port_id,
                    &changed.contents[0].1,
                    &changed.contents[1].1,
                )
                .is_err()
        );
        let retained = fixture.at_revision(8);
        assert_eq!(retained.index, original.index);
        assert_eq!(retained.contents, original.contents);
    }
    let mut changed = fixture.at_revision(8);
    assert_eq!(changed.index[1], b'\n');
    changed.index[1] = b' ';
    assert_ne!(changed.index, original.index);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&changed.index).unwrap(),
        serde_json::from_slice::<serde_json::Value>(&original.index).unwrap(),
    );
    assert_eq!(fixture.at_revision(8).index, original.index);
}

#[test]
fn indexed_fixture_cache_belongs_to_its_exact_catalog() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port_id = &catalog.ports()[0].id;
    let original = IndexedCatalogFixture::new(&catalog, port_id).at_revision(8);
    let mut document = catalog.authoritative_document();
    document.ports[0]
        .summary
        .push_str(" Fixture identity changed.");
    let changed_catalog =
        crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let changed = IndexedCatalogFixture::new(&changed_catalog, port_id).at_revision(8);
    assert_ne!(changed.contents[1].0, original.contents[1].0);
    assert_ne!(changed.contents[1].1, original.contents[1].1);
    let index = crate::DefinitionContentIndex::parse(&changed.index).unwrap();
    index
        .inspect_catalog_projection(
            "official",
            port_id,
            &changed.contents[0].1,
            &changed.contents[1].1,
        )
        .unwrap();
    assert!(
        index
            .inspect_catalog_projection(
                "official",
                port_id,
                &changed.contents[0].1,
                &original.contents[1].1
            )
            .is_err()
    );
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

/// Make a fixture port also declare the running host, reusing the platform-keyed
/// facts of a platform the port already declares (Linux first, for Unix naming).
///
/// Lifecycle fixtures borrow real catalog ports only as convenient shapes. On a
/// host the real port does not ship for (for example macOS), they would otherwise
/// fail before reaching the behavior under test. Hosts the port already declares
/// are unchanged, so Windows and Linux coverage stays byte-identical. The real
/// embedded catalog is never modified. Per-platform `release` routes and
/// validation records are not projected; use a port without them, or extend
/// this before relying on them.
pub(crate) fn declare_host_platform(port: &mut crate::PortDefinition) {
    use crate::Platform;

    let host = Platform::current().unwrap();
    if port.executable_hints.contains_key(&host) {
        return;
    }
    let donor = [
        Platform::LinuxX86_64,
        Platform::MacosAarch64,
        Platform::MacosX86_64,
        Platform::WindowsX86_64,
    ]
    .into_iter()
    .find(|platform| port.executable_hints.contains_key(platform))
    .unwrap_or_else(|| panic!("{} declares no executable on any platform", port.id));
    let hints = port.executable_hints[&donor].clone();
    port.executable_hints.insert(host, hints);
    if let Some(hints) = port.setup_executable_hints.get(&donor).cloned() {
        port.setup_executable_hints.insert(host, hints);
    }
    if let Some(runtime) = port.bundled_runtime.get(&donor).cloned() {
        port.bundled_runtime.insert(host, runtime);
    }
    if let Some(layout) = port.reviewed_package_layouts.get(&donor).cloned() {
        port.reviewed_package_layouts.insert(host, layout);
    }
    if !port.platforms.contains(&host) {
        port.platforms.push(host);
    }
}

/// `catalog` with [`declare_host_platform`] applied to each of `port_ids`.
pub(crate) fn host_declared_catalog(catalog: &crate::Catalog, port_ids: &[&str]) -> crate::Catalog {
    let host = crate::Platform::current().unwrap();
    let mut document = catalog.authoritative_document();
    let mut changed = false;
    for id in port_ids {
        let port = document
            .ports
            .iter_mut()
            .find(|port| port.id == *id)
            .unwrap_or_else(|| panic!("fixture port {id} is not cataloged"));
        changed |= !port.executable_hints.contains_key(&host);
        declare_host_platform(port);
    }
    if !changed {
        // Keep declared hosts on the exact catalog instance the test supplied.
        return catalog.clone();
    }
    crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

/// The embedded catalog with [`declare_host_platform`] applied to `port_ids`.
pub(crate) fn host_declared_embedded_catalog(port_ids: &[&str]) -> crate::Catalog {
    host_declared_catalog(&crate::Catalog::embedded().unwrap(), port_ids)
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
    declare_host_platform(&mut port);
    // The synthetic port does not inherit the official Shipwright package route.
    port.windows_shipwright_persistence = false;
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

/// Generated enrollment is checked independently by retained observations and
/// expectations in each existing lifecycle harness. No title-specific Rust entry.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RouteEnrollment {
    pub port_id: String,
    pub prepared_player: PreparedRouteFacts,
    pub managed_native: bool,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreparedRouteFacts {
    pub executable: String,
    pub working_directory: String,
    pub arguments: Vec<String>,
    pub data_locations: Vec<String>,
}
pub(crate) fn route_enrollment() -> Vec<RouteEnrollment> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope {
        format_version: u32,
        cases: Vec<RouteEnrollment>,
    }
    let envelope: Envelope =
        serde_json::from_str(include_str!("../catalog/route-enrollment.generated.json")).unwrap();
    assert_eq!(envelope.format_version, 1);
    assert!(!envelope.cases.is_empty());
    let mut ids = std::collections::BTreeSet::new();
    for case in &envelope.cases {
        assert!(
            ids.insert(&case.port_id),
            "duplicate route enrollment: {}",
            case.port_id
        );
        assert_eq!(case.prepared_player.working_directory, "executable-parent");
        assert!(!case.prepared_player.data_locations.is_empty());
    }
    let mut expected_ids = std::collections::BTreeMap::new();
    for row in route_expectations() {
        assert!(
            expected_ids
                .insert(
                    row["port_id"].as_str().unwrap().to_owned(),
                    row["managed_native"].as_bool().unwrap()
                )
                .is_none()
        );
    }
    let actual = envelope
        .cases
        .iter()
        .map(|case| (case.port_id.clone(), case.managed_native))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(
        actual, expected_ids,
        "no missing, duplicate or unexpectedly skipped declared lifecycle coverage"
    );
    envelope.cases
}

/// Retained independent legacy expectations plus accepted package/member observations.
pub(crate) fn route_expectations() -> Vec<serde_json::Value> {
    let mut rows = Vec::new();
    for document in [
        include_str!("testdata/route-enrollment-expectations.json"),
        include_str!("testdata/accepted-route-expectations.generated.json"),
    ] {
        let envelope: serde_json::Value = serde_json::from_str(document).unwrap();
        assert_eq!(envelope["format_version"], 1);
        rows.extend(envelope["cases"].as_array().unwrap().iter().cloned());
    }
    rows
}

#[cfg(test)]
pub(crate) fn assert_fixture_archive_prefix(id: &str, folder: &str) {
    assert!(
        folder.is_empty() || folder.ends_with('/'),
        "{id}: runtime_folder {folder:?} must be empty or an archive directory prefix ending in /"
    );
}

#[cfg(test)]
mod tests {
    use super::assert_fixture_archive_prefix;

    #[test]
    fn native_archive_fixture_inventory() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "testdata/native-engine-adoption-2026-11-02.json"
        ))
        .unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            assert_fixture_archive_prefix(
                case["port_id"].as_str().unwrap(),
                case["runtime_folder"].as_str().unwrap(),
            );
        }
    }

    #[test]
    fn native_archive_prefix_requires_directory_separator() {
        for folder in ["", "runtime/", "runtime/bin/"] {
            assert_fixture_archive_prefix("valid fixture", folder);
        }
        for folder in ["runtime", "runtime\\"] {
            assert!(
                std::panic::catch_unwind(|| {
                    assert_fixture_archive_prefix("invalid fixture", folder);
                })
                .is_err()
            );
        }
    }
}
