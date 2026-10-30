//! Read-only refusal for runtimes whose legacy Windows path APIs can be lossy.
use std::path::Path;

use crate::{
    AdapterKind, Platform, PortDefinition, PortcoveError, Result, WindowsRuntimePathPolicy,
};

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    if port.windows_runtime_path_policy == Some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath)
        && port.adapter == AdapterKind::NativePortable
    {
        return if port.platforms.contains(&Platform::WindowsX86_64)
            && port.setup_executable_hints.is_empty()
            && port.source_profile.is_none()
            && port.release.user_prepared.is_empty()
            && port.release.managed_build.is_empty()
        {
            Ok(())
        } else {
            Err(PortcoveError::usage(
                "printable ASCII Windows native archives require Windows support without source preparation or setup helpers",
            ))
        };
    }
    if port.windows_runtime_path_policy == Some(WindowsRuntimePathPolicy::RelativeFileMaxPath) {
        return if port.adapter == AdapterKind::NativePortable
            && port.platforms == [Platform::WindowsX86_64]
            && port.setup_executable_hints.is_empty()
            && port.release.user_prepared.is_empty()
            && port.release.managed_build.is_empty()
        {
            Ok(())
        } else {
            Err(PortcoveError::usage(
                "relative Windows file access requires a Windows-only native archive without preparation helpers",
            ))
        };
    }
    // The fixed CV recipe retains N64 source/persistence on its other declared
    // platforms. Only its Windows source build consumes this existing guard;
    // the recipe validator separately fixes its complete route and byte facts.
    let cvlod_source = port.id == "cvlod-recomp"
        && port.adapter == AdapterKind::N64RecompPortable
        && port.platforms
            == [
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosAarch64,
            ]
        && port.release.managed_build
            == std::collections::BTreeMap::from([(
                Platform::WindowsX86_64,
                crate::CartridgeBuildRecipe::CvlodSourceV1,
            )])
        && port.setup_executable_hints.is_empty();
    if port.windows_runtime_path_policy.is_some()
        && !cvlod_source
        && (port.platforms != [Platform::WindowsX86_64]
            || port.adapter != AdapterKind::StagedSourcePortable
            || !port.setup_executable_hints.is_empty()
            || !port.release.managed_build.is_empty())
    {
        return Err(PortcoveError::usage(
            "Windows runtime path policy requires a Windows-only staged-source route without a setup executable or managed build, or the fixed CVLoD source recipe",
        ));
    }
    if port.windows_runtime_path_policy.is_some()
        && port.release.user_prepared.values().any(|runtime| {
            runtime.source_argument_extension.is_none() || runtime.shared_preferences.is_some()
        })
    {
        return Err(PortcoveError::usage(
            "prepared Windows runtime paths require a fixed positional original-file argument without shared preferences",
        ));
    }
    Ok(())
}

pub(crate) fn minimum_capability(port: &PortDefinition) -> u32 {
    if port.adapter == AdapterKind::NativePortable {
        if port.windows_runtime_path_policy == Some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath)
        {
            7
        } else {
            4
        }
    } else if port.release.user_prepared.is_empty() {
        11
    } else {
        17
    }
}

/// Prepared runtimes receive these paths directly, including any extended prefix.
pub(crate) fn check_prepared_path(
    port: &PortDefinition,
    platform: Platform,
    path: &Path,
) -> Result<()> {
    check(port, platform, path)?;
    if platform == Platform::WindowsX86_64
        && port.windows_runtime_path_policy == Some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath)
        && path.to_str().is_none_or(|text| text.len() >= 260)
    {
        return Err(path_error());
    }
    Ok(())
}

/// Check the actual coordinates used by a non-owning prepared launch. The first
/// argument is the Core-selected original, never an unchecked caller argument.
pub(crate) fn check_prepared_launch(
    port: &PortDefinition,
    platform: Platform,
    executable: &Path,
    working_directory: &Path,
    arguments: &[String],
) -> Result<()> {
    if port.windows_runtime_path_policy.is_none() {
        return Ok(());
    }
    check_executable(port, platform, executable)?;
    check_prepared_path(port, platform, executable)?;
    check_working_directory(port, platform, working_directory)?;
    if port.windows_runtime_path_policy == Some(WindowsRuntimePathPolicy::RelativeFileMaxPath) {
        return Ok(());
    }
    if platform == Platform::WindowsX86_64 {
        check_prepared_path(
            port,
            platform,
            &working_directory.join(".snesrecomp_write_probe"),
        )?;
    }
    let source = arguments.first().ok_or_else(path_error)?;
    check_prepared_path(port, platform, Path::new(source))
}

