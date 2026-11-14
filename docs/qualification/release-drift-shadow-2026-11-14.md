# Release drift shadow comparator bootstrap (November 14, 2026)

This record states what phase 1 ("Shadow comparator") of
[#5359](https://github.com/boburning/portcove/issues/5359) establishes for the
generated reviewed package-shape table, and the shadow verdicts for the six
routes the
[November 13 requalification](mstan-recomp-requalification-2026-11-13.md) found
exposed to drift. These are static archive observations on Linux x86-64 through
Core's managed extraction. Nothing was executed, installed or played. A verdict
is a shadow observation, not a review, a refusal or a support claim, and no
catalog support, applicability row, hold or Project field changed.

## Method

Each artifact was downloaded on its own from its GitHub `releases/download`
URL with `python3 -I` into a new empty directory, its SHA-256 and size were
computed from the bytes, and the directory was deleted after inspection. A
reviewed artifact whose bytes matched its catalog digest was recorded with
`node scripts/package-shape-baselines.mts --record`, which calls
`portcove --json catalog inspect-package-shape` (Core verification, extraction
and shape derivation; no package code runs). The newer releases were then
inspected with the same command against a CLI built with the populated table.
The generated table's `--check` passed offline afterwards.

## Bootstrapped table

Ten entries, all `windows-x86-64`:

| Route                                                | Reviewed artifact  | Source                 |
| ---------------------------------------------------- | ------------------ | ---------------------- |
| `super-mario-world-recomp`                           | v0.12.0 `1609aa46` | applicability          |
| `the-legend-of-zelda-a-link-to-the-past-snes-recomp` | v0.6.1 `b53f5ab7`  | applicability          |
| `sonic-the-hedgehog-recomp`                          | v0.7.3 `082cfb48`  | applicability          |
| `sonic-the-hedgehog-2-recomp`                        | v0.8.3 `c526ad6f`  | applicability          |
| `super-metroid-recomp`                               | v0.4.2 `72b7c179`  | applicability          |
| `ape-escape-recompiled`                              | v0.3.0 `91e2cde5`  | applicability          |
| `blake-stone-aliens-of-gold-bstone`                  | v1.3.4 `4bfe5c0b`  | applicability (native) |
| `blake-stone-planet-strike-bstone`                   | v1.3.4 `4bfe5c0b`  | applicability (native) |
| `diablo-devilutionx`                                 | 1.5.5 `a20cfb62`   | applicability (native) |
| `diablo-hellfire-devilutionx`                        | 1.5.5 `a20cfb62`   | applicability (native) |

The four native-portable entries also carry an explicit
`reviewed_package_layouts` fingerprint. Their generated programs and top-level
directories equal those fingerprints exactly, which a Core test keeps true.

Not bootstrapped:

- Sonic 1 v0.8.3 (`54c73309…`), the route's newest applicability row. Its bound
  URL now serves different bytes (`df79626e…`, 5,324,030 bytes), as the
  requalification recorded, so it cannot be derived. The Sonic 1 baseline is
  therefore v0.7.3, which is older than the newest reviewed release.
- Sonic 1 v0.6.0 and Super Metroid v0.3.12 rows, and the Linux and macOS Super
  Metroid siblings (the applicability digest names the Windows asset).
- The other 794 reviewed artifacts `--candidates` lists, most of them
  `psx-recomp-managed` runtime assets. They stay without a generated entry
  until an explicit refresh; until then their verdict is `unknown`.

## Shadow verdicts for the six known-drift routes

Each newest release was compared with its route's newest generated entry.

| Route / issue          | Candidate          | Verdict | Parts that differ                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Super Mario World #147 | v0.15.9 `8603cc10` | drifted | 4 new programs (`smw-controller-report.exe`, `smw-falcon-cache.exe`, `collect-controller-diagnostics.cmd`/`.ps1`); new `falcon-cache-licenses/`; `mods/packages` → `mods/preloaded`; 5 config files added, 3 removed                                                                                             |
| Link to the Past #151  | v0.6.6 `53b613b8`  | drifted | new `docs/`; `mods/packages` → `mods/preloaded`; shipped `config.ini` removed (persistent overlap and config); 2 config files added, 2 removed                                                                                                                                                                   |
| Sonic 1 #152           | v1.2.0 `fa01c42f`  | drifted | top-level folders only: `docs/`, `tools/` added, `licenses/` removed                                                                                                                                                                                                                                             |
| Sonic 2 #153           | v0.9.23 `d6c19d29` | drifted | `docs/`, `tools/` added, `licenses/` removed; `build-info.json` removed                                                                                                                                                                                                                                          |
| Super Metroid #164     | v0.4.5 `337c1daa`  | drifted | config files only: two new preloaded mod manifests                                                                                                                                                                                                                                                               |
| Ape Escape #142        | v0.5.7 `d8b14cdc`  | drifted | new program `overlay_toolchain/psxrecomp-bios.exe`; `licenses/` added, `docs/` removed; 12 shipped files added to persistent paths (including `input.ini` and the changed `mods/bundled` set), 4 removed; 27 config files added (including `ApeEscapeRecomp.execution.json`, `RELEASE_MANIFEST.json`), 3 removed |

All six are drifted, and nothing was refused.

How this compares with the requalification:

- **Super Mario World, Link to the Past and Ape Escape**: the shape catches the
  reviewed concern directly (the `mods/preloaded` move, the dropped
  `config.ini`, the new programs, the shipped `input.ini` and the
  `mods/bundled` change).
- **Sonic 2**: drift is incidental (`licenses/` removed, `build-info.json`
  removed, new `docs/` and `tools/`). Its real concern, the default replay
  writer under `logs/`, is runtime behavior the package does not show.
- **Sonic 1 and Super Metroid**: their real concerns (runtime `.ini` writers;
  netplay, remote mod downloads and `saves/netplay/`) are also runtime-only.
  They drift here only through incidental folder churn and two new preloaded
  mod manifests, and Sonic 1's baseline is v0.7.3 rather than v0.8.3. These
  are true package differences but not the reviewed behavior change, so they
  are the shadow phase's false-positive evidence: drift that a reviewer would
  likely accept, and drift that would not have caught the actual concern.

A further observation: the reviewed Super Metroid v0.3.12 artifact compared
with the v0.4.2 baseline is also drifted (`mods/` and `mods/preloaded` absent).
That is expected, because v0.4.2 introduced the preloaded mod root; an exactly
listed artifact is compared with its own entry, not the newest one.

## Table maintenance after review

Independent review added a per-entry `derivation_inputs_sha256` and an offline
`--prune` repair
([CATALOG](../CATALOG.md#generated-reviewed-package-shapes-shadow)). The ten
digests above were computed offline from the catalog the shapes were derived
with; no shape was re-derived or edited, and `--check` and `--prune` both
reported the table current afterwards (`--prune` removed nothing). The same
review made the manifest record forward compatible: a record this build does
not understand reads as no record rather than an unreadable manifest.

## Known limits

- A shape derived under a later signed definition delivery is compared with a
  table checked against the embedded catalog; a delivered change to a route's
  persistent paths can therefore show drift that is only a definition change.
- Package shapes do not see runtime behavior, which is where the Sonic 1,
  Sonic 2 and Super Metroid concerns live.
- Exact-name comparison counts a renamed program or configuration file as one
  removal and one addition.
- Routes without a generated entry depend on the explicit fingerprint, the
  active local installation or `unknown`; a local baseline whose provenance is
  `unreviewed` is never evidence of review.

## Not observed

- Runtime behavior of any release, including writes created at first launch.
- Publisher digests: the GitHub API was not available to this session, so the
  newer releases' digests are computed only, as in the requalification. Every
  reviewed artifact matched its catalog digest.
- Linux and macOS packages, and every route outside the ten entries above.
