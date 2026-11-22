//! Typed release-artifact facts.
//!
//! Every release asset Core classifies receives a typed role, target operating
//! system, target architecture and the [`FactSource`] that established them.
//! Sources have a fixed precedence. A filename is only ever a suggestion: it
//! can describe an asset and keep a release outside another platform's stream,
//! but it never authorizes a desktop game runtime by itself.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Platform;

/// Version of the filename suggestion rules in [`suggest_from_filename`].
pub const FILENAME_RULE_VERSION: u32 = 1;

/// What an artifact is. Only [`ArtifactRole::DesktopGameRuntime`] may become a
/// launch target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactRole {
    DesktopGameRuntime,
    DesktopGameData,
    DedicatedServer,
    Builder,
    Installer,
    Importer,
    Compiler,
    DevTool,
    OriginalGameInput,
    MobilePackage,
    ConsoleOutput,
    Documentation,
    SourceArchive,
    IntegrityMetadata,
    DebugSymbols,
    Unknown,
}

impl ArtifactRole {
    /// Supporting files that never install or run a game client.
    pub fn is_supporting(self) -> bool {
        matches!(
            self,
            Self::DedicatedServer
                | Self::Documentation
                | Self::SourceArchive
                | Self::IntegrityMetadata
                | Self::DebugSymbols
        )
    }

    /// Roles that are a player for some platform, even a foreign one.
    fn is_foreign_player(self) -> bool {
        matches!(self, Self::MobilePackage | Self::ConsoleOutput)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TargetOs {
    Windows,
    Linux,
    Macos,
    Android,
    Ios,
    Console,
    Web,
    Unknown,
}

impl TargetOs {
    pub fn of(platform: Platform) -> Self {
        match platform {
            Platform::WindowsX86_64 => Self::Windows,
            Platform::LinuxX86_64 => Self::Linux,
            Platform::MacosX86_64 | Platform::MacosAarch64 => Self::Macos,
        }
    }

    /// A known operating system other than the platform's. Unknown is never
    /// a refusal by itself.
    pub fn excludes(self, platform: Platform) -> bool {
        self != Self::Unknown && self != Self::of(platform)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum TargetArch {
    #[serde(rename = "x86-64")]
    X86_64,
    #[serde(rename = "aarch64")]
    Aarch64,
    #[serde(rename = "x86")]
    X86,
    #[serde(rename = "universal")]
    Universal,
    #[serde(rename = "unknown")]
    Unknown,
}

impl TargetArch {
    pub fn of(platform: Platform) -> Self {
        match platform {
            Platform::WindowsX86_64 | Platform::LinuxX86_64 | Platform::MacosX86_64 => Self::X86_64,
            Platform::MacosAarch64 => Self::Aarch64,
        }
    }
}

/// Where a fact came from, highest precedence first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum FactSource {
    /// Machine-readable metadata the release itself publishes.
    ReleaseMetadata { document: String },
    /// A reviewed structural observation of these exact archive bytes.
    ExactReleaseStructured {
        shape_version: u32,
        archive_sha256: String,
    },
    /// Another provider's reviewed record for the same artifact.
    ProviderCrossReference { provider: String, reference: String },
    /// A bounded, versioned extractor for one family of releases.
    FamilyExtractor { extractor: String, version: u32 },
    /// The catalog's reviewed release selectors for this route.
    StableDeclaration,
    /// Filename tokens only; never authorizing.
    FilenameSuggestion { rule_version: u32 },
}

impl FactSource {
    pub fn authorizes(&self) -> bool {
        !matches!(self, Self::FilenameSuggestion { .. })
    }

    /// Lower is higher precedence.
    fn rank(&self) -> u8 {
        match self {
            Self::ReleaseMetadata { .. } => 0,
            Self::ExactReleaseStructured { .. } => 1,
            Self::ProviderCrossReference { .. } => 2,
            Self::FamilyExtractor { .. } => 3,
            Self::StableDeclaration => 4,
            Self::FilenameSuggestion { .. } => 5,
        }
    }
}

/// One package-relative program that may be the game's player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PlayerCandidate {
    pub path: String,
    /// The machine its PE, ELF or Mach-O header names, for example
    /// `pe-x86-64`, `elf64-x86-64`, `macho-arm64` or
    /// `macho-universal-arm64+x86-64`; an unnamed machine keeps its raw
    /// number, for example `pe-0x01c2`. Absent when the source recorded only
    /// a path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtifactFact {
    pub asset_id: u64,
    pub name: String,
    pub size: u64,
    pub sha256: Option<String>,
    pub role: ArtifactRole,
    pub os: TargetOs,
    pub arch: TargetArch,
    pub source: FactSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub players: Vec<PlayerCandidate>,
    /// Set when two authorizing sources disagreed about the role.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub contradictory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ObservedReleaseFacts {
    pub release_id: u64,
    pub tag: String,
    pub published_at: Option<String>,
    pub provider_prerelease: bool,
    /// False means the asset list is UNKNOWN, never "no player".
    pub assets_complete: bool,
    pub artifacts: Vec<ArtifactFact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Coverage {
    Complete,
    Partial { next_cursor: Option<String> },
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LastGood {
    pub observed_at: String,
    pub facts_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FactProvenance {
    pub observed_at: String,
    /// Freshness is owned by the observer configuration; Core reports none.
    pub fresh_until: Option<String>,
    pub coverage: Coverage,
    pub parser: String,
    pub parser_version: u32,
    pub facts_sha256: String,
    pub catalog_definition_sha256: String,
    /// Core interprets one observation; the observer retains last-good facts.
    pub last_good: Option<LastGood>,
}

/// Typed reasons a route holds an artifact or release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RouteHold {
    WrongRole,
    WrongHost,
    ContradictoryRole,
    IncompleteCoverage,
}

impl RouteHold {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WrongRole => "wrong-role",
            Self::WrongHost => "wrong-host",
            Self::ContradictoryRole => "contradictory-role",
            Self::IncompleteCoverage => "incomplete-coverage",
        }
    }
}

/// The role, host and processor one source claims for an artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoleClaim {
    pub source: FactSource,
    pub role: ArtifactRole,
    pub os: TargetOs,
    pub arch: TargetArch,
    pub players: Vec<PlayerCandidate>,
}

/// Provider identity of one asset.
#[derive(Debug, Clone, Copy)]
pub(crate) struct AssetIdentity<'a> {
    pub asset_id: u64,
    pub name: &'a str,
    pub size: u64,
    pub sha256: Option<&'a str>,
}

