# Render96 fixed-source Windows qualification, 2026-10-19

Related to #519, #136 and the fixed slice 6 batch in #1422. This is a
Windows x64 Core-managed source build using the stock resource set. It does not
publish an original, a modified game binary, a signed definition or an installer.
Repository admission, private operation acceptance, production delivery and
optional gameplay evidence remain distinct.

## Exact contract

- Port: `render96ex`; upstream Render96/Render96ex commit
  `48da5c491c8abfb2f5192b59278c1c269411e533`, Git tree
  `d36e3764e1bf29d421e3f77bde6fe58256a00fc9`.
- Source archive: 11,615,689 bytes, SHA-256
  `43091630151c8023b72e7faa2726c3914376fee2cc3becbfefba30423b71b403`;
  3,100 regular source files, no symlinks or submodules.
- Original: raw USA 1.0, 8,388,608 bytes. Selected-ref SHA-1
  `9bef1128717f958171a4afac3ed78ee2bb4e86ce`; independently matched canonical
  SHA-256 `17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91`.
  The existing Ghostship profile identifies the source; this recipe independently
  requires USA and raw z64/n64/v64, with physical storage identity preserved.
  ZIP inputs must be extracted and the raw file registered before building.
- Existing authenticated RPT toolchain v1.0.14 SHA-256
  `28da9742385e7ff875b3d9311e8ed89dbdc84f27b6ecba2bc0d0acc11f6d2b4d`;
  SDL2 2.32.10 mingw SDK SHA-256
  `f15cff5fca62ec9381a016ef1d42a95c638cd72d2f226ba5781c76fe43dbd1ac`.
  Source/toolchain/SDK acquisition, manifests and all reviewed patch preimages
  and results are retained separately. No package or executable is admitted merely
  because a user points at a prepared directory.
- Recipe `render96-us-source-48da5c491c8a`, staged-source template 12,
  version `source-48da5c491c8a`. US/f3dex2e, D3D11/DXGI, SDL2,
  external stock data; legacy resources, text saves, Discord RPC and RMODERN off.
  Fixed `--savepath !`, install-root working directory. Only
  `sm64config.txt` and `sm64_save_file.bin` are persistent writes.
  Resources, DLLs, original and build receipt remain immutable. Forwarded launch
  arguments, inherited SDL_DYNAMIC_API and unrecorded TAS inputs are refused.
- Windows D3D11/DXGI/compiler and other system imports remain OS dependencies;
  this observation does not qualify a minimum Windows environment. Build paths
  currently allow ASCII letters/digits/slash/colon/dot/underscore/hyphen only.

## Producer and actual operations

The actual producer used CLI SHA-256 `c7eec5bf5686bdaf0dab7ea69129281e0db9cbf87b067d11bf75d26b1c5f37f3`,
source base `05da7a9bc98e411d6292151fedb62f4427e47154` plus the exact 14 task-owned source
file hashes in the producer receipt. Those bytes were frozen, rebuilt and
independently reviewed. The source base alone is not the executable identity;
later catalog/evidence edits do not rewrite the retained producer provenance.
The private producer preceded main integration and used pre-integration template
11; it was never published as a production definition. Final repository admission
uses template12 to preserve the independently delivered F-Zero template11.
Focused composition review/tests and final-head CI qualify that additive
negotiation/schema composition without relabeling the original operations.
The unsigned private catalog used SHA-256 `ec885cd4725504eda855cbcd053f626ba8f339dd19bdb0058d5e7e760cec8d2a`.

Core's supervised build completed extraction, bounded texture/sample generation,
309-object compilation, link, DLL-import checks, publication and verification.
The builder did not execute the game. Its immutable receipt SHA-256 is
`9af4bdf9d0fbfc1e32f15b28d4049ed7b30fce4f6093a9985704afdc049593f3`; it records archive/tree/patch/tool
identities and 1920 selected runtime files before the receipt.
The full managed manifest verifies 5021 immutable files,
including the retained authenticated primary source tree. The selected runtime
count is not the full installation count.
The resulting `sm64.us.f3dex2e.exe` SHA-256 is
`6a78891aa16ebbd0060dc086cf3a298b9217340a28ffd64c8b110bbeb47291f3`. No reproducible-build claim is made.

Two actual Core-mediated startup/ordinary Alt+F4 close cycles returned OS,
Core and CLI exit code zero. Computer Use observed the actual window; independent
held process handles established termination. Refusal controls established no
spawn for changed arguments, SDL injection and an unrecorded cont.m64. Core
verification and the external original hash remained intact.

Current pinned check/update completed without a version transition. Rollback
without a previous version refused explicitly. Backup/restore covered the actual
2 persistent file(s): `sm64_save_file.bin`, `sm64config.txt`.
A controlled inactive config comment was restored; the safety backup preserved
the changed bytes and was deleted with exact consent, retaining the original
backup. This is backup behavior, not a populated in-game save/load observation.

Wrong removal-preview identity and missing consent refused. After fresh matching
preview, zero active lifecycle/launch state and actual process absence, Core
removed only the owned active version. 5024 files
(92798255 bytes) were copied into a bounded hash-verified evidence
archive first. User data, original backup and external original remained unchanged;
the final state was not launchable. The retained byte archive is evidence, not
authority to execute or register arbitrary prepared outputs.

## Preserved failures and scope

