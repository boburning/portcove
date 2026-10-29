use super::*;

fn scope(port: &str) -> RecommendationScope {
    RecommendationScope {
        game_id: "fixture-game".to_owned(),
        edition_id: "fixture-edition".to_owned(),
        port_id: port.to_owned(),
        release_id: "release-1".to_owned(),
        artifact_id: format!("accepted-artifact-{port}-1"),
        platform: Platform::WindowsX86_64,
        environment_id: "fixture-device".to_owned(),
        source_profile_id: "fixture-source".to_owned(),
        route_id: "fixture-route".to_owned(),
    }
}

fn observation(
    scope: &RecommendationScope,
    dimension: RecommendationDimension,
    rating: u8,
) -> RecommendationEvidence {
    use RecommendationDimension as D;
    let kind = match dimension {
        D::Gameplay | D::Stability | D::Controls => RecommendationEvidenceKind::GameplayObserved,
        D::Performance => RecommendationEvidenceKind::PerformanceObserved,
        D::Setup => RecommendationEvidenceKind::SetupObserved,
        D::Maintenance => RecommendationEvidenceKind::MaintenanceObserved,
    };
    RecommendationEvidence {
        id: format!("{}-{dimension:?}", scope.port_id),
        scope: scope.clone(),
        dimension,
        kind,
        claim: RecommendationClaim::Rating { value: rating },
        source: "fixture://observation".to_owned(),
        explanation: "Synthetic policy fixture, not gameplay evidence.".to_owned(),
        observed_at: 10,
        supersedes: BTreeSet::new(),
    }
}

fn fixture_candidate(port: &str, rating: u8) -> RecommendationCandidate {
    let scope = scope(port);
    let evidence = RecommendationDimension::WEIGHTED
        .iter()
        .map(|(dimension, _)| observation(&scope, *dimension, rating))
        .collect();
    RecommendationCandidate {
        scope,
        operation_eligibility: RecommendationOperationEligibility::Allowed,
        capabilities: BTreeMap::new(),
        evidence,
    }
}

fn fixture_input(candidates: Vec<RecommendationCandidate>) -> PortRecommendationInput {
    PortRecommendationInput {
        policy_version: PORT_RECOMMENDATION_POLICY.to_owned(),
        evidence_snapshot_id: "fixture-snapshot-1".to_owned(),
        evaluated_at: 100,
        context: RecommendationContext {
            game_id: "fixture-game".to_owned(),
            edition_id: "fixture-edition".to_owned(),
            platform: Platform::WindowsX86_64,
            environment_id: "fixture-device".to_owned(),
            available_source_profiles: BTreeSet::from(["fixture-source".to_owned()]),
            required_capabilities: BTreeSet::new(),
        },
        candidates,
        retained_regressions: Vec::new(),
        observed_regressions: Vec::new(),
        verified_corrections: Vec::new(),
    }
}

fn assessment(input: &PortRecommendationInput) -> PortRecommendationAssessment {
    assess_port_recommendations(input).unwrap()
}

fn regression(scope: &RecommendationScope) -> RecommendationRegression {
    RecommendationRegression {
        id: "accepted-save-regression".to_owned(),
        affected_scope: scope.clone(),
        dimension: Some(RecommendationDimension::Gameplay),
        observed_at: 20,
        source: "fixture://accepted-failure".to_owned(),
        explanation: "Synthetic accepted save failure.".to_owned(),
    }
}

fn dimension(
    candidate: &RecommendationCandidateAssessment,
    dimension: RecommendationDimension,
) -> &RecommendationDimensionAssessment {
    candidate
        .dimensions
        .iter()
        .find(|result| result.dimension == dimension)
        .unwrap()
}

#[test]
fn weights_are_normalized_and_all_six_rubrics_cover_zero_through_five() {
    assert_eq!(
        RecommendationDimension::WEIGHTED
            .iter()
            .map(|(_, weight)| weight)
            .sum::<u16>(),
        100
    );
    for rating in 0..=5 {
        let result = assessment(&fixture_input(vec![fixture_candidate("a", rating)]));
        assert_eq!(
            result.candidates[0].ranking_score_basis_points,
            Some(u16::from(rating) * 2000)
        );
        assert_eq!(result.candidates[0].evidence_coverage_permille, 1000);
        assert_eq!(result.candidates[0].dimensions.len(), 6);
        for dimension in &result.candidates[0].dimensions {
            assert_eq!(dimension.rating, Some(rating));
            assert_eq!(dimension.state, RecommendationDimensionState::Known);
        }
    }
}

