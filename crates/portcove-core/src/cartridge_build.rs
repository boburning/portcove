//! Fixed original-driven build recipes; compilation never admits an arbitrary executable.
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AdapterKind, OperationCoordinator, Platform, PortDefinition, PortcoveError, ReleaseAsset,
    ReleaseSource, ResolvedRelease, Result, SourceProfile, SourceRecord,
};

#[cfg(test)]
#[path = "cartridge_build_tests.rs"]
pub(crate) mod tests;

#[path = "cartridge_source_build.rs"]
mod source_build;

#[path = "render96_build.rs"]
mod render96;

#[path = "gundam_build.rs"]
mod gundam;

#[path = "cvlod_build.rs"]
pub(crate) mod cvlod;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CartridgeBuildRecipe {
    #[serde(rename = "yoshis-cookie-nes-cycle-v1.1.0")]
    YoshisCookieNesCycle110,
    #[serde(rename = "dr-mario-nes-cycle-v1.3.0-usa")]
    DrMarioNesCycle130Usa,
    #[serde(rename = "advance-wars-gba-source-cb3facb53b6b-usa-rev1")]
    AdvanceWarsGbaSourceV1,
    #[serde(rename = "earthbound-snes-source-fe1155dc26ff-usa")]
    EarthBoundSnesSourceV1,
    #[serde(rename = "render96-us-source-48da5c491c8a")]
    Render96UsSourceV1,
    #[serde(rename = "gundam-wing-snes-source-c7aaaa152192-japan-offline")]
    GundamWingSnesSourceV1,
    #[serde(rename = "cvlod-n64-source-cb8548d145a1-ui-lifetime-v1")]
    CvlodSourceV1,
}

#[cfg(test)]
pub(crate) type WorkerTestLatch = (std::sync::Mutex<(bool, bool)>, std::sync::Condvar);

#[derive(Debug, Clone)]
pub(crate) struct CartridgeBuildPreparation {
    pub recipe: CartridgeBuildRecipe,
    pub source: SourceRecord,
    #[cfg(test)]
    pub worker_test_latch: Option<std::sync::Arc<WorkerTestLatch>>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct BuildArchive {
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub root: &'static str,
}

impl BuildArchive {
    pub(crate) fn asset(self) -> ReleaseAsset {
        ReleaseAsset {
            name: self.name.into(),
            url: self.url.into(),
            size: self.size,
            sha256: self.sha256.into(),
        }
    }
}

pub(crate) const GAME: BuildArchive = BuildArchive {
    name: "yoshis-cookie-1f24c8b73d8835beaa35fce2f1e7d9b07324b343.zip",
    url: "https://codeload.github.com/mstan/YoshisCookieRecomp/zip/1f24c8b73d8835beaa35fce2f1e7d9b07324b343",
    size: 5_365_028,
    sha256: "727bfddb5fa35ec2f1d11cc39b6bada7a8a06e9a8630025f84c10aaa0d14e6bc",
    root: "YoshisCookieRecomp-1f24c8b73d8835beaa35fce2f1e7d9b07324b343",
};
pub(crate) const ENGINE: BuildArchive = BuildArchive {
    name: "nesrecomp-0c061070aebe5caa0b4e22cce70892f52d04a0a3.zip",
    url: "https://codeload.github.com/mstan/NESRecomp/zip/0c061070aebe5caa0b4e22cce70892f52d04a0a3",
    size: 6_642_566,
    sha256: "14c5db137bcff79e891ff56481bcbc1eb5349fc69f46b32a50555103d195446e",
    root: "nesrecomp-0c061070aebe5caa0b4e22cce70892f52d04a0a3",
};
pub(crate) const UI: BuildArchive = BuildArchive {
    name: "recomp-ui-c11a4b6c649164b6951eff107f4607dcef117dd5.zip",
    url: "https://codeload.github.com/mstan/recomp-ui/zip/c11a4b6c649164b6951eff107f4607dcef117dd5",
    size: 4_988_065,
    sha256: "97733c75128539da7ab79410511fbe44098a6ba38cdeb161fedbdfd8c509d1a8",
    root: "recomp-ui-c11a4b6c649164b6951eff107f4607dcef117dd5",
};
pub(crate) const TOOLCHAIN: BuildArchive = BuildArchive {
    name: "cmake-clang-v1-windows-x64.zip",
    url: "https://github.com/RetroPortingToolKit/RetroPorting-Toolchains/releases/download/v1.0.14/cmake-clang-v1-windows-x64.zip",
    size: 209_497_009,
    sha256: "28da9742385e7ff875b3d9311e8ed89dbdc84f27b6ecba2bc0d0acc11f6d2b4d",
    root: "",
};

const DR_MARIO_GAME: BuildArchive = BuildArchive {
    name: "dr-mario-8d800cab034c08ddf13f7ba7a6f76018fef7ca01.zip",
    url: "https://codeload.github.com/mstan/DrMarioNesRecomp/zip/8d800cab034c08ddf13f7ba7a6f76018fef7ca01",
    size: 5_878_644,
    sha256: "0865d0235ce43d0f90d6c800bad375f7bc7ba851454ad57a6be9e25c6bacaada",
    root: "DrMarioNesRecomp-8d800cab034c08ddf13f7ba7a6f76018fef7ca01",
};

pub(crate) const ORIGINAL_SHA256: &str =
    "ea416fff4a2d207236aa31a7abd2d41f06fe0a53486f485b109ed127be11a45a";
const ORIGINAL_SHA1: &str = "b19b67e59dd6bab7977e24e0052de7b48ae214a4";
pub(crate) const ORIGINAL_SIZE: u64 = 196_624;
pub(crate) const PATCH_PATH: &str = "runner/cyc/hw_fds.c";
pub(crate) const PATCH_BEFORE: &str =
    "57fee02a13d96fd47d1f912bd5adc59f213b50684c2608a39a8bd42bc156092d";
pub(crate) const PATCH_AFTER: &str =
    "a47859d8b380edb6ecd3fd42120d7362ae208e7460981f857fb109007f557164";
pub(crate) const RECEIPT: &str = ".portcove-cartridge-build.json";
// The measured 798 MiB toolchain, pinned archives/source trees, both build
// directories and selected runtime fit within this per-operation allowance.
pub(crate) const STAGING_CAPACITY_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Copy)]
struct RecipeFacts {
    game: BuildArchive,
    port_id: &'static str,
    repository: &'static str,
    target: &'static str,
    release_version: &'static str,
    asset_name: &'static str,
    asset_size: u64,
    asset_sha256: &'static str,
    original_sha1: &'static str,
    original_sha256: &'static str,
    original_size: u64,
    payload_sha256: &'static str,
    cartridge_identity: &'static str,
    prg_identity: &'static str,
    compile_objects: usize,
}

