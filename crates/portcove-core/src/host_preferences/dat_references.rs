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

    /// Returns whether a reference with this ID existed. The DAT file itself is untouched.
    pub(crate) fn remove_dat_reference(&self, id: &str) -> Result<bool> {
        let _lock = self.lock()?;
        let mut preferences = self.load()?;
        let mut references = saved_dat_references(&preferences)?;
        let before = references.len();
        references.retain(|saved| saved.id != id);
        if references.len() == before {
            return Ok(false);
        }
        if references.is_empty() {
            preferences.extensions.remove(DAT_REFERENCES_KEY);
        } else {
            preferences.extensions.insert(
                DAT_REFERENCES_KEY.to_owned(),
                serde_json::to_value(references)?,
            );
        }
        self.publish(&preferences)?;
        Ok(true)
    }
}

fn saved_dat_references(preferences: &HostPreferences) -> Result<Vec<SavedDatReference>> {
    let Some(value) = preferences.extensions.get(DAT_REFERENCES_KEY) else {
        return Ok(Vec::new());
    };
    let references: Vec<SavedDatReference> =
        serde_json::from_value(value.clone()).map_err(|_| {
            PortcoveError::state("saved DAT files are malformed; repair or reset preferences")
        })?;
    if references.len() > MAX_DAT_REFERENCES {
        return Err(PortcoveError::state("too many saved DAT files"));
    }
    for reference in &references {
        reference.validate()?;
    }
    Ok(references)
}
