use super::*;
use crate::release::GithubAsset;
use serde_json::json;

const REPOSITORY_ID: u64 = 472575717;
const CLOCK: &str = "2026-09-09T12:00:00.000Z";

fn cvlod_facts() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "../testdata/cvlod-upstream-metadata-2026-10-13.json"
    ))?)
}

fn inspect_cvlod(facts: Value) -> Result<UpstreamObservationReport> {
    let mut port = crate::Catalog::embedded()?.port("cvlod-recomp")?.clone();
    // This proposal covers Windows metadata, not other-platform qualification.
    port.platforms = vec![Platform::WindowsX86_64];
    let repository_id = facts["repository"]["id"].as_u64().unwrap();
    let document = json!({ "format": 1, "authority": "provider-observation-only",
        "port_id": port.id, "started_at": "2026-10-13T00:00:00Z",
        "completed_at": "2026-10-13T00:00:00Z", "facts_sha256": json_digest(&facts)?, "facts": facts });
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("cvlod-observation.json");
    std::fs::write(&path, serde_json::to_vec(&document)?)?;
    inspect_upstream_observation(&port, repository_id, &path)
}

#[test]
fn cvlod_windows_successor_preserves_exact_versioned_selection() -> Result<()> {
    let port = crate::Catalog::embedded()?.port("cvlod-recomp")?.clone();
    let facts = cvlod_facts()?;
    for release in facts["releases"].as_array().unwrap() {
        let mut assets: Vec<GithubAsset> = serde_json::from_value(release["assets"].clone())?;
        assert_eq!(assets.len(), 6);
        let expected = format!(
            "LodRecomp-{}-windows-x64.zip",
            release["tag_name"].as_str().unwrap()
        );
        for _ in 0..assets.len() {
            assert_eq!(
                choose_asset(&port, Platform::WindowsX86_64, &assets)?.name,
                expected
            );
            assets.rotate_left(1);
        }
        assets.reverse();
        assert_eq!(
            choose_asset(&port, Platform::WindowsX86_64, &assets)?.name,
            expected
        );
    }
    for (index, version, size, digest) in [
        (
            0,
            "v0.2.27",
            29_758_946,
            "677cea596030f2ae888904884a64e685be5215eb954431fcee01bafb7757f467",
        ),
        (
            1,
            "v0.2.26",
            29_713_287,
            "be60fefdbc4a98d1cf2ab6932e69825f39268e5ad1daab950ea7b8a19e53b40a",
        ),
    ] {
        let mut selected_facts = facts.clone();
        if index == 1 {
            selected_facts["releases"].as_array_mut().unwrap().remove(0);
        }
        let report = inspect_cvlod(selected_facts)?;
        let selected = report.projections[0].latest_eligible.as_ref().unwrap();
        assert_eq!(selected.release.version, version);
        assert_eq!(
            selected.release.asset.name,
            format!("LodRecomp-{version}-windows-x64.zip")
        );
        assert_eq!(selected.release.asset.size, size);
        assert_eq!(selected.release.asset.sha256, digest);
        assert_eq!(report.eligibility_scope, "core-release-metadata");
        assert!(!report.evidence.provider_authenticated);
        assert!(!report.evidence.artifact_bytes_verified);
        assert!(!report.evidence.catalog_admission_assessed);
    }
    Ok(())
}

