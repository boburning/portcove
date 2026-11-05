//! Optional descriptive notices. Parsing failure is isolated from catalog admission and operations.
use super::{CapabilityFeature, PortCapabilityReport};
use crate::{Platform, PortListing, PortStatus};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CapabilityAdvisory {
    pub id: String,
    pub feature: CapabilityFeature,
    pub platform: Platform,
    pub route: String,
    pub release: Option<String>,
    pub artifact_sha256: Option<String>,
    pub edition: Option<String>,
    pub explanation: String,
    pub provenance: String,
    /// Unix seconds. A newer date never proves an earlier failure is fixed.
    pub observed_at: u64,
    pub evidence: String,
    pub workaround: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AdvisoryApplicability {
    CurrentRoute,
    Historical,
    ContextRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PortCapabilityNotice {
    pub notice: CapabilityAdvisory,
    pub applicability: AdvisoryApplicability,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format_version: u32,
    records: Vec<CapabilityAdvisory>,
}

fn text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= max
        && !value.chars().any(char::is_control)
}

fn descriptive(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    text(value, 2048)
        && !value.contains('`')
        && !value.contains("$(")
        && !lower.contains("/home/")
        && !lower.contains("/users/")
        && !value
            .as_bytes()
            .windows(3)
            .any(|s| s[0].is_ascii_alphabetic() && s[1] == b':' && s[2] == b'\\')
}

impl CapabilityAdvisory {
    fn valid(&self) -> bool {
        text(&self.id, 128)
            && self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            && matches!(
                self.route.as_str(),
                "managed" | "accepted-external" | "existing-copy" | "user-selected"
            )
            && matches!(
                self.evidence.as_str(),
                "observed" | "upstream-reported" | "manual-requirement"
            )
            && descriptive(&self.explanation)
            && self.workaround.as_ref().is_none_or(|v| descriptive(v))
            && self.release.as_ref().is_none_or(|v| text(v, 256))
            && self.edition.as_ref().is_none_or(|v| text(v, 256))
            && self
                .artifact_sha256
                .as_ref()
                .is_none_or(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            && (self.artifact_sha256.is_none() || self.release.is_some())
            && self.observed_at > 0
            && reqwest::Url::parse(&self.provenance).is_ok_and(|u| {
                u.scheme() == "https"
                    && u.host_str().is_some()
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.query().is_none()
            })
    }
}

impl PortCapabilityReport {
    pub(super) fn add_advisories(&mut self, listing: &PortListing, status: &PortStatus) {
        let Some(value) = listing.compatibility.as_ref() else {
            return;
        };
        let size = serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len());
        if size > 65536 {
            self.advisory_state = "invalid".into();
            return;
        }
        if value
            .get("format_version")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|v| v != 1)
        {
            self.advisory_state = "unsupported-version".into();
            return;
        }
        let Ok(envelope) = serde_json::from_value::<Envelope>(value.clone()) else {
            self.advisory_state = "invalid".into();
            return;
        };
        let mut ids = std::collections::BTreeSet::new();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        if envelope.format_version != 1
            || envelope.records.len() > 64
            || envelope
                .records
                .iter()
                .any(|r| !r.valid() || r.observed_at > now || !ids.insert(r.id.clone()))
        {
            self.advisory_state = "invalid".into();
            return;
        }
        self.advisory_state = "available".into();
        // Keep the full scope with every record. Consumers must show exact-scoped records as
        // historical unless their selected route/release/artifact/edition all match.
        // No current edition/environment is inferred from a filesystem path.
        let platform = Platform::current().ok();
        let route = if status.active.is_some() {
            "managed"
        } else if status
            .external_runtime
            .as_ref()
            .is_some_and(|r| r.user_selected.is_some())
        {
            "user-selected"
        } else if status.external_runtime.is_some() {
            "accepted-external"
        } else {
            ""
        };
        // A user-selected copy has an ownership label, not an identified release/archive.
        let release = status
            .active
            .as_ref()
            .map(|r| r.version.as_str())
            .or_else(|| {
                status
                    .external_runtime
                    .as_ref()
                    .filter(|r| r.user_selected.is_none())
                    .map(|r| r.version.as_str())
            })
            .filter(|version| !version.is_empty());
        let artifact = status
            .active
            .as_ref()
            .map(|r| r.artifact.sha256.as_str())
            .or_else(|| {
                status
                    .external_runtime
                    .as_ref()
                    .filter(|r| r.user_selected.is_none())
                    .map(|r| r.archive_sha256.as_str())
            })
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
        self.advisories =
            envelope
                .records
                .into_iter()
                .map(|notice| {
                    let same_route = notice.route == route
                        || (route == "user-selected" && notice.route == "existing-copy");
                    let applicability = if platform.is_some_and(|p| p != notice.platform)
                        || (!route.is_empty() && !same_route)
                        || notice
                            .release
                            .as_ref()
                            .zip(release)
                            .is_some_and(|(expected, current)| expected != current)
                        || notice.artifact_sha256.as_ref().zip(artifact).is_some_and(
                            |(expected, current)| !expected.eq_ignore_ascii_case(current),
                        ) {
                        AdvisoryApplicability::Historical
                    } else if platform.is_none()
                        || route.is_empty()
                        || notice.edition.is_some()
                        || (notice.release.is_some() && release.is_none())
                        || (notice.artifact_sha256.is_some() && artifact.is_none_or(str::is_empty))
                    {
                        AdvisoryApplicability::ContextRequired
                    } else {
                        AdvisoryApplicability::CurrentRoute
                    };
                    PortCapabilityNotice {
                        notice,
                        applicability,
                    }
                })
                .collect();
    }
}

pub(super) fn reviewed_advisory_url(listing: &PortListing, url: &str) -> bool {
    let Some(value) = listing.compatibility.as_ref() else {
        return false;
    };
    if serde_json::to_vec(value).map_or(true, |v| v.len() > 65536) {
        return false;
    }
    let Ok(envelope) = serde_json::from_value::<Envelope>(value.clone()) else {
        return false;
    };
    let mut ids = std::collections::BTreeSet::new();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    envelope.format_version == 1
        && envelope.records.len() <= 64
        && envelope
            .records
            .iter()
            .all(|r| r.valid() && r.observed_at <= now && ids.insert(r.id.clone()))
        && envelope.records.iter().any(|r| r.provenance == url)
}
