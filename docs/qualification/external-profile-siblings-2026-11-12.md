# External-profile platform siblings

Dated package evidence for five managed routes added on November 12, 2026,
under #2926. Each title's Windows contract keeps player data in an external
upstream profile, and the same holds on each new platform. No new runtime
capability is introduced.

Release metadata came from the hosted configured-upstream observer (run
43058926577). Every package below matched its provider SHA-256 and passed
`portcove catalog inspect-package-layout` through Core extraction.

| Title                               | Route                                           | Package, bytes, SHA-256 prefix                                     | Player                     |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| LEGO Island / isle-portable (#1831) | Linux x86-64, rolling `continuous` (`a3dfa219`) | `isle-0.1-Linux-x64.tar.gz`, 4,420,732, `9cba0cba…`                | `bin/isle`                 |
| Infinite Mario 64 Ever (#1830)      | Linux x86-64, `v0.1.5` (`5d220d03`)             | `infinite-mario-64-ever.v0.1.5.linux.zip`, 42,393,997, `bdec381b…` | `infinite-mario-64.x86_64` |
| Wing Commander / WC1-RE (#2909)     | Linux x86-64, `v0.9.8` (commit `b7b0edf5`)      | `wc1-re-v0.9.8-linux-x86_64-sdl2.zip`, 42,926,444, `d072251a…`     | `wc1-modern`               |
| Wing Commander / WC1-RE (#2909)     | Apple silicon Mac                               | `wc1-re-v0.9.8-macos-arm64-sdl2.zip`, 37,517,796, `00b4a2d3…`      | `wc1-modern`               |

## Facts per title

- **isle-portable.**
  - Libraries: `bin/isle` has `RUNPATH=$ORIGIN/../lib`. It finds the bundled `liblego1.so` and SDL3; the SDL3 version links resolve inside `lib/`. Those bundled libraries import `GLIBC_2.43` symbols, so the route needs glibc 2.43, the system libstdc++ with `GLIBCXX_3.4.32` (GCC 13), and GLVND OpenGL/GLES 2.
  - Optional setup helper: `bin/isle-config` needs Qt 6 from the distribution.
  - Data: configuration and saves stay in `SDL_GetPrefPath("isledecomp", "isle")`, which is `~/.local/share/isledecomp/isle` on Linux. The declared `isle.ini` fallback beside the player keeps its meaning.
- **Infinite Mario 64 Ever.**
  - Package: a Godot export with its PCK and companion `.so` files beside the player. The Godot player alone needs glibc 2.28, but the required `libsm64gd` GDExtension imports `GLIBC_2.38` and `GLIBCXX_3.4.32`, so the route needs glibc 2.38 and GCC 13's libstdc++.
  - Data: saves stay in Godot user storage (`~/.local/share/godot/app_userdata/Infinite Mario 64`). The declared `project.godot` beside the player keeps its meaning.
  - The Mac release ZIP only wraps a second ZIP holding `Infinite Mario 64.app`, and Godot would save `project.godot` under `Contents/Resources` inside the signed bundle, so it stays upstream-owned.
- **WC1-RE.**
  - Linux: `wc1-modern` has `DT_RPATH=$ORIGIN` and bundles SDL2, LZO, `libstdc++` and `libgcc_s`. It needs glibc 2.39. DT_RPATH is searched before `LD_LIBRARY_PATH`.
  - Apple silicon Mac: the player is a plain Mach-O executable with a code signature and `minos` 15.0. It loads its bundled SDL2 and LZO through `@executable_path`.
  - Held: the Intel Mac ZIP bundles sdl2-compat, which loads SDL3 at runtime, but ships no SDL3. Upstream's v0.9.8 Intel build installs Homebrew `sdl2` (now sdl2-compat) and packages only the `libSDL2` and `liblzo2` dylibs. Reconsider when the Intel package includes its SDL3 runtime or real SDL2.
  - Data: original data and saves stay in the chosen game folder. Settings use the SDL preference folder for Origin Systems / WC Kilrathi Saga on every platform, which is external.

All three titles are enrolled in the shared release-selection corpus. Each uses its real inventory plus a labelled synthetic successor at `downloads.example.invalid`; isle-portable uses a rolling replacement at the same tag. For isle-portable and Infinite Mario 64 Ever, a non-empty inherited `LD_LIBRARY_PATH` is searched before RUNPATH and could shadow bundled Linux libraries.

## Zombies Ate My Neighbors / moshferatu (#1914)

`zamn-linux-x86_64.tar.gz` from release `20261028` (commit `410454ab`) is 2,366,478 bytes. It matched the provider SHA-256 and passed Core layout inspection.

- Layout: after the lone `zamn/` wrapper is removed, the package holds `zamn_launcher`, `zamn` and a bundled `libSDL2-2.0.so.0`.
- Libraries: both programs have `RUNPATH=$ORIGIN` and need glibc 2.38.
- Process lifetime: at that tag, `src/launcher.c` forks the game, changes to the launcher's base folder, runs `zamn --config <ini>`, and keeps tracking the child, as the Windows launcher does with `CreateProcess`.
- Data: `src/config.h` keeps `zamn.ini` in the working folder, otherwise beside the executable. The default `zamn.quicksave` and `zamn.hiscore` live in the working folder; only a configured high-score path resolves from the folder holding `zamn.ini`.
- Persistence: the Windows persistence contract for `zamn.ini`, `zamn.quicksave`, `zamn.hiscore` and their `.tmp` companions therefore applies unchanged.
- Catalog: the listing's upstream-owned Linux entry moves to the managed integration.
- Labels and setup: upstream labels the Linux build experimental. On Linux the launcher has no file dialog, so the ROM path is typed or dropped onto the launcher.
- Corpus: enrolled with a synthetic `20261201` successor.

## MDK / mdk-sdl (#1775) on Apple silicon

`mdk-osx-arm64.zip` v1.2.6 is 4,293,984 bytes. It matched the provider SHA-256 and passed Core layout inspection for `macos-aarch64`.

- Package: an arm64 NativeAOT `mdk_sdl` with an embedded code signature and `minos` 12.0, beside its `libSDL3.dylib`, which uses `@rpath`.
- Data location: the exact source (`UserFolders.Choose`) keeps settings, saves and mods beside the executable when that folder is writable. This is the same rule as the Windows and Linux routes, so their persistence contract applies unchanged. The unwritable-folder fallback is .NET's local application data folder, `~/Library/Application Support/mdk-sdl` on macOS.
- Finding the original game: `MdkData.Find()` probes only Windows default install locations, and managed launches do not pass `MDK_DATA_DIR`. The managed Mac route therefore names the original installation in `mdk_paths.cfg`.
- Catalog: the listing's upstream-owned Mac entry moves into the managed integration.

## Not observed

No upstream player or helper was executed, and no original data was used. Native launch, gameplay, saves, and update or rollback with real data were not observed.
