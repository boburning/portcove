use std::{
    io::{self, IsTerminal, Read, Write},
    process::ExitCode,
};

use clap::{Parser, error::ErrorKind};
use portcove_core::{
    API_SCHEMA_VERSION, ApplicationRuntimeGuard, BackupAction, CapabilityDocument,
    ChildProcessClass, ChildProcessPolicy, ErrorCode, GithubDeviceLogin, GithubDeviceLoginState,
    GithubReleaseProvider, HostPreferenceStore, IdentifiedLaunchRequest, InstallOverrides,
    LaunchSignal, LaunchStdio, OperationCoordinator, OperationEvent, PortcoveError,
    PortcoveService, Result, SourceImportMode, SourceVerification, UpdatePolicy,
    forward_launch_signal,
};
use schemars::JsonSchema;
use serde::Serialize;
use tracing_subscriber::{EnvFilter, Layer, layer::SubscriberExt};

#[cfg(test)]
use portcove_core::OperationEventKind;

mod args;
use args::*;

mod cancellation;
mod catalog;
mod startup;
use catalog::CatalogCommand;
mod human;
mod human_adapters;
mod progress;
use progress::HumanProgress;
mod schema;

// Read-only consumers can identify a compatible standalone CLI without
// executing an arbitrary PATH candidate. Keep this marker versioned whenever
// the Steam `exec` handoff contract changes.
#[used]
static PORTCOVE_CLI_STEAM_EXEC_IDENTITY: &[u8] = concat!(
    "PORTCOVE_CLI_STEAM_EXEC_IDENTITY_V1|product=",
    env!("CARGO_PKG_VERSION"),
    "|capability=exec"
)
.as_bytes();

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

type ApiError = portcove_core::FailureReport;

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

const CLI_RUNTIME_STACK_BYTES: usize = 8 * 1024 * 1024;

fn main() -> ExitCode {
    std::hint::black_box(PORTCOVE_CLI_STEAM_EXEC_IDENTITY);
    let runtime = std::thread::Builder::new()
        .name("portcove-main".into())
        .stack_size(CLI_RUNTIME_STACK_BYTES)
        .spawn(run);
    match runtime {
        Ok(runtime) => match runtime.join() {
            Ok(exit) => exit,
            Err(panic) => std::panic::resume_unwind(panic),
        },
        Err(error) => {
            eprintln!("Portcove could not initialize its runtime thread: {error}");
            ExitCode::FAILURE
        }
    }
}

fn command_is_observation(command: &Commands) -> bool {
    startup::startup_mode(command) == startup::StartupMode::ReadOnly
}

#[tokio::main]
async fn run() -> ExitCode {
    let raw_args = std::env::args_os().collect::<Vec<_>>();
    let requested_mode = requested_output_mode(&raw_args);
    // Parsing is in-memory only. Start the host session before handling its
    // result or opening preferences, the runtime lease, or any library.
    let parsed = Cli::try_parse_from(raw_args);
    let verbosity = parsed.as_ref().map_or(0, |cli| cli.verbose);
    let (host, mut diagnostic_guard) = portcove_diagnostics::HostDiagnostics::start(
        portcove_diagnostics::Surface::Cli,
        portcove_diagnostics::debug_requested() || verbosity >= 2,
    );
    // Retain the existing stderr verbosity contract. The new host lifecycle
    // observations are file-only, so they do not enter machine or game streams.
    let subscriber = tracing_subscriber::registry()
        .with(host.layer().with_filter(host.filter()))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(io::stderr)
                .with_filter(stderr_diagnostic_filter(verbosity)),
        );
    // A subscriber or file-sink failure cannot change the command's outcome.
    let _ = tracing::subscriber::set_global_default(subscriber);
    tracing::debug!(
        target: "portcove_cli::host_diagnostics",
        component = "startup",
        phase = "start",
        message = "CLI diagnostic debug enabled"
    );
    let exit = run_parsed(parsed, requested_mode).await;
    if let Some(guard) = diagnostic_guard.as_mut() {
        let _ = guard.shutdown(std::time::Duration::from_secs(2));
    }
    exit
}

fn stderr_diagnostic_filter(verbosity: u8) -> EnvFilter {
    let level = match verbosity {
        0 => "warn",
        1 => "info",
        _ => "debug",
    };
    EnvFilter::new(format!(
        "{level},portcove_cli::host_diagnostics=off,portcove_core::host_diagnostics=off"
    ))
}

