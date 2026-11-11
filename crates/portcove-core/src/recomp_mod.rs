//! Bounded, non-executing inspection of N64 Recomp runtime mod packages (`.nrm`).
//!
//! Source observations only (Zelda64Recomp `54950a10`, N64ModernRuntime
//! `df7e820d`, `librecomp/src/mod_manifest.cpp` and `mods.cpp`): an `.nrm` is a ZIP
//! whose `mod.json` names the native mod ID, version, game, minimum runtime and
//! dependencies; `mod_binary.bin` with `mod_syms.bin` carry MIPS code the runtime
//! recompiles and runs; `native_libraries` names host libraries loaded from the
//! mods folder; a `*.offline.nrm` loads its code from a sibling library. Any of
//! these is executable content, which this inspection only classifies: it never
//! extracts, loads or runs anything, and its result grants no activation.
//!
//! The native ID and version come from the manifest, never from the file name,
//! a provider listing or an archive digest; those stay separate facts.
use std::{collections::BTreeMap, fs::File, io::Read, path::Path};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{PortcoveError, Result, inspect_asset_archive, zip_read};

const MANIFEST: &str = "mod.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_TEXT: usize = 256;
const MAX_LIST: usize = 128;
const LIMITS: zip_read::Limits = zip_read::Limits {
    bytes: 4 * 1024 * 1024 * 1024,
    entries: 100_000,
    metadata: 64 * 1024 * 1024,
    zip64: true,
    prefix: false,
};

/// A dependency on another native mod, with an optional minimum version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecompDependency {
    pub id: String,
    pub minimum_version: Option<String>,
}

/// What the package would run on the player's machine if enabled.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum RecompExecution {
    /// Recompiled game code (`mod_binary.bin`/`mod_syms.bin`).
    RecompiledCode,
    /// Host libraries named in `native_libraries`, loaded from the mods folder.
    NativeLibraries,
    /// An offline package whose code comes from a sibling library file.
    ExternalCode,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum RecompModHold {
    /// The manifest names another game than the one being set up.
    OtherGame,
    /// The package carries code; the reviewed loader contract allows none yet.
    ExecutableContent,
    /// Files an operating system runs directly sit inside the package.
    HostExecutableFiles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RecompModInspection {
    pub file_name: String,
    pub sha256: String,
    pub size: u64,
    /// The runtime's identity for the mod (from `mod.json`).
    pub native_id: String,
    pub native_version: String,
    pub display_name: String,
    pub game_id: String,
    pub minimum_runtime_version: String,
    pub authors: Vec<String>,
    pub dependencies: Vec<RecompDependency>,
    pub optional_dependencies: Vec<RecompDependency>,
    /// Library name → exported functions the manifest declares.
    pub native_libraries: BTreeMap<String, Vec<String>>,
    pub enabled_by_default: bool,
    pub has_settings: bool,
    pub execution: Vec<RecompExecution>,
    pub holds: Vec<RecompModHold>,
}

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::verification(format!("Recomp mod package cannot be reviewed: {message}"))
}

fn plain(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TEXT
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
}

fn version(value: &str) -> bool {
    let core = value.split_once('-').map_or(value, |(core, _)| core);
    let parts = core.split('.').collect::<Vec<_>>();
    value.len() <= 64
        && parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && value.chars().all(|c| c.is_ascii_graphic())
}

fn text(manifest: &Value, field: &str, required: bool) -> Result<Option<String>> {
    match manifest.get(field) {
        None if !required => Ok(None),
        None => Err(invalid(&format!("`{field}` is missing"))),
        Some(Value::String(value))
            if !value.is_empty()
                && value.len() <= MAX_TEXT
                && !value.chars().any(char::is_control) =>
        {
            Ok(Some(value.clone()))
        }
        Some(_) => Err(invalid(&format!("`{field}` must be short text"))),
    }
}

fn dependencies(manifest: &Value, field: &str) -> Result<Vec<RecompDependency>> {
    let Some(value) = manifest.get(field) else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .filter(|items| items.len() <= MAX_LIST)
        .ok_or_else(|| invalid(&format!("`{field}` must be a short list")))?;
    let mut parsed = Vec::new();
    for item in items {
        let entry = item
            .as_str()
            .ok_or_else(|| invalid(&format!("`{field}` entries must be text")))?;
        let (id, minimum_version) = match entry.split_once(':') {
            Some((id, minimum)) => (id, Some(minimum)),
            None => (entry, None),
        };
        if !plain(id) || minimum_version.is_some_and(|minimum| !version(minimum)) {
            return Err(invalid(&format!("`{field}` has an unreadable entry")));
        }
        parsed.push(RecompDependency {
            id: id.to_owned(),
            minimum_version: minimum_version.map(str::to_owned),
        });
    }
    Ok(parsed)
}

