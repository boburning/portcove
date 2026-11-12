//! Compiled CLI coverage for the read-only launcher-library inventory (#249).

use super::*;
use std::{collections::BTreeMap, fs, path::Path};

const PORT: &str = "opengoal-jak1";

fn tree(root: &Path) -> BTreeMap<std::path::PathBuf, Vec<u8>> {
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

#[test]
fn launcher_inventory_reads_only_and_hands_matched_entries_to_adopt() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let port = catalog.port(PORT).unwrap();
    let platform = portcove_core::Platform::current().unwrap();
    let executable = compile_native_fixture(root);
    let data = root.join("quiver");
    let install = data.join("Apps/Jak");
    for relative in [
        &port.executable_hints[&platform][0],
        &port.setup_executable_hints[&platform][0],
    ] {
        let destination = install.join(relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(&executable, destination).unwrap();
    }
    fs::create_dir_all(data.join("Apps/Other")).unwrap();
    fs::write(data.join("Apps/Other/game.bin"), b"unrelated").unwrap();
    fs::write(
        data.join("settings.json"),
        br#"{"GitHubApiToken":"ghp_never_read"}"#,
    )
    .unwrap();
    fs::write(
        data.join("apps.json"),
        serde_json::to_vec(&serde_json::json!({"apps": [
            {"name": "Jak", "repository": port.release.repository, "folderName": "Jak"},
            {"name": "Other", "repository": "someone/elsewhere", "folderName": "Other"}
        ]}))
        .unwrap(),
    )
    .unwrap();
    let before = tree(&data);
    let library = root.join("library");
    let preferences = root.join("preferences.json");

    let output = portcove_tool(
        &preferences,
        &library,
        &[
            "--json",
            "launcher-library",
            "inspect",
            "--launcher",
            "quiver",
            data.to_str().unwrap(),
        ],
    );
    assert!(output.status.success(), "{output:?}");
    let value = json_stdout(&output);
    assert_eq!(value["command"], "launcher-library.inspect");
    let inventory = &value["data"];
    assert_eq!(inventory["launcher"], "quiver");
    assert_eq!(inventory["apps_root_origin"], "default");
    assert_eq!(inventory["original_will_be_modified"], false);
    assert!(!value.to_string().contains("ghp_never_read"));
    let jak = &inventory["entries"][0];
    assert!(
        jak["status"] == "ready-to-review" || jak["status"] == "ambiguous",
        "{jak:#}"
    );
    assert!(
        jak["detected_port_ids"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(PORT))
    );
    if jak["status"] == "ready-to-review" {
        assert_eq!(jak["adopt_port_id"], PORT);
    } else {
        assert!(jak["adopt_port_id"].is_null());
    }
    assert_eq!(inventory["entries"][1]["status"], "not-in-catalog");
    assert_eq!(tree(&data), before);

    let human = portcove_tool(
        &preferences,
        &library,
        &[
            "launcher-library",
            "inspect",
            "--launcher",
            "quiver",
            data.to_str().unwrap(),
        ],
    );
    assert!(human.status.success(), "{human:?}");
    let text = String::from_utf8(human.stdout).unwrap();
    assert!(text.contains("Quiver library review"), "{text}");
    assert!(
        text.contains("Launcher files will be modified: No"),
        "{text}"
    );

    // The inventory's handoff is the existing reviewed adoption; the original stays intact.
    let adopted = portcove_tool(
        &preferences,
        &library,
        &[
            "--json",
            "--non-interactive",
            "adopt",
            install.to_str().unwrap(),
            "--port",
            PORT,
            "--yes",
        ],
    );
    assert!(adopted.status.success(), "{adopted:?}");
    assert_eq!(json_stdout(&adopted)["command"], "adopt");
    assert_eq!(tree(&data), before);
}

#[cfg(unix)]
#[test]
fn launcher_batch_copies_named_ready_apps_after_one_confirmation() {
    use std::os::unix::fs::PermissionsExt;
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let platform = portcove_core::Platform::current().unwrap();
    let mut repositories = BTreeMap::<String, usize>::new();
    for port in catalog.ports() {
        *repositories
            .entry(port.release.repository.to_ascii_lowercase())
            .or_default() += 1;
    }
    let data = root.join("quiver");
    let mut apps = Vec::new();
    for port in catalog.ports().iter().filter(|port| {
        port.release.provider == portcove_core::ReleaseSource::Github
            && repositories[&port.release.repository.to_ascii_lowercase()] == 1
    }) {
        let Some(hint) = port.executable_hints.get(&platform).and_then(|h| h.first()) else {
            continue;
        };
        if hint.contains(['*', '?']) {
            continue;
        }
        let executable = data.join("Apps").join(&port.id).join(hint);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"synthetic executable").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        apps.push(serde_json::json!({
            "name": port.id, "repository": port.release.repository, "folderName": port.id
        }));
        if apps.len() == 24 {
            break;
        }
    }
    fs::write(
        data.join("apps.json"),
        serde_json::to_vec(&serde_json::json!({ "apps": apps })).unwrap(),
    )
    .unwrap();
    let library = root.join("library");
    let preferences = root.join("preferences.json");
    let inspected = portcove_tool(
        &preferences,
        &library,
        &[
            "--json",
            "launcher-library",
            "inspect",
            "--launcher",
            "quiver",
            data.to_str().unwrap(),
        ],
    );
    assert!(inspected.status.success(), "{inspected:?}");
    let ready = json_stdout(&inspected)["data"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["status"] == "ready-to-review")
        .map(|entry| entry["name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(ready.len() >= 2, "need two ready apps: {ready:?}");
    let before = tree(&data);

    let unknown = portcove_tool(
        &preferences,
        &library,
        &[
            "--json",
            "--non-interactive",
            "launcher-library",
            "adopt",
            "--launcher",
            "quiver",
            data.to_str().unwrap(),
            "--app",
            "no-such-app",
            "--yes",
        ],
    );
    assert!(!unknown.status.success());

    let adopted = portcove_tool(
        &preferences,
        &library,
        &[
            "--json",
            "--non-interactive",
            "launcher-library",
            "adopt",
            "--launcher",
            "quiver",
            data.to_str().unwrap(),
            "--app",
            &ready[0],
            "--app",
            &ready[1],
            "--yes",
        ],
    );
    assert!(adopted.status.success(), "{adopted:?}");
    let value = json_stdout(&adopted);
    assert_eq!(value["command"], "launcher-library.adopt");
    let items = value["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    for (item, name) in items.iter().zip(&ready) {
        assert_eq!(item["outcome"], "copied", "{item:#}");
        assert_eq!(item["port_id"], name.as_str());
    }
    assert_eq!(
        tree(&data),
        before,
        "launcher data and originals stay unchanged"
    );
}
