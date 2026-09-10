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
