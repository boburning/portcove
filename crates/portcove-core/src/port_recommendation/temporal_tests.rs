//! Historical replay must not use failures or ambiguity from a future observation.
use super::*;

fn fixture() -> PortRecommendationInput {
    let scope = RecommendationScope {
        game_id: "temporal-fixture".into(),
        edition_id: "original".into(),
        port_id: "candidate".into(),
        release_id: "release-1".into(),
        artifact_id: "artifact-1".into(),
        platform: Platform::WindowsX86_64,
        environment_id: "fixture-device".into(),
        source_profile_id: "fixture-source".into(),
        route_id: "fixture-route".into(),
    };
    let evidence = [
        (
            RecommendationDimension::Gameplay,
            RecommendationEvidenceKind::GameplayObserved,
        ),
        (
            RecommendationDimension::Stability,
            RecommendationEvidenceKind::GameplayObserved,
        ),
        (
            RecommendationDimension::Setup,
            RecommendationEvidenceKind::SetupObserved,
        ),
    ]
    .into_iter()
    .map(|(dimension, kind)| RecommendationEvidence {
        id: format!("temporal-{dimension:?}"),
        scope: scope.clone(),
        dimension,
        kind,
        claim: RecommendationClaim::Rating { value: 4 },
        source: "fixture://observed".into(),
        explanation: "Synthetic policy fixture, not real gameplay evidence.".into(),
        observed_at: 10,
        supersedes: BTreeSet::new(),
    })
    .collect();
    PortRecommendationInput {
        policy_version: PORT_RECOMMENDATION_POLICY.into(),
        evidence_snapshot_id: "temporal-snapshot".into(),
        evaluated_at: 100,
        context: RecommendationContext {
            game_id: scope.game_id.clone(),
            edition_id: scope.edition_id.clone(),
            platform: scope.platform,
            environment_id: scope.environment_id.clone(),
            available_source_profiles: BTreeSet::from([scope.source_profile_id.clone()]),
            required_capabilities: BTreeSet::new(),
        },
        candidates: vec![RecommendationCandidate {
            scope,
            operation_eligibility: RecommendationOperationEligibility::Allowed,
            capabilities: BTreeMap::new(),
            evidence,
        }],
        retained_regressions: Vec::new(),
        observed_regressions: Vec::new(),
        verified_corrections: Vec::new(),
    }
}

fn failure(input: &PortRecommendationInput, observed_at: u64) -> RecommendationRegression {
    RecommendationRegression {
        id: "save-regression".into(),
        affected_scope: input.candidates[0].scope.clone(),
        dimension: Some(RecommendationDimension::Gameplay),
        observed_at,
        source: "fixture://failure".into(),
        explanation: "Synthetic accepted failure, not an actual game observation.".into(),
    }
}

#[test]
fn future_failures_are_retained_but_only_apply_at_their_observation_time() {
    for retained in [false, true] {
        let mut input = fixture();
        let baseline = assess_port_recommendations(&input).unwrap();
        assert!(baseline.candidates[0].recommendation_eligible);
        let future = failure(&input, 101);
        if retained {
            input.retained_regressions.push(future.clone());
        } else {
            input.observed_regressions.push(future.clone());
        }
        let before = assess_port_recommendations(&input).unwrap();
        assert_eq!(before.candidates, baseline.candidates);
        assert_eq!(before.status, baseline.status);
        assert_eq!(before.retained_regressions, vec![future.clone()]);

        // A later collection may omit the report; the retained union still applies.
        input.retained_regressions = before.retained_regressions;
        input.observed_regressions.clear();
        for evaluated_at in [101, 102, u64::MAX] {
            input.evaluated_at = evaluated_at;
            let result = assess_port_recommendations(&input).unwrap();
            assert_eq!(result.status, PortRecommendationStatus::NoSuitableCandidate);
            assert_eq!(
                result.candidates[0].unresolved_regression_ids,
                vec![future.id.clone()]
            );
            assert!(!result.candidates[0].recommendation_eligible);
        }
        input.evaluated_at = 100;
        let replay: PortRecommendationInput =
            serde_json::from_slice(&serde_json::to_vec(&input).unwrap()).unwrap();
        assert_eq!(
            assess_port_recommendations(&replay).unwrap().candidates,
            baseline.candidates
        );
    }
}

