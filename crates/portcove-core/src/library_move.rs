use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ActivityOperation, ActivityStatus, ActivityTargetKind, Library, PortcoveError, PortcoveService,
    Result,
    library_access::{LibraryAccess, LibraryLease},
    library_authority::{self, AuthorityState, LibraryAuthority},
    transfer_journal::{TransferJournal, TransferPhase},
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LibraryMoveResult {
    pub transfer_id: String,
    pub source_root: PathBuf,
    pub destination_root: PathBuf,
    pub active_root: PathBuf,
    pub source_retained: bool,
    pub completed: bool,
}

impl PortcoveService {
    /// Call after dropping every service/library handle, including adapter caches.
    pub fn move_library(
        source: &Path,
        destination: &Path,
        expected_plan: &str,
    ) -> Result<LibraryMoveResult> {
        start_move(source, destination, expected_plan, &|_| Ok(()))
    }

    /// Recovery deliberately opens the retained source without following its relocation marker.
    pub fn resume_library_move(source: &Path) -> Result<LibraryMoveResult> {
        let source = fs::canonicalize(source)?;
        let library = Library::open_exclusive(&source)?;
        let mut journal = TransferJournal::read(&source)?;
        if journal.phase == TransferPhase::Aborted {
            return Err(PortcoveError::conflict("this library move was aborted"));
        }
        continue_move(&library, &mut journal, &|_| Ok(()))
    }

    /// Abort preserves every destination byte and reopens only an unpublished source.
    pub fn abort_library_move(source: &Path) -> Result<LibraryMoveResult> {
        let source = fs::canonicalize(source)?;
        let library = Library::open_exclusive(&source)?;
        let mut journal = TransferJournal::read(&source)?;
        if journal.phase == TransferPhase::Aborted {
            library_authority::abort_source(&source, &journal.transfer_id)?;
            return Ok(result(&journal, false));
        }
        let marker = library_authority::authority(&source)?;
        if marker.as_ref().is_some_and(|marker| {
            marker.state == AuthorityState::Moved || marker.transfer_id != journal.transfer_id
        }) || matches!(
            journal.phase,
            TransferPhase::Published | TransferPhase::Complete
        ) {
            return Err(PortcoveError::conflict(
                "the move reached publication; resume it instead of reactivating the old copy",
            ));
        }
        let destination = &journal.plan.destination_root;
        let _destination_lease = if destination.exists()
            && library_authority::authority(destination)?.is_some()
        {
            let lease = LibraryLease::with_access(destination, LibraryAccess::Exclusive)?;
            require_pending(destination, &journal)?;
            Some(lease)
        } else {
            if destination.join("portcove.sqlite3").exists() {
                return Err(PortcoveError::conflict(
                    "an unmarked destination contains a database; retain both copies and inspect the missing authority marker",
                ));
            }
            None
        };
        ensure_move_activity(&library, &journal)?;
        finish_move_activity(
            &library,
            &journal.transfer_id,
            ActivityStatus::Failed,
            "Library move aborted; all original and copied data retained",
        )?;
        journal.phase = TransferPhase::Aborted;
        journal.write()?;
        library_authority::abort_source(&source, &journal.transfer_id)?;
        Ok(result(&journal, false))
    }
}

fn start_move(
    source: &Path,
    destination: &Path,
    expected_plan: &str,
    checkpoint: &dyn Fn(TransferPhase) -> Result<()>,
) -> Result<LibraryMoveResult> {
    let source = fs::canonicalize(source)?;
    let library = Library::open_exclusive(&source)?;
    if library_authority::authority(&source)?.is_some() {
        return Err(PortcoveError::conflict(
            "this library already has a relocation or recovery marker",
        ));
    }
    crate::import_journal::check_open(&source)?;
    let service = PortcoveService::new(library.clone())?;
    let plan = service.plan_library_move(destination)?;
    if plan.plan_sha256 != expected_plan {
        return Err(PortcoveError::conflict(
            "library move plan changed; review a fresh plan before applying it",
        ));
    }
    let mut journal = TransferJournal {
        schema_version: 1,
        transfer_id: uuid::Uuid::new_v4().to_string(),
        plan,
        phase: TransferPhase::Copying,
    };
    journal.create()?;
    continue_move(&library, &mut journal, checkpoint)
        .map_err(|error| recovery_error(error, &journal))
}

