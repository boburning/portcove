//! Private tool execution and fixed generation/build/publication sequence.
use super::super::{
    BuildArchive, BuildCommandOutput, BuildInputs, BuildSession, CartridgeBuildPreparation,
    FileIdentity, RECEIPT, TOOLCHAIN, cmake_path, copy_verified, digest, inventory, write_new,
};
use super::{
    archive_facts, local_profile,
    plan::{OBJECT_BATCH_LIMIT, Plan, Stage},
    sources,
};
use crate::{PortcoveError, Result};
use serde::Deserialize;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

pub(super) const DXC: BuildArchive = BuildArchive {
    name: "cvlod-dxc-1.7.2308.zip",
    url: "https://github.com/microsoft/DirectXShaderCompiler/releases/download/v1.7.2308/dxc_2023_08_14.zip",
    size: 25_291_620,
    sha256: "01d4c4dfa37dee21afe70cac510d63001b6b611a128e3760f168765eead1e625",
    root: "",
};
pub(super) const SDL: BuildArchive = BuildArchive {
    name: "cvlod-SDL2-devel-2.30.3-VC.zip",
    url: "https://github.com/libsdl-org/SDL/releases/download/release-2.30.3/SDL2-devel-2.30.3-VC.zip",
    size: 2_736_738,
    sha256: "89999a6f3dc8f5e4fb03aaea6b4ad01747d9a81690f9f9a0674806e750483a38",
    root: "SDL2-2.30.3",
};
pub(super) const PATCH_BEFORE: &str =
    "eba0e901b6ba8160a0bc656b9c188fb8cfa68f442a8beadde353ca16debc5a49";
pub(super) const PATCH_AFTER: &str =
    "d79ef4de00ac8d04861f1f6d483bb50cf1517de74c5d8a9832dc4be2c9282758";
const GENERATION_PHASE: &str = "install.cartridge.cvlod.generate";

#[cfg(test)]
mod tests {
    use super::*;
    fn status(code: i32) -> std::process::ExitStatus {
        #[cfg(windows)]
        {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(code as u32)
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(code << 8)
        }
    }
    #[test]
    fn cvlod_generation_exception_requires_the_exact_retained_failure_and_phase() {
        let stderr = include_str!("overlay-error.txt");
        let mut diagnostic = crate::ActivityDiagnostic {
            activity_id: "fixture".into(),
            phase: GENERATION_PHASE.into(),
            stdout: crate::DiagnosticStream {
                text: String::new(),
                observed_bytes: 0,
                truncated: false,
            },
            stderr: crate::DiagnosticStream {
                text: stderr.into(),
                observed_bytes: stderr.len() as u64,
                truncated: false,
            },
            complete: true,
            updated_at: 0,
            stream_limit_bytes: 2 * 1024 * 1024,
        };
        validate_command_result(GENERATION_PHASE, &status(1), &diagnostic).unwrap();
        assert!(validate_command_result(GENERATION_PHASE, &status(0), &diagnostic).is_err());
        assert!(validate_command_result(GENERATION_PHASE, &status(2), &diagnostic).is_err());
        assert!(
            validate_command_result("install.cartridge.cvlod.other", &status(1), &diagnostic)
                .is_err()
        );
        diagnostic.stderr.text.push_str("different error\n");
        assert!(validate_command_result(GENERATION_PHASE, &status(1), &diagnostic).is_err());
        diagnostic.stderr.text = stderr.replace('\n', "\r\n");
        validate_command_result(GENERATION_PHASE, &status(1), &diagnostic).unwrap();
    }
}

pub(super) fn identity() -> String {
    digest(
        format!(
            "{}\n{}\n{}\n{}",
            include_str!("llvm.json"),
            include_str!("objects.json"),
            include_str!("helpers.json"),
            include_str!("generation.json")
        )
        .as_bytes(),
    )
}

fn copy_tree(source: &Path, destination: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
    let files = inventory(source, checkpoint)?;
    crate::path::refuse_symlink_ancestors(destination)?;
    fs::create_dir_all(destination)?;
    for file in &files {
        copy_verified(
            &source.join(&file.path),
            &destination.join(&file.path),
            checkpoint,
        )?;
    }
    if inventory(source, checkpoint)? != files {
        return Err(PortcoveError::verification(
            "CVLoD source changed while making its private working copy",
        ));
    }
    Ok(())
}

