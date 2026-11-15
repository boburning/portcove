use super::*;
use crate::{
    Catalog, ObservedSourceComponent, ObservedSourceDigest, SourceAdmission, SourceAssessment,
    SourceClassification, SourceComponentKind, SourceContractResult, SourceHealth,
    SourceRejectionReason,
};
use sha1::Sha1;

const SHA1_EUROPE: &str = "1111111111111111111111111111111111111111";
const SHA1_USA: &str = "2222222222222222222222222222222222222222";
const SHA1_TRACK1: &str = "3333333333333333333333333333333333333333";
const SHA1_SINGLE: &str = "6666666666666666666666666666666666666666";
const SHA1_DISC2: &str = "7777777777777777777777777777777777777777";

fn dat(body: &str) -> String {
    format!(
        "\u{feff}<?xml version=\"1.0\"?>\n<!DOCTYPE datafile PUBLIC \"-//Logiqx//DTD ROM Management Datafile//EN\" \"http://www.logiqx.com/Dats/datafile.dtd\">\n<datafile>\n<header><name>Nintendo &amp; Friends - Test</name><description>Synthetic</description><version>20261113</version></header>\n{body}</datafile>\n"
    )
}

fn sample() -> String {
    dat(&format!(
        "<game name=\"Example (Europe)\"><description>x</description><rom name=\"Example (Europe).z64\" size=\"4\" sha1=\"{SHA1_EUROPE}\"/></game>\n\
         <machine name=\"Example (USA)\"><rom name=\"Example (USA).z64\" size=\"4\" sha1=\"{}\" sha256=\"{}\"/></machine>\n\
         <game name=\"Disc Game (USA)\"><rom name=\"Disc Game (USA).cue\" size=\"10\" sha1=\"{}\"/><rom name=\"Disc Game (USA) (Track 1).bin\" size=\"8\" sha1=\"{SHA1_TRACK1}\"/><rom name=\"Disc Game (USA) (Track 2).bin\" size=\"9\" sha1=\"{}\"/></game>\n\
         <game name=\"Single Track (USA)\"><rom name=\"Single Track (USA).cue\" size=\"10\" sha1=\"{}\"/><rom name=\"Single Track (USA).bin\" size=\"8\" sha1=\"{SHA1_SINGLE}\"/><rom name=\"Single Track (USA).sbi\" size=\"3\" crc=\"01234567\"/></game>\n\
         <game name=\"Multi (USA) (Disc 2)\"><rom name=\"Multi (USA) (Disc 2).bin\" size=\"8\" sha1=\"{SHA1_DISC2}\"/></game>\n\
         <game name=\"No Size (USA)\"><rom name=\"No Size (USA).z64\" sha1=\"{}\"/></game>\n",
        SHA1_USA.to_uppercase(),
        "a".repeat(64),
        "4".repeat(40),
        "5".repeat(40),
        "8".repeat(40),
        "9".repeat(40),
    ))
}

#[test]
fn parses_logiqx_header_entries_and_files() {
    let document = parse_dat(sample().as_bytes()).unwrap();
    assert_eq!(document.name, "Nintendo & Friends - Test");
    assert_eq!(document.version.as_deref(), Some("20261113"));
    assert_eq!(document.entries.len(), 6);
    assert_eq!(document.entries[1].name, "Example (USA)");
    let file = &document.entries[1].files[0];
    assert_eq!(file.size, Some(4));
    assert_eq!(
        file.sha1.as_deref(),
        Some(SHA1_USA),
        "digests are lowercased"
    );
    assert_eq!(file.sha256.as_deref(), Some("a".repeat(64).as_str()));
    assert_eq!(document.file_count(), 10);
}

