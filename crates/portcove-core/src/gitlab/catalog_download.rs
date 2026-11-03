//! Non-owning acquisition uses only same-project registry-backed links. The
//! managed provider's description-only/unknown-size fallback is not inherited.
use super::*;
use crate::{
    CatalogDownloadAssetId, CatalogDownloadCandidate, CatalogDownloadCoverage,
    CatalogDownloadRelease, CatalogDownloadReleaseId, CatalogForeignAssetId,
    CatalogForeignReleaseId,
};

const RELEASE_LIMIT: usize = 10;
const ASSET_LIMIT: usize = 200;

#[derive(Clone)]
enum RegistryReference {
    File(u64),
    Generic(reqwest::Url),
}

struct RegistryFile {
    file: GitlabPackageFile,
    generic_urls: Vec<reqwest::Url>,
}

struct RegistryIndex {
    references: HashMap<u64, RegistryReference>,
    files: Vec<RegistryFile>,
    limitations: Vec<String>,
}

fn release_id(project_id: u64, tag: &str) -> CatalogDownloadReleaseId {
    CatalogDownloadReleaseId::Foreign(CatalogForeignReleaseId::Gitlab {
        project_id,
        tag: tag.into(),
    })
}

fn link_id(link: &GitlabReleaseLink) -> Result<u64> {
    link.id.filter(|id| *id != 0).ok_or_else(|| {
        PortcoveError::verification("GitLab release link lacks its actual positive identity")
    })
}

fn limitation(link: &GitlabReleaseLink, reason: &str) -> String {
    let label = link.name.chars().take(128).collect::<String>();
    format!("{label}: {reason}.")
}

fn validate_file(file: &GitlabPackageFile) -> Result<()> {
    crate::archive::validate_relative_path(&file.file_name, false)?;
    crate::archive::validate_download_progress(0, file.size)?;
    if file.id == 0
        || file.size == 0
        || file.file_name.len() > 255
        || file.file_name.contains(['/', '\\'])
        || file
            .file_name
            .to_ascii_lowercase()
            .starts_with(".portcove-")
        || file.file_sha256.len() != 64
        || !file
            .file_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(PortcoveError::verification(
            "GitLab registry file has an invalid identity, filename, size or SHA-256",
        ));
    }
    Ok(())
}

impl GitlabReleaseProvider {
    async fn catalog_project(&self, repository: &str) -> Result<(String, u64, String)> {
        let project_url = self.project_url(repository)?;
        let project: GitlabProject = self.get_json(&project_url).await?;
        let canonical = project.path_with_namespace.as_deref().ok_or_else(|| {
            PortcoveError::verification("GitLab project has no canonical namespace")
        })?;
        if project.id == 0 || !canonical.eq_ignore_ascii_case(repository) {
            return Err(PortcoveError::verification(
                "GitLab project differs from the selected upstream identity",
            ));
        }
        Ok((project_url, project.id, canonical.into()))
    }

