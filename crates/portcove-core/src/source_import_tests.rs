use super::*;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use sha1::Sha1;

use crate::{
    Catalog, DigestIdentity, DigestScope, ErrorCode, Library, ObservedSourceComponent,
    ObservedSourceDigest, ObservedSourceIdentity, ObservedSourceValidator, SourceComponentKind,
    SourceDigestAlgorithm, SourceRepresentationKind, SourceValidatorResult,
    operation::{LifecycleFaultInjector, LifecycleFaultPoint},
};

const PROFILE: &str = "opengoal-jak1-disc";

#[derive(Debug)]
struct FailAt(LifecycleFaultPoint);

impl LifecycleFaultInjector for FailAt {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == self.0 {
            Err(PortcoveError::state("simulated source import interruption"))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug)]
struct RejectPublicationPhaseWrite {
    library: Library,
    armed: AtomicBool,
}

impl LifecycleFaultInjector for RejectPublicationPhaseWrite {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::SourceImportBeforePublicationRecorded
            && !self.armed.swap(true, Ordering::SeqCst)
        {
            self.library.connection()?.execute_batch(
                "CREATE TRIGGER reject_source_import_publication_phase
                 BEFORE UPDATE OF phase ON lifecycle_operations
                 WHEN NEW.phase='payload_published'
                 BEGIN SELECT RAISE(ABORT, 'simulated publication journal failure'); END;",
            )?;
        }
        Ok(())
    }
}

#[derive(Debug)]
struct ReplacePublishedAtFinalOwnershipCheck {
    source: PathBuf,
    destination: PathBuf,
    fired: AtomicBool,
}

impl LifecycleFaultInjector for ReplacePublishedAtFinalOwnershipCheck {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::SourceImportBeforePublicationOwnershipRecorded
            && !self.fired.swap(true, Ordering::SeqCst)
        {
            let replacement = self.destination.with_extension("replacement");
            fs::copy(&self.source, &replacement)?;
            fs::remove_file(&self.destination)?;
            fs::rename(replacement, &self.destination)?;
        }
        Ok(())
    }
}

#[derive(Debug)]
struct CreateLateDestination {
    destination: PathBuf,
    sentinel: Vec<u8>,
    created_identity: Mutex<Option<String>>,
    fired: AtomicBool,
}

impl LifecycleFaultInjector for CreateLateDestination {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::SourceImportPublicationPrepared
            && !self.fired.swap(true, Ordering::SeqCst)
        {
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&self.destination)?;
            use std::io::Write;
            file.write_all(&self.sentinel)?;
            file.sync_all()?;
            *self.created_identity.lock().unwrap() = Some(object_identity(&self.destination)?);
        }
        Ok(())
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct HoldStagingWithoutDeleteSharing {
    profile_directory: PathBuf,
    destination_name: std::ffi::OsString,
    held: Mutex<Option<File>>,
}

#[cfg(windows)]
impl LifecycleFaultInjector for HoldStagingWithoutDeleteSharing {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == LifecycleFaultPoint::SourceImportPublicationPrepared
            && self.held.lock().unwrap().is_none()
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

            let staging_root = fs::read_dir(&self.profile_directory)?
                .collect::<std::io::Result<Vec<_>>>()?
                .into_iter()
                .find(|entry| {
                    entry.file_name().to_str().is_some_and(|name| {
                        name.starts_with(".portcove-import-") && name.ends_with(".staging")
                    })
                })
                .ok_or_else(|| PortcoveError::state("source import staging root was not found"))?;
            let staging = staging_root.path().join(&self.destination_name);
            let file = fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(staging)?;
            *self.held.lock().unwrap() = Some(file);
        }
        Ok(())
    }
}

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

fn library_fixture() -> (tempfile::TempDir, Library, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let source = temporary.path().join("original").join("disc.iso");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::write(&source, b"synthetic format-only disc source").unwrap();
    (temporary, library, source)
}

fn fixture() -> (tempfile::TempDir, Library, PortcoveService, PathBuf) {
    let (temporary, library, source) = library_fixture();
    let service = PortcoveService::new(library.clone()).unwrap();
    (temporary, library, service, source)
}

fn import(service: &PortcoveService, source: &Path, mode: SourceImportMode) -> SourceImportResult {
    import_profile(service, PROFILE, source, mode)
}

fn import_profile(
    service: &PortcoveService,
    profile_id: &str,
    source: &Path,
    mode: SourceImportMode,
) -> SourceImportResult {
    let plan = service
        .plan_source_import(profile_id, source, mode)
        .unwrap();
    let authorization = (mode == SourceImportMode::Move).then(|| {
        service
            .authorize_source_move(profile_id, source, &plan.plan_sha256)
            .unwrap()
            .token
    });
    service
        .import_source(
            profile_id,
            source,
            mode,
            &plan.plan_sha256,
            authorization.as_deref(),
        )
        .unwrap()
}

#[test]
fn copy_is_reviewed_destination_local_verified_and_non_destructive() {
    let (_temporary, _library, service, source) = fixture();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap();
    assert_eq!(plan.destination.file_name().unwrap(), "disc.iso");
    assert!(!plan.destination.exists());
    assert!(service.library().source(PROFILE).unwrap().is_none());

    let result = service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Copy,
            &plan.plan_sha256,
            None,
        )
        .unwrap();
    assert_eq!(result.outcome, SourceImportOutcome::Copied);
    assert!(result.copied);
    assert!(result.original_retained);
    assert!(!result.original_deleted);
    assert_eq!(
        fs::read(&source).unwrap(),
        fs::read(&result.registered.path).unwrap()
    );
    assert_eq!(
        service.library().source(PROFILE).unwrap().unwrap().path,
        result.registered.path
    );
}

