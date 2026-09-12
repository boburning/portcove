//! Single-owner coordination for application-update checks.
//!
//! The coordinator serializes manual and automatic checks across host processes,
//! re-evaluates policy after acquiring ownership, records bounded scheduling
//! outcomes, and refuses to hand a result forward when it observes that
//! preferences changed.
//! Network and metadata behavior remain behind the injected checker.

use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use fs2::FileExt;

use crate::application_update_preferences::{
    ApplicationUpdateChoice, ApplicationUpdatePreferenceError, ApplicationUpdatePreferenceStore,
};
use crate::application_update_repository::{
    AuthenticatedCandidateSelection, CandidateLoadError, CandidateLoadFailureKind,
};
use crate::application_update_schedule::{
    ApplicationUpdateCheckContext, ApplicationUpdateCheckDecision, ApplicationUpdateCheckRequest,
    ApplicationUpdateSchedule, ApplicationUpdateScheduleError, ApplicationUpdateScheduleStore,
    MeteredConnection, NetworkAvailability,
};

const CHECK_LOCK_FILE: &str = ".application-update-check.lock";

static ACTIVE_CHECK_PATHS: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum ApplicationUpdateCoordinatorError {
    #[error("an application update check is already active")]
    Busy,
    #[error("application update check path is invalid: {0}")]
    InvalidPath(String),
    #[error("application update clock is invalid: {0}")]
    Clock(String),
    #[error("application update coordinator state is invalid: {0}")]
    InvalidState(String),
    #[error(transparent)]
    Preferences(#[from] ApplicationUpdatePreferenceError),
    #[error(transparent)]
    Schedule(#[from] ApplicationUpdateScheduleError),
    #[error("application update check failed ({failure:?}): {source}")]
    Check {
        failure: CandidateLoadFailureKind,
        #[source]
        source: CandidateLoadError,
    },
    #[error("application update coordinator I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplicationUpdateCheckEnvironment {
    pub request: ApplicationUpdateCheckRequest,
    pub startup_unix_seconds: u64,
    pub network: NetworkAvailability,
    pub metered: MeteredConnection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplicationUpdateCoordinatorOutcome {
    Held(ApplicationUpdateCheckDecision),
    Checked {
        preference_revision: u64,
        preference_choice: ApplicationUpdateChoice,
        selection: Box<AuthenticatedCandidateSelection>,
        schedule: ApplicationUpdateSchedule,
    },
    Superseded {
        checked_preference_revision: u64,
        current_preference_revision: u64,
        schedule: ApplicationUpdateSchedule,
    },
}

#[async_trait]
pub trait ApplicationUpdateChecker: Send + Sync {
    async fn check(
        &self,
        choice: ApplicationUpdateChoice,
    ) -> Result<AuthenticatedCandidateSelection, CandidateLoadError>;
}

#[async_trait]
pub trait ApplicationUpdateCheckCompletion: Send + Sync {
    type Error: Send;

    async fn complete(
        &self,
        preference_revision: u64,
        choice: &ApplicationUpdateChoice,
        selection: &AuthenticatedCandidateSelection,
    ) -> Result<(), Self::Error>;
}

#[derive(Debug)]
pub enum ApplicationUpdateCoordinatorRunError<E> {
    Coordinator(ApplicationUpdateCoordinatorError),
    Completion(E),
}

struct NoopCheckCompletion;

#[async_trait]
impl ApplicationUpdateCheckCompletion for NoopCheckCompletion {
    type Error = std::convert::Infallible;

    async fn complete(
        &self,
        _preference_revision: u64,
        _choice: &ApplicationUpdateChoice,
        _selection: &AuthenticatedCandidateSelection,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}

pub trait ApplicationUpdateClock: Send + Sync {
    fn now_unix_seconds(&self) -> Result<u64, String>;
}

#[derive(Debug, Default)]
pub struct SystemApplicationUpdateClock;

impl ApplicationUpdateClock for SystemApplicationUpdateClock {
    fn now_unix_seconds(&self) -> Result<u64, String> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .map_err(|error| error.to_string())
    }
}

#[derive(Clone)]
pub struct ApplicationUpdateCoordinator {
    preferences: ApplicationUpdatePreferenceStore,
    schedule: ApplicationUpdateScheduleStore,
    lock_path: PathBuf,
    clock: Arc<dyn ApplicationUpdateClock>,
}

struct ActiveCheckPath {
    path: PathBuf,
}

impl Drop for ActiveCheckPath {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_CHECK_PATHS
            .get_or_init(|| Mutex::new(BTreeSet::new()))
            .lock()
        {
            active.remove(&self.path);
        }
    }
}

struct CheckLock {
    file: File,
    _active: ActiveCheckPath,
}

impl Drop for CheckLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

impl ApplicationUpdateCoordinator {
    pub fn open_configured() -> Result<Self, ApplicationUpdateCoordinatorError> {
        let preferences = ApplicationUpdatePreferenceStore::open_configured()?;
        let schedule = ApplicationUpdateScheduleStore::open_configured()?;
        let schedule_path = std::env::var_os("PORTCOVE_APPLICATION_UPDATE_SCHEDULE")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(ApplicationUpdateScheduleStore::default_path)?;
        let lock_path = schedule_path.with_file_name(CHECK_LOCK_FILE);
        Self::new(
            preferences,
            schedule,
            lock_path,
            Arc::new(SystemApplicationUpdateClock),
        )
    }

    pub fn new(
        preferences: ApplicationUpdatePreferenceStore,
        schedule: ApplicationUpdateScheduleStore,
        lock_path: PathBuf,
        clock: Arc<dyn ApplicationUpdateClock>,
    ) -> Result<Self, ApplicationUpdateCoordinatorError> {
        validate_lock_path(&lock_path)?;
        Ok(Self {
            preferences,
            schedule,
            lock_path,
            clock,
        })
    }

    /// Evaluates and, when due, executes one check without blocking application
    /// startup. Callers may await this from a background task or an explicit
    /// manual command. No candidate is returned after its preference changes.
    pub async fn run(
        &self,
        environment: ApplicationUpdateCheckEnvironment,
        checker: &dyn ApplicationUpdateChecker,
    ) -> Result<ApplicationUpdateCoordinatorOutcome, ApplicationUpdateCoordinatorError> {
        match self
            .run_with_completion(environment, checker, &NoopCheckCompletion)
            .await
        {
            Ok(outcome) => Ok(outcome),
            Err(ApplicationUpdateCoordinatorRunError::Coordinator(error)) => Err(error),
            Err(ApplicationUpdateCoordinatorRunError::Completion(never)) => match never {},
        }
    }

    /// Runs a selected follow-on step while retaining the cross-process check
    /// owner. A completion failure receives bounded failure cadence; success is
    /// recorded only after completion. This prevents an automatic payload
    /// failure from being hidden behind the daily successful-check interval.
    pub async fn run_with_completion<C: ApplicationUpdateCheckCompletion + ?Sized>(
        &self,
        environment: ApplicationUpdateCheckEnvironment,
        checker: &dyn ApplicationUpdateChecker,
        completion: &C,
    ) -> Result<ApplicationUpdateCoordinatorOutcome, ApplicationUpdateCoordinatorRunError<C::Error>>
    {
        let initial = self
            .decision(environment)
            .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
        if !matches!(initial, ApplicationUpdateCheckDecision::CheckNow) {
            return Ok(ApplicationUpdateCoordinatorOutcome::Held(initial));
        }

        let _check_lock = self
            .lock()
            .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
        let preferences = self
            .preferences
            .load()
            .map_err(ApplicationUpdateCoordinatorError::from)
            .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
        let schedule = self
            .schedule
            .load()
            .map_err(ApplicationUpdateCoordinatorError::from)
            .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
        let now = self
            .now()
            .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
        let decision = schedule.decide(
            &preferences,
            ApplicationUpdateCheckContext {
                request: environment.request,
                now_unix_seconds: now,
                startup_unix_seconds: environment.startup_unix_seconds,
                network: environment.network,
                metered: environment.metered,
            },
        );
        if !matches!(decision, ApplicationUpdateCheckDecision::CheckNow) {
            return Ok(ApplicationUpdateCoordinatorOutcome::Held(decision));
        }
        let choice = preferences.choice.clone().ok_or_else(|| {
            ApplicationUpdateCoordinatorRunError::Coordinator(
                ApplicationUpdateCoordinatorError::InvalidState(
                    "consent changed after the policy decision".into(),
                ),
            )
        })?;
        let preference_revision = preferences.revision;
        let schedule_revision = schedule.revision;

        let checked = checker.check(choice.clone()).await;
        let selection = match checked {
            Ok(selection) => selection,
            Err(source) => {
                let completed_at = self
                    .now()
                    .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
                self.schedule
                    .record_failure(
                        schedule_revision,
                        preference_revision,
                        completed_at,
                        completion_jitter_seed(completed_at, schedule_revision),
                    )
                    .map_err(ApplicationUpdateCoordinatorError::from)
                    .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
                return Err(ApplicationUpdateCoordinatorRunError::Coordinator(
                    ApplicationUpdateCoordinatorError::Check {
                        failure: source.failure_kind(),
                        source,
                    },
                ));
            }
        };
        let current_preferences = self
            .preferences
            .load()
            .map_err(ApplicationUpdateCoordinatorError::from)
            .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
        if current_preferences.revision != preference_revision {
            let completed_at = self
                .now()
                .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
            let schedule = self
                .schedule
                .record_success(schedule_revision, preference_revision, completed_at)
                .map_err(ApplicationUpdateCoordinatorError::from)
                .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
            return Ok(ApplicationUpdateCoordinatorOutcome::Superseded {
                checked_preference_revision: preference_revision,
                current_preference_revision: current_preferences.revision,
                schedule,
            });
        }
        if let Err(error) = completion
            .complete(preference_revision, &choice, &selection)
            .await
        {
            let completed_at = self
                .now()
                .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
            self.schedule
                .record_failure(
                    schedule_revision,
                    preference_revision,
                    completed_at,
                    completion_jitter_seed(completed_at, schedule_revision),
                )
                .map_err(ApplicationUpdateCoordinatorError::from)
                .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
            return Err(ApplicationUpdateCoordinatorRunError::Completion(error));
        }
        let completed_at = self
            .now()
            .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
        let schedule = self
            .schedule
            .record_success(schedule_revision, preference_revision, completed_at)
            .map_err(ApplicationUpdateCoordinatorError::from)
            .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
        let current_preferences = self
            .preferences
            .load()
            .map_err(ApplicationUpdateCoordinatorError::from)
            .map_err(ApplicationUpdateCoordinatorRunError::Coordinator)?;
        if current_preferences.revision != preference_revision {
            return Ok(ApplicationUpdateCoordinatorOutcome::Superseded {
                checked_preference_revision: preference_revision,
                current_preference_revision: current_preferences.revision,
                schedule,
            });
        }
        Ok(ApplicationUpdateCoordinatorOutcome::Checked {
            preference_revision,
            preference_choice: choice,
            selection: Box::new(selection),
            schedule,
        })
    }

    fn decision(
        &self,
        environment: ApplicationUpdateCheckEnvironment,
    ) -> Result<ApplicationUpdateCheckDecision, ApplicationUpdateCoordinatorError> {
        let preferences = self.preferences.load()?;
        let schedule = self.schedule.load()?;
        Ok(schedule.decide(
            &preferences,
            ApplicationUpdateCheckContext {
                request: environment.request,
                now_unix_seconds: self.now()?,
                startup_unix_seconds: environment.startup_unix_seconds,
                network: environment.network,
                metered: environment.metered,
            },
        ))
    }

    fn now(&self) -> Result<u64, ApplicationUpdateCoordinatorError> {
        self.clock
            .now_unix_seconds()
            .map_err(ApplicationUpdateCoordinatorError::Clock)
    }

    fn lock(&self) -> Result<CheckLock, ApplicationUpdateCoordinatorError> {
        refuse_symlink_ancestors(&self.lock_path)?;
        let active = ActiveCheckPath::acquire(self.lock_path.clone())?;
        let parent = self.lock_path.parent().ok_or_else(|| {
            ApplicationUpdateCoordinatorError::InvalidPath(
                "check lock needs a parent directory".into(),
            )
        })?;
        std::fs::create_dir_all(parent)?;
        refuse_symlink_ancestors(parent)?;
        refuse_symlink_ancestors(&self.lock_path)?;
        let file = match OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&self.lock_path)
        {
            Ok(file) => file,
            Err(error) => return Err(error.into()),
        };
        match file.try_lock_exclusive() {
            Ok(()) => Ok(CheckLock {
                file,
                _active: active,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Err(ApplicationUpdateCoordinatorError::Busy)
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl ActiveCheckPath {
    fn acquire(path: PathBuf) -> Result<Self, ApplicationUpdateCoordinatorError> {
        let mut active = ACTIVE_CHECK_PATHS
            .get_or_init(|| Mutex::new(BTreeSet::new()))
            .lock()
            .map_err(|_| {
                ApplicationUpdateCoordinatorError::InvalidPath(
                    "active check registry was poisoned".into(),
                )
            })?;
        if !active.insert(path.clone()) {
            return Err(ApplicationUpdateCoordinatorError::Busy);
        }
        Ok(Self { path })
    }
}

fn completion_jitter_seed(completed_at: u64, schedule_revision: u64) -> u64 {
    completed_at.rotate_left(23) ^ schedule_revision.wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

fn validate_lock_path(path: &Path) -> Result<(), ApplicationUpdateCoordinatorError> {
    if !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ApplicationUpdateCoordinatorError::InvalidPath(
            "check lock path must be absolute, name a file, and contain no parent traversal".into(),
        ));
    }
    Ok(())
}

fn refuse_symlink_ancestors(path: &Path) -> Result<(), ApplicationUpdateCoordinatorError> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match std::fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApplicationUpdateCoordinatorError::InvalidPath(format!(
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
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use super::*;
    use crate::application_update::{ApplicationChannel, CandidateSelection, CandidateState};
    use crate::application_update_preferences::ApplicationUpdateMode;

    #[derive(Default)]
    struct FakeClock(AtomicU64);

    impl ApplicationUpdateClock for FakeClock {
        fn now_unix_seconds(&self) -> Result<u64, String> {
            Ok(self.0.load(Ordering::SeqCst))
        }
    }

    struct FakeChecker {
        calls: AtomicUsize,
        result: Mutex<Option<Result<AuthenticatedCandidateSelection, CandidateLoadError>>>,
    }

    struct BlockingChecker {
        calls: AtomicUsize,
        started: tokio::sync::Semaphore,
        release: tokio::sync::Semaphore,
    }

    struct FailingCompletion {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl ApplicationUpdateCheckCompletion for FailingCompletion {
        type Error = &'static str;

        async fn complete(
            &self,
            _preference_revision: u64,
            _choice: &ApplicationUpdateChoice,
            _selection: &AuthenticatedCandidateSelection,
        ) -> Result<(), Self::Error> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err("payload failed")
        }
    }

    struct BlockingCompletion {
        started: tokio::sync::Semaphore,
        release: tokio::sync::Semaphore,
    }

    impl BlockingCompletion {
        fn new() -> Self {
            Self {
                started: tokio::sync::Semaphore::new(0),
                release: tokio::sync::Semaphore::new(0),
            }
        }
    }

    #[async_trait]
    impl ApplicationUpdateCheckCompletion for BlockingCompletion {
        type Error = std::convert::Infallible;

        async fn complete(
            &self,
            _preference_revision: u64,
            _choice: &ApplicationUpdateChoice,
            _selection: &AuthenticatedCandidateSelection,
        ) -> Result<(), Self::Error> {
            self.started.add_permits(1);
            self.release.acquire().await.unwrap().forget();
            Ok(())
        }
    }

    impl BlockingChecker {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
                started: tokio::sync::Semaphore::new(0),
                release: tokio::sync::Semaphore::new(0),
            }
        }
    }

    #[async_trait]
    impl ApplicationUpdateChecker for BlockingChecker {
        async fn check(
            &self,
            _choice: ApplicationUpdateChoice,
        ) -> Result<AuthenticatedCandidateSelection, CandidateLoadError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.add_permits(1);
            self.release.acquire().await.unwrap().forget();
            Ok(selection())
        }
    }

    #[async_trait]
    impl ApplicationUpdateChecker for FakeChecker {
        async fn check(
            &self,
            _choice: ApplicationUpdateChoice,
        ) -> Result<AuthenticatedCandidateSelection, CandidateLoadError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result.lock().unwrap().take().unwrap()
        }
    }

    fn selection() -> AuthenticatedCandidateSelection {
        AuthenticatedCandidateSelection {
            selection: CandidateSelection {
                state: CandidateState::Current,
                candidate: None,
                reasons: Vec::new(),
            },
            payload_key: None,
        }
    }

    fn checker(result: Result<AuthenticatedCandidateSelection, CandidateLoadError>) -> FakeChecker {
        FakeChecker {
            calls: AtomicUsize::new(0),
            result: Mutex::new(Some(result)),
        }
    }

    fn environment(request: ApplicationUpdateCheckRequest) -> ApplicationUpdateCheckEnvironment {
        ApplicationUpdateCheckEnvironment {
            request,
            startup_unix_seconds: 1_000,
            network: NetworkAvailability::Online,
            metered: MeteredConnection::Unmetered,
        }
    }

    fn fixture() -> (
        tempfile::TempDir,
        ApplicationUpdateCoordinator,
        ApplicationUpdatePreferenceStore,
        ApplicationUpdateScheduleStore,
        Arc<FakeClock>,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let preferences_path = temporary.path().join("application-updates.json");
        let schedule_path = temporary.path().join("application-update-schedule.json");
        let lock_path = temporary.path().join(CHECK_LOCK_FILE);
        let preferences = ApplicationUpdatePreferenceStore::new(preferences_path).unwrap();
        let schedule = ApplicationUpdateScheduleStore::new(schedule_path).unwrap();
        let clock = Arc::new(FakeClock(AtomicU64::new(2_000)));
        let coordinator = ApplicationUpdateCoordinator::new(
            preferences.clone(),
            schedule.clone(),
            lock_path,
            clock.clone(),
        )
        .unwrap();
        (temporary, coordinator, preferences, schedule, clock)
    }

    fn choose(
        store: &ApplicationUpdatePreferenceStore,
        revision: u64,
        mode: ApplicationUpdateMode,
        paused: bool,
    ) {
        store
            .save_choice(
                revision,
                ApplicationUpdateChoice {
                    channel: ApplicationChannel::Preview,
                    mode,
                    paused,
                },
            )
            .unwrap();
    }

    #[tokio::test]
    async fn held_policy_never_calls_the_checker() {
        let (_temporary, coordinator, _preferences, _schedule, _clock) = fixture();
        let checker = checker(Ok(selection()));
        let outcome = coordinator
            .run(
                environment(ApplicationUpdateCheckRequest::Automatic),
                &checker,
            )
            .await
            .unwrap();
        assert!(matches!(
            outcome,
            ApplicationUpdateCoordinatorOutcome::Held(ApplicationUpdateCheckDecision::Hold { .. })
        ));
        assert_eq!(checker.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn successful_manual_check_records_cadence_and_returns_selection() {
        let (_temporary, coordinator, preferences, schedule, _clock) = fixture();
        choose(&preferences, 0, ApplicationUpdateMode::Manual, true);
        let checker = checker(Ok(selection()));
        let outcome = coordinator
            .run(
                ApplicationUpdateCheckEnvironment {
                    metered: MeteredConnection::Metered,
                    ..environment(ApplicationUpdateCheckRequest::Manual)
                },
                &checker,
            )
            .await
            .unwrap();
        assert!(matches!(
            outcome,
            ApplicationUpdateCoordinatorOutcome::Checked {
                preference_revision: 1,
                ..
            }
        ));
        let persisted = schedule.load().unwrap();
        assert_eq!(persisted.preference_revision, Some(1));
        assert_eq!(persisted.last_success_unix_seconds, Some(2_000));
        assert_eq!(checker.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_check_persists_bounded_retry() {
        let (_temporary, coordinator, preferences, schedule, _clock) = fixture();
        choose(&preferences, 0, ApplicationUpdateMode::Automatic, false);
        let checker = checker(Err(CandidateLoadError::InvalidIndex("offline".into())));
        assert!(matches!(
            coordinator
                .run(
                    environment(ApplicationUpdateCheckRequest::Automatic),
                    &checker
                )
                .await,
            Err(ApplicationUpdateCoordinatorError::Check {
                failure: CandidateLoadFailureKind::Rejected,
                source: CandidateLoadError::InvalidIndex(_),
            })
        ));
        let persisted = schedule.load().unwrap();
        assert_eq!(persisted.preference_revision, Some(1));
        assert_eq!(persisted.consecutive_failures, 1);
        assert!(persisted.next_automatic_check_unix_seconds.unwrap() > 2_000);
    }

    #[tokio::test]
    async fn failed_completion_records_retry_instead_of_daily_success() {
        let (_temporary, coordinator, preferences, schedule, _clock) = fixture();
        choose(&preferences, 0, ApplicationUpdateMode::Automatic, false);
        let checker = checker(Ok(selection()));
        let completion = FailingCompletion {
            calls: AtomicUsize::new(0),
        };
        assert!(matches!(
            coordinator
                .run_with_completion(
                    environment(ApplicationUpdateCheckRequest::Automatic),
                    &checker,
                    &completion,
                )
                .await,
            Err(ApplicationUpdateCoordinatorRunError::Completion(
                "payload failed"
            ))
        ));
        let persisted = schedule.load().unwrap();
        assert_eq!(completion.calls.load(Ordering::SeqCst), 1);
        assert_eq!(persisted.last_success_unix_seconds, None);
        assert_eq!(persisted.consecutive_failures, 1);
        assert!(persisted.next_automatic_check_unix_seconds.unwrap() < 2_000 + 24 * 60 * 60);
    }

    #[tokio::test]
    async fn completion_retains_cross_process_check_ownership() {
        let (_temporary, coordinator, preferences, _schedule, _clock) = fixture();
        choose(&preferences, 0, ApplicationUpdateMode::Automatic, false);
        let completion = Arc::new(BlockingCompletion::new());
        let task_completion = completion.clone();
        let task_coordinator = coordinator.clone();
        let running = tokio::spawn(async move {
            task_coordinator
                .run_with_completion(
                    environment(ApplicationUpdateCheckRequest::Automatic),
                    &checker(Ok(selection())),
                    task_completion.as_ref(),
                )
                .await
        });
        completion.started.acquire().await.unwrap().forget();

        assert!(matches!(
            coordinator
                .run(
                    environment(ApplicationUpdateCheckRequest::Manual),
                    &checker(Ok(selection())),
                )
                .await,
            Err(ApplicationUpdateCoordinatorError::Busy)
        ));
        completion.release.add_permits(1);
        assert!(matches!(
            running.await.unwrap().unwrap(),
            ApplicationUpdateCoordinatorOutcome::Checked { .. }
        ));
    }

    #[tokio::test]
    async fn check_failures_preserve_unreachable_and_stale_outcomes() {
        for (source, expected) in [
            (
                CandidateLoadError::Trust(
                    crate::application_update_trust::TrustedRepositoryError::Transport(
                        "offline".into(),
                    ),
                ),
                CandidateLoadFailureKind::Unreachable,
            ),
            (
                CandidateLoadError::Trust(
                    crate::application_update_trust::TrustedRepositoryError::Replay(
                        "timestamp replay".into(),
                    ),
                ),
                CandidateLoadFailureKind::Stale,
            ),
        ] {
            let (_temporary, coordinator, preferences, _schedule, _clock) = fixture();
            choose(&preferences, 0, ApplicationUpdateMode::Manual, false);
            let checker = checker(Err(source));
            let error = coordinator
                .run(environment(ApplicationUpdateCheckRequest::Manual), &checker)
                .await
                .unwrap_err();
            assert!(matches!(
                error,
                ApplicationUpdateCoordinatorError::Check { failure, .. }
                    if failure == expected
            ));
        }
    }

    #[tokio::test]
    async fn one_async_check_owns_the_host_without_blocking_the_runtime() {
        let (_temporary, coordinator, preferences, _schedule, _clock) = fixture();
        choose(&preferences, 0, ApplicationUpdateMode::Automatic, false);
        let blocking_checker = Arc::new(BlockingChecker::new());
        let task_coordinator = coordinator.clone();
        let task_checker = blocking_checker.clone();
        let running = tokio::spawn(async move {
            task_coordinator
                .run(
                    environment(ApplicationUpdateCheckRequest::Automatic),
                    task_checker.as_ref(),
                )
                .await
        });
        blocking_checker.started.acquire().await.unwrap().forget();

        assert!(matches!(
            coordinator
                .run(
                    environment(ApplicationUpdateCheckRequest::Manual),
                    blocking_checker.as_ref()
                )
                .await,
            Err(ApplicationUpdateCoordinatorError::Busy)
        ));
        assert_eq!(blocking_checker.calls.load(Ordering::SeqCst), 1);

        blocking_checker.release.add_permits(1);
        assert!(matches!(
            running.await.unwrap().unwrap(),
            ApplicationUpdateCoordinatorOutcome::Checked { .. }
        ));
    }

    #[tokio::test]
    async fn preference_change_supersedes_inflight_result_and_old_cadence() {
        let (_temporary, coordinator, preferences, schedule, clock) = fixture();
        choose(&preferences, 0, ApplicationUpdateMode::Automatic, false);
        let blocking_checker = Arc::new(BlockingChecker::new());
        let task_coordinator = coordinator.clone();
        let task_checker = blocking_checker.clone();
        let running = tokio::spawn(async move {
            task_coordinator
                .run(
                    environment(ApplicationUpdateCheckRequest::Automatic),
                    task_checker.as_ref(),
                )
                .await
        });
        blocking_checker.started.acquire().await.unwrap().forget();

        preferences
            .save_choice(
                1,
                ApplicationUpdateChoice {
                    channel: ApplicationChannel::Stable,
                    mode: ApplicationUpdateMode::NotifyOnly,
                    paused: false,
                },
            )
            .unwrap();
        clock.0.store(3_000, Ordering::SeqCst);
        blocking_checker.release.add_permits(1);
        assert!(matches!(
            running.await.unwrap().unwrap(),
            ApplicationUpdateCoordinatorOutcome::Superseded {
                checked_preference_revision: 1,
                current_preference_revision: 2,
                ..
            }
        ));
        assert_eq!(schedule.load().unwrap().preference_revision, Some(1));

        let fresh = checker(Ok(selection()));
        assert!(matches!(
            coordinator
                .run(
                    environment(ApplicationUpdateCheckRequest::Automatic),
                    &fresh
                )
                .await
                .unwrap(),
            ApplicationUpdateCoordinatorOutcome::Checked {
                preference_revision: 2,
                ..
            }
        ));
        assert_eq!(fresh.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancelled_check_releases_ownership_without_recording_an_outcome() {
        let (_temporary, coordinator, preferences, schedule, _clock) = fixture();
        choose(&preferences, 0, ApplicationUpdateMode::Automatic, false);
        let blocking_checker = Arc::new(BlockingChecker::new());
        let task_coordinator = coordinator.clone();
        let task_checker = blocking_checker.clone();
        let running = tokio::spawn(async move {
            task_coordinator
                .run(
                    environment(ApplicationUpdateCheckRequest::Automatic),
                    task_checker.as_ref(),
                )
                .await
        });
        blocking_checker.started.acquire().await.unwrap().forget();
        running.abort();
        assert!(running.await.unwrap_err().is_cancelled());
        assert_eq!(
            schedule.load().unwrap(),
            ApplicationUpdateSchedule::default()
        );

        let retry = checker(Ok(selection()));
        assert!(matches!(
            coordinator
                .run(
                    environment(ApplicationUpdateCheckRequest::Automatic),
                    &retry
                )
                .await
                .unwrap(),
            ApplicationUpdateCoordinatorOutcome::Checked { .. }
        ));
    }

    #[tokio::test]
    async fn concurrent_schedule_reset_wins_over_a_completed_check() {
        let (_temporary, coordinator, preferences, schedule, _clock) = fixture();
        choose(&preferences, 0, ApplicationUpdateMode::Automatic, false);
        let blocking_checker = Arc::new(BlockingChecker::new());
        let task_coordinator = coordinator.clone();
        let task_checker = blocking_checker.clone();
        let running = tokio::spawn(async move {
            task_coordinator
                .run(
                    environment(ApplicationUpdateCheckRequest::Automatic),
                    task_checker.as_ref(),
                )
                .await
        });
        blocking_checker.started.acquire().await.unwrap().forget();

        let reset = schedule.reset().unwrap();
        blocking_checker.release.add_permits(1);
        assert!(matches!(
            running.await.unwrap(),
            Err(ApplicationUpdateCoordinatorError::Schedule(
                ApplicationUpdateScheduleError::RevisionConflict {
                    expected: 0,
                    actual: 1
                }
            ))
        ));
        assert_eq!(schedule.load().unwrap(), reset);
    }
}
