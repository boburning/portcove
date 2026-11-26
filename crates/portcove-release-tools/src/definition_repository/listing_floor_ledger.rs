//! Listing-floor ledger (#1422; design `CATALOG-DISTRIBUTION-SCALING.md` 6.1).
//!
//! History verification derives a few facts from every historical listing body
//! that retained signed `official-policy` metadata names: its revision, decoded
//! SHA-256 and withdrawals. The ledger keeps exactly those facts, one entry per
//! distinct body, so a body outside the served window can still be verified
//! from the signed descriptor that names it plus its ledger entry.
//!
//! Trust: the ledger is not a signed target. Each entry's `target`, `sha256` and
//! `length` must equal a retained signed descriptor; its derived facts are
//! recomputed from the body whenever the body is present and are appended only
//! by a run that read the body. The newest body of every listing target is
//! never pruned, so the floor every successor is checked against always comes
//! from signed bytes, never from the ledger.
use super::*;

/// Catalog-relative path of the served ledger. It sits beside, not inside, the
/// TUF repository (`metadata/`, `targets/`), which stays exactly signed content.
pub const PATH: &str = "history-ledger/listing-floors.json";
const KIND: &str = "catalog-listing-floor-ledger";
const SCHEMA: u32 = 1;
/// Canonical (pretty, sorted) entries are about 480 bytes. 16,384 entries is
/// about 5 years at today's 8.6 listing changes a day; history checkpoint
/// schema 2 (#1422 H1) carries the ledger digest before that matters.
pub(super) const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 16_384;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Entry {
    /// The lowest retained `official-policy` version naming this body.
    pub(super) policy_version: u64,
    pub(super) target: String,
    pub(super) sha256: String,
    pub(super) length: u64,
    pub(super) revision: u64,
    pub(super) decoded_sha256: String,
    pub(super) withdrawn_ids_count: u64,
    pub(super) withdrawn_ids_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    ledger_schema: u32,
    kind: String,
    entries: Vec<Entry>,
}

/// SHA-256 of the sorted withdrawn IDs as a compact JSON array.
pub(super) fn withdrawn_digest(ids: &BTreeSet<String>) -> String {
    sha(&serde_json::to_vec(ids).expect("string set serializes"))
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

/// Ordered, append-only list of entries keyed by `(target, sha256)`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Ledger {
    entries: Vec<Entry>,
    index: BTreeMap<(String, String), usize>,
}

impl Ledger {
    fn from_entries(entries: Vec<Entry>) -> Result<Self> {
        if entries.len() > MAX_ENTRIES {
            return invalid("catalog listing-floor ledger exceeds its entry bound");
        }
        let mut index = BTreeMap::new();
        let mut previous: Option<(u64, &str, &str)> = None;
        for (position, entry) in entries.iter().enumerate() {
            if entry.policy_version == 0
                || !portcove_listing_carrier::is_listing_target(&entry.target)
                || !hex64(&entry.sha256)
                || !hex64(&entry.decoded_sha256)
                || !hex64(&entry.withdrawn_ids_sha256)
                || entry.length == 0
                || entry.length > portcove_listing_carrier::MAX_BYTES as u64
                || !(1..=MAX_REVISION).contains(&entry.revision)
                || entry.withdrawn_ids_count > 10_000
                || (entry.withdrawn_ids_count == 0
                    && entry.withdrawn_ids_sha256 != withdrawn_digest(&BTreeSet::new()))
            {
                return invalid("catalog listing-floor ledger entry is malformed");
            }
            // Legacy bodies are their own decoded document.
            if entry.target == portcove_listing_carrier::LEGACY_TARGET
                && entry.decoded_sha256 != entry.sha256
            {
                return invalid("catalog listing-floor ledger legacy entry is malformed");
            }
            let key = (
                entry.policy_version,
                entry.target.as_str(),
                entry.sha256.as_str(),
            );
            if previous.is_some_and(|previous| previous >= key) {
                return invalid("catalog listing-floor ledger is not in canonical order");
            }
            previous = Some(key);
            if index
                .insert((entry.target.clone(), entry.sha256.clone()), position)
                .is_some()
            {
                return invalid("catalog listing-floor ledger repeats a body");
            }
        }
        Ok(Self { entries, index })
    }

