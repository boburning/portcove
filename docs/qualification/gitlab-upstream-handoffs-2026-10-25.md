# GitLab upstream and existing-copy handoffs — October 25, 2026

Partial delivery for [#2510](https://github.com/boburning/portcove/issues/2510)
and [#2926](https://github.com/boburning/portcove/issues/2926), based on delivered
`ed20254dca7314e9487d835a1b7a91b031c37f54`. This packet changes four listing
guides; all 162 operational definitions and 1,410 identities remain intact.
It does not make the whole inventory Reviewed or Supported.

The six authored GitLab URLs were enumerated from source
`dc2e4a0606e73eb6480682ab0eca751122de7e12`. Complete project and release
pagination observed at 17:42 UTC returned HTTP 200 and terminal pages for all
six. Package registry, pinned-source and bounded archive observations followed
separately. Metadata availability does not establish permission, executable fit,
native qualification or supported management.

| Identity / canonical issue  | Current and selected route                                                                                          | Update/setup/data boundary                                                                                               | Remaining operation or condition                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MarioKart64Recomp / #332    | Listing → permitted complete existing Windows player; explicit Linux two-stage unpack/macOS upstream bundle handoff | Upstream first Play validates the North American original; external copy/profile belongs to user/upstream                | Fresh acquisition held for actual packaged Chiaro grant. Managed candidate 90701a50 is preserved; Core capability 4 now exists, but route adoption remains unfinished |
| Starfox64Recomp / #333      | Listing → permitted complete existing Windows player                                                                | Upstream first Play validates USA revision 1.1; external profile and updates remain upstream-owned                       | Same actual Chiaro grant condition. A future managed contract must narrow source representations; the broad Star Fox profile cannot be copied blindly                 |
| Digimon World / #357        | Listing → upstream setup/rebuild, then register the finished Windows player                                         | Own USA BIN/CUE, optional retail BIOS or upstream OpenBIOS generation; upstream owns tools, generated runtime and caches | Managed fit remains unfinished: fixed SDK/CLI compatibility and duplicate generic-registry artifact resolution still require review                                   |
| LADX HD Updated / #1838     | Listing → upstream patching of a permitted existing PC-port copy, then register the finished player                 | Upstream patcher/Launcher owns runtime replacement; actual profile/mods/original Content/Data stay external              | No ready-archive replacement promise for the patcher/self-updating launcher. Missing original PC-port assets are not supplied by Portcove                             |
| Extreme-G / #72             | Existing richer N64 managed route retained                                                                          | Existing source, data and Windows qualification remain authoritative                                                     | No new platform/artifact/grant qualification is inferred by this guide delivery; remaining offered-platform review stays under the existing owner                     |
| Duke Nukem Zero Hour / #140 | Existing richer Windows N64 managed route retained                                                                  | Existing exact source, GitLab provider and historical qualification stay intact                                          | No new qualification or change to installed contracts; broader package review remains separate                                                                        |

## Mario Kart 64 and Star Fox 64

The official [MK64 v0.9.2 release](https://gitlab.com/sonicdcer/MarioKart64Recomp/-/releases/v0.9.2)
and [SF64 v1.0.3 release](https://gitlab.com/sonicdcer/Starfox64Recomp/-/releases/v1.0.3)
join independently published registry records:

| Windows archive                                         | Registry file | Bytes      | Expected and observed SHA-256                                      |
| ------------------------------------------------------- | ------------- | ---------- | ------------------------------------------------------------------ |
| MarioKart64Recompiled-v0.9.2-Windows-RelWithDebInfo.zip | 333130840     | 23,847,630 | `4b41226ad7d4c6012878194fa88fe1a83c1fa8f425dfbaa2a7ea87eb01c1c2b4` |
| Starfox64Recompiled-v1.0.3-Windows-RelWithDebInfo.zip   | 333158626     | 24,382,268 | `768c18b0aeb325a0102f722338f09a270a76eeebea29154764147a93d0bde530` |

Read-only bounded entry/header inspection identifies their complete root players,
DLLs/assets, and AMD64 PE headers. Pinned application sources
`3885e86a4b2088188ddb3914aa26ad4f147bb5df` (MK64) and
`061d4c8050c07bcac09a4074657ec4e49a1504b9` (SF64) establish first-Play ROM
validation and portable/profile coordinates. MK64's reviewed release currently
enables single-player modes. Its Linux ZIP contains only
`MarioKart64Recompiled.tar.gz`; the guide explains both extraction layers instead
of promising managed recursive extraction. macOS retains upstream's complete
application bundle and instructions.

Both Windows archives contain byte-identical `ChiaroBold.otf` and
`ChiaroNormal.otf`. Their own name notices identify Fontworks Japan and reserve
rights; they do not provide an applicable redistribution grant. Complete pinned
source trees retain parent GPL COPYING and a separate Promptfont license;
Lato/Noto have OFL notices. Those facts do not settle Chiaro's separate grant.
This is an unresolved acquisition condition, not a finding of illegality or a
permanent product deferral. Core's existing listing download hold names the
component and reconsideration condition. Existing permitted copies retain
registration and explicit Play; no external file is adopted or deleted.

Normal Windows profiles use `%LOCALAPPDATA%/MarioKart64Recompiled/` and
`%LOCALAPPDATA%/Starfox64Recompiled/`. Preserve actual selected/portable locations,
originals, saves, settings, recovery siblings and mods separately. Existing
external registrations do not gain managed Update, Backup or Rollback.

## Digimon World

Pinned project source `978ea38eb594354724772ba611a22372e1809476`, its
`DISC.md`, and the actual setup package establish USA SLUS-01032 BIN/CUE input.
The documented BIN is 381,771,936 bytes, SHA-1
`5611645da66183e30d11fb6c11a2784ff47e1fdb`; no disc was acquired. Setup can
regenerate OpenBIOS or accept the player's optional retail SCPH-1001 input.

The official v0.3.5 registry has two same-name Windows ZIP records. This packet
inspects immutable registry file 345027966, 29,195,790 bytes, independently expected
and acquired SHA-256
`b5ac8a122bd57fa34004922db0455a74454f5688925bbedd4fd951774af8b3f1`.
It does not claim that the mutable generic release URL uniquely selects that ID.
Bounded central-directory inspection observes 2,049 entries, 191,533 metadata bytes
and 73,321,390 expanded bytes before reading selected text. The initial private
2,000-entry inspection limit refused this package before parser allocation; the
bounded investigation used 4,096 entries with the same 1 MiB metadata and 256 MiB
expanded-work bounds. No executable was extracted or run.

The packaged `README-SETUP.txt`, `codegen_setup.c` and
`psxrecomp/host/psxrecomp_codegen_host.c` distinguish the root setup host from
`build-release/Digimon_World_Recompiled.exe`. On Windows the setup host forwards
with `CreateProcessA`, closes its child handles and exits. The guide registers
the completed product directly, with project-root working directory and
`--game`, `game.toml` and `--launcher` as three separate lines in Portcove’s
Arguments field, following the packaged product handoff and batch
arguments rather than relying on detached-parent tracking. User-triggered
upstream Generate/rebuild remains separate from registration and Play.

Preserve the full prepared project, its actual saves/mods/settings and any
original/BIOS elsewhere. Upstream warns that save states/rewind depend on matching
mods; ordinary memory-card saves retain their separate role. This guide does not
prove compatible managed replacement or qualify a downstream rebuild.

## LADX HD Updated

The direct [v2.0.9 release](https://gitlab.com/bighead.0/ladxhd_updated/-/releases/v2.0.9)
is one of ten observed published releases. Full platform patchers link to
PixelDrain; Lite patchers link to official GitLab registry files. No patcher,
original PC-port content or game package was acquired or executed.

Pinned source `718195bf972cb3fd87ed73af88e44899197d7a0e`, README,
MANUAL/Linux/macOS guides, `HomeView.axaml.cs`, `Config.cs`,
`PlatformServices.cs` and save code establish the handoff. Patching needs a
permitted v1.0.0 or compatible v1.1.4+ PC-port root and its Content/Data assets;
a Game Boy ROM is not that input. The Launcher can replace/restart itself and
update the game. Its Play button starts a separate player and closes the window,
so the guide registers `Link's Awakening DX HD.exe` directly on Windows or the
finished native Linux player, keeping upstream's Launcher useful separately.
macOS preparation stays with its specific upstream bundle guide; no quarantine
bypass, signing script or discovered helper executes during Portcove discovery.

Windows user data normally uses LocalApplicationData/Zelda_LA, with SaveFiles,
settings, advanced, achievements and launcher state; existing portable.txt mode
uses the game folder. Mods normally remain beside the game; AppImage selects
the external Zelda_LA/Mods root. Preserve the actual profile, mods and permitted
original assets before upstream replacement. Registration never grants management
or backup rights over these locations.

## Verification and remaining scope

All four exact authored proposals passed maintained per-record preparation on
delivered main. Operational projections are unchanged: this is listing-structure
feedback, not another Core/native qualification. Existing artwork, canonical
issues, identities and upstream lineage are preserved. Derived listings are
regenerated from current sources, retaining the concurrent 530 additions.
Complete-candidate review, final hosted checks and merge evidence belong to the
PR and canonical records.

The original 524 identities, 312 affected additions, 22 roadmap joins and six Direct
maintenance decisions remain in scope. Core PR #3641 is credited separately;
these guides do not enable a managed N64 route or settle generic GitLab download
support. No entry becomes Reviewed solely for catalog membership. #2510/#2926
remain open; #2225/#47/#48 acceptance and #534/#246 authority remain independent.
