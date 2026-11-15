use super::*;

const A: &str = "install-a";

fn digest(label: &str) -> String {
    format!("{label:0>64}")
}

fn present(label: &str, lineage: &[&str]) -> CarryRow {
    CarryRow::present(
        &digest(label),
        lineage.iter().map(|value| digest(value)).collect(),
    )
}

fn input(
    source: Option<&str>,
    source_row: Option<CarryRow>,
    target: TargetCopy,
    target_row: Option<CarryRow>,
) -> PathInput {
    PathInput {
        source: source.map(digest),
        source_row,
        target,
        target_row,
    }
}

fn file(label: &str) -> TargetCopy {
    TargetCopy::File {
        sha256: digest(label),
    }
}

fn one(path: &str, input: PathInput, exclusions: &CarryExclusions) -> PlannedPath {
    let paths = BTreeMap::from([(path.to_owned(), input)]);
    plan(A, &paths, exclusions, &|_| false).remove(0)
}

fn action(path: &str, input: PathInput) -> CarryAction {
    one(path, input, &CarryExclusions::default()).action
}

#[test]
fn decision_table_rows() {
    // t = a: nothing to copy, T records a's lineage.
    let same = one(
        "settings.ini",
        input(Some("1"), None, file("1"), None),
        &CarryExclusions::default(),
    );
    assert_eq!(same.action, CarryAction::Nothing);
    assert_eq!(same.target_row, Some(present("1", &["1"])));
    // Absent at T: copy.
    assert_eq!(
        action(
            "settings.ini",
            input(Some("1"), None, TargetCopy::Absent, None)
        ),
        CarryAction::Copy
    );
    // Both absent: nothing, and no row.
    let none = one(
        "settings.ini",
        input(None, None, TargetCopy::Absent, None),
        &CarryExclusions::default(),
    );
    assert_eq!(none.action, CarryAction::Nothing);
    assert_eq!(none.target_row, None);
}

#[test]
fn replacement_needs_lineage_and_an_unchanged_target() {
    let a_row = present("2", &["1", "2"]);
    // t is an ancestor and T still holds what Portcove recorded: replace.
    let replaced = one(
        "save.dat",
        input(
            Some("2"),
            Some(a_row.clone()),
            file("1"),
            Some(present("1", &["1"])),
        ),
        &CarryExclusions::default(),
    );
    assert_eq!(replaced.action, CarryAction::Replace);
    assert_eq!(replaced.target_row, Some(present("2", &["1", "2"])));
    // t is an ancestor but T was edited since Portcove recorded it: keep both.
    assert_eq!(
        action(
            "save.dat",
            input(
                Some("2"),
                Some(a_row.clone()),
                file("1"),
                Some(present("9", &["9"]))
            )
        ),
        CarryAction::KeepSeparately
    );
    // t is an ancestor but T has no row (an A→B→A edit made outside Portcove).
    assert_eq!(
        action("save.dat", input(Some("2"), Some(a_row), file("1"), None)),
        CarryAction::KeepSeparately
    );
    // First contact: differing copies and no rows keep both, T keeps its own.
    let first = one(
        "save.dat",
        input(Some("2"), None, file("1"), None),
        &CarryExclusions::default(),
    );
    assert_eq!(first.action, CarryAction::KeepSeparately);
    assert_eq!(first.target_row, Some(present("1", &["1"])));
}

#[test]
fn pending_rows_count_only_from_the_same_source() {
    let a_row = present("2", &["1", "2"]);
    let pending = |source: &str| CarryRow {
        state: RowState::Pending {
            source_install_id: source.to_owned(),
        },
        sha256: digest("1"),
        lineage: vec![digest("1")],
    };
    assert_eq!(
        action(
            "save.dat",
            input(Some("2"), Some(a_row.clone()), file("1"), Some(pending(A)))
        ),
        CarryAction::Replace
    );
    assert_eq!(
        action(
            "save.dat",
            input(Some("2"), Some(a_row), file("1"), Some(pending("other")))
        ),
        CarryAction::KeepSeparately
    );
    // A pending source row is never lineage.
    assert_eq!(
        action(
            "save.dat",
            input(
                Some("2"),
                Some(CarryRow {
                    state: RowState::Pending {
                        source_install_id: "other".into()
                    },
                    sha256: digest("2"),
                    lineage: vec![digest("1"), digest("2")],
                }),
                file("1"),
                Some(present("1", &["1"]))
            )
        ),
        CarryAction::KeepSeparately
    );
}

