#[cfg(test)]
use std::path::{Path, PathBuf};
use std::{future::Future, sync::Arc};

use std::net::IpAddr;

use reqwest::Url;
use reqwest::{Client, Response, dns, redirect};
use serde::{Deserialize, Serialize};

use crate::{
    DefinitionAcquisitionScope, Platform, PortDefinition, PortcoveError, ReleaseAsset,
    ReleaseChannel, ResolvedRelease, Result, ScopedResolvedRelease,
    archive::validate_download_progress,
    release::{PROVIDER_JSON_MAX_BYTES, PROVIDER_NETWORK_BOUNDS, bounded_response_bytes},
};
#[cfg(test)]
use crate::{Installer, OperationCoordinator, ReleaseProvider, archive::validate_download_size};

/// An exact instance selection. Executable acquisition requires a separate grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewedForge {
    dialect: ForgeDialect,
    api_root: String,
    web_host: String,
    asset_hosts: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ForgeDialect {
    GithubV3,
    GitlabV4,
    ForgejoV1,
}

/// Exact acquisition evidence supplied independently of the forge's response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewedForgeArtifact {
    repository: String,
    repository_id: u64,
    tag: String,
    release_id: Option<u64>,
    asset_id: u64,
    name: String,
    url: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReviewedForgeSelection {
    platform: Platform,
    channel: ReleaseChannel,
    instance: ReviewedForge,
    artifact: ReviewedForgeArtifact,
}

impl ReviewedForgeSelection {
    pub(crate) fn validate_subject(&self, port: &PortDefinition) -> Result<()> {
        if !matches!(
            self.instance.dialect,
            ForgeDialect::ForgejoV1 | ForgeDialect::GitlabV4
        ) || port.release.provider != crate::ReleaseSource::ReviewedForge
            || self.artifact.repository != port.release.repository
            || port.platforms.as_slice() != [self.platform]
            || self.channel != ReleaseChannel::Stable
            || port.channels.as_slice() != [self.channel]
        {
            return Err(PortcoveError::verification(
                "reviewed forge selector differs from the exact subject, platform, or channel",
            ));
        }
        self.instance.validate(&self.artifact)?;
        Ok(())
    }
}

impl ReviewedForgeArtifact {
    fn asset(&self) -> ReleaseAsset {
        ReleaseAsset {
            name: self.name.clone(),
            url: self.url.clone(),
            size: self.size,
            sha256: self.sha256.clone(),
        }
    }
}