#[test]
fn late_destination_collision_preserves_copy_sentinel_original_and_recovery() {
    assert_late_destination_collision_is_safe(
        SourceImportMode::Copy,
        b"unrelated late copy destination".to_vec(),
    );
}

#[test]
fn late_destination_collision_preserves_move_sentinel_original_and_recovery() {
    assert_late_destination_collision_is_safe(
        SourceImportMode::Move,
        b"unrelated late move destination".to_vec(),
    );
}

#[test]
fn same_content_late_destination_with_different_identity_is_still_a_collision() {
    for mode in [SourceImportMode::Copy, SourceImportMode::Move] {
        assert_late_destination_collision_is_safe(
            mode,
            b"synthetic format-only disc source".to_vec(),
        );
    }
}

#[cfg(windows)]
#[test]
fn sharing_failure_retains_move_original_and_resumes_after_handle_release() {
    let (_temporary, library, service, source) = fixture();
    let original = fs::read(&source).unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Move)
        .unwrap();
    let fault = Arc::new(HoldStagingWithoutDeleteSharing {
        profile_directory: plan.destination.parent().unwrap().to_path_buf(),
        destination_name: plan.destination.file_name().unwrap().to_os_string(),
        held: Mutex::new(None),
    });
    let service = PortcoveService::with_faults(library.clone(), fault.clone()).unwrap();
    let authorization = service
        .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
        .unwrap();

    let error = service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            Some(&authorization.token),
        )
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::State);
    assert_eq!(fs::read(&source).unwrap(), original);
    assert!(!plan.destination.exists());
    assert!(service.library().source(PROFILE).unwrap().is_none());
    let retained = OperationStore::new(library.clone()).all().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].phase, LifecyclePhase::Prepared);
    assert!(retained[0].paths.staging.as_ref().unwrap().exists());
    *fault.held.lock().unwrap() = None;
    drop(service);

    let recovered = PortcoveService::new(library.clone()).unwrap();
    let registered = recovered.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(registered.path, plan.destination);
    assert_eq!(fs::read(registered.path).unwrap(), original);
    assert!(!source.exists());
    assert!(OperationStore::new(library).all().unwrap().is_empty());
}

fn assert_late_destination_collision_is_safe(mode: SourceImportMode, sentinel: Vec<u8>) {
    let (_temporary, library, service, source) = fixture();
    let original = fs::read(&source).unwrap();
    let plan = service.plan_source_import(PROFILE, &source, mode).unwrap();
    let fault = Arc::new(CreateLateDestination {
        destination: plan.destination.clone(),
        sentinel: sentinel.clone(),
        created_identity: Mutex::new(None),
        fired: AtomicBool::new(false),
    });
    let service = PortcoveService::with_faults(library.clone(), fault.clone()).unwrap();
    let authorization = (mode == SourceImportMode::Move).then(|| {
        service
            .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
            .unwrap()
            .token
    });

    let result = service.import_source(
        PROFILE,
        &source,
        mode,
        &plan.plan_sha256,
        authorization.as_deref(),
    );

    assert!(
        result.is_err(),
        "{mode:?} falsely reported successful publication"
    );
    let sentinel_identity = fault.created_identity.lock().unwrap().clone().unwrap();
    assert_eq!(fs::read(&plan.destination).unwrap(), sentinel, "{mode:?}");
    assert_eq!(
        object_identity(&plan.destination).unwrap(),
        sentinel_identity,
        "{mode:?}"
    );
    assert_eq!(fs::read(&source).unwrap(), original, "{mode:?}");
    assert!(
        service.library().source(PROFILE).unwrap().is_none(),
        "{mode:?}"
    );
    let retained = OperationStore::new(library.clone()).all().unwrap();
    assert_eq!(retained.len(), 1, "{mode:?}");
    assert_eq!(retained[0].phase, LifecyclePhase::Prepared, "{mode:?}");
    let staging = retained[0].paths.staging.clone().unwrap();
    assert!(staging.exists(), "{mode:?}");
    drop(service);

    let conflicted_restart = PortcoveService::new(library.clone()).unwrap();
    assert!(
        conflicted_restart
            .library()
            .source(PROFILE)
            .unwrap()
            .is_none(),
        "{mode:?}"
    );
    assert_eq!(fs::read(&plan.destination).unwrap(), sentinel, "{mode:?}");
    assert_eq!(
        object_identity(&plan.destination).unwrap(),
        sentinel_identity,
        "{mode:?}"
    );
    assert_eq!(fs::read(&source).unwrap(), original, "{mode:?}");
    assert!(staging.exists(), "{mode:?}");
    let retained = OperationStore::new(library.clone()).all().unwrap();
    assert_eq!(retained.len(), 1, "{mode:?}");
    assert_eq!(retained[0].phase, LifecyclePhase::Prepared, "{mode:?}");
    assert!(retained[0].last_error.is_some(), "{mode:?}");
    drop(conflicted_restart);

    fs::remove_file(&plan.destination).unwrap();
    let recovered = PortcoveService::new(library.clone()).unwrap();
    let registered = recovered.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(registered.path, plan.destination, "{mode:?}");
    assert_eq!(fs::read(&registered.path).unwrap(), original, "{mode:?}");
    assert_eq!(source.exists(), mode == SourceImportMode::Copy, "{mode:?}");
    assert!(
        OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty(),
        "{mode:?}"
    );
    let registration_count: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM sources WHERE profile_id=?1",
            [PROFILE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(registration_count, 1, "{mode:?}");
}

#[test]
fn current_location_registers_without_copying() {
    let (_temporary, _library, service, source) = fixture();
    let current = import(&service, &source, SourceImportMode::UseCurrentLocation);
    assert_eq!(
        current.outcome,
        SourceImportOutcome::RegisteredCurrentLocation
    );
    assert_eq!(current.registered.path, fs::canonicalize(&source).unwrap());
    assert!(source.exists());
}

#[test]
fn removal_leaves_copied_inbox_bytes() {
    let (_temporary, _library, service, source) = fixture();
    let copied = import(&service, &source, SourceImportMode::Copy);
    let inbox_path = copied.registered.path.clone();
    let preview = service.preview_source_removal(PROFILE).unwrap();
    let authorization = service
        .authorize_source_removal(PROFILE, &preview.preview_sha256)
        .unwrap();
    service
        .remove_source(PROFILE, &authorization.token)
        .unwrap();
    assert!(service.library().source(PROFILE).unwrap().is_none());
    assert!(inbox_path.exists());
}

#[test]
fn move_requires_single_use_authorization_and_deletes_only_after_registration() {
    let (_temporary, _library, service, source) = fixture();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Move)
        .unwrap();
    let denied = service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            None,
        )
        .unwrap_err();
    assert_eq!(denied.code, ErrorCode::Conflict);
    assert!(source.exists());
    assert!(!plan.destination.exists());

    let authorization = service
        .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
        .unwrap();
    let result = service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            Some(&authorization.token),
        )
        .unwrap();
    assert_eq!(result.outcome, SourceImportOutcome::Moved);
    assert!(result.original_deleted);
    assert!(!source.exists());
    assert!(result.registered.path.exists());
    assert_eq!(
        service.library().source(PROFILE).unwrap().unwrap().path,
        result.registered.path
    );
}

