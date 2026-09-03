use super::*;
use crate::{
    InstallQualification, InstallRequest, Installer, OperationResult, ReleaseAsset, ReleaseChannel,
    ResolvedRelease,
    operation::{LifecycleFaultInjector, LifecycleFaultPoint},
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Barrier},
    thread,
};

fn service() -> (tempfile::TempDir, Arc<PortcoveService>) {
    let temporary = tempfile::tempdir().unwrap();
    let service = PortcoveService::new(Library::open(temporary.path()).unwrap()).unwrap();
    (temporary, Arc::new(service))
}

#[test]
fn request_and_publication_admission_have_exactly_one_winner() {
    let (_temporary, service) = service();
    for _ in 0..16 {
        let (activity, operation) = service
            .begin_cancellable_activity(
                ActivityOperation::Install,
                ActivityTargetKind::Library,
                None,
            )
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let requester = service.clone();
        let request_barrier = barrier.clone();
        let id = activity.id.clone();
        let request = thread::spawn(move || {
            request_barrier.wait();
            requester.request_cancellation(&id)
        });
        barrier.wait();
        let publication = operation.begin_publication();
        let requested = request.join().unwrap();
        assert_ne!(publication.is_ok(), requested.is_ok());
        if let Err(error) = &publication {
            assert_eq!(error.code, ErrorCode::Cancelled);
        }
        let result = service.finish_activity(activity.clone(), publication);
        assert_eq!(
            OperationResult::from_result(&result),
            if requested.is_ok() {
                OperationResult::Cancelled
            } else {
                OperationResult::Succeeded
            }
        );
        assert!(service.request_cancellation(&activity.id).is_err());
    }
}

#[tokio::test]
async fn pending_network_wait_is_cancelled_and_recorded_without_stealing_a_live_worker() {
    let (_temporary, service) = service();
    let (activity, operation) = service
        .begin_cancellable_activity(
            ActivityOperation::CheckUpdate,
            ActivityTargetKind::Port,
            Some("ship-of-harkinian"),
        )
        .unwrap();
    let observer = PortcoveService::new(service.library().clone()).unwrap();
    assert_eq!(
        observer.library().activities(1).unwrap()[0].status,
        ActivityStatus::Running
    );
    let (result, _) = tokio::join!(
        operation.interruptible(std::future::pending::<Result<()>>()),
        async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            observer.request_cancellation(&activity.id).unwrap();
        },
    );
    let result = service.finish_activity(activity.clone(), result);
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    let recorded = observer.library().activities(1).unwrap().remove(0);
    assert_eq!(recorded.id, activity.id);
    assert_eq!(recorded.status, ActivityStatus::Cancelled);
    assert!(recorded.finished_at.is_some());
    assert!(recorded.cancellation.is_none());
}

