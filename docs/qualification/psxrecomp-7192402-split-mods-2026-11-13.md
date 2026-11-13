# PSXRecomp 7192402: split-mods requalification and builder downloads

Dated evidence from November 13, 2026, under #2926 and the Alexbeav PS1
title issues. The owner chose to requalify forward to framework `7192402`
rather than hold unreviewed upstream versions. This record covers the
split-mods routes and the builder. The whole-`mods` routes and the six
multi-disc titles that are still listed only follow separately. No upstream program was executed, and no
original disc or BIOS was used.

## Why this was needed

On November 11 and 12, 2026, the Alexbeav kits moved to new tags. A survey of the
newest tag of every managed PS1 route found 50 routes pinned to PSXRecomp
`7192402c283880e318c97732c9b733c4d1b144d0` (Alexbeav/psxrecomp), read from
each kit's `framework_pins.txt`. Core follows the newest matching release, so
these kits are already offered as updates.

A static review of `7192402` against the reviewed split-mods framework
`5420458a` found three changes that affect Portcove:

- **Overlay toolchain download.** Every `rebuild` stages an overlay toolchain
  (`psxrecomp_cli.py:2427-2428`, `tools/release_stage.py:521-570`, 745-860). It
  downloads a pinned Python with `urllib.request.urlopen`. On Linux, when
  `make` is on the path, it also builds tcc and installs musl headers from
  downloaded source. Core's `--no-toolchain-download` controls only the
  cmake/clang pack (`psxrecomp_cli.py:2270`). No flag, environment variable or
  configuration key skips the step.
  - **On failure:** four attempts, then a logged warning (2512-2515); the
    build still succeeds.
  - **On success:** the downloaded tools sit beside the player, and the
    player uses them to compile overlays at run time (`main.cpp:3662-3668`).
- **New player-data folder.** At every start the runtime creates
  `mods/texture-packs/<game id>/{replacements,dumps}` for player HD texture
  replacements and optional dumps (`mod_runtime.cpp:1755-1793`,
  `gpu_hd_textures.cpp:295`). The split-mods paths did not declare it.
- **In-game disc change.** "Insert disc and resume" rewrites the `[disc]`
  table of `settings.toml`, which is already persistent. With `--no-launcher`,
  `[disc] selected = N` still mounts roster entry N and scopes save states to
  N (`main.cpp:20061-20072`, 22248-22263, 23247-23252), so the reviewed launch
  disc choice is unchanged.

Every other new writer in the runtime is either inside an already declared
path (`saves`, `cache`, `overlay-captures`) or gated behind a debug build, an
environment variable, a diagnostics mod no kit includes, or a
`regional-launch.toml` no kit ships.

## Changes

- **Builder downloads.** Core now starts the managed builder with `HTTPS_PROXY`
  and `HTTP_PROXY` set to `http://127.0.0.1:9`, removes `NO_PROXY`, and keeps
  the reviewed environment that never inherits proxy variables. urllib honors
  these before a Windows system proxy. Each attempt is refused at once, which
  adds about 14 seconds. The kit leaves `overlay_toolchain/` and
  `.cache/overlay-toolchain/` empty, and the player interprets overlays
  (`main.cpp:20376`).
- **Persistent path.** `mods/texture-packs` joins the split mod paths. That
  covers the `split-mods` and `split-mods-openbios` authoring forms and the
  explicit integrations for Armored Core: Master of Arena, Fear Effect 2:
  Retro Helix and MediEvil.
  - **The kits:** they ship only empty `mods/texture-packs/<serial>`
    folders, and the generated player creates its own below
    `build-portcove`.
  - **Existing installations:** installations without the folder keep an
    empty-path transition. Verification recognizes newly declared persistent
    paths when the retained definition otherwise matches.
- **Player copy.** The two multi-disc titles now say that kit v0.1.0 cannot
  change discs during play and later kits offer an in-game disc change.

## Kits checked

All 42 Windows and Linux x64 kits of tag v0.1.1 were downloaded and inspected
statically. For every kit:

- Its SHA-256 matched the kit's `SHA256SUMS.txt`, and the v0.1.0 kits matched
  the corpus.
- `framework_pins.txt` and `project-manifest.toml` name `7192402`.
- Windows and Linux carry the same `game.toml`, with `openbios = false`.
- `bios_config`, `known_sha1`, `disc_serials` and track counts match each
  route's BIOS and source profiles. The two multi-disc kits list every disc
  in catalog order.
- The layout is flat, as before, with `mods/bundled`, `mods/preloaded` and
  empty texture-pack folders. There are no links and no case-colliding Linux
  paths.

