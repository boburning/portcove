# Doom 3 managed Linux runtime and profiles

Doom 3 and Resurrection of Evil have separate managed Linux x86-64 routes
for each of dhewm3 and DUDE. Keep the original installation and copy the
required classic 1.3.1 PK4s into the managed runtime. The expansion uses
the same base files plus its two d3xp PK4s and its existing expansion
argument. Portcove records those original-data paths for preservation.
The player supplies the originals and checks the edition.

| Engine                          | Verified publisher archive                                                                                   | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| dhewm3                          | [1.5.5 Linux AMD64](https://github.com/dhewm/dhewm3/releases/tag/1.5.5), asset 441716838, 7,534,656 bytes    | `793f8dbfb523f8e065b99357f438d0f23f8524c85382098264c3278ac8219290` |
| DUDE                            | [v0.9.8 Linux x86-64](https://github.com/Inkub0/dude/releases/tag/v0.9.8), asset 714906406, 74,529,292 bytes | `3aac3774f2285c9fc3d0eba8d6fc439a8affd266d491ccd84db2fcbe361f8b5e` |
| DUDE earlier layout observation | [v0.9.7 Linux x86-64](https://github.com/Inkub0/dude/releases/tag/v0.9.7), asset 688547366, 73,992,196 bytes | `f44a0489c60217a1bbb6eb383348159812cd2ef7a344db92b10e06205e8efece` |

The Linux entries use the existing stable release selectors and reviewed
layout staging. Both select the direct AMD64 player and exact packaged
shared modules. dhewm3 also packages its separate dedicated executable.
DUDE keeps the Vulkan loader with its own runtime and imports the OpenSSL
variant of libcurl. dhewm3 imports the GNU C++ and GCC runtime libraries. The v0.9.8 layout has
executable-mode gamepad configuration files that v0.9.7 lacks. The new
DUDE route uses the observed v0.9.8 layout and holds a differing layout.
The release-selection fixture still distinguishes the earlier package and
both engines' optional or foreign-platform assets from ordinary successors.

The Linux launch starts from the executable directory and supplies
`+set fs_basepath .` and `+set fs_gameDllPath .`. These choose the managed
base data and first-choice modules. The exact sources use init-only
variables, and a module load can fall back to the compiled system module
directory. The verified players refer to `/usr/local/lib/dhewm3`. The
managed launch holds competing native modules there or in the effective
external profile and holds a nonempty inherited library search override.
Use a separately prepared copy for a different module or loader layout.
[dhewm3 1.5.5 source](https://github.com/dhewm/dhewm3/tree/455b88e8dff2be822f08eb498f51b383e851fa38).
[DUDE v0.9.8 source](https://github.com/Inkub0/dude/tree/2c382a7fbac4cf216f3180530b4ecad0a81e103a).

The engines use presence-sensitive XDG config and data paths or fall back
to HOME. The guard checks the actual child environment, requires absolute
paths with Linux separators and allows up to 767 encoded bytes for a
profile root. That leaves space for game-relative coordinates in the
engine's 1024-byte path builder and also fits its startup command buffer.
It refuses overlap with managed
storage. Play passes the validated config and save paths explicitly,
including when their directories do not exist yet. This prevents DUDE
from selecting a writable folder beside the original data. It holds a
DUDE first launch that would copy an existing dhewm3
config tree. Complete that setup in an upstream copy and preserve both
profiles. External configuration, saves, screenshots, demos and logs stay
with the player. The separate Windows contracts and Mac setup still apply
to their own routes. Linux ARM64 remains upstream setup.

Archive inspection and controlled tests establish the package and Core
operation boundaries. The upstream executables and original games were not
run. Native gameplay, populated real-save interoperability, arbitrary
native mods and protected publication remain separate.