impl CartridgeBuildRecipe {
    fn facts(self) -> Result<RecipeFacts> {
        Ok(match self {
            Self::YoshisCookieNesCycle110 => RecipeFacts {
                game: GAME,
                port_id: "yoshis-cookie-recomp",
                repository: "mstan/YoshisCookieRecomp",
                target: "YoshisCookieRecomp",
                release_version: "v1.1.0",
                asset_name: "YoshisCookieRecomp-windows-x64.zip",
                asset_size: 3_919_022,
                asset_sha256: "3f0b2219479960664312429f464a6c2de2ae155bb112278320e14e94b07bb947",
                original_sha1: ORIGINAL_SHA1,
                original_sha256: ORIGINAL_SHA256,
                original_size: ORIGINAL_SIZE,
                payload_sha256: "24b117a0830fcb91d88d9150ff89a374134a9ddebd5eedcb5df21eab580eb2c0",
                cartridge_identity: "DCEE267B",
                prg_identity: "F586F909",
                compile_objects: 101,
            },
            Self::DrMarioNesCycle130Usa => RecipeFacts {
                game: DR_MARIO_GAME,
                port_id: "dr-mario-nes-recomp",
                repository: "mstan/DrMarioNesRecomp",
                target: "DrMarioRecomp",
                release_version: "v1.3.0",
                asset_name: "DrMarioRecomp-usa-windows-x64.zip",
                asset_size: 3_709_949,
                asset_sha256: "80e9606b0795bf09cadc57cd5ac97ff292f35436011800a406060f3a1a86ae5f",
                original_sha1: "0f18c2a5760be0647339b0e3cab9183af86fdd8c",
                original_sha256: "5f4849329f0ece227a3c7d6a63c0ecb6c9a1edee424e70e7bc6fa4bfda4a82d8",
                original_size: 65_552,
                payload_sha256: "d2fbe8b10f762099d320016ddfd4d2961a591fe6dfaaab2efbeb77282264d06a",
                cartridge_identity: "7422B8F0",
                prg_identity: "8F8C755E",
                compile_objects: 92,
            },
            Self::AdvanceWarsGbaSourceV1
            | Self::EarthBoundSnesSourceV1
            | Self::GundamWingSnesSourceV1
            | Self::Render96UsSourceV1
            | Self::CvlodSourceV1 => {
                return Err(PortcoveError::state(
                    "source-only recipe has no NES cycle facts",
                ));
            }
        })
    }

    pub(crate) fn archives(self) -> Vec<BuildArchive> {
        match self {
            Self::YoshisCookieNesCycle110 => vec![GAME, ENGINE, UI, TOOLCHAIN],
            Self::DrMarioNesCycle130Usa => vec![DR_MARIO_GAME, ENGINE, UI, TOOLCHAIN],
            Self::AdvanceWarsGbaSourceV1 => {
                source_build::SourceRecipe::AdvanceWarsUsaRev1.archives()
            }
            Self::EarthBoundSnesSourceV1 => source_build::SourceRecipe::EarthBoundUsa.archives(),
            Self::GundamWingSnesSourceV1 => source_build::SourceRecipe::GundamWingJapan.archives(),
            Self::Render96UsSourceV1 => render96::archives(),
            Self::CvlodSourceV1 => cvlod::archives(),
        }
    }

    fn source_recipe(self) -> Option<source_build::SourceRecipe> {
        match self {
            Self::AdvanceWarsGbaSourceV1 => Some(source_build::SourceRecipe::AdvanceWarsUsaRev1),
            Self::EarthBoundSnesSourceV1 => Some(source_build::SourceRecipe::EarthBoundUsa),
            Self::GundamWingSnesSourceV1 => Some(source_build::SourceRecipe::GundamWingJapan),
            Self::YoshisCookieNesCycle110
            | Self::DrMarioNesCycle130Usa
            | Self::Render96UsSourceV1
            | Self::CvlodSourceV1 => None,
        }
    }

    pub(crate) fn original_filename(self) -> &'static str {
        if self == Self::CvlodSourceV1 {
            return ".portcove-cvlod-build-original.z64";
        }
        if self == Self::Render96UsSourceV1 {
            return "baserom.us.z64";
        }
        self.source_recipe()
            .map_or("game.nes", |recipe| recipe.facts().original_filename)
    }

    pub(crate) fn fixed_launch_arguments_only(self) -> bool {
        self.source_recipe().is_some()
            || matches!(self, Self::Render96UsSourceV1 | Self::CvlodSourceV1)
    }

    pub(crate) fn require_runtime_environment(self) -> Result<()> {
        if self == Self::CvlodSourceV1 {
            return cvlod::require_runtime_environment();
        }
        if self == Self::Render96UsSourceV1 {
            return source_build::SourceRecipe::EarthBoundUsa.require_runtime_environment();
        }
        match self.source_recipe() {
            Some(recipe) => recipe.require_runtime_environment(),
            None => Ok(()),
        }
    }

    pub(crate) fn acquisition_assets(self) -> Result<Vec<ReleaseAsset>> {
        let mut assets: Vec<_> = self
            .archives()
            .into_iter()
            .map(|archive| archive.asset())
            .collect();
        if self == Self::CvlodSourceV1 {
            assets.extend(cvlod::blobs()?.into_iter().map(|b| b.asset));
        }
        Ok(assets)
    }

    pub(crate) fn temporary_bytes(self, primary_bytes: u64) -> u64 {
        if self == Self::CvlodSourceV1 {
            return primary_bytes.saturating_add(12 * 1024 * 1024 * 1024);
        }
        if self == Self::GundamWingSnesSourceV1 {
            // The authenticated setup archive expands to 861 MiB in addition
            // to the 798 MiB toolchain, SDK, archive spools and private build.
            return primary_bytes.saturating_add(4 * 1024 * 1024 * 1024);
        }
        primary_bytes.saturating_add(STAGING_CAPACITY_BYTES)
    }

    pub(crate) fn minimum_template_version(self) -> u32 {
        match self {
            Self::YoshisCookieNesCycle110 => 6,
            Self::DrMarioNesCycle130Usa => 7,
            Self::AdvanceWarsGbaSourceV1 | Self::EarthBoundSnesSourceV1 => 9,
            Self::Render96UsSourceV1 => 13,
            Self::GundamWingSnesSourceV1 => 14,
            Self::CvlodSourceV1 => 3,
        }
    }

    pub(crate) fn capability_template(self) -> &'static str {
        if self == Self::CvlodSourceV1 {
            "n64-recomp-portable"
        } else {
            "staged-source-portable"
        }
    }

    pub(crate) fn storage_identity(self, primary_sha256: &str) -> Result<String> {
        let facts = self.facts()?;
        // Preserve the existing tuple's domain, ordering and archive projection.
        // Serializing RecipeFacts here would change retained Yoshi storage identity.
        Ok(digest(&serde_json::to_vec(&(
            "Portcove cartridge build storage v1",
            self,
            primary_sha256,
            facts.original_sha256,
            facts.game,
            ENGINE,
            UI,
            TOOLCHAIN,
            PATCH_BEFORE,
            PATCH_AFTER,
        ))?))
    }
}

