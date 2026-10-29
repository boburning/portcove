//! Optional, inert catalog observations. Named rubric outcomes are not catalog scores.
//! The accepted catalog supplies provenance; provider text never constructs observations.
use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    RecommendationClaim, RecommendationDimension as Dimension, RecommendationEvidence,
    RecommendationEvidenceKind as Kind, RecommendationRegression, RecommendationRequirement,
    RecommendationScope, RecommendationVerifiedCorrection,
};

pub const RECOMMENDATION_METADATA_VERSION: u32 = 1;
const MAX_METADATA_BYTES: usize = 128 * 1024;
const MAX_OBSERVATIONS: usize = 64;

/// One documented outcome in the assessed scope, not a universal judgment about a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "dimension",
    content = "outcome",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum RecommendationOutcome {
    Gameplay(GameplayOutcome),
    Stability(StabilityOutcome),
    Performance(PerformanceOutcome),
    Controls(ControlsOutcome),
    Setup(SetupOutcome),
    Maintenance(MaintenanceOutcome),
    Unknown(Dimension),
    NotApplicable(Dimension),
}

macro_rules! rubric {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "kebab-case")]
        pub enum $name { $($variant),+ }
    };
}
rubric!(GameplayOutcome {
    CannotPlay,
    RequiredContentMissing,
    ProgressionDefects,
    MainLoopWithLimitations,
    ProgressionWithMinorDefects,
    AssessedScopeComplete,
});
rubric!(StabilityOutcome {
    DestructiveOrUnusable,
    FrequentCrashesOrSaveFailures,
    MaterialReliabilityGaps,
    RepeatablePlayAndSaveWithLimitations,
    RepeatedReliableSessions,
    AssessedLifecycleAndRecoveryReliable,
});
rubric!(PerformanceOutcome {
    Unusable,
    SevereInterruption,
    MaterialPacingProblems,
    PlayableWithinMeasuredLimits,
    ConsistentMeasuredPerformance,
    AssessedTargetMet,
});
rubric!(ControlsOutcome {
    RequiredInteractionUnusable,
    MajorInteractionGaps,
    MaterialControlLimitations,
    AssessedInteractionWithLimitations,
    UsefulControlsAndAccessibility,
    AssessedInteractionGoalsMet,
});
rubric!(SetupOutcome {
    CannotComplete,
    UnrecoverableProblems,
    ManualOrRecoveryLimitations,
    RepeatableSetupWithLimitations,
    RepeatableSetupVerificationAndUpdate,
    AssessedSetupUpdateAndRecoveryGoalsMet,
});
rubric!(MaintenanceOutcome {
    ExplicitAbandonment,
    UnresolvedContinuityFailure,
    StatedContinuityLimits,
    AttributableContinuityWithLimitations,
    DemonstratedRegressionHandling,
    DemonstratedContinuityAndSuccession,
});

