use std::collections::BTreeSet;

use super::*;
use crate::{CatalogDocument, ModProviderBinding};

const PLATFORMS: [Platform; 4] = [
    Platform::WindowsX86_64,
    Platform::LinuxX86_64,
    Platform::MacosX86_64,
    Platform::MacosAarch64,
];

/// A port id that appears nowhere outside tests. It gains and loses each
/// source kind through its definition alone.
const FIXTURE_ID: &str = "data-only-mod-source-fixture";

/// The compiled authority this change retired, frozen exactly as it was last
/// released, with the resolution rules that read it. The equivalence test
/// keeps today's ports unchanged by comparing it with the data declarations.
mod retired {
    use super::*;

    pub(super) struct Portal {
        pub port: &'static str,
        pub game: &'static str,
        pub project: &'static str,
        pub platforms: &'static [Platform],
        pub portals: &'static [&'static str],
    }

    use Platform::{LinuxX86_64 as L, MacosAarch64 as MA, MacosX86_64 as MX, WindowsX86_64 as W};

    /// `catalog/external-mod-portals.json` before its removal.
    pub(super) const PORTALS: &[Portal] = &[
        Portal {
            port: "interkarma-daggerfall-unity",
            game: "the-elder-scrolls-ii-daggerfall",
            project: "https://github.com/Interkarma/daggerfall-unity",
            platforms: &[L, MX, W],
            portals: &["nexus-daggerfall-unity"],
        },
        Portal {
            port: "super-mario-64-sm64-co-op-dx",
            game: "super-mario-64",
            project: "https://github.com/coop-deluxe/sm64coopdx",
            platforms: &[L, MA, MX, W],
            portals: &["coop-dx"],
        },
        Portal {
            port: "ufo-enemy-unknown-x-com-ufo-defense-openxcom",
            game: "ufo-enemy-unknown-x-com-ufo-defense",
            project: "https://github.com/OpenXcom/OpenXcom",
            platforms: &[L, MA, MX, W],
            portals: &["mod-io-open-xcom", "mod-db-open-xcom"],
        },
        Portal {
            port: "x-com-terror-from-the-deep-openxcom",
            game: "x-com-terror-from-the-deep",
            project: "https://github.com/OpenXcom/OpenXcom",
            platforms: &[L, MA, MX, W],
            portals: &["mod-io-open-xcom", "mod-db-open-xcom"],
        },
        Portal {
            port: "quake-vkquake",
            game: "quake",
            project: "https://github.com/Novum/vkQuake",
            platforms: &[L, MA, MX, W],
            portals: &["quaddicted", "mod-db-arcane-dimensions"],
        },
        Portal {
            port: "quake-ironwail",
            game: "quake",
            project: "https://github.com/andrei-drexler/ironwail",
            platforms: &[W, L],
            portals: &["quaddicted"],
        },
    ];

    /// `ExternalModPortalSource::url` before its removal.
    pub(super) fn portal_url(source: &str) -> &'static str {
        match source {
            "nexus-daggerfall-unity" => "https://www.nexusmods.com/games/daggerfallunity/mods",
            "coop-dx" => "https://mods.sm64coopdx.com/mods/",
            "mod-io-open-xcom" => "https://mod.io/g/openxcom/",
            "quaddicted" => "https://www.quaddicted.com/db/v2/",
            "mod-db-open-xcom" => "https://www.moddb.com/games/openxcom/mods",
            "mod-db-arcane-dimensions" => "https://www.moddb.com/mods/arcane-dimensions/downloads",
            other => panic!("unknown retired portal {other}"),
        }
    }

    /// `quaddicted::source` before its removal.
    pub(super) fn quaddicted(port: &PortDefinition, platform: Platform) -> Option<QuakeEngine> {
        if port.adapter != AdapterKind::NativePortable
            || port.release.provider != ReleaseSource::Github
            || !matches!(platform, Platform::WindowsX86_64 | Platform::LinuxX86_64)
            || !port.platforms.contains(&platform)
        {
            return None;
        }
        match (port.id.as_str(), port.release.repository.as_str()) {
            ("quake-vkquake", "Novum/vkQuake") => Some(QuakeEngine::VkQuake),
            ("quake-ironwail", "andrei-drexler/ironwail") => Some(QuakeEngine::Ironwail),
            _ => None,
        }
    }

    /// `moddb_feed::PORT_ID` and `FILES_PAGE` with `has_moddb_notices`.
    pub(super) fn moddb(port: &PortDefinition, platform: Platform) -> Option<&'static str> {
        (port.id == "quake-vkquake" && quaddicted(port, platform) == Some(QuakeEngine::VkQuake))
            .then_some("https://www.moddb.com/mods/arcane-dimensions/downloads")
    }

    /// `external_mod_portal::matching_binding` and `portals` before removal:
    /// (source, url, browse available).
    pub(super) fn portals(
        catalog: &Catalog,
        id: &str,
        platform: Platform,
    ) -> Vec<(String, String, bool)> {
        let listing = catalog.listings().iter().find(|listing| listing.id == id);
        let port = catalog.port(id).ok();
        let (project, game) = if let Some(port) = port {
            (
                port.project_url.as_str(),
                port.presentation
                    .as_ref()
                    .and_then(|value| value.original_game.as_ref()),
            )
        } else if let Some(listing) = listing {
            (listing.project_url.as_str(), listing.original_game.as_ref())
        } else {
            return Vec::new();
        };
        let Some(game) = game else {
            return Vec::new();
        };
        let defined = port.is_some_and(|port| port.platforms.contains(&platform));
        let listed = listing.is_some_and(|listing| {
            listing.project_url == project
                && listing
                    .original_game
                    .as_ref()
                    .is_some_and(|value| value.id == game.id)
                && listing.platforms.contains(&platform)
        });
        if !defined && !listed {
            return Vec::new();
        }
        PORTALS
            .iter()
            .find(|binding| {
                binding.port == id
                    && binding.game == game.id
                    && binding.project == project
                    && binding.platforms.contains(&platform)
            })
            .into_iter()
            .flat_map(|binding| binding.portals)
            .map(|source| {
                let browse = port.is_some_and(|port| match *source {
                    "quaddicted" => quaddicted(port, platform).is_some(),
                    "mod-db-arcane-dimensions" => moddb(port, platform).is_some(),
                    _ => false,
                });
                ((*source).to_owned(), portal_url(source).to_owned(), browse)
            })
            .collect()
    }

    /// `github_mods::SOURCES` and `reviewed_source` before removal:
    /// (releases page, repository id, asset, companion platforms).
    pub(super) fn github(port: &PortDefinition) -> Option<(String, u64, String, Vec<Platform>)> {
        let loader = crate::profile_loader::configured_loader(port)?;
        (loader.engine == ModEngine::N64Recomp
            && port
                .release
                .repository
                .eq_ignore_ascii_case("Zelda64Recomp/Zelda64Recomp")
            && loader.native_game.as_deref() == Some("mm"))
        .then(|| {
            (
                "https://github.com/RecompRando/MMRecompRando/releases".to_owned(),
                854_379_059,
                "MMRecompRando.zip".to_owned(),
                vec![W, L],
            )
        })
    }

    /// The exact companion files `SOURCES` reviewed for each platform.
    pub(super) fn companions(
        platform: Platform,
    ) -> Option<(&'static str, &'static [&'static str])> {
        match platform {
            W => Some(("APCpp-Glue", &["APCpp-Glue.dll", "python311.dll"])),
            L => Some(("APCpp-Glue", &["APCpp-Glue.so", "libpython3.11.so.1.0"])),
            _ => None,
        }
    }
}

