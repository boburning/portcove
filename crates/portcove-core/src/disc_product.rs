//! Game identifiers read from a disc image before anything is unpacked.
//!
//! Xbox 360 title IDs come from the `default.xex` execution-info header, original
//! Xbox title IDs from the `default.xbe` certificate, PS2 serials from
//! `SYSTEM.CNF` and PSP IDs from `PARAM.SFO`. Only these documented fields are
//! read; nothing is executed, decrypted or patched.
#[cfg(test)]
#[path = "disc_product_tests.rs"]
mod tests;

use crate::{
    DiscImageFormat, PortcoveError, Result, disc_filesystem::DiscImage, failure::KnownFailureCause,
};

const HEADER_PEEK_BYTES: u64 = 64 * 1024;

fn unreadable(message: &str) -> PortcoveError {
    PortcoveError::source(message).with_known_cause(KnownFailureCause::UnsupportedDiscImage)
}

/// Read the game identifier the disc declares, or `None` when it has none of
/// the supported anchor files.
pub(crate) fn read_product_code(
    image: &mut DiscImage,
    format: DiscImageFormat,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Option<String>> {
    match format {
        DiscImageFormat::Xdvdfs => {
            if let Some(bytes) =
                image.read_root_file("default.xex", HEADER_PEEK_BYTES, checkpoint)?
            {
                return xex_title_id(&bytes).map(Some);
            }
            if let Some(bytes) =
                image.read_root_file("default.xbe", HEADER_PEEK_BYTES, checkpoint)?
            {
                return xbe_title_id(&bytes).map(Some);
            }
            Ok(None)
        }
        DiscImageFormat::Iso9660 => {
            if let Some(bytes) = image.read_root_file("SYSTEM.CNF", 4096, checkpoint)? {
                return ps2_serial(&bytes).map(Some);
            }
            if let Some(bytes) =
                image.read_root_file("PSP_GAME/PARAM.SFO", HEADER_PEEK_BYTES, checkpoint)?
            {
                return psp_disc_id(&bytes).map(Some);
            }
            Ok(None)
        }
    }
}

/// Refuse a disc whose identifier is not one the profile declares.
pub(crate) fn require_product_code(
    image: &mut DiscImage,
    format: DiscImageFormat,
    declared: &[String],
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<String> {
    let found = read_product_code(image, format, checkpoint)?;
    match found {
        Some(code) if declared.iter().any(|expected| same_code(expected, &code)) => Ok(code),
        found => Err(PortcoveError::verification(
            "the disc image is a different game or region than this port needs",
        )
        .detail("found", found.clone().unwrap_or_default())
        .detail("expected", declared.join(","))
        .with_known_cause(KnownFailureCause::DiscProductMismatch {
            found: found.unwrap_or_else(|| "no readable game ID".into()),
            expected: declared.to_vec(),
        })),
    }
}

/// Identifiers compare by their letters and digits only, ignoring case.
pub(crate) fn same_code(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        value
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .map(|character| character.to_ascii_uppercase())
            .collect::<String>()
    };
    let (left, right) = (normalize(left), normalize(right));
    !left.is_empty() && left == right
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn le32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}

pub(crate) fn xex_title_id(bytes: &[u8]) -> Result<String> {
    const EXECUTION_INFO: u32 = 0x0004_0006;
    let malformed = || unreadable("the disc's default.xex has an unreadable header");
    if bytes.get(..4) != Some(b"XEX2") {
        return Err(malformed());
    }
    let count = be32(bytes, 0x14).ok_or_else(malformed)?;
    if count > 64 {
        return Err(malformed());
    }
    for index in 0..count as usize {
        let at = 0x18 + index * 8;
        let key = be32(bytes, at).ok_or_else(malformed)?;
        if key == EXECUTION_INFO {
            let offset = be32(bytes, at + 4).ok_or_else(malformed)? as usize;
            let title =
                be32(bytes, offset.checked_add(12).ok_or_else(malformed)?).ok_or_else(malformed)?;
            return Ok(format!("{title:08X}"));
        }
    }
    Err(malformed())
}

pub(crate) fn xbe_title_id(bytes: &[u8]) -> Result<String> {
    let malformed = || unreadable("the disc's default.xbe has an unreadable header");
    if bytes.get(..4) != Some(b"XBEH") {
        return Err(malformed());
    }
    let base = le32(bytes, 0x104).ok_or_else(malformed)?;
    let certificate = le32(bytes, 0x118).ok_or_else(malformed)?;
    let offset = certificate.checked_sub(base).ok_or_else(malformed)? as usize;
    let title = le32(bytes, offset.checked_add(8).ok_or_else(malformed)?).ok_or_else(malformed)?;
    Ok(format!("{title:08X}"))
}

fn serial(letters_and_digits: &str) -> Option<String> {
    let value = letters_and_digits.to_ascii_uppercase();
    let (prefix, digits) = value.split_at_checked(4)?;
    (prefix.bytes().all(|byte| byte.is_ascii_uppercase())
        && digits.len() == 5
        && digits.bytes().all(|byte| byte.is_ascii_digit()))
    .then(|| format!("{prefix}-{digits}"))
}

pub(crate) fn ps2_serial(bytes: &[u8]) -> Result<String> {
    let malformed = || unreadable("the disc's SYSTEM.CNF has no readable boot file");
    let text = std::str::from_utf8(bytes).map_err(|_| malformed())?;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !matches!(key.trim().to_ascii_uppercase().as_str(), "BOOT2" | "BOOT") {
            continue;
        }
        let file = value
            .trim()
            .rsplit(['\\', '/', ':'])
            .next()
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default();
        let compact: String = file
            .chars()
            .filter(|character| !matches!(character, '_' | '.' | '-'))
            .collect();
        return serial(&compact).ok_or_else(malformed);
    }
    Err(malformed())
}

pub(crate) fn psp_disc_id(bytes: &[u8]) -> Result<String> {
    let malformed = || unreadable("the disc's PARAM.SFO has no readable disc ID");
    if bytes.get(..4) != Some(b"\0PSF") {
        return Err(malformed());
    }
    let keys = le32(bytes, 8).ok_or_else(malformed)? as usize;
    let data = le32(bytes, 12).ok_or_else(malformed)? as usize;
    let count = le32(bytes, 16).ok_or_else(malformed)? as usize;
    if count > 256 {
        return Err(malformed());
    }
    for index in 0..count {
        let entry = 20 + index * 16;
        let key_offset = bytes
            .get(entry..entry + 2)
            .map(|raw| usize::from(u16::from_le_bytes([raw[0], raw[1]])))
            .ok_or_else(malformed)?;
        let length = le32(bytes, entry + 4).ok_or_else(malformed)? as usize;
        let data_offset = le32(bytes, entry + 12).ok_or_else(malformed)? as usize;
        let start = keys.checked_add(key_offset).ok_or_else(malformed)?;
        let key = bytes
            .get(start..)
            .and_then(|rest| rest.split(|byte| *byte == 0).next())
            .ok_or_else(malformed)?;
        if key != b"DISC_ID" {
            continue;
        }
        let from = data.checked_add(data_offset).ok_or_else(malformed)?;
        let value = bytes
            .get(from..from.checked_add(length).ok_or_else(malformed)?)
            .ok_or_else(malformed)?;
        let text = std::str::from_utf8(value.split(|byte| *byte == 0).next().unwrap_or_default())
            .map_err(|_| malformed())?;
        let compact: String = text.chars().filter(|character| *character != '-').collect();
        return serial(&compact).ok_or_else(malformed);
    }
    Err(malformed())
}
