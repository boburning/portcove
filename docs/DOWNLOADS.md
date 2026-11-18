# Download and verify Portcove

Choose a version from [Portcove releases](https://github.com/boburning/portcove/releases).
Use the release's download chooser when present, or check its Assets list for
your operating system and processor.

## Choose the package

| What you want                          | Choose                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Graphical app on Windows               | The Desktop setup executable for Windows x86-64                        |
| Graphical app on Linux                 | The desktop AppImage for Linux x86-64                                  |
| Graphical app on macOS                 | The Desktop disk image for your processor, or the universal disk image |
| Terminal use or another frontend       | A standalone CLI archive for your operating system and processor       |
| Add or Repair a Portcove game in Steam | Desktop and the standalone CLI from the same release                   |

The macOS `*.app.tar.gz` file and `*.sig` files serve the automatic updater.
GitHub's **Source code** archives require a [source build](../README.md#prerequisites).

### Public prerelease archive

| Channel and version                                                                                               | Published standalone CLI                                    | CLI API |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------- |
| [Nightly Preview 7 (0.1.0-preview.7)](https://github.com/boburning/portcove/releases/tag/nightly-0.1.0-preview.7) | Windows x86-64                                              | 100     |
| [Nightly Preview 6 (0.1.0-preview.6)](https://github.com/boburning/portcove/releases/tag/nightly-0.1.0-preview.6) | Windows x86-64                                              | 100     |
| [Nightly Preview 4 (0.1.0-preview.4)](https://github.com/boburning/portcove/releases/tag/nightly-0.1.0-preview.4) | Windows x86-64                                              | 93      |
| [Nightly Preview 3 (0.1.0-preview.3)](https://github.com/boburning/portcove/releases/tag/nightly-0.1.0-preview.3) | Windows x86-64                                              | 93      |
| [Preview 2 (0.1.0-preview.2)](https://github.com/boburning/portcove/releases/tag/v0.1.0-preview.2)                | Windows x86-64                                              | 93      |
| [Alpha 2 (0.1.0-alpha.2)](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2)                      | Windows x86-64, Linux x86-64, Apple Silicon and Intel macOS | 34      |
| [Alpha 1 (0.1.0-alpha.1)](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.1)                      | Windows x86-64, Linux x86-64, Apple Silicon and Intel macOS | 12      |

All five Preview releases in the table have a Linux Desktop AppImage and a
universal macOS Desktop disk image. Add or Repair in Steam on those platforms
requires a compatible CLI, which those releases never published. For Steam,
choose the CLI for the same Desktop version and processor, even when another
version reports the same CLI API. Alpha releases name their standalone archives
`portcove-<os>-<architecture>.zip` or `portcove-<os>-<architecture>.tar.gz`.

## Verify a download

Use the checksum manifest beside the package you selected. Preview releases
use `SHA256SUMS`. Alpha releases use `SHA256SUMS.txt` or a platform-specific
`SHA256SUMS-<platform>.txt`. Check the full SHA-256 for the exact filename before
using the package. A matching checksum confirms agreement with the release
manifest.

## CLI quick start

Extract the standalone archive and open a terminal in that folder. Run
`./portcove --version` and `./portcove --json capabilities` on Linux or macOS.
In Windows PowerShell, use `.\portcove.exe` in both commands. Frontends can read
`schema_version` and the advertised commands before using the
[CLI task guide](CLI.md#task-guides). When checking an older CLI, add
`--library <path>` before `--json capabilities` and point it at a fresh folder.
This keeps the older CLI from opening a library created by a newer release.

Windows packages lack Authenticode signing and may show unknown-publisher or
reputation warnings. macOS packages lack Developer ID signing and notarization
and may be blocked by platform policy. Keep operating-system security
protections enabled. Linux and macOS have hosted build/test evidence, but not
equivalent hands-on desktop package qualification. The [Alpha 1
notes](releases/0.1.0-alpha.1-release-notes.md) remain available for
people upgrading from that preview.