#[test]
fn sanitizes_names_and_caps_stored_header_text() {
    let document = parse_dat(
        format!(
            "<datafile><header><name>Evil\u{202E}Name&#7;\n\tSuffix</name><version>{}</version></header><game name=\"Bad\u{2066} Entry\u{0007}\"/></datafile>",
            "v".repeat(500)
        )
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(document.name, "EvilName  Suffix");
    assert_eq!(document.version.as_deref().map(str::len), Some(128));
    assert_eq!(document.entries[0].name, "Bad Entry");
}

#[test]
fn refuses_entities_malformed_and_unbounded_documents_with_fixed_messages() {
    let cases = [
        (
            "<!DOCTYPE datafile [<!ENTITY boom \"boom\">]><datafile><header><name>&boom;</name></header></datafile>".to_owned(),
            "entity",
        ),
        (
            "<!DOCTYPE datafile [<!ENTITY ext SYSTEM \"file:///etc/passwd\">]><datafile><header><name>x</name></header><game name=\"&ext;\"/></datafile>".to_owned(),
            "entity",
        ),
        ("<datafile><header><name>x</name></header>".to_owned(), "complete"),
        ("<catalog><header><name>x</name></header></catalog>".to_owned(), "Logiqx"),
        ("<datafile><header></header></datafile>".to_owned(), "name"),
        (dat("<game name=\"g\"><rom name=\"r\" sha1=\"xyz\"/></game>"), "sha1"),
        (dat("<game name=\"g\"><rom name=\"r\" size=\"-1\"/></game>"), "size"),
        (dat("<game><rom name=\"r\"/></game>"), "name"),
        (
            format!(
                "<datafile><header><name>x</name></header>{}{}</datafile>",
                "<a>".repeat(DAT_LIMITS.depth),
                "</a>".repeat(DAT_LIMITS.depth)
            ),
            "nested",
        ),
        (
            format!(
                "<datafile><header><name>{}</name></header></datafile>",
                "n".repeat(DAT_LIMITS.text_bytes + 1)
            ),
            "too long",
        ),
        (
            "<datafile><header><name>x</name></header><game name=\"g\"></SECRET\u{202E}TAG></datafile>"
                .to_owned(),
            "malformed",
        ),
    ];
    for (document, expected) in cases {
        let error = parse_dat(document.as_bytes()).unwrap_err();
        assert!(
            error.message.contains(expected),
            "{document}: {}",
            error.message
        );
        assert!(
            !error.message.contains("SECRET"),
            "document text never reaches errors"
        );
    }
    assert!(
        parse_dat(&[0xff, 0xfe, 0x00])
            .unwrap_err()
            .message
            .contains("UTF-8")
    );
    let oversized = vec![b' '; MAX_DAT_BYTES as usize + 1];
    assert!(
        parse_dat(&oversized)
            .unwrap_err()
            .message
            .contains("64 MiB")
    );
}

#[test]
fn entry_and_file_counts_are_bounded() {
    let limits = DatLimits {
        entries: 2,
        files: 3,
        ..DAT_LIMITS
    };
    let entries = dat("<game name=\"a\"/><game name=\"b\"/><game name=\"c\"/>");
    assert!(
        parse_dat_with_limits(entries.as_bytes(), limits)
            .unwrap_err()
            .message
            .contains("too many entries")
    );
    let files = dat(
        "<game name=\"a\"><rom name=\"1\"/><rom name=\"2\"/></game><game name=\"b\"><rom name=\"3\"/><rom name=\"4\"/></game>",
    );
    assert!(
        parse_dat_with_limits(files.as_bytes(), limits)
            .unwrap_err()
            .message
            .contains("too many files")
    );
}

fn store(directory: &Path) -> HostPreferenceStore {
    HostPreferenceStore::new(directory.join("preferences.json")).unwrap()
}

#[test]
fn references_persist_report_changes_and_never_save_invalid_files() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = store(temporary.path());
    let path = temporary.path().join("example.dat");
    std::fs::write(&path, sample()).unwrap();

    let added = add_dat_reference(&preferences, &path).unwrap();
    assert_eq!(added.state, DatReferenceState::Ready);
    assert_eq!(added.name, "Nintendo & Friends - Test");
    assert_eq!((added.entry_count, added.file_count), (6, 10));
    // Adding the same location again replaces the reference.
    add_dat_reference(&preferences, &path).unwrap();

    let restarted = store(temporary.path());
    let statuses = dat_reference_statuses(&restarted).unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].state, DatReferenceState::Ready);

    std::fs::write(&path, sample().replace("20261113", "20261114")).unwrap();
    assert_eq!(
        dat_reference_statuses(&restarted).unwrap()[0].state,
        DatReferenceState::Changed
    );
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        dat_reference_statuses(&restarted).unwrap()[0].state,
        DatReferenceState::Missing
    );
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        dat_reference_statuses(&restarted).unwrap()[0].state,
        DatReferenceState::Unreadable
    );

    remove_dat_reference(&restarted, &added.id).unwrap();
    assert!(dat_reference_statuses(&restarted).unwrap().is_empty());
    assert_eq!(
        remove_dat_reference(&restarted, &added.id)
            .unwrap_err()
            .code,
        crate::ErrorCode::NotFound
    );
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(temporary.path().join("preferences.json")).unwrap())
            .unwrap();
    assert!(saved.get("dat_references").is_none());
}