/// Combine claims by precedence. The highest-precedence claim with a definite
/// role wins; two authorizing claims with different definite roles yield an
/// unknown, contradictory role.
pub(crate) fn assign_role(asset: AssetIdentity<'_>, claims: &[RoleClaim]) -> ArtifactFact {
    let mut ordered = claims.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|claim| claim.source.rank());
    let definite = ordered
        .iter()
        .copied()
        .filter(|claim| claim.role != ArtifactRole::Unknown)
        .collect::<Vec<_>>();
    let authorizing = definite
        .iter()
        .copied()
        .filter(|claim| claim.source.authorizes())
        .collect::<Vec<_>>();
    let contradictory = authorizing
        .iter()
        .any(|claim| claim.role != authorizing[0].role);
    let (role, source, players) = match definite.first() {
        Some(_) if contradictory => (
            ArtifactRole::Unknown,
            authorizing[0].source.clone(),
            Vec::new(),
        ),
        Some(claim) => (claim.role, claim.source.clone(), claim.players.clone()),
        None => (
            ArtifactRole::Unknown,
            ordered.first().map_or(
                FactSource::FilenameSuggestion {
                    rule_version: FILENAME_RULE_VERSION,
                },
                |claim| claim.source.clone(),
            ),
            Vec::new(),
        ),
    };
    // Authorizing sources decide the host. When they disagree the host is
    // unknown, never a refusal; a filename only fills an otherwise unknown host.
    let os = host_fact(&ordered, |claim| claim.os, TargetOs::Unknown);
    let arch = host_fact(&ordered, |claim| claim.arch, TargetArch::Unknown);
    ArtifactFact {
        asset_id: asset.asset_id,
        name: asset.name.to_owned(),
        size: asset.size,
        sha256: asset.sha256.map(str::to_owned),
        role,
        os,
        arch,
        source,
        players,
        contradictory,
    }
}

fn host_fact<T: Copy + PartialEq>(
    ordered: &[&RoleClaim],
    value: impl Fn(&RoleClaim) -> T,
    unknown: T,
) -> T {
    let mut authorized = ordered
        .iter()
        .filter(|claim| claim.source.authorizes())
        .map(|claim| value(claim))
        .filter(|value| *value != unknown);
    if let Some(first) = authorized.next() {
        return if authorized.all(|other| other == first) {
            first
        } else {
            unknown
        };
    }
    ordered
        .iter()
        .map(|claim| value(claim))
        .find(|value| *value != unknown)
        .unwrap_or(unknown)
}

