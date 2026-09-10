use std::{
    fs,
    path::{Path, PathBuf},
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtworkState {
    pub choice: ArtworkChoice,
    pub selection: Option<LocalArtworkAsset>,
    pub availability: ArtworkAvailability,
    pub reason: Option<String>,
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
    pub fn artwork(&self, port_id: &str, slot: ArtworkSlot) -> Result<ArtworkState> {
        self.catalog().port(port_id)?;
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        let choice = crate::artwork_store::choice(&transaction, port_id, slot)?;
        let selection = choice
            .asset_sha256
            .as_deref()
            .map(|id| crate::artwork_store::asset(&transaction, id))
            .transpose()?;
        transaction.commit()?;
        let (availability, reason) = match &selection {
            None => (ArtworkAvailability::Fallback, None),
            Some(asset) => match original_bytes(self.library(), asset) {
                Ok(_) => (ArtworkAvailability::Available, None),
                Err(_) => (ArtworkAvailability::Unavailable, Some("The selected local image is missing, changed, or unavailable. Its choice has been retained.".into())),
            },
        };
        Ok(ArtworkState {
            choice,
            selection,
            availability,
            reason,
        })
    }

    pub fn import_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        source: &Path,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        self.catalog().port(port_id)?;
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
            crate::durability::write_bytes_atomically(&path, &bytes, false)?;
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
        // Choices publish only after validated originals. Disposable thumbnails
        // are generated on demand; a cache fault cannot prevent selection.
        transaction.commit()?;
        self.artwork(port_id, slot)
    }

    pub fn reset_artwork(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        expected_revision: u64,
    ) -> Result<ArtworkState> {
        self.catalog().port(port_id)?;
        let _guard = self.library().try_lock_artwork()?;
        let mut connection = self.library().connection()?;
        let transaction = connection.transaction()?;
        crate::artwork_store::require_revision(&transaction, port_id, slot, expected_revision)?;
        crate::artwork_store::write_choice(&transaction, port_id, slot, expected_revision, None)?;
        transaction.commit()?;
        self.artwork(port_id, slot)
    }

    pub fn artwork_thumbnail(
        &self,
        port_id: &str,
        slot: ArtworkSlot,
        expected_revision: u64,
    ) -> Result<ArtworkThumbnail> {
        self.catalog().port(port_id)?;
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

fn publish_thumbnail(
    library: &Library,
    connection: &rusqlite::Connection,
    id: &str,
    bytes: &[u8],
) -> Result<()> {
    let path = thumbnail_path(library, id)?;
    let files = cache_files(library)?;
    let mut total = files
        .iter()
        .filter(|(existing, _)| existing != &path)
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
    ensure_parent(&path)?;
    crate::durability::write_bytes_atomically(&path, bytes, true)?;
    crate::artwork_store::write_thumbnail(connection, id, bytes)
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
        crate::artwork_store::validate_hash(stem)?;
        let metadata = fs::symlink_metadata(&path)?;
        if path.extension().and_then(|extension| extension.to_str()) != Some("png")
            || !metadata.is_file()
            || metadata.file_type().is_symlink()
            || files.len() >= 4096
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
