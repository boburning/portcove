//! Microsoft runtimes a Windows game program most likely needs, and whether this
//! host has them.
//!
//! Core reads the launch program's PE import table and its framework-dependent
//! `.runtimeconfig.json` without executing anything, follows imports into DLLs
//! shipped beside the program, and asks a host-facts seam about the rest. Only an
//! affirmative absence is `missing`: unreadable programs, reached limits, other
//! hosts and unsupported architectures stay `unknown`. The report is advisory and
//! never blocks launch.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Result;

#[cfg(test)]
#[path = "windows_runtime_tests.rs"]
mod tests;

/// Programs read per assessment: the launch program and DLLs shipped beside it.
const PROGRAM_LIMIT: usize = 64;
/// Entries listed in the launch program's folder.
const FOLDER_ENTRY_LIMIT: usize = 4096;
const SECTION_LIMIT: u16 = 96;
const OPTIONAL_HEADER_LIMIT: u16 = 4096;
const IMPORT_DESCRIPTOR_LIMIT: usize = 1024;
const IMPORT_NAME_LIMIT: usize = 255;
/// A PE header further into the file than this is treated as unreadable.
const PE_HEADER_OFFSET_LIMIT: u32 = 1 << 24;
const RUNTIME_CONFIG_LIMIT: u64 = 64 * 1024;
const FRAMEWORK_LIMIT: usize = 8;
const FRAMEWORK_VERSION_LIMIT: usize = 256;
/// Folders between the program's folder and the installation root that a
/// launch may use as its working directory.
const WORKING_FOLDER_LIMIT: usize = 16;

/// Microsoft's page for the supported Visual C++ Redistributable downloads,
/// including the 2010, 2012 and 2013 releases.
pub const VISUAL_CPP_DOWNLOAD_PAGE: &str =
    "https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist";
