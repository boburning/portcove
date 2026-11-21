//! Normal client setup for the separately appointed compiled catalog source.
//! Network locations never supply an anchor, policy or publisher authority.

use std::time::Duration;

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
const SCHEDULED_LISTING_TIMEOUT: Duration = Duration::from_secs(25);

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

/// Installs this release's compiled anchor under the plan Core itself has just
/// reviewed, so official catalog updates are on by default (owner decision on
/// #534, 2026-11-15). The existing provisioning transaction rechecks that exact
/// plan; an installed, different or advanced authority is never replaced.
fn ensure_enabled(
    library: &Library,
    root: &[u8],
    source: &[u8],
    profile: InitialRootProfile,
) -> Result<()> {
    let authority = review(library, root, profile)?;
    if !project_review(authority.clone(), source)?.configured {
        return Err(PortcoveError::unsupported(
            "this release has no configured official catalog",
        ));
    }
    if authority.installed {
        return Ok(());
    }
    match apply(library, root, &authority.expected_plan, profile) {
        Ok(_) => Ok(()),
        // A concurrent caller installed the same compiled anchor first.
        Err(error)
            if error.code == crate::ErrorCode::Conflict
                && review(library, root, profile)?.installed =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// One official catalog refresh at a time in this process: a scheduled refresh
/// skips while another runs, and a player's refresh waits for it.
static REFRESH_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OfficialCatalogAutomaticOutcome {
    /// The player turned automatic updates off; nothing was contacted or changed.
    TurnedOff,
    /// This build appoints no official catalog.
    NotConfigured,
    /// Another official catalog refresh is still running; this one was skipped.
    AlreadyRunning,
    /// The location served nothing that verified; nothing changed.
    Unavailable,
    /// The authenticated refresh verified listings or a known definition.
    Refreshed,
}

/// The result of one scheduled official catalog refresh.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct OfficialCatalogAutomaticRefresh {
    pub outcome: OfficialCatalogAutomaticOutcome,
    /// What the location served, when `outcome` is `unavailable`.
    pub serving: Option<DefinitionDeliveryServing>,
    /// The selected descriptive directory, if present when the refresh completed.
    pub status: Option<crate::ListingDeliveryStatus>,
}

impl OfficialCatalogAutomaticRefresh {
    fn skipped(outcome: OfficialCatalogAutomaticOutcome) -> Self {
        Self {
            outcome,
            serving: None,
            status: None,
        }
    }
}

async fn refresh_automatically<T, F>(
    service: &PortcoveService,
    preferences: &crate::HostPreferenceStore,
    root: &[u8],
    source: &[u8],
    profile: InitialRootProfile,
    connect: F,
    emit: impl FnMut(crate::OperationEvent),
) -> Result<OfficialCatalogAutomaticRefresh>
where
    T: tough::Transport + Send + Sync + 'static,
    F: Fn() -> Result<(DefinitionRepositorySource, T)>,
{
    use OfficialCatalogAutomaticOutcome::*;
    if !preferences.official_catalog_automatic_updates()? {
        return Ok(OfficialCatalogAutomaticRefresh::skipped(TurnedOff));
    }
    if !review_setup(service.library(), root, source, profile)?.configured {
        return Ok(OfficialCatalogAutomaticRefresh::skipped(NotConfigured));
    }
    let Ok(_guard) = REFRESH_GUARD.try_lock() else {
        return Ok(OfficialCatalogAutomaticRefresh::skipped(AlreadyRunning));
    };
    ensure_enabled(service.library(), root, source, profile)?;
    super::require_installed(service.library(), root, profile)?;
    // Both operations read the same authenticated repository snapshot, and
    // retain their existing independent admission and replay checks.
    let (source, transport) = connect()?;
    let deadline = tokio::time::Instant::now() + super::super::super::ACQUISITION_TIMEOUT;
    let repository = tokio::time::timeout_at(
        deadline,
        super::super::super::load_repository(
            root,
            source.metadata_base_url,
            source.targets_base_url,
            transport,
        ),
    )
    .await
    .unwrap_or_else(|_| {
        Err(PortcoveError::network(
            "official catalog acquisition timed out",
        ))
    });
    let repository = match repository {
        Ok(repository) => repository,
        Err(error) => return Ok(unavailable(&error)),
    };
    let listings = tokio::time::timeout_at(
        deadline.min(tokio::time::Instant::now() + SCHEDULED_LISTING_TIMEOUT),
        super::super::listing_delivery::acquire_admissible(service.library(), &repository, root),
    )
    .await
    .unwrap_or_else(|_| {
        Err(PortcoveError::network(
            "listing refresh acquisition timed out",
        ))
    });
    let mut emit = emit;
    // Check definition identities against the effective catalog after this
    // accepted descriptive delivery. New listings can become known now.
    let (status, listing_failure) = match listings {
        Ok(candidate) => (
            Some(super::super::listing_delivery::publish_acquired(
                service, candidate, &mut emit,
            )?),
            None,
        ),
        Err(error) => (None, Some(error)),
    };
    let definitions_verified_or_updated =
        match super::super::refresh::refresh_known_official_definitions(
            service,
            &repository,
            root,
            deadline,
            &mut emit,
        )
        .await
        {
            Ok(changed) => changed,
            Err(error) => {
                tracing::info!(error = %error.message, "scheduled official definitions are unavailable");
                false
            }
        };
    if status.is_none()
        && !definitions_verified_or_updated
        && let Some(error) = listing_failure
    {
        return Ok(unavailable(&error));
    }
    Ok(OfficialCatalogAutomaticRefresh {
        outcome: Refreshed,
        serving: None,
        status: status.or_else(|| service.library().listing_delivery_status().ok()),
    })
}

fn unavailable(error: &PortcoveError) -> OfficialCatalogAutomaticRefresh {
    let serving = delivery_serving(error);
    tracing::info!(
        serving = serving.as_str(),
        error = %error.message,
        "automatic official catalog refresh found no verified update"
    );
    OfficialCatalogAutomaticRefresh {
        outcome: OfficialCatalogAutomaticOutcome::Unavailable,
        serving: Some(serving),
        status: None,
    }
}

impl PortcoveService {
    /// Refresh using only the separately appointed compiled source. Official
    /// updates are on by default, so this installs the compiled anchor when the
    /// library has none; the existing refresh path then authenticates TUF.
    pub async fn refresh_official_catalog(
        &self,
        emit: impl FnMut(crate::OperationEvent),
    ) -> Result<crate::ListingDeliveryStatus> {
        let source = official_repository_source()?;
        ensure_enabled(
            self.library(),
            COMPILED_ROOT,
            COMPILED_SOURCE,
            compiled_profile()?,
        )?;
        let _guard = REFRESH_GUARD.lock().await;
        self.refresh_listings(&source, emit).await
    }

    /// The scheduled refresh: skipped without I/O while the player has turned
    /// automatic updates off, and quiet when the location serves nothing that
    /// verifies. Prior state is kept on every failure.
    pub async fn refresh_official_catalog_automatically(
        &self,
        preferences: &crate::HostPreferenceStore,
        emit: impl FnMut(crate::OperationEvent),
    ) -> Result<OfficialCatalogAutomaticRefresh> {
        refresh_automatically(
            self,
            preferences,
            COMPILED_ROOT,
            COMPILED_SOURCE,
            compiled_profile()?,
            || {
                let source = official_repository_source()?;
                let transport =
                    crate::definition_repository::DefinitionHttpsTransport::new(&source)?;
                Ok((source, transport))
            },
            emit,
        )
        .await
    }

    /// Check this known port's definition using the appointed fixed source.
    /// The existing refresh owns authority, policy, eligibility and atomic selection;
    /// this does not install a game or change runtime ownership. Like the catalog
    /// refresh, it installs the compiled anchor when the library has none.
    pub async fn refresh_official_definition(
        &self,
        port_id: &str,
        emit: impl FnMut(crate::OperationEvent),
    ) -> Result<crate::DefinitionRefresh> {
        let stable_id = official_definition_id(self.catalog(), port_id)?;
        let source = official_repository_source()?;
        ensure_enabled(
            self.library(),
            COMPILED_ROOT,
            COMPILED_SOURCE,
            compiled_profile()?,
        )?;
        self.refresh_definition(&source, stable_id, emit).await
    }
}

#[cfg(test)]
pub(crate) async fn automatic_refresh_fixture<T>(
    service: &PortcoveService,
    preferences: &crate::HostPreferenceStore,
    root: &[u8],
    source: &[u8],
    repository: &DefinitionRepositorySource,
    transport: T,
) -> Result<OfficialCatalogAutomaticRefresh>
where
    T: tough::Transport + Clone + Send + Sync + 'static,
{
    refresh_automatically(
        service,
        preferences,
        root,
        source,
        InitialRootProfile::SingleOwnerOneOfOneV1,
        || Ok((repository.clone(), transport.clone())),
        |_| {},
    )
    .await
}

#[cfg(test)]
pub(crate) async fn serialize_automatic_refresh_fixtures() -> tokio::sync::MutexGuard<'static, ()> {
    static FIXTURES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    FIXTURES.lock().await
}

