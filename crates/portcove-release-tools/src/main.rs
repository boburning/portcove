use clap::{Parser, Subcommand};
use portcove_release_tools::{
    definition_repository::DefinitionOnlineRole, tuf_repository::isolated::OnlineRole,
};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "portcove-release-tools",
    about = "Verify release artifacts and manage authorized release metadata"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Verify {
        artifact: PathBuf,
        signature: PathBuf,
        public_key: PathBuf,
        sha256: String,
        bytes: u64,
    },
    SignOfflineDefinitionTargets {
        config: PathBuf,
    },
    AssembleDefinitionRepository {
        config: PathBuf,
    },
    VerifyDefinitionRepository {
        config: PathBuf,
    },
    SignDefinitionRole {
        /// targets, official-definitions, official-policy, snapshot or timestamp.
        #[arg(value_parser = DefinitionOnlineRole::parse)]
        role: DefinitionOnlineRole,
        config: PathBuf,
    },
    InspectCatalogKeyInventory {
        config: PathBuf,
    },
    InspectExistingPayloadKey {
        config: PathBuf,
    },
    InspectExistingTufKey {
        config: PathBuf,
    },
    CreateOfflineKey {
        config: PathBuf,
    },
    SignOfflineRoot {
        config: PathBuf,
    },
    SignOfflineTargets {
        config: PathBuf,
    },
    PrepareOfflineRoot {
        config: PathBuf,
    },
    FinalizeOfflineRoot {
        config: PathBuf,
    },
    InspectTufBootstrap {
        config: PathBuf,
    },
    InspectTufContext {
        config: PathBuf,
    },
    PrepareTufRenewal {
        config: PathBuf,
    },
    SignTufRole {
        /// targets, releases, preview, stable, snapshot or timestamp.
        #[arg(value_parser = OnlineRole::parse)]
        role: OnlineRole,
        config: PathBuf,
    },
    AssembleTuf {
        config: PathBuf,
    },
    BuildTuf {
        config: PathBuf,
    },
}

fn main() {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            // Existing automation expects errors on stderr and status 1, rather
            // than Clap's default status 2. Generated help is successful stdout.
            let failed = error.use_stderr();
            if error.kind() == clap::error::ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand {
                // Both controller build fixtures consume the lowercase usage marker.
                let usage = error.render().to_string().replacen(
                    "\nUsage: portcove-release-tools",
                    "\nusage: portcove-release-tools",
                    1,
                );
                eprint!("{usage}");
            } else {
                let _ = error.print();
            }
            std::process::exit(i32::from(failed));
        }
    };
    if let Err(error) = run(cli.command) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run(command: Command) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        Command::Verify {
            artifact,
            signature,
            public_key,
            sha256,
            bytes,
        } => {
            let result = portcove_release_tools::verify_artifact(
                &artifact,
                &signature,
                &public_key,
                &sha256,
                bytes,
            )?;
            println!("{}", serde_json::to_string(&result)?);
        }
        Command::SignOfflineDefinitionTargets { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::definition_repository::sign_offline_definition_targets(
                    &config,
                ),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::AssembleDefinitionRepository { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::definition_repository::assemble_definition_repository(
                    &config,
                ),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::VerifyDefinitionRepository { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::definition_repository::verify_definition_repository(
                    &config,
                ),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::SignDefinitionRole { role, config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::definition_repository::sign_definition_role(role, &config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::InspectCatalogKeyInventory { config } => {
            let report =
                portcove_release_tools::definition_repository::inspect_catalog_key_inventory(
                    &config,
                )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::InspectExistingPayloadKey { config } => {
            let report =
                portcove_release_tools::tuf_repository::payload_key::inspect_existing_key(&config)?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::InspectExistingTufKey { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::offline_key::inspect_existing_key(&config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::CreateOfflineKey { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::offline_key::create_one_key(&config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::SignOfflineRoot { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::offline::sign_initial_root(&config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::SignOfflineTargets { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::offline::sign_initial_targets(&config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::PrepareOfflineRoot { config } => {
            let _runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report =
                portcove_release_tools::tuf_repository::offline::prepare_initial_root(&config)?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::FinalizeOfflineRoot { config } => {
            let _runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report =
                portcove_release_tools::tuf_repository::offline::finalize_initial_root(&config)?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::InspectTufBootstrap { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::isolated::inspect_tuf_bootstrap(&config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::InspectTufContext { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::isolated::inspect_tuf_context(&config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::PrepareTufRenewal { config } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::isolated::prepare_tuf_renewal(&config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::SignTufRole { role, config } => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::isolated::sign_tuf_role(role, &config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::AssembleTuf { config } => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::isolated::assemble_tuf_repository(&config),
            )?;
            println!("{}", serde_json::to_string(&report)?);
        }
        Command::BuildTuf { config } => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            let report = runtime
                .block_on(portcove_release_tools::tuf_repository::build_tuf_repository(&config))?;
            println!("{}", serde_json::to_string(&report)?);
        }
    }
    Ok(())
}