#[test]
fn host_cancellation_is_owner_scoped_and_also_stops_queued_work() {
    let (_temporary, first) = service();
    let second = PortcoveService::new(first.library().clone()).unwrap();
    let (first_activity, first_operation) = first
        .begin_cancellable_activity(
            ActivityOperation::CheckUpdate,
            ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    let (second_activity, second_operation) = second
        .begin_cancellable_activity(
            ActivityOperation::CheckUpdate,
            ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    assert_eq!(first.request_owned_cancellations().unwrap(), (1, 0));
    assert_eq!(
        first_operation.begin_publication().unwrap_err().code,
        ErrorCode::Cancelled
    );
    second_operation.begin_publication().unwrap();
    second.finish_activity(second_activity, Ok(())).unwrap();
    let (queued, queued_operation) = first
        .begin_cancellable_activity(
            ActivityOperation::CheckUpdate,
            ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    assert_eq!(
        queued_operation.begin_publication().unwrap_err().code,
        ErrorCode::Cancelled
    );
    let _ = first.finish_activity(queued, queued_operation.begin_publication());
    let _ = first.finish_activity(first_activity, first_operation.begin_publication());
}

#[test]
fn interrupted_requested_preparation_is_discarded_without_touching_user_data() {
    let (_temporary, service) = service();
    let (activity, operation) = service
        .begin_cancellable_activity(
            ActivityOperation::Install,
            ActivityTargetKind::Port,
            Some("sample"),
        )
        .unwrap();
    let mut intent =
        LifecycleOperation::new(&activity.id, LifecycleOperationKind::Install, "sample");
    let staging = service.library().staging_dir().join(&activity.id);
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("partial"), b"private").unwrap();
    intent.paths.staging = Some(staging.clone());
    OperationStore::new(service.library().clone())
        .put(&mut intent)
        .unwrap();
    let save = service.library().user_dir("sample").join("save.dat");
    fs::create_dir_all(save.parent().unwrap()).unwrap();
    fs::write(&save, b"keep save").unwrap();
    service.request_cancellation(&activity.id).unwrap();
    drop(operation);
    let recovered = PortcoveService::new(service.library().clone()).unwrap();
    assert!(!staging.exists());
    assert_eq!(fs::read(save).unwrap(), b"keep save");
    assert!(
        OperationStore::new(recovered.library().clone())
            .all()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        recovered.library().activities(1).unwrap()[0].status,
        ActivityStatus::Cancelled
    );
}

struct CancelAt {
    service: Arc<PortcoveService>,
    id: String,
    point: LifecycleFaultPoint,
    accepted: bool,
}
impl LifecycleFaultInjector for CancelAt {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == self.point {
            assert_eq!(
                self.service.request_cancellation(&self.id).is_ok(),
                self.accepted
            );
        }
        Ok(())
    }
}

#[tokio::test]
async fn cancellation_before_prepared_cleans_private_data_and_after_prepared_finishes_publication()
{
    for (point, accepted) in [
        (LifecycleFaultPoint::InstallReadyToPublish, true),
        (LifecycleFaultPoint::InstallPrepared, false),
        (LifecycleFaultPoint::InstallPublished, false),
    ] {
        let (temporary, service) = service();
        let archive = temporary.path().join("synthetic.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        writer
            .start_file("sample.exe", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"synthetic executable").unwrap();
        writer.finish().unwrap();
        let bytes = fs::read(archive).unwrap();
        let asset = ReleaseAsset {
            name: "synthetic.zip".into(),
            url: String::new(),
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(&bytes)),
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            let _ = connection.read(&mut [0_u8; 4096]);
            write!(
                connection,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            connection.write_all(&bytes).unwrap();
        });
        let (activity, operation) = service
            .begin_cancellable_activity(
                ActivityOperation::Install,
                ActivityTargetKind::Port,
                Some("sample"),
            )
            .unwrap();
        let installer = Installer::with_faults(
            service.library().clone(),
            Arc::new(CancelAt {
                service: service.clone(),
                id: activity.id.clone(),
                point,
                accepted,
            }),
        )
        .unwrap();
        let result = installer
            .install(
                InstallRequest {
                    port_id: "sample".into(),
                    release: ResolvedRelease {
                        version: "v1".into(),
                        channel: ReleaseChannel::Stable,
                        published_at: None,
                        asset: ReleaseAsset {
                            url: format!("http://{address}/synthetic.zip"),
                            ..asset
                        },
                    },
                    activate: true,
                    managed: None,
                    qualification: InstallQualification::test("sample.exe"),
                },
                &operation,
                |_| {},
            )
            .await;
        let result = service.finish_activity(activity, result);
        server.join().unwrap();
        if accepted {
            assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        } else {
            assert!(installer.verify(&result.unwrap()).unwrap().valid);
        }
        assert_eq!(
            service.library().all_installs().unwrap().len(),
            usize::from(!accepted)
        );
        assert!(
            OperationStore::new(service.library().clone())
                .all()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            fs::read_dir(service.library().staging_dir())
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            service.library().activities(1).unwrap()[0].status,
            if accepted {
                ActivityStatus::Cancelled
            } else {
                ActivityStatus::Succeeded
            }
        );
    }
}
