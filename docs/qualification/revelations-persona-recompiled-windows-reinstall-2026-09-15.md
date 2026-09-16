# Revelations: Persona Recompiled Windows clean-reinstall qualification — 2026-09-15

This record adds exact Windows x86-64 removal and clean-reinstall evidence for
Revelations: Persona Recompiled v0.1.1 under the repaired managed-PS1
configuration-copy contract. It complements the earlier structural,
update/rollback, native-intro, persistence, and backup/restore record without
rewriting that history, promoting the port to Supported, or manufacturing
hands-on evidence.

## Scope

| Identity              | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Portcove commit       | `6348bf3e80edf079eb8b12383bf4a8635a380def`                         |
| Portcove version      | `0.1.0-alpha.2`                                                    |
| Native CLI SHA-256    | `9e0b601bbf442882bc44dcb9940d57fb1fbf5afc7877688aa6cb69b72969808d` |
| Platform              | `windows-x86-64`                                                   |
| Upstream ref          | `v0.1.1`                                                           |
| Release asset         | `revp-0.1.1-windows-x86_64-owned-input.zip`                        |
| Artifact size         | `29,260,787` bytes                                                 |
| Artifact SHA-256      | `f4336030ba9c0e032061ad6892aa5ce9ff01c4cedcbaf3a5355428e6d728158a` |
| Source contract       | `revelations-persona-recompiled-game-source`                       |
| Source variant        | `legacy-accepted`                                                  |
| Source representation | `normalized-track-set`                                             |
| Check contract        | `persona-windows-qualification-v1`                                 |
| Retained evidence     | `H:\\Portcove-Worktrees\\persona-reinstall-20260915`               |

The isolated library, operation database, exact requests, release asset,
read-only source copy, installed version, canonical user data, and final backup
remain under the retained evidence root. Proprietary source and generated game
data remained outside Git. No production credentials, signing, publication, or
network service were used.

## Exact source and release binding

The authorized BoburNAS source was copied read-only into isolated storage.
`source add` and an independent source recheck both returned
`recognized_exact/current` for the existing USA `SLUS-00339` contract:

| Observation              | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| CHD size                 | `380,748,155` bytes                                                |
| CHD SHA-256              | `01ce1b6942d0e6d61cf830617cb10919ee3e7aa7e7a99fe8d97358511d751582` |
| Normalized Track 01 size | `707,025,312` bytes                                                |
| Normalized SHA-1         | `3e7d8019a3191a29a48bb9d574cf05b1bc998c06`                         |
| Normalized SHA-256       | `05aaa2c1bd264c1a7e739d0746a1d774e063c9ba1eb8394350f929f57a521680` |

The official v0.1.1 owned-input artifact matched the exact size and SHA-256 in
the scope table. This observation does not widen the accepted source variant,
representation, release identity, or platform.

## Fresh install and pre-removal state

Fresh installation `762602b1-50d0-4f05-9586-23c9a21213e7` completed with
manifest SHA-256
`506dd1f031d5c0ffd96cd811359becef1887c933bd849128cb70cc9fea442642`.
Independent verification checked all 2,094 immutable files with no failures.

Native request `7b40f63f-2290-4bd2-8f21-acde8d70b1a5` reached the exact managed
executable and displayed a responsive `Revelations: Persona - Launcher`
window. A normal close was accepted, the process exited zero, persistent
collection completed, and all 2,094 immutable files still verified.

This launch observed only the launcher. It did not press Play, reach the game
intro, exercise gameplay, controls, audio, or perform an in-game save/load.

## Managed removal and canonical preservation

Managed removal deleted the exact installed version and left its version
container empty. Canonical player data remained present outside the removed
version:

| Canonical file | Size        | SHA-256                                                            |
| -------------- | ----------- | ------------------------------------------------------------------ |
| `input.ini`    | `767` bytes | `a03b43075302081d3c13f513e7d415ac3dc57a35513d36df402a6de7570d52bc` |
| `keybinds.ini` | `605` bytes | `89a37b28295d22664b7793302626e4d04d0240c45355e9b0cc3692928f77ccae` |

The four collected mod-package manifests also remained present. The removed
version's immutable program, generated runtime copy, and projected player files
were not treated as canonical user data.

## Clean reinstall and generated-copy restoration

The clean reinstall created genuinely new installation identity
`0a543be2-8aab-4a60-a198-1e6fef85fad5` with manifest SHA-256
`bc308304a8ba027837c1da72b59fcea3bdc8d497411be87b8c400720dcb72147`.
It again verified all 2,094 immutable files. Before the first post-reinstall
launch, the runtime directory contained neither `.portcove-psx-runtime.toml`
nor runtime `input.ini`; the canonical copies remained in managed user data.

Post-reinstall request `8369d523-b61e-4bf7-a532-629fc957e0aa` reached the same
exact responsive launcher, closed normally, exited zero, and succeeded. The
launch regenerated `.portcove-psx-runtime.toml` with the exact verified source
path and restored runtime `input.ini` and `keybinds.ini` byte-for-byte from
canonical data. The verified immutable `game.toml` template remained unchanged
at SHA-256
`d38e71fd9d58ea07692a228b684b0ff5e4088bd86dd9899a7dc5edd24777031f`.
Final verification again passed 2,094 of 2,094 immutable files.

## Final backup and result

Final healthy backup `bcad0d90-1ddc-467d-aa7c-590647131a4b` contains six
files totaling 7,982 bytes with tree SHA-256
`8d82cbc9c4046e45b87faa1ac0863f4e38cad4615682ed0c8bb2096e138d8a6b`.
Its metadata was created at `2026-09-16T02:05:00Z`. The canonical configuration
files and four mod-package manifests remained the exact collected user-data
set after reinstall.

For the exact artifact/source/variant/platform/check scope above, this bounded
automated lifecycle observation establishes managed removal, preservation of
canonical user data, a genuinely clean v0.1.1 reinstall, prelaunch absence and
next-launch regeneration of the runtime configuration copy, byte-identical
restoration of the two canonical configuration files, and final immutable
verification. It is a separate same-scope observation from the earlier
v0.1.0-to-v0.1.1 update/rollback record.

The following remain explicitly not run or unclaimed:

- Play, game intro, hands-on gameplay, controls, audio, and in-game save/load;
- physical-device behavior;
- Linux and macOS installation or native execution;
- signed upstream provenance; and
- production signing or publication.

The prior qualification record remains authoritative for its exact structural,
update/rollback, native-intro, persistence, and backup/restore observations.
Neither record changes the empty legacy qualification badges, support tier, or
catalog platform declaration.
