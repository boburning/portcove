# PSXRecomp d5cae379: 29 managed PS1 routes move to their newest kits

Dated evidence from November 13, 2026, under #2926. Thirty managed Windows and
Linux x86-64 PS1 routes had a newer kit tag. Twenty-nine of those kits pin
PSXRecomp `d5cae379db84bbce3696a61a89ed06989b18bed0` and pass every check, so
their game and BIOS source contracts now also apply to them. MediEvil v0.1.5
pins `031868cc` and stays bound to v0.1.4 (below). No upstream program, script
or build was executed. Kits were read with Python `zipfile`, and their text
members were read as data.

Rival Schools (renamed player, needs a provider observation) and Incredible
Crisis (pins the unreviewed `de7ad680`) are out of scope.

## Framework review: d5cae379 against 7192402

This is a static `git diff` of the two framework trees, fetched by SHA. No CMake
or build was run. `d5cae379` is `refs/heads/pin/pin-i-v0.1.20` by
`git ls-remote`. It dates from 2026-11-12 13:26 +0200, and `7192402` from
01:07 the same day.

**Verdict:** for Portcove, `d5cae379` runs the same as the reviewed `7192402`
([builder downloads record](psxrecomp-7192402-builder-downloads-2026-11-13.md),
[texture-pack scope](psxrecomp-texture-pack-scope-2026-11-13.md)).

The diff touches 7 files, with 364 insertions and 1 deletion:

- `runtime/CMakeLists.txt`
- `runtime/src/gpu.c`
- `runtime/src/gpu_gl_renderer.c`
- `runtime/src/gpu_thin_tri.h` (new)
- `runtime/tests/gpu_exec_stubs.inc`
- `runtime/tests/test_depth24_copy_exec.c` (new)
- `runtime/tests/test_gpu_thin_tri.c` (new)

These have no diff: `psxrecomp_cli.py`, `tools/` (including
`release_stage.py`), `recompiler/`, `host/` and `runtime/runtime.cmake`.

The product changes are:

1. **Depth24 FMV rows:** `runtime/src/gpu.c:3796-3810` adds
   `depth24_note_copy`. The GP0(80h) VRAM-to-VRAM copy at `gpu.c:7913` calls
   it. It marks the copied rows' 24-bit movie coverage in memory
   (`s_d24_rows`), so FMV rows no longer show black (PS1G-163). It does no I/O
   and reads no environment or configuration.
2. **Thin triangles above 1x:** this adds `runtime/src/gpu_thin_tri.h`, a
   header-only `static inline`. It is used at
   `runtime/src/gpu_gl_renderer.c:4902-4903, 5567-5570, 5588-5593`. Above 1x
   internal scale (`s_out_scale > 1`, `gpu_gl_renderer.c:528`), it draws a
   complement triangle for one-pixel half-quad strips (PS1G-161). It is pure
   rasterization, with no I/O, setting or environment variable, and native
   resolution is unchanged. Both files were already linked into the player
   (`runtime/runtime.cmake:392, 402`).
3. **Test-only CMake:** `runtime/CMakeLists.txt:1930-1947, 3009-3012` adds two
   `add_test` executables inside `if(BUILD_TESTING)` (`runtime/CMakeLists.txt:25`).
   The test stubs are at `runtime/tests/gpu_exec_stubs.inc:170-175`.
   `runtime.cmake`, which builds the player, does not include this file.

Nothing else Portcove depends on changed:

- **Build CLI:** the arguments Core passes are unchanged. They are `generate …
  --disc … --no-toolchain-download [--bios]` (`crates/portcove-core/src/psx.rs:1505-1519`)
  and `rebuild --config --project-root --build-dir --target psx-runtime …`
  (`psx.rs:1522-1550`).
- **Network:** the overlay-toolchain staging is unchanged. Core's proxy
  refusal and `require_no_fetched_overlay_toolchain` cover it as before
  (`psx.rs:708, 1724-1745`).
