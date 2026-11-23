//! Derived upstream package shapes and release-drift verdicts (#5359).
//!
//! A managed route follows the newest upstream release its selector matches.
//! A release can keep matching while it changes reviewed behavior, for example
//! by moving mod state, shipping a file over a declared persistent path or
//! adding a program. Core derives a bounded [`PackageShape`] from the extracted
//! package and compares it with a reviewed baseline: the generated table
//! derived from artifacts the catalog already marks as reviewed, an explicit
//! `reviewed_package_layouts` fingerprint, or the shape recorded by the active
//! local installation.
//!
//! Managed portable installs withhold known drift before publication. Unknown
//! components remain visible alongside the existing reviewed-layout checks.
//! Manifests store records as untyped JSON and read them with [`stored_record`]
//! so they can handle records from different Portcove versions.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{AdapterKind, Catalog, Platform, PortDefinition, PortcoveError, Result};

mod listing;
pub(crate) mod machine;
pub(crate) mod withheld;

pub use listing::{ListingArtifactInspection, inspect_listing_artifact_archive};

/// Version of the derivation rules the generated table records. Version 2
/// adds machine-typed player candidates to the six shape components; the
/// component rules are those of [`COMPONENT_RULES_VERSION`].
pub(crate) const SHAPE_VERSION: u32 = 2;
/// The oldest derivation version whose component rules equal this build's.
/// Records from this version through [`SHAPE_VERSION`] are baselines; any
/// other version is not. Records that carry components only (installation
/// manifests and withheld observations) are written at this version, so
/// earlier Portcove builds keep reading them.
pub(crate) const COMPONENT_RULES_VERSION: u32 = 1;

/// Whether a record of this derivation version has this build's component rules.
pub(crate) fn readable_shape_version(version: u32) -> bool {
    (COMPONENT_RULES_VERSION..=SHAPE_VERSION).contains(&version)
}
/// First template capability that withholds a package with known shape drift.
pub(crate) fn enforcement_capability(adapter: AdapterKind) -> Option<u32> {
    match adapter {
        AdapterKind::NativePortable => Some(38),
        AdapterKind::StagedSourcePortable => Some(37),
        AdapterKind::N64RecompPortable => Some(7),
        AdapterKind::LibultrashipPortable | AdapterKind::PsxRecompManaged => Some(5),
        AdapterKind::GeneratedCache => Some(4),
        AdapterKind::ReferencedDisc | AdapterKind::UpstreamManagedSetup => None,
    }
}

/// Embedded/legacy definitions use this build's template. Indexed definitions
/// use the supported template version selected by their capability contract.
pub(crate) fn selected_enforcement_capability(
    catalog: &Catalog,
    port: &PortDefinition,
) -> Result<Option<u32>> {
    let Some(minimum) = enforcement_capability(port.adapter) else {
        return Ok(None);
    };
    let Some(snapshot) = catalog.definition_snapshot(&port.id) else {
        return Ok(Some(minimum));
    };
    let template = serde_json::to_value(port.adapter)?;
    let projection = snapshot.projection()?;
    Ok(projection
        .entry()
        .capabilities()
        .checks
        .iter()
        .find(|check| {
            template.as_str() == Some(check.requirement.template.as_str())
                && check.outcome == crate::DefinitionCapabilityOutcome::Supported
        })
        .and_then(|check| check.installed_version)
        .filter(|version| *version >= minimum))
}

const TABLE_FORMAT: u32 = 1;
const MAXIMUM_ENTRIES: usize = 200_000;
/// Bound on all recorded paths of one shape together.
const MAXIMUM_SHAPE_PATHS: usize = 16_384;
/// Bound on the paths each verdict change lists; counts stay exact.
const REPORTED_CHANGE_PATHS: usize = 32;
/// Configuration formats whose addition or removal is reviewed (owner decision D3).
const CONFIG_EXTENSIONS: &[&str] = &["ini", "cfg", "toml", "json", "xml"];

static GENERATED_TABLE: &str = include_str!("../catalog/package-shapes.generated.json");

/// One reviewed part of a package shape.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ShapeComponent {
    /// Programs and scripts at any depth, by the reviewed layout classifier.
    Programs,
    /// Top-level directories of the package root.
    TopDirectories,
    /// Child folders under the parent of each declared persistent path, and
    /// under each declared persistent path the package ships as a folder.
    PersistentParentChildren,
    /// Shipped files at or under a declared persistent path or pattern.
    PersistentOverlap,
    /// Shipped `.ini`, `.cfg`, `.toml`, `.json` and `.xml` files at any depth.
    ConfigFiles,
    /// Parents of declared persistent paths that the package does not ship.
    MissingPersistentParents,
}

impl ShapeComponent {
    pub const ALL: [Self; 6] = [
        Self::Programs,
        Self::TopDirectories,
        Self::PersistentParentChildren,
        Self::PersistentOverlap,
        Self::ConfigFiles,
        Self::MissingPersistentParents,
    ];
}

/// Lowercase package-relative paths with `/` separators, sorted per part.
/// An absent part is unknown: it was not observed and is never a pass.
/// Unknown fields are ignored so that a part added by a later derivation
/// version cannot make this build's records unreadable; the generated table
/// generator rejects them separately.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PackageShape {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub programs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_directories: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistent_parent_children: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistent_overlap: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_persistent_parents: Option<Vec<String>>,
}

impl PackageShape {
    pub fn component(&self, component: ShapeComponent) -> Option<&[String]> {
        match component {
            ShapeComponent::Programs => self.programs.as_deref(),
            ShapeComponent::TopDirectories => self.top_directories.as_deref(),
            ShapeComponent::PersistentParentChildren => self.persistent_parent_children.as_deref(),
            ShapeComponent::PersistentOverlap => self.persistent_overlap.as_deref(),
            ShapeComponent::ConfigFiles => self.config_files.as_deref(),
            ShapeComponent::MissingPersistentParents => self.missing_persistent_parents.as_deref(),
        }
    }

