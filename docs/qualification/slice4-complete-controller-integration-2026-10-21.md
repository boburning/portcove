# Complete held controller integration — 2026-10-21

This is a reviewable initial configuration, not activation or provider enforcement.
The [complete controller](application-update-production.complete.yml) stays outside
`.github/workflows`; the automatic wake remains held. Existing D1/D2/D3 decisions,
$0 stop-usage, standard public runners, cache/archive limits, seven-day retention,
retry limits and admission holds remain intact.

The fixed callables now compose tool provenance, independent classification,
coordinator ownership, same-job admission/aggregate custody, separate aggregate
attestation, payload signing, five serial one-key TUF jobs, immutable Release
publication and complete-site Pages ownership. Every App token factory uses the
bound App ID and checks the actual installation before credential use. The
ordinary read token has Checks read where actual producer/job Check readback is
required. The dedicated Release App token reaches only its fixed publisher.

A publishing/promoting candidate with authenticated original context and all five
role outputs routes those inert locators through their existing authenticating
consumers. It obtains current aggregate readback/attestation, then Release and
Pages; payload and TUF signing jobs are skipped. Wrong phase, partial roles,
changed source/context/binding, failed aggregate attestation or failed Release
publication cannot bypass the relevant receiver or dependency. Pending remote
mutation and result-upload recovery retain their separate existing acceptance
requirements; this route does not declare those effects completed.

The automatic wake's actual `wake_run_id` input and run-name now match the fixed
dispatch/reconciliation contract. It conveys correlation only, never accepted
policy or a candidate assertion. The fixed observer starts at each reader's
actual initial ordinal; no Administration-write token enters a reader or signer.

## Proposed resource reconciliation

The complete controller has 52 non-input job-minutes and 46 classification/control
job-minutes, plus one automatic-wake minute: **99 declared, hard ceiling 100**.
These include setup and cleanup inside each original provider job clock. The
independent candidate build workflow retains its separately bounded profile;
this accounting is the controller/wake boundary, not a claim that package builds
cost no resources. Readiness or control exhaustion holds; no paid fallback or
increased job deadline is introduced.

The proposed policy now pins the exact complete-controller and wake bytes. Input
jobs are inline under the same controller concurrency group. Its estimate includes
three control-source receipts and at most 80 readiness/observation pairs (four
initial+14 phases, five TUF phases of three, and five site rounds), each bounded
at 128 KiB; two bounded wake receipts; and ten diagnostic archives, each selecting
only 66 fixed public marker files of at most 64 KiB plus a bounded manifest.
The latter adds at most 43,909,120 bytes, before archive overhead. No logs, private
keys, candidate files or arbitrary paths enter that diagnostic selection.
Existing 512 MiB per-file and 2 GiB archive/assembly ceilings remain unchanged.
These are estimates and read/operation bounds, not account-wide storage headroom,
a reservation or guaranteed availability.

The changed policy digest invalidates the historical ratification for this
proposal. Matching owner-controlled configuration, observed protection and the
exact initial execution grant remain required before use. Availability and
headroom remain **Unknown**, with no reservation. Operation success proves its
own result only. Failures, partial effects and original recovery evidence remain
retained; no unrelated evidence deletion is introduced.

## Verification and limits

The actual YAML job conditions are exercised for fresh release, retained custody,
metadata-only renewal, held decisions and failed prerequisite jobs. Real filesystem
diagnostic checks exclude unrelated/private files, links and oversized markers,
and preserve earlier output. Actual pinned Node parses embedded programs; actual
Bash installation guards reject changed, absent and injected identities.

The connected controller, locator and startup selection passed 36 checks before
the resource/wake reconciliation. The resource/wake/transport selection then
passed 39 checks, with one unchanged Windows-inapplicable Linux socket case skipped.
An earlier local typed check found a test-only inferred spawn result type; it is
retained and repaired with the explicit Node return type. Final independent
review, exact-head hosted CI and actual fresh-tool build are recorded with delivery.
These tests do not establish real semantic judgment, native host qualification,
public delivery, signing custody, provider configuration or production acceptance.

#254 stays Done; #315/#534/#246 acceptance remains pending. Chameleon protected
acceptance is unset. Production remains held and slice 5 is excluded.
