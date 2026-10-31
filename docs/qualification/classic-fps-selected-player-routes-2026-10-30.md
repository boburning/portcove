# Three classic FPS selected-player consumers — October 30, 2026

This consumes the earlier #3409/#3678 guides for PsyDoom #1873, DOOM64 EX+
Enhanced #1812 and UZDoom #1899 under #2510/#2926. It finishes their Windows
operation declarations using the existing nonowning contract. All three already
belong to original-524/frozen-858; none is a historical #1422 member. No listing,
source identity, frozen member, adapter or production Core behavior is added.
The canonical issues and Project retain acceptance and planning ownership.

## Selected contract and actually offered operations

Finish upstream setup in a permitted working copy first. Explicitly select the
actual native game executable, its containing working directory and deliberately
chosen literal arguments with consent. Normal startup uses no arguments; the
upstream player handles game-data selection/readiness. Play is separate from
registration. Core retains execution intent across restart/relink and removes
registration metadata while preserving all external files.

Runtime replacement, originals, saves, settings, mods and profiles remain
upstream/player owned. Maintenance is `user-managed-update`. Core-managed
acquisition, Update, Backup, Rollback, migration, external deletion and original
authentication are unoffered. The Stable manual-registration channel selects no
fixed or stable upstream package; version is user-managed. Beta metadata is not
a Supported promotion, game observation or whole-session ownership guarantee.

### Executables, originals and profiles

| Canonical owner           | Exact source / player coordinate                                                                                                                    | Original and data boundary                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PsyDoom #1873             | `releases/1.1.1`, `2c50690b6e0ae26cbb83ad9039d24748f76275f8`; root AMD64 `PsyDoom.exe` / executable parent                                          | Own supported PlayStation Doom/Final Doom CUE and referenced tracks, not a PC WAD. Keep the upstream VC++ prerequisite. SDL com.codelobster/PsyDoom profile defaults to AppData/Roaming; local launcher.ini, mods, originals and recorded demos remain external.                                                                |
| DOOM64 EX+ Enhanced #1812 | `V1.0.0.1`, `47fcfc08040df701e02e68a89d3ef5d1a5a7b0bc`; AMD64 `doom64ex-plus-enhanced-1.0.0.1-win64/DOOM64EX+ENHANCED.exe` / that containing folder | Already permitted, prepared working copy only. Own PC-remaster DOOM64.WAD, Doom64.kpf and normally DOOMSND.DLS; legacy ROM-derived WADs do not substitute. Source searches GOG/Steam data and errors when required files are missing; no picker promise. Preserve SDL AppData/Roaming/doom64ex-plus and older local files.      |
| UZDoom #1899              | `5.0.3`, `7910df7102033fd7754a317f3254f24101135926`; root AMD64 `uzdoom.exe` / executable parent                                                    | Own supported IWAD or permitted compatible free data and mods. Keep the complete package. updater.exe is the upstream replacement helper, not the selected player. Default Documents/My Games/UZDoom INI, Saved Games/UZDoom saves, portable INI/Save/Screenshots, redirected Windows folders and custom paths remain external. |

The three original guide prefixes and warnings remain intact. Windows remains
the declared operation scope; existing other-platform setup facts stay in the
guides. No other platform's Core operation or universal Unsupported finding is
inferred. No private macOS bundle helper, converter, updater or installer is
promoted into a game player.

PsyDoom's pinned Windows entry returns its launcher or `psx_main`; launcher
`runGame` calls `psx_main` in the same process, including its own launcher-reset
loop. D64's native main calls `D_DoomMain`; the ordinary game remains there.
These are source-lifetime observations, not binary/source build attestation or
actual game runs.

### UZDoom's explicit restart limit

Ordinary `GameMain` runs inside the selected Windows program. Its error pane
sets `restartrequest`; `CheckForRestart` then calls `ShellExecuteW` for the same
executable after `GameMain` and retains no waited successor handle. A restarted
player can remain externally running after Core reports the original exit.

