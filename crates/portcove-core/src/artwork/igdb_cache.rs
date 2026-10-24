//! Disposable cover acceleration and process-local work admission.
//!
//! Originals, choices and catalog admission remain authoritative in the parent.
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicUsize, Ordering},
};

use super::IgdbRequestKey;
use crate::{PortcoveError, Result, artwork_image};

/// Maximum simultaneous IGDB original reads, fetches and image conversions.
/// Hosts can wait asynchronously before dispatching this blocking Core work.
pub const IGDB_ARTWORK_WORK_LIMIT: usize = 2;

const MAX_DERIVATIVE_BYTES: usize = 8 * 1024 * 1024;
const MAX_DERIVATIVE_ENTRIES: usize = 256;
// This cache never survives the executable. Explicit recipe/limit identity also
// prevents a future in-process recipe change from reusing an older derivative.
const DERIVATION: [u64; 7] = [
    1,
    artwork_image::MAX_ORIGINAL_BYTES,
    artwork_image::MAX_DECODED_BYTES,
    artwork_image::MAX_PIXELS,
    artwork_image::MAX_THUMBNAIL_BYTES,
    artwork_image::THUMBNAIL_WIDTH as u64,
    artwork_image::THUMBNAIL_HEIGHT as u64,
];

struct Derivative {
    key: IgdbRequestKey,
    recipe: [u64; 7],
    sha256: String,
    png: Vec<u8>,
}

#[derive(Default)]
pub(super) struct Derivatives {
    entries: VecDeque<Derivative>,
    bytes: usize,
}

impl Derivatives {
    /// Call only after reading and verifying the expected original digest.
    pub(super) fn get(&mut self, key: &IgdbRequestKey) -> Option<Vec<u8>> {
        let index = self.entries.iter().position(|entry| &entry.key == key)?;
        let entry = self.entries.remove(index)?;
        self.bytes -= entry.png.len();
        if entry.recipe != DERIVATION
            || entry.png.len() as u64 > artwork_image::MAX_THUMBNAIL_BYTES
            || crate::signed_catalog::digest(&entry.png) != entry.sha256
        {
            return None;
        }
        let png = entry.png.clone();
        self.bytes += entry.png.len();
        self.entries.push_back(entry);
        Some(png)
    }

    /// Accept only the output of the parent's validated JPEG conversion.
    pub(super) fn insert(&mut self, key: IgdbRequestKey, png: &[u8]) {
        if png.is_empty() || png.len() as u64 > artwork_image::MAX_THUMBNAIL_BYTES {
            return;
        }
        if let Some(index) = self.entries.iter().position(|entry| entry.key == key)
            && let Some(previous) = self.entries.remove(index)
        {
            self.bytes -= previous.png.len();
        }
        while self.bytes + png.len() > MAX_DERIVATIVE_BYTES
            || self.entries.len() >= MAX_DERIVATIVE_ENTRIES
        {
            if let Some(oldest) = self.entries.pop_front() {
                self.bytes -= oldest.png.len();
            }
        }
        self.bytes += png.len();
        self.entries.push_back(Derivative {
            key,
            recipe: DERIVATION,
            sha256: crate::signed_catalog::digest(png),
            png: png.to_vec(),
        });
    }

    pub(super) fn clear_library(&mut self, root: &std::path::Path, id: &str) {
        self.entries
            .retain(|entry| entry.key.0 != root || entry.key.1 != id);
        self.bytes = self.entries.iter().map(|entry| entry.png.len()).sum();
    }
}

pub(super) struct WorkBudget(AtomicUsize);

impl WorkBudget {
    pub(super) const fn new() -> Self {
        Self(AtomicUsize::new(0))
    }

    pub(super) fn try_acquire(&self) -> Result<WorkPermit<'_>> {
        self.0
            .try_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < IGDB_ARTWORK_WORK_LIMIT).then_some(active + 1)
            })
            .map_err(|_| PortcoveError::conflict("cover retrieval is busy; retry shortly"))?;
        Ok(WorkPermit(self))
    }
}

