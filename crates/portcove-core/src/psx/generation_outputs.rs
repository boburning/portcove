//! Exact writes of the packaged PS1 generator, never arbitrary mutable trees.
use crate::{OperationCoordinator, PortcoveError, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GenerationOutputs {
    files: BTreeSet<PathBuf>,
    directories: BTreeSet<PathBuf>,
    required: BTreeSet<PathBuf>,
    config_sha256: String,
    original_config: Vec<u8>,
}

impl GenerationOutputs {
    /// Called only after fresh authenticated package verification. Full TOML
    /// parsing rejects duplicate tables/keys; paths must match the adapter's
    /// bounded project layout instead of following upstream redirects.
    pub(super) fn inspect(
        root: &Path,
        rewritten_config: &[u8],
        retail_bios: bool,
        operation: &OperationCoordinator,
    ) -> Result<Self> {
        let original = crate::path::read_bounded_regular(&root.join("game.toml"), 1024 * 1024)?;
        Self::from_config(
            root,
            original,
            rewritten_config,
            retail_bios,
            true,
            operation,
        )
    }

    fn from_config(
        root: &Path,
        original_config: Vec<u8>,
        rewritten_config: &[u8],
        retail_bios: bool,
        pristine: bool,
        operation: &OperationCoordinator,
    ) -> Result<Self> {
        use sha2::Digest;
        let game = parse_config(&original_config)?;
        if game
            .get("recompiler")
            .is_some_and(|v| v.get("bios_config").is_some())
            || root.join("bios/SCPH1001.toml").exists()
        {
            return Err(PortcoveError::verification(
                "PS1 alternate BIOS profile selector refused",
            ));
        }
        let disc = component(string(&game, "prepare_disc", "out_dir")?)?;
        let generated = component(string(&game, "recompiler", "out_dir")?)?;
        let boot = component(string(&game, "prepare_disc", "boot_exe")?)?;
        if disc != Path::new("disc")
            || generated != Path::new("generated")
            || relative(string(&game, "game", "exe")?)? != disc.join(&boot)
        {
            return Err(PortcoveError::verification(
                "PS1 generation layout redirect refused",
            ));
        }
        let seed = relative(string(&game, "recompiler", "seeds")?)?;
        require_regular(&root.join(seed))?;
        if pristine && root.join(".portcove-builder-environment").exists() {
            return Err(PortcoveError::conflict(
                "PS1 generation environment already exists",
            ));
        }
        // Pin the packaged framework root and both emitters. Missing emitters
        // must be refused before the CLI can enter its configure/build fallback.
        require_regular(&root.join("psxrecomp/.gitignore"))?;
        for name in ["psxrecomp-game", "psxrecomp-bios"] {
            require_regular(
                &root
                    .join("psxrecomp/recompiler/build")
                    .join(if cfg!(windows) {
                        format!("{name}.exe")
                    } else {
                        name.to_owned()
                    }),
            )?;
        }
        let mut files = BTreeSet::new();
        let mut required = BTreeSet::new();
        for key in ["bin_name", "cue_name", "boot_exe"] {
            let path = disc.join(component(string(&game, "prepare_disc", key)?)?);
            files.insert(path.clone());
            required.insert(path);
        }
        files.insert(disc.join("SYSTEM.CNF"));
        let cue = component(string(&game, "prepare_disc", "cue_name")?)?;
        files.insert(disc.join(cue.with_extension("sbi")));
        files.insert(disc.join(cue.with_extension("disc-receipt.json")));
        let stem = boot.to_str().expect("checked Unicode component");
        for suffix in ["_decls.h", "_full.c", "_full.ranges", "_dispatch.c"] {
            files.insert(generated.join(format!("{stem}{suffix}")));
        }
        required.insert(generated.join(format!("{stem}_dispatch.c")));
        for shard in 0..256 {
            files.insert(generated.join(format!("{stem}_full_{shard:02}.c")));
        }
        let openbios = game
            .get("runtime")
            .and_then(|v| v.get("openbios"))
            .map(|v| {
                v.as_bool()
                    .ok_or_else(|| PortcoveError::verification("PS1 OpenBIOS policy type refused"))
            })
            .transpose()?
            .unwrap_or(true);
        for (enabled, backend) in [(openbios, "OpenBIOS"), (retail_bios, "SCPH1001")] {
            if !enabled {
                continue;
            }
            operation.checkpoint()?;
            let profile = read_config(&root.join(format!("psxrecomp/bios/{backend}.toml")))?;
            if string(&profile, "recompiler", "out_dir")? != "generated"
                || string(&profile, "recompiler", "out_stem")? != backend
            {
                return Err(PortcoveError::verification(
                    "PS1 BIOS output redirect refused",
                ));
            }
            let rom = relative(string(&profile, "program", "rom")?)?;
            if backend == "SCPH1001" && rom != Path::new("bios/SCPH1001.BIN") {
                return Err(PortcoveError::verification(
                    "PS1 retail BIOS input redirect refused",
                ));
            }
            let seeds = relative(string(&profile, "recompiler", "seeds")?)?;
            if backend == "OpenBIOS" {
                require_regular(&root.join("psxrecomp").join(rom))?;
            }
            require_regular(&root.join("psxrecomp").join(seeds))?;
            for suffix in [
                "_full.c",
                "_dispatch.c",
                "_skipped_functions.json",
                "_interpreted_functions.json",
            ] {
                files.insert(PathBuf::from(format!(
                    "psxrecomp/generated/{backend}{suffix}"
                )));
            }
            required.insert(PathBuf::from(format!(
                "psxrecomp/generated/{backend}_full.c"
            )));
            required.insert(PathBuf::from(format!(
                "psxrecomp/generated/{backend}_dispatch.c"
            )));
        }
        if retail_bios {
            files.insert(PathBuf::from("psxrecomp/bios/SCPH1001.BIN"));
        }
        files.insert(PathBuf::from("game.toml"));
        let mut directories = BTreeSet::new();
        for file in &files {
            let mut parent = file.parent();
            while let Some(path) = parent {
                directories.insert(path.to_path_buf());
                parent = path.parent();
            }
        }
        operation.checkpoint()?;
        Ok(Self {
            files,
            directories,
            required,
            config_sha256: hex::encode(sha2::Sha256::digest(rewritten_config)),
            original_config,
        })
    }

    pub(super) fn original_config(&self) -> &[u8] {
        &self.original_config
    }

    pub(super) fn revalidate(
        &self,
        root: &Path,
        rewritten_config: &[u8],
        retail_bios: bool,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        let expected = Self::from_config(
            root,
            self.original_config.clone(),
            rewritten_config,
            retail_bios,
            false,
            operation,
        )?;
        if self != &expected {
            return Err(PortcoveError::verification(
                "PS1 retained generation write contract changed",
            ));
        }
        Ok(())
    }

    pub(super) fn mutable_file(&self, path: &Path) -> bool {
        self.files.contains(path) || path.starts_with(".portcove-builder-environment")
    }
    pub(super) fn declared_file(&self, path: &Path) -> bool {
        self.files.contains(path)
    }
    pub(super) fn output_directory(&self, path: &Path) -> bool {
        self.directories.contains(path) || path.starts_with(".portcove-builder-environment")
    }
    pub(super) fn required_files(&self) -> &BTreeSet<PathBuf> {
        &self.required
    }
    pub(super) fn config_sha256(&self) -> &str {
        &self.config_sha256
    }
}

fn read_config(path: &Path) -> Result<toml::Value> {
    let bytes = crate::path::read_bounded_regular(path, 1024 * 1024)?;
    parse_config(&bytes)
}

fn parse_config(bytes: &[u8]) -> Result<toml::Value> {
    if bytes.len() > 1024 * 1024 {
        return Err(PortcoveError::verification(
            "PS1 setup config exceeds bound",
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| PortcoveError::verification("PS1 setup config encoding refused"))?;
    toml::from_str(text).map_err(|_| PortcoveError::verification("PS1 setup config TOML refused"))
}

fn string<'a>(config: &'a toml::Value, table: &str, key: &str) -> Result<&'a str> {
    config
        .get(table)
        .and_then(|v| v.get(key))
        .and_then(toml::Value::as_str)
        .ok_or_else(|| PortcoveError::verification("PS1 setup config path missing or mistyped"))
}

fn relative(value: &str) -> Result<PathBuf> {
    // Reject alternate separators and host syntax on both supported targets.
    if value.is_empty()
        || value.contains(['\\', ':'])
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(PortcoveError::verification(
            "PS1 setup path redirect refused",
        ));
    }
    let path = PathBuf::from(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(PortcoveError::verification(
            "PS1 setup path redirect refused",
        ));
    }
    Ok(path)
}

