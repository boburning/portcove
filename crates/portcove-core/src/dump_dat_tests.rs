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

fn dat(body: &str) -> String {
    format!(
        "\u{feff}<?xml version=\"1.0\"?>\n<!DOCTYPE datafile PUBLIC \"-//Logiqx//DTD ROM Management Datafile//EN\" \"http://www.logiqx.com/Dats/datafile.dtd\">\n<datafile>\n<header><name>Nintendo &amp; Friends - Test</name><description>Synthetic</description><version>20261113</version></header>\n{body}</datafile>\n"
    )
}

fn sample() -> String {
    dat(&format!(
        "<game name=\"Example (Europe)\"><description>x</description><rom name=\"Example (Europe).z64\" size=\"4\" sha1=\"{SHA1_EUROPE}\"/></game>\n\
         <machine name=\"Example (USA)\"><rom name=\"Example (USA).z64\" size=\"4\" sha1=\"{}\" sha256=\"{}\"/></machine>\n\
         <game name=\"Disc Game (USA)\"><rom name=\"Disc Game (USA).cue\" size=\"10\" sha1=\"{}\"/><rom name=\"Disc Game (USA) (Track 1).bin\" size=\"8\" sha1=\"{SHA1_TRACK1}\"/><rom name=\"Disc Game (USA) (Track 2).bin\" size=\"9\" sha1=\"{}\"/></game>\n",
        SHA1_USA.to_uppercase(),
        "a".repeat(64),
        "4".repeat(40),
        "5".repeat(40),
    ))
}

#[test]
fn parses_logiqx_header_entries_and_files() {
    let document = parse_dat(sample().as_bytes()).unwrap();
    assert_eq!(document.name, "Nintendo & Friends - Test");
    assert_eq!(document.version.as_deref(), Some("20261113"));
    assert_eq!(document.entries.len(), 3);
    assert_eq!(document.entries[1].name, "Example (USA)");
    let file = &document.entries[1].files[0];
    assert_eq!(file.size, Some(4));
    assert_eq!(
        file.sha1.as_deref(),
        Some(SHA1_USA),
        "digests are lowercased"
    );
    assert_eq!(file.sha256.as_deref(), Some("a".repeat(64).as_str()));
    assert_eq!(document.file_count(), 5);
}

#[test]
fn refuses_entities_malformed_and_unbounded_documents() {
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
        (
            dat("<game name=\"g\"><rom name=\"r\" sha1=\"xyz\"/></game>"),
            "sha1",
        ),
        (
            dat("<game name=\"g\"><rom name=\"r\" size=\"-1\"/></game>"),
            "size",
        ),
        (dat("<game><rom name=\"r\"/></game>"), "name"),
        (
            format!(
                "<datafile><header><name>x</name></header>{}{}</datafile>",
                "<a>".repeat(MAX_XML_DEPTH),
                "</a>".repeat(MAX_XML_DEPTH)
            ),
            "nested",
        ),
        (
            format!("<datafile><header><name>{}</name></header></datafile>", "n".repeat(MAX_TEXT_BYTES + 1)),
            "too long",
        ),
    ];
    for (document, expected) in cases {
        let error = parse_dat(document.as_bytes()).unwrap_err();
        assert!(
            error.message.contains(expected),
            "{document}: {}",
            error.message
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
    assert_eq!((added.entry_count, added.file_count), (3, 5));
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

    let invalid = temporary.path().join("invalid.dat");
    std::fs::write(&invalid, "<datafile>").unwrap();
    assert!(add_dat_reference(&restarted, &invalid).is_err());
    assert_eq!(dat_reference_statuses(&restarted).unwrap().len(), 1);

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

fn digest(algorithm: SourceDigestAlgorithm, value: &str, size: u64) -> ObservedSourceDigest {
    ObservedSourceDigest {
        algorithm,
        scope: DigestScope::OriginalFile,
        value: value.into(),
        size,
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
    let (sha256, size, document) = read_dat(&path).unwrap();
    SavedDatReference {
        id: reference_id(&path),
        path,
        sha256,
        size,
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

    // A PSX disc exposes only its data track, so a multi-track entry stays partial.
    let disc = ObservedSourceComponent {
        id: "disc-1".into(),
        kind: SourceComponentKind::OpticalDisc,
        name: Some("Disc Game.chd".into()),
        digests: vec![ObservedSourceDigest {
            algorithm: SourceDigestAlgorithm::Sha1,
            scope: DigestScope::PsxNormalizedTrackSet,
            value: SHA1_TRACK1.into(),
            size: 8,
        }],
        size: 8,
        track_count: Some(2),
        volume_id: None,
    };
    let partial = identify_with_references(&inspection(Vec::new(), vec![disc]), &references);
    assert_eq!(partial.state_code, "partially_identified");
    assert_eq!(
        partial.summary,
        "1 of 2 files in “Disc Game (USA)” from Nintendo & Friends - Test match the selected files."
    );
    assert_eq!(
        partial.matches[0].matched_files[0].component_id.as_deref(),
        Some("disc-1")
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
fn changed_or_missing_references_are_reported_and_not_used() {
    let temporary = tempfile::tempdir().unwrap();
    let reference = saved_reference(temporary.path());
    std::fs::write(&reference.path, sample().replace("Europe", "Japan")).unwrap();
    let selected = inspection(
        vec![digest(SourceDigestAlgorithm::Sha1, SHA1_EUROPE, 4)],
        Vec::new(),
    );
    let changed = identify_with_references(&selected, std::slice::from_ref(&reference));
    assert_eq!(changed.state_code, "references_unavailable");
    assert!(changed.matches.is_empty());
    assert_eq!(
        changed.unavailable_references[0].state,
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
fn identification_never_changes_the_catalog_assessment() {
    let temporary = tempfile::tempdir().unwrap();
    let preferences = store(temporary.path());
    let catalog = Catalog::embedded().unwrap();
    let profile_id = catalog
        .source_catalog()
        .unwrap()
        .identities
        .first()
        .unwrap()
        .id
        .clone();
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