| Route                           | Windows bytes, SHA-256  | Linux bytes, SHA-256    |
| ------------------------------- | ----------------------- | ----------------------- |
| AC: Project Phantasma           | 47,702,301, `4859bb99…` | 45,591,958, `f21b968a…` |
| Azure Dreams                    | 47,704,675, `7095e331…` | 45,593,978, `1c49764b…` |
| Bushido Blade 2                 | 47,704,293, `8e73ac52…` | 45,593,696, `e36bc7d5…` |
| Colony Wars: Red Sun            | 47,707,353, `095ad61c…` | 45,596,976, `bcaa0d8c…` |
| Digimon World 2                 | 47,702,755, `258870ee…` | 45,592,190, `dac5ebb9…` |
| Dragon Ball Z: UB22             | 47,702,292, `f186f542…` | 45,592,303, `9128da60…` |
| Future Cop: L.A.P.D.            | 47,706,502, `44d6aa1c…` | 45,596,386, `4df083ff…` |
| G-Police: Weapons of Justice    | 47,702,969, `32ef8dae…` | 45,592,487, `3326a867…` |
| Jade Cocoon                     | 47,704,650, `c6c0021a…` | 45,594,061, `324f9006…` |
| Kartia                          | 47,702,825, `99582a04…` | 45,592,748, `a9c5bc20…` |
| Mega Man Legends 2              | 47,702,339, `ca411c8b…` | 45,592,972, `e0d7f1ba…` |
| The Misadventures of Tron Bonne | 47,701,896, `eae8877f…` | 45,591,853, `17954fd9…` |
| Nightmare Creatures II          | 47,704,996, `2c237954…` | 45,594,114, `c8c357b0…` |
| Rival Schools                   | 47,712,706, `63fd0863…` | 45,602,883, `e570145d…` |
| Rollcage Stage II               | 47,701,330, `4311f93c…` | 45,592,124, `330776b5…` |
| Spider-Man 2: Enter Electro     | 47,705,038, `6d1b58f3…` | 45,595,159, `baa09e47…` |
| Suikoden II                     | 47,704,172, `2bd0c418…` | 45,595,108, `013cfa46…` |
| Tail Concerto                   | 47,704,068, `3d7995d5…` | 45,593,413, `e976e68e…` |
| Wild Arms                       | 47,701,991, `ff4b4076…` | 45,592,751, `71fe83d2…` |
| AC: Master of Arena             | 47,702,757, `0b855971…` | 45,592,098, `5b60cc50…` |
| Fear Effect 2: Retro Helix      | 47,705,144, `e5f8dd6f…` | 45,594,323, `fadca821…` |

Rival Schools v0.1.1 renames its CMake `EXE_NAME` to `Rival_Schools_Arcade`.
Core still passes the catalog's `Rival_Schools_United_by_Fate` as
`--exe-basename`. If the kit's build ignores that override, preparation fails
closed with "PS1 build completed without" the expected player. This was not
built.

MediEvil's newest tag, v0.1.5, pins `031868cc`, whose runtime, recompiler,
setup host and build CLI are byte-identical to `7192402`. Its kit was not
downloaded. Its upstream `SHA256SUMS.txt` was read but not independently
hashed.

## Still open

- **Whole-`mods` routes:** 14 `true`-form routes on `031868cc` or `7192402`,
  and 10 `bundled-openbios` routes. On every start `7192402` moves or deletes
  the flat `mods/packages` (`mod_packages.cpp:2792-2849`), so those routes
  need the split projection and an explicit persistence transition.
- **New BIOS requirements:**
  - The newest `bundled-openbios` kits now require a retail BIOS. King's
    Field needs SCPH-5500, which has no profile.
  - Suikoden and Mortal Kombat Trilogy v0.1.2 moved from SCPH-5552 to
    SCPH-1001.
- **Multi-disc titles:** Galerians, Alone in the Dark: The New Nightmare, In
  Cold Blood, Koudelka, Final Fantasy VIII and Final Fantasy IX now fit the
  split-mods layout with this change. Each still needs its own route and
  enrollment.
- **MediEvil II:** a native-portable route whose newest tag also pins
  `031868cc`. Its v0.2.6 assets no longer match the catalog prefix.

## Not observed

Nothing was built or run:

- no managed build or proxy refusal on a real host
- no gameplay, disc change or texture-pack use
- no update, rollback or backup with real player data

The Windows lifecycle test for split mod paths covers carrying texture-pack
data with inert fixtures.
