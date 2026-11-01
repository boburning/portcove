//! First-install consent over the existing installer and authorization boundary.
use super::{InstallOverrides, OperationReporter, ReleaseIntent};
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
        self.require_managed_runtime_ownership(&status)?;
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
        self.authorize_game_install_with_shared_preferences_ack(port_id, expected_plan, None)
            .await
    }

    pub async fn authorize_game_install_with_shared_preferences_ack(
        &self,
        port_id: &str,
        expected_plan: &str,
        acknowledged: Option<&str>,
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
        crate::external_runtime::shared_preferences::require_scoped_ack(
            reviewed.plan.shared_preferences.is_some(),
            expected_plan,
            acknowledged,
        )?;
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
            operation.observe_release(&reviewed.plan.release.version, None);
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
                    acquired: None,
                    activate: true,
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

    fn source_setup_fixture(
        variant: &str,
    ) -> (
        tempfile::TempDir,
        crate::PortcoveService,
        std::path::PathBuf,
    ) {
        let (temporary, configured, path) = crate::source_reuse::tests::fixture(variant);
        let mut service = service_with_release(configured.library().clone(), "v1");
        service.replace_catalog_for_test(configured.catalog().clone());
        (temporary, service, path)
    }

    #[tokio::test]
    async fn known_excluded_override_refuses_before_changing_the_registered_original() {
        let (temporary, service, original) = source_setup_fixture("ntsc-u-1-0");
        let baseline = serde_json::to_value(service.library().sources().unwrap()).unwrap();
        let excluded = temporary.path().join("controlled-gamecube.z64");
        std::fs::write(&excluded, crate::source_reuse::tests::GC_BYTES).unwrap();
        let error = service
            .install(PORT, None, Some(&excluded), None, true, |_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceInvalid);
        assert!(error.message.contains("not supported"));
        assert!(error.message.contains("Choose"));
        assert_eq!(
            serde_json::to_value(service.library().sources().unwrap()).unwrap(),
            baseline
        );
        assert!(service.status(PORT).unwrap().active.is_none());
        assert_eq!(
            std::fs::read(original).unwrap(),
            crate::source_reuse::tests::USA_BYTES
        );
        assert_eq!(
            std::fs::read(excluded).unwrap(),
            crate::source_reuse::tests::GC_BYTES
        );
    }

    #[tokio::test]
    async fn known_excluded_saved_original_refuses_fresh_setup_without_rebaselining() {
        let (_temporary, service, _) = source_setup_fixture("ntsc-u-gamecube");
        let baseline = serde_json::to_value(service.library().sources().unwrap()).unwrap();
        let error = service
            .install(PORT, None, None, None, true, |_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceInvalid);
        assert_eq!(
            serde_json::to_value(service.library().sources().unwrap()).unwrap(),
            baseline
        );
        assert!(service.status(PORT).unwrap().active.is_none());
    }

    #[test]
    fn original_setup_preserves_supported_replacements_and_unknown_informational_inputs() {
        use crate::OperationCoordinator;
        let (temporary, service, gamecube) = source_setup_fixture("ntsc-u-gamecube");
        let operation = OperationCoordinator::new("source-setup-contract", None);
        {
            let port = service.catalog().port("2ship2harkinian").unwrap();
            let _lock = service
                .library()
                .try_lock_port(&port.id, "install")
                .unwrap();
            let accepted = service
                .validate_and_remember_source(port, Some(&gamecube), &operation)
                .unwrap()
                .unwrap();
            assert_eq!(
                accepted.sha256,
                service
                    .library()
                    .source("majoras-mask")
                    .unwrap()
                    .unwrap()
                    .sha256
            );
        }
        let usa = temporary.path().join("selected-usa.z64");
        std::fs::write(&usa, crate::source_reuse::tests::USA_BYTES).unwrap();
        let unknown = temporary.path().join("selected-unknown.z64");
        std::fs::write(
            &unknown,
            b"\x80\x37\x12\x40controlled legacy informational input",
        )
        .unwrap();
        for selected in [&usa, &unknown] {
            let port = service.catalog().port(PORT).unwrap();
            let _lock = service.library().try_lock_port(PORT, "install").unwrap();
            let accepted = service
                .validate_and_remember_source(port, Some(selected), &operation)
                .unwrap()
                .unwrap();
            assert_eq!(accepted.path, std::fs::canonicalize(selected).unwrap());
        }
        let review = service.review_source_reuse("majoras-mask").unwrap();
        let app = review
            .applications
            .iter()
            .find(|app| app.port_id == PORT)
            .unwrap();
        assert_eq!(
            app.compatibility,
            crate::SourceReuseCompatibility::Potential
        );
        assert!(app.can_review_setup);
        assert_eq!(
            review
                .inspection
                .applications
                .iter()
                .find(|app| app.port_id == PORT)
                .unwrap()
                .contract
                .admission_mode,
            crate::CatalogAdmissionMode::Informational
        );
    }

    #[tokio::test]
    async fn known_excluded_inbox_candidate_is_not_registered_during_fresh_setup() {
        let (temporary, configured, _) = source_setup_fixture("ntsc-u-1-0");
        let library = Library::open(temporary.path().join("inbox-library")).unwrap();
        let mut service = service_with_release(library.clone(), "v1");
        service.replace_catalog_for_test(configured.catalog().clone());
        let inbox = library.source_inbox_profile_dir("majoras-mask").unwrap();
        std::fs::create_dir_all(&inbox).unwrap();
        let selected = inbox.join("controlled-gamecube.z64");
        std::fs::write(&selected, crate::source_reuse::tests::GC_BYTES).unwrap();
        let error = service
            .install(PORT, None, None, None, true, |_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceInvalid);
        assert!(library.sources().unwrap().is_empty());
        assert!(service.status(PORT).unwrap().active.is_none());
        assert_eq!(
            std::fs::read(selected).unwrap(),
            crate::source_reuse::tests::GC_BYTES
        );
    }

    #[tokio::test]
    async fn checked_original_reuse_guard_survives_the_existing_install_path_without_reregistering()
    {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        register_zelda_install(&library, "v1", false);
        let service = service_with_release(library.clone(), "v1");
        let original = temporary.path().join("controlled.z64");
        std::fs::write(
            &original,
            b"\x80\x37\x12\x40synthetic guarded-install source",
        )
        .unwrap();
        service.register_source("majoras-mask", &original).unwrap();
        let review = service.review_source_reuse("majoras-mask").unwrap();
        let baseline = serde_json::to_value(library.source("majoras-mask").unwrap()).unwrap();
        let _guard = service
            .lock_source_reuse(PORT, &review.reference, Some(&original))
            .unwrap();
        let installed = service
            .install(PORT, None, None, None, true, |_| {})
            .await
            .unwrap();
        assert_eq!(installed.version, "v1");
        assert_eq!(
            serde_json::to_value(library.source("majoras-mask").unwrap()).unwrap(),
            baseline
        );
        assert_eq!(
            std::fs::read(original).unwrap(),
            b"\x80\x37\x12\x40synthetic guarded-install source"
        );
    }

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
        // Keep its immutable manifest with the actual copy at the new location.
        let changed_path = temporary.path().join("changed-copy");
        std::fs::rename(&original_path, &changed_path).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE installs SET path=?1",
                [changed_path.to_str().unwrap()],
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
        // Keep the reviewed port; unrelated modern Native6 ports cannot be
        // represented after deleting their schema-2 source authority.
        document.ports.retain(|port| port.id == PORT);
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
