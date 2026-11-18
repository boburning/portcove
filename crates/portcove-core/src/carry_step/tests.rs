use std::collections::BTreeMap;

use super::*;
use crate::carry_plan::{CarryExclusions, CarryRow, PathInput, RowChange, plan};

fn ok() -> Result<()> {
    Ok(())
}

fn write(root: &Path, relative: &str, bytes: &[u8]) {
    let path = member(root, relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

struct Fixture {
    _temporary: tempfile::TempDir,
    source: PathBuf,
    target: PathBuf,
}

fn fixture() -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("a");
    let target = temporary.path().join("t");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    Fixture {
        _temporary: temporary,
        source,
        target,
    }
}

/// A path's source and target ledger rows.
type Rows = (Option<CarryRow>, Option<CarryRow>);

/// Inspect, plan and stage `paths`, with `rows` as the source and target
/// ledger rows for each path.
fn run_with(
    fixture: &Fixture,
    paths: &[&str],
    rows: &dyn Fn(&str) -> Rows,
    space: (u64, u64),
) -> (Vec<PlannedPath>, std::result::Result<Staged, CarryStop>) {
    let mut inputs = BTreeMap::new();
    let mut sizes = BTreeMap::new();
    let (source_listings, target_listings) = (Listings::default(), Listings::default());
    for path in paths {
        let (source, size) = inspect_source(&fixture.source, path, &source_listings, &ok).unwrap();
        if let Some(size) = size {
            sizes.insert(path.to_string(), size);
        }
        let target = inspect_target(&fixture.target, path, &target_listings, &ok).unwrap();
        let (source_row, target_row) = rows(path);
        inputs.insert(
            path.to_string(),
            PathInput {
                source,
                source_row,
                target,
                target_row,
                target_replaces: None,
            },
        );
    }
    let planned = plan("a", &inputs, &CarryExclusions::default(), &|_| false);
    let inspected = Inspected { sizes };
    let staged = stage(
        (&fixture.source, &fixture.target),
        &planned,
        &inspected,
        space,
        &ok,
    );
    (planned, staged)
}

/// First contact: no ledger rows.
fn run(
    fixture: &Fixture,
    paths: &[&str],
    space: (u64, u64),
) -> (Vec<PlannedPath>, std::result::Result<Staged, CarryStop>) {
    run_with(fixture, paths, &|_| (None, None), space)
}

fn sha(bytes: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// Rows proving the target holds an earlier copy of the source's file.
fn descended(old: &[u8], new: Option<&[u8]>) -> Rows {
    let old = sha(old);
    let source = match new {
        Some(new) => CarryRow::present(&sha(new), vec![old.clone(), sha(new)]),
        None => CarryRow::present(&old, vec![old.clone()]),
    };
    (
        Some(source),
        Some(CarryRow::present(&old, vec![old.clone()])),
    )
}

const PLENTY: (u64, u64) = (u64::MAX / 2, 10 * 1024 * 1024 * 1024);

#[test]
fn copies_stage_on_the_destination_volume_and_publish_atomically() {
    let fixture = fixture();
    write(&fixture.source, "settings.ini", b"lives=9");
    write(&fixture.source, "profiles/one/slot.cfg", b"slot");
    let (planned, staged) = run(&fixture, &["settings.ini", "profiles/one/slot.cfg"], PLENTY);
    assert!(
        planned
            .iter()
            .all(|planned| planned.action == CarryAction::Copy)
    );
    assert!(
        planned
            .iter()
            .all(|planned| matches!(planned.target_row, RowChange::Set(_)))
    );
    let staged = staged.unwrap();
    // Nothing at a destination path until publishing.
    assert!(!fixture.target.join("settings.ini").exists());
    let staging = fs::read_dir(&fixture.target)
        .unwrap()
        .filter_map(|entry| entry.unwrap().file_name().into_string().ok())
        .filter(|name| name.starts_with(STAGING_PREFIX))
        .count();
    assert_eq!(staging, 2);
    assert_eq!(staged.written().len(), 2);
    assert!(staged.publish().unwrap().is_empty());
    assert_eq!(
        fs::read(fixture.target.join("settings.ini")).unwrap(),
        b"lives=9"
    );
    assert_eq!(
        fs::read(fixture.target.join("profiles/one/slot.cfg")).unwrap(),
        b"slot"
    );
    assert_eq!(sweep(&fixture.target).unwrap(), 0);
}

#[test]
fn dropping_an_unpublished_carry_leaves_the_target_untouched() {
    let fixture = fixture();
    write(&fixture.source, "settings.ini", b"lives=9");
    let (_, staged) = run(&fixture, &["settings.ini"], PLENTY);
    drop(staged.unwrap());
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 0);
}

#[test]
fn a_short_volume_carries_nothing() {
    let fixture = fixture();
    write(&fixture.source, "settings.ini", b"lives=9");
    let (_, staged) = run(
        &fixture,
        &["settings.ini"],
        (RESERVE_BYTES, 10 * RESERVE_BYTES),
    );
    match staged {
        Err(CarryStop::InsufficientSpace { required, .. }) => {
            assert_eq!(required, RESERVE_BYTES + CLUSTER_BYTES);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 0);
    // A 500 GiB volume keeps 10 GiB.
    let gib = 1024 * 1024 * 1024;
    assert_eq!(required_bytes(&[], &BTreeMap::new(), 500 * gib), 10 * gib);
}

#[test]
fn a_target_that_differs_is_kept_and_never_written() {
    let fixture = fixture();
    write(&fixture.source, "settings.ini", b"lives=9");
    write(&fixture.target, "settings.ini", b"lives=3");
    let (planned, staged) = run(&fixture, &["settings.ini"], PLENTY);
    assert_eq!(planned[0].action, CarryAction::KeepSeparately);
    assert!(staged.unwrap().publish().unwrap().is_empty());
    assert_eq!(
        fs::read(fixture.target.join("settings.ini")).unwrap(),
        b"lives=3"
    );
}

#[test]
fn a_source_changed_after_planning_holds_without_writing() {
    let fixture = fixture();
    write(&fixture.source, "settings.ini", b"lives=9");
    let inputs = BTreeMap::from([(
        "settings.ini".to_owned(),
        PathInput {
            source: SourceCopy::File {
                sha256: "0".repeat(64),
            },
            source_row: None,
            target: TargetCopy::Absent,
            target_row: None,
            target_replaces: None,
        },
    )]);
    let planned = plan("a", &inputs, &CarryExclusions::default(), &|_| false);
    let inspected = Inspected {
        sizes: BTreeMap::from([("settings.ini".to_owned(), 7)]),
    };
    let staged = stage(
        (&fixture.source, &fixture.target),
        &planned,
        &inspected,
        PLENTY,
        &ok,
    );
    assert!(matches!(staged, Err(CarryStop::SourceChanged(path)) if path == "settings.ini"));
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 0);
}

#[test]
fn a_target_written_after_planning_is_left_alone() {
    let fixture = fixture();
    write(&fixture.source, "settings.ini", b"lives=9");
    let (_, staged) = run(&fixture, &["settings.ini"], PLENTY);
    // The verify pass already ran, so the change appears at publish.
    let staged = staged.unwrap();
    write(&fixture.target, "settings.ini", b"written by the game");
    assert_eq!(staged.publish().unwrap(), vec!["settings.ini".to_owned()]);
    assert_eq!(
        fs::read(fixture.target.join("settings.ini")).unwrap(),
        b"written by the game"
    );
    assert_eq!(sweep(&fixture.target).unwrap(), 0);
}

#[test]
fn case_variant_parents_and_links_block_the_path() {
    let fixture = fixture();
    write(&fixture.target, "Profiles/x.cfg", b"theirs");
    let listings = Listings::default();
    assert_eq!(
        inspect_target(&fixture.target, "profiles/x.cfg", &listings, &ok).unwrap(),
        TargetCopy::Blocked
    );
    assert_eq!(
        inspect_target(&fixture.target, "Profiles/new.cfg", &listings, &ok).unwrap(),
        TargetCopy::Absent
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(fixture.target.join("Profiles"), fixture.target.join("link"))
            .unwrap();
        assert_eq!(
            inspect_target(&fixture.target, "link/x.cfg", &Listings::default(), &ok).unwrap(),
            TargetCopy::Blocked
        );
    }
}

#[test]
fn sweep_removes_only_staging_files() {
    let fixture = fixture();
    write(&fixture.target, "keep.ini", b"x");
    write(&fixture.target, &format!("deep/{STAGING_PREFIX}abc"), b"y");
    write(&fixture.target, &format!("{STAGING_PREFIX}def"), b"z");
    assert_eq!(sweep(&fixture.target).unwrap(), 2);
    assert!(fixture.target.join("keep.ini").exists());
}

#[test]
fn a_recorded_earlier_copy_is_replaced_and_a_deleted_one_removed() {
    let fixture = fixture();
    write(&fixture.source, "settings.ini", b"new");
    write(&fixture.target, "settings.ini", b"old");
    write(&fixture.target, "cache.json", b"old cache");
    let rows = |path: &str| match path {
        "settings.ini" => descended(b"old", Some(b"new")),
        _ => descended(b"old cache", None),
    };
    let (planned, staged) = run_with(&fixture, &["settings.ini", "cache.json"], &rows, PLENTY);
    let actions = planned
        .iter()
        .map(|planned| (planned.path.as_str(), planned.action))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(actions["settings.ini"], CarryAction::Replace);
    assert_eq!(actions["cache.json"], CarryAction::Remove);
    let staged = staged.unwrap();
    assert!(staged.changed_targets.is_empty());
    assert!(staged.publish().unwrap().is_empty());
    assert_eq!(
        fs::read(fixture.target.join("settings.ini")).unwrap(),
        b"new"
    );
    assert!(!fixture.target.join("cache.json").exists());
}

#[test]
fn staging_checks_the_bytes_the_plan_approved_not_a_later_look() {
    let fixture = fixture();
    write(&fixture.source, "settings.ini", b"new");
    write(&fixture.target, "settings.ini", b"old");
    write(&fixture.target, "cache.json", b"old cache");
    let rows = |path: &str| match path {
        "settings.ini" => descended(b"old", Some(b"new")),
        _ => descended(b"old cache", None),
    };
    let (planned, staged) = {
        // Plan first, then let the game write both targets before staging.
        let (planned, staged) = run_with(&fixture, &["settings.ini", "cache.json"], &rows, PLENTY);
        drop(staged);
        write(&fixture.target, "settings.ini", b"the player's edit");
        write(&fixture.target, "cache.json", b"the game's rewrite");
        let sizes = BTreeMap::from([("settings.ini".to_owned(), 3)]);
        let staged = stage(
            (&fixture.source, &fixture.target),
            &planned,
            &Inspected { sizes },
            PLENTY,
            &ok,
        );
        (planned, staged)
    };
    assert_eq!(planned.len(), 2);
    let staged = staged.unwrap();
    let mut changed = staged.changed_targets.clone();
    changed.sort();
    assert_eq!(changed, ["cache.json", "settings.ini"]);
    assert!(staged.publish().unwrap().is_empty());
    assert_eq!(
        fs::read(fixture.target.join("settings.ini")).unwrap(),
        b"the player's edit"
    );
    assert_eq!(
        fs::read(fixture.target.join("cache.json")).unwrap(),
        b"the game's rewrite"
    );
    assert_eq!(sweep(&fixture.target).unwrap(), 0);
}

#[test]
fn a_source_growing_past_its_planned_size_stops_the_copy() {
    let fixture = fixture();
    write(&fixture.source, "log.txt", b"short");
    let (planned, _) = run(&fixture, &["log.txt"], PLENTY);
    let staged = stage(
        (&fixture.source, &fixture.target),
        &planned,
        &Inspected {
            sizes: BTreeMap::from([("log.txt".to_owned(), 2)]),
        },
        PLENTY,
        &ok,
    );
    assert!(matches!(staged, Err(CarryStop::SourceChanged(path)) if path == "log.txt"));
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn a_link_swapped_in_before_publishing_is_never_written_through() {
    let fixture = fixture();
    fs::create_dir(fixture.target.join("profiles")).unwrap();
    write(&fixture.source, "profiles/slot.cfg", b"slot");
    let (_, staged) = run(&fixture, &["profiles/slot.cfg"], PLENTY);
    let staged = staged.unwrap();
    // Replace the existing destination folder with a link elsewhere.
    let elsewhere = fixture.target.parent().unwrap().join("elsewhere");
    fs::create_dir(&elsewhere).unwrap();
    let staging = fs::read_dir(fixture.target.join("profiles"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::rename(&staging, fixture.target.join("staged-aside")).unwrap();
    fs::remove_dir(fixture.target.join("profiles")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, fixture.target.join("profiles")).unwrap();
    assert_eq!(
        staged.publish().unwrap(),
        vec!["profiles/slot.cfg".to_owned()]
    );
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
}

#[test]
fn sensitive_entries_are_never_read() {
    let fixture = fixture();
    write(
        &fixture.source,
        "data/retroachievements.credentials",
        b"secret",
    );
    let listings = Listings::default();
    let (source, size) = inspect_source(
        &fixture.source,
        "data/retroachievements.credentials",
        &listings,
        &ok,
    )
    .unwrap();
    assert_eq!((source, size), (SourceCopy::Unreadable, None));
    assert_eq!(
        inspect_target(
            &fixture.target,
            "data/retroachievements.credentials",
            &listings,
            &ok
        )
        .unwrap(),
        TargetCopy::Blocked
    );
}

#[test]
fn dropped_nested_staging_creates_no_destination_directories() {
    let fixture = fixture();
    fs::create_dir(fixture.target.join("existing")).unwrap();
    write(&fixture.source, "existing/new/deep/slot.cfg", b"save");
    let (_, staged) = run(&fixture, &["existing/new/deep/slot.cfg"], PLENTY);
    let staged = staged.unwrap();
    assert!(!fixture.target.join("existing/new").exists());
    assert_eq!(
        fs::read_dir(fixture.target.join("existing"))
            .unwrap()
            .count(),
        1
    );
    drop(staged);
    assert!(fixture.target.join("existing").is_dir());
    assert_eq!(
        fs::read_dir(fixture.target.join("existing"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        fs::read(fixture.source.join("existing/new/deep/slot.cfg")).unwrap(),
        b"save"
    );
}

#[test]
fn failed_nested_copy_creates_no_directories_and_preserves_the_cause() {
    let fixture = fixture();
    let relative = "new/deep/slot.cfg";
    write(&fixture.source, relative, b"save");
    let (mut planned, staged) = run(&fixture, &[relative], PLENTY);
    drop(staged.unwrap());
    planned[0].approved_source = Some("0".repeat(64));
    let staged = stage(
        (&fixture.source, &fixture.target),
        &planned,
        &Inspected {
            sizes: BTreeMap::from([(relative.to_owned(), 4)]),
        },
        PLENTY,
        &ok,
    );
    assert!(matches!(staged, Err(CarryStop::SourceChanged(path)) if path == relative));
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 0);
    assert_eq!(fs::read(fixture.source.join(relative)).unwrap(), b"save");
}

#[test]
fn destination_directories_created_by_another_writer_are_preserved_on_drop() {
    let fixture = fixture();
    write(&fixture.source, "new/deep/slot.cfg", b"save");
    let (_, staged) = run(&fixture, &["new/deep/slot.cfg"], PLENTY);
    let staged = staged.unwrap();
    fs::create_dir_all(fixture.target.join("new/deep")).unwrap();
    drop(staged);
    assert!(fixture.target.join("new/deep").is_dir());
    assert_eq!(
        fs::read_dir(fixture.target.join("new/deep"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(sweep(&fixture.target).unwrap(), 0);
}

#[test]
fn publish_rechecks_new_destination_folders_and_preserves_player_files() {
    let fixture = fixture();
    write(&fixture.source, "new/deep/slot.cfg", b"save");
    let (_, staged) = run(&fixture, &["new/deep/slot.cfg"], PLENTY);
    let staged = staged.unwrap();
    write(&fixture.target, "new/deep/slot.cfg", b"player copy");
    assert_eq!(staged.publish().unwrap(), vec!["new/deep/slot.cfg"]);
    assert_eq!(
        fs::read(fixture.target.join("new/deep/slot.cfg")).unwrap(),
        b"player copy"
    );
    assert_eq!(sweep(&fixture.target).unwrap(), 0);
}