pub(crate) fn check_working_directory(
    port: &PortDefinition,
    platform: Platform,
    directory: &Path,
) -> Result<()> {
    check(port, platform, directory)?;
    if let Some(temporary) = &port.windows_temp_directory {
        check(port, platform, &directory.join(temporary))?;
    }
    if platform == Platform::WindowsX86_64
        && port.windows_runtime_path_policy == Some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath)
    {
        require_narrow_windows_path(directory, "\\.snesrecomp_write_probe")
            .map_err(|_| path_error())?;
    }
    Ok(())
}

pub(crate) fn check(port: &PortDefinition, platform: Platform, path: &Path) -> Result<()> {
    if platform != Platform::WindowsX86_64 || port.windows_runtime_path_policy.is_none() {
        return Ok(());
    }
    match port.windows_runtime_path_policy.unwrap() {
        WindowsRuntimePathPolicy::PrintableAsciiMaxPath => {
            require_narrow_windows_path(path, "").map_err(|_| path_error())
        }
        WindowsRuntimePathPolicy::RelativeFileMaxPath => require_relative_windows_path(path),
    }
}

/// Reject an already impossible destination before resolving or acquiring a release.
/// Actual selected executable/work-directory paths are checked again for readiness
/// and launch, including package nesting which is unknown before acquisition.
pub(crate) fn check_output_root(
    port: &PortDefinition,
    platform: Platform,
    root: &Path,
) -> Result<()> {
    check(port, platform, &root.join("0".repeat(64)))
}

pub(crate) fn check_executable(
    port: &PortDefinition,
    platform: Platform,
    executable: &Path,
) -> Result<()> {
    check(port, platform, executable)?;
    if platform == Platform::WindowsX86_64
        && port.windows_runtime_path_policy == Some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath)
    {
        let parent = executable.parent().ok_or_else(path_error)?;
        require_narrow_windows_path(parent, "\\.snesrecomp_write_probe")
            .map_err(|_| path_error())?;
    }
    Ok(())
}

/// Check the final coordinates of every authenticated package member, rather
/// than assuming that a short executable also implies short data filenames.
pub(crate) fn check_package_paths<'a>(
    port: &PortDefinition,
    platform: Platform,
    root: &Path,
    members: impl IntoIterator<Item = &'a str>,
) -> Result<()> {
    let checks_members = port.windows_runtime_path_policy
        == Some(WindowsRuntimePathPolicy::RelativeFileMaxPath)
        || (port.adapter == AdapterKind::NativePortable
            && port.windows_runtime_path_policy
                == Some(WindowsRuntimePathPolicy::PrintableAsciiMaxPath));
    if platform == Platform::WindowsX86_64 && checks_members {
        for member in members {
            check(port, platform, &root.join(member))?;
        }
    }
    Ok(())
}

fn require_relative_windows_path(path: &Path) -> Result<()> {
    let text = path.to_str().ok_or_else(relative_path_error)?;
    let ordinary = if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        text.strip_prefix("\\\\?\\").unwrap_or(text).to_owned()
    };
    // The supported envelope includes the runtime's relative `.\` spelling;
    // 260 includes the terminating NUL. Count Windows UTF-16 units, not UTF-8.
    if ordinary.is_empty() || ordinary.encode_utf16().count().saturating_add(2) >= 260 {
        return Err(relative_path_error());
    }
    Ok(())
}

fn relative_path_error() -> PortcoveError {
    PortcoveError::unsupported(
        "This game needs a shorter Windows installation folder for its packaged files. Choose a shorter output folder in setup options, then review the installation again.",
    )
    .detail("runtime_path_requirement", "relative-file-max-path")
    .with_known_cause(crate::failure::KnownFailureCause::RuntimePathRequirement)
}

fn path_error() -> PortcoveError {
    PortcoveError::unsupported(
        "This game port needs a shorter installation folder using basic Latin characters. Choose a folder such as C:\\Games\\Portcove in its setup options, then review the installation again.",
    ).detail("runtime_path_requirement", "printable-ascii-max-path")
    .with_known_cause(crate::failure::KnownFailureCause::RuntimePathRequirement)
}

/// Shared with the separately scoped legacy shared-preferences path check.
pub(crate) fn require_narrow_windows_path(path: &Path, suffix: &str) -> Result<()> {
    let text = path.to_str().ok_or_else(|| {
        PortcoveError::unsupported("this runtime requires a printable ASCII Windows path")
    })?;
    let valid = {
        let ordinary = if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{unc}")
        } else {
            text.strip_prefix("\\\\?\\").unwrap_or(text).to_owned()
        };
        !ordinary.is_empty()
            && ordinary.bytes().all(|byte| (32..127).contains(&byte))
            && ordinary.len().saturating_add(suffix.len()) < 260
    };
    if !valid {
        return Err(PortcoveError::unsupported(
            "this exact runtime requires printable ASCII Windows paths shorter than MAX_PATH",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "runtime_path_policy_tests.rs"]
mod tests;
