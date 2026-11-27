//! Bounded, read-only suggestions. Registration and launch revalidate the chosen file.
use super::*;
use std::{
    ffi::OsStr,
    io::{Read, Seek, SeekFrom},
    path::Component,
};

const ENTRY_LIMIT: usize = 2048;
const DEPTH_LIMIT: usize = 5;
const CANDIDATE_LIMIT: usize = 32;
const LAUNCH_MANIFEST_LIMIT: u64 = 64 * 1024;

#[derive(Deserialize)]
struct ReleaseLaunchManifest {
    format: u32,
    repo: Option<String>,
    games: Option<serde_json::Value>,
    start: ReleaseLaunchPrograms,
}

#[derive(Deserialize)]
struct ReleaseLaunchPrograms {
    program: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SetupLaunchTarget {
    pub executable: PathBuf,
    pub working_directory: PathBuf,
    pub supporting_program: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SetupLaunchTargets {
    pub port_id: String,
    pub pending_id: String,
    pub candidates: Vec<SetupLaunchTarget>,
    pub recommended_executable: Option<PathBuf>,
    pub complete: bool,
    pub entries_checked: usize,
    pub explanation: String,
}

/// A package may suggest a program from the existing native candidate set. The
/// manifest grants no execution, arguments, file ownership, or loader binding.
fn release_manifest_program<'a>(
    root: &Path,
    project_url: &str,
    candidates: &[&'a SetupLaunchTarget],
) -> Option<&'a SetupLaunchTarget> {
    let file =
        crate::external_runtime::open_single_link_file(&root.join("recomplauncher.json")).ok()?;
    let mut bytes = Vec::new();
    file.take(LAUNCH_MANIFEST_LIMIT + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > LAUNCH_MANIFEST_LIMIT {
        return None;
    }
    let manifest: ReleaseLaunchManifest = serde_json::from_slice(&bytes).ok()?;
    if manifest.format != 1
        || manifest.games.is_some()
        || manifest.repo.as_deref().is_some_and(|repo| {
            !crate::release::catalog_download_repository(project_url)
                .is_ok_and(|expected| repo.eq_ignore_ascii_case(&expected))
        })
        || !(1..=16).contains(&manifest.start.program.len())
    {
        return None;
    }
    // Refuse the declaration if any alternative is invalid. Only compare
    // lexical paths against the already inspected files, without opening them.
    let programs = manifest
        .start
        .program
        .iter()
        .map(|program| {
            if program.len() > 256 {
                return None;
            }
            let (candidate, _) = crate::archive::validate_relative_path(program, false).ok()?;
            Some(candidate)
        })
        .collect::<Option<Vec<_>>>()?;
    programs.iter().find_map(|program| {
        candidates.iter().copied().find(|candidate| {
            candidate.executable.strip_prefix(root).ok() == Some(program.as_path())
        })
    })
}

// Validate format/processor rather than treating an extension as a game identity.
fn native_application(path: &Path, platform: Platform) -> Result<bool> {
    let mut file = crate::external_runtime::open_single_link_file(path)?;
    let mut header = [0_u8; 64];
    if file.read(&mut header)? < header.len() {
        return Ok(false);
    }
    match platform {
        Platform::WindowsX86_64 => {
            if !header.starts_with(b"MZ")
                || !path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            {
                return Ok(false);
            }
            let offset = u32::from_le_bytes(header[60..64].try_into().unwrap());
            if !(64..=1024 * 1024).contains(&offset) {
                return Ok(false);
            }
            file.seek(SeekFrom::Start(u64::from(offset)))?;
            let mut pe = [0_u8; 24];
            if file.read(&mut pe)? != pe.len() {
                return Ok(false);
            }
            let machine = u16::from_le_bytes(pe[4..6].try_into().unwrap());
            let characteristics = u16::from_le_bytes(pe[22..24].try_into().unwrap());
            Ok(pe.starts_with(b"PE\0\0")
                && matches!(machine, 0x8664 | 0x014c)
                && characteristics & 0x0002 != 0
                && characteristics & 0x2000 == 0)
        }
        Platform::LinuxX86_64 => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if file.metadata()?.permissions().mode() & 0o111 == 0 {
                    return Ok(false);
                }
            }
            Ok(header.starts_with(b"\x7fELF")
                && header[4] == 2
                && header[5] == 1
                && matches!(u16::from_le_bytes([header[16], header[17]]), 2 | 3)
                && u16::from_le_bytes([header[18], header[19]]) == 62)
        }
        Platform::MacosX86_64 | Platform::MacosAarch64 => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if file.metadata()?.permissions().mode() & 0o111 == 0 {
                    return Ok(false);
                }
            }
            let cpu = if platform == Platform::MacosAarch64 {
                0x0100_000c
            } else {
                0x0100_0007
            };
            if header.starts_with(&[0xca, 0xfe, 0xba, 0xbe]) {
                let count = u32::from_be_bytes(header[4..8].try_into().unwrap());
                if count > 16 {
                    return Ok(false);
                }
                let length = file.metadata()?.len();
                for index in 0..count {
                    file.seek(SeekFrom::Start(8 + u64::from(index) * 20))?;
                    let mut arch = [0_u8; 20];
                    if file.read(&mut arch)? != arch.len() {
                        return Ok(false);
                    }
                    if u32::from_be_bytes(arch[0..4].try_into().unwrap()) != cpu {
                        continue;
                    }
                    let offset = u64::from(u32::from_be_bytes(arch[8..12].try_into().unwrap()));
                    if offset > length.saturating_sub(16) {
                        return Ok(false);
                    }
                    file.seek(SeekFrom::Start(offset))?;
                    let mut inner = [0_u8; 16];
                    if file.read(&mut inner)? != inner.len() {
                        return Ok(false);
                    }
                    return Ok(inner.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
                        && u32::from_le_bytes(inner[4..8].try_into().unwrap()) == cpu
                        && u32::from_le_bytes(inner[12..16].try_into().unwrap()) == 2);
                }
                return Ok(false);
            }
            Ok(header.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
                && u32::from_le_bytes(header[4..8].try_into().unwrap()) == cpu
                && u32::from_le_bytes(header[12..16].try_into().unwrap()) == 2)
        }
    }
}

