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
- **Platform:** All, Multi-platform, Windows, Linux, Steam Deck, macOS Intel,
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
Draft Project item -> Inbox -> Triage -> Ready -> In progress -> Validating -> Done
                                  \-> Blocked
                                  \-> Deferred
```

A newly discovered port normally starts as a draft item with its direct
upstream URL and why it may matter. Triage records initial platform,
source-contract, artifact-integrity, persistence, and adapter observations.
Promote it to a repository issue when it becomes Now, Next, Ready, In progress,
materially blocked, high priority, or otherwise needs durable discussion or
evidence.

An implementation issue must state:

- user outcome;
- current behavior and evidence;
- scope and non-goals;
- acceptance criteria;
- required tests;
- documentation impact;
- dependencies and blockers; and
- completion evidence.

Preserve imported identifiers in one machine-searchable issue comment such as
`<!-- portcove-origins: PCV-REAUD-001 -->`. Group findings with one root cause;
create sub-issues only when they can be implemented and validated independently.

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
Readiness for cumulative required gates through V1.

Within the same horizon, address release blockers and safety failures before
optional scope. Manual order is the final tie-breaker. A dependency may move an
item earlier; record the reason in the issue rather than freezing it in docs.

## Tools and snapshots

Use `node scripts/roadmap.mjs capture-port` for fast discovery,
`capture-feature` for feature intake, `promote` for draft-to-issue conversion,
`set` and `move` for planning changes, and `next` for the ordered work queue.
`doctor` and `bootstrap` inspect or reconcile the live Project; ordinary CI runs
only the offline `check` and tests.

Before a tagged release, generate a dated readiness snapshot with
`roadmap.mjs snapshot`. Review and commit that immutable evidence document under
`docs/releases/`. It records what the Project and catalog said at one commit;
the live Project remains authoritative afterward.
