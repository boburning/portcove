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

## GET-only continuation follow-up

The promoting native branch now calls the named configured completion collector.
Its source, actual TUF/context custody, native Check issuer and package identities
remain mandatory. Only the exact promoting reservation uses this collector;
ordinary aggregate and signing paths still refuse that phase. The controller
brackets selection with the acquired checkpoint, and the collector independently
checks its reservation before and after reading the issued Checks.

Pages deployments now use the complete site generation digest as their unique
build version and require the acknowledgement ID to equal that version. The
[provider contract](https://docs.github.com/en/rest/pages/pages#create-a-github-pages-deployment)
documents a unique build version and shows the matching deployment identifier.
Actual provider mapping remains a conditional setup qualification, not a result
of the inert transport tests.

`recoverPendingPagesPublication` consumes the existing journal's exact
`site_expectation`, never a replacement local pending file. The existing owned
coordinator recovery verifies the original publisher is terminal and brackets
the exact remote checkpoint. The reader requires provider success, complete
journal-pinned public site acquisition including catalog bytes, and provider
success again. It retains the real opaque custody receipt separately from the
verified public projection. It performs no Pages POST, cancellation or retry;
missing, failed and 404 status never establish that no effect happened. Existing
completed receipts cannot be overwritten.

This resolves only the existing effect/readback intent. Tough verification,
published-metadata handoff, ordinary public journey and final candidate completion
remain separate obligations. Local tests include the real default full-site
materializer with controlled credential-free public responses, opaque receipt
readback and refusal after retained catalog mutation; they do not establish a
live deployment or production acceptance.

## Coordinator wake and verified publication handoff

The default coordinator wake now selects a durable pending Pages expectation
before waiting on semantic or native work. Its independent coordinator verifies
the original publisher is terminal, reads the exact expected provider/public
generation, and settles the existing journal intent. A settled expectation with
a missing published-metadata handoff remains discoverable on a later wake.

With the actual verified controller tools, the continuation materializes the
complete public site and runs the maintained Rust/Tough verifier against the
journal-pinned root and component. The handoff records the authenticated
**current** feed versions, expiry, records and metadata digests; the verifier's
unused next renewal plan is retained but never signed or published. The existing
owned journal helper rechecks the original terminal publisher and exact current
checkpoint before recording that state. An expired feed refuses this ordinary
verification path; no expiry bypass is introduced.

The combined recovery uses at most four fresh coordinator control rounds within
the original 170-second job budget. It issues no Pages POST and does not repeat
the Release effect. A failure after effect settlement leaves that settled intent
available for the next GET-only handoff attempt. Applicable public client journey
and durable candidate completion remain pending. The local association and
refusal tests do not establish a genuine protected provider invocation.
