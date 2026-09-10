# Repository settings

Portcove keeps its review, merge-message and private-reporting expectations in
version control even though GitHub stores the effective settings outside Git.
`.github/repository-ruleset.json` protects exactly `refs/heads/main`;
`.github/repository-security.json` names the repository, requires private
vulnerability reporting and auto-merge capability, and selects the pull request
title with a blank generated body for merge commits. The allowed merge methods
remain merge, squash and rebase. Contribution wording and the advisory checker
are documented in [Contribution conventions](CONTRIBUTION-CONVENTIONS.md).

The `Protect main` ruleset blocks deletion and force-pushes, requires a pull
request and resolved review threads, and requires the `catalog`,
`dependency-review`, `frontend`, `rust`, and `rust-quality` checks from
`.github/workflows/ci.yml` against an up-to-date main revision. Required
approvals are zero; last-push and mandatory CODEOWNERS approval are disabled.
GitHub's additional-approval setting for unattributed Copilot pull requests is
retained but has no effect when required approvals are zero. The only bypass
actor remains the built-in repository-admin role restricted to pull requests;
it is emergency-only, never the routine solo-maintainer path.

Repository auto-merge capability is enabled, but pull requests are not enrolled
automatically. Routine authorized work must still have all mandatory checks, an
explicit separate review result with substantive findings repaired, resolved
threads, and current revision/authority confirmation before normal auto-merge.
Candidate-controlled workflow changes cannot establish or remove their own
trusted gate. Fully unattended engineering requires a separately implemented
trusted controller and end-to-end negative/recovery proof; this policy change
only removes the second-approver bottleneck.

Validate the local artifacts without GitHub access:

```bash
node scripts/repository-settings.mjs --validate
```

An authenticated repository administrator can inspect the exact bounded delta,
reconcile it, and then verify the live settings with:

```bash
node scripts/repository-settings.mjs --plan
node scripts/repository-settings.mjs --apply
node scripts/repository-settings.mjs --check
```

The live modes fail closed when the stable ruleset is absent or any
out-of-scope rule, check, condition, or bypass actor differs from the checked-in
contract. `--apply` updates the existing stable ruleset identity only for the
authorized review parameters and sends only changed values among
`allow_auto_merge`, `merge_commit_title`, and `merge_commit_message` to the
repository endpoint. It preserves every allowed merge method, required check,
bypass and the separate release-tag ruleset. It refuses to create replacement
protection or apply across unexpected concurrent drift. Do not weaken or delete
a live rule without updating the artifact, regression tests, and rationale
under separately authorized policy scope.

The repository ruleset ID is host-assigned and intentionally absent from the
portable contract. Re-read effective rulesets, classic protection, and
repository settings after every authorized migration; a local artifact is not
live evidence.

The owner-authorized solo-maintainer migration was applied and read back on
2026-09-05. Against ruleset 22155633 it changed only
`required_approving_review_count` from 1 to 0 and
`require_last_push_approval` from true to false; the repository
`allow_auto_merge` property changed from false to true. Effective rules still
show the five strict checks, PR requirement, resolved-thread requirement,
deletion/non-fast-forward protections, and the same PR-only repository-role
bypass. Classic `main` protection remains absent. The separately listed release
tag ruleset 22334556 remained active and outside the update payload. This is live
settings evidence for removal of the approval bottleneck, not evidence that a
trusted unattended controller or zero-intervention merge scenario exists.

The contribution-conventions migration changes only the default presentation
of future merge commits from GitHub's classic merge subject/title body to the
pull request title/blank body. It does not rewrite history, force a merge
method, add a status requirement, or change merge authority. Apply it only from
the merged `main` contract and record the exact live readback on its durable
issue.

## Release protections

Release finalization on 2026-09-05 enabled repository release immutability using
`PUT /repos/boburning/portcove/immutable-releases` (204), then confirmed
`enabled: true`, `enforced_by_owner: false` through GET. Before the change, GET
returned `enabled: false`. These calls used GitHub CLI 2.98.0 and REST API
version `2026-03-10` under the owner's explicit finalization authorization.
See [GitHub's immutable-release API](https://docs.github.com/en/rest/repos/repos#enable-immutable-releases).

The effective repository ruleset **Protect release tags** targets
`refs/tags/v*`, with active enforcement, update and deletion restrictions,
no exclusions, and no bypass actors. Its observed API identity is
[22334556](https://github.com/boburning/portcove/rules/22334556).
The inherited-inclusive ruleset listing previously contained only Protect main.
The new rule has no creation restriction, so the approved initial tag can be
created through the ordinary owner workflow. The existing branch ruleset,
required checks, and its PR-only bypass remain unchanged. No trial tag was used.
See [GitHub's ruleset protections](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

Re-read both settings before tagging and publication. The existing
`repository-settings.mjs --check` covers the branch/private-reporting contract;
it does not verify these release settings. Inspect the inherited-inclusive
ruleset list and each applicable tag rule separately, preserving stronger rules.
Do not add update/deletion bypasses or weaken branch rules to publish.

The intended flow is draft, attach all assets, review, then publish. Drafts
remain mutable. Enabling the repository setting does not retrofit historical
releases or prove that a particular release is immutable: verify that release
and its attestation after authorized publication. No tag or release was created
while applying these settings.
