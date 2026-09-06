//! Read-only source inspection and schema-2 identity matching.

use std::path::{Path, PathBuf};
use std::{collections::HashSet, fs::File, io::Read};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::{
    Catalog, DigestIdentity, DigestScope, Library, PortcoveError, Result, SourceAdmission,
    SourceAdmissionMode, SourceAssessment, SourceClassification, SourceContractResult,
    SourceIdentity, SourceRecord, SourceRejectionReason, SourceRepresentation,
    SourceRepresentationKind,
    adapter::aggregate_sha256,
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

/// Facts returned by read-only inspection. A record is present only when the
/// admission state permits existing callers to register or use the source.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceInspection {
    pub profile_id: String,
    pub path: PathBuf,
    pub observed_digests: Vec<ObservedSourceDigest>,
    #[serde(default)]
    pub components: Vec<ObservedSourceComponent>,
    pub assessment: SourceAssessment,
    pub record: Option<SourceRecord>,
    pub message: String,
}

impl SourceInspection {
    pub(crate) fn from_legacy_validation(record: SourceRecord) -> Self {
        Self {
            profile_id: record.profile_id.clone(),
            path: record.path.clone(),
            observed_digests: Vec::new(),
            components: Vec::new(),
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
            message:
                "source passed a specialized compatibility inspector awaiting schema-2 migration"
                    .into(),
        }
    }

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
    inspect_file_identity(catalog, profile_id, path, &identity)
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
            if representation_matches(representation, identity, &observed_digests) {
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
) -> bool {
    if !representation.extensions.is_empty()
        && !representation
            .extensions
            .iter()
            .any(|extension| extension.eq_ignore_ascii_case(&file.content_extension))
    {
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
        _ => return false,
    };
    identities
        .iter()
        .any(|identity| digest_identity_matches(identity, observed))
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
}
