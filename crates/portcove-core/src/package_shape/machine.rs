//! Bounded executable-header classification for package player candidates.
//!
//! Shape version 2 records the machine a reviewed player was built for. The
//! existing header checks answer narrower questions: `permissions` asks
//! whether a 64-byte prefix runs on one platform, and `windows_runtime` reads
//! the imports of x64 Windows programs only. This reader names the machine of
//! any PE, ELF or Mach-O (including universal) image and whether it is an
//! executable or a library. It also names the system the image is built for
//! ([`ExecutableImage::system`]): the PE subsystem, the ELF OSABI and program
//! interpreter, and the Mach-O platform load commands. Every header read is at
//! most [`MAXIMUM_READ`] bytes, a Mach-O load command table at most
//! [`MAXIMUM_LOAD_COMMANDS`] bytes, and a classification performs at most
//! `3 + 2 * MAXIMUM_FAT_SLICES` reads, so a hostile or truncated header can
//! neither panic nor read without bound.
use std::io::{self, Read, Seek, SeekFrom};

/// Largest single read, in bytes.
pub(crate) const MAXIMUM_READ: usize = 4096;
/// Largest Mach-O load command table read, in bytes. A platform command past
/// it leaves the platform unknown.
pub(crate) const MAXIMUM_LOAD_COMMANDS: usize = 64 * 1024;
/// Largest ELF program interpreter path read, in bytes.
const MAXIMUM_INTERPRETER: usize = 256;
/// Universal binaries with more slices than this are not classified.
const MAXIMUM_FAT_SLICES: u32 = 8;
/// ELF program header tables larger than this are not inspected.
const MAXIMUM_ELF_PROGRAM_HEADERS: usize = 64;

/// What a native image is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageKind {
    /// A program the operating system can start.
    Executable,
    /// A shared library, DLL, dylib or loadable bundle.
    Library,
    /// An object file, core dump, driver or an image whose kind is not established.
    Other,
}

/// A classified native image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutableImage {
    pub kind: ImageKind,
    /// `pe-<arch>`, `elf32-<arch>`, `elf64-<arch>` (`elf32be-`/`elf64be-` for
    /// big-endian), `macho-<arch>` or `macho-universal-<arch>+<arch>…`. The
    /// arch is `x86`, `x86-64`, `arm64` or `arm`, otherwise the raw machine
    /// number as `0x%04x` (PE, ELF) or `0x%08x` (Mach-O). This name keeps its
    /// historical meaning (reviewed package shapes record it): it says nothing
    /// about the system.
    pub machine: String,
    /// The system the image is built for, when it is not its format's desktop
    /// host (Windows for PE, Linux for ELF, macOS for Mach-O): one of
    /// [`PE_SYSTEMS`], [`ELF_SYSTEMS`] or [`MACH_O_SYSTEMS`]. `unknown` means
    /// the header names no system this reader recognizes, or names several.
    pub system: Option<&'static str>,
}

/// Non-Windows PE systems: an Xbox or EFI subsystem, or any other subsystem.
pub(crate) const PE_SYSTEMS: &[&str] = &["xbox", "efi", "unknown"];
/// Non-Linux ELF systems, from the OSABI byte and the program interpreter.
/// `unknown` includes a static image without a GNU/Linux OSABI.
pub(crate) const ELF_SYSTEMS: &[&str] = &[
    "android", "freebsd", "openbsd", "netbsd", "haiku", "solaris", "unknown",
];
/// Non-macOS Mach-O systems, from `LC_BUILD_VERSION` and `LC_VERSION_MIN_*`.
/// Simulators count as their device system; `other` is bridgeOS or DriverKit;
/// `unplatformed` is an image with no platform load command at all, which only
/// its package structure can place.
pub(crate) const MACH_O_SYSTEMS: &[&str] = &[
    "ios",
    "tvos",
    "watchos",
    "visionos",
    "other",
    "unplatformed",
    "unknown",
];

