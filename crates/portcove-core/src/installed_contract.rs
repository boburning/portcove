//! Immutable version-owned catalog semantics, bound by the install manifest digest.
//!
//! The legacy catalog projection retains the source graph referenced by the
//! installed contract. A later catalog cannot supply missing identity, validator
//! or evidence records. This records semantics without granting new trust.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::{
    Catalog, CatalogDocument, DefinitionSelectionIdentity, Platform, PortcoveError, Result,
};

pub(crate) fn legacy_retained_document(
    catalog: &Catalog,
    port_id: &str,
    platform: Option<Platform>,
) -> CatalogDocument {
    let mut document = retained_catalog_document(catalog, port_id);
    let mut omitted = Vec::new();
    let mut stripped_linux = false;
    document.ports.retain_mut(|port| {
        // A whole legacy catalog is decoded before the installed port is chosen.
        if port.id != port_id {
            port.mod_loader = None;
        }
        if port.linux_packaged_library.is_none() {
            return true;
        }
        if port.id != port_id {
            omitted.push(port.id.clone());
            return false;
        }
        if platform == Some(Platform::WindowsX86_64) {
            let linux = Platform::LinuxX86_64;
            stripped_linux = true;
            port.linux_packaged_library = None;
            port.platforms.retain(|platform| *platform != linux);
            port.automated_tested_platforms
                .retain(|platform| *platform != linux);
            port.manually_validated_platforms
                .retain(|platform| *platform != linux);
            port.release.linux_tar_xz = false;
            port.release.asset_hints.remove(&linux);
            port.executable_hints.remove(&linux);
            port.reviewed_package_layouts.remove(&linux);
        }
        true
    });
    if let Some(sources) = &mut document.source_catalog {
        sources
            .contracts
            .retain(|contract| !omitted.contains(&contract.port_id));
        sources.qualification.retain(|record| {
            !omitted.contains(&record.scope.port_id)
                && !(stripped_linux
                    && record.scope.port_id == port_id
                    && record.scope.platform == Platform::LinuxX86_64)
        });
    }
    document
}

// Keep the active and previous immutable interpretations without evicting each
// other on every rollback/status read. Keys retain the complete bounded bytes
// and format, never a mutable path or an authorization result. Installation reads
// still verify current manifest bytes/digests; policy and integrity stay fresh.
static DECODED_CATALOGS: Mutex<Vec<(u32, String, Catalog)>> = Mutex::new(Vec::new());
const DECODED_CATALOG_CAPACITY: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InstalledContract {
    format: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_format: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preparation_mode: Option<crate::PreparationMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    external_trust: Option<crate::ExternalRuntimeTrust>,
    port_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    catalog_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    definition: Option<crate::definition_projection::DefinitionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    admission: Option<DefinitionSelectionIdentity>,
}

/// Keep unrelated source contracts with newer reader requirements out of
/// legacy captures. Older readers decode the whole retained source graph before
/// selecting the port, and the selected port can still use a shared profile.
fn retained_catalog_document(catalog: &Catalog, selected: &str) -> crate::CatalogDocument {
    let mut document = catalog.authoritative_document();
    for port in &mut document.ports {
        if port.id != selected && package_only_settings(port) {
            port.game_settings = None;
        }
    }
    let excluded_ports = document
        .ports
        .iter()
        .filter(|port| crate::preparation::source::native_relative(port))
        .map(|port| &port.id)
        .chain(
            document
                .source_catalog
                .iter()
                .flat_map(|sources| &sources.contracts)
                .filter(|contract| {
                    contract.variant_list_recognition_only
                        || !contract.n64_recomp_inputs_v1.is_empty()
                })
                .map(|contract| &contract.port_id),
        )
        .filter(|port_id| port_id.as_str() != selected)
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    if excluded_ports.is_empty() {
        return document;
    }
    let excluded_profiles = document
        .ports
        .iter()
        .filter(|port| excluded_ports.contains(&port.id))
        .filter_map(|port| port.source_profile.clone())
        .collect::<std::collections::BTreeSet<_>>();
    document
        .ports
        .retain(|port| !excluded_ports.contains(&port.id));
    if let Some(sources) = document.source_catalog.as_mut() {
        sources
            .contracts
            .retain(|contract| !excluded_ports.contains(&contract.port_id));
        sources
            .qualification
            .retain(|record| !excluded_ports.contains(&record.scope.port_id));
        let still_used = document
            .ports
            .iter()
            .flat_map(|port| port.source_profile.iter().chain(&port.bios_source_profile))
            .chain(
                sources
                    .contracts
                    .iter()
                    .map(|contract| &contract.profile_id),
            )
            .collect::<std::collections::BTreeSet<_>>();
        sources.identities.retain(|profile| {
            !excluded_profiles.contains(&profile.id) || still_used.contains(&profile.id)
        });
    }
    document
}

fn package_only_settings(port: &crate::PortDefinition) -> bool {
    port.game_settings
        .as_ref()
        .is_some_and(crate::GameSettingsContract::package_only)
}

impl InstalledContract {
    pub(crate) fn port_id(&self) -> &str {
        &self.port_id
    }

    pub(crate) fn capture(catalog: &Catalog, port_id: &str) -> Result<Self> {
        Self::capture_for_platform(catalog, port_id, None)
    }

    pub(crate) fn capture_for_platform(
        catalog: &Catalog,
        port_id: &str,
        platform: Option<Platform>,
    ) -> Result<Self> {
        let port = catalog.port(port_id)?;
        let definition = catalog.definition_snapshot(port_id).cloned();
        let admission = catalog.definition_selection(port_id).cloned();
        if port.reviewed_launch_contract_v1.is_some()
            && (definition.is_none() || admission.is_none())
        {
            return Err(PortcoveError::verification(
                "named package and launch declarations require the exact admitted indexed entry",
            ));
        }
        if port.managed_runtime_applies_to.is_some()
            && (definition.is_none() || admission.is_none())
        {
            return Err(PortcoveError::verification(
                "reviewed runtime compatibility artifacts require the exact admitted indexed entry",
            ));
        }
        let packaged_library = port.linux_packaged_library.is_some()
            && (definition.is_some() || platform != Some(Platform::WindowsX86_64));
        let mut contract = Self {
            format: if admission.is_some() {
                3
            } else if definition.is_some() {
                2
            } else {
                1
            },
            original_format: None,
            preparation_mode: None,
            external_trust: None,
            port_id: port_id.into(),
            catalog_json: if definition.is_some() {
                String::new()
            } else {
                serde_json::to_string(&legacy_retained_document(catalog, port_id, platform))?
            },
            definition,
            admission,
        };
        if package_only_settings(port) {
            contract.original_format = Some(contract.format);
            contract.format = 12;
        } else if packaged_library {
            contract.original_format = Some(contract.format);
            contract.format = 11;
        } else if catalog
            .port(port_id)?
            .release
            .user_prepared
            .values()
            .any(|runtime| runtime.trust == crate::ExternalRuntimeTrust::UserSelected)
        {
            contract.original_format = Some(contract.format);
            contract.format = 5;
            contract.external_trust = Some(crate::ExternalRuntimeTrust::UserSelected);
        } else if catalog
            .port(port_id)?
            .archive_data_compatibility_v1
            .is_some()
        {
            // Partitioned coordinates must never reach an older ready-archive
            // reader, including embedded/unscoped installation contracts.
            contract.original_format = Some(contract.format);
            contract.format = 10;
        } else if catalog.port(port_id)?.n64_runtime_at_executable_parent {
            // Fence older readers without rewriting existing installed contracts.
            contract.original_format = Some(contract.format);
            contract.format = 8;
        } else if catalog.port(port_id)?.mod_package_policy.is_some() {
            contract.original_format = Some(contract.format);
            contract.format = 7;
        } else if crate::persistence::ready_staged_archive(catalog.port(port_id)?) {
            // Embedded/unscoped installs need the same old-reader fence as an
            // indexed capability. Do not rewrite existing retained contracts.
            contract.original_format = Some(contract.format);
            contract.format = 6;
        }
        contract.catalog(port_id)?;
        Ok(contract)
    }

