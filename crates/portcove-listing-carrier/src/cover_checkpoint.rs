use std::collections::BTreeMap;

use serde::Deserialize;
use sha2::{Digest, Sha256};

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
    if value.len() != 24
        || !value
            .bytes()
            .zip(b"0000-00-00T00:00:00.000Z")
            .all(|(actual, expected)| {
                if *expected == b'0' {
                    actual.is_ascii_digit()
                } else {
                    actual == *expected
                }
            })
    {
        return false;
    }
    // The wire has ASCII digits at every slice below.
    let number = |start, end| value[start..end].parse::<u32>().unwrap_or_default();
    let year = number(0, 4);
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let month_days = match number(5, 7) {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 28 + u32::from(leap),
        _ => return false,
    };
    (1..=month_days).contains(&number(8, 10))
        && number(11, 13) <= 23
        && number(14, 16) <= 59
        && number(17, 19) <= 59
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
            || !(1..=128).contains(&row.id.len())
            || !row.id.as_bytes()[0].is_ascii_alphanumeric()
            || !row
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || !(1..=128).contains(&row.image_id.len())
            || !row
                .image_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
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
                "id": "fixture", "scope": "c".repeat(64), "image_id": "cofixture",
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

    #[test]
    fn checkpoint_clock_agrees_with_canonical_utc_millisecond_dates() {
        assert!(valid_date("2024-02-29T23:59:59.999Z"));
        assert!(!valid_date("2026-02-29T12:00:00.000Z"));
        assert!(!valid_date("2024-02-29T24:00:00.000Z"));
        assert!(!valid_date("2024-02-29T23:59:60.000Z"));
        assert!(!valid_date("2024-02-29T23:59:59Z"));
        assert!(!valid_date("2024-02-29T23:59:59.000-01:00"));
    }
}
