# Slice 4 managed catalog publication integration — 2026-10-21

Owners: [#246](https://github.com/boburning/portcove/issues/246) and
[#534](https://github.com/boburning/portcove/issues/534).

The managed-definition client existed, but its production publication contract
had no callable publisher. This change connects an inert Core inspection command,
a separate Tough catalog publisher, the existing coordinator's bounded effects,
and component-preserving whole-site composition. It grants no publisher authority.

## Implemented boundaries

- `portcove --json catalog inspect-definition-publication DIRECTORY` validates
  the exact indexed definition/content/policy/launch closure through existing Core
  parsers before preferences or a Library is opened. The producer ceiling is
  16,385 files / 32 MiB. Empty index inspection is inert bootstrap preparation.
- The trusted controller tool build includes the ordinary Core CLI in its existing
  immutable manifest and attestation. The actual inspection wrapper copies inert
  bytes, runs only the fixed verified CLI without inherited credentials, retains
  output/failure evidence, and rechecks tool/input identity. Its receipt proves
  Core inspection only; its source context still requires authenticated
  materialization. Imported reports cannot mint a receipt or semantic acceptance.
- The Rust release tool signs separate `official-definitions`, `official-policy`,
  Snapshot and Timestamp roles, each with one appointed key. Offline Targets uses
  its own key. Keyless assembly authenticates the separate Root/Targets, all role
  signatures and target bytes with Tough, preserving historical bytes and semantic
  revision floors across removal/reintroduction. Re-encoded same-version metadata
  and physically aliased keys refuse. No private production key was supplied.
- Explicit catalog subjects use the existing exclusive executor, pending intent,
  remote CAS, completed effects and bounded recovery. They do not allocate an app
  version or clear unrelated holds. Durable catalog facts and the shared site
  cursor advance atomically. App/catalog records retain their own publication
  provenance; a global cursor records which complete site is current.
- Whole-site schema 2 supports independent component roots and catalog-only inert
  composition. Each component update preserves the other's exact bytes and its
  own immutable targets/versioned metadata. An unappointed legacy catalog subtree
  refuses catalog replacement. Existing schema 1 app markers remain readable.
  Site limits remain 6,000 files / 256 MiB, separately tighter than historical Rust
  closure limits. Composition and HTTP custody are not Tough or publisher admission.

## Focused evidence and retained failures

Independent component review covered Core inspector, publisher/key/history
repairs, tool inclusion, catalog subject/executor, component cursor and site
composition. Final PR review and hosted checks remain separate delivery gates.

The original source-bound Rust qualification at `4f68685fd35d4dfcda37bfe438afef14d9e1517a`
passed six Core and one CLI contract tests. The first publisher check failed to
compile against Tough's concrete borrow/stream types. The narrow repairs at
`473ab04e2af1444f331d6ac86900a8267563f13c` passed eleven publisher tests; the final
Unix directory-mode correction at `f4511bd96cd35052579814e0ff6032ec2bfc772f`
was independently reviewed. Original failed log SHA-256:
`0953ebed2f69dec76a462914a7de552fa02fceac56839c64b2e8ee8998fc0fe3`;
passing publisher log: `8fb3931c3bdb3168b23f34c2b5398759caa5c3875497ecca469028fa2d456d86`.

Connected test `30fc5bb44f8c36aa7668b24d6a692bfc99bd479c` ran against integrated
source `131e8da0cdd26a8ec007a2483c155c07586d58f6`: one passed, zero failed,
zero ignored. Matching built binaries were the actual CLI
`9b7b8a1e526fb61c59a55fdfa7a285a6be442af03469803ee849ca2fb3dd0b4b`
and release tool
`f5d72f35835355a88d8d6535d1361e24ba23393bd66aacba96f67633d244b1c3`.
It exercised a nonempty definition bundle → actual CLI inspection → four isolated
role signatures → keyless Tough assembly → actual Core candidate/policy consumer,
then a signed revoked-policy correction, replay floor, immutable history and
byte-tamper refusal. The test first observed missing publisher authority, then
used only the existing test authority boundary. Result receipt SHA-256:
`135d21985fc4c77671fab63bdc1a1a12961589c6d5987a770139127df47397bd`;
connected log: `6da71f80ada048a18c4dc1ece1ee1bf254075a1fe0ceb582c3cae1c65cb1cdd6`.
This is disposable cryptographic/consumer evidence, not the ordinary-client,
real-game, native, protected acceptance or publication journey.

The catalog cursor/executor checks passed 33 focused cases at their applicable
source scopes, including real Git pending/publication/import. One test initially
misused the retained-object exporter; its exact-object fixture was repaired and
passed. The first site union produced 36 passes, five negative-message failures
and one platform skip. All five refusals still occurred; caller error context
was restored. The affected site/inspection checks then passed 25, failed zero,
with one existing platform skip. A prior queued invocation refused source drift
before executing. Those outcomes remain retained under `work/slice4`.

## Cold-build measurement and bounded repair

Ordinary hosted fixture `39626936673/1` passed functional checks on synthetic PR
merge `f1d21e6958be023c8d820a308e7780262fe1fec8`, tree
`c4b0d39d2413af34ab2c9cf52dc7c80a56516c82`, exactly the tree of reviewed source
`b96688ce08c58dd6b22a422beb6ec040414e6e75`. Artifact `12357532158` had digest
`16454bb4b15f9ef7cea48dc4b7f115190031baae55f7118c766c62e8f257158b`.
It measured 266,714 ms for the cold build and 211,643,056 expanded tool bytes,
including the 39,751,968-byte CLI. The archive fits, but that build exceeds the
four-minute production tool job. Functional PASS is not timing acceptance.

The tool-only `controller-tools` Cargo profile inherits release behavior with
optimization level 1; the shipping release profile, features, dependencies and
lockfile are unchanged. The fixed single locked build uses that profile for both
helper binaries. The ordinary fixture now refuses a measured cold build over
210,000 ms, reserving thirty seconds inside the existing four-minute proposal for
setup/upload. This is a preparation allowance, not an observed guarantee of a
future complete job or operation availability. The declared 99-minute estimate,
100-minute hard ceiling, cache/archive/concurrency and seven-day limits remain.
New hosted measurement is required before claiming fit. Node 24.22.1 from #2348 is
reconciled with CLI inclusion, current workflow pins and isolated tool imports.

Three focused recipe/inventory/environment cases passed. The fourth initially
rejected the formatter's trailing comma in a source-owned argument array; its
strict JSON literal guard was repaired and the affected case passed, with no
recipe or runtime assertion removed. Both outcomes remain retained.

## Work still required

This foundation does not activate a catalog controller. Authenticated whole-catalog
semantic input/capture, actual protected catalog configuration and handoff, final
same-controller signing/publication glue, current-site app continuations and
bounded DAG/resource estimates remain integration work. The enhanced ordinary
Linux tool-build fixture must establish the repaired cold-build allowance fit;
debug build timing cannot prove the existing four-minute production bound.

The application setup proposal remains pinned to its reviewed source. These new
source/tool/native changes require source/digest/resource/#706 reconciliation
before a replacement runnable grant; they are not silently adopted by that grant.
Actual catalog Root/custody/delegation/protection identities, producer output,
eligible reservation and corresponding protected authority remain unobserved.
No recurring UAC/VHD step was added or executed. Capacity availability/headroom
remain Unknown, with bounded-attempt eligibility and no capacity reservation.

#254 remains Done; #315/#534/#246 acceptance remains pending. Chameleon protected
acceptance remains unset. #144 stays outside the compiled catalog and its failed
.35/.36 and unrepaired .42/.43 evidence remains at its actual scope. This test
supplies no repaired release-artifact pair. Production remains held; slice 5 is
excluded.
