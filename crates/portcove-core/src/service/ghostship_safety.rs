//! Ownership and deletion of the newer-runtime companion to a canonical backup.

use super::PortcoveService;
use crate::{
    AdoptionCopyFile, AdoptionCopyPlan, BackupRecord, PortcoveError, Result,
    ghostship_data_store::{self, BackupDeletionBinding, RuntimeSafetyReceipt},
};
use rusqlite::OptionalExtension;
use std::{fs, path::Path};

pub(super) const RUNTIME_DATA: &str = "legacy-recovery-runtime";
pub(super) const RUNTIME_RECEIPT: &str = ".portcove-ghostship-runtime-safety.json";

impl PortcoveService {
    pub(crate) fn retire_ghostship_backup_authority(
        &self,
        port_id: &str,
        backup_id: &str,
    ) -> Result<()> {
        if port_id != "ghostship" {
            return Ok(());
        }
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM ghostship_qualified_backups WHERE backup_id=?1 AND port_id='ghostship'",
            [backup_id],
        )?;
        transaction.execute(
            "DELETE FROM ghostship_runtime_safety WHERE backup_id=?1",
            [backup_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn require_backup_deletion_preimage(
        &self,
        root: &Path,
        binding: Option<&BackupDeletionBinding>,
    ) -> Result<()> {
        if let Some(binding) = binding {
            return validate_bound_tree(root, binding, false);
        }
        for name in [RUNTIME_DATA, RUNTIME_RECEIPT] {
            match fs::symlink_metadata(root.join(name)) {
                Ok(_) => {
                    return Err(PortcoveError::verification(
                        "backup deletion did not authorize the runtime safety copy",
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    pub(super) fn runtime_safety_binding(
        &self,
        backup: &BackupRecord,
    ) -> Result<Option<BackupDeletionBinding>> {
        let stored: Option<(String, String)> = self.library.connection()?.query_row(
            "SELECT receipt_sha256,receipt_json FROM ghostship_runtime_safety WHERE backup_id=?1",
            [&backup.id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let companion = backup.path.join(RUNTIME_DATA);
        let receipt_path = backup.path.join(RUNTIME_RECEIPT);
        let exists = |path: &Path| -> Result<bool> {
            match fs::symlink_metadata(path) {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(error.into()),
            }
        };
        let Some((receipt_sha256, json)) = stored else {
            if exists(&companion)? || exists(&receipt_path)? {
                return Err(PortcoveError::verification(
                    "unadmitted runtime safety companion requires review; imported files cannot grant deletion authority",
                ));
            }
            return Ok(None);
        };
        let receipt: RuntimeSafetyReceipt = serde_json::from_str(&json)?;
        if backup.port_id != "ghostship"
            || receipt.format_version != 1
            || receipt.backup_id != backup.id
            || crate::signed_catalog::digest(json.as_bytes()) != receipt_sha256
            || hash(&receipt_path)? != receipt_sha256
        {
            return Err(PortcoveError::verification(
                "runtime safety receipt identity changed",
            ));
        }
        let binding = BackupDeletionBinding {
            format_version: 1,
            backup: backup.clone(),
            canonical_data: ghostship_data_store::reviewed_data(&backup.path.join("data"))?,
            runtime_data: ghostship_data_store::reviewed_data(&companion)?,
            manifest_sha256: hash(&backup.path.join("backup.json"))?,
            receipt_sha256,
        };
        if binding.runtime_data != receipt.runtime_data {
            return Err(PortcoveError::verification(
                "runtime safety companion changed",
            ));
        }
        validate_bound_tree(&backup.path, &binding, false)?;
        Ok(Some(binding))
    }

    pub(crate) fn delete_backup_owned_tree(
        &self,
        root: &Path,
        binding: Option<&BackupDeletionBinding>,
    ) -> Result<()> {
        let Some(binding) = binding else {
            // Old deletion intents never authorized a later companion.
            self.require_backup_deletion_preimage(root, None)?;
            crate::path::refuse_symlink_ancestors(root)?;
            return fs::remove_dir_all(root).map_err(Into::into);
        };
        // An interrupted deletion may have removed an expected member, but may
        // never acquire changed bytes, additions, aliases or links on restart.
        validate_bound_tree(root, binding, true)?;
        let expected = binding_tree(binding)?;
        for file in expected.files {
            let path = root.join(&file.relative_path);
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                result => {
                    result?;
                }
            }
            let metadata = file.relative_path == Path::new("backup.json")
                || file.relative_path == Path::new(RUNTIME_RECEIPT);
            let actual = crate::external_runtime::hash_stable_regular(
                &path,
                if metadata { 1024 * 1024 } else { file.size },
                &|| Ok(()),
            )?;
            if actual.0 != file.sha256 || (!metadata && actual.1 != file.size) {
                return Err(PortcoveError::verification(
                    "authorized backup member changed during deletion",
                ));
            }
            fs::remove_file(path)?;
        }
        let mut directories = expected.directories;
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for directory in directories {
            match fs::remove_dir(root.join(directory)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                result => result?,
            }
        }
        fs::remove_dir(root)?;
        Ok(())
    }
}

fn hash(path: &Path) -> Result<String> {
    Ok(crate::external_runtime::hash_stable_regular(path, 1024 * 1024, &|| Ok(()))?.0)
}

fn binding_tree(binding: &BackupDeletionBinding) -> Result<AdoptionCopyPlan> {
    validate_binding(binding)?;
    let mut tree = AdoptionCopyPlan {
        directories: vec![],
        files: vec![],
        skipped_entries: vec![],
        total_bytes: 0,
    };
    for (prefix, data) in [
        ("data", &binding.canonical_data),
        (RUNTIME_DATA, &binding.runtime_data),
    ] {
        tree.directories.push(prefix.into());
        tree.directories.extend(
            data.directories
                .iter()
                .map(|path| Path::new(prefix).join(path)),
        );
        tree.files
            .extend(data.files.iter().map(|file| AdoptionCopyFile {
                relative_path: Path::new(prefix).join(&file.relative_path),
                ..file.clone()
            }));
    }
    // Size is read separately and checked by the matching hash for the two
    // bounded metadata files. No arbitrary metadata path comes from the journal.
    for (name, sha256) in [
        ("backup.json", &binding.manifest_sha256),
        (RUNTIME_RECEIPT, &binding.receipt_sha256),
    ] {
        tree.files.push(AdoptionCopyFile {
            relative_path: name.into(),
            size: 0,
            sha256: sha256.clone(),
        });
    }
    Ok(tree)
}

pub(super) fn validate_bound_tree(
    root: &Path,
    binding: &BackupDeletionBinding,
    partial: bool,
) -> Result<()> {
    let mut expected = binding_tree(binding)?;
    crate::path::refuse_symlink_ancestors(root)?;
    let mut actual = AdoptionCopyPlan {
        directories: vec![],
        files: vec![],
        skipped_entries: vec![],
        total_bytes: 0,
    };
    // Each saved tree retains its own declared bound; the container is exactly
    // two named trees and two bounded metadata files, not an unbounded walk.
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == "data" || name == RUNTIME_DATA {
            let tree = ghostship_data_store::reviewed_data(&entry.path())?;
            let prefix = Path::new(&name);
            actual.directories.push(prefix.to_path_buf());
            actual
                .directories
                .extend(tree.directories.iter().map(|path| prefix.join(path)));
            actual
                .files
                .extend(tree.files.into_iter().map(|file| AdoptionCopyFile {
                    relative_path: prefix.join(file.relative_path),
                    ..file
                }));
        } else if name == "backup.json" || name == RUNTIME_RECEIPT {
            let (sha256, size) =
                crate::external_runtime::hash_stable_regular(&entry.path(), 1024 * 1024, &|| {
                    Ok(())
                })?;
            actual.files.push(AdoptionCopyFile {
                relative_path: name.into(),
                sha256,
                size,
            });
        } else {
            return Err(PortcoveError::verification(
                "runtime safety backup contains an unreviewed member",
            ));
        }
    }
    for file in &mut expected.files {
        if (file.relative_path == Path::new("backup.json")
            || file.relative_path == Path::new(RUNTIME_RECEIPT))
            && let Some(actual) = actual
                .files
                .iter()
                .find(|entry| entry.relative_path == file.relative_path)
        {
            if actual.size > 1024 * 1024 {
                return Err(PortcoveError::verification(
                    "runtime safety metadata exceeded its bound",
                ));
            }
            file.size = actual.size;
        }
    }
    if actual
        .directories
        .iter()
        .any(|path| !expected.directories.contains(path))
        || actual
            .files
            .iter()
            .any(|file| !expected.files.contains(file))
        || (!partial
            && (actual.files.len() != expected.files.len()
                || actual.directories.len() != expected.directories.len()))
    {
        return Err(PortcoveError::verification(
            "backup tree differs from the authorized canonical and runtime safety copies",
        ));
    }
    Ok(())
}

pub(super) fn validate_binding(binding: &BackupDeletionBinding) -> Result<()> {
    if binding.format_version != 1
        || binding.backup.port_id != "ghostship"
        || uuid::Uuid::parse_str(&binding.backup.id)
            .map(|id| id.to_string() != binding.backup.id)
            .unwrap_or(true)
        || [&binding.manifest_sha256, &binding.receipt_sha256]
            .iter()
            .any(|sha| {
                sha.len() != 64
                    || !sha
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
    {
        return Err(PortcoveError::verification(
            "invalid runtime safety deletion binding",
        ));
    }
    ghostship_data_store::validate_data_plan(&binding.canonical_data)?;
    ghostship_data_store::validate_data_plan(&binding.runtime_data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> BackupDeletionBinding {
        for directory in ["data", RUNTIME_DATA] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        for (name, bytes) in [
            ("data/save.json", "old"),
            ("legacy-recovery-runtime/save.json", "new"),
            ("backup.json", "manifest"),
            (RUNTIME_RECEIPT, "receipt"),
        ] {
            fs::write(root.join(name), bytes).unwrap();
        }
        BackupDeletionBinding {
            format_version: 1,
            backup: BackupRecord {
                id: uuid::Uuid::new_v4().to_string(),
                port_id: "ghostship".into(),
                path: root.into(),
                created_at: 1,
                file_count: 1,
                size: 3,
                sha256: "a".repeat(64),
            },
            canonical_data: ghostship_data_store::reviewed_data(&root.join("data")).unwrap(),
            runtime_data: ghostship_data_store::reviewed_data(&root.join(RUNTIME_DATA)).unwrap(),
            manifest_sha256: hash(&root.join("backup.json")).unwrap(),
            receipt_sha256: hash(&root.join(RUNTIME_RECEIPT)).unwrap(),
        }
    }

    #[test]
    fn ghostship_safety_interrupted_deletion_does_not_acquire_outside_members() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("backup");
        let mut binding = fixture(&root);
        let outside = temporary.path().join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        fs::remove_dir_all(&root).unwrap();
        fs::create_dir(&root).unwrap();
        let library = crate::Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library).unwrap();
        for path in [outside.clone(), Path::new("..").join("outside.txt")] {
            binding.runtime_data.files = vec![AdoptionCopyFile {
                relative_path: path,
                size: 4,
                sha256: crate::signed_catalog::digest(b"keep"),
            }];
            binding.runtime_data.total_bytes = 4;
            assert!(
                service
                    .delete_backup_owned_tree(&root, Some(&binding))
                    .is_err()
            );
            assert_eq!(fs::read(&outside).unwrap(), b"keep");
        }
    }

    #[test]
    fn ghostship_safety_deletion_resumes_only_the_authorized_subset() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("backup");
        let binding = fixture(&root);
        let library = crate::Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library).unwrap();
        fs::remove_file(root.join("data/save.json")).unwrap();
        fs::remove_dir(root.join("data")).unwrap();
        fs::remove_file(root.join("backup.json")).unwrap();
        fs::write(root.join("unreviewed"), b"keep").unwrap();
        assert!(
            service
                .delete_backup_owned_tree(&root, Some(&binding))
                .is_err()
        );
        assert_eq!(
            fs::read(root.join(RUNTIME_DATA).join("save.json")).unwrap(),
            b"new"
        );
        fs::remove_file(root.join("unreviewed")).unwrap();
        fs::write(root.join(RUNTIME_DATA).join("save.json"), b"changed").unwrap();
        assert!(
            service
                .delete_backup_owned_tree(&root, Some(&binding))
                .is_err()
        );
        fs::write(root.join(RUNTIME_DATA).join("save.json"), b"new").unwrap();
        service
            .delete_backup_owned_tree(&root, Some(&binding))
            .unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn ghostship_safety_old_deletion_cannot_acquire_a_new_companion() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("backup");
        fixture(&root);
        let library = crate::Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library).unwrap();
        assert!(service.delete_backup_owned_tree(&root, None).is_err());
        assert!(root.join("data/save.json").is_file());
        assert!(root.join(RUNTIME_DATA).join("save.json").is_file());
    }

    #[test]
    fn ghostship_safety_deletion_binding_must_match_the_journal_backup_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let library = crate::Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new_read_only(library.clone()).unwrap();
        let root = library
            .backups_dir()
            .join("ghostship")
            .join(uuid::Uuid::new_v4().to_string());
        let mut binding = fixture(&root);
        binding.backup.id = root.file_name().unwrap().to_str().unwrap().into();
        let mut operation = crate::operation::LifecycleOperation::new(
            uuid::Uuid::new_v4().to_string(),
            crate::operation::LifecycleOperationKind::DeleteBackup,
            "ghostship",
        );
        operation.phase = crate::operation::LifecyclePhase::Prepared;
        operation.paths.final_path = Some(root.clone());
        operation.paths.quarantine = Some(
            root.parent()
                .unwrap()
                .join(format!(".deleting-{}", operation.id)),
        );
        operation.backup_deletion = Some(binding.clone());
        service
            .validate_backup_deletion_operation(&operation)
            .unwrap();
        for change in ["id", "port", "path"] {
            let mut changed = binding.clone();
            match change {
                "id" => changed.backup.id = uuid::Uuid::new_v4().to_string(),
                "port" => changed.backup.port_id = "other-port".into(),
                _ => changed.backup.path = temporary.path().join("outside"),
            }
            operation.backup_deletion = Some(changed);
            assert!(
                service
                    .validate_backup_deletion_operation(&operation)
                    .is_err(),
                "{change}"
            );
            assert_eq!(fs::read(root.join("data/save.json")).unwrap(), b"old");
            assert!(!operation.paths.quarantine.as_ref().unwrap().exists());
        }
    }

    #[test]
    fn ghostship_safety_preimage_refuses_companion_changes_before_quarantine() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("backup");
        let binding = fixture(&root);
        let service = PortcoveService::new_read_only(
            crate::Library::open(temporary.path().join("library")).unwrap(),
        )
        .unwrap();
        service
            .require_backup_deletion_preimage(&root, Some(&binding))
            .unwrap();
        fs::write(root.join(RUNTIME_DATA).join("save.json"), b"changed").unwrap();
        assert!(
            service
                .require_backup_deletion_preimage(&root, Some(&binding))
                .is_err()
        );
        assert!(
            service
                .require_backup_deletion_preimage(&root, None)
                .is_err()
        );
        assert_eq!(fs::read(root.join("data/save.json")).unwrap(), b"old");
    }
}
