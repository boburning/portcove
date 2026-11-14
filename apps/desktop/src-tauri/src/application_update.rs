//! Application self-update through Tauri's updater plugin.
//!
//! Trust comes from two build inputs: the minisign public key in
//! `tauri.conf.json` and the fixed channel feed URLs below. The plugin checks
//! the feed, downloads the announced package and verifies its signature before
//! it returns any bytes to install. This module owns only the player's channel
//! and automatic-check preference, the check schedule, and the save protection
//! that must hold before the installer runs. Nothing is installed without the
//! player's explicit request.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portcove_core::PortcoveError;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::atomic_files::{read_bytes_with_overflow, write_bytes_atomically};
use crate::desktop_contract::{
    ApplicationUpdateAvailable, ApplicationUpdateChannel, ApplicationUpdatePreferences,
    ApplicationUpdateProgress, ApplicationUpdateStatus,
};
use crate::transport::{DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE, emit_desktop_event};
use crate::{DesktopError, DesktopResult, DesktopState};

const BETA_FEED: &str = "https://boburning.github.io/portcove/updates/beta/latest.json";
const PREVIEW_FEED: &str = "https://boburning.github.io/portcove/updates/preview/latest.json";

const PREFERENCES_FILE: &str = "application-update-preferences.json";
const PREFERENCES_TEMPORARY_FILE: &str = ".application-update-preferences.json.tmp";
const PREFERENCES_ENV: &str = "PORTCOVE_APPLICATION_UPDATE_PREFERENCES";
const MAX_PREFERENCE_BYTES: u64 = 4 * 1024;

const FIRST_AUTOMATIC_CHECK_DELAY: Duration = Duration::from_secs(60);
const AUTOMATIC_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
/// Bounds any single updater request, including the whole package download.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// A download that receives no bytes for this long is abandoned.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(60);
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;

pub(crate) use crate::application_update_admission::{
    RuntimeLease, UPDATE_IN_PROGRESS_DETAIL, refusal,
};

/// Copy shown for a refusal reason, also used by the headless eligibility check.
const PACKAGE_MANAGED_MESSAGE: &str = "This copy of Portcove was installed by your package manager. Update it through your package manager instead.";

/// A `.deb` or `.rpm` installation is owned by the system package manager;
/// replacing its files from inside the app would fight that owner.
pub(crate) fn package_managed() -> bool {
    matches!(
        tauri::utils::platform::bundle_type(),
        Some(tauri::utils::config::BundleType::Deb | tauri::utils::config::BundleType::Rpm)
    )
}

fn package_managed_error() -> DesktopError {
    refusal(
        PortcoveError::unsupported(PACKAGE_MANAGED_MESSAGE),
        "package-managed",
    )
}

/// `--portcove-update-eligibility`: prints whether this installation updates
/// itself, without a window, network request or file change. Exit 1 means the
/// package manager owns updates.
pub(crate) fn run_eligibility_check() -> i32 {
    if package_managed() {
        println!("{PACKAGE_MANAGED_MESSAGE}");
        println!("Portcove did not check for, download or install an update.");
        1
    } else {
        println!("This copy of Portcove can update itself.");
        0
    }
}

/// The release feed for a channel. Only these fixed URLs are ever requested.
pub(crate) fn feed_url(channel: ApplicationUpdateChannel) -> &'static str {
    match channel {
        ApplicationUpdateChannel::Beta => BETA_FEED,
        ApplicationUpdateChannel::Preview => PREVIEW_FEED,
    }
}

#[derive(Debug, Clone)]
struct PreferenceStore {
    path: PathBuf,
}

impl PreferenceStore {
    fn configured() -> Result<Self, String> {
        let path = match std::env::var_os(PREFERENCES_ENV).filter(|value| !value.is_empty()) {
            Some(path) => PathBuf::from(path),
            None => portcove_core::HostPreferenceStore::default_path()
                .map_err(|error| error.to_string())?
                .with_file_name(PREFERENCES_FILE),
        };
        Ok(Self { path })
    }

    fn directory(&self) -> &Path {
        self.path.parent().unwrap_or_else(|| Path::new("."))
    }

    fn destination_name(&self) -> &str {
        self.path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(PREFERENCES_FILE)
    }

