//! Reviewed descriptive media. Images never grant installation or launch authority.
use std::{collections::HashSet, io::Read, path::PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ArtworkThumbnail, Library, OriginalGameIdentity, PortcoveError, PortcoveService, Result,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CatalogMediaRole {
    Header,
    Screenshot,
    Logo,
    KeyArt,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IgdbGameImageKind {
    Logo,
    Artwork,
}

/// A reviewed mapping from IGDB's game-logo or artwork endpoint. These are
/// public descriptive IDs, never API credentials or installation authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct IgdbGameImage {
    pub game_id: u64,
    pub record_id: u64,
    pub kind: IgdbGameImageKind,
    pub image_id: String,
    pub game_slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha_channel: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_type: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_type_name: Option<String>,
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
    /// Reviewed applicability across offered original editions, for any media role.
    /// Absence never implies that an offered edition is the selected edition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edition_neutral: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub igdb: Option<IgdbGameImage>,
}

pub fn validate_catalog_media(
    port_id: &str,
    original_game: Option<&OriginalGameIdentity>,
    media: &[CatalogMediaAsset],
) -> Result<()> {
    let mut ids = HashSet::new();
    if media.len() > 14
        || media
            .iter()
            .filter(|asset| asset.role == CatalogMediaRole::Header)
            .count()
            > 2
        || media
            .iter()
            .filter(|asset| asset.role == CatalogMediaRole::Logo)
            .count()
            > 2
        || media
            .iter()
            .filter(|asset| asset.role == CatalogMediaRole::Screenshot)
            .count()
            > 8
    {
        return Err(PortcoveError::usage(
            "catalog media permits two headers, two key-art images, two game logos and eight screenshots",
        ));
    }
    let mut candidates = HashSet::new();
    if media
        .iter()
        .filter(|asset| asset.role == CatalogMediaRole::KeyArt)
        .count()
        > 2
    {
        return Err(PortcoveError::usage(
            "catalog media permits two key-art candidates",
        ));
    }
    for asset in media {
        if asset.role != CatalogMediaRole::Screenshot
            && !candidates.insert((asset.role, asset.subject.clone()))
        {
            return Err(PortcoveError::usage(
                "catalog media permits one candidate per subject and identity role",
            ));
        }
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
            || !(matches!(
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
            ) || (asset.license == "LicenseRef-IGDB-Terms"
                && matches!(
                    asset.role,
                    CatalogMediaRole::Logo | CatalogMediaRole::KeyArt
                )
                && asset.igdb.is_some()
                && asset.rights_url == "https://www.twitch.tv/p/en/legal/developer-agreement/"))
        {
            return Err(PortcoveError::usage(
                "catalog media needs bounded dimensions, descriptive credit and reviewed rights evidence",
            ));
        }
        fetch_url(&asset.url)?;
        validate_igdb_media(asset)?;
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

fn is_key_art_type_name(name: &str) -> bool {
    if !valid_text(name, 128) {
        return false;
    }
    let normalized: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        normalized.as_str(),
        "keyart" | "keyartwithlogo" | "keyartwithoutlogo"
    )
}

fn validate_igdb_media(asset: &CatalogMediaAsset) -> Result<()> {
    let Some(image) = &asset.igdb else {
        return if matches!(
            asset.role,
            CatalogMediaRole::Header | CatalogMediaRole::Screenshot
        ) {
            Ok(())
        } else {
            Err(PortcoveError::usage(
                "foreground game images require a reviewed IGDB mapping",
            ))
        };
    };
    let variant = match (asset.role, image.kind) {
        (CatalogMediaRole::Logo, IgdbGameImageKind::Logo) => "logo_med_2x",
        (CatalogMediaRole::KeyArt, IgdbGameImageKind::Artwork)
            if image.image_type.is_some()
                && image
                    .image_type_name
                    .as_deref()
                    .is_some_and(is_key_art_type_name) =>
        {
            "720p"
        }
        _ => {
            return Err(PortcoveError::usage(
                "IGDB image kind does not establish the requested media role",
            ));
        }
    };
    let (max_width, max_height) = if asset.role == CatalogMediaRole::Logo {
        (568, 320)
    } else {
        (1280, 720)
    };
    if image.game_id == 0
        || image.record_id == 0
        || image.image_type.is_some_and(|id| id == 0)
        || !valid_id(&image.game_slug)
        || image.image_id.is_empty()
        || image.image_id.len() > 128
        || !image
            .image_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || asset.width > max_width
        || asset.height > max_height
        || asset.url
            != format!(
                "https://images.igdb.com/igdb/image/upload/t_{variant}/{}.png",
                image.image_id
            )
        || asset.source_url != format!("https://www.igdb.com/games/{}", image.game_slug)
    {
        return Err(PortcoveError::usage(
            "foreground game images require an exact reviewed IGDB mapping and bounded fit image",
        ));
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
    let (width, height) = match asset.role {
        CatalogMediaRole::Logo => (568, 320),
        CatalogMediaRole::KeyArt => (960, 640),
        CatalogMediaRole::Header => (1280, 720),
        CatalogMediaRole::Screenshot => (960, 540),
    };
    let decoded = crate::artwork_image::decode_with_thumbnail_bounds(&original, width, height)?;
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
            edition_neutral: None,
            igdb: None,
        }
    }

    fn logo() -> CatalogMediaAsset {
        CatalogMediaAsset {
            id: "example-game-logo".into(),
            role: CatalogMediaRole::Logo,
            url: "https://images.igdb.com/igdb/image/upload/t_logo_med_2x/logo_fixture.png".into(),
            source_url: "https://www.igdb.com/games/example-game".into(),
            igdb: Some(IgdbGameImage {
                game_id: 1,
                record_id: 2,
                kind: IgdbGameImageKind::Logo,
                image_id: "logo_fixture".into(),
                game_slug: "example-game".into(),
                alpha_channel: Some(true),
                image_type: None,
                image_type_name: None,
            }),
            ..asset()
        }
    }

    #[test]
    fn key_art_is_not_inferred_from_generic_artwork() {
        let mut image = logo();
        image.role = CatalogMediaRole::KeyArt;
        image.url = image.url.replace("logo_med_2x", "720p");
        let metadata = image.igdb.as_mut().unwrap();
        metadata.kind = IgdbGameImageKind::Artwork;
        metadata.image_type = Some(3);
        metadata.image_type_name = Some("Concept art".into());
        assert!(validate_catalog_media("example", None, std::slice::from_ref(&image)).is_err());
        for name in ["Key art with logo", "Key art without logo"] {
            image.igdb.as_mut().unwrap().image_type_name = Some(name.into());
            assert!(validate_catalog_media("example", None, std::slice::from_ref(&image)).is_ok());
        }
        image.igdb.as_mut().unwrap().image_type_name = None;
        assert!(validate_catalog_media("example", None, &[image]).is_err());
    }

    #[test]
    fn key_art_candidates_are_bounded_across_distinct_valid_subjects() {
        let mut image = logo();
        image.role = CatalogMediaRole::KeyArt;
        image.url = image.url.replace("logo_med_2x", "720p");
        let metadata = image.igdb.as_mut().unwrap();
        metadata.kind = IgdbGameImageKind::Artwork;
        metadata.image_type = Some(7);
        metadata.image_type_name = Some("Key art".into());
        let game = OriginalGameIdentity {
            format_version: 1,
            id: "original-game".into(),
            evidence_urls: vec!["https://example.com".into()],
            source_editions: ["usa", "europe"]
                .into_iter()
                .map(|id| crate::SourceEdition {
                    id: id.into(),
                    title: id.into(),
                    system: None,
                    evidence_urls: vec!["https://example.com".into()],
                })
                .collect(),
        };
        let mut images = vec![image.clone()];
        for edition in &game.source_editions {
            let mut original = image.clone();
            original.id = format!("key-art-{}", edition.id);
            original.subject = CatalogMediaSubject::Original {
                game_id: game.id.clone(),
                source_edition_id: edition.id.clone(),
            };
            images.push(original);
        }
        assert!(validate_catalog_media("example", Some(&game), &images[..2]).is_ok());
        assert!(validate_catalog_media("example", Some(&game), &images).is_err());
    }

    #[test]
    fn legacy_media_omits_new_metadata_and_keeps_its_serialized_identity() {
        let value = serde_json::to_value(asset()).unwrap();
        assert!(value.get("igdb").is_none());
        let decoded: CatalogMediaAsset = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }

    #[test]
    fn logos_require_a_game_logo_mapping_and_bounded_fit_variant() {
        let image = logo();
        assert!(validate_catalog_media("example", None, std::slice::from_ref(&image)).is_ok());
        let mut invalid = image.clone();
        invalid.igdb = None;
        assert!(validate_catalog_media("example", None, &[invalid]).is_err());
        let mut invalid = image.clone();
        invalid.url = invalid.url.replace("logo_med_2x", "original");
        assert!(validate_catalog_media("example", None, &[invalid]).is_err());
        let mut invalid = image.clone();
        invalid.source_url = "https://www.igdb.com/game-engines/example-game".into();
        assert!(validate_catalog_media("example", None, &[invalid]).is_err());
        let mut invalid = image.clone();
        invalid.width = 569;
        assert!(validate_catalog_media("example", None, &[invalid]).is_err());
        let mut duplicate = image.clone();
        duplicate.id = "second-logo-same-subject".into();
        assert!(validate_catalog_media("example", None, &[image, duplicate]).is_err());
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
