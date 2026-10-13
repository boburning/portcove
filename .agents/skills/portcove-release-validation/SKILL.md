---
name: portcove-release-validation
description: Prepare or validate Portcove releases, packages, updaters, signing policy, upgrades, and rollbacks with existing tooling. Use for candidates, installer qualification, or protected release-policy changes; not permission to publish, sign, change keys, or widen authority.
---

Resolve the checkout with `git rev-parse --show-toplevel`. Read the owning issue
and only the affected operation: [release procedure](../../../docs/RELEASING.md),
[delivery](../../../docs/DELIVERY.md), [updater trust](../../../docs/UPDATER-TRUST.md),
or [upgrade/rollback](../../../docs/UPGRADING.md). Catalog signing additionally uses
[SIGNED-CATALOG](../../../docs/SIGNED-CATALOG.md). Inspect the selected script's
parameters before execution; reuse repository package/checksum/signing logic.

Bind evidence to exact source and artifact digests. Keep build, platform/package,
signing/attestation, clean install, upgrade, rollback/restart and persistence
claims distinct. Use isolated libraries and qualification environments; fixtures
do not qualify production signing or other platforms. Serialize Registry and
installed-session rehearsals with actual host resource guards.

Preserve prior usable state, immutable releases and failed evidence. Preparation
does not authorize publication, credentials, key changes, protected authority or
administrator bypass. Reconfirm exact revision/authority before external actions.

For workflow-gate engineering, secret-free signing fixtures or installer identity,
read the relevant [operation notes](references/operation-notes.md). Packaged discovery,
operation environment and cancellation use [packaged consumers](references/packaged-consumers.md).
[QUALITY](../../../docs/QUALITY.md#required-hosted-baseline) owns required validation;
an ordinary release-doc edit does not itself require an installed rehearsal.
