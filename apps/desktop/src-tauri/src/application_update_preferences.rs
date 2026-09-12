//! Durable application-update preferences owned by the desktop host.
//!
//! This module persists consent and policy only. Reading or saving a choice
//! cannot check, download, stage, or apply an update.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError, Weak};

use fs2::FileExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::application_update::ApplicationChannel;
use crate::application_update_storage::write_bytes_atomically;
use crate::{DesktopError, DesktopResult, blocking_worker};

const PREFERENCE_SCHEMA_VERSION: u32 = 1;
const MAX_PREFERENCE_BYTES: u64 = 64 * 1024;
const DEFAULT_FILE: &str = "application-updates.json";

type ProcessLock = Arc<Mutex<()>>;
type ProcessLockRegistry = Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>;

static PROCESS_LOCKS: OnceLock<ProcessLockRegistry> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdatePreferenceError {
    #[error("application update preferences are already being changed")]
    Busy,
    #[error("application update preference path is invalid: {0}")]
    InvalidPath(String),
    #[error("application update preferences are invalid: {0}")]
    InvalidState(String),
    #[error("application update preference schema {0} is unsupported")]
    UnsupportedSchema(u32),
    #[error("application update preferences changed from revision {expected} to {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("application update preference I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("application update preference serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationUpdateMode {
    Automatic,
    NotifyOnly,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdateChoice {
    pub channel: ApplicationChannel,
    pub mode: ApplicationUpdateMode,
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdatePreferences {
    pub schema_version: u32,
    pub revision: u64,
    /// `None` means the user has not completed the one-time choice.
    pub choice: Option<ApplicationUpdateChoice>,
}

impl Default for ApplicationUpdatePreferences {
    fn default() -> Self {
        Self {
            schema_version: PREFERENCE_SCHEMA_VERSION,
            revision: 0,
            choice: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ApplicationUpdatePreferenceStore {
    path: PathBuf,
    process_lock: ProcessLock,
}

#[derive(Clone)]
pub(crate) struct ApplicationUpdatePreferenceState {
    store: DesktopResult<ApplicationUpdatePreferenceStore>,
}

struct PreferenceLock<'a> {
    file: File,
    _process_guard: MutexGuard<'a, ()>,
}

impl Drop for PreferenceLock<'_> {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

impl ApplicationUpdatePreferenceStore {
    pub fn default_path() -> Result<PathBuf, ApplicationUpdatePreferenceError> {
        let host_preferences = portcove_core::HostPreferenceStore::default_path()
            .map_err(|error| ApplicationUpdatePreferenceError::InvalidPath(error.to_string()))?;
        Ok(host_preferences.with_file_name(DEFAULT_FILE))
    }

    pub fn open_configured() -> Result<Self, ApplicationUpdatePreferenceError> {
        let path = std::env::var_os("PORTCOVE_APPLICATION_UPDATE_PREFERENCES")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(Self::default_path)?;
        Self::new(path)
    }

    pub fn new(path: PathBuf) -> Result<Self, ApplicationUpdatePreferenceError> {
        validate_path(&path)?;
        let process_lock = process_lock(&path)?;
        Ok(Self { path, process_lock })
    }

    pub fn load(&self) -> Result<ApplicationUpdatePreferences, ApplicationUpdatePreferenceError> {
        refuse_symlink_ancestors(&self.path)?;
        let metadata = match fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ApplicationUpdatePreferences::default());
            }
            Err(error) => return Err(error.into()),
            Ok(metadata) => metadata,
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() == 0
            || metadata.len() > MAX_PREFERENCE_BYTES
        {
            return Err(ApplicationUpdatePreferenceError::InvalidState(
                "preference document is not a bounded direct file".into(),
            ));
        }
        let bytes = fs::read(&self.path)?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_PREFERENCE_BYTES {
            return Err(ApplicationUpdatePreferenceError::InvalidState(
                "preference document changed size while being read".into(),
            ));
        }
        let preferences: ApplicationUpdatePreferences =
            serde_json::from_slice(&bytes).map_err(|error| {
                ApplicationUpdatePreferenceError::InvalidState(format!(
                    "document is malformed; explicitly reset or repair it: {error}"
                ))
            })?;
        validate_preferences(&preferences)?;
        Ok(preferences)
    }

    /// Saves a complete explicit choice if the caller observed the current
    /// revision. An unchanged choice is an idempotent read and does not rewrite.
    pub fn save_choice(
        &self,
        expected_revision: u64,
        choice: ApplicationUpdateChoice,
    ) -> Result<ApplicationUpdatePreferences, ApplicationUpdatePreferenceError> {
        let _lock = self.lock()?;
        let mut preferences = self.load()?;
        if preferences.revision != expected_revision {
            return Err(ApplicationUpdatePreferenceError::RevisionConflict {
                expected: expected_revision,
                actual: preferences.revision,
            });
        }
        if preferences.choice.as_ref() == Some(&choice) {
            return Ok(preferences);
        }
        preferences.revision = preferences.revision.checked_add(1).ok_or_else(|| {
            ApplicationUpdatePreferenceError::InvalidState(
                "preference revision is exhausted".into(),
            )
        })?;
        preferences.choice = Some(choice);
        self.publish(&preferences)?;
        Ok(preferences)
    }

    /// Explicit recovery replaces corrupt or future state with no recorded
    /// consent. It cannot start any updater operation.
    pub fn reset(&self) -> Result<ApplicationUpdatePreferences, ApplicationUpdatePreferenceError> {
        let _lock = self.lock()?;
        let revision = match self.load() {
            Ok(current) => current.revision.checked_add(1).ok_or_else(|| {
                ApplicationUpdatePreferenceError::InvalidState(
                    "preference revision is exhausted".into(),
                )
            })?,
            Err(ApplicationUpdatePreferenceError::InvalidState(_))
            | Err(ApplicationUpdatePreferenceError::UnsupportedSchema(_)) => {
                self.next_recovery_revision()?
            }
            Err(error) => return Err(error),
        };
        let preferences = ApplicationUpdatePreferences {
            revision,
            ..ApplicationUpdatePreferences::default()
        };
        self.publish(&preferences)?;
        Ok(preferences)
    }

    fn lock(&self) -> Result<PreferenceLock<'_>, ApplicationUpdatePreferenceError> {
        let process_guard = match self.process_lock.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => return Err(ApplicationUpdatePreferenceError::Busy),
            Err(TryLockError::Poisoned(_)) => {
                return Err(ApplicationUpdatePreferenceError::InvalidState(
                    "process lock was poisoned".into(),
                ));
            }
        };
        let parent = self.path.parent().ok_or_else(|| {
            ApplicationUpdatePreferenceError::InvalidPath(
                "preference path needs a parent directory".into(),
            )
        })?;
        fs::create_dir_all(parent)?;
        refuse_symlink_ancestors(parent)?;
        let lock_path = sibling_path(&self.path, ".lock")?;
        refuse_symlink_ancestors(&lock_path)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(PreferenceLock {
                file,
                _process_guard: process_guard,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Err(ApplicationUpdatePreferenceError::Busy)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn publish(
        &self,
        preferences: &ApplicationUpdatePreferences,
    ) -> Result<(), ApplicationUpdatePreferenceError> {
        validate_preferences(preferences)?;
        let mut bytes = serde_json::to_vec_pretty(preferences)?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_PREFERENCE_BYTES {
            return Err(ApplicationUpdatePreferenceError::InvalidState(
                "serialized preference document exceeds its limit".into(),
            ));
        }
        let parent = self.path.parent().ok_or_else(|| {
            ApplicationUpdatePreferenceError::InvalidPath(
                "preference path needs a parent directory".into(),
            )
        })?;
        refuse_symlink_ancestors(parent)?;
        let destination = file_name(&self.path)?;
        let temporary = format!(".{destination}.tmp");
        write_bytes_atomically(parent, &temporary, destination, &bytes)?;
        Ok(())
    }

    fn next_recovery_revision(&self) -> Result<u64, ApplicationUpdatePreferenceError> {
        let revision = fs::read(&self.path)
            .ok()
            .filter(|bytes| !bytes.is_empty() && bytes.len() as u64 <= MAX_PREFERENCE_BYTES)
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|document| document.get("revision").and_then(serde_json::Value::as_u64))
            .unwrap_or(0);
        revision.checked_add(1).ok_or_else(|| {
            ApplicationUpdatePreferenceError::InvalidState(
                "preference revision is exhausted".into(),
            )
        })
    }
}

pub(crate) fn configured_state() -> ApplicationUpdatePreferenceState {
    ApplicationUpdatePreferenceState {
        store: ApplicationUpdatePreferenceStore::open_configured().map_err(desktop_error),
    }
}

#[tauri::command]
pub(crate) async fn get_application_update_preferences(
    state: tauri::State<'_, ApplicationUpdatePreferenceState>,
) -> DesktopResult<ApplicationUpdatePreferences> {
    let store = state.store.as_ref().map_err(Clone::clone)?.clone();
    blocking_worker(move || store.load().map_err(desktop_error)).await
}

#[tauri::command]
pub(crate) async fn set_application_update_preferences(
    state: tauri::State<'_, ApplicationUpdatePreferenceState>,
    expected_revision: u64,
    choice: ApplicationUpdateChoice,
) -> DesktopResult<ApplicationUpdatePreferences> {
    let store = state.store.as_ref().map_err(Clone::clone)?.clone();
    blocking_worker(move || {
        store
            .save_choice(expected_revision, choice)
            .map_err(desktop_error)
    })
    .await
}

#[tauri::command]
pub(crate) async fn reset_application_update_preferences(
    state: tauri::State<'_, ApplicationUpdatePreferenceState>,
) -> DesktopResult<ApplicationUpdatePreferences> {
    let store = state.store.as_ref().map_err(Clone::clone)?.clone();
    blocking_worker(move || store.reset().map_err(desktop_error)).await
}

fn desktop_error(error: ApplicationUpdatePreferenceError) -> DesktopError {
    let message = error.to_string();
    match error {
        ApplicationUpdatePreferenceError::Busy
        | ApplicationUpdatePreferenceError::RevisionConflict { .. } => {
            portcove_core::PortcoveError::conflict(message).into()
        }
        ApplicationUpdatePreferenceError::UnsupportedSchema(_) => {
            portcove_core::PortcoveError::unsupported(message).into()
        }
        ApplicationUpdatePreferenceError::InvalidPath(_)
        | ApplicationUpdatePreferenceError::InvalidState(_)
        | ApplicationUpdatePreferenceError::Io(_)
        | ApplicationUpdatePreferenceError::Serialization(_) => {
            portcove_core::PortcoveError::state(message).into()
        }
    }
}

pub(crate) fn validate_preferences(
    preferences: &ApplicationUpdatePreferences,
) -> Result<(), ApplicationUpdatePreferenceError> {
    if preferences.schema_version != PREFERENCE_SCHEMA_VERSION {
        return Err(ApplicationUpdatePreferenceError::UnsupportedSchema(
            preferences.schema_version,
        ));
    }
    if preferences.choice.is_some() && preferences.revision == 0 {
        return Err(ApplicationUpdatePreferenceError::InvalidState(
            "consent choice and revision are inconsistent".into(),
        ));
    }
    Ok(())
}

fn process_lock(path: &Path) -> Result<ProcessLock, ApplicationUpdatePreferenceError> {
    let registry = PROCESS_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = registry.lock().map_err(|_| {
        ApplicationUpdatePreferenceError::InvalidState("lock registry was poisoned".into())
    })?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    Ok(lock)
}

fn validate_path(path: &Path) -> Result<(), ApplicationUpdatePreferenceError> {
    if !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ApplicationUpdatePreferenceError::InvalidPath(
            "path must be absolute, name a file, and contain no parent traversal".into(),
        ));
    }
    file_name(path)?;
    Ok(())
}

