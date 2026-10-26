# Native-engine upstream routes — October 26, 2026

This six-port batch continues #2926 and Public beta / Required parent #2510
from delivered main `ac2769c81ad59631e7ee900ee5baa47ef760841e`.
All six original-inventory identities were frozen at source `62c4605f` and
reconciled byte-for-byte against that main before authoring. Their canonical
issues and Project records include two existing Blocked owners. No game is
joined merely because it shares an upstream repository.

The [source-bound packet](native-engine-upstream-routes-2026-10-26.json) records
complete official release/source retrieval, actual Windows archive observations,
route/data ownership and the remaining managed-fit decisions. It is dated
evidence, not a second backlog. The original 524 identities, 312 affected additions
and 22 roadmap joins remain in scope; this packet is not a complete current
inventory or Public beta acceptance claim.

| Identity / canonical owner                  | Selected useful Windows route                                                                                                                                                                                      | Setup, data and update boundary                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zdoom-gzdoom` / #1824                      | Recommend the Windows ZIP and its sole AMD64 `gzdoom.exe`; choose the original IWAD through the upstream first-Play flow.                                                                                          | Default settings use Documents/My Games/GZDoom; saves use Saved Games/GZDoom. Optional portable mode uses the local portable INI and Save folder. Original files, mods and profile remain player/upstream-owned.                                                          |
| `vcmi-vcmi` / #1902                         | Refine the existing useful route: the Windows ZIP includes four AMD64 applications. Import data through `VCMI_launcher.exe`, then register `VCMI_client.exe` for Play. Keep the launcher for setup/mod management. | Complete/Shadow of Death or GOG offline EXE+BIN data; Restoration of Erathia/HD Edition is rejected. Windows data, saves, settings and mods normally use Documents/My Games/vcmi. Preserve the current runtime/profile for unfinished games across major-version changes. |
| `wargus-wargus` / #1904                     | Recommend the upstream portable Windows EXE as an NSIS setup program, then register the installed `wargus.exe`.                                                                                                    | First launch asks for Warcraft II DOS/Battle.net files or a GOG installer and performs upstream extraction. Generated data, settings and runtime updates remain upstream/player-owned.                                                                                    |
| `wargus-war1gus` / #1905                    | Recommend the upstream portable Windows EXE as NSIS setup, then register installed `war1gus.exe`.                                                                                                                  | First launch accepts DOS DATA.WAR or a GOG installer. Official instructions report demo/shareware/Mac extracted data failing. Keep the upstream data/settings with the installation when updating.                                                                        |
| `r-e-l-i-v-e-oddworld-abe-s-oddysee` / #133 | Keep the existing fresh-acquisition hold explicit; offer conditional registration of an already permitted working copy.                                                                                            | Oddysee keeps its own original-data identity and owner. No executable name, arguments, save paths or permission are invented.                                                                                                                                             |
| `r-e-l-i-v-e-oddworld-abe-s-exoddus` / #122 | Same bounded upstream hold, distinct Exoddus identity and conditional existing-copy route.                                                                                                                         | Exoddus does not inherit Oddysee source, save or executable qualification merely because both use AliveTeam/alive_reversing.                                                                                                                                              |

All offered runtime-update routes declare `user-managed-update` on their
canonical owners. The listing guides do not grant Portcove runtime replacement,
data backup, rollback, external deletion or migration rights. Existing files and
registrations retain their ownership and contracts. The new shared #3667 player
suggestions benefit suitable project-named players; raw EXE setup packages still
require an explicit upstream handoff. Read-only discovery runs no installer,
helper or player. Registration and Play remain separate intents.

## Evidence and remaining managed fit

Official release pagination and tag-source trees are complete for all six
identities. Maintained `prepare-port.mts` selected-release feedback proves each
of the four stable, version-independent hint sets matches exactly one reviewed
package. No ordinary release update needs a newly pinned filename here.

GZDoom g4.14.2's actual Windows ZIP contains one AMD64 player. Bounded metadata,
entry paths, native headers and packaged license notices were read without
extracting or executing runtime content. The asset has no publisher digest;
computed SHA-256 `6d01c5bb48610cebfa9dfd0b7705a1e20bfd56032a74484ac256d8c4e3c51bee`
is an inspection identity, not authentication. An independently expected identity
and complete runtime-writer/portable-data contract still need resolution before
managed admission. The useful upstream route is available meanwhile.

VCMI 1.7.5's publisher SHA-256 matches the actual ZIP:
`0a530799085c1a135f9686d49d859beab8741869dcd9fe0877ef428ca0830d88`.
Source `6901839ae9760dfcd1d5ff2c4aa4ef6968fee752` establishes a concrete
fresh-setup gap: `launcher/main.cpp` detaches the Windows client and quits;
`clientapp/EntryPoint.cpp` rejects missing original resources and shuts down with
a fatal dialog, without a first-Play import picker. External launcher settings
are not the atomically completed runtime-local JSON marker supported by the
existing native setup contract. Establish a fitting source/completion and launch
lifetime contract before claiming managed fresh creation. The completed external
client route preserves useful upstream setup and mod features. These two
managed-fit decisions stay unfinished, not Unsupported or newly deferred.

The current Wargus/War1gus Windows releases offer NSIS EXEs, including their
portable-named packages. Tagged `.nsi` and launcher source identify setup,
installed players, original-file selection and extraction. Such installers are
outside current native-portable ZIP/tar.gz/tgz handling; the upstream handoff is
the fitting operation. Reconsider managed adoption if upstream publishes a
compatible authenticated archive and an expressible generated-data/update
contract. This is an operation-specific limit, not a universal platform ban.

For each Oddworld owner, the original stable-integrity/license/exact-source hold
remains. The current github-v1.0.9 release offers debug archives without publisher
digests; the complete source tree has no license file and its README does not
establish a clear current redistribution grant. No held package was acquired.
The existing reconsideration condition is licensed stable packages with
authenticated integrity and the exact original-game source contract. The authored
fresh-download restriction implements that existing condition; it does not
revoke retained installations or grant permission to use another copy.

## Verification and delivery boundary

Six per-ID records use maintained preparation; generated aggregates use
`generate-catalog.mts`. Names, artwork, lineage, existing original-game metadata,
all operational definitions and source tables remain intact. Final independent
review and hosted checks bind the complete PR candidate; canonical issue/Project
readback owns actual delivery. No port receives a Reviewed stage merely because
its listing now has useful guidance.

Actual archive inspection, fixture checks, native execution and acceptance remain
separate. No upstream player, installer, helper or original game was executed.
Other-platform behavior, managed lifecycle, packaged Desktop and real-save
acceptance are not established. #1422's frozen cohort and #2225/#47/#48 and
#534/#246 retain their separate scopes.