#[test]
fn cvlod_windows_successor_holds_incomplete_metadata_without_older_fallback() -> Result<()> {
    let original = cvlod_facts()?;
    for defect in ["missing", "ambiguous", "unhashed", "wrong-platform"] {
        let mut facts = original.clone();
        let assets = facts["releases"][0]["assets"].as_array_mut().unwrap();
        let windows = assets
            .iter()
            .position(|asset| asset["name"] == "LodRecomp-v0.2.27-windows-x64.zip")
            .unwrap();
        match defect {
            "missing" => {
                assets.remove(windows);
            }
            "ambiguous" => {
                let mut duplicate = assets[windows].clone();
                duplicate["id"] = json!(999_999_999);
                duplicate["name"] = json!("LodRecomp-v0.2.27-alternate-windows-x64.zip");
                duplicate["browser_download_url"] = json!(
                    "https://github.com/fliperama86/cvlod_recomp/releases/download/v0.2.27/LodRecomp-v0.2.27-alternate-windows-x64.zip"
                );
                assets.push(duplicate);
            }
            "unhashed" => {
                assets[windows]["digest"] = Value::Null;
            }
            _ => {
                assets[windows]["name"] = json!("LodRecomp-v0.2.27-linux-x64-alternate.zip");
                assets[windows]["browser_download_url"] = json!(
                    "https://github.com/fliperama86/cvlod_recomp/releases/download/v0.2.27/LodRecomp-v0.2.27-linux-x64-alternate.zip"
                );
            }
        }
        let report = inspect_cvlod(facts)?;
        assert_eq!(
            report.projections[0].latest_observed.as_ref().unwrap().tag,
            "v0.2.27"
        );
        assert!(report.projections[0].latest_eligible.is_none(), "{defect}");
        assert_eq!(
            report.projections[0].hold_reasons,
            [if defect == "unhashed" {
                "authenticated-digest-requires-further-resolution"
            } else {
                "asset-missing-or-ambiguous"
            }],
            "{defect}"
        );
    }
    Ok(())
}

fn persona_facts() -> Result<Value> {
    Ok(serde_json::from_str(include_str!(
        "../testdata/persona-upstream-metadata-2026-10-11.json"
    ))?)
}

fn inspect_persona(facts: Value) -> Result<UpstreamObservationReport> {
    let mut port = crate::Catalog::embedded()?
        .port("revelations-persona-recompiled")?
        .clone();
    port.platforms = vec![Platform::WindowsX86_64];
    let repository_id = facts["repository"]["id"].as_u64().unwrap();
    let document = json!({ "format": 1, "authority": "provider-observation-only",
        "port_id": port.id, "started_at": "2026-10-11T05:00:00Z",
        "completed_at": "2026-10-11T05:00:00Z", "facts_sha256": json_digest(&facts)?, "facts": facts });
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("persona-observation.json");
    std::fs::write(&path, serde_json::to_vec(&document)?)?;
    inspect_upstream_observation(&port, repository_id, &path)
}

#[test]
fn persona_owned_input_selection_preserves_complete_versioned_inventory() -> Result<()> {
    let port = crate::Catalog::embedded()?
        .port("revelations-persona-recompiled")?
        .clone();
    let facts = persona_facts()?;
    for release in facts["releases"].as_array().unwrap() {
        let mut assets: Vec<GithubAsset> = serde_json::from_value(release["assets"].clone())?;
        assert_eq!(assets.len(), 9);
        let expected = format!(
            "revp-{}-windows-x86_64-owned-input.zip",
            &release["tag_name"].as_str().unwrap()[1..]
        );
        for _ in 0..assets.len() {
            assert_eq!(
                choose_asset(&port, Platform::WindowsX86_64, &assets)?.name,
                expected
            );
            assets.rotate_left(1);
        }
        assets.reverse();
        assert_eq!(
            choose_asset(&port, Platform::WindowsX86_64, &assets)?.name,
            expected
        );
    }
    let report = inspect_persona(facts)?;
    let selected = report.projections[0].latest_eligible.as_ref().unwrap();
    assert_eq!(selected.release.version, "v0.1.1");
    assert_eq!(selected.release.asset.size, 29_260_787);
    assert_eq!(
        selected.release.asset.sha256,
        "f4336030ba9c0e032061ad6892aa5ce9ff01c4cedcbaf3a5355428e6d728158a"
    );
    assert!(!report.evidence.provider_authenticated);
    assert!(!report.evidence.artifact_bytes_verified);
    assert!(!report.evidence.catalog_admission_assessed);
    Ok(())
}

