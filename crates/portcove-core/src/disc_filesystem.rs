//! Bounded, read-only XDVDFS and ISO 9660 readers for managed disc-image unpacking.
//!
//! Implemented from ECMA-119 and the published XDVDFS layout. Nothing here writes
//! to, locks or modifies the source image. Every structural doubt is an error:
//! no entry is ever skipped silently.
#[cfg(test)]
#[path = "disc_filesystem_fixtures.rs"]
pub(crate) mod fixtures;
#[cfg(test)]
#[path = "disc_filesystem_fuzz_tests.rs"]
mod fuzz_tests;
#[cfg(test)]
#[path = "disc_filesystem_tests.rs"]
mod tests;

use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use crate::{DiscImageFormat, PortcoveError, Result, failure::KnownFailureCause};

pub(crate) const SECTOR: u64 = 2048;
/// Fixed ceiling for any disc-image profile; profiles declare a lower explicit limit.
pub(crate) const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_TABLE_BYTES: u64 = 4 * 1024 * 1024;
/// Total directory-table bytes read while planning, so many small folders that
/// all point at one large table cannot multiply the read and parse work.
const MAX_TOTAL_TABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 131_072;
const MAX_DEPTH: usize = 32;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const XDVDFS_MAGIC: &[u8; 20] = b"MICROSOFT*XBOX*MEDIA";
const XDVDFS_PARTITIONS: [u64; 4] = [0, 0x1830_0000, 0x0FD9_0000, 0x0208_0000];
const FREE_SPACE_FLOOR_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Extent {
    offset: u64,
    size: u64,
}

#[derive(Debug)]
struct Listed {
    name: String,
    directory: bool,
    extent: Extent,
}

#[derive(Debug)]
pub(crate) struct PlannedEntry {
    pub(crate) relative: PathBuf,
    pub(crate) directory: bool,
    pub(crate) size: u64,
    offset: u64,
}

/// Complete validated listing. Producing it writes nothing.
#[derive(Debug)]
pub(crate) struct DiscPlan {
    pub(crate) entries: Vec<PlannedEntry>,
    pub(crate) expanded_bytes: u64,
    pub(crate) image_bytes: u64,
}

fn invalid(message: impl Into<String>) -> PortcoveError {
    PortcoveError::source(message).with_known_cause(KnownFailureCause::UnsupportedDiscImage)
}

fn limit(message: impl Into<String>) -> PortcoveError {
    PortcoveError::source(message).with_known_cause(KnownFailureCause::DiscImageLimit)
}

fn read_error(error: std::io::Error) -> PortcoveError {
    if error.kind() == std::io::ErrorKind::UnexpectedEof {
        invalid("the disc image is truncated")
    } else {
        error.into()
    }
}

fn read_exact_at<R: Read + Seek>(input: &mut R, offset: u64, buffer: &mut [u8]) -> Result<()> {
    input.seek(SeekFrom::Start(offset))?;
    input.read_exact(buffer).map_err(read_error)
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes"))
}

fn be32(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(bytes[at..at + 4].try_into().expect("four bytes"))
}

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().expect("two bytes"))
}

fn component(raw: &[u8]) -> Result<String> {
    if raw.is_empty()
        || raw
            .iter()
            .any(|byte| !(0x20..0x7f).contains(byte) || matches!(byte, b'/' | b'\\'))
    {
        return Err(invalid(
            "the disc image contains a file name Portcove will not unpack",
        ));
    }
    Ok(String::from_utf8_lossy(raw).into_owned())
}

#[derive(Debug)]
struct Volume {
    format: DiscImageFormat,
    base: u64,
    volume_bytes: u64,
    root: Extent,
}

impl Volume {
    fn open<R: Read + Seek>(
        input: &mut R,
        image_bytes: u64,
        format: DiscImageFormat,
    ) -> Result<Self> {
        match format {
            DiscImageFormat::Xdvdfs => Self::open_xdvdfs(input, image_bytes),
            DiscImageFormat::Iso9660 => Self::open_iso9660(input, image_bytes),
        }
    }

