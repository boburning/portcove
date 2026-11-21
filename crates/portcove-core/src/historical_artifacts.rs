//! Frozen local reader identities. No row authorizes acquisition or publication.
use crate::{ArtifactIdentity, CartridgeBuildRecipe, Platform, PortDefinition, Result};
use serde::Deserialize;
use std::sync::LazyLock;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    dkr: Vec<LegacyDkrArtifact>,
    direct: Vec<LegacyDirectArtifact>,
    packages: Vec<HistoricalPackage>,
    cartridge: Vec<CartridgeContract>,
    #[cfg_attr(
        not(any(test, feature = "qualification-fixtures")),
        serde(rename = "forbidden_memories_producer")
    )]
    #[cfg(not(any(test, feature = "qualification-fixtures")))]
    _forbidden_memories_producer: serde::de::IgnoredAny,
    #[cfg(any(test, feature = "qualification-fixtures"))]
    forbidden_memories_producer: HistoricalGithubProducer,
}

static REGISTRY: LazyLock<Registry> = LazyLock::new(|| {
    serde_json::from_str(include_str!("historical-artifacts.json"))
        .expect("built-in historical artifact registry must be valid")
});

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyDkrArtifact {
    pub(crate) version: String,
    pub(crate) platform: Platform,
    pub(crate) asset_name: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    pub(crate) executable: String,
}

pub(crate) fn dkr_artifacts() -> &'static [LegacyDkrArtifact] {
    &REGISTRY.dkr
}

