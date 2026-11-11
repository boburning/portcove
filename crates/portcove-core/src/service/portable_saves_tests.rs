//! Two-library fixtures stand in for two devices. Byte equality here proves
//! classification, consent, conflict and recovery behavior, not game loading.
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use super::*;
use crate::{
    InstallRecord, Library, PersistentDataRole,
    operation::{LifecycleFaultInjector, LifecycleFaultPoint},
};

const PORT: &str = "shipwright";
const VERSION: &str = "9.3.1";

struct Device {
    _temporary: tempfile::TempDir,
    library: Library,
    service: PortcoveService,
}

impl Device {
    fn new(version: &str) -> Self {
        Self::with_faults(version, None)
    }

    fn with_faults(version: &str, fault: Option<LifecycleFaultPoint>) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = match fault {
            None => PortcoveService::new(library.clone()).unwrap(),
            Some(point) => PortcoveService::with_faults(
                library.clone(),
                Arc::new(FailOnce {
                    point,
                    fired: AtomicBool::new(false),
                }),
            )
            .unwrap(),
        };
        register_install(&library, &service, version);
        Self {
            _temporary: temporary,
            library,
            service,
        }
    }

    fn user(&self) -> PathBuf {
        self.library.user_dir(PORT)
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.user().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn read(&self, relative: &str) -> Option<Vec<u8>> {
        fs::read(self.user().join(relative)).ok()
    }

    fn export(&self, name: &str) -> (PathBuf, PortableSaveExportResult) {
        let preview = self.service.preview_portable_save_export(PORT).unwrap();
        assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
        let path = self._temporary.path().join(name);
        let result = self
            .service
            .export_portable_saves(PORT, &path, preview.content_sha256.as_deref().unwrap())
            .unwrap();
        (path, result)
    }

    fn import(
        &self,
        bundle: &Path,
        options: PortableSaveImportOptions,
    ) -> Result<PortableSaveImportResult> {
        let preview = self
            .service
            .preview_portable_save_import(PORT, bundle, options)?;
        let authorization = self.service.authorize_portable_save_import(
            PORT,
            bundle,
            options,
            &preview.preview_sha256,
        )?;
        self.service
            .import_portable_saves(PORT, bundle, options, &authorization.token)
    }
}

struct FailOnce {
    point: LifecycleFaultPoint,
    fired: AtomicBool,
}

impl LifecycleFaultInjector for FailOnce {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == self.point && !self.fired.swap(true, Ordering::SeqCst) {
            return Err(PortcoveError::state(format!(
                "injected lifecycle failure at {point:?}"
            )));
        }
        Ok(())
    }
}

