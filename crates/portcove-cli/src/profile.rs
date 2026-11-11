//! CLI presentation for Core-owned local profiles and their immutable revisions.
//! Core owns identity, validation, retention and recovery; this adapter parses
//! arguments and renders the same decisions Desktop consumes.
use std::{io::Read, path::PathBuf};

use clap::{Subcommand, ValueEnum};
use portcove_core::{
    OriginalAvailability, PortcoveError, PortcoveService, Profile, ProfileInventory,
    ProfileRevision, ProfileRevisionRequest, ProfileUpdatePolicy, Result,
};

use crate::{OutputMode, human::clean, render_read_success};

const MAX_REQUEST_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum PolicyArg {
    KeepCurrent,
    ReviewUpdates,
    AutomaticEligible,
}

impl From<PolicyArg> for ProfileUpdatePolicy {
    fn from(value: PolicyArg) -> Self {
        match value {
            PolicyArg::KeepCurrent => Self::KeepCurrent,
            PolicyArg::ReviewUpdates => Self::ReviewUpdates,
            PolicyArg::AutomaticEligible => Self::AutomaticEligible,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum ToggleArg {
    On,
    Off,
}

#[derive(Debug, Subcommand)]
pub(crate) enum ProfileCommand {
    /// List a port's profiles with their current exact revision and original availability.
    List {
        /// Catalog port ID; run `portcove catalog list` to find it.
        port_id: String,
    },
    /// Give an installed port its equivalent default profile; safe to repeat.
    EnsureDefault {
        /// Catalog port ID with an active installation.
        port_id: String,
    },
    /// Create another profile from a profile's current revision with its own progress.
    Copy {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`; a display name is not an identity.
        source_profile_id: String,
        /// Name shown for the new profile.
        name: String,
    },
    /// Show every immutable revision of one profile, oldest first.
    Revisions {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
    },
    /// Record how this profile should follow newer eligible releases.
    Policy {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// keep-current, review-updates or automatic-eligible.
        #[arg(value_enum)]
        policy: PolicyArg,
    },
    /// Review and install a local mod archive into a profile as a new revision.
    InstallPackage {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// Local archive; it is inspected, never executed, and copied by digest.
        file: PathBuf,
        /// Revision you reviewed; a newer revision makes the install stale.
        #[arg(long)]
        expected_revision: u64,
    },
    /// Enable or disable an installed package as a new revision.
    SetPackage {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// Package native ID shown by `profile list`.
        native_id: String,
        /// `on` or `off`.
        #[arg(value_enum)]
        state: ToggleArg,
        /// Revision you reviewed.
        #[arg(long)]
        expected_revision: u64,
    },
    /// Make a profile the one whose mods and progress are live for play.
    Activate {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
    },
    /// Show live mod files that are not owned by the selected profile or were changed.
    Live {
        /// Catalog port ID.
        port_id: String,
    },
    /// Review one GameBanana file for a profile: downloads privately, inspects, prints the plan.
    ProviderPlan {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// GameBanana Mod ID.
        project_id: u64,
        /// GameBanana file ID from the project's file list.
        file_id: u64,
    },
    /// Install exactly the reviewed plan; changed bytes or a newer revision refuse.
    ProviderApply {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// JSON plan saved from `profile provider-plan`.
        plan_file: PathBuf,
        /// `plan_sha256` of the plan you reviewed.
        #[arg(long)]
        expected_plan: String,
        /// Confirm the reviewed install without a prompt; the digest check still applies.
        #[arg(long)]
        yes: bool,
    },
    /// Append a successor revision from a reviewed JSON request file (`-` reads stdin).
    Revise {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// JSON `ProfileRevisionRequest`; `expected_revision` must be the revision you reviewed.
        request_file: PathBuf,
    },
}

impl ProfileCommand {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::List { .. } => "profile.list",
            Self::EnsureDefault { .. } => "profile.ensure-default",
            Self::Copy { .. } => "profile.copy",
            Self::Revisions { .. } => "profile.revisions",
            Self::Policy { .. } => "profile.policy",
            Self::Revise { .. } => "profile.revise",
            Self::InstallPackage { .. } => "profile.install-package",
            Self::SetPackage { .. } => "profile.set-package",
            Self::Activate { .. } => "profile.activate",
            Self::Live { .. } => "profile.live",
            Self::ProviderPlan { .. } => "profile.provider-plan",
            Self::ProviderApply { .. } => "profile.provider-apply",
        }
    }

    pub(crate) fn mutates(&self) -> bool {
        !matches!(
            self,
            Self::List { .. } | Self::Revisions { .. } | Self::Live { .. }
        )
    }
}

fn read_plan(path: &PathBuf) -> Result<portcove_core::ProviderInstallPlan> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(PortcoveError::usage("plan file exceeds 256 KiB"));
    }
    // `data` wrappers from `--json` output are accepted as well as the bare plan.
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| PortcoveError::usage(format!("invalid plan file: {error}")))?;
    let plan = value.get("data").cloned().unwrap_or(value);
    serde_json::from_value(plan)
        .map_err(|error| PortcoveError::usage(format!("invalid plan file: {error}")))
}

fn plan_text(plan: &portcove_core::ProviderInstallPlan) -> String {
    let mut lines = vec![
        format!(
            "Review GameBanana install: {} (project {}, file {})",
            clean(&plan.project_name),
            clean(&plan.provider.project),
            clean(&plan.file.file_id)
        ),
        format!(
            "Download: {} bytes, SHA-256 {}",
            plan.download_size,
            clean(&plan.download_sha256)
        ),
    ];
    for member in &plan.members {
        lines.push(format!(
            "  package {} ({} assets, {} bytes, SHA-256 {})",
            clean(&member.file_name),
            member.asset_count,
            member.size,
            clean(&member.sha256)
        ));
    }
    for name in &plan.replaces {
        lines.push(format!("  replaces installed {}", clean(name)));
    }
    for conflict in &plan.conflicts {
        lines.push(format!(
            "  asset {} is provided by {}; {} wins",
            clean(&conflict.path),
            conflict.providers.join(", "),
            clean(&conflict.winner)
        ));
    }
    for claim in &plan.unverified_claims {
        lines.push(format!("  not verified: {}", clean(claim)));
    }
    lines.push(format!("Plan SHA-256: {}", clean(&plan.plan_sha256)));
    lines.join("\n")
}

fn read_request(path: &PathBuf) -> Result<ProfileRevisionRequest> {
    let mut bytes = Vec::new();
    let limit = MAX_REQUEST_BYTES + 1;
    if path.as_os_str() == "-" {
        std::io::stdin().take(limit).read_to_end(&mut bytes)?;
    } else {
        std::fs::File::open(path)?
            .take(limit)
            .read_to_end(&mut bytes)?;
    }
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(PortcoveError::usage("revision request exceeds 256 KiB"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| PortcoveError::usage(format!("invalid revision request: {error}")))
}

pub(crate) async fn execute(
    command: ProfileCommand,
    service: &PortcoveService,
    mode: OutputMode,
    non_interactive: bool,
) -> Result<()> {
    let name = command.name();
    match command {
        ProfileCommand::ProviderPlan {
            port_id,
            profile_id,
            project_id,
            file_id,
        } => {
            let plan = service
                .plan_provider_install(&port_id, &profile_id, project_id, file_id)
                .await?;
            render_read_success(mode, name, plan, plan_text)
        }
        ProfileCommand::ProviderApply {
            port_id,
            profile_id,
            plan_file,
            expected_plan,
            yes,
        } => {
            let plan = read_plan(&plan_file)?;
            if plan.port_id != port_id || plan.profile_id != profile_id {
                return Err(PortcoveError::usage(
                    "the plan was reviewed for a different port or profile",
                ));
            }
            if plan.plan_sha256 != expected_plan {
                return Err(PortcoveError::conflict(
                    "the plan differs from the one you reviewed; review it again",
                ));
            }
            if mode == OutputMode::Human {
                println!("{}", plan_text(&plan));
            }
            crate::require_confirmation(
                "Install exactly these reviewed packages into this profile?",
                yes,
                non_interactive,
            )?;
            let authorization = service.authorize_provider_install(&plan)?;
            render_read_success(
                mode,
                name,
                service.apply_provider_install(&plan, &authorization.token)?,
                |revision| format!("Packages installed\n{}", revision_line(revision)),
            )
        }
        ProfileCommand::List { port_id } => {
            render_read_success(mode, name, service.profile_inventory(&port_id)?, inventory)
        }
        ProfileCommand::EnsureDefault { port_id } => render_read_success(
            mode,
            name,
            service.ensure_default_profile(&port_id)?,
            |profile| summary("Default profile ready", profile),
        ),
        ProfileCommand::Copy {
            port_id,
            source_profile_id,
            name: display,
        } => render_read_success(
            mode,
            name,
            service.copy_profile(&port_id, &source_profile_id, &display)?,
            |profile| summary("Profile created with its own progress", profile),
        ),
        ProfileCommand::Revisions {
            port_id,
            profile_id,
        } => render_read_success(
            mode,
            name,
            service.profile_revisions(&port_id, &profile_id)?,
            |revisions: &Vec<ProfileRevision>| {
                revisions
                    .iter()
                    .map(revision_line)
                    .collect::<Vec<_>>()
                    .join("\n")
            },
        ),
        ProfileCommand::Policy {
            port_id,
            profile_id,
            policy,
        } => render_read_success(
            mode,
            name,
            service.set_profile_update_policy(&port_id, &profile_id, policy.into())?,
            |profile| summary("Update policy saved", profile),
        ),
        ProfileCommand::InstallPackage {
            port_id,
            profile_id,
            file,
            expected_revision,
        } => render_read_success(
            mode,
            name,
            service.install_mod_package(&port_id, &profile_id, &file, expected_revision)?,
            |revision| format!("Package installed\n{}", revision_line(revision)),
        ),
        ProfileCommand::SetPackage {
            port_id,
            profile_id,
            native_id,
            state,
            expected_revision,
        } => render_read_success(
            mode,
            name,
            service.set_mod_package_enabled(
                &port_id,
                &profile_id,
                &native_id,
                matches!(state, ToggleArg::On),
                expected_revision,
            )?,
            |revision| format!("Package state saved\n{}", revision_line(revision)),
        ),
        ProfileCommand::Activate {
            port_id,
            profile_id,
        } => render_read_success(
            mode,
            name,
            service.activate_profile(&port_id, &profile_id)?,
            |revision| format!("Profile active\n{}", revision_line(revision)),
        ),
        ProfileCommand::Live { port_id } => {
            render_read_success(mode, name, service.observe_live_mods(&port_id)?, |live| {
                if live.unmanaged.is_empty() && live.changed_owned.is_empty() {
                    "Live mods match the selected profile.".into()
                } else {
                    format!(
                        "Unmanaged files: {}\nChanged installed files: {}",
                        live.unmanaged.join(", "),
                        live.changed_owned.join(", ")
                    )
                }
            })
        }
        ProfileCommand::Revise {
            port_id,
            profile_id,
            request_file,
        } => {
            let request = read_request(&request_file)?;
            render_read_success(
                mode,
                name,
                service.create_profile_revision(&port_id, &profile_id, &request)?,
                |revision| format!("Revision appended\n{}", revision_line(revision)),
            )
        }
    }
}

fn summary(title: &str, profile: &Profile) -> String {
    format!(
        "{title}\nProfile {} ({}) · revision {} · policy {:?}",
        clean(&profile.id),
        clean(&profile.display_name),
        profile.current_revision,
        profile.intent.update_policy
    )
}

fn revision_line(revision: &ProfileRevision) -> String {
    format!(
        "  revision {} · install {} · {} package(s) · digest {}",
        revision.revision,
        clean(&revision.build.install_id),
        revision.packages.len(),
        clean(&revision.digest)
    )
}

fn inventory(value: &ProfileInventory) -> String {
    if value.profiles.is_empty() {
        return "No profiles yet. `profile ensure-default` creates the default from the installed game."
            .into();
    }
    let mut lines = Vec::new();
    for view in &value.profiles {
        lines.push(summary(
            if view.profile.is_default {
                "Default profile"
            } else {
                "Profile"
            },
            &view.profile,
        ));
        lines.push(revision_line(&view.revision));
        for original in &view.originals {
            let state = match original.availability {
                OriginalAvailability::Verified => "verified",
                OriginalAvailability::Missing => "missing",
                OriginalAvailability::Changed => "changed",
            };
            lines.push(format!(
                "  original {}: {state}",
                clean(&original.binding.requirement_id)
            ));
        }
    }
    lines.join("\n")
}
