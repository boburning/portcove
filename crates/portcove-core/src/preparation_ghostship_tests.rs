use super::*;

#[cfg(windows)]
#[test]
fn generated_archive_uses_native_components_for_atomic_no_replace_publication() {
    let temporary = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temporary.path()).unwrap();
    let private = root.join("legacy-user-data");
    let payload = root.join("payload");
    std::fs::create_dir(&private).unwrap();
    std::fs::create_dir(&payload).unwrap();
    let source = private.join("sm64.o2r");
    let destination = generated_path(&payload);
    std::fs::create_dir(destination.parent().unwrap()).unwrap();
    std::fs::write(&source, b"inert generated archive").unwrap();
    crate::durability::rename_noreplace(&source, &destination).unwrap();
    assert!(!source.exists());
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"inert generated archive"
    );
    std::fs::write(&source, b"must not replace accepted output").unwrap();
    assert!(crate::durability::rename_noreplace(&source, &destination).is_err());
    assert_eq!(
        std::fs::read(&source).unwrap(),
        b"must not replace accepted output"
    );
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"inert generated archive"
    );
}

#[test]
fn binary_importer_is_refused_before_fresh_setup_or_archive_reuse_without_mutation() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    require_no_binary_importer(root).unwrap();
    std::fs::create_dir(root.join("saves")).unwrap();
    std::fs::write(root.join("saves/save_0.json"), b"retained player data").unwrap();
    std::fs::write(root.join("default.sav"), b"unqualified importer").unwrap();
    let before = crate::library_transfer::reviewed_tree(root).unwrap();
    assert!(require_no_binary_importer(root).is_err());
    assert_eq!(
        crate::library_transfer::reviewed_tree(root).unwrap(),
        before
    );
    std::fs::remove_file(root.join("default.sav")).unwrap();
    std::fs::create_dir(root.join("default.sav")).unwrap();
    assert!(require_no_binary_importer(root).is_err());
    assert!(root.join("default.sav").is_dir());
}

#[test]
fn discovery_requires_one_resolvable_original_without_duplicate_bundle_discovery() {
    let temporary = tempfile::tempdir().unwrap();
    let bundle = temporary.path().join("bundle");
    let working = temporary.path().join("working");
    std::fs::create_dir(&bundle).unwrap();
    std::fs::create_dir(&working).unwrap();
    let snapshot = |root: &std::path::Path| crate::library_transfer::reviewed_tree(root).unwrap();
    assert!(require_discovery_layout(&snapshot(&bundle), &snapshot(&working)).is_err());
    std::fs::write(
        working.join(ORIGINAL),
        b"inert identity, not an admitted original",
    )
    .unwrap();
    require_discovery_layout(&snapshot(&bundle), &snapshot(&working)).unwrap();
    std::fs::write(bundle.join(ORIGINAL), b"duplicate discovery").unwrap();
    assert!(require_discovery_layout(&snapshot(&bundle), &snapshot(&working)).is_err());
    std::fs::remove_file(bundle.join(ORIGINAL)).unwrap();
    std::fs::write(working.join("another.z64"), b"ambiguous discovery").unwrap();
    assert!(require_discovery_layout(&snapshot(&bundle), &snapshot(&working)).is_err());
}

#[test]
fn legacy_contract_is_closed_to_one_artifact_and_preserves_the_admitted_definition() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("ghostship").unwrap();
    let original = serde_json::to_value(port).unwrap();
    let install = InstallRecord {
        id: "inert".into(),
        port_id: "ghostship".into(),
        version: "2.0.0".into(),
        path: "E:/fixture/Ghostship".into(),
        channel: crate::ReleaseChannel::Stable,
        installed_at: 0,
        verified: true,
        staged: false,
        artifact: crate::ArtifactIdentity {
            asset_name: "Mary-Celeste-Alfa-Win64.zip".into(),
            sha256: "a49f4c791377fcc611264b8920f2c3254b3ab25747c2a59da9305c32f92a6d3f".into(),
            size: 21_561_620,
        },
        runtime: None,
        manifest_sha256: "0".repeat(64),
        selected_executable: "Ghostship.exe".into(),
    };
    let execution = execution_contract(port, &install, Platform::WindowsX86_64).unwrap();
    assert_eq!(execution.setup_output_paths, [GENERATED]);
    assert!(execution.setup_arguments.is_empty());
    assert_eq!(execution.persistent_paths, port.persistent_paths);
    assert_eq!(serde_json::to_value(port).unwrap(), original);
    for changed in [
        InstallRecord {
            version: "3.0.0".into(),
            ..install.clone()
        },
        InstallRecord {
            selected_executable: "other.exe".into(),
            ..install.clone()
        },
        InstallRecord {
            artifact: crate::ArtifactIdentity {
                sha256: "0".repeat(64),
                ..install.artifact.clone()
            },
            ..install.clone()
        },
    ] {
        assert!(execution_contract(port, &changed, Platform::WindowsX86_64).is_err());
    }
    assert!(execution_contract(port, &install, Platform::LinuxX86_64).is_err());
    let mut changed = port.clone();
    changed.launch_arguments.push("--unreviewed".into());
    assert!(execution_contract(&changed, &install, Platform::WindowsX86_64).is_err());
    let mut changed = port.clone();
    changed.setup_output_paths.push("sm64.o2r".into());
    assert!(execution_contract(&changed, &install, Platform::WindowsX86_64).is_err());
}

#[test]
fn legacy_narrow_path_preconditions_match_the_ansi_extractor() {
    require_path(std::path::Path::new(
        "E:/fixture with spaces/baserom.us.z64",
    ))
    .unwrap();
    assert!(require_path(std::path::Path::new("E:/\u{e9}/baserom.us.z64")).is_err());
    assert!(require_path(std::path::Path::new(&"a".repeat(260))).is_err());
    assert!(require_path(std::path::Path::new("E:/bad\npath")).is_err());
}
