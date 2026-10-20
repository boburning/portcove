//! One fixed Render96 US source recipe, using the cartridge install authority.
use super::{
    BuildArchive, BuildCommandOutput, BuildInputs, BuildSession, CartridgeBuildPreparation,
    RECEIPT, TOOLCHAIN, cmake_path, copy_verified, digest, inventory, write_new,
};
use crate::{CartridgeBuildRecipe, Platform, PortcoveError, Result, SourceRecord};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

const RECIPE: CartridgeBuildRecipe = CartridgeBuildRecipe::Render96UsSourceV1;
const COMMIT: &str = "48da5c491c8abfb2f5192b59278c1c269411e533";
const VERSION: &str = "source-48da5c491c8a";
const ORIGINAL: &str = "17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91";
const ORIGINAL_SIZE: u64 = 8_388_608;
// Each fixed upstream compile command also expands the SDL shell script.
// Bound compiler batches separately from the already qualified sound batches
// so the complete debug-event/process membership fits the existing supervisor.
const OBJECTS_PER_INVOCATION: usize = 2;
const GAME: BuildArchive = BuildArchive {
    name: "Render96ex-48da5c491c8abfb2f5192b59278c1c269411e533.zip",
    url: "https://codeload.github.com/Render96/Render96ex/zip/48da5c491c8abfb2f5192b59278c1c269411e533",
    size: 11_615_689,
    sha256: "43091630151c8023b72e7faa2726c3914376fee2cc3becbfefba30423b71b403",
    root: "Render96ex-48da5c491c8abfb2f5192b59278c1c269411e533",
};
const SDL: BuildArchive = BuildArchive {
    name: "SDL2-devel-2.32.10-mingw.zip",
    url: "https://github.com/libsdl-org/SDL/releases/download/release-2.32.10/SDL2-devel-2.32.10-mingw.zip",
    size: 14_260_563,
    sha256: "f15cff5fca62ec9381a016ef1d42a95c638cd72d2f226ba5781c76fe43dbd1ac",
    root: "SDL2-2.32.10",
};

pub(super) fn archives() -> Vec<BuildArchive> {
    vec![GAME, SDL, TOOLCHAIN]
}

fn primary_asset() -> crate::ReleaseAsset {
    crate::ReleaseAsset {
        name: format!("{COMMIT}.zip"),
        url: format!("https://github.com/Render96/Render96ex/archive/{COMMIT}.zip"),
        size: GAME.size,
        sha256: GAME.sha256.into(),
    }
}

pub(super) fn verify_release(release: &crate::ResolvedRelease) -> Result<()> {
    let primary = primary_asset();
    if release.version != VERSION
        || release.channel != crate::ReleaseChannel::Stable
        || serde_json::to_value(&release.asset)? != serde_json::to_value(primary)?
    {
        return Err(PortcoveError::verification(
            "Render96 requires its exact reviewed source archive",
        ));
    }
    Ok(())
}

pub(super) fn validate_port(
    port: &crate::PortDefinition,
    profile: &crate::SourceProfile,
) -> Result<()> {
    let primary = primary_asset();
    let direct = BTreeMap::from([(
        Platform::WindowsX86_64,
        crate::DirectReleaseSpec {
            version: VERSION.into(),
            url: primary.url,
            size: primary.size,
            sha256: primary.sha256,
            published_at: None,
        },
    )]);
    if port.id != "render96ex"
        || port.project_url != "https://github.com/Render96/Render96ex"
        || port.release.provider != crate::ReleaseSource::DirectManifest
        || port.release.repository != "Render96/Render96ex"
        || serde_json::to_value(&port.release.direct)? != serde_json::to_value(direct)?
        || port.release.managed_build != BTreeMap::from([(Platform::WindowsX86_64, RECIPE)])
        || !port.release.user_prepared.is_empty()
        || !port.release.curated.is_empty()
        || !port.release.asset_hints.is_empty()
        || port.release.rolling_tag.is_some()
        || port.platforms != [Platform::WindowsX86_64]
        || port.channels != [crate::ReleaseChannel::Stable]
        || port.adapter != crate::AdapterKind::StagedSourcePortable
        || port.portable_marker
        || port.n64_windows_initial_d3d12
        || port.windows_runtime_path_policy.is_some()
        || port.launch_from_install_root
        || port.source_profile.as_deref() != Some("ghostship-source")
        || profile.id != "ghostship-source"
        || profile.kind != crate::SourceKind::File
        || port.bios_source_profile.is_some()
        || port.executable_hints
            != BTreeMap::from([(Platform::WindowsX86_64, vec!["sm64.us.f3dex2e.exe".into()])])
        || port.persistent_paths != ["sm64config.txt", "sm64_save_file.bin"]
        || !port.runtime_mutable_paths.is_empty()
        || !port.persistent_file_patterns.is_empty()
        || !port.runtime_mutable_file_patterns.is_empty()
        || !port.bundled_runtime.is_empty()
        || port.runtime_subdirectory.is_some()
        || port.runtime_source_filename.is_some()
        || port.runtime_source_materialization.is_some()
        || !port.runtime_source_hashes.is_empty()
        || !port.runtime_source_set.is_empty()
        || port.source_environment.is_some()
        || port.user_data_environment.is_some()
        || !port.launch_environment.is_empty()
        || port.launch_arguments != ["--savepath", "!"]
        || !port.setup_executable_hints.is_empty()
        || !port.setup_arguments.is_empty()
        || port.setup_marker.is_some()
        || !port.setup_output_paths.is_empty()
    {
        return Err(PortcoveError::verification(
            "Render96 fixed source, runtime and write contract differs",
        ));
    }
    Ok(())
}

