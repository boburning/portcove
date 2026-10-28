//! Inert storage and lifecycle fixtures. No upstream mod parser or game runs.
use super::*;
use std::cell::Cell;

fn write(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn additive_regular_file_roots_preserve_missing_and_conflicting_canonical_data() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("runtime-settings.toml");
    let destination = temporary.path().join("canonical-settings.toml");
    fs::write(&source, b"player settings").unwrap();
    AdditiveTree::prepare(&source, &destination, false)
        .unwrap()
        .apply(None)
        .unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"player settings");
    fs::remove_file(&source).unwrap();
    AdditiveTree::prepare(&source, &destination, false)
        .unwrap()
        .apply(None)
        .unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"player settings");
    fs::write(&source, b"different unproven settings").unwrap();
    let error = AdditiveTree::prepare(&source, &destination, false)
        .err()
        .unwrap();
    assert!(error.details["source_path"].ends_with("runtime-settings.toml"));
    assert!(error.details["destination_path"].ends_with("canonical-settings.toml"));
    assert_eq!(fs::read(&source).unwrap(), b"different unproven settings");
    assert_eq!(fs::read(&destination).unwrap(), b"player settings");
}

#[test]
fn additive_metadata_contract_preserves_time_and_refuses_equal_bytes_with_different_time() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("original.bin");
    let destination = temporary.path().join("canonical.bin");
    fs::write(&source, b"owned original").unwrap();
    let stamp = std::time::UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 123_456_700);
    fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(stamp))
        .unwrap();
    AdditiveTree::prepare(&source, &destination, true)
        .unwrap()
        .apply(None)
        .unwrap();
    assert_eq!(
        fs::metadata(&destination).unwrap().modified().unwrap(),
        stamp
    );
    fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(stamp + std::time::Duration::from_secs(1)))
        .unwrap();
    assert!(AdditiveTree::prepare(&source, &destination, true).is_err());
    assert_eq!(
        fs::metadata(&destination).unwrap().modified().unwrap(),
        stamp
    );
    // Timestamp differences alone do not redefine a PSX mod package's content.
    AdditiveTree::prepare(&source, &destination, false).unwrap();
}

fn trees() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let destination = temporary.path().join("target");
    let staging = temporary.path().join("private");
    fs::create_dir(&staging).unwrap();
    write(&source, "packages/bundled/1.0/package.toml", b"old default");
    write(
        &source,
        "packages/imported/2.0/package.toml",
        b"player import",
    );
    write(&source, "state.toml", b"[mods.bundled]\nversion = '1.0'\n");
    write(
        &destination,
        "packages/bundled/1.0/package.toml",
        b"old default",
    );
    write(
        &destination,
        "packages/bundled/2.0/package.toml",
        b"new default",
    );
    write(
        &destination,
        "packages/new-default/1.0/package.toml",
        b"successor only",
    );
    write(&destination, "state.toml", b"new release state");
    (temporary, source, destination, staging)
}

#[test]
fn complete_versions_coexist_and_explicit_state_is_not_rebased() {
    let (_temporary, source, destination, staging) = trees();
    let source_before = snapshot(&source, &|| Ok(())).unwrap();
    ModRestore::prepare(&source, &destination)
        .unwrap()
        .apply_checked(Some(&staging), &|| Ok(()))
        .unwrap();
    assert_eq!(snapshot(&source, &|| Ok(())).unwrap(), source_before);
    for (path, expected) in [
        (
            "packages/bundled/1.0/package.toml",
            b"old default".as_slice(),
        ),
        ("packages/bundled/2.0/package.toml", b"new default"),
        ("packages/imported/2.0/package.toml", b"player import"),
        ("packages/new-default/1.0/package.toml", b"successor only"),
    ] {
        assert_eq!(fs::read(destination.join(path)).unwrap(), expected);
    }
    assert_eq!(
        fs::read(destination.join("state.toml")).unwrap(),
        fs::read(source.join("state.toml")).unwrap()
    );
    // A retry needs no new copy. Removed ordinary state stays removed; complete
    // destination-only versions remain for upstream's own selection rules.
    fs::remove_file(source.join("state.toml")).unwrap();
    let retry = ModRestore::prepare(&source, &destination).unwrap();
    assert!(retry.additions.is_empty());
    retry.apply_checked(None, &|| Ok(())).unwrap();
    assert!(!destination.join("state.toml").exists());
    assert!(
        destination
            .join("packages/bundled/2.0/package.toml")
            .is_file()
    );
}

#[test]
fn common_package_requires_the_complete_identical_tree_before_any_restore() {
    for change in ["changed", "source-only", "destination-only"] {
        let (_temporary, source, destination, _) = trees();
        match change {
            "changed" => write(
                &destination,
                "packages/bundled/1.0/package.toml",
                b"different same version",
            ),
            "source-only" => write(&source, "packages/bundled/1.0/new.txt", b"extra"),
            _ => write(&destination, "packages/bundled/1.0/new.txt", b"extra"),
        }
        let before = snapshot(&destination, &|| Ok(())).unwrap();
        let failure = ModRestore::prepare(&source, &destination).err().unwrap();
        assert!(failure.message.contains("same package ID/version"));
        assert!(failure.details["source_path"].contains("bundled"));
        assert!(failure.details["destination_path"].contains("bundled"));
        assert_eq!(snapshot(&destination, &|| Ok(())).unwrap(), before);
        assert!(!destination.join("packages/imported").exists());
    }
}

