use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::{
    ArtworkChoice, ArtworkMetadata, ArtworkSlot, Catalog, LocalArtworkAsset, PortcoveError, Result,
};

const MAX_ASSETS: usize = 4096;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

pub(crate) fn migrate(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch("CREATE TABLE artwork_assets (
        sha256 TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0)
    ); CREATE TABLE artwork_choices (
        port_id TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('cover','detail')),
        revision INTEGER NOT NULL CHECK(revision>0), asset_sha256 TEXT REFERENCES artwork_assets(sha256),
        PRIMARY KEY(port_id,slot)
    ); CREATE TABLE artwork_thumbnails (
        asset_sha256 TEXT PRIMARY KEY NOT NULL REFERENCES artwork_assets(sha256),
        format_version INTEGER NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0)
    );")?;
    Ok(())
}

pub(crate) fn validate_hash(id: &str) -> Result<()> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PortcoveError::verification(
            "invalid artwork content identity",
        ));
    }
    Ok(())
}

pub(crate) fn validate_asset(asset: &LocalArtworkAsset) -> Result<()> {
    validate_hash(&asset.sha256)?;
    if asset.original_name.is_empty()
        || asset.original_name.len() > 255
        || asset
            .original_name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
        || asset.byte_size == 0
        || asset.byte_size > crate::artwork_image::MAX_ORIGINAL_BYTES
        || asset.width == 0
        || asset.height == 0
        || asset.width > 8192
        || asset.height > 8192
        || u64::from(asset.width) * u64::from(asset.height) > crate::artwork_image::MAX_PIXELS
    {
        return Err(PortcoveError::verification(
            "invalid local artwork metadata",
        ));
    }
    Ok(())
}

pub(crate) fn asset(connection: &Connection, id: &str) -> Result<LocalArtworkAsset> {
    validate_hash(id)?;
    let payload: String = connection
        .query_row(
            "SELECT payload FROM artwork_assets WHERE sha256=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| PortcoveError::verification("artwork choice lost its retained asset"))?;
    let asset: LocalArtworkAsset = serde_json::from_str(&payload)?;
    validate_asset(&asset)?;
    if asset.sha256 != id {
        return Err(PortcoveError::verification(
            "artwork record identity differs from its key",
        ));
    }
    Ok(asset)
}

pub(crate) fn choice(
    connection: &Connection,
    port_id: &str,
    slot: ArtworkSlot,
) -> Result<ArtworkChoice> {
    let recorded = connection
        .query_row(
            "SELECT revision,asset_sha256 FROM artwork_choices WHERE port_id=?1 AND slot=?2",
            params![port_id, slot.key()],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let (revision, asset_sha256) = recorded.unwrap_or((0, None));
    if let Some(id) = &asset_sha256 {
        validate_hash(id)?;
    }
    Ok(ArtworkChoice {
        port_id: port_id.into(),
        slot,
        revision,
        asset_sha256,
    })
}

pub(crate) fn require_revision(
    connection: &Connection,
    port_id: &str,
    slot: ArtworkSlot,
    expected: u64,
) -> Result<ArtworkChoice> {
    let current = choice(connection, port_id, slot)?;
    if current.revision != expected {
        return Err(PortcoveError::conflict(
            "artwork choice changed; review the current selection before replacing it",
        )
        .detail("expected_revision", expected.to_string())
        .detail("current_revision", current.revision.to_string()));
    }
    Ok(current)
}

pub(crate) fn check_capacity(connection: &Connection, proposed: &LocalArtworkAsset) -> Result<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM artwork_assets WHERE sha256=?1)",
        [&proposed.sha256],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(());
    }
    let (count, bytes): (u64, u64) = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(byte_size),0) FROM artwork_assets",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if count >= MAX_ASSETS as u64
        || bytes
            .checked_add(proposed.byte_size)
            .is_none_or(|size| size > MAX_TOTAL_BYTES)
    {
        return Err(PortcoveError::conflict(
            "local artwork storage is full; remove unused local images before importing more",
        ));
    }
    Ok(())
}

pub(crate) fn write_asset(connection: &Connection, asset: &LocalArtworkAsset) -> Result<()> {
    validate_asset(asset)?;
    connection.execute("INSERT INTO artwork_assets(sha256,payload,byte_size) VALUES (?1,?2,?3) ON CONFLICT(sha256) DO NOTHING", params![asset.sha256, serde_json::to_string(asset)?, asset.byte_size])?;
    Ok(())
}

pub(crate) fn write_choice(
    connection: &Connection,
    port_id: &str,
    slot: ArtworkSlot,
    previous: u64,
    id: Option<&str>,
) -> Result<()> {
    let revision = previous
        .checked_add(1)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| PortcoveError::state("artwork revision is exhausted"))?;
    connection.execute("INSERT INTO artwork_choices(port_id,slot,revision,asset_sha256) VALUES (?1,?2,?3,?4)
        ON CONFLICT(port_id,slot) DO UPDATE SET revision=excluded.revision,asset_sha256=excluded.asset_sha256", params![port_id,slot.key(),revision,id])?;
    Ok(())
}

