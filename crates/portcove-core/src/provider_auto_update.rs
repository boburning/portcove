//! Unattended provider updates under a profile's standing policy.
//!
//! A profile whose update policy is `automatic_eligible` lets a standing pass
//! install a newer provider file without another confirmation, but only when the
//! update is unambiguous and changes nothing the player has not already chosen.
//! Updates are considered per installed provider file: the provider must offer
//! exactly one newer file in a current observation, every package from the
//! installed file must be on, the newer file must bring exactly the same package
//! names, and no asset two enabled mods both change may get a different winner.
//! Anything else is held with a reason. A hold that comes from comparing the update
//! with the setup is remembered for the setup's revision and the candidate file,
//! so the same download is not repeated on every pass; any change to either tries
//! again. A busy port or a mods folder with unknown files defers before any
//! download.
//!
//! Like standing setup, the policy is consent, never an authorization: each
//! update is planned again and authorized immediately before it is applied, under
//! the same checks as a reviewed install. The provider's claims do not verify
//! the Recomp loader contract or the staged package's native dependencies.
use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ErrorCode, PortcoveError, PortcoveService, ProfileRevision, ProfileUpdatePolicy,
    ProviderFileCandidate, ProviderInstallPlan, ProviderUpdateObservation, ProviderUpdateState,
    Result, asset_conflicts, inspect_asset_archive, profile,
    profile_deploy::{Layout, enabled_in_override_order},
    provider_client::ProviderClient,
    provider_install::{ProviderInstallMode, RECOMP_REVIEW_BINDING, recomp_review_binding},
};

const HOLDS_FILE: &str = "auto-update-holds.json";
const MAX_REMEMBERED_HOLDS: usize = 256;
const CHECKS_FILE: &str = "last-automatic-checks.json";
/// Written in place of a pass's results that could not be stored whole.
const INCOMPLETE_CHECKS: &[u8] = br#"{"incomplete":true}"#;
/// One check per installed provider file of every automatic setup of a port.
/// A setup has at most one provider file per package (the shared setup
/// capacity), and setups per port are not counted, so a pass records every
/// check. The log is Portcove-owned and read whole, so its parse budget is the
/// library's memory-derived document admission budget; a log past it, or one
/// that cannot be read, is reported as incomplete rather than as no checks.
fn max_checks_bytes() -> u64 {
    crate::library_metadata_document::admission_budget()
}

/// What one standing pass did about one installed provider file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ProviderAutoUpdateOutcome {
    /// The newer file was installed as the setup's next revision.
    Applied { revision: u64, file_id: String },
    /// An update exists but needs the player's review; nothing changed. The hold
    /// is not repeated until the setup or the provider's offer changes.
    Held { reason: String },
    /// Something temporary prevented the update, such as the game running or
    /// another change in progress; a later pass tries again.
    Deferred { reason: String },
    /// Whether an update exists could not be established; nothing changed.
    Unavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderAutoUpdate {
    pub port_id: String,
    pub profile_id: String,
    pub profile_name: String,
    /// The setup's packages from the provider file this outcome is about; empty
    /// when the whole setup could not be checked.
    pub native_ids: Vec<String>,
    #[serde(flatten)]
    pub outcome: ProviderAutoUpdateOutcome,
}

/// The last automatic check of an installed provider file or setup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderAutoUpdateCheck {
    pub checked_at: i64,
    pub profile_id: String,
    pub native_ids: Vec<String>,
    pub project_id: Option<String>,
    pub candidate_file_id: Option<String>,
    /// None means a current observation offered no update.
    pub result: Option<ProviderAutoUpdateOutcome>,
}

/// The stored results of the last automatic pass for a port's setups.
#[derive(Debug, Default)]
pub(crate) struct LastChecks {
    pub(crate) checks: Vec<ProviderAutoUpdateCheck>,
    /// A stored log existed but could not be read whole (unreadable, past its
    /// parse budget, or not a check log), so `checks` does not report it.
    pub(crate) incomplete: bool,
}

