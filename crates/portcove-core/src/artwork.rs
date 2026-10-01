use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Library, PortcoveError, PortcoveService, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtworkSlot {
    Cover,
    Detail,
}

impl ArtworkSlot {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Cover => "cover",
            Self::Detail => "detail",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtworkImageFormat {
    Png,
    Jpeg,
}

/// Local integrity and user selection do not establish copyright permission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LocalArtworkAsset {
    pub sha256: String,
    pub original_name: String,
    pub format: ArtworkImageFormat,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub imported_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkChoice {
    pub port_id: String,
    pub slot: ArtworkSlot,
    pub revision: u64,
    pub asset_sha256: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtworkMetadata {
    pub assets: Vec<LocalArtworkAsset>,
    pub choices: Vec<ArtworkChoice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtworkAvailability {
    Fallback,
    Available,
    Unavailable,
}

/// The source core resolves for one slot before a client attempts to transport
/// or render it. A client can still display the generated fallback if a
/// resolved image cannot be retrieved, decoded or presented safely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtworkResolvedSource {
    LocalImport {
        asset_sha256: String,
    },
    IgdbCover {
        artwork: crate::IgdbArtwork,
        cache_id: String,
    },
    GeneratedFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GeneratedArtworkFallback {
    pub identity: String,
    pub style_version: u32,
    pub initials: String,
    pub palette_index: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtworkState {
    pub choice: ArtworkChoice,
    pub selection: Option<LocalArtworkAsset>,
    pub availability: ArtworkAvailability,
    pub reason: Option<String>,
    pub resolved_source: ArtworkResolvedSource,
    pub generated_fallback: GeneratedArtworkFallback,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtworkThumbnail {
    pub asset_sha256: String,
    pub choice_revision: u64,
    pub png: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtworkCacheClear {
    pub removed_files: u64,
    pub removed_bytes: u64,
}

impl PortcoveService {
    fn artwork_port(&self, port_id: &str) -> Result<std::borrow::Cow<'_, crate::PortDefinition>> {
        match self.catalog().port(port_id) {
            Ok(port) => Ok(std::borrow::Cow::Borrowed(port)),
            Err(unknown) => {
                // An imported installation may retain an admitted definition that
                // the current catalog does not offer. Resolve presentation only;
                // do not add it to discovery or grant lifecycle authority.
                let Some(install) = self
                    .library()
                    .status(port_id, crate::ReleaseChannel::Stable)?
                    .active
                else {
                    return Err(unknown);
                };
                let retained = self.installed_catalog(&install)?;
                let Some(identity) = retained.definition_selection(port_id) else {
                    return Err(unknown);
                };
                if self
                    .library()
                    .retained_definition_admission_role(identity)?
                    .is_none()
                {
                    return Err(unknown);
                }
                Ok(std::borrow::Cow::Owned(retained.port(port_id)?.clone()))
            }
        }
    }

    pub fn artwork(&self, port_id: &str, slot: ArtworkSlot) -> Result<ArtworkState> {
        let port = self.artwork_port(port_id)?;
        self.artwork_for_port(&port, slot)
    }

    fn artwork_for_port(
        &self,
        port: &crate::PortDefinition,
        slot: ArtworkSlot,
    ) -> Result<ArtworkState> {
        let port_id = &port.id;
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        let choice = crate::artwork_store::choice(&transaction, port_id, slot)?;
        let selection = choice
            .asset_sha256
            .as_deref()
            .map(|id| crate::artwork_store::asset(&transaction, id))
            .transpose()?;
        transaction.commit()?;
        let generated_fallback = generated_fallback(port_id, &port.name, slot)?;
        let (availability, reason, resolved_source) = match &selection {
            None => match (slot, port.presentation.as_ref().and_then(|value| value.artwork.as_ref())) {
                (ArtworkSlot::Cover, Some(artwork)) => (
                    ArtworkAvailability::Available,
                    None,
                    ArtworkResolvedSource::IgdbCover {
                        artwork: artwork.clone(),
                        cache_id: igdb_cache_id(artwork),
                    },
                ),
                _ => (
                    ArtworkAvailability::Fallback,
                    None,
                    ArtworkResolvedSource::GeneratedFallback,
                ),
            },
            Some(asset) => match original_bytes(self.library(), asset) {
                Ok(_) => (
                    ArtworkAvailability::Available,
                    None,
                    ArtworkResolvedSource::LocalImport {
                        asset_sha256: asset.sha256.clone(),
                    },
                ),
                Err(_) => (
                    ArtworkAvailability::Unavailable,
                    Some("The selected local image is missing, changed, or unavailable. Its choice has been retained.".into()),
                    ArtworkResolvedSource::GeneratedFallback,
                ),
            },
        };
        Ok(ArtworkState {
            choice,
            selection,
            availability,
            reason,
            resolved_source,
            generated_fallback,
        })
    }

    pub fn import_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        source: &Path,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        let port = self.artwork_port(port_id)?;
        let _guard = self.library().try_lock_artwork()?;
        crate::path::unicode(source, "local artwork")?;
        crate::path::refuse_symlink_ancestors(source)?;
        let bytes =
            crate::path::read_bounded_regular(source, crate::artwork_image::MAX_ORIGINAL_BYTES)?;
        let decoded = crate::artwork_image::decode(&bytes)?;
        let original_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| PortcoveError::usage("artwork needs a Unicode filename"))?
            .to_owned();
        let proposed = LocalArtworkAsset {
            sha256: crate::signed_catalog::digest(&bytes),
            original_name,
            format: decoded.format,
            byte_size: bytes.len() as u64,
            width: decoded.width,
            height: decoded.height,
            imported_at: Library::now(),
        };
        crate::artwork_store::validate_asset(&proposed)?;
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        crate::artwork_store::require_revision(&transaction, port_id, slot, expected_revision)?;
        crate::artwork_store::check_capacity(&transaction, &proposed)?;
        // Reserve durable inventory before publishing bytes. Interruption leaves
        // a tracked unused asset that can be retried or explicitly removed.
        crate::artwork_store::write_asset(&transaction, &proposed)?;
        transaction.commit()?;
        let path = original_path(self.library(), &proposed.sha256)?;
        ensure_parent(&path)?;
        if path.exists() {
            let retained =
                crate::path::read_bounded_regular(&path, crate::artwork_image::MAX_ORIGINAL_BYTES)?;
            if retained != bytes {
                return Err(PortcoveError::verification(
                    "existing artwork content differs from its identity; it was retained",
                ));
            }
        } else {
            crate::artwork_ingestion::publish_original(
                self.library(),
                &proposed.sha256,
                &path,
                &bytes,
            )?;
        }
        let transaction = connection.transaction()?;
        crate::artwork_store::require_revision(&transaction, port_id, slot, expected_revision)?;
        crate::artwork_store::write_choice(
            &transaction,
            port_id,
            slot,
            expected_revision,
            Some(&proposed.sha256),
        )?;
        // Choices publish only after validated originals. The accepted decode
        // also produced the thumbnail, but its disposable cache cannot make a
        // committed selection appear to fail and invite an unsafe retry.
        transaction.commit()?;
        let _ = publish_thumbnail(
            self.library(),
            &connection,
            &proposed.sha256,
            &decoded.thumbnail,
        );
        self.artwork_for_port(&port, slot)
    }

    pub fn reset_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        let port = self.artwork_port(port_id)?;
        let _guard = self.library().try_lock_artwork()?;
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        crate::artwork_store::require_revision(&transaction, port_id, slot, expected_revision)?;
        crate::artwork_store::write_choice(&transaction, port_id, slot, expected_revision, None)?;
        transaction.commit()?;
        self.artwork_for_port(&port, slot)
    }

    pub fn artwork_thumbnail(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        expected_revision: u64,
    ) -> Result<ArtworkThumbnail> {
        let port = self.artwork_port(port_id)?;
        let mapped_cover = match slot {
            ArtworkSlot::Cover => port
                .presentation
                .as_ref()
                .and_then(|value| value.artwork.as_ref()),
            ArtworkSlot::Detail => None,
        };
        if let Some(artwork) = mapped_cover {
            let connection = self.library().connection()?;
            let choice = crate::artwork_store::require_revision(
                &connection,
                port_id,
                slot,
                expected_revision,
            )?;
            if choice.asset_sha256.is_none() {
                drop(connection);
                let thumbnail =
                    igdb_thumbnail(self.library(), artwork, expected_revision, |original| {
                        let _guard = self.library().try_lock_artwork()?;
                        let connection = self.library().connection()?;
                        let current = crate::artwork_store::require_revision(
                            &connection,
                            port_id,
                            slot,
                            expected_revision,
                        )?;
                        if current.asset_sha256.is_some() {
                            return Err(PortcoveError::conflict(
                                "the artwork choice changed during cover retrieval",
                            ));
                        }
                        publish_igdb_original(self.library(), artwork, original)
                    })?;
                let connection = self.library().connection()?;
                let current = crate::artwork_store::require_revision(
                    &connection,
                    port_id,
                    slot,
                    expected_revision,
                )?;
                if current.asset_sha256.is_some() {
                    return Err(PortcoveError::conflict(
                        "the artwork choice changed during cover retrieval",
                    ));
                }
                return Ok(thumbnail);
            }
        }
        let _guard = self.library().try_lock_artwork()?;
        let connection = self.library().connection()?;
        let choice =
            crate::artwork_store::require_revision(&connection, port_id, slot, expected_revision)?;
        let id = choice
            .asset_sha256
            .ok_or_else(|| PortcoveError::not_found("this artwork slot uses the fallback"))?;
        let asset = crate::artwork_store::asset(&connection, &id)?;
        let original = original_bytes(self.library(), &asset)?;
        let cache = thumbnail_path(self.library(), &id)?;
        if let Some((expected_hash, expected_size)) =
            crate::artwork_store::thumbnail(&connection, &id)?
            && let Ok(bytes) =
                crate::path::read_bounded_regular(&cache, crate::artwork_image::MAX_THUMBNAIL_BYTES)
            && bytes.len() as u64 == expected_size
            && crate::signed_catalog::digest(&bytes) == expected_hash
        {
            return Ok(ArtworkThumbnail {
                asset_sha256: id,
                choice_revision: expected_revision,
                png: bytes,
            });
        }
        let decoded = crate::artwork_image::decode(&original)?;
        publish_thumbnail(self.library(), &connection, &id, &decoded.thumbnail)?;
        Ok(ArtworkThumbnail {
            asset_sha256: id,
            choice_revision: expected_revision,
            png: decoded.thumbnail,
        })
    }

    pub fn clear_artwork_cache(&self) -> Result<ArtworkCacheClear> {
        let _guard = self.library().try_lock_artwork()?;
        let files = cache_files(self.library())?;
        let result = ArtworkCacheClear {
            removed_files: files.len() as u64,
            removed_bytes: files.iter().try_fold(0_u64, |total, (_, size)| {
                total
                    .checked_add(*size)
                    .ok_or_else(|| PortcoveError::verification("artwork cache size overflow"))
            })?,
        };
        for (path, _) in files {
            fs::remove_file(path)?;
        }
        self.library()
            .connection()?
            .execute("DELETE FROM artwork_thumbnails", [])?;
        Ok(result)
    }

    pub fn unused_local_artwork(&self) -> Result<Vec<LocalArtworkAsset>> {
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        let metadata = crate::artwork_store::snapshot(&transaction)?;
        transaction.commit()?;
        Ok(metadata
            .assets
            .into_iter()
            .filter(|asset| {
                !metadata
                    .choices
                    .iter()
                    .any(|choice| choice.asset_sha256.as_deref() == Some(asset.sha256.as_str()))
            })
            .collect())
    }

    pub fn remove_unused_local_artwork(&self, asset_sha256: &str) -> Result<()> {
        let _guard = self.library().try_lock_artwork()?;
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        let asset = crate::artwork_store::asset(&transaction, asset_sha256)?;
        let selected: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM artwork_choices WHERE asset_sha256=?1)",
            [asset_sha256],
            |row| row.get(0),
        )?;
        if selected {
            return Err(PortcoveError::conflict(
                "this local image is still selected by an artwork slot",
            ));
        }
        let original = original_path(self.library(), asset_sha256)?;
        if original.exists() {
            original_bytes(self.library(), &asset)?;
            fs::remove_file(&original)?;
            crate::durability::sync_publication(&self.library().root().join("artwork"))?;
        }
        crate::artwork_ingestion::remove_staged_original(self.library(), &asset)?;
        let thumbnail = thumbnail_path(self.library(), asset_sha256)?;
        if thumbnail.exists() {
            fs::remove_file(thumbnail)?;
        }
        transaction.execute(
            "DELETE FROM artwork_thumbnails WHERE asset_sha256=?1",
            [asset_sha256],
        )?;
        transaction.execute("DELETE FROM artwork_assets WHERE sha256=?1", [asset_sha256])?;
        transaction.commit()?;
        Ok(())
    }
}

