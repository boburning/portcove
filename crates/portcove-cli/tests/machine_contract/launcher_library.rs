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
    assert!(
        jak["next_step"]
            .as_str()
            .unwrap()
            .starts_with("portcove adopt")
    );
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
