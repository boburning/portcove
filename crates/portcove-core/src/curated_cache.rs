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

fn verify(path: &Path, worker: &CacheWorker) -> Result<()> {
    let asset = &worker.asset;
    let operation = &worker.operation;
    let metadata = regular(path)?
        .ok_or_else(|| PortcoveError::verification("curated cache bytes disappeared"))?;
    crate::archive::validate_download_size(metadata.len(), asset.size)?;
    let (hash, size) = crate::adapter::hash_file_bounded_with_checkpoint(path, asset.size, || {
        operation.checkpoint()
    })?;
    crate::archive::validate_download_size(size, asset.size)?;
    if hash != asset.sha256 {
        return Err(
            PortcoveError::verification("curated cache bytes failed SHA-256 verification")
                .detail("path", path.display().to_string()),
        );
    }
    #[cfg(test)]
    if let Some(hook) = worker
        .hook
        .as_ref()
        .and_then(|hook| hook.after_verify.as_ref())
    {
        hook(path, size)?;
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
    crate::archive::validate_download_size(metadata.len(), asset.size)?;
    // Verify the private copy, so a concurrent source substitution cannot bless
    // bytes that differ from the independently accepted expected digest.
    copy_checked(&path, destination, asset, worker)?;
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
        verify(&path, worker)?;
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
        || fs2::available_space(root)? < asset.size
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
