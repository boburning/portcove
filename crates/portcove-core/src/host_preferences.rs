//! Host-owned preferences. No operation opens, initializes, or moves a library.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use fs2::FileExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{PortcoveError, Result};

const FORMAT_VERSION: u32 = 1;
const MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostPreferences {
    pub format_version: u32,
    pub library_root: Option<PathBuf>,
    #[serde(flatten)]
    extensions: BTreeMap<String, serde_json::Value>,
}

impl Default for HostPreferences {
    fn default() -> Self {
        Self {
            format_version: FORMAT_VERSION,
            library_root: None,
            extensions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LibrarySelectionSource {
    Invocation,
    Saved,
    PlatformDefault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LibrarySelection {
    pub root: PathBuf,
    pub source: LibrarySelectionSource,
}

/// Adapters supply a dedicated configuration file outside library and credential
/// storage. The parent must already exist; inspecting a missing file writes nothing.
#[derive(Debug, Clone)]
pub struct HostPreferenceStore {
    path: PathBuf,
}

impl HostPreferenceStore {
    pub fn default_path() -> Result<PathBuf> {
        let project = directories::ProjectDirs::from("io.github", "Portcove", "Portcove")
            .ok_or_else(|| {
                PortcoveError::state("could not determine the Portcove configuration directory")
            })?;
        Ok(project.config_local_dir().join("preferences.json"))
    }

    pub fn open_default() -> Result<Self> {
        Self::new(Self::default_path()?)
    }

    pub fn new(path: PathBuf) -> Result<Self> {
        validate_absolute(&path)?;
        if path.file_name().is_none() {
            return Err(PortcoveError::usage(
                "host preference path must name a file",
            ));
        }
        Ok(Self { path })
    }

    pub fn load(&self) -> Result<HostPreferences> {
        crate::path::refuse_symlink_ancestors(&self.path)?;
        match fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(HostPreferences::default());
            }
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let bytes = crate::path::read_bounded_regular(&self.path, MAX_BYTES)?;
        let preferences: HostPreferences = serde_json::from_slice(&bytes).map_err(|error| {
            PortcoveError::state("host preferences are malformed; explicitly reset or repair them")
                .detail("cause", error.to_string())
        })?;
        if preferences.format_version != FORMAT_VERSION {
            return Err(
                PortcoveError::unsupported("unsupported host preference format")
                    .detail("format_version", preferences.format_version.to_string()),
            );
        }
        if let Some(root) = &preferences.library_root {
            validate_absolute(root)?;
        }
        Ok(preferences)
    }

    /// An invocation override permits recovery even when saved preferences are
    /// damaged. An invalid selected path is never replaced by a lower priority path.
    pub fn resolve(
        &self,
        invocation: Option<&Path>,
        platform_default: &Path,
    ) -> Result<LibrarySelection> {
        let (root, source) = if let Some(root) = invocation {
            (root.to_path_buf(), LibrarySelectionSource::Invocation)
        } else if let Some(root) = self.load()?.library_root {
            (root, LibrarySelectionSource::Saved)
        } else {
            (
                platform_default.to_path_buf(),
                LibrarySelectionSource::PlatformDefault,
            )
        };
        validate_absolute(&root)?;
        Ok(LibrarySelection { root, source })
    }

    pub fn set_library(&self, root: &Path) -> Result<()> {
        let root = crate::Library::validate_selection_target(root)?;
        let preference_path = crate::path::resolve_existing_ancestor(&self.path)?;
        if preference_path.starts_with(&root) {
            return Err(PortcoveError::conflict(
                "host preferences must remain outside the selected library",
            ));
        }
        let _lock = self.lock()?;
        let mut preferences = self.load()?;
        preferences.library_root = Some(root);
        self.publish(&preferences)
    }

    /// Clear only the library choice while retaining other compatible settings.
    pub fn clear_library(&self) -> Result<()> {
        let _lock = self.lock()?;
        let mut preferences = self.load()?;
        preferences.library_root = None;
        self.publish(&preferences)
    }

    /// Explicit recovery replaces corrupt or future-format preferences with an
    /// empty current document. It does not delete or inspect the selected library.
    pub fn reset(&self) -> Result<()> {
        let _lock = self.lock()?;
        self.publish(&HostPreferences::default())
    }

    fn lock(&self) -> Result<fs::File> {
        crate::path::refuse_symlink_ancestors(&self.path)?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| PortcoveError::usage("host preference path needs a parent directory"))?;
        fs::create_dir_all(parent)?;
        crate::path::refuse_symlink_ancestors(parent)?;
        let name = self
            .path
            .file_name()
            .ok_or_else(|| PortcoveError::usage("missing preference filename"))?;
        let mut lock_name = name.to_os_string();
        lock_name.push(".lock");
        let lock_path = self.path.with_file_name(lock_name);
        crate::path::refuse_symlink_ancestors(&lock_path)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        FileExt::lock_exclusive(&file)?;
        Ok(file)
    }

    fn publish(&self, preferences: &HostPreferences) -> Result<()> {
        crate::path::refuse_symlink_ancestors(&self.path)?;
        let bytes = serde_json::to_vec_pretty(preferences)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(PortcoveError::state(
                "host preferences exceed their size limit",
            ));
        }
        crate::durability::write_bytes_atomically(&self.path, &bytes, true)
    }
}

fn validate_absolute(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(PortcoveError::usage(
            "host preference paths must be absolute without parent traversal",
        ));
    }
    crate::path::unicode(path, "host preference")?;
    Ok(())
}

#[cfg(test)]
#[path = "host_preferences_tests.rs"]
mod tests;
