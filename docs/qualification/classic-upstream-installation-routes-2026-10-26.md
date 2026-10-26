# Classic upstream installation routes — October 26, 2026

This is a four-port component of [#2510](https://github.com/boburning/portcove/issues/2510)
and [#2926](https://github.com/boburning/portcove/issues/2926), based on verified main
`303861a08f0f803d0ae7e063e26478ac46da47e1`. The
[structured evidence](classic-upstream-installation-routes-2026-10-26.json) records
source identities, platform limits, acquisition conditions and validation scope.
Candidate status is intentional: the canonical owners record later review, checks,
merge/readback and actual delivery. This report is not a live backlog.

## Player outcome and ownership

| Identity / owner                                                                     | Selected useful route                                                                                                                | Runtime and player-data boundary                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arcanum Community Edition / [#828](https://github.com/boburning/portcove/issues/828) | Concrete prepared-copy instructions while retaining the owner-approved upstream dependency                                           | Own GOG/Steam data in a separate working copy; native drop-in player. No published GitHub player release, downstream engine build or managed data contract.         |
| OpenCiv3 / [#1850](https://github.com/boburning/portcove/issues/1850)                | Conditional permitted-copy setup, then original-content selection in the player; hold package acquisition                            | Windows player and companions stay together. C7.ini, Text, Assets and selected save locations remain external, including saves written to the original Civ3 folder. |
| CannonBall DX / [#1132](https://github.com/boburning/portcove/issues/1132)           | Conditional permitted Windows copy with compatible user-owned Revision B ROMs; hold ROM-bearing package acquisition                  | Working directory, runtime companions, ROMs, music, settings and scores stay external. Other CannonBall implementations do not establish DX platform support.       |
| OpenRA / [#1852](https://github.com/boburning/portcove/issues/1852)                  | Recommend the stable Windows x64 portable ZIP; choose one of three game players explicitly; keep upstream native launchers elsewhere | First explicit Play opens the selected game's content setup. Actual OpenRA profile, content, settings, saves, maps and mods remain external.                        |

The player/upstream owns replacement for these routes. Registration preserves files
and does not promise managed Update, Backup, Rollback or external-folder removal.
Saving launch details and read-only discovery execute no player, installer,
extractor or helper. Deliberate Play and upstream setup consent remain separate.
Existing registrations and their retained contracts are unchanged.

All 167 existing managed definitions, all 1,424 authored identities, artwork,
canonical ownership and lineage remain unchanged. These four records gain useful
metadata and shared handoffs; no managed adapter, per-game code, new lifecycle
engine or parallel identity is added. #828's existing product deferral remains
open and Deferred; these instructions do not resurrect downstream engine repair.

## Reviewed facts and remaining conditions

**Arcanum.** [Pinned upstream instructions](https://github.com/alexbatalov/arcanum-ce/blob/a7ff41b300ef712f0e7d088183a3d08957110cdd/README.md)
name the required Arcanum data and native replacement players. Complete observed
GitHub release pagination is empty. The listing now says source-only rather than
suggesting a published download. Preserve the separate original installation and
whole external working copy. The [existing owner amendment](https://github.com/boburning/portcove/issues/828)
still controls reconsideration: a suitable upstream executable/setup interface or
an identified useful user-owned native installation with the necessary operation
facts. No save-parser, codec or filesystem fork is authorized by this batch.

**OpenCiv3.** The selected [Dutch preview](https://github.com/C7-Game/OpenCiv3/releases/tag/v0.3-dutch-preview-1)
resolves to `5a2a868b3411db71528d7b0fd51d80cdbb37aac1`. Its current Windows
publisher digest still matches the retained October 24 static package inspection:
`0f0748227061388ab958045952817945f152e5d17d308b5514f8c285c726376b`.
The packaged asset README separates the unlicensed placeholder bundle from MIT
engine code; individual credits are not blanket compatible grants. The current
[Assets README](https://github.com/C7-Game/Assets/blob/9af005c42bd3c0c60e0e10e1a7446015ade81056/README.md),
[asset notice](https://github.com/C7-Game/Assets/blob/9af005c42bd3c0c60e0e10e1a7446015ade81056/NOTICE.txt)
and [current engine notice](https://github.com/C7-Game/OpenCiv3/blob/c1370e2f63a6042a3c4206f0043543d7da0d5cc5/NOTICE.md)
retain that separation. Acquisition can be reconsidered with attributable grants
covering the affected assets or an offered package omitting them. An existing
permitted copy keeps a useful route. Windows layout evidence does not establish
Linux/macOS native behavior; their separately published packages remain upstream
preparation, with native layout/runtime observations unknown.

**CannonBall DX.** The selected [1.04 release](https://github.com/Endprodukt/cannonball-dx/releases/tag/1.04)
resolves to `afbe061c50ad1aa50795daa98e4ab689a4d3ca46`. The current advertised
`CannonballDX_1.04.zip` digest still matches the retained October 24 inspection:
`d5104e1a886213994fdcdd5dc781753145f7e9ac33e87b4ae15cde485dc9a362`.
That inspection found `roms/outrun.zip` (3,004,457 bytes), including the named
Revision B components, without executing or extracting game data for use.
Engine and third-party code licenses do not establish permission for those
original-game contents. An asset-free package or attributable permission is the
precise acquisition resume condition. The [pinned README](https://github.com/Endprodukt/cannonball-dx/blob/afbe061c50ad1aa50795daa98e4ab689a4d3ca46/README.md)
describes Windows-only DX scope and CRC/size-based ROM loading. This preserves
DX's separate identity and does not settle original CannonBall [#120](https://github.com/boburning/portcove/issues/120).

**OpenRA.** The stable [release-20250330](https://github.com/OpenRA/OpenRA/releases/tag/release-20250330)
resolves to `b4f3d8ae02b6bd6f4a3a5441e6d0daf7c5073787`. Its
[Windows packaging](https://github.com/OpenRA/OpenRA/blob/b4f3d8ae02b6bd6f4a3a5441e6d0daf7c5073787/packaging/windows/buildpackage.sh)
contains RedAlert.exe, TiberianDawn.exe and Dune2000.exe, plus non-player tools.
The portable recommendation excludes the installer and x86 package without
silently selecting a game. The existing one-target managed definition cannot
truthfully substitute three different games, and the observed stable assets
publish no independently expected digest. Neither a local hash nor a newer
preview's digest authenticates that stable package. Keep the supported non-owning
setup route; reconsider managed replacement with both appropriate retained
launch selection and independently expected artifact identity.

Linux has game-specific AppImages; macOS packaging preserves separate Intel and
Apple Silicon application bundles. These use upstream setup rather than the
managed ZIP/tar adapter. The [pinned profile resolver](https://github.com/OpenRA/OpenRA/blob/b4f3d8ae02b6bd6f4a3a5441e6d0daf7c5073787/OpenRA.Game/Platform.cs)
uses the Windows AppData, Linux XDG config or macOS Application Support profile;
a local Support directory, legacy profile or explicit override can change it.
Preserve the actual profile and a working runtime when updating. Source and
packaging evidence is not native execution or save compatibility qualification.

## Complete identity refresh; unfinished rollout stays visible

The maintained collector completed repository-issue and active/archived Project
pagination at `2026-10-26T20:51:12.867Z`, against source `303861a0…`:
1,922 repository issues, 1,921 active Project records, one archived record,
1,512 canonical port rows, 1,424 authored identities and 86 distinct roadmap-only
identities: **1,510 known distinct identities**. Raw source/receipt SHA-256 values
are recorded in the structured report. This is identity coverage, not fit approval.

The original **524 / 312 / 22** cohorts are preserved separately. Seventeen of
the original 22 roadmap-only identities now have authored records; five remain
unlisted. Duplicates #554 → #356 and #1786 → #322, same-issue aliases #281/#320,
and existing owners/deferrals are retained. Marker-role normalizations do not
create identities. OpenSC2K's reviewed relocation retains repository ID 120053075
and its stable ID; both old/current endpoints still resolve to the same opaque
repository/node identities. There are no unresolved identity conflicts in this
refresh.

Newly observed canonical [Smash4PC #3706](https://github.com/boburning/portcove/issues/3706)
retains its Wii U identity, repository ID 1433109248, existing acquisition/provenance
and content-permission gate, and Unscheduled/Watchlist owner. It gains no catalog
admission or Public beta obligation. This does not absorb a different Smash game.

Individual fit and maintenance decisions remain unfinished. All six Direct/legacy
owners (#152/#164/#165/#113/#154/#1113) remain open work. This batch does not close
#2510/#2926, shrink the original commitment, expand #1422's frozen cohort, or
absorb #2225/#47/#48/#534/#246. Full Public beta acceptance remains **false**.

## Validation boundary

Use maintained per-ID preparation, Core declaration inspection and generated
catalog validation for the candidate; exact-head hosted checks and independent
non-writing review are recorded on its PR. No new runtime code or client contract
changes require a bespoke lifecycle fixture in this metadata batch. The two held
packages were not reacquired: their unchanged current publisher identities are
compared with retained static inspection. Complete release histories and bounded
pinned source reads are separate from artifact/native evidence. No original
inputs, upstream player/helper execution, native gameplay, real-save acceptance
or packaged Desktop qualification is claimed.
