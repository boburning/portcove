//! Actual Core query with an owned synthetic release provider and library.
//! Real catalog calibration below establishes artifact-authority/fallback boundaries, never gameplay.
use super::*;
use crate::{
    Catalog, RecommendationEvidenceKind as Kind, ReleaseAsset, ReleaseProvider, ResolvedRelease,
};
use async_trait::async_trait;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct Provider {
    calls: AtomicUsize,
    failure: AtomicBool,
    release: Mutex<ResolvedRelease>,
}
#[async_trait]
impl ReleaseProvider for Provider {
    async fn resolve(
        &self,
        _port: &PortDefinition,
        _channel: ReleaseChannel,
        _platform: Platform,
    ) -> Result<ResolvedRelease> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.failure.load(Ordering::SeqCst) {
            return Err(PortcoveError::state("synthetic collection failure"));
        }
        Ok(self.release.lock().unwrap().clone())
    }
}
struct Fixture {
    _temporary: tempfile::TempDir,
    preferences: HostPreferenceStore,
    provider: Arc<Provider>,
    service: PortcoveService,
    request: GameComparisonRequest,
}
fn scope(id: &str, release: &ResolvedRelease) -> RecommendationScope {
    RecommendationScope {
        game_id: "comparison-fixture".into(),
        edition_id: "fixture-original".into(),
        port_id: id.into(),
        release_id: format!("stable:{}", release.version),
        artifact_id: format!("sha256:{}", release.asset.sha256),
        platform: Platform::current().unwrap(),
        environment_id: "owned-fixture-device".into(),
        source_profile_id: "no-original-files".into(),
        route_id: "managed:native-portable".into(),
    }
}
fn observations(id: &str, release: &ResolvedRelease, good: bool) -> RecommendationMetadata {
    let scope = scope(id, release);
    let outcomes = if good {
        vec![
            RecommendationOutcome::Gameplay(GameplayOutcome::AssessedScopeComplete),
            RecommendationOutcome::Stability(
                StabilityOutcome::AssessedLifecycleAndRecoveryReliable,
            ),
            RecommendationOutcome::Setup(SetupOutcome::AssessedSetupUpdateAndRecoveryGoalsMet),
        ]
    } else {
        vec![
            RecommendationOutcome::Gameplay(GameplayOutcome::MainLoopWithLimitations),
            RecommendationOutcome::Stability(
                StabilityOutcome::RepeatablePlayAndSaveWithLimitations,
            ),
            RecommendationOutcome::Setup(SetupOutcome::RepeatableSetupWithLimitations),
        ]
    };
    RecommendationMetadata {
        format_version: 1,
        capabilities: vec![],
        observations: outcomes
            .into_iter()
            .enumerate()
            .map(|(index, outcome)| RecommendationObservation {
                id: format!("{id}-{index}"),
                scope: scope.clone(),
                outcome,
                kind: if index == 2 {
                    Kind::SetupObserved
                } else {
                    Kind::GameplayObserved
                },
                observed_at: 10,
                source: "https://example.com/synthetic-policy-fixture".into(),
                explanation: "Owned synthetic evidence; not observations of any actual game."
                    .into(),
                supersedes: BTreeSet::new(),
                fixes: BTreeSet::new(),
            })
            .collect(),
    }
}
fn fixture() -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
    let provider = Arc::new(Provider {
        calls: AtomicUsize::new(0),
        failure: AtomicBool::new(false),
        release: Mutex::new(ResolvedRelease {
            version: "1.0".into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: ReleaseAsset {
                name: "fixture.zip".into(),
                url: "https://example.com/fixture.zip".into(),
                size: 42,
                sha256: "a".repeat(64),
            },
        }),
    });
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    let mut service = PortcoveService::with_provider_read_only(library, provider.clone()).unwrap();
    let embedded = Catalog::embedded().unwrap();
    let mut document = embedded.document().clone();
    let base = embedded.port("fragglet-sdl-sopwith").unwrap();
    let test_ports: Vec<_> = ["comparison-alpha", "comparison-beta"]
        .into_iter()
        .enumerate()
        .map(|(index, id)| {
            let mut port = base.clone();
            port.id = id.into();
            port.name = id.into();
            port.project_url = "https://example.com/synthetic-project".into();
            port.platforms = vec![Platform::current().unwrap()];
            port.executable_hints =
                BTreeMap::from([(Platform::current().unwrap(), vec!["game.exe".into()])]);
            port.release.repository = format!("fixture/{id}");
            port.release.asset_hints =
                BTreeMap::from([(Platform::current().unwrap(), vec!["fixture.zip".into()])]);
            let presentation = port.presentation.as_mut().unwrap();
            presentation.original_game_title = Some("Synthetic comparison fixture".into());
            presentation.original_game = Some(crate::OriginalGameIdentity {
                format_version: 1,
                id: "comparison-fixture".into(),
                evidence_urls: vec!["https://example.com/synthetic-project".into()],
                source_editions: vec![crate::SourceEdition {
                    id: "fixture-original".into(),
                    title: "Synthetic original edition".into(),
                    system: Some("nintendo-64".into()),
                    evidence_urls: vec!["https://example.com/synthetic-edition".into()],
                }],
            });
            presentation.recommendation = Some(
                serde_json::to_value(observations(
                    id,
                    &provider.release.lock().unwrap(),
                    index == 0,
                ))
                .unwrap(),
            );
            presentation.artwork = None;
            presentation.media = None;
            presentation.manual_setup = None;
            port
        })
        .collect();
    document.ports.splice(0..0, test_ports);
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    Fixture { _temporary: temporary, preferences, provider, service,
        request: serde_json::from_value(serde_json::json!({"port_id":"comparison-alpha", "environment_id":"owned-fixture-device", "refresh":true, "evaluated_at":100})).unwrap(),
    }
}
fn edit(fixture: &mut Fixture, apply: impl FnOnce(&mut crate::CatalogDocument)) {
    let mut document = fixture.service.catalog().document().clone();
    apply(&mut document);
    fixture.service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
}