    fn registry_reference(
        &self,
        repository: &str,
        project_url: &str,
        project_id: u64,
        value: &str,
    ) -> Result<Option<RegistryReference>> {
        if value.len() > 4096 {
            return Err(PortcoveError::verification(
                "GitLab asset URL exceeds its bound",
            ));
        }
        let url = reqwest::Url::parse(value)
            .map_err(|_| PortcoveError::verification("invalid GitLab asset URL"))?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(PortcoveError::verification(
                "GitLab asset URL contains credentials, a query or a fragment",
            ));
        }
        let origin = reqwest::Url::parse(&self.api_root)
            .map_err(|_| PortcoveError::state("invalid GitLab provider origin"))?;
        if url.origin() != origin.origin() {
            return Ok(None);
        }
        let prefix = format!("/{repository}/-/package_files/");
        if let Some(tail) = url.path().strip_prefix(&prefix)
            && let Some((id, "download")) = tail.split_once('/')
        {
            let id = id
                .parse::<u64>()
                .ok()
                .filter(|id| *id != 0)
                .ok_or_else(|| {
                    PortcoveError::verification("invalid GitLab package-file URL identity")
                })?;
            return Ok(Some(RegistryReference::File(id)));
        }
        Ok(
            generic_package_url(project_url, &self.api_root, project_id, value)?
                .map(RegistryReference::Generic),
        )
    }

    async fn catalog_links(&self, project_url: &str, tag: &str) -> Result<Vec<GitlabReleaseLink>> {
        let mut base = reqwest::Url::parse(project_url)
            .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?;
        base.path_segments_mut()
            .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?
            .extend(["releases", tag, "assets"]);
        let mut links = Vec::new();
        // The final empty/short page proves completeness at the200-link boundary.
        for page in 1..=3 {
            let url = paginated_url(base.as_str(), "links", page, 100)?;
            let current: Vec<GitlabReleaseLink> = self.get_json(&url).await?;
            if current.len() > 100 || links.len() + current.len() > ASSET_LIMIT {
                return Err(PortcoveError::verification(
                    "GitLab release exceeds the200-link bound",
                ));
            }
            let complete = current.len() < 100;
            links.extend(current);
            if complete {
                return Ok(links);
            }
        }
        Err(PortcoveError::verification(
            "GitLab release link coverage is incomplete",
        ))
    }

    async fn catalog_release(
        &self,
        project_url: &str,
        project_id: u64,
        tag: &str,
    ) -> Result<GitlabRelease> {
        release_id(project_id, tag).validate()?;
        let mut url = reqwest::Url::parse(project_url)
            .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?;
        url.path_segments_mut()
            .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?
            .extend(["releases", tag]);
        let release: GitlabRelease = self.get_json(url.as_str()).await?;
        if release.tag_name != tag || release.upcoming_release {
            return Err(PortcoveError::verification(
                "selected GitLab release is not the exact published tag",
            ));
        }
        Ok(release)
    }

    async fn catalog_registry_index(
        &self,
        project_url: &str,
        repository: &str,
        project_id: u64,
        release: &GitlabRelease,
        links: &[GitlabReleaseLink],
    ) -> Result<RegistryIndex> {
        let mut index = RegistryIndex {
            references: HashMap::new(),
            files: Vec::new(),
            limitations: Vec::new(),
        };
        let mut ids = HashSet::new();
        for link in links {
            let id = link_id(link)?;
            if !ids.insert(id) || link.name.len() > 1024 || link.name.chars().any(char::is_control)
            {
                return Err(PortcoveError::verification(
                    "GitLab release repeats or malforms a link identity",
                ));
            }
            match self.registry_reference(repository, project_url, project_id, &link.url)? {
                Some(reference) => {
                    index.references.insert(id, reference);
                }
                None => index.limitations.push(limitation(
                    link,
                    "this host or upload route is outside supported GitLab registry downloads",
                )),
            }
        }
        if index.references.is_empty() {
            return Ok(index);
        }
        let normalized = release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name);
        let packages = self
            .packages(project_url)
            .await?
            .into_iter()
            .filter(|package| package.version == release.tag_name || package.version == normalized)
            .collect::<Vec<_>>();
        if packages.len() > GITLAB_MAX_MATCHING_PACKAGES {
            return Err(PortcoveError::verification(
                "GitLab release exceeds the matching-package bound",
            ));
        }
        let mut package_ids = HashSet::new();
        let mut file_ids = HashSet::new();
        let mut retained_bytes = 0usize;
        for package in packages {
            if package.id == 0
                || !package_ids.insert(package.id)
                || package.name.len() > 255
                || package.version.len() > 512
            {
                return Err(PortcoveError::verification(
                    "GitLab package inventory has an invalid or repeated identity",
                ));
            }
            let base = format!(
                "{}/projects/{project_id}/packages/{}",
                self.api_root, package.id
            );
            let mut complete = false;
            for page in 1..=GITLAB_MAX_PACKAGE_FILE_PAGES {
                let url = paginated_url(&base, "package_files", page, PROVIDER_PAGE_SIZE)?;
                let files: Vec<GitlabPackageFile> = self.get_json(&url).await?;
                if files.len() > PROVIDER_PAGE_SIZE {
                    return Err(PortcoveError::verification(
                        "GitLab package-file page exceeds its bound",
                    ));
                }
                complete = files.len() < PROVIDER_PAGE_SIZE;
                for file in files {
                    if file.id == 0 || !file_ids.insert(file.id) {
                        return Err(PortcoveError::verification(
                            "GitLab registry repeats a package-file identity",
                        ));
                    }
                    let wanted_id = index.references.values().any(|reference| matches!(reference, RegistryReference::File(id) if *id == file.id));
                    let mut generic_urls = Vec::new();
                    if file.file_name.len() <= 255 {
                        for project in [
                            project_url.to_owned(),
                            format!("{}/projects/{project_id}", self.api_root),
                        ] {
                            let mut url = reqwest::Url::parse(&project)
                                .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?;
                            url.path_segments_mut()
                                .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?
                                .extend([
                                    "packages",
                                    "generic",
                                    &package.name,
                                    &package.version,
                                    &file.file_name,
                                ]);
                            if index.references.values().any(|reference| matches!(reference, RegistryReference::Generic(wanted) if *wanted == url)) {
                                generic_urls.push(url);
                            }
                        }
                    }
                    if !wanted_id && generic_urls.is_empty() {
                        continue;
                    }
                    validate_file(&file)?;
                    retained_bytes = retained_bytes.saturating_add(
                        file.file_name.len()
                            + file.file_sha256.len()
                            + 64
                            + generic_urls
                                .iter()
                                .map(|url| url.as_str().len())
                                .sum::<usize>(),
                    );
                    if retained_bytes > PROVIDER_JSON_MAX_BYTES {
                        return Err(PortcoveError::verification(
                            "GitLab registry matches exceed the metadata bound",
                        ));
                    }
                    index.files.push(RegistryFile { file, generic_urls });
                }
                if complete {
                    break;
                }
            }
            if !complete {
                return Err(PortcoveError::verification(
                    "GitLab package-file coverage exceeds its bound",
                ));
            }
        }
        Ok(index)
    }

    async fn catalog_registry_file<'a>(
        &self,
        reference: &RegistryReference,
        files: &'a [RegistryFile],
    ) -> Result<Option<&'a GitlabPackageFile>> {
        let mut matches = files
            .iter()
            .filter(|row| match reference {
                RegistryReference::File(id) => row.file.id == *id,
                RegistryReference::Generic(url) => row.generic_urls.contains(url),
            })
            .map(|row| &row.file)
            .collect::<Vec<_>>();
        let ambiguous = matches.len() > 1;
        if ambiguous {
            let RegistryReference::Generic(url) = reference else {
                return Err(PortcoveError::conflict(
                    "GitLab registry file identity is ambiguous",
                ));
            };
            // The endpoint's current upload is still joined to an independent
            // registry row. Never pick the first duplicate or hash a download.
            let response = self
                .client
                .head(url.clone())
                .send()
                .await
                .map_err(|error| PortcoveError::network(error.to_string()))?;
            if !response.status().is_success() {
                return Err(gitlab_http_error(response.status(), response.headers()));
            }
            let checksums = response
                .headers()
                .get_all("x-checksum-sha256")
                .iter()
                .collect::<Vec<_>>();
            let digest = checksums
                .first()
                .filter(|_| checksums.len() == 1)
                .and_then(|value| value.to_str().ok())
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| {
                    PortcoveError::verification(
                        "GitLab duplicate upload requires one published SHA-256 header",
                    )
                })?;
            let size = response
                .headers()
                .get(header::CONTENT_LENGTH)
                .map(|value| {
                    value
                        .to_str()
                        .ok()
                        .and_then(|value| value.parse::<u64>().ok())
                        .ok_or_else(|| {
                            PortcoveError::verification("invalid GitLab upload size header")
                        })
                })
                .transpose()?;
            matches.retain(|file| {
                file.file_sha256.eq_ignore_ascii_case(digest)
                    && size.is_none_or(|size| size == file.size)
            });
        }
        if ambiguous && matches.len() != 1 {
            return Err(PortcoveError::conflict(
                "GitLab upload does not uniquely identify one registry file",
            ));
        }
        Ok(matches.into_iter().next())
    }

    fn catalog_registry_candidate(
        &self,
        repository: &str,
        project_id: u64,
        release: &GitlabRelease,
        link: &GitlabReleaseLink,
        file: &GitlabPackageFile,
    ) -> Result<CatalogDownloadCandidate> {
        validate_file(file)?;
        let release_id = release_id(project_id, &release.tag_name);
        let asset_id = CatalogDownloadAssetId::Foreign(CatalogForeignAssetId::Gitlab {
            project_id,
            tag: release.tag_name.clone(),
            link_id: link_id(link)?,
            file_id: file.id,
        });
        asset_id.validate_for(&release_id)?;
        let mut release_url =
            reqwest::Url::parse(&format!("https://gitlab.com/{repository}/-/releases/"))
                .map_err(|_| PortcoveError::verification("invalid GitLab release URL"))?;
        release_url
            .path_segments_mut()
            .map_err(|_| PortcoveError::verification("invalid GitLab release URL"))?
            .pop_if_empty()
            .push(&release.tag_name);
        let lower = file.file_name.to_ascii_lowercase();
        Ok(CatalogDownloadCandidate {
            release_id,
            asset_id,
            release_tag: release.tag_name.clone(),
            release_url: release_url.into(),
            name: file.file_name.clone(),
            size: file.size,
            download_url: link.url.clone(),
            sha256: Some(file.file_sha256.to_ascii_lowercase()),
            can_extract: lower.ends_with(".zip")
                || lower.ends_with(".tar.gz")
                || lower.ends_with(".tgz"),
        })
    }

    pub(crate) async fn catalog_download_options(
        &self,
        repository: &str,
        selected: Option<&CatalogDownloadReleaseId>,
        channel: ReleaseChannel,
        rolling_tag: Option<&str>,
    ) -> Result<(
        Vec<CatalogDownloadCandidate>,
        CatalogDownloadCoverage,
        Vec<CatalogDownloadRelease>,
        Option<CatalogDownloadReleaseId>,
    )> {
        if let Some(selected) = selected {
            selected.validate()?;
            if selected.github_id().is_some() {
                return Err(PortcoveError::usage(
                    "GitHub release IDs cannot select GitLab releases",
                ));
            }
        }
        let (project_url, project_id, canonical) = self.catalog_project(repository).await?;
        let url = paginated_url(&project_url, "releases", 1, RELEASE_LIMIT)?;
        let mut releases: Vec<GitlabRelease> = self.get_json(&url).await?;
        if releases.len() > RELEASE_LIMIT {
            return Err(PortcoveError::verification(
                "GitLab release browse page exceeds its bound",
            ));
        }
        let history_complete = releases.len() < RELEASE_LIMIT;
        if let Some(CatalogDownloadReleaseId::Foreign(CatalogForeignReleaseId::Gitlab {
            project_id: expected,
            tag,
        })) = selected
        {
            if *expected != project_id {
                return Err(PortcoveError::verification(
                    "selected GitLab project changed",
                ));
            }
            if releases
                .iter()
                .any(|release| release.tag_name == *tag && release.upcoming_release)
            {
                return Err(PortcoveError::verification(
                    "selected GitLab release is not published",
                ));
            }
            if !releases.iter().any(|release| release.tag_name == *tag) {
                releases.push(self.catalog_release(&project_url, project_id, tag).await?);
            }
        } else if !history_complete {
            let preferred = crate::release::select_channel_candidate(
                &releases,
                channel,
                rolling_tag,
                |release| !release.upcoming_release,
                |release| is_beta_tag(&release.tag_name),
                |release| release.tag_name.as_str(),
            );
            if preferred.is_none()
                || (channel == ReleaseChannel::Beta
                    && preferred.is_some_and(|release| !is_beta_tag(&release.tag_name)))
            {
                releases = self.releases(&project_url).await?;
            }
        }
        let mut tags = HashSet::new();
        for release in &releases {
            release_id(project_id, &release.tag_name).validate()?;
            if !tags.insert(release.tag_name.as_str()) {
                return Err(PortcoveError::verification(
                    "GitLab release listing repeats a tag",
                ));
            }
        }
        let chosen =
            if let Some(CatalogDownloadReleaseId::Foreign(CatalogForeignReleaseId::Gitlab {
                tag,
                ..
            })) = selected
            {
                releases
                    .iter()
                    .find(|release| release.tag_name == *tag && !release.upcoming_release)
            } else {
                crate::release::select_channel_candidate(
                    &releases,
                    channel,
                    rolling_tag,
                    |release| !release.upcoming_release,
                    |release| is_beta_tag(&release.tag_name),
                    |release| release.tag_name.as_str(),
                )
            };
        let mut candidates = Vec::new();
        let mut limitations = Vec::new();
        if let Some(release) = chosen {
            let links = self.catalog_links(&project_url, &release.tag_name).await?;
            let index = self
                .catalog_registry_index(&project_url, &canonical, project_id, release, &links)
                .await?;
            limitations = index.limitations.clone();
            for link in &links {
                let Some(reference) = index.references.get(&link_id(link)?) else {
                    continue;
                };
                match self.catalog_registry_file(reference, &index.files).await? {
                    Some(file) => {
                        candidates.push(self.catalog_registry_candidate(
                            &canonical, project_id, release, link, file,
                        )?)
                    }
                    None => limitations.push(limitation(
                        link,
                        "no matching registry file establishes its size and checksum",
                    )),
                }
            }
        }
        let chosen_id = chosen.map(|release| release_id(project_id, &release.tag_name));
        let summaries = releases
            .iter()
            .enumerate()
            .filter(|(index, release)| {
                !release.upcoming_release
                    && (*index < RELEASE_LIMIT
                        || chosen.is_some_and(|chosen| chosen.tag_name == release.tag_name))
            })
            .map(|(_, release)| CatalogDownloadRelease {
                id: release_id(project_id, &release.tag_name),
                tag: release.tag_name.clone(),
                preview: is_beta_tag(&release.tag_name),
                assets_complete: limitations.is_empty()
                    && chosen.is_some_and(|chosen| chosen.tag_name == release.tag_name),
            })
            .collect();
        Ok((
            candidates,
            CatalogDownloadCoverage {
                release_limit: RELEASE_LIMIT,
                candidate_limit: ASSET_LIMIT,
                releases_checked: usize::from(chosen.is_some()),
                release_history_complete: history_complete,
                candidates_complete: limitations.is_empty(),
                limitations,
            },
            summaries,
            chosen_id,
        ))
    }

    pub(crate) async fn catalog_download_candidate(
        &self,
        repository: &str,
        release_id: &CatalogDownloadReleaseId,
        asset_id: &CatalogDownloadAssetId,
    ) -> Result<CatalogDownloadCandidate> {
        asset_id.validate_for(release_id)?;
        let (
            CatalogDownloadReleaseId::Foreign(CatalogForeignReleaseId::Gitlab {
                project_id: expected_project,
                tag,
            }),
            CatalogDownloadAssetId::Foreign(CatalogForeignAssetId::Gitlab {
                link_id: expected_link,
                ..
            }),
        ) = (release_id, asset_id)
        else {
            return Err(PortcoveError::usage(
                "GitLab download requires its typed project, tag and link identity",
            ));
        };
        let (project_url, project_id, canonical) = self.catalog_project(repository).await?;
        if project_id != *expected_project {
            return Err(PortcoveError::conflict("selected GitLab project changed"));
        }
        let release = self.catalog_release(&project_url, project_id, tag).await?;
        let mut url = reqwest::Url::parse(&project_url)
            .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?;
        url.path_segments_mut()
            .map_err(|_| PortcoveError::state("invalid GitLab project URL"))?
            .extend([
                "releases",
                tag,
                "assets",
                "links",
                &expected_link.to_string(),
            ]);
        let link: GitlabReleaseLink = self.get_json(url.as_str()).await?;
        if link_id(&link)? != *expected_link {
            return Err(PortcoveError::verification(
                "GitLab link endpoint returned another identity",
            ));
        }
        let index = self
            .catalog_registry_index(
                &project_url,
                &canonical,
                project_id,
                &release,
                std::slice::from_ref(&link),
            )
            .await?;
        let reference = index.references.get(expected_link).ok_or_else(|| {
            PortcoveError::unsupported(
                "this link is outside supported GitLab registry downloads; open upstream setup",
            )
        })?;
        let file = self
            .catalog_registry_file(reference, &index.files)
            .await?
            .ok_or_else(|| {
                PortcoveError::verification(
                    "GitLab registry no longer establishes the selected file",
                )
            })?;
        let candidate =
            self.catalog_registry_candidate(&canonical, project_id, &release, &link, file)?;
        if candidate.asset_id != *asset_id {
            return Err(PortcoveError::conflict(
                "selected GitLab registry file changed; refresh the downloads",
            ));
        }
        Ok(candidate)
    }

    pub(crate) fn catalog_download_client(
        &self,
        repository: &str,
        candidate: &CatalogDownloadCandidate,
    ) -> Result<reqwest::Client> {
        candidate.asset_id.validate_for(&candidate.release_id)?;
        let CatalogDownloadAssetId::Foreign(CatalogForeignAssetId::Gitlab {
            project_id,
            file_id,
            ..
        }) = &candidate.asset_id
        else {
            return Err(PortcoveError::verification(
                "GitLab transport requires a GitLab file identity",
            ));
        };
        let project_url = self.project_url(repository)?;
        let reference = self.registry_reference(
            repository,
            &project_url,
            *project_id,
            &candidate.download_url,
        )?;
        if reference.is_none()
            || matches!(reference, Some(RegistryReference::File(id)) if id != *file_id)
        {
            return Err(PortcoveError::verification(
                "GitLab transport URL is outside its selected project registry",
            ));
        }
        let initial = reqwest::Url::parse(&candidate.download_url)
            .map_err(|_| PortcoveError::verification("invalid GitLab transport URL"))?;
        let file_path = format!("/{repository}/-/package_files/{file_id}/download");
        reqwest::Client::builder()
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(self.network_bounds.connect)
            .read_timeout(self.network_bounds.read_idle)
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("GitLab download redirect limit exceeded");
                }
                let url = attempt.url();
                if url.origin() == initial.origin()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && (url == &initial || url.path() == file_path)
                {
                    attempt.follow()
                } else {
                    attempt.error("GitLab download redirected outside its selected registry file")
                }
            }))
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))
    }
}

#[cfg(test)]
mod tests;
