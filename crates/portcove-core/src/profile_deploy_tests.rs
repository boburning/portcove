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
    write_journal(&layout, &w.default, &other.id, 1, Phase::Deployed).unwrap();
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
    write_journal(&layout, &w.default, &other.id, 1, Phase::Start).unwrap();
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
    // The game later updates: a newer build becomes the global active build.
    let second = install(w.service.library(), "second", b"newer runtime", true);
    let pinned = w
        .service
        .copy_profile("starship", &w.default, "Pinned")
        .unwrap();
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
