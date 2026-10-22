use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};
use portcove_core::{ReleaseChannel, SourceImportMode, UpdatePolicy};
use uuid::Uuid;

use crate::{catalog::CatalogCommand, schema::SchemaContract};

// Derive the descriptions from the same commands used by the parser. The groups
// are a task index, not a second command or option definition.
const ROOT_COMMAND_GROUPS: &[(&str, &[&str])] = &[
    (
        "Everyday commands",
        &["install", "update", "exec", "verify", "remove", "status"],
    ),
    (
        "Game files and library",
        &[
            "source", "backup", "library", "storage", "artwork", "output",
        ],
    ),
    (
        "Updates and recovery",
        &[
            "check",
            "activate",
            "rollback",
            "cancel",
            "activity",
            "doctor",
            "launch",
            "preparation",
        ],
    ),
    (
        "Advanced and integration",
        &[
            "catalog",
            "auth",
            "plan",
            "installation",
            "external",
            "adopt",
            "ensure",
            "reconcile",
            "channel",
            "policy",
            "paths",
            "remove-preview",
            "tool",
            "capabilities",
            "schema",
            "about",
        ],
    ),
];

fn root_help_template() -> String {
    let commands = Commands::augment_subcommands(clap::Command::new("portcove"));
    let mut template = String::from(
        "{before-help}{name} {version}\n{about-with-newline}\n{usage-heading} {usage}\n\n",
    );
    for (heading, names) in ROOT_COMMAND_GROUPS {
        template.push_str(heading);
        template.push_str(":\n");
        for name in *names {
            if let Some(command) = commands.find_subcommand(name) {
                template.push_str(&format!(
                    "  {:<17} {}\n",
                    name,
                    command
                        .get_about()
                        .map(ToString::to_string)
                        .unwrap_or_default()
                ));
            }
        }
        template.push('\n');
    }
    // A newly introduced command remains visible even before it is assigned to
    // a group. The completeness test also requires its deliberate placement.
    let ungrouped = commands
        .get_subcommands()
        .filter(|command| {
            !command.is_hide_set()
                && !ROOT_COMMAND_GROUPS
                    .iter()
                    .any(|(_, names)| names.contains(&command.get_name()))
        })
        .collect::<Vec<_>>();
    if !ungrouped.is_empty() {
        template.push_str("Other commands:\n");
        for command in ungrouped {
            template.push_str(&format!(
                "  {:<17} {}\n",
                command.get_name(),
                command
                    .get_about()
                    .map(ToString::to_string)
                    .unwrap_or_default()
            ));
        }
        template.push('\n');
    }
    template.push_str("Options:\n{options}\nUse portcove COMMAND --help for arguments and examples.\n\n{after-help}");
    template
}

#[derive(Debug, Parser)]
#[command(
    name = "portcove",
    version,
    about = "Manage native game ports from a local Portcove library.",
    help_template = root_help_template(),
    after_help = "Start with `catalog list`, then `catalog show PORT_ID` and `plan PORT_ID` before installing. Use `status PORT_ID` to inspect readiness and `exec PORT_ID` to launch. External clients can discover `capabilities` and `schema export`, select an explicit `--library`, and use `--json`, `--jsonl`, and `--non-interactive`. Read durable outcomes with `activity` and retained diagnostics with `activity log ACTIVITY_ID`; handle stable exit codes and machine error objects. Human prose is not a parser contract; `exec` keeps game streams raw. See https://github.com/boburning/portcove/blob/main/docs/INTEGRATION-AUTHOR.md."
)]
pub(crate) struct Cli {
    /// Include redacted technical errors, activity details, and inspection file hashes in human output.
    #[arg(long, global = true)]
    pub(crate) technical_details: bool,
    /// Select a library for this invocation; overrides the saved default and PORTCOVE_LIBRARY.
    #[arg(long, global = true, env = "PORTCOVE_LIBRARY")]
    pub(crate) library: Option<PathBuf>,
    #[cfg(feature = "qualification-fixtures")]
    #[arg(
        long,
        global = true,
        hide = true,
        requires = "qualification_provider_library"
    )]
    pub(crate) qualification_provider_origin: Option<String>,
    #[cfg(feature = "qualification-fixtures")]
    #[arg(long, global = true, hide = true, requires_all = ["qualification_provider_origin", "library"])]
    pub(crate) qualification_provider_library: Option<PathBuf>,
    /// Write one versioned JSON response to standard output for an external client.
    #[arg(long, global = true, conflicts_with = "jsonl")]
    pub(crate) json: bool,
    /// Stream versioned JSON Lines progress events and a final result to standard output.
    #[arg(long, global = true, conflicts_with = "json")]
    pub(crate) jsonl: bool,
    /// Do not prompt; commands needing confirmation require --yes and any reviewed fingerprint.
    #[arg(long, global = true)]
    pub(crate) non_interactive: bool,
    /// Increase diagnostic logging on stderr; use -vv for more detail.
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    pub(crate) verbose: u8,
    #[command(subcommand)]
    pub(crate) command: Commands,
}

