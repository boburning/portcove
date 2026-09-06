//! Read-only source inspection and schema-2 identity matching.

use std::path::{Path, PathBuf};
use std::{collections::HashSet, fs::File, io::Read};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::{
    Catalog, CompoundSourceFormat, DigestIdentity, DigestScope, Library, PortcoveError, Result,
    SourceAdmission, SourceAdmissionMode, SourceAssessment, SourceClassification,
    SourceContractResult, SourceIdentity, SourceKind, SourceRecord, SourceRejectionReason,
    SourceRepresentation, SourceRepresentationKind,
    adapter::{
        ObservedDiscSource, ObservedOpticalDisc, aggregate_sha256, observe_gamecube_disc_source,
        observe_psx_disc_source,
    },
    source_file::{FileIdentity, HashBudget, read_identity},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceDigestAlgorithm {
    Sha1,
    Sha256,
    Crc32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ObservedSourceDigest {
    pub algorithm: SourceDigestAlgorithm,
    pub scope: DigestScope,
    pub value: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceComponentKind {
    FileSetMember,
    OpticalDisc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ObservedSourceComponent {
    pub id: String,
    pub kind: SourceComponentKind,
    pub name: Option<String>,
    pub digests: Vec<ObservedSourceDigest>,
    pub size: u64,
    pub track_count: Option<u32>,
    pub volume_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceValidatorResult {
    NotRun,
    Passed,
    Failed,
    MissingTool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ObservedSourceValidator {
    pub contract_id: String,
    pub tool_id: String,
    pub protocol_version: String,
    pub result: SourceValidatorResult,
}

/// Facts returned by read-only inspection. A record is present only when the
/// admission state permits existing callers to register or use the source.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceInspection {
    pub profile_id: String,
    pub path: PathBuf,
    pub observed_digests: Vec<ObservedSourceDigest>,
    #[serde(default)]
    pub components: Vec<ObservedSourceComponent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validator: Option<ObservedSourceValidator>,
    pub assessment: SourceAssessment,
    pub record: Option<SourceRecord>,
    pub message: String,
}

impl SourceInspection {
    pub fn require_admitted_record(self) -> Result<SourceRecord> {
        if matches!(self.assessment.admission, SourceAdmission::Admitted { .. }) {
            return self.record.ok_or_else(|| {
                PortcoveError::state("admitted source inspection did not produce a source record")
            });
        }
        let reason = match self.assessment.admission {
            SourceAdmission::Rejected { reason } => rejection_code(reason),
            SourceAdmission::NotEvaluated => "not_evaluated",
            SourceAdmission::Admitted { .. } => unreachable!(),
        };
        Err(PortcoveError::source(self.message)
            .detail("profile_id", self.profile_id)
            .detail("admission_reason", reason))
    }
}

fn rejection_code(reason: SourceRejectionReason) -> &'static str {
    match reason {
        SourceRejectionReason::Missing => "missing",
        SourceRejectionReason::Unreadable => "unreadable",
        SourceRejectionReason::Changed => "changed",
        SourceRejectionReason::KnownMismatch => "known_mismatch",
        SourceRejectionReason::AmbiguousIdentity => "ambiguous_identity",
        SourceRejectionReason::MissingTool => "missing_tool",
        SourceRejectionReason::CheckFailed => "check_failed",
        SourceRejectionReason::ConsentRequired => "consent_required",
    }
}

pub(crate) fn inspect_file(
    catalog: &Catalog,
    profile_id: &str,
    path: &Path,
    maximum_size: u64,
    budget: &mut HashBudget,
) -> Result<SourceInspection> {
    let legacy = catalog.source_profile(profile_id)?;
    let identity = read_identity(path, &legacy.accepted_extensions, maximum_size, budget)?;
    let observed = observed_digests(&identity);
    let compound_format = matching_compound_format(catalog, profile_id, &identity, &observed);
    if let Some(CompoundSourceFormat::StfsLive) = compound_format {
        crate::stfs::validate(path, &|| {
            if let Some(operation) = &budget.operation {
                operation.checkpoint()?;
            }
            Ok(())
        })?;
    }
    inspect_file_identity_with_compound(catalog, profile_id, path, &identity, compound_format)
}

pub(crate) fn inspect_pinned_validator(
    catalog: &Catalog,
    profile_id: &str,
    path: &Path,
    maximum_size: u64,
    budget: &mut HashBudget,
) -> Result<SourceInspection> {
    let legacy = catalog.source_profile(profile_id)?;
    let identity = read_identity(path, &legacy.accepted_extensions, maximum_size, budget)?;
    let observed_digests = observed_digests(&identity);
    let record = identity.record_without_admission(profile_id, path);

    let Some(source_catalog) = catalog.source_catalog() else {
        return Ok(SourceInspection {
            profile_id: profile_id.into(),
            path: path.into(),
            observed_digests,
            components: Vec::new(),
            validator: None,
            assessment: SourceAssessment {
                health: crate::SourceHealth::NotBaselined,
                classification: SourceClassification::NotEvaluated,
                contract: SourceContractResult::NotEvaluated,
                admission: SourceAdmission::Admitted {
                    mode: SourceAdmissionMode::StructuralChecks,
                },
                evidence: Vec::new(),
            },
            record: Some(record),
            message: "source passed the schema-1 upstream-validator selection contract".into(),
        });
    };
    let profile = source_catalog
        .identities
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| {
            PortcoveError::state(format!("schema-2 source profile {profile_id} is missing"))
        })?;
    let mut candidates = Vec::new();
    for variant in profile
        .variants
        .iter()
        .filter(|variant| !variant.legacy_projection_only)
    {
        for representation in &variant.representations {
            let SourceRepresentationKind::PinnedValidator {
                validator_contract_id,
            } = &representation.kind
            else {
                continue;
            };
            if !representation_extensions_match(representation, &identity) {
                continue;
            }
            let validator = source_catalog
                .validators
                .iter()
                .find(|validator| validator.id == *validator_contract_id)
                .ok_or_else(|| {
                    PortcoveError::state(format!(
                        "schema-2 source validator {validator_contract_id} is missing"
                    ))
                })?;
            candidates.push((
                SourceIdentity {
                    game_id: profile.id.clone(),
                    variant_id: variant.id.clone(),
                    representation_id: representation.id.clone(),
                },
                ObservedSourceValidator {
                    contract_id: validator.id.clone(),
                    tool_id: validator.tool_id.clone(),
                    protocol_version: validator.protocol_version.clone(),
                    result: SourceValidatorResult::NotRun,
                },
            ));
        }
    }

    let (classification, admission, admitted_record, validator, message) =
        match candidates.as_slice() {
            [(_, validator)] => (
                SourceClassification::NotEvaluated,
                SourceAdmission::Admitted {
                    mode: SourceAdmissionMode::StructuralChecks,
                },
                Some(record),
                Some(validator.clone()),
                format!(
                    "source passed preliminary selection; pinned validator {} has not run",
                    validator.contract_id
                ),
            ),
            [] => (
                SourceClassification::Unrecognized,
                SourceAdmission::Rejected {
                    reason: SourceRejectionReason::KnownMismatch,
                },
                None,
                None,
                format!("source is not eligible for {} validation", legacy.label),
            ),
            many => (
                SourceClassification::Ambiguous {
                    candidates: many.iter().map(|(identity, _)| identity.clone()).collect(),
                },
                SourceAdmission::Rejected {
                    reason: SourceRejectionReason::AmbiguousIdentity,
                },
                None,
                None,
                "source is eligible for more than one pinned validator".into(),
            ),
        };
    Ok(SourceInspection {
        profile_id: profile_id.into(),
        path: path.into(),
        observed_digests,
        components: Vec::new(),
        validator,
        assessment: SourceAssessment {
            health: crate::SourceHealth::NotBaselined,
            classification,
            contract: SourceContractResult::NotEvaluated,
            admission,
            evidence: Vec::new(),
        },
        record: admitted_record,
        message,
    })
}

pub(crate) fn inspect_file_set(
    catalog: &Catalog,
    profile_id: &str,
    path: &Path,
) -> Result<SourceInspection> {
    let legacy = catalog.source_profile(profile_id)?;
    let is_zip = path.is_file()
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"));
    if !path.is_dir() && !is_zip {
        return Err(PortcoveError::source(format!(
            "{} expects a directory or ZIP file set: {}",
            legacy.label,
            path.display()
        )));
    }
    let profile = catalog
        .source_catalog()
        .and_then(|source_catalog| {
            source_catalog
                .identities
                .iter()
                .find(|profile| profile.id == profile_id)
        })
        .ok_or_else(|| {
            PortcoveError::state(format!("schema-2 source profile {profile_id} is missing"))
        })?;

    let mut matches = Vec::new();
    let mut observed = Vec::new();
    for variant in profile
        .variants
        .iter()
        .filter(|variant| !variant.legacy_projection_only)
    {
        for representation in &variant.representations {
            let SourceRepresentationKind::FileSet { members } = &representation.kind else {
                continue;
            };
            let Some((components, record, matched)) =
                inspect_file_set_representation(profile_id, path, is_zip, members)?
            else {
                continue;
            };
            if !matched {
                if observed.is_empty() {
                    observed = components;
                }
                continue;
            }
            if matches.is_empty() {
                observed = components.clone();
            }
            matches.push((
                SourceIdentity {
                    game_id: profile.id.clone(),
                    variant_id: variant.id.clone(),
                    representation_id: representation.id.clone(),
                },
                record,
            ));
        }
    }

    let (classification, admission, record, message) = match matches.as_slice() {
        [(identity, record)] => (
            SourceClassification::Recognized {
                identity: identity.clone(),
            },
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity,
            },
            Some(record.clone()),
            "source file set matches one exact schema-2 identity".into(),
        ),
        [] => (
            SourceClassification::Unrecognized,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch,
            },
            None,
            format!("source hash is not a supported {} variant", legacy.label),
        ),
        many => (
            SourceClassification::Ambiguous {
                candidates: many.iter().map(|(identity, _)| identity.clone()).collect(),
            },
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::AmbiguousIdentity,
            },
            None,
            "source file set matches more than one schema-2 identity".into(),
        ),
    };
    let observed_digests = record
        .as_ref()
        .map(file_set_aggregate_digests)
        .unwrap_or_default();
    Ok(SourceInspection {
        profile_id: profile_id.into(),
        path: path.into(),
        observed_digests,
        components: observed,
        validator: None,
        assessment: SourceAssessment {
            health: crate::SourceHealth::NotBaselined,
            classification,
            contract: SourceContractResult::NotEvaluated,
            admission,
            evidence: Vec::new(),
        },
        record,
        message,
    })
}

