//! Pure, route-bound interpretation of previously accepted source observations.
//! Snapshot construction owns context validation; this evaluator performs no I/O.

use std::borrow::Cow;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Catalog, CatalogAdmissionMode, Platform, PortSourceRole, RegisteredSourceObservation,
    ReleaseChannel, SourceAdmission, SourceAdmissionMode, SourceClassification, SourceHealth,
    SourceIdentity, SourceInspectionReport,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameFileRouteRequest {
    pub port_id: String,
    pub platform: Platform,
    pub channel: ReleaseChannel,
    pub route: GameFileRouteKind,
}

/// Explicit refresh inputs. Inspection reports are never accepted from a client.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameFileQueryRefreshRequest {
    pub routes: Vec<GameFileRouteRequest>,
    pub limits: crate::RegisteredSourceInspectionLimits,
    pub maximum_age_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GameFileQuerySnapshot {
    pub schema_version: u32,
    pub library: crate::LibraryIdentity,
    pub catalog_binding_sha256: String,
    pub registration_sha256: String,
    pub selection_sha256: String,
    pub observed_at: i64,
    pub expires_at: i64,
    pub routes: Vec<GameFileRouteProjection>,
}

impl crate::PortcoveService {
    /// Own the cancellable refresh activity through the blocking worker's return.
    pub fn refresh_game_file_query_with_progress(
        &self,
        request: &GameFileQueryRefreshRequest,
        emit: impl FnMut(crate::OperationEvent),
    ) -> crate::Result<GameFileQuerySnapshot> {
        self.refresh_game_file_query_tracked(request, emit, || Ok(()))
    }

    fn refresh_game_file_query_tracked(
        &self,
        request: &GameFileQueryRefreshRequest,
        mut emit: impl FnMut(crate::OperationEvent),
        before_accept: impl FnOnce() -> crate::Result<()>,
    ) -> crate::Result<GameFileQuerySnapshot> {
        let started = std::time::Instant::now();
        request.limits.validate()?;
        let (activity, operation) = self.begin_cancellable_activity(
            crate::ActivityOperation::VerifySource,
            crate::ActivityTargetKind::Library,
            None,
        )?;
        emit(operation.started());
        let elapsed = || started.elapsed();
        let result = self.refresh_game_file_query_with_fence(
            &request.routes,
            &request.limits,
            request.maximum_age_seconds,
            &QueryFence {
                elapsed: &elapsed,
                maximum: std::time::Duration::from_millis(request.limits.max_elapsed_ms),
                operation: Some(&operation),
            },
            before_accept,
        );
        let result = self.finish_activity(activity, result);
        emit(operation.finished(crate::OperationResult::from_result(&result)));
        result
    }

    /// Build a read-only query snapshot from this service's accepted Core batch.
    /// This is explicit snapshot construction, never filtering. Host adapters must
    /// keep the batch in their Core worker; do not accept client-authored reports.
    /// Current database/retained-definition reads happen here, not in evaluation.
    pub fn game_file_query_snapshot(
        &self,
        batch: &crate::RegisteredSourceInspectionBatch,
        requests: &[GameFileRouteRequest],
        maximum_age_seconds: u32,
    ) -> crate::Result<GameFileQuerySnapshot> {
        let started = std::time::Instant::now();
        let elapsed = || started.elapsed();
        self.game_file_query_snapshot_with_fence(
            batch,
            requests,
            maximum_age_seconds,
            &QueryFence {
                elapsed: &elapsed,
                maximum: std::time::Duration::from_secs(30),
                operation: None,
            },
        )
    }

