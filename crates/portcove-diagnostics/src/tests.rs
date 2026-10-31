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
    let (host, guard) =
        HostDiagnostics::bootstrap(Surface::Desktop, false, move |session, surface| {
            let directory = portcove_core::prepare_support_log_directory(&worker_root).unwrap();
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
        });
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
    assert_eq!(host.health().flush_state, writer::FlushState::Unavailable);
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