pub(super) struct WorkPermit<'a>(&'a WorkBudget);

impl Drop for WorkPermit<'_> {
    fn drop(&mut self) {
        self.0.0.fetch_sub(1, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(index: usize) -> IgdbRequestKey {
        (
            std::path::PathBuf::from("library"),
            "durable identity".into(),
            format!("image{index}"),
            format!("{index:064x}"),
        )
    }

    #[test]
    fn derivatives_bound_bytes_and_entries_and_evict_least_recently_used() {
        let mut cache = Derivatives::default();
        let png = vec![7; artwork_image::MAX_THUMBNAIL_BYTES as usize];
        for index in 0..8 {
            cache.insert(key(index), &png);
        }
        assert_eq!(cache.bytes, MAX_DERIVATIVE_BYTES);
        assert!(cache.get(&key(0)).is_some());
        cache.insert(key(8), &png);
        assert!(cache.get(&key(0)).is_some());
        assert!(cache.get(&key(1)).is_none());
        assert_eq!(cache.bytes, MAX_DERIVATIVE_BYTES);
        cache.insert(key(8), &[9]);
        assert_eq!(cache.bytes, 7 * png.len() + 1);
        cache.insert(key(9), &vec![0; png.len() + 1]);
        assert!(cache.get(&key(9)).is_none());
        for index in 10..400 {
            cache.insert(key(index), &[1]);
        }
        assert_eq!(cache.entries.len(), MAX_DERIVATIVE_ENTRIES);
        assert_eq!(cache.bytes, MAX_DERIVATIVE_ENTRIES);
    }

    #[test]
    fn corrupt_or_different_recipe_derivatives_are_discarded_and_copies_are_isolated() {
        let mut cache = Derivatives::default();
        cache.insert(key(0), &[1, 2, 3]);
        let mut output = cache.get(&key(0)).unwrap();
        output[0] = 9;
        assert_eq!(cache.get(&key(0)).unwrap(), [1, 2, 3]);
        cache.entries[0].png[0] = 9;
        assert!(cache.get(&key(0)).is_none());
        assert_eq!(cache.bytes, 0);
        cache.insert(key(0), &[1, 2, 3]);
        cache.entries[0].recipe[0] += 1;
        assert!(cache.get(&key(0)).is_none());
        assert_eq!(cache.bytes, 0);
    }

    #[test]
    fn derivative_clear_is_scoped_to_canonical_root_and_durable_identity() {
        let mut cache = Derivatives::default();
        let first = key(0);
        let mut other_root = first.clone();
        other_root.0 = "other library".into();
        let mut other_id = first.clone();
        other_id.1 = "replacement identity".into();
        for identity in [&first, &other_root, &other_id] {
            cache.insert(identity.clone(), &[1, 2]);
        }
        cache.clear_library(&first.0, &first.1);
        assert!(cache.get(&first).is_none());
        assert!(cache.get(&other_root).is_some());
        assert!(cache.get(&other_id).is_some());
        assert_eq!(cache.bytes, 4);
    }

    #[test]
    fn work_budget_refuses_excess_without_waiting_and_releases_permits() {
        let budget = WorkBudget::new();
        let first = budget.try_acquire().unwrap();
        let second = budget.try_acquire().unwrap();
        assert!(
            matches!(budget.try_acquire(), Err(error) if error.code == crate::ErrorCode::Conflict)
        );
        drop(first);
        let replacement = budget.try_acquire().unwrap();
        drop((second, replacement));
        assert_eq!(budget.0.load(Ordering::Acquire), 0);
    }

    #[test]
    fn cover_http_client_is_reused_across_requests() {
        let client = super::super::igdb_http_client()
            .map_err(|failure| failure.error)
            .unwrap();
        let next = super::super::igdb_http_client()
            .map_err(|failure| failure.error)
            .unwrap();
        assert!(std::ptr::eq(client, next));
    }
}
