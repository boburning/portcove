# Download and verify Portcove

Choose a Desktop package for the graphical app, or the separate CLI archive for
terminal use, from the [published release](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2).
GitHub Source code archives require a development toolchain.

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
