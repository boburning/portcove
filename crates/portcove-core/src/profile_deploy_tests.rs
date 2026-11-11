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
    let layout = Layout { user: user(&w) };
    fs::create_dir_all(layout.store()).unwrap();
    fs::write(
        layout.journal(),
        serde_json::json!({"from": w.default, "to": other.id, "revision": 1}).to_string(),
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
