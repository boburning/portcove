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
//! the same checks as a reviewed install. Whether a newer file suits the setup's
//! game build is not assessed by the provider or by Portcove (UNKNOWN).
use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ErrorCode, PortcoveError, PortcoveService, ProfileRevision, ProfileUpdatePolicy,
    ProviderInstallPlan, ProviderUpdateObservation, ProviderUpdateState, Result, asset_conflicts,
    gamebanana::GameBananaClient,
    inspect_asset_archive, profile,
    profile_deploy::{Layout, enabled_in_override_order},
};

const HOLDS_FILE: &str = "auto-update-holds.json";
const MAX_REMEMBERED_HOLDS: usize = 256;

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

/// Packages installed from one provider file, and what the provider says about it.
struct InstalledFile<'a> {
    project: String,
    file: String,
    packages: Vec<&'a crate::ResolvedPackage>,
    observation: &'a ProviderUpdateObservation,
}

fn installed_files<'a>(
    revision: &'a ProfileRevision,
    observations: &'a [ProviderUpdateObservation],
) -> Vec<InstalledFile<'a>> {
    let mut groups = BTreeMap::<(String, String), InstalledFile<'a>>::new();
    for observation in observations {
        let project = observation.provider.project.clone();
        let file = observation.provider.file.clone().unwrap_or_default();
        let Some(package) = revision
            .packages
            .iter()
            .find(|package| package.native_id == observation.native_id)
        else {
            continue;
        };
        groups
            .entry((project.clone(), file.clone()))
            .or_insert_with(|| InstalledFile {
                project,
                file,
                packages: Vec::new(),
                observation,
            })
            .packages
            .push(package);
    }
    groups.into_values().collect()
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
    let staged = layout.staged(&plan.plan_sha256);
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

