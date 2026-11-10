# Classic player discovery and setup observations

The discovery directory adds eight desktop platform facts across four titles. Four existing guides also receive corrections. These changes concern player-managed setup and discovery package selection. Android and desktop ARM64 variants outside the discovery vocabulary appear in setup guidance where applicable.

## OpenSC2K

[The v0.3.0 release](https://github.com/OpenSC2K/OpenSC2K/releases/tag/v0.3.0) resolves to source `f4f33738315b24b53efc3056790788de625e34b4`. GitHub digests matched Linux x86-64 asset 623480049, Linux ARM64 623480067, universal Mac DMG 623480047 and portable Windows ARM64 ZIP 623480166. Both Linux archives contain the respective native player, PCK, five extension libraries, FluidSynth and a bundled SoundFont. The Windows ARM64 player is PE ARM64 and has the portable `data/` folder. The Mac app contains x86-64 and ARM64 slices. Its plist specifies macOS 11 on Intel and 13 on Apple Silicon. The upstream install guide specifies glibc 2.34 for Linux.

The standard Linux archive has no portable `data/` directory. The engine can select a writable directory beside its exported executable if one exists. Mac uses the Godot profile. Ordinary saves, custom exports and recent autosaves have distinct paths. On Linux the exact Godot build uses `/tmp`, and the enabled-by-default autosave writer prunes old `.sc2` and `.sc2x` files in its fixed `OpenSC2K Autosaves` subdirectory. Reconsider managed Linux after upstream provides a user-scoped or explicitly configurable autosave directory. Keep the existing managed Windows x86-64 portable contract and its disclosed external autosave boundary.

## OpenOMF

[The stable 0.8.6 release](https://github.com/omf2097/openomf/releases/tag/0.8.6) resolves to `e389b0b5f96c9eda5f2894cacd19202952cdc8a3`. The inspected Linux AppImage 467381991, Linux TAR.GZ 467381973 and Mac ARM64 ZIP 467381966 match the publisher digests. The AppImage contains an in-image link from `AppRun` to `usr/bin/openomf`, a player with a glibc 2.34 floor, origin-relative dependencies and `usr/share/games/openomf/resources/openomf.bk`. The separate TAR.GZ needs glibc 2.43 and system libraries. Do not apply its requirements to the AppImage.

The stable Mac ZIP has a loose `usr/bin/openomf` and `usr/share/games/openomf/resources`. Its player is ARM64, requires macOS 14 and loads versioned Homebrew libraries from `/opt/homebrew`. The publisher's separate rolling asset 730412366 instead contains `OpenOMF.app`, requires macOS 15 and uses system libraries and frameworks. The inspected rolling Linux AppImage 730412558 and TAR.GZ 730412424 retain the distinction between bundled AppImage and system-dependent TAR.GZ. The older stable 0.8.5 TAR.GZ and Mac ZIP have different dependency or resource layouts.

The [stable path implementation](https://github.com/omf2097/openomf/blob/e389b0b5f96c9eda5f2894cacd19202952cdc8a3/src/resources/resource_paths.c) checks explicit resource overrides, XDG data, the binary directory and system locations before AppImage resources. State and configuration have separate override and fallback rules. A managed sibling needs a creating package resource identity and a verified external profile boundary. The guide uses the stable publisher release and the actual package layout. Package selection recognizes the separate macos14 and macos15 filename tokens so the tested arm shorthand identifies an Apple Silicon download on that host. Conflicting platform labels still require a choice.

## MDK

The historical and current GitHub URLs resolve to the same repository ID 1406153922. [The v1.2.6 release](https://github.com/nautilusbits/mdk-sdl/releases/tag/v1.2.6) resolves to `1094e273b33c3bae6a06c5b04d0381ebc5f143c3`. The Linux x86-64 TAR.GZ 717237406 and Mac ARM64 ZIP 717237412 match the publisher digests. Both contain the player, adjacent SDL3 library and icon. The inspected x86-64 ELF needs glibc 2.43 and the Mac Mach-O needs macOS 12. Keep the previous ARM64 Linux and Android package boundaries with their existing guide.

Without an explicit `MDK_USER_DIR`, the portable player can copy older personal settings and saves into the writable player folder on first start. The optional texture tool is downloaded separately, can run as a child, and the process-exit callback requests a kill without observing its completion. Leave sibling runtime replacement upstream-owned pending a supported profile and tool lifetime boundary. Preserve the existing Windows contract and distinguish the tool's output from original game data.

## Zombies Ate My Neighbors

[The experimental 20261028 Linux package](https://github.com/moshferatu/zombies-ate-my-neighbors-pc-port/releases/tag/20261028), asset 686193940, matches its publisher digest and source `08e6c74e8e927e59aab7d831f50a4cf2f0443d2b`. The AMD64 launcher, game and SDL2 library share the `zamn/` wrapper. The package floor is glibc 2.38. The launcher uses an available font at a supported system path. The exact USA original, six default local state paths and custom path boundary remain as recorded.

The Linux launcher forks and usually reaps the game. Its active-game quit-event branch can exit without waiting for that child. Portcove's ordinary gameplay supervisor waits for the selected process. A managed sibling needs supported launcher quiescence or explicit descendant custody. The reachable branch also warrants separate Windows lifecycle follow-up, where no native outcome was observed.

## OpenJK, OpenJO and Exult

The [OpenJK rolling release](https://github.com/JACoders/OpenJK/releases/tag/latest) resolved to `260c59c2907187af555a676fe0cc798893bf7757`. The four Mac archives 597802131, 597802160, 597802226 and 597802241 match their GitHub digests. The campaign apps and the Academy multiplayer apps carry a bundled `Contents/Frameworks/libSDL2-2.0.0.dylib`. The maximum observed load-command minimum is macOS 14 on Intel and 15 on Apple Silicon. Keep the complete app and matching title data. Academy and Outcast retain their distinct preparation scope, including the Outcast first-setup hold.

[Exult's stable distribution page](https://exult.info/download.html) supplies the signed stable Android APK separately from snapshots. Preserve the observed 1.12.1 Android 9 floor as evidence while using the stable distribution link in both guides. Black Gate and Serpent Isle retain their own `STATIC` inputs, directories and app-data custody.

The evidence consists of release metadata, package listings, executable headers and tagged source.
