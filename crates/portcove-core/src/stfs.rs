//! Narrow, bounded extraction for read-only Xbox 360 STFS packages.
//!
//! Format facts follow the public Free60 STFS notes. Xenia (BSD) and darkuni's MIT
//! extractor were read as documentation only. The reader accepts the `LIVE` and `PIRS`
//! containers in the single-table ("read-only") layout and verifies the complete SHA-1
//! hash tree: the header hash, the top hash in the volume descriptor, every hash table
//! between it and level 0, and each data block read. Console-signed `CON` packages, the
//! two-table layout and SVOD volumes are refused with distinct reasons; each would add one
//! [`HashLayout`] or [`StfsPackageType`] arm rather than a second reader.
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use sha1::{Digest, Sha1};
use sha2::Sha256;

use crate::{PortcoveError, Result, StfsPackageType, failure::KnownFailureCause};

#[cfg(test)]
#[path = "stfs_fixtures.rs"]
pub(crate) mod fixtures;
#[cfg(test)]
#[path = "stfs_fuzz_tests.rs"]
mod fuzz_tests;
#[cfg(test)]
#[path = "stfs_tests.rs"]
mod tests;

/// Staged-source capability version that admits `runtime_stfs_package`, PIRS packages
/// and content-based STFS identity; older readers refuse such a definition.
pub(crate) const PACKAGE_BINDING_CAPABILITY: u32 = 32;
/// Upper bound on any accepted package and on a catalog `max_package_bytes`.
pub(crate) const MAX_PACKAGE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const BLOCK_SIZE: u64 = 0x1000;
const END_OF_CHAIN: u32 = 0x00ff_ffff;
const ENTRIES_PER_TABLE: u64 = 170;
const HASH_LEVEL_1: u64 = ENTRIES_PER_TABLE * ENTRIES_PER_TABLE;
const HASH_LEVEL_2: u64 = HASH_LEVEL_1 * ENTRIES_PER_TABLE;
const HASH_ENTRY_SIZE: u64 = 0x18;
const MAX_ENTRIES: usize = 16_384;
const MAX_DEPTH: usize = 64;
const MAX_EXPANDED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
/// The header SHA-1 at 0x32C covers 0x344 up to the first hash table (Free60). The
/// licence entries and the signature lie before it, so owners' copies can differ there.
const HEADER_HASH: u64 = 0x32c;
const HEADER_HASHED_FROM: u64 = 0x344;
const HEADER_SIZE: u64 = 0x340;
const CONTENT_TYPE: u64 = 0x344;
const MEDIA_ID: u64 = 0x354;
const VERSION: u64 = 0x358;
const BASE_VERSION: u64 = 0x35c;
const TITLE_ID: u64 = 0x360;
const DESCRIPTOR: u64 = 0x379;
const DESCRIPTOR_LENGTH: u8 = 0x24;
const VOLUME_TYPE: u64 = 0x3a9;
/// The last header field read; a smaller header cannot hold them.
const MINIMUM_HEADER_SIZE: u64 = VOLUME_TYPE + 4;

/// Facts read from the package header. The header hash binds them once the package has
/// been opened with [`open`]; [`read_header`] alone is an unverified preflight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Header {
    pub(crate) package_type: StfsPackageType,
    pub(crate) content_type: u32,
    pub(crate) title_id: u32,
    pub(crate) media_id: u32,
    pub(crate) version: u32,
    pub(crate) base_version: u32,
}

impl Header {
    pub(crate) fn title_id_hex(&self) -> String {
        format!("{:08X}", self.title_id)
    }

    pub(crate) fn content_type_hex(&self) -> String {
        format!("{:08X}", self.content_type)
    }
}

/// One extracted file of a fully verified package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PackageFile {
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

/// The result of a complete read-only validation: header facts, every file and any
/// hash-tree mismatches that an [`HashPolicy::Advisory`] read reported instead of
/// refusing. A summary with advisories is never a verified package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PackageSummary {
    pub(crate) header: Header,
    pub(crate) files: Vec<PackageFile>,
    pub(crate) hash_advisories: Vec<String>,
}

