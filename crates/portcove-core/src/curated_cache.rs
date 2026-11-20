//! Disposable bytes never replace current acquisition authority or expected identity.
use crate::{
    DefinitionAcquisitionScope, ErrorCode, OperationCoordinator, PortcoveError, ReleaseAsset,
    Result,
};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_CACHE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 256;

#[derive(Clone)]
pub(crate) struct CacheWorker {
    scope: DefinitionAcquisitionScope,
    asset: ReleaseAsset,
    operation: OperationCoordinator,
    #[cfg(test)]
    pub hook: Option<CacheWorkerTestHook>,
}

#[cfg(test)]
type AfterCacheCopy = std::sync::Arc<dyn Fn(&Path, u64) -> Result<()> + Send + Sync>;

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct CacheWorkerTestHook {
    pub after_copy: AfterCacheCopy,
    pub after_verify: Option<AfterCacheCopy>,
    pub finished: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl CacheWorker {
    pub(crate) fn new(
        scope: &DefinitionAcquisitionScope,
        asset: &ReleaseAsset,
        operation: &OperationCoordinator,
    ) -> Self {
        Self {
            scope: scope.clone(),
            asset: asset.clone(),
            operation: operation.clone(),
            #[cfg(test)]
            hook: None,
        }
    }

    pub(crate) async fn restore(&self, destination: &Path) -> Result<bool> {
        self.run(destination, false).await
    }

    pub(crate) async fn retain(&self, source: &Path) -> Result<bool> {
        self.run(source, true).await
    }

    async fn run(&self, path: &Path, retain: bool) -> Result<bool> {
        let worker = self.clone();
        let path = path.to_owned();
        #[cfg(test)]
        if let Some(hook) = &worker.hook {
            hook.finished
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }
        // Never race cancellation against this join: the cooperative worker
        // must stop mutating before its caller can clean private staging.
        tokio::task::spawn_blocking(move || {
            let result = if retain {
                retain_inner(&worker, &path)
            } else {
                restore_inner(&worker, &path)
            };
            #[cfg(test)]
            if let Some(hook) = &worker.hook {
                hook.finished
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            result
        })
        .await
        .map_err(|error| PortcoveError::install(error.to_string()))?
    }
}

fn entry(scope: &DefinitionAcquisitionScope, asset: &ReleaseAsset) -> Result<PathBuf> {
    crate::archive::validate_download_progress(0, asset.size)?;
    scope.require_current()?;
    scope.require_asset_url(&asset.url)?;
    if scope.curated_checks != Some(1)
        || asset.size == 0
        || asset.sha256.len() != 64
        || !asset
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(PortcoveError::verification(
            "cache requires exact admitted curated bytes",
        ));
    }
    let (catalog, _) = scope.library.load_catalog()?;
    let port = catalog.port(&scope.stable_id)?;
    scope.require_port(port)?;
    let record = port
        .release
        .curated
        .values()
        .find(|record| {
            record.filename == asset.name
                && record.sha256 == asset.sha256
                && record.size == asset.size
        })
        .ok_or_else(|| {
            PortcoveError::verification("cache bytes are not in the exact admitted curated record")
        })?;
    crate::definition_repository::publisher_policy::require_curated_artifact_operation(
        &scope.library.connection()?,
        scope.repository_id,
        record,
        crate::definition_repository::publisher_policy::CuratedArtifactOperation::Acquisition,
    )?;
    let path = scope
        .library
        .downloads_dir()
        .join("curated-v1")
        .join(format!("{}.asset", asset.sha256));
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(path)
}

fn regular(path: &Path) -> Result<Option<fs::Metadata>> {
    crate::path::refuse_symlink_ancestors(path)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            Ok(Some(metadata))
        }
        Ok(_) => Err(
            PortcoveError::verification("curated cache member is not a regular file")
                .detail("path", path.display().to_string()),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn integrity_error(path: &Path, worker: &CacheWorker) -> Result<Option<PortcoveError>> {
    let asset = &worker.asset;
    let operation = &worker.operation;
    let metadata = regular(path)?
        .ok_or_else(|| PortcoveError::verification("curated cache bytes disappeared"))?;
    if let Err(error) = crate::archive::validate_download_size(metadata.len(), asset.size) {
        return Ok(Some(error));
    }
    let (hash, size) = crate::adapter::hash_file_bounded_with_checkpoint(path, asset.size, || {
        operation.checkpoint()
    })?;
    if let Err(error) = crate::archive::validate_download_size(size, asset.size) {
        return Ok(Some(error));
    }
    Ok((hash != asset.sha256).then(|| {
        PortcoveError::verification("curated cache bytes failed SHA-256 verification")
            .detail("path", path.display().to_string())
    }))
}

fn verify(path: &Path, worker: &CacheWorker) -> Result<()> {
    if let Some(error) = integrity_error(path, worker)? {
        return Err(error);
    }
    #[cfg(test)]
    if let Some(hook) = worker
        .hook
        .as_ref()
        .and_then(|hook| hook.after_verify.as_ref())
    {
        hook(path, worker.asset.size)?;
    }
    Ok(())
}

fn copy_checked(
    source: &Path,
    destination: &Path,
    asset: &ReleaseAsset,
    worker: &CacheWorker,
) -> Result<()> {
    regular(source)?
        .ok_or_else(|| PortcoveError::verification("curated cache source disappeared"))?;
    crate::path::refuse_symlink_ancestors(destination)?;
    let mut source = fs::File::open(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut buffer = [0; 64 * 1024];
    let mut written = 0_u64;
    loop {
        worker.operation.checkpoint()?;
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        written = written.saturating_add(count as u64);
        crate::archive::validate_download_progress(written, asset.size)?;
        output.write_all(&buffer[..count])?;
        #[cfg(test)]
        if let Some(hook) = &worker.hook {
            (hook.after_copy)(destination, written)?;
        }
    }
    output.sync_all()?;
    drop(output);
    verify(destination, worker)
}

/// Diagnose the canonical object under the existing cache lock. A private
/// copy can fail for unrelated reasons, including a change after it was copied.
fn quarantine_invalid_cache(
    path: &Path,
    worker: &CacheWorker,
    original_error: PortcoveError,
) -> Result<bool> {
    if original_error.code != ErrorCode::Verification {
        return Err(original_error);
    }
    // Only the independently rechecked canonical bytes can be quarantined.
    // Reparse points, I/O failures and cancellation never identify bad bytes.
    regular(path)?.ok_or_else(|| PortcoveError::conflict("curated cache entry disappeared"))?;
    let original = same_file::Handle::from_path(path)?;
    if integrity_error(path, worker)?.is_none() {
        return Err(original_error);
    }
    entry(&worker.scope, &worker.asset)?;
    worker.operation.checkpoint()?;
    if same_file::Handle::from_path(path)? != original {
        return Err(PortcoveError::conflict(
            "curated cache entry changed during verification",
        ));
    }
    // This reserved inactive name is already understood by earlier readers.
    // It counts towards the same storage limits and is never a cache hit.
    let quarantine = path.with_file_name(format!(".partial-{}", uuid::Uuid::new_v4()));
    let refusal = original_error.detail("expected_sha256", &worker.asset.sha256);
    if let Err(error) = crate::durability::rename_noreplace(path, &quarantine) {
        return Err(refusal.detail("quarantine_move_error", error.to_string()));
    }
    let confirmation = (|| -> Result<bool> {
        crate::durability::sync_publication(path.parent().expect("cache entry has parent"))?;
        regular(&quarantine)?
            .ok_or_else(|| PortcoveError::conflict("quarantine entry disappeared"))?;
        Ok(same_file::Handle::from_path(&quarantine)? == original
            && integrity_error(&quarantine, worker)?.is_some())
    })();
    Err(finish_quarantine(path, &quarantine, refusal, confirmation))
}

// The move has completed. Every subsequent failure preserves the original
// verification error and names the location at which we left the evidence.
fn finish_quarantine(
    canonical: &Path,
    quarantine: &Path,
    mut refusal: PortcoveError,
    confirmation: Result<bool>,
) -> PortcoveError {
    match confirmation {
        Ok(true) => {}
        Err(error) => {
            refusal = refusal.detail("quarantine_confirmation_error", error.to_string());
        }
        Ok(false) => match crate::durability::rename_noreplace(quarantine, canonical) {
            Ok(()) => {
                refusal = refusal
                    .detail("cache_changed_during_quarantine", "true")
                    .detail("retained_path", canonical.display().to_string());
                if let Err(error) = crate::durability::sync_publication(
                    canonical.parent().expect("cache entry has parent"),
                ) {
                    refusal = refusal.detail("quarantine_restore_sync_error", error.to_string());
                }
                return refusal;
            }
            Err(error) => {
                refusal = refusal.detail("quarantine_restore_error", error.to_string());
            }
        },
    }
    refusal.detail("quarantine_path", quarantine.display().to_string())
}

fn restore_inner(worker: &CacheWorker, destination: &Path) -> Result<bool> {
    let scope = &worker.scope;
    let asset = &worker.asset;
    let path = entry(scope, asset)?;
    let _guard = match scope.library.try_lock_curated_cache() {
        Ok(guard) => guard,
        Err(error) if error.code == ErrorCode::Conflict => return Ok(false),
        Err(error) => return Err(error),
    };
    let Some(metadata) = regular(&path)? else {
        return Ok(false);
    };
    // Verify the private copy, so a concurrent source substitution cannot bless
    // bytes that differ from the independently accepted expected digest.
    let copied = crate::archive::validate_download_size(metadata.len(), asset.size)
        .and_then(|()| copy_checked(&path, destination, asset, worker));
    if let Err(error) = copied {
        return quarantine_invalid_cache(&path, worker, error);
    }
    entry(scope, asset)?;
    Ok(true)
}

fn retain_inner(worker: &CacheWorker, source: &Path) -> Result<bool> {
    let scope = &worker.scope;
    let asset = &worker.asset;
    let operation = &worker.operation;
    let path = entry(scope, asset)?;
    let _guard = match scope.library.try_lock_curated_cache() {
        Ok(guard) => guard,
        Err(error) if error.code == ErrorCode::Conflict => return Ok(false),
        Err(error) => return Err(error),
    };
    if regular(&path)?.is_some() {
        if let Err(error) = verify(&path, worker) {
            return quarantine_invalid_cache(&path, worker, error);
        }
        entry(scope, asset)?;
        return Ok(true);
    }
    let root = path.parent().expect("cache entry has parent");
    crate::path::refuse_symlink_ancestors(root)?;
    fs::create_dir_all(root)?;
    let mut count = 0_usize;
    let mut bytes = 0_u64;
    for member in fs::read_dir(root)? {
        operation.checkpoint()?;
        let member = member?;
        count += 1;
        if count > MAX_CACHE_ENTRIES {
            return Err(PortcoveError::verification(
                "curated cache inventory exceeds its entry bound",
            ));
        }
        let name = member
            .file_name()
            .into_string()
            .map_err(|_| PortcoveError::verification("unexpected curated cache member"))?;
        let accepted_name = name.strip_suffix(".asset").is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
        let partial_name = name
            .strip_prefix(".partial-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
        if !accepted_name && !partial_name {
            return Err(PortcoveError::verification(
                "unexpected curated cache member; retained for review",
            ));
        }
        let metadata = regular(&member.path())?
            .ok_or_else(|| PortcoveError::conflict("curated cache inventory changed"))?;
        bytes = bytes.saturating_add(metadata.len());
        if bytes > MAX_CACHE_BYTES {
            return Err(PortcoveError::verification(
                "curated cache exceeds its byte bound",
            ));
        }
    }
    // A full cache is optional capacity, never permission to evict evidence.
    if count == MAX_CACHE_ENTRIES
        || bytes.saturating_add(asset.size) > MAX_CACHE_BYTES
        || fs4::available_space(root)? < asset.size
    {
        return Ok(false);
    }
    let staging = root.join(format!(".partial-{}", uuid::Uuid::new_v4()));
    copy_checked(source, &staging, asset, worker)?;
    entry(scope, asset)?;
    operation.checkpoint()?;
    crate::path::refuse_symlink_ancestors(&path)?;
    crate::durability::rename_noreplace(&staging, &path)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_quarantine_reports_the_original_refusal_and_retained_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let canonical = directory.path().join("accepted.asset");
        let quarantine = directory.path().join(".partial-evidence");
        fs::write(&quarantine, b"rejected").unwrap();
        let refused =
            || PortcoveError::verification("curated cache bytes failed SHA-256 verification");
        let error = finish_quarantine(
            &canonical,
            &quarantine,
            refused(),
            Err(PortcoveError::new(
                ErrorCode::Cancelled,
                "operation cancelled",
            )),
        );
        assert_eq!(error.code, ErrorCode::Verification);
        assert_eq!(error.message, refused().message);
        assert_eq!(Path::new(&error.details["quarantine_path"]), quarantine);
        assert_eq!(fs::read(&quarantine).unwrap(), b"rejected");
        assert!(!canonical.exists());

        fs::write(&canonical, b"newer").unwrap();
        let error = finish_quarantine(&canonical, &quarantine, refused(), Ok(false));
        assert!(error.details.contains_key("quarantine_restore_error"));
        assert_eq!(fs::read(&canonical).unwrap(), b"newer");
        assert_eq!(fs::read(&quarantine).unwrap(), b"rejected");

        fs::remove_file(&canonical).unwrap();
        let error = finish_quarantine(&canonical, &quarantine, refused(), Ok(false));
        assert_eq!(Path::new(&error.details["retained_path"]), canonical);
        assert_eq!(fs::read(&canonical).unwrap(), b"rejected");
        assert!(!quarantine.exists());
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn curated_cache_refuses_link_ancestors_without_touching_retained_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("retained");
        let link = directory.path().join("cache-link");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("artifact.asset"), b"retained exact fixture").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        {
            let target = target.to_str().unwrap();
            let link = link.to_str().unwrap();
            for path in [target, link] {
                assert!(!path.contains(['"', '%', '!', '&', '|', '<', '>', '^', '\r', '\n']));
            }
            let mut command = crate::ChildProcessPolicy::native_tool_spec(
                crate::ChildProcessClass::HostTool,
                "cmd.exe",
            )
            .unwrap();
            command.raw_arg(format!("/D /V:OFF /C mklink /J \"{link}\" \"{target}\""));
            let started = std::time::Instant::now();
            let mut final_capture = None;
            let output = crate::tool_process::run_tool(
                &mut command,
                &|| {
                    if started.elapsed() >= std::time::Duration::from_secs(2) {
                        Err(PortcoveError::state(
                            "cache junction fixture exceeded two seconds",
                        ))
                    } else {
                        Ok(())
                    }
                },
                crate::tool_process::ToolProcessObserver {
                    diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                        activity_id: "cache-junction-fixture",
                        phase: "fixture.junction",
                        record: &mut |capture| {
                            final_capture = Some(capture.clone());
                            Ok(())
                        },
                    }),
                    quiesced: None,
                },
            )
            .unwrap();
            assert!(output.status.success(), "{}", output.output);
            let captured = final_capture.unwrap();
            assert!(captured.complete && !captured.stdout.truncated && !captured.stderr.truncated);
            assert_eq!(
                captured.stdout.text.len() + 1 + captured.stderr.text.len(),
                output.output.len()
            );
        }
        assert!(regular(&link).is_err());
        assert!(regular(&link.join("artifact.asset")).is_err());
        assert!(crate::path::refuse_symlink_ancestors(&link.join("new-private.asset")).is_err());
        assert!(!target.join("new-private.asset").exists());
        assert_eq!(
            fs::read(target.join("artifact.asset")).unwrap(),
            b"retained exact fixture"
        );
    }
}
