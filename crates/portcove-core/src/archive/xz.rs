use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

use lzma_turbo::xz::{
    BlockHeader, CheckType, MAX_BLOCK_HEADER_SIZE, XzOptions, XzParallelReader,
    block::header_size_from_first_byte, read_stream_index_ending_at,
};

use super::{
    ARCHIVE_IO_CHUNK_BYTES, MAX_COMPRESSION_RATIO, MAX_EXPANDED_BYTES,
    MAX_TAR_FORMAT_OVERHEAD_BYTES,
};
use crate::{PortcoveError, Result};

const MAX_INDEX_BYTES: u64 = 32 * 1024;
const MAX_BLOCKS: usize = 1024;
const MAX_BLOCK_BYTES: u64 = 64 * 1024 * 1024;
const DECODER_MEMORY_BYTES: u64 = 96 * 1024 * 1024;

struct CheckedFile<'a> {
    file: File,
    checkpoint: &'a dyn Fn() -> Result<()>,
}

impl Read for CheckedFile<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        (self.checkpoint)().map_err(|error| io::Error::other(error.message))?;
        let count = buffer.len().min(ARCHIVE_IO_CHUNK_BYTES);
        self.file.read(&mut buffer[..count])
    }
}

impl Seek for CheckedFile<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        (self.checkpoint)().map_err(|error| io::Error::other(error.message))?;
        self.file.seek(position)
    }
}