fn data_portals(catalog: &Catalog, id: &str, platform: Platform) -> Vec<(String, String, bool)> {
    crate::external_mod_portal::portals(catalog, id, Some(platform))
        .into_iter()
        .map(|portal| (portal.source, portal.url, portal.browse_available))
        .collect()
}

fn data_github(
    port: &PortDefinition,
    platform: Platform,
) -> Option<(String, u64, String, Vec<Platform>)> {
    let source = github(port, platform)?;
    Some((
        crate::github_mods::github_mod_release_url(port, Some(platform))?,
        source.repository_id,
        source.asset_name.to_owned(),
        PLATFORMS
            .into_iter()
            .filter(|platform| source.inspection_layout(*platform).is_some())
            .collect(),
    ))
}

#[test]
fn data_declarations_resolve_exactly_like_the_retired_compiled_tables() {
    let catalog = Catalog::embedded().unwrap();
    let legacy = catalog
        .listing_document()
        .export_format(crate::acquisition_restriction::RESTRICTION_LISTING_FORMAT)
        .unwrap();
    let catalog = catalog.with_listing_document(legacy).unwrap();
    let ids: BTreeSet<&str> = catalog
        .ports()
        .iter()
        .map(|port| port.id.as_str())
        .chain(catalog.listings().iter().map(|listing| listing.id.as_str()))
        .collect();
    let (mut portals, mut github_ports, mut browsers) = (0, 0, 0);
    for id in &ids {
        for platform in PLATFORMS {
            let old = retired::portals(&catalog, id, platform);
            assert_eq!(
                data_portals(&catalog, id, platform),
                old,
                "{id} {platform:?}"
            );
            portals += old.len();
            let Ok(port) = catalog.port(id) else { continue };
            assert_eq!(
                quaddicted(port, platform),
                retired::quaddicted(port, platform),
                "{id} {platform:?}"
            );
            assert_eq!(
                crate::quake_mod_browser::moddb_scope(port, platform).map(|scope| scope.page),
                retired::moddb(port, platform).map(str::to_owned),
                "{id} {platform:?}"
            );
            browsers += usize::from(retired::quaddicted(port, platform).is_some());
            let old = retired::github(port);
            assert_eq!(data_github(port, platform), old, "{id} {platform:?}");
            if let Some(source) = github(port, platform) {
                github_ports += 1;
                // Browsing and private inspection authority are unchanged.
                assert!(source.authority >= ModSourceAuthority::Browse);
                for layout_platform in PLATFORMS {
                    let layout = source.inspection_layout(layout_platform).map(|layout| {
                        (
                            layout.declared_library.as_str(),
                            layout.files.iter().map(String::as_str).collect::<Vec<_>>(),
                        )
                    });
                    let old = retired::companions(layout_platform)
                        .map(|(library, files)| (library, files.to_vec()));
                    assert_eq!(layout, old, "{id} {layout_platform:?}");
                }
                assert_eq!(source.game().as_deref(), Some("mm"));
            }
        }
    }
    // Every retired row was exercised, not just absent on both sides.
    // Daggerfall 3, Co-op DX 4, two OpenXcom games 2 x 4 x 2, vkQuake 4 x 2, Ironwail 2.
    assert_eq!(portals, 3 + 4 + 16 + 8 + 2);
    assert_eq!(github_ports, 4);
    assert_eq!(browsers, 4);
}

