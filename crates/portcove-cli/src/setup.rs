//! CLI presentation for Core-owned upstream package acquisition.
use clap::{Args, Subcommand};
use portcove_core::{CatalogDownloadRequest, PortcoveError, PortcoveService, Result};
use std::path::PathBuf;

use crate::{OutputMode, human, progress_renderer, render_read_success, require_confirmation};

#[derive(Debug, Args)]
pub(crate) struct DownloadSelection {
    /// Stable listing ID from catalog listings.
    port_id: String,
    /// Exact upstream release ID returned by setup candidates.
    #[arg(long)]
    release_id: u64,
    /// Exact upstream asset ID returned by setup candidates.
    #[arg(long)]
    asset_id: u64,
    /// Existing user-owned parent outside the Library and managed output locations.
    #[arg(long)]
    destination_parent: PathBuf,
    /// Safely extract a supported archive into the new folder; otherwise retain the package for upstream setup.
    #[arg(long)]
    extract: bool,
}

impl From<DownloadSelection> for CatalogDownloadRequest {
    fn from(value: DownloadSelection) -> Self {
        Self {
            port_id: value.port_id,
            release_id: value.release_id,
            asset_id: value.asset_id,
            destination_parent: value.destination_parent,
            extract_archive: value.extract,
        }
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum SetupCommand {
    /// Look up bounded upstream release assets without downloading or running them.
    Candidates { port_id: String },
    /// Review the exact asset and a fresh destination before downloading.
    Preview {
        #[command(flatten)]
        selection: DownloadSelection,
    },
    /// Download the reviewed package; finish upstream setup before selecting an executable.
    Download {
        #[command(flatten)]
        selection: DownloadSelection,
        /// SHA-256 returned by setup preview; changed bytes or destination require another review.
        #[arg(long)]
        expected_preview: String,
        /// Confirm this reviewed download without prompting.
        #[arg(long)]
        yes: bool,
    },
    /// Show downloaded packages that still need setup, including recovery attention.
    Pending,
    /// Forget the exact setup record; all handed-off game files remain in place.
    Forget {
        port_id: String,
        /// Exact record ID returned by setup pending.
        #[arg(long)]
        pending_id: String,
    },
}

impl SetupCommand {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Candidates { .. } => "setup.candidates",
            Self::Preview { .. } => "setup.preview",
            Self::Download { .. } => "setup.download",
            Self::Pending => "setup.pending",
            Self::Forget { .. } => "setup.forget",
        }
    }
}

pub(crate) async fn execute(
    command: SetupCommand,
    service: &PortcoveService,
    mode: OutputMode,
    non_interactive: bool,
) -> Result<()> {
    let name = command.name();
    match command {
        SetupCommand::Candidates { port_id } => render_read_success(
            mode,
            name,
            service.catalog_download_candidates(&port_id).await?,
            |result| {
                let mut lines = vec![format!("Upstream: {}", human::clean(&result.upstream_url))];
                if let Some(reason) = &result.reason {
                    lines.push(human::clean(reason));
                }
                for asset in &result.candidates {
                    lines.push(format!(
                        "release={} asset={}  {}  {} bytes  {}",
                        asset.release_id,
                        asset.asset_id,
                        human::clean(&asset.name),
                        asset.size,
                        human::clean(&asset.release_tag)
                    ));
                }
                lines.join("\n")
            },
        ),
        SetupCommand::Preview { selection } => render_read_success(
            mode,
            name,
            service.preview_catalog_download(&selection.into()).await?,
            preview_text,
        ),
        SetupCommand::Download {
            selection,
            expected_preview,
            yes,
        } => {
            let request = selection.into();
            let review = service.preview_catalog_download(&request).await?;
            if review.preview_sha256 != expected_preview {
                return Err(PortcoveError::conflict(
                    "download inputs changed; review them again",
                ));
            }
            if mode == OutputMode::Human {
                println!("{}", preview_text(&review));
            }
            require_confirmation(
                &format!(
                    "Download {} to {}? Finish setup using the upstream instructions, then explicitly select the executable. The handed-off folder stays user-owned.",
                    human::clean(&review.artifact.name),
                    review.destination_path.display()
                ),
                yes,
                non_interactive,
            )?;
            let pending = service
                .download_catalog_package(
                    &request,
                    &expected_preview,
                    progress_renderer(mode, service.catalog()),
                )
                .await?;
            render_read_success(mode, name, pending, |record| {
                format!(
                    "Downloaded—finish setup\nFolder: {}\nRecord: {}\nUse external select-preview after upstream setup.",
                    record.path.display(),
                    record.id
                )
            })
        }
        SetupCommand::Pending => {
            render_read_success(mode, name, service.pending_setups()?, |records| {
                records
                    .iter()
                    .map(|record| {
                        format!(
                            "{}\t{}\t{}{}",
                            human::clean(&record.port_id),
                            record.id,
                            record.path.display(),
                            record
                                .reason
                                .as_ref()
                                .map(|reason| format!("\n{}", human::clean(reason)))
                                .unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }
        SetupCommand::Forget {
            port_id,
            pending_id,
        } => {
            service.forget_pending_setup(&port_id, &pending_id)?;
            render_read_success(mode, name, (), |_| {
                "Setup record forgotten. Handed-off files remain in place.".into()
            })
        }
    }
}

fn preview_text(review: &portcove_core::CatalogDownloadPreview) -> String {
    format!(
        "Package: {} ({} bytes)\nRelease: {}\nFrom: {}\nDestination: {}\nExtract archive: {}\nUpstream SHA-256: {}\nPreview SHA-256: {}",
        human::clean(&review.artifact.name),
        review.artifact.size,
        human::clean(&review.artifact.release_tag),
        human::clean(&review.artifact.download_url),
        review.destination_path.display(),
        review.request.extract_archive,
        review
            .artifact
            .sha256
            .as_deref()
            .unwrap_or("not supplied; download hash will be recorded"),
        review.preview_sha256
    )
}
