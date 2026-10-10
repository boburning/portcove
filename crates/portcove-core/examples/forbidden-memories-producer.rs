//! Child interface for an independently admitted, owned native session.
//! This example alone does not establish process-tree exit or qualification.
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex},
    time::Duration,
};

use portcove_core::{Library, OperationEventKind, PortcoveService};
use serde_json::json;
use sha2::{Digest, Sha256};

// Managed preparation consumes CHD; Core verifies the normalized track.
const SOURCE_BYTES: u64 = 151_881_565;
const SOURCE_SHA256: &str = "3447677c2313417e285abed0b18bd9c24c0a2efb095ede61b9b0b1edecdc8ff4";
// Leave time for cooperative drain within the unchanged 180-second outer cap.
const PREPARATION_SECONDS: u64 = 150;

fn source_identity(source: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut file = File::open(source)?;
    if file.metadata()?.len() != SOURCE_BYTES {
        return Err("CHD source size changed".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if hex::encode(hash.finalize()) != SOURCE_SHA256 {
        return Err("CHD source digest changed".into());
    }
    Ok(())
}

fn emit(value: serde_json::Value) -> std::io::Result<()> {
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn capture_root_activity(id: &Mutex<Option<String>>, event: &portcove_core::OperationEvent) {
    if matches!(event.event, OperationEventKind::Started) && event.parent_operation_id.is_none() {
        let mut id = id.lock().expect("event identity lock poisoned");
        if id.is_none() {
            *id = Some(event.operation_id.clone());
        }
    }
}

fn retain_boundary_event(event: &portcove_core::OperationEvent, emitted: u64) -> bool {
    if matches!(
        event.event,
        OperationEventKind::Started | OperationEventKind::Finished { .. }
    ) {
        return event.parent_operation_id.is_none() || emitted < 32;
    }
    matches!(&event.event, OperationEventKind::Message { level, .. } if level == "error")
        && emitted < 32
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() == 4 && args[0] == "--supervise" {
        let digest = args[1].to_str().ok_or("digest must be UTF-8")?;
        let receipt = PortcoveService::qualification_forbidden_memories_supervise(
            &std::env::current_exe()?,
            digest,
            &PathBuf::from(&args[2]),
            &PathBuf::from(&args[3]),
        )?;
        emit(receipt.clone())?;
        if receipt["process_tree_quiesced"] != true
            || receipt["outcome"]["child_success"] != true
            || receipt["outcome"]["output_truncated"] != false
        {
            return Err("owned producer session held; preserve all evidence".into());
        }
        return Ok(());
    }
    if args.len() != 3 || args[0] != "--owned-child" {
        return Err(
            "requires --supervise <reviewed binary SHA256> <fresh library> <original CHD source>"
                .into(),
        );
    }
    let root = PathBuf::from(&args[1]);
    let source = PathBuf::from(&args[2]);
    if !root.is_absolute() || !source.is_absolute() {
        return Err("root and source must be absolute".into());
    }
    // The outer session owns the environment, lifetime and source custody.
    // Rejecting overrides here is an additional refusal, not admission.
    if std::env::vars_os().any(|(name, _)| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("PORTCOVE_QUALIFICATION_CATALOG")
    }) {
        return Err("catalog override is forbidden".into());
    }
    source_identity(&source)?;
    let operation_id = Arc::new(Mutex::new(None::<String>));
    let output_error = Arc::new(Mutex::new(None::<std::io::Error>));
    let event_id = Arc::clone(&operation_id);
    let event_error = Arc::clone(&output_error);
    let seen_events = Arc::new(AtomicU64::new(0));
    let emitted_events = Arc::new(AtomicU64::new(0));
    let event_seen = Arc::clone(&seen_events);
    let event_emitted = Arc::clone(&emitted_events);
    let operation =
        PortcoveService::qualification_forbidden_memories_baseline(&root, &source, move |event| {
            capture_root_activity(&event_id, &event);
            event_seen.fetch_add(1, Ordering::Relaxed);
            // Core owns activity and bounded diagnostic evidence.
            // Keep this child's bounded output for boundaries and final result;
            // per-chunk download progress must not displace the terminal receipt.
            if !retain_boundary_event(&event, event_emitted.load(Ordering::Relaxed)) {
                return;
            }
            event_emitted.fetch_add(1, Ordering::Relaxed);
            if let Err(error) = emit(json!({"kind": "operation", "event": event})) {
                *event_error.lock().expect("output error lock poisoned") = Some(error);
            }
        });
    tokio::pin!(operation);
    let mut deadline_reached = false;
    let result = tokio::select! {
        result = &mut operation => result,
        _ = tokio::time::sleep(Duration::from_secs(PREPARATION_SECONDS)) => {
            deadline_reached = true;
            let id = operation_id.lock().expect("event identity lock poisoned").clone();
            let cancellation = id.map(|id| {
                PortcoveService::new_read_only(Library::open(&root)?)?.request_cancellation(&id)
            });
            // Do not drop a mutation future or clean its private preparation.
            // The outer controller must enforce its own finite lifetime and
            // retain evidence if this cooperative stop cannot finish.
            let _ = emit(json!({"kind": "deadline", "seconds": PREPARATION_SECONDS,
                "cancellation": cancellation.map(|result| result.map_err(|error| error.to_string()))}));
            operation.await
        }
    };
    source_identity(&source)?;
    emit(
        json!({"kind": "terminal", "deadline_reached": deadline_reached,
        "result": result.as_ref().map(|(_, install)| install).map_err(|error| error.to_string()),
        "source_container_sha256": SOURCE_SHA256,
        "expected_normalized_track_sha256": "6e22494a45bf50fa2d239cd3819a57163a5f9b91e0365babc3e101509b5c3a7c",
        "normalized_track_validation_requirement": "existing Core source inspection and validation; not observed by this field",
        "events_observed": seen_events.load(Ordering::Relaxed),
        "events_emitted": emitted_events.load(Ordering::Relaxed),
        "events_omitted": seen_events.load(Ordering::Relaxed) - emitted_events.load(Ordering::Relaxed),
        "retained_operation_evidence": "Core activity and bounded diagnostics; event stream deliberately sampled",
        "process_tree_exit": "requires outer owned-session receipt"}),
    )?;
    if let Some(error) = output_error
        .lock()
        .expect("output error lock poisoned")
        .take()
    {
        return Err(error.into());
    }
    result?;
    if deadline_reached {
        return Err("preparation exceeded the finite qualification deadline".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_events_never_replace_the_durable_cancellation_activity() {
        let id = Mutex::new(None);
        let event = |operation_id: &str, parent: Option<&str>| {
            serde_json::from_value(json!({
                "schema_version": 1, "operation_id": operation_id,
                "parent_operation_id": parent, "sequence": 1,
                "timestamp_ms": 0, "operation": "install", "target": null,
                "type": "started"
            }))
            .unwrap()
        };
        capture_root_activity(&id, &event("early-child", Some("root")));
        assert!(id.lock().unwrap().is_none());
        capture_root_activity(&id, &event("root", None));
        capture_root_activity(&id, &event("managed-build", Some("root")));
        capture_root_activity(&id, &event("nested-tool", Some("managed-build")));
        capture_root_activity(&id, &event("another-root", None));
        assert_eq!(id.lock().unwrap().as_deref(), Some("root"));
    }

    #[test]
    fn capped_child_boundaries_preserve_root_terminal_evidence() {
        let mut event: portcove_core::OperationEvent = serde_json::from_value(json!({
            "schema_version": 3, "operation_id": "child",
            "parent_operation_id": "root", "sequence": 1,
            "timestamp_ms": 0, "operation": "install", "target": null,
            "type": "started"
        }))
        .unwrap();
        assert!(retain_boundary_event(&event, 31));
        assert!(!retain_boundary_event(&event, 32));
        event.parent_operation_id = None;
        event.event = OperationEventKind::Finished {
            result: portcove_core::OperationResult::Failed,
        };
        assert!(retain_boundary_event(&event, 32));
        event.event = OperationEventKind::Progress {
            phase: "download".into(),
            completed: 100,
            total: Some(200),
        };
        assert!(!retain_boundary_event(&event, 0));
        event.event = OperationEventKind::Message {
            level: "error".into(),
            message: "owned failure".into(),
        };
        assert!(retain_boundary_event(&event, 0));
        assert!(!retain_boundary_event(&event, 32));
    }
}
