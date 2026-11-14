//! Closed runtime behavior is authored; changing release facts come from the
//! provider. Offline checks bind the hashed manifest to its registered artifact.
use crate::{ArtifactIdentity, Platform, PortDefinition, PortcoveError, Result};

pub(crate) const EXACT_EXCLUSION_STAGED_CAPABILITY: u32 = 34;

pub(crate) fn has_exact_exclusions(port: &PortDefinition) -> bool {
    port.managed_acquisition_hold
        .as_ref()
        .is_some_and(|hold| !hold.excluded_artifacts.is_empty())
}

pub(crate) fn validate_exact_exclusions(port: &PortDefinition) -> Result<()> {
    let Some(hold) = port
        .managed_acquisition_hold
        .as_ref()
        .filter(|_| has_exact_exclusions(port))
    else {
        return Ok(());
    };
    if port.adapter != crate::AdapterKind::StagedSourcePortable
        || port.release.provider != crate::ReleaseSource::Github
    {
        return Err(PortcoveError::verification(format!(
            "{} requires a GitHub staged-source release for exact exclusions",
            port.id
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for artifact in hold
        .excluded_artifacts
        .iter()
        .chain(&hold.reviewed_artifacts)
    {
        if artifact.version.trim().is_empty()
            || artifact.sha256.len() != 64
            || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !seen.insert((&artifact.version, artifact.sha256.to_ascii_lowercase()))
        {
            return Err(PortcoveError::verification(format!(
                "{} has an invalid or duplicate exact hold artifact",
                port.id
            )));
        }
    }
    Ok(())
}

/// Catalog-owned containment for a managed route whose upstream release still
/// matches its selector but changed reviewed behavior. Ports absent from the
/// catalog have no hold; their retained definitions keep their own checks.
pub(crate) fn acquisition_hold<'a>(
    catalog: &'a crate::Catalog,
    port_id: &str,
) -> Option<&'a crate::ManagedAcquisitionHold> {
    catalog
        .port(port_id)
        .ok()?
        .managed_acquisition_hold
        .as_ref()
}

pub(crate) fn acquisition_hold_reason<'a>(
    catalog: &'a crate::Catalog,
    port_id: &str,
) -> Option<&'a str> {
    acquisition_hold(catalog, port_id)
        .filter(|hold| hold.excluded_artifacts.is_empty())
        .map(|hold| hold.reason.as_str())
}

/// The routes a catalog acquisition hold withdraws: fresh managed acquisition,
/// whether a first install or an update. Shared by a library's action table and
/// library-free target inspection so both report the same offering.
pub(crate) fn hold_withdraws(action: crate::PortAction) -> bool {
    matches!(
        action,
        crate::PortAction::Install | crate::PortAction::Update
    )
}

pub(crate) fn require_acquisition_available(catalog: &crate::Catalog, port_id: &str) -> Result<()> {
    match acquisition_hold_reason(catalog, port_id) {
        Some(reason) => Err(PortcoveError::unsupported(reason)),
        None => Ok(()),
    }
}

impl crate::ManagedAcquisitionHold {
    pub(crate) fn excludes(&self, version: &str, sha256: &str) -> bool {
        self.excluded_artifacts
            .iter()
            .any(|artifact| artifact.matches(version, sha256))
    }

    pub(crate) fn reviewed(&self, version: &str, sha256: &str) -> bool {
        self.reviewed_artifacts
            .iter()
            .any(|artifact| artifact.matches(version, sha256))
    }
}

impl crate::ReviewedHoldArtifact {
    fn matches(&self, version: &str, sha256: &str) -> bool {
        self.version == version && self.sha256.eq_ignore_ascii_case(sha256)
    }
}

pub(crate) fn require_artifact_available(
    catalog: &crate::Catalog,
    port_id: &str,
    version: &str,
    sha256: &str,
) -> Result<()> {
    if let Some(hold) = acquisition_hold(catalog, port_id)
        && hold.excludes(version, sha256)
    {
        return Err(PortcoveError::unsupported(hold.reason.clone()));
    }
    Ok(())
}

