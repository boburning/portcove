//! Owned structural/decoder oracles; no retail identity or gameplay acceptance.
use super::*;
use std::{fs, path::Path};

fn fixture(root: &Path) -> (std::path::PathBuf, std::path::PathBuf, Vec<u8>) {
    let sources = root.join("originals");
    fs::create_dir(&sources).unwrap();
    let mut original = vec![0_u8; 156];
    original[..8].copy_from_slice(b"MComprHD");
    original[8..12].copy_from_slice(&124_u32.to_be_bytes());
    original[12..16].copy_from_slice(&5_u32.to_be_bytes());
    original[32..40].copy_from_slice(&4096_u64.to_be_bytes());
    original[40..48].copy_from_slice(&124_u64.to_be_bytes());
    original[56..60].copy_from_slice(&512_u32.to_be_bytes());
    fs::write(sources.join("owned.chd"), &original).unwrap();
    let mut declared = portcove_core::Catalog::embedded()
        .unwrap()
        .document()
        .clone();
    declared.source_profiles.clear();
    let mut document = serde_json::to_value(declared).unwrap();
    let identities = document["source_catalog"]["identities"]
        .as_array_mut()
        .unwrap();
    let optical = identities
        .iter_mut()
        .find(|profile| profile["id"] == "masters-of-teras-kasi-psx")
        .unwrap();
    optical["evidence_gap"] =
        "Owned synthetic normalized track fixture; not a retail source".into();
    let representation = &mut optical["variants"][0]["representations"][0];
    representation["track_counts"] = serde_json::json!([1]);
    representation["identities"] = serde_json::json!([{ "scope": "psx-normalized-track-set", "sha256": "f404b44b39098a3055ea8749e89a6dd5ee2a8b3d73b561f27e7c07c212b44344" }]);
    identities.push(serde_json::json!({ "id": "owned-raw-chd", "label": "Owned original container fixture", "kind": "file", "evidence_gap": "Synthetic original bytes; not a retail source", "variants": [{ "id": "fixture", "title": "Owned container", "representations": [{ "id": "original", "kind": "raw-file", "extensions": ["chd"], "identities": [{ "scope": "original-file", "sha256": "5b146fe879d8709105bce852ec13689e56965d2d04b1fc7178e45ef3134f37a0" }] }] }] }));
    portcove_core::Catalog::from_json(&document.to_string()).unwrap();
    let catalog = root.join("catalog.json");
    fs::write(&catalog, document.to_string()).unwrap();
    (sources, catalog, original)
}

fn discover(
    root: &Path,
    sources: &Path,
    catalog: &Path,
    decoder: &Path,
    maximum: u32,
    mode: &str,
) -> Output {
    Command::new(cli_binary())
        .env("PORTCOVE_QUALIFICATION_CATALOG", catalog)
        .env("PORTCOVE_PREFERENCES", root.join("preferences.json"))
        .env("PORTCOVE_CHDMAN", decoder)
        .arg("--library")
        .arg(root.join("library"))
        .args([mode, "source", "discover", "--root"])
        .arg(sources)
        .args([
            "--profile",
            "masters-of-teras-kasi-psx",
            "--profile",
            "owned-raw-chd",
            "--max-candidates",
            &maximum.to_string(),
        ])
        .output()
        .unwrap()
}

