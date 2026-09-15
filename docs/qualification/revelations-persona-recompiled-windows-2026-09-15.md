# Revelations: Persona Recompiled Windows qualification — 2026-09-15

This record captures exact Windows x86-64 structural and bounded automated
lifecycle evidence for Revelations: Persona Recompiled v0.1.1. It retains the
initial fail-closed observation and the repaired result without promoting the
port to Supported or manufacturing hands-on evidence.

## Scope

| Identity              | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Portcove commit       | `623fd1e215a81d530ef0bf0d372b33a92445cb35`                         |
| Portcove version      | `0.1.0-alpha.2`                                                    |
| Platform              | `windows-x86-64`                                                   |
| Upstream ref          | `v0.1.1`                                                           |
| Upstream commit       | `38fa6f4cf49a9a03244a64d2a12762074ed23348`                         |
| Release asset         | `revp-0.1.1-windows-x86_64-owned-input.zip`                        |
| Artifact size         | `29,260,787` bytes                                                 |
| Artifact SHA-256      | `f4336030ba9c0e032061ad6892aa5ce9ff01c4cedcbaf3a5355428e6d728158a` |
| Source contract       | `revelations-persona-recompiled-game-source`                       |
| Source variant        | `legacy-accepted`                                                  |
| Source representation | `normalized-track-set`                                             |
| Check contract        | `persona-windows-qualification-v1`                                 |
| Isolated library      | `H:\Portcove-Worktrees\persona-fixed-evidence`                     |

The v0.1.1 tag points directly to the commit above. GitHub's published digest,
the release checksum inventory, and the independently downloaded asset agreed.
The release/tag and Windows binary were unsigned; that limit is recorded rather
than presented as signed-provenance evidence.

## Source identity

The authorized BoburNAS source was copied read-only into the isolated
qualification root. Proprietary source and generated game data remained outside
Git.

| Observation              | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| CHD size                 | `380,748,155` bytes                                                |
| CHD SHA-256              | `01ce1b6942d0e6d61cf830617cb10919ee3e7aa7e7a99fe8d97358511d751582` |
| Normalized Track 01 size | `707,025,312` bytes                                                |
| Normalized SHA-1         | `3e7d8019a3191a29a48bb9d574cf05b1bc998c06`                         |
| Normalized SHA-256       | `05aaa2c1bd264c1a7e739d0746a1d774e063c9ba1eb8394350f929f57a521680` |

The admitted USA `SLUS-00339` track matched the existing exact catalog source
identity. Container and normalized content identities were checked separately.
This record does not widen accepted source variants or representations.

## Update, rollback, and immutable verification

The bounded update path used the official owned-input packages:

- v0.1.0 at commit `eefec09356c39da883fb3b3efaadccd19671ce96`:
  30,422,833 bytes, SHA-256
  `3b387f7e0705fab70677535a1c1f6d314df8f8443e0d638bd904e80a67eaccc3`;
- v0.1.1 at commit `38fa6f4cf49a9a03244a64d2a12762074ed23348`:
  29,260,787 bytes, SHA-256
  `f4336030ba9c0e032061ad6892aa5ce9ff01c4cedcbaf3a5355428e6d728158a`.

Fresh v0.1.0 installation `61a547c0-5ba3-4fbc-95b0-17a640c03714`
produced manifest
`3ba9f2c55f88b5406818b22fa2bed63c4e35f14d6ff42ab4aca9944f6e2d3dd4`.
The managed v0.1.1 update produced installation
`11a2d109-1c38-4300-b3fa-c1bb2b4c5132` and manifest
`e4694fdcb25b580fa9f44beaceadb4240aba9ead5e4469e08d4e8b3b443b904b`.
Repeat update was a no-op. Rollback and retained-version reactivation passed,
including synthetic keyboard preferences in both versions. Verification checked
2,094 immutable files with no failures after the repaired native runs.

## Fail-closed observation and repair

The first v0.1.1 native launch reached the game intro, then post-launch
verification correctly rejected the installation. Upstream had written
`controller.multitap_analog` into the immutable `game.toml` template and created
undeclared `bios.cfg`, `disc.cfg`, and `psx_freeze_heartbeat.json`; the packaged
`keybinds.ini` was also classified incorrectly as immutable player data. The
failed library and reports remain preserved at
`H:\Portcove-Worktrees\persona-evidence`.

PR #504 repaired the generic managed-PS1 boundary. Each launch now regenerates
the runtime configuration from the verified template and the current verified
disc paths. Persona's keyboard, disc, and BIOS preferences are persistent;
the heartbeat is disposable runtime output. Generated edits cannot redirect a
later launch or change source authority. Existing immutable templates,
executables, companions, and symlink/path checks remain verified.

The original `game.toml` stayed at SHA-256
`0f38e17c2381b78258832b8c01dbf8e88847299a460ac3dbfc996eece22ec644`
while the generated copy received the upstream controller write. Older installs
whose template was already modified, or whose keyboard preferences were
recorded as immutable, require a clean reinstall before those bytes can be
edited; current declarations do not rewrite old manifest identity.

## Native launch and persistence

The repaired v0.1.1 launcher reached the animated game intro, closed normally,
and relaunched. The exact native CLI SHA-256 was
`d67c6fd3b1cd96a46623f167be6918f8134692d3e1af2869a77103f6191f1dff`;
the corrected driver SHA-256 was
`0e191184dc823bd65361490ccf2da8e957e05e05538b962f19e3d0e03000f9c9`.
Post-launch immutable verification passed after both runs.

All 14 collected player files survived post-native rollback/reactivation and
managed backup/restore byte-for-byte. Backup
`c84b26c9-594f-4470-818c-ef1b7fe98528` had tree SHA-256
`2117220e0efa53d21642144c79123222c07bb839a4854783fe6bfd125717075d`.
Runtime-created memory cards establish managed-path creation and preservation,
not an in-game save/load cycle.

## Validation and result

The repaired #504 candidate at
`623fd1e215a81d530ef0bf0d372b33a92445cb35` passed the repository audit,
all 23 hosted checks, and a distinct review before merging as
`1ac8e565681f02dde215c19ad7d6382ba785f47a`. A fresh CLI built from that head
also verified all 2,094 Persona immutable files. Shared prerequisite #503 had
separately preserved executable and companion trust and merged as
`9b0cbd990b44a48e665e3a38387756c536fcaca4`.

The `persona-windows-qualification-v1` structural and automated lifecycle
checks pass only for the exact artifact/source/variant/platform identities
above. They cover exact release and source binding, fresh v0.1.0 installation,
v0.1.1 update, repeated no-op, rollback, retained-version reactivation,
fail-closed immutable verification, repaired responsive native launches,
persistent collection, and backup/restore.

The following remain explicitly not run or unclaimed:

- hands-on gameplay, controls, audio, and in-game save/load;
- physical-device behavior;
- Linux and macOS installation or native execution;
- signed upstream provenance;
- removal and clean reinstall under the repaired v0.1.1 configuration-copy
  contract.

Earlier #234 removal/reinstallation and interruption evidence retains only its
recorded binary and implementation scope. It is not relabeled as testing the
later persistent keyboard preferences or generated configuration copy.
