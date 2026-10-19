# Super Metroid and Mega Man X2: pinned managed Windows routes

Fixed slice 6B-Prepared-reuse-4, owners #164/#165 under #136, October 19, 2026.
This candidate reuses the existing `staged-source-portable` checked-copy route.
It adds no engine capability, builder, source conversion or lifecycle authority.
Repository admission, actual operations, installed Desktop/protected production
delivery and optional gameplay remain separate.

## Exact selections

| Fact              | Super Metroid #164                                                 | Mega Man X2 #165                                                   |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Upstream          | `mstan/SuperMetroidRecomp`                                         | `mstan/MegaManX2Recomp`                                            |
| Release / asset   | `v0.3.12` / `651733446`                                            | `v0.1.4` / `654443273`                                             |
| Game commit       | `494df8541eb4dbd4bacf7eba08c53b52d9fba5ac`                         | `c62a096873fd6b98f197bb06b0b6929432de1bc3`                         |
| Framework pin     | `2562bcf48036f4819b503908a8066a2fb8266b6c`                         | `f68aa0fe8edae75cbc7d4b9473c71687b45ce702`                         |
| UI pin            | `cac2b8f4aaa5d1061c6b8f2c3ed7e73c46b0400e`                         | `0546fbcb0126bb14bf88d2128b4fe8a4229570a3`                         |
| ZIP               | `supermetroid-0.3.12-windows-x64.zip`                              | `MegaManX2SNESRecomp-windows-x64-v0.1.4.zip`                       |
| ZIP bytes         | 13,802,349                                                         | 13,043,789                                                         |
| ZIP SHA256        | `2b864f287e971f4ed8fa4205b69927ab43ecce5b1a4e79d08a8bd7530c3d87c9` | `17629394f1e5704c962d4cff0d6bebe15b0a19f34e9aa690536f7a57dfdb3e07` |
| Executable        | `SuperMetroidSNESRecomp.exe`                                       | `MegaManX2SNESRecomp.exe`                                          |
| Executable SHA256 | `826b9d463c0efed168da55f53f3f4bcdb5eaabd0ed93d052e09bf6383194f57a` | `48f4fecb98226ddb4ab190a8afd8b5b58cdd6be6ec2e7ea37cd414c65f2d5a36` |

Complete upstream release inventories contain 17 and six releases respectively.
The selected official assets match their GitHub accepted digests. Bounded ZIP
inventories find 30/19 regular files, 53,517,367/37,467,066 expanded bytes, one
executable each and no unsafe entries. Super Metroid has one package prefix;
Mega Man X2 is flat and includes SDL3/libiconv and its built-in widescreen mod
manifest. Licenses and notices remain intact. The upstream PolyForm
Noncommercial terms and dependency licenses do not grant rights to original game
data. The historical #164 setup-kit qualification concerns another artifact;
these selected precompiled packages need no local compiler or generated-code kit.

## Original identity and working coordinates

The exact headerless originals match each pinned `rom_identity.txt` and one
independent No-Intro record at `libretro/libretro-database`
`12c21cf79f1e20eff6ac68b80875816c717d0a7a`:

| Original                           | Bytes     | SHA1                                       | SHA256                                                             | CRC32      |
| ---------------------------------- | --------- | ------------------------------------------ | ------------------------------------------------------------------ | ---------- |
| Super Metroid (Japan, USA) (En,Ja) | 3,145,728 | `da957f0d63d14cb441d215462904c4fa8519c613` | `12b77c4bc9c1832cee8881244659065ee1d84c70c3d29e6eaf92e6798cc2ca72` | `d63ed5f8` |
| Mega Man X2 (USA)                  | 1,572,864 | `637079014421563283cded6aeaa0604597b2e33c` | `f3246755f608a1e1dc9c848b61da3b824c7853b29b3be40df6fc7f2793a887ed` | `947b0355` |

Bounded extraction creates exclusive regular single-link working copies while
preserving and rehashing the original NAS archives. No normalization, header
rewrite, identity override or optional Cx4 firmware is used. Core original-file
admission uses the independently established SHA1; `runtime_source_hashes` binds
the copied `game.sfc` to its exact SHA256. A reusable source marker does not skip
destination verification. A missing or rejected original cannot acquire authority
from a runtime copy or backup.

The staged adapter's default working and persistence root is the selected
executable's parent. This resolves both the Super Metroid package prefix and
Mega Man X2 flat root correctly. The literal positional `game.sfc` and upstream
`SNESRECOMP_NO_LAUNCHER=1` supply the checked copy without another source resolver.
This ROM copy is persistent, participates in backup/restore and is rechecked at
launch; it is not an immutable-manifest ROM.

## Ownership and maintenance

