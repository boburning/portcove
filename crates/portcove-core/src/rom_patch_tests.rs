use super::*;

pub(crate) fn number(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let low = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(0x80 | low);
            return;
        }
        out.push(low);
        value -= 1;
    }
}

fn footer(mut patch: Vec<u8>, input: &[u8], output: &[u8]) -> Vec<u8> {
    patch.extend(crc32fast::hash(input).to_le_bytes());
    patch.extend(crc32fast::hash(output).to_le_bytes());
    let own = crc32fast::hash(&patch);
    patch.extend(own.to_le_bytes());
    patch
}

/// A BPS action as written by an encoder.
pub(crate) enum Action {
    SourceRead(usize),
    TargetRead(Vec<u8>),
    SourceCopy(i64, usize),
    TargetCopy(i64, usize),
}

fn signed(out: &mut Vec<u8>, delta: i64) {
    number(out, (delta.unsigned_abs() << 1) | u64::from(delta < 0));
}

pub(crate) fn bps(source: &[u8], target: &[u8], metadata: &[u8], actions: &[Action]) -> Vec<u8> {
    let mut patch = b"BPS1".to_vec();
    number(&mut patch, source.len() as u64);
    number(&mut patch, target.len() as u64);
    number(&mut patch, metadata.len() as u64);
    patch.extend(metadata);
    for action in actions {
        match action {
            Action::SourceRead(length) => number(&mut patch, ((*length as u64 - 1) << 2) | 0),
            Action::TargetRead(bytes) => {
                number(&mut patch, ((bytes.len() as u64 - 1) << 2) | 1);
                patch.extend(bytes);
            }
            Action::SourceCopy(delta, length) => {
                number(&mut patch, ((*length as u64 - 1) << 2) | 2);
                signed(&mut patch, *delta);
            }
            Action::TargetCopy(delta, length) => {
                number(&mut patch, ((*length as u64 - 1) << 2) | 3);
                signed(&mut patch, *delta);
            }
        }
    }
    footer(patch, source, target)
}

/// Encode `output` against `input` as UPS runs of differing bytes.
pub(crate) fn ups(input: &[u8], output: &[u8]) -> Vec<u8> {
    let mut patch = b"UPS1".to_vec();
    number(&mut patch, input.len() as u64);
    number(&mut patch, output.len() as u64);
    let byte = |bytes: &[u8], index: usize| bytes.get(index).copied().unwrap_or(0);
    let mut last = 0_usize;
    let mut index = 0_usize;
    while index < output.len() {
        if byte(input, index) == output[index] {
            index += 1;
            continue;
        }
        number(&mut patch, (index - last) as u64);
        while index < output.len() && byte(input, index) != output[index] {
            patch.push(byte(input, index) ^ output[index]);
            index += 1;
        }
        patch.push(0);
        index += 1;
        last = index;
    }
    footer(patch, input, output)
}

pub(crate) fn ips(
    records: &[(usize, &[u8])],
    rle: &[(usize, u16, u8)],
    truncate: Option<usize>,
) -> Vec<u8> {
    let mut patch = b"PATCH".to_vec();
    for (offset, data) in records {
        patch.extend(&(*offset as u32).to_be_bytes()[1..]);
        patch.extend((data.len() as u16).to_be_bytes());
        patch.extend(*data);
    }
    for (offset, length, value) in rle {
        patch.extend(&(*offset as u32).to_be_bytes()[1..]);
        patch.extend([0, 0]);
        patch.extend(length.to_be_bytes());
        patch.push(*value);
    }
    patch.extend(b"EOF");
    if let Some(size) = truncate {
        patch.extend(&(size as u32).to_be_bytes()[1..]);
    }
    patch
}

fn run(format: RomPatchFormat, original: &[u8], patch: &[u8]) -> Result<Vec<u8>> {
    apply(format, original, patch, &|| Ok(()))
}

fn original() -> Vec<u8> {
    (0..4096_u32).map(|value| (value * 7 % 251) as u8).collect()
}