async fn run_parsed(
    parsed: std::result::Result<Cli, clap::Error>,
    requested_mode: OutputMode,
) -> ExitCode {
    let cli = match parsed {
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
            startup::record_diagnostic(
                startup::DiagnosticPhase::Arguments,
                false,
                Some(ErrorCode::Usage),
            );
            let error = PortcoveError::usage(error.to_string().trim());
            render_error(requested_mode, "cli", &error, false);
            return ExitCode::from(exit_code(&error));
        }
        Err(error) => {
            startup::record_diagnostic(
                startup::DiagnosticPhase::Arguments,
                false,
                Some(ErrorCode::Usage),
            );
            let exit_code = error.exit_code().try_into().unwrap_or(2);
            let _ = error.print();
            return ExitCode::from(exit_code);
        }
    };
    startup::record_diagnostic(startup::DiagnosticPhase::Arguments, true, None);
    let mode = if cli.json {
        OutputMode::Json
    } else if cli.jsonl {
        OutputMode::Jsonl
    } else {
        OutputMode::Human
    };
    let command_name = command_name(&cli.command).to_owned();
    let technical_details = cli.technical_details;
    match execute(cli, mode).await {
        Ok(exit) => {
            startup::record_diagnostic(
                startup::DiagnosticPhase::Command,
                exit == ExitCode::SUCCESS,
                None,
            );
            exit
        }
        Err(error) => {
            startup::record_diagnostic(startup::DiagnosticPhase::Command, false, Some(error.code));
            render_error(mode, &command_name, &error, technical_details);
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

#[cfg(feature = "qualification-fixtures")]
fn require_qualification_update_binding(cli: &Cli) -> Result<()> {
    if matches!(
        &cli.command,
        Commands::Installation {
            command: InstallationCommand::QualificationUpdatePlan { .. }
                | InstallationCommand::QualificationUpdateRun { .. }
        }
    ) && (cli.qualification_provider_origin.is_none()
        || cli.qualification_provider_library.is_none()
        || cli.library.is_none())
    {
        return Err(PortcoveError::usage(
            "qualification update requires an explicit provider and library binding",
        ));
    }
    Ok(())
}

#[cfg(feature = "qualification-fixtures")]
fn require_qualification_proxy_free_environment(
    cli: &Cli,
    environment: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Result<()> {
    if cli.qualification_provider_origin.is_none() && cli.qualification_provider_library.is_none() {
        return Ok(());
    }
    if environment.into_iter().any(|(name, value)| {
        !value.is_empty()
            && name.to_str().is_some_and(|name| {
                ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]
                    .iter()
                    .any(|proxy| name.eq_ignore_ascii_case(proxy))
            })
    }) {
        return Err(PortcoveError::usage(
            "qualification provider refuses proxy environment",
        ));
    }
    Ok(())
}

async fn execute(cli: Cli, mode: OutputMode) -> Result<ExitCode> {
    #[cfg(feature = "qualification-fixtures")]
    {
        execute_with_qualification_environment(cli, mode, std::env::vars_os()).await
    }
    #[cfg(not(feature = "qualification-fixtures"))]
    {
        execute_after_qualification_preflight(cli, mode).await
    }
}

#[cfg(feature = "qualification-fixtures")]
async fn execute_with_qualification_environment(
    cli: Cli,
    mode: OutputMode,
    environment: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Result<ExitCode> {
    require_qualification_update_binding(&cli)?;
    require_qualification_proxy_free_environment(&cli, environment)?;
    execute_after_qualification_preflight(cli, mode).await
}

async fn execute_after_qualification_preflight(cli: Cli, mode: OutputMode) -> Result<ExitCode> {
    if let Commands::Catalog {
        command: CatalogCommand::InspectDefinitionPublication { directory },
    } = &cli.command
    {
        render_read_success(
            mode,
            "catalog.inspect-definition-publication",
            portcove_core::inspect_definition_publication(directory)?,
            |report| catalog::publication_inspection(report, cli.technical_details),
        )?;
        return Ok(ExitCode::SUCCESS);
    }
    if let Commands::Catalog {
        command: CatalogCommand::InspectProposal { file },
    } = &cli.command
    {
        render_read_success(
            mode,
            "catalog.inspect-proposal",
            portcove_core::Catalog::inspect_proposal(file)?,
            |report| catalog::proposal_inspection(report, cli.technical_details),
        )?;
        return Ok(ExitCode::SUCCESS);
    }
    let preferences = startup::observe(
        startup::DiagnosticPhase::Preferences,
        host_preference_store(),
    )?;
    let _application_runtime = startup::observe(
        startup::DiagnosticPhase::RuntimeLease,
        HostPreferenceStore::application_runtime_lock_path()
            .and_then(|path| ApplicationRuntimeGuard::acquire(&path)),
    )?;
    if let Commands::Catalog {
        command: CatalogCommand::CheckCapabilities { file },
    } = &cli.command
    {
        let report = portcove_core::inspect_definition_capabilities(file)?;
        render_read_success(
            mode,
            "catalog.check-capabilities",
            report,
            catalog::definition_capabilities,
        )?;
        return Ok(ExitCode::SUCCESS);
    }
    if matches!(&cli.command, Commands::About) {
        render_about(mode)?;
        return Ok(ExitCode::SUCCESS);
    }
    if let Commands::Schema {
        command: SchemaCommand::Export { contract },
    } = &cli.command
    {
        render_success(mode, "schema.export", schema::document(*contract))?;
        return Ok(ExitCode::SUCCESS);
    }
    if let Commands::Catalog {
        command:
            CatalogCommand::InspectObservation {
                port_id,
                file,
                repository_id,
            },
    } = &cli.command
    {
        let catalog = portcove_core::Catalog::embedded()?;
        let report = portcove_core::inspect_upstream_observation(
            catalog.port(port_id)?,
            *repository_id,
            file,
        )?;
        render_read_success(mode, "catalog.inspect-observation", report, |report| {
            catalog::upstream_observation(
                report,
                catalog
                    .port(port_id)
                    .expect("port was resolved before inspection"),
            )
        })?;
        return Ok(ExitCode::SUCCESS);
    }
    let platform_default = startup::observe(
        startup::DiagnosticPhase::LibrarySelection,
        portcove_core::Library::default_root(),
    )?;
    if let Commands::Library { command } = &cli.command {
        execute_library(
            &preferences,
            cli.library.as_deref(),
            &platform_default,
            command,
            mode,
        )?;
        return Ok(ExitCode::SUCCESS);
    }
    if let Commands::Tool { command } = &cli.command {
        execute_tool(&preferences, command, mode)?;
        return Ok(ExitCode::SUCCESS);
    }
    let selection = startup::observe(
        startup::DiagnosticPhase::LibrarySelection,
        preferences.resolve(cli.library.as_deref(), &platform_default),
    )?;
    let library = startup::observe(
        startup::DiagnosticPhase::LibraryOpen,
        portcove_core::Library::open(selection.root),
    )?;
    if let Commands::Launch {
        command: LaunchCommand::Show { request_id },
    } = &cli.command
    {
        let record = library.launch_request(&request_id.to_string())?;
        // Observation must remain available even when current catalog/provider
        // initialization fails. This optional human lookup never advances recovery.
        let display_service = if mode == OutputMode::Human {
            PortcoveService::new_read_only(library).ok()
        } else {
            None
        };
        render_read_success(mode, "launch.show", record, |record| {
            human_adapters::launch_record(
                record.as_ref(),
                &request_id.to_string(),
                display_service.as_ref().map(PortcoveService::catalog),
                cli.technical_details,
            )
        })?;
        return Ok(ExitCode::SUCCESS);
    }
    #[cfg(feature = "qualification-fixtures")]
    let qualification_provider = match (
        cli.qualification_provider_origin.as_deref(),
        cli.qualification_provider_library.as_deref(),
    ) {
        (Some(origin), Some(root)) => Some(std::sync::Arc::new(
            GithubReleaseProvider::for_qualification_library(&library, root, origin)?,
        )
            as std::sync::Arc<dyn portcove_core::ReleaseProvider>),
        (None, None) => None,
        _ => {
            return Err(PortcoveError::verification(
                "incomplete qualification provider binding",
            ));
        }
    };
    #[cfg(not(feature = "qualification-fixtures"))]
    let qualification_provider: Option<std::sync::Arc<dyn portcove_core::ReleaseProvider>> = None;
    let service = std::sync::Arc::new(startup::observe(
        startup::DiagnosticPhase::ServiceStartup,
        match qualification_provider {
            Some(provider) if command_is_observation(&cli.command) => {
                PortcoveService::with_provider_read_only(library, provider)
            }
            Some(provider) => PortcoveService::with_provider(library, provider),
            None if command_is_observation(&cli.command) => PortcoveService::new_read_only(library),
            None => PortcoveService::new(library),
        },
    )?);
    #[cfg(feature = "qualification-fixtures")]
    let qualification_update_run = matches!(
        &cli.command,
        Commands::Installation {
            command: InstallationCommand::QualificationUpdateRun { .. }
        }
    );
    #[cfg(not(feature = "qualification-fixtures"))]
    let qualification_update_run = false;
    let _cancellation_signals = (qualification_update_run
        || matches!(
            &cli.command,
            Commands::Install(_)
                | Commands::Installation {
                    command: InstallationCommand::Run { .. }
                }
                | Commands::Update(_)
                | Commands::Ensure(_)
                | Commands::Reconcile(_)
                | Commands::Check(_)
                | Commands::Catalog {
                    command: CatalogCommand::Update { apply: true, .. }
                }
                | Commands::Source {
                    command: SourceCommand::Discover(_)
                }
        ))
    .then(|| cancellation::CancellationSignals::start(service.clone()))
    .transpose()?;
    match cli.command {
        Commands::Installation {
            command: InstallationCommand::Plan { port_id },
        } => {
            let review = service.plan_game_install(&port_id).await?;
            let text = human::game_install_plan(&review, service.catalog());
            render_read_success(mode, "installation.plan", review, |_| text.clone())?;
        }
        Commands::Installation {
            command:
                InstallationCommand::Run {
                    port_id,
                    expected_plan,
                    acknowledge_shared_preferences,
                    yes,
                },
        } => {
            require_confirmation(
                "Install this exact reviewed release in its managed destination?",
                yes,
                cli.non_interactive,
            )?;
            let authorization = service
                .authorize_game_install_with_shared_preferences_ack(
                    &port_id,
                    &expected_plan,
                    acknowledge_shared_preferences.then_some(expected_plan.as_str()),
                )
                .await?;
            let mut progress = progress_renderer(mode, service.catalog());
            let installed = service
                .apply_game_install(&port_id, &authorization.token, &mut progress)
                .await?;
            render_read_success(mode, "installation.run", installed, |result| {
                format!(
                    "Reviewed installation completed\n{}",
                    human::install_result(result, service.catalog())
                )
            })?;
        }
        #[cfg(feature = "qualification-fixtures")]
        Commands::Installation {
            command: InstallationCommand::QualificationUpdatePlan { port_id },
        } => {
            let review = service.plan_game_update(&port_id, true).await?;
            render_read_success(
                mode,
                "installation.qualification-update-plan",
                review,
                |value| human::game_update_plan(value, service.catalog()),
            )?;
        }
        #[cfg(feature = "qualification-fixtures")]
        Commands::Installation {
            command:
                InstallationCommand::QualificationUpdateRun {
                    port_id,
                    expected_plan,
                    acknowledge_shared_preferences,
                    yes,
                },
        } => {
            require_confirmation(
                "Activate this exact reviewed fixture update?",
                yes,
                cli.non_interactive,
            )?;
            let authorization = service
                .authorize_game_update_with_shared_preferences_ack(
                    &port_id,
                    true,
                    &expected_plan,
                    acknowledge_shared_preferences.then_some(expected_plan.as_str()),
                )
                .await?;
            let mut progress = progress_renderer(mode, service.catalog());
            let installed = service
                .apply_game_update(&port_id, true, &authorization.token, &mut progress)
                .await?;
            render_read_success(
                mode,
                "installation.qualification-update-run",
                installed,
                |result| {
                    format!(
                        "Reviewed fixture update completed\n{}",
                        human::install_result(result, service.catalog())
                    )
                },
            )?;
        }
        Commands::Artwork { command } => {
            execute_artwork(&service, command, mode, cli.non_interactive)?
        }
        Commands::Cancel { operation_id } => {
            render_read_success(
                mode,
                "cancel",
                service.request_cancellation(&operation_id)?,
                |state| human::cancellation_requested(state, &operation_id),
            )?;
        }
        Commands::Library { .. } => {
            unreachable!("library commands handle exclusive access before opening a service")
        }
        Commands::Tool { .. } => {
            unreachable!("tool commands handle host preferences before opening a service")
        }
        Commands::Auth { command } => {
            let github = GithubReleaseProvider::for_library(service.library())?;
            match command {
                AuthCommand::Status => {
                    render_read_success(
                        mode,
                        "auth.status",
                        github.auth_status().await?,
                        human::auth_status,
                    )?;
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
                            render_read_success(
                                mode,
                                "auth.login",
                                result,
                                human_adapters::device_login_result,
                            )?;
                            break;
                        }
                    }
                }
                AuthCommand::SetToken { stdin } => {
                    let token = read_token(stdin, cli.non_interactive)?;
                    render_read_success(
                        mode,
                        "auth.set-token",
                        github.store_personal_token(&token).await?,
                        human::auth_status,
                    )?;
                }
                AuthCommand::Logout => {
                    render_read_success(
                        mode,
                        "auth.logout",
                        github.logout().await?,
                        human::auth_status,
                    )?;
                }
            }
        }
        Commands::Catalog { command } => {
            catalog::execute(command, &service, mode, cli.non_interactive).await?;
        }
        Commands::Backup {
            command: BackupCommand::GhostshipLegacyPlan { backup_id },
        } => {
            render_read_success(
                mode,
                "backup.ghostship-legacy-plan",
                service.plan_ghostship_legacy_recovery(&backup_id)?,
                human::ghostship_recovery_plan,
            )?;
        }
        Commands::Backup {
            command:
                BackupCommand::GhostshipLegacyRecover {
                    backup_id,
                    expected_plan,
                    yes,
                },
        } => {
            let plan = service.plan_ghostship_legacy_recovery(&backup_id)?;
            if plan.plan_sha256 != expected_plan {
                return Err(PortcoveError::conflict(
                    "legacy recovery inputs changed; review the plan again",
                ));
            }
            if mode == OutputMode::Human {
                println!("{}", human::ghostship_recovery_plan(&plan));
            }
            require_confirmation(
                "Activate a fresh Ghostship 2.0.0 derivative with the selected legacy data, retaining independent copies of current canonical and newer-runtime data?",
                yes,
                cli.non_interactive,
            )?;
            let authorization =
                service.authorize_ghostship_legacy_recovery(&backup_id, &expected_plan)?;
            render_read_success(
                mode,
                "backup.ghostship-legacy-recover",
                service.recover_ghostship_legacy_data(&backup_id, &authorization.token)?,
                |result| human_adapters::ghostship_recovery(result, service.catalog()),
            )?;
        }
        Commands::Backup {
            command: BackupCommand::Create { port_id },
        } => {
            render_read_success(
                mode,
                "backup.create",
                service.create_backup(&port_id)?,
                |result| human::backup_created(result, service.catalog()),
            )?;
        }
        Commands::Backup {
            command: BackupCommand::List { port_id },
        } => {
            render_read_success(
                mode,
                "backup.list",
                service.list_backups(&port_id)?,
                |backups| human::backup_list(&port_id, backups, service.catalog()),
            )?;
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
            if mode == OutputMode::Human {
                println!(
                    "{}",
                    human::backup_action_preview(&preview, service.catalog())
                );
                io::stdout().flush()?;
            }
            if !confirmation(
                &format!(
                    "Permanently delete backup {} for {}?",
                    human::clean(&backup_id),
                    human::port_name(service.catalog(), &port_id)
                ),
                yes,
                cli.non_interactive,
            )? {
                render_backup_cancellation(mode, "backup.delete", "Backup deletion")?;
                return Ok(ExitCode::SUCCESS);
            }
            let authorization = service.authorize_backup_action(
                &port_id,
                &backup_id,
                BackupAction::Delete,
                &preview.preview_sha256,
            )?;
            render_read_success(
                mode,
                "backup.delete",
                service.delete_backup(&port_id, &backup_id, &authorization.token)?,
                |result| human::backup_deleted(result, service.catalog()),
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
            if mode == OutputMode::Human {
                println!(
                    "{}",
                    human::backup_action_preview(&preview, service.catalog())
                );
                io::stdout().flush()?;
            }
            if !confirmation(
                &format!(
                    "Restore backup {} for {}? Replace this port's managed saves and settings.",
                    human::clean(&backup_id),
                    human::port_name(service.catalog(), &port_id)
                ),
                yes,
                cli.non_interactive,
            )? {
                render_backup_cancellation(mode, "backup.restore", "Backup restore")?;
                return Ok(ExitCode::SUCCESS);
            }
            let authorization = service.authorize_backup_action(
                &port_id,
                &backup_id,
                BackupAction::Restore,
                &preview.preview_sha256,
            )?;
            render_read_success(
                mode,
                "backup.restore",
                service.restore_backup(&port_id, &backup_id, &authorization.token)?,
                |result| human::backup_restored(result, service.catalog()),
            )?;
        }

        Commands::Source {
            command: SourceCommand::Discover(args),
        } => {
            render_read_success(
                mode,
                "source.discover",
                service.discover_sources_with_progress(
                    &args.request(),
                    progress_renderer(mode, service.catalog()),
                )?,
                |report| human::source_discovery(report, service.catalog()),
            )?;
        }
        Commands::Source {
            command: SourceCommand::Inbox { command },
        } => match command {
            SourceInboxCommand::Path { profile_id } => {
                render_read_success(
                    mode,
                    "source.inbox.path",
                    service.source_inbox_paths(Some(&profile_id))?,
                    |paths| human_adapters::inbox_paths(paths, service.catalog()),
                )?;
            }
            SourceInboxCommand::Open { profile_id } => {
                let paths = service.prepare_source_inbox_profile(&profile_id)?;
                open_cli_directory(paths.profile.as_deref().ok_or_else(|| {
                    PortcoveError::state("prepared Source Inbox has no profile path")
                })?)?;
                render_read_success(mode, "source.inbox.open", paths, |paths| {
                    human_adapters::inbox_paths(paths, service.catalog())
                })?;
            }
            SourceInboxCommand::Scan(args) => {
                let profile_id = args.profile_id.clone();
                let limits = args.limits();
                render_read_success(
                    mode,
                    "source.inbox.scan",
                    service.scan_source_inbox_with_progress(
                        &profile_id,
                        &limits,
                        progress_renderer(mode, service.catalog()),
                    )?,
                    |result| human_adapters::inbox_resolution(result, service.catalog()),
                )?;
            }
            SourceInboxCommand::Import {
                profile_id,
                path,
                mode: import_mode,
                apply,
                expected_plan,
                yes,
            } => {
                let import_mode = SourceImportMode::from(import_mode);
                if !apply {
                    render_read_success(
                        mode,
                        "source.inbox.import",
                        service.plan_source_import(&profile_id, &path, import_mode)?,
                        |result| human::source_import_plan(result, service.catalog()),
                    )?;
                } else {
                    let expected_plan = expected_plan
                        .as_deref()
                        .ok_or_else(|| PortcoveError::usage("--apply requires --expected-plan"))?;
                    let authorization = if import_mode == SourceImportMode::Move {
                        require_confirmation(
                            &format!(
                                "Move the game files for {} into Portcove's game-file folder? The original is deleted only after the copy is checked and its new location is saved.",
                                human::profile_name(service.catalog(), &profile_id)
                            ),
                            yes,
                            cli.non_interactive,
                        )?;
                        Some(
                            service
                                .authorize_source_move(&profile_id, &path, expected_plan)?
                                .token,
                        )
                    } else {
                        None
                    };
                    render_read_success(
                        mode,
                        "source.inbox.import",
                        service.import_source_with_progress(
                            &profile_id,
                            &path,
                            import_mode,
                            expected_plan,
                            authorization.as_deref(),
                            progress_renderer(mode, service.catalog()),
                        )?,
                        |result| human::source_import_result(result, service.catalog()),
                    )?;
                }
            }
        },
        Commands::Source {
            command: SourceCommand::Roots { command },
        } => match command {
            GameFileRootCommand::List => render_read_success(
                mode,
                "source.roots.list",
                service.library().game_file_roots()?,
                |roots| human::game_file_roots(roots),
            )?,
            GameFileRootCommand::Scan(args) => render_read_success(
                mode,
                "source.roots.scan",
                service.scan_game_file_roots_with_progress(
                    &args.limits(),
                    progress_renderer(mode, service.catalog()),
                )?,
                human::game_file_scan,
            )?,
            GameFileRootCommand::Snapshot => render_read_success(
                mode,
                "source.roots.snapshot",
                service.game_file_scan_snapshot()?,
                human::game_file_scan_snapshot,
            )?,
            GameFileRootCommand::Add { path } => render_read_success(
                mode,
                "source.roots.add",
                service.library().add_game_file_root(&path)?,
                |root| {
                    format!(
                        "Game-file folder saved\n{}",
                        human::game_file_roots(std::slice::from_ref(root))
                    )
                },
            )?,
            GameFileRootCommand::Relink { root_id, path } => render_read_success(
                mode,
                "source.roots.relink",
                service.library().relink_game_file_root(&root_id, &path)?,
                |root| {
                    format!(
                        "Game-file folder saved\n{}",
                        human::game_file_roots(std::slice::from_ref(root))
                    )
                },
            )?,
            GameFileRootCommand::Remove { root_id } => {
                let removed = service.library().remove_game_file_root(&root_id)?;
                render_read_success(
                    mode,
                    "source.roots.remove",
                    serde_json::json!({"root_id": root_id, "removed": removed}),
                    |_| {
                        format!(
                            "Game-file folder registration {}: {}\nThe folder's files and existing game-file registrations remain in place.",
                            if removed { "removed" } else { "not found" },
                            human::clean(&root_id)
                        )
                    },
                )?;
            }
        },
        Commands::Source {
            command:
                SourceCommand::Add {
                    profile_id,
                    path,
                    expected_sha256,
                },
        } => {
            render_read_success(
                mode,
                "source.add",
                if let Some(digest) = expected_sha256 {
                    service.register_source_with_digest(&profile_id, &path, &digest)?
                } else {
                    service.register_source(&profile_id, &path)?
                },
                |result| human::source_record(result, service.catalog()),
            )?;
        }
        Commands::Source {
            command: SourceCommand::List,
        } => {
            render_read_success(
                mode,
                "source.list",
                service.library().sources()?,
                |sources| human::source_list(sources, service.catalog()),
            )?;
        }
        Commands::Source {
            command: SourceCommand::Inspect { profile_id },
        } => {
            render_read_success(
                mode,
                "source.inspect",
                service.inspect_registered_source(&profile_id)?,
                human::source_inspection,
            )?;
        }
        Commands::Source {
            command: SourceCommand::Query(args),
        } => {
            let request = portcove_core::GameFileQueryRefreshRequest {
                routes: vec![portcove_core::GameFileRouteRequest {
                    port_id: args.port_id,
                    platform: portcove_core::Platform::current()?,
                    channel: args.channel.into(),
                    route: args.route.into(),
                }],
                limits: portcove_core::RegisteredSourceInspectionLimits {
                    max_file_bytes: args.max_file_bytes,
                    max_hash_bytes: args.max_hash_bytes,
                    max_elapsed_ms: args.max_elapsed_ms,
                },
                maximum_age_seconds: args.maximum_age_seconds,
            };
            render_read_success(
                mode,
                "source.query",
                service.refresh_game_file_query_with_progress(
                    &request,
                    progress_renderer(mode, service.catalog()),
                )?,
                |value| human::game_file_query(value, service.catalog()),
            )?;
        }
        Commands::Source {
            command:
                SourceCommand::Relink {
                    profile_id,
                    path,
                    apply,
                    expected_plan,
                },
        } => {
            if apply {
                render_read_success(
                    mode,
                    "source.relink",
                    service.relink_source(
                        &profile_id,
                        &path,
                        expected_plan.as_deref().ok_or_else(|| {
                            PortcoveError::usage("--apply requires --expected-plan")
                        })?,
                    )?,
                    |result| human::source_record(result, service.catalog()),
                )?;
            } else {
                render_read_success(
                    mode,
                    "source.relink",
                    service.plan_source_relink(&profile_id, &path)?,
                    |result| human::source_relink_plan(result, service.catalog()),
                )?;
            }
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
                render_read_success(mode, "source.verify", outcomes, |results| {
                    human_adapters::source_batch(results, service.catalog(), cli.technical_details)
                })?;
            } else {
                let profile_id = args
                    .profile_id
                    .ok_or_else(|| PortcoveError::usage("provide PROFILE_ID or --all"))?;
                let verification = service.verify_source(&profile_id)?;
                render_success_with(mode, "source.verify", verification, |result| {
                    Ok(human::source_inspection(&result.inspection))
                })?;
            }
        }
        Commands::Source {
            command: SourceCommand::Remove { profile_id, yes },
        } => {
            let preview = service.preview_source_removal(&profile_id)?;
            if mode == OutputMode::Human {
                println!(
                    "{}",
                    human::source_removal_preview(&preview, service.catalog())
                );
            }
            let impact = if preview.installed_dependent_port_ids.is_empty() {
                "No installed port currently depends on it.".to_owned()
            } else {
                format!(
                    "These installed ports depend on this saved registration and may need the game files registered again: {}.",
                    preview
                        .installed_dependent_port_ids
                        .iter()
                        .map(|id| human::port_name(service.catalog(), id))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            require_confirmation(
                &format!(
                    "Remove {} from Portcove? The original game files will not be deleted or changed. {impact}",
                    human::profile_name(service.catalog(), &profile_id)
                ),
                yes,
                cli.non_interactive,
            )?;
            let authorization =
                service.authorize_source_removal(&profile_id, &preview.preview_sha256)?;
            let removed = service.remove_source(&profile_id, &authorization.token)?;
            render_read_success(
                mode,
                "source.remove",
                serde_json::json!({ "removed": true, "preview": removed }),
                |_| {
                    format!(
                        "Game-file registration removed: {}\nThe original game files remain in place.\n{impact}",
                        human::profile_name(service.catalog(), &profile_id)
                    )
                },
            )?;
        }
        Commands::Status { port_id } => {
            if let Some(port_id) = port_id {
                render_read_success(mode, "status", service.status(&port_id)?, |value| {
                    human::status(value, service.catalog())
                })?;
            } else {
                render_read_success(mode, "status", service.statuses()?, |statuses| {
                    human::statuses(statuses, service.catalog())
                })?;
            }
        }
        Commands::Activity {
            command: None,
            limit,
        } => {
            render_read_success(
                mode,
                "activity",
                service.library().activity_feed(limit as usize)?,
                |feed| human::activities(feed, service.catalog(), cli.technical_details),
            )?;
        }
        Commands::Activity {
            command: Some(ActivityCommand::Log { activity_id }),
            ..
        } => {
            render_read_success(
                mode,
                "activity.log",
                service.library().activity_diagnostic(&activity_id)?,
                |captures| human::activity_diagnostic(captures),
            )?;
        }
        Commands::Launch {
            command: LaunchCommand::Recover { request_id },
        } => {
            service.recover_launch_session(&request_id.to_string())?;
            render_read_success(
                mode,
                "launch.recover",
                service.library().launch_request(&request_id.to_string())?,
                |record| {
                    human_adapters::launch_record(
                        record.as_ref(),
                        &request_id.to_string(),
                        Some(service.catalog()),
                        cli.technical_details,
                    )
                },
            )?;
        }
        Commands::Launch {
            command: LaunchCommand::Show { .. },
        } => unreachable!("launch observation is handled before service initialization"),
        Commands::Storage => {
            render_read_success(
                mode,
                "storage",
                service.library().storage_summary()?,
                human::storage,
            )?;
        }
        Commands::Doctor => {
            render_read_success(
                mode,
                "doctor",
                service.doctor_with_preferences(&preferences)?,
                |value| human::doctor(value, service.catalog()),
            )?;
        }
        Commands::About => unreachable!("about exits before opening the library"),
        Commands::Plan {
            port_id,
            channel,
            output_dir,
        } => {
            render_read_success(
                mode,
                "plan",
                service
                    .plan_install_at(&port_id, channel.map(Into::into), output_dir.as_deref())
                    .await?,
                |value| human::plan(value, service.catalog()),
            )?;
        }
        Commands::Preparation {
            command: PreparationCommand::Plan { port_id },
        } => {
            render_read_success(
                mode,
                "preparation.plan",
                service.plan_preparation(
                    &port_id,
                    portcove_core::PreparationOptions {
                        target: portcove_core::Platform::current()?,
                        mode: portcove_core::PreparationMode::Default,
                    },
                )?,
                |value| human::preparation_plan(value, service.catalog()),
            )?;
        }
        Commands::Preparation {
            command:
                PreparationCommand::Run {
                    port_id,
                    expected_plan,
                    yes,
                },
        } => {
            let options = portcove_core::PreparationOptions {
                target: portcove_core::Platform::current()?,
                mode: portcove_core::PreparationMode::Default,
            };
            let plan = service.plan_preparation(&port_id, options)?;
            if plan.plan_sha256 != expected_plan {
                return Err(PortcoveError::conflict(
                    "preparation inputs changed; review the plan again",
                ));
            }
            if mode == OutputMode::Human {
                println!("{}", human::preparation_plan(&plan, service.catalog()));
            }
            require_confirmation(
                "Prepare game data in a private copy and activate the verified result?",
                yes,
                cli.non_interactive,
            )?;
            let authorization = service.authorize_preparation(&port_id, options, &expected_plan)?;
            let prepared = service.prepare(
                &port_id,
                options,
                &authorization.token,
                progress_renderer(mode, service.catalog()),
            )?;
            render_read_success(mode, "preparation.run", prepared, |result| {
                format!(
                    "Game preparation completed\n{}",
                    human::install_result(result, service.catalog())
                )
            })?;
        }
        Commands::Preparation {
            command: PreparationCommand::CleanupPlan { operation_id },
        } => {
            render_read_success(
                mode,
                "preparation.cleanup-plan",
                service.preview_preparation_cleanup(&operation_id)?,
                |value| human::preparation_cleanup(value, service.catalog()),
            )?;
        }
        Commands::Preparation {
            command:
                PreparationCommand::Cleanup {
                    operation_id,
                    expected_preview,
                    yes,
                },
        } => {
            let preview = service.preview_preparation_cleanup(&operation_id)?;
            if mode == OutputMode::Human {
                println!(
                    "{}",
                    human::preparation_cleanup(&preview, service.catalog())
                );
            }
            if preview.preview_sha256 != expected_preview {
                return Err(PortcoveError::conflict(
                    "retained preparation changed; review cleanup again",
                ));
            }
            require_confirmation(
                "Permanently discard only these retained private preparation files?",
                yes,
                cli.non_interactive,
            )?;
            let authorization =
                service.authorize_preparation_cleanup(&operation_id, &expected_preview)?;
            render_read_success(
                mode,
                "preparation.cleanup",
                service.cleanup_preparation(&operation_id, &authorization.token)?,
                |result| human_adapters::preparation_cleaned(result),
            )?;
        }
        Commands::Paths { port_id } => {
            render_read_success(mode, "paths", service.port_paths(&port_id)?, |value| {
                human::paths(value, service.catalog())
            })?;
        }
        Commands::Output { command } => match command {
            OutputCommand::Show { port_id } => render_read_success(
                mode,
                "output.show",
                service.output_location(&port_id, None)?,
                |value| human::output_location(value, service.catalog()),
            )?,
            OutputCommand::Preview { port_id, path } => render_read_success(
                mode,
                "output.preview",
                service.preview_output_directory(&port_id, path.as_deref())?,
                |value| human::output_preview(value, service.catalog()),
            )?,
            OutputCommand::Set {
                port_id,
                path,
                expected_preview,
                yes,
            } => {
                let preview = service.preview_output_directory(&port_id, Some(&path))?;
                if mode == OutputMode::Human {
                    println!("{}", human::output_preview(&preview, service.catalog()));
                }
                if preview.preview_sha256 != expected_preview {
                    return Err(PortcoveError::conflict(
                        "output destination preview changed; review it again",
                    ));
                }
                require_confirmation(
                    "Change the future install folder? Existing installations will not move.",
                    yes,
                    cli.non_interactive,
                )?;
                let authorization = service.authorize_output_directory_change(
                    &port_id,
                    Some(&path),
                    &expected_preview,
                )?;
                render_read_success(
                    mode,
                    "output.set",
                    service.apply_output_directory_change(
                        &port_id,
                        Some(&path),
                        &authorization.token,
                    )?,
                    |result| human::output_location(result, service.catalog()),
                )?;
            }
            OutputCommand::Reset {
                port_id,
                expected_preview,
                yes,
            } => {
                let preview = service.preview_output_directory(&port_id, None)?;
                if mode == OutputMode::Human {
                    println!("{}", human::output_preview(&preview, service.catalog()));
                }
                if preview.preview_sha256 != expected_preview {
                    return Err(PortcoveError::conflict(
                        "output destination preview changed; review it again",
                    ));
                }
                require_confirmation(
                    "Use the library default for future installs? Existing installations will not move.",
                    yes,
                    cli.non_interactive,
                )?;
                let authorization =
                    service.authorize_output_directory_change(&port_id, None, &expected_preview)?;
                render_read_success(
                    mode,
                    "output.reset",
                    service.apply_output_directory_change(&port_id, None, &authorization.token)?,
                    |result| human::output_location(result, service.catalog()),
                )?;
            }
            OutputCommand::Move {
                port_id,
                path,
                apply,
                expected_plan,
                yes,
            } => {
                let plan = service.plan_output_relocation(&port_id, &path)?;
                if !apply {
                    render_read_success(mode, "output.move", plan, |value| {
                        human::output_relocation_plan(value, service.catalog())
                    })?;
                } else {
                    if mode == OutputMode::Human {
                        println!(
                            "{}",
                            human::output_relocation_plan(&plan, service.catalog())
                        );
                    }
                    let expected_plan = expected_plan
                        .as_deref()
                        .ok_or_else(|| PortcoveError::usage("--apply requires --expected-plan"))?;
                    if plan.plan_sha256 != expected_plan {
                        return Err(PortcoveError::conflict(
                            "output relocation plan changed; review it again",
                        ));
                    }
                    require_confirmation(
                        "Relocate every installed version for this game and make the destination authoritative?",
                        yes,
                        cli.non_interactive,
                    )?;
                    let authorization =
                        service.authorize_output_relocation(&port_id, &path, expected_plan)?;
                    render_read_success(
                        mode,
                        "output.move",
                        service.relocate_output(&port_id, &path, &authorization.token)?,
                        |result| human::output_relocation_result(result, service.catalog()),
                    )?;
                }
            }
        },
        Commands::Check(args) => {
            if args.all {
                let installed = service
                    .statuses()?
                    .into_iter()
                    .filter(|status| status.active.is_some())
                    .map(|status| status.port_id)
                    .collect::<Vec<_>>();
                let checked = service
                    .check_updates(installed)
                    .await?
                    .into_iter()
                    .map(|(port_id, result)| match result {
                        Ok(result) => PortBatchOutcome::success(port_id, result),
                        Err(error) => PortBatchOutcome::failure(port_id, &error),
                    })
                    .collect::<Vec<_>>();
                render_read_success(mode, "check", checked, |results| {
                    human_adapters::port_batch(
                        "Update checks",
                        results,
                        service.catalog(),
                        cli.technical_details,
                        human::update_check,
                    )
                })?;
            } else {
                let port_id = args
                    .port_id
                    .ok_or_else(|| PortcoveError::usage("provide PORT_ID or --all"))?;
                render_read_success(
                    mode,
                    "check",
                    service.check_update(&port_id).await?,
                    |result| human::update_check(result, service.catalog()),
                )?;
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
                    let mut progress = progress_renderer(mode, service.catalog());
                    match service.reconcile(&status.port_id, &mut progress).await {
                        Ok(result) => {
                            reconciled.push(PortBatchOutcome::success(status.port_id, result))
                        }
                        Err(error) => {
                            reconciled.push(PortBatchOutcome::failure(status.port_id, &error))
                        }
                    }
                }
                render_read_success(mode, "reconcile", reconciled, |results| {
                    human_adapters::port_batch(
                        "Game update results",
                        results,
                        service.catalog(),
                        cli.technical_details,
                        human::reconcile_result,
                    )
                })?;
            } else {
                let port_id = args
                    .port_id
                    .ok_or_else(|| PortcoveError::usage("provide PORT_ID or --all"))?;
                if mode == OutputMode::Human {
                    for notice in service.catalog().port(&port_id)?.preservation_notices() {
                        println!("{notice}");
                    }
                }
                let mut progress = progress_renderer(mode, service.catalog());
                render_read_success(
                    mode,
                    "reconcile",
                    service.reconcile(&port_id, &mut progress).await?,
                    |result| human::reconcile_result(result, service.catalog()),
                )?;
            }
        }
        Commands::Install(args) => {
            let mut progress = progress_renderer(mode, service.catalog());
            let install = service
                .install_at(
                    &args.port_id,
                    args.channel.map(Into::into),
                    InstallOverrides {
                        source: args.source.as_deref(),
                        bios: args.bios.as_deref(),
                        output_directory: args.output_dir.as_deref(),
                    },
                    !args.stage,
                    &mut progress,
                )
                .await?;
            render_read_success(mode, "install", install, |result| {
                format!(
                    "Install request completed\n{}",
                    human::install_result(result, service.catalog())
                )
            })?;
        }
        Commands::Ensure(args) => {
            let mut progress = progress_renderer(mode, service.catalog());
            let install = service
                .ensure_at(
                    &args.port_id,
                    args.channel.map(Into::into),
                    args.source.as_deref(),
                    args.bios.as_deref(),
                    args.output_dir.as_deref(),
                    &mut progress,
                )
                .await?;
            render_read_success(mode, "ensure", install, |result| {
                format!(
                    "Ensure request completed\n{}",
                    human::install_result(result, service.catalog())
                )
            })?;
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
                    let mut progress = progress_renderer(mode, service.catalog());
                    let port_id = status.port_id;
                    if mode == OutputMode::Human {
                        for notice in service.catalog().port(&port_id)?.preservation_notices() {
                            println!("{notice}");
                        }
                    }
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
                render_read_success(mode, "update", updated, |results| {
                    human_adapters::port_batch(
                        "Update results",
                        results,
                        service.catalog(),
                        cli.technical_details,
                        human::install_result,
                    )
                })?;
            } else {
                let port_id = args
                    .port_id
                    .ok_or_else(|| PortcoveError::usage("provide PORT_ID or --all"))?;
                let mut progress = progress_renderer(mode, service.catalog());
                let install = service
                    .update(
                        &port_id,
                        args.source.as_deref(),
                        args.bios.as_deref(),
                        !args.stage,
                        &mut progress,
                    )
                    .await?;
                render_read_success(mode, "update", install, |result| {
                    human::install_result(result, service.catalog())
                })?;
            }
        }
        Commands::Verify { port_id } => {
            render_read_success(mode, "verify", service.verify(&port_id)?, |report| {
                human::verification_report(report, &port_id, service.catalog())
            })?
        }
        Commands::Activate { port_id } => render_read_success(
            mode,
            "activate",
            service.activate_staged(&port_id)?,
            |result| {
                format!(
                    "Staged activation completed\n{}",
                    human::install_result(result, service.catalog())
                )
            },
        )?,
        Commands::Rollback { port_id } => {
            render_read_success(mode, "rollback", service.rollback(&port_id)?, |result| {
                format!(
                    "Rollback completed\n{}",
                    human::install_result(result, service.catalog())
                )
            })?
        }
        Commands::RemovePreview { port_id } => {
            render_read_success(
                mode,
                "remove.preview",
                service.preview_removal(&port_id)?,
                |result| human::removal_preview(result, service.catalog()),
            )?;
        }
        Commands::Remove {
            port_id,
            yes,
            expected_preview,
        } => {
            let preview = service.preview_removal(&port_id)?;
            if expected_preview
                .as_ref()
                .is_some_and(|expected| expected != &preview.preview_sha256)
            {
                return Err(PortcoveError::conflict(
                    "managed installs changed after preview; review removal again",
                ));
            }
            if mode == OutputMode::Human {
                println!("{}", human::removal_preview(&preview, service.catalog()));
            }
            require_confirmation(
                &format!(
                    "Remove all managed application versions for {}? Saves and settings in Portcove's persistent data folder will be kept. Sign-ins stored only in installed versions will be deleted.",
                    human::port_name(service.catalog(), &port_id)
                ),
                yes,
                cli.non_interactive,
            )?;
            let authorization = service.authorize_removal(&port_id, &preview.preview_sha256)?;
            let removed = service.remove(&port_id, &authorization.token)?;
            let removed_count = removed.len();
            render_read_success(
                mode,
                "remove",
                serde_json::json!({ "removed": removed }),
                |_| {
                    format!(
                        "{} for {}.\nSaves and settings retained at: {}",
                        if removed_count > 0 {
                            format!("Managed application versions removed: {removed_count}")
                        } else {
                            "No managed application versions to remove".to_owned()
                        },
                        human::port_name(service.catalog(), &port_id),
                        human::clean(&preview.persistent_data_path.display().to_string())
                    )
                },
            )?;
        }
        Commands::External { command } => match command {
            ExternalCommand::RelinkPreview { port_id, path } => {
                render_read_success(
                    mode,
                    "external.relink-preview",
                    service.preview_external_runtime_relink(&port_id, &path)?,
                    |result| human::external_relink_preview(result, service.catalog()),
                )?;
            }
            ExternalCommand::Relink {
                port_id,
                path,
                expected_preview,
                acknowledge_shared_preferences,
                yes,
            } => {
                let preview = service.preview_external_runtime_relink(&port_id, &path)?;
                if preview.preview_sha256 != expected_preview {
                    return Err(PortcoveError::conflict(
                        "external game folder or registration changed after review",
                    ));
                }
                if mode == OutputMode::Human {
                    println!(
                        "{}",
                        human::external_relink_preview(&preview, service.catalog())
                    );
                }
                if let Some(shared) = &preview.proposed.shared_preferences {
                    if mode == OutputMode::Human {
                        println!("{}", human::clean(&shared.write_scope_disclosure()?));
                    }
                    if !acknowledge_shared_preferences {
                        return Err(PortcoveError::usage(
                            "review the shared preferences and use --acknowledge-shared-preferences with the outer --expected-preview",
                        ));
                    }
                } else if acknowledge_shared_preferences {
                    return Err(PortcoveError::usage(
                        "this runtime has no shared preferences scope to acknowledge",
                    ));
                }
                require_confirmation(
                    &format!(
                        "Change {} from {} to {}? All external game files, settings and saves stay in place. Portcove does not copy, update, back up or delete either folder.",
                        human::port_name(service.catalog(), &port_id),
                        preview.previous_path.display(),
                        preview.proposed.path.display()
                    ),
                    yes,
                    cli.non_interactive,
                )?;
                let authorization = service.authorize_external_runtime_relink(
                    &port_id,
                    &path,
                    &expected_preview,
                    acknowledge_shared_preferences.then_some(expected_preview.as_str()),
                )?;
                render_read_success(
                    mode,
                    "external.relink",
                    service.relink_external_runtime(&port_id, &path, &authorization.token)?,
                    |result| human::external_runtime(result, service.catalog()),
                )?;
            }
            ExternalCommand::Preview { port_id, path } => {
                render_read_success(
                    mode,
                    "external.preview",
                    service.preview_external_runtime(&port_id, &path)?,
                    |result| human::external_preview(result, service.catalog()),
                )?;
            }
            ExternalCommand::Register {
                port_id,
                path,
                expected_preview,
                acknowledge_shared_preferences,
                yes,
            } => {
                let preview = service.preview_external_runtime(&port_id, &path)?;
                if mode == OutputMode::Human {
                    println!("{}", human::external_preview(&preview, service.catalog()));
                }
                if let Some(shared) = &preview.shared_preferences {
                    if mode == OutputMode::Human {
                        println!("{}", human::clean(&shared.write_scope_disclosure()?));
                    }
                    if !acknowledge_shared_preferences {
                        return Err(PortcoveError::usage(
                            "review the shared preferences and use --acknowledge-shared-preferences with --expected-preview",
                        ));
                    }
                } else if acknowledge_shared_preferences {
                    return Err(PortcoveError::usage(
                        "this runtime has no shared preferences scope to acknowledge",
                    ));
                }
                require_confirmation(
                    &format!(
                        "Use the installation for {} at {}? Portcove will use it in place. It will not copy, update, back up, or delete its files.",
                        human::port_name(service.catalog(), &port_id),
                        preview.path.display()
                    ),
                    yes,
                    cli.non_interactive,
                )?;
                let authorization = service
                    .authorize_external_runtime_with_shared_preferences_ack(
                        &port_id,
                        &path,
                        expected_preview
                            .as_deref()
                            .unwrap_or(&preview.preview_sha256),
                        acknowledge_shared_preferences.then_some(preview.preview_sha256.as_str()),
                    )?;
                render_read_success(
                    mode,
                    "external.register",
                    service.register_external_runtime(&port_id, &path, &authorization.token)?,
                    |result| human::external_runtime(result, service.catalog()),
                )?;
            }
            ExternalCommand::RemovalPreview { port_id } => {
                render_read_success(
                    mode,
                    "external.removal-preview",
                    service.preview_external_removal(&port_id)?,
                    |result| human::external_removal_preview(result, service.catalog()),
                )?;
            }
            ExternalCommand::Remove {
                port_id,
                expected_preview,
                yes,
            } => {
                let preview = service.preview_external_removal(&port_id)?;
                if mode == OutputMode::Human {
                    println!(
                        "{}",
                        human::external_removal_preview(&preview, service.catalog())
                    );
                }
                require_confirmation(
                    &format!(
                        "Stop using this installation for {}? The files at {} and all other external files will stay where they are.",
                        human::port_name(service.catalog(), &port_id),
                        preview.path.display()
                    ),
                    yes,
                    cli.non_interactive,
                )?;
                let authorization = service.authorize_external_removal(
                    &port_id,
                    expected_preview
                        .as_deref()
                        .unwrap_or(&preview.preview_sha256),
                )?;
                render_read_success(
                    mode,
                    "external.remove",
                    service.remove_external_runtime(&port_id, &authorization.token)?,
                    |record| human_adapters::external_removed(record, service.catalog()),
                )?;
            }
        },
        Commands::Adopt(args) => {
            let preview = service.preview_adoption(&args.path, args.port.as_deref())?;
            if mode == OutputMode::Human {
                println!("{}", human::adoption_preview(&preview, service.catalog()));
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
            render_read_success(
                mode,
                "adopt",
                service.adopt(&args.path, args.port.as_deref(), &authorization.token)?,
                |result| {
                    format!(
                        "Existing installation copied\n{}",
                        human::install_result(result, service.catalog())
                    )
                },
            )?;
        }
        Commands::Channel {
            command: ChannelCommand::Set { port_id, channel },
        } => {
            render_read_success(
                mode,
                "channel.set",
                service.set_channel(&port_id, channel.into())?,
                |result| human::status(result, service.catalog()),
            )?;
        }
        Commands::Policy {
            command: PolicyCommand::Set { port_id, policy },
        } => {
            render_read_success(
                mode,
                "policy.set",
                service.set_update_policy(&port_id, policy.into())?,
                |result| human::status(result, service.catalog()),
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
        Commands::Capabilities => render_read_success(
            mode,
            "capabilities",
            CapabilityDocument::current(),
            human::capabilities,
        )?,
        Commands::Schema {
            command: SchemaCommand::Export { contract },
        } => {
            render_success(mode, "schema.export", schema::document(contract))?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn host_preference_store() -> Result<HostPreferenceStore> {
    HostPreferenceStore::open_configured()
}

fn execute_tool(
    preferences: &HostPreferenceStore,
    command: &ToolCommand,
    mode: OutputMode,
) -> Result<()> {
    match command {
        ToolCommand::List => render_read_success(
            mode,
            "tool.list",
            portcove_core::host_tool_statuses(preferences)?,
            |tools| human::host_tools(tools),
        ),
        ToolCommand::SetPath {
            tool_id,
            executable_path,
        } => render_read_success(
            mode,
            "tool.set-path",
            portcove_core::configure_host_tool(preferences, tool_id, executable_path)?,
            human::host_tool_probe,
        ),
        ToolCommand::ClearPath { tool_id } => {
            portcove_core::clear_host_tool(preferences, tool_id)?;
            let status = portcove_core::host_tool_statuses(preferences)?
                .into_iter()
                .find(|status| status.id == *tool_id)
                .ok_or_else(|| PortcoveError::usage(format!("unknown host tool: {tool_id}")))?;
            render_read_success(mode, "tool.clear-path", status, human::host_tool)
        }
    }
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

fn library_command_name(command: &LibraryCommand) -> &'static str {
    match command {
        LibraryCommand::Show => "library.show",
        LibraryCommand::Identity => "library.identity",
        LibraryCommand::Set { .. } => "library.set",
        LibraryCommand::Reset => "library.reset",
        LibraryCommand::Import { .. } => "library.import",
        LibraryCommand::ResumeImport => "library.resume_import",
        LibraryCommand::AbortImport => "library.abort_import",
        LibraryCommand::Export { .. } => "library.export",
        LibraryCommand::Move { .. } => "library.move",
        LibraryCommand::ResumeMove => "library.resume_move",
        LibraryCommand::AbortMove => "library.abort_move",
    }
}

fn execute_library(
    preferences: &HostPreferenceStore,
    invocation_root: Option<&std::path::Path>,
    platform_default: &std::path::Path,
    command: &LibraryCommand,
    mode: OutputMode,
) -> Result<()> {
    let name = library_command_name(command);
    match command {
        LibraryCommand::Show => render_read_success(
            mode,
            name,
            preferences.resolve(invocation_root, platform_default)?,
            human_adapters::library_selection,
        )?,
        LibraryCommand::Identity => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            let library = portcove_core::Library::open(&root)?;
            render_read_success(
                mode,
                name,
                library.identity_record()?,
                human_adapters::library_identity,
            )?;
        }
        LibraryCommand::Set { path } => {
            preferences.set_library(path)?;
            render_read_success(
                mode,
                name,
                preferences.resolve(None, platform_default)?,
                human_adapters::library_selection,
            )?;
        }
        LibraryCommand::Reset => {
            preferences.reset()?;
            render_read_success(
                mode,
                name,
                preferences.resolve(None, platform_default)?,
                human_adapters::library_selection,
            )?;
        }
        LibraryCommand::Import {
            metadata,
            content_root,
            apply: true,
            expected_plan,
        } => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            render_read_success(
                mode,
                name,
                PortcoveService::import_library(
                    metadata,
                    content_root,
                    &root,
                    expected_plan.as_deref().ok_or_else(|| {
                        PortcoveError::usage("applying an import requires --expected-plan")
                    })?,
                )?,
                human::library_import_result,
            )?;
        }
        LibraryCommand::Import {
            metadata,
            content_root,
            ..
        } => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            render_read_success(
                mode,
                name,
                PortcoveService::plan_library_import(metadata, content_root, &root)?,
                human::library_import_plan,
            )?;
        }
        LibraryCommand::ResumeImport => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            render_read_success(
                mode,
                name,
                PortcoveService::resume_library_import(&root)?,
                human::library_import_result,
            )?
        }
        LibraryCommand::AbortImport => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            render_read_success(
                mode,
                name,
                PortcoveService::abort_library_import(&root)?,
                human::library_import_result,
            )?
        }
        LibraryCommand::ResumeMove => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            render_read_success(
                mode,
                name,
                PortcoveService::resume_library_move(&root)?,
                human::library_move_result,
            )?
        }
        LibraryCommand::AbortMove => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            render_read_success(
                mode,
                name,
                PortcoveService::abort_library_move(&root)?,
                human::library_move_result,
            )?
        }
        LibraryCommand::Move {
            destination,
            apply: true,
            expected_plan,
        } => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            let source = portcove_core::Library::open(&root)?.root().to_path_buf();
            render_read_success(
                mode,
                name,
                PortcoveService::move_library(
                    &source,
                    destination,
                    expected_plan.as_deref().ok_or_else(|| {
                        PortcoveError::usage("applying a move requires --expected-plan")
                    })?,
                )?,
                human::library_move_result,
            )?;
        }
        LibraryCommand::Move { destination, .. } => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            let service = PortcoveService::new_read_only(portcove_core::Library::open(root)?)?;
            render_read_success(
                mode,
                name,
                service.plan_library_move(destination)?,
                human::library_move_plan,
            )?;
        }
        LibraryCommand::Export { output } => {
            let root = preferences.resolve(invocation_root, platform_default)?.root;
            let service = PortcoveService::new_read_only(portcove_core::Library::open(root)?)?;
            if let Some(path) = output {
                render_read_success(
                    mode,
                    name,
                    service.write_library_metadata(path)?,
                    human::library_metadata_file,
                )?;
            } else {
                render_read_success(
                    mode,
                    name,
                    service.export_library_metadata()?,
                    human::library_metadata,
                )?;
            }
        }
    }
    Ok(())
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
    write_device_prompt(
        mode,
        login,
        &mut io::stdout().lock(),
        &mut io::stderr().lock(),
    )
}

