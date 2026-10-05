# External-location fixture catalog boundary — 2026-10-05

This bounded #992 change replaces the private `service.rs` external-location
fixture's extra live-catalog clone with an independently declared, one-port,
source-free schema-2 catalog. It changes tests only. The real
`service_with_release` bootstrap still loads the production catalog and performs
service recovery before replacing its test catalog.

The previous helper cloned the Zelda definition, appended a synthetic port to
all current definitions and source contracts, serialized that graph, and parsed
it again. None of its three callers asserts unrelated title or source facts.
The replacement preserves the current platform, stable channel,
`n64-recomp-portable` adapter, exact inert runtime/tree inspection, executable
hint, and sole mutable `player-save` path. Production preview, authorization,
registration, readiness, launch preparation, retained-definition and removal
paths remain under test. No executable is run by these cases.

The three original cases and every original assertion are retained:

- Missing executable holds launch, preserves registration and player data, and
  recovers after restoring the same bytes.
- Removing the sole current port retains the registration; a missing external
  root holds launch and remains removable without claiming file deletion.
- A replacement registration cannot validate a stale status snapshot.

The added independence control checks the sole synthetic definition, empty
source authority graph, absence of a real Zelda definition, and ordinary
registration readiness. Against the old helper, the guarded focused run reported
three existing cases passing and this control failing: 81 ports and 327,978
serialized bytes versus the required single port. With the replacement, all four
cases passed and the authoritative document was 1,579 bytes. One representative
fixture setup was 169.427 ms before and 163.636 ms after; focused execution was
0.703 s before and 0.386 s after. These individual observations are noisy, not a
benchmark or a whole-suite speedup claim. The deterministic reduction is the
extra graph's 81-to-1 port count and 326,399 fewer serialized bytes. The real
full-catalog bootstrap remains deliberately covered.

Within the replacement-catalog preparation only, the full authoritative-document
clone count changes from one to zero. Explicit catalog serialization and
`Catalog::from_json` calls each remain one before and one after; their input
changes from 81 ports to one. Service bootstrap and later retained-only and
retained-record parsing remain. This is a smaller graph, not fewer total parser
calls across the lifecycle.

The finite boundary is this one fixture family. Catalog policy/index/projection
families retain their real definitions because they assert production
capabilities or the actual graph; generic malformed-definition and runtime
families already converted elsewhere are not replayed here. Basic real
OpenNectar/OpenGoal preparation coverage remains intact. Other fixture families
are deferred until a distinct dependency or measured cost justifies a bounded
conversion. This slice does not close all of #992, alter test selection or any
protected acceptance policy, or establish native, runtime or gameplay evidence.

The first invocation failed at shell filter quoting, and the second supplied a
redundant `--locked` already owned by the wrapper. Both stopped before tests and
are preserved separately from the actual causal red/green results. The corrected
command uses the existing storage and validation guards:

```sh
node scripts/dev-storage.mjs run -- node scripts/local-validation.mjs test-rust \
  -p portcove-core -E 'test(external_location_)' --success-output immediate
```

Cloud used the owned warm target with session-local
`CARGO_TARGET_DIR=/workspace/portcove/target`, pinned tooling, no concurrent native
or Rust worker, and the unchanged 20 GiB storage floor. There is no scheduler,
cache copy, upstream execution or resource-policy change.

The complete selected Cloud run passed whitespace, Rust formatting, seven
repository documentation contracts and all-target warnings-denied Core Clippy.
Its complete Core inventory ran 1,203 tests: 1,191 passed, 12 failed, one platform
skip (487.750 s). All four external-location cases passed, including the five
empty-source-authority assertions. Each failure was an unchanged first-party
launcher fixture's `rustc` child trying to create `/home/agent/.rustup` on the
read-only filesystem, followed by the existing `status.success()` assertion.
That denied action was stopped without a writable-home, PATH or direct-compiler
reroute, bootstrap retry, skip, or source/gate change. This is preserved failed
selected evidence; it does not qualify the complete Rust obligation. Remaining
acceptance belongs to an admitted compatible Local/hosted route, with exact
candidate identities and original logs transferred separately. No second waiting
PR is opened while the existing reviewed #1539 remains pending.

After PR #1539 delivered at `879db2d61a9bd7e76a0c2e633dd3c8a94ac94494`,
its waiting-slot condition cleared. This candidate adopted that delivered main
as its comparison/source base solely because the existing fixed hosted selected
route requires the trusted current controller/authority to be ancestral to the
base and unchanged in the source. The fixture code and original assertions are
unchanged from the preserved `2eb2519` checkpoint. Separate source-delta review
and complete validation on the admitted compatible route remain required; the
original denied Cloud run is retained as failed evidence, never reclassified.
No compiler/home/PATH reroute, validation policy or workflow change is made.
