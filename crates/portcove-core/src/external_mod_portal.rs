use crate::{Catalog, Platform};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Upstream-owned browser routes. These grant no download or import capability.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalModPortalSource {
    NexusDaggerfallUnity,
    CoopDx,
    ModIoOpenXcom,
    Quaddicted,
    ModDbOpenXcom,
    ModDbArcaneDimensions,
}

impl ExternalModPortalSource {
    pub fn url(self) -> &'static str {
        match self {
            Self::NexusDaggerfallUnity => "https://www.nexusmods.com/games/daggerfallunity/mods",
            Self::CoopDx => "https://mods.sm64coopdx.com/mods/",
            Self::ModIoOpenXcom => "https://mod.io/g/openxcom/",
            Self::Quaddicted => "https://www.quaddicted.com/db/v2/",
            Self::ModDbOpenXcom => "https://www.moddb.com/games/openxcom/mods",
            Self::ModDbArcaneDimensions => "https://www.moddb.com/mods/arcane-dimensions/downloads",
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExternalModPortal {
    pub source: ExternalModPortalSource,
    pub url: String,
    /// The current port and platform qualify for the optional read-only provider browser.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub browse_available: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    port: String,
    game: String,
    project: String,
    platforms: Vec<Platform>,
    portals: Vec<ExternalModPortalSource>,
}

fn bindings() -> &'static [Binding] {
    static BINDINGS: std::sync::OnceLock<Vec<Binding>> = std::sync::OnceLock::new();
    BINDINGS.get_or_init(|| {
        serde_json::from_str(include_str!("../catalog/external-mod-portals.json"))
            .expect("bundled mod portal bindings must be valid")
    })
}

fn matching_binding(catalog: &Catalog, id: &str, platform: Platform) -> Option<&'static Binding> {
    let listing = catalog.listings().iter().find(|listing| listing.id == id);
    let port = catalog.port(id).ok();
    let (project, game) = if let Some(port) = port {
        (
            port.project_url.as_str(),
            port.presentation
                .as_ref()
                .and_then(|value| value.original_game.as_ref()),
        )
    } else {
        let listing = listing?;
        (listing.project_url.as_str(), listing.original_game.as_ref())
    };
    let game = game?;
    let defined_platform = port.is_some_and(|port| port.platforms.contains(&platform));
    let listed_platform = listing.is_some_and(|listing| {
        listing.project_url == project
            && listing
                .original_game
                .as_ref()
                .is_some_and(|value| value.id == game.id)
            && listing.platforms.contains(&platform)
    });
    if !defined_platform && !listed_platform {
        return None;
    }
    bindings().iter().find(|binding| {
        binding.port == id
            && binding.game == game.id
            && binding.project == project
            && binding.platforms.contains(&platform)
    })
}

pub(crate) fn require_binding(
    catalog: &Catalog,
    id: &str,
    platform: Platform,
    source: ExternalModPortalSource,
) -> crate::Result<()> {
    if matching_binding(catalog, id, platform)
        .is_some_and(|binding| binding.portals.contains(&source))
    {
        return Ok(());
    }
    Err(crate::PortcoveError::unsupported(
        "This port has no reviewed route for this source",
    ))
}

pub(crate) fn portals(
    catalog: &Catalog,
    id: &str,
    platform: Option<Platform>,
) -> Vec<ExternalModPortal> {
    let Some(platform) = platform else {
        return Vec::new();
    };
    let port = catalog.port(id).ok();
    matching_binding(catalog, id, platform)
        .into_iter()
        .flat_map(|binding| &binding.portals)
        .map(|source| ExternalModPortal {
            source: *source,
            url: source.url().into(),
            browse_available: port.is_some_and(|port| match source {
                ExternalModPortalSource::Quaddicted => {
                    crate::quaddicted::source(port, platform).is_some()
                }
                ExternalModPortalSource::ModDbArcaneDimensions => {
                    crate::quake_mod_browser::has_moddb_notices(port, platform)
                }
                _ => false,
            }),
        })
        .collect()
}

