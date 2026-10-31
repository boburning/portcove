# Frozen membership readback — October 30, 2026

This dated observation under [#2926](https://github.com/boburning/portcove/issues/2926)
reconciles the retained identity inventory against source
`fd55947a8e8c7003b968c8733396d9a787c5123d` and a complete live issue/Project read
ending `2026-10-30T17:54:59.034Z`. It does not replace the canonical Project,
per-port issue or latest delivery receipt. It is not a fleet acceptance report,
reviewed-fit judgment, automatic classification, global-health pass or scope
reduction.

The [packet](beta-frozen-membership-2026-10-30.json) preserves every member from
the [October27 packet](beta-frozen-membership-2026-10-27.json), its immutable
original inventory reference, duplicate mappings and historical crosswalk. Its
source predates the proposed #4090 player handoff and contains the credited
#4087 delivery. Later source or canonical changes do not retroactively modify
this observation.

| Evidence unit                                 |         Count | Boundary                                                                     |
| --------------------------------------------- | ------------: | ---------------------------------------------------------------------------- |
| Original identities                           |           524 | Retained historical membership                                               |
| Affected authored additions                   |           312 | Disjoint from original524                                                    |
| Original roadmap-only joins                   |            22 | Disjoint from those836;17 authored and5 still unlisted                       |
| Frozen union                                  |           858 | Unique canonical issues and stable IDs                                       |
| Historical #1422 rows / identities            |      317 /316 | Entirely within original524; contributes zero new identities                 |
| Current-source authored listings              |         1,424 | Includes571 outside this frozen union; not new frozen scope                  |
| Frozen authored listings                      |           853 | Source shape only                                                            |
| Current-source strict definitions             |           272 | All272 lie in the frozen union; no per-operation acceptance inferred         |
| Frozen manual guides                          |           378 | Includes conditional/held/unfinished routes; not accepted-useful-route count |
| Repository issues read                        |         1,982 | Unique, body-bearing, collector-validated traversal                          |
| Active / archived Project items               |      1,981 /1 | Full archived-inclusive membership;1,982 unique item identities              |
| Frozen issue / Project identity joins         |      858 /858 | Zero missing/ambiguous canonical joins or changed Project-item identities    |
| Accepted useful routes / supported operations | Not evaluated | Requires individual latest receipt and operation/platform/version evidence   |

The retained duplicate mappings remain #554→#356 and #1786→#322. No second
identity is introduced for either historical alias. The five unlisted original
joins remain #2728, #2744, #2757, #2761 and #2791. They still have their canonical
issues/Project items. Existing individual platform, source/code, lineage,
retirement and acquisition conditions remain in the prior batch A/B/C evidence;
unlisted does not mean uninvestigated, unsupported or newly deferred.

## Observation and reproduction

The maintained `collectRoadmapInventory` from `scripts/roadmap-inventory.mts`
was called through the current `RoadmapClient` and validated `.github/roadmap.json`,
with full scope, no supplied cache and archived-inclusive Project coverage.
The collector owns complete pagination, repository/Project identity, independent
counts/revisions and unique-total reconciliation; a partial API response is never
accepted as absent membership. This read completed on its first collector
invocation. The earlier scoped pickup HTTP504 remains a distinct failed read;
its successful bounded retry did not establish this later complete inventory.

The complete raw collector JSON and source/player preparation evidence are
retained under the ignored local checkpoint
`work/b1-port-maintenance-20261030/` in the isolated player worktree. The packet
records the raw inventory SHA-256 and exact collector/source cutoffs. This
retention is an evidence location, not a product or planning authority. GitHub
Project and issue observations are not an atomic snapshot of concurrent edits;
future independent changes require a new observation.

Reproduce the deterministic source join as follows:

1. Read the unchanged October27 packet and its immutable original source. Keep
   all524/312/22 disjoint memberships, original dispositions,317-row crosswalk
   and both duplicate mappings. Require858 unique stable IDs and canonical
   issue numbers,316 unique historical identities, and exact historical subset
   membership; never add317 or316 to858.
2. Obtain a new complete full archived-inclusive collector result with current
   tooling; incomplete counts, pagination, identity, revision or missing bodies
   leave coverage Unknown. For exact replay use the retained raw JSON whose
   hash is recorded in this packet, rather than calling later live state the old
   observation.
3. Read every `catalog/ports/<id>.json` at the declared source commit, including
   additions outside the frozen set. Check filename/stable-ID uniqueness and
   each authored `issue_number` against the retained canonical issue. Join
   Project items by exact opaque issue identity; require unique item IDs and
   unchanged recorded canonical Project-item identities, including archived
   membership. Report every unresolved join instead of choosing a title alias.
4. Record exact authored SHA-256, current listing/definition/guide/condition
   presence, declared source/executable/data contracts, canonical body SHA-256,
   issue revision and dated Project observations. An omitted release provider
   uses the existing schema's GitHub default. Preserve absent/unknown optional
   contract fields as null, never a supported or passing result.
5. Reconcile unique current listings against frozen membership, count source
   shape separately, and retain outside-frozen identities as provenance only.
   Require853 authored frozen members plus the five named unlisted joins, with
   all272 current strict definitions in that union. Fail unexpected membership
   or owner changes rather than replacing historical identities.

Each row's `canonical_condition_lines_at_observation` is a verbatim extraction
of named route/operation/blocker/resume/next-action lines. Those bodies can also
contain retained historical requirements. The extraction does not decide which
paragraph supersedes another, supply latest-comment receipt coverage, approve a
deferral or create a new maintenance declaration. Read the canonical current
specification and newest receipt before implementing or changing its state.
Plain body-byte SHA-256 and the collector's JSON-value body hash are separately
named so their different encodings cannot be confused.

## Acceptance that remains separate

The source comparison observes105 more strict definitions and97 more guides
than the October27 packet. These are differences between source shapes, never
105 or97 newly accepted operations. Delivered multi-port batches keep their own
canonical issue/PR review, check, artifact and readback evidence. A closed issue,
listing, definition, guide, historical disposition or Project Supported stage is
not a complete platform/version/operation acceptance total.

The six retained Direct/legacy transitions and two actual BStone retail
preparation observations remain governed by their latest #2926 receipt. No
source shape or reconciled membership resolves their creating-runtime/source/
state/coordinate evidence or authorizes populated adoption. #1785/#141 retains
its owner-directed evidence-loss/integrity disposition. No new console-family
campaign, gameplay/device/participant gate, protected authority or runtime result
is added. Full per-member fit, maintenance decisions, useful-route acceptance
joins, fitting implementation and guarded delivery remain unfinished under
#2510/#2926/#1422; this packet makes only the stated identity/source observation.