    /// A missing or unreadable file means the defaults: Beta with automatic
    /// checks. The file holds no authority, so a damaged copy is not fatal.
    fn load(&self) -> ApplicationUpdatePreferences {
        let bytes = match read_bytes_with_overflow(&self.path, MAX_PREFERENCE_BYTES) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return ApplicationUpdatePreferences::default();
            }
            Err(error) => {
                tracing::warn!(
                    operation_id = "application-update-preferences",
                    error = %error,
                    message = "using default application update preferences"
                );
                return ApplicationUpdatePreferences::default();
            }
        };
        if bytes.len() as u64 > MAX_PREFERENCE_BYTES {
            return ApplicationUpdatePreferences::default();
        }
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    fn save(&self, preferences: &ApplicationUpdatePreferences) -> std::io::Result<()> {
        let directory = self.directory();
        std::fs::create_dir_all(directory)?;
        let bytes = serde_json::to_vec_pretty(preferences).map_err(std::io::Error::other)?;
        write_bytes_atomically(
            directory,
            PREFERENCES_TEMPORARY_FILE,
            self.destination_name(),
            &bytes,
        )
    }
}

#[derive(Default)]
struct UpdateActivity {
    checking: bool,
    installing: bool,
    pending: Option<PendingUpdate>,
    last_checked_unix_seconds: Option<u64>,
}

struct PendingUpdate {
    channel: ApplicationUpdateChannel,
    update: Update,
}

/// Host-owned application update state. The pending `Update` is the plugin's
/// own verified-feed result; the renderer only names the version it reviewed.
#[derive(Clone)]
pub(crate) struct ApplicationUpdateState {
    store: Result<PreferenceStore, String>,
    preferences: Arc<Mutex<()>>,
    activity: Arc<Mutex<UpdateActivity>>,
}

impl ApplicationUpdateState {
    pub(crate) fn configured() -> Self {
        Self {
            store: PreferenceStore::configured(),
            preferences: Arc::default(),
            activity: Arc::default(),
        }
    }

    fn store(&self) -> DesktopResult<&PreferenceStore> {
        self.store.as_ref().map_err(|_| {
            PortcoveError::state(
                "Portcove couldn't find where to keep update settings. Check the preference file setting, then try again.",
            )
            .into()
        })
    }

    fn preferences(&self) -> DesktopResult<ApplicationUpdatePreferences> {
        let store = self.store()?;
        let _lock = lock(&self.preferences)?;
        Ok(store.load())
    }

    fn activity(&self) -> DesktopResult<MutexGuard<'_, UpdateActivity>> {
        lock(&self.activity)
    }

    fn status(&self, app: &AppHandle) -> DesktopResult<ApplicationUpdateStatus> {
        let activity = self.activity()?;
        Ok(status_from(app, &activity))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> DesktopResult<MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| {
        PortcoveError::state("Application update state is unavailable. Restart Portcove.").into()
    })
}

fn status_from(app: &AppHandle, activity: &UpdateActivity) -> ApplicationUpdateStatus {
    ApplicationUpdateStatus {
        current_version: app.package_info().version.to_string(),
        checking: activity.checking,
        installing: activity.installing,
        available: activity.pending.as_ref().map(available),
        last_checked_unix_seconds: activity.last_checked_unix_seconds,
    }
}

fn available(pending: &PendingUpdate) -> ApplicationUpdateAvailable {
    ApplicationUpdateAvailable {
        version: pending.update.version.clone(),
        channel: pending.channel,
        notes: pending
            .update
            .body
            .clone()
            .filter(|notes| !notes.trim().is_empty()),
        date: pending
            .update
            .raw_json
            .get("pub_date")
            .and_then(|date| date.as_str())
            .map(str::to_owned),
    }
}

fn publish(app: &AppHandle, status: &ApplicationUpdateStatus) {
    if let Err(error) = emit_desktop_event::<ApplicationUpdateStatus>(
        app,
        DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE,
        status.clone(),
    ) {
        tracing::warn!(
            operation_id = "application-update",
            error = %error,
            message = "could not publish the application update status"
        );
    }
}

fn now_unix_seconds() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

/// Clears `checking` or `installing` and publishes the resulting status when
/// a check or install ends, including through an error.
struct ActivityReset<'a> {
    app: &'a AppHandle,
    state: &'a ApplicationUpdateState,
    installing: bool,
}

