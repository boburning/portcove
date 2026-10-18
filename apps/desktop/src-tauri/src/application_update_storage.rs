//! Shared durable-file primitives for host-owned application update state.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

/// Read at most the state limit plus one overflow byte. Callers retain their
/// domain-specific empty/oversized-state errors and path validation.
pub(crate) fn read_bytes_with_overflow(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    read_with_overflow(fs::File::open(path)?, limit)
}

fn read_with_overflow(reader: impl Read, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both buffers are NUL-terminated and remain alive for this call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn replace_file_atomically(
    directory: &Path,
    source_name: &str,
    destination_name: &str,
) -> std::io::Result<()> {
    replace_file(
        &directory.join(source_name),
        &directory.join(destination_name),
    )?;
    #[cfg(unix)]
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

pub(crate) fn write_bytes_atomically(
    directory: &Path,
    temporary_name: &str,
    destination_name: &str,
    bytes: &[u8],
) -> std::io::Result<()> {
    let temporary = directory.join(temporary_name);
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    let write_result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        output.write_all(bytes)?;
        output.sync_all()?;
        replace_file_atomically(directory, temporary_name, destination_name)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_one_overflow_byte_even_without_a_truthful_length() {
        // An unending reader models growth after a metadata check without a
        // large fixture. The unread tail proves bounded consumption, not merely
        // a post-read size rejection.
        let mut input = std::io::repeat(b'x');
        let mut counted = (&mut input).take(100);
        assert_eq!(read_with_overflow(&mut counted, 8).unwrap(), b"xxxxxxxxx");
        assert_eq!(counted.limit(), 91);
    }

    #[test]
    fn state_read_does_not_trust_metadata_captured_before_growth() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("state.json");
        fs::write(&path, b"{}").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        assert!(metadata.len() <= 8);
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"                ")
            .unwrap();
        assert_eq!(read_bytes_with_overflow(&path, 8).unwrap().len(), 9);
    }

    #[test]
    fn supported_boundary_and_empty_reads_preserve_the_original_bytes() {
        for bytes in [b"".as_slice(), b"{}", b"12345678"] {
            assert_eq!(read_with_overflow(bytes, 8).unwrap(), bytes);
        }
        let missing = tempfile::tempdir().unwrap().path().join("missing");
        assert_eq!(
            read_bytes_with_overflow(&missing, 8).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
    }
}