fn generate(
    executor: &Executor<'_, '_>,
    pristine: &[FileIdentity],
    checkpoint: &dyn Fn() -> Result<()>,
    quiesced: &mut bool,
) -> Result<serde_json::Value> {
    // The authenticated source tree has no tracked resources directory. The
    // fixed step6 helper writes its extended original there without creating it.
    // Create only this fresh private output directory; never reuse a preimage.
    checkpoint()?;
    let resources = executor.project.join("resources");
    crate::path::refuse_symlink_ancestors(&resources)?;
    fs::create_dir(&resources)?;
    let python = executor.toolchain().join("python/python.exe");
    for step in [
        "step1_dump_table",
        "step2_decompress",
        "step3_boundaries",
        "step4_functions",
        "step6_extended_rom",
    ] {
        let mut arguments = vec![
            "-I".into(),
            "-B".into(),
            "-X".into(),
            "utf8".into(),
            format!("tools/ni_ovl/{step}.py"),
        ];
        if ["step1_dump_table", "step2_decompress", "step6_extended_rom"].contains(&step) {
            arguments.push("rom.z64".into());
        }
        executor.run(
            &python,
            &arguments,
            &executor.phase("prepare-original"),
            executor.project,
            quiesced,
        )?;
    }
    let generated = executor.run(
        &executor
            .session
            .work
            .join("generated-recompiler/N64Recomp.exe"),
        &["recomp.toml".into()],
        GENERATION_PHASE,
        executor.project,
        quiesced,
    )?;
    // This raw failure is part of the final owned build receipt; classification
    // never changes its exit code or converts a general nonzero result to success.
    let failure = serde_json::json!({"phase":GENERATION_PHASE,"exit_code":generated.exit_code,
        "stdout":generated.complete_stdout()?,"stderr":generated.stderr,
        "classification":"exact reviewed overlay truncation; repairs and byte validation required"});
    for (script, extra) in [
        ("tools/fix_n64recomp_truncation.py", None),
        ("tools/ni_ovl/repair_overlay_table.py", Some("--fix")),
        ("tools/ni_ovl/fix_undeclared_labels.py", None),
        ("tools/apply_patches.py", None),
        ("tools/apply_symbols.py", None),
    ] {
        let mut arguments = vec![
            "-I".into(),
            "-B".into(),
            "-X".into(),
            "utf8".into(),
            script.into(),
        ];
        if let Some(extra) = extra {
            arguments.push(extra.into());
        }
        executor.run(
            &python,
            &arguments,
            &executor.phase("repair-generated"),
            executor.project,
            quiesced,
        )?;
    }
    let game = archive_root(executor.session.work, archive_facts::SOURCES[0]);
    let tracked: Vec<_> = pristine
        .iter()
        .filter(|f| f.path.starts_with("RecompiledFuncs/"))
        .collect();
    if tracked.len() != 17 {
        return Err(PortcoveError::verification(
            "CVLoD tracked generated-source restoration count differs",
        ));
    }
    for file in tracked {
        checkpoint()?;
        let bytes = crate::path::read_bounded_regular(&game.join(&file.path), file.size)?;
        if bytes.len() as u64 != file.size || digest(&bytes) != file.sha256 {
            return Err(PortcoveError::verification(
                "CVLoD tracked restoration preimage differs",
            ));
        }
        let target = executor.project.join(&file.path);
        crate::path::refuse_symlink_ancestors(&target)?;
        fs::write(target, bytes)?;
    }
    executor.run(
        &python,
        &[
            "-I".into(),
            "-B".into(),
            "-X".into(),
            "utf8".into(),
            "tools/ni_ovl/repair_overlay_table.py".into(),
        ],
        &executor.phase("validate-generated"),
        executor.project,
        quiesced,
    )?;
    let expected: Vec<FileIdentity> = serde_json::from_str(include_str!("generation.json"))?;
    if expected.len() != 499 {
        return Err(PortcoveError::verification(
            "CVLoD generated-byte oracle differs",
        ));
    }
    let actual = inventory(executor.project, checkpoint)?;
    let derived = |path: &str| {
        path == "rom.z64"
            || path == "resources/castlevania2_ni_extended.z64"
            || path.starts_with("RecompiledFuncs/")
            || path.starts_with("tools/ni_ovl/out/")
    };
    if actual
        .iter()
        .filter(|f| derived(&f.path))
        .cloned()
        .collect::<Vec<_>>()
        != expected
    {
        return Err(PortcoveError::verification(
            "CVLoD generated bytes differ from the reviewed owned-original output",
        ));
    }
    let public: BTreeMap<_, _> = pristine.iter().map(|f| (f.path.as_str(), f)).collect();
    for file in &actual {
        if !derived(&file.path) && public.get(file.path.as_str()).copied() != Some(file) {
            return Err(PortcoveError::verification(
                "CVLoD generation changed an unrelated public input",
            ));
        }
    }
    for file in pristine {
        if !derived(&file.path) && !actual.contains(file) {
            return Err(PortcoveError::verification(
                "CVLoD generation removed a public input",
            ));
        }
    }
    Ok(
        serde_json::json!({"ordinary_exit_failure":failure,"restored_tracked_files":17,"generated_files":expected,
        "generated_oracle_sha256":digest(include_str!("generation.json").as_bytes())}),
    )
}