- **Staging:** `build-portcove` staging, `EXE_NAME` and `WINDOW_TITLE`
  derivation, and the `mods/bundled`, `preloaded`, `packages`, `installed` and
  `texture-packs` handling are unchanged.
- **Writers, inputs and launch:**
  - The new code has no file, directory or environment access.
  - `config_loader.cpp`, the BIOS and disc code, and the `game.toml` schema
    are unchanged, so `rewrite_game_discs` and `config_disc_field`
    (`psx.rs:757, 1244`) still apply.
  - `main.cpp` and the `settings.toml` `[disc]` semantics are unchanged.
- **Platforms:** the only platform branches are in the test-only CMake.

The review lists these unknowns:

- **Ancestry:** with a depth-1 fetch, it is not shown that `d5cae379`
  descends directly from `7192402`. The review compares the trees.
- **Rendering:** above 1x, frames may differ from `7192402`. That is the
  intended fix. No screenshots above 1x and no depth24 FMV are carried over as
  observed.
- **Kits:** the kit trees were outside the review. The per-route check below
  covers them.
- **recomp-ui `14799da`:** taken as unchanged and not fetched again.

## Method

For each route, both managed kits (Windows and Linux x64) of the newest tag by
`git ls-remote` were downloaded from the release download URL, one at a time.
None of these routes manages a Mac kit. The release API is blocked by this
session's proxy, so the provider digest was not read. Each kit was checked for
these:

- **Download:** its SHA-256 equals that tag's `SHA256SUMS.txt`.
- **Pins:** `framework_pins.txt` and `project-manifest.toml` pin the stated
  PSXRecomp commit and recomp-ui `14799da234db1436306636b64436233a3ec6885c`.
- **Disc:** the `game.toml` matches the route's source profile, for the
  serials (`disc_serials`), the data-track SHA-1 (`known_sha1`), the track
  count (`required_tracks` and `catalog_identity.json`) and the `disc` and
  `discs` form. It is identical on both platforms and to the repository file
  at the tag.
- **BIOS:** `bios_config`, `openbios = false`, the project manifest's
  `[bios]` and the README-SETUP BIOS SHA-256 all match the route's BIOS
  profile.
- **Player:** `EXE_NAME` (or else `WINDOW_TITLE`) gives the catalog
  executable, and the setup host of that name sits at the top level.
- **Layout:** the split layout, with build-staged `mods/bundled`, no file
  under `mods/packages`, and only empty `mods/texture-packs/<serial>`
  folders. There are no links, no absolute, `..` or backslash entries, and no
  case-colliding paths. The top-level entries and the `mods/` and
  `psxrecomp/bios/` entries are the same as in the bound kit.

Each kit's `game.toml`, `CMakeLists.txt` and file listing was compared with
the bound tag:

- **Text files:** `game.toml`, `CMakeLists.txt`, `framework_pins.txt` and
  `project-manifest.toml` were read from raw.githubusercontent.com at both
  tags.
- **Bound kits:** their SHA-256 equals the current applicability. Their
  listings come from the earlier static checks for 26 routes, compared by
  name and size. For Final Fantasy VIII, Final Fantasy IX, Galerians and
  MediEvil, the bound kits were downloaded again and compared by name, size
  and CRC-32.

## Results