pub(super) fn open<'a>(
    source: &Path,
    compressed_size: u64,
    checkpoint: &'a dyn Fn() -> Result<()>,
) -> Result<impl Read + 'a> {
    let file = File::open(source)?;
    if file.metadata()?.len() != compressed_size {
        return Err(PortcoveError::verification("TAR.XZ source size changed"));
    }
    let mut input = CheckedFile { file, checkpoint };
    let stream = read_stream_index_ending_at(&mut input, compressed_size, MAX_INDEX_BYTES)
        .map_err(|error| super::map_tar_error("invalid TAR.XZ index", error, checkpoint))?;
    let check = stream.header.flags.check;
    if stream.stream_offset != 0
        || stream.stream_size != compressed_size
        || !matches!(check, CheckType::Crc32 | CheckType::Crc64)
    {
        return Err(PortcoveError::verification(
            "TAR.XZ requires one unpadded stream with CRC32 or CRC64",
        ));
    }
    let output_limit = MAX_EXPANDED_BYTES + MAX_TAR_FORMAT_OVERHEAD_BYTES;
    let ratio_limit = compressed_size.saturating_mul(MAX_COMPRESSION_RATIO);
    let decoded_size = stream
        .index
        .uncompressed_size()
        .ok_or_else(|| PortcoveError::verification("TAR.XZ decoded size overflowed"))?;
    if decoded_size > ratio_limit {
        return Err(PortcoveError::verification(
            "TAR.XZ decoded-to-compressed ratio exceeds its limit",
        ));
    }
    if !(1..=MAX_BLOCKS).contains(&stream.index.block_count())
        || stream.index.largest_block() > MAX_BLOCK_BYTES
        || decoded_size > output_limit
    {
        return Err(PortcoveError::verification(
            "TAR.XZ block count or decoded size exceeds its limit",
        ));
    }
    let blocks = stream
        .index
        .blocks(0)
        .ok_or_else(|| PortcoveError::verification("TAR.XZ block coordinates overflowed"))?;
    let mut header = [0_u8; MAX_BLOCK_HEADER_SIZE];
    let header_io_error =
        |error| super::map_tar_error("invalid TAR.XZ block header", error, checkpoint);
    for block in blocks {
        checkpoint()?;
        input
            .seek(SeekFrom::Start(block.file_offset))
            .map_err(header_io_error)?;
        input
            .read_exact(&mut header[..1])
            .map_err(header_io_error)?;
        let size = header_size_from_first_byte(header[0])
            .filter(|size| block.record.unpadded_size > (size + check.size()) as u64)
            .ok_or_else(|| PortcoveError::verification("TAR.XZ block header exceeds its range"))?;
        input
            .read_exact(&mut header[1..size])
            .map_err(header_io_error)?;
        let block_header = BlockHeader::parse(&header[..size]).map_err(|error| {
            super::map_tar_error("invalid TAR.XZ block header", error, checkpoint)
        })?;
        if !block_header.chain.is_plain_lzma2() {
            return Err(PortcoveError::verification(
                "TAR.XZ requires plain LZMA2 blocks",
            ));
        }
    }

    // One verified worker uses the bounded, synchronous block decoder. It checks
    // each indexed region and checksum before returning that block's bytes.
    let mut options = XzOptions::default()
        .with_threads(1)
        .with_memory_limit(DECODER_MEMORY_BYTES)
        .with_max_unpack_bytes(Some(output_limit.min(ratio_limit)))
        .with_concatenated(false)
        .with_verified_output(true);
    options.max_block_size = MAX_BLOCK_BYTES;
    XzParallelReader::with_options(input, options)
        .map_err(|error| super::map_tar_error("invalid TAR.XZ decoder", error, checkpoint))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use lzma_turbo::{LzmaEncProps, encode_xz};
    use std::{cell::Cell, fs, io::Cursor};

    const ASSET: &str = "player.tar.xz";

    fn tar_bytes() -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_ustar();
        header.set_mode(0o755);
        header.set_size(6);
        tar.append_data(&mut header, "player", &b"player"[..])
            .unwrap();
        tar.into_inner().unwrap()
    }

    fn encode(bytes: &[u8]) -> Vec<u8> {
        encode_xz(
            bytes,
            &LzmaEncProps::new().with_dict_size(1 << 16),
            CheckType::Crc64,
            1024,
        )
        .unwrap()
    }

    pub(crate) fn fixture() -> Vec<u8> {
        encode(&tar_bytes())
    }

    fn extract(
        bytes: &[u8],
        destination: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        let source = destination.parent().unwrap().join(ASSET);
        fs::write(&source, bytes).unwrap();
        super::super::extract_download_archive_with_checkpoint(
            &source,
            destination,
            ASSET,
            bytes.len() as u64,
            checkpoint,
        )
    }

    #[test]
    fn tar_xz_download_extracts_verified_blocks_and_managed_extraction_refuses() {
        let temporary = tempfile::tempdir().unwrap();
        let output = temporary.path().join("external");
        let bytes = fixture();
        fs::create_dir(&output).unwrap();
        extract(&bytes, &output, &|| Ok(())).unwrap();
        assert_eq!(fs::read(output.join("player")).unwrap(), b"player");

        let managed = temporary.path().join("managed");
        fs::create_dir(&managed).unwrap();
        let error = super::super::extract_archive(
            &temporary.path().join(ASSET),
            &managed,
            ASSET,
            bytes.len() as u64,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert!(fs::read_dir(managed).unwrap().next().is_none());
    }

    #[test]
    fn tar_xz_refuses_bad_framing_and_trailer_before_writing() {
        let temporary = tempfile::tempdir().unwrap();
        let output = temporary.path().join("external");
        let tar = tar_bytes();
        let mut padded = tar.clone();
        padded.extend([0_u8; 1024]);
        let mut bad_crc = encode(&padded);
        let stream = read_stream_index_ending_at(
            &mut Cursor::new(&bad_crc),
            bad_crc.len() as u64,
            MAX_INDEX_BYTES,
        )
        .unwrap();
        let last = stream.index.blocks(0).unwrap().pop().unwrap();
        let last_check_byte = (last.file_offset + last.record.padded_size().unwrap() - 1) as usize;
        bad_crc[last_check_byte] ^= 1;

        let mut hidden = tar.clone();
        hidden.extend([1_u8; 512]);
        let mut excessive_padding = tar.clone();
        excessive_padding.resize(tar.len() + 11 * 1024, 0);
        let mut excessive_ratio = tar.clone();
        excessive_ratio.resize(1024 * 1024, 0);
        let excessive_ratio = encode_xz(
            &excessive_ratio,
            &LzmaEncProps::new().with_dict_size(1 << 16),
            CheckType::Crc64,
            0,
        )
        .unwrap();
        let mut concatenated = encode(&tar);
        concatenated.extend(encode(&tar));
        let mut oversized_index = encode(&tar);
        let end = oversized_index.len();
        let footer = &mut oversized_index[end - 12..];
        footer[4..8].copy_from_slice(&(MAX_INDEX_BYTES as u32 / 4).to_le_bytes());
        let checksum = crc32fast::hash(&footer[4..10]);
        footer[..4].copy_from_slice(&checksum.to_le_bytes());

        for (bytes, reason) in [
            (bad_crc, "TAR.XZ stream ending"),
            (encode(&hidden), "after the TAR end marker"),
            (encode(&excessive_padding), "zero padding exceeds"),
            (excessive_ratio, "decoded-to-compressed ratio"),
            (encode(&tar[..tar.len() - 512]), "complete TAR end marker"),
            (concatenated, "one unpadded stream"),
            (oversized_index, "TAR.XZ index"),
        ] {
            let error = extract(&bytes, &output, &|| Ok(())).unwrap_err();
            assert!(error.message.contains(reason), "{}", error.message);
            assert!(!output.exists());
        }
    }

    #[test]
    fn tar_xz_cancellation_and_links_cannot_start_extraction() {
        let temporary = tempfile::tempdir().unwrap();
        let output = temporary.path().join("external");
        let checkpoints = Cell::new(0);
        let error = extract(&encode(&tar_bytes()), &output, &|| {
            checkpoints.set(checkpoints.get() + 1);
            if checkpoints.get() >= 5 {
                Err(PortcoveError::state("stop extraction fixture"))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(error.message, "stop extraction fixture");
        assert!(!output.exists());

        let armed = Cell::new(false);
        let decode_checkpoints = Cell::new(0);
        let checkpoint = || {
            if armed.get() {
                decode_checkpoints.set(decode_checkpoints.get() + 1);
                if decode_checkpoints.get() >= 2 {
                    return Err(PortcoveError::state("stop during XZ block input"));
                }
            }
            Ok(())
        };
        let source = temporary.path().join(ASSET);
        let mut decoded = open(&source, fs::metadata(&source).unwrap().len(), &checkpoint).unwrap();
        armed.set(true);
        assert!(
            decoded
                .read(&mut [0; 1])
                .unwrap_err()
                .to_string()
                .contains("stop during XZ block input")
        );
        assert_eq!(decode_checkpoints.get(), 2);
        drop(decoded);

        let mut tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        tar.append_link(&mut header, "link", "player").unwrap();
        let error = extract(&encode(&tar.into_inner().unwrap()), &output, &|| Ok(())).unwrap_err();
        assert!(error.message.contains("links and special files"));
        assert!(!output.exists());
    }
}