#[test]
fn normalized_and_original_admission_share_facts_without_exceeding_the_candidate_cap() {
    let temporary = tempfile::tempdir().unwrap();
    let (sources, catalog, original) = fixture(temporary.path());
    let decoder = compile_native_fixture(temporary.path());
    for maximum in [1, 2] {
        let result = discover(
            temporary.path(),
            &sources,
            &catalog,
            &decoder,
            maximum,
            "--json",
        );
        assert!(result.status.success(), "{result:?}");
        let report = json_stdout(&result);
        let candidates = report["data"]["candidates"].as_array().unwrap();
        assert_eq!(candidates.len(), maximum as usize);
        assert_eq!(report["data"]["files_hashed"], 1);
        assert_eq!(
            report["data"]["hash_bytes"],
            original.len() as u64 * 2 + b"owned psx track".len() as u64
        );
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate["profile_id"] == "masters-of-teras-kasi-psx")
        );
        if maximum == 2 {
            assert!(
                candidates
                    .iter()
                    .any(|candidate| candidate["profile_id"] == "owned-raw-chd")
            );
        }
        assert_eq!(fs::read(sources.join("owned.chd")).unwrap(), original);
    }
    let streamed = discover(temporary.path(), &sources, &catalog, &decoder, 1, "--jsonl");
    assert!(streamed.status.success(), "{streamed:?}");
    let rows = String::from_utf8(streamed.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        rows.iter()
            .filter(|row| row["type"] == "source_candidate")
            .count(),
        1
    );
    assert_eq!(
        json_stdout(&portcove(
            &temporary.path().join("library"),
            &["--json", "source", "list"]
        ))["data"],
        serde_json::json!([])
    );
}

#[test]
fn missing_and_unqualified_decoders_leave_independent_raw_matches_available() {
    for exists in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let (sources, catalog, original) = fixture(temporary.path());
        let decoder = temporary.path().join("unavailable-decoder.exe");
        if exists {
            fs::write(&decoder, b"owned invalid executable").unwrap();
        }
        let result = discover(temporary.path(), &sources, &catalog, &decoder, 2, "--json");
        assert!(result.status.success(), "{result:?}");
        let report = json_stdout(&result);
        assert_eq!(report["data"]["candidates"].as_array().unwrap().len(), 1);
        assert_eq!(
            report["data"]["candidates"][0]["profile_id"],
            "owned-raw-chd"
        );
        assert!(!report["data"]["issues"].as_array().unwrap().is_empty());
        assert_eq!(fs::read(sources.join("owned.chd")).unwrap(), original);
        assert_eq!(fs::read_dir(&sources).unwrap().count(), 1);
    }
}

#[test]
fn a_decoder_becoming_unavailable_during_resume_preserves_independent_raw_results() {
    let temporary = tempfile::tempdir().unwrap();
    let (sources, catalog, original) = fixture(temporary.path());
    fs::write(sources.join("zz-second.chd"), &original).unwrap();
    let helper = compile_native_fixture(temporary.path());
    let run = |decoder: &Path, args: &[&str]| {
        Command::new(cli_binary())
            .env("PORTCOVE_QUALIFICATION_CATALOG", &catalog)
            .env(
                "PORTCOVE_PREFERENCES",
                temporary.path().join("preferences.json"),
            )
            .env("PORTCOVE_CHDMAN", decoder)
            .arg("--library")
            .arg(temporary.path().join("library"))
            .args(args)
            .output()
            .unwrap()
    };
    let added = run(
        &helper,
        &[
            "--json",
            "source",
            "roots",
            "add",
            sources.to_str().unwrap(),
        ],
    );
    assert!(added.status.success(), "{added:?}");
    let first = run(
        &helper,
        &["--json", "source", "roots", "scan", "--max-entries", "1"],
    );
    assert!(first.status.success(), "{first:?}");
    let first = json_stdout(&first);
    assert!(
        first["data"]["report"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .all(|candidate| candidate["path"].as_str().unwrap().ends_with("owned.chd"))
    );
    assert_eq!(first["data"]["coverage"]["can_resume"], true);
    let last = run(
        &temporary.path().join("missing-decoder.exe"),
        &["--json", "source", "roots", "scan", "--max-entries", "1"],
    );
    assert!(last.status.success(), "{last:?}");
    let last = json_stdout(&last);
    assert!(
        last["data"]["report"]["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|candidate| candidate["profile_id"] == "owned-raw-chd"
                && candidate["path"]
                    .as_str()
                    .unwrap()
                    .ends_with("zz-second.chd"))
    );
    assert!(
        !last["data"]["report"]["issues"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(last["data"]["coverage"]["can_resume"], false);
    assert_eq!(fs::read(sources.join("owned.chd")).unwrap(), original);
    assert_eq!(fs::read(sources.join("zz-second.chd")).unwrap(), original);
}
