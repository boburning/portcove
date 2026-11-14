//! Bounded IPS, BPS and UPS patch application over in-memory bytes.
//!
//! Implemented from the public format descriptions. Every reader is strict: a
//! truncated record, an offset or copy range outside its buffer, an overlong
//! variable-length number, trailing bytes or a checksum mismatch refuses the
//! patch. Nothing here touches the file system; callers own identity checks of
//! the original, the patch and the output.
use crate::{PortcoveError, Result, RomPatchFormat};

/// Upper bound for the original, the patch and the patched output.
pub(crate) const MAX_ROM_PATCH_BYTES: usize = 64 * 1024 * 1024;

/// Records applied between cancellation checkpoints.
const CHECKPOINT_INTERVAL: usize = 4096;

/// Apply `patch` to `original` and return the patched bytes.
pub(crate) fn apply(
    format: RomPatchFormat,
    original: &[u8],
    patch: &[u8],
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Vec<u8>> {
    if original.len() > MAX_ROM_PATCH_BYTES {
        return Err(invalid("the original is larger than the patch size limit"));
    }
    if patch.len() > MAX_ROM_PATCH_BYTES {
        return Err(invalid("the patch is larger than the patch size limit"));
    }
    checkpoint()?;
    let output = match format {
        RomPatchFormat::Ips => apply_ips(original, patch, checkpoint)?,
        RomPatchFormat::Bps => apply_bps(original, patch, checkpoint)?,
        RomPatchFormat::Ups => apply_ups(original, patch, checkpoint)?,
    };
    checkpoint()?;
    Ok(output)
}

fn invalid(reason: &str) -> PortcoveError {
    PortcoveError::source(format!("ROM patch cannot be applied: {reason}"))
}

/// Forward-only reader over a byte slice with bounded reads.
struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
    end: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let stop = self
            .position
            .checked_add(count)
            .filter(|stop| *stop <= self.end)
            .ok_or_else(|| invalid("the patch ends inside a record"))?;
        let slice = &self.bytes[self.position..stop];
        self.position = stop;
        Ok(slice)
    }

    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn big_endian(&mut self, count: usize) -> Result<usize> {
        Ok(self
            .take(count)?
            .iter()
            .fold(0_usize, |value, byte| (value << 8) | usize::from(*byte)))
    }

    /// The variable-length number shared by BPS and UPS: seven bits per byte,
    /// least significant first, the high bit marks the last byte, and every
    /// continuation adds the next power so each value has one encoding.
    fn number(&mut self) -> Result<u64> {
        let mut value = 0_u64;
        let mut shift = 1_u64;
        loop {
            let byte = self.byte()?;
            value = u64::from(byte & 0x7f)
                .checked_mul(shift)
                .and_then(|part| value.checked_add(part))
                .ok_or_else(|| invalid("a patch number is too large"))?;
            if byte & 0x80 != 0 {
                return Ok(value);
            }
            shift = shift
                .checked_mul(128)
                .ok_or_else(|| invalid("a patch number is too large"))?;
            value = value
                .checked_add(shift)
                .ok_or_else(|| invalid("a patch number is too large"))?;
        }
    }

    fn size(&mut self) -> Result<usize> {
        usize::try_from(self.number()?)
            .ok()
            .filter(|size| *size <= MAX_ROM_PATCH_BYTES)
            .ok_or_else(|| invalid("a declared size is larger than the patch size limit"))
    }
}

