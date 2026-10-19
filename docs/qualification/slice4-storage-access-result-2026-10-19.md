# Actual storage-access refusal and completed recovery

Owner: [#534](https://github.com/boburning/portcove/issues/534).
The owner approved the exact [#2179 observation](slice4-repaired-preflight-observation-2026-10-19.md),
including matching recovery. This record adds its actual result; that single
attempt grant is fulfilled. No further native observation is proposed here.

## Actual execution

Elevated owner `Prepare` succeeded at `2026-10-19T12:14:13.3707187Z`,
source `1388b7c33183f4473e2ed95732ff3d9a3005457b`, with the approved helper tuple,
positive exact-image readback and `ready: true`. No image creation, initialization,
partitioning or formatting occurred. The MdzaNi marker was archived unchanged.

One resource-admitted, non-elevated, same-owner, credential-free
`codex-fixture --bounded-storage` ran as `semantic-isolation-UIAVHJ`, PID 31312.
Resource queue was 1477 ms; total supervised time was 92937 ms. Outer exit was 1.

| Observation                                           | Actual result                         |
| ----------------------------------------------------- | ------------------------------------- |
| Verified reviewer identity                            | true                                  |
| Bypass-traverse enabled / impersonation reverted      | true / true                           |
| Metadata on mount, assigned root, home, work and temp | all refused: error 5; attributes null |
| Preflight passed / reviewer resumed                   | false / false                         |
| Reviewer stdout / stderr                              | 0 / 0 bytes                           |
| Tree empty / capture complete / profile deleted       | true / true / true                    |
| Forced termination / process exit code                | true / null                           |
| Cleanup errors                                        | none                                  |

The privilege-name repair advanced execution to actual metadata calls. No
reviewer startup, authentication error, reader operation, report or semantic
acceptance occurred. `Error` and `NativeErrorCode` are null because these are
per-path API refusals, retained as `MetadataError: 5`, rather than exceptions.

Evidence retained outside Git:

- `work/slice4/semantic-isolation-UIAVHJ/capture/isolation.json`, SHA-256
  `ce8c6e39ab12bd5db136d85ed7e4b48c9194644ae0669cd0c90eacf40269af39`.
- Full `storage-preflight.json`, SHA-256
  `e08392a5fbb9b749bdce7582ecb61fa2f1efa1c9ce06d0a100515b3254e2b45f`.
- `repaired-preflight-observation-single-diagnostic-result.json` and original log.
- `repaired-preflight-observation-recovery-readback.json`, SHA-256
  `dc93b4cb8bad1e4311115da15fcfb61b69d20497e3ea2cc1291f78582ac5e9d4`.

## Recovery actually observed

The owner executed the included `RecoverDetach`, using unchanged helper
`fa61e13beb04e892c50c63b6158b2b880d3555b046bb802f6c22a9738ca90179`
and this attempt's new receipt. Actual matching marker/SID, empty tree, complete
capture, deleted profile and empty cleanup errors were checked before preparing
that command. Owner output and independent exact-image readback confirm detached,
logical 536870912 / backing 536871424 bytes. Both images, active marker, archives,
captures and partial effects remain retained. `grants_removed: false` remains;
detachment does not claim ACL cleanup. No more cleanup is currently needed.

## Deterministic policy mismatch and bounded repair

The mount descriptor has broker/SYSTEM grants only. The four assigned child
descriptors contain the actual reviewer SID with modify rights. The old preflight
required successful reviewer metadata reads on all five, contradicting the
intentional broker-only mount policy. Child grants did not produce effective
access in this attempt: all four child reads also returned error 5.

The existing preflight now distinguishes the mount diagnostic from required
child access. It captures mount attributes as broker before impersonation and
requires positive broker directory metadata and descriptor evidence. The actual
reviewer mount result remains captured. Each assigned child still requires its
own successful reviewer metadata read and broker descriptor evidence. Identity,
reversion, byte bounds, suspension, refusal, teardown and capture remain required.
No ACL, capability, credential, storage or resource boundary changes.

This distinction also avoids conflating the mounting directory with the target
volume: [Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileattributesw)
that `GetFileAttributesW` on a mounted folder reports the mounting directory's
attributes. The broker's existing `BoundedVolume.Open` separately locks and
validates the target volume identity, filesystem and size.

Focused inert regressions exercise root denial/unknown with successful required
children, missing/non-directory broker metadata, each child denial, unknown child
metadata and the actual all-denied pattern. The latter remains refused. These
tests run the compiled production policy without creating a reviewer process or
touching retained storage. The repair does **not** explain or fix child access.
It supplies no native startup or authentication qualification.

The changed native/launcher bytes intentionally invalidate the consumed operator
tuple. Do not update the operator pins or attach storage merely to retry. The next
engineering condition is a substantiated child-path access diagnosis and an
independently verified remedy before considering another native observation.
An upstream report of [mounted file-backed NTFS denial](https://github.com/microsoft/mxc/issues/1473)
is a lead in a different SDK, not proof of this cause or permission to change hosts.

## Other Slice 4 work

Upstream portable-default PR
[psxrecomp#685](https://github.com/RetroPortingToolKit/psxrecomp/pull/685) remains
open, unmerged and without feedback at this readback: head
`572558394b5b737690138f8374c80b032c3d84ba`, target `master`
`53a057f548cd1f93f1b4d8300caaeded72f4160d`. Normal follow-up remains authorized.
The separate file-identity runtime failure, passing repair assertions/package
suite and exclusion of legacy absolute-path migration remain unchanged.

The bounded new-asset assessment remains source-only: .37/.38/.39 assets exist,
but the checked .38/.39 implicated source files retain baseline blobs. Two
eligible repaired real artifacts are not established. No new downloads or native
game runs were performed. #144 remains outside the compiled catalog; the capable
client baseline/initial absence and full same-target Core/protected journey remain.

#254 remains Done; #315/#534/#246 acceptance pending; Chameleon
`protected_acceptance` unset. D1/D2/D3, no-spend/resource restrictions and
bounded-attempt capacity with Unknown availability/headroom and no reservation
remain. Actual producer/authentication/issuer binding, protection provenance,
executor/readback integration, custody/public keys, eligible candidate/reservation,
final controller/digest and exact protected grant remain separate. Assembly is
one stage; signing/publication/feed/custody/recovery acceptance is not complete.
Production held; slice 5 excluded.
