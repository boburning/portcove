//! Narrow, bounded extraction for read-only Xbox 360 STFS packages.
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use crate::{PortcoveError, Result};

const BLOCK_SIZE: u64 = 0x1000;
const END_OF_CHAIN: u32 = 0x00ff_ffff;
const HASH_LEVEL_0: u64 = 170;
const HASH_LEVEL_1: u64 = HASH_LEVEL_0 * HASH_LEVEL_0;
const MAX_ENTRIES: usize = 16_384;
const MAX_DEPTH: usize = 64;
const MAX_EXPANDED_BYTES: u64 = 16 * 1024 * 1024 * 1024;

#[derive(Debug)]
struct Info {
    table_blocks: u16,
    first_table_block: u32,
    total_blocks: u32,
    data_base: u64,
}

#[derive(Debug)]
struct Entry {
    name: String,
    directory: bool,
    blocks: u32,
    first_block: u32,
    parent: u16,
    size: u64,
}

pub(crate) fn extract(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err(PortcoveError::state(
            "STFS extraction destination must be a new directory",
        ));
    }
    let source_size = std::fs::metadata(source)?.len();
    let mut input = File::open(source)?;
    let info = parse_info(&mut input, source_size)?;
    let entries = parse_entries(&mut input, source_size, &info)?;
    let plans = plan_entries(&entries, source_size)?;
    let expanded = entries
        .iter()
        .filter(|entry| !entry.directory)
        .try_fold(0_u64, |total, entry| total.checked_add(entry.size))
        .ok_or_else(|| PortcoveError::source("STFS expanded size overflowed"))?;
    if expanded > MAX_EXPANDED_BYTES || expanded > source_size {
        return Err(PortcoveError::source(
            "STFS package exceeds its expanded-size safety limit",
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("STFS destination has no parent directory"))?;
    if expanded > fs2::available_space(parent)? {
        return Err(PortcoveError::state(
            "STFS package cannot fit in the available destination space",
        ));
    }

    std::fs::create_dir(destination)?;
    for (entry, relative) in entries.iter().zip(plans) {
        let target = destination.join(relative);
        if entry.directory {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        extract_entry(&mut input, source_size, &info, entry, &target)?;
    }
    Ok(())
}

fn parse_info(input: &mut File, source_size: u64) -> Result<Info> {
    let magic = read_at::<4>(input, source_size, 0)?;
    if magic != *b"LIVE" {
        return Err(PortcoveError::source(
            "runtime source is not a read-only Xbox LIVE STFS package",
        ));
    }
    let header_size = u32::from_be_bytes(read_at(input, source_size, 0x340)?) as u64;
    let descriptor = 0x379;
    let flags = read_at::<1>(input, source_size, descriptor + 2)?[0];
    let table_blocks = u16::from_le_bytes(read_at(input, source_size, descriptor + 3)?);
    let first_table_block = u24_le(read_at(input, source_size, descriptor + 5)?);
    let total_blocks = u32::from_be_bytes(read_at(input, source_size, descriptor + 0x1c)?);
    let volume_type = u32::from_be_bytes(read_at(input, source_size, 0x3a9)?);
    let data_base = header_size
        .checked_add(BLOCK_SIZE - 1)
        .map(|value| value / BLOCK_SIZE * BLOCK_SIZE)
        .ok_or_else(|| PortcoveError::source("STFS header size overflowed"))?;
    if flags & 1 == 0
        || volume_type != 0
        || table_blocks == 0
        || usize::from(table_blocks) > MAX_ENTRIES / 64
        || total_blocks == 0
        || first_table_block >= total_blocks
        || data_base < 0x400
        || data_base >= source_size
    {
        return Err(PortcoveError::source(
            "STFS package has an unsupported or invalid volume descriptor",
        ));
    }
    Ok(Info {
        table_blocks,
        first_table_block,
        total_blocks,
        data_base,
    })
}

fn parse_entries(input: &mut File, source_size: u64, info: &Info) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut table_block = info.first_table_block;
    let mut seen = HashSet::new();
    for index in 0..info.table_blocks {
        if table_block == END_OF_CHAIN
            || table_block >= info.total_blocks
            || !seen.insert(table_block)
        {
            return Err(PortcoveError::source(
                "STFS file-table block chain ended early or cycled",
            ));
        }
        let offset = block_offset(table_block, info)?;
        for slot in 0..64_u64 {
            let raw = read_at::<64>(input, source_size, offset + slot * 64)?;
            let name_flags = raw[0x28];
            let name_len = usize::from(name_flags & 0x3f);
            if name_len == 0 {
                break;
            }
            if name_len > 40 || !raw[..name_len].is_ascii() {
                return Err(PortcoveError::source(
                    "STFS file table contains an invalid filename",
                ));
            }
            let name = std::str::from_utf8(&raw[..name_len])
                .map_err(|_| PortcoveError::source("STFS filename is not ASCII"))?
                .to_owned();
            entries.push(Entry {
                name,
                directory: name_flags & 0x80 != 0,
                blocks: u24_le(raw[0x29..0x2c].try_into().expect("three bytes")),
                first_block: u24_le(raw[0x2f..0x32].try_into().expect("three bytes")),
                parent: u16::from_be_bytes(raw[0x32..0x34].try_into().expect("two bytes")),
                size: u64::from(u32::from_be_bytes(
                    raw[0x34..0x38].try_into().expect("four bytes"),
                )),
            });
            if entries.len() > MAX_ENTRIES {
                return Err(PortcoveError::source(
                    "STFS package contains too many entries",
                ));
            }
        }
        if index + 1 < info.table_blocks {
            table_block = next_block(input, source_size, table_block, info)?;
        }
    }
    if entries.is_empty() {
        return Err(PortcoveError::source("STFS package has no file entries"));
    }
    Ok(entries)
}

fn plan_entries(entries: &[Entry], source_size: u64) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::with_capacity(entries.len());
    let mut collisions = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let mut parts = vec![entry.name.as_str()];
        let mut parent = entry.parent;
        let mut seen = HashSet::from([index]);
        while parent != u16::MAX {
            let parent_index = usize::from(parent);
            let Some(parent_entry) = entries.get(parent_index) else {
                return Err(PortcoveError::source(
                    "STFS entry has an invalid parent reference",
                ));
            };
            if !parent_entry.directory || !seen.insert(parent_index) || seen.len() > MAX_DEPTH {
                return Err(PortcoveError::source(
                    "STFS entry has an invalid or cyclic parent chain",
                ));
            }
            parts.push(parent_entry.name.as_str());
            parent = parent_entry.parent;
        }
        parts.reverse();
        let joined = parts.join("/");
        let (relative, key) = crate::archive::validate_relative_path(&joined, entry.directory)?;
        if !collisions.insert(key) {
            return Err(PortcoveError::source(
                "STFS package contains colliding entry paths",
            ));
        }
        if !entry.directory {
            let required_blocks = entry.size.div_ceil(BLOCK_SIZE);
            if required_blocks > u64::from(entry.blocks)
                || required_blocks > u64::from(u32::MAX)
                || entry.size > source_size
            {
                return Err(PortcoveError::source(
                    "STFS file entry has an invalid size or block count",
                ));
            }
        }
        paths.push(relative);
    }
    Ok(paths)
}

