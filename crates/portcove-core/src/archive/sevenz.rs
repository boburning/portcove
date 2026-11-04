//! Bounded 7z decoding inside the existing private extraction transaction.
use std::{
    cell::RefCell,
    io::{self, Seek, SeekFrom},
};

use sevenz_turbo::{ArchiveLimits, ArchiveReader, EncoderMethod, Password};

use super::*;

const HEADER_BYTES: u64 = 16 * 1024 * 1024;
const DECODER_BYTES: u64 = 128 * 1024 * 1024;

fn limits() -> ArchiveLimits {
    ArchiveLimits {
        memory_limit_bytes: DECODER_BYTES,
        max_end_header_bytes: HEADER_BYTES,
        max_header_unpacked_bytes: HEADER_BYTES,
        max_header_depth: 2,
        max_entries: MAX_ENTRIES as u64,
        max_name_bytes: 2 * (MAX_PATH_BYTES as u64 + 1),
        max_total_name_bytes: HEADER_BYTES,
        max_coders_per_block: 4,
        max_streams_per_coder: 4,
        max_total_coders: MAX_ENTRIES as u64,
        max_unpack_bytes: MAX_EXPANDED_BYTES,
        max_unpack_ratio: MAX_COMPRESSION_RATIO,
        // Encryption is not compiled in; never grant KDF work either.
        max_aes_cycles_power: 0,
        max_aes_kdf_rounds: 0,
        reject_unsafe_paths: true,
    }
}

struct CheckedInput<'a> {
    file: File,
    checkpoint: &'a dyn Fn() -> Result<()>,
    failure: &'a RefCell<Option<PortcoveError>>,
}

impl CheckedInput<'_> {
    fn check(&self) -> io::Result<()> {
        if self.failure.borrow().is_some() {
            return Err(io::Error::other("7z reading remains interrupted"));
        }
        if let Err(error) = (self.checkpoint)() {
            *self.failure.borrow_mut() = Some(error);
            return Err(io::Error::other("7z reading interrupted"));
        }
        Ok(())
    }
}

impl Read for CheckedInput<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.check()?;
        let length = buffer.len().min(ARCHIVE_IO_CHUNK_BYTES);
        self.file.read(&mut buffer[..length])
    }
}

impl Seek for CheckedInput<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.check()?;
        self.file.seek(position)
    }
}

struct DecodedInput<'a> {
    reader: &'a mut dyn Read,
    failure: &'a RefCell<Option<PortcoveError>>,
}

impl Read for DecodedInput<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.reader.read(buffer).inspect_err(|error| {
            if self.failure.borrow().is_none() {
                *self.failure.borrow_mut() = Some(PortcoveError::verification(format!(
                    "7z payload decoding failed: {error}"
                )));
            }
        })
    }
}

fn decode_error(error: sevenz_turbo::Error) -> PortcoveError {
    let limited =
        error.limit_hit().is_some() || matches!(error, sevenz_turbo::Error::MaxMemLimited { .. });
    let error = PortcoveError::verification(format!("invalid or unsupported 7z archive: {error}"));
    if limited {
        error.with_known_cause(crate::failure::KnownFailureCause::ArchiveLimit)
    } else {
        error
    }
}

fn supported_codec(id: &[u8]) -> bool {
    [
        EncoderMethod::ID_COPY,
        EncoderMethod::ID_LZMA,
        EncoderMethod::ID_LZMA2,
        EncoderMethod::ID_DELTA,
        EncoderMethod::ID_BCJ_X86,
        EncoderMethod::ID_BCJ2,
        EncoderMethod::ID_BCJ_PPC,
        EncoderMethod::ID_BCJ_IA64,
        EncoderMethod::ID_BCJ_ARM,
        EncoderMethod::ID_BCJ_ARM64,
        EncoderMethod::ID_BCJ_ARM_THUMB,
        EncoderMethod::ID_BCJ_SPARC,
        EncoderMethod::ID_BCJ_RISCV,
    ]
    .contains(&id)
}

