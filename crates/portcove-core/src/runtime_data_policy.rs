//! Closed version-local credentials. Never imports, decrypts or exports them.
use crate::{PortDefinition, PortcoveError, Result};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const CREDENTIAL: &str = "retroachievements.credentials";
pub(crate) fn known_artifact(sha256: &str) -> bool {
    sha256.eq_ignore_ascii_case("f77f3cc10f2dc3db56992480b6906b48bfa1fd1ef614818d039ae86293135028")
}
pub(crate) const NOTICE: &str = "Saves and settings are preserved. RetroAchievements sign-in stays with each installed version and is excluded from backups. Sign in again after installing another version.";

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    if port.runtime_data_policy.is_none() {
        if port.release.provider == crate::ReleaseSource::DirectManifest
            && port
                .release
                .direct
                .values()
                .any(|release| known_artifact(&release.sha256))
        {
            return Err(PortcoveError::usage(
                "managed RaceWave46 requires its version-local credential policy",
            ));
        }
        return Ok(());
    }
    let release = port.release.direct.get(&crate::Platform::WindowsX86_64);
    let legacy = port.runtime_data_policy == Some(crate::RuntimeDataPolicy::Racewave46V100Windows);
    if !legacy {
        crate::managed_runtime_policy::artifact(port)?;
    }
    if port.adapter != crate::AdapterKind::StagedSourcePortable
        || port.platforms != [crate::Platform::WindowsX86_64]
        || port.release.provider != crate::ReleaseSource::DirectManifest
        || !port.release.user_prepared.is_empty()
        || (legacy
            && release.is_none_or(|release| {
                release.version != "v1.0.0"
                    || release.size != 35_768_574
                    || release.sha256
                        != "f77f3cc10f2dc3db56992480b6906b48bfa1fd1ef614818d039ae86293135028"
            }))
        || port.persistent_paths != [".runtime"]
        || port.runtime_mutable_paths != ["game.z64"]
        || port.runtime_source_hashes.len() != 1
        || (legacy
            && port
                .runtime_source_hashes
                .get("game.z64")
                .map(String::as_str)
                != Some("f35d2423ebcb86eaf86fa935b613c7532b123a7bc50fb74996984c3b02fc3999"))
        || port
            .runtime_source_hashes
            .get("game.z64")
            .is_none_or(|hash| {
                hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        || !port.persistent_file_patterns.is_empty()
        || port.runtime_subdirectory.is_some()
        || !port.launch_from_install_root
        || port.source_environment.is_some()
        || port.user_data_environment.is_some()
        || !port.launch_environment.is_empty()
        || port.runtime_source_filename.as_deref() != Some("game.z64")
        || port.runtime_source_materialization
            != Some(crate::RuntimeSourceMaterialization::N64BigEndian)
        || !port.runtime_source_set.is_empty()
        || port.launch_arguments != ["game.z64", "--launch"]
        || port
            .executable_hints
            .get(&crate::Platform::WindowsX86_64)
            .is_none_or(|hints| {
                if legacy {
                    hints != &["WaveRace64Recompiled.exe"]
                } else {
                    hints.len() != 1 || !hints[0].to_ascii_lowercase().ends_with(".exe")
                }
            })
    {
        return Err(PortcoveError::usage(
            "version-local credential handling requires its reviewed Windows staged-source route and local data layout",
        ));
    }
    Ok(())
}

pub(crate) fn sensitive_name(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    if name == CREDENTIAL {
        return true;
    }
    let Some(suffix) = name.strip_prefix("retroachievements.credentials.tmp-") else {
        return false;
    };
    let parts = suffix.split('-').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 20
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u64>().is_ok()
        })
}

pub(crate) fn require_artifact(
    port: &PortDefinition,
    version: &str,
    artifact: &crate::ArtifactIdentity,
    platform: Option<crate::Platform>,
) -> Result<()> {
    validate(port)?;
    if port.runtime_data_policy == Some(crate::RuntimeDataPolicy::VersionLocalRetroAchievementsV1) {
        return crate::managed_runtime_policy::require_artifact(port, version, artifact, platform);
    }
    if (port.runtime_data_policy.is_some() || known_artifact(&artifact.sha256))
        && (port.runtime_data_policy.is_none()
            || platform != Some(crate::Platform::WindowsX86_64)
            || version != "v1.0.0"
            || artifact.asset_name != "RaceWave46-Windows-x64-v1.0.0.zip"
            || artifact.size != 35_768_574
            || artifact.sha256
                != "f77f3cc10f2dc3db56992480b6906b48bfa1fd1ef614818d039ae86293135028")
    {
        return Err(PortcoveError::verification(
            "version-local credential handling requires the actual reviewed RaceWave46 Windows installation; install the official package through Portcove",
        ));
    }
    Ok(())
}