impl Drop for ActivityReset<'_> {
    fn drop(&mut self) {
        if let Ok(mut activity) = self.state.activity.lock() {
            if self.installing {
                activity.installing = false;
            } else {
                activity.checking = false;
            }
            let status = status_from(self.app, &activity);
            drop(activity);
            publish(self.app, &status);
        }
    }
}

async fn check(
    app: &AppHandle,
    state: &ApplicationUpdateState,
) -> DesktopResult<ApplicationUpdateStatus> {
    if package_managed() {
        return Err(package_managed_error());
    }
    let preferences = state.preferences()?;
    {
        let mut activity = state.activity()?;
        if activity.installing {
            return Err(refusal(
                PortcoveError::conflict("Portcove is already installing an update."),
                "in-progress",
            ));
        }
        if activity.checking {
            return Err(refusal(
                PortcoveError::conflict("Portcove is already checking for updates."),
                "in-progress",
            ));
        }
        activity.checking = true;
        let status = status_from(app, &activity);
        drop(activity);
        publish(app, &status);
    }
    let _reset = ActivityReset {
        app,
        state,
        installing: false,
    };
    let channel = preferences.channel;
    // On Windows the plugin exits the process with `process::exit` after it
    // starts the installer, so flush diagnostics first.
    let diagnostics = app.state::<crate::ExitDiagnostics>().inner().clone();
    let updater = app
        .updater_builder()
        .timeout(REQUEST_TIMEOUT)
        .on_before_exit(move || diagnostics.shutdown())
        .endpoints(vec![
            url::Url::parse(feed_url(channel)).map_err(|_| unavailable_error())?,
        ])
        .and_then(|builder| builder.build())
        .map_err(|error| {
            tracing::warn!(
                operation_id = "application-update-check",
                error = %error,
                message = "the application updater is not configured"
            );
            unavailable_error()
        })?;
    let checked = tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| check_failed_error())?
        .map_err(|error| {
            tracing::warn!(
                operation_id = "application-update-check",
                channel = ?channel,
                error = %error,
                message = "application update check failed"
            );
            check_failed_error()
        })?;
    let mut activity = state.activity()?;
    // A channel change during the check makes this answer irrelevant.
    if state.preferences()?.channel == channel {
        activity.pending = checked.map(|update| PendingUpdate { channel, update });
        activity.last_checked_unix_seconds = now_unix_seconds();
    }
    activity.checking = false;
    Ok(status_from(app, &activity))
}

fn unavailable_error() -> DesktopError {
    refusal(
        PortcoveError::unsupported(
            "Updates aren't available in this Portcove build. Download the latest version from the Portcove website.",
        ),
        "unavailable",
    )
}

fn check_failed_error() -> DesktopError {
    refusal(
        PortcoveError::network(
            "Portcove couldn't check for updates. Check your internet connection, then try again.",
        ),
        "check-failed",
    )
}

#[tauri::command]
pub(crate) async fn get_application_update_status(
    app: AppHandle,
    state: tauri::State<'_, ApplicationUpdateState>,
) -> DesktopResult<ApplicationUpdateStatus> {
    state.status(&app)
}

#[tauri::command]
pub(crate) async fn check_application_update(
    app: AppHandle,
    state: tauri::State<'_, ApplicationUpdateState>,
) -> DesktopResult<ApplicationUpdateStatus> {
    check(&app, state.inner()).await
}

#[tauri::command]
pub(crate) async fn get_application_update_preferences(
    state: tauri::State<'_, ApplicationUpdateState>,
) -> DesktopResult<ApplicationUpdatePreferences> {
    state.preferences()
}

#[tauri::command]
pub(crate) async fn set_application_update_preferences(
    app: AppHandle,
    state: tauri::State<'_, ApplicationUpdateState>,
    preferences: ApplicationUpdatePreferences,
) -> DesktopResult<ApplicationUpdatePreferences> {
    let store = state.store()?;
    let changed_channel = {
        let _lock = lock(&state.preferences)?;
        let previous = store.load();
        store.save(&preferences).map_err(|error| {
            tracing::warn!(
                operation_id = "application-update-preferences",
                error = %error,
                message = "could not save application update preferences"
            );
            refusal(
                PortcoveError::state("Portcove couldn't save your update settings. Try again."),
                "save-failed",
            )
        })?;
        previous.channel != preferences.channel
    };
    if changed_channel {
        // An update found on the previous channel no longer applies.
        let mut activity = state.activity()?;
        if !activity.installing {
            activity.pending = None;
            activity.last_checked_unix_seconds = None;
        }
        let status = status_from(&app, &activity);
        drop(activity);
        publish(&app, &status);
    }
    Ok(preferences)
}

