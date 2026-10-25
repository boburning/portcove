//! Exact inherited host configuration for the update helper and relaunch.

use std::ffi::OsString;

/// Configuration owned by the Portcove desktop process must survive the
/// trusted update helper and a successful same-application relaunch. The
/// general child-process policy intentionally carries only host session state,
/// so keep this overlay exact rather than admitting arbitrary `PORTCOVE_*`
/// variables.
const DESKTOP_UPDATE_PROCESS_ENVIRONMENT: &[&str] = &[
    // AppImage's runtime uses this standard host setting to select executable
    // FUSE helper code. Preserve the inherited selection, not a new lookup or
    // updater override; an isolated host must appoint and protect that helper.
    #[cfg(target_os = "linux")]
    "FUSERMOUNT_PROG",
    "PORTCOVE_APPLICATION_RUNTIME_LOCK",
    "PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE",
    "PORTCOVE_APPLICATION_UPDATE_METADATA_URL",
    "PORTCOVE_APPLICATION_UPDATE_PREFERENCES",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_HELPER_PROCESS",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_EXIT",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS",
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE",
    "PORTCOVE_APPLICATION_UPDATE_SCHEDULE",
    "PORTCOVE_APPLICATION_UPDATE_STAGING",
    "PORTCOVE_APPLICATION_UPDATE_TARGETS_URL",
    "PORTCOVE_CHDMAN",
    "PORTCOVE_DOLPHIN_TOOL",
    "PORTCOVE_GITHUB_CLIENT_ID",
    "PORTCOVE_LIBRARY",
    "PORTCOVE_PREFERENCES",
    "PORTCOVE_TEMP_DIR",
];

pub(crate) fn copy_desktop_update_environment(
    command: &mut std::process::Command,
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) {
    command.envs(environment.into_iter().filter(|(name, _)| {
        name.to_str().is_some_and(|name| {
            DESKTOP_UPDATE_PROCESS_ENVIRONMENT
                .iter()
                .any(|candidate| name.eq_ignore_ascii_case(candidate))
        })
    }));
}

#[cfg(all(test, target_os = "linux"))]
#[path = "application_update_process_environment_tests.rs"]
mod tests;
