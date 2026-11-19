# PSXRecomp 7192402: 24 PS1 routes move to a retail BIOS and the split layout

Dated evidence from November 13, 2026, under #2926. It requalifies 24 managed
PS1 routes to their newest kits, which are all on PSXRecomp `7192402`. Those
kits keep each route's disc identity and player but change the BIOS they build
with, so new installations now need the player's own retail BIOS. Like the
[whole-to-split record](psxrecomp-7192402-whole-to-split-2026-11-13.md), the
routes also move to the split mod paths. The framework review is in the
[builder downloads record](psxrecomp-7192402-builder-downloads-2026-11-13.md).
No upstream program was executed.

## Why the BIOS changes

The bound kits (v0.3.6 on framework `08ec704a`, or v0.1.1 on `a839474e`)
used one of two BIOS setups:

- **Bundled OpenBIOS (20 routes):** `game.toml` had no retail
  `bios_config`, and the route passed `--bios bios/openbios.bin`.
- **SCPH-5552 (4 routes):** `game.toml` selected
  `psxrecomp/bios/SCPH5552.toml`.

In every new kit, `game.toml` selects a retail configuration and sets
`[runtime] openbios = false`. Both `project-manifest.toml` and
`README-SETUP.txt` require the player's own BIOS dump with the SHA-256 of an
existing Portcove profile. The kits still contain the framework's
`psxrecomp/bios/openbios.bin`, but they don't select it. In PSXRecomp
`7192402`, `SCPH1001.toml` and `SCPH5552.toml` declare that same image SHA-256
in `[program.image]`. `recompiler/src/main_bios.cpp` refuses to generate from
any other image.

| Change                 | Routes | Kit `bios_config`              | Portcove profile     |
| ---------------------- | ------ | ------------------------------ | -------------------- |
| OpenBIOS to SCPH-1001  | 13     | `psxrecomp/bios/SCPH1001.toml` | `psx-scph-1001-bios` |
| OpenBIOS to SCPH-5552  | 7      | `psxrecomp/bios/SCPH5552.toml` | `psx-scph-5552-bios` |
| SCPH-5552 to SCPH-1001 | 4      | `psxrecomp/bios/SCPH1001.toml` | `psx-scph-1001-bios` |

### Mega Man Legends and `bios_hle`

Its kit also sets `[runtime] bios_hle = true`. In PSXRecomp `7192402`
(`runtime/include/bios_hle.h`, `runtime/src/bios_hle_plan.c`), this turns on
an optional high-level tier on top of the recompiled real BIOS:

- **Kernel calls:** it handles the calls it implements, but only when the
  BIOS profile declares a `deliver_event_ret` anchor. `SCPH5552.toml` does.
- **Boot intro:** it skips the BIOS shell's intro.
- **Everything else:** kernel initialization and every unimplemented call
  still run in the recompiled retail BIOS.

The retail image is therefore still recompiled and executed, and it remains a
required build and launch input that Portcove provides like any other retail
BIOS. Nothing else is needed, so the route is included.

## What changes in the catalog

For each route:

- **Persistence:** authoring-form routes move to `"split-mods"`, which
  requires `bios_source_profile`. Explicit integrations replace `mods` with
  the six split paths. Any `--bios bios/openbios.bin` argument is removed.
- **Launch:** Core now passes the registered BIOS with `--bios`, after
  checking it against the generation marker, as for other retail routes.
- **Source contracts:** the game contract also applies to the new Windows and
  Linux kits. The 20 former OpenBIOS routes get a new BIOS contract bound
  only to the new kits. For the four former SCPH-5552 routes, Core allows one
  BIOS contract per port, so the existing BIOS contract changes:
  - it now names `psx-scph-1001-bios`;
  - its review authority moves to the new kit commit;
  - it binds only the new v0.1.2 kits and cites only their evidence. The
    v0.1.1 kits select SCPH-5552, so they are no longer bound there. Their
    game contract keeps them.
- **Evidence:** each route has one new upstream evidence record. The provider
  release digests were not read, because this session's proxy blocks the
  release API.
