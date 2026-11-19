#[path = "../build_runtime_policy.rs"]
mod build_runtime_policy;

use std::path::PathBuf;
use std::process::Command;

// get_config temporarily changes the working directory. Run each real Tauri
// reader/compiler case in its own process, without changing the test host's env.
#[test]
fn effective_config_child() {
    let Some(root) = std::env::var_os("PORTCOVE_RUNTIME_POLICY_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let result = build_runtime_policy::windows_minimum_source(&root.join("tauri.conf.json"));
    if std::env::var_os("PORTCOVE_RUNTIME_POLICY_EXPECT_BAD_JSON").is_some() {
        assert!(matches!(
            result,
            Err(tauri_codegen::CodegenConfigError::FormatInline(_))
        ));
        println!("PORTCOVE_RUNTIME_POLICY_CHILD_COMPLETE");
        return;
    }
    let expected: Option<String> =
        serde_json::from_str(&std::env::var("PORTCOVE_RUNTIME_POLICY_EXPECTED").unwrap()).unwrap();
    let source = root.join("projection.rs");
    std::fs::write(
        &source,
        format!(
            "{}\nfn main() {{ assert_eq!(WINDOWS_WEBVIEW2_MINIMUM, {:?}); }}\n",
            result.expect("read the effective Tauri configuration"),
            expected
        ),
    )
    .unwrap();
    let binary = root.join(format!("projection{}", std::env::consts::EXE_SUFFIX));
    let compiled = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
        .args([
            "--edition=2024",
            "--crate-name",
            "runtime_policy_projection",
        ])
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let executed = Command::new(&binary).output().unwrap();
    assert!(
        executed.status.success(),
        "{}",
        String::from_utf8_lossy(&executed.stderr)
    );
    println!("PORTCOVE_RUNTIME_POLICY_CHILD_COMPLETE");
}

#[test]
fn effective_minimum_reaches_compiled_rust_with_platform_and_environment_precedence() {
    let escaped = "156.2.3.4\";\nnot Rust code";
    let cases = [
        (
            "platform",
            "x86_64-pc-windows-msvc",
            None,
            Some("156.2.3.5"),
            false,
        ),
        (
            "environment",
            "x86_64-pc-windows-msvc",
            Some(r#"{"bundle":{"windows":{"minimumWebview2Version":"156.2.3.6"}}}"#),
            Some("156.2.3.6"),
            false,
        ),
        (
            "other-target",
            "x86_64-unknown-linux-gnu",
            None,
            Some("156.2.3.4"),
            false,
        ),
        (
            "missing",
            "x86_64-pc-windows-msvc",
            Some(r#"{"bundle":{"windows":{"minimumWebview2Version":null}}}"#),
            None,
            false,
        ),
        (
            "escaped",
            "x86_64-pc-windows-msvc",
            None,
            Some(escaped),
            false,
        ),
        (
            "invalid-json",
            "x86_64-pc-windows-msvc",
            Some("{"),
            None,
            true,
        ),
    ];
    for (name, target, overlay, expected, invalid_json) in cases {
        let fixture = tempfile::tempdir().unwrap();
        std::fs::write(
            fixture.path().join("tauri.conf.json"),
            r#"{"identifier":"io.portcove.runtime-policy-test","bundle":{"windows":{"minimumWebview2Version":"156.2.3.4"}}}"#,
        )
        .unwrap();
        std::fs::write(
            fixture.path().join("tauri.windows.conf.json"),
            serde_json::json!({"bundle":{"windows":{"minimumWebview2Version":
                if name == "escaped" { escaped } else { "156.2.3.5" }
            }}})
            .to_string(),
        )
        .unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", "effective_config_child", "--nocapture"])
            .env("PORTCOVE_RUNTIME_POLICY_TEST_ROOT", fixture.path())
            .env(
                "PORTCOVE_RUNTIME_POLICY_EXPECTED",
                serde_json::to_string(&expected).unwrap(),
            )
            .env("TAURI_ENV_TARGET_TRIPLE", target)
            .env_remove("PORTCOVE_RUNTIME_POLICY_EXPECT_BAD_JSON")
            .env_remove("TAURI_CONFIG");
        if let Some(overlay) = overlay {
            child.env("TAURI_CONFIG", overlay);
        }
        if invalid_json {
            child.env("PORTCOVE_RUNTIME_POLICY_EXPECT_BAD_JSON", "1");
        }
        let result = child.output().unwrap();
        assert!(
            result.status.success(),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&result.stdout)
                .matches("PORTCOVE_RUNTIME_POLICY_CHILD_COMPLETE")
                .count(),
            1,
            "{name}: the selected child must actually complete its assertions"
        );
    }
}
