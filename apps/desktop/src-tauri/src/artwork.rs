//! Native adapter for core-owned local artwork; no image or selection policy.
use crate::{DesktopResult, DesktopState, blocking_worker, service_at_generation};
use base64::Engine as _;
use portcove_core::{ArtworkResolvedSource, ArtworkSlot, ArtworkState, ArtworkThumbnail};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};
use tokio::sync::Semaphore;

fn remote_thumbnail_workers() -> Arc<Semaphore> {
    static WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    Arc::clone(
        WORKERS.get_or_init(|| Arc::new(Semaphore::new(portcove_core::IGDB_ARTWORK_WORK_LIMIT))),
    )
}

async fn thumbnail_worker<T, F>(
    workers: Arc<Semaphore>,
    remote: bool,
    operation: F,
) -> DesktopResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> DesktopResult<T> + Send + 'static,
{
    // Await remote admission before occupying the shared blocking pool. Local
    // thumbnails and choice mutations do not wait behind slow CDN requests.
    let permit =
        if remote {
            Some(workers.acquire_owned().await.map_err(|_| {
                portcove_core::PortcoveError::state("cover workers are unavailable")
            })?)
        } else {
            None
        };
    blocking_worker(move || {
        // Cancellation of an IPC waiter must not release capacity while its
        // already-dispatched blocking operation is still running.
        let _permit = permit;
        operation()
    })
    .await
}

#[derive(Serialize)]
pub(crate) struct DesktopArtworkThumbnail {
    asset_sha256: String,
    choice_revision: u64,
    png_base64: String,
}

fn display_thumbnail(thumbnail: ArtworkThumbnail) -> DesktopArtworkThumbnail {
    DesktopArtworkThumbnail {
        asset_sha256: thumbnail.asset_sha256,
        choice_revision: thumbnail.choice_revision,
        png_base64: base64::engine::general_purpose::STANDARD.encode(thumbnail.png),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::{Future, poll_fn},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        task::Poll,
        time::Duration,
    };

    #[test]
    fn display_thumbnail_preserves_identity_and_bytes_without_changing_core_shape() {
        let core = ArtworkThumbnail {
            asset_sha256: "a".repeat(64),
            choice_revision: 7,
            png: vec![137, 80, 78, 71],
        };
        let display = display_thumbnail(core);
        assert_eq!(display.asset_sha256, "a".repeat(64));
        assert_eq!(display.choice_revision, 7);
        assert_eq!(display.png_base64, "iVBORw==");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(display.png_base64)
                .unwrap(),
            [137, 80, 78, 71]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn remote_thumbnail_waiters_leave_local_and_unrelated_workers_available() {
        let limit = portcove_core::IGDB_ARTWORK_WORK_LIMIT;
        let workers = Arc::new(Semaphore::new(limit));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut releases = Vec::new();
        let mut running = Vec::new();
        for _ in 0..limit {
            let (started, observed_start) = tokio::sync::oneshot::channel();
            let (release, released) = mpsc::channel();
            releases.push(release);
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            running.push(tokio::spawn(thumbnail_worker(
                Arc::clone(&workers),
                true,
                move || {
                    maximum.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    let _ = started.send(());
                    let result = released.recv_timeout(Duration::from_secs(15));
                    active.fetch_sub(1, Ordering::SeqCst);
                    result
                        .map_err(|error| portcove_core::PortcoveError::state(error.to_string()))?;
                    Ok(())
                },
            )));
            tokio::time::timeout(Duration::from_secs(5), observed_start)
                .await
                .unwrap()
                .unwrap();
        }
        let queued_active = Arc::clone(&active);
        let queued_maximum = Arc::clone(&maximum);
        let mut queued = Box::pin(thumbnail_worker(Arc::clone(&workers), true, move || {
            queued_maximum.fetch_max(
                queued_active.fetch_add(1, Ordering::SeqCst) + 1,
                Ordering::SeqCst,
            );
            queued_active.fetch_sub(1, Ordering::SeqCst);
            Ok(11_u8)
        }));
        poll_fn(|context| {
            assert!(queued.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;

        let local = thumbnail_worker(Arc::clone(&workers), false, || Ok(7_u8));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), local)
                .await
                .unwrap()
                .unwrap(),
            7
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), blocking_worker(|| Ok(9_u8)))
                .await
                .unwrap()
                .unwrap(),
            9
        );
        assert_eq!(active.load(Ordering::SeqCst), limit);
        for release in releases {
            release.send(()).unwrap();
        }
        for worker in running {
            worker.await.unwrap().unwrap();
        }
        assert_eq!(queued.await.unwrap(), 11);
        assert_eq!(maximum.load(Ordering::SeqCst), limit);
        assert_eq!(workers.available_permits(), limit);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_thumbnail_waiter_retains_admission_until_worker_finishes() {
        let workers = Arc::new(Semaphore::new(1));
        let (started, observed_start) = tokio::sync::oneshot::channel();
        let (release, released) = mpsc::channel();
        let waiter = tokio::spawn(thumbnail_worker(Arc::clone(&workers), true, move || {
            let _ = started.send(());
            released
                .recv_timeout(Duration::from_secs(15))
                .map_err(|error| portcove_core::PortcoveError::state(error.to_string()))?;
            Ok(())
        }));
        tokio::time::timeout(Duration::from_secs(5), observed_start)
            .await
            .unwrap()
            .unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert_eq!(workers.available_permits(), 0);
        let mut next = Box::pin(thumbnail_worker(Arc::clone(&workers), true, || Ok(3_u8)));
        poll_fn(|context| {
            assert!(next.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        release.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), next)
                .await
                .unwrap()
                .unwrap(),
            3
        );
        assert_eq!(workers.available_permits(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_thumbnail_worker_releases_remote_admission() {
        let workers = Arc::new(Semaphore::new(1));
        let error = thumbnail_worker::<(), _>(Arc::clone(&workers), true, || {
            Err(portcove_core::PortcoveError::conflict("stale choice").into())
        })
        .await
        .unwrap_err();
        assert_eq!(error.code, portcove_core::ErrorCode::Conflict);
        assert_eq!(workers.available_permits(), 1);
        assert_eq!(
            thumbnail_worker(Arc::clone(&workers), true, || Ok(5_u8))
                .await
                .unwrap(),
            5
        );
        assert_eq!(workers.available_permits(), 1);
    }
}

#[tauri::command]
pub(crate) async fn get_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    generation: u64,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .artwork(&port_id, slot)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_artwork_thumbnail(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    expected_revision: u64,
    generation: u64,
) -> DesktopResult<DesktopArtworkThumbnail> {
    let state = state.inner().clone();
    let resolution_state = state.clone();
    let resolution_port = port_id.clone();
    let remote = blocking_worker(move || {
        let resolved = service_at_generation(&resolution_state, generation)?
            .artwork(&resolution_port, slot)?;
        Ok(matches!(
            resolved.resolved_source,
            ArtworkResolvedSource::IgdbCover { .. }
        ))
    })
    .await?;
    thumbnail_worker(remote_thumbnail_workers(), remote, move || {
        // Admission may wait across a library switch or a changed selection.
        // Resolve the current generation again; Core checks the slot revision.
        service_at_generation(&state, generation)?
            .artwork_thumbnail(&port_id, slot, expected_revision)
            .map(display_thumbnail)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn import_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    path: PathBuf,
    expected_revision: u64,
    generation: u64,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .import_artwork(&port_id, slot, &path, expected_revision)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn reset_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    expected_revision: u64,
    generation: u64,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .reset_artwork(&port_id, slot, expected_revision)
            .map_err(Into::into)
    })
    .await
}
