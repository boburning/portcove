//! Shared Core query used by CLI and Desktop. Network work is limited to the
//! existing scoped provider on explicit refresh or changed accepted definition/update input.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, OnceLock};

use crate::game_recommendations::*;
use crate::host_preferences::recommendations::{
    RecommendationHistory, ReleaseObservation, ReleaseObservationPatch,
};
use crate::{
    HostPreferenceStore, Platform, PortAction, PortActionAvailability, PortDefinition, PortStatus,
    PortcoveError, PortcoveService, RecommendationCandidate, RecommendationContext,
    RecommendationOperationEligibility as Eligibility, RecommendationScope, ReleaseChannel,
    ReleaseSource, Result,
};

const MAX_ASSESSED_PORTS: usize = 64;
const MAX_MEMOIZED_ASSESSMENTS: usize = 8;
static ASSESSMENTS: OnceLock<Mutex<BTreeMap<String, crate::PortRecommendationAssessment>>> =
    OnceLock::new();

struct PreparedPort {
    listing: crate::PortListing,
    port: Option<PortDefinition>,
    status: Option<PortStatus>,
    definition_id: Option<String>,
    observation_key: Option<String>,
    pinned: Option<ComparisonRelease>,
    metadata: crate::game_recommendations::metadata::NormalizedMetadata,
}

