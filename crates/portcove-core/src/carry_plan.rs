//! Tier 2 carry planner (#5359 phase 5, T2-1).
//!
//! Pure eligibility rules and the per-path decision table from
//! `docs/design/tier2-unknown-file-carry.md` sections 1 and 4. Nothing here
//! reads or writes the filesystem or the database: callers supply each path's
//! digests and ledger rows and act on the returned plan. A path is only ever
//! replaced or removed in the target when the target's bytes are proven to be
//! an earlier copy of the source's file; every other difference keeps both
//! copies.

// T2-2 wires the planner into the carry step; until then only tests call it.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet};

use crate::PersistentFilePattern;

/// Lineage entries kept per path (design L1).
pub(crate) const MAX_LINEAGE: usize = 8;

/// The state of one ledger row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RowState {
    /// The version's copy was these bytes when Portcove last placed or
    /// recorded it.
    Present,
    /// Portcove intends to place these bytes, copied from the named install.
    Pending { source_install_id: String },
}

/// One `carried_files` row for an install and path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CarryRow {
    pub(crate) state: RowState,
    pub(crate) sha256: String,
    /// Oldest first, no consecutive duplicates, ends with `sha256`.
    pub(crate) lineage: Vec<String>,
}

impl CarryRow {
    pub(crate) fn present(sha256: &str, lineage: Vec<String>) -> Self {
        Self {
            state: RowState::Present,
            sha256: sha256.to_owned(),
            lineage: bounded_lineage(lineage),
        }
    }
}

/// What the target version holds at a path, from an exact parent listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TargetCopy {
    /// The parent exists with exact names and has no exactly named entry.
    Absent,
    /// An exactly named regular file with these bytes.
    File { sha256: String },
    /// A parent component is a file, a link or a case alias, or the
    /// destination is a non-regular object (rule 11).
    Blocked,
}

/// The facts the planner needs for one path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PathInput {
    /// The source's copy, when it is on the source's Tier 1 harmless list.
    pub(crate) source: Option<String>,
    pub(crate) source_row: Option<CarryRow>,
    pub(crate) target: TargetCopy,
    pub(crate) target_row: Option<CarryRow>,
}

/// Paths and names a carry must never touch, all relative to the
/// persistence root with `/` separators.
#[derive(Debug, Default)]
pub(crate) struct CarryExclusions {
    /// Persistent, shared, progress and runtime-mutable paths declared by the
    /// current definition, the target's retained contract and every retained
    /// installation of the port (rule 9, M3).
    pub(crate) declared_paths: Vec<String>,
    /// Declared filename patterns with their directory (rule 9).
    pub(crate) declared_patterns: Vec<(Option<String>, PersistentFilePattern)>,
    /// Members of the target's package (rules 7 and 8).
    pub(crate) target_members: Vec<String>,
    /// Generated metadata and receipt names of either version (rule 4).
    pub(crate) generated_metadata: Vec<String>,
    /// The target's Electron `resources` folder, when it has one (rule 6).
    pub(crate) electron_resources: Option<String>,
}

/// Why a path is never acted on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exclusion {
    InvalidPath,
    ShortName,
    PortcoveMetadata,
    GeneratedMetadata,
    LoaderName,
    ElectronResources,
    PackageMember,
    PackageFolder,
    Declared,
    CaseCollision,
    TargetBlocked,
}

/// What the carry does at one path (design section 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CarryAction {
    Nothing,
    Copy,
    Replace,
    KeepSeparately,
    Remove,
    Leave,
    Excluded(Exclusion),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlannedPath {
    pub(crate) path: String,
    pub(crate) action: CarryAction,
    /// The target's row once the switch is published; `None` means no row.
    /// Excluded paths leave every row untouched, so this is `None` for them.
    pub(crate) target_row: Option<CarryRow>,
}

/// Plan a switch to the target for every candidate path.
///
/// `paths` is the union of the source's harmless list and every path of the
/// source's rows (B1). `is_metadata` recognises Portcove's own receipt names
/// that live inside a version folder.
pub(crate) fn plan(
    source_install_id: &str,
    paths: &BTreeMap<String, PathInput>,
    exclusions: &CarryExclusions,
    is_metadata: &dyn Fn(&str) -> bool,
) -> Vec<PlannedPath> {
    let mut folded = BTreeMap::<String, usize>::new();
    for path in paths.keys() {
        *folded.entry(path.to_ascii_lowercase()).or_default() += 1;
    }
    paths
        .iter()
        .map(|(path, input)| {
            let exclusion = exclusion(path, input, exclusions, is_metadata).or_else(|| {
                (folded[&path.to_ascii_lowercase()] > 1).then_some(Exclusion::CaseCollision)
            });
            match exclusion {
                Some(reason) => PlannedPath {
                    path: path.clone(),
                    action: CarryAction::Excluded(reason),
                    target_row: None,
                },
                None => decide(path, input, source_install_id),
            }
        })
        .collect()
}

