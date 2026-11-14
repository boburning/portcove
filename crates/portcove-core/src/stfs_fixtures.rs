//! Synthetic, hand-built STFS packages with real SHA-1 hash trees. No game data.
//!
//! The physical layout is computed here from the public block formulas (darkuni's MIT
//! notes for data and level-0 placement, Xenia's for level 1 and 2), independently of
//! the reader's own offset arithmetic, so the two cross-check each other.
use std::{collections::BTreeMap, io::Write, path::Path};

use sha1::{Digest, Sha1};

pub(crate) const BLOCK: usize = 0x1000;
const PER_TABLE: u64 = 170;
const LEVEL_1: u64 = PER_TABLE * PER_TABLE;
const END: u32 = 0x00ff_ffff;
/// The LIVE/PIRS header size (Free60); the data region starts at 0xA000. Builders use it
/// by default.
pub(crate) const HEADER_SIZE: u32 = 0x971a;
/// The CON header size (Free60); the data region starts at 0xB000. The historical
/// single-file fixture keeps this layout so its fixed offsets stay valid.
pub(crate) const LARGE_HEADER_SIZE: u32 = 0xad0e;
pub(crate) const ARCADE_TITLE: u32 = 0x000d_0000;
pub(crate) const TITLE_ID: u32 = 0x5841_0a6b;

pub(crate) enum Item {
    File(String, Vec<u8>),
    Dir(String, Vec<Item>),
}

pub(crate) fn file(name: &str, data: &[u8]) -> Item {
    Item::File(name.into(), data.to_vec())
}

pub(crate) fn dir(name: &str, items: Vec<Item>) -> Item {
    Item::Dir(name.into(), items)
}

/// How file blocks are allocated and described.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Allocation {
    /// Blocks are allocated in reverse order and linked only through the hash chain.
    Chained,
    /// Sequential blocks with the contiguous flag and complete next pointers.
    Contiguous,
    /// Sequential blocks with the contiguous flag and empty next pointers.
    ContiguousWithoutPointers,
}

pub(crate) struct Builder {
    pub(crate) magic: [u8; 4],
    /// Header size; the data region starts at the next 4 KiB boundary.
    pub(crate) header_size: u32,
    pub(crate) content_type: u32,
    pub(crate) title_id: u32,
    pub(crate) media_id: u32,
    pub(crate) version: u32,
    pub(crate) flags: u8,
    pub(crate) volume_type: u32,
    pub(crate) allocation: Allocation,
    /// First block for file contents; earlier blocks after the file table stay unused.
    pub(crate) data_start: u32,
    /// Allocated block count; at least the blocks used.
    pub(crate) total_blocks: u32,
    /// Bytes written into the licence area, outside the header hash.
    pub(crate) licence: [u8; 16],
    pub(crate) items: Vec<Item>,
}

pub(crate) fn live(items: Vec<Item>) -> Builder {
    Builder {
        magic: *b"LIVE",
        header_size: HEADER_SIZE,
        content_type: ARCADE_TITLE,
        title_id: TITLE_ID,
        media_id: 0x1234_5678,
        version: 1,
        flags: 1,
        volume_type: 0,
        allocation: Allocation::Chained,
        data_start: 0,
        total_blocks: 0,
        licence: [0; 16],
        items,
    }
}

pub(crate) fn pirs(items: Vec<Item>) -> Builder {
    Builder {
        magic: *b"PIRS",
        ..live(items)
    }
}

/// One built file's position, for targeted mutation.
pub(crate) struct BuiltFile {
    pub(crate) path: String,
    pub(crate) blocks: Vec<u32>,
    pub(crate) entry_offset: usize,
}

/// A sparse package: written segments over an all-zero background.
pub(crate) struct Built {
    pub(crate) len: u64,
    pub(crate) segments: BTreeMap<u64, Vec<u8>>,
    pub(crate) files: Vec<BuiltFile>,
    pub(crate) total_blocks: u32,
}

