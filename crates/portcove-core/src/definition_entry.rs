//! Indexed entry inspection, separate from contract interpretation and admission.
use serde::Deserialize;
use serde_json::Value;

use crate::{
    DefinitionCapabilityReport, DefinitionCapabilityRequest, DefinitionCapabilityRequirement,
    DefinitionContentIndex, PortDefinition, PortcoveError, Result, check_definition_capabilities,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryDocument {
    definition_schema: u32,
    namespace: String,
    stable_id: String,
    revision: u64,
    required_capabilities: Vec<DefinitionCapabilityRequirement>,
    port: Value,
    source_contracts: Vec<String>,
    execution_contract: String,
    persistence_contract: String,
    artifact_bindings: Vec<String>,
    evidence_references: Vec<String>,
}

/// Exact indexed bytes and a typed projection, not a usable catalog or trust grant.
#[derive(Debug)]
pub struct DefinitionEntryInspection {
    bytes: Vec<u8>,
    namespace: String,
    revision: u64,
    port: PortDefinition,
    capabilities: DefinitionCapabilityReport,
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

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Shape-checked data; existing catalog/contract validators still govern its use.
    pub fn port(&self) -> &PortDefinition {
        &self.port
    }

    pub fn capabilities(&self) -> &DefinitionCapabilityReport {
        &self.capabilities
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
        let indexed = self
            .definitions()
            .iter()
            .find(|entry| entry.namespace() == namespace && entry.stable_id() == stable_id)
            .ok_or_else(|| PortcoveError::not_found("definition identity is outside the index"))?;
        self.verify_content(indexed.target(), bytes)?;
        let value: strict_json::UniqueValue = serde_json::from_slice(bytes)?;
        let document: EntryDocument = serde_json::from_value(value.0)?;
        if document.definition_schema != 1 {
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
        let port: PortDefinition = serde_json::from_value(document.port.clone())?;
        if port.id != document.stable_id || serde_json::to_value(&port)? != document.port {
            return Err(PortcoveError::verification(
                "entry port identity or complete typed projection is invalid",
            ));
        }
        if !retained && !port.release.managed_build.is_empty() {
            return Err(crate::cartridge_build::retired_creation());
        }
        let adapter = serde_json::to_value(port.adapter)?;
        if port.n64_runtime_at_executable_parent
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "n64-recomp-portable" && requirement.minimum_version >= 4
            })
        {
            return Err(PortcoveError::verification(
                "executable-parent N64 runtime and data preservation require capability version 4",
            ));
        }
        if port.mod_package_policy.is_some()
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= 24
            })
        {
            return Err(PortcoveError::verification(
                "versioned mod packages require staged-source capability version 24",
            ));
        }
        if crate::preparation::source::native(&port)
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "native-portable" && requirement.minimum_version >= 6
            })
        {
            return Err(PortcoveError::verification(
                "verified native runtime originals require capability version 6",
            ));
        }
        if port.windows_temp_directory.is_some()
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "native-portable" && requirement.minimum_version >= 5
            })
        {
            return Err(PortcoveError::verification(
                "entry-owned Windows temporary data requires native capability version 5",
            ));
        }
        if port.adapter == crate::AdapterKind::NativePortable
            && port.release.provider == crate::ReleaseSource::DirectManifest
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "native-portable" && requirement.minimum_version >= 3
            })
        {
            return Err(PortcoveError::verification(
                "exactly pinned native archives require capability version 3",
            ));
        }
        if crate::preparation::has_manual_marker(&port)
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "native-portable" && requirement.minimum_version >= 2
            })
        {
            return Err(PortcoveError::verification(
                "manual native setup progress requires capability version 2",
            ));
        }
        if !retained
            && crate::persistence::ready_staged_archive(&port)
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= 23
            })
        {
            return Err(PortcoveError::verification(
                "ready staged archives require metadata and prelaunch data preservation capability version 23",
            ));
        }
        if !retained
            && port.adapter == crate::AdapterKind::PsxRecompManaged
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "psx-recomp-managed" && requirement.minimum_version >= 2
            })
        {
            return Err(PortcoveError::verification(
                "new managed PS1 entries require package-preserving activation capability version 2",
            ));
        }
        if port
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.trust == crate::ExternalRuntimeTrust::UserSelected)
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= 20
            })
        {
            return Err(PortcoveError::verification(
                "user-selected execution requires staged-source capability version 20",
            ));
        }
        if crate::managed_runtime_policy::requires_provider_resolution(&port)
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= 21
            })
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
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= 19
            })
        {
            return Err(PortcoveError::verification(
                "reviewed reusable runtime policies require staged-source capability version 19",
            ));
        }
        if port.managed_shared_preferences.is_some()
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= 16
            })
        {
            return Err(PortcoveError::verification(
                "managed shared preferences require staged-source capability version 16",
            ));
        }
        if port.runtime_data_policy.is_some()
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= 15
            })
        {
            return Err(PortcoveError::verification(
                "version-local credentials require staged-source capability version 15",
            ));
        }
        if port.managed_initialization.is_some()
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= 12
            })
        {
            return Err(PortcoveError::verification(
                "managed TFE initialization requires staged-source capability version 12",
            ));
        }
        if port.windows_runtime_path_policy.is_some()
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template
                    == if port.adapter == crate::AdapterKind::NativePortable {
                        "native-portable"
                    } else {
                        "staged-source-portable"
                    }
                    && requirement.minimum_version
                        >= crate::runtime_path_policy::minimum_capability(&port)
            })
        {
            return Err(PortcoveError::verification(format!(
                "Windows runtime paths require {} capability version {}",
                if port.adapter == crate::AdapterKind::NativePortable {
                    "native-portable"
                } else {
                    "staged-source-portable"
                },
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
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= minimum
            })
        {
            return Err(PortcoveError::verification(
                "shared write scope requires its staged-source capability version",
            ));
        }
        for recipe in port.release.managed_build.values() {
            let minimum = recipe.minimum_template_version();
            let template = recipe.capability_template();
            if !document.required_capabilities.iter().any(|requirement| {
                requirement.template == template && requirement.minimum_version >= minimum
            }) {
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
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable" && requirement.minimum_version >= 5
            })
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
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable" && requirement.minimum_version >= 4
            })
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
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable"
                    && requirement.minimum_version >= 18
            })
        {
            return Err(PortcoveError::verification(
                "prepared source directory binding requires staged-source capability version 18",
            ));
        }
        if port.n64_windows_initial_d3d12
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "n64-recomp-portable" && requirement.minimum_version >= 2
            })
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
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable" && requirement.minimum_version >= 2
            })
        {
            return Err(PortcoveError::verification(
                "prepared private user data requires staged-source capability version 2",
            ));
        }
        if port.release.provider == crate::ReleaseSource::UserPrepared
            && port.runtime_subdirectory.is_some()
            && !document.required_capabilities.iter().any(|requirement| {
                requirement.template == "staged-source-portable" && requirement.minimum_version >= 3
            })
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
        let capabilities = if retained {
            crate::definition_capabilities::check_retained_definition_capabilities(&request)?
        } else {
            check_definition_capabilities(&request)?
        };
        let inspection = DefinitionEntryInspection {
            bytes: bytes.to_vec(),
            namespace: document.namespace,
            revision: document.revision,
            port,
            capabilities,
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