    fn is_canonical(&self) -> bool {
        let mut total = 0;
        ShapeComponent::ALL.iter().all(|&component| {
            let Some(paths) = self.component(component) else {
                return true;
            };
            total += paths.len();
            paths.windows(2).all(|pair| pair[0] < pair[1])
                && paths.iter().all(|path| {
                    !path.bytes().any(|byte| byte.is_ascii_uppercase())
                        && crate::archive::validate_relative_path(path, false).is_ok()
                })
        }) && total <= MAXIMUM_SHAPE_PATHS
    }
}

/// How much a recorded shape can stand in for a review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ShapeProvenance {
    /// The exact artifact is listed in the generated reviewed table.
    Reviewed,
    /// Every compared part equals a reviewed or inherited baseline's parts.
    /// It says nothing about package content outside those parts, so it is
    /// weaker than `reviewed`.
    Inherited,
    /// Neither; never evidence of review.
    Unreviewed,
}

/// The baseline a verdict compared against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum ShapeBaseline {
    /// A generated table entry; `exact` when it is the candidate artifact itself.
    Generated {
        version: String,
        sha256: String,
        exact: bool,
    },
    /// The catalog's explicit `reviewed_package_layouts` fingerprint, which
    /// knows only programs and top-level directories.
    ReviewedLayout,
    /// The shape recorded by the active local installation.
    Local {
        install_id: String,
        version: String,
        sha256: String,
        provenance: ShapeProvenance,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ShapeUnknownReason {
    /// No generated, explicit or local baseline exists for this route and platform.
    NoBaseline,
    /// Every compared part matched, but some part is unknown on one side.
    IncompleteComparison,
    /// The package shape could not be derived.
    ObservationFailed,
}

/// One part that differs from the baseline. Lists are bounded; counts are exact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ShapeChange {
    pub component: ShapeComponent,
    pub added_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<String>,
    pub removed_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<String>,
}

/// The comparison verdict for one candidate package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ShapeVerdict {
    Compatible {
        baseline: ShapeBaseline,
    },
    Drifted {
        baseline: ShapeBaseline,
        changes: Vec<ShapeChange>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        unknown: Vec<ShapeComponent>,
    },
    Unknown {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        baseline: Option<ShapeBaseline>,
        reason: ShapeUnknownReason,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        unknown: Vec<ShapeComponent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

impl ShapeVerdict {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Compatible { .. } => "compatible",
            Self::Drifted { .. } => "drifted",
            Self::Unknown { .. } => "unknown",
        }
    }
}

/// An unreviewed local observation can explain drift, but cannot withhold a release.
pub(crate) fn withholds_release(verdict: &ShapeVerdict) -> bool {
    matches!(
        verdict,
        ShapeVerdict::Drifted { baseline, .. }
            if !matches!(baseline, ShapeBaseline::Local { provenance: ShapeProvenance::Unreviewed, .. })
    )
}

/// The shape and shadow verdict an installation records in its manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PackageShapeRecord {
    pub shape_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<PackageShape>,
    pub provenance: ShapeProvenance,
    pub verdict: ShapeVerdict,
}

/// Read-only result of `catalog inspect-package-shape`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PackageShapeInspection {
    pub port_id: String,
    pub platform: Platform,
    pub sha256: String,
    pub shape_version: u32,
    pub shape: PackageShape,
    pub provenance: ShapeProvenance,
    pub verdict: ShapeVerdict,
    /// Digest of the embedded catalog facts this derivation read for the
    /// route platform; absent when the embedded catalog lacks the route. The
    /// table generator refuses to record a shape whose digest differs from
    /// the catalog it records against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derivation_inputs_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predecessor_observation: Option<crate::PackageLayoutObservation>,
    /// The players these exact bytes contain (shape version 2): the route's
    /// declared launch target when it is a reviewed program outside any tool,
    /// installer or server location and its header is a native executable,
    /// with its machine and SHA-256. Empty when none qualifies.
    #[serde(default)]
    pub player_candidates: Vec<crate::PlayerCandidate>,
}

/// Whether an installation's manifest holds a package shape this build reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InstalledShapeStatus {
    /// The manifest records a shape and verdict this build understands.
    Recorded,
    /// The manifest predates package shapes or the install recorded none.
    NotRecorded,
    /// The manifest records a shape from another derivation version or in a
    /// form this build does not understand, for example from a newer Portcove.
    Unrecognized,
    /// The manifest could not be read or does not match its registered identity.
    ManifestUnverifiable,
}

/// Recorded shape of one installation, for read-only diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InstalledPackageShape {
    pub install_id: String,
    pub version: String,
    pub active: bool,
    pub status: InstalledShapeStatus,
    /// Present only when `status` is `recorded`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<PackageShapeRecord>,
    /// The manifest verification error when `status` is `manifest_unverifiable`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Read a record stored in an install manifest. Manifests keep the record as
/// untyped JSON so a record written by another Portcove version never makes
/// the manifest unreadable; anything this build does not fully understand,
/// including another derivation version, is no record.
pub(crate) fn stored_record(value: &serde_json::Value) -> Option<PackageShapeRecord> {
    let record = PackageShapeRecord::deserialize(value).ok()?;
    (readable_shape_version(record.shape_version)
        && record.shape.as_ref().is_none_or(PackageShape::is_canonical))
    .then_some(record)
}

/// The JSON a new install manifest stores for its record.
pub(crate) fn stored_value(record: &PackageShapeRecord) -> Option<serde_json::Value> {
    serde_json::to_value(record).ok()
}

#[derive(Debug, Clone, Deserialize)]
struct GeneratedTable {
    format: u32,
    shape_version: u32,
    entries: Vec<GeneratedEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct GeneratedEntry {
    port_id: String,
    platform: Platform,
    version: String,
    sha256: String,
    /// Digest of the catalog facts the derivation read for this route and
    /// platform; the generator and the table-currency test compare it.
    derivation_inputs_sha256: String,
    /// The derivation version of this entry; absent means the table's.
    #[serde(default)]
    shape_version: Option<u32>,
    shape: PackageShape,
    /// Version 2: the players these exact bytes contain, with machine and digest.
    #[serde(default)]
    player_candidates: Option<Vec<crate::PlayerCandidate>>,
}

impl GeneratedEntry {
    fn version(&self, table: u32) -> u32 {
        self.shape_version.unwrap_or(table)
    }

