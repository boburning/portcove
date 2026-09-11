use crate::{ChildProcessClass, ChildProcessPolicy};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Preserve the last entered test phase when nextest terminates a slow process.
/// Labels contain fixture operations, never user paths or source contents.
pub(crate) fn phase<T>(label: &str, action: impl FnOnce() -> T) -> T {
    let started = std::time::Instant::now();
    eprintln!("test phase started: {label}");
    let result = action();
    eprintln!("test phase finished: {label} ({:?})", started.elapsed());
    result
}

/// Give synthetic installer fixtures the same complete retention input as a
/// production catalog operation, with their explicitly modified port contract.
pub(crate) fn retained_qualification(
    port: &crate::PortDefinition,
    platform: crate::Platform,
) -> crate::Result<crate::InstallQualification> {
    crate::InstallQualification::from_port(port, platform)?;
    let mut document = crate::Catalog::embedded()?.authoritative_document();
    if let Some(existing) = document.ports.iter_mut().find(|value| value.id == port.id) {
        *existing = port.clone();
    } else {
        document.ports.push(port.clone());
    }
    // A fixture may intentionally exercise only one host. Do not attach another
    // platform's historical qualification to that synthetic definition.
    if let Some(source) = &mut document.source_catalog {
        source.contracts.retain(|contract| {
            contract.port_id != port.id
                || match contract.role {
                    crate::PortSourceRole::Game => port.source_profile.as_ref(),
                    crate::PortSourceRole::Bios => port.bios_source_profile.as_ref(),
                }
                .is_some_and(|profile| *profile == contract.profile_id)
        });
        source.qualification.retain(|record| {
            record.scope.port_id != port.id
                || (port.platforms.contains(&record.scope.platform)
                    && record.scope.contract_id.as_ref().is_none_or(|id| {
                        source.contracts.iter().any(|contract| contract.id == *id)
                    }))
        });
    }
    let catalog = crate::Catalog::from_json(&serde_json::to_string(&document)?)?;
    crate::InstallQualification::from_catalog(&catalog, &port.id, platform)
}

/// Supply exact successor bytes for a synthetic lifecycle contract, without
/// publisher or artifact authority. No network or source acquisition occurs.
pub(crate) struct IndexedCatalogBundle {
    pub(crate) index: Vec<u8>,
    pub(crate) contents: Vec<(String, Vec<u8>)>,
}

pub(crate) fn indexed_catalog_bundle(
    catalog: &crate::Catalog,
    port_id: &str,
) -> IndexedCatalogBundle {
    use serde_json::json;
    use sha2::{Digest, Sha256};
    let target = |bytes: &[u8]| format!("sha256/{}.json", hex::encode(Sha256::digest(bytes)));
    let contract = serde_json::to_vec_pretty(&json!({
        "contract_schema":1,"representation":"catalog_projection",
        "catalog":catalog.authoritative_document()
    }))
    .unwrap();
    let leaf = target(&contract);
    let port = catalog.port(port_id).unwrap();
    let entry = serde_json::to_vec_pretty(&json!({
        "definition_schema":1,"namespace":"official","stable_id":port_id,"revision":7,
        "required_capabilities":[{"template":port.adapter,"minimum_version":1,"maximum_version":1}],
        "port":port,"source_contracts":[leaf],"execution_contract":leaf,"persistence_contract":leaf,
        "artifact_bindings":[],"evidence_references":[]
    }))
    .unwrap();
    let contents: Vec<_> = [&entry, &contract].into_iter().map(|bytes| json!({
        "target":target(bytes),"sha256":hex::encode(Sha256::digest(bytes)),"length":bytes.len()
    })).collect();
    let index = serde_json::to_vec_pretty(&json!({
        "index_schema":1,"definitions":[{"namespace":"official","stable_id":port_id,"revision":7,"target":target(&entry)}],
        "contents":contents
    }))
    .unwrap();
    IndexedCatalogBundle {
        index,
        contents: vec![(target(&entry), entry), (target(&contract), contract)],
    }
}

pub(crate) fn indexed_catalog(catalog: &crate::Catalog, port_id: &str) -> crate::Catalog {
    let bundle = indexed_catalog_bundle(catalog, port_id);
    let index = crate::DefinitionContentIndex::parse(&bundle.index).unwrap();
    let entry = &bundle.contents[0].1;
    let contract = &bundle.contents[1].1;
    index
        .inspect_catalog_projection("official", port_id, entry, contract)
        .unwrap()
        .catalog()
        .clone()
}

pub(crate) fn build_probe(directory: &Path) -> PathBuf {
    let executable = directory.join(if cfg!(windows) {
        "host_tool_probe.exe"
    } else {
        "host_tool_probe"
    });
    if let Some(prepared) = std::env::var_os("PORTCOVE_HOST_TOOL_FIXTURE") {
        fs::copy(prepared, &executable).unwrap();
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
        return executable;
    }
    let source = directory.join("host_tool_probe.rs");
    fs::write(&source, include_str!("testdata/host_tool_probe.rs.txt")).unwrap();
    let mut rustc =
        ChildProcessPolicy::native_command(ChildProcessClass::ManagedBuilder, "rustc").unwrap();
    assert!(
        rustc
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .status()
            .unwrap()
            .success()
    );
    crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
    executable
}