impl RecommendationOutcome {
    pub(crate) fn claim(self) -> (Dimension, RecommendationClaim) {
        let (dimension, value) = match self {
            Self::Gameplay(value) => (Dimension::Gameplay, value as u8),
            Self::Stability(value) => (Dimension::Stability, value as u8),
            Self::Performance(value) => (Dimension::Performance, value as u8),
            Self::Controls(value) => (Dimension::Controls, value as u8),
            Self::Setup(value) => (Dimension::Setup, value as u8),
            Self::Maintenance(value) => (Dimension::Maintenance, value as u8),
            Self::Unknown(dimension) => return (dimension, RecommendationClaim::Unknown),
            Self::NotApplicable(dimension) => {
                return (dimension, RecommendationClaim::NotApplicable);
            }
        };
        (dimension, RecommendationClaim::Rating { value })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecommendationObservation {
    pub id: String,
    pub scope: RecommendationScope,
    pub kind: Kind,
    pub outcome: RecommendationOutcome,
    pub source: String,
    pub explanation: String,
    pub observed_at: u64,
    #[serde(default)]
    pub supersedes: BTreeSet<String>,
    /// Explicit accepted fixes. Only exact-scope observed gameplay/save success can clear a failure.
    #[serde(default)]
    pub fixes: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecommendationCapabilityObservation {
    pub id: String,
    pub scope: RecommendationScope,
    pub capability: String,
    pub state: RecommendationRequirement,
    pub kind: Kind,
    pub source: String,
    pub explanation: String,
    pub observed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecommendationMetadata {
    pub format_version: u32,
    #[serde(default)]
    pub observations: Vec<RecommendationObservation>,
    #[serde(default)]
    pub capabilities: Vec<RecommendationCapabilityObservation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RecommendationMetadataState {
    Available,
    Missing,
    Invalid,
    UnsupportedVersion,
}

pub(crate) struct NormalizedMetadata {
    pub state: RecommendationMetadataState,
    pub evidence: Vec<RecommendationEvidence>,
    pub capabilities: Vec<RecommendationCapabilityObservation>,
    pub regressions: Vec<RecommendationRegression>,
    pub corrections: Vec<RecommendationVerifiedCorrection>,
}

pub(crate) fn empty(state: RecommendationMetadataState) -> NormalizedMetadata {
    NormalizedMetadata {
        state,
        evidence: Vec::new(),
        capabilities: Vec::new(),
        regressions: Vec::new(),
        corrections: Vec::new(),
    }
}

pub(crate) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn public_reference(value: &str) -> bool {
    value.len() <= 2048
        && reqwest::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
        })
}

fn provenance(id: &str, source: &str, explanation: &str) -> bool {
    identifier(id)
        && public_reference(source)
        && !explanation.trim().is_empty()
        && explanation.len() <= 2048
        && !explanation.chars().any(|c| c.is_control() && c != '\n')
}

fn scope_valid(scope: &RecommendationScope, port: &crate::PortDefinition) -> bool {
    let Some(game) = port
        .presentation
        .as_ref()
        .and_then(|p| p.original_game.as_ref())
    else {
        return false;
    };
    let digest = scope.artifact_id.strip_prefix("sha256:");
    scope.port_id == port.id
        && scope.game_id == game.id
        && game
            .source_editions
            .iter()
            .any(|edition| edition.id == scope.edition_id)
        && port.platforms.contains(&scope.platform)
        && scope.source_profile_id
            == port
                .source_profile
                .as_deref()
                .unwrap_or("no-original-files")
        && scope.route_id == super::route_id(port)
        && digest.is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit())
        })
        && [scope.release_id.as_str(), scope.environment_id.as_str()]
            .into_iter()
            .all(identifier)
        && scope.environment_id != "unqualified-host"
}