/// Downloads the reviewed update, verifies it, then installs it while Core's
/// exclusive library and runtime guards are held (see
/// `application_update_admission`). On Windows the plugin starts the per-user
/// installer and exits Portcove; on Linux and macOS Portcove restarts into the
/// new build. Any refusal or failure leaves the current version running with its
/// library reopened.
#[tauri::command]
pub(crate) async fn install_application_update(
    app: AppHandle,
    state: tauri::State<'_, ApplicationUpdateState>,
    desktop: tauri::State<'_, DesktopState>,
    runtime: tauri::State<'_, RuntimeLease>,
    generation: u64,
    version: String,
    on_event: Channel<ApplicationUpdateProgress>,
) -> DesktopResult<()> {
    let state = state.inner();
    if package_managed() {
        return Err(package_managed_error());
    }
    // Refuse a busy library before spending a download on it.
    crate::application_update_admission::preflight(&desktop, generation)?;
    let update = {
        let mut activity = state.activity()?;
        if activity.installing || activity.checking {
            return Err(refusal(
                PortcoveError::conflict(
                    "Portcove is already checking for or installing an update.",
                ),
                "in-progress",
            ));
        }
        let update = activity
            .pending
            .as_ref()
            .filter(|pending| pending.update.version == version)
            .map(|pending| pending.update.clone())
            .ok_or_else(|| {
                refusal(
                    PortcoveError::state(
                        "This update is no longer available. Check for updates, then try again.",
                    ),
                    "stale",
                )
            })?;
        activity.installing = true;
        let status = status_from(&app, &activity);
        drop(activity);
        publish(&app, &status);
        update
    };
    let _reset = ActivityReset {
        app: &app,
        state,
        installing: true,
    };

    let bytes = download_verified(&update, &on_event).await?;

    // Save protection, held across the install call.
    let admission = crate::application_update_admission::admit_install(
        &desktop,
        &runtime,
        &crate::BLOCKING_WORKERS,
        generation,
    )
    .inspect_err(|_| announce_library_reopened(&app))?;
    let _ = on_event.send(ApplicationUpdateProgress::Installing);

    // On Windows a successful install flushes diagnostics, starts the
    // installer and exits the process inside this call.
    if let Err(error) = update.install(&bytes) {
        tracing::warn!(
            operation_id = "application-update-install",
            version = %update.version,
            error = %error,
            message = "application update install failed"
        );
        drop(admission);
        announce_library_reopened(&app);
        return Err(refusal(
            PortcoveError::install(
                "Portcove couldn't install the update. Your current version is unchanged. Try again, or download the latest version from the Portcove website.",
            ),
            "install-failed",
        ));
    }
    tracing::info!(
        operation_id = "application-update-install",
        version = %update.version,
        message = "application update installed; restarting"
    );
    // The library stays closed and new work stays refused in this process; the
    // exclusive leases are released so the restarted build can start.
    admission.finish_for_exit();
    app.restart()
}

/// Lets the renderer reload its library after a refused or failed install.
fn announce_library_reopened(app: &AppHandle) {
    let _ = emit_desktop_event::<()>(app, crate::transport::DESKTOP_EVENT_LIBRARY_CHANGED, ());
}

