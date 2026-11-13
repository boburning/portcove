//! Bounded, non-executing inspection of loader asset-archive mod packages.
//!
//! Inspection reads only the ZIP central directory and streams the file once for
//! its digest. It never decompresses entries, runs hooks, or loads native code, and
//! it grants no activation permission: the result is evidence for a reviewed plan.
//! A computed digest establishes bytes, not publisher authenticity.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{PortcoveError, Result, zip_read};

const LIMITS: zip_read::Limits = zip_read::Limits {
    bytes: 4 * 1024 * 1024 * 1024,
    entries: 100_000,
    metadata: 64 * 1024 * 1024,
    zip64: true,
    prefix: false,
};
/// Declared uncompressed bytes a package may claim; guards later extraction.
const MAX_DECLARED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_FILE_NAME: usize = 128;

/// Extensions that are loaded or run as code by an operating system, not as game
/// assets. A package carrying one is held, never silently deployed.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib", "sh", "bat", "cmd", "ps1", "msi", "jar", "com", "scr", "app",
];

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ModPackageHold {
    /// The archive contains files an OS runs directly; asset-only support cannot cover it.
    ContainsExecutableContent,
    /// No file entries, so the package would change nothing.
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModPackageInspection {
    /// The file's own name; for filename-identified loaders this is the native identity.
    pub file_name: String,
    pub sha256: String,
    pub size: u64,
    pub entry_count: usize,
    pub declared_uncompressed_bytes: u64,
    /// Sorted, lowercased asset paths (case collisions are the same asset on every
    /// supported filesystem).
    pub asset_paths: Vec<String>,
    pub executable_entries: Vec<String>,
    pub holds: Vec<ModPackageHold>,
}

/// Several packages claim the same asset path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AssetConflict {
    pub path: String,
    /// Packages providing the path, in the supplied precedence order.
    pub providers: Vec<String>,
    /// The provider that takes effect under that order.
    pub winner: String,
}

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::verification(format!("mod package is not safe to inspect: {message}"))
}

/// Inspects one `.o2r`-style asset archive without extracting or executing it.
pub fn inspect_asset_archive(path: &Path) -> Result<ModPackageInspection> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| {
            !name.is_empty()
                && name.len() <= MAX_FILE_NAME
                && name.is_ascii()
                && !name
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        })
        .ok_or_else(|| invalid("file name must be 1–128 plain ASCII characters"))?
        .to_owned();
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Err(invalid("path is not a regular file"));
    }
    let size = metadata.len();
    let mut hasher = Sha256::new();
    let mut file = File::open(path)?;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let sha256 = hex::encode(hasher.finalize());

    let mut archive = zip_read::open(File::open(path)?, LIMITS, &mut |_| Ok(()))
        .map_err(|error| invalid(&error.message))?;
    let mut paths = BTreeSet::new();
    let mut executables = BTreeSet::new();
    let mut declared = 0u64;
    let mut files = 0usize;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|error| invalid(&format!("invalid entry: {error}")))?;
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != 0o100000 && kind != 0o040000 {
                return Err(invalid("links and special files are not allowed"));
            }
        }
        if entry.encrypted() {
            return Err(invalid("encrypted entries cannot be reviewed"));
        }
        let name = entry
            .name()
            .map_err(|_| invalid("entry names must be valid text"))?;
        if entry.is_dir() {
            crate::archive::validate_relative_path(&name, true)
                .map_err(|error| invalid(&error.message))?;
            continue;
        }
        if !entry.is_file() {
            return Err(invalid("unsupported entry type"));
        }
        let (_, key) = crate::archive::validate_relative_path(&name, false)
            .map_err(|error| invalid(&error.message))?;
        declared = declared
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_DECLARED_BYTES)
            .ok_or_else(|| invalid("declared size exceeds the package bound"))?;
        files += 1;
        if let Some(extension) = key.rsplit('.').next().filter(|_| key.contains('.'))
            && EXECUTABLE_EXTENSIONS.contains(&extension)
        {
            executables.insert(key.clone());
        }
        if !paths.insert(key) {
            return Err(invalid("two entries name the same path"));
        }
    }
    let mut holds = Vec::new();
    if files == 0 {
        holds.push(ModPackageHold::Empty);
    }
    if !executables.is_empty() {
        holds.push(ModPackageHold::ContainsExecutableContent);
    }
    Ok(ModPackageInspection {
        file_name,
        sha256,
        size,
        entry_count: archive.len(),
        declared_uncompressed_bytes: declared,
        asset_paths: paths.into_iter().collect(),
        executable_entries: executables.into_iter().collect(),
        holds,
    })
}

