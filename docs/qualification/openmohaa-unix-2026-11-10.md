# OpenMoHAA Linux and Mac packages

Allied Assault [#2592](https://github.com/boburning/portcove/issues/2592),
Spearhead [#2593](https://github.com/boburning/portcove/issues/2593) and
Breakthrough [#2594](https://github.com/boburning/portcove/issues/2594)
share the official portable package. The existing Windows offer and the
non-owning external registrations retain their creating contracts.

| Reviewed [v0.82.1 asset](https://github.com/openmoh/openmohaa/releases/tag/v0.82.1) |  Asset ID | Publisher and observed SHA-256                                     |
| ----------------------------------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| `openmohaa-v0.82.1-linux-amd64.zip`                                                 | 279608993 | `57692d057a684afb7f7e91a61fcd8c062b29ab1b639f27453830084a88cd653c` |
| `openmohaa-v0.82.1-macos-multiarch-arm64-x86_64.zip`                                | 279608982 | `dd590e887078912e0bd80ad3e9d414ef7611faada064e7e49b4c3eafa59e579a` |

Both ZIPs passed CRC inspection and contain ten regular root files. They contain
no original game files. The ZIPs store the launchers and engine without
execute bits. Portcove sets execution permission on the exact selected launcher
and `openmohaa` after checking their native headers and layout. Linux amd64
requires glibc 2.34, libstdc++ with GLIBCXX_3.4.29 and system SDL2. The Mac
executables and SDL2 dependency contain Intel and Apple Silicon slices, with
minimum systems 10.15 and 11 respectively. The Mac engine finds the included
SDL2 through `@executable_path`. Both packages include the game modules,
OpenAL and curl libraries. Static inspection verified the ARM64 CodeDirectory
page hashes across all ten Mac members.

| Title          | Launcher                        | Preserved original-data directories |
| -------------- | ------------------------------- | ----------------------------------- |
| Allied Assault | `launch_openmohaa_base`         | `main`                              |
| Spearhead      | `launch_openmohaa_spearhead`    | `main`, `mainta`                    |
| Breakthrough   | `launch_openmohaa_breakthrough` | `main`, `maintt`                    |

The [tagged launcher](https://github.com/openmoh/openmohaa/blob/a72bc153db1e6ced6e30431b5217e1a53576712c/code/Launcher/launch_main.cpp)
passes target game 0, 1 or 2. The [Unix launcher](https://github.com/openmoh/openmohaa/blob/a72bc153db1e6ced6e30431b5217e1a53576712c/code/Launcher/launch_linux.cpp)
uses `execve` in the same process. On Mac, the launcher resolves the relative
engine from the archive-root working directory. The
`Sys_LaunchAutoupdater` function returns immediately in the exact Linux
executable and both Mac slices. The
[engine profile code](https://github.com/openmoh/openmohaa/blob/a72bc153db1e6ced6e30431b5217e1a53576712c/code/sys/sys_unix.c#L64)
uses Linux HOME/.openmohaa or, with nonempty FLATPAK_ID, the openmohaa
directory under XDG_DATA_HOME or HOME/.local/share. Mac uses
HOME/Library/Application Support/openmohaa. Settings, saves and crash logs can
live in this shared external profile. The managed launch checks the real
child environment and profile location. A separately prepared copy can retain
custom paths and player-owned replacement.

Stable asset selectors accept matching compatible releases with their provider
digest. Release-selection tests replay the observed inventory and a controlled
successor. Core uses synthetic original files for lifecycle checks. Native Mac
launch, original-game identity, gameplay and populated-save compatibility
remain unobserved.