pub(crate) fn validate_port(port: &PortDefinition, profile: &SourceProfile) -> Result<()> {
    if port.release.managed_build.is_empty() {
        return Ok(());
    }
    let recipe = port
        .release
        .managed_build
        .get(&Platform::WindowsX86_64)
        .copied()
        .ok_or_else(|| PortcoveError::verification("cartridge recipe requires Windows x64"))?;
    if recipe == CartridgeBuildRecipe::Render96UsSourceV1 {
        return render96::validate_port(port, profile);
    }
    if recipe == CartridgeBuildRecipe::CvlodSourceV1 {
        return cvlod::validate_port(port, profile);
    }
    if let Some(source_recipe) = recipe.source_recipe() {
        return source_recipe.validate_port(port, profile);
    }
    let facts = recipe.facts()?;
    let executable = format!("{}.exe", facts.target);
    let expected_recipe = BTreeMap::from([(Platform::WindowsX86_64, recipe)]);
    let original_identity = profile.accepted_sha1 == [facts.original_sha1]
        && profile.accepted_sha256.is_empty()
        || profile.accepted_sha256 == [facts.original_sha256] && profile.accepted_sha1.is_empty();
    if port.release.managed_build != expected_recipe
        || port.id != facts.port_id
        || port.release.provider != ReleaseSource::Github
        || !port
            .release
            .repository
            .eq_ignore_ascii_case(facts.repository)
        || port.platforms != [Platform::WindowsX86_64]
        || port.channels != [crate::ReleaseChannel::Stable]
        || port.adapter != AdapterKind::StagedSourcePortable
        || port.portable_marker
        || port.source_profile.as_deref() != Some(profile.id.as_str())
        || !port.release.user_prepared.is_empty()
        || !port.release.direct.is_empty()
        || port.runtime_subdirectory.is_some()
        || port.executable_hints
            != BTreeMap::from([(Platform::WindowsX86_64, vec![executable.clone()])])
        || port.persistent_paths != ["config.ini", "config.ini.tmp", "saves"]
        || !port.runtime_mutable_paths.is_empty()
        || !port.bundled_runtime.is_empty()
        || port.runtime_source_filename.is_some()
        || !port.runtime_source_set.is_empty()
        || port.source_environment.is_some()
        || port.user_data_environment.is_some()
        || port.launch_arguments != ["game.nes"]
        || port.launch_environment
            != std::collections::BTreeMap::from([("NESRECOMP_NO_LAUNCHER".into(), "1".into())])
        || profile.kind != crate::SourceKind::File
        || profile.accepted_extensions != ["nes"]
        || !original_identity
    {
        return Err(PortcoveError::verification(
            "cartridge build recipe does not match its fixed source and runtime contract",
        ));
    }
    let forbidden = [
        "game.nes",
        RECEIPT,
        executable.as_str(),
        "SDL2.dll",
        "libc++.dll",
        "libunwind.dll",
        "assets",
        "licenses",
    ];
    if port
        .persistent_paths
        .iter()
        .chain(&port.runtime_mutable_paths)
        .any(|mutable| {
            forbidden
                .iter()
                .any(|protected| crate::runtime::overlaps(mutable, protected))
        })
        || port.persistent_file_patterns.len() != 1
        || port.persistent_file_patterns[0].prefix != "cyc_shot_"
        || port.persistent_file_patterns[0].suffix != ".png"
        || !port.runtime_mutable_file_patterns.is_empty()
    {
        return Err(PortcoveError::verification(
            "cartridge build mutable paths overlap protected original or runtime output",
        ));
    }
    Ok(())
}

impl CartridgeBuildPreparation {
    pub(crate) fn storage_identity(&self, primary_sha256: &str) -> Result<String> {
        if self.recipe == CartridgeBuildRecipe::CvlodSourceV1 {
            return cvlod::storage_identity(primary_sha256, &self.source);
        }
        if self.recipe == CartridgeBuildRecipe::Render96UsSourceV1 {
            return render96::storage_identity(primary_sha256, &self.source);
        }
        match self.recipe.source_recipe() {
            Some(recipe) => recipe.storage_identity(primary_sha256, &self.source.sha256),
            None => self.recipe.storage_identity(primary_sha256),
        }
    }

    pub(crate) fn new(recipe: CartridgeBuildRecipe, source: SourceRecord) -> Result<Self> {
        verify_original(recipe, &source, &|| Ok(()))?;
        if recipe == CartridgeBuildRecipe::CvlodSourceV1 {
            cvlod::require_build_prerequisites()?;
        }
        Ok(Self {
            recipe,
            source,
            #[cfg(test)]
            worker_test_latch: None,
        })
    }

    pub(crate) fn verify_release(&self, release: &ResolvedRelease) -> Result<()> {
        if self.recipe == CartridgeBuildRecipe::CvlodSourceV1 {
            return cvlod::verify_release(release);
        }
        if self.recipe == CartridgeBuildRecipe::Render96UsSourceV1 {
            return render96::verify_release(release);
        }
        if let Some(recipe) = self.recipe.source_recipe() {
            let asset = recipe.primary_asset();
            if release.version != recipe.facts().version
                || release.channel != crate::ReleaseChannel::Stable
                || release.asset.name != asset.name
                || release.asset.url != asset.url
                || release.asset.size != asset.size
                || release.asset.sha256 != asset.sha256
            {
                return Err(PortcoveError::verification(
                    "source build requires its exact reviewed source archive",
                ));
            }
            return Ok(());
        }
        let facts = self.recipe.facts()?;
        if release.version != facts.release_version
            || release.channel != crate::ReleaseChannel::Stable
            || release.asset.name != facts.asset_name
            || release.asset.size != facts.asset_size
            || release.asset.sha256 != facts.asset_sha256
        {
            return Err(PortcoveError::verification(
                "cartridge build requires its exact reviewed release input",
            ));
        }
        Ok(())
    }
}

pub(crate) fn verify_original(
    recipe: CartridgeBuildRecipe,
    source: &SourceRecord,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    if recipe == CartridgeBuildRecipe::CvlodSourceV1 {
        return cvlod::verify_original(source, checkpoint);
    }
    if recipe == CartridgeBuildRecipe::Render96UsSourceV1 {
        return render96::verify_original(source, checkpoint);
    }
    if let Some(recipe) = recipe.source_recipe() {
        return recipe.verify_original(source, checkpoint);
    }
    let facts = recipe.facts()?;
    if source.sha256 != facts.original_sha256
        || source.storage_sha256 != facts.original_sha256
        || source.size != facts.original_size
        || source.storage_size != facts.original_size
    {
        return Err(PortcoveError::source(
            "cartridge build requires the unchanged full NES2 original",
        ));
    }
    crate::path::refuse_symlink_ancestors(&source.path)?;
    crate::adapter::verify_source_storage_identity(source, "cartridge build original")?;
    checkpoint()
}