pub(crate) fn last_checks(layout: &Layout, inventory: &crate::ProfileInventory) -> LastChecks {
    let path = layout.store().join(CHECKS_FILE);
    if std::fs::symlink_metadata(&path)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return LastChecks::default();
    }
    let Some(checks) = crate::path::read_bounded_regular(&path, max_checks_bytes())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<ProviderAutoUpdateCheck>>(&bytes).ok())
    else {
        return LastChecks {
            checks: Vec::new(),
            incomplete: true,
        };
    };
    let checks = checks
        .into_iter()
        .filter(|check| {
            // Keep observed Unix timestamps within the portable date range.
            (0..=253_402_300_799).contains(&check.checked_at)
                && inventory.profiles.iter().any(|view| {
                    view.profile.id == check.profile_id
                        && view.profile.intent.update_policy
                            == ProfileUpdatePolicy::AutomaticEligible
                })
        })
        .collect();
    LastChecks {
        checks,
        incomplete: false,
    }
}

fn remember_checks(layout: &Layout, checks: &[ProviderAutoUpdateCheck]) -> Result<()> {
    let path = layout.store().join(CHECKS_FILE);
    if checks.is_empty() && !path.is_file() {
        return Ok(());
    }
    let bytes = serde_json::to_vec(checks)?;
    std::fs::create_dir_all(layout.store())?;
    if bytes.len() as u64 > max_checks_bytes() {
        // Never leave an older pass's results looking current: the marker is
        // not a check log, so readers report the log as incomplete.
        crate::durability::write_bytes_atomically(&path, INCOMPLETE_CHECKS, true)?;
        return Err(
            PortcoveError::state("automatic mod check results exceed their storage bound")
                .detail("check_bytes", bytes.len().to_string())
                .detail("budget_bytes", max_checks_bytes().to_string()),
        );
    }
    crate::durability::write_bytes_atomically(&path, &bytes, true)?;
    Ok(())
}

/// Packages installed from one provider file, and what the provider says about it.
struct InstalledFile<'a> {
    project: String,
    file: String,
    binding: Option<&'a crate::ModProviderBinding>,
    packages: Vec<&'a crate::ResolvedPackage>,
    observation: &'a ProviderUpdateObservation,
}

fn nonlegacy_binding<'a>(
    port_id: &str,
    provider: &'a crate::ProviderPackageRef,
) -> Option<&'a crate::ModProviderBinding> {
    let legacy = crate::provider_binding::legacy_binding(port_id, &provider.provider);
    provider
        .binding
        .as_ref()
        .filter(|binding| Some(*binding) != legacy.as_ref())
}

fn installed_files<'a>(
    port_id: &str,
    revision: &'a ProfileRevision,
    observations: &'a [ProviderUpdateObservation],
) -> Vec<InstalledFile<'a>> {
    let mut groups = BTreeMap::new();
    for observation in observations {
        let project = observation.provider.project.clone();
        let file = observation.provider.file.clone().unwrap_or_default();
        let Some(package) = revision.packages.iter().find(|package| {
            package.native_id == observation.native_id
                && package.provider.as_ref() == Some(&observation.provider)
        }) else {
            continue;
        };
        let binding = nonlegacy_binding(port_id, &observation.provider);
        groups
            .entry((
                observation.provider.provider.as_str(),
                binding,
                project.clone(),
                file.clone(),
            ))
            .or_insert_with(|| InstalledFile {
                project,
                file,
                binding,
                packages: Vec::new(),
                observation,
            })
            .packages
            .push(package);
    }
    groups.into_values().collect()
}

fn hold_scope(binding: Option<&crate::ModProviderBinding>) -> Option<String> {
    match binding? {
        crate::ModProviderBinding::Gamebanana { game_id } => Some(format!("gamebanana:{game_id}")),
        crate::ModProviderBinding::Thunderstore { community } => {
            Some(format!("thunderstore:{community}"))
        }
    }
}

/// Asset paths of each enabled package in deployment order, with `replacement`
/// bytes standing in for packages of the same name. None when any package's
/// assets cannot be read, so the effect of the update is unknown.
fn ordered_assets(
    layout: &Layout,
    revision: &ProfileRevision,
    replacement: &BTreeMap<String, std::path::PathBuf>,
) -> Option<Vec<(String, Vec<String>)>> {
    enabled_in_override_order(revision)
        .into_iter()
        .map(|package| {
            let path = replacement
                .get(&package.native_id)
                .cloned()
                .unwrap_or_else(|| layout.package(&package.sha256, &package.native_id));
            let inspection = inspect_asset_archive(&path).ok()?;
            Some((package.native_id.clone(), inspection.asset_paths))
        })
        .collect()
}

