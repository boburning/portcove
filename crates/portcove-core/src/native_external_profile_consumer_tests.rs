//! End-to-end proof that launch consumers follow an external-profile policy's
//! data rather than the identity of the definition that declares it.
//!
//! Each case renames a real cataloged entry to an identity that no production
//! source names, rebuilds the catalog through `Catalog::from_json`, validates
//! it, and plans the launch through the standard adapter.

use std::path::{Path, PathBuf};

use crate::{
    AdapterKind, Catalog, ExternalProfilePolicy, LaunchSpec, Library, Platform,
    adapter::{Adapter, LaunchSpecRequest},
    catalog::EMBEDDED_CATALOG,
};

/// Prefix of every fixture identity below; production sources never name it.
const UNFAMILIAR: &str = "unfamiliar-external-profile-fixture";

/// Renames `original` to `{UNFAMILIAR}-{suffix}` with an unfamiliar repository
/// and returns the validated catalog together with the new identity.
fn renamed_catalog(original: &str, suffix: &str) -> (Catalog, String) {
    let id = format!("{UNFAMILIAR}-{suffix}");
    let mut document: serde_json::Value = serde_json::from_str(EMBEDDED_CATALOG).unwrap();
    let entry = document["ports"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|port| port["id"] == original)
        .unwrap_or_else(|| panic!("{original} is cataloged"));
    entry["id"] = id.clone().into();
    entry["release"]["repository"] = format!("{UNFAMILIAR}-owner/{suffix}").into();
    let catalog = Catalog::from_json(&document.to_string()).unwrap();
    catalog.validate().unwrap();
    assert!(catalog.port(original).is_err());
    (catalog, id)
}

fn plan(
    library: &Library,
    catalog: &Catalog,
    id: &str,
    platform: Platform,
    executable: &str,
) -> LaunchSpec {
    let port = catalog.port(id).unwrap();
    assert_eq!(port.adapter, AdapterKind::NativePortable);
    let install_root = library.versions_dir().join(format!("{id}-{platform:?}"));
    let selected = install_root.join(executable);
    std::fs::create_dir_all(selected.parent().unwrap()).unwrap();
    std::fs::write(&selected, b"inert fixture; never executed").unwrap();
    crate::adapter::standard(port.adapter)
        .launch_spec_with_executable(
            LaunchSpecRequest {
                library,
                port,
                platform,
                install_root: &install_root,
                selected_executable: &selected,
                source: None,
                source_record: None,
                disc_progress: None,
            },
            &|| Ok(()),
        )
        .unwrap()
}

fn library() -> (tempfile::TempDir, Library) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    (temporary, library)
}

#[test]
fn renamed_jgr_definition_keeps_its_policy_launch_argument() {
    unfamiliar_identity_is_absent_from_production_sources();
    let (catalog, id) = renamed_catalog("jgrennison-openttd-patches", "archive-siblings");
    let port = catalog.port(&id).unwrap();
    assert_eq!(
        port.external_profile_policy,
        Some(ExternalProfilePolicy::JgrppLinuxV1)
    );
    crate::native_external_profile::validate(port).unwrap();
    let (_temporary, library) = library();

    let linux = plan(&library, &catalog, &id, Platform::LinuxX86_64, "openttd");
    assert_eq!(linux.arguments, ["-X"]);
    assert!(linux.fixed_arguments_only);
    assert_eq!(linux.environment["PORTCOVE_PORT_ID"], id);

    // The policy covers only the Linux route: the Windows route of the same
    // renamed definition receives no profile argument.
    let windows = plan(
        &library,
        &catalog,
        &id,
        Platform::WindowsX86_64,
        "openttd.exe",
    );
    assert!(windows.arguments.is_empty());
}

