use clap::{Args, Subcommand};
use portcove_core::{CatalogUpdateSource, PortcoveService, Result};
use std::path::PathBuf;

use crate::{
    OutputMode, human, progress_renderer, render_read_success, render_success, require_confirmation,
};

#[derive(Debug, Args)]
#[group(required = true, multiple = false)]
pub(crate) struct CatalogSourceArgs {
    #[arg(long)]
    file: Option<PathBuf>,
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
    List,
    Export,
    Show {
        port_id: String,
    },
    /// Show effective provenance, public trust keys, and replay protection.
    Status,
    /// Trust a publisher's raw 32-byte Ed25519 public key, encoded as hex.
    TrustKey {
        public_key: String,
        #[arg(long)]
        yes: bool,
    },
    RevokeKey {
        key_id: String,
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
    Rollback {
        #[arg(long)]
        expected_state: String,
    },
    UseCached {
        #[arg(long)]
        expected_state: String,
    },
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
            Self::Status => "catalog.status",
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
        CatalogCommand::Status => render_success(mode, name, library.catalog_status()?),
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
