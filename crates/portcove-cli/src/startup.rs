//! Constructor policy and bounded startup observations. Dispatch and
//! cancellation ownership stay in main; Core owns every durable outcome.
use crate::*;

#[derive(Clone, Copy)]
pub(super) enum DiagnosticPhase {
    Arguments,
    Preferences,
    RuntimeLease,
    LibrarySelection,
    LibraryOpen,
    ServiceStartup,
    Command,
}

impl DiagnosticPhase {
    fn label(self) -> &'static str {
        match self {
            Self::Arguments => "arguments",
            Self::Preferences => "preferences",
            Self::RuntimeLease => "runtime_lease",
            Self::LibrarySelection => "library_selection",
            Self::LibraryOpen => "library_open",
            Self::ServiceStartup => "service_startup",
            Self::Command => "command",
        }
    }
}

pub(super) fn record_diagnostic(phase: DiagnosticPhase, success: bool, code: Option<ErrorCode>) {
    tracing::info!(
        target: "portcove_cli::host_diagnostics",
        component = "startup",
        operation_id = "cli-startup",
        phase = phase.label(),
        success,
        code = code.map(portcove_diagnostics::code_label).unwrap_or("None"),
        message = "CLI stage completed"
    );
}

pub(super) fn observe<T>(phase: DiagnosticPhase, result: Result<T>) -> Result<T> {
    record_diagnostic(
        phase,
        result.is_ok(),
        result.as_ref().err().map(|error| error.code),
    );
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StartupMode {
    ReadOnly,
    Recovering,
}

pub(super) fn startup_mode(command: &Commands) -> StartupMode {
    use StartupMode::{ReadOnly, Recovering};
    match command {
        Commands::Artwork { command } => match command {
            ArtworkCommand::Handoff { .. }
            | ArtworkCommand::HandoffBytes { .. }
            | ArtworkCommand::Show { .. }
            | ArtworkCommand::Unused => ReadOnly,
            ArtworkCommand::Import { .. }
            | ArtworkCommand::Reset { .. }
            | ArtworkCommand::ClearCache
            | ArtworkCommand::RemoveUnused { .. } => Recovering,
        },
        Commands::Auth { command } => match command {
            AuthCommand::Status => ReadOnly,
            AuthCommand::Login | AuthCommand::SetToken { .. } | AuthCommand::Logout => Recovering,
        },
        Commands::Backup { command } => match command {
            BackupCommand::List { .. } | BackupCommand::GhostshipLegacyPlan { .. } => ReadOnly,
            BackupCommand::Create { .. }
            | BackupCommand::Delete { .. }
            | BackupCommand::Restore { .. }
            | BackupCommand::GhostshipLegacyRecover { .. } => Recovering,
        },
        Commands::Catalog { command } => match command {
            CatalogCommand::List
            | CatalogCommand::Export
            | CatalogCommand::Listings
            | CatalogCommand::InspectListings { .. }
            | CatalogCommand::Show { .. }
            | CatalogCommand::Status
            | CatalogCommand::InspectProposal { .. } => ReadOnly,
            CatalogCommand::InspectDefinitionPublication { .. } => ReadOnly,
            CatalogCommand::DefinitionAuthority { apply, .. }
            | CatalogCommand::Update { apply, .. } => apply_mode(*apply),
            CatalogCommand::CheckCapabilities { .. }
            | CatalogCommand::InspectObservation { .. }
            | CatalogCommand::DefinitionRefresh { .. }
            | CatalogCommand::TrustKey { .. }
            | CatalogCommand::RevokeKey { .. }
            | CatalogCommand::Rollback { .. }
            | CatalogCommand::UseCached { .. }
            | CatalogCommand::UseEmbedded { .. } => Recovering,
        },
        Commands::Source { command } => match command {
            SourceCommand::List | SourceCommand::Inspect { .. } | SourceCommand::Verify(_) => {
                ReadOnly
            }
            SourceCommand::Relink { apply, .. } => apply_mode(*apply),
            SourceCommand::Discover(_)
            | SourceCommand::Add { .. }
            | SourceCommand::Query(_)
            | SourceCommand::Remove { .. } => Recovering,
            SourceCommand::Inbox { command } => match command {
                SourceInboxCommand::Path { .. } => ReadOnly,
                SourceInboxCommand::Import { apply, .. } => apply_mode(*apply),
                SourceInboxCommand::Open { .. } | SourceInboxCommand::Scan(_) => Recovering,
            },
            SourceCommand::Roots { command } => match command {
                GameFileRootCommand::List | GameFileRootCommand::Snapshot => ReadOnly,
                GameFileRootCommand::Scan(_)
                | GameFileRootCommand::Add { .. }
                | GameFileRootCommand::Relink { .. }
                | GameFileRootCommand::Remove { .. } => Recovering,
            },
        },
        Commands::External { command } => match command {
            ExternalCommand::Preview { .. }
            | ExternalCommand::SelectPreview { .. }
            | ExternalCommand::SelectRelinkPreview { .. }
            | ExternalCommand::RemovalPreview { .. }
            | ExternalCommand::RelinkPreview { .. } => ReadOnly,
            ExternalCommand::Register { .. }
            | ExternalCommand::Select { .. }
            | ExternalCommand::SelectRelink { .. }
            | ExternalCommand::Remove { .. }
            | ExternalCommand::Relink { .. } => Recovering,
        },
        Commands::Setup { command } => match command {
            crate::setup::SetupCommand::Candidates { .. }
            | crate::setup::SetupCommand::Preview { .. }
            | crate::setup::SetupCommand::Pending => ReadOnly,
            crate::setup::SetupCommand::Download { .. }
            | crate::setup::SetupCommand::Forget { .. } => Recovering,
        },
        Commands::Installation { command } => match command {
            InstallationCommand::Plan { .. }
            | InstallationCommand::Retained { .. }
            | InstallationCommand::Reference { .. }
            | InstallationCommand::ReferencePlan { .. }
            | InstallationCommand::ReferenceRemovalPlan { .. } => ReadOnly,
            InstallationCommand::Run { .. }
            | InstallationCommand::ReferenceBind { .. }
            | InstallationCommand::ReferenceRemove { .. } => Recovering,
            #[cfg(feature = "qualification-fixtures")]
            InstallationCommand::QualificationUpdatePlan { .. } => ReadOnly,
            #[cfg(feature = "qualification-fixtures")]
            InstallationCommand::QualificationUpdateRun { .. } => Recovering,
        },
        Commands::Preparation { command } => match command {
            PreparationCommand::Plan { .. } | PreparationCommand::CleanupPlan { .. } => ReadOnly,
            PreparationCommand::Run { .. } | PreparationCommand::Cleanup { .. } => Recovering,
        },
        Commands::Output { command } => match command {
            OutputCommand::Show { .. } | OutputCommand::Preview { .. } => ReadOnly,
            OutputCommand::Move { apply, .. } => apply_mode(*apply),
            OutputCommand::Set { .. } | OutputCommand::Reset { .. } => Recovering,
        },
        Commands::Activity { command, .. } => match command {
            None | Some(ActivityCommand::Log { .. }) => ReadOnly,
        },
        Commands::Launch { command } => match command {
            LaunchCommand::Show { .. } | LaunchCommand::Recover { .. } => Recovering,
        },
        // These commands return before shared service construction. Preserve the
        // historical policy bit without moving their own dispatch/constructors.
        Commands::Library { command } => match command {
            LibraryCommand::Show
            | LibraryCommand::Identity
            | LibraryCommand::Set { .. }
            | LibraryCommand::Reset
            | LibraryCommand::Import { .. }
            | LibraryCommand::ResumeImport
            | LibraryCommand::AbortImport
            | LibraryCommand::Export { .. }
            | LibraryCommand::Move { .. }
            | LibraryCommand::ResumeMove
            | LibraryCommand::AbortMove => Recovering,
        },
        Commands::Tool { command } => match command {
            ToolCommand::List | ToolCommand::SetPath { .. } | ToolCommand::ClearPath { .. } => {
                Recovering
            }
        },
        Commands::Schema { command } => match command {
            SchemaCommand::Export { .. } => Recovering,
        },
        Commands::Channel { command } => match command {
            ChannelCommand::Set { .. } => Recovering,
        },
        Commands::Policy { command } => match command {
            PolicyCommand::Set { .. } => Recovering,
        },
        Commands::Status { .. }
        | Commands::Storage
        | Commands::Doctor
        | Commands::Plan { .. }
        | Commands::Paths { .. }
        | Commands::RemovePreview { .. }
        | Commands::Capabilities => ReadOnly,
        Commands::Cancel { .. }
        | Commands::About
        | Commands::Check(_)
        | Commands::Reconcile(_)
        | Commands::Install(_)
        | Commands::Adopt(_)
        | Commands::Ensure(_)
        | Commands::Update(_)
        | Commands::Verify { .. }
        | Commands::Activate { .. }
        | Commands::Rollback { .. }
        | Commands::Remove { .. }
        | Commands::Exec(_) => Recovering,
    }
}

fn apply_mode(apply: bool) -> StartupMode {
    match apply {
        false => StartupMode::ReadOnly,
        true => StartupMode::Recovering,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_build_reads_preserve_recovery_and_writes_require_a_review_digest() {
        for arguments in [
            "installation retained port",
            "installation reference port setup",
            "installation reference-plan port setup install",
            "installation reference-removal-plan port setup",
        ] {
            let cli = Cli::try_parse_from(
                std::iter::once("portcove").chain(arguments.split_whitespace()),
            )
            .unwrap();
            assert_eq!(startup_mode(&cli.command), StartupMode::ReadOnly);
        }
        for arguments in [
            "installation reference-bind port setup install",
            "installation reference-remove port setup",
        ] {
            let args = std::iter::once("portcove")
                .chain(arguments.split_whitespace())
                .collect::<Vec<_>>();
            assert_eq!(
                Cli::try_parse_from(args.iter().copied())
                    .unwrap_err()
                    .kind(),
                clap::error::ErrorKind::MissingRequiredArgument
            );
            let cli = Cli::try_parse_from(
                args.into_iter()
                    .chain(["--expected-preview", "reviewed-digest"]),
            )
            .unwrap();
            assert_eq!(startup_mode(&cli.command), StartupMode::Recovering);
        }
    }

    #[test]
    fn legacy_recovery_plan_is_read_only_and_application_can_resume_its_journal() {
        use clap::Parser;
        let plan =
            Cli::try_parse_from(["portcove", "backup", "ghostship-legacy-plan", "backup"]).unwrap();
        assert_eq!(startup_mode(&plan.command), StartupMode::ReadOnly);
        let apply = Cli::try_parse_from([
            "portcove",
            "backup",
            "ghostship-legacy-recover",
            "backup",
            "--expected-plan",
            "hash",
        ])
        .unwrap();
        assert_eq!(startup_mode(&apply.command), StartupMode::Recovering);
        assert!(
            Cli::try_parse_from(["portcove", "backup", "ghostship-legacy-recover", "backup"])
                .is_err()
        );
    }

    // Literal expectations transcribed from the independently reviewed pre-change
    // policy at 9be54ea7. These are parser/constructor-policy tests, not native
    // recovery evidence (the machine_contract integration test supplies that).
    #[test]
    fn parsed_leaf_policy_matches_prechange_oracle() {
        let observations = [
            "artwork handoff p --role portrait-cover",
            "artwork handoff-bytes p --role portrait-cover --expected-library-id l --expected-revision 1 --expected-asset-sha256 a",
            "artwork show p",
            "artwork unused",
            "auth status",
            "backup list p",
            "catalog list",
            "catalog export",
            "catalog show p",
            "catalog status",
            "catalog inspect-proposal file",
            "catalog inspect-definition-publication directory",
            "catalog definition-authority",
            "catalog update --file file",
            "source list",
            "source inspect p",
            "source verify p",
            "source relink p file",
            "source inbox path p",
            "source inbox import p file",
            "source roots list",
            "source roots snapshot",
            "external preview p dir",
            "external removal-preview p",
            "installation plan p",
            "preparation plan p",
            "preparation cleanup-plan op",
            "output show p",
            "output preview p",
            "output move p dir",
            "status",
            "activity",
            "activity log op",
            "storage",
            "doctor",
            "paths p",
            "plan p",
            "remove-preview p",
            "capabilities",
        ];
        let recovering = [
            "artwork import p file",
            "artwork reset p",
            "artwork clear-cache",
            "artwork remove-unused hash",
            "auth login",
            "auth set-token --stdin",
            "auth logout",
            "backup create p",
            "backup delete p backup",
            "backup restore p backup",
            "catalog check-capabilities file",
            "catalog inspect-observation p file --repository-id 1",
            "catalog definition-authority --apply --expected-plan hash",
            "catalog definition-refresh p --metadata-base-url https://example.invalid --targets-base-url https://example.invalid",
            "catalog trust-key key",
            "catalog revoke-key key --expected-state hash",
            "catalog update --file file --apply --expected-plan hash",
            "catalog rollback --expected-state hash",
            "catalog use-cached --expected-state hash",
            "catalog use-embedded --expected-state hash",
            "source discover --root dir --profile p",
            "source add p file",
            "source query p --route managed-install",
            "source relink p file --apply --expected-plan hash",
            "source remove p",
            "source inbox open p",
            "source inbox scan p",
            "source inbox import p file --apply --expected-plan hash",
            "source roots scan",
            "source roots add dir",
            "source roots relink id dir",
            "source roots remove id",
            "external register p dir",
            "external remove p",
            "installation run p --expected-plan hash",
            "preparation run p --expected-plan hash",
            "preparation cleanup op --expected-preview hash",
            "output set p dir --expected-preview hash",
            "output reset p --expected-preview hash",
            "output move p dir --apply --expected-plan hash",
            "launch show 00000000-0000-0000-0000-000000000001",
            "launch recover 00000000-0000-0000-0000-000000000001",
            "library show",
            "library identity",
            "library set dir",
            "library reset",
            "library import file dir",
            "library import file dir --apply --expected-plan hash",
            "library resume-import",
            "library abort-import",
            "library export",
            "library export --output file",
            "library move dir",
            "library move dir --apply --expected-plan hash",
            "library resume-move",
            "library abort-move",
            "tool list",
            "tool set-path tool file",
            "tool clear-path tool",
            "cancel op",
            "about",
            "schema export",
            "schema export --contract output",
            "check",
            "reconcile",
            "install p",
            "adopt dir --port p",
            "ensure p",
            "update p",
            "verify p",
            "activate p",
            "rollback p",
            "remove p",
            "channel set p stable",
            "policy set p notify",
            "exec p",
        ];
        for (mode, cases) in [
            (StartupMode::ReadOnly, observations.as_slice()),
            (StartupMode::Recovering, recovering.as_slice()),
        ] {
            for arguments in cases {
                let parsed = Cli::try_parse_from(
                    std::iter::once("portcove").chain(arguments.split_whitespace()),
                )
                .unwrap_or_else(|error| panic!("{arguments}: {error}"));
                assert_eq!(startup_mode(&parsed.command), mode, "{arguments}");
            }
        }
        #[cfg(feature = "qualification-fixtures")]
        for (arguments, mode) in [
            (
                "installation qualification-update-plan p",
                StartupMode::ReadOnly,
            ),
            (
                "installation qualification-update-run p --expected-plan hash",
                StartupMode::Recovering,
            ),
        ] {
            let parsed = Cli::try_parse_from(
                std::iter::once("portcove").chain(arguments.split_whitespace()),
            )
            .unwrap();
            assert_eq!(startup_mode(&parsed.command), mode);
        }
    }
}