pub(crate) fn inspect_disc(
    catalog: &Catalog,
    profile_id: &str,
    path: &Path,
) -> Result<SourceInspection> {
    let legacy = catalog.source_profile(profile_id)?;
    let observation = match legacy.kind {
        SourceKind::GamecubeDisc => observe_gamecube_disc_source(legacy, path)?,
        SourceKind::PsxDisc => observe_psx_disc_source(legacy, path)?,
        _ => {
            return Err(PortcoveError::state(format!(
                "{profile_id} is not a specialized disc source"
            )));
        }
    };
    inspect_disc_observation(catalog, profile_id, path, observation)
}

fn inspect_disc_observation(
    catalog: &Catalog,
    profile_id: &str,
    path: &Path,
    observation: ObservedDiscSource,
) -> Result<SourceInspection> {
    let legacy = catalog.source_profile(profile_id)?;
    let profile = catalog
        .source_catalog()
        .and_then(|source_catalog| {
            source_catalog
                .identities
                .iter()
                .find(|profile| profile.id == profile_id)
        })
        .ok_or_else(|| {
            PortcoveError::state(format!("schema-2 source profile {profile_id} is missing"))
        })?;
    let components = if legacy.kind == SourceKind::PsxDisc {
        observed_disc_components(&observation.discs)
    } else {
        Vec::new()
    };
    let observed_digests = observed_disc_aggregate_digests(legacy.kind, &observation);
    let mut matches = Vec::new();
    for variant in profile
        .variants
        .iter()
        .filter(|variant| !variant.legacy_projection_only)
    {
        for representation in &variant.representations {
            if disc_representation_matches(representation, path, &observation.discs) {
                let candidate = SourceIdentity {
                    game_id: profile.id.clone(),
                    variant_id: variant.id.clone(),
                    representation_id: representation.id.clone(),
                };
                if !matches.contains(&candidate) {
                    matches.push(candidate);
                }
            }
        }
    }
    let (classification, admission, record, message) = match matches.as_slice() {
        [identity] => (
            SourceClassification::Recognized {
                identity: identity.clone(),
            },
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity,
            },
            Some(observation.record),
            "source disc matches one exact schema-2 identity".into(),
        ),
        [] => (
            SourceClassification::Unrecognized,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch,
            },
            None,
            format!("source disc is not a supported {} variant", legacy.label),
        ),
        many => (
            SourceClassification::Ambiguous {
                candidates: many.to_vec(),
            },
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::AmbiguousIdentity,
            },
            None,
            "source disc matches more than one schema-2 identity".into(),
        ),
    };
    Ok(SourceInspection {
        profile_id: profile_id.into(),
        path: path.into(),
        observed_digests,
        components,
        validator: None,
        assessment: SourceAssessment {
            health: crate::SourceHealth::NotBaselined,
            classification,
            contract: SourceContractResult::NotEvaluated,
            admission,
            evidence: Vec::new(),
        },
        record,
        message,
    })
}

fn observed_disc_components(discs: &[ObservedOpticalDisc]) -> Vec<ObservedSourceComponent> {
    let scope = if discs.len() == 1 {
        DigestScope::PsxNormalizedTrackSet
    } else {
        DigestScope::DiscSetMember
    };
    discs
        .iter()
        .enumerate()
        .map(|(index, disc)| ObservedSourceComponent {
            id: format!("disc-{}", index + 1),
            kind: SourceComponentKind::OpticalDisc,
            name: disc.name.clone(),
            digests: digest_pair(scope, disc.size, &disc.sha1, &disc.sha256),
            size: disc.size,
            track_count: Some(disc.track_count),
            volume_id: disc.volume_id.clone(),
        })
        .collect()
}

