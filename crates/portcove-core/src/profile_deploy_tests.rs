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
fn files_the_game_would_load_as_one_mod_or_cannot_list_are_refused() {
    let w = world();
    install(&w, &w.default, "Link.o2r", 1).unwrap();
    let collision = install(&w, &w.default, "link.otr", 2).unwrap_err();
    assert_eq!(collision.code, crate::ErrorCode::Conflict);
    assert_eq!(revision(&w, &w.default), 2, "nothing was recorded");
    assert_eq!(live_mods(&w), ["Link.o2r"]);
    // A list separator in a name would split it into two native entries.
    #[cfg(unix)]
    {
        assert!(install(&w, &w.default, "a|b.o2r", 2).is_err());
        assert_eq!(revision(&w, &w.default), 2, "nothing was recorded");
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
    w.service.adopt_native_mod_order_locked("starship").unwrap();
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
    w.service.adopt_native_mod_order_locked("starship").unwrap();
    assert_eq!(revision(&w, &w.default), 4);
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(value["CVars"]["gSettings"]["Volume"]["Master"], 20);
}

#[test]
fn other_differences_are_reported_and_rewritten_before_launch_without_a_revision() {
    let w = world();
    install(&w, &w.default, "b.o2r", 1).unwrap();
    install(&w, &w.default, "a.o2r", 2).unwrap();
    // A disable in the game's menu would not survive its next start anyway.
    // `mine` is the player's own entry and is neither reported nor moved.
    fs::write(
        user(&w).join("starship.cfg.json"),
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
    w.service
        .prepare_native_mod_list_locked("starship")
        .unwrap();
    assert_eq!(native_list(&w).as_deref(), Some("mine|b|a"));
    assert_eq!(revision(&w, &w.default), 3, "no revision was created");
    assert!(
        restore_pending(&user(&w)),
        "the build copy is refreshed at launch"
    );
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