/// Microsoft's DirectX End-User Runtime Web Installer page.
pub const DIRECTX_DOWNLOAD_PAGE: &str = "https://www.microsoft.com/download/details.aspx?id=35";
const DOTNET_DOWNLOAD_PAGE: &str = "https://dotnet.microsoft.com/download/dotnet";

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum WindowsArchitecture {
    X86,
    X64,
    Arm64,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
pub enum WindowsRuntime {
    /// The shared Visual C++ Redistributable for Visual Studio 2015 and later.
    #[serde(rename = "visual_cpp_2015_or_later")]
    VisualCpp2015OrLater,
    #[serde(rename = "visual_cpp_2013")]
    VisualCpp2013,
    #[serde(rename = "visual_cpp_2012")]
    VisualCpp2012,
    #[serde(rename = "visual_cpp_2010")]
    VisualCpp2010,
    /// Legacy components installed by the DirectX End-User Runtime (June 2010).
    #[serde(rename = "directx_june_2010")]
    DirectxJune2010,
    /// A .NET shared framework named by the program's runtime configuration.
    #[serde(rename = "dotnet")]
    Dotnet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePresence {
    Present,
    /// This host affirmatively reports a required file or framework absent.
    Missing,
    /// Portcove could not tell; never presented as missing.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeInspection {
    /// The launch program and every DLL it imports from its own folder were read.
    Complete,
    /// Something could not be read or a limit was reached. Listed requirements are
    /// real; others may be absent from the list.
    Partial,
    /// The launch program is not a Windows program, so no Microsoft runtime applies.
    NotWindowsProgram,
    /// The launch program could not be read or its format was not understood.
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeHostCheck {
    /// This Windows host was asked about each requirement.
    Checked,
    /// Presence cannot be checked on this host; every requirement is unknown.
    NotWindows,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DotnetFramework {
    /// Shared framework name, e.g. `Microsoft.WindowsDesktop.App`.
    pub name: String,
    /// Version the program was built against.
    pub version: String,
    /// The program's declared roll-forward policy; absent means `Minor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roll_forward: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimePrerequisite {
    pub runtime: WindowsRuntime,
    /// Architecture of the launch program; absent for an architecture Portcove
    /// does not assess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub architecture: Option<WindowsArchitecture>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framework: Option<DotnetFramework>,
    pub presence: RuntimePresence,
    /// Lowercase runtime DLL names the game imports and does not ship.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// The part of `files` this host reports absent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_files: Vec<String>,
    /// Microsoft's official download page for this runtime.
    pub download_page: String,
}

/// Microsoft runtimes the active installation's launch program most likely
/// needs. Derived on request; nothing is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimePrerequisiteReport {
    pub inspection: RuntimeInspection,
    pub host: RuntimeHostCheck,
    pub requirements: Vec<RuntimePrerequisite>,
}

impl RuntimePrerequisiteReport {
    /// Requirements this host affirmatively reports missing.
    pub fn missing(&self) -> impl Iterator<Item = &RuntimePrerequisite> {
        self.requirements
            .iter()
            .filter(|requirement| requirement.presence == RuntimePresence::Missing)
    }
}

/// Whether `url` is one of the official Microsoft download pages a report names.
pub fn is_official_download_page(url: &str) -> bool {
    if url == VISUAL_CPP_DOWNLOAD_PAGE
        || url == DIRECTX_DOWNLOAD_PAGE
        || url == DOTNET_DOWNLOAD_PAGE
    {
        return true;
    }
    url.strip_prefix(DOTNET_DOWNLOAD_PAGE)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|channel| channel.split_once('.'))
        .is_some_and(|(major, minor)| short_number(major) && short_number(minor))
}

fn short_number(value: &str) -> bool {
    (1..=3).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// Host facts the assessment needs. The real host answers only on Windows;
/// tests substitute a fake on any platform.
pub(crate) trait RuntimeHostFacts {
    fn is_windows(&self) -> bool;
    /// Whether the system folder Windows uses for `architecture` programs holds
    /// `file`, or `None` when this host cannot tell.
    fn system_library(&self, architecture: WindowsArchitecture, file: &str) -> Option<bool>;
    /// Installed versions of a .NET shared framework for `architecture`: empty
    /// when none is installed, `None` when this host cannot tell.
    fn dotnet_framework_versions(
        &self,
        architecture: WindowsArchitecture,
        framework: &str,
    ) -> Option<Vec<String>>;
}

impl crate::Library {
    /// Microsoft runtimes the active installation's launch program most likely
    /// needs, or `None` when the port has no active installation or registration.
    /// This reads program files, so it stays out of the all-ports status read.
    pub fn runtime_prerequisites(
        &self,
        port_id: &str,
    ) -> Result<Option<RuntimePrerequisiteReport>> {
        let status = self.status(port_id, crate::ReleaseChannel::Stable)?;
        Ok(current_program(&status).map(|current| assess_program(&current)))
    }

    /// The same report for one exact installation, only while it is still the
    /// port's current managed installation or external registration.
    pub fn installation_runtime_prerequisites(
        &self,
        port_id: &str,
        install_id: &str,
    ) -> Result<Option<RuntimePrerequisiteReport>> {
        let status = self.status(port_id, crate::ReleaseChannel::Stable)?;
        Ok(current_program(&status)
            .filter(|current| current.id == install_id)
            .map(|current| assess_program(&current)))
    }
}

/// The current installation's identity, root and launch program. The program is
/// unknown for an installation recorded without one.
struct CurrentProgram<'a> {
    id: &'a str,
    root: &'a Path,
    program: Option<PathBuf>,
}

fn current_program(status: &crate::PortStatus) -> Option<CurrentProgram<'_>> {
    if let Some(install) = &status.active {
        let program = (!install.selected_executable.as_os_str().is_empty())
            .then(|| install.path.join(&install.selected_executable));
        return Some(CurrentProgram {
            id: &install.id,
            root: &install.path,
            program,
        });
    }
    status
        .external_runtime
        .as_ref()
        .map(|record| CurrentProgram {
            id: &record.id,
            root: &record.path,
            program: Some(record.executable.clone()),
        })
}

/// Assess the program Windows would start, using this host's facts.
fn assess_program(current: &CurrentProgram<'_>) -> RuntimePrerequisiteReport {
    match &current.program {
        Some(program) => assess_program_with(program, Some(current.root), &SystemRuntimeHost),
        None => RuntimePrerequisiteReport {
            inspection: RuntimeInspection::Unreadable,
            host: if SystemRuntimeHost.is_windows() {
                RuntimeHostCheck::Checked
            } else {
                RuntimeHostCheck::NotWindows
            },
            requirements: Vec::new(),
        },
    }
}

/// Assess `program`. `root` is the installation root: a launch's working
/// directory is the program's folder or one of its ancestors up to the root, and
/// Windows also loads DLLs from the working directory, so a runtime DLL in any of
/// those folders is not reported missing.
pub(crate) fn assess_program_with(
    program: &Path,
    root: Option<&Path>,
    host: &dyn RuntimeHostFacts,
) -> RuntimePrerequisiteReport {
    let host_check = if host.is_windows() {
        RuntimeHostCheck::Checked
    } else {
        RuntimeHostCheck::NotWindows
    };
    let report = |inspection| RuntimePrerequisiteReport {
        inspection,
        host: host_check,
        requirements: Vec::new(),
    };
    let image = match read_program(program) {
        Ok(ProgramImage::Windows(image)) => image,
        Ok(ProgramImage::NotWindows) => return report(RuntimeInspection::NotWindowsProgram),
        Err(_) => return report(RuntimeInspection::Unreadable),
    };
    let architecture = image.architecture;
    let mut complete = image.complete;
    let local = match program.parent().map(list_folder) {
        Some(Ok(folder)) => folder,
        _ => Folder::default(),
    };
    // Names in folders a launch may use as its working directory. Windows finds
    // their DLLs, but they are not read here.
    let mut working = HashSet::new();
    let mut working_complete = true;
    if let (Some(folder), Some(root)) = (program.parent(), root)
        && folder.starts_with(root)
    {
        for ancestor in folder.ancestors().skip(1).take(WORKING_FOLDER_LIMIT) {
            if !ancestor.starts_with(root) {
                break;
            }
            match list_folder(ancestor) {
                Ok(listed) => {
                    working_complete &= listed.complete;
                    working.extend(listed.files.into_keys().chain(listed.unread));
                }
                Err(_) => working_complete = false,
            }
            if ancestor == root {
                break;
            }
        }
    }
    // Without every folder Windows would search, a runtime DLL the game ships may
    // be unlisted, so an absent system copy cannot establish that the game lacks it.
    let folders_complete = local.complete && working_complete;
    complete &= folders_complete;

    let mut runtime_files = BTreeMap::<WindowsRuntime, BTreeSet<String>>::new();
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::from([image.imports]);
    while let Some(imports) = queue.pop_front() {
        for name in imports {
            if local.unread.contains(&name) || working.contains(&name) {
                // Shipped but not read: a symlink, junction or working-directory copy.
                complete = false;
            } else if let Some(path) = local.files.get(&name) {
                if !visited.insert(name) {
                    continue;
                }
                if visited.len() >= PROGRAM_LIMIT {
                    complete = false;
                    continue;
                }
                match read_program(path) {
                    Ok(ProgramImage::Windows(dependency)) => {
                        complete &= dependency.complete;
                        queue.push_back(dependency.imports);
                    }
                    _ => complete = false,
                }
            } else if let Some(runtime) = classify(&name) {
                runtime_files.entry(runtime).or_default().insert(name);
            }
        }
    }

    let mut requirements = runtime_files
        .into_iter()
        .map(|(runtime, files)| {
            let files = files.into_iter().collect::<Vec<_>>();
            let answers = files
                .iter()
                .map(|file| architecture.and_then(|arch| host.system_library(arch, file)))
                .collect::<Vec<_>>();
            let missing_files = files
                .iter()
                .zip(&answers)
                .filter(|(_, answer)| **answer == Some(false))
                .map(|(file, _)| file.clone())
                .collect::<Vec<_>>();
            let presence = if !missing_files.is_empty() {
                if folders_complete {
                    RuntimePresence::Missing
                } else {
                    RuntimePresence::Unknown
                }
            } else if answers.iter().all(|answer| *answer == Some(true)) {
                RuntimePresence::Present
            } else {
                RuntimePresence::Unknown
            };
            RuntimePrerequisite {
                runtime,
                architecture,
                framework: None,
                presence,
                missing_files: if presence == RuntimePresence::Missing {
                    missing_files
                } else {
                    Vec::new()
                },
                files,
                download_page: if runtime == WindowsRuntime::DirectxJune2010 {
                    DIRECTX_DOWNLOAD_PAGE
                } else {
                    VISUAL_CPP_DOWNLOAD_PAGE
                }
                .to_owned(),
            }
        })
        .collect::<Vec<_>>();

    let config_name = program
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| format!("{}.runtimeconfig.json", stem.to_ascii_lowercase()));
    if config_name
        .as_ref()
        .is_some_and(|name| local.unread.contains(name))
    {
        complete = false;
    }
    if let Some(config) = config_name.as_ref().and_then(|name| local.files.get(name)) {
        match read_frameworks(config) {
            Ok(frameworks) => {
                requirements.extend(frameworks.into_iter().map(|(framework, evaluable)| {
                    let presence = architecture
                        .filter(|_| evaluable)
                        .and_then(|arch| host.dotnet_framework_versions(arch, &framework.name))
                        .and_then(|installed| {
                            framework_satisfied(
                                &framework.version,
                                framework.roll_forward.as_deref(),
                                &installed,
                            )
                        })
                        .map_or(RuntimePresence::Unknown, |satisfied| {
                            if satisfied {
                                RuntimePresence::Present
                            } else {
                                RuntimePresence::Missing
                            }
                        });
                    RuntimePrerequisite {
                        runtime: WindowsRuntime::Dotnet,
                        architecture,
                        download_page: dotnet_download_page(&framework.version),
                        framework: Some(framework),
                        presence,
                        files: Vec::new(),
                        missing_files: Vec::new(),
                    }
                }))
            }
            Err(()) => complete = false,
        }
    }

    RuntimePrerequisiteReport {
        inspection: if complete {
            RuntimeInspection::Complete
        } else {
            RuntimeInspection::Partial
        },
        host: host_check,
        requirements,
    }
}

