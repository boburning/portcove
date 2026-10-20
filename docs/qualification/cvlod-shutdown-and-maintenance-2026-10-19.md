# CVLoD Windows shutdown diagnosis and inactive maintenance

This dated #320 result credits #805's accepted baseline operations and #1931's
delivered successor proposal and `cheats.cfg` ownership correction. It adds
actual selected-artifact and inactive-maintenance evidence. Windows clean-close
acceptance remains held for the tested configurations of both versions. This
disposition does not add a Core launch block or exclude the entire port.

## Exact runtime observations

| Version | ZIP SHA-256                                                        | Executable SHA-256                                                 |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| v0.2.26 | `be60fefdbc4a98d1cf2ab6932e69825f39268e5ad1daab950ea7b8a19e53b40a` | `4c695d5a86e67868c39b4850af1fe396c7a8f6c8620e47cf125271795aeef6b2` |
| v0.2.27 | `677cea596030f2ae888904884a64e685be5215eb954431fcee01bafb7757f467` | `e3b0ec8d8e5a0082f0d3e68061e2df6eee0ff0e1cae345843f6fc3cc2b0f2989` |

The [original successor proposal](cvlod-windows-compatibility-proposal-2026-10-13.md)
retains release, source and metadata identities. The actual successor archive is
29,758,946 bytes. Its Core staged manifest contains 53 immutable files. The
admitted original has SHA-256
`89e15df6042defddc48c61f7408f99d06fffdb845e2422cf8b5ba8e73d4d70fb` and
SHA-1 `879ead98f197fd05edda867655da5b1ce25aa5b8`. Original archives were read
only; no original, generated game content or dump is published here.

The runtime packets used Core source `e94ce4e7e1b3a3245961bdf2d713df6d8cfcfafa`
and qualification CLI SHA-256
`477e94dbbb596d9326e1384c521b95e0d0ce7a9f138849581b10ad27a783f850`.
Private exact-release catalog fixtures do not supply production definition,
signing or publication authority.

Both identity-bound main-window close probes observed responsive windows before
attaching Microsoft CDB and requesting ordinary close. The game-process handle
and Core terminal record agree on `0xC0000005` (unsigned 3221225477, signed
-1073741819). The CLI returned 1. This is debugger-attached native evidence,
without Start Game, gameplay or in-game save/load observations.

| Packet            | Core request                           | Local dump observation                                                   |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| v0.2.26, native-4 | `61040f03-7430-45bf-9ef9-fb6d579f690f` | read `0x30`, `LodRecomp+0x1112d0e`, then `+0xee834d`, CRT on-exit frames |
| v0.2.27, native-6 | `d121a79d-74a7-4cba-ba9f-93d86cd1a38b` | read `0x30`, `LodRecomp+0x111c86e`, then `+0xeeb08d`, CRT on-exit frames |

Both packets retain the preceding RmlUi surviving-element warning, positive
game/debugger exits, terminal Core failure readback and post-run 53-file
verification. Native leases were released from those process proofs. No matching
game PDB was supplied, so these offsets do not identify an exact source line.
Earlier harness refusals, interrupted verification and their recovery/disposition
receipts remain preserved; they are not normal-close observations.

## Pinned dependency lifetime control

