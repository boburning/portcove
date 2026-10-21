# Slice 4 owned publication result and feed binding

Owner: [#534](https://github.com/boburning/portcove/issues/534). This records
implementation and focused local verification. It grants no protected execution,
credential provisioning, signing, publication or custody change.

## Implemented integration

The existing owned immutable publisher now prepares a bounded public result only
from genuine settled publication, actual authenticated signing context, current
verified controller tools, the post-sign native pair and producer SPDX custody.
The result binds the exact controller source/tree/ref/run/job/check, full reviewed
record-context identity, candidate and recovery counters, original settled
operation and stable immutable Release/asset identities. Original signature
assets must match the authenticated updater records. Mutable readback evidence
does not change the stable immutable identity.

The fixed immutable artifact handoff uses the existing coordinator pending
operation and publisher executor. Its only additional destination is
`github-actions:boburning/portcove:<version>:immutable-release-result`; other
roles, repositories, effect kinds and suffixes refuse. Provider GET/readback
checks the original artifact ID, digest, source/run and exact bounded ZIP bytes
before constructing the unsigned custom predicate. The existing fixed
attestation action must still sign that predicate and exact report.

The receiver uses the existing GitHub/Sigstore verifier, exact pinned workflow
revision/ref/run, completed successful numeric publisher job/check, immutable
provider artifact readback and authenticated full signing-context association.
An overall workflow failure cannot erase a successful component; that observation
does not authorize recovery or another attempt. Injected test transports cannot
create a private actual-result receipt. The private getter rechecks retained
bytes, context, provider custody, the complete draft-inclusive Release inventory,
actual version tag and all exact immutable asset identities.

The new-release Pages branch no longer accepts Release presence or a serialized
success as its missing record-set join. It requires the private authenticated
result, actual verified current controller tools, the exact pinned Rust verifier
used for real keyless Tough composition, and equality of the complete logical
record-set digest. Before the existing owned Pages operation it also requires
the current promoting reservation, exact candidate/recovery/run tuple, namespace,
complete frozen opportunity, current executor and fresh controls. Maintenance
and new-release subjects cannot be mixed. Complete prior-site preservation,
single-POST ambiguity handling, public readback and durable metadata handoff
remain in the existing publisher.

Downstream phase deadlines permanently tighten both retained result and signing
context readers, including their live provider closures and complete Release
pagination. They cannot extend an earlier budget. The site reuses the context
snapshot already verified within each result readback instead of repeating its
provider traversal. The final callable's finite read count and phase timing still
require integration qualification; there is no unbounded counter reset.

## Verification and review scope

Implementation bases: `11a6a38fbe98858d637ad46d0c949efe077e7158` (owned result),
`2eefb90960b02550153215b335e939ac901afbc3` (transport),
`2df225a2b288359da3b9eeaf1c5e72c00d52515f` (feed join),
`1f093fa5907702818e9cba80ff0f68ede0ea55cc` (deadline repair), and `be425bf`
(same-read context reuse).

Separate non-writing review cleared the owned report, transport and feed
identity/custody checks. Review found a P2 where a result reader could retain a
longer deadline than its site caller; the intersection repair was independently
cleared at `1f093fa5907702818e9cba80ff0f68ede0ea55cc`.

Focused local results:

- 13 tests passed for report association, bounded archives, imported-proof
  refusal, early provider refusal, narrow executor scope and phase history.
- 22 tests passed for immutable Release transitions/readback/refusals, result
  association/transport and Pages archive/session behavior.
- After the deadline repair, 13 tests passed for result deadline arithmetic,
  bounded transport, context/verifier budgets and Pages archive/session behavior.
- Affected typed lint and formatting passed. Initial test typing failures
  (unchecked Buffer index, mock header Map and un-narrowed JSON) were repaired;
  an initial site typed check found the missing maintained file-reader import,
  which was added. These are not runtime or protected-positive results.

The retained original review finding and passing repairs do not establish a real
publisher attestation, production provider write, protection enforcement, public
feed deployment or ordinary-client journey.

## Remaining integration

The fixed Release callable, five isolated role callables, complete default-branch
wake/DAG, actual native worker execution and final public journey/completion
integration remain separate work. This result handoff is one stage, not closure
of #534. Actual setup, credential/public-key custody, eligible reservation,
observed protection evidence and the final reviewed runnable revision/digest
must be bound in the consolidated initial setup procedure before activation.

D1/D2/D3 remain selected. Capacity remains eligibility for one bounded attempt
inside the ratified no-spend boundary; availability/headroom are Unknown and no
capacity reservation is claimed. No recurring admin path is introduced.
#254 remains Done; #315/#534/#246 acceptance remains pending; Chameleon protected
acceptance remains unset; production remains held and slice 5 is excluded.