pub(super) fn extract(
    source: &Path,
    destination: &Path,
    compressed_size: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let file = File::open(source)?;
    validate_download_size(file.metadata()?.len(), compressed_size)?;
    let failure = RefCell::new(None);
    let input = CheckedInput {
        file,
        checkpoint,
        failure: &failure,
    };
    let mut archive =
        ArchiveReader::with_limits(input, Password::empty(), limits()).map_err(|error| {
            failure
                .borrow_mut()
                .take()
                .unwrap_or_else(|| decode_error(error))
        })?;
    archive.set_threads(1);
    archive.set_verify_checksums(true);
    for block in &archive.archive().blocks {
        checkpoint()?;
        if block
            .coders
            .iter()
            .any(|coder| !supported_codec(coder.encoder_method_id()))
        {
            return Err(PortcoveError::unsupported(
                "7z archive uses an unsupported or encrypted codec",
            ));
        }
    }
    let mut collisions = CollisionSet::default();
    let mut plans = BTreeMap::new();
    for entry in &archive.archive().files {
        checkpoint()?;
        let mode = entry.unix_mode();
        let kind = mode.unwrap_or(0) & 0o170000;
        if entry.is_anti_item
            || entry.is_symlink()
            || (entry.has_windows_attributes && entry.windows_attributes & 0x40 != 0)
            || ![0, 0o100000, 0o040000].contains(&kind)
            || (kind == 0o040000 && !entry.is_directory)
            || (kind == 0o100000 && entry.is_directory)
            || (entry.is_directory && (entry.has_stream || entry.size != 0))
            || (!entry.has_stream && entry.size != 0)
        {
            return Err(PortcoveError::verification(
                "7z links, special files, anti-items and inconsistent entry types are not allowed",
            ));
        }
        let (relative, key) = validate_relative_path(&entry.name, entry.is_directory)?;
        collisions.insert(key, entry.is_directory)?;
        plans.insert(
            entry.name.clone(),
            EntryPlan {
                relative,
                directory: entry.is_directory,
                executable: crate::permissions::archive_executable(mode),
                size: entry.size,
            },
        );
    }
    validate_plan(
        destination,
        &plans.values().cloned().collect::<Vec<_>>(),
        compressed_size,
    )?;
    // Method IDs do not prove supported arity or decoder properties. Build
    // every actual chain before any write, stopping its walk at the first
    // callback without consuming entries. Drop each dictionary before the next.
    // This is construction preflight, not payload or CRC qualification.
    for index in 0..archive.archive().blocks.len() {
        checkpoint()?;
        let result = archive
            .block_decoder(index)
            .and_then(|decoder| decoder.for_each_entries(&mut |_, _| Ok(false)));
        result.map_err(|error| {
            failure
                .borrow_mut()
                .take()
                .unwrap_or_else(|| decode_error(error))
        })?;
    }
    // 7z callbacks visit streamed blocks before streamless entries, not header order.
    // Remove by exact admitted identity and require the complete inventory at EOF.
    let result = archive.for_each_entries(|entry, reader| {
        let mut reader = DecodedInput {
            reader,
            failure: &failure,
        };
        let result = (|| {
            checkpoint()?;
            let plan = plans.remove(&entry.name).ok_or_else(|| {
                PortcoveError::verification("7z decoder returned an unexpected or repeated entry")
            })?;
            if plan.size != entry.size || plan.directory != entry.is_directory {
                return Err(PortcoveError::verification(
                    "7z decoded entry differs from its admitted plan",
                ));
            }
            write_entry(destination, &plan, &mut reader, checkpoint)?;
            if reader.read(&mut [0_u8; 1])? != 0 {
                return Err(PortcoveError::verification(
                    "7z entry exceeds its admitted size",
                ));
            }
            Ok(())
        })();
        if let Err(error) = result {
            if failure.borrow().is_none() {
                *failure.borrow_mut() = Some(error);
            }
            return Err(sevenz_turbo::Error::Other(
                "7z extraction interrupted".into(),
            ));
        }
        Ok(true)
    });
    drop(archive);
    if let Some(error) = failure.into_inner() {
        return Err(error);
    }
    result.map_err(decode_error)?;
    if !plans.is_empty() {
        return Err(PortcoveError::verification(
            "7z decoder omitted planned entries",
        ));
    }
    checkpoint()
}

#[cfg(test)]
pub(crate) fn inert_fixture() -> Vec<u8> {
    tests::encoded(&["assets/", "readme.txt"], None)
}

