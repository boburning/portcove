use clap::{Args, Subcommand};
use portcove_core::{CatalogUpdateSource, PortcoveService, Result};
use std::path::PathBuf;

use crate::{
    OutputMode, human, progress_renderer, render_read_success, render_success, require_confirmation,
};

mod render;
use render::{
    catalog_result, catalog_update_plan, definition_authority_result, definition_authority_review,
    definition_refresh,
};
pub(crate) use render::{
    definition_capabilities, proposal_inspection, publication_inspection, upstream_observation,
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
    /// List ports in the active catalog.
    List,
    /// Export the complete active catalog document.
    Export,
    /// Export every descriptive listing, including projects without a managed integration.
    Listings,
    /// Show one port's channels, platform, and source requirements.
    Show {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// Check an inert requirements file against installed engine template versions.
    CheckCapabilities {
        /// Inert capability-requirements JSON file to inspect without opening a library.
        file: PathBuf,
    },
    /// Validate inert catalog declarations without changing the trusted catalog.
    InspectProposal {
        /// Inert catalog proposal JSON file; inspection does not sign, trust or publish it.
        file: PathBuf,
    },
    /// Validate a lightweight listing projection without opening a library or trusting it.
    InspectListings {
        /// Inert versioned listings JSON file to inspect.
        #[arg(long)]
        path: PathBuf,
    },
    /// Inspect a fixed local managed-definition publication bundle without authority or library writes.
    InspectDefinitionPublication {
        /// Local fixed-definition publication bundle directory; inspection performs no library or authority writes.
        directory: PathBuf,
    },
    /// Interpret an inert upstream observation against the embedded catalog.
    InspectObservation {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Inert upstream observation JSON; inspected against the built-in catalog without opening a library.
        file: PathBuf,
        /// Expected numeric GitHub repository identity; the observation must describe this repository.
        #[arg(long)]
        repository_id: u64,
    },
    /// Show the active catalog, publisher keys, and rollback and replay protection.
    Status,
    /// Review this release's fixed definition authority; apply requires exact consent.
    DefinitionAuthority {
        /// Apply only the exact authority or catalog plan reviewed with this command.
        #[arg(long, requires = "expected_plan")]
        apply: bool,
        /// Complete plan fingerprint returned by this command's preview; changed inputs refuse the action.
        #[arg(long, requires = "apply")]
        expected_plan: Option<String>,
        /// Confirm the reviewed trust change without prompting; exact-plan checks still apply.
        #[arg(long, requires = "apply")]
        yes: bool,
    },
    /// Show authenticated descriptive directory selection and fallback reasons.
    ListingStatus,
    /// Refresh descriptive listings and artwork under the installed fixed catalog authority.
    ListingRefresh {
        #[arg(long)]
        metadata_base_url: String,
        #[arg(long)]
        targets_base_url: String,
    },
    /// Refresh one official definition under this release's installed fixed authority.
    DefinitionRefresh {
        /// Official definition ID to refresh under the already installed fixed publisher authority.
        stable_id: String,
        /// HTTPS base URL for signed repository metadata; the URL does not grant publisher authority.
        #[arg(long)]
        metadata_base_url: String,
        /// HTTPS base URL for authenticated definition targets; their hashes and publisher scope are still checked.
        #[arg(long)]
        targets_base_url: String,
    },
    /// Trust a publisher by its 64-character Ed25519 public key.
    #[command(
        after_help = "Verify the publisher key through a trusted channel before trusting it. Trust permits catalogs signed by that key to change port definitions and release download locations; it does not verify every executable or establish gameplay quality."
    )]
    TrustKey {
        /// Raw 32-byte Ed25519 public key encoded as exactly 64 hexadecimal characters.
        public_key: String,
        /// Confirm trusting this public key without prompting; verify its publisher through a trusted channel first.
        #[arg(long)]
        yes: bool,
    },
    /// Revoke a trusted publisher key after reviewing the current state.
    RevokeKey {
        /// Publisher key ID from `catalog status`; revocation may change the active fallback catalog.
        key_id: String,
        /// Require the current trust state to match the reviewed fingerprint.
        #[arg(long)]
        expected_state: String,
    },
    /// Review a signed catalog; apply requires the fingerprint returned by the preview.
    #[command(
        after_help = "First review catalog update --file PATH or --url HTTPS_URL. Then repeat the same source with --apply --expected-plan <plan-sha256>. Changed bytes, trust state, replay sequence or validity may require a new review. Updates change catalog definitions, not installed game files."
    )]
    Update {
        #[command(flatten)]
        source: CatalogSourceArgs,
        /// Apply only the exact authority or catalog plan reviewed with this command.
        #[arg(long, requires = "expected_plan")]
        apply: bool,
        /// Complete plan fingerprint returned by this command's preview; changed inputs refuse the action.
        #[arg(long, requires = "apply")]
        expected_plan: Option<String>,
    },
    /// Return to the previously trusted catalog after reviewing state.
    Rollback {
        /// Exact State SHA-256 from `catalog status`; changed trust or selection requires another review.
        #[arg(long)]
        expected_state: String,
    },
    /// Activate the last verified cached catalog after reviewing state.
    UseCached {
        /// Exact State SHA-256 from `catalog status`; changed trust or selection requires another review.
        #[arg(long)]
        expected_state: String,
    },
    /// Disable signed-catalog updates and use the built-in fallback after reviewing state.
    UseEmbedded {
        /// Exact State SHA-256 from `catalog status`; changed trust or selection requires another review.
        #[arg(long)]
        expected_state: String,
    },
}