impl ExecutableImage {
    /// The machine name qualified by the system: [`Self::machine`] for an
    /// image of its format's desktop host, otherwise the system inserted after
    /// the format prefix (`elf64-android-arm64`, `macho-ios-arm64`,
    /// `macho-ios-universal-arm64+x86-64`, `pe-unknown-x86-64`).
    pub(crate) fn platform_machine(&self) -> String {
        qualified(&self.machine, self.system)
    }
}

/// `machine` with `system` inserted after its format prefix.
fn qualified(machine: &str, system: Option<&str>) -> String {
    match (system, machine.split_once('-')) {
        (Some(system), Some((format, rest))) => format!("{format}-{system}-{rest}"),
        _ => machine.to_owned(),
    }
}

/// Classify the image a reader holds. `None` means it is not a PE, ELF or
/// Mach-O image this reader understands, for example a script, a text file or
/// a truncated or inconsistent header.
pub(crate) fn classify<R: Read + Seek>(reader: &mut R) -> io::Result<Option<ExecutableImage>> {
    let header = read_at(reader, 0, MAXIMUM_READ)?;
    match header.get(..4) {
        Some([b'M', b'Z', _, _]) => pe(reader, &header),
        Some([0x7f, b'E', b'L', b'F']) => elf(reader, &header),
        Some([0xca, 0xfe, 0xba, 0xbe]) => fat(reader, &header, false),
        Some([0xca, 0xfe, 0xba, 0xbf]) => fat(reader, &header, true),
        _ => {
            let Some((kind, cpu)) = thin_mach_o(&header) else {
                return Ok(None);
            };
            let system = mach_o_system(reader, 0, &header)?;
            Ok(Some(ExecutableImage {
                kind,
                machine: format!("macho-{}", mach_o_arch(cpu)),
                system,
            }))
        }
    }
}

/// Whether `machine` is a name [`classify`] can produce: `pe-<arch>`,
/// `elf32-`/`elf64-`/`elf32be-`/`elf64be-<arch>`, `macho-<arch>` or
/// `macho-universal-<arch>+…` with sorted, distinct slices, each optionally
/// qualified by its format's system ([`ExecutableImage::platform_machine`]).
pub(crate) fn is_machine_name(machine: &str) -> bool {
    let Some((format, rest)) = machine.split_once('-') else {
        return false;
    };
    let systems = match format {
        "pe" => PE_SYSTEMS,
        "elf32" | "elf64" | "elf32be" | "elf64be" => ELF_SYSTEMS,
        "macho" => MACH_O_SYSTEMS,
        _ => return false,
    };
    let unqualified = systems
        .iter()
        .find_map(|system| {
            rest.strip_prefix(system)
                .and_then(|after| after.strip_prefix('-'))
        })
        .map_or_else(|| machine.to_owned(), |after| format!("{format}-{after}"));
    is_unqualified_machine_name(&unqualified)
}

