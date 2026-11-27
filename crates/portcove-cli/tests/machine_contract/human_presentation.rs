//! Compiled-command evidence for human presentation and unchanged machine data.

use std::{
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

use serde_json::Value;

fn command(root: &Path) -> Command {
    let mut command = Command::new(super::cli_binary());
    command
        .env("PORTCOVE_PREFERENCES", root.join("preferences.json"))
        .env_remove("PORTCOVE_LIBRARY")
        .env_remove("PORTCOVE_GITHUB_TOKEN")
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .arg("--library")
        .arg(root.join("library"));
    command
}

fn invoke(root: &Path, arguments: &[&str]) -> Output {
    command(root)
        .args(arguments)
        .output()
        .expect("compiled CLI should start")
}

#[test]
fn human_source_removal_reviews_identity_and_preserves_original_on_decline_and_success() {
    let temporary = tempfile::tempdir().unwrap();
    let profile_id = "star-fox-64";
    let source = temporary.path().join("original-名称.z64");
    let bytes = b"\x80\x37\x12\x40synthetic source fixture";
    std::fs::write(&source, bytes).unwrap();
    let added = invoke(
        temporary.path(),
        &[
            "--json",
            "source",
            "add",
            profile_id,
            source.to_str().unwrap(),
        ],
    );
    assert!(added.status.success(), "{added:?}");
    let added: Value = serde_json::from_slice(&added.stdout).unwrap();
    let expected_sha256 = added["data"]["sha256"].as_str().unwrap();
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let profile = catalog.source_profile(profile_id).unwrap();
    let name = format!("{} ({profile_id})", profile.label);
    let read_registered = || {
        let output = invoke(temporary.path(), &["--json", "source", "list"]);
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["data"].clone()
    };
    let before = read_registered();
    let refused = invoke(
        temporary.path(),
        &["--non-interactive", "source", "remove", profile_id],
    );
    assert_eq!(refused.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("Confirmation is required; pass --yes")
    );
    assert_eq!(read_registered(), before);

    let mut child = command(temporary.path())
        .args(["source", "remove", profile_id])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"n\n").unwrap();
    let declined = child.wait_with_output().unwrap();
    assert_eq!(declined.status.code(), Some(2));
    let review = String::from_utf8(declined.stdout).unwrap();
    let consent = String::from_utf8(declined.stderr).unwrap();
    assert!(review.contains(&name), "{review}");
    assert!(review.contains(expected_sha256), "{review}");
    assert!(review.contains("Review SHA-256:"), "{review}");
    assert!(
        review.contains("Original game files stay in place."),
        "{review}"
    );
    assert!(consent.contains(&name), "{consent}");
    assert!(consent.contains("Operation cancelled."), "{consent}");
    assert!(!consent.contains("Error:"), "{consent}");
    assert_eq!(read_registered(), before);
    assert_eq!(std::fs::read(&source).unwrap(), bytes);

    let removed = invoke(temporary.path(), &["source", "remove", profile_id, "--yes"]);
    assert!(removed.status.success(), "{removed:?}");
    let text = String::from_utf8(removed.stdout).unwrap();
    assert!(
        text.contains(&format!("Game-file registration removed: {name}")),
        "{text}"
    );
    assert!(
        text.contains("The original game files remain in place."),
        "{text}"
    );
    assert_eq!(read_registered(), serde_json::json!([]));
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
}

