use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use super::*;

const X64: u16 = 0x8664;
const X86: u16 = 0x014c;
const SECTION_ADDRESS: u32 = 0x1000;
const SECTION_OFFSET: usize = 0x200;

/// A minimal PE image whose single section holds the import table and names.
fn pe(machine: u16, imports: &[&str]) -> Vec<u8> {
    let plus = machine != X86;
    let optional_size: usize = if plus { 240 } else { 224 };
    let mut image = vec![0_u8; SECTION_OFFSET];
    image[..2].copy_from_slice(b"MZ");
    image[0x3c..0x40].copy_from_slice(&0x40_u32.to_le_bytes());
    image[0x40..0x44].copy_from_slice(b"PE\0\0");
    let coff = 0x44;
    image[coff..coff + 2].copy_from_slice(&machine.to_le_bytes());
    image[coff + 2..coff + 4].copy_from_slice(&1_u16.to_le_bytes());
    image[coff + 16..coff + 18].copy_from_slice(&(optional_size as u16).to_le_bytes());
    let optional = coff + 20;
    image[optional..optional + 2]
        .copy_from_slice(&(if plus { 0x20b_u16 } else { 0x10b }).to_le_bytes());
    image[optional + 60..optional + 64].copy_from_slice(&(SECTION_OFFSET as u32).to_le_bytes());
    let (count, directories) = if plus { (108, 112) } else { (92, 96) };
    image[optional + count..optional + count + 4].copy_from_slice(&16_u32.to_le_bytes());
    let import = optional + directories + 8;
    image[import..import + 4].copy_from_slice(&SECTION_ADDRESS.to_le_bytes());

    let mut section = vec![0_u8; (imports.len() + 1) * 20];
    for (index, name) in imports.iter().enumerate() {
        let address = SECTION_ADDRESS + section.len() as u32;
        section.extend_from_slice(name.as_bytes());
        section.push(0);
        let descriptor = index * 20;
        section[descriptor + 12..descriptor + 16].copy_from_slice(&address.to_le_bytes());
        // A non-zero thunk keeps the descriptor distinct from the terminator.
        section[descriptor..descriptor + 4].copy_from_slice(&1_u32.to_le_bytes());
    }
    let header = optional + optional_size;
    image[header + 8..header + 12].copy_from_slice(&(section.len() as u32).to_le_bytes());
    image[header + 12..header + 16].copy_from_slice(&SECTION_ADDRESS.to_le_bytes());
    image[header + 16..header + 20].copy_from_slice(&(section.len() as u32).to_le_bytes());
    image[header + 20..header + 24].copy_from_slice(&(SECTION_OFFSET as u32).to_le_bytes());
    image.extend_from_slice(&section);
    image
}

