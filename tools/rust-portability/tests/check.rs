use std::fs;
use std::path::Path;
use std::process::{Command, Output};

fn repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let initialized = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(dir.path())
        .status()
        .unwrap();
    assert!(initialized.success());
    dir
}

fn write(root: &Path, path: &str, source: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, source).unwrap();
}

fn scan(root: &Path) -> Output {
    let binary = std::env::var_os("NEXTEST_BIN_EXE_portcove-rust-portability")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_portcove-rust-portability").into());
    Command::new(binary).current_dir(root).output().unwrap()
}

#[test]
fn denies_unix_windows_and_unc_literals_after_rust_string_decoding() {
    let root = repository();
    write(
        root.path(),
        "crates/fixture/src/lib.rs",
        r#"
        // "/comment/is/not/a/string"
        const OPAQUE_MACRO: &str = include_str!("/home/user/included");
        fn fixture() {
            let _ = format!("/home/user/formatted");
            let _ = ["\x2funreviewed/data", "D:\\Games\\fixture", r"\\host\share\file"];
            let _ = ["/api/session", "/dev/null", "relative/data", "https://example.com/a"];
        }
        "#,
    );
    let result = scan(root.path());
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert_eq!(result.status.code(), Some(1), "{stderr}");
    assert_eq!(stderr.lines().count(), 3, "{stderr}");
    for reported in [
        r#""/unreviewed/data""#,
        r#""D:\\Games\\fixture""#,
        r#""\\\\host\\share\\file""#,
    ] {
        assert!(stderr.contains(reported), "{stderr}");
    }
}

#[test]
fn scopes_do_not_inherit_to_similar_files_or_similar_values() {
    let root = repository();
    let owner = "crates/portcove-core/src/external_runtime/tfe_settings_tests.rs";
    let adjacent = "crates/portcove-core/src/external_runtime/other_tests.rs";
    let desktop = "apps/desktop/src-tauri/src/application_update_process_environment_tests.rs";
    write(
        root.path(),
        owner,
        r#"fn fixture() { let _ = ["C:/Games/", "/dev/null", "C:/Games/Other/"]; }"#,
    );
    write(root.path(), adjacent, r#"const ROOT: &str = "C:/Games/";"#);
    write(
        root.path(),
        desktop,
        r#"const ROOT: &str = "/owned host helpers/fusermount3";"#,
    );
    let result = scan(root.path());
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert_eq!(result.status.code(), Some(1), "{stderr}");
    let findings: Vec<_> = stderr.lines().collect();
    assert_eq!(findings.len(), 2, "{stderr}");
    assert!(findings[0].starts_with(adjacent) && findings[0].ends_with(r#""C:/Games/""#));
    assert!(findings[1].starts_with(owner) && findings[1].ends_with(r#""C:/Games/Other/""#));
}

#[test]
fn accepts_reviewed_platform_and_fixture_literals_including_unicode() {
    let root = repository();
    write(
        root.path(),
        "crates/portcove-core/src/native_external_profile/doom3_linux.rs",
        r#"const ROOT: &str = "/usr/local/lib/dhewm3";"#,
    );
    write(
        root.path(),
        "apps/desktop/src-tauri/src/source_removal_tests.rs",
        r#"const ROOT: &str = "D:/Original ü/game.iso";"#,
    );
    let result = scan(root.path());
    assert!(result.status.success(), "{result:?}");
    assert!(
        String::from_utf8(result.stdout)
            .unwrap()
            .contains("2 files, 0 blocking")
    );
}

#[test]
fn fails_closed_when_source_or_source_inventory_is_unavailable() {
    let root = repository();
    let nested = root.path().join("nested");
    fs::create_dir(&nested).unwrap();
    let result = scan(&nested);
    assert_eq!(result.status.code(), Some(2), "{result:?}");
    assert!(
        String::from_utf8(result.stderr)
            .unwrap()
            .contains("must run from the Git repository root")
    );

    let result = scan(root.path());
    assert_eq!(result.status.code(), Some(2), "{result:?}");
    write(root.path(), "crates/fixture/src/lib.rs", "fn incomplete(");
    let result = scan(root.path());
    assert_eq!(result.status.code(), Some(2), "{result:?}");
    assert!(
        String::from_utf8(result.stderr)
            .unwrap()
            .contains("Cannot parse crates/fixture/src/lib.rs")
    );
}
