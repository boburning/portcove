# Slice 4 authenticated metadata renewal — October 20, 2026

Owner: [#534](https://github.com/boburning/portcove/issues/534). This is an
implementation and disposable-key checkpoint, not production acceptance.

## Implemented connection

The maintained Tough stack now exposes `prepare-tuf-renewal`. It authenticates
an existing complete public application feed under the independently ratified
root, including safe expiry and retained history, before returning a renewal.
The records and offline Root/top-level Targets remain unchanged. Releases,
Preview, Stable, Snapshot and Timestamp versions advance exactly once; their
expirations advance within the existing limits. Expired current state refuses
normal renewal. An existing valid empty Stable remains empty; it cannot promote.

The fixed-hash TypeScript adapter snapshots complete bounded public inputs,
executes that actual keyless tool with no inherited credentials, and binds the
verified descriptor/context and complete output inventory to a private session.
Imported JSON cannot replace that session. The actual keyless assembler also
returns public component, root, offline-target, timestamp, snapshot and record
identities, exact decimal-string u64 versions and expirations after verification.
The internal repository manifest is excluded from the public component digest.

Schema2 metadata operations use the existing coordinator/capacity Git journal.
They do not allocate a fake application candidate or source/version/review.
Pending effects must be remotely confirmed before the supplied effect runs;
remote completion remains pending until exact readback closes it. Existing
candidate progress and published metadata survive interleaving. Initial published
state is never inferred: a separately authorized fixed caller must actually verify
the ratified root/feed and independent public readback before importing its seed.
The whole-site generation is bound separately from the application component.

Compact lifecycle groups preserve logical completion, the existing two transient
and three substantive recovery limits, and exact original checkpoint/operation
proofs in the same immutable journal. A confirmed one-effect receipt remains
completed through partial recovery. Old metadata groups can be released only
after a bound successor publication; active-candidate effects remain retained.
Executor and recovery-executor identities are associations, not authentication
or leases. Supplied boundary facts never establish available capacity.

## Exact evidence and preserved scope

Reviewed component commits are `07eaa95940ad696ed7fbeaffa78d0fb40d2024f8`,
`2a9f379f4ac48d87620410485468b99ab205c78b` and
`0b3f965742c482650954fc0859499ce7712bf5c7`. Separate non-writing review cleared
these implementations and the one-effect anti-repeat repair. Delivery reconciles
them with main `78e565c17f09ba716640a38aabd4c78b791e87ed`; the Rust source and
Cargo inputs match the tested component byte-for-byte. Current delivery review
and exact-head hosted checks remain separate obligations.

The resource-admitted full release-tools run passed 16 tests: one cross-runtime
canonical unit, eleven TUF tests and four payload-verification tests. This includes
actual disposable-key five-role signing, keyless renewal assembly and expired-feed
refusal. The resulting local executable SHA-256 is
`ed5811dc5e58e602196067a50ee4b815c34fe1c51adc5e44377a3e73ed0abdcb`.
Its public-only export is retained at `work/role-signing/public-renewal-fixture-1`.
The actual Rust-backed adapter passed all four cases with zero skips, including
subsequent custody mutation refusal. Planner/capacity tests passed 26 cases,
including the preserved four legacy plan hashes. Real-Git remote progression and
candidate-free sparse recovery passed; focused type-aware lint passed.

The bounded ledger workload covers 63 candidate purposes, seven metadata purposes
and five recovery increments within 64 KiB. These are fixture results, not live
provider headroom or enforcement. Earlier setup, source-change-while-queued,
fixture-assumption and fractional-time failures remain retained in local logs;
their later repairs are not relabeled as original successes.

The changed held controller still requires fresh coherent resource qualification;
its historical ratification does not silently cover the new source. Trusted
coordinator dispatch, isolated hosted role/key custody, exclusive authenticated
provider effects, actual public publication/readback and protected/native
acceptance remain separate integrations or observations. No active workflow,
credential, root/key installation, protected execution or production signing was
granted or performed here. #534/#315/#246 remain open; #254 remains Done.