fn extract_entry(
    input: &mut File,
    source_size: u64,
    info: &Info,
    entry: &Entry,
    destination: &Path,
) -> Result<()> {
    let mut output = File::create(destination)?;
    let mut remaining = entry.size;
    let mut block = entry.first_block;
    let mut seen = HashSet::new();
    while remaining > 0 {
        if block == END_OF_CHAIN || block >= info.total_blocks || !seen.insert(block) {
            return Err(PortcoveError::source(
                "STFS file block chain ended early or cycled",
            ));
        }
        let count = remaining.min(BLOCK_SIZE) as usize;
        let offset = block_offset(block, info)?;
        let mut bytes = vec![0_u8; count];
        read_exact_at(input, source_size, offset, &mut bytes)?;
        output.write_all(&bytes)?;
        remaining -= count as u64;
        if remaining > 0 {
            block = next_block(input, source_size, block, info)?;
        }
    }
    output.sync_all()?;
    Ok(())
}

fn block_offset(block_index: u32, info: &Info) -> Result<u64> {
    let index = u64::from(block_index);
    let mut physical = index;
    let mut level = HASH_LEVEL_0;
    for _ in 0..3 {
        physical = physical
            .checked_add((index + level) / level)
            .ok_or_else(|| PortcoveError::source("STFS block offset overflowed"))?;
        if index < level {
            break;
        }
        level = level
            .checked_mul(HASH_LEVEL_0)
            .ok_or_else(|| PortcoveError::source("STFS hash level overflowed"))?;
    }
    info.data_base
        .checked_add(physical << 12)
        .ok_or_else(|| PortcoveError::source("STFS block offset overflowed"))
}

