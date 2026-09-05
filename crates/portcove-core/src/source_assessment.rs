//! Source facts shared by inspection and its consumers. These records describe
//! evidence; they do not authorize registration, installation, or filesystem work.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Platform, SourceHealth};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceAssessment {
    pub health: SourceHealth,
    pub classification: SourceClassification,
    pub contract: SourceContractResult,
    pub admission: SourceAdmission,
    pub evidence: Vec<SourceEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SourceClassification {
    NotEvaluated,
    Unrecognized,
    Recognized { identity: SourceIdentity },
    Ambiguous { candidates: Vec<SourceIdentity> },
}

/// Stable catalog identifiers, never display names or inferred hash-array pairs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceIdentity {
    pub game_id: String,
    pub variant_id: String,
    pub representation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SourceContractResult {
    NotEvaluated,
    UnreviewedForRelease,
    Supported { contract_id: String },
    RecognizedNotListed { contract_id: String },
    KnownIncompatible { contract_id: String },
    Informational { contract_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SourceAdmission {
    NotEvaluated,
    Admitted { mode: SourceAdmissionMode },
    Rejected { reason: SourceRejectionReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceAdmissionMode {
    ExactIdentity,
    StructuralChecks,
    InformationalConsent,
    UpstreamValidator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceRejectionReason {
    Missing,
    Unreadable,
    Changed,
    KnownMismatch,
    AmbiguousIdentity,
    MissingTool,
    CheckFailed,
    ConsentRequired,
}

/// Missing legacy scope is explicit, not a wildcard for a newly selected variant.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SourceVariantScope {
    #[default]
    Unspecified,
    Exact {
        identity: SourceIdentity,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceEvidenceScope {
    pub port_id: String,
    pub platform: Platform,
    pub artifact_sha256: Option<String>,
    pub upstream_ref: Option<String>,
    pub contract_id: Option<String>,
    #[serde(default)]
    pub variant: SourceVariantScope,
    /// Version of the tested adapter/tool/check contract, not today's app build.
    pub check_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceEvidenceKind {
    StructuralCheck,
    AutomatedLifecycle,
    HandsOn,
    KnownFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceEvidenceOutcome {
    Passed,
    Failed,
    NotRun,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceEvidence {
    pub scope: SourceEvidenceScope,
    pub kind: SourceEvidenceKind,
    pub outcome: SourceEvidenceOutcome,
    pub observed_at: i64,
    pub portcove_version: Option<String>,
    pub portcove_commit: Option<String>,
    pub method: String,
    /// Reviewed catalog evidence IDs. A renderer must not treat these as URLs.
    pub evidence_ids: Vec<String>,
}

impl SourceEvidence {
    /// Exact relevance only. Callers must still inspect kind and outcome; a
    /// relevant failed check is never qualification. Historical records survive.
    pub fn applies_to(&self, scope: &SourceEvidenceScope) -> bool {
        self.scope == *scope
            && scope.artifact_sha256.as_ref().is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            && scope.contract_id.as_ref().is_some_and(|id| !id.is_empty())
            && scope
                .check_version
                .as_ref()
                .is_some_and(|id| !id.is_empty())
            && matches!(&scope.variant, SourceVariantScope::Exact { identity }
                if !identity.game_id.is_empty()
                    && !identity.variant_id.is_empty()
                    && !identity.representation_id.is_empty())
    }
}

#[cfg(test)]
#[path = "source_assessment_tests.rs"]
mod tests;