/// The runtime a system DLL name belongs to, for names only Microsoft's runtime
/// installers place in the system folder. Debug and in-box names are not listed.
fn classify(file: &str) -> Option<WindowsRuntime> {
    let stem = file.strip_suffix(".dll")?;
    let visual_cpp = |version: &str| {
        ["msvcp", "msvcr", "vcomp", "mfc", "mfcm"]
            .iter()
            .any(|prefix| stem.strip_prefix(prefix) == Some(version))
            || ["mfc", "mfcm"].iter().any(|prefix| {
                stem.strip_prefix(prefix)
                    .and_then(|rest| rest.strip_suffix('u'))
                    == Some(version)
            })
    };
    if matches!(
        stem,
        "msvcp140"
            | "msvcp140_1"
            | "msvcp140_2"
            | "msvcp140_atomic_wait"
            | "msvcp140_codecvt_ids"
            | "vcruntime140"
            | "vcruntime140_1"
            | "concrt140"
            | "vccorlib140"
            | "vcomp140"
            | "mfc140"
            | "mfc140u"
            | "mfcm140"
            | "mfcm140u"
    ) {
        return Some(WindowsRuntime::VisualCpp2015OrLater);
    }
    for (version, runtime) in [
        ("120", WindowsRuntime::VisualCpp2013),
        ("110", WindowsRuntime::VisualCpp2012),
        ("100", WindowsRuntime::VisualCpp2010),
    ] {
        if visual_cpp(version) {
            return Some(runtime);
        }
    }
    let numbered = |prefix: &str, range: std::ops::RangeInclusive<u8>| {
        stem.strip_prefix(prefix).is_some_and(|number| {
            (1..=2).contains(&number.len())
                && number.bytes().all(|byte| byte.is_ascii_digit())
                && number
                    .parse::<u8>()
                    .is_ok_and(|number| range.contains(&number))
        })
    };
    (stem == "d3dx10"
        || numbered("d3dx9_", 24..=43)
        || numbered("d3dx10_", 33..=43)
        || numbered("d3dx11_", 42..=43)
        || numbered("d3dcompiler_", 33..=43)
        || numbered("d3dcsx_", 42..=43)
        || numbered("xinput1_", 1..=3)
        || numbered("xaudio2_", 0..=7)
        || numbered("x3daudio1_", 0..=7)
        || numbered("xapofx1_", 0..=5))
    .then_some(WindowsRuntime::DirectxJune2010)
}

