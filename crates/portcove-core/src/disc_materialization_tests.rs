//! Transactional behavior of the disc-image materializations.
use std::{cell::RefCell, collections::BTreeMap, path::Path};

use sha2::{Digest, Sha256};

use super::*;
use crate::{
    DiscImageFormat, DiscImageProfile, ErrorCode,
    disc_filesystem::fixtures::{Item, dir, file, iso, xex, xiso},
};

const TITLE: u32 = 0x4D53_07E6;

fn profile(codes: &[&str]) -> DiscImageProfile {
    DiscImageProfile {
        format: DiscImageFormat::Xdvdfs,
        max_image_bytes: 1024 * 1024 * 1024,
        product_codes: codes.iter().map(|code| (*code).to_owned()).collect(),
    }
}

fn tree(body: &[u8]) -> Vec<Item> {
    vec![
        file("default.xex", &xex(TITLE)),
        dir("Media", vec![file("b.txt", body)]),
    ]
}

fn anchors() -> BTreeMap<String, String> {
    BTreeMap::from([(
        "default.xex".to_owned(),
        hex::encode(Sha256::digest(xex(TITLE))),
    )])
}

fn phases() -> RefCell<Vec<(DiscUnpackPhase, u64, Option<u64>)>> {
    RefCell::new(Vec::new())
}

fn unpack(
    source: &Path,
    destination: &Path,
    image: &DiscImageProfile,
    required: &BTreeMap<String, String>,
    events: &RefCell<Vec<(DiscUnpackPhase, u64, Option<u64>)>>,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let report = |phase, done, total| events.borrow_mut().push((phase, done, total));
    prepare_disc_runtime_source(
        source,
        destination,
        RuntimeSourceMaterialization::XdvdfsDirectory,
        required,
        None,
        &DiscUnpack {
            profile: image,
            report: &report,
        },
        checkpoint,
    )
}

fn staging_left(directory: &Path) -> bool {
    std::fs::read_dir(directory).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".portcove-disc-")
    })
}

#[test]
fn unpacks_once_reports_phases_and_reuses_only_an_unchanged_source() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("game.iso");
    xiso(0, tree(b"one")).write_to(&source);
    let destination = temporary.path().join("assets");
    let marker = runtime_source_marker_path(&destination).unwrap();
    let image = profile(&["4d5307e6"]);
    let events = phases();

    unpack(&source, &destination, &image, &anchors(), &events, &|| {
        Ok(())
    })
    .unwrap();
    assert_eq!(
        std::fs::read(destination.join("Media/b.txt")).unwrap(),
        b"one"
    );
    assert!(marker.is_file());
    let order: Vec<_> =
        events
            .borrow()
            .iter()
            .map(|(phase, _, _)| *phase)
            .fold(Vec::new(), |mut seen, phase| {
                if seen.last() != Some(&phase) {
                    seen.push(phase);
                }
                seen
            });
    assert_eq!(
        order,
        [
            DiscUnpackPhase::Identify,
            DiscUnpackPhase::Plan,
            DiscUnpackPhase::FreeSpace,
            DiscUnpackPhase::Extract,
            DiscUnpackPhase::Verify,
            DiscUnpackPhase::Activate,
        ]
    );
    let bytes = events
        .borrow()
        .iter()
        .filter(|(phase, _, total)| *phase == DiscUnpackPhase::Extract && total.is_some())
        .map(|(_, done, total)| (*done, total.unwrap()))
        .next_back()
        .unwrap();
    assert_eq!(bytes.0, bytes.1);

    // Unchanged source and marker: nothing is unpacked again.
    events.borrow_mut().clear();
    let marker_before = std::fs::read(&marker).unwrap();
    unpack(&source, &destination, &image, &anchors(), &events, &|| {
        Ok(())
    })
    .unwrap();
    assert!(events.borrow().is_empty());
    assert_eq!(std::fs::read(&marker).unwrap(), marker_before);

    // A changed destination anchor is re-extracted, never reused by size.
    let anchor = destination.join("default.xex");
    let original = std::fs::read(&anchor).unwrap();
    let mut tampered = original.clone();
    tampered[0] ^= 1;
    std::fs::write(&anchor, &tampered).unwrap();
    unpack(&source, &destination, &image, &anchors(), &events, &|| {
        Ok(())
    })
    .unwrap();
    assert_eq!(std::fs::read(&anchor).unwrap(), original);

    // A changed source re-extracts.
    xiso(0, tree(b"two")).write_to(&source);
    events.borrow_mut().clear();
    unpack(&source, &destination, &image, &anchors(), &events, &|| {
        Ok(())
    })
    .unwrap();
    assert_eq!(
        std::fs::read(destination.join("Media/b.txt")).unwrap(),
        b"two"
    );
    assert!(!events.borrow().is_empty());
    assert!(!staging_left(temporary.path()));
}

