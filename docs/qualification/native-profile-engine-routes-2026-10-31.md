# Native profile engines and prepared-copy routes — October 31, 2026

This dated packet owns source and operation facts for eight existing per-port
issues under #2510/#2926. It is not a second roadmap or a Supported designation.
The frozen 858 distinct identities and overlapping historical #1422 denominators
remain unchanged. Windows is the offered managed platform here; other upstream
platforms remain descriptive candidates, not discarded acceptance.

## Offered routes

| Owner                 | Existing capability                   | Original/setup contract                                                                                                                                                                                      | Replacement and player data                                                                                                                                                    |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #2876 Atlantis Native | NativePortable Windows x64 engine     | Normal in-process library/picker; own supported Atlantis I GOG/CD edition with matching atlantis.exe and four BIGCD archives. No new Atlantis II offer.                                                      | Core owns engine replacement. External AppData/atlantis-native and originals remain player-owned; declared atlantis-native-data preserves the dedicated CWD fallback.          |
| #2896 OpenXW          | NativePortable Windows x64 engine     | Normal picker; complete 1994 Collector CD and/or 1998 Windows X-Wing. Optional 1993/B-Wing is a separate mode needing supported menus. Built-in FM synthesis avoids a mandatory synthesizer-ROM requirement. | Core owns engine replacement and narrow local config.yaml; normal TotallyOpen/OpenXW profile and originals remain external.                                                    |
| #2899 OpenXvT         | NativePortable Windows x64 engine     | Normal picker; complete X-Wing vs. TIE Fighter with BalanceOfPower. Base game alone is insufficient.                                                                                                         | Narrow local config.yaml only; normal TotallyOpen/OpenXvT profile remains external. Legacy config2.cfg writer is excluded by XVT_MODERN, not a declared modern runtime output. |
| #2898 OpenXWA         | NativePortable Windows x64 engine     | Normal picker; own complete X-Wing Alliance GOG/Steam installation. Multiplayer is not implemented upstream.                                                                                                 | Narrow local config.yaml/config.cfg; normal TotallyOpen/OpenXWA profile remains external.                                                                                      |
| #2647 NXEngine-evo    | Existing selected-player registration | Complete permitted upstream-prepared Windows nx.exe/data/DLL/translation copy using freeware English Cave Story; Cave Story+ is a different tuple.                                                           | Upstream/player owns replacement, complete data and actual nxengine preference/CWD fallback roots.                                                                             |
| #2878 PanzerChasm     | Existing selected-player registration | Complete working PanzerChasm.exe with own CSM.BIN and companion runtime/shaders; retain --csm/--addon choices. Selected 0.3 source is distinct from current build instructions.                              | Preserve creating CWD, PanzerChasm.cfg, saves/save_XX.pcs, panzer_chasm.log, originals/addons/custom files.                                                                    |
| #2906 OpenChaos       | Existing selected-player registration | Copy all official runtime contents into own complete Urban Chaos 1999 installation upstream; normal OpenChaos.exe, not a bare empty-folder engine.                                                           | Shared AppData/OpenChaos overlay, originals and actual CWD/absolute-path fallbacks remain external.                                                                            |
| #2904 OpenLara        | Existing selected-player registration | Already working coherent Tomb Raider I PC setup: DATA/GYM.PHD and PC level files, completed matching audio/video. Console/later-title branches and Web demo are separate.                                    | Keep complete runtime/data/audio/video and actual AppData/OpenLara save/cache/settings roots.                                                                                  |

The exact selected/current commits, primary paths/blob identities, expected and
observed public package digests, bounded native headers and authoring input
identities are in the [companion JSON](native-profile-engine-routes-2026-10-31.json).
Source references and static bytes do not prove release reproducibility or game
behavior. The three OpenX titles use different pinned Aeron revisions; their
actual VFS/profile consumers were reviewed separately.

## Managed maintenance and failure boundary

The four GitHub release contracts use existing stable-channel asset selection
and provider-authenticated digests, without permanent per-version pins or new
source profiles. Their actual selected Windows ZIPs matched independently
published size/digest; bounded raw-index checks preceded ZIP parsing and bounded
PE-header reads. No member was extracted and no upstream program was executed.
Versioned OpenX wrappers use the executable parent as working/persistence root,
so no hard-coded versioned subdirectory or new adapter is needed. Packaged
resources/config.yaml (W/VT) and resources/remaster/config.yaml (WA) remain
immutable; user config.yaml is a different root file.