Private source probes retained the SDL include, missing stdio, CPP/assembly and
generated-resource failures. A linked probe still failed upstream Make's Windows
resource-copy command (Error 206); a collector-only package proved the bounded
replacement layout without relabeling that failed invocation as successful.

Actual Core A2 was cooperatively cancelled before compilation after discovering
an incompatible diagnostic phase namespace; terminal state was cancelled, with
no publication. Actual A3 compiled helpers but refused their complete 69,759-byte
combined output at the unchanged 64 KiB command-result bound. Full diagnostics
were retained. A4 separates helper and sound-generation phases; capture limits,
warnings, cancellation/quiescence, event budgets and product deadlines are intact.
Actual A4 then exhausted the unchanged supervisor event budget in its first
compiler batch. Its 148 retained lifetimes and active-zero report did not establish
complete membership; Core retained the private preparation and recovery-required
lifecycle, with no publication. That root remains untouched. A5 uses recipe-local
two-object compiler batches while sound batches stay at eight. The subsequent
actual A6 pass does not erase any prior result. A5 completed all309 object
compiles, but its link phase regenerated10 skybox C files and began recompiling
them; no linker command ran before the event-budget refusal. Its private root and
recovery-required lifecycle also remain held. A6 marks only the fixed generated
C files as secondary and supervises a pre-link plan that requires exactly one
authenticated linker command, then verifies compiled-object hashes before and
after link. The plan validates complete stdout separately while preserving both
streams and all unchanged output/termination limits. GNU Make documents the
[specific secondary-file rule](https://www.gnu.org/software/make/manual/html_node/Special-Targets.html); earlier intermediate deletion was consistent with the
evidence, not independently proven. A private zero-selected-test run was refused
before a CLI build; the corrected filters passed25 cartridge and9 diagnostic tests.

The first actual A6 build/install/verify passed, but its native run stayed black
and did not close within the held-handle bound after ordinary Alt+F4. Core
recovery recorded Failed with unknown exit code after fresh process absence;
no ordinary-close or native acceptance was inferred. A separately guarded
diagnostic captured three mini dumps. Its harness rejected ProcDump's observed
exit3 after all three dumps had been written; a collector-only read validated
their bounded MDMP directories, captured PID and hashes without rerunning them.
All three main-thread samples were in sequence_channel_process_script through
the DXGI frame callback, rather than the texture cache.

The installed sequence table's entry zero contained an AMD64 COFF object
(54,144 padded bytes), with raw bytecode beginning at object offset60.
The pinned LLVM objcopy COFF path retained the object envelope despite the
upstream -O binary command. A7 uses --dump-section to a separate raw output,
preserves the input object, and validates the exact source-derived 13,452-byte
sequence SHA-256 27c7003e3f78c90ed67fbc8133be5b2949bae09afe323bdfe857b19c58950af4
before sequence assembly. Packaging separately checks the fixed table layout,
entry hash and padding. No runtime audio or texture-cache algorithm was changed.
The repaired focused suite passed26 cartridge and9 diagnostic tests. Actual
A7 producer and operation evidence above supersedes no failed historical result.

Maintenance A4 stopped at its initial read-only SQLite preflight because of
harness quoting, before a Core operation. A5 completed the recorded maintenance
operations but its final harness check incorrectly protected the Core launch
marker, which restore synchronization intentionally consumes. The original
failure remains retained. The A6 collector verifies marker identity/absence,
all remaining protected files, persistent mirrors/backups, Core verification and
fresh quiescence without replaying update, backup, restore or deletion.

The recipe reuses existing acquisition, cartridge-build supervision, source,
manifest, per-port locking, atomic activation, persistence and removal authority.
No second installer or durable adapter authority is introduced. Stock source
does not supply a detected repository top-level license; no binary/source
redistribution grant is inferred. Optional model/texture packs were not acquired
or admitted, and their independent rights/integrity questions remain outside this
stock route. Future versions need a reviewed compatible recipe; N/N+1 progression
and previous-version rollback are not offered for this single pinned version.

Gameplay completion, populated save/load, subjective audio quality, controller, other platforms,
minimum OS, installed Desktop and protected production definition/client delivery
are not established. The #246/#534 custody/signing/publication grants remain
ungranted. Those boundaries do not turn failed offered operations into acceptance.

Ordinary artwork preparation reused the accepted Super Mario64 underlying-game
cover (IGDB1074, image co721v, SHA-256
`f918d6ea5c09e5b5f44c8863b0a465e145956a26ca98646c25f84c8da3a290f5`)
without downloading it again. The absent exact-port match stays a specific cover
exception; the underlying cover does not merge Render96 and Ghostship identities.

## Evidence custody

Private evidence lives under `H:/pc6-qualification-20261019-a3`:
`evidence/render96-source-pickup-a1`, `render96-materialization-a1`,
`render96-build-inputs-a1`, `render96-original-a2`,
`render96-linked-collector-a1`, `render96-capture-validation-a5`,
`render96-core-install-a2`, `render96-core-install-a3`,
`render96-core-install-a4`, `render96-core-install-a5`, `render96-core-install-a6`, `render96-native-a6`,
`render96-diagnostic-a1`, `render96-sound-validation-a6`,
`render96-core-install-a7`, `render96-native-a7`,
`render96-maintenance-a6` and `render96-removal-a6` (all beneath
`evidence/`). Receipts retain exact inputs, source freezes, requests, output,
process identities, refusal evidence and file hashes. Original game bytes and
derived runtime bytes are private and are not committed to the repository.
