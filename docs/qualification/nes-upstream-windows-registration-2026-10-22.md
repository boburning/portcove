# Official NES Windows packages: non-owning registration

Dated investigation and operation evidence for [Yoshi #155](https://github.com/boburning/portcove/issues/155),
[Dr. Mario #157](https://github.com/boburning/portcove/issues/157) and
[Faxanadu #156](https://github.com/boburning/portcove/issues/156), under
[#1422's upstream-first amendment](https://github.com/boburning/portcove/issues/1422).
This record does not replace canonical issue or Project state.

## Selected official packages

Official latest-release metadata was refreshed on October 22. The selected
scope stayed fixed during validation. ZIP bytes match both GitHub's published
SHA-256 digest and the release's downloaded `SHA256SUMS.txt`; checksum-file bytes
also match their published digests. These are investigation identities, not a
catalog authenticity promise for arbitrary user-selected installations.

| Port           | Release / Windows x64 ZIP                                                                                          |     Bytes | ZIP SHA-256                                                        | Actual executable        |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | --------: | ------------------------------------------------------------------ | ------------------------ |
| Yoshi's Cookie | [v1.1.1](https://github.com/mstan/YoshisCookieRecomp/releases/tag/v1.1.1), `YoshisCookieRecomp-windows-x64.zip`    | 4,902,569 | `5238356ea207ba358602f01b6febd0569b9ffadbf70945e610d8a6c5cc231b98` | `YoshisCookieRecomp.exe` |
| Dr. Mario USA  | [v1.3.1](https://github.com/mstan/DrMarioNesRecomp/releases/tag/v1.3.1), `DrMarioRecomp-usa-windows-x64.zip`       | 4,701,280 | `26f694557a977501206cc2395704de086d96af7c9972b5185315eee169a87aac` | `DrMarioRecomp.exe`      |
| Faxanadu USA   | [v2.3.3](https://github.com/mstan/FaxanaduRecomp/releases/tag/v2.3.3), `FaxanaduRecomp-USA-v2.3.3-windows-x64.zip` | 4,972,545 | `f997e7bd1f08a26db24906704ae69bd0769872ef80632c16abea2c993e0304b4` | `FaxanaduRecomp.exe`     |

Each actual archive has 28 entries, including its native executable, SDL2,
MSVC runtime DLLs, launcher assets and README. Extract the entire archive into
a user-owned directory; use that directory as the working directory. No ROM,
generation, compiler, engine patch or downstream build is supplied by Portcove.
The shipped executables own original selection, verification and play.

The selected game-source commits are `ae1b61f81f2cb7bbc535c45f07e9c17750aa04a8`
(Yoshi), `15d532f299ccdaaeefbc4974a78f6eda2ad30eb2` (Dr. Mario) and
`f97b290858ba66bc41d9fea9bc09ed1b5f443e40` (Faxanadu). All pin shared engine
`5255180704b2a6642cf5defea79454f284b528b3`. Source inspection explains package
behavior; it is distinct from the runtime observations below.

## Preparation and ownership

Run the shipped executable and choose a matching original through **Browse For
ROM**, then **Play** and normal close. Return to Portcove's **Use your existing
installation**, choose the executable and working directory, and add the full
original-ROM path as one literal argument. Desktop accepts one argument per line;
do not surround that line with shell quotes. Review these exact details before
registration. CLI uses `external select-preview`, then `external select` with
the returned `--expected-preview`, the same executable/directory/`--arg` and
`--yes`. `exec` supervises the registered launch.

Yoshi's upstream **Skip launcher on boot** setting exposed a concrete preparation
trap: empty arguments with that setting enabled exit with usage code 2, even
though `rom.cfg` remembers the original. The same unchanged package runs with
the original's documented positional argument. That bounded argument is the
selected reproducible route; empty arguments require keeping the launcher
enabled. The failed run is retained, not relabeled as a pass. This needs clearer
catalog guidance, not a new Core behavior or an upstream engine repair.

Registration is execution intent, not authenticated-package certification.
The player/upstream owns replacement, updates, originals, settings and saves.
Portcove offers no managed update, rollback, backup, migration or external
deletion. **Remove registration** forgets only its reference. Existing managed
development installs, retained definitions, backups and failed recovery scopes
keep their historical contracts. No forced reinstall or ownership conversion
is introduced.

The shared engine puts `config.ini` beside the executable and `rom.cfg` beside
that config. The original remains external and unchanged. Ordinary upstream
writes are separate from Portcove metadata writes. Removal comparison uses a
fresh post-game tree, including legitimate runtime-created files, rather than
requiring launch to leave settings byte-identical.

## Actual inputs and operation scope

The operator is Codex using the native Windows control tool, with one explicitly
reported human normal-close handoff after foreground-input interference. Runs
use freshly extracted packages and an isolated library under
`E:\Codex-Evidence\nes-windows-batch-20261022`; no player library is reused.
Original-game bytes are retained privately and are not committed or uploaded.

| Port      | Retained original                                                                                                  | Observed scope                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yoshi     | 196,624-byte USA NES2 input; SHA-256 `ea416fff4a2d207236aa31a7abd2d41f06fe0a53486f485b109ed127be11a45a`            | Upstream ROM verified; reviewed Core registration; actual game startup/normal close; fresh-process readiness and relaunch; registration-only removal preserving all 30 external files. Three successful supervised CLI launches overall, including two using the selected original-path argument. Native Desktop independently completes registration, two startup/normal-close cycles across app restart and UI removal preserving all 30 files. |
| Dr. Mario | 65,552-byte Japan/USA Rev 1 NES2 input; SHA-256 `5f4849329f0ece227a3c7d6a63c0ecb6c9a1edee424e70e7bc6fa4bfda4a82d8` | USA package verifies this original; reviewed Core registration; two actual CLI game startup/normal-close cycles with fresh-process readiness/relaunch; registration-only removal preserving all 30 external files. Native Desktop independently completes registration, two startup/normal-close cycles across app restart and UI removal preserving all 30 files.                                                                                |
| Faxanadu  | 262,160-byte USA Rev 1 NES2 input; SHA-256 `9e5f12c5fb7f6aa2b360538038abc682488511293e79b9bd2ef199877a8c6d1d`      | Actual launcher refuses **ROM not recognized**; ordinary launcher close exits 0. No game or actual-operation acceptance.                                                                                                                                                                                                                                                                                                                          |

The retained development CLI has API 80 and SHA-256
`10754599b9ed48da1fabc65ee86bd56055cffba410a59730f3737cb379873e2c`.
Its existing producer receipt binds base `43980db13626379bb070eca895e778690ee66fd3`
and a separate DKR candidate catalog; it is not a build of this batch, main
`6048a6b11eec2c65fda2d1405dd94bf29fb656f3`, or a published client. The selected
user-registration/launch implementation is unchanged across the intervening
retained-build change. Artifact-bound operation evidence does not establish
current-main schema migration or unrelated management behavior.

Both final registrations use the actual executable, extracted working directory
and one original-path argument. Durable `launch show` readbacks retain the
external-owner, supervisor/child identities, terminal outcomes and exit 0 for
the successful runs. The intentional zero-argument/skip-launcher failure remains
failed with exit 2. Fresh final status has no external registration and is not
launchable; no running activity remains. Every original's hash still matches its
preimage. Earlier registration/removal checks and command/refusal failures also
remain in the raw packet.

### Native Desktop interface evidence

A fresh local native development build uses source base
`6048a6b11eec2c65fda2d1405dd94bf29fb656f3` plus this batch's catalog guidance.
The dated report was edited afterward; this is not a clean final-commit build.
The Desktop executable SHA-256 is
`f2d3889f73c6b69cf27863a8d0faecaacb1ffc83270a21ac98cc2fd8ee8aef24`;
its same-build CLI is
`21b7a4bbd6a1003e90ab3fef16b346a21176370f3dcf0efa43552a0818a73cfb`.
`native-product-byte-inventory.json` binds both executables, the catalog and
every production frontend file. The served index matched those production
bytes. This native Tauri run uses its configured `http://localhost:1420`
development URL, Windows WebView2 155.0.4283.62 and isolated library,
preferences, runtime lock and WebView profile. It establishes these actual
interface/IPC operations, not packaged-origin or installer acceptance.

For each title the operator read the new preparation guidance, selected the
real executable, entered its working directory and one literal original-path
argument, and reviewed both the in-app details and native execution consent.
Desktop **Play** reached the actual game title screen and normal title-bar
close returned **Ready to play**. Normal Portcove close/restart retained both
registrations, with **Ready (2)**; a second Play/normal-close cycle succeeded
for each. Both Portcove processes exited 0 with positive process waits.

Desktop **Remove registration** then displayed the external folder and
file-preservation wording, followed by native removal consent. Both entries
returned to **Choose your existing installation**, with **Library 0**.
Fresh post-game preimages and removal readbacks match all 30 files per title;
original hashes also match. The new CLI reads two successful external-owner
launch sessions per title, each with child exit 0 and a terminal timestamp,
no registration, no launchability and no running activity. These receipts live
in `desktop-operation-result.json`, `desktop-launch-*.json` and the corresponding
native screenshots/trees. The owned preview was stopped and the native-session
lease released only after positive app exit and no owned game process remained.

## Faxanadu disposition

The official package and native launcher fit the existing non-owning route;
no additional adapter is needed. However, the available authorized original
has payload CRC `E71DB268`, while the tagged North American package's
`tools/verify_usa_rom.py` / `CMakeLists.txt` require payload CRC `57DD23D1` and
mapper 1. The actual launcher refusal confirms the input mismatch. Header
rewriting cannot repair different game-data bytes and is not attempted.

Keep #156 open for that exact original/package operation condition. Resume with
an authorized matching original accepted by this package, or a reviewed official
package supporting the retained revision. This is not a claim that the title
lacks an existing route, that no owner can supply the input, or that another
engine/build implementation is required. No unvalidated catalog addition or
Supported promotion follows from package inspection.

The old README's `saves.txt` / manual-password and legacy-state instructions
conflict with current cycle-host behavior. Tagged cycle configuration declares
`PASSWORD_SAVE "faxanadu.srm"`; the launcher visibly exposes **Mantra** and
current source also handles mantra history. No populated password, save/load,
backup or rollback acceptance is claimed. All external state remains user-owned.

## Evidence and remaining limits

Raw release/source responses, ZIP inventories, checksums, request/response logs,
process receipts, native screenshots, failed attempts and post-game/removal
inventories live in the isolated evidence directory above. The earlier custom
NES-build failures and successful legacy runtime receipts remain historical in
[the Yoshi record](yoshi-nes-cycle-windows-2026-10-18.md) and the canonical issues;
the new official-package route does not erase or reuse them as its runtime pass.

Shared path, consent, stale-review, concurrency, executable and ownership tests
remain with the existing user-selected capability. Browser fixtures and native
fixture scenarios establish only their recorded interface contracts. The
batch changes presentation facts and guidance, not Core/client behavior or any
trust/release authority. No measured maintenance-time comparison is claimed.

Startup and ordinary close do not qualify full gameplay, audio, physical
controllers, populated save/load, human comprehension, another OS/region or
release distribution. Catalog admission, operation acceptance, legacy Supported
intersections, and delivery to released clients remain distinct.
