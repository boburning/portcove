# Download and verify Portcove

Choose a Desktop package for the graphical app, or the separate CLI archive for
terminal use, from the [latest release](https://github.com/boburning/portcove/releases/latest).
Preview builds are listed on the [releases page](https://github.com/boburning/portcove/releases).
GitHub Source code archives require a development toolchain.

## Choose the package

| What you want                      | Choose                                               | Next step                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Graphical Portcove app             | The Desktop package for your operating system        | See the [package choices and first launch](../README.md#download-the-beta), then follow [first play](../README.md#your-first-game). |
| Terminal use or an external client | The separate CLI archive (published for Windows x64) | Read its capabilities and the [CLI task guide](CLI.md#task-guides). Desktop does not require this extra archive.                    |
| Build or change Portcove           | A source checkout or GitHub's Source code archive    | Follow the [development prerequisites](../README.md#prerequisites); a source archive is not an installed app or CLI package.        |

Releases from 0.1.0 onward name every file with its version, for example
`Portcove_0.1.0_x64-setup.exe`. The release page is the inventory for the exact
version you choose. Alpha 1 and Alpha 2 keep their original filenames and
their own [release notes](releases/0.1.0-alpha.1-release-notes.md).

## Verify a download

Download `SHA256SUMS` from the same release. Compute the SHA-256 of the file you
downloaded and compare it with the line for that exact filename:

- **Windows (PowerShell):** `Get-FileHash .\Portcove_<version>_x64-setup.exe -Algorithm SHA256`
- **Linux:** `sha256sum -c --ignore-missing SHA256SUMS`
- **macOS:** `shasum -a 256 -c --ignore-missing SHA256SUMS`

Stop if the entry is missing, duplicated or different. A matching checksum shows
that the file is the one the release published. It does not identify an
operating-system publisher or prove that a game works.

Application updates are checked more strictly: each update package carries a
signature (`.sig`) made with Portcove's updater key, and the installed app
refuses an update whose signature does not verify.

## Unsigned packages

Portcove's packages are not signed with a paid operating-system certificate.
Windows shows a SmartScreen warning, and macOS builds are ad-hoc signed and not
notarized, so Gatekeeper blocks the first launch. The README's
[first launch steps](../README.md#first-launch-on-each-system) explain what to
do on each system. Keep your operating system's other security protections
enabled.

Windows x64 and Linux x64 are the beta platforms. macOS builds are experimental:
they are built and checked on GitHub's hosted Macs but have not yet been tested
on a real Mac.