/// Why this fact cannot be the platform's game runtime, if it cannot.
pub(crate) fn runtime_hold(fact: &ArtifactFact, platform: Platform) -> Option<RouteHold> {
    if fact.contradictory {
        return Some(RouteHold::ContradictoryRole);
    }
    if fact.role != ArtifactRole::DesktopGameRuntime || !fact.source.authorizes() {
        return Some(RouteHold::WrongRole);
    }
    fact.os.excludes(platform).then_some(RouteHold::WrongHost)
}

/// What a filename's tokens suggest about an asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FilenameSuggestion {
    pub role: ArtifactRole,
    pub os: TargetOs,
    pub arch: TargetArch,
    /// Named as a debug build; a reviewed whole-filename selector may still
    /// choose it.
    pub debug_build: bool,
    /// A desktop package or archive form.
    pub package_form: bool,
}

impl FilenameSuggestion {
    pub(crate) fn claim(self) -> RoleClaim {
        RoleClaim {
            source: FactSource::FilenameSuggestion {
                rule_version: FILENAME_RULE_VERSION,
            },
            role: self.role,
            os: self.os,
            arch: self.arch,
            players: Vec::new(),
        }
    }

    /// A player named only for another operating system or device class.
    pub(crate) fn foreign_player(self, platform: Platform) -> bool {
        (self.package_form || self.role.is_foreign_player()) && self.os.excludes(platform)
    }
}

pub(crate) const ARCHIVE_FORMS: &[&str] = &[".zip", ".7z", ".tar.gz", ".tar.xz", ".tgz", ".rar"];
pub(crate) const OTHER_PACKAGE_FORMS: &[&str] = &[
    ".exe",
    ".msi",
    ".appimage",
    ".dmg",
    ".pkg",
    ".deb",
    ".rpm",
    ".7z",
    ".tar.xz",
];

const MOBILE_FORMS: &[&str] = &[".apk", ".aab", ".ipa"];
const CONSOLE_FORMS: &[&str] = &[".nro", ".nsp", ".vpk", ".wad", ".dol"];
const SUPPORTING_EXTENSIONS: &[&str] = &[
    ".sha256",
    ".sha512",
    ".sha1",
    ".md5",
    ".sig",
    ".asc",
    ".minisig",
    ".json",
    ".yml",
    ".yaml",
    ".blockmap",
    ".zsync",
];
const SOURCE_EXTENSIONS: &[&str] = &[
    ".dsc",
    ".orig.tar.gz",
    ".orig.tar.xz",
    ".debian.tar.xz",
    ".diff.gz",
];

fn tokens(name: &str) -> Vec<&str> {
    name.split(|c: char| !c.is_ascii_alphanumeric()).collect()
}

/// Operating systems a filename names.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct NamedSystems {
    pub windows: bool,
    pub linux: bool,
    pub mac: bool,
    android: bool,
    ios: bool,
    console: bool,
}

impl NamedSystems {
    fn foreign(self) -> bool {
        self.android || self.ios || self.console
    }

    pub(crate) fn count(self) -> usize {
        [self.windows, self.linux, self.mac, self.foreign()]
            .into_iter()
            .filter(|named| *named)
            .count()
    }

    fn os(self) -> TargetOs {
        if self.count() != 1 {
            return TargetOs::Unknown;
        }
        if self.windows {
            TargetOs::Windows
        } else if self.linux {
            TargetOs::Linux
        } else if self.mac {
            TargetOs::Macos
        } else if self.android {
            // One foreign device class at a time, most specific first.
            TargetOs::Android
        } else if self.ios {
            TargetOs::Ios
        } else {
            TargetOs::Console
        }
    }
}

pub(crate) fn named_systems(name: &str) -> NamedSystems {
    let name = name.to_ascii_lowercase();
    let tokens = tokens(&name);
    let has = |values: &[&str]| values.iter().any(|value| tokens.contains(value));
    let versioned_macos = tokens.iter().any(|token| {
        token
            .strip_prefix("macos")
            .is_some_and(|major| major.len() == 2 && major.parse::<u8>().is_ok_and(|v| v >= 10))
    });
    NamedSystems {
        windows: has(&["windows", "win", "win32", "win64", "winx64"])
            || name.ends_with(".exe")
            || name.ends_with(".msi"),
        linux: has(&["linux", "appimage", "flatpak"])
            || [".appimage", ".deb", ".rpm"]
                .iter()
                .any(|ext| name.ends_with(ext)),
        mac: has(&["mac", "macos", "osx", "darwin"])
            || versioned_macos
            || name.ends_with(".dmg")
            || name.ends_with(".pkg"),
        android: has(&["android"]) || name.ends_with(".apk"),
        ios: has(&["ios"]),
        // PortMaster packages target handheld Linux firmware, not desktop systems.
        console: has(&["switch", "vita", "wii", "portmaster"]),
    }
}

