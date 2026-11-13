//! CLI presentation for Core-owned upstream package acquisition.
use clap::{Args, Subcommand};
use portcove_core::{
    CatalogDownloadAssetId, CatalogDownloadReleaseId, CatalogDownloadRequest,
    CatalogForeignAssetId, CatalogForeignReleaseId, PortcoveError, PortcoveService, Result,
};
use std::path::PathBuf;

use crate::{OutputMode, human, progress_renderer, render_read_success, require_confirmation};

#[derive(Debug, Args)]
pub(crate) struct ReleaseSelection {
    /// Exact GitHub release ID returned by setup candidates.
    #[arg(long, conflicts_with_all = ["gitlab_project_id", "release_tag"], value_parser = clap::value_parser!(u64).range(1..))]
    release_id: Option<u64>,
    /// Exact GitLab project ID returned by setup candidates.
    #[arg(long, requires = "release_tag", value_parser = clap::value_parser!(u64).range(1..))]
    gitlab_project_id: Option<u64>,
    /// Exact published GitLab release tag, paired with --gitlab-project-id.
    #[arg(long, requires = "gitlab_project_id", allow_hyphen_values = true)]
    release_tag: Option<String>,
}

impl ReleaseSelection {
    fn reference(&self) -> Result<Option<CatalogDownloadReleaseId>> {
        match (
            self.release_id,
            self.gitlab_project_id,
            self.release_tag.as_deref(),
        ) {
            (Some(id), None, None) if id != 0 => Ok(Some(id.into())),
            (None, Some(project_id), Some(tag))
                if project_id != 0
                    && !tag.is_empty()
                    && tag.len() <= 512
                    && !tag.chars().any(char::is_control) =>
            {
                Ok(Some(CatalogDownloadReleaseId::Foreign(
                    CatalogForeignReleaseId::Gitlab {
                        project_id,
                        tag: tag.into(),
                    },
                )))
            }
            (None, None, None) => Ok(None),
            _ => Err(PortcoveError::usage(
                "select one exact GitHub release or GitLab project and tag",
            )),
        }
    }
}

#[derive(Debug, Args)]
pub(crate) struct DownloadSelection {
    /// Stable listing ID from catalog listings.
    port_id: String,
    #[command(flatten)]
    release: ReleaseSelection,
    /// Exact GitHub asset ID returned by setup candidates.
    #[arg(long, requires = "release_id", required_unless_present = "gitlab_link_id", conflicts_with_all = ["gitlab_project_id", "release_tag", "gitlab_link_id", "gitlab_file_id"], value_parser = clap::value_parser!(u64).range(1..))]
    asset_id: Option<u64>,
    /// Exact GitLab release link ID returned by setup candidates.
    #[arg(long, requires_all = ["gitlab_project_id", "gitlab_file_id"], value_parser = clap::value_parser!(u64).range(1..))]
    gitlab_link_id: Option<u64>,
    /// Exact GitLab registry file ID returned by setup candidates.
    #[arg(long, requires = "gitlab_link_id", value_parser = clap::value_parser!(u64).range(1..))]
    gitlab_file_id: Option<u64>,
    /// Existing user-owned parent outside the Library and managed output locations.
    #[arg(long)]
    destination_parent: PathBuf,
    /// Safely extract a supported archive into the new folder; otherwise retain the package for upstream setup.
    #[arg(long)]
    extract: bool,
}

impl TryFrom<DownloadSelection> for CatalogDownloadRequest {
    type Error = PortcoveError;

    fn try_from(value: DownloadSelection) -> Result<Self> {
        let release_id = value
            .release
            .reference()?
            .ok_or_else(|| PortcoveError::usage("an exact release is required"))?;
        let asset_id = match (
            &release_id,
            value.asset_id,
            value.gitlab_link_id,
            value.gitlab_file_id,
        ) {
            (CatalogDownloadReleaseId::Github(_), Some(id), None, None) if id != 0 => id.into(),
            (
                CatalogDownloadReleaseId::Foreign(CatalogForeignReleaseId::Gitlab {
                    project_id,
                    tag,
                }),
                None,
                Some(link_id),
                Some(file_id),
            ) if link_id != 0 && file_id != 0 => {
                CatalogDownloadAssetId::Foreign(CatalogForeignAssetId::Gitlab {
                    project_id: *project_id,
                    tag: tag.clone(),
                    link_id,
                    file_id,
                })
            }
            _ => {
                return Err(PortcoveError::usage(
                    "asset references must match one complete release provider",
                ));
            }
        };
        Ok(Self {
            port_id: value.port_id,
            release_id,
            asset_id,
            destination_parent: value.destination_parent,
            extract_archive: value.extract,
        })
    }
}

