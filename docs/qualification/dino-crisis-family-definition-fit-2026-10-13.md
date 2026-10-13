# Dino Crisis family definition fit — 2026-10-13

Static Windows admission evidence for [Dino Crisis 2 #444](https://github.com/boburning/portcove/issues/444) and [Dino Crisis #445](https://github.com/boburning/portcove/issues/445), within the frozen [#1422](https://github.com/boburning/portcove/issues/1422) cohort and Required [#254](https://github.com/boburning/portcove/issues/254) authoring work. These are distinct repositories sharing the implemented `psx-recomp-managed` adapter, not distinct games sharing one repository. Both remain Cataloged; no tested-platform or runtime qualification is inherited.

## Exact independent packages

Each direct repository's complete release collection contains v0.1.0 and v0.1.1. The selected v0.1.1 release independently offers one Windows x86-64 setup ZIP. Actual downloaded sizes and SHA-256 match GitHub's published asset facts.

| Title         | Repository                                 | Release ID |  Asset ID |    Bytes | SHA-256                                                            |
| ------------- | ------------------------------------------ | ---------: | --------: | -------: | ------------------------------------------------------------------ |
| Dino Crisis   | `alexbeavs-ps1-ports/dino-crisis-recomp`   |  399976421 | 600756803 | 26206145 | `8ef30ffe192343ef4e3c00de993b1ddf99deb106f65bf35f1689fccd4f7996a7` |
| Dino Crisis 2 | `alexbeavs-ps1-ports/dino-crisis-2-recomp` |  399976888 | 600758315 | 26205977 | `ce9d77b3d35254ba31b7cd1c3deef58adacde211fc399842e57fff9b78b56283` |

Immutable title sources: [Dino Crisis `7fd9deaa`](https://github.com/alexbeavs-ps1-ports/dino-crisis-recomp/blob/7fd9deaa0ef7f8b689b1092821c19ac6a0de87db/game.toml), [Dino Crisis 2 `38514024`](https://github.com/alexbeavs-ps1-ports/dino-crisis-2-recomp/blob/38514024f3a7cea54ff05ae3afdad0929920cb5a/game.toml). Archive root `VERSION`, `psx_game_version.txt`, project manifest and setup README all identify 0.1.1; the older general README's 0.1.0 date is historical.

Each ZIP has 2144 entries, expanded 67,100,866 / 67,100,396 bytes respectively. Static inventory found no unsafe relative paths, case collisions, symlinks or encrypted members. The root setup executables are PE AMD64. They are not observed generated games. No disc images, retail BIOS or generated retail C is bundled. Fixed named source members were read as inert bytes; no upstream executable, Python, CMake or other source ran.

The two kits pin framework `a839474e2941cdc44488ace4d53584e6a485ea41` and UI `be8ac1d03ee19d55394b5a5f2d9d1506edd56659`. Inspected shared CLI, runtime main, runtime CMake, capture source, BIOS profile and framework/UI notices compare byte-identically; title setup sources differ. The existing Core calls `psxrecomp/psxrecomp_cli.py`, generates privately with registered tools and verified BIOS, builds `psx-runtime` into `build-portcove`, and requires `Dino_Crisis_Recompiled.exe` / `Dino_Crisis_2_Recompiled.exe` there. Packaged root setup hosts are not the Play target. Exact CMake game dispatch stems are `SLUS_009.22` / `SLUS_012.79`; retail BIOS stem is SCPH5552. Netplay is disabled in the selected build configuration.

## Source and BIOS boundaries

| Title         | Accepted source       | Serial       | First data-track bytes | First data-track SHA-1                     |
| ------------- | --------------------- | ------------ | ---------------------: | ------------------------------------------ |
| Dino Crisis   | USA Rev 1, two tracks | `SLUS-00922` |              379986768 | `0ef3326f26f1d97f4ab467023ac6be5e1189a6d3` |
| Dino Crisis 2 | USA, two tracks       | `SLUS-01279` |              473676336 | `f7c71427c4c8726c9114514746c42f10928fbaee` |

Each independent packaged disc identity advertises Track 2 size 37,396,800 and SHA-1 `d9f92af296360772e62caa4cb276de3fa74f5538`. This remains upstream metadata: Core's `psx-normalized-track-set` observation hashes the first data track and checks track count. It does not authenticate Track 2's digest or every TOC mode/index/pregap. No full-disc identity, audio or netplay success is claimed. Other unpaired hash/size arrays in game.toml are not promoted into accepted identities.

The existing single-disc CHD materialization retains the complete extracted CUE/BIN set, unlike the separate multi-disc raw-set route's one-track-per-disc restriction. Original CHD storage identity is rechecked around generation. No new materialization or public source contract is introduced. Actual disc materialization and runtime compatibility remain unobserved.

Both exact kits require the retail SCPH-5552/5502 Europe v3.0 BIOS, 524,288 bytes, SHA-256 `1faaa18fa820a0225e488d9f086296b8e6c46df739666093987ff7d8fd352c09`. The packaged SCPH5552 profile points to `bios/SCPH5552.BIN` and matches the existing catalog identity. OpenBIOS is not substituted. No original game or BIOS bytes were accessed.

## Ownership and admission limits

Generated executable and ordinary working directory are `build-portcove`. Core supplies the verified registered BIOS and overrides the memory-card directory under runtime `saves`, covering cards, savestates and count-guarded game-option state. Settings/input/keybind/config/BIOS/disc sidecars, mods and additive overlay capture/history are persistent. The declaration also conservatively preserves `settings.toml.bad`; no malformed-settings recovery observation is claimed. Cache, heartbeat/report/trace/lobby files and bounded freeze-dump names are disposable.

The capture environment `build-portcove/overlay-captures/overlay_captures.json` resolves against the package root discovered through CMakeLists, yielding the declared runtime directory. Optional configured capture-persistence directories are absent. Explicit user-selected screenshot/debug/external paths do not grant Portcove ownership of arbitrary data. Setup/generation writes remain operation-private under existing guards; no adapter or safety-policy change is required.

Framework PolyForm Noncommercial 1.0 and UI MIT notices retain their distinct scope. Root project README retains original-game ownership; no independent root game-code license or retail/generated-retail rights are inferred. This metadata change redistributes no upstream code, game or BIOS content.

Maintenance target: `managed-compatible-release`. Current direct manifests bind exact assets; future artifacts require immutable identity and reviewed source/executable/persistence compatibility through existing #254/#246 machinery. Protected publication stays with #534. Future compatibility, automatic updates and inherited qualification are not established.

Actual ordinary proposal preparation against clean accepted main produced exactly these two additions, with declaration checks for 91 accepted / 93 input / 93 output ports and 806.692 ms observed preparation; engineering time and speedup are unmeasured. A separate unsafe persistence proposal was refused by Core with exit 2 before library mutation. Exact-tag game/project/CMake source controls compare equal to each respective package after newline normalization, with raw hashes retained.

Both scoped pins passed strict health in 8/10 requests. The full collection admitted 162 conservative requests under the unchanged 256 ceiling and consumed 150; it remained incomplete because the existing DNZH GitLab repository timed out and its release returned 503. Two bounded diagnostic reads also timed out. This failed observation is retained and does not establish a full-health pass; delivery requires a valid current full collection. Local Rust and Node feedback were refused before execution by the existing 20 GiB storage guard, preserving caches and evidence. Required hosted CI remains authoritative.

Ordinary artwork preparation retained accepted mappings and recorded separate exact-port and original-game fallback reasons for both new titles. Missing provider credentials or an attributable exact artwork mapping permits the existing generated/text fallback; it does not justify copying another implementation's cover identity. Required hosted CI and separate review qualify repository delivery. Generation, native application, runtime/TOC/audio/save compatibility, lifecycle, gameplay, physical/human observations and protected publication: **Not run**. Both per-port issues retain genuinely remaining outcomes; this pair does not complete the entire frozen cohort or #254 acceptance.

Retained exact metadata, ZIP inventories, inert member hashes, strict pin receipts and proposal/health/check evidence reside under `/workspace/scratch/dino-admission`. Earlier failed guards and research remain preserved.