#[test]
fn removal_only_follows_a_deletion_of_a_descendant() {
    let target_row = Some(present("1", &["1"]));
    // A deleted a file whose ancestor T still holds unchanged: remove it.
    let removed = one(
        "cache.json",
        input(
            None,
            Some(present("1", &["1"])),
            file("1"),
            target_row.clone(),
        ),
        &CarryExclusions::default(),
    );
    assert_eq!(removed.action, CarryAction::Remove);
    assert_eq!(removed.target_row, None);
    // No A row: A never had it, so T's own file stays.
    assert_eq!(
        action(
            "cache.json",
            input(None, None, file("1"), target_row.clone())
        ),
        CarryAction::Leave
    );
    // T changed since Portcove recorded it: leave it.
    assert_eq!(
        action(
            "cache.json",
            input(
                None,
                Some(present("1", &["1"])),
                file("1"),
                Some(present("5", &["5"]))
            )
        ),
        CarryAction::Leave
    );
    // T's bytes aren't in A's lineage: leave it.
    assert_eq!(
        action(
            "cache.json",
            input(None, Some(present("2", &["2"])), file("1"), target_row)
        ),
        CarryAction::Leave
    );
}

#[test]
fn worked_forward_back_forward_cycle() {
    // 1. v1 has d1 with no rows; updating to v2 copies it.
    let update = one(
        "settings.ini",
        input(Some("1"), None, TargetCopy::Absent, None),
        &CarryExclusions::default(),
    );
    assert_eq!(update.action, CarryAction::Copy);
    let v2_row = update.target_row.unwrap();
    let v1_row = present("1", &["1"]);
    // v2 changes the file to d2; the switch records v2's departing row.
    let v2_departing = CarryRow::present(&digest("2"), {
        let mut lineage = v2_row.lineage.clone();
        lineage.push(digest("2"));
        lineage
    });
    // 2. Roll back: v1's d1 is in v2's lineage and unchanged, so it's replaced.
    let rollback = one(
        "settings.ini",
        input(Some("2"), Some(v2_departing), file("1"), Some(v1_row)),
        &CarryExclusions::default(),
    );
    assert_eq!(rollback.action, CarryAction::Replace);
    let v1_row = rollback.target_row.unwrap();
    assert_eq!(v1_row, present("2", &["1", "2"]));
    // v1 changes it to d3 and departs.
    let v1_departing = CarryRow::present(&digest("3"), {
        let mut lineage = v1_row.lineage.clone();
        lineage.push(digest("3"));
        lineage
    });
    // 3. Forward: v2 still holds d2, recorded and in lineage, so it's replaced.
    let forward = one(
        "settings.ini",
        input(
            Some("3"),
            Some(v1_departing),
            file("2"),
            Some(present("2", &["1", "2"])),
        ),
        &CarryExclusions::default(),
    );
    assert_eq!(forward.action, CarryAction::Replace);
    assert_eq!(forward.target_row, Some(present("3", &["1", "2", "3"])));
}

#[test]
fn lineage_collapses_duplicates_and_keeps_the_newest_eight() {
    let lineage = ["1", "1", "2", "2", "3"]
        .iter()
        .map(|value| digest(value))
        .collect();
    assert_eq!(
        bounded_lineage(lineage),
        ["1", "2", "3"].map(digest).to_vec()
    );
    let long = (0..12).map(|value| digest(&value.to_string())).collect();
    let bounded = bounded_lineage(long);
    assert_eq!(bounded.len(), MAX_LINEAGE);
    assert_eq!(bounded.first(), Some(&digest("4")));
    assert_eq!(bounded.last(), Some(&digest("11")));
}

fn excluded(path: &str, exclusions: &CarryExclusions) -> Option<Exclusion> {
    match one(
        path,
        input(Some("1"), None, TargetCopy::Absent, None),
        exclusions,
    )
    .action
    {
        CarryAction::Excluded(reason) => Some(reason),
        _ => None,
    }
}

#[test]
fn name_rules_exclude_unsafe_and_portcove_paths() {
    let none = CarryExclusions::default();
    assert_eq!(excluded("settings.ini", &none), None);
    assert_eq!(
        excluded("data/../x.ini", &none),
        Some(Exclusion::InvalidPath)
    );
    assert_eq!(
        excluded("caf\u{e9}.ini", &none),
        Some(Exclusion::InvalidPath)
    );
    assert_eq!(
        excluded("PROGRA~1/x.ini", &none),
        Some(Exclusion::ShortName)
    );
    assert_eq!(excluded("SAVE~2.DAT", &none), Some(Exclusion::ShortName));
    assert_eq!(excluded("tilde~name.ini", &none), None);
    for portcove in [
        ".portcove-manifest.json",
        "game.sfc.Portcove-Source.json",
        "sub/.PORTCOVE-launched",
    ] {
        assert_eq!(
            excluded(portcove, &none),
            Some(Exclusion::PortcoveMetadata),
            "{portcove}"
        );
    }
    for loader in [
        "dxvk.conf",
        "bin/ReShade.ini",
        "portable.txt",
        "Game.exe.config",
    ] {
        assert_eq!(
            excluded(loader, &none),
            Some(Exclusion::LoaderName),
            "{loader}"
        );
    }
}

