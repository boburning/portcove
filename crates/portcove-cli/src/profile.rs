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
    /// Show whether a game supports mod setups, its setups and what is live now.
    Setups {
        /// Catalog port ID.
        port_id: String,
    },
    /// Export a profile revision as a shareable recipe: identity only, no files or saves.
    RecipeExport {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// Revision to export; the current revision when omitted.
        #[arg(long)]
        revision: Option<u64>,
    },
    /// Inspect a recipe file locally; it grants no authority and needs no account.
    RecipeInspect {
        /// Recipe JSON file (`profile recipe-export` output).
        recipe_file: PathBuf,
    },
    /// Plan importing a recipe: reports each input as available, acquirable or unavailable.
    RecipePlan {
        /// Recipe JSON file.
        recipe_file: PathBuf,
    },
    /// Create a new profile from a recipe when every input is already present.
    RecipeApply {
        /// Recipe JSON file.
        recipe_file: PathBuf,
        /// Name for the new profile.
        #[arg(long)]
        name: String,
        /// `plan_sha256` from `profile recipe-plan`; changed inputs refuse.
        #[arg(long)]
        expected_plan: String,
        /// Confirm without a prompt; the digest check still applies.
        #[arg(long)]
        yes: bool,
    },
    /// Browse a game's GameBanana mods, most downloaded first; reads only.
    ProviderBrowse {
        /// Catalog port ID with a reviewed GameBanana binding.
        port_id: String,
        /// Page number, from 1.
        #[arg(long, default_value_t = 1)]
        page: u32,
    },
    /// Show one GameBanana mod's files and the IDs `provider-plan` takes; reads only.
    ProviderProject {
        /// Catalog port ID with a reviewed GameBanana binding.
        port_id: String,
        /// GameBanana Mod ID from `provider-browse`.
        project_id: u64,
    },
    /// Check installed GameBanana packages for newer files, same-version changes or removals.
    ProviderUpdates {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
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
            Self::Setups { .. } => "profile.setups",
            Self::RecipeExport { .. } => "profile.recipe-export",
            Self::RecipeInspect { .. } => "profile.recipe-inspect",
            Self::RecipePlan { .. } => "profile.recipe-plan",
            Self::RecipeApply { .. } => "profile.recipe-apply",
            Self::ProviderBrowse { .. } => "profile.provider-browse",
            Self::ProviderProject { .. } => "profile.provider-project",
            Self::ProviderUpdates { .. } => "profile.provider-updates",
            Self::ProviderPlan { .. } => "profile.provider-plan",
            Self::ProviderApply { .. } => "profile.provider-apply",
        }
    }

    pub(crate) fn mutates(&self) -> bool {
        !matches!(
            self,
            Self::List { .. }
                | Self::Revisions { .. }
                | Self::Live { .. }
                | Self::Setups { .. }
                | Self::RecipeExport { .. }
                | Self::RecipeInspect { .. }
                | Self::RecipePlan { .. }
                | Self::ProviderBrowse { .. }
                | Self::ProviderProject { .. }
                | Self::ProviderUpdates { .. }
        )
    }
}

fn live_text(live: &portcove_core::LiveMods) -> String {
    let native = match &live.native_list {
        portcove_core::NativeModListStatus::NotApplicable
        | portcove_core::NativeModListStatus::InSync => None,
        portcove_core::NativeModListStatus::NotWritten => {
            Some("The game's mod list is written before the next launch.".to_owned())
        }
        portcove_core::NativeModListStatus::Reordered { native_order } => Some(format!(
            "Mods were reordered in the game: {}",
            native_order
                .iter()
                .map(|name| clean(name))
                .collect::<Vec<_>>()
                .join(", ")
        )),
        portcove_core::NativeModListStatus::Differs {
            missing,
            unexpected,
        } => Some(format!(
            "The game's mod list differs (missing: {}; not enabled: {}); it is rewritten before the next launch.",
            missing
                .iter()
                .map(|name| clean(name))
                .collect::<Vec<_>>()
                .join(", "),
            unexpected
                .iter()
                .map(|name| clean(name))
                .collect::<Vec<_>>()
                .join(", ")
        )),
        portcove_core::NativeModListStatus::Unreadable { reason } => Some(format!(
            "The game's configuration could not be read and is left unchanged: {}",
            clean(reason)
        )),
    };
    let mut lines = Vec::new();
    if live.unmanaged.is_empty() && live.changed_owned.is_empty() {
        lines.push("Live mods match the selected profile.".to_owned());
    } else {
        lines.push(format!(
            "Unmanaged files: {}\nChanged installed files: {}",
            live.unmanaged.join(", "),
            live.changed_owned.join(", ")
        ));
    }
    lines.extend(native);
    lines.join("\n")
}

