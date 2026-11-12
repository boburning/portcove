# Wipeout XL (NJH-1001) through split mods with bundled OpenBIOS

Dated evidence from November 12, 2026, under #2926 and #1908. It adds the
reviewed `psx_managed_windows_v1: "split-mods-openbios"` authoring variant and
uses it for managed Windows and Linux x86-64 Wipeout XL routes. Release metadata
came from the hosted configured-upstream observer (run 43058926577). No upstream
program was executed and no original disc was used.

## The variant

The two existing forms each cover half of this kit:

- `"split-mods"` projects the player-owned `mods/installed`, `mods/packages`,
  `mods/.staging`, `mods/state.toml` and `mods/state.toml.tmp` paths, keeps
  `mods/bundled` with each runtime version and requires both x64 selectors, but
  requires a retail BIOS.
- `"bundled-openbios"` projects `--no-launcher --bios bios/openbios.bin` and
  refuses a retail BIOS profile, but keeps the whole-`mods` scope.

`"split-mods-openbios"` applies both: the split mod paths and selector checks,
plus the OpenBIOS argument and the refusal of a retail profile. It adds no Core
behavior. Core already binds no BIOS when a definition has no
`bios_source_profile`, and the OpenBIOS route passes the kit's own image.

## Wipeout XL (#1908)

| Kit                               | Bytes      | Provider SHA-256 |
| --------------------------------- | ---------- | ---------------- |
| `wipeoutxl-0.2.0-windows-x64.zip` | 45,448,914 | `effe49cb…`      |
| `wipeoutxl-0.2.0-linux-x64.zip`   | 46,036,395 | `ee0e2ce8…`      |

Both kits from tag `v0.2.0` (commit `9d3fd26e`) matched their provider SHA-256
and passed `portcove catalog inspect-package-layout`. The Linux kit has no
case-colliding paths.

- **Disc:** both kits carry the same `game.toml`: SCUS-94351 with 12 tracks,
  first data track 86,045,568 bytes, SHA-1 `5694008c…`. [Redump disc
  5649](https://redump.info/disc/5649) lists Wipeout XL (USA), SCUS-94351, with
  12 tracks; track 1 size, SHA-1, MD5 and CRC32 agree. Core binds the first
  data track and the track count.
- **BIOS:** `game.toml` has no retail `bios_config`. `README-SETUP.txt` makes a
  retail SCPH-1001 BIOS optional and otherwise uses the shipped
  `psxrecomp/bios/openbios.bin`, which `OpenBIOS.toml` marks as MIT-licensed and
  redistributable.
- **Framework and layout:** the kits pin PSXRecomp `8d56cf65`. Its runtime path
  literals match the reviewed split-mods framework `5420458a` (Future Cop:
  L.A.P.D.) apart from BIOS discovery names and `gamecontrollerdb.txt`, which
  the player only reads from beside itself. Both ship `mods/bundled` and
  `mods/preloaded`. The PSXRecomp licence is the same PolyForm Noncommercial
  licence as the already managed Alexbeav kits.
- **Generated player:** the kit sets no `EXE_NAME`, so the framework derives
  `Wipeout2K97XL` from the window title (`.exe` on Windows), the player the
  existing upstream guide names.
- **Existing copies:** the upstream completed-player registration route stays
  available and is still exercised by its lifecycle test.
- **Corpus:** enrolled with the real `v0.2.0` kits, a labelled synthetic
  `v999.123.456` successor and a `managed_psx` expectation for OpenBIOS and
  split mod paths. The Mac kits stay outside the managed route.

## Not observed

Native generation, gameplay, saves, and update or rollback with real data were
not observed.