pub(crate) fn require_managed_activation_available(
    catalog: &crate::Catalog,
    install: &crate::InstallRecord,
) -> Result<()> {
    let Some(hold) = acquisition_hold(catalog, &install.port_id) else {
        return Ok(());
    };
    let version = &install.version;
    let sha256 = &install.artifact.sha256;
    if !hold.excludes(version, sha256)
        && (!hold.excluded_artifacts.is_empty() || hold.reviewed(version, sha256))
    {
        return Ok(());
    }
    Err(PortcoveError::unsupported(hold.activation_reason.clone()))
}

pub(crate) fn requires_provider_resolution(port: &PortDefinition) -> bool {
    port.release.provider == crate::ReleaseSource::Github
        && (port.managed_initialization
            == Some(crate::ManagedInitialization::TfeDarkForcesPortableV1)
            || port.managed_shared_preferences
                == Some(crate::PreparedSharedPreferencesContract::GbRecompiledWindowsV1)
            || port.runtime_data_policy
                == Some(crate::RuntimeDataPolicy::VersionLocalRetroAchievementsV1)
            || port.archive_data_compatibility_v1.is_some())
}

pub(crate) fn requires_provider_resolution_on(port: &PortDefinition, platform: Platform) -> bool {
    port.release.requires_tar_xz(platform)
        || crate::release::native_appimage(port, platform).is_some()
        || requires_provider_resolution(port)
}

pub(crate) fn require_native_appimage_artifact(
    port: &PortDefinition,
    platform: Platform,
    asset_name: &str,
) -> Result<()> {
    if !crate::native_temp::has_sibling_platforms(port)
        && !matches!(
            port.external_profile_policy,
            Some(
                crate::ExternalProfilePolicy::RecompAppimageV1
                    | crate::ExternalProfilePolicy::VkquakeLinuxV1
                    | crate::ExternalProfilePolicy::CorsixthLinuxV1
                    | crate::ExternalProfilePolicy::OpenlocoUnixV1
            )
        )
    {
        return Ok(());
    }
    let appimage = asset_name.to_ascii_lowercase().ends_with(".appimage");
    let expected = crate::release::native_appimage(port, platform);
    if (appimage || expected.is_some())
        && expected.is_none_or(|selector| !selector.matches(asset_name))
    {
        return Err(PortcoveError::verification(
            "managed AppImage differs from its retained Linux asset declaration",
        ));
    }
    Ok(())
}

pub(crate) fn validate_release_rules(port: &PortDefinition) -> Result<()> {
    if port.release.provider == crate::ReleaseSource::DirectManifest {
        artifact(port)?;
        return Ok(());
    }
    if !requires_provider_resolution(port)
        || (port.platforms != [Platform::WindowsX86_64]
            && !crate::runtime_path_policy::has_staged_sibling_platforms(port))
        || !crate::definition_acquisition::valid_github_repository(&port.release.repository)
        || !port.release.direct.is_empty()
        || !port.release.curated.is_empty()
        || !port.release.managed_build.is_empty()
        || !port.release.user_prepared.is_empty()
        || port.platforms.iter().any(|platform| {
            port.release.asset_hints.get(platform).is_none_or(|hints| {
                hints.is_empty() || hints.iter().any(|hint| hint.trim().is_empty())
            })
        })
    {
        return Err(PortcoveError::verification(
            "runtime policy requires reviewed direct facts or reusable GitHub package rules for every platform",
        ));
    }
    for &platform in &port.platforms {
        validate_executable(port, platform)?;
    }
    Ok(())
}

fn validate_executable(port: &PortDefinition, platform: Platform) -> Result<()> {
    let hints = port
        .executable_hints
        .get(&platform)
        .ok_or_else(|| PortcoveError::verification("runtime policy has no reviewed executable"))?;
    let [executable] = hints.as_slice() else {
        return Err(PortcoveError::verification(
            "runtime policy requires one unambiguous executable",
        ));
    };
    crate::archive::validate_relative_path(executable, false)?;
    if platform == Platform::WindowsX86_64 && !executable.to_ascii_lowercase().ends_with(".exe") {
        return Err(PortcoveError::verification(
            "runtime policy requires a native Windows executable",
        ));
    }
    Ok(())
}