impl PortcoveService {
    /// Discover alternatives without changing installs, selected implementations,
    /// source registrations, saves, channels or pins. Advisory observations are
    /// retained only through the existing host preference owner.
    pub async fn compare_game_ports(
        &self,
        request: &GameComparisonRequest,
        preferences: &HostPreferenceStore,
    ) -> Result<GameComparison> {
        let observed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| PortcoveError::state("clock precedes Unix epoch"))?
            .as_secs();
        self.compare_game_ports_at(request, preferences, observed_at)
            .await
    }

    // Clock injection is internal; callers can replay assessment time but cannot
    // timestamp collection or poison retained history with a future observation.
    async fn compare_game_ports_at(
        &self,
        request: &GameComparisonRequest,
        preferences: &HostPreferenceStore,
        observed_at: u64,
    ) -> Result<GameComparison> {
        let evaluated_at = request.evaluated_at.unwrap_or(observed_at);
        evaluation_time(request)?;
        if evaluated_at > observed_at {
            return Err(PortcoveError::usage(
                "comparison evaluation time is in the future",
            ));
        }
        let platform = request.platform.map_or_else(Platform::current, Ok)?;
        let environment_id = request
            .environment_id
            .clone()
            .unwrap_or_else(|| "unqualified-host".into());
        let catalog = self
            .catalog_with_registered_listings(self.catalog.clone(), &self.library.connection()?)?;
        let anchor = catalog.listing(&request.port_id)?;
        let original = original_game(&catalog, anchor);
        let game_id = original.map(|game| game.id.clone());
        let mut listings = catalog
            .listings()
            .iter()
            .filter(|listing| {
                listing.id == anchor.id
                    || game_id.as_ref().is_some_and(|id| {
                        original_game(&catalog, listing).is_some_and(|other| other.id == *id)
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        listings.sort_by(|left, right| left.id.cmp(&right.id));
        listings.dedup_by(|left, right| left.id == right.id);
        let mut limitations = Vec::new();
        let mut editions = BTreeMap::<String, ComparisonEdition>::new();
        let mut ambiguous_editions = BTreeSet::new();
        for listing in &listings {
            if let Some(game) = original_game(&catalog, listing) {
                for edition in &game.source_editions {
                    let value = ComparisonEdition {
                        id: edition.id.clone(),
                        title: edition.title.clone(),
                        system: edition.system.clone(),
                        evidence_urls: edition.evidence_urls.clone(),
                    };
                    if let Some(prior) = editions.get_mut(&edition.id) {
                        if prior.title != value.title || prior.system != value.system {
                            ambiguous_editions.insert(edition.id.clone());
                        }
                        prior.evidence_urls.extend(value.evidence_urls);
                        prior.evidence_urls.sort();
                        prior.evidence_urls.dedup();
                    } else {
                        editions.insert(edition.id.clone(), value);
                    }
                }
            }
        }
        let edition_id = request.edition_id.clone().or_else(|| {
            (editions.len() == 1)
                .then(|| editions.keys().next().cloned())
                .flatten()
        });
        if game_id.is_none() {
            limitations.push(
                "No explicit game relationship is available; the ordinary project remains visible."
                    .into(),
            );
        }
        if edition_id
            .as_ref()
            .is_none_or(|id| !editions.contains_key(id) || ambiguous_editions.contains(id))
        {
            limitations.push("Choose an unambiguous source edition before comparing quality; editions are not interchangeable.".into());
        }
        if environment_id == "unqualified-host" {
            limitations.push("This device has no selected qualification environment. Other-device gameplay observations remain historical.".into());
        }
        let mut source_profile_ids = request.source_profile_ids.clone().unwrap_or_default();
        if request.source_profile_ids.is_none() {
            match self.library.sources() {
                Ok(sources) => {
                    source_profile_ids.extend(sources.into_iter().map(|source| source.profile_id))
                }
                Err(_) => limitations.push(
                    "Selected source context could not be read; no source readiness is inferred."
                        .into(),
                ),
            }
        }
        source_profile_ids.insert("no-original-files".into());
        let library_id = self.library.identity()?;
        let (mut history, mut history_available) =
            match preferences.recommendation_history(&library_id) {
                Ok(history) => (history, true),
                Err(_) => (RecommendationHistory::default(), false),
            };
        let organization = preferences.library_organization(&library_id).ok();
        let mut prepared = Vec::new();
        let mut patches = Vec::new();
        let mut regressions = Vec::new();
        let mut corrections = Vec::new();
        for (index, listing) in listings.into_iter().enumerate() {
            let port = self.catalog.port(&listing.id).ok().cloned();
            let status = self.status(&listing.id).ok();
            let mut definition_id = None;
            let mut observation_key = None;
            let mut pinned = None;
            let metadata = port
                .as_ref()
                .map(|port| normalize(port, evaluated_at))
                .unwrap_or_else(|| {
                    crate::game_recommendations::metadata::empty(
                        RecommendationMetadataState::Missing,
                    )
                });
            regressions.extend(metadata.regressions.iter().cloned());
            corrections.extend(metadata.corrections.iter().cloned());
            if let Some(port) = port.as_ref().filter(|_| index < MAX_ASSESSED_PORTS) {
                let mut definition = serde_json::to_value(port)?;
                if let Some(presentation) = definition
                    .get_mut("presentation")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    presentation.remove("recommendation");
                }
                let definition = fingerprint(&definition)?;
                let channel = status.as_ref().map_or_else(
                    || super::super::default_channel(port),
                    |status| status.channel,
                );
                let key = ReleaseObservation::key(&port.id, platform, channel)?;
                let prior = history.releases.get(&key);
                // A stored update is an invalidation signal, not an artifact fact:
                // legacy update snapshots do not bind a platform or definition.
                let update_input = status
                    .as_ref()
                    .and_then(|status| status.last_update_check.as_ref())
                    .map(fingerprint)
                    .transpose()?;
                let definition_changed = prior.is_some_and(|old| {
                    old.attempted_definition_id
                        .as_ref()
                        .unwrap_or(&old.definition_id)
                        != &definition
                });
                let affected = definition_changed
                    || (update_input.is_some()
                        && prior.is_none_or(|old| old.update_input_id != update_input));
                pinned = pinned_release(port, channel, platform);
                if let Some(release) = pinned.as_ref() {
                    if prior.is_none_or(|old| old.last_attempt_at <= observed_at)
                        && prior.is_none_or(|old| {
                            old.definition_id != definition
                                || old.release.as_ref() != Some(release)
                                || old.failed
                        })
                    {
                        let changed = prior
                            .and_then(|old| old.release.as_ref())
                            .map(ComparisonRelease::identity)
                            .transpose()?
                            != Some(release.identity()?);
                        patches.push(ReleaseObservationPatch {
                            key: key.clone(),
                            expected: prior.cloned(),
                            observed: ReleaseObservation {
                                port_id: port.id.clone(),
                                platform,
                                channel,
                                definition_id: definition.clone(),
                                attempted_definition_id: Some(definition.clone()),
                                update_input_id: update_input.clone(),
                                release: Some(release.clone()),
                                last_success_at: None,
                                last_attempt_at: observed_at,
                                changed_at: if changed {
                                    Some(observed_at)
                                } else {
                                    prior.and_then(|old| old.changed_at)
                                },
                                failed: false,
                            },
                        });
                    }
                }
                if pinned.is_none()
                    && port.platforms.contains(&platform)
                    && port.release.provider != ReleaseSource::UserPrepared
                    && (request.refresh || affected)
                {
                    let release = self
                        .resolve_release(port, channel, platform)
                        .await
                        .map(|resolved| ComparisonRelease::from_release(&resolved.release))
                        .and_then(|release| {
                            if release.valid() {
                                Ok(release)
                            } else {
                                Err(PortcoveError::verification(
                                    "provider did not identify exact artifact bytes",
                                ))
                            }
                        });
                    let mut observed = prior.cloned().unwrap_or(ReleaseObservation {
                        port_id: port.id.clone(),
                        platform,
                        channel,
                        definition_id: definition.clone(),
                        attempted_definition_id: None,
                        update_input_id: None,
                        release: None,
                        last_success_at: None,
                        last_attempt_at: observed_at,
                        changed_at: None,
                        failed: false,
                    });
                    // A historical query cannot rewrite later observation memory.
                    if prior.is_none_or(|old| old.last_attempt_at <= observed_at) {
                        observed.last_attempt_at = observed_at;
                        observed.attempted_definition_id = Some(definition.clone());
                        observed.update_input_id = update_input;
                        match release {
                            Ok(release) => {
                                if observed
                                    .release
                                    .as_ref()
                                    .map(ComparisonRelease::identity)
                                    .transpose()?
                                    != Some(release.identity()?)
                                {
                                    observed.changed_at = Some(observed_at);
                                }
                                observed.release = Some(release);
                                observed.last_success_at = Some(observed_at);
                                observed.definition_id = definition.clone();
                                observed.failed = false;
                            }
                            Err(_) => observed.failed = true,
                        }
                        patches.push(ReleaseObservationPatch {
                            key: key.clone(),
                            expected: prior.cloned(),
                            observed,
                        });
                    }
                }
                definition_id = Some(definition);
                observation_key = Some(key);
            }
            prepared.push(PreparedPort {
                listing,
                port,
                status,
                definition_id,
                observation_key,
                pinned,
                metadata,
            });
        }
        if prepared.len() > MAX_ASSESSED_PORTS {
            limitations.push("This comparison exceeds the bounded assessment inventory; every alternative remains listed, but no default is selected.".into());
        }
        if history_available
            && (!patches.is_empty() || !regressions.is_empty() || !corrections.is_empty())
        {
            match preferences.retain_recommendation_observations(
                &library_id,
                patches,
                &regressions,
                &corrections,
            ) {
                Ok(current) => history = current,
                Err(_) => history_available = false,
            }
        }
        if !history_available {
            limitations.push("Retained recommendation history is unavailable or full. Recommendations are withheld; ordinary operations are unchanged.".into());
        }
        let mut rows = Vec::new();
        let mut candidates = Vec::new();
        let assessment_incomplete = prepared.len() > MAX_ASSESSED_PORTS;
        for (index, prepared) in prepared.into_iter().enumerate() {
            let current_game = original_game(&catalog, &prepared.listing);
            let edition_ids: Vec<String> = current_game
                .map(|game| {
                    game.source_editions
                        .iter()
                        .map(|edition| edition.id.clone())
                        .collect()
                })
                .unwrap_or_default();
            let observation = prepared
                .observation_key
                .as_ref()
                .and_then(|key| history.releases.get(key));
            let (offered, freshness) =
                offered_release(&prepared, observation, platform, evaluated_at);
            let mut operation = operation_eligibility(&prepared, offered.as_ref(), platform);
            let mut row_limits = Vec::new();
            if matches!(
                freshness.state,
                ComparisonReleaseState::CollectionFailed
                    | ComparisonReleaseState::DefinitionChanged
            ) {
                row_limits.push("Retained release information is not a successful current check; it cannot justify a new default.".into());
            }
            if prepared.metadata.state != RecommendationMetadataState::Available {
                row_limits.push("No usable optional quality observations are available. Catalog inclusion and successful setup are not gameplay qualification.".into());
            }
            let followed = organization
                .as_ref()
                .is_some_and(|record| record.followed_port_ids.contains(&prepared.listing.id));
            let notice = organization
                .as_ref()
                .filter(|_| followed)
                .and_then(|record| {
                    let release = offered.as_ref()?;
                    let identity = release.identity().ok()?;
                    let observed_at = freshness.offered_identity_changed_at?;
                    let choice = record.update_notices.get(&prepared.listing.id);
                    if choice.is_some_and(|choice| {
                        choice.paused
                            || choice.skipped_release.as_ref().is_some_and(|skip| {
                                skip.version == release.version
                                    && skip.artifact_sha256 == release.artifact_sha256
                            })
                    }) || record
                        .followed_release_acknowledgments
                        .get(&prepared.listing.id)
                        .is_some_and(|seen| seen.contains(&identity))
                    {
                        return None;
                    }
                    Some(ComparisonUpdateNotice {
                        identity,
                        version: release.version.clone(),
                        artifact_sha256: release.artifact_sha256.clone(),
                        observed_at,
                    })
                });
            let source_health = prepared
                .status
                .as_ref()
                .and_then(|status| status.readiness.as_ref())
                .and_then(|readiness| readiness.source);
            let installed = prepared
                .status
                .as_ref()
                .is_some_and(|status| status.active.is_some() || status.external_runtime.is_some());
            let launch_ready = prepared
                .status
                .as_ref()
                .and_then(|status| status.readiness.as_ref())
                .is_some_and(|readiness| readiness.launchable);
            let source_profiles = prepared
                .port
                .as_ref()
                .map(|port| {
                    [
                        port.source_profile.clone(),
                        port.bios_source_profile.clone(),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if let (Some(game_id), Some(edition_id), Some(port), Some(release)) = (
                game_id.as_ref(),
                edition_id.as_ref(),
                prepared.port.as_ref(),
                offered.as_ref(),
            ) && index < MAX_ASSESSED_PORTS
                && editions.contains_key(edition_id)
                && !ambiguous_editions.contains(edition_id)
            {
                // A candidate from another edition remains visible, but never inherits
                // this edition's evidence or becomes an interchangeable recommendation.
                let candidate_edition = if edition_ids.contains(edition_id) {
                    edition_id.clone()
                } else {
                    edition_ids
                        .first()
                        .cloned()
                        .unwrap_or_else(|| "unknown-edition".into())
                };
                let scope = RecommendationScope {
                    game_id: game_id.clone(),
                    edition_id: candidate_edition,
                    port_id: port.id.clone(),
                    release_id: release_id(release),
                    artifact_id: format!("sha256:{}", release.artifact_sha256),
                    platform,
                    environment_id: environment_id.clone(),
                    source_profile_id: port
                        .source_profile
                        .clone()
                        .unwrap_or_else(|| "no-original-files".into()),
                    route_id: route_id(port),
                };
                let assessment_operation = if !history_available
                    || assessment_incomplete
                    || matches!(
                        prepared.metadata.state,
                        RecommendationMetadataState::Invalid
                            | RecommendationMetadataState::UnsupportedVersion
                    )
                    || matches!(
                        freshness.state,
                        ComparisonReleaseState::CollectionFailed
                            | ComparisonReleaseState::DefinitionChanged
                    ) {
                    Eligibility::Unknown { reason: "Optional recommendation evidence or current observation is unavailable; existing operation guards are unchanged.".into() }
                } else {
                    operation.clone()
                };
                candidates.push(RecommendationCandidate {
                    capabilities: capability_states(
                        &prepared.metadata.capabilities,
                        &scope,
                        evaluated_at,
                    ),
                    scope,
                    operation_eligibility: assessment_operation,
                    evidence: prepared.metadata.evidence,
                });
            }
            if prepared.port.is_none() {
                operation = Eligibility::Unknown {
                    reason: "Descriptive listing only; no managed operation is implied.".into(),
                };
            }
            rows.push(ComparisonPort {
                port_id: prepared.listing.id,
                name: prepared.listing.name,
                project_url: prepared.listing.project_url,
                edition_ids,
                declared_platforms: prepared.listing.platforms,
                source_profile_ids: source_profiles,
                metadata: prepared.metadata.state,
                offered_identity: offered
                    .as_ref()
                    .map(ComparisonRelease::identity)
                    .transpose()?,
                offered_release: offered,
                freshness,
                operation,
                source_health,
                installed,
                launch_ready,
                followed,
                update_notice: notice,
                limitations: row_limits,
            });
        }
        let input_id = fingerprint(&(
            crate::PORT_RECOMMENDATION_POLICY,
            &game_id,
            &edition_id,
            platform,
            &environment_id,
            &source_profile_ids,
            &request.required_capabilities,
            evaluated_at,
            &candidates,
            &history.regressions,
            &history.corrections,
            &rows,
            history_available,
        ))?;
        let assessment =
            if let (Some(game), Some(edition)) = (game_id.as_ref(), edition_id.as_ref()) {
                let input = crate::PortRecommendationInput {
                    policy_version: crate::PORT_RECOMMENDATION_POLICY.into(),
                    evidence_snapshot_id: input_id.clone(),
                    evaluated_at,
                    context: RecommendationContext {
                        game_id: game.clone(),
                        edition_id: edition.clone(),
                        platform,
                        environment_id: environment_id.clone(),
                        available_source_profiles: source_profile_ids.clone(),
                        required_capabilities: request.required_capabilities.clone(),
                    },
                    candidates,
                    retained_regressions: history.regressions,
                    observed_regressions: regressions,
                    verified_corrections: history.corrections,
                };
                memoized(&input).ok()
            } else {
                None
            };
        Ok(GameComparison {
            format_version: 1,
            policy_version: crate::PORT_RECOMMENDATION_POLICY.into(),
            game_id,
            edition_id,
            editions: editions.into_values().collect(),
            platform,
            environment_id,
            source_profile_ids,
            source_context_is_hypothetical: request.source_profile_ids.is_some(),
            required_capabilities: request.required_capabilities.clone(),
            evaluated_at,
            input_id,
            assessment,
            ports: rows,
            limitations,
        })
    }
}

fn original_game<'a>(
    catalog: &'a crate::Catalog,
    listing: &'a crate::PortListing,
) -> Option<&'a crate::OriginalGameIdentity> {
    catalog
        .port(&listing.id)
        .ok()
        .and_then(|port| port.presentation.as_ref())
        .and_then(|presentation| presentation.original_game.as_ref())
        .or(listing.original_game.as_ref())
}

fn pinned_release(
    port: &PortDefinition,
    channel: ReleaseChannel,
    platform: Platform,
) -> Option<ComparisonRelease> {
    let release = if port.release.provider == ReleaseSource::DirectManifest {
        crate::providers::resolve_direct(port, channel, platform)
            .ok()
            .map(|release| ComparisonRelease::from_release(&release))
    } else if port.release.provider == ReleaseSource::UserPrepared
        && port.channels.contains(&channel)
    {
        port.release
            .user_prepared
            .get(&platform)
            .map(|runtime| ComparisonRelease {
                version: runtime.version.clone(),
                channel,
                asset_name: runtime.archive_name.clone(),
                artifact_sha256: runtime.archive_sha256.clone(),
                size: runtime.archive_size,
                published_at: None,
            })
    } else {
        None
    };
    release.filter(ComparisonRelease::valid)
}

fn offered_release(
    prepared: &PreparedPort,
    observation: Option<&ReleaseObservation>,
    platform: Platform,
    at: u64,
) -> (Option<ComparisonRelease>, ComparisonFreshness) {
    let mut freshness = ComparisonFreshness {
        state: ComparisonReleaseState::Unobserved,
        last_successful_resolution_at: None,
        last_attempt_at: None,
        offered_identity_changed_at: None,
    };
    if let Some(release) = &prepared.pinned {
        freshness.state = ComparisonReleaseState::CatalogPinned;
        if let Some(observed) = observation.filter(|observed| {
            observed.last_attempt_at <= at
                && observed.release.as_ref() == Some(release)
                && prepared.definition_id.as_ref() == Some(&observed.definition_id)
        }) {
            freshness.last_attempt_at = Some(observed.last_attempt_at);
            freshness.offered_identity_changed_at = observed.changed_at;
        }
        // Catalog pins are declarations, not an invented successful upstream check.
        return (Some(release.clone()), freshness);
    }
    if prepared
        .port
        .as_ref()
        .is_some_and(|port| !port.platforms.contains(&platform))
    {
        freshness.state = ComparisonReleaseState::NotOffered;
        return (None, freshness);
    }
    let Some(observed) = observation.filter(|observed| observed.last_attempt_at <= at) else {
        return (None, freshness);
    };
    freshness.last_attempt_at = Some(observed.last_attempt_at);
    freshness.last_successful_resolution_at = observed.last_success_at;
    freshness.offered_identity_changed_at = observed.changed_at;
    freshness.state = if prepared.definition_id.as_ref() != Some(&observed.definition_id) {
        ComparisonReleaseState::DefinitionChanged
    } else if observed.failed {
        ComparisonReleaseState::CollectionFailed
    } else {
        ComparisonReleaseState::ProviderResolved
    };
    (observed.release.clone(), freshness)
}

fn operation_eligibility(
    prepared: &PreparedPort,
    offered: Option<&ComparisonRelease>,
    platform: Platform,
) -> Eligibility {
    if Platform::current().ok() != Some(platform) {
        return Eligibility::Unknown {
            reason: "Another platform's operation readiness has not been assessed on this host."
                .into(),
        };
    }
    let Some(status) = prepared.status.as_ref() else {
        return Eligibility::Unknown {
            reason: "Existing Core operation assessment is unavailable.".into(),
        };
    };
    let installed_offered = offered.is_some_and(|release| {
        status.active.as_ref().is_some_and(|install| {
            install.artifact.sha256 == release.artifact_sha256
                && install.version == release.version
                && install.channel == release.channel
        }) || status.external_runtime.as_ref().is_some_and(|install| {
            install.archive_sha256 == release.artifact_sha256
                && install.version == release.version
                && install.platform == platform
        })
    });
    let action = if installed_offered {
        PortAction::Launch
    } else if prepared
        .port
        .as_ref()
        .is_some_and(|port| port.release.provider == ReleaseSource::UserPrepared)
    {
        PortAction::RegisterExternal
    } else if status.active.is_some() {
        PortAction::Update
    } else {
        PortAction::Install
    };
    match status
        .port_actions
        .iter()
        .find(|assessment| assessment.action == action)
    {
        Some(assessment) if assessment.availability == PortActionAvailability::Allowed => {
            Eligibility::Allowed
        }
        Some(assessment)
            if matches!(
                assessment.availability,
                PortActionAvailability::Held | PortActionAvailability::NotOffered
            ) =>
        {
            Eligibility::Held {
                reason: format!(
                    "Existing Core {:?} assessment: {:?}.",
                    action, assessment.reason
                ),
            }
        }
        Some(assessment) => Eligibility::Unknown {
            reason: format!(
                "Existing Core {:?} assessment: {:?}.",
                action, assessment.reason
            ),
        },
        None => Eligibility::Unknown {
            reason: "No current operation assessment is available for this route.".into(),
        },
    }
}

fn memoized(input: &crate::PortRecommendationInput) -> Result<crate::PortRecommendationAssessment> {
    let id = fingerprint(input)?;
    let cache = ASSESSMENTS.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Ok(entries) = cache.lock()
        && let Some(result) = entries.get(&id)
    {
        return Ok(result.clone());
    }
    let result = crate::assess_port_recommendations(input)?;
    if let Ok(mut entries) = cache.lock() {
        if entries.len() >= MAX_MEMOIZED_ASSESSMENTS {
            entries.pop_first();
        }
        entries.insert(id, result.clone());
    }
    Ok(result)
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
