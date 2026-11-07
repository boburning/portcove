//! Build-bound snapshots and phase-owned restore proof. This is not gameplay
//! compatibility evidence: only the exact verified archive can reuse its data.
use super::*;

#[derive(PartialEq, Eq)]
pub(super) struct GuardedBackupProducer {
    install_id: String,
    manifest_sha256: String,
    pub(super) archive_sha256: String,
}

pub(super) fn validate_binding(binding: Option<&str>) -> Result<()> {
    if binding.is_some_and(|sha| {
        sha.len() != 64
            || !sha
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    }) {
        return Err(PortcoveError::verification(
            "invalid backup producing archive identity",
        ));
    }
    Ok(())
}

pub(super) fn content_digest(
    mut hasher: Sha256,
    binding: Option<&str>,
    partitioned: Option<&str>,
) -> Result<String> {
    validate_binding(binding)?;
    validate_binding(partitioned)?;
    if let Some(sha) = binding {
        hasher.update(b"\0portcove-backup-guarded-archive-v1\0");
        hasher.update(sha.as_bytes());
    }
    if let Some(policy) = partitioned {
        hasher.update(b"\0portcove-backup-partitioned-data-v1\0");
        hasher.update(policy.as_bytes());
    }
    Ok(hex::encode(hasher.finalize()))
}

fn read_input(path: &Path) -> Result<BackupManifest> {
    refuse_symlink_ancestors(path)?;
    let mut bytes = Vec::new();
    crate::external_runtime::open_single_link_file(path)?
        .take(BACKUP_MANIFEST_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > BACKUP_MANIFEST_MAX_BYTES {
        return Err(PortcoveError::verification(
            "restore manifest input exceeds its bound",
        ));
    }
    let expected = format!(
        "verified-backup-{}.json",
        hex::encode(Sha256::digest(&bytes))
    );
    if path.file_name().and_then(|name| name.to_str()) != Some(expected.as_str()) {
        return Err(PortcoveError::verification(
            "restore manifest input failed its content identity",
        ));
    }
    let manifest: BackupManifest = serde_json::from_slice(&bytes)?;
    if Uuid::parse_str(&manifest.id)
        .map(|id| id.to_string())
        .ok()
        .as_deref()
        != Some(manifest.id.as_str())
    {
        return Err(PortcoveError::verification(
            "restore manifest input has an invalid backup identity",
        ));
    }
    validate_binding(manifest.guarded_archive_v1.as_deref())?;
    validate_binding(manifest.partitioned_data_v1.as_deref())?;
    Ok(manifest)
}

pub(super) fn manifest_input(
    operation: &LifecycleOperation,
    recovery: &Path,
) -> Result<Option<PathBuf>> {
    match operation.original_paths.as_slice() {
        [] => Ok(None),
        [path] if path.parent() == Some(recovery) && manifest_filename(path) => {
            let manifest = read_input(path)?;
            if manifest.port_id != operation.port_id {
                return Err(PortcoveError::verification(
                    "restore manifest input belongs to another port",
                ));
            }
            Ok(Some(path.clone()))
        }
        _ => Err(PortcoveError::state(
            "backup restore journal has an incompatible identity or family payload",
        )),
    }
}

fn manifest_filename(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("verified-backup-"))
        .and_then(|name| name.strip_suffix(".json"))
        .is_some_and(|sha| validate_binding(Some(sha)).is_ok())
}

impl PortcoveService {
    pub(super) fn guarded_backup_producer(
        &self,
        port_id: &str,
    ) -> Result<Option<GuardedBackupProducer>> {
        let Some(active) = self.collectible_active_install(port_id)? else {
            return Ok(None);
        };
        let retained = self.installed_port(&active)?;
        if !crate::persistence::requires_fresh_direct_data_guard(&retained) || !active.verified {
            return Ok(None);
        }
        self.require_portable_runtime_unchanged(&active)?;
        let archive_sha256 = active.artifact.sha256.to_ascii_lowercase();
        validate_binding(Some(&archive_sha256))?;
        Ok(Some(GuardedBackupProducer {
            install_id: active.id,
            manifest_sha256: active.manifest_sha256,
            archive_sha256,
        }))
    }

