# DOS engine upstream routes — October 27, 2026

Partial implementation for [#2926](https://github.com/boburning/portcove/issues/2926)
and parent [#2510](https://github.com/boburning/portcove/issues/2510), starting at
main `57e7c3c3237fbaba381c24cb1eb95c935d344942`. The
[dated packet](dos-engine-upstream-routes-2026-10-27.json) binds each identity,
canonical owner, original-data boundary, package, executable, source and remaining
managed fit. Canonical issues and Projects retain live ownership. This is not a
new status registry, managed admission or full rollout completion.

| Shared upstream route | Distinct canonical owners                                                                                                                                               | Original-data boundary                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ReflectionHLE         | Keen Dreams #2683; Descent #2684; Abyss #2685; Armageddon #2686; Apocalypse #2687; Wolfenstein 3D #2688; Spear of Destiny #2689; DOS Noah's Ark #2690; Bio Menace #2692 | Complete matching DOS executable and data, checked by upstream's per-version size/CRC tables and launcher. Separate games, episodes, shareware and registered revisions stay distinct.                         |
| Crispy                | Doom/Ultimate #2654; Doom II #2655; Final Doom #2656; Heretic #2657; Hexen #2662; Strife #2663                                                                          | The game's own original PC IWAD. Doom and Heretic shareware are limited alternatives for those games only. Final Doom retains TNT/Plutonia choice. Strife needs commercial v1.2 or newer; demo is unsupported. |
| CatacombGL            | Descent #2643; Abyss #2644; Armageddon #2645; Apocalypse #2646                                                                                                          | Own Catacombs Pack data. Only Abyss has the documented shareware v1.13 alternative. This implementation remains separate from ReflectionHLE.                                                                   |
| Omnispeak             | Keen 4 #2648; Keen 5 #2649; Keen 6 #2650                                                                                                                                | Keen 4/5 v1.4 EGA; Keen 6 v1.4/v1.5 EGA, matching episode support files and original maps/graphics/audio. Keen 4 shareware does not provide 5/6; no new retail acquisition of 6 is established.                |

All 22 are existing members of the frozen 312 affected additions. Their guides
use the existing shared download, explicit launch-details, registration and Play
capabilities. No new adapter, helper runner, source profile or persistence engine
is introduced. Updates remain `user-managed-update`: upstream and the player own
runtime replacement, original files and profiles. Registration-only removal
preserves external bytes. Managed Update, Backup, Rollback, migration and external
deletion are not offered by these guides.

## Source and package observations

The four release traversals terminate within one 100-entry page: ReflectionHLE
25, Crispy 54, CatacombGL 16 and Omnispeak 3. Selected release inventories and
non-truncated tagged source trees are retained in the packet. Read-only Windows
ZIP inspection checked finite compressed, metadata, entry-count and expanded
limits before reading bounded native headers and setup documents. No runtime,
helper, original executable, installer or game ran.

- ReflectionHLE `release-20260606`: sole AMD64 `reflectionhle.exe` inside its
  wrapper, with SDL3 and Speex DSP companions. Publisher SHA-256 matches inspected
  bytes. The exact tagged game-definition headers identify original executable,
  required file sizes/CRCs and version-specific writable directories; these are
  upstream input checks, not newly admitted Portcove source identities.
- Crispy `crispy-doom-7.2`: four separately selected AMD64 player archives, each
  with a game-specific setup tool and a separate truecolor executable. All four
  publisher digests match inspected bytes. The guide deliberately selects the
  normal game player and keeps setup explicit. Tagged `d_iwad.c` distinguishes
  original IWADs; `README.Strife.md` retains the demo/v1.1 limitations and speech
  companion rule.
- CatacombGL `v0.5.7-beta`: Windows x64 ZIP, one AMD64 `CatacombGL.exe` and SDL2.
  Every observed release is prerelease, so authored channel `beta` supplies the
  UI's Preview choice. No stable release is invented. No publisher digest is
  present; the recorded computed hash identifies inspected bytes only. Linux's
  tar.xz is an upstream/system extraction handoff, not managed package support.
- Omnispeak `v1.1`: official stable Windows x64 ZIP with one AMD64
  `omnispeak.exe`, episode support files and original README. Each episode uses a separate working player copy; the matching data/keen4, data/keen5, data/keen6e14 or data/keen6e15 contents and original three files must be placed beside the player. Selecting /EPISODE does not search those packaged subdirectories automatically. The modding preview
  is separate. No publisher digest is present; the computed hash is not
  independent authentication. Keen 6 explicitly chooses `6v14` or `6v15` with
  `/EPISODE`; `/GAMEPATH` and `/USERPATH` keep originals and writable profiles
  separate when the player chooses those paths.

Stable package hints distinguish engine, Windows architecture and archive type.
The selected channel and complete selected asset list must produce exactly one
recommendation per identity. This is generic download guidance, not managed
automatic-release compatibility or a promise that future packages remain safe.

## Data and compatibility boundaries

ReflectionHLE's Windows profile normally uses `%APPDATA%/reflectionhle`, with
separate per-version writable directories. Explicit data/config locations remain
external. Several game entries share settings. Original EXEs are upstream input;
they are not the Windows player selected for registration.

Crispy Windows normally writes configuration and saves beside its player.
Explicit configuration/save arguments can redirect them. Separate games or Final
Doom campaigns sharing an engine folder may share settings and slots; keep
separate copies or explicit profiles. The guide preserves the whole working
copy, actual profile, originals and selected mods rather than promising a
complete managed write contract.

CatacombGL uses the actual Roaming AppData `CatacombGL` profile on Windows;
custom INI/log locations remain external. The reviewed beta documents no
controller support or original-DOS-save compatibility. Shared game titles do not
establish interchangeability with ReflectionHLE saves. Omnispeak profiles can use
an explicit `/USERPATH`; upstream build defaults and SDL fallback remain distinct
from that deliberate selection. Upstream's DOS-save claim is not a Portcove
real-save observation.

Close all copies and preserve actual original, profile and overridden locations
before replacing upstream files. Keep the working runtime until its saves work
in a replacement. These guides establish no populated-data adoption, persistence
scope contraction, cross-version state conversion or change to retained managed
installations.

## Delivery and remaining work

The cohort changes 22 listing records and generated listings. All 1,424 existing
identities and all 167 operational definitions remain. Artwork, lineage, existing
acquisition conditions and unrelated records are preserved. No Supported stage
or tested-platform promotion follows from source, archive or authoring checks.

Managed fit remains unfinished for each identity. Resolve the exact original
representation/completion contract and full writer/profile ownership before
offering runtime replacement. ReflectionHLE's external shared profile and
version-specific data need an expressible ownership boundary; Crispy needs a
per-game/profile and mod interpretation; CatacombGL/Omnispeak also need accepted
independent artifact identity for curated managed acquisition. These are precise
next investigations, not new permanent product deferrals or claims that a useful
non-owning route has completed every promised operation.

The full frozen union remains 858 identities: 524 original, 312 disjoint affected
additions and 22 disjoint roadmap-only joins. All 316 canonical identities in
#1422's historical 317-row crosswalk are already in the original 524; do not add
them again. Five original roadmap identities remain unlisted. The six retained
Direct decisions, complete per-platform fit/maintenance and final reconciliation
remain unfinished. Completed #2494/#254 stay consumed. #2225/#47/#48 and
#534/#246 retain independent acceptance and authority.

Exact final source, independent review, executed checks, guarded merge and remote
readback belong to the PR. This dated candidate packet does not claim those
future outcomes or erase earlier failures.