/// What a hash-tree mismatch does. Structural parsing and every safety bound are
/// enforced either way; only the SHA-1 header, table and block comparisons differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HashPolicy {
    /// Refuse the package. Used where the hash tree provides integrity: a content
    /// identity, and any port that declares an STFS package binding.
    Enforce,
    /// Report the mismatch as an advisory. Used only where an exact whole-package
    /// digest has already proven the bytes, so a disagreement with Portcove's reading of
    /// the format must not refuse a known package.
    Advisory,
}

/// At most this many distinct advisories are kept for one package.
const MAX_ADVISORIES: usize = 16;

impl PackageSummary {
    /// The SHA-256 of one extracted file, compared as a Windows path.
    pub(crate) fn file_sha256(&self, path: &str) -> Option<&str> {
        self.files
            .iter()
            .find(|file| file.path.eq_ignore_ascii_case(path))
            .map(|file| file.sha256.as_str())
    }
}

/// How the hash tables are laid out. Only the single-table layout is read; a two-table
/// layout would add its active-table selection here instead of guessing from contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HashLayout {
    SingleTable,
}

#[derive(Debug)]
struct Info {
    header: Header,
    layout: HashLayout,
    table_blocks: u16,
    first_table_block: u32,
    total_blocks: u32,
    data_base: u64,
    top_hash: [u8; 20],
}

#[derive(Debug)]
struct Entry {
    name: String,
    directory: bool,
    contiguous: bool,
    blocks: u32,
    first_block: u32,
    parent: u16,
    size: u64,
}

/// An opened package whose header hash and upper hash tables are checked. Level-0
/// tables are checked against their recorded digests whenever they are read; the policy
/// decides whether a mismatch refuses the package or becomes an advisory.
struct Package<'a> {
    input: &'a mut File,
    size: u64,
    info: Info,
    level0: Vec<[u8; 20]>,
    cached: Option<(u64, Box<[u8; BLOCK_SIZE as usize]>)>,
    policy: HashPolicy,
    advisories: Vec<String>,
}

fn unsupported(message: &str) -> PortcoveError {
    PortcoveError::source(message).with_known_cause(KnownFailureCause::UnsupportedStfs)
}

fn hash_failure(message: &str) -> PortcoveError {
    PortcoveError::verification(format!("STFS package failed its hash check: {message}"))
}

/// Check the catalog binding against the header before anything is extracted.
pub(crate) fn check_binding(
    header: &Header,
    source_size: u64,
    profile: &crate::StfsPackageProfile,
) -> Result<()> {
    if source_size > profile.max_package_bytes {
        return Err(unsupported("STFS package is larger than this port accepts")
            .detail("source_bytes", source_size.to_string())
            .detail("max_package_bytes", profile.max_package_bytes.to_string()));
    }
    let title = header.title_id_hex();
    let content_type = header.content_type_hex();
    let title_matches = profile
        .title_ids
        .iter()
        .any(|accepted| accepted.eq_ignore_ascii_case(&title));
    let type_matches = profile
        .content_types
        .iter()
        .any(|accepted| accepted.eq_ignore_ascii_case(&content_type));
    if !title_matches || !type_matches {
        let found = format!("title {title}, content type {content_type}");
        let expected = profile
            .title_ids
            .iter()
            .flat_map(|title| {
                profile
                    .content_types
                    .iter()
                    .map(move |kind| format!("title {title}, content type {kind}"))
            })
            .collect::<Vec<_>>();
        return Err(PortcoveError::source(
            "STFS package is a different game or content type than this port requires",
        )
        .with_known_cause(KnownFailureCause::StfsPackageMismatch { found, expected }));
    }
    Ok(())
}

/// Read the header and refuse unsupported containers without reading further.
pub(crate) fn read_header_from_path(source: &Path) -> Result<Header> {
    let size = std::fs::metadata(source)?.len();
    let mut input = File::open(source)?;
    Ok(parse_info(&mut input, size)?.header)
}

