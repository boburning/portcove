# Proposed inert reviewer storage qualification

Status: both authorized Provision attempts failed; both partial images are now
detached and retained after their approved recovery. Neither attempt started a
fixture. The second cleanup approval is fulfilled; no cleanup step remains.
The [retained-volume completion proposal](slice4-semantic-retained-volume-completion-2026-10-18.md)
supersedes the historical Provision commands below. It prepares reuse of the
already formatted second image, with no new image or formatting. Completion and
another fixture remain ungranted. This is a local startup diagnostic, not
producer credential provisioning, semantic acceptance or protected execution.

The repaired non-elevated read-only preflight now passes, including actual
package TEMP denial. The fixed reader's real stdio list/read/search also passes
inside the same boundary. Normal exit and persistent-descendant teardown pass.
The installed Codex fixture still exits 1 before events with app-server access
denied. Earlier absent-TEMP, forced-tree and resource-deadline failures remain in
the checkpoint. This proposal is ready for a narrow host decision after review
and exact-head delivery; it does not establish a usable authenticated reviewer.

The selected LPAC boundary successfully starts the installed Codex executable,
but its in-process app-server returns access denied before review events.
Authentication has not been provided inside this boundary. A writable bounded
volume is a diagnostic proposal, not an asserted fix or a network/authentication
qualification.

## Exact operator action

Approve one fixed 512 MiB NTFS VHD under the exact owner/root in
[slice4-semantic-local-storage.proposed.json](slice4-semantic-local-storage.proposed.json).
The same owner must run `scripts/prepare-semantic-storage.ps1 -Operation Provision`
in an elevated PowerShell session, supplying that file and its reviewed SHA-256
through `-Configuration` and `-ExpectedConfigurationSha256`. The helper refuses
an existing root and never selects a numeric host disk. It binds the backing
image to its unique disk identity before each initialization operation. No quota
on the owner's ordinary account is proposed. No authentication is copied.

After positive storage readback, run one existing resource-admitted
`node scripts/qualify-semantic-isolation.mts codex-fixture --bounded-storage`
with no credentials. This is a small inert reviewer/reader startup differential,
not a model invocation grant. Stop on refusal or ambiguity. No credential is
released. Retain the volume and marker after this one attempt; do not start a
subsequent fixture on the same state. The separately prepared native fill probe
can test disk-full refusal only after a fresh reviewed setup/recovery; it has not
run. Earlier successful operations prove only themselves.
The candidate seals the actual default AppContainer profile and registry. The private
volume contains reviewer work, home and temporary paths. A package-specific
writable subtree, kernel volume/GUID/size checks, LPAC token checks, fixed reader
surface, finite job lifetime, output bounds and exclusive active marker constrain
each attempt. Kernel/OS bookkeeping is not claimed to be zero bytes. The hard
reviewer-writable boundary still requires observed successful qualification.

## Recovery and rollback

Keep the backing image, intent, diskpart output, process identity, capture and
all partial effects. Never rerun Provision over an existing root. On ambiguous
provision/attach/format responses, first read `Get-DiskImage -ImagePath` for the
exact reviewed backing path and its `Get-Disk` association; match the retained
intent's unique ID. Do not initialize, format or attach a replacement disk.

Normal rollback uses `-Operation Detach` with the exact configuration digest and
`-IsolationReceipt`. It requires matching image/disk/volume identities, positive
empty-tree/profile-deletion/grant-removal readback and no active marker. It then
detaches the exact image and reads attachment state back. It never deletes the
backing file or unrelated evidence.

The bounded fixture deliberately retains its marker and grants rather than
traversing child-controlled contents for ACL cleanup. Use `-Operation RecoverDetach`
with the same configuration digest and the exact attempt's `capture/isolation.json`.
This acquires the marker exclusively, matches its run-root and SID to that receipt,
requires positive empty-tree/profile-deletion readback and no cleanup errors,
checks the image/disk/volume identities, and detaches without following reviewer
paths. It retains the marker, backing file and grants; detach is containment,
not cleanup success or permission to reuse the state. Missing or contradictory
observations refuse. Never substitute an older receipt, kill by image name or
erase the marker. Ambiguous detach requires exact-image attachment readback before
another action.

