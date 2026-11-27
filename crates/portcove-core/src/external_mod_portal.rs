//! Upstream-owned mod websites and read-only catalogs. These grant no download,
//! import or install capability.
use crate::{
    Catalog, ModPortalSite, ModProviderBinding, ModSourceAuthority, ModSourceKind, Platform,
    PortDefinition,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The site family a portal belongs to, for its link label.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalModSite {
    NexusMods,
    ModIo,
    ModDb,
    Quaddicted,
    CommunitySite,
}

/// A read-only provider browser Core can run for a portal.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalModBrowser {
    Quaddicted,
    ModDbFeed,
    ProviderCatalog,
}

/// Exact provider coordinates from an accepted or explicitly selected game page.
/// Use the original path spelling so normalization cannot erase unrelated segments.
fn catalog_scope(link: &str) -> Option<ModProviderBinding> {
    let binding = if let Some(game) = link.strip_prefix("https://gamebanana.com/games/") {
        let game = game.strip_suffix('/').unwrap_or(game);
        let game_id: u64 = game.parse().ok()?;
        if game_id.to_string() != game {
            return None;
        }
        ModProviderBinding::Gamebanana { game_id }
    } else {
        let community = link.strip_prefix("https://thunderstore.io/c/")?;
        ModProviderBinding::Thunderstore {
            community: community.strip_suffix('/').unwrap_or(community).into(),
        }
    };
    binding.valid_coordinates().then_some(binding)
}

