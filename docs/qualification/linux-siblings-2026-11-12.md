# Linux x86-64 siblings for five managed titles

Dated package evidence for five managed Linux x86-64 routes added on November 12,
2026, under #2926. Each route reuses an established adapter and the title's
existing Windows contract. No new runtime capability is introduced.

## Selection

Release metadata came from the hosted configured-upstream observer (run
43058926577, observed 2026-11-11). It was checked against the whole catalog for
Windows-only integrations whose latest observed release publishes a Linux
package. Five titles fit existing behavior with only their own facts. Others found by
that screen keep their existing scope until their own facts are reviewed. YGOFM
(#141) remains excluded by its Deferred integrity hold.

## Revelations: Persona (#143), `psx-recomp-managed`

| Fact                   | Value                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Asset                  | `revp-0.1.1-linux-x64.zip`                                                                       |
| Size / SHA-256         | 28,066,719 / `b4cb5d74027689465ac4778fd5d71e7f6244f39e2a43b8fe4d7a89dd959b5f70`                  |
| Provider digest        | matched downloaded bytes                                                                         |
| Tag commit             | `v0.1.1` → `38fa6f4cf49a9a03244a64d2a12762074ed23348`; `game.toml` matches the kit               |
| Core layout inspection | passed; root player `Revelations__Persona_Recompiled`, `psxrecomp/psxrecomp_cli.py`, `game.toml` |

After line-ending normalization, all shared members match the accepted Windows
owned-input kit (`f4336030…`) and the ordinary Windows kit. Only
`README-SETUP.txt` differs, by its platform line. Windows-only DLLs, `.exe` files,
vendored `.git` markers, generated rabbitizer headers and `fmt/support/build-docs.py` are absent; setup uses the packaged prebuilt emitters. The Linux
setup host and `psxrecomp-game`/`psxrecomp-bios` emitters are ELF x86-64 binaries.
They need glibc 2.38 and GLIBCXX up to 3.4.32. Core's existing
`cmake-clang-v1-linux-x64` toolchain matches the kit's `toolchain_pack.py`
Linux pack name. The runtime anchors `settings.toml` and saves beside the
generated player, so the existing `build-portcove` persistence declaration
applies unchanged.

The source contract now also applies to this exact Linux kit, with
`revelations-persona-recompiled-v011-linux-static-contract`. Earlier or
later Linux kits remain unbound. The Windows qualification records keep their
Windows scope.

## Blast Corps / Power Dozer (#2557), `native-portable`

| Fact                                    | Value                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| Asset                                   | `power-dozer-v0.84-linux-x86_64.tar.gz`                                         |
| Size / SHA-256                          | 18,788,674 / `56b342f4209544634d7f8debffd3f6bc5d79afcd8e196726436cf46d80f8d5f6` |
| Provider digest and published `.sha256` | matched downloaded bytes                                                        |
| Core layout inspection                  | passed; lone wrapper removed; executables `power-dozer`, `Run Power Dozer.sh`   |

`power-dozer` has `RUNPATH=$ORIGIN/lib`. The bundled sdl2-compat `libSDL2`
and `libSDL3` carry `RPATH=$ORIGIN`, so direct launch resolves the packaged
libraries without the upstream wrapper in the default loader environment. A non-empty inherited `LD_LIBRARY_PATH` is searched first and could shadow them; unlike the profile-specific Linux routes, the generic route does not refuse it. The exact v0.84 source
(`fc04a961…`, provider digest matched) selects
`BLASTCORPS_DATA_DIR` or `<executable>/data`. The existing relative `data`
environment and persistence contract applies on Linux. RT64 diagnostics use
`~/.config/.blastcorps-feasibility`, or `~/.blastcorps-feasibility` when
`~/.config` does not exist, and stay external. The packaged README lists SSSE3/SSE4.1,
glibc 2.38, GLIBCXX 3.4.31, libz, Vulkan, X11/XWayland and a desktop file
chooser.

The shared release-selection corpus enrolls the real v0.84 inventory and a
synthetic v0.85 successor (`downloads.example.invalid`), for both platforms.

## Tails Adventure (#1895), Rewooled (#1882) and Barrett (#1776), `native-portable`

Each route was checked with the same steps. The downloaded Linux package matched
its provider digest and passed Core layout inspection. The exact tagged source
confirmed where the player writes. The Windows persistence contract carries over
unchanged.

| Title           | Linux asset, size, SHA-256                                            | Core layout                                    | Source commit                              |
| --------------- | --------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Tails Adventure | `tails-adventure-v0.3.2-1-linux-amd64.tar.xz`, 4,977,016, `74aa9d7a…` | `tails-adventure`, `assets/` (TAR.XZ, Native8) | `0a937b2a82f5f737d212413ba23d659502862245` |
| Rewooled        | `Rewooled-Linux-x86_64-1.1.3.zip`, 4,660,608, `49a58ef9…`             | `SheepD3D`, `SheepLauncher`                    | `a59781d1f91a0c46186c724efa440bd23316b139` |
| Barrett         | `barrett-linux.zip`, 922,781, `bbfc2752…`                             | lone wrapper removed; `barrett`                | `7d24914fac3c242ef62806db53cb4b0a427a6c2a` |

- Tails Adventure: the release workflow builds without `TA_UNIX_INSTALL`, so
  `config` (options and saves) and `mods` stay beside the executable, as on
  Windows. The player links SDL statically and needs glibc 2.38.
- Rewooled: `--game-dir=game-data` keeps original data beside the player. POSIX
  path lookup is case-insensitive. Saves and options use
  `$XDG_DATA_HOME/Infogrames/Sheep, Dog'n Wolf DX7` (default `~/.local/share`),
  outside Portcove backups, as AppData is on Windows. The player links SDL
  statically and needs glibc 2.38.
- Barrett: `userdata` is created in the working directory, which is the
  executable folder under Portcove. Original-file lookup is case-insensitive,
  but the declared preserved names are uppercase, so the guide asks Linux
  players to keep those names. The Linux ZIP needs distribution SDL2 and
  SDL2_mixer and glibc 2.38.

All three are enrolled in the shared release-selection corpus with their real
observed inventories and labelled synthetic successors at `downloads.example.invalid`.

## Barrett on Apple silicon

`barrett-macOS.zip` (928,007 bytes, provider SHA-256 matched) holds one arm64
Mach-O `barrett` behind a lone wrapper. It has an embedded code signature and
`minos` 15.0, and passed Core layout inspection for `macos-aarch64`. It links
Homebrew SDL2 and SDL2_mixer from `/opt/homebrew/opt`. It uses the same
working-directory `userdata` as Linux, which fits the existing plain-binary Mac
native-portable shape (for example bstone and rerac). Rewooled's Mac app would
place `game-data` inside its app bundle, so it keeps upstream-owned setup until
that bundle boundary is reviewed.

## 3SX (#374), rolling `native-portable`

The `3SX-6187364-linux-x86_64.tar.gz` package (8,624,391 bytes, provider SHA-256
matched) was published on `rolling-pre-release`, tag commit
`618736413eee139800d92d66525af8ada3e31552`. It passed Core layout inspection.
After the lone wrapper is removed, the player is `bin/3sx` and its SDL3 version
links resolve inside `lib/`. The player has `RUNPATH=$ORIGIN/../lib` and needs
glibc 2.38, libz and OpenGL. The exact source keeps its profile at
`SDL_GetPrefPath("CrowdedStreet", "3SX")`, which is external on Linux under XDG
data, just as AppData stays external on Windows. The existing empty persistence
contract applies. The corpus covers a synthetic replacement at the same rolling
tag.

## Held: 3SX-W (#375) Linux

`3SX-c6b8e98-linux.tar.gz` (provider SHA-256 matched) contains
`lib/libSDL3.so -> libSDL3.so.0`, and that target is absent from the archive.
Core extraction refuses the dangling link with "archive links and special files
are not allowed". This is a demonstrated package failure, not missing
knowledge. Reconsider when upstream ships a Linux archive whose links all
resolve inside the package. Windows management is unchanged.

## Not observed

No upstream player, setup host, emitter or helper was executed. No original disc, BIOS
or cartridge dump was used. Linux generation, launch, gameplay, save
compatibility, update and rollback with real data were not observed.
