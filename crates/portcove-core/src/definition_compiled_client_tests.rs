use super::*;
use std::{
    process::Stdio,
    time::{Duration, Instant},
};

struct Consumer {
    path: PathBuf,
    sha256: String,
}

impl Consumer {
    fn from_environment(prefix: &str) -> Self {
        Self::new(
            PathBuf::from(std::env::var_os(format!("{prefix}_PATH")).unwrap()),
            std::env::var(format!("{prefix}_SHA256")).unwrap(),
        )
    }

    fn new(path: PathBuf, sha256: String) -> Self {
        let consumer = Self { path, sha256 };
        consumer.verify_hash("before qualification");
        consumer
    }

    fn verify_hash(&self, phase: &str) {
        let started = Instant::now();
        let bytes = fs::read(&self.path).unwrap();
        let read_elapsed = started.elapsed();
        let hash_started = Instant::now();
        assert_eq!(hex::encode(Sha256::digest(&bytes)), self.sha256);
        println!(
            "compiled consumer {phase}: bytes={}, read_ms={}, hash_ms={}",
            bytes.len(),
            read_elapsed.as_millis(),
            hash_started.elapsed().as_millis()
        );
    }

    fn invoke(&self, library: &Library, args: &[&str]) -> Value {
        self.invoke_result(library, args, true)
    }

    fn invoke_result(&self, library: &Library, args: &[&str], success: bool) -> Value {
        let output = tempfile::tempdir_in(library.root()).unwrap();
        let stdout = output.path().join("stdout.json");
        let stderr = output.path().join("stderr.log");
        let mut child = crate::ChildProcessPolicy::native_command(
            crate::ChildProcessClass::HostTool,
            &self.path,
        )
        .unwrap()
        .args(args)
        .env_remove("PORTCOVE_QUALIFICATION_CATALOG")
        // The qualification provider must not load or send either ambient token.
        .env("GH_TOKEN", "owned-inert-qualification-token")
        .env("GITHUB_TOKEN", "owned-inert-qualification-token")
        .env("PORTCOVE_QUALIFICATION_LIBRARY", library.root())
        .stdin(Stdio::null())
        .stdout(fs::File::create(&stdout).unwrap())
        .stderr(fs::File::create(&stderr).unwrap())
        .spawn()
        .unwrap();
        let start = Instant::now();
        let observation = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(error) => break Err(format!("could not observe owned consumer: {error}")),
            }
            if start.elapsed() >= Duration::from_secs(15) {
                break Err("owned compiled consumer exceeded 15 seconds".to_owned());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if observation.is_err() {
            let _ = child.kill();
        }
        // Positive reap precedes output/fixture cleanup, including timeout/error.
        // The containing existing Heavy Rust supervisor owns any failed reap.
        let status = child.wait().unwrap();
        println!(
            "compiled consumer child: elapsed_ms={}",
            start.elapsed().as_millis()
        );
        assert!(
            observation.is_ok(),
            "{observation:?}; {}",
            fs::read_to_string(&stderr).unwrap()
        );
        let result: Value = serde_json::from_slice(&fs::read(&stdout).unwrap()).unwrap();
        assert_eq!(
            status.success(),
            success,
            "arguments: {args:?}; error: {}; stderr: {}",
            result["error"],
            fs::read_to_string(&stderr).unwrap()
        );
        result
    }
}

#[test]
fn compiled_consumer_identity_refuses_before_and_after_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("owned-consumer");
    let original = b"owned initial consumer";
    fs::write(&path, original).unwrap();
    let digest = hex::encode(Sha256::digest(original));
    let consumer = Consumer::new(path.clone(), digest.clone());
    fs::write(&path, b"changed consumer").unwrap();
    assert!(std::panic::catch_unwind(|| consumer.verify_hash("after qualification")).is_err());
    assert!(std::panic::catch_unwind(|| Consumer::new(path, digest)).is_err());
}

