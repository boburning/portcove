use super::*;
use std::{collections::BTreeMap, fs, io::Write, time::Instant};

const CHILD_TEST: &str = "tool_process::tests::setup_fixture_child";

#[test]
fn post_exit_error_preserves_final_process_proof_and_original_failure() {
    let proof = BTreeMap::from([
        ("process_tree_root_exit".into(), "0".into()),
        ("process_tree_all_retained_signaled".into(), "true".into()),
        ("process_tree_retained_members".into(), "1".into()),
        ("process_tree_total".into(), "1".into()),
    ]);
    let original = PortcoveError::state("final diagnostic failed").detail("capture", "retained");
    let error = attach_process_tree_proof(original, &proof);
    assert_eq!(error.message, "final diagnostic failed");
    assert_eq!(error.code, crate::ErrorCode::State);
    assert_eq!(error.details["capture"], "retained");
    assert_eq!(copy_proof_details(&error), proof);
}

#[cfg(windows)]
#[track_caller]
fn wait_nested_file(path: &Path) {
    wait_nested_file_in_mode(path, None).unwrap();
}

#[cfg(windows)]
#[track_caller]
fn wait_nested_file_in_mode(path: &Path, mode: Option<&str>) -> Result<()> {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(5);
    while !path.is_file() {
        if Instant::now() >= deadline {
            let markers = [
                "inner-observing",
                "allow-inner-release",
                "spawn-child",
                "child-finished",
                "descendant-observed",
                "leader-exiting",
                "inner-quiesced",
                "inner-returned",
                "inner-result.pending",
                "inner-result.json",
                "allow-worker-exit",
            ]
            .map(|marker| {
                let observed = path.parent().map(|parent| parent.join(marker).try_exists());
                (marker, observed)
            });
            return Err(PortcoveError::state(format!(
                "nested handshake did not complete: path={}, caller={}, mode={mode:?}, elapsed={:?}, markers={markers:?}",
                path.display(),
                std::panic::Location::caller(),
                started.elapsed(),
            )));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(windows)]
#[test]
#[ignore = "owned child fixture selected explicitly by the nested-supervision test"]
fn nested_supervision_fixture_child() {
    let program = std::env::var_os("PORTCOVE_NESTED_PROBE").unwrap();
    let short = std::env::var("PORTCOVE_NESTED_MODE").unwrap() == "short";
    let working = std::env::current_dir().unwrap();
    let args = if short {
        vec!["--setup-unobserved-child".into()]
    } else {
        vec![
            "--setup-tree".into(),
            working.join("orphan-output").display().to_string(),
            "observed-exit".into(),
        ]
    };
    let observations = std::cell::Cell::new(0);
    let mut inner_quiesced = false;
    let result = run_setup(
        Path::new(&program),
        &args,
        &working.join("owned.iso"),
        &working,
        &Default::default(),
        &|| {
            let ready = working.join(if short {
                "leader-ready"
            } else {
                "descendant-pid"
            });
            if ready.is_file() {
                // A second callback follows another actual membership observation.
                observations.set(observations.get() + 1);
                if observations.get() >= 2 {
                    fs::write(working.join("inner-observing"), b"paused after observation")
                        .unwrap();
                    wait_nested_file(&working.join("allow-inner-release"));
                    fs::write(
                        working.join(if short {
                            "spawn-child"
                        } else {
                            "descendant-observed"
                        }),
                        b"release",
                    )
                    .unwrap();
                    if short {
                        wait_nested_file(&working.join("child-finished"));
                    }
                }
            }
            Ok(())
        },
        ToolProcessObserver {
            diagnostics: None,
            quiesced: Some(&mut || {
                inner_quiesced = true;
                fs::write(working.join("inner-quiesced"), b"quiesced")?;
                Ok(())
            }),
        },
    );
    fs::write(working.join("inner-returned"), b"returned").unwrap();
    let details = result.as_ref().err().map(copy_proof_details);
    let proof = result
        .as_ref()
        .ok()
        .map(|output| &output.process_tree_proof);
    fs::write(
        working.join("inner-result.pending"),
        serde_json::to_vec(&serde_json::json!({
            "quiesced": inner_quiesced, "error": details, "proof": proof,
        }))
        .unwrap(),
    )
    .unwrap();
    fs::rename(
        working.join("inner-result.pending"),
        working.join("inner-result.json"),
    )
    .unwrap();
    wait_nested_file(&working.join("allow-worker-exit"));
    assert!(inner_quiesced);
    assert!(result.unwrap().status.success());
}

#[cfg(windows)]
#[test]
fn nested_windows_supervisors_report_exact_child_lifetime_coverage() {
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    for short in [false, true] {
        let working = tempfile::tempdir().unwrap();
        fs::write(working.path().join("private-sentinel"), b"retained").unwrap();
        let environment = BTreeMap::from([
            (
                "PORTCOVE_NESTED_PROBE".into(),
                program.display().to_string(),
            ),
            (
                "PORTCOVE_NESTED_MODE".into(),
                if short { "short" } else { "held" }.into(),
            ),
        ]);
        let observations = std::cell::Cell::new(0);
        let mut outer_quiesced = false;
        let result = run_setup(
            &std::env::current_exe().unwrap(),
            &[
                "--ignored".into(),
                "--exact".into(),
                "tool_process::tests::nested_supervision_fixture_child".into(),
                "--nocapture".into(),
            ],
            &working.path().join("owned.iso"),
            working.path(),
            &environment,
            &|| {
                if working.path().join("inner-observing").is_file() {
                    observations.set(observations.get() + 1);
                    if observations.get() >= 2 {
                        // Block this caller while the independent inner controller
                        // observes its child. The outer job has no debug-port
                        // inheritance for the inner debugger's descendants.
                        fs::write(working.path().join("allow-inner-release"), b"release").unwrap();
                        wait_nested_file_in_mode(
                            &working.path().join("inner-result.json"),
                            Some(if short { "short" } else { "held" }),
                        )?;
                        fs::write(
                            working.path().join("allow-worker-exit"),
                            b"joined inner worker",
                        )
                        .unwrap();
                    }
                }
                Ok(())
            },
            ToolProcessObserver {
                diagnostics: None,
                quiesced: Some(&mut || {
                    outer_quiesced = true;
                    Ok(())
                }),
            },
        );
        assert!(
            working.path().join("inner-result.json").is_file(),
            "nested result missing after controlled cleanup: {:?}",
            result.as_ref().err(),
        );
        let inner: serde_json::Value =
            serde_json::from_slice(&fs::read(working.path().join("inner-result.json")).unwrap())
                .unwrap();
        assert_eq!(inner["quiesced"], true);
        assert!(inner["error"].is_null());
        assert_eq!(inner["proof"]["process_tree_total"], "2");
        assert_eq!(inner["proof"]["process_tree_retained_members"], "2");
        assert_eq!(inner["proof"]["process_tree_active"], "0");
        if short && !outer_quiesced {
            let error = result
                .err()
                .expect("a missing nested lifetime must refuse success");
            assert_eq!(
                error.details["process_tree_first_failure"],
                "lifetime_count_gap"
            );
            assert_eq!(error.details["process_tree_total"], "3");
            assert_eq!(error.details["process_tree_retained_members"], "2");
            assert_eq!(error.details["process_tree_active"], "0");
        } else {
            assert!(outer_quiesced);
            let output = result.unwrap();
            assert!(output.status.success());
            assert_eq!(output.process_tree_proof["process_tree_total"], "3");
            assert_eq!(
                output.process_tree_proof["process_tree_retained_members"],
                "3"
            );
            assert_eq!(output.process_tree_proof["process_tree_active"], "0");
            assert!(
                !output
                    .process_tree_proof
                    .contains_key("process_tree_first_failure")
            );
        }
        assert_eq!(
            fs::read(working.path().join("private-sentinel")).unwrap(),
            b"retained"
        );
        assert!(!working.path().join("orphan-output").exists());
    }
}

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
    assert!(output.output.len() < SETUP_OUTPUT_LIMIT);

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
    let root = temporary.path();
    let mut final_capture = None;
    let output = run_setup(
        &std::env::current_exe().unwrap(),
        &["--exact".into(), CHILD_TEST.into(), "--nocapture".into()],
        &root.join("owned-fixture.iso"),
        root,
        &Default::default(),
        &|| Ok(()),
        ToolProcessObserver {
            diagnostics: Some(ToolDiagnosticSink {
                activity_id: "owned-flood-fixture",
                phase: "preparation.setup",
                record: &mut |snapshot| {
                    final_capture = Some(snapshot.clone());
                    Ok(())
                },
            }),
            quiesced: None,
        },
    )
    .unwrap();
    assert!(output.status.success());
    assert!(output.output.len() <= SETUP_OUTPUT_LIMIT);
    let captured = final_capture.unwrap();
    assert!(captured.complete);
    assert!(
        captured.stdout.observed_bytes + captured.stderr.observed_bytes
            > output.output.len() as u64
    );
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
        let mut last_diagnostic = None;
        let deadline = Instant::now() + Duration::from_secs(4);
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
                if Instant::now() >= deadline {
                    return Err(PortcoveError::state("descendant observation deadline"));
                }
                let pid_file = working.path().join("descendant-pid");
                if descendant.borrow().is_none() && pid_file.is_file() {
                    let pid = fs::read_to_string(&pid_file)?
                        .parse()
                        .map_err(|_| PortcoveError::state("invalid owned descendant PID"))?;
                    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                    if handle.is_null() {
                        return Err(PortcoveError::state("owned descendant handle unavailable"));
                    }
                    let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
                    if unsafe { WaitForSingleObject(owned.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
                        return Err(PortcoveError::state("owned descendant already exited"));
                    }
                    *descendant.borrow_mut() = Some(owned);
                    fs::write(
                        working.path().join("descendant-observed"),
                        b"handle captured",
                    )?;
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
                diagnostics: Some(ToolDiagnosticSink {
                    activity_id: "owned-quiescence-control",
                    phase: "first-party-fixture",
                    record: &mut |value| {
                        last_diagnostic = Some(value.clone());
                        Ok(())
                    },
                }),
                quiesced: Some(&mut || {
                    let handles = descendant.borrow();
                    let handle = handles
                        .as_ref()
                        .ok_or_else(|| PortcoveError::state("descendant not observed"))?;
                    if unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } != WAIT_OBJECT_0 {
                        return Err(PortcoveError::state(
                            "descendant positive exit absent at cleanup boundary",
                        ));
                    }
                    confirmed = true;
                    Ok(())
                }),
            },
        );
        let proof = match &result {
            Ok(output) => output.process_tree_proof.clone(),
            Err(error) => copy_proof_details(error),
        };
        eprintln!(
            "native_quiescence_proof:{}",
            serde_json::json!({
                "cancel":cancel,"quiesced":confirmed,"proof":proof,
                "diagnostic":last_diagnostic,
                "operation_error":result.as_ref().err().map(|error| error.message.as_str()),
                "operation_code":result.as_ref().err().map(|error| format!("{:?}", error.code)),
            })
        );
        assert!(confirmed);
        if cancel {
            assert_eq!(result.err().unwrap().code, crate::ErrorCode::Cancelled);
        } else {
            let output = result.unwrap();
            assert!(output.status.success());
            #[cfg(feature = "qualification-fixtures")]
            {
                assert_eq!(
                    output.process_tree_proof["process_tree_retained_members"],
                    "2"
                );
                assert_eq!(
                    output.process_tree_proof["process_tree_membership_complete"],
                    "true"
                );
                assert_eq!(output.process_tree_proof["process_tree_active"], "0");
                assert_eq!(output.process_tree_proof["process_tree_total"], "2");
                assert!(
                    !output
                        .process_tree_proof
                        .contains_key("process_tree_first_failure")
                );
            }
        }
        assert!(!working.path().join("orphan-output").exists());
    }
}