fn register_install(library: &Library, service: &PortcoveService, version: &str) -> InstallRecord {
    use sha2::{Digest, Sha256};
    let catalog = service.catalog();
    let port = catalog.port(PORT).unwrap();
    let platform = Platform::current().unwrap();
    let bytes = format!("{PORT}:{version}:fixture");
    let artifact = crate::ArtifactIdentity {
        // Matches the reviewed Windows package-name shape; bytes stay inert.
        asset_name: format!("SoH-Fixture{}-Win64.zip", version.replace('.', "")),
        sha256: hex::encode(Sha256::digest(bytes.as_bytes())),
        size: bytes.len() as u64,
    };
    let root = library.versions_dir().join(PORT).join(&artifact.sha256);
    fs::create_dir_all(&root).unwrap();
    for relative in port.executable_hints.get(&platform).unwrap() {
        let executable = root.join(relative);
        fs::write(&executable, b"inert executable, never run").unwrap();
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let qualification = crate::InstallQualification::from_catalog(catalog, PORT, platform).unwrap();
    let (manifest_sha256, selected_executable, runtime) =
        crate::install::Installer::new(library.clone())
            .unwrap()
            .create_manifest(&id, PORT, version, &artifact, &qualification, &root)
            .unwrap();
    let install = InstallRecord {
        id,
        port_id: PORT.into(),
        version: version.into(),
        path: root,
        channel: crate::ReleaseChannel::Stable,
        installed_at: Library::now(),
        verified: true,
        staged: false,
        artifact,
        manifest_sha256,
        selected_executable,
        runtime,
    };
    library.register_install(&install, true).unwrap();
    install
}

fn backup_file(record: &crate::BackupRecord, relative: &str) -> Option<Vec<u8>> {
    fs::read(record.path.join("data").join(relative)).ok()
}

fn seeded_source() -> Device {
    let device = Device::new(VERSION);
    device.write("Save/file1.sav", b"{\"slot\":1,\"hearts\":3}");
    device.write("Save/global.sav", b"{\"language\":0}");
    device.write("shipofharkinian.json", b"{\"window\":\"pc\"}");
    device.write("imgui.ini", b"[pc layout]");
    device.write("oot.o2r", b"derived from the player's own original");
    device.write("mods/texture.o2r", b"mod");
    device.write("notes.txt", b"unknown player file");
    device
}

#[test]
fn export_contains_only_classified_progress_and_names_what_stays() {
    let source = seeded_source();
    let preview = source.service.preview_portable_save_export(PORT).unwrap();
    assert!(preview.blockers.is_empty());
    let identity = preview.identity.clone().unwrap();
    assert_eq!(identity.version, VERSION);
    assert_eq!(identity.contract_id, "shipwright-save-files-v1");
    assert_eq!(
        preview
            .files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["Save/file1.sav"]
    );
    let local = |path: &str| {
        preview
            .stays_local
            .iter()
            .find(|entry| entry.path == path)
            .map(|entry| entry.role)
    };
    assert_eq!(
        local("Save/global.sav"),
        Some(PersistentDataRole::DeviceConfiguration)
    );
    assert_eq!(
        local("shipofharkinian.json"),
        Some(PersistentDataRole::DeviceConfiguration)
    );
    assert_eq!(local("oot.o2r"), Some(PersistentDataRole::OriginalDerived));
    assert_eq!(local("mods"), Some(PersistentDataRole::Mods));
    assert_eq!(local("notes.txt"), Some(PersistentDataRole::Unknown));

    let (bundle, result) = source.export("progress.json");
    let text = fs::read_to_string(&bundle).unwrap();
    for excluded in [
        "global.sav",
        "shipofharkinian",
        "oot.o2r",
        "notes.txt",
        "texture",
    ] {
        assert!(
            !text.contains(excluded),
            "{excluded} leaked into the export"
        );
    }
    assert_eq!(result.base_sha256, None);
    // Export never replaces an existing file.
    let again = source
        .service
        .export_portable_saves(PORT, &bundle, &result.content_sha256);
    assert!(again.is_err());
    assert_eq!(fs::read_to_string(&bundle).unwrap(), text);
}

#[test]
fn export_refuses_progress_changed_after_review() {
    let source = seeded_source();
    let preview = source.service.preview_portable_save_export(PORT).unwrap();
    source.write("Save/file1.sav", b"{\"slot\":1,\"hearts\":4}");
    let destination = source._temporary.path().join("stale.json");
    let error = source
        .service
        .export_portable_saves(
            PORT,
            &destination,
            preview.content_sha256.as_deref().unwrap(),
        )
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert!(!destination.exists());
}

#[test]
fn import_moves_progress_and_keeps_destination_local_data() {
    let source = seeded_source();
    let (bundle, _) = source.export("progress.json");
    let destination = Device::new(VERSION);
    destination.write("shipofharkinian.json", b"{\"window\":\"deck\"}");
    destination.write("Save/global.sav", b"{\"language\":1}");
    destination.write("oot.o2r", b"deck's own derived archive");

    let preview = destination
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap();
    assert_eq!(preview.relation, PortableSaveRelation::NoLocalProgress);
    assert!(preview.blockers.is_empty());
    assert!(preview.safety_backup_will_be_created);
    assert_eq!(preview.source.platform, Platform::current().unwrap());
    assert_eq!(preview.changes.len(), 1);
    assert_eq!(preview.changes[0].effect, PortableSaveFileEffect::Add);

    let result = destination.import(&bundle, Default::default()).unwrap();
    assert_eq!(
        destination.read("Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"hearts\":3}"
    );
    assert_eq!(
        destination.read("shipofharkinian.json").unwrap(),
        b"{\"window\":\"deck\"}"
    );
    assert_eq!(
        destination.read("Save/global.sav").unwrap(),
        b"{\"language\":1}"
    );
    assert_eq!(
        destination.read("oot.o2r").unwrap(),
        b"deck's own derived archive"
    );
    assert!(destination.read("notes.txt").is_none());
    assert!(destination.read("imgui.ini").is_none());
    let safety = result.safety_backup.unwrap();
    assert!(backup_file(&safety, "Save/file1.sav").is_none());
    assert_eq!(
        backup_file(&safety, "shipofharkinian.json").unwrap(),
        b"{\"window\":\"deck\"}"
    );
    assert_eq!(
        backup_file(&result.import_snapshot, "Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"hearts\":3}"
    );
    // The same file again has nothing to apply.
    let repeated = destination
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap();
    assert_eq!(repeated.relation, PortableSaveRelation::AlreadyCurrent);
    assert!(
        repeated
            .blockers
            .contains(&PortableSaveBlocker::AlreadyCurrent)
    );
}

#[test]
fn continued_progress_applies_without_a_conflict_choice() {
    let pc = seeded_source();
    let (first, _) = pc.export("first.json");
    let deck = Device::new(VERSION);
    deck.import(&first, Default::default()).unwrap();
    deck.write("Save/file1.sav", b"{\"slot\":1,\"hearts\":5}");
    let (second, exported) = deck.export("second.json");
    assert!(exported.base_sha256.is_some());

    let preview = pc
        .service
        .preview_portable_save_import(PORT, &second, Default::default())
        .unwrap();
    assert_eq!(preview.relation, PortableSaveRelation::Continues);
    assert!(preview.blockers.is_empty());
    pc.import(&second, Default::default()).unwrap();
    assert_eq!(
        pc.read("Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"hearts\":5}"
    );
    assert_eq!(
        pc.read("shipofharkinian.json").unwrap(),
        b"{\"window\":\"pc\"}"
    );
}

#[test]
fn diverged_progress_requires_an_explicit_choice_and_keeps_both_branches() {
    let pc = seeded_source();
    let (first, _) = pc.export("first.json");
    let deck = Device::new(VERSION);
    deck.import(&first, Default::default()).unwrap();
    deck.write("Save/file1.sav", b"{\"slot\":1,\"deck\":true}");
    let (from_deck, _) = deck.export("deck.json");
    // Offline play continued on the PC too.
    pc.write("Save/file1.sav", b"{\"slot\":1,\"pc\":true}");

    let preview = pc
        .service
        .preview_portable_save_import(PORT, &from_deck, Default::default())
        .unwrap();
    assert_eq!(preview.relation, PortableSaveRelation::Diverged);
    assert_eq!(preview.blockers, [PortableSaveBlocker::ConflictNeedsChoice]);
    assert!(
        pc.service
            .authorize_portable_save_import(
                PORT,
                &from_deck,
                Default::default(),
                &preview.preview_sha256
            )
            .is_err()
    );
    assert_eq!(
        pc.read("Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"pc\":true}"
    );

    let replace = PortableSaveImportOptions {
        replace_diverged_progress: true,
        ..Default::default()
    };
    let result = pc.import(&from_deck, replace).unwrap();
    assert_eq!(
        pc.read("Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"deck\":true}"
    );
    assert_eq!(
        backup_file(&result.safety_backup.unwrap(), "Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"pc\":true}"
    );
    assert_eq!(
        backup_file(&result.import_snapshot, "Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"deck\":true}"
    );
}

#[test]
fn local_only_slots_are_kept_unless_removal_is_chosen() {
    let pc = seeded_source();
    let (bundle, _) = pc.export("one-slot.json");
    let deck = Device::new(VERSION);
    deck.write("Save/file2.sav", b"{\"slot\":2}");
    let replace = PortableSaveImportOptions {
        replace_diverged_progress: true,
        ..Default::default()
    };
    let preview = deck
        .service
        .preview_portable_save_import(PORT, &bundle, replace)
        .unwrap();
    let effect = |path: &str| {
        preview
            .changes
            .iter()
            .find(|change| change.path == path)
            .unwrap()
            .effect
    };
    assert_eq!(effect("Save/file2.sav"), PortableSaveFileEffect::KeepLocal);
    deck.import(&bundle, replace).unwrap();
    assert_eq!(deck.read("Save/file2.sav").unwrap(), b"{\"slot\":2}");

    // A second device state where removal is explicitly chosen.
    let other = Device::new(VERSION);
    other.write("Save/file2.sav", b"{\"slot\":2}");
    let remove = PortableSaveImportOptions {
        replace_diverged_progress: true,
        remove_local_only_saves: true,
    };
    let result = other.import(&bundle, remove).unwrap();
    assert!(other.read("Save/file2.sav").is_none());
    assert_eq!(
        backup_file(&result.safety_backup.unwrap(), "Save/file2.sav").unwrap(),
        b"{\"slot\":2}"
    );
}

#[test]
fn incompatible_versions_and_games_are_blocked() {
    let pc = seeded_source();
    let (bundle, _) = pc.export("progress.json");
    let newer = Device::new("9.4.0");
    let preview = newer
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap();
    assert!(
        preview
            .blockers
            .contains(&PortableSaveBlocker::VersionMismatch)
    );
    assert!(
        preview
            .blockers
            .contains(&PortableSaveBlocker::UnsupportedVersion)
    );
    assert_eq!(
        newer
            .service
            .authorize_portable_save_import(
                PORT,
                &bundle,
                Default::default(),
                &preview.preview_sha256
            )
            .unwrap_err()
            .code,
        crate::ErrorCode::Unsupported
    );
    assert!(newer.read("Save/file1.sav").is_none());
    let export = newer.service.preview_portable_save_export(PORT).unwrap();
    assert!(
        export
            .blockers
            .contains(&PortableSaveBlocker::UnsupportedVersion)
    );

    let other_game = pc
        .service
        .preview_portable_save_import("2ship2harkinian", &bundle, Default::default())
        .unwrap();
    assert!(
        other_game
            .blockers
            .contains(&PortableSaveBlocker::DifferentGame)
    );
    assert!(
        other_game
            .blockers
            .contains(&PortableSaveBlocker::Unqualified)
    );
}

#[test]
fn changed_destination_or_file_after_review_refuses_without_changes() {
    let pc = seeded_source();
    let (bundle, _) = pc.export("progress.json");
    let deck = Device::new(VERSION);
    deck.write("shipofharkinian.json", b"{\"window\":\"deck\"}");
    let preview = deck
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap();
    let authorization = deck
        .service
        .authorize_portable_save_import(PORT, &bundle, Default::default(), &preview.preview_sha256)
        .unwrap();
    // The player saved on this device after reviewing.
    deck.write("Save/file1.sav", b"{\"slot\":1,\"newer\":true}");
    let error = deck
        .service
        .import_portable_saves(PORT, &bundle, Default::default(), &authorization.token)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(
        deck.read("Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"newer\":true}"
    );
    assert!(deck.service.list_backups(PORT).unwrap().backups.is_empty());

    // A different file at the reviewed path is refused too.
    fs::remove_file(deck.user().join("Save/file1.sav")).unwrap();
    let preview = deck
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap();
    let authorization = deck
        .service
        .authorize_portable_save_import(PORT, &bundle, Default::default(), &preview.preview_sha256)
        .unwrap();
    pc.write("Save/file1.sav", b"{\"slot\":1,\"hearts\":9}");
    let (_, other) = pc.export("other.json");
    fs::copy(pc._temporary.path().join("other.json"), &bundle).unwrap();
    assert_ne!(other.content_sha256, preview.incoming_content_sha256);
    assert!(
        deck.service
            .import_portable_saves(PORT, &bundle, Default::default(), &authorization.token)
            .is_err()
    );
    assert!(deck.read("Save/file1.sav").is_none());
}

#[test]
fn a_running_game_or_busy_port_blocks_export_and_import() {
    let pc = seeded_source();
    let (bundle, _) = pc.export("progress.json");
    let deck = Device::new(VERSION);
    let preview = deck
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap();
    let authorization = deck
        .service
        .authorize_portable_save_import(PORT, &bundle, Default::default(), &preview.preview_sha256)
        .unwrap();
    let held = deck.library.try_lock_port(PORT, "launch").unwrap();
    let busy = deck
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap();
    assert!(busy.blockers.contains(&PortableSaveBlocker::Busy));
    assert!(
        deck.service
            .preview_portable_save_export(PORT)
            .unwrap()
            .blockers
            .contains(&PortableSaveBlocker::Busy)
    );
    assert_eq!(
        deck.service
            .import_portable_saves(PORT, &bundle, Default::default(), &authorization.token)
            .unwrap_err()
            .code,
        crate::ErrorCode::Conflict
    );
    drop(held);
    assert!(deck.read("Save/file1.sav").is_none());
}

#[test]
fn interrupted_snapshot_leaves_live_data_and_no_restorable_import() {
    let pc = seeded_source();
    let (bundle, _) = pc.export("progress.json");
    let deck = Device::with_faults(VERSION, Some(LifecycleFaultPoint::BackupDataCopied));
    deck.write("Save/file1.sav", b"{\"deck\":1}");
    let replace = PortableSaveImportOptions {
        replace_diverged_progress: true,
        ..Default::default()
    };
    assert!(deck.import(&bundle, replace).is_err());
    assert_eq!(deck.read("Save/file1.sav").unwrap(), b"{\"deck\":1}");
    assert!(deck.service.list_backups(PORT).unwrap().backups.is_empty());
    // A fresh review and consent succeed after the interruption.
    deck.import(&bundle, replace).unwrap();
    assert_eq!(
        deck.read("Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"hearts\":3}"
    );
}

#[test]
fn interrupted_publication_recovers_through_the_restore_journal() {
    let pc = seeded_source();
    let (bundle, _) = pc.export("progress.json");
    let deck = Device::with_faults(VERSION, Some(LifecycleFaultPoint::RestorePublished));
    deck.write("Save/file1.sav", b"{\"deck\":1}");
    let replace = PortableSaveImportOptions {
        replace_diverged_progress: true,
        ..Default::default()
    };
    let error = deck.import(&bundle, replace).unwrap_err();
    assert!(error.details.contains_key("imported_progress_snapshot"));
    // Restart: the existing lifecycle recovery finishes the journaled publication.
    let restarted = PortcoveService::new(deck.library.clone()).unwrap();
    restarted.recover_pending_operations().unwrap();
    assert_eq!(
        deck.read("Save/file1.sav").unwrap(),
        b"{\"slot\":1,\"hearts\":3}"
    );
    let backups = restarted.list_backups(PORT).unwrap().backups;
    assert!(
        backups
            .iter()
            .any(|backup| backup_file(backup, "Save/file1.sav").as_deref()
                == Some(b"{\"deck\":1}".as_slice())),
        "the destination's previous progress stays in a safety backup"
    );
}

#[test]
fn case_variants_of_save_names_are_refused_not_overwritten() {
    let pc = seeded_source();
    let (bundle, _) = pc.export("progress.json");
    let deck = Device::new(VERSION);
    deck.write("Save/File1.sav", b"{\"other spelling\":true}");
    let error = deck
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(
        deck.read("Save/File1.sav").unwrap(),
        b"{\"other spelling\":true}"
    );
}

#[test]
fn adding_new_slots_needs_no_conflict_choice() {
    let pc = seeded_source();
    let (bundle, _) = pc.export("slot-one.json");
    let deck = Device::new(VERSION);
    deck.write("Save/file2.sav", b"{\"slot\":2}");
    let preview = deck
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap();
    assert_eq!(preview.relation, PortableSaveRelation::Diverged);
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    deck.import(&bundle, Default::default()).unwrap();
    assert_eq!(deck.read("Save/file2.sav").unwrap(), b"{\"slot\":2}");
    assert!(deck.read("Save/file1.sav").is_some());
}

#[test]
fn export_refuses_destinations_inside_the_library() {
    let pc = seeded_source();
    let preview = pc.service.preview_portable_save_export(PORT).unwrap();
    for destination in [
        pc.user().join("exported.json"),
        pc.library.backups_dir().join("exported.json"),
    ] {
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let error = pc
            .service
            .export_portable_saves(
                PORT,
                &destination,
                preview.content_sha256.as_deref().unwrap(),
            )
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Usage);
        assert!(!destination.exists());
    }
}

#[test]
fn files_from_unqualified_platforms_are_reported_as_such() {
    let pc = seeded_source();
    let (bundle, _) = pc.export("progress.json");
    let text = fs::read_to_string(&bundle).unwrap();
    let current = serde_json::to_value(Platform::current().unwrap()).unwrap();
    let edited = text.replacen(
        &format!("\"platform\": {current}"),
        "\"platform\": \"macos-aarch64\"",
        1,
    );
    assert_ne!(edited, text);
    fs::write(&bundle, edited).unwrap();
    let deck = Device::new(VERSION);
    let preview = deck
        .service
        .preview_portable_save_import(PORT, &bundle, Default::default())
        .unwrap();
    assert!(
        preview
            .blockers
            .contains(&PortableSaveBlocker::UnsupportedPlatform)
    );
}