#[derive(Default)]
struct FakeHost {
    not_windows: bool,
    present: BTreeSet<(WindowsArchitecture, &'static str)>,
    absent: BTreeSet<(WindowsArchitecture, &'static str)>,
    dotnet: Option<Vec<String>>,
}

impl RuntimeHostFacts for FakeHost {
    fn is_windows(&self) -> bool {
        !self.not_windows
    }

    fn system_library(&self, architecture: WindowsArchitecture, file: &str) -> Option<bool> {
        if self.not_windows {
            return None;
        }
        let key = |set: &BTreeSet<(WindowsArchitecture, &'static str)>| {
            set.iter()
                .any(|(arch, name)| *arch == architecture && *name == file)
        };
        if key(&self.present) {
            Some(true)
        } else if key(&self.absent) {
            Some(false)
        } else {
            None
        }
    }

    fn dotnet_framework_versions(&self, _: WindowsArchitecture, _: &str) -> Option<Vec<String>> {
        if self.not_windows {
            return None;
        }
        self.dotnet.clone()
    }
}

fn game(files: &[(&str, Vec<u8>)]) -> tempfile::TempDir {
    let folder = tempfile::tempdir().unwrap();
    for (name, bytes) in files {
        fs::write(folder.path().join(name), bytes).unwrap();
    }
    folder
}

fn imports(path: &Path) -> (Option<WindowsArchitecture>, Vec<String>) {
    match read_program(path).unwrap() {
        ProgramImage::Windows(image) => (image.architecture, image.imports.into_iter().collect()),
        ProgramImage::NotWindows => panic!("expected a Windows program"),
    }
}

#[test]
fn reads_static_imports_from_pe32_and_pe32_plus_programs() {
    let folder = game(&[
        (
            "x64.exe",
            pe(X64, &["KERNEL32.dll", "VCRUNTIME140.dll", "d3dx9_43.dll"]),
        ),
        ("x86.exe", pe(X86, &["msvcr100.dll"])),
        ("arm.exe", pe(0xaa64, &[])),
        ("other.exe", pe(0x01c4, &["kernel32.dll"])),
    ]);
    assert_eq!(
        imports(&folder.path().join("x64.exe")),
        (
            Some(WindowsArchitecture::X64),
            vec![
                "d3dx9_43.dll".into(),
                "kernel32.dll".into(),
                "vcruntime140.dll".into()
            ]
        )
    );
    assert_eq!(
        imports(&folder.path().join("x86.exe")),
        (Some(WindowsArchitecture::X86), vec!["msvcr100.dll".into()])
    );
    assert_eq!(
        imports(&folder.path().join("arm.exe")),
        (Some(WindowsArchitecture::Arm64), Vec::new())
    );
    assert_eq!(imports(&folder.path().join("other.exe")).0, None);
}

#[test]
fn other_programs_are_not_windows_programs() {
    let mut dos = vec![0_u8; 128];
    dos[..2].copy_from_slice(b"MZ");
    dos[0x3c] = 0x40;
    let folder = game(&[
        ("game", b"\x7fELF\x02\x01\x01".to_vec()),
        ("empty", Vec::new()),
        ("dos.exe", dos),
    ]);
    let host = FakeHost::default();
    for name in ["game", "empty", "dos.exe"] {
        let report = assess_program_with(&folder.path().join(name), None, &host);
        assert_eq!(
            report.inspection,
            RuntimeInspection::NotWindowsProgram,
            "{name}"
        );
        assert!(report.requirements.is_empty());
    }
}

#[test]
fn malformed_programs_are_unreadable_within_bounds() {
    let valid = pe(X64, &["vcruntime140.dll"]);
    let mut far_header = valid.clone();
    far_header[0x3c..0x40].copy_from_slice(&(PE_HEADER_OFFSET_LIMIT + 1).to_le_bytes());
    let mut past_end = valid.clone();
    past_end[0x3c..0x40].copy_from_slice(&0x10_0000_u32.to_le_bytes());
    let truncated = valid[..SECTION_OFFSET + 10].to_vec();
    let mut unterminated = valid.clone();
    unterminated.pop();
    let mut sections = valid.clone();
    sections[0x46..0x48].copy_from_slice(&(SECTION_LIMIT + 1).to_le_bytes());
    let mut magic = valid.clone();
    magic[0x58..0x5a].copy_from_slice(&0x0107_u16.to_le_bytes());
    let mut outside = valid.clone();
    outside[SECTION_OFFSET + 12..SECTION_OFFSET + 16].copy_from_slice(&0x9000_u32.to_le_bytes());
    let mut invalid_name = valid.clone();
    let name = SECTION_OFFSET + 40;
    invalid_name[name..name + 3].copy_from_slice(b"..\\");
    let long_name = pe(X64, &[&"a".repeat(IMPORT_NAME_LIMIT + 1)]);
    let names = (0..IMPORT_DESCRIPTOR_LIMIT)
        .map(|index| format!("d{index}.dll"))
        .collect::<Vec<_>>();
    let too_many = pe(X64, &names.iter().map(String::as_str).collect::<Vec<_>>());

    let host = FakeHost::default();
    for (label, bytes) in [
        ("far header", far_header),
        ("header past end", past_end),
        ("truncated imports", truncated),
        ("section count", sections),
        ("optional magic", magic),
        ("name outside sections", outside),
        ("too many imports", too_many),
    ] {
        let folder = game(&[("game.exe", bytes)]);
        let report = assess_program_with(&folder.path().join("game.exe"), None, &host);
        assert_eq!(report.inspection, RuntimeInspection::Unreadable, "{label}");
        assert!(report.requirements.is_empty(), "{label}");
    }
    for (label, bytes) in [
        ("unterminated name", unterminated),
        ("path-like name", invalid_name),
        ("long name", long_name),
    ] {
        let folder = game(&[("game.exe", bytes)]);
        let report = assess_program_with(&folder.path().join("game.exe"), None, &host);
        assert_eq!(report.inspection, RuntimeInspection::Partial, "{label}");
        assert!(report.requirements.is_empty(), "{label}");
    }
    let missing = tempfile::tempdir().unwrap();
    assert_eq!(
        assess_program_with(&missing.path().join("absent.exe"), None, &host).inspection,
        RuntimeInspection::Unreadable
    );
}

#[cfg(unix)]
#[test]
fn symlinked_programs_and_dlls_are_not_followed_but_satisfy_imports() {
    let folder = game(&[
        ("real.exe", pe(X64, &["vcruntime140.dll"])),
        ("real.dll", pe(X64, &["d3dx9_43.dll"])),
        ("runtime.dll", pe(X64, &["kernel32.dll"])),
        ("game.exe", pe(X64, &["linked.dll", "vcruntime140.dll"])),
    ]);
    let link = |target: &str, name: &str| {
        std::os::unix::fs::symlink(folder.path().join(target), folder.path().join(name)).unwrap()
    };
    link("real.exe", "link.exe");
    link("real.dll", "linked.dll");
    // A mod manager may link a shipped runtime DLL into the program folder.
    link("runtime.dll", "vcruntime140.dll");
    let host = FakeHost {
        absent: [
            (WindowsArchitecture::X64, "vcruntime140.dll"),
            (WindowsArchitecture::X64, "d3dx9_43.dll"),
        ]
        .into(),
        ..FakeHost::default()
    };
    assert_eq!(
        assess_program_with(&folder.path().join("link.exe"), None, &host).inspection,
        RuntimeInspection::Unreadable
    );
    // Linked files satisfy their imports but are never read, so nothing is
    // missing and the inspection is partial.
    let report = assess_program_with(&folder.path().join("game.exe"), None, &host);
    assert_eq!(report.inspection, RuntimeInspection::Partial);
    assert!(report.requirements.is_empty(), "{report:?}");
}

#[test]
fn unusable_import_names_are_skipped_and_the_rest_still_count() {
    let folder = game(&[("game.exe", pe(X64, &["bad/name.dll", "vcruntime140.dll"]))]);
    let host = FakeHost {
        absent: [(WindowsArchitecture::X64, "vcruntime140.dll")].into(),
        ..FakeHost::default()
    };
    let report = assess_program_with(&folder.path().join("game.exe"), None, &host);
    assert_eq!(report.inspection, RuntimeInspection::Partial);
    assert_eq!(report.requirements[0].presence, RuntimePresence::Missing);
}

#[test]
fn runtime_dlls_in_a_possible_working_directory_are_not_missing() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    fs::write(
        bin.join("game.exe"),
        pe(X64, &["vcruntime140.dll", "d3dx9_43.dll"]),
    )
    .unwrap();
    fs::write(root.path().join("vcruntime140.dll"), b"").unwrap();
    let host = FakeHost {
        absent: [
            (WindowsArchitecture::X64, "vcruntime140.dll"),
            (WindowsArchitecture::X64, "d3dx9_43.dll"),
        ]
        .into(),
        ..FakeHost::default()
    };
    let program = bin.join("game.exe");
    let report = assess_program_with(&program, Some(root.path()), &host);
    assert_eq!(report.inspection, RuntimeInspection::Partial);
    let [directx] = report.requirements.as_slice() else {
        panic!("unexpected requirements: {report:?}");
    };
    assert_eq!(directx.runtime, WindowsRuntime::DirectxJune2010);
    assert_eq!(directx.presence, RuntimePresence::Missing);
    // Folders outside the installation are never searched.
    let report = assess_program_with(&program, Some(&bin), &host);
    assert_eq!(report.requirements.len(), 2);
}

#[test]
fn classifies_only_installer_owned_runtime_files() {
    for (file, runtime) in [
        (
            "vcruntime140.dll",
            Some(WindowsRuntime::VisualCpp2015OrLater),
        ),
        (
            "vcruntime140_1.dll",
            Some(WindowsRuntime::VisualCpp2015OrLater),
        ),
        (
            "msvcp140_atomic_wait.dll",
            Some(WindowsRuntime::VisualCpp2015OrLater),
        ),
        ("mfc140u.dll", Some(WindowsRuntime::VisualCpp2015OrLater)),
        ("msvcp120.dll", Some(WindowsRuntime::VisualCpp2013)),
        ("mfcm110u.dll", Some(WindowsRuntime::VisualCpp2012)),
        ("msvcr100.dll", Some(WindowsRuntime::VisualCpp2010)),
        ("d3dx9_43.dll", Some(WindowsRuntime::DirectxJune2010)),
        ("d3dx9_24.dll", Some(WindowsRuntime::DirectxJune2010)),
        ("d3dx10.dll", Some(WindowsRuntime::DirectxJune2010)),
        ("d3dx11_43.dll", Some(WindowsRuntime::DirectxJune2010)),
        ("d3dcompiler_43.dll", Some(WindowsRuntime::DirectxJune2010)),
        ("xinput1_3.dll", Some(WindowsRuntime::DirectxJune2010)),
        ("xaudio2_7.dll", Some(WindowsRuntime::DirectxJune2010)),
        ("x3daudio1_7.dll", Some(WindowsRuntime::DirectxJune2010)),
        ("xapofx1_5.dll", Some(WindowsRuntime::DirectxJune2010)),
        // Debug builds, in-box Windows components and side-by-side runtimes.
        ("vcruntime140d.dll", None),
        ("msvcp140d.dll", None),
        ("msvcr90.dll", None),
        ("ucrtbase.dll", None),
        ("api-ms-win-crt-runtime-l1-1-0.dll", None),
        ("d3dcompiler_47.dll", None),
        ("d3dx9_23.dll", None),
        ("d3dx9_043.dll", None),
        ("xinput1_4.dll", None),
        ("xinput9_1_0.dll", None),
        ("xaudio2_8.dll", None),
        ("d3d9.dll", None),
        ("kernel32.dll", None),
        ("vcruntime140", None),
    ] {
        assert_eq!(classify(file), runtime, "{file}");
    }
}

#[test]
fn presence_is_missing_only_when_the_host_reports_absence() {
    let folder = game(&[(
        "game.exe",
        pe(
            X64,
            &[
                "kernel32.dll",
                "vcruntime140.dll",
                "msvcp140.dll",
                "d3dx9_43.dll",
                "xinput1_3.dll",
            ],
        ),
    )]);
    let host = FakeHost {
        present: [
            (WindowsArchitecture::X64, "vcruntime140.dll"),
            (WindowsArchitecture::X64, "msvcp140.dll"),
            (WindowsArchitecture::X64, "xinput1_3.dll"),
        ]
        .into(),
        absent: [(WindowsArchitecture::X64, "d3dx9_43.dll")].into(),
        ..FakeHost::default()
    };
    let report = assess_program_with(&folder.path().join("game.exe"), None, &host);
    assert_eq!(report.inspection, RuntimeInspection::Complete);
    assert_eq!(report.host, RuntimeHostCheck::Checked);
    let [visual_cpp, directx] = report.requirements.as_slice() else {
        panic!("unexpected requirements: {report:?}");
    };
    assert_eq!(visual_cpp.runtime, WindowsRuntime::VisualCpp2015OrLater);
    assert_eq!(visual_cpp.presence, RuntimePresence::Present);
    assert_eq!(visual_cpp.files, ["msvcp140.dll", "vcruntime140.dll"]);
    assert!(visual_cpp.missing_files.is_empty());
    assert_eq!(visual_cpp.download_page, VISUAL_CPP_DOWNLOAD_PAGE);
    assert_eq!(directx.runtime, WindowsRuntime::DirectxJune2010);
    assert_eq!(directx.architecture, Some(WindowsArchitecture::X64));
    assert_eq!(directx.presence, RuntimePresence::Missing);
    assert_eq!(directx.missing_files, ["d3dx9_43.dll"]);
    assert_eq!(directx.download_page, DIRECTX_DOWNLOAD_PAGE);
    assert_eq!(report.missing().count(), 1);

    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["requirements"][1]["runtime"], "directx_june_2010");
    assert_eq!(
        json["requirements"][0]["runtime"],
        "visual_cpp_2015_or_later"
    );
    assert_eq!(json["requirements"][1]["presence"], "missing");

