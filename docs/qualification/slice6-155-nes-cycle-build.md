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

## Second Core attempt and finite compiler groups

The clean reviewed diagnostic-repair head
`93040a5c6085953b5d3221779e4baf56a5b6cc8b` completed host configure,
host compilation/import inspection and game configuration. During the full
Ninja compile it reached step 76/102, then the unchanged Windows supervisor
reported `event_capacity` at its 4096-debug-event bound. It retained 158 process
identities, with accounting active=0 and all retained handles signaled, but
membership completeness=false. The failed command therefore supplies no Core
quiescence proof. Publication was refused and operation
`f3cc6cd4-aa32-4900-94a3-3ecaf5f8c7e0` and its private inputs/outputs remain held
for review under the existing recovery boundary. They are not reused or removed.
The CLI exited 13 normally (`killed:false`); the outer supervisor settled in
230861 ms. Exact error, diagnostics and bindings remain in
`nes-cycle-core-install-a2` and its separate supervisor/log artifacts.

The next candidate reads the bounded generated `build.ninja`, requires exactly
101 unique safe relative objects under the fixed target and pinned compiler
rule names, and seals that manifest plus its sole `CMakeFiles/rules.ninja`
include. It compiles eight objects per supervised Ninja invocation, with two
jobs each and seal checks between groups. Every group must prove complete
quiescence; the cumulative proof cannot recover from an earlier failed scope.
Full inputs and generated identity are rechecked, and the ordinary final CMake
target links the compiled objects and performs remaining target work. The
4096-event and 512-member limits are unchanged. Actual changed-head execution
is still needed to show that this partition fits them.

Separate review also found malformed CMake `COMPILER_ARG1` serialization in
both retained host/game configurations: quoted configuration-directory paths
became semicolons and broken quotes. Those compiles do not prove the intended
compiler configuration restriction. The repair uses only path-free arguments:
`--config-user-dir= --config-system-dir= --no-default-config --config=x86_64-w64-windows-gnu.cfg`.
At the pinned LLVM revision, empty directories disable those searches; explicit
configuration lookup falls back to the authenticated compiler directory and
loads its bundled MinGW configuration, including its relative common config.
No compiler flags or toolchain bytes are replaced. A focused real C/C++ CMake
experiment checks generated compiler files, rules and driver arguments before
another full Core attempt. Space-containing Ninja object targets decode only
the supported `$ ` escape into literal argument spaces; unsupported escapes,
unescaped multiple targets, unsafe paths and collisions remain refused.

The focused experiment `nes config space a1` passed with space-containing source
and build directories: real C/C++ detection, compilation and linking, exact
generated `ARG1` strings and verbose compiler/driver evidence. All 15683 toolchain
files matched the authenticated archive inventory both before and after.
The compiler's own path did not contain spaces in this experiment; the next
fresh full Core root exercises that additional case. Its inert output was not
executed. Separate non-writing review of the complete repair is clear.

## Third Core attempt and import parser repair

Clean reviewed head `79182d2b2b38c48d216152a0eb090469ebe7eb9c` produced
qualification CLI SHA-256
`6931c7e25849c519a3de7de6aa34b9e101c39cc93e82068213dd0816189e52ea`.
The fresh `E:\pcs6y core3 20261018` attempt completed host bootstrap, game
configuration, all thirteen object groups and final compilation/linking within
unchanged process-supervision limits. Retained generated compiler/rule snapshots
confirm exact path-free arguments with compiler paths containing spaces. Two
earlier read-only snapshot attempts incorrectly expected a C++ compiler file
in the C-only host project; their partial evidence remains retained.

The first game import inspection then refused `WS2_32.dll`: the lexical parser
omitted underscore although that exact Windows DLL was already allowlisted.
This was a parser defect, not an unreviewed dependency. All 24 captured DLL names
belong to the unchanged allowlist. Normal CLI exit was 11 (`killed:false`), and
the outer supervisor settled in 320580 ms. Independent terminal SQL readback
found one failed activity, zero lifecycle journals, zero installs and zero launch
sessions, with the original unchanged and private staging removed by the existing
lifecycle. No output was published and no game ran. Evidence remains under
`nes-cycle-core-install-a3`, including complete import output and terminal readback.

The narrow repair permits underscore during lexical validation, retaining the
same dependency allowlist and case-insensitive duplicate/unsafe-path checks.
Sixteen focused Core tests pass, including the 24 observed imports and malformed,
unknown, duplicate and path controls; separate non-writing repair review is clear.
Changed-head actual Core publication and native offered operations remain required.

## Fourth Core attempt and import-only inspection

Reviewed head `0ef0022767216b8d5f8be703fabb37a167f4de02` produced CLI
SHA-256 `7d7ff550cfbaa63e4daafd348169528f1cd9ce2339f68ba5c1abf31922134a9c`.
The fresh `E:\pcs6y core4 20261018` attempt passed compilation, linking and
game/SDL import checks, then refused the libc++ private-header report because
its 193945 bytes exceeded the existing 64 KiB command-result summary. The
separate 2 MiB diagnostic capture was complete and untruncated. Normal CLI exit
was 11 (`killed:false`), outer supervision settled in 298515 ms, and independent
terminal readback again found zero lifecycle journals, installs and launch
sessions, with the original unchanged. No output was published or game run.

The repair uses the same authenticated toolchain's `llvm-readobj --coff-imports`
and its `Name:` records. At the pinned LLVM revision, this enumerates normal
and delay imports while omitting exports; imported symbols use a distinct
`Symbol:` field. Dependency policy and completeness, process and output limits
are unchanged. The admitted static proof `nes-cycle-import-only-a1` produced
6754/2437 bytes for authenticated libc++/libunwind DLLs, with tool/DLL hashes
unchanged before/after. The libc++ dependency set exactly matches the complete
fourth-attempt report. Sixteen focused tests pass and separate source review is
clear. A fresh Core attempt is still necessary.

Optional local Clippy runs `a5` and `a6` remain failed: an access violation and
then an internal compiler panic (`unexpected unresolved segments`, lowering
unchanged `psx::config_string_end`) under Rust/Clippy 1.99.1. The latter disabled
incremental compilation; this did not repair the tool failure. Neither is a
Clippy pass or a source diagnostic. Ordinary Rust compilation/tests and the
qualification CLI build passed; required exact-head hosted quality remains a
separate pending gate. No PSX source or compiler policy is changed here.

## Remaining acceptance

Core-driven compilation/publication and native offered-operation acceptance
remain to be executed. This document claims no repository title admission,
installed Desktop or production definition delivery, gameplay/save-load/audio/
controller observation, other-platform support or parent #136 completion.
The working table remains the [single slice checkpoint](https://github.com/boburning/portcove/issues/1422#issuecomment-6251727568).
