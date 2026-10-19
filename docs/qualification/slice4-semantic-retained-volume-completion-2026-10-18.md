# Retained reviewer volume: exact completion proposal

Status: implementation preparation only; completion and another fixture are
**ungranted and unexecuted**. Both failed images are detached and retained. The
second cleanup grant is fulfilled; no further cleanup command is needed now.

## Observed failure and smallest repair

The second Provision failed after creating GPT partitions and formatting NTFS.
The owner-authorized cleanup completed at `2026-10-18T23:37:52.5403001Z`, with
positive detached readback, no provider/readback error and no fixture started.
Its retained result is
`work/slice4/semantic-storage-second-partial-detach-result.json`, SHA-256
`0f77c39489e3fbbfa6f0cc9679998e4469bc484b749540c4a8da4d5f5f9e5180`.
The elevated pre-detach observation is
`work/slice4/semantic-storage-second-partial-detach-intent.json`, SHA-256
`4e3fcc609d2b6f98204f930bbe12bfe04479bb89e7c2b06830d869d29daa9ab8`.
Independent readback is retained in
`work/slice4/semantic-storage-second-cleanup-verified.json`.

That observation distinguishes the disk's `UniqueId` from the partition
provider's `DiskId` (the disk provider path). The original helper passed the
former to `Add-PartitionAccessPath -DiskId`. The repair passes the returned
partition through `-InputObject`; no numeric disk fallback is introduced.

The proposed next operation completes the already formatted, never-fixtured
second image. It does not create a third image, initialize, partition or format
either retained disk. It would change the retained volume's ACL/mount metadata
and permit the single fixture's private state, so its backing bytes would no
longer be unchanged. Original failure and cleanup records remain unchanged.

## Exact boundary

`scripts/complete-semantic-storage.ps1` defaults to read-only `Inspect`. Its
mutation modes require a separately authorized, same-owner elevated operator.
It pins the configuration, repaired helper and original preparation/cleanup
records; it refuses reparse ancestry and changed identities.

| Identity                            | Exact value                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Image                               | `E:\Codex-Worktrees\slice4-admission-delivery\work\slice4\semantic-storage-2fda9f572e3843b5b16190a100b5275c\reviewer.vhd` |
| Owner SID                           | `S-1-5-21-1007133822-4277289207-646028416-1001`                                                                           |
| Disk UniqueId                       | `6002248094AE6EFC7984F0EC20A288AC`                                                                                        |
| Logical/backing bytes               | `536870912` / `536871424`                                                                                                 |
| Data partition offset/size          | `16777216` / `520028160`                                                                                                  |
| Volume                              | `\\?\Volume{12961e64-153d-4f34-9ada-6f0dcdb1f392}\`                                                                       |
| Filesystem/label/bytes              | NTFS / `PortcoveSemantic` / `520024064`                                                                                   |
| Configuration SHA-256               | `4cdb2ef63a9c85a917b6d2f6962eddb6f40da561357433cde0bdd3d1e57ad0db`                                                        |
| Repaired preparation helper SHA-256 | `fa61e13beb04e892c50c63b6158b2b880d3555b046bb802f6c22a9738ca90179`                                                        |
| Completion helper SHA-256           | `a278bdaf8a879793e31d4d2fff364b87f99f3eb287425141e43299f0a8d984b9`                                                        |

`Complete` takes an exclusive file lock shared with `RecoverIncomplete`, creates
a durable intent before attachment, attaches only this image without a drive
letter, and verifies its exact non-system GPT disk, both partitions and NTFS
volume. It applies and reads back the private owner/SYSTEM ACL, binds the actual
partition object to the existing empty mount directory, and requires fresh
provider readback before creating `storage.json`. Existing completion records
refuse repetition. Results retain the actual stage, errors and partial effects;
there is no automatic detach, retry or assertion that failure means no effect.

## Proposed single diagnostic grant, after review and delivery

The concrete proposal is one `Complete`, followed only after positive readback
by one resource-admitted, non-elevated, credential-free small inert fixture:
`node scripts/qualify-semantic-isolation.mts codex-fixture --bounded-storage`.
No fill probe, authentication or issuer credential is included. Reaching an
explicit authentication error is useful startup evidence even if the fixture
fails. Normal exit alone does not prove reviewer acceptance.

The following command is prepared for that future grant; **do not run it under
the fulfilled cleanup approval**:

```powershell
$taskCompletion = 'E:\Codex-Worktrees\slice4-admission-delivery\scripts\complete-semantic-storage.ps1'
if ((Get-FileHash -LiteralPath $taskCompletion -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'a278bdaf8a879793e31d4d2fff364b87f99f3eb287425141e43299f0a8d984b9') {
    throw 'Reviewed completion helper changed'
}
pwsh -NoProfile -File $taskCompletion -Operation Complete
```

The same proposed grant includes matching recovery. Before fixture ownership,
the exact hash-checked completion helper's `-Operation RecoverIncomplete` takes
the shared exclusive lock and atomically claims the existing launcher's
`reviewer-active.json` boundary before detaching. It refuses a live completion
or an existing fixture owner; it does not fabricate an isolation receipt.
It preserves the recovery sentinel, intent, result and backing file. Any
ambiguous response requires readback before further action.

After a fixture claims ownership, use the existing preparation helper's
`RecoverDetach` with the **new actual isolation receipt**, only after its
matching run/profile identity and positive process-tree/profile teardown checks
pass. The literal receipt-bound command can only be prepared after that receipt
exists. No force, blind retry, record overwrite or deletion is included.

## Verification and remaining acceptance

The actual provisioning branch fails the new regression on the old identifier
binding and passes with `-InputObject`. Eight focused Windows-helper tests pass,
including exact retained partition/volume refusals, fresh mount readback and an
exclusive-lock interleaving between completion and recovery. These use inert
storage providers and temporary ordinary files; they do not prove native
completion. Retained logs are `work/slice4/partition-binding-before.tap` and
`work/slice4/retained-volume-final-tests.tap`.

No completion, fixture, authentication, issuer provisioning or protected
production execution has occurred. A usable authenticated reviewer, an actual
whole-opportunity report and observed issuer/CheckRun binding remain separate
requirements. #254 remains Done; #315/#534/#246 acceptance remains pending;
Chameleon protected acceptance remains unset; slice 5 remains excluded.