impl Built {
    pub(crate) fn to_vec(&self) -> Vec<u8> {
        let mut bytes = vec![0_u8; self.len as usize];
        for (offset, segment) in &self.segments {
            let offset = *offset as usize;
            bytes[offset..offset + segment.len()].copy_from_slice(segment);
        }
        bytes
    }

    pub(crate) fn write_to(&self, path: &Path) {
        let mut output = std::fs::File::create(path).unwrap();
        output.set_len(self.len).unwrap();
        for (offset, segment) in &self.segments {
            use std::io::Seek;
            output.seek(std::io::SeekFrom::Start(*offset)).unwrap();
            output.write_all(segment).unwrap();
        }
        output.sync_all().unwrap();
    }

    pub(crate) fn file(&self, path: &str) -> &BuiltFile {
        self.files.iter().find(|file| file.path == path).unwrap()
    }
}

fn base_for(header_size: u32) -> u64 {
    (u64::from(header_size) + 0xfff) & !0xfff
}

/// The data base recorded in a built package's header.
fn base_of(bytes: &[u8]) -> u64 {
    base_for(u32::from_be_bytes(bytes[0x340..0x344].try_into().unwrap()))
}

/// The data base of a package built with the default header size.
pub(crate) fn data_base() -> u64 {
    base_for(HEADER_SIZE)
}

/// Byte offset of a data block in a default-header package.
pub(crate) fn data_offset(block: u32) -> u64 {
    data_offset_at(data_base(), block)
}

/// Byte offset of the level-0 table for a data block in a default-header package.
pub(crate) fn level0_offset(block: u32) -> u64 {
    level0_offset_at(data_base(), block)
}

/// Byte offset of a level-1 table in a default-header package.
pub(crate) fn level1_offset(group: u64) -> u64 {
    level1_offset_at(data_base(), group)
}

/// Byte offset of a data block (darkuni `backing_block`, single-table layout).
fn data_offset_at(base: u64, block: u32) -> u64 {
    let n = u64::from(block);
    let r = (n + 0xaa) / 0xaa + n;
    let physical = if n < 0xaa {
        r
    } else if n < 0x70e4 {
        r + (n + 0x70e4) / 0x70e4
    } else {
        1 + r + (n + 0x70e4) / 0x70e4
    };
    base + physical * BLOCK as u64
}

/// Byte offset of the level-0 table covering a data block (darkuni `l0_hash_block`).
fn level0_offset_at(base: u64, block: u32) -> u64 {
    let n = u64::from(block);
    let physical = if n < 0xaa {
        0
    } else {
        let value = (n / 0xaa) * 0xab + (n / 0x70e4 + 1);
        if n / 0x70e4 == 0 { value } else { value + 1 }
    };
    base + physical * BLOCK as u64
}

/// Byte offset of a level-1 table (Xenia `BlockToHashBlockNumberSTFS`, level 1).
fn level1_offset_at(base: u64, group: u64) -> u64 {
    let physical = if group == 0 { 0xab } else { group * 0x718f + 1 };
    base + physical * BLOCK as u64
}

fn level2_offset_at(base: u64) -> u64 {
    base + 0x718f * BLOCK as u64
}

struct Flat {
    name: String,
    parent: u16,
    data: Option<Vec<u8>>,
}

fn flatten(items: &[Item], parent: u16, out: &mut Vec<Flat>) {
    for item in items {
        match item {
            Item::File(name, data) => out.push(Flat {
                name: name.clone(),
                parent,
                data: Some(data.clone()),
            }),
            Item::Dir(name, children) => {
                let index = out.len() as u16;
                out.push(Flat {
                    name: name.clone(),
                    parent,
                    data: None,
                });
                flatten(children, index, out);
            }
        }
    }
}

fn path_of(entries: &[Flat], index: usize) -> String {
    let mut parts = vec![entries[index].name.clone()];
    let mut parent = entries[index].parent;
    while parent != u16::MAX {
        parts.push(entries[usize::from(parent)].name.clone());
        parent = entries[usize::from(parent)].parent;
    }
    parts.reverse();
    parts.join("/")
}

