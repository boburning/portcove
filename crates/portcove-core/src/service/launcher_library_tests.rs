use super::*;
use std::collections::BTreeMap;

fn service(root: &Path) -> PortcoveService {
    PortcoveService::new(crate::Library::open(root.join("library")).unwrap()).unwrap()
}

/// An ordinary catalog port whose upstream repository is unique and whose
/// installation is recognized by its declared executable alone.
fn adoptable_port(service: &PortcoveService, scratch: &Path) -> (String, String, String) {
    let platform = Platform::current().unwrap();
    let mut repositories = BTreeMap::<String, usize>::new();
    for port in service.catalog.ports() {
        if port.release.provider == ReleaseSource::Github {
            *repositories
                .entry(port.release.repository.to_ascii_lowercase())
                .or_default() += 1;
        }
    }
    for port in service.catalog.ports() {
        let Some(hint) = port.executable_hints.get(&platform).and_then(|h| h.first()) else {
            continue;
        };
        if port.release.provider != ReleaseSource::Github
            || repositories[&port.release.repository.to_ascii_lowercase()] != 1
            || hint.contains(['*', '?'])
        {
            continue;
        }
        let probe = scratch.join(format!("probe-{}", port.id));
        write_executable(&probe.join(hint));
        if service.preview_adoption(&probe, Some(&port.id)).is_ok() {
            fs::remove_dir_all(&probe).unwrap();
            return (
                port.id.clone(),
                port.release.repository.clone(),
                hint.clone(),
            );
        }
        fs::remove_dir_all(&probe).unwrap();
    }
    panic!("the embedded catalog has no ordinary adoptable port for this platform");
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn write_executable(path: &Path) {
    write(path, b"synthetic executable");
    crate::permissions::normalize_archive_entry(path, false, true).unwrap();
}

fn tree_digest(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.insert(path.clone(), fs::read(path).unwrap());
            }
        }
    }
    files
}

fn by_folder<'a>(
    inventory: &'a LauncherLibraryInventory,
    folder: &str,
) -> &'a LauncherLibraryEntry {
    inventory
        .entries
        .iter()
        .find(|entry| entry.folder_name == folder)
        .unwrap_or_else(|| panic!("no entry for {folder}: {inventory:#?}"))
}