pub(crate) fn refuse_adoption(port: &PortDefinition) -> Result<()> {
    if port.runtime_data_policy.is_some() {
        return Err(PortcoveError::unsupported(
            "this port's sign-in handling requires its exact official package; use managed installation instead of copying a folder. Existing external registrations remain separate",
        ));
    }
    Ok(())
}

fn held(path: &Path) -> PortcoveError {
    PortcoveError::unsupported(
        "saved RetroAchievements sign-in cannot be copied, hashed, backed up or transferred",
    )
    .detail("host_local_credential_path", path.display().to_string())
    .with_known_cause(crate::failure::KnownFailureCause::HostLocalCredential {
        path: path.to_path_buf(),
    })
}

/// Conservative refusal only: no catalog or journal can authorize reading a
/// known credential leaf as ordinary transferable data. Check before metadata
/// descent, reads or destination verification, including directories and links.
pub(crate) fn refuse_sensitive_entry(path: &Path) -> Result<()> {
    if path
        .components()
        .any(|part| sensitive_name(part.as_os_str()))
    {
        return Err(held(path));
    }
    Ok(())
}

/// Metadata-only preflight, so an ordinary hard-link alias encountered before a
/// credential name cannot be hashed first. Final leaf guards remain necessary.
pub(crate) fn refuse_sensitive_tree(root: &Path) -> Result<()> {
    refuse_sensitive_entry(root)?;
    crate::path::refuse_symlink_ancestors(root)?;
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_dir() => return Ok(()),
        Ok(_) => {}
    }
    let mut pending = vec![(root.to_path_buf(), 0_u32)];
    let mut count = 0_u32;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 64 {
            return Err(PortcoveError::unsupported(
                "credential-safe data scan depth limit reached",
            ));
        }
        crate::path::refuse_symlink_ancestors(&directory)?;
        for entry in fs::read_dir(&directory)? {
            count += 1;
            if count > 65_536 {
                return Err(PortcoveError::unsupported(
                    "credential-safe data scan entry limit reached",
                ));
            }
            let entry = entry?;
            let path = entry.path();
            refuse_sensitive_entry(&path)?;
            // Existing copy owners decide how unrelated links are treated. This
            // preflight never follows them or turns them into accepted entries.
            if entry.file_type()?.is_dir() && !entry.file_type()?.is_symlink() {
                pending.push((path, depth + 1));
            }
        }
    }
    Ok(())
}

pub(crate) fn notices(port: &PortDefinition) -> Vec<String> {
    if port.runtime_data_policy.is_some() {
        vec![NOTICE.into()]
    } else {
        Vec::new()
    }
}

impl PortDefinition {
    /// Preservation limits for players, shared by plans and maintained clients.
    pub fn preservation_notices(&self) -> Vec<String> {
        notices(self)
    }
}

/// Copy through a checked source handle and private replacement. An alias must
/// never cause a credential read or an in-place write to a different file.
pub(crate) fn copy_ordinary_file(source: &Path, destination: &Path) -> Result<()> {
    refuse_sensitive_entry(source)?;
    refuse_sensitive_entry(destination)?;
    crate::path::refuse_symlink_ancestors(destination)?;
    let mut input = crate::external_runtime::open_single_link_file(source)?;
    let before = input.metadata()?;
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("copy target has no parent"))?;
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > before.len() {
            return Err(PortcoveError::conflict("copy source grew during reading"));
        }
        output.write_all(&buffer[..count])?;
    }
    if total != before.len() || input.metadata()?.modified()? != before.modified()? {
        return Err(PortcoveError::conflict(
            "copy source changed during reading",
        ));
    }
    output.as_file().set_permissions(before.permissions())?;
    output.as_file().sync_all()?;
    crate::path::refuse_symlink_ancestors(destination)?;
    output
        .persist(destination)
        .map_err(|error| PortcoveError::from(error.error))?;
    crate::durability::sync_publication(parent)
}