pub(super) fn storage_identity(primary_sha256: &str, source: &SourceRecord) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&(
        "Portcove Render96 US fixed source build v1",
        RECIPE,
        primary_sha256,
        ORIGINAL,
        source.storage_sha256.as_str(),
        source.storage_size,
        archives(),
        PATCHES,
        "us/f3dex2e/D3D11/DXGI/SDL2/external-data/legacy-res=0/textsaves=0/rmodern=0/discordrpc=0",
        ["--savepath", "!"],
        ["sm64config.txt", "sm64_save_file.bin"],
    ))?))
}

pub(super) fn verify_original(
    source: &SourceRecord,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    if !source
        .path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|extension| {
            ["z64", "n64", "v64"]
                .iter()
                .any(|e| extension.eq_ignore_ascii_case(e))
        })
    {
        return Err(PortcoveError::source(
            "Render96 builds require raw .z64, .n64 or .v64 input; extract and register the raw original before building",
        ));
    }
    if source.profile_id != "ghostship-source"
        || source.sha256 != ORIGINAL
        || source.size != ORIGINAL_SIZE
        || source.storage_size != ORIGINAL_SIZE
    {
        return Err(PortcoveError::source(
            "Render96 requires the exact raw Super Mario 64 USA 1.0 original",
        ));
    }
    crate::path::refuse_symlink_ancestors(&source.path)?;
    let (hash, size) =
        crate::adapter::hash_file_bounded_with_checkpoint(&source.path, ORIGINAL_SIZE, checkpoint)?;
    if hash != source.storage_sha256 || size != ORIGINAL_SIZE {
        return Err(PortcoveError::source(
            "Render96 stored original changed after verification",
        ));
    }
    checkpoint()
}

#[derive(serde::Serialize)]
struct Patch {
    path: &'static str,
    before: &'static str,
    after: &'static str,
}
const PATCHES: &[Patch] = &[
    Patch {
        path: "extract_assets.py",
        before: "431e7826ca7bf1c9050f22b205037959625cbc3720dd428a3bfed0fbf59688e8",
        after: "9b607c876c7e38f711ea9e2839c80f588f77e7d7798731648d945ab82ae7983d",
    },
    Patch {
        path: "Makefile",
        before: "f2c1d101b384cb11aa46608a7368a480b2c2536ac585776825723608cb9019d7",
        after: "cc2965990266f475bdbfbe1d5212ed8899eb9a81b622544a1c09c3cd879b9ff2",
    },
    Patch {
        path: "src/pc/audio/audio_sdl.c",
        before: "0575cae71e7b69d3fe92515f82f5807ea27c34aac343b0e3bdbf0aa1466d88b2",
        after: "df1982f979acab5123244c9e4f36a68ce0af78e7e93a7d47e1b0ba0df0359092",
    },
];

fn replace_once(text: &mut String, before: &str, after: &str) -> Result<()> {
    if text.matches(before).count() != 1 {
        return Err(PortcoveError::verification(
            "fixed Render96 patch is not unique",
        ));
    }
    *text = text.replacen(before, after, 1);
    Ok(())
}

fn apply_patches(project: &Path) -> Result<()> {
    for patch in PATCHES {
        let path = project.join(patch.path);
        let bytes = crate::path::read_bounded_regular(&path, 256 * 1024)?;
        if digest(&bytes) != patch.before {
            return Err(PortcoveError::verification(
                "Render96 patch preimage differs",
            ));
        }
        let mut text = String::from_utf8(bytes)
            .map_err(|_| PortcoveError::verification("Render96 patch input is not UTF-8"))?;
        match patch.path {
            "extract_assets.py" => {
                replace_once(
                    &mut text,
                    "    todo = defaultdict(lambda: [])",
                    "    todo = defaultdict(lambda: [])\n    portcove_remaining = 32",
                )?;
                replace_once(
                    &mut text,
                    "                todo[(lang, mio0)].append((asset, pos, size, meta))",
                    "                if portcove_remaining == 0:\n                    continue\n                todo[(lang, mio0)].append((asset, pos, size, meta))\n                portcove_remaining -= 1",
                )?;
                replace_once(
                    &mut text,
                    "    subprocess.check_call(\n        [\"make\", \"-s\", \"-C\", \"tools/\", \"n64graphics\", \"skyconv\", \"mio0\", \"aifc_decode\"]\n    )",
                    "    # Portcove built and verified these tools in a separate supervised phase.",
                )?;
            }
            "Makefile" => {
                replace_once(
                    &mut text,
                    "DUMMY != make -C tools >&2 || echo FAIL",
                    "# Portcove built and verified tools in a separate supervised phase.\nDUMMY :=",
                )?;
                replace_once(
                    &mut text,
                    "$(AS) $(ASFLAGS) -MD $(BUILD_DIR)/$*.d -o $@ $<",
                    "$(AS) $(ASFLAGS) -MMD -MF $(BUILD_DIR)/$*.d -o $@ $<",
                )?;
                text.push_str("\n.PHONY: portcove-object-plan\nportcove-object-plan:\n\t$(file >portcove-objects.txt,$(sort $(O_FILES) $(MIO0_FILES:.mio0=.o) $(SOUND_OBJ_FILES) $(ULTRA_O_FILES) $(GODDARD_O_FILES)))\n\t@true\n");
                text.push_str("\n# Preserve generated C between bounded compiler invocations.\n.SECONDARY: $(GENERATED_C_FILES)\n");
                // LLVM's COFF writer retains an object wrapper with `-O binary`.
                // The sequence interpreter needs only the section's raw bytes.
                replace_once(
                    &mut text,
                    "$(OBJCOPY) -j .rodata $< -O binary $@",
                    "$(OBJCOPY) --dump-section=.rodata=$@ $< $@.coff\n\t@rm $@.coff",
                )?;
            }
            "src/pc/audio/audio_sdl.c" => replace_once(
                &mut text,
                "#include <SDL2/SDL.h>",
                "#include <stdio.h>\n#include <SDL2/SDL.h>",
            )?,
            _ => return Err(PortcoveError::state("unknown fixed Render96 patch")),
        }
        if digest(text.as_bytes()) != patch.after {
            return Err(PortcoveError::verification("Render96 patch result differs"));
        }
        fs::write(path, text)?;
    }
    Ok(())
}

