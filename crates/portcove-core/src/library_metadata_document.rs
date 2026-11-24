//! Streaming encoding of the library metadata document.
//!
//! Export, recovery bundles and import share one document contract: whatever a
//! supported library can write, the supported importer reads. The document is
//! written and read as a stream, so neither side keeps a second serialized copy
//! next to the in-memory snapshot, and no whole-document byte ceiling exists that
//! a growing library could cross. The input is the player's own chosen export or
//! a Portcove-owned bundle; reading it costs memory in proportion to its records,
//! as producing it did. Each record keeps its own bound (profiles,
//! revisions, retained-build references, memberships, held releases), and the
//! parsed snapshot is the same size on both sides: the writer already held it.
//! The bytes and their SHA-256 are identical to the earlier in-memory encoding,
//! so receipts and reviewed plans written before this change still verify.
use std::{
    fs,
    io::{BufReader, BufWriter, Read, Write},
    path::Path,
};

use sha2::{Digest, Sha256};

use crate::{LibraryMetadata, PortcoveError, Result};

/// Size and SHA-256 of an encoded metadata document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DocumentDigest {
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

struct Hashing<T> {
    inner: T,
    hasher: Sha256,
    size: u64,
}

impl<T> Hashing<T> {
    fn new(inner: T) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            size: 0,
        }
    }

    fn finish(self) -> (T, DocumentDigest) {
        (
            self.inner,
            DocumentDigest {
                sha256: hex::encode(self.hasher.finalize()),
                size: self.size,
            },
        )
    }
}

impl<T: Write> Write for Hashing<T> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(bytes)?;
        self.hasher.update(&bytes[..written]);
        self.size += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

impl<T: Read> Read for Hashing<T> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.hasher.update(&buffer[..read]);
        self.size += read as u64;
        Ok(read)
    }
}

/// Encodes `metadata` into `output` and returns the digest of the bytes written.
pub(crate) fn write(output: impl Write, metadata: &LibraryMetadata) -> Result<DocumentDigest> {
    let mut writer = Hashing::new(BufWriter::new(output));
    serde_json::to_writer_pretty(&mut writer, metadata)?;
    writer.flush()?;
    Ok(writer.finish().1)
}

/// Encoded JSON size of any value, measured through a sink without keeping its
/// bytes. Pretty output is never smaller than compact output, so it serves as
/// a capacity reserve for either.
pub(crate) fn encoded_size(value: &impl serde::Serialize) -> Result<u64> {
    let mut writer = Hashing::new(std::io::sink());
    serde_json::to_writer_pretty(&mut writer, value)?;
    Ok(writer.size)
}

/// Destination space a transfer needs beyond its payload for its own durable
/// documents: the recovery journal (or bundle receipt) that carries the
/// reviewed metadata and content inventory, written up to `copies` times, plus
/// a fixed 1 MiB for small fixed-shape records. Replaces a flat 64 MiB reserve
/// that a large inventory could exceed after the copy had already run.
pub(crate) fn transfer_reserve(
    metadata: &LibraryMetadata,
    content: &[crate::LibraryTreePlan],
    copies: u64,
) -> Result<u64> {
    encoded_size(&(metadata, content))?
        .checked_mul(copies)
        .and_then(|bytes| bytes.checked_add(1024 * 1024))
        .ok_or_else(|| PortcoveError::state("transfer journal estimate overflowed"))
}

/// Digest of the document `metadata` encodes to, without keeping its bytes.
pub(crate) fn digest(metadata: &LibraryMetadata) -> Result<DocumentDigest> {
    write(std::io::sink(), metadata)
}

/// Materialized documents are kept within half of physical memory. Decoding
/// JSON into Portcove's records expands it by at most about 16x (an empty
/// string costs 2 bytes in JSON and a 24-byte `String`; every other field costs
/// more JSON than structure), so a document may use 1/32 of physical memory.
/// Physical rather than currently free memory keeps a reviewed plan stable.
/// The same budget refuses an export, so a successful export stays importable
/// on the machine that wrote it; no real library approaches it (10,000
/// setups with 2 KB of revision data each is about 20 MiB).
const PHYSICAL_MEMORY_SHARE: u64 = 32;
/// Used when the platform cannot report physical memory: the budget of an
/// 8 GiB machine.
const FALLBACK_BUDGET: u64 = 256 * 1024 * 1024;