    /// Version 1 entries carry no players; later entries carry canonical
    /// players drawn from their own programs.
    fn players_are_canonical(&self, version: u32) -> bool {
        let Some(players) = &self.player_candidates else {
            return version < PLAYER_CANDIDATES_VERSION;
        };
        version >= PLAYER_CANDIDATES_VERSION
            && players.windows(2).all(|pair| pair[0].path < pair[1].path)
            && players.iter().all(|player| {
                self.shape
                    .programs
                    .as_ref()
                    .is_some_and(|programs| programs.binary_search(&player.path).is_ok())
                    && player.sha256.as_deref().is_some_and(lowercase_digest)
                    && player.machine.as_deref().is_some_and(canonical_machine)
            })
    }
}

/// First derivation version that records player candidates.
const PLAYER_CANDIDATES_VERSION: u32 = 2;

fn canonical_machine(machine: &str) -> bool {
    (1..=64).contains(&machine.len())
        && machine
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'+'))
}

/// What the generated table knows about exact reviewed archive bytes.
pub(crate) struct ReviewedArchive {
    /// The oldest derivation version among the applicable entries.
    pub shape_version: u32,
    pub platforms: Vec<Platform>,
    pub programs: Vec<String>,
    /// Present when every applicable entry records player candidates.
    pub players: Option<Vec<crate::PlayerCandidate>>,
}

fn generated_table() -> &'static [GeneratedEntry] {
    static TABLE: OnceLock<Vec<GeneratedEntry>> = OnceLock::new();
    TABLE.get_or_init(|| parse_table(GENERATED_TABLE).unwrap_or_default())
}

/// Exact, independently reviewed versions whose observations still apply to this route.
pub(crate) fn reviewed_release_digests(
    port: &PortDefinition,
    platform: Platform,
) -> Vec<(&'static str, &'static str)> {
    let mut route = generated_table()
        .iter()
        .filter(|entry| entry.port_id == port.id && entry.platform == platform)
        .peekable();
    if route.peek().is_none() {
        return Vec::new();
    }
    let Some(inputs) = applicable_generated_inputs(port, platform) else {
        return Vec::new();
    };
    route
        .filter(|entry| entry.derivation_inputs_sha256 == inputs)
        .map(|entry| (entry.version.as_str(), entry.sha256.as_str()))
        .collect()
}

/// Reviewed programs and players of exact archive bytes whose observations
/// still apply to this route, with the platforms they were reviewed for.
pub(crate) fn reviewed_archive(port: &PortDefinition, sha256: &str) -> Option<ReviewedArchive> {
    reviewed_archive_in(generated_table(), port, sha256)
}

fn reviewed_archive_in(
    table: &[GeneratedEntry],
    port: &PortDefinition,
    sha256: &str,
) -> Option<ReviewedArchive> {
    let mut platforms = Vec::new();
    let mut programs = BTreeSet::new();
    let mut version = SHAPE_VERSION;
    let mut players = Some(BTreeMap::<(String, Option<String>, Option<String>), _>::new());
    for entry in table
        .iter()
        .filter(|entry| entry.port_id == port.id && entry.sha256.eq_ignore_ascii_case(sha256))
    {
        if applicable_generated_inputs(port, entry.platform).as_deref()
            != Some(entry.derivation_inputs_sha256.as_str())
        {
            continue;
        }
        platforms.push(entry.platform);
        programs.extend(entry.shape.programs.iter().flatten().cloned());
        let entry_version = entry.version(SHAPE_VERSION);
        version = version.min(entry_version);
        match (&mut players, &entry.player_candidates) {
            (Some(found), Some(candidates)) => {
                for player in candidates {
                    found.insert(
                        (
                            player.path.clone(),
                            player.machine.clone(),
                            player.sha256.clone(),
                        ),
                        player.clone(),
                    );
                }
            }
            _ => players = None,
        }
    }
    (!platforms.is_empty()).then(|| ReviewedArchive {
        shape_version: version,
        platforms,
        programs: programs.into_iter().collect(),
        players: players.map(|found| found.into_values().collect()),
    })
}

fn parse_table(text: &str) -> Result<Vec<GeneratedEntry>> {
    let mut table: GeneratedTable = serde_json::from_str(text)?;
    // The table states the version its generator wrote; each entry may keep
    // an older readable version until it is re-derived.
    if table.format != TABLE_FORMAT
        || !readable_shape_version(table.shape_version)
        || table.entries.iter().any(|entry| {
            let version = entry.version(table.shape_version);
            !readable_shape_version(version)
                || !entry.players_are_canonical(version)
                || !entry.shape.is_canonical()
                || ShapeComponent::ALL
                    .iter()
                    .any(|&component| entry.shape.component(component).is_none())
                || !lowercase_digest(&entry.sha256)
                || !lowercase_digest(&entry.derivation_inputs_sha256)
        })
    {
        return Err(PortcoveError::verification(
            "generated package shape table is not current",
        ));
    }
    for entry in &mut table.entries {
        entry.shape_version = Some(entry.version(table.shape_version));
    }
    Ok(table.entries)
}

fn lowercase_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
static LIMITED_DERIVATION_ROOTS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

/// Test seam: packages under `root` derive with one-entry bounds, so a test
/// can exercise a derivation failure inside a real install.
#[cfg(test)]
pub(crate) fn limit_derivation_under(root: &Path) {
    let mut roots = LIMITED_DERIVATION_ROOTS.lock().unwrap();
    roots.push(root.to_path_buf());
    if let Ok(canonical) = root.canonicalize() {
        roots.push(canonical);
    }
}