// Make expands command variables in shell text. Until quoting through all of
// the pinned upstream rules is qualified, reject ambiguous paths explicitly.
fn make_path(path: &Path) -> Result<String> {
    let text = cmake_path(path)?;
    if !text
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/:._-".contains(&b))
    {
        return Err(PortcoveError::unsupported(
            "this Render96 recipe requires build paths containing only ASCII letters, digits, slash, colon, dot, underscore or hyphen",
        ));
    }
    Ok(text)
}

struct MakeSession<'a, 'b> {
    session: &'a BuildSession<'b>,
    project: PathBuf,
}

impl MakeSession<'_, '_> {
    fn run(
        &self,
        arguments: &[String],
        program: &str,
        phase: &str,
        quiesced: &mut bool,
    ) -> Result<BuildCommandOutput> {
        self.session
            .run_configured(arguments, program, phase, quiesced, |command| {
                let tool = self.session.inputs.toolroot()?;
                let root = self.session.work;
                let system = command
                    .environment
                    .iter()
                    .find(|(key, _)| {
                        crate::process::environment_names_equal(
                            key,
                            std::ffi::OsStr::new("SystemRoot"),
                        )
                    })
                    .map(|(_, value)| PathBuf::from(value))
                    .ok_or_else(|| {
                        PortcoveError::unsupported("Windows system root is unavailable")
                    })?;
                command.environment.clear();
                command
                    .current_dir(&self.project)
                    .env("SystemRoot", &system)
                    .env("WINDIR", &system)
                    .env("COMSPEC", system.join("System32/cmd.exe"))
                    .env("OS", "Windows_NT")
                    .env("NUMBER_OF_PROCESSORS", "2")
                    .env("PROCESSOR_ARCHITECTURE", "AMD64")
                    .env(
                        "PATH",
                        std::env::join_paths([
                            root.join("shims"),
                            tool.join("bin"),
                            tool.join("busybox/bin"),
                            tool.join("python"),
                            system.join("System32"),
                        ])
                        .map_err(|_| PortcoveError::verification("invalid fixed build PATH"))?,
                    )
                    .env("SHELL", tool.join("busybox/bin/sh.exe"))
                    .env("TEMP", root.join("temp"))
                    .env("TMP", root.join("temp"))
                    .env("HOME", root.join("home"))
                    .env("USERPROFILE", root.join("home"))
                    .env("PYTHONHOME", tool.join("python"))
                    .env("PYTHONDONTWRITEBYTECODE", "1")
                    .env("PYTHONNOUSERSITE", "1")
                    .env("PYTHONSAFEPATH", "1")
                    .env("CLANG_CONFIG_FILE_SYSTEM_DIR", root.join("empty-config"))
                    .env("CLANG_CONFIG_FILE_USER_DIR", root.join("empty-config"))
                    .env("GIT_CEILING_DIRECTORIES", root)
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("GIT_CONFIG_GLOBAL", root.join("empty-config/no-git-config"));
                Ok(())
            })
    }
}

pub(super) fn prepare_install(
    work: &Path,
    payload: &Path,
    preparation: &CartridgeBuildPreparation,
    library: &crate::Library,
    operation: &crate::OperationCoordinator,
    quiesced: &mut bool,
) -> Result<()> {
    let checkpoint = || operation.checkpoint();
    verify_original(&preparation.source, &checkpoint)?;
    make_path(work)?;
    let inputs = BuildInputs::capture(work, RECIPE, &checkpoint)?;
    let project = work.join("project");
    fs::create_dir(&project)?;
    for file in &inputs.identities[0] {
        checkpoint()?;
        copy_verified(
            &inputs.roots[0].join(&file.path),
            &project.join(&file.path),
            &checkpoint,
        )?;
    }
    apply_patches(&project)?;
    crate::adapter::prepare_raw_n64_source(
        &preparation.source.path,
        &project.join("baserom.us.z64"),
        ORIGINAL_SIZE,
    )?;
    if crate::adapter::hash_file_bounded_with_checkpoint(
        &project.join("baserom.us.z64"),
        ORIGINAL_SIZE,
        &checkpoint,
    )? != (ORIGINAL.into(), ORIGINAL_SIZE)
    {
        return Err(PortcoveError::source(
            "Render96 owned canonical US original differs",
        ));
    }
    verify_original(&preparation.source, &checkpoint)?;
    for directory in ["temp", "home", "shims", "empty-config"] {
        fs::create_dir(work.join(directory))?;
    }
    copy_verified(
        &inputs.tool("bin/mingw32-make.exe")?,
        &work.join("shims/make.exe"),
        &checkpoint,
    )?;
    copy_verified(
        &inputs.tool("python/python.exe")?,
        &work.join("shims/python3.exe"),
        &checkpoint,
    )?;
    let session = BuildSession {
        inputs: &inputs,
        work,
        library,
        operation,
        deadline: Instant::now(),
        port_id: "render96ex",
    };
    let make = MakeSession {
        session: &session,
        project,
    };
    build_and_package(&make, payload, preparation, quiesced)
}

