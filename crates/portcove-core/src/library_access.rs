use std::{
    fs::{self, File, OpenOptions},
    path::Path,
};

use fs2::FileExt;

use crate::{PortcoveError, Result};

#[derive(Debug, Clone, Copy)]
pub(crate) enum LibraryAccess {
    Shared,
    Exclusive,
}

/// A library remains in use until its last clone and service are dropped.
#[derive(Debug)]
pub(crate) struct LibraryLease {
    file: File,
}

impl LibraryLease {
    pub(crate) fn acquire(root: &Path) -> Result<Self> {
        Self::with_access(root, LibraryAccess::Shared)
    }

    pub(crate) fn with_access(root: &Path, access: LibraryAccess) -> Result<Self> {
        let locks = root.join("locks");
        fs::create_dir_all(&locks)?;
        if fs::symlink_metadata(&locks)?.file_type().is_symlink() {
            return Err(PortcoveError::verification(
                "library locks directory must not be a symbolic link",
            ));
        }
        let path = locks.join("library.lock");
        if let Ok(metadata) = fs::symlink_metadata(&path)
            && (!metadata.is_file() || metadata.file_type().is_symlink())
        {
            return Err(PortcoveError::verification(
                "library lease must be a regular file",
            ));
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        let lock = match access {
            LibraryAccess::Shared => FileExt::try_lock_shared(&file),
            LibraryAccess::Exclusive => FileExt::try_lock_exclusive(&file),
        };
        lock.map_err(|error| {
            if error.kind() == fs2::lock_contended_error().kind() {
                PortcoveError::conflict(
                    "the library is in use by another Portcove operation or process",
                )
                .detail("library_root", root.display().to_string())
            } else {
                error.into()
            }
        })?;
        Ok(Self { file })
    }
}

impl Drop for LibraryLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ActivityOperation, ActivityTargetKind, ApplicationUpdateQuiescenceGuard, ErrorCode,
        LaunchSessionPhase, LaunchSessionRecord, Library,
    };

    #[test]
    fn every_open_library_and_clone_retains_the_shared_lease() {
        let temporary = tempfile::tempdir().unwrap();
        let first = Library::open(temporary.path()).unwrap();
        let clone = first.clone();
        let second = Library::open(temporary.path()).unwrap();
        let exclusive = OpenOptions::new()
            .read(true)
            .write(true)
            .open(temporary.path().join("locks/library.lock"))
            .unwrap();
        assert!(FileExt::try_lock_exclusive(&exclusive).is_err());
        drop(first);
        drop(second);
        assert!(FileExt::try_lock_exclusive(&exclusive).is_err());
        drop(clone);
        FileExt::try_lock_exclusive(&exclusive).unwrap();
        assert_eq!(
            Library::open(temporary.path()).unwrap_err().code,
            ErrorCode::Conflict
        );
        FileExt::unlock(&exclusive).unwrap();
        Library::open(temporary.path()).unwrap();
    }

    #[test]
    fn application_update_quiescence_excludes_every_library_process() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        let library = Library::open(&root).unwrap();
        let busy = ApplicationUpdateQuiescenceGuard::acquire(&root).unwrap_err();
        assert_eq!(busy.code, ErrorCode::Conflict);

        drop(library);
        let canonical = fs::canonicalize(&root).unwrap();
        let guard = ApplicationUpdateQuiescenceGuard::acquire(&root).unwrap();
        assert_eq!(guard.root(), canonical);
        assert_eq!(
            Library::open(guard.root()).unwrap_err().code,
            ErrorCode::Conflict
        );
        drop(guard);
        Library::open(&root).unwrap();
    }

    #[test]
    fn application_update_quiescence_does_not_initialize_an_empty_path() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("empty");
        fs::create_dir(&root).unwrap();

        let error = ApplicationUpdateQuiescenceGuard::acquire(&root).unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn unfinished_activity_requires_explicit_recovery_before_application_update() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        let library = Library::open(&root).unwrap();
        let activity = library
            .begin_activity(
                ActivityOperation::ImportSource,
                ActivityTargetKind::Source,
                Some("disc"),
            )
            .unwrap();
        let preflight = library.require_application_update_idle().unwrap_err();
        assert_eq!(preflight.details.get("activity_id"), Some(&activity.id));
        drop(library);

        let error = ApplicationUpdateQuiescenceGuard::acquire(&root).unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(error.details.get("activity_id"), Some(&activity.id));
        assert_eq!(
            error.details.get("activity_operation").map(String::as_str),
            Some("import_source")
        );
        assert_eq!(
            error
                .details
                .get("application_update_held")
                .map(String::as_str),
            Some("true")
        );
    }

    #[test]
    fn unfinished_launch_is_reported_before_its_activity() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("library");
        let library = Library::open(&root).unwrap();
        let activity = library
            .begin_activity(
                ActivityOperation::Launch,
                ActivityTargetKind::Port,
                Some("example"),
            )
            .unwrap();
        library
            .create_launch_session(&LaunchSessionRecord {
                id: activity.id.clone(),
                port_id: "example".into(),
                install_id: "install".into(),
                install_root: root.join("versions/example/install"),
                supervisor_pid: 10,
                supervisor_identity: Some("supervisor".into()),
                child_pid: Some(11),
                child_identity: Some("child".into()),
                phase: LaunchSessionPhase::Running,
                outcome: None,
                exit_code: None,
                message: None,
                started_at: 1,
                updated_at: 2,
                finished_at: None,
            })
            .unwrap();
        let preflight = library.require_application_update_idle().unwrap_err();
        assert_eq!(
            preflight.details.get("launch_session_id"),
            Some(&activity.id)
        );
        drop(library);

        let error = ApplicationUpdateQuiescenceGuard::acquire(&root).unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(error.details.get("launch_session_id"), Some(&activity.id));
        assert_eq!(
            error.details.get("launch_phase").map(String::as_str),
            Some("running")
        );
        assert!(!error.details.contains_key("activity_id"));
    }
}