/// Inspects one `.nrm` for `game_id` without extracting or executing it.
pub fn inspect_recomp_mod(path: &Path, game_id: &str) -> Result<RecompModInspection> {
    // Shared bounded checks: plain name, regular file, digest, safe entry paths,
    // no links or encryption, bounded declared size.
    let archive_view = inspect_asset_archive(path)?;
    let mut archive = zip_read::open(File::open(path)?, LIMITS, &mut |_| Ok(()))
        .map_err(|error| invalid(&error.message))?;
    let mut manifest_bytes = Vec::new();
    {
        let entry = archive
            .by_name(MANIFEST)
            .map_err(|_| invalid("it has no mod.json at its top level"))?;
        if entry.size() > MAX_MANIFEST_BYTES {
            return Err(invalid("mod.json is too large"));
        }
        entry
            .take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut manifest_bytes)?;
    }
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(invalid("mod.json is too large"));
    }
    let crate::definition_entry::strict_json::UniqueValue(manifest) =
        serde_json::from_slice(&manifest_bytes)
            .map_err(|_| invalid("mod.json is not JSON with unique keys"))?;
    if !manifest.is_object() {
        return Err(invalid("mod.json must be an object"));
    }
    let native_id = text(&manifest, "id", true)?.unwrap_or_default();
    if !plain(&native_id) {
        return Err(invalid("the mod ID is not a plain identifier"));
    }
    let native_version = text(&manifest, "version", true)?.unwrap_or_default();
    let minimum_runtime_version =
        text(&manifest, "minimum_recomp_version", true)?.unwrap_or_default();
    if !version(&native_version) || !version(&minimum_runtime_version) {
        return Err(invalid("versions must look like 1.2.3"));
    }
    let manifest_game = text(&manifest, "game_id", true)?.unwrap_or_default();
    let display_name = text(&manifest, "display_name", true)?.unwrap_or_default();
    let authors = match manifest.get("authors") {
        Some(Value::Array(items)) if !items.is_empty() && items.len() <= MAX_LIST => items
            .iter()
            .map(|item| {
                item.as_str()
                    .filter(|value| {
                        !value.is_empty()
                            && value.len() <= MAX_TEXT
                            && !value.chars().any(char::is_control)
                    })
                    .map(str::to_owned)
                    .ok_or_else(|| invalid("`authors` entries must be short text"))
            })
            .collect::<Result<Vec<_>>>()?,
        _ => return Err(invalid("`authors` must be a non-empty list")),
    };
    let mut native_libraries = BTreeMap::new();
    if let Some(value) = manifest.get("native_libraries") {
        let object = value
            .as_object()
            .filter(|object| object.len() <= MAX_LIST)
            .ok_or_else(|| invalid("`native_libraries` must be an object"))?;
        for (library, exports) in object {
            let exports = exports
                .as_array()
                .filter(|items| items.len() <= MAX_LIST)
                .and_then(|items| {
                    items
                        .iter()
                        .map(|item| item.as_str().filter(|name| plain(name)).map(str::to_owned))
                        .collect::<Option<Vec<_>>>()
                })
                .ok_or_else(|| invalid("`native_libraries` exports must be plain names"))?;
            if !plain(library) {
                return Err(invalid("a native library name is not plain"));
            }
            native_libraries.insert(library.clone(), exports);
        }
    }
    let enabled_by_default = match manifest.get("enabled_by_default") {
        None => true,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(invalid("`enabled_by_default` must be true or false")),
    };
    let has_settings = manifest
        .get("config_schema")
        .and_then(|schema| schema.get("options"))
        .and_then(Value::as_array)
        .is_some_and(|options| !options.is_empty());

    let has = |name: &str| archive_view.asset_paths.iter().any(|path| path == name);
    let mut execution = Vec::new();
    if has("mod_binary.bin") || has("mod_syms.bin") {
        execution.push(RecompExecution::RecompiledCode);
    }
    if !native_libraries.is_empty() {
        execution.push(RecompExecution::NativeLibraries);
    }
    if archive_view
        .file_name
        .to_ascii_lowercase()
        .ends_with(".offline.nrm")
    {
        execution.push(RecompExecution::ExternalCode);
    }
    let mut holds = Vec::new();
    if manifest_game != game_id {
        holds.push(RecompModHold::OtherGame);
    }
    if !execution.is_empty() {
        holds.push(RecompModHold::ExecutableContent);
    }
    if !archive_view.executable_entries.is_empty() {
        holds.push(RecompModHold::HostExecutableFiles);
    }
    Ok(RecompModInspection {
        file_name: archive_view.file_name,
        sha256: archive_view.sha256,
        size: archive_view.size,
        native_id,
        native_version,
        display_name,
        game_id: manifest_game,
        minimum_runtime_version,
        authors,
        dependencies: dependencies(&manifest, "dependencies")?,
        optional_dependencies: dependencies(&manifest, "optional_dependencies")?,
        native_libraries,
        enabled_by_default,
        has_settings,
        execution,
        holds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn nrm(directory: &Path, name: &str, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
        let path = directory.join(name);
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        for (entry, bytes) in entries {
            writer
                .start_file(*entry, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    const MANIFEST_OK: &[u8] = br#"{
        "game_id": "mm", "id": "better_dpad", "display_name": "Better D-Pad",
        "version": "1.2.0", "authors": ["someone"], "minimum_recomp_version": "1.2.0",
        "dependencies": ["mm_recomp_dpad_builtin:1.0.0"],
        "optional_dependencies": ["extra_ui"],
        "config_schema": {"options": [{"id": "speed", "type": "Number"}]},
        "future_field": {"kept": "ignored"}
    }"#;

    #[test]
    fn native_identity_comes_from_the_manifest_and_assets_need_no_hold() {
        let directory = tempfile::tempdir().unwrap();
        let path = nrm(
            directory.path(),
            "renamed-by-provider.nrm",
            &[("mod.json", MANIFEST_OK), ("textures/a.png", b"png")],
        );
        let inspection = inspect_recomp_mod(&path, "mm").unwrap();
        assert_eq!(inspection.native_id, "better_dpad");
        assert_eq!(inspection.native_version, "1.2.0");
        assert_eq!(inspection.file_name, "renamed-by-provider.nrm");
        assert_eq!(
            inspection.dependencies,
            [RecompDependency {
                id: "mm_recomp_dpad_builtin".into(),
                minimum_version: Some("1.0.0".into()),
            }]
        );
        assert_eq!(inspection.optional_dependencies[0].minimum_version, None);
        assert!(inspection.enabled_by_default && inspection.has_settings);
        assert!(inspection.execution.is_empty() && inspection.holds.is_empty());
    }

    #[test]
    fn code_libraries_offline_packages_and_other_games_are_classified_and_held() {
        let directory = tempfile::tempdir().unwrap();
        let code = nrm(
            directory.path(),
            "code.nrm",
            &[
                ("mod.json", MANIFEST_OK),
                ("mod_binary.bin", b"\0"),
                ("mod_syms.bin", b"\0"),
            ],
        );
        let inspection = inspect_recomp_mod(&code, "mm").unwrap();
        assert_eq!(inspection.execution, [RecompExecution::RecompiledCode]);
        assert_eq!(inspection.holds, [RecompModHold::ExecutableContent]);

        let with_library = br#"{"game_id":"mm","id":"x","display_name":"X","version":"1.0.0",
            "authors":["a"],"minimum_recomp_version":"1.0.0",
            "native_libraries":{"helper":["do_thing"]}}"#;
        let library = nrm(
            directory.path(),
            "lib.offline.nrm",
            &[("mod.json", with_library), ("helper.dll", b"MZ")],
        );
        let inspection = inspect_recomp_mod(&library, "mm").unwrap();
        assert_eq!(
            inspection.execution,
            [
                RecompExecution::NativeLibraries,
                RecompExecution::ExternalCode
            ]
        );
        assert_eq!(
            inspection.holds,
            [
                RecompModHold::ExecutableContent,
                RecompModHold::HostExecutableFiles
            ]
        );

        let other = nrm(directory.path(), "other.nrm", &[("mod.json", MANIFEST_OK)]);
        assert_eq!(
            inspect_recomp_mod(&other, "bk").unwrap().holds,
            [RecompModHold::OtherGame]
        );
    }

    #[test]
    fn missing_malformed_or_hostile_manifests_are_refused() {
        let directory = tempfile::tempdir().unwrap();
        let cases: &[&[u8]] = &[
            b"{not json",
            br#"{"id":"a","id":"b"}"#,
            br#"{"game_id":"mm","id":"../x","display_name":"X","version":"1.0.0","authors":["a"],"minimum_recomp_version":"1.0.0"}"#,
            br#"{"game_id":"mm","id":"x","display_name":"X","version":"latest","authors":["a"],"minimum_recomp_version":"1.0.0"}"#,
            br#"{"game_id":"mm","id":"x","display_name":"X","version":"1.0.0","authors":[],"minimum_recomp_version":"1.0.0"}"#,
            br#"{"game_id":"mm","id":"x","display_name":"X","version":"1.0.0","authors":["a"],"minimum_recomp_version":"1.0.0","dependencies":["y:>=2"]}"#,
            br#"{"game_id":"mm","id":"x","display_name":"X","version":"1.0.0","authors":["a"],"minimum_recomp_version":"1.0.0","native_libraries":{"../evil":[]}}"#,
            br#"[1,2]"#,
        ];
        for (index, manifest) in cases.iter().enumerate() {
            let path = nrm(
                directory.path(),
                &format!("case{index}.nrm"),
                &[("mod.json", manifest)],
            );
            assert!(inspect_recomp_mod(&path, "mm").is_err(), "case {index}");
        }
        let none = nrm(directory.path(), "none.nrm", &[("readme.txt", b"hi")]);
        assert!(inspect_recomp_mod(&none, "mm").is_err());
        let huge = vec![b' '; (MAX_MANIFEST_BYTES + 1) as usize];
        let big = nrm(directory.path(), "big.nrm", &[("mod.json", &huge)]);
        assert!(inspect_recomp_mod(&big, "mm").is_err());
        let traversal = nrm(
            directory.path(),
            "trav.nrm",
            &[("mod.json", MANIFEST_OK), ("../escape.bin", b"x")],
        );
        assert!(inspect_recomp_mod(&traversal, "mm").is_err());
    }
}
