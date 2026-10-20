# Native account launcher preparation — 2026-10-20

This is a prepared Windows launcher component, not native package acceptance or
an executable setup request. The selected direction uses a one-time separate
non-administrator account and fixed inherited boundaries; routine qualification
must not require UAC or per-attempt administrator ACL changes.

`scripts/native-qualification-account.cs.txt` keeps the fixed parent in the
broker owner account. Its candidate launcher uses `CreateProcessWithLogonW` with
`LOGON_WITH_PROFILE`, an explicit executable and private desktop, a scrubbed
environment, suspended creation and a 64-process JobObject with kill-on-close
and no breakaway. It verifies the actual token SID, rejects administrator group
membership including filtered tokens, and checks the loaded profile and GUI
session before resuming. Password memory is zeroed after the API call. It does
not receive a GitHub, signing or publication credential.

The per-attempt GUI station and desktop grant the candidate GUI-specific rights
without rights to change their ownership or DACL. They never use the owner's
interactive desktop. The helper must run in a separate noninteractive owner
process because changing its process window station is process-wide. A retained
root handle and creation FILETIME bind termination; bounded job PID readback
requires the root to exit and the job to become empty. A failed or ambiguous
termination is latched and permits readback, not a blind second termination.
Closing the job is a last-resort cleanup effect, not positive teardown evidence.

The helper compiles on this Windows host. Its inert test passes nine refusal
cases covering credentials, owner/account separation, private desktop, working
directory, inherited credentials, search path and writable environment paths.
No account was created, no credential supplied, no logon attempted, no desktop
created and no filesystem ACL changed. An initial `Add-Type -Path` call rejected
the `.txt` extension before compilation; using the fixed source as
`-TypeDefinition` then compiled successfully. This preserves that setup failure
without interpreting it as a runtime failure or a native pass.

The follow-on helper also exposes the retained-handle and private-desktop window
operations needed by the existing owner-side harness, and fixed owner Credential
Manager lookup for the local account only. That lookup was not called. The
read-only input tests now cover twelve refusals, including NSIS's documented
last, unquoted absolute `/D=` destination and refusal of a destination outside
qualification work. The GUI fixture parses without being executed.

A separate actual same-owner anonymous-pipe test passes normal bytes, rejects
invalid UTF-8 and refuses output beyond four MiB. Capture starts on a worker so
synchronous pipe reads do not delay resuming a suspended child. The current
[.NET Windows process implementation](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Windows.cs)
uses standard pipe handles with the same logon API; this supports preparation
of that route, not a claim that the unperformed cross-account test passed.
[NSIS's command-line contract](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage)
requires preserving the terminal unquoted install destination.

The tightened pipe test also observes a refusal while the invalid-byte writer
is still open, retaining the exact raw `41-FF` bytes. Overflow retains the first
4 MiB. The process wait polls capture faults every 25 ms and performs one
termination plus bounded teardown readback before reporting the failure; a
failed termination stays latched. Raw snapshots remain available after decoding
or size failure. These tests do not exercise cross-account termination.

The current helper enforces a 64-active-process limit per launched root job.
It does not enforce a JobObject memory, CPU-time or writable-storage limit.
The final multi-root bridge must reconcile total process admission and the
existing resource supervisor before claiming a whole-attempt limit. Ordinary
outer deadlines and proposed filesystem boundaries are not observed enforcement.

The prepared `AccountGroup` adds one shared 64-process job across all supplied
roots before their threads resume, followed by each root's nested cleanup job.
One actual same-owner inert fixture observes two roots in the shared job,
terminates the first nested job without terminating the second root, then
observes an empty shared job after final teardown. Initial fixture assertions
incorrectly required exactly two total processes; the observed descendant PIDs
made that fail. The corrected fixture retains the root identities and permits
their actual descendants. It does not establish cross-account job assignment.

The validation-only checks now cover eighteen refusals. Besides the required
ten environment fields, the helper admits only enumerated runtime state paths
inside qualification work and explicit local fixture URL/port/state values.
It refuses an unknown `PORTCOVE_` field, external writable state, an ambiguous
port spelling and a remote or credential-bearing fixture URL. There is no
inherited environment or wildcard runtime-variable permission.

`scripts/fixtures/native-account-gui-probe.ps1` is prepared for the single inert
post-setup test. It creates a basic private-desktop WinForms window and a bounded
inert descendant, reports its account/profile/PIDs, and leaves all descendant
termination assertions to the owner parent. It is not a WebView, package,
minimum-environment or native Check producer. It has not been run.

The actual host was observed as Windows build 26300.9711 / DisplayVersion 26H2.
That establishes host availability only. No serviced or loaded WebView version,
native minimum-platform acceptance, installed package or update journey is
inferred from it.

## Remaining implementation and one setup boundary

The proposed account/configuration is recorded in
`slice4-native-account-boundary.proposed.json`. The host's broad Authenticated
Users write grant on `E:\` means creating an ordinary account alone would be
insufficient. Exact one-time protected-root/exception ACL preparation, readback
and rollback must be implemented and reviewed before a setup command is offered.
The local account credential and a distinct repository-scoped native Checks
issuer are separate custody items; neither has been provisioned.

The existing owner-side installer harness still needs its fixed account launch
adapter, qualification-account HKCU/profile readback, direct capture, and shared
pre-sign/post-sign report serialization. These are engineering gaps. In
particular, JobObject descendant readback does not prove every possible account
process or service-mediated launch is contained, and must not be expanded into
that claim. No native Check may be emitted from this component alone.

The prepared fixed bridge/client scripts use a Windows owner-only named pipe
for launch and retained-handle observation. The client checks the actual server
PID, creation FILETIME and token owner before sending a bounded command. The
bridge permits only start, observe, close, one-shot stop, readback and finish;
request framing is at most 32 KiB and responses at most 64 KiB. It polls capture
faults while waiting for owner commands and retains raw streams, phase and job
readback on failure. Finish requires complete stream tasks and positive teardown
for every root and the shared group. The verified launch holds a deny-write and
deny-delete executable handle through hashing, suspended creation and resume.

Those scripts parse; they have not been started. Four command-framing refusals
and the three existing helper tests pass, alongside the ordinary routing test.
There is no actual pipe-server identity observation, cross-account invocation,
loaded-profile keeper, installer/desktop-test adapter, native report or account
setup from this checkpoint. In particular, the launch API is transport plumbing
and cannot grant native acceptance or release an issuer credential.

After those independent changes and exact setup/recovery preparation are
reviewed, one credentialed inert capability test must establish the actual
cross-account private-desktop GUI/profile/capture/teardown route. Its result may
fail and must remain failed; no repeated VHD, authentication or fixture loop is
authorized by this component.

The pre-sign stage must retain actual package bytes, install/launch, minimum
platform, protocol and persistent-state observations. Actual compatible signed
update, rollback and journal recovery gate publication separately. Full public
V0-to-V1 acceptance follows publication; it cannot gate its own initial
publication. #254 remains Done, #315/#534/#246 remain pending, Chameleon
protected acceptance remains unset, production remains held and Slice 5 remains
excluded.

The API feasibility claims use the current primary documentation:
[CreateProcessWithLogonW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw)
and [window station and desktop creation](https://learn.microsoft.com/en-us/windows/win32/winstation/window-station-and-desktop-creation).
Documentation support is distinct from the unperformed cross-account host test.
