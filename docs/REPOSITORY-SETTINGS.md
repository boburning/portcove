# Repository settings

Portcove keeps its review and private-reporting expectations in version control even though GitHub stores the effective settings outside Git. `.github/repository-ruleset.json` protects exactly `refs/heads/main`; `.github/repository-security.json` names the repository and requires private vulnerability reporting.

The `Protect main` ruleset blocks deletion and force-pushes, requires a pull request with one fresh approval and resolved review threads, and requires the `catalog`, `dependency-review`, `frontend`, `rust`, and `rust-quality` checks from `.github/workflows/ci.yml` against the latest main revision. It defines no bypass actors.

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