fn dotnet_download_page(version: &str) -> String {
    match parse_version(version) {
        Some((major, minor, _)) if major < 1000 && minor < 1000 => {
            format!("{DOTNET_DOWNLOAD_PAGE}/{major}.{minor}")
        }
        _ => DOTNET_DOWNLOAD_PAGE.to_owned(),
    }
}

/// One folder's listing by lowercase name.
#[derive(Default)]
struct Folder {
    /// Regular files, which may be read.
    files: HashMap<String, PathBuf>,
    /// Symlinks, junctions and other non-directory entries. Windows may load
    /// them, so they satisfy an import, but they are never followed or read.
    unread: HashSet<String>,
    complete: bool,
}

fn list_folder(folder: &Path) -> io::Result<Folder> {
    let mut files = HashMap::new();
    let mut unread = HashSet::new();
    let mut complete = true;
    for (index, entry) in fs::read_dir(folder)?.enumerate() {
        if index == FOLDER_ENTRY_LIMIT {
            complete = false;
            break;
        }
        let Ok(entry) = entry else {
            complete = false;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            complete = false;
            continue;
        };
        if kind.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_ascii_lowercase) else {
            complete = false;
            continue;
        };
        if kind.is_file() {
            files.insert(name, entry.path());
        } else {
            unread.insert(name);
        }
    }
    Ok(Folder {
        files,
        unread,
        complete,
    })
}