fn contested(ordered: &[(String, Vec<String>)]) -> Vec<crate::AssetConflict> {
    asset_conflicts(
        &ordered
            .iter()
            .map(|(id, paths)| (id.as_str(), paths.as_slice()))
            .collect::<Vec<_>>(),
    )
}

/// Why the reviewed plan may not be applied without the player, if it may not.
fn hold_reason(
    layout: &Layout,
    plan: &ProviderInstallPlan,
    revision: &ProfileRevision,
    installed: &InstalledFile<'_>,
) -> Option<String> {
    // Consent to run code covers exact bytes, so new code always waits for the
    // player, however the setup's policy reads.
    if let Some(member) = plan
        .members
        .iter()
        .find(|member| !member.runs_code.is_empty())
    {
        return Some(format!(
            "the update to {} runs its own code inside the game; review it to allow that code",
            member.file_name
        ));
    }
    let brought = plan
        .members
        .iter()
        .map(|member| member.file_name.as_str())
        .collect::<BTreeSet<_>>();
    let had = installed
        .packages
        .iter()
        .map(|package| package.native_id.as_str())
        .collect::<BTreeSet<_>>();
    if brought != had {
        let list = |names: Vec<&str>| {
            if names.is_empty() {
                "none".to_owned()
            } else {
                names.join(", ")
            }
        };
        return Some(format!(
            "the newer file changes which mods it contains (adds: {}; drops: {})",
            list(brought.difference(&had).copied().collect()),
            list(had.difference(&brought).copied().collect()),
        ));
    }
    // Recomp mods' entries are not compared (which mod wins is not established).
    if layout.recomp_game().is_some() {
        return None;
    }
    let staged = ProviderInstallMode::Automatic.staging(layout, &plan.plan_sha256);
    let replacement = plan
        .members
        .iter()
        .map(|member| (member.file_name.clone(), staged.join(&member.file_name)))
        .collect();
    let (Some(before), Some(after)) = (
        ordered_assets(layout, revision, &BTreeMap::new()),
        ordered_assets(layout, revision, &replacement),
    ) else {
        return Some(
            "Portcove could not read every enabled mod's files, so the update's effect is unknown"
                .into(),
        );
    };
    if contested(&before) != contested(&after) {
        return Some(
            "the update changes which mod wins an asset another enabled mod also changes".into(),
        );
    }
    None
}

/// The update a pass would take: the only newer file, or for Thunderstore, whose
/// versions form one line, the highest version. Several GameBanana files are a
/// choice.
fn chosen_candidate<'a>(
    client: &ProviderClient,
    observation: &'a crate::ProviderUpdateObservation,
) -> Option<&'a crate::ProviderFileCandidate> {
    match (client, observation.newer_files.as_slice()) {
        (_, [candidate]) => Some(candidate),
        // The highest version, not the last published: a backport published
        // after a major release never wins over it.
        (ProviderClient::Thunderstore { .. }, [_, _, ..]) => observation
            .newer_files
            .iter()
            .max_by_key(|file| crate::provider_client::version_parts(&file.file_id)),
        _ => None,
    }
}

fn hold_key(
    profile_id: &str,
    revision: u64,
    installed: &InstalledFile<'_>,
    candidate: &ProviderFileCandidate,
) -> String {
    // A provider may revise a file without changing its displayed version or ID.
    // These claims only tell us when to check again. The plan inspects the bytes.
    let observation = serde_json::json!([
        candidate.file_name,
        candidate.size,
        candidate.added_at,
        candidate.claimed_md5,
        candidate.archived,
        candidate.claimed_scan,
    ]);
    let observation = match candidate.thunderstore_dependencies.as_deref() {
        Some(dependencies) if !dependencies.is_empty() => {
            serde_json::json!([observation, dependencies])
        }
        _ => observation,
    };
    let fingerprint = hex::encode(Sha256::digest(observation.to_string()));
    let key = format!(
        "{profile_id}|{revision}|{}|{}|{}|{fingerprint}",
        installed.project, installed.file, candidate.file_id
    );
    match hold_scope(installed.binding) {
        Some(scope) => format!("{key}|{scope}"),
        None => key,
    }
}

