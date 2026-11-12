//! Shared classification of operating-system secure-store failures. Each
//! credential owner keeps its own entry; this only explains a store that is
//! missing or locked, where no credential could have been read or changed.

use crate::{PortcoveError, failure::KnownFailureCause, failure::MutationState};

pub(crate) fn store_error(subject: &str, action: &str, error: keyring::Error) -> PortcoveError {
    let cause = match &error {
        keyring::Error::NoDefaultStore => Some(KnownFailureCause::CredentialStoreUnavailable),
        keyring::Error::NoStorageAccess(_) => Some(KnownFailureCause::CredentialStoreLocked),
        _ => None,
    };
    let error = PortcoveError::state(format!(
        "could not {action} the {subject} in operating-system secure storage: {error}"
    ));
    match cause {
        Some(cause) => error
            .with_known_cause(cause)
            .with_mutation_state(MutationState::NoChanges),
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
            let presentation = store_error("test key", "read", error).presentation();
            assert_eq!(presentation.presentation_key, key);
            assert_eq!(presentation.mutation_state, MutationState::NoChanges);
            assert!(presentation.summary.contains("Nothing was changed"));
        }
        let other = store_error(
            "test key",
            "write",
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other("failed"))),
        )
        .presentation();
        assert_eq!(other.presentation_key, "state_unavailable");
        assert_eq!(other.mutation_state, MutationState::Unknown);
    }
}
