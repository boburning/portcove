use super::*;
use std::{collections::BTreeMap, fs, io::Write, time::Instant};

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
        &Default::default(),
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
        "environment" => {
            fs::write(
                "setup-fixture-environment",
                std::env::var("PORTCOVE_SETUP_FIXTURE").unwrap(),
            )
            .unwrap();
        }
        "wait" => {
            // A finite fallback keeps a failed parent assertion from leaving a
            // permanent process. A passing cancellation test kills it promptly.
            std::thread::sleep(Duration::from_secs(8));
            fs::write("setup-fixture-unexpected-completion", b"finished").unwrap();
        }
        "idle" => {
            std::thread::sleep(Duration::from_millis(2200));
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
fn idle_setup_does_not_republish_unchanged_diagnostics() {
    let temporary = fixture("idle");
    let root = temporary.path();
    let mut snapshots = Vec::new();
    let started = Instant::now();
    let result = run_setup(
        &std::env::current_exe().unwrap(),
        &["--exact".into(), CHILD_TEST.into(), "--nocapture".into()],
        &root.join("owned-fixture.iso"),
        root,
        &Default::default(),
        &|| Ok(()),
        ToolProcessObserver {
            diagnostics: Some(ToolDiagnosticSink {
                activity_id: "owned-idle-fixture",
                phase: "preparation.setup",
                record: &mut |snapshot| {
                    snapshots.push((started.elapsed(), snapshot.clone()));
                    Ok(())
                },
            }),
            quiesced: Some(&mut || Ok(())),
        },
    )
    .unwrap();
    assert!(result.status.success());
    // The child test harness may flush its text in any number of reads.
    // Closing stdout and stderr can each publish one revision without new bytes.
    assert!(snapshots.len() >= 2, "{snapshots:?}");
    assert!(!snapshots.first().unwrap().1.complete);
    assert!(snapshots.last().unwrap().1.complete);
    assert!(result.output.contains("test result: ok"));
    assert!(
        snapshots
            .last()
            .unwrap()
            .1
            .stdout
            .text
            .contains("test result: ok")
    );
    for pair in snapshots.windows(2) {
        assert!(pair[0].1.stdout.observed_bytes <= pair[1].1.stdout.observed_bytes);
        assert!(pair[0].1.stderr.observed_bytes <= pair[1].1.stderr.observed_bytes);
    }
    let mut equal_byte_revisions = 0;
    for pair in snapshots[..snapshots.len() - 1].windows(2) {
        if pair[0].1.stdout.observed_bytes == pair[1].1.stdout.observed_bytes
            && pair[0].1.stderr.observed_bytes == pair[1].1.stderr.observed_bytes
        {
            // The child sleeps for at least 2200 ms before either pipe can
            // close. An earlier equal-byte revision is an idle republication.
            assert!(pair[1].0 >= Duration::from_millis(2200), "{snapshots:?}");
            equal_byte_revisions += 1;
        }
    }
    assert!(equal_byte_revisions <= 2, "{snapshots:?}");
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
fn setup_receives_the_reviewed_environment_overlay() {
    let temporary = fixture("environment");
    let environment = BTreeMap::from([("PORTCOVE_SETUP_FIXTURE".into(), "owned".into())]);
    let output = run_setup(
        &std::env::current_exe().unwrap(),
        &["--exact".into(), CHILD_TEST.into(), "--nocapture".into()],
        &temporary.path().join("owned-fixture.iso"),
        temporary.path(),
        &environment,
        &|| Ok(()),
        ToolProcessObserver::default(),
    )
    .unwrap();
    assert!(output.status.success());
    assert_eq!(
        fs::read_to_string(temporary.path().join("setup-fixture-environment")).unwrap(),
        "owned"
    );
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
        &Default::default(),
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
            &Default::default(),
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

#[cfg(windows)]
#[test]
fn windows_quiescence_callback_observes_descendant_handle_exit() {
    use std::{
        cell::RefCell,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    for cancel in [false, true] {
        let working = tempfile::tempdir().unwrap();
        let descendant = RefCell::new(None::<OwnedHandle>);
        let mut confirmed = false;
        let result = run_setup(
            &program,
            &[
                "--setup-tree".into(),
                working.path().join("orphan-output").display().to_string(),
                if cancel {
                    "observed-wait"
                } else {
                    "observed-exit"
                }
                .into(),
            ],
            &working.path().join("owned.iso"),
            working.path(),
            &Default::default(),
            &|| {
                let pid_file = working.path().join("descendant-pid");
                if descendant.borrow().is_none() && pid_file.is_file() {
                    let pid = fs::read_to_string(&pid_file).unwrap().parse().unwrap();
                    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                    assert!(
                        !handle.is_null(),
                        "capture the live owned descendant handle"
                    );
                    assert_ne!(unsafe { WaitForSingleObject(handle, 0) }, WAIT_OBJECT_0);
                    *descendant.borrow_mut() =
                        Some(unsafe { OwnedHandle::from_raw_handle(handle) });
                    fs::write(
                        working.path().join("descendant-observed"),
                        b"handle captured",
                    )
                    .unwrap();
                }
                if cancel && descendant.borrow().is_some() {
                    Err(PortcoveError::new(
                        crate::ErrorCode::Cancelled,
                        "owned cancellation",
                    ))
                } else {
                    Ok(())
                }
            },
            ToolProcessObserver {
                diagnostics: None,
                quiesced: Some(&mut || {
                    let handles = descendant.borrow();
                    let handle = handles
                        .as_ref()
                        .expect("descendant observed before parent exit");
                    assert_eq!(
                        unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
                        WAIT_OBJECT_0,
                        "positive descendant exit must precede cleanup eligibility"
                    );
                    confirmed = true;
                    Ok(())
                }),
            },
        );
        assert!(confirmed);
        if cancel {
            assert_eq!(result.err().unwrap().code, crate::ErrorCode::Cancelled);
        } else {
            assert!(result.unwrap().status.success());
        }
        assert!(!working.path().join("orphan-output").exists());
    }
}

#[cfg(windows)]
#[test]
fn windows_quiescence_holds_success_when_a_child_exits_between_snapshots() {
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    let working = tempfile::tempdir().unwrap();
    let mut confirmed = false;
    let result = run_setup(
        &program,
        &["--setup-unobserved-child".into()],
        &working.path().join("owned.iso"),
        working.path(),
        &Default::default(),
        &|| {
            if working.path().join("leader-ready").is_file() {
                // The supervisor took its membership snapshot before this
                // checkpoint. Complete one real child while that snapshot is
                // paused, so its lifetime cannot be covered by a later handle.
                fs::write(working.path().join("spawn-child"), b"spawn").unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !working.path().join("child-finished").is_file() {
                    assert!(Instant::now() < deadline, "owned child did not finish");
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            Ok(())
        },
        ToolProcessObserver {
            diagnostics: None,
            quiesced: Some(&mut || {
                confirmed = true;
                Ok(())
            }),
        },
    );
    let error = result
        .err()
        .expect("unobserved lifetime must hold preparation");
    assert_eq!(error.code, crate::ErrorCode::State);
    assert!(
        error
            .message
            .contains("process-tree exit could not be verified")
    );
    assert!(
        !confirmed,
        "successful leader exit cannot grant cleanup authority"
    );
    assert!(working.path().join("child-finished").is_file());
}

#[cfg(windows)]
#[test]
fn windows_quiescence_refuses_invalid_job_observation() {
    let group = ToolProcessGroup {
        job: std::ptr::null_mut(),
        members: Default::default(),
        complete: std::cell::Cell::new(true),
        termination_deadline: Default::default(),
    };
    assert!(!group.proves_tree_quiescence());
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
        &Default::default(),
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