#[test]
fn late_collection_package_edits_refuse_without_mutating_either_tree() {
    for destination_edit in [false, true] {
        let (_temporary, source, destination, _) = trees();
        let plan = ModRestore::prepare(&source, &destination).unwrap();
        write(
            if destination_edit {
                &destination
            } else {
                &source
            },
            "packages/bundled/1.0/package.toml",
            b"edit after the initial collection preflight",
        );
        let source_before = snapshot(&source, &|| Ok(())).unwrap();
        let destination_before = snapshot(&destination, &|| Ok(())).unwrap();
        let failure = plan.require_unchanged(&|| Ok(())).unwrap_err();
        assert!(failure.message.contains("changed after preflight"));
        assert_eq!(snapshot(&source, &|| Ok(())).unwrap(), source_before);
        assert_eq!(
            snapshot(&destination, &|| Ok(())).unwrap(),
            destination_before
        );
    }
}

#[test]
fn type_case_and_nonpackage_roots_are_refused_without_changing_state() {
    for change in ["type", "case", "root", "package-leaf"] {
        let (_temporary, source, destination, _) = trees();
        match change {
            "type" => {
                fs::remove_file(destination.join("state.toml")).unwrap();
                fs::create_dir(destination.join("state.toml")).unwrap();
            }
            "case" => fs::rename(
                destination.join("state.toml"),
                destination.join("STATE.toml"),
            )
            .unwrap(),
            "root" => {
                fs::remove_dir_all(&source).unwrap();
                fs::write(&source, b"not a directory").unwrap();
            }
            _ => write(
                &source,
                "packages/loose-package.zip",
                b"not the reviewed ID/version layout",
            ),
        }
        let before = snapshot(&destination, &|| Ok(())).unwrap();
        assert!(
            ModRestore::prepare(&source, &destination).is_err(),
            "{change}"
        );
        assert_eq!(snapshot(&destination, &|| Ok(())).unwrap(), before);
    }
}

#[test]
fn changed_source_or_destination_and_cancellation_leave_publication_absent() {
    for change in ["source", "destination", "cancel"] {
        let (_temporary, source, destination, staging) = trees();
        let plan = ModRestore::prepare(&source, &destination).unwrap();
        match change {
            "source" => write(
                &source,
                "packages/imported/2.0/package.toml",
                b"changed while copying",
            ),
            "destination" => write(
                &destination,
                "packages/bundled/3.0/package.toml",
                b"appeared after review",
            ),
            _ => {}
        }
        let before = snapshot(&destination, &|| Ok(())).unwrap();
        let calls = Cell::new(0);
        let result = plan.apply_checked(Some(&staging), &|| {
            calls.set(calls.get() + 1);
            if change == "cancel" && calls.get() == 3 {
                Err(PortcoveError::state("fixture cancellation"))
            } else {
                Ok(())
            }
        });
        assert!(result.is_err(), "{change}");
        assert_eq!(snapshot(&destination, &|| Ok(())).unwrap(), before);
        assert!(!destination.join("packages/imported").exists());
        assert_eq!(
            fs::read(source.join("state.toml")).unwrap(),
            b"[mods.bundled]\nversion = '1.0'\n"
        );
    }
}

#[test]
fn hard_linked_package_files_are_refused_before_read_or_copy() {
    let (_temporary, source, destination, _) = trees();
    fs::hard_link(
        source.join("packages/imported/2.0/package.toml"),
        source.join("alias"),
    )
    .unwrap();
    assert!(ModRestore::prepare(&source, &destination).is_err());
    assert!(!destination.join("packages/imported").exists());
}

