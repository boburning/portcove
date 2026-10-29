# Slice 6 manual desktop Steam acceptance — October 29, 2026

Owner: [#290](https://github.com/boburning/portcove/issues/290). This dated
receipt distinguishes application success, installed-game preparation and actual
game/session acceptance. The issue and live Project remain authoritative.

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

## Windows continuation need

Desktop control remains explicitly stopped. The exact next interaction need is a
renewed authorized, uncontended Windows desktop-control session for the stable
game-entry creation and remaining matrix. Recheck live process and mutable-data
state before acting. The first acquired-game UI launch retains the Computer Use
skill's action-time confirmation requirement; do not run it elsewhere to bypass
that boundary. Neither a scheduled wake nor another input mechanism resumes the
stopped session.

Protected artwork-only correction remains with #246/#534, independently of these
manual checks. #292 managed Steam writes, #527 SteamGridDB, Decky and physical
Steam Deck access are not prerequisites. #290 remains open.