#[test]
fn unknown_has_no_displayed_neutral_score_or_manufactured_winner() {
    let mut candidates = vec![fixture_candidate("a", 5), fixture_candidate("b", 5)];
    for candidate in &mut candidates {
        candidate.evidence.clear();
    }
    let result = assessment(&fixture_input(candidates));
    assert_eq!(
        result.status,
        PortRecommendationStatus::InsufficientEvidence
    );
    assert!(result.recommended.is_none());
    for candidate in &result.candidates {
        assert_eq!(candidate.ranking_score_basis_points, None);
        assert_eq!(candidate.evidence_coverage_permille, 0);
        assert!(!candidate.recommendation_eligible);
    }
}

#[test]
fn unknown_and_not_applicable_keep_their_weights_without_inflating_coverage() {
    let mut candidate = fixture_candidate("a", 5);
    candidate.evidence[2].claim = RecommendationClaim::Unknown;
    candidate.evidence[4].claim = RecommendationClaim::NotApplicable;
    let result = assessment(&fixture_input(vec![candidate.clone()]));
    let assessed = &result.candidates[0];
    assert_eq!(assessed.ranking_score_basis_points, Some(8500));
    assert_eq!(assessed.evidence_coverage_permille, 700);
    assert_eq!(
        dimension(assessed, RecommendationDimension::Performance).state,
        RecommendationDimensionState::Unknown
    );
    assert_eq!(
        dimension(assessed, RecommendationDimension::Setup).state,
        RecommendationDimensionState::NotApplicable
    );
    candidate.evidence.remove(4);
    candidate.evidence.remove(2);
    let absent = assessment(&fixture_input(vec![candidate]));
    assert_eq!(
        absent.candidates[0].ranking_score_basis_points,
        assessed.ranking_score_basis_points
    );
    assert_eq!(
        absent.candidates[0].evidence_coverage_permille,
        assessed.evidence_coverage_permille
    );
}

#[test]
fn fixed_strengths_do_not_turn_launch_or_artifact_inspection_into_gameplay() {
    let mut candidate = fixture_candidate("a", 5);
    for observation in &mut candidate.evidence {
        observation.kind = RecommendationEvidenceKind::LaunchObserved;
    }
    let result = assessment(&fixture_input(vec![candidate]));
    assert_eq!(result.candidates[0].evidence_coverage_permille, 112);
    assert!(
        result.candidates[0]
            .reasons
            .contains(&RecommendationReason::GameplayUnobserved)
    );
    assert!(
        result.candidates[0]
            .reasons
            .contains(&RecommendationReason::StabilityUnobserved)
    );
    assert!(!result.candidates[0].recommendation_eligible);
    let mut candidate = fixture_candidate("b", 5);
    for observation in &mut candidate.evidence {
        observation.kind = RecommendationEvidenceKind::ArtifactInspected;
    }
    assert_eq!(
        assessment(&fixture_input(vec![candidate])).candidates[0].evidence_coverage_permille,
        150
    );
}

#[test]
fn upstream_claims_are_weak_evidence_and_never_qualified_gameplay() {
    let mut candidate = fixture_candidate("a", 5);
    for observation in &mut candidate.evidence {
        observation.kind = RecommendationEvidenceKind::UpstreamDeclared;
    }
    let result = assessment(&fixture_input(vec![candidate]));
    assert_eq!(result.candidates[0].ranking_score_basis_points, Some(6250));
    assert_eq!(result.candidates[0].evidence_coverage_permille, 250);
    assert_eq!(
        result.status,
        PortRecommendationStatus::InsufficientEvidence
    );
}

