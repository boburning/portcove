//! Explicit initial-anchor policy selected by trusted ceremony/context configuration.
//! Never infer a lower threshold from downloaded or candidate Root metadata.

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InitialRootProfile {
    #[default]
    LegacyTwoOfThreeV1,
    SingleOwnerOneOfOneV1,
}

impl InitialRootProfile {
    pub(crate) fn root_keys(self) -> usize {
        match self {
            Self::LegacyTwoOfThreeV1 => 3,
            Self::SingleOwnerOneOfOneV1 => 1,
        }
    }

    pub(crate) fn threshold(self) -> u64 {
        match self {
            Self::LegacyTwoOfThreeV1 => 2,
            Self::SingleOwnerOneOfOneV1 => 1,
        }
    }
}
