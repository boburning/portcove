//! Reviewed package-layout fingerprints for managed routes.
//!
//! A release can keep matching its asset selector while its package changes
//! shape, for example by adding a runtime-replacing launcher. The catalog may
//! record a bounded fingerprint of the reviewed layout per platform. A candidate
//! whose extracted layout matches proceeds as an ordinary compatible release; a
//! different layout is held for review before anything is activated.
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use crate::{Platform, PortDefinition, PortcoveError, Result, ReviewedPackageLayout};

/// Upper bound on entries inspected; extraction already bounds the staged tree.
const MAXIMUM_ENTRIES: usize = 200_000;
const MAXIMUM_REVIEWED_PATHS: usize = 4_096;
const REPORTED_NAMES: usize = 3;
pub(crate) const NATIVE_CAPABILITY: u32 = 18;
pub(crate) const EXECUTABLE_GRANT_CAPABILITY: u32 = 29;
pub(crate) const UNIX_PROGRAMS_CAPABILITY: u32 = 30;

pub(crate) fn layout_capability(port: &PortDefinition) -> u32 {
    if port
        .reviewed_package_layouts
        .values()
        .any(|layout| layout.ignore_verified_unix_libraries)
    {
        UNIX_PROGRAMS_CAPABILITY
    } else {
        NATIVE_CAPABILITY
    }
}

pub(crate) fn native_executable_grant_capability(port: &PortDefinition) -> u32 {
    if port
        .platforms
        .iter()
        .any(|&platform| grant_precedes_layout_check(port, platform))
    {
        EXECUTABLE_GRANT_CAPABILITY
    } else {
        22
    }
}

pub(crate) fn grant_precedes_layout_check(port: &PortDefinition, platform: Platform) -> bool {
    port.adapter == crate::AdapterKind::NativePortable
        && port.release.grant_declared_executable
        && crate::permissions::platform_requires_executable(platform)
        && port.reviewed_package_layouts.contains_key(&platform)
}

/// Inspect verified local archive bytes with the managed native layout rules.
/// Unix inspection uses the extraction profile for a declared player executable.
/// This establishes layout, not release authority.
pub fn inspect_package_archive(
    source: &Path,
    platform: Platform,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<ReviewedPackageLayout> {
    inspect_package_archive_with_program_filter(
        source,
        platform,
        expected_size,
        expected_sha256,
        false,
    )
}

/// Inspect a verified archive with the optional Unix program-only layout policy.
pub fn inspect_package_archive_with_program_filter(
    source: &Path,
    platform: Platform,
    expected_size: u64,
    expected_sha256: &str,
    ignore_verified_unix_libraries: bool,
) -> Result<ReviewedPackageLayout> {
    if ignore_verified_unix_libraries && platform == Platform::WindowsX86_64 {
        return Err(PortcoveError::usage(
            "the Unix program filter requires a Unix platform",
        ));
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| PortcoveError::usage("package archive needs a UTF-8 filename"))?;
    let lower = name.to_ascii_lowercase();
    let tar_xz = lower.ends_with(".tar.xz") && platform == Platform::LinuxX86_64;
    if !tar_xz
        && ![".zip", ".tar.gz", ".tgz"]
            .iter()
            .any(|ext| lower.ends_with(ext))
    {
        return Err(PortcoveError::usage("choose a supported managed archive"));
    }
    if !cfg!(unix) && platform != Platform::WindowsX86_64 {
        return Err(PortcoveError::usage(
            "inspect Unix packages on a host that preserves executable modes",
        ));
    }
    if expected_size == 0
        || expected_sha256.len() != 64
        || !expected_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(PortcoveError::usage(
            "provide the expected archive size and SHA-256",
        ));
    }
    crate::archive::validate_download_progress(0, expected_size)?;
    let workspace = tempfile::tempdir()?;
    let root = workspace.path().canonicalize()?;
    let captured = root.join("artifact");
    let input = crate::external_runtime::open_single_link_file(source)?;
    crate::archive::validate_download_size(input.metadata()?.len(), expected_size)?;
    let mut output = fs::File::create(&captured)?;
    let copied = io::copy(&mut input.take(expected_size + 1), &mut output)?;
    drop(output);
    crate::archive::validate_download_size(copied, expected_size)?;
    if !crate::service::sha256_file(&captured)?.eq_ignore_ascii_case(expected_sha256) {
        return Err(PortcoveError::verification(
            "package archive SHA-256 differs",
        ));
    }
    let payload = root.join("payload");
    fs::create_dir(&payload)?;
    if tar_xz {
        crate::archive::extract_tar_xz_with_checkpoint(
            &captured,
            &payload,
            expected_size,
            true,
            &|| Ok(()),
        )?;
    } else {
        crate::install::extract_asset(
            &captured,
            &payload,
            name,
            expected_size,
            platform != Platform::WindowsX86_64,
            &|| Ok(()),
        )?;
    }
    let layout = observe_root(
        look_through_wrapper(&payload)?,
        platform,
        ignore_verified_unix_libraries,
    )?;
    if !valid_layout(&layout) {
        return Err(PortcoveError::verification(
            "package layout cannot be represented by a bounded reviewed declaration",
        ));
    }
    Ok(layout)
}