fn hold_key(
    profile_id: &str,
    revision: u64,
    installed: &InstalledFile<'_>,
    candidate: &str,
) -> String {
    format!(
        "{profile_id}|{revision}|{}|{}|{candidate}",
        installed.project, installed.file
    )
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
) -> Vec<HeldModUpdate> {
    let mut held = Vec::new();
    for (key, reason) in read_holds(layout) {
        let Some((profile_id, revision, project, file, candidate)) = parse_hold_key(&key) else {
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
                    provider.project == project && provider.file.as_deref() == Some(file)
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

/// The parts of a key `hold_key` built: profile, revision, project, installed
/// file and candidate file. None for anything else.
fn parse_hold_key(key: &str) -> Option<(&str, u64, &str, &str, &str)> {
    let parts = key.split('|').collect::<Vec<_>>();
    let [profile, revision, project, file, candidate] = parts.as_slice() else {
        return None;
    };
    Some((profile, revision.parse().ok()?, project, file, candidate))
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
    holds.retain(|key, _| {
        Some(key.as_str()) == keep
            || !parse_hold_key(key).is_some_and(|(profile, _, project, file, _)| {
                profile == profile_id && project == installed.project && file == installed.file
            })
    });
    if holds.len() != before {
        write_holds(layout, &holds);
    }
}

fn read_holds(layout: &Layout) -> BTreeMap<String, String> {
    std::fs::read(layout.store().join(HOLDS_FILE))
        .ok()
        .filter(|bytes| bytes.len() <= 256 * 1024)
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
        let client = GameBananaClient::for_library(&self.library)?;
        self.run_eligible_provider_updates_with(&client, port_id)
            .await
    }

    pub(crate) async fn run_eligible_provider_updates_with(
        &self,
        client: &GameBananaClient,
        port_id: &str,
    ) -> Result<Vec<ProviderAutoUpdate>> {
        if crate::provider_install::gamebanana_game(port_id).is_none() {
            return Ok(Vec::new());
        }
        let layout = self.deploy_layout(port_id)?;
        let setups = self
            .profile_inventory(port_id)?
            .profiles
            .into_iter()
            .filter(|view| {
                view.profile.intent.update_policy == ProfileUpdatePolicy::AutomaticEligible
            })
            .map(|view| view.profile)
            .collect::<Vec<_>>();
        let mut results = Vec::new();
        for setup in setups {
            let result = |native_ids: Vec<String>, outcome| ProviderAutoUpdate {
                port_id: port_id.into(),
                profile_id: setup.id.clone(),
                profile_name: setup.display_name.clone(),
                native_ids,
                outcome,
            };
            let observations = match self
                .check_provider_updates_with(client, port_id, &setup.id)
                .await
            {
                Ok(observations) => observations,
                Err(error) => {
                    results.push(result(Vec::new(), classify(error)));
                    continue;
                }
            };
            let revision =
                match self.library.connection().and_then(|connection| {
                    profile::current_revision(&connection, port_id, &setup.id)
                }) {
                    Ok(revision) => revision,
                    Err(error) => {
                        results.push(result(Vec::new(), classify(error)));
                        continue;
                    }
                };
            for installed in installed_files(&revision, &observations) {
                let names = installed
                    .packages
                    .iter()
                    .map(|package| package.native_id.clone())
                    .collect::<Vec<_>>();
                if let Some(outcome) = self
                    .update_one(client, &layout, port_id, &setup.id, &installed)
                    .await
                {
                    results.push(result(names, outcome));
                }
            }
        }
        Ok(results)
    }

    /// The outcome for one installed provider file; None when it is current. Only
    /// a hold for the current revision and candidate stays remembered.
    async fn update_one(
        &self,
        client: &GameBananaClient,
        layout: &Layout,
        port_id: &str,
        profile_id: &str,
        installed: &InstalledFile<'_>,
    ) -> Option<ProviderAutoUpdateOutcome> {
        let outcome = self
            .update_one_inner(client, layout, port_id, profile_id, installed)
            .await;
        let current_key = match (&outcome, installed.observation.newer_files.as_slice()) {
            (Some(ProviderAutoUpdateOutcome::Held { .. }), [candidate]) => self
                .library
                .connection()
                .and_then(|connection| profile::current_revision(&connection, port_id, profile_id))
                .ok()
                .map(|revision| {
                    hold_key(profile_id, revision.revision, installed, &candidate.file_id)
                })
                .filter(|key| read_holds(layout).contains_key(key)),
            _ => None,
        };
        settle_holds(layout, profile_id, installed, current_key.as_deref());
        outcome
    }

    async fn update_one_inner(
        &self,
        client: &GameBananaClient,
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
        let [candidate] = observation.newer_files.as_slice() else {
            return held("the provider offers several newer files; choose one");
        };
        if installed.packages.iter().any(|package| !package.enabled) {
            return held(
                "a mod from this file is turned off; review the update when you turn it on",
            );
        }
        let ids = installed
            .project
            .parse::<u64>()
            .ok()
            .zip(candidate.file_id.parse::<u64>().ok());
        let Some((project_id, file_id)) = ids else {
            return Some(ProviderAutoUpdateOutcome::Unavailable {
                reason: "the provider's file identity is not readable".into(),
            });
        };
        let revision = match self
            .library
            .connection()
            .and_then(|connection| profile::current_revision(&connection, port_id, profile_id))
        {
            Ok(revision) => revision,
            Err(error) => return Some(classify(error)),
        };
        let key = hold_key(profile_id, revision.revision, installed, &candidate.file_id);
        if let Some(reason) = read_holds(layout).get(&key) {
            return held(reason);
        }
        if let Some(reason) = self.busy_reason(port_id, profile_id) {
            // Waiting costs nothing; downloading now would be thrown away.
            return Some(ProviderAutoUpdateOutcome::Deferred { reason });
        }
        let plan = match self
            .plan_provider_install_with(client, port_id, profile_id, project_id, file_id)
            .await
        {
            Ok(plan) => plan,
            // Refusals here are not remembered: one may be a passing download
            // fault, and the provider's flags are checked before any download.
            Err(error) => return Some(classify(error)),
        };
        let outcome = match hold_reason(layout, &plan, &revision, installed) {
            Some(reason) => {
                remember_hold(layout, key, &reason);
                ProviderAutoUpdateOutcome::Held { reason }
            }
            None => match self
                .authorize_provider_install(&plan)
                .and_then(|authorization| self.apply_provider_install(&plan, &authorization.token))
            {
                Ok(applied) => {
                    return Some(ProviderAutoUpdateOutcome::Applied {
                        revision: applied.revision,
                        file_id: candidate.file_id.clone(),
                    });
                }
                Err(error) => classify(error),
            },
        };
        let _ = self.discard_provider_install(&plan);
        Some(outcome)
    }
}

#[cfg(test)]
#[path = "provider_auto_update_tests.rs"]
mod tests;
