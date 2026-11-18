use super::*;
use std::{
    fs,
    sync::{Arc, Barrier},
    time::Duration,
};
use tracing_subscriber::Layer;

fn finish(mut guard: Option<writer::Guard>) {
    assert_eq!(
        guard
            .as_mut()
            .unwrap()
            .shutdown(Duration::from_secs(2))
            .flush_state,
        writer::FlushState::Complete
    );
}

fn records(host: &HostDiagnostics) -> Vec<serde_json::Value> {
    fs::read_to_string(
        host.session_directory()
            .unwrap()
            .join(writer::LOG_FILE_NAME),
    )
    .unwrap()
    .lines()
    .map(|line| serde_json::from_str(line).unwrap())
    .collect()
}

#[test]
fn location_selection_precedes_preference_read_and_invalid_location_has_safe_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let configured = temp.path().join("configured/preferences.json");
    let platform = temp.path().join("platform/preferences.json");
    fs::create_dir_all(configured.parent().unwrap()).unwrap();
    fs::write(
        &configured,
        "invalid preference JSON private-preference-canary",
    )
    .unwrap();
    let (host, guard) = HostDiagnostics::start_with_locations(
        Some(&configured),
        Some(&platform),
        Surface::Desktop,
        false,
    );
    assert!(!host.used_fallback());
    assert_eq!(
        host.directory(),
        Some(
            fs::canonicalize(configured.with_file_name("diagnostics"))
                .unwrap()
                .as_path()
        )
    );
    finish(guard);
    assert!(
        fs::read_to_string(&configured)
            .unwrap()
            .contains("private-preference-canary")
    );
    assert!(
        !serde_json::to_string(&records(&host))
            .unwrap()
            .contains("private-preference-canary")
    );

    let (fallback, guard) = HostDiagnostics::start_with_locations(
        Some(Path::new("relative-private-canary.json")),
        Some(&platform),
        Surface::Cli,
        false,
    );
    assert!(fallback.used_fallback());
    assert_eq!(
        fallback.directory(),
        Some(
            fs::canonicalize(platform.with_file_name("diagnostics"))
                .unwrap()
                .as_path()
        )
    );
    finish(guard);
    assert!(!platform.exists());
}

#[test]
fn failed_location_falls_back_but_a_selected_root_never_changes_on_capacity_failure() {
    let temp = tempfile::tempdir().unwrap();
    let blocked = temp.path().join("not-a-directory");
    fs::write(&blocked, "preserved").unwrap();
    let platform = temp.path().join("fallback/preferences.json");
    let (fallback, guard) = HostDiagnostics::start_with_locations(
        Some(&blocked.join("preferences.json")),
        Some(&platform),
        Surface::Desktop,
        false,
    );
    assert!(fallback.used_fallback());
    finish(guard);
    assert_eq!(fs::read_to_string(&blocked).unwrap(), "preserved");

    let configured = temp.path().join("chosen/preferences.json");
    // Reserve every real session before starting writers. This case owns the
    // selected-root and capacity policy, independently of best-effort startup.
    let prepared: Vec<_> = (0..SESSION_LIMIT)
        .map(|_| {
            let host = HostDiagnostics::disabled(Surface::Cli, false);
            let prepared = HostDiagnostics::prepare_locations(
                Some(&configured),
                Some(&platform),
                host.session_id,
                Surface::Cli,
                &host.support_directory,
            )
            .unwrap();
            assert!(prepared.allocation.is_some());
            (host, prepared)
        })
        .collect();
    let sessions: Vec<_> = prepared
        .into_iter()
        .map(|(host, prepared)| {
            let (host, guard) = host.start_prepared(prepared);
            (host, guard.unwrap())
        })
        .collect();
    let directories: std::collections::BTreeSet<_> = sessions
        .iter()
        .map(|(host, _)| host.session_directory().unwrap().to_owned())
        .collect();
    assert_eq!(directories.len(), SESSION_LIMIT);
    let (disabled, guard) = HostDiagnostics::start_with_locations(
        Some(&configured),
        Some(&platform),
        Surface::Cli,
        false,
    );
    assert!(guard.is_none());
    assert!(!disabled.used_fallback());
    assert_eq!(disabled.support_directory(), disabled.directory());
    assert_eq!(fallback.support_directory(), fallback.directory());
    assert_eq!(
        disabled.directory(),
        Some(
            fs::canonicalize(configured.with_file_name("diagnostics"))
                .unwrap()
                .as_path()
        )
    );
    assert_eq!(disabled.sessions().active_sessions, SESSION_LIMIT as u64);
    assert_eq!(
        disabled.health().flush_state,
        writer::FlushState::Unavailable
    );
    for (_host, guard) in sessions {
        finish(Some(guard));
    }
}