    fn open_xdvdfs<R: Read + Seek>(input: &mut R, image_bytes: u64) -> Result<Self> {
        let mut found = Vec::new();
        for base in XDVDFS_PARTITIONS {
            let descriptor = base + 32 * SECTOR;
            if descriptor + SECTOR > image_bytes {
                continue;
            }
            let mut sector = [0_u8; SECTOR as usize];
            read_exact_at(input, descriptor, &mut sector)?;
            if &sector[..20] == XDVDFS_MAGIC && &sector[0x7ec..0x7ec + 20] == XDVDFS_MAGIC {
                found.push((base, le32(&sector, 20), le32(&sector, 24)));
            }
        }
        let [(base, root_sector, root_size)] = found[..] else {
            return Err(invalid(if found.is_empty() {
                "the file is not an Xbox or Xbox 360 disc image"
            } else {
                "the disc image has more than one Xbox volume descriptor"
            }));
        };
        let root = Extent {
            offset: base + u64::from(root_sector) * SECTOR,
            size: u64::from(root_size),
        };
        Ok(Self {
            format: DiscImageFormat::Xdvdfs,
            base,
            volume_bytes: image_bytes,
            root,
        })
    }

    fn open_iso9660<R: Read + Seek>(input: &mut R, image_bytes: u64) -> Result<Self> {
        if 17 * SECTOR > image_bytes {
            return Err(invalid("the file is not an ISO 9660 disc image"));
        }
        let mut sector = [0_u8; SECTOR as usize];
        read_exact_at(input, 16 * SECTOR, &mut sector)?;
        if sector[0] != 1 || &sector[1..6] != b"CD001" || sector[6] != 1 {
            return Err(invalid("the file is not an ISO 9660 disc image"));
        }
        let block_size = le16(&sector, 128);
        if u64::from(block_size) != SECTOR || sector[128..130] != [sector[131], sector[130]] {
            return Err(invalid("the disc image does not use 2048-byte sectors"));
        }
        if le32(&sector, 80) != be32(&sector, 84) {
            return Err(invalid("the disc image has an inconsistent volume size"));
        }
        let volume_bytes = u64::from(le32(&sector, 80)) * SECTOR;
        if volume_bytes == 0 || volume_bytes > image_bytes {
            return Err(invalid("the disc image is truncated"));
        }
        let record = parse_iso_record(&sector[156..190])?;
        if !record.directory {
            return Err(invalid("the disc image has an invalid root directory"));
        }
        let root = record.extent;
        if root.size == 0 || root.offset + root.size > volume_bytes {
            return Err(invalid("the disc image has an invalid root directory"));
        }
        Ok(Self {
            format: DiscImageFormat::Iso9660,
            base: 0,
            volume_bytes,
            root,
        })
    }

