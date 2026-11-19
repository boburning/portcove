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

use crate::CarriedFileOutcome as CarryOutcome;

impl CarryOutcome {
    fn complete_counts(&self) -> crate::CarriedFileCounts {
        crate::CarriedFileCounts {
            carried: self.carried.len() as u64,
            removed: self.removed.len() as u64,
            kept_separately: self.kept_separately.len() as u64,
            source_unreadable: self.source_unreadable.len() as u64,
            new_version_ships_file: self.new_version_ships_file.len() as u64,
        }
    }

    fn bounded(mut self) -> Self {
        self.counts = Some(self.complete_counts());
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
        CarryStop::StagingStorageFull => PortcoveError::state("unhandled staging exhaustion"),
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
        self.carry_unknown_files_with_space(active, target, &|root| {
            Ok((fs4::available_space(root)?, fs4::total_space(root)?))
        })
    }

    /// Keep the volume observation replaceable for deterministic low-space
    /// lifecycle fixtures without filling the host's actual game volume.
    pub(super) fn carry_unknown_files_with_space(
        &self,
        active: &InstallRecord,
        target: &InstallRecord,
        observe_space: &dyn Fn(&std::path::Path) -> Result<(u64, u64)>,
    ) -> Result<Option<CarryOutcome>> {
        self.carry_unknown_files_with_staging_writer(active, target, observe_space, None)
    }

