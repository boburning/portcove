---
name: portcove-roadmap
description: Perform Portcove issue intake, dependency and live GitHub Project reconciliation using the repository roadmap commands. Use for backlog and release-readiness work, not product implementation.
---

Resolve the current checkout root with `git rev-parse --show-toplevel` before using
paths below. Read [PROJECT-GOVERNANCE.md](../../../docs/PROJECT-GOVERNANCE.md) and inspect current commands in [roadmap.mjs](../../../scripts/roadmap.mjs). GitHub Projects is the live authority; never create a local backlog mirror.

Read every page of the relevant inventory and require unique counts to match totals. An API failure, stalled cursor, changing total or incomplete dependency read invalidates the result. REST may recover issue reads but does not establish Project fields it did not return.

For GitHub compare-based discovery, validate commit and changed-file completeness separately. A complete commit count does not make a 300-element files array complete. When capped, diff immutable endpoints through a metadata-only clone for the path inventory, use ordinal path identity, and state separately whether deeper content review was complete or targeted.

Search existing issues by upstream and stable game/target identity before intake. Use `capture-port` or `normalize-port` for ports. Preserve canonical issues, completed work, existing parents, origin markers and explicit dependencies. Parentage alone is not a blocking dependency.

Use `next`, `readiness --release <stage>`, and `doctor` for read-only assessment. Before classifying doctor drift under concurrent delivery, verify the local catalog/governance revision is current for the intended authority. Compare live issue/Project fields, current main's catalog, and active unmerged catalog work; coordinate with the owner instead of resetting another task's state from a stale checkout.

`capture-feature`, `promote`, `set`, `move`, and `bootstrap` mutate live state: use only within authorized scope and inspect flags. Before updating several items, account for the cost of complete Project traversal and reserve quota for exact readback and one final doctor. Prefer a repository-supported batch mechanism when available; do not loop a whole-project `set` command blindly. Use REST for independent issue/body/comment work when appropriate, never as proof of Project fields.

For every remote mutation, keep attempted action, transport result, targeted readback, and final doctor acceptance separate. After an ambiguous response, read the requested field before retrying and describe it as verified after the attempt rather than client-applied when causality is unknowable. In machine-readable output, use `unknown` for unavailable or contradictory readback and `partial` for known incomplete acceptance, keep diagnostics off structured stdout, and exit nonzero for either state.

For append-only issue-body reconciliation, reread immediately before mutation, reject changed snapshots, and make the addition idempotent with a unique marker. On readback, normalize CRLF/LF only for full-prefix preservation and separately require the exact addition once.

Keep Target release, Release commitment, Status, Port stage and catalog support separate. Unset commitment is unclassified. Inspect outcome, acceptance, blockers, and completion prose for semantic cycles that wait on downstream shipping or integrated proof despite an acyclic formal graph. Give each prerequisite component an independently satisfiable proof and assign integrated evidence to the downstream owner.

After mutations, read back issues, Project fields, dependencies, and markers. Rerun the full doctor from a coherent current revision. Report exact scope, evidence and unresolved conflicts; preserve priorities unless authorized. Repository docs retain stable contracts or dated snapshots only.

Budget a multi-mutation intake as one quota-bound sequence, including capture and promotion traversals, one guarded field batch, exact readback, and the final complete doctor. Avoid optional whole-Project reads between a successful batch and its doctor. If fields verify but the doctor cannot finish, report partial acceptance, retain the idempotent spec, and wait for enough quota to run one coherent final inventory and doctor.

When REST `/rate_limit` disagrees with a real GraphQL request, use the GraphQL response headers and data for GraphQL availability. If quota fails between draft capture and promotion, preserve exact draft IDs and specs and determine whether durable issues already exist. After the authoritative reset, recheck live state and quota, then verify each draft's identity before resuming supported promotion or replacing only those drafts with the exact existing issues. Never infer absence from a failed promotion response or delete an unverified draft; use the repository-managed roadmap lock for each resumed command and complete full final readback.

`capture-feature` leaves Status, Work type, and Effort at neutral intake defaults even when similarly named generic flags are accepted. Read those Project fields after promotion. For authorized non-neutral classification, declare and apply one guarded `set-many` transition and verify its readback rather than treating the capture invocation as proof.