impl LegacyDkrArtifact {
    pub(crate) fn matches(
        &self,
        version: &str,
        platform: Option<Platform>,
        artifact: &ArtifactIdentity,
        executable: &std::path::Path,
    ) -> bool {
        version == self.version
            && artifact.asset_name == self.asset_name
            && artifact.size == self.size
            && artifact.sha256 == self.sha256
            && executable.file_name() == Some(std::ffi::OsStr::new(&self.executable))
            && platform.is_none_or(|platform| platform == self.platform)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyDirectArtifact {
    port_id: String,
    pub(crate) version: String,
    pub(crate) sha256: String,
}

pub(crate) fn legacy_direct(port_id: &str) -> Option<&'static LegacyDirectArtifact> {
    REGISTRY.direct.iter().find(|row| row.port_id == port_id)
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PackageContract {
    TfeDarkForces122420,
    Racewave46V100Windows,
    Regaiden041Windows,
    Regaiden041PreparedWindows,
    Smb1r11Windows,
    Shipwright931Windows,
    Ghostship200Windows,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoricalPackage {
    contract: PackageContract,
    pub(crate) version: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    asset_name: Option<String>,
}

impl HistoricalPackage {
    pub(crate) fn has_digest(&self, digest: &str) -> bool {
        self.sha256.eq_ignore_ascii_case(digest)
    }

    pub(crate) fn matches_bytes(&self, version: &str, size: u64, digest: &str) -> bool {
        self.version == version && self.size == size && self.sha256 == digest
    }

    pub(crate) fn matches_package(
        &self,
        version: &str,
        name: &str,
        size: u64,
        digest: &str,
    ) -> bool {
        self.asset_name.as_deref() == Some(name) && self.matches_bytes(version, size, digest)
    }

    pub(crate) fn matches_release(
        &self,
        version: &str,
        platform: Option<Platform>,
        artifact: &ArtifactIdentity,
    ) -> bool {
        platform == Some(Platform::WindowsX86_64)
            && self.matches_package(
                version,
                &artifact.asset_name,
                artifact.size,
                &artifact.sha256,
            )
    }
}

impl PackageContract {
    pub(crate) fn package(self) -> &'static HistoricalPackage {
        REGISTRY
            .packages
            .iter()
            .find(|record| record.contract == self)
            .expect("built-in historical package contract must have its frozen identity")
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CartridgeContract {
    port_id: String,
    recipe: CartridgeBuildRecipe,
    projection: CartridgeProjection,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CartridgeProjection {
    YoshisCookieRecomp,
    DrMarioNesRecomp,
    EarthboundRecomp,
    Render96ex,
    GundamWingEndlessDuelRecomp,
    CvlodRecomp,
}

impl CartridgeProjection {
    fn bytes(&self) -> &'static str {
        match self {
            Self::YoshisCookieRecomp => include_str!("legacy_cartridge/yoshis-cookie-recomp.json"),
            Self::DrMarioNesRecomp => include_str!("legacy_cartridge/dr-mario-nes-recomp.json"),
            Self::EarthboundRecomp => include_str!("legacy_cartridge/earthbound-recomp.json"),
            Self::Render96ex => include_str!("legacy_cartridge/render96ex.json"),
            Self::GundamWingEndlessDuelRecomp => {
                include_str!("legacy_cartridge/gundam-wing-endless-duel-recomp.json")
            }
            Self::CvlodRecomp => include_str!("legacy_cartridge/cvlod-recomp.json"),
        }
    }
}

pub(crate) fn cartridge_definition(
    port_id: &str,
    recipe: CartridgeBuildRecipe,
) -> Result<Option<PortDefinition>> {
    REGISTRY
        .cartridge
        .iter()
        .find(|row| row.port_id == port_id && row.recipe == recipe)
        .map(|row| Ok(serde_json::from_str(row.projection.bytes())?))
        .transpose()
}

#[cfg(any(test, feature = "qualification-fixtures"))]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoricalGithubProducer {
    pub(crate) repository: String,
    pub(crate) repository_id: u64,
    pub(crate) release_id: u64,
    pub(crate) asset_id: u64,
    pub(crate) tag: String,
    pub(crate) asset_name: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    pub(crate) url: String,
}

#[cfg(any(test, feature = "qualification-fixtures"))]
pub(crate) fn forbidden_memories_producer() -> &'static HistoricalGithubProducer {
    &REGISTRY.forbidden_memories_producer
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, path::Path};

    fn digest(value: &str) -> bool {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }

    #[test]
    fn registry_preserves_frozen_release_rows_and_refuses_mismatched_coordinates() {
        let original: Vec<LegacyDkrArtifact> =
            serde_json::from_str(include_str!("legacy_dkr/artifacts.json")).unwrap();
        assert!(REGISTRY.dkr == original);
        let mut exact_keys = HashSet::new();
        for row in dkr_artifacts() {
            assert!(digest(&row.sha256));
            assert!(exact_keys.insert((&row.version, row.platform, &row.sha256)));
            let mut archive = ArtifactIdentity {
                asset_name: row.asset_name.clone(),
                size: row.size,
                sha256: row.sha256.clone(),
            };
            let executable = Path::new(&row.executable);
            assert!(row.matches(&row.version, None, &archive, executable));
            assert!(row.matches(&row.version, Some(row.platform), &archive, executable));
            assert!(!row.matches("another-tag", None, &archive, executable));
            assert!(!row.matches(
                &row.version,
                Some(Platform::MacosAarch64),
                &archive,
                executable
            ));
            assert!(!row.matches(&row.version, None, &archive, Path::new("another.exe")));
            archive.size += 1;
            assert!(!row.matches(&row.version, None, &archive, executable));
        }

        let mut package_contracts = Vec::new();
        for package in &REGISTRY.packages {
            assert!(!package_contracts.contains(&package.contract));
            package_contracts.push(package.contract);
            assert!(digest(&package.sha256));
            assert!(package.matches_bytes(&package.version, package.size, &package.sha256));
            assert!(!package.matches_bytes(&package.version, package.size + 1, &package.sha256));
            assert!(!package.matches_bytes(&package.version, package.size, &"a".repeat(64)));
        }

        let mut direct_ports = HashSet::new();
        for row in &REGISTRY.direct {
            assert!(digest(&row.sha256));
            assert!(direct_ports.insert(&row.port_id));
            assert_eq!(legacy_direct(&row.port_id).unwrap().version, row.version);
        }
        assert!(legacy_direct("unknown-port").is_none());
    }

    #[test]
    fn cartridge_registry_keeps_exact_projected_identity_and_excludes_unshipped_recipe() {
        let mut ports = HashSet::new();
        for row in &REGISTRY.cartridge {
            assert!(ports.insert(&row.port_id));
            let expected: PortDefinition = serde_json::from_str(row.projection.bytes()).unwrap();
            assert_eq!(expected.id, row.port_id);
            assert_eq!(
                expected.release.managed_build.get(&Platform::WindowsX86_64),
                Some(&row.recipe),
            );
            assert!(
                cartridge_definition(&row.port_id, row.recipe)
                    .unwrap()
                    .is_some()
            );
            assert!(
                cartridge_definition("unrelated", row.recipe)
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            cartridge_definition("advance-wars", CartridgeBuildRecipe::AdvanceWarsGbaSourceV1)
                .unwrap()
                .is_none()
        );
    }
}