fn apply_ips(
    original: &[u8],
    patch: &[u8],
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Vec<u8>> {
    const EOF: &[u8] = b"EOF";
    if !patch.starts_with(b"PATCH") {
        return Err(invalid("the file is not an IPS patch"));
    }
    let mut cursor = Cursor {
        bytes: patch,
        position: 5,
        end: patch.len(),
    };
    let mut output = original.to_vec();
    let mut records = 0_usize;
    loop {
        records += 1;
        if records % CHECKPOINT_INTERVAL == 0 {
            checkpoint()?;
        }
        // The end marker is also a valid offset, so an IPS patch can never
        // change offset 0x454F46; that is the format's own limit.
        if patch.get(cursor.position..cursor.position + 3) == Some(EOF) {
            cursor.position += 3;
            break;
        }
        let offset = cursor.big_endian(3)?;
        let length = cursor.big_endian(2)?;
        let (length, data) = if length == 0 {
            let run = cursor.big_endian(2)?;
            if run == 0 {
                return Err(invalid("an IPS run has no length"));
            }
            (run, None)
        } else {
            (length, Some(cursor.take(length)?))
        };
        let stop = offset + length;
        if stop > MAX_ROM_PATCH_BYTES {
            return Err(invalid(
                "the patched output is larger than the patch size limit",
            ));
        }
        if stop > output.len() {
            output.resize(stop, 0);
        }
        match data {
            Some(data) => output[offset..stop].copy_from_slice(data),
            None => {
                let value = cursor.byte()?;
                output[offset..stop].fill(value);
            }
        }
    }
    match cursor.end - cursor.position {
        0 => {}
        3 => {
            let size = cursor.big_endian(3)?;
            if size > output.len() {
                return Err(invalid(
                    "the IPS truncation size is past the end of the output",
                ));
            }
            output.truncate(size);
        }
        _ => return Err(invalid("the IPS patch has data after its end marker")),
    }
    Ok(output)
}

/// Reads the three little-endian CRC32 values that end BPS and UPS patches and
/// checks the last one against the patch itself.
fn checked_footer(patch: &[u8], magic: &[u8]) -> Result<(u32, u32)> {
    if patch.len() < magic.len() + 12 || !patch.starts_with(magic) {
        return Err(invalid("the file is not a patch of the declared format"));
    }
    let footer = &patch[patch.len() - 12..];
    let word = |index: usize| {
        u32::from_le_bytes(
            footer[index * 4..index * 4 + 4]
                .try_into()
                .expect("four bytes"),
        )
    };
    if crc32fast::hash(&patch[..patch.len() - 4]) != word(2) {
        return Err(invalid(
            "the patch checksum does not match; the file is damaged",
        ));
    }
    Ok((word(0), word(1)))
}

fn apply_bps(
    original: &[u8],
    patch: &[u8],
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Vec<u8>> {
    let (source_crc, target_crc) = checked_footer(patch, b"BPS1")?;
    let mut cursor = Cursor {
        bytes: patch,
        position: 4,
        end: patch.len() - 12,
    };
    let source_size = cursor.size()?;
    let target_size = cursor.size()?;
    let metadata_size = cursor.size()?;
    cursor.take(metadata_size)?;
    if original.len() != source_size || crc32fast::hash(original) != source_crc {
        return Err(invalid(
            "the original is not the file this patch was made for",
        ));
    }
    let mut target = vec![0_u8; target_size];
    let mut written = 0_usize;
    let mut source_relative = 0_usize;
    let mut target_relative = 0_usize;
    let mut actions = 0_usize;
    let relative = |cursor: &mut Cursor<'_>, base: usize| -> Result<usize> {
        let encoded = cursor.number()?;
        let delta = usize::try_from(encoded >> 1)
            .map_err(|_| invalid("a BPS copy offset is out of range"))?;
        let moved = if encoded & 1 == 1 {
            base.checked_sub(delta)
        } else {
            base.checked_add(delta)
        };
        moved.ok_or_else(|| invalid("a BPS copy offset is out of range"))
    };
    while cursor.position < cursor.end {
        actions += 1;
        if actions % CHECKPOINT_INTERVAL == 0 {
            checkpoint()?;
        }
        let action = cursor.number()?;
        let length = usize::try_from(action >> 2)
            .ok()
            .and_then(|length| length.checked_add(1))
            .filter(|length| {
                written
                    .checked_add(*length)
                    .is_some_and(|stop| stop <= target_size)
            })
            .ok_or_else(|| invalid("a BPS action writes past the declared output size"))?;
        let stop = written + length;
        match action & 3 {
            0 => {
                let read = original
                    .get(written..stop)
                    .ok_or_else(|| invalid("a BPS source read is past the end of the original"))?;
                target[written..stop].copy_from_slice(read);
            }
            1 => target[written..stop].copy_from_slice(cursor.take(length)?),
            2 => {
                source_relative = relative(&mut cursor, source_relative)?;
                let read = source_relative
                    .checked_add(length)
                    .and_then(|end| original.get(source_relative..end))
                    .ok_or_else(|| invalid("a BPS source copy is outside the original"))?;
                target[written..stop].copy_from_slice(read);
                source_relative += length;
            }
            _ => {
                target_relative = relative(&mut cursor, target_relative)?;
                // A target copy may overlap what it is writing, so copy byte by
                // byte; it may only read bytes that are already written.
                if target_relative >= written {
                    return Err(invalid("a BPS target copy reads output not yet written"));
                }
                for index in 0..length {
                    target[written + index] = target[target_relative + index];
                }
                target_relative += length;
            }
        }
        written = stop;
    }
    if written != target_size {
        return Err(invalid(
            "the BPS patch ends before the declared output size",
        ));
    }
    if crc32fast::hash(&target) != target_crc {
        return Err(invalid(
            "the patched output does not match the checksum the patch records",
        ));
    }
    Ok(target)
}

fn apply_ups(
    original: &[u8],
    patch: &[u8],
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Vec<u8>> {
    let (input_crc, output_crc) = checked_footer(patch, b"UPS1")?;
    let mut cursor = Cursor {
        bytes: patch,
        position: 4,
        end: patch.len() - 12,
    };
    let input_size = cursor.size()?;
    let output_size = cursor.size()?;
    // Only the forward direction is applied: the original must be the input.
    if original.len() != input_size || crc32fast::hash(original) != input_crc {
        return Err(invalid(
            "the original is not the file this patch was made for",
        ));
    }
    let mut output = vec![0_u8; output_size];
    let kept = input_size.min(output_size);
    output[..kept].copy_from_slice(&original[..kept]);
    let mut offset = 0_usize;
    let mut runs = 0_usize;
    while cursor.position < cursor.end {
        runs += 1;
        if runs % CHECKPOINT_INTERVAL == 0 {
            checkpoint()?;
        }
        offset = usize::try_from(cursor.number()?)
            .ok()
            .and_then(|skip| offset.checked_add(skip))
            .filter(|offset| *offset <= output_size)
            .ok_or_else(|| invalid("a UPS change is past the declared output size"))?;
        loop {
            let difference = cursor.byte()?;
            if difference == 0 {
                offset += 1;
                break;
            }
            let slot = output
                .get_mut(offset)
                .ok_or_else(|| invalid("a UPS change is past the declared output size"))?;
            *slot = original.get(offset).copied().unwrap_or(0) ^ difference;
            offset += 1;
        }
    }
    if crc32fast::hash(&output) != output_crc {
        return Err(invalid(
            "the patched output does not match the checksum the patch records",
        ));
    }
    Ok(output)
}

#[cfg(test)]
#[path = "rom_patch_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "rom_patch_fuzz_tests.rs"]
mod fuzz_tests;