The visible guide warning therefore states that Portcove tracks the selected
player only. Close every actual remaining UZDoom player before another Play or
upstream replacement. Registration removal preserves every external file and
does not prove whole-game drain. This qualifies the existing selected-process
contract, not tracked successor/session recovery. It does not disable upstream
restart, add a watcher, offer managed replacement or require new family machinery.
The owned inert probes establish their tested root-process contracts; they do
not exercise UZDoom's real error dialog or restarted game.

### D64's permission and legacy-data boundary

The pinned README/COPYING and source identify the original Doom Source License,
not a blanket GPL grant. Applicable code, FMOD, Enhanced-WAD and separately
attributed sprite permissions remain conditional at their actual scope. This
continues the prior already-permitted-copy route; fresh-acquisition metadata is
unchanged and no new acquisition recommendation, universal illegality finding
or product deferral is manufactured.

Startup can move older working-folder config/save/screenshot files into the
external `doom64ex-plus` profile, which other EX+ copies may also use. Preserve
both locations and working players before first Play or upstream updates. Those
are upstream/user actions; Core registration grants no migration, backup, update
or deletion authority over them. Do not substitute an empty persistence contract
or adopt external files as managed data.

## Evidence provenance and limits

The [per-ID packet](classic-fps-selected-player-routes-2026-10-30.json) binds
fresh repository IDs, exact tags/commits, complete source trees and sixteen
recomputed license/README/entry/profile Git blobs. The latest-release/tag and
asset metadata match the previous qualified observations exactly. Actual
read-only software ZIP/header observations are **retained from October 26**,
with their original capture date, asset IDs, sizes, digests and raw metadata
bounds. They are not relabeled as fresh download, extraction or execution.

- PsyDoom asset112501908: 1,540,884 bytes, one entry, observed ZIP SHA256
  `06145417179b16e0b10634a4ebafacd0fa2e93ec29f034090a6b0b51999bb35a`.
  No independently expected publisher digest; computed bytes do not authenticate
  managed acquisition or the selected user copy.
- D64 asset309787204: 17,742,435 bytes, fourteen entries, publisher and retained
  observed SHA256
  `b2a8f92f5885e48f283a402f96b9af303e064532d66ec1dbfec331843d291632`.
- UZDoom asset584674267: 29,337,585 bytes, sixteen entries, publisher and retained
  observed SHA256
  `3a41131845415bc4bb5474f8de301a77736bd858e2ab489926325a2675e8263f`.

Publisher integrity and root engine licensing do not grant original-game or all
component permissions. Keep upstream/dependency attribution and use permitted
originals. No original, game, installer or setup helper is acquired or executed
for this consumer batch. Actual player startup, gameplay/save-load, installed
Desktop, protected unchanged-client and production distribution evidence remain
Not run/Not evaluated.

## Acceptance boundary

Three actual embedded-ID cases reuse the unchanged consent, stale-intent,
single-owner, strict-definition, retained restart, separate supervised Play and
preserving-removal helper. Native programs in those cases are owned inert
probes. Existing pre-declaration and adversarial coverage remains intact; no
production helper or process semantics changes.

All 267 prior operational objects and the entire SourceCatalog remain unchanged.
Three additions give 270 definitions with the same listing and source identities;
the identity-bookkeeping fixture appends only these three reviewed IDs. Every
prior expected ID and source expectation and the frozen schema-1 fixture remain
unchanged. Definition totals are not accepted-user or playable-route counts.

Each canonical issue has three existing criteria: evidenced owned facts and
operation limits with honest Unknowns; catalog/Project agreement for the chosen
route; linked implementation/qualification completion. Independent review, all
current required exact-head CI, guarded merge, remote readback and individual
issue/Project reconciliation must finish before credit. Later gameplay and
conditional managed fits do not become invented closure gates for this valid
narrower contract. Six retained Direct compatibility rows, BStone retail-input
checks and #1785's evidence-loss integrity hold remain separate and unfinished.
