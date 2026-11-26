use super::{Files, Result, TufRepositoryError, invalid, sha};
use portcove_listing_carrier::{COMPACT_TARGET, COVER_CHECKPOINT_TARGET};
use serde::Deserialize;
use serde_json::Value;
use tough::TargetName;
use tough::schema::{Signed, Targets};

pub(super) const CUSTOM_KEY: &str = "portcove_cover_approvals_v1";
pub(super) const COVER_APPROVALS_MAX: usize = 256 * 1024;

pub(super) fn from_policy(bytes: &[u8]) -> Result<Option<Value>> {
    let policy: Signed<Targets> = serde_json::from_slice(bytes)?;
    let target = TargetName::new(COMPACT_TARGET)?;
    let value = policy
        .signed
        .targets
        .get(&target)
        .and_then(|target| target.custom.get(CUSTOM_KEY));
    if let Some(journal) = value {
        cover_approval_packets(journal)?;
    }
    Ok(value.cloned())
}

pub(super) fn select(
    previous: Option<Value>,
    proposed: Option<&Value>,
    prior: &Files,
    next: &Files,
) -> Result<Option<Value>> {
    let selected = proposed.or(previous.as_ref());
    if let Some(journal) = selected {
        let Some(prior_compact) = prior.get(COMPACT_TARGET) else {
            return invalid("catalog cover approvals require an active compact predecessor");
        };
        let Some(prior_cover) = prior.get(COVER_CHECKPOINT_TARGET) else {
            return invalid("catalog cover approvals require an active cover checkpoint");
        };
        let Some(compact) = next.get(COMPACT_TARGET) else {
            return invalid("catalog cover approvals require a compact successor");
        };
        let Some(cover) = next.get(COVER_CHECKPOINT_TARGET) else {
            return invalid("catalog cover approvals cannot lose the cover checkpoint");
        };
        if proposed.is_some() {
            check_cover_approval_successor(
                previous.as_ref(),
                journal,
                prior_compact,
                Some(prior_cover),
                compact,
            )?;
        }
        check_projection(journal, compact, cover)?;
    }
    Ok(proposed.cloned().or(previous))
}

fn check_projection(journal: &Value, compact: &[u8], cover: &[u8]) -> Result<()> {
    cover_approval_packets(journal)?;
    let (decoded, _) = portcove_listing_carrier::decode(compact)
        .map_err(|error| TufRepositoryError::Invalid(error.to_string()))?;
    let directory: Value = serde_json::from_slice(&decoded)?;
    let checkpoint: Value = serde_json::from_slice(cover)?;
    let listings = directory["directory"]["listings"]
        .as_array()
        .ok_or_else(|| {
            TufRepositoryError::Invalid("catalog approved cover directory differs".into())
        })?;
    for approval in journal["approvals"].as_array().unwrap() {
        let Some(listing) = listings
            .iter()
            .find(|listing| listing["id"] == approval["id"])
        else {
            continue;
        };
        if listing["collection_covers"].is_array()
            || approval["scope"] != cover_approval_scope(listing, &approval["authored"])?
        {
            continue;
        }
        let candidate = &approval["candidate"];
        if !matches_checkpoint_cover(listing, candidate, &checkpoint)? {
            return invalid("catalog retained cover approval differs from the signed projection");
        }
    }
    Ok(())
}

fn matches_checkpoint_cover(listing: &Value, expected: &Value, checkpoint: &Value) -> Result<bool> {
    let scope = cover_approval_scope(listing, expected)?;
    let gone = checkpoint["entries"].as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["id"] == listing["id"]
                && entry["scope"] == scope
                && entry["image_id"] == expected["image_id"]
                && entry["prior_sha256"] == expected["image_sha256"]
                && entry["state"] == "gone"
        })
    });
    Ok(if gone {
        listing.get("artwork").is_none()
    } else {
        listing["artwork"] == *expected
    })
}

