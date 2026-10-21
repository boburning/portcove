# Paper Mario ReCut repository relocation — 2026-10-21

This record supplies the concrete continuity evidence for correcting the existing
`paper-mario-recut` repository location and recording its explicit deprecation.
It is a bounded catalog repair under [#247](https://github.com/boburning/portcove/issues/247)
and the current [#139 lineage contract](https://github.com/boburning/portcove/issues/139).
Both broader issues remain open. Independent review of this concrete correction
is required before delivery.

## Observed failure and continuity

The [upstream-health job](https://github.com/boburning/portcove/actions/runs/39615305951/job/119274619246)
for head `fa81464352afea687a9c95113343f5473b7c5772` reported the old
`SMCGames/Paper-Mario-ReCut` location as an unclassified HTTP 301 at
2026-10-21 14:17 UTC. Its retained log has SHA-256
`e0c3c9d718cf95d141478d7a4544fce101ebfb82b95998c402d3d8139618918a`.

Bounded, unauthenticated GitHub API observations at 14:47 UTC used manual redirect
handling. Each destination below was requested separately; no redirect was
followed and no credential was forwarded.

| Observation                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original location             | [Old repository endpoint](https://api.github.com/repos/SMCGames/Paper-Mario-ReCut) returned HTTP 301 identifying numeric repository `1247923238`.                                                                                                                                                                                                                                                                                                                                 |
| Current location              | [Numeric repository endpoint](https://api.github.com/repositories/1247923238) and [canonical endpoint](https://api.github.com/repos/SMCGames/Paper-Mario-ReCut-Deprecated) returned HTTP 200 for `SMCGames/Paper-Mario-ReCut-Deprecated`, repository ID `1247923238`, owner ID `183752111`. The repository was public, not archived and not disabled.                                                                                                                             |
| Historical release continuity | The [September 9 inventory](2026-09-09-definition-acquisition-observations.md) recorded release ID `332755572`, tag `v0.1.2` and one asset at the old location. The [current release](https://github.com/SMCGames/Paper-Mario-ReCut-Deprecated/releases/tag/v0.1.2) retains that numeric release ID and tag. The [September 15 inventory](2026-09-15-catalog-release-maintenance-inventory.md) also records the license-compliance asset selected by the unchanged catalog hints. |
| Release history               | The complete two-release API page retained `v0.1.2` and `v0.1.1`. The `v0.1.2` annotated tag object `93440bd3fc7103f70a8d15080458895286e09b91` targets commit `098be0a501eecd5bb894a47964061d05eeedc3a2`.                                                                                                                                                                                                                                                                         |
| Attributable deprecation      | [Commit `9987cc93`](https://github.com/SMCGames/Paper-Mario-ReCut-Deprecated/commit/9987cc93dbdc9bdfcf1be7a1eb7aa5df70837f72), attributed by GitHub to `SmokeyMcGames` at 09:32 UTC, changes only `README.md`, explicitly deprecates ReCut and recommends PaperBoat. Its direct parent is the `v0.1.2` target commit above. GitHub reports the deprecation commit verified; the release tag itself is unsigned.                                                                   |

The numeric repository response, retained historical release ID, release history
and attributable README change together support a same-repository location
correction. A matching name or redirect alone would not establish this decision.
No historical numeric repository ID or independently verified historical artifact
digest is claimed from the older inventories.

## Exact release metadata observed

| Field                  | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| Release                | `v0.1.2`, ID `332755572`, published `2026-06-01T20:33:17Z`, prerelease |
| Asset                  | `PaperMarioReCut-v0.1.2-license-compliance.zip`, ID `435574347`        |
| Size                   | `88065512` bytes                                                       |
| Provider SHA-256 claim | `4734bc2e11886a327dda9ecedf25258298f3c5ddfc1820e8eeba1b6683ebad2a`     |

These are provider metadata observations. No release asset was downloaded,
executed or requalified, and these observations do not establish accepted-byte
obtainability, absence of compromise, distribution authority or operation holds.

## Catalog and legacy boundary

The correction changes only `project_url`, `release.repository` and
`upstream_status` for the existing port. `retired` records the maintainer's explicit
deprecation under the [availability-first maintenance contract](../CATALOG.md).
It does not withdraw an accepted release or change the existing support tier.
The unchanged beta channel and `license-compliance.zip` selector retain the
same release selection rules and all ordinary source/package checks.

Source identities and digests, executable hints, runtime layout, source
materialization, persistent paths, historical qualification and installed
provenance remain unchanged. The complete source catalog and the separate
`paperboat` entry are byte-for-byte unchanged in authoring data. Recommending
PaperBoat does not establish a successor mapping, merge port identities or
authorize a save migration. The schema-1 fixtures remain frozen; the existing
full compatibility comparison enumerates only these three reviewed metadata
differences.

## Bounded verification

Generation through `scripts/generate-catalog.mts`, its `--check` mode and the
focused deterministic schema-2 authoring test passed. A whole-document semantic
comparison verifies that only the three declared fields change.
The changed Rust file passes the pinned formatter. No local Rust build or runtime
qualification was performed; the existing compatibility test remains part of
the required hosted validation before delivery.

At 14:48:54 UTC, the existing observer with
`--json --port-ids=paper-mario-recut` completed one request for one selected
location: HTTP 200, repository ID `1247923238`, zero unknown locations and no
degradation. The other 112 ports were explicitly unassessed. The report still
retains unresolved lineage and unknown accepted-artifact, preservation and hold
states; reachability is not authority for those decisions. Protected health
accounting is unchanged. This observation does not claim full-catalog health,
new runtime evidence or completion of #139/#247.