    fn list<R: Read + Seek>(
        &self,
        input: &mut R,
        directory: Extent,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<Vec<Listed>> {
        checkpoint()?;
        if directory.size == 0 {
            return Ok(Vec::new());
        }
        if directory.size > MAX_TABLE_BYTES {
            return Err(limit("a directory table in the disc image is too large"));
        }
        if directory
            .offset
            .checked_add(directory.size)
            .is_none_or(|end| end > self.volume_bytes)
        {
            return Err(invalid(
                "a directory table extends past the end of the disc image",
            ));
        }
        let mut table = vec![0_u8; directory.size as usize];
        read_exact_at(input, directory.offset, &mut table)?;
        checkpoint()?;
        match self.format {
            DiscImageFormat::Xdvdfs => self.list_xdvdfs(&table),
            DiscImageFormat::Iso9660 => list_iso9660(&table),
        }
    }

    fn list_xdvdfs(&self, table: &[u8]) -> Result<Vec<Listed>> {
        let mut listed = Vec::new();
        if table.len() >= 2 && table[0] == 0xff && table[1] == 0xff {
            return Ok(listed);
        }
        let mut seen = HashSet::new();
        let mut pending = vec![0_usize];
        while let Some(at) = pending.pop() {
            if !seen.insert(at) {
                return Err(invalid(
                    "a directory in the disc image refers back to itself",
                ));
            }
            if at.checked_add(14).is_none_or(|end| end > table.len()) {
                return Err(invalid("a directory entry extends past its table"));
            }
            let left = usize::from(le16(table, at)) * 4;
            let right = usize::from(le16(table, at + 2)) * 4;
            let sector = le32(table, at + 4);
            let size = le32(table, at + 8);
            let attributes = table[at + 12];
            let name_length = usize::from(table[at + 13]);
            if name_length == 0 || at + 14 + name_length > table.len() {
                return Err(invalid("a directory entry has an invalid name"));
            }
            let name = component(&table[at + 14..at + 14 + name_length])?;
            let directory = attributes & 0x10 != 0;
            listed.push(Listed {
                name,
                directory,
                extent: Extent {
                    offset: self.base + u64::from(sector) * SECTOR,
                    size: u64::from(size),
                },
            });
            if listed.len() > MAX_ENTRIES {
                return Err(limit("the disc image contains too many entries"));
            }
            for child in [left, right] {
                if child != 0 {
                    pending.push(child);
                }
            }
        }
        Ok(listed)
    }
}

struct IsoRecord {
    name: Vec<u8>,
    directory: bool,
    extent: Extent,
}

fn parse_iso_record(record: &[u8]) -> Result<IsoRecord> {
    if record.len() < 34 || record.len() < 33 + usize::from(record[32]) {
        return Err(invalid("a directory record is malformed"));
    }
    if le32(record, 2) != be32(record, 6) || le32(record, 10) != be32(record, 14) {
        return Err(invalid("a directory record has inconsistent fields"));
    }
    let flags = record[25];
    if flags & 0x80 != 0 {
        return Err(invalid(
            "the disc image contains a multi-extent file, which Portcove does not unpack",
        ));
    }
    if record[26] != 0 || record[27] != 0 {
        return Err(invalid(
            "the disc image contains an interleaved file, which Portcove does not unpack",
        ));
    }
    let name_length = usize::from(record[32]);
    // Bytes after the name are a system-use area. Only a CD-XA tail, a chain of
    // well-formed SUSP/Rock Ridge entries, or plain zero padding (as Sony PS2
    // mastering writes) that exactly fills the record is accepted. A zero area
    // holds no data, and a following record starts with a non-zero length, so a
    // corrupted length can never swallow the records after it.
    let minimal = (33 + name_length).div_ceil(2) * 2;
    if record.len() < minimal {
        // An even-length identifier must be followed by its pad byte.
        return Err(invalid("a directory record is malformed"));
    }
    if record.len() != minimal {
        let area = record.get(minimal..).unwrap_or_default();
        let xa_tail = area.len() == 14 && &area[6..8] == b"XA";
        let zero_padding = area.iter().all(|byte| *byte == 0);
        if !xa_tail && !zero_padding && !is_susp_chain(area) {
            return Err(invalid(
                "a directory record has a system-use area Portcove cannot read",
            ));
        }
    }
    Ok(IsoRecord {
        name: record[33..33 + name_length].to_vec(),
        directory: flags & 0x02 != 0,
        extent: Extent {
            offset: (u64::from(le32(record, 2)) + u64::from(record[1])) * SECTOR,
            size: u64::from(le32(record, 10)),
        },
    })
}

/// True when `area` is entirely consecutive SUSP entries (two capital letters,
/// a length of at least four, a version), as Rock Ridge writes them.
fn is_susp_chain(area: &[u8]) -> bool {
    let mut at = 0;
    while at < area.len() {
        let Some(entry) = area.get(at..at + 4) else {
            return false;
        };
        let length = usize::from(entry[2]);
        if !entry[..2].iter().all(u8::is_ascii_uppercase) || length < 4 || at + length > area.len()
        {
            return false;
        }
        at += length;
    }
    !area.is_empty()
}

fn list_iso9660(table: &[u8]) -> Result<Vec<Listed>> {
    let mut listed = Vec::new();
    let mut at = 0_usize;
    while at < table.len() {
        let length = usize::from(table[at]);
        if length == 0 {
            at = (at / SECTOR as usize + 1) * SECTOR as usize;
            continue;
        }
        if length < 34
            || at + length > table.len()
            || at % SECTOR as usize + length > SECTOR as usize
        {
            return Err(invalid("a directory record extends past its sector"));
        }
        let record = parse_iso_record(&table[at..at + length])?;
        at += length;
        if record.name == [0] || record.name == [1] {
            continue;
        }
        let mut name = record.name;
        if !record.directory {
            if let Some(semicolon) = name.iter().rposition(|byte| *byte == b';') {
                let version = &name[semicolon + 1..];
                if version.is_empty()
                    || version.len() > 5
                    || !version.iter().all(u8::is_ascii_digit)
                {
                    return Err(invalid("a file has an invalid version suffix"));
                }
                name.truncate(semicolon);
            }
            if name.last() == Some(&b'.') {
                name.pop();
            }
        }
        listed.push(Listed {
            name: component(&name)?,
            directory: record.directory,
            extent: record.extent,
        });
        if listed.len() > MAX_ENTRIES {
            return Err(limit("the disc image contains too many entries"));
        }
    }
    Ok(listed)
}

/// An opened image: one read-only handle shared by planning, peeking and extraction.
pub(crate) struct DiscImage {
    input: File,
    volume: Volume,
    image_bytes: u64,
}

impl DiscImage {
    pub(crate) fn open(
        source: &Path,
        format: DiscImageFormat,
        max_image_bytes: u64,
    ) -> Result<Self> {
        let input = File::open(source)?;
        let image_bytes = input.metadata()?.len();
        Self::from_file(input, image_bytes, format, max_image_bytes)
    }

