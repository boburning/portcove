use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct ReleaseBlockingPool(Option<std::sync::mpsc::Sender<()>>);

impl ReleaseBlockingPool {
    fn release(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

impl Drop for ReleaseBlockingPool {
    fn drop(&mut self) {
        self.release();
    }
}

#[test]
fn network_download_cancellation_drains_queued_file_write_before_returning() {
    queued_file_write(true);
}

#[test]
fn network_download_success_drains_queued_file_write_before_returning() {
    queued_file_write(false);
}

fn queued_file_write(cancel: bool) {
    // Drop the runtime (and join its blocking workers) before removing the fixture.
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = Arc::new(crate::PortcoveService::new(library.clone()).unwrap());
    let (activity, operation) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::Install,
            crate::ActivityTargetKind::Port,
            Some("sample"),
        )
        .unwrap();
    let staging = library.staging_dir().join(&activity.id);
    fs::create_dir_all(&staging).unwrap();
    let destination = staging.join("artifact.download");
    let unaffected = library.root().join("unaffected-retained-file");
    fs::write(&unaffected, b"preserve unrelated bytes").unwrap();
    let mut record =
        LifecycleOperation::new(&activity.id, LifecycleOperationKind::Install, "sample");
    record.paths.staging = Some(staging.clone());
    let store = OperationStore::new(library.clone());
    store.put(&mut record).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(30), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let (body_sender, body_receiver) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    assert!(request.len() < 8192);
                    request.push(stream.read_u8().await.unwrap());
                }
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
                body_receiver.await.unwrap();
                stream.write_all(b"x").await.unwrap();
            });
            let asset = ReleaseAsset {
                name: "inert.download".into(),
                url: format!("http://{address}/inert.download"),
                size: 1,
                sha256: hex::encode(Sha256::digest(b"x")),
            };
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let (progress_sender, progress_receiver) = tokio::sync::oneshot::channel();
            let mut progress_sender = Some(progress_sender);
            let cancellation_service = service.clone();
            let id = activity.id.clone();
            let output = destination.clone();
            let download = tokio::spawn(async move {
                Installer::download_with_client(
                    &client,
                    &asset,
                    &output,
                    &operation,
                    &mut |event| {
                        if matches!(event.event, crate::OperationEventKind::Progress { .. }) {
                            if cancel {
                                cancellation_service.request_cancellation(&id).unwrap();
                            }
                            if let Some(sender) = progress_sender.take() {
                                let _ = sender.send(());
                            }
                        }
                    },
                )
                .await
            });
            // Let File::create complete before occupying this runtime's only
            // blocking worker. The server still withholds all response bytes.
            while !destination.exists() {
                tokio::task::yield_now().await;
            }
            let (entered_sender, entered_receiver) = tokio::sync::oneshot::channel();
            let (release_sender, release_receiver) = std::sync::mpsc::channel();
            let mut release = ReleaseBlockingPool(Some(release_sender));
            let blocker = tokio::task::spawn_blocking(move || {
                let _ = entered_sender.send(());
                release_receiver.recv_timeout(Duration::from_secs(30))
            });
            entered_receiver.await.unwrap();
            body_sender.send(()).unwrap();
            progress_receiver.await.unwrap();
            // This latches the write QUEUED before worker start, not a write
            // already executing in an OS syscall. Tokio accepted the real byte,
            // while the occupied pool prevents its actual file write completing.
            let returned_before_drain = download.is_finished();
            let unwritten_bytes = fs::metadata(&destination).unwrap().len();
            let staging_before_drain = staging.is_dir();
            let journal_before_drain = store.get(&activity.id).unwrap().is_some();
            let status_before_drain = library
                .activity_feed(1)
                .unwrap()
                .records
                .into_iter()
                .find(|entry| entry.id == activity.id)
                .unwrap()
                .status;
            // Release and join before behavioral assertions; the RAII release
            // also runs during setup failure/timeout, before runtime shutdown.
            release.release();
            let blocker_result = blocker.await.unwrap();
            let result = download.await.unwrap();
            server.await.unwrap();
            eprintln!("queued write witness: cancel={cancel}, returned_before_drain={returned_before_drain}, unwritten_bytes={unwritten_bytes}, staging={staging_before_drain}, journal={journal_before_drain}, status={status_before_drain:?}, released_and_joined={}", blocker_result.is_ok());
            assert!(blocker_result.is_ok(), "pool latch expired instead of release");
            assert!(!returned_before_drain, "transfer returned with actual disk I/O queued");
            assert_eq!(unwritten_bytes, 0);
            assert!(staging_before_drain && journal_before_drain);
            assert_eq!(status_before_drain, crate::ActivityStatus::Running);
            assert_eq!(fs::read(&destination).unwrap(), b"x");
            if cancel {
                assert_eq!(result.as_ref().unwrap_err().code, crate::ErrorCode::Cancelled);
                crate::cancellation::discard_private_install(&library, &record).unwrap();
                assert!(!staging.exists());
                assert!(store.get(&activity.id).unwrap().is_none());
            } else {
                result.as_ref().unwrap();
            }
            let result = service.finish_activity(activity.clone(), result);
            assert_eq!(result.is_err(), cancel);
            let terminal = library
                .activity_feed(1)
                .unwrap()
                .records
                .into_iter()
                .find(|entry| entry.id == activity.id)
                .unwrap();
            assert_eq!(terminal.status, if cancel { crate::ActivityStatus::Cancelled } else { crate::ActivityStatus::Succeeded });
            assert_eq!(fs::read(&unaffected).unwrap(), b"preserve unrelated bytes");
        })
        .await
        .expect("queued writer fixture exceeded thirty seconds");
    });
}
