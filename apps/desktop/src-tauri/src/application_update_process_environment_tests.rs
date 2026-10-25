use super::*;

#[test]
fn linux_child_receives_exact_fuse_helper_without_unknown_or_credential_variables() {
    let mut command = std::process::Command::new("/usr/bin/env");
    command.env_clear();
    copy_desktop_update_environment(
        &mut command,
        [
            ("FUSERMOUNT_PROG", "/owned host helpers/fusermount3"),
            ("FUSERMOUNT_UNKNOWN", "not-admitted"),
            ("PORTCOVE_GITHUB_TOKEN", "secret"),
            ("PORTCOVE_LIBRARY", "/owned library"),
        ]
        .map(|(key, value)| (OsString::from(key), OsString::from(value))),
    );
    let output = command.output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let mut lines = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .collect::<Vec<_>>();
    lines.sort_unstable();
    assert_eq!(
        lines,
        [
            "FUSERMOUNT_PROG=/owned host helpers/fusermount3",
            "PORTCOVE_LIBRARY=/owned library"
        ]
    );
    // An absent selection stays absent, rather than causing discovery.
    let mut command = std::process::Command::new("/usr/bin/env");
    command.env_clear();
    copy_desktop_update_environment(&mut command, []);
    let output = command.output().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
}
