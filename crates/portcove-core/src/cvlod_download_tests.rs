use super::*;
use std::{
    future::Future,
    io::Write,
    pin::Pin,
    sync::{Condvar, Mutex},
    task::{Context, Poll},
};
use tokio::{io::AsyncWrite, sync::oneshot};

type Events = Arc<Mutex<Vec<&'static str>>>;

struct ReleaseLatch(Arc<(Mutex<bool>, Condvar)>);
impl Drop for ReleaseLatch {
    fn drop(&mut self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }
}

// Like Tokio File, this queues a real blocking file mutation and acknowledges
// the write before that mutation finishes. Flush is the joining boundary.
struct LatchedWriter {
    file: Option<fs::File>,
    worker: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    latch: Arc<(Mutex<bool>, Condvar)>,
    started: Option<oneshot::Sender<()>>,
    flushing: Option<oneshot::Sender<()>>,
    events: Events,
    fail_flush: bool,
}

impl AsyncWrite for LatchedWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let mut file = self.file.take().expect("one admitted chunk");
        let bytes = bytes.to_vec();
        let count = bytes.len();
        let latch = self.latch.clone();
        let events = self.events.clone();
        let started = self.started.take().unwrap();
        self.worker = Some(tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            let mut released = latch.0.lock().unwrap();
            while !*released {
                released = latch.1.wait(released).unwrap();
            }
            drop(released);
            file.write_all(&bytes)?;
            file.sync_all()?;
            events.lock().unwrap().push("worker-exited");
            Ok(())
        }));
        Poll::Ready(Ok(count))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        if let Some(flushing) = self.flushing.take() {
            let _ = flushing.send(());
        }
        if let Some(worker) = self.worker.as_mut() {
            match Pin::new(worker).poll(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(result) => {
                    self.worker = None;
                    result.map_err(std::io::Error::other)??;
                    self.events.lock().unwrap().push("flush-completed");
                }
            }
        }
        Poll::Ready(if self.fail_flush {
            Err(std::io::Error::other("fixture ambiguous drain"))
        } else {
            Ok(())
        })
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.poll_flush(cx)
    }
}

#[derive(Clone, Copy, Debug)]
enum Exit {
    Cancel,
    Stream,
    Digest,
    Oversize,
    Success,
}

