//! Bounded executable-header classification for package player candidates.
//!
//! Shape version 2 records the machine a reviewed player was built for. The
//! existing header checks answer narrower questions: `permissions` asks
//! whether a 64-byte prefix runs on one platform, and `windows_runtime` reads
//! the imports of x64 Windows programs only. This reader names the machine of
//! any PE, ELF or Mach-O (including universal) image and whether it is an
//! executable or a library. Every read is at most [`MAXIMUM_READ`] bytes and a
//! classification performs at most `2 + MAXIMUM_FAT_SLICES` reads, so a
//! hostile or truncated header can neither panic nor read without bound.
use std::io::{self, Read, Seek, SeekFrom};

/// Largest single read, in bytes.
pub(crate) const MAXIMUM_READ: usize = 4096;
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
    /// number as `0x%04x` (PE, ELF) or `0x%08x` (Mach-O).
    pub machine: String,
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
        _ => Ok(thin_mach_o(&header).map(|(kind, cpu)| ExecutableImage {
            kind,
            machine: format!("macho-{}", mach_o_arch(cpu)),
        })),
    }
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
    // Signature (4) and COFF file header (20).
    let coff = read_at(reader, u64::from(offset), 24)?;
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
    Ok(Some(ExecutableImage {
        kind,
        machine: format!("pe-{arch}"),
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
    let kind = match kind {
        EXECUTABLE => ImageKind::Executable,
        // A position-independent executable names its program interpreter;
        // a shared library does not. A table outside the bounds stays unknown.
        SHARED => {
            let entry = usize::from(phentsize);
            let count = usize::from(phnum);
            if entry < minimum_entry
                || count > MAXIMUM_ELF_PROGRAM_HEADERS
                || entry * count > MAXIMUM_READ
            {
                ImageKind::Other
            } else {
                let table = read_at(reader, phoff, entry * count)?;
                if table.len() < entry * count {
                    ImageKind::Other
                } else if (0..count)
                    .any(|index| u32_at(&table, index * entry, endian) == Some(INTERPRETER))
                {
                    ImageKind::Executable
                } else {
                    ImageKind::Library
                }
            }
        }
        _ => ImageKind::Other,
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
    }))
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
        let Some((kind, slice_cpu)) = thin_mach_o(&read_at(reader, offset, 32)?) else {
            return Ok(None);
        };
        if slice_cpu != cpu {
            return Ok(None);
        }
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
    Ok(Some(ExecutableImage {
        kind,
        machine: format!("macho-universal-{}", arches.join("+")),
    }))
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Tiny synthetic headers. They are never executed.

    pub(crate) fn pe(machine: u16, characteristics: u16) -> Vec<u8> {
        let mut bytes = vec![0_u8; 0x80 + 24];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&0x80_u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x84..0x86].copy_from_slice(&machine.to_le_bytes());
        bytes[0x96..0x98].copy_from_slice(&characteristics.to_le_bytes());
        bytes
    }

    /// A little-endian ELF64 image; `interpreter` adds a PT_INTERP header.
    pub(crate) fn elf64(kind: u16, machine: u16, interpreter: bool) -> Vec<u8> {
        let mut bytes = vec![0_u8; 64 + 2 * 56];
        bytes[..4].copy_from_slice(b"\x7fELF");
        bytes[4] = 2;
        bytes[5] = 1;
        bytes[6] = 1;
        bytes[16..18].copy_from_slice(&kind.to_le_bytes());
        bytes[18..20].copy_from_slice(&machine.to_le_bytes());
        bytes[32..40].copy_from_slice(&64_u64.to_le_bytes());
        bytes[54..56].copy_from_slice(&56_u16.to_le_bytes());
        bytes[56..58].copy_from_slice(&2_u16.to_le_bytes());
        // PT_LOAD, then PT_INTERP or PT_DYNAMIC.
        bytes[64..68].copy_from_slice(&1_u32.to_le_bytes());
        let second: u32 = if interpreter { 3 } else { 2 };
        bytes[120..124].copy_from_slice(&second.to_le_bytes());
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

    pub(crate) fn mach_o(cpu: u32, file_type: u32) -> Vec<u8> {
        let mut bytes = vec![0_u8; 32];
        bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        bytes[4..8].copy_from_slice(&cpu.to_le_bytes());
        bytes[12..16].copy_from_slice(&file_type.to_le_bytes());
        bytes
    }

    /// A 32-bit universal binary whose slices are thin Mach-O headers.
    pub(crate) fn universal(slices: &[(u32, u32)]) -> Vec<u8> {
        let mut bytes = vec![0_u8; 4096];
        bytes[..4].copy_from_slice(&[0xca, 0xfe, 0xba, 0xbe]);
        bytes[4..8].copy_from_slice(&(slices.len() as u32).to_be_bytes());
        for (index, (cpu, file_type)) in slices.iter().enumerate() {
            let start = 8 + index * 20;
            let offset = 4096 + index * 4096;
            bytes[start..start + 4].copy_from_slice(&cpu.to_be_bytes());
            bytes[start + 8..start + 12].copy_from_slice(&(offset as u32).to_be_bytes());
            bytes[start + 12..start + 16].copy_from_slice(&32_u32.to_be_bytes());
            bytes.resize(offset + 4096, 0);
            bytes[offset..offset + 32].copy_from_slice(&mach_o(*cpu, *file_type));
        }
        bytes
    }
}