fn supporting_program(path: &Path) -> bool {
    let name = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let tokens = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .collect::<Vec<_>>();
    name.starts_with("unins")
        || name.starts_with("vc_redist")
        || name.starts_with("crash")
        || name.contains("setup")
        || name.starts_with("dxweb")
        || tokens.iter().any(|token| {
            [
                "setup",
                "install",
                "installer",
                "uninstall",
                "updater",
                "update",
                "helper",
                "crashpad",
                "reporter",
                "config",
                "configuration",
            ]
            .contains(token)
        })
}

fn reviewed_bundle_hint(hint: &str) -> Option<(&OsStr, &OsStr)> {
    let mut parts = Path::new(hint).components();
    let Component::Normal(bundle) = parts.next()? else {
        return None;
    };
    let Component::Normal(contents) = parts.next()? else {
        return None;
    };
    let Component::Normal(macos) = parts.next()? else {
        return None;
    };
    let Component::Normal(executable) = parts.next()? else {
        return None;
    };
    (parts.next().is_none()
        && Path::new(bundle)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
        && contents == "Contents"
        && macos == "MacOS")
        .then_some((bundle, executable))
}

fn reviewed_bundle_program(
    bundle: &Path,
    platform: Platform,
    hints: &[String],
) -> Result<Option<PathBuf>> {
    if !matches!(platform, Platform::MacosX86_64 | Platform::MacosAarch64) {
        return Ok(None);
    }
    let mut executables = hints
        .iter()
        .filter_map(|hint| reviewed_bundle_hint(hint))
        .filter(|(name, _)| bundle.file_name() == Some(*name))
        .map(|(_, program)| program);
    let Some(program) = executables.next() else {
        return Ok(None);
    };
    if executables.any(|other| other != program) {
        return Ok(None);
    }
    let contents = bundle.join("Contents");
    crate::external_runtime::open_single_link_file(&contents.join("Info.plist"))?;
    Ok(Some(contents.join("MacOS").join(program)))
}

