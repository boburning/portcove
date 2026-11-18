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
    run_with_writer(fixture, paths, rows, space, &write_staging, &ok)
}

fn run_with_writer(
    fixture: &Fixture,
    paths: &[&str],
    rows: &dyn Fn(&str) -> Rows,
    space: (u64, u64),
    writer: &StagingWriter<'_>,
    checkpoint: &dyn Fn() -> Result<()>,
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
    let staged = stage_with_writer(
        (&fixture.source, &fixture.target),
        &planned,
        &inspected,
        space,
        checkpoint,
        writer,
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

#[test]
fn staging_storage_full_discards_completed_and_partial_nested_copies() {
    let fixture = fixture();
    write(&fixture.source, "existing/first.txt", b"first player file");
    write(&fixture.source, "missing/second.txt", b"second player file");
    fs::create_dir(fixture.target.join("existing")).unwrap();
    let writes = std::cell::Cell::new(0);
    let writer = |output: &mut fs::File, bytes: &[u8]| {
        writes.set(writes.get() + 1);
        if writes.get() == 2 {
            write_staging(output, &bytes[..1])?;
            return Err(std::io::ErrorKind::StorageFull.into());
        }
        write_staging(output, bytes)
    };
    let (_, result) = run_with_writer(
        &fixture,
        &["existing/first.txt", "missing/second.txt"],
        &|_| (None, None),
        (u64::MAX, u64::MAX),
        &writer,
        &ok,
    );
    assert!(matches!(
        result,
        Err(CarryStop::InsufficientSpace {
            available: None,
            ..
        })
    ));
    assert_eq!(writes.get(), 2);
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 1);
    assert_eq!(
        fs::read_dir(fixture.target.join("existing"))
            .unwrap()
            .count(),
        0
    );
    assert!(!fixture.target.join("missing").exists());
    assert_eq!(
        fs::read(fixture.source.join("existing/first.txt")).unwrap(),
        b"first player file"
    );
    assert_eq!(
        fs::read(fixture.source.join("missing/second.txt")).unwrap(),
        b"second player file"
    );
}

#[test]
fn staging_non_space_destination_and_checkpoint_errors_remain_holds() {
    let fixture = fixture();
    write(&fixture.source, "notes.txt", b"player file");
    let denied = |_: &mut fs::File, _: &[u8]| Err(std::io::ErrorKind::PermissionDenied.into());
    let (_, result) = run_with_writer(
        &fixture,
        &["notes.txt"],
        &|_| (None, None),
        (u64::MAX, u64::MAX),
        &denied,
        &ok,
    );
    assert!(matches!(result, Err(CarryStop::Failed(_))));
    let checkpoint = || Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into());
    let (_, result) = run_with_writer(
        &fixture,
        &["notes.txt"],
        &|_| (None, None),
        (u64::MAX, u64::MAX),
        &write_staging,
        &checkpoint,
    );
    assert!(matches!(result, Err(CarryStop::Failed(_))));
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 0);
}

#[test]
fn staging_exhaustion_with_unremovable_prior_temp_remains_a_hold() {
    let fixture = fixture();
    write(&fixture.source, "a.txt", b"first player file");
    write(&fixture.source, "b.txt", b"second player file");
    let first_path = std::cell::RefCell::new(None);
    let writer = |output: &mut fs::File, bytes: &[u8]| {
        if let Some(path) = first_path.borrow().as_ref() {
            fs::remove_file(path)?;
            fs::create_dir(path)?;
            write_staging(output, &bytes[..1])?;
            return Err(std::io::ErrorKind::StorageFull.into());
        }
        write_staging(output, bytes)?;
        *first_path.borrow_mut() = Some(fs::read_dir(&fixture.target)?.next().unwrap()?.path());
        Ok(())
    };
    let (_, result) = run_with_writer(
        &fixture,
        &["a.txt", "b.txt"],
        &|_| (None, None),
        (u64::MAX, u64::MAX),
        &writer,
        &ok,
    );
    assert!(matches!(result, Err(CarryStop::Failed(_))));
    assert!(first_path.borrow().as_ref().unwrap().is_dir());
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 1);
    assert!(!fixture.target.join("a.txt").exists());
    assert!(!fixture.target.join("b.txt").exists());
}

fn cancellation() -> PortcoveError {
    PortcoveError::new(
        crate::ErrorCode::Cancelled,
        "fixture requested cancellation",
    )
    .detail("fixture", "carry-checkpoint")
}

fn assert_cancelled(stop: CarryStop) {
    let CarryStop::Failed(error) = stop else {
        panic!("cancellation changed classification: {stop:?}")
    };
    assert_eq!(error.code, crate::ErrorCode::Cancelled);
    assert_eq!(
        error.details.get("fixture").map(String::as_str),
        Some("carry-checkpoint")
    );
}