#[test]
fn collision_names_are_deterministic_and_complete_existing_bytes_are_reused() {
    let (temporary, _library, service, source) = fixture();
    let profile = service.library().source_inbox_profile_dir(PROFILE).unwrap();
    fs::create_dir(&profile).unwrap();
    fs::write(profile.join("disc.iso"), b"different existing source").unwrap();

    let first = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap();
    assert_ne!(first.destination.file_name().unwrap(), "disc.iso");
    assert!(
        first
            .destination
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("disc-")
    );
    let imported = service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Copy,
            &first.plan_sha256,
            None,
        )
        .unwrap();

    let second_source = temporary.path().join("second").join("disc.iso");
    fs::create_dir(second_source.parent().unwrap()).unwrap();
    fs::copy(&source, &second_source).unwrap();
    let second = service
        .plan_source_import(PROFILE, &second_source, SourceImportMode::Copy)
        .unwrap();
    assert_eq!(second.destination, imported.registered.path);
    assert!(second.reuse_existing);
    assert_eq!(second.required_bytes, 0);
    let reused = service
        .import_source(
            PROFILE,
            &second_source,
            SourceImportMode::Copy,
            &second.plan_sha256,
            None,
        )
        .unwrap();
    assert_eq!(reused.outcome, SourceImportOutcome::ReusedExisting);
    assert!(!reused.copied);
}

#[test]
fn changed_source_and_hard_link_aliases_fail_before_publication() {
    let (_temporary, _library, service, source) = fixture();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap();
    fs::write(&source, b"changed after review").unwrap();
    let error = service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Copy,
            &plan.plan_sha256,
            None,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(!plan.destination.exists());

    fs::write(&source, b"synthetic format-only disc source").unwrap();
    let profile = service.library().source_inbox_profile_dir(PROFILE).unwrap();
    fs::create_dir(&profile).unwrap();
    fs::hard_link(&source, profile.join("disc.iso")).unwrap();
    let alias = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap_err();
    assert_eq!(alias.code, ErrorCode::Conflict);
}

#[test]
fn copy_and_move_reject_sources_that_contain_or_are_inside_the_inbox() {
    let (temporary, _library, service, source) = fixture();
    let contains_inbox = service
        .plan_source_import(PROFILE, temporary.path(), SourceImportMode::Copy)
        .unwrap_err();
    assert_eq!(contains_inbox.code, ErrorCode::Conflict);

    let profile = service.library().source_inbox_profile_dir(PROFILE).unwrap();
    fs::create_dir(&profile).unwrap();
    let inbox_source = profile.join("already-there.iso");
    fs::copy(source, &inbox_source).unwrap();
    let inside_inbox = service
        .plan_source_import(PROFILE, &inbox_source, SourceImportMode::Move)
        .unwrap_err();
    assert_eq!(inside_inbox.code, ErrorCode::Conflict);
}

