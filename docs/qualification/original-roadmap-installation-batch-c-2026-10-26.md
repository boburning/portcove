# Original roadmap installation batch C — October 26, 2026

This dated candidate covers the remaining seven identities in the frozen original
22 roadmap joins, reconciled against main
`5dd4b2ed46cf1786e54ba48a4244fea67610176e`. The
[machine-readable packet](original-roadmap-installation-batch-c-2026-10-26.json)
records exact identity, source, platform, ownership, setup/data and delivery
boundaries. It is evidence, not a new live backlog. #2510/#2926 remain open,
Public beta / Required; complete Public beta acceptance remains false.

| Identity / canonical owner | Candidate route                                                                                      | Precise remaining boundary                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stunts HD #2862            | Windows/Linux x64 native-portable runtime; existing-copy, browser and OS application alternatives.   | First explicit Play needs own Stunts 1.1 files and a network map. External profile is outside Core backup; missing historical map caches can prevent old versions from preparing.                                                      |
| CyberMage #2836            | Conditional permitted existing Windows player, original-file picker and exact data guidance.         | Upstream explicitly excludes its embedded commercial Darklight icon from the MIT grant. Fresh acquisition needs accepted permission or a clean official package; interpreted game code is not an unsupported-operation classification. |
| Remastered Plus #2841      | Conditional permitted existing Windows/Linux Godot export.                                           | Bundled sprite/music grants remain unresolved; ROM verification does not extract or authorize those assets. Current RAR versus historical ZIP handling is a separate fact.                                                             |
| GTA III #2852              | Conditional permitted existing re3 player and own original PC assets.                                | Archived game-specific source explicitly declines to license the code. Preserve the existing fresh-distribution/build qualification condition.                                                                                         |
| Vice City #2853            | Conditional permitted existing reVC player and own original PC assets.                               | Same archived repository, distinct game/tag/data contract; do not join it to III or imply fresh binary clearance.                                                                                                                      |
| EarthBound Companion #2861 | Conditional permitted existing Windows launcher with upstream original-ROM preparation and recovery. | Explicit native-foundation redistribution/GPL boundary remains unresolved. Keep custom data-root arguments and separate edition/seed saves; preserve #173's different integration.                                                     |
| Abuse 2025 #2913           | Conditional permitted existing Windows/Linux player; macOS OS application handoff.                   | Mixed game-data/music/soundfont grants and exact clean-data subset compatibility remain unresolved. No automatic asset substitution or offered Linux archive is invented.                                                              |

## Stunts carrier, setup and data evidence

At source `59b9e1a22c1ecf880a16b199a4a454489b20e59d`, the official v1.5.22
Windows ZIP and Linux tar.gz were acquired and inspected read-only. Independent
publisher digests match actual bytes:

- `Stunts-HD-win-x64.zip`: 111,604,171 bytes;
  `118f0598916966bb8d79f3786016e94c8cb8dce57b7e97c02240c41c8d52aaf5`.
  Sole AMD64 game target: `Stunts HD.exe`. The 98 raw ZIP entries expand to
  282,103,559 bytes; Electron/Chromium notices are retained.
- `Stunts-HD-linux-x64.tar.gz`: 102,789,136 bytes;
  `693ab6cc4c8d96df57752c28df0e0f65a5bb56635a8d08eec57098da83c48543`.
  ELF64 x86-64 game target: `Stunts-HD-linux-x64/stunts-hd`, distinct from
  sandbox/crashpad helpers and shared libraries. The 100 raw tar records contain
  no links, PAX extensions or privileged mode bits; decoded size 275,720,192 bytes.

Private inspection used finite compressed/member/expanded/notice budgets and
raw-metadata validation before parser materialization. The first Windows
inspection's 100 MiB compressed-budget refusal is retained; an observed-size
128 MiB private inspection cap admitted the 111.6 MB package. Product extraction
budgets and assertions are unchanged. No game, helper or installer ran.

The desktop carrier is Electron 33.2.1. Original x86 game code is translated
locally from the player's files into JavaScript running on a modeled PC. The map
contains names/places/checksums; generated game code is an in-memory Blob. This
is separate from a statically compiled native game CPU and does not itself
prevent safe carrier management. Reviewed project/Three.js MIT attribution and
retained Electron/Chromium notices remain separate from the original game.

