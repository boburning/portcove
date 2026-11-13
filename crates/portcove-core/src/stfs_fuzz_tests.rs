//! Bounded synthetic mutation campaign for the read-only STFS reader.
use proptest::{
    prelude::*,
    test_runner::{Config, RngAlgorithm, RngSeed, TestRunner},
};

use super::{extract_with_checkpoint, fixtures::*, validate};

const SEED: u64 = 5360;
const CASES: u32 = 192;

fn corpus() -> Vec<Vec<u8>> {
    let tree = || {
        vec![
            file("default.xex", &[0x58; 2 * BLOCK + 9]),
            dir(
                "Media",
                vec![file("a.bin", &[5_u8; 3000]), dir("Deep", vec![])],
            ),
        ]
    };
    let mut contiguous = pirs(tree());
    contiguous.allocation = Allocation::Contiguous;
    vec![live(tree()).bytes(), contiguous.bytes()]
}

/// Validate and extract `bytes`; everything created must stay under `staging`.
fn run(bytes: &[u8]) -> crate::Result<()> {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("package");
    std::fs::write(&path, bytes).unwrap();
    let staging = directory.path().join("staging");
    let validated = validate(&path, &|| Ok(()));
    let extracted = extract_with_checkpoint(&path, &staging, None, &|| Ok(()));
    let mut names = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    assert!(
        names == ["package"] || names == ["package", "staging"],
        "unexpected output beside the package: {names:?}"
    );
    assert_eq!(validated.is_ok(), extracted.is_ok());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    extracted
}

fn runner() -> TestRunner {
    TestRunner::new(Config {
        cases: CASES,
        failure_persistence: None,
        rng_algorithm: RngAlgorithm::ChaCha,
        rng_seed: RngSeed::Fixed(SEED),
        ..Config::default()
    })
}

#[test]
fn random_bytes_never_panic_write_outside_staging_or_succeed() {
    let strategy = (
        prop::sample::select(vec![*b"LIVE", *b"PIRS", *b"CON ", *b"XEX2"]),
        prop::collection::vec(any::<u8>(), 0..70_000),
    );
    runner()
        .run(&strategy, |(magic, mut bytes)| {
            if bytes.len() >= 4 {
                bytes[..4].copy_from_slice(&magic);
            }
            prop_assert!(run(&bytes).is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn mutated_valid_packages_stay_inside_staging_and_never_change_verified_content() {
    let seeds = corpus();
    let strategy = (
        0..seeds.len(),
        prop::collection::vec((any::<usize>(), any::<u8>()), 1..12),
        any::<bool>(),
        any::<usize>(),
    );
    runner()
        .run(&strategy, |(seed, edits, truncate, length)| {
            let original = &seeds[seed];
            let mut bytes = original.clone();
            for (offset, value) in edits {
                let position = offset % bytes.len();
                bytes[position] = value;
            }
            if truncate {
                bytes.truncate(length % (bytes.len() + 1));
            }
            // Any edit inside the hashed region must be refused; edits outside it (the
            // signature, licences and unused padding) may leave the content intact.
            if run(&bytes).is_ok() {
                prop_assert!(unused_region(&bytes, original));
            }
            Ok(())
        })
        .unwrap();
    // The untouched seeds must themselves be accepted.
    for bytes in &seeds {
        run(bytes).unwrap();
    }
}

/// Whether every changed byte at or past the header hash lies in a block the package
/// never reads: zero-filled slack after the last used block or an unused data block.
fn unused_region(bytes: &[u8], original: &[u8]) -> bool {
    let used = used_ranges();
    bytes
        .iter()
        .zip(original)
        .enumerate()
        .filter(|(index, (left, right))| left != right && *index >= 0x32c)
        .all(|(index, _)| {
            !used
                .iter()
                .any(|(start, end)| (*start..*end).contains(&(index as u64)))
        })
}

fn used_ranges() -> Vec<(u64, u64)> {
    // Header, level-0 table and the data blocks the corpus uses (tables and files).
    let mut ranges = vec![
        (0x32c, data_base()),
        (level0_offset(0), level0_offset(0) + 0x1000),
    ];
    for block in 0..6 {
        ranges.push((data_offset(block), data_offset(block) + 0x1000));
    }
    ranges
}
