# PSXRecomp de7ad680: Incredible Crisis moves to its v0.1.1 kits

Dated evidence from November 13, 2026, under #2926 and #1598. The managed
route `alexbeav-incredible-crisis-recomp` was bound to its v0.1.0 kits, which
pin the split-mods framework `5420458a`. Its newest tag, v0.1.1, pins
PSXRecomp `de7ad680fb0ed292de28ec224015c4208a4899ee`. Both managed v0.1.1 kits
pass every check, so the route's game and BIOS source contracts now also apply
to them. No upstream program, script or build was executed. Kits were read with
Python `zipfile`, and their text members were read as data.

## Framework review: de7ad680 against d5cae379 and 7192402

This is a static `git diff` of the framework trees, fetched by SHA. No CMake or
build was run.

**Ancestry:** the history is linear, verified with a depth-20 fetch and
`git merge-base --is-ancestor`:
`7192402 -> 37dc12d -> d5cae37 -> 37b6dfc -> de7ad68`. The two commits after
`d5cae379` are `37b6dfc` ("dma: keep MADR bits 24-31 zero on register writes")
and `de7ad68` ("dma: stop a gpu list kicked at an address with bit 23 set",
PS1G-159).

**Verdict:** for Portcove's build, staging, player data writers and launch,
`de7ad680` is the same as the reviewed `d5cae379` and `7192402`; only DMA
emulation differs
([builder downloads record](psxrecomp-7192402-builder-downloads-2026-11-13.md),
[texture-pack scope](psxrecomp-texture-pack-scope-2026-11-13.md)). The
`d5cae379` review that covers the GPU changes between `7192402` and `d5cae379`
is in the [d5cae379 requalification record](psxrecomp-d5cae379-requalification-2026-11-13.md)
(#5346), and its findings are repeated here only where this route depends on
them.

Against `d5cae379`, the diff touches 3 files, with 134 insertions and 1
deletion:

- `runtime/CMakeLists.txt`
- `runtime/src/dma.c`
- `runtime/tests/test_dma_madr_mask.c` (new)

Against `7192402`, it touches 9 files with 498 insertions and 2 deletions: the
seven `d5cae379` files plus these three. These have no diff: `psxrecomp_cli.py`,
`tools/` (including `release_stage.py`), `recompiler/`, `host/`,
`runtime/runtime.cmake`, `main.cpp`, `config_loader.cpp` and the `mod_*`
sources.

The product changes are:

1. **MADR mask:** `runtime/src/dma.c:1539-1541`, in `dma_write_register`,
   masks D#_MADR writes to 24 bits on every channel. It changes in-memory
   register state only.
2. **GPU list bus error:** `runtime/src/dma.c:817-827`, in
   `start_async_gpu_linked_list` (`:812`), treats a GPU linked-list kick with
   MADR bit 23 set as a bus error. It clears CHCR bits 24 and 28, sets DICR
   bit 15, re-evaluates the DMA IRQ and returns without reading RAM. It has no
   I/O, environment read or setting.
3. **Test-only CMake:** `runtime/CMakeLists.txt:699-703` adds
   `dma_madr_mask_test` inside `if(BUILD_TESTING)` (`:25`). The player build
   does not include it; `runtime/runtime.cmake:420` already links `dma.c` into
   the player. The test's `setenv`/`_putenv_s` helper is test-only.

Nothing else Portcove depends on changed:

- **Build CLI:** the `generate` and `rebuild` arguments Core passes are
  unchanged, because the CLI has no diff.
- **Network:** the overlay-toolchain staging is unchanged, so Core's proxy
  refusal and `require_no_fetched_overlay_toolchain` cover it as before.
- **Staging:** `build-portcove` staging, `EXE_NAME` and `WINDOW_TITLE`
  derivation, and the `mods/bundled`, `preloaded`, `packages`, `installed` and
  `texture-packs` handling are unchanged.
- **Writers, inputs and launch:** there are no new runtime writers. The
  `7192402` writer inventory and the split-mods persistent and runtime-mutable
  paths apply unchanged. The `game.toml`, BIOS and disc schema, the launch
  flags, `PSX_OVERLAY_CAPTURES` and the `settings.toml` `[disc]` semantics are
  unchanged.
- **Platforms:** the new product code has no platform branch. The only
  `_WIN32` branch and the `-flto`/`-fwhole-program` options are in the test
  target.

The review lists these unknowns:

- **Behavior:** there was no native run. The DMA change is meant to fix
  Incredible Crisis's title list walk (PS1G-159). It could change timing or
  IRQ behavior for a title that writes MADR bits 24-31. That is emulation
  correctness, not a Portcove contract. No observed evidence on `7192402` or
  `d5cae379` is carried over as observed on `de7ad680`.
- **Other pins:** recomp-ui `14799da` is the same commit as in the `d5cae379`
  kits. recomp-net `e5305930` and retcomm-rbengine `b29bdde6` were not
  reviewed as source. Their trees under `psxrecomp/lib/` match the reviewed
  `d5cae379` kits by name, size and CRC-32, as does the `recomp-ui/` tree.
- **Prebuilt emitters:** managed generation runs the kit's packaged
  `psxrecomp-game` and `psxrecomp-bios` emitters. In the Windows kit both
  differ in content from the `d5cae379` kits at the same size, while
  `recompiler/` source has no diff. In the Linux kit they match. That rebuild
  was not examined. The route binds the exact kit SHA-256, so only the
  reviewed kit bytes are admitted.

## Method

Both managed kits (Windows and Linux x64) of v0.1.1 and of the bound v0.1.0
were downloaded from the release download URL, one at a time, inspected and
deleted. The route manages no Mac kit. The release API is blocked by this
session's proxy, so the provider digest was not read. Each v0.1.1 kit was
checked for these:

- **Download:** its SHA-256 equals the tag's `SHA256SUMS.txt`.
- **Pins:** `framework_pins.txt` and `project-manifest.toml` pin PSXRecomp
  `de7ad680` (tree `23723233`) and recomp-ui
  `14799da234db1436306636b64436233a3ec6885c`.
- **Disc:** the `game.toml` matches the route's source profile
  `alexbeav-incredible-crisis-recomp-usa-psx`: serial `SLUS-01225` (`id` and
  `disc_serials`), first data track SHA-1
  `024fc3ec2309809406b2663b753bf5c4f505cd5b` (`known_sha1`, also
  `catalog_identity.json`), 1 track (`required_tracks` and
  `catalog_identity.json`), and a single `disc` with a one-entry `discs`
  roster. It is byte-identical on both platforms and to the repository file at
  the tag.
- **BIOS:** `bios_config = "psxrecomp/bios/SCPH1001.toml"`,
  `openbios = false` and `bios_hle = false`. The project manifest's `[bios]`
  and README-SETUP.txt require SCPH-1001 (USA), 524288 bytes, SHA-256
  `71af94d1e47a68c11e8fdb9f8368040601514a42a5a399cda48c7d3bff1e99d3`, which
  is the `psx-scph-1001-bios` profile. Core's `kit_bios_profile`
  (`crates/portcove-core/src/psx.rs:308-323`) maps the `SCPH1001` stem to
  `psx-scph-1001-bios`, the route's `bios_source_profile`.
- **Player:** the CMake `EXE_NAME "Incredible_Crisis"` gives the catalog
  executable, and the setup host of that name (`.exe` on Windows) sits at the
  top level.
- **Layout:** the `split-mods` authoring form. The kit ships `mods/bundled`
  and `mods/preloaded`, no file under `mods/packages`, and only the empty
  `mods/texture-packs/SLUS-01225/{dumps,replacements}` folders. There are no
  links, no absolute, `..` or backslash entries, and no case-colliding paths.

## Results

| Platform    | Tag    | Bytes      | SHA-256 (matches `SHA256SUMS.txt`)                                 | Player                  | Result      |
| ----------- | ------ | ---------- | ------------------------------------------------------------------ | ----------------------- | ----------- |
| Windows x64 | v0.1.1 | 47,713,535 | `f0c5a8cd63560042c55c625f2ccbb5d656a99a3f500849ed812624fc29a73e2e` | `Incredible_Crisis.exe` | requalified |
| Linux x64   | v0.1.1 | 45,604,822 | `aa5fafafeec54ee7123dff0f12966fad88e4716883841350d62129cde6c35803` | `Incredible_Crisis`     | requalified |
| Windows x64 | v0.1.0 | 27,058,998 | `b275b575c8d944d5435f6433d3521cebe7cfe4dbb5b7150d23743fdcd9512172` | `Incredible_Crisis.exe` | bound       |
| Linux x64   | v0.1.0 | 24,984,363 | `fb52b31647ef0863056b2d1d45822e067f2f62a4d8325a647b9c477596707f84` | `Incredible_Crisis`     | bound       |

The v0.1.1 tag peels to `a9544abf52896804174ce35c26e2f6591d6e9294`. Each kit
has 3,789 (Windows) or 3,786 (Linux) entries. The game and BIOS contracts now
also apply to the two v0.1.1 digests, appended after the v0.1.0 pair. The port
keeps one BIOS contract. The new evidence record is
`alexbeav-incredible-crisis-recomp-v011-static-contract`.

## Comparison with v0.1.0

`game.toml`, `CMakeLists.txt`, `framework_pins.txt` and
`project-manifest.toml` were read from raw.githubusercontent.com at both tags.
The kit copies of `game.toml`, `CMakeLists.txt`, `framework_pins.txt` and
`catalog_identity.json` equal the tag files. The kit's `project-manifest.toml`
differs from the tag file only in its `[release] version` (`0.1.1` in the kit,
`0.1.0` in the repository).

- **`game.toml`:** it adds only
  `discs = ["disc/Incredible Crisis (USA).cue"]`,
  `disc_serials = ["SLUS-01225"]` and `bios_hle = false`. The serial, data
  track digests, track count, `bios_config` and `openbios` are unchanged.
- **`CMakeLists.txt`:** it adds only
  `PSXRECOMP_BIOS_STEM "SCPH1001"` and
  `PSXRECOMP_BIOS_PROFILE ".../bios/SCPH1001.toml"` as forced cache entries.
  `EXE_NAME`, `WINDOW_TITLE` and the preloaded-mods wiring are unchanged.
- **Manifest and pins:** the framework moves from `5420458a` (recomp-ui
  `ff92028e`) to `de7ad680` (recomp-ui `14799da2`), and the manifest gains a
  `[bios]` table with the SCPH-1001 digest above. README-SETUP.txt and
  README.md now state that digest, and README-SETUP.txt says the diagnostic
  product is built only on request.
- **Precedent:** Jade Cocoon's reviewed move from v0.1.0 (`5420458a`) to
  v0.1.1 (`7192402`) made the same three `game.toml` additions and the same
  two `CMakeLists.txt` lines.

The file listings were compared by name, size and CRC-32:

- **Framework jump:** the `psxrecomp/` and `recomp-ui/` trees change from
  `5420458a` to `de7ad680`, as the reviewed `7192402` split-mods kits did.
  Against the reviewed `d5cae379` kits (Jade Cocoon v0.1.2), the `psxrecomp/`
  list adds only `runtime/tests/test_dma_madr_mask.c` and changes only
  `runtime/CMakeLists.txt` and `runtime/src/dma.c`, plus the Windows prebuilt
  emitters noted above. The `recomp-ui/` lists are identical.
- **New entries:** `mods/texture-packs/SLUS-01225/{dumps,replacements}`
  (empty, already declared by the split-mods paths), seven more
  `mods/bundled/<id>/1.0.0/manifest.toml` defaults, the
  `psxrecomp/bios/SCPH5500.toml`, `SCPH5501.toml` and `SCPH7000.toml` profiles,
  and, in the Windows kit only, an empty top-level `cache/SLUS-01225/datashards/`.
  `cache` is a declared runtime-mutable path, and the reviewed `d5cae379`
  Windows kits ship the same empty folder.
- **Changed by content:** the setup host, the three bundled-mod manifests
  already present, the readmes, `LICENSE`, `THIRD_PARTY_NOTICES.md`,
  `VERSION`, `psx_game_version.txt` and the files above.
- **Unchanged:** the top-level entries other than the Windows `cache/`, and
  `mods/preloaded`. Apart from the player name and texture-pack serial, the
  top-level, `mods/` and `psxrecomp/bios/` entries match the reviewed
  `d5cae379` kits. Neither version ships `psxrecomp/bios/openbios.bin`.

## Release-selection corpus

`crates/portcove-core/src/testdata/windows-archive-release-selection.json`
holds the provider-observed v0.1.0 release and a synthetic `999.123.456`
successor for this route. The v0.1.1 provider data (asset ids, digests,
publication times) was not observed, so the corpus is unchanged.

## Not observed

These were not observed:

- **Builds and gameplay:** native generation, building, launch, gameplay and
  saves, including the PS1G-159 title list walk the DMA change targets.
- **Data lifecycle:** update from v0.1.0, rollback or backup with real player
  data.
- **Provider data:** the provider release digests and asset lists.
- **Out of scope:** the Mac kits, the setup host binary beyond its listing
  entry, and the recomp-net and retcomm-rbengine source. The prebuilt emitters are listed
  under the review's unknowns above.
- **Portcove inspection:** `portcove catalog inspect-package-layout` was not
  run on these kits.