#[test]
fn inspection_preserves_cancellation_instead_of_unreadable_file_outcomes() {
    let fixture = fixture();
    write(&fixture.source, "notes.txt", b"source player file");
    write(&fixture.target, "notes.txt", b"target player file");
    let listings = Listings::default();
    for error in [
        inspect_source(&fixture.source, "notes.txt", &listings, &|| {
            Err(cancellation())
        })
        .unwrap_err(),
        inspect_target(&fixture.target, "notes.txt", &listings, &|| {
            Err(cancellation())
        })
        .unwrap_err(),
    ] {
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        assert_eq!(
            error.details.get("fixture").map(String::as_str),
            Some("carry-checkpoint")
        );
    }
}

#[test]
fn source_and_destination_verification_preserve_cancellation() {
    for cancel_destination in [false, true] {
        let fixture = fixture();
        let old = b"older player file";
        let new = b"updated player file";
        write(&fixture.source, "notes.txt", new);
        write(&fixture.target, "notes.txt", old);
        let (plan, staged) = run_with(
            &fixture,
            &["notes.txt"],
            &|_| descended(old, Some(new)),
            PLENTY,
        );
        assert_eq!(plan[0].action, CarryAction::Replace);
        let mut staged = staged.unwrap();
        // Measure the real source hash's checkpoints to cancel in the subsequent
        // destination hash, without sleeps or an assumed number of IO chunks.
        let source_calls = std::cell::Cell::new(0);
        hash_file(&fixture.source.join("notes.txt"), &|| {
            source_calls.set(source_calls.get() + 1);
            Ok(())
        })
        .unwrap();
        assert!(source_calls.get() > 0);
        let calls = std::cell::Cell::new(0);
        let checkpoint = || {
            calls.set(calls.get() + 1);
            if !cancel_destination || calls.get() > source_calls.get() {
                Err(cancellation())
            } else {
                Ok(())
            }
        };
        assert_cancelled(verify(&mut staged, &fixture.source, &plan, &checkpoint).unwrap_err());
        assert!(staged.changed_targets.is_empty());
        staged.discard().unwrap();
        assert_eq!(fs::read(fixture.source.join("notes.txt")).unwrap(), new);
        assert_eq!(fs::read(fixture.target.join("notes.txt")).unwrap(), old);
        assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 1);
    }
}

#[test]
fn removal_verification_preserves_cancellation_instead_of_keeping_a_changed_target() {
    let fixture = fixture();
    let old = b"deleted player file";
    write(&fixture.target, "notes.txt", old);
    let (plan, staged) = run_with(&fixture, &["notes.txt"], &|_| descended(old, None), PLENTY);
    assert_eq!(plan[0].action, CarryAction::Remove);
    let mut staged = staged.unwrap();
    assert_cancelled(
        verify(&mut staged, &fixture.source, &plan, &|| Err(cancellation())).unwrap_err(),
    );
    assert!(staged.changed_targets.is_empty());
    assert_eq!(fs::read(fixture.target.join("notes.txt")).unwrap(), old);
}

#[test]
fn cancellation_during_second_copy_discards_completed_and_partial_staging() {
    let fixture = fixture();
    write(&fixture.source, "a.txt", b"first player file");
    let large = vec![42; 128 * 1024];
    write(&fixture.source, "b.txt", &large);
    let writes = std::cell::Cell::new(0);
    let requested = std::cell::Cell::new(false);
    let writer = |output: &mut fs::File, bytes: &[u8]| {
        write_staging(output, bytes)?;
        writes.set(writes.get() + 1);
        if writes.get() == 2 {
            requested.set(true);
        }
        Ok(())
    };
    let checkpoint = || {
        if requested.get() {
            Err(cancellation())
        } else {
            Ok(())
        }
    };
    let (_, result) = run_with_writer(
        &fixture,
        &["a.txt", "b.txt"],
        &|_| (None, None),
        PLENTY,
        &writer,
        &checkpoint,
    );
    assert_cancelled(result.unwrap_err());
    assert_eq!(writes.get(), 2);
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 0);
    assert_eq!(
        fs::read(fixture.source.join("a.txt")).unwrap(),
        b"first player file"
    );
    assert_eq!(fs::read(fixture.source.join("b.txt")).unwrap(), large);
}

