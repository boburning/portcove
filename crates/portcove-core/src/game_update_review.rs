//! Exact review for explicit game updates; saved policy never chooses the action.
use super::{InstallOverrides, OperationReporter, ReleaseIntent};
use crate::{
    ActivityOperation, ActivityTargetKind, DestructiveAuthorization, GameUpdatePlan, InstallRecord,
    OperationEvent, OperationResult, PortcoveError, PortcoveService, Result,
};

impl PortcoveService {
    pub async fn plan_game_update(&self, port_id: &str, activate: bool) -> Result<GameUpdatePlan> {
        let _guard = self.library.try_lock_port(port_id, "review-update")?;
        self.plan_game_update_locked(port_id, activate).await
    }

    async fn plan_game_update_locked(
        &self,
        port_id: &str,
        activate: bool,
    ) -> Result<GameUpdatePlan> {
        let status = self.status(port_id)?;
        if status.active.is_none() {
            return Err(PortcoveError::not_found(
                "install this game before reviewing an update",
            ));
        }
        let plan = self.plan_install(port_id, Some(status.channel)).await?;
        let plan_sha256 = self.game_release_review_digest(
            "Portcove game update review v1",
            &plan,
            &status,
            activate,
        )?;
        Ok(GameUpdatePlan {
            assessment: game_update_plan_assessment(&plan),
            plan,
            activate,
            plan_sha256,
        })
    }

    // Shared exact-input digest; each operation retains its own legal-state and
    // execution boundary. Keep the existing update digest representation intact.
    pub(super) fn game_release_review_digest(
        &self,
        domain: &str,
        plan: &crate::InstallPlan,
        status: &crate::PortStatus,
        activate: bool,
    ) -> Result<String> {
        let port = self.catalog.port(&plan.port_id)?;
        let sources = self
            .library
            .sources()?
            .into_iter()
            .filter(|source| {
                Some(&source.profile_id) == port.source_profile.as_ref()
                    || Some(&source.profile_id) == port.bios_source_profile.as_ref()
            })
            .collect::<Vec<_>>();
        // Free space is checked again at execution, but changing free bytes is
        // not a change to what the user reviewed. Release, destination, source,
        // definition, retained state and execution mode are exact identities.
        let digest = crate::signed_catalog::digest(&serde_json::to_vec(&(
            domain,
            port,
            &plan.release,
            plan.channel,
            plan.platform,
            &plan.bundled_runtime,
            plan.action,
            &plan.output_location,
            (
                &status.active,
                &status.previous,
                &status.staged,
                status.update_policy,
            ),
            sources,
            activate,
        ))?);
        if let Some(shared) = &plan.shared_preferences {
            return Ok(crate::signed_catalog::digest(&serde_json::to_vec(&(
                "Portcove managed shared preference review v1",
                digest,
                shared,
            ))?));
        }
        Ok(digest)
    }

    pub async fn authorize_game_update(
        &self,
        port_id: &str,
        activate: bool,
        expected_plan: &str,
    ) -> Result<DestructiveAuthorization> {
        self.authorize_game_update_with_shared_preferences_ack(
            port_id,
            activate,
            expected_plan,
            None,
        )
        .await
    }

    pub async fn authorize_game_update_with_shared_preferences_ack(
        &self,
        port_id: &str,
        activate: bool,
        expected_plan: &str,
        acknowledged: Option<&str>,
    ) -> Result<DestructiveAuthorization> {
        let reviewed = self.plan_game_update(port_id, activate).await?;
        if reviewed.plan_sha256 != expected_plan {
            return Err(PortcoveError::conflict(
                "update inputs changed; review the update again",
            ));
        }
        if reviewed.plan.action == crate::InstallPlanAction::BlockedUnverified {
            return Err(PortcoveError::verification(
                "an unverified retained copy blocks the update; verify or repair it first",
            ));
        }
        crate::external_runtime::shared_preferences::require_scoped_ack(
            reviewed.plan.shared_preferences.is_some(),
            expected_plan,
            acknowledged,
        )?;
        self.library
            .issue_authorization("game-update", port_id, expected_plan)
    }

