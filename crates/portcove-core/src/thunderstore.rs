//! Thunderstore adapter: community package observations and canonical downloads,
//! never trust or compatibility.
//!
//! Evidence (November 12, 2026, live, unauthenticated reads): the community
//! listing `/c/<community>/api/v1/package/` returns every package with all its
//! versions (version number, size, creation date, dependencies, `is_active`) and a
//! `Last-Modified` header; `/package/download/<namespace>/<name>/<version>/`
//! redirects to the package zip on `ccdn.thunderstore.io`. A package is named
//! `<namespace>-<name>` and a version is `major.minor.patch`; Thunderstore publishes
//! each version once, so a version stands for one file. No digest is offered, so
//! the computed SHA-256 is the only byte identity.
use std::path::Path;

use serde_json::Value;

use crate::{
    Library, PortcoveError, Result,
    mod_provider::{
        Observed, ProviderFileCandidate, ProviderPage, ProviderProject, ThunderstoreDependency,
        sanitize_text,
    },
    provider_http::ProviderHttp,
};

pub const PROVIDER: &str = "thunderstore";
const WEB_ROOT: &str = "https://thunderstore.io";
/// A community listing with more packages than this is refused rather than
/// silently truncated. The 4 MiB response bound (about 1,700 packages at today's
/// density) is reached first and also fails closed; this guards parsed data.
const MAX_PACKAGES: usize = 20_000;
/// More versions than this in one package is refused, so a newer one is never missed.
const MAX_VERSIONS: usize = 1024;
const MAX_DEPENDENCIES: usize = 128;

/// Reviewed port → Thunderstore community bindings. A community's own listing is
/// the only route; a package is never matched to a game by name.
const COMMUNITY_BINDINGS: &[(&str, &str)] = &[("zelda64-recomp", "zelda-64-recompiled")];

pub(crate) fn thunderstore_community(port_id: &str) -> Option<&'static str> {
    #[cfg(test)]
    if port_id == "starship" {
        return Some("starship-test");
    }
    COMMUNITY_BINDINGS
        .iter()
        .find(|(port, _)| *port == port_id)
        .map(|(_, community)| *community)
}

#[derive(Clone)]
pub struct ThunderstoreClient {
    http: ProviderHttp,
    web_root: String,
}

