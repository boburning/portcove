# Initial application metadata preparation

This prepares the selected initial empty feed. It grants no setup, credential,
signing, publication or protected execution authority. The conditional setup
must first establish the public anchors, configuration and provider facts.

Schema2 publication configuration can pin an `initial_site_preimage` file under
the existing immutable public-source commit. Its exact path, bytes and SHA256
must match the separately ratified preimage digest and remain distinct from
Root, offline Targets and the payload-key registry. Schema1 is unchanged. The
coordinator reconstructs the complete bounded Git tree and verifies raw blob
identities before using those files. The existing 128KiB Git-object limit applies.

The pinned preimage records the owner's earlier full-visibility observation. It
is **historical owner-ratified setup evidence**, not a fresh owner API result.
The routine coordinator receives no owner credential. After Pages configuration,
it checks the fixed repository/owner IDs, workflow build type, canonical Pages
URL, public visibility, null custom domain and enforced HTTPS. It brackets four
fixed public routes with that configured-provider readback and requires every
route to remain 404. It does not reassert owner-wide user-site absence. Unexpected
provider state, redirects, unavailable routes or existing content hold the path.
The [Pages API](https://docs.github.com/en/rest/pages/pages#get-a-github-pages-site)
supports the separate Pages read permission; actual configured field availability
and provider behavior remain conditional setup observations.

The fixed `inspect-tuf-bootstrap CONTEXT` command reuses the maintained public
context loader to verify Root and offline Targets signatures, expiry, role/key
constraints and the exact initial descriptor without reading a private key. The
Node preparer runs a copied hash-qualified tool in a scrubbed environment, checks
its report against all retained bytes and rehashes the private preparation on
use. Its six public files contain no previous repository: `context.json`,
`initial-bootstrap.json`, `trusted-root.json`, `offline-targets.json`,
`payload.json`, and the empty `records/reconstruction-manifest.json`. Online
versions start at one, offline Targets stays unchanged, Stable remains empty,
and expiry stays within the offline anchors and existing role ceilings.

The actual coordinator constructor additionally requires its fixed reader/job,
protected configuration, current maintenance controls, actual verified tools,
fresh configured-site observations and the exact existing journal checkpoint.
It preserves active reservations, neutral requests and recovery counters. It
refuses unresolved effects, and published metadata permanently closes initial
bootstrap. The frozen descriptor is recorded through the existing checkpoint CAS;
the private getter retains its original 170-second budget and one finite control
round allocator. Public JSON and hashes cannot construct that private session.
Bootstrap and Pages recovery first publish and consume the fixed ordinal0
readiness/observation, matching the existing ordinary and renewal paths. Later
control rounds begin at one; no path skips the composite's initial wait.

The signing-context consumer must join this separate bootstrap session to the
existing journaled context upload and five isolated role jobs. That join is
separate from the existing renewal session and must not fabricate a prior feed.
Local raw-Git/provider simulations, pure binding tests and disposable-key Rust
tests do not establish a genuine configured coordinator or production acceptance.
