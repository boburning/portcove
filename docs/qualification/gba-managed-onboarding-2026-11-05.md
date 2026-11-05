# Managed GBA onboarding — November 5, 2026

This batch contributes to [#2926](https://github.com/boburning/portcove/issues/2926).
The sample uses existing catalog identities and prior inspected routes. The
grouping describes the operation under review. It carries no planning status.

| Count | Candidates                                                                                                                           | Result                                                                                                                                                                         |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|     6 | Buu's Fury, Legacy of Goku II, Mega Man Zero, Super Mario Advance 2 and 4, WarioWare: Twisted!                                       | Existing managed Windows archives move to shared authoring. The generated operational definitions are byte-equivalent per title.                                               |
|     2 | FireRed [#335](https://github.com/boburning/portcove/issues/335), LeafGreen [#336](https://github.com/boburning/portcove/issues/336) | New separate managed Windows installations use the same staging and versioned mod contract. The existing-copy instructions and retained registration readers remain available. |
|     2 | Ruby and Sapphire                                                                                                                    | Their release packages use variant-prefixed launcher files as well as generic fallbacks. The prepared routes remain useful. This authoring pattern does not cover that layout. |
|     2 | Emerald and Mario Kart: Super Circuit                                                                                                | Netplay profile files need an explicit ownership and backup boundary. The existing routes stay in place.                                                                       |
|     4 | WinBack, Super Metroid, Mega Man X2, Sonic the Hedgehog                                                                              | Existing managed archive patterns already bind different source or data policies. Their accepted behavior and evidence are reused at their original scope.                     |
|     2 | Wetrix and Tomba! 2                                                                                                                  | Existing fresh-acquisition holds still apply. Permitted-copy routes are separate.                                                                                              |
|     2 | Perimeter and Emperor's Testament                                                                                                    | One shared upstream repository with a prepared route. The published release inventory through 3.0.10 contains no Windows binary asset.                                         |

## What the next title supplies

The six existing records separately listed 74 shared path and policy values.
They now record 12 values across the same six records: the game code and
whether the archive uses versioned mod packages. The picker, stable GitHub
selector, staging, versioned-mod coexistence and rollback remain existing Core
behavior. The two new titles supply the repository, channel, variant-specific
archive hint, player basename, game code, mod policy, and exact original/BIOS
requirements and external save location. Their managed definitions need no
production Rust, installer, runtime dispatch, per-title lifecycle wrapper, or
per-release rule. No active-time savings were measured.

Portcove's existing Quiver intake already uses its metadata as discovery hints
and refreshes against the primary repository. RecompLauncher demonstrates
developer-hosted package selection, and Harbourmaster demonstrates sharing
runtime conventions across manifests. Neither supplies the reviewed writer
and preservation contract for these Windows archives. The batch uses primary
upstream metadata and existing Portcove projection and validation. It imports
no ecosystem code, manifests or setup scripts. The selected game source is
PolyForm Noncommercial 1.0.0 and packages have component notices. The route
downloads from upstream and requires the player's original game and BIOS.

## Evidence scope

The [historical package and launcher packet](gba-prepared-player-routes-2026-10-28.md)
covers the five Pokémon identities, including exact original editions, the
shared launcher and compiler lifetime, and the pre-declaration external
operation observations. The two new definitions select the corresponding ZIP
from both actual [v0.0.6](https://github.com/mstan/FireRedLeafGreenRecomp/releases/tag/v0.0.6)
and [v0.0.8](https://github.com/mstan/FireRedLeafGreenRecomp/releases/tag/v0.0.8)
release inventories. The current FireRed and LeafGreen ZIPs matched GitHub's
published SHA-256 and size. Both passed CRC checks and contained one expected
root AMD64 player and bundled versioned mods. The old and new release metadata
exercise the unchanged definitions through the GitHub resolver. The shared
[versioned-mod lifecycle evidence](gba-versioned-mod-preservation-2026-10-25.md)
covers staging, backup, mod conflicts and rollback with fixtures.

Across these tags, the FireRed/LeafGreen source change updates the framework
gitlink. The launcher library remains at the earlier revision. The current
framework retains the same picker state filenames, ROM-adjacent battery saves,
runtime-local compiler cache and game-code diagnostic names. The FireRed and
LeafGreen player sources use the shared default launcher filenames. The
current packages were inspected without execution. The resolver replay does
not establish a native save/load transition or protected delivery. External
ROMs, BIOS and ROM-adjacent save data remain outside managed backup. The
separate publication and frozen-client acceptance remain under
[#534](https://github.com/boburning/portcove/issues/534) and
[#246](https://github.com/boburning/portcove/issues/246).
