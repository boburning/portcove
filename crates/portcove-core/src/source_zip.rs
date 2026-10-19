//! Bounded metadata admission before zip 9 parses a cartridge source container.
//!
//! Keep parsing on an anonymous snapshot: checking the player's mutable file and
//! then giving that file to the parser would leave the allocation bound racy.
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{PortcoveError, Result};
use sha2::{Digest, Sha256};

// Original-file inspection already limits an expanded member to 512 MiB. Allow
// room for incompressible data and companion metadata without unbounded staging.
pub(crate) const MAX_CONTAINER_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_DIRECTORY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
const MAX_EXTRA_FIELDS_PER_ENTRY: usize = 64;
const MAX_EXTRA_FIELDS: usize = 16_384;
const FOOTER_BYTES: u64 = 22 + u16::MAX as u64;
// Pinned zip 9.0.3's backwards magic finder reads 1024-byte windows. Include
// one window before the region so a maximum-length valid comment can be found.
const PARSER_SEARCH_PADDING: u64 = 1024;

pub(crate) struct CheckedSourceZip {
    pub archive: zip::ZipArchive<CheckedReader>,
    pub storage_sha256: String,
    pub storage_size: u64,
}

pub(crate) struct CheckedReader {
    file: File,
    metadata_floor: u64,
    constructing: Arc<AtomicBool>,
}

impl CheckedReader {
    fn check_position(&mut self) -> std::io::Result<()> {
        if self.constructing.load(Ordering::Acquire)
            && self.file.stream_position()? < self.metadata_floor
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ZIP parser attempted metadata fallback outside the checked directory",
            ));
        }
        Ok(())
    }
}

impl Read for CheckedReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.check_position()?;
        self.file.read(buffer)
    }
}

impl Seek for CheckedReader {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let position = self.file.seek(position)?;
        self.check_position()?;
        Ok(position)
    }
}