    // An unanswered file keeps the runtime unknown, never present or missing.
    let partial_host = FakeHost {
        present: [(WindowsArchitecture::X64, "vcruntime140.dll")].into(),
        ..FakeHost::default()
    };
    let report = assess_program_with(&folder.path().join("game.exe"), None, &partial_host);
    assert!(
        report
            .requirements
            .iter()
            .all(|requirement| requirement.presence == RuntimePresence::Unknown)
    );
}

#[test]
fn a_non_windows_host_or_unassessed_architecture_stays_unknown() {
    let folder = game(&[
        ("game.exe", pe(X64, &["vcruntime140.dll"])),
        ("other.exe", pe(0x01c4, &["vcruntime140.dll"])),
    ]);
    let host = FakeHost {
        not_windows: true,
        ..FakeHost::default()
    };
    let report = assess_program_with(&folder.path().join("game.exe"), None, &host);
    assert_eq!(report.host, RuntimeHostCheck::NotWindows);
    assert_eq!(report.requirements[0].presence, RuntimePresence::Unknown);
    assert_eq!(report.missing().count(), 0);

    let windows = FakeHost {
        absent: [(WindowsArchitecture::X64, "vcruntime140.dll")].into(),
        ..FakeHost::default()
    };
    let report = assess_program_with(&folder.path().join("other.exe"), None, &windows);
    assert_eq!(report.requirements[0].architecture, None);
    assert_eq!(report.requirements[0].presence, RuntimePresence::Unknown);
}

