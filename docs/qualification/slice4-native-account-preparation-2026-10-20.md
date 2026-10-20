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
