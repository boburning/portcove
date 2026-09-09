use super::*;
use serde_json::json;

const REPOSITORY_ID: u64 = 472575717;
const CLOCK: &str = "2026-09-09T12:00:00.000Z";

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
    assert!(
        inspect(&port, &document)?.projections[0]
            .hold_reasons
            .contains(&"upstream-archived".into())
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
