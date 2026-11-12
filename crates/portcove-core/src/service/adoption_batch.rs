//! One reviewed consent for copying several existing installations (#249).
//!
//! A batch adds no durable authority. Each item still runs the ordinary journaled
//! `adopt` under its own lock and recovery; the batch only binds one review of all
//! item plans to one consent. An item whose plan changed after review is held, not
//! copied, and a failed item leaves the others independent.
use super::*;

/// Most items one batch review may hold; each item hashes its whole folder.
pub const ADOPTION_BATCH_LIMIT: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionBatchItem {
    /// Existing installation folder to copy; it is never modified.
    pub source: PathBuf,
    /// Catalog port this folder is reviewed for.
    pub port_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionBatchPreview {
    /// The ordinary adoption review of each item, in batch order.
    pub items: Vec<AdoptionPreview>,
    pub total_files: usize,
    pub total_bytes: u64,
    /// Items whose copy replaces matching saved files already in Portcove.
    pub items_replacing_saved_files: usize,
    pub original_will_be_modified: bool,
    /// Binds the item list and every item's reviewed plan.
    pub batch_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AdoptionBatchItemOutcome {
    /// Copied and registered through the ordinary adoption.
    Copied,
    /// The folder or destination changed after review; nothing was copied for it.
    Changed,
    /// Adoption refused or failed; the original stays unchanged.
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionBatchItemResult {
    pub source: PathBuf,
    pub port_id: String,
    pub outcome: AdoptionBatchItemOutcome,
    pub install: Option<InstallRecord>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AdoptionBatchResult {
    pub batch_sha256: String,
    pub items: Vec<AdoptionBatchItemResult>,
}

const BATCH_ACTION: &str = "adopt-batch";

impl PortcoveService {
    /// Review several existing installations as one batch. Each item must resolve to
    /// its named port; folders and ports may appear only once.
    pub fn preview_adoption_batch(
        &self,
        items: &[AdoptionBatchItem],
    ) -> Result<AdoptionBatchPreview> {
        validate_batch(items)?;
        let previews = items
            .iter()
            .map(|item| {
                let preview = self
                    .preview_adoption(&item.source, Some(&item.port_id))
                    .map_err(|error| error.detail("source", item.source.display().to_string()))?;
                if preview.selected_port_id.as_deref() != Some(item.port_id.as_str())
                    || preview.destination.is_none()
                {
                    return Err(PortcoveError::conflict(format!(
                        "{} could not be reviewed as {}",
                        item.source.display(),
                        item.port_id
                    )));
                }
                Ok(preview)
            })
            .collect::<Result<Vec<_>>>()?;
        let batch_sha256 = batch_fingerprint(&previews)?;
        Ok(AdoptionBatchPreview {
            total_files: previews
                .iter()
                .map(|preview| preview.copy_plan.files.len())
                .sum(),
            total_bytes: previews
                .iter()
                .map(|preview| preview.copy_plan.total_bytes)
                .sum(),
            items_replacing_saved_files: previews
                .iter()
                .filter(|preview| {
                    preview
                        .destination
                        .as_ref()
                        .is_some_and(|destination| !destination.imported_user_data_paths.is_empty())
                })
                .count(),
            original_will_be_modified: false,
            items: previews,
            batch_sha256,
        })
    }

    /// One consent for exactly the reviewed batch.
    pub fn authorize_adoption_batch(
        &self,
        items: &[AdoptionBatchItem],
        expected_batch_sha256: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        validate_reviewed_fingerprint("adoption batch", expected_batch_sha256)?;
        validate_batch(items)?;
        self.library
            .issue_authorization(BATCH_ACTION, &batch_target(items)?, expected_batch_sha256)
    }

    /// Copy each reviewed item through the ordinary adoption, in order. The batch
    /// consent is consumed once; each item is then re-reviewed and copied only when
    /// its plan still matches, so a changed folder or destination is held.
    pub fn adopt_batch(
        &self,
        items: &[AdoptionBatchItem],
        reviewed: &AdoptionBatchPreview,
        authorization_token: &str,
    ) -> Result<AdoptionBatchResult> {
        validate_batch(items)?;
        let reviewed_items = reviewed
            .items
            .iter()
            .map(|preview| AdoptionBatchItem {
                source: preview.source.clone(),
                port_id: preview.selected_port_id.clone().unwrap_or_default(),
            })
            .collect::<Vec<_>>();
        if reviewed_items != items || batch_fingerprint(&reviewed.items)? != reviewed.batch_sha256 {
            return Err(PortcoveError::conflict(
                "the reviewed adoption batch does not match these items; review it again",
            ));
        }
        self.library.consume_authorization(
            authorization_token,
            BATCH_ACTION,
            &batch_target(items)?,
            &reviewed.batch_sha256,
        )?;
        let results = reviewed
            .items
            .iter()
            .zip(items)
            .map(|(preview, item)| self.adopt_batch_item(item, preview))
            .collect();
        Ok(AdoptionBatchResult {
            batch_sha256: reviewed.batch_sha256.clone(),
            items: results,
        })
    }

    fn adopt_batch_item(
        &self,
        item: &AdoptionBatchItem,
        reviewed: &AdoptionPreview,
    ) -> AdoptionBatchItemResult {
        let result = |outcome, install, message: Option<String>| AdoptionBatchItemResult {
            source: item.source.clone(),
            port_id: item.port_id.clone(),
            outcome,
            install,
            message,
        };
        match self.preview_adoption(&item.source, Some(&item.port_id)) {
            Ok(current) if current.plan_sha256 == reviewed.plan_sha256 => {}
            Ok(_) => {
                return result(
                    AdoptionBatchItemOutcome::Changed,
                    None,
                    Some("The folder or its destination changed after review; nothing was copied. Review it again.".into()),
                );
            }
            Err(error) => {
                return result(AdoptionBatchItemOutcome::Failed, None, Some(error.message));
            }
        }
        // The batch consent covers this reviewed plan; the ordinary adoption still
        // rechecks it under the port lock before copying.
        let copied = self
            .authorize_adoption(&item.source, Some(&item.port_id), &reviewed.plan_sha256)
            .and_then(|authorization| {
                self.adopt(&item.source, Some(&item.port_id), &authorization.token)
            });
        match copied {
            Ok(install) => result(AdoptionBatchItemOutcome::Copied, Some(install), None),
            Err(error) => result(AdoptionBatchItemOutcome::Failed, None, Some(error.message)),
        }
    }
}

fn validate_batch(items: &[AdoptionBatchItem]) -> Result<()> {
    if items.is_empty() {
        return Err(PortcoveError::usage(
            "choose at least one installation to copy",
        ));
    }
    if items.len() > ADOPTION_BATCH_LIMIT {
        return Err(PortcoveError::usage(format!(
            "a copy batch holds at most {ADOPTION_BATCH_LIMIT} installations"
        )));
    }
    let mut sources = std::collections::BTreeSet::new();
    let mut ports = std::collections::BTreeSet::new();
    for item in items {
        if !sources.insert(&item.source) {
            return Err(PortcoveError::conflict(format!(
                "{} appears more than once in the batch",
                item.source.display()
            )));
        }
        // A second copy of one port would replace the first copy's activation.
        if !ports.insert(&item.port_id) {
            return Err(PortcoveError::conflict(format!(
                "{} appears more than once in the batch; copy one installation per game",
                item.port_id
            )));
        }
    }
    Ok(())
}

fn batch_target(items: &[AdoptionBatchItem]) -> Result<String> {
    items
        .iter()
        .map(|item| adoption_authorization_target(&item.source, Some(&item.port_id)))
        .collect::<Result<Vec<_>>>()
        .map(|targets| targets.join("\n--\n"))
}

fn batch_fingerprint(previews: &[AdoptionPreview]) -> Result<String> {
    let bound = previews
        .iter()
        .map(|preview| {
            (
                &preview.source,
                &preview.selected_port_id,
                &preview.plan_sha256,
            )
        })
        .collect::<Vec<_>>();
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&bound)?)))
}

#[cfg(test)]
#[path = "adoption_batch_tests.rs"]
mod tests;
