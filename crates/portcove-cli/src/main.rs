use std::{
    io::{self, Read, Write},
    path::PathBuf,
    process::ExitCode,
};

use clap::{Args, Parser, Subcommand, ValueEnum, error::ErrorKind};
use portcove_core::{
    API_SCHEMA_VERSION, ActivityRecord, AdoptionPreview, BackupAction, BackupActionPreview,
    BackupRecord, CapabilityDocument, CatalogDocument, DoctorReport, ErrorCode, GithubAuthStatus,
    GithubDeviceLogin, GithubDeviceLoginResult, GithubDeviceLoginState, GithubReleaseProvider,
    InstallPlan, InstallRecord, LaunchSignal, LaunchStdio, OperationEvent, OperationEventKind,
    PortDefinition, PortPaths, PortRemovalPreview, PortStatus, PortcoveError, PortcoveService,
    ReconcileResult, ReleaseChannel, RestoreResult, Result, SourceRecord, SourceRemovalPreview,
    SourceVerification, StorageSummary, UpdateCheck, UpdatePolicy, UpdateSnapshot,
    forward_launch_signal,
};
use schemars::{JsonSchema, schema_for};
use serde::Serialize;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "portcove",
    version,
    about = "Curated native PC port manager",
    after_help = "Native ports. Verified releases. Local sources."
)]
struct Cli {
    #[arg(long, global = true, env = "PORTCOVE_LIBRARY")]
    library: Option<PathBuf>,
    #[arg(long, global = true, conflicts_with = "jsonl")]
    json: bool,
    #[arg(long, global = true, conflicts_with = "json")]
    jsonl: bool,
    #[arg(long, global = true)]
    non_interactive: bool,
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    verbose: u8,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    Backup {
        #[command(subcommand)]
        command: BackupCommand,
    },
    Catalog {
        #[command(subcommand)]
        command: CatalogCommand,
    },
    Source {
        #[command(subcommand)]
        command: SourceCommand,
    },
    Status {
        port_id: Option<String>,
    },
    Activity {
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=200))]
        limit: u16,
    },
    Storage,
    Doctor,
    About,
    Plan {
        port_id: String,
        #[arg(long, value_enum)]
        channel: Option<ChannelArg>,
    },
    Paths {
        port_id: String,
    },
    Check(UpdateTargetArgs),
    Reconcile(UpdateTargetArgs),
    Install(InstallArgs),
    Adopt(AdoptArgs),
    Ensure(EnsureArgs),
    Update(UpdateArgs),
    Verify {
        port_id: String,
    },
    Activate {
        port_id: String,
    },
    Rollback {
        port_id: String,
    },
    Remove {
        port_id: String,
        #[arg(long)]
        yes: bool,
    },
    Channel {
        #[command(subcommand)]
        command: ChannelCommand,
    },
    Policy {
        #[command(subcommand)]
        command: PolicyCommand,
    },
    Exec(ExecArgs),
    Capabilities,
    Schema {
        #[command(subcommand)]
        command: SchemaCommand,
    },
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    Status,
    Login,
    SetToken {
        #[arg(
            long,
            help = "Read the token from standard input without placing it in argv"
        )]
        stdin: bool,
    },
    Logout,
}

#[derive(Debug, Subcommand)]
enum BackupCommand {
    Create {
        port_id: String,
    },
    List {
        port_id: String,
    },
    Delete {
        port_id: String,
        backup_id: String,
        #[arg(long)]
        yes: bool,
    },
    Restore {
        port_id: String,
        backup_id: String,
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Subcommand)]
enum CatalogCommand {
    List,
    Export,
    Show { port_id: String },
}

#[derive(Debug, Subcommand)]
enum SourceCommand {
    Add {
        profile_id: String,
        path: PathBuf,
    },
    List,
    Verify(SourceVerifyArgs),
    Remove {
        profile_id: String,
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Args)]
struct SourceVerifyArgs {
    profile_id: Option<String>,
    #[arg(long, conflicts_with = "profile_id")]
    all: bool,
}

#[derive(Debug, Args)]
struct InstallArgs {
    port_id: String,
    #[arg(long, value_enum)]
    channel: Option<ChannelArg>,
    #[arg(long)]
    source: Option<PathBuf>,
    #[arg(long)]
    bios: Option<PathBuf>,
    #[arg(long)]
    stage: bool,
}

