# #144 repaired-package native checkpoint — October 25, 2026

Two real Windows x86-64 prereleases now supply qualification candidates. They do
not yet supply an eligible pair or the #246 unchanged-client journey. Neither is
in the compiled catalog. This receipt adds actual package observations to the
[framework contribution receipt](slice4-144-consuming-framework-adoption-2026-10-21.md).

## Exact candidates

| Identity           | v1.0.6-4p-spike.1                                                                    | v1.0.7-4p-spike.1                                                                    |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Public release     | [423054514](https://github.com/mstan/MegaManX4Recomp/releases/tag/v1.0.6-4p-spike.1) | [423138316](https://github.com/mstan/MegaManX4Recomp/releases/tag/v1.0.7-4p-spike.1) |
| Game source        | `4387947b3c02cf2cab5c4a115e18a07171fe4fcf`                                           | `d22e0dcc46435ab9560d635f4c63bb0857c61d74`                                           |
| Framework          | `a0738464afe8bdf8cb2e9e1eb939699e37027ac4`                                           | `2f3f38403250b2937cf61179a17dc648c3392765`                                           |
| Windows ZIP asset  | `673641870`, 35,486,077 bytes                                                        | `674044440`, 36,359,055 bytes                                                        |
| ZIP SHA-256        | `8d17b69593d645311306651a79d377b200f12e3f36f1c1b262971e96344858a5`                   | `e7260def47707eb398453122f58d73870603b31501e84178bfb616d662e3767d`                   |
| Executable SHA-256 | `8fd255da5480077857cd82604736603c27209cf636e679344c384f001a00d5fe`                   | `dfbe5f2b5fafc010369a8065b66986a502939a0f59a8b759ad04516f39673570`                   |

Both downloaded ZIPs match their provider asset digests. Bounded archive
preflight, extraction, CRC and streamed file hashing completed; raw inventories
are 522 entries/122,045,856 expanded bytes and 536 entries/129,261,166 expanded
bytes respectively. Shipped execution sidecars match the executables and
BUILD_INFO source/framework metadata. Those equalities are not reproducible-build
provenance or protected acceptance. Both framework sources implement ephemeral
generated defaults relative to the current mod root, with explicit selections
retaining priority. The selected scope is ordinary single-player; four-player
features are outside this qualification.

## Actual native observations

The current ordinary, non-elevated owner token was recorded. Each game received a
fixed Windows environment with isolated profile/temp paths and no pipeline
credentials. The existing native-session lock, resource admission and Windows
process-tree supervisor were used. Output capture is bounded to 1 MiB per stream;
no run overflowed. Each completed attempt has a positive process-exit and outer
zero-candidate-process readback.

1. `spike6-first`, PID 30328, started `2026-10-25T08:36:08.7641744Z`:
   responsive titled window observed, normal close requested, exit 0, no forced
   cleanup; 34,191 ms. OpenBIOS, USA serial SLUS-00561, OpenGL and runtime/render
   initialization appear in the actual logs. All packaged files remained
   unchanged. `keybinds.ini` was generated,
   and `mods/state.toml` contained only `format_version = 2`, without a persisted
   generated absolute texture path.
2. `spike7-first`, PID 27780, started `2026-10-25T08:39:56.8224888Z`:
   **failed** window observation. Runtime/OpenGL initialization was logged, but
   no qualifying window was observed and no normal-close request was sent.
   Owned-tree forced cleanup completed, exit -1; 51,336 ms. This is not evidence
   of a shutdown hang. The original runtime and logs remain retained.
3. `spike7-visibility`, PID 50864, started `2026-10-25T08:54:10.5792532Z`:
   separate diagnostic on a hash-checked forensic copy of that failed runtime.
   A responsive 976×579 titled window appeared after about 33 seconds; normal
   close completed with exit 0, no forced cleanup; 48,625 ms. The diagnostic
   extended the finite startup observation from 35 to 90 seconds and supplied
   the current runtime's absolute disc argument. It cannot establish which
   difference caused the later pass. The original failure remains failed.
4. `spike6-relocated-disabled`, PID 63796, started
   `2026-10-25T08:56:22.3327000Z`: after moving the first runtime, its old root
   was absent. The relocated package opened a responsive window and closed
   normally, exit 0, no forced cleanup; 31,004 ms. Readback found all seven
   tracked settings/input/keybind/mod-state/texture-data/memory-card files
   byte-identical. Both blank memory-card files were present in the pre/post
   relocation readbacks; their first creation timing was not independently
   captured. Equality proves neither file-identity preservation nor loading
   nonempty player saves. The default HD feature remained disabled and mod state still
   contained only `format_version = 2`. This establishes that bounded relocation
   case, not the remaining enabled-default or full lifecycle cases.

These windows were not foreground at capture time, so no screenshot or visual
gameplay acceptance is claimed. Memory-card file presence is not in-game
save/load evidence. The forensic copy includes caches for diagnosis and is not
the proposed persistent-data migration policy.

## Runtime and persistence contract still being qualified

The executable is root `MegaManX4Recomp.exe`, normally with its installation root
as working directory. Exact framework `main.cpp` at both revisions is identical
SHA-256 `86954f47c3c4ffe3afa54d4a17a785ad6e04111e35940499c709321fe3e86ab3`;
the observed argument branches are `--disc`, `--memcard-dir`, `--debug-port`,
`--launcher` and `--no-launcher`. OpenBIOS is bundled at `bios/openbios.bin`.

The existing owned USA raw source is 592,217,136 bytes, SHA-256
`3ceab06ac99add4035f912188bcbf5b16c02056f46a33d38ff0c8dbce6cb613b`.
It was reverified and manually copied to `disc/disc1.bin` with a matching cue for
these observations. This manual copy is **not** ordinary Core
StagedSourcePortable/PsxBinCue materialization. No additional source or native
host is required to continue the independent preparation.

Preserve settings, input and generated `keybinds.ini`, actual memory cards,
`mods/state.toml` and user texture-pack data. Keep bundled/executable mods,
overlay toolchains, tools, JIT caches and diagnostic captures separate from
player-data migration. Preserve explicitly chosen external paths; no legacy
absolute-path migration is included. At the initial checkpoint, enabled HD defaults,
changed working directory, external selections and launcher/lifecycle behavior
still required their applicable real-runtime observations. The subsequent results
below advance only the cases actually observed.

The remaining steps include launcher behavior and actual ordinary Core
materialization, install/update/rollback and retained-state readback.
Only a suitable pair enables freezing the capable ordinary-client baseline and
recording initial absence before protected definition → artifact progression →
compatible correction. Gen2 remains separate component evidence.

## Subsequent resource-path observations

Seven additional native cases used driver source
`80cd64eb249d4667e9222294385948e12e1e50e1`, resource helper SHA-256
`ba4d439bd963b21a004421568789938aacf1108de1941e2a6d5ed3f53c1a06c4`
and wrapper `17d3a6b1919c7c73887301ebe37079ee28408ebbf1d285640fab2147d619cd2a`.
All observed a responsive window, requested normal close, exited 0 without forced
cleanup and retained positive outer settlement. None establishes gameplay.

| Retained attempt              |   PID | Start (UTC, October 25) | Duration ms |
| ----------------------------- | ----: | ----------------------- | ----------: |
| `spike6-enabled-commit`       | 46392 | 09:10:28.8015258        |       31617 |
| `spike6-enabled-relocation`   | 63500 | 09:12:01.0361241        |       17961 |
| `spike7-enabled-commit`       | 53744 | 09:13:20.5469149        |       32546 |
| `spike7-enabled-relocation`   | 30400 | 09:14:49.2783903        |       17759 |
| `spike6-explicit-present`     |  6112 | 09:17:19.0599047        |       29606 |
| `spike6-explicit-unavailable` | 66876 | 09:21:43.2814176        |       50149 |
| `spike7-explicit-progression` | 63556 | 09:24:48.2974245        |       32413 |

Both packages committed an enabled HD selection without a resource path. The
actual logs resolved the generated pack beneath each executable. After moving
each installation with its old root absent, a different working directory still
resolved mods and memory cards beneath the new executable root. Seven retained
settings/input/keybind/mod-state/texture-marker/blank-card files per package were
byte-identical. The working directory had no mods or saves; it did receive runtime
diagnostics. Blank-card equality remains insufficient for nonempty save/load or
file-identity acceptance.

The explicit external selection retained priority. When its owned user-data
folder was temporarily renamed, the runtime recreated empty `replacements` and
`dumps` at that same selected path; it did not refuse or substitute the generated
default. Recovery retained the empty scaffold separately and restored the original
user-data folder and matching marker bytes. Manually transferring the committed
selection to the second package retained that external path and marker. This is
native path/state evidence, not a Core update or permission to migrate/delete
external data. No legacy absolute-path migration was performed.

The closed runtime inventory found all 520/534 packaged immutable files unchanged
and both materialized source copies matching. Its classification assertion failed
on a startup-log locator and a freeze dump. The original failed inventory remains
failed. Three retained diagnostics report `hard_freeze`: two at frame/cycle zero
and one at frame 310/cycle 175250789. Later shared-working-directory telemetry was
overwritten by later runs, so it cannot establish recovery within those original
attempts. Neither a responsive window nor normal shutdown explains these dumps;
their cause remains unresolved. Raw diagnostic memory and copyrighted source
bytes remain private.

## Bundled-compiler diagnostics and owned recovery

The seven cases above selected GCC from the development host. The packages bundle
TinyC, not GCC. Exact framework source selects bundled TinyC when host GCC is
unavailable. Two fresh generated-cache diagnostics therefore restricted the child
PATH to the observed Windows system/Windows directories, retained the previous
caches by owned rename and used separate working directories. No software was
installed. These were not fresh OS or empty system-cache observations.

Both actual logs selected the bundled toolchain and `overlay autocompile enabled
(tcc)`. Helper SHA-256 was
`5e58bf06d555acdc492db4e05ce93f1f705059c25e7cbae3b84fdbb67e628caf`,
wrapper `12dffa44090e5632a392bc4c48b4df1532d7bb67e39329521c4d7051e6c3501b`.
Driver base was `432643a9f682c11de8fd398f1c69e56003fc0d91` plus the reviewed
process-lock recovery delta, file SHA-256
`3bcffa9f43b63aff3f2d5176d52ba541b913b13d995aef97ed7af980695cac53`.

| Attempt           | PID / start UTC          | Duration ms | Final frames / cycles |
| ----------------- | ------------------------ | ----------: | --------------------- |
| `spike6-tcc-cold` | 58232 / 09:53:16.6243397 |       33571 | 823 / 464567040       |
| `spike7-tcc-cold` | 15220 / 09:55:46.0301005 |       31675 | 829 / 467953920       |

Both observed a responsive window and normal SDL window close, exit 0, no forced
cleanup, zero autocompile degradation and zero automatic freeze dumps. Their
unique working directories retained each attempt's final heartbeat and last-run
report; positive process settlement was observed. No foreground screenshot,
gameplay or nonempty save/load acceptance follows. These later TinyC results do
not establish the cause of the earlier GCC-route dumps or whole-pair suitability.

A preceding `spike6-cold-observation` failed before the payload directory existed.
The old wrapper's `finally` masked the underlying error, which remains Unknown.
Its original log, settlement, intent, preserved cache and owner records remain
retained. The repaired wrapper records the primary error before settlement and
continues to hold unknown-status attempts for explicit reconciliation.

The delivering agent reconciled only that attempt's positively absent PID 45440
and exact host/legacy owner tuples through the existing process-lock machinery.
The new optional `expectedStaleOwner` guard refuses changed token, PID, creation
time or process identity on every acquisition read. A regression replaces an
observed stale owner with a different dead successor and verifies refusal and
preservation; all six focused lock tests passed. Original owner bytes/hashes and
recovery readbacks were retained before mutation. Independent review cleared the
guard, exact recovery helper and error-preserving wrapper before use. No foreign
lease, administrator action or automatic retry was involved.

The proposed persistent set remains `saves`, `settings.toml`, `input.ini`,
`keybinds.ini`, `mods/state.toml` and user `mods/texture-packs`. Version-local
executable mods, toolchains, JIT/native DLL caches, overlay captures, heartbeat,
last-run/startup diagnostics and freeze dumps are not player-data migration
inputs. Actual ordinary Core materialization, launcher, update/rollback and
nonempty retained-state observations remain pending. The compiled managed
definition is still absent; an existing listing-only title is not absence of the
title itself. Freeze the capable ordinary-client baseline and observe actual
managed-definition absence before delivering the definition. Nothing here
completes #246's protected journey or changes #315/#534 acceptance.

## Retention and acceptance boundaries

Raw acquisition, package manifests, owned-source checks, process receipts,
stdout/stderr, window inventory and settlement records are retained under
`work/slice4/144-spike-pair/` and
`work/slice4/native144-spike-20261025/` in the delivery checkout. These private
records and copyrighted source/game bytes are not published with this receipt.
The accompanying [evidence manifest](slice4-144-repaired-package-native-2026-10-25.json)
binds retained record bytes without treating local evidence as a hosted artifact.

[psxrecomp #756](https://github.com/RetroPortingToolKit/psxrecomp/pull/756)
remains open at `f545b273305e9ecd9fb3e43c1bf5f4f0a7897d02`, targeting
`feat/conditional-mod-resources-x4`. Its submitted focused package/runtime suite
passes and independent review retain their framework-only scope; immediate
hosted check inventory was empty. The earlier file-identity failure and .35/.36
full-default-persistence failures remain retained at their actual sources.

No new authority decision follows from these observations. #254 remains Done;
#315/#534/#246 acceptance remains pending, Chameleon protected acceptance remains
unset, production remains held and Slice 5 is excluded. Bounded-attempt capacity
still has Unknown availability/headroom and no capacity reservation.
