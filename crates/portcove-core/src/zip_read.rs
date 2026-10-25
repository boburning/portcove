//! Raw ZIP metadata bounds shared by packages and original-file snapshots.
use std::io::{Read, Seek, SeekFrom};

use crate::{PortcoveError, Result};

#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub bytes: u64,
    pub entries: usize,
    pub metadata: u64,
    pub zip64: bool,
    pub prefix: bool,
}

pub(crate) const CARTRIDGE: Limits = Limits {
    bytes: 1024 * 1024 * 1024,
    entries: 4096,
    metadata: 16 * 1024 * 1024,
    zip64: false,
    prefix: false,
};
pub(crate) const FILE_SET: Limits = Limits {
    bytes: 2 * 1024 * 1024 * 1024,
    zip64: true,
    prefix: true,
    ..CARTRIDGE
};
pub(crate) const ARTIFACT: Limits = Limits {
    bytes: 8 * 1024 * 1024 * 1024,
    entries: 100_000,
    metadata: 128 * 1024 * 1024,
    ..FILE_SET
};
pub(crate) const RUNTIME: Limits = Limits {
    bytes: 64 * 1024 * 1024 * 1024,
    ..FILE_SET
};

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::source(format!("unsupported ZIP: {message}"))
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes[offset..offset + 2]
            .try_into()
            .expect("fixed ZIP field"),
    )
}
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed ZIP field"),
    )
}
fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("fixed ZIP field"),
    )
}

struct Directory {
    floor: u64,
    prefix: u64,
    entries: usize,
    start: u64,
    footer: u64,
    zip64_record: Option<u64>,
}

/// This reader retains the very same handle used to admit the raw directory.
#[derive(Debug)]
pub(crate) struct CheckedReader<R = std::fs::File> {
    inner: R,
    floor: u64,
    constructing: bool,
    metadata: Vec<u8>,
    position: u64,
}

impl<R: Seek> CheckedReader<R> {
    pub(crate) fn into_inner(self) -> R {
        self.inner
    }
    fn check(&mut self) -> std::io::Result<()> {
        if self.constructing && self.position < self.floor {
            return Err(std::io::Error::other(
                "ZIP parser attempted metadata fallback outside the checked directory",
            ));
        }
        Ok(())
    }
}
impl<R: Read + Seek> Read for CheckedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.check()?;
        if self.constructing {
            let offset = (self.position - self.floor) as usize;
            let count = buffer.len().min(self.metadata.len().saturating_sub(offset));
            buffer[..count].copy_from_slice(&self.metadata[offset..offset + count]);
            self.position += count as u64;
            return Ok(count);
        }
        self.inner.read(buffer)
    }
}
impl<R: Seek> Seek for CheckedReader<R> {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        if self.constructing {
            let end = self.floor + self.metadata.len() as u64;
            let position = match position {
                SeekFrom::Start(position) => Some(position),
                SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
                SeekFrom::End(offset) => end.checked_add_signed(offset),
            }
            .filter(|position| *position <= end)
            .ok_or_else(|| std::io::Error::other("ZIP metadata seek escaped its snapshot"))?;
            self.position = position;
            self.check()?;
            return Ok(position);
        }
        let position = self.inner.seek(position)?;
        self.check()?;
        Ok(position)
    }
}