pub(crate) fn check_launch(
    port: &PortDefinition,
    working: &Path,
    canonical: &Path,
    arguments: &[String],
) -> Result<()> {
    validate(port)?;
    if port.runtime_data_policy.is_none() {
        return Ok(());
    }
    if arguments != ["game.z64", "--launch"] {
        return Err(PortcoveError::verification(
            "RaceWave46 requires its reviewed fixed launch arguments",
        ));
    }
    refuse_sensitive_tree(canonical)?;
    validate_runtime_names(&working.join(".runtime"))
}

/// The sole omission path. The caller supplies the retained persistence contract
/// and canonical user root. Canonical contamination refuses before any mirror.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CanonicalSide {
    Source,
    Destination,
}

pub(crate) fn mirror(
    port: &PortDefinition,
    source: &Path,
    destination: &Path,
    canonical: &Path,
    side: CanonicalSide,
) -> Result<()> {
    validate(port)?;
    if port.runtime_data_policy.is_none() {
        return Err(PortcoveError::state(
            "credential omission has no retained runtime policy",
        ));
    }
    refuse_sensitive_tree(canonical)?;
    validate_runtime_names(source)?;
    validate_runtime_names(destination)?;
    mirror_entry(source, destination, side, 0, &mut 65_536)
}

fn refuse_existing_sensitive_entry(path: &Path) -> Result<()> {
    if refuse_sensitive_entry(path).is_ok() {
        return Ok(());
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(held(path)),
    }
}

fn validate_runtime_names(root: &Path) -> Result<()> {
    crate::path::refuse_symlink_ancestors(root)?;
    if !root.try_exists()? {
        return Ok(());
    }
    let mut pending = vec![(root.to_path_buf(), 0_u32)];
    let mut count = 0_u32;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 64 {
            return Err(PortcoveError::unsupported(
                "runtime data depth limit reached",
            ));
        }
        crate::path::refuse_symlink_ancestors(&directory)?;
        if !fs::symlink_metadata(&directory)?.is_dir() {
            return Err(PortcoveError::verification(
                "runtime data must be a real directory",
            ));
        }
        let mut seen = std::collections::BTreeSet::new();
        for entry in fs::read_dir(&directory)? {
            count += 1;
            if count > 65_536 {
                return Err(PortcoveError::unsupported(
                    "runtime data entry limit reached",
                ));
            }
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name();
            let text = name
                .to_str()
                .ok_or_else(|| PortcoveError::unsupported("runtime data names must be Unicode"))?;
            let (_, key) =
                crate::archive::validate_relative_path(text, entry.file_type()?.is_dir())?;
            if !seen.insert(key) {
                return Err(PortcoveError::verification(
                    "runtime data has case-colliding names",
                ));
            }
            if sensitive_name(&name) {
                if !entry.file_type()?.is_file() {
                    return Err(held(&path));
                }
                crate::path::refuse_symlink_ancestors(&path).map_err(|_| held(&path))?;
                continue;
            }
            crate::path::refuse_symlink_ancestors(&path)?;
            if entry.file_type()?.is_dir() {
                pending.push((path, depth + 1));
            } else if !entry.file_type()?.is_file() {
                return Err(PortcoveError::verification(
                    "runtime data contains a special entry",
                ));
            }
        }
    }
    Ok(())
}

fn charge(remaining: &mut u32) -> Result<()> {
    *remaining = remaining
        .checked_sub(1)
        .ok_or_else(|| PortcoveError::unsupported("runtime data mutation entry limit reached"))?;
    Ok(())
}

