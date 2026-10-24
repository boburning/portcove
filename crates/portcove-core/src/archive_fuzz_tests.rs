//! Opt-in synthetic mutation campaign for the raw, memory-only TAR boundary.
use std::{cell::Cell, io::Read};

use proptest::{
    prelude::*,
    test_runner::{Config, RngAlgorithm, RngSeed, TestRunner},
};

use super::{CheckpointReader, preflight_raw_tar};

const INPUT_LIMIT: usize = 128 * 1024;
const CHECKPOINT_LIMIT: usize = 1024;
const SEED: u64 = 242047;

struct Seed {
    name: &'static str,
    bytes: Vec<u8>,
    accepted: bool,
    header_only_refusal: Option<&'static str>,
}

fn member(kind: u8, declared: u64, body: &[u8]) -> Vec<u8> {
    let mut header = tar::Header::new_gnu();
    header.set_path("synthetic.bin").unwrap();
    header.set_mode(0o644);
    header.set_size(declared);
    header.set_entry_type(tar::EntryType::new(kind));
    header.set_cksum();
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend_from_slice(body);
    if !body.is_empty() || declared == 0 {
        bytes.resize(bytes.len().div_ceil(512) * 512 + 1024, 0);
    }
    assert!(bytes.len() <= INPUT_LIMIT);
    bytes
}

fn corpus() -> Vec<Seed> {
    let valid = member(b'0', 3, b"abc");
    let mut bad_checksum = valid.clone();
    bad_checksum[0] ^= 1;
    vec![
        Seed {
            name: "empty raw stream",
            bytes: vec![],
            accepted: true,
            header_only_refusal: None,
        },
        Seed {
            name: "ordinary member",
            bytes: valid.clone(),
            accepted: true,
            header_only_refusal: None,
        },
        Seed {
            name: "truncated header",
            bytes: valid[..511].to_vec(),
            accepted: false,
            header_only_refusal: None,
        },
        Seed {
            name: "bad checksum",
            bytes: bad_checksum,
            accepted: false,
            header_only_refusal: Some("checksum"),
        },
        Seed {
            name: "exact raw metadata bound",
            bytes: member(b'L', 65536, &vec![b'a'; 65536]),
            accepted: true,
            header_only_refusal: None,
        },
        Seed {
            name: "oversized extension declaration",
            bytes: member(b'x', 65537, &[]),
            accepted: false,
            header_only_refusal: Some("TAR extension metadata exceeds its size limit"),
        },
        Seed {
            name: "oversized file declaration",
            bytes: member(b'0', 1 << 40, &[]),
            accepted: false,
            header_only_refusal: Some("archive entry exceeds its size limit"),
        },
        Seed {
            name: "unsupported long link",
            bytes: member(b'K', 1 << 40, &[]),
            accepted: false,
            header_only_refusal: Some("TAR links and special files are not allowed"),
        },
    ]
}

struct Chunked<'a> {
    remaining: &'a [u8],
    chunk: usize,
    bytes: usize,
    body_read_attempts: usize,
}

impl Read for Chunked<'_> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if self.bytes >= 512 && !output.is_empty() {
            self.body_read_attempts += 1;
        }
        let length = output.len().min(self.chunk).min(self.remaining.len());
        output[..length].copy_from_slice(&self.remaining[..length]);
        self.remaining = &self.remaining[length..];
        self.bytes += length;
        Ok(length)
    }
}

struct Inspection {
    error: Option<String>,
    bytes: usize,
    body_read_attempts: usize,
}

fn inspect(bytes: &[u8], chunk: usize) -> Inspection {
    assert!(bytes.len() <= INPUT_LIMIT);
    let checkpoints = Cell::new(0);
    let checkpoint = || {
        checkpoints.set(checkpoints.get() + 1);
        if checkpoints.get() > CHECKPOINT_LIMIT {
            return Err(crate::PortcoveError::source(
                "bounded parser campaign checkpoint limit",
            ));
        }
        Ok(())
    };
    let mut input = Chunked {
        remaining: bytes,
        chunk,
        bytes: 0,
        body_read_attempts: 0,
    };
    let reader = CheckpointReader::new(&mut input, INPUT_LIMIT as u64, &checkpoint);
    let error = preflight_raw_tar(reader, bytes.len() as u64, &checkpoint)
        .err()
        .map(|error| error.message);
    assert!(input.bytes <= bytes.len());
    // The reader refusal and its outer error mapping each recheck cancellation.
    assert!(checkpoints.get() <= CHECKPOINT_LIMIT + 2);
    Inspection {
        error,
        bytes: input.bytes,
        body_read_attempts: input.body_read_attempts,
    }
}

fn repair_first_checksum(bytes: &mut [u8]) {
    if bytes.len() < 512 {
        return;
    }
    bytes[148..156].fill(b' ');
    let sum: u32 = bytes[..512].iter().map(|byte| u32::from(*byte)).sum();
    bytes[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
}

#[test]
#[ignore = "opt-in bounded raw TAR mutation campaign; see quality-operations.md"]
fn bounded_raw_tar_mutation_campaign() {
    let seeds = corpus();
    assert!(seeds.iter().map(|seed| seed.bytes.len()).sum::<usize>() <= INPUT_LIMIT);
    for seed in &seeds {
        let result = inspect(&seed.bytes, 4096);
        println!(
            "Raw TAR seed {}: error={:?}; bytes={}; post-header-read-attempts={}",
            seed.name, result.error, result.bytes, result.body_read_attempts
        );
        assert_eq!(result.error.is_none(), seed.accepted, "seed {}", seed.name);
        if let Some(expected) = seed.header_only_refusal {
            assert!(
                result
                    .error
                    .as_deref()
                    .is_some_and(|error| error.contains(expected)),
                "{} must reach its actual refusal: {:?}",
                seed.name,
                result.error
            );
            assert!(result.bytes <= 512, "{} read a declared body", seed.name);
            assert_eq!(
                result.body_read_attempts, 0,
                "{} attempted to read a declared body",
                seed.name
            );
        }
    }
    let strategy = (
        0..seeds.len(),
        prop::collection::vec((0..INPUT_LIMIT, any::<u8>()), 0..17),
        any::<bool>(),
        0..INPUT_LIMIT,
        prop::sample::select(vec![1_usize, 7, 512, 4096]),
        any::<bool>(),
    );
    let mut runner = TestRunner::new(Config {
        cases: 256,
        max_shrink_iters: 512,
        failure_persistence: None,
        rng_algorithm: RngAlgorithm::ChaCha,
        rng_seed: RngSeed::Fixed(SEED),
        ..Config::default()
    });
    runner
        .run(
            &strategy,
            |(seed, edits, truncate, length, chunk, repair)| {
                let mut bytes = seeds[seed].bytes.clone();
                for (offset, value) in edits {
                    if !bytes.is_empty() {
                        let position = offset % bytes.len();
                        bytes[position] = value;
                    }
                }
                if truncate {
                    bytes.truncate(length);
                }
                if repair {
                    repair_first_checksum(&mut bytes);
                }
                let _ = inspect(&bytes, chunk);
                Ok(())
            },
        )
        .unwrap();
    println!(
        "Raw TAR campaign: seed={SEED}; corpus={}; cases=256; input/decoded={INPUT_LIMIT}; checkpoints={CHECKPOINT_LIMIT}; shrink=512; memory-only; no extraction",
        seeds.len()
    );
}