#[test]
fn repeated_identical_reports_cannot_inflate_strength_or_coverage() {
    let original = fixture_candidate("a", 4);
    let baseline = assessment(&fixture_input(vec![original.clone()]));
    let mut repeated = original.clone();
    repeated.evidence.extend(original.evidence.clone());
    assert_eq!(assessment(&fixture_input(vec![repeated])), baseline);
    let mut corroborated = original;
    let mut extra = corroborated.evidence[0].clone();
    extra.id = "another-report".to_owned();
    corroborated.evidence.push(extra);
    let result = assessment(&fixture_input(vec![corroborated]));
    assert_eq!(
        result.candidates[0].ranking_score_basis_points,
        baseline.candidates[0].ranking_score_basis_points
    );
    assert_eq!(
        result.candidates[0].evidence_coverage_permille,
        baseline.candidates[0].evidence_coverage_permille
    );
}

#[test]
fn contradictory_duplicate_ids_are_invalid_and_order_independent() {
    let mut candidate = fixture_candidate("a", 5);
    let mut duplicate = candidate.evidence[0].clone();
    duplicate.claim = RecommendationClaim::Rating { value: 1 };
    candidate.evidence.push(duplicate);
    let first = assessment(&fixture_input(vec![candidate.clone()]));
    candidate.evidence.reverse();
    assert_eq!(assessment(&fixture_input(vec![candidate])), first);
    assert!(
        first.candidates[0]
            .reasons
            .contains(&RecommendationReason::InvalidEvidence)
    );
    assert!(!first.candidates[0].recommendation_eligible);
}

#[test]
fn conflicting_claims_remain_visible_until_an_explicit_qualified_correction() {
    let mut candidate = fixture_candidate("a", 5);
    let mut correction = candidate.evidence[0].clone();
    correction.id = "correction".to_owned();
    correction.observed_at = 30;
    correction.claim = RecommendationClaim::Rating { value: 3 };
    candidate.evidence.push(correction);
    let conflict = assessment(&fixture_input(vec![candidate.clone()]));
    assert_eq!(
        dimension(&conflict.candidates[0], RecommendationDimension::Gameplay).state,
        RecommendationDimensionState::Conflicting
    );
    assert!(!conflict.candidates[0].recommendation_eligible);
    let previous_id = candidate.evidence[0].id.clone();
    candidate
        .evidence
        .last_mut()
        .unwrap()
        .supersedes
        .insert(previous_id);
    let corrected = assessment(&fixture_input(vec![candidate]));
    assert_eq!(
        dimension(&corrected.candidates[0], RecommendationDimension::Gameplay).rating,
        Some(3)
    );
    assert!(corrected.candidates[0].recommendation_eligible);
    assert!(
        corrected.candidates[0]
            .evidence
            .iter()
            .any(|record| record.disposition == RecommendationEvidenceDisposition::Superseded)
    );
}

#[test]
fn a_release_note_cannot_supersede_an_observed_gameplay_failure() {
    let mut candidate = fixture_candidate("a", 4);
    candidate.evidence[0].claim = RecommendationClaim::Rating { value: 0 };
    let mut claim = candidate.evidence[0].clone();
    claim.id = "upstream-fixed-claim".to_owned();
    claim.kind = RecommendationEvidenceKind::UpstreamDeclared;
    claim.claim = RecommendationClaim::Rating { value: 5 };
    claim.observed_at = 30;
    claim.supersedes.insert(candidate.evidence[0].id.clone());
    candidate.evidence.push(claim);
    let result = assessment(&fixture_input(vec![candidate]));
    assert_eq!(
        dimension(&result.candidates[0], RecommendationDimension::Gameplay).rating,
        Some(0)
    );
    assert!(!result.candidates[0].recommendation_eligible);
}

#[test]
fn new_artifacts_and_changed_environments_do_not_inherit_observations() {
    let candidate = fixture_candidate("a", 5);
    for change in 0..4 {
        let mut changed = candidate.clone();
        match change {
            0 => changed.scope.artifact_id = "different-bytes".to_owned(),
            1 => changed.scope.release_id = "different-release".to_owned(),
            2 => changed.scope.environment_id = "different-device".to_owned(),
            _ => changed.scope.source_profile_id = "different-source".to_owned(),
        }
        let result = assessment(&fixture_input(vec![changed]));
        assert_eq!(result.candidates[0].evidence_coverage_permille, 0);
        assert!(
            result.candidates[0]
                .evidence
                .iter()
                .all(|record| record.disposition
                    == RecommendationEvidenceDisposition::HistoricalScope)
        );
    }
}