#[tokio::test]
async fn shared_query_selects_from_scoped_facts_and_reuses_unchanged_provider_inputs() {
    let mut f = fixture();
    let statuses = serde_json::to_value(f.service.statuses().unwrap()).unwrap();
    let first = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.ports.len(), 2);
    let assessment = first.assessment.as_ref().unwrap();
    assert_eq!(
        assessment.status,
        crate::PortRecommendationStatus::RecommendedStartingPoint
    );
    assert_eq!(
        assessment.recommended.as_ref().unwrap().port_id,
        "comparison-alpha"
    );
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
    f.request.refresh = false;
    let again = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&again).unwrap()
    );
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        serde_json::to_value(f.service.statuses().unwrap()).unwrap(),
        statuses
    );
    let output = serde_json::to_string(&again).unwrap();
    assert!(!output.contains(f.service.library().root().to_str().unwrap()));
    assert!(!output.contains("rom_path"));
}

#[tokio::test]
async fn a_new_artifact_does_not_inherit_gameplay_and_failed_collection_keeps_truthful_freshness() {
    let mut f = fixture();
    f.service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    f.provider.release.lock().unwrap().asset.sha256 = "b".repeat(64);
    f.request.evaluated_at = Some(110);
    let changed = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert!(changed.assessment.as_ref().unwrap().recommended.is_none());
    assert!(
        changed
            .assessment
            .as_ref()
            .unwrap()
            .candidates
            .iter()
            .all(
                |candidate| candidate.evidence.iter().all(|record| record.disposition
                    == crate::RecommendationEvidenceDisposition::HistoricalScope)
            )
    );
    assert_eq!(
        changed.ports[0].freshness.offered_identity_changed_at,
        Some(110)
    );
    f.provider.failure.store(true, Ordering::SeqCst);
    f.request.evaluated_at = Some(120);
    let failed = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        failed.ports[0].offered_release,
        changed.ports[0].offered_release
    );
    assert_eq!(
        failed.ports[0].freshness.last_successful_resolution_at,
        Some(110)
    );
    assert_eq!(failed.ports[0].freshness.last_attempt_at, Some(120));
    assert_eq!(
        failed.ports[0].freshness.state,
        ComparisonReleaseState::CollectionFailed
    );
    assert!(failed.assessment.unwrap().recommended.is_none());
}

