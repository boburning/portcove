use std::{
    collections::HashSet,
    path::{Component, Path},
};

use crate::{
    AdapterKind, CatalogDocument, PortDefinition, PortcoveError, ReleaseChannel, ReleaseSource,
    Result, RuntimeSourceMaterialization, SourceKind, SourceProfile, UpstreamStatus,
};

const EMBEDDED_CATALOG: &str = include_str!("../catalog/catalog.json");

#[derive(Debug, Clone)]
pub struct Catalog {
    document: CatalogDocument,
}

impl Catalog {
    pub fn embedded() -> Result<Self> {
        Self::from_json(EMBEDDED_CATALOG)
    }

    pub fn from_json(value: &str) -> Result<Self> {
        let document: CatalogDocument = serde_json::from_str(value)?;
        let catalog = Self { document };
        catalog.validate()?;
        Ok(catalog)
    }

    pub fn document(&self) -> &CatalogDocument {
        &self.document
    }
    pub fn ports(&self) -> &[PortDefinition] {
        &self.document.ports
    }

    pub fn port(&self, id: &str) -> Result<&PortDefinition> {
        self.document
            .ports
            .iter()
            .find(|port| port.id == id)
            .ok_or_else(|| PortcoveError::not_found(format!("unknown port id: {id}")))
    }