fn hash_offset(block_index: u32, info: &Info) -> Result<u64> {
    let index = u64::from(block_index);
    let physical = if index < HASH_LEVEL_0 {
        0
    } else {
        let mut value = (index / HASH_LEVEL_0) * (HASH_LEVEL_0 + 1);
        value += index / HASH_LEVEL_1 + 1;
        if index >= HASH_LEVEL_1 {
            value += 1;
        }
        value
    };
    info.data_base
        .checked_add(physical << 12)
        .and_then(|value| value.checked_add((index % HASH_LEVEL_0) * 0x18 + 0x14))
        .ok_or_else(|| PortcoveError::source("STFS hash offset overflowed"))
}

fn next_block(input: &mut File, source_size: u64, block: u32, info: &Info) -> Result<u32> {
    let word = u32::from_be_bytes(read_at(input, source_size, hash_offset(block, info)?)?);
    Ok(word & END_OF_CHAIN)
}

fn read_at<const N: usize>(input: &mut File, source_size: u64, offset: u64) -> Result<[u8; N]> {
    let mut bytes = [0_u8; N];
    read_exact_at(input, source_size, offset, &mut bytes)?;
    Ok(bytes)
}

fn read_exact_at(input: &mut File, source_size: u64, offset: u64, bytes: &mut [u8]) -> Result<()> {
    let end = offset
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| PortcoveError::source("STFS read offset overflowed"))?;
    if end > source_size {
        return Err(PortcoveError::source("STFS package is truncated"));
    }
    input.seek(SeekFrom::Start(offset))?;
    input.read_exact(bytes)?;
    Ok(())
}

fn u24_le(bytes: [u8; 3]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Vec<u8> {
        let mut package = vec![0_u8; 0xe000];
        package[..4].copy_from_slice(b"LIVE");
        package[0x340..0x344].copy_from_slice(&0xad0e_u32.to_be_bytes());
        package[0x37b] = 1;
        package[0x37c..0x37e].copy_from_slice(&1_u16.to_le_bytes());
        package[0x395..0x399].copy_from_slice(&2_u32.to_be_bytes());
        package[0xb014..0xb018].copy_from_slice(&END_OF_CHAIN.to_be_bytes());
        package[0xb02c..0xb030].copy_from_slice(&END_OF_CHAIN.to_be_bytes());
        let entry = &mut package[0xc000..0xc040];
        entry[..11].copy_from_slice(b"default.xex");
        entry[0x28] = 11;
        entry[0x29] = 1;
        entry[0x2f] = 1;
        entry[0x32..0x34].copy_from_slice(&u16::MAX.to_be_bytes());
        entry[0x34..0x38].copy_from_slice(&4_u32.to_be_bytes());
        package[0xd000..0xd004].copy_from_slice(b"XEX2");
        package
    }

    #[test]
    fn extracts_a_bounded_read_only_package() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        std::fs::write(&source, fixture()).unwrap();
        let destination = temporary.path().join("assets");
        extract(&source, &destination).unwrap();
        assert_eq!(
            std::fs::read(destination.join("default.xex")).unwrap(),
            b"XEX2"
        );
    }

    #[test]
    fn rejects_case_colliding_paths_before_writing() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let mut package = fixture();
        let second = &mut package[0xc040..0xc080];
        second[0] = b'D';
        second[1..11].copy_from_slice(b"efault.xex");
        second[0x28] = 11;
        second[0x29] = 1;
        second[0x2f] = 1;
        second[0x32..0x34].copy_from_slice(&u16::MAX.to_be_bytes());
        second[0x34..0x38].copy_from_slice(&4_u32.to_be_bytes());
        std::fs::write(&source, package).unwrap();
        let destination = temporary.path().join("assets");
        assert!(extract(&source, &destination).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn rejects_a_truncated_block_chain() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let mut package = fixture();
        package[0xc029] = 2;
        package[0xc034..0xc038].copy_from_slice(&4097_u32.to_be_bytes());
        std::fs::write(&source, package).unwrap();
        let destination = temporary.path().join("assets");
        assert!(extract(&source, &destination).is_err());
    }
}