| Route                            | Tags            | Commit     | Windows bytes, SHA-256  | Linux bytes, SHA-256    | Player                              | Result      |
| -------------------------------- | --------------- | ---------- | ----------------------- | ----------------------- | ----------------------------------- | ----------- |
| armored-core-master-of-arena     | v0.1.1 → v0.1.2 | `2a3f5007` | 47,709,806, `33dba866…` | 45,602,757, `02f04524…` | `Armored_Core_Master_of_Arena`      | requalified |
| armored-core-project-phantasma   | v0.1.1 → v0.1.2 | `c76bd728` | 47,709,358, `329a9319…` | 45,602,306, `1576bee1…` | `Armored_Core_Project_Phantasma`    | requalified |
| azure-dreams                     | v0.1.1 → v0.1.2 | `e9a36eb1` | 47,713,645, `e15edb6e…` | 45,601,925, `12cf9986…` | `Azure_Dreams`                      | requalified |
| bushido-blade-2                  | v0.1.1 → v0.1.2 | `e4428ff3` | 47,711,787, `dfb8bd70…` | 45,603,786, `03858d80…` | `Bushido_Blade_2`                   | requalified |
| colony-wars-red-sun              | v0.1.1 → v0.1.2 | `31425b31` | 47,714,058, `8120a4ad…` | 45,605,729, `ede75291…` | `Colony_Wars_Red_Sun`               | requalified |
| destruction-derby-raw            | v0.1.1 → v0.1.2 | `5c84705d` | 47,715,568, `b7831771…` | 45,606,194, `20340fb1…` | `Destruction_Derby_Raw`             | requalified |
| digimon-world-2                  | v0.1.1 → v0.1.2 | `494909c0` | 47,710,200, `18c1d34f…` | 45,602,295, `ef94c339…` | `Digimon_World_2`                   | requalified |
| dino-crisis-2                    | v0.1.2 → v0.1.3 | `329574ec` | 47,815,502, `c92149a8…` | 45,747,818, `5a7e4fda…` | `Dino_Crisis_2_Recompiled`          | requalified |
| dino-crisis                      | v0.1.2 → v0.1.3 | `26724cf3` | 47,815,637, `ab92a941…` | 45,749,066, `6e96b55e…` | `Dino_Crisis_Recompiled`            | requalified |
| dragon-ball-z-ultimate-battle-22 | v0.1.1 → v0.1.2 | `d0a0adf1` | 47,709,107, `a391e353…` | 45,600,595, `b03e45a7…` | `Dragon_Ball_Z_Ultimate_Battle_22`  | requalified |
| fear-effect-2-retro-helix        | v0.1.1 → v0.1.2 | `a8c645b4` | 47,712,917, `5070244d…` | 45,603,623, `a6ad25e1…` | `Fear_Effect_2_Retro_Helix`         | requalified |
| final-fantasy-ix                 | v0.1.2 → v0.1.3 | `abad1d19` | 47,817,076, `d09e74ae…` | 45,750,497, `5abb4b6c…` | `Final_Fantasy_IX_Recompiled`       | requalified |
| final-fantasy-viii               | v0.1.2 → v0.1.3 | `e19c312d` | 47,816,792, `e463c6a2…` | 45,750,192, `db4d818b…` | `Final_Fantasy_VIII_Recompiled`     | requalified |
| future-cop-lapd                  | v0.1.1 → v0.1.2 | `ca7e40c6` | 47,716,170, `3be1f7d5…` | 45,602,831, `af4ba463…` | `Future_Cop_LAPD`                   | requalified |
| g-police-weapons-of-justice      | v0.1.1 → v0.1.2 | `c6a8d4f8` | 47,709,941, `d71b0847…` | 45,602,972, `4b9fe1da…` | `G_Police_Weapons_of_Justice`       | requalified |
| galerians                        | v0.1.1 → v0.1.2 | `232e6dfc` | 47,711,960, `17f5b75f…` | 45,603,063, `5146dc24…` | `Galerians`                         | requalified |
| jade-cocoon                      | v0.1.1 → v0.1.2 | `a575f6c0` | 47,711,455, `41277256…` | 45,603,318, `545611d5…` | `Jade_Cocoon_Story_of_the_Tamamayu` | requalified |
| kartia                           | v0.1.1 → v0.1.2 | `2f840044` | 47,710,593, `4d1a50a6…` | 45,602,821, `13ee1d0f…` | `Kartia_The_Word_of_Fate`           | requalified |
| medievil                         | v0.1.4 → v0.1.5 | `24d3d2db` | 47,782,240, `052e33fe…` | 45,590,347, `ffaaf907…` | `MediEvil_Recompiled`               | unchanged   |
| mega-man-legends-2               | v0.1.1 → v0.1.2 | `62158cfc` | 47,709,779, `bd6273e4…` | 45,601,431, `bfc547ca…` | `Mega_Man_Legends_2`                | requalified |
| misadventures-of-tron-bonne      | v0.1.1 → v0.1.2 | `38bf7369` | 47,708,825, `f5add2eb…` | 45,599,219, `021702d4…` | `The_Misadventures_of_Tron_Bonne`   | requalified |
| mortal-kombat-trilogy            | v0.1.2 → v0.1.3 | `967eac05` | 47,815,547, `7a7c327a…` | 45,747,706, `217aea9a…` | `Mortal_Kombat_Trilogy_Recompiled`  | requalified |
| nightmare-creatures-ii           | v0.1.1 → v0.1.2 | `91db8747` | 47,712,787, `6aac29e7…` | 45,604,672, `d5589436…` | `Nightmare_Creatures_II`            | requalified |
| rollcage-stage-ii                | v0.1.1 → v0.1.2 | `1cd441fa` | 47,708,953, `9d31e699…` | 45,600,865, `0f7a0f1d…` | `Rollcage_Stage_II`                 | requalified |
| silent-bomber                    | v0.1.2 → v0.1.3 | `f9676283` | 47,816,225, `b99b5779…` | 45,750,966, `04ae43b9…` | `Silent_Bomber_Recompiled`          | requalified |
| spider-man-2-enter-electro       | v0.1.1 → v0.1.2 | `df0bcc20` | 47,712,793, `ce5c8ebe…` | 45,605,199, `8aff7f9b…` | `Spider_Man_2_Enter_Electro`        | requalified |
| suikoden-ii                      | v0.1.1 → v0.1.2 | `0c07f647` | 47,711,683, `9cae57b9…` | 45,603,716, `ba7d0507…` | `Suikoden_II`                       | requalified |
| suikoden                         | v0.1.2 → v0.1.3 | `64aea383` | 47,814,636, `71fd74e3…` | 45,748,064, `6d154790…` | `Suikoden_Recompiled`               | requalified |
| tail-concerto                    | v0.1.1 → v0.1.2 | `32576fc1` | 47,711,459, `caca6b16…` | 45,604,072, `9ea83afc…` | `Tail_Concerto`                     | requalified |
| wild-arms                        | v0.1.1 → v0.1.2 | `8fe60ea2` | 47,709,329, `92647f74…` | 45,601,471, `1bcba532…` | `Wild_Arms`                         | requalified |