#[test]
fn quiver_inventory_classifies_entries_and_reads_only() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let service = service(root);
    let (port_id, repository, hint) = adoptable_port(&service, root);
    let data = root.join("quiver-data");
    let apps = root.join("moved apps");
    let ready = apps.join("Ready Game ✓");
    write_executable(&ready.join(&hint));
    write(&ready.join("version.txt"), b"v1.2.3\nignored");
    write(&ready.join("selected_executable.txt"), b"other.exe");
    write(
        &ready.join(".quiver-mods.json"),
        br#"{"mods":[{"provider":"gamebanana","id":"1","files":["a"]},{"provider":"thunderstore"},{"provider":"gamebanana"}]}"#,
    );
    write(&apps.join("Modified/readme.txt"), b"no executable");
    write(&apps.join("Unknown/game.bin"), b"unknown");
    write(&apps.join("CodebergApp/game.bin"), b"unknown");
    write(&apps.join("ManualApp/game.bin"), b"unknown");
    let explicit = root.join("elsewhere/Explicit");
    write_executable(&explicit.join(&hint));
    write(
        &data.join("settings.json"),
        format!(
            r#"{{"AppsPath":{},"GitHubApiToken":"ghp_secret_value"}}"#,
            serde_json::to_string(&apps).unwrap()
        )
        .as_bytes(),
    );
    let library = serde_json::json!({
        "apps": [
            {"name": "Ready", "repository": repository, "folderName": "Ready Game ✓", "preferredVersion": "v9"},
            {"name": "Modified", "repository": repository.to_uppercase(), "folderName": "Modified"},
            {"name": "Unknown", "repository": "someone/not-a-port", "folderName": "Unknown"},
            {"name": "Missing", "repository": "someone/missing", "folderName": "Missing"},
            {"name": "Escape", "repository": repository, "folderName": "../outside"},
            {"name": "Again", "repository": format!("https://github.com/{repository}.git"), "folderName": "Ready Game ✓"},
            {"name": "Explicit", "repository": repository, "folderName": "Explicit", "installPath": explicit},
            {"name": "Relative", "repository": repository, "folderName": "Rel", "installPath": "Apps\\Rel"},
            {"name": "Codeberg", "repositorySource": "codeberg", "repository": repository, "folderName": "CodebergApp"},
            {"name": "Manual", "folderName": "ManualApp"},
            {"name": "Same folder", "repository": "someone/other", "folderName": "Unknown"},
            {"name": "Odd source", "repositorySource": "sourcehut", "repository": "a/b"},
            {"name": "Bad", "repository": 7},
            "not an object"
        ]
    });
    write(
        &data.join("apps.json"),
        serde_json::to_vec_pretty(&library).unwrap().as_slice(),
    );
    let before = tree_digest(root);

    let inventory = service
        .inspect_launcher_library(LauncherKind::Quiver, &data, None)
        .unwrap();

    assert_eq!(tree_digest(root), before, "inspection must not write");
    assert!(!inventory.original_will_be_modified);
    assert_eq!(inventory.format_revision, QUIVER_FORMAT_REVISION);
    assert_eq!(inventory.apps_root_origin, LauncherAppsRootOrigin::Settings);
    assert_eq!(inventory.apps_root.as_deref(), Some(apps.as_path()));
    assert!(!inventory.legacy_library_file);
    let serialized = serde_json::to_string(&inventory).unwrap();
    assert!(!serialized.contains("ghp_secret_value"));

    let entry = by_folder(&inventory, "Ready Game ✓");
    assert_eq!(
        entry.status,
        LauncherEntryStatus::ReadyToReview,
        "{entry:#?}"
    );
    assert_eq!(entry.detected_port_ids, std::slice::from_ref(&port_id));
    assert_eq!(entry.install_path.as_deref(), Some(ready.as_path()));
    assert!(!entry.explicit_install_path);
    assert_eq!(entry.hints.preferred_version.as_deref(), Some("v9"));
    assert_eq!(
        entry.hints.installed_version_label.as_deref(),
        Some("v1.2.3")
    );
    assert_eq!(
        entry.hints.selected_executable.as_deref(),
        Some("other.exe")
    );
    let mods = entry.mods.as_ref().unwrap();
    assert!(mods.readable);
    assert_eq!(mods.records, 3);
    assert_eq!(mods.providers, ["gamebanana", "thunderstore"]);
    assert!(
        entry
            .next_step
            .as_deref()
            .unwrap()
            .ends_with(&format!("--port {port_id}"))
    );
    // The named route is the existing reviewed adoption, which still binds its own plan.
    service.preview_adoption(&ready, Some(&port_id)).unwrap();

    let modified = by_folder(&inventory, "Modified");
    assert_eq!(modified.status, LauncherEntryStatus::UnrecognizedFiles);
    assert_eq!(modified.candidate_port_ids, std::slice::from_ref(&port_id));
    assert!(modified.next_step.is_none());

    let statuses = inventory
        .entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry.status))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(statuses["Unknown"], LauncherEntryStatus::NotInCatalog);
    assert_eq!(statuses["Missing"], LauncherEntryStatus::NotInstalled);
    assert_eq!(statuses["Escape"], LauncherEntryStatus::UnsafePath);
    assert_eq!(statuses["Again"], LauncherEntryStatus::Duplicate);
    assert_eq!(statuses["Explicit"], LauncherEntryStatus::ReadyToReview);
    assert_eq!(statuses["Relative"], LauncherEntryStatus::UnsafePath);
    assert_eq!(statuses["Codeberg"], LauncherEntryStatus::NotInCatalog);
    assert_eq!(statuses["Manual"], LauncherEntryStatus::NotInCatalog);
    assert_eq!(statuses["Same folder"], LauncherEntryStatus::Duplicate);
    let explicit_entry = by_folder(&inventory, "Explicit");
    assert!(explicit_entry.explicit_install_path);
    assert_eq!(by_folder(&inventory, "Rel").install_path, None);
    let manual = inventory
        .entries
        .iter()
        .find(|e| e.name == "Manual")
        .unwrap();
    assert_eq!(manual.repository_source, "manual");

    let skipped = inventory
        .skipped_entries
        .iter()
        .map(|entry| entry.index)
        .collect::<Vec<_>>();
    assert_eq!(skipped, [11, 12, 13]);

    // Inventory is a deterministic read of unchanged inputs.
    let again = service
        .inspect_launcher_library(LauncherKind::Quiver, &data, None)
        .unwrap();
    assert_eq!(again.inventory_sha256, inventory.inventory_sha256);
    write(&ready.join("version.txt"), b"v1.2.4");
    let changed = service
        .inspect_launcher_library(LauncherKind::Quiver, &data, None)
        .unwrap();
    assert_ne!(changed.inventory_sha256, inventory.inventory_sha256);
}

