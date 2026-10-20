# Managed SNES and Genesis Windows routes — 2026-10-20

Owner: [#2177](https://github.com/boburning/portcove/issues/2177). This is the new
managed-install delta for DKC3 and the five SNES/Genesis cohort-B routes. Existing
canonical port work and historical prepared-runtime qualifications keep their
original scope. No Supported promotion or gameplay qualification is made.

## Exact acquisition and ownership

Each definition selects the unchanged official Windows package below. Publisher
asset metadata, size and SHA-256 were checked before the isolated acquisition;
Core verified the downloaded bytes. Licenses and packaged notices remain intact.

| Project                 | Exact official package                                                                                                             |      Bytes | SHA-256                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------: | ------------------------------------------------------------------ |
| DKC3Recomp              | [v0.0.6](https://github.com/elliotttate/DKC3Recomp/releases/download/v0.0.6/DKC3Recomp-v0.0.6-windows-x64.zip)                     |  6,009,000 | `b4965c2cb6d13ce972bc72796e15840d1c1c50e9cb28c748ff213ae145f75e11` |
| SuperMarioWorldRecomp   | [v0.12.0](https://github.com/mstan/SuperMarioWorldRecomp/releases/download/v0.12.0/SuperMarioWorldRecomp-windows-x64-v0.12.0.zip)  |  9,490,376 | `1609aa46af51b9839c30d45ebac0c6bb8341a501fae22be4653486a71eab19fd` |
| ZeldaALttPSNESRecomp    | [v0.6.1](https://github.com/mstan/ZeldaAlttPSNESRecomp/releases/download/v0.6.1/ZeldaALttPSNESRecomp-windows-x64-v0.6.1.zip)       | 11,388,312 | `b53f5ab77d24dfda07caacd413d465795f150dfc0a8ce65cfeb3a05677924632` |
| SonicTheHedgehogRecomp  | [v0.6.0](https://github.com/mstan/SonicTheHedgehogRecomp/releases/download/v0.6.0/SonicTheHedgehogRecomp-v0.6.0-win64.zip)         |  3,776,546 | `78fc4b14de5f232d345ad54bbf2561ece68e4353eb9f3161d4846d829285be40` |
| SonicTheHedgehog2Recomp | [v0.8.3](https://github.com/mstan/SonicTheHedgehog2Recomp/releases/download/v0.8.3/SonicTheHedgehog2Recomp-windows-x64-v0.8.3.zip) |  7,204,657 | `c526ad6fbdbcc83619e0daf8711a7c09699d63541003be4cc4bbdef11877901f` |
| Sonic3KRecomp           | [v0.5.3](https://github.com/mstan/Sonic3AndKnucklesRecomp/releases/download/v0.5.3/Sonic3KRecomp-windows-x64-v0.5.3.zip)           | 16,694,619 | `42ada10579a00d266aa08a833054ea5fea87b64eef67d268b054525fd0f6be99` |

The existing staged-source adapter copies the admitted original to a fixed
runtime name and verifies its exact bytes. SNES originals are `dkc3.sfc`,
`smw.sfc` and `zelda.sfc`; Genesis originals become `game.bin`. The optional
Windows path policy requires a short installation path using basic Latin
characters. Original files may remain at Unicode paths.

Genesis `.md` is an alias for the same raw big-endian bytes. ZIP intake selects
one recognized `.bin` or `.md` member, binding container and member observations
separately. No header removal, byte swapping or interleaving conversion is
introduced. Three actual raw-`.md` intakes passed; Sonic2/3K use actual ZIP inputs.
The initially incorrect container-extension declaration and its refused Sonic2
attempt are retained. The corrected declaration uses the existing reader without
relaxing it. A synthetic six-positive/six-changed-member regression passed.

Default local saves/settings are managed independently of external installations.
Sonic2's standard campaign `.srm`/`.sav`, backups and narrow temporary patterns
are persistent; custom destinations remain player-owned. Exact diagnostic paths
are disposable. In particular, Sonic2/3K name `ramdump_native.bin` and
`last_error.log`; no broad log or development-ring exception is added.
Existing external registrations continue through retained non-owning authority.
They block managed acquisition until explicitly removed; no external folder or
save is adopted. Playnite suppresses new managed setup copy for retained external
records and preserves their external recovery guidance.

## Execution identities and scope

Four routes used source `420b933047d7ff8a46b70ac7a4417c6025b8b56b`, tree
`ec9688eaf9a22488fe645b8166d012ea30ac95b7`, API74 CLI47,468,032bytes,
SHA256 `38f1d17d98741e9dc7f4904d98b4655cd3763b8b790003983e54e6828dcc2fce`.
Sonic2/3K use the corrected source
`fe39995d15def52edb57f12daa794ed660be1967`, tree
`c1b0cfa90c84832c24995ad040f9b66ac2cd33df`, API74 CLI47,468,032bytes,
SHA256 `fcbec2a9b4a06f10cb7d44028ca6f2c1dd2b2df41c90c91952b4fdb45ab195e0`.
The repair changes archive declarations, prominent DKC3 warning, a regression and
Playnite guidance; earlier raw-input observations retain their original identity.

All six passed11 actual prelaunch controls each: incorrect input refused,
Unicode original accepted, unsuitable Unicode/overlong runtime destination
refused, changed original after review refused without activation, fresh bound
review, official acquisition/install, immutable verification and launch readiness.
The exact-source compiled Playnite consumer passed521 checks. A broader catalog
run passed109/110 before the parent's stale qualification-count correction;
all three affected compatibility/route checks passed afterward. All24 historical
qualification records and frozen legacy snapshots remain unchanged. DKC3's former
prepared contract is independently frozen in a historical fixture.

Native process and maintenance results are recorded separately below. These use
private libraries and synthetic persistence probes written through the active
runtime while its real process is running. Probes are not playable saves. No
original, existing installation, player save or host setting is overwritten.

| Route              | Process/startup and ordinary close                                | Managed backup/restore/remove/reinstall |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------- |
| DKC3               | Passed; partial intro rendered; known startup fault reproduced    | Passed                                  |
| Super Mario World  | Passed; title screen rendered                                     | Passed                                  |
| A Link to the Past | Passed; opening animation rendered                                | Passed                                  |
| Sonic 1            | Passed; SEGA opening rendered                                     | Passed                                  |
| Sonic 2            | Passed; initial capture is black and does not prove title arrival | Passed                                  |
| Sonic3K            | Passed; SEGA opening rendered                                     | Passed                                  |

The native driver respects the shared desktop lease. An initial foreign-owner
refusal and a subsequent harness inheritance mistake started no game process;
both failed receipts remain. The repaired owned-token handoff passed the first
four-route process/maintenance batch and the later two-route batch. This is distinct from a game failure.

Observed host: Windows11 Home10.0.26300/build26300, AMD Radeon RX9070XT driver32.0.31041.1004; a SudoMaker virtual display adapter was also present. This is current-host evidence, not minimum-platform qualification.

Sonic2 additionally passed a fresh post-reinstall launch and a separate cached-
source mutation check at sourcefe39995. Only its private active/canonical
`game.bin` copies were corrupted, with the real matching source marker retained.
The next launch recreated the exact admitted ZIP member; both older synthetic
probes, the protected original ZIP, ordinary close and immutable verification
remained correct. This exercises the archive-derived cache path; raw-source
cache recreation is separately covered by the F-Zero record. It is not gameplay
or another route's same-head observation.

## Limitations and maintenance

DKC3 v0.0.6 still reports interpreter cap/unresolved-abandon at guest site
`$808CAD`, frame58. Its summary now presents that known startup failure. A clean
supervisor exit or visible intro does not resolve it. Sonic1 upstream reports
Green Hill complete and later zones partial. Sonic2 packaged feature defaults
remain unchanged. ZeldaALttP documents prebuilt use but has no declared project
license; unchanged first-party acquisition is not a redistribution or notice-
completeness grant.

Managed-compatible-release is the maintenance target. Each later accepted
artifact needs source, persistence and executable compatibility evidence. No
version-to-version update/rollback, game input, audio, controller, in-game save/
load, Portcove GUI first-play, minimum Windows, other OS, installed Portcove packaging or
human-comprehension qualification is claimed here. Platform validation arrays
remain empty. Administrative byte preservation is not gameplay save/load.

Private evidence: `E:/Codex-Evidence/ui-ux-implementation-20261019/` under
`managed-snes-genesis-a1`, `managed-snes-genesis-a2`, cohort-B artifact/review
receipts and the referenced logs. Short disposable libraries are under
`E:/Codex-Evidence/pc2177-six-a1` and `pc2177-six-a2`. Source/game bytes and
private backup contents remain local; they are not attached to repository work.