#[test]
fn unchanged_working_builds_have_no_blanket_age_penalty() {
    let mut input = fixture_input(vec![fixture_candidate("a", 4)]);
    let before = assessment(&input);
    input.evaluated_at = u64::MAX;
    let after = assessment(&input);
    assert_eq!(before.candidates, after.candidates);
    assert_eq!(before.status, after.status);
}

#[test]
fn future_observations_do_not_supply_present_evidence() {
    let mut candidate = fixture_candidate("a", 5);
    for evidence in &mut candidate.evidence {
        evidence.observed_at = 101;
    }
    let result = assessment(&fixture_input(vec![candidate]));
    assert_eq!(result.candidates[0].ranking_score_basis_points, None);
    assert!(
        result.candidates[0].evidence.iter().all(
            |record| record.disposition == RecommendationEvidenceDisposition::FutureObservation
        )
    );
}

#[test]
fn qualified_advantage_and_close_scores_have_distinct_deterministic_outcomes() {
    let winner = assessment(&fixture_input(vec![
        fixture_candidate("b", 3),
        fixture_candidate("a", 4),
    ]));
    assert_eq!(
        winner.status,
        PortRecommendationStatus::RecommendedStartingPoint
    );
    assert_eq!(winner.recommended.unwrap().port_id, "a");
    let mut a = fixture_candidate("a", 4);
    a.evidence[5].claim = RecommendationClaim::Rating { value: 5 };
    let input = fixture_input(vec![fixture_candidate("b", 4), a]);
    let tied = assessment(&input);
    assert_eq!(
        tied.status,
        PortRecommendationStatus::ComparableAlternatives
    );
    assert!(tied.recommended.is_none());
    assert_eq!(tied.comparable.len(), 2);
    let mut reversed = input;
    reversed.candidates.reverse();
    for candidate in &mut reversed.candidates {
        candidate.evidence.reverse();
    }
    assert_eq!(assessment(&reversed), tied);
}

#[test]
fn missing_low_rating_cannot_manufacture_a_winner_from_neutral_unknowns() {
    let mut observed = fixture_candidate("observed", 4);
    observed.evidence[2].claim = RecommendationClaim::Rating { value: 0 };
    let mut sparse = fixture_candidate("sparse", 4);
    sparse.evidence.remove(2);
    let result = assessment(&fixture_input(vec![observed, sparse]));
    assert_eq!(
        result.status,
        PortRecommendationStatus::ComparableAlternatives
    );
    assert!(result.recommended.is_none());
    assert_eq!(result.comparable.len(), 2);
}

#[test]
fn a_single_candidate_is_assessed_without_claiming_best() {
    let result = assessment(&fixture_input(vec![fixture_candidate("a", 5)]));
    assert_eq!(
        result.status,
        PortRecommendationStatus::AssessedSingleCandidate
    );
    assert!(result.recommended.is_none());
    let mut other_game = fixture_candidate("b", 5);
    other_game.scope.game_id = "another-game".to_owned();
    let result = assessment(&fixture_input(vec![fixture_candidate("a", 5), other_game]));
    assert_eq!(
        result.status,
        PortRecommendationStatus::AssessedSingleCandidate
    );
    assert!(result.recommended.is_none());
}

#[test]
fn explicit_requirements_are_noncompensable_and_unknown_is_not_unsupported() {
    let mut input = fixture_input(vec![fixture_candidate("a", 5), fixture_candidate("b", 4)]);
    input
        .context
        .required_capabilities
        .insert("multiplayer".to_owned());
    input.candidates[0].capabilities.insert(
        "multiplayer".to_owned(),
        RecommendationRequirement::Unsupported,
    );
    input.candidates[1].capabilities.insert(
        "multiplayer".to_owned(),
        RecommendationRequirement::Satisfied,
    );
    assert_eq!(assessment(&input).recommended.unwrap().port_id, "b");
    input.candidates[1].capabilities.clear();
    assert_eq!(
        assessment(&input).status,
        PortRecommendationStatus::InsufficientEvidence
    );
    input.candidates[1].capabilities.insert(
        "multiplayer".to_owned(),
        RecommendationRequirement::Unsupported,
    );
    assert_eq!(
        assessment(&input).status,
        PortRecommendationStatus::NoSuitableCandidate
    );
}

