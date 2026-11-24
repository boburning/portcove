# Automatic managed acquisition from upstream releases (design, November 24, 2026)

> **Status: PROPOSED design, revision 6.** Nothing here is implemented or
> activated. The [catalog contract](../CATALOG.md), the
> [definition delivery contract](../DEFINITION-DELIVERY.md), the
> [signed catalog contract](../SIGNED-CATALOG.md), the
> [upstream observation contract](../UPSTREAM-OBSERVATIONS.md) and the
> [architecture](../ARCHITECTURE.md) stay the current contracts until each
> slice below lands through its own pull request. Several slices change what
> Portcove downloads, verifies, refuses or trusts. The owner sees each of
> those changes in plain language before it merges
> ([section 12](#12-for-the-owner-what-changes-in-plain-language)).

- **Owning work:** [#1422](https://github.com/boburning/portcove/issues/1422),
  owner direction of 2026-11-24 ([comment 7137177977](https://github.com/boburning/portcove/issues/1422#issuecomment-7137177977)),
  mechanisms 1 to 3. Mechanisms 4 to 6 of that direction are out of scope.
- **Rights basis:** the tier policy of
  [#1129](https://github.com/boburning/portcove/issues/1129) in
  [rights basis for upstream-hosted packages](../CATALOG.md#rights-basis-for-upstream-hosted-packages).
  This design changes none of its rules. Whether a complete content scan
  counts as "listed" contents is an owner decision (D3); promotion conforms
  to the tier rule only if D3 is accepted.
- **Source:** measurements at `main` `534652ab2`; revision 4 rechecked the
  safety analysis at `main` `4d04ccba8` and at the tags
  `nightly-0.1.0-preview.13` to `.17`. Core paths are relative to
  `crates/portcove-core/src/`; catalog files are in `crates/portcove-core/catalog/`.
- **Measurements:** committed catalog data at `534652ab2`, plus the scheduled
  release content scan report of run
  [45381027365](https://github.com/boburning/portcove/actions/runs/45381027365)
  (source `cb29b0b8`, 2026-11-24). The method is in the
  [appendix](#appendix-measurement-method).
- **Revision 2** repairs the independent review of revision 1: the facts
  worker's current reach (digest-bound archives only), a pin conflict now also
  withholds the listing download, the waiting period requires
  a fresh reconfirmation, limit classes follow the restriction register,
  batch capacity follows the current stop rule, and a generated managed
  record replaces only a generated registration.
- **Revision 3** made the pin-conflict listing hold release-scoped where a
  listing can express it and whole-listing elsewhere. Its claim that signed
  delivery still carries listing format 11 was wrong.
- **Revision 4** repairs the second independent review. Signed delivery
  carries the compact format-15 listing with typed `restrictions` (Preview 14
  and later); Previews 13 and earlier keep the frozen format-11 listing and
  receive no new hold. The generated pin-conflict hold is now release-scoped
  only; it never becomes a whole-listing hold. Also new: a grant id that
  released readers accept, prohibitions read from the whole release body,
  repository README and licence and in-package notices, a tag-level pin key,
  the real gate for schema-4 definitions, a migration and demotion slice, and
  a complete list of residual risks.
- **Revision 5** repairs the re-review: withdrawal of a generated artifact is
  omission (no `curated_transitions`, which fresh libraries refuse and which
  consume a 256-per-library lifetime receipt), every required curated record
  field is mapped, the tag commit joins the facts and the ledger, the meaning
  of the two acceptance fields is owner decision D14, the frozen legacy
  listing is cited without a revision number, and per-identity refresh
  isolation at Previews 13 and 14 is read from their sources.
- **Revision 6** repairs the third review. Inclusion wording ("game files
  included") now waits for a person (D15). The design states that whole-game
  revocation also stops every installed version, and that generated games
  have no per-version revocation (D16). Evidence references cite an earlier
  batch's merge commit, so there is no self-reference. Rights texts are read
  with no size bound. The ledger compares peeled tag commits and records
  `tag-deleted`. Library refresh latency is stated, and its 32-a-day ceiling
  is removed by a new slice 11. §12 opens with a short decision list, and
  the plan table names the decision that blocks each slice.

## Contents

- [Summary](#summary)
- [1. Owner goal and the mechanism for each requirement](#1-owner-goal-and-the-mechanism-for-each-requirement)
- [2. Where Portcove is today](#2-where-portcove-is-today)
- [3. Ownership](#3-ownership)
- [4. Data model](#4-data-model)
- [5. Mechanism 1: pin at first observation](#5-mechanism-1-pin-at-first-observation)
- [6. Mechanism 2: the player chooses the file](#6-mechanism-2-the-player-chooses-the-file)
- [7. Rights-relevant release wording](#7-rights-relevant-release-wording)
- [8. Mechanism 3: timed update hold](#8-mechanism-3-timed-update-hold)
- [9. Update flow](#9-update-flow)
- [10. Failure modes](#10-failure-modes)
- [11. Limits this design adds, keeps or removes](#11-limits-this-design-adds-keeps-or-removes)
- [12. For the owner: what changes, in plain language](#12-for-the-owner-what-changes-in-plain-language)
- [13. Staged implementation plan](#13-staged-implementation-plan)
- [14. Alternatives considered](#14-alternatives-considered)
- [15. Open risks and UNKNOWNs](#15-open-risks-and-unknowns)
- [Appendix: measurement method](#appendix-measurement-method)

## Summary

- **Goal.** Offer tier 3 (Portcove downloads the upstream's own release
  asset, verifies it and installs it) for as many listings as the tier rule
  allows, automatically. Tier 2 (the player registers their own copy) stays
  the floor. The tier rule itself does not change.
- **Mechanism 1: pin at first observation.** The facts job already downloads
  and hashes every digest-bound archive of the offered release. This design
  adds a complete content scan of those same bytes. A listing whose package was inspected, scanned
  clean and is not held gets a generated managed definition. The definition
  is pinned to the SHA-256 that the facts job recorded the first time it saw
  that asset. Different bytes behind the same asset are a new, unverified
  artifact. They are blocked for the managed route, never accepted silently.
  Where the listing has a release route (310 listing-only identities), a
  generated release-scoped hold also stops the listing download of that
  release on Preview 14 and later. Elsewhere the listing download keeps
  today's behaviour, so no listing moves down. Previews 13 and earlier never
  receive that hold (a residual risk, [12.2](#122-residual-risks)).
- **Mechanism 2: the player chooses the file.** When the name rules cannot
  account for an archive or program, the listing is still offered. The player
  picks among the release's inspected, pinned, scanned files and, where
  needed, the program inside. Name rules only nominate a default and detect
  contradictions. A player's explicit choice supplies the missing product
  meaning; a name never does.
- **Rights wording.** A closed phrase list, such as "from my disc", over the
  whole release body, the repository README and licence, and the text files
  inside each package. Build wording ("from my disc") nominates a recorded
  note and blocks automatic tier 3 until every package of the release has a
  complete content scan. Inclusion wording ("game files included") and
  prohibition wording ("do not redistribute") block until a person decides,
  since the scan cannot prove extracted data is absent. Text that was not read completely blocks too. No AI service reads
  the text.
- **Mechanism 3: timed update hold.** A newly pinned artifact is offered only
  after a waiting period, measured from its first observation on Portcove's
  own runners, and only after a fresh observation confirms the same bytes. The proposed value is **72 hours**, kept as owner-editable
  data. It rests on an analogy with package registries, not on a Portcove
  measurement. Real latency is the wait plus the time to the next
  reconfirmation (up to 15 days until slice 7 schedules one at the end of the
  wait). Withdrawals use the existing typed restrictions and omit the
  artifact from the generated definition. A blocked release is never offered; installed copies keep
  working.
- **Measured starting point.** 1,649 listings: 452 operational definitions
  (362 managed downloads or setups from upstream, 90 player registrations)
  and 1,197 listing-only. The committed facts table holds **0 entries**, so
  mechanism 1 can promote **0** listings from committed data today. The
  newest content scan covered all targeted packages for only 4 listing-only
  identities, and every package it read this run was only partly
  byte-checked (its candidate list was cut at 64 files). The candidate pool
  for mechanism 1 is at most the 992 unheld listing-only identities that are
  neither ScummVM nor already enrolled; how many of them pass is UNKNOWN until
  the facts job runs on real data.
- **Mechanism 2 scope.** The lead's real-data measurement "run7" on `main`
  `0316192e` reports 63 of 131 hand-verified identities withheld by name
  rules. Under mechanism 2, 61 of them become offerable with a player choice
  (53 in slice 4, 8 split packages in slice 6). 2 (`bundled-toolchain`) stay
  blocked. This is lead-recorded local evidence, not committed to the
  repository; slice 0 commits the set as a fixture before anything depends
  on it ([2.2](#22-package-facts)).
- **Owner decisions** are listed in [12.3](#123-open-decisions-that-are-the-owners).
  The central one: allowing automation to create pinned acquisition records
  without per-artifact human review. The residual risks the owner accepts
  with it, including a compromised upstream reaching existing installs as an
  update, are in [12.2](#122-residual-risks).

## 1. Owner goal and the mechanism for each requirement

| Owner requirement (2026-11-24)                                                      | Mechanism                                                                                                                                                                                                                                                                   | Section      |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| As many ports as possible on tier 3, with little setup friction                     | Generated managed definitions from observed facts; the player's only setup steps are their original files and, where names are unsure, one choice.                                                                                                                          | 5, 6         |
| The written tier rule stands                                                        | Promotion requires every condition of the rule. Recompiled code is a note; detected game data, explicit prohibition and unscanned contents block. Re-hosting is never offered. Conformance for undetectable game data (textures, audio, text) depends on owner decision D3. | 5.2, 7, 12.3 |
| Tier 2 is the floor                                                                 | Every listing keeps Core's existing-copy registration whatever its definition. A generated managed record replaces only a generated registration; an authored route is never replaced automatically.                                                                        | 4.5, 5.3     |
| Automatic by default; exceptions in grouped queues with a reason                    | Each block has a stable reason code mapped to one queue. Every queue lists complete identity sets and evidence, computed from committed data.                                                                                                                               | 5.3          |
| Mechanisms over per-game work                                                       | No title, id or hand-kept list in the rules. Person-confirmed exceptions use the existing typed restrictions and accounting records.                                                                                                                                        | 3, 4         |
| No AI service in the release or delivery pipeline                                   | Every rule is deterministic code over recorded bytes and text: closed vocabularies, digests and signals.                                                                                                                                                                    | 5, 7         |
| No arbitrary limits                                                                 | Every number is classified in section 11. The scan's 64-file cut becomes a complete read for promotion.                                                                                                                                                                     | 11           |
| Pin at first observation; a later byte change is a new unverified artifact          | An append-only pin ledger keyed by repository, asset, release and tag. A conflict blocks the managed route and, where the listing has a release route, holds that release's listing download. Clients also retain the first identity per asset (library schema 36).         | 4.3, 5, 8.3  |
| Player chooses the file when the rules are unsure                                   | Choice offer over inspected, pinned files and players. Heuristics nominate and detect contradictions only.                                                                                                                                                                  | 6            |
| Timed update hold with a withdrawal list and a blocked state                        | Hold measured from first observation at publish time, not on the player's clock. Withdrawals reuse typed holds and omit the artifact from the generated definition.                                                                                                         | 8            |
| Waiting period is product policy, justified and owner-configurable                  | 72 hours, in a committed policy file outside the batch job's path allowlist, changed only by a person's reviewed pull request.                                                                                                                                              | 8.2          |
| Release wording such as "from my disc" nominates a note and blocks automatic tier 3 | Closed phrase classes over the whole release text, the repository README and licence, and in-package text files; build wording blocks until every package is completely scanned; inclusion and prohibition wording until a person decides.                                  | 7            |
| No second durable authority                                                         | Inputs stay where they are owned today; the tier table is a pure projection with a `--check`. Core keeps installation, update and rollback.                                                                                                                                 | 3, 4.1       |

## 2. Where Portcove is today

All numbers come from committed data at `534652ab2` unless a row says
otherwise. The [appendix](#appendix-measurement-method) gives each method.
UNKNOWN means the repository holds no data that settles the number.

### 2.1 Listings and operational routes

| Measure                                                   | Count | How it was computed                                                                                                                     |
| --------------------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------- |
| Listings in `listings.json`                               | 1,649 | Rows of `listings`.                                                                                                                     |
| Operational definitions in `catalog.json`                 |   452 | Rows of `ports`; every one has a listing.                                                                                               |
| Listing-only identities                                   | 1,197 | Listings without a definition.                                                                                                          |
| Listing-only identities enrolled by a reviewed route fact |     8 | `catalog-route-fit.mts` disposition `enrolled` with adapter `listing` (`route_facts_v1` registration). 2 of them carry a download hold. |
| Generated registrations                                   |     0 | `generated-registration.generated.json` `enrollments`.                                                                                  |

Operational definitions by route kind (`adapter` and release provider):

| Route kind                                     | Adapter and provider                                       | Count | Tier |
| ---------------------------------------------- | ---------------------------------------------------------- | ----: | ---- |
| Managed download and install from upstream     | `native-portable` GitHub 145, direct manifest 5            |   150 | 3    |
|                                                | `psx-recomp-managed` GitHub                                |   119 | 3    |
|                                                | `staged-source-portable` GitHub 42, direct manifest 1      |    43 | 3    |
|                                                | `n64-recomp-portable` GitHub 29, GitLab 2                  |    31 | 3    |
|                                                | `libultraship-portable` GitHub                             |     8 | 3    |
|                                                | `generated-cache` GitHub                                   |     6 | 3    |
|                                                | `referenced-disc` GitHub                                   |     1 | 3    |
| Managed upstream setup                         | `upstream-managed-setup` GitHub                            |     4 | 3    |
| Player registration (Portcove fetches nothing) | `staged-source-portable` with the `user-prepared` provider |    90 | 2    |
| **Total**                                      |                                                            |   452 |      |

5 of the 362 managed definitions carry a whole-definition
`managed_acquisition_hold`.

Listing downloads (the tier 3 listing download from the upstream's own
releases, offered where no Install route exists for the host) are resolved by
Core at request time, not recorded in data. So the number actually offered
today is UNKNOWN. The data bound is: listing-only, not held, release or
project URL on GitHub or GitLab, availability `packages`: **203** (201
GitHub, 2 GitLab). Another 795 unheld GitHub listings have availability
`unknown`; Core may still offer them a download.

### 2.2 Package facts

| Measure                                                   |     Count | Method and limits                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | --------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entries in `listing-package-facts.generated.json`         |         0 | `entries` length (format 17, `generated_at` 2026-11-23).                                                                                                                                                                                                                                                                                                                                                                            |
| Listing-only identities with inspected package facts      |         0 | Same table. The facts batch job is built disabled ([switching it on](../CATALOG.md#switching-it-on)) and stayed off after its dry run of 2026-11-24 ([#1422](https://github.com/boburning/portcove/issues/1422#issuecomment-7137177977)).                                                                                                                                                                                           |
| Route-fit `needs-bytes-worker` (packages known, no facts) |       265 | `catalog-route-fit.mts --json`; 182 unheld, 83 held.                                                                                                                                                                                                                                                                                                                                                                                |
| Route-fit `unobserved`                                    |       847 | Same; 810 unheld, 37 held.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Hand-verified identities withheld by name rules           | 63 of 131 | **Lead-recorded local evidence, not committed.** The lead's real-data measurement "run7" on `main` `0316192e`: 131 identities hand-verified correct in the prior hand-check; 68 enroll, 63 withheld. By reason: `archive-name-unaccounted` 36, `split-package` 8, `program-name-unaccounted` 8, `archive-names-another-listing` 5, `name-not-unique-in-catalog` 2, `bundled-toolchain` 2, `launcher-entry` 1, `ambiguous-player` 1. |

The live dry run of the facts job at `0316192e` enrolled nothing on the real
path ([#1422 comment 7137177977](https://github.com/boburning/portcove/issues/1422#issuecomment-7137177977)):
it read only the newest observer handoff, the observer carried no release
text, and one reproduction refusal stopped the whole job. Repairs are in
progress: since [#8661](https://github.com/boburning/portcove/pull/8661)
(merged 2026-11-24, `4d04ccba8`) the job reads the observer's whole
cumulative checkpoint and resumes carried entries oldest first; it stays
switched off. This design depends on that job running.

**Provenance of the 63 of 131.** The figures are not in the cited #1422
comment. They come from the lead's local real-data run ("run7", `main`
`0316192e`) over the 131 identities that the prior hand-check verified
correct. Neither the identity set nor the run's tables are committed. So
no acceptance in this design depends on that set until slice 0 commits it:
the hand-verified identity list (port id, repository id, expected archive and
program) as a fixture under `scripts/fixtures/`, with the hand-check that
produced it cited. Until then the 63 and 61 are reported, not relied on.

### 2.3 Content scan results

The release content scan is a scheduled workflow, not committed data. Its
report is a 30-day artifact. The newest scheduled `main` report (run
45381027365, rules version 2):

| Measure                                               | Count | Notes                                                                                                                     |
| ----------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------- |
| Targets (listing, platform, hinted asset)             | 1,081 | Over 427 identities: 273 operational, 154 listing-only. Held listings are not targeted (0 held identities among targets). |
| Packages scanned in this run                          |   160 | The run's asset budget.                                                                                                   |
| Packages reused from the checkpoint                   |   160 | Scanned in earlier runs.                                                                                                  |
| Findings                                              |     0 | No unaccounted signal in any scanned or reused package.                                                                   |
| Not scanned                                           |   761 | `asset-budget` 617 (continues later), `no-single-asset` 138, `no-release` 4, `release-unavailable` 2.                     |
| Scanned packages whose byte check was cut at 64 files |   160 | All of them (`heads_truncated`). Name signals covered every member; content signals covered only the first 64 candidates. |
| Listing-only identities with every target scanned     |     4 | 2 scanned this run (both cut at 64 files), 2 reused (cut status not in the report: UNKNOWN).                              |
| Accounting entries (confirmed false positives)        |     2 | `.github/release-content-accounting.json`; neither matched a finding in this run.                                         |

So today no listing-only identity has a scan result that this design would
accept as complete ([5.2](#52-the-promotion-rule), P5).

### 2.4 Holds

| Carrier and reason                    | Listing-only | Operational |   Total |
| ------------------------------------- | -----------: | ----------: | ------: |
| Listing `bundled-game-data`           |           56 |           3 |      59 |
| Listing `upstream-owned-route`        |           38 |           2 |      40 |
| Listing `package-facts-unresolved`    |           23 |           0 |      23 |
| Listing `legacy-rights-review`        |           17 |           0 |      17 |
| Listing `no-useful-route`             |            5 |           0 |       5 |
| Listing `third-party-component-terms` |            5 |           0 |       5 |
| Listing `upstream-prohibition`        |            2 |           0 |       2 |
| Listing `safety-evidence-mismatch`    |            1 |           0 |       1 |
| Managed `managed_acquisition_hold`    |            — |           5 |       5 |
| **Identities with a hold**            |      **147** |      **10** | **157** |

Every listing hold is a whole-listing `download` hold. Three listings also
carry an artifact-scoped `download` permit: `chameleon-twist-recompiled`
(listing-only, v0.1 ZIP by SHA-256), `grand-theft-auto-san-andreas-unity` and
`linewars-ii-sdl3` (both operational). `catalog-route-fit.mts` reports 146
listing-only identities with download held, because its count leaves out the
listing-only identity whose permit cancels the hold for one artifact. No listing hold
names `register-external` or `launch`: the listing carrier can express only
`download` ([acquisition restrictions](../CATALOG.md#acquisition-restrictions)).

### 2.5 What mechanisms 1 and 2 could do, by cause

Listing-only identities, by route-fit disposition and hold:

| Disposition                        | Unheld | Held | What this design does                                                                                                                          |
| ---------------------------------- | -----: | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs-bytes-worker`               |    182 |   83 | Unheld ones are mechanism 1 and 2 candidates once the facts job inspects them. Held ones stay blocked until their hold is lifted by its owner. |
| `unobserved`                       |    810 |   37 | Candidates once the observer covers them; today UNKNOWN whether they publish desktop packages.                                                 |
| `upstream-condition`               |     22 |    6 | Blocked by the upstream (no stable release, gone). Re-evaluated automatically.                                                                 |
| `missing-capability`               |      5 |   19 | Not a GitHub release (other host): blocked as `no-readable-upstream` until a provider adapter exists.                                          |
| `excluded-scummvm`                 |     25 |    0 | Out of scope (ScummVM project's own route).                                                                                                    |
| `enrolled` (reviewed registration) |      6 |    2 | Authored tier 2 routes (`route_facts_v1`). Not promoted automatically (`authored-route`); a person may author a managed route.                 |
| **Total**                          |  1,050 |  147 |                                                                                                                                                |

- **Mechanism 1 promotes 0 today** from committed data (no facts, no
  complete scan). Its candidate pool is the 992 unheld identities in the
  first two rows. How many pass is UNKNOWN until the facts job inspects them.
- **Mechanism 2** newly offers identities withheld only by name uncertainty.
  The one real-data measurement (63 of 131, above) gives 61 offerable with
  a player choice and 2 still blocked. The share among the other candidates
  is UNKNOWN.
- **Blocked by cause, known today:** 147 by holds, 28 by upstream
  conditions, 24 by missing provider capability, 25 ScummVM and 8 by an
  authored registration. These overlap: 6 upstream-condition, 19
  missing-capability and 2 enrolled identities are also held. So 205 distinct
  listing-only identities are blocked by a known cause. Everything else is
  UNKNOWN until observed.

## 3. Ownership

| Piece                                                            | Owner                                                                                                        | Notes                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observed release facts, pins, scan results, release text         | Facts worker (`scripts/listing-package-facts.mts`) and its committed tables; reproduced by CI                | One download per digest-bound archive, read once by Core's inspection and once by the scan rules. Other package forms are not downloaded (today's rule); they stay UNKNOWN contents. Repository tooling, not a player authority. |
| Tier decision and its reasons                                    | Catalog generation (`scripts/generate-catalog.mts`), pure over committed inputs, restated by the gate        | A projection with `--check`, like the generated registration table. It decides nothing that its inputs do not.                                                                                                                   |
| Person decisions (holds, false-positive dismissals, withdrawals) | Existing typed restrictions in `listings.json` and `catalog.json`; `.github/release-content-accounting.json` | No new hold vocabulary for person decisions. Derived blocks are separate and never authored.                                                                                                                                     |
| Policy values (waiting period)                                   | Committed `acquisition-policy.json`, owner-reviewed                                                          | Read by generation only. Clients never read a clock-based policy. Outside the batch job's path allowlist, so automation cannot change it.                                                                                        |
| Signed delivery                                                  | Catalog publisher: `official-definitions` (definitions) and `official-policy` (policy decisions, listings)   | Unchanged roles, keys, thresholds and floors.                                                                                                                                                                                    |
| Acquisition, verification, installation, update, rollback        | Core (`native-portable` managed transaction, immutable game-update acquisition, staged activation)           | The generated route reuses the existing template. Core alone resolves, downloads, verifies, stages and activates.                                                                                                                |
| Player choice                                                    | Core records it in the installation; Desktop and CLI present Core's offer                                    | React keeps only the ephemeral selection before submission.                                                                                                                                                                      |
| Runtime replacement                                              | One owner per installation: Portcove for a generated managed install; the player for a registration          | A package that ships its own updater stays tier 2 ([5.3](#53-blocks-and-their-queues), `upstream-updater`).                                                                                                                      |

**No second authority.** The design adds two committed generated files and
one committed policy file. The pin ledger is append-only evidence of first
observation; it is not an acceptance authority by itself. Acceptance happens
only when the signed policy decision binds the pinned identity, exactly as for
curated records under policy schema 4
([acquisition decision](../DEFINITION-DELIVERY.md#acquisition-decision)).

**Relation to typed acquisition restrictions.** Person-decided holds stay
typed restrictions. Two measured gaps matter here:

1. The listing carrier names only `download`. So no per-identity hold can
   express `register-external` or `launch` for a generated listing, and none
   can name `install` or `update` for a generated managed definition either,
   because that definition has no authored integration.
2. Typed integration restrictions are not yet deliverable in definitions: the
   managed wire format carries only the whole-definition
   `managed_acquisition_hold`. Named definition features
   ([#8496](https://github.com/boburning/portcove/pull/8496)) merged on 2026-11-23,
   but a feature is a reader gate only for readers that have it (section
   [4.6](#46-how-it-travels-through-signed-delivery)).

**Released readers by preview.** Read from the tagged sources:

| Reader                 | Listing carrier                                                                        | Scoped listing holds                     | Definition entry schemas                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview 13 and earlier | Legacy format 11, frozen at its last signed revision; receives no later listing change | No (`acquisition_restriction.rs` absent) | 1 and 2 (`definition_entry.rs`); definitions and policies still reach it                                                                                                                                               |
| Preview 14             | Compact format 15 with `restrictions` (the minimum supported listing reader)           | Yes (`acquisition_restriction.rs`)       | 1 to 3; the entry document is `deny_unknown_fields`, so a schema-4 entry's `required_features` fails before the schema check; scheduled refresh skips that one subject and continues (`definition_refresh.rs`).        |
| Preview 15 to 17       | Compact format 15                                                                      | Yes                                      | 1 to 4 with `required_features` (#8496); an unknown schema or feature isolates that one entry as `engine_capability_required` ([named requirements](../DEFINITION-DELIVERY.md#named-requirements-for-indexed-entries)) |

This design closes the gap without a new carrier. Generation reads a
listing's artifact- or release-scoped `download` hold as "never offer this
artifact for acquisition", and leaves it out of the generated definition.
For a pin conflict on a listing with a release route, generation writes a
generated release-scoped `download` hold into the listing projection
([8.3](#83-withdrawal-list-and-blocked-state)), so the listing download on
Preview 14 and later refuses the changed release too. It never writes a
whole-listing hold. The managed route withdraws an artifact by omitting it
from the next generated definition, never by a `curated_transitions` entry
([4.6](#46-how-it-travels-through-signed-delivery)). An authored whole-listing `download` hold blocks
generation entirely; the generated pin-conflict hold does not. Typed
`install`/`update` holds on generated definitions are slice 9: they need
their own feature name and the schema-4 gate of
[4.6](#46-how-it-travels-through-signed-delivery).

## 4. Data model

### 4.1 Inputs, outputs and who writes each

| File                                         | Kind                                    | Writer                         | New?                 |
| -------------------------------------------- | --------------------------------------- | ------------------------------ | -------------------- |
| `listing-package-facts.generated.json`       | Observed facts per identity             | Facts worker, reproduced by CI | Extended (format 18) |
| `artifact-pins/` shards (4.3)                | Append-only first observation per asset | Facts worker                   | New                  |
| `acquisition-policy.json`                    | Owner policy values                     | A person's reviewed change     | New                  |
| `listings.json`, `catalog.json` restrictions | Person decisions                        | Reviewed change                | Unchanged            |
| `.github/release-content-accounting.json`    | Person-confirmed false positives        | Reviewed change                | Unchanged            |
| `acquisition-tiers.generated.json`           | Tier, reasons, notes per identity       | `generate-catalog.mts`         | New, pure projection |
| `catalog.json` generated managed records     | Generated definitions                   | `generate-catalog.mts`         | New record kind      |

### 4.2 Facts format 18

The worker keeps today's reach: it downloads only digest-bound archives (ZIP,
TAR.GZ, TAR.XZ) of the offered release, and other package forms are never
downloaded ([facts worker](../CATALOG.md#facts-worker)). Each artifact entry
it reads gains:

- `asset_id` (the provider's numeric id), `release_id`,
  `provider_updated_at` (the provider's own asset timestamp) and the release
  tag's `commit_sha1`, beside the existing name, size and provider SHA-256.
- `observed_sha256`: the worker's own digest of the bytes it read. It must
  equal the provider digest; otherwise the artifact is refused
  (`digest-mismatch`, existing).
- `content_scan`: `{ rules, complete, members, heads_read, signals,
  nested }`, new: today's worker runs Core's inspection only, and the content
  scan is a separate workflow with its own downloads. `complete` is true only when every member was listed, every
  regular file's head was read, and no nested container was left unexpanded
  ([5.2](#52-the-promotion-rule), P5).
- `players`: unchanged (path, SHA-256, platform-true machine), now kept for
  every candidate archive, not only the offered one, so mechanism 2 can offer
  them.

Each identity entry gains `rights_text`, one row per text the phrase rules
read ([7](#7-rights-relevant-release-wording)):

- the release title and the **whole** release body;
- the repository README and licence file at the release's tag, as the
  provider's readme and licence endpoints return them. A 404 from either
  endpoint (the repository has none) is recorded complete and empty, not a
  fetch failure. The licence endpoint returns one file, so a second licence
  file in the repository (for example an assets licence) is not read
  ([12.2](#122-residual-risks));
- every package member that is a text notice: a `.txt`, `.md`, `.rtf` or
  `.html` file, or a file whose name stem is `readme`, `license`, `licence`,
  `copying`, `notice`, `eula` or `terms`, at any depth.

Each row records its source, its byte length, the SHA-256 of the whole text,
`complete` (every byte was read) and the phrase classes matched with their
byte offsets. The matching reads the whole text. Only the decision inputs
(digests, offsets, classes) are stored; the facts table keeps at most the
first 4,096 bytes of the release body as a descriptive excerpt for the
person queues (class 3, descriptive: no decision reads the excerpt). CI
reproduction fetches the texts again and re-matches them.

Every text is read to its end, with no size bound: the matcher streams the
text and keeps only a window as long as the longest phrase, so its memory
does not grow with the text. A fetch failure is recorded `complete: false`
and blocks automatic tier 3 as `rights-text-unread`; the next run reads it
again, and a complete read lifts it. A text that cannot be decoded as UTF-8
(or as the encoding its markup declares) never lifts by itself: it is queued
for a person, who records a dismissal or a hold by the text's SHA-256. Such a
text never counts as clean.

### 4.3 The pin ledger

The ledger (`artifact-pins/`, sharded by repository id) has one row per
asset ever observed for a listing-only or generated identity:

```json
{
  "repository_id": 123456789,
  "release_id": 987654321,
  "asset_id": 192837465,
  "release_tag": "v1.2.0",
  "commit_sha1": "…40 lowercase hex, the peeled tag commit…",
  "asset_name": "Game-1.2.0-win64.zip",
  "size": 48123904,
  "sha256": "…64 lowercase hex…",
  "first_observed_at": "2026-11-24T06:00:00Z",
  "facts_run": 45390000000,
  "state": "pinned"
}
```

Rules:

- **Append-only.** CI refuses a change that removes a row or edits its
  identity, digest, size or `first_observed_at`. A new row's
  `first_observed_at` must lie between the provider's own asset `updated_at`
  and the start of its `facts_run`, both of which CI reads back. A worker
  cannot backdate a pin to before the upstream published the bytes. Only `state` may move, and
  only forward: `pinned` → `conflict`, `replaced`, `tag-moved`, `tag-deleted`,
  `deleted`.
  `tag-moved` means the tag now points at another commit
  ([4.6](#46-how-it-travels-through-signed-delivery), tag commits).
- **Three keys.** A row is matched by `(repository_id, asset_id)`, by
  `(repository_id, release_id, asset_name)` and by
  `(repository_id, release_tag, asset_name)`. If any key sees different
  bytes or size later, the row becomes `conflict` (same asset id) or
  `replaced` (same release and name, or same tag and name, with a new asset
  id). The new bytes get no pin. Nothing offers them until a person reviews
  them ([5.3](#53-blocks-and-their-queues), `pin-conflict`).
- **Recreated releases.** A release deleted and recreated with the same tag
  gets a new release id and new asset ids, so only the tag key sees it. An
  asset of the recreated release with the same name and the same bytes is a
  new row in state `pinned` (the bytes are unchanged; no new trust). With the
  same name and different bytes it is `replaced`. A recreated release whose
  asset names are all new is a new release id for a tag the identity already
  pinned: its assets are recorded `replaced` too (`release-recreated`), so a
  re-published version is never offered as an update of itself. Slice 3
  tests all three cases.
- **Deleted assets** become `deleted` when a complete observation of the
  release no longer lists them. The row stays as evidence.
- **Repository identity.** A different numeric repository id is a different
  repository (`repository-identity-changed`, existing). Pins never move between
  repository ids.
- **Growth is lifetime accumulation.** Rows are never removed, about
  400 bytes each. The ledger is not part of any signed carrier; only the
  definitions built from it are. Runway, as an assumption to be replaced by
  slice 3's measurement: 1,000 identities × 6 releases a year × 5 archives is
  30,000 rows, about 12 MB a year, so one file passes GitHub's 50 MB warning
  in about four years. Plan: the ledger is sharded from the start by
  `repository_id` (one file per repository under `artifact-pins/`), so no
  single file carries the whole history and no shard count is chosen. Compaction keeps the append-only
  evidence: a row whose state is final (`conflict`, `replaced`, `deleted`)
  and that no current generated definition binds moves to a yearly archive
  segment; the live shard records the segment's SHA-256 and row count, and CI
  checks that every moved row is present in the segment. Each batch reports
  row counts and file sizes ([11](#11-limits-this-design-adds-keeps-or-removes)).

### 4.4 The tier table

`acquisition-tiers.generated.json` records, per identity and platform:

| Field     | Meaning                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tier`    | 1 (listing only), 2 (registration), 3 (managed). The highest the inputs allow.                                            |
| `route`   | `managed-authored`, `managed-generated`, `registration-authored`, `registration-generated`, `listing-download` or `none`. |
| `choice`  | `automatic` or `player` (mechanism 2), with the nominated default when there is one.                                      |
| `blocks`  | Derived reasons that stop tier 3, each with evidence and the condition that lifts it.                                     |
| `holds`   | The authored restriction ids that apply, by reference. Never copied.                                                      |
| `notes`   | Recorded-note codes for the listing warning (`recompiled-code`, `upstream-states-original-material`, owner exceptions).   |
| `offered` | Pinned artifact keys the generated definition offers, and the newest pinned artifact still in its waiting period.         |

A block is never authored and never stored as a decision. Each generation
recomputes it from inputs. So a block lifts automatically when its reason
clears: new facts, a complete scan, an accounting entry or the end of the
waiting period. An authored hold lifts only by its owner's reviewed change,
as today.

### 4.5 The generated managed definition

`catalog.json` holds one record per identity, with one adapter. A promoted
identity's generated managed record **replaces its generated registration
record** for the platforms it covers. Generation never replaces an authored
record: an identity with an authored integration or a reviewed
`route_facts_v1` enrollment is not promoted (`authored-route`).

The tier 2 floor does not depend on the registration record. Core offers
"register an existing copy" for every listing, with or without a definition
([discovery listings](../ARCHITECTURE.md#discovery-listings-and-user-owned-setup)).
That route stays for a promoted identity, and for a client that isolates the
generated definition. Such an older client also keeps the listing download.
A registered existing copy keeps the player as its replacement owner; a
managed install has Portcove. They are alternatives, not coexisting
installations: Core refuses a registration while the port has a managed
install, and the reverse (`service/user_selected.rs`). So each installation
has exactly one owner.

**Players who already registered a copy.** Promotion changes the definition
under an existing registration. Read from `service/user_selected.rs`
(`check_user_selected_retained_runtime`): a registration on a port that is
not a user-selected listing is checked against
`port.release.user_prepared[platform]` of the _current_ definition. A
generated `native-portable` record has no `user_prepared` contract, so the
check reads as refusing with "retained selected runtime has no platform
contract". Where that refusal surfaces (launch, status, verification) is
UNKNOWN; slice 5a proves it with a test before any promotion is published.
The required behaviour: an existing registration keeps launching from its
retained contract (the contract stored with the registration, as a managed
install keeps its retained definition), keeps the player as replacement
owner, and is never converted to a managed install. Its files and persistent
data are untouched. The player may later remove the registration and install
the managed copy; nothing does that for them.

**Demotion and switching promotion off.** A generated managed record leaves
the catalog when its identity stops passing the rule, when its pins are all
withdrawn, or when the owner switches promotion off. Generation then writes
the generated registration back (or nothing, where none fits). For players:

- an installed managed copy keeps its installed version, retained definition
  and per-version data, and keeps launching and rolling back to retained
  versions; no update is offered while no managed definition exists;
- removal uses the existing removal review;
- if the identity is promoted again later, the next managed definition is at
  a higher revision and its pins must equal the retained identities (library
  schema 36), so a re-promotion can never repin different bytes.

Slice 5a's acceptance is an upgraded library: a library with a registration
and one with a managed install, both made on the current preview, still
launch after promotion and after demotion, with saves and other files in and
outside the game folder byte-identical.

The generated record has:

- `adapter`: `native-portable` (the managed transaction with staged
  activation, retained manifest, and the unknown-file carry of
  [tier 2](../ARCHITECTURE.md#unknown-player-side-files)).
- `release`: GitHub provider, the bound repository and its numeric id, and
  an **exact artifact selector** per platform: release id and tag, asset id,
  name, size and pinned SHA-256. No live "latest" resolution.
- `executable`: the one inspected program path for an automatic choice, or
  `player_choice_v1` with the inspected candidate list (mechanism 2).
- No declared persistent paths. Save ownership is unknown, so Portcove offers
  no backup and no save migration. Files the game writes into its folder are
  kept by the existing unknown-file rules.
- The listing guide keeps its authored steps; generation adds one generic
  step about original game files, the ownership note and the provenance
  reference. The guide's eight-entry bound is a class 4 ceiling in the
  register (SR-01, and SR-02 for generated routes). Until its owner removes
  it, an identity whose authored guide leaves no room is blocked as
  `guide-bound`, as for generated registration today.

### 4.6 How it travels through signed delivery

Nothing in the trust chain changes. The pinned identity travels the way
curated records travel today:

1. The batch pull request changes the facts table, the pin ledger, the tier
   table and the generated records. Required CI reproduces every changed
   entry from upstream bytes (existing reproduction), checks the ledger is
   append-only and runs the gate.
2. The catalog publisher prepares the definition as a content-addressed leaf
   under `official-definitions`, at a higher revision than any previous one
   for that stable id.
3. The generated definition's `release.curated` map holds one curated record
   per offered artifact, and the `official-policy` decision admits it under
   policy schema 4 (`curated_acquisition_checks: 1`). The record's fields are
   mapped below; two of them are owner decision D14.
4. The client verifies the TUF chain, the revision floors and expiry as today,
   admits the definition, and retains the first immutable identity per
   repository and asset id (library schema 36). A later decision that names
   other bytes for the same asset fails on the client too.
5. Withdrawal of a pinned artifact is **omission**: the next generated
   definition no longer lists it, so no library offers it for a fresh install
   or an update. Installed versions keep their retained contracts and stay
   playable. Generated policies carry no `curated_transitions` (below).

**Curated record fields.** `CuratedAcquisitionRecord`
(`curated_acquisition.rs`) is `deny_unknown_fields` at Previews 13 to 17 and
on `main`, and every field is required. Mapping:

| Field                                                                              | Source for a generated record                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record_version`                                                                   | 1 (no preserved locations).                                                                                                                                                                                                                                               |
| `repository`, `upstream_url`                                                       | The listing's bound repository and its canonical URL.                                                                                                                                                                                                                     |
| `acquisition_host`, `acquisition_url`                                              | `github.com` and the canonical release download URL for the tag and file name (`canonical_acquisition_url`).                                                                                                                                                              |
| `release_id`, `tag`, `asset_id`, `filename`, `size`, `sha256`, `platform`, `route` | The pin ledger row and the facts entry.                                                                                                                                                                                                                                   |
| `commit_sha1`                                                                      | The commit the tag pointed to at first observation. **New in facts format 18 and in the ledger** (4.2, 4.3): `verify_metadata` compares the observed tag commit at install, so without it no record can be filled.                                                        |
| `acquisition_evidence`                                                             | The artifact's evidence file `evidence/pins/<repository_id>/<asset_id>.json` (its ledger row, facts entry and reproduction receipt), cited by the immutable commit URL of the **earlier** batch that merged it, with the file's SHA-256. See _Evidence references_ below. |
| `distribution_basis`                                                               | Fixed text: the upstream's own release asset, fetched from the upstream URL, never re-hosted (tier 3 of #1129).                                                                                                                                                           |
| `distribution_evidence`                                                            | The release's evidence file `evidence/releases/<repository_id>/<release_id>.json` (rights-text digests, phrase results, scan results), cited the same way.                                                                                                                |
| `independent_review`, `protected_acceptance`                                       | **Owner decision D14.** No person reviews a generated record, so nothing honest fills these as named.                                                                                                                                                                     |

**D14, the two acceptance fields.** Options:

- **A. Reuse the fields with automated references**: the committed
  reproduction receipt in the artifact's evidence file for
  `independent_review`, and the earlier batch's evidence file at its merge
  commit for `protected_acceptance` (a CI run itself has no content digest
  and its logs expire, so it cannot be cited). Every released reader admits the records, so
  automatic tier 3 reaches Preview 13 and later at once. Cost: the fields
  then mean something weaker than their names on every record, reviewed or
  generated, and an audit tells them apart only by the reference URL. This
  contradicts D1's statement that the CI repeat is not an independent review.
- **B. A new record version (3) with an acceptance class**
  `automatic-first-observation-v1` and fields `observation` and
  `reproduction` in place of the two review fields, behind a named
  definition feature (schema 4). Released readers refuse record version 3,
  so generated managed definitions reach only the reader generation that
  has it; older apps keep the tier 2 floor and the listing download for
  those games. Cost: one Core slice, and automatic tier 3 only for players
  on that app version or later.

Recommendation: **B**. The fields' names are a verification claim; reusing
them makes every record's review claim unverifiable. The reach cost ends as
players update, and the app offers the update automatically.

**Evidence references.** Core's record validation requires each reference
to be an https URL with a 64-hex SHA-256 (`curated_acquisition.rs`,
`validate`). A reference to the batch that also adds the record would be a
cycle: the record sits in the same commit, and a squash merge changes the
commit. So evidence and record are written in different batches. The batch
that first pins an artifact commits its evidence files; the record is
generated only after the waiting period, so always in a later batch, and it
cites the earlier batch's merge commit on `main`
(`https://github.com/boburning/portcove/blob/<commit>/<path>`) and the file's
SHA-256, as existing curated acceptance does to avoid a self-hash cycle
([Chameleon Twist acceptance receipt](../qualification/chameleon-twist-jp-exact-byte-acceptance-2026-10-21.md#deterministic-handoff-and-remaining-authority)).
Evidence files are content-addressed by path and never edited; a new
observation writes a new file. The evidence fields are outside the record's
`immutable_identity` (`curated_acquisition.rs`), so a later record may cite
newer evidence for the same bytes without repinning them.

**Tag commits.** A stable tag moved to another commit with unchanged assets
fails every install of that record (`verify_metadata`), and `commit_sha1` is
part of the record's immutable identity. The ledger records the **peeled**
commit: Core peels an annotated tag through at most five tag objects to the
commit (`release.rs`), and the worker does the same and compares peeled
commits only, so re-annotating a tag over the same commit is no change. A
later observation whose peeled commit differs moves **every** row with that
tag to `tag-moved`; a tag that no longer exists while its release does moves
them to `tag-deleted`. Either way generation omits those artifacts (fresh
installs fall back to an earlier pin, or tier 2) and queues them in
`pin-conflicts` for a person.

**No transitions on generated policies.** A `curated_transitions` entry
may name only an artifact that the admitting library already admitted in
that scope: `require_scoped_artifact` refuses otherwise ("curated transition
has no artifact admission in its authority scope";
[acquisition decision](../DEFINITION-DELIVERY.md#acquisition-decision)). Every
fresh library and every library that was not refreshed while the artifact
was offered would refuse the generated definition's new policy, and new
players would silently lose tier 3 for that game. Each distinct
transition-carrying policy also consumes one of the library's 256 lifetime
receipts (`retain_transition_receipt`, keyed by the policy target's
SHA-256, called on every changed admission whose policy carries transitions,
so every later revision that repeats the transitions costs another), and at
256 Core refuses to **admit** the next such policy (`count == 256`,
conflict). So generated policies carry none:

- an upstream deletion, a pin conflict or a person's withdrawal of one
  artifact is an omission; a library that already admitted the artifact keeps
  its retained identity, and nothing offers the artifact again;
- an emergency withdrawal of everything (for example a malicious release)
  uses the existing whole-definition `Revoked` policy decision, which needs
  no artifact history and no receipt;
- a library that admitted an omitted artifact does not lose acceptance:
  without transitions in the policy, `future_curated_acceptance_lost`
  (`definition_publisher_policy.rs`) reads the newest retained transition
  receipt for that stable id and is false when there is none, which is
  always true for a generated definition. Slice 8's test confirms it, with a
  fresh library admitting the same policy;
- that reasoning needs a stable id with no transition history. P1 therefore
  excludes any identity whose stable id was ever published with an authored
  definition, so no earlier receipt exists for it.

Generated definitions then consume no receipt. The 256 lifetime bound stays
a class 4 ceiling on the transition path for reviewed definitions
([11](#11-limits-this-design-adds-keeps-or-removes)); generated
transitions would wait for its removal and for Core to treat a transition
naming an unadmitted artifact as having nothing to withdraw.

**Where policies are admitted.** Read from `definition_refresh.rs` (`main`,
and the same loop at Previews 13 and 14): scheduled refresh visits every
official definition the catalog lists or the library retained, installed or
not, and admits its policy. A subject whose acquisition or admission fails
is logged and skipped ("scheduled definition could not be acquired"); the
loop continues with its siblings. So a refused policy or entry costs that
one identity, not the refresh.

**Grant id.** Generated definitions use the publisher grant prefix
`managed-github-v1-generated-`. Released readers accept a managed GitHub
policy only when its grant id starts with `MANAGED_GRANT_PREFIX =
"managed-github-v1-"` (`definition_acquisition.rs`, checked in
`definition_publisher_policy.rs`; identical at Preview 14). The generated
prefix starts with it, so every released reader admits the policy and treats
it exactly as a managed grant (portability and adoption refusals included).
The longer prefix lets the publisher select generated grants for a
revocation or a different signing rule; clients do not distinguish them.

**Reader gate for schema 4.** Generated definitions that need new reader
behavior (player choice) name a required feature in definition entry
schema 4. Only Previews 15 to 17 isolate such an entry per definition (table
in [3](#3-ownership)). Preview 14 refuses the entry while parsing, and
Previews 13 and earlier read only schemas 1 and 2. Their scheduled refresh
skips a subject whose acquisition fails and continues (above), so the
refusal is per identity; those players keep the existing-copy registration
and the listing download for that game. They see no "update Portcove"
reason, because those readers do not record `engine_capability_required`.
Slice 4 confirms this with a test against the tagged sources (a refused
schema-4 entry beside an admitted sibling), including a manual refresh of
that one game. No minimum supported reader for definition delivery is
needed (D13).

Which readers receive automatic tier 3 depends on D14. With option A,
generated definitions with no required feature (mechanism 1 with an
automatic choice) use schemas 1 to 3 and reach every reader, Preview 13
included. With option B (recommended), every generated managed definition
names the record-version-3 feature and reaches only the reader generation
that has it; older readers skip it per identity as above. Rollback to an earlier installed version uses the retained
definition of that version, as today.

## 5. Mechanism 1: pin at first observation

### 5.1 Flow

1. The observer reports a stable release for a listing's bound repository.
2. The facts worker downloads every digest-bound archive of the release once,
   checks the provider digest, records the pin row if the asset is new, runs
   Core's inspection and the content scan on the same bytes, and deletes the
   bytes. Other package forms are not downloaded.
3. Generation evaluates the promotion rule per platform. A passing platform
   gets a generated managed record; a failing one keeps its generated
   registration (if any), the existing-copy registration and the listing
   download, with its blocks in the tier table.
4. The batch job delivers the change through its existing pull request,
   reproduction and guarded merge. Publication follows.

### 5.2 The promotion rule

An identity I is promoted to a generated managed route on platform p, with
artifact a of release R, when **all** of these hold. The first that fails is
the block reason.

- **P1. Route slot.** I has no authored record: no authored integration, no
  reviewed `route_facts_v1` enrollment, and no authored definition ever
  published under its stable id (so it has no transition history, 4.6). Generation replaces only its own
  generated registration ([4.5](#45-the-generated-managed-definition)).
- **P2. Upstream and release.** Conditions 2 to 8 of
  [generated user-selected registration](../CATALOG.md#generated-user-selected-registration)
  hold: GitHub repository, current facts, complete observation, fresh within
  `maxFactsAgeDays`, the offered release on the listing's release line, stable
  by rule and by its own text.
- **P3. Pinned bytes.** a has a provider SHA-256, the worker's digest equals
  it, and the pin ledger row for a is `pinned` with that digest. No row for
  the same release and asset name, or the same tag and asset name, is
  `conflict` or `replaced` ([4.3](#43-the-pin-ledger)).
- **P4. Package fit.** Conditions 9 to 11 of generated registration hold for
  a on p, or mechanism 2 applies ([6](#6-mechanism-2-the-player-chooses-the-file)).
  `bundled-toolchain`, `non-desktop-platform`, `unknown-platform`,
  `wrong-host`, `other-package-form-beside-archive` and the role and
  launcher deny-lists stay blocks; mechanism 2 does not lift them.
- **P5. Complete content scan, clean.** For a, and for every other archive of
  R that the player could choose on p: `content_scan.complete` is true under
  the current rules version, and every signal is accounted for in
  `.github/release-content-accounting.json` for that exact SHA-256 and rules
  version. A nested archive or installer counts as unknown contents until
  the scan expands it.
- **P6. No hold.** No authored restriction holds `download` on I at any scope
  that matches a or R, and no `upstream-prohibition` hold exists at any scope.
- **P7. Rights wording.** Every rights text of R, of its repository and of
  every package the player could choose was read completely, no
  prohibition- or inclusion-class phrase matched in any of them without a
  person's decision, and no build-wording phrase is unresolved
  ([7](#7-rights-relevant-release-wording)).
- **P8. One replacement owner.** The package ships no updater program
  (players vetoed with `updater` or `autoupdater`) and no launcher the facts
  identify as replacing the runtime. Such a package stays tier 2 with
  upstream as the replacement owner. This rule reads names only: a game
  program with a built-in self-updater is not detectable and passes. It then
  has two runtime-replacement owners, which the ownership contract forbids.
  Human review caught this class on current definitions
  (`open-nectar-pikmin`: upstream launcher updates; `super-metroid-recomp`: a
  launcher path that starts a game process Portcove can't follow), both now
  managed holds. Containment, not detection: Core's verification of the
  sealed manifest reports changed program files, and a person's report adds
  an authored hold. Listed in [12.2](#122-residual-risks).
- **P9. Waiting period and reconfirmation.** For a first offer,
  `first_offer_hold_hours` has passed since the hold start, and a complete
  observation after that point still lists a with the pinned digest and asset
  id ([8.1](#81-rule)).
- **P10. Capacity.** The batch stays within the
  [catalog capacity](../CATALOG.md#catalog-capacity) ceilings. Today's rule
  applies unchanged: a batch past a ceiling is not proposed, and the run files
  the `catalog-capacity` stop issue. Carrying identities instead of stopping
  would be a separate change to that rule.

Promotion never removes the existing-copy registration, and nothing here re-hosts bytes.
Clients download a only from the upstream's release URL.

### 5.3 Blocks and their queues

Each block maps to one queue in `catalog-route-fit.mts --json`
(`acquisition_queues`), with complete identity lists in port id order and
evidence. "Lifts" says what clears it with no person involved, or names the
person step.

| Block reason                                                      | Source                                                                | Lifts automatically when                                                                  | Queue                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| `authored-route`                                                  | P1                                                                    | Never automatically; a person may author a managed route                                  | `authored-routes`          |
| Registration reasons (P2)                                         | Existing generated-registration reasons                               | The upstream or facts change, as today                                                    | Existing `reasons` queues  |
| `no-provider-digest`                                              | P3                                                                    | Upstream publishes a digest for a new asset                                               | `missing-digest`           |
| `pin-conflict`                                                    | P3: same asset, different bytes                                       | Never; a person reviews the new bytes. The listing download is held too (8.3).            | `pin-conflicts`            |
| `asset-replaced`, `release-recreated`, `tag-moved`, `tag-deleted` | P3: same release or tag and name, new asset; a known tag re-published | Never; a person reviews                                                                   | `pin-conflicts`            |
| Name uncertainty (6.1)                                            | P4, mechanism 2 not yet available                                     | Mechanism 2 ships; then the identity is offered with a choice                             | `player-choice`            |
| `bundled-toolchain` and the other fit contradictions              | P4                                                                    | The release changes                                                                       | Existing `reasons` queues  |
| `scan-incomplete`                                                 | P5                                                                    | A later run completes the scan                                                            | `scan-incomplete`          |
| `nested-unscanned`                                                | P5                                                                    | Scan rules expand that container type                                                     | `scan-incomplete`          |
| `scan-finding`                                                    | P5                                                                    | A person adds an accounting entry, or confirms a `bundled-game-data` hold                 | `scan-findings`            |
| Authored hold (any reason)                                        | P6                                                                    | Its owner's reviewed change, as today                                                     | `holds` grouped by reason  |
| `rights-wording`, `rights-wording-unread`                         | P7: build wording (`own-copy-source`)                                 | Every package of the release, of every form, has a complete clean scan                    | `rights-wording`           |
| `rights-terms`                                                    | P7: prohibition wording                                               | Never; a person adds a prohibition hold or a permit, or dismisses the text by digest      | `rights-terms`             |
| `rights-includes-original`                                        | P7: inclusion wording                                                 | Never; a person confirms a `bundled-game-data` hold or dismisses the text by digest (D15) | `rights-includes-original` |
| `rights-text-unread`                                              | P7: a rights text not read completely                                 | A later run fetches it completely; an undecodable text only by a person's decision        | `rights-wording`           |
| `guide-bound`                                                     | Guide bound (4.5)                                                     | The authored guide shrinks or the bound is removed                                        | Existing `reasons` queues  |
| `upstream-updater`                                                | P8                                                                    | The release stops shipping the updater                                                    | `replacement-owner`        |
| `waiting-period`, `awaiting-reconfirmation`                       | P9                                                                    | Time passes and a fresh complete observation confirms the bytes                           | `waiting` (count only)     |
| `catalog-capacity`                                                | P10                                                                   | Never by itself: today's stop issue for a person                                          | Existing stop issue        |
| `older-client`                                                    | Required feature unknown to a client                                  | The player updates Portcove                                                               | Client-side only           |

Every queue reports the count in the job summary. A queue in which one rule
blocks many real games means the rule needs fixing, not each game.

## 6. Mechanism 2: the player chooses the file

### 6.1 Which reasons it relieves

Name rules today withhold the whole listing when they cannot account for a
name. Under mechanism 2 these reasons stop withholding. They only decide
whether there is an automatic default:

| Reason                          | Real-data count | Under mechanism 2                                                                                         |
| ------------------------------- | --------------: | --------------------------------------------------------------------------------------------------------- |
| `archive-name-unaccounted`      |              36 | Offered; the player picks the archive. A nominated default only if the closed vocabulary accounts for it. |
| `program-name-unaccounted`      |               8 | Offered; the player picks the program among inspected players.                                            |
| `split-package`                 |               8 | Offered in slice 6: the player picks the game archive and any data archives to unpack beside it.          |
| `archive-names-another-listing` |               5 | Offered with the contradiction shown ("This file is named for another game in the catalog").              |
| `name-not-unique-in-catalog`    |               2 | Offered with the colliding listings shown.                                                                |
| `launcher-entry`                |               1 | Offered; the player picks the launcher or the game program.                                               |
| `ambiguous-player`              |               1 | Offered; the player picks the program.                                                                    |
| `bundled-toolchain`             |               2 | **Not relieved.** Building on first start is a property of the package, not of its name.                  |

`ambiguous-artifact`, `role-program` and `contradictory-role` are relieved the
same way when every choice is otherwise valid. The role, launcher and
archive-role deny-lists still remove a candidate (a `server` or `update`
archive is never a choice), but they no longer withhold the identity when
another candidate remains.

### 6.2 What the player can choose

The offer comes only from the signed definition. It lists:

- **Files:** every archive of the offered release that the worker read,
  that permits p by its platform-true players, whose bytes are pinned and
  completely scanned clean, and that no deny-list removed.
- **Programs:** for the chosen file, every inspected player whose machine
  runs on p, with its path and SHA-256.

The player cannot type a path or pick an uninspected file. So the program
that runs is always one the signed definition names by digest. A choice of
zero candidates is impossible: an identity with no valid candidate stays
blocked.

### 6.3 What heuristics may do

- **Nominate** a default when the closed vocabulary accounts for exactly one
  archive and one program. The offer shows it first.
- **Detect contradictions:** a name that spells another catalog game, a role
  word, a non-ASCII look-alike. The offer shows the contradiction beside the
  candidate.
- **Withhold an automatic choice** when anything is unaccounted. The player
  then chooses; Portcove never picks silently.

Heuristics never add a candidate, never hide the only remaining one, and
never decide that a file is the game.

### 6.4 Player copy

Following [content design](../CONTENT-DESIGN.md): lead with the task, one
action per instruction, name the property checked.

- Choice heading: "Choose the game file to install".
- Body: "This release has more than one file for your computer. Portcove
  can't tell from the names which one is the game. Each file below comes from
  the project's own release and matches the SHA-256 Portcove recorded."
- A nominated default: "Suggested: its name matches this game."
- A contradiction: "This file's name matches another game in the catalog:
  {other listing}."
- Program choice: "Choose the program that starts the game."
- After a choice: "Portcove installs this file. You can choose again when you
  reinstall."
- Update needs a choice: "A new version is ready, but its files changed.
  Choose the game file again to update."

The exact strings live in the localized message catalog; this design fixes
their meaning, not their final words.

### 6.5 Recording and reusing the choice

Core stores the choice in the installation record: chosen asset key, chosen
program path and SHA-256, and the definition revision it came from. The
installed manifest binds the selected executable as it does today
(install transaction step 7), so launch, verification and rollback need no
new interpretation.

On an update Core carries the choice only when all of these hold:

- the new release has **exactly one** candidate file whose **asset-name
  family** equals the chosen file's. The family is the asset name with every
  version token (a run of digits and dots, optionally led by `v`) removed;
- that file holds a player at the same relative path, after removing one
  top-level folder whose name differs only by a version token;
- that player is still one of the definition's inspected candidates.

Otherwise the update waits for the player (`choice-required`). The folder
strip is a layout heuristic; it decides which file is the game on update.
So a changed asset-name family always asks the player to confirm, even when
one candidate remains: the update shows the previous and the new file names
side by side. Carrying is a convenience for an identical layout, never a
guess.

## 7. Rights-relevant release wording

Upstream text can state what the package contains or forbid redistribution.
The worker matches every rights text of [4.2](#42-facts-format-18) against
closed phrase classes, split into words like the
[release text](../CATALOG.md#release-text-statements) rules (word boundaries,
no substring matches). The texts are the release title and whole body, the
repository README and licence at the release tag, and the text notices
inside each package. Today's content scan never reads those notices:
`headCandidates` in `scripts/release-content-signals.mts` excludes `.txt`,
`.md`, `license` and `notice`, and reads heads for magic bytes, not words.
`.rtf` and `.html` notices are matched after their markup is stripped to
text, so a tag inside a phrase does not split it.

| Class                  | Example phrases (closed list, grown only from measured examples)                                                                                                  | Effect                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `own-copy-source`      | "from my disc", "from my copy", "dumped from my", "ripped from my", "from my cartridge"                                                                           | Build wording: blocks automatic tier 3 until every package of the release is scanned clean.                                                 |
| `includes-original`    | "includes the game data", "assets included", "game files included", "no ROM needed", "no need for the original", "BIOS included", "ISO included", "pre-extracted" | **Inclusion wording: blocks automatic tier 3 until a person decides (`rights-includes-original`).** A clean scan does not resolve it (D15). |
| `code-derived`         | "recompiled from", "decompiled", "translated from the original code", "static recompilation"                                                                      | Note only: `recompiled-code`. Never a block (tier rule).                                                                                    |
| `redistribution-terms` | "do not redistribute", "not for redistribution", "no mirrors", "do not reupload", "personal use only"                                                             | Prohibition: blocks automatic tier 3 (`rights-terms`) until a person decides.                                                               |

Rules:

- **Whole texts only.** Every rights text is matched in full ([4.2](#42-facts-format-18)).
  A text not read completely blocks automatic tier 3 as
  `rights-text-unread`, whatever the class. A complete content scan never
  resolves it.
- **Build wording.** An `own-copy-source` phrase says how the build was made,
  not that the package contains the original. It is resolved only when
  **every** desktop package of the release has `content_scan.complete` and no
  unaccounted signal. A release that also ships another package form (an
  installer, a `.7z`, a disc image) keeps it unresolved
  (`rights-wording-unread`) until that form is read. The listing then
  carries the note `upstream-states-original-material`: "The project's
  release notes say the build was made using material from the original
  game. Portcove's content check found no game files in the package it
  downloads." A scan finding with such a phrase is a `scan-finding` block,
  as in 5.3.
- **Inclusion wording.** An `includes-original` phrase is the upstream saying
  the package holds game data. The content check cannot prove the opposite:
  it does not detect extracted textures, audio, text, or data inside
  `.pak`, `.dat` or `.wad` files ([12.2](#122-residual-risks)). So a clean
  scan is missing evidence, not absence, and it never resolves this class.
  The identity is queued in `rights-includes-original` with the matched text
  and its location. A person either confirms a `bundled-game-data` hold (the
  tier rule's "bundled game data stays held"), or records by the text's
  SHA-256 that the wording does not describe this package (for example "no
  ROM needed" about a freeware engine). The listing never shows "Portcove's
  content check found no game files" while such wording is unresolved or was
  confirmed. Owner decision D15.
- **Prohibition wording.** `redistribution-terms` never resolves
  automatically, wherever it appears. A person either adds an
  `upstream-prohibition` hold, records an artifact-scoped permit stating that
  the terms do not cover Portcove's acquisition (no re-hosting; Portcove
  fetches from the upstream's own release URL), or dismisses that exact text
  by its SHA-256 in `.github/release-content-accounting.json`. A dismissal
  covers later releases only while the text's digest is unchanged.
- **What the phrases cannot see.** They are English and word-exact. A
  prohibition or inclusion statement in another language, or worded outside
  the closed list, is not matched ([12.2](#122-residual-risks)).
- **Friction is measured before it is enforced.** READMEs often say "do not
  distribute ROMs", which is about the original game, not the port. The
  false-positive rate over the candidate pool is UNKNOWN. Slice 1 records
  matches without blocking and reports them by phrase, class and source;
  the `rights-terms` and `rights-includes-original` blocks are enforced
  from slice 5, with any phrase that is a measured false positive removed or
  narrowed by a reviewed change to the closed list (D11, D15).
- The observer does not carry release text today. Slice 1 adds it and the
  README, licence and notice reads.

The phrase list is a nominator, not a judge. A build-wording false positive
costs one complete scan, which the promotion rule already requires. An
inclusion or prohibition false positive costs a person's decision, once per
text digest.

## 8. Mechanism 3: timed update hold

### 8.1 Rule

A pinned artifact becomes offerable (for a first install on a newly promoted
identity, or as an update) only after its waiting period:

```text
hold_start(a) = max(first_observed_at(a), provider_updated_at(a))
hold(a)       = first_offer_hold_hours   when I has no offered artifact on p yet
                update_hold_hours        otherwise
offerable(a)  = state(a) == "pinned"
            and generated_at >= hold_start(a) + hold(a)
            and last_complete_observation(R) >= hold_start(a) + hold(a)
            and that observation lists a with the pinned asset id and digest
            and no block and no hold applies to a
```

- `generated_at` is the facts table's committed `generated_at`, so the tier
  table stays a pure projection that `--check` reproduces. It comes from the
  hosted runner, never from a client. A wrong player clock cannot shorten or
  extend the wait.
- `provider_updated_at` is the provider's own asset timestamp, which CI reads
  back. A backdated `first_observed_at` therefore cannot shorten the wait.
- The reconfirmation is the facts worker's existing reconfirmation of an
  unchanged release: the provider's asset list, asset ids and digests, read
  again without the bytes. Facts that are merely younger than
  `maxFactsAgeDays` are not enough; the observation must postdate the wait.
  Without one the artifact stays `awaiting-reconfirmation`.
- **Real latency.** Today the batch proposes a reconfirmation of unchanged
  facts only after `refreshAfterDays` (15, half of `maxFactsAgeDays`;
  `scripts/listing-facts-batch.mts`). Without a change, an artifact would
  wait 72 hours and then up to 15 more days. Slice 7 therefore adds a due
  list: an identity whose newest pin's wait has ended is reconfirmed in the
  next batch, ahead of the oldest-first carry. Latency is then the wait plus
  one batch interval; slice 7 measures it on a real update. That is the
  latency to publication. A library then receives the offer on its own
  scheduled refresh cycle (up to about 15 days at 452 definitions,
  [8.3](#83-withdrawal-list-and-blocked-state)) until slice 11 lands.
- An update is offered when the newest offerable artifact on p is newer than
  the installed one (release identity and publication time, as Core compares
  candidates today).
- While the newest release waits, the definition keeps offering the previous
  offerable release. Players see "A newer version is being checked. It
  becomes available on {date}." in update details, from the tier table.
- A change to a pinned asset during the wait (bytes, deletion, replacement)
  is seen at the latest by that reconfirmation. It moves the asset to the
  blocked state, and it never becomes offerable.

### 8.2 The value: 72 hours

**Proposal:** `update_hold_hours: 72` and `first_offer_hold_hours: 72` in
`crates/portcove-core/catalog/acquisition-policy.json`.

**Why 72 hours:**

- **Upstream retractions, by analogy only.** The value rests on an analogy,
  not on a measurement. Package registries use a similar window: npm lets a
  publisher unpublish within 72 hours, and dependency bots commonly wait
  three days before proposing a release. Portcove has no measurement of its
  own upstreams' retraction times (UNKNOWN); slice 8 adds one from the pin
  ledger's `replaced`/`deleted` transitions, and D4 is reviewed against it.
- **Pipeline fit.** The content scan runs every six hours and the facts batch
  runs on its own schedule with reproduction and a guarded merge. 72 hours
  gives at least 12 scheduled scan runs and several batches. A block that
  appears after first observation is in place before the bytes reach players.
- **What the wait does not do.** It protects only if the upstream, a player
  or a person notices a bad release and reacts within the wait. Nothing
  analyses the program for malware during it.
- **Cost.** Every update reaches players 3 days later. An urgent upstream
  hotfix waits too. A person can shorten one artifact's wait only through the
  owner's decision in [12.3](#123-open-decisions-that-are-the-owners) (D5);
  the default design has no bypass.

**Configurable data.** The file is read only by generation. It is outside the
facts batch job's path allowlist, so the job's App cannot change it; a change
is a person's reviewed pull request, and it applies at the next generation.
The repository has no CODEOWNERS file today, so the owner's review of that
pull request is a convention, not a check (decision D9). The value itself is
owner decision D4. Values are
whole hours from 0 upward. 0 is allowed and means "offer at the next
publication". The value is not a client setting.

### 8.3 Withdrawal list and blocked state

There is no new list. The withdrawal list is the set of authored typed holds
with artifact or release scope plus the pin ledger states:

| Situation                                                         | Recorded as                                                                                                                                                                        | Effect                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A person withdraws an artifact                                    | Listing `download` hold, artifact scope, reason `known-defective-artifact`                                                                                                         | Omitted from the next generated definition; no library offers it again. Installed copies keep playing.                                                                                                                                                                                                                               |
| A person withdraws everything (for example a malicious release)   | The existing whole-definition `Revoked` policy decision, plus a listing hold                                                                                                       | No offer of any artifact for that game. **Every installed version of that game also stops launching and rolling back** (`publisher_revoked` is checked before the retained-launch exemption, `definition_eligibility.rs`); only the existing-copy registration stays. No transition and no receipt. See the trade-off below and D16. |
| Upstream deletes the asset                                        | Ledger `deleted`                                                                                                                                                                   | Omitted; fresh installs use an earlier pin or tier 2.                                                                                                                                                                                                                                                                                |
| Bytes change under the same asset                                 | Ledger `conflict`; with a release route, a generated release-scoped listing `download` hold (`safety-evidence-mismatch`)                                                           | The asset's URL now serves other bytes, so every fresh install of the old pin would fail its digest check: the artifact is omitted and fresh installs fall back to an earlier pin, or tier 2. With a release route, that release's listing download is refused too on Preview 14 and later. Installed copies keep playing.           |
| Same release or tag and name, new asset; a known tag re-published | Ledger `replaced`, plus the same generated hold                                                                                                                                    | Omitted and blocked until a person reviews.                                                                                                                                                                                                                                                                                          |
| The tag moves to another commit or is deleted                     | Ledger `tag-moved` or `tag-deleted`                                                                                                                                                | Omitted (every install would fail `verify_metadata`); queued for a person.                                                                                                                                                                                                                                                           |
| A rights holder's request                                         | Existing request route; listing hold `upstream-prohibition`, or delisting through `listing-withdrawals.json` ([withdrawing a listing](../SIGNED-CATALOG.md#withdrawing-a-listing)) | Whole identity blocked or delisted; a `Revoked` policy for its generated definition.                                                                                                                                                                                                                                                 |

A blocked newest release does not block the previous offerable one, unless a
whole-listing hold applies.

**The revocation trade-off.** A generated game has two withdrawal tools,
and neither is per installed version:

- **Omission** stops every fresh install and update of one version. A
  player who installed that version keeps launching it, even if it turns
  out to be malicious.
- **`Revoked`** stops the whole game, including launch and rollback of
  every good installed version: the eligibility check holds a revoked
  publisher before it considers the retained-launch exemption
  (`definition_eligibility.rs`; [failure handling](../DEFINITION-DELIVERY.md),
  "revocation and corrupt authority still refuse"). Players keep only the
  existing-copy registration. A revoked game returns when a higher-revision
  policy decision that is not `Revoked` is published; whether a library
  then restores launch of its installed versions without reinstalling is
  UNKNOWN, and slice 8 tests it.

Reviewed definitions can revoke one version through `curated_transitions`,
but that path refuses fresh libraries and consumes the library's lifetime
receipts (4.6), so this design does not use it. The choice is the owner's
(D16): accept the trade-off, or add a per-version revocation that every
library can admit, which needs a Core change and a new reader generation.

**How long a change takes to reach a library.** Scheduled definition
refresh visits at most 32 definitions a day (`SCHEDULED_SUBJECT_LIMIT`,
`definition_refresh.rs`, the same at Previews 13 to 17), so it cycles
through 452 definitions in about 15 days and through about 1,450 in about 46. A new offer, an omission or a revocation reaches a library on that cycle
or at a manual refresh of that game. Whether a library holding a stale
selection still offers an omitted file for install, or refuses it at the
pinned-digest check, is UNKNOWN; slice 8 measures the time from publication
to a library no longer offering the file. The 32-a-day count is an
accidental ceiling on this path (class 4,
[11](#11-limits-this-design-adds-keeps-or-removes)); slice 11 replaces it
before promotion is switched on.

**Scope of the generated listing hold.** A listing may scope a hold to
releases or artifacts only when it has a `release_url` or download asset
hints ([acquisition restrictions](../CATALOG.md#acquisition-restrictions)).
Only 310 of the 1,197 listing-only identities have either. So:

- **With a release route**, generation writes a release-scoped `download`
  hold whose scope names the conflicted release's **tag** (listing release
  scopes match exact version or tag strings, `acquisition_restriction.rs`),
  marked as generated by its reserved id, which uses the numeric release id
  (below). Signed delivery carries it in the compact format-15 listing with
  typed `restrictions` (live since the compact cutover of 2026-11-24,
  [#8619](https://github.com/boburning/portcove/pull/8619)). Previews 14 to 17
  evaluate release and artifact scopes (`acquisition_restriction.rs` at
  `nightly-0.1.0-preview.14`), so they refuse only that release and keep
  offering a permitted package of another release. The format-15 legacy
  `download_block_reason` string, which equals the explanation of the first
  `download` hold at any scope, is read only by readers below format 15; no
  live listing target carries format 15 to them.
- **Without a release route**, generation writes no listing hold. A
  whole-listing hold would move a listing that offers a download today down
  for every release, which the owner's direction excludes. The managed route
  is still blocked; the listing download keeps today's behaviour, which
  already accepts whatever the project publishes (D6); the conflict is in the
  `pin-conflicts` queue, where a person may author a hold.
- **Previews 13 and earlier** read the legacy format-11 target, frozen at
  its last signed revision ([compact listing delivery](../SIGNED-CATALOG.md#compact-listing-delivery-and-the-minimum-supported-preview)).
  They never receive any new listing hold, generated or authored. On those
  clients a pin conflict does **not** hold the listing download; it fails
  open for the listing download. Their managed route still refuses the
  changed bytes: definitions and policies still reach them, and the
  pinned SHA-256 is checked at download. Listed in [12.2](#122-residual-risks).

**Marking a generated hold.** Released readers refuse an unknown field in a
restriction row (`AcquisitionRestriction` is `deny_unknown_fields` at
`nightly-0.1.0-preview.14`), so the marker is data they already read: the
row id in the reserved form `generated-pin-conflict-<release id>` with
reason `safety-evidence-mismatch`. The listing schema and the gate refuse
that id form on any row generation does not reproduce from the ledger, and
generation refuses to write or edit a row outside the reserved form. So a
person's hold and a generated hold are never confused, and generation never
edits or removes an authored hold. The tier table records the same mark
(`holds` with `generated: true`).

Released readers accept at most 64 restriction rows per listing
(`MAX_RESTRICTIONS`, Preview 14). Generated rows accumulate one per
conflicted release until a person resolves them, so a listing whose rows
would pass 64 stops generation for that listing (never truncated) and is
reported in the `pin-conflicts` queue (class 4, [11](#11-limits-this-design-adds-keeps-or-removes)).

The generated listing hold is generation's own output, like the generated
registration routes it already writes into the listing projection. It
disappears only when a person resolves the conflict: an accounting of the new
bytes, or an authored artifact-scoped permit naming them. It narrows today's
listing download for one release only. That is the owner's rule that changed
bytes are never accepted silently, applied as far as it can be without moving
a listing down; it is listed in
[12.1](#121-changes-to-what-portcove-downloads-verifies-refuses-or-trusts).

## 9. Update flow

1. **Observe and pin.** New release seen; new pins recorded; waiting starts.
2. **Generate.** After the wait, generation adds the artifact to the
   generated definition at a higher revision; the policy decision binds it.
3. **Publish and admit.** Clients admit the signed definition and policy.
4. **Review.** Core's `plan_game_update_acquisition` shows the update, the
   exact pinned identity and its release notes. The player's update policy
   applies as for any managed port. Core's per-game policy is `notify`,
   `stage` or `automatic` (`types.rs` `UpdatePolicy`). With `automatic`, a
   new pinned release reaches the installed game after the wait without the
   player looking at it; whether `automatic` also applies (not only stages)
   without a prompt is confirmed in slice 7. Generated definitions keep the
   player's chosen policy (D12).
5. **Acquire.** `acquire_game_update` downloads from the upstream release URL
   under the per-port acquisition lock, checks size and pinned SHA-256 while
   streaming and after, and keeps the bytes private. A digest mismatch
   refuses before extraction and quarantines the bytes (existing curated
   refusal).
6. **Apply.** Under the exclusive per-port lock: copy into private staging,
   run the archive preflight, extract, resolve the selected program (carried
   choice or new choice), seal the manifest, carry undeclared player files by
   the [unknown-file rules](../ARCHITECTURE.md#unknown-player-side-files), and
   activate atomically. A running game blocks Apply.
7. **Rollback.** The previous version folder and its retained definition
   stay. Rollback activates it with the same carry rules. Nothing upstream is
   needed.
8. **Saves and persistent data.** No path is declared, so nothing is moved or
   migrated. Files in the version folder are carried or kept per version and
   reported when they diverge. Files outside the folder (user profile,
   documents) are never touched. Removal uses the existing removal review and
   never deletes a file it cannot prove it installed.

**When upstream replaces or deletes a file** after a player installed it:
installed copies keep working. Fresh installs stop offering that artifact. If
an earlier pinned release is still offerable, fresh installs use it; if not,
the identity falls back to its generated registration and the existing-copy
registration, with the reason shown. Retained
local bytes are never re-served to anyone.

**Locking.** Acquisition, Apply, rollback and removal use the existing
per-port locks. Different ports stay independent. A player choice is
submitted with the Apply request and checked again under the lock against
the current definition.

## 10. Failure modes

Every outcome is typed. Each recovers automatically when its cause clears;
none deletes installed data.

| Outcome                                                                           | Where        | Cause                                                                      | What the player sees                                                                                | Automatic recovery                                                                                    |
| --------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `waiting-period`, `awaiting-reconfirmation`                                       | Generation   | Artifact newer than the hold, or no complete observation since it ended    | "A newer version is being checked."                                                                 | Offered at the first generation after the hold that has a fresh confirming observation.               |
| `scan-incomplete`                                                                 | Generation   | Budget, deadline, nested container                                         | Tier 2 route; no message beyond the listing                                                         | Next facts run continues the scan.                                                                    |
| `scan-finding`                                                                    | Generation   | Unaccounted signal                                                         | Tier 2 route                                                                                        | Accounting entry or confirmed hold, then regeneration.                                                |
| `pin-conflict`, `asset-replaced`, `release-recreated`, `tag-moved`, `tag-deleted` | Facts worker | Upstream changed bytes, re-published a known tag or moved a tag            | That version is no longer offered; installed copy unaffected                                        | None by design; a person reviews. Fresh installs use an earlier pin or tier 2.                        |
| `rights-terms`, `rights-includes-original`, `rights-text-unread`                  | Generation   | Prohibition or inclusion wording, or a rights text not read completely     | Tier 2 route; listing download unchanged                                                            | A person's decision for wording; a complete read for unread text.                                     |
| `asset-deleted`                                                                   | Facts worker | Upstream removed the asset                                                 | Fresh install uses an older pin or tier 2                                                           | A new release is pinned normally.                                                                     |
| `upstream-unreachable`                                                            | Client       | Network, rate limit, server error                                          | "Couldn't reach the project's download. Try again."                                                 | Retry; partial bytes resume (existing temporary-failure rule).                                        |
| `digest-mismatch`                                                                 | Client       | Bytes differ from the pin                                                  | "The downloaded file doesn't match the recorded SHA-256."                                           | Quarantine; a later attempt fetches again.                                                            |
| `choice-required`                                                                 | Client       | Update layout changed                                                      | "Choose the game file again to update."                                                             | Completes when the player chooses.                                                                    |
| `choice-stale`                                                                    | Client       | Definition changed between offer and Apply                                 | Offer refreshed                                                                                     | Re-offer from the new definition.                                                                     |
| `stale-facts`, `observation-unavailable`                                          | Generation   | Facts older than 30 days or upstream down 14 days                          | Fresh install falls back to tier 2                                                                  | A complete observation restores the route.                                                            |
| `repository-identity-changed`                                                     | Facts worker | Numeric repository id changed                                              | Fresh install falls back to tier 2                                                                  | A reviewed listing change binds the new repository.                                                   |
| `catalog-capacity`                                                                | Batch        | Catalog ceiling reached                                                    | Nothing new; existing offers stay                                                                   | None by itself: today's stop issue for a person; the next batch after the ceiling is raised lands it. |
| `older-client`                                                                    | Client       | Required feature unknown                                                   | Tier 2 route; "Update Portcove to install this game."                                               | Application update.                                                                                   |
| `withdrawn`                                                                       | Policy       | A hold or omission (one version), or a `Revoked` decision (the whole game) | "This version is no longer offered: {reason}." For a revoked game, installed versions are held too. | A later release, the hold's removal, or a higher-revision policy decision that is not `Revoked`.      |

## 11. Limits this design adds, keeps or removes

Classes follow the [restriction register](../RESTRICTION-REGISTER.md#how-to-read-this-register).

| Limit                                                                 | Class                 | Disposition and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Waiting period, 72 hours                                              | 2                     | Integrity: time for an upstream retraction, a report or a scan finding to surface before bytes reach players, ended by a fresh confirming observation. The value rests on an analogy, not a measurement; it is owner-configurable data (D4) reviewed against slice 8's retraction measurement. Not a content ceiling: every artifact continues.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Reconfirmation cadence, `refreshAfterDays` 15                         | 3                     | Existing batch cadence for unchanged facts; every identity continues. For offer latency it adds up to 15 days after the wait; slice 7's due list reconfirms an identity whose wait has ended in the next batch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Scan head read: first 64 candidates per package                       | 4 (for promotion)     | Removed for promotion. The facts worker reads the head of every regular file: `HEAD_BYTES` = 0x9400 = 37,888 bytes per file, from bytes already downloaded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Scan head candidates exclude files over 64 MiB and listed extensions  | 4 (for promotion)     | Removed for promotion: a renamed disc image must not escape the content check. Text notices (`.txt`, `.md`, `license`, `notice`) are also read completely for rights phrases (section 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Scan asset budget, 160 packages per run                               | 3                     | Kept for the scheduled scan; its checkpoint continues. Listing-only archives the facts worker reads are scanned there instead. Package forms the worker does not read stay with the scheduled scan and its limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Nested containers not expanded                                        | 2                     | Correctness: unknown contents stay held. Expanding a container type is a later rules change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Rights text read                                                      | —                     | No size bound: the matcher streams each text with a window as long as the longest phrase (4.2). A fetch failure blocks until a later complete read; an undecodable text until a person decides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Release body excerpt stored: 4,096 bytes                              | 3                     | Descriptive only, for the person queues. No decision reads it; the decision inputs (digests, offsets, classes) cover the whole text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Facts window: 4 releases, 32 assets per release                       | 4                     | The register's DM-01 (an accidental ceiling; GitHub allows 1,000 assets). This design does not remove it: a release past it is incomplete coverage and is not promoted (UNKNOWN, not clean). Its removal belongs to DM-01's owner; promotion depends on it only as lost coverage ([13](#13-staged-implementation-plan)).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Pin ledger growth                                                     | Lifetime accumulation | Rows are never removed. Sharded by repository id from the start, with yearly archive segments for final rows; runway and plan in [4.3](#43-the-pin-ledger). Row counts and file sizes are reported each batch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Released readers' catalog and definition bounds                       | 4                     | The register's CD-03 (16 MiB catalog, 85% guard) and CD-06 (4,096 definitions, 32 MiB content). At about 8.7 KB per generated _registration_ route, about 1,100 more routes fit; a managed record's size is UNKNOWN until slice 5. A batch past a ceiling stops as today. Removal is the [distribution scaling](CATALOG-DISTRIBUTION-SCALING.md) work. Promotion depends on these rows ([13](#13-staged-implementation-plan)).                                                                                                                                                                                                                                                                                                                   |
| Compact listing carrier: 8 MiB wire, 32 MiB decoded, 1 MiB per record | 4                     | The register's CD-02 and the 8 MiB target body read. On 2026-11-23, with legacy revision-47 observations, it measured 2,808,370 wire bytes (33%) and 9,858,222 decoded (29%) ([measured headroom](../SIGNED-CATALOG.md#compact-listing-delivery-and-the-minimum-supported-preview)). Generated listing routes and generated holds add to listing records; the capacity guard (`catalog-capacity.mts`) stops a batch past it.                                                                                                                                                                                                                                                                                                                     |
| Restrictions per listing or definition: 64                            | 4                     | `MAX_RESTRICTIONS`, enforced by released readers. Generated pin-conflict rows accumulate per listing until a person resolves them; a listing that would pass 64 stops generation for that listing (never truncated) and is queued.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `curated_transitions`: at most 64 per policy decision                 | 4                     | Enforced by released readers (`definition_publisher_policy.rs`, the same check at Preview 14). Not used by generated definitions: withdrawal is omission, and an emergency is a whole-definition `Revoked` decision (4.6). It stays a ceiling on reviewed definitions; generated transitions would wait for its removal.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Transition receipts: 256 per library, lifetime                        | 4                     | `curated_acquisition.rs`: one receipt per distinct transition-carrying policy the library admits (keyed by policy target SHA-256, so every revision that repeats its transitions costs another), for every definition the library refreshes, installed or not. At 256 Core refuses to admit the next transition-carrying policy (conflict; evidence retained). Generated definitions consume none (4.6). Removal for the transition path is a Core change: receipts bounded per definition with the oldest superseded receipt compacted, and a transition naming an unadmitted artifact treated as having nothing to withdraw. That change, with its reader generation, is a dependency of any per-version revocation for generated games (D16). |
| Scheduled definition refresh: 32 definitions a day                    | 4                     | `SCHEDULED_SUBJECT_LIMIT` (`definition_refresh.rs`, Previews 13 to 17). An accidental ceiling on this path: the time for an offer, omission or revocation to reach a library grows with the catalog (about 15 days at 452 definitions, about 46 at 1,450). Removed by slice 11 before promotion is switched on: refresh visits the definitions whose index entry or policy changed since the library's last refresh, then continues the rotation for the rest, under the existing time budget. Older readers keep the 32-a-day rotation.                                                                                                                                                                                                         |
| `maxDistinctPrograms` = 1                                             | 2                     | Kept for automatic choice. Under mechanism 2 several programs become a player choice instead of a withhold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Guide bound, 8 entries                                                | 4                     | The register's SR-01 and SR-02. Generated managed routes inherit SR-02's withhold (`guide-bound`) until its owner removes the bound. Promotion depends on these rows ([13](#13-staged-implementation-plan)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 12. For the owner: what changes, in plain language

### Decisions for the owner

Each decision in short; details and costs are in [12.3](#123-open-decisions-that-are-the-owners).

- **D1. Let automation accept files without a person reviewing each one?**
  Yes or no. Recommended: yes, accepting the risks in 12.2. Blocks slice 5.
- **D2. Which signing grant for generated games?** Same roles with a
  separate grant prefix, or a new role. Recommended: same roles, prefix
  `managed-github-v1-generated-`. Blocks slice 5.
- **D3. Does a complete content check count as knowing what is in the
  package?** Yes, or a person per package. Recommended: yes. Blocks slices
  5 and 10.
- **D4. How long to wait before offering a new file?** Recommended: 72 hours,
  as data you control. Blocks slice 7.
- **D5. May a person shorten one file's wait?** Recommended: not yet. Blocks
  nothing.
- **D6. Should today's listing download also use pins?** Recommended: not in
  this design. Blocks nothing.
- **D7. Lift old holds by machine when facts satisfy them?** Recommended:
  report them for a person instead. Blocks nothing.
- **D8. May the batch job's App merge promoting batches?** Recommended: yes,
  as for registrations, after you see the first one. Blocks slice 10.
- **D9. Protect the policy file with a required owner review?** Recommended:
  yes, a CODEOWNERS entry. Blocks slice 7.
- **D10. May a changed file also hold the listing download?** Only for the
  one release, never the whole listing. Recommended: release-scoped only.
  Blocks slice 3.
- **D11. Do prohibitions in READMEs, licences and in-package notices
  block?** Recommended: yes, after slice 1 measures false positives. Blocks
  slice 5.
- **D12. May players auto-apply updates of generated games?** Recommended:
  yes, as for reviewed games. Blocks slices 7 and 10.
- **D13. A minimum app version for definition delivery?** Recommended: no;
  older apps skip what they cannot read, one game at a time. Blocks nothing.
- **D14. How a generated file record states it was accepted.** Reuse the
  "independent review" fields for automated evidence (reaches every app), or
  a new record version (needs an app update). Recommended: new record
  version. Blocks slice 5.
- **D15. May a clean content check clear "game files included" wording?**
  Recommended: no, a person decides. Blocks slice 5.
- **D16. Accept that generated games cannot stop one installed version?**
  Accept it now (revoke the whole game for a dangerous release), or build
  per-version revocation (Core change and app update). Recommended: accept
  now. Blocks slice 8.

### 12.1 Changes to what Portcove downloads, verifies, refuses or trusts

Each item is a verification-rule change. Each slice that makes it shows it to
you again before merge.

1. **Automatic pins replace a person's review of each file for managed
   installs.** Today a managed install accepts a file without a
   project-published checksum only after a person reviews it. After this
   change, the facts job records the file's SHA-256 the first time it sees
   it, CI downloads the same URL again and checks the bytes are the same, and
   the signed catalog then accepts that exact file. No person looks at each
   file. The CI download proves the file did not change; it does not prove the
   file is safe. (Today's listing download already accepts files without any
   checksum; that is unchanged, see D6.)
2. **Portcove installs and updates games it has never reviewed by name.** A
   listing becomes a managed install when the rules in section 5 pass. Today
   only reviewed definitions do this.
3. **Portcove refuses changed files for managed installs, and for one
   release's listing download where it can name the release.** If a project
   replaces the bytes behind a file Portcove already pinned, or deletes a
   release and publishes it again under the same tag, the managed route never
   offers the new bytes until a person looks. For the 310 listing-only games
   whose listing names a release route, Portcove on Preview 14 or later also
   stops the listing download of that one release; other releases stay
   downloadable. For other listings, and on Preview 13 or earlier, the listing
   download keeps today's behaviour and takes whatever the project currently
   publishes. No listing loses its download (D10).
4. **Portcove waits 72 hours, then checks again, before offering a new file.**
   Updates reach players at least three days after the project publishes
   them, and only if a fresh check finds the same file. Until slice 7 adds a
   check at the end of the wait, the fresh check can come up to 15 days
   later. Each player's app then picks up the change on its own refresh
   cycle, which today visits 32 games a day: about 15 days for the whole
   catalog now, about 46 days at 1,450 games, unless the player refreshes
   that game by hand. Slice 11 shortens this before promotion starts.
5. **The content check reads every file for promotion.** Today it reads the
   start of only the first 64 candidate files per package. A package checked
   only partly is not promoted.
6. **Portcove reads the project's words about rights.** It reads the whole
   release notes, the repository's README and licence, and the text files
   inside the package. Wording such as "from my disc" blocks the managed
   route until every file of the release passes the full content check.
   Wording that says game files are included ("game files included", "no
   ROM needed") or forbids redistribution ("do not redistribute") blocks it
   until a person decides, because the content check cannot prove extracted
   game data is absent (D15).
   Text Portcove could not read completely blocks it too. None of this ever
   blocks registration or the listing download.
7. **The player can run a program Portcove did not pick.** When names are
   unclear, the player chooses among the files and programs Portcove
   inspected. The program still has to be one that the signed catalog names
   by SHA-256. If an update's file name changes beyond its version number,
   the player confirms the file again.
8. **Withdrawing one file leaves it playable; revoking a game stops all of
   it.** Portcove withdraws one file of a generated game by leaving it out of
   the catalog entry: new downloads stop, and players who installed it keep
   playing it, even if it was malicious. The only stronger tool is revoking
   the whole game: then every installed version of that game stops
   launching and rolling back, the good ones too, and players keep only
   registration of their own copy. There is no way to stop just one
   installed version of a generated game (D16). Either change reaches a
   player's app on its refresh cycle (item 4).
9. **Automation merges promotions.** The facts batch job's App merges batches
   that add managed installs, with no person approving each batch, as it
   does for registration batches today (D8).
10. **A registered copy stays registered.** A player who registered their own
    copy before a game was promoted keeps that registration and keeps
    playing it; Portcove does not convert it. If promotion is switched off or
    a game is demoted, managed installs keep their installed versions and
    stop receiving updates.
11. **Generated records carry the tag's commit.** Every install checks it,
    and a moved or deleted tag stops installs of that version until a person
    looks. How a record states its acceptance depends on D14: with option B
    it says "automatic first observation"; with option A it reuses the
    fields named "independent review" and "protected acceptance" for
    automated evidence.

Unchanged: the signing keys, roles, thresholds, root and bootstrap; the
client's checks of signatures, revisions and expiry; the archive safety
checks; who may publish. Re-hosting stays forbidden. Generated definitions
use a grant id that today's apps already accept (D2). Under the recommended
D14, automatic managed installs need an app version that knows the new
record version; older apps keep registration and the listing download for
those games, and the player-choice feature needs Preview 15 or later.

### 12.2 Residual risks

These remain after every slice lands. Accepting D1 accepts them.

- **A compromised upstream reaches existing players as an update.** If a
  project's account is taken over, or the project itself turns malicious, a
  NEW release is pinned like any other and offered to everyone with the game
  installed after the wait. Players whose update policy is `automatic` get it
  without looking at it (D12). The wait helps only if the project, a player
  or a person notices and reacts within it. Nothing analyses the program for
  malware.
- **First observation can pin bad bytes.** If a project's first upload is
  malicious, the pin locks in that file. A signature or pin says which file
  it is, not that it is safe.
- **The CI check is a repeat, not a second opinion.** CI downloads the same
  URL again. That proves the bytes did not change between the two downloads;
  it does not prove they are safe or that they are what the project meant to
  publish.
- **Reconfirmation trusts the provider.** The check at the end of the wait
  reads the provider's asset list and SHA-256 again without downloading.
  Players' downloads are checked against the pinned SHA-256 either way, so a
  changed file is refused at download even if the provider lied.
- **Real offer latency is longer than 3 days.** Until slice 7's end-of-wait
  check lands, an offer waits for the batch's next reconfirmation, up to
  15 days after the wait.
- **The content check finds only what it knows.** It finds ROM and disc
  files, headers, disc images and console BIOS. It does not find extracted
  textures, music or text. Proprietary pack files (`.pak`, `.dat`, `.wad`)
  holding extracted assets pass as "complete, clean". A package that bundles
  those is promoted unless the project's words say so or a person reports
  it; when the project's words say game files are included, a person
  decides (D15). Today's listing download has the same gap. Conformance with
  the tier rule depends on D3.
- **Rights wording Portcove does not read is missed.** "Do not
  redistribute" and "game files included" are found anywhere Portcove
  reads. Not found: wording outside the closed English phrase list, any
  other language, statements on a website or in a chat, and a second
  licence file in the repository (Portcove reads the one licence file the
  project's host reports).
- **Built-in self-updaters are not detected.** The updater rule (P8) reads
  file names. A game program that updates itself passes, and then both the
  game and Portcove replace the game's files: two owners, which the
  ownership rules forbid. Reviewers caught this on current definitions
  (`open-nectar-pikmin`, `super-metroid-recomp`, both now held). For
  generated definitions only a player's or person's report catches it;
  Portcove's file verification then shows changed program files.
- **Preview 13 and earlier never receive a pin-conflict hold.** They read the
  frozen legacy listing. Their listing download of a changed release
  keeps working; their managed route still refuses the changed bytes. The
  app offers them the update to the current preview.
- **Unreviewed games get managed installs.** Saves are not managed (no
  backup, no migration). Files in the game folder are carried between
  versions by the existing rules, but a game that keeps saves somewhere
  unusual could lose them if the player deletes the folder outside Portcove.
- **Name contradictions shown to the player can be ignored.** The player can
  choose a file named for another game. The bytes still come from this
  listing's own repository and pass the same checks.
- **Capacity.** At today's sizes about 1,100 more generated registration
  routes fit the released readers' catalog bound; managed records are larger
  by an amount not yet measured, and the listing carrier is at 33% of its
  8 MiB wire bound. Past a catalog bound, the batch job stops and files its
  capacity issue, as today.
- **Withdrawing a file does not reach back into libraries.** Portcove
  withdraws a generated game's file by leaving it out of the next catalog
  entry, so no one is offered it again; it does not send the
  "this file was withdrawn" record that reviewed games can use, because
  today's apps refuse that record in any library that never saw the file,
  and each one uses up one of only 256 lifetime slots per library. A player
  who already installed the file keeps it. For a dangerous release, a person
  revokes the whole game's catalog entry instead, which also stops every
  good installed version of that game (D16).
- **Changes reach players slowly.** A player's app checks 32 games a day,
  so a withdrawal or revocation can take about 15 days to reach it today,
  longer as the catalog grows, unless the player refreshes that game.
  Slice 11 must shorten this before promotion is switched on. Whether an
  app that has not refreshed yet still offers a withdrawn file is not yet
  known; slice 8 measures it.
- **A moved tag stops installs of that version.** If a project moves or
  deletes a release tag, Portcove stops offering that version until a
  person looks.
- **Facts job readiness.** Everything here depends on the facts job, which
  is off and enrolled nothing in its last dry run.

### 12.3 Open decisions that are the owner's

| Id  | Decision                                                                                                                                                                                                                                                    | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | May automation create pinned acquisition records without per-file review (#315 currently requires independent review)?                                                                                                                                      | **Yes**, with the residual risks in 12.2 accepted. CI repeats the download from the upstream URL and confirms the bytes are unchanged; that is a consistency check, not an independent review. How each record states that acceptance is D14 (option B: provenance `automatic-first-observation-v1`), and the job's scripts keep their existing required approval. Without this, mechanism 1 cannot exist.                                                                                                |
| D2  | May the same publisher roles sign generated definitions, or should generated definitions use a separate delegated role?                                                                                                                                     | **Same roles, a separate grant prefix** `managed-github-v1-generated-`. It starts with the `managed-github-v1-` prefix every released reader requires, so today's apps admit it; the publisher can still select generated grants for a revocation or a different signing rule. A new role is a signing change and adds owner steps.                                                                                                                                                                       |
| D3  | Is a complete name-signal and head scan enough to call contents "listed" for the "unknown contents stay held" rule?                                                                                                                                         | **Yes for automatic tier 3**, with the gaps in 12.2 (extracted assets, pack files) stated on the listing ("Portcove's content check found no game files"). The alternative, a person per package, contradicts "mechanisms over per-game work".                                                                                                                                                                                                                                                            |
| D4  | Waiting period value.                                                                                                                                                                                                                                       | **72 hours** for first offer and updates, as data in `acquisition-policy.json` that only your reviewed change alters. It rests on an analogy; review it when slice 8 measures real retraction times.                                                                                                                                                                                                                                                                                                      |
| D5  | May a person shorten one artifact's wait (for example a security fix)?                                                                                                                                                                                      | **Not in the first slices.** If needed later, an artifact-scoped `permit` naming the operation and SHA-256, through the existing typed restriction route, so it stays visible and reviewed.                                                                                                                                                                                                                                                                                                               |
| D6  | Should today's listing download (no pin, provider digest only when present, no scan) also move to pins?                                                                                                                                                     | **Not in this design.** It would narrow what players get today, and the owner's direction adopts no rule that moves listings down. Report it as a separate decision with its measured effect once pins exist.                                                                                                                                                                                                                                                                                             |
| D7  | Existing `package-facts-unresolved` (23) and `legacy-rights-review` (17) listing holds: lift by machine when the facts and scan satisfy them?                                                                                                               | **Report, don't lift.** The rights policy says each existing hold stays until re-reviewed. `restriction-recheck.mts` lists the satisfied ones for a person, grouped; the person's reviewed change lifts them.                                                                                                                                                                                                                                                                                             |
| D8  | Who may merge batches that promote identities: the batch job's App alone, as today for registration?                                                                                                                                                        | **The App, as today**, since every promotion is reproduced by required CI and is reversible by regeneration. The owner sees the first promoting batch before it merges.                                                                                                                                                                                                                                                                                                                                   |
| D9  | Should `acquisition-policy.json` (and the pin ledger's append-only check) be protected by a repository rule, such as a CODEOWNERS entry with required owner review?                                                                                         | **Yes, a CODEOWNERS entry naming the owner for `acquisition-policy.json`**, enforced by the existing branch rules. Today nothing but convention stops another person's reviewed change. Repository settings are the owner's.                                                                                                                                                                                                                                                                              |
| D10 | May a pin conflict also hold the listing download?                                                                                                                                                                                                          | **Only release-scoped, never whole-listing.** For listings with a release route, the conflicted release's listing download is held on Preview 14 and later; other releases stay downloadable. For listings without one, the listing download is left as today: a whole-listing hold would move the listing down, which your direction excludes. The cost is that changed bytes stay reachable through those listing downloads, as they are today (D6).                                                    |
| D11 | Should prohibitions in the repository README, licence and in-package notices block automatic tier 3, as release-note prohibitions do?                                                                                                                       | **Yes**, because "explicit prohibitions stay held" (#1129) does not depend on where the project wrote them. Friction is measured first: slice 1 reports matches without blocking, and the block starts in slice 5 with measured false positives removed from the closed list. A person's dismissal covers that exact text until it changes.                                                                                                                                                               |
| D12 | May players use the `automatic` update policy for generated managed installs?                                                                                                                                                                               | **Yes, as for reviewed managed installs**, since every update has waited, been reconfirmed and is pinned; the update details state that the game was not reviewed by a person. The alternative (`notify` only) adds a step to every update.                                                                                                                                                                                                                                                               |
| D13 | Should definition delivery get a minimum supported reader (Preview 15 or later), as listing delivery has Preview 14?                                                                                                                                        | **No.** Previews 13 and 14 skip a definition they cannot read, one game at a time, and keep registration and the listing download for it (read from their tagged sources; slice 4 confirms with a test). A minimum would cut older apps off from every definition change.                                                                                                                                                                                                                                 |
| D14 | A generated curated record has two required fields named `independent_review` and `protected_acceptance`, and no person reviews a generated file. Fill them with automated references (A), or add a new record version with an honest acceptance class (B)? | **B.** A new record version 3 with acceptance class `automatic-first-observation-v1`, behind a named feature. Cost: automatic managed installs only on the app version that has it; older apps keep registration and the listing download for those games. A reaches every app at once, but makes the review fields mean less on every record, reviewed or not, and contradicts D1. Details in 4.6.                                                                                                       |
| D15 | When a project's own words say game files are included ("game files included", "no ROM needed"), may a complete clean content scan clear it automatically?                                                                                                  | **No: a person decides.** The scan cannot see extracted textures, audio, text or pack files, so a clean scan is missing evidence, not absence, and "bundled game data stays held". Cost: one person decision per affected text (grouped queue `rights-includes-original`); the share of candidates affected is measured in slice 1 before the block starts in slice 5. Alternative: clear automatically on a clean scan (more tier 3, but contradicts the tier rule when the scan misses extracted data). |
| D16 | Generated games have no way to stop one installed version: omission stops new downloads only, and revoking stops every installed version. Accept that, or build per-version revocation?                                                                     | **Accept it for the first slices**, and use whole-game revocation only for a dangerous release, where stopping all versions is the safe side. Per-version revocation needs a Core change (a withdrawal record every library can admit, receipts bounded per game) and a new app version; it can follow as its own slice. A revoked game returns with a higher-revision policy decision (slice 8 tests that installed versions launch again).                                                              |

## 13. Staged implementation plan

Each slice is one pull request, mergeable alone, with its own independent
review and required CI. "Readback" means a released client reads the result
from the live signed catalog. Slices that change verification rules (marked
**V**) are shown to the owner before merge.

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                                              | Acceptance evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Depends on                           | Blocked on decision       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------- |
| 0     | Facts job repairs (real observer path, landed in #8661; release text in the observer; per-entry reproduction refusal). Commit the 131 hand-verified identities as a fixture with the hand-check they came from.                                                                                                                                                                                      | A real-path dry run that enrolls registrations and reports the fate of every identity in the committed fixture.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                    | —                         |
| 1     | Facts format 18: asset, release and tag ids, the tag's commit, observed digest, every archive's players, rights texts (whole release body, README, licence, in-package notices) with phrase matches recorded but not enforced. No behavior change.                                                                                                                                                   | Fixture and real dry-run tables validate; reproduction re-derives every new field; a phrase that sits past byte 4,096 of a fixture body and one in a fixture README are both matched; a moved-tag fixture is detected; a match report by phrase and source over the real dry run.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 0                                    | —                         |
| 2     | Complete content scan in the facts worker over the bytes it already reads (all heads, no 64-file cut), recorded per artifact. **V** (what "complete" means).                                                                                                                                                                                                                                         | Parity with `release-content-scan.mts` signals on its fixtures and on a committed target list: before run 45381027365's report artifact expires (30 days, about 2026-12-24), its 320 package rows (repository, asset id, size, SHA-256, signals, cut status) are committed as a fixture with the artifact's SHA-256; if it has expired, the newest scheduled run's report is committed the same way. The worker re-downloads those packages by digest. Every record `complete` or a typed reason.                                                                                                                                                                                                                                  | 1                                    | —                         |
| 3     | Sharded pin ledger with three keys and the append-only, timestamp and compaction checks; `acquisition-policy.json` outside the batch allowlist; tier table and `acquisition_queues` as reporting only; the generated release-scoped listing hold with its reserved id. **V** (pin conflict refusal, D10).                                                                                            | Ledger tests: removal, edit, backward state and backdated `first_observed_at` refused; recreated tag with same bytes → `pinned`, with different bytes → `replaced`, with all-new names → `release-recreated`. On the Preview 14 tagged reader, a fixture conflict release is refused for listing download and another release of the same listing is still offered. A listing without a release route gets no generated hold and its download is unchanged. The reserved id is refused on an authored row; a 65th generated row stops generation for that listing. The managed route still offers the older pin. Queue counts on a real dry run; owner sees the first measured funnel.                                             | 1, 2                                 | D10                       |
| 4     | Core: `player_choice_v1` definition feature, the choice offer, record and carry rule with the asset-name family check; CLI and Desktop present it.                                                                                                                                                                                                                                                   | Core tests for offer, record, carry, family change → confirmation, `choice-required`, `choice-stale`; machine-contract fixtures; Desktop browser tests; native Windows run of a fixture choice. A test against the tagged sources of Previews 13 and 14 showing whether a refused schema-4 entry leaves siblings, policies and installs unaffected (settles D13).                                                                                                                                                                                                                                                                                                                                                                  | #8496 (merged)                       | —                         |
| 5a    | Existing-registration and demotion compatibility in Core: a registration launches from its retained contract after its definition becomes managed; a demoted managed install keeps launching and rolling back.                                                                                                                                                                                       | Upgraded-library tests: a library with a registration and one with a managed install, made on the current preview, still launch after promotion and after demotion; saves and other files inside and outside the game folder byte-identical; no conversion of a registration.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 3                                    | —                         |
| 5     | Generation of managed records (replacing only generated registrations) with curated records mapped as in 4.6 (tag commit included; the two acceptance fields per D14: with option B, Core's record version 3 and its definition feature land here), grant prefix `managed-github-v1-generated-`; publisher accepts them; `rights-terms` and `rights-text-unread` enforced. **V** (D1, D2, D11, D14). | Gate parity; every generated record passes Core's record validation and `verify_metadata` against the observed tag commit; measured size of a managed record against CD-03, CD-06 and the compact carrier; a canary generated definition published; **released-client readback**: a fresh library on the current preview installs, updates, rolls back and removes it on Windows and still offers the existing-copy registration; on a reader without the record feature (Preview 14), only that identity is skipped and its siblings refresh.                                                                                                                                                                                     | 3, 5a; 4 for choices                 | D1, D2, D3, D11, D14, D15 |
| 6     | Split packages: multi-archive choice unpacked into one version folder with collision refusal.                                                                                                                                                                                                                                                                                                        | Core collision and order tests; readback of one real split-package identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 5                                    | (as 5)                    |
| 7     | Waiting period with reconfirmation, the end-of-wait due list and the blocked state in generation, keyed to the facts table's `generated_at`; update details copy; confirm what `automatic` update policy does. **V** (72-hour wait).                                                                                                                                                                 | Generation tests at the boundary hour, without a fresh observation, and with a changed asset during the wait; a real update observed waiting and then offered within the wait plus one batch interval; readback shows the previous release while waiting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 5                                    | D4, D9, D12               |
| 8     | Withdrawal by omission: artifact-scoped holds and ledger `deleted`/`conflict`/`replaced`/`tag-moved` omit artifacts; emergency withdrawal through the whole-definition `Revoked` decision; no generated `curated_transitions`; retraction-time report.                                                                                                                                               | A library that admitted an artifact and a **fresh library** both admit the next generated policy after that artifact is omitted (confirms `future_curated_acceptance_lost` is false, 4.6); a `Revoked` generated definition is admitted by both, holds launch of its installed versions, and a later higher-revision decision restores launch (or the result is recorded); zero transition receipts consumed by generated policies; the measured time from publication to a library no longer offering an omitted file, with and without a manual refresh, and whether a stale selection still offers it; readback on a client that installed a withdrawn artifact: still playable, no fresh download; the retraction-time report. | 5                                    | D16                       |
| 9     | Typed `install`/`update` holds on generated definitions, under their own feature name.                                                                                                                                                                                                                                                                                                               | Restriction evaluation tests across both carriers; readback on Preview 15 or later; the schema-4 gate of 4.6 satisfied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 4, 5                                 | —                         |
| 10    | Switch on promotion in the batch job.                                                                                                                                                                                                                                                                                                                                                                | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 5, 5a, 7, 8, 11; register rows below | D3, D8, D12               |
| 11    | Core: scheduled definition refresh visits definitions whose index entry or policy changed since the library's last refresh first, then continues the existing rotation, under the existing time budget; removes the 32-a-day ceiling for change delivery (section 11).                                                                                                                               | Core tests with 1,450 fixture definitions: a changed definition is admitted at the next scheduled refresh; unchanged ones keep rotating; the time budget holds; Previews 13 to 17 unaffected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                    | —                         |

**Slice 10 acceptance (measurable).**

1. The first promoting batch promotes at least one identity. For every
   promoted identity the tier table shows P1 to P10 passing with evidence,
   and `--check` reproduces it.
2. A gate query over the batch returns zero promoted identities with an
   authored hold, an unresolved rights block, an incomplete scan, an
   incomplete rights text or a non-`pinned` ledger row.
3. Compared with the previous tier table, zero identities have a lower tier,
   and zero listings carry a whole-listing generated hold.
4. The capacity report after the batch shows catalog (CD-03), definitions
   (CD-06) and the compact carrier (CD-02, wire) each below their existing
   85% guard, and zero transition receipts consumed by generated policies.
5. Readback of the first publication run after the merge shows the
   published generated definition count equal to the batch's, and one
   promoted identity is installed, launched and removed on Windows on the
   current preview.
6. The queue report is published and its queue counts sum to the candidate
   pool.

**Register rows promotion depends on.** These class 4 rows are retained,
not removed, by this design; promotion depends on them as stated:

- **CD-03, CD-06** and the compact carrier (CD-02): every promoting batch
  stops at their guards. Slice 10 cannot promote past them; their removal is
  the distribution scaling work.
- **SR-01, SR-02**: identities whose guide leaves no room stay `guide-bound`;
  promotion of those identities waits for the bound's removal.
- **DM-01**: a release past 32 assets is incomplete coverage and is not
  promoted; those identities wait for DM-01's removal.
- **Transition and receipt bounds** (section 11): generated definitions do
  not use the transition path (slice 8 proves zero receipts). Per-version
  revocation for generated games (D16) depends on the Core change in
  section 11 that bounds receipts per definition and accepts a transition
  for an unadmitted artifact.
- **Scheduled refresh, 32 a day**: removed by slice 11, a dependency of
  slice 10.

**Startable now without an owner decision:** slices 0, 1, 2, 4, 5a and 11.

**Parallel work.** Slices 1 and 4 can run in parallel (data versus Core).
Slice 2, slice 5a and the Core half of slice 6 can run in parallel with
slice 4. Slices 7 and 8 can run in parallel after 5. Slice 0 is owned by the
repair sessions already running and blocks everything that needs real data.
The CODEOWNERS entry of D9 is an owner step that can happen at any time
before slice 7.

## 14. Alternatives considered

| Alternative                                                   | Decision                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trust the provider digest at download time, no pin            | Rejected: a replaced asset with a new provider digest would be accepted silently. The owner's rule forbids that.                                                                                            |
| Re-host verified bytes                                        | Rejected: tier 4 is never offered.                                                                                                                                                                          |
| Client-side waiting period on the player's clock              | Rejected: the signed-catalog contract does not trust the host clock; a wrong clock would bypass the wait.                                                                                                   |
| A person reviews each promoted package                        | Rejected as the default: per-game work. Kept for conflicts, findings and wording that names terms.                                                                                                          |
| Let names choose the file when one candidate is "most likely" | Rejected: names may only nominate and detect contradictions. A guess could install the wrong program.                                                                                                       |
| A new carrier for generated holds                             | Rejected: the typed restriction model already covers person decisions; generation-time omission and the whole-definition `Revoked` decision cover withdrawal until slice 9 delivers typed definition holds. |
| An AI reading of release notes                                | Rejected: no AI service in the pipeline; a closed phrase list is reproducible.                                                                                                                              |
| A whole-listing listing hold on every pin conflict            | Rejected in revision 4: where a listing cannot name the release, it would remove a working listing download for every release, which moves the listing down.                                                |
| Keep only the first 4,096 bytes of release text               | Rejected in revision 4: a prohibition past the cut was never seen, and a content scan cannot resolve terms.                                                                                                 |

## 15. Open risks and UNKNOWNs

- Whether a library holding a stale selection still offers an omitted file
  for install: UNKNOWN until slice 8 measures it.
- Whether a library restores launch of installed versions after a revoked
  generated game gets a higher-revision decision that is not `Revoked`:
  UNKNOWN until slice 8 tests it.
- Settled in revision 6 from `definition_publisher_policy.rs`: omission does
  not lose acceptance for a library that admitted the artifact, because
  `future_curated_acceptance_lost` is false for a stable id with no
  transition receipt (P1 guarantees none).
- How many of the 992 candidate identities publish a stable desktop package
  with a provider digest: UNKNOWN until the facts job inspects them.
- How many fail the complete content scan or its rules: UNKNOWN.
- How mechanism 2 changes the count beyond the 131-identity sample: UNKNOWN.
- Upstream retraction times for the waiting-period review: UNKNOWN until
  slice 8 measures them.
- Whether `native-portable` validates a definition with no persistent paths
  and a player-chosen executable without a new capability: to be confirmed in
  slice 4 against `adapter.rs` and the capability negotiation.
- Previews 13 and 14 skip a refused schema-4 entry per identity in
  scheduled refresh (read from their tagged `definition_refresh.rs`); slice
  4's test confirms it, including a manual refresh of that one game.
- Where the refusal of an existing registration after promotion surfaces
  (`check_user_selected_retained_runtime`): UNKNOWN until slice 5a's test.
- False-positive rate of the prohibition phrases over READMEs and notices:
  UNKNOWN until slice 1's report.
- Whether a library that admitted an omitted artifact derives lost future
  acceptance from its retained state, and what that requires: UNKNOWN until
  slice 8's test.
- Settled in revision 5 from `definition_refresh.rs`: policies are admitted
  for every official definition the library knows, installed or not, and a
  refused subject is skipped without failing its siblings (also at Previews
  13 and 14).
- The size of a generated managed record with exact artifact selectors and a
  choice list is not measured. The 8.7 KB figure is for generated
  registration routes. Slice 5 measures it before the capacity estimate is
  used.
- The listing download inconsistency in D6 stays until the owner decides it.

## Appendix: measurement method

All commands ran on `main` at `534652ab2` in a clean checkout.

1. **Listings, definitions, route kinds.** Python over
   `crates/portcove-core/catalog/listings.json` (`listings`) and
   `catalog.json` (`ports`): counts, `adapter`, and `release.provider`
   (`github` when absent and `release.repository` is set). Listing-only means
   a listing id with no port id.
2. **Dispositions.** `node scripts/catalog-route-fit.mts --json` with no
   observer report (`observer_report: "absent"`), so every observation state
   is `none`. Its `identities[].disposition` and `family` give section 2.1's
   enrolled listings and section 2.5's table, joined with the hold rows of
   step 3.
3. **Holds.** Every `restrictions[]` row with `effect: "hold"` in
   `listings.json`, grouped by `reason` and by whether the listing has a
   definition; plus every `managed_acquisition_hold` in `catalog.json`. Every
   listing hold has `operations: ["download"]` and no scope.
4. **Listing download bound.** Listing-only, no `download` hold, host of
   `release_url` or else `project_url` equal to `github.com` or containing
   `gitlab`, grouped by `availability`.
5. **Facts.** `listing-package-facts.generated.json`: `entries` is empty,
   format 17, `generated_at` 2026-11-23T00:00:00Z.
6. **Content scan.** The artifact `release-content-scan-45381027365-1` (id
   14914002010, SHA-256 `66ceb526…94b09ab`, which matched the artifact
   record) holds `report.json` format 3. Counts are lengths of `scanned`,
   `reused_targets`, `findings`, `unscanned` (grouped by `code`) and
   `accounting_unmatched`. `heads_truncated` is true when the candidate list
   exceeded 64 files (`scripts/release-content-scan.mts`, the
   `heads_truncated` assignment). An identity's targets are all rows with its
   id; "every target scanned" means at least one scanned or reused row and no
   unscanned row. Reused rows carry no truncation field, so their cut status
   is UNKNOWN.
7. **Name-rule withholds (63 of 131).** The lead's real-data measurement
   "run7" on `main` `0316192e`, lead-recorded local evidence. The cited #1422
   comment does not contain these figures. The identity set and the run's
   tables are not committed, so this repository cannot reproduce them; slice
   0 commits the set.
8. **Revision 4 code reads.** `git show nightly-0.1.0-preview.N:<path>` for
   N = 13 to 17 over `acquisition_restriction.rs`, `definition_entry.rs`,
   `definition_acquisition.rs` and `definition_publisher_policy.rs`; current
   `main` for `curated_acquisition.rs`, `service/user_selected.rs`,
   `types.rs`, `scripts/release-content-signals.mts` and
   `scripts/listing-facts-batch.mts`.
