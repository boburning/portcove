//! Explicit host diagnostic, excluded from ordinary test execution.
use super::*;
use std::time::{Duration, Instant};

#[test]
#[ignore = "explicit host SDK measurement; retains a fresh private C: copy"]
fn cvlod_host_sdk_stage_timings() {
    let root = PathBuf::from(
        std::env::var_os("PORTCOVE_SDK_PROBE_ROOT").expect("explicit fresh probe root required"),
    );
    let name = root.file_name().unwrap().to_str().unwrap();
    assert!(name.starts_with("pc6cv-sdk-probe-"));
    assert_eq!(root.parent(), Some(Path::new("C:/")));
    crate::path::refuse_symlink_ancestors(&root).unwrap();
    fs::create_dir(&root).expect("probe root must not exist; nothing is reused or removed");
    let mut log = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("stages.jsonl"))
        .unwrap();
    let started = Instant::now();
    let checkpoint = || {
        if started.elapsed() > Duration::from_secs(15 * 60) {
            Err(PortcoveError::verification(
                "SDK diagnostic deadline exceeded",
            ))
        } else {
            Ok(())
        }
    };
    fn record(log: &mut fs::File, value: serde_json::Value) {
        writeln!(log, "{value}").unwrap();
        log.sync_all().unwrap();
    }
    fn stage<T>(log: &mut fs::File, name: &str, action: impl FnOnce() -> Result<T>) -> T {
        record(log, serde_json::json!({"stage": name, "event": "start"}));
        let begin = Instant::now();
        let result = action();
        record(
            log,
            serde_json::json!({
                "stage": name, "event": "end", "elapsed_ms": begin.elapsed().as_millis(),
                "ok": result.is_ok(), "error": result.as_ref().err().map(|e| format!("{e:?}")),
            }),
        );
        result.unwrap()
    }
    record(
        &mut log,
        serde_json::json!({
            "profile_sha256": identity(), "files": 5621, "bytes": 908_859_619u64,
            "scope": "SDK-only production-function stages; no build, game or original data",
            "cache": "uncontrolled host cache; single run is not cold-cache throughput proof",
            "product_deadline_changed": false,
        }),
    );
    stage(&mut log, "host_authentication", || {
        require_available(&checkpoint)
    });
    let sdk = stage(&mut log, "copy_and_group_verification", || {
        copy_into(&root, &checkpoint)
    });
    let captured = stage(&mut log, "private_inventory_capture", || {
        inventory(&sdk, &checkpoint)
    });
    let inputs = BuildInputs {
        recipe: super::super::RECIPE,
        roots: vec![sdk.clone()],
        identities: vec![captured],
    };
    stage(&mut log, "captured_manifest_binding", || {
        verify_captured(&inputs, &sdk, &checkpoint)
    });
    stage(&mut log, "private_inventory_reverification", || {
        if inventory(&sdk, &checkpoint)? != inputs.identities[0] {
            return Err(PortcoveError::verification("SDK diagnostic input changed"));
        }
        Ok(())
    });
    stage(&mut log, "final_manifest_binding", || {
        verify_captured(&inputs, &sdk, &checkpoint)
    });
    record(
        &mut log,
        serde_json::json!({"result": "pass", "elapsed_ms": started.elapsed().as_millis()}),
    );
    println!("SDK diagnostic retained at {}", root.display());
}