    pub(crate) fn catalog(&self, port_id: &str) -> Result<Catalog> {
        let original_format = match (
            self.format,
            self.original_format,
            self.preparation_mode,
            self.external_trust,
        ) {
            (format @ 1..=3, None, None, None) => format,
            (4, Some(format @ 1..=3), Some(crate::PreparationMode::Ghostship200Legacy), None)
                if self.port_id == "ghostship" =>
            {
                format
            }
            (5, Some(format @ 1..=3), None, Some(crate::ExternalRuntimeTrust::UserSelected)) => {
                format
            }
            (6..=8 | 10, Some(format @ 1..=3), None, None) => format,
            (9, Some(format @ 1..=3), Some(crate::PreparationMode::SourceOnly), None) => format,
            (
                11 | 12,
                Some(format @ 1..=3),
                None | Some(crate::PreparationMode::SourceOnly),
                None,
            ) => format,
            _ => {
                return Err(PortcoveError::verification(
                    "retained preparation interpretation is unsupported or malformed",
                ));
            }
        };
        if self.port_id != port_id
            || !matches!(
                (
                    original_format,
                    self.definition.as_ref(),
                    self.admission.as_ref()
                ),
                (1, None, None) | (2, Some(_), None) | (3, Some(_), Some(_))
            )
            || (original_format >= 2 && !self.catalog_json.is_empty())
        {
            return Err(PortcoveError::verification(
                "retained definition contract does not match this installation",
            ));
        }
        if self.catalog_json.len() > crate::signed_catalog::MAX_CATALOG_BYTES {
            return Err(PortcoveError::verification(
                "retained definition contract exceeds the supported content bound",
            ));
        }
        let mut cache_key = match &self.definition {
            Some(definition) => {
                definition.validate_bounds()?;
                if definition.port_id() != port_id {
                    return Err(PortcoveError::verification(
                        "retained indexed definition has a different port identity",
                    ));
                }
                serde_json::to_string(&(definition, &self.admission))?
            }
            None => self.catalog_json.clone(),
        };
        if matches!(self.format, 4..=12) {
            cache_key = serde_json::to_string(&(
                self.original_format,
                self.preparation_mode,
                self.external_trust,
                cache_key,
            ))?;
        }
        if let Ok(mut cache) = DECODED_CATALOGS.lock()
            && let Some(index) = cache
                .iter()
                .position(|(format, content, _)| *format == self.format && content == &cache_key)
        {
            let entry = cache.remove(index);
            let catalog = entry.2.clone();
            cache.push(entry);
            catalog.port(port_id)?;
            self.require_metadata_semantics(&catalog)?;
            return Ok(catalog);
        }
        let mut catalog = match &self.definition {
            Some(definition) => definition.catalog()?,
            None => Catalog::from_json(&self.catalog_json)?,
        };
        if let Some(admission) = &self.admission {
            catalog.retain_definition_selection(Arc::new(admission.clone()))?;
        }
        catalog.port(port_id)?;
        self.require_metadata_semantics(&catalog)?;
        if self.format == 5
            && !catalog
                .port(port_id)?
                .release
                .user_prepared
                .values()
                .any(|runtime| runtime.trust == crate::ExternalRuntimeTrust::UserSelected)
        {
            return Err(PortcoveError::verification(
                "retained user-selection envelope has no matching trust semantics",
            ));
        }
        // Format 1 stores canonical legacy semantics. Format 2 already ran the
        // strict indexed interpreter; neither route may discard unknown fields.
        if self.definition.is_none()
            && serde_json::from_str::<serde_json::Value>(&self.catalog_json)?
                != serde_json::to_value(catalog.authoritative_document())?
        {
            return Err(PortcoveError::verification(
                "retained definition contains unsupported or noncanonical semantics",
            ));
        }
        if let Ok(mut cache) = DECODED_CATALOGS.lock() {
            // Another reader may have completed the same pure interpretation
            // while this one validated outside the lock.
            cache.retain(|(format, content, _)| *format != self.format || content != &cache_key);
            if cache.len() == DECODED_CATALOG_CAPACITY {
                cache.remove(0);
            }
            cache.push((self.format, cache_key, catalog.clone()));
        }
        Ok(catalog)
    }

    fn require_metadata_semantics(&self, catalog: &Catalog) -> Result<()> {
        let port = catalog.port(&self.port_id)?;
        if (self.format == 12) != package_only_settings(port) {
            return Err(PortcoveError::verification(
                "package-only settings require their retained interpretation envelope",
            ));
        }
        if (self.format == 11) != port.linux_packaged_library.is_some() {
            return Err(PortcoveError::verification(
                "packaged Linux libraries require their retained interpretation envelope",
            ));
        }
        if (self.format == 10)
            != catalog
                .port(&self.port_id)?
                .archive_data_compatibility_v1
                .is_some()
        {
            return Err(PortcoveError::verification(
                "partitioned archive data requires its retained interpretation envelope",
            ));
        }
        if self.preparation_mode == Some(crate::PreparationMode::SourceOnly)
            && !crate::preparation::source::eligible(port)
        {
            return Err(PortcoveError::verification(
                "source-only retained interpretation has no matching source owner",
            ));
        }
        if (self.format == 8)
            != catalog
                .port(&self.port_id)?
                .n64_runtime_at_executable_parent
        {
            return Err(PortcoveError::verification(
                "retained executable-parent N64 contract requires its matching envelope",
            ));
        }
        if self.format != 12 && (self.format == 7) != port.mod_package_policy.is_some() {
            return Err(PortcoveError::verification(
                "versioned mod package semantics require their retained interpretation envelope",
            ));
        }
        if self.format == 6
            && !crate::persistence::ready_staged_archive(catalog.port(&self.port_id)?)
        {
            return Err(PortcoveError::verification(
                "retained metadata-preserving envelope has no matching ready archive semantics",
            ));
        }
        Ok(())
    }