#[test]
fn persona_owned_input_selection_refuses_missing_ambiguous_or_unhashed_kit() -> Result<()> {
    let original = persona_facts()?;
    for defect in ["missing", "ambiguous", "unhashed"] {
        let mut facts = original.clone();
        let assets = facts["releases"][0]["assets"].as_array_mut().unwrap();
        let kit = assets
            .iter()
            .position(|asset| asset["name"] == "revp-0.1.1-windows-x86_64-owned-input.zip")
            .unwrap();
        match defect {
            "missing" => {
                assets.remove(kit);
            }
            "ambiguous" => {
                let mut competing = assets[kit].clone();
                competing["id"] = json!(999_999_999);
                competing["name"] = json!("revp-0.1.1-windows-x86_64-owned-input-alternate.zip");
                competing["browser_download_url"] = json!(
                    "https://github.com/NJH-1001/RevPRecompile/releases/download/v0.1.1/revp-0.1.1-windows-x86_64-owned-input-alternate.zip"
                );
                assets.push(competing);
            }
            _ => {
                assets[kit]["digest"] = Value::Null;
            }
        }
        let report = inspect_persona(facts)?;
        assert_eq!(
            report.projections[0].latest_observed.as_ref().unwrap().tag,
            "v0.1.1"
        );
        assert!(report.projections[0].latest_eligible.is_none(), "{defect}");
        assert_eq!(
            report.projections[0].hold_reasons,
            [if defect == "unhashed" {
                "authenticated-digest-requires-further-resolution"
            } else {
                "asset-missing-or-ambiguous"
            }],
            "{defect}"
        );
    }
    Ok(())
}

#[test]
fn persona_owned_input_requirement_does_not_redefine_unrelated_asset_hints() -> Result<()> {
    let mut port = crate::Catalog::embedded()?
        .port("revelations-persona-recompiled")?
        .clone();
    let facts = persona_facts()?;
    let mut assets: Vec<GithubAsset> =
        serde_json::from_value(facts["releases"][0]["assets"].clone())?;
    assets.retain(|asset| !asset.name.contains("owned-input"));
    assert!(choose_asset(&port, Platform::WindowsX86_64, &assets).is_err());
    port.adapter = crate::Catalog::embedded()?.port("shipwright")?.adapter;
    assert_eq!(
        choose_asset(&port, Platform::WindowsX86_64, &assets)?.name,
        "revp-0.1.1-windows-x64.zip"
    );
    port.adapter = crate::AdapterKind::PsxRecompManaged;
    port.release
        .asset_hints
        .insert(Platform::WindowsX86_64, vec!["windows-x64".into()]);
    assert_eq!(
        choose_asset(&port, Platform::WindowsX86_64, &assets)?.name,
        "revp-0.1.1-windows-x64.zip"
    );
    Ok(())
}

fn release(id: u64, tag: &str) -> Value {
    json!({
        "id": id, "tag_name": tag, "draft": false, "prerelease": false,
        "created_at": CLOCK, "published_at": CLOCK,
        "assets": [{ "id": id * 10, "name": "game-windows.zip", "state": "uploaded",
            "size": 16, "digest": format!("sha256:{}", "a".repeat(64)),
            "created_at": CLOCK, "updated_at": CLOCK,
            "browser_download_url": format!("https://github.com/HarbourMasters/Shipwright/releases/download/{tag}/game-windows.zip")
        }]
    })
}

fn envelope(releases: Vec<Value>) -> Result<Value> {
    let facts = json!({ "repository": { "id": REPOSITORY_ID, "full_name": "HarbourMasters/Shipwright", "archived": false }, "releases": releases });
    Ok(
        json!({ "format": 1, "authority": "provider-observation-only", "port_id": "shipwright",
        "started_at": CLOCK, "completed_at": CLOCK, "facts_sha256": json_digest(&facts)?, "facts": facts }),
    )
}

fn inspect(port: &PortDefinition, document: &Value) -> Result<UpstreamObservationReport> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("observation.json");
    std::fs::write(&path, serde_json::to_vec(document)?)?;
    inspect_upstream_observation(port, REPOSITORY_ID, &path)
}