pub(super) fn resolve_selected_bundle(
    selected: &Path,
    platform: Platform,
    hints: &[String],
) -> Result<Option<PathBuf>> {
    if !matches!(platform, Platform::MacosX86_64 | Platform::MacosAarch64)
        || !selected
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
    {
        return Ok(None);
    }
    if !selected.is_absolute() {
        return Err(PortcoveError::usage("choose an absolute application path"));
    }
    crate::path::refuse_symlink_ancestors(selected)?;
    let program = reviewed_bundle_program(selected, platform, hints)?.ok_or_else(|| {
        PortcoveError::usage("choose the game executable inside this application")
    })?;
    if !native_application(&program, platform)? {
        return Err(PortcoveError::verification(
            "the reviewed application does not contain a native executable for this host",
        ));
    }
    Ok(Some(program))
}

fn inspect(
    root: &Path,
    platform: Platform,
    hints: &[String],
) -> Result<(Vec<SetupLaunchTarget>, bool, usize)> {
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), 0_usize)]);
    let mut candidates = Vec::new();
    let mut checked = 0;
    let mut complete = true;
    'folders: while let Some((directory, depth)) = queue.pop_front() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        for entry in entries {
            if checked == ENTRY_LIMIT || candidates.len() == CANDIDATE_LIMIT {
                complete = false;
                break 'folders;
            }
            checked += 1;
            let Ok(entry) = entry else {
                complete = false;
                continue;
            };
            let path = entry.path();
            if crate::path::refuse_symlink_ancestors(&path).is_err() {
                complete = false;
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(value) => value,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            let executable = if metadata.is_dir() {
                if path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
                {
                    match reviewed_bundle_program(&path, platform, hints) {
                        Ok(Some(program)) => program,
                        _ => {
                            complete = false;
                            continue;
                        }
                    }
                } else {
                    if depth < DEPTH_LIMIT {
                        queue.push_back((path, depth + 1));
                    } else {
                        complete = false;
                    }
                    continue;
                }
            } else if metadata.is_file() {
                path
            } else {
                continue;
            };
            match native_application(&executable, platform) {
                Ok(true) => {
                    let supporting = supporting_program(&executable);
                    let working_directory = executable.parent().unwrap_or(&directory).to_path_buf();
                    candidates.push(SetupLaunchTarget { working_directory, executable, supporting_program:supporting,
                            reason: if supporting { "Appears to be setup or a supporting program. Choose the installed game or upstream launcher instead." } else { "Native application for this host. Confirm that it is the game or upstream launcher." }.into() });
                }
                Ok(false) => {}
                Err(_) => complete = false,
            }
        }
    }
    candidates.sort_by(|a, b| {
        a.supporting_program
            .cmp(&b.supporting_program)
            .then_with(|| a.executable.cmp(&b.executable))
    });
    Ok((candidates, complete, checked))
}

