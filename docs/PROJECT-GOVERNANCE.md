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
- **Target release:** Public beta, 1.0, Post-1.0, Unscheduled for active work.
  Alpha 1, Alpha 2, Alpha 3, Beta 1, Beta 2, RC, V1 and Post-V1 remain historical options.
- **Release commitment:** Required, Planned. An unset value is explicitly
  unclassified.
- **Work type:** Workstream, Product feature, Port, Platform, Bug, Security,
  Research, Qualification, Technical debt, Documentation.
- **Workstream:** Core trust and recovery, Sources and ROM validation, Storage
  and library, Installation and updates, Desktop UX, CLI and integrations,
  Platform support, Port catalog, Release engineering, Documentation and
  governance.
- **Platform:** Unknown, All, Multi-platform, Windows, Linux, Steam Deck, macOS Intel,
  macOS Apple Silicon, Android, Not applicable.
- **Port stage:** Watchlist, Researching, Source contract known, Release
  integrity qualified, Cataloged, Automated qualification, Manual
  qualification, Supported, Blocked, Rejected.
- **Effort:** XS, S, M, L, XL, Unknown.

GitHub reserves the field name `Type` for its own item-type filter, so the live
single-select field is named `Work type`. It carries the exact requested Type
options and is the field referred to as “Type” in historical planning material.

Explicit blocking relationships express dependencies. Sub-issues organize work
but do not imply blockers by themselves. Do not copy blockers into a free-text
Project field.

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
  stage does not itself assert a recorded hands-on pass. The stage name is
  historical; it does not require a human operator when an agent can directly
  observe the same behavior on the runtime and any input or device relevant to
  the claim.
- **Supported:** historical entries require at least one declared platform in
  both legacy qualification arrays. New exact claims require matching scoped
  automated and hands-on records for the artifact, source contract, variant,
  representation, platform, and check version actually assessed. The visible
  support scope must identify which form applies. A port can therefore be
  Supported on Windows while declared Linux or macOS pairs remain unqualified,
  and a newly added artifact or source representation does not inherit the old
  claim.
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
and initializes neutral Watchlist fields. A public New
Port form submission enters the same contract when a maintainer runs
`normalize-port --issue <number>`. Normalization preserves contributor content,
requires the canonical `[Port]` title plus direct-upstream and lowercase
kebab-case game/target-key sections, rejects repository-wide duplicate catalog
IDs, keys, punctuation-normalized titles, and upstream/target identities,
reconciles one marker set, ensures one Project item, sets Work type to Port,
and fills neutral values only where fields are unset. Both intake paths preserve
existing parent relationships and leave unparented issues unparented.
Normalization is repeatable and never changes catalog support.

