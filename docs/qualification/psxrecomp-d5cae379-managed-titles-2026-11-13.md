# Fifteen PS1 titles on PSXRecomp d5cae379: managed Windows and Linux routes

Dated evidence from November 13, 2026, under #2926. It adds managed Windows
and Linux x86-64 routes for 15 Alexbeav PSXRecomp titles that were listed
only, and records why four more stay upstream-owned. Each listing keeps its
ID and issue. No upstream program was executed, and no original disc or BIOS
was used.

## Framework

Every kit pins PSXRecomp `d5cae379db84bbce3696a61a89ed06989b18bed0` and
recomp-ui `14799da`. A static tree diff found `d5cae379` identical to the
reviewed `7192402` for Portcove's purposes. It changes only GPU rendering: a
depth24 movie-row copy fix and a fix for thin triangles above 1x internal
scale. It also adds runtime tests. The build CLI, `release_stage.py`,
`runtime.cmake`, the recompiler, the setup host, the launch path, the
`game.toml` schema and the runtime writers are unchanged. The
[7192402 records](psxrecomp-7192402-builder-downloads-2026-11-13.md), the
split-mods projection and the
[multi-track disc-set record](psx-multi-track-disc-sets-2026-11-13.md)
therefore apply unchanged. That diff used depth-1 fetches, so it does not show
that `d5cae379` descends from `7192402`.

## Kits

Each kit is from the newest tag by `git ls-remote`, fetched from the release
download URL. Every kit's SHA-256 matches the release's `SHA256SUMS.txt`. The
release API is blocked by this session's proxy, so provider release digests,
asset IDs and the prerelease flag were not read. Every tag is annotated; the
table shows its commit.