    /// Parse exactly the canonical encoding written by [`Ledger::encode`].
    pub(super) fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() as u64 > MAX_BYTES {
            return invalid("catalog listing-floor ledger exceeds its byte bound");
        }
        let document: Document = serde_json::from_slice(bytes)?;
        if document.ledger_schema != SCHEMA || document.kind != KIND {
            return invalid("catalog listing-floor ledger schema differs");
        }
        let ledger = Self::from_entries(document.entries)?;
        if ledger.encode()? != bytes {
            return invalid("catalog listing-floor ledger is not canonical");
        }
        Ok(ledger)
    }

    pub(super) fn encode(&self) -> Result<Vec<u8>> {
        let bytes = io::canonical(&serde_json::to_vec(&Document {
            ledger_schema: SCHEMA,
            kind: KIND.into(),
            entries: self.entries.clone(),
        })?)?;
        if bytes.len() as u64 > MAX_BYTES {
            return invalid("catalog listing-floor ledger exceeds its byte bound");
        }
        Ok(bytes)
    }

    pub(super) fn get(&self, target: &str, sha256: &str) -> Option<&Entry> {
        self.index
            .get(&(target.to_owned(), sha256.to_owned()))
            .map(|position| &self.entries[*position])
    }

    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(super) fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Append-only: every published entry stays, unchanged and in place.
    pub(super) fn extends(&self, prior: &Self) -> bool {
        self.entries.len() >= prior.entries.len()
            && self.entries[..prior.entries.len()] == prior.entries[..]
    }
}

/// What one run observed for each distinct listing body named in history.
#[derive(Default)]
pub(super) struct Recorder {
    bodies: BTreeMap<(String, String), (u64, Option<Entry>, bool)>,
}

impl Recorder {
    /// Every signed reference lowers the body's first policy version.
    pub(super) fn reference(&mut self, target: &str, sha256: &str, policy_version: Option<u64>) {
        let slot = self
            .bodies
            .entry((target.to_owned(), sha256.to_owned()))
            .or_insert((u64::MAX, None, false));
        if let Some(version) = policy_version {
            slot.0 = slot.0.min(version);
        }
    }

    /// Facts derived once per body, from its bytes (`from_body`) or the ledger.
    pub(super) fn facts(&mut self, entry: Entry, from_body: bool) {
        let slot = self
            .bodies
            .entry((entry.target.clone(), entry.sha256.clone()))
            .or_insert((u64::MAX, None, false));
        slot.1 = Some(entry);
        slot.2 = from_body;
    }

    /// The deterministic ledger for this history, and how many entries were
    /// re-derived from bodies present in this run.
    pub(super) fn ledger(&self) -> Result<(Ledger, usize)> {
        let mut entries = Vec::with_capacity(self.bodies.len());
        let mut from_bodies = 0;
        for (version, entry, from_body) in self.bodies.values() {
            let Some(entry) = entry else {
                return invalid("catalog listing-floor ledger body has no derived facts");
            };
            if *version == u64::MAX {
                return invalid("catalog listing-floor ledger body has no policy version");
            }
            from_bodies += usize::from(*from_body);
            entries.push(Entry {
                policy_version: *version,
                ..entry.clone()
            });
        }
        entries.sort_by(|a, b| {
            (a.policy_version, &a.target, &a.sha256).cmp(&(b.policy_version, &b.target, &b.sha256))
        });
        Ok((Ledger::from_entries(entries)?, from_bodies))
    }
}

/// The new canonical ledger bytes and their summary.
pub(super) type Output = (Vec<u8>, LedgerReport);

/// A run that maintains the ledger: the published predecessor (absent only for
/// the one-time backfill) and the ledger this run derives.
#[derive(Debug, Default)]
pub(super) struct State {
    pub(super) prior: Option<Ledger>,
    pub(super) next: Option<Output>,
}

/// Summary written into assembly and history-verification reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LedgerReport {
    pub sha256: String,
    pub bytes: u64,
    pub entries: usize,
    pub prior_entries: usize,
    /// Entries re-derived from a body present in this run's retained tree.
    pub verified_from_bodies: usize,
    /// Entries whose body is outside the served tree and was verified only
    /// against the signed descriptor naming it.
    pub verified_from_ledger: usize,
}

/// The new ledger for a verified history, refusing anything that does not
/// extend the published predecessor exactly.
pub(super) fn next(recorder: &Recorder, prior: Option<&Ledger>) -> Result<Output> {
    let (ledger, from_bodies) = recorder.ledger()?;
    if let Some(prior) = prior
        && !ledger.extends(prior)
    {
        return invalid(
            "catalog listing-floor ledger does not extend its published predecessor exactly",
        );
    }
    let bytes = ledger.encode()?;
    Ok((
        bytes.clone(),
        LedgerReport {
            sha256: sha(&bytes),
            bytes: bytes.len() as u64,
            entries: ledger.len(),
            prior_entries: prior.map_or(0, Ledger::len),
            verified_from_bodies: from_bodies,
            verified_from_ledger: ledger.len() - from_bodies,
        },
    ))
}

#[cfg(test)]
mod tests;
