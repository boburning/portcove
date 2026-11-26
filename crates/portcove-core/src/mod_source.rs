//! Catalog-declared mod sources. A port gains or loses a source through its
//! own definition data; no port id, game or repository name in this crate
//! decides which sources a port has. Each declaration states its authority and
//! Core never lets a source exceed the ceiling of its kind. No source kind here
//! can install, update or activate anything: install authority belongs only to
//! the reviewed provider bindings in `provider_binding`.
use reqwest::Url;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AdapterKind, Catalog, Platform, PortDefinition, PortcoveError, QuakeEngine, ReleaseSource,
    Result, profile_loader::ModEngine,
};

const MAX_SOURCES: usize = 8;
const MAX_ID_BYTES: usize = 64;
const MAX_NAME_BYTES: usize = 80;
const MAX_INSTRUCTION_BYTES: usize = 400;
const MAX_URL_BYTES: usize = 256;
const MAX_ASSET_NAME_BYTES: usize = 128;
const MAX_COMPANION_FILES: usize = 8;

/// The most a declared source may do. The order is meaningful: each level
/// includes the levels before it.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ModSourceAuthority {
    /// Open the source's own page in the player's browser.
    LinkOut,
    /// Also read a bounded, attributed listing from the provider.
    Browse,
    /// Also download one exact file privately and inspect it. Inspection is
    /// never an install plan.
    Inspect,
}

/// Community mod sites that a link-out portal may point to. The host for each
/// site is fixed in Core; a definition cannot choose another host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModPortalSite {
    NexusMods,
    ModIo,
    ModDb,
    /// A site run for one game's community. Any public HTTPS host.
    CommunitySite,
}

/// A reviewed link to a mod community for this exact listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingModPortal {
    pub id: String,
    pub site: ModPortalSite,
    pub name: String,
    pub url: String,
    pub instructions: String,
}

pub(crate) fn validate_listing_portals(portals: &[ListingModPortal]) -> Result<()> {
    let mut ids = std::collections::HashSet::new();
    if portals.len() > MAX_SOURCES
        || !portals.iter().all(|portal| {
            valid_id(&portal.id)
                && ids.insert(&portal.id)
                && valid_text(&portal.name, MAX_NAME_BYTES)
                && valid_text(&portal.instructions, MAX_INSTRUCTION_BYTES)
                && checked_url(&portal.url, portal_host(portal.site)).is_some()
        })
    {
        return Err(PortcoveError::verification("invalid listing mod portals"));
    }
    Ok(())
}

/// Exact companion files one reviewed platform loads beside a Recomp mod.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModCompanionLayout {
    pub platform: Platform,
    /// Manifest-declared library stem and its exact same-folder dependencies.
    pub declared_library: String,
    pub files: Vec<String>,
}

/// The typed kinds of mod source. A new kind needs a new named definition
/// feature, so older readers refuse only the definition that uses it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModSourceKind {
    /// A page on a community mod site. Link-out only.
    ExternalPortal { site: ModPortalSite, url: String },
    /// The Quaddicted database, read through its public API.
    Quaddicted { engine: QuakeEngine },
    /// One Mod DB files collection and its RSS feed.
    ModDbFeed { url: String },
    /// Releases of one public GitHub repository, identified by its numeric ID.
    GithubRelease {
        repository: String,
        repository_id: u64,
        /// The exact release asset name.
        asset_name: String,
        /// Reviewed per-platform companion files. Required for `inspect`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        companions: Vec<ModCompanionLayout>,
    },
}

/// One catalog-declared mod source for a port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModSource {
    /// Stable within the port. Clients address the source by this ID.
    pub id: String,
    pub authority: ModSourceAuthority,
    /// Host platforms the source is offered on, in sorted order.
    pub platforms: Vec<Platform>,
    /// Player-facing name of the site or collection. Not used for GitHub releases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Catalog-authored setup guide shown beside the link. Not used for GitHub releases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub source: ModSourceKind,
}

impl ModSource {
    /// The highest authority this kind of source can ever carry.
    pub fn ceiling(&self) -> ModSourceAuthority {
        match self.source {
            ModSourceKind::ExternalPortal { .. } => ModSourceAuthority::LinkOut,
            ModSourceKind::Quaddicted { .. } | ModSourceKind::ModDbFeed { .. } => {
                ModSourceAuthority::Browse
            }
            ModSourceKind::GithubRelease { .. } => ModSourceAuthority::Inspect,
        }
    }