impl CatalogCommand {
    pub fn name(&self) -> &'static str {
        match self {
            Self::List => "catalog.list",
            Self::Export => "catalog.export",
            Self::Listings => "catalog.listings",
            Self::Show { .. } => "catalog.show",
            Self::CheckCapabilities { .. } => "catalog.check-capabilities",
            Self::InspectProposal { .. } => "catalog.inspect-proposal",
            Self::InspectListings { .. } => "catalog.inspect-listings",
            Self::InspectDefinitionPublication { .. } => "catalog.inspect-definition-publication",
            Self::InspectObservation { .. } => "catalog.inspect-observation",
            Self::Status => "catalog.status",
            Self::DefinitionAuthority { .. } => "catalog.definition-authority",
            Self::ListingStatus => "catalog.listing-status",
            Self::ListingRefresh { .. } => "catalog.listing-refresh",
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
        CatalogCommand::Listings => render_read_success(
            mode,
            name,
            service.catalog().listing_document().clone(),
            |document| {
                document
                    .listings
                    .iter()
                    .map(|listing| {
                        format!(
                            "{}\t{}\t{}",
                            human::clean(&listing.id),
                            human::clean(&listing.name),
                            human::clean(&listing.project_url)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            },
        ),
        CatalogCommand::Show { port_id } => render_read_success(
            mode,
            name,
            service.catalog().port(&port_id)?.clone(),
            human::catalog_show,
        ),
        CatalogCommand::Status => {
            render_read_success(mode, name, library.catalog_status()?, human::catalog_status)
        }
        CatalogCommand::ListingStatus => {
            render_read_success(mode, name, library.listing_delivery_status()?, |value| {
                format!(
                    "Listing revision: {:?}; selected: {}; entries: {}",
                    value.revision, value.selected, value.listing_count
                )
            })
        }
        CatalogCommand::ListingRefresh {
            metadata_base_url,
            targets_base_url,
        } => {
            let source = portcove_core::DefinitionRepositorySource::new(
                &metadata_base_url,
                &targets_base_url,
            )?;
            let refreshed = service
                .refresh_listings(&source, progress_renderer(mode, service.catalog()))
                .await?;
            render_read_success(mode, name, refreshed, |value| {
                format!(
                    "Listing revision: {:?}; selected: {}; entries: {}",
                    value.revision, value.selected, value.listing_count
                )
            })
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
                .refresh_definition(
                    &source,
                    &stable_id,
                    progress_renderer(mode, service.catalog()),
                )
                .await?;
            render_read_success(mode, name, refreshed, definition_refresh)
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
                        human::clean(
                            review
                                .compiled_anchor_sha256
                                .as_deref()
                                .expect("configured anchor")
                        ),
                        human::clean(&review.library_id)
                    ),
                    yes,
                    non_interactive,
                )?;
                render_read_success(
                    mode,
                    name,
                    library.provision_definition_authority(
                        &expected_plan.expect("clap requires the reviewed plan"),
                    )?,
                    definition_authority_result,
                )
            } else {
                render_read_success(
                    mode,
                    name,
                    library.review_definition_authority()?,
                    definition_authority_review,
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
        CatalogCommand::InspectListings { .. } => {
            unreachable!("listing inspection executes before opening a library")
        }
        CatalogCommand::InspectDefinitionPublication { .. } => {
            unreachable!("publication inspection executes before opening a library")
        }
        CatalogCommand::TrustKey { public_key, yes } => {
            let key = portcove_core::CatalogTrustKey::from_public_key(&public_key)?;
            require_confirmation(
                &format!(
                    "Trust catalog publisher {} (public key {})? It can change release download locations. Verify the publisher key through a trusted channel before trusting it.",
                    human::clean(&key.key_id),
                    human::clean(&public_key)
                ),
                yes,
                non_interactive,
            )?;
            render_read_success(
                mode,
                name,
                library.trust_catalog_key(&public_key)?,
                |status| {
                    catalog_result(
                        &format!("Publisher key trusted: {}", human::clean(&key.key_id)),
                        status,
                    )
                },
            )
        }
        CatalogCommand::RevokeKey {
            key_id,
            expected_state,
        } => render_read_success(
            mode,
            name,
            library.revoke_catalog_key(&key_id, &expected_state)?,
            |status| {
                catalog_result(
                    &format!("Publisher key revoked: {}", human::clean(&key_id)),
                    status,
                )
            },
        ),
        CatalogCommand::Rollback { expected_state } => render_read_success(
            mode,
            name,
            library.rollback_catalog(&expected_state)?,
            |status| catalog_result("Signed-catalog rollback completed", status),
        ),
        CatalogCommand::UseCached { expected_state } => render_read_success(
            mode,
            name,
            library.use_cached_catalog(&expected_state)?,
            |status| catalog_result("Cached signed catalog enabled", status),
        ),
        CatalogCommand::UseEmbedded { expected_state } => render_read_success(
            mode,
            name,
            library.use_embedded_catalog(&expected_state)?,
            |status| {
                catalog_result(
                    "Signed-catalog updates disabled; built-in fallback selected",
                    status,
                )
            },
        ),
        CatalogCommand::Update {
            source,
            apply,
            expected_plan,
        } => {
            let source = source.source();
            if apply {
                render_read_success(
                    mode,
                    name,
                    service
                        .apply_catalog_update(
                            &source,
                            &expected_plan.expect("clap requires a plan"),
                            progress_renderer(mode, service.catalog()),
                        )
                        .await?,
                    |status| catalog_result("Signed catalog update committed", status),
                )
            } else {
                render_read_success(
                    mode,
                    name,
                    service.plan_catalog_update(&source).await?,
                    catalog_update_plan,
                )
            }
        }
    }
}