The empty runtime persistence declaration is evidenced, not a placeholder:
ordinary original-file import uses IndexedDB `stunts-recomp`, schema 1,
`files/game`; tracks, replays, high scores and preferences use localStorage under
stable `app://stunts`. Logs, window state and version-keyed maps also use the
external Electron profile. Version-matched Electron source documents the
[profile/name defaults](https://github.com/electron/electron/blob/v33.2.1/docs/api/app.md):
`%APPDATA%/Stunts HD` on Windows and `$XDG_CONFIG_HOME/Stunts HD` or
`~/.config/Stunts HD` on Linux. No profile override was found. Screenshots and
exports use the user-selected save destination; explicit self-test output goes
to temporary storage. No ordinary runtime writer or self-updater was found;
`publish:null` is retained. The v1.5.21→v1.5.22 source comparison preserves the
entry/boot blobs, product name, Electron version and database coordinates.

Back up the complete profile with the game closed. F6 exports do not provide a
complete profile restore: imports accept tracks/replays, while settings, high
scores, imported originals and cached maps need the actual profile. Import can
continue temporarily in memory after a storage failure, so retain originals.
Core's empty contract does not promise player-data backup or data restoration.

A version cache miss fetches one mutable HTTPS map. Upstream checks the generated
translation against that map, not a Core original-input receipt. Fresh setup,
an update or a rollback with no matching cached map can fail if the hosted map
no longer fits. Keep cached maps and working versions; no offline/historical-map
or save-compatibility guarantee is made. Core still stages/verifies the runtime
and preserves previous activation/recovery protections. Linux sandbox/GPU/OS
execution remains unqualified; no Core sandbox bypass or helper invocation is
added. macOS bundles, ARM and AppImage routes retain upstream handling.

## Other source and ownership corrections

CyberMage's permitted-copy guide uses the upstream first-Play v1.01F picker:
ISO 9660 `.iso` or `CM_HI.EXE`, not BIN/CUE or an arbitrary original revision.
It copies into `iso/CYBERMAG`, keeps `run` and `NATIVE.CNF`, and supports a custom
root. Its explicit icon condition is distinct from the player's original game
and from optional SC-55 firmware. No CyberMage package was acquired.

Remastered Plus is a real Godot fork of #1891, with separate opaque repository
identity. Its checker verifies seven ROM hashes, one with an unresolved edition
label; it does not extract the bundled sprites/music. The player-facing screen
shows its actual ROM folder. Parent and child both select the
`SuperMarioWorldRemastered` custom user directory, so switching requires keeping
the shared profile recoverable; no fork save migration is qualified.

III uses `re3_v1.0` source `e35c56ceb3eea3c3ccda1cc4e6645e901787d70a`;
VC uses `reVC_1.0` source `e604be65d9b7845ee7ca975545fc9277c662bc11`.
Their readmes separately place saves/settings in the game root and name
`re3.ini`/`reVC.ini`. Earlier raw latest-release observation for III was actually
VC; it is retained as raw VC evidence and superseded by III's own tag. Shared
repository identity never merges the games or licenses their code.

Companion registration keeps the launcher and any existing `--data-root`
argument; empty arguments would open a different default profile. Its ordinary
Windows root is the launcher directory; portable/preview variants can use
`%LOCALAPPDATA%/EarthBoundCompanionPreview`. Keep the actual root, including
Game, Profiles, UserData, msu, mods and generated edition/seed content. Normal
phone saves, build-specific quick states and upstream restore/migration remain
distinct. The nickclyde #173 integration and retained contracts are untouched.

Abuse uses `SDL_GetPrefPath("abuse", "data")`, `ABUSE_SAVE_PATH`, or its actual
current-directory fallback, plus the separate `ABUSE_PATH` asset override.
`local_save` is not evidence of beside-player storage. The clean-data proposal
still needs exact compatible subset evidence; no mixed assets were replaced or
acquired. Apart from the two Stunts carriers, no runtime package was acquired.

## Coverage and validation boundary

The candidate adds seven authored identities and one operational definition:
1,424 authored /166 operational. All 1,417 previous per-ID blobs and all 165 prior
operational definitions remain unchanged. The original 22 joins become
17 authored/five unlisted: four existing named acquisition holds and one explicit
retirement. All 22 identities are accounted for; this does not resolve every
held fresh-acquisition operation or mark all research Reviewed. Original
524 identities/312 affected additions remain preserved. Four current Direct
choices and two retained legacy transitions remain unfinished.

Maintained preparation validates all seven records with production Core and
reviewed original-game artwork. Derived aggregates are generated, not edited.
The existing controlled provider replay gains both observed Stunts platforms:
v1.5.21 metadata → v1.5.22 metadata with unchanged authored rules, expiry and a
fresh client. Only v1.5.22 carrier contents were inspected; neither version ran.

Focused local checks passed 26 Node cases across two requested files (zero skips)
and both requested Linux Core cases (2,051 unselected). Generated-output
consistency passed. These are not complete suites.

Complete-candidate review, exact-head hosted inventories, guarded merge and
canonical readback remain separate PR/issue evidence. This packet does not
manufacture future passes. No production Rust/UI/lifecycle code changes;
#2225/#47/#48 and #534/#246 retain their independent acceptance.
