# Slice 4 immutable Release preparation — October 20, 2026

Owner: #534. Reviewed transport and exact-source qualification implementation;
no production credential, protected execution or publication authority.

The initial-beta adapter derives all six mandatory packages from the existing
verified aggregate and independently pinned public build configuration. It
verifies the two updater signatures against that configured public key, retains
the required SPDX SBOM and regenerates complete public checksums. Cryptographic
verification does not establish the signer job's authority, strict SBOM producer
acceptance, native behavior or original compiler inputs.

The maintained finalizer now accepts an exact candidate qualification root while
retaining its fixed controller policy/storage boundary. Raw local Git blobs
materialize the independently expected prepared commit/tree without checkout,
filters, hooks or candidate build execution. Cargo/toolchain configuration must
match the reviewed controller; ancestor Cargo configuration refuses. Missing
objects refuse with lazy fetching disabled. The exact source and #706 baseline
objects must be available locally before this preparation. The child receives
only the existing read-only qualification job token, never publication, signing,
observer or issuer credentials. Actual scanner/security refusal remains a hold;
local source fixtures do not establish a successful release scan.

Publication is draft-first and advances one effect at a time through the existing
caller's durable-intent/executor seam. It uploads no replacement, deletes no asset
and moves no tag. Logical destinations stay fixed per tag and purpose (create,
filename upload, publish), so changed provider IDs or content cannot reset retry
floors. Exact request digests and completed provider receipts retain those IDs
and content hashes. Complete provider release/asset readback binds numeric IDs,
size and digest. Publication requires all expected assets; completion additionally
requires the provider's actual `immutable: true` and exact version tag commit.
An available token or documentation example proves neither setting enforcement
nor authority. Observed repository immutability setup belongs to the existing
isolated protection observer, not the publisher credential.

The caller's executor returns the actual capacity intent ID and settled
checkpoint. The adapter re-reads that exact checkpoint, verifies the resolved
operation/candidate/destination/callback evidence and rechecks the aggregate
reservation. Lost responses or contradictory readback revoke the private session
and require explicit existing recovery. Recovery evidence retains the current
invocation checkpoint and any known settled checkpoint. There is no automatic
retry or parallel journal. Public preparation reports are detached from the
module-owned private execution state.

Independent review cleared prepared source
`95a9f887d6d34060d88f98703c2c73a5e5558e8c` after narrow repairs at
`548c8b71141a5bb423721465091b46fa1e45bb8c`. Focused fixtures cover draft-first
transitions, incomplete/mutable/corrupt assets, mismatched create tags, invalid
publication IDs, exact settlement identity/evidence, inert prepared sources,
Cargo isolation and missing promisor objects without transport invocation.

The actual fixed publication job/executor wrapper, phase-fresh controls,
observed immutability enforcement, authenticated signer/SBOM/native/compiler
acceptance, eligible candidate and final ratified resource/workflow/grant remain
independent prerequisites. This delivery activates no workflow and performs no
remote Release write. Bounded attempt eligibility retains Unknown availability
and headroom with no capacity reservation. #254 remains Done; #315/#534/#246
acceptance pending; Chameleon protected acceptance unset; Slice 5 excluded.