#[tokio::test]
async fn accepted_failures_survive_omission_and_only_an_exact_observed_correction_clears_them() {
    let mut f = fixture();
    edit(&mut f, |document| {
        let metadata = document.ports[0]
            .presentation
            .as_mut()
            .unwrap()
            .recommendation
            .as_mut()
            .unwrap();
        metadata["observations"][0]["outcome"] =
            serde_json::to_value(RecommendationOutcome::Gameplay(GameplayOutcome::CannotPlay))
                .unwrap();
    });
    let failed = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        failed
            .assessment
            .as_ref()
            .unwrap()
            .retained_regressions
            .len(),
        1
    );
    edit(&mut f, |document| {
        document.ports[0]
            .presentation
            .as_mut()
            .unwrap()
            .recommendation = None
    });
    f.provider.release.lock().unwrap().asset.sha256 = "b".repeat(64);
    f.request.evaluated_at = Some(120);
    let omitted = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        omitted.assessment.as_ref().unwrap().retained_regressions,
        failed.assessment.unwrap().retained_regressions
    );
    assert_eq!(
        omitted.assessment.as_ref().unwrap().candidates[0].unresolved_regression_ids,
        vec!["comparison-alpha-0"]
    );
    let release = f.provider.release.lock().unwrap().clone();
    edit(&mut f, |document| {
        let mut metadata = observations("comparison-alpha", &release, true);
        metadata.observations[0].id = "alpha-correction".into();
        metadata.observations[0].observed_at = 130;
        metadata.observations[0]
            .fixes
            .insert("comparison-alpha-0".into());
        document.ports[0]
            .presentation
            .as_mut()
            .unwrap()
            .recommendation = Some(serde_json::to_value(metadata).unwrap());
    });
    f.request.refresh = false;
    let future = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        !future.assessment.unwrap().candidates[0]
            .unresolved_regression_ids
            .is_empty()
    );
    f.request.evaluated_at = Some(130);
    let corrected = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        corrected.assessment.as_ref().unwrap().candidates[0]
            .unresolved_regression_ids
            .is_empty()
    );
    assert_eq!(corrected.assessment.unwrap().retained_regressions.len(), 1);
}

#[tokio::test]
async fn malformed_optional_metadata_and_unknown_requirements_preserve_ordinary_catalog_and_status()
{
    let mut f = fixture();
    let before = serde_json::to_value(f.service.statuses().unwrap()).unwrap();
    edit(&mut f, |document| {
        document.ports[0]
            .presentation
            .as_mut()
            .unwrap()
            .recommendation = Some(serde_json::json!({"format_version":999,"future":"preserve"}))
    });
    f.request.required_capabilities.insert("multiplayer".into());
    let comparison = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        comparison.ports[0].metadata,
        RecommendationMetadataState::UnsupportedVersion
    );
    assert_eq!(comparison.ports.len(), 2);
    assert!(comparison.assessment.unwrap().recommended.is_none());
    assert_eq!(
        serde_json::to_value(f.service.statuses().unwrap()).unwrap(),
        before
    );
    assert_eq!(
        f.service.catalog().ports()[0]
            .presentation
            .as_ref()
            .unwrap()
            .recommendation
            .as_ref()
            .unwrap()["future"],
        "preserve"
    );
}

