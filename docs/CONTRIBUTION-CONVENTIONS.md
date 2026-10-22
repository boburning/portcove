# Contribution conventions

Portcove uses one lightweight format for branch names, authored commits and
pull requests. The format makes intent and evidence easy to scan without
turning writing style into a merge gate. `.github/pr-conventions.json` is the
machine-readable contract; `just pr-check <number-or-url>` reports advisory
findings against a live pull request.

## Titles and authored commits

Use `type(scope): imperative summary` for pull request titles and commit
subjects. The scope is optional and names the narrowest useful area in
lowercase kebab-case.

Allowed types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`,
`ci`, `chore` and `revert`. Use `!` before the colon for an intentional breaking
change and explain the compatibility effect under **Review and risk**.

Keep the subject at 72 characters or fewer when practical and omit a trailing
period. Proper nouns may retain their normal capitalization. Examples:

```text
feat(desktop): show reviewed library transfer details
fix(core): retain source contracts after catalog updates
docs(repo): clarify release evidence
refactor!: replace the legacy public transport contract
```

Write each authored commit around one coherent change. Temporary fixup commits
may exist while a pull request is a draft, but update them to the standard
before marking it ready. Git-generated `Merge ...` and `Revert "..."` subjects
are exempt. Automated dependency pull requests retain their generated branch,
body and commit formats, while their pull request titles still follow the title
contract.

Port additions follow [integration ownership](CATALOG.md#integration-ownership):
prefer reviewed facts and upstream-supported preparation. A missing official
binary can justify useful existing-installation support, an upstream dependency
or product deferral. Preserve the canonical issue and evidence; a deferred route
is not delivered. When retiring a custom builder, trace and remove its creation
callers, tool/patch inventories, tests, capabilities and active instructions,
while preserving identified installed-state and recovery consumers.

## Branches

Use a descriptive lowercase kebab-case name under one of these prefixes:

```text
feature/  fix/  docs/  test/  refactor/  performance/
build/    ci/   chore/ release/
```

For example, use `chore/pr-conventions`, not an author- or agent-specific
prefix. `dependabot/` is reserved for the dependency service.

## Pull request description

Keep the four template sections: **Linked issue**, **Outcome and scope**,
**Verification**, **Review and risk**. Use a closing keyword only for completed
scope. State the concrete outcome, link exact-head required CI, identify the
review performed, source head and result under QUALITY, and record explicit
native/manual acceptance when required. Include material risks or limitations.
Local checks are optional and need no omission narrative. Drafts may say pending;
ready candidates carry final evidence in one current description. The advisory
`just pr-check <number-or-url>` is optional, including after body updates.

## Review and merge

At pickup, identify the available routes for publishing source, editing the PR,
reading checks/logs, observing complete closing relationships, performing an
expected-head merge and reading back its result. Local CLI installation or
authentication describes that transport only. If it is unavailable, inspect the
connected GitHub capabilities before declaring delivery blocked or requesting
owner intervention. Use existing scoped authorization; a tool inventory does
not grant missing permissions or protected authority.

For manually requested workflow qualification, complete substantive review and
the affected ordinary hosted jobs on the candidate before dispatching the full
run. Repair setup/producer failures first and repeat only invalidated work.
Nightly and release qualification keep their existing triggers.

Read requirements at pickup/resume and reuse them until material source or
requirements changes; refresh relevant authority before final merge or writes
under the [pickup contract](PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep).

One owner delivers each coherent candidate; independent local workers may continue.
Before resuming an existing candidate, verify source, current acceptance and
actual writer release; preserve commits, evidence and unresolved overlap.
A coordinator grant or ceremonial ACK is not required. Actual overlap blocks
only conflicting work. The narrow verified Renovate review exception is owned by [QUALITY](QUALITY.md#bounded-dependency-delivery).
Applicable review, required exact-head CI, explicit acceptance and guarded
merge remain required. Local feedback follows [QUALITY](QUALITY.md#required-hosted-baseline).

Record the reviewed source head, target tip used for the comparison, and actual
merge-base. If `main` advances without changing the source head, do not imply the
later target revision was tested. An unrelated target advance does not by itself
require a rebase, a full rerun, or a replacement review. A relevant dependency,
schema, generated contract, patch, or policy interaction does require focused
reconciliation.
Review may begin on an exact local commit and complete before expensive final
qualification. Blocking findings identify a concrete correctness, security,
data-loss, compatibility, or acceptance defect; a promised safety hole remains
substantive even when current configuration does not exercise it. Cosmetic
preferences, speculative generalization, and unrelated cleanup are nonblocking
unless acceptance says otherwise. Repairs return to the same reviewer for the
delta and affected interactions where practical. A new substantive finding still
blocks; there is no cycle count that creates approval.
Before merging, refetch the pull request, confirm its current head still equals
the reviewed head, confirm required checks and conflict-free mergeability, and
use the guarded command below. A changed source head requires applicable
current-head validation and review; administrator bypass remains outside the
routine path.

For sequential stacked delivery, finish the parent independently, compare its
delivered tree with the reviewed parent, then reconcile and review the child's
actual final head before expensive final qualification. Preserve exploratory
checks with their original head; equivalent trees do not replace current-head CI
or explicitly fresh/stateful acceptance.

For a current read-only delivery observation, use
`node scripts/pr-delivery.mts inspect --pr <number-or-url> --head <reviewed-head> --json`.
It reads the PR, target and complete required check inventories within the existing
sixty-second API collection budget, then brackets source/target/state readback.
Pending or failed checks and a changed requested head are successful observations;
incomplete or contradictory API reads fail with unknown coverage. It recommends
one next action without approving, starting a watcher, retrying or merging.

Optional `--evidence-file <absolute-reference-declaration.json>` supplies a small
reference declaration with `format_version: 1`, `pull_request`, and optional
`review`, `acceptance`, `watcher` entries. Each entry binds `head` and a
`reference: { path: <absolute-file>, sha256: <64-hex> }`. Review additionally binds
`target` and `result` (`clear` or `changes-required`); acceptance declares `result`
(`passed`, `failed`, `not-required`). Watcher binds `run`, `attempt`, and its
original absolute UTC `deadline`, which inspection never renews. Reference files
must be regular file leaves (symlink leaves are refused) up to64MiB; unavailable, changed or corrupt bytes,
source drift, review target drift and stale watcher identities remain unknown.
These are hashed references to declarations, not independently verified approval
or acceptance. The declaration is limited to8192UTF-8bytes. JSON and `--summary`
output are mutually exclusive and bounded to16KiB including the final newline.
Omitting references creates no new merge requirement; the owning acceptance and
actual separate review continue to govern delivery.

Keep the reviewed source head frozen while checks complete. Use
`just pr-watch --pr <number-or-url> --head <reviewed-head> --run <id> --attempt <number> --deadline <UTC-time>`
for one identified source-head workflow and the five checked-in required contexts.
Success also requires each context to match its latest authoritative job in the
same source-bound run. A selective retry may retain a successful independent job
from an earlier attempt; a newer failure or pending execution supersedes it.
Attempt-bound artifacts retain their producer/consumer chain. Changed artifact
inputs require rerunning that chain; cross-run checks cannot fill missing jobs.
Set the absolute UTC deadline once from the actual job start and configured
timeout, with a bounded allowance for collecting results; track queue time
separately. Resume with the same run, attempt, head and deadline. The former
invocation-relative `--timeout-seconds` option is removed because restarting it
extended the wait. The watcher polls silently every three minutes, caps its last
sleep to the deadline, and stops on changed identity, failed checks, terminal
missing gates, unavailable readback or expiry. Its JSON failure evidence retains
the binding, last observations and next action. Each read-only `gh` subprocess
has a fifteen-second limit; all reads and pagination for one observation share
a sixty-second collection budget. A resumed expired wait may collect evidence
once within that budget, but cannot start another polling interval. This bounded
read collection is separate from the retained execution deadline. Inspect
the identified run's jobs,
logs and available artifacts once; classify product, provisioning, resource or
authority failures from that evidence, then repair or retain a resumable
checkpoint. The watcher neither dispatches nor retries a run, and success does
not supply review, native, installed-app or merge authority. Once
the pull request is ready, conflict-free, reviewed under its applicable contract, authorized,
and all exact-head contexts are successful, use
`just pr-merge-rest --pr <number-or-url> --head <reviewed-head> --closure-intent-file <intent.json> --merge-message-file <message.json>` for the routine
immediate squash merge. It freezes and rechecks the source SHA and required
contexts, submits that exact SHA, and reads the remote state back before any
retry or local cleanup. Server-enforced review threads, permissions and
repository rules remain in force; the helper is a mechanism, not review or
merge authority, and is not an administrator bypass.

Supported PR body writes (`github-body.mts pr-create` and `pr-edit`) also require
`--closure-intent-file`. Its JSON is `{ "format_version": 1, "allowed_targets": [] }`
for a component PR. Allowed targets are independently declared
`owner/repository#number` identities, not extracted permissions from candidate
text. An allowlist does not require every permitted issue to be closed. Prefer
neutral references such as “Related to #244”; hazardous negated closing phrases
are refused rather than interpreted as natural language.