#[test]
fn shipped_dlls_satisfy_imports_and_their_own_imports_are_followed() {
    let folder = game(&[
        (
            "game.exe",
            pe(
                X86,
                &["VCRUNTIME140.dll", "engine.dll", "missing-plugin.dll"],
            ),
        ),
        ("vcruntime140.dll", pe(X86, &["kernel32.dll"])),
        ("Engine.DLL", pe(X86, &["audio.dll", "engine.dll"])),
        ("audio.dll", pe(X86, &["xaudio2_7.dll", "game.exe"])),
    ]);
    let host = FakeHost {
        absent: [
            (WindowsArchitecture::X86, "vcruntime140.dll"),
            (WindowsArchitecture::X86, "xaudio2_7.dll"),
        ]
        .into(),
        ..FakeHost::default()
    };
    let report = assess_program_with(&folder.path().join("game.exe"), None, &host);
    assert_eq!(report.inspection, RuntimeInspection::Complete);
    let [directx] = report.requirements.as_slice() else {
        panic!("unexpected requirements: {report:?}");
    };
    assert_eq!(directx.runtime, WindowsRuntime::DirectxJune2010);
    assert_eq!(directx.architecture, Some(WindowsArchitecture::X86));
    assert_eq!(directx.presence, RuntimePresence::Missing);
    assert_eq!(directx.files, ["xaudio2_7.dll"]);
}

