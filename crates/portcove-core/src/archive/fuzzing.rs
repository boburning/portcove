//! Coverage-guided fuzzing entry for the download archive readers.
//!
//! The out-of-workspace `crates/portcove-core/fuzz` crate is the only consumer;
//! the `archive-fuzzing` feature exposes it. This is not a product API.
//!
//! Each call runs the production download extraction (ZIP, 7z, TAR.GZ or TAR.XZ)
//! with its unchanged limits, path rules, integrity checks and cancellation
//! checkpoints in a fresh temporary directory, then removes that directory.
//! A refusal is an ordinary result and is returned. A panic, or a written tree
//! that breaks the extraction contract below, is a finding.
use std::{
    fs,
    path::{Path, PathBuf},
};

use super::{
    MAX_COMPRESSION_RATIO, MAX_ENTRIES, MAX_EXPANDED_BYTES,
    extract_download_archive_with_checkpoint, validate_relative_path,
};
use crate::Result;

const SOURCE_NAME: &str = "source";
const DESTINATION_NAME: &str = "destination";

/// The download archive formats this entry reaches, selected the same way
/// production selects them: by the asset name's extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    SevenZip,
    TarGz,
    TarXz,
}

impl ArchiveFormat {
    pub const ALL: [Self; 4] = [Self::Zip, Self::SevenZip, Self::TarGz, Self::TarXz];

    /// The asset-name extension that routes production extraction to this reader.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Zip => "zip",
            Self::SevenZip => "7z",
            Self::TarGz => "tar.gz",
            Self::TarXz => "tar.xz",
        }
    }
}

/// Extract `bytes` as a download asset of `format` into a fresh temporary
/// directory, check the written tree and remove the directory.
///
/// The temporary directory is created under [`std::env::temp_dir`], so a
/// campaign controls where output goes with `TMPDIR`. The declared size is the
/// input length, as for a release asset whose metadata matches its download.
///
/// # Panics
///
/// Panics when the written tree breaks the extraction contract, whether the
/// extraction succeeded or refused: something other than a regular file or
/// directory, a path the archive path rules refuse (including depth), anything
/// written beside the destination, or more files or bytes than the extraction
/// limits allow.
pub fn extract_download_archive(format: ArchiveFormat, bytes: &[u8]) -> Result<()> {
    let scratch = tempfile::Builder::new()
        .prefix("portcove-archive-fuzz-")
        .tempdir()?;
    let source = scratch
        .path()
        .join(format!("{SOURCE_NAME}.{}", format.extension()));
    let destination = scratch.path().join(DESTINATION_NAME);
    fs::write(&source, bytes)?;
    fs::create_dir(&destination)?;
    let asset_name = format!("download.{}", format.extension());
    let result = extract_download_archive_with_checkpoint(
        &source,
        &destination,
        &asset_name,
        bytes.len() as u64,
        &|| Ok(()),
    );
    check_scratch(scratch.path(), &source, &destination);
    check_written_tree(&destination, bytes.len() as u64, result.is_err());
    scratch.close()?;
    result
}

/// Extraction must not create anything beside its source and destination.
fn check_scratch(scratch: &Path, source: &Path, destination: &Path) {
    let mut names = fs::read_dir(scratch)
        .expect("read fuzz scratch directory")
        .map(|entry| entry.expect("read fuzz scratch entry").path())
        .collect::<Vec<_>>();
    names.sort();
    let mut expected = vec![source.to_path_buf(), destination.to_path_buf()];
    expected.sort();
    assert_eq!(names, expected, "extraction wrote outside its destination");
    let destination_metadata =
        fs::symlink_metadata(destination).expect("read destination metadata");
    assert!(
        destination_metadata.is_dir(),
        "extraction replaced its destination directory"
    );
}

fn check_written_tree(destination: &Path, compressed_size: u64, refused: bool) {
    let mut pending = vec![PathBuf::new()];
    let mut files = 0_usize;
    let mut expanded = 0_u64;
    while let Some(relative) = pending.pop() {
        let directory = destination.join(&relative);
        for entry in fs::read_dir(&directory).expect("read extracted directory") {
            let entry = entry.expect("read extracted entry");
            let name = entry.file_name();
            let name = name
                .to_str()
                .unwrap_or_else(|| panic!("extracted a non-UTF-8 name: {name:?}"));
            let relative = relative.join(name);
            let portable = relative
                .components()
                .map(|component| {
                    component
                        .as_os_str()
                        .to_str()
                        .expect("extracted path component is UTF-8")
                })
                .collect::<Vec<_>>()
                .join("/");
            let metadata = fs::symlink_metadata(entry.path()).expect("read extracted metadata");
            assert!(
                metadata.is_file() || metadata.is_dir(),
                "extracted something other than a regular file or directory: {portable}"
            );
            if let Err(error) = validate_relative_path(&portable, metadata.is_dir()) {
                panic!(
                    "extracted a path the archive rules refuse: {portable}: {}",
                    error.message
                );
            }
            if metadata.is_dir() {
                pending.push(relative);
            } else {
                // Parent directories can be implied by file paths, so only files
                // are bounded by the planned entry count.
                files += 1;
                assert!(
                    files <= MAX_ENTRIES,
                    "extracted more files than the entry limit"
                );
                expanded = expanded.saturating_add(metadata.len());
            }
        }
    }
    // The limits bound declared sizes. A writer reads one byte past an entry's
    // declared size to detect overrun, so a refused extraction can leave that
    // byte in each file it was writing.
    let slack = if refused { files as u64 } else { 0 };
    assert!(
        expanded <= MAX_EXPANDED_BYTES.saturating_add(slack),
        "extracted more bytes than the total limit"
    );
    assert!(
        expanded
            <= compressed_size
                .saturating_mul(MAX_COMPRESSION_RATIO)
                .saturating_add(slack),
        "extracted {expanded} bytes from {compressed_size}, beyond the compression ratio limit"
    );
}
