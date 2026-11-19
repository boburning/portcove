//! Managed PS1 cue sets: every track is kept and only the data track is named
//! like a single-track disc.
use super::*;
use crate::ErrorCode;

const SINGLE: &str = "FILE \"disc01.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n";
const TWO_TRACKS: &str = "FILE \"disc01.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE \"disc02.bin\" BINARY\n  TRACK 02 AUDIO\n    PREGAP 00:02:00\n    INDEX 01 00:00:00\n    POSTGAP 00:00:10\n";

fn track(extracted: &str, runtime: &str) -> PsxTrackFile {
    PsxTrackFile {
        extracted: extracted.into(),
        runtime: runtime.into(),
    }
}

#[test]
fn a_single_track_cue_is_rewritten_exactly_as_before() {
    let (cue, files) = rewrite_psx_cue(SINGLE, 1, 1).unwrap();
    assert_eq!(
        cue,
        "FILE \"disc-01.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n"
    );
    assert_eq!(files, [track("disc01.bin", "disc-01.bin")]);
}

#[test]
fn a_two_track_cue_keeps_the_data_name_and_every_timing_line() {
    let (cue, files) = rewrite_psx_cue(TWO_TRACKS, 2, 2).unwrap();
    assert_eq!(
        cue,
        "FILE \"disc-02.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE \"disc-02-t02.bin\" BINARY\n  TRACK 02 AUDIO\n    PREGAP 00:02:00\n    INDEX 01 00:00:00\n    POSTGAP 00:00:10\n"
    );
    assert_eq!(
        files,
        [
            track("disc01.bin", "disc-02.bin"),
            track("disc02.bin", "disc-02-t02.bin"),
        ]
    );
    // The launch roster still recognises only the numbered cue.
    assert!(is_numbered_psx_cue("disc-02.cue"));
    assert!(!is_numbered_psx_cue("disc-02-t02.bin"));
}

#[test]
fn track_counts_and_file_layout_must_match_the_catalog_exactly() {
    for (body, expected) in [
        // The catalog count differs from the sheet in either direction.
        (SINGLE, 2),
        (TWO_TRACKS, 1),
        // Two tracks in one file, and a file without a track.
        (
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 10:00:00\n",
            2,
        ),
        (
            "FILE \"a.bin\" BINARY\nFILE \"b.bin\" BINARY\n  TRACK 01 MODE2/2352\n  TRACK 02 AUDIO\n",
            2,
        ),
        ("  TRACK 01 MODE2/2352\nFILE \"a.bin\" BINARY\n", 1),
        ("REM no files\n", 0),
    ] {
        let error = rewrite_psx_cue(body, 1, expected).unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceInvalid, "{body}");
    }
}

#[test]
fn unsafe_or_repeated_track_names_are_refused() {
    for name in [
        "../outside.bin",
        "nested/disc.bin",
        "nested\\disc.bin",
        "C:disc.bin",
        "..",
        ".",
        "",
    ] {
        let body = format!("FILE \"{name}\" BINARY\n  TRACK 01 MODE2/2352\n");
        let error = rewrite_psx_cue(&body, 1, 1).unwrap_err();
        assert!(error.message.contains("unsafe FILE path"), "{name}");
    }
    let unquoted = "FILE disc.bin BINARY\n  TRACK 01 MODE2/2352\n";
    assert!(rewrite_psx_cue(unquoted, 1, 1).is_err());
    // Windows names differ only in case, so ASCII case does not separate them.
    for second in ["a.bin", "A.BIN"] {
        let repeated = format!(
            "FILE \"a.bin\" BINARY\n  TRACK 01 MODE2/2352\nFILE \"{second}\" BINARY\n  TRACK 02 AUDIO\n"
        );
        assert!(
            rewrite_psx_cue(&repeated, 1, 2)
                .unwrap_err()
                .message
                .contains("twice"),
            "{second}"
        );
    }
}

fn extracted_disc(root: &Path, cue: &str, files: &[&str]) -> PathBuf {
    let extracted = root.join(".disc-01");
    std::fs::create_dir_all(&extracted).unwrap();
    for name in files {
        std::fs::write(extracted.join(name), name.as_bytes()).unwrap();
    }
    let path = extracted.join("disc.cue");
    std::fs::write(&path, cue).unwrap();
    path
}

#[test]
fn every_track_file_is_staged_beside_its_rewritten_cue() {
    let temporary = tempfile::tempdir().unwrap();
    let staged = temporary.path().join("staged");
    std::fs::create_dir(&staged).unwrap();
    let cue = extracted_disc(temporary.path(), TWO_TRACKS, &["disc01.bin", "disc02.bin"]);
    place_psx_cue_disc(&cue, &staged, 1, 2).unwrap();
    assert_eq!(
        std::fs::read(staged.join("disc-01.bin")).unwrap(),
        b"disc01.bin"
    );
    assert_eq!(
        std::fs::read(staged.join("disc-01-t02.bin")).unwrap(),
        b"disc02.bin"
    );
    let (tracks, data) = inspect_psx_cue(&staged.join("disc-01.cue")).unwrap();
    assert_eq!((tracks, data), (2, staged.join("disc-01.bin")));
    assert_eq!(std::fs::read_dir(&staged).unwrap().count(), 3);
}

#[test]
fn a_missing_track_file_stages_nothing() {
    let temporary = tempfile::tempdir().unwrap();
    let staged = temporary.path().join("staged");
    std::fs::create_dir(&staged).unwrap();
    let cue = extracted_disc(temporary.path(), TWO_TRACKS, &["disc01.bin"]);
    let error = place_psx_cue_disc(&cue, &staged, 1, 2).unwrap_err();
    assert_eq!(error.code, ErrorCode::SourceInvalid);
    assert!(error.message.contains("does not exist"));
    assert_eq!(std::fs::read_dir(&staged).unwrap().count(), 0);
    assert!(cue.with_file_name("disc01.bin").is_file());
}

#[test]
fn audio_track_files_do_not_change_the_launch_disc_roster() {
    let temporary = tempfile::tempdir().unwrap();
    let working = temporary.path();
    let raw_set = working.join("runtime-discs");
    std::fs::create_dir(&raw_set).unwrap();
    for disc in 1..=2 {
        for name in [
            format!("disc-{disc:02}.cue"),
            format!("disc-{disc:02}.bin"),
            format!("disc-{disc:02}-t02.bin"),
        ] {
            std::fs::write(raw_set.join(name), b"track").unwrap();
        }
    }
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog
        .port("alexbeav-alone-in-the-dark-the-new-nightmare-recomp")
        .unwrap();
    assert_eq!(
        managed_psx_materialized_discs(port, working).unwrap(),
        [raw_set.join("disc-01.cue"), raw_set.join("disc-02.cue")]
    );
    // The data track still pairs with its cue.
    std::fs::remove_file(raw_set.join("disc-02.bin")).unwrap();
    assert!(managed_psx_materialized_discs(port, working).is_err());
}