#[derive(Debug, Args)]
struct EnsureArgs {
    port_id: String,
    #[arg(long, value_enum)]
    channel: Option<ChannelArg>,
    #[arg(long)]
    source: Option<PathBuf>,
    #[arg(long)]
    bios: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct UpdateArgs {
    port_id: Option<String>,
    #[arg(long, conflicts_with = "port_id")]
    all: bool,
    #[arg(long)]
    source: Option<PathBuf>,
    #[arg(long)]
    bios: Option<PathBuf>,
    #[arg(long)]
    stage: bool,
}

#[derive(Debug, Args)]
struct UpdateTargetArgs {
    port_id: Option<String>,
    #[arg(long, conflicts_with = "port_id")]
    all: bool,
}

#[derive(Debug, Args)]
struct AdoptArgs {
    path: PathBuf,
    #[arg(long)]
    port: Option<String>,
    #[arg(long)]
    yes: bool,
}

#[derive(Debug, Args)]
struct ExecArgs {
    port_id: String,
    #[arg(long)]
    source: Option<PathBuf>,
    #[arg(last = true, allow_hyphen_values = true)]
    game_args: Vec<String>,
}

#[derive(Debug, Subcommand)]
enum ChannelCommand {
    Set {
        port_id: String,
        #[arg(value_enum)]
        channel: ChannelArg,
    },
}

#[derive(Debug, Subcommand)]
enum PolicyCommand {
    Set {
        port_id: String,
        #[arg(value_enum)]
        policy: PolicyArg,
    },
}

#[derive(Debug, Subcommand)]
enum SchemaCommand {
    Export,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ChannelArg {
    Stable,
    Beta,
    Rolling,
}

impl From<ChannelArg> for ReleaseChannel {
    fn from(value: ChannelArg) -> Self {
        match value {
            ChannelArg::Stable => Self::Stable,
            ChannelArg::Beta => Self::Beta,
            ChannelArg::Rolling => Self::Rolling,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum PolicyArg {
    Notify,
    Stage,
    Automatic,
}

impl From<PolicyArg> for UpdatePolicy {
    fn from(value: PolicyArg) -> Self {
        match value {
            PolicyArg::Notify => Self::Notify,
            PolicyArg::Stage => Self::Stage,
            PolicyArg::Automatic => Self::Automatic,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    Human,
    Json,
    Jsonl,
}

#[derive(Debug, Serialize, JsonSchema)]
struct ApiResponse<T: JsonSchema> {
    schema_version: u32,
    ok: bool,
    command: String,
    data: Option<T>,
    error: Option<ApiError>,
}

#[derive(Debug, Serialize, JsonSchema)]
struct ApiError {
    code: ErrorCode,
    message: String,
    details: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Serialize, JsonSchema)]
struct AboutDocument {
    product: String,
    version: String,
    description: String,
    repository: String,
    license: String,
}

#[derive(Debug, Serialize, JsonSchema)]
struct PortBatchOutcome<T: JsonSchema> {
    port_id: String,
    ok: bool,
    result: Option<T>,
    error: Option<ApiError>,
}

impl<T: JsonSchema> PortBatchOutcome<T> {
    fn success(port_id: String, result: T) -> Self {
        Self {
            port_id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn failure(port_id: String, error: &PortcoveError) -> Self {
        Self {
            port_id,
            ok: false,
            result: None,
            error: Some(api_error(error)),
        }
    }
}

#[derive(Debug, Serialize, JsonSchema)]
struct SourceBatchOutcome {
    profile_id: String,
    ok: bool,
    result: Option<SourceVerification>,
    error: Option<ApiError>,
}

#[tokio::main]
async fn main() -> ExitCode {
    let raw_args = std::env::args_os().collect::<Vec<_>>();
    let requested_mode = requested_output_mode(&raw_args);
    let cli = match Cli::try_parse_from(raw_args) {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) =>
        {
            let exit_code = error.exit_code().try_into().unwrap_or(2);
            let _ = error.print();
            return ExitCode::from(exit_code);
        }
        Err(error) if requested_mode != OutputMode::Human => {
            let error = PortcoveError::usage(error.to_string().trim());
            render_error(requested_mode, "cli", &error);
            return ExitCode::from(exit_code(&error));
        }
        Err(error) => {
            let exit_code = error.exit_code().try_into().unwrap_or(2);
            let _ = error.print();
            return ExitCode::from(exit_code);
        }
    };
    let filter = match cli.verbose {
        0 => "warn",
        1 => "info",
        _ => "debug",
    };
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(filter))
        .with_writer(io::stderr)
        .init();
    let mode = if cli.json {
        OutputMode::Json
    } else if cli.jsonl {
        OutputMode::Jsonl
    } else {
        OutputMode::Human
    };
    let command_name = command_name(&cli.command).to_owned();
    match execute(cli, mode).await {
        Ok(exit) => exit,
        Err(error) => {
            render_error(mode, &command_name, &error);
            ExitCode::from(exit_code(&error))
        }
    }
}

fn requested_output_mode(args: &[std::ffi::OsString]) -> OutputMode {
    args.iter()
        .skip(1)
        .find_map(|argument| match argument.to_str() {
            Some("--json") => Some(OutputMode::Json),
            Some("--jsonl") => Some(OutputMode::Jsonl),
            _ => None,
        })
        .unwrap_or(OutputMode::Human)
}

async fn execute(cli: Cli, mode: OutputMode) -> Result<ExitCode> {
    if matches!(&cli.command, Commands::About) {
        render_about(mode)?;
        return Ok(ExitCode::SUCCESS);
    }
    if matches!(
        &cli.command,
        Commands::Schema {
            command: SchemaCommand::Export
        }
    ) {
        render_success(mode, "schema.export", schema_document())?;
        return Ok(ExitCode::SUCCESS);
    }
    let library = match cli.library {
        Some(path) => portcove_core::Library::open(path)?,
        None => portcove_core::Library::open_default()?,
    };
    let service = PortcoveService::new(library)?;
    match cli.command {
        Commands::Auth { command } => {
            let github = GithubReleaseProvider::for_library(service.library())?;
            match command {
                AuthCommand::Status => {
                    render_success(mode, "auth.status", github.auth_status().await?)?;
                }
                AuthCommand::Login => {
                    let login = github.begin_device_login().await?;
                    render_device_prompt(mode, &login)?;
                    loop {
                        if wait_for_device_login_poll(
                            std::time::Duration::from_secs(login.interval_seconds),
                            tokio::signal::ctrl_c(),
                        )
                        .await?
                            == DeviceLoginWait::Cancelled
                        {
                            return Err(PortcoveError::conflict(
                                "GitHub login was cancelled before authorization completed",
                            ));
                        }
                        let result = github.poll_device_login(&login.session_id).await?;
                        if result.state == GithubDeviceLoginState::Complete {
                            render_success(mode, "auth.login", result)?;
                            break;
                        }
                    }
                }
                AuthCommand::SetToken { stdin } => {
                    let token = read_token(stdin, cli.non_interactive)?;
                    render_success(
                        mode,
                        "auth.set-token",
                        github.store_personal_token(&token).await?,
                    )?;
                }
                AuthCommand::Logout => {
                    render_success(mode, "auth.logout", github.logout().await?)?;
                }
            }
        }
        Commands::Catalog {
            command: CatalogCommand::List,
        } => {
            render_success(mode, "catalog.list", service.catalog().ports().to_vec())?;
        }
        Commands::Backup {
            command: BackupCommand::Create { port_id },
        } => {
            render_success(mode, "backup.create", service.create_backup(&port_id)?)?;
        }
        Commands::Backup {
            command: BackupCommand::List { port_id },
        } => {
            render_success(mode, "backup.list", service.list_backups(&port_id)?)?;
        }
        Commands::Backup {
            command:
                BackupCommand::Delete {
                    port_id,
                    backup_id,
                    yes,
                },
        } => {
            let preview =
                service.preview_backup_action(&port_id, &backup_id, BackupAction::Delete)?;
            require_confirmation(
                &format!("Permanently delete backup {backup_id} for {port_id}?"),
                yes,
                cli.non_interactive,
            )?;
            let authorization = service.authorize_backup_action(
                &port_id,
                &backup_id,
                BackupAction::Delete,
                &preview.preview_sha256,
            )?;
            render_success(
                mode,
                "backup.delete",
                service.delete_backup(&port_id, &backup_id, &authorization.token)?,
            )?;
        }
        Commands::Backup {
            command:
                BackupCommand::Restore {
                    port_id,
                    backup_id,
                    yes,
                },
        } => {
            let preview =
                service.preview_backup_action(&port_id, &backup_id, BackupAction::Restore)?;
            require_confirmation(
                &format!(
                    "Restore backup {backup_id} for {port_id}? Current persistent data will be backed up first."
                ),
                yes,
                cli.non_interactive,
            )?;
            let authorization = service.authorize_backup_action(
                &port_id,
                &backup_id,
                BackupAction::Restore,
                &preview.preview_sha256,
            )?;
            render_success(
                mode,
                "backup.restore",
                service.restore_backup(&port_id, &backup_id, &authorization.token)?,
            )?;
        }
        Commands::Catalog {
            command: CatalogCommand::Export,
        } => {
            render_success(mode, "catalog.export", service.catalog().document().clone())?;
        }
        Commands::Catalog {
            command: CatalogCommand::Show { port_id },
        } => {
            render_success(
                mode,
                "catalog.show",
                service.catalog().port(&port_id)?.clone(),
            )?;
        }
        Commands::Source {
            command: SourceCommand::Add { profile_id, path },
        } => {
            render_success(
                mode,
                "source.add",
                service.register_source(&profile_id, &path)?,
            )?;
        }
        Commands::Source {
            command: SourceCommand::List,
        } => {
            render_success(mode, "source.list", service.library().sources()?)?;
        }
        Commands::Source {
            command: SourceCommand::Verify(args),
        } => {
            if args.all {
                let outcomes = service
                    .library()
                    .sources()?
                    .into_iter()
                    .map(|source| {
                        let profile_id = source.profile_id;
                        match service.verify_source(&profile_id) {
                            Ok(result) => SourceBatchOutcome {
                                profile_id,
                                ok: true,
                                result: Some(result),
                                error: None,
                            },
                            Err(error) => SourceBatchOutcome {
                                profile_id,
                                ok: false,
                                result: None,
                                error: Some(api_error(&error)),
                            },
                        }
                    })
                    .collect::<Vec<_>>();
                render_success(mode, "source.verify", outcomes)?;
            } else {
                let profile_id = args
                    .profile_id
                    .ok_or_else(|| PortcoveError::usage("provide PROFILE_ID or --all"))?;
                render_success(mode, "source.verify", service.verify_source(&profile_id)?)?;
            }
        }
        Commands::Source {
            command: SourceCommand::Remove { profile_id, yes },
        } => {
            let preview = service.preview_source_removal(&profile_id)?;
            if mode == OutputMode::Human {
                println!("{}", serde_json::to_string_pretty(&preview)?);
            }
            let impact = if preview.installed_dependent_port_ids.is_empty() {
                "No installed port currently depends on it.".to_owned()
            } else {
                format!(
                    "Installed ports will lose this registered source dependency: {}.",
                    preview.installed_dependent_port_ids.join(", ")
                )
            };
            require_confirmation(
                &format!("Remove registered source {profile_id}? {impact}"),
                yes,
                cli.non_interactive,
            )?;
            let authorization =
                service.authorize_source_removal(&profile_id, &preview.preview_sha256)?;
            let removed = service.remove_source(&profile_id, &authorization.token)?;
            render_success(
                mode,
                "source.remove",
                serde_json::json!({ "removed": true, "preview": removed }),
            )?;
        }
        Commands::Status { port_id } => {
            if let Some(port_id) = port_id {
                render_success(mode, "status", service.status(&port_id)?)?;
            } else {
                render_success(mode, "status", service.statuses()?)?;
            }
        }
        Commands::Activity { limit } => {
            render_success(
                mode,
                "activity",
                service.library().activities(limit as usize)?,
            )?;
        }
        Commands::Storage => {
            render_success(mode, "storage", service.library().storage_summary()?)?;
        }
        Commands::Doctor => {
            render_success(mode, "doctor", service.doctor()?)?;
        }
        Commands::About => unreachable!("about exits before opening the library"),
        Commands::Plan { port_id, channel } => {
            render_success(
                mode,
                "plan",
                service
                    .plan_install(&port_id, channel.map(Into::into))
                    .await?,
            )?;
        }
        Commands::Paths { port_id } => {
            render_success(mode, "paths", service.port_paths(&port_id)?)?;
        }
        Commands::Check(args) => {
            if args.all {
                let mut checked = Vec::new();
                for status in service
                    .statuses()?
                    .into_iter()
                    .filter(|status| status.active.is_some())
                {
                    let port_id = status.port_id;
                    checked.push(match service.check_update(&port_id).await {
                        Ok(result) => PortBatchOutcome::success(port_id, result),
                        Err(error) => PortBatchOutcome::failure(port_id, &error),
                    });
                }
                render_success(mode, "check", checked)?;
            } else {
                let port_id = args
                    .port_id
                    .ok_or_else(|| PortcoveError::usage("provide PORT_ID or --all"))?;
                render_success(mode, "check", service.check_update(&port_id).await?)?;
            }
        }
        Commands::Reconcile(args) => {
            if args.all {
                let mut reconciled = Vec::new();
                for status in service
                    .statuses()?
                    .into_iter()
                    .filter(|status| status.active.is_some())
                {
                    let mut progress = progress_renderer(mode);
                    match service.reconcile(&status.port_id, &mut progress).await {
                        Ok(result) => {
                            reconciled.push(PortBatchOutcome::success(status.port_id, result))
                        }
                        Err(error) => {
                            reconciled.push(PortBatchOutcome::failure(status.port_id, &error))
                        }
                    }
                }
                render_success(mode, "reconcile", reconciled)?;
            } else {
                let port_id = args
                    .port_id
                    .ok_or_else(|| PortcoveError::usage("provide PORT_ID or --all"))?;
                let mut progress = progress_renderer(mode);
                render_success(
                    mode,
                    "reconcile",
                    service.reconcile(&port_id, &mut progress).await?,
                )?;
            }
        }
        Commands::Install(args) => {
            let mut progress = progress_renderer(mode);
            let install = service
                .install(
                    &args.port_id,
                    args.channel.map(Into::into),
                    args.source.as_deref(),
                    args.bios.as_deref(),
                    !args.stage,
                    &mut progress,
                )
                .await?;
            render_success(mode, "install", install)?;
        }
        Commands::Ensure(args) => {
            let mut progress = progress_renderer(mode);
            let install = service
                .ensure(
                    &args.port_id,
                    args.channel.map(Into::into),
                    args.source.as_deref(),
                    args.bios.as_deref(),
                    &mut progress,
                )
                .await?;
            render_success(mode, "ensure", install)?;
        }
        Commands::Update(args) => {
            if args.all {
                if args.source.is_some() || args.bios.is_some() {
                    return Err(PortcoveError::usage(
                        "--source and --bios cannot be used with --all",
                    ));
                }
                let mut updated = Vec::new();
                for status in service
                    .statuses()?
                    .into_iter()
                    .filter(|status| status.active.is_some())
                {
                    let activate = !args.stage && status.update_policy != UpdatePolicy::Stage;
                    let mut progress = progress_renderer(mode);
                    let port_id = status.port_id;
                    updated.push(
                        match service
                            .update(&port_id, None, None, activate, &mut progress)
                            .await
                        {
                            Ok(result) => PortBatchOutcome::success(port_id, result),
                            Err(error) => PortBatchOutcome::failure(port_id, &error),
                        },
                    );
                }
                render_success(mode, "update", updated)?;
            } else {
                let port_id = args
                    .port_id
                    .ok_or_else(|| PortcoveError::usage("provide PORT_ID or --all"))?;
                let mut progress = progress_renderer(mode);
                let install = service
                    .update(
                        &port_id,
                        args.source.as_deref(),
                        args.bios.as_deref(),
                        !args.stage,
                        &mut progress,
                    )
                    .await?;
                render_success(mode, "update", install)?;
            }
        }
        Commands::Verify { port_id } => render_success(mode, "verify", service.verify(&port_id)?)?,
        Commands::Activate { port_id } => {
            render_success(mode, "activate", service.activate_staged(&port_id)?)?
        }
        Commands::Rollback { port_id } => {
            render_success(mode, "rollback", service.rollback(&port_id)?)?
        }
        Commands::Remove { port_id, yes } => {
            let preview = service.preview_removal(&port_id)?;
            if mode == OutputMode::Human {
                println!("{}", serde_json::to_string_pretty(&preview)?);
            }
            require_confirmation(
                &format!("Remove managed versions for {port_id}? Persistent data will be kept."),
                yes,
                cli.non_interactive,
            )?;
            let authorization = service.authorize_removal(&port_id, &preview.preview_sha256)?;
            render_success(
                mode,
                "remove",
                serde_json::json!({ "removed": service.remove(&port_id, &authorization.token)? }),
            )?;
        }
        Commands::Adopt(args) => {
            let preview = service.preview_adoption(&args.path, args.port.as_deref())?;
            if mode == OutputMode::Human {
                println!("{}", serde_json::to_string_pretty(&preview)?);
            }
            require_confirmation(
                "Copy this installation into Portcove? The original will be left untouched.",
                args.yes,
                cli.non_interactive,
            )?;
            let authorization = service.authorize_adoption(
                &args.path,
                args.port.as_deref(),
                &preview.plan_sha256,
            )?;
            render_success(
                mode,
                "adopt",
                service.adopt(&args.path, args.port.as_deref(), &authorization.token)?,
            )?;
        }
        Commands::Channel {
            command: ChannelCommand::Set { port_id, channel },
        } => {
            render_success(
                mode,
                "channel.set",
                service.set_channel(&port_id, channel.into())?,
            )?;
        }
        Commands::Policy {
            command: PolicyCommand::Set { port_id, policy },
        } => {
            render_success(
                mode,
                "policy.set",
                service.set_update_policy(&port_id, policy.into())?,
            )?;
        }
        Commands::Exec(args) => {
            if mode != OutputMode::Human {
                return Err(PortcoveError::usage(
                    "exec inherits the game's streams and exit code; remove --json or --jsonl",
                ));
            }
            return exec_game(&service, args).await;
        }
        Commands::Capabilities => {
            render_success(mode, "capabilities", CapabilityDocument::current())?
        }
        Commands::Schema {
            command: SchemaCommand::Export,
        } => {
            render_success(mode, "schema.export", schema_document())?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeviceLoginWait {
    Poll,
    Cancelled,
}

async fn wait_for_device_login_poll<F>(
    interval: std::time::Duration,
    cancellation: F,
) -> Result<DeviceLoginWait>
where
    F: std::future::Future<Output = std::io::Result<()>>,
{
    tokio::select! {
        _ = tokio::time::sleep(interval) => Ok(DeviceLoginWait::Poll),
        signal = cancellation => {
            signal.map_err(PortcoveError::from)?;
            Ok(DeviceLoginWait::Cancelled)
        }
    }
}

fn schema_document() -> serde_json::Value {
    serde_json::json!({
        "api_response_port_status": schema_for!(ApiResponse<PortStatus>),
        "about": schema_for!(AboutDocument),
        "catalog": schema_for!(CatalogDocument),
        "port": schema_for!(PortDefinition),
        "status": schema_for!(PortStatus),
        "update_check": schema_for!(UpdateCheck),
        "update_snapshot": schema_for!(UpdateSnapshot),
        "check_batch_outcome": schema_for!(PortBatchOutcome<UpdateCheck>),
        "reconcile_result": schema_for!(ReconcileResult),
        "reconcile_batch_outcome": schema_for!(PortBatchOutcome<ReconcileResult>),
        "update_batch_outcome": schema_for!(PortBatchOutcome<InstallRecord>),
        "source": schema_for!(SourceRecord),
        "source_removal_preview": schema_for!(SourceRemovalPreview),
        "source_verification": schema_for!(SourceVerification),
        "source_batch_outcome": schema_for!(SourceBatchOutcome),
        "activity": schema_for!(ActivityRecord),
        "backup": schema_for!(BackupRecord),
        "backup_action_preview": schema_for!(BackupActionPreview),
        "restore_result": schema_for!(RestoreResult),
        "adoption_preview": schema_for!(AdoptionPreview),
        "port_removal_preview": schema_for!(PortRemovalPreview),
        "storage": schema_for!(StorageSummary),
        "doctor": schema_for!(DoctorReport),
        "install_plan": schema_for!(InstallPlan),
        "port_paths": schema_for!(PortPaths),
        "operation_event": schema_for!(OperationEvent),
        "github_auth_status": schema_for!(GithubAuthStatus),
        "github_device_login": schema_for!(GithubDeviceLogin),
        "github_device_login_result": schema_for!(GithubDeviceLoginResult),
        "capabilities": schema_for!(CapabilityDocument)
    })
}

fn read_token(stdin: bool, non_interactive: bool) -> Result<String> {
    let token = if stdin {
        let mut token = String::new();
        io::stdin().read_to_string(&mut token)?;
        token
    } else if non_interactive {
        return Err(PortcoveError::usage(
            "auth set-token requires --stdin under --non-interactive; environment tokens are also supported",
        ));
    } else {
        rpassword::prompt_password("GitHub token: ")
            .map_err(|error| PortcoveError::state(error.to_string()))?
    };
    let token = token.trim().to_owned();
    if token.is_empty() {
        Err(PortcoveError::usage("GitHub token cannot be empty"))
    } else {
        Ok(token)
    }
}

fn render_device_prompt(mode: OutputMode, login: &GithubDeviceLogin) -> Result<()> {
    let message = format!(
        "Open {} and enter code {}",
        login.verification_uri, login.user_code
    );
    match mode {
        OutputMode::Human => println!("{message}"),
        OutputMode::Json => eprintln!("{message}"),
        OutputMode::Jsonl => println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "schema_version": API_SCHEMA_VERSION,
                "type": "device_authorization",
                "data": login,
            }))?
        ),
    }
    Ok(())
}

fn render_about(mode: OutputMode) -> Result<()> {
    let about = AboutDocument {
        product: "Portcove".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        description: "Native ports, kept current.".into(),
        repository: env!("CARGO_PKG_REPOSITORY").into(),
        license: env!("CARGO_PKG_LICENSE").into(),
    };
    if mode == OutputMode::Human {
        println!(
            "Portcove {}\nNative ports, kept current.\n{}\nLicense: {}",
            about.version, about.repository, about.license
        );
        Ok(())
    } else {
        render_success(mode, "about", about)
    }
}

async fn exec_game(service: &PortcoveService, args: ExecArgs) -> Result<ExitCode> {
    let library = service.library().clone();
    let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
    let mut supervision = tokio::task::spawn_blocking(move || {
        PortcoveService::new(library)?.supervise_launch(
            &args.port_id,
            args.source.as_deref(),
            &args.game_args,
            LaunchStdio::Inherit,
            |session| {
                let _ = started_sender.send(session.child_pid.expect("started session has a PID"));
            },
        )
    });
    tokio::pin!(started_receiver);
    let mut waiting_for_child = true;
    let mut child_pid = None;
    let mut pending_signal = None;
    loop {
        tokio::select! {
            result = &mut supervision => {
                let outcome = result
                    .map_err(|error| PortcoveError::state(format!("launch supervisor task failed: {error}")))??;
                return Ok(ExitCode::from(normalize_process_exit(outcome.exit_code)));
            }
            started = &mut started_receiver, if waiting_for_child => {
                waiting_for_child = false;
                if let Ok(pid) = started {
                    child_pid = Some(pid);
                    if let Some(signal) = pending_signal.take()
                        && let Err(error) = forward_launch_signal(pid, signal)
                    {
                        eprintln!("Portcove warning: {error}");
                    }
                }
            }
            signal = next_launch_signal() => {
                let signal = signal.map_err(PortcoveError::from)?;
                if let Some(pid) = child_pid {
                    if let Err(error) = forward_launch_signal(pid, signal) {
                        eprintln!("Portcove warning: {error}");
                    }
                } else {
                    pending_signal = Some(signal);
                }
            }
        }
    }
}

#[cfg(windows)]
async fn next_launch_signal() -> std::io::Result<LaunchSignal> {
    tokio::signal::ctrl_c().await?;
    Ok(LaunchSignal::Interrupt)
}

#[cfg(unix)]
async fn next_launch_signal() -> std::io::Result<LaunchSignal> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        _ = interrupt.recv() => Ok(LaunchSignal::Interrupt),
        _ = terminate.recv() => Ok(LaunchSignal::Terminate),
    }
}

fn normalize_process_exit(code: Option<i32>) -> u8 {
    match code {
        Some(code @ 0..=255) => code as u8,
        Some(_) => 1,
        None => 125,
    }
}

fn progress_renderer(mode: OutputMode) -> impl FnMut(OperationEvent) {
    move |event| match mode {
        OutputMode::Jsonl => println!(
            "{}",
            serde_json::to_string(&event).expect("operation event is serializable")
        ),
        OutputMode::Human => match event.event {
            OperationEventKind::Progress {
                phase,
                completed,
                total,
            } => {
                if let Some(total) = total {
                    eprint!("\r{phase}: {completed}/{total} bytes");
                }
            }
            OperationEventKind::Message { message, .. } => eprintln!("{message}"),
            OperationEventKind::Finished { .. } => eprintln!(),
            OperationEventKind::Started => {
                eprintln!(
                    "{} {}",
                    event.operation,
                    event.target.map(|target| target.id).unwrap_or_default()
                )
            }
        },
        OutputMode::Json => {}
    }
}

fn render_success<T>(mode: OutputMode, command: &str, data: T) -> Result<()>
where
    T: Serialize + JsonSchema,
{
    match mode {
        OutputMode::Human => println!("{}", serde_json::to_string_pretty(&data)?),
        OutputMode::Json => println!(
            "{}",
            serde_json::to_string(&ApiResponse {
                schema_version: API_SCHEMA_VERSION,
                ok: true,
                command: command.into(),
                data: Some(data),
                error: None,
            })?
        ),
        OutputMode::Jsonl => println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "schema_version": API_SCHEMA_VERSION, "type": "result", "ok": true,
                "command": command, "data": data
            }))?
        ),
    }
    Ok(())
}