#[tokio::test]
#[ignore = "explicit unchanged compiled-client correction consumption"]
async fn qualification_compiled_clients_consume_managed_corrections() {
    qualification_managed_compiled_clients(true).await;
}

#[tokio::test]
#[ignore = "explicit unchanged compiled CLI acquisition; Desktop acceptance remains separate"]
async fn qualification_compiled_cli_acquires_managed_artifacts() {
    qualification_managed_compiled_clients(false).await;
}

async fn qualification_managed_compiled_clients(include_desktop: bool) {
    let cli = Consumer::from_environment("PORTCOVE_QUALIFICATION_CLI");
    let desktop =
        include_desktop.then(|| Consumer::from_environment("PORTCOVE_QUALIFICATION_DESKTOP"));
    let report = PathBuf::from(std::env::var_os("PORTCOVE_QUALIFICATION_CONSUMER_REPORT").unwrap());
    let mut stages = Vec::new();
    let mut observe = |library: &Library, stage: &str| {
        let root = library.root().to_str().unwrap();
        let cli_status = cli.invoke(
            library,
            &["--library", root, "--json", "--non-interactive", "status"],
        );
        assert_eq!(cli_status["ok"], true);
        assert_eq!(cli_status["command"], "status");
        let desktop_status = desktop.as_ref().map(|desktop| {
            desktop.invoke(library, &["--portcove-adapter-conformance-statuses", root])
        });
        let service = PortcoveService::new(library.clone()).unwrap();
        let expected = serde_json::to_value(service.statuses().unwrap()).unwrap();
        assert_eq!(cli_status["data"], expected, "{stage}: CLI projection");
        if let Some(desktop_status) = desktop_status {
            assert_eq!(desktop_status, expected, "{stage}: Desktop projection");
        }
        let content = cli.invoke(
            library,
            &[
                "--library",
                root,
                "--json",
                "--non-interactive",
                "catalog",
                "show",
                ID,
            ],
        );
        assert_eq!(content["ok"], true);
        assert_eq!(content["command"], "catalog.show");
        assert_eq!(
            content["data"],
            serde_json::to_value(service.catalog().port(ID).unwrap()).unwrap()
        );
        if stage.starts_with("correction-") {
            assert_eq!(
                content["data"]["summary"],
                "Reviewed presentation correction"
            );
        }
        stages.push(serde_json::json!({
            "stage": stage,
            "selected": library.definition_selection_status().unwrap().selected,
            "cli_catalog_content": content["data"],
            "statuses": expected,
            "core_cli_status_parity": true,
            "complete_status_parity": desktop.is_some(),
        }));
    };
    let mut acquisitions = Vec::new();
    let mut acquire = |library: &Library,
                       server: &AcquisitionHttp,
                       repository_id: u64,
                       version: &str,
                       release: &Value,
                       bytes: &[u8]| {
        let root = library.root().to_str().unwrap();
        let base = [
            "--library",
            root,
            "--json",
            "--non-interactive",
            "--qualification-provider-library",
            root,
            "--qualification-provider-origin",
            server.origin.as_str(),
            "installation",
        ];
        let (plan_command, run_command) = if version == "v1" {
            ("plan", "run")
        } else {
            ("qualification-update-plan", "qualification-update-run")
        };
        let metadata = || {
            server.json(serde_json::json!({"id":repository_id,"archived":false}));
            server.json(release.clone());
        };
        let user = library.user_dir(ID);
        if version == "v2" {
            fs::create_dir_all(user.join("saves")).unwrap();
            fs::create_dir_all(user.join("config")).unwrap();
            fs::write(user.join("saves/progress.bin"), b"owned retained progress").unwrap();
            fs::write(user.join("config/settings.json"), b"{\"owned\":true}").unwrap();
        }
        let user_before = crate::library_transfer::reviewed_tree(&user).unwrap();
        let requests_before = server.requests.lock().unwrap().len();
        let before_selection = library.definition_selection_status().unwrap();
        let before_records = library.status(ID, ReleaseChannel::Stable).unwrap();
        let retained_before = before_records
            .active
            .as_ref()
            .map(|installed| crate::library_transfer::reviewed_tree(&installed.path).unwrap());
        let wrong_library = tempfile::tempdir().unwrap();
        for (origin, bound_root) in [
            ("https://github.com", root),
            ("http://localhost:8123", root),
            (
                server.origin.as_str(),
                wrong_library.path().to_str().unwrap(),
            ),
        ] {
            let refused = cli.invoke_result(
                library,
                &[
                    "--library",
                    root,
                    "--json",
                    "--non-interactive",
                    "--qualification-provider-library",
                    bound_root,
                    "--qualification-provider-origin",
                    origin,
                    "installation",
                    plan_command,
                    ID,
                ],
                false,
            );
            assert_eq!(refused["ok"], false);
        }
        assert_eq!(server.requests.lock().unwrap().len(), requests_before);
        metadata();
        let plan = cli.invoke(library, &[base.as_slice(), &[plan_command, ID]].concat());
        assert_eq!(plan["ok"], true);
        let fingerprint = plan["data"]["plan_sha256"].as_str().unwrap();
        let expected_release = &plan["data"]["plan"]["release"];
        assert_eq!(expected_release["version"], version);
        let before = library.status(ID, ReleaseChannel::Stable).unwrap();
        // A stale reviewed fingerprint refuses before authorization or download.
        metadata();
        let refused = cli.invoke_result(
            library,
            &[
                base.as_slice(),
                &[run_command, ID, "--expected-plan", &"0".repeat(64), "--yes"],
            ]
            .concat(),
            false,
        );
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["error"]["code"], "conflict");
        assert_eq!(
            crate::library_transfer::reviewed_tree(&user).unwrap(),
            user_before
        );
        assert_eq!(
            serde_json::to_value(library.status(ID, ReleaseChannel::Stable).unwrap()).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        assert!(server.responses.lock().unwrap().is_empty());
        let mut corrupt = bytes.to_vec();
        corrupt[0] ^= 1;
        for redirect in [false, true] {
            metadata();
            server.json(serde_json::json!({"id":repository_id,"archived":false}));
            server.json(serde_json::json!({"id":repository_id,"archived":false}));
            if redirect {
                server.redirect("https://github.com/owned-fixture.zip");
            } else {
                server.bytes(&corrupt);
            }
            let invocation_started = time::OffsetDateTime::now_utc().unix_timestamp();
            let refused = cli.invoke_result(
                library,
                &[
                    base.as_slice(),
                    &[run_command, ID, "--expected-plan", fingerprint, "--yes"],
                ]
                .concat(),
                false,
            );
            assert_eq!(refused["ok"], false);
            if redirect {
                assert_eq!(refused["error"]["code"], "network");
            } else {
                assert_eq!(refused["error"]["code"], "verification");
                assert_eq!(
                    refused["error"]["details"]["expected"],
                    expected_release["asset"]["sha256"]
                );
                assert_eq!(
                    refused["error"]["details"]["actual"],
                    hex::encode(Sha256::digest(&corrupt))
                );
            }
            let mut after = library.status(ID, ReleaseChannel::Stable).unwrap();
            if version == "v2" {
                // Canonical reviewed updates record the truthful check before
                // acquisition. Validate it independently; preserve every other
                // status field exactly through either download refusal.
                let snapshot = after.last_update_check.as_ref().unwrap();
                assert!(snapshot.checked_at >= invocation_started);
                assert!(snapshot.checked_at <= time::OffsetDateTime::now_utc().unix_timestamp());
                let active = before.active.as_ref().unwrap();
                let expected_check = crate::UpdateCheck {
                    port_id: ID.into(),
                    channel: before.channel,
                    installed_version: Some(active.version.clone()),
                    installed_artifact: Some(active.artifact.clone()),
                    installed_runtime: active.runtime.clone(),
                    required_runtime: None,
                    update_available: true,
                    release: serde_json::from_value(expected_release.clone()).unwrap(),
                };
                assert_eq!(
                    serde_json::to_value(&snapshot.check).unwrap(),
                    serde_json::to_value(expected_check).unwrap()
                );
                after.last_update_check = before.last_update_check.clone();
            }
            assert_eq!(
                serde_json::to_value(after).unwrap(),
                serde_json::to_value(&before).unwrap()
            );
            assert_eq!(
                crate::library_transfer::reviewed_tree(&user).unwrap(),
                user_before
            );
            assert_eq!(
                serde_json::to_value(library.definition_selection_status().unwrap()).unwrap(),
                serde_json::to_value(&before_selection).unwrap()
            );
            if let Some(retained) = &retained_before {
                assert_eq!(
                    &crate::library_transfer::reviewed_tree(
                        &before_records.active.as_ref().unwrap().path
                    )
                    .unwrap(),
                    retained
                );
            }
            assert!(server.responses.lock().unwrap().is_empty());
        }
        metadata();
        // Canonical reviewed execution revalidates repository identity at both
        // apply-time planning and acquisition, while retaining the exact release.
        server.json(serde_json::json!({"id":repository_id,"archived":false}));
        server.json(serde_json::json!({"id":repository_id,"archived":false}));
        server.bytes(bytes);
        let result = cli.invoke(
            library,
            &[
                base.as_slice(),
                &[run_command, ID, "--expected-plan", fingerprint, "--yes"],
            ]
            .concat(),
        );
        let installed: crate::InstallRecord =
            serde_json::from_value(result["data"].clone()).unwrap();
        assert_eq!(installed.version, expected_release["version"]);
        assert_eq!(
            installed.artifact.sha256,
            expected_release["asset"]["sha256"]
        );
        assert_eq!(installed.artifact.size, expected_release["asset"]["size"]);
        assert!(server.responses.lock().unwrap().is_empty());
        assert_eq!(
            crate::library_transfer::reviewed_tree(&user).unwrap(),
            user_before
        );
        acquisitions.push(
            serde_json::json!({"version":version, "plan_sha256":fingerprint,
            "reviewed_release": expected_release, "installed":installed,
            "retained_user_tree":user_before,
            "stale_plan_refused":true, "digest_mismatch_refused":true,
            "outside_origin_redirect_refused":true, "nonloopback_origin_refused":true,
            "mismatched_library_refused":true, "retained_state_preserved_after_refusals":true}),
        );
        installed
    };
    // The owned consumers are pinned before publication and rechecked after the
    // complete sequence, before reporting. Rehashing their full debug images per command does
    // not add a client observation and dominated the measured qualification cost.
    managed_ordinary_lifecycle(Some(&mut observe), Some(&mut acquire)).await;
    cli.verify_hash("after qualification");
    if let Some(desktop) = &desktop {
        desktop.verify_hash("after qualification");
    }

    assert_eq!(
        stages
            .iter()
            .map(|s| s["stage"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "new-definition",
            "v1",
            "v2",
            "correction-8",
            "correction-9",
            "authorization-narrowed",
            "authorization-restored"
        ]
    );
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": 1,
        "scope": "Unchanged fixture-capable CLI drives canonical reviewed install/update acquisition of inert loopback artifacts; Desktop execution is reported separately; no production feed, protected publication or installed GUI claim",
        "acquisitions": acquisitions,
        "cli_sha256": cli.sha256,
        "desktop_sha256": desktop.as_ref().map(|desktop| &desktop.sha256),
        "desktop_projection_executed": desktop.is_some(),
        "stages": stages,
    })).unwrap();
    use std::io::Write;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report)
        .unwrap()
        .write_all(&bytes)
        .unwrap();
}
