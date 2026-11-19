# GoldenEye 007 N64 PC Port: upstream acquisition under the rights policy

Date: 2026-11-13. Owner issue: [#1129](https://github.com/boburning/portcove/issues/1129).
Policy: [rights basis for upstream-hosted packages](../CATALOG.md#rights-basis-for-upstream-hosted-packages), tier 3.

The fresh-acquisition hold recorded on October 25, 2026 was based only on the
missing grant for inherited decompiled code that the port links. The owner's
November 13 policy accepts that basis for managed acquisition from the official
upstream release, so the held Windows integration is delivered with that limit
recorded rather than as a hold. This record supersedes the hold in the
[October review](ready-archive-rollout-2026-10-25.md). The technical proposal it
reviewed stays preserved at `fc4a1f98f7914aafc8111774d361f544dd3ceb20` on branch
`feature/installation-ready-three-preserved-20261025`.

## Verified on 2026-11-13

- **Published release.** Upstream `jkdansereau/goldeneye-pc-port` (repository
  1351803914). The latest published release is `v0.5.0`. Tag `v0.6.0` exists
  (commit `5b86a9bbeba89508a0c7d6b797361b7454ceda20`) but has no published
  package: its release workflow attaches packages to a draft, and the
  `v0.6.0` Windows asset returns 404. The GitHub provider therefore resolves
  `v0.5.0`.
- **Package identity.** `goldeneye-pc-port-0.5.0-win64.zip`, 17,178,242 bytes.
  The publisher's `.zip.sha256` file and the downloaded bytes both give SHA-256
  `b49bfb826566367a4d1af16466530f0fadd85e522b33859521d849c143a005ef`, the
  artifact the source contract's `v0.5.0` applicability binds.
- **Package contents** (1,060 entries, listed, not extracted or executed):
  `ge007.x86_64.exe`, the bundled `prepare-assets/ge007-convert.exe`, runtime
  libraries, licence texts and `prepare-assets/vendor/assets`. The vendor tree
  holds 1,030 model-header descriptors (113,882 bytes in total), which are
  decompilation metadata such as names and offsets. No ROM, disc image,
  texture, model, audio or music data is bundled; upstream's packaging script
  refuses to bundle `.z64`, `.n64` or `.v64` files, and models and textures are
  generated from the player's own original on first run.
- **Original identity.** Upstream `ge007.u.sha1` at `v0.6.0` still names SHA-1
  `abe01e4aeb033b6c0836819f549c791b26cfde83` for the NTSC-U USA big-endian
  image, unchanged from the reviewed source contract.
- **Licensing.** The port layer is MIT. The upstream NOTICE excludes the
  inherited decompilation source, headers and assets from that grant and names
  no other licence for them. This is the inherited-code case tier 3 accepts; it
  remains a known limitation.

## Not run

No executable, converter or original was run, and no gameplay, save or
installed-client observation was made. The integration, its persistence and
mutable paths and its first-run preparation boundary are the ones reviewed on
October 25, 2026 against the same `v0.5.0` artifact.

## Resume condition

The source contract binds only the `v0.5.0` artifact. When upstream publishes
the `v0.6.0` release, or any later one, its Windows package must be verified and
added to the contract's applicability; this delivery makes no claim about it.

## Settings restart and managed launch custody

The exact [v0.5.0 source](https://github.com/jkdansereau/goldeneye-pc-port/tree/5c43e69b23f76d1ba30d1120dab427d09968a8c8)
offers a restart from the settings menu. It saves configuration and EEPROM
data before calling `sysRelaunchSelf`. On Windows this starts the same
`ge007.x86_64.exe` with the original command line, inherited working folder
and ordinary process flags. It closes its child handles and exits. The
publisher ZIP matches the digest above, and the Windows executable imports
`CreateProcessA` and contains the restart path's diagnostic strings.

The managed Windows route opts into the existing job-based handoff.
New managed installs using this definition hold their session while the
replacement player runs within the install. Definitions delivered to clients
need the existing native capability 28 in addition to staged-source portable.
Existing installs use their creating definition. External registration
remains player-owned. The bundled first-run converter is a separate,
synchronously waited helper.

The Linux archive also matches the provider SHA-256
`011ee5acdd75028fa3af8cbad2aaade1f362aee89f17b43a15d1d1836e98ab92`
at 11,527,864 bytes. Its restart forks and execs the player in a separate
process and lets the original exit. Linux remains upstream setup until the
runtime keeps its PID across restart or a qualified Linux handoff can track it.
No GoldenEye executable, ROM or restart was exercised. The existing Windows
handoff fixture exercises process and session behavior with an inert player.