fn observed_disc_aggregate_digests(
    kind: SourceKind,
    observation: &ObservedDiscSource,
) -> Vec<ObservedSourceDigest> {
    let mut values = if kind == SourceKind::GamecubeDisc {
        observation
            .discs
            .first()
            .map(|disc| {
                digest_pair(
                    DigestScope::GamecubeNormalizedIso,
                    disc.size,
                    &disc.sha1,
                    &disc.sha256,
                )
            })
            .unwrap_or_default()
    } else if observation.discs.len() == 1 {
        let disc = &observation.discs[0];
        digest_pair(
            DigestScope::PsxNormalizedTrackSet,
            disc.size,
            &disc.sha1,
            &disc.sha256,
        )
    } else {
        vec![ObservedSourceDigest {
            algorithm: SourceDigestAlgorithm::Sha256,
            scope: DigestScope::NormalizedContent,
            value: observation.record.sha256.clone(),
            size: observation.record.size,
        }]
    };
    if observation.record.storage_sha256 != observation.record.sha256
        || observation.record.storage_size != observation.record.size
    {
        values.push(ObservedSourceDigest {
            algorithm: SourceDigestAlgorithm::Sha256,
            scope: DigestScope::OriginalContainer,
            value: observation.record.storage_sha256.clone(),
            size: observation.record.storage_size,
        });
    }
    values
}

fn disc_representation_matches(
    representation: &SourceRepresentation,
    path: &Path,
    discs: &[ObservedOpticalDisc],
) -> bool {
    if !disc_extensions_match(representation, path, discs) {
        return false;
    }
    match &representation.kind {
        SourceRepresentationKind::GamecubeNormalizedIso { identities } => {
            let [disc] = discs else { return false };
            identities.iter().any(|identity| {
                digest_identity_matches(
                    identity,
                    &digest_pair(
                        DigestScope::GamecubeNormalizedIso,
                        disc.size,
                        &disc.sha1,
                        &disc.sha256,
                    ),
                )
            })
        }
        SourceRepresentationKind::OpticalTrackSet {
            track_counts,
            identities,
        } => {
            let [disc] = discs else { return false };
            track_counts.contains(&disc.track_count)
                && identities.iter().any(|identity| {
                    digest_identity_matches(
                        identity,
                        &digest_pair(
                            DigestScope::PsxNormalizedTrackSet,
                            disc.size,
                            &disc.sha1,
                            &disc.sha256,
                        ),
                    )
                })
        }
        SourceRepresentationKind::MultiDiscSet { discs: expected } => {
            discs.len() == expected.len()
                && expected.iter().zip(discs).all(|(expected, actual)| {
                    expected.track_counts.contains(&actual.track_count)
                        && (expected.volume_ids.is_empty()
                            || actual.volume_id.as_ref().is_some_and(|actual| {
                                expected
                                    .volume_ids
                                    .iter()
                                    .any(|value| value.eq_ignore_ascii_case(actual))
                            }))
                        && (expected.identities.is_empty()
                            || expected.identities.iter().any(|identity| {
                                digest_identity_matches(
                                    identity,
                                    &digest_pair(
                                        DigestScope::DiscSetMember,
                                        actual.size,
                                        &actual.sha1,
                                        &actual.sha256,
                                    ),
                                )
                            }))
                })
        }
        SourceRepresentationKind::VolumeId {
            values,
            track_counts,
        } => {
            let [disc] = discs else { return false };
            track_counts.contains(&disc.track_count)
                && disc.volume_id.as_ref().is_some_and(|actual| {
                    values
                        .iter()
                        .any(|expected| expected.eq_ignore_ascii_case(actual))
                })
        }
        _ => false,
    }
}

fn disc_extensions_match(
    representation: &SourceRepresentation,
    path: &Path,
    discs: &[ObservedOpticalDisc],
) -> bool {
    if representation.extensions.is_empty() {
        return true;
    }
    let matches = |name: &str| {
        Path::new(name)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                representation
                    .extensions
                    .iter()
                    .any(|expected| expected.eq_ignore_ascii_case(extension))
            })
    };
    if path.is_file() {
        return path.to_str().is_some_and(matches);
    }
    !discs.is_empty()
        && discs
            .iter()
            .all(|disc| disc.name.as_deref().is_some_and(matches))
}

fn digest_pair(
    scope: DigestScope,
    size: u64,
    sha1: &str,
    sha256: &str,
) -> Vec<ObservedSourceDigest> {
    let mut values = Vec::with_capacity(2);
    append_pair(&mut values, scope, size, sha1, sha256);
    values
}

fn inspect_file_set_representation(
    profile_id: &str,
    path: &Path,
    is_zip: bool,
    members: &[crate::SourceMemberIdentity],
) -> Result<Option<(Vec<ObservedSourceComponent>, SourceRecord, bool)>> {
    let mut archive = if is_zip {
        Some(
            zip::ZipArchive::new(File::open(path)?)
                .map_err(|error| PortcoveError::source(format!("invalid file-set ZIP: {error}")))?,
        )
    } else {
        None
    };
    let mut components = Vec::with_capacity(members.len());
    let mut hashes = Vec::with_capacity(members.len());
    let mut total_size = 0_u64;
    let mut matched = true;
    let mut selected_names = HashSet::new();
    for member in members {
        let Some(source) = (if let Some(archive) = archive.as_mut() {
            read_file_set_zip_member(archive, &member.filenames)?
        } else {
            read_file_set_directory_member(path, &member.filenames)?
        }) else {
            return Ok(None);
        };
        let HashedNamedSource {
            name,
            sha1,
            sha256,
            crc32,
            size,
        } = source;
        if !selected_names.insert(name.to_ascii_lowercase()) {
            return Ok(None);
        }
        let digests = vec![
            ObservedSourceDigest {
                algorithm: SourceDigestAlgorithm::Sha1,
                scope: DigestScope::FileSetMember,
                value: sha1,
                size,
            },
            ObservedSourceDigest {
                algorithm: SourceDigestAlgorithm::Sha256,
                scope: DigestScope::FileSetMember,
                value: sha256.clone(),
                size,
            },
            ObservedSourceDigest {
                algorithm: SourceDigestAlgorithm::Crc32,
                scope: DigestScope::FileSetMember,
                value: crc32,
                size,
            },
        ];
        if !member
            .identities
            .iter()
            .any(|identity| digest_identity_matches(identity, &digests))
        {
            matched = false;
        }
        hashes.push(format!("{}:{sha256}", member.id));
        total_size = total_size.saturating_add(size);
        components.push(ObservedSourceComponent {
            id: member.id.clone(),
            kind: SourceComponentKind::FileSetMember,
            name: Some(name),
            digests,
            size,
            track_count: None,
            volume_id: None,
        });
    }
    let aggregate = aggregate_sha256(&hashes);
    let (storage_sha256, storage_size) = if is_zip {
        let (_, sha256, _, size) = hash_source(File::open(path)?)?;
        (sha256, size)
    } else {
        (aggregate.clone(), total_size)
    };
    Ok(Some((
        components,
        SourceRecord {
            profile_id: profile_id.into(),
            path: path.into(),
            sha256: aggregate,
            size: total_size,
            storage_sha256,
            storage_size,
            updated_at: Library::now(),
        },
        matched,
    )))
}