#[cfg(test)]
pub(crate) fn bad_crc_fixture() -> Vec<u8> {
    tests::bad_crc()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenz_turbo::{ArchiveEntry, ArchiveWriter};
    use std::io::Cursor;

    const CONTENT: &[u8] = b"Follow the upstream setup instructions.";

    pub(super) fn encoded(names: &[&str], attributes: Option<u32>) -> Vec<u8> {
        let mut writer = ArchiveWriter::new(Cursor::new(Vec::new())).unwrap();
        for name in names {
            let mut entry = if name.ends_with('/') {
                ArchiveEntry::new_directory(name)
            } else {
                ArchiveEntry::new_file(name)
            };
            if let Some(attributes) = attributes {
                entry.has_windows_attributes = true;
                entry.windows_attributes = attributes;
            }
            if entry.is_directory {
                writer
                    .push_archive_entry(entry, None::<Cursor<&[u8]>>)
                    .unwrap();
            } else {
                writer
                    .push_archive_entry(entry, Some(Cursor::new(CONTENT)))
                    .unwrap();
            }
        }
        writer.finish().unwrap().into_inner()
    }

    fn number(value: u64, out: &mut Vec<u8>) {
        for extra in 0..8_u32 {
            if (value >> (8 * extra)) < (1_u64 << (7 - extra)) {
                let prefix = ((0xff_u16 << (8 - extra)) & 0xff) as u8;
                out.push(prefix | (value >> (8 * extra)) as u8);
                out.extend_from_slice(&value.to_le_bytes()[..extra as usize]);
                return;
            }
        }
        out.push(0xff);
        out.extend_from_slice(&value.to_le_bytes());
    }

    // Independent raw format oracle: these declared counts/sizes need not have
    // corresponding payloads and never allocate their advertised resources.
    fn container(payload: &[u8], header: &[u8]) -> Vec<u8> {
        let mut start = Vec::new();
        start.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        start.extend_from_slice(&(header.len() as u64).to_le_bytes());
        start.extend_from_slice(&crc32fast::hash(header).to_le_bytes());
        let mut bytes = b"7z\xbc\xaf\x27\x1c\x00\x04".to_vec();
        bytes.extend_from_slice(&crc32fast::hash(&start).to_le_bytes());
        bytes.extend_from_slice(&start);
        bytes.extend_from_slice(payload);
        bytes.extend_from_slice(header);
        bytes
    }

    fn stream_header(method: &[u8], properties: &[u8], size: u64, encoded: bool) -> Vec<u8> {
        let mut h = vec![if encoded { 0x17 } else { 1 }];
        if !encoded {
            h.push(4);
        }
        // PackInfo: one stream. UnpackInfo: one folder with one coder.
        h.extend_from_slice(&[6, 0, 1, 9, 1, 0, 7, 0x0b, 1, 0, 1]);
        h.push(method.len() as u8 | if properties.is_empty() { 0 } else { 0x20 });
        h.extend_from_slice(method);
        if !properties.is_empty() {
            number(properties.len() as u64, &mut h);
            h.extend_from_slice(properties);
        }
        h.push(0x0c);
        number(size, &mut h);
        h.push(0);
        if !encoded {
            h.extend_from_slice(&[8, 0x0a, 1]);
            h.extend_from_slice(&crc32fast::hash(b"x").to_le_bytes());
            h.push(0);
        }
        h.push(0);
        if !encoded {
            // FilesInfo: one file, UTF-16 name "a" and no optional attributes.
            h.extend_from_slice(&[5, 1, 0x11, 5, 0, b'a', 0, 0, 0, 0, 0]);
        }
        h
    }

    pub(super) fn bad_crc() -> Vec<u8> {
        container(b"y", &stream_header(EncoderMethod::ID_COPY, &[], 1, false))
    }

    fn extraction(bytes: &[u8]) -> (tempfile::TempDir, PathBuf, Result<()>) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("fixture.7z");
        let output = temp.path().join("output");
        fs::write(&source, bytes).unwrap();
        fs::create_dir(&output).unwrap();
        let result = extract_download_archive_with_checkpoint(
            &source,
            &output,
            "fixture.7z",
            bytes.len() as u64,
            &|| Ok(()),
        );
        (temp, output, result)
    }

    #[test]
    fn stored_and_encoded_lzma2_archives_extract_by_identity_despite_streamless_order() {
        let raw = container(b"x", &stream_header(EncoderMethod::ID_COPY, &[], 1, false));
        let (_temp, output, result) = extraction(&raw);
        result.unwrap();
        assert_eq!(fs::read(output.join("a")).unwrap(), b"x");
        let (_temp, output, result) = extraction(&inert_fixture());
        result.unwrap();
        assert!(output.join("assets").is_dir());
        assert_eq!(fs::read(output.join("readme.txt")).unwrap(), CONTENT);
    }

    #[test]
    fn managed_extraction_keeps_sevenz_unsupported_before_writes() {
        let temp = tempfile::tempdir().unwrap();
        let bytes = inert_fixture();
        let source = temp.path().join("runtime.7z");
        let output = temp.path().join("managed");
        fs::write(&source, &bytes).unwrap();
        fs::create_dir(&output).unwrap();
        let error =
            extract_archive(&source, &output, "runtime.7z", bytes.len() as u64).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert_eq!(fs::read_dir(output).unwrap().count(), 0);
    }

    #[test]
    fn unsafe_names_collisions_and_links_fail_before_any_write() {
        for (names, attributes) in [
            (vec!["../escape"], None),
            (vec!["C:/escape"], None),
            (vec!["a\\b"], None),
            (vec!["CON.txt"], None),
            (vec!["A", "a"], None),
            (vec!["a", "a/b"], None),
            (vec!["link"], Some(0x400)),
            (vec!["device"], Some(0x40)),
            (vec!["link"], Some((0o120777 << 16) | 0x8000)),
            (vec!["fifo"], Some((0o010600 << 16) | 0x8000)),
        ] {
            let (_temp, output, result) = extraction(&encoded(&names, attributes));
            assert!(result.is_err(), "{names:?}");
            assert_eq!(fs::read_dir(output).unwrap().count(), 0, "{names:?}");
        }
    }

    #[test]
    fn compact_oversized_headers_counts_and_expansion_fail_without_writes() {
        let mut count = vec![1, 5];
        number(MAX_ENTRIES as u64 + 1, &mut count);
        let fixtures = [
            container(&[], &count),
            container(
                b"x",
                &stream_header(EncoderMethod::ID_COPY, &[], MAX_EXPANDED_BYTES + 1, false),
            ),
            container(
                b"x",
                &stream_header(EncoderMethod::ID_LZMA2, &[0], HEADER_BYTES + 1, true),
            ),
        ];
        for bytes in fixtures {
            let (_temp, output, result) = extraction(&bytes);
            let error = result.unwrap_err();
            assert!(error.message.contains("limit"), "{}", error.message);
            assert_eq!(fs::read_dir(output).unwrap().count(), 0);
        }
        let mut bytes = container(&[], &[1, 0]);
        bytes[20..28].copy_from_slice(&(HEADER_BYTES + 1).to_le_bytes());
        let crc = crc32fast::hash(&bytes[12..32]);
        bytes[8..12].copy_from_slice(&crc.to_le_bytes());
        let (_temp, output, result) = extraction(&bytes);
        assert_eq!(
            result.unwrap_err().presentation().presentation_key,
            "archive_safety_limit"
        );
        assert_eq!(fs::read_dir(output).unwrap().count(), 0);
    }

    #[test]
    fn parser_accepts_exact_header_boundary_and_bounds_dictionary_and_total_coders() {
        let header = stream_header(EncoderMethod::ID_COPY, &[], 1, false);
        let bytes = container(b"x", &header);
        let mut budget = limits();
        budget.max_end_header_bytes = header.len() as u64;
        ArchiveReader::with_limits(Cursor::new(&bytes), Password::empty(), budget).unwrap();
        budget.max_end_header_bytes -= 1;
        let error = ArchiveReader::with_limits(Cursor::new(bytes), Password::empty(), budget)
            .err()
            .unwrap();
        assert_eq!(error.limit_hit(), Some(sevenz_turbo::Limit::EndHeaderBytes));

        // Isolate the production decoder-memory ceiling from the independent
        // ratio gate: a tiny declaration must fail before allocating 256 MiB.
        let bytes = container(
            b"x",
            &stream_header(EncoderMethod::ID_LZMA2, &[32], 512 * 1024 * 1024, false),
        );
        let mut budget = limits();
        budget.max_unpack_ratio = u64::MAX;
        let error = ArchiveReader::with_limits(Cursor::new(bytes), Password::empty(), budget)
            .err()
            .unwrap();
        assert_eq!(error.limit_hit(), Some(sevenz_turbo::Limit::MemoryBytes));
        let mut budget = limits();
        budget.max_total_coders = 1;
        let error = ArchiveReader::with_limits(
            Cursor::new(encoded(&["a", "b"], None)),
            Password::empty(),
            budget,
        )
        .err()
        .unwrap();
        assert_eq!(error.limit_hit(), Some(sevenz_turbo::Limit::TotalCoders));
    }

    #[test]
    fn unsupported_codecs_and_anti_items_fail_before_output() {
        for method in [
            EncoderMethod::ID_PPMD,
            EncoderMethod::ID_AES256_SHA256,
            &[0x7f],
        ] {
            let bytes = container(b"x", &stream_header(method, &[], 1, false));
            let (_temp, output, result) = extraction(&bytes);
            assert!(result.is_err());
            assert_eq!(fs::read_dir(output).unwrap().count(), 0);
        }
        // Streamless file marked as an anti-item (deletion instruction).
        let header = [
            1, 5, 1, 0x0e, 1, 0x80, 0x0f, 1, 0x80, 0x10, 1, 0x80, 0x11, 5, 0, b'a', 0, 0, 0, 0, 0,
        ];
        let (_temp, output, result) = extraction(&container(&[], &header));
        assert!(result.unwrap_err().message.contains("anti-items"));
        assert_eq!(fs::read_dir(output).unwrap().count(), 0);
    }

    #[test]
    fn later_unsupported_coder_shape_is_rejected_before_the_first_file_write() {
        // Three packed inputs: one valid Copy folder, followed by a two-input
        // Copy folder. The bounded container graph is valid, but that codec
        // shape has no decoder (multi-input is supported only for BCJ2).
        let header = [
            1, 4, 6, 0, 3, 9, 1, 1, 1, 0, 7, 0x0b, 2, 0, 1, 1, 0, 1, 0x11, 0, 2, 1, 0, 1, 0x0c, 1,
            1, 0, 0, 5, 2, 0x11, 9, 0, b'a', 0, 0, 0, b'b', 0, 0, 0, 0, 0,
        ];
        let (_temp, output, result) = extraction(&container(b"xyz", &header));
        let error = result.unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert_eq!(fs::read_dir(output).unwrap().count(), 0);
    }

    #[test]
    fn payload_crc_and_truncation_errors_are_not_successful_extractions() {
        let mut archive =
            ArchiveReader::with_limits(Cursor::new(bad_crc()), Password::empty(), limits())
                .unwrap();
        let error = archive
            .for_each_entries(|_, mut reader| {
                std::io::copy(&mut reader, &mut std::io::sink())?;
                Ok(true)
            })
            .unwrap_err();
        assert!(error.has_checksum_mismatch(), "{error}");
        let (_temp, _output, result) = extraction(&bad_crc());
        assert_eq!(result.unwrap_err().code, crate::ErrorCode::Verification);
        let mut corrupt = inert_fixture();
        corrupt[32] ^= 0xff;
        let bytes = inert_fixture();
        for bytes in [corrupt.as_slice(), &bytes[..bytes.len() - 1]] {
            let (_temp, _output, result) = extraction(bytes);
            assert!(result.is_err());
        }
    }

    #[test]
    fn raw_reader_and_buffered_output_preserve_typed_cancellation() {
        let bytes = inert_fixture();
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("in.7z");
        fs::write(&source, &bytes).unwrap();
        let mut interrupted = 0;
        let mut completed = 0;
        for stop in 1..100 {
            let output = temp.path().join(format!("out-{stop}"));
            fs::create_dir(&output).unwrap();
            let calls = std::cell::Cell::new(0);
            let result = extract_download_archive_with_checkpoint(
                &source,
                &output,
                "in.7z",
                bytes.len() as u64,
                &|| {
                    calls.set(calls.get() + 1);
                    if calls.get() == stop {
                        Err(PortcoveError::new(crate::ErrorCode::Cancelled, "cancel 7z"))
                    } else {
                        Ok(())
                    }
                },
            );
            match result {
                Err(error) => {
                    assert_eq!(error.code, crate::ErrorCode::Cancelled);
                    interrupted += 1;
                }
                Ok(()) => {
                    completed += 1;
                    break;
                }
            }
        }
        assert!(interrupted > 10);
        assert_eq!(completed, 1);
    }
}
