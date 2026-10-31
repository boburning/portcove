//! Qualification-only waiting point in a genuine public Core update operation.
//! Start before the renderer, after seed/observer processes have exited. The
//! current-library guard rejects migration; its lease is not the busy witness.
use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
use std::time::Duration;

use async_trait::async_trait;
use portcove_core::{
    ActivityLiveness, ActivityOperation, ActivityRecord, ActivityStatus,
    ApplicationUpdateQuiescenceGuard, CancellationState, DefinitionAcquisitionScope, ErrorCode,
    Library, OperationEvent, OperationEventKind, OperationResult, Platform, PortDefinition,
    PortcoveError, PortcoveService, ReleaseChannel, ReleaseProvider, ResolvedRelease,
    ScopedResolvedRelease,
};
use serde::{Deserialize, Serialize};

const RELEASE_BYTES: u64 = 4096;
const RELEASE_SECONDS: u64 = 300;

#[derive(Default)]
struct DenyProvider(AtomicUsize);

impl DenyProvider {
    fn rejected(&self) -> PortcoveError {
        self.0.fetch_add(1, Ordering::SeqCst);
        PortcoveError::state("qualification update must cancel before provider resolution")
    }
}

#[async_trait]
impl ReleaseProvider for DenyProvider {
    async fn resolve(
        &self,
        _: &PortDefinition,
        _: ReleaseChannel,
        _: Platform,
    ) -> portcove_core::Result<ResolvedRelease> {
        Err(self.rejected())
    }

    async fn resolve_scoped(
        &self,
        _: &PortDefinition,
        _: ReleaseChannel,
        _: Platform,
        _: Option<&DefinitionAcquisitionScope>,
    ) -> portcove_core::Result<ScopedResolvedRelease> {
        Err(self.rejected())
    }
}

#[derive(Serialize)]
struct Ready<'a> {
    schema_version: u32,
    phase: &'static str,
    process_id: u32,
    library: &'a Path,
    port_id: &'a str,
    installation_id: Option<String>,
    activity_id: &'a str,
    activity_liveness: ActivityLiveness,
    nonce: &'a str,
    writer_schema: u32,
    lock_protocol: &'static str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Release {
    schema_version: u32,
    action: String,
    activity_id: String,
    nonce: String,
}

#[derive(Serialize)]
pub(super) struct Completed {
    schema_version: u32,
    phase: &'static str,
    process_id: u32,
    activity: ActivityRecord,
    finished_event: OperationEvent,
    cancellation_acknowledged: CancellationState,
    provider_polls: usize,
    library_idle: bool,
}

fn validate_release(bytes: &[u8], ready: &Ready<'_>) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() as u64 > RELEASE_BYTES || !bytes.ends_with(b"\n") {
        return Err("qualification release is missing, oversized or incomplete".into());
    }
    let release: Release = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if release.schema_version != 1
        || release.action != "cancel-and-release"
        || release.activity_id != ready.activity_id
        || release.nonce != ready.nonce
    {
        return Err("qualification release does not name the held activity".into());
    }
    Ok(())
}

fn await_release(ready: &Ready<'_>) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = std::io::stdin()
            .lock()
            .take(RELEASE_BYTES + 1)
            .read_until(b'\n', &mut bytes)
            .map(|_| bytes)
            .map_err(|error| error.to_string());
        let _ = sender.send(result);
    });
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, ready).map_err(|error| error.to_string())?;
    output
        .write_all(b"\n")
        .and_then(|()| output.flush())
        .map_err(|error| error.to_string())?;
    drop(output);
    let bytes = receiver
        .recv_timeout(Duration::from_secs(RELEASE_SECONDS))
        .map_err(|_| "qualification release window ended".to_owned())??;
    validate_release(&bytes, ready)
}

fn refuse_callback_continuation(message: &str) -> ! {
    eprintln!("{message}; held Core activity has no synthesized terminal outcome");
    std::process::exit(86);
}

