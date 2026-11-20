//! Ordinary refresh under this release's already provisioned fixed authority.

use schemars::JsonSchema;
use serde::Serialize;
use std::{collections::BTreeSet, time::Duration};
use tokio::time::Instant;
use tough::{Repository, Transport};

use crate::{
    ActivityOperation, ActivityTargetKind, AuthenticatedDefinitionCandidate, DefinitionEligibility,
    DefinitionRepositorySource, DefinitionSelectionStatus, Library, OperationEvent,
    OperationResult, PortcoveError, PortcoveService, Result,
};

use super::{
    AuthenticatedDefinitionPublisherPolicy, PolicyDecision, launch_assessment, provisioning,
    stored_admission,
};

const SCHEDULED_SUBJECT_LIMIT: usize = 32;
const SCHEDULED_SUBJECT_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Copy, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionRefreshDisposition {
    Revoked,
    Selected,
    Ineligible,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DefinitionRefresh {
    pub refresh_schema: u32,
    pub namespace: String,
    pub stable_id: String,
    pub disposition: DefinitionRefreshDisposition,
    pub policy_changed: bool,
    pub launch_assessment_changed: bool,
    pub eligibility: Option<DefinitionEligibility>,
    pub selection: DefinitionSelectionStatus,
}

struct Progress {
    phase: &'static str,
    policy_changed: bool,
    launch_assessment_changed: bool,
}

impl Progress {
    fn error(&self, error: PortcoveError) -> PortcoveError {
        error
            .detail("definition_refresh_phase", self.phase)
            .detail("definition_policy_changed", self.policy_changed.to_string())
            .detail(
                "definition_launch_assessment_changed",
                self.launch_assessment_changed.to_string(),
            )
    }
}

impl PortcoveService {
    /// Refresh discoverable definitions under the fixed installed authority.
    /// Destinations choose network locations, never roots, grants or operations.
    /// This performs no game installation, update, launch or ownership change.
    /// Existing service instances retain their constructor's catalog snapshot;
    /// construct a new service to consume the resulting durable selection.
    pub async fn refresh_definition(
        &self,
        source: &DefinitionRepositorySource,
        stable_id: &str,
        emit: impl FnMut(OperationEvent),
    ) -> Result<DefinitionRefresh> {
        let root = provisioning::installed_compiled_root(self.library())?;
        let transport = super::super::DefinitionHttpsTransport::new(source)?;
        refresh(self, source, stable_id, root, transport, emit).await
    }
}

async fn refresh<T: Transport + Send + Sync + 'static>(
    service: &PortcoveService,
    source: &DefinitionRepositorySource,
    stable_id: &str,
    root: &[u8],
    transport: T,
    mut emit: impl FnMut(OperationEvent),
) -> Result<DefinitionRefresh> {
    if !super::valid_identity(stable_id) {
        return Err(PortcoveError::usage(
            "unsupported official definition identity",
        ));
    }
    let (activity, operation) = service.begin_cancellable_activity(
        ActivityOperation::UpdateCatalog,
        ActivityTargetKind::Library,
        None,
    )?;
    emit(operation.started());
    let mut progress = Progress {
        phase: "metadata",
        policy_changed: false,
        launch_assessment_changed: false,
    };
    let result = tokio::time::timeout(super::super::ACQUISITION_TIMEOUT, async {
        let repository = operation
            .interruptible(super::super::load_repository(
                root,
                source.metadata_base_url.clone(),
                source.targets_base_url.clone(),
                transport,
            ))
            .await?;
        progress.phase = "policy_acquisition";
        let policy = operation
            .interruptible(super::acquire_from_repository(
                &repository,
                root,
                "official",
                stable_id,
            ))
            .await?;
        let needs_launch = matches!(
            policy.document.decision,
            PolicyDecision::ManagedGithub {
                launch_checks: Some(1),
                ..
            }
        );
        let revoked = matches!(policy.document.decision, PolicyDecision::Revoked);
        // A missing companion must not discard a separately admissible narrower
        // policy. Settle its acquisition before obtaining the exact candidate;
        // publication then has no remaining network work or cancellation gap.
        let launch = if needs_launch {
            progress.phase = "launch_assessment_acquisition";
            Some(
                operation
                    .interruptible(launch_assessment::acquire_from_repository(
                        &repository,
                        root,
                        "official",
                        stable_id,
                    ))
                    .await,
            )
        } else {
            None
        };
        operation.checkpoint()?;
        let candidate = if revoked {
            None
        } else {
            progress.phase = "candidate_acquisition";
            Some(
                operation
                    .interruptible(super::super::acquire_from_repository(&repository))
                    .await?,
            )
        };
        operation.begin_publication()?;
        admit(
            service.library(),
            stable_id,
            &policy,
            launch,
            candidate.as_ref(),
            &mut progress,
        )
    })
    .await
    .unwrap_or_else(|_| {
        Err(PortcoveError::network(
            "definition refresh acquisition timed out",
        ))
    })
    .map_err(|error| progress.error(error));
    let result = service.finish_activity(activity, result);
    emit(operation.finished(OperationResult::from_result(&result)));
    result
}

