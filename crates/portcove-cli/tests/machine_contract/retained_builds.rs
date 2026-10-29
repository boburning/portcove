//! Compiled CLI coverage for exact local references, not game or mod qualification.

use super::*;
use std::{fs, path::Path};

const PORT: &str = "opengoal-jak1";
const SETUP: &str = "customized-fixture";

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
    assert!(output.stderr.is_empty(), "{output:?}");
    assert_eq!(String::from_utf8_lossy(&output.stdout).lines().count(), 1);
    let value = json_stdout(&output);
    assert_eq!(value["schema_version"], portcove_core::API_SCHEMA_VERSION);
    assert_eq!(value["command"], expected_command);
    assert_eq!(value["ok"], true);
    if arguments.contains(&"--jsonl") {
        assert_eq!(value["type"], "result");
    } else {
        assert!(value.get("type").is_none());
    }
    value["data"].clone()
}

#[test]
fn retained_build_reference_roundtrip_binds_exact_bytes_and_keeps_missing_reference() {
    let started = std::time::Instant::now();
    let phase = |label: &str| {
        eprintln!(
            "retained reference phase={label} elapsed={:?}",
            started.elapsed()
        );
    };
    phase("fixture begin");
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let original = root.join("owned-installation");
    fs::create_dir(&original).unwrap();
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let port = catalog.port(PORT).unwrap();
    let platform = portcove_core::Platform::current().unwrap();
    // Reuse the existing prepared native helper as owned fixture content. This
    // test never runs a game or setup tool and adds no executable build route.
    let executable = compile_native_fixture(root);
    phase("native fixture compiled");
    for relative in [
        &port.executable_hints[&platform][0],
        &port.setup_executable_hints[&platform][0],
    ] {
        let destination = original.join(relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(&executable, destination).unwrap();
    }
    fs::write(original.join("owned-sentinel"), b"preserve original bytes").unwrap();
    let installed = result(
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
    let install_id = installed["id"].as_str().unwrap();
    phase("original adopted");
    let install_path = std::path::PathBuf::from(installed["path"].as_str().unwrap());
    let list = result(
        root,
        &["--json", "installation", "retained", PORT],
        "installation.retained",
    );
    assert_eq!(list["port_id"], PORT);
    assert_eq!(list["builds"].as_array().unwrap().len(), 1);
    assert_eq!(list["builds"][0]["availability"], "verified");
    assert_eq!(list["builds"][0]["install"], installed);
    assert_eq!(list["references"], serde_json::json!([]));
    phase("retained baseline observed");

    let plan_args = [
        "--json",
        "installation",
        "reference-plan",
        PORT,
        SETUP,
        install_id,
    ];
    let preview = result(root, &plan_args, "installation.reference-plan");
    let digest = preview["preview_sha256"].as_str().unwrap();
    assert_eq!(preview["build"], list["builds"][0]["identity"]);
    let human = invoke(root, &plan_args[1..]);
    assert!(human.status.success(), "{human:?}");
    let text = String::from_utf8(human.stdout).unwrap();
    for expected in [
        SETUP,
        install_id,
        digest,
        preview["build"]["artifact"]["sha256"].as_str().unwrap(),
        preview["build"]["manifest_sha256"].as_str().unwrap(),
        preview["build"]["installed_contract_sha256"]
            .as_str()
            .unwrap(),
        "Active selection and player data stay unchanged",
    ] {
        assert!(text.contains(expected), "missing {expected:?}: {text}");
    }
    for (review, yes, error) in [(digest, false, "usage"), ("stale-review", true, "conflict")] {
        let mut arguments = vec![
            "--json",
            "--non-interactive",
            "installation",
            "reference-bind",
            PORT,
            SETUP,
            install_id,
            "--expected-preview",
            review,
        ];
        if yes {
            arguments.push("--yes");
        }
        let refused = invoke(root, &arguments);
        assert!(!refused.status.success(), "{refused:?}");
        let refusal = json_stdout(&refused);
        assert_eq!(refusal["command"], "installation.reference-bind");
        assert_eq!(refusal["error"]["code"], error);
        assert_eq!(
            result(
                root,
                &["--json", "installation", "retained", PORT],
                "installation.retained"
            )["references"],
            serde_json::json!([])
        );
    }
    phase("binding refusal controls complete");
    let bound = result(
        root,
        &[
            "--jsonl",
            "--non-interactive",
            "installation",
            "reference-bind",
            PORT,
            SETUP,
            install_id,
            "--expected-preview",
            digest,
            "--yes",
        ],
        "installation.reference-bind",
    );
    assert_eq!(bound["setup_id"], SETUP);
    assert_eq!(bound["revision"], 1);
    assert_eq!(bound["build"], preview["build"]);
    let resolved = result(
        root,
        &["--json", "installation", "reference", PORT, SETUP],
        "installation.reference",
    );
    assert_eq!(resolved["reference"], bound);
    assert_eq!(resolved["availability"], "verified");
    assert_eq!(resolved["install"], installed);
    phase("bound reference resolved");
    let listed = result(
        root,
        &["--jsonl", "installation", "retained", PORT],
        "installation.retained",
    );
    assert_eq!(
        listed["builds"][0]["retained_by"],
        serde_json::json!([SETUP])
    );

    let moved = install_path.with_file_name("temporarily-unavailable-build");
    fs::rename(&install_path, &moved).unwrap();
    let missing = result(
        root,
        &["--jsonl", "installation", "reference", PORT, SETUP],
        "installation.reference",
    );
    assert_eq!(missing["reference"], bound);
    assert_eq!(missing["availability"], "missing");
    assert_eq!(missing["gap"]["code"], "not_found");
    fs::rename(&moved, &install_path).unwrap();
    phase("missing reference preserved and installation restored");

    let removal = result(
        root,
        &[
            "--json",
            "installation",
            "reference-removal-plan",
            PORT,
            SETUP,
        ],
        "installation.reference-removal-plan",
    );
    assert_eq!(removal["reference"], bound);
    let removal_digest = removal["preview_sha256"].as_str().unwrap();
    for (review, yes, error) in [
        (removal_digest, false, "usage"),
        ("stale-review", true, "conflict"),
    ] {
        let mut arguments = vec![
            "--json",
            "--non-interactive",
            "installation",
            "reference-remove",
            PORT,
            SETUP,
            "--expected-preview",
            review,
        ];
        if yes {
            arguments.push("--yes");
        }
        let refused = invoke(root, &arguments);
        assert!(!refused.status.success(), "{refused:?}");
        let refusal = json_stdout(&refused);
        assert_eq!(refusal["command"], "installation.reference-remove");
        assert_eq!(refusal["error"]["code"], error);
        assert_eq!(
            result(
                root,
                &["--json", "installation", "reference", PORT, SETUP],
                "installation.reference"
            )["reference"],
            bound
        );
    }
    phase("removal refusal controls complete");
    let removed = result(
        root,
        &[
            "--jsonl",
            "--non-interactive",
            "installation",
            "reference-remove",
            PORT,
            SETUP,
            "--expected-preview",
            removal_digest,
            "--yes",
        ],
        "installation.reference-remove",
    );
    assert_eq!(removed, bound);
    let after = result(
        root,
        &["--json", "installation", "retained", PORT],
        "installation.retained",
    );
    assert_eq!(after["references"], serde_json::json!([]));
    assert_eq!(after["builds"][0]["install"], installed);
    assert_eq!(after["builds"][0]["active"], true);
    assert_eq!(
        fs::read(install_path.join("owned-sentinel")).unwrap(),
        b"preserve original bytes"
    );
    assert_eq!(
        fs::read(original.join("owned-sentinel")).unwrap(),
        b"preserve original bytes"
    );
    phase("all reference and original-byte assertions complete");
}

#[test]
fn retained_build_observations_do_not_recover_pending_work() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let library = root.join("library");
    drop(portcove_core::Library::open(&library).unwrap());
    let database = rusqlite::Connection::open(library.join("portcove.sqlite3")).unwrap();
    database.execute(
        "INSERT INTO activity_history (id, operation, target_kind, target_id, status, started_at, cancellation_phase, cancellation_owner)
         VALUES ('retained-read-recovery', 'prepare', 'port', 'opengoal-jak1', 'running', 1, 'preparing', 'interrupted-worker')", [],
    ).unwrap();
    let state = || {
        database.query_row(
        "SELECT status, cancellation_phase, finished_at FROM activity_history WHERE id='retained-read-recovery'", [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<i64>>(2)?)),
    ).unwrap()
    };
    let pending = state();
    for arguments in [
        vec!["--json", "installation", "retained", PORT],
        vec!["--json", "installation", "reference", PORT, SETUP],
        vec![
            "--json",
            "installation",
            "reference-plan",
            PORT,
            SETUP,
            "missing-install",
        ],
        vec![
            "--json",
            "installation",
            "reference-removal-plan",
            PORT,
            SETUP,
        ],
    ] {
        let output = invoke(root, &arguments);
        let value = json_stdout(&output);
        assert_eq!(value["command"], format!("installation.{}", arguments[2]));
        assert_eq!(state(), pending, "{arguments:?}: {output:?}");
    }
    let refused = invoke(
        root,
        &[
            "--json",
            "--non-interactive",
            "installation",
            "reference-bind",
            PORT,
            SETUP,
            "missing-install",
            "--expected-preview",
            "review",
            "--yes",
        ],
    );
    assert!(!refused.status.success());
    assert_eq!(state().0, "failed");
    assert!(state().2.is_some());
}

