use super::*;
use std::{fs, io::Write, time::Instant};

const CHILD_TEST: &str = "tool_process::tests::setup_fixture_child";

// The test executable is a redistributable native fixture. The extra source
// argument is another libtest filter and never selects any repository test.
fn fixture(mode: &str) -> tempfile::TempDir {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("setup-fixture-mode"), mode).unwrap();
    temporary
}

fn run_fixture(root: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<SetupOutput> {
    run_setup(
        &std::env::current_exe().unwrap(),
        &["--exact".into(), CHILD_TEST.into(), "--nocapture".into()],
        &root.join("owned-fixture.iso"),
        root,
        checkpoint,
    )
}

#[test]
fn setup_fixture_child() {
    let Ok(mode) = fs::read_to_string("setup-fixture-mode") else {
        return;
    };
    fs::write("setup-fixture-ready", std::process::id().to_string()).unwrap();
    match mode.as_str() {
        "success" => {
            std::io::stdout()
                .write_all(b"owned stdout\n\xff\n")
                .unwrap();
            std::io::stderr().write_all(b"owned stderr\n").unwrap();
        }
        "failure" => std::process::exit(23),
        "flood" => {
            let block = [b'x'; 8192];
            for _ in 0..64 {
                std::io::stdout().write_all(&block).unwrap();
            }
            std::io::stderr()
                .write_all(b"finished excess output")
                .unwrap();
        }
        "wait" => {
            // A finite fallback keeps a failed parent assertion from leaving a
            // permanent process. A passing cancellation test kills it promptly.
            std::thread::sleep(Duration::from_secs(8));
            fs::write("setup-fixture-unexpected-completion", b"finished").unwrap();
        }
        _ => panic!("unknown owned setup fixture"),
    }
}

#[test]
fn native_setup_captures_both_streams_and_preserves_exit_status() {
    let success = fixture("success");
    let output = run_fixture(success.path(), &|| Ok(())).unwrap();
    assert!(output.status.success());
    assert!(output.output.contains("owned stdout"));
    assert!(output.output.contains("owned stderr"));
    assert!(output.output.contains('\u{fffd}'));
    assert!(!output.truncated);

    let failure = fixture("failure");
    let output = run_fixture(failure.path(), &|| Ok(())).unwrap();
    assert_eq!(output.status.code(), Some(23));
}

#[test]
fn verbose_setup_is_drained_with_bounded_capture() {
    let temporary = fixture("flood");
    let output = run_fixture(temporary.path(), &|| Ok(())).unwrap();
    assert!(output.status.success());
    assert!(output.truncated);
    assert!(output.output.len() <= SETUP_OUTPUT_LIMIT);
}

#[test]
fn cancellation_reaps_the_running_native_setup_before_returning() {
    let temporary = fixture("wait");
    let started = Instant::now();
    let error = run_fixture(temporary.path(), &|| {
        if temporary.path().join("setup-fixture-ready").is_file() {
            Err(PortcoveError::new(
                crate::ErrorCode::Cancelled,
                "owned cancellation",
            ))
        } else {
            Ok(())
        }
    })
    .err()
    .expect("setup must be cancelled");
    assert_eq!(error.code, crate::ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(5));
    let pid: u32 = fs::read_to_string(temporary.path().join("setup-fixture-ready"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(crate::launch::process_identity(pid).unwrap().is_none());
    assert!(
        !temporary
            .path()
            .join("setup-fixture-unexpected-completion")
            .exists()
    );
}

#[test]
fn cancellation_before_spawn_starts_no_process() {
    let temporary = fixture("success");
    let error = run_fixture(temporary.path(), &|| {
        Err(PortcoveError::new(
            crate::ErrorCode::Cancelled,
            "already cancelled",
        ))
    })
    .err()
    .expect("already cancelled");
    assert_eq!(error.code, crate::ErrorCode::Cancelled);
    assert!(!temporary.path().join("setup-fixture-ready").exists());
}