The two selected game revisions retain byte-identical UI context/state source.
At successor source `cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d`,
[`create_context_impl`](https://github.com/fliperama86/cvlod_recomp/blob/cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d/src/ui/core/ui_context.cpp#L170)
unconditionally constructs a function-static `Rml::ElementDocument`. Context
cleanup clears contexts but leaves that document alive; the
[`deinitialization hook`](https://github.com/fliperama86/cvlod_recomp/blob/cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d/src/ui/ui_state.cpp#L965)
then calls `Rml::Shutdown()`.

The pinned RmlUi gitlink is `2cd28864ae25ed345b70598751703a5433b12356`
(RmlUi 6.3). Its element destructor dereferences `ElementMetaPool`; shutdown
releases that pool even when it reports a surviving element. A source-verified,
first-party minimal control compiled that exact dependency with a base font
interface, without game source, originals, assets, fonts or optional plugins.

| Identity                          | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| RmlUi source ZIP, 4,544,948 bytes | `9d861c81a5556ae1f8067e7eacad5e6f0642ce77027564bb082c601ee838856c` |
| Control C++ source                | `b9126a9e7518a8ae37935acb073ede7c630befd2b67bcbfe6df47d449cf33676` |
| Control CMake source              | `d34af035ed495c238c654512c14c84fed33028a45dfa29fc511944bd12aa3afc` |
| Built control EXE                 | `bb6a42e20a80fc385395f88398e29ba84f0a5392729dfa43e1bb04dbe1e803eb` |
| Control PDB                       | `6e00f29585339b7ed20721aadd052957cc057eb15b4ed1f0522ba9a8a9144b26` |

Archive central metadata was bounded before parser construction. All 1,169
materialized files matched their Git blob identities and remained unchanged
through the private RelWithDebInfo build with MSVC 14.44.35207. The selected
CMake graph had no enabled downloads or external build commands. The control
statically linked RmlUi Core; metadata-only import inspection found the Windows
and MSVC runtime imports, without a side-loaded RmlUi DLL.

The separately reviewed runtime packet used fresh host/native admission and the
previously qualified accounted process controller. Each serial case had a
three-second wall/CPU bound, 128 MiB memory bound, one-process limit, 64 KiB
output limit and finite outer controller bound. It checked exact executable,
PDB, source, controller and current signed System32 runtime identities.

| Document lifetime                          | Final process exit | Process proof                                            |
| ------------------------------------------ | ------------------ | -------------------------------------------------------- |
| Destroy document before `Rml::Shutdown()`  | 0                  | closure proven, active 0, total 1, no forced termination |
| Function-static document survives shutdown | `0xC0000005`       | closure proven, active 0, total 1, no forced termination |

Both cases printed “shutdown returned; main returning.” The final process exit,
including CRT teardown, determines the result. This comparison establishes the
pinned dependency's lifetime failure. It supports the source lead but supplies
neither shipping-binary attribution nor game repair/acceptance. The game did not
run in this control. The supervisor exited 0 and released its native lease only
after positive closure proof.

## Actual inactive maintenance

The exact archived qualification CLI above performed these operations against
the retained owned diagnostic library. It did not launch the game. Initial
active v0.2.27 installation was `e0ff3c7c-575a-4694-94df-c1f9a0f4a9b9`;
previous v0.2.26 was `f204c2bb-57cd-4a03-981f-2fc1f247c42f`.

1. Core created backup `f39baccf-0236-462a-86db-74947682bf4f`, covering actual
   `audio.json`, `controls.json`, `graphics.json`, `cheats.cfg` and `rom.z64`.
2. An inactive comment-only `cheats.cfg` control changed canonical and effective
   active copies after owned-path, no-follow, single-link and preimage checks.
   Consented Core restore returned both to the original bytes.
3. The packet verified the fresh safety backup's identity, owned path and changed
   config contents, then consented to deletion of only
   `ed6cca5a-fae1-4491-a702-88bc6ddac4b5`. The original backup remains retained.
4. Core rollback selected the exact previous v0.2.26 installation and immutable
   verification passed. A second rollback returned v0.2.27 to active with the
   original previous pointer; verification passed again.
5. All five canonical and final active user files matched their initial bytes.
   All 106 immutable members and both retained manifests stayed unchanged.

Old v0.2.26 mutable preimages were retained before rollback: its `graphics.json`
was 369 bytes, versus the current 329 bytes, and it originally had no
`cheats.cfg`. The rollback operations transport current canonical settings into
the selected runtime. They do not prove the older game consumes those bytes or
reads populated saves. No actual in-game saves existed in these packets.

The library has one preserved interrupted verification activity,
`9cf615f8-a681-430c-a843-8034160bafb7`, with no cancellation owner or lifecycle
journal. Its complete row remained unchanged. Before and after maintenance,
there were zero lifecycle journals and unfinished launches, no additional
running activities, and fresh bounded absence evidence for relevant CLI/game
workers. Every new maintenance activity finished. Core's ordinary port locks
and refusals remained authoritative; no history was rewritten into success.

The first maintenance preflight rejected the historical mutable build path
after its executable bytes changed. The archived copy matched the original
hash exactly. A subsequent path-spelling comparison refusal was repaired by
using a common Win32 namespace. Packet A1 then refused foreign fixture
supervisors before any maintenance operation. The reviewed A2 query retained
exact CLI/game names and excluded those unrelated supervisor names. These
failures and raw inventories remain retained. A2 completed with exit 0 in
148,807 ms including 43,119 ms resource queue/setup; no duplicate worker ran.

## Remaining requirement and evidence custody

The subsequent [October 20 private source comparison](cvlod-source-shutdown-repair-2026-10-20.md) establishes a full-game lifetime repair and restart in its exact private build closure. Core recipe/toolchain delivery and affected operation acceptance remain unfinished; the shipping-artifact failures below remain retained.

Clean-shutdown acceptance remains held for the exact tested Windows artifacts
and configurations. Do not rerun the unchanged failures, normalize their exits
to success or infer a repair from startup/rendering release notes. A narrow
source treatment would give the dummy document explicit ownership and destroy
it after context cleanup but before RmlUi shutdown. The blob-verified element
wrapper borrows this document. A controlled full-game source-build comparison
or eligible changed authenticated artifact still needs actual qualification;
the minimal dependency control is not that proof. This remains required work,
not a whole-game exclusion or completed runtime repair.

Unaffected accepted source/install/verification operations remain credited;
the selected activation and inactive maintenance above add only their recorded
scope. Protected #246/#534 installed-client custody/grants/publication remain
separate and ungranted. No upstream contact, modified-binary publication,
support promotion, other-platform or optional gameplay acceptance follows.

Private evidence is retained under `E:/Codex-Evidence/slice6-20261018/`:
`cvlod-diagnostic/native-{4,5,6}`, `cvlod-rmlui-control-build-a1`,
`cvlod-rmlui-lifetime-control-a1`, `cvlod-ui-element-pickup-a1`,
`cvlod-maintenance-inspect-a{1,2,3,4}` and `cvlod-maintenance-a{1,2}`.
Separate non-writing review cleared the diagnostic source, runtime packet,
actual result and maintenance packet; actual maintenance-result review is
recorded with the delivery receipt. Raw failures, private dumps, source
preimages, process proofs and original receipts remain intact.