#[test]
fn future_duplicate_ids_do_not_retroactively_invalidate_an_accepted_correction() {
    let mut input = fixture();
    let original = failure(&input, 20);
    input.retained_regressions.push(original.clone());
    let correction = RecommendationVerifiedCorrection {
        regression_id: original.id.clone(),
        dimension: Some(RecommendationDimension::Gameplay),
        scope: original.affected_scope.clone(),
        observed_at: 30,
        source: "fixture://verified-correction".into(),
        kind: RecommendationEvidenceKind::GameplayObserved,
    };
    input.verified_corrections.push(correction);
    let baseline = assess_port_recommendations(&input).unwrap();
    assert!(baseline.candidates[0].recommendation_eligible);
    let future = failure(&input, 101);
    input.observed_regressions.push(future);
    let before = assess_port_recommendations(&input).unwrap();
    assert_eq!(before.candidates, baseline.candidates);
    assert_eq!(before.retained_regressions.len(), 2);

    input.evaluated_at = 101;
    let at_boundary = assess_port_recommendations(&input).unwrap();
    assert!(!at_boundary.candidates[0].recommendation_eligible);
    assert_eq!(
        at_boundary.candidates[0].unresolved_regression_ids,
        vec![original.id]
    );
    assert_eq!(at_boundary.retained_regressions.len(), 2);
}

#[test]
fn a_future_correction_does_not_clear_a_present_failure_during_historical_replay() {
    let mut input = fixture();
    let original = failure(&input, 100);
    input.retained_regressions.push(original.clone());
    let correction = RecommendationVerifiedCorrection {
        regression_id: original.id.clone(),
        dimension: Some(RecommendationDimension::Gameplay),
        scope: original.affected_scope,
        observed_at: 101,
        source: "fixture://verified-correction".into(),
        kind: RecommendationEvidenceKind::GameplayObserved,
    };
    input.verified_corrections.push(correction);
    let before = assess_port_recommendations(&input).unwrap();
    assert!(!before.candidates[0].recommendation_eligible);
    input.evaluated_at = 101;
    let after = assess_port_recommendations(&input).unwrap();
    assert!(after.candidates[0].recommendation_eligible);
    assert_eq!(after.retained_regressions, before.retained_regressions);
}

#[test]
fn future_ordinary_duplicates_preserve_current_evidence_until_their_timestamp() {
    for malformed in [false, true] {
        let mut input = fixture();
        let baseline = assess_port_recommendations(&input).unwrap();
        let mut future = input.candidates[0].evidence[0].clone();
        future.observed_at = 101;
        if malformed {
            future.claim = RecommendationClaim::Rating { value: 6 };
            future.source.clear();
        }
        input.candidates[0].evidence.push(future.clone());
        let before = assess_port_recommendations(&input).unwrap();
        assert_eq!(before.status, baseline.status);
        let candidate = &before.candidates[0];
        assert!(candidate.recommendation_eligible);
        assert_eq!(candidate.dimensions, baseline.candidates[0].dimensions);
        assert_eq!(
            candidate.ranking_score_basis_points,
            baseline.candidates[0].ranking_score_basis_points
        );
        assert!(candidate.evidence.iter().any(|record| {
            record.evidence == future
                && record.disposition == RecommendationEvidenceDisposition::FutureObservation
        }));
        input.candidates[0].evidence.reverse();
        assert_eq!(assess_port_recommendations(&input).unwrap(), before);

        input.evaluated_at = 101;
        let after = assess_port_recommendations(&input).unwrap();
        assert!(!after.candidates[0].recommendation_eligible);
        assert!(
            after.candidates[0]
                .reasons
                .contains(&RecommendationReason::InvalidEvidence)
        );
        assert_eq!(
            after.candidates[0]
                .evidence
                .iter()
                .filter(|record| {
                    record.evidence.id == future.id
                        && record.disposition == RecommendationEvidenceDisposition::Invalid
                })
                .count(),
            2
        );
    }
}

#[test]
fn a_future_duplicate_does_not_invalidate_present_supersession_targets() {
    let mut input = fixture();
    let original = input.candidates[0].evidence[0].clone();
    let mut correction = original.clone();
    correction.id = "corrected-gameplay".into();
    correction.observed_at = 30;
    correction.claim = RecommendationClaim::Rating { value: 5 };
    correction.supersedes.insert(original.id.clone());
    input.candidates[0].evidence.push(correction);
    let baseline = assess_port_recommendations(&input).unwrap();
    assert!(baseline.candidates[0].recommendation_eligible);
    let mut future = original.clone();
    future.observed_at = 101;
    input.candidates[0].evidence.push(future.clone());

    let before = assess_port_recommendations(&input).unwrap();
    assert!(before.candidates[0].recommendation_eligible);
    assert_eq!(
        before.candidates[0].dimensions,
        baseline.candidates[0].dimensions
    );
    assert!(before.candidates[0].evidence.iter().any(|record| {
        record.evidence == original
            && record.disposition == RecommendationEvidenceDisposition::Superseded
    }));
    assert!(before.candidates[0].evidence.iter().any(|record| {
        record.evidence == future
            && record.disposition == RecommendationEvidenceDisposition::FutureObservation
    }));
    input.evaluated_at = 101;
    let after = assess_port_recommendations(&input).unwrap();
    assert!(!after.candidates[0].recommendation_eligible);
    assert!(
        after.candidates[0]
            .reasons
            .contains(&RecommendationReason::InvalidEvidence)
    );
}
