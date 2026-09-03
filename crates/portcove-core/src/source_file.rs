//! Shared original-file and cartridge-ZIP identity validation, with bounded scan hashing.
use crate::{Library, PortcoveError, Result, SourceProfile, SourceRecord};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

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

pub(crate) struct FileIdentity {
    sha256: String,
    sha1: String,
    size: u64,
    storage_sha256: String,
    storage_size: u64,
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
        read_zip_identity(path, extensions, maximum_size, metadata.len(), budget)
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
        let (sha256, sha1, size) =
            hash_reader(File::open(path)?, metadata.len(), maximum_size, budget)?;
        Ok(FileIdentity {
            storage_sha256: sha256.clone(),
            storage_size: size,
            sha256,
            sha1,
            size,
        })
    }
}

fn read_zip_identity(
    path: &Path,
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
    let mut archive = zip::ZipArchive::new(File::open(path)?)
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
    let (sha256, sha1, size) =
        hash_reader(entry, expected, maximum_size.min(512 * 1024 * 1024), budget)?;
    let (storage_sha256, _, storage_size) =
        hash_reader(File::open(path)?, storage_size, maximum_size, budget)?;
    Ok(FileIdentity {
        sha256,
        sha1,
        size,
        storage_sha256,
        storage_size,
    })
}

fn hash_reader(
    mut reader: impl Read,
    expected: u64,
    maximum: u64,
    budget: &mut HashBudget,
) -> Result<(String, String, u64)> {
    if expected > maximum {
        return Err(PortcoveError::source(
            "source exceeds its hashing size limit",
        ));
    }
    budget.reserve(expected)?;
    let mut sha256 = Sha256::new();
    let mut sha1 = Sha1::new();
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
    }
    if reader.read(&mut [0_u8; 1])? != 0 {
        return Err(PortcoveError::source("source grew while hashing"));
    }
    Ok((
        hex::encode(sha256.finalize()),
        hex::encode(sha1.finalize()),
        size,
    ))
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
