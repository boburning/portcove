//! Explicit one-time data admission. Creating execution/source contracts remain
//! in their original installed envelope; this does not admit different bytes.
use crate::{Catalog, InstallRecord, PortDefinition, PortcoveError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Admission {
    pub operation_id: String,
    pub predecessor_manifest_sha256: String,
    pub authority: crate::installed_contract::InstalledContract,
}

fn held(message: &str) -> PortcoveError {
    PortcoveError::conflict(message)
        .with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged)
}

pub(crate) fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The exact creating port and its source applicability contract are independent
/// predecessor evidence. Presentation and historical source policy are frozen too.
pub(crate) fn creating_fingerprint(catalog: &Catalog, id: &str) -> Result<String> {
    let port = catalog.port(id)?;
    let contract = catalog.source_catalog().and_then(|sources| {
        sources
            .contracts
            .iter()
            .find(|contract| contract.port_id == id)
    });
    let mut value = serde_json::json!({"port":port,"source_contract":contract});
    value.sort_all_objects();
    Ok(crate::signed_catalog::digest(&serde_json::to_vec(&value)?))
}

pub(crate) fn validate_declaration(port: &PortDefinition) -> Result<()> {
    if let Some(admission) = &port.archive_data_transition_v1 {
        if port.archive_data_compatibility_v1.is_none()
            || !digest(&admission.predecessor_archive_sha256)
            || !digest(&admission.creating_contract_sha256)
            || port.runtime_source_filename.is_none()
            || port.runtime_source_hashes.is_empty()
            || port.source_profile.is_none()
        {
            return Err(PortcoveError::usage(
                "archive data transition needs an exact predecessor and a reviewed original-bound data policy",
            ));
        }
    }
    Ok(())
}

/// Compare only this data transition's unchanged source/execution coordinates.
/// Full predecessor fingerprint and exact artifact admission are checked first.
fn same_coordinates(old: &PortDefinition, new: &PortDefinition) -> bool {
    old.id == new.id
        && old.adapter == new.adapter
        && crate::persistence::ready_staged_archive(old)
        && crate::persistence::ready_staged_archive(new)
        && old.persistent_paths == new.persistent_paths
        && old.persistent_file_patterns == new.persistent_file_patterns
        && old.runtime_subdirectory == new.runtime_subdirectory
        && old.launch_from_install_root == new.launch_from_install_root
        && old.executable_hints == new.executable_hints
        && old.launch_arguments == new.launch_arguments
        && old.launch_environment == new.launch_environment
        && old.user_data_environment == new.user_data_environment
        && old.source_profile == new.source_profile
        && old.bios_source_profile == new.bios_source_profile
        && old.runtime_source_set == new.runtime_source_set
        && old.runtime_source_filename == new.runtime_source_filename
        && old.runtime_source_materialization == new.runtime_source_materialization
        && old.runtime_source_hashes == new.runtime_source_hashes
        && old.source_environment == new.source_environment
        && old.setup_marker == new.setup_marker
        && old.windows_temp_directory == new.windows_temp_directory
        && old.windows_runtime_path_policy == new.windows_runtime_path_policy
        && old.n64_runtime_at_executable_parent == new.n64_runtime_at_executable_parent
        && old.mod_package_policy == new.mod_package_policy
}

pub(crate) fn require_predecessor(
    install: &InstallRecord,
    creating: &Catalog,
    target: &PortDefinition,
) -> Result<()> {
    let expected = target
        .archive_data_transition_v1
        .as_ref()
        .ok_or_else(|| held("this definition does not admit a populated predecessor"))?;
    let old = creating.port(&install.port_id)?;
    if old.archive_data_compatibility_v1.is_some()
        || old.release.provider != crate::ReleaseSource::DirectManifest
        || install.artifact.sha256 != expected.predecessor_archive_sha256
        || creating_fingerprint(creating, &install.port_id)? != expected.creating_contract_sha256
        || !same_coordinates(old, target)
    {
        return Err(held(
            "the exact creating source, execution, data or archive contract is outside this reviewed transition; retain every runtime and data copy",
        ));
    }
    crate::archive_data::validate(target)
}

