---
name: portcove-roadmap
description: Perform Portcove issue intake, dependency and live GitHub Project reconciliation using the repository roadmap commands. Use for backlog and release-readiness work, not product implementation.
---

Resolve the checkout with `git rev-parse --show-toplevel`. GitHub Projects owns
live planning. Read the relevant [governance section](../../../docs/PROJECT-GOVERNANCE.md),
not the entire handbook. Use the current `roadmap.mjs --help` for flags.

Pickup/resume: `context --issue <number> --runner <identity> --json` reads relevant
requirements. Reuse until material requirements/source changes and the final
merge/write check under [pickup](../../../docs/PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep).
Verify actual overlapping writers; the retired board grants no work.

Intake: search canonical owners first. Use `capture-feature` then `promote
<draft-item-id> --spec-file <path>`, or `capture-port`/`normalize-port`. Keep issues
finite and preserve parentage, completed work and genuine prerequisites; parentage
alone is not a blocker. Before rewriting a specification, preserve its old body
in dated linked history, refresh the preimage and reject concurrent changes.

Mutations: use authorized scoped `set`, `move` or intake, read back exact issue
and Project state, and finish the applicable `doctor`. REST issue reads cannot
prove Project fields. Reconcile the task, finite parent and directly affected
relationships on completion/material scope changes. Routine updates need targeted
reads; migrations and release/readiness claims need complete inventories.

For inventory claims, every page and unique total must agree; incomplete API
coverage is UNKNOWN. For bulk edits, ambiguous writes, compare ceilings, historical
handoffs or unavailable transport, use the relevant [operation notes](references/operation-notes.md).
Never scan enormous comment archives for ordinary pickup or create a second ledger.