Both routes preserve `game.sfc`, `config.ini`, `keybinds.ini`, `rom.cfg`, `saves/`
and `screenshots/`. Super Metroid additionally preserves `sm-video.ini` and its
atomic `.tmp`; its built-in presentation provider does not enable the engine mod
loader. Mega Man X2 preserves only `mods/preloaded/state.toml` and `.tmp` within
the immutable built-in mod catalog. No whole `mods/` exemption is granted.
The executable, runtime libraries, package assets, notices and mod manifest stay
immutable. The fixed `.snesrecomp_write_probe`, `last_run_report.json`, and bounded
root `crash_report_*.json` / `crash_minidump_*.dmp` patterns are disposable runtime
outputs. No external directory is claimed.

Primary source traces include host arguments/anchoring, configuration and
keybindings, save roots, screenshots, reports, mod-state publication and the
Super Metroid settings writer. `config.local.ini` remains undeclared; extra
mod installation, donor assets and developer trace/capture/path overrides are
outside this route. Sequential validation does not sandbox the runtime or freeze
external writers.

Both release recipes disable tracing. The exact framework header makes debug
server calls no-ops when tracing is off. Native observations separately check
owned TCP listeners. Although the shared host can relaunch itself, both selected
title initializers leave `in_game_launcher` false, so those entry points are
unreachable for these two fixed titles. No detached-relaunch acceptance follows.

Maintenance declaration: **pinned-release**, Super Metroid `v0.3.12` and Mega Man
X2 `v0.1.4`. Upstream host snapshots require a matching runtime build; preserving
the same save directory across arbitrary builds is not compatibility proof.
Guest SRAM is the upstream upgrade path. Another release needs a reviewed
compatible proposal and consumer operation acceptance before changing this pin.
Current-release checks/no-change, backup/restore and owned removal are distinct
from a version-changing update or successful rollback. This declaration does not
grant publisher, signing or protected distribution authority.

## Actual evidence and remaining acceptance

Evidence root: `E:/Codex-Evidence/slice6-20261018/`, prefix `prepared-reuse-4-`.
Actual qualification retains Core source
`10f3154f1e51e7eae16e0f6eaa19959c2771b90a`, qualification CLI SHA256
`33897a6339b5f3a0b56a8de5b015852511be218a74288d046f91bfe3b073fded`,
and private 106-port catalog SHA256
`9510f257d55e37073a77d3e3f6522390f8c78e7decdd44587e96e5ca9c88d8f2`.
Later presentation/admission changes do not relabel these actual artifacts.

- Isolated Core acquisition, installation and verification pass for both exact
  official executables, checking 29/19 immutable files.
- Each title passes two responsive Core/OS identity-bound startup/ordinary-close
  cycles, positive OS termination, Core/CLI exit zero and zero owned TCP listeners
  at the captured observations. No shutdown kill is substituted for normal close.
- Between cycles, both owned active and canonical ROM copies are deliberately
  altered with the original and valid marker unchanged. Core repairs both copies
  to the exact admitted SHA256. Separate actual acceptance review is CLEAR.
- Pinned current check/update-no-change, exact no-previous refusal, runtime-created
  configuration backup, consented restore, safety-backup preservation and consented
  safety-backup deletion pass. Backups contain the exact ROM copy. Super Metroid
  retains six files/3,166,447 bytes; Mega Man X2 five files/1,576,443 bytes.
- The first negative harness rejects incompatible JSON output before `exec`
  dispatch. Its corrected missing-original attempt refuses with state exit 13 and
  Windows path error 3, recording a terminal childless request; a narrow harness
  message assertion then stops. Both failures, original bytes, idle-state checks
  and independently reviewed reservation/source restoration remain retained.
- Super Metroid's source controls and executable tamper refusal pass. Mega Man
  X2's wrong/missing-original, executable and SDL3 refusals pass. Its immutable
  built-in mod manifest control fails under CLI `10f3154`: the existing
  critical-only gate skips this recorded noncritical member and the game starts.
  Request `6f63d55d-ca77-4024-8c83-b4c189de72fa` reaches the main loop before
  the 30-second refusal harness times out. This is failed negative evidence.
- A separately reviewed bounded packet preserves raw outputs, snapshots
  persistence, uses normal Core interrupted-launch recovery to record Failed
  with unknown exit code, and establishes zero pending work. It then restores
  only the authenticated 782-byte manifest preimage; full verification passes,
  original and retained backup remain unchanged. Only the two exact owned failed
  reservations are archived after readback. No ordinary-close or refusal success
  is inferred from that failed request.
- The candidate repairs managed staged-source launch/maintenance gates through
  complete immutable verification and bounded no-follow inventory, retaining
  older manifest identities and existing mutable/generated output rules.
  The 38 managed-installation fixtures pass, including the nested noncritical
  selector regression. New-CLI operation evidence remains pending.
- **Pending:** repaired-CLI mod-manifest refusal and applicable positive launch
  acceptance, consent-bound owned removal,
  independent final review, exact-head hosted CI, guarded merge and canonical
  issue/Project readback. This candidate is not delivered yet.

Optional gameplay, game save/load, physical controller, audio, visual fidelity,
other platforms, installed Desktop and #246/#534 protected production delivery
remain unqualified. #136 and slice 6 remain in progress; no other frozen consumer
is removed or replaced.
