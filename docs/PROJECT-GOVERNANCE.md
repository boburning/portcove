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

## Port-stage contract

`Port stage` is a workflow and evidence summary, not a synonym for release
channel, catalog maturity, or Project Status:

- **Watchlist:** a durable non-catalog candidate with limited evidence. Project
  presence does not grant catalog support.
- **Researching:** active investigation of upstream identity, releases, source
  requirements, platforms, persistence, or adapter fit.
- **Source contract known:** required game/source identity and accepted
  revisions are sufficiently documented for implementation planning. No
  runnable release is implied.
- **Release integrity qualified:** at least one useful runnable artifact has a
  deterministic, reviewable integrity path for an intended platform. Portcove
  installation or gameplay has not necessarily passed.
- **Cataloged:** exactly one valid `catalog.json` ID exists, but no catalog-owned
  automated platform qualification has been recorded.
- **Automated qualification:** at least one declared platform has catalog-owned
  automated evidence, but no supported platform scope has completed the
  required hands-on evidence.
- **Manual qualification:** automated evidence exists and hands-on
  qualification is the active next or partially completed gate. This workflow
  stage does not itself assert a recorded hands-on pass.
- **Supported:** at least one declared platform is present in both
  `automated_tested_platforms` and `manually_validated_platforms`. The support
  claim is limited to that exact intersection, which must be visible. A port
  can therefore be Supported on Windows while declared Linux or macOS pairs
  remain unqualified.
- **Blocked:** progress cannot continue until a named external, source,
  hardware, upstream, or engineering condition is satisfied. The issue states
  the usable blocker and exact resume condition.
- **Rejected:** the candidate was reviewed and intentionally excluded. Its
  issue preserves the reason and evidence; a Rejected issue cannot
  simultaneously claim catalog support.

Supported never follows merely from an upstream stable channel, catalog stable
`support_tier`, successful download, catalog presence, or qualification of a
different declared platform. These concepts remain independent: upstream
release channel, catalog support tier or maturity, upstream project status,
catalog admission, source-contract coverage, automated qualification,
hands-on qualification, Project `Status`, and Project `Port stage`.

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
attaches it beneath #16, and initializes neutral Watchlist fields. A public New
Port form submission enters the same contract when a maintainer runs
`normalize-port --issue <number>`. Normalization preserves contributor content,
requires the canonical `[Port]` title plus direct-upstream and lowercase
kebab-case game/target-key sections, rejects repository-wide duplicate catalog
IDs, keys, punctuation-normalized titles, and upstream/target identities,
reconciles one marker set, ensures one Project item, sets Work type to Port,
fills neutral values only where fields are unset, and attaches the issue beneath
#16. It is repeatable and never changes catalog support.

A port issue owns its direct upstream,
title identity, catalog ID when assigned, durable game/target key when it is a
non-catalog candidate, platforms, release integrity, source
contract, setup boundary, persistent data, adapter dependencies, stage evidence, blocker
and resume condition, automated and manual qualification, and completion
evidence. The live Port stage remains only in the Project; generated issue text
records its initial Watchlist state without copying mutable authority. The
Continuous Port Pipeline is a parent workstream only. Project
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

Completion applies to the work promised. A port integration can be Done with
unknown gameplay evidence when its promised operations and required checks are
complete. Optional gameplay research is separate unless a concrete regression
makes it necessary; do not leave every untested port awaiting personal playtest.
This does not change legacy `Supported` intersections or fabricate qualification.
Unknown evidence alone is not a Blocked condition or a runtime availability rule.

One-port/one-issue identity is bookkeeping, not a per-release approval gate.
The planned acceptance publisher completes compliant candidates automatically,
with quiet success and deduplicated exceptions identifying affected operations,
failed rules, evidence and resume conditions. Discovery has no admission
authority. Engineering/policy/authority changes still require scoped review;
neither an agent nor a candidate may change its own protected acceptance rules.
Current repository review/security settings remain authoritative until a
separately authorized implementation establishes the scoped publishing path.

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

V1 Readiness includes every unfinished item targeted at any stage through V1;
it does not infer optionality from issue prose or parent/child relationships.
Keep optional prototypes, external participation/publication, and post-V1
extensions targeted Post-V1. Split a required outcome from an optional extension
when necessary, rather than adding a second gate ledger. Genuine implementation
dependencies use blocking relationships; parentage and related work alone do not
block a release. Check for cycles and paths from optional work into required gates.

The required verified application-upgrade outcome and the preferred Windows
in-app mechanism have separate scope. While the mechanism is planned pre-V1,
its unfinished issues remain visible in readiness. If an actual external
prerequisite prevents safe delivery, record the blocker and a reviewed explicit
scope/target decision on the canonical updater and release-engineering issues,
then retarget the affected mechanism issues together. A manual upgrade path
cannot close those in-app implementation issues. Package-appropriate upgrade
qualification stays required for declared platforms; cross-platform automatic
updating does not become a gate through association.

## Tools and snapshots

Use `node scripts/roadmap.mjs capture-port` for direct maintainer port intake,
`normalize-port --issue <number>` for a public New Port form submission,
`capture-feature` for feature intake, `promote` for draft-to-issue conversion,
`set` and `move` for planning changes, and `next` for the ordered work queue.
`doctor` verifies machine-readable identity, visibility, repository linkage,
field types/options, view layout/filter/visible fields, the one-port/one-issue
coverage contract across both repository issues and Project items, honest
Port-stage evidence and exact Supported platform intersections, final UX
origin ownership, and supported-source plan ownership. It requires every
canonical issue and every open repository issue whose title begins `[Port]` to
have exactly one Port item. It rejects missing markers, duplicate catalog IDs,
candidate keys, normalized title identities, same-upstream/same-target
identities, unsupported stage claims, Blocked entries without usable resume
conditions, and Rejected entries that still claim catalog support. Distinct
games or targets may share one upstream. Grouping, sorting, auto-add, and completion workflows remain
explicit manual confirmations. `bootstrap` reconciles the live Project; ordinary CI runs
only the offline `check` and tests.

Before a tagged release, generate a dated readiness snapshot with
`roadmap.mjs snapshot`. Review and commit that immutable evidence document under
`docs/releases/`. It records what the Project and catalog said at one commit;
the live Project remains authoritative afterward.
