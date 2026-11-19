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

### Published previews

| Release                                                                                         | Published standalone CLI                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Preview 2](https://github.com/boburning/portcove/releases/tag/v0.1.0-preview.2)                | Windows x86-64, CLI API 93                                              |
| [Nightly Preview 6](https://github.com/boburning/portcove/releases/tag/nightly-0.1.0-preview.6) | Windows x86-64, CLI API 100                                             |
| [Alpha 2](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2)                    | Windows x86-64, Linux x86-64, Apple Silicon and Intel macOS, CLI API 34 |

Preview 2 and Nightly Preview 6 include a Desktop AppImage and a universal DMG.
They offer a matching CLI for Add or Repair in Steam only on Windows. Use the
Alpha 2 CLI with Alpha 2.

## Verify a download

Open the checksum manifest beside your package. It lists a SHA-256 value for
each file. Preview releases use `SHA256SUMS`. Alpha releases use
`SHA256SUMS.txt` or a platform-specific `SHA256SUMS-<platform>.txt`. Before you
use the package, compare its full SHA-256 to the value for that exact filename.

## CLI quick start

Extract the standalone archive and open a terminal in that folder. Run
`./portcove --version` and `./portcove --json capabilities` on Linux or macOS.
In Windows PowerShell, use `.\portcove.exe` in both commands. Frontends can read
`schema_version` and the advertised commands before using the
[CLI task guide](CLI.md#task-guides).

Windows packages lack Authenticode signing and may show unknown-publisher or
reputation warnings. macOS packages lack Developer ID signing and notarization
and may be blocked by platform policy. Keep operating-system security
protections enabled. Linux and macOS have hosted build/test evidence, but not
equivalent hands-on desktop package qualification. The [Alpha 1
notes](releases/0.1.0-alpha.1-release-notes.md) remain available for
people upgrading from that preview.