fn valid_layout(layout: &ReviewedPackageLayout) -> bool {
    let canonical = |paths: &[String]| {
        paths.windows(2).all(|pair| pair[0] < pair[1])
            && paths.iter().all(|path| {
                !path.bytes().any(|byte| byte.is_ascii_uppercase())
                    && crate::archive::validate_relative_path(path, false).is_ok()
            })
    };
    layout.directories.len() + layout.executables.len() <= MAXIMUM_REVIEWED_PATHS
        && !layout.executables.is_empty()
        && !layout.directories.iter().any(|name| name.contains('/'))
        && canonical(&layout.directories)
        && canonical(&layout.executables)
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    for (platform, layout) in &port.reviewed_package_layouts {
        if !port.platforms.contains(platform)
            || (layout.ignore_verified_unix_libraries
                && (port.adapter != crate::AdapterKind::NativePortable
                    || *platform == Platform::WindowsX86_64))
            || !valid_layout(layout)
        {
            return Err(PortcoveError::verification(format!(
                "{} has an invalid reviewed package layout for {platform:?}",
                port.id
            )));
        }
    }
    Ok(())
}

pub(crate) fn require_reviewed_layout(
    port: &PortDefinition,
    platform: Platform,
    payload_root: &Path,
) -> Result<()> {
    let Some(reviewed) = port.reviewed_package_layouts.get(&platform) else {
        return Ok(());
    };
    let root = if crate::runtime::native_mac_bundle_tar_xz(port, platform) {
        payload_root.to_path_buf()
    } else {
        look_through_wrapper(payload_root)?
    };
    let observed = observe_root(root, platform, reviewed.ignore_verified_unix_libraries)?;
    match compare(reviewed, &observed) {
        None => Ok(()),
        Some(drift) => Err(PortcoveError::unsupported(drift.player_reason())),
    }
}

#[cfg(test)]
fn observe(root: &Path, platform: Platform) -> Result<ReviewedPackageLayout> {
    observe_root(look_through_wrapper(root)?, platform, false)
}

pub(crate) fn native_mac_bundle_root(
    root: &Path,
    port: &PortDefinition,
    platform: Platform,
) -> Result<PathBuf> {
    let bundle = port
        .reviewed_package_layouts
        .get(&platform)
        .and_then(|layout| layout.directories.first())
        .ok_or_else(|| PortcoveError::verification("native Mac bundle has no reviewed layout"))?;
    if fs::read_dir(root)?
        .any(|entry| entry.is_ok_and(|entry| lowercase_name(&entry.file_name()) == *bundle))
    {
        Ok(root.to_path_buf())
    } else {
        look_through_wrapper(root)
    }
}

fn observe_root(
    root: PathBuf,
    platform: Platform,
    ignore_verified_unix_libraries: bool,
) -> Result<ReviewedPackageLayout> {
    let mut directories = BTreeSet::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            directories.insert(lowercase_name(&entry.file_name()));
        }
    }
    let mut executables = BTreeSet::new();
    let mut pending: Vec<(PathBuf, String)> = vec![(root, String::new())];
    let mut inspected = 0_usize;
    while let Some((directory, prefix)) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            inspected += 1;
            if inspected > MAXIMUM_ENTRIES {
                return Err(PortcoveError::verification(
                    "package has too many entries to fingerprint",
                ));
            }
            let file_type = entry.file_type()?;
            let relative = format!("{prefix}{}", lowercase_name(&entry.file_name()));
            if file_type.is_dir() {
                pending.push((entry.path(), format!("{relative}/")));
            } else if file_type.is_file()
                && is_executable(&entry, platform, ignore_verified_unix_libraries)?
            {
                // Location matters: a launcher moved into a subfolder or a second
                // program with the same name is a different layout.
                executables.insert(relative);
            }
        }
    }
    Ok(ReviewedPackageLayout {
        ignore_verified_unix_libraries,
        directories: directories.into_iter().collect(),
        executables: executables.into_iter().collect(),
    })
}

