//! Derived package shapes and the shadow release-drift verdict (#5359 phase 1).
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
//! This phase only records the verdict. Nothing is refused or reordered on its
//! account; the explicit reviewed layout gate in `package_layout` stays the
//! only refusal. Manifests store the record as untyped JSON and read it with
//! [`stored_record`], so records from other Portcove versions stay harmless.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Platform, PortDefinition, PortcoveError, Result};

/// Version of the derivation rules. The generated table records the version it
/// was derived with; a different version is not a baseline.
pub(crate) const SHAPE_VERSION: u32 = 1;
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

/// The shadow verdict for one candidate package. It refuses nothing.
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
    (record.shape_version == SHAPE_VERSION
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
    shape: PackageShape,
}

fn generated_table() -> &'static [GeneratedEntry] {
    static TABLE: OnceLock<Vec<GeneratedEntry>> = OnceLock::new();
    TABLE.get_or_init(|| parse_table(GENERATED_TABLE).unwrap_or_default())
}

fn parse_table(text: &str) -> Result<Vec<GeneratedEntry>> {
    let table: GeneratedTable = serde_json::from_str(text)?;
    if table.format != TABLE_FORMAT
        || table.shape_version != SHAPE_VERSION
        || table.entries.iter().any(|entry| {
            !entry.shape.is_canonical()
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
    let document: serde_json::Value =
        serde_json::from_str(crate::catalog::EMBEDDED_CATALOG).ok()?;
    let port = document["ports"]
        .as_array()?
        .iter()
        .find(|port| port["id"] == port_id)?;
    let platform = serde_json::to_value(platform).ok()?;
    derivation_inputs_sha256(port, platform.as_str()?).ok()
}

/// Inputs that locate declared persistent paths in an extracted package.
pub(crate) struct ShapeRoots {
    /// The root reviewed layouts observe: the payload after wrapper look-through.
    pub package: PathBuf,
    /// The directory declared persistent paths are relative to, when the
    /// declared executable resolved.
    pub persistence: Option<PathBuf>,
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
    let persistence = crate::install::resolve_declared_executable(payload, qualification)
        .ok()
        .map(|selected| qualification.persistence_root(payload, &selected));
    Ok(ShapeRoots {
        package,
        persistence,
    })
}

/// Derive the shape of an extracted package before any adapter adds content.
pub(crate) fn derive(
    port: &PortDefinition,
    platform: Platform,
    roots: &ShapeRoots,
) -> Result<PackageShape> {
    let ignore_macos_libraries = port
        .reviewed_package_layouts
        .get(&platform)
        .is_some_and(|layout| layout.ignore_verified_macos_libraries);
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
                if crate::package_layout::is_program_entry(
                    &entry,
                    platform,
                    ignore_macos_libraries,
                )? {
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
        .filter(|path| !path.contains('/'))
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
    for declared in crate::persistence::declared_paths(port, platform) {
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
) -> (ShapeVerdict, ShapeProvenance) {
    evaluate_with_table(generated_table(), port, platform, sha256, observed, local)
}

fn evaluate_with_table(
    table: &[GeneratedEntry],
    port: &PortDefinition,
    platform: Platform,
    sha256: &str,
    observed: &PackageShape,
    local: Option<&LocalBaseline>,
) -> (ShapeVerdict, ShapeProvenance) {
    let route = table
        .iter()
        .filter(|entry| entry.port_id == port.id && entry.platform == platform)
        .collect::<Vec<_>>();
    let exact = route
        .iter()
        .find(|entry| entry.sha256.eq_ignore_ascii_case(sha256));
    if let Some(entry) = exact.or(route.last()) {
        let baseline = ShapeBaseline::Generated {
            version: entry.version.clone(),
            sha256: entry.sha256.clone(),
            exact: exact.is_some(),
        };
        let verdict = compare(baseline, &entry.shape, observed);
        let provenance = match (&verdict, exact.is_some()) {
            (ShapeVerdict::Compatible { .. }, true) => ShapeProvenance::Reviewed,
            (ShapeVerdict::Compatible { .. }, false) => ShapeProvenance::Inherited,
            _ => ShapeProvenance::Unreviewed,
        };
        return (verdict, provenance);
    }
    if let Some(layout) = port.reviewed_package_layouts.get(&platform) {
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
        shape_version: SHAPE_VERSION,
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
/// Every failure becomes an `observation_failed` verdict: the shadow
/// comparison never refuses an installation.
pub(crate) fn record_for_install(
    port: &PortDefinition,
    qualification: &crate::install::InstallQualification,
    platform: Platform,
    payload: &Path,
    sha256: &str,
    local: Option<&LocalBaseline>,
) -> PackageShapeRecord {
    let observed = roots(port, qualification, platform, payload)
        .and_then(|roots| derive(port, platform, &roots));
    match observed {
        Ok(shape) => {
            let (verdict, provenance) = evaluate(port, platform, sha256, &shape, local);
            PackageShapeRecord {
                shape_version: SHAPE_VERSION,
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
    if !port.platforms.contains(&platform) {
        return Err(PortcoveError::usage(format!(
            "{} has no route for {platform:?}",
            port.id
        )));
    }
    let qualification = crate::install::InstallQualification::from_port(port, platform)?;
    let (_workspace, payload) = crate::package_layout::extract_verified_archive(
        source,
        platform,
        expected_size,
        expected_sha256,
    )?;
    let payload = if crate::runtime::native_mac_bundle_tar_xz(port, platform) {
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
    let roots = roots(port, &qualification, platform, &payload)?;
    let shape = derive(port, platform, &roots)?;
    let (verdict, provenance) = evaluate(port, platform, expected_sha256, &shape, None);
    Ok(PackageShapeInspection {
        port_id: port.id.clone(),
        platform,
        sha256: expected_sha256.to_ascii_lowercase(),
        shape_version: SHAPE_VERSION,
        shape,
        provenance,
        verdict,
        derivation_inputs_sha256: embedded_derivation_inputs_sha256(&port.id, platform),
    })
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
