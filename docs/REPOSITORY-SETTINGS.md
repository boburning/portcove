# Repository settings

Portcove keeps its review and private-reporting expectations in version control even though GitHub stores the effective settings outside Git. `.github/repository-ruleset.json` protects exactly `refs/heads/main`; `.github/repository-security.json` names the repository and requires private vulnerability reporting.

The `Protect main` ruleset blocks deletion and force-pushes, requires a pull request with one fresh approval and resolved review threads, and requires the `catalog`, `dependency-review`, `frontend`, `rust`, and `rust-quality` checks from `.github/workflows/ci.yml` against the latest main revision. Its only bypass actor is the built-in repository-admin role, and that bypass is restricted to pull requests. This prevents a solo-maintainer approval deadlock while retaining a visible PR and merge audit trail; it does not permit bypass by direct push. Use the bypass only for an explicitly authorized merge after the required checks pass.

Validate the local artifacts without GitHub access:

```bash
node scripts/repository-settings.mjs --validate
```

An authenticated repository administrator can reconcile and then verify the live settings with:

```bash
node scripts/repository-settings.mjs --apply
node scripts/repository-settings.mjs --check
```

Both live modes fail closed when the ruleset or private-reporting setting differs from the checked-in contract. `--apply` updates the stable ruleset identity instead of creating duplicates. Do not weaken or delete the live rule without changing the artifact, its regression tests, and this rationale in the same reviewed pull request.

The live `boburning/portcove` settings were reconciled and read back through the GitHub API on 2026-09-02. The repository ruleset ID is host-assigned and intentionally absent from the portable contract.

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