fn cover_hash(raw: &serde_json::Value, length: usize) -> bool {
    raw.as_str().is_some_and(|value| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CoverApprovalMapping {
    cover_id: u64,
    game_id: u64,
    game_slug: String,
    image_id: String,
    image_sha256: String,
    match_kind: String,
}

impl CoverApprovalMapping {
    fn parse(raw: &serde_json::Value) -> Option<Self> {
        let mapping: Self = serde_json::from_value(raw.clone()).ok()?;
        let id = |value| (1..=9_007_199_254_740_991).contains(&value);
        let lowercase_alphanumeric = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        (id(mapping.cover_id)
            && id(mapping.game_id)
            && mapping.match_kind == "underlying-game"
            && !mapping.game_slug.is_empty()
            && mapping.game_slug.len() <= 255
            && mapping
                .game_slug
                .bytes()
                .all(|byte| lowercase_alphanumeric(byte) || byte == b'-')
            && !mapping.image_id.is_empty()
            && mapping.image_id.len() <= 128
            && mapping.image_id.bytes().all(lowercase_alphanumeric)
            && cover_hash(&raw["image_sha256"], 64))
        .then_some(mapping)
    }

    fn replaced_by(&self, next: &Self) -> bool {
        self.game_id == next.game_id
            && self.game_slug == next.game_slug
            && self.cover_id != next.cover_id
            && self.image_id != next.image_id
            && self.image_sha256 != next.image_sha256
    }
}

fn approved_cover_mappings(row: &serde_json::Value) -> bool {
    let [Some(authored), Some(prior), Some(candidate)] =
        ["authored", "prior", "candidate"].map(|name| CoverApprovalMapping::parse(&row[name]))
    else {
        return false;
    };
    authored.replaced_by(&candidate) && prior.replaced_by(&candidate)
}

pub(super) fn cover_approval_packets(journal: &serde_json::Value) -> Result<&[serde_json::Value]> {
    let invalid_value =
        || TufRepositoryError::Invalid("catalog cover approval journal differs".into());
    let packets = journal["consumed_packets"]
        .as_array()
        .ok_or_else(invalid_value)?;
    let rows = journal["approvals"].as_array().ok_or_else(invalid_value)?;
    let mut ids = std::collections::BTreeSet::new();
    if journal["format_version"] != 1
        || journal.as_object().map(serde_json::Map::len) != Some(3)
        || packets.is_empty()
        || packets.len() > 256
        || rows.is_empty()
        || rows.len() > 256
        || serde_json::to_vec(journal)?.len() > COVER_APPROVALS_MAX
        || packets.iter().any(|packet| !cover_hash(packet, 64))
        || (0..packets.len()).any(|index| packets[index + 1..].contains(&packets[index]))
        || rows.iter().any(|row| {
            row.as_object().map(serde_json::Map::len) != Some(10)
                || !row["id"].as_str().is_some_and(|id| {
                    !id.is_empty()
                        && id.len() <= 128
                        && id.split('-').all(|part| {
                            !part.is_empty()
                                && part
                                    .bytes()
                                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                        })
                        && ids.insert(id)
                })
                || !packets.contains(&row["packet"])
                || !cover_hash(&row["scope"], 64)
                || !cover_hash(&row["source"], 40)
                || row["role"] != "cover"
                || !approved_cover_mappings(row)
                || !row["run"].as_str().is_some_and(|run| {
                    !run.is_empty()
                        && run.len() <= 16
                        && run.as_bytes()[0] != b'0'
                        && run.bytes().all(|byte| byte.is_ascii_digit())
                })
                || !row["bytes"]
                    .as_u64()
                    .is_some_and(|bytes| (1..=16 * 1024 * 1024).contains(&bytes))
        })
    {
        return Err(invalid_value());
    }
    Ok(packets)
}

// Matches coverDeclarationScope in scripts/listing-artwork-checkpoint.mts.
// Both inputs are the actual assembled compatible listing shape. Explicitly
// sort nested objects before hashing, including when serde_json preserves order.
fn cover_approval_scope(
    listing: &serde_json::Value,
    artwork: &serde_json::Value,
) -> Result<String> {
    let mut scope = serde_json::json!([
        listing["id"],
        listing["project_url"],
        listing["original_game_title"],
        listing["original_game"],
        if listing["collection_covers"].is_array() {
            "collection"
        } else {
            "single"
        },
        artwork,
    ]);
    scope.sort_all_objects();
    Ok(sha(&serde_json::to_vec(&scope)?))
}

fn check_cover_approval_successor(
    prior: Option<&serde_json::Value>,
    next: &serde_json::Value,
    prior_compact: &[u8],
    prior_cover: Option<&[u8]>,
    compact: &[u8],
) -> Result<()> {
    let new_packets = cover_approval_packets(next)?;
    let old_packets = prior
        .map(cover_approval_packets)
        .transpose()?
        .unwrap_or_default();
    if !new_packets.starts_with(old_packets) || new_packets.len() != old_packets.len() + 1 {
        return invalid("catalog cover approval does not advance the authenticated journal");
    }
    let final_packet = &new_packets[new_packets.len() - 1];
    let previous = prior
        .and_then(|prior| prior["approvals"].as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let approved = next["approvals"].as_array().unwrap();
    if previous.iter().any(|old| {
        !approved
            .iter()
            .any(|row| row["id"] == old["id"] && (row == old || &row["packet"] == final_packet))
    }) || approved
        .iter()
        .any(|row| &row["packet"] != final_packet && !previous.contains(row))
    {
        return invalid("catalog cover approval altered an unrelated journal row");
    }
    let decode = |bytes| {
        portcove_listing_carrier::decode(bytes)
            .map_err(|error| TufRepositoryError::Invalid(error.to_string()))
    };
    let (decoded_prior, _) = decode(prior_compact)?;
    let prior_directory: serde_json::Value = serde_json::from_slice(&decoded_prior)?;
    let prior_listings = prior_directory["directory"]["listings"]
        .as_array()
        .ok_or_else(|| {
            TufRepositoryError::Invalid("catalog approved cover prior listing differs".into())
        })?;
    let prior_checkpoint = prior_cover
        .map(serde_json::from_slice::<serde_json::Value>)
        .transpose()?;
    let (decoded, _) = decode(compact)?;
    let directory: serde_json::Value = serde_json::from_slice(&decoded)?;
    let listings = directory["directory"]["listings"]
        .as_array()
        .ok_or_else(|| {
            TufRepositoryError::Invalid("catalog approved cover directory differs".into())
        })?;
    let changed = approved
        .iter()
        .filter(|row| &row["packet"] == final_packet)
        .collect::<Vec<_>>();
    if changed.is_empty() {
        return invalid("catalog cover approval packet has no signed cover changes");
    }
    for row in changed {
        let subject = |listing: &&serde_json::Value| listing["id"] == row["id"];
        let Some(held) = prior_listings.iter().find(subject) else {
            return invalid("catalog cover approval subject missing from signed compact prior");
        };
        let Some(proposed) = listings.iter().find(subject) else {
            return invalid("catalog cover approval subject missing from signed compact successor");
        };
        if held["collection_covers"].is_array()
            || proposed["collection_covers"].is_array()
            || row["scope"] != cover_approval_scope(held, &row["authored"])?
            || row["scope"] != cover_approval_scope(proposed, &row["authored"])?
            || proposed["artwork"] != row["candidate"]
        {
            return invalid("catalog approved cover differs from the exact signed subject scope");
        }
        let mut expected = &row["authored"];
        if let Some(former) = previous.iter().find(subject)
            && former["scope"] == cover_approval_scope(held, &former["authored"])?
        {
            if row["authored"] != former["authored"] || row["scope"] != former["scope"] {
                return invalid("catalog cover approval changed an active authored anchor");
            }
            expected = &former["candidate"];
        }
        if &row["prior"] != expected
            || !matches_checkpoint_cover(
                held,
                expected,
                prior_checkpoint.as_ref().unwrap_or(&Value::Null),
            )?
        {
            return invalid("catalog cover approval does not bind the effective preimage");
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn approved_cover_successor_binds_packet_history_and_exact_compact_artwork() {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        use flate2::write::GzEncoder;
        use std::io::Write as _;
        let mapping = |id, image: &str, digest: &str| {
            json!({
                "game_id": 1, "game_slug": "original-game", "match_kind": "underlying-game",
                "cover_id": id, "image_id": image, "image_sha256": digest.repeat(64),
            })
        };
        let a = mapping(1, "covera", "b");
        let scope = cover_approval_scope(&json!({"id":"example"}), &a).unwrap();
        let fixture = |first: Option<&str>,
                       last: &str,
                       prior: &serde_json::Value,
                       candidate: &serde_json::Value| {
            let mut packets: Vec<_> = first.into_iter().map(str::to_owned).collect();
            packets.push(last.into());
            json!({
                "format_version": 1,
                "consumed_packets": packets,
                "approvals": [{
                    "id": "example",
                    "scope": scope,
                    "authored": a,
                    "prior": prior,
                    "role": "cover",
                    "candidate": candidate,
                    "bytes": 25,
                    "packet": last,
                    "source": "c".repeat(40),
                    "run": "1"
                }]
            })
        };
        let compact = |artwork: &serde_json::Value| {
            let listing = if artwork.is_null() {
                json!({"id": "example"})
            } else {
                json!({"id": "example", "artwork": artwork})
            };
            let directory = serde_json::to_vec(&json!({
                "listing_delivery_schema": 1,
                "revision": 5,
                "withdrawn_ids": [],
                "directory": { "format_version": 13, "listings": [listing] }
            }))
            .unwrap();
            let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&directory).unwrap();
            serde_json::to_vec(&json!({
                "carrier": portcove_listing_carrier::COMPACT_CARRIER,
                "decoded_bytes": directory.len(),
                "decoded_sha256": sha(&directory),
                "gzip_base64": STANDARD.encode(encoder.finish().unwrap())
            }))
            .unwrap()
        };
        let packet_b = "1".repeat(64);
        let packet_c = "2".repeat(64);
        let b = mapping(2, "coverb", "3");
        let c = mapping(3, "coverc", "4");
        let approved_b = fixture(None, &packet_b, &a, &b);
        let approved_c = fixture(Some(&packet_b), &packet_c, &b, &c);
        check_cover_approval_successor(None, &approved_b, &compact(&a), None, &compact(&b))
            .unwrap();
        check_cover_approval_successor(
            Some(&approved_b),
            &approved_c,
            &compact(&b),
            None,
            &compact(&c),
        )
        .unwrap();
        assert!(
            check_cover_approval_successor(
                Some(&approved_b),
                &approved_c,
                &compact(&b),
                None,
                &compact(&b)
            )
            .is_err()
        );
        assert!(
            check_cover_approval_successor(
                Some(&approved_b),
                &approved_b,
                &compact(&b),
                None,
                &compact(&b)
            )
            .is_err()
        );
        for (key, value) in [
            ("game_id", json!(17)),
            ("unexpected", json!("unknown mapping field")),
            ("image_sha256", a["image_sha256"].clone()),
            ("image_id", b["image_id"].clone()),
        ] {
            let mut invalid = c.clone();
            invalid[key] = value;
            let journal = fixture(Some(&packet_b), &packet_c, &b, &invalid);
            assert!(
                check_cover_approval_successor(
                    Some(&approved_b),
                    &journal,
                    &compact(&b),
                    None,
                    &compact(&invalid)
                )
                .is_err()
            );
        }
        let gone_scope =
            sha(&serde_json::to_vec(&json!(["example", null, null, null, "single", b])).unwrap());
        let gone = serde_json::to_vec(&json!({"entries": [{
            "id": "example", "scope": gone_scope, "image_id": "coverb",
            "prior_sha256": b["image_sha256"], "state": "gone"
        }]}))
        .unwrap();
        assert!(
            check_cover_approval_successor(
                Some(&approved_b),
                &approved_c,
                &compact(&serde_json::Value::Null),
                Some(&gone),
                &compact(&c),
            )
            .is_ok()
        );
        assert!(
            check_cover_approval_successor(
                Some(&approved_b),
                &approved_c,
                &compact(&serde_json::Value::Null),
                None,
                &compact(&c),
            )
            .is_err()
        );
        let wrong_preimage = fixture(Some(&packet_b), &packet_c, &a, &c);
        assert!(
            check_cover_approval_successor(
                Some(&approved_b),
                &wrong_preimage,
                &compact(&b),
                None,
                &compact(&c)
            )
            .is_err()
        );
        let mut forged_scope = approved_c.clone();
        forged_scope["approvals"][0]["scope"] = json!("0".repeat(64));
        assert!(
            check_cover_approval_successor(
                Some(&approved_b),
                &forged_scope,
                &compact(&b),
                None,
                &compact(&c),
            )
            .is_err()
        );
        let mut wrong_anchor = approved_c.clone();
        wrong_anchor["approvals"][0]["authored"] = b.clone();
        wrong_anchor["approvals"][0]["scope"] =
            json!(cover_approval_scope(&json!({"id":"example"}), &b).unwrap());
        assert!(
            check_cover_approval_successor(
                Some(&approved_b),
                &wrong_anchor,
                &compact(&b),
                None,
                &compact(&c),
            )
            .is_err()
        );
        let checkpoint = |state: &str, artwork: &Value| {
            let scope = cover_approval_scope(&json!({"id":"example"}), artwork).unwrap();
            serde_json::to_vec(&json!({"entries": [{
                "id": "example", "scope": scope, "image_id": artwork["image_id"],
                "prior_sha256": artwork["image_sha256"], "state": state
            }]}))
            .unwrap()
        };
        let targets = |artwork: &Value, cover: Vec<u8>| {
            Files::from([
                (COMPACT_TARGET.to_owned(), compact(artwork)),
                (COVER_CHECKPOINT_TARGET.to_owned(), cover),
            ])
        };
        let prior = targets(&a, checkpoint("restored", &a));
        let admitted = targets(&b, checkpoint("restored", &a));
        assert_eq!(
            select(None, Some(&approved_b), &prior, &admitted).unwrap(),
            Some(approved_b.clone()),
        );
        assert!(select(Some(approved_b.clone()), None, &admitted, &prior).is_err());
        let removed = targets(&Value::Null, checkpoint("gone", &b));
        assert_eq!(
            select(Some(approved_b.clone()), None, &admitted, &removed).unwrap(),
            Some(approved_b.clone()),
        );
        let restored = targets(&b, checkpoint("restored", &b));
        assert_eq!(
            select(Some(approved_b.clone()), None, &removed, &restored).unwrap(),
            Some(approved_b.clone()),
        );
        assert!(select(Some(approved_b.clone()), None, &admitted, &Files::new()).is_err());
        assert!(
            select(
                Some(approved_b.clone()),
                Some(&approved_c),
                &removed,
                &restored
            )
            .is_err()
        );
        let mut wrong_role = approved_c;
        wrong_role["approvals"][0]["role"] = json!("logo");
        assert!(
            check_cover_approval_successor(
                Some(&approved_b),
                &wrong_role,
                &compact(&b),
                None,
                &compact(&c)
            )
            .is_err()
        );
    }

    #[test]
    fn approval_scope_matches_the_publisher_vector_for_compatible_edition_identity() {
        let listing = json!({
            "id": "mortal-kombat-4-recompiled",
            "project_url": "https://github.com/alexbeavs-ps1-ports/mortal-kombat-4-recomp",
            "original_game_title": "Mortal Kombat 4 \u{2014} \u{65e5}\u{672c}",
            "original_game": {
                "format_version": 1, "id": "mortal-kombat-4",
                "evidence_urls": ["https://www.igdb.com/games/mortal-kombat-4"],
                "source_editions": [{
                    "id":"mortal-kombat-4-playstation", "title":"Mortal Kombat 4 (PlayStation)",
                    "system":"playstation", "evidence_urls":["https://example.com/edition"],
                }],
            },
        });
        let artwork = json!({
            "cover_id": 237769, "game_id": 1622, "game_slug": "mortal-kombat-4",
            "image_id": "co53gp", "image_sha256": "a".repeat(64), "match_kind": "underlying-game",
        });
        assert_eq!(
            cover_approval_scope(&listing, &artwork).unwrap(),
            "2f814ad1c3629bd5b9aa0a7b1a6d2abe83d22f1e088d9392f31a718702cf3287"
        );
    }
}