A port issue owns its direct upstream,
title identity, catalog ID when assigned, durable game/target key when it is a
non-catalog candidate, platforms, release integrity, source
contract, setup boundary, persistent data, adapter dependencies, stage evidence, blocker
and resume condition, automated and manual qualification, and completion
evidence. The live Port stage remains only in the Project; generated issue text
records its initial Watchlist state without copying mutable authority. The
Port Pipeline Project view is the complete inventory. Project membership with
Work type = Port defines coverage; a missing parent is not missing intake or
incomplete support. The former Continuous Port Pipeline (#16) is superseded by
this inventory and finite engineering issues; its retirement preserves historical
evidence and removes only its direct child links. Optional parent groups represent
bounded work with a meaningful completion condition, not numbered overflow
batches or a second inventory. Parentage alone does not create a blocking
dependency or release commitment. Intake must not depend on any parent's child
capacity, move existing parents, or create overflow workstreams.
Project drafts remain available for fleeting non-port ideas.

The canonical port issue persists across upstream versions. Completing its
current work does not change catalog support or qualification: Status and Port
stage remain independent. Retain canonical Project items, including completed
and deferred entries, so coverage stays auditable. Use linked, finite maintenance
issues for new work without duplicating the canonical Port record. Automatic
archival is not part of this lifecycle; archived-item coverage must be explicitly
validated before adopting an archival policy.

Live roadmap and provenance inventories read every page and require unique
record counts to match the reported totals. Missing pages, stalled cursors,
changing totals, or API failures invalidate the read; retry from the beginning.
The provenance generator leaves the previous snapshot intact when enrichment
fails. A successful traversal is a dated observation, not an atomic snapshot
of concurrent field edits.

Repository Node tools execute GitHub requests through the shared
`scripts/github-api.mjs` transport. GraphQL queries and variables are serialized
as one JSON stdin document rather than shell fields; REST bodies use the same
boundary. That transport owns response headers, quota evidence and generic Link
pagination, while this Roadmap client continues to own Project schema,
completeness, mutation and readback decisions.

Bulk Project field transitions retain a 100-assignment specification ceiling
but execute in verified chunks of at most 25 assignments. Before every chunk,
the client accepts only the declared source or already-applied target value,
samples the current GraphQL quota and preserves a recovery reserve. Every
mutation is read back before the next chunk; an ambiguous response is never
retried blindly. A partial run stops safely and the same specification can be
resumed because already-applied targets are reconciled explicitly. Full
readback and the Roadmap doctor remain the final success gate.

`roadmap.mjs set-many` and `pr-delivery.mjs watch|merge` retain their human
output by default. `--json` emits one schema-versioned operation envelope on
stdout with `planned`, `succeeded`, `partial`, `unknown` or `failed` status;
diagnostics stay on stderr and every status other than `planned` or `succeeded`
exits nonzero. JSON does not relax exact-head checks, mutation readback or
inventory completeness.

Repository issue coverage uses the REST issue collection, follows every
pagination link, validates opaque node IDs and issue numbers before filtering
pull requests, and requires an unchanged newest-record marker across the read.
ProjectV2 fields, items, views and dependencies remain GraphQL-owned; REST issue
coverage cannot substitute for those fields.

For more than one planned field transition, prepare an ignored JSON file under
`work/` and use `node scripts/roadmap.mjs set-many --spec-file <path>`. Each
transition records an exact `from` value (or `null` for unset) and configured
`to` value. The default is a read-only plan; add `--apply` only after reviewing
the resolved targets, already-applied transitions, observed GraphQL cost and
required reserve. Apply validates every target before one bounded mutation,
reads back each field exactly, and runs one final doctor. A current value equal
to `to` is an idempotent resume; any value other than `from` or `to` aborts the
whole batch before mutation. Keep a batch at or below 100 field assignments.

Live Roadmap commands serialize through an owned lock in the repository's
shared Git common directory, so sibling worktrees cannot independently consume
the local GraphQL budget. The lock does not coordinate other machines. Quota
headers, the pre-mutation reserve and exact readback remain authoritative when
another host uses the same account. Missing quota metadata or insufficient
reserve blocks mutation and reports the provider reset time.

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

Done means the acceptance criteria have matching evidence. Codex owns feasible
acceptance execution, failure investigation, bounded repair, a separate review
pass, and exact evidence; the owner is not a standing manual validation queue.
Acceptance names the behavior, exact artifact, environment, input, and retained
evidence rather than a human operator unless participation itself is the claim.
Direct agent-operated application or device observation can establish the same
functional claim as a person operating it. A fixture, browser preview, compiled
bundle, or injected input establishes only the behavior it actually exercises;
none becomes game-specific gameplay, installed-application, physical-device, or
human-subject evidence by relabeling. Code without passing evidence is not Done.
Human comprehension research needs actual participants and remains distinct
from functional acceptance. Close or merge only after required evidence exists;
keep unresolved intrinsic human or external work Blocked or Deferred with an
exact resume condition.

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
Routine authorized work follows mandatory CI, an actual separate non-writing
reviewer result, substantive finding repair, current-revision and authority
confirmation, then the guarded normal merge path. The exact incremental review
and evidence contract is owned by
[Contribution conventions](CONTRIBUTION-CONVENTIONS.md), not repeated here. An
implementation or continuation request authorizes that routine workflow within
its scope without repeated owner approval. Ask the owner only for an unresolved
blocker, intrinsically required manual participation, or authority not already
granted, and continue unrelated authorized work. Unavailable delegation holds
the affected merge, not every other lane. A timeout, cancellation, empty
response, or absence of comments is not a successful review. Administrator
bypass is emergency-only. Protected
acceptance, merge authority, signing/publication permission, credentials, and
other meaningful boundaries require separate owner authorization; candidates
cannot alter or self-authorize their own gate. Privileged handling treats
candidate code, artifacts, and text as untrusted and never executes them with
write or signing credentials.

Priority, horizon, and target release are forecasts. Release commitment records
whether the outcome is necessary for its applicable committed release. Required is a release gate; Planned is approved work expected to execute without making its absence alone a release blocker. Required
work remains a gate through genuine transitive blocking dependencies even if a
dependency is misclassified Planned, unclassified, or targeted later;
the tooling reports that conflict. Optional classification never excuses a
known safety failure in shipped scope. Reorder or edit Project fields instead
of rewriting repository documentation. New ports do not automatically expand
global V1 scope.

## Keeping current specifications readable

Prefer an existing canonical owner. Create a task only for independently owned,
scheduled, implemented or verified work; ordinary observations and evidence stay
with their owner. Durable Port records remain distinct from finite maintenance.
Keep near-term work executable and later approved outcomes visible without
speculatively decomposing every future step.

The issue body is the current specification: finite closure, delivered components
with scoped links, remaining acceptance and owners, genuine blockers/resume
conditions, and separately scoped later work. Integrate accepted amendments;
do not append contradictory overrides or copy entire child checklists into a
parent. Preserve superseded text and unique evidence in a dated linked issue
comment. Every applicable requirement must retain a current owner, not only an
archive. Refresh before writing, guard against concurrent edits and read back.

On completion or material scope change, reconcile the task, finite parent and
directly affected relationships. Closed can mean canceled, duplicate or superseded;
a merged component is not automatically an integrated or qualified outcome.
Credit completed slices and preserve valid historical completion. Aging and
missing evidence prompt investigation, not automatic closure or invented blockers.
Use targeted existing checks for ordinary maintenance; complete inventories and
readiness analysis serve migrations and release declarations, not every PR.

## Selecting approved work

Required determines release readiness. Planned is approved non-gating work that
runners are expected to execute by Priority, Horizon, readiness and Project order.
Use `roadmap.mjs next` as the common execution queue; a Required-only readiness
view is never the universal task selector. Deferred work remains inactive.

At a clean handoff, preserve healthy reservations and select useful disjoint work
across two cloud implementation lanes and the local runner, with independent
non-writing review. The objective is finishing the agreed beta: favor an accepted
beta outcome's exact remaining acceptance, a demonstrated prerequisite for several
beta outcomes or fitting frozen-cohort routes, or an actual implementation, review,
validation, integration or release bottleneck. Immediate safety/data-loss problems
and broken required validation retain precedence. This replaces rotation or
acceleration-first interpretations that indefinitely favor unrelated useful work.

Required alone is not a scheduling algorithm. A Planned task may be the best beta
accelerator; compare relevance, real dependencies, capable routes, accepted
ownership and expected benefit. Use existing Priority, Horizon and Project order,
not a new score or queue. Productive unrelated work remains eligible when no
available higher-value beta work can use that capacity. No fixed machine roles,
quotas, universal local-integration bottleneck or permission to leave a capable
lane idle is introduced. Apply reordered work only at safe boundaries.

For each selected outcome credit delivered acceptance, name the exact remaining
gap and select one bounded implementation or proof advancing closure. Identify
the applicable validation route and missing native/package scenario before
implementation where practical; arrange proof alongside the implementation.
Reuse adequate evidence at its actual inputs and scope across consuming owners,
without copying receipts or repeating qualification solely for multiple parents.
Small coherent PRs may advance an outcome in parallel through disjoint ownership.
Architecture inventory rows end in implemented, replaced/removed, or an
evidence-backed satisfactory/compatibility-retained disposition; file size alone
does not justify another required refactor. Design-system closure uses accepted
surfaces/states/references, not reopened stack selection or new aesthetic goals.

Every actionable Now/Next item has either an explicitly accepted assignment or an
ordered queue position from the live Project behind named work. Queue predecessors
express scheduling, not blocking dependencies. Recommendations are not reservations.
Before passing over executable work, record the concrete dependency, ownership
conflict, missing execution capability, urgent regression, or higher-value choice
in its owning issue/PR, including what it is queued behind and the resume condition.
Being Planned is never a reason. For comparably valuable executable candidates, prefer older
waiting work over repeatedly selecting new small tasks; use existing comments
and queue order to record repeated deferrals, without a new scheduler or ledger.

Preserve actual host/resource guards; do not serialize disjoint cloud work, make
every delivery wait for local integration, preempt healthy work, switch the
existing worker/reviewer models, add paid capacity, or require #284. Acceleration
issues identify a demonstrated delay, bounded repair and completion/no-change
decision. New tiny improvements cannot keep one outcome open indefinitely.

The existing nightly development report leads with accepted beta outcomes advanced,
frozen-cohort useful-route/final-disposition progress, and actual blockers or
acceptance queues. Show material Required and Planned delivery, accepted
assignments and repeatedly passed-over Ready Now/Next work with reasons and named
predecessors. Separate scope additions and bookkeeping corrections from delivered
acceptance; PR totals are supporting activity, not a release forecast. Reuse the
existing cadence and receipts, with no mandatory daily census, new reporting
service or recurring automation. Instructions alone do not prove adoption.

## Pickup, consumption and execution upkeep

The useful pickup guarantee is **the next real invocation or clean handoff**,
not continuous monitoring. The existing coordinator uses its connected runner
continuation route; verify the actual connection and worker response before
claiming dispatch or consumption. Instructions, Project changes and sent messages
do not wake a runner by themselves. No recurring trigger or new service is added.

At startup/resume, before selection, at clean handoffs, before review and before
final acceptance, refresh the relevant owner instructions, current specification,
planning fields, typed relationships, accepted reservation and source candidate.
Share reads within an unchanged stage; do not poll or repeat a complete inventory.
Use `just roadmap-next --json` for recommendations, then
`just roadmap-context --issue <number> --runner <identity> --json` for the selected
issue's full current specification and a compact requirements snapshot. Its scope,
planning, genuine prerequisites and completion organization are separate facets.
An optional `--consumed-file <path>` compares a disposable checkpoint; an exact
`--consumed-comment <exact-comment-url>` can recover an older consumption record.
`--reservation-comment <exact-comment-url>` supplies a raw reference, never a grant.
The stable `runner_coordination` object in `.github/roadmap.json` points to
[the operational issue](https://github.com/boburning/portcove/issues/1583) and
exactly three fixed lane comments. Dot alone edits these records until actual
lane edit permission and write identity are proven. Read the issue body and those
three stored IDs directly; never enumerate comments or use task history as an
ordinary context fallback. `--runner` names the actual visible instance bound to
the owning task's accepted assignment. GitHub actor identity, a declared snapshot
and a caller-reported identity do not prove native invocation, ACK or activity.
An explicit `--coordination-pr <number>` binds an owning evidence PR, not authority.

The body records accepted assignment IDs/generations, actual instances, reserved
scopes, pauses, pending transfers and fixed checkpoint pointers. Each checkpoint
keeps current task/source, phase, meaningful progress, next action, outstanding
request IDs/recipients/ACK states and necessary evidence only. Use direct connected
runner messages for attention; bind actual responses to the request ID, board and
checkpoint pointers, instance and assignment generation. Sent messages are not ACKs.
Exactly one primary coordinator serializes grants; GitHub edits, timestamps and
local locks are not cross-machine exclusivity. Preserve unresolved requests and
pauses. Staged state does not establish active cutover or adoption.

After an accepted assignment is delivered and its scope explicitly released, use
`execution_slot: "completed"`, `reserved_scope: null`, `intentional_pause: false`
and `released_reference` pointing to that owning issue's exact verified release
comment or an explicitly verified owning PR body pinned as
`https://github.com/<owner>/<repo>/pull/<number>#body-sha256-<64hex>`.
The PR must bind the owning issue, exact source and truthful merge state; preserve
its raw body hash and edited timestamp. A bare PR URL or GitHub authorship cannot
release scope. Open-PR transfers retain all remaining gates. Dot verifies the
actual source-owner release response against the accepted instance,
assignment and generation before editing. Retain the last accepted identity and
ACK; the fixed checkpoint binds that same tuple, uses phase `completed` or
`delivered`, and retains the release reference in its necessary evidence pointers.
This completes the assignment, not necessarily its broader owning issue. It grants
no active scope or new execution. Do not combine a completed and active assignment
for the same lane, drop unresolved requests, or infer a successor grant from age,
release, recommendation or an unacknowledged offer. Retain separately accepted
reviewed-waiting scope. Replace the completed current assignment only after an
explicit successor grant and actual ACK; its owning evidence preserves history.

Collection is bounded to four calls, at most15 seconds per request clipped to the
remaining monotonic60-second total,64KiB per response,8KiB board and4KiB per
checkpoint. The final coordination envelope, including carried baseline and
measurement metadata, has a12KiB ceiling and a6KiB design target. Report actual
UTF-8 bytes and bytes/4 token estimates, never billed tokens or claimed savings.
These limits do not truncate the complete relevant task specification or required
evidence. Missing, stale, malformed, oversized or unavailable state is UNKNOWN;
preserve existing grants and stop conflicting new grants rather than falling back.
Retain collected originals and hashes outside model context before interpretation.

Fresh pickup reads the complete current task acceptance and typed relationships.
Continuation validates the versioned baseline, exact four scopes, raw hashes,
edited timestamps and coordinator/assignment binding before suppressing unchanged
operational state. Timestamp-only edits are changes. Invalid baselines return the
full current state. Explicit `node scripts/roadmap.mjs history --issue <number>
[--coordination-pr <number>] --json` reads only that task's bounded recent50-record
window; uncovered absence/latest remains unknown. Exact legacy #793 links are
read-only evidence; no archive scans, writes or duplicate coordination issue.

Prepare a bounded task using approved acceptance: credit delivered components,
name the missing outcome, actual prerequisites, smallest implementation, capable
execution/validation route and reserved scope. Routine decomposition needs no
new owner prompt. Unresolved product choices remain proposals; issue prose,
Ready, a child or a fingerprint cannot approve expanded scope. Keep Required and
Planned executable, the frozen rollout and all existing release/safety boundaries.

Compare actual changes before invalidating work. Priority/order changes affect
the next safe selection; preserve healthy execution. Material acceptance changes
require an updated plan and only affected implementation, review and validation.
A trusted withdrawal or applicable safety stop prevents further unauthorized
execution/acceptance at the safest boundary while preserving work and evidence.
Editorial changes and ordinary progress do not restart an attempt. The hash
normalizes formatting/check marks and bare links in named evidence sections;
other prose may still flag comparison. It is not a semantic diff. A separate raw
observation hash guards receipt freshness, including literal content the comparison
hint may normalize. A raw-only difference does not establish a substantive change;
compare it, refresh the disposable context, and skip acknowledgment for routine
evidence/editorial changes. Neither hash causes dispatch, invalidation or a comment.
Read the complete relevant specification on fresh pickup; a validated continuation
may suppress unchanged text before output while retaining its raw observation
binding. Applicable owner direction and actual source/target drift still require
comparison through the existing delivery guards; no acceptance exemption is created.

After actual material consumption, retain the disposable context and plan
`just roadmap-acknowledge --context-file <path> --runner <actual-instance>
--action <actual-action-or-wait-reason> --evidence <exact-owning-evidence-reference>
--json`. This refreshes the four fixed records and task requirements, binds the
instance/task/generation and preserves existing request IDs/recipients and progress.
Send the planned response through the connected native route. Dot verifies the
actual response and alone edits the assigned fixed checkpoint in place after fresh
preimage/generation checks and unresolved-request preservation. Runner `--apply`
refuses under this coordinator-only contract; ordinary consumption adds no comment.
Duplicate current consumption requests are quiet. Routine reads never advance
meaningful progress. A stale baseline requires a fresh comparison. A changed
revision remains pending comparison until the actual worker response resolves it.
Keep attempted writes, transport response and exact readback distinct; after an
ambiguous write retain the intent and read back without automatic retry.

At a genuine safe checkpoint, `node scripts/roadmap.mjs handoff-offer --spec-file
<path> --json` plans a bounded offer without replacing the accepted assignment.
The spec binds request ID, actual instance, assignment/generation, owning issue,
exact source, bounded outcome/scope and evidence. Supporting tests, fixtures and
necessary inventory companions may belong to that finite outcome; a new product,
security, native or resource boundary requires an explicit amendment.
`handoff-return --offer-file <path> --runner <actual-instance> --disposition
accepted|declined|pending --evidence <exact-reference> --json` prepares a reported
response from the current source and reads only its exact owning issue comment or
bound PR evidence (at most two additional calls, 30 seconds and 64KiB per response).
Prefer the available connected route. An existing owning evidence surface may
carry the response when that route is unavailable, without a progress stream.
These commands cannot authenticate origin or wake a session. Dot must independently
establish actual delivery/invocation and freshly read the exact raw evidence and
edited timestamp before preserving an ACK through the existing checkpoint intent.
Caller fields, a receipt or GitHub authorship cannot supply that verification.
Missing transport/readback stays UNKNOWN and pending; duplicate exact returns
are quiet. Wrong or superseded tuples, changed evidence, unresolved requests,
pauses and completed releases remain preserved. Preimage checks and ambiguous
write/readback rules still apply; no automatic retry or global lock is added.

Prefer healthy cloud owners completing their delivery. A genuine cloud-to-Local
transfer requires the source owner’s explicit release and Local’s actual instance,
generation and remaining-scope ACK, serialized by Dot. Local then owns remaining
validation, repairs, independent review, evidence reconciliation and normal guarded
merge; do not bounce merge back to Cloud. Preserve Local’s existing work and guards.
Capability assistance alone transfers no ownership, and CI cannot prove native
Windows acceptance.

Exactly one implementation owner may hold conflicting scope. Preserve accepted
reservations and use direct existing runner messages for steers, grants and
observed acknowledgments, with compact durable state in the three fixed lane
checkpoints; owning issues/PRs retain only necessary task evidence. Retain exact comment links for later reads. Neither a
sent message nor a checkpoint establishes a grant, consumption or worker activity
without the corresponding actual response. Legacy #793 links remain read-only;
use only the configured operational issue; do not create another tracker or scan
that archive. Verify that this
common coordinator actually serializes grants across machines before claiming
cross-runner exclusivity. If that support is unverified, preserve reservations
and use only explicitly accepted assignments for conflicting work; report the
limitation. Independent read-then-post claims and a checkout-local process lock
are not cross-machine grants. Never reclaim a task solely because its timestamp
is old: confirm stop or explicit handoff. Disjoint work and existing machine
resource limits continue; recommendations do not create active reservations.

Every attempt maintains its canonical roadmap owner before switching, handing off
or ending. Search existing open/closed work; consolidate findings with their owner.
Record observation versus hypothesis, significance, affected acceptance, evidence,
next action and disposition: resolved here, actionable within authority, blocked
with resume condition, awaiting product decision, or deferred with revisit reason.
Use existing fields, not another status system. Create a separate issue through
supported intake only for independent ownership/scheduling/acceptance. Optional
discoveries do not become blocking children or release gates. A small repair may
join an owned branch only within its approved scope and proportionate review.
Execute an improvement before beta when it is a necessary repair, a safe bounded
part of current approved work, or a demonstrated recurring bottleneck likely to
repay implementation and qualification cost during remaining beta work. Favor
repairs unlocking several tasks or batches and record a brief qualitative reason;
do not invent savings or require formal estimates for small fixes. Capture does
not approve execution or expanded scope. Schedule speculative optimization, broad
fixture campaigns and optional refactoring later unless this test justifies them,
preserving approved status and discoverability. Keep acceleration finite rather
than turning a product repair into an environment program.

Distinguish product prerequisites from a runner's missing route, permission or
resource. Record the exact affected obligation, attempted remedies or why none
fits, alternative authorized routes and resumption condition. Continue unrelated
work. Recheck when the condition changes; remove resolved blockers from current
prose/fields, preserve historical evidence and reassess directly affected owners.
Refresh immediately before guarded writes and verify saved state, preserving
concurrent edits. If a write is unavailable, retain the exact unapplied update in
a durable handoff artifact and reconcile live state before any later retry.

After independently verified delivery, record exact evidence on the task,
reconcile its delivered scope and Project state, reassess the finite parent,
direct prerequisites and affected dependents (the inverse blocking consumers),
release/hand off the reservation, and select the next eligible
Required or Planned task within the authorized run. A closed child does not prove
parent completion; a later sibling does not keep a satisfied parent open. Include
a short discovery/update section in the ordinary handoff and nightly report:
canonical links, material changes/dispositions, actual owner decisions, consumed
versus pending requirements, accepted assignments/activity and concrete blockers.
Repeated unchanged reads create no dispatch or comment noise. This uses the
existing reporting flow, not another automation or ledger.

## Views and prioritization

The saved views are entry points into one Project, not independent authorities:

| View                                     | Question answered                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Product Outcomes                         | What meaningful outcomes are planned or delivered, grouped by release?                                                                     |
| Required for Beta / Required through 1.0 | Which direct Required outcomes remain?                                                                                                     |
| In Progress                              | Which issues are marked In progress or Validating? Confirm accepted reservations and observed runner acknowledgments on owning issues/PRs. |
| Next Queue                               | Which unfinished Now/Next work follows, including Required and Planned?                                                                    |
| Planned Additions                        | Which approved non-gating additions remain, across releases?                                                                               |
| Port Pipeline / Active Port Work         | What is the complete durable port inventory, and which port work is active?                                                                |
| Blocked & Deferred / Inbox & Triage      | What has a resume condition, and what still needs triage?                                                                                  |

`roadmap-outcome` is a presentation-only label on canonical finite product and
engineering outcomes, including completed outcomes. It does not classify every
execution task as a product outcome, change readiness, or select eligible work.
Keep accepted outcomes discoverable without an arbitrary display quota. Native
child completion is child progress, not effort percentage or release proof.

The Required views show direct gates, not complete release readiness. Use
`readiness --release <stage>` for genuine transitive prerequisites, classification
conflicts and missing coverage. Product Outcomes excludes Port records; the
complete Port Pipeline retains them. Native children remain expandable; collapsed
row counts must not count integrated parent/child scope as independent value or
replace complete readiness. In Progress does not infer assignment from
Now, and neither a status nor a recommended assignment creates a reservation.
`next` orders the common queue by Horizon, Priority and Project order; the manual
Next Queue view preserves Project ordering within those selection rules.

Configuration owns names, layouts, filters and visible fields. Supported API
readback also verifies grouping and sorting; changing those settings still needs
an authorized UI route. A successful bootstrap is not proof of built-in workflow
configuration. Reuse saved view identities when renaming instead of duplicating
views. Refresh and verify actual saved settings after changes.

`.github/roadmap.json` names `active_release`. Advancing Required for Beta is a
reviewed repository change: update that value, bootstrap the filter, verify saved
settings, run doctor, and record the change. This chooses a readiness commitment,
not an application version or publication authority.

Address immediate security or data-loss hazards and broken required validation
first. Then prioritize bounded, demonstrated development improvements before
ordinary feature expansion when they make remaining work faster, easier to
change, less repetitive or less failure-prone. This execution preference does
not change release commitments or turn optional cleanup into a prerequisite for
every feature. Manual order is the final tie-breaker within otherwise equivalent
work. A genuine dependency may move an item earlier; record the reason in the
issue rather than freezing the queue in docs.

Coordinate application maturity and compatible catalog freshness in these same
queues and views; no additional workstream is needed. A high-priority active Port
may be Planned for a release: its absence does not block that release,
and it participates in the execution queue. Keep work in progress bounded instead of promoting
the full pipeline. A feature freeze constrains application scope, not compatible
catalog growth through an implemented independent path. Until that path ships,
compatible additions may still use the ordinary application-release route.

When a finite component needs an earlier target than its parent outcome, give
only that independently verifiable slice a child and Project item. Parentage
does not block component development. Use one-way final-integration dependencies
and fixture-based component proofs; do not make an optional broad parent a
transitive release gate or mark planned phases complete.

Required through 1.0 shows direct cumulative Required work. The
derived `readiness` command and immutable snapshot compute the actual gate from
Required outcomes and genuine transitive `blocked by` relationships. They report
unclassified targeted work, dependency classification/target conflicts, safety
conflicts, missing Project dependencies, and cycles. Parentage and related-work
links alone never block a release. Unrelated unscheduled intake is not a gate.
Keep non-gating approved work Planned at the release where it may ship or Post-1.0
where that is its real target; do not distort forecasts merely to avoid a gate.

Initial Public beta officially targets Windows and ordinary Linux x86-64, with
actual qualification required before claiming support. #52 closes on the shared
verified updater and #224/#225 evidence for those platforms. Its authenticated
feed, trust, staging, busy-session, interruption, recovery, rollback/schema and
preservation requirements remain intact; #534's separately provisioned protected
delivery authority remains required. #52 and #246 have no reciprocal blocker.

The #917 design system, #921 development-agility consolidation, #925 domain and
lifecycle foundations and genuinely required supporting work remain Required
initial beta. Prioritize changes that improve development speed, explicit
ownership, deterministic testing and safe iteration. The frozen feasible backlog
rollout (#1422), repeatable onboarding (#254), truthful operation availability
(#1168/#1169), account-free artwork (#1155/#208/#206), compatible definition
delivery (#246), reusable public CLI/reference contracts (#30/#243), manual
plugin-free Desktop Steam route (#290) and shared Linux/controller/storage/process
safety remain required. Completed foundations remain consumed proof, not reopened
work. A representative pilot does not substitute for the committed rollout.

Steam Deck (#51/#213–#217/#535), macOS Intel/Apple Silicon (#45/#226), full
user-ready Playnite (#910), automatic Steam entry management (#292), physical Xbox
qualification (#44) and SteamGridDB (#527) are high-priority work during Public
beta, Required before 1.0. Their active target is 1.0; Deck's follow-up may be
described as Beta 2 without reusing the historical Project option. They do not
gate initial beta directly or transitively. #993 still owns the bounded selected-
stack/WebView compatibility decision and Windows/Linux evidence needed by #917;
practical macOS CI/build health and portable architecture remain. Qualification
of macOS packages/devices and Deck/Gaming Mode follows later. Neither Linux CI
nor desktop observations establish physical-device or Valve Verified claims.
Until qualified, those platforms are unqualified support targets even if an
available build works; no deliberate execution block is introduced.

Later owners consume shared foundations one way. #46 owns final production
requalification, including the intended later platform claims, without reopening
completed Windows/Linux beta acceptance. Provider usage stays optional at runtime;
default artwork needs no personal provider credentials. Independent component
proofs permit useful work before complete downstream product acceptance. Paid
signing, marketplace approval, continuous Steam synchronization, Decky and optional
package integrations do not become blockers. See [Delivery](DELIVERY.md).

Migrations are additive: retain historical options and completed targets, capture
a dated before-state, map affected active identities explicitly, read back each
change and preserve concurrent edits. Switch active views only after consistent
mapping. New milestone readiness refuses active legacy targets, Required work
without a target, status mismatches, unclassified targeted work and dependency
conflicts. A partial migration must not appear READY. Legacy stage invocations
retain historical cumulative semantics; they cannot declare new beta/1.0 readiness.

Candidate safety uses the existing metadata, package, CI/review and exact-byte
release checks. Cumulative milestone readiness is an additional requirement only
when declaring Public beta or 1.0; incomplete future capabilities do not block
an otherwise eligible development preview. This planning distinction does not
activate new publication authority or change current release invocations.

`roadmap.mjs candidate-scope --issues 123,456` evaluates an explicitly frozen
candidate's implementation scope and genuine transitive blockers independently
of cumulative milestones. Selected optional work still has to be complete when
included in that candidate; missing/unclassified dependencies fail closed. A
READY scope result never substitutes for package, CI, review, signature/feed or
publication-authority checks. Use `readiness --release "Public beta"` or
`readiness --release "1.0"` additionally for a maturity declaration.

Historical receipts retain Opportunistic. Readiness interprets that historical input as Planned, while active configuration uses only Required / Planned. Use `roadmap.mjs rename-commitment` for a read-only in-place option plan, then `--apply` for an ID-preserving rename with assignment readback. An already-applied rename is a no-op; competing old/new options refuse automatic consolidation.

## Tools and snapshots

Use `node scripts/roadmap.mjs capture-port` for direct maintainer port intake,
`normalize-port --issue <number>` for a public New Port form submission,
`capture-feature` for feature intake, `promote` for draft-to-issue conversion,
`set` and `move` for planning changes, `next` for the ordered work queue, and
`readiness --release <stage>` for dependency-derived release evaluation.
`doctor` verifies machine-readable identity, visibility, repository linkage,
field types/options, view layout/filter/visible fields, the one-port/one-issue
coverage contract across both repository issues and Project items, honest
Port-stage evidence and exact Supported platform intersections, final UX
origin ownership, supported-source plan ownership, active-release commitment
classification, and dependency-graph consistency. It requires every
canonical issue and every open repository issue whose title begins `[Port]` to
have exactly one Port item. It rejects missing markers, duplicate catalog IDs,
candidate keys, normalized title identities, same-upstream/same-target
identities, unsupported stage claims, Blocked entries without usable resume
conditions, and Rejected entries that still claim catalog support. Distinct
games or targets may share one upstream. Grouping and sorting are verified by readback; auto-add and completion workflows
remain explicit manual confirmations. `bootstrap` reconciles the live Project; ordinary CI runs
only the offline `check` and tests.

Before a tagged release, generate a dated readiness snapshot with
`roadmap.mjs snapshot`. Review and commit that immutable evidence document under
`docs/releases/`. It records what the Project and catalog said at one commit;
the live Project remains authoritative afterward.

Use `source-provenance-audit.mjs --live` when a dated source-support and durable
Port-ticket coverage record is needed. The command reads the raw catalog,
repository issues, and Project items; it writes only the explicitly selected
path under `docs/archive/`. The report records the exact catalog digest, dynamic
typed-source and issue counts, cataloged-versus-research scope, deterministic
identity and evidence gaps, exact qualification counts, duplicate/drift
findings, and a fingerprint of the timestamped Project context. It does not
change GitHub, the Project, or catalog support. Offline fixtures exercise the
same generator in ordinary CI without a token; live enrichment is explicit and
read-only, and a failed API read produces no partial snapshot.