    /// Preserve the exact verified origin; never recapture authority from a catalog clone.
    pub(crate) fn for_ghostship_legacy_preparation(&self) -> Result<Self> {
        self.catalog("ghostship")?;
        if self.format == 4
            && self.preparation_mode == Some(crate::PreparationMode::Ghostship200Legacy)
        {
            // Rebinding the identical reviewed original preserves this single
            // interpretation, never another envelope around format 4.
            return Ok(self.clone());
        }
        if !matches!(self.format, 1..=3) {
            return Err(PortcoveError::verification(
                "legacy preparation cannot wrap an already prepared interpretation",
            ));
        }
        let mut prepared = self.clone();
        prepared.original_format = Some(self.format);
        prepared.preparation_mode = Some(crate::PreparationMode::Ghostship200Legacy);
        prepared.format = 4;
        prepared.catalog("ghostship")?;
        Ok(prepared)
    }

    pub(crate) fn for_source_only_preparation(&self) -> Result<Self> {
        let catalog = self.catalog(&self.port_id)?;
        if !crate::preparation::source::eligible(catalog.port(&self.port_id)?) {
            return Err(PortcoveError::unsupported(
                "retained definition has no source-only preparation owner",
            ));
        }
        if self.preparation_mode == Some(crate::PreparationMode::SourceOnly) {
            return Ok(self.clone());
        }
        if matches!(self.format, 11 | 12) {
            let mut prepared = self.clone();
            prepared.preparation_mode = Some(crate::PreparationMode::SourceOnly);
            prepared.catalog(&self.port_id)?;
            return Ok(prepared);
        }
        if !matches!(self.format, 1..=3) {
            return Err(PortcoveError::verification(
                "source-only preparation cannot wrap another interpretation",
            ));
        }
        let mut prepared = self.clone();
        prepared.original_format = Some(self.format);
        prepared.preparation_mode = Some(crate::PreparationMode::SourceOnly);
        prepared.format = 9;
        prepared.catalog(&self.port_id)?;
        Ok(prepared)
    }

