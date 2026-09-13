use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use portcove_desktop::application_update::{
    ApplicationChannel, ApplicationCompatibility, CandidateState, InstallOwner,
    InstalledApplicationContext, LibraryCompatibility, VersionRange,
};
use portcove_desktop::application_update_apply::{
    ApplicationTerminationKind, ApplicationUpdateApplyRequest, ApplicationUpdateApplyStore,
};
use portcove_desktop::application_update_helper::ApplicationUpdateFreshSelectionProvider;
use portcove_desktop::application_update_host::{
    ApplicationUpdateHostProvider, ApplicationUpdateRepositoryConfiguration,
    InstalledApplicationContextSource,
};
use portcove_desktop::application_update_preferences::{
    ApplicationUpdateChoice, ApplicationUpdateMode, ApplicationUpdatePreferenceStore,
};
use portcove_desktop::application_update_staging::ApplicationUpdateStagingStore;
use serde::Serialize;
use url::Url;

#[derive(Clone)]
struct FixedInstalledContext(InstalledApplicationContext);

impl InstalledApplicationContextSource for FixedInstalledContext {
    fn observe(&self) -> Result<InstalledApplicationContext, String> {
        Ok(self.0.clone())
    }
}

#[derive(Serialize)]
struct FixtureContract {
    installed: InstalledApplicationContext,
    compatibility: ApplicationCompatibility,
}

#[derive(Serialize)]
struct PreparedUpdate {
    apply_revision: u64,
    candidate_version: String,
    candidate_sha256: String,
    candidate_bytes: u64,
    installed: InstalledApplicationContext,
}

fn usage() -> &'static str {
    "usage: prepare_appimage_update describe CURRENT_VERSION\n       prepare_appimage_update prepare CURRENT_VERSION ROOT METADATA TARGETS CANDIDATE PREFERENCES STAGING LIBRARY"
}

fn canonical_kernel_version(value: &str) -> Result<String, String> {
    let mut parts = value
        .trim()
        .split(['.', '-'])
        .take(3)
        .map(|part| part.parse::<u64>());
    let major = parts
        .next()
        .transpose()
        .map_err(|error| error.to_string())?;
    let minor = parts
        .next()
        .transpose()
        .map_err(|error| error.to_string())?;
    let patch = parts
        .next()
        .transpose()
        .map_err(|error| error.to_string())?;
    match (major, minor) {
        (Some(major), Some(minor)) => Ok(format!("{major}.{minor}.{}", patch.unwrap_or(0))),
        _ => Err("Linux kernel version is unavailable".into()),
    }
}

fn installed_context(current_version: &str) -> Result<InstalledApplicationContext, String> {
    let kernel_release = Path::new(std::path::MAIN_SEPARATOR_STR)
        .join("proc")
        .join("sys")
        .join("kernel")
        .join("osrelease");
    let kernel = std::fs::read_to_string(kernel_release).map_err(|error| error.to_string())?;
    let catalog_format = portcove_core::Catalog::embedded()
        .map_err(|error| error.to_string())?
        .document()
        .schema_version;
    Ok(InstalledApplicationContext {
        current_version: current_version.into(),
        target: "linux-x86_64".into(),
        os: "linux".into(),
        os_version: canonical_kernel_version(&kernel)?,
        architecture: std::env::consts::ARCH.into(),
        execution_context: "user-owned-appimage".into(),
        package_kind: "appimage".into(),
        install_owner: InstallOwner::Portcove,
        product_id: "io.github.portcove.portcove".into(),
        capabilities: BTreeSet::from([portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.to_owned()]),
        cli_protocol: portcove_core::API_SCHEMA_VERSION,
        catalog_format,
        library_schema: portcove_core::MIN_LIBRARY_SCHEMA_VERSION,
        library_write_schema: portcove_core::LIBRARY_SCHEMA_VERSION,
        lock_protocol: portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.into(),
    })
}

fn fixture_contract(current_version: &str) -> Result<FixtureContract, String> {
    let installed = installed_context(current_version)?;
    let compatibility = ApplicationCompatibility {
        minimum_os_version: installed.os_version.clone(),
        required_capabilities: installed.capabilities.iter().cloned().collect(),
        cli_protocol: VersionRange {
            min: installed.cli_protocol,
            max: installed.cli_protocol,
        },
        catalog_formats: vec![installed.catalog_format],
        library: LibraryCompatibility {
            read: VersionRange {
                min: portcove_core::MIN_LIBRARY_SCHEMA_VERSION,
                max: portcove_core::LIBRARY_SCHEMA_VERSION,
            },
            write_schema: portcove_core::LIBRARY_SCHEMA_VERSION,
            lock_protocol: portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.into(),
        },
    };
    Ok(FixtureContract {
        installed,
        compatibility,
    })
}

