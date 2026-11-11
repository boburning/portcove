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
        }
    }

    pub(crate) fn mutates(&self) -> bool {
        !matches!(self, Self::List { .. } | Self::Revisions { .. })
    }
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

pub(crate) fn execute(
    command: ProfileCommand,
    service: &PortcoveService,
    mode: OutputMode,
) -> Result<()> {
    let name = command.name();
    match command {
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
