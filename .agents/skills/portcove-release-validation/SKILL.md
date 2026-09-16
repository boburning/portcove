---
name: portcove-release-validation
description: Prepare or validate Portcove releases, packages, updaters, signing policy, upgrades, and rollbacks with existing tooling. Use for candidates, installer qualification, or protected release-policy changes; not permission to publish, sign, change keys, or widen authority.
---

Resolve the current checkout root with `git rev-parse --show-toplevel` and read
[RELEASING.md](../../../docs/RELEASING.md), [DELIVERY.md](../../../docs/DELIVERY.md), [UPDATER-TRUST.md](../../../docs/UPDATER-TRUST.md), [UPGRADING.md](../../../docs/UPGRADING.md), the linked issue, and current release/dependency fields in the live Project. Read [SIGNED-CATALOG.md](../../../docs/SIGNED-CATALOG.md) only when catalog signing is in scope. Repository release docs define package and application-signing policy; the Project defines unfinished commitments.

Inspect parameters in [release-preflight.ps1](../../../scripts/release-preflight.ps1), [package-local.ps1](../../../scripts/package-local.ps1), and [test-windows-installer.ps1](../../../scripts/test-windows-installer.ps1) before invoking them. Reuse repository scripts rather than reproducing package selection, signing, or checksum logic in a skill.

Bind results to the exact commit and package digests. Distinguish local build checks, hosted artifact production, signing/attestation, clean installation, N-to-N+1 upgrade, rollback, restart, and persistent-data preservation. For failures retain the previous usable state and record the reproduction plus resume condition.

When introducing a cheap identity or preflight gate, inspect transitive imports of every selected command and exercise it in the dependency environment of the hosted job. Keep dependency-free workflow-contract tests in the cheap lane and dependency-requiring tests after the pinned install. A safe early failure is rehearsal evidence, not release qualification; repair the boundary and rerun exact head.

Test workflow profiles by semantics. Assert exact input-to-version/platform/behavior mappings, invalid combinations, and retained identity/evidence wiring. Prefer executing cheap rejection paths; when a valid path is expensive, test the precise mapping and dynamic field flow rather than independent token presence.

For rejection fixtures, retain both trusted/expected and observed values, the failure result, and preservation claims so an independent artifact reader can establish the boundary without reconstructing logs. Keep direct byte/hash inspection when the artifact is retained.

For disposable signing fixtures, distinguish artifact secret scans from runtime authority teardown. Before any consumer child starts, delete producer private stores, clear inherited signing variables, require the child to independently assert absence before mutation, and record those observations. Failure-path cleanup is defense in depth, not primary proof. Test fixtures do not authorize production credentials.

Run required repository checks in an isolated qualification environment. A Windows test cannot qualify Linux/macOS, and a test-signed fixture cannot qualify production signing. Preserve existing immutable releases; do not repair a published release by replacing assets.

Report passed/failed/not-run checks, artifact identities, environment, evidence paths, and remaining external observations. Preparing and validating a candidate does not authorize publication, key changes, protected gates or administrator bypass. Reconfirm revision and authority immediately before an authorized external action.
