# JGR Patch Pack and OpenGlad managed sibling packages

| Title                | Verified upstream asset                                                                                               | SHA-256                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| JGR Patch Pack #1859 | [0.73.4 Linux AMD64 TAR.XZ](https://github.com/JGRennison/OpenTTD-patches/releases/tag/jgrpp-0.73.4), asset 634550225 | `9df78eaa8157fff3c310345554b34dbd3ecc6d14e3988f91e3c25b5330940511` |
| JGR Patch Pack #1859 | [0.73.5 Linux AMD64 TAR.XZ](https://github.com/JGRennison/OpenTTD-patches/releases/tag/jgrpp-0.73.5), asset 698299976 | `2de4dc6fa93115ddc4c2ff58f6a70e78056e726a182d2f986a06c0f07227097d` |
| OpenGlad #1917       | [v2.1097 Mac ARM64 ZIP](https://github.com/openglad/openglad/releases/tag/v2.1097), asset 695939035                   | `09ada009f20138f1c592a4edb93809aafcc7058290034ce462e2e71b4028ed89` |
| OpenGlad #1917       | [v2.1098 Mac ARM64 ZIP](https://github.com/openglad/openglad/releases/tag/v2.1098), asset 726512796                   | `037fbef7fac1460235b39fb923515b72ef7f784967a2f6b6f62194a7b5353a71` |

Each package matches its publisher digest. The JGR archives have the same
226 paths after stripping their versioned roots. Each has fourteen file
aliases naming regular libraries in the same directory. The Linux player
is `openttd` with glibc 2.28 and RUNPATH `$ORIGIN/lib`. Native archive
extraction materializes each alias as a regular copy. The named selector
separates the generic desktop player from dedicated and distribution builds.

The tagged JGR code checks defined XDG_CONFIG_HOME and XDG_DATA_HOME, then
HOME and account home for absent values. Its fixed Linux `-X` confines
search to the executable directory, the default XDG data directory and
that profile's content_download directory. The launch guard requires the
selected executable's directory as CWD, holds a competing portable
`openttd.cfg` and rejects native social plugins in those scan locations.
It refuses ambiguous profile roots and a custom LD_LIBRARY_PATH.
The default `.config/openttd` and `.local/share/openttd` profiles stay
player-owned. Mac DMG setup and the creating Windows contract are separate.

Both OpenGlad ZIPs pass CRC inspection. The selected `openglad/openglad`
is a thin ARM64 Mach-O built for macOS 26. It loads libyaml, physfs,
libzip and sdl3 from their standard Apple silicon Homebrew locations.
Portcove keeps the archived game assets and launches from the executable's
directory, which the tagged player's Mac asset lookup uses. The managed
Mac route checks the inherited HOME and keeps `.openglad` outside the
library. The upstream OPENGLAD_CONFIG_DIR override and custom
DYLD_LIBRARY_PATH use separately prepared copies. The existing Windows
and Linux routes retain their contracts.

The observed package structures and controlled fixtures support the
stated acquisition and data boundaries. Native execution, populated
saves, game compatibility and protected publication have separate evidence.
