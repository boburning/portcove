# Mac app-bundle screen and Chaotix on Apple silicon

Dated evidence from November 12, 2026, under #2926. It records one new managed
macOS route and the shared gaps that hold the other app-bundle candidates.
Release metadata came from the hosted configured-upstream observer (run
43058926577). No upstream player was executed.

## Knuckles' Chaotix Recompiled (#1534) on Apple silicon

`ChaotixRecompiled-0.15.21-macos-arm64.zip` from tag `v0.15.21` (commit
`27e9e48f`) is 5,223,881 bytes. It matched the provider SHA-256 (`60570154…`)
and passed `portcove catalog inspect-package-layout` for `macos-aarch64`.

- Layout: after the lone versioned wrapper is removed, the package holds
  `ChaotixRecompiled.app` and its notices. The player is
  `ChaotixRecompiled.app/Contents/MacOS/ChaotixRecompiled`.
- Player: an arm64 Mach-O executable with an embedded code signature and
  `minos` 11.0. It links only system libraries and frameworks; SDL is linked
  into the player.
- Data: at that tag, `src/platform/sdl_main.cpp` keeps settings, saves, the
  installed ROM and mods in `SDL_GetPrefPath("ChaotixRecompiled",
  "ChaotixRecompiled")` unless `--user-dir` is passed. On a Mac that is
  `~/Library/Application Support/ChaotixRecompiled/ChaotixRecompiled`. This is
  the same external-profile contract as the Windows and Linux routes. Managed
  launches pass no arguments, and the declared current-folder directories keep
  their existing meaning.
- Corpus: enrolled in the shared release-selection corpus with the real
  `v0.15.20` and `v0.15.21` inventories for Windows, Linux and Apple silicon.

## Held app-bundle candidates

| Title                          | Mac package                                  | Hold and resume condition                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gunstars, ninety-four          | universal ZIPs with `SDL2.framework`         | Core extraction refuses the framework's directory links (`Versions/Current`). Launched outside Finder, both players also write `settings.ini`, save states, screenshots and videos in the working folder, which is `Contents/MacOS` for a managed app. Resume with shared directory-link materialization and a Mac launch root beside the bundle. |
| AlienReRecomp                  | ZIP with `SDL3.framework`                    | Same framework directory links; its relative `--save-dir saves` would also resolve inside the bundle.                                                                                                                                                                                                                                             |
| OpenTyrian                     | universal ZIP                                | Framework directory links, and its data paths start from `SDL_GetBasePath()` (`Contents/Resources`).                                                                                                                                                                                                                                              |
| Stunts HD                      | universal Electron ZIP                       | Electron framework directory links. The data contract is already external.                                                                                                                                                                                                                                                                        |
| ReflectionHLE (eight titles)   | universal2 TAR.XZ                            | Native-portable Mac TAR.XZ is not a supported managed format, and the catalog's `-datadir . -cfgdir .` arguments would resolve inside `Contents/MacOS`.                                                                                                                                                                                           |
| F-Zero Recomp                  | arm64 ZIP, extracts cleanly                  | The Mac app always moves to `~/Library/Application Support/FZeroRecomp`, while Windows and Linux keep Portcove-managed data beside the player. A route would mix data ownership within one title.                                                                                                                                                 |
| Raze titles, GZDoom            | Mac ZIPs                                     | The Windows routes use a portable marker; Raze and GZDoom only honour it on Windows, so a Mac route would mix data ownership.                                                                                                                                                                                                                     |
| OpenOMF                        | `macos15_arm` app ZIP on the rolling release | The stable 0.8.6 Mac ZIP is a loose `usr/` tree linking Homebrew libraries. The self-contained `OpenOMF.app` (system libraries only, `minos` 15.0, data under `~/Library/Application Support/OpenOMF`) exists only on the rolling `latest` release. Resume when a stable release ships the app.                                                   |
| Body Harvest, Dune Dynasty     | ZIPs extract cleanly                         | Their external-profile policies cover only Windows and Linux. Each needs its reviewed Mac profile root.                                                                                                                                                                                                                                           |
| Daggerfall Unity               | universal Unity ZIP                          | Mods and game files would live under `Contents/Resources/Data/StreamingAssets` inside the bundle.                                                                                                                                                                                                                                                 |
| BStone (Apple silicon)         | `-Darwin.zip`                                | The package is Intel-only.                                                                                                                                                                                                                                                                                                                        |
| Ship of Harkinian and siblings | ZIPs wrapping DMGs                           | Portcove cannot extract disk images. About 25 catalog titles publish Mac releases only as DMGs.                                                                                                                                                                                                                                                   |
| Alexbeav PSX kits              | Intel and Apple silicon ZIPs                 | The kits resolve SDL3 from the toolchain's `deps/`, then a system copy, then a network fetch. Portcove's `cmake-clang-v1-macos-universal` 1.0.14 toolchain ships no SDL3, so a managed Mac build would use Homebrew SDL3 or fetch at build time. Native observation of that build remains the resume condition recorded for MediEvil.             |

## Not observed

No upstream player was executed and no original data was used. Native launch,
gameplay, saves and update or rollback with real data were not observed.
