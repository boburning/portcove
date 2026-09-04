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
