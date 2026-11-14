//! Bounded seeded mutation campaign for the ROM patch readers.
use proptest::{
    prelude::*,
    test_runner::{Config, RngAlgorithm, RngSeed, TestRunner},
};

use super::{
    MAX_ROM_PATCH_BYTES, apply,
    tests::{Action, bps, ips, ups},
};
use crate::{Result, RomPatchFormat};

const SEED: u64 = 5405;
const CASES: u32 = 256;
const FORMATS: [RomPatchFormat; 3] = [
    RomPatchFormat::Ips,
    RomPatchFormat::Bps,
    RomPatchFormat::Ups,
];

fn original() -> Vec<u8> {
    (0..2048_u32)
        .map(|value| (value * 13 % 241) as u8)
        .collect()
}

fn corpus() -> Vec<(RomPatchFormat, Vec<u8>)> {
    let source = original();
    let mut target = source[..512].to_vec();
    target.extend(b"translated");
    target.extend(&source[600..700]);
    let start = target.len();
    for index in 0..20 {
        target.push(target[start - 4 + index]);
    }
    let mut changed = source.clone();
    changed[7] ^= 0x10;
    changed.extend(b"grown");
    vec![
        (
            RomPatchFormat::Ips,
            ips(&[(4, b"abcd"), (2050, b"z")], &[(100, 40, 3)], None),
        ),
        (
            RomPatchFormat::Bps,
            bps(
                &source,
                &target,
                b"meta",
                &[
                    Action::SourceRead(512),
                    Action::TargetRead(b"translated".to_vec()),
                    Action::SourceCopy(600, 100),
                    Action::TargetCopy((start - 4) as i64, 20),
                ],
            ),
        ),
        (RomPatchFormat::Ups, ups(&source, &changed)),
    ]
}

fn run(format: RomPatchFormat, patch: &[u8]) -> Result<Vec<u8>> {
    apply(format, &original(), patch, &|| Ok(()))
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
fn random_bytes_never_panic_or_apply() {
    let strategy = (
        prop::sample::select(FORMATS.to_vec()),
        prop::collection::vec(any::<u8>(), 0..4096),
    );
    runner()
        .run(&strategy, |(format, bytes)| {
            prop_assert!(run(format, &bytes).is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn mutated_valid_patches_never_panic_and_stay_bounded() {
    let seeds = corpus();
    // The untouched seeds must themselves apply.
    for (format, patch) in &seeds {
        run(*format, patch).unwrap();
    }
    let strategy = (
        0..seeds.len(),
        prop::collection::vec((any::<usize>(), any::<u8>()), 0..12),
        any::<bool>(),
        any::<usize>(),
        // Mostly refit, so the decoders see the mutations; sometimes not, so the
        // patch checksum refusal stays covered.
        prop::bool::weighted(0.85),
    );
    runner()
        .run(&strategy, |(seed, edits, truncate, length, refit)| {
            let (format, original) = &seeds[seed];
            let mut bytes = original.clone();
            for (offset, value) in edits {
                let position = offset % bytes.len();
                bytes[position] = value;
            }
            if truncate {
                bytes.truncate(length % (bytes.len() + 1));
            }
            // Refit the trailing patch CRC32 so BPS and UPS mutations reach the
            // decoders instead of stopping at the patch checksum.
            if *format != RomPatchFormat::Ips && refit && bytes.len() >= 4 {
                let end = bytes.len() - 4;
                let crc = crc32fast::hash(&bytes[..end]);
                bytes[end..].copy_from_slice(&crc.to_le_bytes());
            }
            if let Ok(output) = run(*format, &bytes) {
                prop_assert!(output.len() <= MAX_ROM_PATCH_BYTES);
            }
            Ok(())
        })
        .unwrap();
}
