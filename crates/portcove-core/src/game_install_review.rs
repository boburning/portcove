//! First-install consent over the existing installer and authorization boundary.
use super::{InstallOverrides, OperationReporter};
use crate::{
    ActivityOperation, ActivityTargetKind, DestructiveAuthorization, GameInstallPlan,
    InstallRecord, OperationEvent, OperationResult, PortcoveError, PortcoveService, Result,
};

impl PortcoveService {
    pub async fn plan_game_install(&self, port_id: &str) -> Result<GameInstallPlan> {
        let _guard = self.library.try_lock_port(port_id, "review-install")?;
        self.plan_game_install_locked(port_id).await
    }

    async fn plan_game_install_locked(&self, port_id: &str) -> Result<GameInstallPlan> {
        let status = self.status(port_id)?;
        if status.active.is_some() {
            return Err(PortcoveError::conflict(
                "this game is already installed; refresh before choosing setup, Play or an explicit update",
            ));
        }
        let plan = self.plan_install(port_id, Some(status.channel)).await?;
        let selected_install = match plan.action {
            crate::InstallPlanAction::UseStaged => status.staged.clone(),
            crate::InstallPlanAction::ReuseRetained
            | crate::InstallPlanAction::BlockedUnverified => self.library.install_by_artifact(
                port_id,
                &plan.release.asset.sha256,
                crate::runtime::required(self.catalog.port(port_id)?, plan.platform).as_ref(),
            )?,
            _ => None,
        };
        let common_digest = self.game_release_review_digest(
            "Portcove first game install review v1",
            &plan,
            &status,
            true,
        )?;
        // Preserve the existing update representation. First installation also
        // binds the actual reuse target and authoritative referenced source graph.
        let definition =
            crate::installed_contract::InstalledContract::capture(&self.catalog, port_id)?;
        let plan_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
            "Portcove first game install exact inputs v1",
            common_digest,
            &selected_install,
            definition,
        ))?);
        Ok(GameInstallPlan {
            plan,
            selected_install,
            plan_sha256,
        })
    }

    pub async fn authorize_game_install(
        &self,
        port_id: &str,
        expected_plan: &str,
    ) -> Result<DestructiveAuthorization> {
        let reviewed = self.plan_game_install(port_id).await?;
        if reviewed.plan_sha256 != expected_plan {
            return Err(PortcoveError::conflict(
                "installation inputs changed; review installation again",
            ));
        }
        if reviewed.plan.action == crate::InstallPlanAction::BlockedUnverified {
            return Err(PortcoveError::verification(
                "verify or repair the retained copy before installation",
            ));
        }
        Self::require_registered_install_inputs(&reviewed)?;
        self.library
            .issue_authorization("game-install", port_id, expected_plan)
    }

    pub async fn apply_game_install(
        &self,
        port_id: &str,
        authorization: &str,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<InstallRecord> {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::Install,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        emit(operation.started());
        let result = async {
            let _guard = self.library.try_lock_port(port_id, "reviewed-install")?;
            let reviewed = operation
                .interruptible(self.plan_game_install_locked(port_id))
                .await?;
            Self::require_registered_install_inputs(&reviewed)?;
            self.library.consume_authorization(
                authorization,
                "game-install",
                port_id,
                &reviewed.plan_sha256,
            )?;
            let status = self.status(port_id)?;
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
                true,
                &mut reporter,
            )
            .await
        }
        .await;
        let result = self.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }

    fn require_registered_install_inputs(reviewed: &GameInstallPlan) -> Result<()> {
        if reviewed.plan.action == crate::InstallPlanAction::Download
            && reviewed
                .plan
                .source_requirements
                .iter()
                .any(|source| !source.registered)
        {
            return Err(PortcoveError::conflict(
                "register and review the required original files before reviewing installation",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        ErrorCode, Library,
        service::tests::{register_zelda_install, service_with_release},
    };
    const PORT: &str = "zelda64-recomp";

    fn register_review_source(library: &Library) {
        let catalog = crate::Catalog::embedded().unwrap();
        library
            .register_source(&crate::SourceRecord {
                profile_id: catalog.port(PORT).unwrap().source_profile.clone().unwrap(),
                path: library.root().join("original.z64"),
                sha256: "b".repeat(64),
                size: 1,
                storage_sha256: "b".repeat(64),
                storage_size: 1,
                updated_at: 1,
                observed_identity: None,
            })
            .unwrap();
    }

    #[tokio::test]
    async fn reviewed_first_install_reuses_verified_staged_bytes_and_consumes_consent() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let existing_path = register_zelda_install(&library, "v1", false);
        library
            .set_output_directory(
                PORT,
                Some(&temporary.path().join("future-output")),
                crate::ReleaseChannel::Stable,
            )
            .unwrap();
        let service = service_with_release(library, "v1");
        let plan = service.plan_game_install(PORT).await.unwrap();
        assert_eq!(plan.selected_install.as_ref().unwrap().path, existing_path);
        assert!(service.status(PORT).unwrap().active.is_none());
        let authorization = service
            .authorize_game_install(PORT, &plan.plan_sha256)
            .await
            .unwrap();
        let installed = service
            .apply_game_install(PORT, &authorization.token, |_| {})
            .await
            .unwrap();
        assert_eq!(installed.version, "v1");
        assert_eq!(installed.path, existing_path);
        assert_eq!(
            service
                .library
                .consume_authorization(
                    &authorization.token,
                    "game-install",
                    PORT,
                    &plan.plan_sha256
                )
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );

        assert_eq!(
            service.status(PORT).unwrap().active.unwrap().id,
            installed.id
        );
        assert_eq!(
            service
                .apply_game_install(PORT, &authorization.token, |_| {})
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[tokio::test]
    async fn changed_release_refuses_both_authorization_and_execution_without_installing() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_review_source(&library);
        let service = service_with_release(library.clone(), "v1");
        let plan = service.plan_game_install(PORT).await.unwrap();
        let authorization = service
            .authorize_game_install(PORT, &plan.plan_sha256)
            .await
            .unwrap();
        let changed = service_with_release(library, "v2");
        assert_eq!(
            changed
                .authorize_game_install(PORT, &plan.plan_sha256)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            changed
                .apply_game_install(PORT, &authorization.token, |_| {})
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(changed.status(PORT).unwrap().active.is_none());
        assert!(changed.status(PORT).unwrap().staged.is_none());
        assert!(changed.status(PORT).unwrap().previous.is_none());
    }
    #[tokio::test]
    async fn changed_source_registration_and_destination_invalidate_consent() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_review_source(&library);
        let service = service_with_release(library.clone(), "v1");
        let review = service.plan_game_install(PORT).await.unwrap();
        let grant = service
            .authorize_game_install(PORT, &review.plan_sha256)
            .await
            .unwrap();
        library
            .register_source(&crate::SourceRecord {
                profile_id: service
                    .catalog
                    .port(PORT)
                    .unwrap()
                    .source_profile
                    .clone()
                    .unwrap(),
                path: temporary.path().join("registered-source.z64"),
                sha256: "a".repeat(64),
                size: 1,
                storage_sha256: "a".repeat(64),
                storage_size: 1,
                updated_at: 7,
                observed_identity: None,
            })
            .unwrap();
        assert_eq!(
            service
                .apply_game_install(PORT, &grant.token, |_| {})
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let review = service.plan_game_install(PORT).await.unwrap();
        let grant = service
            .authorize_game_install(PORT, &review.plan_sha256)
            .await
            .unwrap();
        library
            .set_output_directory(
                PORT,
                Some(&temporary.path().join("new-destination")),
                crate::ReleaseChannel::Stable,
            )
            .unwrap();
        assert_eq!(
            service
                .authorize_game_install(PORT, &review.plan_sha256)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            service
                .apply_game_install(PORT, &grant.token, |_| {})
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(service.status(PORT).unwrap().active.is_none());
        assert!(!temporary.path().join("new-destination").exists());
    }

    #[tokio::test]
    async fn cancellation_preserves_staged_version_and_reports_terminal_cancelled() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", false);
        let service = service_with_release(library, "v1");
        let review = service.plan_game_install(PORT).await.unwrap();
        let grant = service
            .authorize_game_install(PORT, &review.plan_sha256)
            .await
            .unwrap();
        let result = service
            .apply_game_install(PORT, &grant.token, |event| {
                if matches!(event.event, crate::OperationEventKind::Started) {
                    service.request_cancellation(&event.operation_id).unwrap();
                }
            })
            .await;
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        let status = service.status(PORT).unwrap();
        assert!(status.active.is_none());
        assert_eq!(status.staged.unwrap().version, "v1");
        assert_eq!(
            service.library.activities(1).unwrap()[0].status,
            crate::ActivityStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn an_active_install_cannot_be_changed_by_first_install_consent() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", true);
        let service = service_with_release(library, "v2");
        assert_eq!(
            service.plan_game_install(PORT).await.unwrap_err().code,
            ErrorCode::Conflict
        );
        assert_eq!(
            service
                .authorize_game_install(PORT, &"a".repeat(64))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            service
                .ensure(PORT, None, None, None, |_| {})
                .await
                .unwrap()
                .version,
            "v1"
        );
        assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v1");
    }

    #[tokio::test]
    async fn reuse_review_binds_actual_copy_after_future_destination_changes() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let original_path = register_zelda_install(&library, "v1", false);
        // Keep the record as a non-primary retained copy, outside status.staged.
        library
            .connection()
            .unwrap()
            .execute("UPDATE installs SET staged=0", [])
            .unwrap();
        library
            .set_output_directory(
                PORT,
                Some(&temporary.path().join("future-output")),
                crate::ReleaseChannel::Stable,
            )
            .unwrap();
        let service = service_with_release(library.clone(), "v1");
        let review = service.plan_game_install(PORT).await.unwrap();
        assert_eq!(review.plan.action, crate::InstallPlanAction::ReuseRetained);
        assert!(service.status(PORT).unwrap().staged.is_none());
        assert_eq!(
            review.selected_install.as_ref().unwrap().path,
            original_path
        );
        assert_ne!(
            review.plan.output_location.effective_output_directory,
            original_path
        );
        let grant = service
            .authorize_game_install(PORT, &review.plan_sha256)
            .await
            .unwrap();
        // A changed retained target does not change the action or primary status.
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE installs SET path=?1",
                [temporary.path().join("changed-copy").to_str().unwrap()],
            )
            .unwrap();
        let changed = service.plan_game_install(PORT).await.unwrap();
        assert_eq!(changed.plan.action, crate::InstallPlanAction::ReuseRetained);
        assert_ne!(review.plan_sha256, changed.plan_sha256);
        assert_eq!(
            service
                .apply_game_install(PORT, &grant.token, |_| {})
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[tokio::test]
    async fn missing_registration_refuses_inbox_discovery_without_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = service_with_release(library.clone(), "v1");
        let review = service.plan_game_install(PORT).await.unwrap();
        let profile = review.plan.source_requirements[0].profile_id.clone();
        let inbox = library.source_inbox_profile_dir(&profile).unwrap();
        std::fs::create_dir_all(&inbox).unwrap();
        std::fs::write(inbox.join("unreviewed.z64"), b"unreviewed original").unwrap();
        assert_eq!(
            service.plan_game_install(PORT).await.unwrap().plan_sha256,
            review.plan_sha256
        );
        assert_eq!(
            service
                .authorize_game_install(PORT, &review.plan_sha256)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        // Also guard execution against bypassing the public authorization method.
        let grant = library
            .issue_authorization("game-install", PORT, &review.plan_sha256)
            .unwrap();
        assert_eq!(
            service
                .apply_game_install(PORT, &grant.token, |_| {})
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(library.sources().unwrap().is_empty());
        assert_eq!(
            std::fs::read(inbox.join("unreviewed.z64")).unwrap(),
            b"unreviewed original"
        );
    }

    #[tokio::test]
    async fn changed_referenced_source_definition_invalidates_registered_input_review() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_review_source(&library);
        let mut service = service_with_release(library.clone(), "v1");
        // Both sides use the same supported legacy projection; only the
        // referenced source validator changes after the initial consent.
        let mut document = service.catalog.document().clone();
        document.schema_version = 1;
        document.source_catalog = None;
        service.replace_catalog_for_test(
            crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let review = service.plan_game_install(PORT).await.unwrap();
        let common_digest = service
            .game_release_review_digest(
                "Portcove first game install review v1",
                &review.plan,
                &service.status(PORT).unwrap(),
                true,
            )
            .unwrap();
        let grant = service
            .authorize_game_install(PORT, &review.plan_sha256)
            .await
            .unwrap();
        let mut changed = service_with_release(library, "v1");
        let profile = document
            .ports
            .iter()
            .find(|port| port.id == PORT)
            .unwrap()
            .source_profile
            .clone()
            .unwrap();
        document
            .source_profiles
            .iter_mut()
            .find(|source| source.id == profile)
            .unwrap()
            .accepted_sha256
            .push("c".repeat(64));
        changed.replace_catalog_for_test(
            crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
        let changed_plan = changed.plan_game_install(PORT).await.unwrap();
        assert_eq!(
            common_digest,
            changed
                .game_release_review_digest(
                    "Portcove first game install review v1",
                    &changed_plan.plan,
                    &changed.status(PORT).unwrap(),
                    true,
                )
                .unwrap()
        );
        assert_ne!(review.plan_sha256, changed_plan.plan_sha256);
        assert_eq!(
            changed
                .authorize_game_install(PORT, &review.plan_sha256)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            changed
                .apply_game_install(PORT, &grant.token, |_| {})
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(changed.status(PORT).unwrap().active.is_none());
    }
}
