//! Inert immutable-package fixtures; no game or original data is executed.
use super::*;

#[test]
fn native_packaged_paths_use_authenticated_members_and_proposed_final_coordinates() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let catalog = crate::Catalog::embedded().unwrap();
    let id = "marathon-infinity-aleph-one";
    let port = catalog.port(id).unwrap();
    let qualification =
        InstallQualification::from_catalog(&catalog, id, Platform::WindowsX86_64).unwrap();
    let root = temporary.path().join("runtime");
    let wrapper = port.runtime_subdirectory.as_ref().unwrap();
    let player = &port.executable_hints[&Platform::WindowsX86_64][0];
    fs::create_dir_all(root.join(wrapper).join("Scripts")).unwrap();
    fs::write(root.join(wrapper).join(player), b"inert fixture executable").unwrap();
    let data = format!("{wrapper}/Scripts/{}.mml", "a".repeat(90));
    fs::write(root.join(&data), b"immutable scenario data").unwrap();
    let artifact = ArtifactIdentity {
        asset_name: "inert.zip".into(),
        sha256: "a".repeat(64),
        size: 1,
    };
    let (manifest_sha256, selected_executable, runtime) = Installer::new(library)
        .unwrap()
        .create_manifest("fixture", id, "fixture", &artifact, &qualification, &root)
        .unwrap();
    let install = InstallRecord {
        id: "fixture".into(),
        port_id: id.into(),
        version: "fixture".into(),
        path: root.clone(),
        channel: crate::ReleaseChannel::Stable,
        installed_at: 0,
        verified: true,
        staged: false,
        artifact,
        runtime,
        manifest_sha256,
        selected_executable,
    };
    // A short staging directory is insufficient: the final data leaf is longer
    // than the player and may be impossible even when the EXE itself fits.
    let target = std::path::PathBuf::from(format!("C:\\{}", "x".repeat(150)));
    crate::runtime_path_policy::check_executable(
        port,
        Platform::WindowsX86_64,
        &target.join(&install.selected_executable),
    )
    .unwrap();
    let before = fs::read(root.join(".portcove-manifest.json")).unwrap();
    let error = check_retained_runtime_paths(&install, &target).unwrap_err();
    assert_eq!(
        error
            .details
            .get("runtime_path_requirement")
            .map(String::as_str),
        Some("relative-file-max-path")
    );
    assert!(!target.exists());
    assert_eq!(
        fs::read(root.join(".portcove-manifest.json")).unwrap(),
        before
    );
    assert_eq!(
        fs::read(root.join(&data)).unwrap(),
        b"immutable scenario data"
    );
    check_retained_runtime_paths(&install, Path::new("C:\\日本語")).unwrap();
    // The current catalog or a caller's loose path list cannot hide a retained
    // member: a tampered manifest is refused before it can supply path facts.
    fs::write(root.join(".portcove-manifest.json"), b"{}").unwrap();
    assert!(check_retained_runtime_paths(&install, Path::new("C:\\short")).is_err());
}

fn inert_payload(library: &Library, root: &Path, identity: &str) -> InstallRecord {
    let catalog = crate::Catalog::embedded().unwrap();
    let id = "marathon-infinity-aleph-one";
    let port = catalog.port(id).unwrap();
    let qualification =
        InstallQualification::from_catalog(&catalog, id, Platform::WindowsX86_64).unwrap();
    let wrapper = port.runtime_subdirectory.as_ref().unwrap();
    fs::create_dir_all(root.join(wrapper).join("Scripts")).unwrap();
    fs::write(
        root.join(wrapper)
            .join(&port.executable_hints[&Platform::WindowsX86_64][0]),
        b"inert player",
    )
    .unwrap();
    fs::write(
        root.join(wrapper)
            .join("Scripts")
            .join(format!("{}.mml", "x".repeat(90))),
        b"immutable data",
    )
    .unwrap();
    let artifact = ArtifactIdentity {
        asset_name: "inert.zip".into(),
        sha256: "a".repeat(64),
        size: 1,
    };
    let (manifest_sha256, selected_executable, runtime) =
        write_manifest(identity, id, "fixture", &artifact, &qualification, root).unwrap();
    let _ = library;
    InstallRecord {
        id: identity.into(),
        port_id: id.into(),
        version: "fixture".into(),
        path: root.into(),
        channel: crate::ReleaseChannel::Stable,
        installed_at: 0,
        verified: true,
        staged: false,
        artifact,
        runtime,
        manifest_sha256,
        selected_executable,
    }
}