    pub(crate) fn preparation_mode(&self) -> Option<crate::PreparationMode> {
        self.preparation_mode
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_linux_library_fences_only_the_creating_managed_runtime() {
        let catalog = Catalog::embedded().unwrap();
        let id = "diablo-devilutionx";
        let linux =
            InstalledContract::capture_for_platform(&catalog, id, Some(Platform::LinuxX86_64))
                .unwrap();
        assert_eq!(linux.format, 11);
        let prepared = linux.for_source_only_preparation().unwrap();
        assert_eq!(prepared.format, 11);
        let bytes = serde_json::to_vec(&prepared).unwrap();
        let reopened: InstalledContract = serde_json::from_slice(&bytes).unwrap();
        let reopened_catalog = reopened.catalog(id).unwrap();
        let recaptured = InstalledContract::capture_for_platform(
            &reopened_catalog,
            id,
            Some(Platform::LinuxX86_64),
        )
        .unwrap()
        .for_source_only_preparation()
        .unwrap();
        assert_eq!(serde_json::to_vec(&recaptured).unwrap(), bytes);
        assert_eq!(
            prepared.preparation_mode(),
            Some(crate::PreparationMode::SourceOnly)
        );
        assert_eq!(
            prepared
                .catalog(id)
                .unwrap()
                .port(id)
                .unwrap()
                .linux_packaged_library
                .as_deref(),
            Some("discord_game_sdk.so")
        );
        let mut downgraded = prepared;
        downgraded.format = 9;
        assert!(downgraded.catalog(id).is_err());

        let windows =
            InstalledContract::capture_for_platform(&catalog, id, Some(Platform::WindowsX86_64))
                .unwrap();
        let windows_catalog = windows.catalog(id).unwrap();
        let windows_port = windows_catalog.port(id).unwrap();
        assert_eq!(windows.format, 1);
        assert_eq!(windows_port.platforms, [Platform::WindowsX86_64]);
        assert!(windows_port.linux_packaged_library.is_none());
        assert_eq!(
            windows_port.executable_hints[&Platform::WindowsX86_64],
            ["devilutionx.exe"]
        );
        assert_eq!(windows.for_source_only_preparation().unwrap().format, 9);
        assert_eq!(
            serde_json::to_vec(&windows).unwrap(),
            serde_json::to_vec(
                &InstalledContract::capture_for_platform(
                    &windows_catalog,
                    id,
                    Some(Platform::WindowsX86_64),
                )
                .unwrap()
            )
            .unwrap(),
        );
        let unrelated = InstalledContract::capture(&catalog, "shipwright").unwrap();
        assert!(unrelated.catalog("shipwright").unwrap().port(id).is_err());
        assert!(!unrelated.catalog_json.contains("linux_packaged_library"));

        let previous_catalog = crate::test_fixture::retained_devilutionx_appimage_catalog();
        let previous = InstalledContract::capture_for_platform(
            &previous_catalog,
            id,
            Some(Platform::LinuxX86_64),
        )
        .unwrap()
        .for_source_only_preparation()
        .unwrap();
        assert_eq!(previous.format, 9);
        let previous_port = previous.catalog(id).unwrap().port(id).unwrap().clone();
        assert!(previous_port.linux_packaged_library.is_none());
        assert_eq!(
            previous_port.executable_hints[&Platform::LinuxX86_64],
            ["devilutionx.AppImage"]
        );
    }

    #[test]
    fn packaged_linux_library_projection_retains_only_qualified_platforms_present() {
        let mut document = Catalog::embedded().unwrap().authoritative_document();
        let id = "diablo-devilutionx";
        let port = document
            .ports
            .iter_mut()
            .find(|port| port.id == id)
            .unwrap();
        port.automated_tested_platforms = vec![Platform::WindowsX86_64, Platform::LinuxX86_64];
        port.manually_validated_platforms = port.automated_tested_platforms.clone();
        let sources = document.source_catalog.as_mut().unwrap();
        let contract = sources
            .contracts
            .iter()
            .find(|contract| contract.port_id == id)
            .unwrap();
        let profile = sources
            .identities
            .iter()
            .find(|profile| profile.id == contract.profile_id)
            .unwrap();
        let variant = profile
            .variants
            .iter()
            .find(|variant| contract.supported_variant_ids.contains(&variant.id))
            .unwrap();
        let binding = &contract.applicability[0];
        let mut qualification = sources.qualification[0].clone();
        qualification.method = "Synthetic retained-catalog projection fixture".into();
        qualification.scope.port_id = id.into();
        qualification.scope.platform = Platform::LinuxX86_64;
        qualification.scope.contract_id = Some(contract.id.clone());
        qualification.scope.upstream_ref = Some(binding.upstream_ref.clone());
        qualification.scope.artifact_sha256 = binding.artifact_sha256.clone();
        qualification.scope.variant = crate::SourceVariantScope::Exact {
            identity: crate::SourceIdentity {
                game_id: profile.id.clone(),
                variant_id: variant.id.clone(),
                representation_id: variant.representations[0].id.clone(),
            },
        };
        sources.qualification.push(qualification);
        let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();

        for (port_id, platform, keeps_linux_record) in [
            (id, Platform::LinuxX86_64, true),
            (id, Platform::WindowsX86_64, false),
            ("shipwright", Platform::LinuxX86_64, false),
        ] {
            let retained =
                InstalledContract::capture_for_platform(&catalog, port_id, Some(platform))
                    .unwrap()
                    .catalog(port_id)
                    .unwrap();
            assert_eq!(
                retained
                    .source_catalog()
                    .unwrap()
                    .qualification
                    .iter()
                    .any(|record| record.scope.port_id == id),
                keeps_linux_record,
            );
            if port_id == id {
                let port = retained.port(id).unwrap();
                let mut expected_platforms = vec![Platform::WindowsX86_64];
                if keeps_linux_record {
                    expected_platforms.push(Platform::LinuxX86_64);
                }
                assert_eq!(port.automated_tested_platforms, expected_platforms);
                assert_eq!(port.manually_validated_platforms, expected_platforms);
            }
        }
    }

    #[test]
    fn optional_game_settings_retain_exact_legacy_indexed_and_admitted_semantics() {
        let mut document = Catalog::embedded().unwrap().authoritative_document();
        let port = document
            .ports
            .iter_mut()
            .find(|port| port.id == "shipwright")
            .unwrap();
        port.game_settings = None;
        let basic = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let old = InstalledContract::capture(&basic, "shipwright").unwrap();
        assert!(
            old.catalog("shipwright")
                .unwrap()
                .port("shipwright")
                .unwrap()
                .game_settings
                .is_none()
        );
        assert!(
            serde_json::to_value(basic.port("shipwright").unwrap())
                .unwrap()
                .get("game_settings")
                .is_none()
        );

        let authored: serde_json::Value =
            serde_json::from_str(include_str!("../catalog/ports/shipwright.json")).unwrap();
        let expected = authored["integration"]["game_settings"].clone();
        let port = document
            .ports
            .iter_mut()
            .find(|port| port.id == "shipwright")
            .unwrap();
        port.game_settings = Some(serde_json::from_value(expected.clone()).unwrap());
        let configured = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        for catalog in [
            configured.clone(),
            crate::test_fixture::indexed_catalog(&configured, "shipwright"),
            crate::test_fixture::admitted_indexed_catalog(&configured, "shipwright"),
        ] {
            let retained = InstalledContract::capture(&catalog, "shipwright").unwrap();
            let bytes = serde_json::to_vec(&retained).unwrap();
            let restored: InstalledContract = serde_json::from_slice(&bytes).unwrap();
            let retained_catalog = restored.catalog("shipwright").unwrap();
            let actual = retained_catalog
                .port("shipwright")
                .unwrap()
                .game_settings
                .as_ref()
                .unwrap();
            assert_eq!(serde_json::to_value(actual).unwrap(), expected);
            assert_eq!(
                actual.files[0].settings[0].value.default_value(),
                serde_json::json!(40)
            );
            assert_eq!(
                serde_json::to_vec(
                    &InstalledContract::capture(&retained_catalog, "shipwright").unwrap()
                )
                .unwrap(),
                bytes
            );
        }
        // Advertising settings today never changes the already retained basic
        // contract, even when the port and offered release have the same names.
        assert!(
            old.catalog("shipwright")
                .unwrap()
                .port("shipwright")
                .unwrap()
                .game_settings
                .is_none()
        );
    }

    #[test]
    fn partitioned_archive_envelope_preserves_origins_and_refuses_downgraded_readers() {
        let embedded = Catalog::embedded().unwrap();
        for id in [
            "mega-man-x2-snes-recomp",
            "sonic-the-hedgehog-recomp",
            "super-metroid-recomp",
        ] {
            for catalog in [
                embedded.clone(),
                crate::test_fixture::indexed_catalog(&embedded, id),
                crate::test_fixture::admitted_indexed_catalog(&embedded, id),
            ] {
                let captured = InstalledContract::capture(&catalog, id).unwrap();
                assert_eq!(captured.format, 10);
                let bytes = serde_json::to_vec(&captured).unwrap();
                let decoded: InstalledContract = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(
                    serde_json::to_vec(
                        &InstalledContract::capture(&decoded.catalog(id).unwrap(), id).unwrap()
                    )
                    .unwrap(),
                    bytes
                );
                for format in 1..=9 {
                    let mut downgraded = decoded.clone();
                    downgraded.format = format;
                    if format < 4 {
                        downgraded.original_format = None;
                    }
                    assert!(downgraded.catalog(id).is_err(), "{id} format {format}");
                    decoded.catalog(id).unwrap(); // failed downgrade cannot poison the cache
                }
            }
        }
        let id = "alariq-mc2";
        let mut unrelated = InstalledContract::capture(&embedded, id).unwrap();
        assert_eq!(unrelated.format, 6);
        unrelated.format = 10;
        assert!(unrelated.catalog(id).is_err());
    }

    #[test]
    fn versioned_mod_envelope_preserves_all_origins_and_refuses_downgrades() {
        let original = crate::test_fixture::versioned_mod_catalog();
        let id = &original.ports()[0].id;
        for catalog in [
            original.clone(),
            crate::test_fixture::indexed_catalog(&original, id),
            crate::test_fixture::admitted_indexed_catalog(&original, id),
        ] {
            let captured = InstalledContract::capture(&catalog, id).unwrap();
            assert_eq!(captured.format, 7);
            let bytes = serde_json::to_vec(&captured).unwrap();
            let decoded: InstalledContract = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                serde_json::to_vec(
                    &InstalledContract::capture(&decoded.catalog(id).unwrap(), id).unwrap()
                )
                .unwrap(),
                bytes
            );
            for format in [1, 2, 3, 6] {
                let mut downgraded = decoded.clone();
                downgraded.format = format;
                if format < 4 {
                    downgraded.original_format = None;
                }
                assert!(downgraded.catalog(id).is_err());
                decoded.catalog(id).unwrap(); // rejected envelopes cannot poison a warm cache
            }
        }
        let mut old = original.authoritative_document();
        old.ports[0].mod_package_policy = None;
        let old = Catalog::from_json(&serde_json::to_string(&old).unwrap()).unwrap();
        let captured = InstalledContract::capture(&old, id).unwrap();
        assert_eq!(captured.format, 6);
        assert!(
            !serde_json::to_string(&captured)
                .unwrap()
                .contains("mod_package_policy")
        );
        captured.catalog(id).unwrap();
        let mut wrong = captured;
        wrong.format = 7;
        assert!(wrong.catalog(id).is_err());
    }

