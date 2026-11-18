//! CLI presentation for Core-owned local profiles and their immutable revisions.
//! Core owns identity, validation, retention and recovery; this adapter parses
//! arguments and renders the same decisions Desktop consumes.
use std::{io::Read, path::PathBuf};

use clap::{Subcommand, ValueEnum};
use portcove_core::{
    OriginalAvailability, PortcoveError, PortcoveService, Profile, ProfileInventory,
    ProfileProgressCopy, ProfileRecoveryPlan, ProfileRevision, ProfileRevisionRequest,
    ProfileUpdatePolicy, Result,
};

use crate::{
    OutputMode,
    human::{clean, mod_update_outcome, utc_time},
    render_read_success,
};

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
        /// Use the game's current installation instead of the source profile's
        /// build; the source profile keeps its own build and progress.
        #[arg(long)]
        current_build: bool,
        /// Copy supported progress from this reviewed source revision digest.
        #[arg(long, requires_all = ["progress_target_install", "progress_target_revision"])]
        progress_from_revision: Option<String>,
        /// Exact destination installation ID reviewed for the progress copy.
        #[arg(long, requires = "progress_from_revision")]
        progress_target_install: Option<String>,
        /// Digest of the reviewed destination revision (Default with --current-build).
        #[arg(long, requires = "progress_from_revision")]
        progress_target_revision: Option<String>,
    },
    /// Create a named setup on the source runtime with fresh progress and no added mods.
    CreateClean {
        /// Catalog port ID owning the source setup.
        port_id: String,
        /// Source setup ID from `profile list`.
        source_profile_id: String,
        /// Display name for the new clean setup.
        name: String,
        /// Exact source revision shown when you reviewed the setup's runtime.
        #[arg(long)]
        expected_revision: u64,
    },
    /// Show every immutable revision of one profile, oldest first.
    Revisions {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
    },
    /// List admitted saved originals for this setup's exact runtime.
    OriginalInstances {
        /// Catalog port ID owning the setup.
        port_id: String,
        /// Setup ID from `profile list`.
        profile_id: String,
        /// Original source requirement ID from this setup's originals.
        requirement_id: String,
    },
    /// Choose one saved original for a customized setup.
    SelectOriginal {
        /// Catalog port ID owning the setup.
        port_id: String,
        /// Customized setup ID from `profile list`.
        profile_id: String,
        /// Original source requirement ID from this setup's originals.
        requirement_id: String,
        /// Exact instance ID from `profile original-instances`.
        instance_id: String,
        /// Setup revision whose originals you reviewed.
        #[arg(long)]
        expected_revision: u64,
    },
    /// Link the same original in a new location without changing the setup.
    RelinkOriginal {
        /// Catalog port ID owning the setup.
        port_id: String,
        /// Customized setup ID from `profile list`.
        profile_id: String,
        /// Original source requirement ID from this setup's originals.
        requirement_id: String,
        /// New path to the same original, verified before its location is updated.
        path: PathBuf,
        /// Setup revision that recorded the original you are finding.
        #[arg(long)]
        expected_revision: u64,
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
        /// Allow a mod that runs its own code inside the game, for exactly the
        /// package with this SHA-256 (shown when the install is refused). Records
        /// your choice; it does not establish that the code is safe.
        #[arg(long, value_name = "SHA256")]
        allow_mod_code: Option<String>,
    },
    /// Review a local file and its effects in the specified setup.
    PackagePlan {
        /// Catalog port ID for the game.
        port_id: String,
        /// Setup ID shown by `profile setups`.
        profile_id: String,
        /// Local package file to inspect.
        path: PathBuf,
        /// Current setup revision shown by `profile setups`.
        #[arg(long)]
        expected_revision: u64,
    },
    /// Add a local file after the exact package review.
    PackageApply {
        /// Catalog port ID used in the package review.
        port_id: String,
        /// Setup ID used in the package review.
        profile_id: String,
        /// The same local package file read by `profile package-plan`.
        path: PathBuf,
        /// SHA-256 from `profile package-plan` for this file and setup.
        #[arg(long)]
        expected_plan: String,
        /// Allow the exact reviewed mod code to run inside the game.
        #[arg(long)]
        allow_mod_code: bool,
        /// Confirm applying the reviewed changes without a prompt.
        #[arg(long)]
        yes: bool,
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
    /// Remove a package from this setup while preserving its earlier revisions.
    RemovePackage {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// Package native ID shown by `profile list`.
        native_id: String,
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
    /// Inspect one unmanaged or edited mod file from profile live.
    InspectModFile {
        /// Catalog port ID.
        port_id: String,
        /// Exact file name in the mods folder, as reported by profile live.
        file_name: String,
    },
    /// Move a reviewed mod file out of the live folder.
    PreserveModFile {
        /// Catalog port ID.
        port_id: String,
        /// Exact file name named by the inspection.
        file_name: String,
        /// Plan SHA-256 reported by profile inspect-mod-file.
        #[arg(long)]
        expected_plan: String,
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
    /// Review one exact provider file required by a recipe in private staging.
    RecipeAcquire {
        /// Recipe JSON file.
        recipe_file: PathBuf,
        /// Existing setup used for the provider review.
        review_profile_id: String,
        /// Exact native package ID named by the recipe.
        native_id: String,
        /// Earlier JSON results from profile recipe-acquire, repeatable.
        #[arg(long = "acquisition")]
        acquisitions: Vec<PathBuf>,
    },
    /// Discard one exact private provider review.
    RecipeDiscard {
        /// JSON result from profile recipe-acquire.
        acquisition: PathBuf,
    },
    /// Check the exact local or privately reviewed inputs of a recipe.
    RecipePlan {
        /// Recipe JSON file.
        recipe_file: PathBuf,
        /// JSON result from profile recipe-acquire, repeatable.
        #[arg(long = "acquisition")]
        acquisitions: Vec<PathBuf>,
    },
    /// Create a new profile from the exact reviewed recipe inputs.
    RecipeApply {
        /// Recipe JSON file.
        recipe_file: PathBuf,
        /// Name for the new profile.
        #[arg(long)]
        name: String,
        /// `plan_sha256` from `profile recipe-plan`; changed inputs refuse.
        #[arg(long)]
        expected_plan: String,
        /// JSON result from profile recipe-acquire, repeatable.
        #[arg(long = "acquisition")]
        acquisitions: Vec<PathBuf>,
        /// Allow the exact mod code listed in the reviewed plan.
        #[arg(long)]
        allow_mod_code: bool,
        /// Confirm without a prompt; the digest check still applies.
        #[arg(long)]
        yes: bool,
    },
    /// Browse a game's mods on its reviewed provider (GameBanana or Thunderstore); reads only.
    ProviderBrowse {
        /// Catalog port ID with a reviewed provider binding.
        port_id: String,
        /// Page number, from 1.
        #[arg(long, default_value_t = 1)]
        page: u32,
        /// Reviewed provider when the port offers more than one.
        #[arg(long)]
        provider: Option<String>,
    },
    /// Show one mod's files or versions and the IDs `provider-plan` takes; reads only.
    ProviderProject {
        /// Catalog port ID with a reviewed provider binding.
        port_id: String,
        /// Mod ID from `provider-browse`: a GameBanana number or a Thunderstore NAMESPACE-NAME.
        project_id: String,
        /// Reviewed provider when the port offers more than one.
        #[arg(long)]
        provider: Option<String>,
    },
    /// Check installed provider packages for newer files, same-version changes or removals.
    ProviderUpdates {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
    },
    /// Review one provider file for a profile: downloads privately, inspects, prints the plan.
    ProviderPlan {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// Mod ID: a GameBanana number or a Thunderstore NAMESPACE-NAME.
        project_id: String,
        /// A GameBanana file ID or a Thunderstore version, from `provider-project`.
        file_id: String,
        /// Reviewed provider when the port offers more than one.
        #[arg(long)]
        provider: Option<String>,
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
        /// Allow the code of packages the plan reports as running code inside the game,
        /// for exactly the reviewed bytes. Records your choice; not a safety claim.
        #[arg(long)]
        allow_mod_code: bool,
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
    /// Review an earlier setup revision and the current progress it will keep.
    RecoverPlan {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// Earlier revision from `profile revisions`.
        revision: u64,
    },
    /// Apply an exact recovery review and keep the setup's current progress.
    Recover {
        /// Catalog port ID owning the profile.
        port_id: String,
        /// Profile ID from `profile list`.
        profile_id: String,
        /// Earlier revision from `profile revisions`.
        revision: u64,
        /// `plan_sha256` from `profile recover-plan`.
        #[arg(long)]
        expected_plan: String,
        /// Confirm without a prompt. The digest and hold checks still apply.
        #[arg(long)]
        yes: bool,
    },
}

impl ProfileCommand {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::List { .. } => "profile.list",
            Self::EnsureDefault { .. } => "profile.ensure-default",
            Self::Copy { .. } => "profile.copy",
            Self::CreateClean { .. } => "profile.create-clean",
            Self::Revisions { .. } => "profile.revisions",
            Self::OriginalInstances { .. } => "profile.original-instances",
            Self::SelectOriginal { .. } => "profile.select-original",
            Self::RelinkOriginal { .. } => "profile.relink-original",
            Self::Policy { .. } => "profile.policy",
            Self::Revise { .. } => "profile.revise",
            Self::RecoverPlan { .. } => "profile.recover-plan",
            Self::Recover { .. } => "profile.recover",
            Self::InstallPackage { .. } => "profile.install-package",
            Self::PackagePlan { .. } => "profile.package-plan",
            Self::PackageApply { .. } => "profile.package-apply",
            Self::SetPackage { .. } => "profile.set-package",
            Self::RemovePackage { .. } => "profile.remove-package",
            Self::Activate { .. } => "profile.activate",
            Self::Live { .. } => "profile.live",
            Self::InspectModFile { .. } => "profile.inspect-mod-file",
            Self::PreserveModFile { .. } => "profile.preserve-mod-file",
            Self::Setups { .. } => "profile.setups",
            Self::RecipeExport { .. } => "profile.recipe-export",
            Self::RecipeInspect { .. } => "profile.recipe-inspect",
            Self::RecipeAcquire { .. } => "profile.recipe-acquire",
            Self::RecipeDiscard { .. } => "profile.recipe-discard",
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
                | Self::OriginalInstances { .. }
                | Self::Live { .. }
                | Self::InspectModFile { .. }
                | Self::Setups { .. }
                | Self::PackagePlan { .. }
                | Self::RecipeExport { .. }
                | Self::RecipeInspect { .. }
                | Self::RecipePlan { .. }
                | Self::ProviderBrowse { .. }
                | Self::ProviderProject { .. }
                | Self::ProviderUpdates { .. }
                | Self::RecoverPlan { .. }
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
    if let Some(plan) = &live.pending_preservation {
        lines.push(format!(
            "File preservation is pending for {}. Finish it with profile preserve-mod-file and review SHA-256 {}.",
            clean(&plan.file_name), plan.plan_sha256,
        ));
    } else if live.unmanaged.is_empty() && live.changed_owned.is_empty() {
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
    portcove_core::ProfileRecipe::read_file(path)
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
    for approval in &plan.code_approval {
        lines.push(format!(
            "Code permission needed for {} (SHA-256 {})",
            clean(&approval.native_id),
            clean(&approval.sha256),
        ));
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

fn read_plan<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Result<T> {
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

/// A provider's name for people, from its recorded identity.
fn provider_label(provider: &str) -> &str {
    match provider {
        "gamebanana" => "GameBanana",
        "thunderstore" => "Thunderstore",
        other => other,
    }
}

/// What the provider calls one downloadable item of a mod.
fn file_noun(provider: &str) -> &'static str {
    if provider == "thunderstore" {
        "version"
    } else {
        "file"
    }
}

fn plan_text(plan: &portcove_core::ProviderInstallPlan) -> String {
    let provider = plan.provider.provider.as_str();
    let mut lines = vec![
        format!(
            "Review {} install: {} (project {}, {} {})",
            provider_label(provider),
            clean(&plan.project_name),
            clean(&plan.provider.project),
            file_noun(provider),
            clean(&plan.file.file_id)
        ),
        format!(
            "Download: {} bytes, SHA-256 {}",
            plan.download_size,
            clean(&plan.download_sha256)
        ),
    ];
    if plan.wrappers.len() > 1 {
        for wrapper in &plan.wrappers {
            lines.push(format!(
                "  {} {} ({} bytes, SHA-256 {}): {}",
                clean(&wrapper.provider.project),
                clean(&wrapper.file.file_id),
                wrapper.download_size,
                clean(&wrapper.download_sha256),
                wrapper
                    .members
                    .keys()
                    .map(|id| clean(id))
                    .collect::<Vec<_>>()
                    .join(", "),
            ));
        }
    }
    for member in &plan.members {
        lines.push(format!(
            "  package {} ({} assets, {} bytes, SHA-256 {}){}",
            clean(&member.file_name),
            member.asset_count,
            member.size,
            clean(&member.sha256),
            if member.runs_code.is_empty() {
                ""
            } else {
                "; runs its own code inside the game"
            }
        ));
    }
    if plan
        .members
        .iter()
        .any(|member| !member.runs_code.is_empty())
    {
        lines.push(
            "This file includes a mod that runs its own code. Portcove can't tell whether that code is safe; apply with `--allow-mod-code` only if you trust where it came from.".into(),
        );
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

fn stale_note(
    provider: &str,
    freshness: portcove_core::ProviderFreshness,
    observed_at: i64,
) -> Option<String> {
    (freshness == portcove_core::ProviderFreshness::Stale).then(|| {
        format!(
            "{} couldn't be reached, so this is earlier data from {}.",
            provider_label(provider),
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
    let provider = provider_label(&result.provider);
    let order = if result.provider == "thunderstore" {
        "in Thunderstore's order"
    } else {
        "most downloaded first"
    };
    let mut lines = vec![format!(
        "{provider} mods for {}, page {} ({total}, {order})",
        clean(&result.game_name),
        page.page
    )];
    lines.extend(stale_note(
        &result.provider,
        result.freshness,
        result.observed_at,
    ));
    if page.projects.is_empty() {
        lines.push("No mods on this page.".into());
    }
    match result.other_game_records {
        0 => {}
        1 => lines.push(format!(
            "1 mod {provider} labels as another game isn't listed."
        )),
        count => lines.push(format!(
            "{count} mods {provider} labels as another game aren't listed."
        )),
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
            lines.push(format!("More mods are listed on {provider} itself."));
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
    let provider = provider_label(&project.provider);
    let noun = file_noun(&project.provider);
    let mut lines = vec![format!(
        "{} — {provider} mod {} for {}",
        clean(&project.name),
        clean(&project.project_id),
        clean(&view.game_name)
    )];
    let stale = stale_note(&project.provider, view.freshness, view.observed_at);
    lines.extend(stale.clone());
    if project.status_unknown.is_some() {
        lines.push("The provider did not confirm this mod's availability. Check its project page and then refresh the listing.".into());
    } else if project.obsolete {
        lines.push("Its author marked it obsolete, so Portcove won't install it.".into());
    }
    if project.files.is_empty() {
        lines.push("This mod has no files Portcove can list.".into());
    }
    for file in &project.files {
        lines.push(format!(
            "  {noun} {} — {} ({}){}{}",
            clean(&file.file_id),
            clean(&file.file_name),
            crate::human::format_bytes(file.size),
            match (file.status_unknown, file.archived, noun) {
                (Some(_), _, _) =>
                    "; availability unknown, refresh the listing before reviewing it",
                (None, false, _) => "",
                (None, true, "version") => "; no longer offered, so it can't be installed",
                (None, true, _) => "; archived, so it can't be installed",
            },
            file.claimed_scan
                .as_deref()
                .map(|scan| format!("; {provider}'s scan says {} (not verified)", clean(scan)))
                .unwrap_or_default()
        ));
    }
    match project.unreadable_files {
        0 => {}
        1 => lines.push(format!(
            "1 more {noun} on {provider} couldn't be read safely and isn't listed."
        )),
        count => lines.push(format!(
            "{count} more {noun}s on {provider} couldn't be read safely and aren't listed."
        )),
    }
    let installable = !project.obsolete
        && project.status_unknown.is_none()
        && project
            .files
            .iter()
            .any(|file| !file.archived && file.status_unknown.is_none());
    if stale.is_some() {
        lines.push(format!(
            "Try again when {provider} can be reached before reviewing a {noun}."
        ));
    } else if installable {
        lines.push(format!(
            "Review a {noun} for a setup: `portcove profile provider-plan {} PROFILE_ID {} {}`.",
            clean(&view.port_id),
            clean(&project.project_id),
            if noun == "version" {
                "VERSION"
            } else {
                "FILE_ID"
            }
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
        ProfileCommand::ProviderBrowse {
            port_id,
            page,
            provider,
        } => {
            let result = service
                .browse_provider_mods_for_provider(&port_id, page, provider.as_deref())
                .await?;
            render_read_success(mode, name, result, provider_browse_text)
        }
        ProfileCommand::ProviderProject {
            port_id,
            project_id,
            provider,
        } => {
            let view = service
                .provider_project_for_provider(&port_id, &project_id, provider.as_deref())
                .await?;
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
            provider,
        } => {
            let plan = service
                .plan_provider_install_for_provider(
                    &port_id,
                    &profile_id,
                    &project_id,
                    &file_id,
                    provider.as_deref(),
                )
                .await?;
            render_read_success(mode, name, plan, plan_text)
        }
        ProfileCommand::ProviderApply {
            port_id,
            profile_id,
            plan_file,
            expected_plan,
            allow_mod_code,
            yes,
        } => {
            let plan = read_plan::<portcove_core::ProviderInstallPlan>(&plan_file)?;
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
            let authorization = if allow_mod_code {
                service.authorize_provider_install_allowing_code(&plan)?
            } else {
                service.authorize_provider_install(&plan)?
            };
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
            current_build,
            progress_from_revision,
            progress_target_install,
            progress_target_revision,
        } => render_read_success(
            mode,
            name,
            if let Some(((source_revision_sha256, target_install_id), target_revision_sha256)) =
                progress_from_revision
                    .zip(progress_target_install)
                    .zip(progress_target_revision)
            {
                service.copy_profile_with_progress(
                    &port_id,
                    &source_profile_id,
                    &display,
                    current_build,
                    &ProfileProgressCopy {
                        source_revision_sha256,
                        target_install_id,
                        target_revision_sha256,
                    },
                )?
            } else if current_build {
                service.copy_profile_onto_current_build(&port_id, &source_profile_id, &display)?
            } else {
                service.copy_profile(&port_id, &source_profile_id, &display)?
            },
            |profile| summary("Profile created with its own progress", profile),
        ),
        ProfileCommand::CreateClean {
            port_id,
            source_profile_id,
            name: display,
            expected_revision,
        } => render_read_success(
            mode,
            name,
            service.create_clean_profile(
                &port_id,
                &source_profile_id,
                &display,
                expected_revision,
            )?,
            |profile| summary("Clean setup created with fresh progress", profile),
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
        ProfileCommand::OriginalInstances {
            port_id,
            profile_id,
            requirement_id,
        } => render_read_success(
            mode,
            name,
            service.profile_original_instances(&port_id, &profile_id, &requirement_id)?,
            |instances| {
                if instances.is_empty() {
                    return "No saved originals for this requirement".into();
                }
                instances
                    .iter()
                    .map(|instance| {
                        format!(
                            "{}  {}",
                            instance.instance_id,
                            clean(&instance.path.display().to_string())
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            },
        ),
        ProfileCommand::SelectOriginal {
            port_id,
            profile_id,
            requirement_id,
            instance_id,
            expected_revision,
        } => render_read_success(
            mode,
            name,
            service.select_profile_original(
                &port_id,
                &profile_id,
                expected_revision,
                &requirement_id,
                &instance_id,
            )?,
            |revision| format!("Saved original selected\n{}", revision_line(revision)),
        ),
        ProfileCommand::RelinkOriginal {
            port_id,
            profile_id,
            requirement_id,
            path,
            expected_revision,
        } => render_read_success(
            mode,
            name,
            service.relink_profile_original(
                &port_id,
                &profile_id,
                expected_revision,
                &requirement_id,
                &path,
            )?,
            |instance| {
                format!(
                    "Saved original relinked to {}",
                    clean(&instance.path.display().to_string())
                )
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
            allow_mod_code,
        } => render_read_success(
            mode,
            name,
            match allow_mod_code {
                Some(sha256) => service.install_mod_package_allowing_code(
                    &port_id,
                    &profile_id,
                    &file,
                    expected_revision,
                    &sha256,
                )?,
                None => {
                    service.install_mod_package(&port_id, &profile_id, &file, expected_revision)?
                }
            },
            |revision| format!("Package installed\n{}", revision_line(revision)),
        ),
        ProfileCommand::PackagePlan {
            port_id,
            profile_id,
            path,
            expected_revision,
        } => {
            let plan =
                service.plan_local_mod_package(&port_id, &profile_id, &path, expected_revision)?;
            render_read_success(mode, name, plan, |plan| {
                let mut lines = vec![format!(
                    "{} · {} asset(s) · plan SHA-256 {}",
                    clean(&plan.native_id),
                    plan.asset_count,
                    plan.plan_sha256
                )];
                if !plan.replaces.is_empty() {
                    lines.push(format!(
                        "Replaces: {}",
                        plan.replaces
                            .iter()
                            .map(|name| clean(name))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if !plan.overlapping_mods.is_empty() {
                    lines.push(format!(
                        "Shares assets with: {}",
                        plan.overlapping_mods
                            .iter()
                            .map(|name| clean(name))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if plan.conflicts_truncated {
                    lines.push("Some other packages were outside the comparison limit.".into());
                }
                if !plan.required_mods.is_empty() {
                    lines.push(format!(
                        "Requires: {}",
                        plan.required_mods
                            .iter()
                            .map(|name| clean(name))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if !plan.missing_required_mods.is_empty() {
                    lines.push(format!(
                        "Missing or disabled: {}",
                        plan.missing_required_mods
                            .iter()
                            .map(|name| clean(name))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if plan.needs_code_permission {
                    lines.push(format!(
                        "Requires permission to run code at SHA-256 {}",
                        plan.sha256
                    ));
                }
                lines.join("\n")
            })
        }
        ProfileCommand::PackageApply {
            port_id,
            profile_id,
            path,
            expected_plan,
            allow_mod_code,
            yes,
        } => {
            crate::require_confirmation(
                "Install exactly this reviewed mod package?",
                yes,
                non_interactive,
            )?;
            render_read_success(
                mode,
                name,
                service.apply_local_mod_package(
                    &port_id,
                    &profile_id,
                    &path,
                    &expected_plan,
                    allow_mod_code,
                )?,
                |revision| {
                    format!(
                        "Installed reviewed mod package\n{}",
                        revision_line(revision)
                    )
                },
            )
        }
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
        ProfileCommand::RemovePackage {
            port_id,
            profile_id,
            native_id,
            expected_revision,
        } => render_read_success(
            mode,
            name,
            service.remove_mod_package(&port_id, &profile_id, &native_id, expected_revision)?,
            |revision| format!("Package removed\n{}", revision_line(revision)),
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
        ProfileCommand::InspectModFile { port_id, file_name } => render_read_success(
            mode,
            name,
            service.inspect_mod_file(&port_id, &file_name)?,
            |plan| {
                let effect = if let Some(restore) = &plan.restore {
                    format!(
                        "Preserve this edit outside the mods folder and restore the recorded package (SHA-256 {}).",
                        restore.sha256
                    )
                } else {
                    "Preserve this file outside the mods folder.".into()
                };
                format!(
                    "Review mod file {}\nSHA-256: {}\nBytes: {}\n{effect}\nReview SHA-256: {}\nTo apply, use profile preserve-mod-file with this name and --expected-plan.",
                    clean(&plan.file_name),
                    plan.observed.sha256,
                    plan.observed.size,
                    plan.plan_sha256
                )
            },
        ),
        ProfileCommand::PreserveModFile {
            port_id,
            file_name,
            expected_plan,
        } => render_read_success(
            mode,
            name,
            service.preserve_mod_file(&port_id, &file_name, &expected_plan)?,
            |result| {
                format!(
                    "Preserved mod file at {}. To try it as a package, use the ordinary local mod review.",
                    clean(&result.preserved_path.display().to_string())
                )
            },
        ),
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
                for check in &view.last_automatic_checks {
                    let setup = inventory
                        .profiles
                        .iter()
                        .find(|entry| entry.profile.id == check.profile_id)
                        .map(|entry| clean(&entry.profile.display_name))
                        .unwrap_or_else(|| clean(&check.profile_id));
                    let mods = check
                        .native_ids
                        .iter()
                        .map(|id| clean(id))
                        .collect::<Vec<_>>();
                    let subject = if mods.is_empty() {
                        setup
                    } else {
                        format!("{setup} ({})", mods.join(", "))
                    };
                    let status = check.result.as_ref().map_or_else(
                        || "no newer mod file was offered".to_owned(),
                        mod_update_outcome,
                    );
                    lines.push(format!(
                        "{subject}, checked {}: {status}",
                        utc_time(check.checked_at)
                    ));
                }
                for held in &view.held_updates {
                    let setup = inventory
                        .profiles
                        .iter()
                        .find(|entry| entry.profile.id == held.profile_id)
                        .map(|entry| clean(&entry.profile.display_name))
                        .unwrap_or_else(|| clean(&held.profile_id));
                    lines.push(format!(
                        "{setup}: an update to {} waits for your review, so the current version was kept: {}. Review it with `portcove profile provider-plan {} {} {} {}`.",
                        held.native_ids
                            .iter()
                            .map(|name| clean(name))
                            .collect::<Vec<_>>()
                            .join(", "),
                        clean(&held.reason),
                        clean(&view.port_id),
                        clean(&held.profile_id),
                        clean(&held.project_id),
                        clean(&held.candidate_file_id)
                    ));
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
        ProfileCommand::RecipeAcquire {
            recipe_file,
            review_profile_id,
            native_id,
            acquisitions,
        } => {
            let plan = service
                .plan_recipe_acquisition(
                    &read_recipe(&recipe_file)?,
                    &review_profile_id,
                    &native_id,
                    &acquisitions
                        .iter()
                        .map(read_plan)
                        .collect::<Result<Vec<_>>>()?,
                )
                .await?;
            render_read_success(mode, name, plan, |plan| {
                format!("Exact recipe package reviewed: {}", clean(&plan.native_id))
            })
        }
        ProfileCommand::RecipeDiscard { acquisition } => {
            service.discard_recipe_acquisition(&read_plan(&acquisition)?)?;
            render_read_success(mode, name, (), |_| "Recipe staging discarded.".to_owned())
        }
        ProfileCommand::RecipePlan {
            recipe_file,
            acquisitions,
        } => render_read_success(
            mode,
            name,
            service.plan_recipe_import_with_acquisitions(
                &read_recipe(&recipe_file)?,
                &acquisitions
                    .iter()
                    .map(read_plan)
                    .collect::<Result<Vec<_>>>()?,
            )?,
            recipe_plan_text,
        ),
        ProfileCommand::RecipeApply {
            recipe_file,
            name: display_name,
            expected_plan,
            acquisitions,
            allow_mod_code,
            yes,
        } => {
            let plan = service.plan_recipe_import_with_acquisitions(
                &read_recipe(&recipe_file)?,
                &acquisitions
                    .iter()
                    .map(read_plan)
                    .collect::<Result<Vec<_>>>()?,
            )?;
            if plan.plan_sha256 != expected_plan {
                return Err(PortcoveError::conflict(
                    "the local inputs differ from the plan you reviewed; plan again",
                ));
            }
            if mode == OutputMode::Human {
                println!("{}", recipe_plan_text(&plan));
            }
            if !plan.code_approval.is_empty() && !allow_mod_code {
                return Err(PortcoveError::usage(
                    "review the exact mod code and use --allow-mod-code if you want to allow it",
                ));
            }
            crate::require_confirmation(
                "Create a new profile from exactly these reviewed inputs?",
                yes,
                non_interactive,
            )?;
            let authorization = if allow_mod_code {
                service.authorize_recipe_import_allowing_code(&plan, &display_name)?
            } else {
                service.authorize_recipe_import(&plan, &display_name)?
            };
            render_read_success(
                mode,
                name,
                service.apply_recipe_import(&plan, &display_name, &authorization.token)?,
                |profile| summary("Profile created from recipe", profile),
            )
        }
        ProfileCommand::RecoverPlan {
            port_id,
            profile_id,
            revision,
        } => render_read_success(
            mode,
            name,
            service.plan_profile_recovery(&port_id, &profile_id, revision)?,
            recovery_plan_text,
        ),
        ProfileCommand::Recover {
            port_id,
            profile_id,
            revision,
            expected_plan,
            yes,
        } => {
            let plan = service.plan_profile_recovery(&port_id, &profile_id, revision)?;
            if plan.plan_sha256 != expected_plan {
                return Err(PortcoveError::conflict(
                    "The setup recovery changed. Run profile recover-plan to review it again.",
                ));
            }
            if mode == OutputMode::Human {
                println!("{}", recovery_plan_text(&plan));
            }
            if !plan.holds.is_empty() {
                return Err(PortcoveError::conflict(
                    "This recovery is held. See the issues reported by profile recover-plan.",
                ));
            }
            crate::require_confirmation(
                "Recover this setup revision and keep its current progress?",
                yes,
                non_interactive,
            )?;
            render_read_success(
                mode,
                name,
                service.apply_profile_recovery(&port_id, &profile_id, revision, &expected_plan)?,
                |revision| {
                    format!(
                        "Setup recovered with current progress\n{}",
                        revision_line(revision)
                    )
                },
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

fn recovery_plan_text(plan: &ProfileRecoveryPlan) -> String {
    let mut lines = vec![
        format!("Recover setup revision {}", plan.target.revision),
        format!("Current{}", revision_line(&plan.current)),
        format!("Target{}", revision_line(&plan.target)),
        format!("Runtime {}", clean(&plan.target.build.artifact.asset_name)),
        "Keep current progress. Save compatibility depends on the game and mods.".into(),
        format!("Update policy {:?}", plan.update_policy),
    ];
    lines.extend(plan.target.packages.iter().map(|package| {
        let state = if package.enabled {
            "Enabled"
        } else {
            "Disabled"
        };
        format!("{state} · {}", clean(&package.native_id))
    }));
    for order in &plan.target.orderings {
        let names = order
            .native_ids
            .iter()
            .map(|name| clean(name))
            .collect::<Vec<_>>();
        lines.push(format!(
            "Load order {} · {}",
            clean(&order.domain),
            names.join(", ")
        ));
    }
    if !plan.target.settings.is_empty() {
        let keys = plan
            .target
            .settings
            .keys()
            .map(|key| clean(key))
            .collect::<Vec<_>>();
        lines.push(format!("Recorded settings · {}", keys.join(", ")));
    }
    for original in &plan.originals {
        lines.push(format!(
            "Original {} · {:?}",
            clean(&original.binding.requirement_id),
            original.availability,
        ));
    }
    lines.extend(
        plan.target
            .limits
            .iter()
            .map(|limit| format!("Limit · {}", clean(limit))),
    );
    lines.extend(
        plan.holds
            .iter()
            .map(|hold| format!("Held · {}", clean(&hold.message))),
    );
    lines.push(format!("Plan SHA-256 {}", clean(&plan.plan_sha256)));
    lines.join("\n")
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
            status_unknown: None,
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
                status_unknown: None,
                claimed_scan: Some("clean".into()),
                thunderstore_dependencies: None,
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
    fn thunderstore_text_names_the_provider_and_its_versions() {
        let mut thunderstore = project(false, 1, true);
        thunderstore.provider = "thunderstore".into();
        thunderstore.project_id = "Owner-Timer".into();
        thunderstore.files[0].file_id = "1.1.0".into();
        thunderstore.files[0].claimed_scan = None;
        thunderstore.files.push(ProviderFileCandidate {
            file_id: "1.0.0".into(),
            archived: false,
            ..thunderstore.files[0].clone()
        });
        let text = provider_project_text(&view(thunderstore.clone(), ProviderFreshness::Stale));
        assert!(text.contains("Thunderstore mod Owner-Timer"), "{text}");
        assert!(text.contains("version 1.1.0"));
        assert!(text.contains("no longer offered"));
        assert!(text.contains("1 more version on Thunderstore"));
        assert!(text.contains("Thunderstore couldn't be reached"));
        assert!(!text.contains("GameBanana"));
        let text = provider_project_text(&view(thunderstore, ProviderFreshness::Fresh));
        assert!(text.contains("provider-plan shipwright PROFILE_ID Owner-Timer VERSION"));
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
        assert!(stale.contains("2 more files"));
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
            other_game_records: 0,
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