pub(crate) fn artifact(port: &PortDefinition) -> Result<(&str, ArtifactIdentity)> {
    let release = port
        .release
        .direct
        .get(&Platform::WindowsX86_64)
        .ok_or_else(|| {
            PortcoveError::verification("runtime policy has no reviewed direct release")
        })?;
    let url = reqwest::Url::parse(&release.url)
        .map_err(|_| PortcoveError::verification("runtime policy release URL is invalid"))?;
    let name = url
        .path_segments()
        .and_then(|mut segments| segments.next_back());
    if port.release.provider != crate::ReleaseSource::DirectManifest
        || port.platforms != [Platform::WindowsX86_64]
        || port.release.direct.len() != 1
        || release.version.trim().is_empty()
        || release.size == 0
        || release.sha256.len() != 64
        || !release.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || name.is_none_or(str::is_empty)
    {
        return Err(PortcoveError::verification(
            "runtime policy requires a reviewed Windows HTTPS direct package and complete artifact identity",
        ));
    }
    let name =
        name.ok_or_else(|| PortcoveError::verification("runtime policy artifact name is missing"))?;
    crate::archive::validate_relative_path(name, false)?;
    validate_executable(port, Platform::WindowsX86_64)?;
    Ok((
        &release.version,
        ArtifactIdentity {
            asset_name: name.into(),
            sha256: release.sha256.to_ascii_lowercase(),
            size: release.size,
        },
    ))
}

