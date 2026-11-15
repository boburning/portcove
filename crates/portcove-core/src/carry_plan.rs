//! Tier 2 carry planner (#5359 phase 5, T2-1).
//!
//! Pure eligibility rules and the per-path decision table from
//! `docs/design/tier2-unknown-file-carry.md` sections 1 and 4. Nothing here
//! reads or writes the filesystem or the database: callers supply each path's
//! digests and ledger rows and act on the returned plan. A path is only ever
//! replaced or removed in the target when the target's bytes are proven to be
//! an earlier copy of the source's file; every other difference keeps both
//! copies.
//!
//! Every path, in [`PathInput`] keys and in [`CarryExclusions`], is relative to
//! the persistence root with `/` separators, and so is the path the
//! `is_metadata` callback receives. T2-2 builds the exclusions with a single
//! constructor that re-roots install-relative lists (manifest members,
//! generated metadata, Electron resources) and working-root lists
//! (runtime-mutable paths), dropping entries outside the persistence root.

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

    /// The row's lineage, bounded and ending with its own bytes, whatever was
    /// read back from storage (L5).
    pub(crate) fn checked_lineage(&self) -> Vec<String> {
        let mut lineage = self.lineage.clone();
        if lineage.last() != Some(&self.sha256) {
            lineage.push(self.sha256.clone());
        }
        bounded_lineage(lineage)
    }
}

/// What the source version holds at a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SourceCopy {
    /// The source has no file at the path.
    Absent,
    /// A harmless regular file with these bytes.
    File { sha256: String },
    /// A file that could not be read at plan time (M3). It is never treated
    /// as absent, so it can't authorise a removal.
    Unreadable,
}

/// What the target version holds at a path, from an exact parent listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TargetCopy {
    /// No exactly named entry, and every existing parent component is an exact,
    /// non-alias directory. Missing parents count as absent; the carry step
    /// creates them.
    Absent,
    /// An exactly named regular file with these bytes.
    File { sha256: String },
    /// A regular file that could not be read; it is never replaced or removed.
    Unreadable,
    /// A parent component is a file, a link or a case alias, or the
    /// destination is a non-regular object (rule 11).
    Blocked,
}

/// The facts the planner needs for one path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PathInput {
    pub(crate) source: SourceCopy,
    pub(crate) source_row: Option<CarryRow>,
    pub(crate) target: TargetCopy,
    pub(crate) target_row: Option<CarryRow>,
    /// For a pending target row, the present row it displaced. A switch
    /// interrupted before publishing re-plans against that recorded copy, so a
    /// planned replacement doesn't turn into "keep both" (T2-1 review N1).
    pub(crate) target_replaces: Option<CarryRow>,
}

/// Paths and names a carry must never touch, all relative to the persistence
/// root with `/` separators.
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
    /// The source's file couldn't be read, so it stays in the source and the
    /// target is not touched (`source_unreadable`).
    SourceUnreadable,
    /// The target's file couldn't be read, so it is kept as it is.
    TargetUnreadable,
    Excluded(Exclusion),
}

/// How the carry changes one install's row for a path (M2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RowChange {
    /// Leave any existing row exactly as it is, including frozen rows.
    Untouched,
    /// Write this row, replacing any existing one.
    Set(CarryRow),
    /// Delete any existing row.
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlannedPath {
    pub(crate) path: String,
    pub(crate) action: CarryAction,
    /// The target's row once the switch is published.
    pub(crate) target_row: RowChange,
    /// The departing source's row, written in the same transaction (L6).
    pub(crate) source_row: RowChange,
    /// The source bytes the plan approved copying, for Copy and Replace.
    pub(crate) approved_source: Option<String>,
    /// The target bytes the plan approved replacing or removing. The carry
    /// step stages and verifies against these, never against a later look.
    pub(crate) approved_target: Option<String>,
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
    let colliding = case_collisions(paths.keys().map(String::as_str));
    paths
        .iter()
        .map(|(path, input)| {
            let exclusion = exclusion(path, input, exclusions, is_metadata).or_else(|| {
                colliding
                    .contains(path.as_str())
                    .then_some(Exclusion::CaseCollision)
            });
            match exclusion {
                Some(reason) => PlannedPath {
                    path: path.clone(),
                    action: CarryAction::Excluded(reason),
                    target_row: RowChange::Untouched,
                    source_row: RowChange::Untouched,
                    approved_source: None,
                    approved_target: None,
                },
                None => decide(path, input, source_install_id),
            }
        })
        .collect()
}

