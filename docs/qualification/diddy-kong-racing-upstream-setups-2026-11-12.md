# Diddy Kong Racing upstream setup packages

Inspected November 12, 2026. The discovery directory adds Linux x86-64 and
Apple Silicon for Golden Balloon, and Linux x86-64 for DKR-R. DKR-R's ARM64 and
Steam Deck packages are described in its guide. The directory's host platform
enum has no separate Linux ARM64 or Steam Deck entry.

## Golden Balloon

The [v1.8.0 release](https://github.com/akratch/goldenballoon/releases/tag/v1.8.0)
and [tagged guide](https://github.com/akratch/goldenballoon/blob/2b69e748ec04f87a4dc6f032c598726de1b0e813/README.md)
bind the package and original-game facts to source
`2b69e748ec04f87a4dc6f032c598726de1b0e813`. The download bytes matched the
publisher's SHA-256 for each asset.

| Asset ID | Package | SHA-256 |
| --- | --- | --- |
| 638366865 | `Golden-Balloon-1.8.0-linux-x86_64.AppImage` | `7c0fd8912f35d455e9c3c4892e53561a42b608547dac8e7df2c861d9a2df9bb3` |
| 638366889 | `Golden-Balloon-1.8.0-linux-x86_64.tar.gz` | `75a7aea7e0d6b290f1af82c928c569974d503770df06dca3d2ed8704b1910070` |
| 638366830 | `Golden-Balloon-1.8.0-macos-arm64-unsigned.dmg` | `a2218d8071cb4368f4e94879562fb9c3d19fae2559f27a8191deb1357c1b7e31` |

The AppImage has an x86-64 Type 2 ELF header. Its SquashFS and the tarball both
have an `AppRun` wrapper that sets the bundled SDL2 library path and replaces
itself with `usr/bin/mdkr64`. The tarball keeps this layout under
`Golden-Balloon.AppDir`. The tagged guide supplies the Apple Silicon and
unsigned-app facts. The DMG was hashed without mounting or launching it.

The Linux and Mac upstream packages accept US 1.1 and European 1.1 originals.
The existing managed Windows route retains its exact original-file contract.
See the [Linux managed-route assessment](https://github.com/boburning/portcove/issues/321)
for the separate wrapper, ROM handoff and persistent-path questions.
The [tagged profile code](https://github.com/akratch/goldenballoon/blob/2b69e748ec04f87a4dc6f032c598726de1b0e813/platform/user_paths.c)
binds portable saves to the effective executable location. An AppImage uses
the outside AppImage's directory for its portable marker. The loose tarball
uses the inner executable's directory.

## DKR-R

The [Version1.0.15 release](https://github.com/ThatGuyMcd/DKR-R/releases/tag/Version1.0.15)
is source `d2925302d961b46a8492cb3da2169f290ea724b6`. The complete download bytes
matched the publisher's SHA-256 and the ELF Type 2 AppImage headers matched the
advertised architecture.

| Asset ID | Package | SHA-256 |
| --- | --- | --- |
| 724962889 | `DKR-R-1.0.15-Linux-x86_64.AppImage` | `fd089e2d1c2eea0ee489c399100b904aa840b9252750dfa762361c5f907410a0` |
| 724963720 | `DKR-R-1.0.15-SteamDeck-x86_64.AppImage` | `fd089e2d1c2eea0ee489c399100b904aa840b9252750dfa762361c5f907410a0` |
| 724962533 | `DKR-R-1.0.15-Linux-aarch64.AppImage` | `ffcd35426ccc4dab42402f732c697cdd80dcfad39101e82899ae86819a89f910` |

The publisher's [platform notes](https://github.com/ThatGuyMcd/DKR-R/blob/d2925302d961b46a8492cb3da2169f290ea724b6/docs/PLATFORMS.md)
record Vulkan, glibc 2.38 and GLIBCXX_3.4.32 for these packages. There is no
current Mac or Android release in this set. The tagged
[original-file guide](https://github.com/ThatGuyMcd/DKR-R/blob/d2925302d961b46a8492cb3da2169f290ea724b6/docs/ROM_SETUP.md)
specifies US v1.0 and US Rev A/v1.1. Its
[save guide](https://github.com/ThatGuyMcd/DKR-R/blob/d2925302d961b46a8492cb3da2169f290ea724b6/docs/SAVES.md)
records `$XDG_CONFIG_HOME/dkr-port` or `~/.config/dkr-port` by default
and `dkr-runtime-data` beside the application in portable mode.

The Linux packages remain under upstream lifecycle ownership. The existing
Windows registration and retained operation contracts stay in force. Neither
title's Linux or Mac package was launched. No physical Steam Deck result,
populated save, update, or native qualification was observed.