fn inspect_image(
    executor: &Executor<'_, '_>,
    image: &Path,
    quiesced: &mut bool,
) -> Result<Vec<String>> {
    let bytes = crate::path::read_bounded_regular(image, 64 * 1024 * 1024)?;
    let offset = bytes
        .get(0x3c..0x40)
        .and_then(|v| <[u8; 4]>::try_from(v).ok())
        .map(u32::from_le_bytes)
        .map(|v| v as usize)
        .ok_or_else(|| PortcoveError::verification("CVLoD image has no PE header"))?;
    if bytes.get(..2) != Some(b"MZ")
        || bytes.get(offset..offset.saturating_add(6)) != Some(b"PE\0\0\x64\x86")
    {
        return Err(PortcoveError::verification(
            "CVLoD output is not an AMD64 native image",
        ));
    }
    let output = executor.run(
        &executor.toolchain().join("bin/llvm-readobj.exe"),
        &["--coff-imports".into(), cmake_path(image)?],
        &executor.phase("imports"),
        executor.session.work,
        quiesced,
    )?;
    let mut names = BTreeSet::new();
    for name in output
        .complete_stdout()?
        .lines()
        .filter_map(|l| l.trim().strip_prefix("Name:"))
    {
        let name = name.trim().to_ascii_lowercase();
        let allowed = [
            "sdl2.dll",
            "dxcompiler.dll",
            "dxil.dll",
            "d3d12.dll",
            "dxgi.dll",
            "d3dcompiler_47.dll",
            "dbghelp.dll",
            "kernel32.dll",
            "kernelbase.dll",
            "user32.dll",
            "gdi32.dll",
            "shell32.dll",
            "ole32.dll",
            "oleaut32.dll",
            "advapi32.dll",
            "setupapi.dll",
            "version.dll",
            "imm32.dll",
            "dwmapi.dll",
            "winmm.dll",
            "ws2_32.dll",
            "ntdll.dll",
            "msvcrt.dll",
            "ucrtbase.dll",
            "hid.dll",
            "cfgmgr32.dll",
            "msvcp140.dll",
            "msvcp140_atomic_wait.dll",
            "vcruntime140.dll",
            "vcruntime140_1.dll",
            "api-ms-win-shcore-scaling-l1-1-1.dll",
            "api-ms-win-crt-conio-l1-1-0.dll",
            "api-ms-win-crt-convert-l1-1-0.dll",
            "api-ms-win-crt-environment-l1-1-0.dll",
            "api-ms-win-crt-filesystem-l1-1-0.dll",
            "api-ms-win-crt-heap-l1-1-0.dll",
            "api-ms-win-crt-locale-l1-1-0.dll",
            "api-ms-win-crt-math-l1-1-0.dll",
            "api-ms-win-crt-multibyte-l1-1-0.dll",
            "api-ms-win-crt-private-l1-1-0.dll",
            "api-ms-win-crt-process-l1-1-0.dll",
            "api-ms-win-crt-runtime-l1-1-0.dll",
            "api-ms-win-crt-stdio-l1-1-0.dll",
            "api-ms-win-crt-string-l1-1-0.dll",
            "api-ms-win-crt-time-l1-1-0.dll",
            "api-ms-win-crt-utility-l1-1-0.dll",
        ];
        if !allowed.contains(&name.as_str()) || !names.insert(name) {
            return Err(PortcoveError::verification(
                "CVLoD output has an unreviewed native dependency",
            ));
        }
    }
    if names.is_empty() {
        return Err(PortcoveError::verification(
            "CVLoD import inspection is empty",
        ));
    }
    Ok(names.into_iter().collect())
}

