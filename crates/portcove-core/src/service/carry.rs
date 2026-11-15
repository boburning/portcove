//! Tier 2: carry files Portcove didn't install from the active version to the
//! version about to become active (#5359 T2-2; design
//! `docs/design/tier2-unknown-file-carry.md` sections 2 and 3).
//!
//! The step runs under the port lock, only where the pointer change follows
//! in the same operation. It plans with `carry_plan`, applies the plan with
//! `carry_step` and records digests in `carry_ledger`:
//!
//! 1. Plan read-only.
//! 2. One transaction writes the target's rows for each planned copy as
//!    `pending`, keeping the present row each displaces. A path whose row
//!    can't be written (an unknown-format row) is not copied.
//! 3. Sweep leftover staging, then stage, verify and publish. Too little space
//!    carries nothing and the switch goes ahead; every other stop holds.
//! 4. One transaction records the published state, the departing source's
//!    rows and the outcome.
//!
//! Every file write lands in the target while the source is still active and
//! untouched, so an interruption leaves the source authoritative and a retry
//! re-plans.

use std::collections::{BTreeMap, BTreeSet};

use crate::carry_ledger::{self, StoredRow};
use crate::carry_plan::{self, CarryAction, CarryRow, PathInput, PlannedPath, RowChange, RowState};
use crate::carry_step::{self, CarryStop, Inspected, Listings};
use crate::{InstallRecord, PortcoveError, Result};

use super::PortcoveService;

/// Paths named in an outcome, per kind.
const MAX_OUTCOME_PATHS: usize = 64;

/// What one carry did, recorded as the port's outcome.
#[derive(Debug, Default, serde::Serialize)]
pub(crate) struct CarryOutcome {
    pub(crate) carried: Vec<String>,
    pub(crate) removed: Vec<String>,
    pub(crate) kept_separately: Vec<String>,
    pub(crate) source_unreadable: Vec<String>,
    pub(crate) new_version_ships_file: Vec<String>,
    pub(crate) insufficient_space: bool,
}

impl CarryOutcome {
    fn bounded(mut self) -> Self {
        for list in [
            &mut self.carried,
            &mut self.removed,
            &mut self.kept_separately,
            &mut self.source_unreadable,
            &mut self.new_version_ships_file,
        ] {
            list.truncate(MAX_OUTCOME_PATHS);
        }
        self
    }
}

fn hold(stop: CarryStop) -> PortcoveError {
    match stop {
        CarryStop::Locked(path) => carry_step::locked_error(&path),
        CarryStop::SourceChanged(path) => PortcoveError::conflict(
            "A file Portcove would carry to the new version changed while it was being copied. Nothing was changed; try again.",
        )
        .detail("carried_file_changed", path),
        CarryStop::Failed(error) => error,
        CarryStop::InsufficientSpace { .. } => {
            PortcoveError::state("insufficient space is not a hold")
        }
    }
}