fn write_device_prompt(
    mode: OutputMode,
    login: &GithubDeviceLogin,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> Result<()> {
    let message = format!(
        "Open {} and enter code {}",
        login.verification_uri, login.user_code
    );
    match mode {
        OutputMode::Human => writeln!(
            stdout,
            "Open {} and enter code {} to sign in to GitHub.\nExpires: {}",
            human::clean(&login.verification_uri),
            human::clean(&login.user_code),
            i64::try_from(login.expires_at).map_or_else(
                |_| "Unknown expiry (invalid timestamp)".into(),
                human::utc_time
            )
        )?,
        OutputMode::Json => writeln!(stderr, "{message}")?,
        OutputMode::Jsonl => writeln!(
            stdout,
            "{}",
            serde_json::to_string(&serde_json::json!({
                "schema_version": API_SCHEMA_VERSION,
                "type": "device_authorization",
                "data": login,
            }))?
        )?,
    }
    Ok(())
}

fn render_about(mode: OutputMode) -> Result<()> {
    let about = AboutDocument {
        product: "Portcove".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        description: "Install, update, and play native game ports.".into(),
        repository: env!("CARGO_PKG_REPOSITORY").into(),
        license: env!("CARGO_PKG_LICENSE").into(),
    };
    if mode == OutputMode::Human {
        println!(
            "Portcove {}\nManage native game ports from a local Portcove library.\n{}\nLicense: {}",
            about.version, about.repository, about.license
        );
        Ok(())
    } else {
        render_success(mode, "about", about)
    }
}

async fn exec_game(service: &PortcoveService, args: ExecArgs) -> Result<ExitCode> {
    let library = service.library().clone();
    let control_library = library.clone();
    let request_id = args.request_id.map(|id| id.to_string()).unwrap_or_else(|| {
        OperationCoordinator::new("launch", None)
            .operation_id()
            .to_owned()
    });
    let worker_request_id = request_id.clone();
    let (accepted_sender, accepted_receiver) = tokio::sync::oneshot::channel();
    let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
    let mut supervision = tokio::task::spawn_blocking(move || {
        PortcoveService::new(library)?.supervise_launch_identified(
            IdentifiedLaunchRequest {
                request_id: &worker_request_id,
                port_id: &args.port_id,
                source_override: args.source.as_deref(),
                arguments: &args.game_args,
                stdio: LaunchStdio::Inherit,
            },
            |session| {
                let _ = accepted_sender.send(session.id.clone());
            },
            |session| {
                let _ = started_sender.send(session.child_pid.expect("started session has a PID"));
            },
        )
    });
    tokio::pin!(accepted_receiver);
    tokio::pin!(started_receiver);
    let mut waiting_for_acceptance = true;
    let mut waiting_for_child = true;
    let mut accepted_request = None;
    let mut child_pid = None;
    let mut pending_signal = None;
    let mut cancellation_requested = false;
    loop {
        tokio::select! {
            result = &mut supervision => {
                let outcome = result
                    .map_err(|error| PortcoveError::state(format!("launch supervisor task failed: {error}")))??;
                return Ok(ExitCode::from(normalize_process_exit(outcome.exit_code)));
            }
            accepted = &mut accepted_receiver, if waiting_for_acceptance => {
                waiting_for_acceptance = false;
                if let Ok(id) = accepted {
                    accepted_request = Some(id.clone());
                    if let Some(signal) = pending_signal {
                        match PortcoveService::new(control_library.clone())?.request_cancellation(&id) {
                            Ok(_) => {
                                cancellation_requested = true;
                                pending_signal = None;
                            }
                            Err(error) if error.code == ErrorCode::Conflict => {
                                pending_signal = Some(signal);
                            }
                            Err(error) => eprintln!("Portcove warning: {error}"),
                        }
                    }
                }
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
                } else if !cancellation_requested {
                    pending_signal = Some(signal);
                    if let Some(id) = &accepted_request {
                        match PortcoveService::new(control_library.clone())?.request_cancellation(id) {
                            Ok(_) => {
                                cancellation_requested = true;
                                pending_signal = None;
                            }
                            Err(error) if error.code == ErrorCode::Conflict => {}
                            Err(error) => eprintln!("Portcove warning: {error}"),
                        }
                    }
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

fn open_cli_directory(path: &std::path::Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    let program = "explorer.exe";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, program)?
        .arg(path)
        .spawn()
        .map_err(|error| {
            PortcoveError::state(format!(
                "couldn't open Portcove's game-file folder with the system file manager: {error}"
            ))
        })?;
    Ok(())
}

fn progress_renderer(
    mode: OutputMode,
    catalog: &portcove_core::Catalog,
) -> impl FnMut(OperationEvent) + '_ {
    let mut human_progress = HumanProgress::with_catalog(io::stderr().is_terminal(), catalog);
    move |event| match mode {
        OutputMode::Jsonl => println!(
            "{}",
            serde_json::to_string(&event).expect("operation event is serializable")
        ),
        OutputMode::Human => eprint!("{}", human_progress.render(&event)),
        OutputMode::Json => {}
    }
}

fn render_success<T>(mode: OutputMode, command: &str, data: T) -> Result<()>
where
    T: Serialize + JsonSchema,
{
    render_success_with(mode, command, data, human::document)
}

fn render_read_success<T, F>(mode: OutputMode, command: &str, data: T, renderer: F) -> Result<()>
where
    T: Serialize + JsonSchema,
    F: FnOnce(&T) -> String,
{
    render_success_with(mode, command, data, |data| Ok(renderer(data)))
}

fn render_success_with<T, F>(mode: OutputMode, command: &str, data: T, renderer: F) -> Result<()>
where
    T: Serialize + JsonSchema,
    F: FnOnce(&T) -> serde_json::Result<String>,
{
    match mode {
        OutputMode::Human => println!("{}", renderer(&data)?),
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

fn render_error(mode: OutputMode, command: &str, error: &PortcoveError, technical_details: bool) {
    match mode {
        OutputMode::Human => eprintln!(
            "{}",
            human_adapters::error(command, error, technical_details)
        ),
        OutputMode::Json => println!(
            "{}",
            serde_json::to_string(&ApiResponse::<serde_json::Value> {
                schema_version: API_SCHEMA_VERSION,
                ok: false,
                command: command.into(),
                data: None,
                error: Some(api_error(error)),
            })
            .unwrap_or_else(|_| "{\"ok\":false}".into())
        ),
        OutputMode::Jsonl => println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "schema_version": API_SCHEMA_VERSION, "type": "result", "ok": false,
                "command": command, "error": api_error(error)
            }))
            .unwrap_or_else(|_| "{\"ok\":false}".into())
        ),
    }
}

fn api_error(error: &PortcoveError) -> ApiError {
    error.report()
}

fn require_confirmation(prompt: &str, yes: bool, non_interactive: bool) -> Result<()> {
    if confirmation(prompt, yes, non_interactive)? {
        Ok(())
    } else {
        Err(PortcoveError::usage("operation cancelled"))
    }
}

fn execute_artwork(
    service: &PortcoveService,
    command: ArtworkCommand,
    mode: OutputMode,
    non_interactive: bool,
) -> Result<()> {
    let name = command.name();
    match command {
        ArtworkCommand::Handoff { port_id, role } => render_read_success(
            mode,
            name,
            service.destination_artwork(&port_id, role.into())?,
            |result| human_adapters::artwork_handoff(result, service.catalog()),
        ),
        ArtworkCommand::HandoffBytes {
            port_id,
            role,
            expected_library_id,
            expected_revision,
            expected_asset_sha256,
        } => render_read_success(
            mode,
            name,
            service.destination_artwork_bytes(
                &port_id,
                role.into(),
                &expected_library_id,
                expected_revision,
                &expected_asset_sha256,
            )?,
            |result| human_adapters::artwork_bytes(result, service.catalog()),
        ),
        ArtworkCommand::Show { port_id, slot } => render_read_success(
            mode,
            name,
            service.artwork(&port_id, slot.into())?,
            |result| human_adapters::artwork_state(result, service.catalog()),
        ),
        ArtworkCommand::Import {
            port_id,
            path,
            slot,
            expected_revision,
        } => {
            let slot = slot.into();
            let revision = match expected_revision {
                Some(value) => value,
                None => service.artwork(&port_id, slot)?.choice.revision,
            };
            render_read_success(
                mode,
                name,
                service.import_artwork(&port_id, slot, &path, revision)?,
                |result| human_adapters::artwork_state(result, service.catalog()),
            )
        }
        ArtworkCommand::Reset {
            port_id,
            slot,
            expected_revision,
        } => {
            let slot = slot.into();
            let revision = match expected_revision {
                Some(value) => value,
                None => service.artwork(&port_id, slot)?.choice.revision,
            };
            render_read_success(
                mode,
                name,
                service.reset_artwork(&port_id, slot, revision)?,
                |result| human_adapters::artwork_state(result, service.catalog()),
            )
        }
        ArtworkCommand::ClearCache => {
            render_read_success(mode, name, service.clear_artwork_cache()?, |result| {
                format!(
                    "Artwork cache cleared: {} files, {}. Local originals remain in place.",
                    result.removed_files,
                    human::format_bytes(result.removed_bytes)
                )
            })
        }
        ArtworkCommand::Unused => {
            render_read_success(mode, name, service.unused_local_artwork()?, |assets| {
                human_adapters::unused_artwork(assets)
            })
        }
        ArtworkCommand::RemoveUnused { asset_sha256, yes } => {
            require_confirmation(
                "Remove this unused managed local image? The original file outside the library is retained.",
                yes,
                non_interactive,
            )?;
            service.remove_unused_local_artwork(&asset_sha256)?;
            render_read_success(
                mode,
                name,
                serde_json::json!({"removed":true,"asset_sha256":asset_sha256}),
                |_| {
                    format!(
                        "Unused local artwork removed\nSHA-256: {}\nThe original file outside the library remains in place.",
                        human::clean(&asset_sha256)
                    )
                },
            )
        }
    }
}

fn confirmation(prompt: &str, yes: bool, non_interactive: bool) -> Result<bool> {
    if yes {
        return Ok(true);
    }
    if non_interactive {
        return Err(PortcoveError::usage("confirmation required; pass --yes"));
    }
    write_confirmation_prompt(&mut io::stderr().lock(), prompt)?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(answer.trim().eq_ignore_ascii_case("y") || answer.trim().eq_ignore_ascii_case("yes"))
}

fn write_confirmation_prompt(output: &mut impl Write, prompt: &str) -> Result<()> {
    write!(output, "{} [y/N] ", human::clean(prompt))?;
    output.flush()?;
    Ok(())
}

fn render_backup_cancellation(mode: OutputMode, command: &str, label: &str) -> Result<()> {
    if mode == OutputMode::Human {
        println!("{label} cancelled. No changes were made.");
        Ok(())
    } else {
        render_success(
            mode,
            command,
            serde_json::json!({ "cancelled": true, "changed": false }),
        )
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
        ErrorCode::Cancelled => 130,
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
            BackupCommand::GhostshipLegacyPlan { .. } => "backup.ghostship-legacy-plan",
            BackupCommand::GhostshipLegacyRecover { .. } => "backup.ghostship-legacy-recover",
            BackupCommand::Create { .. } => "backup.create",
            BackupCommand::List { .. } => "backup.list",
            BackupCommand::Delete { .. } => "backup.delete",
            BackupCommand::Restore { .. } => "backup.restore",
        },
        Commands::Catalog { command } => command.name(),
        Commands::Source { command } => match command {
            SourceCommand::Add { .. } => "source.add",
            SourceCommand::Discover(_) => "source.discover",
            SourceCommand::Inbox { command } => match command {
                SourceInboxCommand::Path { .. } => "source.inbox.path",
                SourceInboxCommand::Open { .. } => "source.inbox.open",
                SourceInboxCommand::Scan(_) => "source.inbox.scan",
                SourceInboxCommand::Import { .. } => "source.inbox.import",
            },
            SourceCommand::Roots { command } => match command {
                GameFileRootCommand::List => "source.roots.list",
                GameFileRootCommand::Scan(_) => "source.roots.scan",
                GameFileRootCommand::Snapshot => "source.roots.snapshot",
                GameFileRootCommand::Add { .. } => "source.roots.add",
                GameFileRootCommand::Relink { .. } => "source.roots.relink",
                GameFileRootCommand::Remove { .. } => "source.roots.remove",
            },
            SourceCommand::Relink { .. } => "source.relink",
            SourceCommand::List => "source.list",
            SourceCommand::Inspect { .. } => "source.inspect",
            SourceCommand::Query(_) => "source.query",
            SourceCommand::Verify(_) => "source.verify",
            SourceCommand::Remove { .. } => "source.remove",
        },
        Commands::Artwork { command } => command.name(),
        Commands::Tool { command } => match command {
            ToolCommand::List => "tool.list",
            ToolCommand::SetPath { .. } => "tool.set-path",
            ToolCommand::ClearPath { .. } => "tool.clear-path",
        },
        Commands::Status { .. } => "status",
        Commands::Activity {
            command: Some(ActivityCommand::Log { .. }),
            ..
        } => "activity.log",
        Commands::Activity { .. } => "activity",
        Commands::Cancel { .. } => "cancel",
        Commands::Launch { command } => match command {
            LaunchCommand::Show { .. } => "launch.show",
            LaunchCommand::Recover { .. } => "launch.recover",
        },
        Commands::External { command } => match command {
            ExternalCommand::Preview { .. } => "external.preview",
            ExternalCommand::RemovalPreview { .. } => "external.removal-preview",
            ExternalCommand::Register { .. } => "external.register",
            ExternalCommand::RelinkPreview { .. } => "external.relink-preview",
            ExternalCommand::Relink { .. } => "external.relink",
            ExternalCommand::Remove { .. } => "external.remove",
        },
        Commands::Storage => "storage",
        Commands::Library { command } => library_command_name(command),
        Commands::Doctor => "doctor",
        Commands::About => "about",
        Commands::Plan { .. } => "plan",
        Commands::Installation { command } => match command {
            InstallationCommand::Plan { .. } => "installation.plan",
            InstallationCommand::Run { .. } => "installation.run",
            #[cfg(feature = "qualification-fixtures")]
            InstallationCommand::QualificationUpdatePlan { .. } => {
                "installation.qualification-update-plan"
            }
            #[cfg(feature = "qualification-fixtures")]
            InstallationCommand::QualificationUpdateRun { .. } => {
                "installation.qualification-update-run"
            }
        },
        Commands::Preparation {
            command: PreparationCommand::Plan { .. },
        } => "preparation.plan",
        Commands::Preparation {
            command: PreparationCommand::Run { .. },
        } => "preparation.run",
        Commands::Preparation {
            command: PreparationCommand::CleanupPlan { .. },
        } => "preparation.cleanup-plan",
        Commands::Preparation {
            command: PreparationCommand::Cleanup { .. },
        } => "preparation.cleanup",
        Commands::Paths { .. } => "paths",
        Commands::Output { command } => match command {
            OutputCommand::Show { .. } => "output.show",
            OutputCommand::Preview { .. } => "output.preview",
            OutputCommand::Set { .. } => "output.set",
            OutputCommand::Reset { .. } => "output.reset",
            OutputCommand::Move { .. } => "output.move",
        },
        Commands::Check(_) => "check",
        Commands::Reconcile(_) => "reconcile",
        Commands::Install(_) => "install",
        Commands::Adopt(_) => "adopt",
        Commands::Ensure(_) => "ensure",
        Commands::Update(_) => "update",
        Commands::Verify { .. } => "verify",
        Commands::Activate { .. } => "activate",
        Commands::Rollback { .. } => "rollback",
        Commands::RemovePreview { .. } => "remove.preview",
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
    #[test]
    fn stderr_verbosity_keeps_existing_levels_and_excludes_host_observations() {
        use tracing_subscriber::{Layer, layer::SubscriberExt};

        for verbosity in [0, 1, 2] {
            let output = tempfile::NamedTempFile::new().unwrap();
            let writer = output.as_file().try_clone().unwrap();
            let subscriber = tracing_subscriber::registry().with(
                tracing_subscriber::fmt::layer()
                    .without_time()
                    .with_ansi(false)
                    .with_writer(move || writer.try_clone().unwrap())
                    .with_filter(super::stderr_diagnostic_filter(verbosity)),
            );
            tracing::subscriber::with_default(subscriber, || {
                tracing::warn!(target: "portcove_core", "existing application warning");
                tracing::info!(target: "portcove_core", "existing application info");
                tracing::debug!(target: "portcove_core", "existing application debug");
                tracing::warn!(target: "owned_dependency", "existing dependency warning");
                tracing::info!(target: "owned_dependency", "existing dependency info");
                tracing::debug!(target: "owned_dependency", "existing dependency debug");
                tracing::info!(target: "portcove_cli::host_diagnostics", "file-only CLI stage");
                tracing::info!(target: "portcove_core::host_diagnostics", "file-only Core stage");
            });
            let text = std::fs::read_to_string(output.path()).unwrap();
            for owner in ["application", "dependency"] {
                assert!(text.contains(&format!("existing {owner} warning")));
                assert_eq!(
                    text.contains(&format!("existing {owner} info")),
                    verbosity >= 1
                );
                assert_eq!(
                    text.contains(&format!("existing {owner} debug")),
                    verbosity >= 2
                );
            }
            assert!(!text.contains("file-only"));
        }
    }

    #[test]
    fn consent_prompt_keeps_external_paths_on_one_control_safe_line() {
        let mut output = Vec::new();
        super::write_confirmation_prompt(
            &mut output,
            "Change Game (game-id) from /owned/日本語\r\nProceed?\u{1b}[2J to /owned/new\tlocation? External files stay in place.",
        )
        .unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(!text.chars().any(char::is_control), "{text:?}");
        assert!(text.contains("Game (game-id)"));
        assert!(text.contains("/owned/日本語"));
        assert!(text.contains("/owned/new location"));
        assert!(text.contains("External files stay in place."));
        assert_eq!(text.matches("[y/N]").count(), 1);
        assert!(text.ends_with(" [y/N] "));
    }

    #[test]
    fn definition_authority_requires_reviewed_explicit_apply_and_has_no_root_input() {
        let review = Cli::try_parse_from(["portcove", "catalog", "definition-authority"]).unwrap();
        assert!(super::command_is_observation(&review.command));
        assert_eq!(
            super::command_name(&review.command),
            "catalog.definition-authority"
        );
        assert!(
            portcove_core::CapabilityDocument::current()
                .commands
                .iter()
                .any(|name| name == "catalog.definition-authority")
        );
        for flags in [
            vec!["--apply"],
            vec!["--expected-plan", "abc"],
            vec!["--yes"],
            vec!["--file", "root.json"],
            vec!["--url", "https://example.com/root.json"],
            vec!["--root", "root.json"],
            vec!["--public-key", "abc"],
        ] {
            assert!(
                Cli::try_parse_from(
                    [vec!["portcove", "catalog", "definition-authority"], flags].concat()
                )
                .is_err()
            );
        }
        let apply = Cli::try_parse_from([
            "portcove",
            "catalog",
            "definition-authority",
            "--apply",
            "--expected-plan",
            &"0".repeat(64),
            "--yes",
        ])
        .unwrap();
        assert!(!super::command_is_observation(&apply.command));
    }

    #[cfg(feature = "qualification-fixtures")]
    fn qualification_proxy_cli() -> Cli {
        Cli::try_parse_from([
            "portcove",
            "--library",
            "owned-library",
            "--qualification-provider-library",
            "owned-library",
            "--qualification-provider-origin",
            "http://127.0.0.1:8123",
            "status",
        ])
        .unwrap()
    }

    #[cfg(feature = "qualification-fixtures")]
    #[test]
    fn qualification_proxy_environment_is_fail_closed_and_redacted() {
        let cli = qualification_proxy_cli();
        for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
            for spelling in [
                name.to_owned(),
                name.to_ascii_lowercase(),
                name.to_ascii_lowercase().replacen('p', "P", 1),
            ] {
                let environment = [
                    (
                        std::ffi::OsString::from(spelling),
                        std::ffi::OsString::from("inert-private-proxy-value"),
                    ),
                    ("NO_PROXY".into(), "*".into()),
                ];
                let error =
                    super::require_qualification_proxy_free_environment(&cli, environment.clone())
                        .unwrap_err();
                assert_eq!(error.code, portcove_core::ErrorCode::Usage);
                assert_eq!(
                    error.message,
                    "qualification provider refuses proxy environment"
                );
                assert!(error.details.is_empty());
                assert!(!error.to_string().contains("inert-private-proxy-value"));
                assert_eq!(environment[0].1, "inert-private-proxy-value");
            }
        }
    }

    #[cfg(feature = "qualification-fixtures")]
    #[test]
    fn qualification_proxy_environment_allows_unset_empty_and_ordinary_invocations() {
        let cli = qualification_proxy_cli();
        super::require_qualification_proxy_free_environment(&cli, []).unwrap();
        super::require_qualification_proxy_free_environment(
            &cli,
            [
                ("HTTP_PROXY".into(), "".into()),
                ("https_proxy".into(), "".into()),
                ("ALL_PROXY".into(), "".into()),
                ("NO_PROXY".into(), "*".into()),
            ],
        )
        .unwrap();
        let ordinary = Cli::try_parse_from(["portcove", "status"]).unwrap();
        super::require_qualification_proxy_free_environment(
            &ordinary,
            [("HTTP_PROXY".into(), "inert-private-proxy-value".into())],
        )
        .unwrap();
    }

    #[cfg(all(feature = "qualification-fixtures", any(unix, windows)))]
    #[test]
    fn qualification_proxy_environment_refuses_non_unicode_nonempty_values() {
        #[cfg(unix)]
        let value = {
            use std::os::unix::ffi::OsStringExt;
            std::ffi::OsString::from_vec(vec![0xff])
        };
        #[cfg(windows)]
        let value = {
            use std::os::windows::ffi::OsStringExt;
            std::ffi::OsString::from_wide(&[0xd800])
        };
        assert!(value.to_str().is_none());
        let error = super::require_qualification_proxy_free_environment(
            &qualification_proxy_cli(),
            [("ALL_PROXY".into(), value)],
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            "qualification provider refuses proxy environment"
        );
        assert!(error.details.is_empty());
    }

    #[cfg(feature = "qualification-fixtures")]
    #[tokio::test]
    async fn qualification_proxy_refusal_precedes_library_open() {
        let directory = tempfile::tempdir().unwrap();
        let library = directory.path().join("library");
        let cli = Cli::try_parse_from([
            "portcove",
            "--library",
            library.to_str().unwrap(),
            "--qualification-provider-library",
            library.to_str().unwrap(),
            "--qualification-provider-origin",
            "http://127.0.0.1:8123",
            "status",
        ])
        .unwrap();
        let result = super::execute_with_qualification_environment(
            cli,
            super::OutputMode::Json,
            [("HTTP_PROXY".into(), "inert-private-proxy-value".into())],
        )
        .await;
        assert!(
            !library.exists(),
            "proxy refusal must precede library opening"
        );
        let error = result.expect_err("qualification proxy environment must refuse");
        assert_eq!(error.code, portcove_core::ErrorCode::Usage);
        assert_eq!(
            error.message,
            "qualification provider refuses proxy environment"
        );
        assert!(error.details.is_empty());
    }

    #[cfg(not(feature = "qualification-fixtures"))]
    #[test]
    fn ordinary_cli_rejects_qualification_provider_and_update_commands() {
        use clap::Parser;
        assert!(
            Cli::try_parse_from([
                "portcove",
                "--qualification-provider-origin",
                "http://127.0.0.1:8123",
                "status"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "portcove",
                "installation",
                "qualification-update-plan",
                "fixture"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "portcove",
                "installation",
                "qualification-update-run",
                "fixture",
                "--expected-plan",
                "abc",
                "--yes"
            ])
            .is_err()
        );
    }

    #[cfg(feature = "qualification-fixtures")]
    #[test]
    fn qualification_update_requires_explicit_provider_binding() {
        use clap::Parser;
        let unbound = Cli::try_parse_from([
            "portcove",
            "installation",
            "qualification-update-plan",
            "fixture",
        ])
        .unwrap();
        assert!(super::require_qualification_update_binding(&unbound).is_err());
        let cli = Cli::try_parse_from([
            "portcove",
            "--library",
            "owned-library",
            "--qualification-provider-library",
            "owned-library",
            "--qualification-provider-origin",
            "http://127.0.0.1:8123",
            "installation",
            "qualification-update-plan",
            "fixture",
        ])
        .unwrap();
        super::require_qualification_update_binding(&cli).unwrap();
        assert!(super::command_is_observation(&cli.command));
    }

    #[test]
    fn discovery_human_summary_uses_real_bounded_core_result_without_registering() {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("sources");
        std::fs::create_dir(&files).unwrap();
        std::fs::write(files.join("owned-a.txt"), b"owned-a").unwrap();
        std::fs::write(files.join("owned-b.txt"), b"owned-b").unwrap();
        let library = portcove_core::Library::open(root.path().join("library")).unwrap();
        let service = portcove_core::PortcoveService::new_read_only(library).unwrap();
        let cli = Cli::try_parse_from([
            "portcove",
            "source",
            "discover",
            "--root",
            files.to_str().unwrap(),
            "--profile",
            "minish-cap-gba",
            "--max-entries",
            "1",
        ])
        .unwrap();
        let Commands::Source {
            command: SourceCommand::Discover(args),
        } = cli.command
        else {
            panic!("expected source discovery");
        };
        let report = service.discover_sources(&args.request()).unwrap();
        assert_eq!(report.entries_examined, 1);
        assert_eq!(
            report.limits_reached,
            [portcove_core::SourceDiscoveryLimit::Entries]
        );
        assert!(report.candidates.is_empty());
        assert!(service.library().sources().unwrap().is_empty());
        let before = serde_json::to_value(&report).unwrap();
        let text = super::human::source_discovery(&report, service.catalog());
        assert!(text.contains("Search was partial."));
        assert!(text.contains("No matching candidates were found in the inspected scope."));
        assert!(text.contains("No sources were registered by this search."));
        assert_eq!(serde_json::to_value(&report).unwrap(), before);
        for mode in [super::OutputMode::Json, super::OutputMode::Jsonl] {
            super::render_read_success(mode, "source.discover", report.clone(), |_| {
                panic!("machine modes must not invoke human rendering")
            })
            .unwrap();
        }
        assert!(service.library().sources().unwrap().is_empty());
        assert_eq!(
            std::fs::read(files.join("owned-a.txt")).unwrap(),
            b"owned-a"
        );
        assert_eq!(
            std::fs::read(files.join("owned-b.txt")).unwrap(),
            b"owned-b"
        );
    }

    use std::path::PathBuf;

    use super::{
        AuthCommand, BackupCommand, CapabilityDocument, CatalogCommand, ChannelArg, Cli, Commands,
        GameFileRootCommand, GameFileRootScanArgs, HumanProgress, OperationEvent,
        OperationEventKind, OutputCommand, PreparationCommand, SourceCommand,
        normalize_process_exit,
    };
    use clap::Parser;

    fn progress_event(event: OperationEventKind) -> OperationEvent {
        OperationEvent {
            schema_version: 2,
            operation_id: "operation-id".into(),
            parent_operation_id: None,
            sequence: 1,
            timestamp_ms: 0,
            operation: "install".into(),
            target: None,
            event,
        }
    }

    #[test]
    fn redirected_human_progress_uses_bounded_complete_lines() {
        let mut renderer = HumanProgress::new(false);
        let mut output = String::new();
        for event in [
            OperationEventKind::Progress {
                phase: "download".into(),
                completed: 0,
                total: Some(100),
            },
            OperationEventKind::Progress {
                phase: "download".into(),
                completed: 10,
                total: Some(100),
            },
            OperationEventKind::Progress {
                phase: "download".into(),
                completed: 100,
                total: Some(100),
            },
            OperationEventKind::Progress {
                phase: "verify".into(),
                completed: 5,
                total: Some(10),
            },
            OperationEventKind::Finished {
                result: portcove_core::OperationResult::Failed,
            },
        ] {
            output.push_str(&renderer.render(&progress_event(event)));
        }
        assert_eq!(
            output,
            "Downloading release files: started\nDownloading release files: 100 B of 100 B\nChecking file identity: started\nChecking file identity: 5 of 10 units\n"
        );
        assert!(!output.contains('\r'));
    }

    #[test]
    fn interactive_human_progress_keeps_inline_updates_but_ends_the_line() {
        let mut renderer = HumanProgress::new(true);
        let first = renderer.render(&progress_event(OperationEventKind::Progress {
            phase: "download".into(),
            completed: 10,
            total: Some(100),
        }));
        let message = renderer.render(&progress_event(OperationEventKind::Message {
            level: "info".into(),
            message: "Checking file".into(),
        }));
        let last = renderer.render(&progress_event(OperationEventKind::Finished {
            result: portcove_core::OperationResult::Succeeded,
        }));
        assert_eq!(first, "\rDownloading release files: 10 B of 100 B");
        assert_eq!(message, "\nChecking file\n");
        assert!(last.is_empty());
    }

    #[test]
    fn process_crashes_never_look_successful_to_callers() {
        assert_eq!(normalize_process_exit(Some(0)), 0);
        assert_eq!(normalize_process_exit(Some(42)), 42);
        assert_eq!(normalize_process_exit(Some(-1_073_741_819)), 1);
        assert_eq!(normalize_process_exit(Some(300)), 1);
        assert_eq!(normalize_process_exit(None), 125);
    }

    #[test]
    fn preparation_cleanup_requires_an_exact_review_fingerprint() {
        let review =
            Cli::try_parse_from(["portcove", "preparation", "cleanup-plan", "operation-id"])
                .unwrap();
        assert!(matches!(
            review.command,
            Commands::Preparation {
                command: PreparationCommand::CleanupPlan { operation_id }
            } if operation_id == "operation-id"
        ));
        assert!(
            Cli::try_parse_from(["portcove", "preparation", "cleanup", "operation-id"]).is_err()
        );
        let apply = Cli::try_parse_from([
            "portcove",
            "preparation",
            "cleanup",
            "operation-id",
            "--expected-preview",
            "reviewed",
            "--yes",
        ])
        .unwrap();
        assert_eq!(super::command_name(&apply.command), "preparation.cleanup");
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
    fn game_file_root_commands_keep_the_stable_identity_explicit() {
        let cli = Cli::try_parse_from([
            "portcove",
            "source",
            "roots",
            "relink",
            "root-id",
            "replacement",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Commands::Source {
                command: SourceCommand::Roots {
                    command: GameFileRootCommand::Relink { root_id, path }
                }
            } if root_id == "root-id" && path.as_os_str() == "replacement"
        ));

        let scan = Cli::try_parse_from([
            "portcove",
            "source",
            "roots",
            "scan",
            "--max-candidates",
            "12",
        ])
        .unwrap();
        assert!(matches!(
            scan.command,
            Commands::Source {
                command: SourceCommand::Roots {
                    command: GameFileRootCommand::Scan(GameFileRootScanArgs {
                        max_candidates: Some(12),
                        ..
                    })
                }
            }
        ));
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
        let Commands::Activity { limit, .. } = cli.command else {
            panic!("expected activity command");
        };
        assert_eq!(limit, 25);
        assert!(Cli::try_parse_from(["portcove", "activity", "--limit", "0"]).is_err());
        assert!(Cli::try_parse_from(["portcove", "activity", "--limit", "201"]).is_err());
    }

    #[test]
    fn parsed_observation_commands_select_read_only_startup() {
        for arguments in [
            vec!["portcove", "status"],
            vec![
                "portcove",
                "artwork",
                "handoff",
                "zelda64-recomp",
                "--role",
                "portrait-cover",
            ],
            vec![
                "portcove",
                "artwork",
                "handoff-bytes",
                "zelda64-recomp",
                "--role",
                "portrait-cover",
                "--expected-library-id",
                "library",
                "--expected-revision",
                "1",
                "--expected-asset-sha256",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ],
            vec!["portcove", "remove-preview", "zelda64-recomp"],
            vec!["portcove", "activity"],
            vec!["portcove", "doctor"],
            vec!["portcove", "auth", "status"],
            vec!["portcove", "capabilities"],
            vec!["portcove", "source", "verify", "zelda64-recomp"],
            vec!["portcove", "source", "verify", "--all"],
            vec!["portcove", "catalog", "update", "--file", "catalog.json"],
            vec![
                "portcove",
                "source",
                "inbox",
                "import",
                "zelda64-recomp",
                "source.iso",
            ],
            vec!["portcove", "catalog", "export"],
            vec!["portcove", "backup", "list", "zelda64-recomp"],
        ] {
            let cli = Cli::try_parse_from(arguments.clone()).unwrap();
            assert!(super::command_is_observation(&cli.command), "{arguments:?}");
        }
        for arguments in [
            vec!["portcove", "remove", "zelda64-recomp", "--yes"],
            vec![
                "portcove",
                "remove",
                "zelda64-recomp",
                "--yes",
                "--expected-preview",
                "abc",
            ],
            vec!["portcove", "backup", "create", "zelda64-recomp"],
            vec![
                "portcove",
                "catalog",
                "update",
                "--file",
                "catalog.json",
                "--apply",
                "--expected-plan",
                "abc",
            ],
            vec![
                "portcove",
                "source",
                "inbox",
                "import",
                "zelda64-recomp",
                "source.iso",
                "--apply",
                "--expected-plan",
                "abc",
            ],
        ] {
            let cli = Cli::try_parse_from(arguments.clone()).unwrap();
            assert!(
                !super::command_is_observation(&cli.command),
                "{arguments:?}"
            );
        }
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

    fn parsed_channel(route: &str, value: Option<&str>) -> Option<ChannelArg> {
        let mut args = vec!["portcove", route];
        if route == "channel" {
            args.push("set");
        }
        args.push("lighthouse");
        if let Some(value) = value {
            if route != "channel" {
                args.push("--channel");
            }
            args.push(value);
        }
        match Cli::try_parse_from(args).unwrap().command {
            Commands::Plan { channel, .. } => channel,
            Commands::Install(args) => args.channel,
            Commands::Ensure(args) => args.channel,
            Commands::Channel {
                command: super::ChannelCommand::Set { channel, .. },
            } => Some(channel),
            _ => panic!("expected channel consumer"),
        }
    }

    #[test]
    fn preview_and_beta_inputs_share_the_existing_channel_on_every_route() {
        for route in ["plan", "install", "ensure", "channel"] {
            for value in ["preview", "beta"] {
                let channel: portcove_core::ReleaseChannel =
                    parsed_channel(route, Some(value)).unwrap().into();
                assert_eq!(channel, portcove_core::ReleaseChannel::Beta);
                assert_eq!(channel.to_string(), "beta");
                assert_eq!(serde_json::to_value(channel).unwrap(), "beta");
            }
            for (value, expected) in [
                ("stable", portcove_core::ReleaseChannel::Stable),
                ("rolling", portcove_core::ReleaseChannel::Rolling),
            ] {
                let channel: portcove_core::ReleaseChannel =
                    parsed_channel(route, Some(value)).unwrap().into();
                assert_eq!(channel, expected);
            }
        }
    }

    #[test]
    fn channel_inputs_preserve_case_errors_and_optional_defaults() {
        for route in ["plan", "install", "ensure", "channel"] {
            for value in ["Preview", "Beta", "Stable", "Rolling", "invalid"] {
                let mut args = vec!["portcove", route];
                if route == "channel" {
                    args.push("set");
                }
                args.push("lighthouse");
                if route != "channel" {
                    args.push("--channel");
                }
                args.push(value);
                assert_eq!(
                    Cli::try_parse_from(args).unwrap_err().kind(),
                    clap::error::ErrorKind::InvalidValue
                );
            }
        }
        for route in ["plan", "install", "ensure"] {
            assert!(parsed_channel(route, None).is_none());
        }
        assert_eq!(
            Cli::try_parse_from(["portcove", "channel", "set", "lighthouse"])
                .unwrap_err()
                .kind(),
            clap::error::ErrorKind::MissingRequiredArgument
        );
    }

    #[test]
    fn channel_help_prefers_preview_and_explains_the_beta_alias() {
        use clap::{CommandFactory, ValueEnum};
        for args in [
            vec!["portcove", "plan", "--help"],
            vec!["portcove", "install", "--help"],
            vec!["portcove", "ensure", "--help"],
            vec!["portcove", "channel", "set", "--help"],
        ] {
            let error = Cli::try_parse_from(args).unwrap_err();
            assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
            let help = error.to_string();
            assert!(help.contains("preview"), "{help}");
            assert!(help.contains("beta"), "{help}");
            assert!(help.contains("compatibility alias"), "{help}");
        }
        let values = <ChannelArg as clap::ValueEnum>::value_variants()
            .iter()
            .map(|value| value.to_possible_value().unwrap().get_name().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(values, ["stable", "preview", "rolling"]);
        Cli::command().debug_assert();
    }

    #[test]
    fn output_controls_are_single_port_and_review_bound() {
        let output = PathBuf::from("Games").join("Lighthouse");
        let output_argument = output.to_string_lossy();
        let preview = Cli::try_parse_from([
            "portcove",
            "output",
            "preview",
            "lighthouse",
            output_argument.as_ref(),
        ])
        .unwrap();
        assert!(matches!(
            preview.command,
            Commands::Output {
                command: OutputCommand::Preview { port_id, path }
            } if port_id == "lighthouse" && path == Some(output.clone())
        ));
        assert!(
            Cli::try_parse_from([
                "portcove",
                "output",
                "set",
                "lighthouse",
                output_argument.as_ref(),
            ])
            .is_err()
        );
        let relocation = Cli::try_parse_from([
            "portcove",
            "output",
            "move",
            "lighthouse",
            output_argument.as_ref(),
        ])
        .unwrap();
        assert!(matches!(
            relocation.command,
            Commands::Output {
                command: OutputCommand::Move {
                    port_id,
                    path,
                    apply: false,
                    expected_plan: None,
                    yes: false,
                }
            } if port_id == "lighthouse" && path == output
        ));
        assert!(
            Cli::try_parse_from([
                "portcove",
                "output",
                "move",
                "lighthouse",
                output_argument.as_ref(),
                "--apply",
            ])
            .is_err()
        );
        for command in ["plan", "install", "ensure"] {
            assert!(
                Cli::try_parse_from([
                    "portcove",
                    command,
                    "lighthouse",
                    "--output-dir",
                    output_argument.as_ref(),
                ])
                .is_ok(),
                "{command}"
            );
        }
        assert!(
            Cli::try_parse_from([
                "portcove",
                "update",
                "--all",
                "--output-dir",
                output_argument.as_ref(),
            ])
            .is_err()
        );
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
    fn external_review_routes_preserve_caller_identity_and_observation_boundary() {
        let preview = Cli::try_parse_from([
            "portcove",
            "external",
            "removal-preview",
            "wave-race-64-recomp",
        ])
        .unwrap();
        assert!(super::command_is_observation(&preview.command));
        assert_eq!(
            super::command_name(&preview.command),
            "external.removal-preview"
        );
        for action in ["register", "remove"] {
            let mut arguments = vec!["portcove", "external", action, "wave-race-64-recomp"];
            if action == "register" {
                arguments.push("prepared-folder");
            }
            arguments.extend(["--expected-preview", "caller-reviewed-digest", "--yes"]);
            let command = Cli::try_parse_from(arguments).unwrap();
            assert!(!super::command_is_observation(&command.command));
            match command.command {
                super::Commands::External {
                    command:
                        super::ExternalCommand::Register {
                            expected_preview,
                            yes,
                            ..
                        }
                        | super::ExternalCommand::Remove {
                            expected_preview,
                            yes,
                            ..
                        },
                } => {
                    assert_eq!(expected_preview.as_deref(), Some("caller-reviewed-digest"));
                    assert!(yes);
                }
                _ => panic!("expected an external mutation"),
            }
        }
        let legacy = Cli::try_parse_from([
            "portcove",
            "external",
            "remove",
            "wave-race-64-recomp",
            "--yes",
        ])
        .unwrap();
        assert!(matches!(
            legacy.command,
            super::Commands::External {
                command: super::ExternalCommand::Remove {
                    expected_preview: None,
                    yes: true,
                    ..
                }
            }
        ));
    }

    #[test]
    fn catalog_proposal_inspection_is_inert_and_cannot_apply_or_establish_trust() {
        let cli = Cli::try_parse_from(["portcove", "catalog", "inspect-proposal", "proposal.json"])
            .unwrap();
        assert!(super::command_is_observation(&cli.command));
        assert_eq!(
            super::command_name(&cli.command),
            "catalog.inspect-proposal"
        );
        for flag in ["--apply", "--yes", "--expected-plan", "--public-key"] {
            assert!(
                Cli::try_parse_from([
                    "portcove",
                    "catalog",
                    "inspect-proposal",
                    "proposal.json",
                    flag
                ])
                .is_err(),
                "{flag}"
            );
        }
    }

    #[test]
    fn reviewed_installation_routes_keep_plan_read_only_and_require_exact_consent() {
        let plan = Cli::try_parse_from(["portcove", "installation", "plan", "shipwright"]).unwrap();
        assert!(super::command_is_observation(&plan.command));
        assert_eq!(super::command_name(&plan.command), "installation.plan");
        let run = Cli::try_parse_from([
            "portcove",
            "installation",
            "run",
            "shipwright",
            "--expected-plan",
            "digest",
            "--yes",
        ])
        .unwrap();
        assert!(!super::command_is_observation(&run.command));
        assert_eq!(super::command_name(&run.command), "installation.run");
        assert!(
            Cli::try_parse_from(["portcove", "installation", "run", "shipwright", "--yes"])
                .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "portcove",
                "installation",
                "run",
                "shipwright",
                "--expected-plan",
                "digest",
                "--source",
                "source.z64"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "portcove",
                "installation",
                "plan",
                "shipwright",
                "--output-dir",
                "other"
            ])
            .is_err()
        );
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
            (vec!["portcove", "tool", "list"], "tool.list"),
            (
                vec!["portcove", "tool", "set-path", "chdman", "chdman.exe"],
                "tool.set-path",
            ),
            (
                vec!["portcove", "tool", "clear-path", "chdman"],
                "tool.clear-path",
            ),
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
        assert_eq!(
            capabilities.schema_version,
            portcove_core::API_SCHEMA_VERSION
        );
        assert!(
            capabilities
                .commands
                .iter()
                .any(|command| command == "source.roots")
        );
        assert_eq!(
            capabilities.operation_event_schema_version,
            portcove_core::OPERATION_EVENT_SCHEMA_VERSION
        );
        assert_eq!(
            capabilities.failure_isolated_batches,
            ["check", "reconcile", "update", "source.verify"]
        );
        assert_eq!(capabilities.port_operation_locking, "per_port_fail_fast");
        assert!(capabilities.commands.contains(&"storage".to_owned()));
        assert!(capabilities.commands.contains(&"doctor".to_owned()));
        assert!(capabilities.commands.contains(&"backup".to_owned()));
        assert!(capabilities.commands.contains(&"artwork".to_owned()));
        assert!(capabilities.commands.contains(&"tool".to_owned()));
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

    #[test]
    fn device_prompt_identifies_github_and_preserves_machine_streams_and_data() {
        let mut login = super::GithubDeviceLogin {
            session_id: "private-device-session-canary".into(),
            user_code: "ABCD-1234\r\n\u{1b}[2J".into(),
            verification_uri: "https://github.com/login/device\t".into(),
            expires_at: 42,
            interval_seconds: 5,
        };
        let original = serde_json::to_value(&login).unwrap();
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        super::write_device_prompt(super::OutputMode::Human, &login, &mut stdout, &mut stderr)
            .unwrap();
        assert!(stderr.is_empty());
        let human = String::from_utf8(stdout).unwrap();
        assert!(human.contains("https://github.com/login/device"));
        assert!(human.contains("ABCD-1234"));
        assert!(human.contains("to sign in to GitHub."));
        assert!(human.contains("Expires: 1970-01-01T00:00:42Z"));
        assert!(!human.contains("private-device-session-canary"));
        assert!(
            !human
                .chars()
                .any(|value| value.is_control() && value != '\n')
        );
        assert_eq!(human.lines().count(), 2);

        for mode in [super::OutputMode::Json, super::OutputMode::Jsonl] {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            super::write_device_prompt(mode, &login, &mut stdout, &mut stderr).unwrap();
            if mode == super::OutputMode::Json {
                assert!(stdout.is_empty());
                assert_eq!(
                    String::from_utf8(stderr).unwrap(),
                    format!(
                        "Open {} and enter code {}\n",
                        login.verification_uri, login.user_code
                    )
                );
            } else {
                assert!(stderr.is_empty());
                let value: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
                assert_eq!(value["schema_version"], portcove_core::API_SCHEMA_VERSION);
                assert_eq!(value["type"], "device_authorization");
                assert_eq!(value["data"], original);
            }
        }
        assert_eq!(serde_json::to_value(&login).unwrap(), original);
        login.expires_at = u64::MAX;
        let mut stdout = Vec::new();
        super::write_device_prompt(
            super::OutputMode::Human,
            &login,
            &mut stdout,
            &mut Vec::new(),
        )
        .unwrap();
        assert!(
            String::from_utf8(stdout)
                .unwrap()
                .contains("Unknown expiry (invalid timestamp)")
        );
    }
}
