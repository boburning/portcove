use super::*;
use crate::{Library, PortcoveService, ProfileUpdatePolicy, retained_build::tests::fixture};
use std::io::Write;

fn archive(directory: &Path, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
    let path = directory.join(name);
    let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for (entry, bytes) in entries {
        writer
            .start_file(*entry, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
    path
}

struct World {
    _temporary: tempfile::TempDir,
    scratch: PathBuf,
    service: PortcoveService,
    default: String,
}

fn world() -> World {
    let (temporary, service, _first) = fixture();
    let scratch = temporary.path().join("scratch");
    fs::create_dir_all(&scratch).unwrap();
    let default = service.ensure_default_profile("starship").unwrap().id;
    World {
        _temporary: temporary,
        scratch,
        service,
        default,
    }
}

fn user(world: &World) -> PathBuf {
    world.service.library().user_dir("starship")
}

fn live_mods(world: &World) -> Vec<String> {
    let mut names = fs::read_dir(user(world).join("mods"))
        .map(|entries| {
            entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn revision(world: &World, profile: &str) -> u64 {
    world
        .service
        .profile_inventory("starship")
        .unwrap()
        .profiles
        .into_iter()
        .find(|view| view.profile.id == profile)
        .unwrap()
        .profile
        .current_revision
}

#[test]
fn installing_into_the_selected_profile_deploys_exact_bytes_and_records_a_revision() {
    let w = world();
    let package = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
    let next = w
        .service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    assert_eq!(next.revision, 2);
    assert_eq!(next.packages.len(), 1);
    assert_eq!(next.packages[0].native_id, "hd-link.o2r");
    assert_eq!(next.orderings[0].native_ids, ["hd-link.o2r"]);
    assert_eq!(live_mods(&w), ["hd-link.o2r"]);
    assert_eq!(
        fs::read(user(&w).join("mods/hd-link.o2r")).unwrap(),
        fs::read(&package).unwrap()
    );
    // The first revision is still the clean setup, recoverable from history.
    let revisions = w.service.profile_revisions("starship", &w.default).unwrap();
    assert!(revisions[0].packages.is_empty());
}

#[test]
fn an_unseen_port_deploys_exact_bytes_and_updates_only_its_authored_native_list() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let platform = crate::Platform::current().unwrap();
    let id = "unseen-libultraship-fixture";
    let catalog = crate::Catalog::from_json(&serde_json::json!({
        "schema_version": 1,
        "ports": [{
            "id": id,
            "name": "Unseen libultraship fixture",
            "summary": "Native mod contract deployment test.",
            "project_url": "https://github.com/fixture/unseen-libultraship",
            "support_tier": "beta",
            "channels": ["stable"],
            "platforms": [platform],
            "adapter": "libultraship-portable",
            "release": {"repository": "fixture/unseen-libultraship"},
            "executable_hints": { (serde_json::to_value(platform).unwrap().as_str().unwrap()): ["fixture.exe"] },
            "persistent_paths": ["mods", "unseen.json"],
            "mod_loader": {
                "contract": {"id": "libultraship", "version": "1"},
                "repository": "fixture/unseen-libultraship",
                "minimum_version": "1.3.0",
                "platforms": [platform],
                "settings_file": "unseen.json"
            }
        }]
    }).to_string()).unwrap();
    crate::retained_build::tests::install_fixture_port(
        &library,
        &catalog,
        id,
        "unseen-runtime",
        "v1.4.0",
        b"inert runtime",
        true,
    );
    let mut service = PortcoveService::new_read_only(library).unwrap();
    service.replace_catalog_for_test(catalog);
    let profile = service.ensure_default_profile(id).unwrap();
    let user = service.library().user_dir(id);
    fs::create_dir_all(&user).unwrap();
    let settings = user.join("unseen.json");
    fs::write(&settings, br#"{"other_setting":true}"#).unwrap();
    let package = archive(
        temporary.path(),
        "unseen-addon.o2r",
        &[("assets/model", b"new bytes")],
    );

    let revision = service
        .install_mod_package(id, &profile.id, &package, 1)
        .unwrap();
    assert_eq!(revision.loader.unwrap().id, "libultraship");
    assert_eq!(
        fs::read(user.join("mods/unseen-addon.o2r")).unwrap(),
        fs::read(&package).unwrap()
    );
    let native: serde_json::Value = serde_json::from_slice(&fs::read(settings).unwrap()).unwrap();
    assert_eq!(native["CVars"]["gSettings"]["EnabledMods"], "unseen-addon");
    assert_eq!(native["other_setting"], true);
    assert!(!user.join("shipofharkinian.json").exists());
}

#[test]
fn earlier_banjo_and_two_ship_builds_keep_unmanaged_mods_and_require_valid_receipts() {
    let current = crate::Catalog::embedded().unwrap();
    let mut prior = current.authoritative_document();
    for port in &mut prior.ports {
        if matches!(port.id.as_str(), "banjo-recomp" | "2ship2harkinian") {
            port.mod_loader = None;
        }
    }
    let prior = crate::Catalog::from_document(prior).unwrap();
    let platform = crate::Platform::current().unwrap();
    for (id, version, settings_file) in [
        ("banjo-recomp", "v1.0.2", "mods.json"),
        ("2ship2harkinian", "5.0.1", "2ship2harkinian.json"),
    ] {
        if !prior.port(id).unwrap().platforms.contains(&platform) {
            continue;
        }
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = crate::retained_build::tests::install_fixture_port(
            &library,
            &prior,
            id,
            "retained",
            version,
            b"inert runtime",
            true,
        );
        let service = PortcoveService::new_read_only(library).unwrap();
        assert!(service.optional_deploy_layout(id).unwrap().is_none());
        service.ensure_default_profile(id).unwrap();
        assert!(service.optional_deploy_layout(id).unwrap().is_none());

        let user = service.library().user_dir(id);
        fs::create_dir_all(user.join("mods")).unwrap();
        let unmanaged = user.join("mods/manual-mod.bin");
        fs::write(&unmanaged, b"unmanaged data").unwrap();
        fs::write(user.join(settings_file), b"native state").unwrap();
        service
            .require_selected_loader_for_install(&install)
            .unwrap();
        service.prepare_native_mod_list_locked(id).unwrap();
        service
            .require_restore_profile_projection(id, &user)
            .unwrap();
        assert!(!service.mod_setups(id).unwrap().supported);
        assert_eq!(fs::read(&unmanaged).unwrap(), b"unmanaged data");
        assert_eq!(fs::read(user.join(settings_file)).unwrap(), b"native state");

        let layout = Layout::for_user(&user);
        fs::create_dir_all(layout.store()).unwrap();
        fs::write(layout.journal(), b"pending state").unwrap();
        assert!(service.prepare_native_mod_list_locked(id).is_err());
        assert!(
            service
                .require_restore_profile_projection(id, &user)
                .is_err()
        );
        fs::remove_file(layout.journal()).unwrap();

        fs::remove_file(install.path.join(".portcove-manifest.json")).unwrap();
        assert!(service.optional_deploy_layout(id).is_err());
        assert!(service.mod_setups(id).is_err());
        assert!(service.prepare_native_mod_list_locked(id).is_err());
        assert!(
            service
                .require_restore_profile_projection(id, &user)
                .is_err()
        );
        assert_eq!(fs::read(&unmanaged).unwrap(), b"unmanaged data");
        assert_eq!(fs::read(user.join(settings_file)).unwrap(), b"native state");
    }
}

#[test]
fn a_plain_default_rolls_back_and_recovers_a_switch_to_an_admitted_setup() {
    let id = "banjo-recomp";
    let current = crate::Catalog::embedded().unwrap();
    let mut prior = current.authoritative_document();
    prior
        .ports
        .iter_mut()
        .find(|port| port.id == id)
        .unwrap()
        .mod_loader = None;
    let prior = crate::Catalog::from_document(prior).unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let old = crate::retained_build::tests::install_fixture_port(
        &library,
        &prior,
        id,
        "older",
        "v1.0.2",
        b"older runtime",
        true,
    );
    let service = PortcoveService::new_read_only(library).unwrap();
    let default = service.ensure_default_profile(id).unwrap();
    let new = crate::retained_build::tests::install_fixture_port(
        service.library(),
        &current,
        id,
        "newer",
        "v1.0.2",
        b"newer runtime",
        true,
    );
    let target = service
        .copy_profile(id, &default.id, "Reviewed setup")
        .unwrap();
    let rolled_back = service.library().rollback(id).unwrap();
    assert_eq!(rolled_back.id, old.id);
    let revisions = service.profile_revisions(id, &default.id).unwrap();
    assert!(revisions[1].loader.is_some());
    assert!(revisions[2].loader.is_none());
    assert_eq!(revisions[2].save_group, revisions[1].save_group);
    service.require_selected_loader_for_install(&old).unwrap();
    service.prepare_native_mod_list_locked(id).unwrap();

    let another_plain = service
        .copy_profile(id, &default.id, "Plain setup")
        .unwrap();
    let error = service.activate_profile(id, &another_plain.id).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported);

    // Recover a switch whose journal predates the current loader admission.
    let path_layout = Layout::for_user(&service.library().user_dir(id));
    fs::create_dir_all(path_layout.store()).unwrap();
    write_journal(
        &path_layout,
        &default.id,
        &target.id,
        target.current_revision,
        Phase::Start,
        &declared_state_paths(&service, id, &path_layout).unwrap(),
    )
    .unwrap();
    let selected = service.activate_profile(id, &target.id).unwrap();
    assert_eq!(selected.build.install_id, new.id);
    assert_eq!(selected.loader.as_ref().unwrap().id, "n64-recomp");
    assert!(!path_layout.journal().exists());

    let selected = service.activate_profile(id, &default.id).unwrap();
    assert_eq!(selected.build.install_id, old.id);
    assert!(selected.loader.is_none());
    let selected = service.activate_profile(id, &target.id).unwrap();
    assert_eq!(selected.build.install_id, new.id);
}
#[test]
fn a_committed_switch_removes_its_journal_without_readmitting_the_departing_setup() {
    let w = world();
    let layout = Layout::for_user(&user(&w));
    fs::create_dir_all(layout.store()).unwrap();
    fs::create_dir_all(&layout.user).unwrap();
    let preserved = layout.user.join("player-progress.fixture");
    fs::write(&preserved, b"newer progress").unwrap();
    write_journal(
        &layout,
        "retired-departing-profile",
        &w.default,
        1,
        Phase::Deployed,
        &[],
    )
    .unwrap();

    // With the selection already committed, neither old runtime nor a new
    // projection is needed to retire the receipt.
    let latest = w.service.library().all_installs().unwrap().pop().unwrap();
    fs::remove_file(latest.path.join(".portcove-manifest.json")).unwrap();
    w.service
        .finish_interrupted_switch_locked("starship", &layout)
        .unwrap();
    assert!(!layout.journal().exists());
    assert_eq!(fs::read(preserved).unwrap(), b"newer progress");
    assert_eq!(
        profile::selection(&w.service.library().connection().unwrap(), "starship").unwrap(),
        Some((w.default, 1))
    );
}

#[test]
fn removing_a_package_keeps_its_recovery_bytes_and_holds_changed_live_files() {
    let w = world();
    let removed = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
    let other = archive(&w.scratch, "ui.o2r", &[("ui/menu.bin", b"ui")]);
    w.service
        .install_mod_package("starship", &w.default, &removed, 1)
        .unwrap();
    let current = w
        .service
        .install_mod_package("starship", &w.default, &other, 2)
        .unwrap();
    let before = current
        .packages
        .iter()
        .find(|package| package.native_id == "hd-link.o2r")
        .unwrap();
    let live = user(&w).join("mods/hd-link.o2r");
    fs::write(&live, b"player changed this file").unwrap();
    let error = w
        .service
        .remove_mod_package("starship", &w.default, "hd-link.o2r", current.revision)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(fs::read(&live).unwrap(), b"player changed this file");
    assert_eq!(revision(&w, &w.default), current.revision);

    fs::copy(&removed, &live).unwrap();
    let config = user(&w).join("starship.cfg.json");
    fs::write(
        &config,
        br#"{"CVars":{"gSettings":{"EnabledMods":"hd-link|unmanaged|ui"}}}"#,
    )
    .unwrap();
    let next = w
        .service
        .remove_mod_package("starship", &w.default, "hd-link.o2r", current.revision)
        .unwrap();
    assert_eq!(next.revision, current.revision + 1);
    assert_eq!(live_mods(&w), ["ui.o2r"]);
    assert_eq!(next.orderings[0].native_ids, ["ui.o2r"]);
    let config: serde_json::Value = serde_json::from_slice(&fs::read(config).unwrap()).unwrap();
    assert_eq!(config["CVars"]["gSettings"]["EnabledMods"], "ui|unmanaged");
    let history = w.service.profile_revisions("starship", &w.default).unwrap();
    assert!(history[2].packages.contains(before));
    let stored = Layout::for_user(&user(&w)).package(&before.sha256, &before.native_id);
    assert_eq!(fs::read(stored).unwrap(), fs::read(removed).unwrap());
}

#[test]
fn replacing_a_disabled_package_keeps_it_off() {
    let w = world();
    let package = archive(&w.scratch, "hd-link.otr", &[("objects/link.bin", b"old")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    let disabled = w
        .service
        .set_mod_package_enabled("starship", &w.default, "hd-link.otr", false, 2)
        .unwrap();
    let replacement = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"new")]);
    let next = w
        .service
        .install_mod_package("starship", &w.default, &replacement, disabled.revision)
        .unwrap();
    assert_eq!(next.packages.len(), 1);
    assert_eq!(next.packages[0].native_id, "hd-link.o2r");
    assert!(!next.packages[0].enabled);
    assert!(live_mods(&w).is_empty());
}

#[test]
fn disabling_removes_only_the_owned_file_and_enabling_restores_stored_bytes() {
    let w = world();
    let package = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    // A file the profile does not own blocks changes instead of being touched.
    fs::write(user(&w).join("mods/hand-added.o2r"), b"player file").unwrap();
    let held = w
        .service
        .set_mod_package_enabled("starship", &w.default, "hd-link.o2r", false, 2)
        .unwrap_err();
    assert_eq!(held.code, crate::ErrorCode::Conflict);
    assert!(held.details["unmanaged"].contains("hand-added.o2r"));
    assert_eq!(live_mods(&w), ["hand-added.o2r", "hd-link.o2r"]);
    fs::remove_file(user(&w).join("mods/hand-added.o2r")).unwrap();
    let disabled = w
        .service
        .set_mod_package_enabled("starship", &w.default, "hd-link.o2r", false, 2)
        .unwrap();
    assert_eq!(disabled.revision, 3);
    assert!(
        live_mods(&w).is_empty(),
        "disabled content leaves the mods root"
    );
    w.service
        .set_mod_package_enabled("starship", &w.default, "hd-link.o2r", true, 3)
        .unwrap();
    assert_eq!(live_mods(&w), ["hd-link.o2r"]);
}

#[test]
fn restoring_backup_cannot_resurrect_a_disabled_package() {
    let w = world();
    let package = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    let save = user(&w).join("saves/progress.sav");
    fs::create_dir_all(save.parent().unwrap()).unwrap();
    fs::write(&save, b"backup progress").unwrap();
    let old = w.service.create_backup("starship").unwrap();
    let old_manifest = fs::read(old.path.join("backup.json")).unwrap();
    let selected = w
        .service
        .set_mod_package_enabled("starship", &w.default, "hd-link.o2r", false, 2)
        .unwrap();
    let same_setup = w.service.create_backup("starship").unwrap();
    fs::write(&save, b"current progress").unwrap();

    let restore = |backup_id: &str| {
        let action = crate::BackupAction::Restore;
        let preview = w
            .service
            .preview_backup_action("starship", backup_id, action)
            .unwrap();
        let authorization = w
            .service
            .authorize_backup_action("starship", backup_id, action, &preview.preview_sha256)
            .unwrap();
        w.service
            .restore_backup("starship", backup_id, &authorization.token)
    };
    let error = restore(&old.id).unwrap_err();
    assert_eq!(error.details["unknown_package"], "hd-link.o2r");
    assert_eq!(fs::read(&save).unwrap(), b"current progress");
    assert!(live_mods(&w).is_empty());
    assert_eq!(
        fs::read(old.path.join("backup.json")).unwrap(),
        old_manifest
    );
    assert_eq!(revision(&w, &w.default), selected.revision);

    restore(&same_setup.id).unwrap();
    assert_eq!(fs::read(&save).unwrap(), b"backup progress");
    assert!(live_mods(&w).is_empty());
}

#[test]
fn backup_projection_requires_live_bytes_and_native_order() {
    let w = world();
    let package = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    let snapshot = w.scratch.join("staged-data");
    fs::create_dir_all(snapshot.join("mods")).unwrap();
    let path = snapshot.join("mods/hd-link.o2r");
    let validate = || {
        w.service
            .require_restore_profile_projection("starship", &snapshot)
    };
    assert_eq!(
        validate().unwrap_err().details["missing_package"],
        "hd-link.o2r"
    );
    fs::write(&path, b"different bytes").unwrap();
    assert_eq!(
        validate().unwrap_err().details["changed_package"],
        "hd-link.o2r"
    );
    fs::copy(package, &path).unwrap();
    assert_eq!(
        validate().unwrap_err().details["native_list"],
        "differs_or_unreadable"
    );
    fs::copy(
        user(&w).join("starship.cfg.json"),
        snapshot.join("starship.cfg.json"),
    )
    .unwrap();
    validate().unwrap();
}

#[test]
fn launch_preflight_preserves_changed_or_resurrected_packages_for_review() {
    let w = world();
    let package = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    let live = user(&w).join("mods/hd-link.o2r");
    let preflight = || {
        let _guard = w
            .service
            .library()
            .try_lock_port("starship", "launch preflight")
            .unwrap();
        w.service.prepare_native_mod_list_locked("starship")
    };

    fs::write(&live, b"changed bytes").unwrap();
    let refusal = preflight().unwrap_err();
    assert_eq!(refusal.details["changed_package"], "hd-link.o2r");
    assert_eq!(
        refusal.presentation().presentation_key,
        "native_mod_list_review"
    );
    assert_eq!(fs::read(&live).unwrap(), b"changed bytes");
    assert_eq!(revision(&w, &w.default), 2);

    fs::remove_file(&live).unwrap();
    assert_eq!(
        preflight().unwrap_err().details["missing_package"],
        "hd-link.o2r"
    );
    fs::copy(&package, &live).unwrap();
    w.service
        .set_mod_package_enabled("starship", &w.default, "hd-link.o2r", false, 2)
        .unwrap();
    fs::copy(&package, &live).unwrap();
    let refusal = preflight().unwrap_err();
    assert_eq!(refusal.details["unknown_package"], "hd-link.o2r");
    assert_eq!(fs::read(&live).unwrap(), fs::read(&package).unwrap());
    assert_eq!(revision(&w, &w.default), 3);
}

#[test]
fn interrupted_full_restore_preserves_the_projection_and_evidence_on_both_sides_of_rename() {
    use crate::operation::{
        LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore,
    };

    for interrupted in 0..=3 {
        let w = world();
        let package = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
        w.service
            .install_mod_package("starship", &w.default, &package, 1)
            .unwrap();
        let canonical = user(&w);
        let save = canonical.join("saves/progress.sav");
        fs::create_dir_all(save.parent().unwrap()).unwrap();
        fs::write(&save, b"older progress").unwrap();
        let backup = w.service.create_backup("starship").unwrap();
        w.service
            .set_mod_package_enabled("starship", &w.default, "hd-link.o2r", false, 2)
            .unwrap();
        fs::write(&save, b"newer progress").unwrap();

        let id = uuid::Uuid::new_v4().to_string();
        let root = w.service.library().recovery_dir().join(&id);
        let staged = root.join("staged-data");
        let previous = root.join("previous-data");
        crate::service::copy_tree(&backup.path.join("data"), &staged).unwrap();
        let manifest = fs::read(backup.path.join("backup.json")).unwrap();
        let receipt = root.join(format!(
            "verified-backup-{}.json",
            crate::signed_catalog::digest(&manifest)
        ));
        fs::write(&receipt, &manifest).unwrap();
        if interrupted >= 1 {
            fs::rename(&canonical, &previous).unwrap();
        }
        if interrupted >= 2 {
            fs::rename(&staged, &canonical).unwrap();
        }
        let mut operation =
            LifecycleOperation::new(&id, LifecycleOperationKind::Restore, "starship");
        operation.phase = if interrupted == 3 {
            LifecyclePhase::PayloadPublished
        } else {
            LifecyclePhase::Prepared
        };
        operation.activate = true;
        operation.original_paths = vec![receipt.clone()];
        operation.paths.staging = Some(root);
        operation.paths.final_path = Some(canonical.clone());
        operation.paths.quarantine = Some(previous.clone());
        let store = OperationStore::new(w.service.library().clone());
        let _guard = w
            .service
            .library()
            .try_lock_port("starship", "test restore restart")
            .unwrap();
        store.put(&mut operation).unwrap();
        let before = operation.phase;
        let refusal =
            crate::recovery::recover_restore(&w.service, &store, &mut operation).unwrap_err();
        assert_eq!(refusal.details["unknown_package"], "hd-link.o2r");
        assert_eq!(operation.phase, before);
        assert_eq!(fs::read(&receipt).unwrap(), manifest);
        assert_eq!(staged.exists(), interrupted < 2);
        assert_eq!(canonical.exists(), interrupted != 1);
        let newer = if interrupted == 0 {
            &canonical
        } else {
            &previous
        };
        assert_eq!(
            fs::read(newer.join("saves/progress.sav")).unwrap(),
            b"newer progress"
        );
    }
}

#[test]
fn committed_restore_resumes_partial_cleanup_without_republishing() {
    use crate::operation::{
        LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore,
    };

    for phase in [
        LifecyclePhase::PayloadPublished,
        LifecyclePhase::MetadataCommitted,
        LifecyclePhase::CleanupPending,
    ] {
        let w = world();
        let package = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
        w.service
            .install_mod_package("starship", &w.default, &package, 1)
            .unwrap();
        let canonical = user(&w);
        let save = canonical.join("saves/progress.sav");
        fs::create_dir_all(save.parent().unwrap()).unwrap();
        fs::write(&save, b"restored progress").unwrap();
        let backup = w.service.create_backup("starship").unwrap();
        let manifest = fs::read(backup.path.join("backup.json")).unwrap();

        let id = uuid::Uuid::new_v4().to_string();
        let recovery = w.service.library().recovery_dir().join(&id);
        let previous = recovery.join("previous-data");
        let receipt = recovery.join(format!(
            "verified-backup-{}.json",
            crate::signed_catalog::digest(&manifest)
        ));
        if phase != LifecyclePhase::CleanupPending {
            crate::service::copy_tree(&backup.path.join("data"), &previous).unwrap();
            fs::remove_file(previous.join("mods/hd-link.o2r")).unwrap();
            fs::write(&receipt, &manifest).unwrap();
        }

        let mut operation =
            LifecycleOperation::new(&id, LifecycleOperationKind::Restore, "starship");
        operation.phase = phase;
        operation.activate = true;
        operation.original_paths = vec![receipt.clone()];
        operation.paths.staging = Some(recovery.clone());
        operation.paths.final_path = Some(canonical.clone());
        operation.paths.quarantine = Some(previous.clone());
        let store = OperationStore::new(w.service.library().clone());
        let _guard = w
            .service
            .library()
            .try_lock_port("starship", "test interrupted restore cleanup")
            .unwrap();
        store.put(&mut operation).unwrap();

        let result = crate::recovery::recover_restore(&w.service, &store, &mut operation);
        if phase == LifecyclePhase::PayloadPublished {
            assert_eq!(
                result.unwrap_err().details["missing_package"],
                "hd-link.o2r"
            );
            assert_eq!(store.get(&id).unwrap().unwrap().phase, phase);
            assert!(previous.is_dir());
            assert!(receipt.is_file());
        } else {
            result.unwrap();
            assert!(store.get(&id).unwrap().is_none());
            assert!(!recovery.exists());
        }
        assert_eq!(fs::read(&save).unwrap(), b"restored progress");
        assert_eq!(
            fs::read(canonical.join("mods/hd-link.o2r")).unwrap(),
            fs::read(&package).unwrap()
        );
        assert_eq!(fs::read(backup.path.join("backup.json")).unwrap(), manifest);
    }
}

#[test]
fn interrupted_unbound_restore_holds_only_when_a_setup_is_selected() {
    use crate::operation::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase};

    let (_temporary, service, _first) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let root = service.library().recovery_dir().join(&id);
    let staged = root.join("staged-data");
    fs::create_dir_all(&staged).unwrap();
    let mut operation = LifecycleOperation::new(&id, LifecycleOperationKind::Restore, "starship");
    operation.phase = LifecyclePhase::Prepared;
    operation.paths.staging = Some(root.clone());
    operation.paths.final_path = Some(service.library().user_dir("starship"));
    operation.paths.quarantine = Some(root.join("previous-data"));
    {
        let _guard = service
            .library()
            .try_lock_port("starship", "legacy restore")
            .unwrap();
        service
            .require_restore_snapshot_authority(&operation, &staged)
            .unwrap();
    }

    service.ensure_default_profile("starship").unwrap();
    let _guard = service
        .library()
        .try_lock_port("starship", "managed restore")
        .unwrap();
    let refusal = service
        .require_restore_snapshot_authority(&operation, &staged)
        .unwrap_err();
    assert!(refusal.message.contains("no verified backup receipt"));
    assert!(staged.is_dir());
    assert_eq!(operation.phase, LifecyclePhase::Prepared);
}

#[test]
fn edited_owned_files_are_held_not_overwritten() {
    let w = world();
    let package = archive(&w.scratch, "hd-link.o2r", &[("a.bin", b"hd")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    fs::write(user(&w).join("mods/hd-link.o2r"), b"edited in place").unwrap();
    let error = w
        .service
        .set_mod_package_enabled("starship", &w.default, "hd-link.o2r", false, 2)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(error.details["changed_owned"], "hd-link.o2r");
    assert_eq!(
        fs::read(user(&w).join("mods/hd-link.o2r")).unwrap(),
        b"edited in place"
    );
    let live = w.service.observe_live_mods("starship").unwrap();
    assert_eq!(live.changed_owned, ["hd-link.o2r"]);
}

#[test]
fn unsafe_wrong_type_and_executable_packages_are_refused_before_any_change() {
    let w = world();
    for (name, entries) in [
        ("evil.o2r", vec![("../x.bin", &b"x"[..])]),
        (
            "native.o2r",
            vec![("a.bin", &b"x"[..]), ("hook.dll", &b"MZ"[..])],
        ),
        ("wrong.zip", vec![("a.bin", &b"x"[..])]),
    ] {
        let package = archive(&w.scratch, name, &entries);
        assert!(
            w.service
                .install_mod_package("starship", &w.default, &package, 1)
                .is_err(),
            "{name}"
        );
    }
    assert_eq!(revision(&w, &w.default), 1);
    assert!(live_mods(&w).is_empty());
}

#[test]
fn switching_profiles_isolates_saves_and_mods_and_round_trips_progress() {
    let w = world();
    let package = archive(&w.scratch, "hd-link.o2r", &[("a.bin", b"hd")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    fs::create_dir_all(user(&w).join("saves")).unwrap();
    fs::write(user(&w).join("saves/file1.sav"), b"customized progress").unwrap();
    // A clean profile copies the default's setup but not its progress.
    let clean = w
        .service
        .copy_profile("starship", &w.default, "Clean")
        .unwrap();
    w.service
        .set_mod_package_enabled("starship", &clean.id, "hd-link.o2r", false, 1)
        .unwrap();
    w.service.activate_profile("starship", &clean.id).unwrap();
    assert!(live_mods(&w).is_empty(), "clean play has no mods");
    assert!(
        !user(&w).join("saves/file1.sav").exists(),
        "progress did not follow"
    );
    fs::create_dir_all(user(&w).join("saves")).unwrap();
    fs::write(user(&w).join("saves/file1.sav"), b"clean progress").unwrap();
    // Back to the customized profile: its mods and its own progress return.
    w.service.activate_profile("starship", &w.default).unwrap();
    assert_eq!(live_mods(&w), ["hd-link.o2r"]);
    assert_eq!(
        fs::read(user(&w).join("saves/file1.sav")).unwrap(),
        b"customized progress"
    );
    w.service.activate_profile("starship", &clean.id).unwrap();
    assert_eq!(
        fs::read(user(&w).join("saves/file1.sav")).unwrap(),
        b"clean progress"
    );
    assert!(live_mods(&w).is_empty());
    assert!(
        !user(&w)
            .join(STORE)
            .join("tmp")
            .read_dir()
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    );
}

#[test]
fn switching_holds_when_unmanaged_mod_files_would_cross_the_boundary() {
    let w = world();
    let other = w
        .service
        .copy_profile("starship", &w.default, "Other")
        .unwrap();
    fs::create_dir_all(user(&w).join("mods")).unwrap();
    fs::write(user(&w).join("mods/stray.o2r"), b"unknown").unwrap();
    let error = w
        .service
        .activate_profile("starship", &other.id)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(live_mods(&w), ["stray.o2r"]);
    let selected = w.service.library().connection().unwrap();
    assert_eq!(
        profile::selection(&selected, "starship")
            .unwrap()
            .unwrap()
            .0,
        w.default
    );
}

#[test]
fn switching_keeps_the_ship_loader_empty_marker_and_holds_edited_bytes() {
    let w = world();
    let other = w
        .service
        .copy_profile("starship", &w.default, "Other")
        .unwrap();
    let marker = user(&w).join("mods/custom_mod_files_go_here.txt");
    fs::create_dir_all(marker.parent().unwrap()).unwrap();
    fs::write(&marker, b"").unwrap();

    let package = archive(&w.scratch, "hd-link.o2r", &[("objects/link.bin", b"hd")]);
    w.service
        .install_mod_package("starship", &other.id, &package, 1)
        .unwrap();
    w.service.activate_profile("starship", &other.id).unwrap();
    assert_eq!(
        live_mods(&w),
        ["custom_mod_files_go_here.txt", "hd-link.o2r"]
    );
    assert_eq!(fs::read(&marker).unwrap(), b"");
    w.service.activate_profile("starship", &w.default).unwrap();
    assert_eq!(live_mods(&w), ["custom_mod_files_go_here.txt"]);

    fs::write(&marker, b"player notes").unwrap();
    let held = w
        .service
        .activate_profile("starship", &other.id)
        .unwrap_err();
    assert_eq!(held.code, crate::ErrorCode::Conflict);
    assert_eq!(held.details["unmanaged"], "custom_mod_files_go_here.txt");
    assert_eq!(fs::read(&marker).unwrap(), b"player notes");

    fs::remove_file(&marker).unwrap();
    fs::create_dir(&marker).unwrap();
    let held = w
        .service
        .activate_profile("starship", &other.id)
        .unwrap_err();
    assert_eq!(held.details["unmanaged"], "custom_mod_files_go_here.txt");
    assert!(marker.is_dir());
}

#[test]
fn an_interrupted_switch_resumes_without_losing_either_profiles_progress() {
    let w = world();
    let other = w
        .service
        .copy_profile("starship", &w.default, "Other")
        .unwrap();
    fs::create_dir_all(user(&w).join("saves")).unwrap();
    fs::write(user(&w).join("saves/a.sav"), b"default progress").unwrap();
    // Simulate a crash after parking: the journal exists, data already moved.
    let layout = Layout::for_user(&user(&w));
    fs::create_dir_all(layout.store()).unwrap();
    fs::write(
        layout.journal(),
        serde_json::json!({"from": w.default, "to": other.id, "revision": 1, "phase": "start"})
            .to_string(),
    )
    .unwrap();
    fs::create_dir_all(layout.parked(&w.default)).unwrap();
    fs::rename(
        user(&w).join("saves"),
        layout.parked(&w.default).join("saves"),
    )
    .unwrap();
    // Any locked operation first completes the interrupted switch.
    w.service.activate_profile("starship", &other.id).unwrap();
    assert!(!layout.journal().exists());
    let selected = w.service.library().connection().unwrap();
    assert_eq!(
        profile::selection(&selected, "starship")
            .unwrap()
            .unwrap()
            .0,
        other.id
    );
    w.service.activate_profile("starship", &w.default).unwrap();
    assert_eq!(
        fs::read(user(&w).join("saves/a.sav")).unwrap(),
        b"default progress"
    );
}

#[test]
fn installing_into_a_background_profile_waits_in_the_store_and_deploys_on_activation() {
    let w = world();
    let other = w
        .service
        .copy_profile("starship", &w.default, "Other")
        .unwrap();
    let package = archive(&w.scratch, "later.o2r", &[("a.bin", b"x")]);
    w.service
        .install_mod_package("starship", &other.id, &package, 1)
        .unwrap();
    assert!(
        live_mods(&w).is_empty(),
        "the selected profile is unaffected"
    );
    w.service.activate_profile("starship", &other.id).unwrap();
    assert_eq!(live_mods(&w), ["later.o2r"]);
    let _ = (Library::now(), ProfileUpdatePolicy::KeepCurrent);
}

#[test]
fn pending_restore_mark_guards_collection_and_clears_once_the_build_is_synced() {
    let w = world();
    let layout = Layout::for_user(&user(&w));
    assert!(!restore_pending(&layout.user));
    mark_restore_pending(&layout).unwrap();
    assert!(restore_pending(&layout.user));
    clear_restore_pending(&layout.user).unwrap();
    clear_restore_pending(&layout.user).unwrap();
    assert!(!restore_pending(&layout.user));
    // Profile changes leave no lasting mark when the build can be refreshed
    // (here the fixture build is unlaunched, so launch preparation restores it).
    let package = archive(&w.scratch, "pending.o2r", &[("a.bin", b"x")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    assert!(!restore_pending(&layout.user));
}

#[test]
fn a_switch_interrupted_after_unparking_resumes_without_reparking_arrived_data() {
    let w = world();
    let other = w
        .service
        .copy_profile("starship", &w.default, "Other")
        .unwrap();
    let layout = Layout::for_user(&user(&w));
    // State at "deployed": the default's saves are parked, the target's already live.
    fs::create_dir_all(layout.parked(&w.default).join("saves")).unwrap();
    fs::write(
        layout.parked(&w.default).join("saves/a.sav"),
        b"default progress",
    )
    .unwrap();
    fs::create_dir_all(user(&w).join("saves")).unwrap();
    fs::write(user(&w).join("saves/a.sav"), b"other progress").unwrap();
    write_journal(
        &layout,
        &w.default,
        &other.id,
        1,
        Phase::Deployed,
        &declared_state_paths(&w.service, "starship", &layout).unwrap(),
    )
    .unwrap();
    // Recovery must neither re-park the arrived data nor fail on a name collision.
    w.service
        .recover_switch_locked("starship", &layout)
        .unwrap();
    assert!(!layout.journal().exists());
    assert_eq!(
        fs::read(user(&w).join("saves/a.sav")).unwrap(),
        b"other progress"
    );
    assert_eq!(
        fs::read(layout.parked(&w.default).join("saves/a.sav")).unwrap(),
        b"default progress"
    );
    // Both profiles keep their own progress through the next switch back.
    w.service.activate_profile("starship", &w.default).unwrap();
    assert_eq!(
        fs::read(user(&w).join("saves/a.sav")).unwrap(),
        b"default progress"
    );
}

#[test]
fn imported_native_ids_cannot_name_files_outside_the_mods_folder() {
    for bad in [
        "../../x",
        "/etc/passwd",
        "a/b.o2r",
        "a\\b.o2r",
        ".hidden",
        "c:evil",
        "",
        "x.o2r.",
        "x.o2r ",
    ] {
        assert!(!profile::valid_native_id(bad), "{bad}");
    }
    assert!(profile::valid_native_id("hd-link.o2r"));
    let layout = Layout::for_user(Path::new("/tmp/does-not-matter/user/starship"));
    assert!(live_package_path(&layout, "../escape").is_err());
    assert!(live_package_path(&layout, "ok.o2r").is_ok());
}

#[test]
fn a_missing_target_package_fails_before_any_departing_mod_is_removed() {
    let w = world();
    let package = archive(&w.scratch, "keep.o2r", &[("a.bin", b"x")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    let other = w
        .service
        .copy_profile("starship", &w.default, "Other")
        .unwrap();
    // The other profile names a package whose stored bytes are absent (as after an
    // import that did not carry the package store).
    let missing = ResolvedPackage {
        native_id: "missing.o2r".into(),
        native_version: None,
        provider: None,
        sha256: "d".repeat(64),
        size: 1,
        enabled: true,
        requires: Vec::new(),
        provider_requires: Vec::new(),
    };
    let request = ProfileRevisionRequest {
        expected_revision: 1,
        packages: Some(vec![missing]),
        orderings: Some(Vec::new()),
        ..Default::default()
    };
    w.service
        .create_profile_revision("starship", &other.id, &request)
        .unwrap();
    let error = w
        .service
        .activate_profile("starship", &other.id)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Verification);
    assert_eq!(
        live_mods(&w),
        ["keep.o2r"],
        "departing mods were not removed"
    );
    let selected = w.service.library().connection().unwrap();
    assert_eq!(
        profile::selection(&selected, "starship")
            .unwrap()
            .unwrap()
            .0,
        w.default
    );
}

#[test]
fn recovery_holds_instead_of_deleting_a_player_edited_owned_file() {
    let w = world();
    let package = archive(&w.scratch, "mine.o2r", &[("a.bin", b"x")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    let other = w
        .service
        .copy_profile("starship", &w.default, "Other")
        .unwrap();
    let layout = Layout::for_user(&user(&w));
    write_journal(
        &layout,
        &w.default,
        &other.id,
        1,
        Phase::Start,
        &declared_state_paths(&w.service, "starship", &layout).unwrap(),
    )
    .unwrap();
    fs::write(user(&w).join("mods/mine.o2r"), b"edited by the player").unwrap();
    assert!(
        w.service
            .recover_switch_locked("starship", &layout)
            .is_err()
    );
    assert_eq!(
        fs::read(user(&w).join("mods/mine.o2r")).unwrap(),
        b"edited by the player"
    );
    assert!(layout.journal().exists(), "the switch stays resumable");
}

fn native_list(world: &World) -> Option<String> {
    let bytes = fs::read(user(world).join("starship.cfg.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["CVars"]["gSettings"]["EnabledMods"]
        .as_str()
        .map(str::to_owned)
}

fn install(world: &World, profile: &str, name: &str, expected: u64) -> Result<ProfileRevision> {
    let package = archive(&world.scratch, name, &[(name, name.as_bytes())]);
    world
        .service
        .install_mod_package("starship", profile, &package, expected)
}

fn native_status(world: &World) -> NativeModListStatus {
    world
        .service
        .observe_live_mods("starship")
        .unwrap()
        .native_list
}

#[test]
fn the_game_list_names_exactly_the_enabled_packages_in_override_order() {
    let w = world();
    install(&w, &w.default, "b-models.o2r", 1).unwrap();
    install(&w, &w.default, "a-sounds.otr", 2).unwrap();
    // Installation order is the override order; the last listed mod wins.
    assert_eq!(native_list(&w).as_deref(), Some("b-models|a-sounds"));
    assert_eq!(native_status(&w), NativeModListStatus::InSync);
    w.service
        .set_mod_package_enabled("starship", &w.default, "b-models.o2r", false, 3)
        .unwrap();
    assert_eq!(native_list(&w).as_deref(), Some("a-sounds"));
    assert_eq!(live_mods(&w), ["a-sounds.otr"]);
    w.service
        .set_mod_package_enabled("starship", &w.default, "a-sounds.otr", false, 4)
        .unwrap();
    assert_eq!(
        native_list(&w).as_deref(),
        Some(""),
        "clean play lists nothing"
    );
}

#[test]
fn the_same_mod_under_another_extension_replaces_and_unlistable_names_are_refused() {
    let w = world();
    install(&w, &w.default, "a-first.o2r", 1).unwrap();
    install(&w, &w.default, "Link.otr", 2).unwrap();
    install(&w, &w.default, "z-last.o2r", 3).unwrap();
    // The same mod under another extension replaces it and keeps its place.
    let replaced = install(&w, &w.default, "link.o2r", 4).unwrap();
    assert_eq!(live_mods(&w), ["a-first.o2r", "link.o2r", "z-last.o2r"]);
    assert_eq!(
        replaced.orderings[0].native_ids,
        ["a-first.o2r", "link.o2r", "z-last.o2r"]
    );
    assert_eq!(native_list(&w).as_deref(), Some("a-first|link|z-last"));
    // A list separator in a name would split it into two native entries.
    #[cfg(unix)]
    {
        assert!(install(&w, &w.default, "a|b.o2r", 5).is_err());
        assert_eq!(revision(&w, &w.default), 5, "nothing was recorded");
    }
}

#[test]
fn a_reorder_in_the_game_menu_becomes_the_next_revision() {
    let w = world();
    install(&w, &w.default, "b.o2r", 1).unwrap();
    install(&w, &w.default, "a.o2r", 2).unwrap();
    let config = user(&w).join("starship.cfg.json");
    // The player drags `a` above `b` and changes an unrelated setting.
    fs::write(
        &config,
        br#"{"CVars":{"gSettings":{"EnabledMods":"a|b","Volume":{"Master":20}}}}"#,
    )
    .unwrap();
    assert_eq!(
        native_status(&w),
        NativeModListStatus::Reordered {
            native_order: vec!["a".into(), "b".into()]
        }
    );
    w.service
        .reconcile_native_mod_list_locked("starship")
        .unwrap();
    let inventory = w.service.profile_inventory("starship").unwrap();
    let current = inventory
        .profiles
        .iter()
        .find(|view| view.profile.id == w.default)
        .unwrap();
    assert_eq!(current.profile.current_revision, 4);
    let connection = w.service.library().connection().unwrap();
    let adopted = profile::current_revision(&connection, "starship", &w.default).unwrap();
    assert_eq!(adopted.orderings[0].native_ids, ["a.o2r", "b.o2r"]);
    assert_eq!(native_status(&w), NativeModListStatus::InSync);
    // Adopting again is a no-op; the unrelated setting is untouched.
    w.service
        .reconcile_native_mod_list_locked("starship")
        .unwrap();
    assert_eq!(revision(&w, &w.default), 4);
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(value["CVars"]["gSettings"]["Volume"]["Master"], 20);
}

#[test]
fn ship_partial_lists_hold_play_and_clear_list_keeps_enabled_packages() {
    let w = world();
    install(&w, &w.default, "b.o2r", 1).unwrap();
    install(&w, &w.default, "a.o2r", 2).unwrap();
    let config = user(&w).join("starship.cfg.json");
    // A partial list is ambiguous in Ship's order-only menu. Keep the
    // player's entry and avoid interpreting the absence as a disable.
    fs::write(
        &config,
        br#"{"CVars":{"gSettings":{"EnabledMods":"mine|b"}}}"#,
    )
    .unwrap();
    assert_eq!(
        native_status(&w),
        NativeModListStatus::Differs {
            missing: vec!["a".into()],
            unexpected: Vec::new(),
        }
    );
    let held = w
        .service
        .prepare_native_mod_list_locked("starship")
        .unwrap_err();
    assert_eq!(held.code, crate::ErrorCode::Conflict);
    assert_eq!(native_list(&w).as_deref(), Some("mine|b"));
    assert_eq!(revision(&w, &w.default), 3);
    assert_eq!(live_mods(&w), ["a.o2r", "b.o2r"]);

    // Clear List is Ship's explicit request for a rebuild. Both packages
    // still belong to the setup and its reviewed projection stays effective.
    fs::write(&config, br#"{"CVars":{"gSettings":{"EnabledMods":""}}}"#).unwrap();
    w.service
        .prepare_native_mod_list_locked("starship")
        .unwrap();
    assert_eq!(native_list(&w).as_deref(), Some("b|a"));
    assert_eq!(revision(&w, &w.default), 3);
    assert!(restore_pending(&user(&w)));
}

#[test]
fn the_players_own_list_entries_keep_their_positions() {
    let w = world();
    install(&w, &w.default, "hd.o2r", 1).unwrap();
    install(&w, &w.default, "sfx.o2r", 2).unwrap();
    // The player's own mods surround the managed ones in their chosen order.
    fs::write(
        user(&w).join("starship.cfg.json"),
        br#"{"CVars":{"gSettings":{"EnabledMods":"zz-mine|hd|aa-mine|sfx"}}}"#,
    )
    .unwrap();
    assert_eq!(native_status(&w), NativeModListStatus::InSync);
    w.service
        .prepare_native_mod_list_locked("starship")
        .unwrap();
    assert_eq!(native_list(&w).as_deref(), Some("zz-mine|hd|aa-mine|sfx"));
    // Disabling a managed mod only removes its own entry.
    w.service
        .set_mod_package_enabled("starship", &w.default, "hd.o2r", false, 3)
        .unwrap();
    assert_eq!(native_list(&w).as_deref(), Some("zz-mine|sfx|aa-mine"));
}

#[test]
fn a_revision_the_game_cannot_load_unambiguously_is_never_recorded_or_switched_to() {
    let w = world();
    install(&w, &w.default, "a.o2r", 1).unwrap();
    let connection = w.service.library().connection().unwrap();
    let current = profile::current_revision(&connection, "starship", &w.default).unwrap();
    let mut colliding = current.packages[0].clone();
    colliding.native_id = "A.otr".into();
    let mut packages = current.packages.clone();
    packages.push(colliding);
    let refused = w
        .service
        .create_profile_revision(
            "starship",
            &w.default,
            &ProfileRevisionRequest {
                expected_revision: 2,
                packages: Some(packages.clone()),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert_eq!(refused.code, crate::ErrorCode::Conflict);
    assert_eq!(revision(&w, &w.default), 2);

    // A legacy or imported profile already holding such a revision: switching to
    // it refuses before any data is parked.
    let other = w
        .service
        .copy_profile("starship", &w.default, "Legacy")
        .unwrap();
    let mut legacy = profile::current_revision(&connection, "starship", &other.id).unwrap();
    legacy.revision = 2;
    legacy.parent_revision = Some(1);
    legacy.packages = packages;
    profile::seal(&mut legacy).unwrap();
    profile::write_revision(&connection, &legacy).unwrap();
    let mut record = w
        .service
        .profile_inventory("starship")
        .unwrap()
        .profiles
        .into_iter()
        .find(|view| view.profile.id == other.id)
        .unwrap()
        .profile;
    record.current_revision = 2;
    profile::write_profile(&connection, &record).unwrap();
    fs::create_dir_all(user(&w).join("saves")).unwrap();
    fs::write(user(&w).join("saves/file1.sav"), b"progress").unwrap();
    assert!(w.service.activate_profile("starship", &other.id).is_err());
    assert!(!Layout::for_user(&user(&w)).journal().exists());
    assert_eq!(
        fs::read(user(&w).join("saves/file1.sav")).unwrap(),
        b"progress"
    );
    // Switching among valid profiles still works.
    let clean = w
        .service
        .copy_profile("starship", &w.default, "Clean")
        .unwrap();
    w.service.activate_profile("starship", &clean.id).unwrap();
}

#[test]
fn a_menu_reorder_is_kept_before_switching_away() {
    let w = world();
    install(&w, &w.default, "b.o2r", 1).unwrap();
    install(&w, &w.default, "a.o2r", 2).unwrap();
    let clean = w
        .service
        .copy_profile("starship", &w.default, "Clean")
        .unwrap();
    fs::write(
        user(&w).join("starship.cfg.json"),
        br#"{"CVars":{"gSettings":{"EnabledMods":"a|b"}}}"#,
    )
    .unwrap();
    w.service.activate_profile("starship", &clean.id).unwrap();
    w.service.activate_profile("starship", &w.default).unwrap();
    assert_eq!(native_list(&w).as_deref(), Some("a|b"));
    let connection = w.service.library().connection().unwrap();
    let adopted = profile::current_revision(&connection, "starship", &w.default).unwrap();
    assert_eq!(adopted.orderings[0].native_ids, ["a.o2r", "b.o2r"]);
}

#[test]
fn each_profile_keeps_its_own_list_and_settings_across_switches() {
    let w = world();
    install(&w, &w.default, "hd.o2r", 1).unwrap();
    fs::write(
        user(&w).join("starship.cfg.json"),
        br#"{"CVars":{"gSettings":{"EnabledMods":"hd","Volume":{"Master":70}}}}"#,
    )
    .unwrap();
    let clean = w
        .service
        .copy_profile("starship", &w.default, "Clean")
        .unwrap();
    w.service
        .set_mod_package_enabled("starship", &clean.id, "hd.o2r", false, 1)
        .unwrap();
    w.service.activate_profile("starship", &clean.id).unwrap();
    assert_eq!(native_list(&w).as_deref(), Some(""));
    w.service.activate_profile("starship", &w.default).unwrap();
    assert_eq!(native_list(&w).as_deref(), Some("hd"));
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(user(&w).join("starship.cfg.json")).unwrap()).unwrap();
    assert_eq!(value["CVars"]["gSettings"]["Volume"]["Master"], 70);
}

#[test]
fn an_unreadable_game_configuration_is_reported_and_never_rewritten() {
    let w = world();
    install(&w, &w.default, "hd.o2r", 1).unwrap();
    let config = user(&w).join("starship.cfg.json");
    fs::write(&config, b"{broken").unwrap();
    assert!(matches!(
        native_status(&w),
        NativeModListStatus::Unreadable { .. }
    ));
    w.service
        .prepare_native_mod_list_locked("starship")
        .unwrap();
    install(&w, &w.default, "more.o2r", 2).unwrap();
    assert_eq!(fs::read(&config).unwrap(), b"{broken");
}

#[test]
fn the_setups_view_offers_mods_only_where_a_reviewed_contract_exists() {
    let w = world();
    let unsupported = w.service.mod_setups("opengoal-jak1").unwrap();
    assert!(!unsupported.supported && unsupported.inventory.is_none());
    install(&w, &w.default, "hd.o2r", 1).unwrap();
    let view = w.service.mod_setups("starship").unwrap();
    assert!(view.supported);
    assert_eq!(view.package_types, ["o2r", "otr"]);
    let inventory = view.inventory.unwrap();
    assert_eq!(inventory.profiles.len(), 1);
    let live = view.live.unwrap();
    assert_eq!(live.profile_id.as_deref(), Some(w.default.as_str()));
    assert_eq!(live.native_list, NativeModListStatus::InSync);
}

#[test]
fn a_change_reviewed_before_a_menu_reorder_still_applies_and_keeps_the_new_order() {
    let w = world();
    install(&w, &w.default, "b.o2r", 1).unwrap();
    install(&w, &w.default, "a.o2r", 2).unwrap();
    install(&w, &w.default, "c.o2r", 3).unwrap();
    let shown = revision(&w, &w.default);
    fs::write(
        user(&w).join("starship.cfg.json"),
        br#"{"CVars":{"gSettings":{"EnabledMods":"c|a|b"}}}"#,
    )
    .unwrap();
    // The player turns off `a` from the view read before the reorder was kept.
    let next = w
        .service
        .set_mod_package_enabled("starship", &w.default, "a.o2r", false, shown)
        .unwrap();
    assert_eq!(next.revision, shown + 2, "reorder kept, then the change");
    assert_eq!(native_list(&w).as_deref(), Some("c|b"));
    // A change that is not order-only still needs a new review.
    let stale = install(&w, &w.default, "d.o2r", shown).unwrap_err();
    assert_eq!(stale.code, crate::ErrorCode::Conflict);
}

#[test]
fn launch_pins_a_non_default_profiles_exact_build_without_moving_the_active_pointer() {
    use crate::retained_build::tests::install;
    let w = world();
    let first = w
        .service
        .library()
        .all_installs()
        .unwrap()
        .into_iter()
        .find(|install| install.id == "first")
        .unwrap();
    let pinned = w
        .service
        .copy_profile("starship", &w.default, "Pinned")
        .unwrap();
    // The customized profile retains its exact build after Default advances.
    let second = install(w.service.library(), "second", b"newer runtime", true);
    let active = || {
        w.service
            .library()
            .all_installs()
            .unwrap()
            .into_iter()
            .find(|install| install.id == "second")
    };
    // The default profile follows whatever is active, as a single-setup player expects.
    let chosen = w
        .service
        .profile_pinned_install("starship", active())
        .unwrap()
        .unwrap();
    assert_eq!(chosen.id, second.id);
    // Selecting the pinned profile launches the exact build its revision names.
    w.service.activate_profile("starship", &pinned.id).unwrap();
    let chosen = w
        .service
        .profile_pinned_install("starship", active())
        .unwrap()
        .unwrap();
    assert_eq!(chosen.id, first.id, "the pinned build, not the latest");
    // The global active selection is untouched.
    let status = w.service.status("starship").unwrap();
    assert_eq!(status.active.unwrap().id, second.id);
    // No installation means nothing to pin.
    assert!(
        w.service
            .profile_pinned_install("starship", None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_retained_pin_keeps_projection_pending_instead_of_refreshing_global_active() {
    let w = world();
    install(&w, &w.default, "a.o2r", 1).unwrap();
    let pinned = w
        .service
        .copy_profile("starship", &w.default, "Pinned")
        .unwrap();
    crate::retained_build::tests::install(
        w.service.library(),
        "new-active",
        b"different runtime",
        true,
    );
    w.service.activate_profile("starship", &pinned.id).unwrap();
    let selected = w
        .service
        .set_mod_package_enabled("starship", &pinned.id, "a.o2r", false, 1)
        .unwrap();
    assert!(!selected.packages[0].enabled);
    assert!(live_mods(&w).is_empty());
    assert!(restore_pending(&user(&w)));
}

#[test]
fn an_unavailable_pinned_build_holds_the_launch_instead_of_substituting_latest() {
    use crate::retained_build::tests::install;
    let w = world();
    let pinned = w
        .service
        .copy_profile("starship", &w.default, "Pinned")
        .unwrap();
    let second = install(w.service.library(), "second", b"newer runtime", true);
    w.service.activate_profile("starship", &pinned.id).unwrap();
    // The pinned build's bytes go missing.
    let first = w
        .service
        .library()
        .all_installs()
        .unwrap()
        .into_iter()
        .find(|install| install.id == "first")
        .unwrap();
    fs::remove_file(first.path.join(".portcove-manifest.json")).unwrap();
    let error = w
        .service
        .profile_pinned_install("starship", Some(second))
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert!(error.message.contains("no other build was substituted"));
}

const RECOMP: &str = "zelda64-recomp";

struct RecompWorld {
    _temporary: tempfile::TempDir,
    scratch: PathBuf,
    service: PortcoveService,
    default: String,
}

fn recomp_world() -> RecompWorld {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    crate::retained_build::tests::install_port(&library, RECOMP, "first", b"recomp runtime", true);
    let service = PortcoveService::new_read_only(library).unwrap();
    let scratch = temporary.path().join("scratch");
    fs::create_dir_all(&scratch).unwrap();
    let default = service.ensure_default_profile(RECOMP).unwrap().id;
    RecompWorld {
        _temporary: temporary,
        scratch,
        service,
        default,
    }
}

fn manifest(id: &str, dependencies: &[&str]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "game_id": "mm", "id": id, "display_name": id, "version": "1.0.0",
        "authors": ["someone"], "minimum_recomp_version": "1.2.0",
        "dependencies": dependencies,
    }))
    .unwrap()
}

impl RecompWorld {
    fn user(&self) -> PathBuf {
        self.service.library().user_dir(RECOMP)
    }

    fn nrm(&self, file: &str, id: &str, dependencies: &[&str], extra: &[(&str, &[u8])]) -> PathBuf {
        let manifest = manifest(id, dependencies);
        let mut entries = vec![
            ("mod.json", manifest.as_slice()),
            ("textures/a.png", b"png"),
        ];
        entries.extend_from_slice(extra);
        archive(&self.scratch, file, &entries)
    }

    fn install(&self, file: &str, id: &str, dependencies: &[&str]) -> Result<ProfileRevision> {
        let package = self.nrm(file, id, dependencies, &[]);
        let current = self.revision();
        self.service
            .install_mod_package(RECOMP, &self.default, &package, current)
    }

    fn revision(&self) -> u64 {
        self.service
            .profile_inventory(RECOMP)
            .unwrap()
            .profiles
            .into_iter()
            .find(|view| view.profile.id == self.default)
            .unwrap()
            .profile
            .current_revision
    }

    fn list(&self) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.user().join("mods.json")).unwrap()).unwrap()
    }

    fn live(&self) -> Vec<String> {
        let mut names = fs::read_dir(self.user().join("mods"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn status(&self) -> NativeModListStatus {
        self.service.observe_live_mods(RECOMP).unwrap().native_list
    }
}

#[test]
fn recomp_launch_checks_the_native_backup_without_reenabling_a_disabled_package() {
    let w = recomp_world();
    w.install("safe.nrm", "safe", &[]).unwrap();
    let both = w.install("disabled.nrm", "disabled", &[]).unwrap();
    let selected = w
        .service
        .set_mod_package_enabled(RECOMP, &w.default, "disabled.nrm", false, both.revision)
        .unwrap();
    let primary = w.user().join("mods.json");
    let backup = primary.with_extension("json.bak");
    fs::remove_file(&primary).unwrap();
    let safe_backup = br#"{"enabled_mods":["safe","mm_recomp_dpad_builtin"],"mod_order":["disabled","mm_recomp_dpad_builtin","safe"],"future":{"v":1}}"#;
    let unexpected_enabled =
        br#"{"enabled_mods":["safe","disabled"],"mod_order":["safe","disabled"]}"#;
    fs::write(&backup, safe_backup).unwrap();
    let launch_preflight = || {
        let _guard = w
            .service
            .library()
            .try_lock_port(RECOMP, "fallback launch")
            .unwrap();
        w.service.prepare_native_mod_list_locked(RECOMP)
    };
    assert_eq!(w.status(), NativeModListStatus::InSync);
    launch_preflight().unwrap();
    assert!(!primary.exists());
    assert_eq!(fs::read(&backup).unwrap(), safe_backup);
    assert_eq!(w.live(), ["safe.nrm"]);

    fs::write(&backup, unexpected_enabled).unwrap();
    let refusal = launch_preflight().unwrap_err();
    assert_eq!(refusal.details["unexpected"], "disabled");
    assert!(!primary.exists());
    assert_eq!(fs::read(&backup).unwrap(), unexpected_enabled);
    assert_eq!(w.live(), ["safe.nrm"]);

    // A broken existing primary might still win under the game's parser. Core
    // retains both files and holds, even with a separately usable backup.
    fs::write(&primary, b"{broken").unwrap();
    fs::write(&backup, safe_backup).unwrap();
    assert_eq!(
        launch_preflight()
            .unwrap_err()
            .presentation()
            .presentation_key,
        "native_mod_list_review"
    );
    assert_eq!(fs::read(&primary).unwrap(), b"{broken");
    assert_eq!(fs::read(&backup).unwrap(), safe_backup);

    // When both exist, a valid primary wins over the stale backup.
    fs::write(&primary, safe_backup).unwrap();
    fs::write(&backup, unexpected_enabled).unwrap();
    launch_preflight().unwrap();
    assert_eq!(
        w.list()["enabled_mods"],
        serde_json::json!(["mm_recomp_dpad_builtin", "safe"])
    );
    assert_eq!(w.list()["future"]["v"], 1);
    assert_eq!(fs::read(&backup).unwrap(), unexpected_enabled);

    fs::remove_file(&primary).unwrap();
    fs::remove_file(&backup).unwrap();
    launch_preflight().unwrap();
    assert_eq!(w.list()["enabled_mods"], serde_json::json!(["safe"]));
    assert_eq!(w.list()["mod_order"], serde_json::json!(["safe"]));
    assert!(!backup.exists());
    assert_eq!(w.live(), ["safe.nrm"]);
    assert_eq!(w.revision(), selected.revision);
}

#[test]
fn recomp_asset_mods_are_named_by_manifest_id_and_listed_in_mods_json() {
    let w = recomp_world();
    let first = w
        .install(
            "Downloaded Pack (1).nrm",
            "hd_textures",
            &["mm_recomp_dpad_builtin:1.0.0"],
        )
        .unwrap();
    assert_eq!(first.packages[0].native_id, "hd_textures.nrm");
    assert_eq!(first.packages[0].native_version.as_deref(), Some("1.0.0"));
    assert!(
        first.packages[0].requires.is_empty(),
        "built-ins need no package"
    );
    w.install("ui.nrm", "better_ui", &[]).unwrap();
    assert_eq!(w.live(), ["better_ui.nrm", "hd_textures.nrm"]);
    assert_eq!(
        w.list(),
        serde_json::json!({
            "enabled_mods": ["hd_textures", "better_ui"],
            "mod_order": ["hd_textures", "better_ui"],
        })
    );
    assert_eq!(w.status(), NativeModListStatus::InSync);
    let view = w.service.mod_setups(RECOMP).unwrap();
    assert_eq!(view.package_types, ["nrm"]);
    assert!(
        !view.later_mods_take_priority,
        "which mod wins is not established"
    );

    // Turning a mod off removes its file and its entries, so the runtime cannot
    // re-enable it.
    w.service
        .set_mod_package_enabled(RECOMP, &w.default, "hd_textures.nrm", false, w.revision())
        .unwrap();
    assert_eq!(w.live(), ["better_ui.nrm"]);
    assert_eq!(w.list()["enabled_mods"], serde_json::json!(["better_ui"]));
    assert_eq!(w.list()["mod_order"], serde_json::json!(["better_ui"]));
}

#[test]
fn recomp_mods_that_run_code_or_belong_to_another_game_are_refused() {
    let w = recomp_world();
    let code = w.nrm(
        "code.nrm",
        "speedrun_timer",
        &[],
        &[("mod_binary.bin", b"\0"), ("mod_syms.bin", b"\0")],
    );
    let error = w
        .service
        .install_mod_package(RECOMP, &w.default, &code, 1)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Usage);
    assert!(error.message.contains("runs its own code"));
    assert_eq!(
        error.details.get("sha256").map(String::as_str),
        Some(sha256_file(&code).unwrap().as_str()),
        "the refusal names the bytes to allow"
    );
    let other = archive(
        &w.scratch,
        "other.nrm",
        &[(
            "mod.json",
            br#"{"game_id":"oot","id":"x","display_name":"X","version":"1.0.0",
                "authors":["a"],"minimum_recomp_version":"1.0.0"}"#,
        )],
    );
    let error = w
        .service
        .install_mod_package(RECOMP, &w.default, &other, 1)
        .unwrap_err();
    assert!(error.message.contains("different game"));
    assert_eq!(w.revision(), 1, "nothing was recorded");
    assert!(!w.user().join("mods.json").exists());
}

#[test]
fn recomp_local_review_checks_versions_before_offering_code_consent() {
    let w = recomp_world();
    w.install("base.nrm", "base_pack", &[]).unwrap();
    let revision = w.revision();
    let incompatible = w.nrm(
        "incompatible.nrm",
        "extra",
        &["base_pack:2.0.0"],
        &[("mod_binary.bin", b"\0"), ("mod_syms.bin", b"\0")],
    );
    let error = w
        .service
        .plan_local_mod_package(RECOMP, &w.default, &incompatible, revision)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported);
    assert_eq!(error.details["requires"], "base_pack");
    assert_eq!(error.details["minimum_version"], "2.0.0");
    assert_eq!(w.revision(), revision);
    assert_eq!(w.live(), ["base_pack.nrm"]);
    let layout = Layout::for_user(&w.user());
    assert!(!layout.code_consent().exists());
    assert!(
        !layout
            .package(&sha256_file(&incompatible).unwrap(), "extra.nrm")
            .exists()
    );

    let missing = w.nrm(
        "missing.nrm",
        "extra",
        &["missing_library:1.0.0"],
        &[("mod_binary.bin", b"\0"), ("mod_syms.bin", b"\0")],
    );
    let review = w
        .service
        .plan_local_mod_package(RECOMP, &w.default, &missing, revision)
        .unwrap();
    assert_eq!(review.missing_required_mods, ["missing_library.nrm"]);
    assert!(!review.needs_code_permission);

    w.service
        .set_mod_package_enabled(RECOMP, &w.default, "base_pack.nrm", false, revision)
        .unwrap();
    let disabled_replacement = w.nrm("new-base.nrm", "base_pack", &["*:2.0.0"], &[]);
    let review = w
        .service
        .plan_local_mod_package(RECOMP, &w.default, &disabled_replacement, w.revision())
        .unwrap();
    assert!(!review.replaces_enabled);
}

#[test]
fn recomp_draft_reports_local_code_after_resolving_queued_dependencies() {
    let w = recomp_world();
    w.install("base.nrm", "base_pack", &[]).unwrap();
    let mut upgraded: serde_json::Value =
        serde_json::from_slice(&manifest("base_pack", &[])).unwrap();
    upgraded["version"] = "2.0.0".into();
    let upgraded = serde_json::to_vec(&upgraded).unwrap();
    let dependency = archive(&w.scratch, "new-base.nrm", &[("mod.json", &upgraded)]);
    let package = w.nrm(
        "extra.nrm",
        "extra",
        &["base_pack:2.0.0"],
        &[("mod_binary.bin", b"\0"), ("mod_syms.bin", b"\0")],
    );
    let revision = w.revision();
    assert!(
        w.service
            .plan_local_mod_package(RECOMP, &w.default, &package, revision)
            .is_err()
    );
    let local_files = [dependency, package]
        .into_iter()
        .map(|path| {
            let review = w
                .service
                .plan_workspace_local_mod_package(RECOMP, &w.default, &path, revision)
                .unwrap();
            LocalModDraftFile {
                path,
                expected_plan_sha256: review.plan_sha256,
            }
        })
        .collect();
    let edits = ModSetupEdits {
        packages: vec![],
        order: None,
        local_files,
    };
    let preview = w
        .service
        .preview_mod_setup_draft(RECOMP, &w.default, revision, &[], &edits)
        .unwrap();
    assert_eq!(preview.local_code_packages, ["extra.nrm"]);
    let error = w
        .service
        .apply_mod_setup_draft(RECOMP, &w.default, revision, &[], &edits, false)
        .unwrap_err();
    assert!(error.message.contains("needs permission to run code"));
    assert_eq!(w.revision(), revision);
    let applied = w
        .service
        .apply_mod_setup_draft(RECOMP, &w.default, revision, &[], &edits, true)
        .unwrap();
    assert_eq!(applied.revision, revision + 1);
    assert_eq!(w.live(), ["base_pack.nrm", "extra.nrm"]);
}

#[test]
fn recomp_dependencies_must_be_installed_and_stay_on() {
    let w = recomp_world();
    let missing = w
        .install("addon.nrm", "addon", &["base_pack:1.0.0"])
        .unwrap_err();
    assert_eq!(missing.code, crate::ErrorCode::Conflict);
    assert_eq!(w.revision(), 1);
    w.install("base.nrm", "base_pack", &[]).unwrap();
    let added = w
        .install("addon.nrm", "addon", &["base_pack:1.0.0"])
        .unwrap();
    assert_eq!(added.packages[0].requires, ["base_pack.nrm"]);
    let refused = w
        .service
        .set_mod_package_enabled(RECOMP, &w.default, "base_pack.nrm", false, w.revision())
        .unwrap_err();
    assert_eq!(refused.code, crate::ErrorCode::Conflict);
    assert!(refused.message.contains("turn that one on first"));
    assert_eq!(w.live(), ["addon.nrm", "base_pack.nrm"]);
    // Turning the dependent mod off first is allowed.
    w.service
        .set_mod_package_enabled(RECOMP, &w.default, "addon.nrm", false, w.revision())
        .unwrap();
    w.service
        .set_mod_package_enabled(RECOMP, &w.default, "base_pack.nrm", false, w.revision())
        .unwrap();
}

#[test]
fn recomp_menu_reorders_and_disables_become_revisions_and_keep_player_entries() {
    let w = recomp_world();
    w.install("a.nrm", "alpha", &[]).unwrap();
    w.install("b.nrm", "beta", &[]).unwrap();
    // The player reorders in the runtime's menu and keeps the built-in off.
    fs::write(
        w.user().join("mods.json"),
        br#"{"enabled_mods":["beta","alpha","own_mod"],
            "mod_order":["mm_recomp_dpad_builtin","beta","own_mod","alpha"],
            "future":{"kept":true}}"#,
    )
    .unwrap();
    assert_eq!(
        w.status(),
        NativeModListStatus::Reordered {
            native_order: vec!["beta".into(), "alpha".into()]
        }
    );
    let shown = w.revision();
    let _guard = w.service.library().try_lock_port(RECOMP, "test").unwrap();
    w.service.reconcile_native_mod_list_locked(RECOMP).unwrap();
    drop(_guard);
    assert_eq!(w.revision(), shown + 1, "the reorder became a revision");
    assert_eq!(w.status(), NativeModListStatus::InSync);

    // Disabling a managed mod becomes a successor and removes only the
    // deployed file. The retained package stays available in Portcove.
    fs::write(
        w.user().join("mods.json"),
        br#"{"enabled_mods":["beta","own_mod"],
            "mod_order":["mm_recomp_dpad_builtin","beta","own_mod","alpha"],
            "future":{"kept":true}}"#,
    )
    .unwrap();
    assert_eq!(
        w.status(),
        NativeModListStatus::Differs {
            missing: vec!["alpha".into()],
            unexpected: Vec::new(),
        }
    );
    w.service.prepare_native_mod_list_locked(RECOMP).unwrap();
    assert_eq!(w.revision(), shown + 2);
    assert_eq!(w.live(), ["beta.nrm"]);
    assert_eq!(w.status(), NativeModListStatus::InSync);
    assert!(restore_pending(&w.user()));

    w.install("c.nrm", "gamma", &[]).unwrap();
    let list = w.list();
    assert_eq!(
        list["mod_order"],
        serde_json::json!(["mm_recomp_dpad_builtin", "beta", "own_mod", "gamma"])
    );
    assert_eq!(
        list["enabled_mods"],
        serde_json::json!(["own_mod", "beta", "gamma"])
    );
    assert_eq!(list["future"]["kept"], true);
    assert_eq!(w.status(), NativeModListStatus::InSync);
}

#[test]
fn recomp_native_disable_with_an_enabled_dependent_stays_in_review() {
    let w = recomp_world();
    w.install("base.nrm", "base_pack", &[]).unwrap();
    w.install("addon.nrm", "addon", &["base_pack:1.0.0"])
        .unwrap();
    let before = w.revision();
    let path = w.user().join("mods.json");
    let native = br#"{"enabled_mods":["addon"],"mod_order":["base_pack","addon"],"custom":true}"#;
    fs::write(&path, native).unwrap();
    let held = w
        .service
        .prepare_native_mod_list_locked(RECOMP)
        .unwrap_err();
    assert_eq!(held.code, crate::ErrorCode::Conflict);
    assert_eq!(held.details["missing"], "base_pack");
    assert_eq!(fs::read(&path).unwrap(), native);
    assert_eq!(w.revision(), before);
    assert_eq!(w.live(), ["addon.nrm", "base_pack.nrm"]);

    // A deliberate choice in Portcove can resolve the held native change.
    w.service
        .set_mod_package_enabled(RECOMP, &w.default, "addon.nrm", false, before)
        .unwrap();
    w.service
        .set_mod_package_enabled(RECOMP, &w.default, "base_pack.nrm", false, before + 1)
        .unwrap();
    assert!(w.live().is_empty());
    assert!(w.list()["custom"].as_bool().unwrap());
}

#[test]
fn recomp_missing_enabled_field_is_not_a_disable() {
    let w = recomp_world();
    w.install("a.nrm", "alpha", &[]).unwrap();
    let before = w.revision();
    fs::write(
        w.user().join("mods.json"),
        br#"{"mod_order":["own_mod","alpha"],"custom":true}"#,
    )
    .unwrap();
    assert_eq!(w.status(), NativeModListStatus::NotWritten);
    w.service.prepare_native_mod_list_locked(RECOMP).unwrap();
    assert_eq!(w.revision(), before);
    assert_eq!(w.live(), ["alpha.nrm"]);
    assert_eq!(
        w.list()["mod_order"],
        serde_json::json!(["own_mod", "alpha"])
    );
}

#[test]
fn recomp_switching_profiles_swaps_mods_and_their_list_and_keeps_progress() {
    let w = recomp_world();
    w.install("a.nrm", "alpha", &[]).unwrap();
    fs::create_dir_all(w.user().join("saves")).unwrap();
    fs::write(w.user().join("saves/file1.bin"), b"modded progress").unwrap();
    let clean = w.service.copy_profile(RECOMP, &w.default, "Clean").unwrap();
    let request = crate::ProfileRevisionRequest {
        expected_revision: clean.current_revision,
        packages: Some(Vec::new()),
        orderings: Some(Vec::new()),
        ..Default::default()
    };
    w.service
        .create_profile_revision(RECOMP, &clean.id, &request)
        .unwrap();
    w.service.activate_profile(RECOMP, &clean.id).unwrap();
    assert!(w.live().is_empty());
    assert!(!w.user().join("saves/file1.bin").exists());
    assert_eq!(
        w.service.observe_live_mods(RECOMP).unwrap().native_list,
        NativeModListStatus::InSync
    );
    assert_eq!(w.list()["enabled_mods"], serde_json::json!([]));
    fs::create_dir_all(w.user().join("saves")).unwrap();
    fs::write(w.user().join("saves/file1.bin"), b"clean progress").unwrap();

    w.service.activate_profile(RECOMP, &w.default).unwrap();
    assert_eq!(w.live(), ["alpha.nrm"]);
    assert_eq!(w.list()["enabled_mods"], serde_json::json!(["alpha"]));
    assert_eq!(
        fs::read(w.user().join("saves/file1.bin")).unwrap(),
        b"modded progress"
    );
    w.service.activate_profile(RECOMP, &clean.id).unwrap();
    assert_eq!(
        fs::read(w.user().join("saves/file1.bin")).unwrap(),
        b"clean progress",
        "each setup keeps its own newer progress"
    );
}

#[test]
fn recomp_self_runtime_and_unusable_ids_are_handled_before_anything_is_stored() {
    let w = recomp_world();
    // `.` and `*` name the mod itself and the runtime: version floors, not packages.
    let floors = w
        .install("floors.nrm", "floors", &[".:1.0.0", "*:1.2.0"])
        .unwrap();
    assert!(floors.packages[0].requires.is_empty());

    let store = Layout::for_user(&w.user()).store();
    let stored = || {
        walk(&store)
            .into_iter()
            .filter(|path| path.extension().is_some_and(|ext| ext == "nrm"))
            .count()
    };
    let before = stored();
    for id in ["NUL", &"x".repeat(200)] {
        let error = w.install("bad.nrm", id, &[]).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported, "{id}");
        assert!(error.message.contains("cannot be used as a file name"));
    }
    assert_eq!(stored(), before, "nothing was stored for refused IDs");

    // The runtime knows a mod by its ID: the same ID under another file name
    // replaces the installed package instead of adding a second one.
    let renamed = w.install("floors (copy).nrm", "floors", &[]).unwrap();
    assert_eq!(renamed.packages.len(), 1);
    assert_eq!(w.live(), ["floors.nrm"]);

    let missing = w.install("addon.nrm", "addon", &["base_pack"]).unwrap_err();
    assert!(
        missing
            .message
            .contains("not installed; install that one first")
    );
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return found;
    };
    for entry in entries {
        let path = entry.unwrap().path();
        if path.is_dir() {
            found.extend(walk(&path));
        } else {
            found.push(path);
        }
    }
    found
}

#[test]
fn an_upgraded_copy_uses_the_current_build_and_leaves_the_pinned_setup_on_its_own() {
    use crate::retained_build::tests::install;
    let w = world();
    let pinned = w
        .service
        .copy_profile("starship", &w.default, "Pinned")
        .unwrap();
    // The game later updates; the customized setup keeps its exact build.
    let second = install(w.service.library(), "second", b"newer runtime", true);
    let view = w.service.mod_setups("starship").unwrap();
    assert_eq!(view.current_install_id.as_deref(), Some("second"));
    let build_of = |id: &str| {
        w.service
            .profile_inventory("starship")
            .unwrap()
            .profiles
            .into_iter()
            .find(|view| view.profile.id == id)
            .unwrap()
            .revision
    };
    assert_eq!(build_of(&pinned.id).build.install_id, "first");

    let upgraded = w
        .service
        .copy_profile_onto_current_build("starship", &pinned.id, "Pinned on the update")
        .unwrap();
    let copy = build_of(&upgraded.id);
    let original = build_of(&pinned.id);
    assert_eq!(copy.build.install_id, "second");
    assert_eq!(copy.packages, original.packages, "the same mods");
    assert_ne!(copy.save_group, original.save_group, "its own progress");
    assert_eq!(
        original.build.install_id, "first",
        "the original is unchanged"
    );
    assert_eq!(original.revision, 1);

    // Launching the upgraded copy uses the current build; the original still
    // launches its own.
    w.service
        .activate_profile("starship", &upgraded.id)
        .unwrap();
    let chosen = w
        .service
        .profile_pinned_install("starship", Some(second.clone()))
        .unwrap()
        .unwrap();
    assert_eq!(chosen.id, "second");
    w.service.activate_profile("starship", &pinned.id).unwrap();
    let chosen = w
        .service
        .profile_pinned_install("starship", Some(second))
        .unwrap()
        .unwrap();
    assert_eq!(chosen.id, "first");
}

#[test]
fn recomp_code_runs_only_for_the_exact_bytes_the_player_allowed() {
    let w = recomp_world();
    let code = w.nrm(
        "code.nrm",
        "speedrun_timer",
        &[],
        &[("mod_binary.bin", b"\0"), ("mod_syms.bin", b"\0")],
    );
    let sha = sha256_file(&code).unwrap();
    // Consent for other bytes does not cover this package.
    let error = w
        .service
        .install_mod_package_allowing_code(RECOMP, &w.default, &code, 1, &"0".repeat(64))
        .unwrap_err();
    assert!(error.message.contains("runs its own code"));
    assert_eq!(w.revision(), 1);
    let installed = w
        .service
        .install_mod_package_allowing_code(RECOMP, &w.default, &code, 1, &sha)
        .unwrap();
    assert_eq!(installed.packages[0].native_id, "speedrun_timer.nrm");
    assert_eq!(w.live(), ["speedrun_timer.nrm"]);
    assert_eq!(
        w.list()["enabled_mods"],
        serde_json::json!(["speedrun_timer"])
    );

    // A later version is new bytes and needs its own consent.
    let newer = w.nrm(
        "code2.nrm",
        "speedrun_timer",
        &[],
        &[("mod_binary.bin", b"\x01"), ("mod_syms.bin", b"\0")],
    );
    let error = w
        .service
        .install_mod_package(RECOMP, &w.default, &newer, w.revision())
        .unwrap_err();
    assert!(error.message.contains("runs its own code"));
    assert_eq!(
        w.live(),
        ["speedrun_timer.nrm"],
        "the allowed version stays"
    );

    // Libraries loaded by the operating system are never admitted, even with consent.
    let manifest = br#"{"game_id":"mm","id":"native_helper","display_name":"N","version":"1.0.0",
        "authors":["a"],"minimum_recomp_version":"1.0.0","native_libraries":{"helper":["run"]}}"#;
    let native = archive(
        &w.scratch,
        "native.nrm",
        &[("mod.json", manifest.as_slice())],
    );
    let error = w
        .service
        .install_mod_package_allowing_code(
            RECOMP,
            &w.default,
            &native,
            w.revision(),
            &sha256_file(&native).unwrap(),
        )
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported);
    assert!(error.message.contains("outside its package"));
}

fn code_package(w: &RecompWorld, file: &str, marker: &[u8]) -> (PathBuf, String) {
    let package = w.nrm(
        file,
        "speedrun_timer",
        &[],
        &[("mod_binary.bin", marker), ("mod_syms.bin", b"\0")],
    );
    let sha = sha256_file(&package).unwrap();
    (package, sha)
}

fn code_revision_request(expected: u64, sha: &str, size: u64) -> crate::ProfileRevisionRequest {
    crate::ProfileRevisionRequest {
        expected_revision: expected,
        packages: Some(vec![ResolvedPackage {
            native_id: "speedrun_timer.nrm".into(),
            native_version: Some("1.0.0".into()),
            provider: None,
            sha256: sha.into(),
            size,
            enabled: true,
            requires: Vec::new(),
            provider_requires: Vec::new(),
        }]),
        ..Default::default()
    }
}

#[test]
fn code_without_consent_is_never_recorded_from_stored_or_live_bytes() {
    let w = recomp_world();
    let (code, sha) = code_package(&w, "code.nrm", b"\0");
    let size = fs::metadata(&code).unwrap().len();
    // Bytes in the store without consent (for example from a recipe).
    let layout = w.service.deploy_layout(RECOMP).unwrap();
    let stored = layout.package(&sha, "speedrun_timer.nrm");
    fs::create_dir_all(stored.parent().unwrap()).unwrap();
    fs::copy(&code, &stored).unwrap();
    let other = w
        .service
        .copy_profile(RECOMP, &w.default, "Forged")
        .unwrap();
    let error = w
        .service
        .create_profile_revision(RECOMP, &other.id, &code_revision_request(1, &sha, size))
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert!(error.message.contains("runs its own code"), "{error:?}");
    fs::remove_file(&stored).unwrap();

    // The same file dropped into the live mods folder is not adopted either.
    fs::create_dir_all(w.user().join("mods")).unwrap();
    fs::copy(&code, w.user().join("mods").join("speedrun_timer.nrm")).unwrap();
    let error = w
        .service
        .create_profile_revision(RECOMP, &w.default, &code_revision_request(1, &sha, size))
        .unwrap_err();
    assert!(error.message.contains("runs its own code"), "{error:?}");
    assert_eq!(w.revision(), 1, "nothing was recorded");
    assert!(!w.user().join("mods.json").exists(), "nothing was enabled");
}

#[test]
fn a_recipe_reports_missing_local_code_consent_even_when_exact_bytes_are_available() {
    let w = recomp_world();
    let (package, sha) = code_package(&w, "code.nrm", b"\0");
    w.service
        .install_mod_package_allowing_code(RECOMP, &w.default, &package, 1, &sha)
        .unwrap();
    let recipe = w
        .service
        .export_profile_recipe(RECOMP, &w.default, None)
        .unwrap();
    let layout = w.service.deploy_layout(RECOMP).unwrap();
    std::fs::remove_file(layout.code_consent()).unwrap();
    let held = w.service.plan_recipe_import(&recipe).unwrap();
    assert_eq!(held.packages[0].status, crate::RecipeInputStatus::Available);
    assert_eq!(held.code_approval.len(), 1);
    assert_eq!(
        held.code_approval[0].native_id,
        recipe.packages[0].native_id
    );
    assert_eq!(held.code_approval[0].sha256, sha);
    let refused = w
        .service
        .authorize_recipe_import(&held, "Shared")
        .unwrap_err();
    assert!(
        refused
            .message
            .contains("permission to run the exact mod code")
    );

    record_code_consent(&layout, &sha).unwrap();
    let reviewed = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(reviewed.code_approval.is_empty());
    assert_ne!(held.plan_sha256, reviewed.plan_sha256);
}

#[test]
fn a_switch_held_for_missing_consent_changes_nothing_and_allowing_the_file_resumes_it() {
    let w = recomp_world();
    let (code, sha) = code_package(&w, "code.nrm", b"\0");
    let other = w.service.copy_profile(RECOMP, &w.default, "Plain").unwrap();
    w.service
        .install_mod_package_allowing_code(RECOMP, &w.default, &code, 1, &sha)
        .unwrap();
    w.service.activate_profile(RECOMP, &other.id).unwrap();
    // The consent record is lost.
    let layout = w.service.deploy_layout(RECOMP).unwrap();
    fs::remove_file(layout.code_consent()).unwrap();
    let selection = || {
        crate::profile::selection(&w.service.library().connection().unwrap(), RECOMP)
            .unwrap()
            .unwrap()
    };
    let before = selection();
    let error = w.service.activate_profile(RECOMP, &w.default).unwrap_err();
    assert!(error.message.contains("runs its own code"), "{error:?}");
    assert_eq!(selection(), before, "the switch never started");
    assert!(!layout.journal().exists(), "nothing is left to recover");
    // The port stays usable, and allowing the same file again resumes the setup.
    let asset = w.nrm("ui.nrm", "better_ui", &[], &[]);
    let current = w
        .service
        .profile_inventory(RECOMP)
        .unwrap()
        .profiles
        .into_iter()
        .find(|view| view.profile.id == other.id)
        .unwrap()
        .profile
        .current_revision;
    w.service
        .install_mod_package(RECOMP, &other.id, &asset, current)
        .unwrap();
    w.service
        .install_mod_package_allowing_code(RECOMP, &w.default, &code, w.revision(), &sha)
        .unwrap();
    w.service.activate_profile(RECOMP, &w.default).unwrap();
    assert_eq!(w.live(), ["speedrun_timer.nrm"]);
}

#[test]
fn recorded_consent_is_reused_and_an_unreadable_record_fails_closed() {
    let w = recomp_world();
    let (code, sha) = code_package(&w, "code.nrm", b"\0");
    w.service
        .install_mod_package_allowing_code(RECOMP, &w.default, &code, 1, &sha)
        .unwrap();
    // Another setup can use the same allowed bytes without asking again.
    let other = w
        .service
        .copy_profile(RECOMP, &w.default, "Second")
        .unwrap();
    w.service.activate_profile(RECOMP, &other.id).unwrap();
    assert_eq!(w.live(), ["speedrun_timer.nrm"]);
    // Other bytes still need consent.
    let (newer, _) = code_package(&w, "code2.nrm", b"\x01");
    let current = w
        .service
        .profile_inventory(RECOMP)
        .unwrap()
        .profiles
        .into_iter()
        .find(|view| view.profile.id == other.id)
        .unwrap()
        .profile
        .current_revision;
    assert!(
        w.service
            .install_mod_package(RECOMP, &other.id, &newer, current)
            .is_err()
    );
    let layout = w.service.deploy_layout(RECOMP).unwrap();
    fs::write(layout.code_consent(), b"not json").unwrap();
    // A setup without code stays usable while the record is unreadable.
    let plain = w.service.copy_profile(RECOMP, &other.id, "Plain").unwrap();
    let request = crate::ProfileRevisionRequest {
        expected_revision: 1,
        packages: Some(Vec::new()),
        orderings: Some(Vec::new()),
        ..Default::default()
    };
    w.service
        .create_profile_revision(RECOMP, &plain.id, &request)
        .unwrap();
    w.service.activate_profile(RECOMP, &plain.id).unwrap();
    let asset = w.nrm("ui.nrm", "better_ui", &[], &[]);
    w.service
        .install_mod_package(RECOMP, &plain.id, &asset, 2)
        .unwrap();
    assert_eq!(w.live(), ["better_ui.nrm"]);
    // It allows nothing: code is refused, and recording consent needs the record repaired.
    let error = w
        .service
        .install_mod_package(RECOMP, &plain.id, &code, 3)
        .unwrap_err();
    assert!(error.message.contains("runs its own code"), "{error:?}");
    let error = w
        .service
        .install_mod_package_allowing_code(RECOMP, &plain.id, &code, 3, &sha)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::State);
    assert!(error.details.contains_key("path"));
    let error = w.service.activate_profile(RECOMP, &other.id).unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::State, "{error:?}");
}

#[test]
fn reviewing_a_package_reports_its_code_without_changing_anything() {
    let w = recomp_world();
    let asset = w.nrm("ui.nrm", "better_ui", &[], &[]);
    assert_eq!(
        w.service.review_mod_package_code(RECOMP, &asset).unwrap(),
        None
    );
    let (code, sha) = code_package(&w, "code.nrm", b"\0");
    let review = w
        .service
        .review_mod_package_code(RECOMP, &code)
        .unwrap()
        .unwrap();
    assert_eq!(review.native_id, "speedrun_timer");
    assert_eq!(review.sha256, sha);
    assert_eq!(review.runs, [crate::RecompExecution::RecompiledCode]);
    assert!(!review.already_allowed);
    assert_eq!(w.revision(), 1, "reviewing changes nothing");
    w.service
        .install_mod_package_allowing_code(RECOMP, &w.default, &code, 1, &sha)
        .unwrap();
    assert!(
        w.service
            .review_mod_package_code(RECOMP, &code)
            .unwrap()
            .unwrap()
            .already_allowed
    );
    // Games whose loader runs no mod code have nothing to review.
    assert_eq!(
        w.service
            .review_mod_package_code("shipwright", &asset)
            .ok()
            .flatten(),
        None
    );
}

#[test]
fn recovery_restores_exact_custom_runtime_and_disabled_state_while_keeping_newer_progress() {
    let w = world();
    let service = &w.service;
    let port = "starship";
    let customized = service.copy_profile(port, &w.default, "Play").unwrap();
    let profile_id = &customized.id;
    service.activate_profile(port, profile_id).unwrap();
    let mod_file = archive(&w.scratch, "custom.o2r", &[("asset.bin", b"mod asset")]);
    let earlier = service
        .install_mod_package(port, profile_id, &mod_file, 1)
        .unwrap();
    let active =
        crate::retained_build::tests::install(service.library(), "updated", b"newer runtime", true);
    let moved = service
        .create_profile_revision(
            port,
            profile_id,
            &ProfileRevisionRequest {
                expected_revision: earlier.revision,
                install_id: Some(active.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    service.activate_profile(port, profile_id).unwrap();
    let disabled = service
        .set_mod_package_enabled(port, profile_id, "custom.o2r", false, moved.revision)
        .unwrap();
    fs::create_dir_all(user(&w).join("saves")).unwrap();
    let save = user(&w).join("saves/file1.sav");
    fs::write(&save, b"newer progress").unwrap();
    let active_save = active.path.join("saves/file1.sav");
    fs::create_dir_all(active_save.parent().unwrap()).unwrap();
    fs::write(&active_save, b"other runtime bytes").unwrap();
    fs::write(active.path.join(".portcove-launched"), b"").unwrap();

    let plan = service
        .plan_profile_recovery(port, profile_id, earlier.revision)
        .unwrap();
    assert!(plan.holds.is_empty(), "{:?}", plan.holds);
    assert_eq!(plan.progress, ProfileRecoveryProgress::KeepCurrent);
    assert_eq!(plan.target, earlier);
    assert_eq!(plan.current, disabled);
    let layout = service.deploy_layout(port).unwrap();
    let package = &plan.target.packages[0];
    let kept = layout.package(&package.sha256, &package.native_id);
    fs::remove_file(&kept).unwrap();
    let held = service
        .plan_profile_recovery(port, profile_id, earlier.revision)
        .unwrap();
    assert!(
        held.holds
            .iter()
            .any(|hold| hold.details.get("package") == Some(&package.native_id))
    );
    assert!(
        service
            .apply_profile_recovery(port, profile_id, earlier.revision, &plan.plan_sha256)
            .is_err()
    );
    assert_eq!(revision(&w, profile_id), disabled.revision);

    fs::copy(mod_file, kept).unwrap();
    let next = service
        .apply_profile_recovery(port, profile_id, earlier.revision, &plan.plan_sha256)
        .unwrap();
    assert_eq!(next.parent_revision, Some(disabled.revision));
    assert_eq!(next.build, earlier.build);
    assert_eq!(next.save_group, disabled.save_group);
    assert_eq!(live_mods(&w), ["custom.o2r"]);
    assert_eq!(fs::read(&save).unwrap(), b"newer progress");
    assert_eq!(fs::read(active_save).unwrap(), b"other runtime bytes");
    assert!(restore_pending(&user(&w)));
    assert_eq!(
        service
            .profile_pinned_install(port, Some(active.clone()))
            .unwrap()
            .unwrap()
            .id,
        earlier.build.install_id
    );
    assert_eq!(
        service
            .library()
            .status(port, crate::ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap()
            .id,
        active.id
    );
    let plan = service
        .plan_profile_recovery(port, profile_id, disabled.revision)
        .unwrap();
    let next = service
        .apply_profile_recovery(port, profile_id, disabled.revision, &plan.plan_sha256)
        .unwrap();
    assert!(!next.packages[0].enabled);
    assert!(live_mods(&w).is_empty());
    assert_eq!(fs::read(save).unwrap(), b"newer progress");
}

#[test]
fn interrupted_recovery_blocks_launch_until_its_committed_revision_is_materialized() {
    let w = world();
    let service = &w.service;
    let port = "starship";
    let package = archive(&w.scratch, "custom.o2r", &[("asset.bin", b"mod asset")]);
    let current = service
        .install_mod_package(port, &w.default, &package, 1)
        .unwrap();
    let config = user(&w).join("starship.cfg.json");
    fs::write(
        &config,
        br#"{"CVars":{"gSettings":{"EnabledMods":"custom|unmanaged"}}}"#,
    )
    .unwrap();
    let plan = service.plan_profile_recovery(port, &w.default, 1).unwrap();
    assert!(plan.holds.is_empty());
    let guard = service
        .library()
        .try_lock_port(port, "recover-profile")
        .unwrap();
    let layout = service.deploy_layout(port).unwrap();
    mark_restore_pending(&layout).unwrap();
    let committed = service
        .publish_profile_successor_locked(port, &current, plan.target)
        .unwrap();
    drop(guard);
    assert_eq!(live_mods(&w), ["custom.o2r"]);
    let restarted = PortcoveService::new(service.library().clone()).unwrap();
    assert!(
        restarted
            .require_materialized_profile_recovery(port)
            .is_err()
    );
    assert_eq!(
        restarted.activate_profile(port, &w.default).unwrap(),
        committed
    );
    restarted
        .require_materialized_profile_recovery(port)
        .unwrap();
    assert!(live_mods(&w).is_empty());
    let config: serde_json::Value = serde_json::from_slice(&fs::read(config).unwrap()).unwrap();
    assert_eq!(config["CVars"]["gSettings"]["EnabledMods"], "unmanaged");
    assert_eq!(revision(&w, &w.default), committed.revision);
    assert!(
        restarted
            .apply_profile_recovery(port, &w.default, 1, &plan.plan_sha256)
            .is_err()
    );
}

#[test]
fn recomp_captures_typed_settings_and_recovers_them_with_newer_progress() {
    let w = recomp_world();
    let manifest = serde_json::json!({
        "game_id": "mm", "id": "buffer_size", "display_name": "Buffer",
        "version": "1.0.0", "authors": ["someone"], "minimum_recomp_version": "1.2.0",
        "config_schema": {"options": [
            {"id": "size", "name": "Size", "type": "Number", "default": 1024, "min": 128, "max": 8192},
            {"id": "local", "name": "Local name", "type": "String", "default": ""}
        ]}
    })
    .to_string();
    let package = archive(
        &w.scratch,
        "buffer.nrm",
        &[("mod.json", manifest.as_bytes())],
    );
    let installed = w
        .service
        .install_mod_package(RECOMP, &w.default, &package, 1)
        .unwrap();
    let custom = w
        .service
        .copy_profile(RECOMP, &w.default, "Buffer setup")
        .unwrap();
    w.service.activate_profile(RECOMP, &custom.id).unwrap();
    let path = w.user().join("mod_config/buffer_size.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let edit = |value| {
        let document = serde_json::json!({
            "mod_id": "buffer_size", "mod_version": "1.0.0", "future": true,
            "storage": {"size": value, "local": "/private/player/value", "future_value": 3}
        });
        fs::write(&path, document.to_string()).unwrap();
        let _guard = w.service.library().try_lock_port(RECOMP, "test").unwrap();
        w.service.reconcile_native_mod_list_locked(RECOMP).unwrap();
        w.service
            .profile_revisions(RECOMP, &custom.id)
            .unwrap()
            .pop()
            .unwrap()
    };
    let earlier = edit(1024);
    let snapshot = w.scratch.join("saved-setup");
    crate::service::copy_tree(&w.user(), &snapshot).unwrap();
    w.service
        .require_restore_profile_projection(RECOMP, &snapshot)
        .unwrap();
    let later = edit(2048);
    let conflict = w
        .service
        .require_restore_profile_projection(RECOMP, &snapshot)
        .unwrap_err();
    assert_eq!(conflict.details["mod_settings"], "differs");
    let key = format!(
        "recomp-config/buffer_size/{}/size",
        installed.packages[0].sha256
    );
    assert_eq!(earlier.settings.get(&key).unwrap(), "1024.0");
    assert_eq!(later.settings.get(&key).unwrap(), "2048.0");
    assert_eq!(later.settings.len(), 1);
    let uncaptured = w
        .service
        .plan_profile_recovery(RECOMP, &custom.id, 1)
        .unwrap();
    assert!(uncaptured.holds.iter().any(|hold| {
        hold.message
            .contains("did not capture all supported settings")
    }));
    let save = w.user().join("saves/modern.bin");
    fs::create_dir_all(save.parent().unwrap()).unwrap();
    fs::write(&save, b"newer progress").unwrap();
    let plan = w
        .service
        .plan_profile_recovery(RECOMP, &custom.id, earlier.revision)
        .unwrap();
    assert!(plan.holds.is_empty(), "{:?}", plan.holds);
    let restored = w
        .service
        .apply_profile_recovery(RECOMP, &custom.id, earlier.revision, &plan.plan_sha256)
        .unwrap();
    assert_eq!(restored.settings, earlier.settings);
    assert_eq!(fs::read(&save).unwrap(), b"newer progress");
    let config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(config["storage"]["size"].as_f64(), Some(1024.0));
    assert_eq!(config["storage"]["local"], "/private/player/value");
    assert_eq!(config["storage"]["future_value"], 3);
    assert_eq!(config["future"], true);

    let recipe = w
        .service
        .export_profile_recipe(RECOMP, &custom.id, None)
        .unwrap();
    let encoded = serde_json::to_vec(&recipe).unwrap();
    assert!(!String::from_utf8_lossy(&encoded).contains("/private/player/value"));
    assert_eq!(crate::ProfileRecipe::inspect(&encoded).unwrap(), recipe);
    assert_eq!(recipe.format, 2);
    assert_eq!(recipe.settings[0].option_id, "size");
    let review = w.service.plan_recipe_import(&recipe).unwrap();
    assert!(!review.can_apply, "this fixture has no admitted original");
    assert!(
        review
            .holds
            .iter()
            .any(|hold| hold.contains("does not identify the original"))
    );
    assert!(
        !review
            .holds
            .iter()
            .any(|hold| hold.contains("mod settings need review"))
    );
    assert_eq!(
        crate::recomp_mod_settings::import(&recipe.settings).unwrap(),
        earlier.settings,
    );

    let fixture_original = w.scratch.join("synthetic.z64");
    fs::write(
        &fixture_original,
        [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4, 5, 6, 7, 8],
    )
    .unwrap();
    let requirement = "majoras-mask";
    let original = w
        .service
        .register_source(requirement, &fixture_original)
        .unwrap();
    let instance =
        crate::source_instances::identity(&crate::profile::bind_original(requirement, &original))
            .unwrap();
    let selected = w
        .service
        .select_profile_original(
            RECOMP,
            &custom.id,
            restored.revision,
            requirement,
            &instance,
        )
        .unwrap();
    let exact = w
        .service
        .export_profile_recipe(RECOMP, &custom.id, Some(selected.revision))
        .unwrap();
    let reviewed = w.service.plan_recipe_import(&exact).unwrap();
    assert!(reviewed.can_apply, "{:?}", reviewed.holds);
    let approval = w
        .service
        .authorize_recipe_import(&reviewed, "Shared settings")
        .unwrap();
    let imported = w
        .service
        .apply_recipe_import(&reviewed, "Shared settings", &approval.token)
        .unwrap();
    let imported_revision = w
        .service
        .profile_revisions(RECOMP, &imported.id)
        .unwrap()
        .remove(0);
    assert_eq!(imported_revision.settings, selected.settings);
    assert_ne!(imported_revision.save_group, selected.save_group);
    let round_trip = w
        .service
        .export_profile_recipe(RECOMP, &imported.id, None)
        .unwrap();
    assert_eq!(round_trip, exact);
    assert_eq!(fs::read(&save).unwrap(), b"newer progress");

    // The effective list can remain in its backup while the selected revision
    // still supplies a missing supported option using the package's default.
    let primary = w.user().join("mods.json");
    let fallback = primary.with_extension("json.bak");
    let list_bytes = fs::read(&primary).unwrap();
    fs::rename(&primary, &fallback).unwrap();
    fs::remove_file(&path).unwrap();
    {
        let _guard = w
            .service
            .library()
            .try_lock_port(RECOMP, "fallback settings")
            .unwrap();
        w.service.prepare_native_mod_list_locked(RECOMP).unwrap();
    }
    assert!(!primary.exists());
    assert_eq!(fs::read(&fallback).unwrap(), list_bytes);
    let projected: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(projected["storage"]["size"].as_f64(), Some(1024.0));
    fs::rename(fallback, primary).unwrap();

    // An invalid arriving document is held before any switch journal or file
    // movement. The player can still park a setup with an invalid active edit.
    fs::write(&path, b"{broken").unwrap();
    w.service.activate_profile(RECOMP, &w.default).unwrap();
    let layout = w.service.deploy_layout(RECOMP).unwrap();
    let parked = layout
        .parked(&custom.id)
        .join("mod_config/buffer_size.json");
    assert_eq!(fs::read(&parked).unwrap(), b"{broken");
    assert!(w.service.activate_profile(RECOMP, &custom.id).is_err());
    assert!(!layout.journal().exists());
    assert_eq!(fs::read(&parked).unwrap(), b"{broken");
    assert_eq!(
        w.service
            .observe_live_mods(RECOMP)
            .unwrap()
            .profile_id
            .as_deref(),
        Some(w.default.as_str())
    );
}

#[test]
fn local_mod_review_binds_exact_bytes_and_reports_asset_overlap() {
    let w = world();
    let active = archive(&w.scratch, "active.otr", &[("assets/shared.png", b"old")]);
    let local = archive(&w.scratch, "local.o2r", &[("assets/shared.png", b"local")]);
    let mut installed = w
        .service
        .install_mod_package("starship", &w.default, &active, 1)
        .unwrap();
    let reviewed = w
        .service
        .plan_local_mod_package("starship", &w.default, &local, installed.revision)
        .unwrap();
    assert_eq!(reviewed.native_id, "local.o2r");
    assert_eq!(reviewed.overlapping_mods, ["active.otr"]);
    assert!(!reviewed.needs_code_permission);
    assert!(!reviewed.conflicts_truncated);

    let changed = archive(&w.scratch, "local.o2r", &[("assets/another.png", b"new")]);
    let refused = w
        .service
        .apply_local_mod_package(
            "starship",
            &w.default,
            &changed,
            &reviewed.plan_sha256,
            false,
        )
        .unwrap_err();
    assert_eq!(refused.code, crate::ErrorCode::Conflict);
    let refreshed = w
        .service
        .plan_local_mod_package("starship", &w.default, &changed, installed.revision)
        .unwrap();
    installed = w
        .service
        .apply_local_mod_package(
            "starship",
            &w.default,
            &changed,
            &refreshed.plan_sha256,
            false,
        )
        .unwrap();
    assert_eq!(installed.revision, reviewed.expected_revision + 1);
    assert_eq!(installed.packages.len(), 2);
}

#[test]
fn unmanaged_mod_file_preservation_rechecks_bytes_and_keeps_each_copy() {
    let w = world();
    let mods = user(&w).join("mods");
    fs::create_dir_all(mods.join("manual-folder")).unwrap();
    let file = mods.join("outside.o2r");
    let other = mods.join("other.txt");
    fs::write(&file, b"unreviewed bytes").unwrap();
    fs::write(&other, b"other file").unwrap();
    let plan = w
        .service
        .inspect_mod_file("starship", "outside.o2r")
        .unwrap();
    assert!(plan.restore.is_none());
    assert!(
        w.service
            .inspect_mod_file("starship", "manual-folder")
            .is_err()
    );
    assert!(
        w.service
            .inspect_mod_file("starship", "../outside.o2r")
            .is_err()
    );
    fs::write(&file, b"changed before apply").unwrap();
    let error = w
        .service
        .preserve_mod_file("starship", "outside.o2r", &plan.plan_sha256)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(fs::read(&file).unwrap(), b"changed before apply");
    let revised = w
        .service
        .inspect_mod_file("starship", "outside.o2r")
        .unwrap();
    let result = w
        .service
        .preserve_mod_file("starship", "outside.o2r", &revised.plan_sha256)
        .unwrap();
    assert!(!file.exists());
    assert_eq!(
        fs::read(&result.preserved_path).unwrap(),
        b"changed before apply"
    );
    assert_eq!(fs::read(&other).unwrap(), b"other file");
    assert!(mods.join("manual-folder").is_dir());

    fs::write(&file, b"changed before apply").unwrap();
    let duplicate = w
        .service
        .inspect_mod_file("starship", "outside.o2r")
        .unwrap();
    assert_ne!(duplicate.plan_sha256, revised.plan_sha256);
    let second = w
        .service
        .preserve_mod_file("starship", "outside.o2r", &duplicate.plan_sha256)
        .unwrap();
    assert_ne!(result.preserved_path, second.preserved_path);
    assert_eq!(
        fs::read(&second.preserved_path).unwrap(),
        b"changed before apply"
    );
    assert_eq!(
        fs::read(&result.preserved_path).unwrap(),
        b"changed before apply"
    );
    assert_eq!(revision(&w, &w.default), 1);
}

#[test]
fn changed_owned_mod_file_is_preserved_before_exact_restoration_after_interruption() {
    let w = world();
    let package = archive(&w.scratch, "hd.o2r", &[("objects/link.bin", b"original")]);
    let deployed = w
        .service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    assert!(w.service.inspect_mod_file("starship", "hd.o2r").is_err());
    let saves = user(&w).join("saves");
    fs::create_dir_all(&saves).unwrap();
    let progress = saves.join("current.sav");
    fs::write(&progress, b"older backed-up progress").unwrap();
    let backup = w.service.create_backup("starship").unwrap();
    let backup_action = crate::BackupAction::Restore;
    let backup_review = w
        .service
        .preview_backup_action("starship", &backup.id, backup_action)
        .unwrap();
    let backup_approval = w
        .service
        .authorize_backup_action(
            "starship",
            &backup.id,
            backup_action,
            &backup_review.preview_sha256,
        )
        .unwrap();
    fs::write(&progress, b"newer progress").unwrap();
    let layout = w.service.deploy_layout("starship").unwrap();
    let live = layout.mods().join("hd.o2r");
    fs::write(&live, b"locally edited").unwrap();
    let plan = w.service.inspect_mod_file("starship", "hd.o2r").unwrap();
    assert_eq!(
        plan.restore.as_ref().unwrap().sha256,
        deployed.packages[0].sha256
    );
    let pending = layout.store().join("file-preservation.json");
    let kept = layout
        .store()
        .join("preserved")
        .join(&plan.plan_sha256)
        .join("hd.o2r");
    fs::create_dir_all(kept.parent().unwrap()).unwrap();
    crate::durability::write_bytes_atomically(&pending, &serde_json::to_vec(&plan).unwrap(), false)
        .unwrap();
    mark_restore_pending(&layout).unwrap();
    crate::durability::rename_noreplace(&live, &kept).unwrap();
    assert!(!live.exists());
    assert!(
        w.service
            .observe_live_mods("starship")
            .unwrap()
            .pending_preservation
            .is_some()
    );

    let blocked_restore = w
        .service
        .restore_backup("starship", &backup.id, &backup_approval.token)
        .unwrap_err();
    assert_eq!(blocked_restore.code, crate::ErrorCode::Conflict);
    assert_eq!(blocked_restore.details["plan_sha256"], plan.plan_sha256);
    assert_eq!(fs::read(&progress).unwrap(), b"newer progress");
    let recovery = w
        .service
        .plan_profile_recovery("starship", &w.default, 1)
        .unwrap();
    assert!(recovery.holds.iter().any(|hold| {
        hold.code == crate::ErrorCode::Conflict
            && hold.details.get("plan_sha256") == Some(&plan.plan_sha256)
    }));
    assert!(
        w.service
            .apply_profile_recovery("starship", &w.default, 1, &recovery.plan_sha256)
            .is_err()
    );
    assert!(!live.exists());

    fs::write(&live, b"independent file after interruption").unwrap();
    let blocked = w
        .service
        .preserve_mod_file("starship", "hd.o2r", &plan.plan_sha256)
        .unwrap_err();
    assert_eq!(blocked.code, crate::ErrorCode::Conflict);
    assert_eq!(
        fs::read(&live).unwrap(),
        b"independent file after interruption"
    );
    assert_eq!(fs::read(&kept).unwrap(), b"locally edited");
    assert!(pending.exists());

    fs::remove_file(&live).unwrap();
    let _guard = w
        .service
        .library()
        .try_lock_port("starship", "test-launch-preflight")
        .unwrap();
    w.service
        .prepare_native_mod_list_locked("starship")
        .unwrap();
    assert_eq!(fs::read(&progress).unwrap(), b"newer progress");
    assert!(!pending.exists());
    assert_eq!(fs::read(&live).unwrap(), fs::read(&package).unwrap());
    assert_eq!(fs::read(&kept).unwrap(), b"locally edited");
    assert!(restore_pending(&user(&w)));
    assert_eq!(revision(&w, &w.default), deployed.revision);
}

#[test]
fn mod_file_preservation_holds_case_only_alias_of_an_enabled_package() {
    let w = world();
    let package = archive(&w.scratch, "hd.o2r", &[("objects/link.bin", b"original")]);
    w.service
        .install_mod_package("starship", &w.default, &package, 1)
        .unwrap();
    let mods = user(&w).join("mods");
    let temporary_name = mods.join("renaming.o2r");
    // An intermediate name makes the case-only rename observable on Windows.
    fs::rename(mods.join("hd.o2r"), &temporary_name).unwrap();
    fs::rename(&temporary_name, mods.join("HD.O2R")).unwrap();

    let error = w
        .service
        .inspect_mod_file("starship", "HD.O2R")
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
    assert_eq!(error.details["recorded_name"], "hd.o2r");
    assert_eq!(
        fs::read(mods.join("HD.O2R")).unwrap(),
        fs::read(package).unwrap()
    );
    assert!(
        w.service
            .observe_live_mods("starship")
            .unwrap()
            .pending_preservation
            .is_none()
    );
}

#[test]
fn creating_a_clean_setup_preserves_the_source_runtime_and_progress() {
    let w = world();
    let service = &w.service;
    let port = "starship";
    let package = archive(&w.scratch, "color.o2r", &[("asset.bin", b"changed colors")]);
    let source = service
        .install_mod_package(port, &w.default, &package, 1)
        .unwrap();
    let live_save = user(&w).join("saves/file1.sav");
    fs::create_dir_all(live_save.parent().unwrap()).unwrap();
    fs::write(&live_save, b"source progress").unwrap();

    assert_eq!(
        service
            .create_clean_profile(port, &w.default, "Stale", 1)
            .unwrap_err()
            .code,
        crate::ErrorCode::Conflict
    );
    assert_eq!(service.profile_inventory(port).unwrap().profiles.len(), 1);
    let clean = service
        .create_clean_profile(port, &w.default, "Fresh", source.revision)
        .unwrap();
    let initial = service
        .profile_revisions(port, &clean.id)
        .unwrap()
        .remove(0);
    assert_eq!(initial.build, source.build);
    assert_eq!(initial.originals, source.originals);
    assert_ne!(initial.save_group, source.save_group);
    assert!(initial.packages.is_empty() && initial.settings.is_empty());
    assert_eq!(live_mods(&w), ["color.o2r"]);
    assert_eq!(fs::read(&live_save).unwrap(), b"source progress");

    service.activate_profile(port, &clean.id).unwrap();
    assert!(live_mods(&w).is_empty());
    assert!(!live_save.exists());
    service.activate_profile(port, &w.default).unwrap();
    assert_eq!(live_mods(&w), ["color.o2r"]);
    assert_eq!(fs::read(live_save).unwrap(), b"source progress");
}

#[test]
fn mod_inventory_checks_metadata_without_reusing_payload_digests() {
    let (_temporary, service, install) = fixture();
    let profile = service.ensure_default_profile("starship").unwrap();
    let executable = install.path.join(&install.selected_executable);
    let file = fs::File::open(&executable).unwrap();
    let fingerprint = crate::adapter::preview_digest::Fingerprint::of(&file).unwrap();
    // Neither this poisoned digest nor the payload bytes are consulted by the
    // metadata preview. A copy still verifies fresh bytes outside any preview.
    crate::adapter::preview_digest::record(
        &executable,
        fingerprint,
        &("0".repeat(64), file.metadata().unwrap().len()),
    );
    let preview = service.preview_mod_setups("starship").unwrap();
    assert_eq!(
        preview.inventory.unwrap().profiles[0].build_availability,
        crate::RetainedBuildAvailability::Present
    );
    // A real setup mutation must hash the correct bytes instead of inheriting
    // either the metadata preview or its unrelated cached digest.
    let copied = service
        .copy_profile("starship", &profile.id, "Freshly verified")
        .unwrap();
    assert_ne!(copied.id, profile.id);
    let preview = service.preview_mod_setups("starship").unwrap();
    assert!(preview.inventory.unwrap().profiles.iter().all(|profile| {
        profile.build_availability == crate::RetainedBuildAvailability::Present
    }));
    assert!(
        service
            .mod_setups("starship")
            .unwrap()
            .inventory
            .unwrap()
            .profiles
            .iter()
            .all(|profile| {
                profile.build_availability == crate::RetainedBuildAvailability::Verified
            })
    );
}

#[test]
fn mod_inventory_metadata_never_authorizes_same_size_changed_runtime_bytes() {
    let (_temporary, service, install) = fixture();
    let profile = service.ensure_default_profile("starship").unwrap();
    let executable = install.path.join(&install.selected_executable);
    let modified = fs::metadata(&executable).unwrap().modified().unwrap();
    let mut bytes = fs::read(&executable).unwrap();
    let preview = service.preview_mod_setups("starship").unwrap();
    assert_eq!(
        preview.inventory.unwrap().profiles[0].build_availability,
        crate::RetainedBuildAvailability::Present
    );
    bytes[0] ^= 1;
    fs::write(&executable, bytes).unwrap();
    fs::File::options()
        .write(true)
        .open(&executable)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let preview = service.preview_mod_setups("starship").unwrap();
    assert_eq!(
        preview.inventory.unwrap().profiles[0].build_availability,
        crate::RetainedBuildAvailability::Present
    );
    assert_eq!(
        service.profile_inventory("starship").unwrap().profiles[0].build_availability,
        crate::RetainedBuildAvailability::Changed
    );
    assert_eq!(
        service
            .mod_setups("starship")
            .unwrap()
            .inventory
            .unwrap()
            .profiles[0]
            .build_availability,
        crate::RetainedBuildAvailability::Changed
    );
    assert!(
        service
            .copy_profile("starship", &profile.id, "Changed runtime")
            .is_err()
    );
    assert!(
        service
            .verified_retained_build("starship", &install.id)
            .is_err()
    );
    let qualification = crate::InstallQualification::from_catalog(
        service.catalog(),
        "starship",
        crate::Platform::current().unwrap(),
    )
    .unwrap();
    let installer = crate::Installer::new(service.library().clone()).unwrap();
    assert!(installer.verify_critical(&install, &qualification).is_err());
    assert!(
        installer
            .verify_critical_for_replacement(&install, &qualification)
            .is_err()
    );
    assert_eq!(
        service
            .profile_inventory("starship")
            .unwrap()
            .profiles
            .len(),
        1
    );
}

#[test]
fn mod_inventory_metadata_preserves_missing_and_changed_metadata_failures() {
    let (_temporary, service, install) = fixture();
    service.ensure_default_profile("starship").unwrap();
    let manifest = install.path.join(".portcove-manifest.json");
    let bytes = fs::read(&manifest).unwrap();
    fs::write(&manifest, b"changed manifest").unwrap();
    assert_eq!(
        service
            .preview_mod_setups("starship")
            .unwrap()
            .inventory
            .unwrap()
            .profiles[0]
            .build_availability,
        crate::RetainedBuildAvailability::Changed
    );
    fs::remove_file(&manifest).unwrap();
    assert_eq!(
        service
            .preview_mod_setups("starship")
            .unwrap()
            .inventory
            .unwrap()
            .profiles[0]
            .build_availability,
        crate::RetainedBuildAvailability::Missing
    );
    fs::write(&manifest, bytes).unwrap();
    fs::remove_file(install.path.join(&install.selected_executable)).unwrap();
    assert_eq!(
        service
            .preview_mod_setups("starship")
            .unwrap()
            .inventory
            .unwrap()
            .profiles[0]
            .build_availability,
        crate::RetainedBuildAvailability::Missing
    );
}

#[test]
fn mod_inventory_metadata_does_not_walk_or_authorize_unknown_runtime_files() {
    let (_temporary, service, install) = fixture();
    let profile = service.ensure_default_profile("starship").unwrap();
    fs::write(install.path.join("unknown-runtime-file.txt"), b"unrecorded").unwrap();
    let preview = service
        .preview_mod_setups("starship")
        .unwrap()
        .inventory
        .unwrap();
    assert_eq!(
        preview.profiles[0].build_availability,
        crate::RetainedBuildAvailability::Present
    );
    assert_eq!(
        service.profile_inventory("starship").unwrap().profiles[0].build_availability,
        crate::RetainedBuildAvailability::Changed
    );
    assert!(
        service
            .copy_profile("starship", &profile.id, "Refused")
            .is_err()
    );
    assert_eq!(
        service
            .profile_inventory("starship")
            .unwrap()
            .profiles
            .len(),
        1
    );
}

#[test]
fn mod_inventory_metadata_checks_current_binding_without_verifying_retained_history() {
    let (_temporary, service, first) = fixture();
    let profile = service.ensure_default_profile("starship").unwrap();
    let second = crate::retained_build::tests::install(
        service.library(),
        "second",
        b"next accepted runtime",
        true,
    );
    service.ensure_default_profile("starship").unwrap();
    fs::remove_file(first.path.join(&first.selected_executable)).unwrap();
    let preview = service
        .preview_mod_setups("starship")
        .unwrap()
        .inventory
        .unwrap();
    assert_eq!(
        preview.profiles[0].build_availability,
        crate::RetainedBuildAvailability::Present
    );
    assert_eq!(preview.profiles[0].revision.build.install_id, second.id);
    let strict = service
        .resolve_retained_build("starship", &profile.id)
        .unwrap();
    assert_eq!(
        strict.availability,
        crate::RetainedBuildAvailability::Verified
    );
    assert_eq!(strict.history.len(), 1);
    assert_eq!(
        strict.history[0].availability,
        crate::RetainedBuildAvailability::Missing
    );
}

#[test]
fn mod_inventory_metadata_keeps_current_runtime_policy_refusals() {
    let (_temporary, mut service, install) = fixture();
    let profile = service.ensure_default_profile("starship").unwrap();
    let mut document = service.catalog().authoritative_document();
    let port = document
        .ports
        .iter_mut()
        .find(|port| port.id == "starship")
        .unwrap();
    port.managed_acquisition_hold = Some(crate::ManagedAcquisitionHold {
        reason: "Fixture acquisition hold".into(),
        activation_reason: "Fixture runtime hold".into(),
        reviewed_artifacts: Vec::new(),
        excluded_artifacts: Vec::new(),
    });
    service.replace_catalog_for_test(
        crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    let preview = service
        .preview_mod_setups("starship")
        .unwrap()
        .inventory
        .unwrap();
    let strict = service
        .resolve_retained_build("starship", &profile.id)
        .unwrap();
    assert_eq!(preview.profiles[0].build_availability, strict.availability);
    assert_ne!(
        strict.availability,
        crate::RetainedBuildAvailability::Verified
    );
    assert_ne!(
        strict.availability,
        crate::RetainedBuildAvailability::Present
    );
    assert!(
        service
            .verified_retained_build("starship", &install.id)
            .is_err()
    );
    assert!(
        service
            .copy_profile("starship", &profile.id, "Held")
            .is_err()
    );
}

#[test]
fn mod_setup_draft_previews_one_order_and_refuses_a_changed_file_before_publishing() {
    let w = world();
    let port = "starship";
    let original = archive(&w.scratch, "base.otr", &[("assets/shared", b"old")]);
    let current = w
        .service
        .install_mod_package(port, &w.default, &original, 1)
        .unwrap();
    let first = archive(&w.scratch, "a.otr", &[("assets/shared", b"a")]);
    let last = archive(&w.scratch, "b.otr", &[("assets/shared", b"b")]);
    let files = [first, last].map(|path| {
        let review = w
            .service
            .plan_local_mod_package(port, &w.default, &path, current.revision)
            .unwrap();
        LocalModDraftFile {
            path,
            expected_plan_sha256: review.plan_sha256,
        }
    });
    let edits = ModSetupEdits {
        packages: vec![ModSetupPackageEdit {
            native_id: "base.otr".into(),
            enabled: Some(false),
        }],
        order: None,
        local_files: files.to_vec(),
    };
    let preview = w
        .service
        .preview_mod_setup_draft(port, &w.default, current.revision, &[], &edits)
        .unwrap();
    assert_eq!(preview.order, ["a.otr", "b.otr"]);
    assert_eq!(preview.conflicts.first().unwrap().winner, "b.otr");

    archive(&w.scratch, "b.otr", &[("assets/changed", b"replacement")]);
    assert!(
        w.service
            .apply_mod_setup_draft(port, &w.default, current.revision, &[], &edits, false)
            .is_err()
    );
    let layout = w.service.deploy_layout(port).unwrap();
    assert_eq!(
        sha256_file(&layout.mods().join("base.otr")).unwrap(),
        sha256_file(&original).unwrap()
    );
    assert_eq!(
        profile::current_revision(&w.service.library.connection().unwrap(), port, &w.default)
            .unwrap(),
        current
    );

    archive(&w.scratch, "b.otr", &[("assets/shared", b"b")]);
    let next = w
        .service
        .apply_mod_setup_draft(port, &w.default, current.revision, &[], &edits, false)
        .unwrap();
    assert_eq!(next.parent_revision, Some(current.revision));
    assert_eq!(next.save_group, current.save_group);
    assert_eq!(
        profile::selection(&w.service.library.connection().unwrap(), port).unwrap(),
        Some((w.default.clone(), next.revision))
    );
    assert!(restore_pending(&layout.user));
    assert_eq!(live_mods(&w), ["a.otr", "b.otr"]);
    assert_eq!(
        enabled_in_override_order(&next)
            .iter()
            .map(|item| item.native_id.as_str())
            .collect::<Vec<_>>(),
        preview.order
    );
    assert!(
        w.service
            .apply_mod_setup_draft(port, &w.default, current.revision, &[], &edits, false)
            .is_err()
    );
}

#[test]
fn mod_setup_draft_can_retry_before_commit_and_finish_one_revision_after_commit() {
    let w = world();
    let service = &w.service;
    let port = "starship";
    let package = archive(&w.scratch, "base.otr", &[("assets/base", b"old")]);
    let original = service
        .install_mod_package(port, &w.default, &package, 1)
        .unwrap();
    let path = archive(&w.scratch, "queued.otr", &[("assets/new", b"new")]);
    let review = service
        .plan_local_mod_package(port, &w.default, &path, original.revision)
        .unwrap();
    let edits = ModSetupEdits {
        packages: vec![],
        order: None,
        local_files: vec![LocalModDraftFile {
            path,
            expected_plan_sha256: review.plan_sha256,
        }],
    };
    let connection = service.library.connection().unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER interrupt_draft_commit BEFORE INSERT ON profile_revisions
             BEGIN SELECT RAISE(ABORT, 'interrupted before publishing'); END;",
        )
        .unwrap();
    let apply = |service: &PortcoveService| {
        service.apply_mod_setup_draft(port, &w.default, original.revision, &[], &edits, false)
    };
    let before_commit = apply(service).unwrap_err();
    assert!(
        before_commit
            .message
            .contains("interrupted before publishing")
    );
    assert!(!before_commit.details.contains_key("setup_revision"));
    assert_eq!(revision(&w, &w.default), original.revision);
    assert_eq!(live_mods(&w), ["base.otr"]);
    assert_eq!(
        service.activate_profile(port, &w.default).unwrap(),
        original
    );
    connection
        .execute_batch(
            "DROP TRIGGER interrupt_draft_commit;
             CREATE TRIGGER interrupt_draft_activation BEFORE UPDATE ON profile_selection
             WHEN NEW.materialized_revision != OLD.materialized_revision
             BEGIN SELECT RAISE(ABORT, 'interrupted after publishing'); END;",
        )
        .unwrap();
    let failure = apply(service).unwrap_err().report();
    let committed = profile::current_revision(&connection, port, &w.default).unwrap();
    assert_eq!(committed.parent_revision, Some(original.revision));
    assert_eq!(
        failure.presentation.mutation_state,
        crate::MutationState::RecoveryRequired
    );
    assert_eq!(
        failure.presentation.technical_context["setup_revision"],
        committed.revision.to_string()
    );
    assert_eq!(
        failure.presentation.technical_context["setup_revision_digest"],
        committed.digest
    );
    assert_eq!(
        profile::selection(&connection, port).unwrap(),
        Some((w.default.clone(), original.revision))
    );
    assert_eq!(live_mods(&w), ["base.otr", "queued.otr"]);
    connection
        .execute_batch("DROP TRIGGER interrupt_draft_activation;")
        .unwrap();
    let restarted = PortcoveService::new(service.library().clone()).unwrap();
    assert!(apply(&restarted).is_err());
    assert_eq!(
        restarted.activate_profile(port, &w.default).unwrap(),
        committed
    );
    assert!(apply(&restarted).is_err());
    assert_eq!(revision(&w, &w.default), committed.revision);
    assert_eq!(live_mods(&w), ["base.otr", "queued.otr"]);
}

#[test]
fn finishing_a_same_name_replacement_keeps_bytes_already_deployed_by_apply() {
    let w = world();
    let port = "starship";
    let source = archive(&w.scratch, "mod.otr", &[("assets/one", b"old")]);
    let before = w
        .service
        .install_mod_package(port, &w.default, &source, 1)
        .unwrap();
    let source = archive(&w.scratch, "mod.otr", &[("assets/two", b"new")]);
    let after = w
        .service
        .install_mod_package(port, &w.default, &source, before.revision)
        .unwrap();
    let layout = w.service.deploy_layout(port).unwrap();
    let connection = w.service.library.connection().unwrap();
    // Simulate termination after placing the target bytes but before recording
    // the materialized revision.
    profile::set_selection(&connection, port, &w.default, before.revision).unwrap();
    w.service
        .reconcile_selected(port, &layout, &connection, &after)
        .unwrap();
    assert_eq!(
        sha256_file(&layout.mods().join("mod.otr")).unwrap(),
        after.packages[0].sha256
    );
    assert_eq!(
        profile::selection(&connection, port).unwrap(),
        Some((w.default, after.revision))
    );
}

#[test]
fn dfu_local_pointycursor_projects_only_owned_files_and_retains_clean_recovery() {
    const PORT: &str = "interkarma-daggerfall-unity";
    const NAME: &str = "wandererhud - pointycursor.dfmod";
    let platform = crate::Platform::current().unwrap();
    let (data, opposite, wrapper) = match platform {
        crate::Platform::WindowsX86_64 => (
            include_bytes!("fixtures/dfu-mods/pointycursor-windows.dfmod").as_slice(),
            include_bytes!("fixtures/dfu-mods/pointycursor-linux.dfmod").as_slice(),
            include_bytes!("fixtures/dfu-mods/pointycursor-windows.zip").as_slice(),
        ),
        crate::Platform::LinuxX86_64 => (
            include_bytes!("fixtures/dfu-mods/pointycursor-linux.dfmod").as_slice(),
            include_bytes!("fixtures/dfu-mods/pointycursor-windows.dfmod").as_slice(),
            include_bytes!("fixtures/dfu-mods/pointycursor-linux.zip").as_slice(),
        ),
        _ => return,
    };
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let catalog = crate::Catalog::embedded().unwrap();
    let const_port = catalog.port(PORT).unwrap();
    let executable = &const_port.executable_hints[&platform][0];
    let (asset_name, size, sha256) = match platform {
        crate::Platform::WindowsX86_64 => (
            "dfu_windows_64bit-v1.1.1.zip",
            50_240_819,
            "b4eb2620cdf31f973ed1105d06be8a31f21796915d65c253a93eeb02cb1d64bd",
        ),
        _ => (
            "dfu_linux_64bit-v1.1.1.zip",
            58_809_717,
            "be3c476ae92972f42448757719266ad82c04868eb7b6f3a3c90fcfcf1490849a",
        ),
    };
    // An inert executable stands in for the previously reviewed runtime. The
    // test exercises normal manifest and library custody, and never launches it.
    let version = "v1.1.1-cve-2025";
    let id = "dfu-test-runtime";
    let path = library.versions_dir().join(PORT).join(id);
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join(executable), b"inert retained test runtime").unwrap();
    crate::permissions::normalize_archive_entry(&path.join(executable), false, true).unwrap();
    let artifact = crate::ArtifactIdentity {
        asset_name: asset_name.into(),
        size,
        sha256: sha256.into(),
    };
    let qualification =
        crate::InstallQualification::from_catalog(&catalog, PORT, platform).unwrap();
    let (manifest_sha256, selected_executable, runtime) = crate::Installer::new(library.clone())
        .unwrap()
        .create_manifest(id, PORT, version, &artifact, &qualification, &path)
        .unwrap();
    let install = crate::InstallRecord {
        id: id.into(),
        port_id: PORT.into(),
        version: version.into(),
        path: path.clone(),
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

    let service = PortcoveService::new_read_only(library.clone()).unwrap();
    let profile = service.ensure_default_profile(PORT).unwrap();
    let user = library.user_dir(PORT);
    fs::create_dir_all(user.join("PortableAppdata")).unwrap();
    fs::write(
        user.join("PortableAppdata/progress"),
        b"keep newer progress",
    )
    .unwrap();
    fs::write(user.join("Portable.txt"), []).unwrap();
    let runtime_progress = path.join("PortableAppdata/progress");
    fs::create_dir_all(runtime_progress.parent().unwrap()).unwrap();
    fs::write(&runtime_progress, b"keep newer progress").unwrap();
    let candidate = temporary.path().join(NAME);
    fs::write(&candidate, opposite).unwrap();
    assert!(
        service
            .plan_local_mod_package(PORT, &profile.id, &candidate, 1)
            .is_err()
    );
    let code = temporary.path().join("easynpcbehavior.dfmod");
    fs::write(
        &code,
        include_bytes!("fixtures/dfu-mods/easynpcbehavior-linux.dfmod"),
    )
    .unwrap();
    assert!(
        service
            .plan_local_mod_package(PORT, &profile.id, &code, 1)
            .is_err()
    );

    fs::write(&candidate, data).unwrap();
    let live_mods = path.join(crate::profile_loader::DFU_MODS);
    let unmanaged = live_mods.join("outside/manual.dfmod");
    fs::create_dir_all(unmanaged.parent().unwrap()).unwrap();
    fs::write(&unmanaged, b"player files outside ownership").unwrap();
    assert!(
        service
            .plan_local_mod_package(PORT, &profile.id, &candidate, 1)
            .is_err()
    );
    assert_eq!(
        fs::read(&unmanaged).unwrap(),
        b"player files outside ownership"
    );
    fs::remove_file(&unmanaged).unwrap();
    fs::remove_dir(unmanaged.parent().unwrap()).unwrap();
    let scaffold = b"Please copy any .dfmod packages into this folder before running the game.";
    let runtime_scaffold = live_mods.join("readme.txt");
    let canonical_scaffold = user
        .join(crate::profile_loader::DFU_MODS)
        .join("readme.txt");
    fs::create_dir_all(canonical_scaffold.parent().unwrap()).unwrap();
    fs::write(&canonical_scaffold, scaffold).unwrap();
    fs::write(&runtime_scaffold, b"player-authored note").unwrap();
    assert!(
        service
            .plan_local_mod_package(PORT, &profile.id, &candidate, 1)
            .is_err()
    );
    assert_eq!(
        fs::read(&runtime_scaffold).unwrap(),
        b"player-authored note"
    );
    fs::write(&runtime_scaffold, scaffold).unwrap();

    let raw = service
        .plan_local_mod_package(PORT, &profile.id, &candidate, 1)
        .unwrap();
    let candidate = temporary.path().join("PointyCursor.zip");
    fs::write(&candidate, wrapper).unwrap();
    let review = service
        .plan_local_mod_package(PORT, &profile.id, &candidate, 1)
        .unwrap();
    assert_eq!(review.sha256, raw.sha256);
    assert_eq!(review.native_id, raw.native_id);
    assert_ne!(review.plan_sha256, raw.plan_sha256);

    let member = format!("Mods/{NAME}");
    let repack = archive(temporary.path(), "repacked.zip", &[(&member, data)]);
    fs::copy(&repack, &candidate).unwrap();
    let repacked = service
        .plan_local_mod_package(PORT, &profile.id, &candidate, 1)
        .unwrap();
    assert_eq!(repacked.sha256, review.sha256);
    assert_ne!(repacked.plan_sha256, review.plan_sha256);
    assert!(
        service
            .apply_local_mod_package(PORT, &profile.id, &candidate, &review.plan_sha256, false)
            .is_err()
    );
    assert!(!live_mods.join(NAME).exists());
    let ambiguous = archive(
        temporary.path(),
        "ambiguous.zip",
        &[(&member, data), ("Mods/other.dfmod", data)],
    );
    assert!(
        service
            .plan_local_mod_package(PORT, &profile.id, &ambiguous, 1)
            .is_err()
    );
    let mut inconsistent = wrapper.to_vec();
    // The first local record is the zero-length Mods/ directory.
    inconsistent[30] = b'm';
    fs::write(&candidate, inconsistent).unwrap();
    assert!(
        service
            .plan_local_mod_package(PORT, &profile.id, &candidate, 1)
            .is_err()
    );
    fs::write(&candidate, wrapper).unwrap();
    assert!(!review.needs_code_permission);
    let applied = service
        .apply_local_mod_package(PORT, &profile.id, &candidate, &review.plan_sha256, false)
        .unwrap();
    assert_eq!(applied.packages[0].sha256, review.sha256);
    assert!(applied.packages[0].provider.is_none());
    let runtime_mod = live_mods.join(NAME);
    let canonical_mod = user.join(crate::profile_loader::DFU_MODS).join(NAME);
    assert_eq!(fs::read(&canonical_mod).unwrap(), data);
    assert_eq!(fs::read(&runtime_progress).unwrap(), b"keep newer progress");
    service.dfu_restore_projection(&install, &path).unwrap();
    assert_eq!(fs::read(&runtime_mod).unwrap(), data);
    service
        .require_restore_profile_projection(PORT, &user)
        .unwrap();
    let marker = user.join("Portable.txt");
    let manual_backup_path = canonical_mod.parent().unwrap().join("manual/keep.dfmod");
    let backup = service.create_backup(PORT).unwrap();
    fs::remove_file(&marker).unwrap();
    let without_marker = service.create_backup(PORT).unwrap();
    assert!(
        service
            .require_restore_profile_projection(PORT, &user)
            .is_err()
    );
    fs::write(&marker, b"invalid").unwrap();
    let invalid_marker = service.create_backup(PORT).unwrap();
    assert!(
        service
            .require_restore_profile_projection(PORT, &user)
            .is_err()
    );
    fs::write(&marker, []).unwrap();
    service
        .require_restore_profile_projection(PORT, &user)
        .unwrap();

    fs::create_dir_all(manual_backup_path.parent().unwrap()).unwrap();
    fs::write(&manual_backup_path, b"manual canonical mod").unwrap();
    let with_manual_file = service.create_backup(PORT).unwrap();
    assert!(!without_marker.path.join("data/Portable.txt").exists());
    assert_eq!(
        fs::read(invalid_marker.path.join("data/Portable.txt")).unwrap(),
        b"invalid"
    );
    assert_eq!(
        fs::read(
            with_manual_file
                .path
                .join("data")
                .join(crate::profile_loader::DFU_MODS)
                .join("manual/keep.dfmod")
        )
        .unwrap(),
        b"manual canonical mod"
    );
    let restore = |service: &PortcoveService, backup_id: &str| {
        let action = crate::BackupAction::Restore;
        let preview = service.preview_backup_action(PORT, backup_id, action)?;
        let authorization =
            service.authorize_backup_action(PORT, backup_id, action, &preview.preview_sha256)?;
        service.restore_backup(PORT, backup_id, &authorization.token)
    };
    let error = restore(&service, &backup.id).unwrap_err();
    assert_eq!(error.details["unknown_package"], "manual");
    assert_eq!(
        fs::read(&manual_backup_path).unwrap(),
        b"manual canonical mod"
    );
    fs::remove_file(&manual_backup_path).unwrap();
    fs::remove_dir(manual_backup_path.parent().unwrap()).unwrap();

    let canonical_progress = user.join("PortableAppdata/progress");
    fs::write(&canonical_progress, b"current progress").unwrap();
    for (declined, expected) in [
        (&without_marker, "portable_marker"),
        (&invalid_marker, "Portable.txt"),
        (&with_manual_file, "unknown_package"),
    ] {
        let manifest = fs::read(declined.path.join("backup.json")).unwrap();
        let error = restore(&service, &declined.id).unwrap_err();
        assert!(
            error.details.contains_key(expected) || error.message.contains(expected),
            "{error:?}"
        );
        assert!(fs::read(&marker).unwrap().is_empty());
        assert_eq!(fs::read(&canonical_progress).unwrap(), b"current progress");
        assert_eq!(
            fs::read(&declined.path.join("backup.json")).unwrap(),
            manifest
        );
        assert_eq!(fs::read(&canonical_mod).unwrap(), data);
        assert_eq!(fs::read(&runtime_mod).unwrap(), data);
        assert!(!manual_backup_path.exists());
    }
    restore(&service, &backup.id).unwrap();
    struct StopAfterRestorePublish;
    impl crate::operation::LifecycleFaultInjector for StopAfterRestorePublish {
        fn check(&self, point: crate::operation::LifecycleFaultPoint) -> Result<()> {
            if point == crate::operation::LifecycleFaultPoint::RestorePublished {
                return Err(PortcoveError::state(
                    "fixture stopped after restore publication",
                ));
            }
            Ok(())
        }
    }
    fs::write(&canonical_progress, b"pre-interruption progress").unwrap();
    let interrupted_restore = PortcoveService::with_faults(
        service.library().clone(),
        std::sync::Arc::new(StopAfterRestorePublish),
    )
    .unwrap();
    let failure = restore(&interrupted_restore, &backup.id).unwrap_err();
    assert!(
        failure
            .message
            .contains("fixture stopped after restore publication")
    );
    let restored_service = PortcoveService::new_read_only(service.library().clone()).unwrap();
    restored_service
        .recover_lifecycle_operations_for_test()
        .unwrap();
    assert!(fs::read(&marker).unwrap().is_empty());
    assert_eq!(
        fs::read(&canonical_progress).unwrap(),
        b"keep newer progress"
    );
    assert_eq!(fs::read(&runtime_scaffold).unwrap(), scaffold);
    assert_eq!(fs::read(&runtime_mod).unwrap(), data);

    let clean = service
        .create_clean_profile(PORT, &profile.id, "Clean", applied.revision)
        .unwrap();
    service.activate_profile(PORT, &clean.id).unwrap();
    let reopened = PortcoveService::new_read_only(library).unwrap();
    reopened.dfu_restore_projection(&install, &path).unwrap();
    assert_eq!(fs::read(&runtime_scaffold).unwrap(), scaffold);
    assert_eq!(fs::read(&canonical_scaffold).unwrap(), scaffold);
    assert!(!runtime_mod.exists());
    assert!(!canonical_mod.exists());
    assert!(!user.join("PortableAppdata/progress").exists());
    assert!(!runtime_progress.exists());

    reopened.activate_profile(PORT, &profile.id).unwrap();
    assert_eq!(
        fs::read(user.join("PortableAppdata/progress")).unwrap(),
        b"keep newer progress"
    );

    reopened.dfu_restore_projection(&install, &path).unwrap();
    assert_eq!(fs::read(&runtime_mod).unwrap(), data);
    assert_eq!(fs::read(&runtime_progress).unwrap(), b"keep newer progress");
    fs::write(path.join("Portable.txt"), []).unwrap();
    fs::write(path.join(".portcove-launched"), []).unwrap();
    reopened.activate_profile(PORT, &clean.id).unwrap();
    assert!(!runtime_progress.exists());
    reopened.activate_profile(PORT, &profile.id).unwrap();
    assert_eq!(fs::read(&runtime_progress).unwrap(), b"keep newer progress");
    let clean_revision = reopened
        .profile_revisions(PORT, &clean.id)
        .unwrap()
        .last()
        .unwrap()
        .clone();
    let projection = reopened.require_layout_for_revision(&applied).unwrap();
    // The selected setup is already durable. Model loss immediately before
    // publication and immediately after the full file reached its final name.
    for prepublication in [true, false] {
        dfu_deploy::record_test_pending(&projection, &install, &clean_revision, &applied).unwrap();
        if prepublication {
            fs::remove_file(&runtime_mod).unwrap();
        }
        reopened.dfu_restore_projection(&install, &path).unwrap();
        assert_eq!(fs::read(&runtime_mod).unwrap(), data);
    }
    let outside = live_mods.join("manual/keep.dfmod");
    fs::create_dir_all(outside.parent().unwrap()).unwrap();
    fs::write(&outside, b"retained unmanaged nested file").unwrap();
    assert!(reopened.synchronize_restored_user_data(PORT).is_err());
    assert!(reopened.collect_active_user_data_if_launched(PORT).is_err());
    assert!(reopened.preview_removal(PORT).is_err());
    assert_eq!(
        fs::read(&outside).unwrap(),
        b"retained unmanaged nested file"
    );
    assert_eq!(fs::read(&runtime_mod).unwrap(), data);
    fs::remove_file(&outside).unwrap();
    fs::remove_dir(outside.parent().unwrap()).unwrap();

    // A stale, unnamed sibling from a stopped projection is outside the Mods
    // scan. Reopening never adopts or clears it.
    let abandoned = live_mods
        .parent()
        .unwrap()
        .join(".portcove-dfu-interrupted-test");
    fs::create_dir(&abandoned).unwrap();
    fs::write(abandoned.join("staged"), b"abandoned staged bytes").unwrap();
    reopened.activate_profile(PORT, &clean.id).unwrap();
    reopened.activate_profile(PORT, &profile.id).unwrap();
    assert_eq!(fs::read(&runtime_mod).unwrap(), data);
    assert_eq!(
        fs::read(abandoned.join("staged")).unwrap(),
        b"abandoned staged bytes"
    );
    let mut case_only = applied.clone();
    case_only.packages[0].native_id = NAME.to_ascii_uppercase();
    assert!(require_dfu_basename_stability(&applied, &case_only).is_err());

    fs::write(&runtime_mod, b"outside edit").unwrap();
    assert!(reopened.activate_profile(PORT, &clean.id).is_err());
    assert_eq!(fs::read(&runtime_mod).unwrap(), b"outside edit");
    fs::write(&runtime_mod, data).unwrap();

    struct WriteProgressBeforePark {
        progress: PathBuf,
        stop_after_park: bool,
    }
    impl crate::operation::LifecycleFaultInjector for WriteProgressBeforePark {
        fn check(&self, point: crate::operation::LifecycleFaultPoint) -> Result<()> {
            use crate::operation::LifecycleFaultPoint;
            if point == LifecycleFaultPoint::DfuDepartingSaveGroupBeforePark {
                fs::write(&self.progress, b"native progress after preimage review")?;
            }
            if self.stop_after_park && point == LifecycleFaultPoint::DfuDepartingSaveGroupParked {
                return Err(PortcoveError::state(
                    "fixture stopped after parking runtime saves",
                ));
            }
            Ok(())
        }
    }
    let selected = || profile::selection(&reopened.library().connection().unwrap(), PORT).unwrap();
    for stop_after_park in [false, true] {
        let interrupted = PortcoveService::with_faults(
            reopened.library().clone(),
            std::sync::Arc::new(WriteProgressBeforePark {
                progress: runtime_progress.clone(),
                stop_after_park,
            }),
        )
        .unwrap();
        let error = interrupted.activate_profile(PORT, &clean.id).unwrap_err();
        assert!(projection.journal().is_file());
        assert_eq!(selected(), Some((profile.id.clone(), applied.revision)));
        drop(interrupted);
        let recovered = PortcoveService::new_read_only(reopened.library().clone()).unwrap();
        if stop_after_park {
            assert!(error.message.contains("fixture stopped after parking"));
            assert!(!runtime_progress.exists());
            let journal_path = projection.journal();
            let original = fs::read(&journal_path).unwrap();
            let mut journal: serde_json::Value = serde_json::from_slice(&original).unwrap();
            let id = journal["dfu_save_park"]["id"].as_str().unwrap();
            let parked = path
                .join(format!(".portcove-dfu-save-park-{id}"))
                .join("progress");
            assert_eq!(
                fs::read(&parked).unwrap(),
                b"native progress after preimage review"
            );

            // A parked group bound to another revision must never be adopted.
            journal["dfu_save_park"]["to"]["digest"] = serde_json::json!("different-revision");
            fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
            assert!(recovered.activate_profile(PORT, &clean.id).is_err());
            assert!(!runtime_progress.exists());
            assert_eq!(
                fs::read(&parked).unwrap(),
                b"native progress after preimage review"
            );
            fs::write(&journal_path, original).unwrap();
        } else {
            assert!(error.message.contains("runtime progress differs"));
        }
        let held = recovered.activate_profile(PORT, &clean.id).unwrap_err();
        assert!(held.message.contains("runtime progress differs"));
        assert_eq!(selected(), Some((profile.id.clone(), applied.revision)));
        assert_eq!(
            fs::read(&runtime_progress).unwrap(),
            b"native progress after preimage review"
        );
        assert_eq!(
            fs::read(
                projection
                    .parked(&profile.id)
                    .join("PortableAppdata/progress")
            )
            .unwrap(),
            b"keep newer progress"
        );

        // The player preserves the newer data before completing the reviewed
        // switch. Routine recovery must never choose for them.
        let preserved = temporary
            .path()
            .join(format!("preserved-progress-{stop_after_park}"));
        fs::rename(&runtime_progress, &preserved).unwrap();
        fs::write(&runtime_progress, b"keep newer progress").unwrap();
        recovered.activate_profile(PORT, &clean.id).unwrap();
        assert!(!projection.journal().exists());
        assert!(!runtime_progress.exists());
        assert_eq!(
            fs::read(&preserved).unwrap(),
            b"native progress after preimage review"
        );
        recovered.activate_profile(PORT, &profile.id).unwrap();
        assert_eq!(fs::read(&runtime_progress).unwrap(), b"keep newer progress");
    }
    struct StopAfterCleanupPark;
    impl crate::operation::LifecycleFaultInjector for StopAfterCleanupPark {
        fn check(&self, point: crate::operation::LifecycleFaultPoint) -> Result<()> {
            if point == crate::operation::LifecycleFaultPoint::DfuSaveDuplicateCleanup {
                return Err(PortcoveError::state(
                    "fixture stopped before duplicate cleanup",
                ));
            }
            Ok(())
        }
    }
    let cleanup_interrupted = PortcoveService::with_faults(
        reopened.library().clone(),
        std::sync::Arc::new(StopAfterCleanupPark),
    )
    .unwrap();
    let error = cleanup_interrupted
        .activate_profile(PORT, &clean.id)
        .unwrap_err();
    assert!(
        error
            .message
            .contains("fixture stopped before duplicate cleanup")
    );
    assert!(!runtime_progress.exists());
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(projection.journal()).unwrap()).unwrap();
    let id = journal["dfu_save_park"]["id"].as_str().unwrap();
    let cleanup = path.join(format!(".portcove-dfu-save-cleanup-{id}"));
    assert_eq!(
        fs::read(cleanup.join("progress")).unwrap(),
        b"keep newer progress"
    );
    drop(cleanup_interrupted);
    let recovered = PortcoveService::new_read_only(reopened.library().clone()).unwrap();
    let cleanup_progress = cleanup.join("progress");
    fs::write(&cleanup_progress, b"native progress after cleanup custody").unwrap();
    let changed = recovered.activate_profile(PORT, &clean.id).unwrap_err();
    assert_eq!(changed.details["preserved"], cleanup.display().to_string());
    assert_eq!(
        fs::read(&cleanup_progress).unwrap(),
        b"native progress after cleanup custody"
    );
    assert_eq!(selected(), Some((profile.id.clone(), applied.revision)));
    assert!(!runtime_progress.exists());

    let changed_copy = temporary.path().join("changed-cleanup-progress");
    fs::rename(&cleanup_progress, &changed_copy).unwrap();
    fs::write(&cleanup_progress, b"keep newer progress").unwrap();
    let extra = cleanup.join("extra-progress");
    fs::write(&extra, b"native additional progress").unwrap();
    let unexpected = recovered.activate_profile(PORT, &clean.id).unwrap_err();
    assert_eq!(
        unexpected.details["preserved"],
        cleanup.display().to_string()
    );
    assert_eq!(fs::read(&extra).unwrap(), b"native additional progress");
    assert_eq!(fs::read(&cleanup_progress).unwrap(), b"keep newer progress");
    assert_eq!(selected(), Some((profile.id.clone(), applied.revision)));
    assert!(!runtime_progress.exists());

    let extra_copy = temporary.path().join("additional-cleanup-progress");
    fs::rename(&extra, &extra_copy).unwrap();
    // Leave an unchanged subset as if cleanup had previously deleted a member.
    fs::remove_file(&cleanup_progress).unwrap();
    recovered.activate_profile(PORT, &clean.id).unwrap();
    assert_eq!(
        fs::read(changed_copy).unwrap(),
        b"native progress after cleanup custody"
    );
    assert_eq!(fs::read(extra_copy).unwrap(), b"native additional progress");
    assert!(!cleanup.exists());
    assert!(!runtime_progress.exists());
    assert!(!projection.journal().exists());
    recovered.activate_profile(PORT, &profile.id).unwrap();
    assert_eq!(fs::read(&runtime_progress).unwrap(), b"keep newer progress");
}

#[test]
fn dfu_setup_metadata_refuses_optional_ordering_and_bounds_the_transition_set() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("wandererhud - pointycursor.dfmod");
    fs::write(
        &path,
        include_bytes!("fixtures/dfu-mods/pointycursor-linux.dfmod"),
    )
    .unwrap();
    let make = || crate::dfu_mod::inspect_data_only(&path, crate::Platform::LinuxX86_64).unwrap();
    let first = make();
    assert_eq!(first.optional_dependencies.len(), 1);
    let target = first.optional_dependencies[0].clone();
    let mut dependency = make();
    dependency.package.file_name = format!("{target}.dfmod");
    dependency.guid = "fixture-dependency-guid".into();
    dependency.title = "Fixture dependency".into();
    dependency.optional_dependencies.clear();
    let mut rows = vec![(first, true), (dependency, false)];
    require_dfu_metadata(&rows).unwrap();
    rows[1].1 = true;
    assert!(require_dfu_metadata(&rows).is_err());
    rows.clear();
    for i in 0..MAX_DFU_PACKAGES + 1 {
        let mut package = make();
        package.package.file_name = format!("fixture-{i}.dfmod");
        package.guid = format!("fixture-guid-{i}");
        package.title = format!("Fixture {i}");
        package.optional_dependencies.clear();
        rows.push((package, true));
    }
    require_dfu_metadata(&rows[..MAX_DFU_PACKAGES]).unwrap();
    assert!(require_dfu_metadata(&rows).is_err());
    assert_eq!(MAX_DFU_OBSERVED_FILES, 2 * MAX_DFU_PACKAGES);
}
