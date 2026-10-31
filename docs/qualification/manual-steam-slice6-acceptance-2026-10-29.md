# Slice 6 manual desktop Steam acceptance — October 29, 2026

Owner: [#290](https://github.com/boburning/portcove/issues/290). This dated
receipt distinguishes application success, installed-game preparation and actual
game/session acceptance. The issue and live Project remain authoritative.

The original tables below retain their October 29 cutoff. The
[October 30 continuation](#october-30-windows-continuation) adds selected actual
focus/return and standalone CLI relocation evidence; it does not turn the earlier
preparation-only rows into historical passes.

## Windows observations and current readback

The independently reviewed [application receipt](https://github.com/boburning/portcove/issues/290#issuecomment-6501795331)
records actual Steam Desktop and Big Picture launches of a normal source-built,
unbundled application, followed by normal close and Steam exit code 0. The real
WebView rendered; app Settings showed the isolated selected library. Six recorded
application/WebView PIDs were absent afterward and Steam displayed Play. This is
not independent foreground/focus measurement, whole-descendant cleanup,
signed-package/minimum-host or game-launch acceptance.

The manually created application entry retained AppID `4127723725` / GameID
`17728438405831852032`. Its Target and Start In contain spaces and Unicode;
application launch options are empty. The setup probe-to-application field change
does **not** establish application relocation/update/rollback. The historical
unavailable-target negative control remains separate, with its original entry
unchanged. No programmatic Steam profile/shortcut writer was introduced.

| Identity                      | Retained value                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Application/CLI source        | `773d2cc1c61b71aa5ce244a8df44d9ab2346d539`                                                       |
| Windows application SHA256    | `d7636b7b29173893fe50d1551f677b65da4cc06d2949e5800e3ef05aa00d8d4f`                               |
| Standalone Windows CLI SHA256 | `8439770afca1ccb5af27ea2284e5539d57a725631ee58a29b6d2f68ba3549004`                               |
| Recorded native host          | Windows 11 Home x64 `10.0.26300`                                                                 |
| Steam executable version      | `11.15.70.27`                                                                                    |
| Steam process                 | PID `6712`, created `2026-10-27T11:21:08.2424220Z`                                               |
| Library ID                    | `4242ffffbac2142c316b5320e90695dd`                                                               |
| Port / active install         | `opentyrian-opentyrian` / `5e9c0587-066a-4196-abe4-2930b6c8117f`                                 |
| Official package              | `v2.1.20260913`, `opentyrian-v2.1.20260913-windows-x86_64.zip`                                   |
| Package SHA256                | `7eddbe42439392ee8b2ffbe38c1c20a768da0c4afcc795ca31928c9dd6068f60`                               |
| Selected executable / SHA256  | `opentyrian/opentyrian.exe` / `8eb615e58e38c4a1c1a7e90eb6e939e6a85b70373758f667ee4d144bec454e74` |
| Retained manifest SHA256      | `b039ce71b7e7b211f18ec80f51d4d1029336f012103739e1bdf67491f47219ce`                               |

The [installation/prelaunch receipt](https://github.com/boburning/portcove/issues/290#issuecomment-6502325884)
records successful Core installation and independent verification of all 113
manifest files. The first attempt ended at resource admission with no payload;
the second completed successfully. Earlier failures remain retained.

On continuation, native read-only CIM at `2026-10-29T19:50:01.7453510Z` found the
same Steam process and no Portcove application/CLI or OpenTyrian process. File
metadata retains the recorded application/CLI sizes and earlier write times.
Public CLI library selection/identity and metadata export still report the same
saved library, active install, artifact, selected executable and manifest identity,
with no previous install and an empty launch history. This reuses the earlier
digest verification; it is **not** a new full-content verification. No reinstall,
unchanged-artifact rehash or native UI input was performed for this refresh.

The declared runtime-side `opentyrian.cfg` remains a zero-byte regular file;
canonical cfg, `tyrian.cfg`, `tyrian.sav` and recorded demos are absent. No game has
been launched by this qualification. The marker follows the source-reviewed
upstream portable-config behavior, but runtime/save-location isolation is still
unproven. Core collects runtime-side data before restoring it on first `exec`;
seeding only the canonical user marker would not establish this precondition.
Do not modify executable bytes or silently restore old saves to pass continuity.

## Acceptance table

“Reused” preserves an earlier result's exact artifact/environment scope. “Missing”
requires actual observation; a prepared installation is not a launched game.

| Row                                               | Observation                                                                                                                                                                          | State                                                    | Exact next action                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public CLI and manual ownership                   | #3923 documents distinct app/game fields, raw-stream `exec`, fresh request identity and player-maintained launch-only entries. The public CLI prerequisite #30 is recorded complete. | Reused                                                   | Use the stable CLI/library/port fields below; preserve unrelated entries.                                                                                                                                                                               |
| Windows application, Desktop and Big Picture      | Actual real-app render, selected library, normal exit 0 and Steam Play afterward in both modes.                                                                                      | Passed at recorded scope                                 | Reuse matching receipts. Measure remaining focus/return only when interaction resumes; do not repeat the app-opening test merely for a newer report.                                                                                                    |
| Initial installation admission                    | First attempt exited 75 before the payload started.                                                                                                                                  | Failed attempt retained                                  | Keep its logs; the successful second attempt supersedes preparation readiness only.                                                                                                                                                                     |
| Windows game preparation                          | Core install succeeded; original 113-file verification independently reviewed; current identity/mutable-state readback matches.                                                      | Passed preparation only                                  | Recheck current processes/mutable data immediately before the first game launch; preserve the existing install.                                                                                                                                         |
| Actual selected-game Desktop / Big Picture launch | No manual game entry or game/session result recorded.                                                                                                                                | Missing                                                  | In a renewed authorized session, add the stable CLI entry, launch separately in both modes, bind the actual game window/process and Core request/install outcome.                                                                                       |
| Runtime and save isolation                        | Empty runtime-side portable marker exists; no saves yet.                                                                                                                             | Missing                                                  | Observe the real runtime and written paths on first normal exit; compare runtime/canonical cfg/save identities without touching personal AppData.                                                                                                       |
| Game normal exit and return/focus                 | App close is not game exit or foreground measurement.                                                                                                                                | Missing                                                  | Exit through the game's supported route; inspect actual Core terminal outcome, process settlement, collected data and return/focus separately.                                                                                                          |
| Crash / Steam Stop / recovery                     | Historical scoped Windows Stop proof and Core supervision remain; this game has no new result.                                                                                       | Reused component; missing game rows                      | Retain the actual failed outcome and process-start identities, inspect the recorded request, and use Core recovery after it verifies the supervisor is gone; Core may wait for the recorded child. Hard kill does not promise final save collection.    |
| Prepared offline use                              | No new offline selected-game run.                                                                                                                                                    | Missing                                                  | Use the task session's supported Steam offline route, recording client identity/restarts, prepared runtime behavior and no new acquisition. Do not alter shared-host networking to simulate it.                                                         |
| Relocation / update / rollback                    | CLI fixture relocation/relink remains; diagnostic-to-app repair is not application relocation. Only one real game install exists.                                                    | Reused fixture; missing native rows                      | Exercise actual CLI/application relocation and explicit field repair while preserving library/port/install identity. Use genuine eligible/retained versions for applicable update/rollback; never manufacture one or equate relink with managed update. |
| Storage/source failures                           | Historical missing Target/Start In fails before a Core session. OpenTyrian needs no external original-game source.                                                                   | Reused negative control; missing applicable storage rows | Record source non-applicability separately; exercise actual relevant unavailable/read-only/removable-library conditions and exact restoration. A renamed directory does not prove physical removable media.                                             |
| Ordinary Linux application and game               | No supplied usable ordinary-Linux Steam graphical session. Current execution host is WSL with no Steam client.                                                                       | Missing                                                  | Establish the ordinary-Linux route below, then execute and independently review its own app/game matrix.                                                                                                                                                |

## Ordinary-Linux acceptance route

This is an executable operator procedure, **not an executed Linux pass**. Use a
real ordinary Linux x86-64 desktop with the Steam graphical client, independently
of the Windows session. Select a distro/runtime combination within the selected
Portcove AppImage's [Linux delivery contract](../DELIVERY.md), including actual
glibc/WebKit/graphics/FUSE and executable/volume constraints. Also satisfy
[Valve's current Linux requirements](https://github.com/ValveSoftware/steam-for-linux/blob/master/README.md):
Ubuntu/Ubuntu LTS x86-64, working 32/64-bit graphics libraries and glibc 2.31 or
newer. Steam's requirements alone do not establish Portcove compatibility.

1. Record distro/kernel/architecture, ordinary caller UID, desktop/session type,
   Steam version/process and actual graphics/WebView environment. Use a working,
   explicitly authorized session with Steam already usable. WSL/Xvfb, a container,
   SteamCMD, mock Steam trees and the existing hosted renderer/history lane do not
   supply this acceptance. A separately observed VM would retain its virtualization
   limits; it cannot establish physical/minimum-host behavior.
2. Preserve host-preference preimages and use a fresh task-owned library. Keep
   player libraries, credentials and unrelated Steam entries untouched. Select the
   library through the public Core CLI and read saved selection without an invocation
   override before the empty-options app entry opens. Record the durable library ID.
3. Use a verified ordinary Linux application/standalone CLI and an accepted Linux
   OpenTyrian installation, with exact source/package/install/runtime identity and
   owned save/config paths. Preparation on another host is only preparation. Reuse
   matching verification and repeat only inputs/checks invalidated by a real change.
   Inspect the actual selected executable and declared mutable paths; verify a
   readable runtime-side portable cfg before first launch. Do not seed canonical
   data alone or reuse a Windows runtime as Linux evidence.
4. Manually add separate application and installed-game entries through Steam's
   [Non-Steam Game flow](https://help.steampowered.com/en/faqs/view/4B8B-9697-2338-40EC).
   Use the application executable/AppImage with empty options. The game entry uses
   the standalone CLI as Target, its directory as Start In, and this argument array:

   ```json
   ["--library", "ABSOLUTE_OWNED_LIBRARY", "exec", "opentyrian-opentyrian", "--"]
   ```

   Quote complete spaces/Unicode paths in Steam's fields. Do not add a shell,
   `--json`, a static request UUID or the version-specific game executable as Target.

5. Execute application and game separately in Steam Desktop and Big Picture.
   Observe the actual game and Core session, runtime/save-location isolation,
   normal exit and return/focus. Retain before/after mutable-state evidence and
   exact current install/request/process-start identities. Steam Play alone does
   not measure foreground focus or prove game success.
6. Complete the relevant failure, Stop/recovery, prepared-offline and identity
   transition rows above in this Linux session. Distinguish a deliberately injected
   process termination from a spontaneous game crash. Do not label a mock process,
   synthetic package or directory rename as real game/update/removable-media proof.
7. Use Core recovery only after it verifies the recorded supervisor is gone and
   the recorded child/start/install identities; Core may wait for that child.
   Settle exact owned processes before fixture mutation or cleanup. Keep failed /
   not-run outcomes and inspect actual screenshots before visual claims. Submit
   the separately bound Linux evidence for independent non-writing review.

This route needs a usable authorized ordinary-Linux Steam graphical session; none
has been supplied here. It introduces no account provisioning, automated login,
RDP, driver/security change or replacement hosted workflow. The
[hosted acceptance contract](../NATIVE-HOSTED-ACCEPTANCE.md) does not qualify Steam
through its existing Ubuntu renderer/history observations.

## October 30 Windows continuation

The owner authorized a fresh uncontended Windows desktop interval. The selected
existing game entry was exercised in Desktop and Big Picture with Portcove
Desktop closed. Earlier normal exit, Stop, offline, supervisor recovery and
storage observations remain separately credited in the
[latest prior matrix](https://github.com/boburning/portcove/issues/290#issuecomment-6511650359)
and [version-capability receipt](https://github.com/boburning/portcove/issues/290#issuecomment-6513087606).

The native source, CLI digest, package, installation and manifest identities in
the table above were reused. Fresh CLI metadata retained 38,743,040 bytes and
write time `2026-10-29T15:52:30.5363875Z`; public library identity/status/session
readback retained the selected library and installation. This is not a rebuild,
fresh package verification, installed application or minimum-host qualification.
Steam executable version remained `11.15.70.27`; its current process was PID
`7348`, created `2026-10-30T14:37:34.4136290Z`, with window owner PID `10412`.

| Operation                                              | Actual observation                                                                                                                                                                                                                                                                                                                                                                        | Scope                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Desktop automatic focus/return                         | Steam Play started supervisor `47032` and game `33372`. Read-only foreground sampling observed game HWND `987690`, then Steam HWND `263016` after actual game Quit. Both retained handles exited 0; public request `1916e6f4-bfcb-41b4-8f5a-4159a38a91bb` succeeded.                                                                                                                      | Selected Windows Desktop game route; no explicit game activation after Play or Steam activation after Quit.                        |
| Missing standalone CLI                                 | After positive process settlement, the task-owned CLI directory was renamed. Play displayed Steam's “Failed to start process for this game” error. The latest Core session remained the prior request.                                                                                                                                                                                    | Actual missing-target negative control; Steam failure before Core launch, not a failed game session.                               |
| Explicit path repair                                   | Target and Start In were changed through Steam Properties to the relocated `Portcove CLI moved ü 日本語` directory. The quoted library argument, stable port ID and trailing `--` were unchanged.                                                                                                                                                                                         | Manual UI repair, no programmatic Steam-data writer or version-specific game target.                                               |
| Big Picture repaired launch and automatic focus/return | Steam started relocated supervisor `44904` and the same managed installation's game `40624`. Sampling observed game HWND `2167358`, then Big Picture HWND `2560232` after actual Quit. Both handles exited 0; public request `c341c6aa-8029-4473-88f2-378ee9e8905e` succeeded.                                                                                                            | Selected Windows Big Picture route after actual CLI relocation; no explicit game/Steam activation across the measured transitions. |
| Data and cleanup                                       | Runtime/canonical `tyrian.cfg` changed through normal use and match each other. Both selected `opentyrian.cfg` and `tyrian.sav` copies remained unchanged. Original CLI directory and Target/Start In were restored; arguments remained unchanged. Final relevant CIM found only the same Steam process. Both foreground observers exited 0 and the native lease was positively released. | Bounded selected-file and retained-process evidence; no gameplay-progress, hard-kill collection or whole-host-idle claim.          |

The receipt is retained in the Windows execution clone under
`work/foundations-delivery/b5-focus-20261030/receipt.json`, SHA256
`ebb966c35d200f8e253081ec1332d4f23216c1a21db713e38b402e34af736ffb`,
binding 61 artifacts: native images/UIA, foreground chronology, exact process
handles, public Core responses, selected file hashes and explicit limitations.
Screenshots include account/client context and stay local. Independent non-writing
review verified all 61 artifact hashes/sizes, inspected seven key screenshots and
cleared only the selected evidence scope recorded here.

Failed harness observations remain retained: the first Big Picture process
observer sampled before the child existed and exited 1; after actual game-window
discovery, a second observer retained both handles from the same launch. There
was no game retry. Window replacement/closed-window capture errors and the early
lease/import setup limitations confer no acceptance. Existing client extensions
were preserved and unused by this manual route; their absence was not tested.

Ordinary Linux Steam is unavailable by the owner's October 30 answer. It still
needs the independent graphical session and matrix above. Genuine managed-game
update/rollback remains unobserved: the retained public check offered no update,
and rollback reported no previous version. Use an ordinary eligible release or
legitimate retained installation, preserving unchanged shortcut fields across the
transition. Application relocation/update, spontaneous engine crash and applicable
remaining physical-media observations are not supplied by these runs. No older
manifest, version or physical-device result was manufactured.

Protected artwork-only correction remains with #246/#534, independently of these
manual checks. #292 managed Steam writes, #527 SteamGridDB, Decky and physical
Steam Deck access are not prerequisites. #290 remains open.
