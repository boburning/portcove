//! Explicit delivery and reviewed publication; startup never fetches a catalog.
use std::{path::PathBuf, time::Duration};

use futures_util::StreamExt;
use rusqlite::params;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ActivityOperation, ActivityStatus, ActivityTargetKind, CatalogProvenance, CatalogStatus,
    Library, OperationCoordinator, OperationEvent, OperationResult, PortcoveError, PortcoveService,
    Result,
    catalog_store::CatalogState,
    signed_catalog::{self, MAX_CATALOG_BYTES, VerifiedCatalog},
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum CatalogUpdateSource {
    File(PathBuf),
    Https(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogUpdatePlan {
    pub source: CatalogUpdateSource,
    pub envelope_sha256: String,
    pub key_id: String,
    pub sequence: i64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub changed_port_ids: Vec<String>,
    pub current: CatalogProvenance,
    pub plan_sha256: String,
}

impl PortcoveService {
    pub async fn plan_catalog_update(
        &self,
        source: &CatalogUpdateSource,
    ) -> Result<CatalogUpdatePlan> {
        let bytes = read_candidate(source).await?;
        let state = CatalogState::read(&self.library().connection()?)?;
        plan(source, &bytes, &state, Library::now())
    }

    pub async fn apply_catalog_update(
        &self,
        source: &CatalogUpdateSource,
        expected_plan: &str,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<CatalogStatus> {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::UpdateCatalog,
            ActivityTargetKind::Library,
            None,
        )?;
        emit(operation.started());
        let result = async {
            let bytes = operation.interruptible(read_candidate(source)).await?;
            // Seal before acquiring SQLite's publication transaction. A cancellation which
            // already won is honored; a later request cannot interrupt the atomic commit.
            operation.begin_publication()?;
            self.library()
                .publish_catalog(source, &bytes, expected_plan, &operation)
        }
        .await;
        let result = match result {
            Ok(status) => Ok(status), // publication and the terminal ledger row committed together
            Err(error) => self.finish_activity(activity, Err(error)),
        };
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }
}

impl Library {
    fn publish_catalog(
        &self,
        source: &CatalogUpdateSource,
        bytes: &[u8],
        expected: &str,
        operation: &OperationCoordinator,
    ) -> Result<CatalogStatus> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let state = CatalogState::read(&tx)?;
        let now = Self::now();
        let reviewed = plan(source, bytes, &state, now)?;
        if reviewed.plan_sha256 != expected {
            return Err(PortcoveError::conflict(
                "catalog candidate or trust changed; review the update again",
            ));
        }
        let previous = if state.enabled {
            [&state.active, &state.previous]
                .into_iter()
                .flatten()
                .find(|bytes| {
                    signed_catalog::verify(bytes, &state.keys, now)
                        .is_ok_and(|value| value.payload.sequence <= state.highest_sequence)
                })
        } else {
            None
        };
        tx.execute("UPDATE catalog_state SET revision=revision+1,highest_sequence=?1,active=?2,previous=?3,enabled=1 WHERE singleton=1",
            params![reviewed.sequence, bytes, previous])?;
        Library::finish_activity_on(
            &tx,
            operation.operation_id(),
            ActivityStatus::Succeeded,
            None,
        )?;
        let result = CatalogState::read(&tx)?.status(now)?;
        tx.commit()?;
        Ok(result)
    }
}

fn plan(
    source: &CatalogUpdateSource,
    bytes: &[u8],
    state: &CatalogState,
    now: i64,
) -> Result<CatalogUpdatePlan> {
    let verified = signed_catalog::verify(bytes, &state.keys, now)?;
    if verified.payload.sequence <= state.highest_sequence {
        return Err(PortcoveError::verification(
            "catalog sequence has already been seen; replay or downgrade rejected",
        ));
    }
    let (current_catalog, current) = state.resolve(now)?;
    let changed_port_ids = verified
        .catalog
        .ports()
        .iter()
        .filter_map(|port| {
            let changed = current_catalog.port(&port.id).ok().is_none_or(|original| {
                serde_json::to_value(original).ok() != serde_json::to_value(port).ok()
            });
            changed.then(|| port.id.clone())
        })
        .collect();
    let envelope_sha256 = signed_catalog::digest(bytes);
    let plan_sha256 = signed_catalog::digest(&serde_json::to_vec(&(
        source,
        &envelope_sha256,
        state.fingerprint()?,
    ))?);
    let VerifiedCatalog {
        envelope, payload, ..
    } = verified;
    Ok(CatalogUpdatePlan {
        source: source.clone(),
        envelope_sha256,
        key_id: envelope.key_id,
        sequence: payload.sequence,
        issued_at: payload.issued_at,
        expires_at: payload.expires_at,
        changed_port_ids,
        current,
        plan_sha256,
    })
}

async fn read_candidate(source: &CatalogUpdateSource) -> Result<Vec<u8>> {
    match source {
        CatalogUpdateSource::File(path) => {
            crate::path::read_bounded_regular(path, MAX_CATALOG_BYTES as u64)
        }
        CatalogUpdateSource::Https(url) => {
            let url = reqwest::Url::parse(url)
                .map_err(|_| PortcoveError::usage("invalid catalog HTTPS URL"))?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(PortcoveError::usage(
                    "catalog delivery requires HTTPS without userinfo or a fragment",
                ));
            }
            // No credential provider, cookies, default authorization or cross-origin redirects.
            let client = reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .user_agent("Portcove signed catalog/1")
                .build()
                .map_err(|_| PortcoveError::network("could not initialize catalog HTTPS client"))?;
            let response = client
                .get(url)
                .send()
                .await
                .map_err(|_| PortcoveError::network("could not download signed catalog"))?;
            if !response.status().is_success() {
                return Err(PortcoveError::network(format!(
                    "catalog server returned HTTP {}",
                    response.status()
                )));
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_CATALOG_BYTES as u64)
            {
                return Err(PortcoveError::verification(
                    "signed catalog exceeds the 4 MiB limit",
                ));
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    PortcoveError::network("signed catalog download was interrupted")
                })?;
                if chunk.len() > MAX_CATALOG_BYTES - bytes.len() {
                    return Err(PortcoveError::verification(
                        "signed catalog exceeds the 4 MiB limit",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        }
    }
}

#[cfg(test)]
#[path = "signed_catalog_tests.rs"]
mod tests;