fn mirror_entry(
    source: &Path,
    destination: &Path,
    side: CanonicalSide,
    depth: u32,
    remaining: &mut u32,
) -> Result<()> {
    charge(remaining)?;
    match side {
        CanonicalSide::Source => refuse_existing_sensitive_entry(source)?,
        CanonicalSide::Destination => refuse_existing_sensitive_entry(destination)?,
    }
    if source.file_name().is_some_and(sensitive_name)
        || destination.file_name().is_some_and(sensitive_name)
    {
        return Ok(());
    }
    if depth > 64 {
        return Err(PortcoveError::unsupported(
            "runtime data mirror depth limit reached",
        ));
    }
    crate::path::refuse_symlink_ancestors(source)?;
    crate::path::refuse_symlink_ancestors(destination)?;
    let source_metadata = match fs::symlink_metadata(source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
        Ok(metadata) => Some(metadata),
    };
    if let Some(metadata) = &source_metadata
        && metadata.is_file()
    {
        if destination.try_exists()? && !fs::symlink_metadata(destination)?.is_file() {
            prune(
                destination,
                side == CanonicalSide::Destination,
                depth + 1,
                remaining,
            )?;
            if destination.try_exists()? {
                return Err(PortcoveError::conflict(
                    "version-local credentials prevent replacing this directory",
                ));
            }
        }
        let parent = destination
            .parent()
            .ok_or_else(|| PortcoveError::state("runtime data target has no parent"))?;
        fs::create_dir_all(parent)?;
        let mut input = crate::external_runtime::open_single_link_file(source)?;
        let before = input.metadata()?;
        let mut output = tempfile::NamedTempFile::new_in(parent)?;
        let mut total = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > before.len() {
                return Err(PortcoveError::conflict(
                    "runtime data grew during collection",
                ));
            }
            output.write_all(&buffer[..count])?;
        }
        if total != before.len() || input.metadata()?.modified()? != before.modified()? {
            return Err(PortcoveError::conflict(
                "runtime data changed during collection",
            ));
        }
        output.as_file().sync_all()?;
        crate::path::refuse_symlink_ancestors(destination)?;
        output
            .persist(destination)
            .map_err(|error| PortcoveError::from(error.error))?;
        return crate::durability::sync_publication(parent);
    }
    if source_metadata
        .as_ref()
        .is_some_and(|metadata| !metadata.is_dir())
    {
        return Err(PortcoveError::verification(
            "runtime data contains a special entry",
        ));
    }
    if source_metadata.is_none() {
        return prune(
            destination,
            side == CanonicalSide::Destination,
            depth + 1,
            remaining,
        );
    }
    if destination.try_exists()? && !fs::symlink_metadata(destination)?.is_dir() {
        fs::remove_file(destination)?;
    }
    fs::create_dir_all(destination)?;
    for (count, entry) in fs::read_dir(source)?.enumerate() {
        if count >= 65_536 {
            return Err(PortcoveError::unsupported(
                "runtime data mirror entry limit reached",
            ));
        }
        let entry = entry?;
        mirror_entry(
            &entry.path(),
            &destination.join(entry.file_name()),
            side,
            depth + 1,
            remaining,
        )?;
    }
    for (count, entry) in fs::read_dir(destination)?.enumerate() {
        if count >= 65_536 {
            return Err(PortcoveError::unsupported(
                "runtime data mirror entry limit reached",
            ));
        }
        let entry = entry?;
        if sensitive_name(&entry.file_name()) {
            if side == CanonicalSide::Destination {
                return Err(held(&entry.path()));
            }
            continue;
        }
        charge(remaining)?;
        if !source.join(entry.file_name()).try_exists()? {
            prune(
                &entry.path(),
                side == CanonicalSide::Destination,
                depth + 1,
                remaining,
            )?;
        }
    }
    Ok(())
}