#[tokio::test]
async fn changed_update_observation_refreshes_only_its_affected_implementation() {
    let mut f = fixture();
    f.service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    f.service
        .library()
        .store_update_snapshot(&crate::UpdateCheck {
            port_id: "comparison-alpha".into(),
            channel: ReleaseChannel::Stable,
            installed_version: None,
            installed_artifact: None,
            installed_runtime: None,
            required_runtime: None,
            update_available: true,
            release: f.provider.release.lock().unwrap().clone(),
        })
        .unwrap();
    f.request.refresh = false;
    f.request.evaluated_at = Some(140);
    f.service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 3);
    f.service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn followed_updates_are_explicit_deduplicated_and_do_not_change_installs_or_channels() {
    let mut f = fixture();
    let first = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        first
            .ports
            .iter()
            .all(|port| !port.followed && port.update_notice.is_none())
    );
    let library = f.service.library().identity().unwrap();
    f.preferences
        .change_library_organization(
            &library,
            0,
            crate::OrganizationChange::SetFollowedProject {
                port_id: "comparison-alpha".into(),
                followed: true,
                observed_identity: Some(
                    first.ports[0]
                        .offered_release
                        .as_ref()
                        .unwrap()
                        .identity()
                        .unwrap(),
                ),
            },
        )
        .unwrap();
    f.request.refresh = false;
    assert!(
        f.service
            .compare_game_ports_at(
                &f.request,
                &f.preferences,
                evaluation_time(&f.request).unwrap()
            )
            .await
            .unwrap()
            .ports[0]
            .update_notice
            .is_none()
    );
    f.provider.release.lock().unwrap().asset.sha256 = "b".repeat(64);
    f.request.refresh = true;
    f.request.evaluated_at = Some(120);
    let changed = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    let notice = changed.ports[0].update_notice.as_ref().unwrap();
    assert!(!changed.ports[0].installed);
    f.preferences
        .change_library_organization(
            &library,
            1,
            crate::OrganizationChange::AcknowledgeFollowedRelease {
                port_id: "comparison-alpha".into(),
                identity: notice.identity.clone(),
            },
        )
        .unwrap();
    f.request.refresh = false;
    let seen = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert!(seen.ports[0].update_notice.is_none());
    assert!(seen.ports[1].update_notice.is_none());
    assert_eq!(
        f.service.status("comparison-alpha").unwrap().channel,
        ReleaseChannel::Stable
    );
}

#[tokio::test]
async fn pinned_real_sm64_relationships_stay_independent_and_sparse_without_fabricated_quality() {
    let evidence: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/recommendation-sm64-upstream-identities-20261029.json"
    ))
    .unwrap();
    let asset = &evidence["cases"][1]["asset"];
    // Independently collected package identity is available to this provider, but
    // these accepted routes register user-selected runtimes. An upstream package
    // must not silently become their offered/qualified replacement.
    let provider = Arc::new(Provider {
        calls: AtomicUsize::new(0),
        failure: AtomicBool::new(false),
        release: Mutex::new(ResolvedRelease {
            version: "v1.5.1".into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: ReleaseAsset {
                name: asset["name"].as_str().unwrap().into(),
                url: asset["url"].as_str().unwrap().into(),
                size: asset["bytes"].as_u64().unwrap(),
                sha256: asset["downloaded_sha256"].as_str().unwrap().into(),
            },
        }),
    });
    let temporary = tempfile::tempdir().unwrap();
    let preferences = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
    let service = PortcoveService::with_provider_read_only(
        crate::Library::open(temporary.path().join("library")).unwrap(),
        provider.clone(),
    )
    .unwrap();
    let request =
        serde_json::from_value(serde_json::json!({"port_id":"render96ex", "evaluated_at":100, "platform":"windows-x86-64", "refresh":true, "required_capabilities":["multiplayer"]}))
            .unwrap();
    let result = service
        .compare_game_ports_at(&request, &preferences, evaluation_time(&request).unwrap())
        .await
        .unwrap();
    assert_eq!(result.game_id.as_deref(), Some("super-mario-64"));
    assert!(result.ports.iter().any(|port| port.port_id == "render96ex"));
    assert!(
        result
            .ports
            .iter()
            .any(|port| port.port_id == "super-mario-64-sm64-co-op-dx")
    );
    // Other explicitly related projects may provide an edition, but sparse quality
    // and missing candidate-specific edition provenance never manufacture a winner.
    assert!(
        result
            .assessment
            .as_ref()
            .is_none_or(|assessment| assessment.recommended.is_none())
    );
    for id in ["render96ex", "super-mario-64-sm64-co-op-dx"] {
        assert!(
            result
                .ports
                .iter()
                .find(|port| port.port_id == id)
                .unwrap()
                .edition_ids
                .is_empty()
        );
    }
    assert!(
        result
            .ports
            .iter()
            .all(|port| port.metadata == RecommendationMetadataState::Missing)
    );
    assert!(result.ports.iter().all(|port| !port.installed));
    for id in ["render96ex", "super-mario-64-sm64-co-op-dx"] {
        let row = result.ports.iter().find(|port| port.port_id == id).unwrap();
        assert!(row.offered_release.is_none());
        assert!(!row.launch_ready);
    }
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    // A source revision is deliberately not represented as a runtime checksum.
    assert!(evidence["cases"][0]["artifact_identity"].is_null());
    assert_eq!(
        asset["downloaded_sha256"],
        "2a98c40acb2a46d30cde89f3072c039b641dbdf977985f9e82a040615f1b2381"
    );
    assert!(result.assessment.as_ref().is_none_or(|assessment| {
        assessment
            .candidates
            .iter()
            .all(|candidate| !candidate.recommendation_eligible)
    }));
}

