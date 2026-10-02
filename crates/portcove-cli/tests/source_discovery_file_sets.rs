use portcove_core::{ChildProcessClass, ChildProcessPolicy};

fn cli_binary() -> std::path::PathBuf {
    // Nextest remaps the companion binary when an archive moves between runners.
    std::env::var_os("NEXTEST_BIN_EXE_portcove")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_portcove").into())
}

#[test]
fn public_directory_set_search_is_bounded_and_never_registers_synthetic_members() {
    let temporary = tempfile::tempdir().unwrap();
    let sources = temporary.path().join("sources");
    std::fs::create_dir(&sources).unwrap();
    let names = [
        "baserom.us.rev0.z64",
        "baserom.translated.ek.ndd",
        "N64DDIPLROM.n64",
    ];
    for name in names {
        std::fs::write(sources.join(name), b"synthetic, not accepted game bytes").unwrap();
    }
    let library = temporary.path().join("library");
    let run = |args: &[&str]| {
        let mut command =
            ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, cli_binary())
                .unwrap();
        command
            .arg("--library")
            .arg(&library)
            .arg("--json")
            .args(args);
        for kind in ["CONFIG", "DATA", "CACHE", "STATE"] {
            command.env(format!("XDG_{kind}_HOME"), temporary.path().join(kind));
        }
        command.env(
            "PORTCOVE_PREFERENCES",
            temporary.path().join("preferences.json"),
        );
        let output = command.output().unwrap();
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    let report = run(&[
        "source",
        "discover",
        "--root",
        sources.to_str().unwrap(),
        "--profile",
        "g-diffuser-source-set",
        "--max-hash-bytes",
        "1",
    ]);
    assert_eq!(report["command"], "source.discover");
    assert_eq!(
        report["data"]["searched_profiles"],
        serde_json::json!(["g-diffuser-source-set"])
    );
    assert_eq!(report["data"]["entries_examined"], 3);
    assert_eq!(report["data"]["hash_bytes"], 0);
    assert_eq!(
        report["data"]["limits_reached"],
        serde_json::json!(["hash_bytes"])
    );
    assert_eq!(report["data"]["candidates"], serde_json::json!([]));
    assert_eq!(run(&["source", "list"])["data"], serde_json::json!([]));
    for name in names {
        assert_eq!(
            std::fs::read(sources.join(name)).unwrap(),
            b"synthetic, not accepted game bytes"
        );
    }
}
