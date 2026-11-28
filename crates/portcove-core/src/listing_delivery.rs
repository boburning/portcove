//! Descriptive directory delivery under the existing independent catalog policy role.
//! This target cannot create a managed definition, publisher grant or executable contract.
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tough::{Repository, Transport};

use super::{PolicyProvenance, installed_authority_floor, provisioning};
use crate::{
    ActivityOperation, ActivityTargetKind, Catalog, CatalogListingDocument,
    DefinitionRepositorySource, Library, OperationEvent, OperationResult, PortcoveError,
    PortcoveService, Result,
};

pub(crate) use portcove_listing_carrier::{
    COMPACT_CARRIER, COMPACT_TARGET, LEGACY_TARGET as TARGET, MAX_BYTES, MAX_COMPACT_DECODED_BYTES,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListingDeliveryDocument {
    pub listing_delivery_schema: u32,
    pub revision: u64,
    pub withdrawn_ids: Vec<String>,
    pub directory: CatalogListingDocument,
}

use portcove_listing_carrier::MAX_COMPACT_RECORD_BYTES;

/// Measured working memory one element adds through decode, parse and
/// projection, beyond about three times the decoded bytes (SIGNED-CATALOG.md
/// "Reader generations"): 3.93 KiB per listing, 68 bytes per withdrawal.
pub(crate) const LISTING_WORKING_BYTES: usize = 4_027;
pub(crate) const WITHDRAWAL_WORKING_BYTES: usize = 68;
/// One admission's element budget: the measured element share of a realistic
/// directory at the 32 MiB decoded bound (about 10,300 listings x 3.93 KiB).
/// The decoded bound alone admits 350,672 minimal listings, measured at 1.4
/// GiB; this keeps every element shape near the realistic directory's
/// working memory. Larger directories need continuation, not a larger count.
pub(crate) const ELEMENT_WORKING_BUDGET: usize = 40 * 1024 * 1024;

/// A list that charges each element against the element budget while it is
/// parsed, so an oversized list is refused before it is allocated.
fn charged<'de, D, T, const CHARGE: usize>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Entries<T, const CHARGE: usize>(std::marker::PhantomData<T>);

    impl<'de, T: Deserialize<'de>, const CHARGE: usize> serde::de::Visitor<'de> for Entries<T, CHARGE> {
        type Value = Vec<T>;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "listing directory entries within the element budget")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut seq: A,
        ) -> std::result::Result<Vec<T>, A::Error> {
            let mut entries = Vec::new();
            while let Some(value) = seq.next_element()? {
                if (entries.len() + 1) * CHARGE > ELEMENT_WORKING_BUDGET {
                    return Err(serde::de::Error::custom(
                        "compact listing directory exceeds its element budget",
                    ));
                }
                entries.push(value);
            }
            Ok(entries)
        }
    }

    deserializer.deserialize_seq(Entries::<T, CHARGE>(std::marker::PhantomData))
}

fn charged_withdrawals<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<String>, D::Error> {
    charged::<D, String, WITHDRAWAL_WORKING_BYTES>(deserializer)
}

fn charged_listings<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<CompactListing>, D::Error> {
    charged::<D, CompactListing, LISTING_WORKING_BYTES>(deserializer)
}

// The publisher still honors the released readers' `MAX_LISTING_ENTRIES`
// until they are no longer supported.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecodedCompactDirectory {
    listing_delivery_schema: u32,
    revision: u64,
    #[serde(deserialize_with = "charged_withdrawals")]
    withdrawn_ids: Vec<String>,
    directory: CompactListingRecords,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactListingRecords {
    format_version: u32,
    #[serde(deserialize_with = "charged_listings")]
    listings: Vec<CompactListing>,
}

struct CompactListing(crate::PortListing);

