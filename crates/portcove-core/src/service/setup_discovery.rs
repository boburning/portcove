//! Bounded, read-only suggestions. Registration and launch revalidate the chosen file.
use super::*;
use std::io::{Read, Seek, SeekFrom};

const ENTRY_LIMIT: usize = 2048;
const DEPTH_LIMIT: usize = 5;
const CANDIDATE_LIMIT: usize = 32;

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
                && machine == 0x8664
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

fn inspect(root: &Path, platform: Platform) -> Result<(Vec<SetupLaunchTarget>, bool, usize)> {
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
            if metadata.is_dir() {
                if path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
                {
                    complete = false;
                    continue;
                }
                if depth < DEPTH_LIMIT {
                    queue.push_back((path, depth + 1));
                } else {
                    complete = false;
                }
            } else if metadata.is_file() {
                match native_application(&path, platform) {
                    Ok(true) => {
                        let supporting = supporting_program(&path);
                        candidates.push(SetupLaunchTarget { working_directory: directory.clone(), executable:path, supporting_program:supporting,
                            reason: if supporting { "Appears to be setup or a supporting program. Choose the installed game or upstream launcher instead." } else { "Native application for this host. Confirm that it is the game or upstream launcher." }.into() });
                    }
                    Ok(false) => {}
                    Err(_) => complete = false,
                }
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
        let (candidates, complete, entries_checked) = inspect(&root, platform)?;
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
        let title = identity(&pending.listing.name);
        let convincing = plausible.first().is_some_and(|target| {
            let reviewed_hint = self
                .catalog
                .port(port_id)
                .ok()
                .and_then(|port| port.executable_hints.get(&platform))
                .is_some_and(|hints| matches_executable_hint(&target.executable, hints));
            let name = identity(
                &target
                    .executable
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy(),
            );
            reviewed_hint
                || [&id, &title]
                    .iter()
                    .any(|key| key.len() >= 4 && (name == **key || name.starts_with(key.as_str())))
        });
        let raw_package = root.join(&pending.artifact.name).is_file();
        let recommended_executable =
            if complete && plausible.len() == 1 && convincing && !raw_package {
                Some(plausible[0].executable.clone())
            } else {
                None
            };
        let explanation = if !complete { "Search reached a safety bound or could not inspect every entry. Choose an executable manually, or open a smaller installed folder." }
            else if plausible.is_empty() { "No native game application was identified here. Complete upstream setup, refresh suggestions, or choose the installed executable elsewhere. Installers, scripts and app bundles may need upstream setup first." }
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
    path.file_name()
        .is_some_and(|name| hints.iter().any(|hint| name.eq_ignore_ascii_case(hint)))
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
        let (targets, complete, _) = inspect(temp.path(), Platform::WindowsX86_64).unwrap();
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
    fn candidate_and_depth_bounds_are_honest() {
        let temp = tempfile::tempdir().unwrap();
        for i in 0..33 {
            pe(&temp.path().join(format!("game{i}.exe")));
        }
        let (targets, complete, _) = inspect(temp.path(), Platform::WindowsX86_64).unwrap();
        assert!(!complete);
        assert_eq!(targets.len(), 32);
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("a/b/c/d/e/f/g")).unwrap();
        assert!(!inspect(temp.path(), Platform::WindowsX86_64).unwrap().1);
    }
}