/// Extract a package. A declared binding always enforces the hash tree; otherwise the
/// caller's policy applies. Returns the hash advisories of an advisory read.
pub(crate) fn extract_with_checkpoint(
    source: &Path,
    destination: &Path,
    binding: Option<&crate::StfsPackageProfile>,
    policy: HashPolicy,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Vec<String>> {
    checkpoint()?;
    if destination.exists() {
        return Err(PortcoveError::state(
            "STFS extraction destination must be a new directory",
        ));
    }
    let source_size = std::fs::metadata(source)?.len();
    let mut input = File::open(source)?;
    if let Some(profile) = binding {
        let info = parse_info(&mut input, source_size)?;
        check_binding(&info.header, source_size, profile)?;
    }
    let policy = if binding.is_some() {
        HashPolicy::Enforce
    } else {
        policy
    };
    let mut package = open(&mut input, source_size, policy, checkpoint)?;
    let entries = package.entries(checkpoint)?;
    let plans = plan_entries(&entries, source_size, checkpoint)?;
    let expanded = validate_expanded_size(&entries, source_size)?;
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("STFS destination has no parent directory"))?;
    if expanded > fs4::available_space(parent)? {
        return Err(PortcoveError::state(
            "STFS package cannot fit in the available destination space",
        )
        .with_known_cause(KnownFailureCause::DestinationCapacity));
    }

    checkpoint()?;
    std::fs::create_dir(destination)?;
    for (entry, relative) in entries.iter().zip(plans) {
        checkpoint()?;
        let target = destination.join(relative);
        if entry.directory {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        checkpoint()?;
        let mut output = File::create(&target)?;
        package.read_entry(entry, checkpoint, |bytes| {
            output.write_all(bytes)?;
            Ok(())
        })?;
        checkpoint()?;
        output.sync_all()?;
    }
    checkpoint()?;
    Ok(package.advisories)
}

/// Validate the same bounded package structure, hash tree and file-block chains used by
/// extraction without creating destination files.
pub(crate) fn validate(
    source: &Path,
    policy: HashPolicy,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<PackageSummary> {
    let source_size = std::fs::metadata(source)?.len();
    let mut input = File::open(source)?;
    validate_reader(&mut input, source_size, policy, checkpoint)
}

/// Inspect a caller-owned handle without reopening its pathname.
pub(crate) fn validate_reader(
    input: &mut File,
    source_size: u64,
    policy: HashPolicy,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<PackageSummary> {
    checkpoint()?;
    let mut package = open(input, source_size, policy, checkpoint)?;
    checkpoint()?;
    let entries = package.entries(checkpoint)?;
    let plans = plan_entries(&entries, source_size, checkpoint)?;
    validate_expanded_size(&entries, source_size)?;
    let mut files = Vec::new();
    for (entry, relative) in entries.iter().zip(plans) {
        if entry.directory {
            continue;
        }
        let mut digest = Sha256::new();
        package.read_entry(entry, checkpoint, |bytes| {
            digest.update(bytes);
            Ok(())
        })?;
        files.push(PackageFile {
            path: relative.to_string_lossy().replace('\\', "/"),
            size: entry.size,
            sha256: hex::encode(digest.finalize()),
        });
    }
    checkpoint()?;
    Ok(PackageSummary {
        header: package.info.header,
        files,
        hash_advisories: package.advisories,
    })
}

fn validate_expanded_size(entries: &[Entry], source_size: u64) -> Result<u64> {
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
    Ok(expanded)
}

fn parse_info(input: &mut File, source_size: u64) -> Result<Info> {
    if source_size > MAX_PACKAGE_BYTES {
        return Err(unsupported("STFS package exceeds the 16 GiB safety limit"));
    }
    let magic = read_at::<4>(input, source_size, 0)?;
    let package_type = match &magic {
        b"LIVE" => StfsPackageType::Live,
        b"PIRS" => StfsPackageType::Pirs,
        b"CON " => {
            return Err(unsupported(
                "console-signed CON STFS packages are not supported yet",
            ));
        }
        _ => {
            return Err(unsupported(
                "runtime source is not an Xbox 360 STFS package",
            ));
        }
    };
    let header_size = u64::from(u32::from_be_bytes(read_at(
        input,
        source_size,
        HEADER_SIZE,
    )?));
    let volume_type = u32::from_be_bytes(read_at(input, source_size, VOLUME_TYPE)?);
    match volume_type {
        0 => {}
        1 => return Err(unsupported("SVOD packages are not supported yet")),
        _ => return Err(unsupported("STFS package has an unknown volume type")),
    }
    let descriptor = read_at::<0x24>(input, source_size, DESCRIPTOR)?;
    let flags = descriptor[2];
    let layout = if flags & 1 == 1 {
        HashLayout::SingleTable
    } else {
        return Err(unsupported("two-table STFS packages are not supported yet"));
    };
    let table_blocks = u16::from_le_bytes([descriptor[3], descriptor[4]]);
    let first_table_block = u24_le([descriptor[5], descriptor[6], descriptor[7]]);
    let top_hash: [u8; 20] = descriptor[8..28].try_into().expect("twenty bytes");
    let total_blocks = u32::from_be_bytes(descriptor[28..32].try_into().expect("four bytes"));
    let data_base = header_size
        .checked_add(BLOCK_SIZE - 1)
        .map(|value| value / BLOCK_SIZE * BLOCK_SIZE)
        .ok_or_else(|| PortcoveError::source("STFS header size overflowed"))?;
    if descriptor[0] != DESCRIPTOR_LENGTH
        || header_size < MINIMUM_HEADER_SIZE
        || table_blocks == 0
        || usize::from(table_blocks) > MAX_ENTRIES / 64
        || total_blocks == 0
        || u64::from(total_blocks) > HASH_LEVEL_2
        || first_table_block >= total_blocks
        || data_base >= source_size
        // Every allocated block needs its own four KiB in the package.
        || u64::from(total_blocks) > (source_size - data_base) / BLOCK_SIZE
    {
        return Err(unsupported(
            "STFS package has an unsupported or invalid volume descriptor",
        ));
    }
    let mut word = |offset: u64| -> Result<u32> {
        Ok(u32::from_be_bytes(read_at(input, source_size, offset)?))
    };
    let header = Header {
        package_type,
        content_type: word(CONTENT_TYPE)?,
        title_id: word(TITLE_ID)?,
        media_id: word(MEDIA_ID)?,
        version: word(VERSION)?,
        base_version: word(BASE_VERSION)?,
    };
    Ok(Info {
        header,
        layout,
        table_blocks,
        first_table_block,
        total_blocks,
        data_base,
        top_hash,
    })
}

/// Parse and verify the header hash and every hash table above level 0.
fn open<'a>(
    input: &'a mut File,
    source_size: u64,
    policy: HashPolicy,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Package<'a>> {
    let info = parse_info(input, source_size)?;
    checkpoint()?;
    let recorded = read_at::<20>(input, source_size, HEADER_HASH)?;
    let mut header_digest = Sha1::new();
    let mut chunk = [0_u8; BLOCK_SIZE as usize];
    let mut offset = HEADER_HASHED_FROM;
    while offset < info.data_base {
        checkpoint()?;
        let count = (info.data_base - offset).min(BLOCK_SIZE) as usize;
        read_exact_at(input, source_size, offset, &mut chunk[..count])?;
        header_digest.update(&chunk[..count]);
        offset += count as u64;
    }
    let header_matches = header_digest.finalize().as_slice() == recorded;
    let total = u64::from(info.total_blocks);
    let level0_tables = total.div_ceil(ENTRIES_PER_TABLE);
    let mut package = Package {
        input,
        size: source_size,
        info,
        level0: Vec::new(),
        cached: None,
        policy,
        advisories: Vec::new(),
    };
    if !header_matches {
        package.mismatch("the header does not match its recorded hash")?;
    }
    let top_hash = package.info.top_hash;
    if total <= ENTRIES_PER_TABLE {
        package.level0.push(top_hash);
    } else if total <= HASH_LEVEL_1 {
        let level1 = package.verified_table(package.level1_offset(0)?, &top_hash, "level 1")?;
        for table in 0..level0_tables {
            package.level0.push(entry_hash(&level1, table));
        }
    } else {
        let level2 = package.verified_table(package.level2_offset()?, &top_hash, "level 2")?;
        let level1_tables = total.div_ceil(HASH_LEVEL_1);
        for group in 0..level1_tables {
            checkpoint()?;
            let expected = entry_hash(&level2, group);
            let level1 =
                package.verified_table(package.level1_offset(group)?, &expected, "level 1")?;
            let first = group * ENTRIES_PER_TABLE;
            for table in first..level0_tables.min(first + ENTRIES_PER_TABLE) {
                package.level0.push(entry_hash(&level1, table));
            }
        }
    }
    Ok(package)
}

fn entry_hash(table: &[u8; BLOCK_SIZE as usize], index: u64) -> [u8; 20] {
    let start = ((index % ENTRIES_PER_TABLE) * HASH_ENTRY_SIZE) as usize;
    table[start..start + 20].try_into().expect("twenty bytes")
}

impl Package<'_> {
    /// Refuse a hash mismatch, or record it once under the advisory policy.
    fn mismatch(&mut self, message: &str) -> Result<()> {
        match self.policy {
            HashPolicy::Enforce => Err(hash_failure(message)),
            HashPolicy::Advisory => {
                if self.advisories.len() < MAX_ADVISORIES
                    && !self.advisories.iter().any(|known| known == message)
                {
                    self.advisories.push(message.to_owned());
                }
                Ok(())
            }
        }
    }

    fn verified_table(
        &mut self,
        offset: u64,
        expected: &[u8; 20],
        level: &str,
    ) -> Result<Box<[u8; BLOCK_SIZE as usize]>> {
        let mut table = Box::new([0_u8; BLOCK_SIZE as usize]);
        read_exact_at(self.input, self.size, offset, table.as_mut_slice())?;
        if Sha1::digest(table.as_slice()).as_slice() != expected {
            self.mismatch(&format!("a {level} hash table does not match its parent"))?;
        }
        Ok(table)
    }

    /// The verified level-0 hash entry for one data block.
    fn level0_entry(&mut self, block: u32) -> Result<[u8; HASH_ENTRY_SIZE as usize]> {
        if block >= self.info.total_blocks {
            return Err(PortcoveError::source(
                "STFS block number is outside the package",
            ));
        }
        let index = u64::from(block);
        let table = index / ENTRIES_PER_TABLE;
        if self
            .cached
            .as_ref()
            .is_none_or(|(cached, _)| *cached != table)
        {
            let expected = *self
                .level0
                .get(table as usize)
                .ok_or_else(|| PortcoveError::source("STFS block has no level-0 hash table"))?;
            let offset = self.level0_offset(block)?;
            let bytes = self.verified_table(offset, &expected, "level 0")?;
            self.cached = Some((table, bytes));
        }
        let (_, bytes) = self.cached.as_ref().expect("cached level-0 table");
        let start = ((index % ENTRIES_PER_TABLE) * HASH_ENTRY_SIZE) as usize;
        Ok(bytes[start..start + HASH_ENTRY_SIZE as usize]
            .try_into()
            .expect("hash entry"))
    }

    fn next_recorded(&mut self, block: u32) -> Result<u32> {
        let entry = self.level0_entry(block)?;
        Ok(u32::from_be_bytes(entry[20..24].try_into().expect("four bytes")) & END_OF_CHAIN)
    }

    /// Read one data block and verify it against its level-0 entry. A final block that
    /// the package file ends inside is zero-filled before hashing.
    fn read_block(&mut self, block: u32, bytes: &mut [u8; BLOCK_SIZE as usize]) -> Result<()> {
        let entry = self.level0_entry(block)?;
        let offset = self.data_offset(block)?;
        if offset >= self.size {
            return Err(PortcoveError::source("STFS package is truncated"));
        }
        let available = (self.size - offset).min(BLOCK_SIZE) as usize;
        bytes.fill(0);
        read_exact_at(self.input, self.size, offset, &mut bytes[..available])?;
        if Sha1::digest(bytes.as_slice()).as_slice() != &entry[..20] {
            self.mismatch("a data block does not match its level-0 hash")?;
        }
        Ok(())
    }

    fn entries(&mut self, checkpoint: &dyn Fn() -> Result<()>) -> Result<Vec<Entry>> {
        let mut entries = Vec::new();
        let mut table_block = self.info.first_table_block;
        let mut seen = HashSet::new();
        let mut bytes = [0_u8; BLOCK_SIZE as usize];
        for index in 0..self.info.table_blocks {
            checkpoint()?;
            if table_block == END_OF_CHAIN
                || table_block >= self.info.total_blocks
                || !seen.insert(table_block)
            {
                return Err(PortcoveError::source(
                    "STFS file-table block chain ended early or cycled",
                ));
            }
            self.read_block(table_block, &mut bytes)?;
            for raw in bytes.as_chunks::<64>().0 {
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
                    contiguous: name_flags & 0x40 != 0,
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
            if index + 1 < self.info.table_blocks {
                table_block = self.next_recorded(table_block)?;
            }
        }
        if entries.is_empty() {
            return Err(PortcoveError::source("STFS package has no file entries"));
        }
        Ok(entries)
    }

    /// Stream one file's verified bytes. A contiguous file's blocks follow one another;
    /// a recorded next pointer must then name the following block or be left empty.
    fn read_entry(
        &mut self,
        entry: &Entry,
        checkpoint: &dyn Fn() -> Result<()>,
        mut consume: impl FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let mut remaining = entry.size;
        let mut block = entry.first_block;
        let mut seen = HashSet::new();
        let mut bytes = [0_u8; BLOCK_SIZE as usize];
        while remaining > 0 {
            checkpoint()?;
            if block == END_OF_CHAIN || block >= self.info.total_blocks || !seen.insert(block) {
                return Err(PortcoveError::source(
                    "STFS file block chain ended early or cycled",
                ));
            }
            self.read_block(block, &mut bytes)?;
            let count = remaining.min(BLOCK_SIZE) as usize;
            checkpoint()?;
            consume(&bytes[..count])?;
            remaining -= count as u64;
            if remaining > 0 {
                let recorded = self.next_recorded(block)?;
                block = if entry.contiguous {
                    let following = block + 1;
                    if recorded != following && recorded != 0 {
                        return Err(PortcoveError::source(
                            "STFS contiguous file disagrees with its recorded block chain",
                        ));
                    }
                    following
                } else {
                    recorded
                };
            }
        }
        Ok(())
    }

    fn data_offset(&self, block_index: u32) -> Result<u64> {
        let HashLayout::SingleTable = self.info.layout;
        let index = u64::from(block_index);
        let mut physical = index;
        let mut level = ENTRIES_PER_TABLE;
        for _ in 0..3 {
            physical = physical
                .checked_add((index + level) / level)
                .ok_or_else(|| PortcoveError::source("STFS block offset overflowed"))?;
            if index < level {
                break;
            }
            level = level
                .checked_mul(ENTRIES_PER_TABLE)
                .ok_or_else(|| PortcoveError::source("STFS hash level overflowed"))?;
        }
        self.physical_offset(physical)
    }

    fn level0_offset(&self, block_index: u32) -> Result<u64> {
        let HashLayout::SingleTable = self.info.layout;
        let index = u64::from(block_index);
        let physical = if index < ENTRIES_PER_TABLE {
            0
        } else {
            let mut value = (index / ENTRIES_PER_TABLE) * (ENTRIES_PER_TABLE + 1);
            value += index / HASH_LEVEL_1 + 1;
            if index >= HASH_LEVEL_1 {
                value += 1;
            }
            value
        };
        self.physical_offset(physical)
    }

    /// The level-1 table covering one group of 170 level-0 tables.
    fn level1_offset(&self, group: u64) -> Result<u64> {
        let HashLayout::SingleTable = self.info.layout;
        let physical = if group == 0 {
            ENTRIES_PER_TABLE + 1
        } else {
            group * (HASH_LEVEL_1 + ENTRIES_PER_TABLE + 1) + 1
        };
        self.physical_offset(physical)
    }

    fn level2_offset(&self) -> Result<u64> {
        let HashLayout::SingleTable = self.info.layout;
        self.physical_offset(HASH_LEVEL_1 + ENTRIES_PER_TABLE + 1)
    }

    fn physical_offset(&self, physical: u64) -> Result<u64> {
        physical
            .checked_mul(BLOCK_SIZE)
            .and_then(|value| value.checked_add(self.info.data_base))
            .ok_or_else(|| PortcoveError::source("STFS block offset overflowed"))
    }
}

fn plan_entries(
    entries: &[Entry],
    source_size: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::with_capacity(entries.len());
    let mut collisions = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        checkpoint()?;
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
                || (entry.contiguous
                    && u64::from(entry.first_block) + required_blocks > u64::from(END_OF_CHAIN))
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