pub(crate) fn thumbnail(connection: &Connection, id: &str) -> Result<Option<(String, u64)>> {
    Ok(connection.query_row("SELECT sha256,byte_size FROM artwork_thumbnails WHERE asset_sha256=?1 AND format_version=1", [id], |row| Ok((row.get(0)?,row.get(1)?))).optional()?)
}

pub(crate) fn write_thumbnail(connection: &Connection, id: &str, bytes: &[u8]) -> Result<()> {
    connection.execute("INSERT INTO artwork_thumbnails(asset_sha256,format_version,sha256,byte_size) VALUES (?1,1,?2,?3)
        ON CONFLICT(asset_sha256) DO UPDATE SET format_version=1,sha256=excluded.sha256,byte_size=excluded.byte_size", params![id,crate::signed_catalog::digest(bytes),bytes.len() as u64])?;
    Ok(())
}

pub(crate) fn snapshot(connection: &Connection) -> Result<ArtworkMetadata> {
    let mut statement =
        connection.prepare("SELECT sha256 FROM artwork_assets ORDER BY sha256 LIMIT 4097")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if ids.len() > MAX_ASSETS {
        return Err(PortcoveError::verification(
            "artwork asset inventory exceeds its limit",
        ));
    }
    let assets = ids
        .iter()
        .map(|id| asset(connection, id))
        .collect::<Result<Vec<_>>>()?;
    let mut statement = connection.prepare("SELECT port_id,slot,revision,asset_sha256 FROM artwork_choices ORDER BY port_id,slot LIMIT 8193")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, u64>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    let choices = rows
        .map(|row| {
            let (port_id, slot, revision, asset_sha256) = row?;
            let slot = match slot.as_str() {
                "cover" => ArtworkSlot::Cover,
                "detail" => ArtworkSlot::Detail,
                _ => return Err(PortcoveError::verification("unknown artwork slot")),
            };
            Ok(ArtworkChoice {
                port_id,
                slot,
                revision,
                asset_sha256,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ArtworkMetadata { assets, choices })
}

pub(crate) fn validate_metadata(metadata: &ArtworkMetadata, catalog: &Catalog) -> Result<()> {
    if metadata.assets.len() > MAX_ASSETS || metadata.choices.len() > 8192 {
        return Err(PortcoveError::verification(
            "artwork metadata exceeds its record limit",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut bytes = 0_u64;
    for asset in &metadata.assets {
        validate_asset(asset)?;
        if !ids.insert(&asset.sha256) {
            return Err(PortcoveError::verification(
                "artwork metadata repeats an asset",
            ));
        }
        bytes = bytes
            .checked_add(asset.byte_size)
            .ok_or_else(|| PortcoveError::verification("artwork size overflow"))?;
    }
    if bytes > MAX_TOTAL_BYTES {
        return Err(PortcoveError::verification(
            "artwork metadata exceeds its byte limit",
        ));
    }
    let mut choices = BTreeSet::new();
    for choice in &metadata.choices {
        catalog.port(&choice.port_id)?;
        if choice.revision == 0
            || choice.revision > i64::MAX as u64
            || !choices.insert((&choice.port_id, choice.slot.key()))
            || choice
                .asset_sha256
                .as_ref()
                .is_some_and(|id| !ids.contains(id))
        {
            return Err(PortcoveError::verification(
                "artwork metadata has a repeated, unbound, or invalid choice",
            ));
        }
    }
    Ok(())
}

pub(crate) fn restore(connection: &Connection, metadata: &ArtworkMetadata) -> Result<()> {
    for asset in &metadata.assets {
        write_asset(connection, asset)?;
    }
    for choice in &metadata.choices {
        write_choice(
            connection,
            &choice.port_id,
            choice.slot,
            choice.revision - 1,
            choice.asset_sha256.as_deref(),
        )?;
    }
    Ok(())
}

pub(crate) fn validate_transfer_inventory(
    metadata: &crate::LibraryMetadata,
    content: &[crate::LibraryTreePlan],
) -> Result<()> {
    let Some(artwork) = &metadata.artwork else {
        return Ok(());
    };
    let tree = content
        .iter()
        .find(|tree| tree.kind == crate::LibraryContentKind::LocalArtwork)
        .ok_or_else(|| PortcoveError::verification("artwork payload root is missing"))?;
    let assets = artwork
        .assets
        .iter()
        .map(|asset| (asset.sha256.as_str(), asset))
        .collect::<std::collections::BTreeMap<_, _>>();
    if !tree.copy.directories.is_empty()
        || !tree.copy.skipped_entries.is_empty()
        || tree.copy.files.len() != assets.len()
        || tree.copy.files.iter().any(|file| {
            file.relative_path
                .to_str()
                .and_then(|name| assets.get(name))
                .is_none_or(|asset| file.sha256 != asset.sha256 || file.size != asset.byte_size)
        })
    {
        return Err(PortcoveError::verification(
            "artwork payload inventory differs from its metadata; unexpected or missing originals were retained",
        ));
    }
    Ok(())
}