fn component(value: &str) -> Result<PathBuf> {
    let path = relative(value)?;
    if path.components().count() != 1 {
        return Err(PortcoveError::verification(
            "PS1 setup filename redirect refused",
        ));
    }
    Ok(path)
}

fn require_regular(path: &Path) -> Result<()> {
    crate::path::refuse_symlink_ancestors(path)?;
    if !std::fs::symlink_metadata(path)?.is_file() {
        return Err(PortcoveError::verification(
            "PS1 packaged generation input is missing",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::stage::GeneratedTree;
    use super::*;
    use std::fs;

    fn fixture(root: &Path) -> OperationCoordinator {
        for directory in ["seeds", "psxrecomp/recompiler/build"] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        fs::write(root.join("game.toml"), concat!(
            "[game]\nexe = 'disc/GAME.EXE'\n",
            "[prepare_disc]\nout_dir = 'disc'\nbin_name = 'disc.bin'\ncue_name = 'disc.cue'\nboot_exe = 'GAME.EXE'\n",
            "[recompiler]\nout_dir = 'generated'\nseeds = 'seeds/game.txt'\n",
            "[runtime]\nopenbios = false\n",
        )).unwrap();
        fs::write(root.join("seeds/game.txt"), "immutable source seeds").unwrap();
        fs::write(root.join("psxrecomp/.gitignore"), "framework root marker").unwrap();
        for name in ["psxrecomp-game", "psxrecomp-bios"] {
            fs::write(
                root.join("psxrecomp/recompiler/build")
                    .join(if cfg!(windows) {
                        format!("{name}.exe")
                    } else {
                        name.to_owned()
                    }),
                "inert packaged emitter; never executed",
            )
            .unwrap();
        }
        OperationCoordinator::new("generation-output-fixture", None)
    }

    #[test]
    fn generation_output_transition_preserves_inputs_and_refuses_extra_or_incomplete_writes() {
        for change in [
            "none",
            "source",
            "extra",
            "temporary",
            "missing",
            "config",
            "object",
            "directory",
            "existing-directory",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path();
            let operation = fixture(root);
            let original = fs::read(root.join("game.toml")).unwrap();
            let outputs = GenerationOutputs::inspect(root, &original, false, &operation).unwrap();
            if change == "existing-directory" {
                fs::create_dir(root.join("disc")).unwrap();
                fs::write(root.join("disc/SYSTEM.CNF"), "original optional output").unwrap();
            }
            let before = GeneratedTree::capture(root, &operation, true).unwrap();
            for path in outputs.required_files() {
                fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
                fs::write(root.join(path), "inert generated output").unwrap();
            }
            fs::create_dir_all(root.join(".portcove-builder-environment/cache")).unwrap();
            fs::write(
                root.join(".portcove-builder-environment/cache/tool.log"),
                "owned cache",
            )
            .unwrap();
            match change {
                "source" => {
                    let path = root.join("seeds/game.txt");
                    let timestamp = fs::metadata(&path).unwrap().modified().unwrap();
                    let mut bytes = fs::read(&path).unwrap();
                    bytes[0] ^= 1;
                    fs::write(&path, bytes).unwrap();
                    fs::File::options()
                        .write(true)
                        .open(&path)
                        .unwrap()
                        .set_times(fs::FileTimes::new().set_modified(timestamp))
                        .unwrap();
                }
                "extra" => {
                    fs::write(root.join("generated/unexpected.c"), "undeclared").unwrap();
                }
                "temporary" => {
                    fs::write(root.join("generated/GAME.EXE_full_00.c.tmp"), "incomplete").unwrap();
                }
                "missing" => {
                    fs::remove_file(root.join("generated/GAME.EXE_dispatch.c")).unwrap();
                }
                "config" => {
                    fs::write(root.join("game.toml"), "changed config").unwrap();
                }
                "object" => {
                    let path = root.join("seeds/game.txt");
                    fs::rename(&path, root.join("retained-original-seed")).unwrap();
                    fs::write(path, "immutable source seeds").unwrap();
                }
                "directory" => {
                    fs::create_dir(root.join("disc/SYSTEM.CNF")).unwrap();
                }
                "existing-directory" => {
                    fs::remove_file(root.join("disc/SYSTEM.CNF")).unwrap();
                    fs::create_dir(root.join("disc/SYSTEM.CNF")).unwrap();
                }
                _ => {}
            }
            let current = GeneratedTree::capture(root, &operation, true).unwrap();
            assert_eq!(
                before
                    .require_generation_transition(&current, &outputs, &operation)
                    .is_ok(),
                change == "none",
                "{change}"
            );
        }
    }

    #[test]
    fn generation_output_contract_refuses_redirects_missing_emitters_and_preexisting_cache() {
        for change in [
            "absolute",
            "parent",
            "separator",
            "output",
            "duplicate",
            "emitter",
            "cache",
            "bios-selector",
            "alternate-bios",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path();
            let operation = fixture(root);
            let path = root.join("game.toml");
            let original = fs::read(&path).unwrap();
            let text = String::from_utf8(original.clone()).unwrap();
            match change {
                "absolute" => fs::write(&path, text.replace("'disc'", "'/outside'")).unwrap(),
                "parent" => fs::write(&path, text.replace("'disc.bin'", "'../disc.bin'")).unwrap(),
                "separator" => {
                    fs::write(&path, text.replace("'disc.bin'", "'sub\\disc.bin'")).unwrap()
                }
                "output" => fs::write(&path, text.replace("'generated'", "'runtime'")).unwrap(),
                "duplicate" => fs::write(&path, text + "\n[game]\nexe = 'outside'\n").unwrap(),
                "emitter" => fs::remove_file(root.join("psxrecomp/recompiler/build").join(
                    if cfg!(windows) {
                        "psxrecomp-game.exe"
                    } else {
                        "psxrecomp-game"
                    },
                ))
                .unwrap(),
                "cache" => fs::create_dir(root.join(".portcove-builder-environment")).unwrap(),
                "bios-selector" => fs::write(
                    &path,
                    text.replace(
                        "seeds = 'seeds/game.txt'",
                        "seeds = 'seeds/game.txt'\nbios_config = '/outside/profile.toml'",
                    ),
                )
                .unwrap(),
                "alternate-bios" => {
                    fs::create_dir(root.join("bios")).unwrap();
                    fs::write(root.join("bios/SCPH1001.toml"), "alternate profile").unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                GenerationOutputs::inspect(root, &original, false, &operation).is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn generation_output_receipt_cannot_widen_its_mutation_contract() {
        let temporary = tempfile::tempdir().unwrap();
        let operation = fixture(temporary.path());
        let original = fs::read(temporary.path().join("game.toml")).unwrap();
        let mut outputs =
            GenerationOutputs::inspect(temporary.path(), &original, false, &operation).unwrap();
        outputs
            .revalidate(temporary.path(), &original, false, &operation)
            .unwrap();
        outputs.files.insert(PathBuf::from("seeds/game.txt"));
        assert!(
            outputs
                .revalidate(temporary.path(), &original, false, &operation)
                .is_err()
        );
    }
}
