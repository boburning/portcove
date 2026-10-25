# MarioKart64Recomp package scope — October 25, 2026

Partial delivery for [#2510](https://github.com/boburning/portcove/issues/2510)
and [#2926](https://github.com/boburning/portcove/issues/2926), canonical port
[#332](https://github.com/boburning/portcove/issues/332). Prepared against
`394560dc57421b7dd8422df4a5761118daa70da1`, reconciled with main
`d4555328c754f89b60744fcae5227729eed09762` before delivery. The exact base SHA
is recorded in the PR; this dated evidence is not a live backlog.

## Reviewed route and inputs

The official [v0.9.2 release](https://gitlab.com/sonicdcer/MarioKart64Recomp/-/releases/v0.9.2)
and pinned [source](https://gitlab.com/sonicdcer/MarioKart64Recomp/-/tree/3885e86a4b2088188ddb3914aa26ad4f147bb5df)
establish a complete Windows x64 runtime. The existing `n64-recomp-portable`
adapter retains original-file validation/materialization, portable setup, explicit
Play, staged replacement, backup and rollback. This is independent of SpaghettiKart
#60; no support, source revision, save or qualification is inherited from it.

The selected official registry file, ID `333130840`, is
`MarioKart64Recompiled-v0.9.2-Windows-RelWithDebInfo.zip`, 23,847,630 bytes,
SHA-256 `4b41226ad7d4c6012878194fa88fe1a83c1fa8f425dfbaa2a7ea87eb01c1c2b4`.
The independently published registry digest and byte count match the acquired
archive. Bounded read-only inspection finds 45 entries, 53,167,059 expanded bytes,
root `MarioKart64Recompiled.exe` (AMD64 PE), DLLs, assets and controller database.
It contains no bundled player/config/mod directories. No extraction or execution
was used for this observation. The selector fixture retains the release's complete
sources/links and the independently joined selected registry file. Its production
selector regression requires every offered platform to resolve the exact runtime,
size and published identity.

The shared `mario-kart-64` source identity is reused unchanged: North American
original, canonical SHA-256
`d6b8538dd63f0132ecb2856e7d32816ed3c30e3e479aecd23cf83fb6ba17a5da`.
Core's existing N64 big-endian materialization writes `mk64.us.z64`; pinned
`src/main/main.cpp` registers `mk64.us` and validates the retail source. No ROM
was obtained. Source applicability evidence binds this observed release/artifact;
it is separate from provider selection and does not pin routine updates.

## Replacement and data boundary

Portcove owns compatible Windows runtime replacement through the existing GitLab
Stable provider and platform hint `windows-relwithdebinfo`. Neither release tag
nor artifact filename/digest is hardcoded into the definition's release selector.
Each acquired replacement still needs its own independently expected identity,
bounded extraction, file verification and current retained-contract checks.

Pinned application configuration and N64ModernRuntime submodule
`ff5daef97fa7623a722dd0adb6adfdb4e6c3b3c5` establish portable settings,
`saves/`, `mods/`, `mod_config/`, `mods.json`, and general/graphics/controls/sound
JSON files. The declaration includes `.bak` and `.temp` recovery siblings and
the materialized original. Save files are cartridge data at `saves/mk64.us.bin`;
upstream quicksaving is explicitly disabled. These observations support the
existing preservation contract; they do not promise future save/mod compatibility.
Rollback carries current declared data, not an earlier save snapshot. Changed
runtime files or undeclared additions retain Core's existing preservation/refusal
behavior. Existing external copies remain externally owned and are never adopted.

The reviewed release enables single-player modes; upstream multiplayer controller
configuration is unfinished. This limitation is visible in the setup guide.
There are no new native/gameplay, installed-lifecycle or real-save observations.
The operational record remains beta with empty tested-platform arrays.

## Other platforms and remaining GitLab inventory

The Linux x64 ZIP is 13,126,507 bytes, registry SHA-256
`46d4c34f755111daa460c64d34c1e97a932a3406995936ae1f059453a4fba819`.
Its sole entry is `MarioKart64Recompiled.tar.gz`; Core does not recursively unpack
that wrapper. The guide explains manual two-stage extraction followed by explicit
external registration/Play. macOS keeps upstream's complete `.app` bundle and
setup instructions. External Linux/macOS updates belong to upstream. Preserve
their actual data roots separately (`~/.config/MarioKart64Recompiled/` and
`~/Library/Application Support/MarioKart64Recompiled/`, or the explicitly chosen
portable folder). Registration does not grant managed backup/rollback/deletion.

The six authored GitLab identities were enumerated from source
`dc2e4a0606e73eb6480682ab0eca751122de7e12`, observed October 25 at 17:42 UTC.
Each project and all release pages returned HTTP 200 with terminal pagination;
package/source observations followed separately. This finite retrieval is complete
for these six URLs, not an all-port fit or native acceptance claim:

| Identity / canonical issue  | Disposition in this delivery                                 | Remaining fact or operation                                                                                                |
| --------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Extreme-G / #72             | Existing richer managed route retained                       | No new platform qualification or package-layout reassessment claimed                                                       |
| Duke Nukem Zero Hour / #140 | Existing richer managed route retained                       | Existing Windows scope/evidence retained                                                                                   |
| MarioKart64Recomp / #332    | Windows managed N64 route; Linux/macOS upstream alternatives | Native lifecycle/gameplay and optional qualification remain distinct                                                       |
| Starfox64Recomp / #333      | Existing listing retained; real Windows package identified   | USA revision 1.1 source needs narrower representation admission than the existing broad profile; implementation unfinished |
| Digimon World / #357        | Existing listing retained; setup ZIP identified              | Generated runtime/setup-launcher boundary and owned-disc contract still need review                                        |
| LADX HD Updated / #1838     | Existing listing retained; ten published releases observed   | Patcher/original-release inputs, self-update ownership and concrete non-owning handoff still need review                   |

The general GitLab self-service downloader and these remaining fit decisions stay
open under #2510/#2926. Source/API observations do not make an entry Reviewed or
Supported. All original 524 identities, 312 affected additions, 22 roadmap joins,
six Direct maintenance decisions and canonical ownership remain in scope.
This additional MK64 route is outside the historical 232 proposal-path cohort;
it does not decrement that cohort's remaining count. #1422's cohort is unchanged.

## Verification scope

Maintained preparation accepted 163 operational definitions / 880 listings with
the existing Core declaration validator (source `50cb21a245aa817fa16ebbaef50e7d653140d543`,
binary SHA-256 `f0d95d33eeb7d55cd0e8d646fa02c084d3bab77334fd077d643057c96204ed79`).
Its declaration behavior is compatible; this is not an exact-current Core build.
The prepared record omitted artwork, so the exact accepted artwork was explicitly
restored. The single-player guidance was added after preparation. Failed missing
source-binding and mismatched-label attempts are retained separately. Generated
aggregates come only from maintained per-ID/shared sources and generation tools.
Final exact-head hosted checks, independent review and merge evidence belong to
the PR and canonical issue. No upstream installer/helper/compiler/game ran; no
native, packaged Desktop or real-save acceptance is inferred. #2225/#47/#48 and
#534/#246 retain their independent acceptance and authority.
