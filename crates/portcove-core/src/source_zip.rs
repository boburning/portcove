//! Bounded metadata admission before zip 9 parses a cartridge source container.
//!
//! Keep parsing on an anonymous snapshot: checking the player's mutable file and
//! then giving that file to the parser would leave the allocation bound racy.
use std::{
    fs::File,
    io::{Read, Seek, Write},
};

use crate::{PortcoveError, Result};
use sha2::{Digest, Sha256};

// Original-file inspection already limits an expanded member to 512 MiB. Allow
// room for incompressible data and companion metadata without unbounded staging.
pub(crate) const MAX_CONTAINER_BYTES: u64 = 1024 * 1024 * 1024;
#[cfg(test)]
const MAX_DIRECTORY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
#[cfg(test)]
const MAX_EXTRA_FIELDS_PER_ENTRY: usize = 64;

pub(crate) struct CheckedSourceZip {
    pub archive: zip::ZipArchive<CheckedReader>,
    pub storage_sha256: String,
    pub storage_size: u64,
}

pub(crate) type CheckedReader = crate::zip_read::CheckedReader;

pub(crate) fn open(
    input: File,
    maximum_container_size: u64,
    maximum_entries: usize,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<CheckedSourceZip> {
    open_with_limits(
        input,
        crate::zip_read::Limits {
            bytes: maximum_container_size.min(MAX_CONTAINER_BYTES),
            entries: maximum_entries.min(MAX_ENTRIES),
            ..crate::zip_read::CARTRIDGE
        },
        progress,
    )
}

pub(crate) fn open_with_limits(
    mut input: File,
    limits: crate::zip_read::Limits,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<CheckedSourceZip> {
    progress(0)?;
    let expected = input.metadata()?.len();
    if expected > limits.bytes {
        return Err(PortcoveError::unsupported(
            "source ZIP exceeds its container limit; select an extracted original instead",
        ));
    }
    input.rewind()?;
    let mut snapshot = tempfile::tempfile()?;
    let mut copied = 0;
    let mut storage = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    while copied < expected {
        progress(0)?;
        let wanted = (expected - copied).min(buffer.len() as u64) as usize;
        let count = input.read(&mut buffer[..wanted])?;
        if count == 0 {
            return Err(PortcoveError::source(
                "source ZIP shrank while being checked",
            ));
        }
        progress(count as u64)?;
        snapshot.write_all(&buffer[..count])?;
        storage.update(&buffer[..count]);
        copied += count as u64;
    }
    if input.read(&mut [0_u8; 1])? != 0 {
        progress(1)?;
        return Err(PortcoveError::source("source ZIP grew while being checked"));
    }
    progress(0)?;
    let archive = crate::zip_read::open(snapshot, limits, progress)?;
    Ok(CheckedSourceZip {
        archive,
        storage_sha256: hex::encode(storage.finalize()),
        storage_size: copied,
    })
}

pub(crate) fn runtime_archive(
    input: File,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<zip::ZipArchive<CheckedReader>> {
    Ok(open_with_limits(input, crate::zip_read::RUNTIME, &mut |_| checkpoint())?.archive)
}

pub(crate) fn file_set_archive(
    input: File,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<zip::ZipArchive<CheckedReader>> {
    Ok(open_with_limits(input, crate::zip_read::FILE_SET, &mut |_| checkpoint())?.archive)
}

#[cfg(test)]
use crate::zip_read::cartridge_preflight as preflight;

#[cfg(test)]
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[cfg(test)]
#[path = "source_zip_tests.rs"]
mod tests;
