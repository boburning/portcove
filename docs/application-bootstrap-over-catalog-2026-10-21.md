# Initial application metadata over a catalog-only site

This source preparation adds a conditional initial application setup route. It does
not activate setup, appoint a Root, sign metadata, publish Pages, or establish native
or hosted acceptance. The existing whole-404 application bootstrap and catalog
bootstrap remain separate routes.

The application schema2 authority configuration uses its existing exact
`publication.public_source.initial_site_preimage` commit/path/bytes/SHA locator,
`initial_site_preimage_sha256`, and `setup_plan_sha256`. A catalog-only alternative
must be explicitly included in that ratified setup; an old whole-404 appointment
cannot adopt an existing catalog.

The alternative preimage has exactly these fields:

```json
{
  "schema_version": 1,
  "kind": "catalog-only-application-site-preimage",
  "evidence_scope": "github.com",
  "authority": "none",
  "origin": "https://boburning.github.io/portcove/",
  "observed_at": "2026-10-21T00:00:00.000Z",
  "application_history": "owner-ratified-no-prior-application-publication",
  "scope": "initial application setup over exact retained catalog; no unlisted URL absence claim",
  "pins": {
    "kind": "catalog-only",
    "root_sha256": "<exact accepted catalog Root SHA256>",
    "repository_sha256": "<exact accepted catalog inventory SHA256>",
    "site_generation_sha256": "<exact current complete-site generation SHA256>"
  },
  "provider": {
    "repository_id": 1354613114,
    "owner_id": 43177418,
    "url": "https://api.github.com/repos/boburning/portcove/pages",
    "build_type": "workflow",
    "html_url": "https://boburning.github.io/portcove/",
    "cname": null,
    "https_enforced": true,
    "public": true
  }
}
```

The declaration is historical owner-appointed setup input, not an observation
inferred from missing URLs. Every actual preparation also requires the same
journal's absent application seed/component, accepted catalog record, and exact
global cursor. The fixed reader acquires and rehashes the complete catalog-only
public generation, verifies no application entries, and brackets complete fresh
public bytes with the configured provider identity. These public bytes confer no
Root or signing authority. App Root, offline Targets and payload-registry pins
remain independently selected by the application configuration.

The new metadata context retains the exact preimage string and its descriptor-bound
SHA, explicitly tagged prior catalog pins, and deterministic fresh readback digest.
Existing attestation transport binds those facts; copied receipts cannot create
actual custody. Before online roles, the catalog prior must leave conservative
headroom for sixteen 1MiB application entries plus a 4MiB marker under the unchanged
6000-file/256MiB site bounds. Other context, phase, role and provider limits stay
unchanged. The sole site composer preserves every catalog byte; fresh full prior
readback and current journal guards precede the existing Pages effect. GET-only
lost-handoff recovery separately rechecks the setup source and exact retained
catalog component before recording the first application publication.

Focused source verification: six existing suites produced 37 PASS and two existing
optional Rust-tool SKIPs. The final added raw Git-object alternative-preimage path
also passed the bootstrap suite (6 PASS, one unchanged optional SKIP). Thirteen
changed TypeScript files passed type-aware lint before that final test-only
extension; its final check is retained with the candidate. Controlled fixtures use
disposable files and fixed-origin mocked HTTP, not genuine hosted/provider or Tough
admission. No accounts, keys, ACLs, repository settings, issuer POSTs, or Pages
publication were used.

Feedback retained in the authoring transcript: the first verification found one
error-message expectation mismatch; the next found the inert app fixture lacked
its required timestamp. Those fixtures were corrected without weakening assertions.
Initial lint also caught a no-longer-used local and later missing recovery locals;
the final checked source includes those repairs. No production timeout was changed.

## Follow-on pending and final-control repair

The existing metadata upload controller, like the catalog controller, must bind
its post-pending boundary before invoking the context getter. The new named
binder consumes only the actual executor's callback-lifetime private pending
receipt, validates the original checkpoint, exact metadata descriptor/destination,
empty effects, and pending outcome, then rechecks the actual snapshot and executor.
The effect's later bind is idempotent only for the same executor object, checkpoint
and operation ID. Imported or expired callback receipts remain refused.

Metadata context and TUF controller guards now perform their final maintenance
check after slow state/custody reads. The shared isolated signer retains the first
pre-key guard and all subsequent input/tool/dependency tamper checks, then repeats
the appointed guard and original deadline check immediately before key material.
No role, budget, retry count, clock lifetime or acceptance authority is expanded.

The follow-on three suites passed 28 checks with one unchanged optional Rust-tool
skip; seven changed TypeScript files passed type-aware lint. The pending regression
uses the actual maintained capacity operation and a disposable bare Git journal,
with actual callback/binder/private-guard source in an inert VM. Its VM receipts
are not hosted authentication. Clock regressions exercise 59→61 seconds and an
original signer deadline crossing, requiring zero key access. Earlier fixture
feedback included a string-literal syntax error, stale declared publication time,
and a missing VM structuredClone builtin; these were repaired before the passing
candidate. An unnecessary test assertion was removed after type-aware feedback.