fn read_file_set_directory_member(
    root: &Path,
    accepted_filenames: &[String],
) -> Result<Option<HashedNamedSource>> {
    let mut matches = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            return Err(PortcoveError::unsupported(
                "Portcove V1 requires source member paths to be valid Unicode",
            )
            .detail("path_role", "source member"));
        };
        if accepted_filenames
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(&name))
        {
            matches.push((name, entry.path()));
        }
    }
    if matches.len() != 1 {
        return Ok(None);
    }
    let (name, path) = matches.remove(0);
    let (sha1, sha256, crc32, size) = hash_source(File::open(path)?)?;
    Ok(Some(HashedNamedSource {
        name,
        sha1,
        sha256,
        crc32,
        size,
    }))
}

fn read_file_set_zip_member(
    archive: &mut zip::ZipArchive<File>,
    accepted_filenames: &[String],
) -> Result<Option<HashedNamedSource>> {
    let mut matches = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| {
            PortcoveError::source(format!("invalid file-set ZIP entry: {error}"))
        })?;
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        if entry.is_dir() || path.components().count() != 1 {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if accepted_filenames
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(name))
        {
            matches.push((index, name.to_owned()));
        }
    }
    if matches.len() != 1 {
        return Ok(None);
    }
    let (index, name) = matches.remove(0);
    let entry = archive
        .by_index(index)
        .map_err(|error| PortcoveError::source(format!("invalid file-set ZIP entry: {error}")))?;
    let (sha1, sha256, crc32, size) = hash_source(entry)?;
    Ok(Some(HashedNamedSource {
        name,
        sha1,
        sha256,
        crc32,
        size,
    }))
}

struct HashedNamedSource {
    name: String,
    sha1: String,
    sha256: String,
    crc32: String,
    size: u64,
}

fn hash_source(mut reader: impl Read) -> Result<(String, String, String, u64)> {
    let mut sha1 = Sha1::new();
    let mut sha256 = Sha256::new();
    let mut crc32 = crc32fast::Hasher::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        sha1.update(&buffer[..read]);
        sha256.update(&buffer[..read]);
        crc32.update(&buffer[..read]);
        size = size.saturating_add(read as u64);
    }
    Ok((
        hex::encode(sha1.finalize()),
        hex::encode(sha256.finalize()),
        format!("{:08x}", crc32.finalize()),
        size,
    ))
}

fn file_set_aggregate_digests(record: &SourceRecord) -> Vec<ObservedSourceDigest> {
    let mut values = vec![ObservedSourceDigest {
        algorithm: SourceDigestAlgorithm::Sha256,
        scope: DigestScope::NormalizedContent,
        value: record.sha256.clone(),
        size: record.size,
    }];
    if record.storage_sha256 != record.sha256 || record.storage_size != record.size {
        values.push(ObservedSourceDigest {
            algorithm: SourceDigestAlgorithm::Sha256,
            scope: DigestScope::OriginalContainer,
            value: record.storage_sha256.clone(),
            size: record.storage_size,
        });
    }
    values
}

pub(crate) fn inspect_file_identity(
    catalog: &Catalog,
    profile_id: &str,
    path: &Path,
    identity: &FileIdentity,
) -> Result<SourceInspection> {
    inspect_file_identity_with_compound(catalog, profile_id, path, identity, None)
}

fn inspect_file_identity_with_compound(
    catalog: &Catalog,
    profile_id: &str,
    path: &Path,
    identity: &FileIdentity,
    validated_compound: Option<CompoundSourceFormat>,
) -> Result<SourceInspection> {
    let legacy = catalog.source_profile(profile_id)?;
    let observed_digests = observed_digests(identity);
    let record = identity.record_without_admission(profile_id, path);

    let Some(source_catalog) = catalog.source_catalog() else {
        let mode = if legacy.accepted_sha1.is_empty() && legacy.accepted_sha256.is_empty() {
            SourceAdmissionMode::StructuralChecks
        } else {
            SourceAdmissionMode::ExactIdentity
        };
        return Ok(SourceInspection {
            profile_id: profile_id.into(),
            path: path.into(),
            observed_digests,
            components: Vec::new(),
            validator: None,
            assessment: SourceAssessment {
                health: crate::SourceHealth::NotBaselined,
                classification: SourceClassification::NotEvaluated,
                contract: SourceContractResult::NotEvaluated,
                admission: SourceAdmission::Admitted { mode },
                evidence: Vec::new(),
            },
            record: Some(identity.record(legacy, path)?),
            message: "source passed the schema-1 compatibility contract".into(),
        });
    };
    let profile = source_catalog
        .identities
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| {
            PortcoveError::state(format!("schema-2 source profile {profile_id} is missing"))
        })?;

    let mut candidates = Vec::new();
    for variant in profile
        .variants
        .iter()
        .filter(|variant| !variant.legacy_projection_only)
    {
        for representation in &variant.representations {
            if representation_matches(
                representation,
                identity,
                &observed_digests,
                validated_compound,
            ) {
                let candidate = SourceIdentity {
                    game_id: profile.id.clone(),
                    variant_id: variant.id.clone(),
                    representation_id: representation.id.clone(),
                };
                if !candidates.contains(&candidate) {
                    candidates.push(candidate);
                }
            }
        }
    }

    let (classification, admission, admitted_record, message) = match candidates.as_slice() {
        [candidate] => (
            SourceClassification::Recognized {
                identity: candidate.clone(),
            },
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity,
            },
            Some(record),
            "source matches one exact schema-2 identity".into(),
        ),
        [] if legacy.accepted_sha1.is_empty() && legacy.accepted_sha256.is_empty() => (
            SourceClassification::Unrecognized,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::StructuralChecks,
            },
            Some(record),
            "source passed the preserved structural compatibility contract; its exact identity is unknown".into(),
        ),
        [] => (
            SourceClassification::Unrecognized,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch,
            },
            None,
            format!("source hash is not a supported {} variant", legacy.label),
        ),
        many => (
            SourceClassification::Ambiguous {
                candidates: many.to_vec(),
            },
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::AmbiguousIdentity,
            },
            None,
            "source bytes match more than one schema-2 identity".into(),
        ),
    };

    Ok(SourceInspection {
        profile_id: profile_id.into(),
        path: path.into(),
        observed_digests,
        components: Vec::new(),
        validator: None,
        assessment: SourceAssessment {
            health: crate::SourceHealth::NotBaselined,
            classification,
            contract: SourceContractResult::NotEvaluated,
            admission,
            evidence: Vec::new(),
        },
        record: admitted_record,
        message,
    })
}

fn representation_matches(
    representation: &SourceRepresentation,
    file: &FileIdentity,
    observed: &[ObservedSourceDigest],
    validated_compound: Option<CompoundSourceFormat>,
) -> bool {
    if !representation_extensions_match(representation, file) {
        return false;
    }
    let identities = match &representation.kind {
        SourceRepresentationKind::RawFile { identities } => identities,
        SourceRepresentationKind::CanonicalN64 { identities } => {
            if file.canonical_n64_sha256.is_none() {
                return false;
            }
            identities
        }
        SourceRepresentationKind::ArchiveMember {
            member_extensions,
            identities,
        } => {
            if !file.archive_member
                || !member_extensions
                    .iter()
                    .any(|extension| extension.eq_ignore_ascii_case(&file.content_extension))
            {
                return false;
            }
            identities
        }
        SourceRepresentationKind::Compound { format, identities } => {
            if validated_compound != Some(*format) || file.archive_member {
                return false;
            }
            identities
        }
        _ => return false,
    };
    identities
        .iter()
        .any(|identity| digest_identity_matches(identity, observed))
}

