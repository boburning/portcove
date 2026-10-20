# Payload phase control connection

This is held controller implementation for #534. It does not admit a release,
access a real signing key, activate a workflow or grant publication authority.

The existing admission acquisition now offers its trusted continuation a detached,
recursively frozen facts view. The original facts stay private in that same Node
process. Payload preparation uses that continuation to authenticate the uploaded
aggregate, associate the existing reservation, check the independently configured
public key and materialize both exact updater payloads before emitting readiness.
Its readiness digest binds those derived requests and the acquired facts.

Admission and payload use distinct fixed reader/observer jobs, OIDC audiences,
immutable artifact names and phase fields. The payload observer waits GET-only
for payload readiness before obtaining the existing isolated observer App token.
That token never enters the payload reader. The original acquisition process then
obtains fresh payload-phase controls and performs its existing final source,
artifact, qualification, reservation and control readbacks. A source or artifact
proof from another phase cannot satisfy this boundary. Serialized facts cannot
recreate a runtime source brand.

The standalone payload fragment remains outside `.github/workflows`, with both
jobs literally held. The missing fixed configuration producer and real eligibility
evidence remain gates. The artificial `payload-signing-positive-admission-not-connected`
hold is removed because this phase now connects the real late-control path;
existing publication-history, compiler/execution, strict SBOM, native, resource
policy, protection/custody and production-grant requirements are preserved. No
real signing continuation or key release is claimed. Site and immutable-release
publication profiles reserve separate fixed names only; their jobs are not
implemented here. A site-phase source additionally exposes `readMaintenance(api)`:
this reuses its private expiry/protection guard and stable isolated observer job
readback, then authenticates only pause and ratified capacity against the observed
pause ref. It needs no classification record, release opportunity or candidate.
The result is explicitly metadata renewal with no authority; a pause remains an
observed pause. Other phases cannot invoke that purpose. Site execution and
published-metadata integration are separate work.

The final complete workflow digest/resource policy must still
be reconciled within the existing 100-minute ceiling.

The ordinary `Release handshake process fixture` workflow is credential-free.
It keeps random fixture facts in one background Node process across an actual
fixed upload/download artifact round trip, verifies its commitment and process
settlement, and retains tiny immutable artifacts for seven days. The fixture
process has a 45-second deadline; result checking has a 10-second bound. No App,
signing, OIDC, production environment or manual dispatch is used. Local tests prove
only the inert fixture protocol. Hosted process lifetime remains unproven until
the exact delivery workflow runs successfully; even then its result is fixture
evidence, not semantic review, issuer/protection acceptance or production evidence.

## Actual ordinary hosted fixture

Delivery source `abe26a79553c647fa4c3d28cc14b168f1222f637` passed
[run 39469343548, attempt 1](https://github.com/boburning/portcove/actions/runs/39469343548),
job `118788989107`. The same background process retained its private sentinel
through actual upload/download and settled. Ready artifact `12285819317` has
provider digest `2a102241c1d5ded6ff250f5d65407419b15c664597835b58abeca7a446e41259`
(276 bytes). Result artifact `12286062408` has provider digest
`89a3d09c83ae7f3f828ab75309717b37981edfb8f63904f5a1ea5b999b32247f`
(1189 bytes); retained `qualified.json` reports the same ready identity,
`process_settled: true`, fixture scope and `authority: none`. The five required
contexts passed at that source in CI `39469343474/1`. Subsequent target composition
retains these actual source identities; final delivery CI remains independently
bound to its own source head. This is process-lifetime fixture evidence only.