fn previous_runtime(destination: &Path) -> std::path::PathBuf {
    std::fs::create_dir(destination).unwrap();
    std::fs::write(destination.join("previous.bin"), b"previous").unwrap();
    let marker = runtime_source_marker_path(destination).unwrap();
    std::fs::write(&marker, b"previous marker").unwrap();
    marker
}

fn assert_previous_intact(temporary: &Path, destination: &Path, marker: &Path) {
    assert_eq!(std::fs::read(marker).unwrap(), b"previous marker");
    assert_eq!(
        std::fs::read(destination.join("previous.bin")).unwrap(),
        b"previous"
    );
    assert_eq!(std::fs::read_dir(destination).unwrap().count(), 1);
    assert!(!staging_left(temporary));
}

#[test]
fn a_wrong_game_is_refused_before_anything_is_written() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("game.iso");
    xiso(0, tree(b"one")).write_to(&source);
    let destination = temporary.path().join("assets");
    let marker = previous_runtime(&destination);
    let events = phases();

    let error = unpack(
        &source,
        &destination,
        &profile(&["DEADBEEF"]),
        &anchors(),
        &events,
        &|| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert_eq!(error.details["found"], "4D5307E6");
    assert!(
        events
            .borrow()
            .iter()
            .all(|(phase, _, _)| *phase == DiscUnpackPhase::Identify)
    );
    assert_previous_intact(temporary.path(), &destination, &marker);
}

#[test]
fn hostile_images_and_anchor_mismatches_leave_the_previous_runtime_intact() {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("assets");
    let marker = previous_runtime(&destination);
    let events = phases();
    let image = profile(&["4D5307E6"]);

    let collision = temporary.path().join("collision.iso");
    xiso(
        0,
        vec![
            file("default.xex", &xex(TITLE)),
            file("A.BIN", b"1"),
            file("a.bin", b"2"),
        ],
    )
    .write_to(&collision);
    let error = unpack(
        &collision,
        &destination,
        &image,
        &anchors(),
        &events,
        &|| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SourceInvalid);
    assert_previous_intact(temporary.path(), &destination, &marker);

    let source = temporary.path().join("game.iso");
    xiso(0, tree(b"one")).write_to(&source);
    let wrong_anchor = BTreeMap::from([("default.xex".to_owned(), "0".repeat(64))]);
    let error = unpack(
        &source,
        &destination,
        &image,
        &wrong_anchor,
        &events,
        &|| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert_previous_intact(temporary.path(), &destination, &marker);

    let missing_anchor = BTreeMap::from([("missing.xex".to_owned(), "0".repeat(64))]);
    unpack(
        &source,
        &destination,
        &image,
        &missing_anchor,
        &events,
        &|| Ok(()),
    )
    .unwrap_err();
    assert_previous_intact(temporary.path(), &destination, &marker);

    // Disc unpacking requires at least one anchor and a matching declaration.
    unpack(
        &source,
        &destination,
        &image,
        &BTreeMap::new(),
        &events,
        &|| Ok(()),
    )
    .unwrap_err();
    let mut other = image.clone();
    other.format = DiscImageFormat::Iso9660;
    unpack(&source, &destination, &other, &anchors(), &events, &|| {
        Ok(())
    })
    .unwrap_err();
    assert_previous_intact(temporary.path(), &destination, &marker);
}

#[test]
fn cancellation_at_every_checkpoint_never_succeeds_or_leaves_staging() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("game.iso");
    xiso(0, tree(b"one")).write_to(&source);
    let destination = temporary.path().join("assets");
    let image = profile(&["4D5307E6"]);
    let events = phases();

    let counter = std::cell::Cell::new(0_usize);
    let reference = temporary.path().join("reference");
    unpack(&source, &reference, &image, &anchors(), &events, &|| {
        counter.set(counter.get() + 1);
        Ok(())
    })
    .unwrap();
    let total = counter.get();
    assert!(total > 10, "{total} checkpoints");

    for stop_at in 1..=total {
        let marker = previous_runtime(&destination);
        let calls = std::cell::Cell::new(0_usize);
        let error = unpack(&source, &destination, &image, &anchors(), &events, &|| {
            calls.set(calls.get() + 1);
            if calls.get() == stop_at {
                Err(PortcoveError::new(ErrorCode::Cancelled, "cancelled"))
            } else {
                Ok(())
            }
        })
        .expect_err(&format!("cancelled at {stop_at}/{total}"));
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(!staging_left(temporary.path()), "staging after {stop_at}");
        // Either the whole previous runtime, or the whole new tree: never a mix.
        let previous = destination.join("previous.bin").is_file();
        if previous {
            assert_previous_intact(temporary.path(), &destination, &marker);
        } else {
            assert_eq!(
                std::fs::read(destination.join("Media/b.txt")).unwrap(),
                b"one"
            );
            assert_eq!(
                std::fs::read(destination.join("default.xex")).unwrap(),
                xex(TITLE)
            );
        }
        // A later uninterrupted run always succeeds from any interruption point.
        unpack(&source, &destination, &image, &anchors(), &events, &|| {
            Ok(())
        })
        .unwrap();
        assert_eq!(
            std::fs::read(destination.join("Media/b.txt")).unwrap(),
            b"one"
        );
        std::fs::remove_dir_all(&destination).unwrap();
        std::fs::remove_file(runtime_source_marker_path(&destination).unwrap()).unwrap();
    }
}