/// One wrapper directory with nothing beside it is the package root's container,
/// whatever its (often versioned) name.
fn look_through_wrapper(root: &Path) -> Result<PathBuf> {
    let mut entries = fs::read_dir(root)?;
    let (Some(first), None) = (entries.next(), entries.next()) else {
        return Ok(root.to_path_buf());
    };
    let first = first?;
    Ok(if first.file_type()?.is_dir() {
        first.path()
    } else {
        root.to_path_buf()
    })
}

fn lowercase_name(name: &std::ffi::OsStr) -> String {
    name.to_string_lossy().to_ascii_lowercase()
}

fn is_executable(
    entry: &fs::DirEntry,
    platform: Platform,
    ignore_verified_unix_libraries: bool,
) -> Result<bool> {
    let name = lowercase_name(&entry.file_name());
    let extension = Path::new(&name)
        .extension()
        .and_then(|extension| extension.to_str());
    if matches!(
        extension,
        Some("exe" | "appimage" | "bat" | "cmd" | "ps1" | "sh" | "msi" | "jar" | "vbs" | "lnk")
    ) {
        return Ok(true);
    }
    if platform == Platform::WindowsX86_64 || !crate::permissions::executable_intent(&entry.path())?
    {
        return Ok(false);
    }
    if !ignore_verified_unix_libraries {
        return Ok(true);
    }
    let linux_library_name = name.rsplit_once(".so").is_some_and(|(base, suffix)| {
        !base.is_empty()
            && (suffix.is_empty()
                || suffix.strip_prefix('.').is_some_and(|version| {
                    version
                        .split('.')
                        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                }))
    });
    let verified_library = match platform {
        Platform::LinuxX86_64 if linux_library_name => {
            let mut file = crate::external_runtime::open_single_link_file(&entry.path())?;
            is_elf_library(&mut file)?
        }
        Platform::MacosX86_64 | Platform::MacosAarch64 if extension == Some("dylib") => {
            let mut file = crate::external_runtime::open_single_link_file(&entry.path())?;
            is_macho_library(&mut file)?
        }
        _ => false,
    };
    Ok(!verified_library)
}

fn read_header_at<const N: usize>(file: &mut fs::File, offset: u64) -> io::Result<Option<[u8; N]>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = [0; N];
    match file.read_exact(&mut bytes) {
        Ok(()) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error),
    }
}

