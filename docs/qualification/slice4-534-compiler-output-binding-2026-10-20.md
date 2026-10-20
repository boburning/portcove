# Slice 4: fixed compiler and actual output binding preparation

This adds a usable compiler-evidence path to the delivered #2273 component. It
does not establish an observed Release build, native acceptance, protected
execution or publication. #254 stays Done; #315/#534/#246 stay pending, Chameleon
protected acceptance stays unset, and slice 5 is excluded.

## Implemented path

- Selected beta CLI compilation creates a new attempt-private Cargo target. Its
  same-job desktop build must use that exact source/tree/run/attempt target.
  Cargo jobs are four, incremental compilation is disabled, and the selected
  beta bypasses restored Rust target caches. General full-profile behavior stays
  on its existing route.
- The supervising parent records the real CLI binary or every selected desktop
  bundle immediately after its supervised invocation. Started and completed
  reports have unique interface/platform names; failures preserve their actual
  state and partial outputs. Injected test execution never reports actual
  compiler output evidence.
- The existing isolated Release attester adds a separate SLSA attestation over
  the four inert report files. It does not execute candidate scripts or claim
  that the attester compiled them.
- The consumer independently collects the actual completed run/attempt and
  exact immutable report artifact IDs/digests, verifies complete bounded ZIP
  contents and the actual GitHub/Sigstore report subjects, and brackets provider
  identities. It matches exact successful numeric `Build <platform>` jobs and
  their lifetimes, pinned tool observations, all six independently reconstructed
  public input members, fixed invocation arguments and the same private target.
- Desktop output hashes must equal all staged desktop package hashes. The CLI
  package must contain the captured binary exactly: one normal ZIP member or
  one normal raw TAR member. Gzip output is bounded by the independently captured
  binary size plus fixed TAR blocking overhead. PAX/GNU extensions, links,
  sparse entries, trailing members and oversized declarations refuse before
  semantic archive preprocessing. No payload is executed or extracted here.
- The original source's complete maintained scripts, desktop scripts, local
  actions, producing Release workflow and selected tool/configuration blobs must
  match the fixed controller's generated source closure. The final consumer
  requires the existing actual tool-receiver brand and its manifest-owned
  `compiler-source-closure.json`; a raw JSON closure cannot appoint authority.
  The tool bootstrap's generated asset/getter is coordinated with its owner.
- Prepared source is handled through the existing four-file version transform,
  not a blanket version-field exception. Existing complete reconstructed Git
  net-tree evidence must show one exact parent and exactly those four inert
  version edits. Expected prepared blob hashes are reproduced from authenticated
  original bytes. Dependency, script, configuration and extra changes refuse.
- Admission accepts an optional actual same-process controller-tools prerequisite
  (the sixth handshake argument). It clears the compiler hold only after the
  complete actual provider/source/output proof and private evidence brand pass.
  Missing inputs retain the hold; fixture transports cannot clear it. Compiler
  acquisition and all large package work occur before fresh controls.

The immutable tool asset is an existing tool custody extension. It is not a new
classifier, journal, imported acceptance descriptor or signing authority.

## Resource and failure scope

The selected two beta build jobs each have a finite 60-minute ceiling, replacing
their previous implicit 360-minute maximum. These candidate build minutes are
separate from, and not free or omitted from, the unchanged 100-minute controller
and input-job budget. Fresh targets can increase disk use and build time; no
measurement here establishes actual availability or headroom. No shared target
cache is consumed, no unrelated cache/evidence is deleted, and there is no paid
fallback or automatic retry.

The four compiler report archives add at most 8 MiB of compressed acquisition.
Admission subtracts their actual bytes from the existing total acquisition
budget before the SBOM download. All retained compiler/public input receipts
keep seven-day hosted retention and no overwrite. These changes invalidate
corresponding older workflow/resource ratification before execution; they do not
activate any configuration or increase the controller budget.

Missing reports remain Unknown. Changed inputs, wrong attester/source/run,
incomplete observations, mismatched started/completed captures, wrong tool/job
lifetime, incomplete packages or changed output bytes refuse. Original scanner
failures and separate exact-candidate #706 policy decisions remain distinct from
compiler, ordinary CI and native acceptance. The current #706 first ordinary
Linux beta disposition cannot automatically cover a second ordinary beta in the
full V0-to-V1 public proof.

## Verification and remaining work

Focused verification exercises bounded real ZIP/TAR parsing, complete four-report
transport and package joins with inert bytes, cross-platform paths, actual local
Git source/prepared transformations, wrong/changed/missing identities and refusal
of imported runtime brands. Synthetic provider signatures and package bytes retain
fixture scope; no native package build or actual compiler attestation was run.
The GNU-tar producer observation is skipped on this Windows host.

The original Node test-runner invocation for the existing Vitest preparation
suite failed before collecting that suite. Its corrected maintained
`run-ui-tests.mts exact scripts/prepare-release-version.test.mts` invocation
executed all six tests successfully, with ordinary resource admission and
supervisor cleanup. This was a test invocation correction, not a product repair.

Actual controller tool-asset integration, eligible candidate/reservation,
authenticated semantic producer output, stage-specific native pre-sign and
post-sign qualification, relevant custody/public keys, observed protections and
the final exact grant remain separate. No current native/security/history hold
is cleared by this compiler component. The pre-sign native stage must establish
actual package/install/launch/minimum/protocol facts; update/rollback/journal
qualification gates publication after signing. Full public V0-to-V1 acceptance
is a later observation and cannot gate its own initial publication.