fn long_target(library: &Library) -> PathBuf {
    let parent = library.versions_dir().join("marathon-infinity-aleph-one");
    fs::create_dir_all(&parent).unwrap();
    let length = parent.to_string_lossy().encode_utf16().count();
    parent.join("x".repeat(150usize.saturating_sub(length + 1).max(1)))
}

#[test]
fn native_path_refusal_precedes_retained_data_synchronization() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("l")).unwrap();
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    let root = long_target(&library);
    let install = inert_payload(&library, &root, &uuid::Uuid::new_v4().to_string());
    library.register_install(&install, true).unwrap();
    let manifest = fs::read(root.join(".portcove-manifest.json")).unwrap();
    let user = library.user_dir(&install.port_id);
    let user_before = user.exists();
    let error = service.prepare_retained_install_data(&install).unwrap_err();
    assert_eq!(
        error
            .details
            .get("runtime_path_requirement")
            .map(String::as_str),
        Some("relative-file-max-path")
    );
    assert_eq!(user.exists(), user_before);
    assert_eq!(
        fs::read(root.join(".portcove-manifest.json")).unwrap(),
        manifest
    );
    assert!(!root.join(".portcove-launched").exists());
    assert_eq!(library.all_installs().unwrap().len(), 1);
}

#[test]
fn native_recovery_checks_final_coordinates_before_rename_or_registration() {
    use crate::operation::{
        LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore,
    };
    for published in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("l")).unwrap();
        let service = crate::PortcoveService::new(library.clone()).unwrap();
        let identity = uuid::Uuid::new_v4().to_string();
        let staging = library.staging_dir().join(&identity);
        let payload = staging.join("payload");
        let final_path = long_target(&library);
        let mut install = inert_payload(&library, &payload, &identity);
        if published {
            fs::rename(&payload, &final_path).unwrap();
        }
        install.path = final_path.clone();
        let mut operation =
            LifecycleOperation::new(&identity, LifecycleOperationKind::Install, &install.port_id);
        operation.phase = if published {
            LifecyclePhase::PayloadPublished
        } else {
            LifecyclePhase::Prepared
        };
        operation.paths.staging = Some(staging.clone());
        operation.paths.final_path = Some(final_path.clone());
        operation.install = Some(install);
        let store = OperationStore::new(library.clone());
        store.put(&mut operation).unwrap();
        let error = crate::recovery::recover_published_install(&service, &store, &mut operation)
            .unwrap_err();
        assert_eq!(
            error
                .details
                .get("runtime_path_requirement")
                .map(String::as_str),
            Some("relative-file-max-path")
        );
        assert_eq!(payload.exists(), !published);
        assert_eq!(final_path.exists(), published);
        assert!(staging.exists());
        assert!(library.all_installs().unwrap().is_empty());
        assert_eq!(
            store.get(&identity).unwrap().unwrap().phase,
            operation.phase
        );
    }
}

#[cfg(windows)]
#[test]
fn native_library_import_refuses_long_destination_before_copy_or_publication() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("l")).unwrap();
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    let root = library
        .versions_dir()
        .join("marathon-infinity-aleph-one")
        .join("v");
    let install = inert_payload(&library, &root, &uuid::Uuid::new_v4().to_string());
    library.register_install(&install, true).unwrap();
    let metadata = temporary.path().join("metadata.json");
    service.write_library_metadata(&metadata).unwrap();
    let short = temporary.path().join("short");
    crate::PortcoveService::plan_library_import(&metadata, library.root(), &short).unwrap();
    assert!(!short.exists());
    let destination = temporary.path().join("x".repeat(120));
    let before = fs::read(root.join(".portcove-manifest.json")).unwrap();
    let error =
        crate::PortcoveService::plan_library_import(&metadata, library.root(), &destination)
            .unwrap_err();
    assert_eq!(
        error
            .details
            .get("runtime_path_requirement")
            .map(String::as_str),
        Some("relative-file-max-path")
    );
    assert!(!destination.exists());
    assert_eq!(
        fs::read(root.join(".portcove-manifest.json")).unwrap(),
        before
    );
    assert_eq!(library.all_installs().unwrap().len(), 1);
}

