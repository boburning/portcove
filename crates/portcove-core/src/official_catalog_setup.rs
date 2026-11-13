//! Normal client setup for the separately appointed compiled catalog source.
//! Network locations never supply an anchor, policy or publisher authority.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{DefinitionRepositorySource, Library, PortcoveError, PortcoveService, Result};

use super::{
    COMPILED_ROOT, DefinitionAuthorityReview, InitialRootProfile, apply, compiled_profile,
    configured_root, review, review_from,
};

const COMPILED_SOURCE: &[u8] = include_bytes!("../catalog/official-definition-source.json");
const MAX_SOURCE_BYTES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OfficialCatalogSource {
    pub metadata_base_url: String,
    pub targets_base_url: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct OfficialCatalogReview {
    pub configured: bool,
    pub enabled: bool,
    pub source: Option<OfficialCatalogSource>,
    pub expected_plan: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct OfficialCatalogSetup {
    pub changed: bool,
    pub review: OfficialCatalogReview,
}

fn configured_source(bytes: &[u8]) -> Result<Option<OfficialCatalogSource>> {
    if bytes.is_empty() || bytes.len() > MAX_SOURCE_BYTES {
        return Err(PortcoveError::state(
            "compiled catalog source exceeds its bound",
        ));
    }
    let source: Option<OfficialCatalogSource> = serde_json::from_slice(bytes)?;
    source
        .map(|source| {
            let checked = DefinitionRepositorySource::new(
                &source.metadata_base_url,
                &source.targets_base_url,
            )?;
            Ok(OfficialCatalogSource {
                metadata_base_url: checked.metadata_base_url().to_owned(),
                targets_base_url: checked.targets_base_url().to_owned(),
            })
        })
        .transpose()
}

fn official_repository_source() -> Result<DefinitionRepositorySource> {
    let source = configured_source(COMPILED_SOURCE)?.ok_or_else(|| {
        PortcoveError::unsupported("this release has no configured official catalog")
    })?;
    DefinitionRepositorySource::new(&source.metadata_base_url, &source.targets_base_url)
}

pub(crate) fn official_definition_id<'a>(
    catalog: &'a crate::Catalog,
    port_id: &'a str,
) -> Result<&'a str> {
    if let Some(selection) = catalog.definition_selection(port_id) {
        if selection.namespace != "official" {
            return Err(PortcoveError::unsupported(
                "this definition does not belong to the official catalog",
            ));
        }
        return Ok(&selection.stable_id);
    }
    // A descriptive entry supplies its exact publisher identity, never a guessed
    // counterpart or a qualified display ID. Do not acquire arbitrary IDs.
    if catalog.port(port_id).is_err() {
        catalog.listing(port_id)?;
    }
    Ok(port_id)
}

fn setup_plan(authority_plan: &str, source: &[u8]) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        "official-catalog-setup-v1",
        authority_plan,
        hex::encode(Sha256::digest(source)),
    ))?)))
}

fn project_review(
    authority: DefinitionAuthorityReview,
    source: &[u8],
) -> Result<OfficialCatalogReview> {
    let source_location = configured_source(source)?;
    let configured = authority.configured && source_location.is_some();
    Ok(OfficialCatalogReview {
        configured,
        enabled: configured && authority.installed,
        source: configured.then_some(source_location).flatten(),
        expected_plan: configured
            .then(|| setup_plan(&authority.expected_plan, source))
            .transpose()?,
    })
}

fn review_setup(
    library: &Library,
    root: &[u8],
    source: &[u8],
    profile: InitialRootProfile,
) -> Result<OfficialCatalogReview> {
    project_review(review(library, root, profile)?, source)
}

fn enable(
    library: &Library,
    root: &[u8],
    source: &[u8],
    profile: InitialRootProfile,
    expected: &str,
) -> Result<OfficialCatalogSetup> {
    let authority = review(library, root, profile)?;
    let current = project_review(authority.clone(), source)?;
    if !current.configured {
        return Err(PortcoveError::unsupported(
            "this release has no configured official catalog",
        ));
    }
    let authority_plan = if setup_plan(&authority.expected_plan, source)? == expected {
        authority.expected_plan
    } else if authority.installed {
        // Preserve the original transaction's exact, still-unadmitted lost-response retry.
        // The transaction below rechecks this preimage before any write.
        let parsed_root = configured_root(root, profile)?;
        let connection = library.connection()?;
        let original = review_from(library, &connection, parsed_root, true)?;
        if setup_plan(&original.expected_plan, source)? != expected {
            return Err(PortcoveError::conflict(
                "official catalog setup review is stale",
            ));
        }
        original.expected_plan
    } else {
        return Err(PortcoveError::conflict(
            "official catalog setup review is stale",
        ));
    };
    let result = apply(library, root, &authority_plan, profile)?;
    Ok(OfficialCatalogSetup {
        changed: result.changed,
        review: project_review(result.review, source)?,
    })
}

impl Library {
    /// Review the official catalog included in this release, without changing trust.
    pub fn review_official_catalog(&self) -> Result<OfficialCatalogReview> {
        review_setup(self, COMPILED_ROOT, COMPILED_SOURCE, compiled_profile()?)
    }

    /// Explicit normal-client confirmation. Root/library/history and compiled
    /// transport identity are bound to the review; no caller supplies trust bytes.
    pub fn enable_official_catalog(&self, expected_plan: &str) -> Result<OfficialCatalogSetup> {
        enable(
            self,
            COMPILED_ROOT,
            COMPILED_SOURCE,
            compiled_profile()?,
            expected_plan,
        )
    }
}

