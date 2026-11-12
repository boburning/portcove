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
fn recomp_menu_changes_are_adopted_or_restored_and_player_entries_kept() {
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
    w.service.adopt_native_mod_order_locked(RECOMP).unwrap();
    drop(_guard);
    assert_eq!(w.revision(), shown + 1, "the reorder became a revision");
    assert_eq!(w.status(), NativeModListStatus::InSync);

    // Disabling a managed mod in the menu is reported, then restored on the next
    // change, while the player's own entries keep their place and state.
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
    w.install("c.nrm", "gamma", &[]).unwrap();
    let list = w.list();
    assert_eq!(
        list["mod_order"],
        serde_json::json!([
            "mm_recomp_dpad_builtin",
            "beta",
            "own_mod",
            "alpha",
            "gamma"
        ])
    );
    assert_eq!(
        list["enabled_mods"],
        serde_json::json!(["own_mod", "beta", "alpha", "gamma"])
    );
    assert_eq!(list["future"]["kept"], true);
    assert_eq!(w.status(), NativeModListStatus::InSync);
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
