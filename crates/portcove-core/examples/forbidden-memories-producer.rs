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
// Qualification-only policy is shared with the Core supervisor and controller.
const PREPARATION_SECONDS: u64 = PortcoveService::QUALIFICATION_FORBIDDEN_MEMORIES_WORK_SECONDS;

fn cooperative_work_cutoff(budget: Duration) -> tokio::time::Sleep {
    tokio::time::sleep(budget)
}

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
    matches!(&event.event, OperationEventKind::Message { level, message }
        if level == "error" || (level == "info" && event.parent_operation_id.is_none() && message.len() <= 512))
        && emitted < 32
}

fn boundary_output(event: &portcove_core::OperationEvent, elapsed: Duration) -> serde_json::Value {
    json!({"kind": "operation", "event": event,
        "elapsed_ms": u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)})
}

fn diagnostic_operation_id<'a>(
    selected_stage: Option<(&str, Option<&'a str>)>,
    activity_id: Option<&'a str>,
) -> Option<&'a str> {
    selected_stage
        .and_then(|(_, retained)| retained)
        .or(activity_id)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() == 1 && args[0] == "--qualification-budgets" {
        emit(PortcoveService::qualification_forbidden_memories_budgets())?;
        return Ok(());
    }
    if args.len() == 6 && args[0] == "--supervise-stage" {
        let digest = args[1].to_str().ok_or("digest must be UTF-8")?;
        let stage = args[2].to_str().ok_or("stage must be UTF-8")?;
        let retained = args[3].to_str().ok_or("operation must be UTF-8")?;
        let receipt = PortcoveService::qualification_forbidden_memories_supervise_stage(
            &std::env::current_exe()?,
            digest,
            &PathBuf::from(&args[4]),
            &PathBuf::from(&args[5]),
            stage,
            (retained != "-").then_some(retained),
        )?;
        emit(receipt.clone())?;
        if receipt["process_tree_quiesced"] != true
            || receipt["outcome"]["child_success"] != true
            || receipt["outcome"]["output_truncated"] != false
        {
            return Err("owned producer stage held; preserve all evidence".into());
        }
        return Ok(());
    }
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
    let selected_stage = if args.len() == 5 && args[0] == "--owned-stage" {
        let stage = args[1].to_str().ok_or("stage must be UTF-8")?;
        let retained = args[2].to_str().ok_or("operation must be UTF-8")?;
        Some((stage, (retained != "-").then_some(retained)))
    } else {
        None
    };
    if selected_stage.is_none() && (args.len() != 3 || args[0] != "--owned-child") {
        return Err(
            "requires --supervise <reviewed binary SHA256> <fresh library> <original CHD source>"
                .into(),
        );
    }
    let root = PathBuf::from(&args[if selected_stage.is_some() { 3 } else { 1 }]);
    let source = PathBuf::from(&args[if selected_stage.is_some() { 4 } else { 2 }]);
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
    let reporter_started = std::time::Instant::now();
    let reporter = move |event| {
        capture_root_activity(&event_id, &event);
        event_seen.fetch_add(1, Ordering::Relaxed);
        // Core owns activity and bounded diagnostic evidence.
        // Keep this child's bounded output for boundaries and final result;
        // per-chunk download progress must not displace the terminal receipt.
        if !retain_boundary_event(&event, event_emitted.load(Ordering::Relaxed)) {
            return;
        }
        event_emitted.fetch_add(1, Ordering::Relaxed);
        if let Err(error) = emit(boundary_output(&event, reporter_started.elapsed())) {
            *event_error.lock().expect("output error lock poisoned") = Some(error);
        }
    };
    let operation = async {
        if let Some((stage, retained)) = selected_stage {
            PortcoveService::qualification_forbidden_memories_stage(
                &root, &source, stage, retained, reporter,
            )
            .await
        } else {
            PortcoveService::qualification_forbidden_memories_baseline(&root, &source, reporter)
                .await
                .map(|(_, install)| serde_json::to_value(install))
                .and_then(|value| value.map_err(Into::into))
        }
    };
    tokio::pin!(operation);
    // Construct once before polling the stage: progress never resets this clock.
    let work_cutoff = cooperative_work_cutoff(Duration::from_secs(PREPARATION_SECONDS));
    tokio::pin!(work_cutoff);
    let mut deadline_reached = false;
    let result = tokio::select! {
        result = &mut operation => result,
        _ = &mut work_cutoff => {
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
    let activity_id = operation_id
        .lock()
        .expect("event identity lock poisoned")
        .clone();
    // Retained preparation runs under its original lifecycle identity. The
    // fresh activity still owns cancellation; diagnostics cannot change it.
    let diagnostic_id = diagnostic_operation_id(selected_stage, activity_id.as_deref());
    let preparation_diagnostics =
        diagnostic_id.map(portcove_core::qualification_psx_preparation_diagnostics);
    emit(
        json!({"kind": "terminal", "deadline_reached": deadline_reached,
        "selected_stage": selected_stage.map(|(stage, _)| stage),
        "preparation_diagnostic_operation_id": diagnostic_id,
        "result": result.as_ref().map_err(|error| error.to_string()),
        "preparation_diagnostics": preparation_diagnostics,
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
    fn cooperative_timer_uses_a_short_test_budget_without_changing_policy() {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                cooperative_work_cutoff(Duration::ZERO).await;
            });
        assert_eq!(PREPARATION_SECONDS, 900);
    }

    #[test]
    fn retained_diagnostics_use_lifecycle_identity_without_changing_cancellation() {
        let id = Mutex::new(Some("fresh-activity".to_owned()));
        let activity = id.lock().unwrap();
        assert_eq!(
            diagnostic_operation_id(
                Some(("normalize-inputs", Some("retained-owner"))),
                activity.as_deref()
            ),
            Some("retained-owner")
        );
        assert_eq!(
            diagnostic_operation_id(Some(("acquire", None)), activity.as_deref()),
            Some("fresh-activity")
        );
        assert_eq!(
            diagnostic_operation_id(None, activity.as_deref()),
            Some("fresh-activity")
        );
        assert_eq!(activity.as_deref(), Some("fresh-activity"));
        assert_eq!(diagnostic_operation_id(None, None), None);
    }

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

    #[test]
    fn root_phase_information_is_bounded_and_keeps_its_timing() {
        let mut event: portcove_core::OperationEvent = serde_json::from_value(json!({
            "schema_version": 3, "operation_id": "root", "parent_operation_id": null,
            "sequence": 9, "timestamp_ms": 1000, "operation": "install", "target": null,
            "type": "message", "level": "info", "message": "Generating verified source"
        }))
        .unwrap();
        assert!(retain_boundary_event(&event, 31));
        assert!(!retain_boundary_event(&event, 32));
        let output = boundary_output(&event, Duration::from_millis(5130));
        assert_eq!(output["elapsed_ms"], 5130);
        assert_eq!(output["event"]["timestamp_ms"], 1000);
        event.parent_operation_id = Some("root".into());
        assert!(!retain_boundary_event(&event, 0));
        event.parent_operation_id = None;
        event.event = OperationEventKind::Message {
            level: "info".into(),
            message: "é".repeat(256),
        };
        assert!(retain_boundary_event(&event, 0));
        event.event = OperationEventKind::Message {
            level: "info".into(),
            message: "é".repeat(257),
        };
        assert!(!retain_boundary_event(&event, 0));
    }
}