#[cfg(test)]
mod selector_tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct ParseSelection {
        #[command(flatten)]
        selection: DownloadSelection,
    }

    fn parse(flags: &[&str]) -> std::result::Result<ParseSelection, clap::Error> {
        ParseSelection::try_parse_from(
            ["selection", "listing", "--destination-parent", "."]
                .into_iter()
                .chain(flags.iter().copied()),
        )
    }

    #[test]
    fn setup_selectors_preserve_github_and_gitlab_identity() {
        let legacy: CatalogDownloadRequest = parse(&["--release-id", "7", "--asset-id", "11"])
            .unwrap()
            .selection
            .try_into()
            .unwrap();
        assert_eq!(legacy.release_id, 7);
        assert_eq!(legacy.asset_id, 11);
        let foreign: CatalogDownloadRequest = parse(&[
            "--gitlab-project-id",
            "42",
            "--release-tag",
            "v1/日本",
            "--gitlab-link-id",
            "11",
            "--gitlab-file-id",
            "17",
        ])
        .unwrap()
        .selection
        .try_into()
        .unwrap();
        assert_eq!(
            serde_json::to_value(&foreign.asset_id).unwrap(),
            serde_json::json!({
                "provider":"gitlab", "project_id":42, "tag":"v1/日本", "link_id":11, "file_id":17
            })
        );
        assert_ne!(foreign.asset_id, 11);
    }

    #[test]
    fn setup_selectors_refuse_partial_mixed_zero_and_invalid_references() {
        for flags in [
            vec![],
            vec!["--release-id", "7"],
            vec!["--asset-id", "11"],
            vec!["--release-id", "0", "--asset-id", "11"],
            vec!["--release-id", "7", "--asset-id", "0"],
            vec![
                "--gitlab-project-id",
                "42",
                "--release-tag",
                "v1",
                "--gitlab-link-id",
                "11",
            ],
            vec![
                "--gitlab-project-id",
                "42",
                "--release-tag",
                "v1",
                "--gitlab-file-id",
                "17",
            ],
            vec![
                "--gitlab-project-id",
                "42",
                "--release-tag",
                "v1",
                "--asset-id",
                "11",
            ],
            vec![
                "--release-id",
                "7",
                "--asset-id",
                "11",
                "--gitlab-project-id",
                "42",
                "--release-tag",
                "v1",
            ],
        ] {
            assert!(parse(&flags).is_err(), "{flags:?}");
        }
        for tag in ["", "v1\n"] {
            let selection = parse(&[
                "--gitlab-project-id",
                "42",
                "--release-tag",
                tag,
                "--gitlab-link-id",
                "11",
                "--gitlab-file-id",
                "17",
            ])
            .unwrap();
            assert!(CatalogDownloadRequest::try_from(selection.selection).is_err());
        }
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum SetupCommand {
    /// Look up bounded upstream release assets without downloading or running them.
    Candidates {
        /// Stable listing ID from `portcove catalog listings` whose upstream assets should be checked.
        port_id: String,
        #[command(flatten)]
        release: ReleaseSelection,
        /// Explicit stable or preview (beta); otherwise use the catalog recommendation.
        #[arg(long)]
        channel: Option<portcove_core::ReleaseChannel>,
    },
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
    /// Inspect a completed download without running files. Registration still requires review.
    Targets {
        /// Listing ID owning the completed download; use `portcove setup pending` to find it.
        port_id: String,
        /// Exact downloaded setup record ID returned by `portcove setup pending`.
        #[arg(long)]
        pending_id: String,
    },
    /// Forget the exact setup record; all handed-off game files remain in place.
    Forget {
        /// Listing ID owning the setup record; use `portcove setup pending` to find the matching record.
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
            Self::Targets { .. } => "setup.targets",
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
        SetupCommand::Candidates {
            port_id,
            release,
            channel,
        } => render_read_success(
            mode,
            name,
            service
                .catalog_download_options(
                    &port_id,
                    release.reference()?,
                    channel.unwrap_or(service.catalog_download_channel(&port_id)?),
                )
                .await?,
            |result| {
                let mut lines = vec![format!("Upstream: {}", human::clean(&result.upstream_url))];
                if let Some(reason) = &result.reason {
                    lines.push(human::clean(reason));
                }
                lines.push(human::clean(&result.recommendation_reason));
                if let Some(parent) = &result.default_destination_parent {
                    lines.push(format!("Suggested parent: {}", parent.display()));
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
                    if let Some(assessment) = result
                        .packages
                        .iter()
                        .find(|item| item.asset_id == asset.asset_id)
                    {
                        lines.push(format!(
                            "  {}{}: {}",
                            if result.recommended_asset_id.as_ref() == Some(&asset.asset_id) {
                                "Recommended · "
                            } else {
                                ""
                            },
                            assessment.suitability,
                            human::clean(&assessment.reason)
                        ));
                    }
                }
                lines.join("\n")
            },
        ),
        SetupCommand::Preview { selection } => render_read_success(
            mode,
            name,
            service
                .preview_catalog_download(&selection.try_into()?)
                .await?,
            preview_text,
        ),
        SetupCommand::Download {
            selection,
            expected_preview,
            yes,
        } => {
            let request = selection.try_into()?;
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
        SetupCommand::Targets {
            port_id,
            pending_id,
        } => render_read_success(
            mode,
            name,
            service.discover_setup_launch_targets(&port_id, &pending_id)?,
            |result| {
                let mut lines = vec![human::clean(&result.explanation)];
                for target in &result.candidates {
                    lines.push(format!(
                        "{}\n  Working directory: {}\n  {}",
                        target.executable.display(),
                        target.working_directory.display(),
                        human::clean(&target.reason)
                    ));
                }
                lines.join("\n")
            },
        ),
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