#[test]
fn deletion_failure_reports_a_valid_copy_and_the_exact_retained_original() {
    let (_temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library,
        Arc::new(FailAt(LifecycleFaultPoint::SourceImportDeleteAttempt)),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Move)
        .unwrap();
    let authorization = service
        .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
        .unwrap();
    let result = service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            Some(&authorization.token),
        )
        .unwrap();
    assert_eq!(result.outcome, SourceImportOutcome::CopiedOriginalRetained);
    assert!(result.registered.path.exists());
    let retained = result.retained_original_path.unwrap();
    assert!(retained.exists());
    assert_eq!(
        fs::read(retained).unwrap(),
        fs::read(result.registered.path).unwrap()
    );
    assert!(
        OperationStore::new(service.library().clone())
            .all()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn single_file_cleanup_accepts_only_the_quarantine_basename_change() {
    let temporary = tempfile::tempdir().unwrap();
    let quarantine = temporary
        .path()
        .join(".portcove-source-import-id.retained.chd");
    fs::write(&quarantine, b"optical source").unwrap();
    let original = observed_optical_record("game.chd");
    let mut quarantined = original.clone();
    quarantined.observed_identity.as_mut().unwrap().components[0].name = Some(
        quarantine
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    );

    assert!(!equivalent(&original, &quarantined));
    assert!(cleanup_source_equivalent(
        &quarantine,
        &original,
        &quarantined
    ));
}

#[test]
fn single_file_cleanup_keeps_every_material_observation_bound() {
    let temporary = tempfile::tempdir().unwrap();
    let quarantine = temporary
        .path()
        .join(".portcove-source-import-id.retained.chd");
    fs::write(&quarantine, b"optical source").unwrap();
    let original = observed_optical_record("game.chd");
    let mut quarantined = original.clone();
    quarantined.observed_identity.as_mut().unwrap().components[0].name = Some(
        quarantine
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    );

    let mut changed = quarantined.clone();
    changed.observed_identity.as_mut().unwrap().components[0].id = "disc-2".into();
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));

    let mut changed = quarantined.clone();
    changed.observed_identity.as_mut().unwrap().components[0].kind =
        SourceComponentKind::FileSetMember;
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));

    let mut changed = quarantined.clone();
    changed.observed_identity.as_mut().unwrap().components[0].size += 1;
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));

    let mut changed = quarantined.clone();
    changed.observed_identity.as_mut().unwrap().components[0].track_count = Some(2);
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));

    let mut changed = quarantined.clone();
    changed.observed_identity.as_mut().unwrap().components[0].volume_id = Some("SLUS_99999".into());
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));

    let mut changed = quarantined.clone();
    changed.observed_identity.as_mut().unwrap().components[0].digests[0].value = "0".repeat(64);
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));

    let mut changed = quarantined.clone();
    changed.observed_identity.as_mut().unwrap().digests[0].size += 1;
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));

    let mut changed = quarantined.clone();
    changed.observed_identity.as_mut().unwrap().schema_version += 1;
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));

    let mut changed = quarantined.clone();
    changed
        .observed_identity
        .as_mut()
        .unwrap()
        .archive_member_name = Some("disc.chd".into());
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));

    let mut changed = quarantined;
    changed.observed_identity.as_mut().unwrap().validator = Some(ObservedSourceValidator {
        contract_id: "disc-validator".into(),
        tool_id: "disc-tool".into(),
        protocol_version: "1".into(),
        result: SourceValidatorResult::Passed,
    });
    assert!(!cleanup_source_equivalent(&quarantine, &original, &changed));
}

#[test]
fn multi_disc_and_file_set_name_changes_remain_strict() {
    let temporary = tempfile::tempdir().unwrap();
    let quarantine_file = temporary.path().join("retained.chd");
    fs::write(&quarantine_file, b"optical source").unwrap();

    let original = observed_optical_record("disc-1.chd");
    let mut file_set = original.clone();
    file_set.observed_identity.as_mut().unwrap().components[0].kind =
        SourceComponentKind::FileSetMember;
    let mut renamed_file_set = file_set.clone();
    renamed_file_set
        .observed_identity
        .as_mut()
        .unwrap()
        .components[0]
        .name = Some("different-member.chd".into());
    assert!(!cleanup_source_equivalent(
        &quarantine_file,
        &file_set,
        &renamed_file_set
    ));

    let quarantine_directory = temporary.path().join("retained-discs");
    fs::create_dir(&quarantine_directory).unwrap();
    let mut multi_disc = original.clone();
    let mut disc_two = multi_disc.observed_identity.as_ref().unwrap().components[0].clone();
    disc_two.id = "disc-2".into();
    disc_two.name = Some("disc-2.chd".into());
    multi_disc
        .observed_identity
        .as_mut()
        .unwrap()
        .components
        .push(disc_two);
    let mut renamed_multi_disc = multi_disc.clone();
    renamed_multi_disc
        .observed_identity
        .as_mut()
        .unwrap()
        .components[0]
        .name = Some("renamed-disc-1.chd".into());
    assert!(!equivalent(&multi_disc, &renamed_multi_disc));
    assert!(!cleanup_source_equivalent(
        &quarantine_directory,
        &multi_disc,
        &renamed_multi_disc
    ));
    assert!(!cleanup_source_equivalent(
        &quarantine_file,
        &multi_disc,
        &renamed_multi_disc
    ));
}

fn observed_optical_record(name: &str) -> SourceRecord {
    SourceRecord {
        profile_id: "optical-profile".into(),
        path: PathBuf::from(name),
        sha256: "b".repeat(64),
        size: 2_048,
        storage_sha256: "c".repeat(64),
        storage_size: 1_024,
        updated_at: 1,
        observed_identity: Some(observed_optical_identity(name)),
    }
}

fn observed_optical_identity(name: &str) -> ObservedSourceIdentity {
    let digest = ObservedSourceDigest {
        algorithm: SourceDigestAlgorithm::Sha256,
        scope: DigestScope::PsxNormalizedTrackSet,
        value: "a".repeat(64),
        size: 2_048,
    };
    ObservedSourceIdentity {
        schema_version: 1,
        archive_member_name: None,
        digests: vec![digest.clone()],
        components: vec![ObservedSourceComponent {
            id: "disc-1".into(),
            kind: SourceComponentKind::OpticalDisc,
            name: Some(name.into()),
            digests: vec![digest],
            size: 2_048,
            track_count: Some(1),
            volume_id: Some("SLUS_01189".into()),
        }],
        validator: None,
    }
}

