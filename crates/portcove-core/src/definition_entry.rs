//! Indexed entry inspection, separate from contract interpretation and admission.
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

use crate::{
    DefinitionCapabilityReport, DefinitionCapabilityRequest, DefinitionCapabilityRequirement,
    DefinitionContentIndex, PortDefinition, PortcoveError, Result, check_definition_capabilities,
};

use crate::definition_capabilities::{Feature, check_required_features, require_feature};

pub(crate) fn require_indexed_persistence(port: &PortDefinition) -> Result<()> {
    if port
        .persistent_file_patterns
        .iter()
        .any(|pattern| pattern.allow_empty_middle)
    {
        return Err(PortcoveError::unsupported(
            "empty-middle persistent file patterns are currently embedded-only",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryDocument {
    definition_schema: u32,
    namespace: String,
    stable_id: String,
    revision: u64,
    required_capabilities: Vec<DefinitionCapabilityRequirement>,
    #[serde(default, deserialize_with = "present")]
    required_features: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present")]
    advisory: Option<serde_json::Map<String, Value>>,
    port: Value,
    source_contracts: Vec<String>,
    execution_contract: String,
    persistence_contract: String,
    artifact_bindings: Vec<String>,
    evidence_references: Vec<String>,
}

// Explicit null is not omission, including on legacy schemas.
fn present<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Exact indexed bytes and a typed projection, not a usable catalog or trust grant.
#[derive(Debug)]
pub struct DefinitionEntryInspection {
    bytes: Vec<u8>,
    namespace: String,
    revision: u64,
    schema_version: u32,
    port: PortDefinition,
    capabilities: DefinitionCapabilityReport,
    required_features: Option<BTreeSet<Feature>>,
    source_contracts: Vec<String>,
    execution_contract: String,
    persistence_contract: String,
    artifact_bindings: Vec<String>,
    evidence_references: Vec<String>,
}

impl DefinitionEntryInspection {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    pub(crate) fn accepts_projection_schema(&self, schema: u32) -> bool {
        if self.schema_version == 4 {
            matches!(schema, 1..=4)
        } else {
            self.schema_version == schema
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn has_named_features(&self) -> bool {
        self.required_features.is_some()
    }

    /// Shape-checked data; existing catalog/contract validators still govern its use.
    pub fn port(&self) -> &PortDefinition {
        &self.port
    }

    pub fn capabilities(&self) -> &DefinitionCapabilityReport {
        &self.capabilities
    }

    pub(crate) fn supports_feature(
        &self,
        feature: Feature,
        template: &str,
        minimum: u32,
    ) -> Result<bool> {
        require_feature(self.required_features.as_ref(), feature)?;
        Ok(self.capabilities.checks.iter().any(|check| {
            check.requirement.template == template && check.requirement.minimum_version >= minimum
        }))
    }

    /// References retain their entry order and may share one indexed target.
    /// Callers must validate each referenced contract and the complete bounded graph.
    pub fn referenced_targets(&self) -> impl Iterator<Item = &str> {
        self.source_contracts
            .iter()
            .map(String::as_str)
            .chain([
                self.execution_contract.as_str(),
                self.persistence_contract.as_str(),
            ])
            .chain(self.artifact_bindings.iter().map(String::as_str))
            .chain(self.evidence_references.iter().map(String::as_str))
    }

    pub fn source_contracts(&self) -> &[String] {
        &self.source_contracts
    }

    pub fn execution_contract(&self) -> &str {
        &self.execution_contract
    }

    pub fn persistence_contract(&self) -> &str {
        &self.persistence_contract
    }

    pub fn artifact_bindings(&self) -> &[String] {
        &self.artifact_bindings
    }

    pub fn evidence_references(&self) -> &[String] {
        &self.evidence_references
    }
}

impl DefinitionContentIndex {
    /// Inspect exactly one indexed identity without changing any other entry.
    /// Neither success nor compatible capabilities establish operation eligibility.
    pub fn inspect_entry(
        &self,
        namespace: &str,
        stable_id: &str,
        bytes: &[u8],
    ) -> Result<DefinitionEntryInspection> {
        self.inspect_entry_mode(namespace, stable_id, bytes, false)
    }

    pub(crate) fn inspect_retained_entry(
        &self,
        namespace: &str,
        stable_id: &str,
        bytes: &[u8],
    ) -> Result<DefinitionEntryInspection> {
        self.inspect_entry_mode(namespace, stable_id, bytes, true)
    }

    fn inspect_entry_mode(
        &self,
        namespace: &str,
        stable_id: &str,
        bytes: &[u8],
        retained: bool,
    ) -> Result<DefinitionEntryInspection> {
        if bytes.len() > crate::definition_index::MAX_ENTRY_BYTES {
            return Err(PortcoveError::verification(
                "definition entry exceeds its byte bound",
            ));
        }
        let indexed = self
            .definitions()
            .iter()
            .find(|entry| entry.namespace() == namespace && entry.stable_id() == stable_id)
            .ok_or_else(|| PortcoveError::not_found("definition identity is outside the index"))?;
        self.verify_content(indexed.target(), bytes)?;
        let value: strict_json::UniqueValue = serde_json::from_slice(bytes)?;
        // Read only the schema number before the typed document: a newer entry
        // shape needs a newer engine and is not validated by this reader.
        if let Some(schema) = value
            .0
            .get("definition_schema")
            .and_then(Value::as_u64)
            .filter(|schema| *schema > crate::definition_capabilities::MAX_DEFINITION_SCHEMA)
        {
            return Err(crate::definition_capabilities::newer_definition_schema(
                schema,
            ));
        }
        let document: EntryDocument = serde_json::from_value(value.0)?;
        if !matches!(document.definition_schema, 1..=4) {
            return Err(PortcoveError::unsupported(
                "unsupported definition entry schema",
            ));
        }
        if document.namespace != indexed.namespace()
            || document.stable_id != indexed.stable_id()
            || document.revision != indexed.revision()
        {
            return Err(PortcoveError::verification(
                "entry identity differs from its index",
            ));
        }
        let required_features = match (document.definition_schema, document.required_features) {
            (4, Some(names)) => Some(check_required_features(&names)?),
            (1..=3, None) if document.advisory.is_none() => None,
            _ => {
                return Err(PortcoveError::verification(
                    "named features and advisory data require definition schema 4 and an explicit required_features array",
                ));
            }
        };
        if let Some(advisory) = document.advisory {
            const MAX_ADVISORY_BYTES: usize = 16 * 1024;
            const MAX_ADVISORY_KEYS: usize = 64;
            if advisory.len() > MAX_ADVISORY_KEYS
                || advisory.keys().any(|key| key.is_empty() || key.len() > 128)
                || serde_json::to_vec(&advisory)?.len() > MAX_ADVISORY_BYTES
            {
                return Err(PortcoveError::verification(
                    "definition advisory data exceeds its bounds",
                ));
            }
        }
        let supports = |feature: Feature, template: &str, minimum: u32| {
            require_feature(required_features.as_ref(), feature)?;
            Ok::<_, PortcoveError>(document.required_capabilities.iter().any(|requirement| {
                requirement.template == template && requirement.minimum_version >= minimum
            }))
        };
        let port: PortDefinition = serde_json::from_value(document.port.clone())?;
        if port.id != document.stable_id || serde_json::to_value(&port)? != document.port {
            return Err(PortcoveError::verification(
                "entry port identity or complete typed projection is invalid",
            ));
        }
        if port.reviewed_launch_contract_v1.is_some() {
            if required_features.is_none() {
                return Err(PortcoveError::unsupported(
                    "reviewed package and launch declarations require definition schema 4",
                ));
            }
            require_feature(required_features.as_ref(), Feature::ReviewedLaunchContract)?;
            crate::reviewed_launch_contract::validate(&port)?;
        }
        if port.upstream_active_reviewed && document.definition_schema == 1 {
            return Err(PortcoveError::unsupported(
                "a reviewed active project requires indexed definition schema 2",
            ));
        }
        if port.upstream_active_reviewed {
            require_feature(required_features.as_ref(), Feature::UpstreamActiveReviewed)?;
        }
        if port.release.provider == crate::ReleaseSource::ReviewedForge {
            if document.definition_schema != 4 {
                return Err(PortcoveError::unsupported(
                    "reviewed forge requires indexed definition schema 4",
                ));
            }
            require_feature(required_features.as_ref(), Feature::ReviewedForge)?;
        }
        crate::profile_loader::validate(&port)?;
        if port.managed_runtime_applies_to.is_some() {
            if required_features.is_none() {
                return Err(PortcoveError::unsupported(
                    "reviewed runtime compatibility artifacts require definition schema 4",
                ));
            }
            require_feature(
                required_features.as_ref(),
                Feature::ReviewedRuntimeArtifacts,
            )?;
            crate::managed_runtime_policy::validate_applies_to(&port)?;
        }
        if port.mod_loader.is_some() {
            if document.definition_schema < 3 {
                return Err(PortcoveError::verification(
                    "native mod loader bindings require indexed definition schema 3",
                ));
            }
            require_feature(required_features.as_ref(), Feature::ModLoader)?;
        }
        // A Daggerfall Unity binding is a mod loader, so its named feature was
        // already required above; this adds only the capability minimum.
        if crate::profile_loader::declares_dfu_loader(&port)
            && !supports(
                Feature::ModLoader,
                "native-portable",
                crate::profile_loader::DFU_CAPABILITY,
            )?
        {
            return Err(PortcoveError::verification(
                "Daggerfall Unity data-only loader requires its native-portable capability",
            ));
        }
        if let Some(settings) = &port.game_settings {
            settings.validate_port(&port)?;
        }
        crate::provider_binding::validate(&port)?;
        port.release.validate_github_streams(&port.platforms)?;
        if port.mod_provider_bindings.is_some() {
            let (template, minimum) = crate::provider_binding::capability(&port)
                .expect("binding validation requires a supported adapter");
            if !supports(Feature::ProviderBindings, template, minimum)? {
                return Err(PortcoveError::verification(format!(
                    "mod provider bindings require {template} capability version {minimum}"
                )));
            }
        }
        require_indexed_persistence(&port)?;
        // Retained-only exceptions predate named features. They cannot admit a
        // new schema-4 shape that its creating reader would have refused.
        let legacy_retained = retained && required_features.is_none();
        if !legacy_retained && !port.release.managed_build.is_empty() {
            return Err(crate::cartridge_build::retired_creation());
        }
        let adapter = serde_json::to_value(port.adapter)?;
        crate::managed_runtime_policy::validate_exact_exclusions(&port)?;
        if let Some((template, minimum)) =
            crate::managed_runtime_policy::exact_exclusion_capability(&port)
            && !supports(Feature::ExactReleaseExclusions, template, minimum)?
        {
            return Err(PortcoveError::verification(format!(
                "exact release exclusions require {template} capability version {minimum}"
            )));
        }
        if (!legacy_retained && !port.reviewed_package_layouts.is_empty())
            || crate::package_layout::layout_capability(&port)
                > crate::package_layout::NATIVE_CAPABILITY
        {
            let minimum = crate::package_layout::layout_capability(&port);
            crate::package_layout::validate(&port)?;
            if port.adapter != crate::AdapterKind::NativePortable
                || !supports(Feature::ReviewedPackageLayouts, "native-portable", minimum)?
            {
                return Err(PortcoveError::verification(format!(
                    "reviewed package layouts require native-portable capability version {minimum}",
                )));
            }
        }
        if crate::native_temp::has_sibling_platforms(&port)
            && !supports(Feature::NativeTemporaryDataSiblings, "native-portable", 10)?
        {
            return Err(PortcoveError::verification(
                "native original-file siblings with Windows temporary data require capability version 10",
            ));
        }
        if let Some(policy) = port.external_profile_policy {
            let minimum = crate::native_external_profile::minimum_capability(policy);
            if !supports(Feature::ExternalProfilePolicy, "native-portable", minimum)? {
                return Err(PortcoveError::verification(format!(
                    "managed external profile guards require native capability version {minimum}"
                )));
            }
        }
        if port.release.linux_tar_xz && !supports(Feature::LinuxTarXz, "native-portable", 8)? {
            return Err(PortcoveError::verification(
                "managed Linux TAR.XZ requires native capability version 8",
            ));
        }
        if !port.release.tar_xz_platforms.is_empty() {
            crate::runtime::validate_platform_tar_xz(&port)?;
            let (template, minimum) = if port.adapter == crate::AdapterKind::NativePortable {
                (
                    "native-portable",
                    crate::runtime::NATIVE_MAC_BUNDLE_TAR_XZ_CAPABILITY,
                )
            } else {
                (
                    "generated-cache",
                    crate::runtime::GENERATED_CACHE_TAR_XZ_CAPABILITY,
                )
            };
            if !supports(Feature::PlatformTarXz, template, minimum)? {
                return Err(PortcoveError::verification(format!(
                    "managed Mac TAR.XZ requires {template} capability version {minimum}",
                )));
            }
        }
        if port.portable_marker_file.is_some()
            && !supports(Feature::PortableMarker, "native-portable", 19)?
        {
            return Err(PortcoveError::verification(
                "named portable marker files require native capability version 19",
            ));
        }
        if port.linux_portable_data_directory.is_some()
            && !supports(
                Feature::LinuxPortableData,
                "native-portable",
                crate::native_portable_data::NATIVE_CAPABILITY,
            )?
        {
            return Err(PortcoveError::verification(
                "Linux portable data directories require native capability version 25",
            ));
        }
        if !port.runtime_subdirectory_by_platform.is_empty()
            && !supports(
                Feature::PlatformRuntimeSubdirectories,
                "n64-recomp-portable",
                crate::runtime::N64_PLATFORM_RUNTIME_SUBDIRECTORY_CAPABILITY,
            )?
        {
            return Err(PortcoveError::verification(
                "platform runtime subdirectories require n64-recomp-portable capability version 6",
            ));
        }
        // A reader must enforce the launch policy before it can admit this entry.
        let handoff_capability = crate::launch::tracked_handoff_native_capability(&port);
        if port.windows_tracked_handoff
            && !supports(
                Feature::TrackedHandoff,
                "native-portable",
                handoff_capability,
            )?
        {
            return Err(PortcoveError::verification(format!(
                "Windows tracked handoff requires native capability version {handoff_capability}"
            )));
        }
        if port.linux_packaged_library.is_some()
            && !supports(
                Feature::LinuxPackagedLibrary,
                "native-portable",
                crate::runtime::LINUX_PACKAGED_LIBRARY_CAPABILITY,
            )?
        {
            return Err(PortcoveError::verification(format!(
                "packaged Linux libraries require native capability version {}",
                crate::runtime::LINUX_PACKAGED_LIBRARY_CAPABILITY
            )));
        }
        if port.release.grant_declared_executable {
            let (template, minimum) = match port.adapter {
                crate::AdapterKind::NativePortable => (
                    "native-portable",
                    if legacy_retained {
                        22
                    } else {
                        crate::package_layout::native_executable_grant_capability(&port)
                    },
                ),
                crate::AdapterKind::LibultrashipPortable => ("libultraship-portable", 4),
                crate::AdapterKind::GeneratedCache => ("generated-cache", 2),
                _ => {
                    return Err(PortcoveError::verification(
                        "granting a declared executable is supported only by native, libultraship and generated-cache definitions",
                    ));
                }
            };
            if !supports(Feature::DeclaredExecutable, template, minimum)? {
                return Err(PortcoveError::verification(format!(
                    "granting a declared executable requires {template} capability version {minimum}"
                )));
            }
        }
        if port.release.archive_file_links {
            let (template, minimum) = match port.adapter {
                crate::AdapterKind::NativePortable => ("native-portable", 14),
                crate::AdapterKind::N64RecompPortable => ("n64-recomp-portable", 5),
                _ => {
                    return Err(PortcoveError::verification(
                        "archive file links are supported only by native and N64 recomp definitions",
                    ));
                }
            };
            if !supports(Feature::ArchiveFileLinks, template, minimum)? {
                return Err(PortcoveError::verification(format!(
                    "packages relying on archive file links require {template} capability version {minimum}"
                )));
            }
        }
        if port.n64_runtime_at_executable_parent
            && !supports(Feature::N64ExecutableParent, "n64-recomp-portable", 4)?
        {
            return Err(PortcoveError::verification(
                "executable-parent N64 runtime and data preservation require capability version 4",
            ));
        }
        if port.runtime_disc_image.is_some()
            && !supports(Feature::RuntimeDiscImage, "staged-source-portable", 30)?
        {
            return Err(PortcoveError::verification(
                "disc-image unpacking requires staged-source capability version 30",
            ));
        }
        if port.runtime_stfs_package.is_some()
            && !supports(
                Feature::RuntimeStfs,
                "staged-source-portable",
                crate::stfs::PACKAGE_BINDING_CAPABILITY,
            )?
        {
            return Err(PortcoveError::verification(
                "an STFS package binding requires staged-source capability version 32",
            ));
        }
        if (port.runtime_rom_patch.is_some()
            || port.runtime_source_materialization
                == Some(crate::RuntimeSourceMaterialization::RomPatch))
            && !supports(Feature::RuntimeRomPatch, "staged-source-portable", 33)?
        {
            return Err(PortcoveError::verification(
                "ROM patching requires staged-source capability version 33",
            ));
        }
        if port.runtime_source_materialization
            == Some(crate::RuntimeSourceMaterialization::SnesHeaderless)
            && !supports(
                Feature::HeaderlessRuntime,
                "staged-source-portable",
                crate::adapter::SNES_COPIER_HEADER_CAPABILITY,
            )?
        {
            return Err(PortcoveError::verification(
                "a headerless SNES runtime file requires staged-source capability version 36",
            ));
        }
        if port.optional_game_source
            && !supports(Feature::OptionalGameSource, "staged-source-portable", 31)?
        {
            return Err(PortcoveError::verification(
                "an optional game source requires staged-source capability version 31",
            ));
        }
        if port.mod_package_policy.is_some()
            && !supports(Feature::ModPackages, "staged-source-portable", 24)?
        {
            return Err(PortcoveError::verification(
                "versioned mod packages require staged-source capability version 24",
            ));
        }
        if crate::preparation::source::native(&port) {
            let minimum = if crate::preparation::source::native_relative(&port) {
                crate::preparation::source::NATIVE_RELATIVE_SOURCE_CAPABILITY
            } else {
                6
            };
            if !supports(Feature::NativeOriginals, "native-portable", minimum)? {
                return Err(PortcoveError::verification(format!(
                    "verified native runtime originals require capability version {minimum}"
                )));
            }
        }
        if port.windows_temp_directory.is_some()
            && !supports(Feature::NativeTemporaryData, "native-portable", 5)?
        {
            return Err(PortcoveError::verification(
                "entry-owned Windows temporary data requires native capability version 5",
            ));
        }
        if port.adapter == crate::AdapterKind::NativePortable
            && port.release.provider == crate::ReleaseSource::DirectManifest
            && !supports(Feature::DirectManifest, "native-portable", 3)?
        {
            return Err(PortcoveError::verification(
                "exactly pinned native archives require capability version 3",
            ));
        }
        if crate::preparation::has_manual_marker(&port)
            && !supports(Feature::ManualSetup, "native-portable", 2)?
        {
            return Err(PortcoveError::verification(
                "manual native setup progress requires capability version 2",
            ));
        }
        if let Some(version) = crate::persistence::fresh_direct_data_guard_capability(&port)
            && !legacy_retained
            && !supports(Feature::DirectDataGuard, "staged-source-portable", version)?
        {
            return Err(PortcoveError::verification(format!(
                "fresh Direct reader data isolation requires staged-source capability version {version}",
            )));
        }
        if !legacy_retained
            && crate::persistence::ready_staged_archive(&port)
            && !supports(Feature::StagedArchive, "staged-source-portable", 23)?
        {
            return Err(PortcoveError::verification(
                "ready staged archives require metadata and prelaunch data preservation capability version 23",
            ));
        }
        if !legacy_retained
            && port.adapter == crate::AdapterKind::PsxRecompManaged
            && !supports(Feature::PsxPackageActivation, "psx-recomp-managed", 2)?
        {
            return Err(PortcoveError::verification(
                "new managed PS1 entries require package-preserving activation capability version 2",
            ));
        }
        if crate::persistence::requires_psx_retained_scope(&port)
            && !supports(
                Feature::PsxRetainedScope,
                "psx-recomp-managed",
                crate::persistence::PSX_RETAINED_SCOPE_CAPABILITY,
            )?
        {
            return Err(PortcoveError::verification(
                "managed PS1 entries with a texture-pack folder require retained-scope capability version 3",
            ));
        }
        if port
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.trust == crate::ExternalRuntimeTrust::UserSelected)
            && !supports(Feature::UserSelectedRuntime, "staged-source-portable", 20)?
        {
            return Err(PortcoveError::verification(
                "user-selected execution requires staged-source capability version 20",
            ));
        }
        if crate::managed_runtime_policy::requires_provider_resolution(&port)
            && !supports(Feature::ProviderResolution, "staged-source-portable", 21)?
        {
            return Err(PortcoveError::verification(
                "provider-bound reusable runtime policies require staged-source capability version 21",
            ));
        }
        if (port.managed_initialization
            == Some(crate::ManagedInitialization::TfeDarkForcesPortableV1)
            || port.runtime_data_policy
                == Some(crate::RuntimeDataPolicy::VersionLocalRetroAchievementsV1)
            || port.managed_shared_preferences
                == Some(crate::PreparedSharedPreferencesContract::GbRecompiledWindowsV1))
            && !supports(Feature::ReusableRuntimePolicy, "staged-source-portable", 19)?
        {
            return Err(PortcoveError::verification(
                "reviewed reusable runtime policies require staged-source capability version 19",
            ));
        }
        if port.managed_shared_preferences.is_some()
            && !supports(Feature::SharedPreferences, "staged-source-portable", 16)?
        {
            return Err(PortcoveError::verification(
                "managed shared preferences require staged-source capability version 16",
            ));
        }
        if port.runtime_data_policy.is_some()
            && !supports(Feature::RuntimeData, "staged-source-portable", 15)?
        {
            return Err(PortcoveError::verification(
                "version-local credentials require staged-source capability version 15",
            ));
        }
        if crate::managed_chocolate::applies(&port)
            && !supports(
                Feature::ChocolatePreparation,
                "staged-source-portable",
                crate::managed_chocolate::CAPABILITY,
            )?
        {
            return Err(PortcoveError::verification(
                "Chocolate profile preparation requires staged-source capability version 38",
            ));
        }
        if port.managed_initialization.is_some()
            && !supports(Feature::ManagedInitialization, "staged-source-portable", 12)?
        {
            return Err(PortcoveError::verification(
                "managed TFE initialization requires staged-source capability version 12",
            ));
        }
        if port.windows_shipwright_persistence
            && !supports(Feature::ShipwrightPersistence, "libultraship-portable", 3)?
        {
            return Err(PortcoveError::verification(
                "Shipwright working-directory persistence requires libultraship-portable capability version 3",
            ));
        }
        if port.windows_runtime_path_policy.is_some()
            && !supports(
                Feature::WindowsRuntimePaths,
                crate::runtime_path_policy::capability_template(&port),
                crate::runtime_path_policy::minimum_capability(&port),
            )?
        {
            return Err(PortcoveError::verification(format!(
                "Windows runtime paths require {} capability version {}",
                crate::runtime_path_policy::capability_template(&port),
                crate::runtime_path_policy::minimum_capability(&port)
            )));
        }
        if let Some(minimum) = port
            .release
            .user_prepared
            .values()
            .filter_map(|runtime| {
                runtime
                    .shared_preferences
                    .map(|scope| scope.minimum_template_version())
            })
            .max()
            && !supports(Feature::SharedWriteScope, "staged-source-portable", minimum)?
        {
            return Err(PortcoveError::verification(
                "shared write scope requires its staged-source capability version",
            ));
        }
        for recipe in port.release.managed_build.values() {
            let minimum = recipe.minimum_template_version();
            let template = recipe.capability_template();
            if !supports(Feature::CartridgeBuild, template, minimum)? {
                return Err(PortcoveError::verification(format!(
                    "cartridge build recipe requires {template} capability version {minimum}",
                )));
            }
        }
        if port
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.settings_contract.is_some())
            && !supports(Feature::PreparedSettings, "staged-source-portable", 5)?
        {
            return Err(PortcoveError::verification(
                "prepared settings contract requires staged-source capability version 5",
            ));
        }

        if port
            .release
            .user_prepared
            .values()
            .any(|runtime| !runtime.required_mutable_files.is_empty())
            && !supports(Feature::RequiredMutableFiles, "staged-source-portable", 4)?
        {
            return Err(PortcoveError::verification(
                "required mutable files require staged-source capability version 4",
            ));
        }
        if port
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.source_directory_environment)
            && !supports(
                Feature::SourceDirectoryBinding,
                "staged-source-portable",
                18,
            )?
        {
            return Err(PortcoveError::verification(
                "prepared source directory binding requires staged-source capability version 18",
            ));
        }
        if port.n64_windows_initial_d3d12
            && !supports(Feature::N64InitialD3d12, "n64-recomp-portable", 2)?
        {
            return Err(PortcoveError::verification(
                "initial D3D12 requires N64 engine capability version 2",
            ));
        }
        if port
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.library_user_data)
            && !supports(Feature::PrivateUserData, "staged-source-portable", 2)?
        {
            return Err(PortcoveError::verification(
                "prepared private user data requires staged-source capability version 2",
            ));
        }
        if port.release.provider == crate::ReleaseSource::UserPrepared
            && port.runtime_subdirectory.is_some()
            && !supports(
                Feature::PreparedRuntimeSubdirectory,
                "staged-source-portable",
                3,
            )?
        {
            return Err(PortcoveError::verification(
                "prepared runtime subdirectory requires staged-source capability version 3",
            ));
        }
        if !document
            .required_capabilities
            .iter()
            .any(|requirement| adapter.as_str() == Some(requirement.template.as_str()))
        {
            return Err(PortcoveError::verification(
                "entry omits its adapter capability",
            ));
        }
        let request = DefinitionCapabilityRequest {
            capability_contract_schema: 1,
            required_capabilities: document.required_capabilities,
        };
        let capabilities = if legacy_retained {
            crate::definition_capabilities::check_retained_definition_capabilities(&request)?
        } else {
            check_definition_capabilities(&request)?
        };
        let inspection = DefinitionEntryInspection {
            bytes: bytes.to_vec(),
            namespace: document.namespace,
            revision: document.revision,
            schema_version: document.definition_schema,
            port,
            capabilities,
            required_features,
            source_contracts: document.source_contracts,
            execution_contract: document.execution_contract,
            persistence_contract: document.persistence_contract,
            artifact_bindings: document.artifact_bindings,
            evidence_references: document.evidence_references,
        };
        if inspection.referenced_targets().count() > 1024 {
            return Err(PortcoveError::verification(
                "entry has too many contract references",
            ));
        }
        for target in inspection.referenced_targets() {
            self.content_length(target)?;
        }
        Ok(inspection)
    }
}

// Inspect duplicate keys before constructing Value, whose ordinary map decoder
// would otherwise silently keep the last safety field or environment variable.
pub(crate) mod strict_json {
    use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
    use serde_json::{Map, Number, Value};
    use std::fmt;

    pub(crate) struct UniqueValue(pub(crate) Value);

    impl<'de> Deserialize<'de> for UniqueValue {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            deserializer.deserialize_any(UniqueVisitor)
        }
    }

    struct UniqueVisitor;

    impl<'de> Visitor<'de> for UniqueVisitor {
        type Value = UniqueValue;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("JSON with unique object keys")
        }

        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(UniqueValue(Value::Null))
        }

        fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
            Ok(UniqueValue(Value::Bool(value)))
        }

        fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
            Ok(UniqueValue(Value::Number(value.into())))
        }

        fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
            Ok(UniqueValue(Value::Number(value.into())))
        }

        fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
            Number::from_f64(value)
                .map(|number| UniqueValue(Value::Number(number)))
                .ok_or_else(|| E::custom("invalid JSON number"))
        }

        fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
            Ok(UniqueValue(Value::String(value.into())))
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
            let mut values = Vec::new();
            while let Some(UniqueValue(value)) = sequence.next_element()? {
                values.push(value);
            }
            Ok(UniqueValue(Value::Array(values)))
        }

        fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> Result<Self::Value, A::Error> {
            let mut values = Map::new();
            while let Some(key) = object.next_key::<String>()? {
                if values.contains_key(&key) {
                    return Err(de::Error::custom("duplicate definition object key"));
                }
                let UniqueValue(value) = object.next_value()?;
                values.insert(key, value);
            }
            Ok(UniqueValue(Value::Object(values)))
        }
    }
}

#[cfg(test)]
#[path = "definition_entry_tests.rs"]
mod tests;