fn directory_url(path: &Path) -> Result<Url, String> {
    Url::from_directory_path(path)
        .map_err(|_| format!("cannot convert {} to a file URL", path.display()))
}

async fn prepare(arguments: &[String]) -> Result<PreparedUpdate, String> {
    let [
        current_version,
        root,
        metadata,
        targets,
        candidate_path,
        preferences_path,
        staging_root,
        library_root,
    ] = arguments
    else {
        return Err(usage().into());
    };
    let contract = fixture_contract(current_version)?;
    let staging_root = PathBuf::from(staging_root);
    let repository = ApplicationUpdateRepositoryConfiguration::new(
        std::fs::read(root).map_err(|error| error.to_string())?,
        directory_url(Path::new(metadata))?,
        directory_url(Path::new(targets))?,
        staging_root.join("trust"),
    )
    .map_err(|error| error.to_string())?;
    let provider = ApplicationUpdateHostProvider::new(
        repository,
        Arc::new(FixedInstalledContext(contract.installed.clone())),
    );
    let choice = ApplicationUpdateChoice {
        channel: ApplicationChannel::Preview,
        mode: ApplicationUpdateMode::Automatic,
        paused: false,
    };
    let selected = provider
        .select(&choice)
        .await
        .map_err(|error| error.to_string())?;
    if selected.authenticated.selection.state != CandidateState::UpdateAvailable {
        return Err(format!(
            "fixture repository did not offer an update: {:?}",
            selected.authenticated.selection.state
        ));
    }
    let candidate = selected
        .authenticated
        .selection
        .candidate
        .ok_or_else(|| "fixture repository omitted its selected candidate".to_owned())?;
    let payload_key = selected
        .authenticated
        .payload_key
        .ok_or_else(|| "fixture repository omitted the selected payload key".to_owned())?;

    let preferences = ApplicationUpdatePreferenceStore::new(PathBuf::from(preferences_path))
        .map_err(|error| error.to_string())?;
    let current_preferences = preferences.load().map_err(|error| error.to_string())?;
    let saved_preferences = preferences
        .save_choice(current_preferences.revision, choice)
        .map_err(|error| error.to_string())?;
    let staging = ApplicationUpdateStagingStore::new(staging_root.clone())
        .map_err(|error| error.to_string())?;
    let mut payload = tokio::fs::File::open(candidate_path)
        .await
        .map_err(|error| error.to_string())?;
    let staged = staging
        .stage(&mut payload, &candidate, &payload_key)
        .await
        .map_err(|error| error.to_string())?;

    let library_root = PathBuf::from(library_root);
    std::fs::create_dir_all(&library_root).map_err(|error| error.to_string())?;
    let library = portcove_core::Library::open(&library_root).map_err(|error| error.to_string())?;
    let library_root = library.root().to_path_buf();
    drop(library);

    let apply =
        ApplicationUpdateApplyStore::new(staging_root).map_err(|error| error.to_string())?;
    let prepared = apply
        .prepare(
            &saved_preferences,
            &staged,
            &contract.installed,
            &library_root,
            ApplicationUpdateApplyRequest::RestartToApply,
        )
        .map_err(|error| error.to_string())?;
    let terminated = apply
        .record_termination(
            prepared.revision,
            ApplicationTerminationKind::RestartToApply,
        )
        .map_err(|error| error.to_string())?;
    Ok(PreparedUpdate {
        apply_revision: terminated.revision,
        candidate_version: candidate.release.version.clone(),
        candidate_sha256: candidate.release.artifact.sha256.clone(),
        candidate_bytes: candidate.release.artifact.bytes,
        installed: contract.installed,
    })
}

#[tokio::main]
async fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let result = match arguments.as_slice() {
        [command, current_version] if command == "describe" => fixture_contract(current_version)
            .and_then(|contract| {
                serde_json::to_string(&contract).map_err(|error| error.to_string())
            }),
        [command, rest @ ..] if command == "prepare" => prepare(rest).await.and_then(|prepared| {
            serde_json::to_string(&prepared).map_err(|error| error.to_string())
        }),
        _ => Err(usage().into()),
    };
    match result {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