fn maximum_entries(package: &Path) -> usize {
    #[cfg(test)]
    if LIMITED_DERIVATION_ROOTS
        .lock()
        .unwrap()
        .iter()
        .any(|root| package.starts_with(root))
    {
        return 1;
    }
    let _ = package;
    MAXIMUM_ENTRIES
}

/// Digest of the raw catalog facts `roots`, `derive` and `anchors` read for
/// one route platform. `derivationInputs` in
/// `scripts/package-shape-baselines.mts` mirrors it; generated entries record
/// it so a catalog edit to those facts makes the entry stale.
pub(crate) fn derivation_inputs_sha256(port: &serde_json::Value, platform: &str) -> Result<String> {
    let runtime_subdirectory = match &port["runtime_subdirectory_by_platform"][platform] {
        serde_json::Value::Null => port["runtime_subdirectory"].clone(),
        value => value.clone(),
    };
    let mut inputs = serde_json::json!({
        "adapter": port["adapter"],
        "executable_hints": port["executable_hints"][platform],
        "external_profile_policy": port["external_profile_policy"],
        "grant_declared_executable": port["release"]["grant_declared_executable"],
        "ignore_verified_macos_libraries":
            port["reviewed_package_layouts"][platform]["ignore_verified_macos_libraries"],
        "launch_from_install_root": port["launch_from_install_root"],
        "managed_shared_preferences": port["managed_shared_preferences"],
        "n64_runtime_at_executable_parent": port["n64_runtime_at_executable_parent"],
        "persistent_file_patterns": port["persistent_file_patterns"],
        "persistent_paths": port["persistent_paths"],
        "runtime_subdirectory": runtime_subdirectory,
        "tar_xz_platforms": port["release"]["tar_xz_platforms"],
    });
    // Recorded only when declared, so digests of routes without it are unchanged.
    let linux_format =
        &port["reviewed_package_layouts"][platform]["classify_linux_programs_by_format"];
    if !linux_format.is_null() {
        inputs["classify_linux_programs_by_format"] = linux_format.clone();
    }
    // The prepared OpenMoHAA programs differ from the raw ZIP modes. A
    // retained observation made before this rule cannot hold the same asset.
    if port["external_profile_policy"] == "openmohaa-unix-v1"
        && matches!(platform, "linux-x86-64" | "macos-x86-64" | "macos-aarch64")
    {
        inputs["openmohaa_prepared_programs"] = serde_json::Value::Bool(true);
    }
    // Older shape readers did not normalize this independently owned path.
    // Observations from those readers cannot establish a new generated baseline.
    if platform == "linux-x86-64" && !port["linux_portable_data_directory"].is_null() {
        inputs["verified_optional_empty_portable_data"] =
            port["linux_portable_data_directory"].clone();
    }
    // The sole N64 app bundle can prove flat install-root siblings absent.
    // Older CLI builds must not record a partial shape under this input digest.
    if port["adapter"] == "n64-recomp-portable"
        && matches!(platform, "macos-x86-64" | "macos-aarch64")
        && (port["launch_from_install_root"] == true
            || port["n64_runtime_at_executable_parent"] != true)
    {
        inputs["n64_macos_flat_persistence_observed"] = serde_json::Value::Bool(true);
    }
    inputs.sort_all_objects();
    Ok(hex::encode(<sha2::Sha256 as sha2::Digest>::digest(
        serde_json::to_string(&inputs)?.as_bytes(),
    )))
}

/// The derivation-input digest of a route platform in the catalog compiled
/// into this build, or `None` when the embedded catalog has no such route.
pub(crate) fn embedded_derivation_inputs_sha256(
    port_id: &str,
    platform: Platform,
) -> Option<String> {
    let port = embedded_raw_port(port_id)?;
    let platform = serde_json::to_value(platform).ok()?;
    derivation_inputs_sha256(&port, platform.as_str()?).ok()
}

fn embedded_raw_port(port_id: &str) -> Option<serde_json::Value> {
    let mut document: serde_json::Value =
        serde_json::from_str(crate::catalog::EMBEDDED_CATALOG).ok()?;
    document["ports"]
        .as_array_mut()?
        .iter_mut()
        .find(|port| port["id"] == port_id)
        .map(serde_json::Value::take)
}

/// Compare the same typed representation on both sides so absent fields and
/// their deserialized defaults cannot look like different derivation inputs.
fn generated_inputs_match(entry: &GeneratedEntry, port: &PortDefinition) -> bool {
    applicable_generated_inputs(port, entry.platform).as_deref()
        == Some(entry.derivation_inputs_sha256.as_str())
}

fn applicable_generated_inputs(port: &PortDefinition, platform: Platform) -> Option<String> {
    let platform_value = serde_json::to_value(platform).ok()?;
    let raw = embedded_raw_port(&port.id)?;
    let inputs = derivation_inputs_sha256(&raw, platform_value.as_str()?).ok()?;
    let embedded = serde_json::from_value(raw).ok()?;
    (same_derivation_inputs(&embedded, port, platform) == Some(true)).then_some(inputs)
}

/// Compare the catalog facts used to derive both shapes on the same platform.
pub(crate) fn same_derivation_inputs(
    baseline: &PortDefinition,
    candidate: &PortDefinition,
    platform: Platform,
) -> Option<bool> {
    let platform = serde_json::to_value(platform).ok()?;
    let platform = platform.as_str()?;
    let baseline =
        derivation_inputs_sha256(&serde_json::to_value(baseline).ok()?, platform).ok()?;
    let candidate =
        derivation_inputs_sha256(&serde_json::to_value(candidate).ok()?, platform).ok()?;
    Some(baseline == candidate)
}

/// Inputs that locate declared persistent paths in an extracted package.
pub(crate) struct ShapeRoots {
    /// The root reviewed layouts observe: the payload after wrapper look-through.
    pub package: PathBuf,
    /// The directory declared persistent paths are relative to, when the
    /// declared executable resolved.
    pub persistence: Option<PathBuf>,
    /// A single app owns the whole payload and its parent owns player data.
    sole_n64_mac_bundle: bool,
    /// A verified optional player data slot at the package root, if declared.
    optional_top_directory: Option<String>,
    /// The route's declared launch target, when it resolved.
    executable: Option<PathBuf>,
}