fn generated_fallback(
    port_id: &str,
    port_name: &str,
    slot: ArtworkSlot,
) -> Result<GeneratedArtworkFallback> {
    const STYLE_VERSION: u32 = 1;
    let identity = crate::signed_catalog::digest(&serde_json::to_vec(&(
        "portcove-generated-artwork",
        STYLE_VERSION,
        port_id,
        port_name,
        slot.key(),
    ))?);
    let palette_index = u8::from_str_radix(&identity[..2], 16)
        .map_err(|_| PortcoveError::verification("generated artwork identity is invalid"))?
        % 6;
    Ok(GeneratedArtworkFallback {
        identity,
        style_version: STYLE_VERSION,
        initials: fallback_initials(port_name),
        palette_index,
    })
}

fn fallback_initials(name: &str) -> String {
    let words = name
        .split_whitespace()
        .filter_map(|word| word.chars().find(|character| character.is_alphanumeric()))
        .take(2)
        .collect::<Vec<_>>();
    let initials = if words.len() == 1 {
        name.chars()
            .filter(|character| character.is_alphanumeric())
            .take(2)
            .collect::<Vec<_>>()
    } else {
        words
    };
    let value = initials
        .into_iter()
        .filter_map(|character| character.to_uppercase().next())
        .collect::<String>();
    if value.is_empty() { "PC".into() } else { value }
}