#[test]
fn no_mod_source_reaches_an_install_path() {
    let catalog = Catalog::embedded().unwrap();
    let mut declared = 0;
    for port in catalog.ports() {
        for source in &port.mod_sources {
            declared += 1;
            assert!(!grants_install(source));
            assert!(source.authority <= ModSourceAuthority::Inspect);
        }
        // Install helpers read only reviewed provider bindings.
        let installable: Vec<_> = crate::provider_binding::bindings(port);
        for binding in &installable {
            assert!(matches!(
                binding,
                ModProviderBinding::Gamebanana { .. } | ModProviderBinding::Thunderstore { .. }
            ));
        }
        let mut without_sources = port.clone();
        without_sources.mod_sources.clear();
        assert_eq!(
            crate::provider_binding::default_binding(port),
            crate::provider_binding::default_binding(&without_sources),
            "{}",
            port.id
        );
        for provider in [
            "gamebanana",
            "thunderstore",
            "github",
            "quaddicted",
            "moddb",
        ] {
            assert_eq!(
                crate::provider_binding::reviewed_binding(port, provider),
                crate::provider_binding::reviewed_binding(&without_sources, provider),
                "{} {provider}",
                port.id
            );
        }
    }
    assert_eq!(declared, 10);
}

/// The catalog with one renamed copy of an existing definition of the wanted
/// shape. Some definitions carry title guards that refuse a renamed copy, so
/// the first template that validates is used.
fn fixture_catalog(shape: Shape, sources: Vec<ModSource>) -> Catalog {
    let embedded = Catalog::embedded().unwrap();
    let mut refusals = Vec::new();
    for template in embedded.ports().iter().filter(|port| shape.matches(port)) {
        let mut document: CatalogDocument = embedded.authoritative_document();
        let mut port = template.clone();
        port.id = FIXTURE_ID.into();
        port.mod_provider_bindings = None;
        port.mod_sources = sources.clone();
        if matches!(shape, Shape::Recomp) {
            // The copy needs no original-source contract of its own.
            port.source_profile = None;
            port.source_environment = None;
            port.runtime_source_filename = None;
            port.runtime_source_materialization = None;
            port.runtime_source_hashes.clear();
            port.runtime_source_set.clear();
            port.presentation = None;
        }
        document.ports.push(port);
        match Catalog::from_document(document) {
            Ok(catalog) => return catalog,
            Err(error) => refusals.push(format!("{}: {}", template.id, error.message)),
        }
    }
    panic!("no definition can serve as the fixture template: {refusals:#?}");
}