fn make_arguments(inputs: &BuildInputs) -> Result<Vec<String>> {
    let tool = make_path(inputs.toolroot()?)?;
    let sdl = make_path(&inputs.roots[1].join("x86_64-w64-mingw32"))?;
    Ok(vec![
        "-j2".into(),
        format!("SHELL={tool}/busybox/bin/sh.exe"),
        "VERSION=us".into(),
        "GRUCODE=f3dex2e".into(),
        "EXTERNAL_DATA=1".into(),
        "LEGACY_RES=0".into(),
        "DISCORDRPC=0".into(),
        "TEXTSAVES=0".into(),
        "RMODERN=0".into(),
        "RENDER_API=D3D11".into(),
        "WINDOW_API=DXGI".into(),
        "AUDIO_API=SDL2".into(),
        "CONTROLLER_API=SDL2".into(),
        "TARGET_ARCH=x86-64".into(),
        "TARGET_BITS=64".into(),
        "NOEXTRACT=1".into(),
        format!(
            "INCLUDE_CFLAGS=-I include -I build/us_pc -I build/us_pc/include -I src -I . -I {sdl}/include"
        ),
        "GIT_HASH=48da5c4".into(),
        "COMPILE_TIME=Portcove-private-fixed-source".into(),
        format!("CC={tool}/bin/x86_64-w64-mingw32-gcc.exe"),
        format!("CXX={tool}/bin/x86_64-w64-mingw32-g++.exe"),
        format!("LD={tool}/bin/x86_64-w64-mingw32-g++.exe"),
        format!("CPP={tool}/bin/x86_64-w64-mingw32-gcc.exe -E -P -x c"),
        format!("AS={tool}/bin/x86_64-w64-mingw32-gcc.exe -c -x assembler-with-cpp"),
        "ASFLAGS=-I include -I build/us_pc -Wa,--defsym,AVOID_UB=1".into(),
        format!("OBJCOPY={tool}/bin/llvm-objcopy.exe"),
        format!("OBJDUMP={tool}/bin/llvm-objdump.exe"),
        format!("PYTHON={tool}/python/python.exe"),
        format!("SDLCONFIG={tool}/busybox/bin/sh.exe {sdl}/bin/sdl2-config"),
    ])
}

fn verify_files(
    root: &Path,
    files: &[super::FileIdentity],
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    for file in files {
        checkpoint()?;
        let path = root.join(&file.path);
        crate::path::refuse_symlink_ancestors(&path)?;
        let (hash, size) =
            crate::adapter::hash_file_bounded_with_checkpoint(&path, file.size, checkpoint)?;
        if hash != file.sha256 || size != file.size {
            return Err(PortcoveError::verification(
                "Render96 derived input changed",
            ));
        }
    }
    Ok(())
}

fn us_assets(project: &Path) -> Result<Vec<String>> {
    let bytes = crate::path::read_bounded_regular(&project.join("assets.json"), 2 * 1024 * 1024)?;
    let map: BTreeMap<String, serde_json::Value> = serde_json::from_slice(&bytes)?;
    if map.len() > 4000 {
        return Err(PortcoveError::verification(
            "Render96 asset map exceeds fixed bounds",
        ));
    }
    let mut paths = Vec::new();
    for (name, value) in map {
        if name.starts_with('@') {
            continue;
        }
        crate::archive::validate_relative_path(&name, false)?;
        if value
            .as_array()
            .and_then(|a| a.last())
            .and_then(|v| v.as_object())
            .is_some_and(|positions| positions.contains_key("us"))
        {
            paths.push(name);
        }
    }
    if paths.len() < 1000 || paths.len() > 2500 {
        return Err(PortcoveError::verification(
            "Render96 US asset inventory differs",
        ));
    }
    Ok(paths)
}

fn missing_assets(project: &Path, assets: &[String]) -> Result<usize> {
    let mut missing = 0;
    for name in assets {
        let path = project.join(name);
        crate::path::refuse_symlink_ancestors(&path)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => missing += 1,
            _ => {
                return Err(PortcoveError::verification(
                    "Render96 asset is not a regular file",
                ));
            }
        }
    }
    Ok(missing)
}

fn compile_plan(project: &Path) -> Result<Vec<String>> {
    let bytes =
        crate::path::read_bounded_regular(&project.join("portcove-objects.txt"), 128 * 1024)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| PortcoveError::verification("Render96 object plan is not UTF-8"))?;
    let mut seen = std::collections::BTreeSet::new();
    let mut objects = Vec::new();
    for target in text.split_whitespace() {
        crate::archive::validate_relative_path(target, false)?;
        if !target.starts_with("build/us_pc/")
            || !target.ends_with(".o")
            || !target
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
            || !seen.insert(target.to_ascii_lowercase())
        {
            return Err(PortcoveError::verification(
                "Render96 object target differs",
            ));
        }
        objects.push(target.into());
    }
    // Independent owner bound, never supplied by the inspected Make graph.
    if objects.len() != 309 {
        return Err(PortcoveError::verification(
            "Render96 compiler object inventory differs",
        ));
    }
    Ok(objects)
}

