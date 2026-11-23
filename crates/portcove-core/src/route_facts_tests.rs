use super::*;

fn asset(name: &str) -> AssetIdentity<'_> {
    AssetIdentity {
        asset_id: 7,
        name,
        size: 1,
        sha256: None,
    }
}

fn claim(source: FactSource, role: ArtifactRole, os: TargetOs) -> RoleClaim {
    RoleClaim {
        source,
        role,
        os,
        arch: TargetArch::Unknown,
        players: Vec::new(),
    }
}

fn metadata() -> FactSource {
    FactSource::ReleaseMetadata {
        document: "release.json".into(),
    }
}

fn structured() -> FactSource {
    FactSource::ExactReleaseStructured {
        shape_version: 1,
        archive_sha256: "a".repeat(64),
    }
}

#[test]
fn filename_suggestions_classify_role_host_and_processor() {
    for (name, role, os, arch) in [
        (
            "game-1.0-windows-x64.zip",
            ArtifactRole::DesktopGameRuntime,
            TargetOs::Windows,
            TargetArch::X86_64,
        ),
        (
            "Game-linux-arm64.tar.gz",
            ArtifactRole::DesktopGameRuntime,
            TargetOs::Linux,
            TargetArch::Aarch64,
        ),
        (
            "game-macos-universal.dmg",
            ArtifactRole::DesktopGameRuntime,
            TargetOs::Macos,
            TargetArch::Universal,
        ),
        (
            "game-win32.zip",
            ArtifactRole::DesktopGameRuntime,
            TargetOs::Windows,
            TargetArch::X86,
        ),
        (
            "game-1.0.apk",
            ArtifactRole::MobilePackage,
            TargetOs::Android,
            TargetArch::Unknown,
        ),
        (
            "game-android-arm64.zip",
            ArtifactRole::MobilePackage,
            TargetOs::Android,
            TargetArch::Aarch64,
        ),
        (
            "game-ios.ipa",
            ArtifactRole::MobilePackage,
            TargetOs::Ios,
            TargetArch::Unknown,
        ),
        (
            "game-1.0.ipa",
            ArtifactRole::MobilePackage,
            TargetOs::Ios,
            TargetArch::Unknown,
        ),
        (
            "game-1.0.aab",
            ArtifactRole::MobilePackage,
            TargetOs::Android,
            TargetArch::Unknown,
        ),
        (
            "game-portmaster.zip",
            ArtifactRole::ConsoleOutput,
            TargetOs::Console,
            TargetArch::Unknown,
        ),
        (
            "game-switch.nro",
            ArtifactRole::ConsoleOutput,
            TargetOs::Console,
            TargetArch::Unknown,
        ),
        (
            "game-setup.msi",
            ArtifactRole::Installer,
            TargetOs::Windows,
            TargetArch::Unknown,
        ),
        (
            "game-windows-installer.exe",
            ArtifactRole::Installer,
            TargetOs::Windows,
            TargetArch::Unknown,
        ),
        (
            "level-editor-windows.zip",
            ArtifactRole::DevTool,
            TargetOs::Windows,
            TargetArch::Unknown,
        ),
        (
            "toolchain-linux.tar.gz",
            ArtifactRole::Compiler,
            TargetOs::Linux,
            TargetArch::Unknown,
        ),
        (
            "game-dedicated-server-linux.tar.gz",
            ArtifactRole::DedicatedServer,
            TargetOs::Linux,
            TargetArch::Unknown,
        ),
        (
            "SHA256SUMS.txt",
            ArtifactRole::IntegrityMetadata,
            TargetOs::Unknown,
            TargetArch::Unknown,
        ),
        (
            "game.zip.sig",
            ArtifactRole::IntegrityMetadata,
            TargetOs::Unknown,
            TargetArch::Unknown,
        ),
        (
            "game-windows-x64-symbols.zip",
            ArtifactRole::DebugSymbols,
            TargetOs::Windows,
            TargetArch::X86_64,
        ),
        (
            "game-1.0-src.tar.gz",
            ArtifactRole::SourceArchive,
            TargetOs::Unknown,
            TargetArch::Unknown,
        ),
        (
            "game-lgpl-compliance.zip",
            ArtifactRole::Documentation,
            TargetOs::Unknown,
            TargetArch::Unknown,
        ),
        (
            "README.md",
            ArtifactRole::Unknown,
            TargetOs::Unknown,
            TargetArch::Unknown,
        ),
        (
            "game-windows-linux.zip",
            ArtifactRole::DesktopGameRuntime,
            TargetOs::Unknown,
            TargetArch::Unknown,
        ),
    ] {
        let suggestion = suggest_from_filename(name);
        assert_eq!(
            (suggestion.role, suggestion.os, suggestion.arch),
            (role, os, arch),
            "{name}"
        );
    }
    assert!(suggest_from_filename("game-debug-windows.zip").debug_build);
    assert!(!suggest_from_filename("game-windows.zip").debug_build);
}