    fn game_file_query_snapshot_with_fence(
        &self,
        batch: &crate::RegisteredSourceInspectionBatch,
        requests: &[GameFileRouteRequest],
        maximum_age_seconds: u32,
        fence: &QueryFence<'_>,
    ) -> crate::Result<GameFileQuerySnapshot> {
        use crate::{PortcoveError, source_batch::fingerprint};
        if requests.is_empty()
            || requests.len() > 256
            || maximum_age_seconds == 0
            || maximum_age_seconds > 1800
        {
            return Err(PortcoveError::usage(
                "game-file projection needs 1-256 unique routes and a bounded observation age",
            ));
        }
        for request in requests {
            if request.port_id.len() > 128 {
                return Err(PortcoveError::usage(
                    "game-file route identifier exceeds its budget",
                ));
            }
            self.catalog().port(&request.port_id)?;
        }
        let mut selections = requests
            .iter()
            .map(fingerprint)
            .collect::<crate::Result<Vec<_>>>()?;
        selections.sort_unstable();
        selections.dedup();
        if selections.len() != requests.len() {
            return Err(PortcoveError::usage(
                "game-file projection routes must be unique",
            ));
        }
        self.validate_game_file_batch(batch)?;
        // This catalog is immutable for the operation. Mutable route state is
        // still reread for every binding and final acceptance check.
        let current_document = self.catalog().authoritative_document();
        let now = crate::Library::now();
        let expires_at = batch
            .observed_at
            .checked_add(i64::from(maximum_age_seconds))
            .ok_or_else(|| PortcoveError::usage("game-file observation timestamp overflow"))?;
        let fresh = batch.observed_at > 0 && batch.observed_at <= now && now <= expires_at;
        let mut routes = Vec::with_capacity(requests.len());
        let mut bindings = Vec::with_capacity(requests.len());
        for request in requests {
            fence.checkpoint()?;
            let selected = resolve_route(self, request)?;
            let context = selected.context(request);
            let observation = match context.requirements {
                GameInputRequirements::Profile(profile) => {
                    batch
                        .observations
                        .iter()
                        .find(|observation| match observation {
                            RegisteredSourceObservation::Unregistered { profile_id } => {
                                profile_id == profile
                            }
                            RegisteredSourceObservation::Inspected { report } => {
                                report.profile_id == profile
                            }
                        })
                }
                _ => None,
            };
            let mut projection = project(&context, observation, fresh)?;
            projection.route_definition_sha256 = if selected.context_complete {
                Some(match &selected.catalog {
                    // Batch validation has just proved this exact digest matches
                    // the service catalog. Retained installations keep their own.
                    Cow::Borrowed(_) => batch.catalog_sha256.clone(),
                    Cow::Owned(catalog) => fingerprint(&catalog.authoritative_document())?,
                })
            } else {
                None
            };
            projection.route_instance_sha256 = selected.instance_sha256.clone();
            routes.push(projection);
            bindings.push(selected.binding(request, &current_document)?);
        }
        // Detect changes to current channel, active/external instance and retained
        // definition while constructing this observation. No source reinspection.
        for (request, before) in requests.iter().zip(&bindings) {
            fence.checkpoint()?;
            if resolve_route(self, request)?.binding(request, &current_document)? != *before {
                return Err(PortcoveError::conflict(
                    "selected game-file route changed during projection",
                ));
            }
        }
        self.validate_game_file_batch(batch)?;
        let snapshot = GameFileQuerySnapshot {
            schema_version: 1,
            library: batch.library.clone(),
            catalog_binding_sha256: batch.catalog_binding_sha256.clone(),
            registration_sha256: batch.registration_sha256.clone(),
            selection_sha256: fingerprint(&(requests, bindings))?,
            observed_at: batch.observed_at,
            expires_at,
            routes,
        };
        if serde_json::to_vec(&snapshot)?.len() > 4 * 1024 * 1024 {
            return Err(PortcoveError::unsupported(
                "game-file query response budget reached",
            ));
        }
        fence.checkpoint()?;
        Ok(snapshot)
    }