#[tokio::test]
async fn explicit_observed_requirement_changes_suitability_without_changing_quality_or_installs() {
    let mut f = fixture();
    let release = f.provider.release.lock().unwrap().clone();
    edit(&mut f, |document| {
        for (index, port) in document.ports.iter_mut().take(2).enumerate() {
            let mut metadata = observations(&port.id, &release, index == 0);
            metadata
                .capabilities
                .push(RecommendationCapabilityObservation {
                    id: format!("{}-multiplayer", port.id),
                    scope: scope(&port.id, &release),
                    capability: "multiplayer".into(),
                    kind: Kind::GameplayObserved,
                    state: if index == 0 {
                        crate::RecommendationRequirement::Unsupported
                    } else {
                        crate::RecommendationRequirement::Satisfied
                    },
                    source: "https://example.com/synthetic-requirement".into(),
                    explanation: "Synthetic observed requirement; no actual game capability claim."
                        .into(),
                    observed_at: 10,
                });
            port.presentation.as_mut().unwrap().recommendation =
                Some(serde_json::to_value(metadata).unwrap());
        }
    });
    let ordinary = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        ordinary
            .assessment
            .as_ref()
            .unwrap()
            .recommended
            .as_ref()
            .unwrap()
            .port_id,
        "comparison-alpha"
    );
    f.request.required_capabilities.insert("multiplayer".into());
    f.request.refresh = false;
    let required = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        required
            .assessment
            .as_ref()
            .unwrap()
            .recommended
            .as_ref()
            .unwrap()
            .port_id,
        "comparison-beta"
    );
    for (before, after) in ordinary
        .assessment
        .unwrap()
        .candidates
        .iter()
        .zip(&required.assessment.unwrap().candidates)
    {
        assert_eq!(
            before.ranking_score_basis_points,
            after.ranking_score_basis_points
        );
    }
    assert!(f.service.library().all_installs().unwrap().is_empty());
}

#[tokio::test]
async fn seen_release_identity_stays_deduplicated_after_a_different_release_is_acknowledged() {
    let mut f = fixture();
    let first = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    let library = f.service.library().identity().unwrap();
    f.preferences
        .change_library_organization(
            &library,
            0,
            crate::OrganizationChange::SetFollowedProject {
                port_id: "comparison-alpha".into(),
                followed: true,
                observed_identity: first.ports[0].offered_identity.clone(),
            },
        )
        .unwrap();
    f.provider.release.lock().unwrap().asset.sha256 = "b".repeat(64);
    f.request.evaluated_at = Some(110);
    let next = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    f.preferences
        .change_library_organization(
            &library,
            1,
            crate::OrganizationChange::AcknowledgeFollowedRelease {
                port_id: "comparison-alpha".into(),
                identity: next.ports[0]
                    .update_notice
                    .as_ref()
                    .unwrap()
                    .identity
                    .clone(),
            },
        )
        .unwrap();
    f.provider.release.lock().unwrap().asset.sha256 = "a".repeat(64);
    f.request.evaluated_at = Some(120);
    let back = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert!(back.ports[0].update_notice.is_none());
    assert_eq!(
        f.preferences
            .library_organization(&library)
            .unwrap()
            .followed_release_acknowledgments["comparison-alpha"]
            .len(),
        2
    );
}