#[test]
fn ips_writes_records_and_runs_and_extends_the_output() {
    let source = original();
    let patch = ips(&[(16, b"HELLO"), (4100, b"END")], &[(32, 8, 0xAA)], None);
    let output = run(RomPatchFormat::Ips, &source, &patch).unwrap();
    let mut expected = source.clone();
    expected[16..21].copy_from_slice(b"HELLO");
    expected[32..40].fill(0xAA);
    expected.resize(4103, 0);
    expected[4100..4103].copy_from_slice(b"END");
    assert_eq!(output, expected);
}

#[test]
fn ips_applies_the_truncation_extension() {
    let source = original();
    let output = run(
        RomPatchFormat::Ips,
        &source,
        &ips(&[(0, b"X")], &[], Some(1024)),
    )
    .unwrap();
    assert_eq!(output.len(), 1024);
    assert_eq!(output[0], b'X');
    assert_eq!(output[1..], source[1..1024]);
    assert!(run(RomPatchFormat::Ips, &source, &ips(&[], &[], Some(5000))).is_err());
}

#[test]
fn ips_refuses_malformed_patches() {
    let source = original();
    let valid = ips(&[(16, b"HELLO")], &[], None);
    for (case, patch) in [
        ("wrong magic", b"PATCX".to_vec()),
        ("no end marker", valid[..valid.len() - 3].to_vec()),
        ("truncated record", valid[..12].to_vec()),
        ("trailing bytes", [valid.clone(), vec![1]].concat()),
        ("zero-length run", ips(&[], &[(0, 0, 1)], None)),
    ] {
        assert!(run(RomPatchFormat::Ips, &source, &patch).is_err(), "{case}");
    }
}

#[test]
fn bps_applies_every_action() {
    let source = original();
    // Keep 100 bytes, insert text, copy source bytes from before and after the
    // cursor, then repeat earlier output with an overlapping target copy.
    let mut target = source[..100].to_vec();
    target.extend(b"PATCHED");
    target.extend(&source[50..70]);
    target.extend(&source[3000..3010]);
    let start = target.len();
    for index in 0..12 {
        target.push(target[start - 3 + index]);
    }
    let patch = bps(
        &source,
        &target,
        b"<metadata/>",
        &[
            Action::SourceRead(100),
            Action::TargetRead(b"PATCHED".to_vec()),
            Action::SourceCopy(50, 20),
            Action::SourceCopy(2930, 10),
            Action::TargetCopy((start - 3) as i64, 12),
        ],
    );
    assert_eq!(run(RomPatchFormat::Bps, &source, &patch).unwrap(), target);
}

#[test]
fn bps_applies_negative_relative_offsets() {
    let source = original();
    let mut target = source[200..210].to_vec();
    target.extend(&source[100..105]);
    let patch = bps(
        &source,
        &target,
        b"",
        &[Action::SourceCopy(200, 10), Action::SourceCopy(-110, 5)],
    );
    assert_eq!(run(RomPatchFormat::Bps, &source, &patch).unwrap(), target);
}

#[test]
fn bps_refuses_wrong_original_and_damaged_patches() {
    let source = original();
    let target = [source[..10].to_vec(), b"NEW".to_vec()].concat();
    let patch = bps(
        &source,
        &target,
        b"",
        &[Action::SourceRead(10), Action::TargetRead(b"NEW".to_vec())],
    );
    assert!(run(RomPatchFormat::Bps, &source, &patch).is_ok());
    let mut other = source.clone();
    other[0] ^= 1;
    assert!(
        run(RomPatchFormat::Bps, &other, &patch).is_err(),
        "wrong original"
    );
    assert!(
        run(RomPatchFormat::Bps, &source[1..], &patch).is_err(),
        "wrong size"
    );
    let mut damaged = patch.clone();
    damaged[8] ^= 1;
    assert!(
        run(RomPatchFormat::Bps, &source, &damaged).is_err(),
        "patch checksum"
    );
    let mut wrong_target = patch.clone();
    let at = wrong_target.len() - 8;
    wrong_target[at] ^= 1;
    let own = crc32fast::hash(&wrong_target[..wrong_target.len() - 4]);
    let end = wrong_target.len();
    wrong_target[end - 4..].copy_from_slice(&own.to_le_bytes());
    assert!(
        run(RomPatchFormat::Bps, &source, &wrong_target).is_err(),
        "target checksum"
    );
}