/// Downloads the package with progress. The plugin verifies its signature
/// against the configured key before returning the bytes. A download that
/// stalls is abandoned; the request timeout bounds the whole transfer.
async fn download_verified(
    update: &Update,
    on_event: &Channel<ApplicationUpdateProgress>,
) -> DesktopResult<Vec<u8>> {
    let last_progress = Arc::new(Mutex::new(Instant::now()));
    let observed = last_progress.clone();
    let mut downloaded = 0_u64;
    let mut reported = 0_u64;
    let download = update.download(
        move |chunk, total| {
            if let Ok(mut last) = observed.lock() {
                *last = Instant::now();
            }
            downloaded = downloaded.saturating_add(chunk as u64);
            if downloaded.saturating_sub(reported) >= PROGRESS_STEP_BYTES
                || Some(downloaded) == total
            {
                reported = downloaded;
                let _ = on_event.send(ApplicationUpdateProgress::Downloading {
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                });
            }
        },
        || {},
    );
    let stalled = async {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let idle = last_progress
                .lock()
                .map_or(Duration::ZERO, |last| last.elapsed());
            if idle >= DOWNLOAD_STALL_TIMEOUT {
                break;
            }
        }
    };
    let failed = |reason: &str| {
        tracing::warn!(
            operation_id = "application-update-install",
            version = %update.version,
            error = %reason,
            message = "application update download or verification failed"
        );
        refusal(
            PortcoveError::verification(
                "Portcove couldn't download a verified copy of the update. Check your internet connection, then try again.",
            ),
            "download-failed",
        )
    };
    tokio::select! {
        result = download => result.map_err(|error| failed(&error.to_string())),
        () = stalled => Err(failed("the download stalled")),
    }
}

/// Checks at startup (after a short delay) and then every six hours while the
/// player keeps automatic checks on. A found update is only announced.
/// Development builds never check automatically.
pub(crate) fn start_automatic_checks(app: AppHandle) {
    // Package-managed installations update through their package manager.
    if cfg!(debug_assertions) || package_managed() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_AUTOMATIC_CHECK_DELAY).await;
        loop {
            let state = app.state::<ApplicationUpdateState>();
            if state
                .preferences()
                .is_ok_and(|preferences| preferences.automatic_checks)
            {
                // The finished check publishes its status to the notice.
                if let Err(error) = check(&app, state.inner()).await {
                    tracing::info!(
                        operation_id = "application-update-check",
                        error = %error.message,
                        message = "automatic application update check did not complete"
                    );
                }
            }
            tokio::time::sleep(AUTOMATIC_CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_use_their_fixed_feeds() {
        assert_eq!(
            feed_url(ApplicationUpdateChannel::Beta),
            "https://boburning.github.io/portcove/updates/beta/latest.json"
        );
        assert_eq!(
            feed_url(ApplicationUpdateChannel::Preview),
            "https://boburning.github.io/portcove/updates/preview/latest.json"
        );
        assert_eq!(
            ApplicationUpdateChannel::default(),
            ApplicationUpdateChannel::Beta
        );
    }

    #[test]
    fn preferences_default_to_beta_with_automatic_checks_and_survive_restart() {
        let temporary = tempfile::tempdir().unwrap();
        let store = PreferenceStore {
            path: temporary.path().join("nested").join(PREFERENCES_FILE),
        };
        assert_eq!(store.load(), ApplicationUpdatePreferences::default());
        assert!(store.load().automatic_checks);

        let chosen = ApplicationUpdatePreferences {
            channel: ApplicationUpdateChannel::Preview,
            automatic_checks: false,
        };
        store.save(&chosen).unwrap();
        let reopened = PreferenceStore {
            path: store.path.clone(),
        };
        assert_eq!(reopened.load(), chosen);
        assert!(!store.directory().join(PREFERENCES_TEMPORARY_FILE).exists());
    }

    #[test]
    fn damaged_or_oversized_preferences_fall_back_to_defaults() {
        let temporary = tempfile::tempdir().unwrap();
        let store = PreferenceStore {
            path: temporary.path().join(PREFERENCES_FILE),
        };
        for bytes in [
            b"not json".to_vec(),
            br#"{"channel":"nightly","automatic_checks":true}"#.to_vec(),
            br#"{"channel":"beta","automatic_checks":true,"extra":1}"#.to_vec(),
            vec![b' '; MAX_PREFERENCE_BYTES as usize + 1],
        ] {
            std::fs::write(&store.path, bytes).unwrap();
            assert_eq!(store.load(), ApplicationUpdatePreferences::default());
        }
    }

    #[test]
    fn preference_wire_format_is_stable() {
        let preferences = ApplicationUpdatePreferences {
            channel: ApplicationUpdateChannel::Preview,
            automatic_checks: true,
        };
        assert_eq!(
            serde_json::to_value(&preferences).unwrap(),
            serde_json::json!({"channel": "preview", "automatic_checks": true})
        );
        assert!(
            serde_json::from_value::<ApplicationUpdatePreferences>(
                serde_json::json!({"channel": "stable", "automatic_checks": true})
            )
            .is_err()
        );
    }
}
