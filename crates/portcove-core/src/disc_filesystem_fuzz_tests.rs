//! Bounded synthetic mutation campaign for the read-only disc readers.
use proptest::{
    prelude::*,
    test_runner::{Config, RngAlgorithm, RngSeed, TestRunner},
};

use super::{DiscImage, MAX_IMAGE_BYTES, fixtures::*};
use crate::{DiscImageFormat, Result};

const SEED: u64 = 4959;
const CASES: u32 = 192;

fn corpus() -> Vec<(DiscImageFormat, Vec<u8>)> {
    let tree = || {
        vec![
            file("default.xex", b"XEX2"),
            dir(
                "Media",
                vec![file("a.bin", &vec![5_u8; 3000]), dir("Deep", vec![])],
            ),
        ]
    };
    let directory = tempfile::tempdir().unwrap();
    let mut out = Vec::new();
    for (format, image) in [
        (DiscImageFormat::Xdvdfs, xiso(0, tree())),
        (DiscImageFormat::Iso9660, iso(tree())),
    ] {
        let path = directory.path().join("seed.bin");
        image.write_to(&path);
        out.push((format, std::fs::read(&path).unwrap()));
    }
    out
}

/// Plan and extract `bytes`; everything created must stay under `staging`.
fn run(format: DiscImageFormat, bytes: &[u8]) -> Result<()> {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.bin");
    std::fs::write(&path, bytes).unwrap();
    let staging = directory.path().join("staging");
    let outcome = DiscImage::open(&path, format, MAX_IMAGE_BYTES).and_then(|mut disc| {
        let plan = disc.plan(&|| Ok(()))?;
        disc.extract(&plan, &staging, &|| Ok(()), &|_, _| {})
    });
    let mut names = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    assert!(
        names == ["image.bin"] || names == ["image.bin", "staging"],
        "unexpected output beside the image: {names:?}"
    );
    outcome
}

#[test]
fn random_bytes_never_panic_write_outside_staging_or_succeed() {
    let mut runner = TestRunner::new(Config {
        cases: CASES,
        failure_persistence: None,
        rng_algorithm: RngAlgorithm::ChaCha,
        rng_seed: RngSeed::Fixed(SEED),
        ..Config::default()
    });
    let strategy = (
        prop::sample::select(vec![DiscImageFormat::Xdvdfs, DiscImageFormat::Iso9660]),
        prop::collection::vec(any::<u8>(), 0..70_000),
    );
    runner
        .run(&strategy, |(format, bytes)| {
            prop_assert!(run(format, &bytes).is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn mutated_valid_images_stay_inside_staging() {
    let seeds = corpus();
    let mut runner = TestRunner::new(Config {
        cases: CASES,
        failure_persistence: None,
        rng_algorithm: RngAlgorithm::ChaCha,
        rng_seed: RngSeed::Fixed(SEED),
        ..Config::default()
    });
    let strategy = (
        0..seeds.len(),
        prop::collection::vec((any::<usize>(), any::<u8>()), 0..12),
        any::<bool>(),
        any::<usize>(),
    );
    runner
        .run(&strategy, |(seed, edits, truncate, length)| {
            let (format, original) = &seeds[seed];
            let mut bytes = original.clone();
            for (offset, value) in edits {
                let position = offset % bytes.len();
                bytes[position] = value;
            }
            if truncate {
                bytes.truncate(length % (bytes.len() + 1));
            }
            let _ = run(*format, &bytes);
            Ok(())
        })
        .unwrap();
    // The untouched seeds must themselves be accepted.
    for (format, bytes) in &seeds {
        run(*format, bytes).unwrap();
    }
}