impl ThunderstoreClient {
    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(Some(library.clone()), WEB_ROOT)
    }

    fn build(library: Option<Library>, web_root: &str) -> Result<Self> {
        Ok(Self {
            http: ProviderHttp::new(library, "Thunderstore", "thunderstore.io")?,
            web_root: web_root.trim_end_matches('/').into(),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_root(root: &str, library: Option<Library>) -> Result<Self> {
        Self::build(library, root)
    }

    /// Every package in one community, in the provider's listing order.
    pub async fn community(&self, community: &str) -> Result<Observed<Vec<ProviderProject>>> {
        if !plain_name(community, true) {
            return Err(PortcoveError::usage(
                "a Thunderstore community name is a plain slug",
            ));
        }
        let url = reqwest::Url::parse(&format!("{}/c/{community}/api/v1/package/", self.web_root))
            .map_err(|error| PortcoveError::state(error.to_string()))?;
        let web_root = self.web_root.clone();
        let community = community.to_owned();
        self.http
            .observe(url, move |value| {
                parse_listing(value, &community, &web_root)
            })
            .await
    }

    /// One page of a community, `per_page` packages at a time.
    pub async fn search(
        &self,
        community: &str,
        page: u32,
        per_page: u32,
    ) -> Result<Observed<ProviderPage>> {
        let observed = self.community(community).await?;
        Ok(Observed {
            value: page_of(observed.value, page, per_page),
            observed_at: observed.observed_at,
            freshness: observed.freshness,
        })
    }

    /// One package and its versions, named `<namespace>-<name>`.
    pub async fn project(
        &self,
        community: &str,
        package: &str,
    ) -> Result<Observed<ProviderProject>> {
        let Some((namespace, name)) = package.split_once('-') else {
            return Err(PortcoveError::usage(
                "a Thunderstore package is named NAMESPACE-NAME",
            ));
        };
        if !plain_name(namespace, false) || !plain_name(name, false) {
            return Err(PortcoveError::usage(
                "a Thunderstore package is named NAMESPACE-NAME",
            ));
        }
        let observed = self.community(community).await?;
        let project = observed
            .value
            .into_iter()
            .find(|project| project.project_id == package)
            .ok_or_else(|| PortcoveError::not_found("the community has no such package"))?;
        Ok(Observed {
            value: project,
            observed_at: observed.observed_at,
            freshness: observed.freshness,
        })
    }

    /// Streams one version's zip from its canonical location; see
    /// [`ProviderHttp::download`].
    pub(crate) async fn download_file(
        &self,
        project_id: &str,
        file: &ProviderFileCandidate,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(String, u64)> {
        let (namespace, name) = project_id.split_once('-').ok_or_else(|| {
            PortcoveError::usage("a Thunderstore package is named NAMESPACE-NAME")
        })?;
        let canonical = canonical_download(&self.web_root, namespace, name, &file.file_id);
        self.http
            .download(file, &canonical, destination, max_bytes)
            .await
    }
}

/// One page of a listing, in the provider's order; `per_page` is clamped to 50.
pub(crate) fn page_of(projects: Vec<ProviderProject>, page: u32, per_page: u32) -> ProviderPage {
    let per_page = per_page.clamp(1, 50) as usize;
    let page = page.max(1);
    let total = projects.len();
    let start = (page as usize - 1).saturating_mul(per_page);
    let projects = projects
        .into_iter()
        .skip(start)
        .take(per_page)
        .collect::<Vec<_>>();
    ProviderPage {
        complete: start + projects.len() >= total,
        projects,
        total: total as u64,
        page,
    }
}

/// Thunderstore namespaces and names use ASCII letters, digits and `_`;
/// community slugs also use `-`.
fn plain_name(value: &str, slug: bool) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || (slug && byte == b'-'))
}

fn version_number(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    value.len() <= 32
        && parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit())
        })
}

fn canonical_download(web_root: &str, namespace: &str, name: &str, version: &str) -> String {
    format!("{web_root}/package/download/{namespace}/{name}/{version}/")
}

