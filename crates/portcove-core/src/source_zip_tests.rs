use super::*;
use std::io::Cursor;

fn put16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend(value.to_le_bytes());
}
fn put32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend(value.to_le_bytes());
}
fn put64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend(value.to_le_bytes());
}

// A small independently formed ZIP32; custom fields live only in its directory.
fn archive(count: u16, fields: usize, payload: &[u8], comment: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut central = Vec::new();
    for index in 0..count {
        let name = format!("game-{index}.bin");
        let offset = bytes.len() as u32;
        let crc = crc32fast::hash(payload);
        bytes.extend(b"PK\x03\x04");
        for value in [20, 0, 0, 0, 0] {
            put16(&mut bytes, value);
        }
        for value in [crc, payload.len() as u32, payload.len() as u32] {
            put32(&mut bytes, value);
        }
        put16(&mut bytes, name.len() as u16);
        put16(&mut bytes, 0);
        bytes.extend(name.as_bytes());
        bytes.extend(payload);
        central.extend(b"PK\x01\x02");
        for value in [(3 << 8) | 20, 20, 0, 0, 0, 0] {
            put16(&mut central, value);
        }
        for value in [crc, payload.len() as u32, payload.len() as u32] {
            put32(&mut central, value);
        }
        for value in [name.len() as u16, (fields * 4) as u16, 0, 0, 0] {
            put16(&mut central, value);
        }
        put32(&mut central, 0o100644 << 16);
        put32(&mut central, offset);
        central.extend(name.as_bytes());
        for _ in 0..fields {
            put16(&mut central, 0xcafe);
            put16(&mut central, 0);
        }
    }
    let start = bytes.len() as u32;
    let length = central.len() as u32;
    bytes.extend(central);
    bytes.extend(b"PK\x05\x06");
    for value in [0, 0, count, count] {
        put16(&mut bytes, value);
    }
    put32(&mut bytes, length);
    put32(&mut bytes, start);
    put16(&mut bytes, comment.len() as u16);
    bytes.extend(comment);
    bytes
}

fn open_bytes(bytes: &[u8]) -> Result<CheckedSourceZip> {
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(bytes).unwrap();
    open(file, MAX_CONTAINER_BYTES, MAX_ENTRIES, &mut |_| Ok(()))
}