#[test]
fn github_launcher_reads_legacy_grouped_library_and_default_apps_folder() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let service = service(root);
    let (port_id, repository, hint) = adoptable_port(&service, root);
    let data = root.join("GithubLauncher");
    write_executable(&data.join("Apps/Game").join(&hint));
    write(&data.join("Apps/Missing/.keep"), b"");
    fs::remove_dir_all(data.join("Apps/Missing")).unwrap();
    // GitHub Launcher ignores repositorySource; its repositories are always GitHub.
    let library = serde_json::json!({
        "standard": [{"name": "Game", "repository": repository, "folderName": "Game", "repositorySource": "gitlab"}],
        "experimental": null,
        "custom": [{"name": "Missing", "repository": repository, "folderName": "Missing"}]
    });
    write(
        &data.join("games.json"),
        serde_json::to_vec(&library).unwrap().as_slice(),
    );

    let inventory = service
        .inspect_launcher_library(LauncherKind::GithubLauncher, &data, None)
        .unwrap();

    assert!(inventory.legacy_library_file);
    assert_eq!(inventory.format_revision, GITHUB_LAUNCHER_FORMAT_REVISION);
    assert_eq!(inventory.apps_root_origin, LauncherAppsRootOrigin::Default);
    let game = by_folder(&inventory, "Game");
    assert_eq!(game.repository_source, "github");
    assert_eq!(game.status, LauncherEntryStatus::ReadyToReview);
    assert_eq!(game.detected_port_ids, [port_id]);
    assert!(game.mods.is_none(), "only Quiver writes mod sidecars");
    let missing = by_folder(&inventory, "Missing");
    assert_eq!(missing.status, LauncherEntryStatus::NotInstalled);
}

#[test]
fn moved_apps_folder_and_unreadable_settings_stay_explicit() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let service = service(root);
    let (_, repository, hint) = adoptable_port(&service, root);
    let data = root.join("data");
    write(&data.join("settings.json"), b"{not json");
    write(
        &data.join("apps.json"),
        serde_json::to_vec(&serde_json::json!([
            {"name": "Game", "repository": repository, "folderName": "Game"}
        ]))
        .unwrap()
        .as_slice(),
    );
    let unresolved = service
        .inspect_launcher_library(LauncherKind::Quiver, &data, None)
        .unwrap();
    assert_eq!(
        unresolved.apps_root_origin,
        LauncherAppsRootOrigin::Unresolved
    );
    assert_eq!(unresolved.apps_root, None);
    let entry = by_folder(&unresolved, "Game");
    assert_eq!(entry.status, LauncherEntryStatus::UnsafePath);
    assert!(entry.explanation.contains("apps folder"));

    let moved = root.join("new drive/Apps");
    write_executable(&moved.join("Game").join(&hint));
    let overridden = service
        .inspect_launcher_library(LauncherKind::Quiver, &data, Some(&moved))
        .unwrap();
    assert_eq!(
        overridden.apps_root_origin,
        LauncherAppsRootOrigin::Override
    );
    assert_eq!(
        by_folder(&overridden, "Game").status,
        LauncherEntryStatus::ReadyToReview
    );
    assert!(
        service
            .inspect_launcher_library(LauncherKind::Quiver, &data, Some(Path::new("Apps")))
            .is_err()
    );
}