pub(super) fn prepare_install(
    work: &Path,
    payload: &Path,
    preparation: &CartridgeBuildPreparation,
    library: &crate::Library,
    operation: &crate::OperationCoordinator,
    quiesced: &mut bool,
) -> Result<()> {
    let deadline = Instant::now();
    let checkpoint = || {
        operation.checkpoint()?;
        super::RECIPE
            .check_execution_deadline(deadline.elapsed())
            .map_err(|_| {
                PortcoveError::install("CVLoD build exceeded its finite execution deadline")
            })
    };
    super::verify_original(&preparation.source, &checkpoint)?;
    super::require_runtime_environment()?;
    for directory in ["home", "appdata", "localappdata", "temp"] {
        fs::create_dir(work.join(directory))?;
    }
    local_profile::require_available(&checkpoint)?;
    let local = local_profile::copy_into(work, &checkpoint)?;
    prepare_clang(work, &checkpoint)?;
    let archives = super::archives();
    let sdk = sources::sdk_roots(work, &archives, &checkpoint)?;
    let directx = sdk
        .get("directx")
        .ok_or_else(|| PortcoveError::verification("CVLoD DirectX headers are absent"))?;
    for name in ["freetype", "zlib"] {
        let source = sdk
            .get(name)
            .ok_or_else(|| PortcoveError::verification("CVLoD SDK source is absent"))?;
        copy_tree(source, &work.join("sdk-source").join(name), &checkpoint)?;
    }
    copy_tree(
        sdk.get("dlg")
            .ok_or_else(|| PortcoveError::verification("CVLoD dlg source is absent"))?,
        &work.join("sdk-source/freetype/subprojects/dlg"),
        &checkpoint,
    )?;
    let project = sources::assemble(work, &archives, &checkpoint)?;
    patch(&project)?;
    let pristine = inventory(&project, &checkpoint)?;
    let inputs = BuildInputs::capture(work, super::RECIPE, &checkpoint)?;
    let session = BuildSession {
        inputs: &inputs,
        work,
        library,
        operation,
        deadline,
        port_id: "cvlod-recomp",
    };
    let executor = Executor {
        session: &session,
        project: &project,
        local: &local,
        directx,
        sequence: Cell::new(0),
        commands: RefCell::new(Vec::new()),
    };
    let prefix = work.join("prefix");
    let mut plans = BTreeMap::new();
    for (name, stage, target, options) in [
        (
            "zlib",
            Stage::Zlib,
            "zlibstatic",
            vec![
                "-DZLIB_BUILD_TESTING=OFF".into(),
                "-DZLIB_BUILD_SHARED=OFF".into(),
                "-DZLIB_BUILD_STATIC=ON".into(),
            ],
        ),
        (
            "freetype",
            Stage::Freetype,
            "freetype",
            vec![
                "-DBUILD_SHARED_LIBS=OFF".into(),
                "-DFT_DISABLE_BZIP2=ON".into(),
                "-DFT_DISABLE_PNG=ON".into(),
                "-DFT_DISABLE_HARFBUZZ=ON".into(),
                "-DFT_DISABLE_BROTLI=ON".into(),
                "-DFT_DISABLE_HVF=ON".into(),
                "-DFT_REQUIRE_ZLIB=ON".into(),
                format!("-DZLIB_ROOT={}", cmake_path(&prefix)?),
                format!(
                    "-DZLIB_LIBRARY:FILEPATH={}",
                    cmake_path(&prefix.join("lib/zs.lib"))?
                ),
                format!(
                    "-DZLIB_LIBRARY_RELEASE:FILEPATH={}",
                    cmake_path(&prefix.join("lib/zs.lib"))?
                ),
                format!(
                    "-DZLIB_INCLUDE_DIR:PATH={}",
                    cmake_path(&prefix.join("include"))?
                ),
            ],
        ),
    ] {
        let build = work.join(format!("build-{name}"));
        let mut options = options;
        options.extend([
            format!("-DCMAKE_INSTALL_PREFIX={}", cmake_path(&prefix)?),
            format!("-DCMAKE_PREFIX_PATH={}", cmake_path(&prefix)?),
        ]);
        executor.configure(
            &work.join("sdk-source").join(name),
            &build,
            false,
            &options,
            quiesced,
        )?;
        plans.insert(name, executor.compile(&build, stage, target, quiesced)?);
        executor.run(
            &executor.cmake(),
            &["--install".into(), cmake_path(&build)?],
            &executor.phase("install-sdk"),
            work,
            quiesced,
        )?;
    }
    let recompiler_build = work.join("build-n64recomp");
    executor.configure(
        &project.join("lib/N64ModernRuntime/N64Recomp"),
        &recompiler_build,
        false,
        &[],
        quiesced,
    )?;
    plans.insert(
        "n64recomp",
        executor.compile(
            &recompiler_build,
            Stage::Recompiler,
            "N64RecompCLI",
            quiesced,
        )?,
    );
    fs::create_dir(work.join("generated-recompiler"))?;
    copy_verified(
        &recompiler_build.join("N64Recomp.exe"),
        &work.join("generated-recompiler/N64Recomp.exe"),
        &checkpoint,
    )?;
    let recompiler_imports = inspect_image(
        &executor,
        &work.join("generated-recompiler/N64Recomp.exe"),
        quiesced,
    )?;
    inputs.verify(&preparation.source, &checkpoint)?;
    let mut commands = executor.commands.into_inner();
    let sequence = executor.sequence.get();
    let inputs = BuildInputs::capture(work, super::RECIPE, &checkpoint)?;
    let session = BuildSession {
        inputs: &inputs,
        work,
        library,
        operation,
        deadline,
        port_id: "cvlod-recomp",
    };
    let executor = Executor {
        session: &session,
        project: &project,
        local: &local,
        directx,
        sequence: Cell::new(sequence),
        commands: RefCell::new(Vec::new()),
    };
    crate::adapter::prepare_raw_n64_source(
        &preparation.source.path,
        &project.join("rom.z64"),
        super::ORIGINAL_SIZE,
    )?;
    if crate::adapter::hash_file_bounded_with_checkpoint(
        &project.join("rom.z64"),
        super::ORIGINAL_SIZE,
        &checkpoint,
    )? != (super::ORIGINAL.into(), super::ORIGINAL_SIZE)
    {
        return Err(PortcoveError::verification(
            "CVLoD normalized original differs",
        ));
    }
    let generation = generate(&executor, &pristine, &checkpoint, quiesced)?;
    let generated_source = inventory(&project, &checkpoint)?;
    let build = work.join("build-game");
    let options = vec![
        format!("-DCMAKE_PREFIX_PATH={}", cmake_path(&prefix)?),
        format!(
            "-DZLIB_LIBRARY:FILEPATH={}",
            cmake_path(&prefix.join("lib/zs.lib"))?
        ),
        format!(
            "-DZLIB_LIBRARY_RELEASE:FILEPATH={}",
            cmake_path(&prefix.join("lib/zs.lib"))?
        ),
        format!(
            "-DZLIB_INCLUDE_DIR:PATH={}",
            cmake_path(&prefix.join("include"))?
        ),
        format!(
            "-DFREETYPE_LIBRARY_RELEASE:FILEPATH={}",
            cmake_path(&prefix.join("lib/freetype.lib"))?
        ),
        format!(
            "-DFREETYPE_INCLUDE_DIR_freetype2:PATH={}",
            cmake_path(&prefix.join("include/freetype2"))?
        ),
        format!(
            "-DFREETYPE_INCLUDE_DIR_ft2build:PATH={}",
            cmake_path(&prefix.join("include/freetype2"))?
        ),
        format!(
            "-DFETCHCONTENT_SOURCE_DIR_SDL2={}",
            cmake_path(&archive_root(work, SDL))?
        ),
    ];
    executor.configure(&project, &build, true, &options, quiesced)?;
    let compiler = crate::path::read_bounded_regular(
        &build.join("CMakeFiles/3.31.12/CMakeCXXCompiler.cmake"),
        64 * 1024,
    )?;
    let compiler = std::str::from_utf8(&compiler)
        .map_err(|_| PortcoveError::verification("CVLoD compiler metadata is not UTF-8"))?;
    if ![
        "CMAKE_CXX_COMPILER_ID \"Clang\"",
        "CMAKE_CXX_COMPILER_FRONTEND_VARIANT \"MSVC\"",
        "CMAKE_CXX_SIMULATE_ID \"MSVC\"",
    ]
    .iter()
    .all(|s| compiler.contains(s))
    {
        return Err(PortcoveError::verification(
            "CVLoD selected a different compiler ABI",
        ));
    }
    plans.insert(
        "game",
        executor.compile(&build, Stage::Game, "LodRecomp", quiesced)?,
    );
    if inventory(&project, &checkpoint)? != generated_source {
        return Err(PortcoveError::verification(
            "CVLoD build changed its generated source inputs",
        ));
    }
    inputs.verify(&preparation.source, &checkpoint)?;
    local_profile::verify_private(&local, &checkpoint)?;
    let package = work.join("package");
    fs::create_dir(&package)?;
    for (from, name) in [
        (build.join("LodRecomp.exe"), "LodRecomp.exe"),
        (archive_root(work, SDL).join("lib/x64/SDL2.dll"), "SDL2.dll"),
        (
            project.join("lib/rt64/src/contrib/dxc/bin/x64/dxcompiler.dll"),
            "dxcompiler.dll",
        ),
        (
            project.join("lib/rt64/src/contrib/dxc/bin/x64/dxil.dll"),
            "dxil.dll",
        ),
        (project.join("rom.z64"), super::RECIPE.original_filename()),
    ] {
        copy_verified(&from, &package.join(name), &checkpoint)?;
    }
    let assets = inventory(&project.join("assets"), &checkpoint)?;
    if assets.len() != 80 {
        return Err(PortcoveError::verification(
            "CVLoD runtime asset count differs",
        ));
    }
    for file in assets {
        copy_verified(
            &project.join("assets").join(&file.path),
            &package.join("assets").join(file.path),
            &checkpoint,
        )?;
    }
    write_new(&package.join("portable.txt"), b"")?;
    let public_roots = archives.len() + sources::raw_roots(work)?.len();
    for (index, root) in inputs
        .roots
        .iter()
        .enumerate()
        .filter(|(i, _)| *i < public_roots)
    {
        // Include public component notices, never Microsoft SDK/tool bytes.
        for file in &inputs.identities[index] {
            let name = file
                .path
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if name.contains("license")
                || name.starts_with("copying")
                || name.starts_with("notice")
                || ["ftl.txt", "gplv2.txt"].contains(&name.as_str())
            {
                copy_verified(
                    &root.join(&file.path),
                    &package
                        .join("licenses")
                        .join(index.to_string())
                        .join(&file.path),
                    &checkpoint,
                )?;
            }
        }
    }
    let mut imports = BTreeMap::new();
    for name in ["LodRecomp.exe", "SDL2.dll", "dxcompiler.dll", "dxil.dll"] {
        imports.insert(
            name,
            inspect_image(&executor, &package.join(name), quiesced)?,
        );
    }
    inputs.verify(&preparation.source, &checkpoint)?;
    if !*quiesced {
        return Err(PortcoveError::state(
            "CVLoD builder has no process-tree quiescence proof",
        ));
    }
    let output = inventory(&package, &checkpoint)?;
    commands.extend(executor.commands.into_inner());
    write_new(
        &package.join(RECEIPT),
        &serde_json::to_vec_pretty(&serde_json::json!({
            "format_version":1,"recipe":super::RECIPE,"runtime_origin":"locally-built","source_commit":"cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d",
            "original_sha256":super::ORIGINAL,"original_size":super::ORIGINAL_SIZE,"stored_original_sha256":preparation.source.storage_sha256,
            "auxiliary_archives":archives,"source_manifest_sha256":sources::identity(),"local_toolchain_profile":local_profile::ID,
            "local_toolchain_manifest_sha256":local_profile::identity(),"input_tree_sha256":inputs.identities.iter().map(|v|serde_json::to_vec(v).map(|b|digest(&b))).collect::<std::result::Result<Vec<_>,_>>()?,
            "lifetime_patch":{"before_sha256":PATCH_BEFORE,"after_sha256":PATCH_AFTER},"generation":generation,"commands":commands,"compilation":plans,
            "objects_per_invocation":OBJECT_BATCH_LIMIT,"mixed_objects_per_invocation":2,"helpers_per_invocation":8,"dry_run_before_execution":true,"execution_deadline_seconds":super::RECIPE.execution_budget().as_secs(),
            "elapsed_ms":deadline.elapsed().as_millis(),"recompiler_imports":recompiler_imports,"imports":imports,"runtime_files":output,"builder_quiesced":true,"game_executed_by_builder":false
        }))?,
    )?;
    checkpoint()?;
    let parent = work
        .parent()
        .ok_or_else(|| PortcoveError::state("CVLoD build has no private operation root"))?;
    if work.file_name() != Some(std::ffi::OsStr::new("cartridge-build"))
        || payload != parent.join("payload")
    {
        return Err(PortcoveError::state(
            "CVLoD build output is outside its private operation",
        ));
    }
    crate::path::refuse_symlink_ancestors(payload)?;
    crate::durability::rename_noreplace(payload, &work.join("primary-runtime-input"))?;
    crate::durability::rename_noreplace(&package, payload)?;
    checkpoint()
}

