# Mortal Kombat 4: PSXRecomp 031868cc kits and the managed PS1 layout

Dated evidence from November 13, 2026, under #82 and #2926. It moves the
managed `mortal-kombat-4-recompiled` route on Windows, Linux and both Mac
architectures to the reviewed managed PS1 layout of its v0.3.6 kits. The
framework review is in the
[builder downloads record](psxrecomp-7192402-builder-downloads-2026-11-13.md).
The split layout follows the
[whole-to-split record](psxrecomp-7192402-whole-to-split-2026-11-13.md), and
the texture-pack rule follows the
[texture-pack record](psxrecomp-texture-pack-scope-2026-11-13.md). No upstream
program was executed.

## Why it changes

The newest tag is v0.3.6 (commit `c0eea8a6eaf48c0b1622236f5031eba3acfb4b24`,
tag object `eb94b0c6`). Its kits pin PSXRecomp
`031868cc0170d260f1cb81c7cfe7ab68e8bbb424`, whose runtime, recompiler, setup
host and build CLI are byte-identical to the reviewed `7192402`, and recomp-ui
`14799da`. Core already offers it as an update. Before this change the route:

- persisted all of `mods`, so each version's build-staged `mods/bundled`
  would be collected as player data;
- persisted `config`, `game_options.json`, `graphics.json`, `input.json` and
  `sound.json`;
- had no `--no-launcher`, overlay environment or disposable diagnostic paths;
- had game and BIOS source contracts with empty applicability, so no release
  was bound to the player's disc or BIOS;
- had no product code on its disc identity.

## Kits

All four kits were downloaded and inspected statically, one at a time, and
deleted afterwards.

| Platform    | Asset                                          | Bytes      | SHA-256                                                            |
| ----------- | ---------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| Windows x64 | `mortal-kombat-4-recomp-0.3.6-windows-x64.zip` | 47,787,823 | `45b72a23db2286e0bebcdc31bb6a0d72346ccc333346011c711bc9d0b27fdde8` |
| Linux x64   | `mortal-kombat-4-recomp-0.3.6-linux-x64.zip`   | 45,956,510 | `5f4144ddce73767ca6be36640086d6e28f6223cb1f2e5862444c3c9ada32e9fd` |
| macOS x64   | `mortal-kombat-4-recomp-0.3.6-macos-x64.zip`   | 43,384,895 | `629c40e6aaa0df4c9a472242e6918f15ee50e9aec65374ee2c697e2d14903e64` |
| macOS arm64 | `mortal-kombat-4-recomp-0.3.6-macos-arm64.zip` | 42,877,092 | `cb8d3533b9cf054a4c0f88094934f0d6d3689b887db915a88ff3b38c8cd8b9a7` |

In each kit:

- the SHA-256 matched the release's `SHA256SUMS.txt`. The provider release
  digest was not read, because this session's proxy blocks the release API;
- `framework_pins.txt` named PSXRecomp `031868cc` and recomp-ui `14799da`;
- `game.toml` and `CMakeLists.txt` matched the tagged files, apart from line
  endings. The game id and disc serial are `SLUS-00605`, with 1 track, data
  track size 718,112,640 and SHA-1 `21515cdd9829521a2db76a83300b77e83855fa88`,
  which is the route's existing disc identity;
- the BIOS configuration is `psxrecomp/bios/SCPH1001.toml`, with OpenBIOS
  and `bios_hle` off. `README-SETUP.txt` asks for the player's own SCPH-1001
  (USA) BIOS with the SHA-256 of the `psx-scph-1001-bios` profile. The kits
  ship no OpenBIOS image;
- the generated player is `Mortal_Kombat_4`, from the `WINDOW_TITLE`
  "Mortal Kombat 4" with no `EXE_NAME`, and `.exe` on Windows. The kit's
  `codegen_setup.c` uses the same basename. This matches the catalog's
  executable on every platform;
- `mods` holds `bundled` (34 entries), `preloaded` and empty
  `texture-packs/SLUS-00605/{dumps,replacements}`, with no flat
  `mods/packages`, no links and no case-colliding paths. Only the Windows kit
  also ships an empty `cache/SLUS-00605/datashards/`.

The Linux kit and both Mac kits list the same paths. The Mac kits use the same
root layout and player name as Linux, and ship `psxrecomp-game` and
`psxrecomp-bios` emitters without `.exe`. Their architecture was not checked. Core's managed builder already prepares Mac
routes through its Apple toolchain path (`psx.rs`). The kit-BIOS guard and
the `mods/packages` refusal apply on every platform.