#[derive(Clone, Copy)]
enum Shape {
    /// A NativePortable GitHub release route on Windows and Linux.
    QuakeBrowser,
    /// A definition with a reviewed N64 Recomp loader and native game.
    Recomp,
}

impl Shape {
    fn matches(self, port: &PortDefinition) -> bool {
        match self {
            Self::QuakeBrowser => {
                port.mod_loader.is_none()
                    && quake_browser_platform(port, Platform::LinuxX86_64)
                    && quake_browser_platform(port, Platform::WindowsX86_64)
            }
            Self::Recomp => port.mod_loader.as_ref().is_some_and(|_| {
                crate::profile_loader::configured_loader(port).is_some_and(|loader| {
                    loader.engine == ModEngine::N64Recomp && loader.native_game.is_some()
                })
            }),
        }
    }
}

fn source(id: &str, authority: ModSourceAuthority, kind: ModSourceKind) -> ModSource {
    let github = matches!(kind, ModSourceKind::GithubRelease { .. });
    ModSource {
        id: id.into(),
        authority,
        platforms: PLATFORMS.to_vec(),
        name: (!github).then(|| "Fixture mods".into()),
        instructions: (!github).then(|| "Follow the author’s setup.".into()),
        source: kind,
    }
}

fn portal(url: &str, site: ModPortalSite) -> ModSource {
    source(
        "fixture-portal",
        ModSourceAuthority::LinkOut,
        ModSourceKind::ExternalPortal {
            site,
            url: url.into(),
        },
    )
}

fn fixture_github(authority: ModSourceAuthority) -> ModSource {
    source(
        "fixture-releases",
        authority,
        ModSourceKind::GithubRelease {
            repository: "fixture-owner/fixture-mods".into(),
            repository_id: 42,
            asset_name: "fixture.zip".into(),
            companions: if authority == ModSourceAuthority::Inspect {
                vec![ModCompanionLayout {
                    platform: Platform::LinuxX86_64,
                    declared_library: "Glue".into(),
                    files: vec!["Glue.so".into()],
                }]
            } else {
                Vec::new()
            },
        },
    )
}