#[test]
fn simultaneous_desktop_and_cli_sessions_have_distinct_leases_envelopes_and_files() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("diagnostics");
    let barrier = Arc::new(Barrier::new(SESSION_LIMIT));
    // Exercise eight simultaneous writers with real, exclusively leased slots.
    // Preparation is sequential: best-effort startup may legitimately refuse a
    // session under its 250 ms product deadline or transient inventory contention.
    // The separate blocked-bootstrap test owns that unavailable-startup contract.
    let directory = portcove_core::prepare_support_log_directory(&directory).unwrap();
    let prepared: Vec<_> = (0..SESSION_LIMIT)
        .map(|index| {
            let surface = if index % 2 == 0 {
                Surface::Desktop
            } else {
                Surface::Cli
            };
            let host = HostDiagnostics::disabled(surface, false);
            let prepared =
                HostDiagnostics::prepare_session(directory.clone(), host.session_id, surface);
            assert!(prepared.allocation.is_some());
            (host, prepared, surface)
        })
        .collect();
    let threads: Vec<_> = prepared.into_iter().enumerate().map(|(index, (host, prepared, surface))| {
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            let (host, guard) = host.start_prepared(prepared);
            assert!(guard.is_some());
            tracing::subscriber::with_default(tracing_subscriber::registry().with(host.layer()), || {
                tracing::info!(target: "portcove_diagnostics", sequence = index as u64, message = "isolated session fixture");
            });
            (host, guard, surface)
        })
    }).collect();
    let sessions: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let directories: std::collections::BTreeSet<_> = sessions
        .iter()
        .map(|(host, _, _)| host.session_directory().unwrap().to_owned())
        .collect();
    assert_eq!(directories.len(), SESSION_LIMIT);
    let identities: std::collections::BTreeSet<_> = sessions
        .iter()
        .map(|(host, _, _)| host.session_id().to_owned())
        .collect();
    assert_eq!(identities.len(), SESSION_LIMIT);
    for (host, guard, surface) in sessions {
        finish(guard);
        let records = records(&host);
        assert!(records.len() >= 2);
        assert!(
            records
                .iter()
                .all(|record| record["session_id"] == host.session_id()
                    && record["surface"] == surface.as_str())
        );
        let marker: serde_json::Value = serde_json::from_slice(
            &fs::read(host.session_directory().unwrap().join(SESSION_MARKER)).unwrap(),
        )
        .unwrap();
        assert_eq!(marker["complete"], true);
        assert_eq!(marker["session_id"], host.session_id());
    }
}