#[test]
fn foreign_players_are_named_only_for_another_host() {
    let windows = Platform::WindowsX86_64;
    assert!(suggest_from_filename("game.apk").foreign_player(windows));
    assert!(suggest_from_filename("game.ipa").foreign_player(windows));
    assert!(suggest_from_filename("game-switch.nro").foreign_player(windows));
    assert!(suggest_from_filename("game-linux.tar.gz").foreign_player(windows));
    assert!(!suggest_from_filename("game-windows.zip").foreign_player(windows));
    assert!(!suggest_from_filename("game.zip").foreign_player(windows));
    // Only players: a foreign-named note or checksum keeps the release's
    // ordinary refusal semantics.
    assert!(!suggest_from_filename("android-notes.md").foreign_player(windows));
    assert!(!suggest_from_filename("game-windows-linux.zip").foreign_player(windows));
}

#[test]
fn filename_suggestion_alone_never_authorizes_a_runtime() {
    let suggested = suggest_from_filename("game-windows-x64.zip");
    assert_eq!(suggested.role, ArtifactRole::DesktopGameRuntime);
    let fact = assign_role(asset("game-windows-x64.zip"), &[suggested.claim()]);
    assert_eq!(fact.role, ArtifactRole::DesktopGameRuntime);
    assert!(!fact.source.authorizes());
    assert_eq!(
        runtime_hold(&fact, Platform::WindowsX86_64),
        Some(RouteHold::WrongRole)
    );
}

#[test]
fn sources_are_consulted_in_precedence_order() {
    let name = "game-windows-x64-installer.zip";
    let suggestion = suggest_from_filename(name).claim();
    assert_eq!(suggestion.role, ArtifactRole::Installer);
    // A reviewed declaration outranks a filename that suggests a tool.
    let declared = assign_role(
        asset(name),
        &[
            suggestion.clone(),
            declared_runtime(Platform::WindowsX86_64),
        ],
    );
    assert_eq!(declared.role, ArtifactRole::DesktopGameRuntime);
    assert_eq!(declared.source, FactSource::StableDeclaration);
    assert_eq!(runtime_hold(&declared, Platform::WindowsX86_64), None);
    // Order of the claims does not matter; precedence does.
    let structured_first = assign_role(
        asset(name),
        &[
            suggestion.clone(),
            declared_runtime(Platform::WindowsX86_64),
            claim(
                structured(),
                ArtifactRole::DesktopGameRuntime,
                TargetOs::Windows,
            ),
        ],
    );
    assert_eq!(structured_first.source, structured());
    // A higher source without a definite role leaves the role to a lower one.
    let unknown_metadata = assign_role(
        asset(name),
        &[
            claim(metadata(), ArtifactRole::Unknown, TargetOs::Unknown),
            declared_runtime(Platform::WindowsX86_64),
        ],
    );
    assert_eq!(unknown_metadata.source, FactSource::StableDeclaration);
    assert!(!unknown_metadata.contradictory);
}

