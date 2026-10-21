# Download and verify Portcove

Choose a Desktop package for the graphical app, or the separate CLI archive for
terminal use, from the [published release](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2).
GitHub Source code archives require a development toolchain.

## Choose the package

| What you want                      | Choose                                                    | Next step                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Graphical Portcove app             | A Desktop package for your operating system and processor | Use the [exact Alpha 2 package choices](../README.md#download-the-technical-alpha), then follow [first play](../README.md#your-first-game). |
| Terminal use or an external client | The separate CLI archive for that same OS/processor       | Read its capabilities and the [CLI task guide](CLI.md#task-guides). Desktop does not require this extra archive.                            |
| Build or change Portcove           | A source checkout or GitHub's Source code archive         | Follow the [development prerequisites](../README.md#prerequisites); a source archive is not an installed app or CLI package.                |

The release page is the asset inventory for the exact tag you choose. Alpha 1
and Alpha 2 keep their frozen unversioned CLI filenames. Future release tooling
generates the chooser and versioned filenames from the checked package inventory;
do not infer that a new naming pattern is present on an old release.

Published Alpha 2 exposes CLI API 34. Newer integration recipes require an
[identified compatible candidate](INTEGRATION-AUTHOR.md#choose-a-cli-and-fixture-library)
until a suitable public release exists. A local package with the same product
version string is not the historical published artifact.

## Verify a download

Download `SHA256SUMS-<platform>.txt` or `SHA256SUMS.txt` from the same release
and compare the complete SHA-256 on the line for the exact filename you chose.
Stop if the entry is missing, duplicated, conflicting, or mismatched. A matching
checksum establishes agreement with that manifest; it does not identify an OS
publisher or prove gameplay support.

The current release workflow is designed to include an SPDX 2.3 JSON software
bill of materials and GitHub artifact attestations for the final tagged files
in future releases. Its aggregate checksum manifest covers the packages and
the SBOM before a draft release is created. Check the actual assets and
attestations for the version you choose: the published Alpha 2 release lists
package and checksum files, but no SBOM. These records do not replace an
operating-system publisher signature or hands-on package qualification.

Windows packages lack Authenticode signing and may show unknown-publisher or
reputation warnings. macOS packages lack Developer ID signing and notarization
and may be blocked by platform policy. Keep operating-system security
protections enabled. Linux and macOS have hosted build/test evidence, but not
equivalent hands-on desktop package qualification. The [Alpha 1
notes](releases/0.1.0-alpha.1-release-notes.md) remain available for
people upgrading from that preview.
