use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{AdapterKind, PortDefinition, PortcoveError, Result};

pub(crate) const LIBULTRASHIP_BINDING_CAPABILITY: u32 = 6;
pub(crate) const N64_RECOMP_BINDING_CAPABILITY: u32 = 8;

/// Exact provider-side scope from a reviewed definition.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "provider", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModProviderBinding {
    Gamebanana { game_id: u64 },
    Thunderstore { community: String },
}

impl ModProviderBinding {
    pub(crate) fn valid_coordinates(&self) -> bool {
        match self {
            Self::Gamebanana { game_id } => (1..=(1u64 << 53) - 1).contains(game_id),
            Self::Thunderstore { community } => {
                !community.is_empty()
                    && community.len() <= 80
                    && !community.starts_with('-')
                    && !community.ends_with('-')
                    && community.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
            }
        }
    }

    pub(crate) fn provider(&self) -> &'static str {
        match self {
            Self::Gamebanana { .. } => crate::gamebanana::PROVIDER,
            Self::Thunderstore { .. } => crate::thunderstore::PROVIDER,
        }
    }

    pub(crate) fn label(&self) -> &'static str {
        match self {
            Self::Gamebanana { .. } => "GameBanana",
            Self::Thunderstore { .. } => "Thunderstore",
        }
    }
}

pub(crate) fn legacy_binding(port_id: &str, provider: &str) -> Option<ModProviderBinding> {
    match provider {
        crate::gamebanana::PROVIDER => crate::provider_install::gamebanana_game(port_id)
            .map(|game_id| ModProviderBinding::Gamebanana { game_id }),
        crate::thunderstore::PROVIDER => {
            crate::thunderstore::thunderstore_community(port_id).map(|community| {
                ModProviderBinding::Thunderstore {
                    community: community.to_owned(),
                }
            })
        }
        _ => None,
    }
}

pub(crate) fn default_binding(port: &PortDefinition) -> Option<ModProviderBinding> {
    match configured_bindings(port) {
        None => legacy_binding(&port.id, crate::gamebanana::PROVIDER)
            .or_else(|| legacy_binding(&port.id, crate::thunderstore::PROVIDER)),
        Some([binding]) => Some(binding.clone()),
        _ => None,
    }
}

pub(crate) fn reviewed_binding(
    port: &PortDefinition,
    provider: &str,
) -> Option<ModProviderBinding> {
    match configured_bindings(port) {
        None => legacy_binding(&port.id, provider),
        Some(bindings) => bindings
            .iter()
            .find(|binding| binding.provider() == provider)
            .cloned(),
    }
}

pub(crate) fn bindings(port: &PortDefinition) -> Vec<ModProviderBinding> {
    configured_bindings(port).map_or_else(
        || default_binding(port).into_iter().collect(),
        <[ModProviderBinding]>::to_vec,
    )
}

pub(crate) fn configured_bindings(port: &PortDefinition) -> Option<&[ModProviderBinding]> {
    if port.legacy_mod_provider_held {
        return Some(&[]);
    }
    port.mod_provider_bindings.as_deref()
}

pub(crate) fn reference_matches(
    port: &PortDefinition,
    reference: &crate::ProviderPackageRef,
) -> bool {
    let expected = reviewed_binding(port, &reference.provider);
    let legacy = legacy_binding(&port.id, &reference.provider);
    expected.is_some() && expected.as_ref() == reference.binding.as_ref().or(legacy.as_ref())
}

pub(crate) fn same_project(
    port_id: &str,
    left: &crate::ProviderPackageRef,
    right: &crate::ProviderPackageRef,
) -> bool {
    left.provider == right.provider
        && left.project == right.project
        && (left.binding == right.binding || {
            let legacy = legacy_binding(port_id, &left.provider);
            left.binding.as_ref().or(legacy.as_ref()) == right.binding.as_ref().or(legacy.as_ref())
        })
}

pub(crate) fn has_explicit_scope(
    provider: Option<&crate::ProviderPackageRef>,
    requirements: &[crate::ProviderRequirement],
) -> bool {
    provider.is_some_and(|provider| provider.binding.is_some())
        || requirements
            .iter()
            .any(|requirement| requirement.provider.binding.is_some())
}

pub(crate) fn validate_dependency_scope(
    root: Option<&crate::ProviderPackageRef>,
    requirements: &[crate::ProviderRequirement],
) -> Result<()> {
    if let Some(root) = root
        && root.provider == crate::thunderstore::PROVIDER
        && requirements.iter().any(|requirement| {
            requirement.provider.provider != root.provider
                || requirement.provider.binding != root.binding
        })
    {
        return Err(PortcoveError::verification(
            "a Thunderstore package and its dependencies must use the same reviewed community",
        ));
    }
    Ok(())
}

pub(crate) fn validate_successor(previous: &PortDefinition, next: &PortDefinition) -> Result<()> {
    if previous.mod_provider_bindings.is_some() && next.mod_provider_bindings.is_none() {
        return Err(implicit_successor());
    }
    Ok(())
}

pub(crate) fn implicit_successor() -> PortcoveError {
    PortcoveError::conflict("reviewed mod provider scopes cannot revert to an implicit binding")
}

