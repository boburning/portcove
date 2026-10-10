---
name: portcove-port-qualification
description: Investigate, add, or requalify a Portcove port with exact upstream, source and artifact evidence. Use for catalog admission and lifecycle qualification, not ordinary UI changes.
---

Resolve the checkout with `git rev-parse --show-toplevel`. Read the port's canonical
issue, relevant Project fields and affected [catalog contract](../../../docs/CATALOG.md).
Use `portcove-roadmap` for intake/planning changes; search the canonical owner first.

Establish direct upstream or accepted user-runtime identity, exact runnable
artifact/platform, accepted expected digest, source variant/representation and
operation/persistence ownership. A local hash does not authenticate arbitrary
downloads. Cataloged and Supported remain distinct; only offered operations and
explicit acceptance acquire qualification obligations.

Inventory upstream outputs before definition changes and verify adapter working
coordinates. Use an isolated library and authorized sources. Preserve originals,
saves and failed evidence; never claim managed update/backup/deletion for unowned
data. Record exact artifacts, source contracts, platform, checks, outcomes and
evidence. A download, schema pass or launch alone does not prove gameplay or full
lifecycle acceptance. Human comprehension remains intrinsically human.

For asset selection, materialization, persistence probes, maintenance declarations
and multi-port identity joins, read the relevant [operation notes](references/operation-notes.md).
Optional focused catalog feedback: `just test-rust -p portcove-core embedded_catalog_is_valid_and_contains_lighthouse`.
Confirm the actual test name before use. Required checks follow
[QUALITY](../../../docs/QUALITY.md#required-hosted-baseline); admission/lifecycle
acceptance remains explicit and operation scoped.