    pub async fn apply_game_update(
        &self,
        port_id: &str,
        activate: bool,
        authorization: &str,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<InstallRecord> {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::Update,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        emit(operation.started());
        let result = async {
            let _guard = self.library.try_lock_port(port_id, "reviewed-update")?;
            let reviewed = operation
                .interruptible(self.plan_game_update_locked(port_id, activate))
                .await?;
            self.library.consume_authorization(
                authorization,
                "game-update",
                port_id,
                &reviewed.plan_sha256,
            )?;
            let status = self.status(port_id)?;
            self.record_update_check(port_id, &status, &reviewed.plan.release)?;
            let mut reporter = OperationReporter {
                operation: &operation,
                emit: &mut emit,
            };
            self.apply_resolved_release(
                self.catalog.port(port_id)?,
                status,
                InstallOverrides {
                    source: None,
                    bios: None,
                    output_directory: None,
                },
                reviewed.plan.release,
                ReleaseIntent {
                    activate,
                    shared_preferences: reviewed
                        .plan
                        .shared_preferences
                        .as_ref()
                        .map(crate::managed_shared_preferences::Acceptance::after_review),
                },
                &mut reporter,
            )
            .await
        }
        .await;
        let result = self.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }
}

fn game_update_plan_assessment(plan: &crate::InstallPlan) -> crate::PortActionAssessment {
    use crate::{
        InstallPlanAction as Action, PortActionAvailability as Availability,
        PortActionReason as Reason,
    };
    let (availability, reason) = match plan.action {
        Action::AlreadyActive => (Availability::NotOffered, Reason::AlreadyRegistered),
        Action::BlockedUnverified => (Availability::Held, Reason::InvalidInstallation),
        // Verified local reuse does not reacquire original input bytes. Its
        // critical files and retained ownership are checked again at execution.
        Action::UseStaged | Action::ReuseRetained => (Availability::Allowed, Reason::Available),
        Action::Download => match plan
            .source_requirements
            .iter()
            .find(|input| !input.registered)
        {
            Some(input) => (
                Availability::Waiting,
                match input.role {
                    crate::SourceRequirementRole::GameSource => Reason::MissingSource,
                    crate::SourceRequirementRole::Bios => Reason::MissingBios,
                },
            ),
            None => (Availability::Allowed, Reason::Available),
        },
    };
    crate::PortActionAssessment {
        action: crate::PortAction::Update,
        availability,
        reason,
        definition: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ErrorCode, Library, UpdatePolicy,
        service::tests::{register_zelda_install, service_with_release},
    };

    const PORT: &str = "zelda64-recomp";

    #[tokio::test]
    async fn an_unverified_retained_plan_cannot_authorize_execution() {
        let (_temporary, service) = fixture();
        service.activate_staged(PORT).unwrap();
        service
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE installs SET verified=0 WHERE port_id=?1 AND version='v1'",
                [PORT],
            )
            .unwrap();
        let previous = service_with_release(service.library.clone(), "v1");
        let review = previous.plan_game_update(PORT, true).await.unwrap();
        assert_eq!(
            review.plan.action,
            crate::InstallPlanAction::BlockedUnverified
        );
        assert_eq!(
            review.assessment.availability,
            crate::PortActionAvailability::Held
        );
        assert_eq!(
            review.assessment.reason,
            crate::PortActionReason::InvalidInstallation
        );
        assert_eq!(
            previous
                .authorize_game_update(PORT, true, &review.plan_sha256)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Verification
        );
        assert_eq!(previous.status(PORT).unwrap().active.unwrap().version, "v2");
    }

