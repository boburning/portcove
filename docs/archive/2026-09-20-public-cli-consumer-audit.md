# Public CLI consumer audit and responsiveness evidence

Date: 2026-09-20
Audited baseline: `cafce9adc1ec8e5949e4fe151b94ab8a7e6d83ef`
API compatibility window: 42–51
Operation-event schema: 2

This is dated completion evidence for [#30](https://github.com/boburning/portcove/issues/30),
not a second protocol or roadmap authority. The current contract remains the generated
schema, `capabilities` output, core types, CLI implementation and maintained public
documentation.

## Conclusion

The audit found no missing shared command or DTO that justified widening the public
surface. The existing surface provides the core-owned identity, catalog metadata and
artwork references, installation/readiness, requirements, eligible next actions and
stable reasons, update decisions, operation results, and launcher invocation data needed
by proportional launch-only, library, and lifecycle consumers. The remaining demonstrated
gap was evidence: the reference consumer did not record its process shape or representative
responsiveness. The candidate adds observable invocation accounting and repeatable
synthetic-scale plus real-CLI measurements without adding a daemon, cache, private-state
reader or per-port branch.

## Advertised command audit

The table covers every command name in `CapabilityDocument::current()`. A command being
advertised does not make it mandatory for a narrower consumer. The maintained reference
negotiates only the rows it uses and leaves other authority with Portcove.

| Advertised command | Public consumer purpose and authority | Existing contract evidence |
| --- | --- | --- |
| `auth` | Explicit credential lifecycle; never inferred from library or product identity. | Machine envelopes, typed errors and documented noninteractive boundaries. |
| `backup` | Core-owned saved-data backup, restore and recovery. | Exported schemas and machine-contract recovery fixtures. |
| `artwork` | Local artwork state/import/repair/clear with explicit ownership and consent. | Schema-44 exports, structural checks and CLI fixtures. |
| `catalog` | Batched discovery and exact catalog metadata, requirements and provenance. | Exported catalog schemas; compiled reference refresh consumes the batch. |
| `catalog.check-capabilities` | Compare a definition request with installed engine contracts without granting admission. | Schema-45 report/request fixtures and generated schemas. |
| `source` | Core source profiles, verification, relink, search and registration. | Typed machine results, stale-state/locking tests and failure-isolated batch capability. |
| `tool` | Inspect/configure optional preparation tools without moving authority into a client. | CLI schemas and preparation fixtures. |
| `status` | Batched or per-port installation, readiness, restrictions, definition decisions and recovery state. | Generated status schema, CLI/Tauri parity checks and strict reference-client consumers. |
| `activity` | Durable operation readback, bounded diagnostics and schema-51 completeness/classification. | Positive, legacy, missing and contradictory feed fixtures. |
| `cancel` | Request cancellation of a known operation ID; acknowledgment is not terminal success. | Event/result fixtures plus real concurrent cancellation/readback qualification. |
| `storage` | Read effective storage state; no client ownership of cleanup or migration. | Generated machine result and CLI contract tests. |
| `library` | Explicit library selection, move/copy/import/export and related review/recovery flows. | Generated schemas, stale-plan fixtures and managed move/import identity evidence. |
| `library.identity` | Opaque stable library ID and effective root. | Collision-safe game-key fixture, reconnect checks and move/import identity tests. |
| `doctor` | Core-generated diagnostics and supported repair actions. | Required by full lifecycle negotiation; retained-preparation parsing rejects unknown repairs. |
| `about` | Product/build information only; never a compatibility authority. | Machine result contract; consumers negotiate schema/capabilities instead. |
| `plan` | Read-only exact install plan for review. | Machine schema and stale/review-bound execution tests. |
| `preparation` | Review and run core-owned source/tool preparation. | Event schema 2, plan fingerprint and lifecycle qualification. |
| `preparation.cleanup` | Preview/apply exact retained-preparation cleanup under consent. | Schema-48 inventory/fingerprint positive and fail-closed fixtures. |
| `paths` | Launcher-ready program, argument-array, working-directory and explicit library handoff. | Generated response contract and literal Windows argument delivery tests. |
| `check` | Read update eligibility for one port or a failure-isolated batch. | Batch capability plus channel/provider machine-contract tests. |
| `reconcile` | Apply stored update policy without a client duplicating policy. | Failure-isolated batch contract and lifecycle tests. |
| `install` | Explicit install mutation. | JSONL operation/result contract, consent and integrity fixtures. |
| `adopt` | Review and adopt an existing tree without treating a selected path as proof. | Preview/apply stale-state and preservation fixtures. |
| `ensure` | Return an existing active install or install when absent. | Two adapter shapes through the same compiled consumer. |
| `update` | Explicit update/stage operation. | Success, checksum failure, missing artifact and recovery qualification. |
| `verify` | Verify active immutable installation state. | Typed machine result and corruption fixtures. |
| `activate` | Promote an exact staged version transactionally. | Core/CLI lifecycle and rollback fixtures. |
| `rollback` | Activate the retained rollback target. | Stable identity and lifecycle fixtures. |
| `remove` | Explicit destructive removal with noninteractive consent. | Consent, locking and persistence-preservation tests. |
| `channel` | Read/change the selected update channel under core validation. | Typed channel schemas and stale/invalid selection tests. |
| `policy` | Read/change stored update policy under core validation. | Generated schemas and policy lifecycle tests. |
| `exec` | Raw supervised game process with literal arguments and exact save collection. | Raw-stream capability, argument test and launch-session contract. |
| `launch` | Namespace for durable caller-known launch records. | Generated launch schema and strict identity/phase/outcome parsing. |
| `launch.show` | Read one exact retained launch request; null is not success. | Schema-42 positive, absent, wrong-identity and unknown-value fixtures. |
| `launch.recover` | Explicit exact-identity recovery after supervisor loss. | Schema-49 capability/contract tests and documented fail-closed cases. |
| `capabilities` | Negotiate API/event schemas, commands, formats, batches and locking. | Schemas 42–51, missing/contradictory capabilities and future-schema rejection. |
| `schema` | Export authoritative public schemas for binding/conformance generation. | Drift checks against Serde/Tauri/TypeScript definitions and package entry tests. |

`output` is a human presentation preference command and is intentionally absent from the
machine capability list; it is not a lifecycle or transport contract. `exec` is intentionally
the only advertised raw-stream command.

## Consequential contract consumption

- Launch-only negotiation requires only `capabilities`, `status`, `library.identity`,
  `launch.show`, raw `exec`, and JSON. It does not require catalog or lifecycle mutations.
- Library negotiation requires only capabilities, batched catalog/status, stable identity
  and JSON.
- Lifecycle negotiation additionally requires source/status/activity/cancel/doctor,
  identity, ensure/update/preparation/cleanup, JSONL, and event schema 2 where advertised.
- Unknown API schemas, event schemas, launch phases/outcomes, definition operations,
  eligibility outcomes/reasons, cleanup formats and activity classifications fail closed.
- Missing final results, exit/result disagreement, gaps, malformed/oversized output,
  invalid UTF-8, stale identity, busy-port conflict and cancellation never fabricate success.
- Reconnect reads durable activity and current state. It never automatically replays an
  unconfirmed mutation.

## Representative measurements

`just playnite-check` built the .NET Framework 4.6.2 consumer and current standalone CLI,
then ran the complete compiled fixture and real lifecycle qualification on this Windows x64
host. Elapsed values are observations, not cross-machine service-level promises.

| Path | Library size | CLI processes | Elapsed on this host | Boundary |
| --- | ---: | ---: | ---: | --- |
| Connect (synthetic local executable) | 256 ports | 2 | 289 ms | Capabilities plus library identity. |
| Warm refresh (synthetic) | 256 ports | 3 | 440 ms | One catalog batch, one status batch, one identity recheck. |
| Four caller-bounded reads (synthetic) | 256 ports | 4 | 152 ms | Maximum four concurrent commands; no hidden extra process. |
| Warm launch through first observation (synthetic) | 256 ports | 4 | 473 ms | Status, identity, raw exec and one `launch.show`; prepared fixture is network-free. |
| Cancel (synthetic) | 256 ports | 2 | 283 ms | Identity recheck plus one cancellation request; no replay. |
| Connect (real current CLI) | 77 ports | 2 | 393 ms | Current compiled schema-51 producer. |
| Warm refresh (real current CLI) | 77 ports | 3 | 1,120 ms | Artifact server was closed first; installed-state refresh remained offline. |

The durable process budgets are therefore independent of library size: two processes to
connect, three for a complete warm refresh, four from warm readiness through the first
launch observation, and two for cancellation. A cold launch-through-first-observation adds
the two-process connection, for six total. The Playnite reference performs one sequential
`launch.show` process per 750 ms observation interval and starts no overlapping poll. Its
caller owns concurrency; the representative parallel check caps it at four.

Latency remains environment-dependent. The safety bounds stay explicit: read processes
have a 45-second timeout, exited-process pipe drainage has a five-second bound, mutations
and game supervisors are not killed by a read timeout, and missing terminal evidence
requires durable readback rather than replay. A future tighter latency budget requires
measurements on the target host class; this evidence does not justify a resident daemon.

## Qualification and limits

The focused run passed 99 compiled consumer checks. The real-CLI lifecycle run additionally
covered two distinct adapter shapes, install/update progress, busy-port conflict,
cancellation, checksum and missing-artifact failures, recovery updates, exact durable
activity correlation, selected-definition eligibility and publisher revocation. Its final
offline measurement returned all 77 catalog/status rows with the artifact server stopped.

The standalone package smoke contract identifies extracted CLI bytes, checks product/schema
capabilities, explicit library provenance, raw `exec`, `launch.show` and `launch.recover`.
This audit does not claim a published release, Playnite marketplace package, gameplay,
physical device, novice comprehension, production publisher, signing key or feed.