#[test]
fn human_guidance_and_json_jsonl_errors_keep_the_same_core_report_and_exit_code() {
    let temporary = tempfile::tempdir().unwrap();
    for (arguments, message, expected_human) in [
        (
            vec!["source", "verify"],
            "provide PROFILE_ID or --all",
            "Provide PROFILE_ID or pass --all.",
        ),
        (
            vec!["check"],
            "provide PORT_ID or --all",
            "Provide PORT_ID or pass --all.",
        ),
        (
            vec!["--non-interactive", "auth", "set-token"],
            "auth set-token requires --stdin under --non-interactive; environment tokens are also supported",
            "PORTCOVE_GITHUB_TOKEN",
        ),
    ] {
        let human = invoke(temporary.path(), &arguments);
        assert_eq!(human.status.code(), Some(2), "{human:?}");
        assert!(human.stdout.is_empty(), "{human:?}");
        let text = String::from_utf8(human.stderr).unwrap();
        assert!(text.starts_with("Error:"), "{text}");
        assert!(text.contains(expected_human), "{text}");
        assert!(text.contains("Next step:"), "{text}");
        for format in ["--json", "--jsonl"] {
            let machine = invoke(
                temporary.path(),
                &[vec![format], arguments.clone()].concat(),
            );
            assert_eq!(machine.status.code(), Some(2), "{machine:?}");
            assert!(machine.stderr.is_empty(), "{machine:?}");
            let value: Value = serde_json::from_slice(&machine.stdout).unwrap();
            assert_eq!(value["schema_version"], portcove_core::API_SCHEMA_VERSION);
            assert_eq!(value["ok"], false);
            assert_eq!(
                value["error"],
                serde_json::to_value(portcove_core::PortcoveError::usage(message).report())
                    .unwrap()
            );
        }
    }
}

#[test]
fn grouped_help_and_redirected_readback_are_actionable_without_terminal_controls() {
    let temporary = tempfile::tempdir().unwrap();
    let help = invoke(temporary.path(), &["--help"]);
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    for heading in [
        "Everyday commands:",
        "Game files and library:",
        "Updates and recovery:",
        "Advanced and integration:",
    ] {
        assert!(text.contains(heading), "{text}");
    }
    for arguments in [
        vec!["check", "--all"],
        vec!["source", "verify", "--all"],
        vec!["catalog", "list"],
        vec!["catalog", "status"],
        vec!["library", "identity"],
    ] {
        let human = invoke(temporary.path(), &arguments);
        assert!(human.status.success(), "{arguments:?}: {human:?}");
        assert!(!human.stdout.contains(&b'\r') && !human.stdout.contains(&0x1b));
        assert!(!human.stderr.contains(&b'\r') && !human.stderr.contains(&0x1b));
        let json = invoke(
            temporary.path(),
            &[vec!["--json"], arguments.clone()].concat(),
        );
        let jsonl = invoke(temporary.path(), &[vec!["--jsonl"], arguments].concat());
        assert!(json.status.success() && jsonl.status.success());
        let json: Value = serde_json::from_slice(&json.stdout).unwrap();
        let jsonl: Value = serde_json::from_slice(&jsonl.stdout).unwrap();
        assert_eq!(json["data"], jsonl["data"]);
    }
    let catalog = portcove_core::Catalog::embedded().unwrap();
    let list = invoke(temporary.path(), &["catalog", "list"]);
    let text = String::from_utf8(list.stdout).unwrap();
    for port in catalog.ports() {
        assert!(
            text.contains(&format!("{} ({})", port.name, port.id)),
            "missing {}",
            port.id
        );
    }
}

#[test]
fn human_library_export_names_metadata_boundary_and_preserves_exported_payload() {
    let temporary = tempfile::tempdir().unwrap();
    let metadata = temporary.path().join("library-metadata.json");
    let human = invoke(
        temporary.path(),
        &["library", "export", "--output", metadata.to_str().unwrap()],
    );
    assert!(human.status.success(), "{human:?}");
    let text = String::from_utf8(human.stdout).unwrap();
    assert!(text.to_lowercase().contains("metadata"), "{text}");
    assert!(
        text.contains("payload") || text.contains("game files"),
        "{text}"
    );
    let exported: Value = serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
    let json = invoke(temporary.path(), &["--json", "library", "export"]);
    assert!(json.status.success(), "{json:?}");
    let response: Value = serde_json::from_slice(&json.stdout).unwrap();
    // The two metadata exports may have different export timestamps. Their
    // durable inventories must agree; presentation must not mutate the library.
    for field in [
        "schema_version",
        "original_root",
        "content_roots",
        "source_references",
        "application_versions",
        "port_settings",
        "launch_history",
    ] {
        assert!(exported.get(field).is_some(), "missing exported {field}");
        assert!(
            response["data"].get(field).is_some(),
            "missing response {field}"
        );
        assert_eq!(exported[field], response["data"][field], "{field}");
    }
    for field in ["artwork", "portability_authority"] {
        assert_eq!(exported.get(field), response["data"].get(field), "{field}");
    }
    assert!(metadata.is_file());
}