#[test]
fn operation_holds_are_preserved_and_never_averaged_into_quality() {
    let mut candidate = fixture_candidate("a", 5);
    candidate.operation_eligibility = RecommendationOperationEligibility::Held {
        reason: "Existing Core integrity restriction.".to_owned(),
    };
    let result = assessment(&fixture_input(vec![candidate.clone()]));
    assert_eq!(result.status, PortRecommendationStatus::NoSuitableCandidate);
    assert_eq!(result.candidates[0].ranking_score_basis_points, Some(10000));
    assert_eq!(
        result.candidates[0].operation_eligibility,
        candidate.operation_eligibility
    );
    assert!(!result.candidates[0].recommendation_eligible);
}

#[test]
fn setup_and_other_polish_cannot_compensate_for_materially_worse_play() {
    let mut playing = fixture_candidate("playing", 0);
    for evidence in &mut playing.evidence {
        if matches!(
            evidence.dimension,
            RecommendationDimension::Gameplay | RecommendationDimension::Stability
        ) {
            evidence.claim = RecommendationClaim::Rating { value: 5 };
        }
    }
    let mut polished = fixture_candidate("polished", 5);
    polished.evidence[0].claim = RecommendationClaim::Rating { value: 3 };
    polished.evidence[1].claim = RecommendationClaim::Rating { value: 3 };
    let result = assessment(&fixture_input(vec![playing, polished]));
    assert_eq!(result.recommended.unwrap().port_id, "playing");
    assert!(
        result.candidates[1]
            .reasons
            .contains(&RecommendationReason::MateriallyWorsePlayingExperience)
    );
}

#[test]
fn critical_failures_survive_omission_tag_advancement_and_elapsed_time() {
    let mut input = fixture_input(vec![fixture_candidate("a", 5)]);
    input
        .observed_regressions
        .push(regression(&input.candidates[0].scope));
    let first = assessment(&input);
    assert_eq!(first.status, PortRecommendationStatus::NoSuitableCandidate);
    input.retained_regressions = first.retained_regressions;
    input.observed_regressions.clear();
    input.candidates[0].scope.artifact_id = "new-artifact".to_owned();
    input.candidates[0].scope.release_id = "new-tag".to_owned();
    input.evaluated_at = u64::MAX;
    let later = assessment(&input);
    assert_eq!(
        later.candidates[0].unresolved_regression_ids,
        vec!["accepted-save-regression"]
    );
    assert_eq!(later.retained_regressions.len(), 1);
    assert!(!later.candidates[0].recommendation_eligible);
}

#[test]
fn only_exact_accepted_gameplay_corrections_resolve_critical_failure() {
    let mut input = fixture_input(vec![fixture_candidate("a", 5)]);
    input
        .retained_regressions
        .push(regression(&input.candidates[0].scope));
    let correction = RecommendationVerifiedCorrection {
        regression_id: "accepted-save-regression".to_owned(),
        dimension: Some(RecommendationDimension::Gameplay),
        scope: input.candidates[0].scope.clone(),
        observed_at: 30,
        source: "fixture://verified-gameplay-correction".to_owned(),
        kind: RecommendationEvidenceKind::GameplayObserved,
    };
    for change in 0..7 {
        let mut invalid = correction.clone();
        match change {
            0 => invalid.kind = RecommendationEvidenceKind::UpstreamDeclared,
            1 => invalid.kind = RecommendationEvidenceKind::LaunchObserved,
            2 => invalid.scope.artifact_id = "another-artifact".to_owned(),
            3 => invalid.observed_at = 101,
            4 => invalid.observed_at = 20,
            5 => invalid.dimension = Some(RecommendationDimension::Stability),
            _ => invalid.dimension = None,
        }
        input.verified_corrections = vec![invalid];
        assert!(!assessment(&input).candidates[0].recommendation_eligible);
    }
    input.verified_corrections = vec![correction];
    let resolved = assessment(&input);
    assert!(resolved.candidates[0].recommendation_eligible);
    assert_eq!(resolved.retained_regressions.len(), 1);
    input.retained_regressions[0].dimension = None;
    assert!(!assessment(&input).candidates[0].recommendation_eligible);
}

