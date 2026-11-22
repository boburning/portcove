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
    let day = Library::now().div_euclid(86_400).unsigned_abs();

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
    for &stable_id in scheduled_subjects(&known, day) {
        if Instant::now() >= deadline {
            break;
        }
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
                let launch_current = launch.as_ref().and_then(|launch| launch.as_ref().ok());
                if (!needs_launch || launch_current.is_some())
                    && exact_scheduled_replay(
                        library,
                        &policy,
                        index.as_ref().ok(),
                        launch_current,
                    )?
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

/// An exact local retry is successful only while the current repository floors
/// and effective selection still authorize it in the same read transaction.
fn exact_scheduled_replay(
    library: &Library,
    policy: &AuthenticatedDefinitionPublisherPolicy,
    index: Option<&super::super::AuthenticatedDefinitionIndex>,
    launch: Option<&launch_assessment::AuthenticatedDefinitionLaunchAssessment>,
) -> Result<bool> {
    let connection = library.connection()?;
    let transaction = connection.unchecked_transaction()?;
    let exact_policy = stored_admission(&transaction, "official", &policy.document.stable_id)?
        .is_some_and(|(document, provenance, _)| {
            document == policy.document && provenance == policy.provenance
        });
    if !exact_policy {
        return Ok(false);
    }
    let floor = super::installed_authority_floor(&transaction, &policy.provenance.anchor_sha256)?
        .ok_or_else(|| PortcoveError::state("publisher policy lost its replay floor"))?;
    policy.provenance.check_advance(&floor)?;
    policy.provenance.require_fresh()?;
    if matches!(policy.document.decision, PolicyDecision::Revoked) {
        return Ok(true);
    }
    let Some(index) = index else {
        return Ok(false);
    };
    let stable_id = &policy.document.stable_id;
    let now = Library::now();
    let status = Library::definition_selection_status_from(&transaction, "official", stable_id)?;
    if let Some(floor) = &status.replay_floor {
        floor.evaluate(&index.provenance)?;
    }
    crate::definition_candidate::selection::require_fresh(&index.provenance, now)?;
    let Some(selection) = status
        .selected
        .filter(|selected| selected.provenance == index.provenance)
    else {
        return Ok(false);
    };
    let (catalog, _) = crate::catalog_store::load_catalog_from(&transaction, now)?;
    if catalog.definition_selection(stable_id) != Some(&selection) {
        return Ok(false);
    }
    if let Some(launch) = launch {
        return launch.already_admitted(&transaction);
    }
    Ok(true)
}

/// Consecutive days start a whole window apart, so daily windows tile the set
/// instead of overlapping: each cycle of `c = ceil(n / limit)` days covers
/// every stable subject (447 subjects: 14 days, not 416), and any `2c`
/// consecutive full windows do too. Each completed
/// cycle shifts the phase by one subject, so even when the deadline always
/// cuts the window short, every subject eventually gets the first slot. The
/// split visits each at most once.
fn scheduled_subjects<T>(known: &[T], day: u64) -> impl Iterator<Item = &T> {
    let count = known.len() as u64;
    let start = if count == 0 {
        0
    } else {
        let limit = SCHEDULED_SUBJECT_LIMIT as u64;
        let cycle = count.div_ceil(limit);
        (((day % cycle) * limit + (day / cycle) % count) % count) as usize
    };
    let (early, late) = known.split_at(start);
    late.iter().chain(early).take(SCHEDULED_SUBJECT_LIMIT)
}

#[cfg(test)]
mod scheduled_subject_tests {
    use super::*;

    #[test]
    fn short_daily_budget_eventually_visits_each_subject() {
        for count in [1, 6, 32, 33, 64, 81] {
            let subjects: Vec<_> = (0..count).collect();
            let cycle = (count as usize).div_ceil(SCHEDULED_SUBJECT_LIMIT) as u64;
            for budget in [1, 4] {
                let visited: BTreeSet<_> = (0..count as u64 * cycle)
                    .flat_map(|day| scheduled_subjects(&subjects, day).take(budget).copied())
                    .collect();
                assert_eq!(
                    visited,
                    subjects.iter().copied().collect(),
                    "{count}/{budget}"
                );
            }
        }
    }

    #[test]
    fn daily_window_wraps_within_the_bound_without_duplicates_or_overflow() {
        let subjects: Vec<_> = (0..40).collect();
        let selected: Vec<_> = scheduled_subjects(&subjects, u64::MAX).copied().collect();
        assert_eq!(selected.len(), SCHEDULED_SUBJECT_LIMIT);
        assert_eq!(
            selected.iter().collect::<BTreeSet<_>>().len(),
            SCHEDULED_SUBJECT_LIMIT
        );
        let none = scheduled_subjects::<u32>(&[], u64::MAX).count();
        assert_eq!(none, 0);
    }

    #[test]
    fn full_daily_windows_cover_a_large_stable_set_within_one_cycle() {
        for count in [33_usize, 64, 96, 128, 447, 1_000] {
            let subjects: Vec<_> = (0..count).collect();
            let cycle = count.div_ceil(SCHEDULED_SUBJECT_LIMIT) as u64;
            let covers = |first: u64, days: u64| {
                (first..first + days)
                    .flat_map(|day| scheduled_subjects(&subjects, day).copied())
                    .collect::<BTreeSet<_>>()
                    .len()
                    == count
            };
            for aligned in [0_u64, 7] {
                assert!(covers(aligned * cycle, cycle), "{count} cycle {aligned}");
            }
            for first in 0..3 * cycle {
                assert!(covers(first, 2 * cycle), "{count} from day {first}");
            }
        }
    }
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
