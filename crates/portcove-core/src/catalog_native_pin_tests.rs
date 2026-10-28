//! Existing native lifecycle with exact archive pins; no game or network runs.
use super::*;
use crate::Platform;

const ID: &str = "marathon-aleph-one";

fn document() -> serde_json::Value {
    serde_json::to_value(Catalog::embedded().unwrap().authoritative_document()).unwrap()
}

fn port(document: &mut serde_json::Value) -> &mut serde_json::Value {
    document["ports"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|port| port["id"] == ID)
        .unwrap()
}

#[test]
fn native_pins_resolve_only_the_exact_declared_platform_channel_and_artifact() {
    let catalog = Catalog::embedded().unwrap();
    for id in [
        ID,
        "marathon-2-durandal-aleph-one",
        "marathon-infinity-aleph-one",
    ] {
        let port = catalog.port(id).unwrap();
        let expected = &port.release.direct[&Platform::WindowsX86_64];
        let resolved =
            crate::providers::resolve_direct(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .unwrap();
        assert_eq!(resolved.version, expected.version);
        assert_eq!(resolved.asset.url, expected.url);
        assert_eq!(resolved.asset.size, expected.size);
        assert_eq!(resolved.asset.sha256, expected.sha256);
        assert!(resolved.asset.name.ends_with("-Win.zip"));
        assert!(!resolved.asset.name.contains("-Exe-"));
        assert!(
            crate::providers::resolve_direct(port, ReleaseChannel::Beta, Platform::WindowsX86_64)
                .is_err()
        );
        assert!(
            crate::providers::resolve_direct(port, ReleaseChannel::Stable, Platform::LinuxX86_64)
                .is_err()
        );
        assert!(port.automated_tested_platforms.is_empty());
        assert!(port.manually_validated_platforms.is_empty());
    }
}

#[test]
fn native_pins_refuse_nonarchives_and_incomplete_or_unqualified_release_identity() {
    for (field, value) in [
        ("url", "https://example.com/player.exe"),
        ("url", "https://example.com/setup.msi"),
        ("url", "https://example.com/player.zip.exe?archive=.zip"),
        ("url", "https://example.com/player.7z"),
        ("url", "http://example.com/player.zip"),
        ("sha256", ""),
        ("sha256", "not-a-digest"),
        ("version", ""),
    ] {
        let mut document = document();
        port(&mut document)["release"]["direct"]["windows-x86-64"][field] = value.into();
        assert!(
            Catalog::from_json(&document.to_string()).is_err(),
            "{field}={value}"
        );
    }
    let mut document = document();
    port(&mut document)["release"]["direct"] = serde_json::json!({});
    assert!(Catalog::from_json(&document.to_string()).is_err());
}

#[test]
fn native_pin_does_not_grant_source_preparation_or_mutable_runtime_authority() {
    for (field, value) in [
        ("source_profile", serde_json::json!("ghostship-source")),
        ("bios_source_profile", serde_json::json!("psx-bios")),
        ("runtime_source_filename", serde_json::json!("original.bin")),
        ("runtime_source_materialization", serde_json::json!("copy")),
        ("runtime_mutable_paths", serde_json::json!(["runtime"])),
        (
            "setup_executable_hints",
            serde_json::json!({"windows-x86-64":["setup.exe"]}),
        ),
        ("setup_arguments", serde_json::json!(["--prepare"])),
        ("source_environment", serde_json::json!("GAME_ORIGINAL")),
        ("user_data_environment", serde_json::json!("GAME_DATA")),
    ] {
        let mut document = document();
        port(&mut document)[field] = value;
        let error = Catalog::from_json(&document.to_string()).unwrap_err();
        assert!(
            error.message.contains("native portable packages require"),
            "{field}: {error}"
        );
    }
}

#[test]
fn native_pin_supports_only_existing_extractable_archive_formats() {
    for extension in ["zip", "tar.gz", "tgz"] {
        let mut document = document();
        port(&mut document)["release"]["direct"]["windows-x86-64"]["url"] =
            format!("https://example.com/complete-game.{extension}").into();
        Catalog::from_json(&document.to_string()).unwrap();
    }
}