    pub fn source_profile(&self, id: &str) -> Result<&SourceProfile> {
        self.document
            .source_profiles
            .iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| PortcoveError::not_found(format!("unknown source profile: {id}")))
    }

    pub fn validate(&self) -> Result<()> {
        if self.document.schema_version != 1 {
            return Err(PortcoveError::unsupported(format!(
                "catalog schema {} is not supported",
                self.document.schema_version
            )));
        }
        let profile_ids: HashSet<&str> = self
            .document
            .source_profiles
            .iter()
            .map(|profile| profile.id.as_str())
            .collect();
        if profile_ids.len() != self.document.source_profiles.len() {
            return Err(PortcoveError::conflict("duplicate source profile id"));
        }
        for profile in &self.document.source_profiles {
            if profile.accepted_sha1.iter().any(|value| !is_sha1(value))
                || profile
                    .accepted_sha256
                    .iter()
                    .any(|value| !is_sha256(value))
            {
                return Err(PortcoveError::usage(format!(
                    "{} contains an invalid source digest",
                    profile.id
                )));
            }
            match profile.kind {
                SourceKind::File if profile.disc.is_some() || !profile.members.is_empty() => {
                    return Err(PortcoveError::usage(format!(
                        "{} declares set or disc identity for a file source",
                        profile.id
                    )));
                }
                SourceKind::FileSet => {
                    let mut member_ids = HashSet::new();
                    let mut filenames = HashSet::new();
                    let valid_members = profile.disc.is_none()
                        && profile.accepted_extensions.is_empty()
                        && profile.accepted_sha1.is_empty()
                        && profile.accepted_sha256.is_empty()
                        && !profile.members.is_empty()
                        && profile.members.iter().all(|member| {
                            let valid_id = !member.id.is_empty()
                                && member.id.chars().all(|character| {
                                    character.is_ascii_lowercase()
                                        || character.is_ascii_digit()
                                        || character == '-'
                                });
                            let valid_filenames = !member.accepted_filenames.is_empty()
                                && member.accepted_filenames.iter().all(|filename| {
                                    is_safe_basename(filename)
                                        && filenames.insert(filename.to_ascii_lowercase())
                                });
                            valid_id
                                && member_ids.insert(member.id.as_str())
                                && !member.label.trim().is_empty()
                                && valid_filenames
                                && (!member.accepted_sha1.is_empty()
                                    || !member.accepted_sha256.is_empty()
                                    || !member.accepted_crc32.is_empty())
                                && member.accepted_sha1.iter().all(|value| is_sha1(value))
                                && member.accepted_sha256.iter().all(|value| is_sha256(value))
                                && member.accepted_crc32.iter().all(|value| is_crc32(value))
                        });
                    if !valid_members {
                        return Err(PortcoveError::usage(format!(
                            "{} has an incomplete file-set identity",
                            profile.id
                        )));
                    }
                }
                SourceKind::GamecubeDisc => {
                    if profile.disc.is_some()
                        || !profile.members.is_empty()
                        || !profile
                            .accepted_extensions
                            .iter()
                            .any(|extension| extension.eq_ignore_ascii_case("iso"))
                        || (profile.accepted_sha1.is_empty() && profile.accepted_sha256.is_empty())
                    {
                        return Err(PortcoveError::usage(format!(
                            "{} has an incomplete GameCube disc identity",
                            profile.id
                        )));
                    }
                }
                SourceKind::PsxDisc => {
                    let Some(disc) = &profile.disc else {
                        return Err(PortcoveError::usage(format!(
                            "{} is missing its PS1 disc identity",
                            profile.id
                        )));
                    };
                    let single_identity = !disc.track_counts.is_empty()
                        && !disc.track_counts.contains(&0)
                        && (!profile.accepted_sha1.is_empty()
                            || !profile.accepted_sha256.is_empty());
                    let disc_set_identity = disc.discs.len() >= 2
                        && disc.discs.iter().all(|entry| {
                            !entry.label.trim().is_empty()
                                && !entry.track_counts.is_empty()
                                && !entry.track_counts.contains(&0)
                                && (!entry.accepted_sha1.is_empty()
                                    || !entry.accepted_sha256.is_empty()
                                    || !entry.accepted_volume_ids.is_empty())
                                && entry.accepted_sha1.iter().all(|value| is_sha1(value))
                                && entry.accepted_sha256.iter().all(|value| is_sha256(value))
                                && entry.accepted_volume_ids.iter().all(|value| {
                                    !value.is_empty()
                                        && value.len() <= 32
                                        && value.chars().all(|character| {
                                            character.is_ascii_uppercase()
                                                || character.is_ascii_digit()
                                                || matches!(character, '_' | '-' | '.' | ' ')
                                        })
                                })
                        });
                    if !profile.members.is_empty()
                        || !profile
                            .accepted_extensions
                            .iter()
                            .any(|extension| extension.eq_ignore_ascii_case("chd"))
                        || (!single_identity && !disc_set_identity)
                        || (!disc.discs.is_empty() && !disc_set_identity)
                    {
                        return Err(PortcoveError::usage(format!(
                            "{} has an incomplete PS1 disc identity",
                            profile.id
                        )));
                    }
                }
                SourceKind::UpstreamValidatedDisc => {
                    if profile.disc.is_some()
                        || !profile.members.is_empty()
                        || profile.accepted_extensions.len() != 2
                        || !profile
                            .accepted_extensions
                            .iter()
                            .any(|extension| extension.eq_ignore_ascii_case("iso"))
                        || !profile
                            .accepted_extensions
                            .iter()
                            .any(|extension| extension.eq_ignore_ascii_case("chd"))
                        || !profile.accepted_sha1.is_empty()
                        || !profile.accepted_sha256.is_empty()
                    {
                        return Err(PortcoveError::usage(format!(
                            "{} has an invalid upstream-validated disc contract",
                            profile.id
                        )));
                    }
                }
                SourceKind::File => {}
            }
        }
        let mut port_ids = HashSet::new();
        for port in &self.document.ports {
            if port.id.is_empty()
                || !port.id.chars().all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
                })
            {
                return Err(PortcoveError::usage(format!(
                    "invalid canonical port id: {}",
                    port.id
                )));
            }
            if !port_ids.insert(port.id.as_str()) {
                return Err(PortcoveError::conflict(format!(
                    "duplicate port id: {}",
                    port.id
                )));
            }
            if port.channels.is_empty() || port.platforms.is_empty() {
                return Err(PortcoveError::usage(format!(
                    "{} has no channels or platforms",
                    port.id
                )));
            }
            if let Some(profile) = &port.source_profile
                && !profile_ids.contains(profile.as_str())
            {
                return Err(PortcoveError::usage(format!(
                    "{} references missing source profile {profile}",
                    port.id
                )));
            }
            if let Some(profile) = &port.bios_source_profile
                && (!profile_ids.contains(profile.as_str())
                    || port.adapter != AdapterKind::PsxRecompManaged)
            {
                return Err(PortcoveError::usage(format!(
                    "{} references an invalid BIOS source profile {profile}",
                    port.id
                )));
            }
            if let Some(variable) = &port.source_environment {
                let mut characters = variable.chars();
                let valid_name = characters
                    .next()
                    .is_some_and(|character| character.is_ascii_uppercase() || character == '_')
                    && characters.all(|character| {
                        character.is_ascii_uppercase()
                            || character.is_ascii_digit()
                            || character == '_'
                    });
                if port.source_profile.is_none()
                    || !valid_name
                    || variable.starts_with("PORTCOVE_")
                    || matches!(variable.as_str(), "GH_TOKEN" | "GITHUB_TOKEN")
                {
                    return Err(PortcoveError::usage(format!(
                        "{} has unsafe source environment variable: {variable}",
                        port.id
                    )));
                }
            }
            for argument in port
                .launch_arguments
                .iter()
                .chain(port.setup_arguments.iter())
            {
                if argument.is_empty()
                    || argument
                        .chars()
                        .any(|character| matches!(character, '\0' | '\r' | '\n'))
                {
                    return Err(PortcoveError::usage(format!(
                        "{} has unsafe built-in launch argument",
                        port.id
                    )));
                }
            }
            match port.upstream_status {
                UpstreamStatus::Active | UpstreamStatus::Retired => {}
                UpstreamStatus::Superseded => {
                    return Err(PortcoveError::unsupported(format!(
                        "{} is superseded; catalog its maintained successor instead",
                        port.id
                    )));
                }
                UpstreamStatus::Abandoned => {
                    return Err(PortcoveError::unsupported(format!(
                        "{} is abandoned and cannot be included in the catalog",
                        port.id
                    )));
                }
            }
            match port.release.provider {
                ReleaseSource::Github | ReleaseSource::Gitlab => {
                    if !valid_repository_path(&port.release.repository)
                        || !port.release.direct.is_empty()
                    {
                        return Err(PortcoveError::usage(format!(
                            "{} has an invalid hosted release specification",
                            port.id
                        )));
                    }
                    if port
                        .release
                        .repository
                        .eq_ignore_ascii_case("TechnicallyComputers/RetComM-Launcher")
                    {
                        return Err(PortcoveError::usage(format!(
                            "{} must resolve from its game upstream, not the RetComM launcher",
                            port.id
                        )));
                    }
                    if port.upstream_status == UpstreamStatus::Retired {
                        return Err(PortcoveError::unsupported(format!(
                            "{} is retired and must use a pinned direct manifest",
                            port.id
                        )));
                    }
                }
                ReleaseSource::DirectManifest => {
                    if port.channels != [ReleaseChannel::Stable]
                        || port.release.rolling_tag.is_some()
                        || port.release.direct.len() != port.platforms.len()
                    {
                        return Err(PortcoveError::usage(format!(
                            "{} direct manifests must pin one stable artifact per declared platform",
                            port.id
                        )));
                    }
                    for platform in &port.platforms {
                        let Some(release) = port.release.direct.get(platform) else {
                            return Err(PortcoveError::usage(format!(
                                "{} has no direct manifest for {platform:?}",
                                port.id
                            )));
                        };
                        if release.version.trim().is_empty()
                            || release.size == 0
                            || !release.url.starts_with("https://")
                            || !is_sha256(&release.sha256)
                        {
                            return Err(PortcoveError::usage(format!(
                                "{} has an invalid direct manifest for {platform:?}",
                                port.id
                            )));
                        }
                    }
                }
            }
            for platform in &port.automated_tested_platforms {
                if !port.platforms.contains(platform) {
                    return Err(PortcoveError::usage(format!(
                        "{} has automated evidence for undeclared platform {platform:?}",
                        port.id
                    )));
                }
            }
            for platform in &port.manually_validated_platforms {
                if !port.platforms.contains(platform)
                    || !port.automated_tested_platforms.contains(platform)
                {
                    return Err(PortcoveError::usage(format!(
                        "{} manual validation must have matching declared and automated platform evidence for {platform:?}",
                        port.id
                    )));
                }
            }
            crate::runtime::validate(port)?;
            for pattern in &port.persistent_file_patterns {
                pattern.validate()?;
            }
            let mut persistent_paths = HashSet::new();
            for relative in &port.persistent_paths {
                if relative.is_empty()
                    || Path::new(relative)
                        .components()
                        .any(|component| !matches!(component, Component::Normal(_)))
                {
                    return Err(PortcoveError::usage(format!(
                        "{} has unsafe persistent path: {relative}",
                        port.id
                    )));
                }
                if !persistent_paths.insert(relative.as_str()) {
                    return Err(PortcoveError::conflict(format!(
                        "{} repeats persistent path: {relative}",
                        port.id
                    )));
                }
            }
            let mut runtime_mutable_paths = HashSet::new();
            for relative in &port.runtime_mutable_paths {
                if relative.is_empty()
                    || Path::new(relative)
                        .components()
                        .any(|component| !matches!(component, Component::Normal(_)))
                    || !runtime_mutable_paths.insert(relative.as_str())
                    || port.adapter != AdapterKind::UpstreamManagedSetup
                    || port.runtime_subdirectory.is_some()
                    || port
                        .persistent_paths
                        .iter()
                        .any(|persistent| crate::runtime::overlaps(relative, persistent))
                    || port
                        .runtime_source_filename
                        .as_ref()
                        .is_some_and(|source| crate::runtime::overlaps(relative, source))
                    || port
                        .setup_marker
                        .as_ref()
                        .is_some_and(|marker| crate::runtime::overlaps(relative, marker))
                {
                    return Err(PortcoveError::usage(format!(
                        "{} has an invalid nonpersistent runtime path: {relative}",
                        port.id
                    )));
                }
            }
            if let Some(directory) = &port.runtime_subdirectory
                && (directory.is_empty()
                    || Path::new(directory)
                        .components()
                        .any(|component| !matches!(component, Component::Normal(_))))
            {
                return Err(PortcoveError::usage(format!(
                    "{} has unsafe runtime subdirectory: {directory}",
                    port.id
                )));
            }
            if let Some(filename) = &port.runtime_source_filename
                && (filename.is_empty()
                    || Path::new(filename)
                        .components()
                        .any(|component| !matches!(component, Component::Normal(_))))
            {
                return Err(PortcoveError::usage(format!(
                    "{} has unsafe runtime source filename: {filename}",
                    port.id
                )));
            }
            if port.runtime_source_materialization.is_some()
                && port.runtime_source_filename.is_none()
            {
                return Err(PortcoveError::usage(format!(
                    "{} declares runtime source materialization without a destination",
                    port.id
                )));
            }
            if port.runtime_source_filename.is_some() && !port.runtime_source_set.is_empty() {
                return Err(PortcoveError::usage(format!(
                    "{} mixes single and file-set runtime sources",
                    port.id
                )));
            }
            if let Some(filename) = &port.runtime_source_filename {
                let materialization = port
                    .runtime_source_materialization
                    .unwrap_or(RuntimeSourceMaterialization::N64BigEndian);
                let expected = port
                    .runtime_subdirectory
                    .as_deref()
                    .map(Path::new)
                    .unwrap_or_else(|| Path::new(""))
                    .join(filename);
                let source_is_persistent = port.persistent_paths.iter().any(|path| {
                    let persistent = Path::new(path);
                    persistent == expected
                        || (persistent.components().next().is_some()
                            && expected.starts_with(persistent))
                });
                let valid = match materialization {
                    RuntimeSourceMaterialization::N64BigEndian => {
                        matches!(
                            port.adapter,
                            AdapterKind::N64RecompPortable
                                | AdapterKind::LibultrashipPortable
                                | AdapterKind::GeneratedCache
                        ) && filename.ends_with(".z64")
                            && source_is_persistent
                    }
                    RuntimeSourceMaterialization::Copy => {
                        port.adapter == AdapterKind::StagedSourcePortable && source_is_persistent
                    }
                    RuntimeSourceMaterialization::GamecubeIso => {
                        port.adapter == AdapterKind::StagedSourcePortable
                            && filename.ends_with(".iso")
                            && port.source_profile.as_ref().is_some_and(|profile_id| {
                                self.document.source_profiles.iter().any(|profile| {
                                    profile.id == *profile_id
                                        && profile.kind == SourceKind::GamecubeDisc
                                })
                            })
                    }
                    RuntimeSourceMaterialization::PsxBinCue => {
                        port.adapter == AdapterKind::StagedSourcePortable
                            && port.source_profile.as_ref().is_some_and(|profile_id| {
                                self.document.source_profiles.iter().any(|profile| {
                                    profile.id == *profile_id
                                        && profile.kind == SourceKind::PsxDisc
                                        && profile
                                            .disc
                                            .as_ref()
                                            .is_some_and(|disc| disc.discs.is_empty())
                                })
                            })
                    }
                    RuntimeSourceMaterialization::PsxRawSet => {
                        port.adapter == AdapterKind::StagedSourcePortable
                            && port.source_profile.as_ref().is_some_and(|profile_id| {
                                self.document.source_profiles.iter().any(|profile| {
                                    profile.id == *profile_id
                                        && profile.kind == SourceKind::PsxDisc
                                        && profile
                                            .disc
                                            .as_ref()
                                            .is_some_and(|disc| disc.discs.len() >= 2)
                                })
                            })
                    }
                    RuntimeSourceMaterialization::Ps2Iso => {
                        port.adapter == AdapterKind::UpstreamManagedSetup
                            && filename.ends_with(".iso")
                            && port.source_profile.as_ref().is_some_and(|profile_id| {
                                self.document.source_profiles.iter().any(|profile| {
                                    profile.id == *profile_id
                                        && profile.kind == SourceKind::UpstreamValidatedDisc
                                })
                            })
                    }
                };
                if port.source_profile.is_none() || !valid {
                    return Err(PortcoveError::usage(format!(
                        "{} has an invalid runtime source materialization contract",
                        port.id
                    )));
                }
            }
            if !port.runtime_source_set.is_empty() {
                let Some(profile) = port.source_profile.as_ref().and_then(|profile_id| {
                    self.document
                        .source_profiles
                        .iter()
                        .find(|profile| profile.id == *profile_id)
                }) else {
                    return Err(PortcoveError::usage(format!(
                        "{} has runtime source targets without a source profile",
                        port.id
                    )));
                };
                let mut destinations = HashSet::new();
                for target in &port.runtime_source_set {
                    let source_names = target
                        .source_filenames
                        .iter()
                        .map(|value| value.to_ascii_lowercase())
                        .collect::<HashSet<_>>();
                    let matches_member = profile.members.iter().any(|member| {
                        member
                            .accepted_filenames
                            .iter()
                            .map(|value| value.to_ascii_lowercase())
                            .collect::<HashSet<_>>()
                            == source_names
                    });
                    let valid = profile.kind == SourceKind::FileSet
                        && !target.source_filenames.is_empty()
                        && target
                            .source_filenames
                            .iter()
                            .all(|filename| is_safe_basename(filename))
                        && !target.destination.is_empty()
                        && Path::new(&target.destination)
                            .components()
                            .all(|component| matches!(component, Component::Normal(_)))
                        && destinations.insert(target.destination.to_ascii_lowercase())
                        && matches!(
                            target.materialization,
                            RuntimeSourceMaterialization::Copy
                                | RuntimeSourceMaterialization::N64BigEndian
                        )
                        && matches_member;
                    if !valid {
                        return Err(PortcoveError::usage(format!(
                            "{} has an invalid file-set runtime source target",
                            port.id
                        )));
                    }
                }
            }
            if port.launch_from_install_root
                && !matches!(
                    port.adapter,
                    AdapterKind::StagedSourcePortable | AdapterKind::UpstreamManagedSetup
                )
            {
                return Err(PortcoveError::usage(format!(
                    "{} has an invalid install-root launch contract",
                    port.id
                )));
            }
            let has_setup_contract = !port.setup_executable_hints.is_empty()
                || !port.setup_arguments.is_empty()
                || port.setup_marker.is_some();
            if port.adapter == AdapterKind::UpstreamManagedSetup {
                let valid_marker = port.setup_marker.as_ref().is_some_and(|marker| {
                    !marker.is_empty()
                        && Path::new(marker)
                            .components()
                            .all(|component| matches!(component, Component::Normal(_)))
                });
                let valid_hints = port.platforms.iter().all(|platform| {
                    port.setup_executable_hints
                        .get(platform)
                        .is_some_and(|hints| {
                            !hints.is_empty() && hints.iter().all(|hint| is_safe_basename(hint))
                        })
                });
                let upstream_validated_source = port.source_profile.as_ref().is_some_and(|id| {
                    self.document.source_profiles.iter().any(|profile| {
                        profile.id == *id && profile.kind == SourceKind::UpstreamValidatedDisc
                    })
                });
                if !valid_marker
                    || !valid_hints
                    || port.setup_arguments.is_empty()
                    || !upstream_validated_source
                    || port.runtime_source_materialization
                        != Some(RuntimeSourceMaterialization::Ps2Iso)
                {
                    return Err(PortcoveError::usage(format!(
                        "{} has an incomplete upstream-managed setup contract",
                        port.id
                    )));
                }
            } else if has_setup_contract {
                return Err(PortcoveError::usage(format!(
                    "{} declares setup behavior on an incompatible adapter",
                    port.id
                )));
            }
        }
        Ok(())
    }
}