#[test]
fn a_fixture_only_port_gains_and_loses_each_source_kind_by_data_alone() {
    let linux = Platform::LinuxX86_64;
    // The fixture id is absent from every non-test source file.
    for root in ["src", "../portcove-cli/src", "../../scripts"] {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(root);
        let mut stack = vec![base];
        while let Some(path) = stack.pop() {
            if path.is_dir() {
                stack.extend(
                    std::fs::read_dir(&path)
                        .unwrap()
                        .map(|entry| entry.unwrap().path()),
                );
            } else if !path.to_string_lossy().contains("test")
                && let Ok(text) = std::fs::read_to_string(&path)
            {
                assert!(!text.contains(FIXTURE_ID), "{}", path.display());
            }
        }
    }

    let quake = Shape::QuakeBrowser;
    let empty = fixture_catalog(quake, Vec::new());
    let port = empty.port(FIXTURE_ID).unwrap();
    assert!(crate::external_mod_portal::portals(&empty, FIXTURE_ID, Some(linux)).is_empty());
    assert!(quaddicted(port, linux).is_none());
    assert!(crate::quake_mod_browser::moddb_scope(port, linux).is_none());

    // External portal: link-out only.
    let catalog = fixture_catalog(
        quake,
        vec![portal(
            "https://mods.example.org/fixture/",
            ModPortalSite::CommunitySite,
        )],
    );
    let offered = crate::external_mod_portal::portals(&catalog, FIXTURE_ID, Some(linux));
    assert_eq!(offered.len(), 1);
    assert_eq!(offered[0].url, "https://mods.example.org/fixture/");
    assert!(!offered[0].browse_available && offered[0].browser.is_none());

    assert!(crate::external_mod_portal::portals(&catalog, FIXTURE_ID, None).is_empty());
    let mut website = catalog.port(FIXTURE_ID).unwrap().mod_sources[0].clone();
    website.platforms.clear();
    let catalog = fixture_catalog(quake, vec![website]);
    assert_eq!(
        crate::external_mod_portal::portals(&catalog, FIXTURE_ID, None),
        offered
    );

    // Quaddicted and Mod DB feeds: browse on the adapter's platforms.
    let browsers = fixture_catalog(
        quake,
        vec![
            source(
                "fixture-quaddicted",
                ModSourceAuthority::Browse,
                ModSourceKind::Quaddicted {
                    engine: QuakeEngine::Ironwail,
                },
            ),
            source(
                "fixture-moddb",
                ModSourceAuthority::Browse,
                ModSourceKind::ModDbFeed {
                    url: "https://www.moddb.com/mods/fixture-mod/downloads".into(),
                },
            ),
        ],
    );
    let catalog = &browsers;
    let port = catalog.port(FIXTURE_ID).unwrap();
    assert_eq!(quaddicted(port, linux), Some(QuakeEngine::Ironwail));
    assert_eq!(
        crate::quake_mod_browser::moddb_scope(port, linux)
            .unwrap()
            .feed,
        "https://rss.moddb.com/mods/fixture-mod/downloads/feed/rss.xml"
    );
    let offered = crate::external_mod_portal::portals(catalog, FIXTURE_ID, Some(linux));
    assert_eq!(offered.len(), 2);
    assert!(offered.iter().all(|portal| portal.browse_available));
    // Declared link-out authority keeps the link and withholds the browser.
    let catalog = fixture_catalog(
        quake,
        port.mod_sources
            .iter()
            .cloned()
            .map(|mut source| {
                source.authority = ModSourceAuthority::LinkOut;
                source
            })
            .collect(),
    );
    let port = catalog.port(FIXTURE_ID).unwrap();
    assert!(quaddicted(port, linux).is_none());
    assert!(crate::quake_mod_browser::moddb_scope(port, linux).is_none());
    let offered = crate::external_mod_portal::portals(&catalog, FIXTURE_ID, Some(linux));
    assert_eq!(offered.len(), 2);
    assert!(offered.iter().all(|portal| !portal.browse_available));

    // GitHub releases: browse and inspect follow the declared authority and
    // the port's own reviewed Recomp loader.
    let recomp = Shape::Recomp;
    let catalog = fixture_catalog(recomp, Vec::new());
    let port = catalog.port(FIXTURE_ID).unwrap();
    assert!(github(port, linux).is_none());
    assert!(crate::github_mods::github_mod_release_url(port, Some(linux)).is_none());
    let catalog = fixture_catalog(recomp, vec![fixture_github(ModSourceAuthority::Browse)]);
    let port = catalog.port(FIXTURE_ID).unwrap();
    assert_eq!(
        crate::github_mods::github_mod_release_url(port, Some(linux)).as_deref(),
        Some("https://github.com/fixture-owner/fixture-mods/releases")
    );
    assert!(
        github(port, linux)
            .unwrap()
            .inspection_layout(linux)
            .is_none()
    );
    let catalog = fixture_catalog(recomp, vec![fixture_github(ModSourceAuthority::Inspect)]);
    let port = catalog.port(FIXTURE_ID).unwrap();
    let declared = github(port, linux).unwrap();
    assert_eq!(
        declared.inspection_layout(linux).unwrap().files,
        ["Glue.so"]
    );
    assert!(
        declared
            .inspection_layout(Platform::WindowsX86_64)
            .is_none()
    );

    // None of them confers an install binding on the fixture.
    for catalog in [&catalog, &browsers] {
        let port = catalog.port(FIXTURE_ID).unwrap();
        assert!(crate::provider_binding::default_binding(port).is_none());
        assert!(crate::provider_binding::bindings(port).is_empty());
        for provider in ["gamebanana", "thunderstore", "github"] {
            assert!(crate::provider_binding::reviewed_binding(port, provider).is_none());
        }
    }
}