pub(crate) fn roots(
    port: &PortDefinition,
    qualification: &crate::install::InstallQualification,
    platform: Platform,
    payload: &Path,
) -> Result<ShapeRoots> {
    let package = if crate::runtime::native_mac_bundle_tar_xz(port, platform) {
        payload.to_path_buf()
    } else {
        crate::package_layout::look_through_wrapper(payload)?
    };
    let executable = crate::install::resolve_declared_executable(payload, qualification).ok();
    let persistence = executable
        .as_deref()
        .map(|selected| qualification.persistence_root(payload, selected));
    let sole_n64_mac_bundle = port.adapter == crate::AdapterKind::N64RecompPortable
        && matches!(platform, Platform::MacosX86_64 | Platform::MacosAarch64)
        && persistence.as_deref() == Some(payload)
        && package.parent() == Some(payload)
        && package
            .extension()
            .and_then(std::ffi::OsStr::to_str)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        && executable
            .as_deref()
            .and_then(Path::parent)
            .is_some_and(|parent| parent == package.join("Contents/MacOS"));
    let optional_top_directory = if let Some(name) =
        crate::native_portable_data::directory_name(port, platform)
    {
        let executable = executable.as_deref().ok_or_else(|| {
            PortcoveError::verification("cannot locate the portable Linux player in the package")
        })?;
        let directory =
            crate::native_portable_data::require_pristine_package(payload, executable, name)?;
        (directory.parent() == Some(package.as_path())).then(|| name.to_ascii_lowercase())
    } else {
        None
    };
    Ok(ShapeRoots {
        package,
        persistence,
        sole_n64_mac_bundle,
        optional_top_directory,
        executable,
    })
}

/// Derive the shape of an extracted package before any adapter adds content.
pub(crate) fn derive(
    port: &PortDefinition,
    platform: Platform,
    roots: &ShapeRoots,
) -> Result<PackageShape> {
    let program_filter = crate::package_layout::PackageProgramFilter::of(
        port.reviewed_package_layouts.get(&platform),
    );
    let mut directories = BTreeSet::new();
    // Lowercase relative path to the original file name.
    let mut files = BTreeMap::<String, String>::new();
    let mut programs = BTreeSet::new();
    let mut pending = vec![(roots.package.clone(), String::new())];
    let mut inspected = 0_usize;
    let maximum_entries = maximum_entries(&roots.package);
    while let Some((directory, prefix)) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            inspected += 1;
            if inspected > maximum_entries {
                return Err(PortcoveError::verification(
                    "package has too many entries to derive its shape",
                ));
            }
            let file_type = entry.file_type()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = format!("{prefix}{}", name.to_ascii_lowercase());
            if file_type.is_dir() {
                directories.insert(relative.clone());
                pending.push((entry.path(), format!("{relative}/")));
            } else if file_type.is_file() {
                if crate::package_layout::is_program_entry(&entry, platform, program_filter)? {
                    programs.insert(relative.clone());
                }
                files.insert(relative, name);
            }
        }
    }
    let config_files = files
        .keys()
        .filter(|path| {
            Path::new(path.as_str())
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| CONFIG_EXTENSIONS.contains(&extension))
        })
        .cloned()
        .collect::<BTreeSet<_>>();
    let top_directories = directories
        .iter()
        .filter(|path| {
            !path.contains('/') && Some(path.as_str()) != roots.optional_top_directory.as_deref()
        })
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut shape = PackageShape {
        programs: Some(programs.into_iter().collect()),
        top_directories: Some(top_directories.into_iter().collect()),
        config_files: Some(config_files.into_iter().collect()),
        ..PackageShape::default()
    };
    if let Some(persistence) = &roots.persistence {
        let anchors = anchors(port, platform, roots, persistence);
        let mut children = BTreeSet::new();
        let mut overlap = BTreeSet::new();
        let mut missing = BTreeSet::new();
        let child_directories = |parent: &str, into: &mut BTreeSet<String>| {
            let prefix = format!("{parent}/");
            into.extend(
                directories
                    .iter()
                    .filter(|path| {
                        path.strip_prefix(&prefix)
                            .is_some_and(|rest| !rest.contains('/'))
                    })
                    .cloned(),
            );
        };
        for anchor in &anchors.paths {
            if let Some((parent, _)) = anchor.rsplit_once('/') {
                if directories.contains(parent) {
                    child_directories(parent, &mut children);
                } else {
                    missing.insert(parent.to_owned());
                }
            }
            if directories.contains(anchor) {
                child_directories(anchor, &mut children);
            }
            let under = format!("{anchor}/");
            overlap.extend(
                files
                    .keys()
                    .filter(|path| *path == anchor || path.starts_with(&under))
                    .cloned(),
            );
        }
        if let Some(directory) = &anchors.pattern_directory {
            let patterns = port
                .persistent_file_patterns
                .iter()
                .map(|pattern| crate::PersistentFilePattern {
                    prefix: pattern.prefix.to_ascii_lowercase(),
                    suffix: pattern.suffix.to_ascii_lowercase(),
                    allow_empty_middle: pattern.allow_empty_middle,
                })
                .collect::<Vec<_>>();
            overlap.extend(
                files
                    .keys()
                    .filter(|path| {
                        let (parent, name) = path
                            .rsplit_once('/')
                            .map_or(("", path.as_str()), |(parent, name)| (parent, name));
                        parent == directory && patterns.iter().any(|pattern| pattern.matches(name))
                    })
                    .cloned(),
            );
        }
        // A declared path or pattern that cannot be located relative to the
        // package leaves the persistent parts unknown rather than known-empty.
        if anchors.complete {
            shape.persistent_parent_children = Some(children.into_iter().collect());
            shape.persistent_overlap = Some(overlap.into_iter().collect());
            shape.missing_persistent_parents = Some(missing.into_iter().collect());
        }
    }
    if !shape.is_canonical() {
        return Err(PortcoveError::verification(
            "package shape cannot be represented within its bounds",
        ));
    }
    Ok(shape)
}