pub(crate) fn capability(port: &PortDefinition) -> Option<(&'static str, u32)> {
    match port.adapter {
        AdapterKind::LibultrashipPortable => {
            Some(("libultraship-portable", LIBULTRASHIP_BINDING_CAPABILITY))
        }
        AdapterKind::N64RecompPortable => {
            Some(("n64-recomp-portable", N64_RECOMP_BINDING_CAPABILITY))
        }
        _ => None,
    }
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let Some(bindings) = &port.mod_provider_bindings else {
        return Ok(());
    };
    let valid = crate::profile_loader::configured_loader(port).is_some()
        && capability(port).is_some()
        && bindings.len() <= 2
        && bindings
            .windows(2)
            .all(|pair| pair[0].provider() < pair[1].provider())
        && bindings.iter().all(ModProviderBinding::valid_coordinates);
    if !valid {
        return Err(PortcoveError::verification(format!(
            "{} has invalid or duplicate mod provider bindings for its reviewed loader",
            port.id
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_provider_scopes_preserve_historical_package_identity() {
        let catalog = crate::Catalog::embedded().unwrap();
        for (id, provider) in [
            ("shipwright", crate::gamebanana::PROVIDER),
            ("zelda64-recomp", crate::thunderstore::PROVIDER),
        ] {
            let port = catalog.port(id).unwrap();
            let prior = legacy_binding(id, provider).unwrap();
            assert_eq!(
                configured_bindings(port),
                Some(std::slice::from_ref(&prior))
            );
            assert_eq!(default_binding(port), Some(prior));
            assert!(reference_matches(
                port,
                &crate::ProviderPackageRef {
                    provider: provider.into(),
                    binding: None,
                    project: "legacy-project".into(),
                    file: Some("legacy-file".into()),
                    version: None,
                },
            ));
        }
    }

    #[test]
    fn explicit_reviewed_scope_is_selected_and_replayed_exactly() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("shipwright").unwrap().clone();
        let legacy = default_binding(&port).unwrap();
        let mut reference = crate::ProviderPackageRef {
            provider: legacy.provider().into(),
            binding: None,
            project: "123".into(),
            file: Some("456".into()),
            version: None,
        };
        assert!(reference_matches(&port, &reference));
        assert!(
            serde_json::to_value(&reference)
                .unwrap()
                .get("binding")
                .is_none()
        );

        let new_scope = ModProviderBinding::Gamebanana { game_id: 32001 };
        let community = ModProviderBinding::Thunderstore {
            community: "owned-fixture".into(),
        };
        port.mod_provider_bindings = Some(vec![new_scope.clone(), community.clone()]);
        validate(&port).unwrap();
        assert!(default_binding(&port).is_none());
        let directory = tempfile::tempdir().unwrap();
        let library = crate::Library::open(directory.path()).unwrap();
        use crate::provider_client::ProviderClient;
        assert!(ProviderClient::for_definition(&library, &port, None).is_err());
        assert_eq!(
            ProviderClient::for_definition(&library, &port, Some("gamebanana"))
                .unwrap()
                .binding(),
            new_scope
        );
        assert_eq!(
            ProviderClient::for_definition(&library, &port, Some("thunderstore"))
                .unwrap()
                .binding(),
            community
        );
        assert!(ProviderClient::for_definition(&library, &port, Some("unreviewed")).is_err());
        assert_eq!(
            reviewed_binding(&port, "gamebanana"),
            Some(new_scope.clone())
        );
        assert_eq!(reviewed_binding(&port, "thunderstore"), Some(community));
        assert!(!reference_matches(&port, &reference));

        reference.binding = Some(new_scope);
        assert!(reference_matches(&port, &reference));
        port.mod_provider_bindings.as_mut().unwrap()[0] = legacy;
        assert!(!reference_matches(&port, &reference));
        let mut withdrawn = port.clone();
        withdrawn.mod_provider_bindings = Some(Vec::new());
        assert!(!reference_matches(&withdrawn, &reference));
        validate_successor(&port, &withdrawn).unwrap();
        let mut implicit = catalog.port("shipwright").unwrap().clone();
        implicit.mod_provider_bindings = None;
        assert!(validate_successor(&withdrawn, &implicit).is_err());
    }

    #[test]
    fn rejects_a_dependency_from_another_reviewed_community() {
        let root = crate::ProviderPackageRef {
            provider: "thunderstore".into(),
            binding: Some(ModProviderBinding::Thunderstore {
                community: "root-community".into(),
            }),
            project: "Owner-Root".into(),
            file: Some("1.0.0".into()),
            version: Some("1.0.0".into()),
        };
        let mut dependency = crate::ProviderRequirement {
            provider: crate::ProviderPackageRef {
                project: "Owner-Dependency".into(),
                ..root.clone()
            },
            members: Default::default(),
        };
        validate_dependency_scope(Some(&root), std::slice::from_ref(&dependency)).unwrap();
        dependency.provider.binding = Some(ModProviderBinding::Thunderstore {
            community: "other".into(),
        });
        assert!(validate_dependency_scope(Some(&root), &[dependency]).is_err());
    }

    #[test]
    fn refuses_duplicate_provider_and_unreviewed_loader() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut port = catalog.port("shipwright").unwrap().clone();
        let binding = default_binding(&port).unwrap();
        port.mod_provider_bindings = Some(vec![binding.clone(), binding.clone()]);
        assert!(validate(&port).is_err());
        port.mod_provider_bindings =
            Some(vec![ModProviderBinding::Gamebanana { game_id: u64::MAX }]);
        assert!(validate(&port).is_err());
        port.id = "unreviewed-port".into();
        port.mod_loader = None;
        port.mod_provider_bindings = Some(vec![binding]);
        assert!(validate(&port).is_err());
    }
}