#[test]
fn unreadable_shipped_dlls_make_the_inspection_partial() {
    let folder = game(&[
        ("game.exe", pe(X64, &["engine.dll", "vcruntime140.dll"])),
        ("engine.dll", b"MZ".to_vec()),
    ]);
    let host = FakeHost {
        absent: [(WindowsArchitecture::X64, "vcruntime140.dll")].into(),
        ..FakeHost::default()
    };
    let report = assess_program_with(&folder.path().join("game.exe"), None, &host);
    assert_eq!(report.inspection, RuntimeInspection::Partial);
    // The folder listing was complete, so the absent runtime is still missing.
    assert_eq!(report.requirements[0].presence, RuntimePresence::Missing);
}

#[test]
fn an_incomplete_folder_listing_cannot_establish_a_missing_runtime() {
    let folder = game(&[("game.exe", pe(X64, &["vcruntime140.dll"]))]);
    for index in 0..FOLDER_ENTRY_LIMIT {
        fs::write(folder.path().join(format!("{index}.txt")), b"").unwrap();
    }
    let host = FakeHost {
        absent: [(WindowsArchitecture::X64, "vcruntime140.dll")].into(),
        ..FakeHost::default()
    };
    let report = assess_program_with(&folder.path().join("game.exe"), None, &host);
    assert_eq!(report.inspection, RuntimeInspection::Partial);
    assert_eq!(report.requirements[0].presence, RuntimePresence::Unknown);
    assert!(report.requirements[0].missing_files.is_empty());
}

