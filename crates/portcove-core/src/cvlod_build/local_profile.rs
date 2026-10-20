//! The one reviewed installed VC/Windows SDK profile for this recipe.
//! Host files are inputs only; every build uses authenticated private copies.
use super::super::{FileIdentity, digest, inventory};
use crate::{PortcoveError, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) const ID: &str = "cvlod-vc1444-sdk19041-x64-v1";
const MANIFEST: &str = include_str!("local-profile.json");
const VC: &str =
    "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/14.44.35207";
const SDK: &str = "C:/Program Files (x86)/Windows Kits/10";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    format_version: u32,
    id: String,
    msvc_version: String,
    windows_sdk_version: String,
    groups: Vec<Group>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Group {
    id: String,
    files: Vec<FileIdentity>,
}

fn group_roots() -> [(&'static str, PathBuf); 7] {
    [
        ("vc-include", Path::new(VC).join("include")),
        ("vc-lib", Path::new(VC).join("lib/x64")),
        ("vc-tools", Path::new(VC).join("bin/Hostx64/x64")),
        ("sdk-include", Path::new(SDK).join("Include/10.0.19041.0")),
        ("sdk-um-lib", Path::new(SDK).join("Lib/10.0.19041.0/um/x64")),
        (
            "sdk-ucrt-lib",
            Path::new(SDK).join("Lib/10.0.19041.0/ucrt/x64"),
        ),
        ("sdk-tools", Path::new(SDK).join("bin/10.0.19041.0/x64")),
    ]
}

fn manifest() -> Result<Profile> {
    let profile: Profile = serde_json::from_str(MANIFEST)?;
    if profile.format_version != 1
        || profile.id != ID
        || profile.msvc_version != "14.44.35207"
        || profile.windows_sdk_version != "10.0.19041.0"
        || profile.groups.len() != 7
    {
        return Err(PortcoveError::verification(
            "CVLoD local toolchain profile differs",
        ));
    }
    let mut count = 0usize;
    let mut bytes = 0u64;
    for (group, (id, _)) in profile.groups.iter().zip(group_roots()) {
        if group.id != id || group.files.is_empty() {
            return Err(PortcoveError::verification(
                "CVLoD local toolchain group differs",
            ));
        }
        let mut names = std::collections::BTreeSet::new();
        let mut prior: Option<&str> = None;
        for file in &group.files {
            crate::archive::validate_relative_path(&file.path, false)?;
            if !file.path.is_ascii()
                || file.path.split('/').count() > 24
                || file.size > 256 * 1024 * 1024
                || file.sha256.len() != 64
                || !file
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                || !names.insert(file.path.to_ascii_lowercase())
                || prior.is_some_and(|p| p >= file.path.as_str())
            {
                return Err(PortcoveError::verification(
                    "CVLoD local toolchain file contract differs",
                ));
            }
            prior = Some(&file.path);
            count += 1;
            bytes = bytes
                .checked_add(file.size)
                .ok_or_else(|| PortcoveError::verification("local toolchain size overflow"))?;
        }
    }
    if count != 5620 || bytes != 908_357_067 {
        return Err(PortcoveError::verification(
            "CVLoD local toolchain closure differs",
        ));
    }
    Ok(profile)
}

pub(super) fn identity() -> String {
    digest(MANIFEST.as_bytes())
}

fn unavailable(error: impl std::fmt::Display) -> PortcoveError {
    PortcoveError::unsupported("CVLoD source builds require the reviewed Visual Studio 2022 Build Tools 14.44.35207 and Windows SDK 10.0.19041.0 x64 profile at their standard C: locations; install those components before retrying")
        .detail("profile", ID)
        .detail("reason", error.to_string())
}

/// Read-only prerequisite check. Never called as an installed-runtime launch gate.
pub(super) fn require_available(checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
    inspect_available(checkpoint, true)
}

pub(super) fn require_present(checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
    inspect_available(checkpoint, false)
}

fn inspect_available(checkpoint: &dyn Fn() -> Result<()>, authenticate: bool) -> Result<()> {
    for (group, (_, root)) in manifest()?.groups.iter().zip(group_roots()) {
        for expected in &group.files {
            checkpoint()?;
            let path = root.join(&expected.path);
            crate::path::refuse_symlink_ancestors(&path).map_err(unavailable)?;
            let file = fs::File::open(&path).map_err(unavailable)?;
            let metadata = file.metadata().map_err(unavailable)?;
            if !metadata.is_file()
                || metadata.len() != expected.size
                || crate::external_runtime::link_count(&file).map_err(unavailable)? != 1
            {
                return Err(unavailable(format!(
                    "{} is missing or not a single regular input",
                    expected.path
                )));
            }
            if authenticate {
                let (sha, size) = crate::adapter::hash_file_bounded_with_checkpoint(
                    &path,
                    expected.size,
                    checkpoint,
                )?;
                if sha != expected.sha256 || size != expected.size {
                    return Err(unavailable(format!(
                        "{} differs from the reviewed profile",
                        expected.path
                    )));
                }
            }
        }
    }
    checkpoint()
}

/// Copy only manifest members. Unlisted host DLLs, headers and libraries cannot
/// shadow the private closure, and pre-existing destinations are never reused.
pub(super) fn copy_into(work: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<PathBuf> {
    let profile = manifest()?;
    let destination = work.join("local-toolchain");
    crate::path::refuse_symlink_ancestors(&destination)?;
    fs::create_dir(&destination)?;
    let mut directory_count = 1usize;
    for (group, (_, root)) in profile.groups.iter().zip(group_roots()) {
        let target = destination.join(&group.id);
        fs::create_dir(&target)?;
        directory_count += 1;
        let mut directories = std::collections::BTreeSet::new();
        for expected in &group.files {
            checkpoint()?;
            let source = root.join(&expected.path);
            let relative = Path::new(&expected.path);
            let parents: Vec<_> = relative
                .ancestors()
                .skip(1)
                .filter(|p| !p.as_os_str().is_empty())
                .collect();
            for parent in parents.into_iter().rev() {
                if directories.insert(parent.to_path_buf()) {
                    directory_count += 1;
                    if directory_count > 20_000 {
                        return Err(PortcoveError::verification(
                            "private local toolchain exceeds directory bound",
                        ));
                    }
                    fs::create_dir(target.join(parent))?;
                }
            }
            let output_path = target.join(relative);
            copy_member(&source, &output_path, expected, checkpoint)?;
        }
        if inventory(&target, checkpoint)? != group.files {
            return Err(PortcoveError::verification(
                "private local toolchain contains unexpected inputs",
            ));
        }
    }
    checkpoint()?;
    Ok(destination)
}

pub(super) fn copy_member(
    source: &Path,
    output_path: &Path,
    expected: &FileIdentity,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(source).map_err(copy_failure)?;
    let mut input = fs::File::open(source).map_err(copy_failure)?;
    let metadata = input.metadata().map_err(copy_failure)?;
    if !metadata.is_file()
        || metadata.len() != expected.size
        || expected.size > 256 * 1024 * 1024
        || crate::external_runtime::link_count(&input).map_err(copy_failure)? != 1
    {
        return Err(copy_failure(
            "input is not a single regular file with the exact manifest size",
        ));
    }
    crate::path::refuse_symlink_ancestors(output_path)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output_path)?;
    let mut hash = Sha256::new();
    let mut remaining = expected.size;
    let mut buffer = vec![0u8; 1024 * 1024];
    while remaining != 0 {
        checkpoint()?;
        let limit = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| PortcoveError::verification("local toolchain chunk overflow"))?;
        let read = input.read(&mut buffer[..limit])?;
        if read == 0 {
            return Err(copy_failure("input shortened during copy"));
        }
        hash.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    if input.read(&mut buffer[..1])? != 0 || hex::encode(hash.finalize()) != expected.sha256 {
        return Err(copy_failure("input changed during copy"));
    }
    output.sync_all()?;
    let (sha, size) =
        crate::adapter::hash_file_bounded_with_checkpoint(output_path, expected.size, checkpoint)?;
    if sha != expected.sha256 || size != expected.size {
        return Err(PortcoveError::verification(
            "private local toolchain copy differs",
        ));
    }
    checkpoint()
}

fn copy_failure(error: impl std::fmt::Display) -> PortcoveError {
    PortcoveError::verification("CVLoD private toolchain copy failed")
        .detail("cause", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cvlod_local_copy_requires_exact_single_link_bytes_and_never_replaces_outputs() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("input");
        let output = temp.path().join("output");
        fs::write(&source, b"reviewed input").unwrap();
        let expected = FileIdentity {
            path: "input".into(),
            size: 14,
            sha256: digest(b"reviewed input"),
        };
        copy_member(&source, &output, &expected, &|| Ok(())).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"reviewed input");
        assert!(copy_member(&source, &output, &expected, &|| Ok(())).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"reviewed input");
        let mut wrong = expected.clone();
        wrong.sha256 = "0".repeat(64);
        assert!(copy_member(&source, &temp.path().join("wrong"), &wrong, &|| Ok(())).is_err());
        assert!(
            copy_member(&source, &temp.path().join("cancelled"), &expected, &|| Err(
                PortcoveError::new(crate::ErrorCode::Cancelled, "fixture")
            ))
            .is_err()
        );
        assert!(!temp.path().join("cancelled").exists());
        fs::hard_link(&source, temp.path().join("other-link")).unwrap();
        assert!(copy_member(&source, &temp.path().join("linked"), &expected, &|| Ok(())).is_err());
        assert!(!temp.path().join("linked").exists());
    }
}

pub(super) fn verify_private(root: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
    for group in manifest()?.groups {
        if inventory(&root.join(group.id), checkpoint)? != group.files {
            return Err(PortcoveError::verification(
                "private local toolchain changed",
            ));
        }
    }
    checkpoint()
}