#[cfg(windows)]
#[test]
fn windows_creation_capture_continues_while_the_caller_checkpoint_is_blocked() {
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
                // Complete a real child while this caller is blocked. The
                // independent controller must capture its creation beforehand.
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
    let output = result.expect("creation events cover the blocked caller's short child");
    assert!(output.status.success());
    assert!(confirmed);
    assert_eq!(output.process_tree_proof["process_tree_active"], "0");
    assert_eq!(
        output.process_tree_proof["process_tree_retained_members"],
        "2"
    );
    assert_eq!(output.process_tree_proof["process_tree_total"], "2");
    assert!(
        !output
            .process_tree_proof
            .contains_key("process_tree_first_failure")
    );
    assert!(working.path().join("child-finished").is_file());
}

#[cfg(windows)]
#[test]
#[ignore = "owned different-image child selected explicitly by the blocked-caller control"]
fn different_image_fixture_child() {
    assert!(Path::new("different-image-admitted").is_file());
    fs::write("different-image-pid", std::process::id().to_string()).unwrap();
    fs::write(
        "different-image-executable",
        std::env::current_exe().unwrap().display().to_string(),
    )
    .unwrap();
}

#[cfg(windows)]
#[test]
#[ignore = "requires separately admitted actual hidden console infrastructure"]
fn console_image_fixture_child() {
    assert!(Path::new("console-image-admitted").is_file());
    assert!(Path::new("console-session-ready").is_file());
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetConsoleProcessList(pids: *mut u32, count: u32) -> u32;
    }
    let mut pids = [0u32; 8];
    let count = unsafe { GetConsoleProcessList(pids.as_mut_ptr(), 8) };
    assert_eq!(
        count, 2,
        "exact owned root and different-image client required"
    );
    let root: u32 = fs::read_to_string("console-root-pid")
        .unwrap()
        .parse()
        .unwrap();
    let mut expected = vec![root, std::process::id()];
    expected.sort();
    let mut clients = pids[..2].to_vec();
    clients.sort();
    assert_eq!(clients, expected);
    fs::write(
        "console-image-clients",
        serde_json::to_vec(&clients).unwrap(),
    )
    .unwrap();
    fs::write("console-image-pid", std::process::id().to_string()).unwrap();
    fs::write(
        "console-image-executable",
        std::env::current_exe().unwrap().display().to_string(),
    )
    .unwrap();
}

