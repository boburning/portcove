//! Exact, read-only plans for the existing upstream-managed setup family.
#[path = "preparation_execution.rs"]
mod execution;
pub(crate) use execution::recover;
pub(crate) const RECEIPT_FILE: &str = ".portcove-preparation.json";
use std::path::PathBuf;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AdapterKind, AdoptionCopyPlan, ChildProcessClass, ChildProcessPolicy, InstallQualification,
    InstallRecord, Installer, Platform, PortcoveError, PortcoveService, Result,
    SourceInspectionReport, SourceRecord,
};

/// This family currently exposes the catalog's reviewed defaults only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreparationMode {
    #[default]
    Default,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PreparationOptions {
    pub target: Platform,
    #[serde(default)]
    pub mode: PreparationMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PreparationTool {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PreparationInputs {
    pub install: InstallRecord,
    /// Binds the admitted port and source definitions; hashing does not admit a definition.
    pub definition_sha256: String,
    pub source: SourceRecord,
    pub source_inspection: SourceInspectionReport,
    pub setup_tool: PreparationTool,
    pub conversion_tool: Option<PreparationTool>,
    pub host: Platform,
    pub options: PreparationOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PreparationPlan {
    pub format_version: u32,
    pub port_id: String,
    pub inputs: PreparationInputs,
    /// A copy identity, checked only after the existing install trust checks pass.
    pub copy: AdoptionCopyPlan,
    pub plan_sha256: String,
}

impl PortcoveService {
    /// Inspect installed inputs without acquiring software, starting setup, or changing readiness.
    pub fn plan_preparation(
        &self,
        port_id: &str,
        options: PreparationOptions,
    ) -> Result<PreparationPlan> {
        let _guard = self.library().try_lock_port(port_id, "plan-preparation")?;
        self.plan_preparation_locked(port_id, options)
    }

    pub(crate) fn plan_preparation_locked(
        &self,
        port_id: &str,
        options: PreparationOptions,
    ) -> Result<PreparationPlan> {
        let port = self.catalog().port(port_id)?;
        let host = Platform::current()?;
        if port.adapter != AdapterKind::UpstreamManagedSetup {
            return Err(PortcoveError::unsupported(
                "this port has no managed preparation operation",
            )
            .detail("port_id", port_id));
        }
        if port.setup_output_paths.is_empty() {
            return Err(PortcoveError::unsupported(
                "this definition has no reviewed managed preparation output contract",
            ));
        }
        if options.target != host || !port.platforms.contains(&host) {
            return Err(PortcoveError::unsupported(
                "managed preparation requires an available artifact for this host; target selection does not enable cross-compilation",
            ));
        }
        let install = self.status(port_id)?.active.ok_or_else(|| {
            PortcoveError::not_found("install this port before preparing its source")
                .detail("port_id", port_id)
        })?;
        crate::output_root::validate_install_path(self.library(), port_id, &install.path)?;
        let qualification = InstallQualification::from_port(port, host)?;
        let installer = Installer::new(self.library().clone())?;
        let selected = installer.verify_critical(&install, &qualification)?;
        let working =
            crate::adapter::launch_working_directory(port.adapter, port, &install.path, &selected)?;
        if working != install.path {
            return Err(PortcoveError::unsupported(
                "managed preparation currently requires an install-root working directory",
            ));
        }
        if !installer.verify_managed(&install, &qualification)?.valid {
            return Err(PortcoveError::verification(
                "installed setup inputs do not match their admitted manifest; repair the installation before preparation",
            ));
        }
        crate::runtime::require_ready(port, host, &install)?;
        let profile_id = port
            .source_profile
            .as_deref()
            .ok_or_else(|| PortcoveError::state("managed preparation has no source contract"))?;
        let source = self.library().source(profile_id)?.ok_or_else(|| {
            PortcoveError::source("register the required source before preparation")
                .detail("profile_id", profile_id)
        })?;
        self.verify_source_record(&source)?;
        let source_inspection = self.inspect_registered_source(profile_id)?;
        let hints = port.setup_executable_hints.get(&host).ok_or_else(|| {
            PortcoveError::unsupported("this host has no declared setup executable")
        })?;
        let setup =
            crate::install::resolve_executable_hints(&working, host, hints, "setup executable")?;
        let setup_tool = tool_identity(setup, ChildProcessClass::UpstreamSetup)?;
        let conversion_tool = if source
            .path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("chd"))
        {
            Some(tool_identity(
                crate::adapter::resolve_chdman()?,
                ChildProcessClass::HostTool,
            )?)
        } else {
            None
        };
        let definition_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
            port,
            self.catalog().source_profile(profile_id)?,
        ))?);
        let copy = crate::library_transfer::reviewed_tree(&install.path)?;
        let mut plan = PreparationPlan {
            format_version: 1,
            port_id: port_id.into(),
            inputs: PreparationInputs {
                install,
                definition_sha256,
                source,
                source_inspection,
                setup_tool,
                conversion_tool,
                host,
                options,
            },
            copy,
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&plan)?);
        Ok(plan)
    }
}

fn tool_identity(path: PathBuf, class: ChildProcessClass) -> Result<PreparationTool> {
    crate::path::refuse_symlink_ancestors(&path)?;
    let _command = ChildProcessPolicy::native_command(class, &path)?;
    let (sha256, size) = crate::adapter::hash_file(&path)?;
    Ok(PreparationTool { path, sha256, size })
}

pub(crate) fn validate_output_contract(port: &crate::PortDefinition) -> Result<()> {
    let generated_metadata = crate::adapter::generated_metadata(port)?;
    for (index, output) in port.setup_output_paths.iter().enumerate() {
        crate::archive::validate_relative_path(output, true)?;
        let overlaps = |other: &String| crate::runtime::overlaps(output, other);
        if crate::path::is_portcove_metadata(std::path::Path::new(output))
            || generated_metadata.iter().any(overlaps)
            || port.setup_output_paths[..index].iter().any(overlaps)
            || port.persistent_paths.iter().any(overlaps)
            || port.runtime_mutable_paths.iter().any(overlaps)
            || port.runtime_source_filename.iter().any(overlaps)
            || port
                .bundled_runtime
                .values()
                .any(|runtime| overlaps(&runtime.target_directory))
            || port
                .executable_hints
                .values()
                .chain(port.setup_executable_hints.values())
                .flatten()
                .any(overlaps)
        {
            return Err(PortcoveError::usage(
                "setup output paths overlap another ownership contract",
            )
            .detail("port_id", &port.id)
            .detail("path", output));
        }
    }
    if !port.setup_output_paths.is_empty()
        && !port.setup_marker.as_ref().is_some_and(|marker| {
            port.setup_output_paths
                .iter()
                .any(|output| std::path::Path::new(marker).starts_with(output))
        })
    {
        return Err(PortcoveError::usage(
            "setup marker must belong to a declared generated output path",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "preparation_tests.rs"]
mod tests;