struct Anchors {
    /// Declared persistent paths relative to the package root.
    paths: BTreeSet<String>,
    /// The package-relative directory declared file patterns apply to, when
    /// it is inside the package root ("" for the root itself).
    pattern_directory: Option<String>,
    /// Whether every declared path and pattern was located relative to the
    /// package root.
    complete: bool,
}

fn anchors(
    port: &PortDefinition,
    platform: Platform,
    roots: &ShapeRoots,
    persistence: &Path,
) -> Anchors {
    let declared_paths = crate::persistence::declared_paths(port, platform);
    if roots.sole_n64_mac_bundle {
        let bundle_name = roots.package.file_name().and_then(std::ffi::OsStr::to_str);
        if let Some(bundle_name) = bundle_name
            && declared_paths
                .iter()
                .all(|path| !path.contains(['/', '\\']) && !path.eq_ignore_ascii_case(bundle_name))
        {
            // Looking through the sole app proves the install root contains no
            // other entry. Flat siblings and regular files matched by root
            // patterns are absent, and their parent (the install root) exists.
            return Anchors {
                paths: BTreeSet::new(),
                pattern_directory: None,
                complete: true,
            };
        }
    }
    let relative_lower = |path: &Path| -> Option<String> {
        let parts = path
            .components()
            .map(|component| match component {
                std::path::Component::Normal(part) => {
                    Some(part.to_string_lossy().to_ascii_lowercase())
                }
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        Some(parts.join("/"))
    };
    let normalize = |path: &str| path.replace('\\', "/").to_ascii_lowercase();
    // Persistence is normally the package root or one of its folders. With a
    // package wrapper and persistence at the payload root, declared paths name
    // the wrapper first; a path beside the wrapper is outside the package.
    let (inside, outside) = match persistence.strip_prefix(&roots.package) {
        Ok(relative) => (relative_lower(relative), None),
        Err(_) => (
            None,
            roots
                .package
                .strip_prefix(persistence)
                .ok()
                .and_then(relative_lower),
        ),
    };
    let mut paths = BTreeSet::new();
    let mut complete = inside.is_some() || port.persistent_file_patterns.is_empty();
    for declared in declared_paths {
        let declared = normalize(declared);
        let anchored = match (&inside, &outside) {
            (Some(prefix), _) if prefix.is_empty() => Some(declared),
            (Some(prefix), _) => Some(format!("{prefix}/{declared}")),
            (None, Some(wrapper)) => declared
                .strip_prefix(&format!("{wrapper}/"))
                .map(str::to_owned),
            (None, None) => None,
        };
        match anchored {
            Some(anchored) if !anchored.is_empty() => {
                paths.insert(anchored);
            }
            _ => complete = false,
        }
    }
    Anchors {
        paths,
        pattern_directory: inside,
        complete,
    }
}

/// The local fallback baseline: the shape the active installation recorded.
pub(crate) struct LocalBaseline {
    pub install_id: String,
    pub version: String,
    pub sha256: String,
    pub record: PackageShapeRecord,
}

/// Compare an observed shape with the best available baseline.
/// Precedence: the generated table, the explicit reviewed layout, the local
/// installation. A generated entry for the exact artifact is preferred over
/// the route's newest generated entry.
pub(crate) fn evaluate(
    port: &PortDefinition,
    platform: Platform,
    sha256: &str,
    observed: &PackageShape,
    local: Option<&LocalBaseline>,
    reviewed_layout: Option<&crate::ReviewedPackageLayout>,
) -> (ShapeVerdict, ShapeProvenance) {
    let entry = preferred_generated_entry(generated_table(), &port.id, platform, sha256);
    if let Some(entry) = entry
        && !generated_inputs_match(entry, port)
    {
        return (
            ShapeVerdict::Unknown {
                baseline: Some(generated_baseline(entry, sha256)),
                reason: ShapeUnknownReason::IncompleteComparison,
                unknown: ShapeComponent::ALL.to_vec(),
                detail: Some(
                    "The active port definition's package shape inputs could not be matched to the generated baseline."
                        .into(),
                ),
            },
            ShapeProvenance::Unreviewed,
        );
    }
    evaluate_with_generated_entry(
        entry,
        port,
        platform,
        sha256,
        observed,
        local,
        reviewed_layout,
    )
}

fn preferred_generated_entry<'a>(
    table: &'a [GeneratedEntry],
    port_id: &str,
    platform: Platform,
    sha256: &str,
) -> Option<&'a GeneratedEntry> {
    let mut route = table
        .iter()
        .filter(|entry| entry.port_id == port_id && entry.platform == platform);
    route
        .clone()
        .find(|entry| entry.sha256.eq_ignore_ascii_case(sha256))
        .or_else(|| route.next_back())
}

fn generated_baseline(entry: &GeneratedEntry, sha256: &str) -> ShapeBaseline {
    ShapeBaseline::Generated {
        version: entry.version.clone(),
        sha256: entry.sha256.clone(),
        exact: entry.sha256.eq_ignore_ascii_case(sha256),
    }
}

#[cfg(test)]
fn evaluate_with_table(
    table: &[GeneratedEntry],
    port: &PortDefinition,
    platform: Platform,
    sha256: &str,
    observed: &PackageShape,
    local: Option<&LocalBaseline>,
) -> (ShapeVerdict, ShapeProvenance) {
    let entry = preferred_generated_entry(table, &port.id, platform, sha256);
    evaluate_with_generated_entry(entry, port, platform, sha256, observed, local, None)
}