#[test]
fn disagreeing_authorizing_sources_hold_only_that_artifact() {
    let contradictory = assign_role(
        asset("game-windows-x64.zip"),
        &[
            claim(metadata(), ArtifactRole::Installer, TargetOs::Windows),
            declared_runtime(Platform::WindowsX86_64),
            suggest_from_filename("game-windows-x64.zip").claim(),
        ],
    );
    assert_eq!(contradictory.role, ArtifactRole::Unknown);
    assert!(contradictory.contradictory);
    assert_eq!(
        runtime_hold(&contradictory, Platform::WindowsX86_64),
        Some(RouteHold::ContradictoryRole)
    );
    // The sibling platform's package has no disagreement and stays offered.
    let sibling = assign_role(
        asset("game-linux-x64.tar.gz"),
        &[
            claim(
                metadata(),
                ArtifactRole::DesktopGameRuntime,
                TargetOs::Linux,
            ),
            declared_runtime(Platform::LinuxX86_64),
        ],
    );
    assert_eq!(runtime_hold(&sibling, Platform::LinuxX86_64), None);
    // A filename that disagrees with an authorizing source is not a contradiction.
    let suggestion_only_disagrees = assign_role(
        asset("game-setup.zip"),
        &[
            suggest_from_filename("game-setup.zip").claim(),
            declared_runtime(Platform::WindowsX86_64),
        ],
    );
    assert!(!suggestion_only_disagrees.contradictory);
}

#[test]
fn an_authorized_non_runtime_role_is_never_the_game_even_when_named_like_one() {
    for role in [
        ArtifactRole::Installer,
        ArtifactRole::Builder,
        ArtifactRole::Compiler,
        ArtifactRole::DevTool,
        ArtifactRole::OriginalGameInput,
        ArtifactRole::MobilePackage,
        ArtifactRole::ConsoleOutput,
        ArtifactRole::Documentation,
    ] {
        let name = "game-windows-x64.zip";
        let alone = assign_role(
            asset(name),
            &[
                claim(metadata(), role, TargetOs::Windows),
                suggest_from_filename(name).claim(),
            ],
        );
        assert_eq!(alone.role, role);
        assert_eq!(
            runtime_hold(&alone, Platform::WindowsX86_64),
            Some(RouteHold::WrongRole),
            "{role:?}"
        );
        let with_selector = assign_role(
            asset(name),
            &[
                claim(metadata(), role, TargetOs::Windows),
                declared_runtime(Platform::WindowsX86_64),
                suggest_from_filename(name).claim(),
            ],
        );
        assert!(
            runtime_hold(&with_selector, Platform::WindowsX86_64).is_some(),
            "{role:?}"
        );
    }
}

#[test]
fn authorized_host_refuses_another_desktop_and_disagreement_is_unknown() {
    let windows_only = assign_role(
        asset("game.zip"),
        &[claim(
            metadata(),
            ArtifactRole::DesktopGameRuntime,
            TargetOs::Windows,
        )],
    );
    assert_eq!(runtime_hold(&windows_only, Platform::WindowsX86_64), None);
    assert_eq!(
        runtime_hold(&windows_only, Platform::LinuxX86_64),
        Some(RouteHold::WrongHost)
    );
    // Authorizing sources that disagree about the host leave it unknown.
    let disagreeing = assign_role(
        asset("game.zip"),
        &[
            claim(
                structured(),
                ArtifactRole::DesktopGameRuntime,
                TargetOs::Windows,
            ),
            declared_runtime(Platform::LinuxX86_64),
        ],
    );
    assert_eq!(disagreeing.os, TargetOs::Unknown);
    // A filename's host never outranks an authorizing one.
    let named_windows = assign_role(
        asset("game-windows.zip"),
        &[
            declared_runtime(Platform::LinuxX86_64),
            suggest_from_filename("game-windows.zip").claim(),
        ],
    );
    assert_eq!(named_windows.os, TargetOs::Linux);
}

