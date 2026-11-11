use std::path::Path;

use crate::{Platform, PortcoveError, Result};

pub(crate) fn archive_executable(mode: Option<u32>) -> bool {
    mode.is_some_and(|mode| mode & 0o111 != 0)
}

pub(crate) fn normalize_archive_entry(
    path: &Path,
    directory: bool,
    executable: bool,
) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = if directory || executable {
            0o755
        } else {
            0o644
        };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, directory, executable);
    }
    Ok(())
}

pub(crate) fn executable_intent(path: &Path) -> Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        Ok(std::fs::metadata(path)?.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(false)
    }
}

pub(crate) fn require_executable(path: &Path, label: &str) -> Result<()> {
    if !path.is_file() {
        return Err(PortcoveError::verification(format!(
            "{label} is missing or is not a regular file"
        )));
    }
    #[cfg(unix)]
    if !executable_intent(path)? {
        return Err(PortcoveError::verification(format!(
            "{label} is not executable on this Unix host"
        )));
    }
    Ok(())
}

pub(crate) const fn platform_requires_executable(platform: Platform) -> bool {
    !matches!(platform, Platform::WindowsX86_64)
}

pub(crate) fn require_platform_executable(
    path: &Path,
    platform: Platform,
    label: &str,
) -> Result<()> {
    if platform_requires_executable(platform) {
        require_executable(path, label)
    } else if !path.is_file() {
        Err(PortcoveError::verification(format!(
            "{label} is missing or is not a regular file"
        )))
    } else {
        Ok(())
    }
}

/// Whether the file's header identifies a binary this platform can run. A text file, a
/// script, a binary for another architecture or an unreadable file does not qualify.
pub(crate) fn is_platform_binary(path: &Path, platform: Platform) -> Result<bool> {
    let file = std::fs::File::open(path)?;
    header_is_platform_binary(&read_header(&file)?, platform)
}

fn read_header(file: &std::fs::File) -> Result<Vec<u8>> {
    use std::io::Read;

    let mut header = Vec::with_capacity(64);
    file.take(64).read_to_end(&mut header)?;
    Ok(header)
}

fn header_is_platform_binary(header: &[u8], platform: Platform) -> Result<bool> {
    Ok(match platform {
        Platform::LinuxX86_64 => {
            // ELF64, little endian, executable or position-independent, x86-64.
            header.len() >= 20
                && header[..4] == [0x7f, b'E', b'L', b'F']
                && header[4] == 2
                && header[5] == 1
                && matches!(u16::from_le_bytes([header[16], header[17]]), 2 | 3)
                && u16::from_le_bytes([header[18], header[19]]) == 62
        }
        Platform::MacosX86_64 | Platform::MacosAarch64 => {
            let wanted: u32 = if platform == Platform::MacosAarch64 {
                0x0100_000c
            } else {
                0x0100_0007
            };
            if header.len() >= 8 && header[..4] == [0xcf, 0xfa, 0xed, 0xfe] {
                u32::from_le_bytes([header[4], header[5], header[6], header[7]]) == wanted
            } else if header.len() >= 8 && header[..4] == [0xca, 0xfe, 0xba, 0xbe] {
                // A universal binary lists at most a few slices; one must match.
                let count = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
                (1..=2).contains(&count)
                    && (0..count as usize).any(|index| {
                        let start = 8 + index * 20;
                        header.len() >= start + 4
                            && u32::from_be_bytes([
                                header[start],
                                header[start + 1],
                                header[start + 2],
                                header[start + 3],
                            ]) == wanted
                    })
            } else {
                false
            }
        }
        Platform::WindowsX86_64 => false,
    })
}

/// Grant execute permission to one resolved, declared program. The file must be a regular
/// file that verifies as a binary for the platform; a program the publisher already marked
/// executable is left exactly as it is, and Windows has nothing to grant.
pub(crate) fn grant_verified_executable(
    path: &Path,
    platform: Platform,
    label: &str,
) -> Result<()> {
    if !platform_requires_executable(platform) {
        return Ok(());
    }
    if !std::fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(PortcoveError::verification(format!(
            "{label} is missing or is not a regular file"
        )));
    }
    if executable_intent(path)? {
        return Ok(());
    }
    // Verify and change the same open file, so a path swap cannot redirect the grant.
    let file = std::fs::File::open(path)?;
    if !file.metadata()?.is_file() || !header_is_platform_binary(&read_header(&file)?, platform)? {
        return Err(PortcoveError::verification(format!(
            "{label} is not a binary for this platform, so execution is not granted"
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        file.set_permissions(std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod grant_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn elf(machine: u16) -> Vec<u8> {
        let mut bytes = vec![0_u8; 64];
        bytes[..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
        bytes[4] = 2;
        bytes[5] = 1;
        bytes[16] = 3;
        bytes[18..20].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    fn file(dir: &Path, name: &str, bytes: &[u8], mode: u32) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn a_verified_binary_is_granted_and_everything_else_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let good = file(dir.path(), "good", &elf(62), 0o644);
        grant_verified_executable(&good, Platform::LinuxX86_64, "program").unwrap();
        assert!(executable_intent(&good).unwrap());
        for (name, bytes) in [
            ("arm", elf(183)),
            ("script", b"#!/bin/sh\nexit 0\n".to_vec()),
            ("empty", Vec::new()),
            ("mach-o", vec![0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]),
        ] {
            let path = file(dir.path(), name, &bytes, 0o644);
            assert!(grant_verified_executable(&path, Platform::LinuxX86_64, "program").is_err());
            assert!(!executable_intent(&path).unwrap(), "{name}");
        }
    }

    #[test]
    fn mach_o_slices_must_match_the_platform_and_links_are_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let arm = file(
            dir.path(),
            "arm",
            &[0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1],
            0o644,
        );
        let x86 = file(
            dir.path(),
            "x86",
            &[0xcf, 0xfa, 0xed, 0xfe, 0x07, 0, 0, 1],
            0o644,
        );
        assert!(is_platform_binary(&arm, Platform::MacosAarch64).unwrap());
        assert!(!is_platform_binary(&arm, Platform::MacosX86_64).unwrap());
        assert!(is_platform_binary(&x86, Platform::MacosX86_64).unwrap());
        let mut universal = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2];
        universal.extend([
            0x01, 0, 0, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        universal.extend([
            0x01, 0, 0, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        let fat = file(dir.path(), "fat", &universal, 0o644);
        assert!(is_platform_binary(&fat, Platform::MacosAarch64).unwrap());
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&good_target(dir.path()), &link).unwrap();
        assert!(grant_verified_executable(&link, Platform::LinuxX86_64, "program").is_err());
    }

    fn good_target(dir: &Path) -> std::path::PathBuf {
        file(dir, "target", &elf(62), 0o644)
    }

    #[test]
    fn a_publisher_executable_bit_is_left_alone_and_windows_grants_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let script = file(dir.path(), "tool", b"not a binary", 0o750);
        grant_verified_executable(&script, Platform::LinuxX86_64, "program").unwrap();
        assert_eq!(
            std::fs::metadata(&script).unwrap().permissions().mode() & 0o777,
            0o750
        );
        let plain = file(dir.path(), "plain", &elf(62), 0o644);
        grant_verified_executable(&plain, Platform::WindowsX86_64, "program").unwrap();
        assert!(!executable_intent(&plain).unwrap());
    }
}
