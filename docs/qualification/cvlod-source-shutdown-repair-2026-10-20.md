# Legacy of Darkness private source shutdown repair — October 20, 2026

Owning issue: [#320](https://github.com/boburning/portcove/issues/320).
This continues the [shipping-artifact shutdown and maintenance record](cvlod-shutdown-and-maintenance-2026-10-19.md).
The shipping v0.2.26/v0.2.27 failures remain failures. This record establishes a
controlled private source repair and restart, not delivery of a repaired catalog
runtime. Issue #320 remains open with its required integration obligation.

## Source treatment

The [reviewed source patch](patches/slice6-cvlod-ui-context-lifetime.patch) targets
`src/ui/core/ui_context.cpp` at upstream commit
`cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d` of
[fliperama86/cvlod_recomp](https://github.com/fliperama86/cvlod_recomp/tree/cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d).
Pinned RmlUi is `2cd28864ae25ed345b70598751703a5433b12356`.

Previously, `create_context_impl` constructed a function-static dummy document
even for a real document. Its static destructor ran after RmlUi shutdown.
The patch lazily creates a context-owned dummy only for a null document, under
the existing lock. Context cleanup releases all contexts before the dummy and
shared stylesheet, while RmlUi remains alive. Renderer shutdown order and game
features stay unchanged.

An actual-source regression compiled `ui_context.cpp`, `ui_element.cpp` and
`ui_style.cpp` against the pinned RmlUi library. It exercised real and null
document paths, element/style destruction, pending updates, text cleanup and two
initialization/shutdown cycles. Both variants returned from the test body; the
unpatched process then failed with `0xC0000005`, while the patched process exited 0. That fontless regression alone did not establish full-game behavior.

Patch application was separately checked against the exact source preimage.
The private qualified replacement used CRLF; applying the retained patch to the
upstream LF file produces identical source text with LF. These are distinct byte
identities, not interchangeable executable receipts:

| Item                                | SHA256                                                             |
| ----------------------------------- | ------------------------------------------------------------------ |
| Exact upstream source preimage      | `eba0e901b6ba8160a0bc656b9c188fb8cfa68f442a8beadde353ca16debc5a49` |
| Qualified private replacement, CRLF | `ae53be1a5f081d988709cadf4bc3cd07102aad45acdf959b12cecd2937ee41df` |
| Applied repository patch output, LF | `d79ef4de00ac8d04861f1f6d483bb50cf1517de74c5d8a9832dc4be2c9282758` |
| Retained patch                      | `c1aefb9d2bd88c182b1c2974002643cd4d70b480e8c6ecdf3324c1c484a39168` |

## Controlled full-game build

The complete authenticated public source assembly contained 10,471 regular files;
original-dependent preparation produced a 10,953-file build input. The owned
16 MiB North American big-endian original remained private and unchanged
(SHA256 `89e15df6042defddc48c61f7408f99d06fffdb845e2422cf8b5ba8e73d4d70fb`).
Pinned N64Recomp `81213c1831fab2521a6a5459c67b63437d67e253` performed generation.
Its documented overlay-section abort was retained, then only the reviewed
upstream repair sequence and 17 exact tracked-file restorations resumed. Neither
the owned original nor generated original-dependent output is included here.

Both game builds used the same Windows x64 Clang 22/MSVC ABI profile, installed
MSVC 14.44.35207 and Windows SDK 10.0.19041, source-built SDL 2.30.3,
Freetype 2.15.0 and zlib 1.3.2, and complete portable CMake 3.31.12. Exact
Microsoft DirectX-Headers v1.614.1 supplied the missing GPU-upload enum.
`/FIx86intrin.h` used the real pinned LLVM intrinsic headers to avoid SDL's
obsolete `_m_prefetch` declaration. Neither dependency source nor game features
were disabled to obtain the comparison. Real RmlUi fonts and SVG remained enabled.
These private dependencies differ from publisher packaging; the installed MSVC
and SDK experiment is not an already delivered managed toolchain.

A4 compiled and linked the unpatched game. The first patched incremental attempt
copied source with its older timestamp, so Ninja rebuilt only assets. Its command
exit 0 and unchanged EXE do **not** prove a patched build; that receipt is retained
as invalid for this claim. A2 recorded the old object and source timestamps,
changed only the source timestamp without changing bytes, and required actual
`ui_context.cpp.obj` compilation, linking, a changed object and a distinct EXE.
All expected source, SDK, header, compiler-resource and tool identities were
checked again after each accepted build.

## Actual native comparison and restart

Each runtime contained 85 checked files: the EXE, SDL2, DXC/DXIL, 80 assets and an
empty portable marker. Only the EXE differed between variants. A private copy of
the verified original and source-supported save-directory argument kept the
observations separate from existing libraries and player data.

| Private runtime                                       | Executable SHA256                                                  | Ordinary close                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Unpatched A4                                          | `bc303cb36b7d6a6bd770dc30af703098d2d2d682b663af4ff001efc8931252ca` | OS/Node 127; log records on-exit `0xC0000005` at address `0x30` |
| Patched A2                                            | `3fdef4db53b6ce651a5c208615e1de8eea52854d7b5b2360a6dddc54fd240ed4` | OS/Node 0                                                       |
| Same patched runtime restarted with existing settings | same patched EXE                                                   | OS/Node 0                                                       |

All three observations displayed the rendered v0.2.27 LoD Recomp Launcher,
including text, menus and cursor, then used its ordinary titlebar Close button.
No Start game action was performed. The AMD Radeon RX 9070 XT host selected
Vulkan through the unchanged upstream device workaround; this is not separate
D3D12 or minimum-machine acceptance.

A maintained process snapshot and retained OS handle correlated exact executable
path, PID and creation time with the observed window and Node child. Window
absence was never exit proof. The baseline returned from `recomp::start()` before
its on-exit exception; both patched runs returned and exited 0. All 85 immutable
files and the owned original remained exact. Restart used the existing 92-file
tree without recopying the ROM, and preserved the six existing configuration and
original files; the session log could change. No populated gameplay save was
created or tested. Native reservations released only after positive exit proof.

The first baseline UI receipt incorrectly transcribed the immediate post-close
window count as zero; the raw list still contained the window. That receipt was
retained separately and corrected to one. Neither count authorized an exit claim.
Separate non-writing reviews cleared the source treatment, build packets, actual
build outcomes, native packets, paired outcomes and focused restart result.

## Required delivery engineering

The private full-game comparison resolves the repair hypothesis for this exact
closure. It does not repair the published v0.2.26/v0.2.27 bytes or establish a
usable catalog build route. Existing inactive maintenance evidence remains
credited independently.

A fixed Core recipe must still bind the complete public source/SDK/tool closure,
owned-source generation and exact restorations, apply the reviewed lifetime
patch, and publish through existing supervised build and installation receipts.
The Windows compiler/SDK needs an obtainable fixed closure or a narrowly reviewed
local-toolchain contract. This is unfinished engineering, not an exclusion.
Actual Core-mediated launch/ordinary-close/restart and affected offered-operation
acceptance must follow on the delivered recipe/output. A private EXE hash alone
cannot become a generally obtainable prepared-runtime definition.

No Core execution, managed preparation, public binary distribution, Cataloged-to-
Supported promotion, installed Desktop qualification, other platform acceptance,
protected #246/#534 authority or optional gameplay observation follows here.

## Retained evidence

Private root: `H:/pc6-qualification-20261019-a3/`. The code/source materials,
failures and raw receipts remain there; original-dependent bytes stay private.

| Record                                                   | SHA256 of result receipt                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `evidence/cvlod-baseline-build-a4/result.json`           | `9bc9d2322c3a17f173853e7822a056e4c960c162d58ae6b4b41dd786ff980274` |
| `evidence/cvlod-patched-build-a2/result.json`            | `c231e53539525c24d5857379b2eadf730b8e15e18c6834fc432a9369278f8f0c` |
| `evidence/cvlod-fullgame-baseline-native-a1/result.json` | `3ce6166ab88c4feadeca526b1f650066b267961cbf986ea31de6d87d3180efa9` |
| `evidence/cvlod-fullgame-patched-native-a1/result.json`  | `d0563a7afba59f86fceeab5311f550b4079e78205b45cfbf2751b6bbb6796c8e` |
| `evidence/cvlod-fullgame-patched-native-a2/result.json`  | `0135b342775a9ab289263dde1b59628a13102de330dbaa9a8a7f41b498164564` |

Additional retained records include `cvlod-context-control-build-a1`, complete
source/dependency/SDK/CMake materialization and assembly receipts, generation A1
failure and A2 resume, failed baseline builds A1–A3, invalid patched build A1,
`cvlod-repository-patch-control-a1.json`, immutable runtime inventories, restart
preimage, UI observations, process snapshots and positive OS-handle exit proofs.