impl Builder {
    pub(crate) fn build(&self) -> Built {
        let base = base_for(self.header_size);
        let mut entries = Vec::new();
        flatten(&self.items, u16::MAX, &mut entries);
        let table_blocks = entries.len().div_ceil(64).max(1) as u32;
        let mut contents: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
        let mut next: BTreeMap<u32, u32> = BTreeMap::new();
        let mut table = vec![0_u8; table_blocks as usize * BLOCK];
        for block in 0..table_blocks {
            next.insert(
                block,
                if block + 1 == table_blocks {
                    END
                } else {
                    block + 1
                },
            );
        }
        let mut free = table_blocks.max(self.data_start);
        let mut files = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            let raw = &mut table[index * 64..index * 64 + 64];
            raw[..entry.name.len()].copy_from_slice(entry.name.as_bytes());
            raw[0x28] = entry.name.len() as u8;
            raw[0x32..0x34].copy_from_slice(&entry.parent.to_be_bytes());
            let Some(data) = &entry.data else {
                raw[0x28] |= 0x80;
                continue;
            };
            let count = data.len().div_ceil(BLOCK) as u32;
            let mut blocks = (free..free + count).collect::<Vec<_>>();
            free += count;
            if self.allocation == Allocation::Chained {
                blocks.reverse();
            } else {
                raw[0x28] |= 0x40;
            }
            for (position, block) in blocks.iter().enumerate() {
                let start = position * BLOCK;
                let end = data.len().min(start + BLOCK);
                let mut bytes = data[start..end].to_vec();
                bytes.resize(BLOCK, 0);
                contents.insert(*block, bytes);
                let following = blocks.get(position + 1).copied().unwrap_or(END);
                if self.allocation != Allocation::ContiguousWithoutPointers {
                    next.insert(*block, following);
                }
            }
            raw[0x29..0x2c].copy_from_slice(&count.to_le_bytes()[..3]);
            raw[0x2c..0x2f].copy_from_slice(&count.to_le_bytes()[..3]);
            let first = blocks.first().copied().unwrap_or(0);
            raw[0x2f..0x32].copy_from_slice(&first.to_le_bytes()[..3]);
            raw[0x34..0x38].copy_from_slice(&(data.len() as u32).to_be_bytes());
            files.push(BuiltFile {
                path: path_of(&entries, index),
                blocks,
                entry_offset: data_offset_at(base, 0) as usize + index * 64,
            });
        }
        for block in 0..table_blocks {
            let start = block as usize * BLOCK;
            contents.insert(block, table[start..start + BLOCK].to_vec());
        }
        let total = self.total_blocks.max(free).max(1);
        let zero_hash = Sha1::digest([0_u8; BLOCK]);
        let mut segments = BTreeMap::new();
        let mut len = data_offset_at(base, total - 1) + BLOCK as u64;
        for (block, bytes) in &contents {
            segments.insert(data_offset_at(base, *block), bytes.clone());
        }
        let level0_count = u64::from(total).div_ceil(PER_TABLE);
        let mut level0_hashes = Vec::new();
        for table_index in 0..level0_count {
            let mut table = vec![0_u8; BLOCK];
            for slot in 0..PER_TABLE {
                let block = table_index * PER_TABLE + slot;
                if block >= u64::from(total) {
                    break;
                }
                let block = block as u32;
                let hash = contents.get(&block).map_or(zero_hash, Sha1::digest);
                let entry = &mut table[slot as usize * 0x18..slot as usize * 0x18 + 0x18];
                entry[..20].copy_from_slice(&hash);
                let info = 0x8000_0000 | next.get(&block).copied().unwrap_or(0);
                entry[20..24].copy_from_slice(&info.to_be_bytes());
            }
            level0_hashes.push(Sha1::digest(&table));
            let offset = level0_offset_at(base, (table_index * PER_TABLE) as u32);
            len = len.max(offset + BLOCK as u64);
            segments.insert(offset, table);
        }
        let top = if u64::from(total) <= PER_TABLE {
            level0_hashes[0]
        } else {
            let groups = u64::from(total).div_ceil(LEVEL_1);
            let mut level1_hashes = Vec::new();
            for group in 0..groups {
                let mut table = vec![0_u8; BLOCK];
                for (slot, hash) in level0_hashes
                    .iter()
                    .skip((group * PER_TABLE) as usize)
                    .take(PER_TABLE as usize)
                    .enumerate()
                {
                    table[slot * 0x18..slot * 0x18 + 20].copy_from_slice(hash);
                }
                level1_hashes.push(Sha1::digest(&table));
                let offset = level1_offset_at(base, group);
                len = len.max(offset + BLOCK as u64);
                segments.insert(offset, table);
            }
            if groups == 1 {
                level1_hashes[0]
            } else {
                let mut table = vec![0_u8; BLOCK];
                for (slot, hash) in level1_hashes.iter().enumerate() {
                    table[slot * 0x18..slot * 0x18 + 20].copy_from_slice(hash);
                }
                let hash = Sha1::digest(&table);
                len = len.max(level2_offset_at(base) + BLOCK as u64);
                segments.insert(level2_offset_at(base), table);
                hash
            }
        };