impl PortcoveService {
    /// Carry eligible unknown files from `active` to `target`. A no-op when
    /// they are the same installation or no file qualifies.
    pub(crate) fn carry_unknown_files(
        &self,
        active: &InstallRecord,
        target: &InstallRecord,
    ) -> Result<Option<CarryOutcome>> {
        if active.id == target.id {
            return Ok(None);
        }
        let unknown = self.portable_runtime_unknown_files(active)?;
        let active_qualification = self.installed_mutability_qualification(active)?;
        let target_qualification = self.installed_mutability_qualification(target)?;
        let (source_root, source_exclusions) = active_qualification.carry_exclusions(active)?;
        let (target_root, mut exclusions) = target_qualification.carry_exclusions(target)?;
        // Rule 9: what either version declares is never carried.
        exclusions
            .declared_paths
            .extend(source_exclusions.declared_paths);
        exclusions
            .declared_patterns
            .extend(source_exclusions.declared_patterns);

        let mut connection = self.library.connection()?;
        let source_rows = carry_ledger::load(&connection, &active.id)?;
        let target_rows = carry_ledger::load(&connection, &target.id)?;
        // Candidates (B1, review N2): A's harmless files, A's rows, and the
        // paths T holds pending from A.
        let mut candidates = BTreeSet::new();
        for file in &unknown {
            let absolute = crate::install::manifest_member(&file.install_root, &file.relative)?;
            if let Ok(relative) = absolute.strip_prefix(&source_root)
                && let Some(parts) = relative
                    .components()
                    .map(|part| part.as_os_str().to_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            {
                candidates.insert(parts.join("/"));
            }
        }
        candidates.extend(source_rows.keys().cloned());
        candidates.extend(target_rows.iter().filter_map(|(path, stored)| {
            matches!(&stored.row.state, RowState::Pending { source_install_id } if *source_install_id == active.id)
                .then(|| path.clone())
        }));
        if candidates.is_empty() {
            return Ok(None);
        }

        let checkpoint = || Ok(());
        let (source_listings, target_listings) = (Listings::default(), Listings::default());
        let mut inputs = BTreeMap::new();
        let mut inspected = Inspected::default();
        for path in &candidates {
            if crate::archive::validate_relative_path(path, false).is_err() {
                continue;
            }
            let (source, size) =
                carry_step::inspect_source(&source_root, path, &source_listings, &checkpoint)?;
            if let Some(size) = size {
                inspected.sizes.insert(path.clone(), size);
            }
            let target_copy =
                carry_step::inspect_target(&target_root, path, &target_listings, &checkpoint)?;
            let stored = target_rows.get(path);
            inputs.insert(
                path.clone(),
                PathInput {
                    source,
                    source_row: source_rows.get(path).map(|stored| stored.row.clone()),
                    target: target_copy,
                    target_row: stored.map(|stored| stored.row.clone()),
                    target_replaces: stored.and_then(|stored| stored.replaces.clone()),
                },
            );
        }
        let plan = carry_plan::plan(&active.id, &inputs, &exclusions, &|_| false);
        let copying = |planned: &PlannedPath| {
            matches!(planned.action, CarryAction::Copy | CarryAction::Replace)
        };

        // Step 2: pending rows before any file is written.
        let mut not_written = BTreeSet::new();
        {
            let transaction = connection.transaction()?;
            for planned in plan.iter().filter(|planned| copying(planned)) {
                let RowChange::Set(row) = &planned.target_row else {
                    continue;
                };
                let pending = CarryRow {
                    state: RowState::Pending {
                        source_install_id: active.id.clone(),
                    },
                    sha256: row.sha256.clone(),
                    lineage: row.lineage.clone(),
                };
                let displaced = target_rows
                    .get(&planned.path)
                    .filter(|stored| stored.row.state == RowState::Present)
                    .map(|stored| &stored.row);
                if !carry_ledger::put(&transaction, &target.id, &planned.path, &pending, displaced)?
                {
                    not_written.insert(planned.path.clone());
                }
            }
            transaction.commit()?;
        }
        let plan = plan
            .into_iter()
            .map(|mut planned| {
                if not_written.contains(&planned.path) {
                    planned.action = CarryAction::KeepSeparately;
                    planned.target_row = RowChange::Untouched;
                    planned.approved_source = None;
                }
                planned
            })
            .collect::<Vec<_>>();

        // Step 3: stage, verify and publish.
        carry_step::sweep(&target_root)?;
        let space = (
            fs4::available_space(&target_root)?,
            fs4::total_space(&target_root)?,
        );
        let mut outcome = CarryOutcome::default();
        let kept = match carry_step::stage(
            (&source_root, &target_root),
            &plan,
            &inspected,
            space,
            &checkpoint,
        ) {
            Ok(staged) => {
                let mut kept = staged.changed_targets.clone();
                kept.extend(staged.publish().map_err(hold)?);
                kept
            }
            Err(CarryStop::InsufficientSpace { .. }) => {
                outcome.insufficient_space = true;
                self.restore_target_rows(&mut connection, target, &plan, &target_rows, &copying)?;
                self.record_carry_outcome(&mut connection, active, target, &outcome)?;
                return Ok(Some(outcome.bounded()));
            }
            Err(stop) => return Err(hold(stop)),
        };
        let kept = kept.into_iter().collect::<BTreeSet<_>>();

        // Step 4: record what was published and the departing source's rows.
        let transaction = connection.transaction()?;
        for planned in &plan {
            let kept_here = kept.contains(&planned.path) || not_written.contains(&planned.path);
            match planned.action {
                CarryAction::Copy | CarryAction::Replace if !kept_here => {
                    outcome.carried.push(planned.path.clone())
                }
                CarryAction::Remove if !kept_here => outcome.removed.push(planned.path.clone()),
                CarryAction::SourceUnreadable => {
                    outcome.source_unreadable.push(planned.path.clone())
                }
                CarryAction::Excluded(carry_plan::Exclusion::PackageMember) => {
                    outcome.new_version_ships_file.push(planned.path.clone())
                }
                CarryAction::KeepSeparately => outcome.kept_separately.push(planned.path.clone()),
                _ if kept_here => outcome.kept_separately.push(planned.path.clone()),
                _ => {}
            }
            if kept_here {
                // Not written: T keeps the row it had before this switch.
                restore_row(
                    &transaction,
                    &target.id,
                    &planned.path,
                    target_rows.get(&planned.path),
                )?;
            } else {
                apply(&transaction, &target.id, &planned.path, &planned.target_row)?;
            }
            apply(&transaction, &active.id, &planned.path, &planned.source_row)?;
        }
        transaction.commit()?;
        self.record_carry_outcome(&mut connection, active, target, &outcome)?;
        Ok(Some(outcome.bounded()))
    }

    /// Put T's rows back as they were before step 2, for a carry that wrote
    /// nothing.
    fn restore_target_rows(
        &self,
        connection: &mut rusqlite::Connection,
        target: &InstallRecord,
        plan: &[PlannedPath],
        target_rows: &BTreeMap<String, StoredRow>,
        copying: &dyn Fn(&PlannedPath) -> bool,
    ) -> Result<()> {
        let transaction = connection.transaction()?;
        for planned in plan.iter().filter(|planned| copying(planned)) {
            restore_row(
                &transaction,
                &target.id,
                &planned.path,
                target_rows.get(&planned.path),
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn record_carry_outcome(
        &self,
        connection: &mut rusqlite::Connection,
        active: &InstallRecord,
        target: &InstallRecord,
        outcome: &CarryOutcome,
    ) -> Result<()> {
        let transaction = connection.transaction()?;
        let bounded = serde_json::to_value(CarryOutcome {
            carried: outcome
                .carried
                .iter()
                .take(MAX_OUTCOME_PATHS)
                .cloned()
                .collect(),
            removed: outcome
                .removed
                .iter()
                .take(MAX_OUTCOME_PATHS)
                .cloned()
                .collect(),
            kept_separately: outcome
                .kept_separately
                .iter()
                .take(MAX_OUTCOME_PATHS)
                .cloned()
                .collect(),
            source_unreadable: outcome
                .source_unreadable
                .iter()
                .take(MAX_OUTCOME_PATHS)
                .cloned()
                .collect(),
            new_version_ships_file: outcome
                .new_version_ships_file
                .iter()
                .take(MAX_OUTCOME_PATHS)
                .cloned()
                .collect(),
            insufficient_space: outcome.insufficient_space,
        })?;
        carry_ledger::put_outcome(
            &transaction,
            &target.port_id,
            &active.id,
            &target.id,
            &bounded,
        )?;
        transaction.commit()?;
        Ok(())
    }
}

fn restore_row(
    transaction: &rusqlite::Transaction<'_>,
    install_id: &str,
    path: &str,
    previous: Option<&StoredRow>,
) -> Result<()> {
    match previous {
        Some(stored) => {
            carry_ledger::put(
                transaction,
                install_id,
                path,
                &stored.row,
                stored.replaces.as_ref(),
            )?;
        }
        None => {
            carry_ledger::delete(transaction, install_id, path)?;
        }
    }
    Ok(())
}

fn apply(
    transaction: &rusqlite::Transaction<'_>,
    install_id: &str,
    path: &str,
    change: &RowChange,
) -> Result<()> {
    match change {
        RowChange::Untouched => {}
        RowChange::Set(row) => {
            carry_ledger::put(transaction, install_id, path, row, None)?;
        }
        RowChange::Delete => {
            carry_ledger::delete(transaction, install_id, path)?;
        }
    }
    Ok(())
}
