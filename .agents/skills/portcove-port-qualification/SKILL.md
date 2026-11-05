---
name: portcove-port-qualification
description: Investigate, add, or requalify a Portcove port with exact upstream, source and artifact evidence. Use for catalog admission and lifecycle qualification, not ordinary UI changes.
---

Resolve the checkout with `git rev-parse --show-toplevel`. Read the port's canonical
issue, relevant Project fields and affected [catalog contract](../../../docs/CATALOG.md).
Use `portcove-roadmap` for intake/planning changes; search the canonical owner first.

Start ordinary authoring with `node scripts/prepare-port.mts --issue N --output-dir
CHECKPOINT` or its direct project/record input. Read the
[per-ID authoring contract](../../../docs/CATALOG.md#adding-or-changing-a-port).
One `catalog/ports/<id>.json` record owns the listing and optional strict
integration; shared source tables keep their existing authority. Generated
aggregates are outputs. Reuse the checkpoint for unchanged observations, retry
failed enrichment independently, and regenerate after reviewing the proposed
record. Do not mutate sources or publish merely because preparation succeeded.

For fitting ordinary work, prefer authoring-only `route_facts_v1`: a Windows
prepared player basename, executable-parent working directory, literal arguments
and actual external data locations. Source-free here means no Core source binding,
not that the game requires no originals. Preserve upstream original-file setup,
bespoke actions and immediate warnings. Managed facts currently cover only the
existing NativePortable GitHub shape without a Core source binding. Other shapes
keep their working route and specific limitation; do not infer operational facts
from prose or expand the schema to fit them.

Use the existing `prepare-port.mts` feedback and reviewed per-ID record, followed
by `generate-catalog.mts`; shared explanations and distinct lifecycle entrypoints
are generated. Reuse accepted inspections with the existing paired package
observation options to derive descriptive metadata and expected member facts.
Independent initial acceptance remains necessary. Covered ordinary releases use
the existing dynamic resolver and applicable integrity checks, with no new
version/applicability row, guide rewrite, wrapper or routine agent approval.
See `crates/portcove-core/catalog/ports/nhl-94-genesis-ninety-four.json` for a
prepared route retaining explicit retail-ROM and save/state limitations.

A discovery-only listing needs a stable implementation identity, truthful name,
summary and attributable public origin. Unknown availability, missing artwork or
unreviewed setup details do not require a full port investigation. Listing
visibility is separate from executable-route acceptance and actual distribution.
Only promised operations acquire the qualification requirements below.

Select the [integration owner](../../../docs/CATALOG.md#integration-ownership)
first: official package, supported upstream preparation, bounded non-owning
existing installation, or precise upstream dependency/product deferral. Prefer
upstream's engine and build implementation. Retiring new custom creation does
not retire installed-runtime readers or recovery. A deferred route is not delivered.

For a strict managed or curated package operation, establish direct upstream
identity, exact runnable artifact/platform, accepted expected digest, source
variant/representation and operation/persistence ownership. Generic download
instead binds the explicitly selected asset and destination, verifies published
digest evidence when available and records missing authenticity evidence
honestly. A computed hash alone does not authenticate a download. Cataloged and
Supported remain distinct; only offered operations and explicit acceptance
acquire qualification obligations.

User-selected existing installations instead bind explicit executable, working
directory and arguments to execution intent. Check paths and supported launch;
do not demand curated immutable-tree certification or infer update, backup,
rollback, migration or deletion rights. Registration removal preserves all
external runtime and player data. Require evidence only for offered operations.

Inventory the affected upstream outputs before changing managed runtime creation
or replacement and verify adapter working coordinates. Descriptive or artwork
changes do not acquire that inventory obligation. Use an isolated library and authorized sources. Preserve originals,
saves and failed evidence; never claim managed update/backup/deletion for unowned
data. Record exact artifacts, source contracts, platform, checks, outcomes and
evidence. A download, schema pass or launch alone does not prove gameplay or full
lifecycle acceptance. Human comprehension remains intrinsically human.

For asset selection, materialization, persistence probes, maintenance declarations
and multi-port identity joins, read the relevant [operation notes](references/operation-notes.md).
For repeated managed setup/immutable checks, reuse the existing report tool's
[reviewed preparation case](../../../docs/CATALOG.md#qualification-evidence-preparation).
Retain failure receipts and Core operation inputs; external launch-only routes
do not acquire this managed sequence or unoffered lifecycle obligations.
Optional focused catalog feedback: `just test-rust -p portcove-core embedded_catalog_is_valid_and_contains_lighthouse`.
Confirm the actual test name before use. Required checks follow
[QUALITY](../../../docs/QUALITY.md#required-hosted-baseline); admission/lifecycle
acceptance remains explicit and operation scoped.

When drafting a listing summary or setup guide, collect precise evidence first.
Write the player explanation separately. Use the existing warning and reference
fields and follow [Content design](../../../docs/CONTENT-DESIGN.md).