    pub(super) fn retain_restore_manifest(
        &self,
        operation: &mut LifecycleOperation,
        bytes: &[u8],
    ) -> Result<()> {
        let restore = self.validate_restore_operation(operation)?;
        let manifest: BackupManifest = serde_json::from_slice(bytes)?;
        let guarded = manifest.guarded_archive_v1.is_some()
            || manifest.partitioned_data_v1.is_some()
            || self
                .library
                .all_installs()?
                .iter()
                .filter(|install| install.port_id == operation.port_id)
                .map(|install| self.installed_port(install))
                .collect::<Result<Vec<_>>>()?
                .iter()
                .any(crate::persistence::requires_fresh_direct_data_guard);
        if !guarded {
            return Ok(());
        }
        if bytes.len() as u64 > BACKUP_MANIFEST_MAX_BYTES || manifest.port_id != operation.port_id {
            return Err(PortcoveError::verification(
                "restore manifest input has an invalid scope",
            ));
        }
        let path = restore.recovery_root.join(format!(
            "verified-backup-{}.json",
            hex::encode(Sha256::digest(bytes))
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        crate::durability::sync_publication(&restore.recovery_root)?;
        operation.original_paths = vec![path];
        manifest_input(operation, &restore.recovery_root)?;
        Ok(())
    }

    pub(crate) fn require_restore_snapshot_authority(
        &self,
        operation: &LifecycleOperation,
        snapshot: &Path,
    ) -> Result<()> {
        let restore = self.validate_restore_operation(operation)?;
        let (binding, partitioned) = if let Some(path) = restore.input_manifest {
            let manifest = read_input(&path)?;
            let mut stats = BackupStats::default();
            inspect_snapshot(snapshot, snapshot, &mut stats, &mut 0, 0)?;
            let metadata = manifest.metadata_sha256.clone();
            let binding = manifest.guarded_archive_v1.clone();
            let partitioned = manifest.partitioned_data_v1.clone();
            verify_backup_stats(
                &backup_record(manifest, snapshot.to_path_buf()),
                stats,
                metadata.as_deref(),
                binding.as_deref(),
                partitioned.as_deref(),
            )?;
            (binding, partitioned)
        } else {
            (None, None)
        };
        self.require_direct_backup_snapshot(
            &operation.port_id,
            snapshot,
            binding.as_deref(),
            partitioned.as_deref(),
        )
    }
}

/// Same released integrity framing as copy_backup_tree, without writing a second
/// tree during recovery. Bounded enumeration and stable regular-file reads fail
/// closed before publication or synchronization.
fn inspect_snapshot(
    path: &Path,
    root: &Path,
    stats: &mut BackupStats,
    entries: &mut usize,
    depth: usize,
) -> Result<()> {
    *entries += 1;
    if *entries > 4096 || depth > 32 {
        return Err(PortcoveError::unsupported(
            "bounded restore snapshot inspection limit reached",
        ));
    }
    refuse_symlink_ancestors(path)?;
    crate::runtime_data_policy::refuse_sensitive_entry(path)?;
    let metadata = fs::symlink_metadata(path)?;
    let relative = backup_relative_path(
        path.strip_prefix(root)
            .map_err(|_| PortcoveError::state("restore snapshot escaped its root"))?,
    )?;
    if metadata.file_type().is_symlink() || !(metadata.is_dir() || metadata.is_file()) {
        return Err(PortcoveError::conflict(
            "restore snapshot contains an unsupported entry",
        ));
    }
    if metadata.is_dir() {
        stats.hasher.update(b"dir\0");
        stats.hasher.update(relative.as_bytes());
        stats.hasher.update(b"\0");
        let mut children = Vec::new();
        for child in fs::read_dir(path)? {
            if children.len() + *entries >= 4096 {
                return Err(PortcoveError::unsupported(
                    "bounded restore snapshot inspection limit reached",
                ));
            }
            children.push(child?);
        }
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            inspect_snapshot(&child.path(), root, stats, entries, depth + 1)?;
        }
    } else {
        let mut file = crate::external_runtime::open_single_link_file(path)?;
        let before = file.metadata()?;
        if before.len() != metadata.len() || before.modified()? != metadata.modified()? {
            return Err(PortcoveError::conflict(
                "restore snapshot changed before inspection",
            ));
        }
        stats.hasher.update(b"file\0");
        stats.hasher.update(relative.as_bytes());
        stats.hasher.update(b"\0");
        stats.metadata_hasher.update(relative.as_bytes());
        stats.metadata_hasher.update(b"\0");
        stats
            .metadata_hasher
            .update(crate::runtime_data_policy::modified_stamp(&before)?.as_bytes());
        stats.metadata_hasher.update(b"\0");
        let mut buffer = vec![0; 64 * 1024];
        let mut read_bytes = 0;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            read_bytes += count as u64;
            if read_bytes > before.len() {
                return Err(PortcoveError::conflict(
                    "restore snapshot grew during inspection",
                ));
            }
            stats.hasher.update(&buffer[..count]);
        }
        let after = file.metadata()?;
        if read_bytes != before.len()
            || after.len() != before.len()
            || after.modified()? != before.modified()?
        {
            return Err(PortcoveError::conflict(
                "restore snapshot changed during inspection",
            ));
        }
        stats.size += read_bytes;
        stats.file_count += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guarded_snapshot_digest_preserves_legacy_and_rejects_ignored_or_changed_binding() {
        let mut hash = Sha256::new();
        hash.update(b"dir\0\0file\0save.bin\0private fixture");
        let legacy = hex::encode(Sha256::digest(b"dir\0\0file\0save.bin\0private fixture"));
        assert_eq!(content_digest(hash.clone(), None, None).unwrap(), legacy);
        let bound = content_digest(hash.clone(), Some(&"a".repeat(64)), None).unwrap();
        assert_ne!(
            bound, legacy,
            "older raw-byte readers must refuse a bound backup"
        );
        assert_ne!(
            bound,
            content_digest(hash.clone(), Some(&"b".repeat(64)), None).unwrap()
        );
        assert!(content_digest(hash, Some("unverified-tag"), None).is_err());
        let mut hash = Sha256::new();
        hash.update(b"same private snapshot");
        let partitioned =
            content_digest(hash.clone(), Some(&"a".repeat(64)), Some(&"b".repeat(64))).unwrap();
        assert_ne!(
            partitioned,
            content_digest(hash.clone(), Some(&"a".repeat(64)), None).unwrap(),
            "earlier unpartitioned readers must fail integrity, even at the same archive"
        );
        assert_ne!(
            partitioned,
            content_digest(hash.clone(), Some(&"a".repeat(64)), Some(&"c".repeat(64))).unwrap()
        );
        assert_ne!(
            content_digest(hash.clone(), None, Some(&"b".repeat(64))).unwrap(),
            content_digest(hash, None, None).unwrap(),
            "opaque retained data still fences older readers"
        );
    }

    #[test]
    #[cfg(windows)]
    fn partitioned_backup_and_runtime_copy_preserve_deep_windows_data_and_timestamps() {
        use std::os::windows::ffi::OsStrExt;
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(
            source.join("snapshot-境界.sav"),
            b"exact first-party snapshot fixture",
        )
        .unwrap();
        let parent = temporary
            .path()
            .join("recovery")
            .join(uuid::Uuid::new_v4().to_string())
            .join("staged-data")
            .join(".portcove-archive-data-v1")
            .join("a".repeat(64))
            .join("b".repeat(64));
        fs::create_dir_all(&parent).unwrap();
        let mut destination = parent.join("preserved");
        while destination.as_os_str().encode_wide().count() < 280 {
            destination = destination.join("owned-data-coordinate");
        }
        fs::create_dir_all(&destination).unwrap();
        let output = destination.join("snapshot-境界.sav");
        crate::runtime_data_policy::copy_ordinary_file(&source.join("snapshot-境界.sav"), &output)
            .unwrap();
        assert_eq!(
            fs::read(&output).unwrap(),
            b"exact first-party snapshot fixture"
        );
        assert_eq!(
            fs::metadata(&output).unwrap().modified().unwrap(),
            fs::metadata(source.join("snapshot-境界.sav"))
                .unwrap()
                .modified()
                .unwrap()
        );
        let mut stats = BackupStats::default();
        copy_backup_tree(&source, &destination.join("backup"), &source, &mut stats).unwrap();
        let copied = destination.join("backup/snapshot-境界.sav");
        assert_eq!(fs::read(&copied).unwrap(), fs::read(&output).unwrap());
        assert_eq!(
            fs::metadata(&copied).unwrap().modified().unwrap(),
            fs::metadata(&output).unwrap().modified().unwrap()
        );
        assert_eq!(stats.file_count, 1);
        assert_eq!(
            fs::read(source.join("snapshot-境界.sav")).unwrap(),
            b"exact first-party snapshot fixture"
        );
    }

    #[test]
    fn opaque_partitioned_restore_retains_proof_before_publication() {
        opaque_partitioned_restore_at(LifecycleFaultPoint::RestorePrepared);
    }

    #[test]
    fn opaque_partitioned_restore_retains_proof_after_publication() {
        opaque_partitioned_restore_at(LifecycleFaultPoint::RestorePublished);
    }

    fn opaque_partitioned_restore_at(point: LifecycleFaultPoint) {
        use std::sync::Arc;
        struct Interrupt(LifecycleFaultPoint);
        impl crate::operation::LifecycleFaultInjector for Interrupt {
            fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
                if point == self.0 {
                    Err(PortcoveError::state("opaque restore fixture interruption"))
                } else {
                    Ok(())
                }
            }
        }
        let started = std::time::Instant::now();
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let id = "super-metroid-recomp";
        let mut service = PortcoveService::new(library.clone()).unwrap();
        let port = service.catalog.port(id).unwrap();
        let user = library.user_dir(id);
        crate::archive_data::initialize(port, &user).unwrap();
        let bound = crate::archive_data::namespace(port, &user)
            .unwrap()
            .join("a".repeat(64));
        fs::create_dir_all(&bound).unwrap();
        fs::write(bound.join("snapshot.sav"), b"opaque preserved snapshot").unwrap();
        fs::write(user.join("config.ini"), b"reviewed conventional data").unwrap();
        let backup = service.create_backup(id).unwrap();
        eprintln!("opaque {point:?}: backup at {:?}", started.elapsed());
        let manifest: BackupManifest =
            serde_json::from_slice(&fs::read(backup.path.join("backup.json")).unwrap()).unwrap();
        assert!(manifest.guarded_archive_v1.is_none());
        assert!(manifest.partitioned_data_v1.is_some());
        fs::write(user.join("config.ini"), b"current data before restore").unwrap();
        let preview = service
            .preview_backup_action(id, &backup.id, BackupAction::Restore)
            .unwrap();
        let consent = service
            .authorize_backup_action(
                id,
                &backup.id,
                BackupAction::Restore,
                &preview.preview_sha256,
            )
            .unwrap();
        service.faults = Arc::new(Interrupt(point));
        assert!(
            service
                .restore_backup(id, &backup.id, &consent.token)
                .is_err()
        );
        let store = OperationStore::new(library.clone());
        let mut operations = store.all().unwrap();
        assert_eq!(operations.len(), 1);
        let operation = &mut operations[0];
        assert_eq!(
            operation.original_paths.len(),
            1,
            "opaque data still requires phase-owned restore proof"
        );
        let restore = service.validate_restore_operation(operation).unwrap();
        let snapshot = if point == LifecycleFaultPoint::RestorePrepared {
            restore.staged_data
        } else {
            user.clone()
        };
        fs::rename(snapshot.join("config.ini"), snapshot.join("config.changed")).unwrap();
        assert!(crate::recovery::recover_restore(&service, &store, operation).is_err());
        assert!(operation.original_paths[0].is_file());
        assert!(store.all().unwrap().len() == 1);
        fs::rename(snapshot.join("config.changed"), snapshot.join("config.ini")).unwrap();
        crate::recovery::recover_restore(&service, &store, operation).unwrap();
        assert_eq!(
            fs::read(user.join("config.ini")).unwrap(),
            b"reviewed conventional data"
        );
        assert_eq!(
            crate::archive_data::snapshot_policy(&user).unwrap(),
            manifest.partitioned_data_v1
        );
        assert!(store.all().unwrap().is_empty());
        eprintln!("opaque {point:?}: recovered at {:?}", started.elapsed());
    }

