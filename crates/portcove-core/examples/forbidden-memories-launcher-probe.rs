//! One first-party translation unit under the delivered Core owned-child job.
//! Source/tool/binary/custody admission remains a separate native packet.
use std::error::Error;

#[cfg(windows)]
mod probe {
    use portcove_core::{ChildProcessClass, ChildProcessPolicy, PortcoveService};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::{
        fs::{self, File},
        io::{Read, Write},
        os::windows::fs::MetadataExt,
        path::{Component, Path, PathBuf, Prefix},
        process::Stdio,
        time::{Duration, Instant},
    };

    const INPUT: &[u8] = b"int portcove_first_party_probe(void) { return 141; }\n";
    const COOPERATIVE_SECONDS: u64 = 150;

    #[derive(Deserialize)]
    struct FileIdentity {
        path: String,
        bytes: u64,
        sha256: String,
    }

    fn sha256(
        path: &Path,
        expected_bytes: u64,
        deadline: Instant,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let mut file = File::open(path)?;
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut observed = 0_u64;
        loop {
            if Instant::now() >= deadline {
                return Err("verification deadline reached".into());
            }
            let limit =
                (expected_bytes.saturating_sub(observed) + 1).min(buffer.len() as u64) as usize;
            let count = file.read(&mut buffer[..limit])?;
            if count == 0 {
                break;
            }
            observed += count as u64;
            if observed > expected_bytes {
                return Err("verification byte bound exceeded".into());
            }
            hash.update(&buffer[..count]);
        }
        if observed != expected_bytes {
            return Err("verification byte count changed".into());
        }
        Ok(hex::encode(hash.finalize()))
    }