#[tokio::test]
async fn comparison_and_changed_metadata_preserve_a_real_registered_install_manifest_and_player_bytes()
 {
    let mut f = fixture();
    let library = f.service.library().clone();
    let port_id = "comparison-alpha";
    let root = library
        .versions_dir()
        .join(port_id)
        .join("comparison-stable-install");
    std::fs::create_dir_all(&root).unwrap();
    let executable = root.join("game.exe");
    std::fs::write(&executable, b"inert fixture; never executed").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let artifact = crate::ArtifactIdentity {
        asset_name: "fixture.zip".into(),
        sha256: "a".repeat(64),
        size: 42,
    };
    let qualification = crate::InstallQualification::from_catalog(
        f.service.catalog(),
        port_id,
        Platform::current().unwrap(),
    )
    .unwrap();
    let (manifest_sha256, selected_executable, runtime) = crate::Installer::new(library.clone())
        .unwrap()
        .create_manifest(
            "comparison-stable-install",
            port_id,
            "1.0",
            &artifact,
            &qualification,
            &root,
        )
        .unwrap();
    let install = crate::InstallRecord {
        id: "comparison-stable-install".into(),
        port_id: port_id.into(),
        version: "1.0".into(),
        path: root.clone(),
        channel: ReleaseChannel::Stable,
        installed_at: 10,
        verified: true,
        staged: false,
        artifact,
        runtime,
        manifest_sha256,
        selected_executable,
    };
    library.register_install(&install, true).unwrap();
    library
        .set_update_policy(port_id, crate::UpdatePolicy::Notify, ReleaseChannel::Stable)
        .unwrap();
    let save = library.user_dir(port_id).join("player-save.dat");
    std::fs::create_dir_all(save.parent().unwrap()).unwrap();
    std::fs::write(&save, b"player-owned progress").unwrap();
    let before = serde_json::to_value(f.service.status(port_id).unwrap()).unwrap();
    let records = serde_json::to_value(library.all_installs().unwrap()).unwrap();
    let sources = serde_json::to_value(library.sources().unwrap()).unwrap();
    f.service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    edit(&mut f, |document| {
        document.ports[0]
            .presentation
            .as_mut()
            .unwrap()
            .recommendation = None;
    });
    f.provider.release.lock().unwrap().asset.sha256 = "b".repeat(64);
    f.request.evaluated_at = Some(120);
    let refreshed = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert!(refreshed.ports[0].installed);
    assert_eq!(
        serde_json::to_value(f.service.status(port_id).unwrap()).unwrap(),
        before
    );
    assert_eq!(
        serde_json::to_value(library.all_installs().unwrap()).unwrap(),
        records
    );
    assert_eq!(
        serde_json::to_value(library.sources().unwrap()).unwrap(),
        sources
    );
    assert_eq!(std::fs::read(save).unwrap(), b"player-owned progress");
    assert_eq!(
        std::fs::read(executable).unwrap(),
        b"inert fixture; never executed"
    );
}

#[tokio::test]
async fn accepted_definition_changes_refresh_only_affected_inputs_without_manual_ranking_edits() {
    let mut f = fixture();
    let first = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
    let original_statuses = serde_json::to_value(f.service.statuses().unwrap()).unwrap();
    f.provider.release.lock().unwrap().asset.sha256 = "b".repeat(64);
    edit(&mut f, |document| {
        document.ports[0].release.repository = "fixture/changed-upstream".into();
    });
    f.request.refresh = false;
    f.request.evaluated_at = Some(110);
    let changed = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        changed.ports[0]
            .offered_release
            .as_ref()
            .unwrap()
            .artifact_sha256,
        "b".repeat(64)
    );
    assert_eq!(
        changed.ports[0].freshness.state,
        ComparisonReleaseState::ProviderResolved
    );
    assert_eq!(
        changed.ports[0].freshness.last_successful_resolution_at,
        Some(110)
    );
    assert_eq!(
        changed.ports[1].offered_release,
        first.ports[1].offered_release
    );
    assert_eq!(changed.ports[1].freshness, first.ports[1].freshness);
    assert_ne!(changed.input_id, first.input_id);
    assert!(
        changed.assessment.as_ref().unwrap().candidates[0]
            .evidence
            .iter()
            .all(|record| {
                record.disposition == crate::RecommendationEvidenceDisposition::HistoricalScope
            })
    );
    let repeated = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        serde_json::to_value(repeated).unwrap(),
        serde_json::to_value(changed).unwrap()
    );
    assert_eq!(
        serde_json::to_value(f.service.statuses().unwrap()).unwrap(),
        original_statuses
    );
}