    #[tokio::test]
    async fn an_unverified_matching_staged_update_is_held() {
        let (_temporary, service) = fixture();
        service
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE installs SET verified=0 WHERE port_id=?1 AND version='v2'",
                [PORT],
            )
            .unwrap();
        let before = service.status(PORT).unwrap();
        let review = service.plan_game_update(PORT, false).await.unwrap();
        assert_eq!(
            review.plan.action,
            crate::InstallPlanAction::BlockedUnverified
        );
        assert_eq!(
            review.assessment.availability,
            crate::PortActionAvailability::Held
        );
        assert_eq!(
            review.assessment.reason,
            crate::PortActionReason::InvalidInstallation
        );
        assert_eq!(
            service
                .authorize_game_update(PORT, false, &review.plan_sha256)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Verification
        );
        let after = service.status(PORT).unwrap();
        assert_eq!(after.active.unwrap().id, before.active.unwrap().id);
        assert_eq!(after.staged.unwrap().id, before.staged.unwrap().id);
        assert!(service.library.activities(100).unwrap().is_empty());
    }

    #[test]
    fn staged_activation_needs_no_release_request_and_refuses_replaced_versions() {
        let (_temporary, service) = fixture();
        let before = service.status(PORT).unwrap();
        let active = before.active.as_ref().map(|install| install.id.as_str());
        let staged = before.staged.as_ref().unwrap();
        assert_eq!(
            service
                .activate_staged_reviewed(PORT, active, "stale-staged-id")
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            service
                .activate_staged_reviewed(PORT, Some("stale-active-id"), &staged.id)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v1");
        // The ordinary provider has no test release endpoint. Local activation
        // succeeds without attempting to resolve the current upstream release.
        let offline = PortcoveService::new(Library::open(service.library.root()).unwrap()).unwrap();
        let activated = offline
            .activate_staged_reviewed(PORT, active, &staged.id)
            .unwrap();
        assert_eq!(activated.version, "v2");
        assert_eq!(
            offline.status(PORT).unwrap().previous.unwrap().version,
            "v1"
        );
    }

    fn fixture() -> (tempfile::TempDir, PortcoveService) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);
        (temporary, service_with_release(library, "v2"))
    }

    #[tokio::test]
    async fn update_assessment_requires_review_and_preserves_local_reuse_without_original_inputs() {
        use crate::{
            PortAction, PortActionAvailability as Availability, PortActionReason as Reason,
        };
        let (_temporary, service) = fixture();
        let empty = service_with_release(
            Library::open(_temporary.path().join("empty-library")).unwrap(),
            "v2",
        );
        let empty_status = empty.status(PORT).unwrap();
        let absent = empty_status
            .port_actions
            .iter()
            .find(|action| action.action == PortAction::Update)
            .unwrap();
        assert_eq!(absent.availability, Availability::NotOffered);
        assert_eq!(absent.reason, Reason::NotInstalled);
        let status = service.status(PORT).unwrap();
        let pending = status
            .port_actions
            .iter()
            .find(|action| action.action == PortAction::Update)
            .unwrap();
        assert_eq!(pending.availability, Availability::Waiting);
        assert_eq!(pending.reason, Reason::ReviewRequired);
        let activities = service.library.activities(100).unwrap().len();
        let review = service.plan_game_update(PORT, false).await.unwrap();
        assert_eq!(review.plan.action, crate::InstallPlanAction::UseStaged);
        assert!(
            review
                .plan
                .source_requirements
                .iter()
                .any(|input| !input.registered)
        );
        assert_eq!(review.assessment.availability, Availability::Allowed);
        assert_eq!(review.assessment.reason, Reason::Available);
        assert_eq!(
            service.status(PORT).unwrap().active.unwrap().id,
            status.active.unwrap().id
        );
        assert_eq!(service.library.activities(100).unwrap().len(), activities);
        // An allowed preview does not supply an execution token.
        assert!(
            service
                .apply_game_update(PORT, false, "preview-is-not-authorization", |_| {})
                .await
                .is_err()
        );
        service.activate_staged(PORT).unwrap();
        let current = service.plan_game_update(PORT, true).await.unwrap();
        assert_eq!(current.assessment.availability, Availability::NotOffered);
        assert_eq!(current.assessment.reason, Reason::AlreadyRegistered);
    }

    #[tokio::test]
    async fn update_download_assessment_distinguishes_original_input_and_bios() {
        let (_temporary, service) = fixture();
        let next = service_with_release(service.library.clone(), "v3");
        let mut review = next.plan_game_update(PORT, false).await.unwrap();
        assert_eq!(review.plan.action, crate::InstallPlanAction::Download);
        assert_eq!(
            review.assessment.availability,
            crate::PortActionAvailability::Waiting
        );
        assert_eq!(
            review.assessment.reason,
            crate::PortActionReason::MissingSource
        );
        review.plan.source_requirements[0].role = crate::SourceRequirementRole::Bios;
        assert_eq!(
            game_update_plan_assessment(&review.plan).reason,
            crate::PortActionReason::MissingBios
        );
        review.plan.source_requirements[0].registered = true;
        assert_eq!(
            game_update_plan_assessment(&review.plan).availability,
            crate::PortActionAvailability::Allowed
        );
    }

    #[test]
    fn saving_every_policy_changes_no_installation_or_activity_and_survives_restart() {
        let (_temporary, service) = fixture();
        let before = service.status(PORT).unwrap();
        let tree = crate::library_transfer::reviewed_tree(&service.library.versions_dir()).unwrap();
        let activities = service.library.activities(100).unwrap().len();
        for policy in [
            UpdatePolicy::Stage,
            UpdatePolicy::Automatic,
            UpdatePolicy::Notify,
        ] {
            let saved = service.set_update_policy(PORT, policy).unwrap();
            assert_eq!(saved.update_policy, policy);
            assert_eq!(
                saved.active.as_ref().unwrap().id,
                before.active.as_ref().unwrap().id
            );
            assert_eq!(
                saved.staged.as_ref().unwrap().id,
                before.staged.as_ref().unwrap().id
            );
            assert_eq!(service.library.activities(100).unwrap().len(), activities);
            assert_eq!(
                crate::library_transfer::reviewed_tree(&service.library.versions_dir()).unwrap(),
                tree
            );
            let reopened =
                service_with_release(Library::open(service.library.root()).unwrap(), "v2");
            assert_eq!(reopened.status(PORT).unwrap().update_policy, policy);
        }
    }

    #[tokio::test]
    async fn reviewed_stage_and_activation_are_explicit_and_ignore_saved_automatic_policy() {
        let (_temporary, service) = fixture();
        service
            .set_update_policy(PORT, UpdatePolicy::Automatic)
            .unwrap();
        let stage = service.plan_game_update(PORT, false).await.unwrap();
        let activate = service.plan_game_update(PORT, true).await.unwrap();
        assert_ne!(stage.plan_sha256, activate.plan_sha256);
        assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v1");
        assert!(service.library.activities(100).unwrap().is_empty());
        let grant = service
            .authorize_game_update(PORT, false, &stage.plan_sha256)
            .await
            .unwrap();
        service
            .apply_game_update(PORT, false, &grant.token, |_| {})
            .await
            .unwrap();
        let staged = service.status(PORT).unwrap();
        assert_eq!(staged.active.unwrap().version, "v1");
        assert_eq!(staged.staged.unwrap().version, "v2");
        let activate = service.plan_game_update(PORT, true).await.unwrap();
        let grant = service
            .authorize_game_update(PORT, true, &activate.plan_sha256)
            .await
            .unwrap();
        service
            .apply_game_update(PORT, true, &grant.token, |_| {})
            .await
            .unwrap();
        let status = service.status(PORT).unwrap();
        assert_eq!(status.active.unwrap().version, "v2");
        assert_eq!(status.previous.unwrap().version, "v1");
        assert_eq!(status.update_policy, UpdatePolicy::Automatic);
        assert!(
            service
                .apply_game_update(PORT, true, &grant.token, |_| {})
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn stale_policy_release_and_wrong_execution_mode_fail_before_activation() {
        let (_temporary, service) = fixture();
        let review = service.plan_game_update(PORT, false).await.unwrap();
        service
            .set_update_policy(PORT, UpdatePolicy::Automatic)
            .unwrap();
        assert_eq!(
            service
                .authorize_game_update(PORT, false, &review.plan_sha256)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let review = service.plan_game_update(PORT, false).await.unwrap();
        let grant = service
            .authorize_game_update(PORT, false, &review.plan_sha256)
            .await
            .unwrap();
        assert!(
            service
                .apply_game_update(PORT, true, &grant.token, |_| {})
                .await
                .is_err()
        );
        let changed = service_with_release(service.library.clone(), "v3");
        assert_eq!(
            changed
                .authorize_game_update(PORT, false, &review.plan_sha256)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v1");
    }

    #[tokio::test]
    async fn cancellation_and_invalid_retained_bytes_preserve_the_active_version() {
        let (_temporary, service) = fixture();
        let review = service.plan_game_update(PORT, true).await.unwrap();
        let grant = service
            .authorize_game_update(PORT, true, &review.plan_sha256)
            .await
            .unwrap();
        let result = service
            .apply_game_update(PORT, true, &grant.token, |event| {
                if matches!(event.event, crate::OperationEventKind::Started) {
                    service.request_cancellation(&event.operation_id).unwrap();
                }
            })
            .await;
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v1");
        let review = service.plan_game_update(PORT, true).await.unwrap();
        let grant = service
            .authorize_game_update(PORT, true, &review.plan_sha256)
            .await
            .unwrap();
        let staged = service.status(PORT).unwrap().staged.unwrap();
        std::fs::write(staged.path.join(&staged.selected_executable), b"damaged").unwrap();
        assert!(
            service
                .apply_game_update(PORT, true, &grant.token, |_| {})
                .await
                .is_err()
        );
        assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v1");
    }
}