fn exclusion(
    path: &str,
    input: &PathInput,
    exclusions: &CarryExclusions,
    is_metadata: &dyn Fn(&str) -> bool,
) -> Option<Exclusion> {
    if crate::archive::validate_relative_path(path, false).is_err() {
        return Some(Exclusion::InvalidPath);
    }
    let components = path.split('/').collect::<Vec<_>>();
    if components.iter().any(|component| short_name(component)) {
        return Some(Exclusion::ShortName);
    }
    if components
        .iter()
        .any(|component| component.to_ascii_lowercase().contains(".portcove"))
    {
        return Some(Exclusion::PortcoveMetadata);
    }
    if is_metadata(path)
        || exclusions
            .generated_metadata
            .iter()
            .any(|name| name.eq_ignore_ascii_case(path))
    {
        return Some(Exclusion::GeneratedMetadata);
    }
    if components
        .iter()
        .any(|component| crate::install::is_loader_sensitive_name(std::ffi::OsStr::new(component)))
    {
        return Some(Exclusion::LoaderName);
    }
    if exclusions
        .electron_resources
        .as_deref()
        .is_some_and(|resources| related(path, resources))
    {
        return Some(Exclusion::ElectronResources);
    }
    if exclusions
        .target_members
        .iter()
        .any(|member| related(path, member))
    {
        return Some(Exclusion::PackageMember);
    }
    if let Some((parent, _)) = path.rsplit_once('/')
        && exclusions.target_members.iter().any(|member| {
            member
                .rsplit_once('/')
                .is_some_and(|(directory, _)| directory.eq_ignore_ascii_case(parent))
        })
    {
        return Some(Exclusion::PackageFolder);
    }
    if exclusions
        .declared_paths
        .iter()
        .any(|declared| related(path, declared))
        || declared_by_pattern(path, &exclusions.declared_patterns)
    {
        return Some(Exclusion::Declared);
    }
    (input.target == TargetCopy::Blocked).then_some(Exclusion::TargetBlocked)
}

/// Whether `path` equals, contains or sits inside `other`, ignoring ASCII case.
fn related(path: &str, other: &str) -> bool {
    let path = path.trim_end_matches('/').to_ascii_lowercase();
    let other = other.trim_end_matches('/').to_ascii_lowercase();
    path == other
        || path
            .strip_prefix(&other)
            .is_some_and(|rest| rest.starts_with('/'))
        || other
            .strip_prefix(&path)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn declared_by_pattern(path: &str, patterns: &[(Option<String>, PersistentFilePattern)]) -> bool {
    let (directory, name) = path
        .rsplit_once('/')
        .map_or((None, path), |(directory, name)| (Some(directory), name));
    patterns.iter().any(|(pattern_directory, pattern)| {
        pattern_directory.as_deref().map(str::to_ascii_lowercase)
            == directory.map(str::to_ascii_lowercase)
            && (pattern.matches(name) || pattern.matches(&name.to_ascii_lowercase()))
    })
}

/// An 8.3 short-name alias such as `PROGRA~1` (rule 2).
fn short_name(component: &str) -> bool {
    component.split_once('~').is_some_and(|(_, tail)| {
        tail.chars()
            .next()
            .is_some_and(|first| first.is_ascii_digit())
    })
}

fn decide(path: &str, input: &PathInput, source_install_id: &str) -> PlannedPath {
    let lineage = input
        .source_row
        .as_ref()
        .filter(|row| row.state == RowState::Present)
        .map(|row| row.lineage.as_slice())
        .unwrap_or_default();
    let target_unchanged = |bytes: &str| {
        input.target_row.as_ref().is_some_and(|row| {
            row.sha256 == bytes
                && match &row.state {
                    RowState::Present => true,
                    RowState::Pending {
                        source_install_id: source,
                    } => source == source_install_id,
                }
        })
    };
    let carried = |a: &str| {
        let mut next = lineage.to_vec();
        next.push(a.to_owned());
        Some(CarryRow::present(a, next))
    };
    let kept = |t: &str| {
        Some(match &input.target_row {
            Some(row) if row.sha256 == t && row.state == RowState::Present => {
                CarryRow::present(t, row.lineage.clone())
            }
            _ => CarryRow::present(t, vec![t.to_owned()]),
        })
    };
    let (action, target_row) = match (&input.source, &input.target) {
        (Some(a), TargetCopy::File { sha256: t }) if a == t => (CarryAction::Nothing, carried(a)),
        (Some(a), TargetCopy::Absent) => (CarryAction::Copy, carried(a)),
        (Some(a), TargetCopy::File { sha256: t }) => {
            if lineage.contains(t) && target_unchanged(t) {
                (CarryAction::Replace, carried(a))
            } else {
                (CarryAction::KeepSeparately, kept(t))
            }
        }
        (None, TargetCopy::File { sha256: t }) => {
            if input.source_row.is_some() && lineage.contains(t) && target_unchanged(t) {
                (CarryAction::Remove, None)
            } else {
                (CarryAction::Leave, kept(t))
            }
        }
        (None, TargetCopy::Absent) => (CarryAction::Nothing, None),
        (_, TargetCopy::Blocked) => unreachable!("blocked targets are excluded"),
    };
    PlannedPath {
        path: path.to_owned(),
        action,
        target_row,
    }
}

/// Collapse consecutive duplicates and keep the newest [`MAX_LINEAGE`] entries.
pub(crate) fn bounded_lineage(lineage: Vec<String>) -> Vec<String> {
    let mut collapsed = Vec::<String>::with_capacity(lineage.len());
    for entry in lineage {
        if collapsed.last() != Some(&entry) {
            collapsed.push(entry);
        }
    }
    let excess = collapsed.len().saturating_sub(MAX_LINEAGE);
    collapsed.split_off(excess)
}

/// Paths the planner would copy or replace, with no duplicates.
pub(crate) fn written_paths(plan: &[PlannedPath]) -> BTreeSet<&str> {
    plan.iter()
        .filter(|planned| matches!(planned.action, CarryAction::Copy | CarryAction::Replace))
        .map(|planned| planned.path.as_str())
        .collect()
}

#[cfg(test)]
mod tests;
