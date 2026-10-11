# Finite Windows launcher discrimination harness

Owners: [#141](https://github.com/boburning/portcove/issues/141) and
[#135](https://github.com/boburning/portcove/issues/135). This is harness
engineering for the retained producer's unresolved supervision/resource boundary.
It does not qualify game setup or v0.6.1/v0.6.2 progression.

## Exact input and execution scope

The qualification-only `forbidden-memories-launcher-probe` example uses the
delivered Core `qualification_forbidden_memories_supervise` entry point. Its
owned-child interface receives a fresh scratch path and an authenticated toolchain
root. The legacy Core receipt's `library` field denotes scratch and its `source`
field denotes the toolchain; neither field establishes a game-source or Library
operation. The enclosing receipt names the tiny launcher scope explicitly.

The selected tool bytes come from Core's Windows v1.0.14 archive pin:
209,497,009 bytes, SHA-256
`28da9742385e7ff875b3d9311e8ed89dbdc84f27b6ecba2bc0d0acc11f6d2b4d`.
The example's companion JSON pins twelve independently compared root-bin files:
Ninja, ccache, clang/clang++, clang-22, the target wrapper and six adjacent DLLs.
This authenticates selected files, not every possible loader dependency.

The child verifies these files before tool execution, with exact-size bounded
reads and a shared fifteen-second verification deadline. It refuses reparse
ancestors, nonordinary/non-ASCII coordinates and canonical case-insensitive
scratch/toolchain overlap. Canonical identities are comparison-only; actual tool
arguments retain ordinary spelling to avoid the previously observed verbatim
mixed-slash failure.

Only one first-party C source is compiled to one object. No game code, ROM, CMake
regeneration, download, linker, executable output or full-build replay is used.
Ninja has one worker. ccache receives fresh private configuration/cache/temp/log
paths, a fresh private `USERPROFILE`, a 16 MiB cache maximum and disabled remote storage. Its environment is
explicitly rebuilt from the checked Windows root and selected tool bin; caller
compiler/cache configuration is not inherited.

Core owns the first-party child and inherited tool tree. Existing limits remain:
512 retained handles, complete lifetime accounting, positive handle waits,
two-second closure, 64 KiB captured output and the 180-second Core boundary.
The child's 150-second checkpoint includes its verification and work. A deadline
returns failure and leaves exact-job closure to Core. No scratch or cache is
deleted, on success or failure.

Qualification receipts expose the existing successful Windows accounting fields
as well as the already delivered failure fields. This adds observation only:
membership/positive-wait/accounting predicates and cleanup callback order are
unchanged. Non-Windows qualification output has no fabricated Windows proof.

## Independent admission and interpretation

Before execution, separately review a literal packet binding the exact source
head/tree, compiled executable SHA-256, twelve tool identities, fresh ordinary
scratch, host boot/process identities, uncontended native window and existing
storage/runtime guards. The command or feature flag does not grant admission.
Preserve source-review failures, earlier binaries, recovered reservations,
historical producer staging and any failed native receipt.

The independently admitted command shape is:

```text
forbidden-memories-launcher-probe --supervise <reviewed binary SHA256> <fresh scratch> <authenticated toolchain root>
```

Capture the first-party/Ninja process identities, exact compiler command and
private ccache log, object/input identity, Core proof fields and outer settlement.
If Core refuses lifetime coverage or any other guard, retain its first reason and
available API/wait/accounting facts; do not relabel a compiler result as quiescence.
Even a positive tiny result cannot establish full producer resource fit, all
compiler/image lifetimes, historical cleanup, installed behavior or game setup.

The first separately admitted attempt at `e74e60827b3252f647b8d078781c6299b5972b1a`
failed at ccache's missing-`USERPROFILE` prerequisite; compiler/object success was
not observed. Current owned-tree closure passed with complete three-member
accounting and positive outer exit. Its packet and scratch are preserved; see
[the owning receipt](https://github.com/boburning/portcove/issues/141#issuecomment-6104505321).
The repaired source creates a fresh private profile rather than inheriting the
player's profile. Actual execution of that repair is **Not run** at preparation.
Subsequent observations belong to the canonical owning issues and must name
their literal source/binary/platform/packet rather than inheriting this document
as acceptance. Historical producer cleanup remains unknown.
