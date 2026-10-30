# Four hybrid/native player handoffs — October 30, 2026

This bounded #2926 batch delivers existing-copy Windows routes for
[Arwing2 #1946](https://github.com/boburning/portcove/issues/1946),
[Go Go Ackman #2881](https://github.com/boburning/portcove/issues/2881),
[Strike Gunner #2713](https://github.com/boburning/portcove/issues/2713) and
[Top Gear #2905](https://github.com/boburning/portcove/issues/2905).
The shared cause is selecting an already working real player rather than an
installer, source/setup host or short-lived settings dispatcher, while preserving
originals, private generation, profiles and hybrid execution limits.

These are existing frozen identities: Arwing2 is original524; the other three
are affected312. All four are outside #1422's overlapping historical subset.
No new identity, strict definition, release commitment or support is introduced.
Full #2510/#2926/#1422 acceptance stays open. [Companion audit #2552](https://github.com/boburning/portcove/issues/2552)
is closed at its corrected discovery/intake scope; no competing audit owner or
new family campaign is created. Native host, compiled game dispatch, interpreter
fallback, source metadata, package identity and actual gameplay remain distinct.

## Exact source and evidence limits

The [source packet](snes-hybrid-player-handoffs-2026-10-30.json) rechecks 222
**distinct repository/commit/path/blob bindings**, 130 unique content blobs and
ten complete tree reference roles. Arwing current/tag are the same source;
those duplicate reference roles are deduplicated, yielding nine distinct
commit/root-tree bindings and nine root-tree objects. Source/API bytes,
Git blob SHA-1, SHA-256, actual tree membership and nontruncation are bound.
Pinned framework consumers and Ackman's applied local patch inputs are explicit;
this is not exhaustive transitive dependency/package compliance or source-to-binary
certification.

| Owner                | Selected source                            | Separate current observation               |
| -------------------- | ------------------------------------------ | ------------------------------------------ |
| Arwing rolling1.0    | `f683ae57c05277aef1cd7e07ff30c3b6a4358a84` | same commit                                |
| Ackman v1.0          | `9f12ba1e59185e6fbe70eb7822338c7709f0c86a` | `db9f16b5ae51719f0ec81f3f4bae63a5ef84348c` |
| Strike Gunner v0.3.0 | `cb6287f3f5a72fd3f33c2c97876b7e3800649a03` | `f507564744619c791d8779e8f2e9c60e15c6bc5e` |
| Top Gear v0.1.3      | `b91007aaf1bb95afa4c510d734f74455de48a770` | `d390f2b2face6c478e0bf10f1896af0b82310c3e` |

No game package, ROM/original/private save, upstream helper/compiler/installer or
game was acquired or executed. Publisher assets/digests are metadata only;
previous source claims and actual observations keep their original scope. No
newly computed hash substitutes for accepted identity. Native Core probes are
not these games, hardware/audio, ROM/code/package or full-game qualification.

## Arwing2: installed game, separate rolling installer and profile

Selected README affirmatively documents installing and playing Project Arwing(2)
with one's own Star Fox2 SNES Classic/Mini retail ROM, SHA1
`1135a2a6cb786ac7523e81dd553dc81aaa266f51`; 1995 prototypes are different.
Its picker accepts an optional 512-byte copier header, verifies the normalized
input and copies `sf2.sfc` into the actual profile. Preserve both original and
copied input. Core does not import/extract/authenticate originals or generate
code. MIT covers tools/runtime/installer, excluding Nintendo disassembly and
ROM-derived assets; no whole-component/package grant is inferred.

Rolling Windows asset `arwing.exe` is an **installer**. Complete official install,
ROM picker and a working normal launch externally, then select installed
**Project Arwing (2).exe**, zero arguments, containing installation-root initial CWD.
Selected installer source writes that literal filename; `arwing2.exe` is its App Paths alias/build name, not the installed file to select.
The installer defaults under the user's local Programs folder and records its
actual installation location; no hard-coded path is required by Core. The native
Windows application changes into `%APPDATA%/Project Arwing (2)` and owns its game
and UI process. Registration does not install or launch anything. Star Fox2 is
independent from original Star Fox Enhanced #124.

Startup may move legacy `%APPDATA%/Project Arwing` if the new profile is absent
and the old `sf2.sfc` exists. Preserve both histories; this is upstream migration,
not Core adoption. Keep whole installation/profile/original, `sf2.sfc`,
`sf2.sfc.srm`, `sf2.ini`, saves/states/screenshots and all logs/custom/unknown
files. Source-build paths are different and retain their creating coordinates.
Keep old state and runtime together; metadata removal neither uninstalls the
application nor deletes profiles.

Native 65816/SuperFX translated code coexists with hardware/interpreter fallback.
Upstream dispatch/hash coverage is sampled; audio/hardware comparison, subpixel
recovery and aspect limitations remain. The selected README explicitly states no true widescreen and partial HD sub-pixel recovery for approximately66–90% of vertices; these are attributed upstream limits, not our measurement. No emulation-free, exhaustive equivalence,
Portcove native/gameplay/save/audio or other-platform claim. Diagnostic
`--interp`, coverage/headless/frame/script modes are not the selected player.

Upstream compares the mutable1.0 tag to build ID and can download/start the
Windows installer with `--update`; no independent digest/signature validation is
established by that inspected path. It is player/upstream-owned replacement,
not Core verified update or a process-family guarantee. Tags/assets are
replaceable; October12 metadata does not identify October30 bytes. Finish actual
replacement outside Core and re-review changed executable through relink.

## Strike Gunner: completed private build, not the source/setup host

The publisher's v0.3.0 Windows ZIP and PLAYING.md describe a **setup/source pack**.
Root `StrikeGunnerSTGSNESRecomp.exe` asks for the user's own ROM and offers
Generate & rebuild, potentially downloading shared `cmake-clang-v1` tools;
it closes and starts the external build console. No original ROM or generated
C is intended in that staged setup pack. Finish supported upstream generation,
compilation and a normal working launch externally. Core supplies no compiler,
SDK, setup-script host or generated-runtime activation.

Select actual completed **build/StrikeGunnerSTGSNESRecomp.exe**, build-directory
initial CWD, zero arguments for the established normal ROM choice. Preserve an
already required supported absolute ROM positional argument/custom context
when needed. Do not select the root setup host, rebuild console, build/toolchain
helper or diagnostic mode as ordinary Play. Completed desktop host remains
through normal launcher/game play; future rebuilding is external replacement
followed by fresh relink review.

Own USA Strike Gunner S.T.G `.sfc`, SHA256
`05f14e6ed3394d9273e2397769a8acf1a9db646be6066e82269521e8eec53562`,
CRC32 `d054e288`; upstream generation/runtime verifies selected identity.
Other revisions/modified input are not inherited. Pinned framework fork
`SlippyGetBackHere/snesrecomp` at
`ae8d20cfddcc2d40104b73ff59abec68946d242d` and selected UI pin/patch ownership
remain explicit. Native variants coexist with hardware and uncovered-code
interpreter fallback; upstream completion/audio/state claims are not Portcove
full-game or state observations. Original/derived code and all framework/project/
component terms stay separate.

Preserve whole original/source/generated/build/runtime copy, actual external
ROM path, build `config.ini`, `keybinds.ini`, `strikegunner.ini`, `rom.cfg`,
`saves/save.srm`, all states, logs/captures, mod/music/player edits, caches and
unknown/custom paths. External music/config/original roots need separate
preservation. Existing versioned state/mod records remain with their creator;
source compatibility statements do not establish real save/load acceptance.
Metadata removal preserves all bytes and does not tear down shared tool caches.

## Top Gear: direct hybrid game and absolute original argument

Tagged publisher instructions explicitly support direct `topgear.exe` with a
ROM argument or original beside the executable. Use an already permitted working
Windows x64 v0.1.3 copy. No root project LICENSE was found in complete trees;
LakeSnes MIT is not a grant for all project/game/package material. The direct
player invitation supports the narrower permitted private-copy handoff; optional
LICENSE absence alone is not a private-execution prohibition.

Own unmodified USA ROM, 524,288 bytes after optional 512-byte copier-header
normalization, SHA256
`ca9889f17f184b3d99a2eaaa82af73e366f03ed00313fdd369e5e023b208e788`.
Keep exact original/path for assets, graphics and audio. Core does not import,
patch, extract or authenticate it. The upstream loader checks normalized input;
foreign/mastered/translated versions are not inherited.

Select **topgear.exe**, one absolute existing owned original path as a single
literal argument (spaces stay in that token), actual established writable
installation-root CWD. Complete settings in `topgear-launcher.exe` separately:
its launcher sets background creation and destroys its process handle without
waiting, so it is not the selected long-lived game. Do not select headless,
`--original`, verification/replay or build helpers. Native races remain translated
C; menus/some routines remain LakeSnes. No emulation-free/full conversion or
runtime coverage percentage is claimed. Linux remains experimental and upstream
untested on real machines, independent of this Windows route.

Preserve whole runtime/original and actual SDL profile
`%APPDATA%/topgear-pc/Top Gear`: `settings.txt`, `launcher.txt`, `progress.txt`,
`ghosts.bin`; executable-side `controls.txt`, recordings/session logs/coverage,
custom/replay/mod and all unknown files. Recordings can fall back to the actual
SDL profile if executable-side directory creation fails; preserve actual
locations and any custom CWD. Automatic progress/ghost/record writes are upstream/
player actions, not Core ownership or tested compatibility. Keep old runtime/data
separately and re-review changed executable through relink; removal is metadata-only.

## Ackman: compiled dispatch source resolved, runtime fraction unknown

The canonical next action asks whether game code actually dispatches to compiled
bodies, beyond a native UI. Selected source establishes **reachable hybrid
compiled game dispatch**:

1. CMake pins framework `e119994bcde03dec95f9ebaeeda305d72a6668b2`, applies local
   patch inputs, adds selected `src/gen/*.c` and defines generated-code presence.
2. Selected generated table contains 73 dispatch addresses and 89 non-null M/X
   slots referencing 89 distinct bodies; each has a definition in selected bank C.
3. Normal host registers its game info. Ackman frame handling calls RtlRunFrame,
   selected GameRunOneFrame and the pinned interpreter bridge. That bridge can
   reach `cpu_dispatch_has_entry` / `cpu_dispatch_pc_paired` and registered
   compiled bodies while retaining interpreter/hardware execution.

This resolves source reachability/classification, not measured dispatch fraction,
whole-game completeness, native runtime execution or exhaustive equivalence.
The selected release is v1.0 while its source also declares an experimental game
build version. Interpreter/core terminology is preserved rather than removed.

Use an already permitted complete working Windows **AckmanRecomp.exe**, zero
arguments for the established normal own-ROM choice, actual writable containing
installation-root CWD. Preserve supported existing `--config`/absolute config
path or ROM positional arguments when required; keep each path's spaces in its
literal token. `AckmanBootEnter` owns the normal watchdog/supervisor and waits for
its child/recovery lifecycle. Do not bypass it with private child/restart flags.
Shader/driver/mod changes may cold-boot, restore emergency snapshots or try
fallback configs. Core observes its selected process, without a family/sandbox
or upstream recovery guarantee. Finish actual repair/replacement upstream before
relinking a changed executable.

Own Japanese Go Go Ackman ROM: normalized1,310,720 bytes, SHA256
`e8a33b6c8e15cf0aa60e9694471a51926fb97ad895d4714384c6abff28a33a1f`;
optional512-byte copier header is normalized upstream. Other revisions require
their own evidence. Preserve whole runtime/original, actual config.ini/custom
config, rom/, external input path, saves/slots/custom states/GGA1_autosave.sav,
emergency checkpoints, mods/MSU/player edits, shaders, screenshots, logs/status
files, fallback config history and every unknown path. Windows writable root is
actual executable-side; changing CWD is not a profile redirect. This cartridge
has no battery SRAM declaration; native states are not interchangeable emulator
saves. Keep all recovery/state/mod data with its creating runtime.

### Precise translation-component acquisition condition

Project/framework PolyForm Noncommercial original-contribution and retained
component terms remain scoped; original ROM and external translation/audio
rights are not granted by that file. Source consumers compile a fixed English
IPS-derived translation table plus English/PT-BR translation metadata. The
PT-BR metadata header alone does **not** establish a full embedded PT-BR patch
payload. Credits and MD5 inputs are not an applicable redistribution grant.

The fresh-acquisition condition therefore names any included source-bound English
translation payload/metadata and requires exact selected-package applicability
and applicable permission, or a reviewed asset-clean route. This source review
is **not a contents certificate for an unacquired asset**. Nor is it a blanket
private-execution prohibition: an already permitted private Japanese base-game
copy remains a separate use question. Core offers no translation download,
patch conversion, original acquisition, shared component grant or full package
rights clearance. Conditional source uncertainty stays visible, not silently
relabeled a failed measured package inspection.

## Validation and delivery boundaries

Maintained per-record preparations keep operational projection unchanged. Only
four `manual_setup` guides and Ackman's exact `download_block_reason` are added;
all accepted artwork/lineage, identities and 272 strict definitions/source
contracts remain unchanged. Generated listings come from maintained generation.
Four actual-ID cases reuse the complete inert native-probe helper for consent,
stale intent, relink, restart/retained creating listing, separate selected-process
Play and metadata removal preserving external bytes. A fifth actual-ID Ackman
case reuses the complete zero-provider/no-publication refusal helper with guide
presence. No prior refusal ID/assertion or production lifecycle code changes.

Independent early source/use and exact-proposal review cleared the bounded
routes and source-bound condition. Final committed-diff/source, parent-squash
composition, exact-head hosted inventories, current-target review, guarded merge
and individual canonical dispositions belong to the delivery PR/receipts. Local
stack parent4576fc66 is historical review basis, not assumed delivered before
#4101 actual readback. No strict admission, managed acquisition/generation/update/
rollback/backup/migration/deletion, actual game/save/state/mod/installed/physical/
human/other-platform/protected qualification or Supported/fleet completion claim.
