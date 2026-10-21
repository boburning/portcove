# Slice 4: fixed immutable Release continuation

This implementation connects the existing protected Release primitives. It does
not activate a workflow, provision an App, sign with production keys, publish a
Release, establish native qualification, or complete #534.

The qualified tool inventory adds `release-publication-controller.bundle.mjs`
and the fixed public Tauri configuration asset. The normal entry is
`--run FIXED_CONFIG`. Its exact configuration contains `configuration`,
`identity`, `tools`, `context`, and the five ordered `roles` locators. These are
transport identities: the default maintained tool/context/role receivers and
actual keyless Tough assembly must authenticate them before admission. There is
no caller-supplied accepted result, package directory, native expectation,
prepared Git directory, finalizer path, or private-receipt import.

The current publisher identity is distinct from the original aggregate, payload,
and role producers. Original aggregate identity and bytes must match the actual
authenticated context. Fresh publisher tools, signed environment, compiler,
SPDX, post-sign native pair, controls, reservation and executor remain required.
The original provider job start bounds all process modes to 350 seconds total;
monotonic sub-operation scopes only tighten that bound.

The source materializer reconstructs bounded raw commit/tree/blob identities
before writing them to an owned bare Git repository. It performs no Git network
fetch, hooks, checkout, lazy fetch or candidate execution. Existing candidate
qualification then materializes the exact prepared tree and invokes only the
fixed hash-qualified bundled `--finalize` child with a scrubbed read-only
environment. Existing strict scanner/release policy remains applicable.

There are at most twelve distinct Release effects: one draft, ten fixed assets,
and immutable publication. Each goes through the existing exclusive pending,
remote CAS, one effect, and readback settlement. There is no retry loop. Separate
fresh completion and result-upload observations bring the maximum immutable
control-round ordinal to fourteen, without extending the job or observation
freshness budgets.

After actual immutable readback, the existing phase writer persists promoting
and the existing owned report/handoff prepares the result artifact and unsigned
predicate. The fixed same-job `--ready`, `--uploaded ID SHA256`, and `--predicate`
commands coordinate the maintained upload/attestation workflow. Routing files
are not authority; the producer independently verifies uploaded provider bytes.
Original failed or unsigned artifacts cannot pass the completed-success result
consumer.

A promoting continuation collects current proof through a separate read-only
admission purpose. It cannot re-enter aggregate, signing, or Release-effect
routes. An unresolved latest effect remains held for exact coordinator recovery.
An already completed result upload returns its retained provider locator for
GET-only attestation reconciliation, without repeating the upload. A later
report repair requires an already consumed existing candidate recovery tuple,
fresh current proof, exact retained original promoting/publication locators, and
a new tuple-bound result destination. The original Release operation and its
original counters remain unchanged.

The context receiver retains one finite lifetime budget of 384 provider GETs:
initial twelve plus at most sixty-two six-GET refreshes. The complete default
role/assembly/native graph exceeds the previous forty-eight-read allowance.
Named retained provenance getters continue to rehash original authenticated
bytes without claiming new provider observations. Neither those getters nor
later live refreshes reset the original deadline or request counter.

Local tests cover inert provider simulations, signature encoding association,
actual default-transport budget enforcement, bounded same-job handoff, stage
history association, and actual Git source materialization when its admitted
fixture runs. These are separate from a genuine protected publisher invocation.
Actual provider, native, signing, public updater journey, and final candidate
completion evidence remain outstanding until the selected setup and applicable
execution grants are fulfilled. The post-publication ordinary client journey
cannot be inferred from immutable Release presence or Pages byte identity.