fn continue_move(
    source: &Library,
    journal: &mut TransferJournal,
    checkpoint: &dyn Fn(TransferPhase) -> Result<()>,
) -> Result<LibraryMoveResult> {
    ensure_move_activity(source, journal)?;
    let marker = library_authority::authority(source.root())?;
    if let Some(marker) = &marker {
        if marker.transfer_id != journal.transfer_id
            || marker.destination != journal.plan.destination_root
        {
            return Err(PortcoveError::verification(
                "source authority does not match the library move journal",
            ));
        }
    } else {
        if journal.phase != TransferPhase::Copying {
            return Err(PortcoveError::verification(
                "source authority was lost after move publication began",
            ));
        }
        crate::library_transfer::verify_source_plan(source, &journal.plan)?;
        library_authority::write_authority(
            source.root(),
            &authority(journal, AuthorityState::Pending),
            false,
        )?;
    }
    let destination = &journal.plan.destination_root;
    let created = match fs::create_dir(destination) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(error.into()),
    };
    let metadata = fs::symlink_metadata(destination)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || fs::canonicalize(destination)? != *destination
    {
        return Err(PortcoveError::verification(
            "library destination was replaced or redirected",
        ));
    }
    if !created && library_authority::authority(destination)?.is_none() {
        // Do not create lock files in an unrelated directory that appeared after review.
        library_authority::verify_receipt(destination, &journal.transfer_id)?;
    }
    let lease = Arc::new(LibraryLease::with_access(
        destination,
        LibraryAccess::Exclusive,
    )?);
    if created {
        library_authority::write_authority(
            destination,
            &authority(journal, AuthorityState::Pending),
            false,
        )?;
        crate::durability::sync_publication(
            destination
                .parent()
                .ok_or_else(|| PortcoveError::state("destination has no parent"))?,
        )?;
    } else if library_authority::authority(destination)?.is_none() {
        // A successfully activated copy may have legitimate new saves. Never replay old data over it.
        library_authority::verify_receipt(destination, &journal.transfer_id)?;
        if marker
            .as_ref()
            .is_none_or(|marker| marker.state != AuthorityState::Moved)
            || !matches!(
                journal.phase,
                TransferPhase::Published | TransferPhase::Complete
            )
        {
            return Err(PortcoveError::verification(
                "destination became active outside the recorded publication sequence",
            ));
        }
        let target = Library::initialize(destination.clone(), lease)?;
        return finish_move(&target, journal);
    }
    require_pending(destination, journal)?;
    checkpoint(TransferPhase::Copying)?;
    crate::library_transfer::verify_source_plan(source, &journal.plan)?;
    crate::transfer_copy::copy_content(
        &journal.plan.source_root,
        &journal.plan.destination_root,
        &journal.plan.content,
    )?;
    crate::transfer_copy::copy_database(source, &journal.plan)?;
    let target = Library::initialize(destination.clone(), lease)?;
    crate::transfer_copy::verify_destination(
        &target,
        &journal.plan.metadata,
        &journal.plan.content,
    )?;
    // Reject out-of-band edits to the retained source as well as destination corruption.
    crate::library_transfer::verify_source_plan(source, &journal.plan)?;
    if library_authority::verify_receipt(destination, &journal.transfer_id).is_err() {
        library_authority::write_receipt(destination, &journal.transfer_id)?;
    }
    journal.phase = TransferPhase::Verified;
    journal.write()?;
    checkpoint(TransferPhase::Verified)?;
    library_authority::write_authority(
        source.root(),
        &authority(journal, AuthorityState::Moved),
        true,
    )?;
    journal.phase = TransferPhase::Published;
    journal.write()?;
    checkpoint(TransferPhase::Published)?;
    library_authority::activate_destination(destination, &journal.transfer_id)?;
    checkpoint(TransferPhase::Complete)?;
    finish_move(&target, journal)
}

fn finish_move(target: &Library, journal: &mut TransferJournal) -> Result<LibraryMoveResult> {
    finish_move_activity(
        target,
        &journal.transfer_id,
        ActivityStatus::Succeeded,
        "Library move verified and activated; original directory retained for recovery",
    )?;
    journal.phase = TransferPhase::Complete;
    journal.write()?;
    Ok(result(journal, true))
}

fn finish_move_activity(
    library: &Library,
    id: &str,
    status: ActivityStatus,
    message: &str,
) -> Result<()> {
    library.finish_activity_once(id, status, message)
}

fn ensure_move_activity(library: &Library, journal: &TransferJournal) -> Result<()> {
    let exists: bool = library.connection()?.query_row(
        "SELECT EXISTS(SELECT 1 FROM activity_history WHERE id=?1)",
        [&journal.transfer_id],
        |row| row.get(0),
    )?;
    if !exists {
        if journal.phase != TransferPhase::Copying
            || journal
                .plan
                .destination_root
                .join("portcove.sqlite3")
                .exists()
        {
            return Err(PortcoveError::verification(
                "published transfer activity is missing",
            ));
        }
        let id = uuid::Uuid::parse_str(&journal.transfer_id)
            .map_err(|_| PortcoveError::state("transfer ID is invalid"))?;
        library.begin_identified_activity(
            id,
            ActivityOperation::MoveLibrary,
            ActivityTargetKind::Library,
            None,
        )?;
    }
    Ok(())
}