fn render_error(mode: OutputMode, command: &str, error: &PortcoveError) {
    match mode {
        OutputMode::Human => eprintln!("error: {error}"),
        OutputMode::Json => println!("{}", serde_json::to_string(&ApiResponse::<serde_json::Value> {
            schema_version: API_SCHEMA_VERSION, ok: false, command: command.into(), data: None,
            error: Some(api_error(error)),
        }).unwrap_or_else(|_| "{\"ok\":false}".into())),
        OutputMode::Jsonl => println!("{}", serde_json::to_string(&serde_json::json!({
            "schema_version": API_SCHEMA_VERSION, "type": "result", "ok": false,
            "command": command, "error": { "code": error.code, "message": error.message, "details": error.details }
        })).unwrap_or_else(|_| "{\"ok\":false}".into())),
    }
}

fn api_error(error: &PortcoveError) -> ApiError {
    ApiError {
        code: error.code,
        message: error.message.clone(),
        details: error.details.clone(),
    }
}

fn require_confirmation(prompt: &str, yes: bool, non_interactive: bool) -> Result<()> {
    if yes {
        return Ok(());
    }
    if non_interactive {
        return Err(PortcoveError::usage("confirmation required; pass --yes"));
    }
    eprint!("{prompt} [y/N] ");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    if answer.trim().eq_ignore_ascii_case("y") || answer.trim().eq_ignore_ascii_case("yes") {
        Ok(())
    } else {
        Err(PortcoveError::usage("operation cancelled"))
    }
}

