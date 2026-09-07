---
name: portcove-roadmap
description: Perform Portcove issue intake, dependency and live GitHub Project reconciliation using the repository roadmap commands. Use for backlog and release-readiness work, not product implementation.
---

Read [PROJECT-GOVERNANCE.md](../../../docs/PROJECT-GOVERNANCE.md) and inspect the current commands in [roadmap.mjs](../../../scripts/roadmap.mjs). GitHub Projects is the live authority; never create a local backlog mirror.

Read every page of the relevant inventory and require unique counts to match totals. An API failure, stalled cursor, changing total or incomplete dependency read invalidates the result; retry the traversal rather than presenting partial coverage as complete. REST may recover issue reads but does not establish Project fields it did not return.

Search existing issues by upstream and stable game/target identity before intake. Use `capture-port` or `normalize-port` for ports. Preserve canonical issues, completed work, existing parents, origin markers and explicit dependencies. Parentage alone is not a blocking dependency.

Use `next`, `readiness --release <stage>`, and `doctor` for read-only assessment. `capture-feature`, `promote`, `set`, `move`, and `bootstrap` mutate live state: use only within the user's authorized scope. Inspect each command's current flags before execution.

Keep Target release, Release commitment, Status, Port stage and catalog support separate. Unset commitment is unclassified. Do not close work without matching acceptance evidence or make unknown optional gameplay a universal blocker.

After mutations, read back the affected issue, Project fields and dependency relationships. Report exact changed scope, evidence and unresolved conflicts; preserve existing priorities unless their change was authorized. Repository docs retain stable contracts or dated snapshots only.
