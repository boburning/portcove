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

The combined main-target integration ran 98 focused cases: 95 passed and three
were explicitly skipped (the unavailable GNU producer and two existing
non-Windows shell publisher cases). It includes the actual pinned tool bundle
and isolated receiver load without `node_modules`, source/output joins, refusal
cases, native wire integrity and SPDX custody. Type-aware lint and formatting
passed. The existing reviewed shared publication inventory extraction is also
included; its 15 admission cases passed after exact-byte composition. Independent
reviews cleared compiler source `68e7e5d`, tool/native-wire source `5fae0416` and
SPDX custody source `bac4e5a0`; these are component review identities, not native
or production execution evidence.

The original Node test-runner invocation for the existing Vitest preparation
suite failed before collecting that suite. Its corrected maintained
`run-ui-tests.mts exact scripts/prepare-release-version.test.mts` invocation
executed all six tests successfully, with ordinary resource admission and
supervisor cleanup. This was a test invocation correction, not a product repair.

The reviewed generated tool asset and actual receiver getter are integrated in
the combined delivery; its eleven-file ordinary hosted build remains separately
observed evidence. The actual signed SPDX collector also retains its publication
document through a private same-process getter, with bounded document,
verification, artifact and receipt readback. Imported or injected summaries
cannot appoint publication bytes, and the getter does not supply scanner or
native acceptance. The private admission continuation carries the actual SPDX
receipt independently of detached public facts.

Eligible candidate/reservation,
authenticated semantic producer output, stage-specific native pre-sign and
post-sign qualification, relevant custody/public keys, observed protections and
the final exact grant remain separate. No current native/security/history hold
is cleared by this compiler component. The pre-sign native stage must establish
actual package/install/launch/minimum/protocol facts; update/rollback/journal
qualification gates publication after signing. Full public V0-to-V1 acceptance
is a later observation and cannot gate its own initial publication.

## Prepared Windows installed-byte input (October 21)

The ordinary public-parent join requires the actual installed executable to
match an independently observed compiler identity. Existing reports bind NSIS
package bytes but do not expose the inner Windows executable hash. The fixed
same-job desktop capture now emits schema 3 after the Tauri process and final
NSIS discovery, reading only its fresh target's `release/portcove-desktop.exe`.
It brackets a bounded regular unlinked file read and computes the exact single
Tauri bundle-slot `UNK` to `NSS` hash projection in memory. No executable,
installer or signature is modified. The package output inventory stays separate
and must still equal the independently acquired aggregate bytes.

The existing complete report/producer/attestation/source-closure consumer checks
the schema-3 platform/interface, retains the exact source/run/numeric producer
and report digest, and binds the one NSIS package slot. Its new private getter
rehashes the original proof before exposing a detached executable/package tuple.
Legacy schema 2 remains usable for its original scope but supplies no such
identity. Imported and injected receipts cannot call this getter successfully.

This is an input to the next actual public-parent join, not proof that the
installer contains or installed those bytes. The genuine isolated installation
and automatic public updater must compare their actual bytes with the observed
identity. The actual build, local-parent collection, public journey and native
acceptance remain unobserved; controlled slot/file/report tests and unchanged
compiler fixture paths confer no additional authority.
The projection is pinned to the repository's CLI 2.12.2 and runtime 2.12.4:
[runtime bundle marker](https://github.com/tauri-apps/tauri/blob/59b63ab500da9859f12d8888c3298bc29bba0b92/crates/tauri-utils/src/platform.rs#L355-L369)
retains the unknown marker and recognizes the NSIS value;
[bundler patch and restoration](https://github.com/tauri-apps/tauri/blob/5b23c82ea5ba6b9aec420dd71f60493edc486aa9/crates/tauri-bundler/src/bundle.rs#L35-L89)
selects the NSIS suffix before packaging, then
[restores the original executable](https://github.com/tauri-apps/tauri/blob/5b23c82ea5ba6b9aec420dd71f60493edc486aa9/crates/tauri-bundler/src/bundle.rs#L195-L201).
The maintained capture uses `--no-sign`; the pinned
[signer returns without signing](https://github.com/tauri-apps/tauri/blob/5b23c82ea5ba6b9aec420dd71f60493edc486aa9/crates/tauri-bundler/src/bundle/windows/sign.rs#L228-L235).
The selected default current-user NSIS template
[copies that main executable into the installation directory](https://github.com/tauri-apps/tauri/blob/5b23c82ea5ba6b9aec420dd71f60493edc486aa9/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi#L604-L614).
This reasoning covers that unsigned default-template route with the maintained
public overlay, without custom hooks or executable transforms. It does not
substitute for installer containment or the actual installed-file comparison.

The final controlled compiler selection passed 17 cases with one existing GNU
tar producer skip on Windows; all 105 validation-plan/local-selection cases
passed. Resource-admitted type-aware lint passed all eight changed TypeScript
files. These checks use inert temporary executable/report bytes, retained fake
provider artifacts and existing private-brand refusal paths. They run no actual
compiler, installer, native account or public updater.