impl crate::PortcoveService {
    /// Recheck that a clicked destination belongs to the selected port and source.
    pub async fn review_external_mod_source_page(
        &self,
        port_id: &str,
        source: ExternalModPortalSource,
        url: &str,
    ) -> crate::Result<String> {
        let platform = Platform::current()?;
        let capability = portals(self.catalog(), port_id, Some(platform))
            .into_iter()
            .find(|portal| portal.source == source)
            .ok_or_else(|| {
                crate::PortcoveError::unsupported("This port has no reviewed route for this source")
            })?;
        if capability.url == url {
            return Ok(capability.url);
        }
        if capability.browse_available {
            match source {
                ExternalModPortalSource::Quaddicted => {
                    return self.review_quaddicted_page(port_id, platform, url).await;
                }
                ExternalModPortalSource::ModDbArcaneDimensions => {
                    return self.review_moddb_notice(port_id, platform, url).await;
                }
                _ => {}
            }
        }
        Err(crate::PortcoveError::verification(
            "This page is outside the reviewed portal",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_reviewed_route_matches_the_current_catalog() {
        let catalog = Catalog::embedded().unwrap();
        assert_eq!(bindings().len(), 6);
        for binding in bindings() {
            for &platform in &binding.platforms {
                let offered = portals(&catalog, &binding.port, Some(platform));
                assert_eq!(
                    offered
                        .iter()
                        .map(|portal| portal.source)
                        .collect::<Vec<_>>(),
                    binding.portals,
                    "{} {platform:?}",
                    binding.port
                );
                for portal in offered {
                    assert_eq!(portal.url, portal.source.url());
                }
            }
        }
    }

    #[test]
    fn discovery_and_prefetch_revoke_routes_after_project_or_game_identity_drift() {
        let embedded = Catalog::embedded().unwrap();
        let id = "quake-vkquake";
        let platform = Platform::LinuxX86_64;
        let sources = [
            ExternalModPortalSource::Quaddicted,
            ExternalModPortalSource::ModDbArcaneDimensions,
        ];
        for source in sources {
            require_binding(&embedded, id, platform, source).unwrap();
        }
        for change_project in [false, true] {
            let mut document = embedded.authoritative_document();
            let port = document
                .ports
                .iter_mut()
                .find(|port| port.id == id)
                .unwrap();
            if change_project {
                port.project_url = "https://example.org/another-quake-engine".into();
            } else {
                port.presentation
                    .as_mut()
                    .unwrap()
                    .original_game
                    .as_mut()
                    .unwrap()
                    .id = "different-game".into();
            }
            assert_eq!(port.release.repository, "Novum/vkQuake");
            let changed = Catalog::from_document(document).unwrap();
            assert!(portals(&changed, id, Some(platform)).is_empty());
            for source in sources {
                assert!(require_binding(&changed, id, platform, source).is_err());
            }
        }
    }

    #[test]
    fn public_profile_reads_surface_portals_before_installation() {
        let root = tempfile::tempdir().unwrap();
        let library = crate::Library::open(root.path().join("library")).unwrap();
        let service = crate::PortcoveService::new_read_only(library).unwrap();
        let platform = Platform::current().unwrap();
        for binding in bindings()
            .iter()
            .filter(|binding| binding.platforms.contains(&platform))
        {
            let desktop = service.preview_mod_handoff(&binding.port).unwrap();
            let cli = service.mod_setups(&binding.port).unwrap();
            assert!(!desktop.supported);
            assert!(!cli.supported);
            assert!(!desktop.external_mod_portals.is_empty());
            assert_eq!(desktop.external_mod_portals, cli.external_mod_portals);
        }
    }

    #[tokio::test]
    async fn a_browser_only_link_checks_port_source_and_exact_page_before_opening() {
        let root = tempfile::tempdir().unwrap();
        let library = crate::Library::open(root.path().join("library")).unwrap();
        let service = crate::PortcoveService::new_read_only(library).unwrap();
        let source = ExternalModPortalSource::CoopDx;
        let url = source.url();
        let port = "super-mario-64-sm64-co-op-dx";
        assert_eq!(
            service
                .review_external_mod_source_page(port, source, url)
                .await
                .unwrap(),
            url
        );
        assert!(
            service
                .review_external_mod_source_page(port, source, &format!("{url}?download=true"))
                .await
                .is_err()
        );
        assert!(
            service
                .review_external_mod_source_page("starship", source, url)
                .await
                .is_err()
        );
        assert!(
            service
                .review_external_mod_source_page(
                    port,
                    ExternalModPortalSource::NexusDaggerfallUnity,
                    url
                )
                .await
                .is_err()
        );
    }

    #[test]
    fn unrelated_ports_unknown_hosts_and_unlisted_platforms_do_not_inherit_portals() {
        let catalog = Catalog::embedded().unwrap();
        assert!(portals(&catalog, "starship", Some(Platform::WindowsX86_64)).is_empty());
        assert!(portals(&catalog, "interkarma-daggerfall-unity", None).is_empty());
        assert!(
            portals(
                &catalog,
                "interkarma-daggerfall-unity",
                Some(Platform::MacosAarch64)
            )
            .is_empty()
        );
    }
}
