# Hosted Windows GUI execution proposal — October 26

This is a disabled engineering proposal for [#534](https://github.com/boburning/portcove/issues/534)
and draft [#3559](https://github.com/boburning/portcove/pull/3559), prepared from
retained source `6ea7e12264a7f2e9505825d4d941d9bb93237e29`. The
[owning receipt](https://github.com/boburning/portcove/issues/534#issuecomment-6404962768)
remains authoritative. Earlier failed runs, including the exhausted audit batch
and its historical unknown recovery state, remain failures at their original scope.

## Local findings

A real Windows repro found an independent observer race. An initial empty desktop
can produce `EnumDesktopWindows == FALSE` with no extended error. The old broker
threw immediately and terminated the root before its form started. The shared
lookup now clears last-error before enumeration and treats FALSE/error0 as
pending with no HWND. FALSE/nonzero still fails. Ownership, `IsWindowVisible`,
non-input status, generation checks and bounded `WM_NULL` response remain required.
The real current-token WinSta0/private-desktop test fails against the retained
lookup and passes against the repair. It creates only an owned inert form and
verifies root exit, an empty original job and independent observer drain.

The repeatable local command is Windows Node with
`--test --test-name-pattern 'real Windows observer' scripts/release-hosted-native-windows-setup.test.mts`.
This regression runs on Windows in its owning suite; fixture-only edits select
that suite. It does not run from hosted setup and does not replace dedicated-account acceptance.

Station startup was then investigated without changing workstation WinSta0 ACLs,
accounts, audit policy, privileges or services. A temporary
`LOGON_NETCREDENTIALS_ONLY` session with deliberately unused, unvalidated network
credentials permits create-only creation of a fresh unnamed noninteractive
station. Only that newly created station's DACL is changed. An OWNER RIGHTS RC
ACE removes implicit owner WRITE_DAC from the candidate model; successful roots
report their actual station/desktop handle grants. The desktop is prepared before
station restriction. The model keeps the full visibility predicate, so it cannot
qualify GUI acceptance beneath its noninteractive desktop ancestor.

On local Windows build 26300, the fixed System32 Windows PowerShell form starts
with station `0x20062` and desktop `0x200C7`. The current station grant `0x20002`
does not reach script entry. Screen-read alone, write-attributes alone and the
previous metadata/global-atoms combinations do not repair startup. The successful
mask excludes clipboard, screen-read, desktop creation, station-write attributes,
DELETE, WRITE_DAC and WRITE_OWNER. This is causal startup evidence in the local
current-user model, not proof of hosted interactive-station or nonadmin/profile equivalence.

The fixed local PowerShell image has valid Microsoft signature and SHA256
`60c9b29843624dd8af6b6a7b26147753be6aeef65098b9a503cc50850afe410f`.
Ignored `work/slice4/534-local-*` receipts retain the experiments, failures,
source bindings, runtime metadata and cleanup observations.

## Exact proposed change and risk

| Object                              | Retained             | Proposed  |
| ----------------------------------- | -------------------- | --------- |
| Candidate station allow             | `0x20002`            | `0x20062` |
| Candidate station deny              | `0xD037D`            | `0xD031D` |
| Private desktop allow               | `0x200C7`            | unchanged |
| Default/input desktop object access | denied before resume | unchanged |
| Original job hierarchy and teardown | retained             | unchanged |

The added `0x60` is WINSTA_ACCESSGLOBALATOMS plus WINSTA_EXITWINDOWS. Together with
READ_CONTROL it is the documented station
[GENERIC_EXECUTE mapping](https://learn.microsoft.com/en-us/windows/win32/winstation/window-station-security-and-access-rights).
The proposal also retains existing READATTRIBUTES. It is not merely metadata
access: global atoms are shared mutable state, and WINSTA_EXITWINDOWS permits
ExitWindows/ExitWindowsEx, including the risk of logging off the station owner.
Do not describe the proposal as preventing owner logoff. Shutdown-token privileges
and a general hostile-candidate boundary remain unqualified.

The proposed grant is limited to the fixed, source-bound, Microsoft-runtime inert
fixture on a fresh disposable hosted VM. The fixture contains no explicit global-atom or
ExitWindows calls; framework behavior does not prove a capability denied. Global
atoms can persist beyond root teardown until VM disposal. It grants no arbitrary/protected runtime, production, signing,
publication or issuer authority. The dedicated nonadmin account/profile,
credential-free child environment/stdin, owner-only source/capture custody,
original jobs, pre-resume effective-access checks, independent observation,
bounded capture and independent disabling remain unchanged.

Job UI restrictions cannot be used as a casual substitute: the retained actual
root was already in another job before original-job admission, and
[nested job assignment](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
does not support the proposed UI-limit workaround. This does not establish that
existing job UI limits caused startup failure.

## Execution and recovery gate

Both the PowerShell entry point and `HostedDesktop.Prepare` refuse the disabled
proposal before account or station effects. The consumed privileged access-audit
grant is separately disabled; ordinary GUI qualification no longer calls its
preparation. No SeSecurityPrivilege adjustment, Security-log dependency or audit
policy/SACL mutation is required by the proposed normal path. Prior audit code,
controls and failure evidence remain retained.

Existing station DACL recovery writes owner-only preimage/proposal bytes before
mutation, verifies the postimage, and restores only an unchanged owned proposal.
Foreign edits are refused. Original-job cleanup and account disabling remain
independent attempts, including failed launch paths. This proposal introduces no
new workstation recovery or owner setup step.

After separate nonwriting review and resolution of the explicit execution-right
scope, refresh target interactions, freeze the enabled source, pass all five
exact-head contexts and make one meaningful hosted qualification. Actual acceptance
still requires the dedicated root's owned visible responsive window, isolated
HKCU/profile, inert descendant, complete tree teardown, account disablement and
station restoration. Local controls cannot satisfy those gates. Keep #3559 draft
and unmerged until they pass, then guarded merge/readback and update the owning
receipt. Broader protected Windows source/runtime/capture/report/proof/upload
integration and whole-job resource fit remain unfinished; passing this primitive
does not complete #534.

#254 remains Done; #315/#534/#246 remain pending; Chameleon protected acceptance
is unset, production is held and Slice 5 is excluded. D1/D2/D3, single-owner
recovery, the account-wide $0/resource stop, Unknown capacity/headroom and no
reservation or paid fallback remain unchanged.
