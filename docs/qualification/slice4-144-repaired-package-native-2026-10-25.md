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
   unchanged. Actual memory-card files were created, `keybinds.ini` was generated,
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
   byte-identical. The default HD feature remained disabled and mod state still
   contained only `format_version = 2`. This establishes that bounded relocation
   case, not the remaining enabled-default or full lifecycle cases.

These windows were not foreground at capture time, so no screenshot or visual
gameplay acceptance is claimed. Memory-card file creation is not in-game
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
absolute-path migration is included. Disabled and enabled HD defaults, changed
working directory, external selections, launcher behavior and complete retained
state beyond the recorded disabled-default relocation case still require their
applicable real-runtime observations.

The next bounded steps are the remaining enabled-default, changed-working-directory,
explicit-path and launcher cases with retained-state readback. Then exercise actual ordinary Core
materialization, launcher, install/update/rollback and retained-state readback.
Only a suitable pair enables freezing the capable ordinary-client baseline and
recording initial absence before protected definition → artifact progression →
compatible correction. Gen2 remains separate component evidence.

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