    #[test]
    fn executable_parent_n64_captures_fence_legacy_and_indexed_readers() {
        // Keep historical coordinates explicit when the live catalog advances.
        let mut historical = Catalog::embedded().unwrap().authoritative_document();
        let historical_port = historical
            .ports
            .iter_mut()
            .find(|p| p.id == "road-rash-64-recompiled")
            .unwrap();
        if let Some(root) = historical_port.runtime_subdirectory.take() {
            let prefix = format!("{root}/");
            historical_port.persistent_paths = historical_port
                .persistent_paths
                .iter()
                .map(|p| p.strip_prefix(&prefix).unwrap().to_owned())
                .collect();
        }
        historical_port.n64_runtime_at_executable_parent = false;
        historical_port.runtime_subdirectory = Some("historical-wrapper".into());
        historical_port.persistent_paths = historical_port
            .persistent_paths
            .iter()
            .map(|p| format!("historical-wrapper/{p}"))
            .collect();
        let original = Catalog::from_json(&serde_json::to_string(&historical).unwrap()).unwrap();
        let legacy = InstalledContract::capture(&original, "road-rash-64-recompiled").unwrap();
        let mut document = original.authoritative_document();
        let port = document
            .ports
            .iter_mut()
            .find(|p| p.id == "road-rash-64-recompiled")
            .unwrap();
        port.n64_runtime_at_executable_parent = true;
        let prefix = format!("{}/", port.runtime_subdirectory.take().unwrap());
        port.persistent_paths = port
            .persistent_paths
            .iter()
            .map(|p| p.strip_prefix(&prefix).unwrap().to_owned())
            .collect();
        port.portable_marker = true;
        let changed = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        for catalog in [
            changed.clone(),
            crate::test_fixture::indexed_catalog(&changed, "road-rash-64-recompiled"),
        ] {
            let contract = InstalledContract::capture(&catalog, "road-rash-64-recompiled").unwrap();
            assert_eq!(contract.format, 8);
            assert!(
                contract
                    .catalog("road-rash-64-recompiled")
                    .unwrap()
                    .port("road-rash-64-recompiled")
                    .unwrap()
                    .n64_runtime_at_executable_parent
            );
            let mut downgraded = contract.clone();
            downgraded.format = downgraded.original_format.take().unwrap();
            assert!(downgraded.catalog("road-rash-64-recompiled").is_err());
        }
        assert!(
            !legacy
                .catalog("road-rash-64-recompiled")
                .unwrap()
                .port("road-rash-64-recompiled")
                .unwrap()
                .n64_runtime_at_executable_parent
        );
        let mut wrong = legacy;
        wrong.original_format = Some(wrong.format);
        wrong.format = 8;
        assert!(wrong.catalog("road-rash-64-recompiled").is_err());
    }

    #[test]
    fn ready_archive_metadata_fence_preserves_origins_without_rewriting_history() {
        let embedded = Catalog::embedded().unwrap();
        for id in ["alariq-mc2", "crash-team-racing-ctr-native"] {
            for catalog in [
                embedded.clone(),
                crate::test_fixture::indexed_catalog(&embedded, id),
                crate::test_fixture::admitted_indexed_catalog(&embedded, id),
            ] {
                let contract = InstalledContract::capture(&catalog, id).unwrap();
                let value = serde_json::to_value(&contract).unwrap();
                assert_eq!(value["format"], 6);
                assert!(matches!(contract.original_format, Some(1..=3)));
                contract.catalog(id).unwrap();
                let mut historical = contract.clone();
                historical.format = historical.original_format.take().unwrap();
                historical.catalog(id).unwrap();
                assert_eq!(
                    historical.format,
                    value["original_format"].as_u64().unwrap() as u32
                );
                for invalid in [None, Some(4), Some(5), Some(6)] {
                    let mut malformed = contract.clone();
                    malformed.original_format = invalid;
                    assert!(malformed.catalog(id).is_err());
                }
            }
        }
        // A raw catalog shares its complete projection across identities. Even
        // a warmed decode cache must not confer this envelope on another route.
        let _ = InstalledContract::capture(&embedded, "alariq-mc2").unwrap();
        let mut wrong = InstalledContract::capture(&embedded, "fragglet-sdl-sopwith").unwrap();
        wrong.original_format = Some(wrong.format);
        wrong.format = 6;
        assert!(wrong.catalog("fragglet-sdl-sopwith").is_err());
    }

    #[test]
    fn legacy_preparation_preserves_all_three_verified_origins_and_rejects_invalid_envelopes() {
        let embedded = Catalog::embedded().unwrap();
        for catalog in [
            embedded.clone(),
            crate::test_fixture::indexed_catalog(&embedded, "ghostship"),
            crate::test_fixture::admitted_indexed_catalog(&embedded, "ghostship"),
        ] {
            let original = InstalledContract::capture(&catalog, "ghostship").unwrap();
            let before = serde_json::to_value(&original).unwrap();
            assert!(before.get("original_format").is_none());
            assert!(before.get("preparation_mode").is_none());
            let prepared = original.for_ghostship_legacy_preparation().unwrap();
            let after = serde_json::to_value(&prepared).unwrap();
            assert_eq!(after["format"], 4);
            assert_eq!(after["original_format"], before["format"]);
            for field in ["catalog_json", "definition", "admission", "port_id"] {
                assert_eq!(before.get(field), after.get(field), "{field}");
            }
            assert_eq!(
                serde_json::to_value(
                    prepared
                        .catalog("ghostship")
                        .unwrap()
                        .authoritative_document()
                )
                .unwrap(),
                serde_json::to_value(
                    original
                        .catalog("ghostship")
                        .unwrap()
                        .authoritative_document()
                )
                .unwrap()
            );
            assert_eq!(
                serde_json::to_value(prepared.for_ghostship_legacy_preparation().unwrap()).unwrap(),
                after
            );
            for (field, value) in [
                ("original_format", serde_json::Value::Null),
                ("original_format", serde_json::json!(4)),
                ("preparation_mode", serde_json::Value::Null),
                ("preparation_mode", serde_json::json!("default")),
                ("port_id", serde_json::json!("shipwright")),
            ] {
                let mut malformed = after.clone();
                malformed[field] = value;
                let decoded: InstalledContract = serde_json::from_value(malformed).unwrap();
                assert!(decoded.catalog("ghostship").is_err(), "{field}");
                // A rejected envelope cannot poison the pure decode cache.
                prepared.catalog("ghostship").unwrap();
            }
            let mut downgraded = prepared.clone();
            downgraded.format = original.format;
            assert!(downgraded.catalog("ghostship").is_err());
            let mut mode_on_original = original.clone();
            mode_on_original.preparation_mode = Some(crate::PreparationMode::Ghostship200Legacy);
            assert!(mode_on_original.catalog("ghostship").is_err());
            assert_eq!(serde_json::to_value(&original).unwrap(), before);
        }
        assert!(
            InstalledContract::capture(&embedded, "shipwright")
                .unwrap()
                .for_ghostship_legacy_preparation()
                .is_err()
        );
    }

