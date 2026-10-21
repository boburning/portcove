# Catalog signing handoff source checkpoint

This checkpoint implements adapters, without appointing a publisher, provisioning
keys, activating a workflow or claiming protected/provider acceptance.

The coordinator requires its actual Core invocation receipt, the original settled
semantic capture and a fresh selected-App Check, ratified catalog configuration,
current maintenance controls, and the existing durable catalog subject. It keeps
one original 170-second clock and one ordinal allocator (initial 0, then 1–14).
The Core invocation must use the identical actual controller-tool receipt.

`completeCoordinatorCatalogSigningContext` uses the existing exclusive pending,
immutable context upload, provider readback and attestation transport. Each of the
four catalog role entries authenticates its own fixed job, context, dependencies,
current controls, semantic Check and owned pending before opening its one-use
key channel. The fixed Rust command accepts only that appointed role's key.
Keyless assembly receives all four actual attested role receipts, invokes the
maintained Tough assembler, and rehashes retained inputs, output and proof files.
None of these receipts is application release/native completion or permission to
deploy. Imported reports and injected transport results cannot mint them.

The producer refuses an existing unresolved context effect. This checkpoint adds
no automatic context replay or new recovery journal; full fixed DAG selection,
durable baseline creation and sole Pages publication are separate caller work.
The unchanged transport caps still apply: two context members, 128 MiB total,
1 MiB per represented file and 2,208 files; role envelopes remain 512 KiB.
A valid larger Core bundle can therefore be refused by the narrower transport.

The Rust context generation time must remain within its existing five-minute
window through role signing and assembly. Separate 115-second original job
ceilings do not establish that the complete hosted chain will fit this window.
No timestamp remint, production timeout or resource limit increase is included.

Focused source checks covered exact catalog-purpose archive contents and u64
serialization, changed source/admission/prior refusal, dependency ordering,
original provider job clocks, imported-receipt refusal, and injected catalog
attestation/completed-job custody. Existing application controller, context,
handoff and role tests were also exercised. Linux-only socket and optional
actual-Rust worker cases skipped on this Windows run; no new protected positive
execution is inferred. Earlier checks exposed and repaired canonical UTC
serialization, Promise rejection compatibility, and the shared output reader's
previously application-only producer list.