- **Player copy:** summaries, setup steps, BIOS source requirements and
  manual preparation now ask for the player's own retail BIOS. Mac steps now
  point to the kit's `README-SETUP.txt` for the BIOS. The Mac kits were not
  inspected.
- **Release corpus:** the 22 enrolled routes expect their retail BIOS
  profile and the split paths. For the 20 former OpenBIOS routes, all
  enrolled there, the observed v0.3.6 release is not bound to the BIOS contract. The
  corpus marks this with `retail_bios_from_later_release`, and its game
  evidence stays exact. The same mark applies to Suikoden and Mortal Kombat
  Trilogy, whose observed v0.1.1 release selects SCPH-5552. Dino Crisis and
  Dino Crisis 2 have no corpus entry. No provider release data was added.

The game contracts keep their older entries, so older kits stay listed as
reviewed games. Release selection takes the newest release. If an older kit were built under
the new definition anyway, two things could happen:

- **Wrong BIOS staged:** Core would stage the registered SCPH-1001 BIOS at
  the path that kit's configuration names. Frameworks `08ec704a` and
  `a839474e` declare no image identity, so nothing would refuse the mismatch.
- **Flat packages:** a kit that stages defaults in `mods/packages` is refused
  by the split-scope check before anything is installed.

## Existing installations

`bios_source_profile`, launch arguments and persistent paths are part of an
installation's retained contract (`installed_mutability`). Existing copies
therefore keep their retained definition:

- **Launch:** an OpenBIOS copy keeps launching with `--bios
  bios/openbios.bin` and no registered BIOS. An SCPH-5552 copy keeps using
  that BIOS. Both keep their whole-`mods` scope.
- **Update:** an update installs the new kit under the current definition.
  Before downloading or preparing anything, `validate_and_remember_bios`
  requires the new profile. If no matching BIOS is registered, in the Source
  Inbox or passed with `--bios`, the update fails with a source error. The
  error names the profile, and the active copy stays unchanged. The status
  snapshot does not report the missing BIOS beforehand: Update stays
  **Waiting** for review.
- **New BIOS input:** once the BIOS is supplied, the update collects the old
  copy's data and restores the split paths into the new copy, as in the
  whole-to-split record. The new copy builds and launches with the retail
  BIOS.
- **Rollback:** it restores the earlier copy with its retained OpenBIOS or
  SCPH-5552 contract.
- **Player copy:** each route's manual preparation states this behaviour.

## Kits

All Windows and Linux x64 kits were downloaded and inspected statically. In
each one:

- the SHA-256 matched the kit's `SHA256SUMS.txt`;
- `game.toml` agreed on both platforms;
- the data-track SHA-1 and track count matched the route's source identity;
- the BIOS configuration and the README's BIOS SHA-256 matched the new
  profile;
- the generated player matched the catalog;
- `mods/bundled` was present with empty texture-pack folders, and there was
  no flat `mods/packages`, no links and no case-colliding Linux paths.

### OpenBIOS to SCPH-1001