fn representation_extensions_match(
    representation: &SourceRepresentation,
    file: &FileIdentity,
) -> bool {
    representation.extensions.is_empty()
        || representation
            .extensions
            .iter()
            .any(|extension| extension.eq_ignore_ascii_case(&file.content_extension))
}

fn matching_compound_format(
    catalog: &Catalog,
    profile_id: &str,
    file: &FileIdentity,
    observed: &[ObservedSourceDigest],
) -> Option<CompoundSourceFormat> {
    if file.archive_member {
        return None;
    }
    catalog
        .source_catalog()?
        .identities
        .iter()
        .find(|profile| profile.id == profile_id)?
        .variants
        .iter()
        .filter(|variant| !variant.legacy_projection_only)
        .flat_map(|variant| &variant.representations)
        .find_map(|representation| {
            let SourceRepresentationKind::Compound { format, identities } = &representation.kind
            else {
                return None;
            };
            (representation_extensions_match(representation, file)
                && identities
                    .iter()
                    .any(|identity| digest_identity_matches(identity, observed)))
            .then_some(*format)
        })
}

fn digest_identity_matches(identity: &DigestIdentity, observed: &[ObservedSourceDigest]) -> bool {
    [
        (SourceDigestAlgorithm::Sha1, identity.sha1.as_deref()),
        (SourceDigestAlgorithm::Sha256, identity.sha256.as_deref()),
        (SourceDigestAlgorithm::Crc32, identity.crc32.as_deref()),
    ]
    .into_iter()
    .all(|(algorithm, expected)| {
        expected.is_none_or(|expected| {
            observed.iter().any(|actual| {
                actual.algorithm == algorithm
                    && actual.scope == identity.scope
                    && actual.value.eq_ignore_ascii_case(expected)
            })
        })
    })
}

fn observed_digests(identity: &FileIdentity) -> Vec<ObservedSourceDigest> {
    let mut values = Vec::new();
    let content_scope = if identity.archive_member {
        DigestScope::ArchiveMember
    } else {
        DigestScope::OriginalFile
    };
    append_pair(
        &mut values,
        content_scope,
        identity.size,
        &identity.sha1,
        &identity.sha256,
    );
    append_pair(
        &mut values,
        DigestScope::NormalizedContent,
        identity.size,
        &identity.sha1,
        &identity.sha256,
    );
    if identity.archive_member {
        values.push(ObservedSourceDigest {
            algorithm: SourceDigestAlgorithm::Sha256,
            scope: DigestScope::OriginalContainer,
            value: identity.storage_sha256.clone(),
            size: identity.storage_size,
        });
    }
    if let (Some(sha1), Some(sha256), Some(size)) = (
        &identity.canonical_n64_sha1,
        &identity.canonical_n64_sha256,
        identity.canonical_n64_size,
    ) {
        append_pair(
            &mut values,
            DigestScope::CanonicalN64BigEndian,
            size,
            sha1,
            sha256,
        );
    }
    values
}

fn append_pair(
    values: &mut Vec<ObservedSourceDigest>,
    scope: DigestScope,
    size: u64,
    sha1: &str,
    sha256: &str,
) {
    values.push(ObservedSourceDigest {
        algorithm: SourceDigestAlgorithm::Sha1,
        scope,
        value: sha1.into(),
        size,
    });
    values.push(ObservedSourceDigest {
        algorithm: SourceDigestAlgorithm::Sha256,
        scope,
        value: sha256.into(),
        size,
    });
}