fn evaluate_with_generated_entry(
    entry: Option<&GeneratedEntry>,
    port: &PortDefinition,
    platform: Platform,
    sha256: &str,
    observed: &PackageShape,
    local: Option<&LocalBaseline>,
    reviewed_layout: Option<&crate::ReviewedPackageLayout>,
) -> (ShapeVerdict, ShapeProvenance) {
    if let Some(entry) = entry {
        let exact = entry.sha256.eq_ignore_ascii_case(sha256);
        let baseline = generated_baseline(entry, sha256);
        let verdict = compare(baseline, &entry.shape, observed);
        let provenance = match (&verdict, exact) {
            (ShapeVerdict::Compatible { .. }, true) => ShapeProvenance::Reviewed,
            (ShapeVerdict::Compatible { .. }, false) => ShapeProvenance::Inherited,
            _ => ShapeProvenance::Unreviewed,
        };
        return (verdict, provenance);
    }
    if let Some(layout) = reviewed_layout.or_else(|| port.reviewed_package_layouts.get(&platform)) {
        let reviewed = PackageShape {
            programs: Some(layout.executables.clone()),
            top_directories: Some(layout.directories.clone()),
            ..PackageShape::default()
        };
        return (
            compare(ShapeBaseline::ReviewedLayout, &reviewed, observed),
            ShapeProvenance::Unreviewed,
        );
    }
    if let Some(local) = local
        && let Some(shape) = &local.record.shape
    {
        let baseline = ShapeBaseline::Local {
            install_id: local.install_id.clone(),
            version: local.version.clone(),
            sha256: local.sha256.clone(),
            provenance: local.record.provenance,
        };
        let verdict = compare(baseline, shape, observed);
        let provenance = if matches!(verdict, ShapeVerdict::Compatible { .. })
            && local.record.provenance != ShapeProvenance::Unreviewed
        {
            ShapeProvenance::Inherited
        } else {
            ShapeProvenance::Unreviewed
        };
        return (verdict, provenance);
    }
    (
        ShapeVerdict::Unknown {
            baseline: None,
            reason: ShapeUnknownReason::NoBaseline,
            unknown: Vec::new(),
            detail: None,
        },
        ShapeProvenance::Unreviewed,
    )
}

/// A verdict for a package whose shape could not be derived.
pub(crate) fn observation_failed(error: &PortcoveError) -> PackageShapeRecord {
    PackageShapeRecord {
        shape_version: COMPONENT_RULES_VERSION,
        shape: None,
        provenance: ShapeProvenance::Unreviewed,
        verdict: ShapeVerdict::Unknown {
            baseline: None,
            reason: ShapeUnknownReason::ObservationFailed,
            unknown: Vec::new(),
            detail: Some(error.message.chars().take(512).collect()),
        },
    }
}

fn compare(
    baseline: ShapeBaseline,
    reviewed: &PackageShape,
    observed: &PackageShape,
) -> ShapeVerdict {
    let mut changes = Vec::new();
    let mut unknown = Vec::new();
    for component in ShapeComponent::ALL {
        let (Some(before), Some(after)) =
            (reviewed.component(component), observed.component(component))
        else {
            unknown.push(component);
            continue;
        };
        let before_set = before.iter().collect::<BTreeSet<_>>();
        let after_set = after.iter().collect::<BTreeSet<_>>();
        let added = after
            .iter()
            .filter(|path| !before_set.contains(path))
            .cloned()
            .collect::<Vec<_>>();
        let removed = before
            .iter()
            .filter(|path| !after_set.contains(path))
            .cloned()
            .collect::<Vec<_>>();
        if !added.is_empty() || !removed.is_empty() {
            changes.push(ShapeChange {
                component,
                added_count: added.len(),
                added: added.into_iter().take(REPORTED_CHANGE_PATHS).collect(),
                removed_count: removed.len(),
                removed: removed.into_iter().take(REPORTED_CHANGE_PATHS).collect(),
            });
        }
    }
    if !changes.is_empty() {
        ShapeVerdict::Drifted {
            baseline,
            changes,
            unknown,
        }
    } else if unknown.is_empty() {
        ShapeVerdict::Compatible { baseline }
    } else {
        ShapeVerdict::Unknown {
            baseline: Some(baseline),
            reason: ShapeUnknownReason::IncompleteComparison,
            unknown,
            detail: None,
        }
    }
}

/// Derive and judge one extracted package for its installation manifest.
/// A derivation failure becomes an `observation_failed` unknown verdict.
pub(crate) fn record_for_install(
    port: &PortDefinition,
    qualification: &crate::install::InstallQualification,
    platform: Platform,
    payload: &Path,
    sha256: &str,
    local: Option<&LocalBaseline>,
    reviewed_layout: Option<&crate::ReviewedPackageLayout>,
) -> PackageShapeRecord {
    let observed = roots(port, qualification, platform, payload)
        .and_then(|roots| derive(port, platform, &roots));
    match observed {
        Ok(shape) => {
            let (verdict, provenance) =
                evaluate(port, platform, sha256, &shape, local, reviewed_layout);
            PackageShapeRecord {
                shape_version: COMPONENT_RULES_VERSION,
                shape: Some(shape),
                provenance,
                verdict,
            }
        }
        Err(error) => observation_failed(&error),
    }
}

