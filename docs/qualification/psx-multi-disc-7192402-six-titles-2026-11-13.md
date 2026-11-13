# Multi-disc PS1 routes on PSXRecomp 7192402: five of six titles

Dated evidence from November 13, 2026, under #1597, #426, #458, #453, #449
and #450. It adds managed Windows and Linux x86-64 routes for five multi-disc
Alexbeav PSXRecomp titles that were listed only, using the reviewed
[launch disc choice precedent](psx-multi-disc-launch-choice-2026-11-12.md) of
Armored Core: Master of Arena and Fear Effect 2. Alone in the Dark: The New
Nightmare stays listed only (below). No upstream program was executed and no
original disc or BIOS was used.

## Inputs

Each kit is the newest tag by `git ls-remote`. The kits were fetched from the
release download URLs and gave the same SHA-256 on every download, at least
two each. The release API is blocked
by this session's proxy, so the provider digest and asset list were not read.
The ten admitted kits passed `portcove catalog inspect-package-layout` with
those bytes. No kit has a symlink, an absolute or `..` entry, and the Linux
kits have no case-colliding paths.

| Title (issue)                 | Tag      | Commit     | Windows kit bytes, SHA-256 | Linux kit bytes, SHA-256 | Player                          |
| ----------------------------- | -------- | ---------- | -------------------------- | ------------------------ | ------------------------------- |
| Galerians (#1597)             | `v0.1.1` | `dfe40d4d` | 47,704,878, `99f0d0ea…`    | 45,593,961, `0d685a12…`  | `Galerians`                     |
| In Cold Blood (#458)          | `v0.3.7` | `8d64a316` | 47,930,909, `5a5c2dc4…`    | 45,737,089, `86ee3409…`  | `In_Cold_Blood_Recompiled`      |
| Koudelka (#453)               | `v0.3.7` | `b27046a1` | 47,932,903, `c7b739ed…`    | 45,739,541, `8246957e…`  | `Koudelka_Recompiled`           |
| Final Fantasy VIII (#449)     | `v0.1.2` | `cd8498c0` | 47,809,027, `ed238836…`    | 45,740,444, `3d2c770a…`  | `Final_Fantasy_VIII_Recompiled` |
| Final Fantasy IX (#450)       | `v0.1.2` | `ca43695a` | 47,809,442, `0a95cf37…`    | 45,741,914, `eedac0d0…`  | `Final_Fantasy_IX_Recompiled`   |
| Alone in the Dark: TNN (#426) | `v0.3.7` | `673a0d5f` | 47,935,917, `c4567cc8…`    | 45,743,277, `3ab2be5c…`  | not admitted                    |

All twelve kits pin PSXRecomp `7192402c283880e318c97732c9b733c4d1b144d0`
(`framework_pins.txt`; `project-manifest.toml` names the same tree), whose
builder change and texture-pack folder are reviewed in the
[builder downloads](psxrecomp-7192402-builder-downloads-2026-11-13.md) and
[texture-pack scope](psxrecomp-texture-pack-scope-2026-11-13.md) records. Their
`psxrecomp/runtime/src` trees are identical to each other and to `7192402`.
Each kit ships `mods/bundled` and an empty `mods/texture-packs/<serial>`
folder. Galerians, In Cold Blood and Koudelka also ship `mods/preloaded`; the
Final Fantasy VIII and IX kits have none, which the kit build treats as
optional. Each Windows and Linux pair carries the same `game.toml` (In Cold
Blood and Koudelka differ only in Windows line endings), matching the
repository file at the tagged commit. `EXE_NAME` names the player. Each
`README-SETUP.txt` requires the retail BIOS below, and `[runtime] openbios` is
`false`.

## Discs

Each `game.toml` lists every disc's data-track size, CRC32, MD5 and SHA-1 under
`[prepare_disc]`, and its `discs` roster names each disc by its Redump file
name. Every value agrees with the Redump record, and a Redump search for each
SHA-1 returned only that disc.

| Title                                  | Disc | Serial     | Data track bytes | SHA-1       | Redump                                |
| -------------------------------------- | ---- | ---------- | ---------------- | ----------- | ------------------------------------- |
| Galerians (Europe)                     | 1    | SLES-02328 | 683,248,944      | `b35fe93b…` | [7420](https://redump.info/disc/7420) |
| Galerians (Europe)                     | 2    | SLES-12328 | 672,867,216      | `77637261…` | [7421](https://redump.info/disc/7421) |
| Galerians (Europe)                     | 3    | SLES-22328 | 595,923,888      | `3f0656c6…` | [7422](https://redump.info/disc/7422) |
| In Cold Blood (USA)                    | 1    | SLUS-01294 | 555,591,792      | `9a33a893…` | [1849](https://redump.info/disc/1849) |
| In Cold Blood (USA)                    | 2    | SLUS-01314 | 657,543,936      | `f788994d…` | [1850](https://redump.info/disc/1850) |
| Koudelka (Europe)                      | 1    | SLES-02897 | 542,302,992      | `43cfec26…` | [7357](https://redump.info/disc/7357) |
| Koudelka (Europe)                      | 2    | SLES-12897 | 527,073,792      | `8e779283…` | [7358](https://redump.info/disc/7358) |
| Koudelka (Europe)                      | 3    | SLES-22897 | 680,294,832      | `cab865b5…` | [7359](https://redump.info/disc/7359) |
| Koudelka (Europe)                      | 4    | SLES-32897 | 633,061,968      | `3a647314…` | [7360](https://redump.info/disc/7360) |
| Final Fantasy VIII (USA)               | 1    | SLUS-00892 | 732,271,680      | `5028a4f8…` | [69](https://redump.info/disc/69)     |
| Final Fantasy VIII (USA)               | 2    | SLUS-00908 | 692,932,128      | `2af26ce9…` | [70](https://redump.info/disc/70)     |
| Final Fantasy VIII (USA)               | 3    | SLUS-00909 | 721,356,048      | `94170034…` | [71](https://redump.info/disc/71)     |
| Final Fantasy VIII (USA)               | 4    | SLUS-00910 | 694,475,040      | `68a3e8e9…` | [72](https://redump.info/disc/72)     |
| Final Fantasy IX (USA, Canada) (Rev 1) | 1    | SLUS-01251 | 740,715,360      | `8b8feaf9…` | [4005](https://redump.info/disc/4005) |
| Final Fantasy IX (USA, Canada) (Rev 1) | 2    | SLUS-01295 | 689,004,288      | `232c9b94…` | [5030](https://redump.info/disc/5030) |
| Final Fantasy IX (USA, Canada) (Rev 1) | 3    | SLUS-01296 | 729,755,040      | `f7177bd1…` | [5028](https://redump.info/disc/5028) |
| Final Fantasy IX (USA, Canada) (Rev 1) | 4    | SLUS-01297 | 688,413,936      | `ce78c21e…` | [5029](https://redump.info/disc/5029) |

Every disc has one data track. The Final Fantasy VIII records cover both the
Original and Greatest Hits releases. The Final Fantasy IX Rev 1 records list
the Greatest Hits serials (`SLUS-01251GH` and so on); the catalog keeps the
boot serials the kit names. The In Cold Blood records report an errors count
of 2, which does not change the bound data-track values.

## What Core binds

Each title uses the explicit integration form of the precedent: the split-mods
persistent paths including `mods/texture-packs`, `runtime_source_filename:
"runtime-discs"`, the `psx-raw-set` materialization bound to a
`multi-disc-set` identity with each disc's data-track SHA-1 and a track count
of 1, `launch_disc_choice: "psx-settings-selected"`, and the retail BIOS
profile (`psx-scph-5552-bios` for Galerians and Koudelka, `psx-scph-1001-bios`
for the others). The source contracts apply to the exact Windows and Linux kit
digests above. Multi-disc titles stay outside the release-selection corpus.
The Mac kits stay upstream-owned with the upstream guide; they were not
downloaded.

The `7192402` runtime keeps the precedent's `[disc] selected` contract: it
mounts roster entry N and uses N for the save-state disc scope. Its in-game
menu can also insert another disc and rewrites `[disc] selected` in the
persistent `settings.toml`. The player copy therefore says to use the game's
own disc change if it offers one, or quit and choose Play with the next disc.
A `regional-launch.toml` in the player folder or up to four parents would
override the selected disc; no kit ships one.

## Alone in the Dark: The New Nightmare

Both European discs (SLES-02801, SLES-12801; Redump 892 and 893) have two
tracks, and the kit's `[netplay]` gate requires both. Core's managed
`psx-raw-set` materialization keeps only each disc's data track, and catalog
validation admits a managed PS1 set only when every disc has a single track.
The route cannot be expressed without a reviewed multi-track set form, so the
title stays listed only. Its `game.toml` also lists a third `known_sha1`
(`77bf47a7…`, 645,019,536 bytes) that matches no Redump track, and it sets no
`EXE_NAME`, so the player name is derived from the window title.

## Not observed

Native generation, gameplay, in-game or Play-time disc changes, saves, save
states, texture packs, and update or rollback with real data were not
observed. The provider digests and the Mac kits were not checked.
