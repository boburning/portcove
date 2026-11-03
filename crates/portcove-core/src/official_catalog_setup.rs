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
        let source = configured_source(COMPILED_SOURCE)?.ok_or_else(|| {
            PortcoveError::unsupported("this release has no configured official catalog")
        })?;
        let source =
            DefinitionRepositorySource::new(&source.metadata_base_url, &source.targets_base_url)?;
        self.refresh_listings(&source, emit).await
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
