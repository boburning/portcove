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

The maintained TypeScript harness client binds the retained broker/configuration
tuple and the configured PowerShell image, supplies no credential environment,
and latches a failed or mismatched response as ambiguous. It will not repeat a
launch, close or stop after that failure. Its three injected-transport tests
cover successful tuple handling, changed state/runtime, forbidden credential
fields and retained ambiguity. Those fixtures do not establish a real pipe or
native acceptance. A close operation can now identify the exact owned child
PID and creation time, because an application's window belongs to the WebDriver
descendant rather than the driver root; the helper verifies current job
membership and a retained child handle before sending the close message.

The following adapter checkpoint adds the selected account route to the
installer's central launch seam and the ordinary desktop-test WebDriver seam.
It never falls back to owner-account candidate execution. The installer reads
the qualification SID's actual loaded HKEY_USERS hive while its fixed inert
profile keeper remains positively alive. NSIS completion uses the broker's
retained nested job, exact self-copy hash and exact-root empty readback instead
of a recyclable parent PID. The selected desktop route separates writable
library/profile/preferences/update state from owner-only output and projects
actual job identities into the existing native-session assertions. It does not
forge local kernel handles or accept imported native reports.
The installer invokes that ordinary client while the installed image still
exists, before its uninstall/persistence observations. A shared parent stage
still must bind those observations to the required qualification assertions.

The selected binding also fixes the Node, Tauri driver and WebView driver paths
and hashes. Those bytes are checked before use and after owned driver teardown;
the ambient cache does not appoint qualified tools. The bridge requires its
fixed protected controller staging root and refuses replaceable ancestors,
including the known broad writable E: ancestry. All dynamically consumed helper
and driver inputs must therefore be staged and read back under the protected
root before candidate execution. That staging/setup has not occurred.

Five new adapter tests pass: exact identity/environment handling and one-shot
stop/readback, NSIS job completion and changed-root refusal, desktop job/snapshot
binding and forbidden owner fallback, and append-only bounded stream capture.
Those observations are injected/inert plumbing evidence, not cross-account GUI
execution. Twelve existing native dependency/custody tests also pass. The
declared helper inventory captures the new backend and its client/C# sources.
Capture appends only newly observed bytes rather than rewriting up to 4 MiB per
stream on every poll; unexpected retained length refuses without overwriting the
partial evidence.
Independent review identified a missing keeper working directory before its
first startup. The adapter now creates a new exact per-invocation directory after
ancestry checks and before requesting the launch; retained directories refuse.
The regression observes that real directory at the injected launch seam and
proves one launch request with repeat/collision refusal. It performs no logon.

