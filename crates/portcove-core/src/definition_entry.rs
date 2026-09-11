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
        let adapter = serde_json::to_value(port.adapter)?;
        if !document
            .required_capabilities
            .iter()
            .any(|requirement| adapter.as_str() == Some(requirement.template.as_str()))
        {
            return Err(PortcoveError::verification(
                "entry omits its adapter capability",
            ));
        }
        let capabilities = check_definition_capabilities(&DefinitionCapabilityRequest {
            capability_contract_schema: 1,
            required_capabilities: document.required_capabilities,
        })?;
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
