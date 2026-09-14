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
        ToolProcessObserver {
            diagnostics: Some(ToolDiagnosticSink {
                activity_id: "owned-fixture",
                phase: "preparation.setup",
                record: &mut |_| Ok(()),
            }),
            quiesced: Some(&mut || Ok(())),
        },
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
fn diagnostic_storage_failure_stops_the_owned_tool_before_returning() {
    let temporary = fixture("wait");
    let root = temporary.path();
    let started = Instant::now();
    let error = run_setup(
        &std::env::current_exe().unwrap(),
        &["--exact".into(), CHILD_TEST.into(), "--nocapture".into()],
        &root.join("owned-fixture.iso"),
        root,
        &|| Ok(()),
        ToolProcessObserver {
            diagnostics: Some(ToolDiagnosticSink {
                activity_id: "owned-storage-failure",
                phase: "preparation.setup",
                record: &mut |capture| {
                    if capture.stdout.observed_bytes > 0 {
                        Err(PortcoveError::state("owned diagnostic storage failure"))
                    } else {
                        Ok(())
                    }
                },
            }),
            quiesced: Some(&mut || Ok(())),
        },
    )
    .err()
    .expect("storage failure must stop setup");
    assert_eq!(error.code, crate::ErrorCode::State);
    assert_eq!(error.message, "owned diagnostic storage failure");
    assert!(started.elapsed() < Duration::from_secs(5));
    let pid = fs::read_to_string(root.join("setup-fixture-ready"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(crate::launch::process_identity(pid).unwrap().is_none());
    assert!(!root.join("setup-fixture-unexpected-completion").exists());
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

#[test]
fn setup_descendants_cannot_keep_writing_after_completion_or_cancellation() {
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    for cancel in [false, true] {
        let working = tempfile::tempdir().unwrap();
        let marker = working.path().join("orphan-output");
        let arguments = vec![
            "--setup-tree".into(),
            marker.display().to_string(),
            if cancel { "wait" } else { "exit" }.into(),
        ];
        let result = run_setup(
            &program,
            &arguments,
            &working.path().join("owned.iso"),
            working.path(),
            &|| {
                if cancel && working.path().join("descendant-pid").is_file() {
                    Err(PortcoveError::new(
                        crate::ErrorCode::Cancelled,
                        "owned cancellation",
                    ))
                } else {
                    Ok(())
                }
            },
            ToolProcessObserver {
                diagnostics: Some(ToolDiagnosticSink {
                    activity_id: "owned-descendant-fixture",
                    phase: "preparation.setup",
                    record: &mut |_| Ok(()),
                }),
                quiesced: Some(&mut || Ok(())),
            },
        );
        if cancel {
            assert_eq!(result.err().unwrap().code, crate::ErrorCode::Cancelled);
        } else {
            assert!(result.unwrap().status.success());
        }
        std::thread::sleep(Duration::from_millis(1200));
        assert!(
            !marker.exists(),
            "setup descendant wrote after its operation returned"
        );
    }
}

#[cfg(unix)]
#[test]
fn detached_unix_descendant_never_records_tree_quiescence() {
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    let working = tempfile::tempdir().unwrap();
    let marker = working.path().join("escaped-output");
    let ready = working.path().join("escaped-ready");
    let arguments = vec![
        "--setup-tree-escape".into(),
        marker.display().to_string(),
        ready.display().to_string(),
    ];
    let mut quiesced = false;
    let output = run_setup(
        &program,
        &arguments,
        &working.path().join("owned.iso"),
        working.path(),
        &|| Ok(()),
        ToolProcessObserver {
            diagnostics: None,
            quiesced: Some(&mut || {
                quiesced = true;
                Ok(())
            }),
        },
    )
    .unwrap();
    assert!(output.status.success());
    assert!(!quiesced, "a detached helper cannot authorize cleanup");
    std::thread::sleep(Duration::from_millis(1200));
    assert!(
        marker.is_file(),
        "fixture did not prove process-group escape"
    );
}