pub(crate) fn source_roots(work: &Path, recipe: CartridgeBuildRecipe) -> Result<Vec<PathBuf>> {
    if recipe == CartridgeBuildRecipe::CvlodSourceV1 {
        return cvlod::source_roots(work);
    }
    Ok(recipe
        .archives()
        .into_iter()
        .map(|archive| {
            work.join(archive.name.trim_end_matches(".zip"))
                .join(archive.root)
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FileIdentity {
    path: String,
    size: u64,
    sha256: String,
}

fn inventory(root: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<Vec<FileIdentity>> {
    fn visit(
        root: &Path,
        directory: &Path,
        depth: usize,
        files: &mut Vec<FileIdentity>,
        bytes: &mut u64,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        checkpoint()?;
        if depth > 32 {
            return Err(PortcoveError::verification(
                "build input exceeds path-depth bound",
            ));
        }
        crate::path::refuse_symlink_ancestors(directory)?;
        for entry in fs::read_dir(directory)? {
            checkpoint()?;
            let path = entry?.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(PortcoveError::verification("build input contains a link"));
            }
            if metadata.is_dir() {
                visit(root, &path, depth + 1, files, bytes, checkpoint)?;
                continue;
            }
            if !metadata.is_file() || metadata.len() > 256 * 1024 * 1024 || files.len() >= 20_000 {
                return Err(PortcoveError::verification(
                    "build input exceeds regular-file bounds",
                ));
            }
            *bytes = bytes
                .checked_add(metadata.len())
                .ok_or_else(|| PortcoveError::verification("build input size overflow"))?;
            if *bytes > 2 * 1024 * 1024 * 1024 {
                return Err(PortcoveError::verification(
                    "build input exceeds expanded-size bound",
                ));
            }
            crate::path::refuse_symlink_ancestors(&path)?;
            let file = fs::File::open(&path)?;
            if crate::external_runtime::link_count(&file)? != 1 {
                return Err(PortcoveError::verification(
                    "build input must not share hard-linked bytes",
                ));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| PortcoveError::verification("build input escaped its root"))?;
            let name = crate::path::unicode(relative, "build input")?.replace('\\', "/");
            crate::archive::validate_relative_path(&name, false)?;
            let (sha256, size) = crate::adapter::hash_file_bounded_with_checkpoint(
                &path,
                metadata.len(),
                checkpoint,
            )?;
            if size != metadata.len() {
                return Err(PortcoveError::verification(
                    "build input changed while hashing",
                ));
            }
            files.push(FileIdentity {
                path: name,
                size,
                sha256,
            });
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, root, 0, &mut files, &mut 0, checkpoint)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut names = std::collections::BTreeSet::new();
    if files
        .iter()
        .any(|f| !names.insert(f.path.to_ascii_lowercase()))
    {
        return Err(PortcoveError::verification(
            "build input has case-colliding files",
        ));
    }
    Ok(files)
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    crate::path::refuse_symlink_ancestors(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn apply_patch(engine: &Path) -> Result<()> {
    let path = engine.join(PATCH_PATH);
    crate::path::refuse_symlink_ancestors(&path)?;
    let before = crate::path::read_bounded_regular(&path, 64 * 1024)?;
    if digest(&before) != PATCH_BEFORE {
        return Err(PortcoveError::verification(
            "cartridge build patch preimage differs",
        ));
    }
    let text = std::str::from_utf8(&before)
        .map_err(|_| PortcoveError::verification("build patch is not UTF-8"))?;
    let needle = "#include \"cyc_ring.h\"";
    if text.matches(needle).count() != 1 {
        return Err(PortcoveError::verification(
            "build patch declaration is not unique",
        ));
    }
    let after = text.replace(needle, "#include \"cyc_ring.h\"\n#include \"cyc_trace.h\"");
    if digest(after.as_bytes()) != PATCH_AFTER {
        return Err(PortcoveError::verification(
            "cartridge build patch result differs",
        ));
    }
    fs::write(path, after)?;
    Ok(())
}

struct BuildInputs {
    recipe: CartridgeBuildRecipe,
    roots: Vec<PathBuf>,
    identities: Vec<Vec<FileIdentity>>,
}

impl BuildInputs {
    fn capture(
        work: &Path,
        recipe: CartridgeBuildRecipe,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<Self> {
        let roots = source_roots(work, recipe)?;
        let identities = roots
            .iter()
            .map(|r| inventory(r, checkpoint))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            recipe,
            roots,
            identities,
        })
    }
    fn verify(&self, source: &SourceRecord, checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
        verify_original(self.recipe, source, checkpoint)?;
        for (root, expected) in self.roots.iter().zip(&self.identities) {
            if inventory(root, checkpoint)? != *expected {
                return Err(PortcoveError::verification(
                    "authenticated build inputs changed",
                ));
            }
        }
        Ok(())
    }
    fn toolchain_index(&self) -> Result<usize> {
        let matches: Vec<_> = self
            .recipe
            .archives()
            .iter()
            .enumerate()
            .filter_map(|(index, archive)| {
                (archive.sha256 == TOOLCHAIN.sha256
                    && archive.url == TOOLCHAIN.url
                    && archive.root == TOOLCHAIN.root)
                    .then_some(index)
            })
            .collect();
        match matches.as_slice() {
            [index] => Ok(*index),
            _ => Err(PortcoveError::verification(
                "build requires one fixed toolchain",
            )),
        }
    }

    fn toolroot(&self) -> Result<&Path> {
        Ok(&self.roots[self.toolchain_index()?])
    }

    fn tool(&self, name: &str) -> Result<PathBuf> {
        let index = self.toolchain_index()?;
        let path = self.roots[index].join(name);
        let expected = self.identities[index]
            .iter()
            .find(|f| f.path == name)
            .ok_or_else(|| PortcoveError::verification("pinned build tool is absent"))?;
        crate::path::refuse_symlink_ancestors(&path)?;
        let (sha, size) =
            crate::adapter::hash_file_bounded_with_checkpoint(&path, expected.size, || Ok(()))?;
        if sha != expected.sha256 || size != expected.size {
            return Err(PortcoveError::verification("pinned build tool changed"));
        }
        Ok(path)
    }

    fn verified_tool_path(&self, path: &Path) -> Result<PathBuf> {
        let mut matches = Vec::new();
        for (root, files) in self.roots.iter().zip(&self.identities) {
            if let Ok(relative) = path.strip_prefix(root) {
                let relative =
                    crate::path::unicode(relative, "CVLoD build tool")?.replace('\\', "/");
                if let Some(file) = files.iter().find(|f| f.path == relative) {
                    matches.push(file);
                }
            }
        }
        let [expected] = matches.as_slice() else {
            return Err(PortcoveError::verification(
                "CVLoD tool is outside its captured fixed inputs",
            ));
        };
        crate::path::refuse_symlink_ancestors(path)?;
        let (sha, size) =
            crate::adapter::hash_file_bounded_with_checkpoint(path, expected.size, || Ok(()))?;
        if sha != expected.sha256 || size != expected.size {
            return Err(PortcoveError::verification(
                "CVLoD captured build tool changed",
            ));
        }
        Ok(path.to_path_buf())
    }
}

struct BuildSession<'a> {
    inputs: &'a BuildInputs,
    work: &'a Path,
    library: &'a crate::Library,
    operation: &'a OperationCoordinator,
    deadline: Instant,
    port_id: &'a str,
}

struct BuildCommandOutput {
    output: String,
    stdout: Option<String>,
    stderr: Option<String>,
    exit_code: Option<i32>,
}

impl BuildCommandOutput {
    fn complete_stdout(&self) -> Result<&str> {
        self.stdout.as_deref().ok_or_else(|| {
            PortcoveError::verification("cartridge build command has no complete stdout capture")
        })
    }
}

impl BuildSession<'_> {
    fn run(
        &self,
        arguments: &[String],
        program: &str,
        phase: &str,
        quiesced: &mut bool,
    ) -> Result<String> {
        self.run_configured(arguments, program, phase, quiesced, |_| Ok(()))
            .map(|result| result.output)
    }

    fn run_configured(
        &self,
        arguments: &[String],
        program: &str,
        phase: &str,
        quiesced: &mut bool,
        configure: impl FnOnce(&mut crate::process::NativeToolLaunchSpec) -> Result<()>,
    ) -> Result<BuildCommandOutput> {
        self.run_command(
            arguments,
            self.inputs.tool(program)?,
            phase,
            quiesced,
            configure,
            false,
        )
    }

    fn run_cvlod_configured(
        &self,
        arguments: &[String],
        program: &Path,
        phase: &str,
        quiesced: &mut bool,
        configure: impl FnOnce(&mut crate::process::NativeToolLaunchSpec) -> Result<()>,
    ) -> Result<BuildCommandOutput> {
        if self.inputs.recipe != CartridgeBuildRecipe::CvlodSourceV1 {
            return Err(PortcoveError::verification(
                "CVLoD command requires its fixed recipe",
            ));
        }
        self.run_command(
            arguments,
            self.inputs.verified_tool_path(program)?,
            phase,
            quiesced,
            configure,
            true,
        )
    }

    fn run_command(
        &self,
        arguments: &[String],
        program: PathBuf,
        phase: &str,
        quiesced: &mut bool,
        configure: impl FnOnce(&mut crate::process::NativeToolLaunchSpec) -> Result<()>,
        cvlod_capture: bool,
    ) -> Result<BuildCommandOutput> {
        crate::activity_diagnostics::require_managed_install_phase(phase, self.port_id)?;
        let Self {
            inputs,
            work,
            library,
            operation,
            deadline,
            port_id,
        } = self;
        let checkpoint = || {
            operation.checkpoint()?;
            if deadline.elapsed() > Duration::from_secs(20 * 60) {
                return Err(PortcoveError::launch(
                    "cartridge build exceeded its finite execution deadline",
                ));
            }
            Ok(())
        };
        checkpoint()?;
        let mut command = crate::ChildProcessPolicy::native_tool_spec(
            crate::ChildProcessClass::ManagedBuilder,
            program,
        )?;
        let toolroot = inputs.toolroot()?;
        let path = std::env::join_paths([toolroot.join("bin"), toolroot.join("python")])
            .map_err(|_| PortcoveError::verification("build tool PATH is invalid"))?;
        command
            .args(arguments)
            .current_dir(work)
            .env("PATH", path)
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONSAFEPATH", "1")
            .env("TEMP", work.join("temp"))
            .env("TMP", work.join("temp"))
            .env("CMAKE_BUILD_PARALLEL_LEVEL", "2");
        for variable in [
            "CC",
            "CXX",
            "CFLAGS",
            "CXXFLAGS",
            "CPPFLAGS",
            "LDFLAGS",
            "CMAKE_PREFIX_PATH",
            "CMAKE_TOOLCHAIN_FILE",
            "CMAKE_GENERATOR",
            "CMAKE_GENERATOR_INSTANCE",
            "CMAKE_GENERATOR_PLATFORM",
            "CMAKE_GENERATOR_TOOLSET",
            "CMAKE_PROJECT_INCLUDE",
            "CMAKE_PROJECT_INCLUDE_BEFORE",
            "PYTHONHOME",
            "PYTHONPATH",
            "INCLUDE",
            "LIB",
            "LIBPATH",
            "CCC_OVERRIDE_OPTIONS",
            "CL",
            "_CL_",
            "CPATH",
            "C_INCLUDE_PATH",
            "CPLUS_INCLUDE_PATH",
            "OBJC_INCLUDE_PATH",
            "LIBRARY_PATH",
            "COMPILER_PATH",
            "GCC_EXEC_PREFIX",
            "CLANG_CONFIG_FILE_SYSTEM_DIR",
            "CLANG_CONFIG_FILE_USER_DIR",
        ] {
            command.env_remove(variable);
        }
        configure(&mut command)?;
        let previous = *quiesced;
        *quiesced = false;
        let mut child_quiesced = false;
        let mut captured = None;
        let result = crate::tool_process::run_tool(
            &mut command,
            &checkpoint,
            crate::tool_process::ToolProcessObserver {
                diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                    activity_id: operation.operation_id(),
                    phase,
                    record: &mut |snapshot| {
                        captured = Some(snapshot.clone());
                        library.record_managed_install_diagnostic(snapshot, port_id)
                    },
                }),
                quiesced: Some(&mut || {
                    child_quiesced = true;
                    Ok(())
                }),
            },
        );
        *quiesced = previous && child_quiesced;
        if let Some(snapshot) = &captured {
            library.record_managed_install_diagnostic(snapshot, port_id)?;
        }
        let result = result?;
        if cvlod_capture {
            let snapshot = captured.as_ref().ok_or_else(|| {
                PortcoveError::verification("CVLoD command has no diagnostic capture")
            })?;
            if !child_quiesced
                || snapshot.activity_id != operation.operation_id()
                || snapshot.phase != phase
                || !snapshot.complete
                || snapshot.stdout.truncated
                || snapshot.stderr.truncated
                || snapshot.stream_limit_bytes != 2 * 1024 * 1024
                || snapshot.stdout.observed_bytes > snapshot.stream_limit_bytes
                || snapshot.stderr.observed_bytes > snapshot.stream_limit_bytes
                || snapshot.stdout.text.len() as u64 > snapshot.stream_limit_bytes
                || snapshot.stderr.text.len() as u64 > snapshot.stream_limit_bytes
            {
                return Err(PortcoveError::verification(
                    "CVLoD command capture or process-tree drain is incomplete",
                ));
            }
            cvlod::validate_command_result(phase, &result.status, snapshot)?;
        } else if !result.status.success() {
            return Err(
                PortcoveError::install("pinned cartridge build command failed")
                    .detail("phase", phase)
                    .detail("output", result.output),
            );
        }
        if !cvlod_capture && result.truncated {
            return Err(PortcoveError::verification(
                "cartridge build command output was incomplete",
            ));
        }
        checkpoint()?;
        Ok(BuildCommandOutput {
            output: result.output,
            stdout: captured
                .as_ref()
                .filter(|snapshot| snapshot.complete && !snapshot.stdout.truncated)
                .map(|snapshot| snapshot.stdout.text.clone()),
            stderr: captured
                .filter(|snapshot| snapshot.complete && !snapshot.stderr.truncated)
                .map(|snapshot| snapshot.stderr.text),
            exit_code: result.status.code(),
        })
    }
}

fn cmake_path(path: &Path) -> Result<String> {
    let path = crate::path::unicode(path, "cartridge build path")?.replace('\\', "/");
    if path.chars().any(|c| matches!(c, ';' | '"' | '\r' | '\n')) {
        return Err(PortcoveError::unsupported(
            "cartridge build path contains unsupported CMake control characters",
        ));
    }
    Ok(path)
}

fn configure_arguments(inputs: &BuildInputs, project: &Path, build: &Path) -> Result<Vec<String>> {
    let mut args = vec![
        "-S".into(),
        cmake_path(project)?,
        "-B".into(),
        cmake_path(build)?,
        "-G".into(),
        "Ninja".into(),
        "-DCMAKE_BUILD_TYPE=Release".into(),
    ];
    for (variable, tool) in [
        ("CMAKE_MAKE_PROGRAM", "bin/ninja.exe"),
        ("CMAKE_C_COMPILER", "bin/clang.exe"),
        ("CMAKE_CXX_COMPILER", "bin/clang++.exe"),
        ("CMAKE_AR", "bin/llvm-ar.exe"),
        ("CMAKE_RANLIB", "bin/llvm-ranlib.exe"),
        ("CMAKE_RC_COMPILER", "bin/llvm-windres.exe"),
        ("CMAKE_LINKER", "bin/ld.lld.exe"),
        ("Python3_EXECUTABLE", "python/python.exe"),
    ] {
        args.push(format!("-D{variable}={}", cmake_path(&inputs.tool(tool)?)?));
    }
    // CMake serializes ARG1 into quoted source and splits it on spaces during
    // compiler identification. Keep it path-free: empty search directories
    // restrict explicit config lookup to the authenticated driver's own bin.
    // The explicit bundled config remains enabled with no-default-config.
    for variable in ["CMAKE_C_COMPILER_ARG1", "CMAKE_CXX_COMPILER_ARG1"] {
        args.push(format!(
            "-D{variable}=--config-user-dir= --config-system-dir= --no-default-config --config=x86_64-w64-windows-gnu.cfg"
        ));
    }
    args.extend(
        [
            "-DCMAKE_C_COMPILER_LAUNCHER:STRING=",
            "-DCMAKE_CXX_COMPILER_LAUNCHER:STRING=",
            "-DCMAKE_C_FLAGS:STRING=",
            "-DCMAKE_CXX_FLAGS:STRING=",
            "-DCMAKE_EXE_LINKER_FLAGS:STRING=",
            "-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF",
            "-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF",
            "-DCMAKE_FIND_USE_CMAKE_ENVIRONMENT_PATH=OFF",
            "-DCMAKE_FIND_USE_SYSTEM_ENVIRONMENT_PATH=OFF",
        ]
        .map(String::from),
    );
    Ok(args)
}

const OBJECTS_PER_INVOCATION: usize = 8;

fn decode_object_target(encoded: &str) -> Result<String> {
    let mut bytes = encoded.bytes();
    let mut target = String::new();
    while let Some(byte) = bytes.next() {
        match byte {
            b'$' if bytes.next() == Some(b' ') => target.push(' '),
            c if c.is_ascii_alphanumeric() || b"/._-".contains(&c) => target.push(c as char),
            _ => {
                return Err(PortcoveError::verification(
                    "build graph has an unsupported object target escape",
                ));
            }
        }
    }
    crate::archive::validate_relative_path(&target, false)?;
    Ok(target)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct CompilePlan {
    manifest_sha256: String,
    rules_sha256: String,
    object_targets: Vec<String>,
}

impl CompilePlan {
    fn read(build: &Path, recipe: CartridgeBuildRecipe) -> Result<Self> {
        let facts = recipe.facts()?;
        Self::read_target(
            build,
            facts.target,
            facts.compile_objects..=facts.compile_objects,
        )
    }

    // Callers supply independently reviewed bounds for a fixed recipe. The
    // graph being inspected never defines its own authorized object count.
    fn read_target(
        build: &Path,
        target: &str,
        objects: std::ops::RangeInclusive<usize>,
    ) -> Result<Self> {
        if target.is_empty()
            || !target
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || *objects.start() == 0
            || objects.is_empty()
            || *objects.end() > 20_000
        {
            return Err(PortcoveError::verification(
                "invalid fixed compiler target contract",
            ));
        }
        let target_prefix = format!("CMakeFiles/{target}.dir/");
        let c_rule = format!("C_COMPILER__{target}_unscanned_Release");
        let cxx_rule = format!("CXX_COMPILER__{target}_unscanned_Release");
        let bytes = crate::path::read_bounded_regular(&build.join("build.ninja"), 1024 * 1024)?;
        let manifest = std::str::from_utf8(&bytes)
            .map_err(|_| PortcoveError::verification("build graph is not UTF-8"))?;
        let includes: Vec<_> = manifest
            .lines()
            .filter(|line| line.starts_with("include ") || line.starts_with("subninja "))
            .collect();
        if includes != ["include CMakeFiles/rules.ninja"] {
            return Err(PortcoveError::verification(
                "build graph include inventory differs",
            ));
        }
        let rules =
            crate::path::read_bounded_regular(&build.join("CMakeFiles/rules.ninja"), 1024 * 1024)?;
        let rule_text = std::str::from_utf8(&rules)
            .map_err(|_| PortcoveError::verification("compiler rules are not UTF-8"))?;
        if rule_text
            .lines()
            .any(|line| line.starts_with("include ") || line.starts_with("subninja "))
        {
            return Err(PortcoveError::verification(
                "compiler rules introduce another build graph",
            ));
        }
        let mut object_targets = Vec::new();
        let mut identities = std::collections::BTreeSet::new();
        for line in manifest.lines() {
            let Some(line) = line.strip_prefix("build ") else {
                continue;
            };
            let Some((target, rest)) = line.split_once(": ") else {
                continue;
            };
            if !target.ends_with(".obj") {
                continue;
            }
            let target = decode_object_target(target)?;
            let rule = rest.split_whitespace().next().unwrap_or_default();
            if !target.starts_with(&target_prefix)
                || target.len() > 1024
                || (rule != c_rule && rule != cxx_rule)
                || !identities.insert(target.to_ascii_lowercase())
                || object_targets.len() == *objects.end()
            {
                return Err(PortcoveError::verification(
                    "build graph has an undeclared compiler object",
                ));
            }
            object_targets.push(target);
        }
        if !objects.contains(&object_targets.len()) {
            return Err(PortcoveError::verification(
                "build graph compiler object inventory differs",
            ));
        }
        Ok(Self {
            manifest_sha256: digest(&bytes),
            rules_sha256: digest(&rules),
            object_targets,
        })
    }

    fn require_unchanged(&self, build: &Path) -> Result<()> {
        let bytes = crate::path::read_bounded_regular(&build.join("build.ninja"), 1024 * 1024)?;
        let rules =
            crate::path::read_bounded_regular(&build.join("CMakeFiles/rules.ninja"), 1024 * 1024)?;
        if digest(&bytes) != self.manifest_sha256 || digest(&rules) != self.rules_sha256 {
            return Err(PortcoveError::verification(
                "build graph changed between compiler groups",
            ));
        }
        Ok(())
    }
}

fn generated_identity(build: &Path, recipe: CartridgeBuildRecipe) -> Result<(String, String)> {
    let facts = recipe.facts()?;
    let root = build.join(format!("cycle-{}", facts.target));
    let manifest = crate::path::read_bounded_regular(&root.join("sources.cmake"), 64 * 1024)?;
    let text = std::str::from_utf8(&manifest)
        .map_err(|_| PortcoveError::verification("generated source manifest is not UTF-8"))?;
    for (name, value) in [
        ("CYC_PROJECT_ROM_SHA256", facts.original_sha256),
        ("CYC_PROJECT_LAUNCHER_SHA256", facts.payload_sha256),
    ] {
        if text
            .matches(&format!("set({name}\n  [=[{value}]=]\n)"))
            .count()
            != 1
        {
            return Err(PortcoveError::verification(
                "generated source manifest has a different original identity",
            ));
        }
    }
    let mut directories = Vec::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(PortcoveError::verification(
                "generated source directory is a link",
            ));
        }
        if kind.is_dir() {
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| {
                PortcoveError::verification("generated source path is not Unicode")
            })?;
            if name.len() != 20 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(PortcoveError::verification(
                    "generated source directory is undeclared",
                ));
            }
            directories.push(entry.path());
        }
    }
    if directories.len() != 1 {
        return Err(PortcoveError::verification(
            "generated source selection is ambiguous",
        ));
    }
    let generated =
        crate::path::read_bounded_regular(&directories[0].join("generated/game_cyc.c"), 64 * 1024)?;
    let text = std::str::from_utf8(&generated)
        .map_err(|_| PortcoveError::verification("generated identity is not UTF-8"))?;
    for expected in [
        format!(
            "const uint32_t cyc_native_cart_hash = 0x{}u;",
            facts.cartridge_identity
        ),
        format!(
            "const uint32_t cyc_native_prg_hash = 0x{}u;",
            facts.prg_identity
        ),
    ] {
        if text.matches(expected.as_str()).count() != 1 {
            return Err(PortcoveError::verification(
                "generated cartridge or PRG identity differs",
            ));
        }
    }
    Ok((digest(&manifest), digest(&generated)))
}