fn admit(
    library: &Library,
    stable_id: &str,
    policy: &AuthenticatedDefinitionPublisherPolicy,
    launch: Option<Result<launch_assessment::AuthenticatedDefinitionLaunchAssessment>>,
    candidate: Option<&AuthenticatedDefinitionCandidate>,
    progress: &mut Progress,
) -> Result<DefinitionRefresh> {
    let revoked = matches!(policy.document.decision, PolicyDecision::Revoked);
    progress.phase = "policy_admission";
    progress.policy_changed = library.apply_definition_publisher_policy(policy, candidate)?;
    let mut eligibility = None;
    let mut selected = None;
    let disposition = if revoked {
        DefinitionRefreshDisposition::Revoked
    } else {
        if let Some(launch) = launch {
            progress.phase = "launch_assessment";
            progress.launch_assessment_changed =
                library.apply_definition_launch_assessment(&launch?)?;
        }
        progress.phase = "availability";
        let availability = library.assess_definition_candidate(
            candidate.ok_or_else(|| {
                PortcoveError::state("availability policy lost its authenticated candidate")
            })?,
            "official",
            stable_id,
        )?;
        eligibility = Some(availability.eligibility());
        if let Some(eligible) = availability.into_eligible() {
            progress.phase = "selection";
            selected = Some(library.select_definition_catalog(eligible)?);
            DefinitionRefreshDisposition::Selected
        } else {
            DefinitionRefreshDisposition::Ineligible
        }
    };
    Ok(DefinitionRefresh {
        refresh_schema: 1,
        namespace: "official".into(),
        stable_id: stable_id.into(),
        disposition,
        policy_changed: progress.policy_changed,
        launch_assessment_changed: progress.launch_assessment_changed,
        eligibility,
        selection: match selected {
            Some(status) => status,
            None => library.definition_selection_status_for("official", stable_id)?,
        },
    })
}