impl ReviewedForgeSelection {
    pub(crate) fn validate_grant(&self) -> Result<()> {
        if !matches!(
            self.instance.dialect,
            ForgeDialect::ForgejoV1 | ForgeDialect::GitlabV4
        ) || self.channel != ReleaseChannel::Stable
            || !self
                .artifact
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(independent_admission_required());
        }
        self.instance.validate(&self.artifact)?;
        Ok(())
    }

    pub(crate) fn validate_granted_port(&self, port: &PortDefinition) -> Result<()> {
        self.validate_grant()?;
        self.validate_subject(port)?;
        if port.adapter != crate::AdapterKind::NativePortable
            || !port.release.curated.is_empty()
            || !port.bundled_runtime.is_empty()
            || !port.release.managed_build.is_empty()
            || !port.release.direct.is_empty()
            || port.release.grant_declared_executable
            || ![".zip", ".tar.gz", ".tgz"]
                .iter()
                .any(|suffix| self.artifact.name.to_ascii_lowercase().ends_with(suffix))
            || port.mod_loader.is_some()
            || port.reviewed_launch_contract_v1.is_some()
        {
            return Err(independent_admission_required());
        }
        let project = Url::parse(&port.project_url).map_err(|_| invalid_instance())?;
        if !safe_https(&project)
            || project.host_str() != Some(self.instance.web_host.as_str())
            || project.path() != format!("/{}", self.artifact.repository)
            || project.query().is_some()
        {
            return Err(invalid_instance());
        }
        Ok(())
    }

    pub(crate) fn repository_id(&self) -> u64 {
        self.artifact.repository_id
    }

    pub(crate) fn asset_hosts(&self) -> Vec<String> {
        self.instance.asset_hosts.clone()
    }

    pub(crate) fn require_asset(
        &self,
        release: &ResolvedRelease,
        platform: Platform,
    ) -> Result<()> {
        if self.platform != platform
            || self.channel != release.channel
            || self.artifact.tag != release.version
            || self.artifact.asset() != release.asset
        {
            return Err(asset_mismatch());
        }
        Ok(())
    }

    pub(crate) async fn resolve_scoped(
        &self,
        scope: &DefinitionAcquisitionScope,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ScopedResolvedRelease> {
        if self.platform != platform || self.channel != channel {
            return Err(independent_admission_required());
        }
        scope.require_port(port)?;
        scope.require_current()?;
        let route = self.instance.route(&self.artifact)?;
        let client = metadata_client()?;
        route
            .resolve(|url| {
                let client = &client;
                async move {
                    scope.require_current()?;
                    let reply = request(client, url).await?;
                    if reply.status() != reqwest::StatusCode::OK {
                        return Err(PortcoveError::network(
                            "reviewed forge metadata request failed",
                        ));
                    }
                    bounded_response_bytes(
                        reply,
                        PROVIDER_JSON_MAX_BYTES,
                        "reviewed forge metadata",
                    )
                    .await
                }
            })
            .await?;
        ScopedResolvedRelease::managed(
            ResolvedRelease {
                version: self.artifact.tag.clone(),
                channel,
                published_at: None,
                asset: self.artifact.asset(),
                uploader_continuity: None,
            },
            scope.clone(),
        )?
        .for_selection(port, platform, channel)
    }
}

pub(crate) fn public_transport(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .no_proxy()
        .https_only(true)
        .dns_resolver(Arc::new(PublicDns))
}

fn metadata_client() -> Result<Client> {
    let bounds = PROVIDER_NETWORK_BOUNDS;
    public_transport(Client::builder())
        .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(bounds.connect)
        .read_timeout(bounds.read_idle)
        .timeout(bounds.request)
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|_| PortcoveError::network("reviewed forge transport unavailable"))
}

pub(crate) fn independent_admission_required() -> PortcoveError {
    PortcoveError::unsupported(
        "reviewed forge acquisition requires an independent exact publisher grant",
    )
}

struct ForgeRoute<'a> {
    instance: &'a ReviewedForge,
    artifact: &'a ReviewedForgeArtifact,
    api: Url,
    #[cfg(test)]
    download: Url,
}

