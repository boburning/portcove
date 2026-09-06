# Port parent retirement: migration and recovery record

> Dated migration evidence, not a second inventory, release gate, or support authority. Preparation is complete; the live migration is pending the tooling PR merge and final readback.

## Baseline and ownership

The [recovery manifest](2026-09-06-port-parent-retirement-before.json) records the
actual 100 direct children of #16 at capture time, their existing parents,
subtasks, blocking relationships, owners, states and Project fields, plus #16's
original body, state, Project fields and the existing view IDs/configuration.
Do not substitute a numerical issue range for this membership list.

The [live provenance baseline](2026-09-06-ports-inventory-before-retirement.md)
contains 186 canonical Port issues: 67 cataloged ports and 119 research candidates,
within 316 repository issues and 316 Project items. Coverage and Port-stage
validation report no errors. The doctor reports only the planned, unapplied
Active Port Work view as drift. These are observations at capture time, not
counts to enforce against unrelated future intake.

Of the direct children, 93 are Port records. The seven shared engineering owners
remain independent issues with their existing acceptance criteria:

| Issues | Responsibility retained |
|---|---|
| #135 | Managed PS1 manifest, source, toolchain and lifecycle contract |
| #136 | Generic ROM-first recompilation adapter |
| #137 | GameCube/Wii build and generated-data contract |
| #138 | Xbox 360 source composition and setup contract |
| #139 | Successor/alternative identity and preserved installation provenance |
| #177 | Neutral discovery observations and idempotent durable intake |
| #254 | Bounded authoring proposals through #246 acceptance authority |

Their current specifications already own the actionable work. #16 adds no
unique implementation requirement to transfer. Existing references to #16
become historical coordination links, not blocking dependencies. #246 retains
automatic admission/publication ownership. #16 itself has no parent, incoming
blockers, or issues it blocks at capture time.

## Ordered migration

1. Merge the tested tooling/documentation PR through normal required checks.
   Re-read the current repository, Project and relationships immediately before
   the migration. Stop if an unexpected new #16 child or a changed relationship
   would invalidate the captured scope. Preserve unrelated concurrent updates;
   refresh dated evidence and review any relevant differences before proceeding.
2. Use `RoadmapClient.reconcileViews` with a configuration containing only the
   new Active Port Work view and the existing Project field IDs. This adds or
   reconciles only that named view. Preserve every existing view ID, filter,
   layout and field set, especially Port Pipeline at `/views/4`. Confirm the
   new table groups by Status and sorts by Priority, then manual order, in the
   GitHub UI. Record its returned URL and any unapplied UI settings honestly.
3. For each captured child, re-read its parent and protected relationships,
   state, owners and Project fields. If its parent is #16, record a pending
   operation in the local migration journal, call `removeSubIssue` with the
   manifest's parent and child node IDs, and verify parent is now null before
   recording success. If already null, record a skip; never move a child from
   a different parent. Unexpected protected-state changes stop the migration
   for reconciliation rather than restoring stale values.
4. Resume an interrupted run from live readback. A pending entry is not proof
   of failure: first check whether the requested edge is already absent. Re-run
   only remaining authorized removals. Do not change child issue bodies,
   close children, edit their Project fields, or remove their own subtasks or
   blocking relationships.
5. Require #16's direct child list to be empty. Run the live doctor and a new
   provenance audit; compare canonical coverage, catalog hash, qualification,
   Required commitments, readiness and protected child state with the baseline.
   Retain new audit output as separate dated evidence. Do not edit the baseline.
6. Prepend the retirement notice below to #16's latest, verified original body,
   retaining all historical evidence and `PCV-DEF-007`. Fill in the actual merged
   PR, view and verification links. Then close #16 as completed and set only its
   Project Status to Done. Re-read to confirm these exact changes and all child
   invariants; log any partial failure. #16's retirement is not completion of
   the shared engineering work.
7. Record the merged revision, actual removed/skipped counts, checks and final
   readback as a dated addendum. Add partial completion evidence to #314 for
   complete pagination and failure regressions; keep #314 open for its remaining
   stale-blocker/source-evidence scope.

### Retirement notice to prepend

> **Retired as a continuous parent.** The Port Pipeline Project view is the
> complete port inventory; Active Port Work shows unfinished, non-deferred
> work. This issue is retained as historical evidence. Its former direct
> children remain independent and retain their own work, subtasks, dependencies,
> owners and qualification evidence. Earlier statements that this umbrella
> remains open or must be a parent are superseded by this retirement.

Completion evidence must link the merged tooling PR, the actual Project views,
this recovery manifest and the post-migration verification. Include the actual
removed/skipped counts. Preserve the original issue body after the notice.

## Recovery

Use the original manifest and the per-operation journal together. Restore only
links this migration actually removed, only while the child's current parent is
still null. Use `addSubIssue` with the captured node IDs, without any reparenting
override, and restore captured sibling order where possible. Stop if another
parent or newly consumed capacity prevents safe restoration; do not evict or
move unrelated work.

Restore #16's body/state/Status only when the current values still equal the
values written by this migration. Preserve concurrent edits instead of replacing
them with the snapshot. Do not restore child fields or dependencies, since the
migration does not write them. The additive view can remain if retirement is
rolled back; do not delete a view containing subsequent user customization.

Repeat the live doctor, coverage and relationship checks after recovery. Keep
the failure, recovery and before/after records; never rewrite historical audit
evidence to imply an incomplete migration succeeded.