Failures during provisioning before `storage.json` exists cannot use these detach
operations. Preserve partial intent/output. Read back only the exact backing image
and associated unique disk identity, and obtain explicit recovery authority for
any subsequent mutation; never fabricate completion or isolation receipts.
No supported authenticated reviewer route, accepted whole-opportunity report or
issuer App/installation/CheckRun exists yet. Once inert startup works, prepare
and qualify the supported authentication route inside the same boundary before
requesting issuer provisioning. Production remains held.

## Historical first-attempt command (consumed; do not rerun)

The following hashes/command identify the first attempt from #2143. That attempt failed before initialization, and the image is now positively detached with its file retained. Its configuration is preserved at commit e245733; the current proposal uses the fresh root and hashes below.

Reviewed configuration SHA-256:
`8e305e64fccd5f002e7855f6472c3e6fb55f575691390db2221f400963fbaa89`.
Provision/recovery helper SHA-256:
`771d0c013aaf467b26798321a73c20e9390cfca42c5935fa2c53c2b5af18ead1`.
From the exact reviewed delivery, the authorized same-owner elevated session uses:

```powershell
pwsh -NoProfile -File E:/Codex-Worktrees/slice4-admission-delivery/scripts/prepare-semantic-storage.ps1 -Operation Provision -Configuration E:/Codex-Worktrees/slice4-admission-delivery/docs/qualification/slice4-semantic-local-storage.proposed.json -ExpectedConfigurationSha256 8e305e64fccd5f002e7855f6472c3e6fb55f575691390db2221f400963fbaa89
```

Do not execute this command until the host action is granted. The source revision
and helper digest must match the reviewed delivery; changed helpers/configuration
require reconciliation before any operation. Fixture execution stays non-elevated.
`RecoverDetach` uses the same command with that operation and the exact newly
retained `-IsolationReceipt <run-root>/capture/isolation.json`; never guess a run.

<a id="corrected-next-attempt--awaiting-a-new-operation-grant"></a>

## Corrected next attempt — awaiting a new operation grant

The original helper compared `FileBackedVirtual` with the actual elevated Windows
provider text `File Backed Virtual`. The corrected guard accepts that exact
observed representation and requires explicit false boot/system flags. It still
refuses other bus types, missing identity, wrong size and ambiguous associations.
An inert regression executes the actual extracted guard; it does not provision
storage. Native success beyond the original RAW attachment is still unproven.

The original image remains detached at root ending
`semantic-storage-dde7e30cccb4407695183a63817d12a5`, with its owner marker/logs/file
retained. No fixture ran. The new proposed root ends
`semantic-storage-2fda9f572e3843b5b16190a100b5275c` and is absent. The original
one-Provision grant has been consumed; this is a request for one new operation
using the corrected reviewed bytes, not a new storage mechanism selection.

New helper SHA-256:
`a5cc33964b309f09214ebc4ed246c781cf8ee2e010cad3d22d42dbd63fc4cc28`.
New configuration SHA-256:
`4cdb2ef63a9c85a917b6d2f6962eddb6f40da561357433cde0bdd3d1e57ad0db`.

After the exact corrected delivery is approved, same-owner elevated operation:

```powershell
pwsh -NoProfile -File E:/Codex-Worktrees/slice4-admission-delivery/scripts/prepare-semantic-storage.ps1 -Operation Provision -Configuration E:/Codex-Worktrees/slice4-admission-delivery/docs/qualification/slice4-semantic-local-storage.proposed.json -ExpectedConfigurationSha256 4cdb2ef63a9c85a917b6d2f6962eddb6f40da561357433cde0bdd3d1e57ad0db
```

This is not an instruction to run the command before that new grant. One
non-elevated credential-free startup differential requires positive provisioning
readback; matching RecoverDetach still requires the exact new isolation receipt
and positive identity/teardown checks. The same retention, refusal and partial
provisioning recovery rules above apply. No repeated fixture, fill probe,
authentication, issuer or production operation is included. Original and later
outcomes remain separate evidence.