fn assert_durable_move_recovery(point: LifecycleFaultPoint) {
    let (_temporary, library, source) = library_fixture();
    eprintln!("{point:?}: fixture created");
    let service = PortcoveService::with_faults(library.clone(), Arc::new(FailAt(point))).unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Move)
        .unwrap();
    let authorization = service
        .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
        .unwrap();
    let error = service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            Some(&authorization.token),
        )
        .unwrap_err();
    assert_eq!(
        error.message, "simulated source import interruption",
        "{point:?}"
    );
    drop(service);
    eprintln!("{point:?}: interruption recorded; recovering");

    let recovered = PortcoveService::new(library.clone()).unwrap();
    let registered = recovered.library().source(PROFILE).unwrap().unwrap();
    assert!(registered.path.exists(), "{point:?}");
    assert!(!source.exists(), "{point:?}");
    assert!(
        OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    let activity = recovered
        .library()
        .activities(20)
        .unwrap()
        .into_iter()
        .find(|activity| activity.operation == ActivityOperation::ImportSource)
        .unwrap();
    assert_eq!(activity.status, ActivityStatus::Succeeded, "{point:?}");
    assert_eq!(
        activity.message.as_deref(),
        Some("Source copied, verified, registered, and original removed"),
        "{point:?}"
    );
    drop(recovered);
    eprintln!("{point:?}: recovery verified; checking idempotence");
    let recovered_again = PortcoveService::new(library.clone()).unwrap();
    let registered_again = recovered_again.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(registered_again.path, registered.path, "{point:?}");
    assert_eq!(registered_again.sha256, registered.sha256, "{point:?}");
}

#[test]
fn recovers_journaled_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportJournaled);
}

#[test]
fn recovers_copy_started_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportCopyStarted);
}

#[test]
fn recovers_copied_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportCopied);
}

#[test]
fn recovers_verified_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportVerified);
}

#[test]
fn recovers_publication_prepared_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportPublicationPrepared);
}

#[test]
fn recovers_before_publication_recorded_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportBeforePublicationRecorded);
}

#[test]
fn recovers_before_publication_ownership_recorded_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(
        LifecycleFaultPoint::SourceImportBeforePublicationOwnershipRecorded,
    );
}

#[test]
fn recovers_published_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportPublished);
}

#[test]
fn recovers_registered_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportRegistered);
}

#[test]
fn recovers_original_quarantined_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportOriginalQuarantined);
}

#[test]
fn recovers_cleanup_completed_without_deleting_unverified_bytes() {
    assert_durable_move_recovery(LifecycleFaultPoint::SourceImportCleanupCompleted);
}