#[test]
fn bps_refuses_out_of_range_actions() {
    let source = [1_u8, 2, 3, 4];
    let target = vec![0_u8; 8];
    for (case, actions) in [
        ("source read past original", vec![Action::SourceRead(8)]),
        ("copy before start", vec![Action::SourceCopy(-1, 8)]),
        ("copy past end", vec![Action::SourceCopy(2, 8)]),
        (
            "target copy of unwritten output",
            vec![Action::TargetCopy(0, 8)],
        ),
        ("write past output", vec![Action::TargetRead(vec![0; 9])]),
        ("short output", vec![Action::TargetRead(vec![0; 4])]),
    ] {
        let patch = bps(&source, &target, b"", &actions);
        assert!(run(RomPatchFormat::Bps, &source, &patch).is_err(), "{case}");
    }
}

#[test]
fn ups_applies_changes_and_size_changes() {
    let source = original();
    let mut grown = source.clone();
    grown[10] = 0;
    grown[11..14].copy_from_slice(b"abc");
    grown.extend(b"tail bytes");
    assert_eq!(
        run(RomPatchFormat::Ups, &source, &ups(&source, &grown)).unwrap(),
        grown
    );
    let mut shrunk = source[..2000].to_vec();
    shrunk[1999] ^= 0x55;
    assert_eq!(
        run(RomPatchFormat::Ups, &source, &ups(&source, &shrunk)).unwrap(),
        shrunk
    );
}

#[test]
fn ups_refuses_wrong_original_reverse_direction_and_damage() {
    let source = original();
    let mut target = source.clone();
    target[5] ^= 0xFF;
    target.push(1);
    let patch = ups(&source, &target);
    assert!(
        run(RomPatchFormat::Ups, &target, &patch).is_err(),
        "reverse direction"
    );
    let mut damaged = patch.clone();
    damaged[9] ^= 1;
    assert!(
        run(RomPatchFormat::Ups, &source, &damaged).is_err(),
        "patch checksum"
    );
    assert!(run(RomPatchFormat::Ups, &source, &patch[..patch.len() - 1]).is_err());
}

#[test]
fn formats_refuse_each_other_and_oversized_inputs() {
    let source = original();
    let target = [source.clone(), b"x".to_vec()].concat();
    let patch = ups(&source, &target);
    assert!(run(RomPatchFormat::Bps, &source, &patch).is_err());
    assert!(run(RomPatchFormat::Ips, &source, &patch).is_err());
    let huge = vec![0_u8; MAX_ROM_PATCH_BYTES + 1];
    assert!(run(RomPatchFormat::Ips, &huge, &ips(&[], &[], None)).is_err());
    assert!(run(RomPatchFormat::Ips, &source, &huge).is_err());
    // A declared size above the limit is refused before anything is allocated.
    let mut oversized = b"BPS1".to_vec();
    number(&mut oversized, source.len() as u64);
    number(&mut oversized, MAX_ROM_PATCH_BYTES as u64 + 1);
    number(&mut oversized, 0);
    let oversized = footer(oversized, &source, b"");
    assert!(run(RomPatchFormat::Bps, &source, &oversized).is_err());
}

#[test]
fn cancellation_is_honoured() {
    let source = original();
    let patch = ips(&[(0, b"A")], &[], None);
    let cancelled = apply(RomPatchFormat::Ips, &source, &patch, &|| {
        Err(crate::PortcoveError::new(
            crate::ErrorCode::Cancelled,
            "stopped",
        ))
    });
    assert!(cancelled.is_err());
}

#[test]
fn numbers_have_a_single_bounded_encoding() {
    for value in [0_u64, 1, 127, 128, 16_511, 16_512, 1 << 40] {
        let mut bytes = Vec::new();
        number(&mut bytes, value);
        let mut cursor = Cursor {
            bytes: &bytes,
            position: 0,
            end: bytes.len(),
        };
        assert_eq!(cursor.number().unwrap(), value);
        assert_eq!(cursor.position, bytes.len());
    }
    let endless = vec![0_u8; 32];
    let mut cursor = Cursor {
        bytes: &endless,
        position: 0,
        end: endless.len(),
    };
    assert!(cursor.number().is_err());
}