#[test]
fn conflicting_regression_identity_cannot_be_cleared_by_one_fix() {
    let mut input = fixture_input(vec![fixture_candidate("a", 5)]);
    let failure = regression(&input.candidates[0].scope);
    let mut conflicting = failure.clone();
    conflicting.explanation = "Conflicting retained identity.".to_owned();
    input.retained_regressions = vec![failure, conflicting];
    input
        .verified_corrections
        .push(RecommendationVerifiedCorrection {
            regression_id: "accepted-save-regression".to_owned(),
            dimension: Some(RecommendationDimension::Gameplay),
            scope: input.candidates[0].scope.clone(),
            observed_at: 30,
            source: "fixture://verified-correction".to_owned(),
            kind: RecommendationEvidenceKind::GameplayObserved,
        });
    assert!(!assessment(&input).candidates[0].recommendation_eligible);
}

#[test]
fn assessment_is_read_only_and_serialization_replays_identically() {
    let input = fixture_input(vec![fixture_candidate("a", 5), fixture_candidate("b", 4)]);
    let before = serde_json::to_value(&input).unwrap();
    let result = assessment(&input);
    assert_eq!(serde_json::to_value(&input).unwrap(), before);
    let replayed: PortRecommendationInput = serde_json::from_value(before).unwrap();
    assert_eq!(assessment(&replayed), result);
    let decoded: PortRecommendationAssessment =
        serde_json::from_str(&serde_json::to_string(&result).unwrap()).unwrap();
    assert_eq!(decoded, result);
}

#[test]
fn malformed_optional_inputs_refuse_assessment_without_operating_on_a_library() {
    let mut input = fixture_input(vec![fixture_candidate("a", 5)]);
    input.policy_version = "future-policy".to_owned();
    assert!(assess_port_recommendations(&input).is_err());
    input.policy_version = PORT_RECOMMENDATION_POLICY.to_owned();
    input.candidates.push(input.candidates[0].clone());
    assert!(assess_port_recommendations(&input).is_err());
    input.candidates.pop();
    input.candidates[0].scope.artifact_id.clear();
    assert!(assess_port_recommendations(&input).is_err());
}

#[test]
fn out_of_range_ratings_are_invalid_not_clamped_into_quality() {
    let mut candidate = fixture_candidate("a", 5);
    candidate.evidence[0].claim = RecommendationClaim::Rating { value: 255 };
    let result = assessment(&fixture_input(vec![candidate]));
    assert!(
        result.candidates[0]
            .reasons
            .contains(&RecommendationReason::InvalidEvidence)
    );
    assert!(!result.candidates[0].recommendation_eligible);
    assert_eq!(
        dimension(&result.candidates[0], RecommendationDimension::Gameplay).rating,
        None
    );
}

#[test]
fn platform_and_selected_source_change_suitability_without_changing_quality() {
    let mut windows = fixture_candidate("windows", 4);
    let mut linux = fixture_candidate("linux", 5);
    windows.scope.source_profile_id = "source-a".to_owned();
    linux.scope.source_profile_id = "source-b".to_owned();
    linux.scope.platform = Platform::LinuxX86_64;
    for candidate in [&mut windows, &mut linux] {
        for evidence in &mut candidate.evidence {
            evidence.scope = candidate.scope.clone();
        }
    }
    let mut input = fixture_input(vec![windows, linux]);
    input.context.available_source_profiles =
        BTreeSet::from(["source-a".to_owned(), "source-b".to_owned()]);
    let first = assessment(&input);
    assert_eq!(first.recommended.unwrap().port_id, "windows");
    input.context.platform = Platform::LinuxX86_64;
    let second = assessment(&input);
    assert_eq!(second.recommended.unwrap().port_id, "linux");
    for (before, after) in first.candidates.iter().zip(&second.candidates) {
        assert_eq!(
            before.ranking_score_basis_points,
            after.ranking_score_basis_points
        );
    }
    input.context.available_source_profiles.remove("source-b");
    assert_eq!(
        assessment(&input).status,
        PortRecommendationStatus::NoSuitableCandidate
    );
}

#[test]
fn unknown_input_semantics_refuse_instead_of_silently_discarding_new_fields() {
    let mut json = serde_json::to_value(fixture_input(vec![fixture_candidate("a", 4)])).unwrap();
    json["unrecognized_authority"] = serde_json::json!(true);
    assert!(serde_json::from_value::<PortRecommendationInput>(json).is_err());
}
