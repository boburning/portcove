//! Artifact applicability for reviewed, closed runtime behaviors. The retained
//! catalog owns release facts; hashing a download never supplies that authority.
use crate::{ArtifactIdentity, Platform, PortDefinition, PortcoveError, Result};

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
    let hints = port
        .executable_hints
        .get(&Platform::WindowsX86_64)
        .ok_or_else(|| PortcoveError::verification("runtime policy has no reviewed executable"))?;
    let [executable] = hints.as_slice() else {
        return Err(PortcoveError::verification(
            "runtime policy requires one unambiguous executable",
        ));
    };
    crate::archive::validate_relative_path(executable, false)?;
    if !executable.to_ascii_lowercase().ends_with(".exe") {
        return Err(PortcoveError::verification(
            "runtime policy requires a native Windows executable",
        ));
    }
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

    const PORTS: [&str; 3] = [
        "the-force-engine-dark-forces",
        "resident-evil-gaiden-recomp",
        "wave-race-64-racewave46",
    ];

    #[test]
    fn reviewed_policy_reuses_catalog_release_facts_and_refuses_mismatched_installations() {
        let catalog = crate::Catalog::embedded().unwrap();
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
        let catalog = crate::Catalog::embedded().unwrap();
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
        let catalog = crate::Catalog::embedded().unwrap();
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
