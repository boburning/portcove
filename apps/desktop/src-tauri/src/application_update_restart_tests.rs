use std::ffi::{OsStr, OsString};

use super::*;

#[test]
fn helper_revision_accepts_only_one_nonzero_decimal_revision() {
    assert_eq!(helper_revision(OsStr::new("42")), Some(42));
    for invalid in ["0", "-1", "+1", " 1", "1 ", "1.0", "request.json"] {
        assert_eq!(helper_revision(OsStr::new(invalid)), None);
    }
}

#[test]
fn helper_mode_is_exact() {
    assert!(is_helper_mode(OsStr::new("--portcove-apply-update")));
    assert!(!is_helper_mode(OsStr::new("--portcove-apply")));
}

#[test]
fn helper_process_receives_only_the_fixed_mode_and_revision() {
    let executable = std::env::current_exe().unwrap();
    let command = update_helper_command(&executable, 42).unwrap();
    let arguments: Vec<_> = command.get_args().collect();
    assert_eq!(
        arguments,
        [OsStr::new("--portcove-apply-update"), OsStr::new("42")]
    );
    #[cfg(target_os = "linux")]
    {
        assert_eq!(command.get_program(), executable.as_os_str());
        for name in ["APPDIR", "APPIMAGE"] {
            assert!(
                command
                    .get_envs()
                    .all(|(key, value)| key != name || value.is_none())
            );
        }
        let mut command = command;
        bind_verified_linux_appimage_execution(
            &mut command,
            std::path::Path::new("verified/Portcove.AppImage"),
            std::path::Path::new("mount/verified"),
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new("APPIMAGE"))
                .map(|(_, value)| value),
            Some(Some(OsStr::new("verified/Portcove.AppImage")))
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new("APPDIR"))
                .map(|(_, value)| value),
            Some(Some(OsStr::new("mount/verified")))
        );
    }
}

#[test]
fn application_update_processes_carry_only_reviewed_portcove_configuration() {
    let mut command =
        ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, "unused").unwrap();
    copy_desktop_update_environment(
        &mut command,
        [
            (
                OsString::from("PORTCOVE_LIBRARY"),
                OsString::from("library"),
            ),
            (
                OsString::from("portcove_application_update_staging"),
                OsString::from("staging"),
            ),
            (
                OsString::from("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT"),
                OsString::from("during-swap-copy"),
            ),
            (
                OsString::from("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE"),
                OsString::from("stage"),
            ),
            (
                OsString::from("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_EXIT"),
                OsString::from("1"),
            ),
            (
                OsString::from("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS"),
                OsString::from("process.json"),
            ),
            (
                OsString::from("PORTCOVE_GITHUB_TOKEN"),
                OsString::from("secret"),
            ),
            (
                OsString::from("PORTCOVE_PORT_ID"),
                OsString::from("game-child-only"),
            ),
        ],
    );
    let environment = command
        .get_envs()
        .filter_map(|(name, value)| {
            value.map(|value| {
                (
                    name.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
        })
        .collect::<std::collections::BTreeMap<_, _>>();

    assert_eq!(
        environment.get("PORTCOVE_LIBRARY").map(String::as_str),
        Some("library")
    );
    assert_eq!(
        environment
            .get("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT")
            .map(String::as_str),
        Some("during-swap-copy")
    );
    assert_eq!(
        environment
            .get("portcove_application_update_staging")
            .map(String::as_str),
        Some("staging")
    );
    assert_eq!(
        environment
            .get("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE")
            .map(String::as_str),
        Some("stage")
    );
    assert_eq!(
        environment
            .get("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_EXIT")
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        environment
            .get("PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS")
            .map(String::as_str),
        Some("process.json")
    );
    assert!(!environment.contains_key("PORTCOVE_GITHUB_TOKEN"));
    assert!(!environment.contains_key("PORTCOVE_PORT_ID"));
}

#[test]
fn helper_and_relaunch_command_preserve_only_the_linux_fuse_helper_selection() {
    let helper = OsString::from("/owned host helpers/fusermount3");
    // This is the shared shipping command constructor used by both the
    // update helper and the relaunched executable. No ambient mutation is
    // needed to exercise its inherited-environment overlay.
    let command = desktop_update_process_command(
        std::path::Path::new("verified-application"),
        [
            (OsString::from("FUSERMOUNT_PROG"), helper.clone()),
            (
                OsString::from("FUSERMOUNT_UNKNOWN"),
                OsString::from("ignored"),
            ),
            (
                OsString::from("PORTCOVE_GITHUB_TOKEN"),
                OsString::from("secret"),
            ),
        ],
    )
    .unwrap();
    let value = command
        .get_envs()
        .find(|(key, _)| *key == OsStr::new("FUSERMOUNT_PROG"))
        .and_then(|(_, value)| value);
    #[cfg(target_os = "linux")]
    assert_eq!(value, Some(helper.as_os_str()));
    #[cfg(not(target_os = "linux"))]
    assert_eq!(value, None);
    assert!(
        command
            .get_envs()
            .all(|(key, _)| { key != "FUSERMOUNT_UNKNOWN" && key != "PORTCOVE_GITHUB_TOKEN" })
    );
    assert_eq!(command.get_program(), OsStr::new("verified-application"));
    assert_eq!(command.get_args().count(), 0);
}

#[test]
fn desktop_restarts_only_after_a_known_complete_native_outcome() {
    assert_eq!(
        classify_launch_result(Ok(())),
        UpdateHelperOutcome::Succeeded
    );
    assert_eq!(
        classify_launch_result(Err(WindowsApplicationUpdateError::Launch(
            "fixture launch failure".into(),
        ))),
        UpdateHelperOutcome::FailedSafe
    );
    assert_eq!(
        classify_launch_result(Err(WindowsApplicationUpdateError::Wait(
            "fixture wait failure".into(),
        ))),
        UpdateHelperOutcome::Ambiguous
    );
    assert_eq!(
        classify_linux_launch_result(Err(LinuxApplicationUpdateError::Ambiguous(
            "fixture durability failure".into(),
        ))),
        UpdateHelperOutcome::Ambiguous
    );
    assert_eq!(
        classify_linux_launch_result(Err(LinuxApplicationUpdateError::InvalidPayload(
            "fixture payload failure".into(),
        ))),
        UpdateHelperOutcome::FailedSafe
    );
}