/// Package files taken from a provider's wrapper archive.
#[derive(Debug)]
pub(crate) struct ExtractedPackages {
    pub files: Vec<std::path::PathBuf>,
    /// Entries that were not packages and were neither read nor written.
    pub ignored: usize,
}

const MAX_MEMBER_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_MEMBERS: usize = 64;
/// Total bytes one wrapper may extract, however many members it lists.
const MAX_EXTRACTED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Extracts only members whose file extension the loader contract accepts,
/// flattened to their plain file names. Everything else in the wrapper is left
/// unread. A matching member with an unsafe path, a duplicate name or a size that
/// disagrees with its header refuses the whole archive; nothing is deployed.
pub(crate) fn extract_packages(
    archive: &Path,
    destination: &Path,
    extensions: &[&str],
) -> Result<ExtractedPackages> {
    extract_packages_capped(archive, destination, extensions, MAX_EXTRACTED_BYTES)
}

fn extract_packages_capped(
    archive: &Path,
    destination: &Path,
    extensions: &[&str],
    max_total: u64,
) -> Result<ExtractedPackages> {
    let mut zip = zip_read::open(File::open(archive)?, LIMITS, &mut |_| Ok(()))
        .map_err(|error| invalid(&error.message))?;
    let mut names = BTreeSet::new();
    let mut files = Vec::new();
    let mut ignored = 0usize;
    let mut extracted_total = 0u64;
    for index in 0..zip.len() {
        let (name, size, is_file) = {
            let entry = zip
                .by_index_raw(index)
                .map_err(|error| invalid(&format!("invalid entry: {error}")))?;
            if entry.encrypted() {
                return Err(invalid("encrypted entries cannot be reviewed"));
            }
            if let Some(mode) = entry.unix_mode() {
                let kind = mode & 0o170000;
                if kind != 0 && kind != 0o100000 && kind != 0o040000 {
                    return Err(invalid("links and special files are not allowed"));
                }
            }
            let name = entry
                .name()
                .map_err(|_| invalid("entry names must be valid text"))?
                .into_owned();
            (name, entry.size(), entry.is_file())
        };
        let lower = name.to_ascii_lowercase();
        let matches = is_file
            && lower
                .rsplit_once('.')
                .is_some_and(|(_, extension)| extensions.contains(&extension));
        if !matches {
            ignored += 1;
            continue;
        }
        crate::archive::validate_relative_path(&name, false)
            .map_err(|error| invalid(&error.message))?;
        let file_name = name.rsplit('/').next().unwrap_or_default().to_owned();
        if !crate::profile::valid_native_id(&file_name) {
            return Err(invalid("a package member has an unsafe file name"));
        }
        if size == 0 || size > MAX_MEMBER_BYTES {
            return Err(invalid("a package member has an unsupported size"));
        }
        if files.len() >= MAX_MEMBERS || !names.insert(file_name.to_ascii_lowercase()) {
            return Err(invalid(
                "too many package members or a repeated package name",
            ));
        }
        extracted_total = extracted_total
            .checked_add(size)
            .filter(|total| *total <= max_total)
            .ok_or_else(|| {
                invalid("the package members would extract more than the supported total")
            })?;
        let path = destination.join(&file_name);
        let mut entry = zip
            .by_index(index)
            .map_err(|error| invalid(&format!("invalid entry: {error}")))?;
        let mut output = File::create(&path)?;
        let copied = std::io::copy(&mut (&mut entry).take(size + 1), &mut output)?;
        output.sync_all()?;
        if copied != size {
            let _ = std::fs::remove_file(&path);
            return Err(invalid("a package member's size disagrees with its header"));
        }
        files.push(path);
    }
    Ok(ExtractedPackages { files, ignored })
}

/// Finds asset paths several enabled packages provide. `ordered` lists
/// `(native ID, asset paths)` in precedence order, lowest first; the last provider
/// of a path wins. That precedence is the contract this function applies, and the
/// loader integration must confirm it against the real loader before a profile
/// relies on the reported winner.
pub fn asset_conflicts(ordered: &[(&str, &[String])]) -> Vec<AssetConflict> {
    let mut providers: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (id, paths) in ordered {
        for path in *paths {
            providers.entry(path).or_default().push(id);
        }
    }
    providers
        .into_iter()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(path, ids)| AssetConflict {
            path: path.into(),
            winner: ids.last().map(|id| (*id).into()).unwrap_or_default(),
            providers: ids.into_iter().map(String::from).collect(),
        })
        .collect()
}

#[cfg(test)]
#[path = "mod_package_tests.rs"]
mod tests;
