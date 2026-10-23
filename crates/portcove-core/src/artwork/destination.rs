use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{ArtworkChoice, ArtworkSlot, LocalArtworkAsset, original_bytes};
use crate::{LibraryIdentity, PortcoveError, PortcoveService, Result};

/// This optional handoff evolves independently of API envelopes and events.
pub const ARTWORK_HANDOFF_SCHEMA: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DestinationArtworkRole {
    PortraitCover,
    LandscapeCover,
    HeroBanner,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DestinationArtworkSource {
    LocalImport { asset: LocalArtworkAsset },
    CatalogDefault { artwork: crate::IgdbArtwork },
    GeneratedFallback,
    UnassignedRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DestinationArtworkUnavailableReason {
    RoleNotProvided,
    NoLocalOriginal,
    SelectedOriginalUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "availability", rename_all = "snake_case", deny_unknown_fields)]
pub enum DestinationArtworkContent {
    Available {
        asset: LocalArtworkAsset,
    },
    Unavailable {
        reason: DestinationArtworkUnavailableReason,
    },
}

/// An observation, never provider permission, destination ownership or write consent.
/// V1 exposes validated local portrait originals. Catalog defaults and unprovided
/// wide roles remain explicit; they are never synthesized from another role/cache.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DestinationArtworkHandoff {
    #[schemars(range(min = 1, max = 1))]
    pub handoff_schema: u32,
    pub library: LibraryIdentity,
    pub port_id: String,
    pub role: DestinationArtworkRole,
    pub choice: Option<ArtworkChoice>,
    pub source: DestinationArtworkSource,
    pub selected_asset_sha256: Option<String>,
    pub content: DestinationArtworkContent,
}

impl DestinationArtworkHandoff {
    pub fn validate(&self) -> Result<()> {
        let invalid = || PortcoveError::verification("invalid destination artwork handoff");
        if self.handoff_schema != ARTWORK_HANDOFF_SCHEMA
            || self.library.id.is_empty()
            || self.library.root.as_os_str().is_empty()
            || self.port_id.is_empty()
        {
            return Err(invalid());
        }
        if let Some(id) = &self.selected_asset_sha256 {
            crate::artwork_store::validate_hash(id)?;
        }
        if self.role != DestinationArtworkRole::PortraitCover {
            return if self.choice.is_none()
                && self.source == DestinationArtworkSource::UnassignedRole
                && self.selected_asset_sha256.is_none()
                && self.content
                    == (DestinationArtworkContent::Unavailable {
                        reason: DestinationArtworkUnavailableReason::RoleNotProvided,
                    })
            {
                Ok(())
            } else {
                Err(invalid())
            };
        }
        let choice = self.choice.as_ref().ok_or_else(invalid)?;
        if choice.port_id != self.port_id || choice.slot != ArtworkSlot::Cover {
            return Err(invalid());
        }
        match (&self.source, &self.content) {
            (
                DestinationArtworkSource::LocalImport { asset: selected },
                DestinationArtworkContent::Available { asset },
            ) => {
                crate::artwork_store::validate_asset(asset)?;
                if choice.asset_sha256.as_deref() != Some(&asset.sha256)
                    || self.selected_asset_sha256.as_deref() != Some(&asset.sha256)
                    || selected != asset
                {
                    return Err(invalid());
                }
            }
            (
                DestinationArtworkSource::LocalImport { asset },
                DestinationArtworkContent::Unavailable {
                    reason: DestinationArtworkUnavailableReason::SelectedOriginalUnavailable,
                },
            ) => {
                crate::artwork_store::validate_asset(asset)?;
                if choice.asset_sha256.as_deref() != Some(&asset.sha256)
                    || self.selected_asset_sha256.as_deref() != Some(&asset.sha256)
                {
                    return Err(invalid());
                }
            }
            (
                DestinationArtworkSource::CatalogDefault { artwork },
                DestinationArtworkContent::Unavailable {
                    reason: DestinationArtworkUnavailableReason::NoLocalOriginal,
                },
            ) if choice.asset_sha256.is_none()
                && self.selected_asset_sha256.as_deref() == Some(&artwork.image_sha256)
                && artwork.game_id > 0
                && artwork.cover_id > 0
                && !artwork.image_id.is_empty()
                && artwork
                    .image_id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                && !artwork.game_slug.is_empty()
                && artwork.game_slug.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                }) => {}
            (
                DestinationArtworkSource::GeneratedFallback,
                DestinationArtworkContent::Unavailable {
                    reason: DestinationArtworkUnavailableReason::NoLocalOriginal,
                },
            ) if choice.asset_sha256.is_none() && self.selected_asset_sha256.is_none() => {}
            _ => return Err(invalid()),
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for DestinationArtworkHandoff {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            handoff_schema: u32,
            library: LibraryIdentity,
            port_id: String,
            role: DestinationArtworkRole,
            choice: Option<ArtworkChoice>,
            source: DestinationArtworkSource,
            selected_asset_sha256: Option<String>,
            content: DestinationArtworkContent,
        }
        let wire = Wire::deserialize(deserializer)?;
        let value = Self {
            handoff_schema: wire.handoff_schema,
            library: wire.library,
            port_id: wire.port_id,
            role: wire.role,
            choice: wire.choice,
            source: wire.source,
            selected_asset_sha256: wire.selected_asset_sha256,
            content: wire.content,
        };
        value.validate().map_err(serde::de::Error::custom)?;
        Ok(value)
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DestinationArtworkBytes {
    pub handoff: DestinationArtworkHandoff,
    /// Exact bounded original bytes, with no resize, crop, URL or filesystem path.
    pub original: Vec<u8>,
}

impl DestinationArtworkBytes {
    pub fn validate(&self) -> Result<()> {
        self.handoff.validate()?;
        let DestinationArtworkContent::Available { asset } = &self.handoff.content else {
            return Err(PortcoveError::verification(
                "unavailable artwork cannot carry bytes",
            ));
        };
        if self.original.len() as u64 != asset.byte_size
            || crate::signed_catalog::digest(&self.original) != asset.sha256
        {
            return Err(PortcoveError::verification(
                "artwork handoff bytes differ from their identity",
            ));
        }
        validate_decoded(&self.original, asset)
    }
}

impl<'de> Deserialize<'de> for DestinationArtworkBytes {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            handoff: DestinationArtworkHandoff,
            original: Vec<u8>,
        }
        let wire = Wire::deserialize(deserializer)?;
        let value = Self {
            handoff: wire.handoff,
            original: wire.original,
        };
        value.validate().map_err(serde::de::Error::custom)?;
        Ok(value)
    }
}