#[test]
fn invalid_target_input_is_not_repeated_in_primary_human_progress_or_error() {
    let temporary = tempfile::tempdir().unwrap();
    let private = "token=private-target-canary";
    let human = invoke(temporary.path(), &["install", private]);
    assert!(!human.status.success(), "{human:?}");
    let text = format!(
        "{}{}",
        String::from_utf8(human.stdout).unwrap(),
        String::from_utf8(human.stderr).unwrap()
    );
    assert!(!text.contains(private), "{text}");
    assert!(!text.contains("private-target-canary"), "{text}");
    assert!(text.contains("Selected port"), "{text}");
    assert!(text.contains("Error:"), "{text}");
}

#[test]
fn missing_subcommand_keeps_machine_parser_envelope_and_actionable_help_guidance() {
    let temporary = tempfile::tempdir().unwrap();
    let mut reports = Vec::new();
    for format in ["--json", "--jsonl"] {
        let output = invoke(temporary.path(), &[format]);
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        assert!(output.stderr.is_empty(), "{output:?}");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["schema_version"], portcove_core::API_SCHEMA_VERSION);
        assert_eq!(value["command"], "cli");
        assert_eq!(value["ok"], false);
        assert!(value["data"].is_null());
        assert_eq!(value["error"]["code"], "usage");
        let diagnostic = value["error"]["message"].as_str().unwrap();
        assert!(diagnostic.contains("requires a subcommand"), "{diagnostic}");
        assert!(diagnostic.contains("[OPTIONS] <COMMAND>"), "{diagnostic}");
        assert!(diagnostic.contains("try '--help'"), "{diagnostic}");
        reports.push(value["error"].clone());
    }
    assert_eq!(reports[0], reports[1]);
    assert!(!temporary.path().join("library").exists());
}