#[test]
fn the_shipped_dll_limit_is_bounded() {
    let names = (0..PROGRAM_LIMIT + 4)
        .map(|index| format!("part{index}.dll"))
        .collect::<Vec<_>>();
    let mut files = vec![(
        "game.exe".to_owned(),
        pe(X64, &names.iter().map(String::as_str).collect::<Vec<_>>()),
    )];
    files.extend(
        names
            .iter()
            .map(|name| (name.clone(), pe(X64, &["kernel32.dll"]))),
    );
    let folder = tempfile::tempdir().unwrap();
    for (name, bytes) in &files {
        fs::write(folder.path().join(name), bytes).unwrap();
    }
    let report = assess_program_with(&folder.path().join("game.exe"), None, &FakeHost::default());
    assert_eq!(report.inspection, RuntimeInspection::Partial);
}

fn runtime_config(json: &str) -> tempfile::TempDir {
    game(&[
        ("Game.exe", pe(X64, &["kernel32.dll"])),
        ("game.runtimeconfig.json", json.as_bytes().to_vec()),
    ])
}

#[test]
fn framework_dependent_programs_need_their_dotnet_frameworks() {
    let folder = runtime_config(
        r#"{"runtimeOptions":{"tfm":"net8.0","frameworks":[
            {"name":"Microsoft.NETCore.App","version":"8.0.0"},
            {"name":"Microsoft.WindowsDesktop.App","version":"8.0.0"}]}}"#,
    );
    let program = folder.path().join("Game.exe");
    let installed = |versions: &[&str]| FakeHost {
        dotnet: Some(
            versions
                .iter()
                .map(|version| (*version).to_owned())
                .collect(),
        ),
        ..FakeHost::default()
    };
    let report = assess_program_with(&program, None, &installed(&[]));
    assert_eq!(report.inspection, RuntimeInspection::Complete);
    assert_eq!(report.requirements.len(), 2);
    let desktop = &report.requirements[1];
    assert_eq!(desktop.runtime, WindowsRuntime::Dotnet);
    assert_eq!(desktop.presence, RuntimePresence::Missing);
    assert_eq!(
        desktop.framework.as_ref().unwrap().name,
        "Microsoft.WindowsDesktop.App"
    );
    assert_eq!(
        desktop.download_page,
        "https://dotnet.microsoft.com/download/dotnet/8.0"
    );
    assert!(is_official_download_page(&desktop.download_page));

    let report = assess_program_with(
        &program,
        None,
        &installed(&["6.0.30", "8.0.11", "9.0.0-rc.1"]),
    );
    assert!(
        report
            .requirements
            .iter()
            .all(|requirement| requirement.presence == RuntimePresence::Present)
    );
    let report = assess_program_with(&program, None, &FakeHost::default());
    assert!(
        report
            .requirements
            .iter()
            .all(|requirement| requirement.presence == RuntimePresence::Unknown)
    );
}