#[test]
fn copy_recovers_after_publication_before_phase_persistence_and_registers_once() {
    let (_temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(FailAt(
            LifecycleFaultPoint::SourceImportBeforePublicationRecorded,
        )),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap();
    service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Copy,
            &plan.plan_sha256,
            None,
        )
        .unwrap_err();
    let interrupted = OperationStore::new(library.clone()).all().unwrap();
    assert_eq!(interrupted.len(), 1);
    assert_eq!(interrupted[0].phase, LifecyclePhase::Prepared);
    assert!(!interrupted[0].paths.staging.as_ref().unwrap().exists());
    let staging_root = interrupted[0]
        .paths
        .staging
        .as_ref()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    assert!(plan.destination.exists());
    assert!(source.exists());
    drop(service);

    let recovered = PortcoveService::new(library.clone()).unwrap();
    let registered = recovered.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(registered.path, plan.destination);
    assert!(registered.path.exists());
    assert!(source.exists());
    assert!(
        OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    assert!(!staging_root.exists());
    let registration_count: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM sources WHERE profile_id=?1",
            [PROFILE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(registration_count, 1);
    drop(recovered);

    let recovered_again = PortcoveService::new(library.clone()).unwrap();
    let registered_again = recovered_again.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(registered_again.path, registered.path);
    assert_eq!(registered_again.sha256, registered.sha256);
    assert_eq!(registered_again.storage_sha256, registered.storage_sha256);
    let registration_count: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM sources WHERE profile_id=?1",
            [PROFILE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(registration_count, 1);
}

#[test]
fn copy_recovers_when_publication_phase_write_fails() {
    assert_publication_phase_write_recovery(SourceImportMode::Copy);
}

#[test]
fn move_recovers_when_publication_phase_write_fails() {
    assert_publication_phase_write_recovery(SourceImportMode::Move);
}

fn assert_publication_phase_write_recovery(mode: SourceImportMode) {
    let (_temporary, library, source) = library_fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(RejectPublicationPhaseWrite {
            library: library.clone(),
            armed: AtomicBool::new(false),
        }),
    )
    .unwrap();
    let plan = service.plan_source_import(PROFILE, &source, mode).unwrap();
    let authorization = (mode == SourceImportMode::Move).then(|| {
        service
            .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
            .unwrap()
            .token
    });
    let error = service
        .import_source(
            PROFILE,
            &source,
            mode,
            &plan.plan_sha256,
            authorization.as_deref(),
        )
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("simulated publication journal failure")
    );
    let interrupted = OperationStore::new(library.clone()).all().unwrap();
    assert_eq!(interrupted.len(), 1);
    assert_eq!(interrupted[0].phase, LifecyclePhase::Prepared);
    assert!(!interrupted[0].paths.staging.as_ref().unwrap().exists());
    let staging_root = interrupted[0]
        .paths
        .staging
        .as_ref()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    assert!(plan.destination.exists());
    drop(service);

    library
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_source_import_publication_phase")
        .unwrap();
    let recovered = PortcoveService::new(library.clone()).unwrap();
    let registered = recovered.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(registered.path, plan.destination);
    assert_eq!(source.exists(), mode == SourceImportMode::Copy);
    assert!(
        OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    assert!(!staging_root.exists());
    let registration_count: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM sources WHERE profile_id=?1",
            [PROFILE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(registration_count, 1);
}

#[derive(Debug, Clone, Copy)]
enum PublicationMutation {
    BothPresent,
    BothAbsent,
    ChangedDestination,
    MissingReceipt,
    SameContentReplacement,
}

fn assert_prejournal_rejects(mutation: PublicationMutation) {
    let (_temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(FailAt(
            LifecycleFaultPoint::SourceImportBeforePublicationRecorded,
        )),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Move)
        .unwrap();
    let authorization = service
        .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
        .unwrap();
    service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            Some(&authorization.token),
        )
        .unwrap_err();
    let operation = OperationStore::new(library.clone())
        .all()
        .unwrap()
        .remove(0);
    let staging = operation.paths.staging.as_ref().unwrap();
    match mutation {
        PublicationMutation::BothPresent => {
            fs::copy(&plan.destination, staging).unwrap();
        }
        PublicationMutation::BothAbsent => {
            fs::remove_file(&plan.destination).unwrap();
        }
        PublicationMutation::ChangedDestination => {
            fs::write(&plan.destination, b"changed destination after publication").unwrap();
        }
        PublicationMutation::MissingReceipt => {
            fs::remove_file(publication_receipt_path(&operation, &plan).unwrap()).unwrap();
        }
        PublicationMutation::SameContentReplacement => {
            // Allocate while the original still exists so its file identity cannot
            // be recycled by the filesystem between removal and replacement.
            let replacement = plan.destination.with_extension("replacement");
            fs::copy(&source, &replacement).unwrap();
            fs::remove_file(&plan.destination).unwrap();
            fs::rename(replacement, &plan.destination).unwrap();
        }
    }
    drop(service);

    let recovered = PortcoveService::new(library.clone()).unwrap();
    assert!(recovered.library().source(PROFILE).unwrap().is_none());
    assert!(source.exists());
    let retained = OperationStore::new(library.clone()).all().unwrap();
    assert_eq!(retained.len(), 1, "{mutation:?}");
    assert_eq!(retained[0].phase, LifecyclePhase::Prepared, "{mutation:?}");
    assert!(retained[0].last_error.is_some(), "{mutation:?}");
    match mutation {
        PublicationMutation::BothPresent => {
            assert!(staging.exists());
            assert!(plan.destination.exists());
        }
        PublicationMutation::BothAbsent => {
            assert!(!staging.exists());
            assert!(!plan.destination.exists());
        }
        PublicationMutation::ChangedDestination
        | PublicationMutation::MissingReceipt
        | PublicationMutation::SameContentReplacement => {
            assert!(plan.destination.exists());
        }
    }
}

#[test]
fn prejournal_rejects_both_present() {
    assert_prejournal_rejects(PublicationMutation::BothPresent);
}

#[test]
fn prejournal_rejects_both_absent() {
    assert_prejournal_rejects(PublicationMutation::BothAbsent);
}

#[test]
fn prejournal_rejects_changed_destination() {
    assert_prejournal_rejects(PublicationMutation::ChangedDestination);
}

#[test]
fn prejournal_rejects_missing_receipt() {
    assert_prejournal_rejects(PublicationMutation::MissingReceipt);
}

#[test]
fn prejournal_rejects_same_content_replacement() {
    assert_prejournal_rejects(PublicationMutation::SameContentReplacement);
}

#[test]
fn final_publication_ownership_check_rejects_a_same_content_replacement() {
    let (_temporary, library, service, source) = fixture();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(ReplacePublishedAtFinalOwnershipCheck {
            source: source.clone(),
            destination: plan.destination.clone(),
            fired: AtomicBool::new(false),
        }),
    )
    .unwrap();

    let error = service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Copy,
            &plan.plan_sha256,
            None,
        )
        .unwrap_err();

    assert!(error.to_string().contains("does not own"));
    assert!(source.exists());
    assert!(plan.destination.exists());
    assert!(service.library().source(PROFILE).unwrap().is_none());
    let retained = OperationStore::new(library).all().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].phase, LifecyclePhase::Prepared);
}

#[test]
fn recovered_publication_rejects_a_redirected_receipt_root() {
    let (temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(FailAt(
            LifecycleFaultPoint::SourceImportBeforePublicationRecorded,
        )),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap();
    service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Copy,
            &plan.plan_sha256,
            None,
        )
        .unwrap_err();
    let operation = OperationStore::new(library.clone())
        .all()
        .unwrap()
        .remove(0);
    let receipt = publication_receipt_path(&operation, &plan).unwrap();
    let staging_root = receipt.parent().unwrap().to_path_buf();
    let redirected = temporary.path().join("redirected-receipt-root");
    fs::create_dir(&redirected).unwrap();
    fs::rename(&receipt, redirected.join(PUBLICATION_RECEIPT_FILE)).unwrap();
    fs::remove_dir(&staging_root).unwrap();
    if create_directory_symlink(&redirected, &staging_root).is_err() {
        return;
    }
    drop(service);

    let recovered = PortcoveService::new(library.clone()).unwrap();
    assert!(recovered.library().source(PROFILE).unwrap().is_none());
    assert!(source.exists());
    assert!(plan.destination.exists());
    let retained = OperationStore::new(library).all().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].phase, LifecyclePhase::Prepared);
    assert!(retained[0].last_error.is_some());
}

