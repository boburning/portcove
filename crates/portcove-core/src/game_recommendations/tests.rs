//! Synthetic normalization tests. None of these records qualifies a real game.
use super::*;
use crate::{RecommendationClaim, RecommendationDimension as D};

#[test]
fn named_rubrics_map_every_level_without_catalog_numeric_scores() {
    use RecommendationOutcome as O;
    let rubrics = [
        [
            O::Gameplay(GameplayOutcome::CannotPlay),
            O::Gameplay(GameplayOutcome::RequiredContentMissing),
            O::Gameplay(GameplayOutcome::ProgressionDefects),
            O::Gameplay(GameplayOutcome::MainLoopWithLimitations),
            O::Gameplay(GameplayOutcome::ProgressionWithMinorDefects),
            O::Gameplay(GameplayOutcome::AssessedScopeComplete),
        ],
        [
            O::Stability(StabilityOutcome::DestructiveOrUnusable),
            O::Stability(StabilityOutcome::FrequentCrashesOrSaveFailures),
            O::Stability(StabilityOutcome::MaterialReliabilityGaps),
            O::Stability(StabilityOutcome::RepeatablePlayAndSaveWithLimitations),
            O::Stability(StabilityOutcome::RepeatedReliableSessions),
            O::Stability(StabilityOutcome::AssessedLifecycleAndRecoveryReliable),
        ],
        [
            O::Performance(PerformanceOutcome::Unusable),
            O::Performance(PerformanceOutcome::SevereInterruption),
            O::Performance(PerformanceOutcome::MaterialPacingProblems),
            O::Performance(PerformanceOutcome::PlayableWithinMeasuredLimits),
            O::Performance(PerformanceOutcome::ConsistentMeasuredPerformance),
            O::Performance(PerformanceOutcome::AssessedTargetMet),
        ],
        [
            O::Controls(ControlsOutcome::RequiredInteractionUnusable),
            O::Controls(ControlsOutcome::MajorInteractionGaps),
            O::Controls(ControlsOutcome::MaterialControlLimitations),
            O::Controls(ControlsOutcome::AssessedInteractionWithLimitations),
            O::Controls(ControlsOutcome::UsefulControlsAndAccessibility),
            O::Controls(ControlsOutcome::AssessedInteractionGoalsMet),
        ],
        [
            O::Setup(SetupOutcome::CannotComplete),
            O::Setup(SetupOutcome::UnrecoverableProblems),
            O::Setup(SetupOutcome::ManualOrRecoveryLimitations),
            O::Setup(SetupOutcome::RepeatableSetupWithLimitations),
            O::Setup(SetupOutcome::RepeatableSetupVerificationAndUpdate),
            O::Setup(SetupOutcome::AssessedSetupUpdateAndRecoveryGoalsMet),
        ],
        [
            O::Maintenance(MaintenanceOutcome::ExplicitAbandonment),
            O::Maintenance(MaintenanceOutcome::UnresolvedContinuityFailure),
            O::Maintenance(MaintenanceOutcome::StatedContinuityLimits),
            O::Maintenance(MaintenanceOutcome::AttributableContinuityWithLimitations),
            O::Maintenance(MaintenanceOutcome::DemonstratedRegressionHandling),
            O::Maintenance(MaintenanceOutcome::DemonstratedContinuityAndSuccession),
        ],
    ];
    for (dimension, levels) in [
        D::Gameplay,
        D::Stability,
        D::Performance,
        D::Controls,
        D::Setup,
        D::Maintenance,
    ]
    .into_iter()
    .zip(rubrics)
    {
        for (rating, outcome) in levels.into_iter().enumerate() {
            assert_eq!(
                outcome.claim(),
                (
                    dimension,
                    RecommendationClaim::Rating {
                        value: rating as u8
                    }
                )
            );
            let value = serde_json::to_value(outcome).unwrap();
            assert!(value["outcome"].is_string());
            assert_eq!(
                serde_json::from_value::<RecommendationOutcome>(value).unwrap(),
                outcome
            );
        }
        assert_eq!(
            O::Unknown(dimension).claim(),
            (dimension, RecommendationClaim::Unknown)
        );
        assert_eq!(
            O::NotApplicable(dimension).claim(),
            (dimension, RecommendationClaim::NotApplicable)
        );
    }
}

#[test]
fn request_context_is_bounded_and_uses_an_explicit_replay_clock() {
    let mut request: GameComparisonRequest =
        serde_json::from_value(serde_json::json!({"port_id":"fixture", "evaluated_at":100}))
            .unwrap();
    assert_eq!(evaluation_time(&request).unwrap(), 100);
    request.environment_id = Some("private\npath".into());
    assert!(evaluation_time(&request).is_err());
    assert!(
        serde_json::from_value::<GameComparisonRequest>(
            serde_json::json!({"port_id":"fixture", "rom_path":"private"})
        )
        .is_err()
    );
}

#[test]
fn exact_release_identity_changes_for_same_tag_different_bytes_not_check_time() {
    let mut release = ComparisonRelease {
        version: "1.0".into(),
        channel: ReleaseChannel::Stable,
        asset_name: "game.zip".into(),
        artifact_sha256: "a".repeat(64),
        size: 42,
        published_at: None,
    };
    let first = release.identity().unwrap();
    release.published_at = Some("2026-10-28T00:00:00Z".into());
    assert_eq!(release.identity().unwrap(), first);
    release.artifact_sha256 = "b".repeat(64);
    assert_ne!(release.identity().unwrap(), first);
}
