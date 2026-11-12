# Quake II managed PSX route and listed-only Alexbeav kit fit

Dated evidence from November 12, 2026, under #2926 and #474. It adds managed
Windows and Linux x86-64 routes for Quake II through the reviewed
`psx_managed_windows_v1: true` form. It also records why other listed-only
Alexbeav PSXRecomp kits stay on their upstream guides. Release metadata came
from the hosted configured-upstream observer (run 43058926577). No upstream
program was executed and no original disc or BIOS was used.

## Quake II (#474)

| Kit                                     | Bytes      | Provider SHA-256 |
| --------------------------------------- | ---------- | ---------------- |
| `quake-ii-recomp-0.1.2-windows-x64.zip` | 29,903,257 | `dd9fc377…`      |
| `quake-ii-recomp-0.1.2-linux-x64.zip`   | 27,797,758 | `c3d3e196…`      |

Both kits from tag `v0.1.2` (commit `348015cc`) matched their provider SHA-256
and passed `portcove catalog inspect-package-layout` for their platform. The
Linux kit has no case-colliding paths.

- **Framework and layout:** both kits pin PSXRecomp `40ce4789`, the framework
  of the reviewed Tony Hawk's Pro Skater 3 route, and ship their packages under
  `mods/packages`. The `true` form's whole-`mods` persistence and generated
  `build-portcove` player apply unchanged.
- **Disc:** both kits carry the same `game.toml`: SLUS-00757 with two tracks,
  first data track 323,642,256 bytes, SHA-1 `f936e7cc…`. [Redump disc
  6643](https://redump.info/disc/6643) lists Quake II (USA), SLUS-00757, with
  two tracks; track 1 size, SHA-1, MD5 and CRC32 agree with the kit. Core binds
  the first data track and the track count.
- **BIOS:** `README-SETUP.txt` requires a retail SCPH-1001 BIOS and states that
  OpenBIOS is not supported.
- **Generated player:** the kit sets no `EXE_NAME`, so the framework derives the
  player name from the window title "Quake II Recompiled" with CMake's
  `MAKE_C_IDENTIFIER`: `Quake_II_Recompiled` (`.exe` on Windows).
- **Corpus:** enrolled with the real `v0.1.2` kits and a labelled synthetic
  `v999.123.456` successor. The Mac kits stay upstream-owned.

## Listed-only kits inspected and held

| Title                              | Kit                          | Hold and resume condition                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suikoden (#481)                    | v0.1.1, framework `a839474e` | Requires the European SCPH-5552 BIOS but keeps the older whole-`mods/packages` layout, with user installs in the same folder as the kit's packages. No reviewed form combines the two; it needs an explicit kit-fit review. |
| Silent Bomber (#478)               | v0.1.1, framework `a839474e` | Same SCPH-5552 and whole-`mods` combination.                                                                                                                                                                                |
| Mortal Kombat Trilogy (#468)       | v0.1.1, framework `a839474e` | Same combination, with 30 tracks.                                                                                                                                                                                           |
| Devil Dice (#1591)                 | v0.1.0, framework `5420458a` | The split-mods layout fits, but a prerelease disc shares the retail first data track and 12-track count. Core's binding would admit it as the retail disc. Resume with a binding that distinguishes them.                   |
| AC: Master of Arena (#1585)        | v0.1.0, framework `5420458a` | Multi-disc. No reviewed split-mods route covers a disc set.                                                                                                                                                                 |
| Fear Effect 2: Retro Helix (#1594) | v0.1.0, framework `5420458a` | Multi-disc, as above.                                                                                                                                                                                                       |

Final Fantasy VIII, Final Fantasy IX, Wipeout XL and Vib-Ribbon were not
downloaded for this record.

## Not observed

Native generation, gameplay, saves, and update or rollback with real data were
not observed.
