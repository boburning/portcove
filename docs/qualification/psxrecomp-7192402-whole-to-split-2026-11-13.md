# PSXRecomp 7192402: 21 whole-`mods` PS1 routes move to the split layout

Dated evidence from November 13, 2026, under #2926. It moves 21 managed PS1
routes from whole-`mods` persistence to the split mod paths. Their newest
kits are on PSXRecomp `7192402` or the runtime-identical `031868cc`, and those
kits keep each route's disc identity, BIOS and player. The framework review is
in the [builder downloads record](psxrecomp-7192402-builder-downloads-2026-11-13.md).
The texture-pack scope rule is in the
[texture-pack record](psxrecomp-texture-pack-scope-2026-11-13.md). No upstream
program was executed.

## Why the layout changes

Earlier kits on these routes kept every mod package in one flat
`mods/packages`, so the routes persisted all of `mods`. The new kits stage
their own defaults in `mods/bundled` at build time and keep player packages
in `mods/installed`. Each start runs `ModPackageManager::migrate_legacy_root`
(`runtime/src/mod_packages.cpp`), which handles each older flat
`mods/packages/<id>/<version>` like this:

- **Moved:** to `mods/installed`.
- **Deleted:** only when the build already ships that exact version or
  `mods/installed` already holds it.
- **Left in place:** anything that cannot be moved, with the whole legacy
  folder.

Under a whole-`mods` scope, each version's build-staged `mods/bundled` would
be collected as player data. The routes therefore now use the split mod
paths, including `mods/texture-packs`:

- **Authoring-form routes:** `psx_managed_windows_v1` changes from `true` to
  `"split-mods"`.
- **Explicit integrations:** `mods` is replaced by the same six paths.

## Existing installations

Core keeps an installation's retained definition when the current one no
longer contains all of its persistent paths (`installed_mutability`).

- **Existing copies:** they keep their whole-`mods` scope.
- **New installations:** they use the split paths.
- **Update from old to new:** the old copy's `mods` is collected, and the
  split paths, including any flat `mods/packages`, are restored into the new
  copy. The runtime then migrates them on start.
- **Rollback:** a whole-`mods` copy restores all of `mods` as before.

## Kits

All Windows and Linux x64 kits were downloaded and inspected statically. In
each one:

- the SHA-256 matched the kit's `SHA256SUMS.txt`;
- `game.toml` was identical on both platforms, apart from line endings;
- the data-track SHA-1 and track count matched the route's source identity;
- the BIOS configuration matched its profile;
- the generated player matched the catalog;
- `mods/bundled` was present with empty texture-pack folders, and there were
  no links or case-colliding Linux paths.

Each route's game and BIOS source contracts now also apply to these kits,
with one new evidence record per route. The provider release digests were
not read, because this session's proxy blocks the release API.

| Title                       | Tag, framework     | Windows bytes, SHA-256  | Linux bytes, SHA-256    | Form           |
| --------------------------- | ------------------ | ----------------------- | ----------------------- | -------------- |
| Alien Resurrection          | v0.1.5, `031868cc` | 47,781,243, `9c7f812e…` | 45,589,397, `cc53e2a6…` | explicit       |
| Bloody Roar II              | v0.1.3, `031868cc` | 47,785,224, `94bcee3d…` | 45,592,598, `90d4ed56…` | explicit       |
| Brave Fencer Musashi        | v0.1.4, `031868cc` | 47,783,422, `48402432…` | 45,590,623, `ffe43ae8…` | explicit       |
| Destruction Derby Raw       | v0.1.1, `7192402c` | 47,708,984, `4a9ee3c7…` | 45,600,544, `dffe2dbc…` | explicit       |
| Diablo                      | v0.1.5, `031868cc` | 47,782,111, `780ed938…` | 45,589,957, `0a6a5ebe…` | explicit       |
| Legacy of Kain: Soul Reaver | v0.1.5, `031868cc` | 47,787,369, `764ba185…` | 45,594,884, `afd865f4…` | explicit       |
| MDK                         | v0.1.5, `031868cc` | 47,784,075, `3fce1b86…` | 45,591,670, `d955f972…` | explicit       |
| Monster Rancher 2           | v0.1.4, `031868cc` | 47,786,734, `abb71a7c…` | 45,594,658, `da90b637…` | authoring form |
| Nightmare Creatures         | v0.1.4, `031868cc` | 47,781,296, `3634c700…` | 45,588,616, `37acaa48…` | authoring form |
| Oddworld: Abe's Oddysee     | v0.1.4, `031868cc` | 47,784,218, `eea18a4d…` | 45,592,454, `239f6e1d…` | authoring form |
| Quake II                    | v0.1.3, `031868cc` | 47,787,981, `31b5d2e7…` | 45,592,327, `49a5c9b9…` | authoring form |
| Silent Bomber               | v0.1.2, `7192402c` | 47,809,186, `3aebb600…` | 45,741,069, `3bd3321b…` | authoring form |
| Spyro the Dragon            | v0.1.5, `031868cc` | 47,782,482, `05422c51…` | 45,590,434, `a8278880…` | explicit       |
| Syphon Filter 3             | v0.1.4, `031868cc` | 47,788,677, `dbe41506…` | 45,596,417, `2b853e52…` | authoring form |
| Tenchu: Stealth Assassins   | v0.1.4, `031868cc` | 47,782,751, `00ca7e0e…` | 45,590,751, `eabbd721…` | authoring form |
| Tony Hawk's Pro Skater 2    | v0.1.4, `031868cc` | 47,787,465, `51739cfb…` | 45,595,594, `38831ff8…` | authoring form |
| Tony Hawk's Pro Skater 3    | v0.1.4, `031868cc` | 47,787,531, `0fa4952c…` | 45,595,681, `a206b084…` | authoring form |
| Tony Hawk's Pro Skater 4    | v0.1.4, `031868cc` | 47,787,482, `5042ef46…` | 45,595,629, `717a2ce4…` | authoring form |
| Tony Hawk's Pro Skater      | v0.1.4, `031868cc` | 47,786,049, `56a39e86…` | 45,594,225, `0650f2f2…` | authoring form |
| WipEout                     | v0.1.5, `031868cc` | 47,783,637, `daaa8119…` | 45,591,583, `0936ac15…` | explicit       |
| Xena: Warrior Princess      | v0.1.3, `7192402c` | 47,702,735, `63b2d851…` | 45,592,553, `d158c822…` | authoring form |

## Not changed here

- **BIOS changes (24 routes):** their newest kits changed the BIOS. Thirteen
  moved from OpenBIOS to SCPH-1001, seven from OpenBIOS to SCPH-5552, and four
  from SCPH-5552 to SCPH-1001.
- **SCPH-5500:** King's Field and Ace Combat 3 (Japan) now need it, and it has
  no profile.
- **Mortal Kombat 4:** a different kit family with Mac routes.
- **Rival Schools:** its renamed player needs the release corpus updated from a
  provider observation.

## Not observed

Nothing was built or run, and no mod package was migrated. No update,
rollback or backup with real player data was observed.
