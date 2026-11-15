# Tier 2: carrying files Portcove didn't install (design, November 15, 2026)

Status: **proposal for critical review**. Nothing here is implemented. Owning
issue: [#5359](https://github.com/boburning/portcove/issues/5359) phase 5. Once
the phases ship, the stable contract moves into
[ARCHITECTURE](../ARCHITECTURE.md#unknown-player-side-files) and this note
becomes dated design history. Line references are to `origin/main` `2488ebb5d`.

## Summary

Tier 1 (#5487, `6c7bf42a7`) lets harmless undeclared files stay in a version
folder without holding anything, and backs them up in a separate area. An
update or rollback leaves them behind. Tier 2 copies them to the version being
activated. It follows one rule:

> Portcove overwrites or removes a file in the version being activated only
> when those bytes are a recorded ancestor of the copy the player is leaving.
> If it can't prove that, both versions keep their own copy and Portcove says
> so. It never holds a version change because of these files.

The rule never silently loses newer data, because only provable ancestors are
replaced and the departing copy always stays in its own folder. It has no
dead-end holds: a divergence is reported, not held, and its remedy is to delete
one copy and switch again. It needs no catalog field and no per-route upkeep.

## 1. Scope and candidates

**Participating routes.** These are the routes on which Tier 1 already splits
hazards from harmless files and that activate through Core's staged path:

- `native-portable`;
- ready `staged-source-portable` archives;
- N64 executable-parent.

`portable_runtime_unknown_files` returns nothing for any other adapter
(`service/native_portable.rs:549-553`). These routes all switch versions
through `prepare_retained_install_data` (`service/psx_mod_data.rs:867-893`) or
`rollback` (`service.rs:4036-4073`). Staged activation is chosen at
`service.rs:3576`.

**Excluded routes:**

- **Generated-cache.** It activates inside `Installer::install_acquired` with no
  staged hook (`install.rs:1668`), and its contract forbids enrolling output
  from an older runtime (ARCHITECTURE, "Generated-cache maintenance").
- **PS1 managed builds, libultraship and other adapters.** They have no Tier 1
  split.
- **Preparation and source-only routes.** `ready_staged_archive` already
  rejects managed builds and setup helpers (`persistence.rs:200-231`).

**Candidate selection** happens under the port lock, after the target's
declared data restore and additive adoption.

1. Start from the departing active version's Tier 1 harmless list,
   `verify_managed_with_unknown` (`install.rs:2094`). That list already
   excludes:
   - the source's manifest members (`install.rs:2266-2270`);
   - its declared and retained mutable paths and patterns;
   - `.portcove-manifest.json`, `.portcove-launched`, generated metadata and
     PS1/archive-data metadata (`install.rs:2278-2290`);
   - every hazard (`install.rs:2311-2321`, `package_layout.rs:417`).

   Any hazard still holds the whole switch exactly as today
   (`service/native_portable.rs:571-579`).

2. Re-express each path relative to the source's persistence root
   (`service.rs:6952`), the working directory the adapter launches. A file
   outside that root is not a candidate. This keeps a renamed wrapper
   directory, such as `Game-v1/` becoming `Game-v2/`, from landing in a dead
   path.
3. Drop the path, so that it stays where it is, if any of these is true:
   - any component fails `archive::validate_relative_path`
     (`archive.rs:280-316`): non-ASCII, `:`, reserved device names, or a
     trailing dot or space;
   - any component looks like an 8.3 short name (`~` followed by digits);
   - any component starts with `.portcove`;
   - any component is a loader-read name under `is_loader_sensitive_name`
     (`install.rs:4956`), anywhere in the tree rather than only beside the
     program;
   - it is under the target's Electron `resources` folder
     (`install.rs:5002`);
   - it equals or is an ASCII case-alias of the target package's manifest
     members, or is inside one of them;
   - it equals, contains or sits inside a path that is declared persistent,
     shared, progress or runtime-mutable, or matches a file pattern, in the
     source's retained contract, the target's retained contract or the
     **current catalog** definition. The catalog check means a path that a
     later reviewed declaration claims, such as an additive successor's
     appended file, is owned by that declaration and never by Tier 2.
   - it collides by ASCII case with another candidate.

**Partitioned `archive_data_compatibility_v1` and the additive successor.** In
a forward switch, appended paths are declared by the target, so step 3 drops
them and `adopt_additive_archive_data` (`service/native_portable.rs:358`)
stays their only owner. In a rollback, the successor declares them, so they
never enter the source's list. The current-catalog check also keeps Tier 2
from writing an appended path into a predecessor copy. Such a write would
invalidate the rollback baseline that `record_additive_rollback_baseline`
records (`service/native_portable.rs:333`; `psx_mod_data.rs:123-178`) and
cause a false `appended_settings_diverged` hold. The archive-data namespace
lives under `user/`, never in a runtime folder, so Tier 2 never sees it.

**Super Mario World and A Link to the Past.** Tier 2 can be the answer.
Tier 1 is enough on its own to unblock them.

- **Why declaring the file fails.** The #5881 conflict comes from adding
  `mods/preloaded/state.toml` to `persistent_paths`. That widens the
  receipt-governed scope, which leads to `PortableDataContractChanged`.
- **Leaving it undeclared.** Both definitions declare
  `mods/state.toml` and `mods/state.toml.tmp`, but not `mods` or
  `mods/preloaded` (`catalog/ports/super-mario-world-recomp.json`,
  `.../the-legend-of-zelda-a-link-to-the-past-snes-recomp.json`). Left
  undeclared, `mods/preloaded/state.toml` is not a package member, not a
  hazard and not a loader name. It is therefore a Tier 1 harmless file today.
- **What adding a binding row changes.** It changes no persistence
  coordinate, so no receipt or contract check fires.
- **What Tier 2 adds.** It carries the file through rollback and forward
  switches. The old runtimes never read it.
- **Cost.** The selection is not in restorable backups, only in the
  unknown-file area. Managed play skips the launcher and so already uses the
  package default (`docs/qualification/mstan-snes-forward-2026-11-14.md`).

Recommendation: bind both routes with the file undeclared through their own
port PRs. This does not depend on Tier 2 landing.

## 2. Ledger

**Location: the library database, not the runtime folder.** It adds library
schema 60 (`database.rs:16`) with two tables:

```
carried_files(
  install_id TEXT NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,              -- persistence-root relative, ASCII, '/'
  state TEXT NOT NULL CHECK(state IN ('pending','present')),
  sha256 TEXT NOT NULL,
  source_install_id TEXT,          -- NULL when the target's own copy was kept
  lineage TEXT NOT NULL,           -- JSON array, at most 8 SHA-256, oldest first, ends with sha256
  format INTEGER NOT NULL,         -- 1
  PRIMARY KEY(install_id, path))
carried_file_outcomes(
  port_id TEXT PRIMARY KEY, from_install_id TEXT, to_install_id TEXT,
  outcome TEXT NOT NULL, format INTEGER NOT NULL)  -- bounded JSON, see section 7
```

A row means "this version's copy of `path` was these bytes when Portcove last
placed or recorded it, and descends from `lineage`". It stores digests only,
never bytes or restore authority. It is separate from `user/<port>/`, from
backups and from every restore receipt.

Why a database rather than a sidecar like #6107's
`.portcove-archive-data-baseline.json` (`psx_mod_data.rs:123`):

- The lineage is per port across two or more installations.
- Rows follow installation IDs through relocation and transfer
  (`VACUUM INTO`), and removal deletes them by cascade.
- No new metadata name has to be excluded from verification, relocation and
  transfer.

**Older Portcove refuses rather than corrupts.** A newer schema is refused
with `KnownFailureCause::NewerLibrary` (`database.rs:1499-1514`). An
installation exported to another library loses its rows. Without a lineage,
every divergence falls to "keep separately", which is the safe side. The
`format` column guards evolution within newer schemas: rows with an unknown
format are treated as no lineage and are never rewritten. Carried files
themselves are ordinary harmless files to any Tier 1 build.

**Atomicity and recovery.** The steps for each switch from the active version A
to the target T:

1. Plan (section 4) read-only.
2. One transaction writes T's rows for every planned copy as `pending` with
   `source_install_id = A`.
3. Write each file to a `.portcove-carry-*` temporary file beside its
   destination, hash it and compare with the plan. A mismatch raises
   `carried_file_changed`, and nothing is activated. Then publish it with the
   durability helper's replacing rename, or remove it for a planned removal.
4. One transaction marks those rows `present`, records T's own kept copies,
   and writes the outcome.
5. The existing `verify_critical` and pointer change run unchanged
   (`service.rs:4256-4258`, `library.rs:3414-3458`).

Every write lands in T while A is still active and untouched, so an
interruption leaves A authoritative. A retry, including activation recovery,
re-runs `prepare_retained_install_data` (`recovery.rs:190`, `recovery.rs:791`).
It overwrites a copy only if the copy equals a `pending` or `present` row of T
placed from the same A, or is in A's lineage. The bytes are then Portcove's own
earlier copy of A, so a retry is idempotent even if A changed in between. Leftover
`.portcove-carry-*` files are swept at the start of each carry into T. Pending
rows never count as lineage when T is a source, so a half-finished placement
can't vouch for bytes T doesn't have. The status shows an outcome only while
`active == to_install_id`.

## 3. Update

**When.** Only when a version becomes active: staged activation
(`service.rs:4256`), update reuse with `activate`, which calls
`prepare_retained_install_data` before `register_install` (`service.rs:3547-3548`),
and activation recovery. A stage-only update carries nothing. The step comes
after `restore_retained_user_data_to` and additive adoption, and before the
last `require_portable_target_transition` and `verify_critical`
(`psx_mod_data.rs:882-890`). Declared data is placed first, then the
undeclared files.

**The new package ships a file at the path, including as a case-alias.** The
path is not carried, because a package member is immutable. The source keeps
its copy, reported as "the new version has its own copy".

**Windows case and alias handling** (all platforms behave the same):

- Candidates are ASCII-only.
- A collision is compared with ASCII case folding.
- An existing destination counts only if its parent listing contains that exact
  name. A destination that exists but isn't listed exactly is a case or 8.3
  alias, so the copy is kept separately.
- Each parent directory created or reused must match exactly. A parent that is
  a file, a link or a case-alias keeps the copy separate.
- A non-file object at the destination keeps the copy separate.

None of these hold the switch.

## 4. Rollback in both directions, repeated

Plan for each path p, where a is A's copy, t is T's copy and `L_A(p)` is the
lineage of A's `present` row:

| A's copy            | T's copy | Condition                                   | Action                                               |
| ------------------- | -------- | ------------------------------------------- | ---------------------------------------------------- |
| a                   | t = a    | None                                        | Nothing. T row `present`, lineage `L_A(p)+a`         |
| a                   | none     | None                                        | Copy a. Lineage `L_A(p)+a`                           |
| a                   | t        | t ∈ `L_A(p)`, or T row from A with sha256 t | Replace t with a                                     |
| a                   | t        | otherwise                                   | **Keep separately.** T row `present` `[t]`; reported |
| none (A row exists) | t        | t ∈ `L_A(p)`                                | Remove t (A deleted its descendant)                  |
| none                | t        | otherwise                                   | Leave t                                              |

Lineages are truncated to the last 8 values. Truncation can only turn a
replacement into "keep separately". The table is the same for update,
reactivation, rollback and a forward switch after rollback, because Core
always knows which copy was played last: the active one. It never uses
timestamps.

Worked cycle. The update v1→v2 copies d1 and lineage `[d1]`; v2 changes the
file to d2. Rolling back replaces v1's d1, because it is an ancestor, giving
lineage `[d1,d2]`; v1 changes it to d3. Going forward replaces v2's d2, giving
`[d1,d2,d3]`. Each departing copy stays in its folder until the next switch
replaces it as an ancestor.

**First contact after upgrading to Tier 2.** Pre-existing versions have no
rows. Matching copies and copies only one side has carry normally. Differing
copies are kept separately, which is exactly today's behavior and never worse.

This reuses #6107's idea of a recorded baseline that marks a stale copy
(`archive_data.rs:455-487`), generalized from one rollback baseline to a short
ancestry. It keeps #6107's other properties:

- only the target is written (`archive_data.rs:489-512`);
- a retry is idempotent;
- stable hashing (`external_runtime.rs:571`);
- ordinary-file copying (`runtime_data_policy.rs:232`), extended with digest
  verification.

It drops #6107's hold. A divergence between undeclared files has a safe
default: leave both. The player-data owner, the canonical copy, isn't involved.

## 5. Backup and restore

Tier 1's area (`service/backups/unknown_files.rs:93-145`) already copies the
active version's files, carried ones included. Removal copies the files of
every version. Neither changes.

**Restore should not write carried files back** (recommended; decision D3):

- The area is keyed by installation, and that installation may not be active
  or may no longer exist.
- Restore is a time-travel operation on saves, whereas Tier 2's semantics
  apply to version switches.
- The automatic safety snapshot copies no unknown files past a cap
  (`unknown_files.rs:187-190`), so writing back could replace bytes that exist
  nowhere else.

Restore leaves Tier 2 rows alone. Its copy keeps saying "Restoring this backup
doesn't put them back." A later opt-in, "Also put back other files", is
possible if players ask for it.

**Risk: copies multiply.** Every retained version can now hold a copy, so the
removal backup can reach the 64 MiB cap sooner. Option D6 deduplicates the
unknown area by digest (`unknown_files_v2`).

## 6. Removal, relocation, transfer and preparation

- **Removal** (whole port, `library.rs:3461-3476`). The rows cascade with the
  installations. The removal backup and review are unchanged.
- **Output relocation and library transfer.** They still refuse any unknown
  file (ARCHITECTURE line 2649). Tier 2 does not make that worse: a carried
  file already exists in its source version, which was already refused.
  Database rows survive both, because they are keyed by ID. Recommended later
  phase (D7): copy harmless files with the reviewed tree and keep refusing
  hazards.
- **Library information export and import.** The rows are not exported. An
  imported copy keeps separately until a lineage builds up again.
- **Preparation, source-only routes and generated-cache.** Out of scope;
  unchanged.

## 7. Caps and holds

- **The caps.** They are Tier 1's constants (`unknown_files.rs:15-17`): 1,024
  files, 16 MiB each and 64 MiB in total. They apply to A's whole candidate set
  and are all-or-nothing.
- **Past a cap (recommended, D1).** Portcove carries nothing, writes no rows
  for T and records `over_cap` with the count and bytes. The switch goes ahead
  and every file stays in A's folder. This is not truncation. It matches how
  Tier 1 treats an automatic snapshot (`unknown_files.rs:187-190`), and it
  keeps "never jam" (ARCHITECTURE, "Update, rollback, collection and launch are
  never held by a cap").
- **Disposable writers.** The reviewed lever is to declare them
  `runtime_mutable_paths`, as Sonic 2 does with `logs`
  (`catalog/ports/sonic-the-hedgehog-2-recomp.json`). Without that, a growing
  writer is carried until it passes a cap.

**The one new hold** is transient and has an in-app remedy, retry.
`KnownFailureCause::CarriedFileChanged { file, from_version, to_version }`, code
`carried_file_changed`, is raised when a source file changes or can't be read
during the copy. It also covers a Windows sharing violation, which usually
means the game is running outside Portcove. Nothing is activated.

Player copy, written per [CONTENT-DESIGN](../CONTENT-DESIGN.md#results-cancellation-and-errors).
Paths go in details.

- `carried_file_changed`: "A file in the game folder changed while Portcove was
  copying it to version {to}, so Portcove didn't switch versions. Version
  {from} is still the one Play uses, and no files were lost. Close the game if
  it's running, then try again."
- Outcome `kept_separately` is shown on the version details after the switch,
  with a count-aware message: "{count} files Portcove didn't install are
  different in version {from} and version {to}, so each version keeps its own
  copy. To use one copy in both versions, delete the copy you don't want, then
  switch versions again." Details list each file's two paths, up to 64.
- Outcome `new_version_ships_file`: "Version {to} comes with its own {file}, so
  your copy stayed in version {from}."
- Outcome `over_cap`: "Portcove didn't bring the {count} files it didn't install
  to version {to}, because there are more than it can copy (up to 1,024 files,
  16 MB each and 64 MB in total). They're all still in the version {from}
  folder."
- Outcome `carried`: no notice. Technical details state the count.

The outcomes are a read model: `PortStatus.carried_files`, sourced from
`carried_file_outcomes`. They are not failures, so they get no
`KnownFailureCause`.

## 8. Test plan

Every lifecycle test drives the real `PortcoveService` paths: update, rollback,
activation recovery, backup, restore and removal. None calls the planner alone.

**Unit tests:**

- the planner table;
- lineage truncation;
- candidate exclusions, one case per rule in section 1;
- the migration to schema 60, including cascade on installation deletion;
- an unknown `format` treated as no lineage.

**Linux** (`service/native_tar_xz_tests.rs`, alongside the Tier 1 tests at lines
257-534):

1. Update carries nested harmless files when the wrapper directory changes, and
   the source copies stay in place.
2. Rollback, forward and rollback again: ancestors are replaced, and each
   departing copy is byte-identical after its switch.
3. Divergence: both kept, status lists them, nothing is held. Deleting one
   copy and switching carries the other.
4. A removal propagates only along the lineage.
5. Caps: exactly 1,024 files, 16 MiB and 64 MiB carry. One past any of them
   carries none, the switch succeeds and every file stays in place.
6. Hazards still hold the switch and are never carried. Loader names, `.portcove`
   names, target members and catalog-declared paths are never carried.
7. Interruption: new fault points `CarryPending` and `CarryPlaced`, plus the
   existing `ActivationMetadataCommitted` (`operation.rs:914`). Recovery
   finishes with no leftover temporary files, including when A changed before
   the retry.
8. `carried_file_changed` leaves the pointer and A unchanged.
9. Restore writes no carried file. Backups contain the carried copies in the
   unknown-file area.
10. Removal cascades the rows.
11. Receipt route with an SMW-shaped fixture (`mods/preloaded/state.toml`):
    update, launch restore, backup and rollback succeed with no
    `PortableDataContractChanged`.

**Windows** (`service/native_portable.rs` Windows module and
`native_portable_transition_tests.rs`):

1. A target member `Settings.INI` against a carried `settings.ini`: the member
   is unchanged and the copy is kept separately.
2. An 8.3 alias.
3. A read-only destination, and a sharing violation that raises
   `carried_file_changed`.
4. The Sonic 1 additive fixture: appended paths are never carried, and the
   baseline is undisturbed through predecessor→predecessor carries
   (`compatible_archive_progression_sonic_additive_settings`,
   `native_portable.rs:4424`).

Hosted Windows partitions are the authority. Desktop and CLI get rendering
tests for the three outcomes and the cause.

## 9. Risks, open decisions and phasing

**Risks:**

- **A carried newer settings file can break an older version after rollback.**
  This is the same exposure declared data already has. The remedy is the same:
  delete the file in that version's folder.
- **Carrying credential-like files.** The SMW `netplay_secret` is written only
  outside managed play. This adds no exposure: Tier 1 backups already copy
  such files, and the copy stays inside the library.
- **A large disposable writer suppresses carrying for everything else** (past a
  cap). It is visible as `over_cap`.
- **The Windows alias rules are only proven on hosted Windows.**
- **Copies multiply in removal backups** (D6).

**Open owner decisions (recommended option first):**

- **D1, caps.** Carry none and leave everything in place, with no hold. The
  alternative is to hold the switch past a cap. The owner wrote "hold rather
  than truncate"; this proposal reads all-or-nothing as satisfying that
  without jamming.
- **D2, divergence.** Keep separately and report. The alternative is that the
  active copy wins and the other copy moves to a Portcove area, which adds
  storage, caps and its own cleanup.
- **D3, restore write-back.** No.
- **D4, removal propagation.** Only along a proven lineage. The alternative is
  never.
- **D5, ledger location.** Library schema 60, with older Portcove refusing the
  newer library. The alternative is a per-installation sidecar file, which
  avoids a schema bump but needs new metadata exclusions everywhere.
- **D6.** Deduplicate the unknown-file backup area by digest, in phase T2-4.
- **D7.** Relocation and transfer copy harmless files, in phase T2-5.
- **D8.** Bind SMW and ALttP now under Tier 1, with the file undeclared.

**Phasing** (each phase is one reviewed PR; T2-2 gets a critical reviewer
from the start, because it touches user-data loss):

1. **T2-1 Planner.** Pure candidate selection and the planner table, unit
   tests only, no behavior change.
2. **T2-2 Carry.** Schema 60, placement in activation, reuse, recovery and
   rollback, the `carried_file_changed` cause, the Linux and Windows lifecycle
   tests, and an ARCHITECTURE update.
3. **T2-3 Visibility.** `PortStatus.carried_files`, CLI human output, the
   Desktop version-details copy and locales.
4. **T2-4 (optional, D6).** Deduplicated unknown-file backup area.
5. **T2-5 (optional, D7).** Relocation and transfer carry harmless files.