#[test]
fn metadata_names_are_excluded() {
    let exclusions = CarryExclusions {
        generated_metadata: vec!["rom.cfg".into()],
        ..CarryExclusions::default()
    };
    assert_eq!(
        excluded("ROM.cfg", &exclusions),
        Some(Exclusion::GeneratedMetadata)
    );
    let paths = BTreeMap::from([(
        "receipt.json".to_owned(),
        input(Some("1"), None, TargetCopy::Absent, None),
    )]);
    let planned = plan(A, &paths, &CarryExclusions::default(), &|path| {
        path == "receipt.json"
    });
    assert_eq!(
        planned[0].action,
        CarryAction::Excluded(Exclusion::GeneratedMetadata)
    );
}

#[test]
fn package_members_and_their_folders_are_never_written_or_removed() {
    let exclusions = CarryExclusions {
        target_members: vec!["Game.exe".into(), "mods/bundled/core.pak".into()],
        electron_resources: Some("resources".into()),
        ..CarryExclusions::default()
    };
    // B1: v2 ships settings-like content as a member; even with A's lineage and
    // A having deleted it, the member is never removed.
    let member = CarryExclusions {
        target_members: vec!["settings.ini".into()],
        ..CarryExclusions::default()
    };
    let removal = one(
        "settings.ini",
        input(
            None,
            Some(present("0", &["0"])),
            file("0"),
            Some(present("0", &["0"])),
        ),
        &member,
    );
    assert_eq!(
        removal.action,
        CarryAction::Excluded(Exclusion::PackageMember)
    );
    assert_eq!(removal.target_row, None);
    // Case alias of a member, a path inside a member, and a member's parent.
    assert_eq!(
        excluded("game.EXE", &exclusions),
        Some(Exclusion::PackageMember)
    );
    assert_eq!(
        excluded("mods/bundled", &exclusions),
        Some(Exclusion::PackageMember)
    );
    // A new file beside a shipped mod package.
    assert_eq!(
        excluded("mods/bundled/extra.pak", &exclusions),
        Some(Exclusion::PackageFolder)
    );
    // A file directly in the root beside the program is not a package folder.
    assert_eq!(excluded("notes.txt", &exclusions), None);
    assert_eq!(
        excluded("Resources/app/x.json", &exclusions),
        Some(Exclusion::ElectronResources)
    );
}

#[test]
fn declared_paths_and_patterns_freeze_rows() {
    let pattern = PersistentFilePattern {
        prefix: "slot".into(),
        suffix: ".sav".into(),
        allow_empty_middle: false,
    };
    let exclusions = CarryExclusions {
        declared_paths: vec!["saves".into(), "mods/preloaded/state.toml".into()],
        declared_patterns: vec![(Some("data".into()), pattern)],
        ..CarryExclusions::default()
    };
    // A carried path that becomes declared: its rows freeze, nothing is written.
    let frozen = one(
        "mods/preloaded/state.toml",
        input(
            Some("2"),
            Some(present("2", &["1", "2"])),
            file("1"),
            Some(present("1", &["1"])),
        ),
        &exclusions,
    );
    assert_eq!(frozen.action, CarryAction::Excluded(Exclusion::Declared));
    assert_eq!(frozen.target_row, None);
    assert_eq!(
        excluded("saves/slot1.srm", &exclusions),
        Some(Exclusion::Declared)
    );
    assert_eq!(excluded("Saves", &exclusions), Some(Exclusion::Declared));
    assert_eq!(
        excluded("data/slot04.sav", &exclusions),
        Some(Exclusion::Declared)
    );
    assert_eq!(excluded("data/other.sav", &exclusions), None);
    assert_eq!(excluded("slot04.sav", &exclusions), None);
}

#[test]
fn case_collisions_and_blocked_targets_are_excluded() {
    let paths = BTreeMap::from([
        (
            "Config.ini".to_owned(),
            input(Some("1"), None, TargetCopy::Absent, None),
        ),
        (
            "config.ini".to_owned(),
            input(Some("2"), None, TargetCopy::Absent, None),
        ),
        (
            "other.ini".to_owned(),
            input(Some("3"), None, TargetCopy::Blocked, None),
        ),
        (
            "fine.ini".to_owned(),
            input(Some("4"), None, TargetCopy::Absent, None),
        ),
    ]);
    let planned = plan(A, &paths, &CarryExclusions::default(), &|_| false);
    let by_path = planned
        .iter()
        .map(|planned| (planned.path.as_str(), planned.action))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        by_path["Config.ini"],
        CarryAction::Excluded(Exclusion::CaseCollision)
    );
    assert_eq!(
        by_path["config.ini"],
        CarryAction::Excluded(Exclusion::CaseCollision)
    );
    assert_eq!(
        by_path["other.ini"],
        CarryAction::Excluded(Exclusion::TargetBlocked)
    );
    assert_eq!(by_path["fine.ini"], CarryAction::Copy);
    assert_eq!(written_paths(&planned), BTreeSet::from(["fine.ini"]));
}
