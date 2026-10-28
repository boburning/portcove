use crate::{PortDefinition, PortcoveError, ReleaseChannel, ReleaseSource, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

/// Inspect inert provider metadata without a library, network, acquisition or trust mutation.
pub fn inspect_provider_observation(port: &PortDefinition, path: &Path) -> Result<Value> {
    let bytes = crate::path::read_bounded_regular(path, 4 * 1024 * 1024)?;
    let document: Value = serde_json::from_slice(&bytes)?;
    let fail =
        || PortcoveError::verification("provider observation binding or coverage is invalid");
    if document["format"] != 3
        || document["authority"] != "provider-observation-only"
        || document["port_id"] != port.id
    {
        return Err(fail());
    }
    let clock = |key: &str| {
        document[key].as_str().and_then(|s| {
            time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
        })
    };
    let (Some(start), Some(end)) = (clock("started_at"), clock("completed_at")) else {
        return Err(fail());
    };
    if start > end || end - start > time::Duration::hours(12) {
        return Err(fail());
    }
    let mut facts = document["facts"].clone();
    facts.sort_all_objects();
    let digest = hex::encode(Sha256::digest(serde_json::to_vec(&facts)?));
    if document["facts_sha256"] != digest {
        return Err(fail());
    }
    let mut report = match port.release.provider {
        ReleaseSource::Gitlab if document["provider"] == "gitlab" => {
            crate::gitlab::project_observed_releases(port, &facts)?
        }
        ReleaseSource::DirectManifest if document["provider"] == "direct-manifest" => {
            let endpoints = facts["endpoints"].as_object().ok_or_else(fail)?;
            let mut projections = Vec::new();
            for &platform in &port.platforms {
                for channel in [
                    ReleaseChannel::Stable,
                    ReleaseChannel::Beta,
                    ReleaseChannel::Rolling,
                ] {
                    let mut row = json!({"platform":platform,"channel":channel,"latest_observed":null,"channel_candidate":null,"latest_eligible":null,"hold_reasons":[]});
                    match crate::providers::resolve_direct(port, channel, platform) {
                        Ok(release) => {
                            let endpoint = endpoints.get(&release.asset.url).ok_or_else(fail)?;
                            if endpoint["url"] != release.asset.url || !endpoint["status"].is_u64()
                            {
                                return Err(fail());
                            }
                            row["latest_observed"] =
                                json!({"version":release.version,"url":release.asset.url});
                            row["channel_candidate"] = row["latest_observed"].clone();
                            // HEAD establishes availability only, never checksum or artifact verification.
                            let size = endpoint["content_length"].as_u64();
                            if endpoint["status"]
                                .as_u64()
                                .is_some_and(|s| (200..300).contains(&s))
                                && size.is_none_or(|s| s == release.asset.size)
                            {
                                row["latest_eligible"] = json!({"identity":{"provider":"direct-manifest","url":release.asset.url,"version":release.version},"release":release});
                            } else {
                                row["hold_reasons"] = json!([
                                    "pinned-endpoint-unavailable-size-changed-or-redirect-unresolved"
                                ]);
                            }
                        }
                        Err(error) => row["hold_reasons"] = json!([error.to_string()]),
                    }
                    projections.push(row);
                }
            }
            json!({"provider_identity":{"provider":"direct-manifest","port_id":port.id},"projections":projections})
        }
        _ => {
            return Err(PortcoveError::unsupported(
                "provider observation is not applicable to this reviewed definition",
            ));
        }
    };
    let object = report.as_object_mut().expect("constructed object");
    for (key, value) in [
        ("format", json!(2)),
        (
            "engine_api_schema_version",
            json!(crate::API_SCHEMA_VERSION),
        ),
        ("port_id", json!(port.id)),
        ("facts_sha256", json!(digest)),
        (
            "catalog_definition_sha256",
            json!(crate::catalog::observation_definition_sha256(port)?),
        ),
        ("observed_at", document["completed_at"].clone()),
        ("eligibility_scope", json!("core-provider-metadata-only")),
        (
            "evidence",
            json!({"provider_authenticated":false,"artifact_bytes_verified":false,"catalog_admission_assessed":false,"player_update_eligibility_assessed":false}),
        ),
    ] {
        object.insert(key.into(), value);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inspect(port: &PortDefinition, facts: Value, provider: &str) -> Result<Value> {
        let mut canonical = facts.clone();
        canonical.sort_all_objects();
        let document = json!({"format":3,"authority":"provider-observation-only","provider":provider,"port_id":port.id,"started_at":"2026-10-27T00:00:00Z","completed_at":"2026-10-27T00:01:00Z","facts":facts,"facts_sha256":hex::encode(Sha256::digest(serde_json::to_vec(&canonical)?))});
        let directory = tempfile::tempdir()?;
        let file = directory.path().join("observation.json");
        std::fs::write(&file, serde_json::to_vec(&document)?)?;
        inspect_provider_observation(port, &file)
    }
    #[test]
    fn direct_observation_preserves_reviewed_pin_and_separates_availability_from_trust() {
        let catalog = crate::Catalog::embedded().unwrap();
        for port in catalog
            .ports()
            .iter()
            .filter(|p| p.release.provider == ReleaseSource::DirectManifest)
        {
            let endpoints: serde_json::Map<String, Value> = port
                .release
                .direct
                .values()
                .map(|pin| {
                    (
                        pin.url.clone(),
                        json!({"url":pin.url,"status":200,"content_length":pin.size}),
                    )
                })
                .collect();
            let report = inspect(port, json!({"endpoints":endpoints}), "direct-manifest").unwrap();
            assert_eq!(report["format"], 2);
            assert_eq!(report["evidence"]["artifact_bytes_verified"], false);
            assert_eq!(report["evidence"]["catalog_admission_assessed"], false);
            let stable = report["projections"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["channel"] == "stable")
                .unwrap();
            assert!(!stable["latest_eligible"].is_null());
            let mut unavailable: Value = json!({"endpoints":endpoints});
            for value in unavailable["endpoints"]
                .as_object_mut()
                .unwrap()
                .values_mut()
            {
                value["status"] = json!(404);
            }
            let held = inspect(port, unavailable, "direct-manifest").unwrap();
            assert!(
                held["projections"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|p| p["latest_eligible"].is_null())
            );
            assert!(inspect(port, json!({"endpoints":{}}), "direct-manifest").is_err());
            assert!(inspect(port, json!({"endpoints":endpoints}), "gitlab").is_err());
        }
    }
    #[test]
    fn gitlab_observation_reuses_core_selection_and_exact_registry_identity() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut selected_port = catalog
            .ports()
            .iter()
            .find(|p| p.release.provider == ReleaseSource::Gitlab)
            .unwrap()
            .clone();
        selected_port.release.asset_hints.clear();
        selected_port
            .release
            .asset_hints
            .insert(crate::Platform::WindowsX86_64, vec!["windows".into()]);
        let port = &selected_port;
        let name = "Example-v1.0.0-Windows-x64.zip";
        let file_url = format!(
            "https://gitlab.com/{}/-/package_files/301/download",
            port.release.repository
        );
        let facts = json!({"project":{"id":7,"path_with_namespace":port.release.repository,"archived":false},"releases":[{"tag_name":"v1.0.0","description":"","released_at":"2026-10-26T00:00:00Z","upcoming_release":false,"assets":{"links":[{"id":99,"name":name,"url":file_url,"direct_asset_url":file_url,"link_type":"package"}]}}],"packages":[{"id":101,"version":"1.0.0","name":"Example"}],"package_files":{"101":[{"id":301,"file_name":"Example-Windows-x64.zip","size":512,"file_sha256":"a".repeat(64)}]},"coverage":{"releases":true,"packages":true}});
        let report = inspect(port, facts.clone(), "gitlab").unwrap();
        let windows = report["projections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| {
                p["channel"] == "stable"
                    && p["platform"]
                        == serde_json::to_value(crate::Platform::WindowsX86_64).unwrap()
            })
            .unwrap();
        assert_eq!(
            windows["latest_eligible"]["identity"]["package_file_id"],
            301
        );
        assert_eq!(
            windows["latest_eligible"]["release"]["asset"]["sha256"],
            "a".repeat(64)
        );
        assert!(report.get("repository_id").is_none());
        assert_eq!(report["evidence"]["artifact_bytes_verified"], false);
        let mut unknown_archive = facts.clone();
        unknown_archive["project"]
            .as_object_mut()
            .unwrap()
            .remove("archived");
        let unknown_report = inspect(port, unknown_archive, "gitlab").unwrap();
        let unknown_windows = unknown_report["projections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| {
                p["channel"] == "stable"
                    && p["platform"]
                        == serde_json::to_value(crate::Platform::WindowsX86_64).unwrap()
            })
            .unwrap();
        assert_eq!(
            unknown_windows["latest_eligible"],
            windows["latest_eligible"]
        );
        assert!(unknown_report["provider_identity"]["archived"].is_null());
        let mut malformed_archive = facts.clone();
        malformed_archive["project"]["archived"] = json!("false");
        assert!(inspect(port, malformed_archive, "gitlab").is_err());
        let mut incomplete = facts.clone();
        incomplete["package_files"] = json!({});
        let held = inspect(port, incomplete, "gitlab").unwrap();
        assert!(
            held["projections"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p["latest_eligible"].is_null())
        );
        let mut foreign = facts.clone();
        foreign["project"]["path_with_namespace"] = json!("foreign/repository");
        assert!(inspect(port, foreign, "gitlab").is_err());
        let mut duplicate = facts.clone();
        duplicate["releases"]
            .as_array_mut()
            .unwrap()
            .push(facts["releases"][0].clone());
        assert!(inspect(port, duplicate, "gitlab").is_err());
        let mut generic = facts.clone();
        let generic_url = format!(
            "https://gitlab.com/api/v4/projects/{}/packages/generic/Example/1.0.0/Example-Windows-x64.zip",
            port.release.repository.replace('/', "%2F")
        );
        generic["releases"][0]["assets"]["links"][0]["url"] = json!(generic_url);
        generic["releases"][0]["assets"]["links"][0]["direct_asset_url"] = json!(generic_url);
        generic["releases"][0]["description"] =
            json!(format!("{name} SHA-256: {}", "a".repeat(64)));
        let with_description = inspect(port, generic.clone(), "gitlab").unwrap();
        let windows = with_description["projections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| {
                p["channel"] == "stable"
                    && p["platform"]
                        == serde_json::to_value(crate::Platform::WindowsX86_64).unwrap()
            })
            .unwrap();
        assert_eq!(
            windows["latest_eligible"]["release"]["asset"]["size"], 0,
            "description resolution must preserve runtime precedence"
        );
        generic["package_files"]["101"][0]["file_sha256"] = json!("b".repeat(64));
        let conflict = inspect(port, generic, "gitlab").unwrap();
        assert!(
            conflict["projections"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p["latest_eligible"].is_null())
        );
        let mut bad_digest = facts;
        bad_digest["package_files"]["101"][0]["file_sha256"] = json!("invalid");
        assert!(inspect(port, bad_digest, "gitlab").is_err());
    }
}