/// Processor tokens a filename names.
#[derive(Debug, Clone, Copy)]
pub(crate) struct NamedProcessors {
    pub arm: bool,
    pub intel: bool,
    pub legacy: bool,
    pub universal: bool,
}

/// `macos_arm` is true when a bare `arm` token means Apple Silicon.
pub(crate) fn named_processors(name: &str, macos_arm: bool) -> NamedProcessors {
    let name = name.to_ascii_lowercase();
    let tokens = tokens(&name);
    let has = |values: &[&str]| values.iter().any(|value| tokens.contains(value));
    let macos_arm = macos_arm && has(&["arm"]);
    let arm = has(&["arm64", "aarch64"]) || macos_arm;
    let intel = has(&["x64", "amd64", "win64", "winx64", "intel"])
        || name.contains("x86_64")
        || name.contains("x86-64");
    let legacy = has(&[
        "i386", "i686", "win32", "x32", "32bit", "armv6", "armv7", "armv8",
    ]) || name.contains("32-bit")
        || name.contains("32_bit")
        || (has(&["arm"]) && !macos_arm)
        || (has(&["x86"]) && !intel);
    let universal = has(&["universal", "universal2"]) || (arm && intel);
    NamedProcessors {
        arm,
        intel,
        legacy,
        universal,
    }
}

/// Supporting-file role a lowercase filename names, ignoring debug builds.
fn supporting_role(name: &str, tokens: &[&str]) -> Option<ArtifactRole> {
    let has = |values: &[&str]| values.iter().any(|value| tokens.contains(value));
    let archive = ARCHIVE_FORMS.iter().any(|ext| name.ends_with(ext));
    if crate::service::package_selection::is_server_package(name) {
        Some(ArtifactRole::DedicatedServer)
    } else if has(&["checksums", "checksum", "sha256sums", "sha512sums"])
        || SUPPORTING_EXTENSIONS.iter().any(|ext| name.ends_with(ext))
    {
        Some(ArtifactRole::IntegrityMetadata)
    } else if has(&["symbols", "pdb", "dsym"]) {
        Some(ArtifactRole::DebugSymbols)
    } else if SOURCE_EXTENSIONS.iter().any(|ext| name.ends_with(ext))
        || (archive && has(&["source", "sources", "src"]))
    {
        Some(ArtifactRole::SourceArchive)
    } else if name.ends_with(".txt")
        || (archive && has(&["notices"]))
        || crate::service::package_selection::is_license_compliance_archive(name)
    {
        Some(ArtifactRole::Documentation)
    } else {
        None
    }
}

/// Tool role a filename or package path segment names.
fn tool_role(tokens: &[&str]) -> Option<ArtifactRole> {
    let has = |values: &[&str]| values.iter().any(|value| tokens.contains(value));
    if has(&[
        "installer",
        "setup",
        "uninstall",
        "unins000",
        "vcredist",
        "redist",
    ]) {
        Some(ArtifactRole::Installer)
    } else if has(&["builder"]) {
        Some(ArtifactRole::Builder)
    } else if has(&[
        "compiler",
        "toolchain",
        "tcc",
        "gcc",
        "clang",
        "python",
        "pythonw",
    ]) {
        Some(ArtifactRole::Compiler)
    } else if has(&["importer", "extractor"]) {
        Some(ArtifactRole::Importer)
    } else if has(&["sdk", "devkit", "editor", "tools"]) {
        Some(ArtifactRole::DevTool)
    } else {
        None
    }
}