## Route changes

The explicit integration now has the same managed PS1 layout as
`alexbeav-medievil-recomp`, on all four platforms:

- **Mod paths:** `mods` is replaced by `mods/installed`, `mods/packages`,
  `mods/.staging`, `mods/state.toml`, `mods/state.toml.tmp` and
  `mods/texture-packs`. Each runtime version keeps its own `mods/bundled`.
- **Other player data:** `saves`, `settings.toml` and `settings.toml.bad`,
  the recomp-ui files `input.ini`, `keybinds.ini`, `config.ini`, `disc.cfg`
  and `bios.cfg`, the overlay captures, and `diagnostics-location.txt`.
  These kits do not compile playtest diagnostics, so nothing writes that last
  file yet. It is declared so that a later kit that turns diagnostics on keeps
  the same shape as MediEvil.
- **Disposable runtime files:** `cache`, the freeze heartbeat and dumps, the
  last-run and exit-trace reports, the LAN lobby file, `psx_crash.txt` and
  the overlay-capture temporary files.
- **Launch:** `--no-launcher` and `PSX_OVERLAY_CAPTURES` in `build-portcove`.

Release selectors, executables, platforms and the BIOS profile are unchanged.

### The former `config` and `*.json` paths

They are dropped. No writer or reader for them exists in the `031868cc`
runtime (`runtime/src`, `runtime/include`, `host/`, the linked
`recompiler/src/config_loader.cpp`), in recomp-ui `14799da`, or in the kit's
own `codegen_setup.c` and `CMakeLists.txt`. The framework keeps game options
in `saves/<game id>.options`, only when a `game_options.toml` ships, and this
kit ships none. Launcher settings live in the `.ini`, `.cfg` and
`settings.toml` files above. The `runtime` folders of `031868cc` and
`7192402` differ only in test files.

## Source contracts

- **Disc identity:** `SLUS-00605` is added as the product code of the
  existing `legacy-accepted` variant. Product codes do not change the
  schema-1 projection.
- **Game and BIOS contracts:** each now applies to the four v0.3.6 kits by
  tag and artifact SHA-256. Their earlier applicability was empty, so nothing
  is removed. Both cite the new
  `mortal-kombat-4-recompiled-v036-static-contract` evidence record.
- **Release corpus:** this route has no release-selection corpus entry, and
  none is added, because there is no provider observation.

## Existing installations

The launch arguments and environment changed, so Core keeps each existing
installation's retained definition (`installed_mutability`).

- **Existing copies:** they keep the whole-`mods`, `config` and `*.json`
  scope, and launch as before, without `--no-launcher`.
- **New installations:** they use the layout above.
- **Update from an older copy:** the older copy's declared data, including all
  of `mods`, is collected under its retained scope. The new copy restores only
  its own declared paths, including any flat `mods/packages`, which the
  runtime migrates into `mods/installed` on start (`migrate_legacy_root`).
  Files in `config` and the four `.json` files are not restored into the new
  copy, which has no reader for them. They stay in the older copy and in the
  automatic snapshot taken before the update. The whole-to-split record
  describes the one migration case that drops a player-edited package.
- **Rollback:** an older copy restores its whole scope as before.

## Player copy

The summary now says the player is built from the player's own disc and BIOS.
The new preparation note names the disc, track count and BIOS, says that
Portcove builds a private player on each platform and skips the setup
launcher, notes the Mac command-line tools, lists the preserved data, and
says that copies installed earlier keep their scope until updated.

## Validation

- `node scripts/generate-catalog.mts`, then `--check`
- the Core repository proposal inspector on the generated catalog
- `node --test scripts/catalog-source-authoring.test.mts`
- the Core catalog, release, PS1, route enrollment, definition entry, signed
  catalog, installed mutability and source catalog tests, including a new
  test of this route's layout, product code and four kit bindings, and the
  updated frozen schema-1 comparison
- `cargo fmt --all --check` and `cargo clippy -p portcove-core --all-targets`

## Not observed

Nothing was built or run on any platform. No disc or BIOS was used, and no
mod package was migrated. No update, rollback or backup with real player
data was observed, and Mac preparation of these exact kits under Portcove's
toolchain is unobserved.
