# Five PS1 titles on PSXRecomp 031868cc and 7192402: managed Windows and Linux routes

Dated evidence from November 13, 2026, under #2926, #448, #457, #469, #473 and
#491. It adds managed Windows and Linux x86-64 routes for five Alexbeav
PSXRecomp titles that were listed only. Each listing keeps its ID and issue.
No upstream program was executed, and no original disc or BIOS was used.

## Kits

Each kit is from the newest tag by `git ls-remote`, fetched from the release
download URL. Every kit's SHA-256 matches the release's `SHA256SUMS.txt`. The
release API is blocked by this session's proxy, so provider release digests,
asset IDs and the prerelease flag were not read.

| Title (issue)                  | Tag      | Commit     | Windows kit bytes, SHA-256 | Linux kit bytes, SHA-256 | Framework  | Player                               |
| ------------------------------ | -------- | ---------- | -------------------------- | ------------------------ | ---------- | ------------------------------------ |
| Fighting Force (#448)          | `v0.1.3` | `afbbbb06` | 47,782,128, `4e986f79…`    | 45,590,045, `0ad37f49…`  | `031868cc` | `Fighting_Force__Recompiled`         |
| Jackie Chan Stuntmaster (#457) | `v0.1.3` | `9c60d7f7` | 47,787,843, `c828aa7c…`    | 45,595,210, `a60aaaad…`  | `031868cc` | `Jackie_Chan_Stuntmaster_Recompiled` |
| Metal Slug X (#469)            | `v0.1.3` | `4d6cc56a` | 47,786,925, `ca2c5481…`    | 45,594,831, `02024ce3…`  | `031868cc` | `Metal_Slug_X__Recompiled`           |
| Parasite Eve (#473)            | `v0.4.1` | `aa070962` | 47,932,161, `06efae8f…`    | 45,740,193, `d90ca4b1…`  | `7192402`  | `Parasite_Eve`                       |
| Valkyrie Profile (#491)        | `v0.1.4` | `3f9b39fe` | 47,703,176, `66db6912…`    | 45,594,047, `554b7f0a…`  | `7192402`  | `Valkyrie_Profile_Recompiled`        |

The Valkyrie Profile tag is a lightweight tag on that commit; the others are
annotated tags whose commit is shown.

Static inspection of every Windows and Linux kit found:

- **Framework:** `framework_pins.txt` and `project-manifest.toml` name the
  framework above and recomp-ui `14799da`. The three `031868cc` Linux kits
  have identical `psxrecomp` trees. The two `7192402` Linux kits differ only
  in the framework's unselected OpenBIOS files, which the Parasite Eve kits
  carry, as other `7192402` kits do. Per-file comparison found the
  `runtime/src`, `runtime/include`, `host` and `recompiler/src` trees and
  `psxrecomp_cli.py` identical across both frameworks; the `031868cc` trees
  differ from `7192402` only in five `runtime/tests` files and
  `tools/stage_setup_sdk.sh`, as the
  [builder downloads record](psxrecomp-7192402-builder-downloads-2026-11-13.md)
  describes.
- **`game.toml`:** each Linux kit carries the file of the tagged commit
  unchanged. The Windows kits differ only in CRLF line endings, except
  Valkyrie Profile, whose two copies are the same bytes.
- **BIOS:** every kit sets `bios_config = "psxrecomp/bios/SCPH1001.toml"`,
  `openbios = false` and `bios_hle = false`. `CMakeLists.txt` accepts only the
  `SCPH1001` stem, and `README-SETUP.txt` requires the player's own SCPH-1001
  (USA) dump with SHA-256 `71af94d1…` (524,288 bytes), the existing
  `psx-scph-1001-bios` profile. Core's `kit_bios_profile` maps that stem to
  the same profile.
- **Player:** Valkyrie Profile sets `EXE_NAME`. The others derive the name
  from `WINDOW_TITLE`, whose spaces become `_`: "Fighting Force Recompiled"
  and "Metal Slug X Recompiled" have two spaces, and "Parasite Eve" gives
  `Parasite_Eve`. Each root setup host has the same basename.
- **Layout:** `mods/bundled` holds the same 11 generic `psx.*` packages in
  every kit, `mods/preloaded/packages` is empty, and
  `mods/texture-packs/<serial>/{dumps,replacements}` are empty. There is no
  flat `mods/packages`, no link, no absolute or `..` entry and no
  case-colliding path. No bundled package enables playtest diagnostics. The
  Windows kits also have an empty `cache/<serial>/datashards` folder at the kit
  root, outside the `build-portcove` runtime.

## Discs

Each value below is a data-track value from `[prepare_disc]` and agrees with
Redump in size, CRC32, MD5 and SHA-1. A Redump search for each SHA-1 resolves
only to that disc.

| Title                   | Disc | Serial     | Tracks | Data track bytes | SHA-1       | Redump                                  |
| ----------------------- | ---- | ---------- | ------ | ---------------- | ----------- | --------------------------------------- |
| Fighting Force (Rev 2)  | 1    | SLUS-00433 | 27     | 231,888,384      | `0f1491ec…` | [16730](https://redump.info/disc/16730) |
| Jackie Chan Stuntmaster | 1    | SLUS-00684 | 1      | 627,972,240      | `afa11e3b…` | [7374](https://redump.info/disc/7374)   |
| Metal Slug X            | 1    | SLUS-01212 | 1      | 104,315,904      | `f1ea9a0a…` | [7410](https://redump.info/disc/7410)   |
| Parasite Eve            | 1    | SLUS-00662 | 1      | 495,531,120      | `c339455d…` | [116](https://redump.info/disc/116)     |
| Parasite Eve            | 2    | SLUS-00668 | 1      | 646,877,616      | `6dc5b537…` | [117](https://redump.info/disc/117)     |
| Valkyrie Profile        | 1    | SLUS-01156 | 1      | 730,448,880      | `fa13cbde…` | [655](https://redump.info/disc/655)     |
| Valkyrie Profile        | 2    | SLUS-01179 | 1      | 747,352,704      | `7cc65766…` | [656](https://redump.info/disc/656)     |

All titles are USA releases. Fighting Force has one data track and 26 audio
tracks, and its kit's `required_tracks` is 27. Its second `known_sha1`
(`198a7e0a…`, 745,290,000 bytes) is a merged single-image value; its CRC32
matches Redump's merged image. The route binds only the first data track and
the track count, as the MediEvil II route does for its two tracks. Because
the disc is single, this needs no multi-track disc-set support.

## Routes

- **Fighting Force, Jackie Chan Stuntmaster, Metal Slug X:** the `"split-mods"`
  form of `psx_managed_windows_v1`, like the
  [MediEvil II setup-kit route](medievil-ii-psxrecomp-managed-2026-11-13.md).
- **Parasite Eve, Valkyrie Profile:** the explicit multi-disc integration of
  the [six-title record](psx-multi-disc-7192402-six-titles-2026-11-13.md):
  the split-mods paths, `runtime_source_filename: "runtime-discs"`, the
  `psx-raw-set` materialization bound to a `multi-disc-set` identity of each
  disc's data-track SHA-1 with a track count of 1, and
  `launch_disc_choice: "psx-settings-selected"`. Both join the Core test that
  lists the ports with a settings disc choice.

Every route uses the `psx-scph-1001-bios` profile, the `stable` channel and the
selectors `<asset prefix>` plus `-windows-x64.zip` or `-linux-x64.zip`, which
are the existing listing selectors. No Core change was needed. The routes
declare `mods/texture-packs`, so delivered definitions need managed PS1
capability 3 ([texture-pack record](psxrecomp-texture-pack-scope-2026-11-13.md)).

## Catalog changes

- **Source profiles:** new `alexbeav-fighting-force-recomp-usa-rev-2-psx`
  (27 tracks), `alexbeav-jackie-chan-stuntmaster-recomp-usa-psx`,
  `alexbeav-parasite-eve-recomp-usa-psx` and
  `alexbeav-valkyrie-profile-recomp-usa-psx`. Metal Slug X reuses the existing
  `metal-slug-x-psx` profile, whose single-track SHA-1 is already
  `f1ea9a0a…`; its `legacy-accepted` variant gains product code `SLUS-01212`
  and the new evidence. Product codes do not change the schema-1 projection.
  The other port on that profile, `metal-slug-x-recompiled`, is unchanged.
- **Evidence:** one `-static-contract` record per title for its kits and one
  Redump record per disc.
- **Source contracts:** a new game and BIOS contract per port, each applying
  to the exact Windows and Linux kit SHA-256s and tag. No port had a contract
  before.
- **Player copy:** each listing asks for the player's own disc or disc set
  and retail SCPH-1001 BIOS, says Portcove builds the player, and keeps the
  Mac kit upstream-owned. The Parasite Eve copy says that upstream reports
  each disc starting but no tested change to Disc 2 during play. Valkyrie
  Profile was never listed for Mac, so its listing now has no upstream-owned
  platform; its preparation text says upstream confirmed one change to Disc 2
  on an earlier build (the kit's `docs/DISC2_FIX.md`) and that this
  version's disc changes are untested.
- **Reviewed additions:** the five ports and four new profiles join the
  legacy-additions fixture.

## Not changed here

- **Release-selection corpus:** not enrolled, for the same reason as MediEvil
  II: provider release and asset IDs, publication times and digests could not
  be observed. Multi-disc titles stay outside the corpus.
- **Mac:** the Mac kits of all five tags were not downloaded. Valkyrie Profile
  `v0.1.4` publishes Mac kits, but adding a Mac listing for it is left to a
  separate review.

## Uncertain

The tags have no prerelease suffix, but GitHub's prerelease flag is unknown.
If a tag is flagged as a prerelease, the `stable` channel would select an
older stable tag, whose assets were not checked against these selectors. If
those assets do not match, nothing is installed; if they do, an older kit
would be built. Confirm the flags when these routes are enrolled in the
release-selection corpus.

## Not observed

Nothing was built or run. No disc, BIOS, gameplay, disc change, save, save
state, texture pack, update, rollback or backup was observed. Core's
package-layout inspection was not run on these kits.
