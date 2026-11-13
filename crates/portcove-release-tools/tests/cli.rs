use std::path::PathBuf;
use std::process::{Command, Output};

fn cli(args: &[&str]) -> Output {
    let binary = std::env::var_os("NEXTEST_BIN_EXE_portcove-release-tools")
        .map(PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_portcove-release-tools").into());
    Command::new(binary).args(args).output().unwrap()
}

const COMMANDS: &[&str] = &[
    "verify",
    "build-tuf",
    "sign-tuf-role",
    "assemble-tuf",
    "prepare-tuf-renewal",
    "inspect-tuf-bootstrap",
    "inspect-tuf-context",
    "create-offline-key",
    "inspect-existing-tuf-key",
    "inspect-existing-payload-key",
    "inspect-catalog-key-inventory",
    "prepare-offline-root",
    "sign-offline-root",
    "finalize-offline-root",
    "sign-offline-targets",
    "sign-offline-definition-targets",
    "assemble-definition-repository",
    "verify-definition-repository",
    "sign-definition-role",
];

#[test]
fn generated_help_covers_every_command_without_reading_inputs() {
    let output = cli(&["--help"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let help = String::from_utf8(output.stdout).unwrap();
    for command in COMMANDS {
        assert!(help.contains(command), "missing {command}");
        let output = cli(&[command, "--help"]);
        assert!(output.status.success(), "{command}");
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn grammar_errors_preserve_failure_exit_and_stderr_contract() {
    for args in [
        vec![],
        vec!["unknown"],
        vec!["verify"],
        vec!["verify", "a", "b", "c", "hash", "not-a-number"],
        vec!["verify", "a", "b", "c", "hash", "-1"],
        vec!["verify", "a", "b", "c", "hash", "18446744073709551616"],
        vec!["assemble-tuf", "config", "extra"],
        vec!["inspect-tuf-context"],
        vec!["sign-tuf-role", "releases"],
        vec!["sign-definition-role", "targets"],
    ] {
        let output = cli(&args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(!output.stderr.is_empty(), "{args:?}");
        if args.is_empty() {
            assert!(
                String::from_utf8(output.stderr)
                    .unwrap()
                    .contains("usage: portcove-release-tools")
            );
        }
    }
}

#[test]
fn domain_role_errors_still_use_the_existing_validation() {
    for (command, message) in [
        (
            "sign-tuf-role",
            "unsupported separately authorized online role",
        ),
        (
            "sign-definition-role",
            "unsupported separately authorized catalog role",
        ),
    ] {
        let output = cli(&[command, "root", "unused.json"]);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8(output.stderr).unwrap().contains(message));
    }
}