fn is_unqualified_machine_name(machine: &str) -> bool {
    let named = |arch: &str, raw_digits: usize| {
        matches!(arch, "x86" | "x86-64" | "arm64" | "arm")
            || arch.strip_prefix("0x").is_some_and(|digits| {
                digits.len() == raw_digits
                    && digits
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
    };
    if let Some(slices) = machine.strip_prefix("macho-universal-") {
        let arches = slices.split('+').collect::<Vec<_>>();
        return arches.len() <= MAXIMUM_FAT_SLICES as usize
            && arches.iter().all(|arch| named(arch, 8))
            && arches.windows(2).all(|pair| pair[0] < pair[1]);
    }
    if let Some(arch) = machine.strip_prefix("macho-") {
        return named(arch, 8);
    }
    ["pe-", "elf32-", "elf64-", "elf32be-", "elf64be-"]
        .iter()
        .find_map(|prefix| machine.strip_prefix(prefix))
        .is_some_and(|arch| named(arch, 4))
}

fn read_at<R: Read + Seek>(reader: &mut R, offset: u64, length: usize) -> io::Result<Vec<u8>> {
    let length = length.min(MAXIMUM_READ);
    // No file is this large; a header naming such an offset reads nothing
    // instead of failing the seek.
    if offset > i64::MAX as u64 / 2 {
        return Ok(Vec::new());
    }
    reader.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::with_capacity(length);
    reader
        .by_ref()
        .take(length as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[derive(Clone, Copy)]
enum Endian {
    Little,
    Big,
}

fn field<const N: usize>(bytes: &[u8], offset: usize) -> Option<[u8; N]> {
    bytes.get(offset..offset.checked_add(N)?)?.try_into().ok()
}

fn u16_at(bytes: &[u8], offset: usize, endian: Endian) -> Option<u16> {
    let value = field::<2>(bytes, offset)?;
    Some(match endian {
        Endian::Little => u16::from_le_bytes(value),
        Endian::Big => u16::from_be_bytes(value),
    })
}

fn u32_at(bytes: &[u8], offset: usize, endian: Endian) -> Option<u32> {
    let value = field::<4>(bytes, offset)?;
    Some(match endian {
        Endian::Little => u32::from_le_bytes(value),
        Endian::Big => u32::from_be_bytes(value),
    })
}

fn u64_at(bytes: &[u8], offset: usize, endian: Endian) -> Option<u64> {
    let value = field::<8>(bytes, offset)?;
    Some(match endian {
        Endian::Little => u64::from_le_bytes(value),
        Endian::Big => u64::from_be_bytes(value),
    })
}

fn pe<R: Read + Seek>(reader: &mut R, header: &[u8]) -> io::Result<Option<ExecutableImage>> {
    let Some(offset) = u32_at(header, 0x3c, Endian::Little) else {
        return Ok(None);
    };
    // Signature (4), COFF file header (20) and the optional header through
    // its Subsystem field (70).
    let coff = read_at(reader, u64::from(offset), 24 + 70)?;
    if coff.get(..4) != Some(b"PE\0\0".as_slice()) {
        return Ok(None);
    }
    let (Some(machine), Some(characteristics)) = (
        u16_at(&coff, 4, Endian::Little),
        u16_at(&coff, 22, Endian::Little),
    ) else {
        return Ok(None);
    };
    const EXECUTABLE_IMAGE: u16 = 0x0002;
    const DLL: u16 = 0x2000;
    let kind = if characteristics & DLL != 0 {
        ImageKind::Library
    } else if characteristics & EXECUTABLE_IMAGE != 0 {
        ImageKind::Executable
    } else {
        ImageKind::Other
    };
    let arch = match machine {
        0x014c => "x86".to_owned(),
        0x8664 => "x86-64".to_owned(),
        0xaa64 => "arm64".to_owned(),
        0x01c0 | 0x01c4 => "arm".to_owned(),
        other => format!("0x{other:04x}"),
    };
    // The Subsystem field sits at the same optional header offset in PE32 and
    // PE32+. Only the Windows GUI and console subsystems are a desktop program.
    let optional_size = u16_at(&coff, 20, Endian::Little).unwrap_or(0);
    let magic = u16_at(&coff, 24, Endian::Little);
    let subsystem = (optional_size >= 70 && matches!(magic, Some(0x010b | 0x020b)))
        .then(|| u16_at(&coff, 24 + 68, Endian::Little))
        .flatten();
    let system = match subsystem {
        Some(2 | 3) => None,
        Some(14) => Some("xbox"),
        Some(10..=13) => Some("efi"),
        _ => Some("unknown"),
    };
    Ok(Some(ExecutableImage {
        kind,
        machine: format!("pe-{arch}"),
        system,
    }))
}

fn elf<R: Read + Seek>(reader: &mut R, header: &[u8]) -> io::Result<Option<ExecutableImage>> {
    let (Some(&class), Some(&data)) = (header.get(4), header.get(5)) else {
        return Ok(None);
    };
    let endian = match data {
        1 => Endian::Little,
        2 => Endian::Big,
        _ => return Ok(None),
    };
    // (e_phoff, e_phentsize, e_phnum, smallest program header) by class.
    let (wide, phoff, phentsize, phnum, minimum_entry) = match class {
        1 => (
            false,
            u32_at(header, 28, endian).map(u64::from),
            u16_at(header, 42, endian),
            u16_at(header, 44, endian),
            32,
        ),
        2 => (
            true,
            u64_at(header, 32, endian),
            u16_at(header, 54, endian),
            u16_at(header, 56, endian),
            56,
        ),
        _ => return Ok(None),
    };
    let (Some(kind), Some(machine), Some(phoff), Some(phentsize), Some(phnum)) = (
        u16_at(header, 16, endian),
        u16_at(header, 18, endian),
        phoff,
        phentsize,
        phnum,
    ) else {
        return Ok(None);
    };
    const EXECUTABLE: u16 = 2;
    const SHARED: u16 = 3;
    const INTERPRETER: u32 = 3;
    // The program header table, when it is within the bounds. A table outside
    // them leaves a shared object's kind and every image's system unknown.
    let entry = usize::from(phentsize);
    let count = usize::from(phnum);
    let table = if entry < minimum_entry
        || count > MAXIMUM_ELF_PROGRAM_HEADERS
        || entry * count > MAXIMUM_READ
    {
        None
    } else {
        let table = read_at(reader, phoff, entry * count)?;
        (table.len() == entry * count).then_some(table)
    };
    // (p_offset, p_filesz) of the first PT_INTERP header.
    let interpreter = table.as_ref().and_then(|table| {
        (0..count)
            .map(|index| index * entry)
            .find(|start| u32_at(table, *start, endian) == Some(INTERPRETER))
            .map(|start| {
                if wide {
                    (
                        u64_at(table, start + 8, endian),
                        u64_at(table, start + 32, endian),
                    )
                } else {
                    (
                        u32_at(table, start + 4, endian).map(u64::from),
                        u32_at(table, start + 16, endian).map(u64::from),
                    )
                }
            })
    });
    let kind = match kind {
        EXECUTABLE => ImageKind::Executable,
        // A position-independent executable names its program interpreter;
        // a shared library does not.
        SHARED => match (&table, interpreter) {
            (None, _) => ImageKind::Other,
            (Some(_), Some(_)) => ImageKind::Executable,
            (Some(_), None) => ImageKind::Library,
        },
        _ => ImageKind::Other,
    };
    let interpreter_path = match interpreter {
        Some((Some(offset), Some(size))) if size > 0 => {
            let size = usize::try_from(size).unwrap_or(usize::MAX);
            let bytes = read_at(reader, offset, size.min(MAXIMUM_INTERPRETER))?;
            let bytes = bytes.split(|byte| *byte == 0).next().unwrap_or_default();
            Some(String::from_utf8_lossy(bytes).into_owned())
        }
        Some(_) => Some(String::new()),
        None => None,
    };
    let system = if table.is_none() {
        Some("unknown")
    } else {
        elf_system(header.get(7).copied(), interpreter_path.as_deref())
    };
    let arch = match machine {
        3 => "x86".to_owned(),
        62 => "x86-64".to_owned(),
        183 => "arm64".to_owned(),
        40 => "arm".to_owned(),
        other => format!("0x{other:04x}"),
    };
    let bits = if wide { 64 } else { 32 };
    let order = match endian {
        Endian::Little => "",
        Endian::Big => "be",
    };
    Ok(Some(ExecutableImage {
        kind,
        machine: format!("elf{bits}{order}-{arch}"),
        system,
    }))
}

/// The system an ELF image is for, from its OSABI byte and program
/// interpreter path (`None` when it has no PT_INTERP header). Linux needs a
/// Linux (glibc or musl) interpreter with a System V or GNU OSABI, or a static
/// image branded GNU/Linux. Evidence that disagrees is `unknown`.
fn elf_system(osabi: Option<u8>, interpreter: Option<&str>) -> Option<&'static str> {
    const LINUX: &str = "linux";
    let branded = match osabi {
        Some(0) => None,
        Some(3) => Some(LINUX),
        Some(2) => Some("netbsd"),
        Some(6) => Some("solaris"),
        Some(9) => Some("freebsd"),
        Some(12) => Some("openbsd"),
        _ => Some("unknown"),
    };
    let loaded = interpreter.map(|path| {
        let (directory, name) = path.rsplit_once('/').unwrap_or(("", path));
        if directory.starts_with("/lib")
            && (name.starts_with("ld-linux") || name.starts_with("ld-musl-"))
        {
            LINUX
        } else if matches!(path, "/system/bin/linker" | "/system/bin/linker64") {
            "android"
        } else if path == "/libexec/ld-elf.so.1" {
            "freebsd"
        } else if path == "/usr/libexec/ld.so" {
            "openbsd"
        } else if path == "/usr/libexec/ld.elf_so" {
            "netbsd"
        } else if path == "/system/runtime_loader" {
            "haiku"
        } else {
            "unknown"
        }
    });
    let system = match (branded, loaded) {
        // A System V OSABI names no system; a static one stays unknown.
        (None, None) => "unknown",
        (None, Some(loaded)) => loaded,
        (Some(branded), None) => branded,
        (Some(branded), Some(loaded)) if branded == loaded => branded,
        // A GNU OSABI with another system's loader disagrees.
        _ => "unknown",
    };
    (system != LINUX).then_some(system)
}

/// The kind and CPU type of a single-architecture Mach-O header.
fn thin_mach_o(header: &[u8]) -> Option<(ImageKind, u32)> {
    let endian = match header.get(..4)? {
        [0xce | 0xcf, 0xfa, 0xed, 0xfe] => Endian::Little,
        [0xfe, 0xed, 0xfa, 0xce | 0xcf] => Endian::Big,
        _ => return None,
    };
    let cpu = u32_at(header, 4, endian)?;
    const EXECUTE: u32 = 2;
    const DYLIB: u32 = 6;
    const BUNDLE: u32 = 8;
    let kind = match u32_at(header, 12, endian)? {
        EXECUTE => ImageKind::Executable,
        DYLIB | BUNDLE => ImageKind::Library,
        _ => ImageKind::Other,
    };
    Some((kind, cpu))
}

/// The non-macOS system a Mach-O image at `offset` is built for, from its
/// platform load commands; `header` holds at least the image's first bytes.
fn mach_o_system<R: Read + Seek>(
    reader: &mut R,
    offset: u64,
    header: &[u8],
) -> io::Result<Option<&'static str>> {
    let (endian, header_size) = match header.get(..4) {
        Some([0xce, 0xfa, 0xed, 0xfe]) => (Endian::Little, 28),
        Some([0xcf, 0xfa, 0xed, 0xfe]) => (Endian::Little, 32),
        Some([0xfe, 0xed, 0xfa, 0xce]) => (Endian::Big, 28),
        Some([0xfe, 0xed, 0xfa, 0xcf]) => (Endian::Big, 32),
        _ => return Ok(Some("unknown")),
    };
    let (Some(count), Some(size)) = (u32_at(header, 16, endian), u32_at(header, 20, endian)) else {
        return Ok(Some("unknown"));
    };
    let size = usize::try_from(size).unwrap_or(usize::MAX);
    let wanted = size.min(MAXIMUM_LOAD_COMMANDS);
    let commands = read_bounded(reader, offset + header_size, wanted)?;
    let complete = size <= MAXIMUM_LOAD_COMMANDS && commands.len() == size;
    const LC_VERSION_MIN_MACOSX: u32 = 0x24;
    const LC_VERSION_MIN_IPHONEOS: u32 = 0x25;
    const LC_VERSION_MIN_TVOS: u32 = 0x2f;
    const LC_VERSION_MIN_WATCHOS: u32 = 0x30;
    const LC_BUILD_VERSION: u32 = 0x32;
    let mut systems = Vec::new();
    let mut start = 0_usize;
    let mut scanned_all = true;
    for _ in 0..count {
        let (Some(command), Some(length)) = (
            u32_at(&commands, start, endian),
            u32_at(&commands, start + 4, endian),
        ) else {
            scanned_all = false;
            break;
        };
        let length = usize::try_from(length).unwrap_or(usize::MAX);
        if length < 8 {
            scanned_all = false;
            break;
        }
        let system = match command {
            LC_VERSION_MIN_MACOSX => Some("macos"),
            LC_VERSION_MIN_IPHONEOS => Some("ios"),
            LC_VERSION_MIN_TVOS => Some("tvos"),
            LC_VERSION_MIN_WATCHOS => Some("watchos"),
            LC_BUILD_VERSION => Some(match u32_at(&commands, start + 8, endian) {
                // macOS and Mac Catalyst.
                Some(1 | 6) => "macos",
                Some(2 | 7) => "ios",
                Some(3 | 8) => "tvos",
                Some(4 | 9) => "watchos",
                Some(11 | 12) => "visionos",
                // bridgeOS and DriverKit.
                Some(5 | 10) => "other",
                _ => "unknown",
            }),
            _ => None,
        };
        systems.extend(system);
        let Some(next) = start.checked_add(length) else {
            scanned_all = false;
            break;
        };
        start = next;
    }
    systems.sort_unstable();
    systems.dedup();
    Ok(match systems.as_slice() {
        ["macos"] => None,
        [system] => Some(*system),
        [] if complete && scanned_all => Some("unplatformed"),
        _ => Some("unknown"),
    })
}

/// Up to `length` bytes at `offset`, at most [`MAXIMUM_LOAD_COMMANDS`].
fn read_bounded<R: Read + Seek>(reader: &mut R, offset: u64, length: usize) -> io::Result<Vec<u8>> {
    let length = length.min(MAXIMUM_LOAD_COMMANDS);
    if offset > i64::MAX as u64 / 2 {
        return Ok(Vec::new());
    }
    reader.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::with_capacity(length);
    reader
        .by_ref()
        .take(length as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn mach_o_arch(cpu: u32) -> String {
    match cpu {
        0x0000_0007 => "x86".to_owned(),
        0x0100_0007 => "x86-64".to_owned(),
        0x0100_000c => "arm64".to_owned(),
        0x0000_000c => "arm".to_owned(),
        other => format!("0x{other:08x}"),
    }
}

fn fat<R: Read + Seek>(
    reader: &mut R,
    header: &[u8],
    wide: bool,
) -> io::Result<Option<ExecutableImage>> {
    // Java class files share the 32-bit magic; their next word is a class
    // file version far above any plausible slice count.
    let Some(count) = u32_at(header, 4, Endian::Big) else {
        return Ok(None);
    };
    if !(1..=MAXIMUM_FAT_SLICES).contains(&count) {
        return Ok(None);
    }
    let entry = if wide { 32 } else { 20 };
    let mut kinds = Vec::new();
    let mut arches = Vec::new();
    let mut systems = Vec::new();
    for index in 0..count as usize {
        let start = 8 + index * entry;
        let cpu = u32_at(header, start, Endian::Big);
        let offset = if wide {
            u64_at(header, start + 8, Endian::Big)
        } else {
            u32_at(header, start + 8, Endian::Big).map(u64::from)
        };
        let (Some(cpu), Some(offset)) = (cpu, offset) else {
            return Ok(None);
        };
        // The slice must hold a Mach-O header for the CPU the table names.
        let slice = read_at(reader, offset, 32)?;
        let Some((kind, slice_cpu)) = thin_mach_o(&slice) else {
            return Ok(None);
        };
        if slice_cpu != cpu {
            return Ok(None);
        }
        systems.push(mach_o_system(reader, offset, &slice)?);
        kinds.push(kind);
        arches.push(mach_o_arch(cpu));
    }
    arches.sort();
    arches.dedup();
    let kind = if kinds.iter().all(|kind| *kind == kinds[0]) {
        kinds[0]
    } else {
        ImageKind::Other
    };
    // Every slice must agree; a macOS slice beside an unplatformed one leaves
    // the image to its package structure.
    systems.sort_unstable();
    systems.dedup();
    let system = match systems.as_slice() {
        [system] => *system,
        [None, Some("unplatformed")] => Some("unplatformed"),
        _ => Some("unknown"),
    };
    Ok(Some(ExecutableImage {
        kind,
        machine: format!("macho-universal-{}", arches.join("+")),
        system,
    }))
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Tiny synthetic headers. They are never executed.

    /// A PE image for the Windows console subsystem.
    pub(crate) fn pe(machine: u16, characteristics: u16) -> Vec<u8> {
        pe_subsystem(machine, characteristics, 3)
    }

    /// A PE32+ image with an optional header naming `subsystem`.
    pub(crate) fn pe_subsystem(machine: u16, characteristics: u16, subsystem: u16) -> Vec<u8> {
        let mut bytes = vec![0_u8; 0x80 + 24 + 0xf0];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&0x80_u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x84..0x86].copy_from_slice(&machine.to_le_bytes());
        bytes[0x94..0x96].copy_from_slice(&0xf0_u16.to_le_bytes());
        bytes[0x96..0x98].copy_from_slice(&characteristics.to_le_bytes());
        bytes[0x98..0x9a].copy_from_slice(&0x020b_u16.to_le_bytes());
        bytes[0x98 + 68..0x98 + 70].copy_from_slice(&subsystem.to_le_bytes());
        bytes
    }

    /// The glibc x86-64 program interpreter.
    pub(crate) const LINUX_INTERPRETER: &str = "/lib64/ld-linux-x86-64.so.2";

    /// A little-endian Linux ELF64 image; `interpreter` adds a PT_INTERP
    /// header naming the glibc loader.
    pub(crate) fn elf64(kind: u16, machine: u16, interpreter: bool) -> Vec<u8> {
        elf64_for(kind, machine, 0, interpreter.then_some(LINUX_INTERPRETER))
    }

    /// A little-endian ELF64 image with this OSABI and optional interpreter.
    pub(crate) fn elf64_for(
        kind: u16,
        machine: u16,
        osabi: u8,
        interpreter: Option<&str>,
    ) -> Vec<u8> {
        let mut bytes = vec![0_u8; 64 + 2 * 56];
        bytes[..4].copy_from_slice(b"\x7fELF");
        bytes[4] = 2;
        bytes[5] = 1;
        bytes[6] = 1;
        bytes[7] = osabi;
        bytes[16..18].copy_from_slice(&kind.to_le_bytes());
        bytes[18..20].copy_from_slice(&machine.to_le_bytes());
        bytes[32..40].copy_from_slice(&64_u64.to_le_bytes());
        bytes[54..56].copy_from_slice(&56_u16.to_le_bytes());
        bytes[56..58].copy_from_slice(&2_u16.to_le_bytes());
        // PT_LOAD, then PT_INTERP or PT_DYNAMIC.
        bytes[64..68].copy_from_slice(&1_u32.to_le_bytes());
        let second: u32 = if interpreter.is_some() { 3 } else { 2 };
        bytes[120..124].copy_from_slice(&second.to_le_bytes());
        if let Some(path) = interpreter {
            let offset = bytes.len() as u64;
            let size = path.len() as u64 + 1;
            bytes[128..136].copy_from_slice(&offset.to_le_bytes());
            bytes[152..160].copy_from_slice(&size.to_le_bytes());
            bytes.extend_from_slice(path.as_bytes());
            bytes.push(0);
        }
        bytes
    }

    /// A little-endian ELF32 executable.
    pub(crate) fn elf32(machine: u16) -> Vec<u8> {
        let mut bytes = vec![0_u8; 52];
        bytes[..4].copy_from_slice(b"\x7fELF");
        bytes[4] = 1;
        bytes[5] = 1;
        bytes[16..18].copy_from_slice(&2_u16.to_le_bytes());
        bytes[18..20].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    /// A 64-bit Mach-O image with no load commands.
    pub(crate) fn mach_o(cpu: u32, file_type: u32) -> Vec<u8> {
        let mut bytes = vec![0_u8; 32];
        bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        bytes[4..8].copy_from_slice(&cpu.to_le_bytes());
        bytes[12..16].copy_from_slice(&file_type.to_le_bytes());
        bytes
    }

    /// A 64-bit Mach-O image whose load commands are an `LC_UUID`, then
    /// `command` (an `LC_BUILD_VERSION` platform number, or an
    /// `LC_VERSION_MIN_*` command when `minimum` is set).
    pub(crate) fn mach_o_for(cpu: u32, file_type: u32, platform: u32, minimum: bool) -> Vec<u8> {
        let mut bytes = mach_o(cpu, file_type);
        let mut commands = Vec::new();
        commands.extend_from_slice(&0x1b_u32.to_le_bytes());
        commands.extend_from_slice(&24_u32.to_le_bytes());
        commands.extend_from_slice(&[0_u8; 16]);
        if minimum {
            commands.extend_from_slice(&platform.to_le_bytes());
            commands.extend_from_slice(&16_u32.to_le_bytes());
            commands.extend_from_slice(&[0_u8; 8]);
        } else {
            commands.extend_from_slice(&0x32_u32.to_le_bytes());
            commands.extend_from_slice(&24_u32.to_le_bytes());
            commands.extend_from_slice(&platform.to_le_bytes());
            commands.extend_from_slice(&[0_u8; 12]);
        }
        bytes[16..20].copy_from_slice(&2_u32.to_le_bytes());
        bytes[20..24].copy_from_slice(&(commands.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&commands);
        bytes
    }

    /// A 32-bit universal binary whose slices are thin Mach-O headers.
    pub(crate) fn universal(slices: &[(u32, u32)]) -> Vec<u8> {
        universal_of(
            &slices
                .iter()
                .map(|(cpu, file_type)| mach_o(*cpu, *file_type))
                .collect::<Vec<_>>(),
        )
    }

    /// A 32-bit universal binary holding these thin Mach-O images.
    pub(crate) fn universal_of(slices: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = vec![0_u8; 4096];
        bytes[..4].copy_from_slice(&[0xca, 0xfe, 0xba, 0xbe]);
        bytes[4..8].copy_from_slice(&(slices.len() as u32).to_be_bytes());
        for (index, slice) in slices.iter().enumerate() {
            let start = 8 + index * 20;
            let offset = 4096 + index * 4096;
            bytes[start..start + 4]
                .copy_from_slice(&slice[4..8].iter().rev().copied().collect::<Vec<_>>());
            bytes[start + 8..start + 12].copy_from_slice(&(offset as u32).to_be_bytes());
            bytes[start + 12..start + 16].copy_from_slice(&(slice.len() as u32).to_be_bytes());
            bytes.resize(offset + 4096, 0);
            bytes[offset..offset + slice.len()].copy_from_slice(slice);
        }
        bytes
    }
}
