# N64 pre-Play preservation — October 25, 2026

This component continues [#2510](https://github.com/boburning/portcove/issues/2510)
and [#2926](https://github.com/boburning/portcove/issues/2926). It does not close
their all-port/Public beta acceptance or any port's native qualification.
Base source: `d4555328c754f89b60744fcae5227729eed09762`.

Independent review of the proposed MarioKart64Recomp route found that historical
N64 contracts collect runtime data only after a Portcove launch marker exists.
Data added before first Play can therefore be omitted from backup/replacement
or overwritten by canonical restoration. Enabling a new managed route with that
promise would be incorrect. The unmerged metadata candidate is preserved at
`90701a50dec611b0b317501b76dc4040d9601f55` on
`feature/installation-mk64-candidate-preserved-20261025`.

The existing preserved rollout source
`9e160ec99ddfd5b78be6762e7ab3ca05e3415ec1` already contains an explicit
`n64_runtime_at_executable_parent` contract. This component reconciles that
implementation with current main, including the subsequently delivered versioned
mod policy. N64 capability 4 negotiates the opt-in. New captures use retained
format 8, preserving format 7's existing versioned-mod interpretation. No authored
port or old retained installation is silently changed.

The opt-in resolves launch and persistence beside the selected executable,
strictly verifies immutable runtime files and package variants, rejects
incompatible coordinates, stages before activation and reuses Core's existing
bounded data-restoration receipt. Current declared data is collected before
first Play, backup, replacement, rollback and removal. Unproven conflicting
canonical/runtime data is held for explicit preservation and resolution.
Recovery replays the existing collect/restore-before-publication sequence.
This is not a new installer or lifecycle engine. Old contracts keep their
original coordinates and collection behavior; changing the flag requires an
explicitly supported transition, not a catalog edit.

GitLab display labels can omit archive suffixes; independently joined registry
filenames are authoritative for supported archive/variant checks. The opt-in
checks those final filenames before caching. GitHub selector/cache scope and
authoring comparison feedback likewise consume the explicit contract.

Inert N64 fixtures use a first-party 32-byte big-endian header/payload, never a
commercial original. They exercise pre-Play settings/save/mod collection,
backup, changing archive wrappers, staged replacement, interrupted publication,
current-data rollback, missing-receipt conflicts, removal preservation, immutable
tamper/unknown-addition refusal, capability floors and retained-reader fences.
Returning a launch specification does not execute a game or establish Play.
Final exact-head checks and independent review are recorded on the PR.

MarioKart64Recomp acquisition has an independent unresolved condition: the
verified Windows package includes Chiaro fonts whose own notices identify
Fontworks Japan and reserve rights. The full pinned source tree and package
contain no attributable applicable grant for them. Lato/Noto include OFL notices;
the root GPL and Promptfont's separate license do not settle Chiaro permission.
This observation does not establish illegality. Managed acquisition remains
unfinished pending an attributable grant or an appropriately licensed replacement
package; no new managed route is enabled by this Core component. The useful
permitted-existing-copy handoff and canonical reconciliation remain separate work.

All 524 original identities, 312 affected authored additions and 22 original
roadmap joins remain in scope. Six Direct maintenance decisions remain unfinished.
This component makes no new global fit/reconciliation count or Reviewed/Supported
claim. #2225/#47/#48 acceptance and #534/#246 publication authority remain separate.
