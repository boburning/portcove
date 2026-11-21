//! Reviewed PSX builder packs. A definition can choose an exact pack only
//! through its admitted operational projection.
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use crate::{Platform, PortcoveError, ReleaseAsset, Result};

const SOURCE: &str = "https://github.com/TechnicallyComputers/retcomm-toolchains/releases/download";
const EMBEDDED: &str = include_str!("../catalog/tool-artifacts.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolchainArtifact {
    pub platform: Platform,
    pub version: String,
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub python_paths: Vec<String>,
    pub cmake: String,
    pub ninja: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned_executables: Vec<PinnedExecutable>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PinnedExecutable {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

impl ToolchainArtifact {
    pub(crate) fn release_asset(&self) -> ReleaseAsset {
        ReleaseAsset {
            name: self.name.clone(),
            url: self.url.clone(),
            size: self.size,
            sha256: self.sha256.clone(),
        }
    }

    pub(crate) fn cache_coordinate(&self) -> String {
        if embedded(self.platform).is_ok_and(|default| default == self) {
            match self.platform {
                Platform::MacosAarch64 => format!("{}-macos-arm64-native-python", self.version),
                Platform::MacosX86_64 => format!("{}-macos-x64-native-python", self.version),
                _ => self.version.clone(),
            }
        } else {
            use sha2::{Digest, Sha256};
            let bytes = serde_json::to_vec(self).expect("tool artifacts are serializable");
            format!("artifact-{}", hex::encode(Sha256::digest(bytes)))
        }
    }
}

fn sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_version(value: &str) -> bool {
    value.split('.').count() == 3
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 6
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
        })
}

fn validate(artifact: &ToolchainArtifact) -> Result<()> {
    let (name, paths, cmake, ninja): (&str, &[&str], &str, &str) = match artifact.platform {
        Platform::WindowsX86_64 => (
            "cmake-clang-v1-windows-x64.zip",
            &["python/python.exe"],
            "bin/cmake.exe",
            "bin/ninja.exe",
        ),
        Platform::LinuxX86_64 => (
            "cmake-clang-v1-linux-x64.zip",
            &["python/bin/python3", "python/bin/python"],
            "bin/cmake",
            "bin/ninja",
        ),
        Platform::MacosX86_64 => (
            "cmake-clang-v1-macos-universal.zip",
            &["python/x86_64-apple-darwin/bin/python3"],
            "bin/cmake",
            "bin/ninja",
        ),
        Platform::MacosAarch64 => (
            "cmake-clang-v1-macos-universal.zip",
            &["python/aarch64-apple-darwin/bin/python3"],
            "bin/cmake",
            "bin/ninja",
        ),
    };
    if !valid_version(&artifact.version)
        || artifact.name != name
        || artifact.url != format!("{SOURCE}/v{}/{name}", artifact.version)
        || !(1..=1024 * 1024 * 1024).contains(&artifact.size)
        || !sha256(&artifact.sha256)
        || artifact.python_paths != paths
        || artifact.cmake != cmake
        || artifact.ninja != ninja
    {
        return Err(PortcoveError::verification(
            "unreviewed PS1 toolchain artifact or layout",
        ));
    }
    let mac = matches!(
        artifact.platform,
        Platform::MacosAarch64 | Platform::MacosX86_64
    );
    let expected = [paths[0], cmake, "bin/ccache", ninja];
    if (mac
        && (artifact.pinned_executables.len() != expected.len()
            || expected.iter().any(|path| {
                artifact
                    .pinned_executables
                    .iter()
                    .filter(|file| file.path == *path)
                    .count()
                    != 1
            })))
        || (!mac && !artifact.pinned_executables.is_empty())
        || artifact
            .pinned_executables
            .iter()
            .any(|file| !(1..=128 * 1024 * 1024).contains(&file.size) || !sha256(&file.sha256))
    {
        return Err(PortcoveError::verification(
            "unreviewed PS1 tool executable identities",
        ));
    }
    Ok(())
}

pub(crate) fn validate_artifacts(artifacts: &[ToolchainArtifact]) -> Result<()> {
    if artifacts.is_empty() || artifacts.len() > 4 {
        return Err(PortcoveError::verification(
            "invalid PS1 tool artifact inventory",
        ));
    }
    for (index, artifact) in artifacts.iter().enumerate() {
        validate(artifact)?;
        if artifacts[..index]
            .iter()
            .any(|other| other.platform == artifact.platform)
        {
            return Err(PortcoveError::verification(
                "duplicate PS1 toolchain platform",
            ));
        }
    }
    Ok(())
}

pub(crate) fn selected(
    catalog: &crate::Catalog,
    port_id: &str,
    platform: Platform,
) -> Result<ToolchainArtifact> {
    if catalog.definition_selection(port_id).is_some() {
        let snapshot = catalog.definition_snapshot(port_id).ok_or_else(|| {
            PortcoveError::verification("admitted PS1 definition lost its exact snapshot")
        })?;
        if let Some(artifacts) = snapshot.selected_psx_tools()? {
            return artifacts
                .into_iter()
                .find(|artifact| artifact.platform == platform)
                .ok_or_else(|| {
                    PortcoveError::verification(
                        "signed PS1 toolchain does not cover the requested platform",
                    )
                });
        }
    }
    Ok(embedded(platform)?.clone())
}

pub(crate) fn embedded(platform: Platform) -> Result<&'static ToolchainArtifact> {
    static ARTIFACTS: LazyLock<Option<Vec<ToolchainArtifact>>> = LazyLock::new(|| {
        let artifacts = serde_json::from_str::<Vec<ToolchainArtifact>>(EMBEDDED).ok()?;
        validate_artifacts(&artifacts).ok()?;
        (artifacts.len() == 4).then_some(artifacts)
    });
    ARTIFACTS
        .as_ref()
        .and_then(|artifacts| artifacts.iter().find(|row| row.platform == platform))
        .ok_or_else(|| PortcoveError::state("bundled PS1 toolchain artifact inventory is invalid"))
}