#[test]
fn receipt_cleanup_failure_is_retained_and_retried_before_registration() {
    let (_temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(FailAt(
            LifecycleFaultPoint::SourceImportBeforePublicationRecorded,
        )),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap();
    service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Copy,
            &plan.plan_sha256,
            None,
        )
        .unwrap_err();
    let operation = OperationStore::new(library.clone())
        .all()
        .unwrap()
        .remove(0);
    let staging_root = publication_receipt_path(&operation, &plan)
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let blocker = staging_root.join("unexpected-file");
    fs::write(&blocker, b"preserve me").unwrap();
    drop(service);

    let first_restart = PortcoveService::new(library.clone()).unwrap();
    assert!(first_restart.library().source(PROFILE).unwrap().is_none());
    assert_eq!(fs::read(&blocker).unwrap(), b"preserve me");
    let retained = OperationStore::new(library.clone()).all().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].phase, LifecyclePhase::PayloadPublished);
    assert!(retained[0].last_error.is_some());
    drop(first_restart);

    fs::remove_file(blocker).unwrap();
    let recovered = PortcoveService::new(library.clone()).unwrap();
    let registered = recovered.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(registered.path, plan.destination);
    assert!(source.exists());
    assert!(OperationStore::new(library).all().unwrap().is_empty());
    assert!(!staging_root.exists());
}

#[test]
fn payload_published_cleanup_rejects_a_redirected_root_without_deleting_external_files() {
    let (temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(FailAt(LifecycleFaultPoint::SourceImportPublished)),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap();
    service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Copy,
            &plan.plan_sha256,
            None,
        )
        .unwrap_err();
    let operation = OperationStore::new(library.clone())
        .all()
        .unwrap()
        .remove(0);
    assert_eq!(operation.phase, LifecyclePhase::PayloadPublished);
    let receipt = publication_receipt_path(&operation, &plan).unwrap();
    let staging_root = receipt.parent().unwrap().to_path_buf();
    assert!(!staging_root.exists());
    let redirected = temporary.path().join("redirected-cleanup-root");
    fs::create_dir(&redirected).unwrap();
    let external_receipt = redirected.join(PUBLICATION_RECEIPT_FILE);
    fs::write(&external_receipt, b"external evidence").unwrap();
    if create_directory_symlink(&redirected, &staging_root).is_err() {
        return;
    }
    drop(service);

    let recovered = PortcoveService::new(library.clone()).unwrap();
    assert!(recovered.library().source(PROFILE).unwrap().is_none());
    assert_eq!(fs::read(&external_receipt).unwrap(), b"external evidence");
    let retained = OperationStore::new(library).all().unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].phase, LifecyclePhase::PayloadPublished);
    assert!(retained[0].last_error.is_some());
}

#[test]
fn changed_original_after_publication_registers_destination_and_retains_original() {
    let (_temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(FailAt(
            LifecycleFaultPoint::SourceImportBeforePublicationRecorded,
        )),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Move)
        .unwrap();
    let authorization = service
        .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
        .unwrap();
    service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            Some(&authorization.token),
        )
        .unwrap_err();
    drop(service);

    fs::write(&source, b"changed original before restart").unwrap();
    let recovered = PortcoveService::new(library.clone()).unwrap();
    let registered = recovered.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(registered.path, plan.destination);
    assert_eq!(
        fs::read(&source).unwrap(),
        b"changed original before restart"
    );
    assert_eq!(
        fs::read(&plan.destination).unwrap(),
        b"synthetic format-only disc source"
    );
    assert!(OperationStore::new(library).all().unwrap().is_empty());
    let activity = recovered
        .library()
        .activities(20)
        .unwrap()
        .into_iter()
        .find(|activity| activity.operation == ActivityOperation::ImportSource)
        .unwrap();
    assert_eq!(
        activity.message.as_deref(),
        Some("Source copied, verified, and registered; original retained")
    );
}

#[test]
fn recovery_never_deletes_a_replacement_at_the_original_path() {
    let (_temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(FailAt(LifecycleFaultPoint::SourceImportOriginalQuarantined)),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Move)
        .unwrap();
    let authorization = service
        .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
        .unwrap();
    service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            Some(&authorization.token),
        )
        .unwrap_err();
    drop(service);

    fs::write(&source, b"replacement after interrupted move").unwrap();
    let recovered = PortcoveService::new(library.clone()).unwrap();
    assert_eq!(
        fs::read(&source).unwrap(),
        b"replacement after interrupted move"
    );
    let registered = recovered.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(
        fs::read(&registered.path).unwrap(),
        b"synthetic format-only disc source"
    );
    let activity = recovered
        .library()
        .activities(20)
        .unwrap()
        .into_iter()
        .find(|activity| activity.operation == ActivityOperation::ImportSource)
        .unwrap();
    assert_eq!(
        activity.message.as_deref(),
        Some("Source copied, verified, and registered; original retained")
    );
    let quarantined = quarantine_path(&source, &activity.id);
    assert_eq!(
        fs::read(quarantined).unwrap(),
        b"synthetic format-only disc source"
    );
    assert!(OperationStore::new(library).all().unwrap().is_empty());
}