impl FileIdentity {
    fn record_without_admission(&self, profile_id: &str, path: &Path) -> SourceRecord {
        SourceRecord {
            profile_id: profile_id.into(),
            path: path.into(),
            sha256: self.sha256.clone(),
            size: self.size,
            storage_sha256: self.storage_sha256.clone(),
            storage_size: self.storage_size,
            updated_at: Library::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha1::Sha1;
    use sha2::{Digest, Sha256};
    use std::{fs, io::Write};

    fn catalog_with_identity(
        profile_id: &str,
        mutate: impl FnOnce(&mut crate::SourceIdentityProfile),
    ) -> Catalog {
        let mut document = Catalog::embedded().unwrap().authoritative_document();
        let profile = document
            .source_catalog
            .as_mut()
            .unwrap()
            .identities
            .iter_mut()
            .find(|profile| profile.id == profile_id)
            .unwrap();
        mutate(profile);
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
    }

    fn inspect(catalog: &Catalog, profile_id: &str, path: &Path) -> SourceInspection {
        let mut budget = HashBudget {
            operation: None,
            limit: u64::MAX,
            hashed: 0,
            max_zip_entries: 4096,
        };
        inspect_file(catalog, profile_id, path, u64::MAX, &mut budget).unwrap()
    }

    fn observed_disc_source(
        profile_id: &str,
        path: &Path,
        discs: Vec<ObservedOpticalDisc>,
    ) -> ObservedDiscSource {
        let hashes = discs
            .iter()
            .map(|disc| disc.sha256.clone())
            .collect::<Vec<_>>();
        let size = discs.iter().map(|disc| disc.size).sum();
        let sha256 = aggregate_sha256(&hashes);
        ObservedDiscSource {
            record: SourceRecord {
                profile_id: profile_id.into(),
                path: path.into(),
                sha256: sha256.clone(),
                size,
                storage_sha256: format!("storage-{sha256}"),
                storage_size: size + 1,
                updated_at: Library::now(),
            },
            discs,
        }
    }

    fn optical_disc(name: &str, bytes: &[u8], tracks: u32) -> ObservedOpticalDisc {
        ObservedOpticalDisc {
            name: Some(name.into()),
            sha1: hex::encode(Sha1::digest(bytes)),
            sha256: hex::encode(Sha256::digest(bytes)),
            size: bytes.len() as u64,
            track_count: tracks,
            volume_id: None,
        }
    }

    fn stfs_fixture() -> Vec<u8> {
        let mut package = vec![0_u8; 0xe000];
        package[..4].copy_from_slice(b"LIVE");
        package[0x340..0x344].copy_from_slice(&0xad0e_u32.to_be_bytes());
        package[0x37b] = 1;
        package[0x37c..0x37e].copy_from_slice(&1_u16.to_le_bytes());
        package[0x395..0x399].copy_from_slice(&2_u32.to_be_bytes());
        package[0xb014..0xb018].copy_from_slice(&0x00ff_ffff_u32.to_be_bytes());
        package[0xb02c..0xb030].copy_from_slice(&0x00ff_ffff_u32.to_be_bytes());
        let entry = &mut package[0xc000..0xc040];
        entry[..11].copy_from_slice(b"default.xex");
        entry[0x28] = 11;
        entry[0x29] = 1;
        entry[0x2f] = 1;
        entry[0x32..0x34].copy_from_slice(&u16::MAX.to_be_bytes());
        entry[0x34..0x38].copy_from_slice(&4_u32.to_be_bytes());
        package[0xd000..0xd004].copy_from_slice(b"XEX2");
        package
    }

    #[test]
    fn raw_file_digests_are_conjunctive_and_zip_storage_stays_separate() {
        let temporary = tempfile::tempdir().unwrap();
        let bytes = b"synthetic exact BIOS";
        let sha1 = hex::encode(Sha1::digest(bytes));
        let sha256 = hex::encode(Sha256::digest(bytes));
        let catalog = catalog_with_identity("psx-scph-1001-bios", |profile| {
            let SourceRepresentationKind::RawFile { identities } =
                &mut profile.variants[0].representations[0].kind
            else {
                panic!("BIOS fixture is a raw file")
            };
            identities[0].sha1 = Some(sha1.clone());
            identities[0].sha256 = Some(sha256.clone());
        });

        let file = temporary.path().join("bios.bin");
        fs::write(&file, bytes).unwrap();
        let exact = inspect(&catalog, "psx-scph-1001-bios", &file);
        assert!(matches!(
            exact.assessment.classification,
            SourceClassification::Recognized { .. }
        ));
        assert!(matches!(
            exact.assessment.admission,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity
            }
        ));

        let conjunctive_mismatch = catalog_with_identity("psx-scph-1001-bios", |profile| {
            let SourceRepresentationKind::RawFile { identities } =
                &mut profile.variants[0].representations[0].kind
            else {
                unreachable!()
            };
            identities[0].sha1 = Some(sha1.clone());
            identities[0].sha256 = Some("0".repeat(64));
        });
        assert!(matches!(
            inspect(&conjunctive_mismatch, "psx-scph-1001-bios", &file)
                .assessment
                .admission,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch
            }
        ));

        let archive_path = temporary.path().join("bios.zip");
        let mut archive = zip::ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive
            .start_file("bios.bin", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(bytes).unwrap();
        archive.finish().unwrap();
        let zipped = inspect(&catalog, "psx-scph-1001-bios", &archive_path);
        assert!(matches!(
            zipped.assessment.admission,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity
            }
        ));
        assert!(
            zipped
                .observed_digests
                .iter()
                .any(|digest| digest.scope == DigestScope::OriginalContainer)
        );
        assert!(
            zipped
                .observed_digests
                .iter()
                .any(|digest| digest.scope == DigestScope::ArchiveMember)
        );

        fs::write(&file, b"different bytes").unwrap();
        let mismatch = inspect(&catalog, "psx-scph-1001-bios", &file);
        assert!(matches!(
            mismatch.assessment.admission,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch
            }
        ));
        assert!(mismatch.record.is_none());
    }

    #[test]
    fn every_n64_byte_order_matches_one_canonical_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let canonical = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4, 5, 6, 7, 8];
        let sha1 = hex::encode(Sha1::digest(canonical));
        let catalog = catalog_with_identity("star-fox-64", |profile| {
            let variant = profile
                .variants
                .iter_mut()
                .find(|variant| variant.id == "usa-1-0")
                .unwrap();
            variant.representations.truncate(1);
            let SourceRepresentationKind::CanonicalN64 { identities } =
                &mut variant.representations[0].kind
            else {
                panic!("Star Fox fixture is canonical N64")
            };
            identities[0].sha1 = Some(sha1);
            identities[0].sha256 = None;
        });

        let mut byte_swapped = canonical;
        for pair in byte_swapped.chunks_exact_mut(2) {
            pair.swap(0, 1);
        }
        let mut little = canonical;
        for word in little.chunks_exact_mut(4) {
            word.reverse();
        }
        for (name, bytes) in [
            ("game.z64", canonical.as_slice()),
            ("game.v64", byte_swapped.as_slice()),
            ("game.n64", little.as_slice()),
        ] {
            let path = temporary.path().join(name);
            fs::write(&path, bytes).unwrap();
            let result = inspect(&catalog, "star-fox-64", &path);
            let SourceClassification::Recognized { identity } = result.assessment.classification
            else {
                panic!("{name} was not recognized")
            };
            assert_eq!(identity.variant_id, "usa-1-0");
            assert_eq!(identity.representation_id, "compressed-rom");
        }
    }

    #[test]
    fn distinct_matching_representations_are_ambiguous_and_never_admitted() {
        let temporary = tempfile::tempdir().unwrap();
        let bytes = b"ambiguous source";
        let sha1 = hex::encode(Sha1::digest(bytes));
        let sha256 = hex::encode(Sha256::digest(bytes));
        let catalog = catalog_with_identity("psx-scph-1001-bios", |profile| {
            let representation = &mut profile.variants[0].representations[0];
            let SourceRepresentationKind::RawFile { identities } = &mut representation.kind else {
                panic!("BIOS fixture is a raw file")
            };
            identities[0].sha1 = Some(sha1);
            identities[0].sha256 = None;
            let mut second = representation.clone();
            second.id = "sha256-alternative".into();
            let SourceRepresentationKind::RawFile { identities } = &mut second.kind else {
                unreachable!()
            };
            identities[0].sha1 = None;
            identities[0].sha256 = Some(sha256);
            profile.variants[0].representations.push(second);
        });
        let path = temporary.path().join("bios.bin");
        fs::write(&path, bytes).unwrap();
        let result = inspect(&catalog, "psx-scph-1001-bios", &path);
        assert!(matches!(
            result.assessment.classification,
            SourceClassification::Ambiguous { .. }
        ));
        assert!(matches!(
            result.assessment.admission,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::AmbiguousIdentity
            }
        ));
        assert!(result.record.is_none());
    }

    #[test]
    fn file_set_members_are_observed_once_and_impossible_cross_pairs_are_rejected() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("source-set");
        fs::create_dir(&root).unwrap();
        let fixtures = [
            ("baserom.us.rev0.z64", b"cartridge".as_slice()),
            ("baserom.translated.ek.ndd", b"expansion".as_slice()),
            ("N64DDIPLROM.n64", b"ipl".as_slice()),
        ];
        for (name, bytes) in fixtures {
            fs::write(root.join(name), bytes).unwrap();
        }
        let catalog = catalog_with_identity("g-diffuser-source-set", |profile| {
            let SourceRepresentationKind::FileSet { members } =
                &mut profile.variants[0].representations[0].kind
            else {
                panic!("G-Diffuser fixture is a file set")
            };
            for (member, (_, bytes)) in members.iter_mut().zip(fixtures) {
                member.identities = vec![DigestIdentity {
                    scope: DigestScope::FileSetMember,
                    sha1: Some(hex::encode(Sha1::digest(bytes))),
                    sha256: Some(hex::encode(Sha256::digest(bytes))),
                    crc32: Some(format!("{:08x}", crc32fast::hash(bytes))),
                }];
            }
        });

        let result = inspect_file_set(&catalog, "g-diffuser-source-set", &root).unwrap();
        assert!(matches!(
            result.assessment.classification,
            SourceClassification::Recognized { .. }
        ));
        assert_eq!(result.components.len(), 3);
        assert!(result.components.iter().all(|component| {
            component.kind == SourceComponentKind::FileSetMember && component.digests.len() == 3
        }));

        let archive_path = temporary.path().join("source-set.zip");
        let mut archive = zip::ZipWriter::new(fs::File::create(&archive_path).unwrap());
        for (name, bytes) in fixtures {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(bytes).unwrap();
        }
        archive.finish().unwrap();
        let zipped = inspect_file_set(&catalog, "g-diffuser-source-set", &archive_path).unwrap();
        assert!(matches!(
            zipped.assessment.admission,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity
            }
        ));
        assert!(zipped.observed_digests.iter().any(|digest| {
            digest.scope == DigestScope::OriginalContainer
                && digest.value == zipped.record.as_ref().unwrap().storage_sha256
        }));

        let cross_pair = catalog_with_identity("g-diffuser-source-set", |profile| {
            let SourceRepresentationKind::FileSet { members } =
                &mut profile.variants[0].representations[0].kind
            else {
                unreachable!()
            };
            for (member, (_, bytes)) in members.iter_mut().zip(fixtures) {
                let actual_sha1 = hex::encode(Sha1::digest(bytes));
                let actual_sha256 = hex::encode(Sha256::digest(bytes));
                member.identities = vec![
                    DigestIdentity {
                        scope: DigestScope::FileSetMember,
                        sha1: Some(actual_sha1),
                        sha256: Some("0".repeat(64)),
                        crc32: None,
                    },
                    DigestIdentity {
                        scope: DigestScope::FileSetMember,
                        sha1: Some("0".repeat(40)),
                        sha256: Some(actual_sha256),
                        crc32: None,
                    },
                ];
            }
        });
        let rejected = inspect_file_set(&cross_pair, "g-diffuser-source-set", &root).unwrap();
        assert!(matches!(
            rejected.assessment.admission,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch
            }
        ));
        assert!(rejected.record.is_none());
    }

    #[test]
    fn raw_gamecube_iso_is_observed_without_rewriting_the_selected_file() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("game.iso");
        let bytes = b"synthetic normalized GameCube ISO";
        fs::write(&path, bytes).unwrap();
        let sha1 = hex::encode(Sha1::digest(bytes));
        let sha256 = hex::encode(Sha256::digest(bytes));
        let catalog = catalog_with_identity("animal-crossing-gamecube", |profile| {
            let SourceRepresentationKind::GamecubeNormalizedIso { identities } =
                &mut profile.variants[0].representations[0].kind
            else {
                panic!("Animal Crossing fixture is a normalized GameCube ISO")
            };
            identities[0].sha1 = Some(sha1);
            identities[0].sha256 = Some(sha256);
        });
        let legacy = catalog.source_profile("animal-crossing-gamecube").unwrap();
        let observed = observe_gamecube_disc_source(legacy, &path).unwrap();
        let result =
            inspect_disc_observation(&catalog, "animal-crossing-gamecube", &path, observed)
                .unwrap();

        assert!(matches!(
            result.assessment.admission,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity
            }
        ));
        assert!(result.components.is_empty());
        assert!(result.observed_digests.iter().any(|digest| {
            digest.algorithm == SourceDigestAlgorithm::Sha1
                && digest.scope == DigestScope::GamecubeNormalizedIso
        }));
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn psx_track_set_requires_one_conjunctive_identity_and_an_allowed_track_count() {
        let path = Path::new("game.chd");
        let disc = optical_disc("game.chd", b"normalized PSX data track", 17);
        let catalog = catalog_with_identity("masters-of-teras-kasi-psx", |profile| {
            let SourceRepresentationKind::OpticalTrackSet { identities, .. } =
                &mut profile.variants[0].representations[0].kind
            else {
                panic!("Masters fixture is an optical track set")
            };
            identities[0].sha1 = Some(disc.sha1.clone());
            identities[0].sha256 = Some(disc.sha256.clone());
        });
        let exact = inspect_disc_observation(
            &catalog,
            "masters-of-teras-kasi-psx",
            path,
            observed_disc_source("masters-of-teras-kasi-psx", path, vec![disc.clone()]),
        )
        .unwrap();
        assert!(matches!(
            exact.assessment.classification,
            SourceClassification::Recognized { .. }
        ));
        assert_eq!(exact.components[0].track_count, Some(17));
        assert!(exact.observed_digests.iter().any(|digest| {
            digest.scope == DigestScope::PsxNormalizedTrackSet
                && digest.algorithm == SourceDigestAlgorithm::Sha256
        }));

        let mismatch = catalog_with_identity("masters-of-teras-kasi-psx", |profile| {
            let SourceRepresentationKind::OpticalTrackSet { identities, .. } =
                &mut profile.variants[0].representations[0].kind
            else {
                unreachable!()
            };
            identities[0].sha1 = Some(disc.sha1.clone());
            identities[0].sha256 = Some("0".repeat(64));
        });
        let rejected = inspect_disc_observation(
            &mismatch,
            "masters-of-teras-kasi-psx",
            path,
            observed_disc_source("masters-of-teras-kasi-psx", path, vec![disc.clone()]),
        )
        .unwrap();
        assert!(matches!(
            rejected.assessment.admission,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch
            }
        ));

        let mut wrong_tracks = disc;
        wrong_tracks.track_count = 1;
        let rejected = inspect_disc_observation(
            &catalog,
            "masters-of-teras-kasi-psx",
            path,
            observed_disc_source("masters-of-teras-kasi-psx", path, vec![wrong_tracks]),
        )
        .unwrap();
        assert!(rejected.record.is_none());
    }

    #[test]
    fn psx_multi_disc_matching_preserves_order_volume_ids_and_per_disc_facts() {
        let path = Path::new("disc-set");
        let mut discs = (1..=4)
            .map(|index| optical_disc(&format!("disc-{index}.chd"), &[index as u8], 1))
            .collect::<Vec<_>>();
        for (disc, volume_id) in
            discs
                .iter_mut()
                .zip(["SCUS94491", "SCUS94584", "SCUS94585", "SCUS94586"])
        {
            disc.volume_id = Some(volume_id.into());
        }
        let catalog = Catalog::embedded().unwrap();
        let exact = inspect_disc_observation(
            &catalog,
            "legend-of-dragoon-usa",
            path,
            observed_disc_source("legend-of-dragoon-usa", path, discs.clone()),
        )
        .unwrap();
        assert!(matches!(
            exact.assessment.admission,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity
            }
        ));
        assert_eq!(exact.components.len(), 4);
        assert!(exact.components.iter().all(|component| {
            component.kind == SourceComponentKind::OpticalDisc
                && component.track_count == Some(1)
                && component.volume_id.is_some()
                && component
                    .digests
                    .iter()
                    .all(|digest| digest.scope == DigestScope::DiscSetMember)
        }));

        discs.swap(0, 1);
        let rejected = inspect_disc_observation(
            &catalog,
            "legend-of-dragoon-usa",
            path,
            observed_disc_source("legend-of-dragoon-usa", path, discs),
        )
        .unwrap();
        assert!(matches!(
            rejected.assessment.admission,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch
            }
        ));

        let volume_only = SourceRepresentation {
            id: "volume-only".into(),
            extensions: vec!["chd".into()],
            kind: SourceRepresentationKind::VolumeId {
                values: vec!["SCUS94491".into()],
                track_counts: vec![1],
            },
            evidence_ids: Vec::new(),
        };
        let first = optical_disc("disc-1.chd", b"one", 1);
        let mut first_with_volume = first.clone();
        first_with_volume.volume_id = Some("scus94491".into());
        assert!(disc_representation_matches(
            &volume_only,
            Path::new("disc-1.chd"),
            &[first_with_volume]
        ));
        assert!(!disc_representation_matches(
            &volume_only,
            Path::new("disc-1.chd"),
            &[first]
        ));
    }

    #[test]
    fn service_inspection_is_read_only_and_registration_consumes_the_same_result() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source.z64");
        fs::write(&path, b"synthetic structurally accepted source").unwrap();
        let service = crate::PortcoveService::new(
            crate::Library::open(temporary.path().join("library")).unwrap(),
        )
        .unwrap();

        let inspection = service.inspect_source("star-fox-64", &path).unwrap();
        assert!(matches!(
            inspection.assessment.admission,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::StructuralChecks
            }
        ));
        assert!(service.library().sources().unwrap().is_empty());
        assert_eq!(
            fs::read(&path).unwrap(),
            b"synthetic structurally accepted source"
        );

        let expected = inspection.record.unwrap();
        let registered = service.register_source("star-fox-64", &path).unwrap();
        assert_eq!(registered.sha256, expected.sha256);
        assert_eq!(registered.storage_sha256, expected.storage_sha256);
        assert_eq!(service.library().sources().unwrap().len(), 1);
    }

    #[test]
    fn stfs_compound_requires_exact_identity_and_bounded_structure() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source");
        let package = stfs_fixture();
        let sha256 = hex::encode(Sha256::digest(&package));
        let catalog = catalog_with_identity("sotn-xbla", |profile| {
            let SourceRepresentationKind::Compound { identities, .. } =
                &mut profile.variants[0].representations[0].kind
            else {
                panic!("SotN fixture is an STFS compound source")
            };
            identities[0].sha256 = Some(sha256.clone());
        });
        fs::write(&path, &package).unwrap();

        let exact = inspect(&catalog, "sotn-xbla", &path);

        assert!(matches!(
            exact.assessment.classification,
            SourceClassification::Recognized { .. }
        ));
        assert!(matches!(
            exact.assessment.admission,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::ExactIdentity
            }
        ));
        assert!(exact.observed_digests.iter().any(|digest| {
            digest.scope == DigestScope::NormalizedContent && digest.value == sha256
        }));
        assert_eq!(fs::read(&path).unwrap(), package);

        let mut changed = stfs_fixture();
        changed[0xd000..0xd004].copy_from_slice(b"XEX3");
        fs::write(&path, changed).unwrap();
        let mismatch = inspect(&catalog, "sotn-xbla", &path);
        assert!(matches!(
            mismatch.assessment.admission,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch
            }
        ));
        assert!(mismatch.record.is_none());
    }

    #[test]
    fn exact_hash_cannot_admit_malformed_or_truncated_stfs() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source");
        let mut malformed = stfs_fixture();
        malformed[0] = b'X';
        let sha256 = hex::encode(Sha256::digest(&malformed));
        let catalog = catalog_with_identity("sotn-xbla", |profile| {
            let SourceRepresentationKind::Compound { identities, .. } =
                &mut profile.variants[0].representations[0].kind
            else {
                unreachable!()
            };
            identities[0].sha256 = Some(sha256);
        });
        fs::write(&path, malformed).unwrap();
        assert!(
            inspect_file(
                &catalog,
                "sotn-xbla",
                &path,
                u64::MAX,
                &mut HashBudget {
                    operation: None,
                    limit: u64::MAX,
                    hashed: 0,
                    max_zip_entries: 4096,
                },
            )
            .is_err()
        );

        let mut truncated = stfs_fixture();
        truncated[0xc029] = 2;
        truncated[0xc034..0xc038].copy_from_slice(&4097_u32.to_be_bytes());
        let sha256 = hex::encode(Sha256::digest(&truncated));
        let catalog = catalog_with_identity("sotn-xbla", |profile| {
            let SourceRepresentationKind::Compound { identities, .. } =
                &mut profile.variants[0].representations[0].kind
            else {
                unreachable!()
            };
            identities[0].sha256 = Some(sha256);
        });
        fs::write(&path, truncated).unwrap();
        assert!(
            inspect_file(
                &catalog,
                "sotn-xbla",
                &path,
                u64::MAX,
                &mut HashBudget {
                    operation: None,
                    limit: u64::MAX,
                    hashed: 0,
                    max_zip_entries: 4096,
                },
            )
            .is_err()
        );
    }

    #[test]
    fn pinned_validator_selection_is_typed_but_not_an_exact_match() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("game.iso");
        fs::write(&path, b"synthetic retail disc candidate").unwrap();
        let service = crate::PortcoveService::new(
            crate::Library::open(temporary.path().join("library")).unwrap(),
        )
        .unwrap();

        let inspection = service.inspect_source("opengoal-jak1-disc", &path).unwrap();

        assert_eq!(
            inspection.assessment.classification,
            SourceClassification::NotEvaluated
        );
        assert!(matches!(
            inspection.assessment.admission,
            SourceAdmission::Admitted {
                mode: SourceAdmissionMode::StructuralChecks
            }
        ));
        let validator = inspection.validator.as_ref().unwrap();
        assert_eq!(validator.contract_id, "opengoal-jak1-disc-validator-v1");
        assert_eq!(validator.tool_id, "opengoal-launcher");
        assert_eq!(validator.result, SourceValidatorResult::NotRun);
        assert!(service.library().sources().unwrap().is_empty());

        let expected = inspection.record.unwrap();
        let registered = service
            .register_source("opengoal-jak1-disc", &path)
            .unwrap();
        assert_eq!(registered.sha256, expected.sha256);
        assert_eq!(service.library().sources().unwrap().len(), 1);
    }

    #[test]
    fn pinned_validator_ambiguity_and_wrong_extension_are_not_admitted() {
        let temporary = tempfile::tempdir().unwrap();
        let iso = temporary.path().join("game.iso");
        fs::write(&iso, b"ambiguous candidate").unwrap();
        let catalog = catalog_with_identity("opengoal-jak1-disc", |profile| {
            let mut second = profile.variants[0].representations[0].clone();
            second.id = "second-pinned-validator".into();
            profile.variants[0].representations.push(second);
        });
        let mut budget = HashBudget {
            operation: None,
            limit: u64::MAX,
            hashed: 0,
            max_zip_entries: 4096,
        };
        let ambiguous =
            inspect_pinned_validator(&catalog, "opengoal-jak1-disc", &iso, u64::MAX, &mut budget)
                .unwrap();
        assert!(matches!(
            ambiguous.assessment.admission,
            SourceAdmission::Rejected {
                reason: SourceRejectionReason::AmbiguousIdentity
            }
        ));
        assert!(ambiguous.record.is_none());

        let wrong = temporary.path().join("game.bin");
        fs::write(&wrong, b"wrong extension").unwrap();
        let mut budget = HashBudget {
            operation: None,
            limit: u64::MAX,
            hashed: 0,
            max_zip_entries: 4096,
        };
        assert!(
            inspect_pinned_validator(
                &Catalog::embedded().unwrap(),
                "opengoal-jak1-disc",
                &wrong,
                u64::MAX,
                &mut budget,
            )
            .is_err()
        );
    }
}
