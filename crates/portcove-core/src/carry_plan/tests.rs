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

fn pending_from(source: &str, label: &str) -> CarryRow {
    CarryRow {
        state: RowState::Pending {
            source_install_id: source.to_owned(),
        },
        sha256: digest(label),
        lineage: vec![digest(label)],
    }
}

fn src(label: Option<&str>) -> SourceCopy {
    label.map_or(SourceCopy::Absent, |label| SourceCopy::File {
        sha256: digest(label),
    })
}

fn file(label: &str) -> TargetCopy {
    TargetCopy::File {
        sha256: digest(label),
    }
}

fn input(
    source: Option<&str>,
    source_row: Option<CarryRow>,
    target: TargetCopy,
    target_row: Option<CarryRow>,
) -> PathInput {
    PathInput {
        source: src(source),
        source_row,
        target,
        target_row,
        target_replaces: None,
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
    let same = one(
        "settings.ini",
        input(Some("1"), Some(present("0", &["0"])), file("1"), None),
        &CarryExclusions::default(),
    );
    // t = a: nothing to copy, T records a's lineage including L_A.
    assert_eq!(same.action, CarryAction::Nothing);
    assert_eq!(same.target_row, RowChange::Set(present("1", &["0", "1"])));
    assert_eq!(same.source_row, RowChange::Set(present("1", &["0", "1"])));
    assert_eq!(
        action(
            "settings.ini",
            input(Some("1"), None, TargetCopy::Absent, None)
        ),
        CarryAction::Copy
    );
    let none = one(
        "settings.ini",
        input(None, None, TargetCopy::Absent, None),
        &CarryExclusions::default(),
    );
    assert_eq!(none.action, CarryAction::Nothing);
    assert_eq!(none.target_row, RowChange::Delete);
    assert_eq!(none.source_row, RowChange::Delete);
}

#[test]
fn replacement_needs_lineage_and_an_unchanged_target() {
    let a_row = present("2", &["1", "2"]);
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
    assert_eq!(
        replaced.target_row,
        RowChange::Set(present("2", &["1", "2"]))
    );
    // Edited since Portcove recorded it: keep both.
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
    // No target row (an edit made outside Portcove): keep both.
    assert_eq!(
        action("save.dat", input(Some("2"), Some(a_row), file("1"), None)),
        CarryAction::KeepSeparately
    );
}

#[test]
fn kept_rows_preserve_recorded_lineage_or_restart_it() {
    // An existing present row matching T keeps its lineage.
    let kept = one(
        "save.dat",
        input(Some("5"), None, file("3"), Some(present("3", &["2", "3"]))),
        &CarryExclusions::default(),
    );
    assert_eq!(kept.action, CarryAction::KeepSeparately);
    assert_eq!(kept.target_row, RowChange::Set(present("3", &["2", "3"])));
    // A stale row restarts at T's bytes.
    let stale = one(
        "save.dat",
        input(Some("5"), None, file("3"), Some(present("9", &["9"]))),
        &CarryExclusions::default(),
    );
    assert_eq!(stale.target_row, RowChange::Set(present("3", &["3"])));
    // A pending row from another source restarts at T's bytes.
    let pending = one(
        "save.dat",
        input(Some("5"), None, file("3"), Some(pending_from("other", "3"))),
        &CarryExclusions::default(),
    );
    assert_eq!(pending.action, CarryAction::KeepSeparately);
    assert_eq!(pending.target_row, RowChange::Set(present("3", &["3"])));
}

#[test]
fn pending_rows_count_only_from_the_same_source() {
    let a_row = present("2", &["1", "2"]);
    assert_eq!(
        action(
            "save.dat",
            input(
                Some("2"),
                Some(a_row.clone()),
                file("1"),
                Some(pending_from(A, "1"))
            )
        ),
        CarryAction::Replace
    );
    assert_eq!(
        action(
            "save.dat",
            input(
                Some("2"),
                Some(a_row),
                file("1"),
                Some(pending_from("other", "1"))
            )
        ),
        CarryAction::KeepSeparately
    );
    // A pending source row is never lineage.
    assert_eq!(
        action(
            "save.dat",
            input(
                Some("2"),
                Some(pending_from("other", "2")),
                file("1"),
                Some(present("1", &["1"]))
            )
        ),
        CarryAction::KeepSeparately
    );
}

#[test]
fn an_interrupted_placement_from_this_source_is_portcoves_own() {
    // M1: T holds a's bytes from an interrupted publish, and A had no row.
    // A changed before the retry: replace Portcove's own placement. T's row
    // starts from A's lineage, not the pending row's.
    let replaced = one(
        "settings.ini",
        input(Some("2"), None, file("1"), Some(pending_from(A, "1"))),
        &CarryExclusions::default(),
    );
    assert_eq!(replaced.action, CarryAction::Replace);
    assert_eq!(replaced.target_row, RowChange::Set(present("2", &["2"])));
    // A deleted it before the retry: remove Portcove's own placement.
    let removed = one(
        "settings.ini",
        input(None, None, file("1"), Some(pending_from(A, "1"))),
        &CarryExclusions::default(),
    );
    assert_eq!(removed.action, CarryAction::Remove);
    assert_eq!(removed.target_row, RowChange::Delete);
}

#[test]
fn removal_only_follows_a_deletion_of_a_descendant() {
    let target_row = Some(present("1", &["1"]));
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
    assert_eq!(removed.target_row, RowChange::Delete);
    assert_eq!(removed.source_row, RowChange::Delete);
    assert_eq!(
        action(
            "cache.json",
            input(None, None, file("1"), target_row.clone())
        ),
        CarryAction::Leave
    );
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
    assert_eq!(
        action(
            "cache.json",
            input(
                None,
                Some(present("2", &["2"])),
                file("1"),
                target_row.clone()
            )
        ),
        CarryAction::Leave
    );
    // A pending A row is not a deletion record.
    assert_eq!(
        action(
            "cache.json",
            input(
                None,
                Some(pending_from("other", "1")),
                file("1"),
                target_row
            )
        ),
        CarryAction::Leave
    );
}

#[test]
fn unreadable_copies_are_never_absent_or_replaced() {
    // M3: an unreadable source with a lineage covering T's copy never removes it.
    let unreadable_source = one(
        "save.dat",
        PathInput {
            source: SourceCopy::Unreadable,
            source_row: Some(present("2", &["1", "2"])),
            target: file("1"),
            target_row: Some(present("1", &["1"])),
            target_replaces: None,
        },
        &CarryExclusions::default(),
    );
    assert_eq!(unreadable_source.action, CarryAction::SourceUnreadable);
    assert_eq!(unreadable_source.target_row, RowChange::Untouched);
    assert_eq!(unreadable_source.source_row, RowChange::Untouched);
    let unreadable_target = one(
        "save.dat",
        PathInput {
            source: src(Some("2")),
            source_row: Some(present("2", &["1", "2"])),
            target: TargetCopy::Unreadable,
            target_row: Some(present("1", &["1"])),
            target_replaces: None,
        },
        &CarryExclusions::default(),
    );
    assert_eq!(unreadable_target.action, CarryAction::TargetUnreadable);
    assert_eq!(unreadable_target.target_row, RowChange::Untouched);
    assert_eq!(unreadable_target.source_row, RowChange::Untouched);
    let absent_source = one(
        "save.dat",
        PathInput {
            source: SourceCopy::Absent,
            source_row: Some(present("1", &["1"])),
            target: TargetCopy::Unreadable,
            target_row: Some(present("1", &["1"])),
            target_replaces: None,
        },
        &CarryExclusions::default(),
    );
    assert_eq!(absent_source.action, CarryAction::TargetUnreadable);
    assert_eq!(absent_source.source_row, RowChange::Untouched);
}

#[test]
fn worked_forward_back_forward_cycle() {
    let update = one(
        "settings.ini",
        input(Some("1"), None, TargetCopy::Absent, None),
        &CarryExclusions::default(),
    );
    assert_eq!(update.action, CarryAction::Copy);
    // v2 changes the file to d2; its departing row extends its lineage.
    let rollback = one(
        "settings.ini",
        input(
            Some("2"),
            Some(present("2", &["1", "2"])),
            file("1"),
            Some(present("1", &["1"])),
        ),
        &CarryExclusions::default(),
    );
    assert_eq!(rollback.action, CarryAction::Replace);
    assert_eq!(
        rollback.target_row,
        RowChange::Set(present("2", &["1", "2"]))
    );
    let forward = one(
        "settings.ini",
        input(
            Some("3"),
            Some(present("3", &["1", "2", "3"])),
            file("2"),
            Some(present("2", &["1", "2"])),
        ),
        &CarryExclusions::default(),
    );
    assert_eq!(forward.action, CarryAction::Replace);
    assert_eq!(
        forward.target_row,
        RowChange::Set(present("3", &["1", "2", "3"]))
    );
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
    // Inside plan: a full L_A plus a stays at eight, and L_A ending in a collapses.
    let full = (1..=8).map(|value| value.to_string()).collect::<Vec<_>>();
    let full_refs = full.iter().map(String::as_str).collect::<Vec<_>>();
    let copied = one(
        "x.ini",
        input(
            Some("9"),
            Some(present("8", &full_refs)),
            TargetCopy::Absent,
            None,
        ),
        &CarryExclusions::default(),
    );
    let RowChange::Set(row) = copied.target_row else {
        panic!("copy sets a row");
    };
    assert_eq!(row.lineage.len(), MAX_LINEAGE);
    assert_eq!(row.lineage.last(), Some(&digest("9")));
    let same = one(
        "x.ini",
        input(Some("8"), Some(present("8", &full_refs)), file("8"), None),
        &CarryExclusions::default(),
    );
    let RowChange::Set(row) = same.target_row else {
        panic!("t = a sets a row");
    };
    assert_eq!(
        row.lineage,
        full.iter().map(|value| digest(value)).collect::<Vec<_>>()
    );
    // A stored row whose lineage doesn't end with its bytes is repaired (L5).
    let malformed = CarryRow {
        state: RowState::Present,
        sha256: digest("2"),
        lineage: vec![digest("1")],
    };
    assert_eq!(malformed.checked_lineage(), ["1", "2"].map(digest).to_vec());
}

/// Every exclusion leaves both rows untouched, whatever the input shape.
fn assert_excluded(path: &str, exclusions: &CarryExclusions, expected: Exclusion) {
    let shapes = [
        ("copy", input(Some("1"), None, TargetCopy::Absent, None)),
        (
            "replace",
            input(
                Some("2"),
                Some(present("2", &["1", "2"])),
                file("1"),
                Some(present("1", &["1"])),
            ),
        ),
        (
            "remove",
            input(
                None,
                Some(present("1", &["1"])),
                file("1"),
                Some(present("1", &["1"])),
            ),
        ),
    ];
    for (shape, input) in shapes {
        let planned = one(path, input, exclusions);
        assert_eq!(
            planned.action,
            CarryAction::Excluded(expected),
            "{path} ({shape})"
        );
        assert_eq!(planned.target_row, RowChange::Untouched, "{path} ({shape})");
        assert_eq!(planned.source_row, RowChange::Untouched, "{path} ({shape})");
    }
}

fn eligible(path: &str, exclusions: &CarryExclusions) -> bool {
    !matches!(
        one(
            path,
            input(Some("1"), None, TargetCopy::Absent, None),
            exclusions
        )
        .action,
        CarryAction::Excluded(_)
    )
}

#[test]
fn name_rules_exclude_unsafe_and_portcove_paths() {
    let none = CarryExclusions::default();
    assert!(eligible("settings.ini", &none));
    for invalid in [
        "data/../x.ini",
        "caf\u{e9}.ini",
        "a:b.ini",
        "con.txt",
        "trailing.",
        "space ",
        "a\\b.ini",
    ] {
        assert_excluded(invalid, &none, Exclusion::InvalidPath);
    }
    for short in ["PROGRA~1/x.ini", "SAVE~2.DAT", "a~b~1.txt"] {
        assert_excluded(short, &none, Exclusion::ShortName);
    }
    assert!(eligible("tilde~name.ini", &none));
    for portcove in [
        ".portcove-manifest.json",
        "game.sfc.Portcove-Source.json",
        "sub/.PORTCOVE-launched",
    ] {
        assert_excluded(portcove, &none, Exclusion::PortcoveMetadata);
    }
    for loader in [
        "dxvk.conf",
        "bin/ReShade.ini",
        "portable.txt",
        "Game.exe.config",
        "Engine.DLL.CONFIG",
        "plugins/Engine.dll.config",
    ] {
        assert_excluded(loader, &none, Exclusion::LoaderName);
    }
}

#[test]
fn metadata_names_are_excluded() {
    let exclusions = CarryExclusions {
        generated_metadata: vec!["rom.cfg".into()],
        ..CarryExclusions::default()
    };
    assert_excluded("ROM.cfg", &exclusions, Exclusion::GeneratedMetadata);
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
    // B1: v2 ships the path as a member; A's lineage never removes it.
    let member = CarryExclusions {
        target_members: vec!["settings.ini".into()],
        ..CarryExclusions::default()
    };
    assert_excluded("settings.ini", &member, Exclusion::PackageMember);
    assert_excluded("game.EXE", &exclusions, Exclusion::PackageMember);
    assert_excluded("mods/bundled", &exclusions, Exclusion::PackageMember);
    assert_excluded(
        "mods/bundled/extra.pak",
        &exclusions,
        Exclusion::PackageFolder,
    );
    assert_excluded(
        "MODS/Bundled/extra.pak",
        &exclusions,
        Exclusion::PackageFolder,
    );
    // Only the direct parent counts: a nested folder stays eligible.
    assert!(eligible("mods/bundled/sub/notes.txt", &exclusions));
    assert!(eligible("notes.txt", &exclusions));
    assert_excluded(
        "Resources/app/x.json",
        &exclusions,
        Exclusion::ElectronResources,
    );
}

#[test]
fn declared_paths_and_patterns_freeze_rows() {
    let pattern = PersistentFilePattern {
        prefix: "Slot".into(),
        suffix: ".sav".into(),
        allow_empty_middle: false,
    };
    let exclusions = CarryExclusions {
        declared_paths: vec!["saves".into(), "mods/preloaded/state.toml".into()],
        declared_patterns: vec![(Some("data".into()), pattern)],
        ..CarryExclusions::default()
    };
    assert_excluded(
        "mods/preloaded/state.toml",
        &exclusions,
        Exclusion::Declared,
    );
    assert_excluded("saves/slot1.srm", &exclusions, Exclusion::Declared);
    assert_excluded("Saves", &exclusions, Exclusion::Declared);
    assert_excluded("data/slot04.sav", &exclusions, Exclusion::Declared);
    assert_excluded("Data/SLOT04.SAV", &exclusions, Exclusion::Declared);
    assert!(eligible("data/other.sav", &exclusions));
    assert!(eligible("slot04.sav", &exclusions));
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
            "Data/x.ini".to_owned(),
            input(Some("3"), None, TargetCopy::Absent, None),
        ),
        (
            "data/y.ini".to_owned(),
            input(Some("4"), None, TargetCopy::Absent, None),
        ),
        (
            "notes".to_owned(),
            input(Some("5"), None, TargetCopy::Absent, None),
        ),
        (
            "Notes/inner.txt".to_owned(),
            input(Some("6"), None, TargetCopy::Absent, None),
        ),
        (
            "other.ini".to_owned(),
            input(Some("7"), None, TargetCopy::Blocked, None),
        ),
        (
            "fine.ini".to_owned(),
            input(Some("8"), None, TargetCopy::Absent, None),
        ),
    ]);
    let planned = plan(A, &paths, &CarryExclusions::default(), &|_| false);
    let by_path = planned
        .iter()
        .map(|planned| (planned.path.as_str(), planned.action))
        .collect::<BTreeMap<_, _>>();
    for colliding in [
        "Config.ini",
        "config.ini",
        "Data/x.ini",
        "data/y.ini",
        "notes",
        "Notes/inner.txt",
    ] {
        assert_eq!(
            by_path[colliding],
            CarryAction::Excluded(Exclusion::CaseCollision),
            "{colliding}"
        );
    }
    assert_eq!(
        by_path["other.ini"],
        CarryAction::Excluded(Exclusion::TargetBlocked)
    );
    assert_eq!(by_path["fine.ini"], CarryAction::Copy);
    assert_eq!(written_paths(&planned), BTreeSet::from(["fine.ini"]));
}