struct Constructing<'a, R> {
    inner: CheckedReader<R>,
    progress: &'a mut dyn FnMut(u64) -> Result<()>,
    failure: &'a mut Option<PortcoveError>,
    directory: &'a Directory,
    central_started: bool,
    footer_read: bool,
    zip64_read: bool,
}
impl<R> Constructing<'_, R> {
    fn checkpoint(&mut self) -> std::io::Result<()> {
        if self.failure.is_some() {
            return Err(std::io::Error::other("ZIP parsing remains interrupted"));
        }
        if let Err(error) = (self.progress)(0) {
            *self.failure = Some(error);
            return Err(std::io::Error::other("ZIP parsing interrupted"));
        }
        Ok(())
    }
}
impl<R: Read + Seek> Read for Constructing<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.checkpoint()?;
        if !self.central_started {
            let position = self.inner.position;
            let offset = position.saturating_sub(self.inner.floor) as usize;
            let magic = self.inner.metadata.get(offset..offset.saturating_add(4));
            // Pinned zip 9.1 reads fixed end blocks before decoding the directory.
            // Refuse other candidates without altering payload or comment bytes.
            let unadmitted = match (buffer.len(), magic) {
                (22, Some(b"PK\x05\x06")) => position != self.directory.footer,
                (56, Some(b"PK\x06\x06")) => Some(position) != self.directory.zip64_record,
                (20, Some(b"PK\x06\x07")) => {
                    position.checked_add(20) != Some(self.directory.footer)
                }
                _ => false,
            };
            let main_comment = self.footer_read && position >= self.directory.footer + 22;
            let zip64_extension = self.zip64_read
                && self.directory.zip64_record.is_some_and(|record| {
                    position >= record + 56 && position < self.directory.footer - 20
                });
            if unadmitted && !main_comment && !zip64_extension {
                return Err(std::io::Error::other(
                    "ZIP parser selected an unchecked end record",
                ));
            }
            if buffer.len() == 22 && position == self.directory.footer {
                self.footer_read = true;
            }
            if buffer.len() == 56 && Some(position) == self.directory.zip64_record {
                self.zip64_read = true;
            }
            if position == self.directory.start
                && buffer.len() == 46
                && magic == Some(b"PK\x01\x02")
            {
                self.central_started = true;
            }
        }
        self.inner.read(buffer)
    }
}
impl<R: Seek> Seek for Constructing<'_, R> {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.checkpoint()?;
        self.inner.seek(position)
    }
}

pub(crate) fn open<R: Read + Seek>(
    mut reader: R,
    limits: Limits,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<zip::ZipArchive<CheckedReader<R>>> {
    let directory = preflight(&mut reader, limits, progress, 0)?;
    let length = reader.seek(SeekFrom::End(0))?;
    let metadata_bytes = length
        .checked_sub(directory.floor)
        .filter(|bytes| *bytes <= limits.metadata + 65557 + 1024 + 76)
        .ok_or_else(|| invalid("metadata snapshot exceeds its size limit"))?;
    reader.seek(SeekFrom::Start(directory.floor))?;
    let mut metadata = vec![0; metadata_bytes as usize];
    for chunk in metadata.chunks_mut(64 * 1024) {
        progress(0)?;
        reader.read_exact(chunk)?;
    }
    let mut reader = CheckedReader {
        inner: reader,
        floor: directory.floor,
        constructing: true,
        metadata,
        position: length,
    };
    // Mutable originals cannot alter parser allocations after the raw check.
    let minimum_position = reader.floor;
    let directory = preflight(&mut reader, limits, progress, minimum_position)?;
    reader.seek(SeekFrom::End(0))?;
    let mut failure = None;
    let parsed = zip::ZipArchive::with_config(
        zip::read::Config {
            archive_offset: zip::read::ArchiveOffset::Known(directory.prefix),
        },
        Constructing {
            inner: reader,
            progress,
            failure: &mut failure,
            directory: &directory,
            central_started: false,
            footer_read: false,
            zip64_read: false,
        },
    );
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(error) => {
            return Err(failure.unwrap_or_else(|| invalid(&format!("invalid metadata: {error}"))));
        }
    };
    if parsed.central_directory_start() != directory.start || parsed.offset() != directory.prefix {
        return Err(invalid("parser selected an unchecked directory"));
    }
    if parsed.len() != directory.entries || parsed.has_duplicate_names() {
        return Err(invalid("duplicate effective member names"));
    }
    let metadata = parsed.metadata();
    let mut reader = parsed.into_inner().inner;
    if let Some(error) = failure {
        return Err(error);
    }
    reader.constructing = false;
    reader.metadata = Vec::new();
    // SAFETY: metadata and reader come from the same parsed archive; no handle,
    // bytes or offset is replaced while removing the borrowed checkpoint adapter.
    Ok(unsafe { zip::ZipArchive::unsafe_new_with_metadata(reader, metadata) })
}

