# Multi-disc PS1 launch disc choice, AC: Master of Arena and Fear Effect 2

Dated evidence from November 12, 2026, under #2926, #1585, #1594 and #427. It
adds a reviewed launch disc choice for managed multi-disc PSXRecomp kits and
managed Windows and Linux x86-64 routes for two multi-disc titles that the
[Quake II record](quake-ii-psx-managed-2026-11-12.md) held. Release metadata
came from the hosted configured-upstream observer (run 43058926577). No
upstream program was executed and no original disc or BIOS was used.

## How a disc is chosen

Managed PS1 launches pass `--no-launcher`, so the upstream launcher's disc
list never appears. Before this change a managed multi-disc set could only
start the disc the game had saved, which is disc 1 on a new installation.

The runtime source of both reviewed frameworks (`5420458a` below and the Ace
Combat 3 Japan kit's `08ec704a`) shows two ways to choose a disc:

- **`--disc PATH`** mounts that image. The runtime only works out the disc
  number from the roster when no override is given; with one, the number stays
  at the saved `[disc] selected` value or 1. That number sets the save-state
  disc scope (`savestate_set_disc_scope`), so a Disc 2 session would file its
  save states as Disc 1. The runtime's own comment describes that mix-up as
  what per-disc scoping prevents. Independent review blocked the first
  `--disc` implementation of this change for that reason.
- **`[disc] selected = N`** in the `settings.toml` beside the player. The
  runtime documents this as the way "an external launcher (or a hand edit)
  changes discs by writing one integer". It mounts roster entry N and uses N
  for the save-state scope.

Portcove uses the second route. Core writes only the `selected` value, or adds
that one line or a `[disc]` table, in the restored settings after every other
launch check. The file is already player data under `persistent_paths`, so the
session captures it like a choice made in the upstream launcher, and the next
launch without a choice starts the same disc. Settings the editor cannot place
exactly, such as an inline or dotted `disc` table, refuse the choice and leave
the file unchanged.

The integration field `launch_disc_choice: "psx-settings-selected"` gates the
choice. It is valid only with the managed PS1 adapter, a `psx-raw-set` source,
a runtime subdirectory and a persistent `settings.toml`. It is set for Ace
Combat 3 Japan and the two titles below.

Final Fantasy VII (`final-fantasy-vii-recompiled`) is also a managed
`psx-raw-set` set but ships a prebuilt player without runtime source. Its
`v0.1.7` Windows kit (SHA-256 `2b5c2b0d…`) contains the `[disc]` `path` and
`selected` key strings and the `_disc%d` save-state token. That is not reviewed
source evidence, so it offers no choice. Resume with its runtime source or an
upstream statement of the same settings contract.

## Titles

Each kit from tag `v0.1.0` matched its provider SHA-256 and passed
`portcove catalog inspect-package-layout`. The Linux kits have no
case-colliding paths. All four kits pin PSXRecomp `5420458a`, the split-mods
framework of the reviewed Future Cop: L.A.P.D. route, require a retail
SCPH-1001 BIOS (`README-SETUP.txt` states OpenBIOS is not supported) and ship
`mods/bundled` and `mods/preloaded`. Each Windows and Linux pair carries the
same `game.toml` and sets `EXE_NAME`.

| Title (issue)                      | Commit     | Windows kit bytes, SHA-256 | Linux kit bytes, SHA-256 | Player                         |
| ---------------------------------- | ---------- | -------------------------- | ------------------------ | ------------------------------ |
| AC: Master of Arena (#1585)        | `d39c6cba` | 27,058,386, `d99a7e67…`    | 24,984,747, `b14c8dcd…`  | `Armored_Core_Master_of_Arena` |
| Fear Effect 2: Retro Helix (#1594) | `4757d985` | 27,060,603, `2abab823…`    | 24,986,108, `57456d4d…`  | `Fear_Effect_2_Retro_Helix`    |

| Title                      | Disc | Serial     | Data track SHA-1 | Redump                                  |
| -------------------------- | ---- | ---------- | ---------------- | --------------------------------------- |
| AC: Master of Arena (USA)  | 1    | SLUS-01030 | `96f5fcc9…`      | [2487](https://redump.info/disc/2487)   |
| AC: Master of Arena (USA)  | 2    | SLUS-01081 | `c9ca14a6…`      | [2488](https://redump.info/disc/2488)   |
| Fear Effect 2 (USA, Rev 1) | 1    | SLUS-01266 | `86a470f4…`      | [31449](https://redump.info/disc/31449) |
| Fear Effect 2 (USA, Rev 1) | 2    | SLUS-01275 | `c80cf358…`      | [31450](https://redump.info/disc/31450) |
| Fear Effect 2 (USA, Rev 1) | 3    | SLUS-01276 | `2ea416bc…`      | [31451](https://redump.info/disc/31451) |
| Fear Effect 2 (USA, Rev 1) | 4    | SLUS-01277 | `1665f4c7…`      | [31452](https://redump.info/disc/31452) |

Each kit's `game.toml` lists Disc 1's data-track SHA-1 under `known_sha1`, and
it matches the table. Its `discs` roster names every disc by its Redump file
name, so the later discs' single data tracks and SHA-1 values come from those
Redump records. Both titles use the explicit integration form of the
Ace Combat 3 Japan precedent: the Future Cop split-mods projection plus
`runtime_source_filename: "runtime-discs"` and the `psx-raw-set`
materialization, bound to a `multi-disc-set` identity. Multi-disc titles stay
outside the release-selection corpus, as for Ace Combat 3 Japan. The Mac kits
stay upstream-owned.

The kits cannot swap discs during play (`game.toml`: "Swapping mid-session …
is not implemented"), so the player copy says to quit and choose Play with the
next disc.

## Not observed

Native generation, gameplay, disc changes, saves, save states, and update or
rollback with real data were not observed.