fn file_name(path: &Path) -> Result<&str, ApplicationUpdatePreferenceError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            ApplicationUpdatePreferenceError::InvalidPath(
                "preference filename must be valid Unicode".into(),
            )
        })
}

fn sibling_path(path: &Path, suffix: &str) -> Result<PathBuf, ApplicationUpdatePreferenceError> {
    let name = format!("{}{suffix}", file_name(path)?);
    Ok(path.with_file_name(name))
}

fn refuse_symlink_ancestors(path: &Path) -> Result<(), ApplicationUpdatePreferenceError> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApplicationUpdatePreferenceError::InvalidPath(format!(
                    "path contains a symbolic link: {}",
                    candidate.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        current = candidate.parent();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(mode: ApplicationUpdateMode) -> ApplicationUpdateChoice {
        ApplicationUpdateChoice {
            channel: ApplicationChannel::Preview,
            mode,
            paused: false,
        }
    }

    #[test]
    fn missing_state_is_unconsented_and_read_only() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("application-updates.json");
        let store = ApplicationUpdatePreferenceStore::new(path.clone()).unwrap();

        assert_eq!(
            store.load().unwrap(),
            ApplicationUpdatePreferences::default()
        );
        assert!(!path.exists());
    }

    #[test]
    fn explicit_choice_survives_restart_and_is_idempotent() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("application-updates.json");
        let store = ApplicationUpdatePreferenceStore::new(path.clone()).unwrap();
        let selected = store
            .save_choice(0, choice(ApplicationUpdateMode::Automatic))
            .unwrap();
        assert_eq!(selected.revision, 1);

        let bytes = fs::read(&path).unwrap();
        let restarted = ApplicationUpdatePreferenceStore::new(path).unwrap();
        assert_eq!(restarted.load().unwrap(), selected);
        assert_eq!(
            restarted
                .save_choice(1, choice(ApplicationUpdateMode::Automatic))
                .unwrap(),
            selected
        );
        assert_eq!(fs::read(restarted.path).unwrap(), bytes);
    }

    #[test]
    fn stale_revision_cannot_replace_a_newer_choice() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("application-updates.json");
        let first = ApplicationUpdatePreferenceStore::new(path.clone()).unwrap();
        let stale = ApplicationUpdatePreferenceStore::new(path).unwrap();
        first
            .save_choice(0, choice(ApplicationUpdateMode::NotifyOnly))
            .unwrap();

        assert!(matches!(
            stale.save_choice(0, choice(ApplicationUpdateMode::Manual)),
            Err(ApplicationUpdatePreferenceError::RevisionConflict {
                expected: 0,
                actual: 1
            })
        ));
        assert_eq!(
            first.load().unwrap().choice.unwrap().mode,
            ApplicationUpdateMode::NotifyOnly
        );

        let reset = first.reset().unwrap();
        assert_eq!(reset.revision, 2);
        assert!(reset.choice.is_none());
        assert!(matches!(
            stale.save_choice(1, choice(ApplicationUpdateMode::Manual)),
            Err(ApplicationUpdatePreferenceError::RevisionConflict {
                expected: 1,
                actual: 2
            })
        ));
    }

    #[test]
    fn malformed_future_and_inconsistent_state_require_explicit_reset() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("application-updates.json");
        let store = ApplicationUpdatePreferenceStore::new(path.clone()).unwrap();
        fs::write(&path, b"{").unwrap();
        assert!(matches!(
            store.load(),
            Err(ApplicationUpdatePreferenceError::InvalidState(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), b"{");

        fs::write(&path, br#"{"schema_version":2,"revision":7,"choice":null}"#).unwrap();
        assert!(matches!(
            store.load(),
            Err(ApplicationUpdatePreferenceError::UnsupportedSchema(2))
        ));
        let reset_future = store.reset().unwrap();
        assert_eq!(reset_future.revision, 8);
        assert!(reset_future.choice.is_none());

        fs::write(
            &path,
            br#"{"schema_version":1,"revision":0,"choice":{"channel":"preview","mode":"manual","paused":false}}"#,
        )
        .unwrap();
        assert!(matches!(
            store.load(),
            Err(ApplicationUpdatePreferenceError::InvalidState(_))
        ));

        let reset = store.reset().unwrap();
        assert_eq!(reset.revision, 1);
        assert!(reset.choice.is_none());
        assert_eq!(store.load().unwrap(), reset);
    }

    #[test]
    fn unknown_fields_and_unsafe_paths_fail_closed() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("application-updates.json");
        fs::write(
            &path,
            br#"{"schema_version":1,"revision":0,"choice":null,"install":true}"#,
        )
        .unwrap();
        let store = ApplicationUpdatePreferenceStore::new(path).unwrap();
        assert!(matches!(
            store.load(),
            Err(ApplicationUpdatePreferenceError::InvalidState(_))
        ));
        assert!(ApplicationUpdatePreferenceStore::new(PathBuf::from("relative.json")).is_err());
    }
}