The delivery guard reads complete fresh closing-issue relationships, including
manual links, and checks the body, candidate commit messages and explicit squash
message. The message JSON contains `title` and `body`; those checked values are
submitted as the actual merge message and verified afterward. Body and linked
issue changes matter even at an unchanged source SHA. Unknown inventory refuses
delivery. An ambiguous mutation or changed post-merge state requires readback
and reconciliation, never an automatic retry or reopening.

These safeguards cover supported writers and guarded delivery. They do not
prevent arbitrary GitHub UI/API edits, and GitHub supplies no atomic relationship
precondition alongside the merge SHA guard. Hosted conventions remain advisory;
existing acceptance, review, current-target/composed-tree and merge authority
requirements remain separate.

### Connector delivery

When authenticated `gh` is unavailable, the supported GitHub connector can
publish a branch/PR and perform the authorized expected-head squash merge. Use
`pr-delivery.mts prepare-merge` and `verify-merge` to validate the supplied
observations through the same check/job, candidate-message and closure predicates
used by the CLI. The commands are offline validators; they never contact GitHub,
merge, retry, approve review or establish permissions. The
[connector operation](DEVELOPMENT-TOOLS.md#connector-delivery-observations)
describes collection, independent expectations and readback.

Keep actual review, acceptance, live repository rules and CI checkout provenance
separate from snapshot validation. Refresh relevant target interactions only;
retain unchanged evidence and the existing inspector/watcher reference format.
If a mutation reports an error, inspect remote state before deciding what remains.
A mismatched postmerge observation is an unknown outcome requiring reconciliation,
never permission to repeat the mutation.

Repository auto-merge capability remains enabled for an explicitly justified
deferred merge, but enrollment is not the routine path. Do not describe it as
preserving an external review across a later source-head change unless that
enforcement has been demonstrated; changed code still requires applicable fresh
review and validation.

Draft pull requests may say that verification or review is pending. Before a
pull request becomes ready, update its single description with final evidence
rather than appending a second narrative. Summarize evidence in GitHub-visible
text even when detailed artifacts are retained locally. Do not claim a command,
platform, gameplay observation, review or protected action that did not occur.

The checker is intentionally advisory. A warning asks the author to improve the
metadata or explain an exception; it is not an acceptance, review, security or
merge authority and is not a required status check.
