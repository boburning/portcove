# Tier 2: carrying files Portcove didn't install (design, November 15, 2026)

Historical design, revision 2. The planner (#6185), backup deduplication and
free-space checks (#6213), carry, and T2-3 visibility were implemented. The
[current contract](../ARCHITECTURE.md#unknown-player-side-files) explains which
files can be copied and how CLI and Desktop report the result for the active
target. The proposal below records the original decisions for
[#5359](https://github.com/boburning/portcove/issues/5359) at `2488ebb5d`.

## Summary

Tier 1 (#5487, `6c7bf42a7`) lets harmless undeclared files stay in a version
folder without holding anything, and backs them up in a separate area. An
update or rollback leaves them behind. Tier 2 copies them to the version being
activated. It follows one rule:

> Portcove overwrites or removes a file in the version being activated only
> when (a) the path is still eligible against that version, (b) those bytes are
> a recorded ancestor of the copy the player is leaving, and (c) that version's
> copy is unchanged since Portcove last recorded it. Otherwise each version keeps
> its own copy and Portcove says so. No version change is held because of these
> files, except while a file changes or can't be read during the copy.

The departing copy always stays in its own folder, and only proven, unchanged
ancestors are replaced, so newer data is never lost silently. Divergence is
reported, not held; the remedy is to delete one copy and switch again, and a
later in-app "use this copy" action can replace that (D2). No catalog field and
no per-route upkeep are needed.

## 1. Scope and candidates

**Participating routes.** These are the routes on which Tier 1 already splits
hazards from harmless files and that activate through Core's staged path:

- `native-portable`;
- ready `staged-source-portable` archives;
- N64 executable-parent.

`portable_runtime_unknown_files` returns nothing for any other adapter
(`service/native_portable.rs:549-553`). Staged activation is chosen at
`service.rs:3576`.

**Excluded routes:**

- **Generated-cache.** It activates inside `Installer::install_acquired` with no
  staged hook (`install.rs:1668`), and its contract forbids enrolling output
  from an older runtime (ARCHITECTURE, "Generated-cache maintenance").
- **PS1 managed builds, libultraship and other adapters.** They have no Tier 1
  split.
- **Preparation and source-only routes.** `ready_staged_archive` already
  rejects managed builds and setup helpers (`persistence.rs:200-231`).

**The planned set (B1).** For a switch from the active version A to the
target T, the planner considers the union of:

- A's Tier 1 harmless list from `verify_managed_with_unknown` (`install.rs:2094`),
  re-expressed relative to A's persistence root (`service.rs:6952`); and
- every path of A's ledger rows (section 2), including paths A no longer has;
  and
- every path of T's `pending` rows from A, so that a retry can remove a copy
  Portcove placed from A before A deleted it (T2-1 review N2).

A file of A outside its persistence root is not a candidate, so a renamed
wrapper directory (`Game-v1/` → `Game-v2/`) cannot strand a copy in a dead path.
A hazard anywhere in A is handled in section 4 (L5).

**Eligibility.** Every exclusion below is evaluated against T as well as A, and
applies to every planned **write and removal**. An excluded path is never acted
on: no copy, no removal, and no row for it is written for T. A's existing row
for it is frozen and ignored, never used as lineage or as the reason for a
removal. A path is excluded when:

1. any component fails `archive::validate_relative_path` (`archive.rs:280-316`):
   non-ASCII, `:`, reserved device names, or a trailing dot or space;
2. any component looks like an 8.3 short name (`~` followed by digits);
3. any component contains `.portcove`, ASCII case-insensitive (M5). This
   covers `.portcove-manifest.json`, `.portcove-launched`, the archive-data
   baseline (`service/psx_mod_data.rs:123`) and runtime-source markers
   `<name>.portcove-source.json` (`adapter.rs:1914-1919`);
4. it is one of A's or T's `generated_metadata_paths` (`adapter.rs:1680-1709`),
   or `psx_data_metadata_name` is true for it;
5. any component is a loader-read name under `is_loader_sensitive_name`
   (`install.rs:4956`), anywhere in the tree rather than only beside the
   program;
6. it is under T's Electron `resources` folder (`install.rs:5002`), matched
   ASCII case-insensitive (L3);
7. it equals, contains or sits inside T's package manifest members, or an
   ASCII case-alias of one;
8. its parent directory, other than the persistence root, directly contains a
   file that is a member of T's package (L4). This keeps added files out of
   shipped mod-package and asset folders, where a loader may read every file;
9. it equals, contains or sits inside a path that is declared persistent,
   shared, progress or runtime-mutable, or matches a file pattern, in any of:
   - the current catalog definition;
   - T's retained contract;
   - the retained contract of **any installation of the port** (M3), including
     A. This keeps Tier 2 off a path that an additive successor appended in some
     version, so `.portcove-archive-data-baseline.json` still matches when
     `require_adoptable` compares it (`archive_data.rs:455-487`, especially
     468-470);
10. it collides by ASCII case with another planned path;
11. at T, a parent component is a file, a link or a case-alias, or the
    destination is a non-regular object.

"Absent at T" means the path is eligible **and** T's parent directory exists
with exact names and has no exactly named entry. A path that exists only as a
case or 8.3 alias isn't absent; rule 11 makes it ineligible.

**Scenarios the rules must cover (B1):**

- **v2 ships `settings.ini`.** Its bytes d0 are in v1's lineage, and the player
  deleted the file in v1. Switching v1→v2, the path is a member of T's
  package (rule 7), so the removal is never planned. The package file stays
  untouched, v1's row is frozen, and the player sees nothing, because a
  package file is not theirs.
- **A carried path is later declared**, for example SMW `mods/preloaded/state.toml`.
  Rule 9 applies through the current catalog at once, so every row for that path
  freezes and Tier 2 stops touching it. The declaration's own reviewed
  transition owns it from then on. Tier 2 doesn't make declaring that path any
  easier: the #5881 receipt-scope conflict still applies to it.

**Partitioned `archive_data_compatibility_v1` and the additive successor.** In
a forward switch, appended paths are declared by T, so rule 9 excludes them and
`adopt_additive_archive_data` (`service/native_portable.rs:358`) stays their
only owner. In a rollback, the successor's appended paths are declared by A's
contract, and by rule 9 every retained installation's contract counts.
Predecessor copies therefore never receive Tier 2 writes at appended paths,
and the baseline that `record_additive_rollback_baseline` records
(`service/native_portable.rs:333`; `service/psx_mod_data.rs:135-178`) stays
valid. The archive-data namespace lives under `user/`, never in a runtime
folder.

**Super Mario World and A Link to the Past (D8).** PR #6177 binds both with
their new `mods/preloaded/state.toml` pair declared in `runtime_mutable_paths`
as disposable runtime output, as Sonic 2 does for `logs`. Declaring the pair
persistent would have widened the receipt-governed scope (#5881). Because the
pair is declared, rule 9 excludes it and Tier 2 never carries it. Managed play
never changes the selection from the package default.

## 2. Ledger

**Location: the library database (D5), library schema 61 (B2).** Schema 60 is
taken by PR #6166 for the catalog bound, and `database.rs:16` is 59 on
`2488ebb5d`. The migration adds two tables:

```
carried_files(
  install_id TEXT NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,              -- persistence-root relative, ASCII, '/'
  state TEXT NOT NULL CHECK(state IN ('pending','present')),
  sha256 TEXT NOT NULL,
  source_install_id TEXT,          -- install the bytes were copied from; NULL if recorded in place
  replaces_sha256 TEXT,            -- pending only: the present row it displaced
  replaces_lineage TEXT,           -- pending only: that row's lineage (JSON)
  lineage TEXT NOT NULL,           -- JSON array, <= 8 SHA-256, oldest first, no consecutive
                                   -- duplicates (L1), ends with sha256
  format INTEGER NOT NULL,         -- 1
  PRIMARY KEY(install_id, path))
carried_file_outcomes(
  port_id TEXT PRIMARY KEY, from_install_id TEXT, to_install_id TEXT,
  outcome TEXT NOT NULL, format INTEGER NOT NULL)  -- bounded JSON, section 7
```

A `present` row means "this version's copy of `path` was these bytes when
Portcove last placed or recorded it, and descends from `lineage`". A `pending`
row means "Portcove intends to place these bytes, copied from
`source_install_id`". The tables hold digests only, never bytes or restore
authority. They are separate from `user/<port>/`, from backups and from every
restore receipt.

Why a database and not a sidecar like #6107's
`.portcove-archive-data-baseline.json`:

- A file in a version folder can be written by the game or the player. A forged
  lineage would authorize overwriting their data.
- Rows follow installation IDs through relocation and transfer (`VACUUM INTO`),
  and removal deletes them by cascade.
- No new metadata name has to be excluded from verification, relocation and
  transfer.

**Older Portcove refuses rather than corrupts.** A newer schema is refused
with `KnownFailureCause::NewerLibrary` (`database.rs:1499-1514`). An installation
exported to another library loses its rows. Without rows, every divergence falls
to "keep separately", which is the safe side. Rows with an unknown `format` are
treated as no rows and are never rewritten. Carried files are ordinary harmless
files to any Tier 1 build.

**Migration-ordering test.** The existing contiguous-history tests
(`database.rs:2491`, `database.rs:2764`) must see 61 directly after #6166's 60.
A new test migrates a schema-60 library fixture to 61, then checks:

- both tables exist;
- the foreign-key cascade fires when an installation is deleted;
- `PRAGMA foreign_key_check` is clean.

If #6166 has not merged when T2-2 is ready, T2-2 rebases onto it rather than
taking 60.

**Atomicity and recovery.** Under the port lock, for each switch from A to T:

1. Plan read-only (section 4).
2. One transaction writes T's rows for each planned copy as `pending`, with
   `source_install_id` = A.
3. Sweep leftover `.portcove-carry-*` files in T, then run the free-space
   check (section 7) against what is still needed. The copy then runs in two
   phases (N1), so T never ends up with only part of A's files:
   1. **Stage.** For each planned copy, write a `.portcove-carry-*` temporary
      file in the nearest existing destination ancestor and hash it against the plan. Nothing at a
      destination path changes in this phase.
   2. **Verify.** Re-hash every source and every destination (M4) and compare
      with the plan (absent, or the digest the plan approved replacing).
   3. **Publish.** Only after every file is staged and verified, run the
      durability helper's replacing renames and the planned removals. This
      phase needs no new space. A fault point `CarryStaged` sits between
      verify and publish.

   A failure in stage or verify deletes every temporary file and changes
   nothing in T:
   - out of space (the check is a snapshot; another writer can fill the disk):
     destination creation, write, timestamp, sync or private retention failures
     with a storage-full error discard all private temporary copies before
     recording `insufficient_space` and allowing the switch to continue. The
     required-byte estimate is retained; an unknown current free-space reading
     is omitted. A cleanup failure holds. Source IO and publication errors do
     not use this nonblocking outcome, and an earlier partial publication still
     holds until the carry can finish;
   - a source changed during the copy: `carried_file_changed`, which holds;
   - a source locked by another program (a Windows sharing violation):
     `carried_file_unreadable`, which holds and is retryable; it is the only
     unreadable case that holds;
   - a source that can't be read for any other reason, such as a lasting
     permission error: that path stays in A with the `source_unreadable`
     outcome, and the rest carry (N5);
   - a T mismatch: that path is re-planned as "keep separately", and the switch
     writes nothing at it.

   Publish is not cancellable. Cancellation is checked only while planning,
   staging and verifying, so a cancel can't leave T half-published. Just before
   each rename or removal, Portcove re-checks that destination's size and
   mtime against the verify pass (a re-hash on any doubt); a mismatch keeps
   that path separate. A rename or removal can still fail without an
   interruption, for example an antivirus or sharing lock on Windows: that
   holds as `carried_file_unreadable`, A stays active, and T never becomes
   active with only part of the files published. A retry, or recovery after an
   interruption, finishes publishing from the staged files, or sweeps them and
   re-plans if any staged file no longer matches. Files already published are
   pending rows from A that match T's bytes, so a re-plan treats them as
   Portcove's own placement.

4. One transaction:
   - marks T's rows `present`;
   - records T's kept copies;
   - writes the departing source's rows (M1): `present`, `sha256` = a, lineage
     L_A + a, for each eligible path A has; and deletes A's rows for eligible
     paths A no longer has;
   - writes the outcome.
5. The existing `verify_critical` and pointer change follow in the same locked
   operation (section 3).

Every file write lands in T while A is still active and untouched, so an
interruption leaves A authoritative. A retry re-plans. A `pending` T row from
the same A, whose `sha256` equals T's current copy, counts as Portcove's own
earlier placement and may be replaced. Pending rows never count as lineage when
T is later a source. A `pending` row keeps the `present` row it displaced in
`replaces_sha256` and `replaces_lineage`, and the planner treats that copy as
recorded and unchanged. Otherwise a retry after an interruption before publish
would turn a planned Replace into "keep separately" and drop T's lineage
(T2-1 review N1). Rows written for A in step 4 are true whether or not the
pointer change happens: they describe A's copy at that moment, and A is only
modified while active. The status shows an outcome only while
`active == to_install_id`.

## 3. Update and where the carry step runs (M2)

`carry_unknown_files(active, target)` is a dedicated step. It is called only
where the pointer change follows in the same locked operation, and it is a
no-op when there is no active version or `active.id == target.id`:

| Path                     | Call site                                                                                                                        | Pointer change that follows                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Staged activation        | after `prepare_retained_install_data` (`service.rs:4256`)                                                                        | `library.activate_staged` (`service.rs:4258`)                            |
| Update reuse             | only when `activate` and `active.id != existing.id`, after `prepare_retained_install_data` (`service.rs:3547`)                   | `register_install(&existing, true)` (`service.rs:3548`)                  |
| Recovery, preparing      | before `library.activate_staged` (`recovery.rs:791-792`)                                                                         | the same call                                                            |
| Recovery, install intent | only when `operation.activate`, after `prepare_retained_install_data` (`recovery.rs:189-190`)                                    | `register_install(&install, operation.activate)` (`recovery.rs:204-206`) |
| Rollback                 | after `record_additive_rollback_baseline` (`service.rs:4068`), before `verify_critical_for_replacement` (`service.rs:4070-4071`) | `library.rollback` (`service.rs:4072`)                                   |

`prepare_retained_install_data` itself does not carry. That function also runs
for a stage-only reuse and for recovery's `register_install(&install, false)`.
Placing the step after it puts declared data and additive adoption
(`service/psx_mod_data.rs:882-887`) before the undeclared files, and keeps the
final `verify_critical` after the carry.

Staging uses the nearest existing destination ancestor on the destination
volume and creates no missing destination folders. Publication creates them
only after all copies verify, then rechecks the destination before its atomic
rename. Planning, staging and verification holds therefore leave no new empty
destination folders. A partial publication or prior process crash may still
leave folders; this does not authorize deleting them or player-created folders.

**Time under the port lock (N4).** Planning hashes the eligible files in A and
T, and staging hashes each copy again, so a large tree adds time to every
switch. The carry step:

- reports progress through the existing operation reporter, including on
  rollback, which gains a reporter for this step;
- checks for cancellation between files (`hash_stable_regular` already takes a
  checkpoint). Cancelling during stage or verify sweeps the temporary files
  and leaves the switch undone; this is the existing retryable state;
- may use a recorded (size, mtime) match to skip re-hashing an unchanged file
  at plan time only. It never authorizes a replacement or removal without a
  fresh hash.

Startup recovery runs the same step, with the same progress and cancellation.

**The new package ships a file at the path.** Rules 7 and 8 exclude the path,
so it is not carried and A keeps its copy. The outcome reports it as "the new
version has its own copy".

**Windows case and alias handling** (all platforms behave the same):

- candidates are ASCII-only;
- collisions are compared with ASCII case folding;
- an existing destination counts only through an exact parent listing;
- every parent must match exactly.

The re-hash before the rename (M4) means even an alias that resolves late can't
replace bytes the plan didn't approve. None of these rules hold the switch.

## 4. Rollback in both directions, repeated

Plan for each eligible path p. Here a is A's copy, t is T's copy, `L_A(p)` is
the lineage of A's `present` row (empty if A has none), and "T unchanged" means
T has a `present` row for p with `sha256 == t`, or a `pending` row from A with
`sha256 == t` (M1):

| A's copy             | T's copy | Condition                        | Action                              |
| -------------------- | -------- | -------------------------------- | ----------------------------------- |
| a                    | t = a    | None                             | Nothing                             |
| a                    | absent   | None                             | Copy a                              |
| a                    | t        | t ∈ `L_A(p)` **and** T unchanged | Replace t with a                    |
| a                    | t        | otherwise                        | **Keep separately**; reported       |
| absent, A row exists | t        | t ∈ `L_A(p)` **and** T unchanged | Remove t (A deleted its descendant) |
| absent               | t        | otherwise                        | Leave t                             |
| absent               | absent   | None                             | Nothing                             |

T's row after the switch:

- where T ends with a's bytes: `present`, `sha256` = a, lineage `L_A(p) + a`;
- where T keeps its own copy: its existing lineage if its row's `sha256 == t`,
  otherwise `[t]`;
- where T has nothing: no row.

Lineages collapse consecutive duplicates and keep the last 8 values (L1).
Truncation, a missing row or a changed T copy can only turn a replacement or
removal into "keep separately".

The table is the same for update, reactivation, rollback and a forward switch
after rollback. Core always knows which copy was played last, the active one,
without timestamps.

Worked cycle:

1. **v1 has d1, with no rows.** Updating to v2 copies d1. Both v1 and v2 get
   rows d1 / `[d1]`. v2 then changes the file to d2.
2. **Rollback.** v1's copy d1 is in `L_v2 = [d1]`, and v1's row says d1, so it
   is replaced. Both get d2 / `[d1,d2]`. v1 then changes the file to d3.
3. **Forward.** v2's d2 is in `[d1,d2]` and matches v2's row, so it is replaced.
   Both get d3 / `[d1,d2,d3]`.

If the player edits v2's folder while v1 is active, v2's copy no longer
matches its row. The next forward switch keeps both instead of overwriting
that edit.

**First contact after upgrading to Tier 2.** Pre-existing versions have no
rows:

- matching copies need nothing;
- a copy only A has is carried;
- differing copies are kept separately, which is today's behavior.

**Hazards in A (L5).** Activation and update already hold on a hazard in A
(`service.rs:3459`), and rollback checks only its target (`service.rs:4115`).
The carry step runs A's Tier 1 split. To keep rollback available as the way out
of a modified version, a hazard in A makes the carry step carry nothing and
record outcome `source_modified`. It doesn't add a hold to rollback. The
hazard itself keeps its existing holds elsewhere.

This reuses #6107's idea of a recorded baseline that marks a stale copy
(`archive_data.rs:455-487`), generalized to a short ancestry plus an
unchanged-since-recorded check. It keeps #6107's other properties:

- only the target is written (`archive_data.rs:489-512`);
- a retry is idempotent;
- stable hashing (`external_runtime.rs:571`);
- ordinary-file copying (`runtime_data_policy.rs:232`), extended with digest
  checks on both ends.

It drops #6107's divergence hold. Leaving both copies is a safe default for
undeclared files.

## 5. Backup and restore

Explicit and automatic backups copy the active version's files through Tier 1,
carried ones included (`copy_area` in `service/backups/unknown_files.rs`), and keep
the `unknown_files_v1` layout.

**Removal backups deduplicate (B3, D6 required).** `UnknownFileScope::Removal`
collects every version (`backup_unknown_files` in `unknown_files.rs`). Tier 2 puts identical
copies in several versions, so the caps would be reached because of Portcove's
own copies. The new layout is `unknown_files_v2`, written by removal backups
only:

- **The store.** The v1 folders, `unknown-files/<install>/<install path>`,
  so a player can still find a file by browsing. Each distinct (shared path,
  digest) is stored once, under the first installation (by id) that has it.
  The shared path is the file's path relative to its version's persistence
  root, which is how Tier 2 carries it, so versions whose top folders are named
  differently still collapse. A file outside that root is never collapsed.
  `unknown-files/index.json` (schema 2) lists every installation's copy with
  its digest and `stored_in` and `stored_path`, the folder and path that hold
  the bytes. (T2-1b chose this over a content-addressed `objects/` store, which
  players couldn't browse.)
- **The space check.** Owner decision, November 15, 2026: removal and explicit
  backups have no caps and need only the free space for what they store (the
  same reserve as section 7); automatic snapshots and the legacy Ghostship
  recovery snapshot keep Tier 1's caps. When there are unknown files, the check
  counts the saves and settings plus the stored copies. Only copies with the same shared path
  and size are hashed. Each stored copy is
  re-hashed after copying, and each collapsed copy's source afterwards, so no
  copy changes unseen during the backup. A write after the backup and before
  removal moves the folders is not covered, as in Tier 1. The removal review
  applies the same collapsed space check and shows the backup size.
- **The shared path** comes from the selected executable, as verification
  reads it. A version whose root can't be read keeps its own keys and never
  collapses, so this adds no new hold.
- **Only when needed.** A removal backup where nothing collapsed keeps
  `unknown_files_v1`, which older readers count.
- **The record.** Recorded beside, and outside, the content digest, like v1.
- **Older readers.** The manifest field is optional and unknown fields are
  ignored (`service/backups.rs:489-497`), so they still restore exactly
  `data/` and ignore the area.

This lands in T2-2 or before it.

**Restore does not write carried files back** (D3):

- The area is keyed by installation, and that installation may not be active
  or may no longer exist.
- Restore is about saves, whereas Tier 2's semantics apply to version switches.
- The automatic safety snapshot copies no unknown files past a cap
  (the `Automatic` arm of `backup_unknown_files`).

Restore leaves Tier 2 rows alone, and its copy still says "Restoring this
backup doesn't put them back."

## 6. Removal, relocation, transfer and preparation

- **Removal** (whole port, `library.rs:3461-3476`). Rows cascade with the
  installations. The backup is deduplicated as in section 5. The review still
  lists every version's copy, applies the collapsed space check and shows the
  backup size.
- **Output relocation and library transfer.** They still refuse any unknown
  file (ARCHITECTURE line 2649). Tier 2 doesn't make that worse: a carried file
  already exists in its source version, which was already refused. Rows survive
  both, because they are keyed by ID. Carrying harmless files with the reviewed
  tree is a later phase (D7).
- **Library information export and import.** The rows are not exported. An
  imported copy keeps separately until a lineage builds up again.
- **Preparation, source-only routes and generated-cache.** Unchanged.

## 7. Caps and holds

- **No fixed caps (D1, owner decision 2026-11-15).** The owner asked to drop
  the 1,024-file, 16 MiB-per-file and 64 MiB-total limits for carrying. There
  is no count or size limit on what Tier 2 carries. A fixed per-file limit
  would leave an undeclared save larger than it behind, which works against
  keeping player data.
- **Free-space check instead (N2).** Before staging, Portcove estimates the
  space the files actually to be copied need (the "copy" and "replace" rows;
  removals and unchanged paths don't count). Each file is rounded up to the
  volume's cluster size, or 4 KiB when that can't be read, plus a per-file
  allowance for directory and file-table overhead. The check requires that
  estimate **plus** a reserve left free afterwards of min(8 GiB, max(1 GiB, 2% of the
  volume)), measured with `fs4::available_space` on the target version's
  volume. The reserve keeps room for the next session's saves, collection and
  Portcove's own backups, so an automatic copy never leaves the drive nearly
  full.
- **Not enough room.** Portcove copies nothing and removes nothing, records
  `insufficient_space`, and the switch goes ahead. Nothing is held and nothing is
  truncated: all files stay in the version they came from.
- **Tier 1's caps bound only automatic snapshots** (`require_within_caps` in
  `unknown_files.rs`), not what is carried. Removal and explicit backups need
  only free space, and removal backups deduplicate so Tier 2's own copies need
  no extra space (§5, B3).
- **Disposable writers.** The reviewed lever is to declare them
  `runtime_mutable_paths`, as Sonic 2 does with `logs`
  (`crates/portcove-core/catalog/ports/sonic-the-hedgehog-2-recomp.json`).

**New holds.** Both are transient, retryable and leave A active and T's
approved state intact (L2):

| Cause                                                      | Code                      | When                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CarriedFileChanged { file, from_version, to_version }`    | `carried_file_changed`    | A source file's bytes differ from the plan during copying                                                                               |
| `CarriedFileUnreadable { file, from_version, to_version }` | `carried_file_unreadable` | A source or destination is locked by another program (a Windows sharing violation); other read failures keep that path separate instead |

Player copy, written per
[CONTENT-DESIGN](../CONTENT-DESIGN.md#results-cancellation-and-errors). Paths
and byte counts go in details.

- `carried_file_changed`: "A file in the game folder changed while Portcove was
  copying it to version {to}, so Portcove didn't switch versions. Version {from}
  is still the one Play uses, and no files were lost. Close the game if it's
  running, then try again."
- `carried_file_unreadable`: "Portcove couldn't read {file} to copy it to
  version {to}, so it didn't switch versions. Version {from} is still the one
  Play uses, and no files were changed. Close the game or any program using
  that file, then try again."
- Outcome `kept_separately` (count-aware): "{count} files Portcove didn't install
  are different in version {from} and version {to}, so each version keeps its
  own copy. To use one copy in both versions, delete the copy you don't want,
  then switch to version {from} and back to version {to}." Details list both paths for up to 64 files.
- Outcome `source_unreadable`: "Portcove couldn't read {file}, so it stayed in
  version {from}." Details give the path and the error.
- Outcome `new_version_ships_file`: "Version {to} comes with its own {file}, so
  your copy stayed in version {from}."
- Outcome `insufficient_space`: "Portcove didn't bring {count} files it didn't
  install to version {to}, because the drive doesn't have enough free space to
  copy them. They're still in the version {from} folder. Free up space, then
  switch to version {from} and back to version {to}." Details give both folders, the bytes needed and the
  bytes available.
- Outcome `source_modified`: "Portcove didn't bring files it didn't install to
  version {to}, because version {from} has changed or added program files.
  They're still in the version {from} folder."
- Outcome `carried`: no notice for small carries. When the carried bytes are large (over 256 MiB), the version's status says how much was carried, so per-version storage stays visible (N3). Technical details state the count and bytes.

The outcomes are a read model, `PortStatus.carried_files`, sourced from
`carried_file_outcomes`. They are not failures.

## 8. Test plan

Every lifecycle test drives the real `PortcoveService` paths: update, rollback,
activation recovery, backup, restore and removal.

**Unit tests:**

- the planner table, including "T unchanged" and pending rows;
- lineage collapsing and truncation;
- one case per eligibility rule in section 1, for both writes and removals;
- frozen rows after a path becomes excluded;
- the schema 60→61 migration-ordering test (section 2);
- an unknown `format` treated as no rows.

**Linux** (`service/native_tar_xz_tests.rs`, alongside the Tier 1 tests at
lines 257-534):

1. Update carries nested files across a wrapper-directory rename. The source
   copies stay in place, and both versions get rows.
2. Rollback, forward and rollback again: ancestors are replaced, and each
   departing copy is byte-identical after its switch.
3. An edit to the inactive copy, and a pre-Tier-2 divergence: both are kept,
   reported and never held. Deleting one copy and switching carries the other.
4. Removal propagates only with a lineage and an unchanged T copy.
5. The B1 scenarios:
   - v2 ships `settings.ini`, whose digest is in L_A, after the player deleted
     it in v1: the package file is untouched;
   - a carried path becomes declared: rows freeze and nothing is written there;
   - a path inside a folder that holds package files is never carried.
6. No fixed caps: more than 1,024 files and a file over 16 MiB are carried.
   With a stubbed available-space reading below the required bytes, nothing is
   copied or removed, the switch succeeds and the outcome is
   `insufficient_space`. Unchanged files don't count toward the bytes needed.
7. Hazards: a hazard in T holds as today. A hazard in A gives
   `source_modified` and still allows rollback. Hazards, loader names,
   `.portcove`-containing names, generated metadata, target members and
   catalog-declared or retained-declared paths are never carried.
8. Interruption at the new fault points `CarryPending` and `CarryPlaced`, plus
   the existing `ActivationMetadataCommitted` (`operation.rs:914`). Recovery
   through both `recovery.rs` paths finishes with no leftover temporary files,
   including when A changed before the retry.
9. `carried_file_changed`: the source changes during the copy. A T change
   between plan and rename (M4) re-plans as kept separately, and nothing is
   overwritten.
10. Stage-only reuse and recovery `register_install(false)` carry nothing (M2).
11. Restore writes no carried file. A removal backup with three identical
    copies stores the bytes once and stays within the caps (B3).
12. Removal cascades the rows.
13. Receipt route with an SMW-shaped fixture: a path declared in
    `runtime_mutable_paths` (`mods/preloaded/state.toml`) is never carried,
    while an undeclared sibling is; update, launch restore, backup and rollback
    succeed without `PortableDataContractChanged`.
14. Two-phase copy (N1): a simulated out-of-space error during staging leaves T
    unchanged, sweeps every temporary file, records `insufficient_space` and
    still switches; interruption at `CarryStaged` resumes or re-plans cleanly.
15. Free-space estimate (N2): cluster rounding and the reserve make a tree of
    many small files need more than its byte count; a stubbed volume just
    below the requirement carries nothing.
16. A source that stays unreadable for a non-sharing reason is kept separately
    and the rest carry; a sharing violation holds (N5).

**Windows** (`service/native_portable.rs` Windows module and
`native_portable_transition_tests.rs`):

1. A target member `Settings.INI` against a carried `settings.ini`.
2. An 8.3 alias.
3. A `resources` / `Resources` Electron case.
4. A read-only destination, and a sharing violation that raises
   `carried_file_unreadable`.
5. The Sonic 1 additive fixture
   (`compatible_archive_progression_sonic_additive_settings`,
   `service/native_portable.rs:4424`): appended paths are never carried in
   either direction, and the baseline still matches after carries between
   predecessor copies.

Hosted Windows partitions are the authority. Desktop and CLI get rendering
tests for every outcome and both causes.

## 9. Risks, decisions and phasing

**Risks:**

- **Newer settings can break an older version.** A carried newer settings file
  can break an older version after rollback. Declared data already carries
  that exposure, and the remedy is the same: delete the file in that version's
  folder.
- **Credential-like files are carried.** For example, SMW's `netplay_secret`,
  which is written only outside managed play. This adds no exposure: Tier 1
  backups already copy such files, and the copy stays inside the library.
- **Loaders that read folders the package doesn't ship.** Rule 8 only covers
  folders that hold package files. A loader that reads every file in a folder
  the package doesn't ship is not covered, but non-hazard data files only.
- **A large undeclared writer copies every switch.** With no caps, a
  multi-gigabyte undeclared cache is copied on each version switch and
  duplicated per version. The reviewed lever is to declare it
  `runtime_mutable_paths`. When the drive is short of space, nothing is carried
  (`insufficient_space`, which is visible).
- **Removal and explicit backups can grow large (N3).** Owner decision,
  November 15, 2026: they have no fixed caps and hold only when the library
  volume lacks space. The removal review shows the backup size, which stays
  until the player deletes the backup. Automatic snapshots keep Tier 1's caps.
- **Disk use grows with retained versions.** Each switch can leave another copy
  in a retained version, and nothing prunes retained versions; large carries
  are shown on the version's status (section 7).
- **Windows alias rules.** They are proven only on hosted Windows.

**Decisions** (critical reviewer's recommendation recorded; owner confirms):

| Decision                         | Recommendation                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| D1, caps                         | Owner decision 2026-11-15: no fixed caps; a free-space check carries nothing, without holding, when the drive is short |
| D2, divergence                   | Owner decision 2026-11-15: keep both and report. A later in-app "use this copy" action                                 |
| D3, restore write-back           | No                                                                                                                     |
| D4, removal propagation          | Only with the lineage, unchanged-target and eligibility proofs (M1, B1)                                                |
| D5, ledger                       | Owner decision 2026-11-15: library database, schema 61. A sidecar could be forged by the game or the player            |
| D6, deduplicated removal backups | Required, in or before T2-2                                                                                            |
| D7, relocation and transfer      | Later                                                                                                                  |
| D8, SMW and ALttP                | Bound in PR #6177 with the pair declared `runtime_mutable_paths`; Tier 2 never carries it                              |

**Phasing** (each phase is one reviewed PR; T2-2 has a critical reviewer from
the start, because it touches user-data loss):

1. **T2-1 Planner.** Pure eligibility and planner table, unit tests only, no
   behavior change.
2. **T2-1b Removal deduplication (D6).** `unknown_files_v2` for removal
   backups, with tests. It may merge into T2-2, but must not follow it.
3. **T2-2 Carry.**
   - schema 61 and its migration-ordering test;
   - the `carry_unknown_files` step at the five call sites;
   - both causes;
   - the Linux and Windows lifecycle tests;
   - the ARCHITECTURE update.
4. **T2-3 Visibility.** `PortStatus.carried_files`, CLI human output, Desktop
   version-details copy and locales.
5. **T2-4 (later, D7).** Relocation and transfer carry harmless files.
6. **T2-5 (later, D2).** An in-app "use this copy" action for kept-separately
   files.
