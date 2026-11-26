//! Native adapter for core-owned local artwork; no image or selection policy.
use crate::{
    DesktopResult, DesktopState, blocking_worker, desktop_contract::DesktopArtworkSelectionPreview,
    initialization_snapshot, library_at_generation, service_at_generation, state_generation,
};
use base64::Engine as _;
use portcove_core::{
    ARTWORK_CACHE_MISS, ARTWORK_RETRY, ArtworkFraming, ArtworkResolvedSource,
    ArtworkSelectionFraming, ArtworkSelectionPreview, ArtworkSlot, ArtworkState, ArtworkThumbnail,
    PortcoveService,
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};
use tokio::sync::Semaphore;

pub(crate) fn remote_thumbnail_workers() -> Arc<Semaphore> {
    static WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    Arc::clone(
        WORKERS.get_or_init(|| Arc::new(Semaphore::new(portcove_core::IGDB_ARTWORK_WORK_LIMIT))),
    )
}

pub(crate) async fn thumbnail_worker<T, F>(
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
    let queued = std::time::Instant::now();
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
        tracing::debug!(
            elapsed_us = queued.elapsed().as_micros() as u64,
            remote,
            message = "Artwork thumbnail worker admission"
        );
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
    let started = std::time::Instant::now();
    let input_bytes = thumbnail.png.len() as u64;
    let png_base64 = base64::engine::general_purpose::STANDARD.encode(thumbnail.png);
    tracing::debug!(
        elapsed_us = started.elapsed().as_micros() as u64,
        input_bytes,
        output_bytes = png_base64.len() as u64,
        message = "Artwork thumbnail encoding"
    );
    DesktopArtworkThumbnail {
        asset_sha256: thumbnail.asset_sha256,
        choice_revision: thumbnail.choice_revision,
        png_base64,
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

fn artwork_service_at_generation(
    state: &DesktopState,
    generation: u64,
) -> DesktopResult<PortcoveService> {
    let (ready, actual) = initialization_snapshot(state);
    crate::require_library_generation(actual, generation)?;
    let ready = ready?;
    let service = PortcoveService::with_provider_for_artwork(ready.library, ready.releases)?;
    crate::require_library_generation(state_generation(state), generation)?;
    Ok(service)
}

#[tauri::command]
pub(crate) async fn get_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    generation: u64,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    let generation_state = state.clone();
    let result = blocking_worker(move || {
        let started = std::time::Instant::now();
        let artwork = artwork_service_at_generation(&state, generation)?.artwork(&port_id, slot);
        tracing::debug!(
            elapsed_us = started.elapsed().as_micros() as u64,
            success = artwork.is_ok(),
            message = "Artwork state read"
        );
        artwork.map_err(Into::into)
    })
    .await?;
    crate::require_library_generation(state_generation(&generation_state), generation)?;
    Ok(result)
}

async fn artwork_thumbnail_at_generation<F>(
    state: DesktopState,
    generation: u64,
    cache_only: bool,
    cache_epoch: Option<String>,
    operation: F,
) -> DesktopResult<DesktopArtworkThumbnail>
where
    F: Fn(&PortcoveService) -> portcove_core::Result<ArtworkThumbnail> + Send + Sync + 'static,
{
    static CACHE_WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let workers = CACHE_WORKERS
        .get_or_init(|| Arc::new(Semaphore::new(portcove_core::IGDB_ARTWORK_WORK_LIMIT)));
    let library = library_at_generation(&state, generation)?;
    let epoch = blocking_worker(move || library.artwork_cache_epoch().map_err(Into::into)).await?;
    if cache_epoch.is_some_and(|expected| expected != epoch.token()) {
        return Err(portcove_core::PortcoveError::conflict(
            "the artwork cache was cleared during retrieval",
        )
        .into());
    }
    let operation = Arc::new(operation);
    let cache_state = state.clone();
    let cached_operation = operation.clone();
    let cached = thumbnail_worker(workers.clone(), true, move || {
        let service = artwork_service_at_generation(&cache_state, generation)?
            .with_artwork_cache_epoch(epoch, false);
        cached_operation(&service)
            .map(display_thumbnail)
            .map_err(Into::into)
    })
    .await;
    let result = match cached {
        Err(error) if !cache_only && error.details.contains_key(ARTWORK_CACHE_MISS) => {
            let download_state = state.clone();
            thumbnail_worker(remote_thumbnail_workers(), true, move || {
                let service = artwork_service_at_generation(&download_state, generation)?
                    .with_artwork_cache_epoch(epoch, true);
                operation(&service)
                    .map(display_thumbnail)
                    .map_err(Into::into)
            })
            .await
        }
        result => result,
    };
    let thumbnail = result.map_err(|mut error| {
        if error.details.contains_key(ARTWORK_CACHE_MISS)
            || error.details.contains_key(ARTWORK_RETRY)
        {
            error
                .details
                .insert("artwork_cache_epoch".into(), epoch.token());
        }
        error
    })?;
    crate::require_library_generation(state_generation(&state), generation)?;
    Ok(thumbnail)
}

#[tauri::command]
pub(crate) async fn get_artwork_thumbnail(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    expected_revision: u64,
    generation: u64,
    cache_only: Option<bool>,
    cache_epoch: Option<String>,
) -> DesktopResult<DesktopArtworkThumbnail> {
    artwork_thumbnail_at_generation(
        state.inner().clone(),
        generation,
        cache_only.unwrap_or(false),
        cache_epoch,
        move |service| service.artwork_thumbnail(&port_id, slot, expected_revision),
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_collection_cover_thumbnail(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_sha256: String,
    expected_revision: u64,
    generation: u64,
    cache_only: Option<bool>,
    cache_epoch: Option<String>,
) -> DesktopResult<DesktopArtworkThumbnail> {
    artwork_thumbnail_at_generation(
        state.inner().clone(),
        generation,
        cache_only.unwrap_or(false),
        cache_epoch,
        move |service| {
            service.collection_cover_thumbnail(&port_id, &expected_sha256, expected_revision)
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_companion_cover_thumbnail(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_primary_cache_id: String,
    expected_sha256: String,
    expected_revision: u64,
    generation: u64,
    cache_only: Option<bool>,
    cache_epoch: Option<String>,
) -> DesktopResult<DesktopArtworkThumbnail> {
    artwork_thumbnail_at_generation(
        state.inner().clone(),
        generation,
        cache_only.unwrap_or(false),
        cache_epoch,
        move |service| {
            service.companion_cover_thumbnail(
                &port_id,
                &expected_primary_cache_id,
                &expected_sha256,
                expected_revision,
            )
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_catalog_media_thumbnail(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    media_id: String,
    expected_sha256: String,
    generation: u64,
    cache_only: Option<bool>,
    cache_epoch: Option<String>,
) -> DesktopResult<DesktopArtworkThumbnail> {
    artwork_thumbnail_at_generation(
        state.inner().clone(),
        generation,
        cache_only.unwrap_or(false),
        cache_epoch,
        move |service| service.catalog_media_thumbnail(&port_id, &media_id, &expected_sha256),
    )
    .await
}

impl From<ArtworkSelectionPreview> for DesktopArtworkSelectionPreview {
    fn from(preview: ArtworkSelectionPreview) -> Self {
        Self {
            original_sha256: preview.original_sha256,
            png_base64: base64::engine::general_purpose::STANDARD.encode(preview.png),
        }
    }
}

#[tauri::command]
pub(crate) async fn preview_local_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    path: PathBuf,
    generation: u64,
) -> DesktopResult<DesktopArtworkSelectionPreview> {
    let state = state.inner().clone();
    blocking_worker(move || {
        let preview =
            service_at_generation(&state, generation)?.preview_local_artwork(&port_id, &path)?;
        crate::require_library_generation(crate::state_generation(&state), generation)?;
        Ok(preview.into())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_background_artwork_framing(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    expected_revision: u64,
    generation: u64,
    framing: Option<ArtworkFraming>,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .set_background_artwork_framing(&port_id, expected_revision, framing)
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
    framing: Option<ArtworkSelectionFraming>,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .import_artwork_with_framing(&port_id, slot, &path, expected_revision, framing)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn suppress_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    expected_revision: u64,
    generation: u64,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .suppress_artwork(&port_id, slot, expected_revision)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub(crate) async fn unhide_artwork(
    state: tauri::State<'_, DesktopState>,
    port_id: String,
    slot: ArtworkSlot,
    expected_revision: u64,
    generation: u64,
) -> DesktopResult<ArtworkState> {
    let state = state.inner().clone();
    blocking_worker(move || {
        service_at_generation(&state, generation)?
            .unhide_artwork(&port_id, slot, expected_revision)
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
