//! Immutable runtime dependencies share the game's installation transaction and lifetime.
use std::path::{Path, PathBuf};

use crate::{
    ArtifactIdentity, BundledRuntime, InstallRecord, Platform, PortDefinition, PortcoveError,
    Result, RuntimeIdentity, RuntimeOrigin,
};

impl BundledRuntime {
    pub(crate) fn identity(&self) -> RuntimeIdentity {
        RuntimeIdentity {
            origin: RuntimeOrigin::VerifiedDownload,
            artifact: ArtifactIdentity {
                asset_name: self.asset.name.clone(),
                sha256: self.asset.sha256.to_ascii_lowercase(),
                size: self.asset.size,
            },
            archive_root: self.archive_root.clone(),
            target_directory: self.target_directory.clone(),
            executable: self.executable.clone(),
        }
    }

    pub(crate) fn same_layout(&self, identity: &RuntimeIdentity) -> bool {
        self.target_directory == identity.target_directory && self.executable == identity.executable
    }
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    if port.bundled_runtime.is_empty() {
        return Ok(());
    }
    if port.bundled_runtime.len() != port.platforms.len()
        || port
            .platforms
            .iter()
            .any(|platform| !port.bundled_runtime.contains_key(platform))
    {
        return Err(PortcoveError::usage(
            "a bundled runtime must cover every declared platform",
        ));
    }
    if let Some(directory) = &port.runtime_subdirectory {
        crate::archive::validate_relative_path(directory, true)?;
    }
    for runtime in port.bundled_runtime.values() {
        for path in [
            &runtime.archive_root,
            &runtime.target_directory,
            &runtime.executable,
        ] {
            crate::archive::validate_relative_path(path, false)?;
        }
        if runtime.target_directory.contains('/') {
            return Err(PortcoveError::usage(
                "bundled runtime must occupy one directory in the game working directory",
            ));
        }
        let url = reqwest::Url::parse(&runtime.asset.url)
            .map_err(|_| PortcoveError::usage("runtime URL is invalid"))?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || runtime.asset.name.is_empty()
            || runtime.asset.sha256.len() != 64
            || !runtime
                .asset
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || runtime.asset.size == 0
        {
            return Err(PortcoveError::usage(
                "runtime requires a pinned HTTPS archive, SHA-256, and size",
            ));
        }
        crate::archive::validate_download_progress(0, runtime.asset.size)?;
        if port
            .persistent_paths
            .iter()
            .chain(port.runtime_source_filename.iter())
            .chain(port.setup_marker.iter())
            .any(|mutable| overlaps(mutable, &runtime.target_directory))
            || port
                .persistent_file_patterns
                .iter()
                .any(|pattern| pattern.matches(&runtime.target_directory))
            || port
                .runtime_source_set
                .iter()
                .any(|source| overlaps(&source.destination, &runtime.target_directory))
        {
            return Err(PortcoveError::usage(
                "bundled runtime overlaps persistent data",
            ));
        }
    }
    Ok(())
}

pub(crate) fn require_vacant(parent: &Path, target: &str) -> Result<()> {
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name();
        if crate::path::unicode(Path::new(&name), "runtime sibling")?.eq_ignore_ascii_case(target) {
            return Err(PortcoveError::verification(
                "game payload collides with its bundled runtime",
            ));
        }
    }
    Ok(())
}

pub(crate) fn overlaps(left: &str, right: &str) -> bool {
    let left = left.replace('\\', "/").to_lowercase();
    let right = right.replace('\\', "/").to_lowercase();
    left == right
        || left.starts_with(&format!("{right}/"))
        || right.starts_with(&format!("{left}/"))
}

pub(crate) fn required(port: &PortDefinition, platform: Platform) -> Option<RuntimeIdentity> {
    port.bundled_runtime
        .get(&platform)
        .map(BundledRuntime::identity)
}

pub(crate) fn working_root(port: &PortDefinition, install: &InstallRecord) -> PathBuf {
    if let Some(directory) = &port.runtime_subdirectory {
        install.path.join(directory)
    } else if port.launch_from_install_root || port.adapter == crate::AdapterKind::N64RecompPortable
    {
        install.path.clone()
    } else {
        install
            .path
            .join(&install.selected_executable)
            .parent()
            .unwrap_or(&install.path)
            .to_path_buf()
    }
}

pub(crate) fn ready(port: &PortDefinition, platform: Platform, install: &InstallRecord) -> bool {
    let Some(required) = port.bundled_runtime.get(&platform) else {
        return install.runtime.is_none();
    };
    install.runtime.as_ref().is_some_and(|identity| {
        let executable = working_root(port, install)
            .join(&identity.target_directory)
            .join(&identity.executable);
        required.same_layout(identity)
            && crate::permissions::require_platform_executable(
                &executable,
                platform,
                "bundled runtime executable",
            )
            .is_ok()
    })
}

pub(crate) fn require_ready(
    port: &PortDefinition,
    platform: Platform,
    install: &InstallRecord,
) -> Result<()> {
    if !ready(port, platform, install) {
        return Err(PortcoveError::verification(
            "This installation needs its verified runtime. Update the port before launching.",
        )
        .detail("port_id", &port.id)
        .detail("install_id", &install.id));
    }
    Ok(())
}

pub(crate) fn require_executable(
    root: &Path,
    runtime: &BundledRuntime,
    platform: Platform,
) -> Result<()> {
    let executable = root.join(&runtime.executable);
    if !root.is_dir() {
        return Err(PortcoveError::verification(
            "bundled runtime is missing its declared executable",
        ));
    }
    crate::permissions::require_platform_executable(
        &executable,
        platform,
        "bundled runtime executable",
    )
}
