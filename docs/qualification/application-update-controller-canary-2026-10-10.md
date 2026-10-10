# Disposable controller enforcement proposal — October 10, 2026

Owner: [#534](https://github.com/boburning/portcove/issues/534), consuming
[the existing owner amendment](https://github.com/boburning/portcove/issues/534#issuecomment-5999823580).
The initial component was source preparation. The `.yml.txt` template is inert;
that preparation provisioned no workflow, tag, environment, variable, secret or
protection. The separately authorized activation and bounded proof are recorded
below.
The existing default-branch release-coordinator rehearsal remains unchanged.
The delivered #1710 offline-targets/online-role split remains credited.

## Proposed independent boundary

Dispatch the reviewed controller directly at an immutable tag; admit its canary
environment using exactly that **tag** rule, not a same-name branch or protected
branches generally. An Active tag ruleset restricts creation/update/deletion,
with no routine bypass actors. Disable environment bypass and routine required
reviewers for this disposable proof. Settings administrators remain trusted
custodians and must be inventoried. GitHub matches deployment rules to the run
ref; it supports separate branch/tag rules and environment secrets become
available only to environment jobs. These documented controls make the route a
plausible independent ref boundary, not a proven configuration.
[Environment rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[tag restrictions](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

The environment gates the execution ref, not a particular workflow digest. Every
workflow/action/executable dependency reachable at the frozen controller tag
must therefore be reviewed. A pinned reusable workflow called from main retains
the caller-associated ref and does not replace this boundary. Repository secrets
and other workflows' write tokens are separate authority: this canary grants no
repository publication permission and cannot prove the eventual publisher boundary.

## Concrete disposable configuration packet

The canonical owner must separately authorize these exact effects after reviewed
source delivery. This document is the preparation packet, not that authorization.

| Field                  | Proposed value / required observation                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository             | `boburning/portcove`                                                                                                                                                                                                                                                 |
| Activation path        | `.github/workflows/application-update-controller-canary.yml`, copied from the reviewed inert template; exact activated commit/tree and every workflow/dependency digest require separate readback/review                                                             |
| Controller tag         | `portcove-controller-canary-20261010`, frozen at that separately reviewed activated commit; no tag is created by this candidate                                                                                                                                      |
| Tag ruleset            | Active; exact controller tag; creation/update/deletion restricted; no routine bypass; exact administrative custody/readback retained                                                                                                                                 |
| Environment            | `portcove-controller-canary`; selected deployment rules contain only `type=tag`, `name=portcove-controller-canary-20261010`; bypass disabled; no routine reviewers; exact readback required                                                                          |
| Frozen dispatch actors | Proposed reviewed code permits only boburning numericID43177418 and github-actions[bot] numericID41898282, freshly read from their public API identities; activation authorization must explicitly admit those actors. Repository variables cannot alter this policy |
| Environment variables  | `PORTCOVE_CONTROLLER_CANARY_SHA` = activated reviewed SHA; `PORTCOVE_CONTROLLER_CANARY_DIGEST` = SHA256 of the UTF-8 64-character lowercase hexadecimal disposable canary; environment owner/admin custody and readback required                                     |
| Environment secret     | `PORTCOVE_CONTROLLER_CANARY`:32 random bytes encoded as64 lowercase hex characters; never a credential, signing key, recovery secret or production material                                                                                                          |
| Token grants           | Only `contents:read` for each trusted checkout; no release/Pages/signing privilege. Any automatic caller's narrow `actions:write` grant is a separate owner decision, not created by this template                                                                   |
| Resources              | Two standard Ubuntu22.04 jobs, five minutes each, serialized, no cancellation of an existing run, one small seven-day identity artifact; actual free storage/cache/account capacity remains an admission requirement                                                 |
| Teardown               | Owner-authorized removal of disposable secret/configuration after retained readback; preserve receipts and failed evidence; no production revocation is implied                                                                                                      |

The controller helper uses only Node built-ins. The pinned setup-node Action may
download the fixed Node24.21.0 runtime; the Action/runtime are reviewed tool
dependencies and package-manager caching is explicitly disabled. No candidate
checkout, candidate-supplied executable, package install, restored cache, arbitrary
path or command is consumed. Source admission checks repository, dispatch event,
exact tag/workflow ref, observed SHA shape, frozen numeric actor inventory,
attempt1, bounded2048B schema1 `probe-only` JSON and a strict string32-character
hex nonce. The separate canary step checks the owner/admin-controlled environment
SHA before reading canary material, then returns only its nonsecret digest and
identity receipt. The independent tag/environment protections remain the actual
source boundary; neither code check proves its own platform immutability. Fixtures
establish these code refusals, not GitHub enforcement or actual zero approvals.

## Required platform proof before production adoption

The activation candidate adds a mutually exclusive `environment-negative`
dispatch option. It skips admission and the canary job, and requests the same
environment directly in a one-minute, token-permission-free job. It checks out
no source, uses no Action, references no secret or protected variable, and reads
no canary material. If a runner starts, it records only run/ref and fails. For
an ineligible ref, job startup is therefore an adverse platform-policy result,
not a passing source-code rejection. This route permits actual environment
denial checks after authorization without disabling the positive controller's
source guards. Normal two-job execution and this one-job probe are mutually
exclusive; existing concurrency and capacity admission still apply.

After exact owner authorization, retain actual activation source/tree/digests,
typed environment policy, Active ruleset and full bypass/admin inventory. Prove
the directly dispatched eligible tag can reach only disposable material with
zero routine approvals; bind run/attempt/ref/SHA/actor/nonce/artifact digest.
Exercise main, PR/fork, wrong tag, same-name branch, reusable main caller, altered
main guards and tag creation/update/deletion refusal. An environment-denied job
must never begin. Preserve failure artifacts and distinguish platform refusal
from the controller's own secret-free rejection.

Provisioning order must itself preserve the boundary: review the activated source
first; apply the exact Active ruleset with only a separately authorized temporary
owner creation bypass; create/read back the frozen tag; remove that temporary
bypass and verify creation/update/deletion restrictions; then configure/read back
the typed environment policy and disposable material. No secret is provisioned
while the tag is mutable. Administrative policy changes remain owner-controlled.

A caller with an approved bot identity can dispatch the approved tag regardless
of which upstream main workflow made the request. That executes immutable trusted
canary code; it does **not** authenticate an eligible production release request.
Production still requires independently verified candidate/classification/run
lineage, allocation freshness, complete artifact inventory, serialization,
capacity exhaustion holds, safe retries and public readback. Do not call a
shared bot identity proof of trusted caller provenance.

Actual custody/recovery media, root/targets offline keys, distinct online roles,
payload signing, minimum publisher/Pages authority and feed activation remain
separate #534 packet fields. Standard public runners and proposed controls need
no mandatory server/App/PAT or additional paid resource, but current account and
artifact capacity must be verified. Preserve Windows/ordinary Linux, the full
317-record/316-identity cohort, Linux GLib security hold and production/tagging
authority boundaries. This component closes no release/platform acceptance.

## Authorized bounded platform proof

The canonical owner approved [the exact packet](https://github.com/boburning/portcove/issues/534#issuecomment-6099501516)
and then [the narrower zero-spend attempt](https://github.com/boburning/portcove/issues/534#issuecomment-6099765626).
[The complete delivery receipt](https://github.com/boburning/portcove/issues/534#issuecomment-6099823612)
records control preimages, actual denials, archive verification and remaining scope.
PR #1719 merged as `c32b86072e931586b1901f88253e413dbc8155c9`.
The protected tag targets reviewed head `b67826eda36547add4b3304682d6301464a979a1`,
tree `adecbfd5ae375ef54e29ace13b6f25c594c14f56`; all 15 reviewed closure blobs agreed.

| Ref                                    | Run / attempt                                                                   | Observation                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Exact controller tag                   | [38068408780/1](https://github.com/boburning/portcove/actions/runs/38068408780) | Admission and protected canary passed; nonsecret receipt retained |
| `refs/heads/main`                      | [38068507505/1](https://github.com/boburning/portcove/actions/runs/38068507505) | Explicit environment branch-policy denial                         |
| Wrong tag ending `-wrong-ref`          | [38068532042/1](https://github.com/boburning/portcove/actions/runs/38068532042) | Explicit environment tag-policy denial                            |
| Branch sharing the controller tag name | [38068602640/1](https://github.com/boburning/portcove/actions/runs/38068602640) | Explicit environment branch-policy denial                         |

Each negative job had runner ID 0 and no steps. Check annotations named the denied
ref and environment protection rule. Complete enumeration found exactly four
dispatches, each attempt 1, serialized without retries. Positive artifact
11676380818 is 529 bytes and expires October 17, 2026, at 16:37:42 UTC. The downloaded
archive agrees with its API SHA-256 digest:
`ecf5e68e3990b9e594284d83ac39d68599b5383019f58e2e97ac4f3a071fc3e4`.
The parsed receipt agrees on head, execution/workflow ref, actor, run, attempt,
nonce and disposable canary digest. No secret bytes were retained in evidence.

Final readback found Active exact tag ruleset 24845568, creation/update/deletion
restrictions, no bypass actors, and the unchanged tag. Environment 23963641917 has
administrator bypass disabled and only tag policy 62609324 for the exact controller
tag, the two approved variables and one disposable secret. Actual update/deletion
probes returned explicit rule violations. Creation returned generic `Reference
update failed`: creation-policy denial remains unproven. No release tag changed.

The existing zero-dollar Actions budget with stop-usage enabled was preserved.
Included artifact headroom was unconfirmed; the owner authorized one bounded
attempt, whose artifact upload succeeded. No paid capacity, budget change, evidence
deletion or further attempt was admitted. The allocation is exhausted. Disposable
material/configuration and two probe refs remain retained for canonical owner
teardown disposition.

PR/fork/reusable-caller cases and a safe attributable creation-denial probe require
separately reviewed nonsecret source. Production request lineage, custody, signing,
feed publication and installed acceptance remain unqualified. This evidence does
not close #534 or lift the Linux GLib or native custody holds.