fn read_recipe(path: &PathBuf) -> Result<portcove_core::ProfileRecipe> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    portcove_core::ProfileRecipe::inspect_document(&bytes)
}

fn recipe_text(title: &str, recipe: &portcove_core::ProfileRecipe) -> String {
    let mut lines = vec![format!(
        "{title}: {} (format {}), {} package(s), identity {}",
        clean(&recipe.port_id),
        recipe.format,
        recipe.packages.len(),
        clean(&recipe.identity_sha256)
    )];
    lines.extend(
        recipe
            .uncaptured
            .iter()
            .map(|line| format!("  not captured: {}", clean(line))),
    );
    lines.join("\n")
}

fn recipe_plan_text(plan: &portcove_core::RecipeImportPlan) -> String {
    let status = |value: &portcove_core::RecipeInputPlan| {
        format!(
            "  {} — {:?}: {}",
            clean(&value.name),
            value.status,
            clean(&value.detail)
        )
    };
    let mut lines = vec![format!(
        "Recipe import plan for {}",
        clean(&plan.recipe.port_id)
    )];
    lines.push(status(&plan.runtime));
    lines.extend(plan.originals.iter().map(status));
    lines.extend(plan.packages.iter().map(status));
    for hold in &plan.holds {
        lines.push(format!("  held: {}", clean(hold)));
    }
    lines.push(format!(
        "{} · plan SHA-256 {}",
        if plan.can_apply {
            "Ready to apply"
        } else {
            "Not ready"
        },
        clean(&plan.plan_sha256)
    ));
    lines.join("\n")
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

fn stale_note(freshness: portcove_core::ProviderFreshness, observed_at: i64) -> Option<String> {
    (freshness == portcove_core::ProviderFreshness::Stale).then(|| {
        format!(
            "GameBanana couldn't be reached, so this is earlier data from {}.",
            crate::human::utc_time(observed_at)
        )
    })
}

pub(crate) fn provider_browse_text(result: &portcove_core::ProviderBrowsePage) -> String {
    let page = &result.page;
    let total = if page.total == 0 && !page.projects.is_empty() {
        "total unknown".to_owned()
    } else {
        format!("{} in total", page.total)
    };
    let mut lines = vec![format!(
        "GameBanana mods for {}, page {} ({total}, most downloaded first)",
        clean(&result.game_name),
        page.page
    )];
    lines.extend(stale_note(result.freshness, result.observed_at));
    if page.projects.is_empty() {
        lines.push("No mods on this page.".into());
    }
    for project in &page.projects {
        lines.push(format!(
            "  {} — {}{}",
            clean(&project.project_id),
            clean(&project.name),
            project
                .version
                .as_deref()
                .map(|version| format!(" ({})", clean(version)))
                .unwrap_or_default()
        ));
    }
    if !page.complete && !page.projects.is_empty() {
        if page.page < result.last_page {
            lines.push(format!(
                "More mods: `portcove profile provider-browse {} --page {}`.",
                clean(&result.port_id),
                page.page + 1
            ));
        } else {
            lines.push("More mods are listed on GameBanana itself.".into());
        }
    }
    if !page.projects.is_empty() {
        lines.push(format!(
            "See a mod's files: `portcove profile provider-project {} MOD_ID`.",
            clean(&result.port_id)
        ));
    }
    lines.join("\n")
}

pub(crate) fn provider_project_text(view: &portcove_core::ProviderProjectView) -> String {
    let project = &view.project;
    let mut lines = vec![format!(
        "{} — GameBanana mod {} for {}",
        clean(&project.name),
        clean(&project.project_id),
        clean(&view.game_name)
    )];
    let stale = stale_note(view.freshness, view.observed_at);
    lines.extend(stale.clone());
    if project.obsolete {
        lines.push("Its author marked it obsolete, so Portcove won't install it.".into());
    }
    if project.files.is_empty() {
        lines.push("This mod has no files Portcove can list.".into());
    }
    for file in &project.files {
        lines.push(format!(
            "  file {} — {} ({}){}{}",
            clean(&file.file_id),
            clean(&file.file_name),
            crate::human::format_bytes(file.size),
            if file.archived {
                "; archived, so it can't be installed"
            } else {
                ""
            },
            file.claimed_scan
                .as_deref()
                .map(|scan| format!("; GameBanana's scan says {} (not verified)", clean(scan)))
                .unwrap_or_default()
        ));
    }
    if project.unreadable_files > 0 {
        lines.push(format!(
            "{} more file(s) on GameBanana couldn't be read safely and aren't listed.",
            project.unreadable_files
        ));
    }
    let installable = !project.obsolete && project.files.iter().any(|file| !file.archived);
    if stale.is_some() {
        lines.push("Try again when GameBanana can be reached before reviewing a file.".into());
    } else if installable {
        lines.push(format!(
            "Review a file for a setup: `portcove profile provider-plan {} PROFILE_ID {} FILE_ID`.",
            clean(&view.port_id),
            clean(&project.project_id)
        ));
    }
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
        ProfileCommand::ProviderBrowse { port_id, page } => {
            let result = service.browse_provider_mods(&port_id, page).await?;
            render_read_success(mode, name, result, provider_browse_text)
        }
        ProfileCommand::ProviderProject {
            port_id,
            project_id,
        } => {
            let view = service.provider_project(&port_id, project_id).await?;
            render_read_success(mode, name, view, provider_project_text)
        }
        ProfileCommand::ProviderUpdates {
            port_id,
            profile_id,
        } => {
            let updates = service
                .check_provider_updates(&port_id, &profile_id)
                .await?;
            render_read_success(mode, name, updates, |updates| {
                if updates.is_empty() {
                    return "No installed package came from a provider.".into();
                }
                updates
                    .iter()
                    .map(|update| {
                        let candidates = update
                            .newer_files
                            .iter()
                            .map(|file| clean(&file.file_id))
                            .collect::<Vec<_>>()
                            .join(", ");
                        format!(
                            "{}: {:?}{}{}",
                            clean(&update.native_id),
                            update.state,
                            if candidates.is_empty() {
                                String::new()
                            } else {
                                format!(" (candidate files: {candidates})")
                            },
                            update
                                .reason
                                .as_deref()
                                .map(|reason| format!(" — {}", clean(reason)))
                                .unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }
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
            render_read_success(mode, name, service.observe_live_mods(&port_id)?, live_text)
        }
        ProfileCommand::Setups { port_id } => {
            render_read_success(mode, name, service.mod_setups(&port_id)?, |view| {
                if !view.supported {
                    return "This game has no reviewed mod support.".into();
                }
                let Some(inventory) = &view.inventory else {
                    return "No setups yet; the installed game gets its default setup first."
                        .into();
                };
                let mut lines = inventory
                    .profiles
                    .iter()
                    .map(|entry| {
                        format!(
                            "{} ({}) revision {}",
                            clean(&entry.profile.display_name),
                            clean(&entry.profile.id),
                            entry.profile.current_revision
                        )
                    })
                    .collect::<Vec<_>>();
                if let Some(live) = &view.live {
                    lines.push(live_text(live));
                }
                lines.join("\n")
            })
        }
        ProfileCommand::RecipeExport {
            port_id,
            profile_id,
            revision,
        } => render_read_success(
            mode,
            name,
            service.export_profile_recipe(&port_id, &profile_id, revision)?,
            |recipe| recipe_text("Recipe", recipe),
        ),
        ProfileCommand::RecipeInspect { recipe_file } => {
            render_read_success(mode, name, read_recipe(&recipe_file)?, |recipe| {
                recipe_text("Valid recipe", recipe)
            })
        }
        ProfileCommand::RecipePlan { recipe_file } => render_read_success(
            mode,
            name,
            service.plan_recipe_import(&read_recipe(&recipe_file)?)?,
            recipe_plan_text,
        ),
        ProfileCommand::RecipeApply {
            recipe_file,
            name: display_name,
            expected_plan,
            yes,
        } => {
            let plan = service.plan_recipe_import(&read_recipe(&recipe_file)?)?;
            if plan.plan_sha256 != expected_plan {
                return Err(PortcoveError::conflict(
                    "the local inputs differ from the plan you reviewed; plan again",
                ));
            }
            if mode == OutputMode::Human {
                println!("{}", recipe_plan_text(&plan));
            }
            crate::require_confirmation(
                "Create a new profile from exactly these reviewed inputs?",
                yes,
                non_interactive,
            )?;
            let authorization = service.authorize_recipe_import(&plan, &display_name)?;
            render_read_success(
                mode,
                name,
                service.apply_recipe_import(&plan, &display_name, &authorization.token)?,
                |profile| summary("Profile created from recipe", profile),
            )
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

#[cfg(test)]
mod provider_text_tests {
    use super::*;
    use portcove_core::{
        ProviderBrowsePage, ProviderFileCandidate, ProviderFreshness, ProviderPage,
        ProviderProject, ProviderProjectView,
    };

    fn project(obsolete: bool, unreadable: u32, archived: bool) -> ProviderProject {
        ProviderProject {
            provider: "gamebanana".into(),
            project_id: "42".into(),
            name: "HD Link".into(),
            version: Some("2.0".into()),
            game_id: Some("16121".into()),
            updated_at: 5,
            obsolete,
            profile_url: String::new(),
            submitter: None,
            files: vec![ProviderFileCandidate {
                file_id: "10".into(),
                file_name: "pack.zip".into(),
                size: 2048,
                added_at: 4,
                download_url: String::new(),
                claimed_md5: None,
                archived,
                claimed_scan: Some("clean".into()),
            }],
            unreadable_files: unreadable,
        }
    }

    fn view(project: ProviderProject, freshness: ProviderFreshness) -> ProviderProjectView {
        ProviderProjectView {
            port_id: "shipwright".into(),
            game_name: "Ship of Harkinian".into(),
            project,
            observed_at: 0,
            freshness,
        }
    }

    #[test]
    fn project_text_states_stale_data_unlisted_files_and_only_runnable_next_steps() {
        let fresh =
            provider_project_text(&view(project(false, 0, false), ProviderFreshness::Fresh));
        assert!(fresh.contains("Ship of Harkinian"));
        assert!(fresh.contains("provider-plan shipwright PROFILE_ID 42 FILE_ID"));
        assert!(!fresh.contains("bytes)"), "sizes are readable: {fresh}");

        let stale =
            provider_project_text(&view(project(false, 2, false), ProviderFreshness::Stale));
        assert!(stale.contains("earlier data"));
        assert!(stale.contains("2 more file(s)"));
        assert!(!stale.contains("provider-plan"), "no plan from outage data");

        let obsolete =
            provider_project_text(&view(project(true, 0, true), ProviderFreshness::Fresh));
        assert!(obsolete.contains("marked it obsolete"));
        assert!(obsolete.contains("archived"));
        assert!(!obsolete.contains("provider-plan"));
    }

    #[test]
    fn browse_text_shows_empty_pages_unknown_totals_and_stops_at_the_last_page() {
        let page = |projects: Vec<ProviderProject>, total, number, complete| ProviderBrowsePage {
            port_id: "shipwright".into(),
            game_name: "Ship of Harkinian".into(),
            last_page: 50,
            provider: "gamebanana".into(),
            page: ProviderPage {
                projects,
                total,
                page: number,
                complete,
            },
            observed_at: 0,
            freshness: ProviderFreshness::Fresh,
        };
        let empty = provider_browse_text(&page(Vec::new(), 41, 4, false));
        assert!(empty.contains("No mods on this page."));
        assert!(!empty.contains("--page 5"));
        let unknown = provider_browse_text(&page(vec![project(false, 0, false)], 0, 1, false));
        assert!(unknown.contains("total unknown"));
        assert!(unknown.contains("provider-browse shipwright --page 2"));
        let last = provider_browse_text(&page(vec![project(false, 0, false)], 1000, 50, false));
        assert!(!last.contains("--page 51"));
        assert!(last.contains("GameBanana itself"));
    }
}