The first hosted delivery run
[39502864188/1](https://github.com/boburning/portcove/actions/runs/39502864188)
at source `f19d0b5c27d72228b61e6ff26d3b89f8eb72b65e` failed in three ordinary
producers: the Node adapter suite was placed in the UI test tree, the existing
extracted startDriver fixture omitted its new account binding, and PowerShell
lint refused right-hand null comparisons. The Node suite now lives with the
maintained script tests, the fixture explicitly selects its unchanged ordinary
route, and null comparisons follow the pinned analyzer. The affected 36-test
selection passes; the original run and its failures remain retained. These
repairs change no native acceptance or resource limit.

This remains an incomplete stage adapter. Direct application-recovery and
private-key fixture renderer modes are explicitly refused in the selected route;
a real public signed-context update/rollback/journal adapter still has to replace
that legacy fixture path. The default owner-side harness route is unchanged.
Actual parent-owned stage capture/report serialization, protected controller
staging, exact setup/readback/recovery and the single cross-account capability
observation remain required before any native acceptance or Check issuance.

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

The follow-on stage request/capture contract derives its fixed producer, host,
account and scenario inventory from the existing global authority configuration.
It binds the exact candidate/build/package and setup descriptor, and keeps the
signed predecessor/context/signature identities separate for the post-sign
stage. Partial roots, streams and failed or ambiguous outcomes remain retained;
a complete serialization requires positive per-root and shared-group teardown.
These are integrity checks with `authority: none`, not parent provenance.

The prepared Windows scheduler observer uses read-only Task Scheduler COM and
bounded process queries. It brackets exact task XML, one Exec action, the
ordinary broker principal, IgnoreNew concurrency and a 35-minute deadline. One
observed running instance must connect to the actual fixed parent through a
creation-ordered process ancestry ending at the reported engine PID. The engine
PID is not relabeled as the application PID. The fixed inbox Windows PowerShell
reader also checks owner/ancestor ACLs on the descriptor, adjacent initial
installation receipt, global/boundary configuration, controller and capture roots.
The adjacent installation receipt avoids a descriptor/task-XML hash cycle.
Neither helper registers, starts, stops or changes a task or ACL.

The scheduler collector's private receipt denotes only an actual readback. It
must be joined to the protected local setup reader and freshly re-observed at
execution boundaries; imported fixtures cannot enter that receipt map. The
installed task, its actual engine ancestry and cross-account native behavior
remain unobserved. The tests cover integrity/refusal paths only. Microsoft
documents the [engine PID](https://learn.microsoft.com/en-us/windows/win32/taskschd/runningtask-enginepid)
and [security-context scope of GetInstances](https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-getinstances);
those capabilities do not establish that the proposed host setup exists.

The parent join now combines private setup-byte custody with the actual default
scheduler observer and checks the complete appointed producer source/tree and
harness bytes. The initial adjacent installation record has a strict transport
section naming separate source-read token and native issuer-key files; issuer
App identities still come from the global authority configuration. Neither key
nor token is configuration content or an incoming request value. Credential
files must stay outside candidate work/profile, controller and capture storage.
Windows observes their owner/ancestor ACLs without reading the issuer key;
Linux checks owner-only file custody. The private parent getter rechecks actual
setup and scheduler state before use. Its receipt is parent-boundary provenance,
not a native qualification result or an execution grant.

The disposable credential-ACL fixture initially also attempted a positive
non-private path check in the host's ordinary temporary directory. The real
ancestor guard refused it as foreign-replaceable. That outcome remains a
refusal; the focused fixture now exercises only rejection of a foreign reader
on its new disposable file, without claiming protected temporary-directory
custody. The initial setup still has to establish the real protected roots.

The local selector now reuses the complete admission collector's source/run/
archive/reservation acquisition. Its private default transport reads the
separately protected source token after actual-parent recheck, admits only
fixed-repository GETs and read-only GraphQL queries, and supplies the token only
to a hash-pinned GitHub CLI child's closed environment. The initial transport
record therefore also names `github_cli: {path, sha256}`. It never modifies the
parent's authentication environment. The reused admission result retains
`injected-provider` scope; that result cannot become native or admission
acceptance. The selector reconstructs the exact NSIS/AppImage package tuple,
rechecks the remote checkpoint, retains a pre-sign data-only request, and exposes
it only through its private selection map with fresh parent/package/checkpoint
readback. Native execution and Check issuance remain unimplemented by this
selection component. No post-sign or public journey is inferred from it.

The pinned source CLI is an owned copy under the prepared protected tools
storage. Its path is the ninth Windows scheduler custody observation, with the
same owner/ancestor and foreign-write refusal used for public fixed inputs;
Linux requires owner-only file custody. It cannot overlap credentials, public
configuration, candidate work/profile or capture storage. This closes the gap
between a matching tool hash and a candidate-writable executable path, without
adding a global installation or changing an existing host ACL.

The bridge capture now also retains each actual returned root's image path,
verified launch digest and UTC startup time alongside PID/creation and teardown.
The digest comes from the fixed verified-launch operation's deny-write/delete
custody, not from an imported report. A missing teardown remains null. A focused
inert root-projection test passes; its first assertion incorrectly compared a
PowerShell 7.6 automatically parsed JSON DateTime with a string, and now checks
the exact retained wire timestamp. No candidate was launched by this fixture.

One bounded, read-only WSL capability inspection saw Ubuntu and docker-desktop
registered as stopped WSL2 distributions. The single fixed Ubuntu owner/tool
query then reached its 20-second child timeout without stdout or stderr. It
returned `ETIMEDOUT`, not Linux OS, tool, interop or native evidence. At
2026-10-20T22:39:40.323Z, the owned wrapper/Node/WSL process inventory was empty;
no global WSL shutdown or reset was performed. The query was not repeated. A
cold-start timeout does not establish an unsupported host; the actual Linux
account, cgroup, GUI and minimum-platform route remain unobserved.

The native invocation claim is now prepared around the existing coordinator's
bounded counters. Initial setup must create the protected capture root's
`.native-capture-custody.jsonl` with one line containing only
`{"schema_version":1,"kind":"native-capture-custody","setup_grant_sha256":"EXACT_APPROVED_GRANT_SHA256"}`
and a final newline. The worker cannot create or replace this initial marker.
Each deterministic invocation is appended and synced before its fixed
`native-attempt-INVOCATION_SHA256` directory and original request claim are
created. A missing directory, marker, capture or contradictory append refuses
continuation; it does not reset a retry counter. The claim contains the actual
frozen request, coordinator checkpoint and bounded counters.

Repeating an invocation returns readback-only after validating its original
capture and positive owned-root/shared-group teardown. Every retained stream
must still match its exact byte count and digest. A possible Check POST requires
the original fixed wire and GET-only issuer/source/report reconciliation before
any later invocation. Missing, duplicate or incomplete provider inventory holds;
there is no POST replay or automatic native retry. Reused consumer observations
remain explicitly unbranded and cannot clear native admission. Focused fixture
coverage passes nine tests, including lost custody, changed counters, ambiguous
cleanup, changed wire and imported-receipt refusals. Actual task, native launch,
Check issuance and scheduler/account qualification remain unobserved.

The fixed installed worker now has a Windows driver connection through the
existing resource supervisor. It privately selects and claims the candidate,
rechecks source/reservation after resource admission, and launches only the
fixed owner-side PowerShell driver. Its closed environment carries no source,
issuer or signing credential. The driver stages the exact installer under the
protected controller inputs, creates only per-invocation work/capture children,
and uses the existing separate-account bridge for every installer, application,
driver and WebView root. The parent owns one latched final group-finish request.
The new capture leaf makes inherited entries explicit without adding rights or
altering the existing root. This code has not changed any real host ACL.

Initial installation data can now supply strict `windows_tools` pins for an
owned PowerShell7 runtime, Git, Node, Tauri driver and WebView driver. No runtime
is discovered, downloaded or installed by the worker. Missing tools hold. The
driver checks owner/ancestor custody and bounded hashes before and after use;
the selected Node bound remains 128 MiB. Its owner-side bridge/harness streams
use the same four-MiB raw prefix and strict UTF-8 guard as candidate streams.
Faults stop the affected child and retain the prefix. Child/group identities,
nonzero outcomes and ambiguous completion remain separate from native success.

The isolated installer now checks registration in the actual qualification SID
hive rather than the broker's HKCU. The installed empty-library observation
also retains the existing Core capability IPC response, actual WebView process
snapshot and bounded loaded-image hashes. No product command or client trust
path was added. Seventeen focused local tests pass, including actual inert
PowerShell child streams with normal output, invalid UTF-8 and overflow, plus
wrong-hive and imported-capture refusals. Those are component observations;
the fixed Task/account route has not run. Whole-stage report construction,
native Check handoff, the signed-context/post-sign selector and the Linux
separate-account backend remain engineering work. The current worker reports
HOLD after driver capture and cannot publish native acceptance or a Release.
