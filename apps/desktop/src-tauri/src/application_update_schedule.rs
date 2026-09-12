//! Durable host policy for deciding when an application-update check is due.
//!
//! This module does not perform network activity. It combines the explicit host
//! preference, observable connection state, startup delay and persisted cadence
//! into a decision that a later updater coordinator may act on.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError, Weak};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::application_update_preferences::{
    ApplicationUpdateMode, ApplicationUpdatePreferenceStore, ApplicationUpdatePreferences,
};
use crate::application_update_storage::write_bytes_atomically;

const SCHEDULE_SCHEMA_VERSION: u32 = 1;
const MAX_SCHEDULE_BYTES: u64 = 64 * 1024;
const DEFAULT_FILE: &str = "application-update-schedule.json";
const STARTUP_DELAY_SECONDS: u64 = 30;
const SUCCESS_INTERVAL_SECONDS: u64 = 24 * 60 * 60;
const RETRY_BASE_SECONDS: u64 = 15 * 60;
const RETRY_BASE_CAP_SECONDS: u64 = 5 * 60 * 60;
const RETRY_TOTAL_CAP_SECONDS: u64 = 6 * 60 * 60;
const MAX_FAILURE_COUNT: u32 = 32;

type ProcessLock = Arc<Mutex<()>>;
type ProcessLockRegistry = Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>;

