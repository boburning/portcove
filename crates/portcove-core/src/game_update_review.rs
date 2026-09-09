//! Exact review for explicit game updates; saved policy never chooses the action.
use super::{InstallOverrides, OperationReporter};
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
        let port = self.catalog.port(port_id)?;
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
        let plan_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
            "Portcove game update review v1",
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
        Ok(GameUpdatePlan {
            plan,
            activate,
            plan_sha256,
        })
    }

    pub async fn authorize_game_update(
        &self,
        port_id: &str,
        activate: bool,
        expected_plan: &str,
    ) -> Result<DestructiveAuthorization> {
        let reviewed = self.plan_game_update(port_id, activate).await?;
        if reviewed.plan_sha256 != expected_plan {
            return Err(PortcoveError::conflict(
                "update inputs changed; review the update again",
            ));
        }
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
                activate,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ErrorCode, Library, UpdatePolicy,
        service::tests::{register_zelda_install, service_with_release},
    };

    const PORT: &str = "zelda64-recomp";

    fn fixture() -> (tempfile::TempDir, PortcoveService) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        register_zelda_install(&library, "v2", false);
        (temporary, service_with_release(library, "v2"))
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