#[test]
fn move_retains_original_bytes_changed_after_registration() {
    let (_temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(FailAt(LifecycleFaultPoint::SourceImportRegistered)),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Move)
        .unwrap();
    let authorization = service
        .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
        .unwrap();
    service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            Some(&authorization.token),
        )
        .unwrap_err();
    drop(service);

    fs::write(&source, b"changed after destination registration").unwrap();
    let recovered = PortcoveService::new(library.clone()).unwrap();
    assert_eq!(
        fs::read(&source).unwrap(),
        b"changed after destination registration"
    );
    let registered = recovered.library().source(PROFILE).unwrap().unwrap();
    assert_eq!(
        fs::read(&registered.path).unwrap(),
        b"synthetic format-only disc source"
    );
    let activity = recovered
        .library()
        .activities(20)
        .unwrap()
        .into_iter()
        .find(|activity| activity.operation == ActivityOperation::ImportSource)
        .unwrap();
    assert_eq!(
        activity.message.as_deref(),
        Some("Source copied, verified, and registered; original retained")
    );
    assert!(OperationStore::new(library).all().unwrap().is_empty());
}

#[test]
fn missing_published_destination_blocks_recovery_and_preserves_the_original() {
    let (_temporary, library, _service, source) = fixture();
    let service = PortcoveService::with_faults(
        library.clone(),
        Arc::new(FailAt(LifecycleFaultPoint::SourceImportPublished)),
    )
    .unwrap();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Move)
        .unwrap();
    let authorization = service
        .authorize_source_move(PROFILE, &source, &plan.plan_sha256)
        .unwrap();
    service
        .import_source(
            PROFILE,
            &source,
            SourceImportMode::Move,
            &plan.plan_sha256,
            Some(&authorization.token),
        )
        .unwrap_err();
    drop(service);
    fs::remove_file(&plan.destination).unwrap();

    let recovered = PortcoveService::new(library.clone()).unwrap();
    assert!(source.exists());
    assert!(recovered.library().source(PROFILE).unwrap().is_none());
    let operations = OperationStore::new(library).all().unwrap();
    assert_eq!(operations.len(), 1);
    assert_eq!(operations[0].phase, LifecyclePhase::PayloadPublished);
    assert!(operations[0].last_error.is_some());
}

#[test]
fn directory_file_sets_copy_with_names_and_identity_intact() {
    eprintln!("directory import: initialize library");
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    eprintln!("directory import: prepare catalog");
    let member_bytes: [&[u8]; 3] = [b"synthetic cartridge", b"synthetic disk", b"synthetic IPL"];
    let mut document = Catalog::embedded().unwrap().authoritative_document();
    let profile = document
        .source_catalog
        .as_mut()
        .unwrap()
        .identities
        .iter_mut()
        .find(|profile| profile.id == "g-diffuser-source-set")
        .unwrap();
    let representation = profile
        .variants
        .iter_mut()
        .find(|variant| !variant.legacy_projection_only)
        .unwrap()
        .representations
        .first_mut()
        .unwrap();
    let SourceRepresentationKind::FileSet { members } = &mut representation.kind else {
        panic!("expected file set")
    };
    for (member, bytes) in members.iter_mut().zip(member_bytes) {
        member.identities = vec![DigestIdentity {
            scope: DigestScope::FileSetMember,
            sha1: Some(hex::encode(Sha1::digest(bytes))),
            sha256: Some(hex::encode(Sha256::digest(bytes))),
            crc32: None,
        }];
    }
    let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    eprintln!("directory import: initialize service");
    let mut service = PortcoveService::new(library).unwrap();
    service.replace_catalog_for_test(catalog);
    eprintln!("directory import: prepare source files");
    let source = temporary.path().join("owned-files");
    fs::create_dir(&source).unwrap();
    for (name, bytes) in [
        ("baserom.us.rev0.z64", member_bytes[0]),
        ("baserom.translated.ek.ndd", member_bytes[1]),
        ("N64DDIPLROM.n64", member_bytes[2]),
    ] {
        fs::write(source.join(name), bytes).unwrap();
    }
    eprintln!("directory import: plan and publish");
    let result = import_profile(
        &service,
        "g-diffuser-source-set",
        &source,
        SourceImportMode::Copy,
    );
    assert!(result.registered.path.is_dir());
    eprintln!("directory import: verify published bytes");
    for name in [
        "baserom.us.rev0.z64",
        "baserom.translated.ek.ndd",
        "N64DDIPLROM.n64",
    ] {
        assert_eq!(
            fs::read(source.join(name)).unwrap(),
            fs::read(result.registered.path.join(name)).unwrap()
        );
    }
    eprintln!("directory import: cleanup");
}

#[test]
fn impossible_capacity_fails_before_staging() {
    let (_temporary, _library, service, source) = fixture();
    let plan = service
        .plan_source_import(PROFILE, &source, SourceImportMode::Copy)
        .unwrap();
    fs::create_dir(plan.destination.parent().unwrap()).unwrap();
    let error = require_capacity(&plan.destination, u64::MAX).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(!plan.destination.exists());
}

#[cfg(unix)]
#[test]
fn links_and_special_files_are_rejected_without_inspection_or_copy() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt, os::unix::fs::symlink};

    let (temporary, _library, service, source) = fixture();
    let link = temporary.path().join("linked.iso");
    symlink(&source, &link).unwrap();
    assert_eq!(
        service
            .plan_source_import(PROFILE, &link, SourceImportMode::Copy)
            .unwrap_err()
            .code,
        ErrorCode::SourceInvalid
    );

    let fifo = temporary.path().join("special.iso");
    let path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    assert_eq!(
        service
            .plan_source_import(PROFILE, &fifo, SourceImportMode::Copy)
            .unwrap_err()
            .code,
        ErrorCode::SourceInvalid
    );
}
