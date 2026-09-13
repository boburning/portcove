//! GUI-independent inspection and bounded recovery for host-owned updater state.
//!
//! The command reuses the same stores as the Tauri adapter. It can report or
//! repair malformed local coordination state and safely abandon an interrupted
//! pre-activation AppImage swap. It cannot contact a release repository, grant
//! consent, download, install, restart, or answer an OS security prompt.

use std::ffi::{OsStr, OsString};

use crate::application_update_apply::{ApplicationUpdateApplyError, ApplicationUpdateApplyStore};
#[cfg(target_os = "linux")]
use crate::application_update_apply::{
    ApplicationUpdateApplyState, ApplicationUpdateNativeLaunchState,
};
#[cfg(target_os = "linux")]
use crate::application_update_linux::{
    LinuxApplicationUpdateRecovery, recover_linux_application_update_before_startup,
};
use crate::application_update_preferences::{
    ApplicationUpdatePreferenceError, ApplicationUpdatePreferenceStore,
};
use crate::application_update_schedule::{
    ApplicationUpdateScheduleError, ApplicationUpdateScheduleStore,
};
use crate::application_update_staging::{
    ApplicationUpdateStagingError, ApplicationUpdateStagingStore,
};
#[cfg(target_os = "linux")]
use portcove_core::{ApplicationUpdateExclusivityGuard, HostPreferenceStore};

const MODE: &str = "--application-update-recovery";
#[cfg(target_os = "linux")]
const INTERRUPTED_APPIMAGE: &str = "interrupted-appimage";
const NO_OPERATION_NOTICE: &str =
    "No update check, download, install, restart, or native prompt was started.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryArea {
    Preferences,
    Schedule,
    Staging,
    Apply,
}

impl RecoveryArea {
    const ALL: [Self; 4] = [
        Self::Preferences,
        Self::Schedule,
        Self::Staging,
        Self::Apply,
    ];

    fn parse(value: &OsStr) -> Option<Self> {
        match value.to_str()? {
            "preferences" => Some(Self::Preferences),
            "schedule" => Some(Self::Schedule),
            "staging" => Some(Self::Staging),
            "apply" => Some(Self::Apply),
            _ => None,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Preferences => "preferences",
            Self::Schedule => "schedule",
            Self::Staging => "staging",
            Self::Apply => "apply",
        }
    }