Healthy OpenX use requires the current account's writable SDL preference root.
If SDL_GetPrefPath fails, USER and default TEMP can resolve to engine CWD.
Arbitrarily named pilots (.PLT/.plt/.pl2), replays and cache/temp files there are
**unclaimed modified-runtime data**. Existing update, removal and retained-runtime
validation refuses destructive maintenance and retains the creating runtime.
This is a visible preservation fault boundary, not a promise to back up or
migrate arbitrary files. A Core backup of declared config paths is not a backup
of those unclaimed outputs. Preserve the **whole creating runtime and all effective
profiles/original roots** before reviewing recovery; do not delete files to force
an update, overwrite the folder, or assume a fresh download restores progress.
No broad extension exemption, generated-cache policy change, automatic recovery
or dedicated profile framework was added.

Atlantis is different: its dedicated local atlantis-native-data fallback can be
declared completely. The ordinary per-user profile remains external and shared.
Its library migration reads old game-folder.txt only when games.txt cannot be
read, then writes the new library in that same profile; it does not move original
game folders. Per-build save directories retain their actual creating build.
No automatic conversion or backward-save compatibility is asserted.

## Prepared-copy and rights boundaries

NXEngine's selected Windows packaging explicitly prepares freeware English
Cave Story data and translations upstream. Removal of its built-in extractor
does not mean a completed package has no playable data. Its Windows release,
PanzerChasm's older release and OpenLara's moving latest release currently lack
an independently published accepted package digest for managed install. A
freshly computed hash cannot substitute for that identity; their useful already
permitted prepared-copy routes remain available. Reconsider management when
accepted artifact identity and the actual package/setup/persistence offer fit.
OpenChaos's copy-into-original-tree setup remains upstream-owned; no fake
completion marker or new Core data builder was introduced.

OpenLara's selected PC source positively recognizes GYM.PHD and PC level paths.
Its audio lookup accepts track_XX and remapped numbered tracks in the documented
root/audio/1/audio locations; video lookup and codec dispatch must agree (Escape
ARMo, Cinepak FILM or STR are different contents). The guide retains an already
working coherent PC preparation; it does not acquire/convert originals or
certify all retail patches/full campaigns. No later-title screenshot or console
branch is used as proof of that PC tuple.

Keep upstream's actual normal download/run invitation distinct from a whole-IP
license grant. Atlantis's packaged engine and font notices are retained. OpenX
packages retain component license notices; W's absent root license and W/VT's
binary menu font atlas are not relabeled as a whole-payload grant or an invented
private-use prohibition. Engine licenses do not confer original-game, music,
mod or separately authored component rights. No rehosting, signing or publication
authority is added. All originals, external profiles and attached runtimes stay
under their existing owners.

## Validation scope

Maintained preparation accepted all eight exact candidate records before source
application, using the source-bound first-party authoring CLI. Each managed
proposal changed operational declarations; listing-only guide proposals did not.
The four new compatibility identities append to the prior ordered fixture;
all 273 prior managed definitions and the source catalog remain exact. Final
Core parsing accepts 277 declarations / 1,424 listings with matching identities.
Identity bookkeeping is not installed or title acceptance.

Four inert actual-definition lifecycle cases exercise unchanged-definition
N-to-N+1 engine replacement, changed artifact identity, actual executable/working
coordinates, narrow local-state carry and rollback. Three additionally create
representative unclaimed fallback pilots, then assert update and removal refusal,
unchanged active identity and byte preservation, including a stale previously
approved removal intent. Existing staged/version-switch/interruption safety
coverage is reused through ordinary complete-diff selection. Four actual-ID
prepared-player cases use the existing full selected-registration lifecycle
helper. These fixtures do not execute SDL, the original-data picker or a game.

Required exact-head CI and independent full-source/target review are recorded on
the delivering PR. No upstream game/helper/compiler, original/private-save,
installed Desktop, real-save round trip, multiplayer, physical/human, Supported
or protected-publication acceptance is claimed. Complete primary evidence and
retained failures remain in the delivery checkpoint; current planning stays on
its canonical issues and GitHub Project.

## Retained qualification failure and repair

Initial source `2e97b6a2c0438508e3245f2a43db005ae83f26d8` failed Rust
on CI 41184847305/a1: the existing
`catalog::tests::embedded_summaries_leave_structured_facts_to_structured_fields`
rejected the new Atlantis record's retained research summary. All four newly
strict records now use concise outcome summaries, with detailed operation facts
retained in structured presentation and this source packet. Existing tests,
assertions, ownership and lifecycle contracts are unchanged. The failed run,
all producer logs and observations remain retained; its partial passing cases
are not a complete source qualification. Replacement source requires fresh
review and all five exact-head CI contexts.