fn descriptive_portal(
    source: String,
    site: ExternalModSite,
    name: String,
    url: String,
    instructions: String,
) -> ExternalModPortal {
    let browse_available = catalog_scope(&url).is_some();
    ExternalModPortal {
        source,
        site,
        name,
        url,
        instructions,
        browser: browse_available.then_some(ExternalModBrowser::ProviderCatalog),
        browse_available,
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExternalModPortal {
    /// The declared source ID. Clients pass it back to open a page.
    pub source: String,
    pub site: ExternalModSite,
    /// Player-facing site or collection name from the catalog.
    pub name: String,
    pub url: String,
    /// Catalog-authored setup guide for files from this source.
    pub instructions: String,
    /// The read-only browser this source can use, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<ExternalModBrowser>,
    /// The current port and platform qualify for the optional read-only provider browser.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub browse_available: bool,
}

fn site_label(site: ModPortalSite) -> ExternalModSite {
    match site {
        ModPortalSite::NexusMods => ExternalModSite::NexusMods,
        ModPortalSite::ModIo => ExternalModSite::ModIo,
        ModPortalSite::ModDb => ExternalModSite::ModDb,
        ModPortalSite::CommunitySite => ExternalModSite::CommunitySite,
    }
}

fn portal(
    port: &PortDefinition,
    platform: Option<Platform>,
    source: &crate::ModSource,
) -> Option<ExternalModPortal> {
    let (site, browser, browse_available) = match &source.source {
        ModSourceKind::ExternalPortal { site, .. } => (site_label(*site), None, false),
        ModSourceKind::Quaddicted { .. } => (
            ExternalModSite::Quaddicted,
            Some(ExternalModBrowser::Quaddicted),
            platform
                .is_some_and(|platform| crate::mod_source::quaddicted(port, platform).is_some()),
        ),
        ModSourceKind::ModDbFeed { .. } => (
            ExternalModSite::ModDb,
            Some(ExternalModBrowser::ModDbFeed),
            platform.is_some_and(|platform| {
                crate::quake_mod_browser::moddb_scope(port, platform).is_some()
            }),
        ),
        // GitHub release sources have their own view and inspection route.
        ModSourceKind::GithubRelease { .. } => return None,
    };
    Some(ExternalModPortal {
        source: source.id.clone(),
        site,
        name: source.name.clone()?,
        url: source.link(),
        instructions: source.instructions.clone()?,
        browser,
        browse_available: browse_available && source.allows(ModSourceAuthority::Browse),
    })
}

pub(crate) fn portals(
    catalog: &Catalog,
    id: &str,
    platform: Option<Platform>,
) -> Vec<ExternalModPortal> {
    let port = catalog.port(id).ok();
    let mut sources = Vec::new();
    if let Some(port) = port {
        let presented_platform =
            platform.filter(|platform| crate::mod_source::presented_on(catalog, port, *platform));
        sources.extend(
            port.mod_sources
                .iter()
                .filter(|source| {
                    source.is_platform_independent_portal()
                        || presented_platform.is_some_and(|platform| source.offered_on(platform))
                })
                .filter_map(|source| portal(port, platform, source)),
        );
    }
    if let Ok(listing) = catalog.listing(id)
        && port.is_none_or(|port| {
            port.project_url == listing.project_url
                && crate::catalog::listings::same_original_description(
                    port.presentation
                        .as_ref()
                        .and_then(|presentation| presentation.original_game.as_ref()),
                    listing.original_game.as_ref(),
                )
        })
    {
        sources.extend(
            listing
                .mod_portals
                .iter()
                .filter(|link| {
                    port.is_none_or(|port| {
                        port.mod_sources.iter().all(|source| source.id != link.id)
                    })
                })
                .map(|link| {
                    descriptive_portal(
                        link.id.clone(),
                        site_label(link.site),
                        link.name.clone(),
                        link.url.clone(),
                        link.instructions.clone(),
                    )
                }),
        );
    }
    sources
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AutomaticModPortal {
    pub source: String,
    pub name: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModPortalPreferenceView {
    pub preferences: crate::ModPortalPreferences,
    pub automatic_sources: Vec<AutomaticModPortal>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModPortalsView {
    pub external_mod_portals: Vec<ExternalModPortal>,
    pub mod_portal_preferences: ModPortalPreferenceView,
}

pub(crate) fn project_mod_portals(
    mut offered: Vec<ExternalModPortal>,
    preferences: crate::ModPortalPreferences,
) -> ModPortalsView {
    let automatic_sources = offered
        .iter()
        .map(|portal| AutomaticModPortal {
            source: portal.source.clone(),
            name: portal.name.clone(),
        })
        .collect();
    offered.retain(|portal| {
        preferences
            .choices
            .hidden_sources
            .binary_search(&portal.source)
            .is_err()
    });
    if let Some(page) = &preferences.choices.local_page {
        offered.push(descriptive_portal(
            crate::mod_portal_preferences::LOCAL_PAGE_SOURCE.into(),
            ExternalModSite::CommunitySite,
            page.name.clone(),
            page.url.clone(),
            "Your mod website".into(),
        ));
    }
    ModPortalsView {
        external_mod_portals: offered,
        mod_portal_preferences: ModPortalPreferenceView {
            preferences,
            automatic_sources,
        },
    }
}

impl crate::PortcoveService {
    pub(crate) fn external_provider_scope(
        &self,
        port_id: &str,
        source: &str,
        expected_url: Option<&str>,
    ) -> crate::Result<ModProviderBinding> {
        self.effective_external_mod_portals(port_id, Platform::current().ok())?
            .external_mod_portals
            .iter()
            .find(|portal| {
                portal.source == source
                    && expected_url.is_none_or(|url| portal.url == url)
                    && portal.browse_available
                    && portal.browser == Some(ExternalModBrowser::ProviderCatalog)
            })
            .and_then(|portal| catalog_scope(&portal.url))
            .ok_or_else(|| {
                crate::PortcoveError::unsupported("This source has no supported provider catalog")
            })
    }

    pub(crate) fn effective_external_mod_portals(
        &self,
        port_id: &str,
        platform: Option<Platform>,
    ) -> crate::Result<ModPortalsView> {
        let preferences = self.mod_portal_preferences(port_id)?;
        Ok(project_mod_portals(
            portals(self.catalog(), port_id, platform),
            preferences,
        ))
    }

    /// Recheck that a clicked destination belongs to the selected port and source.
    pub async fn review_external_mod_source_page(
        &self,
        port_id: &str,
        source: &str,
        url: &str,
    ) -> crate::Result<String> {
        let platform = Platform::current().ok();
        let capability = self
            .effective_external_mod_portals(port_id, platform)?
            .external_mod_portals
            .into_iter()
            .find(|portal| portal.source == source)
            .ok_or_else(|| {
                crate::PortcoveError::unsupported("This port has no reviewed route for this source")
            })?;
        if capability.url == url {
            return Ok(capability.url);
        }
        if capability.browse_available
            && let Some(platform) = platform
        {
            match capability.browser {
                Some(ExternalModBrowser::Quaddicted) => {
                    return self.review_quaddicted_page(port_id, platform, url).await;
                }
                Some(ExternalModBrowser::ModDbFeed) => {
                    return self.review_moddb_notice(port_id, platform, url).await;
                }
                Some(ExternalModBrowser::ProviderCatalog) | None => {}
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
    fn only_exact_provider_game_pages_supply_descriptive_coordinates() {
        assert_eq!(
            catalog_scope("https://gamebanana.com/games/16121"),
            Some(ModProviderBinding::Gamebanana { game_id: 16121 })
        );
        assert_eq!(
            catalog_scope("https://thunderstore.io/c/exact-game/"),
            Some(ModProviderBinding::Thunderstore {
                community: "exact-game".into()
            })
        );
        for address in [
            "https://gamebanana.com.evil.example/games/16121",
            "https://gamebanana.com:443/games/16121",
            "https://gamebanana.com/games/+16121",
            "https://gamebanana.com/games/016121",
            "https://gamebanana.com/games/9007199254740992",
            "https://gamebanana.com/games/16121?name=some-game",
            "https://thunderstore.io/c/another/../exact-game",
            "https://thunderstore.io/c/exact-game/p/mod",
            "https://thunderstore.io/c/exact-game#mods",
            "https://thunderstore.io/c/exact%2dgame/",
            "https://thunderstore.io/c/-exact-game/",
        ] {
            assert_eq!(catalog_scope(address), None, "{address}");
        }
    }

    #[test]
    fn listing_and_player_selected_provider_pages_never_supply_install_bindings() {
        let (_temporary, mut service, _) = crate::retained_build::tests::fixture();
        let mut document =
            crate::CatalogListingDocument::from_json(include_str!("../catalog/listings.json"))
                .unwrap();
        let listing = document
            .listings
            .iter_mut()
            .find(|listing| {
                service.catalog().port(&listing.id).is_err()
                    && service.catalog().listing(&listing.id).is_ok()
            })
            .unwrap();
        let id = listing.id.clone();
        listing.mod_portals = vec![crate::ListingModPortal {
            id: "catalog-mods".into(),
            site: ModPortalSite::CommunitySite,
            name: "GameBanana".into(),
            url: "https://gamebanana.com/games/16121".into(),
            instructions: "Browse this community's mods.".into(),
        }];
        document.format_version = document.format_version.max(16);
        service.replace_catalog_for_test(
            service
                .catalog()
                .clone()
                .with_listing_document(document)
                .unwrap(),
        );
        assert!(service.catalog().port(&id).is_err());
        let offered = portals(service.catalog(), &id, None);
        assert_eq!(
            offered[0].browser,
            Some(ExternalModBrowser::ProviderCatalog)
        );
        assert!(offered[0].browse_available);
        assert_eq!(
            service
                .external_provider_scope(
                    &id,
                    "catalog-mods",
                    Some("https://gamebanana.com/games/16121")
                )
                .unwrap(),
            ModProviderBinding::Gamebanana { game_id: 16121 }
        );
        let choices = crate::ModPortalChoices {
            local_page: Some(crate::LocalModPage {
                name: "Thunderstore".into(),
                url: "https://thunderstore.io/c/exact-game/".into(),
            }),
            hidden_sources: vec!["catalog-mods".into()],
        };
        service.set_mod_portal_preferences(&id, 0, choices).unwrap();
        assert!(
            service
                .external_provider_scope(&id, "catalog-mods", None)
                .is_err()
        );
        assert_eq!(
            service
                .external_provider_scope(
                    &id,
                    crate::mod_portal_preferences::LOCAL_PAGE_SOURCE,
                    None
                )
                .unwrap(),
            ModProviderBinding::Thunderstore {
                community: "exact-game".into()
            }
        );
        assert!(
            service
                .external_provider_scope(
                    &id,
                    crate::mod_portal_preferences::LOCAL_PAGE_SOURCE,
                    Some("https://thunderstore.io/c/previous-community/")
                )
                .is_err()
        );
        assert!(service.catalog().port(&id).is_err());
    }

    #[tokio::test]
    async fn a_browser_only_link_checks_port_source_and_exact_page_before_opening() {
        let root = tempfile::tempdir().unwrap();
        let library = crate::Library::open(root.path().join("library")).unwrap();
        let service = crate::PortcoveService::new_read_only(library).unwrap();
        let platform = Platform::current().unwrap();
        let (port, portal) = service
            .catalog()
            .ports()
            .iter()
            .find_map(|port| {
                portals(service.catalog(), &port.id, Some(platform))
                    .into_iter()
                    .find(|portal| portal.browser.is_none())
                    .map(|portal| (port.id.clone(), portal))
            })
            .expect("the catalog declares a link-out portal on this host");
        assert_eq!(
            service
                .review_external_mod_source_page(&port, &portal.source, &portal.url)
                .await
                .unwrap(),
            portal.url
        );
        assert!(
            service
                .review_external_mod_source_page(
                    &port,
                    &portal.source,
                    &format!("{}?download=true", portal.url)
                )
                .await
                .is_err()
        );
        assert!(
            service
                .review_external_mod_source_page("starship", &portal.source, &portal.url)
                .await
                .is_err()
        );
        assert!(
            service
                .review_external_mod_source_page(&port, "undeclared-source", &portal.url)
                .await
                .is_err()
        );
    }

    #[test]
    fn public_profile_reads_surface_portals_before_installation() {
        let root = tempfile::tempdir().unwrap();
        let library = crate::Library::open(root.path().join("library")).unwrap();
        let service = crate::PortcoveService::new_read_only(library).unwrap();
        let platform = Platform::current().unwrap();
        let mut seen = 0;
        for port in service.catalog().ports() {
            if portals(service.catalog(), &port.id, Some(platform)).is_empty() {
                continue;
            }
            seen += 1;
            let desktop = service.preview_mod_handoff(&port.id).unwrap();
            let cli = service.mod_setups(&port.id).unwrap();
            assert!(!desktop.external_mod_portals.is_empty());
            assert_eq!(desktop.external_mod_portals, cli.external_mod_portals);
        }
        assert!(seen > 0);
    }

    #[test]
    fn unrelated_ports_and_unlisted_platforms_do_not_inherit_portals() {
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
