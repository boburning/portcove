//! Read-only, deterministic recommendation policy. This never grants an operation.
//!
//! Inputs are accepted, scoped Core facts, not raw upstream text. Collection and
//! persistence remain with their existing owners. See the policy reference for
//! rubrics and the intentionally unfinished adapter/collection boundary.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Platform, PortcoveError, Result};

pub const PORT_RECOMMENDATION_POLICY: &str = "balanced-v1";
const COMPARABLE_MARGIN: u16 = 500;
const MINIMUM_COVERAGE: u16 = 650;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecommendationScope {
    pub game_id: String,
    pub edition_id: String,
    pub port_id: String,
    pub release_id: String,
    /// Accepted artifact identity, not a mutable tag or download URL.
    pub artifact_id: String,
    pub platform: Platform,
    /// Explicit relevant environment identity; not inferred from the current host.
    pub environment_id: String,
    pub source_profile_id: String,
    pub route_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecommendationContext {
    pub game_id: String,
    pub edition_id: String,
    pub platform: Platform,
    pub environment_id: String,
    /// Catalog profile IDs only. No original-file bytes, hashes or paths are needed.
    pub available_source_profiles: BTreeSet<String>,
    pub required_capabilities: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RecommendationDimension {
    Gameplay,
    Stability,
    Performance,
    Controls,
    Setup,
    Maintenance,
}

impl RecommendationDimension {
    const WEIGHTED: [(Self, u16); 6] = [
        (Self::Gameplay, 30),
        (Self::Stability, 20),
        (Self::Performance, 15),
        (Self::Controls, 15),
        (Self::Setup, 15),
        (Self::Maintenance, 5),
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RecommendationEvidenceKind {
    UpstreamDeclared,
    ArtifactInspected,
    SetupObserved,
    LaunchObserved,
    GameplayObserved,
    PerformanceObserved,
    MaintenanceObserved,
}

impl RecommendationEvidenceKind {
    fn strength(self, dimension: RecommendationDimension) -> u16 {
        use RecommendationDimension as D;
        match (self, dimension) {
            (Self::UpstreamDeclared, _) => 250,
            (Self::ArtifactInspected, D::Controls | D::Setup) => 500,
            (Self::SetupObserved, D::Setup)
            | (Self::GameplayObserved, D::Gameplay | D::Stability | D::Controls)
            | (Self::PerformanceObserved, D::Performance)
            | (Self::MaintenanceObserved, D::Maintenance) => 1000,
            (Self::LaunchObserved, D::Setup) => 750,
            _ => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RecommendationClaim {
    Rating { value: u8 },
    Unknown,
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecommendationEvidence {
    pub id: String,
    pub scope: RecommendationScope,
    pub dimension: RecommendationDimension,
    pub kind: RecommendationEvidenceKind,
    pub claim: RecommendationClaim,
    pub source: String,
    pub explanation: String,
    pub observed_at: u64,
    /// Explicit accepted corrections, never implicit latest-report-wins ordering.
    pub supersedes: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RecommendationRequirement {
    Satisfied,
    Unknown,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RecommendationOperationEligibility {
    Allowed,
    Unknown { reason: String },
    Held { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecommendationCandidate {
    pub scope: RecommendationScope,
    /// Existing Core operation assessment. A recommendation cannot override it.
    pub operation_eligibility: RecommendationOperationEligibility,
    pub capabilities: BTreeMap<String, RecommendationRequirement>,
    pub evidence: Vec<RecommendationEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecommendationRegression {
    pub id: String,
    /// Retain the originally affected artifact as provenance. A new artifact does
    /// not itself resolve this accepted failure for the same route/environment.
    pub affected_scope: RecommendationScope,
    pub observed_at: u64,
    pub source: String,
    pub explanation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecommendationVerifiedCorrection {
    pub regression_id: String,
    pub scope: RecommendationScope,
    pub observed_at: u64,
    pub source: String,
    /// Must be GameplayObserved. Release-note and launch-only fixes cannot clear it.
    pub kind: RecommendationEvidenceKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PortRecommendationInput {
    pub policy_version: String,
    pub evidence_snapshot_id: String,
    pub evaluated_at: u64,
    pub context: RecommendationContext,
    pub candidates: Vec<RecommendationCandidate>,
    /// Prior accepted failures must be carried by the existing observation owner.
    pub retained_regressions: Vec<RecommendationRegression>,
    pub observed_regressions: Vec<RecommendationRegression>,
    pub verified_corrections: Vec<RecommendationVerifiedCorrection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RecommendationEvidenceDisposition {
    Current,
    HistoricalScope,
    FutureObservation,
    UnsupportedObservationKind,
    Superseded,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecommendationEvidenceAssessment {
    pub evidence: RecommendationEvidence,
    pub disposition: RecommendationEvidenceDisposition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RecommendationDimensionState {
    Known,
    Unknown,
    NotApplicable,
    Conflicting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecommendationDimensionAssessment {
    pub dimension: RecommendationDimension,
    pub weight_percent: u16,
    pub state: RecommendationDimensionState,
    pub rating: Option<u8>,
    pub strength_permille: u16,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RecommendationReason {
    DifferentGameOrEdition,
    DifferentPlatformOrEnvironment,
    SourceNotSelected,
    OperationUnknown,
    OperationHeld,
    RequirementUnknown,
    RequirementUnsupported,
    InvalidEvidence,
    ConflictingEvidence,
    CriticalRegression,
    InsufficientCoverage,
    GameplayUnobserved,
    StabilityUnobserved,
    GameplayBelowDefaultFloor,
    StabilityBelowDefaultFloor,
    MateriallyWorsePlayingExperience,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecommendationCandidateAssessment {
    pub scope: RecommendationScope,
    pub operation_eligibility: RecommendationOperationEligibility,
    pub required_capabilities: BTreeMap<String, RecommendationRequirement>,
    pub dimensions: Vec<RecommendationDimensionAssessment>,
    pub evidence: Vec<RecommendationEvidenceAssessment>,
    /// Diagnostic 0..10000, never a cross-game public quality score. All-unknown
    /// evidence is None, not a displayed neutral 50/100.
    pub ranking_score_basis_points: Option<u16>,
    /// Coverage of this policy's evidence, not probability of successful play.
    pub evidence_coverage_permille: u16,
    pub recommendation_eligible: bool,
    pub unresolved_regression_ids: Vec<String>,
    pub reasons: Vec<RecommendationReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PortRecommendationStatus {
    RecommendedStartingPoint,
    ComparableAlternatives,
    AssessedSingleCandidate,
    InsufficientEvidence,
    NoSuitableCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PortRecommendationAssessment {
    pub policy_version: String,
    pub evidence_snapshot_id: String,
    pub evaluated_at: u64,
    pub status: PortRecommendationStatus,
    pub recommended: Option<RecommendationScope>,
    pub comparable: Vec<RecommendationScope>,
    pub candidates: Vec<RecommendationCandidateAssessment>,
    /// Feed this union back through the existing observation store on refresh.
    /// Corrections do not erase original failure evidence.
    pub retained_regressions: Vec<RecommendationRegression>,
}

/// Assess one game/edition using accepted scoped facts, without IO or mutations.
/// Invalid optional metadata returns an error for the caller's ordinary-listing
/// fallback; it must not be used to deny an otherwise allowed operation.
pub fn assess_port_recommendations(
    input: &PortRecommendationInput,
) -> Result<PortRecommendationAssessment> {
    validate_input(input)?;
    let regressions = input
        .retained_regressions
        .iter()
        .chain(&input.observed_regressions)
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut candidates = input
        .candidates
        .iter()
        .map(|candidate| assess_candidate(input, candidate, &regressions))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.scope.cmp(&right.scope));
    let dominated = candidates
        .iter()
        .map(|candidate| {
            candidate.recommendation_eligible
                && candidates.iter().any(|other| {
                    other.recommendation_eligible && materially_better_play(other, candidate)
                })
        })
        .collect::<Vec<_>>();
    for (candidate, dominated) in candidates.iter_mut().zip(dominated) {
        if dominated {
            candidate.recommendation_eligible = false;
            candidate
                .reasons
                .push(RecommendationReason::MateriallyWorsePlayingExperience);
        }
    }
    let mut eligible = candidates
        .iter()
        .filter(|candidate| candidate.recommendation_eligible)
        .collect::<Vec<_>>();
    eligible.sort_by(|left, right| {
        right
            .ranking_score_basis_points
            .cmp(&left.ranking_score_basis_points)
            .then_with(|| left.scope.cmp(&right.scope))
    });
    let mut recommended = None;
    let mut comparable = Vec::new();
    let status = if let Some(best) = eligible.first() {
        let best_score = best.ranking_score_basis_points.unwrap_or_default();
        comparable = eligible
            .iter()
            .filter(|candidate| {
                best_score
                    .saturating_sub(candidate.ranking_score_basis_points.unwrap_or_default())
                    <= COMPARABLE_MARGIN
                    || shared_evidence_advantage(best, candidate) <= i64::from(COMPARABLE_MARGIN)
            })
            .map(|candidate| candidate.scope.clone())
            .collect();
        let in_game = candidates
            .iter()
            .filter(|candidate| {
                candidate.scope.game_id == input.context.game_id
                    && candidate.scope.edition_id == input.context.edition_id
            })
            .count();
        if in_game == 1 {
            PortRecommendationStatus::AssessedSingleCandidate
        } else if comparable.len() > 1 {
            PortRecommendationStatus::ComparableAlternatives
        } else {
            recommended = Some(best.scope.clone());
            PortRecommendationStatus::RecommendedStartingPoint
        }
    } else if !candidates.is_empty() && candidates.iter().all(known_unsuitable) {
        PortRecommendationStatus::NoSuitableCandidate
    } else {
        PortRecommendationStatus::InsufficientEvidence
    };
    Ok(PortRecommendationAssessment {
        policy_version: PORT_RECOMMENDATION_POLICY.to_owned(),
        evidence_snapshot_id: input.evidence_snapshot_id.clone(),
        evaluated_at: input.evaluated_at,
        status,
        recommended,
        comparable,
        candidates,
        retained_regressions: regressions,
    })
}

fn validate_input(input: &PortRecommendationInput) -> Result<()> {
    let present = |value: &str| {
        !value.is_empty() && value.trim() == value && !value.chars().any(char::is_control)
    };
    if input.policy_version != PORT_RECOMMENDATION_POLICY {
        return Err(PortcoveError::usage("unsupported recommendation policy"));
    }
    if ![
        input.evidence_snapshot_id.as_str(),
        input.context.game_id.as_str(),
        input.context.edition_id.as_str(),
        input.context.environment_id.as_str(),
    ]
    .into_iter()
    .all(present)
    {
        return Err(PortcoveError::usage("incomplete recommendation context"));
    }
    let mut scopes = BTreeSet::new();
    for candidate in &input.candidates {
        let scope = &candidate.scope;
        if ![
            scope.game_id.as_str(),
            scope.edition_id.as_str(),
            scope.port_id.as_str(),
            scope.release_id.as_str(),
            scope.artifact_id.as_str(),
            scope.environment_id.as_str(),
            scope.source_profile_id.as_str(),
            scope.route_id.as_str(),
        ]
        .into_iter()
        .all(present)
            || !scopes.insert(scope)
        {
            return Err(PortcoveError::usage(
                "incomplete or duplicate recommendation candidate identity",
            ));
        }
    }
    Ok(())
}

fn assess_candidate(
    input: &PortRecommendationInput,
    candidate: &RecommendationCandidate,
    regressions: &[RecommendationRegression],
) -> RecommendationCandidateAssessment {
    use RecommendationReason as R;
    let scope = &candidate.scope;
    let context = &input.context;
    let evidence = assess_evidence(candidate, input.evaluated_at);
    let dimensions = RecommendationDimension::WEIGHTED
        .iter()
        .map(|(dimension, weight)| assess_dimension(*dimension, *weight, &evidence))
        .collect::<Vec<_>>();
    let mut reasons = Vec::new();
    if scope.game_id != context.game_id || scope.edition_id != context.edition_id {
        reasons.push(R::DifferentGameOrEdition);
    }
    if scope.platform != context.platform || scope.environment_id != context.environment_id {
        reasons.push(R::DifferentPlatformOrEnvironment);
    }
    if !context.available_source_profiles.contains(&scope.source_profile_id) {
        reasons.push(R::SourceNotSelected);
    }
    match candidate.operation_eligibility {
        RecommendationOperationEligibility::Allowed => {}
        RecommendationOperationEligibility::Unknown { .. } => reasons.push(R::OperationUnknown),
        RecommendationOperationEligibility::Held { .. } => reasons.push(R::OperationHeld),
    }
    let required_capabilities = context
        .required_capabilities
        .iter()
        .map(|requirement| {
            let state = candidate
                .capabilities
                .get(requirement)
                .copied()
                .unwrap_or(RecommendationRequirement::Unknown);
            let reason = match state {
                RecommendationRequirement::Satisfied => None,
                RecommendationRequirement::Unknown => Some(R::RequirementUnknown),
                RecommendationRequirement::Unsupported => Some(R::RequirementUnsupported),
            };
            if let Some(reason) = reason
                && !reasons.contains(&reason)
            {
                reasons.push(reason);
            }
            (requirement.clone(), state)
        })
        .collect();
    if evidence.iter().any(|record| {
        record.disposition == RecommendationEvidenceDisposition::Invalid
            && record.evidence.scope == *scope
    }) {
        reasons.push(R::InvalidEvidence);
    }
    if dimensions
        .iter()
        .any(|dimension| dimension.state == RecommendationDimensionState::Conflicting)
    {
        reasons.push(R::ConflictingEvidence);
    }
    let unresolved_regression_ids = regressions
        .iter()
        .filter(|regression| {
            same_playing_scope(&regression.affected_scope, scope)
                && !regression_resolved(input, regression, scope, regressions)
        })
        .map(|regression| regression.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if !unresolved_regression_ids.is_empty() {
        reasons.push(R::CriticalRegression);
    }
    let coverage = dimensions
        .iter()
        .map(|dimension| u32::from(dimension.weight_percent) * u32::from(dimension.strength_permille))
        .sum::<u32>()
        / 100;
    if coverage < u32::from(MINIMUM_COVERAGE) {
        reasons.push(R::InsufficientCoverage);
    }
    for (dimension, unknown, low) in [
        (RecommendationDimension::Gameplay, R::GameplayUnobserved, R::GameplayBelowDefaultFloor),
        (RecommendationDimension::Stability, R::StabilityUnobserved, R::StabilityBelowDefaultFloor),
    ] {
        let result = dimensions.iter().find(|result| result.dimension == dimension);
        match result {
            Some(result) if result.strength_permille == 1000 => {
                if result.rating.is_some_and(|rating| rating < 3) {
                    reasons.push(low);
                }
            }
            _ => reasons.push(unknown),
        }
    }
    let score = dimensions
        .iter()
        .map(|dimension| {
            let rating = i64::from(dimension.rating.unwrap_or_default());
            let estimate = 5000
                + i64::from(dimension.strength_permille) * (rating * 2000 - 5000) / 1000;
            i64::from(dimension.weight_percent) * estimate
        })
        .sum::<i64>()
        / 100;
    RecommendationCandidateAssessment {
        scope: scope.clone(),
        operation_eligibility: candidate.operation_eligibility.clone(),
        required_capabilities,
        dimensions,
        evidence,
        ranking_score_basis_points: (coverage > 0).then_some(score as u16),
        evidence_coverage_permille: coverage as u16,
        recommendation_eligible: reasons.is_empty(),
        unresolved_regression_ids,
        reasons,
    }
}

fn assess_evidence(
    candidate: &RecommendationCandidate,
    evaluated_at: u64,
) -> Vec<RecommendationEvidenceAssessment> {
    use RecommendationEvidenceDisposition as D;
    let mut groups: BTreeMap<&str, Vec<&RecommendationEvidence>> = BTreeMap::new();
    for evidence in &candidate.evidence {
        let group = groups.entry(&evidence.id).or_default();
        if !group.contains(&evidence) {
            group.push(evidence);
        }
    }
    // Conflicting duplicate IDs are unusable, rather than whichever report arrived first.
    let mut records = groups
        .values()
        .flat_map(|group| {
            group.iter().map(move |evidence| {
                let disposition = if evidence.scope != candidate.scope {
                    D::HistoricalScope
                } else if group.len() != 1
                    || evidence.id.trim().is_empty()
                    || evidence.source.trim().is_empty()
                    || evidence.explanation.trim().is_empty()
                    || matches!(evidence.claim, RecommendationClaim::Rating { value } if value > 5)
                {
                    D::Invalid
                } else if evidence.observed_at > evaluated_at {
                    D::FutureObservation
                } else if evidence.kind.strength(evidence.dimension) == 0 {
                    D::UnsupportedObservationKind
                } else {
                    D::Current
                };
                RecommendationEvidenceAssessment {
                    evidence: (**evidence).clone(),
                    disposition,
                }
            })
        })
        .collect::<Vec<_>>();
    // Canonical ordering also covers contradictory records sharing an ID.
    records.sort_by(|left, right| left.evidence.cmp(&right.evidence));
    let original = records.clone();
    let mut superseded = BTreeSet::new();
    for record in &mut records {
        if record.disposition != D::Current || record.evidence.supersedes.is_empty() {
            continue;
        }
        let correction = &record.evidence;
        let targets = correction
            .supersedes
            .iter()
            .map(|id| original.iter().filter(|prior| prior.evidence.id == *id).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let valid = targets.iter().all(|matches| {
            matches.len() == 1
                && matches[0].disposition == D::Current
                && matches[0].evidence.scope == correction.scope
                && matches[0].evidence.dimension == correction.dimension
                // Strict time ordering excludes cycles without implicit latest-wins behavior.
                && matches[0].evidence.observed_at < correction.observed_at
                && matches[0].evidence.kind.strength(correction.dimension)
                    <= correction.kind.strength(correction.dimension)
        });
        if valid {
            superseded.extend(correction.supersedes.iter().cloned());
        } else {
            record.disposition = D::Invalid;
        }
    }
    for record in &mut records {
        if record.disposition == D::Current && superseded.contains(&record.evidence.id) {
            record.disposition = D::Superseded;
        }
    }
    records
}

fn assess_dimension(
    dimension: RecommendationDimension,
    weight_percent: u16,
    evidence: &[RecommendationEvidenceAssessment],
) -> RecommendationDimensionAssessment {
    let active = evidence
        .iter()
        .filter(|record| {
            record.disposition == RecommendationEvidenceDisposition::Current
                && record.evidence.dimension == dimension
        })
        .map(|record| &record.evidence)
        .collect::<Vec<_>>();
    let ratings = active
        .iter()
        .filter_map(|record| match record.claim {
            RecommendationClaim::Rating { value } => Some(value),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let not_applicable = active
        .iter()
        .any(|record| record.claim == RecommendationClaim::NotApplicable);
    let state = if ratings.len() > 1 || (!ratings.is_empty() && not_applicable) {
        RecommendationDimensionState::Conflicting
    } else if !ratings.is_empty() {
        RecommendationDimensionState::Known
    } else if not_applicable {
        RecommendationDimensionState::NotApplicable
    } else {
        RecommendationDimensionState::Unknown
    };
    let rating = (state == RecommendationDimensionState::Known)
        .then(|| ratings.first().copied())
        .flatten();
    let strength_permille = if rating.is_some() {
        active
            .iter()
            .filter(|record| matches!(record.claim, RecommendationClaim::Rating { .. }))
            .map(|record| record.kind.strength(dimension))
            .max()
            .unwrap_or_default()
    } else {
        0
    };
    RecommendationDimensionAssessment {
        dimension,
        weight_percent,
        state,
        rating,
        strength_permille,
        evidence_ids: active.iter().map(|record| record.id.clone()).collect(),
    }
}

fn same_playing_scope(left: &RecommendationScope, right: &RecommendationScope) -> bool {
    left.game_id == right.game_id
        && left.edition_id == right.edition_id
        && left.port_id == right.port_id
        && left.platform == right.platform
        && left.environment_id == right.environment_id
        && left.source_profile_id == right.source_profile_id
        && left.route_id == right.route_id
}

fn regression_resolved(
    input: &PortRecommendationInput,
    regression: &RecommendationRegression,
    scope: &RecommendationScope,
    regressions: &[RecommendationRegression],
) -> bool {
    let unambiguous = regressions.iter().filter(|other| other.id == regression.id).count() == 1;
    unambiguous
        && input.verified_corrections.iter().any(|correction| {
            correction.regression_id == regression.id
                && correction.scope == *scope
                && correction.kind == RecommendationEvidenceKind::GameplayObserved
                && correction.observed_at > regression.observed_at
                && correction.observed_at <= input.evaluated_at
                && !correction.source.trim().is_empty()
        })
}

fn materially_better_play(
    better: &RecommendationCandidateAssessment,
    worse: &RecommendationCandidateAssessment,
) -> bool {
    let rating = |candidate: &RecommendationCandidateAssessment, dimension| {
        candidate
            .dimensions
            .iter()
            .find(|result| result.dimension == dimension)
            .and_then(|result| result.rating)
            .unwrap_or_default()
    };
    let better_gameplay = rating(better, RecommendationDimension::Gameplay);
    let worse_gameplay = rating(worse, RecommendationDimension::Gameplay);
    let better_stability = rating(better, RecommendationDimension::Stability);
    let worse_stability = rating(worse, RecommendationDimension::Stability);
    (better_gameplay >= worse_gameplay.saturating_add(2) && better_stability >= worse_stability)
        || (better_stability >= worse_stability.saturating_add(2) && better_gameplay >= worse_gameplay)
}

// A neutral unknown must not create an advantage over an observed low rating.
// Compare only jointly known dimensions at the weaker of their two strengths.
fn shared_evidence_advantage(
    left: &RecommendationCandidateAssessment,
    right: &RecommendationCandidateAssessment,
) -> i64 {
    left.dimensions
        .iter()
        .zip(&right.dimensions)
        .filter_map(|(left, right)| {
            let difference = i64::from(left.rating?) - i64::from(right.rating?);
            let strength = left.strength_permille.min(right.strength_permille);
            Some(i64::from(left.weight_percent) * difference * 2000 * i64::from(strength))
        })
        .sum::<i64>()
        / 100_000
}

fn known_unsuitable(candidate: &RecommendationCandidateAssessment) -> bool {
    use RecommendationReason as R;
    candidate.reasons.iter().any(|reason| {
        matches!(
            reason,
            R::DifferentGameOrEdition
                | R::DifferentPlatformOrEnvironment
                | R::SourceNotSelected
                | R::OperationHeld
                | R::RequirementUnsupported
                | R::CriticalRegression
                | R::GameplayBelowDefaultFloor
                | R::StabilityBelowDefaultFloor
        )
    })
}

#[cfg(test)]
mod tests;