impl PortcoveService {
    pub fn discover_setup_launch_targets(
        &self,
        port_id: &str,
        pending_id: &str,
    ) -> Result<SetupLaunchTargets> {
        let root = self.pending_setup_folder(port_id, pending_id)?;
        let pending = self
            .pending_setups()?
            .into_iter()
            .find(|record| record.port_id == port_id && record.id == pending_id)
            .ok_or_else(|| PortcoveError::conflict("setup reminder changed; refresh the game"))?;
        if pending.state != PendingSetupState::Downloaded {
            return Err(PortcoveError::conflict(
                "resolve the download recovery before choosing a launch target",
            ));
        }
        let platform = Platform::current()?;
        let definition = self.catalog.port(port_id).ok();
        let hints = definition
            .and_then(|port| port.executable_hints.get(&platform))
            .map(Vec::as_slice)
            .unwrap_or_default();
        let (candidates, complete, entries_checked) = inspect(&root, platform, hints)?;
        let plausible = candidates
            .iter()
            .filter(|candidate| !candidate.supporting_program)
            .collect::<Vec<_>>();
        let identity = |text: &str| {
            text.chars()
                .filter(char::is_ascii_alphanumeric)
                .flat_map(char::to_lowercase)
                .collect::<String>()
        };
        let id = identity(&pending.listing.id);
        let title = identity(
            pending
                .listing
                .original_game_title
                .as_deref()
                .unwrap_or(&pending.listing.name),
        );
        let unintegrated = definition.is_none();
        let project = reqwest::Url::parse(&pending.listing.project_url)
            .ok()
            .and_then(|url| {
                let mut segments = url.path_segments()?;
                segments.rfind(|segment| !segment.is_empty()).map(identity)
            })
            .unwrap_or_default();
        let convincing = plausible
            .iter()
            .filter(|target| {
                let reviewed_hint = matches_executable_hint(&target.executable, hints);
                let name = identity(
                    &target
                        .executable
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy(),
                );
                reviewed_hint
                    || (unintegrated && project.len() >= 4 && name == project)
                    || [&id, &title].iter().any(|key| {
                        key.len() >= 4 && (name == **key || name.starts_with(key.as_str()))
                    })
            })
            .collect::<Vec<_>>();
        let raw_package = root.join(&pending.artifact.name).is_file();
        let declared = if complete && !raw_package && hints.is_empty() {
            release_manifest_program(&root, &pending.listing.project_url, &plausible)
        } else {
            None
        };
        let recommended_executable = if complete && !raw_package {
            declared
                .or_else(|| (convincing.len() == 1).then(|| *convincing[0]))
                .map(|candidate| candidate.executable.clone())
        } else {
            None
        };
        let explanation = if !complete { "Search reached a safety bound or could not inspect every entry. Choose an executable manually, or open a smaller installed folder." }
            else if plausible.is_empty() { "No native game application was identified here. Complete upstream setup, refresh suggestions, or choose the installed executable elsewhere. Installers, scripts and app bundles may need upstream setup first." }
            else if declared.is_some() { "The setup manifest names this native program. Confirm that it is the game or upstream launcher." }
            else { "Confirm the game or upstream launcher. First launch may handle game-data setup; discovery does not prove configuration or gameplay." }.into();
        Ok(SetupLaunchTargets {
            port_id: port_id.into(),
            pending_id: pending_id.into(),
            candidates,
            recommended_executable,
            complete,
            entries_checked,
            explanation,
        })
    }
}

