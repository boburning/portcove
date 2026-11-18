//! Compiled CLI coverage for local profile identity and immutable revisions.

use super::*;
use std::{fs, path::Path};

const PORT: &str = "opengoal-jak1";

#[test]
fn capabilities_advertise_the_public_profile_commands() {
    let temporary = tempfile::tempdir().unwrap();
    let capabilities = result(
        temporary.path(),
        &["--json", "capabilities"],
        "capabilities",
    );
    assert_eq!(
        capabilities["schema_version"],
        portcove_core::API_SCHEMA_VERSION
    );
    let commands = capabilities["commands"].as_array().unwrap();
    for name in [
        "profile",
        "profile.list",
        "profile.create-clean",
        "profile.original-instances",
        "profile.select-original",
        "profile.relink-original",
        "profile.package-plan",
        "profile.package-apply",
        "profile.provider-plan",
        "profile.provider-apply",
        "profile.recover-plan",
        "profile.recover",
    ] {
        assert!(
            commands.iter().any(|command| command == name),
            "capabilities did not advertise {name}"
        );
    }
    assert!(!commands.iter().any(|command| command == "profile.help"));
}

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
fn profile_setups_keeps_full_runtime_verification_in_public_json() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    // This adapter exists in the ordinary compiled CLI, unlike the Core-only
    // Starship mod fixture. Reuse the supported-port adoption shape from
    // host_diagnostics; these owned helper bytes are never game qualification.
    let port_id = "zelda64-recomp";
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let port = catalog.port(port_id).unwrap();
    let original = root.join("owned-installation");
    fs::create_dir(&original).unwrap();
    let relative = &port.executable_hints[&portcove_core::Platform::current().unwrap()][0];
    let executable = original.join(relative);
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::copy(compile_native_fixture(root), &executable).unwrap();
    let install = result(
        root,
        &[
            "--json",
            "--non-interactive",
            "adopt",
            original.to_str().unwrap(),
            "--port",
            port_id,
            "--yes",
        ],
        "adopt",
    );
    result(
        root,
        &["--json", "profile", "ensure-default", port_id],
        "profile.ensure-default",
    );
    let view = result(
        root,
        &["--json", "profile", "setups", port_id],
        "profile.setups",
    );
    assert_eq!(view["supported"], true, "{view}");
    assert_eq!(
        view["inventory"]["profiles"].as_array().unwrap().len(),
        1,
        "{view}"
    );
    assert_eq!(
        view["inventory"]["profiles"][0]["build_availability"], "verified",
        "{view}"
    );
    let installed = Path::new(install["path"].as_str().unwrap())
        .join(install["selected_executable"].as_str().unwrap());
    let mut bytes = fs::read(&installed).unwrap();
    bytes[0] ^= 1;
    fs::write(installed, bytes).unwrap();
    let changed = result(
        root,
        &["--json", "profile", "setups", port_id],
        "profile.setups",
    );
    assert_eq!(
        changed["inventory"]["profiles"][0]["build_availability"], "changed",
        "{changed}"
    );
    assert!(
        !serde_json::to_string(&changed)
            .unwrap()
            .contains("\"present\"")
    );
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

    let original_requirement = port.source_profile.as_deref().unwrap();
    let disc = root.join("original.iso");
    fs::write(&disc, b"synthetic profile recipe original").unwrap();
    let registered = result(
        root,
        &[
            "--json",
            "source",
            "add",
            original_requirement,
            disc.to_str().unwrap(),
        ],
        "source.add",
    );

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
    // Provider planning needs a reviewed binding; this port has none, so it refuses
    // before any network request.
    let no_binding = invoke(
        root,
        &[
            "--json",
            "profile",
            "provider-plan",
            PORT,
            profile_id,
            "1",
            "2",
        ],
    );
    assert!(!no_binding.status.success());
    assert_eq!(json_stdout(&no_binding)["error"]["code"], "unsupported");
    // Browsing is read-only and also needs the binding.
    for arguments in [
        &["--json", "profile", "provider-browse", PORT][..],
        &["--json", "profile", "provider-project", PORT, "1"][..],
    ] {
        let refused = invoke(root, arguments);
        assert!(!refused.status.success());
        let envelope = json_stdout(&refused);
        assert_eq!(envelope["error"]["code"], "unsupported");
        assert_eq!(
            envelope["command"],
            format!("profile.{}", arguments[2]),
            "{envelope}"
        );
    }
    // Applying needs a valid plan file that matches the reviewed digest.
    let plan = root.join("plan.json");
    fs::write(&plan, b"{not json").unwrap();
    let invalid = invoke(
        root,
        &[
            "--json",
            "--non-interactive",
            "profile",
            "provider-apply",
            PORT,
            profile_id,
            plan.to_str().unwrap(),
            "--expected-plan",
            "abc",
            "--yes",
        ],
    );
    assert!(!invalid.status.success());
    assert_eq!(json_stdout(&invalid)["error"]["code"], "usage");
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

    // The archived revision endpoint is available, with setup recovery limited
    // to ports with a supported mod deployment contract.
    for arguments in [
        &["--json", "profile", "recover-plan", PORT, profile_id, "1"][..],
        &[
            "--json",
            "--non-interactive",
            "profile",
            "recover",
            PORT,
            profile_id,
            "1",
            "--expected-plan",
            "reviewed",
            "--yes",
        ][..],
    ] {
        let output = invoke(root, arguments);
        assert!(!output.status.success(), "{arguments:?}: {output:?}");
        let envelope = json_stdout(&output);
        let command = if arguments.contains(&"recover-plan") {
            "profile.recover-plan"
        } else {
            "profile.recover"
        };
        assert_eq!(envelope["command"], command);
        assert_eq!(envelope["error"]["code"], "unsupported");
    }

    // Recipes: export identity only, inspect locally, plan, and import as a new profile.
    let exported = result(
        root,
        &["--json", "profile", "recipe-export", PORT, profile_id],
        "profile.recipe-export",
    );
    assert_eq!(exported["format"], 3);
    assert_eq!(exported["originals"].as_array().unwrap().len(), 1);
    assert_eq!(
        exported["originals"][0]["requirement_id"],
        original_requirement
    );
    assert_eq!(exported["originals"][0]["sha256"], registered["sha256"]);
    assert_eq!(
        exported["originals"][0]["storage"]["sha256"],
        registered["storage_sha256"]
    );
    let recipe_file = root.join("recipe.json");
    fs::write(&recipe_file, serde_json::to_vec_pretty(&exported).unwrap()).unwrap();
    let text = fs::read_to_string(&recipe_file).unwrap();
    assert!(
        !text.contains(root.to_str().unwrap()),
        "no private path in a recipe"
    );
    assert!(
        !text.contains(profile_id),
        "no local profile identity in a recipe"
    );
    let inspected = result(
        root,
        &[
            "--json",
            "profile",
            "recipe-inspect",
            recipe_file.to_str().unwrap(),
        ],
        "profile.recipe-inspect",
    );
    assert_eq!(inspected["identity_sha256"], exported["identity_sha256"]);
    let plan = result(
        root,
        &[
            "--json",
            "profile",
            "recipe-plan",
            recipe_file.to_str().unwrap(),
        ],
        "profile.recipe-plan",
    );
    assert_eq!(plan["can_apply"], true, "{plan}");
    let digest = plan["plan_sha256"].as_str().unwrap();
    // A stale plan digest refuses.
    let stale = invoke(
        root,
        &[
            "--json",
            "--non-interactive",
            "profile",
            "recipe-apply",
            recipe_file.to_str().unwrap(),
            "--name",
            "From recipe",
            "--expected-plan",
            "stale",
            "--yes",
        ],
    );
    assert!(!stale.status.success());
    assert_eq!(json_stdout(&stale)["error"]["code"], "conflict");
    let created = result(
        root,
        &[
            "--json",
            "--non-interactive",
            "profile",
            "recipe-apply",
            recipe_file.to_str().unwrap(),
            "--name",
            "From recipe",
            "--expected-plan",
            digest,
            "--yes",
        ],
        "profile.recipe-apply",
    );
    assert_ne!(created["id"], default["id"]);
    let again = result(
        root,
        &[
            "--json",
            "profile",
            "recipe-export",
            PORT,
            created["id"].as_str().unwrap(),
        ],
        "profile.recipe-export",
    );
    assert_eq!(
        again["identity_sha256"], exported["identity_sha256"],
        "identity round trip"
    );
    // A forged recipe is refused before any planning.
    let mut forged = exported.clone();
    forged["packages"] = serde_json::json!([{"native_id": "../../x", "native_version": null,
        "provider": null, "sha256": "a".repeat(64), "size": 1, "enabled": true, "requires": []}]);
    fs::write(&recipe_file, serde_json::to_vec(&forged).unwrap()).unwrap();
    let refused = invoke(
        root,
        &[
            "--json",
            "profile",
            "recipe-plan",
            recipe_file.to_str().unwrap(),
        ],
    );
    assert!(!refused.status.success());
}

#[test]
fn capabilities_advertise_reviewed_recipe_commands() {
    let temporary = tempfile::tempdir().unwrap();
    let capabilities = result(
        temporary.path(),
        &["--json", "capabilities"],
        "capabilities",
    );
    let commands = capabilities["commands"].as_array().unwrap();
    for name in [
        "profile",
        "profile.recipe-export",
        "profile.recipe-inspect",
        "profile.recipe-acquire",
        "profile.recipe-discard",
        "profile.recipe-plan",
        "profile.recipe-apply",
    ] {
        assert_eq!(
            commands.iter().filter(|command| *command == name).count(),
            1,
            "capabilities must advertise {name} once"
        );
    }
}