#[derive(Debug, Subcommand)]
pub(crate) enum Commands {
    /// Import and select local artwork independently of game installation.
    Artwork {
        #[command(subcommand)]
        command: ArtworkCommand,
    },
    /// Select, inspect, export, import, or move a Portcove library.
    Library {
        #[command(subcommand)]
        command: LibraryCommand,
    },
    /// Inspect or configure GitHub authentication for release downloads.
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    /// Create, inspect, restore, or delete backups of managed saves and settings.
    Backup {
        #[command(subcommand)]
        command: BackupCommand,
    },
    /// Browse ports and inspect or update the trusted catalog.
    Catalog {
        #[command(subcommand)]
        command: CatalogCommand,
    },
    /// Discover and register player-owned game files without uploading them.
    Source {
        #[command(subcommand)]
        command: SourceCommand,
    },
    /// Inspect or register a player-owned, catalog-accepted runtime without copying it.
    External {
        #[command(subcommand)]
        command: ExternalCommand,
    },
    /// Inspect and configure optional disc preparation tools for this host.
    Tool {
        #[command(subcommand)]
        command: ToolCommand,
    },
    /// Show installation, source, launch, and update readiness.
    Status {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: Option<String>,
    },
    /// Read recent operations and their durable outcomes.
    Activity {
        #[command(subcommand)]
        command: Option<ActivityCommand>,
        /// Maximum recent activities to return (1 to 200).
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=200))]
        limit: u16,
    },
    /// Request cancellation of a running operation by its activity ID.
    Cancel {
        /// Operation ID from `portcove activity`; inspect its current state before recovery or cancellation.
        operation_id: String,
    },
    /// Read a caller-known durable launch request without starting or recovering a game.
    Launch {
        #[command(subcommand)]
        command: LaunchCommand,
    },
    /// Show library storage use and managed locations.
    Storage,
    /// Diagnose host, library, and tool prerequisites.
    Doctor,
    /// Show Portcove product and version information without opening a library.
    About,
    /// Preview requirements and actions for installing a port.
    Plan {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Game release channel: stable, preview or rolling; beta remains a compatibility alias for preview.
        #[arg(long, value_enum)]
        channel: Option<ChannelArg>,
        /// Destination for a new managed installation; an existing installation is not moved.
        #[arg(long)]
        output_dir: Option<PathBuf>,
    },
    /// Review managed installs and retain exact local builds for stable setups.
    Installation {
        #[command(subcommand)]
        command: InstallationCommand,
    },
    /// Inspect and prepare exact managed game inputs.
    Preparation {
        #[command(subcommand)]
        command: PreparationCommand,
    },
    /// Show managed installation and persistent-data paths for a port.
    Paths {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// Check installed ports for available game updates without applying them.
    Check(UpdateTargetArgs),
    /// Check installed ports and follow each port's game update settings.
    Reconcile(UpdateTargetArgs),
    /// Install or stage a selected port release in its managed destination.
    Install(InstallArgs),
    /// Review and register an existing managed port installation.
    Adopt(AdoptArgs),
    /// Reuse the current installation when its required runtime is present, or install a selected release.
    Ensure(EnsureArgs),
    /// Install or stage available game updates for installed ports.
    Update(UpdateArgs),
    /// Verify the installed files for one port against recorded hashes.
    Verify {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// Make a staged release the current installed version.
    Activate {
        /// Port with a staged release to activate.
        port_id: String,
    },
    /// Return to the retained previous installed version after checking its files.
    Rollback {
        /// Port whose retained previous version should become current.
        port_id: String,
    },
    /// Read the exact managed-version removal preview without changing files.
    RemovePreview {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// Remove managed installed versions while keeping persistent saved data.
    Remove {
        /// Port whose managed installed versions should be removed.
        port_id: String,
        /// Confirm the reviewed removal without an interactive prompt.
        #[arg(long)]
        yes: bool,
        /// Require the current removal inventory to match a separately reviewed preview.
        #[arg(long)]
        expected_preview: Option<String>,
    },
    /// Set the preferred game-release channel for a port.
    Channel {
        #[command(subcommand)]
        command: ChannelCommand,
    },
    /// Set how Portcove handles future game updates for a port.
    Policy {
        #[command(subcommand)]
        command: PolicyCommand,
    },
    /// Review or change where future game installs are placed.
    Output {
        #[command(subcommand)]
        command: OutputCommand,
    },
    /// Launch an installed port with inherited game streams and its exit code.
    #[command(
        after_help = "Pass game arguments after --. Native executables receive these arguments unchanged; Windows batch launchers reject caller-supplied arguments. The game inherits standard input, standard output and standard error. Its exit code becomes the command result, so exec cannot use --json or --jsonl. Use machine modes for management commands, then plain exec for launch."
    )]
    Exec(ExecArgs),
    /// Discover supported CLI operations and machine contract versions.
    Capabilities,
    /// Export authoritative machine input or output JSON schemas.
    Schema {
        #[command(subcommand)]
        command: SchemaCommand,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum ActivityCommand {
    /// Read the retained, redacted diagnostic capture for one activity.
    Log {
        /// Activity ID from `portcove activity`; reads only its retained diagnostic capture.
        activity_id: String,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum InstallationCommand {
    /// Resolve the exact release, destination and registered inputs without mutation.
    Plan {
        /// Catalog port ID whose managed install should be reviewed.
        port_id: String,
    },
    /// Install only when the reviewed inputs still match under the port lock.
    Run {
        /// Catalog port ID used for the preceding installation plan.
        port_id: String,
        /// Plan SHA-256 returned by `installation plan`; changed inputs refuse the install.
        #[arg(long)]
        expected_plan: String,
        /// Accept the exact shared-preferences scope shown by this plan. --yes alone is insufficient.
        #[arg(long)]
        acknowledge_shared_preferences: bool,
        /// Confirm this reviewed install without a prompt; the plan check still applies.
        #[arg(long)]
        yes: bool,
    },
    /// Inspect retained local builds and the setup references protecting them from cleanup.
    Retained {
        /// Stable catalog port ID; retained builds are local, not a historical release list.
        port_id: String,
    },
    /// Resolve one setup's exact retained build and its current availability without mutation.
    Reference {
        port_id: String,
        /// Stable setup identity, independent of its display name and source profile.
        setup_id: String,
    },
    /// Review binding a stable setup to one already accepted local install without mutation.
    ReferencePlan {
        port_id: String,
        /// Stable setup identity, independent of its display name and source profile.
        setup_id: String,
        /// Exact install ID from `installation retained`; a version label is insufficient.
        install_id: String,
    },
    /// Bind only the exact reviewed local build; existing active selection does not change.
    ReferenceBind {
        port_id: String,
        /// Stable setup identity from the binding review.
        setup_id: String,
        /// Exact install ID from the binding review.
        install_id: String,
        /// Review SHA-256 from `installation reference-plan`; changed inputs refuse the binding.
        #[arg(long)]
        expected_preview: String,
        /// Confirm the reviewed binding without a prompt; the review check still applies.
        #[arg(long)]
        yes: bool,
    },
    /// Review removing a setup reference without deleting the retained build or player data.
    ReferenceRemovalPlan {
        port_id: String,
        /// Stable setup identity whose reference should be removed.
        setup_id: String,
    },
    /// Remove only the reviewed setup reference; later cleanup still respects other protections.
    ReferenceRemove {
        port_id: String,
        /// Stable setup identity from the removal review.
        setup_id: String,
        /// Review SHA-256 from `installation reference-removal-plan`; changed inputs refuse removal.
        #[arg(long)]
        expected_preview: String,
        /// Confirm the reviewed reference removal without prompting; no build files are deleted.
        #[arg(long)]
        yes: bool,
    },
    #[cfg(feature = "qualification-fixtures")]
    #[command(hide = true)]
    QualificationUpdatePlan {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    #[cfg(feature = "qualification-fixtures")]
    #[command(hide = true)]
    QualificationUpdateRun {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Exact plan SHA-256 returned by the preceding review; changed inputs refuse the action.
        #[arg(long)]
        expected_plan: String,
        /// Accept the exact shared-preferences scope shown in the reviewed preview; --yes alone is insufficient.
        #[arg(long)]
        acknowledge_shared_preferences: bool,
        /// Confirm the reviewed action without prompting.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub(crate) enum ArtworkSlotArg {
    Cover,
    Detail,
}

impl From<ArtworkSlotArg> for portcove_core::ArtworkSlot {
    fn from(slot: ArtworkSlotArg) -> Self {
        match slot {
            ArtworkSlotArg::Cover => Self::Cover,
            ArtworkSlotArg::Detail => Self::Detail,
        }
    }
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub(crate) enum DestinationArtworkRoleArg {
    PortraitCover,
    LandscapeCover,
    HeroBanner,
}

impl From<DestinationArtworkRoleArg> for portcove_core::DestinationArtworkRole {
    fn from(role: DestinationArtworkRoleArg) -> Self {
        match role {
            DestinationArtworkRoleArg::PortraitCover => Self::PortraitCover,
            DestinationArtworkRoleArg::LandscapeCover => Self::LandscapeCover,
            DestinationArtworkRoleArg::HeroBanner => Self::HeroBanner,
        }
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum ArtworkCommand {
    /// Observe a semantic destination role without fetching or writing artwork.
    Handoff {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Destination image role to observe; the result identifies any exact local original available.
        #[arg(long, value_enum)]
        role: DestinationArtworkRoleArg,
    },
    /// Read exact accepted local original bytes against a previously observed binding.
    HandoffBytes {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Destination image role to observe; the result identifies any exact local original available.
        #[arg(long, value_enum)]
        role: DestinationArtworkRoleArg,
        /// Require the library identity returned by artwork handoff; another library refuses the read.
        #[arg(long)]
        expected_library_id: String,
        /// Require the artwork revision returned by the preceding observation; changed artwork refuses the operation.
        #[arg(long)]
        expected_revision: u64,
        /// Require the complete original asset SHA-256 returned by artwork handoff.
        #[arg(long)]
        expected_asset_sha256: String,
    },
    /// Show the effective artwork and source for a port and slot.
    Show {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Artwork slot to inspect or change; cover is the library image and detail is the detail view image.
        #[arg(long, value_enum, default_value = "cover")]
        slot: ArtworkSlotArg,
    },
    /// Import a local image for one port without changing its installation.
    Import {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Local image file to import; the original stays outside Portcove ownership.
        path: PathBuf,
        /// Artwork slot to inspect or change; cover is the library image and detail is the detail view image.
        #[arg(long, value_enum, default_value = "cover")]
        slot: ArtworkSlotArg,
        /// Require the artwork revision to match the value previously read.
        #[arg(long)]
        expected_revision: Option<u64>,
    },
    /// Return a port and slot to catalog or generated artwork.
    Reset {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Artwork slot to inspect or change; cover is the library image and detail is the detail view image.
        #[arg(long, value_enum, default_value = "cover")]
        slot: ArtworkSlotArg,
        /// Require the artwork revision to match the value previously read.
        #[arg(long)]
        expected_revision: Option<u64>,
    },
    /// Remove only regenerable artwork cache files.
    ClearCache,
    /// List imported artwork assets no longer referenced by a port.
    Unused,
    /// Delete one unreferenced imported asset after confirmation.
    RemoveUnused {
        /// Full SHA-256 of an unused imported asset from `artwork unused`; referenced assets cannot be removed.
        asset_sha256: String,
        /// Confirm the reviewed action without prompting.
        #[arg(long)]
        yes: bool,
    },
}

impl ArtworkCommand {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Handoff { .. } => "artwork.handoff",
            Self::HandoffBytes { .. } => "artwork.handoff-bytes",
            Self::Show { .. } => "artwork.show",
            Self::Import { .. } => "artwork.import",
            Self::Reset { .. } => "artwork.reset",
            Self::ClearCache => "artwork.clear-cache",
            Self::Unused => "artwork.unused",
            Self::RemoveUnused { .. } => "artwork.remove-unused",
        }
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum LaunchCommand {
    /// Return the retained request, or null when absent; absence is not a successful outcome.
    Show {
        /// Durable launch request UUID supplied to exec or returned by its authoritative readback.
        request_id: Uuid,
    },
    /// Recover an unfinished request after its recorded supervisor has exited.
    Recover {
        /// Durable launch request UUID supplied to exec or returned by its authoritative readback.
        request_id: Uuid,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum ExternalCommand {
    /// Review an executable you manage yourself, without claiming package authenticity.
    SelectPreview {
        /// Catalog port ID offering user-selected executable registration.
        port_id: String,
        /// Existing native game executable or supported native launcher to review.
        executable: PathBuf,
        /// Existing working directory used when launching the selected executable.
        #[arg(long)]
        working_directory: PathBuf,
        /// One literal argument per occurrence; no shell command is interpreted.
        #[arg(long = "arg", allow_hyphen_values = true)]
        arguments: Vec<String>,
    },
    /// Register the explicitly reviewed executable; all external files stay user-owned.
    Select {
        /// Catalog port ID from the preceding external select-preview review.
        port_id: String,
        /// Exact native executable or launcher path shown in the preceding review.
        executable: PathBuf,
        /// Exact working directory shown in the preceding executable review.
        #[arg(long)]
        working_directory: PathBuf,
        /// One literal argument per occurrence, matching the reviewed launch details.
        #[arg(long = "arg", allow_hyphen_values = true)]
        arguments: Vec<String>,
        /// Exact select-preview SHA-256; changed executable, directory or arguments refuse registration.
        #[arg(long)]
        expected_preview: String,
        /// Confirm execution of the reviewed user-selected executable without prompting.
        #[arg(long)]
        yes: bool,
    },
    /// Review a replacement folder against the existing retained runtime contract.
    RelinkPreview {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Replacement runtime folder to check against the retained registration contract.
        path: PathBuf,
    },
    /// Change only the registered external folder; preserve all external files.
    Relink {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Replacement folder from external relink-preview; external files are used in place.
        path: PathBuf,
        /// Exact preview fingerprint returned by the preceding review; changed inputs refuse the action.
        #[arg(long)]
        expected_preview: String,
        /// Accept the exact shared-preferences scope shown in the reviewed preview; --yes alone is insufficient.
        #[arg(long)]
        acknowledge_shared_preferences: bool,
        /// Confirm the reviewed action without prompting.
        #[arg(long)]
        yes: bool,
    },
    /// Compare a player-owned runtime with the exact accepted package contract.
    Preview {
        /// Catalog port ID offering use-in-place runtime registration.
        port_id: String,
        /// Root folder of the already prepared runtime; no files are copied.
        path: PathBuf,
    },
    /// Register a reviewed runtime; no external file becomes Portcove-owned.
    Register {
        /// Catalog port ID offering use-in-place runtime registration.
        port_id: String,
        /// Root folder of the already prepared runtime; Portcove uses it in place.
        path: PathBuf,
        /// Require the exact external preview reviewed by the caller.
        #[arg(long)]
        expected_preview: Option<String>,
        /// Accept the displayed shared preference rewrite scope for this exact preview.
        #[arg(long, requires = "expected_preview")]
        acknowledge_shared_preferences: bool,
        /// Confirm the freshly reviewed registration without a prompt; files are rechecked.
        #[arg(long)]
        yes: bool,
    },
    /// Review registration removal without changing any external files.
    RemovalPreview {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// Remove only Portcove's registration, preserving every external file.
    Remove {
        /// Catalog port ID whose external registration should be forgotten.
        port_id: String,
        /// Require the exact removal preview reviewed by the caller.
        #[arg(long)]
        expected_preview: Option<String>,
        /// Confirm forgetting the registration without a prompt; external files stay in place.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum AuthCommand {
    /// Show whether release-download credentials are available.
    Status,
    /// Sign in to GitHub with a browser code and save the resulting credential.
    #[command(
        after_help = "Open the displayed GitHub URL and enter its code. Keep this command running until sign-in finishes; Ctrl-C cancels the waiting sign-in. For unattended downloads, set PORTCOVE_GITHUB_TOKEN instead."
    )]
    Login,
    /// Save a supplied GitHub token for release downloads.
    #[command(
        after_help = "With --non-interactive, auth set-token requires --stdin. You can also set PORTCOVE_GITHUB_TOKEN for this process without saving a credential. Never place a token in command-line arguments."
    )]
    SetToken {
        #[arg(
            long,
            help = "Read the token from standard input without placing it in argv"
        )]
        stdin: bool,
    },
    /// Remove the saved GitHub credential from this host.
    Logout,
}

#[derive(Debug, Subcommand)]
pub(crate) enum BackupCommand {
    /// Review the exact qualified Ghostship 2.0.0 snapshot recovery route.
    GhostshipLegacyPlan {
        /// Backup ID from `backup list PORT_ID`; select the snapshot for the intended port.
        backup_id: String,
    },
    /// Recover qualified legacy data into a fresh retained-runtime derivative.
    GhostshipLegacyRecover {
        /// Backup ID from `backup list PORT_ID`; select the snapshot for the intended port.
        backup_id: String,
        /// Exact plan SHA-256 returned by the preceding review; changed inputs refuse the action.
        #[arg(long)]
        expected_plan: String,
        /// Confirm the reviewed action without prompting.
        #[arg(long)]
        yes: bool,
    },
    /// Copy and verify managed persistent data for one port.
    Create {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// List retained backups and their verification state.
    List {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// Delete one backup after confirmation; does not remove live saved data.
    Delete {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Backup ID from `backup list PORT_ID`; select the snapshot for the intended port.
        backup_id: String,
        /// Confirm permanent removal of this backup.
        #[arg(long)]
        yes: bool,
    },
    /// Restore a selected backup after confirmation.
    Restore {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Backup ID from `backup list PORT_ID`; select the snapshot for the intended port.
        backup_id: String,
        /// Confirm replacement of the affected managed saved data.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum LibraryCommand {
    /// Show the effective library and whether it came from --library, saved preferences, or default.
    Show,
    /// Open the selected library and report its stable identity and effective location.
    Identity,
    /// Save an existing empty directory or recognizable Portcove library as the host default.
    Set {
        /// Existing empty folder or recognizable library to save as this host's default.
        path: PathBuf,
    },
    /// Clear the saved library, including recovery from malformed or future preferences.
    Reset,
    /// Review restoring metadata and copied content into --library's new or empty root.
    #[command(
        after_help = "Review first: portcove --library <new-or-empty-root> --json library import <metadata.json> <copied-library-folder>\nThen repeat the same inputs with --apply --expected-plan <plan-sha256> from that review. Import does not merge libraries or modify the input backup."
    )]
    Import {
        /// Metadata JSON written by `library export`; contains no payload bytes.
        metadata: PathBuf,
        /// Copied library folder containing the exported content roots; never modified by import.
        content_root: PathBuf,
        /// Apply the reviewed import into --library's new or empty root; requires --expected-plan.
        #[arg(long, requires = "expected_plan")]
        apply: bool,
        /// Plan SHA-256 from this import review; changed metadata or payloads refuse the import.
        #[arg(long, requires = "apply")]
        expected_plan: Option<String>,
    },
    /// Resume an interrupted import using --library <destination>; the input backup remains unchanged.
    ResumeImport,
    /// Retain an incomplete import using --library <destination>; the incomplete destination stays closed and no copied files are deleted.
    AbortImport,
    /// Export metadata without application files, saves, or original sources.
    #[command(
        after_help = "Metadata alone is not a library backup: this export records identities and paths, not payload bytes. Retain a separate copy of the required library content before using library import with that content root. Original game files referenced outside the library stay at their existing paths."
    )]
    Export {
        /// Write metadata to PATH instead of printing it.
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Review a verified copy; applying retains the old directory as a recovery copy.
    #[command(
        after_help = "Review first: portcove --library <original> --json library move <new-directory>\nClose other Portcove clients and finish launch/lifecycle recovery before applying. Then repeat with --apply --expected-plan <plan-sha256> from that review. Original game-file references stay at their original paths."
    )]
    Move {
        /// New directory beneath an existing parent; must not overlap the original library.
        destination: PathBuf,
        /// Apply the reviewed copy; retain the original as a recovery copy.
        #[arg(long, requires = "expected_plan")]
        apply: bool,
        /// Plan SHA-256 from this move review; changed inputs refuse the move.
        #[arg(long, requires = "apply")]
        expected_plan: Option<String>,
    },
    /// Resume an interrupted move using --library <original>, the retained original directory.
    ResumeMove,
    /// Reactivate an unpublished original using --library <original>; refuses after authority publication and copied files remain.
    AbortMove,
}

#[derive(Debug, Subcommand)]
pub(crate) enum PreparationCommand {
    /// Review the installed artifact, registered source, tools and default host setup.
    Plan {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// Prepare a private installation from an unchanged reviewed plan.
    Run {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Exact plan SHA-256 returned by the preceding review; changed inputs refuse the action.
        #[arg(long)]
        expected_plan: String,
        /// Confirm the reviewed action without prompting.
        #[arg(long)]
        yes: bool,
    },
    /// Review the exact private files retained by an interrupted preparation.
    CleanupPlan {
        /// Operation ID from `portcove activity`; inspect its current state before recovery or cancellation.
        operation_id: String,
    },
    /// Remove only the unchanged private files from a reviewed cleanup plan.
    Cleanup {
        /// Operation ID from `portcove activity`; inspect its current state before recovery or cancellation.
        operation_id: String,
        /// Exact preview fingerprint returned by the preceding review; changed inputs refuse the action.
        #[arg(long)]
        expected_preview: String,
        /// Confirm the reviewed action without prompting.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum SourceCommand {
    /// Search only explicitly selected folders and profiles; never registers a candidate.
    #[command(
        after_help = "Choose folders and file profiles explicitly, for example: portcove source discover --root <folder> --profile <profile-id>. Find profile IDs in catalog show PORT_ID. Discovery only reports candidates. Review a selected file with source inbox import PROFILE_ID PATH before applying its returned plan, or deliberately register it in place with source add PROFILE_ID PATH."
    )]
    Discover(SourceDiscoveryArgs),
    /// Open and search Portcove's game-file folder for a file profile.
    Inbox {
        #[command(subcommand)]
        command: SourceInboxCommand,
    },
    /// Manage explicitly selected folders used for catalog-wide game-file discovery.
    Roots {
        #[command(subcommand)]
        command: GameFileRootCommand,
    },
    /// Validate and register a player-owned game file at its current location.
    Add {
        /// Game-file profile ID from `catalog show PORT_ID`; saved profiles appear in `source list`.
        profile_id: String,
        /// Player-owned game file to check and register in place; its bytes are not changed.
        path: PathBuf,
        /// Require the selected file to match this SHA-256 digest.
        #[arg(long)]
        expected_sha256: Option<String>,
    },
    /// Review a new location for the same registered game files; apply only the reviewed plan.
    #[command(
        after_help = "Review first: portcove source relink PROFILE_ID PATH. Repeat those inputs with --apply --expected-plan <plan-sha256> to save only the reviewed new location. The original and replacement game files are not moved or deleted; changed inputs require a fresh review."
    )]
    Relink {
        /// Registered source whose location is changing.
        profile_id: String,
        /// Replacement game-file path to review.
        path: PathBuf,
        /// Save the reviewed new location.
        #[arg(long, requires = "expected_plan")]
        apply: bool,
        /// Exact plan fingerprint returned by the review.
        #[arg(long, requires = "apply")]
        expected_plan: Option<String>,
    },
    /// List registered game-file locations and their profile IDs.
    List,
    /// Inspect a registered source without changing its bytes or saved baseline.
    Inspect {
        /// Game-file profile ID from `catalog show PORT_ID`; saved profiles appear in `source list`.
        profile_id: String,
    },
    /// Explicitly refresh route-bound game-file observations for one port on this host.
    Query(SourceQueryArgs),
    /// Recheck registered game files against their saved baselines.
    #[command(
        after_help = "Provide PROFILE_ID or pass --all. Run source list for registered profile IDs. Verification checks the saved source; it does not replace it or accept changed bytes."
    )]
    Verify(SourceVerifyArgs),
    /// Forget a source registration without deleting its file.
    Remove {
        /// Game-file profile ID from `catalog show PORT_ID`; saved profiles appear in `source list`.
        profile_id: String,
        /// Confirm forgetting this registration without a prompt.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Args)]
pub(crate) struct SourceQueryArgs {
    /// Catalog port ID; run `portcove catalog list` to find it.
    pub(crate) port_id: String,
    /// Selected setup or launch route whose game-file requirements should be checked.
    #[arg(long, value_enum)]
    pub(crate) route: GameFileQueryRouteArg,
    /// Game release channel: stable, preview or rolling; beta remains a compatibility alias for preview.
    #[arg(long, value_enum, default_value = "stable")]
    pub(crate) channel: ChannelArg,
    /// Validity duration in seconds for the returned game-file observation (1 through 1800); later use rechecks its binding.
    #[arg(long, default_value_t = 300)]
    pub(crate) maximum_age_seconds: u32,
    /// Maximum bytes in one candidate file; larger candidates are not hashed.
    #[arg(long, default_value_t = 2 * 1024 * 1024 * 1024)]
    pub(crate) max_file_bytes: u64,
    /// Maximum total file bytes to hash during this scan or query.
    #[arg(long, default_value_t = 32 * 1024 * 1024 * 1024)]
    pub(crate) max_hash_bytes: u64,
    /// Maximum elapsed milliseconds for this game-file query before it reports incomplete work.
    #[arg(long, default_value_t = 30_000)]
    pub(crate) max_elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum GameFileQueryRouteArg {
    ManagedInstall,
    ExternalRegistration,
    ManagedLaunch,
    ExternalLaunch,
}

impl From<GameFileQueryRouteArg> for portcove_core::GameFileRouteKind {
    fn from(value: GameFileQueryRouteArg) -> Self {
        match value {
            GameFileQueryRouteArg::ManagedInstall => Self::ManagedInstall,
            GameFileQueryRouteArg::ExternalRegistration => Self::ExternalRegistration,
            GameFileQueryRouteArg::ManagedLaunch => Self::ManagedLaunch,
            GameFileQueryRouteArg::ExternalLaunch => Self::ExternalLaunch,
        }
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum GameFileRootCommand {
    /// List saved folders, including currently unavailable locations.
    List,
    /// Scan every available saved folder against the current catalog.
    Scan(GameFileRootScanArgs),
    /// Read the last completed scan and whether its inputs still match.
    Snapshot,
    /// Save one available folder; adding the same folder again is idempotent.
    Add {
        /// Available folder to remember for future scans; adding it does not register its files.
        path: PathBuf,
    },
    /// Update one saved identity after a mount or folder path changes.
    Relink {
        /// Saved folder ID from `source roots list`; paths alone are not folder identities.
        root_id: String,
        /// Available replacement folder for this saved folder identity.
        path: PathBuf,
    },
    /// Forget one saved folder without changing files, registrations or installs.
    Remove {
        /// Saved folder ID from `source roots list`; paths alone are not folder identities.
        root_id: String,
    },
}

#[derive(Debug, Args)]
pub(crate) struct GameFileRootScanArgs {
    /// Maximum filesystem entries to inspect; reaching the bound leaves the scan incomplete.
    #[arg(long)]
    pub(crate) max_entries: Option<u32>,
    /// Maximum folder depth below each selected root; deeper content is not scanned.
    #[arg(long)]
    pub(crate) max_depth: Option<u32>,
    /// Maximum bytes in one candidate file; larger candidates are not hashed.
    #[arg(long)]
    pub(crate) max_file_bytes: Option<u64>,
    /// Maximum total file bytes to hash during this scan or query.
    #[arg(long)]
    pub(crate) max_hash_bytes: Option<u64>,
    /// Maximum matching candidates to retain; reaching the bound leaves the scan incomplete.
    #[arg(long)]
    pub(crate) max_candidates: Option<u32>,
}

impl GameFileRootScanArgs {
    pub(crate) fn limits(self) -> portcove_core::SourceDiscoveryLimits {
        source_limits(
            self.max_entries,
            self.max_depth,
            self.max_file_bytes,
            self.max_hash_bytes,
            self.max_candidates,
        )
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum SourceInboxCommand {
    /// Return the core-owned profile folder without changing it.
    Path {
        /// Game-file profile ID from `catalog show PORT_ID`; saved profiles appear in `source list`.
        profile_id: String,
    },
    /// Create the validated profile folder and show it in the system file manager.
    Open {
        /// Game-file profile ID from `catalog show PORT_ID`; saved profiles appear in `source list`.
        profile_id: String,
    },
    /// Scan only one profile folder; never registers an unresolved candidate.
    Scan(SourceInboxScanArgs),
    /// Review or apply a copy, explicit move, or current-location registration.
    #[command(
        after_help = "Review first: portcove source inbox import PROFILE_ID PATH --mode copy. Then repeat the same inputs and mode with --apply --expected-plan <plan-sha256>. Copy keeps the original. Move needs --yes or an interactive confirmation and removes the original only after checked publication. use-current-location saves a reference without copying. A changed file, mode or destination requires another review."
    )]
    Import {
        /// Game-file profile ID from `catalog show PORT_ID`; saved profiles appear in `source list`.
        profile_id: String,
        /// Selected game file to review for the chosen copy, move or current-location mode.
        path: PathBuf,
        /// Copy retains the original; move removes it only after checked publication and confirmation; use-current-location registers it in place.
        #[arg(long, value_enum, default_value_t = SourceImportModeArg::Copy)]
        mode: SourceImportModeArg,
        /// Apply the reviewed action; requires the exact --expected-plan from the preview.
        #[arg(long, requires = "expected_plan")]
        apply: bool,
        /// Exact plan SHA-256 returned by the preceding review; changed inputs refuse the action.
        #[arg(long, requires = "apply")]
        expected_plan: Option<String>,
        /// Confirm deletion of the original after a verified move publication.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum SourceImportModeArg {
    Copy,
    Move,
    UseCurrentLocation,
}

impl From<SourceImportModeArg> for SourceImportMode {
    fn from(value: SourceImportModeArg) -> Self {
        match value {
            SourceImportModeArg::Copy => Self::Copy,
            SourceImportModeArg::Move => Self::Move,
            SourceImportModeArg::UseCurrentLocation => Self::UseCurrentLocation,
        }
    }
}

#[derive(Debug, Args)]
pub(crate) struct SourceInboxScanArgs {
    /// Game-file profile ID from `catalog show PORT_ID`; saved profiles appear in `source list`.
    pub(crate) profile_id: String,
    /// Maximum filesystem entries to inspect; reaching the bound leaves the scan incomplete.
    #[arg(long)]
    pub(crate) max_entries: Option<u32>,
    /// Maximum folder depth below each selected root; deeper content is not scanned.
    #[arg(long)]
    pub(crate) max_depth: Option<u32>,
    /// Maximum bytes in one candidate file; larger candidates are not hashed.
    #[arg(long)]
    pub(crate) max_file_bytes: Option<u64>,
    /// Maximum total file bytes to hash during this scan or query.
    #[arg(long)]
    pub(crate) max_hash_bytes: Option<u64>,
    /// Maximum matching candidates to retain; reaching the bound leaves the scan incomplete.
    #[arg(long)]
    pub(crate) max_candidates: Option<u32>,
}

impl SourceInboxScanArgs {
    pub(crate) fn limits(self) -> portcove_core::SourceDiscoveryLimits {
        source_limits(
            self.max_entries,
            self.max_depth,
            self.max_file_bytes,
            self.max_hash_bytes,
            self.max_candidates,
        )
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum ToolCommand {
    /// Show resolution, source, purpose, and official setup reference for every tool.
    List,
    /// Validate a native executable with the tool's fixed probe before saving it.
    SetPath {
        /// Tool ID from `portcove tool list`, which also shows its supported purpose and setup reference.
        tool_id: String,
        /// Path to the tool executable; its fixed probe must succeed before the path is saved.
        executable_path: PathBuf,
    },
    /// Clear the saved path without changing an environment override or any library.
    ClearPath {
        /// Tool ID from `portcove tool list`, which also shows its supported purpose and setup reference.
        tool_id: String,
    },
}

#[derive(Debug, Args)]
pub(crate) struct SourceVerifyArgs {
    /// Game-file profile ID from `catalog show PORT_ID`; saved profiles appear in `source list`.
    pub(crate) profile_id: Option<String>,
    /// Check every registered game-file profile instead of one PROFILE_ID.
    #[arg(long, conflicts_with = "profile_id")]
    pub(crate) all: bool,
}

#[derive(Debug, Args)]
pub(crate) struct SourceDiscoveryArgs {
    /// Folder to search; repeat --root for each selected folder. Discovery never registers matches automatically.
    #[arg(long = "root", required = true)]
    pub(crate) roots: Vec<PathBuf>,
    /// Exact file profile to search for; repeat --profile. Find profile IDs with `catalog show PORT_ID`.
    #[arg(long = "profile", required = true)]
    pub(crate) profiles: Vec<String>,
    /// Maximum filesystem entries to inspect; reaching the bound leaves the scan incomplete.
    #[arg(long)]
    pub(crate) max_entries: Option<u32>,
    /// Maximum folder depth below each selected root; deeper content is not scanned.
    #[arg(long)]
    pub(crate) max_depth: Option<u32>,
    /// Maximum bytes in one candidate file; larger candidates are not hashed.
    #[arg(long)]
    pub(crate) max_file_bytes: Option<u64>,
    /// Maximum total file bytes to hash during this scan or query.
    #[arg(long)]
    pub(crate) max_hash_bytes: Option<u64>,
    /// Maximum matching candidates to retain; reaching the bound leaves the scan incomplete.
    #[arg(long)]
    pub(crate) max_candidates: Option<u32>,
}

impl SourceDiscoveryArgs {
    pub(crate) fn request(self) -> portcove_core::SourceDiscoveryRequest {
        portcove_core::SourceDiscoveryRequest {
            roots: self.roots,
            profile_ids: self.profiles,
            limits: source_limits(
                self.max_entries,
                self.max_depth,
                self.max_file_bytes,
                self.max_hash_bytes,
                self.max_candidates,
            ),
        }
    }
}

fn source_limits(
    max_entries: Option<u32>,
    max_depth: Option<u32>,
    max_file_bytes: Option<u64>,
    max_hash_bytes: Option<u64>,
    max_candidates: Option<u32>,
) -> portcove_core::SourceDiscoveryLimits {
    let defaults = portcove_core::SourceDiscoveryLimits::default();
    portcove_core::SourceDiscoveryLimits {
        max_entries: max_entries.unwrap_or(defaults.max_entries),
        max_depth: max_depth.unwrap_or(defaults.max_depth),
        max_file_bytes: max_file_bytes.unwrap_or(defaults.max_file_bytes),
        max_hash_bytes: max_hash_bytes.unwrap_or(defaults.max_hash_bytes),
        max_candidates: max_candidates.unwrap_or(defaults.max_candidates),
    }
}

#[derive(Debug, Args)]
pub(crate) struct InstallArgs {
    /// Catalog port ID to install; run `portcove catalog list` to find it.
    pub(crate) port_id: String,
    /// Release channel: stable (Stable), preview (Preview), or rolling (Rolling); beta is a compatibility alias.
    #[arg(long, value_enum)]
    pub(crate) channel: Option<ChannelArg>,
    /// Override the registered game file for this installation.
    #[arg(long)]
    pub(crate) source: Option<PathBuf>,
    /// Override the registered BIOS file for this installation.
    #[arg(long)]
    pub(crate) bios: Option<PathBuf>,
    /// Place a new install in this folder instead of its saved destination.
    #[arg(long)]
    pub(crate) output_dir: Option<PathBuf>,
    /// Download and check the release without activating it as the current version.
    #[arg(long)]
    pub(crate) stage: bool,
}

#[derive(Debug, Args)]
pub(crate) struct EnsureArgs {
    /// Catalog port ID to use or install; run `portcove catalog list` to find it.
    pub(crate) port_id: String,
    /// Release channel if needed: stable (Stable), preview (Preview), or rolling (Rolling); beta is a compatibility alias.
    #[arg(long, value_enum)]
    pub(crate) channel: Option<ChannelArg>,
    /// Override the source game file used if installation is needed.
    #[arg(long)]
    pub(crate) source: Option<PathBuf>,
    /// Override the BIOS file used if installation is needed.
    #[arg(long)]
    pub(crate) bios: Option<PathBuf>,
    /// Folder for a new install; an existing install is not moved.
    #[arg(long)]
    pub(crate) output_dir: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
pub(crate) enum OutputCommand {
    /// Show the saved and effective future install folder for one game.
    Show {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// Review a future install folder without changing files or settings.
    Preview {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Omit PATH to preview resetting to the library default.
        path: Option<PathBuf>,
    },
    /// Save a reviewed future install folder. Existing installs are not moved.
    Set {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Future install folder from output preview; current installations remain at their existing paths.
        path: PathBuf,
        /// Exact preview fingerprint returned by the preceding review; changed inputs refuse the action.
        #[arg(long)]
        expected_preview: String,
        /// Confirm the reviewed action without prompting.
        #[arg(long)]
        yes: bool,
    },
    /// Return future installs to the library default. Existing installs are not moved.
    Reset {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Exact preview fingerprint returned by the preceding review; changed inputs refuse the action.
        #[arg(long)]
        expected_preview: String,
        /// Confirm the reviewed action without prompting.
        #[arg(long)]
        yes: bool,
    },
    /// Review or apply relocation of every installed version for one game.
    Move {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// New destination for all retained managed versions; must match the reviewed relocation plan.
        path: PathBuf,
        /// Apply the reviewed action; requires the exact --expected-plan from the preview.
        #[arg(long, requires = "expected_plan")]
        apply: bool,
        /// Exact plan SHA-256 returned by the preceding review; changed inputs refuse the action.
        #[arg(long, requires = "apply")]
        expected_plan: Option<String>,
        /// Confirm the reviewed action without prompting.
        #[arg(long, requires = "apply")]
        yes: bool,
    },
}

#[derive(Debug, Args)]
pub(crate) struct UpdateArgs {
    /// Installed PORT_ID to update, or omit it and pass --all.
    pub(crate) port_id: Option<String>,
    /// Update every eligible installed port instead of one PORT_ID.
    #[arg(long, conflicts_with = "port_id")]
    pub(crate) all: bool,
    /// Override the registered game file for the update.
    #[arg(long)]
    pub(crate) source: Option<PathBuf>,
    /// Override the registered BIOS file for the update.
    #[arg(long)]
    pub(crate) bios: Option<PathBuf>,
    /// Download and check the update without activating it as the current version.
    #[arg(long)]
    pub(crate) stage: bool,
}

#[derive(Debug, Args)]
pub(crate) struct UpdateTargetArgs {
    /// Installed PORT_ID to check or reconcile, or omit it and pass --all.
    pub(crate) port_id: Option<String>,
    /// Use every installed port instead of one PORT_ID.
    #[arg(long, conflicts_with = "port_id")]
    pub(crate) all: bool,
}

#[derive(Debug, Args)]
pub(crate) struct AdoptArgs {
    /// Existing managed installation folder to review.
    pub(crate) path: PathBuf,
    /// Require adoption to resolve to this catalog port ID.
    #[arg(long)]
    pub(crate) port: Option<String>,
    /// Confirm the reviewed copy and registration without prompting; skipped entries remain outside the copy.
    #[arg(long)]
    pub(crate) yes: bool,
}

#[derive(Debug, Args)]
pub(crate) struct ExecArgs {
    /// Installed PORT_ID to launch; inspect `status PORT_ID` for readiness.
    pub(crate) port_id: String,
    /// Override the registered game file for this launch.
    #[arg(long)]
    pub(crate) source: Option<PathBuf>,
    /// Caller-known UUID for durable launch observation; a fresh UUID is generated by default.
    #[arg(long)]
    pub(crate) request_id: Option<Uuid>,
    /// Arguments after -- pass unchanged to native games; batch launchers reject caller arguments.
    #[arg(last = true, allow_hyphen_values = true)]
    pub(crate) game_args: Vec<String>,
}

#[derive(Debug, Subcommand)]
pub(crate) enum ChannelCommand {
    /// Save the preferred channel: stable (Stable), preview (Preview), or rolling (Rolling); beta is a compatibility alias.
    Set {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Game release channel: stable, preview or rolling; beta remains a compatibility alias for preview.
        #[arg(value_enum)]
        channel: ChannelArg,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum PolicyCommand {
    /// Save notify, stage, or automatic handling for future game updates.
    Set {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
        /// Future update behavior: notify only, download/check and stage, or automatically activate eligible updates.
        #[arg(value_enum)]
        policy: PolicyArg,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum SchemaCommand {
    /// Export JSON schemas for CLI input or serialized output.
    Export {
        /// Choose input (default) or output contract shapes.
        #[arg(long, value_enum, default_value = "input")]
        contract: SchemaContract,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum ChannelArg {
    Stable,
    /// Preview releases; beta is a compatibility alias for the same stream.
    #[value(name = "preview", alias = "beta")]
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
pub(crate) enum PolicyArg {
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use clap::{Command, CommandFactory, Parser};

    use super::{Cli, Commands, ROOT_COMMAND_GROUPS};

    fn assert_help(command: &Command, path: &str) {
        for argument in command
            .get_arguments()
            .filter(|argument| !argument.is_hide_set())
        {
            assert!(
                argument
                    .get_help()
                    .is_some_and(|help| !help.to_string().trim().is_empty()),
                "{path}: argument {} needs purpose and usage help",
                argument.get_id()
            );
        }
        for child in command
            .get_subcommands()
            .filter(|child| !child.is_hide_set() && child.get_name() != "help")
        {
            let child_path = format!("{path} {}", child.get_name());
            assert!(
                child
                    .get_about()
                    .is_some_and(|about| !about.to_string().trim().is_empty()),
                "{child_path}: command needs task help"
            );
            assert_help(child, &child_path);
        }
    }

    #[test]
    fn every_visible_command_and_argument_explains_its_purpose() {
        let mut command = Cli::command();
        command.build();
        assert_help(&command, "portcove");
    }

    #[test]
    fn root_help_groups_every_implemented_command_once() {
        let mut command = Cli::command();
        command.build();
        let visible = command
            .get_subcommands()
            .filter(|child| !child.is_hide_set() && child.get_name() != "help")
            .map(|child| child.get_name())
            .collect::<BTreeSet<_>>();
        let grouped = ROOT_COMMAND_GROUPS
            .iter()
            .flat_map(|(_, names)| names.iter().copied())
            .collect::<Vec<_>>();
        assert_eq!(
            grouped.len(),
            grouped.iter().copied().collect::<BTreeSet<_>>().len(),
            "a command appears in more than one task group"
        );
        assert_eq!(visible, grouped.into_iter().collect());
        let help = command.render_long_help().to_string();
        assert!(help.contains("Manage native game ports from a local Portcove library."));
        assert!(!help.contains("Other commands:"));
        let positions = ROOT_COMMAND_GROUPS
            .iter()
            .map(|(heading, _)| help.find(heading).unwrap())
            .collect::<Vec<_>>();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(help.contains("Human prose is not a parser contract"));
        assert!(help.contains("activity log ACTIVITY_ID"));
    }

    fn help(path: &[&str]) -> String {
        let mut arguments = vec!["portcove"];
        arguments.extend_from_slice(path);
        arguments.push("--help");
        Cli::try_parse_from(arguments)
            .unwrap_err()
            .to_string()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn consequential_help_preserves_review_originals_and_raw_stream_limits() {
        for (path, phrases) in [
            (
                vec!["source", "discover"],
                vec![
                    "never registers",
                    "--root",
                    "--profile",
                    "source inbox import",
                ],
            ),
            (
                vec!["source", "relink"],
                vec!["--expected-plan", "not moved or deleted", "fresh review"],
            ),
            (
                vec!["source", "inbox", "import"],
                vec![
                    "Copy keeps the original",
                    "Move needs --yes",
                    "use-current-location",
                ],
            ),
            (
                vec!["library", "export"],
                vec!["Metadata alone is not a library backup", "payload bytes"],
            ),
            (
                vec!["library", "import"],
                vec!["new or empty", "--expected-plan", "does not merge"],
            ),
            (
                vec!["library", "abort-move"],
                vec!["refuses after authority publication", "copied files remain"],
            ),
            (
                vec!["auth", "set-token"],
                vec![
                    "--non-interactive",
                    "requires --stdin",
                    "PORTCOVE_GITHUB_TOKEN",
                ],
            ),
            (
                vec!["exec"],
                vec![
                    "standard input",
                    "standard output",
                    "standard error",
                    "exit code",
                    "cannot use --json or --jsonl",
                    "unchanged",
                ],
            ),
            (
                vec!["catalog", "trust-key"],
                vec![
                    "64-character",
                    "trusted channel",
                    "release download locations",
                ],
            ),
            (
                vec!["catalog", "update"],
                vec![
                    "fingerprint returned by the preview",
                    "--expected-plan",
                    "not installed game files",
                ],
            ),
        ] {
            let rendered = help(&path);
            for phrase in phrases {
                assert!(
                    rendered.contains(phrase),
                    "{} help lacks {phrase:?}: {rendered}",
                    path.join(" ")
                );
            }
        }
    }

    #[test]
    fn publisher_key_confirmation_does_not_invent_a_plan_requirement() {
        let rendered = help(&["catalog", "trust-key"]);
        assert!(rendered.contains("Confirm trusting this public key without prompting"));
        assert!(rendered.contains("trusted channel"));
        assert!(!rendered.contains("exact-plan"));
        assert!(!rendered.contains("--expected-plan"));
        let artwork = help(&["artwork", "remove-unused"]);
        assert!(!artwork.contains("fingerprint checks"));
    }

    #[test]
    fn grouped_help_keeps_literal_game_arguments_and_review_requirements() {
        let parsed = Cli::try_parse_from([
            "portcove",
            "exec",
            "ship",
            "--",
            "--fullscreen",
            "save 名称",
            "-1",
        ])
        .unwrap();
        let Commands::Exec(arguments) = parsed.command else {
            panic!("wrong command")
        };
        assert_eq!(arguments.game_args, ["--fullscreen", "save 名称", "-1"]);
        assert!(Cli::try_parse_from(["portcove", "library", "move", "new", "--apply"]).is_err());
        assert!(
            Cli::try_parse_from([
                "portcove",
                "source",
                "relink",
                "profile",
                "file",
                "--expected-plan",
                "a"
            ])
            .is_err()
        );
        assert!(Cli::try_parse_from(["portcove", "--json", "--jsonl", "status"]).is_err());
    }
}