fn exit_code(error: &PortcoveError) -> u8 {
    match error.code {
        ErrorCode::Usage => 2,
        ErrorCode::Unsupported => 3,
        ErrorCode::NotFound => 4,
        ErrorCode::SourceInvalid => 5,
        ErrorCode::Network => 10,
        ErrorCode::Verification => 11,
        ErrorCode::Install => 12,
        ErrorCode::State => 13,
        ErrorCode::Conflict => 14,
        ErrorCode::Launch => 125,
    }
}

fn command_name(command: &Commands) -> &'static str {
    match command {
        Commands::Auth { command } => match command {
            AuthCommand::Status => "auth.status",
            AuthCommand::Login => "auth.login",
            AuthCommand::SetToken { .. } => "auth.set-token",
            AuthCommand::Logout => "auth.logout",
        },
        Commands::Backup { command } => match command {
            BackupCommand::Create { .. } => "backup.create",
            BackupCommand::List { .. } => "backup.list",
            BackupCommand::Delete { .. } => "backup.delete",
            BackupCommand::Restore { .. } => "backup.restore",
        },
        Commands::Catalog { command } => match command {
            CatalogCommand::List => "catalog.list",
            CatalogCommand::Export => "catalog.export",
            CatalogCommand::Show { .. } => "catalog.show",
        },
        Commands::Source { command } => match command {
            SourceCommand::Add { .. } => "source.add",
            SourceCommand::List => "source.list",
            SourceCommand::Verify(_) => "source.verify",
            SourceCommand::Remove { .. } => "source.remove",
        },
        Commands::Status { .. } => "status",
        Commands::Activity { .. } => "activity",
        Commands::Storage => "storage",
        Commands::Doctor => "doctor",
        Commands::About => "about",
        Commands::Plan { .. } => "plan",
        Commands::Paths { .. } => "paths",
        Commands::Check(_) => "check",
        Commands::Reconcile(_) => "reconcile",
        Commands::Install(_) => "install",
        Commands::Adopt(_) => "adopt",
        Commands::Ensure(_) => "ensure",
        Commands::Update(_) => "update",
        Commands::Verify { .. } => "verify",
        Commands::Activate { .. } => "activate",
        Commands::Rollback { .. } => "rollback",
        Commands::Remove { .. } => "remove",
        Commands::Channel { .. } => "channel.set",
        Commands::Policy { .. } => "policy.set",
        Commands::Exec(_) => "exec",
        Commands::Capabilities => "capabilities",
        Commands::Schema { .. } => "schema.export",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AuthCommand, BackupCommand, CapabilityDocument, CatalogCommand, ChannelArg, Cli, Commands,
        SourceCommand, normalize_process_exit,
    };
    use clap::Parser;

    #[test]
    fn process_crashes_never_look_successful_to_callers() {
        assert_eq!(normalize_process_exit(Some(0)), 0);
        assert_eq!(normalize_process_exit(Some(42)), 42);
        assert_eq!(normalize_process_exit(Some(-1_073_741_819)), 1);
        assert_eq!(normalize_process_exit(Some(300)), 1);
        assert_eq!(normalize_process_exit(None), 125);
    }

    #[test]
    fn exec_accepts_no_game_arguments() {
        let cli = Cli::try_parse_from(["portcove", "exec", "lighthouse"]).unwrap();
        let Commands::Exec(args) = cli.command else {
            panic!("expected exec command");
        };
        assert_eq!(args.port_id, "lighthouse");
        assert!(args.game_args.is_empty());
    }

    #[test]
    fn exec_forwards_arguments_after_the_separator() {
        let cli = Cli::try_parse_from([
            "portcove",
            "exec",
            "lighthouse",
            "--",
            "--fullscreen",
            "slot 1",
        ])
        .unwrap();
        let Commands::Exec(args) = cli.command else {
            panic!("expected exec command");
        };
        assert_eq!(args.game_args, ["--fullscreen", "slot 1"]);
    }

    #[test]
    fn token_input_is_never_a_positional_argument() {
        let cli = Cli::try_parse_from(["portcove", "auth", "set-token", "--stdin"]).unwrap();
        let Commands::Auth {
            command: AuthCommand::SetToken { stdin },
        } = cli.command
        else {
            panic!("expected auth set-token command");
        };
        assert!(stdin);
        assert!(Cli::try_parse_from(["portcove", "auth", "set-token", "secret-in-argv"]).is_err());
    }

    #[test]
    fn source_verification_accepts_one_profile_or_all() {
        let single = Cli::try_parse_from(["portcove", "source", "verify", "star-fox-64"]).unwrap();
        let Commands::Source {
            command: SourceCommand::Verify(single),
        } = single.command
        else {
            panic!("expected source verify command");
        };
        assert_eq!(single.profile_id.as_deref(), Some("star-fox-64"));
        assert!(!single.all);

        let all = Cli::try_parse_from(["portcove", "source", "verify", "--all"]).unwrap();
        let Commands::Source {
            command: SourceCommand::Verify(all),
        } = all.command
        else {
            panic!("expected source verify command");
        };
        assert!(all.profile_id.is_none());
        assert!(all.all);
        assert!(
            Cli::try_parse_from(["portcove", "source", "verify", "star-fox-64", "--all"]).is_err()
        );
    }

    #[test]
    fn update_checks_accept_one_port_or_all() {
        let single = Cli::try_parse_from(["portcove", "check", "lighthouse"]).unwrap();
        let Commands::Check(single) = single.command else {
            panic!("expected check command");
        };
        assert_eq!(single.port_id.as_deref(), Some("lighthouse"));
        assert!(!single.all);

        let all = Cli::try_parse_from(["portcove", "check", "--all"]).unwrap();
        let Commands::Check(all) = all.command else {
            panic!("expected check command");
        };
        assert!(all.port_id.is_none());
        assert!(all.all);
        assert!(Cli::try_parse_from(["portcove", "check", "lighthouse", "--all"]).is_err());
    }

    #[test]
    fn activity_limit_is_bounded_for_automation_callers() {
        let cli = Cli::try_parse_from(["portcove", "activity", "--limit", "25"]).unwrap();
        let Commands::Activity { limit } = cli.command else {
            panic!("expected activity command");
        };
        assert_eq!(limit, 25);
        assert!(Cli::try_parse_from(["portcove", "activity", "--limit", "0"]).is_err());
        assert!(Cli::try_parse_from(["portcove", "activity", "--limit", "201"]).is_err());
    }

    #[test]
    fn storage_is_a_read_only_top_level_command() {
        let cli = Cli::try_parse_from(["portcove", "storage"]).unwrap();
        assert!(matches!(cli.command, Commands::Storage));
    }

    #[test]
    fn doctor_is_a_read_only_top_level_command() {
        let cli = Cli::try_parse_from(["portcove", "doctor"]).unwrap();
        assert!(matches!(cli.command, Commands::Doctor));
        assert_eq!(super::command_name(&cli.command), "doctor");
    }

    #[test]
    fn about_is_a_compact_top_level_identity_command() {
        let cli = Cli::try_parse_from(["portcove", "about"]).unwrap();
        assert!(matches!(cli.command, Commands::About));
        assert_eq!(super::command_name(&cli.command), "about");
    }

    #[test]
    fn backup_create_and_list_have_explicit_port_targets() {
        let create = Cli::try_parse_from(["portcove", "backup", "create", "lighthouse"]).unwrap();
        assert!(matches!(
            create.command,
            Commands::Backup {
                command: BackupCommand::Create { port_id }
            } if port_id == "lighthouse"
        ));
        let restore = Cli::try_parse_from([
            "portcove",
            "backup",
            "restore",
            "lighthouse",
            "3b241101-e2bb-4255-8caf-4136c566a962",
            "--yes",
        ])
        .unwrap();
        assert!(matches!(
            restore.command,
            Commands::Backup {
                command: BackupCommand::Restore { port_id, backup_id, yes }
            } if port_id == "lighthouse" && backup_id == "3b241101-e2bb-4255-8caf-4136c566a962" && yes
        ));
        let delete = Cli::try_parse_from([
            "portcove",
            "backup",
            "delete",
            "lighthouse",
            "3b241101-e2bb-4255-8caf-4136c566a962",
            "--yes",
        ])
        .unwrap();
        assert!(matches!(
            delete.command,
            Commands::Backup {
                command: BackupCommand::Delete { port_id, backup_id, yes }
            } if port_id == "lighthouse" && backup_id == "3b241101-e2bb-4255-8caf-4136c566a962" && yes
        ));
        let list = Cli::try_parse_from(["portcove", "backup", "list", "lighthouse"]).unwrap();
        assert!(matches!(
            list.command,
            Commands::Backup {
                command: BackupCommand::List { port_id }
            } if port_id == "lighthouse"
        ));
    }

    #[test]
    fn plan_accepts_an_optional_release_channel() {
        let cli =
            Cli::try_parse_from(["portcove", "plan", "lighthouse", "--channel", "beta"]).unwrap();
        let Commands::Plan { port_id, channel } = cli.command else {
            panic!("expected plan command");
        };
        assert_eq!(port_id, "lighthouse");
        assert!(matches!(channel, Some(ChannelArg::Beta)));
    }

    #[test]
    fn paths_accepts_one_port_identifier() {
        let cli = Cli::try_parse_from(["portcove", "paths", "lighthouse"]).unwrap();
        let Commands::Paths { port_id } = cli.command else {
            panic!("expected paths command");
        };
        assert_eq!(port_id, "lighthouse");
    }

    #[test]
    fn catalog_export_is_available_to_machine_consumers() {
        let cli = Cli::try_parse_from(["portcove", "catalog", "export"]).unwrap();
        assert!(matches!(
            cli.command,
            Commands::Catalog {
                command: CatalogCommand::Export
            }
        ));
    }

    #[test]
    fn nested_command_names_match_their_machine_response_names() {
        let cases = [
            (vec!["portcove", "auth", "status"], "auth.status"),
            (
                vec!["portcove", "backup", "list", "lighthouse"],
                "backup.list",
            ),
            (vec!["portcove", "catalog", "list"], "catalog.list"),
            (vec!["portcove", "source", "list"], "source.list"),
            (
                vec!["portcove", "channel", "set", "lighthouse", "beta"],
                "channel.set",
            ),
            (
                vec!["portcove", "policy", "set", "lighthouse", "stage"],
                "policy.set",
            ),
            (vec!["portcove", "schema", "export"], "schema.export"),
        ];

        for (args, expected) in cases {
            let cli = Cli::try_parse_from(args).unwrap();
            assert_eq!(super::command_name(&cli.command), expected);
        }
    }

    #[test]
    fn capabilities_advertise_failure_isolated_batches() {
        let capabilities = CapabilityDocument::current();
        assert_eq!(capabilities.schema_version, 4);
        assert_eq!(
            capabilities.failure_isolated_batches,
            ["check", "reconcile", "update", "source.verify"]
        );
        assert_eq!(capabilities.port_operation_locking, "per_port_fail_fast");
        assert!(capabilities.commands.contains(&"storage".to_owned()));
        assert!(capabilities.commands.contains(&"doctor".to_owned()));
        assert!(capabilities.commands.contains(&"backup".to_owned()));
        assert!(capabilities.commands.contains(&"plan".to_owned()));
        assert!(capabilities.commands.contains(&"paths".to_owned()));
        assert_eq!(capabilities.raw_stream_commands, ["exec"]);
        assert_eq!(capabilities.product_version, env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn device_login_poll_wait_is_async_and_cancellable() {
        let cancelled = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            super::wait_for_device_login_poll(std::time::Duration::from_secs(60), async { Ok(()) }),
        )
        .await
        .expect("cancellation should not wait for the polling interval")
        .unwrap();
        assert_eq!(cancelled, super::DeviceLoginWait::Cancelled);

        let poll = super::wait_for_device_login_poll(
            std::time::Duration::ZERO,
            std::future::pending::<std::io::Result<()>>(),
        )
        .await
        .unwrap();
        assert_eq!(poll, super::DeviceLoginWait::Poll);
    }
}