| Title                                         | Tag, framework     | Windows bytes, SHA-256  | Linux bytes, SHA-256    | Form      |
| --------------------------------------------- | ------------------ | ----------------------- | ----------------------- | --------- |
| Ace Combat 3: Electrosphere (USA)             | v0.3.7, `7192402c` | 47,926,856, `8e186f7a…` | 45,735,357, `6e58033b…` | explicit  |
| Ape Escape                                    | v0.3.7, `7192402c` | 47,930,165, `266df861…` | 45,736,497, `5d92df00…` | explicit  |
| Blood Omen: Legacy of Kain                    | v0.3.7, `7192402c` | 47,930,582, `8a9271df…` | 45,738,635, `a909162c…` | explicit  |
| Colin McRae Rally 2.0                         | v0.3.7, `7192402c` | 47,927,684, `e2176610…` | 45,735,665, `d2b59611…` | authoring |
| Destruction Derby 2                           | v0.3.7, `7192402c` | 47,928,865, `16c7ee74…` | 45,736,046, `4eff212f…` | explicit  |
| Die Hard Trilogy                              | v0.3.7, `7192402c` | 47,927,989, `aacc00b8…` | 45,736,313, `c107ca3f…` | authoring |
| Driver                                        | v0.3.7, `7192402c` | 47,929,655, `b22d43d1…` | 45,737,557, `ed8663a8…` | explicit  |
| Duke Nukem: Land of the Babes                 | v0.3.7, `7192402c` | 47,928,829, `fad24b49…` | 45,736,190, `d4c873e6…` | explicit  |
| Duke Nukem: Time to Kill                      | v0.3.7, `7192402c` | 47,933,260, `e1a381ec…` | 45,741,181, `8991bb4f…` | explicit  |
| Fade to Black                                 | v0.3.7, `7192402c` | 47,926,396, `4b6e9937…` | 45,732,787, `57d072e6…` | explicit  |
| The Lost World: Jurassic Park Special Edition | v0.3.7, `7192402c` | 47,927,472, `9842aae3…` | 45,736,272, `8320e3ff…` | authoring |
| The Mummy                                     | v0.3.7, `7192402c` | 47,930,793, `634f68c3…` | 45,737,544, `ada93e70…` | authoring |
| Vampire Hunter D                              | v0.3.7, `7192402c` | 47,929,817, `9b455e63…` | 45,738,139, `9593f9aa…` | authoring |

### OpenBIOS to SCPH-5552

| Title                  | Tag, framework     | Windows bytes, SHA-256  | Linux bytes, SHA-256    | Form      |
| ---------------------- | ------------------ | ----------------------- | ----------------------- | --------- |
| Alundra                | v0.3.7, `7192402c` | 47,927,439, `37579410…` | 45,734,165, `e5f296bc…` | explicit  |
| Armored Core           | v0.3.7, `7192402c` | 47,926,388, `e4e78340…` | 45,734,618, `d70974fa…` | explicit  |
| Digimon World 2003     | v0.3.7, `7192402c` | 47,928,101, `fddb8340…` | 45,736,030, `a000a3b7…` | explicit  |
| Kula World             | v0.3.7, `7192402c` | 47,928,321, `2fd8349f…` | 45,736,525, `0773a913…` | authoring |
| Mega Man Legends       | v0.3.7, `7192402c` | 47,927,605, `9f482f8c…` | 45,735,528, `34b8c3d8…` | authoring |
| Men in Black: The Game | v0.3.7, `7192402c` | 47,930,656, `aaeb3d51…` | 45,738,177, `89d0b57d…` | authoring |
| Vigilante 8            | v0.3.7, `7192402c` | 47,927,838, `d019e4ac…` | 45,736,079, `cf48982c…` | authoring |

### SCPH-5552 to SCPH-1001

| Title                 | Tag, framework     | Windows bytes, SHA-256  | Linux bytes, SHA-256    | Form      |
| --------------------- | ------------------ | ----------------------- | ----------------------- | --------- |
| Dino Crisis           | v0.1.2, `7192402c` | 47,808,177, `ec4d53bb…` | 45,740,712, `8558fb5c…` | explicit  |
| Dino Crisis 2         | v0.1.2, `7192402c` | 47,808,025, `a1f9f0f0…` | 45,739,588, `6afc46eb…` | explicit  |
| Mortal Kombat Trilogy | v0.1.2, `7192402c` | 47,807,983, `9a37b119…` | 45,739,303, `b583269a…` | authoring |
| Suikoden              | v0.1.2, `7192402c` | 47,807,205, `5c096392…` | 45,739,662, `b0216458…` | authoring |

## Not changed here

- **SCPH-5500:** King's Field and Ace Combat 3 (Japan) now need it, and it has
  no profile.
- **Mac kits:** they stay upstream-owned, and their BIOS was not inspected.

## Not observed

Nothing was built or run. No retail BIOS was used, and no update, rollback or
backup with real player data was observed.