#[test]
fn application_debug_expires_with_the_session_and_dependency_info_stays_off() {
    let temp = tempfile::tempdir().unwrap();
    for debug in [true, false] {
        // This case owns filtering and session-local debug, after filesystem
        // preparation. The separate blocked-bootstrap case owns the production
        // 250ms best-effort deadline, including late-worker lease cleanup.
        let host = HostDiagnostics::disabled(Surface::Cli, debug);
        let directory = portcove_core::prepare_support_log_directory(temp.path()).unwrap();
        let prepared = HostDiagnostics::prepare_session(directory, host.session_id, Surface::Cli);
        let (host, guard) = host.start_prepared(prepared);
        tracing::subscriber::with_default(
            tracing_subscriber::registry().with(host.layer().with_filter(host.filter())),
            || {
                tracing::debug!(target: "portcove_cli", message = "application debug fixture");
                tracing::info!(target: "portcove_core", message = "application info fixture");
                tracing::info!(target: "dependency::fixture", message = "dependency info fixture");
                tracing::warn!(target: "dependency::fixture", message = "dependency warn fixture");
            },
        );
        finish(guard);
        let text = serde_json::to_string(&records(&host)).unwrap();
        assert_eq!(text.contains("application debug fixture"), debug);
        assert!(text.contains("application info fixture"));
        assert!(!text.contains("dependency info fixture"));
        assert!(text.contains("dependency warn fixture"));
    }
    assert!(!temp.path().join("preferences.json").exists());
}

#[test]
fn unavailable_host_diagnostics_has_no_subscriber_or_application_failure() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("not-a-directory");
    fs::write(&file, "user file").unwrap();
    let (host, guard) = HostDiagnostics::start_in(&file, Surface::Desktop, false);
    assert!(guard.is_none());
    assert!(host.directory().is_none());
    assert_eq!(host.health().flush_state, writer::FlushState::Unavailable);
    assert_eq!(
        host.producer().try_record(b"{}\n".to_vec()),
        writer::EnqueueOutcome::DroppedClosed
    );
    assert_eq!(fs::read_to_string(file).unwrap(), "user file");
}

#[test]
fn recreated_layers_share_the_host_session_monotonic_clock() {
    let temp = tempfile::tempdir().unwrap();
    let host = HostDiagnostics::disabled(Surface::Desktop, false);
    let directory = portcove_core::prepare_support_log_directory(temp.path()).unwrap();
    let prepared = HostDiagnostics::prepare_session(directory, host.session_id, Surface::Desktop);
    assert!(prepared.allocation.is_some());
    let (host, guard) = host.start_prepared(prepared);
    std::thread::sleep(Duration::from_millis(5));
    for _ in 0..2 {
        tracing::subscriber::with_default(
            tracing_subscriber::registry().with(host.layer()),
            || {
                tracing::info!(target: "portcove_diagnostics", message = "same host clock");
            },
        );
    }
    finish(guard);
    let records = records(&host);
    let elapsed: Vec<_> = records
        .iter()
        .map(|record| record["elapsed_ms"].as_u64().unwrap())
        .collect();
    assert!(elapsed.windows(2).all(|pair| pair[0] <= pair[1]));
    assert!(elapsed.last().unwrap() >= &5);
}

