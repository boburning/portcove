//! Strict extraction of the authenticated Tauri macOS updater USTAR package.
//!
//! Read raw headers ourselves so an extension record cannot allocate memory in
//! a tar parser before the application has applied its limits. This accepts the
//! regular files and directories produced by the current Tauri bundler only.

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;

const BLOCK: usize = 512;
const MAX_ENTRIES: usize = 2048;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_DECODED_BYTES: u64 = 1024 * 1024 * 1024;
const ROOT: &str = "Portcove.app";

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn octal(field: &[u8]) -> io::Result<u64> {
    let value = field
        .split(|byte| *byte == 0)
        .next()
        .ok_or_else(|| invalid("empty tar numeric field"))?;
    let value = value
        .iter()
        .copied()
        .skip_while(|byte| *byte == b' ')
        .collect::<Vec<_>>();
    let value = value
        .iter()
        .copied()
        .take_while(|byte| *byte != b' ')
        .collect::<Vec<_>>();
    if value.is_empty() || !value.iter().all(|byte| (b'0'..=b'7').contains(byte)) {
        return Err(invalid("invalid or unsupported tar numeric field"));
    }
    value.into_iter().try_fold(0_u64, |number, digit| {
        number
            .checked_mul(8)
            .and_then(|number| number.checked_add(u64::from(digit - b'0')))
            .ok_or_else(|| invalid("tar numeric field overflow"))
    })
}

fn entry_path(header: &[u8; BLOCK], directory: bool) -> io::Result<PathBuf> {
    if header[345..500].iter().any(|byte| *byte != 0) {
        return Err(invalid("tar prefix extensions are unsupported"));
    }
    let raw = header[..100]
        .split(|byte| *byte == 0)
        .next()
        .ok_or_else(|| invalid("missing tar entry name"))?;
    let raw = std::str::from_utf8(raw).map_err(|_| invalid("tar path is not UTF-8"))?;
    let raw = if directory {
        raw.trim_end_matches('/')
    } else {
        raw
    };
    if raw.is_empty() || raw.contains('\\') || raw.starts_with('/') || raw.contains(':') {
        return Err(invalid("invalid tar entry path"));
    }
    let mut components = raw.split('/');
    if components.next() != Some(ROOT)
        || components.any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(invalid("tar entry escapes the expected application bundle"));
    }
    Ok(PathBuf::from(raw))
}

fn read_block(input: &mut impl Read, decoded: &mut u64) -> io::Result<[u8; BLOCK]> {
    *decoded = decoded
        .checked_add(BLOCK as u64)
        .ok_or_else(|| invalid("tar decoded size overflow"))?;
    if *decoded > MAX_DECODED_BYTES {
        return Err(invalid("tar decoded size exceeds limit"));
    }
    let mut block = [0_u8; BLOCK];
    input.read_exact(&mut block)?;
    Ok(block)
}

fn checked_header(header: &[u8; BLOCK]) -> io::Result<()> {
    if &header[257..263] != b"ustar " && &header[257..263] != b"ustar\0" {
        return Err(invalid("unsupported tar header format"));
    }
    let recorded = octal(&header[148..156])?;
    let actual: u64 = header
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            if (148..156).contains(&index) {
                u64::from(b' ')
            } else {
                u64::from(*byte)
            }
        })
        .sum();
    if recorded != actual {
        return Err(invalid("tar header checksum mismatch"));
    }
    Ok(())
}