        let mut header = vec![0_u8; base as usize];
        header[..4].copy_from_slice(&self.magic);
        header[0x22c..0x23c].copy_from_slice(&self.licence);
        header[0x340..0x344].copy_from_slice(&self.header_size.to_be_bytes());
        header[0x344..0x348].copy_from_slice(&self.content_type.to_be_bytes());
        header[0x354..0x358].copy_from_slice(&self.media_id.to_be_bytes());
        header[0x358..0x35c].copy_from_slice(&self.version.to_be_bytes());
        header[0x360..0x364].copy_from_slice(&self.title_id.to_be_bytes());
        let descriptor = &mut header[0x379..0x379 + 0x24];
        descriptor[0] = 0x24;
        descriptor[2] = self.flags;
        descriptor[3..5].copy_from_slice(&(table_blocks as u16).to_le_bytes());
        descriptor[8..28].copy_from_slice(&top);
        descriptor[28..32].copy_from_slice(&total.to_be_bytes());
        header[0x3a9..0x3ad].copy_from_slice(&self.volume_type.to_be_bytes());
        let header_hash = Sha1::digest(&header[0x344..]);
        header[0x32c..0x340].copy_from_slice(&header_hash);
        segments.insert(0, header);
        Built {
            len,
            segments,
            files,
            total_blocks: total,
        }
    }

    pub(crate) fn bytes(&self) -> Vec<u8> {
        self.build().to_vec()
    }
}

/// Recompute the header hash after a deliberate header edit, so a test reaches the
/// check it targets instead of the header hash.
pub(crate) fn reseal_header(bytes: &mut [u8]) {
    let end = base_of(bytes) as usize;
    let hash = Sha1::digest(&bytes[0x344..end]);
    bytes[0x32c..0x340].copy_from_slice(&hash);
}

/// Recompute every hash covering one data block after a deliberate content edit: its
/// level-0 entry, the level-0 table's parent entry (or the top hash) and the header.
/// Only packages with at most one level-1 table are supported.
pub(crate) fn reseal_block(bytes: &mut [u8], block: u32, total_blocks: u32) {
    let base = base_of(bytes);
    let data = data_offset_at(base, block) as usize;
    let hash = Sha1::digest(&bytes[data..data + BLOCK]);
    let table = level0_offset_at(base, block) as usize;
    let slot = (u64::from(block) % PER_TABLE) as usize * 0x18;
    bytes[table + slot..table + slot + 20].copy_from_slice(&hash);
    let table_hash = Sha1::digest(&bytes[table..table + BLOCK]);
    if u64::from(total_blocks) <= PER_TABLE {
        bytes[0x379 + 8..0x379 + 28].copy_from_slice(&table_hash);
    } else {
        let level1 = level1_offset_at(base, 0) as usize;
        let slot = (u64::from(block) / PER_TABLE) as usize * 0x18;
        bytes[level1 + slot..level1 + slot + 20].copy_from_slice(&table_hash);
        let top = Sha1::digest(&bytes[level1..level1 + BLOCK]);
        bytes[0x379 + 8..0x379 + 28].copy_from_slice(&top);
    }
    reseal_header(bytes);
}

