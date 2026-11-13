# Managed Ruby and Sapphire archives — November 6, 2026

This batch contributes to [#2926](https://github.com/boburning/portcove/issues/2926).
It adds separate Windows x86-64 staged installations for
[Pokémon Ruby #337](https://github.com/boburning/portcove/issues/337) and
[Pokémon Sapphire #338](https://github.com/boburning/portcove/issues/338).
The existing prepared-copy guide and registration contract remain available.
Neither original game nor BIOS is supplied. Use the exact USA rev1 game and
retail BIOS documented in each record.

## Package and selection

Both complete Windows ZIPs from each of the
[v0.0.8](https://github.com/mstan/RubySapphireRecomp/releases/tag/v0.0.8) and
[v0.0.9](https://github.com/mstan/RubySapphireRecomp/releases/tag/v0.0.9)
inventories matched the GitHub-published SHA-256 and passed archive CRC checks.
Each v0.0.9 ZIP has its distinct root AMD64 player and bundled versioned mods.
The selected package includes the upstream compiler companions. The packages
were inspected without running them. Preserve the upstream PolyForm
Noncommercial 1.0.0 and component notices.

The shared Core resolver test consumes the two published inventories with
independently recorded expected asset names. Each unchanged definition
resolves both releases in sequence with its own expected name, digest and
size. The other variant is visible in each inventory. The same test retains
the earlier FireRed and LeafGreen inventories and expected selections. The
fixture tags identify evidence. The runtime rule follows the stable release
channel using discriminating title and archive hints.

## Data and lifetime

The [launcher build declarations](https://github.com/mstan/RubySapphireRecomp/blob/v0.0.9/CMakeLists.txt)
supply variant-specific config, keybind, ROM cache and BIOS cache basenames.
The [launcher seam](https://github.com/mstan/gbarecomp/blob/c1a5fda36fb41c2fcba6c901692006ac69d50555/src/runtime/launcher_seam.h)
writes those paths beside the executable. The
[runtime asset picker](https://github.com/mstan/gbarecomp/blob/c1a5fda36fb41c2fcba6c901692006ac69d50555/src/runtime/runtime.cpp)
can also write generic ROM and BIOS caches. The title records declare both
sets explicitly. The existing GBA shorthand describes the default layout.
The title entrypoint runs the picker and player in the same process. The
[Windows compiler caller](https://github.com/mstan/gbarecomp/blob/c1a5fda36fb41c2fcba6c901692006ac69d50555/src/runtime/overlay_compile.cpp)
waits on its direct compiler child.

The title source comparison between the two tags changes the framework
gitlink. The framework runtime comparison from
`91b3428deeed1df11ae8a17d0b01726093a7b9ed` to
`c1a5fda36fb41c2fcba6c901692006ac69d50555` changes controller and menu input
in `host_window.cpp`. The launcher, asset picker, battery-save writer and
compiler paths are unchanged across those framework revisions.

The existing [staged versioned-mod contract](gba-versioned-mod-preservation-2026-10-25.md)
owns runtime-local settings, selected local saves and versioned mods. Reuse its
shared staging, preservation and rollback fixture coverage. Compiler caches
and diagnostics stay with the creating runtime. Originals, BIOS, default
ROM-adjacent saves and external state destinations need separate backups.
The managed route creates a separate copy. A preserved earlier catalog
fixture exercises the creating contract for existing registrations.
Runtime rollback carries current declared data. Game execution, save/load,
cross-version save state compatibility and protected delivery remain separate.
