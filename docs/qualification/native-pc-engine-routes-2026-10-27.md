# Native PC engine upstream routes — October 27, 2026

This bounded #2926/#2510 cohort adds twenty setup/non-owning Windows player
guides and preserves one existing research-only decision. It starts from main
`55e6bb8c6c860d4b1ad39d89fd7b396bb9f809cd`. The
[dated packet](native-pc-engine-routes-2026-10-27.json) records each canonical
identity, original data, player, source references, package observations and
unfinished managed fit. It is evidence, not a new live status authority.

| Upstream route         | Canonical owners                                                                   | Original and preparation boundary                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BStone                 | Aliens of Gold #2555; Planet Strike #2556                                          | Full matching BS6 or VSI files. BS1 shareware provides only limited Aliens of Gold content. Explicit game/data selection and external shared profile.                                       |
| DXX-Rebirth            | Descent #2652; Descent II #2653                                                    | Separate D1X/D2X players and complete respective original or documented demo/shareware file sets. Current Windows distribution uses Actions artifacts, not an invented tagged binary asset. |
| OpenXcom               | UFO Defense #2619; Terror from the Deep #2620                                      | Complete unmodified original subfolders in separate UFO/TFTD roots. A TFTD-capable build is required; do not assume an older UFO-only release suffices.                                     |
| GemRB originals        | Baldur's Gate #2628; BGII #2629; Icewind Dale #2630; IWDII #2631; Planescape #2632 | Complete installed original working copies, per-game configuration and save roots, and dedicated private caches. Expansions/language/patches retain their own installed identity.           |
| GemRB Enhanced Edition | BG2EE #2633                                                                        | Existing experimental/revision research remains pending; no ordinary original-edition guide, new support promise, acquisition hold or permanent deferral is added.                          |
| Open Fodder            | Cannon Fodder #2641; Cannon Fodder 2 #2642                                         | Required campaign data plus CF1 DOS CD CF_ENG.DAT or all CF2 DOS CD files in their distinct folders. Installer and installed player are separate.                                           |
| Exult                  | Black Gate #2621; Serpent Isle #2622                                               | Original installed STATIC data, separate game configuration and saves. Optional Forge of Virtue/Silver Seed remain separate choices.                                                        |
| DevilutionX            | Diablo #2563; Hellfire #2564                                                       | Base DIABDAT.MPQ; Hellfire additionally needs its four expansion MPQs. Limited shareware is not Hellfire. Explicit --diablo/--hellfire preserves game intent.                               |
| OpenMW                 | Morrowind #2616                                                                    | Original PC data/configuration through upstream wizard/launcher, deliberate content/mod order and external OpenMW saves. Register the installed player after setup.                         |
| dhewm3                 | Classic Doom 3 #2567; Resurrection of Evil #2568                                   | Original 1.3.1 base PK4s; expansion also needs its d3xp PK4s. BFG Edition is separate and unsupported by this engine. Official Windows player is PE32.                                      |

All twenty-one are already frozen affected-addition members. No identity,
artwork, lineage, acquisition condition or operational definition changes.
The 167 operational definitions remain intact. Existing shared download,
upstream setup, literal launch details, supervised Play and registration-only
removal supply the useful operations. Upstream/player retain runtime replacement,
original files, mods and profile ownership (`user-managed-update`). Core receives
no external backup, rollback, migration or deletion authority.

## Consequential setup and data decisions

GemRB cleans `CachePath`, including on startup/load/teardown. Each guide therefore
requires a dedicated empty private cache, separate from originals, saves and
profile roots. `SavePath` names the parent containing `save/`. GemRB can first
write `gem-*.ini` into `GamePath`, so a private save root alone does not isolate
original installation writes. The guides use separate complete working original
copies and a per-game `-c` configuration, preserving all actual data/config/save
locations. Development `@...@` placeholders are not a finished configuration.
BG2EE's experimental fit is not inherited from original BGII.

OpenXcom can use the actual Documents profile or installation-local/explicit
locations. Its UFO/TFTD originals, standard resources, mods, configuration, saves
and screenshots remain separate from registration storage. DXX's actual writable
directory can depend on its build/home overrides; preserve it and the working
player/data directories. Neither guide guesses that every save lives beside the
selected executable.

Open Fodder's installer can choose Documents or installation-local data.
Campaigns are required alongside retail originals, and the two DOS CD layouts
are not interchangeable. OpenMW uses a deliberate upstream wizard/launcher before
the actual `openmw.exe`; original-engine and OpenMW saves are different formats.
Exult retains its per-game/mod save and gamedat configuration. BStone and
DevilutionX retain their actual shared external profiles and mode distinctions.

dhewm3's inspected Windows ZIP contains `dhewm3.exe`, `dhewm3_notools.exe` and
`dhewm3ded.exe`. The guide selects the game player explicitly. Existing Core
setup discovery accepts PE32 as well as AMD64 on the Windows host route; no
x64-artifact claim or new compatibility layer is introduced. The main 1.x Win32
package hints distinguish it from the optional mods archive while keeping
ordinary 1.x version changes independent of a minor-version filename pin.

## Source, package and selection evidence

All nine upstream release inventories terminate: Exult needs seven pages and
contains 647 entries; the other eight fit within one 100-entry page. GemRB has
release metadata without binary assets; OpenXcom has no GitHub releases. DXX's
documented Actions distribution is distinct from tagged releases. Those routes
receive no invented GitHub ZIP recommendation. Upstream installers and source-
prepared/existing players keep their appropriate manual handoffs.

Three actual Windows ZIPs were inspected without extracting or executing code:
BStone v1.3.4, DevilutionX 1.5.5 and main dhewm3 1.5.5. All three publisher
SHA-256 digests match the bytes; bounded ZIP metadata and native-header reads
identify players and companions. BStone and DevilutionX are AMD64; dhewm3 is
PE32. The packet retains archive identities, limits and entry/header observations.
Open Fodder/OpenMW installer roles and installed player identities are supported
by pinned upstream setup/build sources; no installer execution or extracted
player observation is inferred from an installer filename.

Every captured source text binds an exact Git blob and available commit/tree, or
the exact dated official website bytes. Package tags and separately current
upstream preparation documentation are distinguished; this is not a reproducible
source-to-binary build attestation. BStone's separate signatures remain signatures;
Core's existing package suitability excludes signature sidecars. A raw substring
hint count is not a count of installable runtime packages.

Existing authoring/generation, selection/refusal and registration/ownership
coverage remains applicable. Final exact source, independent review, executed
checks, guarded merge/readback and canonical reconciliation belong to the PR.
No original game, player, helper or installer ran; no native, gameplay, populated
save, installed Desktop or Supported-stage promotion is claimed.

## Remaining acceptance

Managed fit remains individually unfinished. Establish the exact original/
completion contract, complete writer/profile ownership, independently accepted
artifact identity and compatible runtime progression before adding management.
Missing current binary assets, expired Actions artifacts or an installer handoff
do not justify a per-title build engine or an invented playable package.
BG2EE needs an actual matched build/data-revision assessment before ordinary
setup can be offered. These are explicit continuation tasks, not new permanent
product deferrals.

The frozen 858-identity union and historical 317-row/316-identity subset remain
unchanged. Broader fit/maintenance and accepted-route/Supported-operation joins,
the six retained Direct constraints and independent #2225/#47/#48/#534/#246
acceptance remain open at their exact scope. #2494/#254 stay consumed; this cohort
does not close #2510/#2926 or expand #1422.
