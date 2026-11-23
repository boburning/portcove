//! Streaming encoding of the library metadata document.
//!
//! Export, recovery bundles and import share one document contract: whatever a
//! supported library can write, the supported importer reads. The document is
//! written and read as a stream, so neither side keeps a second serialized copy
//! next to the in-memory snapshot, and no whole-document byte ceiling exists that
//! a growing library could cross. Each record keeps its own bound (profiles,
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

/// Digest of the document `metadata` encodes to, without keeping its bytes.
pub(crate) fn digest(metadata: &LibraryMetadata) -> Result<DocumentDigest> {
    write(std::io::sink(), metadata)
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

/// Streams and decodes a metadata document from a regular, non-link file.
pub(crate) fn read(path: &Path) -> Result<(DocumentDigest, LibraryMetadata)> {
    let mut reader = BufReader::new(Hashing::new(open_regular(path)?));
    let document = serde_json::from_reader(&mut reader)?;
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