Route ids are `alexbeav-<route>-recomp`. Commits are the peeled tag commits.

### The 29 requalified routes

Every kit passed every check.

- **Unchanged files:** each route's `game.toml` and `CMakeLists.txt` are
  byte-identical at both tags. Its disc identity, BIOS, player,
  `mods/preloaded` presence and top-level entries therefore carry over
  unchanged. Most titles have 1 track. The others are Destruction Derby Raw
  and Rollcage Stage II with 13, Mortal Kombat Trilogy with 30, and Dino
  Crisis, Dino Crisis 2, Mega Man Legends 2, Nightmare Creatures II, Tail
  Concerto and Tron Bonne with 2. The five multi-disc titles keep their
  rosters in catalog order.
- **Changed files:** only `framework_pins.txt` and the project manifest's
  framework `commit` and `tree` changed.
- **Listings:** against the bound kit, each listing adds exactly the three new
  PSXRecomp files, `runtime/src/gpu_thin_tri.h`,
  `runtime/tests/test_depth24_copy_exec.c` and
  `runtime/tests/test_gpu_thin_tri.c`.
- **Changed sizes:** the setup host and the four changed framework files
  changed size: `runtime/CMakeLists.txt`, `runtime/src/gpu.c`,
  `runtime/src/gpu_gl_renderer.c` and `runtime/tests/gpu_exec_stubs.inc`.
- **CRC check:** where CRC-32 was compared (Final Fantasy VIII and IX,
  Galerians), the prebuilt `psxrecomp/recompiler/build/psxrecomp-game.exe` and
  `psxrecomp-bios.exe` in the Windows kit also differ in content at the same
  size. `recompiler/` source has no diff. The other 26 routes were compared
  by size only, so the same rebuild there is not excluded.

