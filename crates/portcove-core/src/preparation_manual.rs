//! Upstream-owned manual progress is an observation, never a Core source receipt.
use std::path::{Component, Path};

use crate::{AdapterKind, InstallRecord, PortDefinition, PortcoveError, Result};

pub(crate) fn has_manual_marker(port: &PortDefinition) -> bool {
    port.adapter == AdapterKind::NativePortable && port.setup_marker.is_some()
}

pub(crate) fn validate_manual_marker(port: &PortDefinition) -> Result<()> {
    let marker = port
        .setup_marker
        .as_deref()
        .ok_or_else(|| PortcoveError::usage("manual setup needs a completion record"))?;
    let path = Path::new(marker);
    if marker.is_empty()
        || marker.contains('\\')
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        || path.extension().is_none_or(|extension| extension != "json")
        || !port.persistent_paths.iter().any(|owned| {
            let owned = Path::new(owned);
            path != owned && path.starts_with(owned)
        })
        || !port.setup_executable_hints.is_empty()
        || !port.setup_arguments.is_empty()
        || !port.setup_output_paths.is_empty()
    {
        return Err(PortcoveError::usage(
            "manual setup requires a JSON completion record beneath declared player data and no managed helper",
        ));
    }
    Ok(())
}

/// Bounded structural progress only. The upstream runtime still validates its
/// edition, data format and actual game files. Never run a discovered helper.
pub(crate) fn require_manual_setup(port: &PortDefinition, install: &InstallRecord) -> Result<()> {
    if !has_manual_marker(port) {
        return Ok(());
    }
    validate_manual_marker(port)?;
    let marker = crate::runtime::working_root(port, install)
        .join(port.setup_marker.as_ref().expect("validated manual marker"));
    let ready = crate::external_runtime::read_single_link_metadata(&marker, 64 * 1024)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|record| record.is_object());
    if !ready {
        return Err(PortcoveError::conflict(
            "Finish the game-file setup in the installed folder, then check setup again before playing. The upstream completion record is missing, unreadable or incomplete.",
        )
        .detail("path", marker.display().to_string()));
    }
    Ok(())
}