| Title (issue)                    | Tag      | Commit     | Windows kit bytes, SHA-256 | Linux kit bytes, SHA-256 | BIOS      | Player                                               |
| -------------------------------- | -------- | ---------- | -------------------------- | ------------------------ | --------- | ---------------------------------------------------- |
| Apocalypse (#430)                | `v0.1.3` | `c2223f7b` | 47,816,582, `d84758b0…`    | 45,751,002, `de87f7e2…`  | SCPH-5552 | `Apocalypse_Recompiled`                              |
| Colony Wars (#437)               | `v0.1.3` | `9b9f1255` | 47,814,837, `412c6cf6…`    | 45,748,251, `7dc07ebb…`  | SCPH-1001 | `Colony_Wars_Recompiled`                             |
| Crash Bandicoot 3: Warped (#439) | `v0.1.3` | `a50db59d` | 47,814,520, `813baad5…`    | 45,747,252, `bd706cb8…`  | SCPH-1001 | `Crash_Bandicoot_3__Warped_Recompiled`               |
| Fear Effect (#447)               | `v0.1.3` | `4f2beedd` | 47,817,136, `1c754aaa…`    | 45,750,561, `5bf9cec9…`  | SCPH-1001 | `Fear_Effect_Recompiled`                             |
| G-Police (#452)                  | `v0.1.3` | `d9bd79f1` | 47,815,834, `25606e62…`    | 45,749,262, `4c84627e…`  | SCPH-1001 | `G_Police_Recompiled`                                |
| Ghost in the Shell (#451)        | `v0.1.3` | `f87a1092` | 47,813,980, `2bf2f49e…`    | 45,748,468, `3f9f66c3…`  | SCPH-5552 | `Ghost_in_the_Shell_Recompiled`                      |
| Martian Gothic (#460)            | `v0.1.3` | `0b35bcb5` | 47,817,423, `3e08915c…`    | 45,752,433, `d071cd78…`  | SCPH-5552 | `Martian_Gothic_Recompiled`                          |
| Metal Gear Solid (#466)          | `v0.1.3` | `5e655aa5` | 47,818,931, `96eaace9…`    | 45,752,342, `24b28ad0…`  | SCPH-1001 | `Metal_Gear_Solid_Recompiled`                        |
| Monster Rancher (#467)           | `v0.1.3` | `ed5afdab` | 47,817,071, `839901bc…`    | 45,749,296, `6ba2f6e6…`  | SCPH-1001 | `Monster_Rancher_Recompiled`                         |
| R-Type Delta (#471)              | `v0.1.3` | `8a6874f8` | 47,813,394, `e1b8edbc…`    | 45,746,850, `357dfe20…`  | SCPH-1001 | `R_Type_Delta_Recompiled`                            |
| Spider-Man (#476)                | `v0.1.3` | `3e9f90c6` | 47,816,507, `825a3b6a…`    | 45,749,927, `7244c695…`  | SCPH-1001 | `Spider_Man_Recompiled`                              |
| Star Wars Episode I (#480)       | `v0.1.3` | `9921d6c1` | 47,815,898, `e784073d…`    | 45,750,548, `57546b0e…`  | SCPH-5552 | `Star_Wars_Episode_I__The_Phantom_Menace_Recompiled` |
| The Fifth Element (#482)         | `v0.1.3` | `a85e6d21` | 47,813,441, `04e13ecd…`    | 45,746,986, `4f507d44…`  | SCPH-5552 | `The_Fifth_Element_Recompiled`                       |
| Threads of Fate (#486)           | `v0.1.3` | `baaf87d8` | 47,818,216, `22754eef…`    | 45,750,448, `29975320…`  | SCPH-1001 | `Threads_of_Fate_Recompiled`                         |
| Tokyo Highway Battle (#490)      | `v0.1.3` | `3a76094f` | 47,814,699, `451a1ca9…`    | 45,746,807, `379b2d7c…`  | SCPH-1001 | `Tokyo_Highway_Battle_Recompiled`                    |

The full SHA-256s are in each title's `-v013-static-contract` evidence record
and in its game and BIOS source contracts.

Static inspection of every Windows and Linux kit found:

- **Framework:** `framework_pins.txt` and `project-manifest.toml` name
  `d5cae379` and recomp-ui `14799da` in both kits of every title. All 15
  Linux kits list the same `psxrecomp` and `recomp-ui` files, including the
  framework's unselected OpenBIOS files. File contents were not compared
  between kits.
- **`game.toml`:** both kits of every title carry the file of the tagged
  commit byte for byte. `CMakeLists.txt` also matches the tagged file.
- **BIOS:** each kit sets `bios_config` to `psxrecomp/bios/SCPH1001.toml` or
  `psxrecomp/bios/SCPH5552.toml` and `openbios = false`. `CMakeLists.txt`
  accepts only that stem, and `README-SETUP.txt` and `project-manifest.toml`
  require the player's own retail dump: SCPH-1001 (USA) with SHA-256
  `71af94d1…` or SCPH-5552 (Europe) with SHA-256 `1faaa18f…`, each 524,288
  bytes. These are the existing `psx-scph-1001-bios` and `psx-scph-5552-bios`
  profiles, and Core's `kit_bios_profile` maps each stem to the same profile.
- **Threads of Fate and `bios_hle`:** its kit also sets
  `[runtime] bios_hle = true`. Its `SCPH1001.toml` declares the
  `deliver_event_ret` and `shell_entry_phys` anchors. As for the reviewed
  [Mega Man Legends route](psxrecomp-7192402-retail-bios-2026-11-13.md),
  the optional high-level tier runs over the recompiled retail BIOS. That
  BIOS stays a required build and launch input. Every other kit sets
  `bios_hle = false`.
- **Player:** every kit sets `EXE_NAME`, shown in the table. The setup host at
  the kit root has the same basename.
- **Layout:** `mods/bundled` holds the same 11 generic `psx.*` packages in
  every kit. The empty folders `mods/texture-packs/<serial>/dumps` and
  `mods/texture-packs/<serial>/replacements` are present. There is no
  `mods/preloaded` folder. PSXRecomp's `runtime.cmake` then stages only the
  framework packages, so a missing folder is not an error. There is no flat
  `mods/packages`, no link, no absolute or `..` entry and no case-colliding
  path. No bundled package manifest mentions diagnostics. The Windows kits also
  have an empty `cache/<serial>/datashards` folder at the kit root, outside
  the `build-portcove` runtime.

## Discs

Each value below is a data-track value from `[prepare_disc]`. Each agrees with
Redump in size, CRC32, MD5 and SHA-1, and each track count equals the kit's
`required_tracks`. A Redump search for each SHA-1 resolves only to that disc.
No disc's Redump page lists LibCrypt protection.

| Title                         | Disc | Serial     | Tracks | Data track bytes | SHA-1       | Redump                                  |
| ----------------------------- | ---- | ---------- | ------ | ---------------- | ----------- | --------------------------------------- |
| Apocalypse (Europe)           | 1    | SLES-00460 | 2      | 459,223,296      | `f0ee4a74…` | [1679](https://redump.info/disc/1679)   |
| Colony Wars (USA)             | 1    | SLUS-00543 | 2      | 525,650,832      | `5ad8f6a6…` | [387](https://redump.info/disc/387)     |
| Colony Wars (USA)             | 2    | SLUS-00554 | 2      | 642,091,296      | `723491c2…` | [388](https://redump.info/disc/388)     |
| Crash Bandicoot 3 (USA)       | 1    | SCUS-94244 | 1      | 285,130,608      | `ae57f60f…` | [5006](https://redump.info/disc/5006)   |
| Fear Effect (USA)             | 1    | SLUS-00920 | 1      | 487,435,536      | `e96eb6d8…` | [1267](https://redump.info/disc/1267)   |
| Fear Effect (USA)             | 2    | SLUS-01056 | 1      | 505,757,616      | `0c2ffb3d…` | [1268](https://redump.info/disc/1268)   |
| Fear Effect (USA)             | 3    | SLUS-01057 | 1      | 451,666,320      | `a4205816…` | [1269](https://redump.info/disc/1269)   |
| Fear Effect (USA)             | 4    | SLUS-01058 | 1      | 509,955,936      | `bc1762d5…` | [1270](https://redump.info/disc/1270)   |
| G-Police (USA)                | 1    | SLUS-00544 | 1      | 730,742,880      | `2161d286…` | [7333](https://redump.info/disc/7333)   |
| G-Police (USA)                | 2    | SLUS-00556 | 1      | 728,964,768      | `7f6ba87d…` | [1865](https://redump.info/disc/1865)   |
| Ghost in the Shell (Eur.)     | 1    | SCES-01050 | 1      | 655,620,000      | `4d996a3b…` | [6179](https://redump.info/disc/6179)   |
| Martian Gothic (Europe)       | 1    | SLES-01350 | 1      | 660,582,720      | `7ac0f376…` | [1260](https://redump.info/disc/1260)   |
| Metal Gear Solid (Rev 1)      | 1    | SLUS-00594 | 1      | 705,614,112      | `37498e65…` | [104](https://redump.info/disc/104)     |
| Metal Gear Solid (Rev 1)      | 2    | SLUS-00776 | 1      | 731,911,824      | `d6edfd60…` | [105](https://redump.info/disc/105)     |
| Monster Rancher (USA)         | 1    | SLUS-00568 | 2      | 325,022,880      | `e79b66e3…` | [18824](https://redump.info/disc/18824) |
| R-Type Delta (USA)            | 1    | SLUS-00877 | 1      | 339,381,840      | `33bec6c0…` | [455](https://redump.info/disc/455)     |
| Spider-Man (USA)              | 1    | SLUS-00875 | 1      | 729,736,224      | `65f186e0…` | [2324](https://redump.info/disc/2324)   |
| Star Wars Episode I (Eur.)    | 1    | SLES-02034 | 1      | 675,430,896      | `e811ef4d…` | [7233](https://redump.info/disc/7233)   |
| The Fifth Element (Eur.)      | 1    | SCES-01285 | 10     | 354,378,192      | `71d5d3ce…` | [1837](https://redump.info/disc/1837)   |
| Threads of Fate (USA, Canada) | 1    | SLUS-01019 | 1      | 357,454,608      | `375e4a34…` | [158](https://redump.info/disc/158)     |
| Tokyo Highway Battle (USA)    | 1    | SLUS-00229 | 8      | 220,676,400      | `580ab877…` | [7496](https://redump.info/disc/7496)   |

Three kits also list a merged single-image value: Apocalypse (491,857,296
bytes, `5c105ed3…`), Colony Wars Disc 1 (559,559,616 bytes, `192d0789…`) and
The Fifth Element (704,221,728 bytes, `c449beb4…`). Each CRC32 equals Redump's
merged `.img` value, and a Redump search for each SHA-1 finds no disc. The
routes bind none of them.

On the single discs with more than one track (Apocalypse, Monster Rancher,
The Fifth Element and Tokyo Highway Battle), track 1 is data and the others
are audio. Each route binds the first data track and the track count, as the
MediEvil II and Wipeout XL (NJH-1001) routes do. Both Colony Wars discs have one data
track and one audio track.

## Routes

- **Single discs (11 titles):** the `"split-mods"` form of
  `psx_managed_windows_v1`, like the
  [MediEvil II setup-kit route](medievil-ii-psxrecomp-managed-2026-11-13.md).
- **Disc sets (Colony Wars, Fear Effect, G-Police, Metal Gear Solid):** the
  explicit multi-disc integration of the
  [six-title record](psx-multi-disc-7192402-six-titles-2026-11-13.md). It uses
  the split-mods paths, `runtime_source_filename: "runtime-discs"` and
  `launch_disc_choice: "psx-settings-selected"`. Its `psx-raw-set`
  materialization is bound to a `multi-disc-set` identity of each disc's
  data-track SHA-1 and track count. Colony Wars uses a count of 2, like Alone
  in the Dark: The New Nightmare, so its delivered definition needs managed
  PS1 capability 4. The other three use a count of 1. All four join the Core
  test that lists the ports with a settings disc choice.

Every route uses the existing BIOS profile above, the `stable` channel and
the existing listing selectors `<asset prefix>` plus `-windows-x64.zip` or
`-linux-x64.zip`. No Core change was needed. The routes declare
`mods/texture-packs`, so delivered definitions need managed PS1 capability 3
([texture-pack record](psxrecomp-texture-pack-scope-2026-11-13.md)).

## Catalog changes

- **Source profiles:** 15 new profiles, one per title. No existing profile
  held any of these SHA-1s.
- **Evidence:** one `-v013-static-contract` record per title for its kits and
  one Redump record per disc.
- **Source contracts:** a new enforced game and BIOS contract per port. Each
  applies to the exact Windows and Linux kit SHA-256s and tag. No port had a
  contract before.
- **Player copy:** each listing asks for the player's own disc or disc set and
  retail BIOS, and says Portcove builds the player. It also says that a
  separately prepared upstream copy can be used. The Mac kits stay
  upstream-owned with their own steps.
- **Reviewed additions:** the 15 ports and 15 profiles join the
  legacy-additions fixture.

## Deferred

These titles keep their listing-only upstream route.

| Title (issue)          | Tag      | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Devil Dice (#1591)     | `v0.1.2` | The issue's November 12 hold on disc identity still applies. The kit's SCES-01312 first data track (`73caf9f7…`, 12 tracks) is shared by retail Redump disc [6565](https://redump.info/disc/6565) and prerelease [107981](https://redump.info/disc/107981), and a Redump search for it returns both. Core binds only the first data track and the track count, so an enforced contract would admit the prerelease. Telling them apart would need per-track identities in Core. |
| Resident Evil 3 (#477) | `v0.1.3` | The kit's SLES-02529 disc is LibCrypt-protected (Redump [496](https://redump.info/disc/496)). Its README requires the matching SBI file beside the CUE, with the same basename. The managed route takes the disc as a CHD and gives the kit no SBI file. No authoring form or Core path supplies one, so the title would need a Core change.                                                                                                                                   |
| Vib-Ribbon (#495)      | `v0.1.3` | The issue records a managed-enrollment hold because no rights grant is attributable to the kit's title code. That hold is respected. The kit otherwise has the same form as the qualified titles (SCES-02873, 8 tracks, SCPH-5552).                                                                                                                                                                                                                                            |
| Wipeout XL (#497)      | `v0.1.3` | The issue records the same rights hold for managed enrollment, and it is respected. The kit otherwise has the same form (SCUS-94351, 12 tracks, SCPH-1001). The separate managed NJH-1001 route (#1908) is unchanged.                                                                                                                                                                                                                                                          |

Crash Bandicoot 3's issue also records a rejected `v0.1.0` to `v0.1.1`
proof-target pair. That decision covers proving update progression, not the
managed route. The BIOS mismatch it describes is gone in `v0.1.3`, which
configures and accepts only SCPH-1001.

## Not changed here

- **Release-selection corpus:** not enrolled, for the same reason as MediEvil
  II. Provider release and asset IDs, publication times and digests could not
  be observed. Disc sets stay outside the corpus.
- **Mac:** the Mac kits were not downloaded. Their listings keep the upstream
  guide.

## Uncertain

The tags have no prerelease suffix, but GitHub's prerelease flag is unknown.
If a tag is flagged as a prerelease, the `stable` channel would select an
older stable tag. That tag's assets were not checked against these selectors.
Either way, nothing is built. The game and BIOS contracts are enforced and
bind only the kits above. An older kit has no applicable contract, so its disc
and BIOS are reported as not bound to that release. Confirm the flags when
these routes are enrolled in the release-selection corpus.

## Not observed

Nothing was built or run. No disc, BIOS, gameplay, disc change, music, save,
save state, texture pack, update, rollback or backup was observed. Rendering
differences between `d5cae379` and `7192402` above 1x were not observed.
Core's package-layout inspection was not run on these kits. Kit file contents
other than the inspected text members were not compared between kits.
