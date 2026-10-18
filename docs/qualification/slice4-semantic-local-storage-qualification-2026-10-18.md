# Proposed inert reviewer storage qualification

Status: prepared, ungranted. This is a local host differential test, not producer
credential provisioning, semantic acceptance or protected execution.

Preparation is not yet an execution-ready request: first qualify the repaired
package TEMP path in the non-elevated read-only preflight. The last completed
probe denied real-profile writes, but TEMP was absent (Win32 error 3); that is a
failure, not evidence of denied writes. The repaired preflight reached its
900-second resource admission deadline without starting a payload. No host action
or credential grant can substitute for that outstanding qualification.

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