    pub(super) fn carry_unknown_files_with_staging_writer(
        &self,
        active: &InstallRecord,
        target: &InstallRecord,
        observe_space: &dyn Fn(&std::path::Path) -> Result<(u64, u64)>,
        writer: Option<&carry_step::StagingWriter<'_>>,
    ) -> Result<Option<CarryOutcome>> {
        if active.id == target.id
            || !self.carry_participates(active)?
            || !self.carry_participates(target)?
        {
            return Ok(None);
        }
        // A modified active version carries nothing and never holds the
        // switch: rollback stays the way out of it (design L5). Only that
        // hazard does; any other error holds as before (review N1).
        let unknown = match self.portable_runtime_unknown_files(active) {
            Ok(unknown) => unknown,
            Err(error)
                if matches!(
                    error.known_cause(),
                    Some(crate::failure::KnownFailureCause::PortableRuntimeModified { .. })
                ) =>
            {
                if self.partial_carry_present(active, target)? {
                    return Err(PortcoveError::conflict(
                        "Portcove was part-way through carrying files to this version when it stopped, and the version you're leaving has since changed. Nothing more was changed. Undo the change to the active version, then try again.",
                    )
                    .detail("carried_file_pending", &target.id));
                }
                let outcome = CarryOutcome {
                    source_modified: true,
                    ..CarryOutcome::default()
                };
                let mut connection = self.library.connection()?;
                let transaction = connection.transaction()?;
                record_outcome(&transaction, active, target, &outcome);
                transaction.commit()?;
                return Ok(Some(outcome));
            }
            Err(error) => return Err(error),
        };
        let active_qualification = self.installed_mutability_qualification(active)?;
        let target_qualification = self.installed_mutability_qualification(target)?;
        let (source_root, source_exclusions) = active_qualification.carry_exclusions(active)?;
        let (target_root, mut exclusions) = target_qualification
            .carry_exclusions_with_current(target, self.catalog.port(&active.port_id).ok())?;
        // Rule 9 includes declarations from every retained installation, even
        // one that is neither the active copy nor this switch's target.
        exclusions
            .declared_paths
            .extend(source_exclusions.declared_paths);
        exclusions
            .declared_patterns
            .extend(source_exclusions.declared_patterns);
        exclusions
            .generated_metadata
            .extend(source_exclusions.generated_metadata);
        for retained in self.library.installs_for_port(&active.port_id)? {
            if retained.id == active.id || retained.id == target.id {
                continue;
            }
            let (_, retained_exclusions) = self
                .installed_mutability_qualification(&retained)
                .and_then(|qualification| qualification.carry_exclusions(&retained))
                .map_err(|error| error.detail("carry_retained_install", &retained.id))?;
            exclusions
                .declared_paths
                .extend(retained_exclusions.declared_paths);
            exclusions
                .declared_patterns
                .extend(retained_exclusions.declared_patterns);
        }

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
        candidates.extend(
            target_rows
                .iter()
                .filter(|(_, stored)| {
                    matches!(&stored.row.state, RowState::Pending { source_install_id } if *source_install_id == active.id)
                })
                .map(|(path, _)| path.clone()),
        );
        // Paths no carry may touch are dropped before anything is read, so a
        // locked or unreadable excluded file can't hold the switch (M3).
        let probe = candidates
            .iter()
            .filter(|path| crate::archive::validate_relative_path(path, false).is_ok())
            .map(|path| {
                (
                    path.clone(),
                    PathInput {
                        source: carry_plan::SourceCopy::Absent,
                        source_row: None,
                        target: carry_plan::TargetCopy::Absent,
                        target_row: None,
                        target_replaces: None,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut shipped = Vec::new();
        let eligible = carry_plan::plan(&active.id, &probe, &exclusions, &|_| false)
            .into_iter()
            .filter_map(|planned| match planned.action {
                CarryAction::Excluded(carry_plan::Exclusion::PackageMember) => {
                    shipped.push(planned.path);
                    None
                }
                CarryAction::Excluded(_) => None,
                _ => Some(planned.path),
            })
            .collect::<BTreeSet<_>>();
        let harmless = unknown
            .iter()
            .map(|file| file.relative.as_str())
            .collect::<BTreeSet<_>>();
        if eligible.is_empty() {
            return Ok(None);
        }
        let candidates = eligible;

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
                // The present record T holds, or the one an earlier
                // interrupted attempt's pending row kept (review M1).
                let displaced =
                    target_rows
                        .get(&planned.path)
                        .and_then(|stored| match stored.row.state {
                            RowState::Present => Some(&stored.row),
                            RowState::Pending { .. } => stored.replaces.as_ref(),
                        });
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
        let space = observe_space(&target_root)?;
        let mut outcome = CarryOutcome::default();
        let staged = match writer {
            Some(writer) => carry_step::stage_with_writer(
                (&source_root, &target_root),
                &plan,
                &inspected,
                space,
                &checkpoint,
                writer,
            ),
            None => carry_step::stage(
                (&source_root, &target_root),
                &plan,
                &inspected,
                space,
                &checkpoint,
            ),
        };
        let kept = match staged {
            Ok(staged) => {
                let mut kept = staged.changed_targets.clone();
                kept.extend(staged.publish().map_err(hold)?);
                kept
            }
            Err(CarryStop::InsufficientSpace {
                required,
                available,
            }) => {
                self.restore_target_rows(&mut connection, target, &plan, &target_rows, &copying)?;
                // An earlier attempt published part of a carry here: hold
                // rather than activate a partial carry (review M5).
                if self.partial_carry_present(active, target)? {
                    let mut error = PortcoveError::conflict(
                        "There isn't enough free space to finish carrying files to the new version. Nothing more was changed. Free up space on the drive that holds the game, then try again.",
                    )
                    .detail("required_bytes", required.to_string());
                    if let Some(available) = available {
                        error = error.detail("available_bytes", available.to_string());
                    }
                    return Err(error);
                }
                outcome.insufficient_space = true;
                outcome.not_carried_count = Some(
                    plan.iter()
                        .filter(|path| {
                            matches!(path.action, CarryAction::Copy | CarryAction::Replace)
                        })
                        .count() as u64,
                );
                outcome.required_bytes = Some(required);
                outcome.available_bytes = available;
                let transaction = connection.transaction()?;
                record_outcome(&transaction, active, target, &outcome);
                transaction.commit()?;
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
        // Only files the active version actually has count as shipped.
        outcome.new_version_ships_file = shipped
            .into_iter()
            .filter(|path| {
                harmless
                    .iter()
                    .any(|relative| relative == path || relative.ends_with(&format!("/{path}")))
            })
            .collect();
        outcome.carried_bytes = outcome.carried.iter().try_fold(0_u64, |total, path| {
            total.checked_add(*inspected.sizes.get(path)?)
        });
        record_outcome(&transaction, active, target, &outcome);
        transaction.commit()?;
        Ok(Some(outcome.bounded()))
    }

    /// Whether an earlier attempt published part of a carry to `target`: a
    /// pending row from `active` whose bytes are in the target, or whose file
    /// is there but can't be read. The target must not then become active
    /// with only part of a carry.
    fn partial_carry_present(
        &self,
        active: &InstallRecord,
        target: &InstallRecord,
    ) -> Result<bool> {
        let connection = self.library.connection()?;
        let rows = carry_ledger::load(&connection, &target.id)?;
        let (target_root, _) = self
            .installed_mutability_qualification(target)?
            .carry_exclusions(target)?;
        for (path, stored) in rows {
            if !matches!(&stored.row.state, RowState::Pending { source_install_id } if *source_install_id == active.id)
                || crate::archive::validate_relative_path(&path, false).is_err()
            {
                continue;
            }
            let placed = path
                .split('/')
                .fold(target_root.clone(), |folder, part| folder.join(part));
            if std::fs::symlink_metadata(&placed).is_err() {
                continue;
            }
            match carry_step::hash_file(&placed, &|| Ok(())) {
                Ok(digest) if digest.sha256 != stored.row.sha256 => {}
                _ => return Ok(true),
            }
        }
        Ok(false)
    }

    /// Whether an installation is on a route Tier 2 carries for: the routes
    /// on which Tier 1 splits hazards from harmless files and that activate
    /// through Core's staged path (design section 1). Generated-cache and
    /// every other adapter never carry.
    fn carry_participates(&self, install: &InstallRecord) -> Result<bool> {
        let port = self.installed_port(install)?;
        Ok(port.adapter == crate::AdapterKind::NativePortable
            || crate::persistence::ready_staged_archive(&port)
            || port.n64_runtime_at_executable_parent)
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
}

/// Record the switch's outcome in the caller's transaction, bounded in bytes.
/// An outcome is never a reason to hold a switch whose files are published.
fn record_outcome(
    transaction: &rusqlite::Transaction<'_>,
    active: &InstallRecord,
    target: &InstallRecord,
    outcome: &CarryOutcome,
) {
    let mut paths = MAX_OUTCOME_PATHS;
    loop {
        let bounded = CarryOutcome {
            carried: outcome.carried.iter().take(paths).cloned().collect(),
            removed: outcome.removed.iter().take(paths).cloned().collect(),
            kept_separately: outcome
                .kept_separately
                .iter()
                .take(paths)
                .cloned()
                .collect(),
            source_unreadable: outcome
                .source_unreadable
                .iter()
                .take(paths)
                .cloned()
                .collect(),
            new_version_ships_file: outcome
                .new_version_ships_file
                .iter()
                .take(paths)
                .cloned()
                .collect(),
            insufficient_space: outcome.insufficient_space,
            source_modified: outcome.source_modified,
            counts: Some(outcome.complete_counts()),
            carried_bytes: outcome.carried_bytes,
            not_carried_count: outcome.not_carried_count,
            required_bytes: outcome.required_bytes,
            available_bytes: outcome.available_bytes,
        };
        let Ok(value) = serde_json::to_value(&bounded) else {
            return;
        };
        if serde_json::to_string(&value).map_or(0, |text| text.len()) <= 60_000 || paths == 0 {
            let _ = carry_ledger::put_outcome(
                transaction,
                &target.port_id,
                &active.id,
                &target.id,
                &value,
            );
            return;
        }
        paths /= 2;
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

#[cfg(test)]
mod disclosure_tests {
    use super::*;

    #[test]
    fn recorded_counts_and_bytes_survive_path_example_truncation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = crate::Library::open(temporary.path()).unwrap();
        let record = |id: &str| InstallRecord {
            id: id.into(),
            port_id: "lighthouse".into(),
            version: id.into(),
            path: temporary.path().join(id),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact: crate::ArtifactIdentity::default(),
            manifest_sha256: String::new(),
            selected_executable: std::path::PathBuf::new(),
            runtime: None,
        };
        let outcome = CarryOutcome {
            carried: (0..100)
                .map(|n| format!("{n}/{}", "x".repeat(2_000)))
                .collect(),
            carried_bytes: Some(900_000_000),
            ..Default::default()
        };
        let mut connection = library.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        record_outcome(&transaction, &record("source"), &record("target"), &outcome);
        transaction.commit().unwrap();
        let (_, _, value) = carry_ledger::outcome(&connection, "lighthouse")
            .unwrap()
            .unwrap();
        let text = value.to_string();
        assert!(text.len() <= 60_000);
        let disclosed = crate::carried_files::decode_outcome(&text).unwrap();
        assert!(disclosed.carried.len() < 64);
        assert_eq!(disclosed.counts.unwrap().carried, 100);
        assert_eq!(disclosed.carried_bytes, Some(900_000_000));
    }
}