fn validated(template: &str, sources: Vec<ModSource>) -> Result<()> {
    let catalog = Catalog::embedded().unwrap();
    let mut port = catalog.port(template).unwrap().clone();
    port.mod_sources = sources;
    validate(&port)
}

#[test]
fn authority_cannot_exceed_the_source_kind_or_its_reviewed_loader() {
    let mut over = portal("https://mods.example.org/", ModPortalSite::CommunitySite);
    over.authority = ModSourceAuthority::Browse;
    assert!(validated("quake-ironwail", vec![over]).is_err());
    let mut over = source(
        "q",
        ModSourceAuthority::Inspect,
        ModSourceKind::Quaddicted {
            engine: QuakeEngine::VkQuake,
        },
    );
    assert!(validated("quake-ironwail", vec![over.clone()]).is_err());
    over.authority = ModSourceAuthority::Browse;
    validated("quake-ironwail", vec![over]).unwrap();
    // Inspection needs a reviewed Recomp loader and companion layouts.
    assert!(
        validated(
            "quake-ironwail",
            vec![fixture_github(ModSourceAuthority::Inspect)]
        )
        .is_err()
    );
    validated(
        "zelda64-recomp",
        vec![fixture_github(ModSourceAuthority::Inspect)],
    )
    .unwrap();
    let mut no_layouts = fixture_github(ModSourceAuthority::Inspect);
    if let ModSourceKind::GithubRelease { companions, .. } = &mut no_layouts.source {
        companions.clear();
    }
    assert!(validated("zelda64-recomp", vec![no_layouts]).is_err());
    // Layouts without inspect authority are refused rather than ignored.
    let mut browse = fixture_github(ModSourceAuthority::Inspect);
    browse.authority = ModSourceAuthority::Browse;
    assert!(validated("zelda64-recomp", vec![browse]).is_err());
    // An unknown authority or kind is refused for this definition.
    for bad in [
        serde_json::json!({"id":"x","authority":"install","platforms":["linux-x86-64"],
            "name":"X","instructions":"Use it.","source":{"kind":"quaddicted","engine":"ironwail"}}),
        serde_json::json!({"id":"x","authority":"link_out","platforms":["linux-x86-64"],
            "name":"X","instructions":"Use it.","source":{"kind":"future_feed","url":"https://example.org/"}}),
        serde_json::json!({"id":"x","authority":"link_out","platforms":["linux-x86-64"],
            "name":"X","instructions":"Use it.","extra":true,
            "source":{"kind":"quaddicted","engine":"ironwail"}}),
    ] {
        assert!(serde_json::from_value::<ModSource>(bad).is_err());
    }
}