    fn from_file(
        mut input: File,
        image_bytes: u64,
        format: DiscImageFormat,
        max_image_bytes: u64,
    ) -> Result<Self> {
        if image_bytes > max_image_bytes.min(MAX_IMAGE_BYTES) {
            return Err(limit("the disc image is larger than this port allows"));
        }
        let volume = Volume::open(&mut input, image_bytes, format)?;
        Ok(Self {
            input,
            volume,
            image_bytes,
        })
    }

    /// Read up to `max_bytes` from the start of one file named by a slash path,
    /// matched case-insensitively. `Ok(None)` means the file is absent.
    pub(crate) fn read_root_file(
        &mut self,
        path: &str,
        max_bytes: u64,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<Option<Vec<u8>>> {
        let mut directory = self.volume.root;
        let mut parts = path.split('/').peekable();
        while let Some(part) = parts.next() {
            let last = parts.peek().is_none();
            let listed = self.volume.list(&mut self.input, directory, checkpoint)?;
            let mut matches = listed
                .into_iter()
                .filter(|item| item.name.eq_ignore_ascii_case(part));
            let Some(item) = matches.next() else {
                return Ok(None);
            };
            if matches.next().is_some() {
                return Err(invalid("the disc image has ambiguous file names"));
            }
            if item.directory == last {
                return Ok(None);
            }
            if last {
                let count = item.extent.size.min(max_bytes);
                if item
                    .extent
                    .offset
                    .checked_add(item.extent.size)
                    .is_none_or(|end| end > self.volume.volume_bytes)
                {
                    return Err(invalid("a file extends past the end of the disc image"));
                }
                let mut bytes = vec![0_u8; count as usize];
                read_exact_at(&mut self.input, item.extent.offset, &mut bytes)?;
                return Ok(Some(bytes));
            }
            directory = item.extent;
        }
        Ok(None)
    }

    /// Validate the whole file system without writing anything.
    pub(crate) fn plan(&mut self, checkpoint: &dyn Fn() -> Result<()>) -> Result<DiscPlan> {
        checkpoint()?;
        struct Raw {
            path: String,
            directory: bool,
            extent: Extent,
        }
        let mut raw: Vec<Raw> = Vec::new();
        let mut tables = HashSet::new();
        if self.volume.root.size > 0 {
            tables.insert(self.volume.root.offset);
        }
        let mut table_bytes = 0_u64;
        let mut stack = vec![(self.volume.root, String::new(), 0_usize)];
        while let Some((directory, prefix, depth)) = stack.pop() {
            table_bytes = table_bytes.saturating_add(directory.size);
            if table_bytes > MAX_TOTAL_TABLE_BYTES {
                return Err(limit("the disc image's folders are too large to unpack"));
            }
            for item in self.volume.list(&mut self.input, directory, checkpoint)? {
                if raw.len() >= MAX_ENTRIES {
                    return Err(limit("the disc image contains too many entries"));
                }
                let path = if prefix.is_empty() {
                    item.name.clone()
                } else {
                    format!("{prefix}/{}", item.name)
                };
                if item.directory {
                    if depth + 1 > MAX_DEPTH {
                        return Err(limit("the disc image nests folders too deeply"));
                    }
                    if item.extent.size > 0 && !tables.insert(item.extent.offset) {
                        return Err(invalid(
                            "folders in the disc image share or repeat a directory table",
                        ));
                    }
                    stack.push((item.extent, path.clone(), depth + 1));
                } else if item.extent.size > 0
                    && item
                        .extent
                        .offset
                        .checked_add(item.extent.size)
                        .is_none_or(|end| end > self.volume.volume_bytes)
                {
                    return Err(invalid("a file extends past the end of the disc image"));
                }
                raw.push(Raw {
                    path,
                    directory: item.directory,
                    extent: item.extent,
                });
            }
        }
        if raw.is_empty() {
            return Err(invalid("the disc image contains no files"));
        }

        let mut keys = HashSet::new();
        let mut entries = Vec::with_capacity(raw.len());
        let mut extents = Vec::new();
        let mut expanded = 0_u64;
        if self.volume.root.size > 0 {
            extents.push((self.volume.root, true));
        }
        for item in &raw {
            checkpoint()?;
            let (relative, key) =
                crate::archive::validate_relative_path(&item.path, item.directory)
                    .map_err(|error| invalid(error.message))?;
            if !keys.insert(key) {
                return Err(invalid(
                    "the disc image contains names that differ only by letter case",
                ));
            }
            if item.extent.size > 0 {
                extents.push((item.extent, item.directory));
            }
            if !item.directory {
                expanded = expanded
                    .checked_add(item.extent.size)
                    .ok_or_else(|| limit("the disc image expands past its size limit"))?;
            }
            entries.push(PlannedEntry {
                relative,
                directory: item.directory,
                size: if item.directory { 0 } else { item.extent.size },
                offset: item.extent.offset,
            });
        }
        if expanded > MAX_EXPANDED_BYTES || expanded > self.image_bytes {
            return Err(limit("the disc image expands past its size limit"));
        }
        // Exactly repeated file extents are harmless to a read-only source; any
        // other overlap, or any overlap with a directory table, is refused.
        extents.sort_by_key(|(extent, directory)| (extent.offset, extent.size, *directory));
        let mut previous: Option<(Extent, bool)> = None;
        for (extent, directory) in extents {
            if let Some((last, last_directory)) = previous {
                let overlaps = extent.offset < last.offset + last.size;
                let identical_files = !directory && !last_directory && extent == last;
                if overlaps && !identical_files {
                    return Err(invalid("files or folders in the disc image overlap"));
                }
            }
            previous = Some((extent, directory));
        }
        checkpoint()?;
        Ok(DiscPlan {
            entries,
            expanded_bytes: expanded,
            image_bytes: self.image_bytes,
        })
    }

    /// Create `destination` (which must not exist) and stream every planned
    /// file into it. `progress` receives (bytes written, bytes planned).
    pub(crate) fn extract(
        &mut self,
        plan: &DiscPlan,
        destination: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
        progress: &dyn Fn(u64, u64),
    ) -> Result<()> {
        checkpoint()?;
        if self.input.metadata()?.len() != plan.image_bytes {
            return Err(PortcoveError::conflict(
                "the disc image changed while it was being unpacked",
            )
            .with_known_cause(KnownFailureCause::SourceChanged));
        }
        std::fs::create_dir(destination)?;
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        let mut done = 0_u64;
        progress(0, plan.expanded_bytes);
        for entry in &plan.entries {
            checkpoint()?;
            let target = destination.join(&entry.relative);
            if entry.directory {
                std::fs::create_dir_all(&target)?;
                continue;
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut output = File::create_new(&target)?;
            self.input.seek(SeekFrom::Start(entry.offset))?;
            let mut remaining = entry.size;
            while remaining > 0 {
                checkpoint()?;
                let count = remaining.min(buffer.len() as u64) as usize;
                self.input
                    .read_exact(&mut buffer[..count])
                    .map_err(read_error)?;
                output.write_all(&buffer[..count])?;
                remaining -= count as u64;
                done += count as u64;
                progress(done, plan.expanded_bytes);
            }
            checkpoint()?;
        }
        checkpoint()
    }
}

/// Logical (expanded) size a CHD declares, read from its version 5 header so an
/// oversized or hostile CHD is refused before `chdman` writes anything.
pub(crate) fn chd_logical_bytes(source: &Path) -> Result<u64> {
    let mut header = [0_u8; 40];
    let mut input = File::open(source)?;
    input.read_exact(&mut header).map_err(read_error)?;
    if &header[..8] != b"MComprHD" || be32(&header, 12) != 5 {
        return Err(invalid("the CHD is not a version 5 compressed disc image"));
    }
    Ok(u64::from_be_bytes(
        header[32..40].try_into().expect("eight bytes"),
    ))
}

/// A compressed container Portcove can turn into a plain disc image itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiscContainer {
    /// Not a known container: read as the declared file-system format.
    Plain,
    /// PSP CSO (`CISO`), inflated by `expand_cso`.
    Cso,
}

/// Identify a CSO by its magic, regardless of extension. A `ZISO` (LZ4) image is a
/// recognised but unsupported container, refused rather than misread as plain.
pub(crate) fn sniff_container(source: &Path) -> Result<DiscContainer> {
    let mut magic = [0_u8; 4];
    let mut input = File::open(source)?;
    match input.read_exact(&mut magic) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Ok(DiscContainer::Plain);
        }
        Err(error) => return Err(error.into()),
    }
    match &magic {
        b"CISO" => Ok(DiscContainer::Cso),
        b"ZISO" => Err(invalid(
            "LZ4-compressed ZSO disc images are not supported; use a CSO or a plain ISO",
        )),
        _ => Ok(DiscContainer::Plain),
    }
}