impl<'de> Deserialize<'de> for CompactListing {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        // Strict keys are checked one record at a time. Borrow the raw JSON
        // and bound its size before building a JSON value for the duplicate check.
        let raw = <&serde_json::value::RawValue>::deserialize(deserializer)?;
        if raw.get().len() > MAX_COMPACT_RECORD_BYTES {
            return Err(serde::de::Error::custom(
                "compact listing record exceeds its byte bound",
            ));
        }
        let value: crate::definition_entry::strict_json::UniqueValue =
            serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        serde_json::from_value(value.0)
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod projection_tests {
    use super::*;

    /// Deterministic scale scenario: the committed directory repeated `scale`
    /// times, each repetition with fresh identities. A validation scenario
    /// for measurement only; it is never a product limit.
    #[cfg(target_os = "linux")]
    fn scaled_compact_document(scale: usize) -> Vec<u8> {
        let mut directory: serde_json::Value =
            serde_json::from_str(include_str!("../catalog/listings.json")).unwrap();
        let rows = directory["listings"].as_array().unwrap().clone();
        let mut listings = Vec::with_capacity(rows.len() * scale);
        for copy in 0..scale {
            for row in &rows {
                let mut row = row.clone();
                if copy > 0 {
                    // Every reference to the listing's own identity (its id and
                    // media subjects) moves to the fresh identity together.
                    fn rename(value: &mut serde_json::Value, from: &str, to: &str) {
                        match value {
                            serde_json::Value::String(text) if text == from => *text = to.into(),
                            serde_json::Value::Array(items) => {
                                items.iter_mut().for_each(|item| rename(item, from, to))
                            }
                            serde_json::Value::Object(fields) => {
                                fields.values_mut().for_each(|item| rename(item, from, to))
                            }
                            _ => {}
                        }
                    }
                    let id = row["id"].as_str().unwrap().to_owned();
                    rename(&mut row, &id, &format!("{id}-scale-{copy}"));
                }
                listings.push(row);
            }
        }
        directory["listings"] = listings.into();
        serde_json::to_vec(&serde_json::json!({
            "listing_delivery_schema": 1,
            "revision": 1,
            "withdrawn_ids": [],
            "directory": directory,
        }))
        .unwrap()
    }

    /// Worst-case element shape at the released decoded bound: the smallest
    /// valid listing rows, or the shortest withdrawals, filling 32 MiB.
    #[cfg(target_os = "linux")]
    fn worst_case_compact_document(shape: &str) -> Vec<u8> {
        let budget = MAX_COMPACT_DECODED_BYTES - 1024;
        let (mut listings, mut withdrawn) = (Vec::new(), Vec::new());
        let mut used = 0;
        for index in 0.. {
            let element = match shape {
                "minimal-listings" => format!(
                    r#"{{"id":"l-{index}","name":"Listing","summary":"Description.","project_url":"https://example.org"}}"#
                ),
                "minimal-withdrawals" => format!(r#""w-{index}""#),
                _ => panic!("unknown PORTCOVE_LISTING_SHAPE"),
            };
            used += element.len() + 1;
            if used > budget {
                break;
            }
            if shape == "minimal-listings" {
                listings.push(element);
            } else {
                withdrawn.push(element);
            }
        }
        format!(
            r#"{{"listing_delivery_schema":1,"revision":1,"withdrawn_ids":[{}],"directory":{{"format_version":15,"listings":[{}]}}}}"#,
            withdrawn.join(","),
            listings.join(",")
        )
        .into_bytes()
    }

    #[cfg(target_os = "linux")]
    fn resident_kib(field: &str) -> u64 {
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix(field))
            .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
            .unwrap()
    }

    /// Measurement for the reader-limit decision (#1422). Generation and
    /// measurement run in separate processes so freed fixture memory is not
    /// reused: `PORTCOVE_LISTING_SCALE=N PORTCOVE_LISTING_CARRIER=FILE cargo
    /// nextest run -p portcove-core --lib --run-ignored only
    /// measure_compact_directory_admission` writes FILE when it is absent and
    /// measures decode, parse and projection of it when it exists.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "measurement; run explicitly, one phase per process"]
    fn measure_compact_directory_admission() {
        use std::io::Write as _;
        let path = std::path::PathBuf::from(std::env::var("PORTCOVE_LISTING_CARRIER").unwrap());
        if !path.exists() {
            let scale = std::env::var("PORTCOVE_LISTING_SCALE")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(1);
            let decoded = match std::env::var("PORTCOVE_LISTING_SHAPE").as_deref() {
                Ok(shape) => worst_case_compact_document(shape),
                Err(_) => scaled_compact_document(scale),
            };
            let mut gzip =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            gzip.write_all(&decoded).unwrap();
            let carrier = serde_json::to_vec(&serde_json::json!({
                "carrier": COMPACT_CARRIER,
                "decoded_bytes": decoded.len(),
                "decoded_sha256": hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&decoded)),
                "gzip_base64": base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    gzip.finish().unwrap()
                ),
            }))
            .unwrap();
            std::fs::write(&path, carrier).unwrap();
            let mut directory: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
            std::fs::write(
                path.with_extension("text"),
                serde_json::to_string_pretty(&directory["directory"].take()).unwrap(),
            )
            .unwrap();
            return;
        }
        if std::env::var("PORTCOVE_LISTING_MEASURE").as_deref() == Ok("text") {
            // Authored-text inspection: the `catalog inspect-listings` parse.
            let text = std::fs::read_to_string(path.with_extension("text")).unwrap();
            std::fs::write("/proc/self/clear_refs", "5").unwrap();
            let before = resident_kib("VmRSS:");
            let started = std::time::Instant::now();
            let document = CatalogListingDocument::from_json(&text).unwrap();
            eprintln!(
                "text listings={} text_bytes={} total_ms={} baseline_rss_kib={before} \
                 peak_increment_kib={}",
                document.listings.len(),
                text.len(),
                started.elapsed().as_millis(),
                resident_kib("VmHWM:").saturating_sub(before),
            );
            return;
        }
        let baseline_catalog = Catalog::embedded().unwrap();
        let carrier = std::fs::read(&path).unwrap();
        // Attribute only admission work to the peak (Linux >= 4.0).
        std::fs::write("/proc/self/clear_refs", "5").unwrap();
        let before = resident_kib("VmRSS:");
        let started = std::time::Instant::now();
        let (bytes, _) =
            portcove_listing_carrier::decode_within(&carrier, usize::MAX, usize::MAX).unwrap();
        let document = match ListingDeliveryDocument::parse_compact_within(&bytes, usize::MAX) {
            Ok(document) => document,
            Err(error) => {
                eprintln!(
                    "refused decoded_bytes={} parse_ms={} peak_increment_kib={}: {}",
                    bytes.len(),
                    started.elapsed().as_millis(),
                    resident_kib("VmHWM:").saturating_sub(before),
                    error.message
                );
                return;
            }
        };
        let parsed = started.elapsed();
        let projected = document.project(baseline_catalog).unwrap();
        let elapsed = started.elapsed();
        let peak = resident_kib("VmHWM:");
        eprintln!(
            "listings={} delivered={} withdrawn={} wire_bytes={} decoded_bytes={} parse_ms={} \
             total_ms={} baseline_rss_kib={before} peak_increment_kib={}",
            projected.listing_document().listings.len(),
            document.directory.listings.len(),
            document.withdrawn_ids.len(),
            carrier.len(),
            bytes.len(),
            parsed.as_millis(),
            elapsed.as_millis(),
            peak.saturating_sub(before),
        );
    }

    #[test]
    fn compact_parse_charges_an_element_budget_not_the_released_count() {
        let envelope = |withdrawn: &str, listings: &str| {
            format!(
                r#"{{"listing_delivery_schema":1,"revision":1,"withdrawn_ids":[{withdrawn}],"directory":{{"format_version":11,"listings":[{listings}]}}}}"#
            )
        };
        let oversize = format!(r#"{{"id":"{}"}}"#, "a".repeat(MAX_COMPACT_RECORD_BYTES));
        let oversized =
            ListingDeliveryDocument::parse_compact(envelope("", &oversize).as_bytes()).unwrap_err();
        assert!(oversized.message.contains("record exceeds its byte bound"));
        // The released readers' 10,000 count no longer applies; elements are
        // charged against the measured working-memory budget instead.
        let count = portcove_listing_carrier::MAX_LISTING_ENTRIES + 1;
        let listings = (0..count)
            .map(|index| {
                format!(
                    r#"{{"id":"listing-{index}","name":"Listing","summary":"Description","project_url":"https://example.org"}}"#
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let withdrawn = (0..count)
            .map(|index| format!(r#""withdrawn-{index}""#))
            .collect::<Vec<_>>()
            .join(",");
        let complete = envelope(&withdrawn, &listings);
        let document = ListingDeliveryDocument::parse_compact(complete.as_bytes()).unwrap();
        assert_eq!(document.directory.listings.len(), count);
        assert_eq!(document.withdrawn_ids.len(), count);
        assert!(
            ListingDeliveryDocument::parse_compact_within(complete.as_bytes(), complete.len() - 1)
                .unwrap_err()
                .message
                .contains("compact listing delivery exceeds its byte bound")
        );
        let row = |index: usize| {
            format!(
                r#"{{"id":"listing-{index}","name":"Listing","summary":"Description","project_url":"https://example.org"}}"#
            )
        };
        let over = ELEMENT_WORKING_BUDGET / LISTING_WORKING_BYTES + 1;
        let over_listings = (0..over).map(row).collect::<Vec<_>>().join(",");
        // Refused while parsing the compact carrier, before the list is built.
        assert!(
            ListingDeliveryDocument::parse_compact(envelope("", &over_listings).as_bytes())
                .unwrap_err()
                .message
                .contains("element budget")
        );
        // The legacy carrier applies the same charge after its parse.
        assert!(
            ListingDeliveryDocument::parse(envelope("", &over_listings).as_bytes())
                .unwrap_err()
                .message
                .contains("element budget")
        );
        // Withdrawals cost far less than listings, so many more fit.
        let withdrawals = (0..100_000)
            .map(|index| format!(r#""withdrawn-{index}""#))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(
            ListingDeliveryDocument::parse_compact(envelope(&withdrawals, "").as_bytes())
                .unwrap()
                .withdrawn_ids
                .len(),
            100_000
        );
        let duplicate = r#"{"id":"listing","id":"other","name":"Listing","summary":"Description","project_url":"https://example.org"}"#;
        assert!(
            ListingDeliveryDocument::parse_compact(envelope("", duplicate).as_bytes()).is_err()
        );
    }

    #[test]
    fn legacy_delivery_preserves_only_same_scope_implementation_descriptions() {
        let baseline = Catalog::embedded().unwrap();
        let original = baseline.listing("zelda64-recomp").unwrap();
        assert!(original.implementation.is_some());
        let legacy = baseline.listing_document().export_format(11).unwrap();
        let legacy = legacy
            .listings
            .iter()
            .find(|listing| listing.id == original.id)
            .unwrap();
        for case in [
            "legacy-same-scope",
            "current-format-omission",
            "changed-project",
            "changed-game",
            "changed-edition",
            "missing-identity",
            "new-id",
        ] {
            let mut delivered = legacy.clone();
            delivered.summary = "Updated delivered summary.".into();
            delivered.download_block_reason = Some("Preserve the delivered prerequisite.".into());
            match case {
                "changed-project" => delivered.project_url = "https://example.invalid/other".into(),
                "changed-game" => {
                    delivered.original_game.as_mut().unwrap().id = "other-game".into()
                }
                "changed-edition" => {
                    delivered.original_game.as_mut().unwrap().source_editions[0].id =
                        "other-edition".into();
                }
                "missing-identity" => delivered.original_game = None,
                "new-id" => delivered.id = "separate-implementation".into(),
                _ => {}
            }
            let id = delivered.id.clone();
            let document = ListingDeliveryDocument {
                listing_delivery_schema: 1,
                revision: 1,
                withdrawn_ids: vec![],
                directory: CatalogListingDocument {
                    format_version: if case == "current-format-omission" {
                        12
                    } else {
                        11
                    },
                    listings: vec![delivered],
                },
            };
            let document =
                ListingDeliveryDocument::parse(&serde_json::to_vec(&document).unwrap()).unwrap();
            let projected = document.project(baseline.clone()).unwrap();
            let listing = projected.listing(&id).unwrap();
            assert_eq!(
                listing.implementation,
                if case == "legacy-same-scope" {
                    original.implementation.clone()
                } else {
                    None
                },
                "{case}"
            );
            assert_eq!(listing.summary, "Updated delivered summary.", "{case}");
            assert_eq!(
                listing.download_block_reason.as_deref(),
                Some("Preserve the delivered prerequisite."),
                "{case}"
            );
            assert_eq!(
                serde_json::to_value(projected.authoritative_document()).unwrap(),
                serde_json::to_value(baseline.authoritative_document()).unwrap(),
                "{case}"
            );
        }
    }

    #[test]
    fn legacy_delivery_preserves_typed_igdb_scenes_only_for_an_unchanged_scope() {
        let baseline = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#).unwrap();
        let current = CatalogListingDocument::from_json(&serde_json::json!({
            "format_version": 13,
            "listings": [{
                "id":"fixture","name":"Fixture game","summary":"Fixture description.",
                "project_url":"https://example.com/project",
                "media":[{
                    "id":"typed-shot","role":"screenshot","subject":{"kind":"port","port_id":"fixture"},
                    "caption":"Test scene","url":"https://images.igdb.com/igdb/image/upload/t_720p/fixture.png",
                    "sha256":"a".repeat(64),"width":1280,"height":720,"attribution":"Fixture",
                    "source_url":"https://www.igdb.com/games/fixture","license":"LicenseRef-IGDB-Terms",
                    "rights_url":"https://www.twitch.tv/p/en/legal/developer-agreement/",
                    "igdb":{"game_id":11,"record_id":21,"kind":"screenshot","image_id":"fixture","game_slug":"fixture"}
                }]
            }]
        }).to_string()).unwrap();
        let baseline = baseline.with_listing_document(current.clone()).unwrap();
        for (format_version, same_scope, count) in [(11, true, 1), (11, false, 0), (13, true, 0)] {
            let mut directory = current.export_format(11).unwrap();
            directory.format_version = format_version;
            if !same_scope {
                directory.listings[0].project_url = "https://example.com/changed-project".into();
            }
            let delivery = ListingDeliveryDocument {
                listing_delivery_schema: 1,
                revision: 1,
                withdrawn_ids: vec![],
                directory,
            };
            let delivery =
                ListingDeliveryDocument::parse(&serde_json::to_vec(&delivery).unwrap()).unwrap();
            let projected = delivery.project(baseline.clone()).unwrap();
            assert_eq!(projected.listing("fixture").unwrap().media.len(), count);
        }
    }

    #[test]
    fn older_delivery_keeps_typed_restrictions_only_for_the_same_legacy_scope() {
        let baseline = Catalog::embedded().unwrap();
        let original = baseline
            .listings()
            .iter()
            .find(|listing| {
                listing.restrictions.len() == 1
                    && listing.original_game.is_some()
                    && baseline.port(&listing.id).is_err()
            })
            .unwrap()
            .clone();
        let legacy = baseline.listing_document().export_format(11).unwrap();
        let legacy = legacy
            .listings
            .iter()
            .find(|listing| listing.id == original.id)
            .unwrap();
        assert!(legacy.restrictions.is_empty());
        for case in ["same", "changed-reason", "cleared", "changed-project"] {
            let mut delivered = legacy.clone();
            match case {
                "changed-reason" => {
                    delivered.download_block_reason = Some("A delivered condition.".into())
                }
                "cleared" => delivered.download_block_reason = None,
                "changed-project" => delivered.project_url = "https://example.invalid/other".into(),
                _ => {}
            }
            let document = ListingDeliveryDocument {
                listing_delivery_schema: 1,
                revision: 1,
                withdrawn_ids: vec![],
                directory: CatalogListingDocument {
                    format_version: 11,
                    listings: vec![delivered.clone()],
                },
            };
            let document =
                ListingDeliveryDocument::parse(&serde_json::to_vec(&document).unwrap()).unwrap();
            let projected = document.project(baseline.clone()).unwrap();
            let listing = projected.listing(&original.id).unwrap();
            assert_eq!(
                listing.download_block_reason, delivered.download_block_reason,
                "{case}"
            );
            match case {
                "same" => assert_eq!(listing.restrictions, original.restrictions),
                "cleared" => assert!(listing.restrictions.is_empty()),
                _ => assert_eq!(
                    listing.restrictions,
                    crate::acquisition_restriction::normalize_legacy_listing(
                        delivered.download_block_reason.as_deref()
                    ),
                    "{case}"
                ),
            }
        }
    }

    #[test]
    fn restricted_delivery_promotes_a_legacy_directory_without_granting_managed_authority() {
        let document = ListingDeliveryDocument::parse(
            &serde_json::to_vec(&serde_json::json!({
                "listing_delivery_schema":1,"revision":1,"withdrawn_ids":[],
                "directory":{"format_version":2,"listings":[{
                    "id":"restricted-delivery","name":"Restricted delivery",
                    "summary":"A project with an exact acquisition prerequisite.",
                    "project_url":"https://example.invalid/project",
                    "download_block_reason":"Resolve the upstream component permission."
                }]}
            }))
            .unwrap(),
        )
        .unwrap();
        let legacy = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#).unwrap();
        assert_eq!(legacy.listing_document().format_version, 1);
        let projected = document.project(legacy).unwrap();
        assert_eq!(projected.listing_document().format_version, 2);
        assert_eq!(
            projected
                .listing("restricted-delivery")
                .unwrap()
                .download_block_reason
                .as_deref(),
            Some("Resolve the upstream component permission.")
        );
        assert!(projected.port("restricted-delivery").is_err());
    }
}

impl ListingDeliveryDocument {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_BYTES {
            return Err(PortcoveError::verification(
                "listing delivery exceeds its byte bound",
            ));
        }
        let value: crate::definition_entry::strict_json::UniqueValue =
            serde_json::from_slice(bytes)?;
        Self::validate_delivery(serde_json::from_value(value.0)?)
    }

    pub(crate) fn parse_compact(bytes: &[u8]) -> Result<Self> {
        Self::parse_compact_within(bytes, MAX_COMPACT_DECODED_BYTES)
    }

    fn parse_compact_within(bytes: &[u8], max_decoded: usize) -> Result<Self> {
        if bytes.len() > max_decoded {
            return Err(PortcoveError::verification(
                "compact listing delivery exceeds its byte bound",
            ));
        }
        let wire: DecodedCompactDirectory = serde_json::from_slice(bytes)?;
        Self::validate_delivery(Self {
            listing_delivery_schema: wire.listing_delivery_schema,
            revision: wire.revision,
            withdrawn_ids: wire.withdrawn_ids,
            directory: CatalogListingDocument {
                format_version: wire.directory.format_version,
                listings: wire
                    .directory
                    .listings
                    .into_iter()
                    .map(|row| row.0)
                    .collect(),
            },
        })
    }

    fn validate_delivery(document: Self) -> Result<Self> {
        if document.listing_delivery_schema != 1 {
            return Err(PortcoveError::unsupported(
                "unsupported listing delivery schema",
            ));
        }
        if document.revision == 0 || document.revision > 9_007_199_254_740_991 {
            return Err(PortcoveError::verification(
                "invalid listing delivery revision",
            ));
        }
        // Both carriers share one element budget across listings and withdrawals.
        let charge = document.directory.listings.len() * LISTING_WORKING_BYTES
            + document.withdrawn_ids.len() * WITHDRAWAL_WORKING_BYTES;
        if charge > ELEMENT_WORKING_BUDGET {
            return Err(PortcoveError::verification(
                "listing delivery exceeds its element budget",
            ));
        }
        document.directory.validate()?;
        let listing_ids: BTreeSet<_> = document
            .directory
            .listings
            .iter()
            .map(|listing| listing.id.as_str())
            .collect();
        let mut ids = BTreeSet::new();
        for id in &document.withdrawn_ids {
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                || !ids.insert(id)
                || listing_ids.contains(id.as_str())
            {
                return Err(PortcoveError::verification(
                    "invalid or conflicting listing withdrawal",
                ));
            }
        }
        Ok(document)
    }

    fn project(&self, catalog: Catalog) -> Result<Catalog> {
        let mut directory = catalog.listing_document().clone();
        let withdrawn: BTreeSet<_> = self.withdrawn_ids.iter().map(String::as_str).collect();
        let mut listings: BTreeMap<_, _> = std::mem::take(&mut directory.listings)
            .into_iter()
            // A withdrawal cannot hide a usable managed definition or mutate its retained state.
            .filter(|listing| {
                !withdrawn.contains(listing.id.as_str()) || catalog.port(&listing.id).is_ok()
            })
            .map(|listing| (listing.id.clone(), listing))
            .collect();
        for listing in &self.directory.listings {
            let mut replacement = listing.clone();
            if let Some(current) = listings.get(&listing.id) {
                let same_scope = replacement.project_url == current.project_url
                    && crate::catalog::listings::same_original_description(
                        replacement.original_game.as_ref(),
                        current.original_game.as_ref(),
                    );
                if self.directory.format_version
                    < crate::catalog::listings::VERIFIED_EDITION_LISTING_FORMAT
                    && same_scope
                    && let (Some(original), Some(previous)) = (
                        replacement.original_game.as_mut(),
                        current.original_game.as_ref(),
                    )
                {
                    crate::catalog::listings::inherit_verified_sources(original, previous);
                }
                if self.directory.format_version
                    < crate::catalog::listings::MOD_PORTAL_LISTING_FORMAT
                    && same_scope
                {
                    replacement.mod_portals.clone_from(&current.mod_portals);
                }
                // Older directories cannot express or withdraw format-12
                // explanations. Retain only the same project's exact game
                // scope; all fields that delivery understands remain its own.
                if self.directory.format_version < 12
                    && replacement.implementation.is_none()
                    && same_scope
                {
                    replacement.implementation = current.implementation.clone();
                }
                // An older delivery cannot express typed restrictions. When it
                // repeats the current legacy projection for the same project and
                // game, keep the typed form; otherwise its legacy value wins.
                if self.directory.format_version
                    < crate::acquisition_restriction::RESTRICTION_LISTING_FORMAT
                    && same_scope
                    && replacement.download_block_reason == current.download_block_reason
                {
                    replacement.restrictions = current.restrictions.clone();
                }
                if self.directory.format_version < crate::catalog_media::IGDB_SCENE_LISTING_FORMAT
                    && same_scope
                    && current
                        .media
                        .iter()
                        .any(crate::CatalogMediaAsset::is_typed_igdb_scene)
                {
                    let mut media = replacement.media.clone();
                    media.extend(
                        current
                            .media
                            .iter()
                            .filter(|asset| asset.is_typed_igdb_scene())
                            .cloned(),
                    );
                    if crate::catalog_media::validate_catalog_media(
                        &replacement.id,
                        replacement.original_game.as_ref(),
                        &media,
                    )
                    .is_ok()
                    {
                        replacement.media = media;
                    }
                }
            }
            listings.insert(listing.id.clone(), replacement);
        }
        directory.listings = listings.into_values().collect();
        if self.directory.format_version >= crate::catalog::listings::ASSIGNED_COVER_LISTING_FORMAT
        {
            directory.format_version = directory.format_version.max(self.directory.format_version);
        }
        catalog
            .with_projected_listing_document(directory)
            .map(|catalog| catalog.with_signed_cover_assignments(&self.directory))
    }
}

#[cfg(test)]
#[test]
fn verified_edition_bindings_follow_managed_scope_and_directory_version() {
    use crate::catalog::listings::{VERIFIED_EDITION_LISTING_FORMAT, has_verified_source_editions};

    let port_id = "zelda64-recomp";
    let catalog = Catalog::embedded().unwrap();
    let mut directory = catalog.listing_document().clone();
    directory.format_version = directory
        .format_version
        .max(VERIFIED_EDITION_LISTING_FORMAT);
    let row = directory
        .listings
        .iter_mut()
        .find(|row| row.id == port_id)
        .unwrap();
    let edition = &mut row.original_game.as_mut().unwrap().source_editions[0];
    edition.verified_sources = vec![
        crate::OriginalEditionSourceBinding {
            game_id: "majoras-mask".into(),
            variant_id: "ntsc-u-1-0".into(),
            representation_id: "canonical-rom".into(),
        },
        crate::OriginalEditionSourceBinding {
            game_id: "majoras-mask".into(),
            variant_id: "ntsc-u-1-0".into(),
            representation_id: "unknown".into(),
        },
    ];
    let catalog = catalog.with_listing_document(directory).unwrap();
    let current = catalog.listing(port_id).unwrap();
    assert_eq!(
        current.original_game.as_ref().unwrap().source_editions[0]
            .verified_sources
            .len(),
        1
    );

    let mut delivery = ListingDeliveryDocument {
        listing_delivery_schema: 1,
        revision: 1,
        withdrawn_ids: Vec::new(),
        directory: crate::CatalogListingDocument {
            format_version: catalog.listing_document().format_version,
            listings: vec![current.clone()],
        }
        .export_format(13)
        .unwrap(),
    };
    // A carrier does not change the field authority of its decoded directory.
    for parse in [
        ListingDeliveryDocument::parse,
        ListingDeliveryDocument::parse_compact,
    ] {
        delivery.directory.format_version = 13;
        let legacy = parse(&serde_json::to_vec(&delivery).unwrap()).unwrap();
        let projected = legacy.project(catalog.clone()).unwrap();
        assert!(has_verified_source_editions(
            projected.listing(port_id).unwrap()
        ));

        delivery.directory.format_version = VERIFIED_EDITION_LISTING_FORMAT;
        let replacement = parse(&serde_json::to_vec(&delivery).unwrap()).unwrap();
        let projected = replacement.project(catalog.clone()).unwrap();
        assert!(!has_verified_source_editions(
            projected.listing(port_id).unwrap()
        ));
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ListingDeliveryStatus {
    pub delivery_schema: u32,
    pub revision: Option<u64>,
    pub selected: bool,
    pub anchor_sha256: Option<String>,
    pub repository_root_sha256: Option<String>,
    pub target_sha256: Option<String>,
    /// Digest of the authenticated compact transport target, when applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport_target_sha256: Option<String>,
    pub expires_at: Option<String>,
    pub listing_count: usize,
    pub withdrawn_ids: Vec<String>,
    pub fallback_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_code: Option<crate::CatalogFallbackCode>,
}

impl Default for ListingDeliveryStatus {
    fn default() -> Self {
        Self {
            delivery_schema: 1,
            revision: None,
            selected: false,
            anchor_sha256: None,
            repository_root_sha256: None,
            target_sha256: None,
            transport_target_sha256: None,
            expires_at: None,
            listing_count: 0,
            withdrawn_ids: vec![],
            fallback_reason: None,
            fallback_code: None,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CompactListingProof {
    transport: PolicyProvenance,
    decoded_sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum ListingAdmissionProof {
    Compact(CompactListingProof),
    Legacy(PolicyProvenance),
}

impl ListingAdmissionProof {
    fn provenance(&self) -> &PolicyProvenance {
        match self {
            Self::Compact(proof) => &proof.transport,
            Self::Legacy(proof) => proof,
        }
    }

    fn decoded_sha256(&self) -> &str {
        match self {
            Self::Compact(proof) => &proof.decoded_sha256,
            Self::Legacy(proof) => &proof.target_sha256,
        }
    }

    fn transport_target_sha256(&self) -> Option<String> {
        match self {
            Self::Compact(proof) => Some(proof.transport.target_sha256.clone()),
            Self::Legacy(_) => None,
        }
    }
}

pub(crate) struct AuthenticatedListings {
    bytes: Vec<u8>,
    document: ListingDeliveryDocument,
    proof: ListingAdmissionProof,
}

impl AuthenticatedListings {
    fn stored(connection: &Connection) -> Result<Option<Self>> {
        let legacy = Self::stored_in(connection, false)?;
        let compact = Self::stored_in(connection, true)?;
        let (legacy, compact) = match (legacy, compact) {
            (Some(legacy), Some(compact)) => (legacy, compact),
            (Some(stored), None) | (None, Some(stored)) => return Ok(Some(stored)),
            (None, None) => return Ok(None),
        };
        let legacy_proof = legacy.proof.provenance();
        let compact_proof = compact.proof.provenance();
        if legacy_proof.anchor_sha256 != compact_proof.anchor_sha256
            || (legacy.document.revision == compact.document.revision
                && legacy.bytes != compact.bytes)
        {
            return Err(PortcoveError::verification(
                "stored listing carrier identity or equal-revision bytes differ",
            ));
        }
        // Same-byte representations may have been refreshed by different readers.
        // Keep the higher decoded revision, then the later authenticated timestamp.
        if (legacy.document.revision, legacy_proof.roles[1].version)
            > (compact.document.revision, compact_proof.roles[1].version)
        {
            Ok(Some(legacy))
        } else {
            Ok(Some(compact))
        }
    }

    fn stored_in(connection: &Connection, compact: bool) -> Result<Option<Self>> {
        if compact
            && !connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='compact_listing_delivery')",
                [],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Ok(None);
        }
        let (table, maximum) = if compact {
            ("compact_listing_delivery", MAX_COMPACT_DECODED_BYTES)
        } else {
            ("listing_delivery", MAX_BYTES)
        };
        let select = format!(
            "SELECT CASE WHEN length(CAST(document_json AS BLOB))<=?1 THEN document_json END,
                    CASE WHEN length(CAST(provenance_json AS BLOB))<=16384 THEN provenance_json END
             FROM {table} WHERE singleton=1"
        );
        let row: Option<(Option<String>, Option<String>)> = connection
            .query_row(&select, [maximum], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        row.map(|(document, provenance)| {
            let (Some(document), Some(provenance)) = (document, provenance) else {
                return Err(PortcoveError::state(
                    "stored listing data exceeds its bound",
                ));
            };
            let proof: ListingAdmissionProof = serde_json::from_str(&provenance)?;
            if matches!(proof, ListingAdmissionProof::Compact(_)) != compact {
                return Err(PortcoveError::state(
                    "stored listing carrier does not match its table",
                ));
            }
            proof.provenance().validate()?;
            if super::digest(document.as_bytes()) != proof.decoded_sha256() {
                return Err(PortcoveError::state(
                    "stored listing bytes differ from admission",
                ));
            }
            Ok(Self {
                document: if compact {
                    ListingDeliveryDocument::parse_compact(document.as_bytes())?
                } else {
                    ListingDeliveryDocument::parse(document.as_bytes())?
                },
                bytes: document.into_bytes(),
                proof,
            })
        })
        .transpose()
    }

    fn require_current(&self, connection: &Connection, now: i64) -> Result<()> {
        let provenance = self.proof.provenance();
        let floor = installed_authority_floor(connection, &provenance.anchor_sha256)?
            .ok_or_else(|| PortcoveError::state("listing authority lost its replay floor"))?;
        // Other policy targets may have advanced shared metadata since this target was admitted.
        floor.check_advance(provenance)?;
        let expiry = OffsetDateTime::parse(&provenance.expires_at, &Rfc3339)
            .map_err(|_| PortcoveError::state("invalid listing expiration"))?
            .unix_timestamp();
        if now >= expiry {
            return Err(PortcoveError::verification(
                "listing delivery metadata is expired",
            ));
        }
        Ok(())
    }

    fn status(&self) -> ListingDeliveryStatus {
        let provenance = self.proof.provenance();
        ListingDeliveryStatus {
            delivery_schema: 1,
            revision: Some(self.document.revision),
            selected: true,
            anchor_sha256: Some(provenance.anchor_sha256.clone()),
            repository_root_sha256: Some(provenance.root_sha256.clone()),
            target_sha256: Some(self.proof.decoded_sha256().to_owned()),
            transport_target_sha256: self.proof.transport_target_sha256(),
            expires_at: Some(provenance.expires_at.clone()),
            listing_count: self.document.directory.listings.len(),
            withdrawn_ids: self.document.withdrawn_ids.clone(),
            fallback_reason: None,
            fallback_code: None,
        }
    }
}

pub(crate) fn load(
    connection: &Connection,
    catalog: Catalog,
    now: i64,
) -> (Catalog, ListingDeliveryStatus) {
    let mut status = ListingDeliveryStatus::default();
    let result: Result<Option<Catalog>> = (|| {
        let Some(stored) = AuthenticatedListings::stored(connection)? else {
            return Ok(None);
        };
        status = stored.status();
        stored.require_current(connection, now)?;
        stored.document.project(catalog.clone()).map(Some)
    })();
    match result {
        Ok(Some(projected)) => (projected, status),
        Ok(None) => (catalog, status),
        Err(error) => {
            status.selected = false;
            status.fallback_code = Some(
                error
                    .catalog_fallback()
                    .unwrap_or(crate::CatalogFallbackCode::ListingDirectoryUnavailable),
            );
            status.fallback_reason = Some(error.message);
            (catalog, status)
        }
    }
}

impl Library {
    pub fn listing_delivery_status(&self) -> Result<ListingDeliveryStatus> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction()?;
        let now = Self::now();
        let (baseline, provenance) =
            crate::catalog_store::CatalogState::read(&transaction)?.resolve(now)?;
        let (catalog, _) =
            crate::catalog_store::resolve_before_listings(&transaction, baseline, provenance, now)?;
        let (_, status) = load(&transaction, catalog, now);
        transaction.commit()?;
        Ok(status)
    }

    fn apply_listings(&self, candidate: AuthenticatedListings) -> Result<ListingDeliveryStatus> {
        self.admit_listings(&candidate, true)
    }

    /// Every admission check of `apply_listings`, without writing. A scheduled
    /// refresh uses it so a candidate this client would refuse records nothing.
    pub(crate) fn check_listings(&self, candidate: &AuthenticatedListings) -> Result<()> {
        self.admit_listings(candidate, false).map(|_| ())
    }

    fn admit_listings(
        &self,
        candidate: &AuthenticatedListings,
        publish: bool,
    ) -> Result<ListingDeliveryStatus> {
        let provenance = candidate.proof.provenance();
        provenance.require_fresh()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let floor = installed_authority_floor(&transaction, &provenance.anchor_sha256)?;
        if let Some(floor) = &floor {
            provenance.check_advance(floor)?;
        }
        let previous = AuthenticatedListings::stored(&transaction)?;
        if let Some(previous) = &previous
            && (previous.proof.provenance().anchor_sha256 != provenance.anchor_sha256
                || candidate.document.revision < previous.document.revision
                || (candidate.document.revision == previous.document.revision
                    && candidate.bytes != previous.bytes))
        {
            return Err(PortcoveError::verification(
                "listing revision replay, equivocation or authority change",
            ));
        }
        let now = Self::now();
        let (baseline, baseline_provenance) =
            crate::catalog_store::CatalogState::read(&transaction)?.resolve(now)?;
        let (catalog, _) = crate::catalog_store::resolve_before_listings(
            &transaction,
            baseline,
            baseline_provenance,
            now,
        )?;
        let selected = candidate.document.project(catalog.clone())?;
        provenance.require_fresh()?;
        let proof = serde_json::to_string(&candidate.proof)?;
        let document = std::str::from_utf8(&candidate.bytes)
            .map_err(|_| PortcoveError::verification("listing target must be UTF-8"))?;
        if !publish {
            // Dropping the transaction rolls it back; nothing was written.
            return Ok(candidate.status());
        }
        let prior = match previous {
            Some(previous) if previous.require_current(&transaction, now).is_ok() => {
                previous.document.project(catalog).ok()
            }
            Some(_) => None,
            None => Some(catalog),
        };
        // A corrupt or full local preference projection must not block
        // independent catalog delivery. Preserve its original rows on error.
        transaction.execute_batch("SAVEPOINT retain_mod_website_choices")?;
        if crate::mod_portal_preferences::retain_generated_thunderstore_choices(
            &transaction,
            prior.as_ref(),
            &selected,
        )
        .is_err()
        {
            transaction.execute_batch("ROLLBACK TO retain_mod_website_choices")?;
        }
        transaction.execute_batch("RELEASE retain_mod_website_choices")?;
        let insert = if matches!(candidate.proof, ListingAdmissionProof::Compact(_)) {
            // This optional, descriptive store introduces no library schema
            // dependency. An older reader can still open and renew its separately
            // authenticated row. Both remain subject to the same replay floor.
            if document.len() > MAX_BYTES {
                let schema: Option<String> = transaction
                    .query_row(
                        "SELECT sql FROM sqlite_master WHERE type='table' AND name='compact_listing_delivery'",
                        [],
                        |row| row.get(0),
                    )
                    .optional()?;
                // The replacement below records this candidate and advances the
                // replay floor atomically. Failure restores the prior table.
                if schema.as_ref().is_some_and(|sql| {
                    sql.contains(&format!("length(CAST(document_json AS BLOB))<={MAX_BYTES}"))
                }) {
                    transaction.execute_batch("DROP TABLE compact_listing_delivery;")?;
                }
            }
            transaction.execute_batch(&format!(
                "CREATE TABLE IF NOT EXISTS compact_listing_delivery(
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    document_json TEXT NOT NULL CHECK(length(CAST(document_json AS BLOB))<={MAX_COMPACT_DECODED_BYTES}),
                    provenance_json TEXT NOT NULL CHECK(length(CAST(provenance_json AS BLOB))<=16384));"
            ))?;
            "INSERT INTO compact_listing_delivery(singleton,document_json,provenance_json) VALUES(1,?1,?2)
             ON CONFLICT(singleton) DO UPDATE SET document_json=excluded.document_json,provenance_json=excluded.provenance_json"
        } else {
            "INSERT INTO listing_delivery(singleton,document_json,provenance_json) VALUES(1,?1,?2)
             ON CONFLICT(singleton) DO UPDATE SET document_json=excluded.document_json,provenance_json=excluded.provenance_json"
        };
        transaction.execute(insert, params![document, proof])?;
        transaction.execute(
            "UPDATE definition_publisher_authority SET replay_floor_json=?1 WHERE anchor_sha256=?2",
            params![serde_json::to_string(provenance)?, provenance.anchor_sha256],
        )?;
        transaction.commit()?;
        Ok(candidate.status())
    }
}

impl PortcoveService {
    /// A new service consumes the durable directory; this instance keeps its original snapshot.
    pub async fn refresh_listings(
        &self,
        source: &DefinitionRepositorySource,
        emit: impl FnMut(OperationEvent),
    ) -> Result<ListingDeliveryStatus> {
        let root = provisioning::installed_compiled_root(self.library())?;
        let transport = super::super::DefinitionHttpsTransport::new(source)?;
        refresh(self, source, root, transport, emit).await
    }
}

pub(crate) async fn refresh<T: Transport + Send + Sync + 'static>(
    service: &PortcoveService,
    source: &DefinitionRepositorySource,
    root: &[u8],
    transport: T,
    mut emit: impl FnMut(OperationEvent),
) -> Result<ListingDeliveryStatus> {
    let (activity, operation) = service.begin_cancellable_activity(
        ActivityOperation::UpdateCatalog,
        ActivityTargetKind::Library,
        None,
    )?;
    emit(operation.started());
    let result = tokio::time::timeout(super::super::ACQUISITION_TIMEOUT, async {
        let repository = operation
            .interruptible(super::super::load_repository(
                root,
                source.metadata_base_url.clone(),
                source.targets_base_url.clone(),
                transport,
            ))
            .await?;
        let candidate = operation
            .interruptible(acquire_listings(&repository, root))
            .await?;
        operation.checkpoint()?;
        operation.begin_publication()?;
        service.library().apply_listings(candidate)
    })
    .await
    .unwrap_or_else(|_| {
        Err(PortcoveError::network(
            "listing refresh acquisition timed out",
        ))
    });
    let result = service.finish_activity(activity, result);
    emit(operation.finished(OperationResult::from_result(&result)));
    result
}

/// The scheduled refresh's acquisition: the same authenticated TUF path and
/// strict parser as `refresh`, followed by every admission check, with no
/// activity and no write. A candidate this client would refuse (outage, absent
/// or expired publication, bad signature, newer format, replay) records nothing.
pub(crate) async fn acquire_admissible(
    library: &Library,
    repository: &Repository,
    root: &[u8],
) -> Result<AuthenticatedListings> {
    let candidate = acquire_listings(repository, root).await?;
    library.check_listings(&candidate)?;
    Ok(candidate)
}

async fn acquire_listings(repository: &Repository, root: &[u8]) -> Result<AuthenticatedListings> {
    // A known compact descriptor must pass the same scoped delegation and raw
    // digest checks as every other policy target. The legacy carrier is a
    // compatibility path only when signed metadata does not name the compact one.
    let compact = repository
        .all_targets()
        .any(|(name, _)| name.raw() == COMPACT_TARGET);
    let target = if compact { COMPACT_TARGET } else { TARGET };
    let (bytes, provenance) =
        super::acquire_target_with_limit(repository, root, target, MAX_BYTES as u64).await?;
    let (bytes, proof) = if compact {
        let (decoded, decoded_sha256) = portcove_listing_carrier::decode(&bytes)
            .map_err(|error| PortcoveError::verification(error.to_string()))?;
        (
            decoded,
            ListingAdmissionProof::Compact(CompactListingProof {
                transport: provenance,
                decoded_sha256,
            }),
        )
    } else {
        (bytes, ListingAdmissionProof::Legacy(provenance))
    };
    let document = if compact {
        ListingDeliveryDocument::parse_compact(&bytes)?
    } else {
        ListingDeliveryDocument::parse(&bytes)?
    };
    Ok(AuthenticatedListings {
        bytes,
        document,
        proof,
    })
}

/// Publishes an already acquired and checked candidate through the ordinary
/// activity, cancellation and atomic admission owner.
pub(crate) fn publish_acquired(
    service: &PortcoveService,
    candidate: AuthenticatedListings,
    mut emit: impl FnMut(OperationEvent),
) -> Result<ListingDeliveryStatus> {
    let (activity, operation) = service.begin_cancellable_activity(
        ActivityOperation::UpdateCatalog,
        ActivityTargetKind::Library,
        None,
    )?;
    emit(operation.started());
    let result = (|| {
        operation.checkpoint()?;
        operation.begin_publication()?;
        service.library().apply_listings(candidate)
    })();
    let result = service.finish_activity(activity, result);
    emit(operation.finished(OperationResult::from_result(&result)));
    result
}

pub(crate) fn migrate(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    transaction.execute_batch(&format!(
        "CREATE TABLE listing_delivery(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        document_json TEXT NOT NULL CHECK(length(CAST(document_json AS BLOB))<={MAX_BYTES}),
        provenance_json TEXT NOT NULL CHECK(length(CAST(provenance_json AS BLOB))<=16384));"
    ))?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn refresh_fixture<T: Transport + Send + Sync + 'static>(
    service: &PortcoveService,
    source: &DefinitionRepositorySource,
    root: &[u8],
    transport: T,
    emit: impl FnMut(OperationEvent),
) -> Result<ListingDeliveryStatus> {
    provisioning::installed_fixture_root(service.library(), root)?;
    refresh(service, source, root, transport, emit).await
}
