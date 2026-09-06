//! Typed catalog authority for source identity, admission contracts, and evidence.

use std::collections::{HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    DiscIdentityProfile, DiscSourceProfile, PortcoveError, Result, SourceEvidence,
    SourceEvidenceKind, SourceEvidenceOutcome, SourceEvidenceScope, SourceKind,
    SourceMemberProfile, SourceProfile, SourceVariantScope,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceCatalog {
    pub evidence: Vec<CatalogEvidence>,
    pub identities: Vec<SourceIdentityProfile>,
    pub contracts: Vec<PortSourceContract>,
    pub validators: Vec<SourceValidatorContract>,
    /// Exact qualification facts. Legacy platform arrays remain on the port and
    /// are never promoted into these records because they do not identify an
    /// artifact, source variant, representation, or check contract.
    #[serde(default)]
    pub qualification: Vec<SourceEvidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QualificationEvidenceState {
    Missing,
    Unknown,
    NotRun,
    Passed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceQualificationAssessment {
    pub structural_check: QualificationEvidenceState,
    pub automated_lifecycle: QualificationEvidenceState,
    pub hands_on: QualificationEvidenceState,
    pub known_failure: QualificationEvidenceState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CatalogEvidence {
    pub id: String,
    pub role: CatalogEvidenceRole,
    pub authority: String,
    pub authority_ref: String,
    pub reviewed_at: String,
    pub claim: String,
    pub immutable_url: String,
    pub live_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CatalogEvidenceRole {
    UpstreamSupport,
    ByteIdentity,
    PreservationCrosswalk,
    PortcoveQualification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceIdentityProfile {
    pub id: String,
    pub label: String,
    pub kind: SourceIdentityKind,
    pub variants: Vec<SourceVariant>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub tombstones: Vec<String>,
    pub evidence_gap: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SourceIdentityKind {
    File,
    FileSet,
    OpticalDisc,
    MultiDiscSet,
    Compound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceVariant {
    pub id: String,
    pub title: String,
    pub region: Option<String>,
    pub revision: Option<String>,
    /// Transitional schema-1 projection input. The schema-2 inspector must not
    /// classify or admit this record, and contracts may not reference it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub legacy_projection_only: bool,
    #[serde(default)]
    pub product_codes: Vec<String>,
    pub representations: Vec<SourceRepresentation>,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SourceRepresentation {
    pub id: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(flatten)]
    pub kind: SourceRepresentationKind,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SourceRepresentationKind {
    RawFile {
        identities: Vec<DigestIdentity>,
    },
    CanonicalN64 {
        identities: Vec<DigestIdentity>,
    },
    ArchiveMember {
        member_extensions: Vec<String>,
        identities: Vec<DigestIdentity>,
    },
    FileSet {
        members: Vec<SourceMemberIdentity>,
    },
    GamecubeNormalizedIso {
        identities: Vec<DigestIdentity>,
    },
    OpticalTrackSet {
        track_counts: Vec<u32>,
        identities: Vec<DigestIdentity>,
    },
    MultiDiscSet {
        discs: Vec<SourceDiscIdentity>,
    },
    VolumeId {
        values: Vec<String>,
        track_counts: Vec<u32>,
    },
    PinnedValidator {
        validator_contract_id: String,
    },
    Compound {
        format: CompoundSourceFormat,
        identities: Vec<DigestIdentity>,
    },
    InformationalExtension {
        evidence_gap: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CompoundSourceFormat {
    StfsLive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceMemberIdentity {
    pub id: String,
    pub label: String,
    pub filenames: Vec<String>,
    pub identities: Vec<DigestIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceDiscIdentity {
    pub id: String,
    pub label: String,
    pub track_counts: Vec<u32>,
    #[serde(default)]
    pub volume_ids: Vec<String>,
    #[serde(default)]
    pub identities: Vec<DigestIdentity>,
}

/// Digests inside one record are conjunctive and describe one exact byte scope.
/// Separate records and representations are alternatives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DigestIdentity {
    pub scope: DigestScope,
    pub sha1: Option<String>,
    pub sha256: Option<String>,
    pub crc32: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DigestScope {
    OriginalFile,
    OriginalContainer,
    NormalizedContent,
    CanonicalN64BigEndian,
    ArchiveMember,
    GamecubeNormalizedIso,
    PsxNormalizedTrackSet,
    FileSetMember,
    DiscSetMember,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PortSourceContract {
    pub id: String,
    pub port_id: String,
    pub role: PortSourceRole,
    pub profile_id: String,
    pub admission_mode: CatalogAdmissionMode,
    #[serde(default)]
    pub supported_variant_ids: Vec<String>,
    pub validator_contract_id: Option<String>,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    pub authority_ref: String,
    pub reviewed_at: String,
    pub immutable_review_url: String,
    pub live_review_url: Option<String>,
    pub evidence_gap: Option<String>,
    #[serde(default)]
    pub applicability: Vec<SourceContractApplicability>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub tombstones: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PortSourceRole {
    Game,
    Bios,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CatalogAdmissionMode {
    Enforced,
    Informational,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceContractApplicability {
    pub upstream_ref: String,
    pub artifact_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceValidatorContract {
    pub id: String,
    pub tool_id: String,
    pub protocol_version: String,
    pub evidence_ids: Vec<String>,
}

impl SourceCatalog {
    /// Resolve an immutable reviewed link by stable evidence ID and revalidate it
    /// at the moment of use. Adapters must never substitute a renderer URL.
    pub fn reviewed_evidence_url(&self, evidence_id: &str) -> Result<&str> {
        let evidence = self
            .evidence
            .iter()
            .find(|evidence| evidence.id == evidence_id)
            .ok_or_else(|| {
                PortcoveError::not_found(format!("unknown source evidence id: {evidence_id}"))
            })?;
        validate_evidence_url(&evidence.immutable_url, true)?;
        Ok(&evidence.immutable_url)
    }

    pub fn validate<I, S>(&self, port_ids: I) -> Result<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let port_ids = port_ids
            .into_iter()
            .map(|id| id.as_ref().to_owned())
            .collect::<HashSet<_>>();
        let evidence = unique_ids("evidence", self.evidence.iter().map(|item| &item.id))?;
        unique_ids(
            "source profile",
            self.identities.iter().map(|item| &item.id),
        )?;
        let validators = unique_ids("validator", self.validators.iter().map(|item| &item.id))?;
        unique_ids(
            "source contract",
            self.contracts.iter().map(|item| &item.id),
        )?;
        validate_global_names(
            "source profile",
            self.identities.iter().map(|profile| {
                (
                    profile.id.as_str(),
                    profile.aliases.as_slice(),
                    profile.tombstones.as_slice(),
                )
            }),
        )?;
        validate_global_names(
            "source contract",
            self.contracts.iter().map(|contract| {
                (
                    contract.id.as_str(),
                    contract.aliases.as_slice(),
                    contract.tombstones.as_slice(),
                )
            }),
        )?;

        for item in &self.evidence {
            require_text(&item.authority, "evidence authority")?;
            require_text(&item.authority_ref, "evidence authority ref")?;
            require_date(&item.reviewed_at)?;
            require_text(&item.claim, "evidence claim")?;
            validate_evidence_url(&item.immutable_url, true)?;
            if is_git_hosted(&item.immutable_url)?
                && (!is_hex(&item.authority_ref, 40)
                    || !url_has_path_segment(&item.immutable_url, &item.authority_ref)?)
            {
                return Err(PortcoveError::usage(format!(
                    "{} Git evidence is not bound to its full commit authority ref",
                    item.id
                )));
            }
            if let Some(url) = &item.live_url {
                validate_evidence_url(url, false)?;
            }
        }
        for validator in &self.validators {
            require_text(&validator.tool_id, "validator tool id")?;
            require_text(&validator.protocol_version, "validator protocol version")?;
            validate_references("validator evidence", &validator.evidence_ids, &evidence)?;
        }
        let mut qualification_keys = HashSet::new();
        for record in &self.qualification {
            self.validate_qualification(record, &port_ids, &evidence)?;
            let key = serde_json::to_string(&(
                &record.scope,
                record.kind,
                record.observed_at,
                &record.method,
            ))?;
            if !qualification_keys.insert(key) {
                return Err(PortcoveError::conflict(
                    "duplicate exact source qualification record",
                ));
            }
        }
        for profile in &self.identities {
            profile.validate(&evidence, &validators)?;
        }
        let mut port_roles = HashSet::new();
        for contract in &self.contracts {
            if !port_ids.contains(&contract.port_id) {
                return Err(PortcoveError::usage(format!(
                    "{} references unknown port {}",
                    contract.id, contract.port_id
                )));
            }
            let profile = self
                .identities
                .iter()
                .find(|profile| profile.id == contract.profile_id)
                .ok_or_else(|| {
                    PortcoveError::usage(format!(
                        "{} references unknown source profile {}",
                        contract.id, contract.profile_id
                    ))
                })?;
            require_text(&contract.authority_ref, "source contract authority ref")?;
            require_date(&contract.reviewed_at)?;
            validate_evidence_url(&contract.immutable_review_url, true)?;
            if let Some(url) = &contract.live_review_url {
                validate_evidence_url(url, false)?;
            }
            if !port_roles.insert((contract.port_id.clone(), contract.role)) {
                return Err(PortcoveError::conflict(format!(
                    "{} has more than one {:?} source contract",
                    contract.port_id, contract.role
                )));
            }
            validate_references("contract evidence", &contract.evidence_ids, &evidence)?;
            validate_aliases(
                contract.id.as_str(),
                &contract.aliases,
                &contract.tombstones,
            )?;
            if let Some(validator_id) = &contract.validator_contract_id {
                if !validators.contains_key(validator_id) {
                    return Err(PortcoveError::usage(format!(
                        "{} references unknown validator {}",
                        contract.id, validator_id
                    )));
                }
            }
            let variants = profile
                .variants
                .iter()
                .map(|variant| variant.id.as_str())
                .collect::<HashSet<_>>();
            for variant in &contract.supported_variant_ids {
                if !variants.contains(variant.as_str()) {
                    return Err(PortcoveError::usage(format!(
                        "{} references unknown variant {}",
                        contract.id, variant
                    )));
                }
                if profile
                    .variants
                    .iter()
                    .any(|candidate| candidate.id == *variant && candidate.legacy_projection_only)
                {
                    return Err(PortcoveError::usage(format!(
                        "{} references legacy projection-only variant {}",
                        contract.id, variant
                    )));
                }
            }
            match contract.admission_mode {
                CatalogAdmissionMode::Enforced
                    if contract.supported_variant_ids.is_empty()
                        && contract.validator_contract_id.is_none() =>
                {
                    return Err(PortcoveError::usage(format!(
                        "{} has no deterministic variant or validator",
                        contract.id
                    )));
                }
                CatalogAdmissionMode::Informational
                    if contract.evidence_gap.as_deref().is_none_or(str::is_empty) =>
                {
                    return Err(PortcoveError::usage(format!(
                        "{} informational admission has no evidence gap",
                        contract.id
                    )));
                }
                _ => {}
            }
            let mut applicability_keys = HashSet::new();
            for applicability in &contract.applicability {
                require_text(&applicability.upstream_ref, "contract applicability ref")?;
                if let Some(hash) = &applicability.artifact_sha256 {
                    require_digest(hash, 64, "artifact SHA-256")?;
                }
                if !applicability_keys.insert((
                    applicability.upstream_ref.as_str(),
                    applicability.artifact_sha256.as_deref(),
                )) {
                    return Err(PortcoveError::conflict(format!(
                        "{} has duplicate release applicability",
                        contract.id
                    )));
                }
            }
        }
        Ok(())
    }

    /// Aggregate only records with exactly the requested scope. Historical or
    /// legacy records remain visible but cannot qualify a different target.
    pub fn assess_qualification(
        &self,
        scope: &SourceEvidenceScope,
    ) -> SourceQualificationAssessment {
        SourceQualificationAssessment {
            structural_check: evidence_state(self.qualification.iter().filter(|record| {
                record.kind == SourceEvidenceKind::StructuralCheck && record.applies_to(scope)
            })),
            automated_lifecycle: evidence_state(self.qualification.iter().filter(|record| {
                record.kind == SourceEvidenceKind::AutomatedLifecycle && record.applies_to(scope)
            })),
            hands_on: evidence_state(self.qualification.iter().filter(|record| {
                record.kind == SourceEvidenceKind::HandsOn && record.applies_to(scope)
            })),
            known_failure: evidence_state(self.qualification.iter().filter(|record| {
                record.kind == SourceEvidenceKind::KnownFailure && record.applies_to(scope)
            })),
        }
    }

    /// An all-source claim is true only when every currently supported variant
    /// and representation has a passed record for the same exact artifact and
    /// check contract. Adding either dimension therefore invalidates the claim
    /// until its own evidence exists.
    pub fn all_supported_sources_qualified(
        &self,
        contract_id: &str,
        platform: crate::Platform,
        upstream_ref: &str,
        artifact_sha256: &str,
        check_version: &str,
        kind: SourceEvidenceKind,
    ) -> Result<bool> {
        let contract = self
            .contracts
            .iter()
            .find(|contract| contract.id == contract_id)
            .ok_or_else(|| {
                PortcoveError::not_found(format!("unknown source contract: {contract_id}"))
            })?;
        let profile = self
            .identities
            .iter()
            .find(|profile| profile.id == contract.profile_id)
            .ok_or_else(|| {
                PortcoveError::not_found(format!("unknown source profile: {}", contract.profile_id))
            })?;
        let mut targets = 0usize;
        for variant in profile.variants.iter().filter(|variant| {
            !variant.legacy_projection_only && contract.supported_variant_ids.contains(&variant.id)
        }) {
            for representation in &variant.representations {
                targets += 1;
                let scope = SourceEvidenceScope {
                    port_id: contract.port_id.clone(),
                    platform,
                    artifact_sha256: Some(artifact_sha256.into()),
                    upstream_ref: Some(upstream_ref.into()),
                    contract_id: Some(contract.id.clone()),
                    variant: SourceVariantScope::Exact {
                        identity: crate::SourceIdentity {
                            game_id: profile.id.clone(),
                            variant_id: variant.id.clone(),
                            representation_id: representation.id.clone(),
                        },
                    },
                    check_version: Some(check_version.into()),
                };
                let passed = evidence_state(
                    self.qualification
                        .iter()
                        .filter(|record| record.kind == kind && record.applies_to(&scope)),
                ) == QualificationEvidenceState::Passed;
                if !passed {
                    return Ok(false);
                }
            }
        }
        Ok(targets > 0)
    }

    fn validate_qualification(
        &self,
        record: &SourceEvidence,
        port_ids: &HashSet<String>,
        evidence: &HashMap<String, ()>,
    ) -> Result<()> {
        let scope = &record.scope;
        if !port_ids.contains(&scope.port_id) || !record.applies_to(scope) {
            return Err(PortcoveError::usage(
                "source qualification must have a complete exact scope",
            ));
        }
        if record.observed_at <= 0 || record.method.trim().is_empty() {
            return Err(PortcoveError::usage(
                "source qualification must record a method and observation time",
            ));
        }
        if record.evidence_ids.is_empty() {
            return Err(PortcoveError::usage(
                "source qualification must reference reviewed qualification evidence",
            ));
        }
        validate_references("qualification evidence", &record.evidence_ids, evidence)?;
        if !record.evidence_ids.iter().any(|id| {
            self.evidence.iter().any(|item| {
                item.id == *id && item.role == CatalogEvidenceRole::PortcoveQualification
            })
        }) {
            return Err(PortcoveError::usage(
                "source qualification must reference Portcove qualification evidence",
            ));
        }
        let contract_id = scope
            .contract_id
            .as_deref()
            .expect("applies_to checked contract id");
        let contract = self
            .contracts
            .iter()
            .find(|contract| contract.id == contract_id && contract.port_id == scope.port_id)
            .ok_or_else(|| {
                PortcoveError::usage("source qualification references an unknown contract")
            })?;
        let SourceVariantScope::Exact { identity } = &scope.variant else {
            unreachable!("applies_to checked exact identity")
        };
        if identity.game_id != contract.profile_id
            || !contract
                .supported_variant_ids
                .contains(&identity.variant_id)
        {
            return Err(PortcoveError::usage(
                "source qualification references an unsupported variant",
            ));
        }
        let representation_exists = self.identities.iter().any(|profile| {
            profile.id == identity.game_id
                && profile.variants.iter().any(|variant| {
                    variant.id == identity.variant_id
                        && !variant.legacy_projection_only
                        && variant
                            .representations
                            .iter()
                            .any(|representation| representation.id == identity.representation_id)
                })
        });
        if !representation_exists {
            return Err(PortcoveError::usage(
                "source qualification references an unknown representation",
            ));
        }
        let binding_exists = contract.applicability.iter().any(|binding| {
            scope.upstream_ref.as_deref() == Some(binding.upstream_ref.as_str())
                && scope.artifact_sha256.as_deref() == binding.artifact_sha256.as_deref()
        });
        if !binding_exists {
            return Err(PortcoveError::usage(
                "source qualification is not bound to a reviewed artifact applicability",
            ));
        }
        if record.kind == SourceEvidenceKind::KnownFailure
            && record.outcome != SourceEvidenceOutcome::Failed
        {
            return Err(PortcoveError::usage(
                "known-failure evidence must have a failed outcome",
            ));
        }
        Ok(())
    }

    /// Builds the single temporary schema-1 view consumed by the existing matcher.
    /// Schema-2 remains authoritative; a supplied compatibility view is accepted only
    /// when it is semantically equal after typed serialization.
    pub fn compatibility_profiles(&self) -> Result<Vec<SourceProfile>> {
        self.identities
            .iter()
            .map(SourceIdentityProfile::compatibility_profile)
            .collect()
    }
}

fn evidence_state<'a>(
    records: impl Iterator<Item = &'a SourceEvidence>,
) -> QualificationEvidenceState {
    records
        .max_by_key(|record| (record.observed_at, outcome_rank(record.outcome)))
        .map_or(QualificationEvidenceState::Missing, |record| {
            match record.outcome {
                SourceEvidenceOutcome::Unknown => QualificationEvidenceState::Unknown,
                SourceEvidenceOutcome::NotRun => QualificationEvidenceState::NotRun,
                SourceEvidenceOutcome::Passed => QualificationEvidenceState::Passed,
                SourceEvidenceOutcome::Failed => QualificationEvidenceState::Failed,
            }
        })
}

fn outcome_rank(outcome: SourceEvidenceOutcome) -> u8 {
    match outcome {
        SourceEvidenceOutcome::Unknown => 0,
        SourceEvidenceOutcome::NotRun => 1,
        SourceEvidenceOutcome::Passed => 2,
        SourceEvidenceOutcome::Failed => 3,
    }
}

impl SourceIdentityProfile {
    fn validate(
        &self,
        evidence: &HashMap<String, ()>,
        validators: &HashMap<String, ()>,
    ) -> Result<()> {
        require_text(&self.label, "source profile label")?;
        validate_aliases(self.id.as_str(), &self.aliases, &self.tombstones)?;
        if self.variants.is_empty() && self.evidence_gap.as_deref().is_none_or(str::is_empty) {
            return Err(PortcoveError::usage(format!(
                "{} has neither source variants nor an evidence gap",
                self.id
            )));
        }
        unique_ids(
            "source variant",
            self.variants.iter().map(|variant| &variant.id),
        )?;

        let mut deterministic_owners = HashMap::new();
        for variant in &self.variants {
            require_text(&variant.title, "source variant title")?;
            validate_text_values("source product code", &variant.product_codes)?;
            validate_references("variant evidence", &variant.evidence_ids, evidence)?;
            if variant.representations.is_empty() {
                return Err(PortcoveError::usage(format!(
                    "{} variant {} has no representations",
                    self.id, variant.id
                )));
            }
            unique_ids(
                "source representation",
                variant.representations.iter().map(|item| &item.id),
            )?;
            for representation in &variant.representations {
                validate_references(
                    "representation evidence",
                    &representation.evidence_ids,
                    evidence,
                )?;
                representation.validate(validators)?;
                if !variant.legacy_projection_only {
                    for key in representation.deterministic_match_keys()? {
                        if let Some(previous) =
                            deterministic_owners.insert(key, variant.id.as_str())
                            && previous != variant.id
                        {
                            return Err(PortcoveError::conflict(format!(
                                "{} variants {} and {} have an ambiguous deterministic identity",
                                self.id, previous, variant.id
                            )));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn compatibility_profile(&self) -> Result<SourceProfile> {
        let mut legacy = SourceProfile {
            id: self.id.clone(),
            label: self.label.clone(),
            accepted_extensions: Vec::new(),
            accepted_sha1: Vec::new(),
            accepted_sha256: Vec::new(),
            kind: SourceKind::File,
            disc: None,
            members: Vec::new(),
        };
        let mut represented_kind = None;
        let has_legacy_projection = self
            .variants
            .iter()
            .any(|variant| variant.legacy_projection_only);
        for variant in self
            .variants
            .iter()
            .filter(|variant| !has_legacy_projection || variant.legacy_projection_only)
        {
            for representation in &variant.representations {
                append_unique(&mut legacy.accepted_extensions, &representation.extensions);
                let kind = match &representation.kind {
                    SourceRepresentationKind::RawFile { identities }
                    | SourceRepresentationKind::CanonicalN64 { identities }
                    | SourceRepresentationKind::ArchiveMember { identities, .. }
                    | SourceRepresentationKind::Compound { identities, .. } => {
                        append_digests(&mut legacy, identities);
                        SourceKind::File
                    }
                    SourceRepresentationKind::GamecubeNormalizedIso { identities } => {
                        append_digests(&mut legacy, identities);
                        SourceKind::GamecubeDisc
                    }
                    SourceRepresentationKind::OpticalTrackSet {
                        track_counts,
                        identities,
                    } => {
                        append_digests(&mut legacy, identities);
                        legacy.disc.get_or_insert_with(|| DiscSourceProfile {
                            track_counts: Vec::new(),
                            discs: Vec::new(),
                        });
                        append_unique(
                            &mut legacy.disc.as_mut().expect("inserted").track_counts,
                            track_counts,
                        );
                        SourceKind::PsxDisc
                    }
                    SourceRepresentationKind::MultiDiscSet { discs } => {
                        let legacy_disc = legacy.disc.get_or_insert_with(|| DiscSourceProfile {
                            track_counts: Vec::new(),
                            discs: Vec::new(),
                        });
                        for disc in discs {
                            let mut accepted_sha1 = Vec::new();
                            let mut accepted_sha256 = Vec::new();
                            append_identity_digests(
                                &mut accepted_sha1,
                                &mut accepted_sha256,
                                &disc.identities,
                            );
                            legacy_disc.discs.push(DiscIdentityProfile {
                                label: disc.label.clone(),
                                accepted_sha1,
                                accepted_sha256,
                                accepted_volume_ids: disc.volume_ids.clone(),
                                track_counts: disc.track_counts.clone(),
                            });
                        }
                        SourceKind::PsxDisc
                    }
                    SourceRepresentationKind::VolumeId {
                        values,
                        track_counts,
                    } => {
                        legacy.disc = Some(DiscSourceProfile {
                            track_counts: track_counts.clone(),
                            discs: vec![DiscIdentityProfile {
                                label: variant.title.clone(),
                                accepted_sha1: Vec::new(),
                                accepted_sha256: Vec::new(),
                                accepted_volume_ids: values.clone(),
                                track_counts: track_counts.clone(),
                            }],
                        });
                        SourceKind::PsxDisc
                    }
                    SourceRepresentationKind::FileSet { members } => {
                        for member in members {
                            let mut accepted_sha1 = Vec::new();
                            let mut accepted_sha256 = Vec::new();
                            append_identity_digests(
                                &mut accepted_sha1,
                                &mut accepted_sha256,
                                &member.identities,
                            );
                            let accepted_crc32 = member
                                .identities
                                .iter()
                                .filter_map(|identity| identity.crc32.clone())
                                .collect();
                            legacy.members.push(SourceMemberProfile {
                                id: member.id.clone(),
                                label: member.label.clone(),
                                accepted_filenames: member.filenames.clone(),
                                accepted_sha1,
                                accepted_sha256,
                                accepted_crc32,
                            });
                        }
                        SourceKind::FileSet
                    }
                    SourceRepresentationKind::PinnedValidator { .. } => {
                        SourceKind::UpstreamValidatedDisc
                    }
                    SourceRepresentationKind::InformationalExtension { .. } => SourceKind::File,
                };
                if let Some(previous) = represented_kind
                    && previous != kind
                {
                    return Err(PortcoveError::conflict(format!(
                        "{} cannot project mixed source kinds",
                        self.id
                    )));
                }
                represented_kind = Some(kind);
            }
        }
        legacy.kind = represented_kind.unwrap_or(SourceKind::File);
        if legacy.kind == SourceKind::PsxDisc {
            let disc = legacy.disc.get_or_insert_with(|| DiscSourceProfile {
                track_counts: vec![1],
                discs: Vec::new(),
            });
            if disc.track_counts.is_empty() {
                disc.track_counts.push(1);
            }
        }
        Ok(legacy)
    }
}

fn append_digests(profile: &mut SourceProfile, identities: &[DigestIdentity]) {
    let mut sha1 = std::mem::take(&mut profile.accepted_sha1);
    let mut sha256 = std::mem::take(&mut profile.accepted_sha256);
    append_identity_digests(&mut sha1, &mut sha256, identities);
    profile.accepted_sha1 = sha1;
    profile.accepted_sha256 = sha256;
}

fn append_identity_digests(
    sha1: &mut Vec<String>,
    sha256: &mut Vec<String>,
    identities: &[DigestIdentity],
) {
    for identity in identities {
        if let Some(value) = &identity.sha1
            && !sha1.contains(value)
        {
            sha1.push(value.clone());
        }
        if let Some(value) = &identity.sha256
            && !sha256.contains(value)
        {
            sha256.push(value.clone());
        }
    }
}

fn append_unique<T: Clone + PartialEq>(target: &mut Vec<T>, values: &[T]) {
    for value in values {
        if !target.contains(value) {
            target.push(value.clone());
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl SourceRepresentation {
    fn deterministic_match_keys(&self) -> Result<Vec<String>> {
        let identities = match &self.kind {
            SourceRepresentationKind::RawFile { identities }
            | SourceRepresentationKind::CanonicalN64 { identities }
            | SourceRepresentationKind::ArchiveMember { identities, .. }
            | SourceRepresentationKind::GamecubeNormalizedIso { identities }
            | SourceRepresentationKind::OpticalTrackSet { identities, .. }
            | SourceRepresentationKind::Compound { identities, .. } => identities,
            SourceRepresentationKind::FileSet { .. }
            | SourceRepresentationKind::MultiDiscSet { .. }
            | SourceRepresentationKind::VolumeId { .. } => {
                return Ok(vec![serde_json::to_string(&self.kind)?]);
            }
            SourceRepresentationKind::PinnedValidator { .. }
            | SourceRepresentationKind::InformationalExtension { .. } => return Ok(Vec::new()),
        };
        let mut keys = Vec::new();
        for identity in identities {
            if let Some(value) = &identity.sha1 {
                keys.push(format!("{:?}:sha1:{value}", identity.scope));
            }
            if let Some(value) = &identity.sha256 {
                keys.push(format!("{:?}:sha256:{value}", identity.scope));
            }
            if let Some(value) = &identity.crc32 {
                keys.push(format!("{:?}:crc32:{value}", identity.scope));
            }
        }
        Ok(keys)
    }

    fn validate(&self, validators: &HashMap<String, ()>) -> Result<()> {
        validate_extensions(&self.extensions)?;
        match &self.kind {
            SourceRepresentationKind::RawFile { identities }
            | SourceRepresentationKind::CanonicalN64 { identities }
            | SourceRepresentationKind::GamecubeNormalizedIso { identities }
            | SourceRepresentationKind::OpticalTrackSet { identities, .. }
            | SourceRepresentationKind::Compound { identities, .. } => {
                validate_identities(identities)?;
            }
            SourceRepresentationKind::ArchiveMember {
                member_extensions,
                identities,
            } => {
                validate_extensions(member_extensions)?;
                validate_identities(identities)?;
            }
            SourceRepresentationKind::FileSet { members } => {
                if members.is_empty() {
                    return Err(PortcoveError::usage(
                        "file-set representation has no members",
                    ));
                }
                unique_ids("source member", members.iter().map(|member| &member.id))?;
                for member in members {
                    if member.filenames.is_empty() {
                        return Err(PortcoveError::usage("source member has no filename"));
                    }
                    require_text(&member.label, "source member label")?;
                    validate_filenames(&member.filenames)?;
                    validate_identities(&member.identities)?;
                }
            }
            SourceRepresentationKind::MultiDiscSet { discs } => {
                if discs.len() < 2 {
                    return Err(PortcoveError::usage(
                        "multi-disc representation needs at least two discs",
                    ));
                }
                unique_ids("source disc", discs.iter().map(|disc| &disc.id))?;
                for disc in discs {
                    if disc.track_counts.is_empty()
                        || disc.track_counts.contains(&0)
                        || (disc.identities.is_empty() && disc.volume_ids.is_empty())
                    {
                        return Err(PortcoveError::usage(
                            "source disc needs track and identity evidence",
                        ));
                    }
                    require_text(&disc.label, "source disc label")?;
                    validate_volume_ids(&disc.volume_ids)?;
                    validate_identities_if_present(&disc.identities)?;
                }
            }
            SourceRepresentationKind::VolumeId {
                values,
                track_counts,
            } => {
                if values.is_empty() || track_counts.is_empty() || track_counts.contains(&0) {
                    return Err(PortcoveError::usage(
                        "volume-id representation needs values and track counts",
                    ));
                }
                validate_volume_ids(values)?;
            }
            SourceRepresentationKind::PinnedValidator {
                validator_contract_id,
            } => {
                if !validators.contains_key(validator_contract_id) {
                    return Err(PortcoveError::usage(format!(
                        "representation references unknown validator {validator_contract_id}"
                    )));
                }
            }
            SourceRepresentationKind::InformationalExtension { evidence_gap } => {
                require_text(evidence_gap, "informational representation evidence gap")?;
            }
        }
        Ok(())
    }
}

fn validate_identities(identities: &[DigestIdentity]) -> Result<()> {
    if identities.is_empty() {
        return Err(PortcoveError::usage(
            "exact source representation has no digest identities",
        ));
    }
    validate_identities_if_present(identities)
}

fn validate_identities_if_present(identities: &[DigestIdentity]) -> Result<()> {
    let mut seen = HashSet::new();
    for identity in identities {
        if identity.sha1.is_none() && identity.sha256.is_none() && identity.crc32.is_none() {
            return Err(PortcoveError::usage("digest identity is empty"));
        }
        if let Some(value) = &identity.sha1 {
            require_digest(value, 40, "SHA-1")?;
        }
        if let Some(value) = &identity.sha256 {
            require_digest(value, 64, "SHA-256")?;
        }
        if let Some(value) = &identity.crc32 {
            require_digest(value, 8, "CRC32")?;
        }
        let serialized = serde_json::to_string(identity)?;
        if !seen.insert(serialized) {
            return Err(PortcoveError::conflict("duplicate digest identity"));
        }
    }
    Ok(())
}

fn unique_ids<'a>(
    namespace: &str,
    ids: impl IntoIterator<Item = &'a String>,
) -> Result<HashMap<String, ()>> {
    let mut unique = HashMap::new();
    for id in ids {
        require_id(id, namespace)?;
        if unique.insert(id.clone(), ()).is_some() {
            return Err(PortcoveError::conflict(format!(
                "duplicate {namespace} id: {id}"
            )));
        }
    }
    Ok(unique)
}

fn validate_aliases(canonical: &str, aliases: &[String], tombstones: &[String]) -> Result<()> {
    let aliases = unique_ids("alias", aliases)?;
    let tombstones = unique_ids("tombstone", tombstones)?;
    if aliases.contains_key(canonical)
        || tombstones.contains_key(canonical)
        || aliases.keys().any(|alias| tombstones.contains_key(alias))
    {
        return Err(PortcoveError::conflict(
            "canonical IDs, aliases, and tombstones must be disjoint",
        ));
    }
    Ok(())
}

fn validate_global_names<'a>(
    namespace: &str,
    items: impl IntoIterator<Item = (&'a str, &'a [String], &'a [String])>,
) -> Result<()> {
    let mut names = HashMap::new();
    for (canonical, aliases, tombstones) in items {
        for (name, role) in std::iter::once((canonical, "canonical"))
            .chain(aliases.iter().map(|value| (value.as_str(), "alias")))
            .chain(tombstones.iter().map(|value| (value.as_str(), "tombstone")))
        {
            if let Some(previous) = names.insert(name, role) {
                return Err(PortcoveError::conflict(format!(
                    "{namespace} id {name} is both {previous} and {role}"
                )));
            }
        }
    }
    Ok(())
}

fn validate_references(label: &str, ids: &[String], available: &HashMap<String, ()>) -> Result<()> {
    let references = unique_ids(label, ids)?;
    if let Some(missing) = references.keys().find(|id| !available.contains_key(*id)) {
        return Err(PortcoveError::usage(format!(
            "{label} references unknown id {missing}"
        )));
    }
    Ok(())
}

fn require_id(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || value.starts_with('-')
        || value.ends_with('-')
        || value.contains("--")
    {
        return Err(PortcoveError::usage(format!("invalid {label} id: {value}")));
    }
    Ok(())
}

fn require_text(value: &str, label: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(PortcoveError::usage(format!("{label} is empty")));
    }
    Ok(())
}

fn require_date(value: &str) -> Result<()> {
    let valid = value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
        && value[5..7]
            .parse::<u8>()
            .is_ok_and(|month| (1..=12).contains(&month))
        && value[8..10]
            .parse::<u8>()
            .is_ok_and(|day| (1..=31).contains(&day));
    if !valid {
        return Err(PortcoveError::usage(format!(
            "invalid reviewed date: {value}"
        )));
    }
    Ok(())
}

fn require_digest(value: &str, length: usize, label: &str) -> Result<()> {
    if !is_hex(value, length) {
        return Err(PortcoveError::usage(format!("invalid {label}")));
    }
    Ok(())
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_text_values(label: &str, values: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    for value in values {
        require_text(value, label)?;
        if !seen.insert(value) {
            return Err(PortcoveError::conflict(format!(
                "duplicate {label}: {value}"
            )));
        }
    }
    Ok(())
}

fn validate_filenames(values: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    for value in values {
        if value.is_empty()
            || value == "."
            || value == ".."
            || value.contains('/')
            || value.contains('\\')
            || value.chars().any(char::is_control)
            || !seen.insert(value.to_ascii_lowercase())
        {
            return Err(PortcoveError::usage(format!(
                "invalid or duplicate source member filename: {value}"
            )));
        }
    }
    Ok(())
}

fn validate_volume_ids(values: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    for value in values {
        if value.is_empty()
            || value.len() > 32
            || !value.bytes().all(|byte| {
                byte.is_ascii_uppercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'_' | b'-' | b'.' | b' ')
            })
            || !seen.insert(value)
        {
            return Err(PortcoveError::usage(format!(
                "invalid or duplicate source volume id: {value}"
            )));
        }
    }
    Ok(())
}

fn validate_extensions(extensions: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    for extension in extensions {
        if extension.is_empty()
            || !extension
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            || !seen.insert(extension)
        {
            return Err(PortcoveError::usage(format!(
                "invalid or duplicate source extension: {extension}"
            )));
        }
    }
    Ok(())
}

fn validate_evidence_url(value: &str, immutable: bool) -> Result<()> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| PortcoveError::usage("invalid catalog evidence URL"))?;
    let host = url
        .host_str()
        .ok_or_else(|| PortcoveError::usage("catalog evidence URL has no host"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || matches!(host, "localhost" | "localhost.localdomain")
        || host.ends_with(".local")
        || host.parse::<std::net::IpAddr>().is_ok_and(|address| {
            address.is_loopback()
                || address.is_unspecified()
                || match address {
                    std::net::IpAddr::V4(address) => {
                        address.is_private() || address.is_link_local()
                    }
                    std::net::IpAddr::V6(address) => address.is_unique_local(),
                }
        })
        || (immutable
            && is_git_host(host)
            && !url
                .path_segments()
                .is_some_and(|segments| segments.into_iter().any(|segment| is_hex(segment, 40))))
    {
        return Err(PortcoveError::usage("unsafe catalog evidence URL"));
    }
    Ok(())
}

fn is_git_host(host: &str) -> bool {
    matches!(host, "github.com" | "gitlab.com")
}

fn is_git_hosted(value: &str) -> Result<bool> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| PortcoveError::usage("invalid catalog evidence URL"))?;
    Ok(url.host_str().is_some_and(is_git_host))
}

fn url_has_path_segment(value: &str, expected: &str) -> Result<bool> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| PortcoveError::usage("invalid catalog evidence URL"))?;
    Ok(url
        .path_segments()
        .is_some_and(|segments| segments.into_iter().any(|segment| segment == expected)))
}

#[cfg(test)]
#[path = "source_catalog_tests.rs"]
mod tests;