fn copy_verified(source: &Path, target: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(source)?;
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err(PortcoveError::verification(
            "runtime output exceeds its regular-file bound",
        ));
    }
    let bytes = crate::path::read_bounded_regular(source, 64 * 1024 * 1024)?;
    write_new(target, &bytes)?;
    if crate::adapter::hash_file(source)? != crate::adapter::hash_file(target)? {
        return Err(PortcoveError::verification(
            "runtime output changed during publication preparation",
        ));
    }
    checkpoint()
}

impl BuildSession<'_> {
    fn inspect_imports(
        &self,
        image: &Path,
        phase: &str,
        quiesced: &mut bool,
    ) -> Result<Vec<String>> {
        let output = self.run(
            &["--coff-imports".into(), cmake_path(image)?],
            "bin/llvm-readobj.exe",
            phase,
            quiesced,
        )?;
        if self.inputs.recipe == CartridgeBuildRecipe::EarthBoundSnesSourceV1 {
            validate_imports_with_crash_reports(&output, true)
        } else {
            validate_imports(&output)
        }
    }
}

fn validate_imports(output: &str) -> Result<Vec<String>> {
    validate_imports_with_crash_reports(output, false)
}

fn validate_imports_with_crash_reports(output: &str, crash_reports: bool) -> Result<Vec<String>> {
    let mut names = std::collections::BTreeSet::new();
    for line in output.lines() {
        if let Some(name) = line.trim().strip_prefix("Name:") {
            let name = name.trim().to_ascii_lowercase();
            if name.is_empty()
                || name.len() > 128
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-+.".contains(&b))
                || !names.insert(name)
            {
                return Err(PortcoveError::verification(
                    "runtime import inventory is malformed",
                ));
            }
        }
    }
    let allowed = [
        "ws2_32.dll",
        "sdl2.dll",
        "opengl32.dll",
        "d2d1.dll",
        "dwrite.dll",
        "ole32.dll",
        "kernel32.dll",
        "user32.dll",
        "shell32.dll",
        "comdlg32.dll",
        "libc++.dll",
        "libunwind.dll",
        "advapi32.dll",
        "gdi32.dll",
        "imm32.dll",
        "msvcrt.dll",
        "oleaut32.dll",
        "setupapi.dll",
        "version.dll",
        "winmm.dll",
        "api-ms-win-crt-stdio-l1-1-0.dll",
        "api-ms-win-crt-runtime-l1-1-0.dll",
        "api-ms-win-crt-math-l1-1-0.dll",
        "api-ms-win-crt-filesystem-l1-1-0.dll",
        "api-ms-win-crt-conio-l1-1-0.dll",
        "api-ms-win-crt-string-l1-1-0.dll",
        "api-ms-win-crt-environment-l1-1-0.dll",
        "api-ms-win-crt-locale-l1-1-0.dll",
        "api-ms-win-crt-convert-l1-1-0.dll",
        "api-ms-win-crt-heap-l1-1-0.dll",
        "api-ms-win-crt-private-l1-1-0.dll",
        "api-ms-win-crt-utility-l1-1-0.dll",
        "api-ms-win-crt-multibyte-l1-1-0.dll",
        "api-ms-win-crt-time-l1-1-0.dll",
    ];
    // The fixed EarthBound runner links Win32 MiniDumpWriteDump for its
    // reviewed crash reports. Earlier recipes retain their exact import set.
    if names.is_empty()
        || names
            .iter()
            .any(|n| !allowed.contains(&n.as_str()) && !(crash_reports && n == "dbghelp.dll"))
    {
        return Err(PortcoveError::verification(
            "runtime has an unreviewed native dependency",
        ));
    }
    Ok(names.into_iter().collect())
}

