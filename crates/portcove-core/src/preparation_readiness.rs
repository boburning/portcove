//! Preparation eligibility and launch validation share the registered core state.
use super::{RECEIPT_FILE, execution::PreparationReceipt};
use crate::{
    AdapterKind, InstallRecord, Installer, Platform, PortDefinition, PortcoveError,
    PortcoveService, Result, SourceRecord,
};

pub(crate) fn managed(port: &PortDefinition) -> bool {
    matches!(
        port.adapter,
        AdapterKind::UpstreamManagedSetup | AdapterKind::LibultrashipPortable
    ) && !port.setup_output_paths.is_empty()
}

/// Which original a receipt check compares. Launch of a self-contained
/// installation does not consult the original at all.
#[derive(Clone, Copy)]
pub(crate) enum ReceiptSource<'a> {
    Original(Option<&'a SourceRecord>),
    NotConsulted,
}

impl<'a> From<Option<&'a SourceRecord>> for ReceiptSource<'a> {
    fn from(source: Option<&'a SourceRecord>) -> Self {
        Self::Original(source)
    }
}

impl<'a> ReceiptSource<'a> {
    /// The consulted original, if any.
    pub(crate) fn original(self) -> Option<&'a SourceRecord> {
        match self {
            Self::Original(source) => source,
            Self::NotConsulted => None,
        }
    }

    /// True when the original was not consulted, or matches `expected`.
    pub(crate) fn matches(self, expected: impl Fn(&SourceRecord) -> bool) -> bool {
        match self {
            Self::NotConsulted => true,
            Self::Original(source) => source.is_some_and(expected),
        }
    }
}

/// Owner decision on #966: when installed, manifest-covered data already
/// holds every game input, the registered original is needed only to repair,
/// rebuild or prepare again, so launch neither requires nor reads it. This
/// covers sealed source-only preparations, prepared upstream/Libultraship
/// outputs, managed PS1 raw sets (the BIOS is still read at launch) and
/// retained cartridge builds.
pub(crate) fn self_contained_launch(
    library: &crate::Library,
    port: &PortDefinition,
    install: &InstallRecord,
) -> Result<bool> {
    if port.adapter == AdapterKind::PsxRecompManaged {
        return Ok(port.runtime_source_materialization
            == Some(crate::RuntimeSourceMaterialization::PsxRawSet));
    }
    let installer = Installer::new(library.clone())?;
    if super::source::eligible(port) {
        return Ok(installer.retained_preparation_mode(install)?
            == Some(super::PreparationMode::SourceOnly));
    }
    if managed(port) && managed_mode(port, install) == Some(super::PreparationMode::Default) {
        return Ok(true);
    }
    Ok(!port.release.managed_build.is_empty()
        && installer
            .read_verified_member(install, crate::cartridge_build::RECEIPT, 1024 * 1024)
            .is_ok())
}

pub(crate) fn managed_install(port: &PortDefinition, install: &InstallRecord) -> bool {
    managed_mode(port, install).is_some()
}

pub(crate) fn managed_mode(
    port: &PortDefinition,
    install: &InstallRecord,
) -> Option<super::PreparationMode> {
    if super::source::eligible(port) {
        Some(super::PreparationMode::SourceOnly)
    } else if port.id == "ghostship"
        && install.version == "2.0.0"
        && matches!(Platform::current(), Ok(Platform::WindowsX86_64))
    {
        Some(super::PreparationMode::Ghostship200Legacy)
    } else {
        managed(port).then_some(super::PreparationMode::Default)
    }
}