const CSO_HEADER_BYTES: u64 = 24;
const CSO_MAX_INDEX_SHIFT: u8 = 8;

/// Header facts of a CSO, validated against the file it came from.
pub(crate) struct CsoHeader {
    pub(crate) total_bytes: u64,
    block_size: u64,
    index_shift: u8,
    blocks: u64,
    file_bytes: u64,
}

/// Read and validate a version 0/1 CSO header before anything is written, so an
/// oversized or hostile image is refused up front.
pub(crate) fn cso_header(source: &Path) -> Result<CsoHeader> {
    let mut input = File::open(source)?;
    let file_bytes = input.metadata()?.len();
    let mut header = [0_u8; CSO_HEADER_BYTES as usize];
    input.read_exact(&mut header).map_err(read_error)?;
    if &header[..4] != b"CISO" || le32(&header, 4) as u64 != CSO_HEADER_BYTES {
        return Err(invalid("the CSO header is not recognised"));
    }
    let total_bytes = u64::from_le_bytes(header[8..16].try_into().expect("eight bytes"));
    let block_size = u64::from(le32(&header, 16));
    let version = header[20];
    let index_shift = header[21];
    if version > 1 || index_shift > CSO_MAX_INDEX_SHIFT {
        return Err(invalid("the CSO version is not supported"));
    }
    if !(SECTOR..=65_536).contains(&block_size) || !block_size.is_power_of_two() {
        return Err(invalid("the CSO block size is not supported"));
    }
    if total_bytes == 0 || total_bytes % SECTOR != 0 {
        return Err(invalid("the CSO declares an invalid size"));
    }
    if total_bytes > MAX_IMAGE_BYTES {
        return Err(limit("the disc image is larger than this port allows"));
    }
    Ok(CsoHeader {
        total_bytes,
        block_size,
        index_shift,
        blocks: total_bytes.div_ceil(block_size),
        file_bytes,
    })
}

