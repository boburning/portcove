//! Runtime consumers of an independently admitted managed GitHub scope.
//! Scope values cannot be constructed or deserialized by an external caller.

use crate::{AdapterKind, PortDefinition, PortcoveError, ReleaseSource, ResolvedRelease, Result};

pub(crate) const MANAGED_GRANT_PREFIX: &str = "managed-github-v1-";
pub(crate) const MANAGED_OPERATIONS: [&str; 4] = ["install", "update", "prepare", "launch"];

pub(crate) fn restricted_grant(grant_id: &str) -> bool {
    grant_id.starts_with(MANAGED_GRANT_PREFIX)
}

pub(crate) fn refuse_restricted_portability(grant_id: &str) -> Result<()> {
    if restricted_grant(grant_id) {
        return Err(PortcoveError::unsupported(
            "managed GitHub grant portability is not qualified; keep the original library",
        ));
    }
    Ok(())
}

pub(crate) fn refuse_restricted_adoption(catalog: &crate::Catalog, port_id: &str) -> Result<()> {
    if catalog
        .definition_selection(port_id)
        .is_some_and(|identity| restricted_grant(&identity.grant_id))
    {
        return Err(PortcoveError::unsupported(
            "managed GitHub acquisition does not authorize adoption",
        ));
    }
    Ok(())
}

/// Opaque scope from the library's independently admitted publisher policy.
/// It is neither a trust-root provisioner nor an external client capability.
#[derive(Debug, Clone)]
pub struct DefinitionAcquisitionScope {
    pub(crate) library: crate::Library,
    pub(crate) identity: Option<crate::DefinitionSelectionIdentity>,
    pub(crate) policy_sha256: String,
    pub(crate) anchor_sha256: String,
    pub(crate) port_sha256: String,
    pub(crate) stable_id: String,
    pub(crate) repository: String,
    pub(crate) repository_id: u64,
    pub(crate) artifact_hosts: Vec<String>,
    pub(crate) max_redirects: u32,
    pub(crate) grant_id: String,
    pub(crate) policy_revision: u64,
    #[cfg(any(test, feature = "qualification-fixtures"))]
    pub(crate) fixture_origin: Option<String>,
}

impl DefinitionAcquisitionScope {
    pub(crate) fn port_digest(port: &PortDefinition) -> Result<String> {
        use sha2::{Digest, Sha256};
        Ok(hex::encode(Sha256::digest(serde_json::to_vec(port)?)))
    }