pub(crate) fn prepare_install(
    work: &Path,
    payload: &Path,
    preparation: &CartridgeBuildPreparation,
    library: &crate::Library,
    operation: &OperationCoordinator,
) -> (Result<()>, bool) {
    let mut quiesced = true;
    let result = (|| {
        #[cfg(test)]
        if let Some(latch) = &preparation.worker_test_latch {
            let (lock, condition) = &**latch;
            let mut state = lock.lock().unwrap();
            state.0 = true;
            condition.notify_all();
            while !state.1 {
                state = condition.wait(state).unwrap();
            }
        }
        operation.checkpoint()?;
        prepare_install_inner(
            work,
            payload,
            preparation,
            library,
            operation,
            &mut quiesced,
        )
    })();
    (result, quiesced)
}

fn prepare_install_inner(
    work: &Path,
    payload: &Path,
    preparation: &CartridgeBuildPreparation,
    library: &crate::Library,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
) -> Result<()> {
    if Platform::current()? != Platform::WindowsX86_64 {
        return Err(PortcoveError::unsupported(
            "this cartridge recipe is Windows x64 only",
        ));
    }
    let checkpoint = || operation.checkpoint();
    let recipe = preparation.recipe;
    if recipe == CartridgeBuildRecipe::CvlodSourceV1 {
        return cvlod::prepare_install(work, payload, preparation, library, operation, quiesced);
    }
    if recipe == CartridgeBuildRecipe::Render96UsSourceV1 {
        return render96::prepare_install(work, payload, preparation, library, operation, quiesced);
    }
    if let Some(source_recipe) = recipe.source_recipe() {
        return source_recipe.prepare_install(
            work,
            payload,
            preparation,
            library,
            operation,
            quiesced,
        );
    }
    let facts = recipe.facts()?;
    let executable = format!("{}.exe", facts.target);
    verify_original(recipe, &preparation.source, &checkpoint)?;
    let before = BuildInputs::capture(work, recipe, &checkpoint)?;
    apply_patch(&before.roots[1])?;
    let inputs = BuildInputs::capture(work, recipe, &checkpoint)?;
    for part in [0, 2, 3] {
        if before.identities[part] != inputs.identities[part] {
            return Err(PortcoveError::verification(
                "build patch changed unrelated inputs",
            ));
        }
    }
    let differences: Vec<_> = before.identities[1]
        .iter()
        .zip(&inputs.identities[1])
        .filter(|(a, b)| a != b)
        .collect();
    if before.identities[1].len() != inputs.identities[1].len()
        || differences.len() != 1
        || differences[0].0.path != PATCH_PATH
        || differences[0].0.sha256 != PATCH_BEFORE
        || differences[0].1.sha256 != PATCH_AFTER
    {
        return Err(PortcoveError::verification(
            "build patch changed an undeclared file",
        ));
    }
    fs::create_dir(work.join("build"))?;
    fs::create_dir(work.join("temp"))?;
    let session = BuildSession {
        inputs: &inputs,
        work,
        library,
        operation,
        deadline: Instant::now(),
        port_id: facts.port_id,
    };
    // Bootstrap separately: upstream's nested configure does not forward the
    // authenticated Clang configuration arguments to its host compiler.
    let host_build = work.join("host-build");
    fs::create_dir(&host_build)?;
    let host_arguments =
        configure_arguments(&inputs, &inputs.roots[1].join("recompiler"), &host_build)?;
    session.run(
        &host_arguments,
        "bin/cmake.exe",
        "install.cartridge.host.configure",
        quiesced,
    )?;
    session.run(
        &[
            "--build".into(),
            cmake_path(&host_build)?,
            "--config".into(),
            "Release".into(),
            "--parallel".into(),
            "2".into(),
            "--target".into(),
            "NESRecomp".into(),
        ],
        "bin/cmake.exe",
        "install.cartridge.host.compile",
        quiesced,
    )?;
    let host = host_build.join("NESRecomp.exe");
    crate::path::refuse_symlink_ancestors(&host)?;
    let host_identity =
        crate::adapter::hash_file_bounded_with_checkpoint(&host, 64 * 1024 * 1024, &checkpoint)?;
    if host_identity.1 == 0 || host_identity.1 > 64 * 1024 * 1024 {
        return Err(PortcoveError::verification(
            "generated host tool exceeds its executable bound",
        ));
    }
    let host_imports =
        session.inspect_imports(&host, "install.cartridge.host.imports", quiesced)?;
    if host_imports.iter().any(|n| n == "sdl2.dll") {
        return Err(PortcoveError::verification(
            "host compiler has an undeclared runtime dependency",
        ));
    }
    inputs.verify(&preparation.source, &checkpoint)?;
    let mut arguments = configure_arguments(&inputs, &inputs.roots[0], &work.join("build"))?;
    arguments.extend([
        format!("-DNESRECOMP_ROM={}", cmake_path(&preparation.source.path)?),
        format!("-DNESRECOMP_ROOT={}", cmake_path(&inputs.roots[1])?),
        format!("-DNESRECOMP_RECOMP_UI={}", cmake_path(&inputs.roots[2])?),
        format!("-DNESRECOMP_HOST_COMPILER={}", cmake_path(&host)?),
        "-DNESRECOMP_BACKEND=cycle".into(),
        "-DNESRECOMP_ENABLE_NET=OFF".into(),
        "-DNESRECOMP_DEV_UI=OFF".into(),
        "-DRECOMP_UI_ENABLE_MODS=OFF".into(),
    ]);
    match recipe {
        CartridgeBuildRecipe::YoshisCookieNesCycle110 => {}
        CartridgeBuildRecipe::DrMarioNesCycle130Usa => arguments.extend([
            "-DDRMARIO_REGION=usa".into(),
            format!(
                "-DNESRECOMP_CYCLE_SEEDS={}",
                cmake_path(&inputs.roots[0].join("cyc_seeds.txt"))?
            ),
        ]),
        CartridgeBuildRecipe::AdvanceWarsGbaSourceV1
        | CartridgeBuildRecipe::EarthBoundSnesSourceV1
        | CartridgeBuildRecipe::GundamWingSnesSourceV1
        | CartridgeBuildRecipe::Render96UsSourceV1
        | CartridgeBuildRecipe::CvlodSourceV1 => {
            return Err(PortcoveError::state(
                "source-only recipe reached NES cycle configuration",
            ));
        }
    }
    session.run(
        &arguments,
        "bin/cmake.exe",
        "install.cartridge.configure",
        quiesced,
    )?;
    inputs.verify(&preparation.source, &checkpoint)?;
    let generated = generated_identity(&work.join("build"), recipe)?;
    let compile_plan = CompilePlan::read(&work.join("build"), recipe)?;
    // A full Ninja compile exceeds the unchanged native supervisor's finite
    // debug-event budget. Each object group drains its own complete process
    // scope; the final target then links the already compiled objects.
    for (index, objects) in compile_plan
        .object_targets
        .chunks(OBJECTS_PER_INVOCATION)
        .enumerate()
    {
        compile_plan.require_unchanged(&work.join("build"))?;
        let mut arguments = vec![
            "-C".into(),
            cmake_path(&work.join("build"))?,
            "-j".into(),
            "2".into(),
        ];
        arguments.extend(objects.iter().cloned());
        session.run(
            &arguments,
            "bin/ninja.exe",
            &format!("install.cartridge.objects.{index}"),
            quiesced,
        )?;
        compile_plan.require_unchanged(&work.join("build"))?;
    }
    inputs.verify(&preparation.source, &checkpoint)?;
    compile_plan.require_unchanged(&work.join("build"))?;
    session.run(
        &[
            "--build".into(),
            cmake_path(&work.join("build"))?,
            "--config".into(),
            "Release".into(),
            "--parallel".into(),
            "2".into(),
            "--target".into(),
            facts.target.into(),
        ],
        "bin/cmake.exe",
        "install.cartridge.compile",
        quiesced,
    )?;
    inputs.verify(&preparation.source, &checkpoint)?;
    compile_plan.require_unchanged(&work.join("build"))?;
    if generated_identity(&work.join("build"), recipe)? != generated {
        return Err(PortcoveError::verification(
            "generated source identity changed during compilation",
        ));
    }
    let package = work.join("runtime");
    fs::create_dir(&package)?;
    for name in [executable.as_str(), "SDL2.dll"] {
        copy_verified(
            &work.join("build").join(name),
            &package.join(name),
            &checkpoint,
        )?;
    }
    for name in ["libc++.dll", "libunwind.dll"] {
        copy_verified(
            &inputs.tool(&format!("bin/{name}"))?,
            &package.join(name),
            &checkpoint,
        )?;
    }
    let assets = inventory(&work.join("build/assets"), &checkpoint)?;
    let expected = [
        "fonts/LatoLatin-Bold.ttf",
        "fonts/LatoLatin-Regular.ttf",
        "fonts/NotoSansSymbols2-Regular.ttf",
        "fonts/OpenMoji-black-glyf.ttf",
        "img/boxart.tga",
        "img/brand_mark.tga",
        "img/brand_nes.tga",
        "img/flags.png",
        "img/pad_nes.tga",
        "img/verdict_bad.tga",
        "img/verdict_none.tga",
        "img/verdict_ok.tga",
        "img/verdict_warn.tga",
    ];
    if assets.iter().map(|f| f.path.as_str()).collect::<Vec<_>>() != expected {
        return Err(PortcoveError::verification(
            "built runtime asset inventory differs",
        ));
    }
    for asset in &assets {
        copy_verified(
            &work.join("build/assets").join(&asset.path),
            &package.join("assets").join(&asset.path),
            &checkpoint,
        )?;
    }
    for (part, from, to) in [
        (0, "LICENSE", "Game-LICENSE.txt"),
        (1, "LICENSE", "NESRecomp-LICENSE.txt"),
        (1, "runner/external/SDL2/COPYING.txt", "SDL2-COPYING.txt"),
        (2, "src/third_party/imgui/LICENSE.txt", "ImGui-LICENSE.txt"),
        (2, "assets/common/fonts/NOTICE.md", "Font-NOTICE.md"),
        (2, "assets/common/img/NOTICE.md", "Image-NOTICE.md"),
        (3, "LICENSE.TXT", "LLVM-LICENSE.txt"),
    ] {
        copy_verified(
            &inputs.roots[part].join(from),
            &package.join("licenses").join(to),
            &checkpoint,
        )?;
    }
    copy_verified(
        &preparation.source.path,
        &package.join("game.nes"),
        &checkpoint,
    )?;
    let mut imports = BTreeMap::new();
    for (index, name) in [
        executable.as_str(),
        "SDL2.dll",
        "libc++.dll",
        "libunwind.dll",
    ]
    .into_iter()
    .enumerate()
    {
        imports.insert(
            name,
            session.inspect_imports(
                &package.join(name),
                &format!("install.cartridge.imports.{index}"),
                quiesced,
            )?,
        );
    }
    inputs.verify(&preparation.source, &checkpoint)?;
    if crate::adapter::hash_file(&host)? != host_identity {
        return Err(PortcoveError::verification(
            "generated host compiler changed during execution",
        ));
    }
    let output = inventory(&package, &checkpoint)?;
    let mut receipt = serde_json::json!({"format_version":1,"recipe":preparation.recipe,"runtime_origin":"locally-built","original_sha256":facts.original_sha256,"original_size":facts.original_size,"sources":[{"archive_sha256":facts.game.sha256,"tree_sha256":digest(&serde_json::to_vec(&inputs.identities[0])?)},{"archive_sha256":ENGINE.sha256,"tree_sha256":digest(&serde_json::to_vec(&inputs.identities[1])?)},{"archive_sha256":UI.sha256,"tree_sha256":digest(&serde_json::to_vec(&inputs.identities[2])?)}],"auxiliary_archives":recipe.archives(),"auxiliary_transport":"HTTPS to fixed GitHub/codeload/artifact CDN hosts; no delegated primary grant","toolchain_archive_sha256":TOOLCHAIN.sha256,"toolchain_tree_sha256":digest(&serde_json::to_vec(&inputs.identities[3])?),"source_patch":{"path":PATCH_PATH,"before_sha256":PATCH_BEFORE,"after_sha256":PATCH_AFTER},"configure_arguments":arguments,"cartridge_identity":facts.cartridge_identity,"prg_identity":facts.prg_identity,"generated_manifest_sha256":generated.0,"generated_dispatch_sha256":generated.1,"imports":imports,"runtime_files":output,"builder_quiesced":*quiesced,"game_executed_by_builder":false});
    receipt["compilation"] = serde_json::json!({"plan": compile_plan, "objects_per_invocation": OBJECTS_PER_INVOCATION, "supervisor_event_limit_unchanged": true});
    receipt["host_compiler"] = serde_json::json!({"sha256":host_identity.0,"size":host_identity.1,"imports":host_imports,"configure_arguments":host_arguments});
    if !*quiesced {
        return Err(PortcoveError::state(
            "cartridge builder has no quiescence proof",
        ));
    }
    write_new(
        &package.join(RECEIPT),
        &serde_json::to_vec_pretty(&receipt)?,
    )?;
    verify_original(recipe, &preparation.source, &checkpoint)?;
    // Only the installer-owned, unpublished download payload is replaced. The
    // caller's lifecycle retains the manifest/publication admission boundary.
    let parent = work
        .parent()
        .ok_or_else(|| PortcoveError::state("cartridge build has no operation root"))?;
    if work.file_name() != Some(std::ffi::OsStr::new("cartridge-build"))
        || payload != parent.join("payload")
    {
        return Err(PortcoveError::state(
            "cartridge build output is outside its private operation",
        ));
    }
    crate::path::refuse_symlink_ancestors(payload)?;
    crate::durability::rename_noreplace(payload, &work.join("primary-runtime-input"))?;
    crate::durability::rename_noreplace(&package, payload)?;
    checkpoint()
}
