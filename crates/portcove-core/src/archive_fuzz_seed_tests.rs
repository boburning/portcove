//! The committed cargo-fuzz seeds are valid archives that each reader extracts.
//!
//! Each seed goes through the same entry as its fuzz target. Set
//! `PORTCOVE_WRITE_ARCHIVE_FUZZ_SEEDS=1` to rewrite the seed files from the
//! generators below (TAR.XZ needs the Linux x86_64 test encoder), then run the
//! test again without it so the embedded bytes are checked. The test checks
//! that the committed bytes extract; it does not compare them with the
//! generators' current output.
use std::{
    fs,
    io::{Cursor, Write},
    path::Path,
};

use super::fuzzing::{ArchiveFormat, extract_download_archive};

const README: &[u8] = b"Follow the upstream setup instructions.\n";
const LAUNCHER: &[u8] = b"#!/bin/sh\nexec ./game \"$@\"\n";

struct Seed {
    target: &'static str,
    name: &'static str,
    format: ArchiveFormat,
    committed: &'static [u8],
    generate: Option<fn() -> Vec<u8>>,
}

fn seeds() -> [Seed; 6] {
    [
        Seed {
            target: "archive_zip",
            name: "tree.zip",
            format: ArchiveFormat::Zip,
            committed: include_bytes!("../fuzz/seeds/archive_zip/tree.zip"),
            generate: Some(zip_tree),
        },
        Seed {
            target: "archive_zip",
            name: "alias.zip",
            format: ArchiveFormat::Zip,
            committed: include_bytes!("../fuzz/seeds/archive_zip/alias.zip"),
            generate: Some(zip_alias),
        },
        Seed {
            target: "archive_7z",
            name: "tree.7z",
            format: ArchiveFormat::SevenZip,
            committed: include_bytes!("../fuzz/seeds/archive_7z/tree.7z"),
            generate: Some(seven_zip_tree),
        },
        Seed {
            target: "archive_tar_gz",
            name: "tree.tar.gz",
            format: ArchiveFormat::TarGz,
            committed: include_bytes!("../fuzz/seeds/archive_tar_gz/tree.tar.gz"),
            generate: Some(tar_gz_tree),
        },
        Seed {
            target: "archive_tar_xz",
            name: "tree.tar.xz",
            format: ArchiveFormat::TarXz,
            committed: include_bytes!("../fuzz/seeds/archive_tar_xz/tree.tar.xz"),
            generate: tar_xz_generator(),
        },
        Seed {
            target: "archive_tar_xz",
            name: "upstream-fixture.tar.xz",
            format: ArchiveFormat::TarXz,
            committed: include_bytes!("../fuzz/seeds/archive_tar_xz/upstream-fixture.tar.xz"),
            generate: Some(super::xz_fixture),
        },
    ]
}

fn zip_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644)
}

fn zip_tree() -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_directory("game/", zip_options().unix_permissions(0o755))
        .unwrap();
    writer
        .start_file(
            "game/readme.txt",
            zip_options().compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
    writer.write_all(README).unwrap();
    writer
        .start_file(
            "game/run.sh",
            zip_options()
                .compression_method(zip::CompressionMethod::Stored)
                .unix_permissions(0o755),
        )
        .unwrap();
    writer.write_all(LAUNCHER).unwrap();
    writer.finish().unwrap().into_inner()
}

/// A link to a regular file in the same archive is written as a copy.
fn zip_alias() -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "game/readme.txt",
            zip_options().compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
    writer.write_all(README).unwrap();
    writer
        .add_symlink("game/README", "readme.txt", zip_options())
        .unwrap();
    writer.finish().unwrap().into_inner()
}

fn seven_zip_tree() -> Vec<u8> {
    use sevenz_turbo::{ArchiveEntry, ArchiveWriter};
    let mut writer = ArchiveWriter::new(Cursor::new(Vec::new())).unwrap();
    writer
        .push_archive_entry(ArchiveEntry::new_directory("game"), None::<Cursor<&[u8]>>)
        .unwrap();
    for (name, content) in [("game/readme.txt", README), ("game/run.sh", LAUNCHER)] {
        writer
            .push_archive_entry(ArchiveEntry::new_file(name), Some(Cursor::new(content)))
            .unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn tar_tree() -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    let mut directory = tar::Header::new_ustar();
    directory.set_entry_type(tar::EntryType::Directory);
    directory.set_mode(0o755);
    directory.set_size(0);
    directory.set_mtime(0);
    tar.append_data(&mut directory, "game/", std::io::empty())
        .unwrap();
    for (name, mode, content) in [
        ("game/readme.txt", 0o644, README),
        ("game/run.sh", 0o755, LAUNCHER),
    ] {
        let mut header = tar::Header::new_ustar();
        header.set_mode(mode);
        header.set_size(content.len() as u64);
        header.set_mtime(0);
        tar.append_data(&mut header, name, content).unwrap();
    }
    tar.into_inner().unwrap()
}

fn tar_gz_tree() -> Vec<u8> {
    let mut encoder = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), flate2::Compression::best());
    encoder.write_all(&tar_tree()).unwrap();
    encoder.finish().unwrap()
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn tar_xz_generator() -> Option<fn() -> Vec<u8>> {
    Some(|| super::encode_xz_fixture(&tar_tree()))
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
fn tar_xz_generator() -> Option<fn() -> Vec<u8>> {
    None
}

#[test]
fn committed_archive_fuzz_seeds_extract_through_the_fuzz_entry() {
    if std::env::var_os("PORTCOVE_WRITE_ARCHIVE_FUZZ_SEEDS").is_some() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("fuzz/seeds");
        let seeds = seeds();
        if let Some(seed) = seeds.iter().find(|seed| seed.generate.is_none()) {
            panic!(
                "{} has no generator on this host; nothing was written",
                seed.name
            );
        }
        for seed in seeds {
            let generate = seed.generate.expect("checked above");
            let directory = root.join(seed.target);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join(seed.name), generate()).unwrap();
        }
        panic!("rewrote the archive fuzz seeds; rerun without PORTCOVE_WRITE_ARCHIVE_FUZZ_SEEDS");
    }
    let mut formats = Vec::new();
    for seed in seeds() {
        assert!(
            seed.committed.len() <= 4096,
            "{} should stay a small starting input",
            seed.name
        );
        if let Err(error) = extract_download_archive(seed.format, seed.committed) {
            panic!("{} did not extract: {}", seed.name, error.message);
        }
        formats.push(seed.format);
    }
    for format in ArchiveFormat::ALL {
        assert!(formats.contains(&format), "no seed reaches {format:?}");
    }
}

#[test]
fn archive_fuzz_entry_returns_reader_refusals_without_a_finding() {
    for format in ArchiveFormat::ALL {
        for bytes in [&b""[..], b"not an archive", &[0xff; 600]] {
            assert!(extract_download_archive(format, bytes).is_err());
        }
    }
    let truncated = &seeds()[0].committed[..40];
    assert!(extract_download_archive(ArchiveFormat::Zip, truncated).is_err());
}