#[test]
fn shared_upstream_repository_is_ambiguous_until_the_player_chooses() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let service = service(root);
    let platform = Platform::current().unwrap();
    // Several catalog ports can share one upstream repository and executable name.
    let mut groups = BTreeMap::<(String, String), Vec<String>>::new();
    for port in service.catalog.ports() {
        if port.release.provider != ReleaseSource::Github {
            continue;
        }
        if let Some(hint) = port.executable_hints.get(&platform).and_then(|h| h.first()) {
            groups
                .entry((port.release.repository.to_ascii_lowercase(), hint.clone()))
                .or_default()
                .push(port.id.clone());
        }
    }
    let data = root.join("data");
    for ((repository, hint), ids) in groups.into_iter().filter(|(_, ids)| ids.len() > 1) {
        let install = data.join("Apps/Shared");
        let _ = fs::remove_dir_all(&install);
        write_executable(&install.join(&hint));
        write(
            &data.join("apps.json"),
            serde_json::to_vec(&serde_json::json!({"apps": [
                {"name": "Shared", "repository": repository, "folderName": "Shared"}
            ]}))
            .unwrap()
            .as_slice(),
        );
        let inventory = service
            .inspect_launcher_library(LauncherKind::Quiver, &data, None)
            .unwrap();
        let entry = by_folder(&inventory, "Shared");
        if entry.detected_port_ids.len() > 1 {
            assert_eq!(entry.status, LauncherEntryStatus::Ambiguous);
            assert!(entry.detected_port_ids.iter().all(|id| ids.contains(id)));
            assert!(
                entry
                    .next_step
                    .as_deref()
                    .unwrap()
                    .ends_with("--port PORT_ID")
            );
            return;
        }
    }
    eprintln!("no shared-repository ports are detectable on this platform");
}

#[test]
fn malformed_and_unsupported_libraries_fail_safely() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let service = service(root);
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let inspect = || service.inspect_launcher_library(LauncherKind::Quiver, &data, None);

    assert_eq!(inspect().unwrap_err().code, crate::ErrorCode::NotFound);
    for (bytes, expected) in [
        (b"{".as_slice(), "not valid JSON"),
        (br#"{"schema": 2, "items": []}"#.as_slice(), "no apps list"),
        (br#""apps""#.as_slice(), "no apps list"),
        (br#"{"apps": {"a": 1}}"#.as_slice(), "not a list"),
    ] {
        write(&data.join("apps.json"), bytes);
        let error = inspect().unwrap_err();
        assert!(error.message.contains(expected), "{error:?}");
    }
    let too_many = serde_json::Value::Array(vec![serde_json::json!({}); ENTRY_LIMIT + 1]);
    write(
        &data.join("apps.json"),
        serde_json::to_vec(&too_many).unwrap().as_slice(),
    );
    assert!(inspect().unwrap_err().message.contains("at most"));

    assert!(
        service
            .inspect_launcher_library(LauncherKind::Quiver, Path::new("relative"), None)
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn symlinked_installations_and_library_files_are_not_followed() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let service = service(root);
    let (_, repository, hint) = adoptable_port(&service, root);
    let data = root.join("data");
    let real = root.join("real");
    write_executable(&real.join(&hint));
    fs::create_dir_all(data.join("Apps")).unwrap();
    std::os::unix::fs::symlink(&real, data.join("Apps/Linked")).unwrap();
    write(
        &data.join("apps.json"),
        serde_json::to_vec(&serde_json::json!([
            {"name": "Linked", "repository": repository, "folderName": "Linked"}
        ]))
        .unwrap()
        .as_slice(),
    );
    let inventory = service
        .inspect_launcher_library(LauncherKind::Quiver, &data, None)
        .unwrap();
    assert_eq!(
        by_folder(&inventory, "Linked").status,
        LauncherEntryStatus::UnsafePath
    );

    let linked_data = root.join("linked-data");
    fs::create_dir_all(&linked_data).unwrap();
    std::os::unix::fs::symlink(data.join("apps.json"), linked_data.join("apps.json")).unwrap();
    assert!(
        service
            .inspect_launcher_library(LauncherKind::Quiver, &linked_data, None)
            .is_err()
    );
}