fn prune(path: &Path, canonical: bool, depth: u32, remaining: &mut u32) -> Result<()> {
    charge(remaining)?;
    if canonical {
        refuse_sensitive_entry(path)?;
    }
    if path.file_name().is_some_and(sensitive_name) {
        return Ok(());
    }
    if depth > 64 {
        return Err(PortcoveError::unsupported(
            "runtime data pruning depth limit reached",
        ));
    }
    crate::path::refuse_symlink_ancestors(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(metadata) => metadata,
    };
    if metadata.is_dir() {
        for (count, entry) in fs::read_dir(path)?.enumerate() {
            if count >= 65_536 {
                return Err(PortcoveError::unsupported(
                    "runtime data pruning entry limit reached",
                ));
            }
            prune(&entry?.path(), canonical, depth + 1, remaining)?;
        }
        // A directory containing version-local credentials must stay intact.
        if fs::read_dir(path)?.next().is_none() {
            fs::remove_dir(path)?;
        }
    } else if metadata.is_file() {
        fs::remove_file(path)?;
    } else {
        return Err(PortcoveError::verification(
            "runtime data pruning found a special entry",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port() -> PortDefinition {
        crate::Catalog::embedded()
            .unwrap()
            .port("wave-race-64-racewave46")
            .unwrap()
            .clone()
    }

    #[test]
    fn uppercase_known_digest_cannot_drop_the_credential_policy() {
        let mut definition = port();
        definition.runtime_data_policy = None;
        definition
            .release
            .direct
            .get_mut(&crate::Platform::WindowsX86_64)
            .unwrap()
            .sha256
            .make_ascii_uppercase();
        assert!(
            validate(&definition)
                .unwrap_err()
                .message
                .contains("requires its version-local credential policy")
        );
        let historical = crate::Catalog::from_json(include_str!(
            "../tests/fixtures/racewave46-100-prepared-historical.json"
        ))
        .unwrap();
        let no_policy = historical.port(&definition.id).unwrap();
        assert!(
            require_artifact(
                no_policy,
                "v1.0.0",
                &crate::ArtifactIdentity {
                    asset_name: "RaceWave46-Windows-x64-v1.0.0.zip".into(),
                    size: 35_768_574,
                    sha256: "f77f3cc10f2dc3db56992480b6906b48bfa1fd1ef614818d039ae86293135028"
                        .to_uppercase(),
                },
                Some(crate::Platform::WindowsX86_64)
            )
            .unwrap_err()
            .message
            .contains("actual reviewed")
        );
    }

    #[test]
    fn installed_policy_requires_actual_artifact_version_platform_and_no_adoption() {
        let port = port();
        let artifact = crate::ArtifactIdentity {
            asset_name: "RaceWave46-Windows-x64-v1.0.0.zip".into(),
            size: 35_768_574,
            sha256: "f77f3cc10f2dc3db56992480b6906b48bfa1fd1ef614818d039ae86293135028".into(),
        };
        require_artifact(
            &port,
            "v1.0.0",
            &artifact,
            Some(crate::Platform::WindowsX86_64),
        )
        .unwrap();
        assert!(
            require_artifact(
                &port,
                "v1.0.1",
                &artifact,
                Some(crate::Platform::WindowsX86_64)
            )
            .is_err()
        );
        assert!(
            require_artifact(
                &port,
                "v1.0.0",
                &artifact,
                Some(crate::Platform::LinuxX86_64)
            )
            .is_err()
        );
        assert!(
            require_artifact(
                &port,
                "v1.0.0",
                &crate::ArtifactIdentity {
                    asset_name: "local-adoption".into(),
                    sha256: "0".repeat(64),
                    ..artifact
                },
                Some(crate::Platform::WindowsX86_64)
            )
            .is_err()
        );
        let temp = tempfile::tempdir().unwrap();
        let library = crate::Library::open(temp.path().join("library")).unwrap();
        let service = crate::PortcoveService::new(library).unwrap();
        let external = temp.path().join("external");
        fs::create_dir_all(&external).unwrap();
        fs::write(
            external.join("WaveRace64Recompiled.exe"),
            b"arbitrary executable",
        )
        .unwrap();
        let policy_error = refuse_adoption(&port).unwrap_err();
        assert!(policy_error.message.contains("exact official package"));
        let preview_error = service
            .preview_adoption(&external, Some(&port.id))
            .unwrap_err();
        if crate::Platform::current().unwrap() == crate::Platform::WindowsX86_64 {
            assert_eq!(preview_error.code, policy_error.code);
            assert_eq!(preview_error.message, policy_error.message);
        } else {
            // The real service refuses the Windows-only executable projection
            // before adoption policy on other hosts. Both refusals stay covered.
            assert_eq!(preview_error.code, crate::ErrorCode::Verification);
            assert!(preview_error.message.contains("no declared executable"));
        }
        assert!(
            service
                .adopt(&external, Some(&port.id), "ungranted")
                .is_err()
        );
        assert_eq!(
            fs::read(external.join("WaveRace64Recompiled.exe")).unwrap(),
            b"arbitrary executable"
        );
    }

    #[test]
    fn legacy_manifest_cannot_inherit_current_credential_omission_policy() {
        use sha2::{Digest, Sha256};
        let temp = tempfile::tempdir().unwrap();
        let library = crate::Library::open(temp.path().join("library")).unwrap();
        let historical = crate::Catalog::from_json(include_str!(
            "../tests/fixtures/racewave46-100-prepared-historical.json"
        ))
        .unwrap();
        let id = "wave-race-64-racewave46";
        let root = library.versions_dir().join(id).join("legacy");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("WaveRace64Recompiled.exe"),
            b"synthetic legacy executable",
        )
        .unwrap();
        let artifact = crate::ArtifactIdentity {
            asset_name: "local-adoption".into(),
            sha256: "a".repeat(64),
            size: 4,
        };
        let qualification = crate::InstallQualification::from_catalog(
            &historical,
            id,
            crate::Platform::WindowsX86_64,
        )
        .unwrap();
        let (_, selected_executable, runtime) = crate::Installer::new(library.clone())
            .unwrap()
            .create_manifest(
                "legacy-racewave",
                id,
                "legacy",
                &artifact,
                &qualification,
                &root,
            )
            .unwrap();
        let path = root.join(".portcove-manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest["schema_version"] = serde_json::json!(5);
        manifest
            .as_object_mut()
            .unwrap()
            .remove("retained_contract");
        let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        fs::write(&path, &bytes).unwrap();
        let install = crate::InstallRecord {
            id: "legacy-racewave".into(),
            port_id: id.into(),
            version: "legacy".into(),
            path: root.clone(),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact,
            manifest_sha256: hex::encode(Sha256::digest(&bytes)),
            selected_executable,
            runtime,
        };
        assert!(
            crate::Installer::new(library.clone())
                .unwrap()
                .retained_catalog(&install)
                .unwrap()
                .is_none()
        );
        library.register_install(&install, true).unwrap();
        fs::create_dir(root.join(".runtime")).unwrap();
        fs::write(root.join(".runtime").join(CREDENTIAL), b"synthetic").unwrap();
        let service = crate::PortcoveService::new(library.clone()).unwrap();
        assert!(
            service
                .installed_catalog(&install)
                .unwrap_err()
                .message
                .contains("legacy installation")
        );
        assert!(service.collect_user_data(id).is_err());
        assert!(root.join(".runtime").join(CREDENTIAL).exists());
        assert!(
            !library
                .user_dir(id)
                .join(".runtime")
                .join(CREDENTIAL)
                .exists()
        );
    }

    #[test]
    fn reserved_credentials_match_only_exact_upstream_names() {
        for name in [
            CREDENTIAL,
            "RETROACHIEVEMENTS.CREDENTIALS",
            "retroachievements.credentials.tmp-1-23-456",
        ] {
            assert!(sensitive_name(name.as_ref()), "{name}");
        }
        for name in [
            "credentials",
            "retroachievements.credentials.bak",
            "retroachievements.credentials.tmp-1-2",
            "retroachievements.credentials.tmp-1-2-3-4",
            "retroachievements.credentials.tmp-1-x-3",
            "retroachievements.credentials.tmp-1-2-",
            "retroachievements.credentials.tmp-18446744073709551616-1-2",
        ] {
            assert!(!sensitive_name(name.as_ref()), "{name}");
        }
    }

    #[test]
    fn final_mirror_and_prune_refuse_canonical_credential_injection() {
        let temp = tempfile::tempdir().unwrap();
        let canonical = temp.path().join("canonical");
        let path = canonical.join(CREDENTIAL);
        fs::create_dir_all(&canonical).unwrap();
        fs::write(&path, b"synthetic").unwrap();
        assert!(
            mirror_entry(
                &temp.path().join("version").join(CREDENTIAL),
                &path,
                CanonicalSide::Destination,
                0,
                &mut 10
            )
            .is_err()
        );
        assert!(prune(&path, true, 0, &mut 10).is_err());
        assert!(path.exists());
    }

    #[test]
    fn generic_copy_and_hash_refuse_hard_link_alias_before_reading() {
        let temp = tempfile::tempdir().unwrap();
        let credential = temp.path().join(CREDENTIAL);
        let alias = temp.path().join("ordinary.bin");
        fs::write(&credential, b"synthetic").unwrap();
        fs::hard_link(&credential, &alias).unwrap();
        assert!(crate::service::sha256_file(&alias).is_err());
        assert!(copy_ordinary_file(&alias, &temp.path().join("copy.bin")).is_err());
        assert!(!temp.path().join("copy.bin").exists());
    }

    #[cfg(windows)]
    #[test]
    fn ordinary_windows_paths_open_and_locked_credentials_are_never_read_by_mirror() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let version = temp.path().join("version/.runtime");
        let canonical = temp.path().join("canonical");
        fs::create_dir_all(&version).unwrap();
        let ordinary = version.join("save.bin");
        fs::write(&ordinary, b"save").unwrap();
        let spelling = ordinary
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_owned();
        let mut handle =
            crate::external_runtime::open_single_link_file(Path::new(&spelling)).unwrap();
        let mut bytes = Vec::new();
        handle.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"save");
        let credential = version.join(CREDENTIAL);
        fs::write(&credential, b"synthetic").unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&credential)
            .unwrap();
        mirror(
            &port(),
            &version,
            &canonical.join(".runtime"),
            &canonical,
            CanonicalSide::Destination,
        )
        .unwrap();
        assert!(!canonical.join(".runtime").join(CREDENTIAL).exists());
        drop(locked);
    }

    #[test]
    fn mirror_keeps_credentials_version_local_in_both_directions_and_pruning() {
        let temp = tempfile::tempdir().unwrap();
        let version = temp.path().join("version/.runtime");
        let canonical = temp.path().join("canonical");
        let saved = canonical.join(".runtime");
        fs::create_dir_all(&version).unwrap();
        fs::write(version.join(CREDENTIAL), b"synthetic-host-local-no-account").unwrap();
        fs::write(
            version.join("retroachievements.credentials.tmp-12-34-56"),
            b"synthetic-temp",
        )
        .unwrap();
        fs::write(version.join("save.bin"), b"first-save").unwrap();
        mirror(
            &port(),
            &version,
            &saved,
            &canonical,
            CanonicalSide::Destination,
        )
        .unwrap();
        assert_eq!(fs::read(saved.join("save.bin")).unwrap(), b"first-save");
        assert!(!saved.join(CREDENTIAL).exists());
        assert!(
            !saved
                .join("retroachievements.credentials.tmp-12-34-56")
                .exists()
        );
        fs::write(saved.join("save.bin"), b"restored-save").unwrap();
        fs::write(version.join("obsolete.bin"), b"obsolete").unwrap();
        mirror(&port(), &saved, &version, &canonical, CanonicalSide::Source).unwrap();
        assert_eq!(
            fs::read(version.join("save.bin")).unwrap(),
            b"restored-save"
        );
        assert!(!version.join("obsolete.bin").exists());
        assert_eq!(
            fs::read(version.join(CREDENTIAL)).unwrap(),
            b"synthetic-host-local-no-account"
        );
        fs::remove_dir_all(&saved).unwrap();
        mirror(&port(), &saved, &version, &canonical, CanonicalSide::Source).unwrap();
        assert!(!version.join("save.bin").exists());
        assert!(version.join(CREDENTIAL).exists());
        assert!(
            version
                .join("retroachievements.credentials.tmp-12-34-56")
                .exists()
        );
    }

    #[test]
    fn canonical_and_destination_contamination_refuse_without_copying() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("save.bin"), b"save").unwrap();
        fs::write(target.join(CREDENTIAL), b"synthetic").unwrap();
        assert!(crate::service::copy_tree(&source, &target).is_err());
        assert!(!target.join("save.bin").exists());
        assert!(
            mirror(
                &port(),
                &source,
                &target,
                &target,
                CanonicalSide::Destination
            )
            .is_err()
        );
        fs::remove_file(target.join(CREDENTIAL)).unwrap();
        fs::create_dir(target.join(CREDENTIAL)).unwrap();
        assert!(refuse_sensitive_tree(&target).is_err());
        assert!(!target.join("save.bin").exists());
    }

    #[test]
    fn closed_policy_cannot_be_removed_or_attached_to_different_bytes() {
        let mut p = port();
        validate(&p).unwrap();
        p.runtime_data_policy = None;
        assert!(validate(&p).is_err());
        p.runtime_data_policy = Some(crate::RuntimeDataPolicy::Racewave46V100Windows);
        p.release
            .direct
            .get_mut(&crate::Platform::WindowsX86_64)
            .unwrap()
            .sha256 = "0".repeat(64);
        assert!(validate(&p).is_err());
        let old = crate::Catalog::from_json(include_str!(
            "../tests/fixtures/racewave46-100-prepared-historical.json"
        ))
        .unwrap();
        validate(old.port("wave-race-64-racewave46").unwrap()).unwrap();
    }
}