#[test]
fn an_interrupted_replacement_re_plans_against_the_displaced_record() {
    // N1: the switch wrote T's row as pending{A, a}, displacing T's present
    // [t_old] row, and was interrupted before publishing. T still holds t_old.
    let pending = pending_from(A, "2");
    let retry = |target: TargetCopy| {
        one(
            "save.dat",
            PathInput {
                source: src(Some("2")),
                source_row: Some(present("2", &["1", "2"])),
                target,
                target_row: Some(pending.clone()),
                target_replaces: Some(present("1", &["0", "1"])),
            },
            &CarryExclusions::default(),
        )
    };
    let replaced = retry(file("1"));
    assert_eq!(replaced.action, CarryAction::Replace);
    assert_eq!(
        replaced.target_row,
        RowChange::Set(present("2", &["1", "2"]))
    );
    // Edited since: keep both, and keep only the bytes now there.
    let kept = retry(file("7"));
    assert_eq!(kept.action, CarryAction::KeepSeparately);
    assert_eq!(kept.target_row, RowChange::Set(present("7", &["7"])));
    // The displaced record keeps its lineage when T is kept unchanged.
    let unrelated = one(
        "save.dat",
        PathInput {
            source: src(Some("5")),
            source_row: None,
            target: file("1"),
            target_row: Some(pending_from("other", "9")),
            target_replaces: Some(present("1", &["0", "1"])),
        },
        &CarryExclusions::default(),
    );
    assert_eq!(unrelated.action, CarryAction::KeepSeparately);
    assert_eq!(
        unrelated.target_row,
        RowChange::Set(present("1", &["0", "1"]))
    );
    // A displaced record is ignored when T's own row is present.
    let own = one(
        "save.dat",
        PathInput {
            source: src(Some("2")),
            source_row: Some(present("2", &["1", "2"])),
            target: file("1"),
            target_row: Some(present("9", &["9"])),
            target_replaces: Some(present("1", &["1"])),
        },
        &CarryExclusions::default(),
    );
    assert_eq!(own.action, CarryAction::KeepSeparately);
}