/// Invalid/future optional schemas cannot poison the ordinary catalog reader.
/// The raw value is retained by the catalog; only this bounded typed interpretation is optional.
pub(crate) fn normalize(port: &crate::PortDefinition, evaluated_at: u64) -> NormalizedMetadata {
    use RecommendationMetadataState as State;
    let Some(raw) = port
        .presentation
        .as_ref()
        .and_then(|p| p.recommendation.as_ref())
    else {
        return empty(State::Missing);
    };
    if raw
        .get("format_version")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|version| version != u64::from(RECOMMENDATION_METADATA_VERSION))
    {
        return empty(State::UnsupportedVersion);
    }
    if serde_json::to_vec(raw).map_or(true, |bytes| bytes.len() > MAX_METADATA_BYTES) {
        return empty(State::Invalid);
    }
    let Ok(metadata) = serde_json::from_value::<RecommendationMetadata>(raw.clone()) else {
        return empty(State::Invalid);
    };
    if metadata.format_version != RECOMMENDATION_METADATA_VERSION
        || metadata.observations.len() > MAX_OBSERVATIONS
        || metadata.capabilities.len() > MAX_OBSERVATIONS
        || metadata.observations.iter().any(|observation| {
            !scope_valid(&observation.scope, port)
                || !provenance(
                    &observation.id,
                    &observation.source,
                    &observation.explanation,
                )
                || observation.supersedes.len() > MAX_OBSERVATIONS
                || observation.fixes.len() > MAX_OBSERVATIONS
                || observation
                    .supersedes
                    .iter()
                    .chain(&observation.fixes)
                    .any(|id| !identifier(id))
        })
        || metadata.capabilities.iter().any(|observation| {
            !scope_valid(&observation.scope, port)
                || !identifier(&observation.capability)
                || !provenance(
                    &observation.id,
                    &observation.source,
                    &observation.explanation,
                )
        })
    {
        return empty(State::Invalid);
    }
    let mut result = empty(State::Available);
    let observations = metadata.observations;
    for observation in &observations {
        let (dimension, claim) = observation.outcome.claim();
        let playing = matches!(dimension, Dimension::Gameplay | Dimension::Stability)
            && observation.kind == Kind::GameplayObserved;
        if playing && matches!(claim, RecommendationClaim::Rating { value: 0..=2 }) {
            // Every accepted observed material playing failure survives later collection omission.
            result.regressions.push(RecommendationRegression {
                id: observation.id.clone(),
                affected_scope: observation.scope.clone(),
                dimension: Some(dimension),
                observed_at: observation.observed_at,
                source: observation.source.clone(),
                explanation: observation.explanation.clone(),
            });
        }
        if !observation.fixes.is_empty()
            && (!playing || !matches!(claim, RecommendationClaim::Rating { value: 3..=5 }))
        {
            return empty(State::Invalid);
        }
        result.evidence.push(RecommendationEvidence {
            id: observation.id.clone(),
            scope: observation.scope.clone(),
            dimension,
            kind: observation.kind,
            claim,
            source: observation.source.clone(),
            explanation: observation.explanation.clone(),
            observed_at: observation.observed_at,
            supersedes: observation.supersedes.clone(),
        });
    }
    // A typed claim alone is not an accepted correction. Require the policy's
    // current, exact-scope, unambiguous observation and a nonconflicting playing dimension.
    for observation in observations
        .iter()
        .filter(|record| !record.fixes.is_empty() && record.observed_at <= evaluated_at)
    {
        let (dimension, _) = observation.outcome.claim();
        let scope = &observation.scope;
        let candidate = crate::RecommendationCandidate {
            scope: scope.clone(),
            operation_eligibility: crate::RecommendationOperationEligibility::Allowed,
            capabilities: BTreeMap::new(),
            evidence: result.evidence.clone(),
        };
        let input = crate::PortRecommendationInput {
            policy_version: crate::PORT_RECOMMENDATION_POLICY.into(),
            evidence_snapshot_id: "catalog-correction-validation".into(),
            evaluated_at,
            context: crate::RecommendationContext {
                game_id: scope.game_id.clone(),
                edition_id: scope.edition_id.clone(),
                platform: scope.platform,
                environment_id: scope.environment_id.clone(),
                available_source_profiles: BTreeSet::from([scope.source_profile_id.clone()]),
                required_capabilities: BTreeSet::new(),
            },
            candidates: vec![candidate],
            retained_regressions: vec![],
            observed_regressions: vec![],
            verified_corrections: vec![],
        };
        let Ok(assessment) = crate::assess_port_recommendations(&input) else {
            continue;
        };
        let checked = &assessment.candidates[0];
        if checked
            .reasons
            .contains(&crate::RecommendationReason::InvalidEvidence)
            || !checked.evidence.iter().any(|record| {
                record.evidence.id == observation.id
                    && record.disposition == crate::RecommendationEvidenceDisposition::Current
            })
            || !checked.dimensions.iter().any(|result| {
                result.dimension == dimension
                    && result.strength_permille == 1000
                    && result.state == crate::RecommendationDimensionState::Known
                    && result.rating.is_some_and(|rating| rating >= 3)
            })
        {
            continue;
        }
        for id in &observation.fixes {
            result.corrections.push(RecommendationVerifiedCorrection {
                regression_id: id.clone(),
                dimension: Some(dimension),
                scope: scope.clone(),
                observed_at: observation.observed_at,
                source: observation.source.clone(),
                kind: Kind::GameplayObserved,
            });
        }
    }
    result.capabilities = metadata.capabilities;
    result
}

pub(crate) fn capability_states(
    observations: &[RecommendationCapabilityObservation],
    scope: &RecommendationScope,
    evaluated_at: u64,
) -> BTreeMap<String, RecommendationRequirement> {
    use RecommendationRequirement as State;
    let mut current: BTreeMap<&str, Vec<&RecommendationCapabilityObservation>> = BTreeMap::new();
    for observation in observations
        .iter()
        .filter(|record| record.scope == *scope && record.observed_at <= evaluated_at)
    {
        let entries = current.entry(&observation.capability).or_default();
        if !entries.contains(&observation) {
            entries.push(observation);
        }
    }
    current
        .into_iter()
        .map(|(capability, entries)| {
            // Conflicting IDs/claims stay unknown. A declaration is visible, but cannot by itself
            // satisfy an explicit player requirement for a recommended default.
            let mut ids = BTreeMap::new();
            let mut states = BTreeSet::new();
            let mut invalid = false;
            for record in entries {
                if ids
                    .insert(&record.id, record)
                    .is_some_and(|old| old != record)
                {
                    invalid = true;
                }
                if matches!(
                    record.kind,
                    Kind::GameplayObserved | Kind::ArtifactInspected
                ) {
                    states.insert(match record.state {
                        State::Satisfied => 1,
                        State::Unsupported => 2,
                        State::Unknown => 0,
                    });
                }
            }
            let state = if invalid || states.len() != 1 {
                State::Unknown
            } else {
                match states.first() {
                    Some(1) => State::Satisfied,
                    Some(2) => State::Unsupported,
                    _ => State::Unknown,
                }
            };
            (capability.to_owned(), state)
        })
        .collect()
}