/// Replace a level-0 next pointer and reseal its table, keeping the hash tree valid.
pub(crate) fn set_next(bytes: &mut [u8], block: u32, next: u32, total_blocks: u32) {
    let base = base_of(bytes);
    let table = level0_offset_at(base, block) as usize;
    let slot = (u64::from(block) % PER_TABLE) as usize * 0x18;
    bytes[table + slot + 20..table + slot + 24]
        .copy_from_slice(&(0x8000_0000 | next).to_be_bytes());
    let table_hash = Sha1::digest(&bytes[table..table + BLOCK]);
    if u64::from(total_blocks) <= PER_TABLE {
        bytes[0x379 + 8..0x379 + 28].copy_from_slice(&table_hash);
    } else {
        let level1 = level1_offset_at(base, 0) as usize;
        let slot = (u64::from(block) / PER_TABLE) as usize * 0x18;
        bytes[level1 + slot..level1 + slot + 20].copy_from_slice(&table_hash);
        let top = Sha1::digest(&bytes[level1..level1 + BLOCK]);
        bytes[0x379 + 8..0x379 + 28].copy_from_slice(&top);
    }
    reseal_header(bytes);
}

/// A single-file LIVE package with the historical fixture layout (the 0xAD0E header):
/// level-0 table at 0xB000, file table at 0xC000 and `default.xex` from 0xD000.
pub(crate) fn single_file(payload: &[u8]) -> Vec<u8> {
    let mut builder = live(vec![file("default.xex", payload)]);
    builder.header_size = LARGE_HEADER_SIZE;
    builder.allocation = Allocation::Contiguous;
    builder.bytes()
}

/// Exact-digest packages that each break one check the earlier reader did not make.
/// An advisory read accepts every one with an advisory; an enforced read refuses it.
/// The 16 GiB cap needs a sparse file and is covered separately.
pub(crate) fn relaxed_cases() -> Vec<(&'static str, Vec<u8>)> {
    let tree = || {
        vec![
            file("default.xex", &[0x58; 2 * BLOCK + 9]),
            dir("Media", vec![file("a.bin", &[5_u8; 3000])]),
        ]
    };
    let mut cases = Vec::new();

    let mut descriptor = live(tree()).bytes();
    descriptor[0x379] = 0x23;
    reseal_header(&mut descriptor);
    cases.push(("volume descriptor length", descriptor));

    let mut small_header = live(tree());
    small_header.header_size = 0x380;
    cases.push(("header smaller than its fields", small_header.bytes()));

    let built = live(tree()).build();
    let mut levels = built.to_vec();
    levels[0x379 + 28..0x379 + 32].copy_from_slice(&(170_u32.pow(3) + 1).to_be_bytes());
    reseal_header(&mut levels);
    cases.push(("block count beyond three hash levels", levels));

    let mut oversized = built.to_vec();
    oversized[0x379 + 28..0x379 + 32].copy_from_slice(&(built.total_blocks + 64).to_be_bytes());
    reseal_header(&mut oversized);
    cases.push(("block count larger than the package", oversized));

    // A level-1 table exists once more than 170 blocks are allocated; the files use only
    // the first ones, so the earlier reader never read the truncated table.
    let mut level1 = live(tree());
    level1.total_blocks = 171;
    let mut truncated = level1.bytes();
    truncated.truncate(level1_offset(0) as usize + 100);
    cases.push(("truncated level-1 table", truncated));

    let mut contiguous = built.to_vec();
    let entry = built.file("default.xex").entry_offset;
    contiguous[entry + 0x28] |= 0x40;
    reseal_block(&mut contiguous, 0, built.total_blocks);
    cases.push(("contiguous flag on a chained file", contiguous));
    cases
}