    #[test]
    fn retained_initial_renderer_does_not_follow_later_catalog_choices() {
        let current = Catalog::embedded().unwrap();
        let mut legacy_document = current.authoritative_document();
        legacy_document
            .ports
            .iter_mut()
            .find(|port| port.id == "dr-mario-64-recomp")
            .unwrap()
            .n64_windows_initial_d3d12 = false;
        let legacy = Catalog::from_json(&serde_json::to_string(&legacy_document).unwrap()).unwrap();
        let contracts = [(&legacy, false), (&current, true)].map(|(catalog, expected)| {
            let captured = InstalledContract::capture(catalog, "dr-mario-64-recomp").unwrap();
            let restored: InstalledContract =
                serde_json::from_slice(&serde_json::to_vec(&captured).unwrap()).unwrap();
            (restored, expected)
        });
        // Alternate active/previous semantics through repeated reads. A cached
        // interpretation cannot follow the most recently decoded catalog.
        for index in [0, 1, 0, 1] {
            let (restored, expected) = &contracts[index];
            assert_eq!(
                restored
                    .catalog("dr-mario-64-recomp")
                    .unwrap()
                    .port("dr-mario-64-recomp")
                    .unwrap()
                    .n64_windows_initial_d3d12,
                *expected
            );
        }
    }