#[derive(Deserialize)]
struct Repository {
    id: u64,
    full_name: Option<String>,
    path_with_namespace: Option<String>,
    html_url: Option<String>,
    web_url: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    id: Option<u64>,
    tag_name: String,
    draft: Option<bool>,
    prerelease: Option<bool>,
    assets: ReleaseAssets,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ReleaseAssets {
    Attachments(Vec<Attachment>),
    Links { links: Vec<Attachment> },
}

#[derive(Deserialize)]
struct Attachment {
    id: u64,
    name: String,
    size: Option<u64>,
    browser_download_url: Option<String>,
    direct_asset_url: Option<String>,
    url: Option<String>,
}

impl ReviewedForge {
    fn validate(&self, artifact: &ReviewedForgeArtifact) -> Result<(Url, Url)> {
        let api = Url::parse(&self.api_root).map_err(|_| invalid_instance())?;
        let path = match self.dialect {
            ForgeDialect::GithubV3 => "/",
            ForgeDialect::GitlabV4 => "/api/v4",
            ForgeDialect::ForgejoV1 => "/api/v1",
        };
        if !safe_https(&api)
            || api.path() != path
            || api.query().is_some()
            || !valid_host(&self.web_host)
            || self.asset_hosts.is_empty()
            || self.asset_hosts.len() > 8
            || self
                .asset_hosts
                .iter()
                .enumerate()
                .any(|(index, host)| !valid_host(host) || self.asset_hosts[..index].contains(host))
        {
            return Err(invalid_instance());
        }

        let count = artifact.repository.split('/').count();
        let valid_repository = match self.dialect {
            ForgeDialect::GitlabV4 => (2..=8).contains(&count),
            _ => count == 2,
        } && artifact.repository.split('/').all(safe_coordinate);
        let valid_release_id = match self.dialect {
            ForgeDialect::GitlabV4 => artifact.release_id.is_none(),
            _ => artifact.release_id.is_some_and(|id| id > 0),
        };
        if !valid_repository
            || !valid_release_id
            || artifact.repository_id == 0
            || artifact.asset_id == 0
            || artifact.size == 0
            || !safe_coordinate(&artifact.name)
            || artifact.tag.len() > 128
            || !artifact.tag.split('/').all(safe_coordinate)
            || artifact.sha256.len() != 64
            || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(PortcoveError::verification(
                "invalid reviewed forge artifact identity",
            ));
        }
        validate_download_progress(0, artifact.size)?;
        let download = Url::parse(&artifact.url).map_err(|_| invalid_destination())?;
        if !allows_asset(&self.asset_hosts, &download) {
            return Err(invalid_destination());
        }
        Ok((api, download))
    }

    fn route<'a>(&'a self, artifact: &'a ReviewedForgeArtifact) -> Result<ForgeRoute<'a>> {
        let (api, _download) = self.validate(artifact)?;
        Ok(ForgeRoute {
            instance: self,
            artifact,
            api,
            #[cfg(test)]
            download: _download,
        })
    }
}

#[cfg(test)]
enum QualificationTransport {
    Reviewed,
    Loopback(Url),
}

#[cfg(test)]
impl QualificationTransport {
    fn client(&self, asset_hosts: Option<Vec<String>>) -> Result<Client> {
        match self {
            Self::Reviewed => request_client(asset_hosts),
            Self::Loopback(origin) => {
                let origin = origin.origin();
                let redirects = asset_hosts.is_some();
                Client::builder()
                    .no_proxy()
                    .timeout(PROVIDER_NETWORK_BOUNDS.request)
                    .redirect(redirect::Policy::custom(move |attempt| {
                        if redirects
                            && attempt.previous().len() <= 4
                            && attempt.url().origin() == origin
                        {
                            attempt.follow()
                        } else {
                            attempt.error("qualification request left its loopback origin")
                        }
                    }))
                    .build()
                    .map_err(|_| {
                        PortcoveError::network("qualification forge transport unavailable")
                    })
            }
        }
    }

    fn destination(&self, url: Url) -> Url {
        match self {
            Self::Reviewed => url,
            Self::Loopback(origin) => {
                let mut mapped = origin.clone();
                mapped.set_path(url.path());
                mapped.set_query(url.query());
                mapped
            }
        }
    }
}

/// No production scope issuer exists. The fixture is explicitly authorized for
/// only one exact subject and artifact, independently of returned provider data.
#[cfg(test)]
struct ReviewedForgeReleaseProvider {
    instance: ReviewedForge,
    accepted: ReviewedForgeArtifact,
    subject: serde_json::Value,
    platform: Platform,
    channel: ReleaseChannel,
    transport: QualificationTransport,
}