#[tokio::test]
async fn failed_changed_definition_retains_last_good_binding_without_a_query_retry_loop() {
    let mut f = fixture();
    let first = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    f.provider.failure.store(true, Ordering::SeqCst);
    edit(&mut f, |document| {
        document.ports[0].release.repository = "fixture/changed-upstream".into();
    });
    f.request.refresh = false;
    f.request.evaluated_at = Some(110);
    let failed = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        failed.ports[0].offered_release,
        first.ports[0].offered_release
    );
    assert_eq!(
        failed.ports[0].freshness.state,
        ComparisonReleaseState::DefinitionChanged
    );
    assert_eq!(
        failed.ports[0].freshness.last_successful_resolution_at,
        Some(100)
    );
    assert_eq!(failed.ports[0].freshness.last_attempt_at, Some(110));
    assert!(!failed.assessment.as_ref().unwrap().candidates[0].recommendation_eligible);
    f.request.evaluated_at = Some(120);
    let repeated = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 3);
    assert_eq!(repeated.ports[0].freshness, failed.ports[0].freshness);
    f.provider.failure.store(false, Ordering::SeqCst);
    f.request.refresh = true;
    let recovered = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        recovered.ports[0].freshness.state,
        ComparisonReleaseState::ProviderResolved
    );
    assert_eq!(
        recovered.ports[0].freshness.last_successful_resolution_at,
        Some(120)
    );
    assert_eq!(
        recovered.ports[0].freshness.offered_identity_changed_at,
        Some(100)
    );
}

#[tokio::test]
async fn accepted_quality_changes_recompute_without_refetching_unchanged_artifact_inputs() {
    let mut f = fixture();
    let first = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    let release = f.provider.release.lock().unwrap().clone();
    edit(&mut f, |document| {
        let metadata = observations("comparison-alpha", &release, false);
        document.ports[0]
            .presentation
            .as_mut()
            .unwrap()
            .recommendation = Some(serde_json::to_value(metadata).unwrap());
    });
    f.request.refresh = false;
    let comparable = f
        .service
        .compare_game_ports_at(
            &f.request,
            &f.preferences,
            evaluation_time(&f.request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
    assert_ne!(first.input_id, comparable.input_id);
    assert_eq!(
        comparable.assessment.as_ref().unwrap().status,
        crate::PortRecommendationStatus::ComparableAlternatives
    );
    assert!(comparable.assessment.unwrap().recommended.is_none());
}

#[tokio::test]
async fn future_replay_cannot_poison_collection_and_normal_refresh_recovers() {
    let mut f = fixture();
    f.request.evaluated_at = Some(u64::MAX);
    assert!(
        f.service
            .compare_game_ports(&f.request, &f.preferences)
            .await
            .is_err()
    );
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 0);
    let library_id = f.service.library().identity().unwrap();
    assert!(
        f.preferences
            .recommendation_history(&library_id)
            .unwrap()
            .releases
            .is_empty()
    );
    f.request.evaluated_at = None;
    let normal = f
        .service
        .compare_game_ports(&f.request, &f.preferences)
        .await
        .unwrap();
    assert!(normal.ports[0].offered_release.is_some());
    assert_eq!(
        normal.ports[0].freshness.last_attempt_at,
        Some(normal.evaluated_at)
    );
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn historical_assessment_does_not_backdate_new_provider_facts() {
    let mut f = fixture();
    f.request.evaluated_at = Some(100);
    let historical = f
        .service
        .compare_game_ports_at(&f.request, &f.preferences, 200)
        .await
        .unwrap();
    assert!(historical.ports[0].offered_release.is_none());
    let history = f
        .preferences
        .recommendation_history(&f.service.library().identity().unwrap())
        .unwrap();
    assert!(
        history
            .releases
            .values()
            .all(|record| record.last_attempt_at == 200)
    );
    f.request.refresh = false;
    f.request.evaluated_at = None;
    let current = f
        .service
        .compare_game_ports_at(&f.request, &f.preferences, 200)
        .await
        .unwrap();
    assert!(current.ports[0].offered_release.is_some());
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
}