#[test]
fn iso9660_directory_unpacks_ps2_style_images_and_refuses_chd_for_xbox() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("game.iso");
    iso(vec![
        file("SYSTEM.CNF", b"BOOT2 = cdrom0:\\SLUS_200.62;1\r\n"),
        file("SLUS_200.62", b"elf"),
    ])
    .write_to(&source);
    let destination = temporary.path().join("assets");
    let required = BTreeMap::from([(
        "SYSTEM.CNF".to_owned(),
        hex::encode(Sha256::digest(b"BOOT2 = cdrom0:\\SLUS_200.62;1\r\n")),
    )]);
    let image = DiscImageProfile {
        format: DiscImageFormat::Iso9660,
        max_image_bytes: 1024 * 1024,
        product_codes: vec!["SLUS-20062".into()],
    };
    let report = |_, _, _| {};
    let unpack_iso = |image: &DiscImageProfile, source: &Path| {
        prepare_disc_runtime_source(
            source,
            &destination,
            RuntimeSourceMaterialization::Iso9660Directory,
            &required,
            None,
            &DiscUnpack {
                profile: image,
                report: &report,
            },
            &|| Ok(()),
        )
    };
    unpack_iso(&image, &source).unwrap();
    assert_eq!(
        std::fs::read(destination.join("SLUS_200.62")).unwrap(),
        b"elf"
    );

    let wrong = DiscImageProfile {
        product_codes: vec!["SLES-50330".into()],
        ..image.clone()
    };
    std::fs::remove_dir_all(&destination).unwrap();
    std::fs::remove_file(runtime_source_marker_path(&destination).unwrap()).unwrap();
    assert_eq!(
        unpack_iso(&wrong, &source).unwrap_err().code,
        ErrorCode::Verification
    );

    let chd = temporary.path().join("xbox.chd");
    std::fs::write(&chd, b"chd").unwrap();
    let events = phases();
    let error = unpack(
        &chd,
        &temporary.path().join("assets2"),
        &profile(&["4D5307E6"]),
        &anchors(),
        &events,
        &|| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SourceInvalid);
    assert!(!staging_left(temporary.path()));
}

#[test]
fn legacy_callers_cannot_unpack_without_a_declared_disc_profile() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("game.iso");
    xiso(0, tree(b"one")).write_to(&source);
    let destination = temporary.path().join("assets");
    let error = prepare_runtime_source(
        &source,
        &destination,
        RuntimeSourceMaterialization::XdvdfsDirectory,
        &anchors(),
        &|| Ok(()),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Usage);
    assert!(!destination.exists());
}