#[test]
fn refused_files_save_nothing() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = store(temporary.path());
    let refused = [
        ("malformed.dat", "<datafile>".to_owned()),
        (
            "entity.dat",
            "<!DOCTYPE datafile [<!ENTITY boom \"boom\">]><datafile><header><name>&boom;</name></header></datafile>".to_owned(),
        ),
        ("digest.dat", dat("<game name=\"g\"><rom name=\"r\" sha1=\"xyz\"/></game>")),
    ];
    for (name, contents) in refused {
        let path = temporary.path().join(name);
        std::fs::write(&path, contents).unwrap();
        assert!(add_dat_reference(&preferences, &path).is_err(), "{name}");
    }
    let oversized = temporary.path().join("oversized.dat");
    std::fs::File::create(&oversized)
        .unwrap()
        .set_len(MAX_DAT_BYTES + 1)
        .unwrap();
    assert!(
        add_dat_reference(&preferences, &oversized)
            .unwrap_err()
            .message
            .contains("64 MiB")
    );
    assert!(
        add_dat_reference(&preferences, temporary.path()).is_err(),
        "folders are refused"
    );
    assert!(dat_reference_statuses(&preferences).unwrap().is_empty());
    assert!(!temporary.path().join("preferences.json").exists());
}

#[cfg(unix)]
#[test]
fn links_to_dat_files_are_refused() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = store(temporary.path());
    let target = temporary.path().join("real.dat");
    std::fs::write(&target, sample()).unwrap();
    let link = temporary.path().join("link.dat");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(
        add_dat_reference(&preferences, &link)
            .unwrap_err()
            .message
            .contains("link")
    );
    assert!(dat_reference_statuses(&preferences).unwrap().is_empty());
}

#[test]
fn same_contents_at_a_new_location_replace_the_reference() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = store(temporary.path());
    let first = temporary.path().join("first.dat");
    let moved = temporary.path().join("moved.dat");
    std::fs::write(&first, sample()).unwrap();
    std::fs::write(&moved, sample()).unwrap();
    add_dat_reference(&preferences, &first).unwrap();
    add_dat_reference(&preferences, &moved).unwrap();
    let statuses = dat_reference_statuses(&preferences).unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].path, moved);
}

#[test]
fn reference_count_is_bounded() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = store(temporary.path());
    for index in 0..=MAX_DAT_REFERENCES {
        let path = temporary.path().join(format!("{index}.dat"));
        std::fs::write(&path, sample().replace("20261113", &index.to_string())).unwrap();
        let result = add_dat_reference(&preferences, &path);
        assert_eq!(result.is_ok(), index < MAX_DAT_REFERENCES, "{index}");
    }
}

