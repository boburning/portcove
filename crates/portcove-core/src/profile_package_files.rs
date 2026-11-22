use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

use crate::{Platform, PortcoveError, ProfileRevision, Result, profile_loader::ModEngine};

/// An exact wrapper and its reviewed native files for the profile's retained build.
/// A sealed revision records provenance. An acquisition digest grants no execution authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecompCompanionSetV1 {
    pub repository: String,
    pub repository_id: u64,
    pub release_id: u64,
    pub asset_id: u64,
    pub publisher_sha256: Option<String>,
    pub wrapper_sha256: String,
    pub wrapper_size: u64,
    pub install_id: String,
    pub platform: Platform,
    /// Identity of the accepted exact-set execution review, distinct from all file hashes.
    pub consent_sha256: String,
    pub members: BTreeMap<String, RecompCompanionMemberV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecompCompanionMemberV1 {
    pub size: u64,
    pub sha256: String,
    pub role: RecompCompanionRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecompCompanionRole {
    Nrm,
    PrimaryLibrary,
    BundledLibrary,
}

// Absence means legacy. An explicitly present member must be the typed array.
pub(crate) fn read_companion_sets<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Vec<RecompCompanionSetV1>>, D::Error> {
    Vec::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProfilePackageFile<'a> {
    pub name: &'a str,
    pub sha256: &'a str,
    pub size: u64,
    pub enabled: bool,
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_repository(value: &str) -> bool {
    value.split_once('/').is_some_and(|(owner, repository)| {
        [owner, repository].into_iter().all(|part| {
            !part.is_empty()
                && part.len() <= 100
                && part.as_bytes()[0].is_ascii_alphanumeric()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    })
}

fn reviewed_library(name: &str, platform: Platform) -> bool {
    match platform {
        Platform::WindowsX86_64 => name.ends_with(".dll"),
        Platform::LinuxX86_64 => {
            name.ends_with(".so")
                || name.rsplit_once(".so.").is_some_and(|(_, version)| {
                    version
                        .split('.')
                        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                })
        }
        _ => false,
    }
}

/// Keep generic file projection inert until companion consent and recovery can
/// participate in all existing managed operations.
pub(crate) fn require_managed_custody(revision: &ProfileRevision) -> Result<()> {
    if revision.recomp_companion_sets_v1.is_some() {
        return Err(PortcoveError::unsupported(
            "Recomp companion profile revisions require complete managed custody",
        ));
    }
    Ok(())
}

/// One file-set interpretation for native ownership and retained content. Typed
/// sets keep logical NRM entries in the profile, then add their exact host files.
pub(crate) fn profile_package_files(
    revision: &ProfileRevision,
) -> Result<Vec<ProfilePackageFile<'_>>> {
    let mut files: Vec<_> = revision
        .packages
        .iter()
        .map(|package| ProfilePackageFile {
            name: &package.native_id,
            sha256: &package.sha256,
            size: package.size,
            enabled: package.enabled,
        })
        .collect();
    let Some(sets) = &revision.recomp_companion_sets_v1 else {
        return Ok(files);
    };
    if sets.is_empty()
        || sets.len() > crate::mod_package::MAX_MEMBERS
        || revision.loader.as_ref() != Some(&ModEngine::N64Recomp.reference())
        || !matches!(
            revision.build.platform,
            Platform::WindowsX86_64 | Platform::LinuxX86_64
        )
    {
        return Err(PortcoveError::verification(
            "invalid Recomp companion revision scope",
        ));
    }
    let mut names = BTreeMap::new();
    for (index, file) in files.iter().enumerate() {
        if names
            .insert(file.name.to_ascii_lowercase(), index)
            .is_some()
        {
            return Err(PortcoveError::conflict("Recomp package file names collide"));
        }
    }
    let mut owned_nrms = BTreeSet::new();
    let mut assets = BTreeSet::new();
    for set in sets {
        if set.install_id != revision.build.install_id
            || set.platform != revision.build.platform
            || !valid_repository(&set.repository)
            || [
                set.repository_id,
                set.release_id,
                set.asset_id,
                set.wrapper_size,
            ]
            .contains(&0)
            || set.wrapper_size > crate::recomp_companion_review::MAX_WRAPPER_BYTES
            || !digest(&set.wrapper_sha256)
            || !digest(&set.consent_sha256)
            || set
                .publisher_sha256
                .as_ref()
                .is_some_and(|sha| sha != &set.wrapper_sha256)
            || !assets.insert((set.repository_id, set.asset_id))
            || set.members.is_empty()
            || set.members.len() > crate::mod_package::MAX_MEMBERS
        {
            return Err(PortcoveError::verification(
                "invalid exact Recomp companion wrapper",
            ));
        }
        let mut group_names = BTreeSet::new();
        let mut enabled = None;
        let mut primary_libraries = 0;
        for (name, member) in &set.members {
            let key = name.to_ascii_lowercase();
            if !crate::profile::valid_native_id(name)
                || crate::archive::validate_relative_path(name, false).is_err()
                || !group_names.insert(key.clone())
                || !(1..=crate::recomp_companion_review::MAX_MEMBER_BYTES).contains(&member.size)
                || !digest(&member.sha256)
            {
                return Err(PortcoveError::verification(
                    "invalid exact Recomp companion member",
                ));
            }
            if member.role == RecompCompanionRole::Nrm {
                let Some(file) = names.get(&key).map(|&index| &files[index]) else {
                    return Err(PortcoveError::conflict(
                        "companion NRM has no profile package",
                    ));
                };
                if !key.ends_with(".nrm")
                    || file.name != name
                    || file.size != member.size
                    || file.sha256 != member.sha256
                    || !owned_nrms.insert(name.as_str())
                    || enabled.is_some_and(|value| value != file.enabled)
                {
                    return Err(PortcoveError::conflict(
                        "companion NRM differs from its profile or owner state",
                    ));
                }
                enabled = Some(file.enabled);
            } else {
                if !reviewed_library(&key, set.platform) {
                    return Err(PortcoveError::verification(
                        "unsupported companion library platform or name",
                    ));
                }
                primary_libraries +=
                    usize::from(member.role == RecompCompanionRole::PrimaryLibrary);
            }
        }
        let enabled = enabled.filter(|_| primary_libraries == 1).ok_or_else(|| {
            PortcoveError::verification("companion set needs NRM members and one primary library")
        })?;
        for (name, member) in set
            .members
            .iter()
            .filter(|(_, member)| member.role != RecompCompanionRole::Nrm)
        {
            let key = name.to_ascii_lowercase();
            let projected = ProfilePackageFile {
                name,
                sha256: &member.sha256,
                size: member.size,
                enabled,
            };
            if let Some(&index) = names.get(&key) {
                if files[index] != projected || index < revision.packages.len() {
                    return Err(PortcoveError::conflict(
                        "companion owners disagree on a native file",
                    ));
                }
            } else {
                names.insert(key, files.len());
                files.push(projected);
            }
        }
    }
    Ok(files)
}
