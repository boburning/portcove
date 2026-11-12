//! Shared classification of operating-system secure-store failures. Each
//! credential owner keeps its own entry; this only explains a store that is
//! missing or locked, where no credential could have been read or changed.

use crate::{PortcoveError, failure::KnownFailureCause, failure::MutationState};

/// `side_effect_free` is true only for owners whose callers have changed nothing
/// durable before the store is reached; otherwise the mutation state stays as
/// the caller's recovery records it.
pub(crate) fn store_error(
    subject: &str,
    action: &str,
    error: keyring::Error,
    side_effect_free: bool,
) -> PortcoveError {
    let cause = match &error {
        keyring::Error::NoDefaultStore => Some(KnownFailureCause::CredentialStoreUnavailable),
        keyring::Error::NoStorageAccess(_) => Some(KnownFailureCause::CredentialStoreLocked),
        _ => None,
    };
    let error = PortcoveError::state(format!(
        "could not {action} the {subject} in operating-system secure storage: {error}"
    ));
    match cause {
        Some(cause) if side_effect_free => error
            .with_known_cause(cause)
            .with_mutation_state(MutationState::NoChanges),
        Some(cause) => error.with_known_cause(cause),
        None => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_locked_stores_explain_that_nothing_changed() {
        for (error, key) in [
            (
                keyring::Error::NoDefaultStore,
                "credential_store_unavailable",
            ),
            (
                keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("locked"))),
                "credential_store_locked",
            ),
        ] {
            let presentation = store_error("test key", "read", error, true).presentation();
            assert_eq!(presentation.presentation_key, key);
            assert_eq!(presentation.mutation_state, MutationState::NoChanges);
            assert!(
                !presentation
                    .recovery_actions
                    .contains(&crate::failure::RecoveryAction::ReviewCurrentState)
            );
        }
        // Import and move reach the portability key after copying files: the
        // cause is explained but the state and review step are kept.
        let during_transfer = store_error(
            "portability authority",
            "read",
            keyring::Error::NoDefaultStore,
            false,
        )
        .presentation();
        assert_eq!(
            during_transfer.presentation_key,
            "credential_store_unavailable"
        );
        assert_eq!(during_transfer.mutation_state, MutationState::Unknown);
        assert!(
            during_transfer
                .recovery_actions
                .contains(&crate::failure::RecoveryAction::ReviewCurrentState)
        );
        let other = store_error(
            "test key",
            "write",
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other("failed"))),
            true,
        )
        .presentation();
        assert_eq!(other.presentation_key, "state_unavailable");
        assert_eq!(other.mutation_state, MutationState::Unknown);
    }
}