fn signatures(
    reader: &mut (impl Read + Seek),
    start: u64,
    end: u64,
    needle: u32,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<Vec<u64>> {
    reader.seek(SeekFrom::Start(start))?;
    let mut matches = Vec::new();
    let mut signature = 0_u32;
    let mut position = start;
    let mut buffer = [0; 64 * 1024];
    while position < end {
        progress(0)?;
        let count = (end - position).min(buffer.len() as u64) as usize;
        reader.read_exact(&mut buffer[..count])?;
        for byte in &buffer[..count] {
            signature = (signature << 8) | u32::from(*byte);
            position += 1;
            if signature == needle && position >= start + 4 {
                matches.push(position - 4);
                if matches.len() > 1 {
                    return Err(invalid("ambiguous end records in directory metadata"));
                }
            }
        }
    }
    Ok(matches)
}

fn zip64_candidates(
    reader: &mut (impl Read + Seek),
    start: u64,
    end: u64,
    maximum: u64,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<Vec<u64>> {
    let mut candidates = Vec::new();
    let mut position = start;
    let mut signature = 0_u32;
    let mut buffer = [0; 64 * 1024];
    while position < end {
        progress(0)?;
        reader.seek(SeekFrom::Start(position))?;
        let count = (end - position).min(buffer.len() as u64) as usize;
        reader.read_exact(&mut buffer[..count])?;
        for byte in &buffer[..count] {
            signature = (signature << 8) | u32::from(*byte);
            position += 1;
            if signature != 0x504b0606 || position < start + 4 {
                continue;
            }
            let candidate = position - 4;
            if candidate.checked_add(56).is_none_or(|value| value > end) {
                continue;
            }
            progress(0)?;
            reader.seek(SeekFrom::Start(candidate + 4))?;
            let mut declared = [0; 8];
            reader.read_exact(&mut declared)?;
            let size = u64::from_le_bytes(declared);
            if size >= 44
                && size - 44 <= maximum
                && candidate
                    .checked_add(12)
                    .and_then(|value| value.checked_add(size))
                    == Some(end)
            {
                candidates.push(candidate);
                if candidates.len() > 1 {
                    return Err(invalid("ambiguous ZIP64 end records"));
                }
            }
        }
    }
    Ok(candidates)
}

fn preflight(
    reader: &mut (impl Read + Seek),
    limits: Limits,
    progress: &mut dyn FnMut(u64) -> Result<()>,
    minimum_position: u64,
) -> Result<Directory> {
    progress(0)?;
    let length = reader.seek(SeekFrom::End(0))?;
    if length > limits.bytes {
        return Err(invalid("container exceeds its size limit"));
    }
    if length < 22 {
        return Err(invalid("truncated end record"));
    }
    let tail_length = length.min(22 + u16::MAX as u64);
    reader.seek(SeekFrom::Start(length - tail_length))?;
    let mut tail = vec![0; tail_length as usize];
    reader.read_exact(&mut tail)?;
    let mut footers = tail.windows(4).enumerate().filter_map(|(offset, bytes)| {
        if bytes != b"PK\x05\x06" {
            return None;
        }
        let valid_extent = offset + 22 <= tail.len()
            && offset + 22 + usize::from(u16_at(&tail, offset + 20)) == tail.len();
        (!limits.prefix || valid_extent).then_some(offset)
    });
    let footer = footers
        .next()
        .ok_or_else(|| invalid("missing end record"))?;
    if footers.next().is_some() {
        return Err(invalid("ambiguous end records"));
    }
    let end = &tail[footer..];
    if end.len() < 22 || 22 + usize::from(u16_at(end, 20)) != end.len() {
        return Err(invalid("trailing or truncated end-record comment"));
    }
    let footer_position = length - tail_length + footer as u64;
    let mut count = u64::from(u16_at(end, 10));
    let mut size = u64::from(u32_at(end, 12));
    let mut relative_start = u64::from(u32_at(end, 16));
    let mut directory_end = footer_position;
    let mut extension_bytes = 0;
    let mut zip64_record = None;
    if u16_at(end, 4) != 0 || u16_at(end, 6) != 0 || u64::from(u16_at(end, 8)) != count {
        return Err(invalid("split archives are not supported"));
    }
    let locator = if footer_position >= 20 {
        reader.seek(SeekFrom::Start(footer_position - 20))?;
        let mut locator = [0; 20];
        reader.read_exact(&mut locator)?;
        (&locator[..4] == b"PK\x06\x07").then_some(locator)
    } else {
        None
    };
    if let Some(locator) = locator {
        if !limits.zip64 {
            return Err(invalid("ZIP64 is not supported for original-file ZIPs"));
        }
        if u32_at(&locator, 4) != 0 || u32_at(&locator, 16) != 1 {
            return Err(invalid("split ZIP64 archive"));
        }
        let locator_position = footer_position - 20;
        // The ZIP64 record can have an extension. Bound the search and its
        // declared body before zip allocates that extension from record_size.
        let candidates = zip64_candidates(
            reader,
            locator_position
                .saturating_sub(limits.metadata + 56)
                .max(minimum_position),
            locator_position,
            limits.metadata,
            progress,
        )?;
        let [record_position] = candidates.as_slice() else {
            return Err(invalid("missing ZIP64 end record"));
        };
        reader.seek(SeekFrom::Start(*record_position))?;
        let mut record = [0; 56];
        reader.read_exact(&mut record)?;
        let record_size = u64_at(&record, 4);
        if record_size < 44 || record_size - 44 > limits.metadata {
            return Err(invalid("ZIP64 metadata exceeds its size limit"));
        }
        if record_position
            .checked_add(12)
            .and_then(|value| value.checked_add(record_size))
            != Some(locator_position)
        {
            return Err(invalid("ZIP64 record bounds disagree with locator"));
        }
        if u32_at(&record, 16) != 0
            || u32_at(&record, 20) != 0
            || u64_at(&record, 24) != u64_at(&record, 32)
        {
            return Err(invalid("split ZIP64 archive"));
        }
        let expanded = [
            u64_at(&record, 32),
            u64_at(&record, 40),
            u64_at(&record, 48),
        ];
        for (ordinary, extended, sentinel) in [
            (count, expanded[0], u16::MAX as u64),
            (size, expanded[1], u32::MAX as u64),
            (relative_start, expanded[2], u32::MAX as u64),
        ] {
            if ordinary != sentinel && ordinary != extended {
                return Err(invalid("contradictory ZIP64 end records"));
            }
        }
        [count, size, relative_start] = expanded;
        directory_end = *record_position;
        zip64_record = Some(*record_position);
        extension_bytes = record_size - 44;
        let actual_start = directory_end
            .checked_sub(size)
            .ok_or_else(|| invalid("invalid directory bounds"))?;
        let prefix = actual_start
            .checked_sub(relative_start)
            .ok_or_else(|| invalid("invalid ZIP prefix"))?;
        if u64_at(&locator, 8).checked_add(prefix) != Some(*record_position) {
            return Err(invalid("ZIP64 locator points outside the checked record"));
        }
    } else if count == u16::MAX as u64
        || size == u32::MAX as u64
        || relative_start == u32::MAX as u64
    {
        return Err(invalid("ZIP64 end record is missing or unsupported"));
    }
    if count > limits.entries as u64 {
        return Err(invalid(
            "directory entry limit exceeded; source ZIP has too many entries",
        ));
    }
    if size
        .checked_add(extension_bytes)
        .is_none_or(|size| size > limits.metadata)
    {
        return Err(invalid(&format!(
            "directory metadata exceeds {} MiB",
            limits.metadata / (1024 * 1024)
        )));
    }
    let start = directory_end
        .checked_sub(size)
        .ok_or_else(|| invalid("directory bounds do not match the end record"))?;
    let prefix = start
        .checked_sub(relative_start)
        .ok_or_else(|| invalid("directory bounds do not match the end record"))?;
    if !limits.prefix && prefix != 0 {
        return Err(invalid("directory bounds do not match the end record"));
    }
    let floor = start.min(length - tail_length).saturating_sub(1024);
    if !limits.prefix
        && signatures(reader, floor, length, 0x504b0506, progress)? != [footer_position]
    {
        return Err(invalid("missing checked end record"));
    }
    reader.seek(SeekFrom::Start(start))?;
    let mut total_fields = 0_usize;
    for _ in 0..count {
        progress(0)?;
        let position = reader.stream_position()?;
        if position
            .checked_add(46)
            .is_none_or(|end| end > directory_end)
        {
            return Err(invalid("truncated directory header"));
        }
        let mut header = [0; 46];
        reader.read_exact(&mut header)?;
        if &header[..4] != b"PK\x01\x02" {
            return Err(invalid("invalid directory header"));
        }
        if u16_at(&header, 8) & !0x080e != 0 || !matches!(u16_at(&header, 10), 0 | 8) {
            return Err(invalid("encrypted or unsupported compression/flags"));
        }
        if u16_at(&header, 34) != 0 {
            return Err(invalid("split archive member"));
        }
        let extra_start = position + 46 + u64::from(u16_at(&header, 28));
        let extra_end = extra_start + u64::from(u16_at(&header, 30));
        let record_end = extra_end + u64::from(u16_at(&header, 32));
        if record_end > directory_end {
            return Err(invalid("variable directory metadata exceeds its bound"));
        }
        let mut local_offset = u64::from(u32_at(&header, 42));
        let needs_zip64 = [20, 24, 42]
            .into_iter()
            .any(|offset| u32_at(&header, offset) == u32::MAX);
        if needs_zip64 && !limits.zip64 {
            return Err(invalid("ZIP64 member is not supported"));
        }
        reader.seek(SeekFrom::Start(extra_start))?;
        let mut fields = 0;
        let mut found_zip64 = false;
        while reader.stream_position()? < extra_end {
            progress(0)?;
            fields += 1;
            total_fields += 1;
            if fields > 64 || total_fields > limits.entries.saturating_mul(4) {
                return Err(invalid("directory extra-field record limit exceeded"));
            }
            let position = reader.stream_position()?;
            if position + 4 > extra_end {
                return Err(invalid("truncated directory extra field"));
            }
            let mut field = [0; 4];
            reader.read_exact(&mut field)?;
            let tag = u16_at(&field, 0);
            let end = position + 4 + u64::from(u16_at(&field, 2));
            if end > extra_end {
                return Err(invalid("extra field exceeds its directory record"));
            }
            if tag == 0x9901 || (tag == 1 && !limits.zip64) {
                return Err(invalid("ZIP64/encryption extra field is not supported"));
            }
            if tag == 1 {
                if found_zip64 {
                    return Err(invalid("duplicate ZIP64 extra field"));
                }
                found_zip64 = true;
                for offset in [24, 20, 42] {
                    if u32_at(&header, offset) == u32::MAX {
                        if reader.stream_position()? + 8 > end {
                            return Err(invalid("truncated ZIP64 extra field"));
                        }
                        let mut value = [0; 8];
                        reader.read_exact(&mut value)?;
                        if offset == 42 {
                            local_offset = u64::from_le_bytes(value);
                        }
                    }
                }
            }
            reader.seek(SeekFrom::Start(end))?;
        }
        if needs_zip64 && !found_zip64 {
            return Err(invalid("ZIP64 member has no extended fields"));
        }
        if local_offset
            .checked_add(prefix)
            .is_none_or(|offset| offset >= start)
        {
            return Err(invalid("member header lies outside the data region"));
        }
        reader.seek(SeekFrom::Start(record_end))?;
    }
    if reader.stream_position()? != directory_end {
        return Err(invalid(
            "directory count does not cover its declared metadata",
        ));
    }
    Ok(Directory {
        floor,
        prefix,
        entries: count as usize,
        start,
        footer: footer_position,
        zip64_record,
    })
}

#[cfg(test)]
pub(crate) fn cartridge_preflight(
    file: &mut std::fs::File,
    maximum_entries: usize,
    progress: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<()> {
    preflight(
        file,
        Limits {
            entries: maximum_entries.min(CARTRIDGE.entries),
            ..CARTRIDGE
        },
        progress,
        0,
    )
    .map(|_| ())
}