    /// The source's landing page. Fixed by Core for kinds with a fixed host.
    pub fn link(&self) -> String {
        match &self.source {
            ModSourceKind::ExternalPortal { url, .. } | ModSourceKind::ModDbFeed { url } => {
                url.clone()
            }
            ModSourceKind::Quaddicted { .. } => crate::quaddicted::DIRECTORY.into(),
            ModSourceKind::GithubRelease { repository, .. } => {
                format!("https://github.com/{repository}/releases")
            }
        }
    }

    pub(crate) fn is_platform_independent_portal(&self) -> bool {
        self.platforms.is_empty() && matches!(self.source, ModSourceKind::ExternalPortal { .. })
    }

    pub(crate) fn offered_on(&self, platform: Platform) -> bool {
        self.platforms.contains(&platform)
    }

    pub(crate) fn allows(&self, authority: ModSourceAuthority) -> bool {
        self.authority >= authority
    }
}

/// The Quaddicted and Mod DB readers serve native Windows and Linux Quake
/// engines distributed as GitHub release packages. This is an adapter rule,
/// not a choice of port.
pub(crate) fn quake_browser_platform(port: &PortDefinition, platform: Platform) -> bool {
    port.adapter == AdapterKind::NativePortable
        && port.release.provider == ReleaseSource::Github
        && matches!(platform, Platform::WindowsX86_64 | Platform::LinuxX86_64)
        && port.platforms.contains(&platform)
}

/// Sources the definition declares for the platform, in declaration order.
pub(crate) fn declared(
    port: &PortDefinition,
    platform: Platform,
) -> impl Iterator<Item = &ModSource> {
    port.mod_sources
        .iter()
        .filter(move |source| source.offered_on(platform))
}

/// The Quaddicted engine the port's browse-level source declares on the platform.
pub(crate) fn quaddicted(port: &PortDefinition, platform: Platform) -> Option<QuakeEngine> {
    if !quake_browser_platform(port, platform) {
        return None;
    }
    declared(port, platform).find_map(|source| match source.source {
        ModSourceKind::Quaddicted { engine } if source.allows(ModSourceAuthority::Browse) => {
            Some(engine)
        }
        _ => None,
    })
}

/// The Mod DB files page whose feed the port may read on the platform.
pub(crate) fn moddb_feed(port: &PortDefinition, platform: Platform) -> Option<&str> {
    if !quake_browser_platform(port, platform) {
        return None;
    }
    declared(port, platform).find_map(|source| match &source.source {
        ModSourceKind::ModDbFeed { url } if source.allows(ModSourceAuthority::Browse) => {
            Some(url.as_str())
        }
        _ => None,
    })
}

/// The port's GitHub release source on the platform, if any.
pub(crate) fn github(port: &PortDefinition, platform: Platform) -> Option<GithubSource<'_>> {
    declared(port, platform).find_map(|source| match &source.source {
        ModSourceKind::GithubRelease {
            repository,
            repository_id,
            asset_name,
            companions,
        } => Some(GithubSource {
            authority: source.authority,
            repository,
            repository_id: *repository_id,
            asset_name,
            companions,
            port,
        }),
        _ => None,
    })
}

/// A port carrying one inspect-level GitHub source, for tests of the readers.
#[cfg(test)]
pub(crate) fn synthetic_github_port(
    repository: &str,
    repository_id: u64,
    asset_name: &str,
    companions: Vec<ModCompanionLayout>,
) -> PortDefinition {
    let mut port = Catalog::embedded()
        .unwrap()
        .port("zelda64-recomp")
        .unwrap()
        .clone();
    port.mod_sources = vec![ModSource {
        id: "synthetic".into(),
        authority: ModSourceAuthority::Inspect,
        platforms: vec![
            Platform::WindowsX86_64,
            Platform::LinuxX86_64,
            Platform::MacosX86_64,
            Platform::MacosAarch64,
        ],
        name: None,
        instructions: None,
        source: ModSourceKind::GithubRelease {
            repository: repository.into(),
            repository_id,
            asset_name: asset_name.into(),
            companions,
        },
    }];
    validate(&port).unwrap();
    port
}

/// Borrowed GitHub source facts from one definition.
#[derive(Clone, Copy, Debug)]
pub(crate) struct GithubSource<'a> {
    pub authority: ModSourceAuthority,
    pub repository: &'a str,
    pub repository_id: u64,
    pub asset_name: &'a str,
    pub companions: &'a [ModCompanionLayout],
    port: &'a PortDefinition,
}

