//! Fixed historical metadata for the isolated #141 producer; no normal selector change.
use super::*;

pub(crate) const PORT: &str = "yu-gi-oh-forbidden-memories-recompiled";
const REPOSITORY: &str = "Unchiga/YuGiOhForbiddenMemoriesRecomp";
const REPOSITORY_ID: u64 = 1_339_885_631;
const RELEASE_ID: u64 = 387_954_225;
const ASSET_ID: u64 = 561_508_224;
const TAG: &str = "v0.6.1";
const NAME: &str = "ygofm-0.6.1-win-x64.zip";
const SIZE: u64 = 34_799_128;
const DIGEST: &str = "4eed315000952dee7a751a05de4413a88777cf49609d29ab77ee3765a44d0f53";
const URL: &str = "https://github.com/Unchiga/YuGiOhForbiddenMemoriesRecomp/releases/download/v0.6.1/ygofm-0.6.1-win-x64.zip";

#[derive(Deserialize)]
struct HistoricalRelease {
    id: u64,
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<HistoricalAsset>,
}

#[derive(Deserialize)]
struct HistoricalAsset {
    id: u64,
    #[serde(flatten)]
    asset: GithubAsset,
}

fn authenticated_baseline(
    port: &PortDefinition,
    repository: GithubRepository,
    release: HistoricalRelease,
) -> Result<ResolvedRelease> {
    if port.id != PORT
        || port.release.repository != REPOSITORY
        || repository.id != Some(REPOSITORY_ID)
        || release.id != RELEASE_ID
        || release.tag_name != TAG
        || release.draft
        || release.prerelease
    {
        return Err(PortcoveError::verification(
            "historical producer release identity changed",
        ));
    }
    let assets: Vec<_> = release
        .assets
        .iter()
        .map(|entry| entry.asset.clone())
        .collect();
    // Consume the existing complete-inventory selector; a newly ambiguous asset
    // is refused rather than silently selecting our expected filename.
    let selected = choose_asset(port, Platform::WindowsX86_64, &assets)?;
    let identities: Vec<_> = release
        .assets
        .iter()
        .filter(|entry| entry.asset.name == selected.name)
        .collect();
    if identities.len() != 1
        || identities[0].id != ASSET_ID
        || selected.name != NAME
        || selected.browser_download_url != URL
        || selected.size != SIZE
        || selected.digest.as_deref().and_then(parse_digest).as_deref() != Some(DIGEST)
    {
        return Err(PortcoveError::verification(
            "historical producer asset identity changed",
        ));
    }
    Ok(ResolvedRelease {
        version: TAG.into(),
        channel: ReleaseChannel::Stable,
        published_at: release.published_at,
        asset: ReleaseAsset {
            name: NAME.into(),
            url: URL.into(),
            size: SIZE,
            sha256: DIGEST.into(),
        },
    })
}

#[cfg(feature = "qualification-fixtures")]
impl GithubReleaseProvider {
    pub(crate) async fn forbidden_memories_baseline(
        &self,
        port: &PortDefinition,
    ) -> Result<ResolvedRelease> {
        if self.api_root != "https://api.github.com"
            || self.web_root != "https://github.com"
            || self.qualification_origin.is_some()
        {
            return Err(PortcoveError::unsupported(
                "historical producer requires the normal official provider",
            ));
        }
        let repository_url = format!("https://api.github.com/repos/{REPOSITORY}");
        let repository = self.get_json(&repository_url).await?;
        let release = self
            .get_json(&format!("{repository_url}/releases/{RELEASE_ID}"))
            .await?;
        authenticated_baseline(port, repository, release)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Catalog;

    fn metadata() -> serde_json::Value {
        serde_json::json!({
            "id": RELEASE_ID, "tag_name": TAG, "draft": false, "prerelease": false,
            "published_at": "2026-09-15T00:00:00Z",
            "assets": [{"id": ASSET_ID, "name": NAME, "browser_download_url": URL,
                "size": SIZE, "digest": format!("sha256:{DIGEST}")}]
        })
    }

    fn check(repository_id: u64, value: serde_json::Value) -> Result<ResolvedRelease> {
        let catalog = Catalog::from_json(include_str!("../../catalog/catalog.json")).unwrap();
        authenticated_baseline(
            catalog.port(PORT).unwrap(),
            GithubRepository {
                id: Some(repository_id),
                archived: false,
            },
            serde_json::from_value(value).unwrap(),
        )
    }

    #[test]
    fn historical_producer_binds_every_release_and_asset_identity() {
        let value = metadata();
        assert_eq!(
            check(REPOSITORY_ID, value.clone()).unwrap().asset.sha256,
            DIGEST
        );
        assert!(check(REPOSITORY_ID + 1, value.clone()).is_err());
        for (pointer, replacement) in [
            ("/id", serde_json::json!(RELEASE_ID + 1)),
            ("/tag_name", serde_json::json!("v0.6.2")),
            ("/draft", serde_json::json!(true)),
            ("/prerelease", serde_json::json!(true)),
            ("/assets/0/id", serde_json::json!(ASSET_ID + 1)),
            ("/assets/0/name", serde_json::json!("alternate-win-x64.zip")),
            (
                "/assets/0/browser_download_url",
                serde_json::json!("https://example.invalid/asset.zip"),
            ),
            ("/assets/0/size", serde_json::json!(SIZE + 1)),
            (
                "/assets/0/digest",
                serde_json::json!(format!("sha256:{}", "0".repeat(64))),
            ),
        ] {
            let mut changed = value.clone();
            *changed.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                check(REPOSITORY_ID, changed).is_err(),
                "accepted drift at {pointer}"
            );
        }
        let mut duplicate = value;
        let asset = duplicate["assets"][0].clone();
        duplicate["assets"].as_array_mut().unwrap().push(asset);
        assert!(check(REPOSITORY_ID, duplicate).is_err());
        for digest in [
            serde_json::Value::Null,
            serde_json::json!("sha256:malformed"),
        ] {
            let mut changed = metadata();
            changed["assets"][0]["digest"] = digest;
            assert!(check(REPOSITORY_ID, changed).is_err());
        }
        let mut ambiguous = metadata();
        let mut other = ambiguous["assets"][0].clone();
        other["id"] = serde_json::json!(ASSET_ID + 2);
        other["name"] = serde_json::json!("ygofm-alternate-win-x64.zip");
        ambiguous["assets"].as_array_mut().unwrap().push(other);
        assert!(check(REPOSITORY_ID, ambiguous).is_err());
    }

    #[cfg(feature = "qualification-fixtures")]
    #[tokio::test]
    async fn historical_producer_rejects_nonofficial_origin_before_request() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let alternate = format!("http://{}", listener.local_addr().unwrap());
        let catalog = Catalog::from_json(include_str!("../../catalog/catalog.json")).unwrap();
        for (api, web, fixture) in [
            (alternate.as_str(), "https://github.com", false),
            ("https://api.github.com", alternate.as_str(), false),
            ("https://api.github.com", "https://github.com", true),
        ] {
            let mut provider = GithubReleaseProvider::build_with_credential(
                None,
                api,
                web,
                PROVIDER_NETWORK_BOUNDS,
                Some(GithubCredential {
                    token: None,
                    source: GithubAuthSource::Anonymous,
                    intent: 0,
                }),
                false,
            )
            .unwrap();
            if fixture {
                provider.qualification_origin = Some(alternate.clone());
            }
            let error = provider
                .forbidden_memories_baseline(catalog.port(PORT).unwrap())
                .await
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Unsupported);
            assert!(error.message.contains("normal official provider"));
        }
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