// Same official player and ordinary launcher for all nine original-game identities.
// These are inert manifest/persistence fixtures, never upstream execution.
fn reflectionhle_declared_coordinates(id: &str) {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port(id).unwrap();
    assert_eq!(port.adapter, crate::AdapterKind::NativePortable);
    assert_eq!(port.launch_arguments, ["-datadir", ".", "-cfgdir", "."]);
    assert!(port.runtime_subdirectory.is_none());
    assert_eq!(port.persistent_paths.len(), 110);
    assert!(port.source_profile.is_none());
    assert!(port.setup_executable_hints.is_empty());
    assert!(port.automated_tested_platforms.is_empty());
    assert!(port.manually_validated_platforms.is_empty());
    // A changed package wrapper must keep data next to the selected player,
    // without adopting a former AppData profile or another title's install.
    for wrapper in ["reflectionhle-0.66.0", "synthetic-successor-wrapper"] {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let root = temporary.path().join("payload");
        let working = root.join(wrapper);
        fs::create_dir_all(&working).unwrap();
        for file in ["reflectionhle.exe", "SDL3.dll", "libspeexdsp-1.dll"] {
            fs::write(working.join(file), b"inert authenticated fixture member").unwrap();
        }
        let qualification =
            InstallQualification::from_catalog(&catalog, id, Platform::WindowsX86_64).unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "synthetic.zip".into(),
            sha256: "a".repeat(64),
            size: 1,
        };
        let installer = Installer::new(library).unwrap();
        let (manifest_sha256, selected_executable, runtime) = installer
            .create_manifest("fixture", id, "synthetic", &artifact, &qualification, &root)
            .unwrap();
        let install = InstallRecord {
            id: "fixture".into(),
            port_id: id.into(),
            version: "synthetic".into(),
            path: root.clone(),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 0,
            verified: true,
            staged: false,
            artifact,
            runtime,
            manifest_sha256,
            selected_executable,
        };
        assert_eq!(crate::runtime::working_root(port, &install), working);
        for (relative, bytes) in [
            ("reflectionhle.cfg", b"private config".as_slice()),
            ("wl6ap14.txt", b"external original folder reference"),
            ("wl6ap14/SAVEGAM0.WL6", b"synthetic new private progress"),
        ] {
            let path = working.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        assert!(installer.verify(&install).unwrap().valid);
        // Only declared player-relative paths are mutable. Root aliases and
        // an executable companion cannot be smuggled into the managed tree.
        for unexpected in [
            root.join("reflectionhle.cfg"),
            working.join("unreviewed.dll"),
        ] {
            fs::write(&unexpected, b"unreviewed").unwrap();
            assert!(!installer.verify(&install).unwrap().valid);
            fs::remove_file(unexpected).unwrap();
        }
        fs::write(working.join("SDL3.dll"), b"changed packaged code").unwrap();
        assert!(!installer.verify(&install).unwrap().valid);
        assert_eq!(
            fs::read(working.join("wl6ap14/SAVEGAM0.WL6")).unwrap(),
            b"synthetic new private progress"
        );
    }
}

macro_rules! reflectionhle_coordinate_case {
    ($name:ident, $id:literal) => {
        #[test]
        fn $name() {
            reflectionhle_declared_coordinates($id);
        }
    };
}
reflectionhle_coordinate_case!(reflectionhle_coordinates_2683, "keen-dreams-reflectionhle");
reflectionhle_coordinate_case!(
    reflectionhle_coordinates_2684,
    "catacomb-3-d-the-descent-reflectionhle"
);
reflectionhle_coordinate_case!(
    reflectionhle_coordinates_2685,
    "the-catacomb-abyss-reflectionhle"
);
reflectionhle_coordinate_case!(
    reflectionhle_coordinates_2686,
    "the-catacomb-armageddon-reflectionhle"
);
reflectionhle_coordinate_case!(
    reflectionhle_coordinates_2687,
    "the-catacomb-apocalypse-reflectionhle"
);
reflectionhle_coordinate_case!(
    reflectionhle_coordinates_2688,
    "wolfenstein-3d-reflectionhle"
);
reflectionhle_coordinate_case!(
    reflectionhle_coordinates_2689,
    "spear-of-destiny-reflectionhle"
);
reflectionhle_coordinate_case!(
    reflectionhle_coordinates_2690,
    "super-3-d-noah-s-ark-dos-reflectionhle"
);
reflectionhle_coordinate_case!(reflectionhle_coordinates_2692, "bio-menace-reflectionhle");