impl PortcoveService {
    /// Refresh using only the separately appointed compiled source. The existing
    /// refresh path still requires its matching installed anchor and authenticates TUF.
    pub async fn refresh_official_catalog(
        &self,
        emit: impl FnMut(crate::OperationEvent),
    ) -> Result<crate::ListingDeliveryStatus> {
        let source = official_repository_source()?;
        self.refresh_listings(&source, emit).await
    }

    /// Check this known port's definition using the appointed fixed source.
    /// The existing refresh owns authority, policy, eligibility and atomic selection;
    /// this does not install a game, provision trust or change runtime ownership.
    pub async fn refresh_official_definition(
        &self,
        port_id: &str,
        emit: impl FnMut(crate::OperationEvent),
    ) -> Result<crate::DefinitionRefresh> {
        let stable_id = official_definition_id(self.catalog(), port_id)?;
        let source = official_repository_source()?;
        if !self.library().review_official_catalog()?.enabled {
            return Err(PortcoveError::conflict(
                "Enable official catalog updates in Settings before checking setup availability.",
            ));
        }
        self.refresh_definition(&source, stable_id, emit).await
    }
}

#[cfg(test)]
pub(crate) fn review_fixture(
    library: &Library,
    root: &[u8],
    source: &[u8],
) -> Result<OfficialCatalogReview> {
    review_setup(
        library,
        root,
        source,
        InitialRootProfile::SingleOwnerOneOfOneV1,
    )
}

#[cfg(test)]
pub(crate) fn enable_fixture(
    library: &Library,
    root: &[u8],
    source: &[u8],
    expected: &str,
) -> Result<OfficialCatalogSetup> {
    enable(
        library,
        root,
        source,
        InitialRootProfile::SingleOwnerOneOfOneV1,
        expected,
    )
}

/// What the appointed official location serves, verified as a client would.
///
/// Read-only maintenance evidence (#4129): it uses only the compiled trust root
/// and the compiled locations, fetches through the client's own TUF path, and
/// writes nothing — no trust, replay floor or selection. "Not served" and an
/// outage are this request's serving status, never evidence that something
/// published earlier was withdrawn.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DefinitionDeliveryInspection {
    pub format_version: u32,
    pub scope: &'static str,
    pub metadata_base_url: Option<String>,
    pub targets_base_url: Option<String>,
    pub serving: DefinitionDeliveryServing,
    /// Why the request did not verify, when it did not.
    pub reason: Option<String>,
    /// Authenticated metadata identities; present only when verified.
    pub provenance: Option<crate::AuthenticatedDefinitionProvenance>,
    /// Every indexed definition with its exact target digest; empty unless verified.
    pub definitions: Vec<PublishedDefinition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionDeliveryServing {
    /// The appointed metadata and index verified against the compiled root.
    Verified,
    /// The appointed location serves no metadata (HTTP 403, 404 or 410).
    NotServed,
    /// The location could not be reached or did not answer completely.
    Unreachable,
    /// Signed metadata was served but has expired.
    Expired,
    /// Something was served but did not authenticate.
    VerificationFailed,
    /// This build appoints no official catalog location.
    NotConfigured,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PublishedDefinition {
    pub namespace: String,
    pub stable_id: String,
    pub revision: u64,
    pub target: String,
    pub sha256: Option<String>,
    pub length: Option<u64>,
}

pub async fn inspect_official_definition_delivery() -> DefinitionDeliveryInspection {
    let scope = "read-only client verification of the appointed official definition location against the compiled root; writes no trust, floor or selection";
    let configured = configured_source(COMPILED_SOURCE).ok().flatten();
    let mut report = DefinitionDeliveryInspection {
        format_version: 1,
        scope,
        metadata_base_url: configured
            .as_ref()
            .map(|source| source.metadata_base_url.clone()),
        targets_base_url: configured
            .as_ref()
            .map(|source| source.targets_base_url.clone()),
        serving: DefinitionDeliveryServing::NotConfigured,
        reason: None,
        provenance: None,
        definitions: Vec::new(),
    };
    let source = match official_repository_source() {
        Ok(source) => source,
        Err(error) => {
            report.reason = Some(error.message);
            return report;
        }
    };
    match crate::acquire_definition_candidate(&source, COMPILED_ROOT).await {
        Ok(candidate) => {
            report.serving = DefinitionDeliveryServing::Verified;
            report.provenance = Some(candidate.provenance().clone());
            let index = candidate.index();
            report.definitions = index
                .definitions()
                .iter()
                .map(|definition| {
                    let digest = index.content_digest(definition.target());
                    PublishedDefinition {
                        namespace: definition.namespace().to_owned(),
                        stable_id: definition.stable_id().to_owned(),
                        revision: definition.revision(),
                        target: definition.target().to_owned(),
                        sha256: digest.map(|(sha256, _)| sha256.to_owned()),
                        length: digest.map(|(_, length)| length),
                    }
                })
                .collect();
        }
        Err(error) => {
            report.serving = match (
                error.code,
                error.details.get("delivery").map(String::as_str),
            ) {
                (_, Some("expired")) => DefinitionDeliveryServing::Expired,
                (crate::ErrorCode::Network, Some("not_served")) => {
                    DefinitionDeliveryServing::NotServed
                }
                (crate::ErrorCode::Network, _) => DefinitionDeliveryServing::Unreachable,
                _ => DefinitionDeliveryServing::VerificationFailed,
            };
            report.reason = Some(error.message);
        }
    }
    report
}
