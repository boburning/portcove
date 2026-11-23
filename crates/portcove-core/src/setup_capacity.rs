//! The one supported-state contract for mod setups, recipes, drafts and
//! provider dependency closures.
//!
//! A setup is what one profile revision holds. Every stage that creates or
//! consumes one — draft review, provider closure staging, recipe export,
//! recipe acquisition and import, revision persistence, reload, deployment and
//! rollback — accepts the same shape, so a state one stage can create always
//! passes every later stage. No stage keeps a smaller count of its own.
//!
//! The retained bounds are resource budgets over one atomic unit of work, not
//! product ceilings on how a player composes a setup:
//!
//! - [`MAX_SETUP_PACKAGES`]: a revision is validated (identity uniqueness,
//!   dependency closure, provider requirement proofs, asset conflicts) and
//!   written in one transaction under the port lock. This bounds that one
//!   operation's work and memory. It is the same at every stage.
//! - [`MAX_SETUP_DOCUMENT_BYTES`]: one stored revision or profile record is
//!   parsed whole into memory on every reload; this is its parse budget. It is
//!   checked when the record is written, so a stored record always reloads.
//! - [`MAX_RECIPE_DOCUMENT_BYTES`]: a recipe file carries the same content as a
//!   revision plus each shared setting's exact package digest, so its parse
//!   budget has twice the revision budget. Import reviews whether the setup it
//!   would create fits [`MAX_SETUP_DOCUMENT_BYTES`] and says so before applying.
//!
//! Staging is bounded by the work in flight, not by a count: downloads and
//! extraction are budgeted per provider file, processed one file at a time,
//! and admitted only when the staging volume has room ([`require_staging_space`]).
use std::path::Path;

use crate::{PortcoveError, Result};

/// Distinct packages one setup may hold, at every stage.
pub const MAX_SETUP_PACKAGES: usize = 4096;
/// Parse budget for one stored revision or profile record.
pub const MAX_SETUP_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;
/// Parse budget for one recipe document (see the module documentation).
pub(crate) const MAX_RECIPE_DOCUMENT_BYTES: usize = 2 * MAX_SETUP_DOCUMENT_BYTES;
/// Free space kept on the staging volume after admitting staged bytes, so
/// staging never fills the volume that also holds the player's data.
const STAGING_RESERVE_BYTES: u64 = 256 * 1024 * 1024;

/// Admits `bytes` of new staging under `directory` only when its volume keeps
/// the reserve afterwards. The failure names what was needed and what is free.
pub(crate) fn require_staging_space(directory: &Path, bytes: u64) -> Result<()> {
    let mut probe = directory;
    while !probe.exists() {
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    let available = fs4::available_space(probe)?;
    let required = bytes.saturating_add(STAGING_RESERVE_BYTES);
    if required > available {
        return Err(PortcoveError::state(
            "there is not enough free space to stage these mod files",
        )
        .with_known_cause(crate::failure::KnownFailureCause::DestinationCapacity)
        .detail("required_bytes", required.to_string())
        .detail("available_bytes", available.to_string()));
    }
    Ok(())
}

/// Bytes that can still be staged under `directory` while keeping the reserve.
pub(crate) fn staging_allowance(directory: &Path) -> Result<u64> {
    Ok(fs4::available_space(directory)?.saturating_sub(STAGING_RESERVE_BYTES))
}

/// A human-readable size for player-facing bound messages.
pub(crate) fn mebibytes(bytes: usize) -> String {
    format!("{} MiB", bytes / (1024 * 1024))
}