#[cfg(test)]
impl ReviewedForgeReleaseProvider {
    fn issue_fixture_scope(
        selected: ReviewedForgeSelection,
        independently_accepted: &ReviewedForgeSelection,
        port: &PortDefinition,
        fixture_origin: Option<&str>,
    ) -> Result<Self> {
        selected.validate_subject(port)?;
        if &selected != independently_accepted {
            return Err(independent_admission_required());
        }
        let ReviewedForgeSelection {
            platform,
            channel,
            instance,
            artifact: accepted,
        } = selected;
        let transport = if let Some(origin) = fixture_origin {
            crate::definition_acquisition::validate_fixture_origin(origin)?;
            QualificationTransport::Loopback(Url::parse(origin).map_err(|_| invalid_destination())?)
        } else {
            QualificationTransport::Reviewed
        };
        Ok(Self {
            instance,
            accepted,
            subject: serde_json::to_value(port)?,
            platform,
            channel,
            transport,
        })
    }

    fn accepted_asset(&self) -> ReleaseAsset {
        self.accepted.asset()
    }

    async fn acquire(
        &self,
        resolution: &ScopedResolvedRelease,
        port: &PortDefinition,
        private_staging: &Path,
    ) -> Result<VerifiedForgeDownload> {
        resolution.require_selection(port, self.platform, self.channel)?;
        if serde_json::to_value(port)? != self.subject
            || resolution.release.version != self.accepted.tag
            || resolution.release.asset != self.accepted_asset()
        {
            return Err(asset_mismatch());
        }
        let route = self.instance.route(&self.accepted)?;
        let client = self
            .transport
            .client(Some(self.instance.asset_hosts.clone()))?;
        let mut asset = resolution.release.asset.clone();
        asset.url = self.transport.destination(route.download.clone()).into();
        route.download(&client, &asset, private_staging).await
    }
}

#[cfg(test)]
#[async_trait::async_trait]
impl ReleaseProvider for ReviewedForgeReleaseProvider {
    async fn resolve(
        &self,
        port: &PortDefinition,
        channel: ReleaseChannel,
        platform: Platform,
    ) -> Result<ResolvedRelease> {
        if platform != self.platform
            || channel != self.channel
            || serde_json::to_value(port)? != self.subject
        {
            return Err(PortcoveError::verification(
                "reviewed forge scope does not match the requested subject",
            ));
        }
        let route = self.instance.route(&self.accepted)?;
        let metadata = self.transport.client(None)?;
        route
            .resolve(|url| {
                let metadata = &metadata;
                let destination = self.transport.destination(url);
                async move {
                    let response = request(metadata, destination).await?;
                    if response.status() != reqwest::StatusCode::OK {
                        return Err(PortcoveError::network(
                            "reviewed forge metadata request failed",
                        ));
                    }
                    bounded_response_bytes(
                        response,
                        PROVIDER_JSON_MAX_BYTES,
                        "reviewed forge metadata",
                    )
                    .await
                }
            })
            .await?;
        Ok(ResolvedRelease {
            version: self.accepted.tag.clone(),
            channel,
            published_at: None,
            asset: self.accepted_asset(),
            uploader_continuity: None,
        })
    }
}