/// Inflate a CSO into a new plain image at `target` (which must not exist) and
/// return its size. Every block is bounds-checked against the index and the file;
/// a block that inflates to less than its size (only the final block may be padded past the
/// image end), an index that runs backwards or past
/// the file, or a truncated file is an error, never silently padded.
pub(crate) fn expand_cso(
    source: &Path,
    header: &CsoHeader,
    target: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<u64> {
    let mut input = File::open(source)?;
    if input.metadata()?.len() != header.file_bytes {
        return Err(
            PortcoveError::conflict("the disc image changed while it was being read")
                .with_known_cause(KnownFailureCause::SourceChanged),
        );
    }
    let entries = header.blocks + 1;
    let index_bytes = entries * 4;
    if CSO_HEADER_BYTES + index_bytes > header.file_bytes {
        return Err(invalid("the CSO index is truncated"));
    }
    let mut raw_index = vec![0_u8; index_bytes as usize];
    read_exact_at(&mut input, CSO_HEADER_BYTES, &mut raw_index)?;
    // index_bytes is a whole number of four-byte entries, so no remainder.
    let (entries_le, _) = raw_index.as_chunks::<4>();
    let index: Vec<u32> = entries_le
        .iter()
        .map(|entry| u32::from_le_bytes(*entry))
        .collect();
    drop(raw_index);
    let offset_of = |entry: u32| u64::from(entry & 0x7FFF_FFFF) << header.index_shift;
    let data_start = CSO_HEADER_BYTES + index_bytes;
    let mut output = File::create_new(target)?;
    let mut compressed = Vec::new();
    // One spare byte so a block that inflates past its size is detected.
    let mut block = vec![0_u8; header.block_size as usize + 1];
    let mut remaining = header.total_bytes;
    input.seek(SeekFrom::Start(data_start))?;
    for number in 0..header.blocks as usize {
        if number % 64 == 0 {
            checkpoint()?;
        }
        let (start, end) = (offset_of(index[number]), offset_of(index[number + 1]));
        if start < data_start || end <= start || end > header.file_bytes {
            return Err(invalid("the CSO index is invalid"));
        }
        let length = end - start;
        if length > header.block_size.saturating_mul(2) {
            return Err(invalid("a CSO block is larger than its block size allows"));
        }
        compressed.resize(length as usize, 0);
        read_exact_at(&mut input, start, &mut compressed)?;
        let want = remaining.min(header.block_size) as usize;
        let plain = index[number] & 0x8000_0000 != 0;
        let produced = if plain {
            // A stored block holds exactly one block of data (the last may be padded).
            if length < want as u64 || length > header.block_size {
                return Err(invalid("a stored CSO block has the wrong size"));
            }
            block[..want].copy_from_slice(&compressed[..want]);
            want
        } else {
            let mut decoder = flate2::read::DeflateDecoder::new(compressed.as_slice())
                .take(header.block_size + 1);
            let mut produced = 0_usize;
            loop {
                let read = decoder
                    .read(&mut block[produced..])
                    .map_err(|_| invalid("a CSO block is not valid compressed data"))?;
                if read == 0 {
                    break;
                }
                produced += read;
                if produced > header.block_size as usize {
                    break;
                }
            }
            if produced < want || produced > header.block_size as usize {
                return Err(invalid("a CSO block inflated to the wrong size"));
            }
            want
        };
        output.write_all(&block[..produced])?;
        remaining -= produced as u64;
    }
    if remaining != 0 {
        return Err(invalid("the CSO ended before its declared size"));
    }
    checkpoint()?;
    Ok(header.total_bytes)
}

/// Whether a version 5 CHD holds a CD (track metadata) rather than a DVD, read from
/// its bounded metadata chain. A CHD with neither kind of metadata is refused, because
/// `chdman` would still expand it into something that is not an ISO.
pub(crate) fn chd_is_cd(source: &Path) -> Result<bool> {
    let mut input = File::open(source)?;
    let file_bytes = input.metadata()?.len();
    let mut header = [0_u8; 56];
    input.read_exact(&mut header).map_err(read_error)?;
    if &header[..8] != b"MComprHD" || be32(&header, 12) != 5 {
        return Err(invalid("the CHD is not a version 5 compressed disc image"));
    }
    let mut next = u64::from_be_bytes(header[48..56].try_into().expect("eight bytes"));
    let (mut cd, mut dvd) = (false, false);
    let mut ended = false;
    for _ in 0..64 {
        if next == 0 {
            ended = true;
            break;
        }
        if next.saturating_add(16) > file_bytes {
            return Err(invalid("the CHD metadata is truncated"));
        }
        let mut entry = [0_u8; 16];
        read_exact_at(&mut input, next, &mut entry)?;
        match &entry[..4] {
            b"CHT2" | b"CHTR" | b"CHCD" | b"CHGT" | b"CHGD" => cd = true,
            b"DVD " => dvd = true,
            _ => {}
        }
        let following = u64::from_be_bytes(entry[8..16].try_into().expect("eight bytes"));
        next = following;
    }
    if !ended && next != 0 {
        return Err(invalid("the CHD has too much metadata to classify"));
    }
    match (cd, dvd) {
        (true, false) => Ok(true),
        (false, true) => Ok(false),
        _ => Err(invalid("the CHD is not a single CD or DVD image")),
    }
}

/// How the first data track of a CD image stores its 2048-byte sectors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CdTrackMode {
    /// `MODE1/2048`: the sectors are already the ISO.
    Mode1Cooked,
    /// `MODE1/2352`: user data after a 16-byte header.
    Mode1Raw,
    /// `MODE2/2352`, form 1: user data after a 24-byte header and subheader.
    Mode2Form1Raw,
}