    /// Explicit bounded refresh: observations never cross an adapter input boundary.
    /// Call from one awaited blocking worker. Filtering consumes only its returned snapshot.
    pub fn refresh_game_file_query(
        &self,
        requests: &[GameFileRouteRequest],
        limits: &crate::RegisteredSourceInspectionLimits,
        maximum_age_seconds: u32,
        operation: &crate::OperationCoordinator,
    ) -> crate::Result<GameFileQuerySnapshot> {
        let started = std::time::Instant::now();
        let elapsed = || started.elapsed();
        self.refresh_game_file_query_with_fence(
            requests,
            limits,
            maximum_age_seconds,
            &QueryFence {
                elapsed: &elapsed,
                maximum: std::time::Duration::from_millis(limits.max_elapsed_ms),
                operation: Some(operation),
            },
            || Ok(()),
        )
    }

    fn refresh_game_file_query_with_fence(
        &self,
        requests: &[GameFileRouteRequest],
        limits: &crate::RegisteredSourceInspectionLimits,
        maximum_age_seconds: u32,
        fence: &QueryFence<'_>,
        before_accept: impl FnOnce() -> crate::Result<()>,
    ) -> crate::Result<GameFileQuerySnapshot> {
        use crate::PortcoveError;
        limits.validate()?;
        if requests.is_empty()
            || requests.len() > 256
            || maximum_age_seconds == 0
            || maximum_age_seconds > 1800
        {
            return Err(PortcoveError::usage(
                "game-file refresh needs 1-256 unique routes and bounded observation age",
            ));
        }
        fence.checkpoint()?;
        let current_document = self.catalog().authoritative_document();
        let mut profiles = std::collections::BTreeSet::new();
        let mut initial_bindings = Vec::with_capacity(requests.len());
        let mut unique = std::collections::HashSet::new();
        for request in requests {
            fence.checkpoint()?;
            if request.port_id.len() > 128 {
                return Err(PortcoveError::usage(
                    "game-file route identifier exceeds its budget",
                ));
            }
            self.catalog().port(&request.port_id)?;
            if !unique.insert(crate::source_batch::fingerprint(request)?) {
                return Err(PortcoveError::usage(
                    "game-file refresh routes must be unique",
                ));
            }
            let selected = resolve_route(self, request)?;
            if selected.context_complete
                && selected.offered
                && !selected.empty_requirements
                && !selected.unknown_requirements
                && let Some(profile) = &selected.profile_id
            {
                // The current authoritative matcher must know the profile;
                // unknown retained facts stay unavailable rather than guessed.
                if self.catalog().source_profile(profile).is_ok() {
                    profiles.insert(profile.clone());
                }
            }
            initial_bindings.push(selected.binding(request, &current_document)?);
        }
        fence.checkpoint()?;
        let mut remaining = limits.clone();
        remaining.max_elapsed_ms = limits
            .max_elapsed_ms
            .saturating_sub((fence.elapsed)().as_millis().min(u128::from(u64::MAX)) as u64);
        remaining.validate()?;
        let operation = fence
            .operation
            .ok_or_else(|| PortcoveError::usage("game-file refresh needs its own coordinator"))?;
        let (snapshot, _) = self.inspect_registered_sources_bounded_with_projection(
            &profiles.into_iter().collect::<Vec<_>>(),
            &remaining,
            operation,
            |batch| {
                let snapshot = self.game_file_query_snapshot_with_fence(
                    &batch,
                    requests,
                    maximum_age_seconds,
                    fence,
                )?;
                before_accept()?;
                Ok((snapshot, batch))
            },
            |(_, batch)| {
                fence.checkpoint()?;
                self.validate_game_file_batch(batch)?;
                for (request, before) in requests.iter().zip(&initial_bindings) {
                    fence.checkpoint()?;
                    if resolve_route(self, request)?.binding(request, &current_document)? != *before
                    {
                        return Err(PortcoveError::conflict(
                            "selected game-file route changed during refresh",
                        ));
                    }
                }
                fence.checkpoint()
            },
        )?;
        Ok(snapshot)
    }