#[test]
fn accepts_pinned_writer_and_preserves_its_compressed_member_and_comment() {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer.set_comment("ordinary original files").unwrap();
    writer
        .start_file(
            "Sonic the Hedgehog.md",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
    writer.write_all(b"original unchanged bytes").unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let mut checked = open_bytes(&bytes).unwrap();
    assert_eq!(checked.storage_sha256, hex::encode(Sha256::digest(&bytes)));
    assert_eq!(checked.storage_size, bytes.len() as u64);
    let mut payload = Vec::new();
    checked
        .archive
        .by_index(0)
        .unwrap()
        .read_to_end(&mut payload)
        .unwrap();
    assert_eq!(payload, b"original unchanged bytes");
    assert_eq!(checked.archive.comment(), b"ordinary original files");
}

#[test]
fn accepts_maximum_comment_and_record_boundaries() {
    let bytes = archive(
        1,
        MAX_EXTRA_FIELDS_PER_ENTRY,
        &vec![42; 80_000],
        &vec![b'a'; u16::MAX as usize],
    );
    assert_eq!(open_bytes(&bytes).unwrap().archive.len(), 1);
    assert_eq!(
        open_bytes(&archive(MAX_ENTRIES as u16, 0, b"x", b""))
            .unwrap()
            .archive
            .len(),
        MAX_ENTRIES
    );
    assert_eq!(
        open_bytes(&archive(256, MAX_EXTRA_FIELDS_PER_ENTRY, b"x", b""))
            .unwrap()
            .archive
            .len(),
        256
    );
}

#[test]
fn refuses_exact_duplicate_records_including_an_overwritten_link() {
    for hidden_link in [false, true] {
        let mut bytes = archive(2, 0, b"original", b"");
        // Form both duplicate local and central names independently of ZipWriter,
        // which may itself refuse duplicates before the reader sees the fixture.
        let offsets = bytes
            .windows(b"game-1.bin".len())
            .enumerate()
            .filter_map(|(offset, name)| (name == b"game-1.bin").then_some(offset))
            .collect::<Vec<_>>();
        assert_eq!(offsets.len(), 2);
        for offset in offsets {
            bytes[offset..offset + 10].copy_from_slice(b"game-0.bin");
        }
        if hidden_link {
            let first = bytes
                .windows(4)
                .position(|value| value == b"PK\x01\x02")
                .unwrap();
            bytes[first + 38..first + 42].copy_from_slice(&(0o120777_u32 << 16).to_le_bytes());
        }
        let error = open_bytes(&bytes)
            .err()
            .expect("duplicate records must survive raw accounting");
        assert!(
            error.message.contains("duplicate effective member names"),
            "{}",
            error.message
        );
    }
}

#[test]
fn refuses_extra_field_object_amplification_before_parser_construction() {
    for bytes in [
        archive(1, MAX_EXTRA_FIELDS_PER_ENTRY + 1, b"x", b""),
        archive(257, MAX_EXTRA_FIELDS_PER_ENTRY, b"x", b""),
    ] {
        let error = open_bytes(&bytes).err().expect("raw extra record cap");
        assert!(
            error.message.contains("extra-field record limit"),
            "{}",
            error.message
        );
    }
}

#[test]
fn refuses_declared_directory_allocation_and_variable_metadata_with_tiny_fixtures() {
    let original = archive(1, 0, b"x", b"");
    let footer = original.len() - 22;
    let central = u32_at(&original, footer + 16) as usize;
    for (offset, value, message) in [
        (footer + 12, (MAX_DIRECTORY_BYTES as u32) + 1, "16 MiB"),
        (central + 42, u32::MAX, "ZIP64"),
    ] {
        let mut bytes = original.clone();
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        assert!(open_bytes(&bytes).err().unwrap().message.contains(message));
    }
    let mut count = original.clone();
    count[footer + 8..footer + 12].copy_from_slice(&[0x88, 0x13, 0x88, 0x13]);
    assert!(
        open_bytes(&count)
            .err()
            .unwrap()
            .message
            .contains("entry limit")
    );
    let mut variable = original;
    variable[central + 30..central + 32].copy_from_slice(&u16::MAX.to_le_bytes());
    assert!(
        open_bytes(&variable)
            .err()
            .unwrap()
            .message
            .contains("variable directory metadata")
    );
}

fn older_zip64_with_bad_later_directory() -> Vec<u8> {
    let original = archive(1, 0, b"older payload", b"");
    let end = original.len() - 22;
    let start = u32_at(&original, end + 16);
    let size = u32_at(&original, end + 12);
    let mut bytes = original[..end].to_vec();
    let zip64 = bytes.len() as u64;
    bytes.extend(b"PK\x06\x06");
    put64(&mut bytes, 44);
    put16(&mut bytes, 45);
    put16(&mut bytes, 45);
    put32(&mut bytes, 0);
    put32(&mut bytes, 0);
    put64(&mut bytes, 1);
    put64(&mut bytes, 1);
    put64(&mut bytes, u64::from(size));
    put64(&mut bytes, u64::from(start));
    bytes.extend(b"PK\x06\x07");
    put32(&mut bytes, 0);
    put64(&mut bytes, zip64);
    put32(&mut bytes, 1);
    bytes.extend(b"PK\x05\x06");
    for value in [0, 0, u16::MAX, u16::MAX] {
        put16(&mut bytes, value);
    }
    put32(&mut bytes, u32::MAX);
    put32(&mut bytes, u32::MAX);
    put16(&mut bytes, 0);
    // The earlier valid ZIP64 footer is outside both the usual footer window and
    // the additional pinned-parser lookbehind. Never give it to an ungated parser.
    bytes.extend(vec![0; 80_000]);
    let later_start = bytes.len() as u32;
    let mut later = original[start as usize..end].to_vec();
    later[30..32].copy_from_slice(&4_u16.to_le_bytes());
    // Structurally bounded, but the pinned parser rejects an empty UnicodePath.
    later.extend([0x75, 0x70, 0, 0]);
    let later_size = later.len() as u32;
    bytes.extend(later);
    bytes.extend(b"PK\x05\x06");
    for value in [0, 0, 1, 1] {
        put16(&mut bytes, value);
    }
    put32(&mut bytes, later_size);
    put32(&mut bytes, later_start);
    put16(&mut bytes, 0);
    bytes
}

#[test]
fn parser_cannot_fall_back_to_an_unchecked_older_zip64_footer() {
    let bytes = older_zip64_with_bad_later_directory();
    // The final raw directory itself fits the stated bounds. Its payload decoder
    // failure must end parsing, rather than admit the older unreviewed archive.
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(&bytes).unwrap();
    assert!(preflight(&mut file, MAX_ENTRIES, &mut |_| Ok(())).is_ok());
    assert!(open_bytes(&bytes).is_err());
}

#[test]
fn snapshot_stays_bound_when_original_path_is_replaced_and_cancellation_preserves_it() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("player-original.zip");
    let before = archive(1, 0, b"unchanged original", b"");
    std::fs::write(&path, &before).unwrap();
    let mut checked = open(
        File::open(&path).unwrap(),
        MAX_CONTAINER_BYTES,
        MAX_ENTRIES,
        &mut |_| Ok(()),
    )
    .unwrap();
    std::fs::write(&path, b"replacement after inspection").unwrap();
    let mut content = Vec::new();
    checked
        .archive
        .by_index(0)
        .unwrap()
        .read_to_end(&mut content)
        .unwrap();
    assert_eq!(content, b"unchanged original");
    assert_eq!(checked.storage_sha256, hex::encode(Sha256::digest(&before)));
    std::fs::write(&path, &before).unwrap();
    let cancelled = open(
        File::open(&path).unwrap(),
        MAX_CONTAINER_BYTES,
        MAX_ENTRIES,
        &mut |bytes| {
            if bytes > 0 {
                return Err(PortcoveError::conflict("qualification cancellation"));
            }
            Ok(())
        },
    );
    assert!(cancelled.is_err());
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn malformed_metadata_still_consumes_the_storage_hashing_budget() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("bad.zip");
    let mut bytes = archive(1, 0, b"x", b"");
    let footer = bytes.len() - 22;
    bytes[footer + 12..footer + 16]
        .copy_from_slice(&((MAX_DIRECTORY_BYTES as u32) + 1).to_le_bytes());
    std::fs::write(&path, &bytes).unwrap();
    let mut budget = crate::source_file::HashBudget {
        operation: None,
        limit: bytes.len() as u64,
        hashed: 0,
        max_zip_entries: MAX_ENTRIES,
    };
    assert!(
        crate::source_file::read_identity(&path, &["bin".into()], MAX_CONTAINER_BYTES, &mut budget)
            .is_err()
    );
    assert_eq!(budget.hashed, bytes.len() as u64);
}