#[test]
fn retained_build_schemas_help_and_required_reviews_are_library_free() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let capabilities = result(root, &["--json", "capabilities"], "capabilities");
    let commands = capabilities["commands"].as_array().unwrap();
    for name in [
        "installation.retained",
        "installation.reference",
        "installation.reference-plan",
        "installation.reference-bind",
        "installation.reference-removal-plan",
        "installation.reference-remove",
    ] {
        assert!(
            commands
                .iter()
                .any(|command| command.as_str() == Some(name)),
            "missing capability {name}"
        );
    }
    assert!(!root.join("library").exists());
    let schemas = result(
        root,
        &["--json", "schema", "export", "--contract", "output"],
        "schema.export",
    );
    for name in [
        "retained_build_inventory",
        "retained_build_reference",
        "retained_build_resolution",
        "retained_build_binding_preview",
        "retained_build_removal_preview",
    ] {
        assert!(schemas[name].is_object(), "missing schema {name}");
    }
    assert_eq!(
        schemas["retained_build_resolution"]["$defs"]["RetainedBuildAvailability"]["enum"],
        serde_json::json!(["verified", "missing", "changed", "held", "unavailable"])
    );
    for (command, positional, source) in [
        (
            "reference-bind",
            vec![PORT, SETUP, "install"],
            "installation reference-plan",
        ),
        (
            "reference-remove",
            vec![PORT, SETUP],
            "installation reference-removal-plan",
        ),
    ] {
        let help = invoke(root, &["installation", command, "--help"]);
        assert!(help.status.success());
        let text = String::from_utf8(help.stdout).unwrap();
        for expected in ["--expected-preview", "--yes", source] {
            assert!(text.contains(expected), "{text}");
        }
        let mut args = vec!["--json", "--non-interactive", "installation", command];
        args.extend(positional);
        args.push("--yes");
        let refused = invoke(root, &args);
        assert_eq!(refused.status.code(), Some(2));
        let value = json_stdout(&refused);
        assert_eq!(value["command"], "cli");
        assert_eq!(value["error"]["code"], "usage");
    }
    assert!(!root.join("library").exists());
}
