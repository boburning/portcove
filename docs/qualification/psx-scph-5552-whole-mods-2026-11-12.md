# SCPH-5552 whole-mods PSX kits: Suikoden, Silent Bomber and Mortal Kombat Trilogy

Dated evidence from November 12, 2026, under #2926. It widens the reviewed
`psx_managed_windows_v1: true` form to accept an explicit retail SCPH-5552 BIOS
and adds managed Windows and Linux x86-64 routes for three titles that the
[Quake II record](quake-ii-psx-managed-2026-11-12.md) held. Release metadata came
from the hosted configured-upstream observer (run 43058926577). No upstream
program was executed and no original disc or BIOS was used.

## Why the form change is safe

The `true` form already owns the whole-`mods` persistence, the generated
`build-portcove` player, `--no-launcher`, the overlay environment and the
disposable diagnostics for kits on PSXRecomp `40ce4789` (Tony Hawk's Pro
Skater 3, Quake II). The three kits below pin PSXRecomp `a839474e` and ship the
same whole `mods/packages` layout.

- **Writer paths:** the file and folder literals in the two frameworks'
  `runtime/src` and `runtime/include` trees are identical apart from BIOS
  discovery. `40ce4789` hard-codes SCPH-1001 filename candidates, a SCPH-1001
  size and CRC check in its setup host and a `bios/SCPH1001.BIN` default in
  `runtime.cmake`; `a839474e` names `SCPH5552.BIN` instead. These affect only
  first-run BIOS discovery, not where player data is written.
- **BIOS staging:** Core's `psx-recomp-managed` preparation reads the kit's own
  `[recompiler] bios_config` from `game.toml` and stages the BIOS that profile
  names. Nothing in that path depends on the authoring form. The `split-mods`
  form already relies on it for SCPH-5552 kits such as Future Cop: L.A.P.D.
- **BIOS identity:** each kit's `README-SETUP.txt` requires the SCPH-5502/5552
  Europe BIOS with SHA-256 `1faaa18f…`, the existing `psx-scph-5552-bios`
  profile.

The form now accepts `psx-scph-1001-bios` or `psx-scph-5552-bios` for `true`.
`bundled-openbios` still refuses any retail profile, and other BIOS profiles
are still refused.

## Titles

All six kits matched their provider SHA-256 and passed
`portcove catalog inspect-package-layout` for their platform. The Linux kits
have no case-colliding paths. Each Windows and Linux pair carries the same
`game.toml` and sets `EXE_NAME` for the `psx-runtime` target. Redump
corroborates every first data track, and a Redump SHA-1 search resolves to that
single disc.

| Title (issue)                | Tag, commit        | Disc                                                     | Redump                                | Player                             |
| ---------------------------- | ------------------ | -------------------------------------------------------- | ------------------------------------- | ---------------------------------- |
| Suikoden (#481)              | v0.1.1, `4db9b62c` | SLUS-00292 (USA) (Rev 1), 1 track, `409453aa…`           | [7712](https://redump.info/disc/7712) | `Suikoden_Recompiled`              |
| Silent Bomber (#478)         | v0.1.1, `bc491c6c` | SLES-02792 (Europe), 1 track, `c9293c68…`                | [3617](https://redump.info/disc/3617) | `Silent_Bomber_Recompiled`         |
| Mortal Kombat Trilogy (#468) | v0.1.1, `4bd910c2` | SLUS-00330 (USA) (Rev 1), 30 tracks, track 1 `aa9b7e17…` | [469](https://redump.info/disc/469)   | `Mortal_Kombat_Trilogy_Recompiled` |

Mortal Kombat Trilogy's `game.toml` also lists a second 577,190,208-byte image
(`b1f8cf90…`) that matches no Redump track. Its size equals the full Redump
disc, so it is most likely the same disc merged into one file. Core binds only the Redump Rev 1
first data track and its 30-track count, so the managed route accepts the
complete Redump disc in a CHD. Its other tracks are carried into preparation
without authenticating their audio content.

Each title is enrolled in the shared release-selection corpus with the real
v0.1.1 kits, a labelled synthetic `v999.123.456` successor, and a `managed_psx`
expectation for the SCPH-5552 profile. The Mac kits stay upstream-owned.

## Not observed

Native generation, gameplay, saves, and update or rollback with real data were
not observed.