/// An unattended update the player has to review, remembered for a setup's
/// current revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HeldModUpdate {
    pub profile_id: String,
    /// The setup's mods from the installed provider file.
    pub native_ids: Vec<String>,
    pub project_id: String,
    pub candidate_file_id: String,
    pub reason: String,
}

/// Held updates that still apply to each setup's current revision.
pub(crate) fn held_updates(
    layout: &Layout,
    inventory: &crate::ProfileInventory,
    port: &crate::PortDefinition,
) -> Vec<HeldModUpdate> {
    let mut held = Vec::new();
    for (key, reason) in read_holds(layout) {
        let Some((profile_id, revision, project, file, candidate, scope)) = parse_hold_key(&key)
        else {
            continue;
        };
        // Only setups that still allow unattended updates have one waiting.
        let Some(view) = inventory.profiles.iter().find(|view| {
            view.profile.id == profile_id
                && view.revision.revision == revision
                && view.profile.intent.update_policy == ProfileUpdatePolicy::AutomaticEligible
        }) else {
            continue;
        };
        let native_ids = view
            .revision
            .packages
            .iter()
            .filter(|package| {
                package.provider.as_ref().is_some_and(|provider| {
                    provider.project == project
                        && provider.file.as_deref() == Some(file)
                        && crate::provider_binding::reference_matches(port, provider)
                        && hold_scope(nonlegacy_binding(&port.id, provider)).as_deref() == scope
                })
            })
            .map(|package| package.native_id.clone())
            .collect::<Vec<_>>();
        if native_ids.is_empty() {
            continue;
        }
        held.push(HeldModUpdate {
            profile_id: profile_id.to_owned(),
            native_ids,
            project_id: project.to_owned(),
            candidate_file_id: candidate.to_owned(),
            reason,
        });
    }
    held
}

/// The display identity shared by current keys and legacy keys with no observed
/// file facts. Legacy keys keep their explanation until the next fresh check.
fn parse_hold_key(key: &str) -> Option<(&str, u64, &str, &str, &str, Option<&str>)> {
    let parts = key.split('|').collect::<Vec<_>>();
    let ([profile, revision, project, file, candidate]
    | [profile, revision, project, file, candidate, _]
    | [profile, revision, project, file, candidate, _, _]) = parts.as_slice()
    else {
        return None;
    };
    Some((
        profile,
        revision.parse().ok()?,
        project,
        file,
        candidate,
        parts.get(6).copied(),
    ))
}

fn write_holds(layout: &Layout, holds: &BTreeMap<String, String>) {
    if let Ok(bytes) = serde_json::to_vec(holds) {
        let _ = std::fs::create_dir_all(layout.store());
        let _ = crate::durability::write_bytes_atomically(
            &layout.store().join(HOLDS_FILE),
            &bytes,
            true,
        );
    }
}

/// Keeps at most `keep` among the holds for one setup's installed provider file,
/// so a replaced candidate or a changed outcome never leaves an old reason shown.
fn settle_holds(
    layout: &Layout,
    profile_id: &str,
    installed: &InstalledFile<'_>,
    keep: Option<&str>,
) {
    let mut holds = read_holds(layout);
    let before = holds.len();
    let scope = hold_scope(installed.binding);
    holds.retain(|key, _| {
        Some(key.as_str()) == keep
            || !parse_hold_key(key).is_some_and(|(profile, _, project, file, _, held_scope)| {
                profile == profile_id
                    && project == installed.project
                    && file == installed.file
                    && held_scope == scope.as_deref()
            })
    });
    if holds.len() != before {
        write_holds(layout, &holds);
    }
}