    pub(crate) fn require_current(&self) -> Result<()> {
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| PortcoveError::state("acquisition scope has no admitted definition"))?;
        crate::definition_repository::publisher_policy::validate_current_acquisition(self)?;
        let eligibility = self.library.assess_definition_operation(
            identity,
            crate::definition_eligibility::DefinitionOperationContext::observed(
                crate::DefinitionOperation::Install,
                false,
                true,
            ),
        )?;
        if eligibility.outcome != crate::DefinitionEligibilityOutcome::Eligible {
            return Err(PortcoveError::conflict(
                "definition is no longer eligible for acquisition",
            ));
        }
        Ok(())
    }

    pub(crate) fn same_authorization(&self, other: &Self) -> bool {
        self.library.root() == other.library.root()
            && self.identity == other.identity
            && self.policy_sha256 == other.policy_sha256
            && self.anchor_sha256 == other.anchor_sha256
            && self.port_sha256 == other.port_sha256
            && self.repository_id == other.repository_id
            && self.repository == other.repository
            && self.artifact_hosts == other.artifact_hosts
            && self.max_redirects == other.max_redirects
            && self.grant_id == other.grant_id
            && self.policy_revision == other.policy_revision
    }
    pub(crate) fn validate_parameters(
        repository_id: u64,
        hosts: &[String],
        max_redirects: u32,
        operations: &[String],
    ) -> Result<()> {
        let valid_host = |host: &str| {
            host.len() <= 253
                && host.contains('.')
                && host.parse::<std::net::IpAddr>().is_err()
                && host.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                        })
                })
        };
        let mut unique = std::collections::BTreeSet::new();
        let supported_operations = operations.len() == MANAGED_OPERATIONS.len()
            && MANAGED_OPERATIONS.iter().all(|expected| {
                operations
                    .iter()
                    .filter(|actual| actual.as_str() == *expected)
                    .count()
                    == 1
            });
        if repository_id == 0
            || hosts.is_empty()
            || hosts.len() > 8
            || hosts
                .iter()
                .any(|host| !valid_host(host) || !unique.insert(host))
            || max_redirects > 5
            || !supported_operations
        {
            return Err(PortcoveError::unsupported(
                "unsupported managed GitHub acquisition scope",
            ));
        }
        Ok(())
    }

    pub(crate) fn validate_port(port: &PortDefinition) -> Result<()> {
        crate::curated_acquisition::require_runtime_authority(port)?;
        let segments = port.release.repository.split('/').collect::<Vec<_>>();
        let repository_valid = segments.len() == 2
            && port.release.repository.len() <= 255
            && segments.iter().all(|segment| {
                !segment.is_empty()
                    && !matches!(*segment, "." | "..")
                    && segment.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
            });
        if port.release.provider != ReleaseSource::Github
            || !repository_valid
            || !port.bundled_runtime.is_empty()
            || !matches!(
                port.adapter,
                AdapterKind::LibultrashipPortable
                    | AdapterKind::N64RecompPortable
                    | AdapterKind::StagedSourcePortable
                    | AdapterKind::ReferencedDisc
            )
        {
            return Err(PortcoveError::unsupported(
                "managed GitHub scope does not authorize auxiliary runtime or toolchain acquisition",
            ));
        }
        Ok(())
    }

    pub(crate) fn require_port(&self, port: &PortDefinition) -> Result<()> {
        Self::validate_port(port)?;
        if self.stable_id != port.id
            || self.repository != port.release.repository
            || self.port_sha256 != Self::port_digest(port)?
        {
            return Err(PortcoveError::verification(
                "acquisition scope belongs to another definition",
            ));
        }
        Ok(())
    }

    pub(crate) fn require_url(&self, url: &reqwest::Url) -> Result<()> {
        #[cfg(any(test, feature = "qualification-fixtures"))]
        if let Some(origin) = &self.fixture_origin {
            validate_fixture_origin(origin)?;
            if url.as_str().len() <= 4096
                && url.origin().ascii_serialization() == *origin
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
            {
                return Ok(());
            }
            return Err(PortcoveError::verification(
                "artifact URL is outside the bound qualification origin",
            ));
        }
        if url.as_str().len() > 4096
            || url.scheme() != "https"
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !url
                .host_str()
                .is_some_and(|host| self.artifact_hosts.iter().any(|allowed| allowed == host))
        {
            return Err(PortcoveError::verification(
                "artifact URL is outside the admitted HTTPS scope",
            ));
        }
        Ok(())
    }

    pub(crate) fn require_asset_url(&self, value: &str) -> Result<()> {
        let url = reqwest::Url::parse(value)
            .map_err(|_| PortcoveError::verification("invalid scoped artifact URL"))?;
        self.require_url(&url)
    }

    pub(crate) fn redirect_policy(&self) -> reqwest::redirect::Policy {
        let scope = self.clone();
        reqwest::redirect::Policy::custom(move |attempt| {
            if let Err(error) = scope.require_current() {
                return attempt.error(error.message);
            }
            if let Err(error) = scope.require_url(attempt.url()) {
                return attempt.error(error.message);
            }
            if attempt.previous().len() > scope.max_redirects as usize {
                return attempt.error("admitted artifact redirect limit exceeded");
            }
            attempt.follow()
        })
    }
}

/// Exact resolved bytes and their opaque acquisition provenance. The serialized
/// release client contract stays unchanged; installation retains this proof internally.
#[derive(Debug, Clone)]
pub struct ScopedResolvedRelease {
    pub(crate) release: ResolvedRelease,
    pub(crate) scope: Option<DefinitionAcquisitionScope>,
}

impl ScopedResolvedRelease {
    pub(crate) fn legacy(release: ResolvedRelease) -> Self {
        Self {
            release,
            scope: None,
        }
    }

    pub(crate) fn managed(
        release: ResolvedRelease,
        scope: DefinitionAcquisitionScope,
    ) -> Result<Self> {
        scope.require_current()?;
        scope.require_asset_url(&release.asset.url)?;
        Ok(Self {
            release,
            scope: Some(scope),
        })
    }
}

#[cfg(test)]
#[path = "definition_acquisition_tests.rs"]
mod tests;

/// Qualification routes accept a canonical literal loopback HTTP origin only.
#[cfg(any(test, feature = "qualification-fixtures"))]
pub(crate) fn validate_fixture_origin(origin: &str) -> Result<()> {
    let url = reqwest::Url::parse(origin)
        .map_err(|_| PortcoveError::verification("invalid qualification origin"))?;
    let loopback = url.host_str().is_some_and(|host| {
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
    });
    if origin.len() > 256
        || url.scheme() != "http"
        || !loopback
        || url.port().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.origin().ascii_serialization() != origin
    {
        return Err(PortcoveError::verification(
            "qualification origin must be a canonical literal loopback HTTP origin",
        ));
    }
    Ok(())
}
