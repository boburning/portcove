use std::{
    future::Future,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use reqwest::{Client, Response, Url, dns, redirect};
use serde::Deserialize;

use crate::{
    Installer, OperationCoordinator, PortcoveError, ReleaseAsset, Result,
    archive::{validate_download_progress, validate_download_size},
    release::{PROVIDER_JSON_MAX_BYTES, PROVIDER_NETWORK_BOUNDS, bounded_response_bytes},
};

/// An explicitly reviewed instance. Qualification builds accept fixture input.
/// Production callers will need a signed definition and a separate acquisition grant.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewedForge {
    dialect: ForgeDialect,
    api_root: String,
    web_host: String,
    asset_hosts: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ForgeDialect {
    GithubV3,
    GitlabV4,
    ForgejoV1,
}

/// Exact acquisition evidence supplied independently of the forge's response.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewedForgeArtifact {
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

struct ForgeRoute<'a> {
    instance: &'a ReviewedForge,
    artifact: &'a ReviewedForgeArtifact,
    api: Url,
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
    fn route<'a>(&'a self, artifact: &'a ReviewedForgeArtifact) -> Result<ForgeRoute<'a>> {
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
        Ok(ForgeRoute {
            instance: self,
            artifact,
            api,
            download,
        })
    }

    /// Fetches one reviewed artifact into the caller's private staging directory.
    /// A temporary file becomes available only after the reviewed hash and size match.
    pub async fn fetch(
        &self,
        artifact: &ReviewedForgeArtifact,
        private_staging: &Path,
    ) -> Result<VerifiedForgeDownload> {
        let route = self.route(artifact)?;
        let metadata = request_client(None)?;
        route
            .resolve(|url| {
                let metadata = &metadata;
                async move {
                    let response = request(metadata, url).await?;
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

        route.download(private_staging).await
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

    async fn download(&self, private_staging: &Path) -> Result<VerifiedForgeDownload> {
        let client = request_client(Some(self.instance.asset_hosts.clone()))?;
        let directory = tempfile::tempdir_in(private_staging)?;
        let path = directory.path().join("archive");
        let operation = OperationCoordinator::new("reviewed forge qualification", None);
        let asset = ReleaseAsset {
            name: self.artifact.name.clone(),
            url: self.download.as_str().into(),
            size: self.artifact.size,
            sha256: self.artifact.sha256.clone(),
        };
        Installer::download_with_client(&client, &asset, &path, &operation, &mut |_| {}).await?;
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
pub struct VerifiedForgeDownload {
    _directory: tempfile::TempDir,
    path: PathBuf,
}

impl VerifiedForgeDownload {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

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