Every kit also ships the framework's `psxrecomp/bios/openbios.bin` and
`OpenBIOS.toml`, as the bound kits did. No `game.toml` selects OpenBIOS. Each
selects the retail `SCPH1001.toml`, or `SCPH5552.toml` for Dragon Ball Z,
Future Cop, Galerians, Mega Man Legends 2, Tron Bonne and Silent Bomber.

Each port's game and BIOS contract now also applies to the two exact kit
digests, appended to the existing applicability. Each port keeps one BIOS
contract. Each route has one new `v0.1.x` static-contract evidence record.

### MediEvil: left on v0.1.4

The v0.1.5 kits pass the listed checks:

- the SHA-256 matches `SHA256SUMS.txt`;
- they pin `031868cc0170d260f1cb81c7cfe7ab68e8bbb424` (runtime-identical to
  `7192402`) and recomp-ui `14799da`;
- `known_sha1[0]` is `928257764f5107c9d27aa3e2d469c43aee591abd` with 2 tracks
  and SCUS-94227;
- they select `SCPH1001.toml` with `openbios = false`;
- they build the player `MediEvil_Recompiled`;
- they use the split layout with no `mods/packages`.

Against the bound v0.1.4 kits (framework `852199db`), these differences
remain:

- **Diagnostics removed:** the kit removes the title's input recorder. The
  `CMakeLists.txt` drops `psxrecomp_add_playtest_diagnostics(… MOD_ID
  "medievil.diagnostics")`, `PRELOADED_MODS_DIR` and `EXCLUDE_BUILTIN_MODS
  psx.enhancement.hd-textures`. These files are gone:
  - `mods/preloaded/packages/medievil.diagnostics`
  - `mods/bundled/medievil.diagnostics`
  - `docs/PLAYTEST_DIAGNOSTICS.md`
  - `replay-diagnostics.py`
  - `mods/README.md`
- **Route copy:** the route's player copy says the default offline recorder
  captures starting memory cards, settings and inputs. Its persistent paths
  include `diagnostics-location.txt`. The
  [managed record](medievil-psx-managed-2026-11-10.md) reviewed that writer.
  The copy no longer describes this kit, and that is a definition change, not
  an applicability append.
- **`game.toml` rewritten:**
  - it adds `disc`, `discs` and `disc_serials`;
  - it renames `bin_name` and `cue_name` to the Redump names;
  - it reorders `known_sizes`, `known_md5` and `known_sha1` so that the split
    data track is first;
  - it adds `known_crc32` and `bios_config`.
- **CMake BIOS stems:** the CMake now forces the `SCPH1001` BIOS stems.
- **Framework jump:** the move from `852199db` to `031868cc` is outside the
  `d5cae379` review.
- **Windows `cache/`:** the Windows kit adds a top-level `cache/SCUS-94227/datashards/`.

The route keeps its v0.1.4 binding. The v0.1.5 kit needs a reviewed definition
and copy update first.

## Release-selection corpus

`crates/portcove-core/src/testdata/windows-archive-release-selection.json`
has cases for 23 of these routes, MediEvil included. Each inventory holds one
provider-observed earlier release (v0.1.0, or v0.1.1 for Mortal Kombat
Trilogy, Silent Bomber and Suikoden, or v0.1.4 for MediEvil) and a synthetic
`999.123.456` successor. The earlier moves to the currently bound kits added
no inventory entries. The new releases' provider data (asset ids, digests,
publication times) was not observed, and the corpus has no pattern for adding
it without that data. The corpus is unchanged.

## Not observed

These were not observed:

- **Builds and gameplay:** native generation, building, launch, gameplay and
  saves.
- **Rendering:** above 1x internal scale or in depth24 FMV.
- **Data lifecycle:** update, rollback or backup with real player data.
- **Provider data:** the provider release digests and asset lists.
- **Out of scope:** the Mac kits and the setup host and prebuilt emitter
  binaries, which were not inspected beyond their listing entries.
- **Portcove inspection:** `portcove catalog inspect-package-layout` was not
  run on these kits.