fn timestamp(value: &Value) -> Option<i64> {
    time::OffsetDateTime::parse(
        value.as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()
    .map(time::OffsetDateTime::unix_timestamp)
}

fn parse_dependency(value: &Value) -> Option<ThunderstoreDependency> {
    let (namespace, rest) = value.as_str()?.split_once('-')?;
    let (package, version) = rest.split_once('-')?;
    if !plain_name(namespace, false) || !plain_name(package, false) || !version_number(version) {
        return None;
    }
    Some(ThunderstoreDependency {
        namespace: namespace.to_owned(),
        package: package.to_owned(),
        version: version.to_owned(),
    })
}

fn parse_dependencies(values: &[Value]) -> Option<Vec<ThunderstoreDependency>> {
    if values.len() > MAX_DEPENDENCIES {
        return None;
    }
    let mut dependencies = values
        .iter()
        .map(parse_dependency)
        .collect::<Option<Vec<_>>>()?;
    dependencies.sort_unstable();
    if dependencies.windows(2).any(|pair| pair[0] == pair[1]) {
        return None;
    }
    Some(dependencies)
}

pub(crate) fn verify_wrapper_manifest(
    bytes: &[u8],
    project_id: &str,
    file: &ProviderFileCandidate,
) -> Result<()> {
    #[derive(serde::Deserialize)]
    struct Manifest {
        name: String,
        version_number: String,
        dependencies: Vec<Value>,
    }
    let error = || {
        PortcoveError::verification(
        "the Thunderstore wrapper manifest does not match the exact listing; check the provider listing and review again",
    ).detail("project", project_id).detail("version", &file.file_id)
    };
    let manifest = serde_json::from_slice::<Manifest>(bytes).map_err(|_| error())?;
    let (_, package) = project_id.split_once('-').ok_or_else(error)?;
    let dependencies = parse_dependencies(&manifest.dependencies).ok_or_else(error)?;
    if manifest.name != package
        || manifest.version_number != file.file_id
        || Some(&dependencies) != file.thunderstore_dependencies.as_ref()
    {
        return Err(error());
    }
    Ok(())
}

fn parse_version(
    value: &Value,
    namespace: &str,
    name: &str,
    web_root: &str,
) -> Option<ProviderFileCandidate> {
    let version = value["version_number"].as_str()?;
    if !version_number(version) || value["name"].as_str() != Some(name) {
        return None;
    }
    let download_url = canonical_download(web_root, namespace, name, version);
    // A listed location that disagrees with the canonical one makes the record
    // untrustworthy as a candidate.
    if value["download_url"].as_str() != Some(download_url.as_str()) {
        return None;
    }
    let file_name = format!("{namespace}-{name}-{version}.zip");
    if !crate::profile::valid_native_id(&file_name) {
        return None;
    }
    let dependencies = parse_dependencies(value["dependencies"].as_array()?)?;
    let active = crate::mod_provider::provider_status_flag(value, "is_active");
    Some(ProviderFileCandidate {
        file_id: version.to_owned(),
        file_name,
        size: value["file_size"].as_u64()?,
        added_at: timestamp(&value["date_created"])?,
        download_url,
        claimed_md5: None,
        // An inactive version is no longer offered by the community.
        archived: !active.unwrap_or(false),
        status_unknown: active.err(),
        claimed_scan: None,
        thunderstore_dependencies: Some(dependencies),
    })
}

fn parse_package(value: &Value, community: &str, web_root: &str) -> Option<ProviderProject> {
    let namespace = value["owner"].as_str()?;
    let name = value["name"].as_str()?;
    if !plain_name(namespace, false) || !plain_name(name, false) {
        return None;
    }
    let project_id = format!("{namespace}-{name}");
    if value["full_name"].as_str() != Some(project_id.as_str()) {
        return None;
    }
    let (files, unreadable_files) = match &value["versions"] {
        Value::Array(versions) if versions.len() <= MAX_VERSIONS => {
            let parsed = versions
                .iter()
                .filter_map(|version| parse_version(version, namespace, name, web_root))
                .collect::<Vec<_>>();
            let unreadable = versions.len() - parsed.len();
            (parsed, unreadable)
        }
        _ => (Vec::new(), 1),
    };
    let latest = files
        .iter()
        .filter(|file| !file.archived && file.status_unknown.is_none())
        .max_by_key(|file| file.added_at)
        .map(|file| file.file_id.clone());
    let deprecated = crate::mod_provider::provider_status_flag(value, "is_deprecated");
    Some(ProviderProject {
        provider: PROVIDER.into(),
        profile_url: format!("{web_root}/c/{community}/p/{namespace}/{name}/"),
        project_id,
        name: sanitize_text(name),
        version: latest,
        // The community listing is the binding: every package in it belongs to it.
        game_id: Some(community.to_owned()),
        updated_at: timestamp(&value["date_updated"]).unwrap_or_default(),
        obsolete: deprecated.unwrap_or(false),
        status_unknown: deprecated.err(),
        submitter: Some(sanitize_text(namespace)),
        files,
        unreadable_files: u32::try_from(unreadable_files).unwrap_or(u32::MAX),
    })
}

pub(crate) fn parse_listing(
    value: &Value,
    community: &str,
    web_root: &str,
) -> Result<Vec<ProviderProject>> {
    let packages = value
        .as_array()
        .ok_or_else(|| PortcoveError::verification("Thunderstore listing is not a list"))?;
    if packages.len() > MAX_PACKAGES {
        return Err(PortcoveError::verification(
            "the Thunderstore listing exceeds the number of packages this client can review",
        ));
    }
    Ok(packages
        .iter()
        .filter_map(|package| parse_package(package, community, web_root))
        .collect())
}

/// Exact provider files, with requirements before their dependants. The root
/// file is last. Native requirements are established separately by inspection.
pub(crate) fn resolve_dependencies<'a>(
    listing: &'a [ProviderProject],
    project_id: &str,
    file_id: &str,
) -> Result<Vec<(&'a ProviderProject, &'a ProviderFileCandidate)>> {
    const MAX_CLOSURE: usize = 64;

    struct Resolution<'a> {
        listing: &'a [ProviderProject],
        versions: std::collections::BTreeMap<String, String>,
        visiting: std::collections::BTreeSet<String>,
        files: Vec<(&'a ProviderProject, &'a ProviderFileCandidate)>,
    }

    impl<'a> Resolution<'a> {
        fn visit(&mut self, project_id: &str, file_id: &str) -> Result<()> {
            let with_coordinate = |error: PortcoveError| {
                error
                    .detail("project", project_id)
                    .detail("version", file_id)
            };
            if let Some(existing) = self.versions.get(project_id) {
                if existing != file_id {
                    return Err(with_coordinate(
                        PortcoveError::conflict(
                            "Thunderstore requires two versions of the same package",
                        )
                        .detail("other_version", existing),
                    ));
                }
                if self.visiting.contains(project_id) {
                    return Err(with_coordinate(PortcoveError::conflict(
                        "the Thunderstore package requirements form a cycle",
                    )));
                }
                return Ok(());
            }
            if self.versions.len() >= MAX_CLOSURE {
                return Err(with_coordinate(PortcoveError::unsupported(
                    "the Thunderstore dependency closure exceeds the supported size",
                )));
            }
            let project = exact_listing_entry(
                self.listing
                    .iter()
                    .filter(|entry| entry.project_id == project_id),
                &with_coordinate,
            )?;
            let file = exact_listing_entry(
                project.files.iter().filter(|file| file.file_id == file_id),
                &with_coordinate,
            )?;
            if project.status_unknown.is_some() || file.status_unknown.is_some() {
                return Err(with_coordinate(PortcoveError::verification(
                    crate::mod_provider::UNKNOWN_PROVIDER_ELIGIBILITY,
                )));
            }
            if project.obsolete || file.archived {
                return Err(with_coordinate(PortcoveError::unsupported(
                    "the exact Thunderstore package version is no longer offered",
                )));
            }
            let requirements = file.thunderstore_dependencies.as_deref().ok_or_else(|| {
                with_coordinate(PortcoveError::verification(
                    "the exact Thunderstore package version has unreadable dependency metadata",
                ))
            })?;
            self.versions.insert(project_id.into(), file_id.into());
            self.visiting.insert(project_id.into());
            for requirement in requirements {
                let required_project = format!("{}-{}", requirement.namespace, requirement.package);
                self.visit(&required_project, &requirement.version)?;
            }
            self.visiting.remove(project_id);
            self.files.push((project, file));
            Ok(())
        }
    }

    let mut resolution = Resolution {
        listing,
        versions: Default::default(),
        visiting: Default::default(),
        files: Vec::new(),
    };
    resolution.visit(project_id, file_id)?;
    Ok(resolution.files)
}

fn exact_listing_entry<T>(
    mut matches: impl Iterator<Item = T>,
    describe: &impl Fn(PortcoveError) -> PortcoveError,
) -> Result<T> {
    let entry = matches.next().ok_or_else(|| {
        describe(PortcoveError::not_found(
            "the Thunderstore listing does not offer the exact requested package version",
        ))
    })?;
    if matches.next().is_some() {
        return Err(describe(PortcoveError::verification(
            "the Thunderstore listing has ambiguous records for the exact package version",
        )));
    }
    Ok(entry)
}

#[cfg(test)]
#[path = "thunderstore_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "provider_thunderstore_tests.rs"]
mod lifecycle_tests;
