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

    pub(super) async fn plan_game_update_locked(
        &self,
        port_id: &str,
        activate: bool,
    ) -> Result<GameUpdatePlan> {
        self.plan_game_update_with_data_locked(port_id, activate, true)
            .await
    }

    pub(super) async fn plan_game_update_with_data_locked(
        &self,
        port_id: &str,
        activate: bool,
        review_data: bool,
    ) -> Result<GameUpdatePlan> {
        self.plan_game_update_with_status(port_id, activate, review_data)
            .await
            .map(|(plan, _, _)| plan)
    }

    pub(super) async fn plan_game_update_with_status(
        &self,
        port_id: &str,
        activate: bool,
        review_data: bool,
    ) -> Result<(
        GameUpdatePlan,
        crate::PortStatus,
        crate::ScopedResolvedRelease,
    )> {
        let status = self.status(port_id)?;
        if status.active.is_none() {
            return Err(PortcoveError::not_found(
                "install this game before reviewing an update",
            ));
        }
        let (mut plan, resolution) = self
            .plan_install_resolution(port_id, Some(status.channel), None, None)
            .await?;
        let explicit_package_proof_sha256 = resolution.explicit_package_proof_sha256()?;
        let transition = if review_data {
            self.archive_data_transition_review(port_id, &plan.release)?
        } else {
            None
        };
        let data_transition = transition.as_ref().map(|review| {
            let available_bytes = fs4::available_space(self.library.root()).ok();
            plan.preservation_notices.push(format!("This first update preserves the current runtime and its build-specific states while carrying conventional saves/settings through the reviewed data transition. Keep the old runtime in Versions when your progress exists only in its snapshots. No state conversion or save rewind is performed. Temporary preservation needs an additional {} MiB in this library.", review.required_bytes.div_ceil(1024 * 1024)));
            crate::ArchiveDataTransitionReview { preimage_sha256:review.preimage_sha256.clone(), producing_archive_sha256:review.active.artifact.sha256.clone(), retained_installations:review.installs.len() as u32,
                temporary_space:crate::InstallSpaceRequirement { path:self.library.root().to_path_buf(), required_bytes:review.required_bytes, available_bytes, volume_identity:None, sufficient:available_bytes.map(|available|available>=review.required_bytes) } }
        });
        let assessment = game_update_plan_assessment(&plan);
        let offer_archive = review_data
            && plan.action == crate::InstallPlanAction::Download
            && assessment.availability == crate::PortActionAvailability::Allowed
            && self.require_acquisition_state(&status, &plan).is_ok();
        let (mut plan_sha256, mut archive_only_plan_sha256) = self.game_release_review_digests(
            "Portcove game update review v1",
            &plan,
            &status,
            activate,
            offer_archive,
        )?;
        // Even a nonmatching archive owns a retained slot; replacing/discarding it invalidates review.
        if let Some(acquisition) = &status.acquisition {
            plan_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
                "Portcove acquired update review v1",
                plan_sha256,
                acquisition,
            ))?);
        }
        let acquisition =
            self.acquisition_for_review(&status, &plan, explicit_package_proof_sha256.as_deref())?;
        if let Some(proof) = &explicit_package_proof_sha256 {
            let bind_package = |digest: &str| {
                serde_json::to_vec(&(
                    "Portcove reviewed update explicit package v2",
                    digest,
                    proof,
                ))
                .map(|bytes| crate::signed_catalog::digest(&bytes))
            };
            plan_sha256 = bind_package(&plan_sha256)?;
            archive_only_plan_sha256 = archive_only_plan_sha256
                .as_deref()
                .map(bind_package)
                .transpose()?;
        }
        // Informational and outside the digest: edited upstream notes never
        // invalidate a reviewed update. Read from cached metadata only.
        let release_notes = self.update_release_notes(port_id, &plan, &status)?;
        if let Some(review) = &transition {
            plan_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
                "Portcove reviewed archive data transition v1",
                plan_sha256,
                &review.preimage_sha256,
                review.required_bytes,
            ))?);
        }
        let reviewed = GameUpdatePlan {
            explicit_package_proof_sha256,
            acquisition,
            data_transition,
            assessment,
            plan,
            activate,
            plan_sha256,
            archive_only_plan_sha256,
            release_notes,
        };
        Ok((reviewed, status, resolution))
    }

    /// The release list link is kept only when Desktop's reviewed-link check would
    /// open it. Each entry's release page is kept only with that list and only when
    /// it is a plain-tag release page of this port's own release repository.
    fn update_release_notes(
        &self,
        port_id: &str,
        plan: &crate::InstallPlan,
        status: &crate::PortStatus,
    ) -> Result<Option<crate::UpdateReleaseNotes>> {
        if plan.action == crate::InstallPlanAction::AlreadyActive {
            return Ok(None);
        }
        let port = self.catalog.port(port_id)?;
        let Some(mut notes) = self.releases.cached_release_notes(
            port,
            plan.channel,
            plan.platform,
            status.active.as_ref().map(|active| active.version.as_str()),
            &plan.release.version,
        ) else {
            return Ok(None);
        };
        if let Some(url) = &notes.releases_url {
            let reviewed = self.is_reviewed_resource_url(url);
            keep_reviewed_link(&mut notes, reviewed);
        }
        // Without an openable list, no release page is offered either. The page
        // check is the port-bound part of Desktop's reviewed-link check.
        let list_kept = notes.releases_url.is_some();
        for entry in &mut notes.entries {
            entry.url = entry
                .url
                .take()
                .filter(|url| list_kept && super::listings::release_page_url(port, url));
        }
        Ok((!notes.entries.is_empty() || notes.releases_url.is_some()).then_some(notes))
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
        self.game_release_review_digests(domain, plan, status, activate, false)
            .map(|(digest, _)| digest)
    }

    fn game_release_review_digests(
        &self,
        domain: &str,
        plan: &crate::InstallPlan,
        status: &crate::PortStatus,
        activate: bool,
        offer_archive: bool,
    ) -> Result<(String, Option<String>)> {
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
        let digest = |activate| -> Result<String> {
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
                &sources,
                activate,
            ))?);
            let digest = if let Some(pin) = &plan.exact_release {
                crate::signed_catalog::digest(&serde_json::to_vec(&(
                    "Portcove exact release review v1",
                    digest,
                    pin,
                ))?)
            } else {
                digest
            };
            if let Some(shared) = &plan.shared_preferences {
                return Ok(crate::signed_catalog::digest(&serde_json::to_vec(&(
                    "Portcove managed shared preference review v1",
                    digest,
                    shared,
                ))?));
            }
            Ok(digest)
        };
        let reviewed = digest(activate)?;
        let archive = if offer_archive && activate {
            Some(digest(false)?)
        } else {
            offer_archive.then(|| reviewed.clone())
        };
        Ok((reviewed, archive))
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
        let mut data_transition_completed = false;
        let result = async {
            let _guard = self.library.try_lock_port(port_id, "reviewed-update")?;
            let (reviewed, _, mut resolution) = operation
                .interruptible(self.plan_game_update_with_status(port_id, activate, true))
                .await?;
            let port = self.catalog.port(port_id)?;
            if reviewed.data_transition.is_some()
                && let Some(verdict) = self.current_package_shape_refusal(
                    port,
                    reviewed.plan.platform,
                    &resolution.release,
                    Some(&resolution),
                )?
            {
                return Err(crate::package_shape::withheld::refusal(
                    port,
                    &resolution.release,
                    &verdict,
                ));
            }
            self.library.consume_authorization(
                authorization,
                "game-update",
                port_id,
                &reviewed.plan_sha256,
            )?;
            if let Some(transition) = &reviewed.data_transition {
                self.apply_archive_data_transition(
                    port_id,
                    &reviewed.plan.release,
                    &transition.preimage_sha256,
                    &operation,
                )?;
                data_transition_completed = true;
                operation.checkpoint().map_err(|error| {
                    error
                        .with_mutation_state(crate::MutationState::Committed)
                        .detail(
                            "data_transition",
                            "completed; the creating runtime remains active",
                        )
                })?;
            }
            let acquired = self.acquired_inputs(&reviewed, &operation)?;
            let status = self.status(port_id)?;
            operation.observe_release(&reviewed.plan.release.version, None);
            self.record_update_check_from_selection(port_id, &status, &resolution, None)?;
            if resolution.saved_variant.is_none()
                && reviewed.plan.action == crate::InstallPlanAction::Download
                && crate::ManagedPackageVariant::can_record(
                    port,
                    reviewed.plan.platform,
                    &resolution.release,
                )
            {
                resolution.saved_variant = crate::ManagedPackageVariant::from_review(
                    port,
                    reviewed.plan.platform,
                    &resolution,
                );
            }
            let mut reporter = OperationReporter {
                operation: &operation,
                emit: &mut emit,
            };
            self.apply_scoped_release_with_shared(
                port,
                status,
                InstallOverrides {
                    source: None,
                    bios: None,
                    output_directory: None,
                },
                resolution,
                ReleaseIntent {
                    activate,
                    acquired,
                    explicit_package_proof_sha256: reviewed.explicit_package_proof_sha256,
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
        let result = result.map_err(|error| {
            if data_transition_completed {
                error.detail(
                    "data_transition",
                    "completed; retained runtimes and their creating contracts were preserved",
                )
            } else {
                error
            }
        });
        let result = self.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }
}

/// Notes are informational: a link check that cannot complete drops the link,
/// never the review.
fn keep_reviewed_link(notes: &mut crate::UpdateReleaseNotes, reviewed: Result<bool>) {
    match reviewed {
        Ok(true) => {}
        Ok(false) => notes.releases_url = None,
        Err(error) => {
            tracing::warn!(%error, "could not check the release notes link; omitting it");
            notes.releases_url = None;
        }
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
            .find(|input| input.blocks_setup())
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
        restriction: None,
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
    async fn both_update_review_intents_bind_the_exact_provider_identity() {
        let (_temporary, service) = fixture();
        let (reviewed, mut status, _) = service
            .plan_game_update_with_status(PORT, true, false)
            .await
            .unwrap();
        let mut plan = reviewed.plan;
        let release = &plan.release;
        plan.exact_release = Some(crate::ExactReleaseSelection {
            port_id: PORT.into(),
            channel: plan.channel,
            platform: plan.platform,
            version: release.version.clone(),
            filename: release.asset.name.clone(),
            size: release.asset.size,
            sha256: release.asset.sha256.clone(),
            identity: crate::ExactReleaseIdentity::Github {
                repository_id: 1,
                release_id: 2,
                asset_id: 3,
                commit_sha1: "a".repeat(40),
            },
        });
        status.exact_release = plan.exact_release.clone();
        let digest = |plan: &crate::InstallPlan| {
            service
                .game_release_review_digests(
                    "Portcove game update review v1",
                    plan,
                    &status,
                    true,
                    true,
                )
                .unwrap()
        };
        let (install, archive) = digest(&plan);
        let archive = archive.unwrap();
        assert_ne!(install, archive);
        assert_eq!(
            service
                .game_release_review_digest("Portcove game update review v1", &plan, &status, false)
                .unwrap(),
            archive,
        );
        if let crate::ExactReleaseIdentity::Github { asset_id, .. } =
            &mut plan.exact_release.as_mut().unwrap().identity
        {
            *asset_id += 1;
        }
        let (changed_install, changed_archive) = digest(&plan);
        assert_ne!(changed_install, install);
        assert_ne!(changed_archive.as_deref(), Some(archive.as_str()));
        assert!(service.require_acquisition_state(&status, &plan).is_err());
    }

    struct NotesProvider {
        inner: std::sync::Arc<dyn crate::ReleaseProvider>,
        /// Repository used for the release list link; the port's own when `None`.
        repository: Option<String>,
        entries: Vec<crate::UpdateReleaseNotesEntry>,
        requests: std::sync::Mutex<Vec<(Option<String>, String)>>,
        selections: std::sync::atomic::AtomicI64,
    }

    impl NotesProvider {
        fn new(
            service: &PortcoveService,
            repository: Option<&str>,
            entries: Vec<crate::UpdateReleaseNotesEntry>,
        ) -> std::sync::Arc<Self> {
            std::sync::Arc::new(Self {
                inner: service.releases.clone(),
                repository: repository.map(str::to_owned),
                entries,
                requests: Default::default(),
                selections: Default::default(),
            })
        }
    }

    #[async_trait::async_trait]
    impl crate::ReleaseProvider for NotesProvider {
        async fn resolve(
            &self,
            port: &crate::PortDefinition,
            channel: crate::ReleaseChannel,
            platform: crate::Platform,
        ) -> crate::Result<crate::ResolvedRelease> {
            self.inner.resolve(port, channel, platform).await
        }

        async fn resolve_scoped(
            &self,
            port: &crate::PortDefinition,
            channel: crate::ReleaseChannel,
            platform: crate::Platform,
            scope: Option<&crate::DefinitionAcquisitionScope>,
        ) -> crate::Result<crate::ScopedResolvedRelease> {
            use std::sync::atomic::Ordering;
            let mut selection = self
                .inner
                .resolve_scoped(port, channel, platform, scope)
                .await?;
            selection.upstream_activity = Some(crate::UpstreamActivity {
                repository: port.release.repository.clone(),
                observed_at: self.selections.fetch_add(1, Ordering::Relaxed) + 1,
                archived: false,
                last_change_at: None,
            });
            Ok(selection)
        }

        fn cached_release_notes(
            &self,
            port: &crate::PortDefinition,
            _channel: crate::ReleaseChannel,
            _platform: crate::Platform,
            installed: Option<&str>,
            offered: &str,
        ) -> Option<crate::UpdateReleaseNotes> {
            self.requests
                .lock()
                .unwrap()
                .push((installed.map(str::to_owned), offered.to_owned()));
            // Built exactly as the GitHub provider builds it.
            let repository = self
                .repository
                .as_deref()
                .unwrap_or(&port.release.repository);
            let list = format!("https://github.com/{repository}/releases");
            let entries = self
                .entries
                .iter()
                .cloned()
                .map(|mut entry| {
                    entry.url = crate::release_notes::release_page(
                        &list,
                        crate::release_notes::ReleasePage::GithubTag,
                        &entry.version,
                    );
                    entry
                })
                .collect::<Vec<_>>();
            Some(crate::UpdateReleaseNotes {
                releases_url: Some(list),
                coverage: if self.entries.is_empty() {
                    crate::UpdateReleaseNotesCoverage::Unavailable
                } else {
                    crate::UpdateReleaseNotesCoverage::Complete
                },
                entries,
            })
        }
    }

    fn notes_entry() -> crate::UpdateReleaseNotesEntry {
        crate::UpdateReleaseNotesEntry {
            version: "v2".into(),
            title: None,
            published_at: None,
            notes: "Fixes".into(),
            notes_truncated: false,
            url: None,
        }
    }

    /// The embedded port's project is its release repository, so the release list
    /// page the provider builds is a reviewed handoff.
    fn reviewed_repository_service(
        library: &Library,
        provider: std::sync::Arc<NotesProvider>,
    ) -> PortcoveService {
        PortcoveService::with_provider(library.clone(), provider).unwrap()
    }

    #[tokio::test]
    async fn release_notes_are_informational_and_outside_the_review_digest() {
        let (_temporary, service) = fixture();
        let without = service.plan_game_update(PORT, true).await.unwrap();
        assert_eq!(without.release_notes, None);
        let provider = NotesProvider::new(&service, None, vec![notes_entry()]);
        let noted =
            PortcoveService::with_provider(service.library.clone(), provider.clone()).unwrap();
        let with = noted.plan_game_update(PORT, true).await.unwrap();
        assert_eq!(
            with.release_notes.as_ref().unwrap().entries,
            [crate::UpdateReleaseNotesEntry {
                url: Some("https://github.com/Zelda64Recomp/Zelda64Recomp/releases/tag/v2".into()),
                ..notes_entry()
            }]
        );
        assert_eq!(with.plan_sha256, without.plan_sha256);
        assert_eq!(
            *provider.requests.lock().unwrap(),
            [(Some("v1".to_owned()), "v2".to_owned())]
        );
        // A review carrying notes still authorizes against the same digest.
        noted
            .authorize_game_update(PORT, true, &without.plan_sha256)
            .await
            .unwrap();
    }

    #[test]
    fn a_failed_link_check_drops_only_the_link() {
        let notes = || crate::UpdateReleaseNotes {
            releases_url: Some("https://github.com/owner/game/releases".into()),
            entries: vec![notes_entry()],
            coverage: crate::UpdateReleaseNotesCoverage::Complete,
        };
        let mut failed = notes();
        keep_reviewed_link(
            &mut failed,
            Err(PortcoveError::state("database unavailable")),
        );
        assert_eq!(failed.releases_url, None);
        assert_eq!(failed.entries, [notes_entry()]);
        let mut refused = notes();
        keep_reviewed_link(&mut refused, Ok(false));
        assert_eq!(refused.releases_url, None);
        let mut reviewed = notes();
        keep_reviewed_link(&mut reviewed, Ok(true));
        assert_eq!(reviewed, notes());
    }

    #[tokio::test]
    async fn every_exposed_release_notes_link_is_a_reviewed_handoff() {
        let (_temporary, service) = fixture();
        // The port's own reviewed repository: the release list link is kept.
        let reviewed = reviewed_repository_service(
            &service.library,
            NotesProvider::new(&service, None, vec![notes_entry()]),
        );
        let notes = reviewed
            .plan_game_update(PORT, true)
            .await
            .unwrap()
            .release_notes
            .unwrap();
        assert_eq!(
            notes.releases_url.as_deref(),
            Some("https://github.com/Zelda64Recomp/Zelda64Recomp/releases")
        );
        assert!(
            reviewed
                .is_reviewed_resource_url(notes.releases_url.as_deref().unwrap())
                .unwrap()
        );
        // Each release page under the same repository is a reviewed handoff too.
        assert_eq!(
            notes.entries[0].url.as_deref(),
            Some("https://github.com/Zelda64Recomp/Zelda64Recomp/releases/tag/v2")
        );
        // Desktop's gate opens exactly what the review offers.
        assert!(
            reviewed
                .is_reviewed_resource_url(notes.entries[0].url.as_deref().unwrap())
                .unwrap()
        );
        // A tag that is not plain keeps its notes but gets no release page.
        let slashed = crate::UpdateReleaseNotesEntry {
            version: "release/v2".into(),
            ..notes_entry()
        };
        let slashed_notes = reviewed_repository_service(
            &service.library,
            NotesProvider::new(&service, None, vec![slashed]),
        )
        .plan_game_update(PORT, true)
        .await
        .unwrap()
        .release_notes
        .unwrap();
        assert_eq!(slashed_notes.entries[0].url, None);
        for refused in [
            "https://github.com/Zelda64Recomp/Zelda64Recomp/releases/tag/v2/../../../other",
            "https://github.com/Zelda64Recomp/Zelda64Recomp/releases/tag/v2?x=1",
            "https://github.com/Zelda64Recomp/Zelda64Recomp/releases/tag/v2#notes",
            "https://github.com/Zelda64Recomp/Zelda64Recomp/releases/tag/v%2F2",
            "https://github.com/Zelda64Recomp/Zelda64Recomp/releases/tag/",
            "https://github.com/Other/Zelda64Recomp/releases/tag/v2",
            "https://github.com/Zelda64Recomp/Zelda64Recomp/releases/download/v2/x.zip",
            "http://github.com/Zelda64Recomp/Zelda64Recomp/releases/tag/v2",
        ] {
            assert!(
                !reviewed.is_reviewed_resource_url(refused).unwrap(),
                "{refused}"
            );
        }
        // A link Desktop would refuse is dropped; the notes remain.
        let foreign = reviewed_repository_service(
            &service.library,
            NotesProvider::new(&service, Some("foreign/game"), vec![notes_entry()]),
        );
        let notes = foreign
            .plan_game_update(PORT, true)
            .await
            .unwrap()
            .release_notes
            .unwrap();
        assert_eq!(notes.releases_url, None);
        // The foreign repository's release pages are dropped with its list.
        assert_eq!(notes.entries, [notes_entry()]);
        // Neither notes nor an openable link: nothing to show.
        let empty = reviewed_repository_service(
            &service.library,
            NotesProvider::new(&service, Some("foreign/game"), Vec::new()),
        );
        assert_eq!(
            empty
                .plan_game_update(PORT, true)
                .await
                .unwrap()
                .release_notes,
            None
        );
        // The active release is never presented as news.
        let current = reviewed_repository_service(
            &service.library,
            NotesProvider::new(&service, None, vec![notes_entry()]),
        );
        current.activate_staged(PORT).unwrap();
        let review = current.plan_game_update(PORT, true).await.unwrap();
        assert_eq!(review.plan.action, crate::InstallPlanAction::AlreadyActive);
        assert_eq!(review.release_notes, None);
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

    #[tokio::test]
    async fn an_optional_unregistered_game_source_does_not_hold_the_update_download() {
        let (_temporary, service) = fixture();
        let next = service_with_release(service.library.clone(), "v3");
        let mut review = next.plan_game_update(PORT, false).await.unwrap();
        assert_eq!(review.plan.action, crate::InstallPlanAction::Download);
        // The required baseline holds the download.
        assert_eq!(
            review.assessment.reason,
            crate::PortActionReason::MissingSource
        );
        review.plan.source_requirements[0].optional = true;
        let assessment = game_update_plan_assessment(&review.plan);
        assert_eq!(
            assessment.availability,
            crate::PortActionAvailability::Allowed
        );
        assert_eq!(assessment.reason, crate::PortActionReason::Available);
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
    async fn reviewed_apply_records_the_fresh_selection_and_reuses_it() {
        use std::sync::atomic::Ordering;

        let (_temporary, service) = fixture();
        let provider = NotesProvider::new(&service, None, Vec::new());
        let service = reviewed_repository_service(&service.library, provider.clone());
        let review = service.plan_game_update(PORT, true).await.unwrap();
        let grant = service
            .authorize_game_update(PORT, true, &review.plan_sha256)
            .await
            .unwrap();
        let before = provider.selections.load(Ordering::Relaxed);
        service
            .apply_game_update(PORT, true, &grant.token, |_| {})
            .await
            .unwrap();
        assert_eq!(provider.selections.load(Ordering::Relaxed), before + 1);
        let checked = service.library.update_snapshot(PORT).unwrap().unwrap();
        assert_eq!(checked.check.release, review.plan.release);
        assert_eq!(
            checked.check.upstream_activity.unwrap().observed_at,
            before + 1
        );
        assert_eq!(service.status(PORT).unwrap().active.unwrap().version, "v2");
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
    async fn activity_apply_refuses_other_handle_file_work_before_consuming_review_or_mutating() {
        use crate::test_fixture::{async_phase, phase};
        // Keep the large Apply futures out of this diagnostic wrapper's inline
        // state; Windows debug frames otherwise exhaust the normal test stack.
        let (_temporary, service) = phase("activity Apply: seed two retained runtimes", fixture);
        let before = phase("activity Apply: baseline status", || service.status(PORT)).unwrap();
        let tree = phase("activity Apply: baseline version tree", || {
            crate::library_transfer::reviewed_tree(&service.library.versions_dir())
        })
        .unwrap();
        let review = async_phase(
            "activity Apply: first review",
            service.plan_game_update(PORT, true),
        )
        .await
        .unwrap();
        let grant = async_phase(
            "activity Apply: first authorization",
            service.authorize_game_update(PORT, true, &review.plan_sha256),
        )
        .await
        .unwrap();
        let other = phase("activity Apply: open other client", || {
            Library::open(service.library.root())
        })
        .unwrap();
        let file_work = phase("activity Apply: other client owns file work", || {
            other.try_lock_port(PORT, "verify")
        })
        .unwrap();
        assert_eq!(
            async_phase(
                "activity Apply: busy refusal",
                Box::pin(service.apply_game_update(PORT, true, &grant.token, |_| {}))
            )
            .await
            .unwrap_err()
            .code,
            ErrorCode::Conflict
        );
        let after = phase(
            "activity Apply: status while file work remains owned",
            || service.status(PORT),
        )
        .unwrap();
        assert_eq!(
            after.active.as_ref().unwrap().id,
            before.active.as_ref().unwrap().id
        );
        assert_eq!(
            after.staged.as_ref().unwrap().id,
            before.staged.as_ref().unwrap().id
        );
        assert_eq!(
            phase("activity Apply: unchanged tree while busy", || {
                crate::library_transfer::reviewed_tree(&service.library.versions_dir())
            })
            .unwrap(),
            tree
        );
        phase(
            "activity Apply: release other client's file-work guard",
            || drop(file_work),
        );

        let reopened = phase("activity Apply: reopen independent client", || {
            service_with_release(Library::open(service.library.root()).unwrap(), "v2")
        });
        assert!(
            async_phase(
                "activity Apply: old client grant refused after reopen",
                Box::pin(reopened.apply_game_update(PORT, true, &grant.token, |_| {}))
            )
            .await
            .is_err()
        );
        assert_eq!(
            phase(
                "activity Apply: unchanged tree after old grant refusal",
                || crate::library_transfer::reviewed_tree(&service.library.versions_dir())
            )
            .unwrap(),
            tree
        );
        // Consuming only in this test proves the lock refusal left the original grant untouched.
        phase(
            "activity Apply: prove original grant was not consumed",
            || {
                service.library.consume_authorization(
                    &grant.token,
                    "game-update",
                    PORT,
                    &review.plan_sha256,
                )
            },
        )
        .unwrap();
        let fresh = async_phase(
            "activity Apply: fresh independent review",
            reopened.plan_game_update(PORT, true),
        )
        .await
        .unwrap();
        let fresh_grant = async_phase(
            "activity Apply: fresh independent authorization",
            reopened.authorize_game_update(PORT, true, &fresh.plan_sha256),
        )
        .await
        .unwrap();
        assert_ne!(fresh_grant.token, grant.token);
        let activated = async_phase(
            "activity Apply: fresh grant activates verified staged runtime",
            Box::pin(reopened.apply_game_update(PORT, true, &fresh_grant.token, |_| {})),
        )
        .await
        .unwrap();
        assert_eq!(activated.version, "v2");
        assert_eq!(
            phase("activity Apply: final previous-version proof", || reopened
                .status(PORT))
            .unwrap()
            .previous
            .unwrap()
            .version,
            "v1"
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