async fn hold_update(
    service: &PortcoveService,
    provider: &DenyProvider,
    port: &str,
    nonce: &str,
    mut release: impl FnMut(&Ready<'_>) -> Result<(), String>,
) -> Result<Completed, String> {
    let installation_id = service
        .status(port)
        .map_err(|error| error.to_string())?
        .active
        .map(|record| record.id);
    let mut activity_id = None;
    let mut finished_event = None;
    let mut cancellation_acknowledged = None;
    let result = service
        .update(port, None, None, false, |event| {
            if matches!(event.event, OperationEventKind::Started)
                && event.parent_operation_id.is_none()
            {
                if activity_id.is_some() {
                    refuse_callback_continuation("unexpected second root activity");
                }
                activity_id = Some(event.operation_id.clone());
                let feed = service
                    .library()
                    .activity_feed(0)
                    .unwrap_or_else(|error| refuse_callback_continuation(&error.to_string()));
                let running = feed
                    .records
                    .iter()
                    .find(|record| record.id == event.operation_id)
                    .unwrap_or_else(|| {
                        refuse_callback_continuation("running Core activity missing")
                    });
                if !feed.active_and_actionable_complete
                    || running.status != ActivityStatus::Running
                    || running.operation != ActivityOperation::Update
                    || running.target_id.as_deref() != Some(port)
                    || running.liveness != Some(ActivityLiveness::Active)
                {
                    refuse_callback_continuation(
                        "Core activity identity or continuous ownership differs",
                    );
                }
                let ready = Ready {
                    schema_version: 1,
                    phase: "ready",
                    process_id: std::process::id(),
                    library: service.library().root(),
                    port_id: port,
                    installation_id: installation_id.clone(),
                    activity_id: &event.operation_id,
                    activity_liveness: ActivityLiveness::Active,
                    nonce,
                    writer_schema: portcove_core::LIBRARY_SCHEMA_VERSION,
                    lock_protocol: portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL,
                };
                if let Err(error) = release(&ready) {
                    refuse_callback_continuation(&error);
                }
                cancellation_acknowledged = Some(
                    service
                        .request_cancellation(&event.operation_id)
                        .unwrap_or_else(|error| refuse_callback_continuation(&error.to_string())),
                );
            } else if matches!(
                event.event,
                OperationEventKind::Finished {
                    result: OperationResult::Cancelled
                }
            ) && activity_id.as_deref() == Some(event.operation_id.as_str())
            {
                finished_event = Some(event);
            }
        })
        .await;
    match result {
        Err(error) if error.code == ErrorCode::Cancelled => {}
        Err(error) => {
            return Err(format!(
                "held Core update did not finish cancelled ({:?}): {error}; report={}",
                error.code,
                serde_json::to_string(&error.report()).map_err(|encode| encode.to_string())?
            ));
        }
        Ok(record) => {
            return Err(format!(
                "held Core update unexpectedly succeeded for installation {}",
                record.id
            ));
        }
    }
    let id = activity_id.ok_or("Core update did not emit its root activity")?;
    let activity = service
        .library()
        .activities(64)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|record| record.id == id)
        .ok_or("held activity is missing from Core readback")?;
    let provider_polls = provider.0.load(Ordering::SeqCst);
    if activity.status != ActivityStatus::Cancelled
        || activity.finished_at.is_none()
        || activity.target_id.as_deref() != Some(port)
        || provider_polls != 0
    {
        return Err("held update did not settle before provider acquisition".into());
    }
    service
        .library()
        .require_application_update_idle()
        .map_err(|error| error.to_string())?;
    Ok(Completed {
        schema_version: 1,
        phase: "cancelled",
        process_id: std::process::id(),
        activity,
        finished_event: finished_event.ok_or("Core cancelled Finished event is missing")?,
        cancellation_acknowledged: cancellation_acknowledged
            .ok_or("Core cancellation acknowledgement is missing")?,
        provider_polls,
        library_idle: true,
    })
}

pub(super) async fn hold(
    root: &str,
    port: &str,
    installation: &str,
    nonce: &str,
    schema: &str,
) -> Result<Completed, String> {
    if schema.parse::<u32>().ok() != Some(portcove_core::LIBRARY_SCHEMA_VERSION)
        || nonce.len() != 64
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("qualification schema or nonce differs".into());
    }
    // This must precede renderer launch. Existing Core admission inspects the
    // schema ledger without migrating, then proves no old Core handle/work remains.
    let guard = ApplicationUpdateQuiescenceGuard::acquire(Path::new(root))
        .map_err(|error| error.to_string())?;
    let root = guard.root().to_path_buf();
    drop(guard);
    let provider = Arc::new(DenyProvider::default());
    let service = PortcoveService::with_provider_read_only(
        Library::open(root).map_err(|error| error.to_string())?,
        provider.clone(),
    )
    .map_err(|error| error.to_string())?;
    let active = service
        .status(port)
        .map_err(|error| error.to_string())?
        .active;
    if active
        .as_ref()
        .is_none_or(|record| record.id != installation)
    {
        return Err("qualification requires the exact existing installed game".into());
    }
    hold_update(&service, &provider, port, nonce, await_release).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn release_requires_complete_exact_control() {
        let library = tempfile::tempdir().unwrap();
        let ready = Ready {
            schema_version: 1,
            phase: "ready",
            process_id: 1,
            library: library.path(),
            port_id: "fixture",
            installation_id: None,
            activity_id: "held",
            activity_liveness: ActivityLiveness::Active,
            nonce: NONCE,
            writer_schema: portcove_core::LIBRARY_SCHEMA_VERSION,
            lock_protocol: portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL,
        };
        let valid = serde_json::json!({"schema_version":1,"action":"cancel-and-release","activity_id":"held","nonce":NONCE}).to_string()+"\n";
        validate_release(valid.as_bytes(), &ready).unwrap();
        for invalid in [
            Vec::new(),
            valid.trim_end().as_bytes().to_vec(),
            vec![b'x'; 4097],
            valid.replace("held", "foreign").into_bytes(),
            valid.replace(NONCE, "different").into_bytes(),
            valid.replace("\"action\"", "\"unknown\"").into_bytes(),
        ] {
            assert!(validate_release(&invalid, &ready).is_err());
        }
    }

    #[tokio::test]
    async fn genuine_core_activity_is_busy_then_cancelled_before_provider_poll() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        let provider = Arc::new(DenyProvider::default());
        let service = PortcoveService::with_provider_read_only(library, provider.clone()).unwrap();
        let completed = hold_update(
            &service,
            &provider,
            "opentyrian-opentyrian",
            NONCE,
            |ready| {
                let problem = service
                    .library()
                    .require_application_update_idle()
                    .unwrap_err();
                assert_eq!(problem.code, ErrorCode::Conflict);
                assert_eq!(
                    problem.details.get("activity_id").map(String::as_str),
                    Some(ready.activity_id)
                );
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(completed.activity.status, ActivityStatus::Cancelled);
        assert_eq!(completed.provider_polls, 0);
        assert!(completed.library_idle);
        // Empty-library control proves Core activity/cancellation only. The
        // native caller separately binds a normal installed game and its bytes.
        assert!(completed.activity.finished_at.is_some());
    }
}