#[cfg(windows)]
#[test]
fn a_read_only_destination_holds_publication_and_preserves_both_copies() {
    let fixture = fixture();
    let old = b"read-only previous player file";
    let new = b"new player file";
    write(&fixture.source, "notes.txt", new);
    write(&fixture.target, "notes.txt", old);
    let path = fixture.target.join("notes.txt");
    struct RestorePermissions(PathBuf, fs::Permissions);
    impl Drop for RestorePermissions {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, self.1.clone());
        }
    }
    let original = fs::metadata(&path).unwrap().permissions();
    let restore = RestorePermissions(path.clone(), original.clone());
    let mut readonly = original;
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let (plan, staged) = run_with(
        &fixture,
        &["notes.txt"],
        &|_| descended(old, Some(new)),
        PLENTY,
    );
    assert_eq!(plan[0].action, CarryAction::Replace);
    assert!(staged.unwrap().publish().is_err());
    assert_eq!(fs::read(fixture.source.join("notes.txt")).unwrap(), new);
    assert_eq!(fs::read(&path).unwrap(), old);
    assert!(fs::metadata(&path).unwrap().permissions().readonly());
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 1);
    fs::set_permissions(&path, restore.1.clone()).unwrap();
}

#[cfg(windows)]
fn observed_short_name(path: &Path) -> Option<String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let input = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let required = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
            input.as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    assert!(
        required > 0 && required <= 32768,
        "short-name observation failed: {}",
        std::io::Error::last_os_error()
    );
    let mut output = vec![0u16; required as usize];
    let count = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
            input.as_ptr(),
            output.as_mut_ptr(),
            required,
        )
    };
    assert!(
        count > 0 && count < required,
        "short-name observation changed: {}",
        std::io::Error::last_os_error()
    );
    output.truncate(count as usize);
    let short = PathBuf::from(std::ffi::OsString::from_wide(&output));
    let name = short.file_name().unwrap().to_str().unwrap();
    if short.file_name() == path.file_name() {
        eprintln!(
            "PORTCOVE_CARRY_83_NOT_RUN: the fixture volume provides no short alias for this owned path"
        );
        return None;
    }
    assert!(name.is_ascii() && name.contains('~'));
    assert!(short.exists());
    eprintln!("PORTCOVE_CARRY_83_OBSERVED: {name}");
    Some(name.to_owned())
}

#[cfg(windows)]
#[test]
fn a_windows_short_file_alias_keeps_the_target_separate() {
    let fixture = fixture();
    let long = "PlayerConfigurationFile.ini";
    write(&fixture.target, long, b"existing target data");
    let Some(alias) = observed_short_name(&fixture.target.join(long)) else {
        return;
    };
    write(&fixture.source, &alias, b"different source data");
    let (planned, staged) = run(&fixture, &[&alias], PLENTY);
    // The planner rejects short-name coordinates before staging or ledger changes.
    assert_eq!(
        planned[0].action,
        CarryAction::Excluded(crate::carry_plan::Exclusion::ShortName)
    );
    assert_eq!(planned[0].source_row, RowChange::Untouched);
    assert_eq!(planned[0].target_row, RowChange::Untouched);
    let staged = staged.unwrap();
    assert!(staged.changed_targets.is_empty());
    assert!(staged.written().is_empty());
    assert!(staged.publish().unwrap().is_empty());
    assert_eq!(
        fs::read(fixture.target.join(long)).unwrap(),
        b"existing target data"
    );
    assert_eq!(
        fs::read(fixture.source.join(&alias)).unwrap(),
        b"different source data"
    );
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 1);
    eprintln!("PORTCOVE_CARRY_83_FILE_PRESERVED");
}

#[cfg(windows)]
#[test]
fn a_windows_short_directory_alias_is_not_a_publication_parent() {
    let fixture = fixture();
    let long = "PlayerConfigurationDirectory";
    fs::create_dir(fixture.target.join(long)).unwrap();
    let Some(alias) = observed_short_name(&fixture.target.join(long)) else {
        return;
    };
    let relative = format!("{alias}/new.txt");
    write(&fixture.source, &relative, b"source data");
    let (planned, staged) = run(&fixture, &[&relative], PLENTY);
    assert_eq!(
        planned[0].action,
        CarryAction::Excluded(crate::carry_plan::Exclusion::ShortName)
    );
    assert_eq!(planned[0].source_row, RowChange::Untouched);
    assert_eq!(planned[0].target_row, RowChange::Untouched);
    let staged = staged.unwrap();
    assert!(staged.changed_targets.is_empty());
    assert!(staged.written().is_empty());
    assert!(staged.publish().unwrap().is_empty());
    assert!(!fixture.target.join(long).join("new.txt").exists());
    assert_eq!(
        fs::read(fixture.source.join(relative)).unwrap(),
        b"source data"
    );
    assert_eq!(fs::read_dir(fixture.target.join(long)).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&fixture.target).unwrap().count(), 1);
    eprintln!("PORTCOVE_CARRY_83_DIRECTORY_PRESERVED");
}