#[test]
fn observations_use_shared_game_channels_and_preserve_unverified_evidence() -> Result<()> {
    let mut port = crate::Catalog::embedded()?.port("shipwright")?.clone();
    port.platforms = vec![Platform::WindowsX86_64];
    port.channels = vec![
        ReleaseChannel::Stable,
        ReleaseChannel::Beta,
        ReleaseChannel::Rolling,
    ];
    port.release.rolling_tag = Some("devbuild".into());
    let report = inspect(
        &port,
        &envelope(vec![
            release(3, "1.1-rc5"),
            release(2, "1.0.0"),
            release(1, "devbuild"),
        ])?,
    )?;
    assert_eq!(report.projections.len(), 3);
    for (index, expected_id) in [2, 3, 1].into_iter().enumerate() {
        let projection = &report.projections[index];
        assert_eq!(projection.latest_observed.as_ref().unwrap().id, 3);
        assert!(
            !projection
                .latest_observed
                .as_ref()
                .unwrap()
                .provider_prerelease
        );
        assert_eq!(
            projection.channel_candidate.as_ref().unwrap().id,
            expected_id
        );
        let eligible = projection.latest_eligible.as_ref().unwrap();
        assert_eq!(eligible.release_id, expected_id);
        assert_eq!(eligible.asset_id, expected_id * 10);
        assert_eq!(eligible.release.asset.sha256, "a".repeat(64));
    }
    assert!(!report.evidence.provider_authenticated);
    assert!(!report.evidence.artifact_bytes_verified);
    assert!(!report.evidence.catalog_admission_assessed);
    assert_eq!(report.eligibility_scope, "core-release-metadata");
    Ok(())
}

#[test]
fn a_held_latest_release_never_makes_an_older_release_current() -> Result<()> {
    let mut port = crate::Catalog::embedded()?.port("shipwright")?.clone();
    port.platforms = vec![Platform::WindowsX86_64];
    let older = envelope(vec![release(1, "1.0.0")])?;
    assert_eq!(
        inspect(&port, &older)?.projections[0]
            .latest_eligible
            .as_ref()
            .unwrap()
            .release_id,
        1
    );
    let mut held = release(2, "2.0.0");
    held["assets"][0]["digest"] = Value::Null;
    let document = envelope(vec![held.clone(), release(1, "1.0.0")])?;
    let report = inspect(&port, &document)?;
    assert_eq!(
        report.projections[0].latest_observed.as_ref().unwrap().id,
        2
    );
    assert!(report.projections[0].latest_eligible.is_none());
    assert_eq!(
        report.projections[0].hold_reasons,
        ["authenticated-digest-requires-further-resolution"]
    );
    assert!(
        report.projections[1]
            .hold_reasons
            .contains(&"channel-not-offered".into())
    );
    let mut duplicate = held["assets"][0].clone();
    duplicate["id"] = json!(21);
    duplicate["name"] = json!("another-windows.zip");
    duplicate["browser_download_url"] = json!(
        "https://github.com/HarbourMasters/Shipwright/releases/download/2.0.0/another-windows.zip"
    );
    held["assets"].as_array_mut().unwrap().push(duplicate);
    let report = inspect(&port, &envelope(vec![held])?)?;
    assert_eq!(
        report.projections[0].hold_reasons,
        ["asset-missing-or-ambiguous"]
    );
    Ok(())
}

#[test]
fn observations_reject_changed_bytes_scope_identity_and_invalid_clocks() -> Result<()> {
    let port = crate::Catalog::embedded()?.port("shipwright")?.clone();
    let mut document = envelope(vec![release(1, "1.0.0")])?;
    document["facts"]["repository"]["archived"] = json!(true);
    assert!(
        inspect(&port, &document)
            .unwrap_err()
            .to_string()
            .contains("digest differs")
    );
    document["facts_sha256"] = json!(json_digest(&document["facts"])?);
    let archived = inspect(&port, &document)?;
    assert_eq!(archived.facts_sha256, json_digest(&document["facts"])?);
    assert!(archived.projections[0].hold_reasons.is_empty());
    assert_eq!(
        archived.projections[0]
            .latest_eligible
            .as_ref()
            .unwrap()
            .release_id,
        1
    );
    document["facts"]["releases"][0]["assets"][0]["browser_download_url"] =
        json!("https://foreign.invalid/payload.exe");
    document["facts_sha256"] = json!(json_digest(&document["facts"])?);
    assert!(inspect(&port, &document).is_err());
    let mut document = envelope(vec![release(1, "1.0.0"), release(1, "2.0.0")])?;
    assert!(
        inspect(&port, &document)
            .unwrap_err()
            .to_string()
            .contains("repeated a release")
    );
    document["completed_at"] = json!("2026-02-31T12:00:00Z");
    assert!(
        inspect(&port, &document)
            .unwrap_err()
            .to_string()
            .contains("interval")
    );
    Ok(())
}