pub(super) fn validate_command_result(
    phase: &str,
    status: &std::process::ExitStatus,
    diagnostic: &crate::ActivityDiagnostic,
) -> Result<()> {
    if phase == GENERATION_PHASE {
        let stderr = diagnostic.stderr.text.replace("\r\n", "\n");
        if status.code() == Some(1)
            && stderr.len() == 3641
            && digest(stderr.as_bytes())
                == "ca2ac998c1594aed9d405425bb6785edf23f701e224874514da319e83d4492c2"
            && stderr.lines().filter(|l| l.starts_with("[Info]")).count() == 9
            && stderr.lines().filter(|l| l.starts_with("[Warn]")).count() == 29
            && stderr.lines().last()
                == Some(
                    "Failed to find written section index of relocatable section: ..overlay_system",
                )
        {
            return Ok(());
        }
        return Err(PortcoveError::verification(
            "CVLoD generation did not produce its exact reviewed ordinary exit-1 overlay diagnostic",
        ));
    }
    if !status.success() {
        return Err(PortcoveError::install("fixed CVLoD build command failed")
            .detail("phase", phase)
            .detail("exit", format!("{status}")));
    }
    Ok(())
}

fn archive_root(work: &Path, archive: BuildArchive) -> PathBuf {
    work.join(archive.name.trim_end_matches(".zip"))
        .join(archive.root)
}