pub(crate) fn effective_port(
    install: &InstallRecord,
    creating: &Catalog,
    admission: &Admission,
) -> Result<PortDefinition> {
    if uuid::Uuid::parse_str(&admission.operation_id)
        .map(|id| id.to_string())
        .ok()
        .as_deref()
        != Some(admission.operation_id.as_str())
        || !digest(&admission.predecessor_manifest_sha256)
    {
        return Err(held(
            "archive data admission has an invalid original identity",
        ));
    }
    let authority = admission.authority.catalog(&install.port_id)?;
    let target = authority.port(&install.port_id)?;
    require_predecessor(install, creating, target)?;
    let mut effective = creating.port(&install.port_id)?.clone();
    effective.archive_data_compatibility_v1 = target.archive_data_compatibility_v1.clone();
    // Only the data mapping changes. Provider, original and execution fields stay exact.
    Ok(effective)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn historical(id: &str) -> Catalog {
        let old: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/direct-diagnostic-v26.json"))
                .unwrap();
        let mut current =
            serde_json::to_value(Catalog::embedded().unwrap().authoritative_document()).unwrap();
        let index = current["ports"]
            .as_array()
            .unwrap()
            .iter()
            .position(|p| p["id"] == id)
            .unwrap();
        current["ports"][index] = old["ports"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .unwrap()
            .clone();
        let index = current["source_catalog"]["contracts"]
            .as_array()
            .unwrap()
            .iter()
            .position(|p| p["port_id"] == id)
            .unwrap();
        current["source_catalog"]["contracts"][index] = old["source_contracts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["port_id"] == id)
            .unwrap()
            .clone();
        Catalog::from_json(&current.to_string()).unwrap()
    }
    #[test]
    fn declarations_bind_exact_historical_creating_contracts() {
        let current = Catalog::embedded().unwrap();
        let mut mismatches = Vec::new();
        for id in [
            "mega-man-x2-snes-recomp",
            "sonic-the-hedgehog-recomp",
            "super-metroid-recomp",
        ] {
            let creating = historical(id);
            let declared = current
                .port(id)
                .unwrap()
                .archive_data_transition_v1
                .as_ref()
                .unwrap();
            let actual = creating_fingerprint(&creating, id).unwrap();
            eprintln!(
                "{}",
                serde_json::json!({"kind":"historical-creating-contract-fingerprint","port_id":id,"sha256":actual})
            );
            if declared.creating_contract_sha256 != actual {
                mismatches.push(id);
            }
            assert_eq!(
                declared.predecessor_archive_sha256,
                creating.port(id).unwrap().release.direct[&crate::Platform::WindowsX86_64].sha256,
                "{id}"
            );
        }
        assert!(
            mismatches.is_empty(),
            "creating fingerprints differ: {mismatches:?}"
        );
    }
    #[test]
    fn admission_changes_only_data_and_rejects_foreign_archive_or_creating_contract() {
        let current = Catalog::embedded().unwrap();
        let id = "mega-man-x2-snes-recomp";
        let creating = historical(id);
        let target = current.port(id).unwrap();
        let mut install:InstallRecord=serde_json::from_value(serde_json::json!({"id":"controlled-install","port_id":id,"version":"v0.2.2","path":"controlled-runtime","channel":"stable","installed_at":1,"verified":true,"staged":false,"artifact":{"asset_name":"predecessor.zip","sha256":target.archive_data_transition_v1.as_ref().unwrap().predecessor_archive_sha256,"size":1}})).unwrap();
        let admission = Admission {
            operation_id: uuid::Uuid::new_v4().to_string(),
            predecessor_manifest_sha256: "a".repeat(64),
            authority: crate::installed_contract::InstalledContract::capture(&current, id).unwrap(),
        };
        let mut effective = effective_port(&install, &creating, &admission).unwrap();
        assert_eq!(
            effective.archive_data_compatibility_v1,
            target.archive_data_compatibility_v1
        );
        effective.archive_data_compatibility_v1 = None;
        assert_eq!(
            serde_json::to_value(effective).unwrap(),
            serde_json::to_value(creating.port(id).unwrap()).unwrap()
        );
        install.artifact.sha256 = "b".repeat(64);
        assert!(effective_port(&install, &creating, &admission).is_err());
        install.artifact.sha256 = target
            .archive_data_transition_v1
            .as_ref()
            .unwrap()
            .predecessor_archive_sha256
            .clone();
        let mut changed = serde_json::to_value(creating.authoritative_document()).unwrap();
        let index = changed["ports"]
            .as_array()
            .unwrap()
            .iter()
            .position(|p| p["id"] == id)
            .unwrap();
        changed["ports"][index]["summary"] = serde_json::json!("A different retained contract.");
        let changed = Catalog::from_json(&changed.to_string()).unwrap();
        assert!(effective_port(&install, &changed, &admission).is_err());
    }
}
