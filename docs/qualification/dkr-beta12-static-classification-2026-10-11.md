# DKR-R beta12 static helper and persistence classification

Dated October 11, 2026. Owners: [#54](https://github.com/boburning/portcove/issues/54)
and proposal preparation [#254](https://github.com/boburning/portcove/issues/254).
This completes the source-independent classification permitted by the
[October 10 byte/layout checkpoint](https://github.com/boburning/portcove/issues/54#issuecomment-6100240187).
The existing [release-selection proposal](dkr-numbered-beta-selection-2026-10-10.md)
and retained 1.0.4 Windows/Linux evidence remain credited.

## Identity, method and scope

Repository comparison target: Portcove `748f010804ac2e97dadb660643622b34e2a9f654`.
The accepted catalog, adapters and guards are unchanged. This is dated static
proposal evidence, not an admitted version, support promotion or publication.

| Source identity                          | Exact observed commit                      | Evidence boundary                                                                                                             |
| ---------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `ThatGuyMcd/DKR-R`, `Version1.0.4`       | `b0156864562100ce3453ce4b72ba15c8e3125376` | Current direct tag read; commit dated September 3, 2026; not an attestation of the previously qualified binary's build inputs |
| `ThatGuyMcd/DKR-R`, `Version1.0.5beta12` | `8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6` | Exact source already identified by the October 10 checkpoint; source-to-package reproducibility remains unproved              |

Both recursive Git tree reads reported `truncated=false` (385 and 690 records,
respectively). Only the 29 selected blobs below were read: 1,331,194 bytes.
Each response decoded to its declared size and matched Git's SHA-1
`blob <length>\0<bytes>` identity independently; SHA-256 values were also retained.
Per-blob source reads were bounded to less than 1 MiB with a 30-second read
subprocess deadline. No source build, script, self-test, helper or game ran.

Existing authenticated artifact inspection is reused, not repeated:

| Release / artifact            | Exact identity retained                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| beta12 release                | ID `399053184`, tag `Version1.0.5beta12`                                                                        |
| Windows ZIP                   | asset `597977195`, 23,636,673 bytes, SHA-256 `456ae813bddf2bb34e5be1e63ce00b95bf2b09ca4280d5655d8cea6612358f0b` |
| Linux AppImage                | asset `597977048`, 28,281,336 bytes, SHA-256 `525ef84d7382d017de43d3c2dfdc29f608052f88a16ecffac41154d1f720b3ae` |
| Retained 1.0.4 Windows ZIP    | SHA-256 `0732aa1637f6813f6cce9a23564f53214b2f47b913bbb1ade23298a97a37f728`                                      |
| Retained 1.0.4 Linux AppImage | SHA-256 `9da1e72dd23eaf7b6e096f19bc2bb215065e2ef7c5fd35a2601c9d430fe25ee0`                                      |

A current 1.0.4 release metadata read reports release `382294437`, Windows
asset `543261861` and Linux asset `543261835`, with those retained digests.
Matching metadata does not newly verify retained bytes or qualification.
The October 10 receipt binds the complete Windows manifest and selected Linux
members, including main/InputHost/ModWorker hashes. Its raw inspection and source
manifest SHA-256 values remain `a955a9d6d7510fbceae4b5477658c9a77c168318ff1211a9cef1dbda49f1a50f`
and `814c314b2e1d76f441a69ad7179c4f667df58f882b48df6ca9492d5e3be061c8`.
Those artifact files were not present in this cloud checkout; their canonical
receipt supplies the reused observations, not a fresh local artifact readback.

## Helper responsibilities and ownership

Links below name the exact beta12 source revision.

- **InputHost:** [host source](https://github.com/ThatGuyMcd/DKR-R/blob/8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6/runtime-recomp/src/input/sdl3_input_host.cpp)
  initializes SDL3 gamepad, sensor and haptic subsystems and accesses HID devices,
  including feature reports. It connects to a parent-created loopback socket;
  the client supplies a port, token and optional mapping database. It is an
  active input/device helper, not a read-only metadata tool. The host and
  [client](https://github.com/ThatGuyMcd/DKR-R/blob/8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6/runtime-recomp/src/game/sdl3_input_client.cpp)
  blobs are byte-identical between the two inspected source commits. InputHost
  therefore is not newly introduced in this source comparison; the old binary
  package's helper inventory has not been re-inspected here.
- **InputHost resolution/lifetime:**
  [runtime_platform.cpp:340](https://github.com/ThatGuyMcd/DKR-R/blob/8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6/runtime-recomp/src/game/runtime_platform.cpp#L340)
  accepts a regular-file `DKR_SDL3_INPUT_HOST` override, then searches executable
  `libexec/dkr-r`, its parent, executable directory and current-working-directory
  `libexec/dkr-r` candidates. These checks alone do not authenticate helper bytes.
  Client shutdown sends a protocol packet, joins its reader and reaps the direct
  process. The POSIX force path eventually sends SIGTERM and uses blocking
  `waitpid`; this static code does not prove a bounded natural exit, descendant
  quiescence or compatibility with Portcove supervision. Preserve the exact
  helper trust/environment/resolution and lifetime obligations.
- **ModWorker:**
  [worker source](https://github.com/ThatGuyMcd/DKR-R/blob/8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6/runtime-recomp/src/game/mods/legacy_mod_worker.cpp)
  is absent from the inspected 1.0.4 tree and present in beta12. It accepts one
  request path (or an unexecuted self-test switch), reads at most 64 KiB of JSON,
  checks the schema and at most eight ROM paths, and dispatches import,
  track preparation or character preparation. It writes `content`, fixed-label
  `progress.jsonl` and bounded failure text beside the private request.
  [stage_import](https://github.com/ThatGuyMcd/DKR-R/blob/8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6/runtime-recomp/src/game/mods/legacy_mod_stage.cpp)
  creates converted patch/blob/review output and enforces its stated 256 MiB
  transaction limit. This classifies a writing/conversion helper; no safety or
  successful import execution is claimed.
- **ModWorker resolution/transactions:**
  [runtime_ui.cpp:10630](https://github.com/ThatGuyMcd/DKR-R/blob/8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6/runtime-recomp/src/game/runtime_ui.cpp#L10630)
  searches beside the executable or its parent under `libexec/dkr-r`, not a mod
  directory or CWD, then configures `config/mods/legacy`.
  [ImportLibrary](https://github.com/ThatGuyMcd/DKR-R/blob/8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6/runtime-recomp/src/game/mods/legacy_import_library.cpp)
  owns `jobs/<identity>/request.json`, staged `content`, progress/failure records
  and `reviews/<content hash>`, with cancellation/cleanup branches. This is
  upstream-owned data under the selected configuration directory, not a new
  Portcove import API or permission to delete players' mod data.
- **ModWorker containment intent:**
  [legacy_mod_process.cpp](https://github.com/ThatGuyMcd/DKR-R/blob/8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6/runtime-recomp/src/game/mods/legacy_mod_process.cpp)
  requires absolute executable/request paths and a positive timeout. Windows
  creates a suspended child assigned to a kill-on-close, one-active-process job
  with memory/CPU limits. Linux sets parent-death/resource/no-new-privileges
  controls, starts a process group and has kill/reap branches. These are
  inspected implementation intentions, not observed containment, parent-loss,
  cancellation or cleanup results. They do not replace #141's custody/lifetime
  disposition or authorize native sessions.

The Windows `online.1` package-root spelling differs from the outer beta12
asset/tag. Linux places helpers in `usr/libexec/dkr-r`; source resolver candidates
explain those coordinates but do not prove the mounted AppImage paths at runtime.
CMake names InputHost/ModWorker consistently with the retained package receipt.
No helper is selected by basename alone for acceptance.

## Linux constraints

Reuse the checkpoint's ELF64/x86-64 type-2 AppImage, `AppRun -> usr/bin/DKR-R`,
ZSTD SquashFS listing and exact three decoded member hashes. Only those selected
ELF members were decoded/inspected; no full filesystem verification is added.

The selected ELF requirements include `GLIBC_2.38` and `GLIBCXX_3.4.32`.
Main `DT_NEEDED` names SDL2, GTK3/GDK3, GObject/GLib, libstdc++, libm, libgcc,
libc and the loader; InputHost additionally names SDL3. An AppImage container
alone does not prove resolution of those libraries/versioned symbols, its
loader, graphics stack, display, mounting support or helper paths on a target
host. The complete effective bundled-versus-host dependency resolution and
minimum-host compatibility are **Unknown**. No dependency installation,
security approval, distro floor, Steam Deck support or successful Linux launch
is inferred. Portcove's separate GTK/GLib safety holds remain unchanged.

The accepted Linux executable hint names exactly the 1.0.4 AppImage and cannot
resolve the beta12 filename. Any later unsigned proposal must preserve that
mapping and give beta12 its own exact selection; no wildcard/renaming continuity
or automatic compatibility is established here.

## Version-bound configuration and save comparison

The common inspected `README.md`, `runtime_platform.cpp`, InputHost/client,
`runtime_save_routing.cpp` and `dkr_save_codec.cpp/.hpp` blobs are byte-identical.
`game_main.cpp`, `save_manager.cpp` and CMake differ. Equality is source-local:
submodules, compile flags, package resources and runtime transitions were not
proved equivalent.

| Subject                | Static result                                                                                                                                                                                                                                                                                                                                                         | Acceptance boundary                                                                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit source/config | Both main sources parse `--rom` and `--config`; explicit config bypasses defaults. Retain `--rom dkr-us-v80.z64 --config dkr-runtime-data`, resolved from Portcove's install-root working directory.                                                                                                                                                                  | Materialized ROM identity, package-root placement and actual runtime writes still need exact candidate evidence.                                                                                                                                                                                                 |
| Configuration/input    | Both configure Paks, saves and input using the selected config directory. `runtime_platform.cpp` is identical.                                                                                                                                                                                                                                                        | This does not compare every UI/graphics/network config serializer or prove old configuration migration. `imgui.ini` ownership remains the accepted Portcove contract, not a new upstream write observation.                                                                                                      |
| Ordinary saves         | Both use `config/saves/dkr.us.v77.bin`, controller Paks `config/controller-pak-<1..4>.mpk`, and `config/save-backups`. Codec/routing source equality is established.                                                                                                                                                                                                  | No saved-data round trip, binary compatibility, active/canonical synchronization or lifecycle witness.                                                                                                                                                                                                           |
| Online saves           | Both name host `config/saves/online/host/dkr.us.v77.bin` and per-match `config/saves/online/sessions/<16-digit hex match>/dkr.us.v77.bin`.                                                                                                                                                                                                                            | beta12 stages the validated host seed in memory instead of writing during lobby creation. At actual host save activation it preserves differing prior bytes as `.previous-session`, writes atomically and verifies readback. Changed commit timing requires its own persistence/cancellation/restart assessment. |
| Mod-session saves      | beta12 [legacy_mod_launch.cpp](https://github.com/ThatGuyMcd/DKR-R/blob/8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6/runtime-recomp/src/game/mods/legacy_mod_launch.cpp#L78) derives a sorted content/session fingerprint and uses `config/saves/mods/<fingerprint>/dkr.us.v77.bin` and `paks`. A missing mod save is seeded from a valid stock save or blank codec data. | New source-visible namespace, not observed preservation or permission for managed mod migration/deletion. Retain stock/mod/online distinctions.                                                                                                                                                                  |

The online change above is the complete observed `save_manager.cpp` diff for
these two commits. The source comparison therefore supports ordinary path/codec
continuity and identifies a changed online commit boundary; it does not accept
all beta12 saves or carry the 1.0.4 lifecycle qualification forward.

## Unsigned proposal disposition and remaining acceptance

Keep accepted 1.0.4 and its actual qualifications unchanged. Static classification
supports a **version-bound unsigned proposal only**. The extra ModWorker,
InputHost resolution/lifetime, Linux filename and dependency requirements,
mod save namespaces and changed online commit timing prevent claiming ordinary
compatible progression from this research alone.

Before beta12 admission, retain the existing packet's exact helper/immutable-file
trust and environmental resolution, materialized source identity, actual normal
close/supervisor lifetime, application-coordinate persistence and each offered
update/rollback/removal/recovery obligation. Config migration and online/mod save
compatibility remain unknown. Linux's retained 0x0 display/recovery failures
remain preserved; a future success claim needs its own healthy session.
Protected #246 acceptance and authenticated unchanged-client delivery are
separate; #534 exclusively owns production authority. This receipt creates no
catalog/channel/support/maintenance-policy change or new update framework.

Native, helper/game/upstream execution, installation, runtime test/self-test,
physical/controller/human/gameplay and production checks: **Not run**.
No artwork, health request-cap, credentials, host policy or held resource changed.
Whole #54/#254/#1422 remains open.

## Complete selected source read inventory

B12 = `8a8e927e9ea14c5c07ca7ad74b44fdbe077f5ff6`;
104 = `b0156864562100ce3453ce4b72ba15c8e3125376`.
The manifest records every source blob read for this finite classification.
Hashes attest retrieved source bytes, not compiled artifact provenance.

| Version | Source path                                                 |  Bytes | Git blob SHA-1                             | SHA-256                                                            |
| ------- | ----------------------------------------------------------- | -----: | ------------------------------------------ | ------------------------------------------------------------------ |
| B12     | `runtime-recomp/src/game/runtime_platform.cpp`              | 125379 | `58fdffe5656a609f421dd68c4cbcab316700113c` | `921f8713f9053680d987aa93b7cbe87609e4ce7c1e8306f75f6b76ff6e9ddd5f` |
| B12     | `runtime-recomp/src/game/dkr_save_codec.cpp`                |  20025 | `636d66fe03b25358f317838d3827936673b9dba8` | `ea67640b6baf2a39c49976b13e6c23944d46c5b96d590d5d36367c97679f7168` |
| B12     | `runtime-recomp/src/game/dkr_save_codec.hpp`                |   3566 | `06f5bf74f92d3f0edca3874575385e1daad8a782` | `8d858dda54deee76eac6fe9cf154b4343d06a9e95aa5573dab0fed773c50d18d` |
| B12     | `README.md`                                                 |   7966 | `e649ab69f9d5179486acddbad325726153012d34` | `1a7562e2705bf9ef5f02bbf408303aed1043442ce0b0e0b839ff1f8fa3b83a8b` |
| B12     | `runtime-recomp/CMakeLists.txt`                             |  67711 | `3dd6d639aa40b28f916dd4ce477936ce60eab24e` | `c53f460fdf1291e5fa5c08b9f25b5e10346dc8783d17d29e79505e8967bb0450` |
| B12     | `runtime-recomp/src/game/game_main.cpp`                     |  45955 | `12047061a64acdae2e03b883bef658e5788fd490` | `be42c3e7c74fd92420b5105ca50201a0cfb55867655fd226e1a54ee45919cf80` |
| B12     | `runtime-recomp/src/game/runtime_save_routing.cpp`          |   2924 | `23204082465e5c7149e06b061093eff682cfaa91` | `dc17ee1310c1c04340503b5c858d69d4ad3445620df0c33bcfc742bee40de7a2` |
| B12     | `runtime-recomp/src/game/save_manager.cpp`                  |  36414 | `d2b8b32b8f3493019dfdaf94c9f0f3b86fdeaa96` | `4c84c333ed8dd37012f347f1e058faab8cea4597a0db3c9684318d15a99a839d` |
| B12     | `runtime-recomp/src/game/sdl3_input_client.cpp`             |  18340 | `f1b1c0625950491704edbe93d1a805f28f5d6b55` | `ec144ed3d938add32b9f02b5370a11dfb2bf89ecd9b5f941fac62d3c6f6ae5f1` |
| B12     | `runtime-recomp/src/input/sdl3_input_host.cpp`              |  33983 | `019c2e8835abf10d4d2ffee3d8d0022fbc3233bf` | `b684b224f3819ab18542f35ab0950e0cfba61d1c3eeaa088a17a6363e381dfa5` |
| B12     | `runtime-recomp/cmake/LegacyMods.cmake`                     |   9024 | `63c63dd591b695a31480cdfe397eaa5031aa30c2` | `867040732a075d3e60de5cbb887fc868a2b00910ce98344899a53d042b1fc555` |
| B12     | `runtime-recomp/src/game/runtime_ui.cpp`                    | 562390 | `2e7b0838430e35c87cb8cce0cded8891f5f11198` | `b7cfdcdce48c5d95031cf12bc212459c1de5316d04756ca92ef55a201d7e008a` |
| B12     | `runtime-recomp/src/game/mods/legacy_import_library.cpp`    |  14956 | `ea88dbc4a6acbd7468c710bbbbd929f903443d26` | `8451c7bfb8ca2cb3e41727411f95a158596d46dce3d3de6b3b1b84a4f0df1ff1` |
| B12     | `runtime-recomp/src/game/mods/legacy_track_prepare_job.cpp` |  10427 | `1a1a202aab61ef0467258cbf81d79068ee1a4b82` | `ccb460773988d5a82fafc0348d473286ba639f1d9b54cc9399f7ac35f9986905` |
| B12     | `runtime-recomp/src/game/mods/legacy_mod_worker.cpp`        |   3676 | `7acc9af84334d45e040cd7d5a7bd846408a71557` | `126d840e3ce0de9b6cc9ab9bfc473cd0ab4435a8051e7cd423d6b8b3b96594a5` |
| B12     | `runtime-recomp/src/game/mods/legacy_mod_process.cpp`       |   6306 | `cb85649784a8104cc39afca43a5c41d9eae10577` | `80cf60ed18600ae9306643e92df8eace8d4cf4c1f3f01520dbbcf92400dfb716` |
| B12     | `runtime-recomp/src/game/mods/legacy_mod_launch.cpp`        |   8211 | `ade2b247ade03b854ce6faabba903e289de965e4` | `53069a31f227d7221915766e8c342a60df03efd8161973fa504be1b5829e68e2` |
| B12     | `runtime-recomp/src/game/mods/legacy_mod_import.cpp`        |   5672 | `81c99395ec42d7d1680de29834493c9d6e4211fc` | `e0cf21c6cea5db352a042e0d4f30d1bae4f19dffd233925a03ecb149067da384` |
| B12     | `runtime-recomp/src/game/mods/legacy_mod_stage.cpp`         |   7542 | `0ebc28cb6ed670e470f274e4faccaa7fdf742922` | `0fe7a1ec56a88f3b4488cb7b719869624680876b6b4b847d61b46d2cfa374bdc` |
| 104     | `runtime-recomp/src/game/runtime_platform.cpp`              | 125379 | `58fdffe5656a609f421dd68c4cbcab316700113c` | `921f8713f9053680d987aa93b7cbe87609e4ce7c1e8306f75f6b76ff6e9ddd5f` |
| 104     | `runtime-recomp/src/game/dkr_save_codec.cpp`                |  20025 | `636d66fe03b25358f317838d3827936673b9dba8` | `ea67640b6baf2a39c49976b13e6c23944d46c5b96d590d5d36367c97679f7168` |
| 104     | `runtime-recomp/src/game/dkr_save_codec.hpp`                |   3566 | `06f5bf74f92d3f0edca3874575385e1daad8a782` | `8d858dda54deee76eac6fe9cf154b4343d06a9e95aa5573dab0fed773c50d18d` |
| 104     | `README.md`                                                 |   7966 | `e649ab69f9d5179486acddbad325726153012d34` | `1a7562e2705bf9ef5f02bbf408303aed1043442ce0b0e0b839ff1f8fa3b83a8b` |
| 104     | `runtime-recomp/CMakeLists.txt`                             |  51004 | `9c0c69782c3b6e02f00910b9110615691d20deef` | `7c56bb1567c5d39db955235162f27763bb0b207c9930b82f00f87736dfe19e53` |
| 104     | `runtime-recomp/src/game/game_main.cpp`                     |  41848 | `7ed17ce2fb9a08c4876ee765f8932a20ef517e5c` | `4e0bcd9572946451c1a0a49772186bdd42754b85e4dc7ef1279769293a541044` |
| 104     | `runtime-recomp/src/game/runtime_save_routing.cpp`          |   2924 | `23204082465e5c7149e06b061093eff682cfaa91` | `dc17ee1310c1c04340503b5c858d69d4ad3445620df0c33bcfc742bee40de7a2` |
| 104     | `runtime-recomp/src/game/save_manager.cpp`                  |  35692 | `373f39e159827c225b07207975bd81e9cc87652a` | `83d5689077b0e2a0fe107c2f09c1f6e4fa74faae59087d012d9f7fd99f30f276` |
| 104     | `runtime-recomp/src/game/sdl3_input_client.cpp`             |  18340 | `f1b1c0625950491704edbe93d1a805f28f5d6b55` | `ec144ed3d938add32b9f02b5370a11dfb2bf89ecd9b5f941fac62d3c6f6ae5f1` |
| 104     | `runtime-recomp/src/input/sdl3_input_host.cpp`              |  33983 | `019c2e8835abf10d4d2ffee3d8d0022fbc3233bf` | `b684b224f3819ab18542f35ab0950e0cfba61d1c3eeaa088a17a6363e381dfa5` |