fn patch(project: &Path) -> Result<()> {
    let path = project.join("src/ui/core/ui_context.cpp");
    let bytes = crate::path::read_bounded_regular(&path, 64 * 1024)?;
    if digest(&bytes) != PATCH_BEFORE {
        return Err(PortcoveError::verification(
            "CVLoD lifetime patch preimage differs",
        ));
    }
    let mut text = String::from_utf8(bytes)
        .map_err(|_| PortcoveError::verification("CVLoD patch preimage is not UTF-8"))?;
    let replacements = [
        (
            "    Rml::SharedPtr<Rml::StyleSheetContainer> style_sheet;\n",
            "    Rml::SharedPtr<Rml::StyleSheetContainer> style_sheet;\n    std::unique_ptr<Rml::ElementDocument> dummy_document;\n",
        ),
        (
            "    static Rml::ElementDocument dummy_document{\"\"};\n    bool add_to_dict = true;\n\n    if (document == nullptr) {\n        document = &dummy_document;\n        add_to_dict = false;\n    }\n\n    recompui::ContextId ret;\n    {\n        std::lock_guard lock{ context_state.all_contexts_lock };\n",
            "    const bool add_to_dict = document != nullptr;\n    recompui::ContextId ret;\n    {\n        std::lock_guard lock{ context_state.all_contexts_lock };\n        if (document == nullptr) {\n            if (!context_state.dummy_document) {\n                context_state.dummy_document = std::make_unique<Rml::ElementDocument>(\"\");\n            }\n            document = context_state.dummy_document.get();\n        }\n",
        ),
        (
            "    context_state.all_contexts.reset();\n    context_state.documents_to_contexts.clear();\n",
            "    context_state.all_contexts.reset();\n    context_state.documents_to_contexts.clear();\n    context_state.dummy_document.reset();\n    context_state.style_sheet.reset();\n",
        ),
    ];
    for (before, after) in replacements {
        if text.matches(before).count() != 1 {
            return Err(PortcoveError::verification(
                "CVLoD lifetime patch site is not unique",
            ));
        }
        text = text.replace(before, after);
    }
    if digest(text.as_bytes()) != PATCH_AFTER {
        return Err(PortcoveError::verification(
            "CVLoD lifetime patch result differs",
        ));
    }
    fs::write(path, text)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Llvm {
    bin: Vec<FileIdentity>,
    resources: Vec<FileIdentity>,
}

fn prepare_clang(work: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
    let llvm: Llvm = serde_json::from_str(include_str!("llvm.json"))?;
    let toolchain = archive_root(work, TOOLCHAIN);
    if llvm.bin.len() != 10
        || llvm.resources.len() != 412
        || inventory(&toolchain.join("lib/clang/22"), checkpoint)? != llvm.resources
    {
        return Err(PortcoveError::verification(
            "CVLoD complete LLVM resource closure differs",
        ));
    }
    prepare_clang_binaries(&toolchain, &work.join("clang-cl"), &llvm.bin, checkpoint)
}

fn prepare_clang_binaries(
    toolchain: &Path,
    destination: &Path,
    binaries: &[FileIdentity],
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    fs::create_dir(destination)?;
    for input in binaries {
        let from = toolchain.join(&input.path);
        let (sha, size) =
            crate::adapter::hash_file_bounded_with_checkpoint(&from, input.size, checkpoint)?;
        if sha != input.sha256 || size != input.size {
            return Err(PortcoveError::verification(
                "CVLoD LLVM binary closure differs",
            ));
        }
        let name = Path::new(&input.path)
            .file_name()
            .ok_or_else(|| PortcoveError::verification("CVLoD LLVM tool name is absent"))?;
        let target = if input.path == "bin/clang-22.exe" {
            destination.join("clang-cl.exe")
        } else {
            destination.join(name)
        };
        local_profile::copy_member(&from, &target, input, checkpoint)
            .map_err(|error| error.detail("fixed_llvm_input", &input.path))?;
    }
    Ok(())
}

#[cfg(test)]
mod llvm_copy_tests {
    use super::*;

    #[test]
    fn cvlod_llvm_preparation_copies_large_exact_members_without_runtime_output_limits() {
        let temp = tempfile::tempdir().unwrap();
        let toolchain = temp.path().join("toolchain");
        fs::create_dir_all(toolchain.join("bin")).unwrap();
        let source = toolchain.join("bin/libLLVM-22.dll");
        let size = 64 * 1024 * 1024 + 1;
        fs::File::create(&source).unwrap().set_len(size).unwrap();
        let (sha256, observed_size) =
            crate::adapter::hash_file_bounded_with_checkpoint(&source, size, &|| Ok(())).unwrap();
        assert_eq!(observed_size, size);
        let expected = FileIdentity {
            path: "bin/libLLVM-22.dll".into(),
            size,
            sha256,
        };
        let destination = temp.path().join("clang-cl");
        prepare_clang_binaries(&toolchain, &destination, &[expected.clone()], &|| Ok(())).unwrap();
        assert_eq!(
            crate::adapter::hash_file_bounded_with_checkpoint(
                &destination.join("libLLVM-22.dll"),
                size,
                &|| Ok(())
            )
            .unwrap(),
            (expected.sha256.clone(), size)
        );
        let mut changed = expected;
        changed.sha256 = "0".repeat(64);
        let refused = temp.path().join("changed-clang-cl");
        assert!(prepare_clang_binaries(&toolchain, &refused, &[changed], &|| Ok(())).is_err());
        assert!(!refused.join("libLLVM-22.dll").exists());
    }
}

struct Executor<'a, 'b> {
    session: &'a BuildSession<'b>,
    project: &'a Path,
    local: &'a Path,
    directx: &'a Path,
    sequence: Cell<usize>,
    commands: RefCell<Vec<serde_json::Value>>,
}

impl Executor<'_, '_> {
    fn toolchain(&self) -> PathBuf {
        archive_root(self.session.work, TOOLCHAIN)
    }
    fn cmake(&self) -> PathBuf {
        archive_root(self.session.work, super::CMAKE).join("bin/cmake.exe")
    }
    fn run(
        &self,
        program: &Path,
        arguments: &[String],
        phase: &str,
        cwd: &Path,
        quiesced: &mut bool,
    ) -> Result<BuildCommandOutput> {
        let work = self.session.work;
        let toolchain = self.toolchain();
        let path = std::env::join_paths([
            work.join("clang-cl"),
            self.local.join("vc-tools"),
            self.local.join("sdk-tools"),
            archive_root(work, super::CMAKE).join("bin"),
            toolchain.join("bin"),
            toolchain.join("python"),
            PathBuf::from("C:/Windows/System32"),
            PathBuf::from("C:/Windows"),
        ])
        .map_err(|_| PortcoveError::verification("CVLoD private tool PATH differs"))?;
        let include = std::env::join_paths([
            self.directx.join("include/directx"),
            self.local.join("vc-include"),
            self.local.join("sdk-include/ucrt"),
            self.local.join("sdk-include/shared"),
            self.local.join("sdk-include/um"),
            self.local.join("sdk-include/winrt"),
            self.local.join("sdk-include/cppwinrt"),
        ])
        .map_err(|_| PortcoveError::verification("CVLoD private include path differs"))?;
        let lib = std::env::join_paths([
            self.local.join("vc-lib"),
            self.local.join("sdk-um-lib"),
            self.local.join("sdk-ucrt-lib"),
        ])
        .map_err(|_| PortcoveError::verification("CVLoD private library path differs"))?;
        let result =
            self.session
                .run_cvlod_configured(arguments, program, phase, quiesced, |command| {
                    command.environment.clear();
                    command
                        .current_dir(cwd)
                        .env("SystemRoot", "C:\\Windows")
                        .env("WINDIR", "C:\\Windows")
                        .env("SystemDrive", "C:")
                        .env("ComSpec", "C:\\Windows\\System32\\cmd.exe")
                        .env("PATH", path)
                        .env("INCLUDE", include)
                        .env("LIB", &lib)
                        .env("LIBPATH", lib)
                        .env("HOME", work.join("home"))
                        .env("USERPROFILE", work.join("home"))
                        .env("APPDATA", work.join("appdata"))
                        .env("LOCALAPPDATA", work.join("localappdata"))
                        .env("TEMP", work.join("temp"))
                        .env("TMP", work.join("temp"))
                        .env("PYTHONDONTWRITEBYTECODE", "1")
                        .env("PYTHONNOUSERSITE", "1")
                        .env("PYTHONSAFEPATH", "1")
                        .env("NUMBER_OF_PROCESSORS", "2")
                        .env("CMAKE_BUILD_PARALLEL_LEVEL", "2")
                        .env("MSBUILDDISABLENODEREUSE", "1");
                    Ok(())
                })?;
        let stdout = result.complete_stdout()?;
        let stderr = result
            .stderr
            .as_deref()
            .ok_or_else(|| PortcoveError::verification("CVLoD command has no complete stderr"))?;
        self.commands.borrow_mut().push(serde_json::json!({"phase":phase,"program":program,"arguments":arguments,"working_directory":cwd,
            "exit_code":result.exit_code,"stdout_sha256":digest(stdout.as_bytes()),"stderr_sha256":digest(stderr.as_bytes()),
            "stdout_bytes":stdout.len(),"stderr_bytes":stderr.len(),"process_tree_quiesced":*quiesced}));
        Ok(result)
    }

    fn phase(&self, label: &str) -> String {
        let sequence = self.sequence.get();
        self.sequence.set(sequence + 1);
        format!("install.cartridge.cvlod.{label}.{sequence}")
    }

    fn ninja(
        &self,
        build: &Path,
        targets: &[String],
        dry_run: bool,
        quiesced: &mut bool,
    ) -> Result<BuildCommandOutput> {
        self.run(
            &self.toolchain().join("bin/ninja.exe"),
            &Plan::ninja_arguments(build, targets, dry_run)?,
            &self.phase(if dry_run { "plan" } else { "compile" }),
            self.session.work,
            quiesced,
        )
    }

    fn bounded_build(
        &self,
        plan: &Plan,
        build: &Path,
        targets: &[String],
        depth: usize,
        quiesced: &mut bool,
    ) -> Result<()> {
        if depth > 32 {
            return Err(PortcoveError::verification(
                "CVLoD helper dependency depth exceeds its bound",
            ));
        }
        for _ in 0..2048 {
            plan.require_unchanged(build)?;
            let output = self.ninja(build, targets, true, quiesced)?;
            let actions = plan.actions(output.complete_stdout()?, true)?;
            plan.require_unchanged(build)?;
            if actions.is_empty() {
                return Ok(());
            }
            if actions.bounded() {
                let output = self.ninja(build, targets, false, quiesced)?;
                let observed = plan.actions(output.complete_stdout()?, false)?;
                plan.require_unchanged(build)?;
                actions.require_observed(&observed)?;
                return Ok(());
            }
            let smaller = if let Some(objects) = actions.split_objects() {
                objects.to_vec()
            } else {
                vec![
                    actions
                        .helpers
                        .first()
                        .ok_or_else(|| {
                            PortcoveError::verification("CVLoD helper closure made no progress")
                        })?
                        .target
                        .clone(),
                ]
            };
            if smaller == targets {
                return Err(PortcoveError::verification(
                    "CVLoD helper closure cannot fit its process scope",
                ));
            }
            self.bounded_build(plan, build, &smaller, depth + 1, quiesced)?;
        }
        Err(PortcoveError::verification(
            "CVLoD fixed build exceeded its scheduling bound",
        ))
    }

    fn compile(
        &self,
        build: &Path,
        stage: Stage,
        target: &str,
        quiesced: &mut bool,
    ) -> Result<Plan> {
        let plan = Plan::read(build, stage)?;
        for objects in plan.objects.chunks(OBJECT_BATCH_LIMIT) {
            self.bounded_build(&plan, build, objects, 0, quiesced)?;
        }
        self.bounded_build(&plan, build, &[target.into()], 0, quiesced)?;
        Ok(plan)
    }

    fn configure(
        &self,
        source: &Path,
        build: &Path,
        clang: bool,
        extra: &[String],
        quiesced: &mut bool,
    ) -> Result<Vec<String>> {
        let mut arguments = vec![
            "-S".into(),
            cmake_path(source)?,
            "-B".into(),
            cmake_path(build)?,
            "-G".into(),
            "Ninja".into(),
            format!(
                "-DCMAKE_MAKE_PROGRAM={}",
                cmake_path(&self.toolchain().join("bin/ninja.exe"))?
            ),
            format!(
                "-DCMAKE_LINKER={}",
                cmake_path(&self.local.join("vc-tools/link.exe"))?
            ),
            format!(
                "-DCMAKE_AR={}",
                cmake_path(&self.local.join("vc-tools/lib.exe"))?
            ),
            format!(
                "-DCMAKE_RC_COMPILER={}",
                cmake_path(&self.local.join("sdk-tools/rc.exe"))?
            ),
            format!(
                "-DCMAKE_MT={}",
                cmake_path(&self.local.join("sdk-tools/mt.exe"))?
            ),
            "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL".into(),
            "-DCMAKE_TRY_COMPILE_CONFIGURATION=Release".into(),
            "-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF".into(),
            "-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF".into(),
            "-DCMAKE_FIND_USE_CMAKE_ENVIRONMENT_PATH=OFF".into(),
            "-DCMAKE_FIND_USE_SYSTEM_ENVIRONMENT_PATH=OFF".into(),
            "-DCMAKE_C_COMPILER_LAUNCHER:STRING=".into(),
            "-DCMAKE_CXX_COMPILER_LAUNCHER:STRING=".into(),
            "-DFETCHCONTENT_FULLY_DISCONNECTED=ON".into(),
            "-DFETCHCONTENT_UPDATES_DISCONNECTED=ON".into(),
        ];
        let compiler = if clang {
            self.session.work.join("clang-cl/clang-cl.exe")
        } else {
            self.local.join("vc-tools/cl.exe")
        };
        for variable in ["CMAKE_C_COMPILER", "CMAKE_CXX_COMPILER"] {
            arguments.push(format!("-D{variable}={}", cmake_path(&compiler)?));
        }
        if clang {
            for variable in ["CMAKE_C_COMPILER_ARG1", "CMAKE_CXX_COMPILER_ARG1"] {
                arguments.push(format!("-D{variable}=--no-default-config --config-user-dir= --config-system-dir= --driver-mode=cl --target=x86_64-pc-windows-msvc"));
            }
            let resource = cmake_path(&self.toolchain().join("lib/clang/22"))?;
            arguments.extend(["-DCMAKE_BUILD_TYPE=RelWithDebInfo".into(),
                format!("-DCMAKE_C_FLAGS:STRING=-resource-dir=\"{resource}\" /DWIN32 /D_WINDOWS /FIx86intrin.h"),
                format!("-DCMAKE_CXX_FLAGS:STRING=-resource-dir=\"{resource}\" /DWIN32 /D_WINDOWS /EHsc /FIx86intrin.h")]);
        } else {
            arguments.push("-DCMAKE_BUILD_TYPE=Release".into());
        }
        arguments.extend_from_slice(extra);
        self.run(
            &self.cmake(),
            &arguments,
            &self.phase("configure"),
            self.session.work,
            quiesced,
        )?;
        Ok(arguments)
    }
}