fn validate_decoded(bytes: &[u8], asset: &LocalArtworkAsset) -> Result<()> {
    let decoded = crate::artwork_image::decode(bytes)?;
    if decoded.format != asset.format
        || decoded.width != asset.width
        || decoded.height != asset.height
    {
        return Err(PortcoveError::verification(
            "artwork handoff content differs from admitted metadata",
        ));
    }
    Ok(())
}

impl PortcoveService {
    pub fn destination_artwork(
        &self,
        port_id: &str,
        role: DestinationArtworkRole,
    ) -> Result<DestinationArtworkHandoff> {
        let _guard = self.library().try_lock_artwork()?;
        self.resolve_destination_artwork(port_id, role)
            .map(|(handoff, _)| handoff)
    }

    pub fn destination_artwork_bytes(
        &self,
        port_id: &str,
        role: DestinationArtworkRole,
        expected_library_id: &str,
        expected_revision: u64,
        expected_asset_sha256: &str,
    ) -> Result<DestinationArtworkBytes> {
        crate::artwork_store::validate_hash(expected_asset_sha256)?;
        let _guard = self.library().try_lock_artwork()?;
        let (handoff, original) = self.resolve_destination_artwork(port_id, role)?;
        if handoff.library.id != expected_library_id
            || handoff.choice.as_ref().map(|choice| choice.revision) != Some(expected_revision)
            || handoff.selected_asset_sha256.as_deref() != Some(expected_asset_sha256)
        {
            return Err(PortcoveError::conflict(
                "artwork handoff changed; read and review it again",
            ));
        }
        let original = original.ok_or_else(|| {
            PortcoveError::not_found("this role has no accepted durable local original")
        })?;
        Ok(DestinationArtworkBytes { handoff, original })
    }

    fn resolve_destination_artwork(
        &self,
        port_id: &str,
        role: DestinationArtworkRole,
    ) -> Result<(DestinationArtworkHandoff, Option<Vec<u8>>)> {
        // Use the same current/validated-retained listing boundary as existing slots.
        let port = self.artwork_port(port_id)?;
        let mut handoff = DestinationArtworkHandoff {
            handoff_schema: ARTWORK_HANDOFF_SCHEMA,
            library: self.library().identity_record()?,
            port_id: port_id.into(),
            role,
            choice: None,
            source: DestinationArtworkSource::UnassignedRole,
            selected_asset_sha256: None,
            content: DestinationArtworkContent::Unavailable {
                reason: DestinationArtworkUnavailableReason::RoleNotProvided,
            },
        };
        let mut original = None;
        if role == DestinationArtworkRole::PortraitCover {
            let connection = self.library().connection()?;
            let choice = crate::artwork_store::choice(&connection, port_id, ArtworkSlot::Cover)?;
            if let Some(id) = &choice.asset_sha256 {
                let asset = crate::artwork_store::asset(&connection, id)?;
                handoff.source = DestinationArtworkSource::LocalImport {
                    asset: asset.clone(),
                };
                handoff.selected_asset_sha256 = Some(id.clone());
                match original_bytes(self.library(), &asset).and_then(|bytes| {
                    validate_decoded(&bytes, &asset)?;
                    Ok(bytes)
                }) {
                    Ok(bytes) => {
                        original = Some(bytes);
                        handoff.content = DestinationArtworkContent::Available { asset };
                    }
                    Err(_) => {
                        handoff.content = DestinationArtworkContent::Unavailable {
                            reason:
                                DestinationArtworkUnavailableReason::SelectedOriginalUnavailable,
                        }
                    }
                }
            } else {
                handoff.source = DestinationArtworkSource::GeneratedFallback;
                if let Some(artwork) = port.artwork.as_ref() {
                    handoff.source = DestinationArtworkSource::CatalogDefault {
                        artwork: artwork.clone(),
                    };
                    handoff.selected_asset_sha256 = Some(artwork.image_sha256.clone());
                }
                handoff.content = DestinationArtworkContent::Unavailable {
                    reason: DestinationArtworkUnavailableReason::NoLocalOriginal,
                };
            }
            handoff.choice = Some(choice);
        }
        handoff.validate()?;
        Ok((handoff, original))
    }
}
