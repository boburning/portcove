//! Ordinary refresh under this release's already provisioned fixed authority.

use schemars::JsonSchema;
use serde::Serialize;
use tough::Transport;

use crate::{
    ActivityOperation, ActivityTargetKind, DefinitionEligibility, DefinitionRepositorySource,
    DefinitionSelectionStatus, OperationEvent, OperationResult, PortcoveError, PortcoveService,
    Result,
};

use super::{PolicyDecision, launch_assessment, provisioning};

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
    let library = service.library();
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
        // The existing SQLite cancellation seal decides whether cancellation or
        // admission won. Every mutation below is synchronous; all HTTP is done.
        operation.begin_publication()?;
        progress.phase = "policy_admission";
        progress.policy_changed =
            library.apply_definition_publisher_policy(&policy, candidate.as_ref())?;
        let mut eligibility = None;
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
                candidate
                    .as_ref()
                    .expect("positive policy requires candidate"),
                "official",
                stable_id,
            )?;
            eligibility = Some(availability.eligibility());
            if let Some(eligible) = availability.into_eligible() {
                progress.phase = "selection";
                library.select_definition_candidate(eligible)?;
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
            selection: library.definition_selection_status()?,
        })
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