    const fn effect(self) -> &'static str {
        match self {
            Self::Preferences => {
                "Saved update consent was cleared; choose update settings again in Portcove."
            }
            Self::Schedule => {
                "Only automatic-check timing and retry history were cleared; update consent is unchanged."
            }
            Self::Staging => {
                "The damaged staged payload and journal were cleared; a fresh verified download is required."
            }
            Self::Apply => {
                "Only the damaged exit or restart request was cleared; an independently healthy staged payload is unchanged."
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Inspection {
    Healthy,
    RecoveryRequired,
    #[cfg(target_os = "linux")]
    InterruptedAppImage,
}

pub(crate) fn is_mode(value: &OsStr) -> bool {
    value == MODE
}

pub(crate) fn run(mut arguments: impl Iterator<Item = OsString>) -> i32 {
    match arguments.next().as_deref() {
        Some(command) if command == "eligibility" && arguments.next().is_none() => eligibility(),
        Some(command) if command == "status" && arguments.next().is_none() => status(),
        Some(command) if command == "repair" => {
            let area = arguments.next().as_deref().and_then(RecoveryArea::parse);
            match area {
                Some(area) if arguments.next().is_none() => repair(area),
                _ => usage(),
            }
        }
        #[cfg(target_os = "linux")]
        Some(command) if command == "recover" => match arguments.next().as_deref() {
            Some(target) if target == INTERRUPTED_APPIMAGE && arguments.next().is_none() => {
                recover_interrupted_appimage()
            }
            _ => usage(),
        },
        _ => usage(),
    }
}

fn usage() -> i32 {
    eprintln!("Usage:");
    eprintln!("  portcove-desktop {MODE} eligibility");
    eprintln!("  portcove-desktop {MODE} status");
    eprintln!("  portcove-desktop {MODE} repair <preferences|schedule|staging|apply>");
    #[cfg(target_os = "linux")]
    eprintln!("  portcove-desktop {MODE} recover {INTERRUPTED_APPIMAGE}");
    eprintln!("{NO_OPERATION_NOTICE}");
    2
}

#[cfg(target_os = "linux")]
fn eligibility() -> i32 {
    match crate::application_update_linux::current_linux_installed_application_context() {
        Ok(_) => {
            println!("This Portcove AppImage is eligible for built-in application updates.");
            println!("{NO_OPERATION_NOTICE}");
            0
        }
        Err(crate::application_update::InstalledApplicationContextError::PackageManager(
            manager,
        )) => {
            println!(
                "{}",
                crate::application_update_commands::package_manager_update_guidance(manager)
            );
            println!("{NO_OPERATION_NOTICE}");
            1
        }
        Err(crate::application_update::InstalledApplicationContextError::Unavailable(_)) => {
            unavailable(
                "This Portcove installation is not eligible for built-in application updates. Use the documented installation-specific update path.",
            )
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn eligibility() -> i32 {
    unavailable("Package ownership eligibility inspection is available only on Linux.")
}

fn status() -> i32 {
    let runtime = match runtime() {
        Ok(runtime) => runtime,
        Err(message) => return unavailable(message),
    };
    let mut required = Vec::new();
    #[cfg(target_os = "linux")]
    let mut interrupted_appimage = false;
    for area in RecoveryArea::ALL {
        match inspect(area, &runtime) {
            Ok(Inspection::Healthy) => {}
            Ok(Inspection::RecoveryRequired) => required.push(area),
            #[cfg(target_os = "linux")]
            Ok(Inspection::InterruptedAppImage) => interrupted_appimage = true,
            Err(message) => return unavailable(message),
        }
    }

    #[cfg(not(target_os = "linux"))]
    let interrupted_appimage = false;

    if required.is_empty() && !interrupted_appimage {
        println!("Application update coordination state is healthy.");
        println!("{NO_OPERATION_NOTICE}");
        return 0;
    }

    if !required.is_empty() {
        println!("Application update recovery is required for:");
        for area in required {
            println!("  - {}", area.name());
            println!("    portcove-desktop {MODE} repair {}", area.name());
        }
        println!("Run only the listed fixed-area repairs, then run status again.");
    }
    #[cfg(target_os = "linux")]
    if interrupted_appimage {
        println!("An AppImage replacement is awaiting safe recovery or startup reconciliation.");
        println!("  portcove-desktop {MODE} recover {INTERRUPTED_APPIMAGE}");
    }
    println!("{NO_OPERATION_NOTICE}");
    1
}

#[cfg(target_os = "linux")]
fn is_interrupted_appimage_pending(state: &ApplicationUpdateApplyState) -> bool {
    state.native_launch == Some(ApplicationUpdateNativeLaunchState::Starting)
}

#[cfg(target_os = "linux")]
fn recover_interrupted_appimage() -> i32 {
    let runtime_path = match HostPreferenceStore::application_runtime_lock_path() {
        Ok(path) => path,
        Err(_) => return unavailable("The application runtime lease could not be located."),
    };
    let runtime = match ApplicationUpdateExclusivityGuard::acquire(&runtime_path) {
        Ok(runtime) => runtime,
        Err(_) => {
            return unavailable(
                "Portcove or an application update helper still holds the runtime lease.",
            );
        }
    };
    let apply = match ApplicationUpdateApplyStore::open_configured() {
        Ok(apply) => apply,
        Err(_) => return unavailable("Application update request state could not be opened."),
    };
    let staging = match ApplicationUpdateStagingStore::open_configured() {
        Ok(staging) => staging,
        Err(_) => return unavailable("Application update staging could not be opened."),
    };

    match recover_linux_application_update_before_startup(&runtime, &apply, &staging) {
        Ok(LinuxApplicationUpdateRecovery::RecoveredPreActivation) => {
            println!("Recovered the interrupted AppImage replacement before activation.");
            println!("The verified staged candidate remains available for a fresh update retry.");
            println!("{NO_OPERATION_NOTICE}");
            0
        }
        Ok(LinuxApplicationUpdateRecovery::NoAttempt) => {
            eprintln!("No interrupted AppImage replacement requires recovery.");
            eprintln!("{NO_OPERATION_NOTICE}");
            1
        }
        Ok(LinuxApplicationUpdateRecovery::CandidateInstalled) => {
            eprintln!("The candidate AppImage is already present at the stable path.");
            eprintln!("Start Portcove normally to complete healthy-startup reconciliation.");
            eprintln!("{NO_OPERATION_NOTICE}");
            1
        }
        Err(error) => {
            eprintln!("The interrupted AppImage recovery could not safely complete: {error}");
            eprintln!("Review the retained local state before retrying the update.");
            eprintln!("{NO_OPERATION_NOTICE}");
            1
        }
    }
}

fn repair(area: RecoveryArea) -> i32 {
    let runtime = match runtime() {
        Ok(runtime) => runtime,
        Err(message) => return unavailable(message),
    };
    match inspect(area, &runtime) {
        Ok(Inspection::Healthy) => return repair_not_required(area),
        #[cfg(target_os = "linux")]
        Ok(Inspection::InterruptedAppImage) => return repair_not_required(area),
        Ok(Inspection::RecoveryRequired) => {}
        Err(message) => return unavailable(message),
    }

    let result = match area {
        RecoveryArea::Preferences => ApplicationUpdatePreferenceStore::open_configured()
            .and_then(|store| store.recover_invalid())
            .map(|_| ())
            .map_err(preference_repair_error),
        RecoveryArea::Schedule => ApplicationUpdateScheduleStore::open_configured()
            .and_then(|store| store.recover_invalid())
            .map(|_| ())
            .map_err(schedule_repair_error),
        RecoveryArea::Staging => runtime.block_on(async {
            let store =
                ApplicationUpdateStagingStore::open_configured().map_err(staging_repair_error)?;
            store.recover_invalid().await.map_err(staging_repair_error)
        }),
        RecoveryArea::Apply => ApplicationUpdateApplyStore::open_configured()
            .and_then(|store| store.recover_invalid())
            .map(|_| ())
            .map_err(apply_repair_error),
    };

    match result {
        Ok(()) => {
            println!("Repaired application update {} state.", area.name());
            println!("{}", area.effect());
            println!("{NO_OPERATION_NOTICE}");
            0
        }
        Err(message) => unavailable(message),
    }
}

fn repair_not_required(area: RecoveryArea) -> i32 {
    eprintln!(
        "Application update {} state does not require repair.",
        area.name()
    );
    eprintln!("{NO_OPERATION_NOTICE}");
    1
}

fn inspect(
    area: RecoveryArea,
    runtime: &tokio::runtime::Runtime,
) -> Result<Inspection, &'static str> {
    match area {
        RecoveryArea::Preferences => match ApplicationUpdatePreferenceStore::open_configured()
            .and_then(|store| store.load())
        {
            Ok(_) => Ok(Inspection::Healthy),
            Err(ApplicationUpdatePreferenceError::InvalidState(_))
            | Err(ApplicationUpdatePreferenceError::UnsupportedSchema(_)) => {
                Ok(Inspection::RecoveryRequired)
            }
            Err(_) => Err("Application update preferences could not be inspected."),
        },
        RecoveryArea::Schedule => {
            match ApplicationUpdateScheduleStore::open_configured().and_then(|store| store.load()) {
                Ok(_) => Ok(Inspection::Healthy),
                Err(ApplicationUpdateScheduleError::InvalidState(_))
                | Err(ApplicationUpdateScheduleError::UnsupportedSchema(_)) => {
                    Ok(Inspection::RecoveryRequired)
                }
                Err(_) => Err("Application update check history could not be inspected."),
            }
        }
        RecoveryArea::Staging => runtime.block_on(async {
            let store = ApplicationUpdateStagingStore::open_configured()
                .map_err(|_| "Application update staging could not be inspected.")?;
            match store.status().await {
                Ok(_) => Ok(Inspection::Healthy),
                Err(ApplicationUpdateStagingError::InvalidState(_))
                | Err(ApplicationUpdateStagingError::UnsupportedSchema(_)) => {
                    Ok(Inspection::RecoveryRequired)
                }
                Err(_) => Err("Application update staging could not be inspected."),
            }
        }),
        RecoveryArea::Apply => {
            match ApplicationUpdateApplyStore::open_configured().and_then(|store| store.load()) {
                Ok(_state) => {
                    #[cfg(target_os = "linux")]
                    if is_interrupted_appimage_pending(&_state) {
                        return Ok(Inspection::InterruptedAppImage);
                    }
                    Ok(Inspection::Healthy)
                }
                Err(ApplicationUpdateApplyError::InvalidState(_))
                | Err(ApplicationUpdateApplyError::UnsupportedSchema(_)) => {
                    Ok(Inspection::RecoveryRequired)
                }
                Err(_) => Err("Application update request could not be inspected."),
            }
        }
    }
}

fn runtime() -> Result<tokio::runtime::Runtime, &'static str> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Application update recovery could not initialize its local file worker.")
}

fn unavailable(message: &'static str) -> i32 {
    eprintln!("{message}");
    eprintln!("Close Portcove and try again.");
    eprintln!("{NO_OPERATION_NOTICE}");
    1
}

fn preference_repair_error(error: ApplicationUpdatePreferenceError) -> &'static str {
    match error {
        ApplicationUpdatePreferenceError::Busy => {
            "Application update preferences are busy and were not changed."
        }
        ApplicationUpdatePreferenceError::InvalidState(_) => {
            "Application update preferences changed before repair and were not cleared."
        }
        _ => "Application update preferences could not be repaired.",
    }
}

fn schedule_repair_error(error: ApplicationUpdateScheduleError) -> &'static str {
    match error {
        ApplicationUpdateScheduleError::Busy => {
            "Application update check history is busy and was not changed."
        }
        ApplicationUpdateScheduleError::InvalidState(_) => {
            "Application update check history changed before repair and was not cleared."
        }
        _ => "Application update check history could not be repaired.",
    }
}

fn staging_repair_error(error: ApplicationUpdateStagingError) -> &'static str {
    match error {
        ApplicationUpdateStagingError::Busy => {
            "Application update staging is busy and was not changed."
        }
        ApplicationUpdateStagingError::InvalidState(_) => {
            "Application update staging changed before repair and was not cleared."
        }
        _ => "Application update staging could not be repaired.",
    }
}

fn apply_repair_error(error: ApplicationUpdateApplyError) -> &'static str {
    match error {
        ApplicationUpdateApplyError::Busy => {
            "Application update request is busy and was not changed."
        }
        ApplicationUpdateApplyError::InvalidState(_) => {
            "Application update request changed before repair and was not cleared."
        }
        _ => "Application update request could not be repaired.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_recovery_mode_and_areas_are_exact() {
        assert!(is_mode(OsStr::new(MODE)));
        assert!(!is_mode(OsStr::new(
            "--portcove-application-update-recovery"
        )));
        for (value, expected) in [
            ("preferences", RecoveryArea::Preferences),
            ("schedule", RecoveryArea::Schedule),
            ("staging", RecoveryArea::Staging),
            ("apply", RecoveryArea::Apply),
        ] {
            assert_eq!(RecoveryArea::parse(OsStr::new(value)), Some(expected));
        }
        for invalid in ["", "all", "Preferences", "../staging", "apply.json"] {
            assert_eq!(RecoveryArea::parse(OsStr::new(invalid)), None);
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(INTERRUPTED_APPIMAGE, "interrupted-appimage");
            let mut state = ApplicationUpdateApplyState::default();
            assert!(!is_interrupted_appimage_pending(&state));
            state.native_launch = Some(ApplicationUpdateNativeLaunchState::Starting);
            assert!(is_interrupted_appimage_pending(&state));
        }
    }
}