    #[test]
    fn guarded_snapshot_read_only_integrity_matches_published_copy_and_detects_tamper() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let copied = temporary.path().join("copied");
        fs::create_dir_all(source.join("empty")).unwrap();
        fs::write(source.join("save.bin"), b"private fixture").unwrap();
        let mut written = BackupStats::default();
        copy_backup_tree(&source, &copied, &source, &mut written).unwrap();
        let expected = hex::encode(Sha256::digest(
            b"dir\0\0dir\0empty\0file\0save.bin\0private fixture",
        ));
        assert_eq!(hex::encode(written.hasher.clone().finalize()), expected);
        let mut observed = BackupStats::default();
        inspect_snapshot(&copied, &copied, &mut observed, &mut 0, 0).unwrap();
        assert_eq!(observed.file_count, 1);
        assert_eq!(observed.size, 15);
        assert_eq!(hex::encode(observed.hasher.finalize()), expected);
        assert_eq!(
            hex::encode(observed.metadata_hasher.finalize()),
            hex::encode(written.metadata_hasher.finalize())
        );
        fs::write(copied.join("save.bin"), b"changed fixture").unwrap();
        let mut changed = BackupStats::default();
        inspect_snapshot(&copied, &copied, &mut changed, &mut 0, 0).unwrap();
        assert_ne!(hex::encode(changed.hasher.finalize()), expected);
    }
}