impl PortcoveService {
    pub(crate) fn validate_preparation_receipt<'a>(
        &self,
        port: &PortDefinition,
        install: &InstallRecord,
        source: impl Into<ReceiptSource<'a>>,
    ) -> Result<()> {
        let source = source.into();
        if !managed_install(port, install) {
            return Ok(());
        }
        let catalog = self.installed_catalog(install)?;
        if super::source::eligible(port) {
            return super::source::validate(self.library(), &catalog, port, install, source, None);
        }
        self.validate_preparation_receipt_in_retained_catalog(&catalog, install, source, None)
    }

    /// Content interpretation only. The caller must establish the registered
    /// root or exact journal-owned staging location before supplying its catalog.
    pub(crate) fn validate_preparation_receipt_in_retained_catalog<'a>(
        &self,
        catalog: &crate::Catalog,
        install: &InstallRecord,
        source: impl Into<ReceiptSource<'a>>,
        expected_plan: Option<&super::PreparationPlan>,
    ) -> Result<()> {
        let source = source.into();
        let port = catalog.port(&install.port_id)?;
        if super::source::eligible(port) {
            return super::source::validate(
                self.library(),
                catalog,
                port,
                install,
                source,
                expected_plan,
            );
        }
        let legacy = port.id == "ghostship"
            && install.version == "2.0.0"
            && matches!(Platform::current(), Ok(Platform::WindowsX86_64));
        if !managed(port) && !legacy {
            return Ok(());
        }
        if legacy {
            super::require_legacy_runtime_path(
                &self.library().user_dir("ghostship").join("sm64.o2r"),
            )?;
        }
        let installer = Installer::new(self.library().clone())?;
        if legacy
            && installer.retained_preparation_mode(install)?
                != Some(super::PreparationMode::Ghostship200Legacy)
        {
            return Err(PortcoveError::conflict(
                "review and run the exact Ghostship 2.0.0 legacy preparation before launch",
            ));
        }
        let working = crate::adapter::launch_working_directory(
            port,
            &install.path,
            &install.path.join(&install.selected_executable),
            Platform::current()?,
        )?;
        let marker = if legacy {
            super::ghostship::GENERATED
        } else {
            port.setup_marker
                .as_deref()
                .ok_or_else(|| PortcoveError::state("preparation has no output marker"))?
        };
        // A manually created marker cannot establish readiness. Both legacy and
        // new prepared installations must have admitted this exact output.
        let generated = if legacy {
            super::ghostship::generated_path(&working)
        } else {
            working.join(marker)
        };
        installer.verify_recorded_member(install, &generated)?;
        let bytes = match installer.read_verified_member(install, RECEIPT_FILE, 1024 * 1024) {
            Ok(bytes) => bytes,
            Err(error) if error.code == crate::ErrorCode::NotFound && !legacy => {
                return crate::adapter::validate_completed_legacy_setup(
                    port,
                    install,
                    &working,
                    source.original(),
                );
            }
            Err(error) => return Err(error),
        };
        let receipt: PreparationReceipt = serde_json::from_slice(&bytes)?;
        if let Some(plan) = expected_plan
            && (receipt.format_version != plan.format_version
                || receipt.plan_sha256 != plan.plan_sha256
                || serde_json::to_value(&receipt.inputs)? != serde_json::to_value(&plan.inputs)?)
        {
            return Err(PortcoveError::verification(
                "staged preparation receipt differs from its reviewed journal plan",
            ));
        }
        let profile = port
            .source_profile
            .as_deref()
            .ok_or_else(|| PortcoveError::state("preparation has no source profile"))?;
        let definition = crate::signed_catalog::digest(&serde_json::to_vec(&(
            port,
            catalog.source_profile(profile)?,
        ))?);
        let inputs = &receipt.inputs;
        let source_matches = source.matches(|source| {
            source.profile_id == inputs.source.profile_id
                && source.path == inputs.source.path
                && source.sha256 == inputs.source.sha256
                && source.size == inputs.source.size
                && source.storage_sha256 == inputs.source.storage_sha256
                && source.storage_size == inputs.source.storage_size
        });
        if receipt.format_version != if legacy { 2 } else { 1 }
            || inputs.setup_tool.is_none()
            || inputs.definition_sha256 != definition
            || inputs.install.artifact != install.artifact
            || inputs.install.runtime != install.runtime
            || inputs.install.version != install.version
            || inputs.host != Platform::current()?
            || inputs.options.target != inputs.host
            || inputs.options.mode
                != if legacy {
                    super::PreparationMode::Ghostship200Legacy
                } else {
                    super::PreparationMode::Default
                }
            || !source_matches
        {
            return Err(PortcoveError::conflict(
                "prepared inputs changed; review and prepare game data again",
            ));
        }
        if legacy {
            let (sha256, size) = crate::external_runtime::hash_stable_regular(
                &install.path.join(&install.selected_executable),
                11_533_312,
                &|| Ok(()),
            )?;
            if sha256 != super::ghostship::EXECUTABLE_SHA256 || size != 11_533_312 {
                return Err(PortcoveError::verification(
                    "legacy prepared executable differs from the reviewed official tool",
                ));
            }
            super::ghostship::execution_contract(port, &inputs.install, inputs.host)?;
            super::ghostship::require_source(&inputs.source)?;
            if inputs.setup_tool.as_ref().is_none_or(|tool| {
                tool.sha256 != super::ghostship::EXECUTABLE_SHA256 || tool.size != 11_533_312
            }) || inputs.conversion_tool.is_some()
            {
                return Err(PortcoveError::verification(
                    "legacy preparation receipt has an unreviewed setup tool",
                ));
            }
        }
        Ok(())
    }
}