#[test]
fn setup_references_reach_human_current_and_explicit_legacy_consumers() {
    let temporary = tempfile::tempdir().unwrap();
    let human = invoke(temporary.path(), &["catalog", "show", "render96ex"]);
    assert!(human.status.success(), "{human:?}");
    let text = String::from_utf8(human.stdout).unwrap();
    assert!(text.contains("Separate program folders can share saves."));
    assert!(text.contains("1. Set up Render96 before adding it"));
    assert!(text.contains("Save locations and version notes"));
    assert!(!text.contains("3. Build output"));
    let current = invoke(
        temporary.path(),
        &["--json", "catalog", "show", "render96ex"],
    );
    assert!(current.status.success(), "{current:?}");
    let current: Value = serde_json::from_slice(&current.stdout).unwrap();
    assert_eq!(current["schema_version"], portcove_core::API_SCHEMA_VERSION);
    assert_eq!(
        current["data"]["presentation"]["manual_setup"]["references"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let schema = "2";
    let output = invoke(
        temporary.path(),
        &["--json", "catalog", "export", "--schema-version", schema],
    );
    assert!(output.status.success(), "{output:?}");
    let output: Value = serde_json::from_slice(&output.stdout).unwrap();
    let data = &output["data"];
    assert_eq!(data["schema_version"].as_u64().unwrap().to_string(), schema);
    let port = data["ports"]
        .as_array()
        .unwrap()
        .iter()
        .find(|port| port["id"] == "render96ex")
        .unwrap();
    let guide = &port["presentation"]["manual_setup"];
    assert!(guide.get("references").is_none());
    assert_eq!(guide["steps"].as_array().unwrap().len(), 5);
    let loaded = portcove_core::Catalog::from_json(&data.to_string()).unwrap();
    assert!(
        loaded
            .port("render96ex")
            .unwrap()
            .presentation
            .as_ref()
            .unwrap()
            .manual_setup
            .as_ref()
            .unwrap()
            .references
            .is_empty()
    );
    let legacy = invoke(
        temporary.path(),
        &["--json", "catalog", "listings", "--format-version", "5"],
    );
    assert!(legacy.status.success(), "{legacy:?}");
    let legacy: Value = serde_json::from_slice(&legacy.stdout).unwrap();
    let doc =
        portcove_core::CatalogListingDocument::from_json(&legacy["data"].to_string()).unwrap();
    assert_eq!(doc.format_version, 5);
    let guide = doc
        .listings
        .iter()
        .find(|listing| listing.id == "syphon-filter-sf-pc-port")
        .unwrap()
        .manual_setup
        .as_ref()
        .unwrap();
    assert!(guide.references.is_empty());
    assert_eq!(guide.steps.len(), 7);
    assert!(
        guide
            .steps
            .iter()
            .any(|step| step.instruction.contains("historical observation"))
    );
}

#[test]
fn artwork_and_implementation_export_with_explicit_legacy_reader_fences() {
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path().join("isolated-home");
    std::fs::create_dir_all(&home).unwrap();
    let read = |arguments: &[&str]| {
        // The helper supplies explicit preferences and library paths. Keep
        // platform directory discovery intact while isolating the runtime lease.
        let output = command(temporary.path())
            .env(
                "PORTCOVE_APPLICATION_RUNTIME_LOCK",
                home.join("application-runtime.lock"),
            )
            .current_dir(temporary.path())
            .args(arguments)
            .output()
            .expect("compiled CLI should start in the isolated fixture");
        assert!(output.status.success(), "{output:?}");
        super::json_stdout(&output)["data"].clone()
    };
    let current = read(&["--json", "catalog", "listings"]);
    let implementation = read(&["--json", "catalog", "listings", "--format-version", "12"]);
    let legacy = read(&["--json", "catalog", "listings", "--format-version", "11"]);
    assert_eq!(current["format_version"], 15);
    assert_eq!(implementation["format_version"], 12);
    assert_eq!(legacy["format_version"], 11);
    // Consume the compiled producer's documents through the actual Core reader,
    // rather than accepting only a new format number or a hand-authored fixture.
    for document in [&current, &implementation, &legacy] {
        portcove_core::CatalogListingDocument::from_json(&document.to_string()).unwrap();
    }
    let current_listings = current["listings"].as_array().unwrap();
    let implementation_listings = implementation["listings"].as_array().unwrap();
    let legacy_listings = legacy["listings"].as_array().unwrap();
    assert_eq!(current_listings.len(), implementation_listings.len());
    assert_eq!(current_listings.len(), legacy_listings.len());
    let zelda = current_listings
        .iter()
        .find(|listing| listing["id"] == "zelda64-recomp")
        .unwrap();
    assert_eq!(
        zelda["implementation"]["methods"][0]["kind"],
        "static-recompilation"
    );
    assert!(zelda["original_game"]["source_editions"].is_array());
    assert!(current_listings.iter().any(|listing| {
        listing["download_block_reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty())
    }));
    let mut removed_scenes = 0;
    let mut removed_restrictions = 0;
    let mut removed_verified_sources = 0;
    for (original, exported) in current_listings.iter().zip(implementation_listings) {
        let mut expected = original.clone();
        let row = expected.as_object_mut().unwrap();
        // Readers below listing format 15 keep only the legacy download string.
        if row.remove("restrictions").is_some() {
            removed_restrictions += 1;
            assert!(
                row["download_block_reason"]
                    .as_str()
                    .is_some_and(|reason| !reason.is_empty()),
                "listing {} keeps its legacy download string",
                original["id"]
            );
        }
        // Format 14 introduced verified source bindings. Older formats keep
        // the edition descriptions and their evidence, with no bindings.
        if let Some(editions) = row
            .get_mut("original_game")
            .and_then(|game| game.get_mut("source_editions"))
            .and_then(Value::as_array_mut)
        {
            for edition in editions {
                if edition
                    .as_object_mut()
                    .unwrap()
                    .remove("verified_sources")
                    .is_some()
                {
                    removed_verified_sources += 1;
                }
            }
        }
        if let Some(media) = row.get_mut("media").and_then(Value::as_array_mut) {
            let count = media.len();
            media.retain(|asset| {
                asset["igdb"].is_null()
                    || !matches!(asset["role"].as_str(), Some("header" | "screenshot"))
            });
            removed_scenes += count - media.len();
            if media.is_empty() {
                row.remove("media");
            }
        }
        assert_eq!(&expected, exported, "listing {}", original["id"]);
    }
    assert!(
        removed_scenes > 0,
        "the bundled catalog has reviewed IGDB scenes"
    );
    assert!(
        removed_restrictions > 0,
        "the bundled catalog has typed acquisition restrictions"
    );
    assert!(
        removed_verified_sources > 0,
        "the bundled catalog has verified source-edition bindings"
    );
    for (original, exported) in implementation_listings.iter().zip(legacy_listings) {
        assert!(exported.get("implementation").is_none());
        // Every original-file guide, edition identity, availability and download
        // restriction survives; only inert explanations are omitted for strict
        // readers that understand at most listing format 11.
        let mut expected = original.clone();
        expected.as_object_mut().unwrap().remove("implementation");
        assert_eq!(&expected, exported, "listing {}", original["id"]);
    }
}

#[test]
fn inert_supplied_listing_export_preserves_the_upstream_guide_instead_of_merging_managed_setup() {
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let authored: Value = serde_json::from_str(include_str!(
        "../../../portcove-core/catalog/ports/alexbeav-diablo-recomp.json"
    ))
    .unwrap();
    let mut supplied = authored["listing"].clone();
    supplied["implementation"] =
        serde_json::json!({"format_version":999,"future":"inert explanation"});
    let document = serde_json::json!({"format_version":12,"listings":[supplied]});
    let parsed = portcove_core::CatalogListingDocument::from_json(&document.to_string()).unwrap();
    let expected_guide = serde_json::to_value(&parsed.listings[0].manual_setup).unwrap();
    let embedded = portcove_core::Catalog::embedded().unwrap();
    let managed_guide = serde_json::to_value(
        &embedded
            .port("alexbeav-diablo-recomp")
            .unwrap()
            .presentation
            .as_ref()
            .unwrap()
            .manual_setup,
    )
    .unwrap();
    assert_ne!(
        expected_guide, managed_guide,
        "the representative must distinguish the upstream guide from managed setup"
    );
    assert!(
        expected_guide
            .to_string()
            .contains("Choose the official Mac ZIP")
    );
    let input = temporary.path().join("supplied-listings.json");
    std::fs::write(&input, document.to_string()).unwrap();
    let invoke = |arguments: &[&str]| {
        command(temporary.path())
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("APPDATA", &home)
            .env("LOCALAPPDATA", &home)
            .env("XDG_CONFIG_HOME", &home)
            .env("XDG_DATA_HOME", &home)
            .env("XDG_CACHE_HOME", &home)
            .env("XDG_STATE_HOME", &home)
            .current_dir(temporary.path())
            .args(arguments)
            .output()
            .unwrap()
    };
    let ordinary = invoke(&[
        "--json",
        "catalog",
        "inspect-listings",
        "--path",
        input.to_str().unwrap(),
    ]);
    assert!(ordinary.status.success(), "{ordinary:?}");
    assert_eq!(super::json_stdout(&ordinary)["data"]["format_version"], 12);
    assert!(
        super::json_stdout(&ordinary)["data"]["listings"][0]
            .get("implementation")
            .is_some()
    );
    let legacy = invoke(&[
        "--json",
        "catalog",
        "inspect-listings",
        "--path",
        input.to_str().unwrap(),
        "--format-version",
        "11",
    ]);
    assert!(legacy.status.success(), "{legacy:?}");
    let legacy = super::json_stdout(&legacy);
    assert_eq!(legacy["data"]["format_version"], 11);
    assert!(
        legacy["data"]["listings"][0]
            .get("implementation")
            .is_none()
    );
    assert_eq!(
        legacy["data"]["listings"][0]["manual_setup"],
        expected_guide
    );
    let unsupported = invoke(&[
        "--json",
        "catalog",
        "inspect-listings",
        "--path",
        input.to_str().unwrap(),
        "--format-version",
        "999",
    ]);
    assert!(!unsupported.status.success());
    assert!(
        !temporary.path().join("library").exists(),
        "every supplied-file projection stays before library opening"
    );
}