fn is_elf_library(file: &mut fs::File) -> io::Result<bool> {
    let Some(header) = read_header_at::<64>(file, 0)? else {
        return Ok(false);
    };
    if !header.starts_with(b"\x7fELF\x02\x01\x01") || header[16..20] != [3, 0, 62, 0] {
        return Ok(false);
    }
    let word = |bytes: &[u8]| u64::from_le_bytes(bytes.try_into().unwrap());
    let count = u16::from_le_bytes([header[56], header[57]]);
    let start = word(&header[32..40]);
    let length = file.metadata()?.len();
    if !(1..=64).contains(&count)
        || header[54..56] != [56, 0]
        || start < 64
        || start
            .checked_add(u64::from(count) * 56)
            .is_none_or(|end| end > length)
    {
        return Ok(false);
    }
    let mut dynamic = None;
    let mut loads = Vec::new();
    for index in 0..u64::from(count) {
        let Some(program) = read_header_at::<56>(file, start + index * 56)? else {
            return Ok(false);
        };
        match u32::from_le_bytes(program[..4].try_into().unwrap()) {
            1 => loads.push((
                word(&program[16..24]),
                word(&program[8..16]),
                word(&program[32..40]),
            )),
            3 => return Ok(false), // PT_INTERP identifies a program even if renamed.
            2 if dynamic.is_none() => {
                dynamic = Some((word(&program[8..16]), word(&program[32..40])))
            }
            2 => return Ok(false),
            _ => {}
        }
    }
    let Some((offset, size)) = dynamic else {
        return Ok(false);
    };
    if !(16..=16 * 256).contains(&size)
        || size % 16 != 0
        || offset.checked_add(size).is_none_or(|end| end > length)
    {
        return Ok(false);
    }
    let mut soname = None;
    let mut strings = None;
    let mut strings_size = None;
    let mut terminated = false;
    for index in 0..size / 16 {
        let Some(entry) = read_header_at::<16>(file, offset + index * 16)? else {
            return Ok(false);
        };
        match word(&entry[..8]) {
            0 => {
                terminated = true;
                break;
            }
            5 => strings = Some(word(&entry[8..])),
            10 => strings_size = Some(word(&entry[8..])),
            14 => soname = Some(word(&entry[8..])),
            0x6fff_fffb if word(&entry[8..]) & 0x0800_0000 != 0 => return Ok(false), // DF_1_PIE
            _ => {}
        }
    }
    let (true, Some(strings), Some(strings_size), Some(soname)) =
        (terminated, strings, strings_size, soname)
    else {
        return Ok(false);
    };
    if soname == 0 || soname >= strings_size {
        return Ok(false);
    }
    for (address, offset, size) in loads {
        let Some(relative) = strings.checked_sub(address) else {
            continue;
        };
        if relative
            .checked_add(strings_size)
            .is_none_or(|end| end > size)
            || offset.checked_add(size).is_none_or(|end| end > length)
        {
            continue;
        }
        let count = (strings_size - soname).min(256) as usize;
        let mut name = [0; 256];
        file.seek(SeekFrom::Start(offset + relative + soname))?;
        file.read_exact(&mut name[..count])?;
        return Ok(name[..count]
            .iter()
            .position(|&byte| byte == 0)
            .is_some_and(|end| end > 0));
    }
    Ok(false)
}