#[test]
fn unevaluated_roll_forward_settings_stay_unknown() {
    let host = FakeHost {
        dotnet: Some(Vec::new()),
        ..FakeHost::default()
    };
    for json in [
        r#"{"runtimeOptions":{"rollForwardOnNoCandidateFx":2,"framework":{"name":"Microsoft.NETCore.App","version":"8.0.0"}}}"#,
        r#"{"runtimeOptions":{"applyPatches":false,"framework":{"name":"Microsoft.NETCore.App","version":"8.0.0"}}}"#,
        r#"{"runtimeOptions":{"framework":{"name":"Microsoft.NETCore.App","version":"8.0.0","rollForward":"Major"}}}"#,
        r#"{"runtimeOptions":{"framework":{"name":"Microsoft.NETCore.App","version":"8.0.0","applyPatches":true}}}"#,
    ] {
        let folder = runtime_config(json);
        let report = assess_program_with(&folder.path().join("Game.exe"), None, &host);
        assert_eq!(report.requirements.len(), 1, "{json}");
        assert_eq!(
            report.requirements[0].presence,
            RuntimePresence::Unknown,
            "{json}"
        );
    }
}

#[test]
fn self_contained_and_invalid_runtime_configurations() {
    let host = FakeHost {
        dotnet: Some(Vec::new()),
        ..FakeHost::default()
    };
    let contained = runtime_config(
        r#"{"runtimeOptions":{"includedFrameworks":[{"name":"Microsoft.NETCore.App","version":"8.0.0"}]}}"#,
    );
    let report = assess_program_with(&contained.path().join("Game.exe"), None, &host);
    assert_eq!(report.inspection, RuntimeInspection::Complete);
    assert!(report.requirements.is_empty());

    for json in [
        "not json",
        r#"{"runtimeOptions":{"framework":{"name":"../escape","version":"8.0.0"}}}"#,
        r#"{"runtimeOptions":{"framework":{"name":"Microsoft..App","version":"8.0.0"}}}"#,
    ] {
        let invalid = runtime_config(json);
        let report = assess_program_with(&invalid.path().join("Game.exe"), None, &host);
        assert_eq!(report.inspection, RuntimeInspection::Partial, "{json}");
        assert!(report.requirements.is_empty(), "{json}");
    }
}

#[test]
fn roll_forward_policies_follow_the_dotnet_host() {
    let installed =
        |versions: &[&str]| versions.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>();
    let cases = [
        ("8.0.4", None, &["8.0.3"][..], Some(false)),
        ("8.0.4", None, &["8.0.10"][..], Some(true)),
        ("8.0.4", None, &["8.1.0"][..], Some(true)),
        ("8.0.4", None, &["9.0.0"][..], Some(false)),
        ("8.0.4", Some("LatestMinor"), &["8.2.0"][..], Some(true)),
        ("8.0.4", Some("LatestPatch"), &["8.1.0"][..], Some(false)),
        ("8.0.4", Some("LatestPatch"), &["8.0.9"][..], Some(true)),
        ("8.0.4", Some("Major"), &["9.0.0"][..], Some(true)),
        ("8.0.4", Some("LatestMajor"), &["7.0.20"][..], Some(false)),
        ("8.0.4", Some("Disable"), &["8.0.5"][..], Some(false)),
        ("8.0.4", Some("Disable"), &["8.0.4"][..], Some(true)),
        ("8.0.4", Some("Sideways"), &["8.0.4"][..], None),
        ("8.0.0-preview.1", None, &["8.0.0"][..], None),
        ("8.0.4", None, &["8.0.5-rc.1", "garbage"][..], Some(false)),
    ];
    for (required, policy, versions, expected) in cases {
        assert_eq!(
            framework_satisfied(required, policy, &installed(versions)),
            expected,
            "{required} {policy:?} {versions:?}"
        );
    }
}