fn publish_thumbnail(
    library: &Library,
    connection: &rusqlite::Connection,
    id: &str,
    bytes: &[u8],
) -> Result<()> {
    publish_thumbnail_file(library, id, bytes)?;
    crate::artwork_store::write_thumbnail(connection, id, bytes)
}

fn publish_thumbnail_file(library: &Library, id: &str, bytes: &[u8]) -> Result<()> {
    let path = thumbnail_path(library, id)?;
    publish_cache_file(
        library,
        &path,
        "pending-thumbnail",
        crate::artwork_image::MAX_THUMBNAIL_BYTES,
        bytes,
    )
}

fn publish_cache_file(
    library: &Library,
    path: &Path,
    pending_name: &str,
    maximum_bytes: u64,
    bytes: &[u8],
) -> Result<()> {
    if bytes.len() as u64 > maximum_bytes {
        return Err(PortcoveError::verification(
            "artwork cache entry exceeds its byte limit",
        ));
    }
    let files = cache_files(library)?;
    let mut total = files
        .iter()
        .filter(|(existing, _)| existing != path)
        .try_fold(0_u64, |total, (_, size)| {
            total
                .checked_add(*size)
                .ok_or_else(|| PortcoveError::verification("artwork cache size overflow"))
        })?;
    for (existing, size) in files {
        if total <= (64 * 1024 * 1024_u64).saturating_sub(bytes.len() as u64) {
            break;
        }
        if existing != path {
            fs::remove_file(existing)?;
            total -= size;
        }
    }
    ensure_parent(path)?;
    let pending = library.root().join("artwork-cache").join(pending_name);
    crate::path::refuse_symlink_ancestors(&pending)?;
    if pending.exists() {
        crate::path::read_bounded_regular(&pending, maximum_bytes)?;
        fs::remove_file(&pending)?;
    }
    crate::artwork_ingestion::write_staged_file(&pending, bytes)?;
    tempfile::TempPath::try_from_path(pending)?
        .persist(path)
        .map_err(|error| PortcoveError::from(error.error))?;
    crate::durability::sync_publication(&library.root().join("artwork-cache"))?;
    Ok(())
}