#[test]
fn toolchain_programs_beside_the_player_are_not_player_candidates() {
    let programs = [
        "apeescaperecomp.exe",
        "overlay_toolchain/psxrecomp-bios.exe",
        "overlay_toolchain/psxrecomp-game.exe",
        "overlay_toolchain/python/python.exe",
        "overlay_toolchain/python/pythonw.exe",
        "overlay_toolchain/tcc/i386-win32-tcc.exe",
        "overlay_toolchain/tcc/tcc.exe",
        "tools/level-editor.exe",
        "setup.exe",
        "dedicated-server.exe",
        "bin/game",
    ]
    .map(String::from);
    let players = player_candidates(&programs);
    assert_eq!(
        players
            .iter()
            .map(|player| player.path.as_str())
            .collect::<Vec<_>>(),
        ["apeescaperecomp.exe", "bin/game"]
    );
    // A shape whose only programs are tools has no player, so it cannot
    // authorize the archive as a runtime.
    assert!(player_candidates(&["overlay_toolchain/tcc/tcc.exe".to_owned()]).is_empty());
}

#[test]
fn typed_facts_serialize_as_kebab_case_and_reject_unknown_fields() {
    assert_eq!(
        serde_json::to_value(FactSource::FilenameSuggestion { rule_version: 1 }).unwrap(),
        serde_json::json!({"kind": "filename-suggestion", "rule_version": 1})
    );
    assert_eq!(
        serde_json::to_value(FactSource::StableDeclaration).unwrap(),
        serde_json::json!({"kind": "stable-declaration"})
    );
    assert_eq!(
        serde_json::to_value(Coverage::Partial { next_cursor: None }).unwrap(),
        serde_json::json!({"kind": "partial", "next_cursor": null})
    );
    assert_eq!(
        serde_json::to_value(ArtifactRole::DesktopGameRuntime).unwrap(),
        "desktop-game-runtime"
    );
    assert_eq!(serde_json::to_value(TargetArch::X86_64).unwrap(), "x86-64");
    for hold in [
        RouteHold::WrongRole,
        RouteHold::WrongHost,
        RouteHold::ContradictoryRole,
        RouteHold::IncompleteCoverage,
    ] {
        assert_eq!(serde_json::to_value(hold).unwrap(), hold.as_str());
    }
    assert!(
        serde_json::from_value::<FactSource>(
            serde_json::json!({"kind": "filename-suggestion", "rule_version": 1, "extra": 1})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<Coverage>(
            serde_json::json!({"kind": "partial", "next_cursor": null, "cursor": 1})
        )
        .is_err()
    );
}

/// The upstream-managed setup widening admits an extractable package named for
/// its setup or installer only; uninstallers and runtime redistributables stay
/// held, as does any installer for another adapter.
#[test]
fn upstream_setup_widening_admits_only_setup_and_installer_packages() {
    let managed = crate::AdapterKind::UpstreamManagedSetup;
    for name in ["game-windows-setup.zip", "game-installer-win64.zip"] {
        assert_eq!(package_role_hold(managed, name, true, &[]), None, "{name}");
        assert_eq!(
            package_role_hold(managed, name, false, &[]),
            Some(RouteHold::WrongRole),
            "{name}"
        );
        assert_eq!(
            package_role_hold(crate::AdapterKind::NativePortable, name, true, &[]),
            Some(RouteHold::WrongRole),
            "{name}"
        );
    }
    for name in [
        "game-windows-uninstall.zip",
        "game-uninstall-setup.zip",
        "game-vcredist-win64.zip",
        "game-redist-setup.zip",
        "unins000.zip",
    ] {
        assert_eq!(
            package_role_hold(managed, name, true, &[]),
            Some(RouteHold::WrongRole),
            "{name}"
        );
    }
}