/// Consume only exact known authorities named by this snapshot's independent
/// policy role. Missing targets are never interpreted as withdrawals.
pub(super) async fn refresh_known_official_definitions(
    service: &PortcoveService,
    repository: &Repository,
    root: &[u8],
    deadline: Instant,
    emit: &mut impl FnMut(OperationEvent),
) -> Result<bool> {
    let role = super::policy_role(repository)?;
    let metadata = role
        .targets
        .as_ref()
        .ok_or_else(|| PortcoveError::verification("publisher policy delegation was not loaded"))?;
    let library = service.library();
    let (catalog, _) = library.load_catalog()?;
    let retained = library.retained_official_definition_subjects()?;
    let mut known = BTreeSet::new();
    for target in metadata.signed.targets.keys() {
        let Some(id) = target
            .raw()
            .strip_prefix("policy/official/")
            .and_then(|path| path.strip_suffix(".json"))
            .filter(|id| super::valid_identity(id))
        else {
            continue;
        };
        // A launch companion or listing target cannot validate as a stable
        // definition ID. Previously admitted subjects remain known even if a
        // later directory omits their descriptive listing.
        if provisioning::official_catalog::official_definition_id(&catalog, id)
            .is_ok_and(|known| known == id)
            || retained.contains(id)
        {
            known.insert(id);
        }
    }
    if known.is_empty() {
        return Ok(false);
    }

    let known: Vec<_> = known.into_iter().collect();
    // Stable daily windows keep large repositories bounded without leaving
    // later identities permanently behind the same fixed prefix.
    let day = Library::now().div_euclid(86_400).unsigned_abs();
    let windows = known.len().div_ceil(SCHEDULED_SUBJECT_LIMIT);
    let start = (day % windows as u64) as usize * SCHEDULED_SUBJECT_LIMIT;

    // Read the index once. A missing or unreadable index cannot undo an
    // independently authenticated explicit withdrawal.
    let index = tokio::time::timeout_at(
        deadline.min(Instant::now() + SCHEDULED_SUBJECT_TIMEOUT),
        super::super::acquire_index(repository),
    )
    .await
    .unwrap_or_else(|_| {
        Err(PortcoveError::network(
            "definition index acquisition timed out",
        ))
    });
    let mut verified_or_updated = false;
    for &stable_id in known.iter().skip(start).take(SCHEDULED_SUBJECT_LIMIT) {
        if Instant::now() >= deadline {
            break;
        }
        let before = match library.definition_selection_status_for("official", stable_id) {
            Ok(before) => before,
            Err(error) => {
                tracing::info!(stable_id, error = %error.message, "scheduled definition state could not be read");
                continue;
            }
        };
        let acquired = tokio::time::timeout_at(
            deadline.min(Instant::now() + SCHEDULED_SUBJECT_TIMEOUT),
            async {
                let policy =
                    super::acquire_from_repository(repository, root, "official", stable_id).await?;
                let revoked = matches!(policy.document.decision, PolicyDecision::Revoked);
                let needs_launch = matches!(
                    policy.document.decision,
                    PolicyDecision::ManagedGithub {
                        launch_checks: Some(1),
                        ..
                    }
                );
                let connection = library.connection()?;
                let exact_policy = stored_admission(&connection, "official", stable_id)?
                    .is_some_and(|(document, provenance, _)| {
                        document == policy.document && provenance == policy.provenance
                    });
                let exact_selection = before.selected.as_ref().is_some_and(|selected| {
                    index
                        .as_ref()
                        .is_ok_and(|index| selected.provenance == index.provenance)
                });
                if exact_policy && (revoked || (!needs_launch && exact_selection)) {
                    return Ok(None);
                }
                drop(connection);
                let launch = if needs_launch {
                    Some(
                        launch_assessment::acquire_from_repository(
                            repository, root, "official", stable_id,
                        )
                        .await,
                    )
                } else {
                    None
                };
                if exact_policy
                    && exact_selection
                    && let Some(Ok(launch)) = &launch
                    && launch.already_admitted(&library.connection()?)?
                {
                    return Ok(None);
                }
                let candidate = if revoked {
                    None
                } else {
                    Some(
                        index
                            .as_ref()
                            .map_err(|error| PortcoveError::new(error.code, error.message.clone()))?
                            .acquire_subject(repository, "official", stable_id)
                            .await?,
                    )
                };
                Ok::<_, PortcoveError>(Some((policy, launch, candidate)))
            },
        )
        .await
        .unwrap_or_else(|_| {
            Err(PortcoveError::network(
                "scheduled definition acquisition timed out",
            ))
        });
        let (policy, launch, candidate) = match acquired {
            Ok(Some(acquired)) => acquired,
            Ok(None) => {
                verified_or_updated = true;
                continue;
            }
            Err(error) => {
                tracing::info!(stable_id, error = %error.message, "scheduled definition could not be acquired");
                continue;
            }
        };
        let (activity, operation) = match service.begin_cancellable_activity(
            ActivityOperation::UpdateCatalog,
            ActivityTargetKind::Library,
            None,
        ) {
            Ok(activity) => activity,
            Err(error) => {
                tracing::info!(stable_id, error = %error.message, "scheduled definition activity could not start");
                break;
            }
        };
        emit(operation.started());
        let mut progress = Progress {
            phase: "publication",
            policy_changed: false,
            launch_assessment_changed: false,
        };
        let result = operation
            .begin_publication()
            .and_then(|()| {
                admit(
                    library,
                    stable_id,
                    &policy,
                    launch,
                    candidate.as_ref(),
                    &mut progress,
                )
            })
            .map_err(|error| progress.error(error));
        verified_or_updated |=
            progress.policy_changed || progress.launch_assessment_changed || result.is_ok();
        let result = service.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        if let Err(error) = result {
            tracing::info!(stable_id, error = %error.message, "scheduled definition was not selected");
            if error.code == crate::ErrorCode::Cancelled {
                break;
            }
        }
    }
    Ok(verified_or_updated)
}

#[cfg(test)]
pub(crate) async fn refresh_fixture<T: Transport + Send + Sync + 'static>(
    service: &PortcoveService,
    source: &DefinitionRepositorySource,
    stable_id: &str,
    root: &[u8],
    transport: T,
    emit: impl FnMut(OperationEvent),
) -> Result<DefinitionRefresh> {
    provisioning::installed_fixture_root(service.library(), root)?;
    refresh(service, source, stable_id, root, transport, emit).await
}