#[test]
fn over_limit_saved_entries_are_ignored_and_still_removable() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = store(temporary.path());
    let path = temporary.path().join("example.dat");
    std::fs::write(&path, sample()).unwrap();
    let valid = |index: usize| {
        serde_json::json!({
            "id": format!("{index:016x}"), "path": path, "sha256": "f".repeat(64), "size": 1,
            "name": "Example", "entry_count": 1, "file_count": 1
        })
    };
    let mut entries: Vec<_> = (0..MAX_DAT_REFERENCES + 1).map(valid).collect();
    let mut long = valid(99);
    long["path"] = serde_json::json!(path.join("x".repeat(MAX_STORED_PATH_BYTES)));
    entries.insert(0, long);
    std::fs::write(
        temporary.path().join("preferences.json"),
        serde_json::to_vec(&serde_json::json!({
            "format_version": 1, "library_root": null, "dat_references": entries
        }))
        .unwrap(),
    )
    .unwrap();

    let listed = dat_reference_statuses(&preferences).unwrap();
    assert_eq!(
        listed.len(),
        MAX_DAT_REFERENCES,
        "invalid and extra entries are ignored"
    );
    assert!(
        add_dat_reference(&preferences, &path).is_err(),
        "the limit still applies"
    );
    for id in [99_usize, 0, 1] {
        remove_dat_reference(&preferences, &format!("{id:016x}")).unwrap();
    }
    assert_eq!(
        add_dat_reference(&preferences, &path).unwrap().state,
        DatReferenceState::Ready
    );
}

#[test]
fn worst_case_references_leave_most_of_the_preference_budget() {
    // Backslashes double when JSON-escaped; four-byte characters fill the text caps.
    let temporary = std::env::temp_dir();
    let root = temporary.to_str().unwrap();
    let path = PathBuf::from(format!(
        "{root}{}",
        "\\".repeat(MAX_STORED_PATH_BYTES - root.len())
    ));
    let text = "\u{1F3AE}".repeat(MAX_STORED_TEXT_BYTES / 4);
    let references: Vec<_> = (0..MAX_DAT_REFERENCES)
        .map(|index| SavedDatReference {
            id: format!("{index:016x}"),
            path: path.clone(),
            sha256: "f".repeat(64),
            size: u64::MAX,
            name: text.clone(),
            version: Some(text.clone()),
            entry_count: u64::MAX,
            file_count: u64::MAX,
        })
        .collect();
    for reference in &references {
        reference.validate().unwrap();
    }
    let mut document = serde_json::Map::new();
    document.insert(
        "dat_references".into(),
        serde_json::to_value(&references).unwrap(),
    );
    let bytes = serde_json::to_vec_pretty(&document).unwrap();
    assert!(
        bytes.len() < 20 * 1024,
        "{} bytes of the 64 KiB budget",
        bytes.len()
    );
}

fn digest(algorithm: SourceDigestAlgorithm, value: &str, size: u64) -> ObservedSourceDigest {
    ObservedSourceDigest {
        algorithm,
        scope: DigestScope::OriginalFile,
        value: value.into(),
        size,
    }
}

fn disc(id: &str, sha1: &str, track_count: u32) -> ObservedSourceComponent {
    ObservedSourceComponent {
        id: id.into(),
        kind: SourceComponentKind::OpticalDisc,
        name: Some(format!("{id}.chd")),
        digests: vec![ObservedSourceDigest {
            algorithm: SourceDigestAlgorithm::Sha1,
            scope: DigestScope::DiscSetMember,
            value: sha1.into(),
            size: 8,
        }],
        size: 8,
        track_count: Some(track_count),
        volume_id: None,
    }
}

fn inspection(
    digests: Vec<ObservedSourceDigest>,
    components: Vec<ObservedSourceComponent>,
) -> SourceInspection {
    SourceInspection {
        profile_id: "example".into(),
        path: PathBuf::from("selected.z64"),
        observed_digests: digests,
        archive_member_name: None,
        components,
        validator: None,
        assessment: SourceAssessment {
            health: SourceHealth::NotBaselined,
            classification: SourceClassification::Unrecognized,
            contract: SourceContractResult::NotEvaluated,
            admission: SourceAdmission::Rejected {
                reason: SourceRejectionReason::KnownMismatch,
            },
            evidence: Vec::new(),
        },
        record: None,
        message: "not a supported variant".into(),
        integrity_advisories: Vec::new(),
    }
}

fn saved_reference(directory: &Path) -> SavedDatReference {
    let path = directory.join("example.dat");
    std::fs::write(&path, sample()).unwrap();
    let (sha256, bytes) = read_fingerprinted(&path).unwrap();
    let document = parse_dat(&bytes).unwrap();
    SavedDatReference {
        id: reference_id(&path),
        path,
        sha256,
        size: bytes.len() as u64,
        name: document.name.clone(),
        version: document.version.clone(),
        entry_count: document.entries.len() as u64,
        file_count: document.file_count(),
    }
}

