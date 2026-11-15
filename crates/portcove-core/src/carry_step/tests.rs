use std::collections::BTreeMap;

use super::*;
use crate::carry_plan::{CarryExclusions, PathInput, RowChange, plan};

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

/// Inspect, plan and stage `paths` with no ledger rows (first contact).
fn run(
    fixture: &Fixture,
    paths: &[&str],
    space: (u64, u64),
) -> (Vec<PlannedPath>, std::result::Result<Staged, CarryStop>) {
    let mut inputs = BTreeMap::new();
    let mut sizes = BTreeMap::new();
    let mut source_digests = BTreeMap::new();
    let mut target_digests = BTreeMap::new();
    for path in paths {
        let (source, size) = inspect_source(&fixture.source, path, &ok).unwrap();
        if let SourceCopy::File { sha256 } = &source {
            source_digests.insert(path.to_string(), sha256.clone());
            sizes.insert(path.to_string(), size.unwrap());
        }
        let target = inspect_target(&fixture.target, path, &ok).unwrap();
        if let TargetCopy::File { sha256 } = &target {
            target_digests.insert(path.to_string(), sha256.clone());
        }
        inputs.insert(
            path.to_string(),
            PathInput {
                source,
                source_row: None,
                target,
                target_row: None,
                target_replaces: None,
            },
        );
    }
    let planned = plan("a", &inputs, &CarryExclusions::default(), &|_| false);
    let inspected = Inspected {
        sizes,
        source_digests,
        target_digests,
    };
    let staged = stage(
        (&fixture.source, &fixture.target),
        &planned,
        &inspected,
        space,
        &ok,
    );
    (planned, staged)
}

const PLENTY: (u64, u64) = (u64::MAX / 2, 10 * 1024 * 1024 * 1024);

#[test]
fn copies_stage_beside_the_destination_and_publish_atomically() {
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
    assert_eq!(staging, 1);
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
        source_digests: BTreeMap::from([("settings.ini".to_owned(), "0".repeat(64))]),
        target_digests: BTreeMap::new(),
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
    assert_eq!(
        inspect_target(&fixture.target, "profiles/x.cfg", &ok).unwrap(),
        TargetCopy::Blocked
    );
    assert_eq!(
        inspect_target(&fixture.target, "Profiles/new.cfg", &ok).unwrap(),
        TargetCopy::Absent
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(fixture.target.join("Profiles"), fixture.target.join("link"))
            .unwrap();
        assert_eq!(
            inspect_target(&fixture.target, "link/x.cfg", &ok).unwrap(),
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