impl<'a> GithubSource<'a> {
    /// The Recomp native game of the port's reviewed loader, for inspection.
    pub(crate) fn game(&self) -> Option<String> {
        crate::profile_loader::configured_loader(self.port)
            .filter(|loader| loader.engine == ModEngine::N64Recomp)
            .and_then(|loader| loader.native_game.map(std::borrow::Cow::into_owned))
    }

    pub(crate) fn releases_url(&self) -> String {
        format!("https://github.com/{}/releases", self.repository)
    }

    /// The companion layout for a platform when this source may inspect.
    pub(crate) fn inspection_layout(&self, platform: Platform) -> Option<&'a ModCompanionLayout> {
        if self.authority < ModSourceAuthority::Inspect || self.game().is_none() {
            return None;
        }
        self.companions
            .iter()
            .find(|layout| layout.platform == platform)
    }
}

/// Every mod source, browse-only or inspect, grants no install authority.
/// Install-path helpers read only reviewed provider bindings; this guard keeps
/// the two vocabularies disjoint for any future kind.
pub(crate) fn grants_install(_source: &ModSource) -> bool {
    false
}

fn invalid(port: &PortDefinition, detail: &str) -> PortcoveError {
    PortcoveError::verification(format!("{} has an invalid mod source: {detail}", port.id))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty()
        && text.len() <= max
        && text.trim() == text
        && !text.chars().any(char::is_control)
        && !text.contains(['<', '>'])
}

/// A data-declared address: canonical HTTPS on a fixed or public DNS host, with
/// no credentials, port, query, fragment or dot segments.
pub(crate) fn checked_url(raw: &str, host: Option<&str>) -> Option<Url> {
    if raw.len() > MAX_URL_BYTES || raw.contains(['\\', '%']) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let actual = url.domain()?;
    let public_name = actual.contains('.')
        && !actual.ends_with('.')
        && actual.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        && !actual.ends_with(".localhost")
        && !actual.ends_with(".local")
        && !actual.ends_with(".internal");
    let ok = url.scheme() == "https"
        && url.as_str() == raw
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && public_name
        && host.is_none_or(|host| actual == host)
        && url.path().starts_with('/')
        && !url
            .path()
            .split('/')
            .any(|segment| segment == "." || segment == "..");
    ok.then_some(url)
}

fn portal_host(site: ModPortalSite) -> Option<&'static str> {
    match site {
        ModPortalSite::NexusMods => Some("www.nexusmods.com"),
        ModPortalSite::ModIo => Some("mod.io"),
        ModPortalSite::ModDb => Some("www.moddb.com"),
        ModPortalSite::CommunitySite => None,
    }
}

/// `https://www.moddb.com/{mods|games}/<slug>/downloads`, the only Mod DB
/// collection shape whose feed Core reads.
pub(crate) fn moddb_feed_page(raw: &str) -> bool {
    checked_url(raw, Some("www.moddb.com")).is_some_and(|url| {
        let segments: Vec<_> = url.path().split('/').collect();
        matches!(
            segments.as_slice(),
            ["", "mods" | "games", slug, "downloads"] if valid_id(slug)
        )
    })
}

fn valid_repository(repository: &str) -> bool {
    let mut parts = repository.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    [owner, name].iter().all(|part| {
        !part.is_empty()
            && part.len() <= 100
            && *part != "."
            && *part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    })
}

fn valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ASSET_NAME_BYTES
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control)
}