#[test]
fn blocked_bootstrap_returns_unavailable_and_late_preparation_cannot_start_a_writer() {
    let temp = tempfile::tempdir().unwrap();
    let worker_root = temp.path().join("diagnostics");
    let (entered, observe) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let started = Instant::now();
    let (host, guard) = HostDiagnostics::bootstrap(
        Surface::Desktop,
        false,
        move |session, surface, support_directory| {
            let directory = portcove_core::prepare_support_log_directory(&worker_root).unwrap();
            let _ = support_directory.set(directory.clone());
            let prepared = HostDiagnostics::prepare_session(directory, session, surface);
            assert!(prepared.allocation.is_some());
            // The caller must probe the actual canonical namespace, not reconstruct it.
            entered
                .send(prepared.allocation.as_ref().unwrap().directory.clone())
                .unwrap();
            // Models a diagnostic OS call held after acquisition of the session
            // lease. The caller's receive deadline must not join or release it.
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Some(prepared)
        },
    );
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(BOOTSTRAP_TIMEOUT_MS));
    assert!(
        elapsed < Duration::from_secs(2),
        "startup waited for blocked diagnostics: {elapsed:?}"
    );
    assert!(guard.is_none());
    assert!(host.bootstrap_timed_out());
    assert!(host.directory().is_none());
    assert!(host.session_directory().is_none());
    assert_eq!(host.health().flush_state, writer::FlushState::Unavailable);
    assert_eq!(
        host.support_directory(),
        Some(
            fs::canonicalize(temp.path())
                .unwrap()
                .join("diagnostics")
                .as_path()
        )
    );
    let session = observe.recv_timeout(Duration::from_secs(2)).unwrap();
    let lease = writer::open_owned(&session.join(writer::WRITER_LOCK_NAME), false).unwrap();
    let error: io::Error = lease.try_lock().unwrap_err().into();
    assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match lease.try_lock() {
            Ok(()) => break,
            Err(error) => {
                let error: io::Error = error.into();
                assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
                assert!(
                    Instant::now() < deadline,
                    "late preparation retained its lease"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    // Lease release proves the late allocation reached its final drop. No
    // subscriber/writer can be created after this receiver has been abandoned.
    assert!(!session.join(writer::LOG_FILE_NAME).exists());
    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(session.join(SESSION_MARKER)).unwrap()).unwrap();
    assert_eq!(marker["complete"], false);
    let export_root = host.support_directory().unwrap();
    assert_eq!(
        export_root,
        fs::canonicalize(temp.path()).unwrap().join("diagnostics")
    );
    let exported = portcove_core::export_support_bundle(portcove_core::SupportBundleRequest {
        destination_dir: export_root,
        logs_dir: Some(export_root),
        library: None,
        startup_failure: None,
    })
    .unwrap();
    assert!(exported.path.is_file());
    assert!(!exported.manifest.library_available);
    assert_eq!(host.health().flush_state, writer::FlushState::Unavailable);
}

#[test]
fn late_validated_root_reaches_existing_handles_without_rebinding_or_enabling_logging() {
    let temp = tempfile::tempdir().unwrap();
    let expected = fs::canonicalize(temp.path())
        .unwrap()
        .join("chosen/diagnostics");
    let worker_root = expected.clone();
    let (release, wait) = mpsc::sync_channel(1);
    let (published, publication) = mpsc::sync_channel(1);
    let (host, guard, worker) = HostDiagnostics::bootstrap_worker(
        Surface::Desktop,
        false,
        move |session, surface, support_directory| {
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            let directory = portcove_core::prepare_support_log_directory(&worker_root).unwrap();
            support_directory.set(directory.clone()).unwrap();
            // Selection is immutable even if another location later becomes available.
            assert!(
                support_directory
                    .set(worker_root.with_file_name("other"))
                    .is_err()
            );
            let prepared = HostDiagnostics::prepare_session(directory, session, surface);
            published.send(()).unwrap();
            Some(prepared)
        },
    );
    let retained = host.clone();
    assert!(guard.is_none());
    assert!(host.bootstrap_timed_out());
    assert!(host.directory().is_none());
    assert!(retained.support_directory().is_none());
    release.send(()).unwrap();
    publication.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(retained.support_directory(), Some(expected.as_path()));
    assert_eq!(host.support_directory(), retained.support_directory());
    assert!(retained.directory().is_none());
    assert!(retained.session_directory().is_none());
    assert!(retained.bootstrap_timed_out());
    assert_eq!(
        retained.health().flush_state,
        writer::FlushState::Unavailable
    );
    let exported = portcove_core::export_support_bundle(portcove_core::SupportBundleRequest {
        destination_dir: retained.support_directory().unwrap(),
        logs_dir: retained.support_directory(),
        library: None,
        startup_failure: None,
    })
    .unwrap();
    assert_eq!(exported.path.parent(), Some(expected.as_path()));
    assert!(!exported.manifest.library_available);
    assert!(!expected.with_file_name("other").exists());
    let worker = worker.expect("bootstrap worker was not started");
    let deadline = Instant::now() + Duration::from_secs(2);
    while !worker.is_finished() {
        assert!(Instant::now() < deadline, "bootstrap worker did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
    worker.join().unwrap();
    assert_eq!(
        retained.health().flush_state,
        writer::FlushState::Unavailable
    );
}

#[cfg(unix)]
#[test]
fn unsafe_export_root_is_never_published_after_bootstrap() {
    let temp = tempfile::tempdir().unwrap();
    let foreign = temp.path().join("foreign");
    fs::create_dir(&foreign).unwrap();
    let alias = temp.path().join("alias");
    std::os::unix::fs::symlink(&foreign, &alias).unwrap();
    let requested = alias.join("diagnostics");
    let (host, guard, worker) = HostDiagnostics::bootstrap_worker(
        Surface::Desktop,
        false,
        move |session, surface, support_directory| {
            HostDiagnostics::prepare_in(&requested, session, surface, support_directory)
        },
    );
    let worker = worker.expect("bootstrap worker was not started");
    let deadline = Instant::now() + Duration::from_secs(2);
    while !worker.is_finished() {
        assert!(
            Instant::now() < deadline,
            "unsafe-root validation did not finish"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    worker.join().unwrap();
    assert!(guard.is_none());
    assert!(host.support_directory().is_none());
    assert!(host.session_directory().is_none());
    assert_eq!(host.health().flush_state, writer::FlushState::Unavailable);
    assert!(!foreign.join("diagnostics").exists());
}

#[test]
fn qualification_preparation_requires_the_compile_feature_and_exact_opt_in() {
    const CHILD: &str = "PORTCOVE_DIAGNOSTICS_POLICY_FIXTURE_CHILD";
    const FLAG: &str = "PORTCOVE_DIAGNOSTICS_QUALIFICATION_PREPARED";
    if std::env::var(CHILD).as_deref() == Ok("1") {
        let root =
            PathBuf::from(std::env::var_os("PORTCOVE_DIAGNOSTICS_POLICY_FIXTURE_ROOT").unwrap());
        let (host, mut guard) =
            HostDiagnostics::start_in(&root.join("diagnostics"), Surface::Cli, false);
        let mode = host.qualification_prepared();
        if let Some(guard) = &mut guard {
            assert_eq!(
                guard.shutdown(Duration::from_secs(2)).flush_state,
                writer::FlushState::Complete
            );
        }
        std::fs::write(
            root.join("mode.json"),
            serde_json::to_vec(&serde_json::json!({
                "feature_enabled": cfg!(feature = "qualification-fixtures"),
                "qualification_prepared": mode,
                "bootstrap_timed_out": host.bootstrap_timed_out(),
            }))
            .unwrap(),
        )
        .unwrap();
        return;
    }
    for value in [
        None,
        Some(""),
        Some("0"),
        Some("true"),
        Some("1 "),
        Some(" 1"),
    ] {
        assert!(!HostDiagnostics::qualification_preparation_requested(value));
    }
    assert_eq!(
        HostDiagnostics::qualification_preparation_requested(Some("1")),
        cfg!(feature = "qualification-fixtures")
    );
    struct OwnedPolicyChild(Option<std::process::Child>);
    impl Drop for OwnedPolicyChild {
        fn drop(&mut self) {
            if let Some(mut child) = self.0.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    for flag in [None, Some("1"), Some("true")] {
        let temporary = tempfile::tempdir().unwrap();
        let mut command = portcove_core::ChildProcessPolicy::native_command(
            portcove_core::ChildProcessClass::HostIntegration,
            std::env::current_exe().unwrap(),
        )
        .unwrap();
        command
            .args([
                "--exact",
                "tests::qualification_preparation_requires_the_compile_feature_and_exact_opt_in",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("PORTCOVE_DIAGNOSTICS_POLICY_FIXTURE_ROOT", temporary.path())
            .env_remove(FLAG)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(flag) = flag {
            command.env(FLAG, flag);
        }
        let mut child = OwnedPolicyChild(Some(command.spawn().unwrap()));
        let started = Instant::now();
        loop {
            if child.0.as_mut().unwrap().try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "owned constructor policy child did not exit"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.0.take().unwrap().wait_with_output().unwrap();
        assert!(output.status.success(), "{output:?}");
        let observed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temporary.path().join("mode.json")).unwrap())
                .unwrap();
        assert_eq!(
            observed["feature_enabled"],
            cfg!(feature = "qualification-fixtures")
        );
        assert_eq!(
            observed["qualification_prepared"],
            cfg!(feature = "qualification-fixtures") && flag == Some("1")
        );
        println!("diagnostic-bootstrap-policy: flag={flag:?} observed={observed}");
    }
}

#[test]
fn panic_record_preserves_previous_hook_and_reaches_a_later_bundle() {
    use portcove_core::runtime_diagnostics::PANIC_RECORD_NAME;
    use std::process::Stdio;

    const ROOT: &str = "PORTCOVE_TEST_PANIC_ROOT";
    const MODE: &str = "PORTCOVE_TEST_PANIC_MODE";
    if let Some(root) = std::env::var_os(ROOT) {
        std::panic::set_hook(Box::new(|_| eprintln!("previous hook observed")));
        install_panic_hook();
        let (host, guard) = HostDiagnostics::start_in(Path::new(&root), Surface::Cli, false);
        if std::env::var_os(MODE).as_deref() == Some(std::ffi::OsStr::new("unhandled")) {
            assert!(host.session_directory().is_some());
            panic!("private panic canary");
        }
        for _ in 0..2 {
            assert!(std::panic::catch_unwind(|| panic!("private panic canary")).is_err());
        }
        if host.session_directory().is_some() {
            finish(guard);
        }
        return;
    }

    for mode in ["caught", "unhandled", "unavailable"] {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("logs");
        if mode == "unavailable" {
            fs::write(&root, b"not a diagnostic directory").unwrap();
        }
        let stderr = fs::File::create(temporary.path().join("stderr")).unwrap();
        let mut command = portcove_core::ChildProcessPolicy::native_command(
            portcove_core::ChildProcessClass::HostIntegration,
            std::env::current_exe().unwrap(),
        )
        .unwrap();
        let mut child = command
            .args([
                "--exact",
                "tests::panic_record_preserves_previous_hook_and_reaches_a_later_bundle",
                "--nocapture",
            ])
            .env(ROOT, &root)
            .env(MODE, mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                other => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("panic fixture did not complete: {other:?}");
                }
            }
        };
        assert_eq!(status.success(), mode != "unhandled", "{mode}");
        let stderr = fs::read_to_string(temporary.path().join("stderr")).unwrap();
        assert_eq!(
            stderr.matches("previous hook observed").count(),
            if mode == "unhandled" { 1 } else { 2 },
            "{mode}: {stderr}"
        );
        if mode == "unavailable" {
            assert_eq!(fs::read(&root).unwrap(), b"not a diagnostic directory");
            continue;
        }

        let record = fs::read_to_string(root.join(SLOT_NAMES[0]).join(PANIC_RECORD_NAME)).unwrap();
        assert_eq!(record.lines().count(), 1);
        assert!(record.contains("Rust panic observed"));
        assert!(!record.contains("private panic canary"));
        let exported = portcove_core::export_support_bundle(portcove_core::SupportBundleRequest {
            destination_dir: &temporary.path().join("exports"),
            logs_dir: Some(&root),
            library: None,
            startup_failure: None,
        })
        .unwrap();
        let entry = format!("logs/{}/{}", SLOT_NAMES[0], PANIC_RECORD_NAME);
        assert!(exported.manifest.sections.iter().any(|section| {
            section.entry.as_deref() == Some(entry.as_str()) && section.records == Some(1)
        }));
    }
}