impl ForgeRoute<'_> {
    fn repository_url(&self) -> Url {
        let mut url = self.api.clone();
        let mut path = url.path_segments_mut().expect("validated HTTPS API root");
        path.pop_if_empty();
        if matches!(self.instance.dialect, ForgeDialect::GitlabV4) {
            path.extend(["projects", &self.artifact.repository]);
        } else {
            path.push("repos")
                .extend(self.artifact.repository.split('/'));
        }
        drop(path);
        url
    }

    async fn resolve<F, Fut>(&self, mut get: F) -> Result<()>
    where
        F: FnMut(Url) -> Fut,
        Fut: Future<Output = Result<Vec<u8>>>,
    {
        let repository_url = self.repository_url();
        let bytes = get(repository_url.clone()).await?;
        let repo: Repository = parse_metadata(&bytes)?;
        let (path, project) = match self.instance.dialect {
            ForgeDialect::GitlabV4 => (repo.path_with_namespace, repo.web_url),
            _ => (repo.full_name, repo.html_url),
        };
        let expected_project_path = format!("/{}", self.artifact.repository);
        let valid_project = project
            .and_then(|value| Url::parse(&value).ok())
            .is_some_and(|url| {
                safe_https(&url)
                    && url.host_str() == Some(self.instance.web_host.as_str())
                    && url.path() == expected_project_path
                    && url.query().is_none()
            });
        if repo.id != self.artifact.repository_id
            || path.as_deref() != Some(self.artifact.repository.as_str())
            || !valid_project
        {
            return Err(PortcoveError::verification(
                "reviewed forge repository identity differs",
            ));
        }

        let mut release_url = repository_url;
        let mut path = release_url
            .path_segments_mut()
            .expect("validated HTTPS API root");
        path.push("releases");
        if !matches!(self.instance.dialect, ForgeDialect::GitlabV4) {
            path.push("tags");
        }
        path.push(&self.artifact.tag);
        drop(path);
        let bytes = get(release_url).await?;
        let release: Release = parse_metadata(&bytes)?;
        let stable = match self.instance.dialect {
            ForgeDialect::GitlabV4 => {
                release.draft != Some(true) && release.prerelease != Some(true)
            }
            _ => release.draft == Some(false) && release.prerelease == Some(false),
        };
        if release.id != self.artifact.release_id
            || release.tag_name != self.artifact.tag
            || !stable
        {
            return Err(PortcoveError::verification(
                "reviewed forge release identity differs",
            ));
        }

        let (assets, gitlab) = match (release.assets, self.instance.dialect) {
            (ReleaseAssets::Links { links }, ForgeDialect::GitlabV4) => (links, true),
            (
                ReleaseAssets::Attachments(assets),
                ForgeDialect::GithubV3 | ForgeDialect::ForgejoV1,
            ) => (assets, false),
            _ => {
                return Err(PortcoveError::verification(
                    "reviewed forge release uses a different dialect",
                ));
            }
        };
        if assets.len() > 256 {
            return Err(PortcoveError::verification(
                "reviewed forge asset inventory exceeds its bound",
            ));
        }
        let mut selected = assets
            .iter()
            .filter(|asset| asset.id == self.artifact.asset_id || asset.name == self.artifact.name);
        let asset = selected.next().ok_or_else(asset_mismatch)?;
        let location = if gitlab {
            asset.direct_asset_url.as_ref().or(asset.url.as_ref())
        } else {
            asset.browser_download_url.as_ref()
        };
        if selected.next().is_some()
            || asset.id != self.artifact.asset_id
            || asset.name != self.artifact.name
            || (!gitlab || asset.size.is_some()) && asset.size != Some(self.artifact.size)
            || location != Some(&self.artifact.url)
        {
            return Err(asset_mismatch());
        }
        Ok(())
    }

    #[cfg(test)]
    async fn download(
        &self,
        client: &Client,
        asset: &ReleaseAsset,
        private_staging: &Path,
    ) -> Result<VerifiedForgeDownload> {
        let directory = tempfile::tempdir_in(private_staging)?;
        let path = directory.path().join("archive");
        let operation = OperationCoordinator::new("reviewed forge qualification", None);
        Installer::download_with_client(client, asset, &path, &operation, &mut |_| {}).await?;
        let expected_size = self.artifact.size;
        let staged = tokio::task::spawn_blocking(move || {
            let (digest, actual_size) =
                crate::adapter::hash_file_bounded_with_checkpoint(&path, expected_size, || Ok(()))?;
            Ok::<_, PortcoveError>((directory, path, digest, actual_size))
        })
        .await
        .map_err(|_| PortcoveError::verification("reviewed forge verification worker failed"))??;
        let (directory, path, digest, actual_size) = staged;
        verify_artifact(self.artifact, &digest, actual_size)?;
        Ok(VerifiedForgeDownload {
            _directory: directory,
            path,
        })
    }
}

/// A qualification download whose lifetime is limited to private scratch.
#[cfg(test)]
struct VerifiedForgeDownload {
    _directory: tempfile::TempDir,
    path: PathBuf,
}

