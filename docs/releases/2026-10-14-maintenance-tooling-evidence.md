# Maintenance tooling and Cargo artifact evidence — October 14, 2026

Issue #1973 combines the five session retrospective improvements with a scoped
Cargo artifact investigation. This is dated evidence, not a planning authority.

## Cargo pilot: supported-scope hold

Live Renovate #1972/#1974 metadata identifies engine **44.156.3**. The official
validator was run with `corepack pnpm --package=renovate@44.156.3 dlx
--allow-build=re2 renovate-config-validator --strict renovate.json`.

It rejected the proposed Cargo/crate/serde_json rule combining
`matchUpdateTypes: ["patch"]` and `rangeStrategy: "update-lockfile"`:

> packageRules cannot combine both matchUpdateTypes and rangeStrategy.

A nested `patch.rangeStrategy` candidate migrates to the same invalid combination
and was also rejected. Actual engine package-rule evaluation of a JSONata
`updateType = 'patch'` alternative retained `bump` before lookup and applied
`update-lockfile` only after lookup, with currentValue `1.0.151` and newValue
`1.0.152` already differing. The engine's Cargo artifact implementation skips
precise updates for such changed manifest values. This is not a safe substitute.

The production Renovate configuration was restored byte-for-byte and passed the
official strict validator. Global range strategy, age/security/queue policies,
manifest and lockfile remain unchanged by this candidate. No status was fabricated.

## Actual workspace replay

An isolated archive of merge-base `f21f6fa1503861562e73eae8e692f33f483fe166`
provided the actual workspace and original dependency graph. Cargo executed:

```text
cargo update --manifest-path <fixture>/Cargo.toml --package serde_json@1.0.151 --precise 1.0.152
cargo update --manifest-path <fixture>/Cargo.toml --workspace
cargo metadata --manifest-path <fixture>/Cargo.toml --locked --format-version 1
```

The locked graph retained serde_json **1.0.152** while newer **1.0.154** was
available; nearby semver remained **1.0.28**. Official engine extraction identified
both as `crate` workspace dependencies, with the correct ranges/locked versions.
Cargo generated integrity data; no checksums were manually changed. This proves
the precise-command replay, not a supported patch-only automatic strategy.

The historical age case is #1958: 1.0.152 was eligible at pickup, while 1.0.154
published October 11 at 15:31:46.076577 UTC became eligible October 14 at the same
time. Direct eligibility never qualified the original newer lock resolution.
The historical failure remains preserved on its original source.

## Resume and completion boundaries

Resume the Cargo pilot when a deployed engine supports a pre-lookup patch-only
strategy or an equivalent officially validated method. Repeat extractor,
effective-rule, workspace/artifact and nearby/security/maintenance controls before
adoption. A broader serde_json range policy needs a separate explicit owner choice.

The other tooling improvements can be independently reviewed and merged in the
same PR. #1973 stays open for this hold; if a safe rule is later delivered, its
hosted-uptake criterion also requires a naturally occurring generated proposal.
Do not manufacture an update to close the issue.

Local raw validator logs, rejected candidate configs, extraction/evaluation JSON
and the workspace replay are retained under the candidate's ignored `work/`.
