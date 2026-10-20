# Slice 4 acceptance producer integration preparation

Owner: [#534](https://github.com/boburning/portcove/issues/534). This component
does not authorize protected execution, keys, signing, publication or acceptance.

The maintained admission reader now consumes the existing GitHub Sigstore SPDX
attestation. It downloads one exact numeric immutable final artifact, within the
existing total archive allowance, preflights its complete ZIP inventory, checks
the bounded actual package subject and retained document, and invokes GitHub's
signature verifier with the fixed repository, issuer, workflow, source, ref,
run and attempt. All selected package subjects must match the independently
discovered package hashes. The SPDX document must contain the pinned Syft
producer and a complete local package/relationship graph. Missing evidence is
Unknown; changed bytes, wrong issuers, incomplete subjects or ambiguous verified
results refuse. Only actual provider scope can clear the document hold.

The existing isolated `attest` job also runs for the identity-selected initial
beta dispatch. Its permission set and fixed action remain unchanged. The
dispatch certificate must refer to the already observed immutable reservation
tag `refs/tags/<namespace>-prepared/v<version>` and prepared source commit.
General push behavior remains. Full-profile manual rehearsal does not acquire
this attestation path. GitHub documents the [SPDX verification predicate](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

This authenticates a document and its exact package subjects. It does not prove
vulnerability clearance, original compiler execution, package contents or native
installation. The certificate binds the workflow/run/attempt; the separately
observed unique attester job ID is retained without relabeling it as the build
job. The additional final archive stays inside the existing two-GiB acquisition
bound. Other final package members are structurally checked, not expanded and
rehashed as part of this document-only proof.

Beta CLI and desktop build steps now use direct parent capture through the
existing admitted process-tree supervisor. Each invocation reconstructs and
checks the exact six public input members, binds source/tree, actual Node,
Tauri JavaScript/native package and lock hashes, and observes the fixed Rust
toolchain paths, versions and executable hashes. The child receives toolchain,
resource and public configuration inputs without role, OIDC or signing
credentials. Desktop uses the existing public overlay with `--no-sign`; CLI
states explicitly that updater inputs do not apply to CLI compilation. Failed
exits and changed inputs/tools remain failed, preserving partial outputs.
Started and final observations are separate new files and upload through the
existing seven-day, no-overwrite transport, including on a failed build step.
There are no additional jobs, caches or larger runners.

Both real outer native harnesses now include their actual script hash, checkout
commit/tree and host observation. Windows records the installer pair before
mutation; Linux retains the initial library/game/save/backup/log marker hashes.
The new native consumer binds those identities and the actual package pair and
interprets existing scenario/retained-state fields. Failed and partial journals
retain their phase and completed subset. Imported JSON supplies no native
authority. In particular, the running harness checkout is not automatically the
package's compiler source, and Windows update/uninstall evidence does not supply
an absent rollback observation.

The handshake has an optional fifth `onAdmitted` callback. It can execute only
after an actual `admitted` result with zero holds, actual `github.com` scope,
phase-matching runtime-branded controls and the same private-facts reservation
checkpoint. It receives the frozen facts, actual control source and final
snapshot inside that process. Current independent holds prevent invocation;
there is no serialized positive session or fixture bypass.

Remaining engineering is explicit: original compiler acceptance still needs
actual producing-job provenance and capture-output-to-package binding through
the independently checked report transport. A signature over imported report
bytes alone is insufficient. Native acceptance still needs the direct harness
handoff, required minimum-environment identity, exact final teardown evidence
and absent Windows recovery observations. These are not renamed operator
observations. No production credential is needed to prepare those adapters.
Actual qualified package/environment runs and custody remain separate evidence.

The final focused selection passes 59 cases with two existing platform skips
(61 total). Checks exercise inert compiler processes, refusal/partial capture,
strict SPDX verification contracts, native partial-report interpretation and
existing admission/workflow/inventory interactions. These fixtures establish no
release compiler, installed application, native host or production acceptance.
PowerShell parsing passes for both changed harnesses. Initial stale assertions
for the former combined SBOM/native hold were repaired to require both separate
holds. The prior unrelated native/Git/storage failures remain unchanged.

The source/workflow change invalidates its corresponding old digest/resource
ratification. Final controller budgeting still includes input and tool jobs
within the existing 100-minute ceiling; this preparation asserts no timing
feasibility or spending headroom. Availability/headroom remain Unknown, with no
capacity reservation. #254 stays Done; #315/#534/#246 acceptance, Chameleon
protected acceptance, production execution and slice 5 boundaries are unchanged.