    fn ordinary_path(path: &Path, fresh: bool) -> Result<(), Box<dyn std::error::Error>> {
        let text = path.to_str().ok_or("native coordinates must be ASCII")?;
        if text.len() > 220
            || !path.is_absolute()
            || !text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b" :/\\._-+".contains(&byte))
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
            || !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
        {
            return Err("native coordinates require ordinary absolute ASCII disk paths".into());
        }
        for ancestor in path.ancestors() {
            match fs::symlink_metadata(ancestor) {
                Ok(metadata) if metadata.file_attributes() & 0x400 != 0 => {
                    return Err("reparse-point coordinates refused".into());
                }
                Ok(_) => {}
                Err(error)
                    if fresh
                        && ancestor == path
                        && error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if fresh && path.exists() {
            return Err("scratch is not fresh".into());
        }
        Ok(())
    }

    fn verify_tools(root: &Path, deadline: Instant) -> Result<(), Box<dyn std::error::Error>> {
        ordinary_path(root, false)?;
        let files: Vec<FileIdentity> =
            serde_json::from_str(include_str!("forbidden-memories-launcher-files.json"))?;
        for identity in files {
            let path = root.join(identity.path);
            ordinary_path(&path, false)?;
            if !path.is_file()
                || path.metadata()?.len() != identity.bytes
                || sha256(&path, identity.bytes, deadline)? != identity.sha256
            {
                return Err("authenticated toolchain member changed".into());
            }
        }
        Ok(())
    }

    fn write_new(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        let mut file = File::options().write(true).create_new(true).open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    }

    fn refuse_overlap(root: &Path, tools: &Path) -> Result<(), Box<dyn std::error::Error>> {
        // Canonical identities are comparison-only; retain ordinary caller
        // spelling for tools that reject verbatim mixed-slash coordinates.
        let scratch_identity = fs::canonicalize(root.parent().ok_or("scratch parent absent")?)?
            .join(root.file_name().ok_or("scratch leaf absent")?);
        let tools_identity = fs::canonicalize(tools)?;
        let folded = |path: &Path| {
            PathBuf::from(
                path.to_string_lossy()
                    .replace('/', "\\")
                    .to_ascii_lowercase(),
            )
        };
        let scratch_identity = folded(&scratch_identity);
        let tools_identity = folded(&tools_identity);
        if tools_identity.starts_with(&scratch_identity)
            || scratch_identity.starts_with(&tools_identity)
        {
            return Err("scratch/toolchain overlap".into());
        }
        Ok(())
    }

    fn owned_child(root: &Path, tools: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let started = Instant::now();
        let operation_deadline = started + Duration::from_secs(COOPERATIVE_SECONDS);
        ordinary_path(root, true)?;
        verify_tools(
            tools,
            (Instant::now() + Duration::from_secs(15)).min(operation_deadline),
        )?;
        refuse_overlap(root, tools)?;
        fs::create_dir(root)?;
        fs::create_dir(root.join("temp"))?;
        fs::create_dir(root.join("cache"))?;
        fs::create_dir(root.join("profile"))?;
        write_new(&root.join("probe.c"), INPUT)?;
        let bin = tools.join("bin");
        let command = format!(
            "rule compile\n  command = \"{}\" \"{}\" -c probe.c -o probe.obj\n  description = first-party launcher probe\nbuild probe.obj: compile probe.c\ndefault probe.obj\n",
            bin.join("ccache.exe").display(),
            bin.join("clang.exe").display()
        );
        write_new(&root.join("build.ninja"), command.as_bytes())?;
        write_new(
            &root.join("ccache.conf"),
            b"compiler_check = content\nmax_size = 16M\nhard_link = false\n",
        )?;
        let system_root = std::env::var_os("SystemRoot").ok_or("SystemRoot is absent")?;
        let system_root = PathBuf::from(system_root);
        ordinary_path(&system_root, false)?;
        let mut ninja = ChildProcessPolicy::native_command(
            ChildProcessClass::UpstreamSetup,
            &bin.join("ninja.exe"),
        )?;
        ninja
            .env_clear()
            .env("SystemRoot", &system_root)
            .env("WINDIR", &system_root)
            .env(
                "PATH",
                format!(
                    "{};{}",
                    bin.display(),
                    system_root.join("System32").display()
                ),
            )
            .env("TEMP", root.join("temp"))
            .env("TMP", root.join("temp"))
            .env("USERPROFILE", root.join("profile"))
            .env("CCACHE_DIR", root.join("cache"))
            .env("CCACHE_TEMPDIR", root.join("temp"))
            .env("CCACHE_CONFIGPATH", root.join("ccache.conf"))
            .env("CCACHE_REMOTE_STORAGE", "")
            .env("CCACHE_LOGFILE", root.join("ccache.log"))
            .current_dir(root)
            .args(["-f", "build.ninja", "-j", "1", "-v"])
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        // The reviewed outer Core job already owns this child and all launches.
        // No nested job, upstream code, CMake generation or linked executable.
        let mut child = ninja.spawn()?;
        println!(
            "{}",
            serde_json::json!({"kind":"launcher_start", "probe_pid":std::process::id(), "ninja_pid":child.id(), "source_sha256":hex::encode(Sha256::digest(INPUT)), "cache":"fresh isolated", "deadline_seconds":COOPERATIVE_SECONDS})
        );
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if started.elapsed() >= Duration::from_secs(COOPERATIVE_SECONDS) {
                // Returning stops this first-party leader; Core closes and proves
                // the exact inherited job. Failed/private scratch is never removed.
                return Err("tiny launcher deadline reached; preserve scratch".into());
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        verify_tools(
            tools,
            (Instant::now() + Duration::from_secs(15)).min(operation_deadline),
        )?;
        if !status.success() {
            return Err("tiny launcher failed; preserve scratch".into());
        }
        let object = root.join("probe.obj");
        ordinary_path(&object, false)?;
        let bytes = object.metadata()?.len();
        let verification_deadline =
            (Instant::now() + Duration::from_secs(15)).min(operation_deadline);
        if bytes == 0
            || bytes > 1024 * 1024
            || sha256(
                &root.join("probe.c"),
                INPUT.len() as u64,
                verification_deadline,
            )? != hex::encode(Sha256::digest(INPUT))
        {
            return Err("tiny object/input validation refused".into());
        }
        println!(
            "{}",
            serde_json::json!({"kind":"tiny_compile", "object_bytes":bytes, "object_sha256":sha256(&object, bytes, verification_deadline)?, "ninja_exit_code":status.code(), "elapsed_ms":started.elapsed().as_millis(), "qualification":"not granted"})
        );
        Ok(())
    }

    pub fn main() -> Result<(), Box<dyn std::error::Error>> {
        let args = std::env::args_os().skip(1).collect::<Vec<_>>();
        if args.len() == 3 && args[0] == "--owned-child" {
            return owned_child(&PathBuf::from(&args[1]), &PathBuf::from(&args[2]));
        }
        if args.len() != 4 || args[0] != "--supervise" {
            return Err("requires --supervise <reviewed binary SHA256> <fresh scratch> <authenticated toolchain>".into());
        }
        let digest = args[1].to_str().ok_or("digest must be UTF-8")?;
        let root = PathBuf::from(&args[2]);
        let tools = PathBuf::from(&args[3]);
        ordinary_path(&root, true)?;
        // Tool bytes are checked by the first-party child, inside the delivered
        // Core 180-second boundary and before any tool payload executes.
        ordinary_path(&tools, false)?;
        let receipt = PortcoveService::qualification_forbidden_memories_supervise(
            &std::env::current_exe()?,
            digest,
            &root,
            &tools,
        )?;
        println!(
            "{}",
            serde_json::json!({"kind":"authenticated_tiny_launcher_probe", "toolchain_root":tools, "core_owned_session":receipt, "scope":"one first-party object, not full producer fit/game setup/progression", "native_admission":"separate literal review required"})
        );
        if receipt["process_tree_quiesced"] != true
            || receipt["outcome"]["child_success"] != true
            || receipt["outcome"]["output_truncated"] != false
        {
            return Err("tiny launcher observation held; preserve all evidence".into());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn refuses_growth_short_reads_and_expired_verification() {
            let working = tempfile::tempdir().unwrap();
            let file = working.path().join("bounded");
            fs::write(&file, b"ab").unwrap();
            let deadline = Instant::now() + Duration::from_secs(1);
            assert!(
                sha256(&file, 1, deadline)
                    .unwrap_err()
                    .to_string()
                    .contains("byte bound")
            );
            assert!(
                sha256(&file, 3, deadline)
                    .unwrap_err()
                    .to_string()
                    .contains("byte count")
            );
            assert!(
                sha256(&file, 2, Instant::now())
                    .unwrap_err()
                    .to_string()
                    .contains("deadline")
            );
            assert_eq!(
                sha256(&file, 2, deadline).unwrap(),
                hex::encode(Sha256::digest(b"ab"))
            );
            assert_eq!(fs::read(&file).unwrap(), b"ab");
        }

        #[test]
        fn refuses_case_alias_overlap_without_creating_scratch() {
            let working = tempfile::tempdir().unwrap();
            let tools = working.path().join("Tools");
            fs::create_dir(&tools).unwrap();
            let root = PathBuf::from(tools.join("scratch").to_str().unwrap().to_ascii_uppercase());
            assert!(
                refuse_overlap(&root, &tools)
                    .unwrap_err()
                    .to_string()
                    .contains("overlap")
            );
            assert!(!root.exists());
            refuse_overlap(&working.path().join("separate-scratch"), &tools).unwrap();
        }
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    #[cfg(windows)]
    {
        probe::main()
    }
    #[cfg(not(windows))]
    {
        Err("this finite toolchain probe is Windows-only".into())
    }
}
