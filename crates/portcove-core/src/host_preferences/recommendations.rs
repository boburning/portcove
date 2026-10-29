//! Bounded advisory observation memory in the existing host preference store.
//! Unknown extension versions are preserved. This is not executable/catalog authority.
use super::*;
use crate::game_recommendations::{ComparisonRelease, fingerprint};

const KEY: &str = "recommendation_observations_by_library";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReleaseObservation {
    pub port_id: String,
    pub platform: crate::Platform,
    pub channel: crate::ReleaseChannel,
    /// Relevant definition input, independent of optional quality observations.
    pub definition_id: String,
    /// Last attempted accepted definition, including a failed check. Keep this
    /// separate from the last-good release's definition so failure neither
    /// relabels old bytes nor retries unchanged input on every query.
    #[serde(default)]
    pub attempted_definition_id: Option<String>,
    pub update_input_id: Option<String>,
    pub release: Option<ComparisonRelease>,
    pub last_success_at: Option<u64>,
    pub last_attempt_at: u64,
    pub changed_at: Option<u64>,
    pub failed: bool,
}

impl ReleaseObservation {
    pub(crate) fn key(
        port_id: &str,
        platform: crate::Platform,
        channel: crate::ReleaseChannel,
    ) -> Result<String> {
        fingerprint(&(port_id, platform, channel))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecommendationHistory {
    format_version: u32,
    pub releases: BTreeMap<String, ReleaseObservation>,
    pub regressions: Vec<crate::RecommendationRegression>,
    pub corrections: Vec<crate::RecommendationVerifiedCorrection>,
}

impl Default for RecommendationHistory {
    fn default() -> Self {
        Self {
            format_version: 1,
            releases: BTreeMap::new(),
            regressions: vec![],
            corrections: vec![],
        }
    }
}

pub(crate) struct ReleaseObservationPatch {
    pub key: String,
    pub expected: Option<ReleaseObservation>,
    pub observed: ReleaseObservation,
}

impl HostPreferenceStore {
    pub(crate) fn recommendation_history(&self, library_id: &str) -> Result<RecommendationHistory> {
        validate_favorite_library_id(library_id)?;
        let preferences = self.load()?;
        let libraries = history_libraries(&preferences)?;
        history_record(libraries.get(library_id))
    }

    /// Accepted failures/corrections are a union, never latest-collection replacement.
    /// Concurrent collection only replaces a release slot it actually observed; a
    /// later writer cannot overwrite an unseen newer answer. The returned readback
    /// is the only history the caller may use for the resulting assessment.
    pub(crate) fn retain_recommendation_observations(
        &self,
        library_id: &str,
        releases: Vec<ReleaseObservationPatch>,
        regressions: &[crate::RecommendationRegression],
        corrections: &[crate::RecommendationVerifiedCorrection],
    ) -> Result<RecommendationHistory> {
        validate_favorite_library_id(library_id)?;
        let _lock = self.lock()?;
        let mut preferences = self.load()?;
        let mut libraries = history_libraries(&preferences)?;
        let mut record = history_record(libraries.get(library_id))?;
        let original = record.clone();
        for patch in releases {
            if record.releases.get(&patch.key) == patch.expected.as_ref() {
                record.releases.insert(patch.key, patch.observed);
            }
        }
        record.regressions = record
            .regressions
            .iter()
            .chain(regressions)
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        for correction in corrections {
            if !record.corrections.contains(correction) {
                record.corrections.push(correction.clone());
            }
        }
        record
            .corrections
            .sort_by_cached_key(|correction| serde_json::to_string(correction).unwrap_or_default());
        if record == original {
            return Ok(record);
        }
        // Refuse rather than erase critical history to make space. The ordinary
        // application remains usable and the comparison reports unavailable history.
        validate_history(&record)?;
        libraries.insert(library_id.to_owned(), serde_json::to_value(&record)?);
        preferences
            .extensions
            .insert(KEY.into(), serde_json::to_value(libraries)?);
        self.publish(&preferences)?;
        Ok(record)
    }
}

fn history_libraries(preferences: &HostPreferences) -> Result<BTreeMap<String, serde_json::Value>> {
    preferences.extensions.get(KEY).map_or_else(
        || Ok(BTreeMap::new()),
        |value| {
            serde_json::from_value(value.clone())
                .map_err(|_| PortcoveError::state("recommendation history is unavailable"))
        },
    )
}

fn history_record(value: Option<&serde_json::Value>) -> Result<RecommendationHistory> {
    let record = value.map_or_else(
        || Ok(RecommendationHistory::default()),
        |value| {
            serde_json::from_value(value.clone()).map_err(|_| {
                PortcoveError::state("recommendation history version or data is unavailable")
            })
        },
    )?;
    validate_history(&record)?;
    Ok(record)
}

fn validate_history(record: &RecommendationHistory) -> Result<()> {
    if record.format_version != 1
        || record.releases.len() > 64
        || record.regressions.len() > 128
        || record.corrections.len() > 128
        || record.releases.iter().any(|(key, observation)| {
            ReleaseObservation::key(
                &observation.port_id,
                observation.platform,
                observation.channel,
            )
            .map_or(true, |expected| expected != *key)
                || !crate::game_recommendations::digest_valid(&observation.definition_id)
                || observation
                    .attempted_definition_id
                    .as_ref()
                    .is_some_and(|id| !crate::game_recommendations::digest_valid(id))
                || observation
                    .release
                    .as_ref()
                    .is_some_and(|release| !release.valid())
                || observation
                    .last_success_at
                    .is_some_and(|time| time > observation.last_attempt_at)
        })
    {
        return Err(PortcoveError::state(
            "recommendation history is unsupported or full",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_read_and_unchanged_union_do_not_create_preferences() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preferences.json");
        let store = HostPreferenceStore::new(path.clone()).unwrap();
        let id = crate::Library::open(tmp.path().join("library"))
            .unwrap()
            .identity()
            .unwrap();
        assert_eq!(
            store.recommendation_history(&id).unwrap(),
            RecommendationHistory::default()
        );
        assert_eq!(
            store
                .retain_recommendation_observations(&id, vec![], &[], &[])
                .unwrap(),
            RecommendationHistory::default()
        );
        assert!(!path.exists());
    }

    #[test]
    fn a_future_extension_is_preserved_and_cannot_be_reset_by_collection() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("preferences.json");
        let store = HostPreferenceStore::new(path.clone()).unwrap();
        let id = crate::Library::open(tmp.path().join("library"))
            .unwrap()
            .identity()
            .unwrap();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "format_version": 1, "library_root": null,
            KEY: {id.clone(): {"format_version": 7, "accepted_failures": ["preserve-me"]}}
        }))
        .unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(store.recommendation_history(&id).is_err());
        assert!(
            store
                .retain_recommendation_observations(&id, vec![], &[], &[])
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}
