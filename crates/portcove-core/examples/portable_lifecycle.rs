//! Explicit real-package observation, separate from deterministic offline tests.
//! Baseline release facts must carry an independently published expected digest.
//! No native process or original game input is executed by this example.
use std::{io::Read, path::PathBuf, sync::Arc};

use portcove_core::{
    GithubReleaseProvider, Library, Platform, PortDefinition, PortcoveError, PortcoveService,
    ReleaseChannel, ReleaseProvider, ResolvedRelease, Result,
};

struct Baseline(ResolvedRelease);

#[async_trait::async_trait]
impl ReleaseProvider for Baseline {
    async fn resolve(
        &self,
        _port: &PortDefinition,
        channel: ReleaseChannel,
        _platform: Platform,
    ) -> Result<ResolvedRelease> {
        let mut release = self.0.clone();
        release.channel = channel;
        Ok(release)
    }
}

fn main() -> Result<()> {
    // Match the existing CLI's Windows stack allowance for Core async operations.
    match std::thread::Builder::new()
        .name("portable-evidence".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(run)?
        .join()
    {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::main]
async fn run() -> Result<()> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        return Err(PortcoveError::usage(
            "portable_lifecycle PORT_ID BASELINE_RELEASE_JSON NEW_LIBRARY",
        ));
    }
    let port_id = args[0]
        .to_str()
        .ok_or_else(|| PortcoveError::usage("port ID must be Unicode"))?;
    let root = PathBuf::from(&args[2]);
    if root.exists() {
        return Err(PortcoveError::conflict(
            "use a new isolated library; existing evidence is preserved",
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&args[1])?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 {
        return Err(PortcoveError::usage("baseline release facts exceed 64 KiB"));
    }
    let baseline: ResolvedRelease = serde_json::from_slice(&bytes)?;
    let library = Library::open(&root)?;
    let initial = PortcoveService::with_provider(library.clone(), Arc::new(Baseline(baseline)))?;
    eprintln!("Installing the explicitly selected baseline package");
    let first = initial
        .install(port_id, None, None, None, true, |_| {})
        .await?;
    // The replacement uses the normal GitHub provider and unchanged catalog facts.
    let current = PortcoveService::with_provider(
        library.clone(),
        Arc::new(GithubReleaseProvider::for_library(&library)?),
    )?;
    let check = current.check_update(port_id).await?;
    if !check.update_available {
        return Err(PortcoveError::conflict(
            "baseline did not establish a real available transition",
        ));
    }
    eprintln!("Applying the release selected by the normal GitHub provider");
    let second = current.update(port_id, None, None, true, |_| {}).await?;
    current.verify(port_id)?;
    let before_rollback = current.status(port_id)?;
    let rolled_back = current.rollback(port_id)?;
    current.verify(port_id)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "evidence": "real upstream bytes through production Core install, GitHub update selection, activation, verification and rollback; baseline metadata explicitly supplied",
            "baseline": first, "update_check": check, "replacement": second,
            "status_after_update": before_rollback, "rolled_back": rolled_back,
            "gameplay": "not run", "native_setup_launch": "not run",
            "data_preservation": "declared-data behavior is separately exercised by deterministic lifecycle fixtures; external application data is not migrated by this example"
        }))?
    );
    Ok(())
}
