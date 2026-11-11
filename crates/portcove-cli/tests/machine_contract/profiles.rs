//! Compiled CLI coverage for local profile identity and immutable revisions.

use super::*;
use std::{fs, path::Path};

const PORT: &str = "opengoal-jak1";

fn invoke(root: &Path, arguments: &[&str]) -> Output {
    portcove_tool(
        &root.join("preferences.json"),
        &root.join("library"),
        arguments,
    )
}

fn result(root: &Path, arguments: &[&str], expected_command: &str) -> Value {
    let output = invoke(root, arguments);
    assert!(output.status.success(), "{arguments:?}: {output:?}");
    let value = json_stdout(&output);
    assert_eq!(value["command"], expected_command);
    assert_eq!(value["ok"], true);
    value["data"].clone()
}

#[test]
fn profile_commands_migrate_default_append_revisions_and_refuse_stale_review() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let original = root.join("owned-installation");
    fs::create_dir(&original).unwrap();
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let port = catalog.port(PORT).unwrap();
    let platform = portcove_core::Platform::current().unwrap();
    let executable = compile_native_fixture(root);
    for relative in [
        &port.executable_hints[&platform][0],
        &port.setup_executable_hints[&platform][0],
    ] {
        let destination = original.join(relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(&executable, destination).unwrap();
    }
    result(
        root,
        &[
            "--json",
            "--non-interactive",
            "adopt",
            original.to_str().unwrap(),
            "--port",
            PORT,
            "--yes",
        ],
        "adopt",
    );
    let empty = result(root, &["--json", "profile", "list", PORT], "profile.list");
    assert_eq!(empty["profiles"], serde_json::json!([]));

    let default = result(
        root,
        &["--json", "profile", "ensure-default", PORT],
        "profile.ensure-default",
    );
    assert_eq!(default["is_default"], true);
    assert_eq!(default["current_revision"], 1);
    let repeated = result(
        root,
        &["--json", "profile", "ensure-default", PORT],
        "profile.ensure-default",
    );
    assert_eq!(repeated["id"], default["id"]);
    let profile_id = default["id"].as_str().unwrap();

    let copy = result(
        root,
        &["--json", "profile", "copy", PORT, profile_id, "Experiments"],
        "profile.copy",
    );
    assert_eq!(copy["is_default"], false);
    assert_ne!(copy["id"], default["id"]);

    let policy = result(
        root,
        &[
            "--json",
            "profile",
            "policy",
            PORT,
            profile_id,
            "keep-current",
        ],
        "profile.policy",
    );
    assert_eq!(policy["intent"]["update_policy"], "keep_current");

    let request = root.join("request.json");
    fs::write(
        &request,
        br#"{"expected_revision": 1, "limits": ["synthetic fixture"]}"#,
    )
    .unwrap();
    let revised = result(
        root,
        &[
            "--json",
            "profile",
            "revise",
            PORT,
            profile_id,
            request.to_str().unwrap(),
        ],
        "profile.revise",
    );
    assert_eq!(revised["revision"], 2);
    assert_eq!(revised["parent_revision"], 1);
    // The same reviewed request is now stale.
    let stale = invoke(
        root,
        &[
            "--json",
            "profile",
            "revise",
            PORT,
            profile_id,
            request.to_str().unwrap(),
        ],
    );
    assert!(!stale.status.success());
    assert_eq!(json_stdout(&stale)["error"]["code"], "conflict");
    // Unknown request fields are refused rather than ignored.
    fs::write(&request, br#"{"expected_revision": 2, "script": "rm -rf"}"#).unwrap();
    let unknown = invoke(
        root,
        &[
            "--json",
            "profile",
            "revise",
            PORT,
            profile_id,
            request.to_str().unwrap(),
        ],
    );
    assert!(!unknown.status.success());
    assert_eq!(json_stdout(&unknown)["error"]["code"], "usage");

    // A port without a reviewed mod package contract refuses installs up front.
    let package = root.join("anything.o2r");
    fs::write(&package, b"not inspected").unwrap();
    let unsupported = invoke(
        root,
        &[
            "--json",
            "profile",
            "install-package",
            PORT,
            profile_id,
            package.to_str().unwrap(),
            "--expected-revision",
            "2",
        ],
    );
    assert!(!unsupported.status.success());
    assert_eq!(json_stdout(&unsupported)["error"]["code"], "unsupported");
    let live = invoke(root, &["--json", "profile", "live", PORT]);
    assert!(!live.status.success());
    assert_eq!(json_stdout(&live)["error"]["code"], "unsupported");

    let revisions = result(
        root,
        &["--json", "profile", "revisions", PORT, profile_id],
        "profile.revisions",
    );
    assert_eq!(revisions.as_array().unwrap().len(), 2);
    let inventory = result(root, &["--json", "profile", "list", PORT], "profile.list");
    assert_eq!(inventory["profiles"].as_array().unwrap().len(), 2);
    assert_eq!(inventory["profiles"][0]["profile"]["id"], default["id"]);
}