static PROCESS_LOCKS: OnceLock<ProcessLockRegistry> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdateScheduleError {
    #[error("application update schedule is already being changed")]
    Busy,
    #[error("application update schedule path is invalid: {0}")]
    InvalidPath(String),
    #[error("application update schedule state is invalid: {0}")]
    InvalidState(String),
    #[error("application update schedule schema {0} is unsupported")]
    UnsupportedSchema(u32),
    #[error("application update schedule changed from revision {expected} to {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("application update schedule I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("application update schedule serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplicationUpdateCheckRequest {
    Automatic,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkAvailability {
    Online,
    Offline,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeteredConnection {
    Unmetered,
    Metered,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplicationUpdateCheckContext {
    pub request: ApplicationUpdateCheckRequest,
    pub now_unix_seconds: u64,
    pub startup_unix_seconds: u64,
    pub network: NetworkAvailability,
    pub metered: MeteredConnection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplicationUpdateCheckHold {
    ConsentRequired,
    Paused,
    ManualMode,
    Offline,
    Metered,
    MeteredStateUnknown,
    StartupDelay,
    Cadence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplicationUpdateCheckDecision {
    CheckNow,
    Hold {
        reason: ApplicationUpdateCheckHold,
        retry_at_unix_seconds: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationUpdateSchedule {
    pub schema_version: u32,
    pub revision: u64,
    pub preference_revision: Option<u64>,
    pub last_success_unix_seconds: Option<u64>,
    pub consecutive_failures: u32,
    pub next_automatic_check_unix_seconds: Option<u64>,
}

impl Default for ApplicationUpdateSchedule {
    fn default() -> Self {
        Self {
            schema_version: SCHEDULE_SCHEMA_VERSION,
            revision: 0,
            preference_revision: None,
            last_success_unix_seconds: None,
            consecutive_failures: 0,
            next_automatic_check_unix_seconds: None,
        }
    }
}

impl ApplicationUpdateSchedule {
    pub fn decide(
        &self,
        preferences: &ApplicationUpdatePreferences,
        context: ApplicationUpdateCheckContext,
    ) -> ApplicationUpdateCheckDecision {
        let Some(choice) = preferences.choice.as_ref() else {
            return hold(ApplicationUpdateCheckHold::ConsentRequired, None);
        };
        if context.network == NetworkAvailability::Offline {
            return hold(ApplicationUpdateCheckHold::Offline, None);
        }
        if context.request == ApplicationUpdateCheckRequest::Manual {
            return ApplicationUpdateCheckDecision::CheckNow;
        }
        if choice.paused {
            return hold(ApplicationUpdateCheckHold::Paused, None);
        }
        if choice.mode == ApplicationUpdateMode::Manual {
            return hold(ApplicationUpdateCheckHold::ManualMode, None);
        }
        match context.metered {
            MeteredConnection::Metered => {
                return hold(ApplicationUpdateCheckHold::Metered, None);
            }
            MeteredConnection::Unknown => {
                return hold(ApplicationUpdateCheckHold::MeteredStateUnknown, None);
            }
            MeteredConnection::Unmetered => {}
        }

        let startup_due = context
            .startup_unix_seconds
            .saturating_add(STARTUP_DELAY_SECONDS);
        if context.now_unix_seconds < startup_due {
            return hold(ApplicationUpdateCheckHold::StartupDelay, Some(startup_due));
        }
        let schedule_due = if self.preference_revision == Some(preferences.revision) {
            let successful_check_due = self
                .last_success_unix_seconds
                .map(|last| last.saturating_add(SUCCESS_INTERVAL_SECONDS));
            later_timestamp(successful_check_due, self.next_automatic_check_unix_seconds)
        } else {
            None
        };
        if let Some(due) = schedule_due
            && context.now_unix_seconds < due
        {
            return hold(ApplicationUpdateCheckHold::Cadence, Some(due));
        }
        ApplicationUpdateCheckDecision::CheckNow
    }
}

#[derive(Debug, Clone)]
pub struct ApplicationUpdateScheduleStore {
    path: PathBuf,
    process_lock: ProcessLock,
}

struct ScheduleLock<'a> {
    file: File,
    _process_guard: MutexGuard<'a, ()>,
}

impl Drop for ScheduleLock<'_> {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

impl ApplicationUpdateScheduleStore {
    pub fn default_path() -> Result<PathBuf, ApplicationUpdateScheduleError> {
        let preferences = ApplicationUpdatePreferenceStore::default_path()
            .map_err(|error| ApplicationUpdateScheduleError::InvalidPath(error.to_string()))?;
        Ok(preferences.with_file_name(DEFAULT_FILE))
    }

    pub fn open_configured() -> Result<Self, ApplicationUpdateScheduleError> {
        let path = std::env::var_os("PORTCOVE_APPLICATION_UPDATE_SCHEDULE")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(Self::default_path)?;
        Self::new(path)
    }

    pub fn new(path: PathBuf) -> Result<Self, ApplicationUpdateScheduleError> {
        validate_path(&path)?;
        Ok(Self {
            process_lock: process_lock(&path)?,
            path,
        })
    }

    pub fn load(&self) -> Result<ApplicationUpdateSchedule, ApplicationUpdateScheduleError> {
        refuse_symlink_ancestors(&self.path)?;
        let metadata = match fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ApplicationUpdateSchedule::default());
            }
            Err(error) => return Err(error.into()),
            Ok(metadata) => metadata,
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() == 0
            || metadata.len() > MAX_SCHEDULE_BYTES
        {
            return Err(ApplicationUpdateScheduleError::InvalidState(
                "schedule document is not a bounded direct file".into(),
            ));
        }
        let bytes = fs::read(&self.path)?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_SCHEDULE_BYTES {
            return Err(ApplicationUpdateScheduleError::InvalidState(
                "schedule document changed size while being read".into(),
            ));
        }
        let schedule: ApplicationUpdateSchedule =
            serde_json::from_slice(&bytes).map_err(|error| {
                ApplicationUpdateScheduleError::InvalidState(format!(
                    "document is malformed; explicitly reset or repair it: {error}"
                ))
            })?;
        validate_schedule(&schedule)?;
        Ok(schedule)
    }

    pub fn record_success(
        &self,
        expected_revision: u64,
        preference_revision: u64,
        now_unix_seconds: u64,
    ) -> Result<ApplicationUpdateSchedule, ApplicationUpdateScheduleError> {
        self.update(expected_revision, |schedule| {
            schedule.preference_revision = Some(preference_revision);
            schedule.last_success_unix_seconds = Some(now_unix_seconds);
            schedule.consecutive_failures = 0;
            schedule.next_automatic_check_unix_seconds =
                Some(now_unix_seconds.saturating_add(SUCCESS_INTERVAL_SECONDS));
        })
    }

    pub fn record_failure(
        &self,
        expected_revision: u64,
        preference_revision: u64,
        now_unix_seconds: u64,
        jitter_seed: u64,
    ) -> Result<ApplicationUpdateSchedule, ApplicationUpdateScheduleError> {
        self.update(expected_revision, |schedule| {
            if schedule.preference_revision != Some(preference_revision) {
                schedule.last_success_unix_seconds = None;
                schedule.consecutive_failures = 0;
                schedule.next_automatic_check_unix_seconds = None;
            }
            schedule.preference_revision = Some(preference_revision);
            schedule.consecutive_failures = schedule
                .consecutive_failures
                .saturating_add(1)
                .min(MAX_FAILURE_COUNT);
            let retry_at = now_unix_seconds.saturating_add(retry_delay_seconds(
                schedule.consecutive_failures,
                jitter_seed,
            ));
            schedule.next_automatic_check_unix_seconds =
                later_timestamp(schedule.next_automatic_check_unix_seconds, Some(retry_at));
        })
    }

    /// Explicit recovery clears cadence state while advancing any readable
    /// revision. It cannot start an updater operation.
    pub fn reset(&self) -> Result<ApplicationUpdateSchedule, ApplicationUpdateScheduleError> {
        let _lock = self.lock()?;
        self.reset_locked(false)
    }

    /// Repairs malformed or future state only while it is still invalid.
    /// A stale recovery action cannot clear a schedule that another process repaired.
    pub fn recover_invalid(
        &self,
    ) -> Result<ApplicationUpdateSchedule, ApplicationUpdateScheduleError> {
        let _lock = self.lock()?;
        self.reset_locked(true)
    }

    fn reset_locked(
        &self,
        require_invalid: bool,
    ) -> Result<ApplicationUpdateSchedule, ApplicationUpdateScheduleError> {
        let revision = match self.load() {
            Ok(_) if require_invalid => {
                return Err(ApplicationUpdateScheduleError::InvalidState(
                    "schedule state no longer requires recovery".into(),
                ));
            }
            Ok(current) => next_revision(current.revision)?,
            Err(ApplicationUpdateScheduleError::InvalidState(_))
            | Err(ApplicationUpdateScheduleError::UnsupportedSchema(_)) => {
                next_revision(self.recovery_revision())?
            }
            Err(error) => return Err(error),
        };
        let schedule = ApplicationUpdateSchedule {
            revision,
            ..ApplicationUpdateSchedule::default()
        };
        self.publish(&schedule)?;
        Ok(schedule)
    }

    fn update(
        &self,
        expected_revision: u64,
        operation: impl FnOnce(&mut ApplicationUpdateSchedule),
    ) -> Result<ApplicationUpdateSchedule, ApplicationUpdateScheduleError> {
        let _lock = self.lock()?;
        let mut schedule = self.load()?;
        if schedule.revision != expected_revision {
            return Err(ApplicationUpdateScheduleError::RevisionConflict {
                expected: expected_revision,
                actual: schedule.revision,
            });
        }
        schedule.revision = next_revision(schedule.revision)?;
        operation(&mut schedule);
        self.publish(&schedule)?;
        Ok(schedule)
    }

    fn lock(&self) -> Result<ScheduleLock<'_>, ApplicationUpdateScheduleError> {
        let process_guard = match self.process_lock.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => return Err(ApplicationUpdateScheduleError::Busy),
            Err(TryLockError::Poisoned(_)) => {
                return Err(ApplicationUpdateScheduleError::InvalidState(
                    "process lock was poisoned".into(),
                ));
            }
        };
        let parent = self.path.parent().ok_or_else(|| {
            ApplicationUpdateScheduleError::InvalidPath(
                "schedule path needs a parent directory".into(),
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
            .open(lock_path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(ScheduleLock {
                file,
                _process_guard: process_guard,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Err(ApplicationUpdateScheduleError::Busy)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn publish(
        &self,
        schedule: &ApplicationUpdateSchedule,
    ) -> Result<(), ApplicationUpdateScheduleError> {
        validate_schedule(schedule)?;
        let mut bytes = serde_json::to_vec_pretty(schedule)?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_SCHEDULE_BYTES {
            return Err(ApplicationUpdateScheduleError::InvalidState(
                "serialized schedule document exceeds its limit".into(),
            ));
        }
        let parent = self.path.parent().ok_or_else(|| {
            ApplicationUpdateScheduleError::InvalidPath(
                "schedule path needs a parent directory".into(),
            )
        })?;
        refuse_symlink_ancestors(parent)?;
        let destination = file_name(&self.path)?;
        let temporary = format!(".{destination}.tmp");
        write_bytes_atomically(parent, &temporary, destination, &bytes)?;
        Ok(())
    }

    fn recovery_revision(&self) -> u64 {
        fs::read(&self.path)
            .ok()
            .filter(|bytes| !bytes.is_empty() && bytes.len() as u64 <= MAX_SCHEDULE_BYTES)
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|document| document.get("revision").and_then(serde_json::Value::as_u64))
            .unwrap_or(0)
    }
}

fn hold(
    reason: ApplicationUpdateCheckHold,
    retry_at_unix_seconds: Option<u64>,
) -> ApplicationUpdateCheckDecision {
    ApplicationUpdateCheckDecision::Hold {
        reason,
        retry_at_unix_seconds,
    }
}

fn later_timestamp(first: Option<u64>, second: Option<u64>) -> Option<u64> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first.max(second)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn retry_delay_seconds(failure_count: u32, jitter_seed: u64) -> u64 {
    let shift = failure_count.saturating_sub(1).min(63);
    let base = RETRY_BASE_SECONDS
        .saturating_mul(1_u64 << shift)
        .min(RETRY_BASE_CAP_SECONDS);
    let jitter_limit = base / 5;
    let mixed = jitter_seed
        .wrapping_add(u64::from(failure_count).wrapping_mul(0x9E37_79B9_7F4A_7C15))
        .rotate_left(17)
        ^ 0xA076_1D64_78BD_642F;
    let jitter = if jitter_limit == 0 {
        0
    } else {
        mixed % (jitter_limit + 1)
    };
    base.saturating_add(jitter).min(RETRY_TOTAL_CAP_SECONDS)
}

fn validate_schedule(
    schedule: &ApplicationUpdateSchedule,
) -> Result<(), ApplicationUpdateScheduleError> {
    if schedule.schema_version != SCHEDULE_SCHEMA_VERSION {
        return Err(ApplicationUpdateScheduleError::UnsupportedSchema(
            schedule.schema_version,
        ));
    }
    if schedule.consecutive_failures > MAX_FAILURE_COUNT {
        return Err(ApplicationUpdateScheduleError::InvalidState(
            "failure count exceeds its bound".into(),
        ));
    }
    if schedule.revision == 0
        && (schedule.preference_revision.is_some()
            || schedule.last_success_unix_seconds.is_some()
            || schedule.consecutive_failures != 0
            || schedule.next_automatic_check_unix_seconds.is_some())
    {
        return Err(ApplicationUpdateScheduleError::InvalidState(
            "schedule values and revision are inconsistent".into(),
        ));
    }
    let has_outcome = schedule.last_success_unix_seconds.is_some()
        || schedule.consecutive_failures != 0
        || schedule.next_automatic_check_unix_seconds.is_some();
    if schedule.preference_revision.is_some() != has_outcome {
        return Err(ApplicationUpdateScheduleError::InvalidState(
            "schedule outcome and preference revision are inconsistent".into(),
        ));
    }
    if schedule.consecutive_failures != 0 && schedule.next_automatic_check_unix_seconds.is_none() {
        return Err(ApplicationUpdateScheduleError::InvalidState(
            "failed checks require a retry boundary".into(),
        ));
    }
    if let Some(last_success) = schedule.last_success_unix_seconds {
        let minimum_next = last_success.saturating_add(SUCCESS_INTERVAL_SECONDS);
        if schedule
            .next_automatic_check_unix_seconds
            .is_none_or(|next| next < minimum_next)
        {
            return Err(ApplicationUpdateScheduleError::InvalidState(
                "successful check does not preserve the daily cadence".into(),
            ));
        }
    } else if schedule.consecutive_failures == 0
        && schedule.next_automatic_check_unix_seconds.is_some()
    {
        return Err(ApplicationUpdateScheduleError::InvalidState(
            "retry boundary has no matching outcome".into(),
        ));
    }
    Ok(())
}

fn next_revision(revision: u64) -> Result<u64, ApplicationUpdateScheduleError> {
    revision.checked_add(1).ok_or_else(|| {
        ApplicationUpdateScheduleError::InvalidState("schedule revision is exhausted".into())
    })
}

fn process_lock(path: &Path) -> Result<ProcessLock, ApplicationUpdateScheduleError> {
    let registry = PROCESS_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = registry.lock().map_err(|_| {
        ApplicationUpdateScheduleError::InvalidState("lock registry was poisoned".into())
    })?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    Ok(lock)
}

fn validate_path(path: &Path) -> Result<(), ApplicationUpdateScheduleError> {
    if !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ApplicationUpdateScheduleError::InvalidPath(
            "path must be absolute, name a file, and contain no parent traversal".into(),
        ));
    }
    file_name(path)?;
    Ok(())
}

fn file_name(path: &Path) -> Result<&str, ApplicationUpdateScheduleError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            ApplicationUpdateScheduleError::InvalidPath(
                "schedule filename must be valid Unicode".into(),
            )
        })
}

fn sibling_path(path: &Path, suffix: &str) -> Result<PathBuf, ApplicationUpdateScheduleError> {
    Ok(path.with_file_name(format!("{}{suffix}", file_name(path)?)))
}

fn refuse_symlink_ancestors(path: &Path) -> Result<(), ApplicationUpdateScheduleError> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApplicationUpdateScheduleError::InvalidPath(format!(
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
    use crate::application_update::ApplicationChannel;
    use crate::application_update_preferences::ApplicationUpdateChoice;

    fn choice(mode: ApplicationUpdateMode, paused: bool) -> ApplicationUpdateChoice {
        ApplicationUpdateChoice {
            channel: ApplicationChannel::Preview,
            mode,
            paused,
        }
    }

    fn preferences(
        revision: u64,
        mode: ApplicationUpdateMode,
        paused: bool,
    ) -> ApplicationUpdatePreferences {
        ApplicationUpdatePreferences {
            schema_version: 1,
            revision,
            choice: Some(choice(mode, paused)),
        }
    }

    fn context(request: ApplicationUpdateCheckRequest, now: u64) -> ApplicationUpdateCheckContext {
        ApplicationUpdateCheckContext {
            request,
            now_unix_seconds: now,
            startup_unix_seconds: 1_000,
            network: NetworkAvailability::Online,
            metered: MeteredConnection::Unmetered,
        }
    }

    #[test]
    fn automatic_checks_require_consent_and_automatic_policy() {
        let schedule = ApplicationUpdateSchedule::default();
        assert_eq!(
            schedule.decide(
                &ApplicationUpdatePreferences::default(),
                context(ApplicationUpdateCheckRequest::Automatic, 2_000)
            ),
            hold(ApplicationUpdateCheckHold::ConsentRequired, None)
        );
        assert_eq!(
            schedule.decide(
                &preferences(1, ApplicationUpdateMode::Manual, false),
                context(ApplicationUpdateCheckRequest::Automatic, 2_000)
            ),
            hold(ApplicationUpdateCheckHold::ManualMode, None)
        );
        assert_eq!(
            schedule.decide(
                &preferences(1, ApplicationUpdateMode::NotifyOnly, true),
                context(ApplicationUpdateCheckRequest::Automatic, 2_000)
            ),
            hold(ApplicationUpdateCheckHold::Paused, None)
        );
    }

    #[test]
    fn automatic_checks_wait_for_startup_and_daily_cadence() {
        let selected_preferences = preferences(1, ApplicationUpdateMode::Automatic, false);
        let mut schedule = ApplicationUpdateSchedule::default();
        assert_eq!(
            schedule.decide(
                &selected_preferences,
                context(ApplicationUpdateCheckRequest::Automatic, 1_029)
            ),
            hold(ApplicationUpdateCheckHold::StartupDelay, Some(1_030))
        );
        assert_eq!(
            schedule.decide(
                &selected_preferences,
                context(ApplicationUpdateCheckRequest::Automatic, 1_030)
            ),
            ApplicationUpdateCheckDecision::CheckNow
        );

        schedule.revision = 1;
        schedule.preference_revision = Some(1);
        schedule.last_success_unix_seconds = Some(2_000);
        schedule.next_automatic_check_unix_seconds = Some(2_000 + SUCCESS_INTERVAL_SECONDS);
        assert_eq!(
            schedule.decide(
                &selected_preferences,
                context(
                    ApplicationUpdateCheckRequest::Automatic,
                    2_000 + SUCCESS_INTERVAL_SECONDS - 1
                )
            ),
            hold(
                ApplicationUpdateCheckHold::Cadence,
                Some(2_000 + SUCCESS_INTERVAL_SECONDS)
            )
        );
        assert_eq!(
            schedule.decide(
                &selected_preferences,
                context(
                    ApplicationUpdateCheckRequest::Automatic,
                    2_000 + SUCCESS_INTERVAL_SECONDS
                )
            ),
            ApplicationUpdateCheckDecision::CheckNow
        );
        assert_eq!(
            schedule.decide(
                &preferences(2, ApplicationUpdateMode::Automatic, false),
                context(
                    ApplicationUpdateCheckRequest::Automatic,
                    2_000 + SUCCESS_INTERVAL_SECONDS - 1
                )
            ),
            ApplicationUpdateCheckDecision::CheckNow
        );
    }

    #[test]
    fn connection_holds_are_explicit_and_manual_checks_override_local_policy() {
        let schedule = ApplicationUpdateSchedule::default();
        let paused = preferences(1, ApplicationUpdateMode::Manual, true);
        let mut automatic = context(ApplicationUpdateCheckRequest::Automatic, 2_000);
        automatic.metered = MeteredConnection::Unknown;
        assert_eq!(
            schedule.decide(&paused, automatic),
            hold(ApplicationUpdateCheckHold::Paused, None)
        );

        let mut manual = context(ApplicationUpdateCheckRequest::Manual, 1_001);
        manual.metered = MeteredConnection::Metered;
        assert_eq!(
            schedule.decide(&paused, manual),
            ApplicationUpdateCheckDecision::CheckNow
        );
        manual.network = NetworkAvailability::Offline;
        assert_eq!(
            schedule.decide(&paused, manual),
            hold(ApplicationUpdateCheckHold::Offline, None)
        );
    }

    #[test]
    fn retry_backoff_and_jitter_are_bounded() {
        for failure in 1..=MAX_FAILURE_COUNT {
            let lower = RETRY_BASE_SECONDS
                .saturating_mul(1_u64 << failure.saturating_sub(1).min(63))
                .min(RETRY_BASE_CAP_SECONDS);
            for seed in [0, 1, u64::MAX / 2, u64::MAX] {
                let delay = retry_delay_seconds(failure, seed);
                assert!(delay >= lower);
                assert!(delay <= RETRY_TOTAL_CAP_SECONDS);
                assert!(delay <= lower.saturating_add(lower / 5));
            }
        }
    }

    #[test]
    fn persisted_outcomes_survive_restart_and_never_shorten_a_hold() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join(DEFAULT_FILE);
        let store = ApplicationUpdateScheduleStore::new(path.clone()).unwrap();
        let success = store.record_success(0, 3, 10_000).unwrap();
        assert_eq!(success.revision, 1);
        assert_eq!(
            success.next_automatic_check_unix_seconds,
            Some(10_000 + SUCCESS_INTERVAL_SECONDS)
        );

        let failed = store.record_failure(1, 3, 10_001, 7).unwrap();
        assert_eq!(failed.revision, 2);
        assert_eq!(
            failed.next_automatic_check_unix_seconds,
            success.next_automatic_check_unix_seconds
        );
        assert_eq!(
            ApplicationUpdateScheduleStore::new(path)
                .unwrap()
                .load()
                .unwrap(),
            failed
        );
    }

    #[test]
    fn failures_back_off_and_stale_writers_cannot_replace_state() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join(DEFAULT_FILE);
        let first = ApplicationUpdateScheduleStore::new(path.clone()).unwrap();
        let stale = ApplicationUpdateScheduleStore::new(path).unwrap();
        let failed = first.record_failure(0, 2, 2_000, 11).unwrap();
        let retry_at = failed.next_automatic_check_unix_seconds.unwrap();
        assert!(retry_at > 2_000);
        assert!(retry_at <= 2_000 + RETRY_TOTAL_CAP_SECONDS);
        assert!(matches!(
            stale.record_success(0, 2, 3_000),
            Err(ApplicationUpdateScheduleError::RevisionConflict {
                expected: 0,
                actual: 1
            })
        ));
    }

    #[test]
    fn corrupt_and_future_state_require_explicit_reset() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join(DEFAULT_FILE);
        let store = ApplicationUpdateScheduleStore::new(path.clone()).unwrap();
        fs::write(&path, b"{").unwrap();
        assert!(matches!(
            store.load(),
            Err(ApplicationUpdateScheduleError::InvalidState(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), b"{");

        fs::write(
            &path,
            br#"{"schema_version":2,"revision":7,"preference_revision":null,"last_success_unix_seconds":null,"consecutive_failures":0,"next_automatic_check_unix_seconds":null}"#,
        )
        .unwrap();
        assert!(matches!(
            store.load(),
            Err(ApplicationUpdateScheduleError::UnsupportedSchema(2))
        ));
        let reset = store.reset().unwrap();
        assert_eq!(reset.revision, 8);
        assert_eq!(reset, store.load().unwrap());

        fs::write(
            &path,
            br#"{"schema_version":1,"revision":9,"preference_revision":4,"last_success_unix_seconds":1000,"consecutive_failures":0,"next_automatic_check_unix_seconds":1001}"#,
        )
        .unwrap();
        assert!(matches!(
            store.load(),
            Err(ApplicationUpdateScheduleError::InvalidState(_))
        ));
    }
}
