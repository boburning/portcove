---
name: portcove-release-validation
description: Prepare or validate Portcove packages, upgrade and rollback evidence using existing release tooling. Use for release candidates and installer qualification, not permission to publish or sign releases.
---

Resolve the checkout root and read [RELEASING.md](../../../docs/RELEASING.md), the linked issue, and current release/dependency fields in the live Project. Repository release docs define the package policy; the Project defines unfinished commitments.

Inspect parameters in [release-preflight.ps1](../../../scripts/release-preflight.ps1), [package-local.ps1](../../../scripts/package-local.ps1), and [test-windows-installer.ps1](../../../scripts/test-windows-installer.ps1) before invoking them. Reuse these scripts rather than reproducing package selection, signing, or checksum logic in a skill.

Bind results to the exact commit and package digests. Distinguish local build checks, hosted artifact production, signing/attestation, clean installation, N-to-N+1 upgrade, rollback, restart, and persistent-data preservation. For failures retain the previous usable state and record the reproduction plus resume condition.

Run required repository checks and use an isolated qualification environment. A Windows test cannot qualify Linux/macOS, and a test-signed fixture cannot qualify production signing. Preserve existing immutable releases; do not repair a published release by replacing its assets.

Report passed/failed/not-run checks, artifact identities, environment, evidence paths, and remaining intrinsically external observations. Preparing and validating a candidate does not authorize publication, key changes, protected gates or administrator bypass. Reconfirm current revision and existing authority immediately before an authorized external action.
