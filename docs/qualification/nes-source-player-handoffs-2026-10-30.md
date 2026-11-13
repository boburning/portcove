# Two NES cycle-source player handoffs — October 30, 2026

This bounded [#2926](https://github.com/boburning/portcove/issues/2926) batch
selects permitted completed-source Windows players for
[#1840](https://github.com/boburning/portcove/issues/1840), LegendOfZeldaNESRecomp,
and [#2739](https://github.com/boburning/portcove/issues/2739), YoshiNESRecomp.
Both are already authored frozen 858 members: Zelda belongs to original 524,
Yoshi to affected 312. Neither belongs to #1422's historical 317 rows/316 identities.
No listing, strict definition, original-source identity or historical cohort is
added. Full #2510/#2926 scope and all unrelated owners remain open.

The shared cause is the current NES cycle host's completed-player interface,
configuration/ROM sidecar and backend-state boundary. Existing Core listing
registration/consent/relink/restart/selected-process Play/preserving removal
supplies the route. No new #136 primitive, engine build service, adapter or
console-family campaign is needed. Upstream/player retain replacement ownership
(`user-managed-update`); no managed progression or state migration is promised.

## Exact source and permission

The [source packet](nes-source-player-handoffs-2026-10-30.json) records 34
verified repository/commit/path/blob observations across five complete pinned
trees. Identical content in different selected source bindings is not presented
as distinct unique content. Decoded bytes were independently checked against
Git blob identity and SHA-256. Base is delivered
`0aedae80a31b4839478f8a89b4c89b5d4d0dba89`. Pickup issue hashes and Project
observations are dated evidence, never a second planning authority.

| Component        | Exact selected revision                    | Grant/scope                                                                                 |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Zelda title      | `07c3004786f36b73e58fe00bfece9ad648ba7d96` | PolyForm Noncommercial original title code; component/original/media rights remain separate |
| Zelda nesrecomp  | `23e87d71f6da42e22450323d882047b90363798d` | PolyForm Noncommercial                                                                      |
| Yoshi title      | `f219991df2e70d6bf41f4ba9a46c8ddf990b572e` | PolyForm Noncommercial original title code; component/original/media rights remain separate |
| Yoshi nesrecomp  | `5a2eddeecc646e9325bef53f3c711e119423f99c` | PolyForm Noncommercial; do not silently substitute the other title's pin                    |
| Shared recomp-ui | `c11a4b6c649164b6951eff107f4607dcef117dd5` | MIT for that component; not a blanket MIT label for the combined player                     |

The four selected title/framework LICENSE observations have Git blob
`b981b950da9e5e7363b08bd3c573cf0f479e07f6`, SHA-256
`168689b754213aaa4f64b974ecfb15203b31f46b824ef436482cdb4a88a35b50`.
UI LICENSE is `a4e60e1cc9c426120561d3ab85b58fcc9201a3ef`, SHA-256
`676252c9efb0849cc08cdba279318b4d62ae144c19a52a0aa7ab5ca845ae5ddc`.
These support the conditional personal/noncommercial completed-source route,
subject to applicable notices. They do not authenticate arbitrary packages,
older builds, generated game code, original ROMs or optional HD/media content.
No game package was acquired or certified. Existing generic explicit-download
behavior remains separate; neither listing has an invented acquisition hold.

## Completed product and invocation

Current title CMake selects the cycle backend by default. Choose an already
working generated **cycle** product: `LegendOfZeldaNESRecomp.exe` for stock
Zelda and `YoshiRecomp.exe` for Yoshi. Filename alone does not certify backend or
build provenance; keep the creating source/backend and generated output.
Do not select setup scripts, compilers, diagnostics/headless tools or legacy/HD
executables as the selected current cycle product. Upstream generation/build
happens outside Portcove before registration.

Both selected cycle hosts share `cyc_host.c` blob
`a05b7f90e3cc0a931d6dff51a60f79c74bed751e`, SHA-256
`ac4f03f5bff4ef7af43f44c8b5aa13bb747df54550f320db2cc7ac3e925e9ab7`. Their actual CLI accepts one positional original ROM path and an
optional `--config FILE`. It does **not** accept the SNES `--rom` /
`--no-launcher` pair. `NESRECOMP_NO_LAUNCHER=1` is an upstream environment
switch, not an argument or a Portcove requirement; this route preserves the
ordinary launcher. Do not add debug/network/headless switches merely to register.

For normal defaults, choose the executable's containing runtime folder as CWD
and one absolute ROM path as a literal argument token. Preserve an already
working custom CWD, actual `--config` and custom save options rather than
changing path interpretation. Keep spaces inside a path token; `--config` and
its absolute path remain separate tokens. Core binds that reviewed intent and
consent, does not start the program during registration, and requires separate
explicit Play. Relink a replacement through fresh review.

Default config is executable-parent `config.ini`. The ROM selection sidecar
`rom.cfg` follows the chosen settings file; custom configuration is **not** an
all-writes redirect. Default battery/state paths remain executable-relative.
Preserve actual `--save-file` / `--no-save` choices; adding `--no-save` would
also disable battery loading. Prepare each title/backend/input in its own
creating tree; combining trees with common configuration/sidecar/state names can
change the active profile. Do not move an established working copy just to
register it.

## Original and creating-state boundaries

Zelda's selected stock source names USA PRG0, PRG+CHR payload CRC32 `3fe272fb`,
compatible cartridge/header metadata and SNROM 8KiB battery RAM. CRC32 here is an
upstream source selector, not a Core curated cryptographic source certificate;
this observation establishes no full-file cryptographic hash. Equivalent
supported iNES/NES2.0 board metadata is distinct from arbitrary regions, wiring,
RAM geometry, FDS or the separate HD/Remastered image. Core user-selected
registration does not authenticate the original or generated build.

Zelda battery data normally uses `saves/<ROM stem>.sav`; cycle shortcut states
use `saves/<ROM stem>.cycstate` and additional state/UI data stays with the
creating copy. Preserve actual custom paths. The selected migration notes
explicitly refuse legacy binary-state transfer to cycle. Raw 8KiB `.srm` battery
import is an upstream UI operation, not a Portcove migration or qualified
cross-build compatibility. Registration never imports/renames old states.

Yoshi's current USA payload is CRC32 `E7EAD93B`, 128KiB PRG+32KiB CHR. Its
[pinned header guide](https://github.com/mstan/YoshiNESRecomp/blob/f219991df2e70d6bf41f4ba9a46c8ddf990b572e/docs/ROM_HEADERS.md)
identifies canonical NES2.0 file SHA-1
`71cc02d4a005c6ad71f1fbf2b3ccd890d65056a3`; the older header declaring 64KiB
CHR is accepted only for the complete known payload/length, without rewriting
the original. The previous larger image and its state are not qualified for
this release. Yoshi has no battery save; its cycle states still require
preservation. Legacy and cycle/current-image states remain separate.

Keep originals, generated/source/runtime trees, actual settings/rom.cfg,
legacy keybinds, mods, battery/state/import candidates, diagnostics/captures and
all unknown/custom paths. Upstream's preview, migration playtest and
native/interpreter claims remain upstream claims, not Portcove gameplay,
full-mechanics, cross-build/save or other-platform qualification.

## Operation, validation and remaining acceptance

The inspected ordinary cycle prelaunch/game/SDL cleanup is in-process.
Core observes the selected process; this is no exclusive process-family,
sandbox, network/debug/netplay or external-instance ownership claim. Close all
actual players before upstream replacement. Upstream/player own preparation,
repair and updates. Metadata-only registration removal preserves all external
bytes. Managed acquisition/setup/Install/Update/Backup/Rollback/migration and
external deletion are not offered by these guides.

Maintained per-record preparation completed for both proposals with unchanged
operational projection. Optional artwork enrichment is advisory: preserve
Zelda's accepted mapping and Yoshi's existing absence exactly, together with
Yoshi's opaque upstream lineage. Derived listings are generated through current
tooling; all 272 strict definitions and source contracts remain unchanged.
Two named actual-ID cases reuse the full existing native-probe consent,
stale-intent/relink/restart/retained-listing/selected-process Play/preserving-removal
contract, explicitly checking guide presence and no invented acquisition hold.
Their executed results, final separate review, exact-head hosted checks,
guarded merge and canonical readback belong to the delivery PR/owners.

Source/authoring evidence is distinct from an executed game or accepted package.
No upstream game package, original ROM, game build/helper/compiler or game was
acquired/executed. Native game/gameplay/save/state/installed/protected and
other-platform observations remain Not run/Not evaluated. No Supported or fleet
completion promotion follows. The six retained transitions, two actual BStone
retail observations, #1785/#141 evidence disposition, five source-unlisted joins
and other unreviewed per-operation requirements remain with their existing owners.
