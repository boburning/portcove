# Five Namco arcade existing-copy routes — October 26, 2026

Partial [#2926](https://github.com/boburning/portcove/issues/2926) delivery for
[#2510](https://github.com/boburning/portcove/issues/2510). This dated packet is
candidate evidence, not a live backlog or completed Public beta acceptance.

The finite workset is five existing distinct games. Pickup source
`3daf2fda27c2ec1b30e60d59f854c5c887bbb334`; observation cutoff `2026-10-26T16:04:28.044Z`.
All five current authored identities at this exact upstream are included; no
other game is merged into them. The [source-bound packet](namco22-existing-copy-routes-2026-10-26.json)
retains canonical specification hashes, per-port dispositions, setup/data boundaries
and validation limits. Original 524 identities /312 additions /22 joins remain.

The canonical owners already require resolving the bundled original C71 DSP BIOS
and Namco-derived program-code permission before acquisition. Release 0.9.3 source
`d7331fba68c57f914565f7fc5186081129a23805` keeps the same boundary: its MIT grant expressly excludes
Namco game code. All five inspected Windows executables contain the complete
8,192-byte BIOS table described by upstream. Archive integrity does not grant
permission. Reconsider after an attributable grant or an upstream package and
supported preparation route that removes the ungranted content. This preserves
an existing owner-approved condition rather than creating a new deferral.

Each listing now carries that hold through Core's existing acquisition restriction,
and gives concrete conditional instructions for an existing permitted copy.
Registration preserves external ownership and every external file; Play remains
explicit. No Portcove update, backup, rollback, adoption or deletion is promised.

| Identity / owner                                                                   | Existing Windows player | Original inputs                                                                               | Linux profile |
| ---------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- | ------------- |
| `dirt-dash-namco22` / [#1568](https://github.com/boburning/portcove/issues/1568)   | `DirtDash.exe`          | dirtdash.zip (World DT2 Ver.A); also keep dirtdasha.zip beside it when using a split MAME set | `dirtdash`    |
| `prop-cycle-namco22` / [#1565](https://github.com/boburning/portcove/issues/1565)  | `PropCycle.exe`         | propcycl.zip                                                                                  | `propcycle`   |
| `rave-racer-namco22` / [#1566](https://github.com/boburning/portcove/issues/1566)  | `RaveRacer.exe`         | raverace.zip (World RV2 Ver.B) and namcoc74.zip                                               | `raverace`    |
| `time-crisis-namco22` / [#1569](https://github.com/boburning/portcove/issues/1569) | `TimeCrisis.exe`        | timecris.zip (World TS2 Ver.B)                                                                | `timecris`    |
| `tokyo-wars-namco22` / [#1567](https://github.com/boburning/portcove/issues/1567)  | `TokyoWars.exe`         | tokyowar.zip (World TW2 Ver.A)                                                                | `tokyowar`    |

Windows players run from their own executable-parent folder and unpack original
chips on first Play. Preserve the complete external folder, including ROMs,
extracted chips, controls, arcade records, captures, recordings and log. Linux
uses the upstream AppImage launcher and its existing XDG/legacy/portable profile
selection. The launcher supplies its own environment; selecting a private binary
would lose preparation and storage behavior. Replays may require their creating
runtime. Source edition checks remain upstream-owned.

The official 84,374,072-byte Windows archive matched its independently expected
published SHA-256 and has 23 entries with eleven AMD64 executable headers. Five
Linux AppImages separately matched their published digests and outer ELF64 x86-64
AppImage type-2 headers; their compressed payloads and native behavior were not
qualified. Pinned host-source blobs, packaging and data writers were inspected;
no game, setup helper or original input was executed. Managed drafts were rejected
because the existing permission condition remains unresolved. No managed route is
added, and all 166 existing operational records remain unchanged. The five records
use maintained preparation and derived catalog generation; exact final-head checks,
separate review and guarded delivery are pending at this source checkpoint.