#[cfg(test)]
thread_local! {
    static BUDGET_OVERRIDE: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) fn with_admission_budget<T>(budget: u64, run: impl FnOnce() -> T) -> T {
    BUDGET_OVERRIDE.with(|value| value.set(Some(budget)));
    let result = run();
    BUDGET_OVERRIDE.with(|value| value.set(None));
    result
}

#[cfg(unix)]
fn physical_memory() -> Option<u64> {
    // SAFETY: sysconf reads process-independent configuration values.
    let (pages, page) = unsafe {
        (
            libc::sysconf(libc::_SC_PHYS_PAGES),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    (pages > 0 && page > 0).then(|| (pages as u64).saturating_mul(page as u64))
}

#[cfg(windows)]
fn physical_memory() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: the structure is zero-initialized with its declared length, as
    // GlobalMemoryStatusEx requires.
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        (GlobalMemoryStatusEx(&mut status) != 0).then_some(status.ullTotalPhys)
    }
}

/// Largest document this machine admits for decoding; see `PHYSICAL_MEMORY_SHARE`.
pub(crate) fn admission_budget() -> u64 {
    #[cfg(test)]
    if let Some(budget) = BUDGET_OVERRIDE.with(std::cell::Cell::get) {
        return budget;
    }
    physical_memory()
        .map(|bytes| bytes / PHYSICAL_MEMORY_SHARE)
        .unwrap_or(FALLBACK_BUDGET)
}

/// Typed refusal for a document beyond the admission budget, before any parse.
pub(crate) fn require_admitted(size: u64, document: &str) -> Result<()> {
    let budget = admission_budget();
    if size > budget {
        return Err(PortcoveError::unsupported(format!(
            "This {document} is larger than this computer can safely read."
        ))
        .with_mutation_state(crate::MutationState::NoChanges)
        .detail("document_bytes", size.to_string())
        .detail("admission_budget_bytes", budget.to_string())
        .detail("admission_basis", "physical_memory_div_32"));
    }
    Ok(())
}

/// Opens a regular, non-link file admitted by the budget. The returned reader
/// stops one byte past the budget so a file that grows while it is read is
/// refused too.
pub(crate) fn open_admitted(path: &Path, document: &str) -> Result<std::io::Take<fs::File>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(
            PortcoveError::verification(format!("{document} must be a regular file"))
                .detail("path", path.display().to_string()),
        );
    }
    require_admitted(metadata.len(), document)?;
    Ok(fs::File::open(path)?.take(admission_budget().saturating_add(1)))
}

fn open_regular(path: &Path) -> Result<fs::File> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(
            PortcoveError::verification("metadata must be a regular file")
                .detail("path", path.display().to_string()),
        );
    }
    Ok(fs::File::open(path)?)
}

/// Streams and decodes a metadata document from a regular, non-link file
/// within the admission budget.
pub(crate) fn read(path: &Path) -> Result<(DocumentDigest, LibraryMetadata)> {
    let mut reader = BufReader::new(Hashing::new(open_admitted(path, "library metadata")?));
    let decoded = serde_json::from_reader(&mut reader);
    if reader.get_ref().size > admission_budget() {
        require_admitted(reader.get_ref().size, "library metadata")?;
    }
    let document = decoded?;
    // The decoder accepts only trailing whitespace; hash whatever remains so the
    // digest names the complete file that was reviewed.
    std::io::copy(&mut reader, &mut std::io::sink())?;
    Ok((reader.into_inner().finish().1, document))
}

/// Digest of a metadata file without decoding it.
pub(crate) fn file_digest(path: &Path) -> Result<DocumentDigest> {
    let mut reader = Hashing::new(open_regular(path)?);
    std::io::copy(&mut reader, &mut std::io::sink())?;
    Ok(reader.finish().1)
}
