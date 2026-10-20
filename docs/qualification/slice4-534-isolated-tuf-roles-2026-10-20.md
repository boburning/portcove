# Slice 4 isolated online TUF roles — October 20, 2026

Owner: #534. Implementation and disposable-key evidence; no custody change.

The maintained Tough-based release tool now signs Releases, Preview, Stable,
Snapshot and Timestamp in separate invocations. Each invocation accepts only its
own role private-key path. Public context derives delegated identities from the
authenticated Root and offline top-level Targets. Their private keys are absent
from every online job. The older multi-key builder remains an offline bootstrap
or disposable qualification tool, not the production role path.

Keyless `assemble-tuf` checks the actual separately signed envelopes through
Tough and emits a complete repository. Prior authenticated versioned metadata and
consistent targets remain present byte-for-byte. Every historical Releases logical
target must also equal the current context's logical record bytes: removing or
rewriting an older record is rejected even if an old Releases envelope and its
Snapshot are validly re-signed. The check runs before role-key access.

Initial empty Stable can be renewed only with unchanged empty content; renewal
cannot introduce promotion. Offline anchors remain unchanged and valid. Normal
signing refuses expired prior repositories; recovery is a separate procedure.

## Exact evidence

Independent non-writing review cleared `5a5c39a2c9e3937f88cabc81c8e587720d765a3f`
with one history P2, then cleared its repair
`5817077b7682b47706432f95784d842d0ebeeaf8`. The repaired regression creates an
actually signed historical Releases rewrite, re-signs its Snapshot and reconstructs
the exact inventory; the new check refuses it rather than merely failing an old
hash. Full package checks pass 13 tests (nine TUF and four payload); Clippy with
warnings denied passes. Earlier fixture-setup and diagnostic assertions are
retained with their actual failure scope.

The repaired local qualification executable has SHA-256
`b9dd6291f27d130dc0eadfc41d97776d6ca7f4b6c047056df0a1ad56ea699027`.
Its public-only fixture export is retained at
`work/role-signing/public-fixture-2` in the role-signing worktree. No private keys
are included in that export. Earlier composer qualification used the previous
explicitly recorded binary and is not relabeled as this repaired binary's proof.

## Remaining integration

Metadata-only preparation, current public-feed import, coordinator maintenance
subjects, isolated hosted role jobs, immutable artifact handoffs, final expiry/
resource configuration and actual custody/public-key observations remain separate
connections. This CLI implementation and its disposable keys establish none of
those production outcomes. No signing, feed or key installation has been activated.

#254 remains Done; #315/#534/#246 acceptance pending; Chameleon protected
acceptance unset; production held; Slice 5 excluded.
