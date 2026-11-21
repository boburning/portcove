use super::*;
use std::collections::BTreeMap;

pub const COVER_CHECKPOINT_TARGET: &str = "policy/official/catalog.cover-checkpoint.json";
pub const COVER_CHECKPOINT_MAX: usize = 1024 * 1024;

#[derive(Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    scope: String,
    image_id: String,
    prior_sha256: String,
    observed_at: String,
    receipt: String,
    state: State,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum State {
    Gone,
    Restored,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    checkpoint_schema: u32,
    listing_sha256: String,
    #[serde(deserialize_with = "required_option")]
    prior_checkpoint_sha256: Option<String>,
    entries: Vec<Entry>,
}

fn required_option<'de, D: serde::Deserializer<'de>>(value: D) -> Result<Option<String>, D::Error> {
    Option::deserialize(value)
}

#[derive(Debug, thiserror::Error)]
#[error("invalid or discontinuous cover observation checkpoint")]
pub struct InvalidCoverCheckpoint;

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn key(row: &Entry) -> String {
    format!(
        "{}/{}/{}/{}",
        row.id, row.scope, row.image_id, row.prior_sha256
    )
}

fn valid_date(value: &str) -> bool {
    value.len() == 24
        && value
            .bytes()
            .zip(b"0000-00-00T00:00:00.000Z")
            .all(|(actual, expected)| {
                if *expected == b'0' {
                    actual.is_ascii_digit()
                } else {
                    actual == *expected
                }
            })
}

fn parse(raw: &[u8], listing_sha256: &str) -> Result<Checkpoint, InvalidCoverCheckpoint> {
    if raw.is_empty() || raw.len() > COVER_CHECKPOINT_MAX {
        return Err(InvalidCoverCheckpoint);
    }
    let checkpoint: Checkpoint = serde_json::from_slice(raw).map_err(|_| InvalidCoverCheckpoint)?;
    if checkpoint.checkpoint_schema != 1
        || checkpoint.listing_sha256 != listing_sha256
        || !digest(listing_sha256)
        || checkpoint
            .prior_checkpoint_sha256
            .as_ref()
            .is_some_and(|sha| !digest(sha))
        || !(1..=3072).contains(&checkpoint.entries.len())
    {
        return Err(InvalidCoverCheckpoint);
    }
    let mut previous = String::new();
    for row in &checkpoint.entries {
        let identity = key(row);
        if identity <= previous
            || row.id.len() > 128
            || !row.id.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            })
            || !(1..=64).contains(&row.image_id.len())
            || !row.image_id.bytes().all(|b| b.is_ascii_alphanumeric())
            || !digest(&row.scope)
            || !digest(&row.prior_sha256)
            || !row.receipt.strip_prefix("sha256:").is_some_and(digest)
            || !valid_date(&row.observed_at)
        {
            return Err(InvalidCoverCheckpoint);
        }
        previous = identity;
    }
    Ok(checkpoint)
}

/// Inspect inert publisher state against the active directory's decoded identity.
pub fn check_cover_checkpoint(
    raw: &[u8],
    listing_sha256: &str,
) -> Result<(), InvalidCoverCheckpoint> {
    parse(raw, listing_sha256).map(drop)
}

/// Compare the current and proposed states after the repository authenticated its prior.
pub fn check_cover_checkpoint_successor(
    prior: Option<(&[u8], &str)>,
    next: Option<(&[u8], &str)>,
) -> Result<(), InvalidCoverCheckpoint> {
    let Some((next_bytes, next_listing)) = next else {
        return if prior.is_some() {
            Err(InvalidCoverCheckpoint)
        } else {
            Ok(())
        };
    };
    let next = parse(next_bytes, next_listing)?;
    let Some((prior_bytes, prior_listing)) = prior else {
        return if next.prior_checkpoint_sha256.is_none()
            && next.entries.iter().all(|row| row.state == State::Gone)
        {
            Ok(())
        } else {
            Err(InvalidCoverCheckpoint)
        };
    };
    let prior = parse(prior_bytes, prior_listing)?;
    if prior_bytes == next_bytes {
        return Ok(());
    }
    if next.prior_checkpoint_sha256 != Some(hex::encode(Sha256::digest(prior_bytes))) {
        return Err(InvalidCoverCheckpoint);
    }
    let mut old: BTreeMap<_, _> = prior
        .entries
        .into_iter()
        .map(|row| (key(&row), row))
        .collect();
    for row in next.entries {
        match old.remove(&key(&row)) {
            Some(previous) if previous == row || previous.observed_at < row.observed_at => {}
            None if row.state == State::Gone => {}
            _ => return Err(InvalidCoverCheckpoint),
        }
    }
    if !old.is_empty() {
        return Err(InvalidCoverCheckpoint);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cover_checkpoint_recovery_requires_the_exact_active_listing_and_predecessor() {
        let listing = "a".repeat(64);
        let successor_listing = "b".repeat(64);
        let mut value = json!({
            "checkpoint_schema": 1,
            "listing_sha256": listing,
            "prior_checkpoint_sha256": null,
            "entries": [{
                "id": "fixture", "scope": "c".repeat(64), "image_id": "coFixture",
                "prior_sha256": "d".repeat(64), "observed_at": "2026-11-21T12:00:00.000Z",
                "receipt": format!("sha256:{}", "e".repeat(64)), "state": "gone",
            }],
        });
        let first = serde_json::to_vec(&value).unwrap();
        let prior = Some((first.as_slice(), listing.as_str()));
        assert!(check_cover_checkpoint_successor(None, prior).is_ok());
        assert!(check_cover_checkpoint_successor(prior, prior).is_ok());
        assert!(check_cover_checkpoint_successor(prior, None).is_err());
        assert!(check_cover_checkpoint(&first, &successor_listing).is_err());
        value["listing_sha256"] = json!(successor_listing);
        value["entries"][0]["state"] = json!("restored");
        value["prior_checkpoint_sha256"] = json!(hex::encode(Sha256::digest(&first)));
        let stale = serde_json::to_vec(&value).unwrap();
        assert!(
            check_cover_checkpoint_successor(prior, Some((&stale, &successor_listing))).is_err()
        );
        value["entries"][0]["observed_at"] = json!("2026-11-22T12:00:00.000Z");
        let restored = serde_json::to_vec(&value).unwrap();
        let next = Some((restored.as_slice(), successor_listing.as_str()));
        assert!(check_cover_checkpoint_successor(prior, next).is_ok());
        assert!(check_cover_checkpoint_successor(next, prior).is_err());
    }
}