struct WindowsImage {
    architecture: Option<WindowsArchitecture>,
    /// Lowercase, deduplicated DLL names from the static import table.
    imports: BTreeSet<String>,
    /// False when an unusable import name was skipped.
    complete: bool,
}

enum ProgramImage {
    NotWindows,
    Windows(WindowsImage),
}

fn malformed(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason.to_owned())
}

fn open_regular(path: &Path) -> io::Result<fs::File> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(malformed("not a regular file"));
    }
    let mut options = fs::File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(malformed("not a regular file"));
    }
    Ok(file)
}

struct Reader {
    file: fs::File,
    length: u64,
}

impl Reader {
    fn read(&mut self, offset: u64, length: usize) -> io::Result<Vec<u8>> {
        if offset
            .checked_add(length as u64)
            .is_none_or(|end| end > self.length)
        {
            return Err(malformed("read outside the file"));
        }
        self.file.seek(SeekFrom::Start(offset))?;
        let mut buffer = vec![0; length];
        self.file.read_exact(&mut buffer)?;
        Ok(buffer)
    }
}

fn u16_at(bytes: &[u8], offset: usize) -> io::Result<u16> {
    bytes
        .get(offset..offset + 2)
        .map(|value| u16::from_le_bytes([value[0], value[1]]))
        .ok_or_else(|| malformed("truncated header"))
}