#[test]
fn interruption_after_complete_publication_retries_without_mixing_versions_or_state() {
    let (temporary, source, destination, staging) = trees();
    write(
        &source,
        "packages/z-last/1.0/file",
        b"second complete package",
    );
    let original = snapshot(&source, &|| Ok(())).unwrap();
    let plan = ModRestore::prepare(&source, &destination).unwrap();
    let error = plan
        .apply_checked(Some(&staging), &|| {
            if destination
                .join("packages/imported/2.0/package.toml")
                .exists()
                && !destination.join("packages/z-last/1.0/file").exists()
            {
                Err(PortcoveError::state(
                    "interrupted after one complete publication",
                ))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(error.message.contains("interrupted"));
    assert_eq!(
        fs::read(destination.join("packages/imported/2.0/package.toml")).unwrap(),
        b"player import"
    );
    assert!(!destination.join("packages/z-last").exists());
    assert_eq!(
        fs::read(destination.join("state.toml")).unwrap(),
        b"new release state"
    );
    assert_eq!(snapshot(&source, &|| Ok(())).unwrap(), original);
    let retry = temporary.path().join("retry");
    fs::create_dir(&retry).unwrap();
    ModRestore::prepare(&source, &destination)
        .unwrap()
        .apply_checked(Some(&retry), &|| Ok(()))
        .unwrap();
    assert_eq!(
        fs::read(destination.join("packages/z-last/1.0/file")).unwrap(),
        b"second complete package"
    );
    assert!(
        destination
            .join("packages/bundled/2.0/package.toml")
            .is_file()
    );
    assert_eq!(
        fs::read(destination.join("state.toml")).unwrap(),
        fs::read(source.join("state.toml")).unwrap()
    );
}

#[test]
fn metadata_namespace_is_exact_and_bounded() {
    assert!(metadata_name(PSX_DATA_RECEIPT));
    assert!(metadata_name(&format!("{PSX_DATA_WRITE_PREFIX}Abc12345")));
    for name in [
        format!("sub/{PSX_DATA_RECEIPT}"),
        format!("{PSX_DATA_WRITE_PREFIX}Abc123456"),
        format!("{PSX_DATA_WRITE_PREFIX}abc/1234"),
        format!("{PSX_DATA_RECEIPT}.other"),
    ] {
        assert!(!metadata_name(&name));
    }
}

#[cfg(unix)]
#[test]
fn linked_package_directory_is_not_followed() {
    let (_temporary, source, destination, _) = trees();
    std::os::unix::fs::symlink(
        source.join("packages/imported"),
        source.join("packages/alias"),
    )
    .unwrap();
    assert!(ModRestore::prepare(&source, &destination).is_err());
    assert!(!destination.join("packages/alias").exists());
}

#[cfg(windows)]
mod lifecycle {
    use super::*;
    const ID: &str = "psx-mod-data-fixture";

    fn fixture() -> (tempfile::TempDir, PortcoveService, Catalog) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let catalog = Catalog::from_json(&serde_json::json!({
            "schema_version":1,"ports":[{
                "id":ID,"name":"PSX mod fixture","summary":"Inert storage fixture",
                "project_url":"https://example.invalid/psx-fixture","support_tier":"beta",
                "channels":["stable"],"platforms":["windows-x86-64"],
                "adapter":"psx-recomp-managed","release":{"repository":"fixture/psx"},
                "executable_hints":{"windows-x86-64":["fixture.exe"]},
                "runtime_subdirectory":"build-portcove","persistent_paths":["saves","mods","settings.toml"]
            }]
        }).to_string()).unwrap();
        let mut service = PortcoveService::new(library).unwrap();
        service.replace_catalog_for_test(catalog.clone());
        (temporary, service, catalog)
    }

    fn register(
        service: &PortcoveService,
        catalog: &Catalog,
        version: &str,
        active: bool,
        custom: Option<&Path>,
    ) -> InstallRecord {
        let library = &service.library;
        let id = Uuid::new_v4().to_string();
        let parent = custom
            .map(Path::to_path_buf)
            .unwrap_or_else(|| library.versions_dir().join(ID));
        if custom.is_some() {
            crate::output_root::prepare_for_install(
                library,
                ID,
                &parent,
                &Uuid::new_v4().to_string(),
                0,
            )
            .unwrap();
        }
        let root = parent.join(version);
        write(
            &root,
            "build-portcove/fixture.exe",
            b"inert storage fixture, never executed",
        );
        // Production Installer records the canonical published path. A raw
        // Windows path is a different key from its output-root claim spelling.
        let root = fs::canonicalize(root).unwrap();
        let artifact = crate::ArtifactIdentity {
            asset_name: format!("{version}.zip"),
            sha256: hex::encode(Sha256::digest(version.as_bytes())),
            size: version.len() as u64,
        };
        let qualification =
            InstallQualification::from_catalog(catalog, ID, Platform::WindowsX86_64).unwrap();
        let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
            .unwrap()
            .create_manifest(&id, ID, version, &artifact, &qualification, &root)
            .unwrap();
        let install = InstallRecord {
            id,
            port_id: ID.into(),
            version: version.into(),
            path: root,
            channel: ReleaseChannel::Stable,
            installed_at: Library::now(),
            verified: true,
            staged: !active,
            artifact,
            manifest_sha256,
            selected_executable,
            runtime,
        };
        library.register_install(&install, active).unwrap();
        install
    }

    #[test]
    fn played_collection_preserves_removal_intent_and_preflights_before_other_data() {
        let (temporary, service, catalog) = fixture();
        let install = register(&service, &catalog, "v1", true, None);
        let runtime = install.path.join("build-portcove");
        let canonical = service.library.user_dir(ID);
        for version in ["1.0", "2.0"] {
            write(
                &canonical,
                &format!("mods/packages/player/{version}/manifest.toml"),
                version.as_bytes(),
            );
        }
        write(&canonical, "mods/state.toml", b"initial choice");
        service
            .restore_user_data_to(catalog.port(ID).unwrap(), &install.path)
            .unwrap();
        // Upstream remove_version deletes an inactive version directory.
        fs::remove_dir_all(runtime.join("mods/packages/player/2.0")).unwrap();
        write(&runtime, "mods/state.toml", b"deliberate current choice");
        write(
            &runtime,
            "mods/installed/readme.txt",
            b"ordinary historical folder",
        );
        write(&runtime, "saves/current.sav", b"current save");
        fs::write(
            install.path.join(LAUNCH_MARKER),
            b"fixture marker, no game run",
        )
        .unwrap();
        let before = snapshot(&runtime, &|| Ok(())).unwrap();
        service
            .collect_user_data_from_install(ID, &install.path)
            .unwrap();
        assert_eq!(snapshot(&runtime, &|| Ok(())).unwrap(), before);
        assert!(!canonical.join("mods/packages/player/2.0").exists());
        assert_eq!(
            fs::read(canonical.join("mods/state.toml")).unwrap(),
            b"deliberate current choice"
        );
        assert_eq!(
            fs::read(canonical.join("mods/installed/readme.txt")).unwrap(),
            b"ordinary historical folder"
        );
        fs::remove_file(runtime.join("mods/state.toml")).unwrap();
        fs::remove_dir_all(runtime.join("mods/packages/player/1.0")).unwrap();
        service
            .collect_user_data_from_install(ID, &install.path)
            .unwrap();
        assert!(!canonical.join("mods/state.toml").exists());
        assert!(!canonical.join("mods/packages/player/1.0").exists());
        let new = register(&service, &catalog, "v2", false, None);
        write(
            &new.path,
            "build-portcove/mods/packages/new-default/1.0/manifest.toml",
            b"new default",
        );
        service.activate_staged(ID).unwrap();
        assert!(
            !new.path
                .join("build-portcove/mods/packages/player/1.0")
                .exists()
        );
        service.rollback(ID).unwrap();
        assert!(!runtime.join("mods/packages/player/1.0").exists());
        assert!(!runtime.join("mods/packages/player/2.0").exists());
        write(
            &runtime,
            "mods/packages/player/1.0/manifest.toml",
            b"current package",
        );
        service
            .collect_user_data_from_install(ID, &install.path)
            .unwrap();
        write(
            &runtime,
            "mods/packages/player/1.0/manifest.toml",
            b"different same version",
        );
        write(
            &runtime,
            "saves/current.sav",
            b"save must not publish before conflict",
        );
        let before = snapshot(&canonical, &|| Ok(())).unwrap();
        let failure = service
            .collect_user_data_from_install(ID, &install.path)
            .unwrap_err();
        assert!(failure.message.contains("same package ID/version"));
        assert!(failure.details["source_path"].contains("manifest.toml"));
        assert!(failure.details["destination_path"].contains("manifest.toml"));
        assert_eq!(snapshot(&canonical, &|| Ok(())).unwrap(), before);
        let activity = service
            .library
            .begin_activity(
                ActivityOperation::Launch,
                ActivityTargetKind::Port,
                Some(ID),
            )
            .unwrap();
        let now = Library::now();
        service
            .library
            .create_launch_session(&LaunchSessionRecord {
                id: activity.id.clone(),
                port_id: ID.into(),
                install_id: install.id.clone(),
                install_root: install.path.clone(),
                owner_kind: crate::LaunchOwnerKind::Managed,
                supervisor_pid: u32::MAX,
                supervisor_identity: None,
                child_pid: None,
                child_identity: None,
                phase: LaunchSessionPhase::Collecting,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: now,
                updated_at: now,
                finished_at: None,
            })
            .unwrap();
        assert!(
            service
                .recover_launch_session(&activity.id)
                .unwrap_err()
                .message
                .contains("same package ID/version")
        );
        assert_eq!(snapshot(&canonical, &|| Ok(())).unwrap(), before);
        assert_eq!(
            service
                .library
                .active_launch_session(&activity.id)
                .unwrap()
                .unwrap()
                .phase,
            LaunchSessionPhase::Collecting
        );
        assert!(service.library.try_lock_port(ID, "update").is_err());
        let preserved = temporary.path().join("preserved-canonical-package");
        fs::rename(canonical.join("mods/packages/player/1.0"), &preserved).unwrap();
        service.recover_launch_session(&activity.id).unwrap();
        assert!(
            service
                .library
                .active_launch_session(&activity.id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fs::read(preserved.join("manifest.toml")).unwrap(),
            b"current package"
        );
        assert_eq!(
            fs::read(canonical.join("mods/packages/player/1.0/manifest.toml")).unwrap(),
            b"different same version"
        );
        assert_eq!(
            fs::read(canonical.join("saves/current.sav")).unwrap(),
            b"save must not publish before conflict"
        );
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, install.id);
        // Recovery releases launch preparation; this fixture still lacks PS1 input.
        let missing = service
            .prepare_launch_for_install(catalog.port(ID).unwrap(), &install, None, None)
            .unwrap_err();
        assert!(missing.message.contains("verified source"), "{missing}");
    }

    #[test]
    fn staged_activation_and_rollback_carry_prelaunch_data_and_coexisting_packages() {
        let (_temporary, service, catalog) = fixture();
        let old = register(&service, &catalog, "v1", true, None);
        write(
            &old.path,
            "build-portcove/saves/prelaunch.sav",
            b"data before first launch",
        );
        write(
            &old.path,
            "build-portcove/mods/packages/bundled/1.0/package.toml",
            b"old package",
        );
        write(
            &old.path,
            "build-portcove/mods/state.toml",
            b"version = '1.0'",
        );
        let new = register(&service, &catalog, "v2", false, None);
        write(
            &new.path,
            "build-portcove/mods/packages/bundled/2.0/package.toml",
            b"new package",
        );
        let activated = service.activate_staged(ID).unwrap();
        assert_eq!(activated.id, new.id);
        assert_eq!(
            fs::read(new.path.join("build-portcove/saves/prelaunch.sav")).unwrap(),
            b"data before first launch"
        );
        for version in ["1.0", "2.0"] {
            assert!(
                new.path
                    .join(format!(
                        "build-portcove/mods/packages/bundled/{version}/package.toml"
                    ))
                    .is_file()
            );
        }
        write(&new.path, LAUNCH_MARKER, b"1");
        write(
            &new.path,
            "build-portcove/saves/prelaunch.sav",
            b"current progress",
        );
        service.rollback(ID).unwrap();
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, old.id);
        assert_eq!(
            fs::read(old.path.join("build-portcove/saves/prelaunch.sav")).unwrap(),
            b"current progress"
        );
        assert!(
            old.path
                .join("build-portcove/mods/packages/bundled/2.0/package.toml")
                .is_file()
        );
        assert_eq!(
            fs::read(old.path.join("build-portcove/mods/state.toml")).unwrap(),
            b"version = '1.0'"
        );
    }

    #[test]
    fn activation_conflict_preflights_before_other_saves_or_metadata_change() {
        let (_temporary, service, catalog) = fixture();
        let old = register(&service, &catalog, "v1", true, None);
        write(
            &old.path,
            "build-portcove/mods/packages/bundled/1.0/file",
            b"old",
        );
        write(&old.path, "build-portcove/saves/current.sav", b"current");
        let new = register(&service, &catalog, "v2", false, None);
        write(
            &new.path,
            "build-portcove/mods/packages/bundled/1.0/file",
            b"conflict",
        );
        write(
            &new.path,
            "build-portcove/saves/current.sav",
            b"successor original",
        );
        assert!(
            service
                .activate_staged(ID)
                .unwrap_err()
                .message
                .contains("Mod packages need review")
        );
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, old.id);
        assert_eq!(
            fs::read(new.path.join("build-portcove/saves/current.sav")).unwrap(),
            b"successor original"
        );
        assert_eq!(
            fs::read(service.library.user_dir(ID).join("saves/current.sav")).unwrap(),
            b"current"
        );
    }

    #[test]
    fn custom_output_uses_owned_staging_and_replay_preserves_its_claim() {
        let (temporary, service, catalog) = fixture();
        let install = register(
            &service,
            &catalog,
            "v1",
            true,
            Some(&temporary.path().join("custom")),
        );
        let source = service.library.user_dir(ID).join("mods");
        let target = install.path.join("build-portcove/mods");
        write(&source, "packages/imported/1.0/file", b"preserved package");
        ModRestore::prepare(&source, &target)
            .unwrap()
            .apply(&service.library, ID, &install.path)
            .unwrap();
        crate::output_root::validate_install_path(&service.library, ID, &install.path).unwrap();
        assert!(
            fs::read_dir(temporary.path().join("custom/.staging"))
                .unwrap()
                .next()
                .is_none()
        );
        ModRestore::prepare(&source, &target)
            .unwrap()
            .apply(&service.library, ID, &install.path)
            .unwrap();
    }

    #[tokio::test]
    async fn raw_installer_refuses_activation_before_network_or_staging() {
        let (_temporary, service, catalog) = fixture();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let request = InstallRequest {
            port_id: ID.into(),
            release: ResolvedRelease {
                version: "v1".into(),
                channel: ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "fixture.zip".into(),
                    url: format!("http://{}/fixture.zip", listener.local_addr().unwrap()),
                    size: 42,
                    sha256: "ab".repeat(32),
                },
            },
            output_root: service.library.versions_dir().join(ID),
            activate: true,
            managed: None,
            qualification: InstallQualification::from_catalog(
                &catalog,
                ID,
                Platform::WindowsX86_64,
            )
            .unwrap(),
        };
        let error = Installer::new(service.library.clone())
            .unwrap()
            .install(request, &OperationCoordinator::new("psx-raw", None), |_| {})
            .await
            .unwrap_err();
        assert!(error.message.contains("preflight before activation"));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert!(
            OperationStore::new(service.library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn uninitialized_historical_runtime_preserves_canonical_only_data_and_holds_differences() {
        let (_temporary, service, catalog) = fixture();
        let install = register(&service, &catalog, "v1", true, None);
        let user = service.library.user_dir(ID);
        write(&user, "saves/canonical.sav", b"existing canonical progress");
        write(&user, "settings.toml", b"prior settings");
        write(
            &install.path,
            "build-portcove/saves/prelaunch.sav",
            b"new prelaunch progress",
        );
        service.collect_active_user_data_if_launched(ID).unwrap();
        assert_eq!(
            fs::read(user.join("saves/canonical.sav")).unwrap(),
            b"existing canonical progress"
        );
        assert_eq!(
            fs::read(user.join("settings.toml")).unwrap(),
            b"prior settings"
        );
        assert_eq!(
            fs::read(user.join("saves/prelaunch.sav")).unwrap(),
            b"new prelaunch progress"
        );
        write(
            &install.path,
            "build-portcove/settings.toml",
            b"unproven stock settings",
        );
        write(
            &install.path,
            "build-portcove/saves/not-yet-collected.sav",
            b"keep this in runtime",
        );
        let before = snapshot(&user, &|| Ok(())).unwrap();
        let error = service
            .collect_active_user_data_if_launched(ID)
            .unwrap_err();
        assert!(error.message.contains("unlaunched runtime data differs"));
        assert!(error.details["destination_path"].ends_with("settings.toml"));
        assert_eq!(snapshot(&user, &|| Ok(())).unwrap(), before);
        assert!(!user.join("saves/not-yet-collected.sav").exists());
        assert!(!initialized(&install).unwrap());
    }

    #[test]
    fn first_play_preparation_keeps_deliberate_edits_after_completed_core_restore() {
        let (_temporary, service, catalog) = fixture();
        let install = register(&service, &catalog, "v1", true, None);
        let user = service.library.user_dir(ID);
        write(&user, "settings.toml", b"initial settings");
        write(&user, "mods/state.toml", b"version = '1.0'");
        service
            .restore_user_data_to(catalog.port(ID).unwrap(), &install.path)
            .unwrap();
        assert!(initialized(&install).unwrap());
        write(
            &install.path,
            "build-portcove/settings.toml",
            b"deliberate prelaunch settings",
        );
        write(
            &install.path,
            "build-portcove/mods/state.toml",
            b"version = '2.0'",
        );
        write(
            &install.path,
            "build-portcove/saves/prelaunch.sav",
            b"deliberate prelaunch progress",
        );
        // Run the actual launch preparation boundary. This inert source-less
        // fixture then refuses its absent PS1 input; no child can be started.
        let error = service
            .prepare_launch_for_install(catalog.port(ID).unwrap(), &install, None, None)
            .unwrap_err();
        assert!(error.message.contains("verified source"), "{error}");
        for (path, expected) in [
            ("settings.toml", b"deliberate prelaunch settings".as_slice()),
            ("mods/state.toml", b"version = '2.0'"),
            ("saves/prelaunch.sav", b"deliberate prelaunch progress"),
        ] {
            assert_eq!(fs::read(user.join(path)).unwrap(), expected);
            assert_eq!(
                fs::read(install.path.join("build-portcove").join(path)).unwrap(),
                expected
            );
        }
        assert!(!install.path.join(LAUNCH_MARKER).exists());
        let qualification =
            InstallQualification::from_catalog(&catalog, ID, Platform::WindowsX86_64).unwrap();
        assert!(
            Installer::new(service.library.clone())
                .unwrap()
                .verify_managed(&install, &qualification)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn failed_or_future_restore_does_not_create_or_replace_completion_proof() {
        let (_temporary, service, catalog) = fixture();
        let install = register(&service, &catalog, "v1", true, None);
        let user = service.library.user_dir(ID);
        write(&user, "mods/packages/default/1.0/file", b"canonical");
        write(
            &install.path,
            "build-portcove/mods/packages/default/1.0/file",
            b"different",
        );
        assert!(
            service
                .restore_user_data_to(catalog.port(ID).unwrap(), &install.path)
                .is_err()
        );
        assert!(!install.path.join(PSX_DATA_RECEIPT).exists());
        let future = serde_json::to_vec(&DataRestored {
            schema_version: 2,
            port_id: ID.into(),
            install_id: install.id.clone(),
            manifest_sha256: install.manifest_sha256.clone(),
        })
        .unwrap();
        fs::write(install.path.join(PSX_DATA_RECEIPT), &future).unwrap();
        assert!(
            service
                .collect_active_user_data_if_launched(ID)
                .unwrap_err()
                .message
                .contains("compatible Portcove")
        );
        assert!(
            service
                .restore_user_data_to(catalog.port(ID).unwrap(), &install.path)
                .is_err()
        );
        assert_eq!(
            fs::read(install.path.join(PSX_DATA_RECEIPT)).unwrap(),
            future
        );
        let stale = serde_json::to_vec(&DataRestored {
            schema_version: 1,
            port_id: ID.into(),
            install_id: install.id.clone(),
            manifest_sha256: "00".repeat(32),
        })
        .unwrap();
        fs::write(install.path.join(PSX_DATA_RECEIPT), &stale).unwrap();
        assert!(!initialized(&install).unwrap());
        assert!(service.collect_active_user_data_if_launched(ID).is_err());
        fs::write(install.path.join(PSX_DATA_RECEIPT), b"malformed").unwrap();
        assert!(service.collect_active_user_data_if_launched(ID).is_err());
        assert_eq!(
            fs::read(user.join("mods/packages/default/1.0/file")).unwrap(),
            b"canonical"
        );
    }

    #[test]
    fn explicit_backup_restore_preserves_successor_packages_and_preflights_conflicts() {
        let started = std::time::Instant::now();
        for conflict in [false, true] {
            let (_temporary, service, catalog) = fixture();
            let install = register(&service, &catalog, "v1", true, None);
            eprintln!(
                "PSX restore conflict={conflict} registered: {:?}",
                started.elapsed()
            );
            let user = service.library.user_dir(ID);
            write(&user, "mods/packages/default/1.0/file", b"old package");
            write(&user, "saves/progress.sav", b"old save");
            service
                .restore_user_data_to(catalog.port(ID).unwrap(), &install.path)
                .unwrap();
            let backup = service.create_backup(ID).unwrap();
            eprintln!(
                "PSX restore conflict={conflict} snapshot created: {:?}",
                started.elapsed()
            );
            write(&install.path, LAUNCH_MARKER, b"1");
            write(
                &install.path,
                "build-portcove/mods/packages/default/2.0/file",
                b"successor package",
            );
            write(
                &install.path,
                "build-portcove/saves/progress.sav",
                b"current save",
            );
            if conflict {
                write(
                    &install.path,
                    "build-portcove/mods/packages/default/1.0/file",
                    b"changed same version",
                );
                // Model already reconciled current data so this fixture reaches
                // backup restoration's conflict with the old package snapshot.
                // Collection's refusal of divergent copies is tested separately.
                write(
                    &user,
                    "mods/packages/default/1.0/file",
                    b"changed same version",
                );
            }
            // Bind this package-coexistence test to current canonical data.
            // Runtime collection versus restore review is a separate contract.
            service.collect_user_data(ID).unwrap();
            let preview = service
                .preview_backup_action(ID, &backup.id, crate::BackupAction::Restore)
                .unwrap();
            let authorization = service
                .authorize_backup_action(
                    ID,
                    &backup.id,
                    crate::BackupAction::Restore,
                    &preview.preview_sha256,
                )
                .unwrap();
            eprintln!(
                "PSX restore conflict={conflict} review authorized: {:?}",
                started.elapsed()
            );
            let before = snapshot(&user, &|| Ok(())).unwrap();
            let result = service.restore_backup(ID, &backup.id, &authorization.token);
            eprintln!(
                "PSX restore conflict={conflict} restore returned: {:?}",
                started.elapsed()
            );
            if conflict {
                assert!(
                    result
                        .unwrap_err()
                        .message
                        .contains("same package ID/version")
                );
                assert_eq!(snapshot(&user, &|| Ok(())).unwrap(), before);
                assert_eq!(
                    fs::read(install.path.join("build-portcove/saves/progress.sav")).unwrap(),
                    b"current save"
                );
            } else {
                result.unwrap();
                assert_eq!(
                    fs::read(install.path.join("build-portcove/saves/progress.sav")).unwrap(),
                    b"old save"
                );
            }
            assert!(
                install
                    .path
                    .join("build-portcove/mods/packages/default/2.0/file")
                    .is_file()
            );
            assert_eq!(service.status(ID).unwrap().active.unwrap().id, install.id);
            eprintln!(
                "PSX restore conflict={conflict} assertions complete: {:?}",
                started.elapsed()
            );
        }
    }

    #[test]
    fn prepared_backup_recovery_preflights_before_canonical_publication() {
        for conflict in [false, true] {
            let (_temporary, service, catalog) = fixture();
            let install = register(&service, &catalog, "v1", true, None);
            let user = service.library.user_dir(ID);
            write(&user, "saves/progress.sav", b"current canonical");
            service
                .restore_user_data_to(catalog.port(ID).unwrap(), &install.path)
                .unwrap();
            write(
                &install.path,
                "build-portcove/mods/packages/default/1.0/file",
                if conflict {
                    b"conflicting package"
                } else {
                    b"old package"
                },
            );
            write(
                &install.path,
                "build-portcove/mods/packages/default/2.0/file",
                b"successor package",
            );
            let id = Uuid::new_v4().to_string();
            let root = service.library.recovery_dir().join(&id);
            let staged = root.join("staged-data");
            write(&staged, "mods/packages/default/1.0/file", b"old package");
            write(&staged, "saves/progress.sav", b"backup save");
            let mut journal = crate::operation::LifecycleOperation::new(
                &id,
                crate::operation::LifecycleOperationKind::Restore,
                ID,
            );
            journal.phase = crate::operation::LifecyclePhase::Prepared;
            journal.activate = true;
            journal.paths.staging = Some(root.clone());
            journal.paths.final_path = Some(user.clone());
            journal.paths.quarantine = Some(root.join("previous-data"));
            let store = OperationStore::new(service.library.clone());
            store.put(&mut journal).unwrap();
            let result = crate::recovery::recover_restore(&service, &store, &mut journal);
            if conflict {
                assert!(
                    result
                        .unwrap_err()
                        .message
                        .contains("same package ID/version")
                );
                assert_eq!(
                    fs::read(user.join("saves/progress.sav")).unwrap(),
                    b"current canonical"
                );
                assert!(staged.is_dir());
                assert!(!root.join("previous-data").exists());
            } else {
                result.unwrap();
                assert_eq!(
                    fs::read(user.join("saves/progress.sav")).unwrap(),
                    b"backup save"
                );
                assert!(!root.exists());
                assert!(initialized(&install).unwrap());
            }
            assert!(
                install
                    .path
                    .join("build-portcove/mods/packages/default/2.0/file")
                    .is_file()
            );
            assert_eq!(service.status(ID).unwrap().active.unwrap().id, install.id);
        }
    }

    #[test]
    fn launched_collection_refuses_unreadable_receipt_before_canonical_changes() {
        for malformed in [false, true] {
            let (_temporary, service, catalog) = fixture();
            let install = register(&service, &catalog, "v1", true, None);
            let user = service.library.user_dir(ID);
            write(&user, "saves/progress.sav", b"canonical save");
            write(&user, "settings.toml", b"canonical settings");
            write(
                &install.path,
                "build-portcove/saves/progress.sav",
                b"runtime save",
            );
            write(
                &install.path,
                "build-portcove/settings.toml",
                b"runtime settings",
            );
            write(&install.path, LAUNCH_MARKER, b"launched");
            let receipt = if malformed {
                b"malformed".to_vec()
            } else {
                serde_json::to_vec(&DataRestored {
                    schema_version: 2,
                    port_id: ID.into(),
                    install_id: install.id.clone(),
                    manifest_sha256: install.manifest_sha256.clone(),
                })
                .unwrap()
            };
            fs::write(install.path.join(PSX_DATA_RECEIPT), &receipt).unwrap();
            let before = snapshot(&user, &|| Ok(())).unwrap();
            for entry in 0..3 {
                let result = match entry {
                    0 => service.collect_active_user_data_if_launched(ID),
                    1 => service.collect_user_data(ID),
                    _ => service.collect_user_data_from_install(ID, &install.path),
                };
                assert!(result.is_err());
                assert_eq!(snapshot(&user, &|| Ok(())).unwrap(), before);
                assert_eq!(
                    fs::read(install.path.join(PSX_DATA_RECEIPT)).unwrap(),
                    receipt
                );
            }
        }
    }

    fn old_install_journal(
        service: &PortcoveService,
        install: &InstallRecord,
    ) -> crate::operation::LifecycleOperation {
        let id = Uuid::new_v4().to_string();
        let mut journal = crate::operation::LifecycleOperation::new(
            &id,
            crate::operation::LifecycleOperationKind::Install,
            ID,
        );
        journal.install = Some(install.clone());
        journal.activate = true;
        journal.phase = crate::operation::LifecyclePhase::PayloadPublished;
        journal.paths.staging = Some(service.library.staging_dir().join(&id));
        journal.paths.final_path = Some(install.path.clone());
        fs::create_dir_all(journal.paths.staging.as_ref().unwrap()).unwrap();
        OperationStore::new(service.library.clone())
            .put(&mut journal)
            .unwrap();
        journal
    }

    #[test]
    fn older_activate_true_journal_stages_and_preserves_conflict_before_recoverable_commit() {
        let (temporary, service, catalog) = fixture();
        let old = register(&service, &catalog, "v1", true, None);
        write(
            &old.path,
            "build-portcove/mods/packages/bundled/1.0/file",
            b"old player's copy",
        );
        let new = register(&service, &catalog, "v2", false, None);
        write(
            &new.path,
            "build-portcove/mods/packages/bundled/1.0/file",
            b"conflicting release copy",
        );
        let mut journal = old_install_journal(&service, &new);
        let store = OperationStore::new(service.library.clone());
        assert!(
            crate::recovery::recover_published_install(&service, &store, &mut journal)
                .unwrap_err()
                .message
                .contains("same package ID/version")
        );
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, old.id);
        assert_eq!(service.status(ID).unwrap().staged.unwrap().id, new.id);
        assert!(store.get(&journal.id).unwrap().is_some());
        // Deliberate manual preservation resolves the reported exact conflict.
        let preserved = temporary.path().join("preserved-conflicting-package");
        fs::rename(
            new.path.join("build-portcove/mods/packages/bundled/1.0"),
            &preserved,
        )
        .unwrap();
        crate::recovery::recover_published_install(&service, &store, &mut journal).unwrap();
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, new.id);
        assert_eq!(
            fs::read(
                new.path
                    .join("build-portcove/mods/packages/bundled/1.0/file")
            )
            .unwrap(),
            b"old player's copy"
        );
        assert_eq!(
            fs::read(preserved.join("file")).unwrap(),
            b"conflicting release copy"
        );
        assert!(store.get(&journal.id).unwrap().is_none());
        assert!(old.path.is_dir());
    }

    #[test]
    fn older_journal_after_actual_commit_preserves_authoritative_active_data() {
        let (_temporary, service, catalog) = fixture();
        let old = register(&service, &catalog, "v1", true, None);
        let new = register(&service, &catalog, "v2", false, None);
        write(
            &new.path,
            "build-portcove/mods/packages/bundled/1.0/file",
            b"committed current bytes",
        );
        write(
            &service.library.user_dir(ID),
            "mods/packages/bundled/1.0/file",
            b"stale canonical copy",
        );
        let mut journal = old_install_journal(&service, &new);
        service.library.register_install(&new, true).unwrap();
        crate::recovery::recover_published_install(
            &service,
            &OperationStore::new(service.library.clone()),
            &mut journal,
        )
        .unwrap();
        assert_eq!(service.status(ID).unwrap().active.unwrap().id, new.id);
        assert_eq!(
            fs::read(
                new.path
                    .join("build-portcove/mods/packages/bundled/1.0/file")
            )
            .unwrap(),
            b"committed current bytes"
        );
        assert!(old.path.is_dir());
    }
}