/// The data file and mode of track 1 from a `chdman`-written cue sheet.
pub(crate) fn first_cd_track(cue: &str) -> Result<(String, CdTrackMode)> {
    let mut file = None;
    for line in cue.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("FILE ") {
            if file.is_some() {
                break;
            }
            let name = rest
                .strip_prefix('"')
                .and_then(|rest| rest.split_once('"'))
                .map(|(name, kind)| (name, kind.trim()));
            match name {
                Some((name, "BINARY")) if !name.is_empty() => file = Some(name.to_owned()),
                _ => return Err(invalid("the CD image's cue sheet is not recognised")),
            }
        } else if let Some(rest) = line.strip_prefix("TRACK ") {
            let mut parts = rest.split_whitespace();
            let (number, mode) = (parts.next(), parts.next());
            if number != Some("01") {
                return Err(invalid("the CD image does not start with track 1"));
            }
            let mode = match mode {
                Some("MODE1/2048") => CdTrackMode::Mode1Cooked,
                Some("MODE1/2352") => CdTrackMode::Mode1Raw,
                Some("MODE2/2352") => CdTrackMode::Mode2Form1Raw,
                _ => {
                    return Err(invalid(
                        "the CD image's first track is not a data track Portcove can read",
                    ));
                }
            };
            let file = file.ok_or_else(|| invalid("the CD image's cue sheet is not recognised"))?;
            if file.contains(['/', '\\', ':']) || file == ".." || file == "." {
                return Err(invalid("the CD image's cue sheet names an unsafe file"));
            }
            return Ok((file, mode));
        }
    }
    Err(invalid("the CD image's cue sheet has no data track"))
}