/// The single filename classifier. Its result is a
/// [`FactSource::FilenameSuggestion`] and never authorizes a runtime.
pub(crate) fn suggest_from_filename(name: &str) -> FilenameSuggestion {
    let name = name.to_ascii_lowercase();
    let tokens = tokens(&name);
    let systems = named_systems(&name);
    // A mobile package form names its device class even without a token.
    let os = match systems.os() {
        TargetOs::Unknown if systems.count() == 0 && name.ends_with(".ipa") => TargetOs::Ios,
        TargetOs::Unknown if systems.count() == 0 && name.ends_with(".aab") => TargetOs::Android,
        os => os,
    };
    let processors = named_processors(&name, os == TargetOs::Macos);
    let arch = if processors.universal {
        TargetArch::Universal
    } else if processors.arm {
        TargetArch::Aarch64
    } else if processors.intel {
        TargetArch::X86_64
    } else if processors.legacy && !tokens.iter().any(|token| token.starts_with("arm")) {
        TargetArch::X86
    } else {
        TargetArch::Unknown
    };
    let package_form = ARCHIVE_FORMS
        .iter()
        .chain(OTHER_PACKAGE_FORMS)
        .any(|extension| name.ends_with(extension));
    let role = if let Some(role) = supporting_role(&name, &tokens) {
        role
    } else if matches!(os, TargetOs::Android | TargetOs::Ios)
        && (package_form || MOBILE_FORMS.iter().any(|ext| name.ends_with(ext)))
    {
        ArtifactRole::MobilePackage
    } else if systems.console
        && (package_form || CONSOLE_FORMS.iter().any(|ext| name.ends_with(ext)))
    {
        ArtifactRole::ConsoleOutput
    } else if name.ends_with(".msi") {
        ArtifactRole::Installer
    } else if let Some(role) = tool_role(&tokens) {
        role
    } else if package_form {
        ArtifactRole::DesktopGameRuntime
    } else {
        ArtifactRole::Unknown
    };
    FilenameSuggestion {
        role,
        os,
        arch,
        debug_build: tokens.contains(&"debug"),
        package_form,
    }
}

/// Programs in a reviewed package listing that may be the game's player.
/// Programs under or named as a toolchain, installer, server or development
/// tool are never player candidates.
pub(crate) fn player_candidates(programs: &[String]) -> Vec<PlayerCandidate> {
    programs
        .iter()
        .filter(|path| {
            let lowered = path.to_ascii_lowercase();
            !lowered.split('/').any(|segment| {
                let stem = segment.rsplit_once('.').map_or(segment, |(stem, _)| stem);
                tool_role(&tokens(stem)).is_some()
                    || crate::service::package_selection::is_server_package(stem)
            })
        })
        .map(|path| PlayerCandidate {
            path: path.clone(),
            machine: None,
            sha256: None,
        })
        .collect()
}

/// The claim a reviewed exact package observation makes, if one applies.
///
/// Shape version 2 entries record the players derived from the reviewed bytes,
/// with machine and digest. When any applicable entry predates them, the
/// claim keeps the version 1 path-only rule and names version 1.
pub(crate) fn structured_claim(port: &crate::PortDefinition, sha256: &str) -> Option<RoleClaim> {
    crate::package_shape::reviewed_archive(port, sha256)
        .map(|archive| archive_claim(archive, sha256))
}

/// The claim one reviewed archive observation makes.
pub(crate) fn archive_claim(
    archive: crate::package_shape::ReviewedArchive,
    sha256: &str,
) -> RoleClaim {
    let crate::package_shape::ReviewedArchive {
        shape_version,
        platforms,
        programs,
        players,
    } = archive;
    let os = platforms
        .iter()
        .map(|platform| TargetOs::of(*platform))
        .reduce(|left, right| {
            if left == right {
                left
            } else {
                TargetOs::Unknown
            }
        })
        .unwrap_or(TargetOs::Unknown);
    let arch = platforms
        .iter()
        .map(|platform| TargetArch::of(*platform))
        .reduce(|left, right| {
            if left == right {
                left
            } else {
                TargetArch::Unknown
            }
        })
        .unwrap_or(TargetArch::Unknown);
    let players = players.unwrap_or_else(|| player_candidates(&programs));
    RoleClaim {
        source: FactSource::ExactReleaseStructured {
            shape_version,
            archive_sha256: sha256.to_owned(),
        },
        role: if players.is_empty() {
            ArtifactRole::Unknown
        } else {
            ArtifactRole::DesktopGameRuntime
        },
        os,
        arch,
        players,
    }
}

/// The claim the catalog's reviewed selectors make for the asset they choose.
pub(crate) fn declared_runtime(platform: Platform) -> RoleClaim {
    RoleClaim {
        source: FactSource::StableDeclaration,
        role: ArtifactRole::DesktopGameRuntime,
        os: TargetOs::of(platform),
        arch: TargetArch::Unknown,
        players: Vec::new(),
    }
}

#[cfg(test)]
#[path = "route_facts_tests.rs"]
mod tests;
