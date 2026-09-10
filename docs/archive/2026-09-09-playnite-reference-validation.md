# Playnite reference native validation — 2026-09-09

This dated observation records agent-operated Windows execution for the bounded
reference implementation in [PR #580](https://github.com/boburning/portcove/pull/580).
It is not a live roadmap, released artifact, retail gameplay result or an
independent-consumer exercise. Current acceptance remains in #243 and #30.

## Exact inputs

| Input | Identity |
|---|---|
| Client source | `302b12158bbcddead744c6992d7a1abceb035cde` |
| Client DLL SHA-256 | `8a473e514d5214cce0ad41d3654687c869d2d1b8c35826d3f4e02365fa047799` |
| CLI candidate source | `490b4c4a73829d4bfb3392f7c72ac814c0a6b8c9` |
| CLI archive SHA-256 | `8ce6f48478ecd6294d6017cb1d26cdbb3bf77d9da985d88cd3cc42b1246653ad` |
| Extracted CLI SHA-256 | `44351c2935fc478f405ffade4d07e90d71e962bdafdac197c60ab7cc8026eab8` |
| Playnite | `10.56.0.23531`, public runtime SDK `6.16.0.0` |
| Build SDK | Locked build-only `PlayniteSDK 6.15.0`, .NET Framework 4.6.2 |
| Contract | API schema 42; event schema 2; Windows x64 |
| Synthetic game/setup executable SHA-256 | `a03ff588779fec06b4b752258cc687d5e04c6f622ea4eb24e960cc5cbcf177e9` |

The CLI was built with the release profile, packaged by `package-cli.ps1` and
verified by `smoke-test-cli-archive.ps1`. The standard archive contains the CLI
only. Its current source product version is 0.1.0-alpha.2, but these candidate
bytes are not the historical public Alpha 2 release. Nothing was published.
The client commit differs from the CLI candidate only in client presentation
and observation code; core and CLI source are identical between those commits.

## Observed behavior

An owned `--userdatadir` profile loaded the local extension, accepted explicit
CLI/library settings and imported 67 Windows catalog entries. The initial
first-run wizard could not be reliably captured; the owned qualification profile
was configured directly to skip it and use Playnite's documented software
rendering option. This does not prove novice onboarding or the first-run wizard.

A redistributable synthetic executable, derived from the repository's host-tool
test fixture, was adopted through the public CLI under the existing OpenGOAL
Jak 1 definition. Its source file contains synthetic text, not original game
data. This exercises the real upstream-managed-setup path with owned code; it
does not qualify OpenGOAL or admit another catalog artifact.

Playnite showed preparation required. The native confirmation exposed the exact
installation, registered source, setup executable/hash, 685172 copy bytes, mode
and target. After confirmation, core prepared and activated a private copy, and
Playnite displayed launchable readiness and retained `prepare: succeeded`.
The original setup and game executable hashes remained unchanged.

Play invoked the packaged CLI with a newly retained request UUID. An independent
public-command observer recorded preparing, spawning, running, collecting and
terminal success for request `6059d738-9e25-4a02-8873-27a2edf5f49c`, supervisor
17100 and child 2244. Playnite logged game start and stop after three seconds.
These PIDs are historical observations, not reusable process identities.

After a clean Playnite exit and restart, library refresh retained the game entry
and displayed the new prepared installation path. The management view read back
`launch: succeeded`, `prepare: succeeded` and the same last-launch terminal
outcome from core. No launch was automatically replayed. The repaired view used
readable theme foreground and font resources.

## Validation and limits

All 43 client contract checks passed against the extracted candidate, including
actual literal Windows arguments, schema/capability mismatch, malformed and
oversized records, invalid UTF-8 draining, lost events, conflict/cancellation,
launch identity/phase/outcome validation and real CLI discovery. The final core
audit passed 709 Rust tests, 231 UI tests, 20 Windows qualification scenarios and
31 advisory/zero blocking findings. The earlier deep pass reported unavailable
optional Hawk/semdup analyses rather than a clean result from those tools.

Local evidence is retained under `work/playnite-native-first/evidence`, with
packaged identities in `work/playnite-packaged-candidate-490b4c4/candidate.json`,
launch observations in `work/playnite-native-launch-observations.json`, and the
completed application log in `work/playnite-native-completed-session.log`.
Evidence contains only the owned fixture's local paths and process identities;
no original game files, credentials or raw game output were exported.

This does not prove a second real adapter's install/update lifecycle, all native
failure/cancellation/disconnect scenarios, intrinsic human observations, another
physical platform, public release qualification or an independent author working
without implementation knowledge. Synthetic protocol cases and this native
session remain separate evidence categories.