#[test]
fn cvlod_build_original_is_critical_and_working_rom_remains_persistent() {
    let mut port = crate::Catalog::embedded()
        .unwrap()
        .port("cvlod-recomp")
        .unwrap()
        .clone();
    let recipe = crate::CartridgeBuildRecipe::CvlodSourceV1;
    port.release
        .managed_build
        .insert(Platform::WindowsX86_64, recipe);
    port.runtime_source_hashes.insert(
        "rom.z64".into(),
        "89e15df6042defddc48c61f7408f99d06fffdb845e2422cf8b5ba8e73d4d70fb".into(),
    );
    port.windows_runtime_path_policy = Some(crate::WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
    let qualification = InstallQualification::from_port(&port, Platform::WindowsX86_64).unwrap();
    assert!(
        qualification
            .persistent_paths
            .iter()
            .any(|path| path == "rom.z64")
    );
    assert!(
        qualification
            .critical_paths
            .iter()
            .any(|path| path == recipe.original_filename())
    );
    assert!(
        qualification
            .critical_paths
            .iter()
            .any(|path| path == crate::cartridge_build::RECEIPT)
    );
    assert!(
        !qualification
            .critical_paths
            .iter()
            .any(|path| path == "rom.z64")
    );
    assert_ne!(recipe.original_filename(), "rom.z64");
}

async fn cvlod_blob_case(exit: Exit, fail_flush: bool) {
    eprintln!("CVLoD drain fixture start: {exit:?}, fail_flush={fail_flush}");
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    let (activity, operation) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::Install,
            crate::ActivityTargetKind::Port,
            Some("sample"),
        )
        .unwrap();
    let staging = library.staging_dir().join(&activity.id);
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("owned-input"), b"retained private bytes").unwrap();
    let mut record =
        LifecycleOperation::new(&activity.id, LifecycleOperationKind::Install, "sample");
    record.paths.staging = Some(staging.clone());
    let store = OperationStore::new(library.clone());
    store.put(&mut record).unwrap();
    let mut lifecycle = InstallLifecycle {
        destination: staging.join("unused"),
        operation_root: staging.clone(),
        store: store.clone(),
        record,
    };
    let latch = Arc::new((Mutex::new(false), Condvar::new()));
    let release = ReleaseLatch(latch.clone());
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let (started, started_rx) = oneshot::channel();
    let (flushing, flushing_rx) = oneshot::channel();
    let mut writer = LatchedWriter {
        file: Some(fs::File::create(staging.join("download")).unwrap()),
        worker: None,
        latch,
        started: Some(started),
        flushing: Some(flushing),
        events: events.clone(),
        fail_flush,
    };
    let asset = ReleaseAsset {
        name: "fixture".into(),
        url: "https://example.invalid/fixture".into(),
        size: 5,
        sha256: if matches!(exit, Exit::Digest) {
            "0".repeat(64)
        } else {
            hex::encode(Sha256::digest(b"bytes"))
        },
    };
    let tail: Pin<
        Box<dyn futures_util::Stream<Item = std::result::Result<Vec<u8>, String>> + Send>,
    > = match exit {
        Exit::Cancel => Box::pin(futures_util::stream::pending()),
        Exit::Stream => Box::pin(futures_util::stream::iter([Err(
            "fixture stream failure".into()
        )])),
        Exit::Oversize => Box::pin(futures_util::stream::iter([Ok(vec![0])])),
        _ => Box::pin(futures_util::stream::empty()),
    };
    let stream = futures_util::stream::iter([Ok(b"bytes".to_vec())]).chain(tail);
    let worker_events = events.clone();
    let worker_library = library.clone();
    let pending = tokio::spawn(async move {
        let result = run_cvlod_blob_transfer(&mut lifecycle, async {
            let outcome = write_cvlod_blob_stream(stream, &mut writer, &asset, &operation).await;
            worker_events.lock().unwrap().push("helper-return");
            (outcome.result.map(|_| ()), outcome.drained)
        })
        .await;
        worker_events.lock().unwrap().push("transfer-return");
        let proof = lifecycle.record.preparation_process_quiesced;
        let cleanup =
            crate::cancellation::discard_private_install(&worker_library, &lifecycle.record);
        worker_events.lock().unwrap().push("cleanup-attempt");
        (result, cleanup, proof)
    });
    tokio::time::timeout(Duration::from_secs(5), started_rx)
        .await
        .unwrap()
        .unwrap();
    eprintln!("worker started");
    if matches!(exit, Exit::Cancel) {
        service.request_cancellation(&activity.id).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(5), flushing_rx)
        .await
        .unwrap()
        .unwrap();
    eprintln!("flush entered");
    let finished_early = pending.is_finished();
    let before = store
        .get(&activity.id)
        .unwrap()
        .unwrap()
        .preparation_process_quiesced;
    let input_before = fs::read(staging.join("owned-input")).unwrap();
    drop(release);
    eprintln!("worker released");
    let (result, cleanup, proof) = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap();
    eprintln!("transfer and cleanup returned");
    assert!(!finished_early, "{exit:?}");
    assert_eq!(before, Some(false));
    assert_eq!(input_before, b"retained private bytes");
    assert_eq!(proof, Some(!fail_flush));
    let expected = match exit {
        Exit::Cancel => Some(crate::ErrorCode::Cancelled),
        Exit::Stream => Some(crate::ErrorCode::Network),
        Exit::Digest | Exit::Oversize => Some(crate::ErrorCode::Verification),
        Exit::Success if fail_flush => Some(crate::ErrorCode::Install),
        Exit::Success => None,
    };
    assert_eq!(result.as_ref().err().map(|error| error.code), expected);
    if fail_flush {
        assert!(
            result
                .unwrap_err()
                .details
                .contains_key("cvlod_blob_drain_error")
        );
    }
    assert_eq!(cleanup.is_ok(), !fail_flush);
    assert_eq!(staging.exists(), fail_flush);
    assert_eq!(store.get(&activity.id).unwrap().is_some(), fail_flush);
    assert!(!staging.join("unused").exists());
    assert_eq!(
        *events.lock().unwrap(),
        [
            "worker-exited",
            "flush-completed",
            "helper-return",
            "transfer-return",
            "cleanup-attempt"
        ]
    );
}

// Separate cases keep each complete lifecycle within the ordinary finite harness
// budget and identify the exact exit path if a worker/cleanup boundary stalls.
#[tokio::test]
async fn cvlod_blob_cancel_drains_before_cleanup() {
    cvlod_blob_case(Exit::Cancel, false).await;
}
#[tokio::test]
async fn cvlod_blob_stream_error_drains_before_cleanup() {
    cvlod_blob_case(Exit::Stream, false).await;
}
#[tokio::test]
async fn cvlod_blob_digest_refusal_drains_before_cleanup() {
    cvlod_blob_case(Exit::Digest, false).await;
}
#[tokio::test]
async fn cvlod_blob_oversize_refusal_drains_before_cleanup() {
    cvlod_blob_case(Exit::Oversize, false).await;
}
#[tokio::test]
async fn cvlod_blob_success_drains_before_cleanup() {
    cvlod_blob_case(Exit::Success, false).await;
}
#[tokio::test]
async fn cvlod_blob_cancel_and_ambiguous_drain_retains_private_state() {
    cvlod_blob_case(Exit::Cancel, true).await;
}
#[tokio::test]
async fn cvlod_blob_stream_error_and_ambiguous_drain_retains_private_state() {
    cvlod_blob_case(Exit::Stream, true).await;
}
#[tokio::test]
async fn cvlod_blob_success_and_ambiguous_drain_retains_private_state() {
    cvlod_blob_case(Exit::Success, true).await;
}