fn validate_sound_player(bytes: &[u8]) -> Result<()> {
    if bytes.len() != 13_452
        || digest(bytes) != "27c7003e3f78c90ed67fbc8133be5b2949bae09afe323bdfe857b19c58950af4"
    {
        return Err(PortcoveError::verification(
            "Render96 raw sound-player sequence differs from the fixed source",
        ));
    }
    Ok(())
}

fn validate_sequence_table(bytes: &[u8]) -> Result<()> {
    // Fixed Windows little-endian 64-bit table: 35 entries, aligned data at
    // 576. Entry zero is the source-assembled player, padded to 16 bytes.
    if bytes.len() < 576 + 13_456
        || bytes[..8] != [3, 0, 35, 0, 0, 0, 0, 0]
        || bytes[8..16] != 576_u64.to_le_bytes()
        || bytes[16..24] != 13_456_u64.to_le_bytes()
        || bytes[576 + 13_452..576 + 13_456] != [0; 4]
    {
        return Err(PortcoveError::verification(
            "Render96 assembled sequence table differs from the fixed layout",
        ));
    }
    validate_sound_player(&bytes[576..576 + 13_452])
}

fn validate_link_plan(plan: &str, tool: &str) -> Result<()> {
    let commands: Vec<_> = plan
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let prefix = format!(
        "{tool}/bin/x86_64-w64-mingw32-g++.exe -L build/us_pc -o build/us_pc/sm64.us.f3dex2e.exe "
    );
    if commands.len() != 1 || !commands[0].starts_with(&prefix) {
        return Err(PortcoveError::verification(
            "Render96 link plan must contain only its fixed linker command; generated sources or objects still require preparation",
        ));
    }
    Ok(())
}