fn valid_repository_path(value: &str) -> bool {
    let mut parts = value.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(owner), Some(project), None) if !owner.is_empty() && !project.is_empty())
}

fn is_safe_basename(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value).components().count() == 1
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn is_sha1(value: &str) -> bool {
    value.len() == 40 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn is_crc32(value: &str) -> bool {
    value.len() == 8 && value.chars().all(|character| character.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Platform;

    #[test]
    fn embedded_catalog_is_valid_and_contains_lighthouse() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let lighthouse = catalog.port("lighthouse").expect("lighthouse should exist");
        assert_eq!(lighthouse.release.repository, "HarbourMasters/Lighthouse");
        assert_eq!(lighthouse.source_profile.as_deref(), Some("banjo-kazooie"));
    }

    #[test]
    fn extreme_g_uses_gitlab_and_an_exact_source_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let port = catalog
            .port("extreme-g-recompiled")
            .expect("Extreme-G should exist");
        assert_eq!(port.release.provider, crate::ReleaseSource::Gitlab);
        assert_eq!(port.release.repository, "sonicdcer/ExtremeGRecomp");
        assert_eq!(port.channels, vec![crate::ReleaseChannel::Stable]);
        assert!(port.portable_marker);
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("extremeg.us.z64")
        );
        let profile = catalog.source_profile("extreme-g").unwrap();
        assert_eq!(
            profile.accepted_sha1,
            vec!["eb9b273431970a6124319a8fd125f0b2cacd8966"]
        );
        assert_eq!(
            profile.accepted_sha256,
            vec!["9e67bc574e40ef273759d587972655003d5213e625bfa68d3071dc9782d2071c"]
        );
    }

    #[test]
    fn superseded_and_abandoned_projects_fail_closed() {
        let catalog = Catalog::embedded().unwrap();
        for status in [
            crate::UpstreamStatus::Superseded,
            crate::UpstreamStatus::Abandoned,
        ] {
            let mut document = catalog.document().clone();
            document.ports[0].upstream_status = status;
            let value = serde_json::to_string(&document).unwrap();
            assert!(Catalog::from_json(&value).is_err());
        }
    }

    #[test]
    fn shared_banjo_source_is_explicit() {
        let catalog = Catalog::embedded().expect("catalog should load");
        assert_eq!(
            catalog.port("lighthouse").unwrap().source_profile,
            catalog.port("banjo-recomp").unwrap().source_profile
        );
        let profile = catalog.source_profile("banjo-kazooie").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["59875835b9a5128bb0054315a7f929e2071c2001e528d70bf543e1d6680e6eff"]
        );
        let recomp = catalog.port("banjo-recomp").unwrap();
        assert_eq!(
            recomp.runtime_source_filename.as_deref(),
            Some("bk.n64.us.1.0.z64")
        );
        assert!(
            recomp
                .persistent_paths
                .iter()
                .any(|path| path == "bk.n64.us.1.0.z64")
        );
    }

    #[test]
    fn qualified_windows_ports_have_expected_evidence() {
        let catalog = Catalog::embedded().expect("catalog should load");
        for id in [
            "shipwright",
            "2ship2harkinian",
            "spaghetti-kart",
            "lighthouse",
            "zelda64-recomp",
            "banjo-recomp",
            "bm64-recomp",
        ] {
            let port = catalog.port(id).unwrap();
            assert_eq!(
                port.automated_tested_platforms,
                vec![crate::Platform::WindowsX86_64]
            );
            assert_eq!(
                port.manually_validated_platforms,
                vec![crate::Platform::WindowsX86_64]
            );
        }
        for id in [
            "dusklight",
            "bomberman-hero-recomp",
            "snowboard-kids-2-recomp",
            "goemon64-recomp",
            "harvest-moon-64-recomp",
            "mega-man-64-recompiled",
            "gen1recomp",
            "perfect-dark",
            "donkey-kong-64-recompiled",
            "automobili-lamborghini-recompiled",
            "aerogauge-recompiled",
            "beetle-recomp",
            "quest-64-recompiled",
            "wcw-world-tour-recompiled",
            "wcw-nwo-revenge-recompiled",
            "wwf-no-mercy-recompiled",
            "opengoal-jak1",
            "opengoal-jak2",
            "opengoal-jak3",
        ] {
            let port = catalog.port(id).unwrap();
            assert_eq!(
                port.automated_tested_platforms,
                vec![crate::Platform::WindowsX86_64]
            );
            assert!(port.manually_validated_platforms.is_empty());
        }
    }

    #[test]
    fn aki_family_uses_exact_sources_and_portable_runtime_names() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let contracts = [
            (
                "wcw-world-tour",
                "5ad2d8359058c8bb71f08e3d3433b7a50d3bb645",
                "wcw-world-tour-recompiled",
                "wcw.nwo.worldtour.us.z64",
            ),
            (
                "vpw64",
                "f9e9fa2ed819c3a39db5cb6afeca186f021db5ed",
                "vpw64-recompiled",
                "vpw.vpw64.jp.z64",
            ),
            (
                "wcw-nwo-revenge",
                "e1711a2511394b9357b5f1ac8ca5cc17bd674836",
                "wcw-nwo-revenge-recompiled",
                "wcw.nwo.revenge.us.z64",
            ),
            (
                "wwf-wrestlemania-2000",
                "d7d1fad473fef9b61fe5f8273c975ee7c603a51b",
                "wwf-wrestlemania-2000-recompiled",
                "wwf.wm2k.us.z64",
            ),
            (
                "vpw2",
                "82dd25a044689eab57ab362fe10c0da6388c217a",
                "vpw2-recompiled",
                "vpw.vpw2.jp.z64",
            ),
            (
                "wwf-no-mercy",
                "91cee3d096f4a76644d8b35b9aead6448909abd1",
                "wwf-no-mercy-recompiled",
                "wwf.nomercy.us.z64",
            ),
        ];

        for (profile_id, sha1, port_id, runtime_source) in contracts {
            let profile = catalog.source_profile(profile_id).unwrap();
            assert_eq!(profile.accepted_extensions, vec!["z64"]);
            assert_eq!(profile.accepted_sha1, vec![sha1]);

            let port = catalog.port(port_id).unwrap();
            assert_eq!(port.channels, vec![crate::ReleaseChannel::Beta]);
            assert_eq!(
                port.runtime_source_filename.as_deref(),
                Some(runtime_source)
            );
            assert!(
                port.persistent_paths
                    .iter()
                    .any(|path| path == runtime_source)
            );
        }
    }

    #[test]
    fn quest_64_uses_its_exact_portable_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("quest-64").unwrap();
        assert_eq!(
            profile.accepted_sha256,
            vec!["3292d99dd93c3054906887a84a00efdd747ee620cbea4601df2f7f82d5f74c74"]
        );
        let port = catalog.port("quest-64-recompiled").unwrap();
        assert_eq!(port.channels, vec![crate::ReleaseChannel::Stable]);
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("quest64_us.z64")
        );
    }

    #[test]
    fn gen1_uses_its_verified_red_import_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("pokemon-gen-1").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["gb"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["5ca7ba01642a3b27b0cc0b5349b52792795b62d3ed977e98a09390659af96b7b"]
        );
        let port = catalog.port("gen1recomp").unwrap();
        assert!(port.portable_marker);
        assert_eq!(
            port.source_environment.as_deref(),
            Some("POKEPORT_IMPORT_ROM")
        );
        assert_eq!(port.launch_arguments, vec!["--game=red"]);
    }

    #[test]
    fn catalog_rejects_reserved_source_environment_variables() {
        let mut document: serde_json::Value =
            serde_json::from_str(EMBEDDED_CATALOG).expect("embedded JSON should parse");
        let port = document["ports"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|port| port["id"] == "gen1recomp")
            .unwrap();
        port["source_environment"] = serde_json::json!("GITHUB_TOKEN");

        let error = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap_err();
        assert!(error.to_string().contains("unsafe source environment"));
    }

    #[test]
    fn catalog_rejects_escaping_runtime_subdirectories() {
        let mut document: serde_json::Value =
            serde_json::from_str(EMBEDDED_CATALOG).expect("embedded JSON should parse");
        let port = document["ports"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|port| port["id"] == "beetle-recomp")
            .unwrap();
        port["runtime_subdirectory"] = serde_json::json!("../outside");

        let error = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap_err();
        assert!(error.to_string().contains("unsafe runtime subdirectory"));
    }

    #[test]
    fn catalog_rejects_retcomm_launcher_as_a_game_release_source() {
        let mut document: serde_json::Value =
            serde_json::from_str(EMBEDDED_CATALOG).expect("embedded JSON should parse");
        let port = document["ports"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|port| port["id"] == "twisted-metal-4-recompiled")
            .unwrap();
        port["release"]["repository"] = serde_json::json!("TechnicallyComputers/RetComM-Launcher");

        let error = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap_err();
        assert!(error.to_string().contains("game upstream"));
    }

    #[test]
    fn mortal_kombat_uses_the_exact_shared_psx_bios_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let port = catalog.port("mortal-kombat-4-recompiled").unwrap();
        assert_eq!(
            port.bios_source_profile.as_deref(),
            Some("psx-scph-1001-bios")
        );
        let bios = catalog.source_profile("psx-scph-1001-bios").unwrap();
        assert_eq!(bios.accepted_extensions, ["bin", "rom"]);
        assert_eq!(
            bios.accepted_sha1,
            ["10155d8d6e6e832d6ea66db9bc098321fb5e8ebf"]
        );
        assert_eq!(
            bios.accepted_sha256,
            ["71af94d1e47a68c11e8fdb9f8368040601514a42a5a399cda48c7d3bff1e99d3"]
        );
    }

    #[test]
    fn dusklight_uses_its_validated_disc_and_persistence_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("twilight-princess").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["iso", "gcm", "rvz"]);
        let port = catalog.port("dusklight").unwrap();
        for path in [
            "texture_replacements",
            "USA",
            "EUR",
            "JAP",
            "achievements.json",
            "config.json",
            "controller_ports.dat",
            "gamecontrollerdb.txt",
            "imgui.ini",
            "keyboard_bindings.dat",
            "states.json",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "Dusklight persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn bomberman_hero_uses_its_validated_portable_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("bomberman-hero").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["e021ec484a88c528256dbff80617e599768b074b0918dcec081ecbf365386542"]
        );
        let port = catalog.port("bomberman-hero-recomp").unwrap();
        assert_eq!(port.runtime_source_filename.as_deref(), Some("bmhero.z64"));
        for path in [
            "mods",
            "mod_config",
            "saves",
            "general.json",
            "graphics.json",
            "controls.json",
            "sound.json",
            "bmhero.z64",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "Bomberman Hero persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn snowboard_kids_2_uses_its_validated_portable_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("snowboard-kids-2").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["8af426d05af66033ab6ba8e643aaf3ea4eee329a642440600821f6faf6618ebd"]
        );
        let port = catalog.port("snowboard-kids-2-recomp").unwrap();
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("snowboardkids2.n64.us.z64")
        );
        for path in [
            "mods",
            "mod_config",
            "saves",
            "general.json",
            "graphics.json",
            "controls.json",
            "sound.json",
            "snowboardkids2.n64.us.z64",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "Snowboard Kids 2 persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn goemon_64_uses_its_upstream_portable_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let port = catalog
            .port("goemon64-recomp")
            .expect("Goemon 64 should exist");
        let profile = catalog
            .source_profile("goemon-64")
            .expect("Goemon 64 source profile should exist");

        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["1603be37427a33548857fc3d2e8867ede71121c353fb631b79b44f1d94845d80"]
        );
        assert_eq!(port.runtime_source_filename.as_deref(), Some("mnsg.us.z64"));
        assert!(port.persistent_paths.iter().any(|path| path == "saves"));
        assert!(port.persistent_paths.iter().any(|path| path == "mods"));
        assert!(
            port.persistent_paths
                .iter()
                .any(|path| path == "mnsg.us.z64")
        );
    }

    #[test]
    fn dkr_alpha_exposes_only_its_published_platforms() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let port = catalog.port("dkr-r").expect("DKR-R should exist");

        assert_eq!(port.channels, vec![crate::ReleaseChannel::Beta]);
        assert_eq!(
            port.platforms,
            vec![crate::Platform::LinuxX86_64, crate::Platform::MacosAarch64]
        );
        assert!(!port.platforms.contains(&crate::Platform::WindowsX86_64));
        assert!(port.automated_tested_platforms.is_empty());
    }

    #[test]
    fn tomba_alpha_requires_the_opt_in_beta_channel() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let port = catalog
            .port("tomba-recompiled")
            .expect("Tomba should exist");

        assert_eq!(port.channels, vec![crate::ReleaseChannel::Beta]);
        assert_eq!(port.support_tier, crate::SupportTier::Beta);
    }

    #[test]
    fn donkey_kong_64_uses_its_upstream_portable_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("donkey-kong-64").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["b6347d9f1f75d38a88d829b4f80b1acf0d93344170a5fbe9546c484dae416ce3"]
        );

        let port = catalog.port("donkey-kong-64-recompiled").unwrap();
        assert_eq!(port.channels, vec![crate::ReleaseChannel::Stable]);
        assert_eq!(port.runtime_source_filename.as_deref(), Some("DK64.z64"));
        for path in [
            "mods",
            "mod_config",
            "saves",
            "general.json",
            "graphics.json",
            "controls.json",
            "sound.json",
            "technical.json",
            "DK64.z64",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "Donkey Kong 64 persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn automobili_lamborghini_uses_its_upstream_portable_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("automobili-lamborghini").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["cab2467684a58bc19c787423d704a961aa497629763367d9fe691172de58591c"]
        );

        let port = catalog.port("automobili-lamborghini-recompiled").unwrap();
        assert_eq!(port.channels, vec![crate::ReleaseChannel::Stable]);
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("Automobili Lamborghini (USA).z64")
        );
        for path in [
            "mods",
            "mod_config",
            "saves",
            "graphics.json",
            "controls.json",
            "player.json",
            "lambo_controller_pak.mpk",
            "lambo_savestate.lstate",
            "Automobili Lamborghini (USA).z64",
            "lamborghini.us.z64",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "Automobili Lamborghini persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn beetle_recomp_uses_its_stable_and_continuous_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("beetle-adventure-racing").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["6addd60de277c83351eff83099e4dab25ac45279b6401728cfda9eea2f1380df"]
        );

        let port = catalog.port("beetle-recomp").unwrap();
        assert_eq!(
            port.channels,
            vec![
                crate::ReleaseChannel::Stable,
                crate::ReleaseChannel::Rolling
            ]
        );
        assert_eq!(port.release.rolling_tag.as_deref(), Some("Continuous"));
        assert_eq!(
            port.runtime_subdirectory.as_deref(),
            Some("BeetleRecomp-Windows-x64")
        );
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("bar.n64.us.z64")
        );
        for path in [
            "BeetleRecomp-Windows-x64/mods",
            "BeetleRecomp-Windows-x64/mod_config",
            "BeetleRecomp-Windows-x64/saves",
            "BeetleRecomp-Windows-x64/graphics.json",
            "BeetleRecomp-Windows-x64/input.json",
            "BeetleRecomp-Windows-x64/cheats.cfg",
            "BeetleRecomp-Windows-x64/bar.n64.us.z64",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "BeetleRecomp persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn aerogauge_uses_its_upstream_portable_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("aerogauge").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["2cc529109b11b00289d87f693a40591ef260d1dc7c1129113966ba6ddb1be4a5"]
        );

        let port = catalog.port("aerogauge-recompiled").unwrap();
        assert_eq!(port.channels, vec![crate::ReleaseChannel::Stable]);
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("AeroGauge (USA).z64")
        );
        for path in [
            "mods",
            "mod_config",
            "saves",
            "graphics.json",
            "AeroGauge (USA).z64",
            "aerogauge.us.z64",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "AeroGauge persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn trouble_makers_requires_the_upstream_us_1_1_source() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("trouble-makers").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["e00ab74c3dee79efaafe8e10f2a6b67784d7327ab588d8ef90ad8945427da627"]
        );
    }

    #[test]
    fn perfect_dark_uses_its_recommended_rolling_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("perfect-dark").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["4e51142acac686d96861cecc58cf7cb7c3b06b21733b7f8ed609a709dc039a21"]
        );
        let port = catalog.port("perfect-dark").unwrap();
        assert_eq!(port.channels, vec![crate::ReleaseChannel::Rolling]);
        assert_eq!(port.launch_arguments, vec!["--portable"]);
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("data/pd.ntsc-final.z64")
        );
    }

    #[test]
    fn harvest_moon_uses_its_validated_portable_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("harvest-moon-64").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["15c570120bfaa97b4580762f5ee5939a56ba054e696925ea81ccfa55a022d2a6"]
        );
        let port = catalog.port("harvest-moon-64-recomp").unwrap();
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("harvest_moon_64.z64")
        );
        for path in [
            "mods",
            "mod_config",
            "saves",
            "general.json",
            "graphics.json",
            "controls.json",
            "sound.json",
            "harvest_moon_64.z64",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "Harvest Moon persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn mega_man_uses_its_validated_portable_runtime_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("mega-man-64").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["618d49bf62913b376e4858f1422a51a4352792b070fe6305860dd43e28353999"]
        );
        let port = catalog.port("mega-man-64-recompiled").unwrap();
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("megaman.n64.us.1.0.z64")
        );
        for path in [
            "mods",
            "mod_config",
            "saves",
            "general.json",
            "graphics.json",
            "controls.json",
            "sound.json",
            "megaman.n64.us.1.0.z64",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "Mega Man persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn two_ship_persists_generated_assets_and_settings() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let port = catalog.port("2ship2harkinian").unwrap();
        for path in ["mm.o2r", "2ship2harkinian.json", "saves", "presets"] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "2Ship persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn spaghetti_kart_requires_the_upstream_supported_us_z64() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("mario-kart-64").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["d6b8538dd63f0132ecb2856e7d32816ed3c30e3e479aecd23cf83fb6ba17a5da"]
        );
    }

    #[test]
    fn ghostship_requires_the_supported_us_super_mario_64_z64() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("ghostship-source").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91"]
        );
        let port = catalog.port("ghostship").unwrap();
        for path in ["sm64.o2r", "ghostship.cfg.json", "saves", "mods"] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "Ghostship persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn bomberman_recomp_uses_its_pinned_us_rom_filename() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("bomberman-64").unwrap();
        assert_eq!(profile.accepted_extensions, vec!["z64"]);
        assert_eq!(
            profile.accepted_sha256,
            vec!["e6da7c26127788cd894b88b71cc055ff9dec0d0f4f8e10d9b15b40153af2b52a"]
        );
        let port = catalog.port("bm64-recomp").unwrap();
        assert_eq!(port.runtime_source_filename.as_deref(), Some("bm64_us.z64"));
        assert!(
            port.persistent_paths
                .iter()
                .any(|path| path == "bm64_us.z64")
        );
    }

    #[test]
    fn first_tge_cutoff_wave_uses_reviewed_source_materialization_contracts() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let contracts = [
            (
                "sssv-recompiled",
                "space-station-silicon-valley",
                None,
                true,
            ),
            (
                "animal-crossing-pc-port",
                "animal-crossing-gamecube",
                Some(RuntimeSourceMaterialization::GamecubeIso),
                true,
            ),
            (
                "project-picori",
                "minish-cap-gba",
                Some(RuntimeSourceMaterialization::Copy),
                true,
            ),
            ("battleship", "super-smash-bros-64", None, true),
        ];

        for (port_id, profile_id, materialization, stages_source) in contracts {
            let port = catalog.port(port_id).expect("cutoff port should exist");
            assert_eq!(port.source_profile.as_deref(), Some(profile_id));
            assert_eq!(port.runtime_source_materialization, materialization);
            assert_eq!(port.runtime_source_filename.is_some(), stages_source);
            assert!(port.platforms.contains(&Platform::WindowsX86_64));
        }

        assert_eq!(
            catalog
                .source_profile("animal-crossing-gamecube")
                .unwrap()
                .kind,
            SourceKind::GamecubeDisc
        );
    }

    #[test]
    fn copied_runtime_sources_require_persistent_ownership() {
        let mut catalog = Catalog::embedded().unwrap();
        let index = catalog
            .document
            .ports
            .iter()
            .position(|port| port.id == "project-picori")
            .unwrap();
        catalog.document.ports[index]
            .persistent_paths
            .retain(|path| path != "baserom.gba");
        assert!(catalog.validate().is_err());

        // A declared parent directory owns the staged file, but a similarly
        // named sibling does not.
        catalog.document.ports[index].runtime_source_filename = Some("rom/baserom.gba".into());
        catalog.document.ports[index]
            .persistent_paths
            .push("rom-other".into());
        assert!(catalog.validate().is_err());
        catalog.document.ports[index]
            .persistent_paths
            .push("rom".into());
        catalog.validate().unwrap();
    }

    #[test]
    fn g_diffuser_requires_and_stages_its_three_exact_inputs() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("g-diffuser-source-set").unwrap();
        assert_eq!(profile.kind, SourceKind::FileSet);
        assert_eq!(profile.members.len(), 3);
        assert_eq!(
            profile.members[0].accepted_sha1,
            ["5f658e88ffa9de23cba6986a8fd3d3a90d7b4340"]
        );
        assert_eq!(
            profile.members[1].accepted_sha1,
            ["fde9fa6f29a52be0144bda74caf8583c036c20ce"]
        );

        let port = catalog.port("g-diffuser").unwrap();
        assert_eq!(port.runtime_source_set.len(), 3);
        assert_eq!(
            port.channels,
            [ReleaseChannel::Stable, ReleaseChannel::Beta]
        );
        assert!(port.automated_tested_platforms.is_empty());
        for path in [
            "fzerox.o2r",
            "fzerox-disk.o2r",
            "n64ddipl.o2r",
            "gdx_firstboot.cfg",
            "gdx_extract_state.cfg",
            "saves",
            "ghosts",
            "mods",
        ] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "G-Diffuser persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn severed_chains_uses_the_exact_four_disc_rolling_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("legend-of-dragoon-usa").unwrap();
        assert_eq!(profile.kind, SourceKind::PsxDisc);
        let volume_ids: Vec<&str> = profile
            .disc
            .as_ref()
            .unwrap()
            .discs
            .iter()
            .map(|disc| disc.accepted_volume_ids[0].as_str())
            .collect();
        assert_eq!(
            volume_ids,
            ["SCUS94491", "SCUS94584", "SCUS94585", "SCUS94586"]
        );

        let port = catalog.port("severed-chains").unwrap();
        assert_eq!(port.channels, [ReleaseChannel::Rolling]);
        assert_eq!(
            port.runtime_source_materialization,
            Some(RuntimeSourceMaterialization::PsxRawSet)
        );
        assert_eq!(port.runtime_source_filename.as_deref(), Some("isos"));
        assert!(port.launch_from_install_root);
        for path in ["saves", "mods", "isos", "config.dcnf", "launch.conf"] {
            assert!(
                port.persistent_paths.iter().any(|value| value == path),
                "Severed Chains persistence contract is missing {path}"
            );
        }
    }

    #[test]
    fn openpete_uses_its_direct_checksum_and_idempotent_ingest_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("spyro-dragon-openpete").unwrap();
        assert_eq!(profile.kind, SourceKind::PsxDisc);
        assert_eq!(
            profile.accepted_sha256,
            ["95f03abf97c9ff0b2a64888ed7dbbb4b59a7b4363cf188cd0a562b95cfd4809f"]
        );

        let port = catalog.port("openpete").unwrap();
        assert_eq!(port.platforms, [Platform::WindowsX86_64]);
        assert_eq!(port.release.provider, crate::ReleaseSource::DirectManifest);
        let release = &port.release.direct[&Platform::WindowsX86_64];
        assert_eq!(release.size, 122_163_057);
        assert_eq!(
            release.sha256,
            "7ba215834c6a1e23d0642b6c749c6335853a18cc566805c0a39bcf2cd5ab1359"
        );
        assert_eq!(
            port.runtime_source_materialization,
            Some(RuntimeSourceMaterialization::PsxBinCue)
        );
        assert_eq!(port.launch_arguments, ["--ingest", "import/disc.cue"]);
        for path in ["openpete.toml", "cards", "states", "library"] {
            assert!(port.persistent_paths.iter().any(|value| value == path));
        }
    }

    #[test]
    fn opengoal_games_share_the_verified_setup_adapter_but_remain_separate_ports() {
        let catalog = Catalog::embedded().expect("catalog should load");
        for (port_id, profile_id, game, tier) in [
            (
                "opengoal-jak1",
                "opengoal-jak1-disc",
                "jak1",
                crate::SupportTier::Stable,
            ),
            (
                "opengoal-jak2",
                "opengoal-jak2-disc",
                "jak2",
                crate::SupportTier::Beta,
            ),
            (
                "opengoal-jak3",
                "opengoal-jak3-disc",
                "jak3",
                crate::SupportTier::Beta,
            ),
        ] {
            let profile = catalog.source_profile(profile_id).unwrap();
            assert_eq!(profile.kind, SourceKind::UpstreamValidatedDisc);
            assert_eq!(profile.accepted_extensions, ["iso", "chd"]);

            let port = catalog.port(port_id).unwrap();
            assert_eq!(port.adapter, AdapterKind::UpstreamManagedSetup);
            assert_eq!(port.support_tier, tier);
            assert_eq!(
                port.runtime_source_materialization,
                Some(RuntimeSourceMaterialization::Ps2Iso)
            );
            assert_eq!(port.setup_executable_hints.len(), 4);
            assert_eq!(port.setup_arguments[0..2], ["--game", game]);
            assert_eq!(port.launch_arguments, ["--game", game, "--portable"]);
            assert_eq!(port.runtime_mutable_paths, ["data/log", "data/imgui.ini"]);
            assert!(
                port.setup_marker
                    .as_deref()
                    .unwrap()
                    .ends_with("/iso/0COMMON.TXT")
            );
        }
    }

    #[test]
    fn mega_man_x6_reuses_the_exact_psx_disc_materialization_contract() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("mega-man-x6-psx").unwrap();
        assert_eq!(profile.kind, SourceKind::PsxDisc);
        assert_eq!(
            profile.accepted_sha1,
            ["d4f7e08371027a87a3bf13311db5a4c56733f4ea"]
        );
        assert_eq!(
            profile.accepted_sha256,
            ["91ef53c12c3a3eb3362d51d524d3f83cd4ff8e68bf2d2ad6c5c8ea4e0310d318"]
        );

        let port = catalog.port("mega-man-x6-recompiled").unwrap();
        assert_eq!(port.adapter, AdapterKind::StagedSourcePortable);
        assert_eq!(port.platforms, [Platform::WindowsX86_64]);
        assert_eq!(
            port.runtime_source_materialization,
            Some(RuntimeSourceMaterialization::PsxBinCue)
        );
        assert_eq!(port.runtime_source_filename.as_deref(), Some("disc"));
        assert_eq!(port.launch_arguments.last().unwrap(), "disc/disc.cue");
    }

    #[test]
    fn paper_mario_recut_keeps_its_upstream_user_directory_portable() {
        let catalog = Catalog::embedded().expect("catalog should load");
        let profile = catalog.source_profile("paper-mario-us").unwrap();
        assert_eq!(
            profile.accepted_sha1,
            ["3837f44cda784b466c9a2d99df70d77c322b97a0"]
        );

        let port = catalog.port("paper-mario-recut").unwrap();
        assert_eq!(port.adapter, AdapterKind::N64RecompPortable);
        assert_eq!(port.channels, [ReleaseChannel::Beta]);
        assert_eq!(
            port.runtime_subdirectory.as_deref(),
            Some("Paper Mario ReCut")
        );
        assert_eq!(
            port.runtime_source_filename.as_deref(),
            Some("user/pm.n64.us.z64")
        );
        assert_eq!(
            port.runtime_source_materialization,
            Some(RuntimeSourceMaterialization::N64BigEndian)
        );
        assert_eq!(port.persistent_paths, ["Paper Mario ReCut/user"]);
    }
}