fn set_mode(path: &Path, mode: u64, directory: bool) -> io::Result<()> {
    let kind = mode & 0o170000;
    if mode & !(0o170000 | 0o777) != 0
        || mode & 0o6000 != 0
        || (kind != 0 && kind != if directory { 0o040000 } else { 0o100000 })
    {
        return Err(invalid("unsafe tar entry permissions"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode((mode & 0o777) as u32))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

/// Extracts one verified archive into an existing, empty private directory.
/// The caller must retain that directory on failure for diagnosis and must not
/// publish its bundle until platform identity and signature checks pass.
#[cfg(test)]
fn extract_verified_macos_bundle(archive: &Path, output: &Path) -> io::Result<PathBuf> {
    extract_verified_macos_bundle_file(File::open(archive)?, output)
}

pub(crate) fn extract_verified_macos_bundle_file(
    archive: File,
    output: &Path,
) -> io::Result<PathBuf> {
    if !fs::read_dir(output)?.next().is_none() {
        return Err(invalid("macOS extraction directory is not empty"));
    }
    let mut input = GzDecoder::new(archive);
    let mut decoded = 0_u64;
    let mut paths: BTreeSet<PathBuf> = BTreeSet::new();
    let mut entries = 0_usize;
    loop {
        let header = read_block(&mut input, &mut decoded)?;
        if header.iter().all(|byte| *byte == 0) {
            let end = read_block(&mut input, &mut decoded)?;
            if end.iter().any(|byte| *byte != 0) || entries == 0 {
                return Err(invalid("invalid tar end marker"));
            }
            let mut trailing = [0_u8; BLOCK];
            loop {
                let count = input.read(&mut trailing)?;
                if count == 0 {
                    break;
                }
                decoded = decoded
                    .checked_add(count as u64)
                    .ok_or_else(|| invalid("tar decoded size overflow"))?;
                if decoded > MAX_DECODED_BYTES || trailing[..count].iter().any(|byte| *byte != 0) {
                    return Err(invalid("unexpected data after tar end marker"));
                }
            }
            let bundle = output.join(ROOT);
            if !bundle.join("Contents/Info.plist").is_file()
                || !bundle.join("Contents/MacOS/portcove-desktop").is_file()
                || !bundle
                    .join("Contents/_CodeSignature/CodeResources")
                    .is_file()
            {
                return Err(invalid("macOS updater bundle is incomplete"));
            }
            // Persist descendant names and final modes before the caller may
            // publish the bundle through the atomic name exchange.
            #[cfg(unix)]
            {
                let mut directories = paths
                    .iter()
                    .filter(|path| output.join(path).is_dir())
                    .collect::<Vec<_>>();
                directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
                for directory in directories {
                    File::open(output.join(directory))?.sync_all()?;
                }
                File::open(output)?.sync_all()?;
            }
            return Ok(bundle);
        }
        entries += 1;
        if entries > MAX_ENTRIES {
            return Err(invalid("tar entry count exceeds limit"));
        }
        checked_header(&header)?;
        let directory = header[156] == b'5';
        if !directory && header[156] != b'0' && header[156] != 0 {
            return Err(invalid("tar links and extensions are unsupported"));
        }
        let size = octal(&header[124..136])?;
        if size > MAX_FILE_BYTES || (directory && size != 0) {
            return Err(invalid("tar entry size exceeds limit"));
        }
        let padded = size
            .checked_add(511)
            .ok_or_else(|| invalid("tar entry size overflow"))?
            / 512
            * 512;
        if decoded
            .checked_add(padded)
            .is_none_or(|total| total > MAX_DECODED_BYTES)
        {
            return Err(invalid("tar decoded size exceeds limit"));
        }
        let relative = entry_path(&header, directory)?;
        if !paths.insert(relative.clone()) {
            return Err(invalid("duplicate tar entry path"));
        }
        let target = output.join(&relative);
        let parent = target
            .parent()
            .ok_or_else(|| invalid("tar entry has no parent"))?;
        if !parent.is_dir() {
            return Err(invalid("tar parent directory was not declared first"));
        }
        let mode = octal(&header[100..108])?;
        if directory {
            fs::create_dir(&target)?;
            set_mode(&target, mode, true)?;
        } else {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            let copied = io::copy(&mut Read::by_ref(&mut input).take(size), &mut file)?;
            if copied != size {
                return Err(invalid("truncated tar file payload"));
            }
            set_mode(&target, mode, false)?;
            file.sync_all()?;
        }
        let padding = padded - size;
        if padding != 0 {
            let mut discard = [0_u8; BLOCK];
            input.read_exact(&mut discard[..padding as usize])?;
        }
        decoded += padded;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    fn write_fixture(path: &Path) {
        let output = File::create(path).unwrap();
        let mut archive = tar::Builder::new(GzEncoder::new(output, Compression::default()));
        for directory in [
            "Portcove.app",
            "Portcove.app/Contents",
            "Portcove.app/Contents/MacOS",
            "Portcove.app/Contents/_CodeSignature",
        ] {
            archive.append_dir(directory, ".").unwrap();
        }
        for path in [
            "Portcove.app/Contents/Info.plist",
            "Portcove.app/Contents/MacOS/portcove-desktop",
            "Portcove.app/Contents/_CodeSignature/CodeResources",
        ] {
            let mut header = tar::Header::new_ustar();
            header.set_size(4);
            header.set_mode(if path.ends_with("portcove-desktop") {
                0o755
            } else {
                0o644
            });
            header.set_cksum();
            archive
                .append_data(&mut header, path, b"test".as_slice())
                .unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn extracts_simple_tauri_bundle_and_rejects_nonempty_destination() {
        let temporary = tempfile::tempdir().unwrap();
        let archive = temporary.path().join("candidate.app.tar.gz");
        let output = temporary.path().join("extract");
        fs::create_dir(&output).unwrap();
        write_fixture(&archive);
        let bundle = extract_verified_macos_bundle(&archive, &output).unwrap();
        assert_eq!(
            fs::read(bundle.join("Contents/MacOS/portcove-desktop")).unwrap(),
            b"test"
        );
        assert!(extract_verified_macos_bundle(&archive, &output).is_err());
    }

    #[test]
    fn oversized_raw_entry_is_rejected_before_payload_or_writes() {
        let temporary = tempfile::tempdir().unwrap();
        let archive = temporary.path().join("oversized.app.tar.gz");
        let output = temporary.path().join("extract");
        fs::create_dir(&output).unwrap();
        let mut header = tar::Header::new_ustar();
        header
            .set_path("Portcove.app/Contents/MacOS/portcove-desktop")
            .unwrap();
        header.set_size(MAX_FILE_BYTES + 1);
        header.set_mode(0o755);
        header.set_cksum();
        let mut gzip = GzEncoder::new(File::create(&archive).unwrap(), Compression::default());
        gzip.write_all(header.as_bytes()).unwrap();
        gzip.finish().unwrap();
        let error = extract_verified_macos_bundle(&archive, &output).unwrap_err();
        assert!(error.to_string().contains("size exceeds limit"));
        assert_eq!(fs::read_dir(&output).unwrap().count(), 0);
    }

    #[test]
    fn parser_extension_is_rejected_before_its_declared_payload() {
        let temporary = tempfile::tempdir().unwrap();
        let archive = temporary.path().join("pax.app.tar.gz");
        let output = temporary.path().join("extract");
        fs::create_dir(&output).unwrap();
        let mut header = tar::Header::new_ustar();
        header.set_path("Portcove.app/PaxHeader").unwrap();
        header.set_entry_type(tar::EntryType::XHeader);
        header.set_size(MAX_FILE_BYTES);
        header.set_mode(0o644);
        header.set_cksum();
        let mut gzip = GzEncoder::new(File::create(&archive).unwrap(), Compression::default());
        gzip.write_all(header.as_bytes()).unwrap();
        gzip.finish().unwrap();
        let error = extract_verified_macos_bundle(&archive, &output).unwrap_err();
        assert!(error.to_string().contains("unsupported"));
        assert_eq!(fs::read_dir(&output).unwrap().count(), 0);
    }

    #[test]
    fn extracts_retained_hosted_tauri_archive_when_available() {
        let Some(archive) = std::env::var_os("PORTCOVE_MACOS_ARCHIVE_TEST_PATH") else {
            return;
        };
        let temporary = tempfile::tempdir().unwrap();
        let bundle = extract_verified_macos_bundle(Path::new(&archive), temporary.path()).unwrap();
        assert!(bundle.join("Contents/MacOS/portcove-desktop").is_file());
    }
}
