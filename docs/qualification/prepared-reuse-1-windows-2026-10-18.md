# Prepared-runtime reuse: SMW, ALttP and Sonic — October 18, 2026

Fixed slice 6 batch **6B-Prepared-reuse-1** contains only canonical owners
[#147](https://github.com/boburning/portcove/issues/147),
[#151](https://github.com/boburning/portcove/issues/151) and
[#152](https://github.com/boburning/portcove/issues/152). These are distinct mstan
implementations. ALttP is not Zelda3, and Sonic retains its Genesis identity.
This reuses the existing Windows x86-64 `staged-source-portable` registration
route; it introduces no Core adapter or ownership capability.

| Owner                              | Selected game revision                     | Official Windows ZIP SHA-256                                       | Immutable tree SHA-256                                             |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| #147 SuperMarioWorldRecomp v0.12.0 | `5fc466cd11a3cb1a4bdc529ebf29e35915ef0252` | `1609aa46af51b9839c30d45ebac0c6bb8341a501fae22be4653486a71eab19fd` | `14ef59aaf6afb54be86eefea3ab98bf842685064df6ed487356aeaf927f0f28e` |
| #151 ZeldaALttPSNESRecomp v0.6.1   | `70b9c1a374d7d92a1d037516354036bf1bfebd5d` | `b53f5ab77d24dfda07caacd413d465795f150dfc0a8ce65cfeb3a05677924632` | `0bf47793d4f53fe258e94be76e8b28e4ca3c8c19ef6d702dddc54dfb58e3335e` |
| #152 SonicTheHedgehogRecomp v0.6.0 | `557e10fbb56fe505f9a2dd44a15c03145b35c157` | `78fc4b14de5f232d345ad54bbf2561ece68e4353eb9f3161d4846d829285be40` | `7dff505742639ce34c28c40066fe0493b54eaf33ee463b2bf7708ddfc9b37e68` |

## Original-input and executable binding

- #147 requires the stock headerless 524,288-byte USA SMW, SHA-256
  `0838e531fe22c077528febe14cb3ff7c492f1f5fa8de354192bdff7137c27f5b`.
  The player places it as immutable `smw.sfc` beside
  `SuperMarioWorldSNESRecomp.exe`; the fixed argument is `smw.sfc`.
  [Tagged main](https://github.com/mstan/SuperMarioWorldRecomp/blob/5fc466cd11a3cb1a4bdc529ebf29e35915ef0252/src/main.c)
  absolutizes the positional path and returns from same-path relocation before
  opening an output file. Its
  [MSU tool](https://github.com/mstan/SuperMarioWorldRecomp/blob/5fc466cd11a3cb1a4bdc529ebf29e35915ef0252/tools/apply_msu_patch.py)
  records the stock SHA-256. EXE SHA-256 is
  `76535f169a4e44ad0139c9ab6344265d6921bac1c6d378458b37e90c1409071f`.
- #151 requires the stock headerless 1,048,576-byte USA ALttP, SHA-256
  `66871d66be19ad2c34c927d6b14cd8eb6fc3181965b6e517cb361f7316009cfb`.
  The immutable filename is `zelda.sfc`, with that fixed positional argument to
  `ZeldaALttPSNESRecomp.exe`. The
  [tagged tool](https://github.com/mstan/ZeldaAlttPSNESRecomp/blob/70b9c1a374d7d92a1d037516354036bf1bfebd5d/tools/apply_msu_patch.py)
  and main record the stock identity; the same-path branch precedes output open.
  EXE SHA-256 is `ec69cc8b051b563254198a66b33ab81eba14b90bf58e39354d9751ec8b3c4832`.
- #152 accepts raw big-endian 524,288-byte Sonic JUE REV00. Its pinned
  [engine compatibility module](https://github.com/mstan/segagenesisrecomp/blob/5c165f6195a88b17d8da4ae619aec2b8f640d84f/sonicthehedgehog/game.toml)
  specifies CRC `f9394e97`; the unique matching
  [No-Intro record](https://github.com/libretro/libretro-database/blob/12c21cf79f1e20eff6ac68b80875816c717d0a7a/metadat/no-intro/Sega%20-%20Mega%20Drive%20-%20Genesis.dat)
  supplies enforced SHA-1 `6ddb7de1e17e7f6cdb88927bd906352030daa194`.
  Ordinary-file inspection observes SHA-1/SHA-256, so an unobserved CRC is not
  added as an ANDed admission requirement. Core passes the verified original
  absolute `.bin` path directly to `SonicTheHedgehogRecomp.exe`; it does not copy
  or relocate the source. EXE SHA-256 is
  `f3b141685e89549275b9a7e0644372477840d3ff1c6bd58245e59616b5ab5bd3`.

All three authorized NAS originals matched these identities. Private disposable
copies were used for preparation; original ZIP hashes were read back unchanged.
No proprietary source or generated game content is committed or redistributed.

## Ownership, notices and runtime defaults

The player acquires and extracts the exact official package outside the library.
Registration reviews its immutable tree and source. Package/executable/DLL/assets,
SNES source files and `mods/packages` remain immutable; unknown files cause a
preserved verification refusal. Only the individually reviewed settings, save,
mod-state and diagnostic paths in each prepared declaration are mutable.
Removing registration preserves external files. Updates are user-managed;
Portcove offers no acquisition, update, rollback, backup or external deletion.

#147's root PolyForm Noncommercial terms and #152's included `LICENSE`,
`THIRD-PARTY-LICENSES.md` and `README.txt` remain intact. #152 explicitly limits
what its license can grant for translated original-game code. #151's verified
README directs players to download/extract/run the prebuilt with their own ROM,
while separately declaring its project license **not yet declared**. Its absent
standalone license and incomplete dependency notices remain Unknown; personal
prepared-runtime use is not a Portcove redistribution grant. No package is
repacked or repaired to imply comprehensive rights clearance.

Native programs inherit the caller's environment and are not sandboxed. For the
ordinary-default qualification, the child environment clears
`SNESRECOMP_WRAM_TRACE_FILE`, `SNESRECOMP_APURAM_TRACE_FILE`,
`SNESRECOMP_DSPREG_TRACE_FILE`, `SNESRECOMP_DSPOUT`, `SNESRECOMP_STALL_LOG`,
`SNESRECOMP_LUA_PORT` and `SNESRECOMP_LUA_PAUSED`. Core does not clear these for
players. Both SNES frameworks contain opt-in output paths; #147 additionally
contains an opt-in loopback Lua listener and caller-selected stall-log path.
`SNESRECOMP_LUA_PORT=0` is a startup error, not a disable setting. #151 predates
that Lua integration. Selected release symbol/source review found the normal
debug-server calls compiled as no-op stubs; native listener observations retain
their narrower actual scope. Sonic's absent `debug.ini` remains immutable: adding
it must refuse verification rather than silently enabling its developer listener.

## Evidence and remaining operation acceptance

Separate non-writing review approved all three canonical port/profile identities,
source representations, tree boundaries and underlying-game artwork. It found an
incorrect Sonic source URL; the corrected evidence consistently names the pinned
engine repository and compatibility module. The final private proposal byte
SHA-256 is `6cde62aec94ecb31dce0d9bb13cf1d18ea7628b4d4ff0dac0ca6b7bccde0664d`.

Actual existing-Core CLI controls passed separately for every tuple: mutated
source refusal, exact source admission, unknown package file refusal, review-bound
registration, readiness and revalidation. Both preliminary and corrected-catalog
21-control runs are retained. These are not game execution evidence. They use the
retained qualification CLI from `e94ce4e7e1b3a3245961bdf2d713df6d8cfcfafa`, SHA-256
`477e94dbbb596d9326e1384c521b95e0d0ce7a9f138849581b10ad27a783f850`, with private
catalog/preferences/library paths. No production trust store is changed.

The first #147 packet failed in its harness before a Core session existed:
`launch.show` legitimately returned `data: null`. The repaired packet waits
within the same finite phase budget. Failed evidence and exact reservation
disposition remain retained; the failed packet is not a runtime pass.

#147 then passed two responsive startups and ordinary closes, positive captured
process termination, post-run immutable verification and registration-only
removal preserving all 34 external files and its source. Both Core game exit
codes and CLI exit codes were zero. Point-in-time observations found no TCP
listener owned by the observed game PID under the recorded environment. These
are process/operation observations, without visual or gameplay inspection.

First native #151/#152 attempts started and closed normally but **failed**
post-run immutable verification. Independent exact-source review found two
previously omitted ordinary outputs:

- #151's
  [ordinary atexit writer](https://github.com/mstan/snesrecomp/blob/ad7860b7c684c44fdc31c7ee5be35272716d87f4/runner/src/desktop/post_mortem.c#L661)
  emits the literal `tier2_coverage.json` when the selected build's tier-2
  post-mortem feature is enabled.
- #152's
  [native initialization](https://github.com/mstan/segagenesisrecomp/blob/5c165f6195a88b17d8da4ae619aec2b8f640d84f/runner/main.c#L1800)
  opens the executable-relative literal `yield_log_native.log`, and its native
  glue appends diagnostic rows during ordinary execution.

Only those exact paths were added to their respective mutable declarations.
All 19/11 original immutable files remained unchanged; Sonic's external original
input also retained its exact hash. Excluding the newly generated diagnostic
restored each original immutable tree hash without changing package/source bytes.
No glob, other-port exemption, notice change or ownership grant was added. Fresh
registration and acceptance use the repaired catalog byte SHA-256
`dca4d540573c686a5cb6dc3ae7562920adc96a74e16d6cbd00dadcce053e7adb`.
Failed verification and its positive first-close evidence remain separate.

#151/#152 then passed their repaired packets, each with two responsive startups,
ordinary close, positive captured-process termination, restart and post-run
immutable verification. Registration-only removal preserved all **28** and
**14** external files respectively, including the owned preservation sentinels;
source copies remained unchanged. No sentinel is evidence of an in-game save.
Core and CLI exit codes were zero; point-in-time checks found no TCP listener
owned by each observed game PID. Subsequent Core status and read-only database
queries confirmed zero corresponding registrations in each tested library.
The readback harness first expected a JSON null where the established serializer
omits the absent optional field; that assertion failure remains retained and was
corrected without executing a game again. Completed native packets released
their owned leases after the positive exit receipts.

Final catalog text records these observations and clarifies that Sonic's exact
raw `.md` input can be copied byte-for-byte to `.bin`. It changes no execution,
source, ownership or artifact field after the repaired native observations.
The #147 tuple reuses its exact prior evidence; its fields were unaffected by the
two other title-specific diagnostic declarations. Save/load, gameplay, visual
correctness, audio, controllers and other platforms remain Unknown.
Sonic upstream reports Green Hill complete and later zones partial; this is not
a complete-game support claim. Repository admission and actual unchanged-client
definition delivery remain separate from these observations and from protected
publication authority. This three-consumer batch does not complete #136 or #1422.

Retained receipts: `E:/Codex-Evidence/slice6-20261018/prepared-reuse-1-*`.