    #[test]
    fn exact_successor_bytes_survive_decode_and_recapture_without_canonical_replacement() {
        let original = Catalog::embedded().unwrap();
        let catalog = crate::test_fixture::indexed_catalog(&original, "zelda64-recomp");
        let contract = InstalledContract::capture(&catalog, "zelda64-recomp").unwrap();
        let bytes = serde_json::to_vec(&contract).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["format"], 2);
        assert!(value.get("catalog_json").is_none());
        for field in ["index_json", "entry_json", "contract_json"] {
            assert!(value["definition"][field].as_str().unwrap().contains('\n'));
        }
        let decoded: InstalledContract = serde_json::from_slice(&bytes).unwrap();
        let restored = decoded.catalog("zelda64-recomp").unwrap();
        assert_eq!(
            serde_json::to_value(restored.authoritative_document()).unwrap(),
            serde_json::to_value(crate::test_fixture::indexed_fixture_document_for_port(
                &original,
                "zelda64-recomp"
            ))
            .unwrap()
        );
        assert_eq!(
            serde_json::to_vec(&InstalledContract::capture(&restored, "zelda64-recomp").unwrap())
                .unwrap(),
            bytes
        );
        // An unselected port in the shared legacy graph never inherits this entry.
        let other = InstalledContract::capture(&catalog, "shipwright").unwrap();
        assert_eq!(other.format, 1);
        assert!(other.definition.is_none());
    }

    #[test]
    fn successor_records_reject_changed_bytes_identities_formats_and_mixed_authorities() {
        let catalog =
            crate::test_fixture::indexed_catalog(&Catalog::embedded().unwrap(), "zelda64-recomp");
        let contract = InstalledContract::capture(&catalog, "zelda64-recomp").unwrap();
        let original = serde_json::to_value(&contract).unwrap();
        for field in ["entry_json", "contract_json"] {
            let mut changed = original.clone();
            let text = changed["definition"][field].as_str().unwrap().to_owned() + " ";
            changed["definition"][field] = serde_json::json!(text);
            let decoded: InstalledContract = serde_json::from_value(changed).unwrap();
            assert!(decoded.catalog("zelda64-recomp").is_err());
        }
        for field in ["namespace", "stable_id"] {
            let mut changed = original.clone();
            changed["definition"][field] = serde_json::json!("wrong-identity");
            let decoded: InstalledContract = serde_json::from_value(changed).unwrap();
            assert!(decoded.catalog("zelda64-recomp").is_err());
        }
        let mut mixed = contract.clone();
        mixed.catalog_json = serde_json::to_string(&catalog.authoritative_document()).unwrap();
        assert!(mixed.catalog("zelda64-recomp").is_err());
        let mut downgraded = contract.clone();
        downgraded.format = 1;
        assert!(downgraded.catalog("zelda64-recomp").is_err());
        let mut missing = contract.clone();
        missing.definition = None;
        assert!(missing.catalog("zelda64-recomp").is_err());
        let mut future = contract;
        future.format = 4;
        assert!(future.catalog("zelda64-recomp").is_err());
        let mut unknown = original;
        unknown["definition"]["trusted"] = serde_json::json!(true);
        assert!(serde_json::from_value::<InstalledContract>(unknown).is_err());
    }

    #[test]
    fn cache_never_confuses_a_successor_snapshot_with_legacy_catalog_content() {
        let catalog =
            crate::test_fixture::indexed_catalog(&Catalog::embedded().unwrap(), "zelda64-recomp");
        let successor = InstalledContract::capture(&catalog, "zelda64-recomp").unwrap();
        successor.catalog("zelda64-recomp").unwrap();
        let impostor = InstalledContract {
            format: 1,
            original_format: None,
            preparation_mode: None,
            external_trust: None,
            port_id: "zelda64-recomp".into(),
            catalog_json: serde_json::to_string(successor.definition.as_ref().unwrap()).unwrap(),
            definition: None,
            admission: None,
        };
        assert!(impostor.catalog("zelda64-recomp").is_err());
        assert!(successor.catalog("zelda64-recomp").is_ok());
    }

    #[test]
    fn successor_content_bounds_and_index_agreement_are_rechecked_before_reuse() {
        use crate::definition_index::{MAX_CONTENT_BYTES, MAX_ENTRY_BYTES, MAX_INDEX_BYTES};

        let catalog =
            crate::test_fixture::indexed_catalog(&Catalog::embedded().unwrap(), "zelda64-recomp");
        let contract = InstalledContract::capture(&catalog, "zelda64-recomp").unwrap();
        let original = serde_json::to_value(&contract).unwrap();
        for (field, maximum) in [
            ("index_json", MAX_INDEX_BYTES),
            ("entry_json", MAX_ENTRY_BYTES),
            ("contract_json", MAX_CONTENT_BYTES as usize),
        ] {
            let mut changed = original.clone();
            changed["definition"][field] = serde_json::json!(" ".repeat(maximum + 1));
            let decoded: InstalledContract = serde_json::from_value(changed).unwrap();
            assert!(
                decoded
                    .catalog("zelda64-recomp")
                    .unwrap_err()
                    .message
                    .contains("bounds")
            );
        }
        let mut changed = original;
        let mut index: serde_json::Value =
            serde_json::from_str(changed["definition"]["index_json"].as_str().unwrap()).unwrap();
        index["definitions"][0]["revision"] = serde_json::json!(8);
        changed["definition"]["index_json"] =
            serde_json::json!(serde_json::to_string(&index).unwrap());
        let decoded: InstalledContract = serde_json::from_value(changed).unwrap();
        assert!(
            decoded
                .catalog("zelda64-recomp")
                .unwrap_err()
                .message
                .contains("identity differs")
        );
    }

    #[test]
    fn package_only_settings_are_scoped_to_the_selected_installation() {
        let catalog = Catalog::embedded().unwrap();
        let smw = "super-mario-world-recomp";
        let other = "zelda64-recomp";
        let unrelated = InstalledContract::capture(&catalog, other).unwrap();
        assert_eq!(unrelated.format, 1);
        let retained = unrelated.catalog(other).unwrap();
        assert!(retained.port(smw).unwrap().game_settings.is_none());
        assert!(
            retained
                .source_profile("super-mario-world-snes-usa")
                .is_ok()
        );

        let selected =
            InstalledContract::capture_for_platform(&catalog, smw, Some(Platform::WindowsX86_64))
                .unwrap();
        assert_eq!(selected.format, 12);
        assert!(package_only_settings(
            selected.catalog(smw).unwrap().port(smw).unwrap()
        ));
        let mut downgraded = selected.clone();
        downgraded.format = 6;
        assert!(downgraded.catalog(smw).is_err());

        let mut previous = catalog.authoritative_document();
        previous
            .ports
            .iter_mut()
            .find(|port| port.id == smw)
            .unwrap()
            .game_settings = None;
        let previous = Catalog::from_document(previous).unwrap();
        let historical = InstalledContract::capture(&previous, smw).unwrap();
        assert_eq!(historical.format, 6);
        assert!(
            historical
                .catalog(smw)
                .unwrap()
                .port(smw)
                .unwrap()
                .game_settings
                .is_none()
        );
    }

    #[test]
    fn unrelated_retention_excludes_new_native_relative_source_contracts() {
        let catalog = Catalog::embedded().unwrap();
        let stable = "zelda64-recomp";
        let newer = "doom-3-classic-dhewm3";
        let newer_profile = catalog
            .port(newer)
            .unwrap()
            .source_profile
            .as_deref()
            .unwrap();
        let captured = InstalledContract::capture(&catalog, stable).unwrap();
        let retained = captured.catalog(stable).unwrap();
        assert_eq!(
            InstalledContract::capture(&retained, stable)
                .unwrap()
                .catalog_json,
            captured.catalog_json,
        );

        assert!(retained.port(newer).is_err());
        assert!(retained.source_profile(newer_profile).is_err());
        assert_eq!(
            serde_json::to_value(retained.port(stable).unwrap()).unwrap(),
            serde_json::to_value(catalog.port(stable).unwrap()).unwrap(),
        );
        let stable_profile = catalog
            .port(stable)
            .unwrap()
            .source_profile
            .as_deref()
            .unwrap();
        assert_eq!(
            serde_json::to_value(retained.source_profile(stable_profile).unwrap()).unwrap(),
            serde_json::to_value(catalog.source_profile(stable_profile).unwrap()).unwrap(),
        );

        let own = InstalledContract::capture(&catalog, newer)
            .unwrap()
            .catalog(newer)
            .unwrap();
        assert_eq!(
            serde_json::to_value(own.source_profile(newer_profile).unwrap()).unwrap(),
            serde_json::to_value(catalog.source_profile(newer_profile).unwrap()).unwrap(),
        );
    }

    #[test]
    fn legacy_capture_keeps_only_the_installed_ports_loader() {
        let catalog = Catalog::embedded().unwrap();
        let unrelated = "opentyrian-opentyrian";
        let capture = |selected| InstalledContract::capture(&catalog, selected).unwrap();
        let contract = capture(unrelated);
        assert!(!contract.catalog_json.contains("\"mod_loader\""));
        let retained = contract.catalog(unrelated).unwrap();
        let mut pre_loader = catalog.authoritative_document();
        for port in &mut pre_loader.ports {
            port.mod_loader = None;
        }
        let pre_loader = Catalog::from_document(pre_loader).unwrap();
        assert_eq!(
            contract.catalog_json,
            InstalledContract::capture(&pre_loader, unrelated)
                .unwrap()
                .catalog_json,
        );

        for loader_port in [
            "shipwright",
            "2ship2harkinian",
            "zelda64-recomp",
            "banjo-recomp",
        ] {
            let mut expected = catalog.port(loader_port).unwrap().clone();
            assert!(expected.mod_loader.is_some(), "{loader_port}");
            let selected = capture(loader_port).catalog(loader_port).unwrap();
            assert_eq!(
                selected.port(loader_port).unwrap().mod_loader,
                expected.mod_loader
            );
            assert!(
                selected
                    .ports()
                    .iter()
                    .filter(|port| port.id != loader_port)
                    .all(|port| port.mod_loader.is_none())
            );
            expected.mod_loader = None;
            assert_eq!(
                serde_json::to_value(retained.port(loader_port).unwrap()).unwrap(),
                serde_json::to_value(expected).unwrap(),
            );
        }
    }

    #[test]
    fn unrelated_legacy_capture_keeps_shared_identity_without_optional_recognition() {
        let baseline = Catalog::embedded().unwrap();
        let optional_port = "zelda64-recomp";
        let legacy_port = "2ship2harkinian";
        let mut document = baseline.authoritative_document();
        let contract = document
            .source_catalog
            .as_mut()
            .unwrap()
            .contracts
            .iter_mut()
            .find(|contract| {
                contract.port_id == optional_port && contract.role == crate::PortSourceRole::Game
            })
            .unwrap();
        contract.variant_list_recognition_only = true;
        contract.applicability = vec![crate::SourceContractApplicability {
            upstream_ref: "fixture-v1".into(),
            artifact_sha256: Some("a".repeat(64)),
        }];
        let catalog = Catalog::from_document(document).unwrap();

        let captured = InstalledContract::capture(&catalog, legacy_port).unwrap();
        assert!(
            !captured
                .catalog_json
                .contains("variant_list_recognition_only")
        );
        let retained = captured.catalog(legacy_port).unwrap();
        assert!(retained.port(optional_port).is_err());
        assert_eq!(
            serde_json::to_value(retained.port(legacy_port).unwrap()).unwrap(),
            serde_json::to_value(baseline.port(legacy_port).unwrap()).unwrap(),
        );
        assert_eq!(
            serde_json::to_value(retained.source_profile("majoras-mask").unwrap()).unwrap(),
            serde_json::to_value(baseline.source_profile("majoras-mask").unwrap()).unwrap(),
        );
        let selected = InstalledContract::capture(&catalog, optional_port)
            .unwrap()
            .catalog(optional_port)
            .unwrap();
        assert!(
            selected
                .source_catalog()
                .unwrap()
                .contracts
                .iter()
                .any(|contract| {
                    contract.port_id == optional_port && contract.variant_list_recognition_only
                })
        );
    }

    #[test]
    fn catalog_growth_stays_within_supported_capacity() {
        use crate::signed_catalog::{CATALOG_SUPPORTED_CAPACITY_PERCENT, MAX_CATALOG_BYTES};

        let catalog = Catalog::embedded().unwrap();
        let projection = serde_json::to_vec(&serde_json::json!({
            "contract_schema": 1, "representation": "catalog_projection",
            "catalog": catalog.authoritative_document()
        }))
        .unwrap();
        let contract = InstalledContract::capture(&catalog, "zelda64-recomp").unwrap();
        assert!(contract.definition.is_none());
        let escaped = serde_json::to_vec(&contract).unwrap();
        let bundle = crate::test_fixture::indexed_catalog_bundle(&catalog, "zelda64-recomp");
        let index = crate::DefinitionContentIndex::parse(&bundle.index).unwrap();
        let definition = &index.definitions()[0];
        let content = |target| {
            bundle
                .contents
                .iter()
                .find(|(name, _)| name == target)
                .unwrap()
                .1
                .as_slice()
        };
        let entry = content(definition.target());
        let inspection = index
            .inspect_entry("official", "zelda64-recomp", entry)
            .unwrap();
        let indexed = index
            .inspect_catalog_projection(
                "official",
                "zelda64-recomp",
                entry,
                content(inspection.execution_contract()),
            )
            .unwrap();
        let snapshot =
            crate::definition_candidate::selection::publishable_snapshot_size(indexed.snapshot())
                .unwrap();
        for (measure, bytes, bound) in [
            (
                "escaped indexed selection snapshot",
                snapshot,
                crate::definition_candidate::selection::MAX_PUBLISHABLE_SNAPSHOT_BYTES,
            ),
            (
                "compact catalog projection",
                projection.len(),
                crate::definition_index::MAX_CONTENT_BYTES as usize,
            ),
            (
                "retained format-1 catalog_json",
                contract.catalog_json.len(),
                MAX_CATALOG_BYTES,
            ),
            (
                "escaped retained contract",
                escaped.len(),
                MAX_CATALOG_BYTES,
            ),
        ] {
            let ceiling = bound * CATALOG_SUPPORTED_CAPACITY_PERCENT / 100;
            println!(
                "{measure}: {bytes} bytes; ceiling {ceiling} ({CATALOG_SUPPORTED_CAPACITY_PERCENT}% of \
                 {bound}); headroom {}",
                ceiling as i64 - bytes as i64
            );
            assert!(
                bytes <= ceiling,
                "{measure} is {bytes} bytes, above {ceiling}"
            );
        }
    }

    #[test]
    fn retention_keeps_complete_legacy_catalog_and_source_graph_before_later_edits() {
        let mut legacy =
            crate::test_fixture::retained_devilutionx_appimage_catalog().authoritative_document();
        let newer_ports = [
            "doom-3-classic-dhewm3",
            "doom-3-resurrection-of-evil-classic-dhewm3",
        ];
        legacy
            .ports
            .retain(|port| !newer_ports.contains(&port.id.as_str()));
        let sources = legacy.source_catalog.as_mut().unwrap();
        sources.identities.retain(|identity| {
            !["doom-3-classic-pc-131-pk4", "doom-3-roe-classic-pc-131-pk4"]
                .contains(&identity.id.as_str())
        });
        sources
            .contracts
            .retain(|contract| !newer_ports.contains(&contract.port_id.as_str()));
        sources
            .qualification
            .retain(|record| !newer_ports.contains(&record.scope.port_id.as_str()));
        for port in &mut legacy.ports {
            if port.id != "zelda64-recomp" {
                port.mod_loader = None;
            }
            if package_only_settings(port) {
                port.game_settings = None;
            }
        }
        let original = Catalog::from_json(&serde_json::to_string(&legacy).unwrap()).unwrap();
        let contract = InstalledContract::capture(&original, "zelda64-recomp").unwrap();
        let mut changed = original.authoritative_document();
        let port = changed
            .ports
            .iter_mut()
            .find(|port| port.id == "zelda64-recomp")
            .unwrap();
        port.persistent_paths.push("replacement-saves".into());
        port.launch_arguments = vec!["changed-argument".into()];
        let changed = Catalog::from_json(&serde_json::to_string(&changed).unwrap()).unwrap();
        let retained = contract.catalog("zelda64-recomp").unwrap();
        assert_eq!(
            serde_json::to_value(retained.authoritative_document()).unwrap(),
            serde_json::to_value(original.authoritative_document()).unwrap()
        );
        assert_ne!(
            retained.port("zelda64-recomp").unwrap().persistent_paths,
            changed.port("zelda64-recomp").unwrap().persistent_paths
        );
        assert_ne!(
            retained.port("zelda64-recomp").unwrap().launch_arguments,
            changed.port("zelda64-recomp").unwrap().launch_arguments
        );
    }

    #[test]
    fn retained_content_rejects_unknown_semantics_identity_and_resource_overflow() {
        let catalog = Catalog::embedded().unwrap();
        let contract = InstalledContract::capture(&catalog, "shipwright").unwrap();
        assert!(contract.catalog("starship").is_err());
        let mut unknown = contract.clone();
        let mut value: serde_json::Value = serde_json::from_str(&unknown.catalog_json).unwrap();
        value["ports"][0]["arbitrary_setup_script"] = serde_json::json!("unrecognized");
        unknown.catalog_json = serde_json::to_string(&value).unwrap();
        assert!(
            unknown
                .catalog("shipwright")
                .unwrap_err()
                .message
                .contains("unsupported")
        );
        let mut future = contract.clone();
        future.format = 2;
        assert!(future.catalog("shipwright").is_err());
        let mut oversized = contract;
        oversized.catalog_json = " ".repeat(crate::signed_catalog::MAX_CATALOG_BYTES + 1);
        assert!(
            oversized
                .catalog("shipwright")
                .unwrap_err()
                .message
                .contains("bound")
        );
    }
}
