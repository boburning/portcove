# Slice 4 retained-image preflight result and narrow repair

Owner: [#534](https://github.com/boburning/portcove/issues/534).
The owner approved the [exact #2161 observation](slice4-next-storage-observation-2026-10-18.md).
Its same-owner elevated Prepare succeeded at `2026-10-19T02:27:37.6669173Z`
(October 18, 22:27 EDT), stage `exact-storage-readback`, `ready: true`, no
provider/readback error. It archived the original marker byte-for-byte and
attached the existing second image. No image creation/init/partition/format occurred.

## Actual diagnostic

One resource-admitted, same-owner **non-elevated**, credential-free invocation of
`node scripts/qualify-semantic-isolation.mts codex-fixture --bounded-storage`
ran at exact source `319e0938b5b7ea3dee938ba63a4d41bf651a3c91`.
The new run is `work/slice4/semantic-isolation-MdzaNi`. Resource queue was 1104 ms;
total supervised execution 79896 ms. No retry or fill probe ran.

The reviewer was created suspended and terminated before resume. The preflight
reported `Win32Exception: lookup traverse privilege`, `IdentityVerified: false`,
`Reverted: true`, `BypassTraverseEnabled: null`, `Passed: false`.
The actual error's numeric Win32 code was not retained by that source and is
Unknown; do not infer access denied or another specific code. All five metadata
attributes remain null. Zero metadata-error placeholders do not prove successful
reads: metadata observation was never reached. Broker descriptors were retained.

`ReviewerResumed: false`, `ForcedTermination: true`, `ExitCode: null`, stdout and
stderr both zero bytes; the outer qualification command exited 1. No Codex startup,
authentication error, reader event, report or semantic acceptance was observed.
This does not improve on the earlier `ttTNEZ` startup result; it is a different
failed stage with its own retained evidence.

Actual PID 23832; profile `portcove.review.29ee57bac14a43d2abb4b4a9a83e5c3d`;
observed/expected/marker SID all
`S-1-15-2-836910389-3658380980-400037360-4199672164-515889898-3902766667-2277342764`.
TreeEmpty, CaptureComplete and profile_deleted are true; cleanup_errors is empty.
The new active marker and image remain retained for the approved receipt-bound
recovery. The owner-elevated recovery command is prepared; its execution/readback
was pending when this result was recorded. Do not claim detached from teardown alone.

| Retained evidence                                | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| New capture `isolation.json`                     | `1cce72f7715d044c61be1aaeaea5415d7486e5e23a2bef31d9a61341b2597d9a` |
| New capture `storage-preflight.json`             | `1f3998b3a1e406dba08f063a954886c024642990a6c3e261af2ff47451ddffad` |
| New `reviewer-active.json`                       | `09cf56df3f76d65cf442992a37eab3b5d2338e48c5b11ccba42611053b68edd5` |
| Original `ttTNEZ` marker archive                 | `0ab15171c42aa3ce88e410a58768fb329af24e516afb938fcb29da8dc56dc52a` |
| `next-observation-single-diagnostic-result.json` | `f8b4dcbd31e4638e01e842548b516f05cfe890022282798c0f4f0ff3251bc262` |

Paths not under the new capture are under `work/slice4` or the existing
`semantic-storage-2fda9f572e3843b5b16190a100b5275c` root. The corrected derived
result retains the earlier derived wrapper/hash: its initial `wrapper.Error`
lookup returned null; the actual error resides at `preflight.Error` and the
isolation summary's `process.Storage.Error`. Original raw evidence is unchanged.
Invocation intent, log, exit, owner grant and positive prelaunch readback are
retained separately. The original home access-denied and both partial Provision
failures/recoveries remain intact.

A read-only prelaunch `DiskImage | Get-Disk` association failed because Number
was null; no diagnostic intent/profile/fixture existed at that point. Its error
is retained in `next-observation-prelaunch-association-failure.json`. Subsequent
readback selected the exact disk by UniqueId and required Location equal the
exact ImagePath, known fixed size/non-boot/non-system/writable GPT identity,
provider-associated partitions, exact NTFS volume and existing mount. No disk was
selected by number and no setting was changed. The owner's positive preparation
record and the launcher's fixed-volume handle checks retained their actual scope.

## Repair prepared within existing engineering authority

The failure occurs in `LookupPrivilegeValueW` inside the impersonated verification
callback. [Microsoft documents this API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-lookupprivilegevaluew)
as resolving a local privilege name to its system LUID. That name resolution can
be completed by the broker before entering the restricted reviewer context.
The actual privilege-enabled observation must still come from the verified
reviewer thread token through
[GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation).

The repair adds that broker preparation phase to the existing preflight seam.
Path/size validation runs first; lookup must succeed before impersonation.
The same resolved LUID is used only to inspect the actual token's privilege list.
SID/AppContainer checks, metadata reads under impersonation, revert, refusal,
owned-job termination and bounded capture remain enforced. No privilege is
enabled, ACL changed or isolation relaxed. NativeErrorCode is now retained for
future direct Win32 exceptions; it does not reconstruct the missing old code.

Focused tests compile the helper and exercise broker-before-enter ordering,
preparation refusal without entry, retained numeric native errors and the
existing identity/metadata/revert/teardown/capture cases with inert delegates.
They do not rerun an AppContainer or qualify native startup. The original
PowerShell-delegate wrapping failure in the test harness is retained separately.

The old #2161 source/hash tuple is historical and intentionally does not grant
execution of this changed helper or launcher. Its one diagnostic is consumed;
only matching recovery remains covered. No new observation grant is requested
by this repair receipt. A subsequent runnable observation would require its
actual source/digests, retained state and exact authority reconciled first.

#254 Done; #315/#534/#246 acceptance pending; Chameleon protected acceptance unset.
D1/D2/D3, bounded-attempt eligibility with Unknown availability/headroom and no
reservation, $0 stop/resources and coordinator recovery restrictions remain.
Runtime authentication, whole-opportunity producer evidence, issuer provisioning,
protections, custody/public keys, eligible reservation and protected execution
remain separate. Production held; slice 5 excluded.
