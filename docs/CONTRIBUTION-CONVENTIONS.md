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

## Branches

Use a descriptive lowercase kebab-case name under one of these prefixes:

```text
feature/  fix/  docs/  test/  refactor/  performance/
build/    ci/   chore/ release/
```

For example, use `chore/pr-conventions`, not an author- or agent-specific
prefix. `dependabot/` is reserved for the dependency service.

## Pull request description

Keep the five template sections in order:

1. **Linked issue** — use `Closes`, `Fixes` or `Resolves` only when the pull
   request completes the issue; otherwise use `Refs` or `Related to`.
2. **Outcome and scope** — lead with the user or maintainer outcome, then name
   important implementation boundaries and non-goals.
3. **Verification** — list exact commands and observed results. Distinguish
   automated, packaged, physical-platform and human evidence. Use
   `Not run — <reason>` or `Not applicable — <reason>` instead of silence.
   For an ordinary pull request, record the focused local checks, the selected
   hosted validation plan, and the required exact-head GitHub CI result
   separately. The selected plan may be focused fast validation, exhaustive
   qualification, or the narrow prose contract. `Not run — full local suite delegated to required exact-head CI` is valid when no task-specific acceptance requires
   an aggregate local run; it does not excuse pending or failed hosted checks.
4. **Review and risk** — identify the actual separate non-writing reviewer
   subagent and record its coherent baseline review against the exact head commit,
   findings, limitations, repairs, incremental re-review delta and final reviewed head,
   important invariants, and documentation impact. Implementer self-review may
   supplement this evidence but is not independent review.
   The existing Renovate fast-lane exception in `AGENTS.md` takes precedence for
   an exact head that `just renovate-check` classifies `merge-ready`: record the
   delivering agent's concise dependency diff and upstream review instead.
   A repair, controlled update or policy change retains independent review.
5. **Readiness and follow-ups** — state the live Roadmap status, merge authority,
   remaining blockers or linked follow-up issues, or `None`.

Before review and final acceptance, refresh applicable issue/Project requirements
and accepted ownership as well as the source candidate. Compare material deltas
under [Project governance](PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep):
reconcile superseded acceptance and repeat only affected obligations. A changed
fingerprint alone neither rejects sound work nor approves stale work. This does
not replace exact-head, relevant-target, independent review or protected gates.

One local runner owns routine delivery under the owner's single-runner decision.
Before resuming an existing candidate, verify source, current acceptance and
actual writer release; preserve commits, evidence and unresolved overlap.
A coordinator grant or ceremonial ACK is not required. Actual overlap blocks
only conflicting work. Independent review, validation, exact-head CI, distinct
acceptance and guarded merge remain required.

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

Keep the reviewed source head frozen while checks complete. Use
`just pr-watch --pr <number-or-url> --head <reviewed-head> --run <id> --attempt <number> --deadline <UTC-time>`
for one identified source-head workflow and the five checked-in required contexts.
Success also requires every context to identify a successful job in that exact
run attempt's complete job inventory; same-head checks from another run cannot
supply missing jobs.
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
not supply review, local, native, installed-app or merge authority. Once
the pull request is ready, conflict-free, reviewed under its applicable contract, authorized,
and all exact-head contexts are successful, use
`just pr-merge-rest --pr <number-or-url> --head <reviewed-head>` for the routine
immediate squash merge. It freezes and rechecks the source SHA and required
contexts, submits that exact SHA, and reads the remote state back before any
retry or local cleanup. Server-enforced review threads, permissions and
repository rules remain in force; the helper is a mechanism, not review or
merge authority, and is not an administrator bypass.

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