/// Checks a definition's sources. Runs for the embedded catalog and for every
/// indexed entry, so an invalid declaration refuses only its own definition.
pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let sources = &port.mod_sources;
    if sources.len() > MAX_SOURCES {
        return Err(invalid(port, "too many sources"));
    }
    let mut ids = std::collections::BTreeSet::new();
    let mut kinds = std::collections::BTreeSet::new();
    for source in sources {
        if !valid_id(&source.id) || !ids.insert(source.id.as_str()) {
            return Err(invalid(port, "ids must be unique lowercase names"));
        }
        if source.authority > source.ceiling() {
            return Err(invalid(
                port,
                "authority exceeds what the source kind allows",
            ));
        }
        if grants_install(source) {
            return Err(invalid(port, "a mod source cannot carry install authority"));
        }
        if (source.platforms.is_empty() && !source.is_platform_independent_portal())
            || !source.platforms.windows(2).all(|pair| pair[0] < pair[1])
        {
            return Err(invalid(
                port,
                "platforms must be sorted and may be empty only for an external portal",
            ));
        }
        let github = matches!(source.source, ModSourceKind::GithubRelease { .. });
        let described = match (&source.name, &source.instructions) {
            (Some(name), Some(instructions)) => {
                valid_text(name, MAX_NAME_BYTES) && valid_text(instructions, MAX_INSTRUCTION_BYTES)
            }
            _ => false,
        };
        if github == (source.name.is_some() || source.instructions.is_some())
            || (!github && !described)
        {
            return Err(invalid(
                port,
                "portals need a name and instructions; GitHub release sources have neither",
            ));
        }
        let browser = match source.source {
            ModSourceKind::ExternalPortal { .. } => None,
            ModSourceKind::Quaddicted { .. } => Some("quaddicted"),
            ModSourceKind::ModDbFeed { .. } => Some("mod_db_feed"),
            ModSourceKind::GithubRelease { .. } => Some("github_release"),
        };
        if browser.is_some_and(|kind| !kinds.insert(kind)) {
            return Err(invalid(port, "at most one source of each browsing kind"));
        }
        match &source.source {
            ModSourceKind::ExternalPortal { site, url } => {
                if checked_url(url, portal_host(*site)).is_none() {
                    return Err(invalid(
                        port,
                        "the portal address is not allowed for its site",
                    ));
                }
            }
            ModSourceKind::Quaddicted { .. } => {}
            ModSourceKind::ModDbFeed { url } => {
                if !moddb_feed_page(url) {
                    return Err(invalid(
                        port,
                        "the Mod DB address is not a files collection",
                    ));
                }
            }
            ModSourceKind::GithubRelease {
                repository,
                repository_id,
                asset_name,
                companions,
            } => {
                if !valid_repository(repository)
                    || !(1..=(1u64 << 53) - 1).contains(repository_id)
                    || !valid_file_name(asset_name)
                {
                    return Err(invalid(
                        port,
                        "the GitHub repository or asset identity is invalid",
                    ));
                }
                let mut seen = std::collections::BTreeSet::new();
                let layouts_valid = companions.iter().all(|layout| {
                    seen.insert(layout.platform)
                        && source.platforms.contains(&layout.platform)
                        && valid_file_name(&layout.declared_library)
                        && !layout.files.is_empty()
                        && layout.files.len() <= MAX_COMPANION_FILES
                        && layout.files.iter().all(|file| valid_file_name(file))
                        && layout
                            .files
                            .iter()
                            .collect::<std::collections::BTreeSet<_>>()
                            .len()
                            == layout.files.len()
                });
                if !layouts_valid {
                    return Err(invalid(port, "companion layouts are invalid"));
                }
                if source.authority == ModSourceAuthority::Inspect {
                    let recomp_loader =
                        crate::profile_loader::configured_loader(port).is_some_and(|loader| {
                            loader.engine == ModEngine::N64Recomp && loader.native_game.is_some()
                        });
                    if companions.is_empty() || !recomp_loader {
                        return Err(invalid(
                            port,
                            "inspection needs companion layouts and a reviewed Recomp loader",
                        ));
                    }
                } else if !companions.is_empty() {
                    return Err(invalid(port, "companion layouts apply only to inspection"));
                }
            }
        }
    }
    Ok(())
}

/// Legacy signed catalogs predate mod source data. They cannot appoint or
/// withdraw a source; the compiled baseline's declaration stays in place.
pub(crate) fn retain_from_baseline(
    port: &mut PortDefinition,
    original: &PortDefinition,
) -> Result<()> {
    if !port.mod_sources.is_empty() {
        return Err(PortcoveError::verification(
            "legacy signed catalogs cannot deliver mod sources",
        ));
    }
    port.mod_sources.clone_from(&original.mod_sources);
    Ok(())
}

/// The definition the platform view reads sources from: the port's own
/// definition, offered on platforms that the definition manages or that its
/// matching listing presents.
pub(crate) fn presented_on(catalog: &Catalog, port: &PortDefinition, platform: Platform) -> bool {
    if port.platforms.contains(&platform) {
        return true;
    }
    let game = port
        .presentation
        .as_ref()
        .and_then(|value| value.original_game.as_ref());
    catalog.listings().iter().any(|listing| {
        listing.id == port.id
            && listing.project_url == port.project_url
            && game.is_some_and(|game| {
                listing
                    .original_game
                    .as_ref()
                    .is_some_and(|value| value.id == game.id)
            })
            && listing.platforms.contains(&platform)
    })
}

#[cfg(test)]
#[path = "mod_source_tests.rs"]
mod tests;