/// Inspect verified local archive bytes as the installer would derive their
/// shape, and judge them against the generated table or explicit layout.
/// It runs before opening a library, reads only the embedded catalog and
/// executes nothing. This establishes shape, not release authority.
pub fn inspect_package_shape_archive(
    source: &Path,
    port: &PortDefinition,
    platform: Platform,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<PackageShapeInspection> {
    inspect_package_shape_archive_observed(
        source,
        port,
        platform,
        expected_size,
        expected_sha256,
        None,
    )
}

/// Compare an observed predecessor with its exact declared layout. A supplied
/// observation must match or the dry comparison is unavailable.
pub fn inspect_package_shape_archive_observed(
    source: &Path,
    port: &PortDefinition,
    platform: Platform,
    expected_size: u64,
    expected_sha256: &str,
    predecessor: Option<&crate::PackageLayoutObservation>,
) -> Result<PackageShapeInspection> {
    let reviewed_layout = predecessor
        .map(|observation| {
            let filename = source
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| {
                    PortcoveError::usage("package observation requires its exact provider filename")
                })?;
            crate::package_layout::observed_predecessor_layout(
                port,
                platform,
                observation,
                &crate::ArtifactIdentity {
                    asset_name: filename.into(),
                    size: expected_size,
                    sha256: expected_sha256.into(),
                },
            )
            .ok_or_else(|| {
                PortcoveError::verification(
                    "observed package does not match a reviewed predecessor",
                )
            })
        })
        .transpose()?;
    if !port.platforms.contains(&platform) {
        return Err(PortcoveError::usage(format!(
            "{} has no route for {platform:?}",
            port.id
        )));
    }
    let qualification = crate::install::InstallQualification::from_port(port, platform)?;
    let native_mac_bundle_tar_xz = crate::runtime::native_mac_bundle_tar_xz(port, platform);
    let (_workspace, payload) = crate::package_layout::extract_verified_archive(
        source,
        platform,
        expected_size,
        expected_sha256,
        native_mac_bundle_tar_xz,
    )?;
    let payload = if native_mac_bundle_tar_xz {
        crate::package_layout::native_mac_bundle_root(&payload, port, platform)?
    } else {
        payload
    };
    if port.managed_shared_preferences.is_some() {
        crate::managed_shared_preferences::prepare_owned_saves(port, &payload)?;
    }
    if port.release.grant_declared_executable {
        crate::install::grant_declared_executable(&payload, &qualification)?;
    }
    crate::native_external_profile::openmohaa::prepare_package(port, platform, &payload)?;
    let roots = roots(port, &qualification, platform, &payload)?;
    let shape = derive(port, platform, &roots)?;
    let player_candidates = derive_player_candidates(&roots, &shape)?;
    let predecessor_scope_unassessed = predecessor.is_none()
        && preferred_generated_entry(generated_table(), &port.id, platform, expected_sha256)
            .is_none()
        && port
            .reviewed_predecessor_package_layouts_v1
            .get(&platform)
            .is_some_and(|rules| {
                rules.iter().any(|rule| {
                    rule.artifact.size == expected_size
                        && rule.artifact.sha256.eq_ignore_ascii_case(expected_sha256)
                })
            });
    let (verdict, provenance) = if predecessor_scope_unassessed {
        (
            ShapeVerdict::Unknown {
                baseline: Some(ShapeBaseline::ReviewedLayout),
                reason: ShapeUnknownReason::IncompleteComparison,
                unknown: ShapeComponent::ALL.to_vec(),
                detail: Some("These bytes match a reviewed predecessor. The provider release and asset scope were not established.".into()),
            },
            ShapeProvenance::Unreviewed,
        )
    } else {
        evaluate(
            port,
            platform,
            expected_sha256,
            &shape,
            None,
            reviewed_layout,
        )
    };
    Ok(PackageShapeInspection {
        port_id: port.id.clone(),
        platform,
        sha256: expected_sha256.to_ascii_lowercase(),
        shape_version: SHAPE_VERSION,
        shape,
        provenance,
        verdict,
        derivation_inputs_sha256: embedded_derivation_inputs_sha256(&port.id, platform),
        predecessor_observation: predecessor.cloned(),
        player_candidates,
    })
}

/// Player candidates of an extracted package (derivation version 2).
///
/// Bundled compilers, overlay toolchains, updaters, crash reporters, setup
/// programs and servers are never players. The decision uses declared facts
/// and structure only, never a list of titles: the candidate is the route's
/// declared launch target, resolved exactly as the installer resolves it; it
/// must be one of the shape's reviewed programs, no segment of its path may
/// name a tool, installer or server location, and its header must classify as
/// a native executable rather than a library or script.
pub(crate) fn derive_player_candidates(
    roots: &ShapeRoots,
    shape: &PackageShape,
) -> Result<Vec<crate::PlayerCandidate>> {
    let Some(executable) = &roots.executable else {
        return Ok(Vec::new());
    };
    let Some(relative) = executable
        .strip_prefix(&roots.package)
        .ok()
        .and_then(|relative| {
            relative
                .components()
                .map(|component| match component {
                    std::path::Component::Normal(part) => {
                        Some(part.to_string_lossy().to_ascii_lowercase())
                    }
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()
        })
        .map(|parts| parts.join("/"))
    else {
        return Ok(Vec::new());
    };
    let reviewed = shape
        .programs
        .as_ref()
        .is_some_and(|programs| programs.binary_search(&relative).is_ok());
    if !reviewed
        || crate::route_facts::player_candidates(std::slice::from_ref(&relative)).is_empty()
    {
        return Ok(Vec::new());
    }
    // Classify and digest the same open single-link file.
    let mut file = crate::external_runtime::open_single_link_file(executable)?;
    let Some(image) = machine::classify(&mut file)? else {
        return Ok(Vec::new());
    };
    if image.kind != machine::ImageKind::Executable {
        return Ok(Vec::new());
    }
    use std::io::{Read as _, Seek as _};
    file.seek(std::io::SeekFrom::Start(0))?;
    let mut digest = <sha2::Sha256 as sha2::Digest>::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        sha2::Digest::update(&mut digest, &buffer[..read]);
    }
    Ok(vec![crate::PlayerCandidate {
        path: relative,
        machine: Some(image.machine),
        sha256: Some(hex::encode(sha2::Digest::finalize(digest))),
    }])
}

impl crate::PortcoveService {
    /// Recorded package shapes and shadow drift verdicts of a port's managed
    /// installations. Read-only diagnostics; it opens no operation lock.
    pub fn installed_package_shapes(&self, port_id: &str) -> Result<Vec<InstalledPackageShape>> {
        self.catalog().port(port_id)?;
        crate::install::Installer::new(self.library.clone())?.installed_package_shapes(port_id)
    }
}

#[cfg(test)]
mod tests;