fn matches_executable_hint(path: &Path, hints: &[String]) -> bool {
    hints.iter().any(|hint| {
        path.file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(hint))
            || (reviewed_bundle_hint(hint).is_some() && path.ends_with(hint))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pe(path: &Path) {
        let mut bytes = vec![0_u8; 88];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&64_u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[68..70].copy_from_slice(&0x8664_u16.to_le_bytes());
        bytes[86..88].copy_from_slice(&2_u16.to_le_bytes());
        fs::write(path, bytes).unwrap();
    }
    #[test]
    fn validates_native_headers_and_preserves_nested_working_directory() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("game/bin");
        fs::create_dir_all(&nested).unwrap();
        pe(&nested.join("game.exe"));
        pe(&nested.join("setup.exe"));
        fs::write(nested.join("fake.exe"), b"MZ not a program").unwrap();
        let (targets, complete, _) = inspect(temp.path(), Platform::WindowsX86_64, &[]).unwrap();
        assert!(complete);
        assert_eq!(targets.len(), 2);
        assert!(!targets[0].supporting_program);
        assert!(targets[1].supporting_program);
        assert_eq!(targets[0].working_directory, nested);
        assert!(!native_application(&targets[0].executable, Platform::LinuxX86_64).unwrap());
        assert!(matches_executable_hint(
            &targets[0].executable,
            &["Game.EXE".into()]
        ));
        assert!(!matches_executable_hint(
            &targets[0].executable,
            &["other.exe".into()]
        ));
    }

    #[test]
    fn mac_setup_only_suggests_reviewed_bundle_programs_for_the_host() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let directory = root.join("OpenLoco.app/Contents/MacOS");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.parent().unwrap().join("Info.plist"), b"fixture").unwrap();
        let program = directory.join("OpenLoco");
        let mut macho = [0_u8; 64];
        macho[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        macho[4..8].copy_from_slice(&0x0100_000c_u32.to_le_bytes());
        macho[12..16].copy_from_slice(&2_u32.to_le_bytes());
        fs::write(&program, macho).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let hints = ["OpenLoco.app/Contents/MacOS/OpenLoco".into()];
        let bundle = root.join("OpenLoco.app");
        assert_eq!(
            resolve_selected_bundle(&bundle, Platform::MacosAarch64, &hints).unwrap(),
            Some(program.clone())
        );
        assert!(resolve_selected_bundle(&bundle, Platform::MacosX86_64, &hints).is_err());
        assert!(resolve_selected_bundle(&bundle, Platform::MacosAarch64, &[]).is_err());
        let (targets, complete, entries) = inspect(&root, Platform::MacosAarch64, &hints).unwrap();
        assert!(complete);
        assert_eq!(entries, 1);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].executable, program);
        assert_eq!(targets[0].working_directory, directory);
        assert!(matches_executable_hint(&targets[0].executable, &hints));
        assert!(
            inspect(&root, Platform::MacosX86_64, &hints)
                .unwrap()
                .0
                .is_empty()
        );
        assert!(
            inspect(&root, Platform::MacosAarch64, &[])
                .unwrap()
                .0
                .is_empty()
        );
        assert!(reviewed_bundle_hint("OpenLoco.app/Contents/MacOS/../OpenLoco").is_none());

        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            let other = outside.path().join("different");
            fs::rename(&program, &other).unwrap();
            std::os::unix::fs::symlink(&other, &program).unwrap();
            let (targets, complete, _) = inspect(&root, Platform::MacosAarch64, &hints).unwrap();
            assert!(targets.is_empty());
            assert!(!complete);
        }
    }

    #[test]
    fn windows_host_suggestions_include_win32_but_exclude_dlls_and_other_processors() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("game.exe");
        pe(&path);
        let mut bytes = fs::read(&path).unwrap();
        bytes[68..70].copy_from_slice(&0x014c_u16.to_le_bytes());
        fs::write(&path, &bytes).unwrap();
        assert!(native_application(&path, Platform::WindowsX86_64).unwrap());
        bytes[86..88].copy_from_slice(&0x2002_u16.to_le_bytes());
        fs::write(&path, &bytes).unwrap();
        assert!(!native_application(&path, Platform::WindowsX86_64).unwrap());
        bytes[86..88].copy_from_slice(&2_u16.to_le_bytes());
        for machine in [0xaa64_u16, 0x01c4, 0x0000] {
            bytes[68..70].copy_from_slice(&machine.to_le_bytes());
            fs::write(&path, &bytes).unwrap();
            assert!(!native_application(&path, Platform::WindowsX86_64).unwrap());
        }
    }
    #[test]
    fn candidate_and_depth_bounds_are_honest() {
        let temp = tempfile::tempdir().unwrap();
        for i in 0..33 {
            pe(&temp.path().join(format!("game{i}.exe")));
        }
        let (targets, complete, _) = inspect(temp.path(), Platform::WindowsX86_64, &[]).unwrap();
        assert!(!complete);
        assert_eq!(targets.len(), 32);
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("a/b/c/d/e/f/g")).unwrap();
        assert!(
            !inspect(temp.path(), Platform::WindowsX86_64, &[])
                .unwrap()
                .1
        );
    }
}