#[test]
fn declarations_are_bounded_unique_and_ordered() {
    let a = portal("https://mods.example.org/a", ModPortalSite::CommunitySite);
    let mut b = a.clone();
    assert!(validated("quake-ironwail", vec![a.clone(), b.clone()]).is_err());
    b.id = "other".into();
    validated("quake-ironwail", vec![a.clone(), b]).unwrap();
    let mut unsorted = a.clone();
    unsorted.platforms = vec![Platform::LinuxX86_64, Platform::WindowsX86_64];
    assert!(validated("quake-ironwail", vec![unsorted]).is_err());
    let mut unscoped_feed = source(
        "fixture-moddb",
        ModSourceAuthority::Browse,
        ModSourceKind::ModDbFeed {
            url: "https://www.moddb.com/mods/fixture-mod/downloads".into(),
        },
    );
    unscoped_feed.platforms.clear();
    assert!(validated("quake-ironwail", vec![unscoped_feed]).is_err());
    for id in [
        "",
        "Upper",
        "-lead",
        "trail-",
        "under_score",
        &"x".repeat(65),
    ] {
        let mut bad = a.clone();
        bad.id = id.into();
        assert!(validated("quake-ironwail", vec![bad]).is_err(), "{id}");
    }
    let mut unnamed = a.clone();
    unnamed.name = None;
    assert!(validated("quake-ironwail", vec![unnamed]).is_err());
    let mut markup = a.clone();
    markup.instructions = Some("<b>bold</b>".into());
    assert!(validated("quake-ironwail", vec![markup]).is_err());
    let mut github_copy = fixture_github(ModSourceAuthority::Browse);
    github_copy.name = Some("Releases".into());
    assert!(validated("zelda64-recomp", vec![github_copy]).is_err());
    let feeds = |id: &str| {
        source(
            id,
            ModSourceAuthority::Browse,
            ModSourceKind::Quaddicted {
                engine: QuakeEngine::Ironwail,
            },
        )
    };
    assert!(validated("quake-ironwail", vec![feeds("one"), feeds("two")]).is_err());
    let many = (0..9)
        .map(|index| {
            let mut next = a.clone();
            next.id = format!("portal-{index}");
            next
        })
        .collect();
    assert!(validated("quake-ironwail", many).is_err());
}