fn u32_at(bytes: &[u8], offset: usize) -> io::Result<u32> {
    bytes
        .get(offset..offset + 4)
        .map(|value| u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
        .ok_or_else(|| malformed("truncated header"))
}

struct Section {
    virtual_size: u32,
    address: u32,
    raw_size: u32,
    raw_offset: u32,
}

/// Read a program's architecture and static imports with fixed bounds.
fn read_program(path: &Path) -> io::Result<ProgramImage> {
    let file = open_regular(path)?;
    let length = file.metadata()?.len();
    let mut reader = Reader { file, length };
    if length < 2 || reader.read(0, 2)? != b"MZ" {
        return Ok(ProgramImage::NotWindows);
    }
    let dos = reader.read(0, 64)?;
    let header_offset = u32_at(&dos, 0x3c)?;
    if header_offset > PE_HEADER_OFFSET_LIMIT {
        return Err(malformed("PE header offset is out of range"));
    }
    let header_offset = u64::from(header_offset);
    let signature = reader.read(header_offset, 4)?;
    if signature != b"PE\0\0" {
        // An MS-DOS program has no Windows imports.
        return Ok(ProgramImage::NotWindows);
    }
    let coff = reader.read(header_offset + 4, 20)?;
    let architecture = match u16_at(&coff, 0)? {
        0x014c => Some(WindowsArchitecture::X86),
        0x8664 => Some(WindowsArchitecture::X64),
        0xaa64 => Some(WindowsArchitecture::Arm64),
        _ => None,
    };
    let section_count = u16_at(&coff, 2)?;
    let optional_size = u16_at(&coff, 16)?;
    if section_count > SECTION_LIMIT || optional_size > OPTIONAL_HEADER_LIMIT {
        return Err(malformed("PE header is out of range"));
    }
    let optional = reader.read(header_offset + 24, usize::from(optional_size))?;
    let (count_offset, directory_offset) = match u16_at(&optional, 0)? {
        0x010b => (92, 96),
        0x020b => (108, 112),
        _ => return Err(malformed("unknown optional header")),
    };
    let headers_size = u32_at(&optional, 60)?;
    let mut imports = BTreeSet::new();
    if u32_at(&optional, count_offset)? < 2 {
        return Ok(ProgramImage::Windows(WindowsImage {
            architecture,
            imports,
            complete: true,
        }));
    }
    let import_address = u32_at(&optional, directory_offset + 8)?;
    if import_address == 0 {
        return Ok(ProgramImage::Windows(WindowsImage {
            architecture,
            imports,
            complete: true,
        }));
    }
    let table = reader.read(
        header_offset + 24 + u64::from(optional_size),
        usize::from(section_count) * 40,
    )?;
    let sections = table
        .chunks_exact(40)
        .map(|section| {
            Ok(Section {
                virtual_size: u32_at(section, 8)?,
                address: u32_at(section, 12)?,
                raw_size: u32_at(section, 16)?,
                raw_offset: u32_at(section, 20)?,
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    let file_offset = |address: u32| -> io::Result<u64> {
        if address < headers_size {
            return Ok(u64::from(address));
        }
        sections
            .iter()
            .find(|section| {
                // Bytes past a nonzero virtual size are file padding, not data.
                let extent = match section.virtual_size {
                    0 => section.raw_size,
                    size => size.min(section.raw_size),
                };
                address >= section.address && address - section.address < extent
            })
            .map(|section| u64::from(section.raw_offset) + u64::from(address - section.address))
            .ok_or_else(|| malformed("address outside the file's sections"))
    };
    let mut complete = true;
    for index in 0..=IMPORT_DESCRIPTOR_LIMIT {
        if index == IMPORT_DESCRIPTOR_LIMIT {
            return Err(malformed("too many imported DLLs"));
        }
        let address = u32::try_from(index * 20)
            .ok()
            .and_then(|offset| import_address.checked_add(offset))
            .ok_or_else(|| malformed("import table is out of range"))?;
        let descriptor = reader.read(file_offset(address)?, 20)?;
        if descriptor.iter().all(|byte| *byte == 0) {
            break;
        }
        let name_offset = file_offset(u32_at(&descriptor, 12)?)?;
        let available = usize::try_from(length.saturating_sub(name_offset))
            .unwrap_or(usize::MAX)
            .min(IMPORT_NAME_LIMIT + 1);
        let bytes = reader.read(name_offset, available)?;
        // An unterminated, overlong or path-like name is skipped; the other
        // imports still count, but the inspection is no longer complete.
        match bytes
            .iter()
            .position(|byte| *byte == 0)
            .map(|end| &bytes[..end])
        {
            Some(name)
                if !name.is_empty()
                    && name.iter().all(|byte| {
                        byte.is_ascii_graphic() && !matches!(byte, b'/' | b'\\' | b':')
                    }) =>
            {
                imports.insert(String::from_utf8_lossy(name).to_ascii_lowercase());
            }
            _ => complete = false,
        }
    }
    Ok(ProgramImage::Windows(WindowsImage {
        architecture,
        imports,
        complete,
    }))
}

#[derive(Deserialize)]
struct RuntimeConfig {
    #[serde(rename = "runtimeOptions")]
    runtime_options: Option<RuntimeOptions>,
}

#[derive(Deserialize)]
struct RuntimeOptions {
    framework: Option<ConfiguredFramework>,
    #[serde(default)]
    frameworks: Vec<ConfiguredFramework>,
    #[serde(rename = "rollForward")]
    roll_forward: Option<String>,
    #[serde(rename = "rollForwardOnNoCandidateFx")]
    legacy_roll_forward: Option<serde_json::Value>,
    #[serde(rename = "applyPatches")]
    apply_patches: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ConfiguredFramework {
    name: String,
    version: String,
    #[serde(rename = "rollForward")]
    roll_forward: Option<serde_json::Value>,
    #[serde(rename = "rollForwardOnNoCandidateFx")]
    legacy_roll_forward: Option<serde_json::Value>,
    #[serde(rename = "applyPatches")]
    apply_patches: Option<serde_json::Value>,
}

/// Frameworks a framework-dependent program needs, each with whether Portcove
/// can evaluate its roll-forward. Legacy `rollForwardOnNoCandidateFx`,
/// `applyPatches` and per-framework `rollForward` settings are not evaluated, so
/// those frameworks stay unknown. A self-contained program lists
/// `includedFrameworks` instead and needs none.
fn read_frameworks(path: &Path) -> std::result::Result<Vec<(DotnetFramework, bool)>, ()> {
    let bytes = crate::path::read_bounded_regular(path, RUNTIME_CONFIG_LIMIT).map_err(|_| ())?;
    let config: RuntimeConfig = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let Some(options) = config.runtime_options else {
        return Ok(Vec::new());
    };
    let options_evaluable =
        options.legacy_roll_forward.is_none() && options.apply_patches.is_none();
    let frameworks = options
        .framework
        .into_iter()
        .chain(options.frameworks)
        .collect::<Vec<_>>();
    if frameworks.len() > FRAMEWORK_LIMIT {
        return Err(());
    }
    frameworks
        .into_iter()
        .map(|framework| {
            let name_valid = (1..=64).contains(&framework.name.len())
                && framework
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
                && !framework.name.starts_with('.')
                && !framework.name.contains("..");
            if !name_valid || framework.version.len() > 64 {
                return Err(());
            }
            let evaluable = options_evaluable
                && framework.roll_forward.is_none()
                && framework.legacy_roll_forward.is_none()
                && framework.apply_patches.is_none();
            Ok((
                DotnetFramework {
                    name: framework.name,
                    version: framework.version,
                    roll_forward: options.roll_forward.clone(),
                },
                evaluable,
            ))
        })
        .collect()
}

/// `major.minor.patch` of a release version; prerelease versions are not parsed.
fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((major, minor, patch))
}

/// Whether an installed release satisfies the requested version under the .NET
/// host's roll-forward policy, or `None` for a policy or version Portcove does
/// not evaluate.
fn framework_satisfied(
    required: &str,
    roll_forward: Option<&str>,
    installed: &[String],
) -> Option<bool> {
    let required = parse_version(required)?;
    if installed.len() > FRAMEWORK_VERSION_LIMIT {
        return None;
    }
    let accepts: fn((u32, u32, u32), (u32, u32, u32)) -> bool = match roll_forward
        .unwrap_or("Minor")
        .to_ascii_lowercase()
        .as_str()
    {
        "disable" => |required, candidate| candidate == required,
        "latestpatch" => |required, candidate| {
            candidate.0 == required.0 && candidate.1 == required.1 && candidate >= required
        },
        "minor" | "latestminor" => {
            |required, candidate| candidate.0 == required.0 && candidate >= required
        }
        "major" | "latestmajor" => |required, candidate| candidate >= required,
        _ => return None,
    };
    Some(
        installed
            .iter()
            .filter_map(|version| parse_version(version))
            .any(|candidate| accepts(required, candidate)),
    )
}

/// The running host's facts.
pub(crate) struct SystemRuntimeHost;

#[cfg(not(windows))]
impl RuntimeHostFacts for SystemRuntimeHost {
    fn is_windows(&self) -> bool {
        false
    }

    fn system_library(&self, _: WindowsArchitecture, _: &str) -> Option<bool> {
        None
    }

    fn dotnet_framework_versions(&self, _: WindowsArchitecture, _: &str) -> Option<Vec<String>> {
        None
    }
}

#[cfg(windows)]
impl RuntimeHostFacts for SystemRuntimeHost {
    fn is_windows(&self) -> bool {
        true
    }

    fn system_library(&self, architecture: WindowsArchitecture, file: &str) -> Option<bool> {
        classify(file)?;
        let folder = windows_host::system_folder(architecture)?;
        match fs::metadata(folder.join(file)) {
            Ok(metadata) => Some(metadata.is_file()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Some(false),
            Err(_) => None,
        }
    }

    fn dotnet_framework_versions(
        &self,
        architecture: WindowsArchitecture,
        framework: &str,
    ) -> Option<Vec<String>> {
        let root = windows_host::dotnet_root(architecture)?;
        let entries = match fs::read_dir(root.join("shared").join(framework)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Some(Vec::new()),
            Err(_) => return None,
        };
        let mut versions = Vec::new();
        for entry in entries {
            let entry = entry.ok()?;
            if versions.len() == FRAMEWORK_VERSION_LIMIT {
                return None;
            }
            if entry.file_type().ok()?.is_dir()
                && let Some(name) = entry.file_name().to_str()
            {
                versions.push(name.to_owned());
            }
        }
        Some(versions)
    }
}

#[cfg(windows)]
mod windows_host {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::PathBuf;

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6432KEY, RegGetValueW,
    };
    use windows_sys::Win32::System::SystemInformation::{
        GetSystemDirectoryW, GetSystemWow64DirectoryW, IMAGE_FILE_MACHINE_AMD64,
        IMAGE_FILE_MACHINE_I386,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, IsWow64Process2};

    use super::WindowsArchitecture;

    fn folder(read: unsafe extern "system" fn(*mut u16, u32) -> u32) -> Option<PathBuf> {
        let mut buffer = [0_u16; 1024];
        // SAFETY: the buffer is writable for its stated length.
        let count = unsafe { read(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        (count != 0 && count < buffer.len())
            .then(|| PathBuf::from(OsString::from_wide(&buffer[..count])))
    }

    /// The native machine. On ARM64 Windows an emulated x64 Portcove sees the
    /// native folders, whose layout this assessment does not interpret.
    fn native_machine() -> Option<u16> {
        let (mut process, mut native) = (0, 0);
        // SAFETY: the pseudo-handle is valid for this process and both outputs
        // are writable.
        (unsafe { IsWow64Process2(GetCurrentProcess(), &mut process, &mut native) } != 0)
            .then_some(native)
    }

    /// Whether this host's folder layout is the one assessed here: native x64
    /// Windows, or x86 Windows for a 32-bit build.
    fn assessed_host() -> bool {
        match native_machine() {
            Some(IMAGE_FILE_MACHINE_AMD64) => true,
            Some(IMAGE_FILE_MACHINE_I386) => cfg!(target_arch = "x86"),
            _ => false,
        }
    }

    /// The folder Windows loads system DLLs from for programs of `architecture`,
    /// for the architectures this build can answer about.
    pub(super) fn system_folder(architecture: WindowsArchitecture) -> Option<PathBuf> {
        if !assessed_host() {
            return None;
        }
        match architecture {
            #[cfg(target_arch = "x86_64")]
            WindowsArchitecture::X64 => folder(GetSystemDirectoryW),
            #[cfg(target_arch = "x86_64")]
            WindowsArchitecture::X86 => folder(GetSystemWow64DirectoryW),
            #[cfg(target_arch = "x86")]
            WindowsArchitecture::X86 => folder(GetSystemDirectoryW),
            _ => None,
        }
    }

    /// Where the .NET host looks for shared frameworks of `architecture`: the
    /// registered install location, or the default one.
    pub(super) fn dotnet_root(architecture: WindowsArchitecture) -> Option<PathBuf> {
        if !assessed_host() {
            return None;
        }
        let (key, default) = match architecture {
            #[cfg(target_arch = "x86_64")]
            WindowsArchitecture::X64 => ("x64", "ProgramW6432"),
            WindowsArchitecture::X86 => ("x86", "ProgramFiles(x86)"),
            _ => return None,
        };
        // Only an absent registration falls back to the default location; any
        // other registry failure leaves the location unknown.
        if let Some(location) = registered_location(key)? {
            return Some(location);
        }
        std::env::var_os(default).map(|programs| PathBuf::from(programs).join("dotnet"))
    }

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(Some(0))
            .collect()
    }

    /// `Some(None)` when nothing is registered, `None` when the registry could
    /// not be read.
    fn registered_location(architecture: &str) -> Option<Option<PathBuf>> {
        let key = wide(&format!(
            "SOFTWARE\\dotnet\\Setup\\InstalledVersions\\{architecture}"
        ));
        let name = wide("InstallLocation");
        let mut buffer = [0_u16; 1024];
        let mut bytes = (buffer.len() * 2) as u32;
        // SAFETY: the key and value names are null terminated and the buffer is
        // writable for the byte length passed.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ | RRF_SUBKEY_WOW6432KEY,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Some(None);
        }
        if status != ERROR_SUCCESS {
            return None;
        }
        let mut value = &buffer[..(bytes as usize / 2).min(buffer.len())];
        while let Some((&0, rest)) = value.split_last() {
            value = rest;
        }
        (!value.is_empty()).then(|| Some(PathBuf::from(OsString::from_wide(value))))
    }
}
