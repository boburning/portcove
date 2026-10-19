# Slice 6B: original-driven Yoshi's Cookie cycle build

Owner: [#136](https://github.com/boburning/portcove/issues/136), consumer
[#155](https://github.com/boburning/portcove/issues/155). Date: 2026-10-18.
This is the fixed prepared-reuse-2 batch (#153, #154, #155), not a new cohort.

## Exact cause and retained prototype

The official v1.1.0 Windows executable, SHA-256
`bf552a27e4ecc31dc23e274857ae927a3ac5dfa5ebbc5ca521f028fc6915688a`,
exited 2 with `Cartridge metadata differs from the compiled program; regenerate native code`.
The pinned engine compares cartridge metadata before PRG identity. No full
original/header/RAM geometry conversion, checksum override or guard suppression
is used. The unchanged full USA NES2 original is 196624 bytes, SHA-1
`b19b67e59dd6bab7977e24e0052de7b48ae214a4`, SHA-256
`ea416fff4a2d207236aa31a7abd2d41f06fe0a53486f485b109ed127be11a45a`.
Its payload CRC is `52B58732`; metadata is part of the admitted identity.

The private build prototype binds game commit
`1f24c8b73d8835beaa35fce2f1e7d9b07324b343`, engine
`0c061070aebe5caa0b4e22cce70892f52d04a0a3`, UI
`c11a4b6c649164b6951eff107f4607dcef117dd5` and toolchain v1.0.14 archive
SHA-256 `28da9742385e7ff875b3d9311e8ed89dbdc84f27b6ecba2bc0d0acc11f6d2b4d`.
All 15683 authenticated distribution files match the measured local toolchain;
that comparison did not install or extract tools. Attempt 1 failed on a Windows
CMake escape; attempt 2 failed on the pinned missing `cyc_trace_mix` declaration.
Both are retained. The reviewed correction adds only `#include "cyc_trace.h"`
next to `cyc_ring.h` in `runner/cyc/hw_fds.c`; exact pre/post hashes are checked.
Attempt 3 built successfully in 34.223 seconds. Its executable SHA-256 is
`a7afd40b5fbaa52c0e25974b337a7ddd0aea005d958f703ff60fe26d312eb7af`.
Generated cartridge `DCEE267B` and PRG `F586F909` match the unchanged original.
No game ran in this prototype. It establishes feasibility, not an admitted
fixed executable hash or a supported arbitrary local-build recipe.

## Core candidate and observed fixture scope

The narrow Core recipe uses authenticated private source/tool trees, separate
host bootstrap with pinned Clang configuration, checked generated identity,
complete runtime dependency/assets/notices packaging, and an immutable build
receipt. It reuses existing acquisition/extraction, supervised ManagedBuilder,
worker joining, installer publication and recovery. Distinct storage identity
and retained recipe comparison prevent downloaded-executable reuse.

The ordinary write contract is `config.ini`, `config.ini.tmp`, `saves/` and root
files matching prefix `cyc_shot_` and suffix `.png`. The screenshot pattern is
not digit-constrained. Root `debug.ini` enables an arbitrary-path local TCP
interface despite developer UI being off; it stays undeclared and is refused
before launch. Fixed arguments and the common child environment policy exclude
the other reviewed diagnostic controls. This is not a runtime sandbox.

Separate non-writing implementation and pinned runtime-write reviews found no
remaining source blocker. The focused Core run passed 13 tests in 0.29 seconds,
including the actual blocked-worker cancellation/join/cleanup boundary,
source/tool identity refusal, generated identity, retained contract, storage and
reuse distinctions, protected file tampering and debug/selector rejection.
These are fixtures, with no compiler child or game execution. Affected Core
Clippy including tests passed after two retained lint findings were repaired.
The new CLI accepts the private 103-port proposal; actual old-v5/new-v6 CLI
capability checks respectively refuse/accept required version 6. This is only
negotiation; strict installed-manifest downgrade reading remains unobserved.

Local evidence is retained under `E:\Codex-Evidence\slice6-20261018`:
`nes-cycle-core-test-a2`/`a3` failures, `nes-cycle-core-test-a4` PASS,
`nes-cycle-core-clippy-a1` failure / `a2` PASS, source/build prototype receipts,
`nes-cycle-proposal-a1`, and the paired v5/v6 capability-check JSON files.

## First actual Core attempt and diagnostic repair

The clean reviewed candidate `8a4afad58ac48ed515bb1eb8fecfdebb105acfc2`
compiled a qualification CLI with SHA-256
`6f5355e23e56823ece3a09d0136e35df2933d374210875050466cd397a84858e`.
Its private proposal SHA-256 is
`e2a069bb1716a2b9aa61d36b647de6515e39866654cffa9e4a2eb08c4585fa48`.
The first actual Core-driven install acquired/extracted the fixed inputs but
failed at host-configure diagnostic capture: `diagnostic capture requires its
running preparation activity`. The CLI exited 14 normally (`killed:false`);
the outer resource supervisor settled in 105754 ms. Failed stdout/stderr,
process facts, proposal/compiled bindings and independent terminal SQL readback
are retained under `nes-cycle-core-install-a1`. That readback found one failed
install activity, zero installs, zero lifecycle journals and zero launch
sessions; the original hash is unchanged. No successful compilation, publication
or native game operation is inferred from this attempt.

The narrow repair retains the preparation-only recorder and adds a private
compiler recorder bound to `install.cartridge.*`, the expected port and that
same running install/update/reconcile activity. It shares the existing atomic
ledger insertion, redaction, retention and quota boundaries. All nine diagnostic
ledger tests pass, including wrong port/kind/phase/operation and finished-row
refusal, preservation of prior captures, redaction and retention regressions.
Separate non-writing review is clear. A changed-head Core retry remains necessary.
The inherited scope text in `nes-cycle-diagnostics-test-a1-result.json` is broader
than that run; its exact log and appended scope correction describe the nine
ledger tests and make no worker-cancellation or compiler-execution claim.

## Remaining acceptance

Core-driven compilation/publication and native offered-operation acceptance
remain to be executed. This document claims no repository title admission,
installed Desktop or production definition delivery, gameplay/save-load/audio/
controller observation, other-platform support or parent #136 completion.
The working table remains the [single slice checkpoint](https://github.com/boburning/portcove/issues/1422#issuecomment-6251727568).