#[cfg(test)]
pub(crate) async fn hold_refresh_guard_fixture() -> tokio::sync::MutexGuard<'static, ()> {
    REFRESH_GUARD.lock().await
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
    /// The appointed location serves no metadata: its timestamp is absent (HTTP 404 or 410).
    NotServed,
    /// Metadata is served, but a file it requires is absent: a partial publication.
    Incomplete,
    /// The location could not be reached, refused access (HTTP 403) or did not answer completely.
    Unreachable,
    /// Signed metadata was served but has expired.
    Expired,
    /// Something was served but did not authenticate.
    VerificationFailed,
    /// This build appoints no official catalog location.
    NotConfigured,
}

impl DefinitionDeliveryServing {
    /// The machine name, as serialized.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::NotServed => "not_served",
            Self::Incomplete => "incomplete",
            Self::Unreachable => "unreachable",
            Self::Expired => "expired",
            Self::VerificationFailed => "verification_failed",
            Self::NotConfigured => "not_configured",
        }
    }
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
            // Only a build without an appointed location is "not configured"; an
            // invalid compiled location is a failure, never hidden as absent.
            if configured.is_some() || error.code != crate::ErrorCode::Unsupported {
                report.serving = DefinitionDeliveryServing::VerificationFailed;
            }
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
            report.serving = delivery_serving(&error);
            report.reason = Some(error.message);
        }
    }
    report
}

/// The serving status of a failed client acquisition.
pub(crate) fn delivery_serving(error: &PortcoveError) -> DefinitionDeliveryServing {
    match (
        error.code,
        error.details.get("delivery").map(String::as_str),
    ) {
        (_, Some("expired")) => DefinitionDeliveryServing::Expired,
        (crate::ErrorCode::Network, Some("not_served")) => DefinitionDeliveryServing::NotServed,
        (crate::ErrorCode::Network, Some("incomplete")) => DefinitionDeliveryServing::Incomplete,
        (crate::ErrorCode::Network, _) => DefinitionDeliveryServing::Unreachable,
        _ => DefinitionDeliveryServing::VerificationFailed,
    }
}
