# One retained-image storage observation — prepared, not granted

Owner: [#534](https://github.com/boburning/portcove/issues/534). The
[previous result](slice4-bounded-runtime-result-2026-10-18.md) remains failed:
the credential-free reviewer could not read `CODEX_HOME`. Its matching recovery
is complete. Both images remain detached and retained. That grant is consumed.

The smallest next observation uses the same second image and the delivered
metadata preflight before permitting one fresh reviewer startup. It does not
create another image or change an ACL. The preflight may refuse before Codex
resumes; that is useful access evidence, not successful runtime qualification.
No observation described here has been executed.

## Exact scope and identities

Workspace: `E:\Codex-Worktrees\slice4-admission-delivery`.
All image-relative names below are under
`work\slice4\semantic-storage-2fda9f572e3843b5b16190a100b5275c`.

| Input                                  | Required identity                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Owner                                  | `S-1-5-21-1007133822-4277289207-646028416-1001`                                                                                    |
| Image                                  | `reviewer.vhd`; logical 536870912, backing 536871424 bytes; StorageType 2                                                          |
| Disk                                   | `6002248094AE6EFC7984F0EC20A288AC`; File Backed Virtual, GPT, known non-boot/non-system, writable                                  |
| Partitions                             | reserved offset 17408 / size 16759808; data offset 16777216 / size 520028160; associated through the disk's provider Path          |
| Existing NTFS volume                   | `\\?\Volume{12961e64-153d-4f34-9ada-6f0dcdb1f392}\`; PortcoveSemantic; 520024064 bytes; existing `data` mount must resolve to it   |
| Configuration                          | `slice4-semantic-local-storage.proposed.json`; SHA-256 `4cdb2ef63a9c85a917b6d2f6962eddb6f40da561357433cde0bdd3d1e57ad0db`          |
| New operator                           | `scripts/prepare-semantic-observation.ps1`; SHA-256 `3e1dce63f73146eb0c38b734a3f759e217fe5b4746756b03157ff7c7f707d336`             |
| Launcher                               | `scripts/semantic-review-sandbox.ps1`; SHA-256 `dbfdc66cee9e0b0ececa0b0afb2a38507a5af928e6b60a345e6160b784088445`                  |
| Native helper                          | `scripts/fixtures/semantic-review-appcontainer.cs.txt`; SHA-256 `a2cf7668d6de8cd0cd4760e0e72c01f423bc245c6de02d65941892c471bded87` |
| Qualifier                              | `scripts/qualify-semantic-isolation.mts`; SHA-256 `15d1e751a4abbaffd3743043361714921486675bef34c59630f6ffb00d5c090b`               |
| Existing receipt-bound recovery helper | `scripts/prepare-semantic-storage.ps1`; SHA-256 `fa61e13beb04e892c50c63b6158b2b880d3555b046bb802f6c22a9738ca90179`                 |

The new operator pins the original storage/completion records, actual `ttTNEZ`
isolation receipt and positive detached readback. It checks their hashes and
non-reparse ancestry before mutation. `Prepare` additionally requires the exact
delivered Git revision supplied by `-ExpectedSourceRevision` and clean tracked
source. The delivery receipt supplies that final revision; a placeholder is not
an executable command or a grant.

## Proposed single grant and sequence

One new grant would cover the following entire sequence and matching recovery:

1. Same-owner elevated `Prepare` on this exact image. Persist an exclusive
   `observation-intent.json` before effects. Move the old `reviewer-active.json`
   byte-for-byte to
   `reviewer-active.semantic-isolation-ttTNEZ.retained.json`, never overwrite it.
   Its SHA-256 remains
   `0ab15171c42aa3ce88e410a58768fb329af24e516afb938fcb29da8dc56dc52a`.
   Attach only this image without a drive letter, then verify the exact existing
   disk, partitions, volume and mount. No creation, initialization, partitioning,
   formatting, access-path repair or ACL change is included.
2. Only after `observation-result.json` says `ready: true` with no provider or
   readback error and positive matching attached-storage readback, admit ONE
   non-elevated, credential-free
   `node scripts/qualify-semantic-isolation.mts codex-fixture --bounded-storage`.
   The existing qualifier allocates a fresh isolated run directory; it cannot
   reuse `ttTNEZ`. Supply no authentication or issuer credential. The launcher
   verifies both preparation records, source-file hashes and archived marker,
   and holds the shared operator lock through final teardown and capture.
3. Retain actual preflight, startup, completion/refusal and teardown evidence.
   A native metadata refusal, explicit authentication error or later failure
   remains its actual result. Do not force an accepted report or rerun.
4. Apply only the recovery route for the actual ownership phase below. Preserve
   the image, old archive, fresh marker, captures and all partial effects.

The existing 512 MiB writable-storage bound, fixed five metadata paths, 32 KiB
preflight capture and existing process/output/time/resource limits are retained.
The operator adds at most four 8 KiB intent/result records outside reviewer
write authority. No fill probe, authentication transfer, issuer provisioning or
production operation is included. Admission remains bounded-attempt eligibility
with Unknown availability/headroom and no capacity reservation.

## Matching recovery

Before a fresh fixture owns `reviewer-active.json`, use the SAME new operator:

```powershell
pwsh -NoProfile -File "$taskRepo\scripts\prepare-semantic-observation.ps1" `
  -Operation RecoverBeforeFixture
```

First verify the operator's exact hash from the table. Recovery requires its
actual matching intent and the old marker at exactly one original/archive
location. It claims an exclusive recovery intent and, when needed, creates a
refusing active marker before exact-image detach. It retains provider errors and
independent readback; a lost response cannot erase an observed effect. An absent
or contradictory marker/intent requires reconciliation before another mutation.
Recovery never requires a stale Git checkout merely to detach the exact image.

After fresh fixture ownership, this route refuses. Use the existing reviewed
`RecoverDetach` helper with THAT attempt's newly retained `capture/isolation.json`,
positive matching TreeEmpty/profile-deleted/cleanup evidence and exact marker
binding. Prepare its receipt path and hash from the actual result; the old
`ttTNEZ` receipt cannot authorize recovery of the new attempt. The command shape is:

```powershell
pwsh -NoProfile -File "$taskRepo\scripts\prepare-semantic-storage.ps1" `
  -Operation RecoverDetach `
  -Configuration "$taskRepo\docs\qualification\slice4-semantic-local-storage.proposed.json" `
  -ExpectedConfigurationSha256 4cdb2ef63a9c85a917b6d2f6962eddb6f40da561357433cde0bdd3d1e57ad0db `
  -IsolationReceipt $taskNewActualReceipt
```

Neither command is requested for the current already-detached state. The operator
and launcher share `completion-operation.lock`; recovery intent blocks further
launch. CreateNew records prevent retries. Missing completion, receipt or teardown
evidence remains a reconciliation hold, not permission to substitute an old record.

## Preparation evidence and remaining scope

Focused inert tests execute the actual provider guards, archive, preparation,
recovery and launcher-handoff code with mocked provider calls and ordinary
temporary files. They cover unavailable/wrong identity, missing mount, live
ownership, partial attachment, ambiguous detach, no repeat, byte preservation,
wrong source/input identity and exclusive locks. They do not establish native
access, authentication, semantic acceptance or a production reservation.

The source-level metadata localization and original failures remain retained.
No ACL repair is selected by this proposal. Its observation should determine
whether any repair is necessary and which exact access check needs it.
Authentication qualification, complete-opportunity review, issuer provisioning,
provider protections, custody/public keys, eligible reservation and exact final
controller/digest grant remain separate prerequisites. #254 stays Done;
#315/#534/#246 acceptance pending; Chameleon protected acceptance unset;
production held and slice 5 excluded.
