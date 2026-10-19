# One observation of the repaired preflight — proposed, not granted

Owner: [#534](https://github.com/boburning/portcove/issues/534).
The [MdzaNi result and repair](slice4-storage-preflight-result-2026-10-18.md)
remain accurately scoped: the reviewer never resumed, no metadata/startup/auth
progress occurred, and the original numeric Win32 error is Unknown.

The owner executed the included `RecoverDetach` on October 19, 06:43 EDT.
Independent exact-image readback at `2026-10-19T10:46:36.8024433Z` confirms detached,
logical 536870912/backing 536871424 bytes, original/new markers and isolation
receipt unchanged. TreeEmpty/profile_deleted true and cleanup_errors empty
remain bound to the actual new receipt. `grants_removed: false` is retained;
detachment does not claim ACL cleanup. The full approved sequence is fulfilled.

Readback: `work/slice4/next-observation-recovery-readback.json`, SHA-256
`8e6c2ffc9e62b6ce88dee01046c0d77fb16ca5259c19a3591202d5cacad7f807`.
Both images, captures, failed results, prior operation records and markers remain.

## Smallest next operation

The broker-only production lookup has already succeeded non-elevated. The repair
resolves the local privilege name before impersonation while continuing to query
the actual reviewer token and metadata under verified impersonation. Its native
reviewer path remains unqualified. Propose ONE credential-free observation of
that path on the SAME retained second image, with actual-phase recovery included.
No new image, initialization, partition, format, mount repair or ACL widening.

Reuse `scripts/prepare-semantic-observation.ps1` and the existing launcher.
New fixed `privilege-observation-{intent,result,recovery-intent,recovery-result}.json`
names preserve every consumed `observation-*.json` record. Before attach, the
operator would move the MdzaNi active marker byte-for-byte to
`reviewer-active.semantic-isolation-MdzaNi.retained.json`, without overwriting
the earlier ttTNEZ archive. Its hash remains
`09cf56df3f76d65cf442992a37eab3b5d2338e48c5b11ccba42611053b68edd5`.
This archive/attach/fixture has NOT occurred and requires a fresh exact grant.

The operator pins both prior attempts' receipts/recovery and the first observation's
intent/result bytes. Shared exclusion precedes the launcher's intent check and
lasts through teardown/capture. New ready records bind the actual configuration,
native helper, launcher, qualifier, operator, owner and reviewed source revision.
Old ready records cannot stand in for this attempt. CreateNew prevents repeats.

Disk readback now selects only the pinned opaque UniqueId and requires its
Location to equal the exact ImagePath, as demonstrated by the retained readback
from the previous diagnostic. This avoids the missing DiskImage.Number property;
it never selects a disk by number. Known non-boot/non-system/writable GPT, exact
provider-associated partitions and the same NTFS/mount checks remain required.

## Exact proposed tuple

Workspace: `E:\Codex-Worktrees\slice4-admission-delivery`. Existing storage root:
`work\slice4\semantic-storage-2fda9f572e3843b5b16190a100b5275c`.

| Input                            | Identity                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Owner                            | `S-1-5-21-1007133822-4277289207-646028416-1001`                                                                   |
| Disk                             | `6002248094AE6EFC7984F0EC20A288AC`; 536870912 bytes; File Backed Virtual/GPT/non-boot/non-system                  |
| Data partition                   | offset 16777216 / size 520028160; reserved offset 17408 / size 16759808                                           |
| Volume                           | `\\?\Volume{12961e64-153d-4f34-9ada-6f0dcdb1f392}\`; NTFS/PortcoveSemantic/520024064 bytes; existing `data` mount |
| Operator SHA-256                 | `bd603502a08f0e56836c2949069a4798fec9310c7cc3d42cd2950f97ba905099`                                                |
| Launcher SHA-256                 | `0b37cd52e486320162f36e3f6bec68c6cb39769fafb55970951a175466716670`                                                |
| Repaired native helper SHA-256   | `1c7e886ed148e3e9b2ccf6ca2bb821dbe6f4552f280c65ea299fc59308a03cf6`                                                |
| Qualifier SHA-256                | `15d1e751a4abbaffd3743043361714921486675bef34c59630f6ffb00d5c090b`                                                |
| Configuration SHA-256            | `4cdb2ef63a9c85a917b6d2f6962eddb6f40da561357433cde0bdd3d1e57ad0db`                                                |
| Existing recovery helper SHA-256 | `fa61e13beb04e892c50c63b6158b2b880d3555b046bb802f6c22a9738ca90179`                                                |
| Installed Codex                  | 0.162.0; SHA-256 `dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f`                               |

The delivery receipt will supply the actual final reviewed revision for
`Prepare -ExpectedSourceRevision`; clean tracked source and pinned bytes are
required. A placeholder or earlier grant is not a runnable authorization.

## Proposed grant and matching recovery

One grant would authorize the complete bounded sequence:

1. Owner performs ONE same-owner elevated `Prepare` with the reviewed helper
   hash and final source revision. Intent is durable before marker archive/attach.
   Missing or conflicting state stops; preserve the actual phase and partial effects.
2. Only after matching `ready: true`, no provider/readback error and positive
   exact storage readback, the agent performs ONE resource-admitted non-elevated
   `codex-fixture --bounded-storage`, with no credentials. No series, fill probe,
   retry, authentication transfer or issuer provisioning. Preserve the actual
   preflight/startup/refusal result; do not force acceptance.
3. Before fresh fixture ownership, use this reviewed operator's
   `RecoverBeforeFixture`, with its actual new intent and marker checks.
   After fresh ownership, use unchanged `RecoverDetach` with THAT attempt's new
   isolation receipt/hash, matching marker and positive teardown. Neither MdzaNi
   nor ttTNEZ can substitute for the new receipt. Prepare the applicable exact
   elevated recovery command from the actual result; it is included in this grant.

Missing/contradictory evidence requires readback/reconciliation; an ambiguous
response preserves remote effects and original errors. No automatic retry or
speculative cleanup. The image, all archives, new marker, partial state and
captures remain retained. Neither recovery command is needed for the currently
detached state.

Same 512 MiB reviewer-writable bound and existing process/time/output/capture
bounds; at most four additional 8 KiB operator records outside reviewer writes.
No resource-policy increase, paid fallback, larger runner, cache/archive/concurrency
change or deletion. Production seven-day retention restrictions are unchanged.
Capacity stays bounded-attempt eligibility, availability/headroom Unknown, no
capacity reservation; an operation succeeds only for its own result.

Inert tests exercise actual operator/handoff code with mocked providers and
ordinary temporary files, including wrong UniqueId/Location, live ownership,
ambiguous effects, byte preservation and no repeat. Prior preflight/capture tests
remain reusable at their applicable scope. No native fixture has been repeated.

#254 stays Done; #315/#534/#246 acceptance pending, Chameleon acceptance unset.
D1/D2/D3 stay selected. Authentication, whole-opportunity producer evidence,
issuer provisioning, protections, custody/public keys, eligible reservation,
final protected controller/digest/grant, signing/publication/feed/recovery remain
separate. Production held; slice 5 excluded. Upstream #685 remains open without
feedback; two repaired real game artifacts and the full unchanged-client journey
remain missing. This observation does not complete those obligations.