#[test]
fn identifies_complete_partial_and_unlisted_selections() {
    let temporary = tempfile::tempdir().unwrap();
    let references = [saved_reference(temporary.path())];

    let complete = identify_with_references(
        &inspection(
            vec![digest(SourceDigestAlgorithm::Sha1, SHA1_EUROPE, 4)],
            Vec::new(),
        ),
        &references,
    );
    assert_eq!(complete.state_code, "identified");
    assert_eq!(
        complete.summary,
        "Matches “Example (Europe)” in Nintendo & Friends - Test."
    );
    assert_eq!(complete.matches[0].entry_file_count, 1);
    assert_eq!(
        complete.matches[0].matched_files[0].scope,
        DigestScope::OriginalFile
    );
    assert_eq!(complete.limitation, IDENTIFICATION_LIMITATION);

    let by_sha256 = identify_with_references(
        &inspection(
            vec![digest(SourceDigestAlgorithm::Sha256, &"A".repeat(64), 4)],
            Vec::new(),
        ),
        &references,
    );
    assert_eq!(by_sha256.matches[0].entry_name, "Example (USA)");

    let wrong_size = identify_with_references(
        &inspection(
            vec![digest(SourceDigestAlgorithm::Sha1, SHA1_EUROPE, 5)],
            Vec::new(),
        ),
        &references,
    );
    assert_eq!(wrong_size.state_code, "not_listed");

    let no_size = identify_with_references(
        &inspection(
            vec![digest(SourceDigestAlgorithm::Sha1, &"9".repeat(40), 4)],
            Vec::new(),
        ),
        &references,
    );
    assert_eq!(
        no_size.state_code, "not_listed",
        "a DAT file without a size can't match"
    );

    // A single PSX disc is inspected as both the selection's own digest and a
    // disc component, both covering only the data track, so a multi-track
    // entry stays partial and says so.
    let mut track = disc("disc-1", SHA1_TRACK1, 2);
    track.digests[0].scope = DigestScope::PsxNormalizedTrackSet;
    let top_level = ObservedSourceDigest {
        scope: DigestScope::PsxNormalizedTrackSet,
        ..digest(SourceDigestAlgorithm::Sha1, SHA1_TRACK1, 8)
    };
    let partial = identify_with_references(&inspection(vec![top_level], vec![track]), &references);
    assert_eq!(partial.state_code, "partially_identified");
    assert_eq!(
        partial.summary,
        "1 of 2 files in “Disc Game (USA)” from Nintendo & Friends - Test match the selected files. Only the disc’s data track was checked."
    );
    assert_eq!(
        partial.matches[0].matched_files[0].scope,
        DigestScope::PsxNormalizedTrackSet
    );

    let container_only = identify_with_references(
        &inspection(
            vec![ObservedSourceDigest {
                scope: DigestScope::OriginalContainer,
                ..digest(SourceDigestAlgorithm::Sha1, SHA1_EUROPE, 4)
            }],
            Vec::new(),
        ),
        &references,
    );
    assert_eq!(container_only.state_code, "not_checked");
}

#[test]
fn cue_and_crc_only_files_do_not_block_a_complete_disc_match() {
    let temporary = tempfile::tempdir().unwrap();
    let references = [saved_reference(temporary.path())];
    let single = identify_with_references(
        &inspection(Vec::new(), vec![disc("disc-1", SHA1_SINGLE, 1)]),
        &references,
    );
    assert_eq!(single.state_code, "identified");
    assert_eq!(single.matches[0].entry_name, "Single Track (USA)");
    assert_eq!(single.matches[0].entry_file_count, 1);
}

#[test]
fn each_disc_of_a_set_is_named() {
    let temporary = tempfile::tempdir().unwrap();
    let references = [saved_reference(temporary.path())];
    let set = identify_with_references(
        &inspection(
            Vec::new(),
            vec![
                disc("disc-1", SHA1_SINGLE, 1),
                disc("disc-2", SHA1_DISC2, 1),
            ],
        ),
        &references,
    );
    assert_eq!(set.match_count, 2);
    assert!(set.summary.ends_with("It also matches 1 other DAT entry."));
    let mut names: Vec<_> = set
        .matches
        .iter()
        .map(|found| {
            (
                found.entry_name.as_str(),
                found.matched_files[0].component_id.as_deref(),
            )
        })
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            ("Multi (USA) (Disc 2)", Some("disc-2")),
            ("Single Track (USA)", Some("disc-1"))
        ]
    );
}