fn is_macho_library(file: &mut fs::File) -> io::Result<bool> {
    let Some(header) = read_header_at::<32>(file, 0)? else {
        return Ok(false);
    };
    let dylib = |header: &[u8]| {
        header.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
            && matches!(&header[4..8], [7 | 12, 0, 0, 1])
            && header[12..16] == [6, 0, 0, 0]
    };
    if dylib(&header) {
        return macho_dylib_id(file, 0, file.metadata()?.len(), &header);
    }
    if header[..4] != [0xca, 0xfe, 0xba, 0xbe] {
        return Ok(false);
    }
    let count = u64::from(u32::from_be_bytes(header[4..8].try_into().unwrap()));
    if !(1..=8).contains(&count) {
        return Ok(false);
    }
    let length = file.metadata()?.len();
    let mut ranges = Vec::new();
    let mut architectures = BTreeSet::new();
    for index in 0..count {
        let Some(entry) = read_header_at::<20>(file, 8 + index * 20)? else {
            return Ok(false);
        };
        let offset = u64::from(u32::from_be_bytes(entry[8..12].try_into().unwrap()));
        let size = u64::from(u32::from_be_bytes(entry[12..16].try_into().unwrap()));
        if offset < 8 + count * 20
            || size < 32
            || offset + size > length
            || !architectures.insert(entry[..4].to_vec())
            || ranges
                .iter()
                .any(|&(start, end)| offset < end && start < offset + size)
        {
            return Ok(false);
        }
        let Some(slice) = read_header_at::<32>(file, offset)? else {
            return Ok(false);
        };
        ranges.push((offset, offset + size));
        if !dylib(&slice)
            || slice[4..8].iter().rev().ne(entry[..4].iter())
            || !macho_dylib_id(file, offset, size, &slice)?
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn macho_dylib_id(
    file: &mut fs::File,
    base: u64,
    size: u64,
    header: &[u8; 32],
) -> io::Result<bool> {
    let word = |bytes: &[u8]| u64::from(u32::from_le_bytes(bytes.try_into().unwrap()));
    let count = word(&header[16..20]);
    let end = 32 + word(&header[20..24]);
    if !(1..=256).contains(&count) || end > size {
        return Ok(false);
    }
    let mut position = 32;
    let mut has_id = false;
    for _ in 0..count {
        if position + 8 > end {
            return Ok(false);
        }
        let Some(command) = read_header_at::<8>(file, base + position)? else {
            return Ok(false);
        };
        let length = word(&command[4..]);
        if length < 8 || length % 8 != 0 || position + length > end {
            return Ok(false);
        }
        if word(&command[..4]) == 0xd {
            if has_id || length < 24 {
                return Ok(false);
            }
            let Some(offset) = read_header_at::<4>(file, base + position + 8)? else {
                return Ok(false);
            };
            let offset = word(&offset);
            if !(24..length).contains(&offset) {
                return Ok(false);
            }
            let count = (length - offset).min(1024) as usize;
            let mut name = [0; 1024];
            file.seek(SeekFrom::Start(base + position + offset))?;
            file.read_exact(&mut name[..count])?;
            if !name[..count]
                .iter()
                .position(|&byte| byte == 0)
                .is_some_and(|end| end > 0)
            {
                return Ok(false);
            }
            has_id = true;
        }
        position += length;
    }
    Ok(has_id && position == end)
}

#[derive(Debug, PartialEq, Eq)]
struct LayoutDrift {
    added_directories: Vec<String>,
    removed_directories: Vec<String>,
    added_executables: Vec<String>,
    removed_executables: Vec<String>,
}

fn difference(left: &[String], right: &[String]) -> Vec<String> {
    let right: BTreeSet<_> = right.iter().collect();
    left.iter()
        .filter(|name| !right.contains(name))
        .cloned()
        .collect()
}

fn compare(
    reviewed: &ReviewedPackageLayout,
    observed: &ReviewedPackageLayout,
) -> Option<LayoutDrift> {
    let drift = LayoutDrift {
        added_directories: difference(&observed.directories, &reviewed.directories),
        removed_directories: difference(&reviewed.directories, &observed.directories),
        added_executables: difference(&observed.executables, &reviewed.executables),
        removed_executables: difference(&reviewed.executables, &observed.executables),
    };
    let unchanged = drift.added_directories.is_empty()
        && drift.removed_directories.is_empty()
        && drift.added_executables.is_empty()
        && drift.removed_executables.is_empty();
    (!unchanged).then_some(drift)
}

impl LayoutDrift {
    fn player_reason(&self) -> String {
        let mut changes = Vec::new();
        for (label, names) in [
            ("new programs", &self.added_executables),
            ("missing programs", &self.removed_executables),
            ("new folders", &self.added_directories),
            ("missing folders", &self.removed_directories),
        ] {
            if !names.is_empty() {
                changes.push(format!("{label}: {}", summarize(names)));
            }
        }
        format!(
            "Portcove did not install this version because its files changed in a way Portcove has not reviewed yet ({}). Nothing on your computer was changed. Check again after Portcove's next update.",
            changes.join("; ")
        )
    }
}

fn summarize(names: &[String]) -> String {
    let mut shown = names
        .iter()
        .take(REPORTED_NAMES)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > REPORTED_NAMES {
        shown.push_str(&format!(" and {} more", names.len() - REPORTED_NAMES));
    }
    shown
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, relative: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }

    fn package(wrapper: Option<&str>, files: &[&str]) -> tempfile::TempDir {
        let temporary = tempfile::tempdir().unwrap();
        let root = match wrapper {
            Some(name) => temporary.path().join(name),
            None => temporary.path().to_path_buf(),
        };
        for file in files {
            write(&root, file);
        }
        temporary
    }

    const REVIEWED_FILES: &[&str] = &[
        "Game.exe",
        "data/level.dat",
        "data/readme.txt",
        "lib/helper.dll",
        "README.md",
    ];

    fn reviewed() -> ReviewedPackageLayout {
        let package = package(Some("game-1.0"), REVIEWED_FILES);
        observe(package.path(), Platform::WindowsX86_64).unwrap()
    }

    #[test]
    fn elf_library_requires_soname_without_program_flags() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("libgame.so.1");
        let mut bytes = [0_u8; 320];
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        bytes[16..20].copy_from_slice(&[3, 0, 62, 0]);
        bytes[32] = 64;
        bytes[54] = 56;
        bytes[56] = 3;
        bytes[64] = 2;
        bytes[72] = 240;
        bytes[96] = 64;
        bytes[120] = 1;
        bytes[152..160].copy_from_slice(&320_u64.to_le_bytes());
        bytes[240] = 14;
        bytes[248] = 1;
        bytes[256..264].copy_from_slice(&5_u64.to_le_bytes());
        bytes[264..272].copy_from_slice(&304_u64.to_le_bytes());
        bytes[272..280].copy_from_slice(&10_u64.to_le_bytes());
        bytes[280] = 16;
        bytes[305..317].copy_from_slice(b"libgame.so.1");
        let check = |bytes: &[u8]| {
            fs::write(&path, bytes).unwrap();
            is_elf_library(&mut fs::File::open(&path).unwrap()).unwrap()
        };
        assert!(check(&bytes));
        bytes[176] = 3; // PT_INTERP
        assert!(!check(&bytes));
        bytes[176] = 0;
        bytes[248] = 0; // Empty SONAME.
        assert!(!check(&bytes));
        bytes[248] = 1;
        assert!(!check(&bytes[..300]));
    }

    #[cfg(unix)]
    #[test]
    fn verified_unix_libraries_may_change_names_but_programs_still_drift() {
        let package = tempfile::tempdir().unwrap();
        let root = package.path().to_path_buf();
        let platform = Platform::MacosAarch64;
        let mut header = [0_u8; 72];
        header[..8].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]);
        header[16] = 1;
        header[20] = 40;
        header[32] = 0xd;
        header[36] = 40;
        header[40] = 24;
        header[56..69].copy_from_slice(b"libGame.dylib");
        let write_program = |name, file_type| {
            let mut bytes = header;
            bytes[12] = file_type;
            let path = root.join(name);
            fs::write(&path, bytes).unwrap();
            crate::permissions::normalize_archive_entry(&path, false, true).unwrap();
        };
        write_program("Game", 2);
        write_program("libGame.1.1.dylib", 6);
        let reviewed = observe_root(root.clone(), platform, true).unwrap();
        assert_eq!(reviewed.executables, ["game"]);
        fs::rename(
            root.join("libGame.1.1.dylib"),
            root.join("libGame.1.2.dylib"),
        )
        .unwrap();
        assert_eq!(
            observe_root(root.clone(), platform, true).unwrap(),
            reviewed
        );
        assert_eq!(
            observe_root(root.clone(), platform, false)
                .unwrap()
                .executables,
            ["game", "libgame.1.2.dylib"]
        );
        write_program("Updater.dylib", 2);
        let drift = compare(&reviewed, &observe_root(root, platform, true).unwrap()).unwrap();
        assert_eq!(drift.added_executables, ["updater.dylib"]);
    }

    #[test]
    fn archive_layout_inspection_verifies_bytes_before_staging() {
        use std::io::Write as _;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("game.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for name in REVIEWED_FILES {
            writer
                .start_file(
                    format!("game-1.0/{name}"),
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            writer.write_all(b"x").unwrap();
        }
        writer.finish().unwrap();
        let size = fs::metadata(&path).unwrap().len();
        let digest = crate::service::sha256_file(&path).unwrap();
        let platform = Platform::WindowsX86_64;
        assert_eq!(
            inspect_package_archive(&path, platform, size, &digest).unwrap(),
            reviewed()
        );
        assert!(inspect_package_archive(&path, platform, size + 1, &digest).is_err());
        assert!(inspect_package_archive(&path, platform, size, &"0".repeat(64)).is_err());
    }

    #[test]
    fn observation_records_directories_and_executables_through_a_wrapper() {
        assert_eq!(
            reviewed(),
            ReviewedPackageLayout {
                ignore_verified_unix_libraries: false,
                directories: vec!["data".to_owned(), "lib".to_owned()],
                executables: vec!["game.exe".to_owned()],
            }
        );
    }

    #[test]
    fn a_compatible_successor_with_a_renamed_wrapper_and_new_data_proceeds() {
        let mut files = REVIEWED_FILES.to_vec();
        files.extend(["data/new-level.dat", "lib/other.dll", "CHANGELOG.md"]);
        let successor = package(Some("game-1.1"), &files);
        let observed = observe(successor.path(), Platform::WindowsX86_64).unwrap();
        assert_eq!(compare(&reviewed(), &observed), None);
    }

    #[test]
    fn a_new_launcher_or_folder_is_drift_with_a_player_reason() {
        let mut files = REVIEWED_FILES.to_vec();
        files.extend(["Launcher.exe", "runtime/engine.bin"]);
        let drifted = package(Some("game-1.1"), &files);
        let observed = observe(drifted.path(), Platform::WindowsX86_64).unwrap();
        let drift = compare(&reviewed(), &observed).unwrap();
        assert_eq!(drift.added_executables, ["launcher.exe"]);
        assert_eq!(drift.added_directories, ["runtime"]);
        let reason = drift.player_reason();
        assert!(reason.contains("new programs: launcher.exe"), "{reason}");
        assert!(reason.contains("new folders: runtime"), "{reason}");
        assert!(
            reason.contains("Nothing on your computer was changed"),
            "{reason}"
        );
    }

    #[test]
    fn a_renamed_executable_is_drift_in_both_directions() {
        let files = ["Game2.exe", "data/level.dat", "lib/helper.dll"];
        let renamed = package(Some("game-1.1"), &files);
        let observed = observe(renamed.path(), Platform::WindowsX86_64).unwrap();
        let drift = compare(&reviewed(), &observed).unwrap();
        assert_eq!(drift.added_executables, ["game2.exe"]);
        assert_eq!(drift.removed_executables, ["game.exe"]);
    }

    #[test]
    fn a_moved_or_duplicated_program_is_drift_even_with_an_unchanged_name() {
        let reviewed = reviewed();
        let duplicated = package(
            Some("game-1.1"),
            &[
                "Game.exe",
                "tools/Game.exe",
                "data/level.dat",
                "lib/helper.dll",
            ],
        );
        let observed = observe(duplicated.path(), Platform::WindowsX86_64).unwrap();
        let drift = compare(&reviewed, &observed).unwrap();
        assert_eq!(drift.added_executables, ["tools/game.exe"]);
        let moved = package(
            Some("game-1.1"),
            &["bin/Game.exe", "data/level.dat", "lib/helper.dll"],
        );
        let observed = observe(moved.path(), Platform::WindowsX86_64).unwrap();
        let drift = compare(&reviewed, &observed).unwrap();
        assert_eq!(drift.added_executables, ["bin/game.exe"]);
        assert_eq!(drift.removed_executables, ["game.exe"]);
    }

    #[test]
    fn installers_scripts_and_shortcuts_count_but_libraries_do_not() {
        let mut files = REVIEWED_FILES.to_vec();
        files.extend(["lib/other.dll", "lib/other.so"]);
        let libraries = package(Some("game-1.1"), &files);
        let observed = observe(libraries.path(), Platform::WindowsX86_64).unwrap();
        assert_eq!(compare(&reviewed(), &observed), None);
        for extra in ["Setup.msi", "tool.jar", "run.vbs", "Game.lnk"] {
            let mut files = REVIEWED_FILES.to_vec();
            files.push(extra);
            let drifted = package(Some("game-1.1"), &files);
            let observed = observe(drifted.path(), Platform::WindowsX86_64).unwrap();
            assert!(compare(&reviewed(), &observed).is_some(), "{extra}");
        }
    }

    #[test]
    fn an_unreviewed_platform_has_no_layout_requirement() {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .ports()
            .first()
            .unwrap()
            .clone();
        port.reviewed_package_layouts.clear();
        let anything = package(None, &["whatever.exe"]);
        assert!(require_reviewed_layout(&port, Platform::WindowsX86_64, anything.path()).is_ok());
    }

    #[test]
    fn drift_is_refused_as_a_hold_and_a_match_is_accepted() {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .ports()
            .first()
            .unwrap()
            .clone();
        port.reviewed_package_layouts
            .insert(Platform::WindowsX86_64, reviewed());
        let same = package(Some("game-2.0"), REVIEWED_FILES);
        assert!(require_reviewed_layout(&port, Platform::WindowsX86_64, same.path()).is_ok());
        let drifted = package(
            Some("game-2.0"),
            &[
                "Game.exe",
                "Updater.exe",
                "data/level.dat",
                "lib/helper.dll",
            ],
        );
        let refusal =
            require_reviewed_layout(&port, Platform::WindowsX86_64, drifted.path()).unwrap_err();
        assert_eq!(refusal.code, crate::ErrorCode::Unsupported);
        assert!(
            refusal.message.contains("updater.exe"),
            "{}",
            refusal.message
        );
    }
}
