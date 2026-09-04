# Project governance

The public, user-owned
[Portcove Roadmap](https://github.com/users/boburning/projects/1) is the sole live
planning authority. Project fields may change freely without a documentation
rewrite. GitHub issues preserve executable specifications and evidence;
repository documentation preserves stable contracts and dated snapshots;
`catalog.json` preserves actual port support.

Do not create a JSON ledger, `STATUS.md`, TODO list, milestone mirror, or second
planning service. GitHub milestones are not the target-release authority.

## Fields

The Project uses these single-select fields:

- **Status:** Inbox, Triage, Ready, In progress, Blocked, Validating, Done,
  Deferred.
- **Priority:** Urgent, High, Medium, Low, None.
- **Horizon:** Now, Next, Later, Someday.
- **Target release:** Alpha 1, Alpha 2, Alpha 3, Beta 1, Beta 2, RC, V1,
  Post-V1, Unscheduled.
- **Work type:** Workstream, Product feature, Port, Platform, Bug, Security,
  Research, Qualification, Technical debt, Documentation.
- **Workstream:** Core trust and recovery, Sources and ROM validation, Storage
  and library, Installation and updates, Desktop UX, CLI and integrations,
  Platform support, Port catalog, Release engineering, Documentation and
  governance.
- **Platform:** Unknown, All, Multi-platform, Windows, Linux, Steam Deck, macOS Intel,
  macOS Apple Silicon, Not applicable.
- **Port stage:** Watchlist, Researching, Source contract known, Release
  integrity qualified, Cataloged, Automated qualification, Manual
  qualification, Supported, Blocked, Rejected.
- **Effort:** XS, S, M, L, XL, Unknown.

GitHub reserves the field name `Type` for its own item-type filter, so the live
single-select field is named `Work type`. It carries the exact requested Type
options and is the field referred to as “Type” in historical planning material.

Issue relationships and sub-issues express dependencies. Do not copy blockers
into a free-text Project field.

## Lifecycle

```text
Non-port draft -> Inbox -> Triage -> Ready -> In progress -> Validating -> Done
                                  \-> Blocked
                                  \-> Deferred
```

Every independently catalogable or independently prioritizable port has
exactly one durable GitHub issue. Shared engineering and family issues may
coordinate several ports but never replace their individual issues.

`capture-port` creates the repository issue immediately, adds it to the Project,
and initializes neutral Watchlist fields. A port issue owns its direct upstream,
title identity, catalog ID when assigned, durable game/target key when it is a
non-catalog candidate, platforms, release integrity, source
contract, setup boundary, persistent data, adapter dependencies, stage, blocker
and resume condition, automated and manual qualification, and completion
evidence. The Continuous Port Pipeline is a parent workstream only. Project
drafts remain available for fleeting non-port ideas.

A promoted draft or port implementation issue must state:

- user outcome;
- current behavior and evidence;
- scope and non-goals;
- acceptance criteria;
- required tests;
- documentation impact;
- dependencies and blockers; and
- completion evidence.

`promote` refuses an incomplete draft unless `--spec-file` supplies all of those
sections. Preserve imported identifiers in one machine-searchable issue comment such as
`<!-- portcove-origins: PCV-REAUD-001 -->`. Group findings with one root cause;
create sub-issues only when they can be implemented and validated independently.

Final audit and implementation-plan origins also remain machine-searchable.
Every imported UX audit ID has exactly one canonical issue owner through a
portcove-ux-audit-origins comment, and the supported-source plan has one parent
owner, issue #36, through its portcove-origins comment. The roadmap doctor
rejects missing,
duplicate, malformed, unknown, or range-abbreviated UX IDs and rejects duplicate
or misplaced supported-source plan ownership.

## Working rules

Before substantial work, read the linked issue, its dependencies, and the live
Project fields. Move actionable work to In progress when implementation begins
and to Validating when code and review evidence are ready. Link the pull request
to the issue using a closing keyword when appropriate.

Done means the acceptance criteria have matching evidence. Code without passing
evidence is not Done. Manual gameplay, controller, signing, installer, or
physical-platform acceptance cannot be closed using synthetic tests alone.
Close or merge only after the required evidence exists; keep unresolved human
or external work Blocked or Deferred with an exact resume condition.

Priority and target release are forecasts. Reorder or edit Project fields
instead of rewriting repository documentation. New ports do not automatically
expand global V1 scope.

## Views and prioritization

Use Priority Stack for ordered Now/Next execution, Now Board for active flow,
Port Pipeline for continuous admission, Product Roadmap for non-port work,
Current Release for the earliest active target, Blocked & Deferred for resume
conditions, Inbox & Triage for intake, Steam Deck for that platform, and V1
Readiness for cumulative required gates through V1. The checked-in view schema
records machine-applied layout, filter, and visible fields separately from the
`manual_group_by` and `manual_sort_by` UI requirements. `bootstrap` cannot claim
those manual settings or the built-in workflows are configured.

`.github/roadmap.json` names `active_release`. Advancing Current Release is a
reviewed repository change: update that value, run `bootstrap`, confirm the view
filter and all nine manual grouping/sorting rules in the UI, run `doctor`, and
record the change in the release pull request.

Within the same horizon, address release blockers and safety failures before
optional scope. Manual order is the final tie-breaker. A dependency may move an
item earlier; record the reason in the issue rather than freezing it in docs.

## Tools and snapshots

Use `node scripts/roadmap.mjs capture-port` for fast durable port discovery,
`capture-feature` for feature intake, `promote` for draft-to-issue conversion,
`set` and `move` for planning changes, and `next` for the ordered work queue.
`doctor` verifies machine-readable identity, visibility, repository linkage,
field types/options, view layout/filter/visible fields, the one-port/one-issue
coverage contract across both repository issues and Project items, final UX
origin ownership, and supported-source plan ownership. It requires every
repository issue carrying the canonical port marker to have exactly one Port
item and rejects duplicate catalog IDs, candidate keys, normalized title
identities, or same-upstream/same-target identities. Distinct games or targets
may share one upstream. Grouping, sorting, auto-add, and completion workflows remain
explicit manual confirmations. `bootstrap` reconciles the live Project; ordinary CI runs
only the offline `check` and tests.

Before a tagged release, generate a dated readiness snapshot with
`roadmap.mjs snapshot`. Review and commit that immutable evidence document under
`docs/releases/`. It records what the Project and catalog said at one commit;
the live Project remains authoritative afterward.