#[test]
fn only_official_runtime_download_pages_are_recognized() {
    for url in [
        VISUAL_CPP_DOWNLOAD_PAGE,
        DIRECTX_DOWNLOAD_PAGE,
        "https://dotnet.microsoft.com/download/dotnet",
        "https://dotnet.microsoft.com/download/dotnet/8.0",
        "https://dotnet.microsoft.com/download/dotnet/10.0",
    ] {
        assert!(is_official_download_page(url), "{url}");
    }
    for url in [
        "https://dotnet.microsoft.com/download/dotnet/8",
        "https://dotnet.microsoft.com/download/dotnet/8.0/",
        "https://dotnet.microsoft.com/download/dotnet/8.0.1",
        "https://dotnet.microsoft.com/download/dotnet/8.x",
        "https://dotnet.microsoft.com/download/dotnet/1234.0",
        "https://dotnet.microsoft.com/download/dotnet8.0",
        "https://example.com/download/details.aspx?id=35",
        "http://www.microsoft.com/download/details.aspx?id=35",
        "https://www.microsoft.com/download/details.aspx?id=8109",
    ] {
        assert!(!is_official_download_page(url), "{url}");
    }
    assert_eq!(dotnet_download_page("weird"), DOTNET_DOWNLOAD_PAGE);
}

const PORT: &str = "cvlod-recomp";

fn library_with_install() -> (tempfile::TempDir, crate::Library) {
    let temporary = tempfile::tempdir().unwrap();
    let library = crate::Library::open(temporary.path().join("library")).unwrap();
    let destination = library.versions_dir().join(PORT).join("1");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("game.exe"), pe(X64, &["vcruntime140.dll"])).unwrap();
    let install = crate::InstallRecord {
        id: "current".into(),
        port_id: PORT.into(),
        version: "1".into(),
        path: destination,
        channel: crate::ReleaseChannel::Stable,
        installed_at: 1,
        verified: true,
        staged: false,
        artifact: Default::default(),
        runtime: None,
        manifest_sha256: "0".repeat(64),
        selected_executable: "game.exe".into(),
    };
    library.register_install(&install, true).unwrap();
    (temporary, library)
}

#[test]
fn reports_follow_only_the_current_installation() {
    let (_temporary, library) = library_with_install();
    let current = library
        .installation_runtime_prerequisites(PORT, "current")
        .unwrap()
        .unwrap();
    assert_eq!(current.inspection, RuntimeInspection::Complete);
    assert_eq!(
        current.requirements[0].runtime,
        WindowsRuntime::VisualCpp2015OrLater
    );
    assert_eq!(library.runtime_prerequisites(PORT).unwrap(), Some(current));
    assert_eq!(
        library
            .installation_runtime_prerequisites(PORT, "replaced")
            .unwrap(),
        None
    );
    assert_eq!(library.runtime_prerequisites("other-port").unwrap(), None);
}

#[test]
fn launch_views_carry_reports_only_for_missing_dll_exits_of_the_current_installation() {
    let (_temporary, library) = library_with_install();
    let view = |install_id: &str, exit_code: u32| {
        let record: crate::LaunchSessionRecord = serde_json::from_value(serde_json::json!({
            "id": "r", "port_id": PORT, "install_id": install_id, "install_root": "/i",
            "supervisor_pid": 1, "phase": "running", "started_at": 0, "updated_at": 1,
            "outcome": "failed", "exit_code": exit_code as i32,
        }))
        .unwrap();
        crate::LaunchSessionView::new(record).with_runtime_prerequisites(&library)
    };
    for status in [0xC000_0135_u32, 0xC000_0142] {
        assert!(
            view("current", status).runtime_prerequisites.is_some(),
            "{status:#x}"
        );
    }
    assert!(view("current", 0xC000_0005).runtime_prerequisites.is_none());
    assert!(view("current", 3).runtime_prerequisites.is_none());
    assert!(
        view("replaced", 0xC000_0135)
            .runtime_prerequisites
            .is_none()
    );
}
