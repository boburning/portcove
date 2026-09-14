# Bounded engineering repair and resume

Portcove's initial autonomous-engineering slice maintains an explicitly
preauthorized pull request after implementation has begun. It does not select
arbitrary Ready issues and does not close parent #284. The live GitHub Project
and issue remain planning and acceptance authorities; the controller prompt and
deterministic planner only govern a bounded handoff episode.

`scripts/engineering-handoff.mjs` consumes one complete fresh snapshot of the
configured issue and PR. The input binds the current base/head, default-branch
controller revision and policy digest, an affirmative standing-authority record,
all five protected contexts with run/attempt/head identities, review threads,
exact review identity/time/evidence, live issue/Project status, active leases,
and counters.
It emits one content-digested action. Missing or stale authority fails closed.

The initial limits are one task per PR, two active repository tasks, two
transient-infrastructure retries, and three substantive repair attempts per
episode. Expired ownership can be reclaimed only after live reconciliation.
Execution first acquires a 30-minute lease, then advances explicitly through
authoring, validation, reviewing, and merge-ready phases; each transition
requires a new complete observation.
Engineering pause is independent from publication pause. Exact repeated actions
and exceptions are quiet after their digest is recorded in the existing PR or
issue. The freshness timestamp is validated but excluded from the semantic
action digest, so refreshing otherwise identical evidence remains deduplicated.
No new backlog, mutable repository ledger, service, or database is added.

The supported executor boundary is a subscription-backed Codex GitHub event task,
not a workflow that embeds API credentials. Its checked-in prompt is
`.github/codex/portcove-repair-resume.md`. It reads trusted controller policy from
the current default branch before candidate checkout, treats candidate material
as untrusted, and uses normal branch, CI, review, auto-merge, issue, and Project
operations. GitHub checks created by the default `GITHUB_TOKEN` do not prove that
another workflow or task started; the first controlled pilot must record the
actual task/thread, pushed repair, downstream check runs, review, merge, and
Project readback.

## One-time pilot setup

In ChatGPT on web or mobile, connect the `boburning/portcove` repository to Codex
and create one pull-request activity task. Put the exact pilot issue, PR, and
authorized workstream in the task configuration, then use the checked-in prompt
above. Do not configure a repository-wide Ready selector. This UI-only connection
is the single owner setup step; no token is copied into the repository or local
scheduled task.

Until that event task is connected and a controlled repair is observed, only the
deterministic fixture lifecycle is proven. The fixture covers substantive repair,
fresh review, normal merge eligibility, issue/Project finalization, check and
review refusal states, lease/capacity recovery, retries, pause, authority changes,
and deduplication. It is not evidence that a hosted coding task started, pushed a
repair, or reached terminal live state.

## Recovery and operator controls

- Set `engineering_paused` in the trusted controller input to stop new repair,
  review, or merge actions without affecting publication controls.
- Preserve branch and PR evidence when capacity or budgets are exhausted. Resume
  only after the action's recorded condition is satisfied and a new complete live
  snapshot is built.
- Treat a changed head/base/controller, incomplete Project traversal, missing or
  unexpectedly skipped check, unresolved thread, processing/silent/stale review,
  or changed protected policy as refusal evidence, never success.
- A confirmed post-merge defect receives a forward repair or tested/reviewed
  revert. Never reset main or undo unrelated work.
