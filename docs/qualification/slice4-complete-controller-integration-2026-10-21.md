# Complete held controller integration — 2026-10-21

This is a reviewable initial configuration, not activation or provider enforcement.
The [complete controller](application-update-production.complete.yml) now has identical source under `.github/workflows/application-update-production.yml`; the wake likewise has an installed, configuration-held source. Existing D1/D2/D3 decisions,
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

The coordinator and its observer may start after failed classification persistence
only when source admission and trusted tools succeed. Existing maintenance-first
selection can therefore renew already accepted metadata while a new semantic
review is unavailable. The actual coordinator still authenticates maintenance
controls, and new-release admission still requires independently accepted
classification; this workflow condition supplies neither authority.

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

## Installed source and initial configuration hold

The complete controller and automatic wake now occupy their actual workflow paths.
Their retained proposals are byte-identical, and the capacity policy pins both
exact sources. This removes a future source-copy step before the final reviewed
controller/tag/tool identities can be bound.

The controller starts no job unless its existing admission configuration is
nonempty and its configured source/ref match the provider source/ref. Its first
secret-free bootstrap still validates the exact protected tag, source, actor,
workflow bytes and grant; every credential role retains its own admission. The
wake starts no job without its existing selected wake configuration. No new
activation mechanism, App, key or protected setting is installed by this source
change. Authenticated repository-variable inventory returned HTTP success with
zero variables before authoring. Refresh that preimage before delivery and retain
the provider's automatic skipped wake as its own limited observation.

Actual YAML dependency evaluation proves that empty configuration starts zero
jobs, including downstream `always()` branches. Actual Bash bootstrap checks
continue to reject changed identities before checkout. The focused installed
workflow/admission/wake/capacity selection passed 42 checks; initial test feedback
concerned the retired literal-false expectation and scalar YAML `needs` syntax.
Those test assumptions were repaired; the production source checks remain intact.
Configuration presence is routing, never acceptance. Actual runtime, credentials,
protections, custody, signing, public proof and the exact initial grant remain
separate prerequisites.

Normal cleanup uses the already selected seven-day provider retention and positive
owned process/namespace teardown. No early DELETE permission or cleanup App is
added. Expiry is not successor custody or capacity. Actual cleanup observations
remain acceptance evidence to collect in the authorized journey.

The first installed-source CI (`39547918663/1`) retained two failures: an obsolete
whole-workflow assertion prohibited even the isolated observer, and pinned
Actionlint did not recognize the provider's optional `queue: max` syntax. The
assertion now checks actual per-job observer credential isolation. Both workflows
use the ordinary one-pending-run concurrency behavior, with unchanged groups and
`cancel-in-progress: false`; bounded wake coalescing cannot cancel a running
controller, replace durable coordinator intent or authorize a retry. No linter
suppression, tool migration or increased queue/resource ceiling is introduced.