#[test]
fn data_declared_addresses_are_canonical_https_on_the_site_host() {
    let check = |url: &str, site| validated("quake-ironwail", vec![portal(url, site)]).is_ok();
    assert!(check(
        "https://www.nexusmods.com/games/daggerfallunity/mods",
        ModPortalSite::NexusMods
    ));
    assert!(check("https://mod.io/g/openxcom/", ModPortalSite::ModIo));
    assert!(check(
        "https://www.moddb.com/games/openxcom/mods",
        ModPortalSite::ModDb
    ));
    assert!(check(
        "https://mods.example.org/",
        ModPortalSite::CommunitySite
    ));
    for (url, site) in [
        // Wrong host for the declared site.
        (
            "https://nexusmods.example.org/mods",
            ModPortalSite::NexusMods,
        ),
        ("https://www.moddb.com.example.org/x", ModPortalSite::ModDb),
        ("https://mod.io.evil/x", ModPortalSite::ModIo),
        // Scheme, credentials, ports, queries, fragments and dot segments.
        ("http://mods.example.org/", ModPortalSite::CommunitySite),
        (
            "https://user:secret@mods.example.org/",
            ModPortalSite::CommunitySite,
        ),
        ("https://user@mod.io/g/openxcom/", ModPortalSite::ModIo),
        (
            "https://mods.example.org:8443/",
            ModPortalSite::CommunitySite,
        ),
        (
            "https://mods.example.org/?token=1",
            ModPortalSite::CommunitySite,
        ),
        (
            "https://mods.example.org/#top",
            ModPortalSite::CommunitySite,
        ),
        (
            "https://mods.example.org/a/../b",
            ModPortalSite::CommunitySite,
        ),
        (
            "https://mods.example.org/a/%2e%2e/b",
            ModPortalSite::CommunitySite,
        ),
        // Non-canonical spellings and hosts that are not public DNS names.
        ("https://Mods.Example.org/", ModPortalSite::CommunitySite),
        ("https://mods.example.org", ModPortalSite::CommunitySite),
        ("https://127.0.0.1/", ModPortalSite::CommunitySite),
        ("https://[::1]/", ModPortalSite::CommunitySite),
        ("https://localhost/", ModPortalSite::CommunitySite),
        ("https://router.local/", ModPortalSite::CommunitySite),
        ("https://mods.example.org./", ModPortalSite::CommunitySite),
        ("file:///etc/passwd", ModPortalSite::CommunitySite),
        ("javascript:alert(1)", ModPortalSite::CommunitySite),
    ] {
        assert!(!check(url, site), "{url}");
    }
    let long = format!("https://mods.example.org/{}", "a".repeat(MAX_URL_BYTES));
    assert!(!check(&long, ModPortalSite::CommunitySite));
    // A Mod DB feed source names only a files collection; its fetch hosts are
    // derived by Core and never taken from data.
    let feed = |url: &str| {
        validated(
            "quake-ironwail",
            vec![source(
                "feed",
                ModSourceAuthority::Browse,
                ModSourceKind::ModDbFeed { url: url.into() },
            )],
        )
        .is_ok()
    };
    assert!(feed(
        "https://www.moddb.com/mods/arcane-dimensions/downloads"
    ));
    assert!(!feed(
        "https://rss.moddb.com/mods/arcane-dimensions/downloads/feed/rss.xml"
    ));
    assert!(!feed("https://www.moddb.com/mods/arcane-dimensions/images"));
    assert!(!feed(
        "https://example.org/mods/arcane-dimensions/downloads"
    ));
    // GitHub sources take a repository and numeric id, never a URL.
    for (repository, id) in [("a/b/c", 1), ("../b", 1), ("a/b", 0), ("a/b", 1u64 << 53)] {
        let mut bad = fixture_github(ModSourceAuthority::Browse);
        if let ModSourceKind::GithubRelease {
            repository: name,
            repository_id,
            ..
        } = &mut bad.source
        {
            *name = repository.into();
            *repository_id = id;
        }
        assert!(
            validated("zelda64-recomp", vec![bad]).is_err(),
            "{repository}"
        );
    }
    for asset in ["", "../x.zip", "a/b.zip", "a\\b.zip"] {
        let mut bad = fixture_github(ModSourceAuthority::Browse);
        if let ModSourceKind::GithubRelease { asset_name, .. } = &mut bad.source {
            *asset_name = asset.into();
        }
        assert!(validated("zelda64-recomp", vec![bad]).is_err(), "{asset}");
    }
}

#[test]
fn legacy_signed_catalogs_cannot_appoint_or_withdraw_a_source() {
    let catalog = Catalog::embedded().unwrap();
    let original = catalog.port("quake-vkquake").unwrap();
    let mut delivered = original.clone();
    delivered.mod_sources.clear();
    retain_from_baseline(&mut delivered, original).unwrap();
    assert_eq!(delivered.mod_sources, original.mod_sources);
    let mut appointed = original.clone();
    assert!(retain_from_baseline(&mut appointed, original).is_err());
}

#[test]
fn installed_contracts_retain_only_the_installed_ports_sources() {
    let catalog = Catalog::embedded().unwrap();
    for id in ["zelda64-recomp", "quake-vkquake", "opentyrian-opentyrian"] {
        let contract = crate::installed_contract::InstalledContract::capture(&catalog, id).unwrap();
        let retained = contract.catalog(id).unwrap();
        for port in retained.ports() {
            let expected = if port.id == id {
                catalog.port(id).unwrap().mod_sources.clone()
            } else {
                Vec::new()
            };
            assert_eq!(port.mod_sources, expected, "{id} retains {}", port.id);
        }
    }
}
