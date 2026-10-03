//! Shared original-file and ZIP identity validation, with bounded scan hashing.
use crate::{Library, PortcoveError, Result, SourceProfile, SourceRecord};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek},
    path::Path,
};

pub(crate) struct HashBudget {
    pub operation: Option<crate::OperationCoordinator>,
    pub limit: u64,
    pub hashed: u64,
    pub max_zip_entries: usize,
}

impl HashBudget {
    pub fn reserve(&self, bytes: u64) -> Result<()> {
        if bytes > self.limit.saturating_sub(self.hashed) {
            return Err(
                PortcoveError::unsupported("source discovery hashing budget reached")
                    .detail("scan_limit", "hash_bytes"),
            );
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct FileIdentity {
    pub sha256: String,
    pub sha1: String,
    pub crc32: String,
    pub size: u64,
    pub storage_sha256: String,
    pub storage_size: u64,
    pub content_extension: String,
    pub archive_member: bool,
    pub archive_member_name: Option<String>,
    pub canonical_n64_sha256: Option<String>,
    pub canonical_n64_sha1: Option<String>,
    pub canonical_n64_size: Option<u64>,
}

impl FileIdentity {
    pub fn record(&self, profile: &SourceProfile, path: &Path) -> Result<SourceRecord> {
        validate_source_hashes(profile, &self.sha1, &self.sha256)?;
        Ok(SourceRecord {
            profile_id: profile.id.clone(),
            path: path.to_path_buf(),
            sha256: self.sha256.clone(),
            size: self.size,
            storage_sha256: self.storage_sha256.clone(),
            storage_size: self.storage_size,
            updated_at: Library::now(),
            observed_identity: None,
        })
    }
}

pub(crate) fn read_identity(
    path: &Path,
    extensions: &[String],
    maximum_size: u64,
    budget: &mut HashBudget,
) -> Result<FileIdentity> {
    crate::path::unicode(path, "source")?;
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(PortcoveError::source(format!(
            "source does not exist or is not a file: {}",
            path.display()
        )));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("zip") {
        read_zip_identity(path, extensions, maximum_size, budget)
    } else {
        if !extensions.is_empty()
            && !extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        {
            return Err(PortcoveError::source(format!(
                "source expects one of: {}, or a ZIP containing exactly one matching file",
                extensions.join(", ")
            )));
        }
        read_raw_identity(path, metadata.len(), maximum_size, budget)
    }
}

/// Original byte facts shared by directory-set and ordinary-file discovery.
pub(crate) fn read_raw_identity(
    path: &Path,
    expected: u64,
    maximum_size: u64,
    budget: &mut HashBudget,
) -> Result<FileIdentity> {
    crate::path::unicode(path, "source")?;
    read_raw_identity_from_reader(path, File::open(path)?, expected, maximum_size, budget)
}

/// Use the existing bounded hasher on a caller-owned stream, starting at byte zero.
pub(crate) fn read_raw_identity_from_reader(
    path: &Path,
    reader: impl Read,
    expected: u64,
    maximum_size: u64,
    budget: &mut HashBudget,
) -> Result<FileIdentity> {
    crate::path::unicode(path, "source")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let identity = hash_reader(reader, expected, maximum_size, budget, true)?;
    Ok(FileIdentity {
        storage_sha256: identity.sha256.clone(),
        storage_size: identity.size,
        sha256: identity.sha256,
        sha1: identity.sha1,
        crc32: identity.crc32,
        size: identity.size,
        content_extension: extension.to_ascii_lowercase(),
        archive_member: false,
        archive_member_name: None,
        canonical_n64_sha256: identity.canonical_n64_sha256,
        canonical_n64_sha1: identity.canonical_n64_sha1,
        canonical_n64_size: identity.canonical_n64_size,
    })
}

fn read_zip_identity(
    path: &Path,
    extensions: &[String],
    maximum_size: u64,
    budget: &mut HashBudget,
) -> Result<FileIdentity> {
    let file = File::open(path)?;
    // Bind length to the same opened artifact as both digest passes.
    let storage_size = file.metadata()?.len();
    read_zip_identity_from_file(file, extensions, maximum_size, storage_size, budget)
}

fn read_zip_identity_from_file(
    file: File,
    extensions: &[String],
    maximum_size: u64,
    storage_size: u64,
    budget: &mut HashBudget,
) -> Result<FileIdentity> {
    if storage_size > maximum_size {
        return Err(
            PortcoveError::source("source container exceeds its size limit")
                .detail("scan_limit", "file_size"),
        );
    }
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| PortcoveError::source(format!("invalid source ZIP: {error}")))?;
    if archive.len() > budget.max_zip_entries {
        return Err(PortcoveError::source(
            "source ZIP has too many entries for discovery",
        ));
    }
    let index = single_zip_source_index(&mut archive, extensions)?;
    let entry = archive
        .by_index(index)
        .map_err(|error| PortcoveError::source(format!("invalid source ZIP entry: {error}")))?;
    let archive_member_name = entry.name().to_owned();
    let content_extension = Path::new(&archive_member_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let expected = entry.size();
    if expected > maximum_size.min(512 * 1024 * 1024) {
        return Err(
            PortcoveError::source("expanded source exceeds its size limit")
                .detail("scan_limit", "file_size"),
        );
    }
    budget.reserve(
        expected
            .checked_add(storage_size)
            .ok_or_else(|| PortcoveError::source("source ZIP size overflowed"))?,
    )?;
    let identity = hash_reader(
        entry,
        expected,
        maximum_size.min(512 * 1024 * 1024),
        budget,
        true,
    )?;
    // The outer archive is retained as storage identity only. Its member receives
    // the full content-identity treatment above.
    let mut storage_file = archive.into_inner();
    storage_file.rewind()?;
    let storage = hash_storage_reader(storage_file, storage_size, maximum_size, budget)?;
    Ok(FileIdentity {
        sha256: identity.sha256,
        sha1: identity.sha1,
        crc32: identity.crc32,
        size: identity.size,
        storage_sha256: storage.sha256,
        storage_size: storage.size,
        content_extension,
        archive_member: true,
        archive_member_name: Some(archive_member_name),
        canonical_n64_sha256: identity.canonical_n64_sha256,
        canonical_n64_sha1: identity.canonical_n64_sha1,
        canonical_n64_size: identity.canonical_n64_size,
    })
}

struct HashedContent {
    sha256: String,
    sha1: String,
    crc32: String,
    size: u64,
    canonical_n64_sha256: Option<String>,
    canonical_n64_sha1: Option<String>,
    canonical_n64_size: Option<u64>,
}

struct HashedStorage {
    sha256: String,
    size: u64,
}

pub(crate) fn read_zip_member_hashes(
    archive: &mut zip::ZipArchive<File>,
    index: usize,
    maximum: u64,
    budget: &mut HashBudget,
) -> Result<(String, String, String, u64)> {
    let entry = archive
        .by_index(index)
        .map_err(|error| PortcoveError::source(format!("invalid file-set ZIP entry: {error}")))?;
    let maximum = maximum.min(512 * 1024 * 1024);
    let expected = entry.size();
    if expected > maximum {
        return Err(
            PortcoveError::source("expanded source exceeds its size limit")
                .detail("scan_limit", "file_size"),
        );
    }
    // File-set members use original byte digests, not cartridge canonicalization.
    let identity = hash_reader(entry, expected, maximum, budget, false)?;
    Ok((
        identity.sha1,
        identity.sha256,
        identity.crc32,
        identity.size,
    ))
}

pub(crate) fn read_storage_identity(
    mut file: File,
    expected: u64,
    maximum: u64,
    budget: &mut HashBudget,
) -> Result<(String, u64)> {
    file.rewind()?;
    let identity = hash_storage_reader(file, expected, maximum, budget)?;
    Ok((identity.sha256, identity.size))
}

fn hash_reader(
    mut reader: impl Read,
    expected: u64,
    maximum: u64,
    budget: &mut HashBudget,
    canonical_n64: bool,
) -> Result<HashedContent> {
    if expected > maximum {
        return Err(PortcoveError::source(
            "source exceeds its hashing size limit",
        ));
    }
    budget.reserve(expected)?;
    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
    let mut crc32 = crc32fast::Hasher::new();
    let mut n64 = N64CanonicalDigest::default();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    while size < expected {
        if let Some(operation) = &budget.operation {
            operation.checkpoint()?;
        }
        let wanted = (expected - size).min(buffer.len() as u64) as usize;
        let read = reader.read(&mut buffer[..wanted])?;
        if read == 0 {
            return Err(PortcoveError::source("source shrank while hashing"));
        }
        budget.hashed += read as u64;
        size += read as u64;
        sha256.update(&buffer[..read]);
        sha1.update(&buffer[..read]);
        crc32.update(&buffer[..read]);
        if canonical_n64 {
            n64.update(&buffer[..read])?;
        }
    }
    if reader.read(&mut [0_u8; 1])? != 0 {
        return Err(PortcoveError::source("source grew while hashing"));
    }
    let (canonical_n64_sha256, canonical_n64_sha1, canonical_n64_size) = n64.finish()?;
    Ok(HashedContent {
        sha256: hex::encode(sha256.finalize()),
        sha1: hex::encode(sha1.finalize()),
        crc32: format!("{:08x}", crc32.finalize()),
        size,
        canonical_n64_sha256,
        canonical_n64_sha1,
        canonical_n64_size,
    })
}

fn hash_storage_reader(
    mut reader: impl Read,
    expected: u64,
    maximum: u64,
    budget: &mut HashBudget,
) -> Result<HashedStorage> {
    if expected > maximum {
        return Err(PortcoveError::source(
            "source exceeds its hashing size limit",
        ));
    }
    budget.reserve(expected)?;
    let mut sha256 = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    while size < expected {
        if let Some(operation) = &budget.operation {
            operation.checkpoint()?;
        }
        let wanted = (expected - size).min(buffer.len() as u64) as usize;
        let read = reader.read(&mut buffer[..wanted])?;
        if read == 0 {
            return Err(PortcoveError::source("source shrank while hashing"));
        }
        budget.hashed += read as u64;
        size += read as u64;
        sha256.update(&buffer[..read]);
    }
    if reader.read(&mut [0_u8; 1])? != 0 {
        return Err(PortcoveError::source("source grew while hashing"));
    }
    Ok(HashedStorage {
        sha256: hex::encode(sha256.finalize()),
        size,
    })
}

#[derive(Default)]
struct N64CanonicalDigest {
    order: Option<N64ByteOrder>,
    pending: [u8; 4],
    pending_len: usize,
    sha256: Sha256,
    sha1: Sha1,
    size: u64,
    #[cfg(test)]
    work: N64Work,
}

#[cfg(test)]
#[derive(Default)]
struct N64Work {
    buffered_bytes: u64,
    digested_bytes: u64,
}

#[derive(Clone, Copy)]
enum N64ByteOrder {
    Big,
    ByteSwapped,
    Little,
    Invalid,
}

impl N64CanonicalDigest {
    fn update(&mut self, bytes: &[u8]) -> Result<()> {
        if matches!(self.order, Some(N64ByteOrder::Invalid)) {
            return Ok(());
        }

        let mut remaining = bytes;
        if self.order.is_none() {
            let take = (4 - self.pending_len).min(remaining.len());
            self.pending[self.pending_len..self.pending_len + take]
                .copy_from_slice(&remaining[..take]);
            self.pending_len += take;
            #[cfg(test)]
            {
                self.work.buffered_bytes += take as u64;
            }
            remaining = &remaining[take..];
            if self.pending_len < 4 {
                return Ok(());
            }
            self.order = Some(match self.pending {
                [0x80, 0x37, 0x12, 0x40] => N64ByteOrder::Big,
                [0x37, 0x80, 0x40, 0x12] => N64ByteOrder::ByteSwapped,
                [0x40, 0x12, 0x37, 0x80] => N64ByteOrder::Little,
                _ => N64ByteOrder::Invalid,
            });
            if matches!(self.order, Some(N64ByteOrder::Invalid)) {
                self.pending_len = 0;
                return Ok(());
            }
            let header = self.pending;
            self.pending_len = 0;
            self.hash_words(&header);
        }

        if self.pending_len > 0 {
            let take = (4 - self.pending_len).min(remaining.len());
            self.pending[self.pending_len..self.pending_len + take]
                .copy_from_slice(&remaining[..take]);
            self.pending_len += take;
            #[cfg(test)]
            {
                self.work.buffered_bytes += take as u64;
            }
            remaining = &remaining[take..];
            if self.pending_len < 4 {
                return Ok(());
            }
            let pending = self.pending;
            self.pending_len = 0;
            self.hash_words(&pending);
        }

        let complete = remaining.len() / 4 * 4;
        self.hash_words(&remaining[..complete]);
        let tail = &remaining[complete..];
        self.pending.fill(0);
        self.pending[..tail.len()].copy_from_slice(tail);
        self.pending_len = tail.len();
        #[cfg(test)]
        {
            self.work.buffered_bytes += tail.len() as u64;
        }
        Ok(())
    }

    fn hash_words(&mut self, words: &[u8]) {
        if words.is_empty() {
            return;
        }
        match self.order.expect("N64 byte order is known") {
            N64ByteOrder::Big => {
                self.sha256.update(words);
                self.sha1.update(words);
            }
            N64ByteOrder::ByteSwapped => {
                let mut normalized = [0_u8; 4096];
                for chunk in words.chunks(normalized.len()) {
                    normalized[..chunk.len()].copy_from_slice(chunk);
                    for pair in normalized[..chunk.len()].as_chunks_mut::<2>().0 {
                        pair.swap(0, 1);
                    }
                    self.sha256.update(&normalized[..chunk.len()]);
                    self.sha1.update(&normalized[..chunk.len()]);
                }
            }
            N64ByteOrder::Little => {
                let mut normalized = [0_u8; 4096];
                for chunk in words.chunks(normalized.len()) {
                    normalized[..chunk.len()].copy_from_slice(chunk);
                    for word in normalized[..chunk.len()].as_chunks_mut::<4>().0 {
                        word.reverse();
                    }
                    self.sha256.update(&normalized[..chunk.len()]);
                    self.sha1.update(&normalized[..chunk.len()]);
                }
            }
            N64ByteOrder::Invalid => unreachable!("invalid N64 input is rejected before hashing"),
        }
        self.size += words.len() as u64;
        #[cfg(test)]
        {
            self.work.digested_bytes += words.len() as u64;
        }
    }

    fn finish(mut self) -> Result<(Option<String>, Option<String>, Option<u64>)> {
        if self.order.is_none() || matches!(self.order, Some(N64ByteOrder::Invalid)) {
            return Ok((None, None, None));
        }
        if self.pending_len > 0 {
            let pending = self.pending;
            self.hash_words(&pending);
        }
        Ok((
            Some(hex::encode(self.sha256.finalize())),
            Some(hex::encode(self.sha1.finalize())),
            Some(self.size),
        ))
    }
}

pub(crate) fn validate_source_hashes(
    profile: &SourceProfile,
    sha1: &str,
    sha256: &str,
) -> Result<()> {
    for (algorithm, actual, accepted) in [
        ("sha1", sha1, &profile.accepted_sha1),
        ("sha256", sha256, &profile.accepted_sha256),
    ] {
        if !accepted.is_empty()
            && !accepted
                .iter()
                .any(|expected| expected.eq_ignore_ascii_case(actual))
        {
            return Err(PortcoveError::source(format!(
                "source hash is not a supported {} variant",
                profile.label
            ))
            .detail(algorithm, actual));
        }
    }
    Ok(())
}

pub(crate) fn single_zip_source_index(
    archive: &mut zip::ZipArchive<File>,
    extensions: &[String],
) -> Result<usize> {
    let mut matches = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| PortcoveError::source(format!("invalid source ZIP entry: {error}")))?;
        if entry.is_dir() {
            continue;
        }
        let extension = Path::new(entry.name())
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if extensions
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        {
            matches.push(index);
        }
    }
    if matches.len() != 1 {
        return Err(PortcoveError::source(format!(
            "source ZIP must contain exactly one matching file; found {}",
            matches.len()
        ))
        .detail("zip_match_count", matches.len().to_string()));
    }
    Ok(matches[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn zip_identity_retains_member_and_storage_from_the_opened_archive() {
        use std::io::Write;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source.zip");
        let displaced = temporary.path().join("original.zip");
        let write = |payload: &[u8]| {
            let mut archive = zip::ZipWriter::new(File::create(&path).unwrap());
            archive
                .start_file(
                    "source.bin",
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            archive.write_all(payload).unwrap();
            archive.finish().unwrap();
        };
        write(b"original source!");
        let original = std::fs::read(&path).unwrap();
        let file = File::open(&path).unwrap();
        // Renaming away first also supports platforms that cannot replace an
        // existing destination. The original handle remains open throughout.
        std::fs::rename(&path, &displaced).unwrap();
        write(b"replaced source!");
        let replacement = std::fs::read(&path).unwrap();
        assert_eq!(original.len(), replacement.len());
        assert_ne!(original, replacement);
        let mut budget = HashBudget {
            operation: None,
            limit: 1_000_000,
            hashed: 0,
            max_zip_entries: 8,
        };
        let identity = read_zip_identity_from_file(
            file,
            &["bin".into()],
            1_000_000,
            original.len() as u64,
            &mut budget,
        )
        .unwrap();
        assert_eq!(
            identity.sha256,
            hex::encode(Sha256::digest(b"original source!"))
        );
        assert_eq!(
            identity.storage_sha256,
            hex::encode(Sha256::digest(&original))
        );
        assert_eq!(identity.storage_size, original.len() as u64);
        assert_eq!(budget.hashed, original.len() as u64 + 16);
        assert_eq!(std::fs::read(&path).unwrap(), replacement);
        assert_eq!(std::fs::read(&displaced).unwrap(), original);
    }

    #[test]
    fn retained_storage_reader_rewinds_and_preserves_limits_and_length_guards() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("storage.zip");
        let bytes = b"original storage";
        std::fs::write(&path, bytes).unwrap();
        let mut file = File::open(&path).unwrap();
        file.seek(std::io::SeekFrom::End(0)).unwrap();
        let expected = file.metadata().unwrap().len();
        let mut budget = HashBudget {
            operation: None,
            limit: expected,
            hashed: 0,
            max_zip_entries: 8,
        };
        let (digest, size) =
            read_storage_identity(file.try_clone().unwrap(), expected, expected, &mut budget)
                .unwrap();
        assert_eq!(digest, hex::encode(Sha256::digest(bytes)));
        assert_eq!(size, expected);
        assert_eq!(budget.hashed, expected);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        for (limit, maximum, message) in [
            (expected - 1, expected, "budget"),
            (expected, expected - 1, "size limit"),
        ] {
            let mut budget = HashBudget {
                operation: None,
                limit,
                hashed: 0,
                max_zip_entries: 8,
            };
            let error =
                read_storage_identity(file.try_clone().unwrap(), expected, maximum, &mut budget)
                    .unwrap_err();
            assert!(error.message.contains(message), "{}", error.message);
            assert_eq!(budget.hashed, 0);
        }
        for (changed, message) in [
            (b"short".as_slice(), "shrank"),
            (b"original storage plus".as_slice(), "grew"),
        ] {
            // In-place changes affect the original handle, unlike pathname replacement.
            std::fs::write(&path, changed).unwrap();
            let mut budget = HashBudget {
                operation: None,
                limit: expected,
                hashed: 0,
                max_zip_entries: 8,
            };
            let error =
                read_storage_identity(file.try_clone().unwrap(), expected, expected, &mut budget)
                    .unwrap_err();
            assert!(error.message.contains(message), "{}", error.message);
            assert!(budget.hashed <= expected);
            assert_eq!(std::fs::read(&path).unwrap(), changed);
        }
    }

    fn canonical_digest(input_chunks: &[&[u8]]) -> (N64CanonicalDigest, Vec<u8>) {
        let mut digest = N64CanonicalDigest::default();
        for chunk in input_chunks {
            digest.update(chunk).unwrap();
        }
        let canonical = match digest.order.unwrap() {
            N64ByteOrder::Big => input_chunks.concat(),
            N64ByteOrder::ByteSwapped => {
                let mut bytes = input_chunks.concat();
                for pair in bytes.as_chunks_mut::<2>().0 {
                    pair.swap(0, 1);
                }
                bytes
            }
            N64ByteOrder::Little => {
                let mut bytes = input_chunks.concat();
                for word in bytes.as_chunks_mut::<4>().0 {
                    word.reverse();
                }
                bytes
            }
            N64ByteOrder::Invalid => Vec::new(),
        };
        (digest, canonical)
    }

    #[test]
    fn n64_canonical_digest_preserves_all_orders_across_split_reads() {
        let canonical = [
            0x80, 0x37, 0x12, 0x40, 0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc, 0xdd,
        ];
        let mut byte_swapped = canonical;
        for pair in byte_swapped.as_chunks_mut::<2>().0 {
            pair.swap(0, 1);
        }
        let mut little = canonical;
        for word in little.as_chunks_mut::<4>().0 {
            word.reverse();
        }

        for encoded in [canonical, byte_swapped, little] {
            let chunks = [&encoded[..1], &encoded[1..3], &encoded[3..7], &encoded[7..]];
            let (digest, normalized) = canonical_digest(&chunks);
            assert_eq!(normalized, canonical);
            let (sha256, sha1, size) = digest.finish().unwrap();
            assert_eq!(sha256.unwrap(), hex::encode(Sha256::digest(canonical)));
            assert_eq!(sha1.unwrap(), hex::encode(Sha1::digest(canonical)));
            assert_eq!(size, Some(canonical.len() as u64));
        }
    }

    #[test]
    fn n64_canonical_digest_preserves_padded_tail_semantics() {
        for (encoded, expected) in [
            (
                vec![0x80, 0x37, 0x12, 0x40, 0x11, 0x22],
                vec![0x80, 0x37, 0x12, 0x40, 0x11, 0x22, 0, 0],
            ),
            (
                vec![0x37, 0x80, 0x40, 0x12, 0x22, 0x11],
                vec![0x80, 0x37, 0x12, 0x40, 0x11, 0x22, 0, 0],
            ),
            (
                vec![0x40, 0x12, 0x37, 0x80, 0x44, 0x33],
                vec![0x80, 0x37, 0x12, 0x40, 0, 0, 0x33, 0x44],
            ),
        ] {
            let mut digest = N64CanonicalDigest::default();
            digest.update(&encoded[..3]).unwrap();
            digest.update(&encoded[3..]).unwrap();
            let (sha256, sha1, size) = digest.finish().unwrap();
            assert_eq!(sha256.unwrap(), hex::encode(Sha256::digest(&expected)));
            assert_eq!(sha1.unwrap(), hex::encode(Sha1::digest(&expected)));
            assert_eq!(size, Some(8));
        }
    }

    #[test]
    fn non_n64_rejection_stops_canonical_work_after_split_header() {
        let mut digest = N64CanonicalDigest::default();
        digest.update(&[0xde]).unwrap();
        digest.update(&[0xad, 0xbe]).unwrap();
        digest.update(&[0xef, 1, 2, 3]).unwrap();
        digest.update(&vec![0x55; 256 * 1024]).unwrap();

        assert!(matches!(digest.order, Some(N64ByteOrder::Invalid)));
        assert_eq!(digest.work.buffered_bytes, 4);
        assert_eq!(digest.work.digested_bytes, 0);
        assert_eq!(digest.finish().unwrap(), (None, None, None));
    }

    #[test]
    fn short_n64_header_remains_unclassified() {
        for bytes in [
            &[][..],
            &[0x80][..],
            &[0x80, 0x37][..],
            &[0x80, 0x37, 0x12][..],
        ] {
            let mut digest = N64CanonicalDigest::default();
            digest.update(bytes).unwrap();
            assert_eq!(digest.finish().unwrap(), (None, None, None));
        }
    }

    #[test]
    fn storage_identity_hashes_only_sha256_and_preserves_accounting() {
        let bytes = b"outer zip storage bytes";
        let mut budget = HashBudget {
            operation: None,
            limit: bytes.len() as u64,
            hashed: 0,
            max_zip_entries: 1,
        };
        let identity = hash_storage_reader(
            Cursor::new(bytes),
            bytes.len() as u64,
            bytes.len() as u64,
            &mut budget,
        )
        .unwrap();

        assert_eq!(identity.sha256, hex::encode(Sha256::digest(bytes)));
        assert_eq!(identity.size, bytes.len() as u64);
        assert_eq!(budget.hashed, bytes.len() as u64);
    }
    #[test]
    fn raw_member_facts_keep_crc_budget_and_changing_stream_guards() {
        let bytes = b"facts";
        let mut budget = HashBudget {
            operation: None,
            limit: 5,
            hashed: 0,
            max_zip_entries: 4096,
        };
        let identity = hash_reader(std::io::Cursor::new(bytes), 5, 5, &mut budget, true).unwrap();
        assert_eq!(identity.crc32, format!("{:08x}", crc32fast::hash(bytes)));
        assert_eq!(identity.sha1, hex::encode(Sha1::digest(bytes)));
        assert_eq!(identity.sha256, hex::encode(Sha256::digest(bytes)));
        assert_eq!(budget.hashed, 5);
        for (data, expected, message) in [
            (b"ab".as_slice(), 3, "shrank"),
            (b"abcd".as_slice(), 3, "grew"),
        ] {
            let mut budget = HashBudget {
                operation: None,
                limit: 3,
                hashed: 0,
                max_zip_entries: 4096,
            };
            let error = hash_reader(std::io::Cursor::new(data), expected, 3, &mut budget, true)
                .err()
                .unwrap();
            assert!(error.message.contains(message));
            assert!(budget.hashed <= 3);
        }
    }
}
