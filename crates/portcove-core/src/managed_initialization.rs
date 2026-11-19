//! Dispatch closed preparation recipes without extending another game's authority.
use crate::{ArtifactIdentity, Platform, PortDefinition, Result};
use std::path::Path;

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    if crate::managed_chocolate::applies(port) {
        crate::managed_chocolate::validate(port)
    } else {
        crate::managed_tfe::validate(port)
    }
}

pub(crate) fn require_artifact(
    port: &PortDefinition,
    version: &str,
    artifact: &ArtifactIdentity,
    platform: Option<Platform>,
) -> Result<()> {
    if crate::managed_chocolate::applies(port) {
        validate(port)?;
        crate::managed_runtime_policy::require_artifact(port, version, artifact, platform)
    } else {
        crate::managed_tfe::require_artifact(port, version, artifact, platform)
    }
}

pub(crate) fn refuse_adoption(port: &PortDefinition) -> Result<()> {
    if crate::managed_chocolate::applies(port) {
        return Err(crate::PortcoveError::unsupported(
            "this profile requires its verified official package; install it through Portcove instead of copying a runtime folder",
        ));
    }
    crate::managed_tfe::refuse_adoption(port)
}

pub(crate) fn check(
    port: &PortDefinition,
    root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    if crate::managed_chocolate::applies(port) {
        crate::managed_chocolate::check(port, root, checkpoint)
    } else {
        crate::managed_tfe::check(port, root, checkpoint)
    }
}

pub(crate) fn prepare(
    port: &PortDefinition,
    root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    if crate::managed_chocolate::applies(port) {
        crate::managed_chocolate::prepare(port, root, checkpoint)
    } else if port.managed_initialization.is_some() {
        crate::managed_tfe::prepare(root, checkpoint)
    } else {
        Ok(())
    }
}
