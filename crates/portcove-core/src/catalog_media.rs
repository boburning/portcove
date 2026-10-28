//! Reviewed descriptive media. Images never grant installation or launch authority.
use std::{collections::HashSet, io::Read, path::PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ArtworkThumbnail, Library, OriginalGameIdentity, PortcoveError, PortcoveService, Result,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CatalogMediaRole {
    Header,
    Screenshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CatalogMediaSubject {
    Port {
        port_id: String,
    },
    Original {
        game_id: String,
        source_edition_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CatalogMediaAsset {
    pub id: String,
    pub role: CatalogMediaRole,
    pub subject: CatalogMediaSubject,
    pub caption: String,
    pub url: String,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
    pub attribution: String,
    pub source_url: String,
    pub license: String,
    pub rights_url: String,
}

pub fn validate_catalog_media(
    port_id: &str,
    original_game: Option<&OriginalGameIdentity>,
    media: &[CatalogMediaAsset],
) -> Result<()> {
    let mut ids = HashSet::new();
    if media.len() > 9
        || media
            .iter()
            .filter(|asset| asset.role == CatalogMediaRole::Header)
            .count()
            > 1
        || media
            .iter()
            .filter(|asset| asset.role == CatalogMediaRole::Screenshot)
            .count()
            > 8
    {
        return Err(PortcoveError::usage(
            "catalog media permits one header and eight screenshots",
        ));
    }
    for asset in media {
        if !valid_id(&asset.id) || !ids.insert(&asset.id) {
            return Err(PortcoveError::usage(
                "catalog media needs unique stable image IDs",
            ));
        }
        crate::artwork_store::validate_hash(&asset.sha256)?;
        if asset.width == 0
            || asset.height == 0
            || asset.width > 8192
            || asset.height > 8192
            || u64::from(asset.width) * u64::from(asset.height) > crate::artwork_image::MAX_PIXELS
            || !valid_text(&asset.caption, 512)
            || !valid_text(&asset.attribution, 1024)
            || !evidence_url(&asset.source_url)
            || !evidence_url(&asset.rights_url)
            || !matches!(
                asset.license.as_str(),
                "CC0-1.0"
                    | "CC-BY-3.0"
                    | "CC-BY-4.0"
                    | "CC-BY-SA-3.0"
                    | "CC-BY-SA-4.0"
                    | "MIT"
                    | "Apache-2.0"
                    | "BSD-2-Clause"
                    | "BSD-3-Clause"
                    | "GPL-2.0-only"
                    | "GPL-2.0-or-later"
                    | "GPL-3.0-only"
                    | "GPL-3.0-or-later"
                    | "LicenseRef-Permission"
            )
        {
            return Err(PortcoveError::usage(
                "catalog media needs bounded dimensions, descriptive credit and reviewed rights evidence",
            ));
        }
        fetch_url(&asset.url)?;
        let matches = match &asset.subject {
            CatalogMediaSubject::Port {
                port_id: image_port,
            } => image_port == port_id,
            CatalogMediaSubject::Original {
                game_id,
                source_edition_id,
            } => original_game.is_some_and(|game| {
                game.id == *game_id
                    && game
                        .source_editions
                        .iter()
                        .any(|edition| edition.id == *source_edition_id)
            }),
        };
        if !matches {
            return Err(PortcoveError::usage(
                "catalog media must name this exact port or an explicitly offered original-game edition",
            ));
        }
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn evidence_url(value: &str) -> bool {
    value.len() <= 2048
        && reqwest::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
}

fn fetch_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| PortcoveError::usage("catalog media URL is invalid"))?;
    if value.len() > 2048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(PortcoveError::usage(
            "catalog media requires a public immutable HTTPS image URL",
        ));
    }
    let supported = match url.host_str() {
        Some("raw.githubusercontent.com") => {
            let segments = url
                .path_segments()
                .map(|segments| segments.collect::<Vec<_>>())
                .unwrap_or_default();
            segments.len() >= 4
                && !segments[0].is_empty()
                && !segments[1].is_empty()
                && segments[2].len() == 40
                && segments[2].bytes().all(|byte| byte.is_ascii_hexdigit())
        }
        Some("images.igdb.com") => url.path().starts_with("/igdb/image/upload/"),
        Some("upload.wikimedia.org") => url.path().starts_with("/wikipedia/commons/"),
        _ => false,
    };
    if !supported {
        return Err(PortcoveError::usage(
            "catalog media image host or immutable source path is unsupported",
        ));
    }
    Ok(url)
}

impl PortcoveService {
    pub fn catalog_media_thumbnail(
        &self,
        port_id: &str,
        media_id: &str,
        expected_sha256: &str,
    ) -> Result<ArtworkThumbnail> {
        crate::artwork_store::validate_hash(expected_sha256)?;
        let listing = self.artwork_port(port_id)?;
        validate_catalog_media(port_id, listing.original_game.as_ref(), &listing.media)?;
        let asset = listing
            .media
            .iter()
            .find(|asset| asset.id == media_id)
            .ok_or_else(|| PortcoveError::not_found("this catalog image is no longer available"))?;
        if asset.sha256 != expected_sha256 {
            return Err(PortcoveError::conflict(
                "catalog image changed; refresh its details",
            ));
        }
        thumbnail_with_fetch(self.library(), asset, || fetch_original(asset))
    }
}

fn cache_path(library: &Library, asset: &CatalogMediaAsset) -> Result<PathBuf> {
    crate::artwork_store::validate_hash(&asset.sha256)?;
    let path = library
        .root()
        .join("artwork-cache")
        .join(format!("{}.image", asset.sha256));
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(path)
}

fn thumbnail_with_fetch(
    library: &Library,
    asset: &CatalogMediaAsset,
    fetch: impl FnOnce() -> Result<Vec<u8>>,
) -> Result<ArtworkThumbnail> {
    let _permit = crate::artwork::admit_image_work()?;
    let path = cache_path(library, asset)?;
    let cached = crate::path::read_bounded_regular(&path, crate::artwork_image::MAX_ORIGINAL_BYTES)
        .ok()
        .filter(|bytes| crate::signed_catalog::digest(bytes) == asset.sha256);
    let from_cache = cached.is_some();
    let original = match cached {
        Some(bytes) => bytes,
        None => fetch()?,
    };
    if original.len() as u64 > crate::artwork_image::MAX_ORIGINAL_BYTES
        || crate::signed_catalog::digest(&original) != asset.sha256
    {
        return Err(PortcoveError::verification(
            "catalog image differs from its admitted content identity",
        ));
    }
    let decoded = crate::artwork_image::decode(&original)?;
    if decoded.width != asset.width || decoded.height != asset.height {
        return Err(PortcoveError::verification(
            "catalog image dimensions differ from its admitted metadata",
        ));
    }
    if !from_cache {
        let _guard = library.try_lock_artwork()?;
        crate::artwork::publish_cache_file(
            library,
            &path,
            "pending-catalog-media-original",
            crate::artwork_image::MAX_ORIGINAL_BYTES,
            &original,
        )?;
    }
    Ok(ArtworkThumbnail {
        asset_sha256: asset.sha256.clone(),
        choice_revision: 0,
        png: decoded.thumbnail,
    })
}

fn fetch_original(asset: &CatalogMediaAsset) -> Result<Vec<u8>> {
    let url = fetch_url(&asset.url)?;
    // Reuse the credential-free finite artwork client; redirects are refused.
    let response = crate::artwork::igdb_http_client()
        .map_err(|failure| failure.error)?
        .get(url)
        .send()
        .map_err(|error| {
            PortcoveError::network(format!("catalog image request failed: {error}"))
        })?;
    if !response.status().is_success() {
        return Err(PortcoveError::network(format!(
            "catalog image unavailable (HTTP {})",
            response.status()
        )));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if !matches!(content_type, "image/png" | "image/jpeg")
        || response
            .content_length()
            .is_some_and(|length| length > crate::artwork_image::MAX_ORIGINAL_BYTES)
    {
        return Err(PortcoveError::verification(
            "catalog image response is not a bounded PNG or JPEG",
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(crate::artwork_image::MAX_ORIGINAL_BYTES + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn asset() -> CatalogMediaAsset {
        CatalogMediaAsset {
            id: "play-screen".into(),
            role: CatalogMediaRole::Screenshot,
            subject: CatalogMediaSubject::Port {
                port_id: "example".into(),
            },
            caption: "Synthetic test scene".into(),
            url: format!(
                "https://raw.githubusercontent.com/owner/project/{}/shot.png",
                "a".repeat(40)
            ),
            sha256: "a".repeat(64),
            width: 2,
            height: 1,
            attribution: "Portcove test fixture".into(),
            source_url: "https://github.com/owner/project".into(),
            license: "CC0-1.0".into(),
            rights_url: "https://github.com/owner/project/blob/main/LICENSE".into(),
        }
    }

    #[test]
    fn media_requires_exact_port_or_explicit_original_edition() {
        let mut image = asset();
        assert!(validate_catalog_media("example", None, &[image.clone()]).is_ok());
        assert!(validate_catalog_media("other", None, &[image.clone()]).is_err());
        let game = OriginalGameIdentity {
            format_version: 1,
            id: "original-game".into(),
            evidence_urls: vec!["https://example.com".into()],
            source_editions: vec![crate::SourceEdition {
                id: "usa-v1".into(),
                title: "USA version 1".into(),
                system: Some("nintendo-64".into()),
                evidence_urls: vec!["https://example.com".into()],
            }],
        };
        image.subject = CatalogMediaSubject::Original {
            game_id: game.id.clone(),
            source_edition_id: "usa-v1".into(),
        };
        assert!(validate_catalog_media("example", Some(&game), &[image.clone()]).is_ok());
        image.subject = CatalogMediaSubject::Original {
            game_id: game.id.clone(),
            source_edition_id: "europe-v1".into(),
        };
        assert!(validate_catalog_media("example", Some(&game), &[image]).is_err());
    }

    #[test]
    fn media_rejects_unreviewed_rights_unsafe_fetches_and_unbounded_catalogs() {
        let image = asset();
        for url in [
            "http://images.igdb.com/igdb/image/upload/image.jpg",
            "https://127.0.0.1/image.png",
            "https://raw.githubusercontent.com/o/r/main/a.png",
            "https://images.igdb.com/igdb/image/upload/image.jpg?token=private",
            "https://user:password@images.igdb.com/igdb/image/upload/image.jpg",
        ] {
            let mut invalid = image.clone();
            invalid.url = url.into();
            assert!(
                validate_catalog_media("example", None, &[invalid]).is_err(),
                "{url}"
            );
        }
        let mut invalid = image.clone();
        invalid.license = "unknown".into();
        assert!(validate_catalog_media("example", None, &[invalid]).is_err());
        let mut invalid = image.clone();
        invalid.width = 8193;
        assert!(validate_catalog_media("example", None, &[invalid]).is_err());
        assert!(validate_catalog_media("example", None, &[image.clone(), image.clone()]).is_err());
        assert!(validate_catalog_media("example", None, &vec![image; 10]).is_err());
    }

    #[test]
    fn thumbnails_revalidate_cached_bytes_and_dimensions_without_creating_user_choices() {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path().join("library")).unwrap();
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2, 1, image::Rgb([20, 40, 60])))
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let bytes = encoded.into_inner();
        let mut image = asset();
        image.sha256 = crate::signed_catalog::digest(&bytes);
        let first = thumbnail_with_fetch(&library, &image, || Ok(bytes.clone())).unwrap();
        assert_eq!(first.asset_sha256, image.sha256);
        assert_eq!(first.choice_revision, 0);
        assert!(!first.png.is_empty());
        let second = thumbnail_with_fetch(&library, &image, || {
            panic!("valid cached original must be reused")
        })
        .unwrap();
        assert_eq!(first.png, second.png);
        std::fs::write(cache_path(&library, &image).unwrap(), b"changed").unwrap();
        assert!(thumbnail_with_fetch(&library, &image, || Ok(b"foreign".to_vec())).is_err());
        let mut wrong_dimensions = image.clone();
        wrong_dimensions.width += 1;
        assert!(thumbnail_with_fetch(&library, &wrong_dimensions, || Ok(bytes.clone())).is_err());
        assert!(
            crate::artwork_store::snapshot(&library.connection().unwrap())
                .unwrap()
                .choices
                .is_empty()
        );
    }
}
