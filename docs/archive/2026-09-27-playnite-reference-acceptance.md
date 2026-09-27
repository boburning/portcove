# Playnite reference acceptance checkpoint — 2026-09-27

This checkpoint is for the developer-loaded Playnite reference client in #243. It
does not qualify the planned installable integration in #910 or real-game
playability. The native host was Playnite 10.56.0.23531 with SDK 6.16.0.0 on
Windows x64. The fixture was an owned synthetic OpenGOAL Jak 3 source and
executable, not original game data.

## Negative-path map

| Case | Current boundary | Evidence and limit |
| --- | --- | --- |
| Busy library | The compiled client surfaces a `conflict` from the public `status` command while the library lease is held. The same library is readable after release. | `just playnite-check` runs the real CLI with an exclusive `library.lock` lease. This is a read conflict, not every possible concurrent writer. |
| Busy port and cancellation | The real CLI fixture checks busy-port refusal, cancellation and recovery through durable activity. | `just playnite-check`; synthetic fixture, not every native dialog timing. |
| Stale selection | Import keys use the opaque library ID and port ID. `Identity.Port` rejects a different library. The management dialog binds one game and port and rechecks the library identity on refresh and actions. Preparation submits the exact reviewed plan fingerprint to core, which revalidates it. | Contract identity test, source inspection and the native single-game dialog. Concurrent out-of-band changes are covered by core's fingerprint/lock checks; a manual race through every dialog was not run. |
| Private data in exported evidence | Only the redacted checkpoint and sanitized summary are suitable for issue/PR export. | The new summary was inspected for credentials, account names and host paths. Historical raw screenshots and Playnite logs contain local paths and remain local. |

## Native refresh, action and launch

An isolated Playnite profile loaded the current reference DLL and a local
qualification CLI. Playnite imported 77 current Windows catalog entries. The
managed OpenGOAL Jak 3 entry showed the owned installation and `preparation
required`. Its management window showed source profile, action assessment and
retained activity. After review of the exact synthetic plan, Playnite requested
preparation; the window then showed launch readiness and `prepare: succeeded`.

Playnite's Play command launched the owned synthetic executable. Playnite showed
a three-second session. A fresh management window showed `launch: succeeded`,
`prepare: succeeded` and `Last launch: collecting, succeeded`. The public CLI
read back terminal launch activity `36b90514-1b22-4929-a19b-89517859a765`
and preparation activity `54fafa6f-d57c-4512-a96a-3e63b2ae613e`, with no
current, attention-required or recovery-required activity IDs. This proves the
frontend route and retained readback for this synthetic case, not gameplay.

The first native import attempt failed because managed `status` omits
`external_runtime` and the client required that field. The candidate now treats
an absent or null external runtime as a managed status and rejects a malformed
non-object value. The install completion controller also consumes that optional
field through the checked status-installation mapping; that mapping has focused
contract tests, while the controller callback was not rerun in a native
installation flow. The failed Playnite profile/log remains local for diagnosis.

## Evidence handling

The isolated profile and its failed/successful Playnite logs remain under the
ignored `work/playnite-native-243-20260927` directory in the owned worktree.
They include host paths and are not an export artifact. The sanitized summary
under its `evidence` directory contains only fixture labels, result states,
activity IDs and binary hashes. It was checked for credential and account/path
markers before use. Earlier native screenshots in the September 9 checkpoint
are historical evidence; their raw sidecar metadata includes a local username
path and is likewise not suitable for direct publication.