#[test]
fn retained_image_projection_preserves_lifetime_metadata_without_unrelated_details() {
    let images = r#"[{"pid":42,"created_filetime":"134362482769661130","image":"C:\\Windows\\System32\\conhost.exe"}]"#;
    let original = PortcoveError::new(crate::ErrorCode::Cancelled, "owned cancellation")
        .detail("process_tree_image_identities", images)
        .detail("unrelated_private_detail", "fixture-only-value");
    let proof = copy_proof_details(&original);
    assert_eq!(proof["process_tree_image_identities"], images);
    assert!(!proof.contains_key("unrelated_private_detail"));
    let projected = attach_process_tree_proof(
        PortcoveError::new(crate::ErrorCode::Cancelled, "owned cancellation"),
        &proof,
    );
    assert_eq!(projected.code, original.code);
    assert_eq!(projected.message, original.message);
    assert_eq!(copy_proof_details(&projected), proof);
}

#[cfg(windows)]
#[test]
#[ignore = "requires separately admitted actual hidden console infrastructure"]
fn windows_console_image_child_exits_while_the_caller_checkpoint_is_blocked() {
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    let other_image = std::env::current_exe().unwrap();
    assert_ne!(program, other_image);
    let working = tempfile::tempdir().unwrap();
    fs::write(
        working.path().join("console-image-admitted"),
        b"owned control",
    )
    .unwrap();
    let blocked_child_exit = std::cell::Cell::new(false);
    let mut confirmed = false;
    let mut last_diagnostic = None;
    let overall_deadline = Instant::now() + Duration::from_secs(8);
    let result = run_setup(
        &program,
        &[
            "--setup-console-image".into(),
            other_image.display().to_string(),
        ],
        &working.path().join("owned.iso"),
        working.path(),
        &Default::default(),
        &|| {
            if Instant::now() >= overall_deadline {
                return Err(PortcoveError::state("console-image control deadline"));
            }
            if working.path().join("leader-ready").is_file() {
                fs::write(working.path().join("spawn-child"), b"spawn")?;
                let deadline = overall_deadline.min(Instant::now() + Duration::from_secs(5));
                while !working.path().join("child-finished").is_file() {
                    if Instant::now() >= deadline {
                        return Err(PortcoveError::state(
                            "owned console-image child did not finish",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                blocked_child_exit.set(true);
            }
            Ok(())
        },
        ToolProcessObserver {
            diagnostics: Some(ToolDiagnosticSink {
                activity_id: "owned-console-image-control",
                phase: "first-party-fixture",
                record: &mut |value| {
                    last_diagnostic = Some(value.clone());
                    Ok(())
                },
            }),
            quiesced: Some(&mut || {
                confirmed = true;
                Ok(())
            }),
        },
    );
    let proof = match &result {
        Ok(output) => output.process_tree_proof.clone(),
        Err(error) => copy_proof_details(error),
    };
    let console_window_owner = fs::read_to_string(working.path().join("console-window-owner-pid"))
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    let images = proof
        .get("process_tree_image_identities")
        .and_then(|value| serde_json::from_str::<Vec<serde_json::Value>>(value).ok());
    let console_host_image =
        std::path::PathBuf::from(std::env::var_os("SystemRoot").expect("Windows system root"))
            .join("System32")
            .join("conhost.exe")
            .to_string_lossy()
            .into_owned();
    let hosts = images.as_ref().map(|images| {
        images
            .iter()
            .filter(|entry| {
                entry["image"]
                    .as_str()
                    .is_some_and(|image| image.eq_ignore_ascii_case(&console_host_image))
            })
            .collect::<Vec<_>>()
    });
    let console_host = hosts
        .as_ref()
        .filter(|hosts| hosts.len() == 1)
        .and_then(|hosts| hosts[0]["pid"].as_u64())
        .and_then(|pid| u32::try_from(pid).ok());
    let console_root = fs::read_to_string(working.path().join("console-root-pid"))
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    let clients = fs::read_to_string(working.path().join("console-image-clients"))
        .ok()
        .and_then(|value| serde_json::from_str::<Vec<u32>>(&value).ok());
    let detached = working.path().join("console-session-detached").is_file();
    eprintln!(
        "native_console_image_proof:{}",
        serde_json::json!({
            "quiesced":confirmed,"proof":proof,"diagnostic":last_diagnostic,
            "console_host":console_host,"console_root":console_root,"clients":clients,
            "console_window_owner":console_window_owner,"images":images,
            "detached":detached,"blocked_child_exit_observed":blocked_child_exit.get(),
            "operation_error":result.as_ref().err().map(|error| error.message.as_str()),
        })
    );
    let output = result.expect("console-image creation remains captured while caller blocks");
    assert!(output.status.success());
    assert!(confirmed);
    assert_eq!(output.process_tree_proof["process_tree_active"], "0");
    assert_eq!(
        output.process_tree_proof["process_tree_total"],
        output.process_tree_proof["process_tree_retained_members"]
    );
    assert_eq!(
        output.process_tree_proof["process_tree_all_retained_signaled"],
        "true"
    );
    assert!(
        !output
            .process_tree_proof
            .contains_key("process_tree_first_failure")
    );
    let identities: Vec<serde_json::Value> =
        serde_json::from_str(&output.process_tree_proof["process_tree_identities"]).unwrap();
    let child_pid: u32 = fs::read_to_string(working.path().join("console-image-pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        identities
            .iter()
            .any(|identity| identity["pid"] == child_pid)
    );
    assert_eq!(
        fs::read_to_string(working.path().join("console-image-executable")).unwrap(),
        other_image.display().to_string()
    );
    let host = console_host.expect("actual console host required");
    let root = console_root.expect("actual console root required");
    let images = images.unwrap();
    assert_eq!(images.len(), identities.len());
    for image in &images {
        assert!(
            identities
                .iter()
                .any(|identity| identity["pid"] == image["pid"]
                    && identity["created_filetime"] == image["created_filetime"])
        );
    }
    assert_ne!(host, root);
    assert_ne!(host, child_pid);
    assert!(identities.iter().any(|identity| identity["pid"] == host));
    assert!(identities.iter().any(|identity| identity["pid"] == root));
    let mut expected_clients = vec![root, child_pid];
    expected_clients.sort();
    assert_eq!(clients.unwrap(), expected_clients);
    assert!(detached && blocked_child_exit.get());
    assert!(identities.len() >= 3 && identities.len() <= 7);
    assert!(working.path().join("child-finished").is_file());
}

#[cfg(windows)]
#[test]
fn windows_different_image_child_exits_while_the_caller_checkpoint_is_blocked() {
    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    let other_image = std::env::current_exe().unwrap();
    assert_ne!(program, other_image);
    let working = tempfile::tempdir().unwrap();
    fs::write(
        working.path().join("different-image-admitted"),
        b"owned control",
    )
    .unwrap();
    let mut confirmed = false;
    let mut last_diagnostic = None;
    let overall_deadline = Instant::now() + Duration::from_secs(8);
    let result = run_setup(
        &program,
        &[
            "--setup-unobserved-image".into(),
            other_image.display().to_string(),
        ],
        &working.path().join("owned.iso"),
        working.path(),
        &Default::default(),
        &|| {
            if Instant::now() >= overall_deadline {
                return Err(PortcoveError::state("different-image control deadline"));
            }
            if working.path().join("leader-ready").is_file() {
                fs::write(working.path().join("spawn-child"), b"spawn")?;
                let deadline = overall_deadline.min(Instant::now() + Duration::from_secs(5));
                while !working.path().join("child-finished").is_file() {
                    if Instant::now() >= deadline {
                        return Err(PortcoveError::state(
                            "owned different-image child did not finish",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            Ok(())
        },
        ToolProcessObserver {
            diagnostics: Some(ToolDiagnosticSink {
                activity_id: "owned-different-image-control",
                phase: "first-party-fixture",
                record: &mut |value| {
                    last_diagnostic = Some(value.clone());
                    Ok(())
                },
            }),
            quiesced: Some(&mut || {
                confirmed = true;
                Ok(())
            }),
        },
    );
    let proof = match &result {
        Ok(output) => output.process_tree_proof.clone(),
        Err(error) => copy_proof_details(error),
    };
    eprintln!(
        "native_different_image_proof:{}",
        serde_json::json!({
            "quiesced":confirmed,"proof":proof,"diagnostic":last_diagnostic,
            "operation_error":result.as_ref().err().map(|error| error.message.as_str()),
        })
    );
    let output = result.expect("different-image creation remains captured while caller blocks");
    assert!(output.status.success());
    assert!(confirmed);
    assert_eq!(output.process_tree_proof["process_tree_active"], "0");
    assert_eq!(output.process_tree_proof["process_tree_total"], "2");
    assert_eq!(
        output.process_tree_proof["process_tree_retained_members"],
        "2"
    );
    assert_eq!(
        output.process_tree_proof["process_tree_all_retained_signaled"],
        "true"
    );
    assert!(
        !output
            .process_tree_proof
            .contains_key("process_tree_first_failure")
    );
    let identities: Vec<serde_json::Value> =
        serde_json::from_str(&output.process_tree_proof["process_tree_identities"]).unwrap();
    let child_pid: u32 = fs::read_to_string(working.path().join("different-image-pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        identities
            .iter()
            .any(|identity| identity["pid"] == child_pid)
    );
    assert_eq!(
        fs::read_to_string(working.path().join("different-image-executable")).unwrap(),
        other_image.display().to_string()
    );
    assert!(working.path().join("child-finished").is_file());
}

#[cfg(windows)]
#[test]
fn windows_retained_handle_capacity_refuses_one_more_member_without_cleanup_proof() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };

    let native = tempfile::tempdir().unwrap();
    let program = crate::test_fixture::build_probe(native.path());
    for occupied in [511, 512] {
        let working = tempfile::tempdir().unwrap();
        let mut spec =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                .unwrap();
        spec.args([
            "--setup-tree",
            &working.path().join("orphan-output").display().to_string(),
            "observed-wait",
        ])
        .current_dir(working.path());
        // Reservations consume real handle storage, but never assert distinct
        // lifetimes. Final accounting must reject their synthetic coverage.
        let (mut child, group) = windows::spawn_with_occupied_slots(&spec, occupied)
            .map_err(|failure| failure.error)
            .unwrap();
        let descendant = if occupied == 511 {
            wait_nested_file(&working.path().join("descendant-pid"));
            let pid = fs::read_to_string(working.path().join("descendant-pid"))
                .unwrap()
                .parse()
                .unwrap();
            let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(!raw.is_null());
            Some(unsafe { OwnedHandle::from_raw_handle(raw) })
        } else {
            // The creation event is refused before continuation. The parent
            // therefore cannot publish descendant-pid; await automatic closure.
            let deadline = Instant::now() + Duration::from_secs(5);
            while child.try_wait().unwrap().is_none() {
                assert!(
                    Instant::now() < deadline,
                    "capacity refusal did not stop root"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            None
        };
        group.terminate_and_wait(&mut child).unwrap();
        assert!(!group.proves_tree_quiescence());
        let error = group.with_proof_details(PortcoveError::state("capacity fixture held"));
        assert_eq!(error.details["process_tree_retained_members"], "512");
        assert_eq!(error.details["process_tree_active"], "0");
        assert_eq!(error.details["process_tree_total"], "2");
        assert_eq!(
            error.details["process_tree_first_failure"],
            if occupied == 512 {
                "retained_handle_capacity"
            } else {
                "lifetime_count_gap"
            }
        );
        if let Some(descendant) = descendant {
            assert_eq!(
                unsafe { WaitForSingleObject(descendant.as_raw_handle(), 1000) },
                WAIT_OBJECT_0,
                "captured descendant is positively stopped"
            );
        }
        child.wait().unwrap();
        assert!(!working.path().join("orphan-output").exists());
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
