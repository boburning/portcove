# Immutable signed-fixture work profile, 2026-10-26

Audit36 of [#2420](https://github.com/boburning/portcove/issues/2420) calls for measured reuse within a fixture while retaining fresh revision and trust boundaries.

`IndexedCatalogFixture` already retained serialized catalog-projection bytes, but each revision hashed both that stream and its fresh entry four times. The fixture now hashes its private immutable projection once at construction and each fresh entry once per revision. Index and entry serialization, returned byte ownership, signing, revocation and state admission remain fresh. No filesystem or process-wide cache is introduced.

## Paired observations

On one WSL Linux x86_64 host with Rust1.99.1 in the test/debug profile, the maintained implementation and a byte-exact frozen preimage ran in one guarded test binary. Five samples each constructed both fixtures and compared16 successive revisions, alternating which implementation ran first for each revision. All80 pairs matched exact index bytes and every content name/byte. Equality assertions ran outside the measured phases.

The782,938-byte projection was identical for the paired inputs. A preliminary unchanged-versus-unchanged control measured median revision totals of1.127s versus1.132s, a0.4% difference. After reuse, median constructor-plus16-revision totals were1.165s for the frozen baseline and54.720ms for the candidate, a95.3% reduction for this bounded operation. Candidate construction includes the one-time digest: its median rose from the baseline32.648ms to49.250ms. This is fixture-construction evidence, not whole-suite or Windows performance evidence.

[The structured packet](testing-audit-immutable-fixture-cost-2026-10-26.json) preserves all samples, nanosecond phases, source/preimage hashes and limits. The baseline fixture source hash is `c7f0aef1735457a16919ed25725d96606ac22c8d552f1cef7fc5e68dd37479af`, taken from source456263bb550eed4d35ba24247c826eba23611920. The dirty temporary experiment is identified by its source hash rather than presented as a clean final candidate.

## Validation and limits

The existing fixture/repository consumer cohort passes147 tests on Linux, including fresh revision, publisher, revocation and recovery assertions. Separate controls exercise same-length valid-JSON mutations of both returned content streams, returned-index isolation and a different catalog's identity. Final candidate CI is tracked in the owning PR.

The first absolute-include probe failed compilation because its relative fixture paths resolved outside the crate. That failed log is retained; the repaired local baseline retained the exact original bytes. The duplicated preimage module and profile test were removed before delivery. Compilation, resource queueing and equality checks are excluded from timing. Constructor ordering, host/cache variation and the single debug-build environment limit generalization. No signing, installed/native acceptance or whole-suite speed claim follows from this profile.
