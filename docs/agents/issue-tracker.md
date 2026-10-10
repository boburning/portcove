# Issue tracker: GitHub

Issues and executable specifications live in `boburning/portcove`.
Use the `gh` CLI and the repository Roadmap workflow.

## Authority and intake

Read `docs/PROJECT-GOVERNANCE.md` and load `portcove-roadmap` before intake
or planning changes. Reuse canonical issues and preserve completed work,
parent relationships, dependencies, and active reservations.

Use `node scripts/roadmap.mjs capture-feature` for feature intake. It creates
a Project draft; use `promote <draft-item-id> --spec-file <path>` with a complete
specification to create the durable GitHub issue. Use `capture-port` for direct
maintainer port intake and `normalize-port` for public New Port submissions.
Follow the owning workflow for other issue types and reconcile Project membership.

GitHub Projects owns priority, horizon, status, blockers, target release,
release commitment, and the port pipeline. Issues own specifications and
evidence; `catalog.json` owns actual support. Do not introduce a local
tracker, mutable status mirror, or competing planning authority.

## Reading and editing

- Read an issue: `gh issue view <number> --repo boburning/portcove --json number,title,body,labels`.
- For complete inventories, use pagination-aware API traversal rather
  than relying on the default issue-list limit.
- Use `gh issue comment`, `gh issue edit`, and `gh issue close` only
  within the user's authorized scope.
- Use the [guarded body operations](../DEVELOPMENT-TOOLS.md#generated-github-text)
  for file-based issue/PR bodies, exact edit preimages and remote readback.
- Use native sub-issues and blocking relationships through the Roadmap
  workflow. Preserve existing parentage; sub-issues alone are not blockers.
- Read back mutations and finish applicable Roadmap integrity checks.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill requests

"Publish to the issue tracker" means create or update the appropriate
GitHub issue through the owning workflow.

"Fetch the relevant ticket" means read the canonical issue and its
relevant comments, dependencies, and live Project fields.

Fetch comments only for exact relevant references or bounded recent history; the
default read does not enumerate comments.

## Wayfinding operations

This section applies only to an explicitly invoked wayfinding task.

A map is a finite decision effort represented by one canonical GitHub
issue labelled `wayfinder:map`. Its decision tickets use
`wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or
`wayfinder:task`. Ensure required labels exist within authorized scope.

Reuse canonical issues and preserve existing parentage. Link new tickets
as native sub-issues where appropriate; use native blocking dependencies
separately. Reconcile map and ticket Project membership and classification
through `portcove-roadmap`.

The frontier is the map's open, unblocked, unclaimed tickets that are
eligible under current Project fields and active reservations. Read all
pages of the relevant children and dependencies; order eligible tickets
using the live Project.

Claim by assigning the driving developer after checking reservations,
then read back the claim. Assignment coordinates work and does not grant
acceptance or merge authority.

Resolve a ticket by recording its answer and evidence in a comment,
closing it only when its promised outcome is complete, and adding a
title-linked context pointer to the map's Decisions so far. Reconcile
and verify Project state through the owning workflow.

The map indexes decisions; live scheduling and readiness remain in the
Project. Implementation arising from a decision follows Portcove's
normal issue, validation, review, and delivery contract.
