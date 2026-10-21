use clap::{Args, Subcommand};
use portcove_core::{CatalogUpdateSource, PortcoveService, Result};
use std::path::PathBuf;

use crate::{
    OutputMode, human, progress_renderer, render_read_success, render_success, require_confirmation,
};

#[derive(Debug, Args)]
#[group(required = true, multiple = false)]
pub(crate) struct CatalogSourceArgs {
    /// Read a signed catalog from a local file.
    #[arg(long)]
    file: Option<PathBuf>,
    /// Download a signed catalog from an explicit HTTPS URL.
    #[arg(long)]
    url: Option<String>,
}

impl CatalogSourceArgs {
    fn source(self) -> CatalogUpdateSource {
        match self.file {
            Some(path) => CatalogUpdateSource::File(path),
            None => CatalogUpdateSource::Https(self.url.expect("clap requires one source")),
        }
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum CatalogCommand {
    /// List ports in the effective trusted catalog.
    List,
    /// Export the full effective catalog for machine consumers.
    Export,
    /// Show one port's channels, platform, and source requirements.
    Show { port_id: String },
    /// Check an inert requirements file against installed engine template versions.
    CheckCapabilities { file: PathBuf },
    /// Validate inert catalog declarations without changing the trusted catalog.
    InspectProposal { file: PathBuf },
    /// Inspect a fixed local managed-definition publication bundle without authority or library writes.
    InspectDefinitionPublication { directory: PathBuf },
    /// Interpret an inert upstream observation against the embedded catalog.
    InspectObservation {
        port_id: String,
        file: PathBuf,
        #[arg(long)]
        repository_id: u64,
    },
    /// Show effective provenance, public trust keys, and replay protection.
    Status,
    /// Review this release's fixed definition authority; apply requires exact consent.
    DefinitionAuthority {
        #[arg(long, requires = "expected_plan")]
        apply: bool,
        #[arg(long, requires = "apply")]
        expected_plan: Option<String>,
        #[arg(long, requires = "apply")]
        yes: bool,
    },
    /// Refresh one official definition under this release's installed fixed authority.
    DefinitionRefresh {
        stable_id: String,
        #[arg(long)]
        metadata_base_url: String,
        #[arg(long)]
        targets_base_url: String,
    },
    /// Trust a publisher's raw 32-byte Ed25519 public key, encoded as hex.
    TrustKey {
        public_key: String,
        #[arg(long)]
        yes: bool,
    },
    /// Revoke a trusted publisher key after reviewing the current state.
    RevokeKey {
        key_id: String,
        /// Require the current trust state to match the reviewed fingerprint.
        #[arg(long)]
        expected_state: String,
    },
    /// Review an explicitly selected signed catalog. Apply requires the review fingerprint.
    Update {
        #[command(flatten)]
        source: CatalogSourceArgs,
        #[arg(long, requires = "expected_plan")]
        apply: bool,
        #[arg(long, requires = "apply")]
        expected_plan: Option<String>,
    },
    /// Return to the previously trusted catalog after reviewing state.
    Rollback {
        #[arg(long)]
        expected_state: String,
    },
    /// Activate the last verified cached catalog after reviewing state.
    UseCached {
        #[arg(long)]
        expected_state: String,
    },
    /// Use the built-in catalog after reviewing state.
    UseEmbedded {
        #[arg(long)]
        expected_state: String,
    },
}

impl CatalogCommand {
    pub fn name(&self) -> &'static str {
        match self {
            Self::List => "catalog.list",
            Self::Export => "catalog.export",
            Self::Show { .. } => "catalog.show",
            Self::CheckCapabilities { .. } => "catalog.check-capabilities",
            Self::InspectProposal { .. } => "catalog.inspect-proposal",
            Self::InspectDefinitionPublication { .. } => "catalog.inspect-definition-publication",
            Self::InspectObservation { .. } => "catalog.inspect-observation",
            Self::Status => "catalog.status",
            Self::DefinitionAuthority { .. } => "catalog.definition-authority",
            Self::DefinitionRefresh { .. } => "catalog.definition-refresh",
            Self::TrustKey { .. } => "catalog.trust-key",
            Self::RevokeKey { .. } => "catalog.revoke-key",
            Self::Update { .. } => "catalog.update",
            Self::Rollback { .. } => "catalog.rollback",
            Self::UseCached { .. } => "catalog.use-cached",
            Self::UseEmbedded { .. } => "catalog.use-embedded",
        }
    }
}

pub(crate) async fn execute(
    command: CatalogCommand,
    service: &PortcoveService,
    mode: OutputMode,
    non_interactive: bool,
) -> Result<()> {
    let name = command.name();
    let library = service.library();
    match command {
        CatalogCommand::List => {
            render_read_success(mode, name, service.catalog().ports().to_vec(), |ports| {
                human::catalog_list(ports)
            })
        }
        CatalogCommand::Export => render_success(mode, name, service.catalog().document().clone()),
        CatalogCommand::Show { port_id } => render_read_success(
            mode,
            name,
            service.catalog().port(&port_id)?.clone(),
            human::catalog_show,
        ),
        CatalogCommand::Status => {
            render_read_success(mode, name, library.catalog_status()?, human::catalog_status)
        }
        CatalogCommand::DefinitionRefresh {
            stable_id,
            metadata_base_url,
            targets_base_url,
        } => {
            let source = portcove_core::DefinitionRepositorySource::new(
                &metadata_base_url,
                &targets_base_url,
            )?;
            let refreshed = service
                .refresh_definition(&source, &stable_id, progress_renderer(mode))
                .await?;
            render_read_success(mode, name, refreshed, |result| {
                let disposition = match result.disposition {
                    portcove_core::DefinitionRefreshDisposition::Revoked => {
                        "publisher revoked; existing selection retained"
                    }
                    portcove_core::DefinitionRefreshDisposition::Selected => {
                        "authenticated definition selected"
                    }
                    portcove_core::DefinitionRefreshDisposition::Ineligible => {
                        "definition unavailable; existing selection retained"
                    }
                };
                format!("Definition {}: {}", result.stable_id, disposition)
            })
        }
        CatalogCommand::DefinitionAuthority {
            apply,
            expected_plan,
            yes,
        } => {
            if apply {
                let review = library.review_definition_authority()?;
                if !review.configured {
                    return Err(portcove_core::PortcoveError::unsupported(
                        "this build has no configured definition authority",
                    ));
                }
                require_confirmation(
                    &format!(
                        "Install this release's fixed definition authority {} in library {}? Authenticated policy is still required for operations.",
                        review
                            .compiled_anchor_sha256
                            .as_deref()
                            .expect("configured anchor"),
                        review.library_id
                    ),
                    yes,
                    non_interactive,
                )?;
                render_success(
                    mode,
                    name,
                    library.provision_definition_authority(
                        &expected_plan.expect("clap requires the reviewed plan"),
                    )?,
                )
            } else {
                render_read_success(
                    mode,
                    name,
                    library.review_definition_authority()?,
                    |review| {
                        format!(
                            "Definition authority: {}\nInstalled: {}\nLibrary: {}\nReview plan: {}",
                            review
                                .compiled_anchor_sha256
                                .as_deref()
                                .unwrap_or("unconfigured"),
                            review.installed,
                            review.library_id,
                            review.expected_plan
                        )
                    },
                )
            }
        }
        CatalogCommand::InspectObservation { .. } => {
            unreachable!("observation inspection executes before opening a library")
        }
        CatalogCommand::CheckCapabilities { .. } => {
            unreachable!("capability inspection executes before opening a library")
        }
        CatalogCommand::InspectProposal { .. } => {
            unreachable!("proposal inspection executes before opening a library")
        }
        CatalogCommand::InspectDefinitionPublication { .. } => {
            unreachable!("publication inspection executes before opening a library")
        }
        CatalogCommand::TrustKey { public_key, yes } => {
            let key = portcove_core::CatalogTrustKey::from_public_key(&public_key)?;
            require_confirmation(
                &format!(
                    "Trust catalog publisher {} (public key {public_key})? It can change release download locations. Verify the key with its publisher first.",
                    key.key_id
                ),
                yes,
                non_interactive,
            )?;
            render_success(mode, name, library.trust_catalog_key(&public_key)?)
        }
        CatalogCommand::RevokeKey {
            key_id,
            expected_state,
        } => render_success(
            mode,
            name,
            library.revoke_catalog_key(&key_id, &expected_state)?,
        ),
        CatalogCommand::Rollback { expected_state } => {
            render_success(mode, name, library.rollback_catalog(&expected_state)?)
        }
        CatalogCommand::UseCached { expected_state } => {
            render_success(mode, name, library.use_cached_catalog(&expected_state)?)
        }
        CatalogCommand::UseEmbedded { expected_state } => {
            render_success(mode, name, library.use_embedded_catalog(&expected_state)?)
        }
        CatalogCommand::Update {
            source,
            apply,
            expected_plan,
        } => {
            let source = source.source();
            if apply {
                render_success(
                    mode,
                    name,
                    service
                        .apply_catalog_update(
                            &source,
                            &expected_plan.expect("clap requires a plan"),
                            progress_renderer(mode),
                        )
                        .await?,
                )
            } else {
                render_success(mode, name, service.plan_catalog_update(&source).await?)
            }
        }
    }
}