fn read_holds(layout: &Layout) -> BTreeMap<String, String> {
    crate::path::read_bounded_regular(&layout.store().join(HOLDS_FILE), 256 * 1024)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn remember_hold(layout: &Layout, key: String, reason: &str) {
    let mut holds = read_holds(layout);
    if holds.len() >= MAX_REMEMBERED_HOLDS {
        // Holds only save repeated downloads: forgetting them costs one more check.
        holds.clear();
    }
    holds.insert(key, reason.to_owned());
    write_holds(layout, &holds);
}

/// Network trouble is unavailability; contention and changed state are retried;
/// everything else is a refusal the player has to review.
fn classify(error: PortcoveError) -> ProviderAutoUpdateOutcome {
    match error.code {
        ErrorCode::Network => ProviderAutoUpdateOutcome::Unavailable {
            reason: error.message,
        },
        ErrorCode::Conflict | ErrorCode::State | ErrorCode::Cancelled => {
            ProviderAutoUpdateOutcome::Deferred {
                reason: error.message,
            }
        }
        _ => ProviderAutoUpdateOutcome::Held {
            reason: error.message,
        },
    }
}

impl PortcoveService {
    /// Why an update cannot be applied right now, checked before downloading: the
    /// game or another change holds the port, or the live mods folder of the
    /// selected setup has files the setup did not add.
    fn busy_reason(&self, port_id: &str, profile_id: &str) -> Option<String> {
        if let Err(error) = self.library.try_lock_port(port_id, "check-provider-update") {
            return Some(error.message);
        }
        let selected = self
            .library
            .connection()
            .and_then(|connection| profile::selection(&connection, port_id))
            .ok()
            .flatten()
            .is_some_and(|(id, _)| id == profile_id);
        if selected {
            match self.observe_live_mods(port_id) {
                Ok(live) if live.unmanaged.is_empty() && live.changed_owned.is_empty() => {}
                Ok(_) => {
                    return Some(
                        "the mods folder has files this setup did not add, or files changed outside Portcove; move or restore them first"
                            .into(),
                    );
                }
                Err(error) => return Some(error.message),
            }
        }
        None
    }

    /// Applies eligible provider updates to every setup of `port_id` whose
    /// policy allows it. Other setups are not contacted.
    pub async fn run_eligible_provider_updates(
        &self,
        port_id: &str,
    ) -> Result<Vec<ProviderAutoUpdate>> {
        let port = self.catalog().port(port_id)?;
        let clients = crate::provider_binding::bindings(port)
            .iter()
            .map(|binding| {
                ProviderClient::for_definition(&self.library, port, Some(binding.provider()))
            })
            .collect::<Result<Vec<_>>>()?;
        if clients.is_empty() && crate::provider_binding::configured_bindings(port).is_none() {
            return Ok(Vec::new());
        }
        self.run_eligible_provider_updates_for(&clients, port_id)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn run_eligible_provider_updates_with(
        &self,
        client: &crate::GameBananaClient,
        port_id: &str,
    ) -> Result<Vec<ProviderAutoUpdate>> {
        let client = ProviderClient::gamebanana(client, port_id)?;
        self.run_eligible_provider_updates_via(&client, port_id)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn run_eligible_provider_updates_via(
        &self,
        client: &ProviderClient,
        port_id: &str,
    ) -> Result<Vec<ProviderAutoUpdate>> {
        self.run_eligible_provider_updates_for(std::slice::from_ref(client), port_id)
            .await
    }

    async fn run_eligible_provider_updates_for(
        &self,
        clients: &[ProviderClient],
        port_id: &str,
    ) -> Result<Vec<ProviderAutoUpdate>> {
        let layout = self.deploy_layout(port_id)?;
        let port = self.catalog().port(port_id)?;
        let setups = self
            .profile_inventory(port_id)?
            .profiles
            .into_iter()
            .filter(|view| {
                view.profile.intent.update_policy == ProfileUpdatePolicy::AutomaticEligible
            })
            .collect::<Vec<_>>();
        let mut results = Vec::new();
        let mut checks = Vec::new();
        for view in &setups {
            let setup = &view.profile;
            let mut record =
                |native_ids: Vec<String>,
                 project_id: Option<String>,
                 candidate_file_id: Option<String>,
                 outcome: Option<ProviderAutoUpdateOutcome>| {
                    checks.push(ProviderAutoUpdateCheck {
                        checked_at: crate::Library::now(),
                        profile_id: setup.id.clone(),
                        native_ids: native_ids.clone(),
                        project_id,
                        candidate_file_id,
                        result: outcome.clone(),
                    });
                    if let Some(outcome) = outcome {
                        results.push(ProviderAutoUpdate {
                            port_id: port_id.into(),
                            profile_id: setup.id.clone(),
                            profile_name: setup.display_name.clone(),
                            native_ids,
                            outcome,
                        });
                    }
                };
            if crate::provider_binding::configured_bindings(port).is_some() {
                for package in &view.revision.packages {
                    if let Some(reference) = &package.provider
                        && !clients
                            .iter()
                            .any(|client| client.provider() == reference.provider)
                    {
                        record(
                            vec![package.native_id.clone()],
                            Some(reference.project.clone()),
                            None,
                            Some(ProviderAutoUpdateOutcome::Unavailable {
                                reason: "this package's provider scope is no longer reviewed for this port".into(),
                            }),
                        );
                    }
                }
            }
            for client in clients {
                let revision = match self.library.connection().and_then(|connection| {
                    profile::current_revision(&connection, port_id, &setup.id)
                }) {
                    Ok(revision) => revision,
                    Err(error) => {
                        record(Vec::new(), None, None, Some(classify(error)));
                        continue;
                    }
                };
                let observations = match self
                    .check_provider_updates_for_revision(client, &revision)
                    .await
                {
                    Ok(observations) => observations,
                    Err(error) => {
                        record(Vec::new(), None, None, Some(classify(error)));
                        continue;
                    }
                };
                for installed in installed_files(port_id, &revision, &observations) {
                    let names = installed
                        .packages
                        .iter()
                        .map(|package| package.native_id.clone())
                        .collect::<Vec<_>>();
                    let outcome = self
                        .update_one(client, &layout, port_id, &setup.id, &installed)
                        .await;
                    record(
                        names,
                        Some(installed.project.clone()),
                        chosen_candidate(client, installed.observation)
                            .map(|file| file.file_id.clone()),
                        outcome,
                    );
                }
            }
        }
        if let Err(error) = remember_checks(&layout, &checks) {
            tracing::warn!(port_id, error = %error, "automatic mod check results could not be saved");
        }
        Ok(results)
    }

    /// The outcome for one installed provider file; None when it is current. Only
    /// a hold for the current revision and candidate stays remembered.
    async fn update_one(
        &self,
        client: &ProviderClient,
        layout: &Layout,
        port_id: &str,
        profile_id: &str,
        installed: &InstalledFile<'_>,
    ) -> Option<ProviderAutoUpdateOutcome> {
        let outcome = self
            .update_one_inner(client, layout, port_id, profile_id, installed)
            .await;
        let current_key = match (&outcome, chosen_candidate(client, installed.observation)) {
            (Some(ProviderAutoUpdateOutcome::Held { .. }), Some(candidate)) => self
                .library
                .connection()
                .and_then(|connection| profile::current_revision(&connection, port_id, profile_id))
                .ok()
                .map(|revision| hold_key(profile_id, revision.revision, installed, candidate))
                .filter(|key| read_holds(layout).contains_key(key)),
            _ => None,
        };
        // A passing outage or a busy setup says nothing new about the update.
        if !matches!(
            outcome,
            Some(
                ProviderAutoUpdateOutcome::Unavailable { .. }
                    | ProviderAutoUpdateOutcome::Deferred { .. }
            )
        ) {
            settle_holds(layout, profile_id, installed, current_key.as_deref());
        }
        outcome
    }

    async fn update_one_inner(
        &self,
        client: &ProviderClient,
        layout: &Layout,
        port_id: &str,
        profile_id: &str,
        installed: &InstalledFile<'_>,
    ) -> Option<ProviderAutoUpdateOutcome> {
        let observation = installed.observation;
        let held = |reason: &str| {
            Some(ProviderAutoUpdateOutcome::Held {
                reason: reason.into(),
            })
        };
        match observation.state {
            ProviderUpdateState::Current => return None,
            ProviderUpdateState::Unavailable => {
                return Some(ProviderAutoUpdateOutcome::Unavailable {
                    reason: observation
                        .reason
                        .clone()
                        .unwrap_or_else(|| "the provider could not be checked".into()),
                });
            }
            ProviderUpdateState::InstalledFileRemoved => {
                return held(
                    "the provider no longer offers the installed file and has no newer one",
                );
            }
            ProviderUpdateState::NewerFiles => {}
        }
        // Decided from the observation alone, before anything is downloaded.
        if let Some(reason) = &observation.reason {
            return held(reason);
        }
        // Thunderstore versions form one line, so the newest one is the update;
        // several GameBanana files are a choice for the player.
        let Some(candidate) = chosen_candidate(client, observation) else {
            return held("the provider offers several newer files; choose one");
        };
        if installed.packages.iter().any(|package| !package.enabled) {
            return held(
                "a mod from this file is turned off; review the update when you turn it on",
            );
        }
        if installed.project.is_empty() || candidate.file_id.is_empty() {
            return Some(ProviderAutoUpdateOutcome::Unavailable {
                reason: "the provider's file identity is not readable".into(),
            });
        }
        let revision = match self
            .library
            .connection()
            .and_then(|connection| profile::current_revision(&connection, port_id, profile_id))
        {
            Ok(revision) => revision,
            Err(error) => return Some(classify(error)),
        };
        if installed
            .packages
            .iter()
            .any(|package| !revision.packages.contains(package))
        {
            return Some(ProviderAutoUpdateOutcome::Deferred {
                reason: "the setup's installed mods changed while checking; check again".into(),
            });
        }
        let key = hold_key(profile_id, revision.revision, installed, candidate);
        if let Some(reason) = read_holds(layout).get(&key) {
            return held(reason);
        }
        if let Some(reason) = self.busy_reason(port_id, profile_id) {
            // Waiting costs nothing; downloading now would be thrown away.
            return Some(ProviderAutoUpdateOutcome::Deferred { reason });
        }
        let plan = match self
            .plan_provider_install_in_mode(
                client,
                port_id,
                profile_id,
                &installed.project,
                &candidate.file_id,
                ProviderInstallMode::Automatic,
            )
            .await
        {
            Ok(plan) => plan,
            Err(error)
                if error.details.get("review_stage").is_some_and(|stage| {
                    stage == crate::profile_loader::RECOMP_DEPENDENCY_REVIEW
                }) =>
            {
                let same_review =
                    recomp_review_binding(&revision.digest, candidate).is_ok_and(|binding| {
                        error.details.get(RECOMP_REVIEW_BINDING) == Some(&binding)
                    });
                if !same_review {
                    return Some(ProviderAutoUpdateOutcome::Deferred {
                        reason: "the setup or offered file changed while reviewing native dependencies; check again".into(),
                    });
                }
                remember_hold(layout, key, &error.message);
                return held(&error.message);
            }
            // Transport and inspection errors may be transient.
            Err(error) => return Some(classify(error)),
        };
        if &plan.file != candidate {
            let _ = self.discard_provider_install_in_mode(&plan, ProviderInstallMode::Automatic);
            return Some(ProviderAutoUpdateOutcome::Deferred {
                reason:
                    "the provider changed the offered file while planning the update; check again"
                        .into(),
            });
        }
        if plan.expected_revision != revision.revision {
            let _ = self.discard_provider_install_in_mode(&plan, ProviderInstallMode::Automatic);
            return Some(ProviderAutoUpdateOutcome::Deferred {
                reason: "the setup changed while planning the update; check again".into(),
            });
        }
        let outcome = match hold_reason(layout, &plan, &revision, installed) {
            Some(reason) => {
                remember_hold(layout, key, &reason);
                ProviderAutoUpdateOutcome::Held { reason }
            }
            None => match self
                .authorize_provider_install(&plan)
                .and_then(|authorization| {
                    self.apply_automatic_provider_install(&plan, &authorization.token)
                }) {
                Ok(applied) => {
                    return Some(ProviderAutoUpdateOutcome::Applied {
                        revision: applied.revision,
                        file_id: candidate.file_id.clone(),
                    });
                }
                Err(error) => classify(error),
            },
        };
        let _ = self.discard_provider_install_in_mode(&plan, ProviderInstallMode::Automatic);
        Some(outcome)
    }
}

#[cfg(test)]
#[path = "provider_auto_update_tests.rs"]
mod tests;