pub(crate) fn require_artifact(
    port: &PortDefinition,
    version: &str,
    actual: &ArtifactIdentity,
    platform: Option<Platform>,
) -> Result<()> {
    if requires_provider_resolution(port) {
        validate_release_rules(port)?;
        crate::archive::validate_relative_path(&actual.asset_name, false)?;
        let name = actual.asset_name.to_ascii_lowercase();
        let hints = platform
            .filter(|platform| port.platforms.contains(platform))
            .and_then(|platform| port.release.asset_hints.get(&platform));
        if version.trim().is_empty()
            || actual.size == 0
            || actual.sha256.len() != 64
            || !actual.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !name.ends_with(".zip")
            || hints.is_none_or(|hints| {
                hints
                    .iter()
                    .any(|hint| !name.contains(&hint.to_ascii_lowercase()))
            })
        {
            return Err(PortcoveError::verification(
                "runtime policy artifact does not match its retained package rules",
            ));
        }
        // This is consistency validation only. Fresh acquisition additionally
        // requires the opaque provider binding; old installed versions stay offline.
        return Ok(());
    }
    let (expected_version, expected) = artifact(port)?;
    if platform != Some(Platform::WindowsX86_64)
        || version != expected_version
        || actual.asset_name != expected.asset_name
        || actual.size != expected.size
        || !actual.sha256.eq_ignore_ascii_case(&expected.sha256)
    {
        return Err(PortcoveError::verification(
            "runtime policy requires the artifact selected by its retained reviewed release",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_sibling_artifacts_follow_the_retained_platform_rules() {
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("super-metroid-recomp").unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "supermetroid-0.4.4-linux-x64.zip".into(),
            size: 14_938_225,
            sha256: "4a7f0116c42460c4b0e9643225a2b27a3ff4d58ad3fd41cce49e59703b5f73a8".into(),
        };
        require_artifact(port, "v0.4.4", &artifact, Some(Platform::LinuxX86_64)).unwrap();
        for platform in [
            None,
            Some(Platform::WindowsX86_64),
            Some(Platform::MacosX86_64),
            Some(Platform::MacosAarch64),
        ] {
            assert!(require_artifact(port, "v0.4.4", &artifact, platform).is_err());
        }
        let mut invalid = port.clone();
        invalid.release.asset_hints.remove(&Platform::MacosAarch64);
        assert!(validate_release_rules(&invalid).is_err());
        invalid = port.clone();
        invalid.archive_data_compatibility_v1 = None;
        assert!(crate::runtime_path_policy::validate(&invalid).is_err());
    }

    #[test]
    fn managed_acquisition_holds_follow_catalog_data_without_port_specific_code() {
        let embedded = crate::Catalog::embedded().unwrap();
        let mut document = embedded.authoritative_document();
        let held = "open-nectar-pikmin";
        let other = document
            .ports
            .iter()
            .find(|port| port.id != held && port.managed_acquisition_hold.is_none())
            .unwrap()
            .id
            .clone();
        assert!(require_acquisition_available(&embedded, held).is_err());
        assert!(require_acquisition_available(&embedded, &other).is_ok());

        let hold = crate::ManagedAcquisitionHold {
            reason: "held for review".into(),
            activation_reason: "unreviewed package".into(),
            excluded_artifacts: Vec::new(),
            reviewed_artifacts: vec![crate::ReviewedHoldArtifact {
                version: "1.0.0".into(),
                sha256: "b".repeat(64),
            }],
        };
        for port in &mut document.ports {
            if port.id == held {
                port.managed_acquisition_hold = None;
            } else if port.id == other {
                port.managed_acquisition_hold = Some(hold.clone());
            }
        }
        let changed =
            crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        assert!(require_acquisition_available(&changed, held).is_ok());
        let refusal = require_acquisition_available(&changed, &other).unwrap_err();
        assert_eq!(refusal.code, crate::ErrorCode::Unsupported);
        assert!(require_acquisition_available(&changed, "not-in-catalog").is_ok());

        let mut install = crate::InstallRecord {
            id: "staged".into(),
            port_id: other.clone(),
            version: "1.0.0".into(),
            path: std::path::PathBuf::from("staged"),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: true,
            artifact: crate::ArtifactIdentity {
                asset_name: "port.zip".into(),
                sha256: "B".repeat(64),
                size: 1,
            },
            manifest_sha256: "a".repeat(64),
            selected_executable: "port.exe".into(),
            runtime: None,
        };
        assert!(require_managed_activation_available(&changed, &install).is_ok());
        install.version = "1.0.1".into();
        let refusal = require_managed_activation_available(&changed, &install).unwrap_err();
        assert!(refusal.message.contains("unreviewed package"));

        let policy = document
            .ports
            .iter_mut()
            .find(|port| port.id == other)
            .unwrap()
            .managed_acquisition_hold
            .as_mut()
            .unwrap();
        policy.excluded_artifacts.push(crate::ReviewedHoldArtifact {
            version: "1.0.1".into(),
            sha256: "b".repeat(64),
        });
        let exact = crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        assert!(require_acquisition_available(&exact, &other).is_ok());
        assert!(require_artifact_available(&exact, &other, "1.0.1", &"B".repeat(64)).is_err());
        assert!(require_managed_activation_available(&exact, &install).is_err());
        install.version = "1.0.2".into();
        assert!(require_managed_activation_available(&exact, &install).is_ok());
    }

    #[test]
    fn super_metroid_excludes_v0_4_6_without_withdrawing_acquisition() {
        let catalog = crate::Catalog::embedded().unwrap();
        let id = "super-metroid-recomp";
        assert!(require_acquisition_available(&catalog, id).is_ok());

        let staged = |version: &str, sha256: &str| crate::InstallRecord {
            id: "staged".into(),
            port_id: id.into(),
            version: version.into(),
            path: std::path::PathBuf::from("staged"),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: true,
            artifact: crate::ArtifactIdentity {
                asset_name: format!("supermetroid-{}-windows-x64.zip", &version[1..]),
                sha256: sha256.into(),
                size: 1,
            },
            manifest_sha256: "a".repeat(64),
            selected_executable: "SuperMetroidSNESRecomp.exe".into(),
            runtime: None,
        };
        for (version, sha256) in [
            (
                "v0.4.2",
                "72b7c179b855fba9404eec07abdbacefaffa4c67898f5c5232f0b1444b73d531",
            ),
            (
                "v0.4.5",
                "337c1daa92bc74b6f7dcd881366d9791b8d7bb0710b1c945f5b88ee07d20a314",
            ),
        ] {
            assert!(
                require_managed_activation_available(&catalog, &staged(version, sha256)).is_ok(),
                "{version}"
            );
        }
        // A published Linux sibling is reviewed too, so it activates.
        let mut linux = staged(
            "v0.4.5",
            "72e6d67a0de4115a1bd943cd33d9e2e2a282315b6f6bd84199c0d05b83f65cbe",
        );
        linux.artifact.asset_name = "supermetroid-0.4.5-linux-x64.zip".into();
        linux.selected_executable = "SuperMetroidSNESRecomp".into();
        assert!(require_managed_activation_available(&catalog, &linux).is_ok());
        let refusal = require_managed_activation_available(
            &catalog,
            &staged(
                "v0.4.6",
                "9a765fdc4ce80ac9cf6147f776f98220b7013ed36210e71f4053463496ec8429",
            ),
        )
        .unwrap_err();
        assert!(refusal.message.contains("new window"));
    }

    const PORTS: [&str; 3] = [
        "the-force-engine-dark-forces",
        "resident-evil-gaiden-recomp",
        "wave-race-64-racewave46",
    ];

    #[test]
    fn dynamic_policies_keep_rules_unchanged_and_validate_old_artifacts_offline() {
        let catalog = crate::Catalog::embedded().unwrap();
        for id in PORTS {
            let mut port = catalog.port(id).unwrap().clone();
            port.release.provider = crate::ReleaseSource::Github;
            port.release.direct.clear();
            port.release.repository = "official/project".into();
            port.release.asset_hints.insert(
                Platform::WindowsX86_64,
                vec!["engine-".into(), "-windows-x64.zip".into()],
            );
            crate::runtime::validate(&port).unwrap();
            for version in ["v1", "v2"] {
                let actual = ArtifactIdentity {
                    asset_name: format!("engine-{version}-windows-x64.zip"),
                    sha256: "ab".repeat(32),
                    size: 42,
                };
                require_artifact(&port, version, &actual, Some(Platform::WindowsX86_64)).unwrap();
                let mut wrong = actual.clone();
                wrong.asset_name = format!("engine-{version}-windows-arm64.zip");
                assert!(
                    require_artifact(&port, version, &wrong, Some(Platform::WindowsX86_64))
                        .is_err()
                );
                wrong = actual.clone();
                wrong.sha256.clear();
                assert!(
                    require_artifact(&port, version, &wrong, Some(Platform::WindowsX86_64))
                        .is_err()
                );
            }
            match id {
                "the-force-engine-dark-forces" => {
                    port.managed_initialization =
                        Some(crate::ManagedInitialization::TfeDarkForces122420)
                }
                "resident-evil-gaiden-recomp" => {
                    port.managed_shared_preferences =
                        Some(crate::PreparedSharedPreferencesContract::Regaiden041Windows)
                }
                _ => {
                    port.runtime_data_policy = Some(crate::RuntimeDataPolicy::Racewave46V100Windows)
                }
            }
            assert!(
                crate::runtime::validate(&port).is_err(),
                "legacy exact policies cannot acquire dynamic meaning"
            );
        }
    }

    #[test]
    fn reviewed_policy_reuses_catalog_release_facts_and_refuses_mismatched_installations() {
        let catalog = crate::test_fixture::historical_managed_policy_catalog();
        for id in PORTS {
            let original = catalog.port(id).unwrap();
            let (_, previous) = artifact(original).unwrap();
            let mut next = original.clone();
            // Synthetic compatible release declaration, not a claimed upstream
            // release or runtime observation. Its closed behavioral layout stays.
            let release = next
                .release
                .direct
                .get_mut(&Platform::WindowsX86_64)
                .unwrap();
            release.version = "synthetic-compatible-next".into();
            release.url = "https://upstream.example.invalid/renamed-package.zip".into();
            release.size += 1;
            release.sha256 = "ab".repeat(32);
            next.executable_hints
                .insert(Platform::WindowsX86_64, vec!["RenamedEngine.exe".into()]);
            crate::runtime::validate(&next).unwrap();
            let (version, actual) = artifact(&next).unwrap();
            require_artifact(&next, version, &actual, Some(Platform::WindowsX86_64)).unwrap();
            assert!(
                require_artifact(&next, version, &previous, Some(Platform::WindowsX86_64)).is_err()
            );
            assert!(
                require_artifact(&next, "other", &actual, Some(Platform::WindowsX86_64)).is_err()
            );
            assert!(
                require_artifact(&next, version, &actual, Some(Platform::LinuxX86_64)).is_err()
            );
            assert!(require_artifact(&next, version, &actual, None).is_err());
            let mut wrong = actual.clone();
            wrong.asset_name = "other.zip".into();
            assert!(
                require_artifact(&next, version, &wrong, Some(Platform::WindowsX86_64)).is_err()
            );
            wrong = actual.clone();
            wrong.size += 1;
            assert!(
                require_artifact(&next, version, &wrong, Some(Platform::WindowsX86_64)).is_err()
            );

            let mut changed_behavior = next.clone();
            changed_behavior.launch_arguments.push("--arbitrary".into());
            assert!(crate::runtime::validate(&changed_behavior).is_err());
            changed_behavior = next.clone();
            changed_behavior.persistent_paths.push("../shared".into());
            // TFE preserves its fixed persistent leaves but Core's generic
            // catalog path owner, rather than the initializer, rejects traversal.
            assert!(
                crate::Catalog::from_json(&{
                    let mut document = catalog.authoritative_document();
                    let port = document
                        .ports
                        .iter_mut()
                        .find(|port| port.id == id)
                        .unwrap();
                    *port = changed_behavior;
                    serde_json::to_string(&document).unwrap()
                })
                .is_err()
            );

            match id {
                "the-force-engine-dark-forces" => {
                    next.managed_initialization =
                        Some(crate::ManagedInitialization::TfeDarkForces122420)
                }
                "resident-evil-gaiden-recomp" => {
                    next.managed_shared_preferences =
                        Some(crate::PreparedSharedPreferencesContract::Regaiden041Windows)
                }
                _ => {
                    next.runtime_data_policy = Some(crate::RuntimeDataPolicy::Racewave46V100Windows)
                }
            }
            assert!(
                crate::runtime::validate(&next).is_err(),
                "legacy variants retain their original exact release meaning"
            );
        }
    }

    #[test]
    fn policy_facts_do_not_authorize_unsafe_urls_ambiguous_executables_or_unknown_policy() {
        let catalog = crate::test_fixture::historical_managed_policy_catalog();
        let original = catalog.port(PORTS[0]).unwrap();
        for url in [
            "http://upstream.example/game.zip",
            "https://user:password@upstream.example/game.zip",
            "https://upstream.example/game.zip#other",
            "https://upstream.example/",
        ] {
            let mut changed = original.clone();
            changed
                .release
                .direct
                .get_mut(&Platform::WindowsX86_64)
                .unwrap()
                .url = url.into();
            assert!(artifact(&changed).is_err());
        }
        for hints in [
            vec!["../game.exe".into()],
            vec!["game.cmd".into()],
            vec!["a.exe".into(), "b.exe".into()],
        ] {
            let mut changed = original.clone();
            changed
                .executable_hints
                .insert(Platform::WindowsX86_64, hints);
            assert!(artifact(&changed).is_err());
        }
        let mut encoded = serde_json::to_value(original).unwrap();
        encoded["managed_initialization"] = serde_json::json!("future-unknown-policy");
        assert!(serde_json::from_value::<PortDefinition>(encoded).is_err());
    }

    #[test]
    fn shared_save_identifier_is_reviewed_bounded_data_and_does_not_expand_legacy_authority() {
        let catalog = crate::test_fixture::historical_managed_policy_catalog();
        let original = catalog.port("resident-evil-gaiden-recomp").unwrap();
        for save_id in [
            None,
            Some("../outside"),
            Some("nested/path"),
            Some(""),
            Some("café"),
        ] {
            let mut changed = original.clone();
            changed.managed_shared_preferences_save_id = save_id.map(str::to_owned);
            assert!(crate::runtime::validate(&changed).is_err());
        }
        let mut changed = original.clone();
        changed.managed_shared_preferences_save_id = Some("x".repeat(129));
        assert!(crate::runtime::validate(&changed).is_err());
        changed = original.clone();
        changed.managed_shared_preferences =
            Some(crate::PreparedSharedPreferencesContract::Regaiden041Windows);
        assert!(crate::runtime::validate(&changed).is_err());
        changed.managed_shared_preferences_save_id = None;
        crate::runtime::validate(&changed).unwrap();
        changed.managed_shared_preferences = None;
        changed.runtime_source_materialization = Some(crate::RuntimeSourceMaterialization::Copy);
        changed.managed_shared_preferences_save_id = Some("other".into());
        assert!(crate::runtime::validate(&changed).is_err());
    }
}