    fn validate_game_file_batch(
        &self,
        batch: &crate::RegisteredSourceInspectionBatch,
    ) -> crate::Result<()> {
        use crate::{
            PortcoveError,
            source_batch::{effective_binding, fingerprint},
        };
        let (catalog, binding) = effective_binding(self.library())?;
        let records = self.library().sources_for(&batch.profile_ids)?;
        if batch.schema_version != 1
            || batch.profile_ids.len() > 256
            || batch.observations.len() != batch.profile_ids.len()
            || batch.library != self.library().identity_record()?
            || binding != batch.catalog_binding_sha256
            || fingerprint(&catalog.authoritative_document())? != batch.catalog_sha256
            || fingerprint(&self.catalog().authoritative_document())? != batch.catalog_sha256
            || fingerprint(&records)? != batch.registration_sha256
        {
            return Err(PortcoveError::conflict(
                "game-file projection context does not match the accepted source batch",
            ));
        }
        let mut profiles = std::collections::HashSet::new();
        for observation in &batch.observations {
            let (profile, registration) = match observation {
                RegisteredSourceObservation::Unregistered { profile_id } => (profile_id, None),
                RegisteredSourceObservation::Inspected { report } => {
                    (&report.profile_id, report.registered.as_ref())
                }
            };
            if !profiles.insert(profile)
                || !batch.profile_ids.contains(profile)
                || fingerprint(&registration)?
                    != fingerprint(&records.iter().find(|record| &record.profile_id == profile))?
            {
                return Err(PortcoveError::conflict(
                    "game-file observation does not match its registered instance",
                ));
            }
        }
        Ok(())
    }
}

struct QueryFence<'a> {
    elapsed: &'a dyn Fn() -> std::time::Duration,
    maximum: std::time::Duration,
    operation: Option<&'a crate::OperationCoordinator>,
}

impl QueryFence<'_> {
    fn checkpoint(&self) -> crate::Result<()> {
        if let Some(operation) = self.operation {
            operation.checkpoint()?;
        }
        if (self.elapsed)() >= self.maximum {
            return Err(crate::PortcoveError::unsupported(
                "game-file projection cooperative time budget reached",
            ));
        }
        Ok(())
    }
}

struct ResolvedRoute<'a> {
    catalog: Cow<'a, Catalog>,
    context_complete: bool,
    offered: bool,
    empty_requirements: bool,
    unknown_requirements: bool,
    profile_id: Option<String>,
    release: Option<(String, String)>,
    instance_sha256: Option<String>,
}

impl ResolvedRoute<'_> {
    fn context<'a>(&'a self, request: &'a GameFileRouteRequest) -> GameFileRouteContext<'a> {
        GameFileRouteContext {
            catalog: &self.catalog,
            port_id: &request.port_id,
            platform: request.platform,
            channel: request.channel,
            route: request.route,
            offered: self.offered,
            context_complete: self.context_complete,
            requirements: if self.empty_requirements {
                GameInputRequirements::Empty
            } else if self.unknown_requirements {
                GameInputRequirements::Unknown
            } else {
                self.profile_id.as_deref().map_or(
                    GameInputRequirements::Unknown,
                    GameInputRequirements::Profile,
                )
            },
            release: self
                .release
                .as_ref()
                .map(|(reference, hash)| (reference.as_str(), hash.as_str())),
        }
    }

    fn binding(
        &self,
        request: &GameFileRouteRequest,
        current_document: &crate::CatalogDocument,
    ) -> crate::Result<String> {
        let document = match &self.catalog {
            Cow::Borrowed(_) => Cow::Borrowed(current_document),
            Cow::Owned(catalog) => Cow::Owned(catalog.authoritative_document()),
        };
        crate::source_batch::fingerprint(&(
            request,
            document,
            self.context_complete,
            self.offered,
            self.empty_requirements,
            self.unknown_requirements,
            &self.profile_id,
            &self.release,
            &self.instance_sha256,
        ))
    }
}