#[test]
fn changed_missing_and_unparseable_references_are_reported_and_not_used() {
    let temporary = tempfile::tempdir().unwrap();
    let reference = saved_reference(temporary.path());
    let selected = inspection(
        vec![digest(SourceDigestAlgorithm::Sha1, SHA1_EUROPE, 4)],
        Vec::new(),
    );

    std::fs::write(&reference.path, sample().replace("Europe", "Japan")).unwrap();
    let changed = identify_with_references(&selected, std::slice::from_ref(&reference));
    assert_eq!(changed.state_code, "references_unavailable");
    assert!(changed.matches.is_empty());
    assert_eq!(
        changed.unavailable_references[0].state,
        DatReferenceState::Changed
    );

    // A changed file that no longer parses is still reported as changed.
    std::fs::write(&reference.path, "<not xml").unwrap();
    let broken = identify_with_references(&selected, std::slice::from_ref(&reference));
    assert_eq!(
        broken.unavailable_references[0].state,
        DatReferenceState::Changed
    );

    std::fs::remove_file(&reference.path).unwrap();
    let missing = identify_with_references(&selected, std::slice::from_ref(&reference));
    assert_eq!(
        missing.unavailable_references[0].state,
        DatReferenceState::Missing
    );
}

#[test]
fn unreadable_preferences_never_decorate_a_report() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = store(temporary.path());
    std::fs::write(temporary.path().join("preferences.json"), "{not json").unwrap();
    let catalog = Catalog::embedded().unwrap();
    let mut selected = inspection(
        vec![digest(SourceDigestAlgorithm::Sha1, SHA1_EUROPE, 4)],
        Vec::new(),
    );
    selected.profile_id = catalog.source_catalog().unwrap().identities[0].id.clone();
    let mut report = crate::source_report::available_report(&catalog, None, selected).unwrap();
    identify_source_report(&preferences, &mut report);
    assert!(report.dump_identification.is_none());
}

#[test]
fn identification_never_changes_the_catalog_assessment() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = store(temporary.path());
    let catalog = Catalog::embedded().unwrap();
    let profile_id = catalog.source_catalog().unwrap().identities[0].id.clone();
    let bytes = b"not a pinned dump";
    let sha1 = hex::encode(Sha1::digest(bytes));
    let mut selected = inspection(
        vec![digest(
            SourceDigestAlgorithm::Sha1,
            &sha1,
            bytes.len() as u64,
        )],
        Vec::new(),
    );
    selected.profile_id = profile_id;
    let mut report = crate::source_report::available_report(&catalog, None, selected).unwrap();
    let before = serde_json::to_value(&report).unwrap();

    identify_source_report(&preferences, &mut report);
    assert!(report.dump_identification.is_none(), "no saved DAT files");
    assert_eq!(serde_json::to_value(&report).unwrap(), before);

    let path = temporary.path().join("listed.dat");
    std::fs::write(
        &path,
        dat(&format!(
            "<game name=\"Listed (Europe)\"><rom name=\"Listed.z64\" size=\"{}\" sha1=\"{sha1}\"/></game>",
            bytes.len()
        )),
    )
    .unwrap();
    add_dat_reference(&preferences, &path).unwrap();
    identify_source_report(&preferences, &mut report);
    let identification = report.dump_identification.take().unwrap();
    assert_eq!(identification.state_code, "identified");
    assert_eq!(identification.matches[0].entry_name, "Listed (Europe)");
    assert_eq!(
        serde_json::to_value(&report).unwrap(),
        before,
        "assessment, record and state stay catalog-owned"
    );
    let inspection = report.inspection.unwrap();
    assert!(inspection.record.is_none());
    assert!(matches!(
        inspection.assessment.admission,
        SourceAdmission::Rejected { .. }
    ));
}