fn authority(journal: &TransferJournal, state: AuthorityState) -> LibraryAuthority {
    LibraryAuthority {
        schema_version: 1,
        transfer_id: journal.transfer_id.clone(),
        state,
        destination: journal.plan.destination_root.clone(),
    }
}

fn require_pending(root: &Path, journal: &TransferJournal) -> Result<()> {
    let marker = library_authority::authority(root)?.ok_or_else(|| {
        PortcoveError::conflict(
            "an existing destination has no matching transfer marker; it was retained unchanged",
        )
    })?;
    if marker.state != AuthorityState::Pending
        || marker.transfer_id != journal.transfer_id
        || marker.destination != journal.plan.destination_root
    {
        return Err(PortcoveError::verification(
            "destination belongs to another library transfer",
        ));
    }
    Ok(())
}

fn result(journal: &TransferJournal, completed: bool) -> LibraryMoveResult {
    LibraryMoveResult {
        transfer_id: journal.transfer_id.clone(),
        source_root: journal.plan.source_root.clone(),
        destination_root: journal.plan.destination_root.clone(),
        active_root: if completed {
            journal.plan.destination_root.clone()
        } else {
            journal.plan.source_root.clone()
        },
        source_retained: true,
        completed,
    }
}

fn recovery_error(error: PortcoveError, journal: &TransferJournal) -> PortcoveError {
    error
        .detail("transfer_id", &journal.transfer_id)
        .detail("recovery_action", "library resume-move")
        .detail(
            "retained_source",
            journal.plan.source_root.display().to_string(),
        )
        .detail(
            "destination",
            journal.plan.destination_root.display().to_string(),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ArtifactIdentity, ErrorCode, InstallQualification, InstallRecord, Installer, ReleaseChannel,
    };

    fn fixture(root: &Path) -> PortcoveService {
        let library = Library::open(root).unwrap();
        for (id, staged) in [("old", false), ("active", false), ("staged", true)] {
            let path = root.join("versions/starship").join(id);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("game.exe"), format!("synthetic application {id}")).unwrap();
            let artifact = ArtifactIdentity {
                asset_name: format!("{id}.zip"),
                sha256: "a".repeat(64),
                size: 123,
            };
            let qualification = InstallQualification::test("game.exe");
            let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
                .unwrap()
                .create_manifest(id, "starship", id, &artifact, &qualification, &path)
                .unwrap();
            library
                .register_install(
                    &InstallRecord {
                        id: id.into(),
                        port_id: "starship".into(),
                        version: id.into(),
                        path,
                        channel: ReleaseChannel::Stable,
                        installed_at: 1,
                        verified: true,
                        staged,
                        artifact,
                        manifest_sha256,
                        selected_executable,
                        runtime,
                    },
                    !staged,
                )
                .unwrap();
        }
        for (tree, bytes) in [
            ("user", b"save".as_slice()),
            ("backups", b"backup"),
            ("toolchains", b"tool"),
        ] {
            fs::create_dir_all(root.join(tree).join("starship")).unwrap();
            fs::write(root.join(tree).join("starship/data.bin"), bytes).unwrap();
        }
        PortcoveService::new(library).unwrap()
    }

    #[test]
    fn move_preserves_metadata_content_and_manifest_identity_and_redirects_old_handles() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let service = fixture(&source);
        let plan = service.plan_library_move(&destination).unwrap();
        assert_eq!(
            PortcoveService::move_library(&source, &destination, &plan.plan_sha256)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        drop(service);
        let moved =
            PortcoveService::move_library(&source, &destination, &plan.plan_sha256).unwrap();
        assert!(moved.completed);
        let library = Library::open(&source).unwrap();
        assert_eq!(library.root(), fs::canonicalize(&destination).unwrap());
        let status = library.status("starship", ReleaseChannel::Stable).unwrap();
        assert_eq!(status.active.unwrap().id, "active");
        assert_eq!(status.previous.unwrap().id, "old");
        assert_eq!(status.staged.unwrap().id, "staged");
        for tree in ["user", "backups", "toolchains"] {
            assert_eq!(
                fs::read(source.join(tree).join("starship/data.bin")).unwrap(),
                fs::read(destination.join(tree).join("starship/data.bin")).unwrap()
            );
        }
        assert_eq!(
            library.activities(10).unwrap()[0].status,
            ActivityStatus::Succeeded
        );
        assert_eq!(
            PortcoveService::abort_library_move(&source)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn every_recorded_move_boundary_recovers_without_two_writable_libraries() {
        for fault in [
            TransferPhase::Copying,
            TransferPhase::Verified,
            TransferPhase::Published,
            TransferPhase::Complete,
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let source = temporary.path().join("source");
            let destination = temporary.path().join("destination");
            let service = fixture(&source);
            let plan = service.plan_library_move(&destination).unwrap();
            drop(service);
            let error = start_move(&source, &destination, &plan.plan_sha256, &|phase| {
                if phase == fault {
                    Err(PortcoveError::state("simulated process interruption"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
            assert_eq!(error.message, "simulated process interruption");
            if fault == TransferPhase::Complete {
                let current = Library::open(&source).unwrap();
                assert_eq!(current.root(), fs::canonicalize(&destination).unwrap());
                fs::write(
                    destination.join("user/starship/data.bin"),
                    b"new save after activation",
                )
                .unwrap();
            } else {
                assert!(Library::open(&source).is_err());
                assert!(Library::open(&destination).is_err());
            }
            assert!(
                PortcoveService::resume_library_move(&source)
                    .unwrap()
                    .completed
            );
            assert!(
                PortcoveService::resume_library_move(&source)
                    .unwrap()
                    .completed
            );
            assert_eq!(
                fs::read(source.join("user/starship/data.bin")).unwrap(),
                b"save"
            );
            if fault == TransferPhase::Complete {
                assert_eq!(
                    fs::read(destination.join("user/starship/data.bin")).unwrap(),
                    b"new save after activation"
                );
            }
        }
    }

    #[test]
    fn changed_source_or_destination_stops_recovery_and_abort_retains_both_copies() {
        for change_source in [true, false] {
            let temporary = tempfile::tempdir().unwrap();
            let source = temporary.path().join("source");
            let destination = temporary.path().join("destination");
            let service = fixture(&source);
            let plan = service.plan_library_move(&destination).unwrap();
            drop(service);
            start_move(&source, &destination, &plan.plan_sha256, &|phase| {
                if phase == TransferPhase::Verified {
                    Err(PortcoveError::state("interruption"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
            let changed = if change_source { &source } else { &destination };
            fs::write(
                changed.join("user/starship/data.bin"),
                b"retained changed save",
            )
            .unwrap();
            assert!(PortcoveService::resume_library_move(&source).is_err());
            assert!(
                !PortcoveService::abort_library_move(&source)
                    .unwrap()
                    .completed
            );
            let reopened = Library::open(&source).unwrap();
            assert_eq!(
                fs::canonicalize(reopened.root()).unwrap(),
                fs::canonicalize(&source).unwrap()
            );
            assert!(Library::open(&destination).is_err());
            assert_eq!(
                fs::read(changed.join("user/starship/data.bin")).unwrap(),
                b"retained changed save"
            );
        }
    }

    #[test]
    fn damaged_application_and_stale_review_never_activate_a_copy() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let service = fixture(&source);
        let plan = service.plan_library_move(&destination).unwrap();
        fs::write(
            source.join("versions/starship/active/game.exe"),
            b"changed application",
        )
        .unwrap();
        drop(service);
        assert_eq!(
            PortcoveService::move_library(&source, &destination, &plan.plan_sha256)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(!destination.exists());
        let service = PortcoveService::new(Library::open(&source).unwrap()).unwrap();
        let plan = service.plan_library_move(&destination).unwrap();
        drop(service);
        assert_eq!(
            PortcoveService::move_library(&source, &destination, &plan.plan_sha256)
                .unwrap_err()
                .code,
            ErrorCode::Verification
        );
        assert!(Library::open(&source).is_err());
        PortcoveService::abort_library_move(&source).unwrap();
        assert_eq!(
            fs::read(source.join("versions/starship/active/game.exe")).unwrap(),
            b"changed application"
        );
    }

    #[test]
    fn recovery_handles_journal_creation_and_abort_marker_removal_interruptions() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let destination = temporary.path().join("destination");
        let service = fixture(&source);
        let plan = service.plan_library_move(&destination).unwrap();
        let mut journal = TransferJournal {
            schema_version: 1,
            transfer_id: uuid::Uuid::new_v4().to_string(),
            plan,
            phase: TransferPhase::Copying,
        };
        journal.create().unwrap();
        drop(service);
        // A crash after creating an empty destination but before its marker must
        // permit abort without claiming or deleting the unmarked directory.
        fs::create_dir(&destination).unwrap();
        assert!(PortcoveService::resume_library_move(&source).is_err());
        PortcoveService::abort_library_move(&source).unwrap();
        assert!(
            fs::read_dir(&destination)
                .unwrap()
                .all(|entry| entry.unwrap().file_name() == "locks")
        );
        let source = fs::canonicalize(&source).unwrap();
        library_authority::write_authority(
            &source,
            &authority(&journal, AuthorityState::Pending),
            false,
        )
        .unwrap();
        journal.phase = TransferPhase::Aborted;
        journal.write().unwrap();
        PortcoveService::abort_library_move(&source).unwrap();
        assert!(Library::open(&source).is_ok());
    }
}
