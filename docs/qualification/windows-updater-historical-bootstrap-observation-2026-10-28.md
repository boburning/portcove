# Windows historical manual bootstrap — October 28, 2026

Owners: [#224](https://github.com/boburning/portcove/issues/224) and
[#52](https://github.com/boburning/portcove/issues/52). Both remain open.

One actual non-elevated Windows installed chain completed:

1. Install the genuine published updater-less Alpha2 NSIS package, launch it
   without qualification arguments, observe its responsive window and private
   WebView browser profile, then close normally with retained-handle OS exit 0.
2. Manually invoke the updater-enabled qualified 0.1.0 installer with `/P /UPDATE`
   and no destination override. Verify the same HKCU registration and library,
   then exercise damaged-stage rejection and repair before the UI upgrade.
3. Observe a fresh ordinary Settings Stable check with no eligible release and
   unchanged installed executable, then explicitly check Preview, download and
   restart into the authenticated signed 0.3.0 skipped upgrade.
4. Observe helper PID 12744 through a retained OS process handle exiting 0,
   relaunch PID 29044, candidate normal exit,
   and uninstall parent/self-copy exit 0 with registration/managed files removed.

The [machine-readable receipt](windows-updater-historical-bootstrap-observation-2026-10-28.json)
records the exact package/signature/Root/feed/source/caller identities, actions,
boundary manifests, process outcomes, original failure and retained capsule.
The historical package is 8331357 bytes, SHA256
`2e2b6a3c5a0134924b5133f865842dd68c06ef6082885be6d1837235adf16a85`,
from [release v0.1.0-alpha.2](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2),
source `27328c8a`. Its Authenticode state is NotSigned; published checksums are
not payload or metadata signatures. The qualified predecessor is `e81008b6…`;
the candidate is `64ad75e9…`. Their existing disposable authenticated feed and
payload-signing infrastructure was reused.

A 32-byte sentinel was created before Alpha2 installation and retained, without
reseeding, across all four recorded boundaries and the authenticated upgrade.
The same library hosted Alpha2 database initialization and updater-enabled
startup. Snapshots record migration bytes; no existing game/save records were
present and no semantic record preservation is asserted. General preferences
were absent at every historical boundary. Recursive manifest equality applies
only around uninstall. Neither actual game data nor existing preferences or
credentials receive preservation credit.

The initial attempt remains failed: its profile oracle did not allow the SDK's
documented `EBWebView` child and did not record the raw rejected path. The fixed
observer records bounded parsed paths and identity before rejection, accepts
only the configured directory or its exact SDK child, and refuses junctions and
other descendants. The successful fresh run positively observed browser PID
15992 beneath Alpha2 PID 27920 using that private SDK child. This matches
[Microsoft's documented suffix](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server).
Its controlled Windows refusal tests are separate from this native observation.

Owned settlement of the failed installation reused the existing journaled NSIS
uninstall helpers. A supplemental controller first stalled while serializing a
registry provider object; exact worker interruption and source ordering prove
that attempt never dispatched an uninstaller. After restricting the journal to
scalar registry fields, parent/self-copy exited 0, managed files/registration
were absent and library/preference manifests matched. Original failure and
profile remain retained. Path-scoped process absence is not universal browser
profile quiescence or reboot acceptance.

Non-writing independent review verified all 174 retained capsule members:
8808352 packed bytes, SHA256
`6703b801463258781906ef5262a33bf710c1d8ef67c8d107b348e8282bc1ff03`.
All four temporary version files plus the temporary harness overlay restored
byte-for-byte. Native harness source is `e077d8bf`; product qualification bytes
remain ADC plus the recorded compatibility/observer overlays.

This closes one missing observation in the
[initial beta matrix](application-updater-beta-acceptance-2026-10-28.md).
The current caller is non-elevated in the existing medium split-admin environment;
this does not establish a pure standard account or clean VM. Both updater-enabled
packages retain qualification instrumentation. Production Root/key/feed/publication
and protected connected-account proof remain [#534](https://github.com/boburning/portcove/issues/534).
Other channel, real-data, host and reboot rows retain their stated limits.
