# Active port rollout maintainability audit — October 26, 2026

Source-bound maintenance evidence for [#2926](https://github.com/boburning/portcove/issues/2926),
under product parent [#2510](https://github.com/boburning/portcove/issues/2510).
Initial main was `9cb0c1f286d42ad856023eac0c62f2e85df0e435`; the safety repair
delivered in [PR #3742](https://github.com/boburning/portcove/pull/3742) as
`ad9e11a721fbcf2a0c61e1820c8f85d8fac551ec`. This dated audit is evidence, not a
rollout inventory or live planning authority. The delivering PR owns final
source/check/review/merge receipts for the accompanying consolidation and tests.

## Findings and dispositions

| Severity | Demonstrated finding                                                                                                                                                                                                                         | Source and disposition                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Historical NativePortable install journals with `activate=true` bypassed the retained-data preflight used by normal installation. Compatible recovery could omit edits made after staging; incompatible retained coordinates could activate. | `recovery.rs::recover_published_install` now uses the existing `persistence::collect_before_first_launch` classifier. #3742 preserves NativePortable's lack of a restore-receipt requirement while applying its existing transition and immutable-byte guards.       |
| High     | An explicit preparation record could replace an existing listing and lose its authored acquisition restriction; lineage checks did not cover this field.                                                                                     | `scripts/prepare-port.mts::preparePort` now refuses removal/change of an existing reason. Resolve the canonical condition through reviewed Git-authored source, rather than provider observations.                                                                   |
| High     | Authoring permitted a listing restriction beside a managed integration, whose separate acquisition route did not consume that self-service hold.                                                                                             | `scripts/catalog-authoring.mts::checkedAuthoredPort` refuses the contradictory shape. All 1,424 existing records remain valid: 45 restricted, 167 integrated, zero conflicting. No current port needed changing.                                                     |
| Medium   | Reuse, staged activation and recovery repeated the same ordered collect/check/restore/check/verify decisions.                                                                                                                                | Reuse and staged activation now call the existing recovery helper, renamed `prepare_retained_install_data`. Four production call sites share one implementation. Caller-specific transactions remain separate; rollback intentionally retains its directional guard. |
| Medium   | Seven Raze records repeated shared upstream/package/profile/update facts without an equality regression. Five Namco records likewise repeated common platform/upstream links.                                                                | The existing authoring test family checks those shared facts and rejects synthetic drift. Original-file instructions, identity/issues and independently scoped permission restrictions remain independent. No runtime inheritance or new authoring registry.         |
| Medium   | #2510/#2926 repeated large delivery histories and provider acceptance, making both current specifications costly to update.                                                                                                                  | Exact preimages were preserved in linked comments, current requirements assigned to the parent/rollout/port/PR owners, and guarded scoped rewrites/readbacks completed. Future component receipts have one owner.                                                    |
| Low      | Definition-delivery guidance still described completed client/observer/tooling components as active ownership without clearly separating production proof.                                                                                   | `ARCHITECTURE.md`, `CATALOG.md`, `DEFINITION-DELIVERY.md` and `SIGNED-CATALOG.md` credit completed #245/#254/#397/#398, retain #177/#247 ownership and leave #246/#534 production acceptance unfinished.                                                             |

## Lifecycle regression matrix

The authoritative decisions remain Core's installed contracts, installer,
persistence and existing operation interpreters. No schema, installed manifest,
consent, lock, journal phase or signed-publication contract changes here.

| Supported route                             | Applicable enforcement and evidence                                                                                                                                                                                                                                                                                                               | Disposition                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Fresh installation and preparation          | `service.rs::apply_scoped_release_with_shared` captures current qualification; `install.rs` verifies immutable artifacts/manifests. Preparation retains exact inputs and installed interpretation through `preparation_execution.rs`; source-change recovery refusals remain. No prior active runtime means no invented cross-version comparison. | Existing ownership retained.                                           |
| Managed N-to-N+1                            | `require_portable_runtime_unchanged`, `require_portable_transition` and staged-target verification precede publication. Source, executable, data environment and ownership changes refuse; ready archives permit only the authenticated empty additive expansion from #3704.                                                                      | Existing checks retained.                                              |
| Already-active artifact                     | The retained active qualification and bytes verify before returning; current catalog recommendations do not rewrite the installed contract.                                                                                                                                                                                                       | Existing idempotent route retained.                                    |
| Downloaded artifact reuse / retained target | `require_portable_target_transition` uses the target's actual retained definition. Shared preflight repeats compatibility after collection and restoration, then verifies immutable target bytes. #3695's refusals remain.                                                                                                                        | Duplicated sequence consolidated.                                      |
| Staged activation                           | Same retained-data preflight; `ActivationOperation` keeps its journal/commit/cleanup order and stale reviewed identities.                                                                                                                                                                                                                         | Duplicated sequence consolidated.                                      |
| Rollback                                    | `rollback_target` and `require_portable_rollback_transition` retain the stricter reverse-direction check; current declared data travels with the runtime switch. Saves are not rewound and old-reader compatibility is not assumed.                                                                                                               | Intentionally separate.                                                |
| Interrupted install/update publication      | `recover_published_install` repeats applicable retained-data preflight before activation, now including NativePortable. Already-committed metadata remains authoritative.                                                                                                                                                                         | Confirmed bypass repaired in #3742.                                    |
| Pending activation recovery                 | `recover_activation` validates the journal family and retained target, invokes shared preflight, then commits. Foreign identities and changed staged targets refuse.                                                                                                                                                                              | Existing #3695 protection retained; helper reused.                     |
| Backup and restore                          | `service/backups.rs` binds preview/consent to actual backup/current-data identities; retained persistence contracts and PSX/ready restore preflight precede canonical replacement. Timestamp/receipt safeguards and historical backup interpretation remain.                                                                                      | Existing #3704 guards retained.                                        |
| External-to-managed                         | `installation_route_change.rs` uses a separate fresh owned copy and exact external-registration fingerprint. External bytes are untouched; preexisting canonical data refuses rather than receiving an inferred migration. Recovery retains that intent.                                                                                          | Intentionally separate ownership transition.                           |
| Installed data/ownership changes            | `installed_mutability.rs::checked_port` admits only existing checked additive mutability without rewriting contracts. Ready-archive restore receipts cannot be reinterpreted through current paths. Historical readers retain their original behavior.                                                                                            | Existing constrained interpretation retained.                          |
| Removal and removal recovery                | `preview_removal` verifies managed runtime integrity and owned paths; the checked removal family binds quarantine/original paths and keeps persistent data. External deregistration does not delete external bytes. No replacement contract is being activated.                                                                                   | Existing invariants retained; no inappropriate activation check added. |

The reviewed preconsolidation oracle is source
`c7d71140ad51abde098c1954a6e913fc5d70b7ab`, including the existing Windows
`service::native_portable::tests` success/refusal matrix for update, staging,
rollback, empty expansion, artifact reuse, interrupted activation and committed
recovery. Its expected values were not regenerated from the consolidation.
The new six-case NativePortable publication test covers compatible recovery,
changed data/executable/environment contracts, and modified active/target bytes;
refusals preserve current/canonical data, manifests, both copies and the journal.

[#3742 CI 40437689191/a1](https://github.com/boburning/portcove/actions/runs/40437689191)
passed all five required source-head contexts. All eight Windows execution
inventories were complete: 2,139 distinct passed cases; ignored declarations
remain separate. The new matrix has an explicit passed case observation.
The actual hosted checkout was `df1e2c493fffb5daad0d734960c1052123b6f3c6`;
the later target composition was separately reviewed and its two affected Node
families passed 28 cases with complete execution accounting. The delivered tree
`b6891366597fb767a3d20109bacb50a8f269cc4c` matches that composition.

## Acquisition, release and family evidence

Listing download restrictions remain different from missing artifact integrity,
unsupported OS/CPU/package, source/executable incompatibility and unknown facts.
`Catalog::with_embedded_listings` retains restrictions while projecting accepted
strict presentation. Format-1 metadata publication cannot add new operational
definitions. Core's self-service options/preview/mutation guard runs before the
provider, and permitted existing-copy registration retains its separate consent
and ownership checks. The authoring repair adds no prose parser or runtime policy
registry and grants no rights over an existing copy.

The production release classifier already serves managed selection and
self-service discovery. Completed #3654/#3721/#3735 behavior is retained rather
than rewritten. Existing cases cover stable/preview/rolling, platform streams,
wrong architecture/variant, source/symbol/debug/checksum assets, ambiguity,
missing independent integrity, checksum-to-filename binding, cache expiry and
historical installed identities. Intentionally pinned Direct providers retain
their stable-only exact target; user update policy remains independent.

The [historical corpus](../../crates/portcove-core/src/testdata/rollout-release-selection-2026-10-26.json)
contains attributable selected GitHub release metadata for Road Rash v1.4.7→1.4.8,
Sonic 3K v0.5.3→0.6.0, Brave Fencer Musashi r47→Windows r48/Linux r55, and
OpenCiv3's Dutch Preview versus Carthage stable. It preserves observed IDs,
names, sizes, publisher digest fields, URLs and raw prerelease flags. This is a
selected historical corpus, not a complete upstream inventory. New production
provider replays use unchanged authored definitions; synthetic mutations exercise
wrong CPU, debug-only, ambiguous and missing-integrity refusals without falling
back to an older release. OpenCiv3's preview tag wins despite `prerelease=false`;
its acquisition hold remains intact. No artifact bytes were acquired or accepted.

Raze's package/platform/setup links and shared profile/update steps receive
consistency protection. Its original-file and fixed-game launch guidance remain
game-specific. Namco's common upstream/platform links receive equality checks;
permission restrictions and original-file instructions are deliberately excluded
from blanket equality. Synthetic changes to independent names/issues/originals/
restriction reasons pass; seven shared-fact mutations refuse. Ten other
shared-repository groups with at least four entries were compared for
platform/setup/release/hint/guide variance: v64recomp, Crispy Doom, gen1recomp,
CPS2Recomp, GemRB, Athelas, ReflectionHLE, CatacombGL, nxport and Twisted Metal.
Several repeat absent setup data rather than a shared maintained guide;
v64recomp/Athelas/Twisted Metal carry different original-game instructions, and
gen1recomp mixes an integrated route with descriptive entries. No additional
concrete shared-fact drift or safe authoring-helper benefit was demonstrated.
Those records remain independent. No IDs or evidence merged.

## Ownership, measures and limits

The exact prior issue bodies are preserved at
[#2510 history](https://github.com/boburning/portcove/issues/2510#issuecomment-6432300598)
and [#2926 history](https://github.com/boburning/portcove/issues/2926#issuecomment-6432304929).
Both guarded writes and scoped doctors passed with complete issue coverage;
global health was `not_evaluated`. Exact body/Project readback retained planning
fields and parent relationships. The original 524/312/22 cohorts, duplicate
relationships, six unfinished Direct decisions, audit references, owner steering,
blockers and historical failures retain current owners or verbatim linked history.

Measured at that readback: combined current bodies fell from 112,967 to 28,128
characters, removing 84,839 characters of repeated/history-heavy current text.
The operational benefit is one component receipt and one rollout owner, with
parent updates reserved for material product acceptance/scope/blocker changes.
The preflight benefit is one ordered implementation replacing three copies;
phase-specific transactions remain local. Family edits still update complete
per-port records: this change detects drift, not fewer authoring writes or a
measured time saving. Historical release replays require zero application or
definition edits for their represented compatible successors; this does not
promise compatibility for arbitrary future upstream changes.

Four current Direct definitions remain: Sonic 1 (#152), Super Metroid (#164),
Mega Man X2 (#165) and OpenPete (#113). The first three preserve evidenced
same-build native-state boundaries; OpenPete's current managed replacement
still needs attributable generated-library regeneration/ABI and supported
release-discovery contracts. See the existing
[source-bound review](direct-runtime-maintenance-2026-10-25.md#bounded-review-of-the-other-four-direct-routes).
Their current per-port transition/adoption decisions remain with the independently
active #2926 rollout owner; no parallel inventory or new deferral was created.

#177 owns normalized discovery, #247 scoped release-health incidents/recovery,
#246 actual compatible publication to existing clients, #534 protected production
provisioning, and #251 game-centered comparison. Completed #245/#254/#397/#398
components remain credited. #3662/#3717/#1104 modernization is not reopened.
This audit grants no production authority and claims no native gameplay,
real-save restoration, installed-Desktop or release qualification. There is no
additional demonstrated unowned maintainability defect from this scoped audit.