#[test]
fn renamed_vcmi_definition_keeps_its_windows_profile_guard() {
    unfamiliar_identity_is_absent_from_production_sources();
    let (catalog, id) = renamed_catalog("vcmi-vcmi", "windows-guard");
    let port = catalog.port(&id).unwrap();
    assert_eq!(
        port.external_profile_policy,
        Some(ExternalProfilePolicy::VcmiWindowsV1)
    );
    crate::native_external_profile::validate(port).unwrap();
    let (_temporary, library) = library();

    let guarded = plan(
        &library,
        &catalog,
        &id,
        Platform::WindowsX86_64,
        "VCMI_client.exe",
    );
    assert!(guarded.arguments.is_empty());
    // The active profile guard forbids forwarding player launch arguments.
    assert!(guarded.fixed_arguments_only);

    // The same data without the policy plans an ordinary forwardable launch,
    // so the restriction above comes from the policy, not the identity.
    let mut unguarded = catalog.port(&id).unwrap().clone();
    unguarded.external_profile_policy = None;
    let install_root: PathBuf = library.versions_dir().join("unguarded");
    let selected = install_root.join("VCMI_client.exe");
    std::fs::create_dir_all(&install_root).unwrap();
    std::fs::write(&selected, b"inert fixture; never executed").unwrap();
    let spec = crate::adapter::standard(unguarded.adapter)
        .launch_spec_with_executable(
            LaunchSpecRequest {
                library: &library,
                port: &unguarded,
                platform: Platform::WindowsX86_64,
                install_root: &install_root,
                selected_executable: &selected,
                source: None,
                source_record: None,
                disc_progress: None,
            },
            &|| Ok(()),
        )
        .unwrap();
    assert!(!spec.fixed_arguments_only);
}

/// CorsixTH's `USER=PLAYER` launch value is a separate title-bound behavior in
/// the adapter, not part of the external-profile policy: the generic layout
/// rule forbids launch environment for every policy, so moving it to data
/// needs a catalog contract change. Until then an equivalent definition under
/// another identity keeps the profile guard but not that value.
#[test]
fn renamed_corsixth_definition_keeps_its_guard_without_the_title_bound_user() {
    unfamiliar_identity_is_absent_from_production_sources();
    let (catalog, id) = renamed_catalog("corsixth-corsixth", "profile-siblings");
    let port = catalog.port(&id).unwrap();
    assert_eq!(
        port.external_profile_policy,
        Some(ExternalProfilePolicy::CorsixthLinuxV1)
    );
    crate::native_external_profile::validate(port).unwrap();
    let (_temporary, library) = library();
    for (platform, executable) in [
        (Platform::WindowsX86_64, "CorsixTH.exe"),
        (Platform::LinuxX86_64, "corsix-th.AppImage"),
    ] {
        let renamed = plan(&library, &catalog, &id, platform, executable);
        assert!(!renamed.environment.contains_key("USER"), "{platform:?}");
        assert_eq!(
            renamed.fixed_arguments_only,
            crate::native_external_profile::applies_to(
                ExternalProfilePolicy::CorsixthLinuxV1,
                platform
            ),
            "{platform:?}"
        );
    }

    // The reviewed CorsixTH identity still receives it.
    let embedded = Catalog::embedded().unwrap();
    let original = plan(
        &library,
        &embedded,
        "corsixth-corsixth",
        Platform::LinuxX86_64,
        "corsix-th.AppImage",
    );
    assert_eq!(original.environment["USER"], "PLAYER");
}

/// Every non-test file under `src` must not name the fixture identities, so
/// the cases above cannot pass through an identity-keyed production branch.
/// Test files, test and fixture directories, and inline
/// `#[cfg(test)] mod tests` blocks are excluded from the scan.
pub(crate) fn assert_absent_from_production_sources(needles: &[&str]) {
    fn visit(directory: &Path, needles: &[&str], found: &mut Vec<String>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if path.is_dir() {
                if !(name.contains("test") || name == "testdata" || name == "fixtures") {
                    visit(&path, needles, found);
                }
                continue;
            }
            if name.contains("test") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let source = String::from_utf8_lossy(&bytes);
            let production = source
                .find("#[cfg(test)]\nmod tests {")
                .map_or(&*source, |end| &source[..end]);
            if needles.iter().any(|needle| production.contains(needle)) {
                found.push(path.display().to_string());
            }
        }
    }
    let mut found = Vec::new();
    visit(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        needles,
        &mut found,
    );
    assert!(
        found.is_empty(),
        "fixture identity in production: {found:?}"
    );
    let catalog = Catalog::embedded().unwrap();
    assert!(catalog.ports().iter().all(|port| {
        needles
            .iter()
            .all(|needle| !port.id.contains(needle) && !port.release.repository.contains(needle))
    }));
}

fn unfamiliar_identity_is_absent_from_production_sources() {
    assert_absent_from_production_sources(&[UNFAMILIAR]);
}