#[cfg(test)]
impl VerifiedForgeDownload {
    fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
fn verify_artifact(artifact: &ReviewedForgeArtifact, digest: &str, size: u64) -> Result<()> {
    validate_download_size(size, artifact.size)?;
    if !digest.eq_ignore_ascii_case(&artifact.sha256) {
        return Err(PortcoveError::verification(
            "reviewed forge asset digest differs",
        ));
    }
    Ok(())
}

fn allows_asset(allowed: &[String], url: &Url) -> bool {
    safe_https(url)
        && url.query().is_none()
        && url
            .host_str()
            .is_some_and(|host| allowed.iter().any(|value| value == host))
}

fn parse_metadata<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    let value: crate::definition_entry::strict_json::UniqueValue = serde_json::from_slice(bytes)?;
    Ok(serde_json::from_value(value.0)?)
}

fn safe_coordinate(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

fn valid_host(host: &str) -> bool {
    host.len() <= 253
        && host.contains('.')
        && host.parse::<IpAddr>().is_err()
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

fn safe_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.host_str().is_some_and(valid_host)
}

fn invalid_instance() -> PortcoveError {
    PortcoveError::verification("invalid reviewed forge instance")
}

fn invalid_destination() -> PortcoveError {
    PortcoveError::verification("reviewed forge asset host or URL is outside its exact policy")
}

fn asset_mismatch() -> PortcoveError {
    PortcoveError::verification("reviewed forge asset identity differs or is ambiguous")
}

#[cfg(test)]
fn request_client(asset_hosts: Option<Vec<String>>) -> Result<Client> {
    let bounds = PROVIDER_NETWORK_BOUNDS;
    let builder = Client::builder()
        .no_proxy()
        .https_only(true)
        .dns_resolver(Arc::new(PublicDns))
        .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(bounds.connect)
        .read_timeout(bounds.read_idle);
    let builder = match asset_hosts {
        Some(hosts) => builder.redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() <= 4 && allows_asset(&hosts, attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("reviewed forge redirect exceeds its destination policy")
            }
        })),
        None => builder
            .redirect(redirect::Policy::none())
            .timeout(bounds.request),
    };
    builder
        .build()
        .map_err(|_| PortcoveError::network("reviewed forge transport unavailable"))
}

async fn request(client: &Client, url: Url) -> Result<Response> {
    client
        .get(url)
        .send()
        .await
        .map_err(|_| PortcoveError::network("reviewed forge request failed"))
}

struct PublicDns;

impl dns::Resolve for PublicDns {
    fn resolve(&self, name: dns::Name) -> dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 443))
                .await?
                .collect::<Vec<_>>();
            if addresses.is_empty()
                || addresses.len() > 64
                || addresses.iter().any(|socket| !public_address(socket.ip()))
            {
                return Err(std::io::Error::other(
                    "reviewed forge DNS contains an unsupported address",
                )
                .into());
            }
            Ok(Box::new(addresses.into_iter()) as dns::Addrs)
        })
    }
}

fn public_address(address: IpAddr) -> bool {
    // The simple staging policy permits global unicast IPv4 and the currently
    // allocated IPv6 global-unicast range. Special-use and transition ranges fail closed.
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_documentation()
                && a > 0
                && a < 224
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && ((b == 0 && c == 0) || (b == 88 && c == 99)))
                && !(a == 198 && matches!(b, 18 | 19))
        }
        IpAddr::V6(address) => {
            let [a, b, _, _, _, _, _, _] = address.segments();
            (0x2000..=0x3fff).contains(&a)
                && !(a == 0x2001 && (b <= 0x01ff || b == 0x0db8))
                && !matches!(a, 0x2002 | 0x3fff)
        }
    }
}

#[cfg(test)]
#[path = "reviewed_forge_tests.rs"]
mod tests;
