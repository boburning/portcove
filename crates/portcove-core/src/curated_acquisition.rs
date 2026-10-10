//! Declaration validation for proposed curated bytes. These types cannot
//! construct an acquisition capability or authenticate their evidence claims.

use crate::{Platform, PortDefinition, PortcoveError, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CuratedEvidenceReference {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CuratedAcquisitionRecord {
    pub record_version: u32,
    pub repository: String,
    pub upstream_url: String,
    pub acquisition_host: String,
    pub acquisition_url: String,
    pub release_id: u64,
    pub tag: String,
    pub commit_sha1: String,
    pub asset_id: u64,
    pub platform: Platform,
    pub route: String,
    pub filename: String,
    pub size: u64,
    pub sha256: String,
    pub acquisition_evidence: CuratedEvidenceReference,
    pub distribution_basis: String,
    pub distribution_evidence: CuratedEvidenceReference,
    pub independent_review: CuratedEvidenceReference,
    pub protected_acceptance: CuratedEvidenceReference,
}

fn canonical_hash(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn https_reference(value: &str) -> Option<reqwest::Url> {
    if !bounded_text(value, 2048) {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| host.contains('.') && host.parse::<std::net::IpAddr>().is_err()))
    .then_some(url)
}

impl CuratedAcquisitionRecord {
    /// Checks declared identity and attribution only. No URL is fetched and
    /// neither digest equality nor a claimed acceptance reference grants trust.
    pub(crate) fn validate(&self, repository: &str, platform: Platform) -> Result<()> {
        let upstream = format!("https://github.com/{repository}");
        let acquisition = https_reference(&self.acquisition_url);
        let mut expected_acquisition = https_reference(&upstream)
            .ok_or_else(|| PortcoveError::usage("invalid curated upstream declaration"))?;
        expected_acquisition
            .path_segments_mut()
            .map_err(|_| PortcoveError::usage("invalid curated upstream coordinates"))?
            .extend([
                "releases",
                "download",
                self.tag.as_str(),
                self.filename.as_str(),
            ]);
        let tag_valid = bounded_text(&self.tag, 255)
            && self.tag.split('/').all(|part| {
                !part.is_empty()
                    && !part.starts_with('.')
                    && !part.ends_with('.')
                    && !part.ends_with(".lock")
                    && !part.contains("..")
                    && part.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
            });
        let references = [
            &self.acquisition_evidence,
            &self.distribution_evidence,
            &self.independent_review,
            &self.protected_acceptance,
        ];
        if self.record_version != 1
            || self.repository != repository
            || self.upstream_url != upstream
            || self.acquisition_url != expected_acquisition.as_str()
            || self.platform != platform
            || self.route != "github-release-asset"
            || self.release_id == 0
            || self.asset_id == 0
            || !tag_valid
            || !canonical_hash(&self.commit_sha1, 40)
            || !canonical_hash(&self.sha256, 64)
            || self.size == 0
            || self.size > i64::MAX as u64
            || !bounded_text(&self.filename, 255)
            || self.filename.contains(['/', '\\'])
            || matches!(self.filename.as_str(), "." | "..")
            || crate::archive::validate_relative_path(&self.filename, false).is_err()
            || !bounded_text(&self.distribution_basis, 2048)
            || acquisition.as_ref().is_none_or(|url| {
                url.host_str() != Some(self.acquisition_host.as_str())
                    || url.query().is_some()
                    || url.fragment().is_some()
            })
            || references.iter().any(|reference| {
                https_reference(&reference.url).is_none() || !canonical_hash(&reference.sha256, 64)
            })
        {
            return Err(PortcoveError::usage(
                "invalid curated acquisition declaration",
            ));
        }
        Ok(())
    }
}

/// Existing publisher-digest grants do not admit curated claims. Every Core
/// acquisition caller must fail before a provider or cached selection can run.
pub(crate) fn require_runtime_authority(port: &PortDefinition) -> Result<()> {
    if !port.release.curated.is_empty() {
        return Err(PortcoveError::unsupported(
            "curated acquisition requires independently admitted capability support",
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn fixture_record() -> CuratedAcquisitionRecord {
    let evidence = || CuratedEvidenceReference {
        url: "https://example.invalid/curated-evidence#review".into(),
        sha256: "b".repeat(64),
    };
    CuratedAcquisitionRecord {
        record_version: 1,
        repository: "ThatGuyMcd/DKR-R".into(),
        upstream_url: "https://github.com/ThatGuyMcd/DKR-R".into(),
        acquisition_host: "github.com".into(),
        acquisition_url: "https://github.com/ThatGuyMcd/DKR-R/releases/download/fixture/game.zip"
            .into(),
        release_id: 1,
        tag: "fixture".into(),
        commit_sha1: "a".repeat(40),
        asset_id: 2,
        platform: Platform::WindowsX86_64,
        route: "github-release-asset".into(),
        filename: "game.zip".into(),
        size: 123,
        sha256: "c".repeat(64),
        acquisition_evidence: evidence(),
        distribution_basis: "Synthetic attribution declaration, not a permission grant".into(),
        distribution_evidence: evidence(),
        independent_review: evidence(),
        protected_acceptance: evidence(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curated_record_validation_binds_identity_and_bounded_evidence() {
        let record = fixture_record();
        record
            .validate(&record.repository, record.platform)
            .unwrap();
        assert!(record.validate("Other/Project", record.platform).is_err());
        assert!(
            record
                .validate(&record.repository, Platform::LinuxX86_64)
                .is_err()
        );
        let valid = serde_json::to_value(&record).unwrap();
        for (pointer, replacement) in [
            ("/record_version", serde_json::json!(2)),
            ("/release_id", serde_json::json!(0)),
            ("/asset_id", serde_json::json!(0)),
            ("/tag", serde_json::json!("../bad")),
            ("/commit_sha1", serde_json::json!("a".repeat(39))),
            ("/route", serde_json::json!("direct-manifest")),
            ("/filename", serde_json::json!("../game.zip")),
            ("/size", serde_json::json!(0)),
            ("/sha256", serde_json::json!("C".repeat(64))),
            ("/acquisition_host", serde_json::json!("other.invalid")),
            (
                "/acquisition_url",
                serde_json::json!(
                    "https://github.com/Other/Project/releases/download/fixture/game.zip"
                ),
            ),
            (
                "/acquisition_url",
                serde_json::json!("http://github.com/game.zip"),
            ),
            (
                "/acquisition_url",
                serde_json::json!("https://user:password@github.com/game.zip"),
            ),
            (
                "/acquisition_url",
                serde_json::json!("https://127.0.0.1/game.zip"),
            ),
            (
                "/acquisition_url",
                serde_json::json!("https://github.com/game.zip?token=secret"),
            ),
            ("/distribution_basis", serde_json::json!("x".repeat(2049))),
            ("/independent_review/sha256", serde_json::json!("unknown")),
            (
                "/protected_acceptance/url",
                serde_json::json!("file:///claim.json"),
            ),
        ] {
            let mut value = valid.clone();
            *value.pointer_mut(pointer).unwrap() = replacement;
            let changed: CuratedAcquisitionRecord = serde_json::from_value(value).unwrap();
            assert!(
                changed
                    .validate(&record.repository, record.platform)
                    .is_err(),
                "{pointer}"
            );
        }
        for pointer in ["", "/independent_review"] {
            let mut value = valid.clone();
            value
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("trust_me".into(), serde_json::json!(true));
            assert!(serde_json::from_value::<CuratedAcquisitionRecord>(value).is_err());
        }
    }

    #[test]
    fn curated_proposal_inspection_is_inert_and_rejects_misbound_records() {
        let mut value =
            serde_json::to_value(crate::Catalog::embedded().unwrap().document()).unwrap();
        let port = value["ports"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|port| port["id"] == "dkr-r")
            .unwrap();
        port["release"]["curated"] = serde_json::json!({"windows-x86-64": fixture_record()});
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("proposal.json");
        let bytes = serde_json::to_vec(&value).unwrap();
        std::fs::write(&input, &bytes).unwrap();
        let inspected = crate::Catalog::inspect_proposal(&input).unwrap();
        let port = inspected
            .ports
            .iter()
            .find(|port| port.port_id == "dkr-r")
            .unwrap();
        assert_eq!(port.curated_record_sha256.len(), 1);
        assert!(inspected.scope.contains("no trust"));
        assert_eq!(std::fs::read(&input).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        let parsed = crate::Catalog::from_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
        assert!(require_runtime_authority(parsed.port("dkr-r").unwrap()).is_err());
        value["schema_version"] = serde_json::json!(1);
        assert!(crate::Catalog::from_json(&value.to_string()).is_err());
    }

    #[tokio::test]
    async fn curated_claims_refuse_github_acquisition_before_network() {
        use crate::ReleaseProvider;
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("dkr-r").unwrap().clone();
        assert!(require_runtime_authority(&port).is_ok());
        assert!(
            !serde_json::to_value(&port.release)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("curated")
        );
        port.release
            .curated
            .insert(Platform::WindowsX86_64, fixture_record());
        let provider = crate::GithubReleaseProvider::with_api_root("http://127.0.0.1:9").unwrap();
        let error = provider
            .resolve(
                &port,
                crate::ReleaseChannel::Stable,
                Platform::WindowsX86_64,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(crate::DefinitionAcquisitionScope::validate_port(&port).is_err());
    }
}