/// Convert a CD data track into a plain 2048-byte-sector image at `target` (which must
/// not exist) and return its size. Raw sectors are checked for the sync pattern, the
/// expected mode and (MODE2) form 1: nothing is guessed or padded.
pub(crate) fn cd_track_to_iso(
    track: &Path,
    mode: CdTrackMode,
    target: &Path,
    max_bytes: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<u64> {
    const RAW: usize = 2352;
    let mut input = File::open(track)?;
    let bytes = input.metadata()?.len();
    let stride = if mode == CdTrackMode::Mode1Cooked {
        SECTOR as usize
    } else {
        RAW
    };
    if bytes == 0 || bytes % stride as u64 != 0 {
        return Err(invalid("the CD track is not a whole number of sectors"));
    }
    let sectors = bytes / stride as u64;
    if sectors * SECTOR > max_bytes.min(MAX_IMAGE_BYTES) {
        return Err(limit("the disc image is larger than this port allows"));
    }
    let mut output = File::create_new(target)?;
    let mut buffer = vec![0_u8; stride * 256];
    let mut done = 0_u64;
    while done < sectors {
        checkpoint()?;
        let count = (sectors - done).min(256) as usize;
        input
            .read_exact(&mut buffer[..count * stride])
            .map_err(read_error)?;
        for sector in buffer[..count * stride].chunks_exact(stride) {
            let user = match mode {
                CdTrackMode::Mode1Cooked => sector,
                CdTrackMode::Mode1Raw | CdTrackMode::Mode2Form1Raw => {
                    if sector[..12] != [0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0] {
                        return Err(invalid("a CD sector is missing its sync pattern"));
                    }
                    if mode == CdTrackMode::Mode1Raw {
                        if sector[15] != 1 {
                            return Err(invalid("a CD sector is not MODE1"));
                        }
                        &sector[16..16 + SECTOR as usize]
                    } else {
                        // Subheader: file, channel, submode, coding, repeated; form 2 is
                        // 2324 data bytes and cannot be a 2048-byte sector.
                        if sector[15] != 2
                            || sector[16..20] != sector[20..24]
                            || sector[18] & 0x20 != 0
                        {
                            return Err(invalid("a CD sector is not MODE2 form 1"));
                        }
                        &sector[24..24 + SECTOR as usize]
                    }
                }
            };
            output.write_all(user)?;
        }
        done += count as u64;
    }
    checkpoint()?;
    Ok(sectors * SECTOR)
}

/// Bytes that must be free on the destination volume to unpack `expanded_bytes`.
pub(crate) fn required_free_bytes(expanded_bytes: u64) -> u64 {
    expanded_bytes.saturating_add(FREE_SPACE_FLOOR_BYTES.max(expanded_bytes / 32))
}

/// Refuse before writing when the destination volume cannot hold the unpacked tree.
pub(crate) fn ensure_free_space(parent: &Path, expanded_bytes: u64) -> Result<()> {
    let required = required_free_bytes(expanded_bytes);
    let available = fs4::available_space(parent)?;
    if required > available {
        let volume = parent
            .components()
            .next()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .unwrap_or_default();
        return Err(PortcoveError::state(
            "the disc image cannot be unpacked in the available destination space",
        )
        .detail("required_bytes", required.to_string())
        .detail("available_bytes", available.to_string())
        .with_known_cause(KnownFailureCause::DiscSpace {
            required_bytes: required,
            available_bytes: available,
            volume,
        }));
    }
    Ok(())
}