fn igdb_thumbnail(
    library: &Library,
    artwork: &crate::IgdbArtwork,
    revision: u64,
    publish: impl FnOnce(&[u8]) -> Result<()>,
) -> Result<ArtworkThumbnail> {
    let id = igdb_cache_id(artwork);
    let path = igdb_original_path(library, artwork)?;
    if let Ok(original) =
        crate::path::read_bounded_regular(&path, crate::artwork_image::MAX_ORIGINAL_BYTES)
        && let Ok(decoded) = decode_igdb_original(&original, artwork)
    {
        return Ok(ArtworkThumbnail {
            asset_sha256: id,
            choice_revision: revision,
            png: decoded.thumbnail,
        });
    }
    let url = format!(
        "https://images.igdb.com/igdb/image/upload/t_cover_big/{}.jpg",
        artwork.image_id
    );
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| PortcoveError::network(format!("IGDB image client failed: {error}")))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| PortcoveError::network(format!("IGDB image request failed: {error}")))?;
    if !response.status().is_success() {
        return Err(PortcoveError::network(format!(
            "IGDB cover unavailable (HTTP {}).",
            response.status()
        )));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| !value.starts_with("image/jpeg"))
    {
        return Err(PortcoveError::verification(
            "IGDB cover did not return JPEG content",
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > crate::artwork_image::MAX_ORIGINAL_BYTES)
    {
        return Err(PortcoveError::verification(
            "IGDB cover exceeds the encoded byte limit",
        ));
    }
    let mut original = Vec::new();
    response
        .take(crate::artwork_image::MAX_ORIGINAL_BYTES + 1)
        .read_to_end(&mut original)?;
    let decoded = decode_igdb_original(&original, artwork)?;
    publish(&original)?;
    Ok(ArtworkThumbnail {
        asset_sha256: id,
        choice_revision: revision,
        png: decoded.thumbnail,
    })
}

fn decode_igdb_original(
    original: &[u8],
    artwork: &crate::IgdbArtwork,
) -> Result<crate::artwork_image::DecodedArtwork> {
    if original.len() as u64 > crate::artwork_image::MAX_ORIGINAL_BYTES
        || crate::signed_catalog::digest(original) != artwork.image_sha256
    {
        return Err(PortcoveError::verification(
            "IGDB cover no longer matches its catalog identity",
        ));
    }
    let decoded = crate::artwork_image::decode(original)?;
    if decoded.format != ArtworkImageFormat::Jpeg {
        return Err(PortcoveError::verification(
            "IGDB cover is not a static JPEG",
        ));
    }
    Ok(decoded)
}

fn igdb_original_path(library: &Library, artwork: &crate::IgdbArtwork) -> Result<PathBuf> {
    crate::artwork_store::validate_hash(&artwork.image_sha256)?;
    let path = library
        .root()
        .join("artwork-cache")
        .join(format!("{}.jpg", artwork.image_sha256));
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(path)
}

fn publish_igdb_original(
    library: &Library,
    artwork: &crate::IgdbArtwork,
    original: &[u8],
) -> Result<()> {
    publish_cache_file(
        library,
        &igdb_original_path(library, artwork)?,
        "pending-igdb-original",
        crate::artwork_image::MAX_ORIGINAL_BYTES,
        original,
    )
}

fn igdb_cache_id(artwork: &crate::IgdbArtwork) -> String {
    crate::signed_catalog::digest(format!("igdb-cover-big:{}", artwork.image_sha256).as_bytes())
}

fn cache_files(library: &Library) -> Result<Vec<(PathBuf, u64)>> {
    let root = library.root().join("artwork-cache");
    crate::path::refuse_symlink_ancestors(&root)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or_else(|| PortcoveError::verification("unexpected artwork cache entry"))?;
        let name = path.file_name().and_then(|name| name.to_str());
        let pending_thumbnail = name == Some("pending-thumbnail");
        let pending_original = name == Some("pending-igdb-original");
        let pending = pending_thumbnail || pending_original;
        if !pending {
            crate::artwork_store::validate_hash(stem)?;
        }
        let metadata = fs::symlink_metadata(&path)?;
        let extension = path.extension().and_then(|extension| extension.to_str());
        let too_large = if pending_original || extension == Some("jpg") {
            metadata.len() > crate::artwork_image::MAX_ORIGINAL_BYTES
        } else if pending_thumbnail {
            metadata.len() > crate::artwork_image::MAX_THUMBNAIL_BYTES
        } else {
            false
        };
        if (!pending && !matches!(extension, Some("png" | "jpg")))
            || !metadata.is_file()
            || metadata.file_type().is_symlink()
            || too_large
            || files.len() >= 4097
        {
            return Err(PortcoveError::verification(
                "artwork cache contains an unexpected entry; it was retained",
            ));
        }
        files.push((path, metadata.len()));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

pub(crate) fn original_path(library: &Library, id: &str) -> Result<PathBuf> {
    crate::artwork_store::validate_hash(id)?;
    let path = library.root().join("artwork").join(id);
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(path)
}

fn thumbnail_path(library: &Library, id: &str) -> Result<PathBuf> {
    crate::artwork_store::validate_hash(id)?;
    let path = library
        .root()
        .join("artwork-cache")
        .join(format!("{id}.png"));
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(path)
}

pub(crate) fn original_bytes(library: &Library, asset: &LocalArtworkAsset) -> Result<Vec<u8>> {
    let bytes = crate::path::read_bounded_regular(
        &original_path(library, &asset.sha256)?,
        crate::artwork_image::MAX_ORIGINAL_BYTES,
    )?;
    if bytes.len() as u64 != asset.byte_size
        || crate::signed_catalog::digest(&bytes) != asset.sha256
    {
        return Err(PortcoveError::verification(
            "local artwork no longer matches its retained identity",
        ));
    }
    Ok(bytes)
}

fn ensure_parent(path: &Path) -> Result<()> {
    crate::path::refuse_symlink_ancestors(path)?;
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| PortcoveError::state("artwork path has no parent"))?,
    )?;
    crate::path::refuse_symlink_ancestors(path)
}