fn build_and_package(
    make: &MakeSession<'_, '_>,
    payload: &Path,
    preparation: &CartridgeBuildPreparation,
    quiesced: &mut bool,
) -> Result<()> {
    let session = make.session;
    let inputs = session.inputs;
    let project = &make.project;
    let checkpoint = || session.operation.checkpoint();
    let derived = inventory(project, &checkpoint)?;
    let tool = make_path(inputs.toolroot()?)?;
    // The amalgamated C++ audio helper's retained warnings and all other
    // helper output together exceed the bounded command result. Keep both
    // phases complete rather than suppressing warnings or relaxing capture.
    make.run(
        &[
            "-C".into(),
            make_path(&project.join("tools/audiofile"))?,
            "-j2".into(),
            format!("SHELL={tool}/busybox/bin/sh.exe"),
            format!("CC={tool}/bin/gcc.exe"),
            format!("CXX={tool}/bin/g++.exe"),
            "libaudiofile.a".into(),
        ],
        "bin/mingw32-make.exe",
        "install.cartridge.render96.tools.audiofile",
        quiesced,
    )?;
    make.run(
        &[
            "-C".into(),
            make_path(&project.join("tools"))?,
            "-j2".into(),
            format!("SHELL={tool}/busybox/bin/sh.exe"),
            format!("CC={tool}/bin/gcc.exe"),
            format!("CXX={tool}/bin/g++.exe"),
            "tabledesign_LDFLAGS=-Laudiofile -laudiofile -lc++ -lm".into(),
        ],
        "bin/mingw32-make.exe",
        "install.cartridge.render96.tools",
        quiesced,
    )?;
    let tools = inventory(&project.join("tools"), &checkpoint)?;
    for name in [
        "aifc_decode",
        "aiff_extract_codebook",
        "extract_data_for_mio",
        "mio0",
        "n64cksum",
        "n64graphics_ci",
        "n64graphics",
        "patch_libultra_math",
        "skyconv",
        "tabledesign",
        "textconv",
        "vadpcm_enc",
    ] {
        if !tools.iter().any(|file| file.path == format!("{name}.exe")) {
            return Err(PortcoveError::verification(
                "Render96 helper output is missing",
            ));
        }
    }
    verify_files(project, &derived, &checkpoint)?;
    let assets = us_assets(project)?;
    let mut missing = missing_assets(project, &assets)?;
    let mut extraction_batches = 0;
    while missing > 0 {
        if extraction_batches >= 80 {
            return Err(PortcoveError::verification(
                "Render96 extraction exceeded its fixed batch bound",
            ));
        }
        make.run(
            &[
                "-I".into(),
                "-B".into(),
                make_path(&project.join("extract_assets.py"))?,
                "us".into(),
            ],
            "python/python.exe",
            &format!("install.cartridge.render96.extract.{extraction_batches}"),
            quiesced,
        )?;
        let remaining = missing_assets(project, &assets)?;
        if remaining >= missing || missing - remaining > 32 {
            return Err(PortcoveError::verification(
                "Render96 extraction made invalid bounded progress",
            ));
        }
        missing = remaining;
        extraction_batches += 1;
    }
    verify_files(project, &derived, &checkpoint)?;
    verify_files(&project.join("tools"), &tools, &checkpoint)?;
    let generated = inventory(project, &checkpoint)?;
    let arguments = make_arguments(inputs)?;
    let run_targets =
        |targets: &[String], phase: &str, quiesced: &mut bool| -> Result<BuildCommandOutput> {
            let mut args = arguments.clone();
            args.extend_from_slice(targets);
            make.run(&args, "bin/mingw32-make.exe", phase, quiesced)
        };
    run_targets(
        &["build/us_pc/include/level_headers.h".into()],
        "install.cartridge.render96.level-headers",
        quiesced,
    )?;
    let textures: Vec<_> = generated
        .iter()
        .filter(|file| {
            file.path.ends_with(".png")
                && ["actors/", "levels/", "textures/"]
                    .iter()
                    .any(|prefix| file.path.starts_with(prefix))
        })
        .map(|file| format!("build/us_pc/{}.inc.c", file.path.trim_end_matches(".png")))
        .collect();
    if textures.len() < 1000 || textures.len() > 2500 {
        return Err(PortcoveError::verification(
            "Render96 texture inventory differs",
        ));
    }
    for (batch, targets) in textures.chunks(16).enumerate() {
        for target in targets {
            crate::archive::validate_relative_path(target, false)?;
            let output = project.join(target);
            let parent = output.parent().ok_or_else(|| {
                PortcoveError::verification("Render96 texture target has no parent")
            })?;
            crate::path::refuse_symlink_ancestors(parent)?;
            fs::create_dir_all(parent)?;
        }
        run_targets(
            targets,
            &format!("install.cartridge.render96.textures.{batch}"),
            quiesced,
        )?;
    }
    // Generate the fixed sound dependencies separately: one compiler object
    // can otherwise pull every sample conversion into its output/event budget.
    let samples: Vec<_> = generated
        .iter()
        .filter(|file| file.path.ends_with(".aiff"))
        .map(|file| format!("build/us_pc/{}.aifc", file.path.trim_end_matches(".aiff")))
        .collect();
    if samples.len() != 219 {
        return Err(PortcoveError::verification(
            "Render96 sound sample inventory differs",
        ));
    }
    for (batch, targets) in samples.chunks(super::OBJECTS_PER_INVOCATION).enumerate() {
        run_targets(
            targets,
            &format!("install.cartridge.render96.samples.{batch}"),
            quiesced,
        )?;
    }
    run_targets(
        &[
            "build/us_pc/endian-and-bitwidth".into(),
            "build/us_pc/sound/sequences/00_sound_player.m64".into(),
        ],
        "install.cartridge.render96.sound-player",
        quiesced,
    )?;
    // Validate before assemble_sound.py can embed a COFF object as bytecode.
    let sound_player = crate::path::read_bounded_regular(
        &project.join("build/us_pc/sound/sequences/00_sound_player.m64"),
        13_452,
    )?;
    validate_sound_player(&sound_player)?;
    run_targets(
        &[
            "build/us_pc/sound/sound_data.ctl".into(),
            "build/us_pc/sound/sound_data.tbl".into(),
            "build/us_pc/sound/sequences.bin".into(),
            "build/us_pc/sound/bank_sets".into(),
        ],
        "install.cartridge.render96.sound",
        quiesced,
    )?;
    run_targets(
        &["portcove-object-plan".into()],
        "install.cartridge.render96.object-plan",
        quiesced,
    )?;
    let objects = compile_plan(project)?;
    for (batch, targets) in objects.chunks(OBJECTS_PER_INVOCATION).enumerate() {
        run_targets(
            targets,
            &format!("install.cartridge.render96.compile.{batch}"),
            quiesced,
        )?;
    }
    let mut compiled = Vec::new();
    for target in &objects {
        let path = project.join(target);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
            return Err(PortcoveError::verification(
                "Render96 object output differs",
            ));
        }
        let (sha256, size) =
            crate::adapter::hash_file_bounded_with_checkpoint(&path, metadata.len(), &checkpoint)?;
        compiled.push(super::FileIdentity {
            path: target.clone(),
            size,
            sha256,
        });
    }
    // Make's dry-run still expands its authenticated parse-time shell commands,
    // so retain supervision and complete diagnostics for this phase as well.
    let link_plan = run_targets(
        &["-n".into(), "build/us_pc/sm64.us.f3dex2e.exe".into()],
        "install.cartridge.render96.link-plan",
        quiesced,
    )?;
    let link_stdout = link_plan.complete_stdout()?;
    validate_link_plan(link_stdout, &tool)?;
    verify_files(project, &compiled, &checkpoint)?;
    run_targets(
        &["build/us_pc/sm64.us.f3dex2e.exe".into()],
        "install.cartridge.render96.link",
        quiesced,
    )?;
    if compile_plan(project)? != objects {
        return Err(PortcoveError::verification("Render96 compile plan changed"));
    }
    verify_files(project, &compiled, &checkpoint)?;
    verify_files(project, &generated, &checkpoint)?;
    verify_files(&project.join("tools"), &tools, &checkpoint)?;
    inputs.verify(&preparation.source, &checkpoint)?;
    let package = session.work.join("runtime");
    fs::create_dir(&package)?;
    copy_verified(
        &project.join("build/us_pc/sm64.us.f3dex2e.exe"),
        &package.join("sm64.us.f3dex2e.exe"),
        &checkpoint,
    )?;
    copy_verified(
        &inputs.roots[1].join("x86_64-w64-mingw32/bin/SDL2.dll"),
        &package.join("SDL2.dll"),
        &checkpoint,
    )?;
    for name in ["libc++.dll", "libunwind.dll"] {
        copy_verified(
            &inputs.tool(&format!("bin/{name}"))?,
            &package.join(name),
            &checkpoint,
        )?;
    }
    copy_verified(
        &project.join("baserom.us.z64"),
        &package.join("baserom.us.z64"),
        &checkpoint,
    )?;
    for name in [
        "bank_sets",
        "sequences.bin",
        "sound_data.ctl",
        "sound_data.tbl",
    ] {
        if name == "sequences.bin" {
            validate_sequence_table(&crate::path::read_bounded_regular(
                &project.join("build/us_pc/sound").join(name),
                512 * 1024,
            )?)?;
        }
        copy_verified(
            &project.join("build/us_pc/sound").join(name),
            &package.join("res/sound").join(name),
            &checkpoint,
        )?;
    }
    for file in &generated {
        if file.path.ends_with(".png")
            && ["actors/", "levels/", "textures/"]
                .iter()
                .any(|prefix| file.path.starts_with(prefix))
        {
            copy_verified(
                &project.join(&file.path),
                &package.join("res/gfx").join(&file.path),
                &checkpoint,
            )?;
        }
    }
    for file in inventory(
        &project.join("build/us_pc/textures/skybox_tiles"),
        &checkpoint,
    )? {
        copy_verified(
            &project
                .join("build/us_pc/textures/skybox_tiles")
                .join(&file.path),
            &package
                .join("res/gfx/textures/skybox_tiles")
                .join(&file.path),
            &checkpoint,
        )?;
    }
    for (source, target) in [
        (
            inputs.roots[0].join("README.md"),
            "licenses/Render96-README.md",
        ),
        (
            inputs.roots[1].join("LICENSE.txt"),
            "licenses/SDL2-LICENSE.txt",
        ),
        (
            inputs.toolroot()?.join("LICENSE.TXT"),
            "licenses/LLVM-LICENSE.txt",
        ),
    ] {
        copy_verified(&source, &package.join(target), &checkpoint)?;
    }
    let mut imports = BTreeMap::new();
    for (index, name) in [
        "sm64.us.f3dex2e.exe",
        "SDL2.dll",
        "libc++.dll",
        "libunwind.dll",
    ]
    .iter()
    .enumerate()
    {
        imports.insert(
            *name,
            session.inspect_imports(
                &package.join(name),
                &format!("install.cartridge.render96.imports.{index}"),
                quiesced,
            )?,
        );
    }
    inputs.verify(&preparation.source, &checkpoint)?;
    if !*quiesced {
        return Err(PortcoveError::state(
            "Render96 builder has no quiescence proof",
        ));
    }
    let output = inventory(&package, &checkpoint)?;
    let receipt = serde_json::json!({
        "format_version":1,"recipe":RECIPE,"runtime_origin":"locally-built","source_commit":COMMIT,
        "original_sha256":ORIGINAL,"original_size":ORIGINAL_SIZE,"stored_original_sha256":preparation.source.storage_sha256,
        "auxiliary_archives":archives(),"input_tree_identities":inputs.identities,"patches":PATCHES,
        "derived_project_sha256":digest(&serde_json::to_vec(&generated)?),"make_arguments":arguments,
        "extraction":{"assets":assets.len(),"batches":extraction_batches,"assets_per_batch":32},
        "compilation":{"objects":compiled,"objects_per_invocation":OBJECTS_PER_INVOCATION,"sound_samples":samples.len(),"sound_samples_per_invocation":super::OBJECTS_PER_INVOCATION,"supervisor_event_limit_unchanged":true},
        "sound_player":{"size":sound_player.len(),"sha256":digest(&sound_player),"format":"raw-sequence-bytecode"},
        "link_plan_stdout_sha256":digest(link_stdout.as_bytes()),
        "imports":imports,"runtime_files":output,"builder_quiesced":*quiesced,
        "game_executed_by_builder":false,"reproducibility_claim":false,
    });
    write_new(
        &package.join(RECEIPT),
        &serde_json::to_vec_pretty(&receipt)?,
    )?;
    for file in inventory(&package, &checkpoint)? {
        copy_verified(
            &package.join(&file.path),
            &payload.join(&file.path),
            &checkpoint,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sound_player_refuses_object_wrappers_and_unverified_bytecode() {
        // Regression: LLVM's COFF -O binary output contained this object header
        // before the actual sequence; interpreting it hung the audio script.
        let mut object = vec![0; 54_135];
        object[..4].copy_from_slice(&[0x64, 0x86, 1, 0]);
        object[20..27].copy_from_slice(b".rodata");
        object[60..68].copy_from_slice(&[0xd3, 0x60, 0xd5, 0, 0xdb, 0x7f, 0xdd, 0x78]);
        assert!(validate_sound_player(&object).is_err());
        assert!(validate_sound_player(&object[60..60 + 13_452]).is_err());
        assert!(validate_sound_player(&[]).is_err());
    }

    #[test]
    fn link_gate_refuses_remaining_generation_or_compilation() {
        let tool = "C:/fixed-toolchain";
        let link = format!(
            "{tool}/bin/x86_64-w64-mingw32-g++.exe -L build/us_pc -o build/us_pc/sm64.us.f3dex2e.exe build/us_pc/example.o -lm"
        );
        validate_link_plan(&link, tool).unwrap();
        // The runner preserves both streams. A retained stderr warning must
        // never be mistaken for another planned recipe.
        let captured = BuildCommandOutput {
            output: format!(
                "{link}\nprocess_begin: CreateProcess(NULL, git rev-parse --abbrev-ref HEAD, ...) failed.\nMakefile:178: pipe: No error\n"
            ),
            stdout: Some(link.clone()),
        };
        assert!(validate_link_plan(&captured.output, tool).is_err());
        validate_link_plan(captured.complete_stdout().unwrap(), tool).unwrap();
        assert!(
            BuildCommandOutput {
                output: link.clone(),
                stdout: None
            }
            .complete_stdout()
            .is_err()
        );
        for wrong in [
            String::new(),
            format!("tools/skyconv input output\n{link}"),
            format!("{tool}/bin/x86_64-w64-mingw32-gcc.exe -c example.c"),
            format!("{link}\n{link}"),
            link.replace("fixed-toolchain", "other-toolchain"),
        ] {
            assert!(validate_link_plan(&wrong, tool).is_err());
        }
    }

    fn fixture() -> (crate::PortDefinition, crate::SourceProfile) {
        let (mut port, mut profile) = super::super::source_build::tests::fixture(
            super::super::source_build::SourceRecipe::EarthBoundUsa,
        );
        port.id = "render96ex".into();
        port.project_url = "https://github.com/Render96/Render96ex".into();
        port.source_profile = Some("ghostship-source".into());
        port.release.repository = "Render96/Render96ex".into();
        port.release.managed_build = BTreeMap::from([(Platform::WindowsX86_64, RECIPE)]);
        let asset = primary_asset();
        port.release.direct = BTreeMap::from([(
            Platform::WindowsX86_64,
            crate::DirectReleaseSpec {
                version: VERSION.into(),
                url: asset.url,
                size: asset.size,
                sha256: asset.sha256,
                published_at: None,
            },
        )]);
        port.executable_hints =
            BTreeMap::from([(Platform::WindowsX86_64, vec!["sm64.us.f3dex2e.exe".into()])]);
        port.launch_arguments = vec!["--savepath".into(), "!".into()];
        port.persistent_paths = vec!["sm64config.txt".into(), "sm64_save_file.bin".into()];
        port.runtime_mutable_paths.clear();
        port.runtime_mutable_file_patterns.clear();
        profile.id = "ghostship-source".into();
        profile.accepted_extensions = vec!["z64".into(), "n64".into(), "v64".into()];
        profile.accepted_sha1.clear();
        profile.accepted_sha256 = vec![ORIGINAL.into()];
        (port, profile)
    }

    #[test]
    fn fixed_render96_contract_refuses_loader_writes_source_or_argument_changes() {
        let (port, profile) = fixture();
        super::super::validate_port(&port, &profile).unwrap();
        assert_eq!(RECIPE.minimum_template_version(), 13);
        assert!(port.windows_runtime_path_policy.is_none());
        // The retained common path policy stays a no-op for this recipe. Its
        // separate build-path validator still rejects ambiguous Make paths.
        crate::runtime_path_policy::check_output_root(
            &port,
            Platform::WindowsX86_64,
            Path::new("C:/non-ascii-\u{e9}/runtime"),
        )
        .unwrap();
        assert!(RECIPE.fixed_launch_arguments_only());
        assert_eq!(archives().len(), 3);
        for changed in [
            "res",
            "tas",
            "dll",
            "argument",
            "environment",
            "source",
            "recipe",
            "target",
            "path-policy",
        ] {
            let mut wrong = port.clone();
            match changed {
                "res" => wrong.persistent_paths.push("res".into()),
                "tas" => wrong.runtime_mutable_paths.push("cont.m64".into()),
                "dll" => wrong
                    .runtime_mutable_paths
                    .push("D3DCompiler_47.dll".into()),
                "argument" => wrong.launch_arguments = vec!["--savepath".into(), "other".into()],
                "environment" => {
                    wrong
                        .launch_environment
                        .insert("SDL_DYNAMIC_API".into(), "other.dll".into());
                }
                "source" => wrong.source_profile = Some("other-source".into()),
                "recipe" => {
                    wrong.release.managed_build.insert(
                        Platform::WindowsX86_64,
                        CartridgeBuildRecipe::EarthBoundSnesSourceV1,
                    );
                }
                "target" => {
                    wrong
                        .executable_hints
                        .insert(Platform::WindowsX86_64, vec!["other.exe".into()]);
                }
                "path-policy" => {
                    wrong.windows_runtime_path_policy =
                        Some(crate::WindowsRuntimePathPolicy::PrintableAsciiMaxPath);
                }
                _ => unreachable!(),
            }
            assert!(validate_port(&wrong, &profile).is_err(), "{changed}");
        }
    }

    #[test]
    fn raw_original_guidance_and_storage_identity_do_not_conflate_container_or_byte_order() {
        let source = SourceRecord {
            profile_id: "ghostship-source".into(),
            path: PathBuf::from("not-opened.zip"),
            sha256: ORIGINAL.into(),
            size: ORIGINAL_SIZE,
            storage_sha256: "a".repeat(64),
            storage_size: 123,
            updated_at: 0,
            observed_identity: None,
        };
        let error = verify_original(&source, &|| Ok(()))
            .unwrap_err()
            .to_string();
        assert!(error.contains("extract and register"));
        let first = storage_identity(GAME.sha256, &source).unwrap();
        let mut other = source.clone();
        other.storage_sha256 = "b".repeat(64);
        assert_ne!(first, storage_identity(GAME.sha256, &other).unwrap());
        assert!(make_path(Path::new("C:/ambiguous path/build")).is_err());
        assert!(make_path(Path::new("C:/build/$(substitute)")).is_err());
    }
}