#[test]
fn scoped_observations_keep_core_channel_selection_and_require_asset_coverage() -> Result<()> {
    let mut port = crate::Catalog::embedded()?.port("shipwright")?.clone();
    port.platforms = vec![Platform::WindowsX86_64];
    port.channels = vec![
        ReleaseChannel::Stable,
        ReleaseChannel::Beta,
        ReleaseChannel::Rolling,
    ];
    port.release.rolling_tag = Some("devbuild".into());
    let mut document = envelope(vec![
        release(3, "1.1-rc5"),
        release(2, "1.0.0"),
        release(1, "devbuild"),
    ])?;
    document["format"] = json!(2);
    document["coverage"] = json!({ "kind": "channel-candidate-assets", "complete_release_headers": true, "asset_release_ids": [] });
    for release in document["facts"]["releases"].as_array_mut().unwrap() {
        release["assets"] = json!([]);
    }
    document["facts_sha256"] = json!(json_digest(&document["facts"])?);
    let headers = inspect(&port, &document)?;
    for (projection, expected) in headers.projections.iter().zip([2, 3, 1]) {
        assert_eq!(projection.channel_candidate.as_ref().unwrap().id, expected);
        assert!(projection.latest_eligible.is_none());
        assert_eq!(
            projection.hold_reasons,
            ["release-asset-observation-incomplete"]
        );
    }
    document["facts"]["releases"][1] = release(2, "1.0.0");
    document["coverage"]["asset_release_ids"] = json!([2]);
    document["facts_sha256"] = json!(json_digest(&document["facts"])?);
    let scoped = inspect(&port, &document)?;
    assert_eq!(
        scoped.projections[0]
            .latest_eligible
            .as_ref()
            .unwrap()
            .release_id,
        2
    );
    assert!(scoped.projections[1].latest_eligible.is_none());
    assert!(scoped.projections[2].latest_eligible.is_none());
    assert_eq!(
        scoped.eligibility_scope,
        "core-release-metadata-scoped-assets"
    );
    assert!(!scoped.evidence.provider_authenticated);
    assert!(!scoped.evidence.artifact_bytes_verified);
    assert!(!scoped.evidence.catalog_admission_assessed);
    Ok(())
}

#[test]
fn scoped_observations_refuse_ambiguous_coverage_and_unassessed_asset_payloads() -> Result<()> {
    let port = crate::Catalog::embedded()?.port("shipwright")?.clone();
    let mut document = envelope(vec![release(1, "1.0.0")])?;
    document["format"] = json!(2);
    for coverage in [
        json!(null),
        json!({ "kind": "channel-candidate-assets", "complete_release_headers": false, "asset_release_ids": [1] }),
        json!({ "kind": "channel-candidate-assets", "complete_release_headers": true, "asset_release_ids": [1, 1] }),
        json!({ "kind": "channel-candidate-assets", "complete_release_headers": true, "asset_release_ids": [2] }),
        json!({ "kind": "channel-candidate-assets", "complete_release_headers": true, "asset_release_ids": [] }),
        json!({ "kind": "channel-candidate-assets", "complete_release_headers": true, "asset_release_ids": [1], "ignore_missing": true }),
    ] {
        document["coverage"] = coverage;
        assert!(inspect(&port, &document).is_err());
    }
    document["coverage"] = json!({ "kind": "channel-candidate-assets", "complete_release_headers": true, "asset_release_ids": [1] });
    assert!(inspect(&port, &document).is_ok());
    document["format"] = json!(3);
    assert!(inspect(&port, &document).is_err());
    Ok(())
}