/// Paths whose spelling, or any of whose parent directories, collides by ASCII
/// case with another candidate, or where a file and a directory share a
/// folded name (rule 10, L3).
fn case_collisions<'a>(paths: impl Iterator<Item = &'a str> + Clone) -> BTreeSet<&'a str> {
    let mut spellings = BTreeMap::<String, BTreeSet<&str>>::new();
    let mut directories = BTreeSet::<String>::new();
    let mut files = BTreeSet::<String>::new();
    for path in paths.clone() {
        files.insert(path.to_ascii_lowercase());
        for (index, _) in path.match_indices('/') {
            let prefix = &path[..index];
            directories.insert(prefix.to_ascii_lowercase());
            spellings
                .entry(prefix.to_ascii_lowercase())
                .or_default()
                .insert(prefix);
        }
        spellings
            .entry(path.to_ascii_lowercase())
            .or_default()
            .insert(path);
    }
    paths
        .filter(|path| {
            let mut prefixes = path
                .match_indices('/')
                .map(|(index, _)| &path[..index])
                .collect::<Vec<_>>();
            prefixes.push(path);
            prefixes.iter().any(|prefix| {
                let folded = prefix.to_ascii_lowercase();
                spellings.get(&folded).is_some_and(|set| set.len() > 1)
                    || (files.contains(&folded) && directories.contains(&folded))
            })
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
    let path = path.to_ascii_lowercase();
    let (directory, name) = path
        .rsplit_once('/')
        .map_or((None, path.as_str()), |(directory, name)| {
            (Some(directory), name)
        });
    patterns.iter().any(|(pattern_directory, pattern)| {
        let folded = PersistentFilePattern {
            prefix: pattern.prefix.to_ascii_lowercase(),
            suffix: pattern.suffix.to_ascii_lowercase(),
            allow_empty_middle: pattern.allow_empty_middle,
        };
        pattern_directory.as_deref().map(str::to_ascii_lowercase) == directory.map(str::to_owned)
            && folded.matches(name)
    })
}

/// An 8.3 short-name alias such as `PROGRA~1`: any `~` followed by a digit
/// (rule 2).
fn short_name(component: &str) -> bool {
    component.match_indices('~').any(|(index, _)| {
        component
            .as_bytes()
            .get(index + 1)
            .is_some_and(u8::is_ascii_digit)
    })
}

fn decide(path: &str, input: &PathInput, source_install_id: &str) -> PlannedPath {
    let lineage = input
        .source_row
        .as_ref()
        .filter(|row| row.state == RowState::Present)
        .map(CarryRow::checked_lineage)
        .unwrap_or_default();
    // Portcove's own earlier placement from this source, interrupted before
    // the switch completed (M1).
    let placed_by_source = |bytes: &str| {
        input.target_row.as_ref().is_some_and(|row| {
            row.sha256 == bytes
                && matches!(&row.state, RowState::Pending { source_install_id: source } if source == source_install_id)
        })
    };
    // The present record of T's current bytes: T's row itself, or the row a
    // pending placement displaced when T still holds those bytes.
    let recorded = |bytes: &str| -> Option<&CarryRow> {
        match &input.target_row {
            Some(row) if row.state == RowState::Present => (row.sha256 == bytes).then_some(row),
            Some(_) => input
                .target_replaces
                .as_ref()
                .filter(|row| row.state == RowState::Present && row.sha256 == bytes),
            None => None,
        }
    };
    let recorded_unchanged = |bytes: &str| recorded(bytes).is_some();
    // T's copy may be replaced or removed only when it is a recorded ancestor
    // left unchanged, or Portcove's own interrupted placement from this source.
    let stale =
        |t: &str| (lineage.contains(&t.to_owned()) && recorded_unchanged(t)) || placed_by_source(t);
    let carried = |a: &str| {
        let mut next = lineage.clone();
        next.push(a.to_owned());
        RowChange::Set(CarryRow::present(a, next))
    };
    let kept = |t: &str| {
        RowChange::Set(match recorded(t) {
            Some(row) => CarryRow::present(t, row.checked_lineage()),
            None => CarryRow::present(t, vec![t.to_owned()]),
        })
    };
    let source_row = match &input.source {
        SourceCopy::File { sha256 } => carried(sha256),
        SourceCopy::Absent => RowChange::Delete,
        SourceCopy::Unreadable => RowChange::Untouched,
    };
    let (action, target_row) = match (&input.source, &input.target) {
        (_, TargetCopy::Blocked) => (
            CarryAction::Excluded(Exclusion::TargetBlocked),
            RowChange::Untouched,
        ),
        (SourceCopy::Unreadable, _) => (CarryAction::SourceUnreadable, RowChange::Untouched),
        (_, TargetCopy::Unreadable) => (CarryAction::TargetUnreadable, RowChange::Untouched),
        (SourceCopy::File { sha256: a }, TargetCopy::File { sha256: t }) if a == t => {
            (CarryAction::Nothing, carried(a))
        }
        (SourceCopy::File { sha256: a }, TargetCopy::Absent) => (CarryAction::Copy, carried(a)),
        (SourceCopy::File { sha256: a }, TargetCopy::File { sha256: t }) => {
            if stale(t) {
                (CarryAction::Replace, carried(a))
            } else {
                (CarryAction::KeepSeparately, kept(t))
            }
        }
        (SourceCopy::Absent, TargetCopy::File { sha256: t }) => {
            let deleted_descendant = input
                .source_row
                .as_ref()
                .is_some_and(|row| row.state == RowState::Present);
            if (deleted_descendant && stale(t)) || placed_by_source(t) {
                (CarryAction::Remove, RowChange::Delete)
            } else {
                (CarryAction::Leave, kept(t))
            }
        }
        (SourceCopy::Absent, TargetCopy::Absent) => (CarryAction::Nothing, RowChange::Delete),
    };
    // An unplanned path keeps A's row, so a later retry still has its lineage.
    let source_row = match action {
        CarryAction::Excluded(_)
        | CarryAction::SourceUnreadable
        | CarryAction::TargetUnreadable => RowChange::Untouched,
        _ => source_row,
    };
    let approved_source = match (&action, &input.source) {
        (CarryAction::Copy | CarryAction::Replace, SourceCopy::File { sha256 }) => {
            Some(sha256.clone())
        }
        _ => None,
    };
    let approved_target = match (&action, &input.target) {
        (CarryAction::Replace | CarryAction::Remove, TargetCopy::File { sha256 }) => {
            Some(sha256.clone())
        }
        _ => None,
    };
    PlannedPath {
        path: path.to_owned(),
        action,
        target_row,
        source_row,
        approved_source,
        approved_target,
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
