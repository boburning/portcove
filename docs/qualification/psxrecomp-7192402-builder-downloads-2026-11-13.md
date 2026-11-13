# PSXRecomp 7192402: managed builder downloads and requalification scope

Dated evidence from November 13, 2026, under #2926 and the Alexbeav PS1
title issues. The owner chose to requalify forward to framework `7192402`
rather than hold unreviewed upstream versions. This record covers the
builder change and the review that sets the rest of the requalification. No
upstream program was executed, and no original disc or BIOS was used.

## Why

On November 11 and 12, 2026, the Alexbeav kits moved to new tags. A survey of
the newest tag of every managed PS1 route found 50 routes pinned to PSXRecomp
`7192402c283880e318c97732c9b733c4d1b144d0` (Alexbeav/psxrecomp), read from
each kit's `framework_pins.txt`. Ten more pin `031868cc`, whose runtime,
recompiler, setup host and build CLI are byte-identical. Core follows the
newest matching release, so these kits are already offered as updates.

## Overlay toolchain download

Every `7192402` `rebuild` stages an overlay toolchain
(`psxrecomp_cli.py:2427-2428`; `tools/release_stage.py:521-570`, 745-860).

- **What it fetches:** a pinned Python, through
  `urllib.request.urlopen(url, timeout=120)` with the default opener (RS:552).
  On Linux, when `make` is on the path, it also downloads tcc and musl source,
  then runs `./configure`, `make` and `make install` (RS:690-744, 806-820).
- **Core's flag doesn't stop it:** `--no-toolchain-download` controls only the
  cmake/clang pack (CLI:2270). No flag, environment variable or configuration
  key skips the step. A SHA-matched archive already in
  `<kit>/.cache/overlay-toolchain` is used without the network (RS:539-542).
- **On failure:** four attempts with 2, 4 and 8 second pauses, then a logged
  warning (CLI:2512-2515); the build still succeeds. It leaves empty
  `overlay_toolchain/` and `.cache/overlay-toolchain/` folders. With no
  `compiler.txt` the player interprets overlays and starts no compiler
  (`main.cpp:20376`, 3600-3603, 3662-3668).
- **On success:** the downloaded tools sit beside the player, and `compiler.txt`
  points the player at a compiler it runs to build overlays.

Core never admits an executable it has not verified. The managed builder
therefore now:

- **refuses the requests:** it sets `HTTPS_PROXY` and `HTTP_PROXY` to
  `http://127.0.0.1:9` and removes every spelling of `https_proxy`,
  `http_proxy` and `NO_PROXY`. The reviewed child environment never inherits
  proxy variables. urllib reads these before any Windows registry or macOS
  system proxy, so each attempt is refused at once and the step adds about
  14 seconds.
- **checks the result:** after `rebuild`, any file under
  `build-portcove/overlay_toolchain` or `.cache/overlay-toolchain` fails the
  preparation and keeps the previous version. That covers a pre-filled cache
  as well as a request that got through.

A host with a listener on 127.0.0.1:9, such as a discard service, gets no
reply. Each attempt then waits its 120-second timeout, so the build is
delayed by about eight minutes. It still downloads nothing.

Installations built with network access before this change may already hold
a downloaded toolchain in their verified manifest. This change does not
detect them. That remains open with the route requalification below.

## What the requalification still needs

Static review of `7192402` against the reviewed split-mods framework
`5420458a`:

- **New player data.** At every start the runtime creates
  `mods/texture-packs/<game id>/{replacements,dumps}`
  (`mod_runtime.cpp:1755-1793`, `gpu_hd_textures.cpp:295`). The split mod
  paths do not declare it.
  - **Why it isn't declared yet:** every PS1 installation keeps a data-restore
    receipt for its retained scope. Core refuses collection, activation and
    backup when the current scope differs from that receipt. Widening the
    declaration would stop data synchronization for every existing
    installation. Independent review blocked that first attempt.
  - **What it needs:** a reviewed Core transition for receipt-governed scopes,
    one that proves the added path holds no files. The whole-`mods` routes
    below need the same transition.
- **Whole-`mods` routes.** On every start `7192402` moves or deletes the flat
  `mods/packages` (`mod_packages.cpp:2792-2849`). This affects 14 `true`-form
  routes and 10 `bundled-openbios` routes, which persist all of `mods`.
- **BIOS changes.**
  - The newest `bundled-openbios` kits require a retail BIOS. King's Field
    needs SCPH-5500, which has no profile.
  - Suikoden and Mortal Kombat Trilogy v0.1.2 moved from SCPH-5552 to
    SCPH-1001.
- **In-game disc change.** "Insert disc and resume" rewrites the `[disc]`
  table of `settings.toml`, which is already persistent. With
  `--no-launcher`, `[disc] selected = N` still mounts roster entry N and
  scopes save states to N (`main.cpp:20061-20072`, 22248-22263, 23247-23252),
  so the reviewed launch disc choice is unchanged.
- **Other new writers.** Each one is inside an already declared path
  (`saves`, `cache`, `overlay-captures`). Otherwise it is gated behind a debug
  build, an environment variable, a diagnostics mod no kit includes, or a
  `regional-launch.toml` no kit ships.

All 42 v0.1.1 Windows and Linux x64 kits of the 21 split-mods routes on
`7192402` were downloaded and inspected statically. Each matched:

- its upstream `SHA256SUMS.txt`
- the `7192402` framework pin
- its route's BIOS profile and disc identity

They keep the flat layout with `mods/bundled`, `mods/preloaded` and empty
texture-pack folders. Rival Schools v0.1.1 renames its CMake `EXE_NAME` to
`Rival_Schools_Arcade`, while Core passes the catalog's
`Rival_Schools_United_by_Fate` as `--exe-basename`. That was not built.

## Not observed

Nothing was built or run:

- no managed build or proxy refusal on a real host
- no gameplay, disc change or texture-pack use
- no update, rollback or backup with real player data