fn resolve_route<'a>(
    service: &'a crate::PortcoveService,
    request: &GameFileRouteRequest,
) -> crate::Result<ResolvedRoute<'a>> {
    use crate::source_batch::fingerprint;
    let current = service.catalog().port(&request.port_id).ok();
    service.catalog().listing(&request.port_id)?;
    let status = service.library().status(
        &request.port_id,
        current.map_or(crate::ReleaseChannel::Stable, |port| port.channels[0]),
    )?;
    let mut selected = ResolvedRoute {
        catalog: Cow::Borrowed(service.catalog()),
        context_complete: true,
        offered: false,
        empty_requirements: false,
        unknown_requirements: false,
        profile_id: None,
        release: None,
        instance_sha256: None,
    };
    let Some(current) = current else {
        // A directory entry does not declare a Core source contract. Keep the
        // request honest and inert without failing unrelated batched entries.
        selected.unknown_requirements = true;
        return Ok(selected);
    };
    match request.route {
        GameFileRouteKind::ManagedLaunch => {
            let Some(install) = status.active.as_ref() else {
                return Ok(selected);
            };
            selected.instance_sha256 = Some(fingerprint(install)?);
            let Ok((Some(catalog), Some(platform))) = crate::output_root::validate_install_path(
                service.library(),
                &request.port_id,
                &install.path,
            )
            .and_then(|_| crate::install::retained_query_context(install)) else {
                selected.context_complete = false;
                return Ok(selected);
            };
            selected.catalog = Cow::Owned(catalog);
            selected.release = Some((install.version.clone(), install.artifact.sha256.clone()));
            selected.offered = install.channel == request.channel && platform == request.platform;
        }
        GameFileRouteKind::ExternalLaunch => {
            let (record, catalog) = match service
                .library()
                .external_runtime_with_port(&request.port_id)
            {
                Ok(Some(pair)) => pair,
                Ok(None) => return Ok(selected),
                Err(_) => {
                    selected.context_complete = false;
                    return Ok(selected);
                }
            };
            selected.catalog = Cow::Owned(catalog);
            selected.instance_sha256 = Some(fingerprint(&record)?);
            selected.release = Some((record.version.clone(), record.archive_sha256.clone()));
            selected.offered =
                record.platform == request.platform && status.channel == request.channel;
            if record.user_selected.is_some() {
                // Upstream setup owns game data; an explicit launch selection
                // must not inherit the current managed route's source rules.
                selected.unknown_requirements = true;
                return Ok(selected);
            }
            let spec = selected
                .catalog
                .port(&request.port_id)?
                .release
                .user_prepared
                .get(&request.platform);
            selected.offered &= spec.is_some_and(|spec| {
                spec.version == record.version
                    && spec
                        .archive_sha256
                        .eq_ignore_ascii_case(&record.archive_sha256)
                    && spec
                        .immutable_tree_sha256
                        .eq_ignore_ascii_case(&record.immutable_tree_sha256)
            });
        }
        GameFileRouteKind::ManagedInstall => {
            selected.offered = crate::definition_eligibility::admission_route_exclusion(
                current,
                &status,
                request.platform,
                crate::PortAction::Install,
            )
            .is_none()
                && status.channel == request.channel;
            if let Some(release) = current.release.direct.get(&request.platform) {
                selected.release = Some((release.version.clone(), release.sha256.clone()));
            } else if let Some(record) = current.release.curated.get(&request.platform) {
                // A selected declared artifact can be compared to independently
                // reviewed source applicability. This is not acquisition authority.
                selected.release = Some((record.tag.clone(), record.sha256.clone()));
            }
        }
        GameFileRouteKind::ExternalRegistration => {
            selected.offered = crate::definition_eligibility::admission_route_exclusion(
                current,
                &status,
                request.platform,
                crate::PortAction::RegisterExternal,
            )
            .is_none()
                && current
                    .release
                    .user_prepared
                    .contains_key(&request.platform)
                && status.channel == request.channel;
            // Registration validates the package itself and has no game-input
            // argument. This says nothing about the separate launch route.
            selected.empty_requirements = selected.offered;
        }
    }
    let port = selected.catalog.port(&request.port_id)?;
    selected.offered &=
        port.platforms.contains(&request.platform) && port.channels.contains(&request.channel);
    selected.profile_id = port.source_profile.clone();
    if port.source_profile.is_none() && !selected.empty_requirements {
        // Explicit, complete presentation plus absence of all execution source
        // bindings establishes empty game requirements; missing legacy metadata
        // or source-dependent execution fields remains unknown.
        selected.empty_requirements = port.presentation.as_ref().is_some_and(|presentation| {
            !presentation
                .source_requirements
                .iter()
                .any(|requirement| requirement.role == PortSourceRole::Game)
        }) && port.source_environment.is_none()
            && port.runtime_source_filename.is_none()
            && port.runtime_source_materialization.is_none()
            && port.runtime_source_set.is_empty();
        selected.unknown_requirements = !selected.empty_requirements;
    }
    Ok(selected)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GameFileRouteKind {
    ManagedInstall,
    ExternalRegistration,
    ManagedLaunch,
    ExternalLaunch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GameFileQueryState {
    FilesAvailable,
    FilesMissing,
    NeedsChecking,
    NoFilesRequired,
    UnavailableContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GameFileQueryReason {
    CompleteCompatibleObservation,
    NoConnectedRegistration,
    ExplicitEmptyRequirements,
    ObservationUnavailable,
    ObservationStale,
    SourceNeedsChecking,
    StorageAbsenceUnconfirmed,
    IdentityNotAdmitted,
    ContractNotReviewed,
    VariantNotSupported,
    ReleaseNotBound,
    RouteNotOffered,
    ProfileContextChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GameFileRouteProjection {
    pub port_id: String,
    pub platform: Platform,
    pub channel: ReleaseChannel,
    pub route: GameFileRouteKind,
    pub state: GameFileQueryState,
    pub reason: GameFileQueryReason,
    pub contract_id: Option<String>,
    pub identity: Option<SourceIdentity>,
    /// Digest of the complete registered instance, never its private path.
    pub source_instance_sha256: Option<String>,
    pub route_definition_sha256: Option<String>,
    pub route_instance_sha256: Option<String>,
}

/// Constructed by Core from the selected current or retained definition. A
/// client request cannot supply the requirements, profile or admission facts.
pub(crate) struct GameFileRouteContext<'a> {
    pub catalog: &'a Catalog,
    pub port_id: &'a str,
    pub platform: Platform,
    pub channel: ReleaseChannel,
    pub route: GameFileRouteKind,
    pub offered: bool,
    pub context_complete: bool,
    pub requirements: GameInputRequirements<'a>,
    pub release: Option<(&'a str, &'a str)>,
}

pub(crate) enum GameInputRequirements<'a> {
    /// A complete operation-specific requirement list, not a nullable profile.
    Empty,
    Profile(&'a str),
    Unknown,
}

pub(crate) fn project(
    context: &GameFileRouteContext<'_>,
    observation: Option<&RegisteredSourceObservation>,
    fresh: bool,
) -> crate::Result<GameFileRouteProjection> {
    let mut result = GameFileRouteProjection {
        port_id: context.port_id.into(),
        platform: context.platform,
        channel: context.channel,
        route: context.route,
        state: GameFileQueryState::NeedsChecking,
        reason: GameFileQueryReason::ObservationUnavailable,
        contract_id: None,
        identity: None,
        source_instance_sha256: None,
        route_definition_sha256: None,
        route_instance_sha256: None,
    };
    if !context.context_complete {
        result.state = GameFileQueryState::UnavailableContext;
        return Ok(result);
    }
    if !context.offered {
        result.reason = GameFileQueryReason::RouteNotOffered;
        return Ok(result);
    }
    let profile_id = match context.requirements {
        GameInputRequirements::Empty => {
            result.state = GameFileQueryState::NoFilesRequired;
            result.reason = GameFileQueryReason::ExplicitEmptyRequirements;
            return Ok(result);
        }
        GameInputRequirements::Unknown => return Ok(result),
        GameInputRequirements::Profile(id) => id,
    };
    if !fresh {
        result.reason = GameFileQueryReason::ObservationStale;
        return Ok(result);
    }
    let report = match observation {
        Some(RegisteredSourceObservation::Unregistered {
            profile_id: observed,
        }) if observed == profile_id => {
            result.state = GameFileQueryState::FilesMissing;
            result.reason = GameFileQueryReason::NoConnectedRegistration;
            return Ok(result);
        }
        Some(RegisteredSourceObservation::Inspected { report })
            if report.profile_id == profile_id =>
        {
            report.as_ref()
        }
        _ => {
            result.state = GameFileQueryState::UnavailableContext;
            return Ok(result);
        }
    };
    evaluate_report(context, profile_id, report, &mut result)?;
    Ok(result)
}

fn evaluate_report(
    context: &GameFileRouteContext<'_>,
    profile_id: &str,
    report: &SourceInspectionReport,
    result: &mut GameFileRouteProjection,
) -> crate::Result<()> {
    if report.health != SourceHealth::Current {
        result.reason = if report.health == SourceHealth::Missing {
            // A failed path lookup does not establish mounted storage identity.
            GameFileQueryReason::StorageAbsenceUnconfirmed
        } else {
            GameFileQueryReason::SourceNeedsChecking
        };
        return Ok(());
    }
    let Some(inspection) = report.inspection.as_ref() else {
        return Ok(());
    };
    let Some(registration) = report.registered.as_ref() else {
        return Ok(());
    };
    if inspection.assessment.health != SourceHealth::Current
        || !matches!(
            inspection.assessment.admission,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity
            }
        )
    {
        result.reason = GameFileQueryReason::IdentityNotAdmitted;
        return Ok(());
    }
    let SourceClassification::Recognized { identity } = &inspection.assessment.classification
    else {
        result.reason = GameFileQueryReason::IdentityNotAdmitted;
        return Ok(());
    };
    let Some(source_catalog) = context.catalog.source_catalog() else {
        result.reason = GameFileQueryReason::ContractNotReviewed;
        return Ok(());
    };
    let expected = source_catalog
        .identities
        .iter()
        .find(|profile| profile.id == profile_id);
    if expected.is_none()
        || expected != report.expected_identity.as_ref()
        || identity.game_id != profile_id
        || registration.profile_id != profile_id
        || inspection.profile_id != profile_id
        || inspection.path != registration.path
    {
        result.reason = GameFileQueryReason::ProfileContextChanged;
        return Ok(());
    }
    let contracts = source_catalog
        .contracts
        .iter()
        .filter(|contract| {
            contract.port_id == context.port_id
                && contract.role == PortSourceRole::Game
                && contract.profile_id == profile_id
        })
        .collect::<Vec<_>>();
    let [contract] = contracts.as_slice() else {
        result.reason = GameFileQueryReason::ContractNotReviewed;
        return Ok(());
    };
    result.contract_id = Some(contract.id.clone());
    if contract.admission_mode != CatalogAdmissionMode::Enforced {
        result.reason = GameFileQueryReason::ContractNotReviewed;
        return Ok(());
    }
    if !contract
        .supported_variant_ids
        .contains(&identity.variant_id)
    {
        result.reason = GameFileQueryReason::VariantNotSupported;
        return Ok(());
    }
    let Some((upstream_ref, artifact_sha256)) = context.release else {
        result.reason = GameFileQueryReason::ReleaseNotBound;
        return Ok(());
    };
    if !contract.applies_to_release(upstream_ref, artifact_sha256) {
        result.reason = GameFileQueryReason::ReleaseNotBound;
        return Ok(());
    }
    result.source_instance_sha256 = Some(crate::signed_catalog::digest(&serde_json::to_vec(
        registration,
    )?));
    result.identity = Some(identity.clone());
    result.state = GameFileQueryState::FilesAvailable;
    result.reason = GameFileQueryReason::CompleteCompatibleObservation;
    Ok(())
}

#[cfg(test)]
#[path = "game_file_query_tests.rs"]
mod tests;