pub(crate) fn open(
    mut input: File,
    maximum_container_size: u64,
    maximum_entries: usize,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<CheckedSourceZip> {
    progress(0)?;
    let expected = input.metadata()?.len();
    if expected > maximum_container_size.min(MAX_CONTAINER_BYTES) {
        return Err(PortcoveError::unsupported(
            "source ZIP exceeds its container limit (at most 1 GiB); select an extracted original instead",
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
    let (metadata_floor, raw_entries) =
        preflight(&mut snapshot, maximum_entries.min(MAX_ENTRIES), progress)?;
    snapshot.seek(SeekFrom::End(0))?;
    let constructing = Arc::new(AtomicBool::new(true));
    let reader = CheckedReader {
        file: snapshot,
        metadata_floor,
        constructing: constructing.clone(),
    };
    // zip retries earlier EOCDs on decode failures. It cannot read such a footer
    // outside the scanned region while constructing metadata. Only after success
    // can ordinary entry readers reach the private payload. No bytes are altered.
    let archive = zip::ZipArchive::with_config(
        zip::read::Config {
            archive_offset: zip::read::ArchiveOffset::Known(0),
        },
        reader,
    )
    .map_err(|error| PortcoveError::source(format!("invalid source ZIP: {error}")))?;
    // zip stores entries by effective name and can silently overwrite duplicate
    // records. Never let that collapse hide a record from semantic validation.
    if archive.len() != raw_entries {
        return Err(invalid("duplicate effective member names"));
    }
    constructing.store(false, Ordering::Release);
    Ok(CheckedSourceZip {
        archive,
        storage_sha256: hex::encode(storage.finalize()),
        storage_size: copied,
    })
}

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::source(format!("unsupported source ZIP: {message}"))
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed header field"),
    )
}

/// Inspect declared/raw records before ZipArchive allocates its entry vector or
/// processes names, comments and extra fields. This does not authorize extraction.
fn preflight(
    file: &mut File,
    maximum_entries: usize,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<(u64, usize)> {
    let length = file.metadata()?.len();
    if length < 22 {
        return Err(invalid("truncated end record"));
    }
    let tail_length = length.min(FOOTER_BYTES);
    file.seek(SeekFrom::Start(length - tail_length))?;
    let mut tail = vec![0; tail_length as usize];
    file.read_exact(&mut tail)?;
    // zip can retry an earlier end record after failing a later one. Refuse an
    // ambiguous tail instead of validating one directory and parsing another.
    let mut footers = tail
        .windows(4)
        .enumerate()
        .filter_map(|(offset, bytes)| (bytes == b"PK\x05\x06").then_some(offset));
    let footer = footers
        .next()
        .ok_or_else(|| invalid("missing end record"))?;
    if footers.next().is_some() {
        return Err(invalid("ambiguous end records"));
    }
    if footer + 22 > tail.len() {
        return Err(invalid("truncated end record"));
    }
    let end = &tail[footer..];
    if 22 + usize::from(u16_at(end, 20)) != end.len() {
        return Err(invalid("trailing or truncated end-record comment"));
    }
    let footer_position = length - tail_length + footer as u64;
    if footer_position >= 20 {
        file.seek(SeekFrom::Start(footer_position - 20))?;
        let mut signature = [0; 4];
        file.read_exact(&mut signature)?;
        if signature == *b"PK\x06\x07" {
            return Err(invalid("ZIP64 is not supported for original-file ZIPs"));
        }
    }
    let count = usize::from(u16_at(end, 10));
    let directory_size = u64::from(u32_at(end, 12));
    let directory_start = u64::from(u32_at(end, 16));
    if count == usize::from(u16::MAX)
        || directory_size == u64::from(u32::MAX)
        || directory_start == u64::from(u32::MAX)
    {
        return Err(invalid("ZIP64 is not supported for original-file ZIPs"));
    }
    if u16_at(end, 4) != 0 || u16_at(end, 6) != 0 || usize::from(u16_at(end, 8)) != count {
        return Err(invalid("split archives are not supported"));
    }
    if count > maximum_entries {
        return Err(invalid("directory entry limit exceeded")
            .detail("maximum_entries", maximum_entries.to_string()));
    }
    if directory_size > MAX_DIRECTORY_BYTES {
        return Err(invalid("directory metadata exceeds 16 MiB"));
    }
    let directory_end = directory_start
        .checked_add(directory_size)
        .filter(|end| *end == footer_position)
        .ok_or_else(|| invalid("directory bounds do not match the end record"))?;
    let metadata_floor = directory_start
        .min(length - tail_length)
        .saturating_sub(PARSER_SEARCH_PADDING);
    // The complete parser-readable region, rather than only the usual tail,
    // must contain exactly the EOCD whose directory was admitted above.
    file.seek(SeekFrom::Start(metadata_floor))?;
    let mut signature = 0_u32;
    let mut signatures = 0;
    let mut remaining = length - metadata_floor;
    let mut buffer = [0; 64 * 1024];
    while remaining > 0 {
        progress(0)?;
        let wanted = remaining.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..wanted])?;
        for byte in &buffer[..wanted] {
            signature = (signature << 8) | u32::from(*byte);
            if signature == 0x504b0506 {
                signatures += 1;
                if signatures > 1 {
                    return Err(invalid("ambiguous end records in directory metadata"));
                }
            }
        }
        remaining -= wanted as u64;
    }
    if signatures != 1 {
        return Err(invalid("missing checked end record"));
    }
    file.seek(SeekFrom::Start(directory_start))?;
    let mut total_extra_fields = 0;
    for _ in 0..count {
        progress(0)?;
        let position = file.stream_position()?;
        if position
            .checked_add(46)
            .is_none_or(|end| end > directory_end)
        {
            return Err(invalid("truncated directory header"));
        }
        let mut header = [0; 46];
        file.read_exact(&mut header)?;
        if &header[..4] != b"PK\x01\x02" {
            return Err(invalid("invalid directory header"));
        }
        let flags = u16_at(&header, 8);
        let compression = u16_at(&header, 10);
        if flags & !0x080e != 0 || !matches!(compression, 0 | 8) {
            return Err(invalid("encrypted or unsupported compression/flags"));
        }
        if u16_at(&header, 34) != 0 {
            return Err(invalid("split archive member"));
        }
        if [20, 24, 42]
            .into_iter()
            .any(|offset| u32_at(&header, offset) == u32::MAX)
        {
            return Err(invalid("ZIP64 member is not supported"));
        }
        if u64::from(u32_at(&header, 42)) >= directory_start {
            return Err(invalid("member header lies outside the data region"));
        }
        let name_length = u64::from(u16_at(&header, 28));
        let extra_length = u64::from(u16_at(&header, 30));
        let comment_length = u64::from(u16_at(&header, 32));
        let extra_start = position + 46 + name_length;
        let extra_end = extra_start + extra_length;
        let record_end = extra_end + comment_length;
        if record_end > directory_end {
            return Err(invalid("variable directory metadata exceeds its bound"));
        }
        file.seek(SeekFrom::Start(extra_start))?;
        let mut entry_extra_fields = 0;
        while file.stream_position()? < extra_end {
            progress(0)?;
            entry_extra_fields += 1;
            total_extra_fields += 1;
            if entry_extra_fields > MAX_EXTRA_FIELDS_PER_ENTRY
                || total_extra_fields > MAX_EXTRA_FIELDS
            {
                return Err(invalid("directory extra-field record limit exceeded"));
            }
            let position = file.stream_position()?;
            if position + 4 > extra_end {
                return Err(invalid("truncated directory extra field"));
            }
            let mut field = [0; 4];
            file.read_exact(&mut field)?;
            let tag = u16_at(&field, 0);
            let end = position + 4 + u64::from(u16_at(&field, 2));
            if end > extra_end {
                return Err(invalid("extra field exceeds its directory record"));
            }
            if matches!(tag, 0x0001 | 0x9901) {
                return Err(invalid("ZIP64/encryption extra field is not supported"));
            }
            file.seek(SeekFrom::Start(end))?;
        }
        file.seek(SeekFrom::Start(record_end))?;
    }
    if file.stream_position()? != directory_end {
        return Err(invalid(
            "directory count does not cover its declared metadata",
        ));
    }
    Ok((metadata_floor, count))
}

#[cfg(test)]
#[path = "source_zip_tests.rs"]
mod tests;
