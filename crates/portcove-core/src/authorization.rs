use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{PortcoveError, Result};

const AUTHORIZATION_LIFETIME: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone)]
pub(crate) struct AuthorizationStore {
    grants: Arc<Mutex<HashMap<String, AuthorizationGrant>>>,
    lifetime: Duration,
}

#[derive(Debug)]
struct AuthorizationGrant {
    action: String,
    target: String,
    fingerprint: String,
    expires_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DestructiveAuthorization {
    pub token: String,
    pub expires_at: i64,
}

impl Default for AuthorizationStore {
    fn default() -> Self {
        Self {
            grants: Arc::new(Mutex::new(HashMap::new())),
            lifetime: AUTHORIZATION_LIFETIME,
        }
    }
}

impl AuthorizationStore {
    pub fn issue(
        &self,
        action: &str,
        target: &str,
        fingerprint: &str,
    ) -> Result<DestructiveAuthorization> {
        let token = Uuid::new_v4().to_string();
        let expires_at = Instant::now() + self.lifetime;
        let unix_expiry = SystemTime::now()
            .checked_add(self.lifetime)
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs() as i64)
            .ok_or_else(|| PortcoveError::state("could not calculate authorization expiry"))?;
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| PortcoveError::state("destructive authorization store is unavailable"))?;
        let now = Instant::now();
        grants.retain(|_, grant| grant.expires_at > now);
        grants.insert(
            token.clone(),
            AuthorizationGrant {
                action: action.to_owned(),
                target: target.to_owned(),
                fingerprint: fingerprint.to_owned(),
                expires_at,
            },
        );
        Ok(DestructiveAuthorization {
            token,
            expires_at: unix_expiry,
        })
    }

    pub fn consume(
        &self,
        token: &str,
        action: &str,
        target: &str,
        fingerprint: &str,
    ) -> Result<()> {
        self.consume_with_state(token, action, target, || Ok(fingerprint.to_owned()))
    }

    pub fn consume_with_state(
        &self,
        token: &str,
        action: &str,
        target: &str,
        current_fingerprint: impl FnOnce() -> Result<String>,
    ) -> Result<()> {
        let grant = self
            .grants
            .lock()
            .map_err(|_| PortcoveError::state("destructive authorization store is unavailable"))?
            .remove(token)
            .ok_or_else(|| {
                PortcoveError::conflict(
                    "destructive authorization is missing, expired, or was already used",
                )
            })?;
        if Instant::now() >= grant.expires_at {
            return Err(PortcoveError::conflict(
                "destructive authorization expired; review the operation again",
            ));
        }
        if grant.action != action || grant.target != target {
            return Err(PortcoveError::conflict(
                "destructive authorization does not match this operation",
            ));
        }
        if grant.fingerprint != current_fingerprint()? {
            return Err(PortcoveError::conflict(
                "destructive operation state changed after authorization; review it again",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorizations_are_single_use_and_bound_to_action_target_and_state() {
        let store = AuthorizationStore::default();
        let replay = store.issue("remove", "port-a", "state-a").unwrap();
        store
            .consume(&replay.token, "remove", "port-a", "state-a")
            .unwrap();
        assert!(
            store
                .consume(&replay.token, "remove", "port-a", "state-a")
                .unwrap_err()
                .message
                .contains("already used")
        );

        let mismatch = store.issue("remove", "port-a", "state-a").unwrap();
        assert!(
            store
                .consume(&mismatch.token, "restore", "port-a", "state-a")
                .unwrap_err()
                .message
                .contains("does not match")
        );

        let changed = store.issue("remove", "port-a", "state-a").unwrap();
        assert!(
            store
                .consume(&changed.token, "remove", "port-a", "state-b")
                .unwrap_err()
                .message
                .contains("state changed")
        );
    }

    #[test]
    fn expired_authorizations_fail_closed() {
        let store = AuthorizationStore {
            grants: Arc::new(Mutex::new(HashMap::new())),
            lifetime: Duration::ZERO,
        };
        let authorization = store.issue("remove", "port-a", "state-a").unwrap();
        assert!(
            store
                .consume(&authorization.token, "remove", "port-a", "state-a")
                .unwrap_err()
                .message
                .contains("expired")
        );
        let authorization = store.issue("restore", "port-a", "state-a").unwrap();
        let mut reviewed = false;
        assert!(
            store
                .consume_with_state(&authorization.token, "restore", "port-a", || {
                    reviewed = true;
                    Ok("state-a".into())
                })
                .is_err()
        );
        assert!(
            !reviewed,
            "expired admission must not collect or hash live data"
        );
    }

    #[test]
    fn authorization_admits_once_before_expensive_state_validation() {
        let store = AuthorizationStore::default();
        let authorization = store.issue("restore", "port-a", "reviewed").unwrap();
        let error = store
            .consume_with_state(&authorization.token, "restore", "port-a", || {
                assert!(
                    store
                        .consume(&authorization.token, "restore", "port-a", "reviewed")
                        .is_err()
                );
                Ok("changed during review".into())
            })
            .unwrap_err();
        assert!(error.message.contains("state changed"));
        assert!(
            store
                .consume(&authorization.token, "restore", "port-a", "reviewed")
                .is_err()
        );
    }
}
