//! Saved references to player-supplied DAT files. They name dumps only and
//! never authorize a source; see `crate::dump_dat`.
use super::*;
use crate::dump_dat::{MAX_DAT_REFERENCES, SavedDatReference};

const DAT_REFERENCES_KEY: &str = "dat_references";

impl HostPreferenceStore {
    pub(crate) fn dat_references(&self) -> Result<Vec<SavedDatReference>> {
        saved_dat_references(&self.load()?)
    }

    /// Replace a reference at the same location, or with the same contents
    /// (a moved file), under the preference lock and atomic publication.
    pub(crate) fn save_dat_reference(&self, reference: SavedDatReference) -> Result<()> {
        reference.validate()?;
        let _lock = self.lock()?;
        let mut preferences = self.load()?;
        let mut references = saved_dat_references(&preferences)?;
        references.retain(|saved| saved.id != reference.id && saved.sha256 != reference.sha256);
        if references.len() >= MAX_DAT_REFERENCES {
            return Err(PortcoveError::conflict(format!(
                "Portcove keeps at most {MAX_DAT_REFERENCES} DAT files; remove one first"
            )));
        }
        references.push(reference);
        preferences.extensions.insert(
            DAT_REFERENCES_KEY.to_owned(),
            serde_json::to_value(references)?,
        );
        self.publish(&preferences)
    }

    /// Returns whether a reference with this ID existed. The DAT file itself is
    /// untouched. Removal works on the saved entries as stored, so an entry that
    /// no longer validates (for example from another build) can still be removed.
    pub(crate) fn remove_dat_reference(&self, id: &str) -> Result<bool> {
        let _lock = self.lock()?;
        let mut preferences = self.load()?;
        let mut entries = stored_entries(&preferences)?;
        let before = entries.len();
        entries.retain(|entry| entry.get("id").and_then(serde_json::Value::as_str) != Some(id));
        if entries.len() == before {
            return Ok(false);
        }
        if entries.is_empty() {
            preferences.extensions.remove(DAT_REFERENCES_KEY);
        } else {
            preferences.extensions.insert(
                DAT_REFERENCES_KEY.to_owned(),
                serde_json::Value::Array(entries),
            );
        }
        self.publish(&preferences)?;
        Ok(true)
    }
}

fn stored_entries(preferences: &HostPreferences) -> Result<Vec<serde_json::Value>> {
    match preferences.extensions.get(DAT_REFERENCES_KEY) {
        None => Ok(Vec::new()),
        Some(serde_json::Value::Array(entries)) => Ok(entries.clone()),
        Some(_) => Err(PortcoveError::state(
            "saved DAT files are malformed; repair or reset preferences",
        )),
    }
}

/// Valid entries, at most the supported count. Entries that don't validate
/// or exceed the count (for example from another build) are ignored here and
/// dropped by the next added reference; removal by ID still reaches them.
fn saved_dat_references(preferences: &HostPreferences) -> Result<Vec<SavedDatReference>> {
    Ok(stored_entries(preferences)?
        .into_iter()
        .filter_map(|entry| serde_json::from_value::<SavedDatReference>(entry).ok())
        .filter(|reference| reference.validate().is_ok())
        .take(MAX_DAT_REFERENCES)
        .collect())
}
