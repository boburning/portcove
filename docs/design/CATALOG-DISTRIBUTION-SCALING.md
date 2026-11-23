# Scaling signed catalog distribution (design, November 23, 2026)

Proposed design, revision 3. Nothing here is implemented or activated. The
[signed catalog contract](../SIGNED-CATALOG.md), the
[definition delivery contract](../DEFINITION-DELIVERY.md) and
[RELEASING](../RELEASING.md) stay the current contracts until each step below
lands through its own pull request. Work belongs to
[#1422](https://github.com/boburning/portcove/issues/1422) (bounded publication
across repeated history growth) and
[#246](https://github.com/boburning/portcove/issues/246) (ordered frozen-client
delivery). Source: `main` at `14ed722fa`. Measurements: the `gh-pages` tree at
`c912fc37b87a34da26a5944c7aa656e8a70eb92c` (the last catalog publication,
2026-11-23T16:09Z; the later `gh-pages` head `758583339` only moves the Preview
pointer), a `gh-pages`-only clone, and anonymous Pages GETs on the same day.

**Revision 3** applies the owner's pre-beta compatibility amendment, recorded on
#1422 on 2026-11-23:

- Obsolete preview catalog formats and application-selected 4/8 MiB
  whole-catalog ceilings must not constrain the architecture.
- There is one minimum supported preview generation for live catalog updates.
  Older previews may need an application update before they receive further
  catalog changes.
- Installed data and the forward upgrade path are preserved.
- Trust and revision protections stay intact.

#8619 is being rewritten as a **compact-only** listing cutover. So this
revision:

- re-derives runway and churn for compact-only delivery;
- compares chunking against compact-only by measurement and makes the chunked
  manifest a later, triggered step;
- replaces the per-carrier compatibility matrix with a minimum
  supported generation;
- justifies every size bound.

Revision 2's security fixes stay: definitions remain under their own role, the
withdrawal-union fallback stays, a ledger is written before any historical body
is pruned, and bootstrap and root rotation remain owner-only.

## Summary

- **Default plan: compact-only delivery with corrected retention.**
  - **Cutover.** After the #8619 cutover, one compact target carries the full
    directory (1,649 rows with every observation). The minimum supported
    generation for live listing updates is the first compact-capable preview.
    Older previews keep their stored and bundled data, their library and
    installs, and update through the application updater.
  - **Measured at 1×:** 11.89 MB decoded and 3.45 MB on the wire. Each change
    rewrites the whole body.
- **Runway: about 13.5–17.3 days after the cutover, so retention is urgent.**
  The retained tree holds 404,914,714 of 805,306,368 bytes; 390,631,685 of
  them are 47 legacy bodies. A compact-only change adds about 3.45 MB, at
  6.7–8.6 changes a day. A body window (current and previous compact body, plus
  pins) cuts the served catalog tree to about 21 MB, after which it grows only
  by about 36 KB a day of metadata. The ledger must be written before the first
  prune, because `verify_history` reads every historical body today.
- **Compact-only is sufficient at today's size, except for Git history.**

  | Per publication, measured or derived    | Compact-only 1× / 5× / 10×  | Chunked manifest 1× / 5× / 10× |
  | --------------------------------------- | --------------------------- | ------------------------------ |
  | Changed bytes (served and Git)          | 3.45 / 17.2 / 34.5 MB       | 0.31 / ≈1.8 / ≈3.5 MB          |
  | Client transfer per daily refresh       | 3.45 / 17.2 / 34.5 MB       | 1.2–1.6 / ≈4.9 / ≈9.7 MB       |
  | `gh-pages` history growth a day         | 23–28 / 92–117 / 179–228 MB | ≈7.9 / ≈19 / ≈33 MB            |
  | Days until the 2 GiB history compaction | 75–91 / 18–23 / 9–12        | ≈265 / ≈107 / ≈64              |
  | Served catalog tree with the window     | 21 / 49 / 83 MB             | 17 / ≈30 / ≈45 MB              |

  At 1×, compact-only costs an owner `gh-pages` compaction about every 75–91
  days, or 94–118 with the stop-gap. Its other numbers are within the hosting
  limits. **The chunked manifest is therefore a later, optional step.** It
  starts when the per-run report projects compaction more often than every 60
  days, when the compact body reaches 70% of its justified bound, or when the
  owner prefers it to recurring compaction (3.0). At the measured density, the
  first trigger arrives at about 1.3–1.5× today's rows.

- **Churn without the legacy byte budget is small.** Revision 1's large
  observation churn came from the legacy budget dropping and re-adding
  observations. Without it, a publication changes the facts of 4–22 rows and
  only the timestamps of 118–414 rows. Compact-only rewrites 100% of the body
  for either. Chunking would rewrite 0–19 of 64 observation chunks (mean
  230 KB) plus one 49 KB freshness object.
- **Definitions** stay on `official-definitions`. Policy decision schema 2
  removes the O(n) rebind by binding `namespace`, `stable_id` and
  `entry_sha256` instead of the global index digest (4).
- **History** uses the previous checkpoint plus a 16-deep suffix: at most 18
  objects a run, with no epochs (6.4).
- **Every bound is justified** in 3.9. The compact carrier's 8 MiB wire and
  32 MiB decoded bounds are application choices that fail at about 2.4× and
  2.8× today's rows. This design supplies the measurements; the lead's separate
  ceiling-inventory change replaces them.

## 1. Owner requirements and the mechanism that satisfies each

| Owner requirement                                                                                                                                                                              | Mechanism                                                                                                                                                                                         | Section       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| "Distribution that reuses unchanged content and avoids an ever-growing aggregate download: a small authenticated manifest referencing stable, content-addressed chunks"                        | Specified as the triggered phase 2 (3.1–3.8). Compact-only ships first because, at 1×, its measured cost is acceptable except for Git history, which sets the trigger (3.0).                      | 3.0–3.8       |
| "integrated with the existing trust model (TUF roles, revision floors, expiry). Choose the smallest compatible implementation."                                                                | Compact-only adds nothing. The phase-2 manifest is one more `policy/official/*.json` target. `official-definitions` keeps exactly `definitions/index.json` and `sha256/*.json`.                   | 3.0, 3.2, 4   |
| "Preserve authenticated identity, revision floors, expiry, withdrawals, restrictions and capability checks."                                                                                   | One shared listing revision floor, with distinct revisions per carrier. A persisted safety floor (withdrawal union and floor-revision holds) applies to every fallback, bundled included.         | 3.2, 5        |
| "Download and verify only changed or needed content."                                                                                                                                          | Phase 2: the reader fetches only absent digests. Each object is checked for length and digest, then decoded length and decoded digest.                                                            | 3.6           |
| "Stable chunking … quantify rewrite fraction for 1, 10, 100 changed records at current, 5× and 10× catalog sizes."                                                                             | Split-only ID-hash prefixes, measured in 3.4. Compact-only rewrites 100% in every cell.                                                                                                           | 3.4           |
| "Coherent activation … all-or-nothing adoption" and "Preserve the previously accepted usable state …"                                                                                          | Compact: the existing single transaction. Phase 2: stage, assemble, validate, then one transaction stores the assembled document, its digest and both floors.                                     | 3.6, 3.8      |
| "Bounded individual objects and requests while supporting complete catalogs through continuation."                                                                                             | Every bound is derived in 3.9. Manifest continuation is reserved and not needed until about 32× today's rows.                                                                                     | 3.3, 3.9      |
| "Explicit older-client behavior including safety withdrawals and an upgrade path, WITHOUT indefinite duplication of complete historical projections …" (amended: minimum supported generation) | One live carrier. Previews below the minimum generation keep stored and bundled data, library and installs, and update the application. No frozen projections and no final-safety-form machinery. | 5             |
| "Prove a compatible catalog addition made after a client was built reaches that unchanged capable client." (amended: verify with the actual newly released supported client)                   | The T-ADD frozen-binary harness, plus a readback by the actual released supported client of each cutover.                                                                                         | 5.3, 8        |
| "Cover ALL consumers …"                                                                                                                                                                        | Per-consumer rows in 2.1 and 3.5. Definitions are covered by policy schema 2.                                                                                                                     | 2.1, 3.5, 4   |
| "Publication history: bound verification work as publication count grows" and "preserve the revision and authority evidence …"                                                                 | Before bootstrap: a listing-floor ledger and a body window. After it: the previous checkpoint plus a 16-deep suffix, carrying cumulative floors.                                                  | 6.1, 6.4      |
| "continuation across trusted-root rotation" and carrier recovery                                                                                                                               | A root-transition checkpoint, and a carrier-set change rule.                                                                                                                                      | 6.5           |
| "retention that preserves supported rollback/recovery …" and "restoration from a pinned last-good publication"                                                                                 | Current plus previous body plus pins, a pin store, a manual restore runbook, then `restore-publication`.                                                                                          | 6.1, 6.2, 6.5 |
| "measure active bytes, retained bytes, changed bytes per publication and client transfer"                                                                                                      | 2.2 holds today's numbers. PR 2 records them on every run, plus the projected compaction interval.                                                                                                | 2.2, 9        |
| "$0 hosting …; no new infrastructure …; playing an installed game never depends on any of this; ScummVM unchanged."                                                                            | GitHub Pages and the `gh-pages` branch only. Git growth is measured and has a trigger. Launch reads only retained local contracts.                                                                | 3.9, 6.6      |

## 2. Current architecture and measurements

### 2.1 Consumers

| Consumer                    | What it reads or writes today                                                                                                                                                                                                                                                                                                                                                                                                                       | Scaling limit                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing carriers (Core)     | `listing_delivery::acquire_listings` reads one target: compact when signed metadata names it, legacy otherwise. Bounds: 8 MiB wire; compact decoded at most 32 MiB, 1 MiB per record and 10,000 records. `admit_listings` (`listing_delivery.rs` ~787) refuses a lower revision or an equal revision with different bytes. `AuthenticatedListings::stored` (~614) refuses stored legacy and compact rows at an equal revision with different bytes. | Every change re-downloads the whole document. Legacy is full at 8,388,398 of 8,388,608 bytes and drops optional observations to fit. Compact with every observation fails its 8 MiB wire bound at about 2.4× today's rows. |
| Definition index            | `definitions/index.json` plus content-addressed `sha256/<hex>.json` leaves, signed by `official-definitions`. Bounds: 4 MiB index, 4,096 definitions and a 32 MiB content budget. Each policy decision binds the global `index_sha256` (`definition_publisher_policy.rs` ~269 and ~681). The receipt labels the result `retained-index-rebind` (`scripts/catalog-publication-receipt.mts` ~250).                                                    | One addition re-signs the policy and launch targets of all N definitions. At today's 17.4 KB of content per definition, the content budget is reached at about 1,900 definitions (4.4).                                    |
| Execution content           | Entry and contract leaves, immutable and content-addressed. Installs keep the exact bytes.                                                                                                                                                                                                                                                                                                                                                          | Each leaf grows `official-definitions` metadata.                                                                                                                                                                           |
| Publisher tooling           | `catalog-publish.yml`: prepare (keyless), four signing jobs, publish. Prepare fetches the full `gh-pages` history (~84). `verify_history` (`repository.rs` ~261) runs `HistoricalRevisionFloors::observe` (~541–640) over every retained metadata version. That reads every historical listing body for revision, decoded SHA-256 and withdrawals, and refuses equivocation. It bounds other `policy/official` targets at 65,536 bytes.             | No deletion route exists, and pruning a body without a replacement breaks the next run (6.1).                                                                                                                              |
| History checkpoints (inert) | `history_checkpoint.rs`: a pointer target, checkpoints and segments under `catalog-history/sha256/`, with a shared bound of 4,096 objects and 64 MiB. Root mismatch fails with `ROOT_ROTATED`. Bootstrap is a manual owner dispatch.                                                                                                                                                                                                                | The chain bound is reached after about 2,048 publications, about 8.7 months at 7.8 publications a day.                                                                                                                     |
| Caches (client)             | SQLite `listing_delivery`, `compact_listing_delivery`, `definition_publisher_authority` (replay floor), `definition_selection_state`, `definition_subject_selection`. `CURRENT_SCHEMA_VERSION` 77.                                                                                                                                                                                                                                                  | There is no persisted safety state separate from carrier rows, so a bundled fallback loses remote withdrawals.                                                                                                             |
| Release-side readers        | `catalog-released-reader.mts` selects and attests the Preview reader. Publish restores `PRIOR_COMMIT` with `--depth=1` (~308).                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                          |
| Transport                   | `reqwest` without `gzip`, plain `GET`s, no redirects or `Range`; 20 s per request, 120 s overall, eight concurrent.                                                                                                                                                                                                                                                                                                                                 | Pages offers gzip, but Portcove never asks for it. That matters only for metadata once compact (already gzip) is the only carrier.                                                                                         |

### 2.2 Measured numbers (2026-11-23)

The method is in the [appendix](#appendix-measurement-method). All byte counts
are exact unless marked ≈.

**Served tree at `c912fc37`:** 1,614 files, 404,921,640 bytes. The retained
catalog tree checked by the 768 MiB bound is 404,914,714 bytes, leaving
400,391,654.

| Part                                       | Files | Bytes       |
| ------------------------------------------ | ----- | ----------- |
| Legacy listing bodies (47 versions)        | 47    | 390,631,685 |
| `browse/` (projection, search, game pages) | 1,294 | 13,787,563  |
| Metadata (60 versions of three roles)      | 183   | 280,308     |
| Other targets (leaves, index, policies)    | 87    | 215,158     |
| Everything except listing bodies           | 1,567 | 14,289,955  |

**Publication rate.**

- Policy v1–v60 took 7.69 days: 7.8 publications a day.
- Listing bodies changed in 46 transitions over the 5.35 days ending
  2026-11-23T15:53Z, which is **8.6 a day**. #8619 measured **6.7 a day** over
  the week.
- 25 of the 46 transitions changed a descriptive field or the withdrawals:
  4.7 a day, and 3.4 a day over the last 50 hours.

**Authored descriptive rows** (`crates/portcove-core/catalog/listings.json` at
`5ea4d3570`): format 15, **1,649 rows, which is 1× throughout**. They are
5,364,231 bytes as canonical JSON; the largest record is 8,517 bytes.

**Observation churn without the legacy byte budget.**

- **Method.** Only the 47 legacy bodies record observations, and they are
  byte-budgeted. The reconstruction carries each ID's latest published
  observation forward when a body omits it, which is compact's rule.
- **Coverage.** 1,458 of the 1,649 IDs have an observation at some point.

| From → to | Legacy as served: appeared · vanished · facts changed (rows in both) | Without the budget: facts changed · freshness only |
| --------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| v54 → v55 | 70 · 99 · 3                                                          | 22 · 173                                           |
| v55 → v56 | 66 · 91 · 14                                                         | 20 · 282                                           |
| v56 → v57 | 46 · 35 · 4                                                          | 11 · 161                                           |
| v57 → v58 | 39 · 18 · 1                                                          | 4 · 140                                            |
| v58 → v59 | 146 · 117 · 1                                                        | 10 · 118                                           |
| v59 → v60 | 99 · 81 · 11                                                         | 11 · 414                                           |

- **Every transition changes freshness**, so a compact-only body changes on
  every publication that carries an observer run.
- **The reconstruction is a lower bound.** Refreshes of rows the budget
  omitted are invisible. PR 0 settles this with an observer-enriched dry run.

**Compact-only body, measured.** The format-15 directory of the authored rows
plus every reconstructed observation, encoded as `gzip-base64-json-v1` with
gzip level 6, the same as `encodeCompactListing`. The same encoder on the v60
observations gives 9,858,222 / 2,848,281 bytes, within 3–4% of #8619's
9,602,327 / 2,745,010.

| Catalog | Rows   | Decoded     | gzip       | Wire (base64 JSON) | Against today's compact bounds (32 MiB decoded, 8 MiB wire) |
| ------- | ------ | ----------- | ---------- | ------------------ | ----------------------------------------------------------- |
| 1×      | 1,649  | 11,893,946  | 2,584,982  | 3,446,810          | 35% / 41%                                                   |
| 5×      | 8,245  | 59,489,082  | 12,923,357 | 17,231,310         | exceeds both                                                |
| 10×     | 16,490 | 118,983,002 | 25,845,894 | 34,461,359         | exceeds both                                                |

**Git history of `gh-pages`** (`git count-objects -vH` on a
`--single-branch --bare` clone at `758583339`): 74 commits, 111,748 objects,
**63.87 MiB packed** over 9.9 days, about 6.8 MB a day.

| Path                     | Blob versions | Raw bytes   | Packed bytes | Packed per publication |
| ------------------------ | ------------- | ----------- | ------------ | ---------------------- |
| `browse/`                | 110,777       | 544,495,879 | 49,695,341   | ≈0.71 MB               |
| Legacy listing bodies    | 47            | 390,631,685 | 13,922,603   | ≈0.30 MB per change    |
| Metadata, targets, trees | 835           | 1,154,535   | 176,242      | ≈2.5 KB                |

**Delta behavior,** measured by committing v59 and then v60 to a scratch
repository and repacking with `--window=250`:

| Encoding of the same listing change | File size | Added to the pack |
| ----------------------------------- | --------- | ----------------- |
| Raw JSON (legacy)                   | 8,388,398 | 88 KiB            |
| gzip level 9                        | 1,788,857 | 1,743 KiB         |
| base64 of gzip (compact's carrier)  | 2,385,144 | 1,761 KiB         |

A compressed body adds about its gzip size to history on every change: about
2.58 MB per compact change at 1×.

**Pages runway** (400,391,654 bytes left):

| Situation                                            | Changes a day | Growth a day | Days left        |
| ---------------------------------------------------- | ------------- | ------------ | ---------------- |
| Legacy only (today)                                  | 6.7–8.6       | 56–72 MB     | 5.5–7.1          |
| **Compact-only cutover**, 3,446,810 bytes per change | 6.7–8.6       | 23.1–29.6 MB | **13.5–17.3**    |
| Compact-only plus the stop-gap (6.3)                 | 5.4–6.7       | 18.6–23.1 MB | 17.3–21.5        |
| Body window active (6.1), any of the above           | —             | ≈0.036 MB    | effectively none |

**Body retention stays urgent after the cutover.** It is the only step that
bounds the served tree. Retention should be active within about a week of the
cutover.

**Bandwidth** (GitHub's soft limit of 100 GB a month, one refresh per client
per day): compact-only at 1× is 3.45 MB per client-day, about 970 daily clients.
Chunked is 1.2–1.6 MB, about 2,100–2,800 clients. Client counts are UNKNOWN;
there is no telemetry.

### 2.3 Why the current shape does not scale

- **Retention grows with every publication.** Complete projections are kept
  forever: 96.5% of the served tree today.
- **Transfer grows with the catalog, not the change.** A freshness-only change
  rewrites and re-downloads the whole directory.
- **Preview-era ceilings set the architecture.** The legacy target is full,
  and compact's 8 MiB wire bound fails at about 2.4×.
- **Definition work is O(N) per addition.**
- **Verification is linear in history.**
- **Compressed whole bodies inflate Git history.** About 2.58 MB per compact
  change, against 0.30 MB for legacy JSON.

## 3. Proposed design

### 3.0 Compact-only first; chunked manifest when triggered

**Phase 1 (default, now).** The #8619 compact-only cutover delivers:

- the full directory, with no byte budget;
- body-window retention with the ledger (6.1);
- the persisted safety floor (3.2);
- the per-run report (PR 2);
- policy schema 2 (4);
- history groundwork (6.4).

**Measured comparison.** Changed bytes per publication equal the new served
bytes, and roughly the Git growth.

| Measure (per publication unless stated)   | Compact-only 1× | Chunked 1× | Compact-only 5× | Chunked 5× | Compact-only 10× | Chunked 10× |
| ----------------------------------------- | --------------- | ---------- | --------------- | ---------- | ---------------- | ----------- |
| Changed bytes (wire)                      | 3.45 MB         | 0.31 MB    | 17.2 MB         | ≈1.8 MB    | 34.5 MB          | ≈3.5 MB     |
| Git growth from listings                  | 2.58 MB         | 0.31 MB    | 12.9 MB         | ≈1.8 MB    | 25.8 MB          | ≈3.5 MB     |
| Client transfer, daily refresh            | 3.45 MB         | 1.2–1.6 MB | 17.2 MB         | ≈4.9 MB    | 34.5 MB          | ≈9.7 MB     |
| Client transfer, cold                     | 3.45 MB         | 2.86 MB    | 17.2 MB         | ≈13.8 MB   | 34.5 MB          | ≈27.6 MB    |
| History growth a day, including `browse/` | 23–28 MB        | ≈7.9 MB    | 92–117 MB       | ≈19 MB     | 179–228 MB       | ≈33 MB      |
| Days to the 2 GiB history trigger         | 75–91           | ≈265       | 18–23           | ≈107       | 9–12             | ≈64         |
| Served catalog tree with the window       | 21 MB           | 17 MB      | 49 MB           | ≈30 MB     | 83 MB            | ≈45 MB      |

- **Measured columns.** Chunked 1× is measured (3.4). The 5× and 10× chunked
  cells assume fact-change and refresh counts scale with rows, which is
  UNKNOWN.
- **Per-day rates** assume 6.7–8.6 listing changes and 7.7 publications a day.

**Verdict.** At 1×, compact-only is sufficient for served storage, bandwidth
and correctness. Its cost is Git history: the 2 GiB `gh-pages` compaction (6.6)
every 75–91 days, or 94–118 days with the stop-gap. At 5×, it would need
compaction every few weeks, and the carrier bounds must be replaced in any
case. Chunking roughly divides changed bytes by 11 and history growth by 3–7.

**Triggers for phase 2.** Start the chunked manifest when any of these holds,
using the PR 2 report's 14-day average:

1. The projected interval between history compactions falls below 60 days.
   That is two months of owner force-push exceptions. At measured density, it
   happens at about 1.3–1.5× today's rows.
2. The compact wire size reaches 70% of its justified bound (3.9). That leaves
   about 30% growth headroom while the release and gate run.
3. The owner chooses chunking over recurring compaction.

Phase 2 needs PR 3, PR 4 released, and PR 6. PR 3 is pure code and may start
earlier as groundwork.

### 3.1 Phase 2 overview

```text
timestamp.json ─▶ N.snapshot.json ─▶ N.official-policy.json      (existing roles, keys, expiry)
                                        │  names, by length + SHA-256:
                                        ├─ policy/official/catalog.listings.compact.json  (until the manifest generation is the minimum)
                                        └─ policy/official/catalog.manifest.json          (NEW, ≤1 MiB)
                                               │ names, by stored length, SHA-256, decoded length, decoded SHA-256:
                                               ├─ objects/sha256/<hex>.jsonl.gz   descriptive stream chunks
                                               ├─ objects/sha256/<hex>.jsonl.gz   observation stream chunks
                                               └─ objects/sha256/<hex>.jsonl.gz   freshness object (one)
                 └─▶ N.official-definitions.json ─▶ definitions/index.json, sha256/*.json   (unchanged role and scope)
```

### 3.2 Trust placement

| Object                                | Signed or bound by                                                       | Change from today                                    |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Root, top-level targets               | Offline keys                                                             | None                                                 |
| Snapshot, timestamp                   | Online keys; expiry 7 d and 1 d                                          | None                                                 |
| `official-policy.json`                | `official-policy` key; scope `policy/official/*.json`                    | Phase 2: one more target name                        |
| `catalog.manifest.json` (phase 2)     | Named by `official-policy`                                               | New target                                           |
| Chunks and freshness object (phase 2) | Named by the manifest                                                    | New, outside TUF, like `catalog-history/`            |
| `official-definitions.json`           | Existing key; scope exactly `definitions/index.json` and `sha256/*.json` | None. The policy key never signs definition content. |

**Why chunks are not TUF targets.** 129–923 chunk entries in `official-policy`
would add about 30–210 KB to a role every client downloads on every refresh.
The manifest gives the same hash-and-length check.

**Replay and expiry.** The manifest's provenance is the existing
`PolicyProvenance`. It advances the same `replay_floor_json`.

**One listing revision floor, distinct revisions per carrier.**

- Every carrier shares one revision floor.
- While compact and the manifest coexist, each publication gives every carrier
  it changes a distinct revision above the maximum over all carriers. The
  signer refuses shared revisions within one policy version, and
  `verify_history` refuses a revision seen on two carriers.
- Byte equality, which `admit_listings` and `AuthenticatedListings::stored` use
  today, cannot compare a manifest with a whole body. So the manifest reader
  refuses a candidate whose `listing_revision` equals any stored carrier's
  revision, except an exact retry of the same carrier and digest.
- **At the cutover** (one carrier), the compact revision simply stays above
  the legacy maximum, as #8619 already does.

**Safety floor (phase 1, Core).** Every carrier adoption writes
`listing_safety_floor` in the same transaction as the revision floor:

- the monotonic union of all adopted withdrawals;
- the holds of the floor revision (from the adopted document's typed
  restrictions);
- the revision and a digest.

Every load path applies it: the stored carrier row, the active manifest in
phase 2, and the bundled directory. A fallback never resurrects a withdrawn
row or lifts a hold; only an adopted higher revision lifts a hold. First open
after the migration initializes the floor from stored rows. This ships in the
cutover's minimum supported generation, so expiry of the 1-day timestamp no
longer drops remote withdrawals.

### 3.3 Object layout (phase 2)

**Paths:** `catalog/objects/sha256/<64 hex>.jsonl.gz`. Each name is the SHA-256
of the stored bytes. **The reader derives every object URL only from a
validated `^[0-9a-f]{64}$` digest** plus the fixed suffix. It never uses a path
or URL string from a manifest. The overlay and assembly inventory gain exactly
this pattern.

**Manifest** (canonical JSON, strict, duplicate keys rejected):

```json
{
  "manifest_schema": 1,
  "listing_revision": 50,
  "issued_at": 1764000000,
  "required_features": ["catalog.chunked-manifest-v1"],
  "withdrawn_ids": ["..."],
  "aggregate": { "objects": 129, "decoded_length": 12022941, "stored_length": 2832768 },
  "streams": [
    {
      "stream": "listings.descriptive",
      "envelope_version": 1,
      "key": "sha256-id-prefix-v1",
      "records": 1649,
      "chunks": [
        {
          "prefix": "00000000",
          "depth": 6,
          "records": 27,
          "length": 22071,
          "sha256": "…",
          "decoded_length": 83120,
          "decoded_sha256": "…"
        }
      ]
    },
    {
      "stream": "listings.observations",
      "envelope_version": 1,
      "key": "sha256-id-prefix-v1",
      "…": "…"
    }
  ],
  "freshness": {
    "records": 1458,
    "length": 49462,
    "sha256": "…",
    "decoded_length": 249291,
    "decoded_sha256": "…"
  },
  "continuation": null
}
```

**Manifest fields:**

- `prefix` is eight hex digits: a 32-bit key prefix, of which `depth` bits
  count.
- `length` and `sha256` bind the stored gzip bytes. `decoded_length` and
  `decoded_sha256` bind the decoded lines.
- `aggregate` must equal the sums, and the reader checks it before any fetch.
- Each stream's chunks partition the 32-bit key space exactly.
- `withdrawn_ids` are inline.
- Holds are typed restrictions in the descriptive records, as in format 15.
- `continuation` is reserved and must be null for this reader generation. The
  aggregate object bound keeps one page sufficient (3.9).

**Chunk:** one gzip member (`mtime` 0, no name) of UTF-8 JSON lines.

- **Line 1 is a header:**
  `{"chunk_schema":1,"stream":…,"envelope_version":1,"prefix":…,"depth":…}`.
- **Each further line** is `{"id":…,"value":{…}}` in canonical JSON, sorted by
  `id`.
  - In the descriptive stream, `value` is the `CatalogListing` without
    `upstream_observation`.
  - In the observation stream, it is the observation without the three
    timestamps.
- **The reader checks** each record's prefix, uniqueness, sort order and count.

**Freshness object:** one gzip JSON-lines object of
`{id, observed_at, attempted_at, fresh_until}`. `fresh_until` stays explicit.
About a quarter of observed rows refresh each publication, so the object is
rewritten each time; splitting it saves nothing.

**Format increases** follow the minimum-supported-generation rule (5): the
publisher emits a new `envelope_version` or required feature only after the
released-reader gate verifies a released build reads it. There is no
dual-variant or per-record skip machinery.

### 3.4 Record-to-chunk mapping and rewrite fraction (phase 2)

- **Key.** The first 32 bits of the SHA-256 of the UTF-8 stable ID.
- **Start.** Each stream starts at depth 6, 64 chunks.
- **Split only.** A chunk splits into its two children when its decoded bytes
  exceed 192 KiB. Chunks never merge, so an existing record moves only when its
  own chunk splits.

**Parameters measured** exactly as specified: gzip 9, `mtime` 0, depth 6,
split above 192 KiB decoded. The 5× and 10× catalogs are clones with suffixed
IDs. Changes are k random descriptive records with seed 1422, over 10 trials.

| Catalog | Rows   | Chunks (descriptive + observation) | Set, gzip  | Largest chunk, decoded |
| ------- | ------ | ---------------------------------- | ---------- | ---------------------- |
| 1×      | 1,649  | 64 + 64                            | 2,783,306  | 155,300                |
| 5×      | 8,245  | 216 + 242                          | 13,555,800 | 195,982                |
| 10×     | 16,490 | 431 + 491                          | 27,098,387 | 195,751                |

Freshness adds 49,462 bytes at 1×, for a full set of 2,832,768 bytes.

**Rewrite for 1, 10 and 100 changed descriptive records** (chunks · gzip bytes
· share of the set). Compact-only rewrites 100% in every cell.

| Catalog | 1 changed                      | 10 changed                      | 100 changed                       |
| ------- | ------------------------------ | ------------------------------- | --------------------------------- |
| 1×      | 1 of 64 · 22.1 KB · **0.79%**  | 9.6 of 64 · 221 KB · **7.9%**   | 50.9 of 64 · 1.17 MB · **42.1%**  |
| 5×      | 1 of 216 · 36.2 KB · **0.27%** | 9.7 of 216 · 332 KB · **2.45%** | 80.1 of 216 · 2.75 MB · **20.3%** |
| 10×     | 1 of 431 · 38.1 KB · **0.14%** | 9.8 of 431 · 341 KB · **1.26%** | 88.0 of 431 · 3.00 MB · **11.1%** |

The generated-registration migration rewrites 200–400 listing-only identities.
Chunked at 1×, that is 61.8 or 63.9 of 64 descriptive chunks (1.41 or 1.455 MB),
once. Compact-only rewrites the whole body, as for any change.

**Real publications at 1×** (observation chunks · bytes · freshness), without
the byte budget:

| From → to | Observation chunks | Bytes   | Freshness |
| --------- | ------------------ | ------- | --------- |
| v50 → v51 | 9 of 64            | 185,601 | 49,154    |
| v51 → v52 | 10                 | 221,805 | 49,196    |
| v52 → v53 | 0                  | 0       | 49,201    |
| v53 → v54 | 16                 | 330,168 | 49,371    |
| v54 → v55 | 19                 | 455,804 | 49,295    |
| v55 → v56 | 18                 | 377,442 | 49,268    |
| v56 → v57 | 11                 | 222,715 | 49,317    |
| v57 → v58 | 4                  | 93,712  | 49,349    |
| v58 → v59 | 9                  | 184,513 | 49,407    |
| v59 → v60 | 10                 | 224,146 | 49,462    |
| Mean      | 10.6               | 229,591 | 49,302    |

- **A day.** v50→v60 (30.8 h) rewrites 56 of 64 observation chunks (1,173,891
  bytes). v57→v60 (12.1 h) rewrites 22 (483,120 bytes).
- **5× and 10× estimates.** They assume changed rows scale with rows: about
  57 of 242 and 114 of 491 observation chunks a publication, plus freshness
  objects of ≈0.25 and ≈0.49 MB.

### 3.5 Streams and consumers

| Stream or consumer      | Content                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact (phase 1)       | The full format-15 directory with observations, no byte budget. The only live listing carrier after the cutover.                                        |
| `listings.descriptive`  | Phase 2: every canonical listing without observations.                                                                                                  |
| `listings.observations` | Phase 2: observation facts. An optional candidate that fails Core validation is excluded alone and keeps its prior signed observation (compact's rule). |
| Freshness object        | Phase 2: timestamps per observed ID.                                                                                                                    |
| Definitions             | Not a manifest stream. They stay on `official-definitions`; schema 2 removes the rebind (4).                                                            |
| Publisher tooling       | Prepare fetches `gh-pages` at depth 1. `verify_history` uses the ledger for pruned versions. The overlay accepts planned removals only.                 |
| Release-side readers    | `catalog-released-reader.mts` gates each cutover: compact (exists), schema-2 policy, and `chunked-manifest-v1`.                                         |
| Caches                  | The safety floor (phase 1). In phase 2, a chunk store plus an assembled-document selection row.                                                         |

### 3.6 Reader algorithm (phase 2)

1. **Load the TUF chain** with the existing `load_repository`.
2. **Choose the carrier:** the manifest when named and every required feature
   is supported, otherwise compact while it is still named. When the manifest
   is the only listing carrier and is unsupported, report
   `listing_manifest_update_required`. Keep the stored data under the safety
   floor; the application updater is the path forward.
3. **Fetch the manifest** (≤1 MiB) and verify it against `official-policy`.
   Check freshness, the replay floor and the revision rule (3.2) before
   anything else. An identical digest is an exact retry.
4. **Check the plan before any chunk fetch.** Verify the partitions and that
   `aggregate` equals the sums. If `aggregate.objects` or
   `aggregate.decoded_length` exceeds this release's bounds (3.9), refuse with
   `listing_manifest_update_required`. Otherwise compute the missing set and
   the overall deadline from planned stored bytes.
5. **Fetch the missing objects**, eight at a time, from digest-derived URLs.
   Each is read bounded by `length` and checked for SHA-256, then gunzipped
   bounded by `decoded_length` and checked for exact `decoded_length` and
   `decoded_sha256`. Then the header and records are checked, and the object
   is stored **staged**, without authority.
6. **Assemble and validate** through Core's listing validators and `project()`.
   Serialize the canonical assembled document and compute its SHA-256.
7. **Adopt** in one `Immediate` transaction. Re-check the floors. Upsert
   `listing_manifest_selection` with the manifest, **the assembled document and
   its digest**, provenance and revision. Advance `replay_floor_json` and
   `listing_safety_floor`. Mark the objects active.
8. **On failure,** state and floors are unchanged, and a typed code is
   recorded: `incomplete`, `verification`, `unsupported`, `update_required` or
   `deadline`. Staged objects stay for the next attempt.
9. **Load order:** the active selection (its digest re-checked, if fresh), then
   the stored compact row, then bundled, always under the safety floor. The
   previous manifest is kept only for garbage collection and diagnostics,
   never for loading.

### 3.7 Publisher algorithm (phase 2)

**Prepare.** Read the prior manifest at `--depth=1`. Build the streams with no
budget. Partition by the prior layout and apply splits. Gzip deterministically
and name objects by digest. Assign distinct carrier revisions. Compute the
retention plan.

**Sign.** The policy signer recomputes new objects' digests and lengths. It
checks the partitions and aggregate, a rising floor, distinct revisions,
withdrawals as a superset, and that every reused object is present in the
prior served tree. `HistoricalRevisionFloors::observe` gains a bound for
`catalog.manifest.json` (3.9); other non-listing policy targets stay at
65,536 bytes.

**Assemble and publish.** Overlay `objects/`, apply planned removals, check
bounds, push, and read back **every** object anonymously. A missing object
fails the publication.

**Return.** `--return-to-compact` (PR 6) drops the manifest target and
publishes compact above the manifest revision with every withdrawal. It is
valid while the minimum generation still reads compact.

### 3.8 Client cache (phase 2)

```text
catalog_object(sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
               decoded BLOB NOT NULL, decoded_sha256 TEXT NOT NULL,
               state TEXT NOT NULL CHECK(state IN ('staged','active')),
               staged_at INTEGER NOT NULL)
listing_manifest_selection(singleton, manifest_bytes, assembled_document BLOB,
                           assembled_sha256, provenance_json, revision,
                           previous_manifest_sha256)       -- diagnostics only
```

- **Read path.** Every command reads the assembled document and re-checks its
  digest. It never reassembles about 130 chunks at startup. The store is for
  reuse and diffing.
- **Collection.** After adoption, delete objects named by neither the active
  nor the previous manifest, and staged rows older than 7 days.
- **Bound refusal.** A refusal over the bound happens before any fetch, with a
  typed status shown by `catalog listing-status` and Desktop as "update
  Portcove to receive catalog updates".
- **Writer protocol.** The migration bumps the writer protocol, so older
  executables refuse rather than lose the selection.

### 3.9 Bounds and their justification

Each bound has a resource, protocol or correctness reason, and its measured
position at 1× and 10×.

| Bound                                              | Value                                                   | Justification                                                                                                                                                                                                                                                                                                                                          | 1× / 10×                    |
| -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Compact carrier wire, decoded and record count     | Today 8 MiB, 32 MiB and 10,000                          | **Application choices with no resource basis.** Replaced by the lead's ceiling inventory. Inputs from this design: measured wire 3.45 / 17.2 / 34.5 MB and decoded 11.9 / 59.5 / 119 MB at 1× / 5× / 10×. Hard ceilings above them: Git's 100 MiB file limit, GitHub's 50 MiB push warning, and reader peak memory (UNKNOWN; PR 0 measures parse RSS). | 41% / exceeds               |
| Split threshold                                    | 192 KiB decoded                                         | Rewrite granularity against request count. At measured gzip ratios of 3.7–4.8, one changed record rewrites at most about 52 KB. 1× then starts at depth 6: 129 objects, 17 rounds of eight requests on a cold fetch.                                                                                                                                   | Largest 155,300 / 195,982   |
| Chunk decoded bound                                | 256 KiB                                                 | Correctness: the split threshold plus 64 KiB, so a chunk at the threshold plus any record up to 64 KiB is still valid. The largest descriptive record is 8,517 bytes.                                                                                                                                                                                  | Never reached               |
| Oversize single-record chunk                       | 1 MiB + 4 KiB decoded                                   | Core's existing per-record bound plus a header. A chunk holding one record may reach it. Two records sharing all 32 key bits and exceeding 256 KiB together refuse publication.                                                                                                                                                                        | —                           |
| Stored length                                      | ≤ decoded + 5 bytes per 65,535 + 18                     | Correctness: deflate's worst-case expansion (stored blocks) plus gzip framing. Any larger stored object is malformed.                                                                                                                                                                                                                                  | —                           |
| Records per chunk                                  | 4,096                                                   | 256 KiB divided by a 64-byte minimum record line (header plus a short ID): it bounds per-chunk parse work.                                                                                                                                                                                                                                             | 27 / ≈38 typical            |
| Aggregate objects (this reader generation)         | 4,096                                                   | It keeps the manifest one page: 4,096 entries × 256 bytes maximum per canonical entry = 1 MiB. At measured density (129 objects per 1,649 rows) it holds about 52,000 rows, about 32×. Continuation is defined when a later generation raises it.                                                                                                      | 129 / 923                   |
| Manifest                                           | 1 MiB                                                   | Derived from the line above.                                                                                                                                                                                                                                                                                                                           | ≈30 KB / ≈210 KB            |
| Aggregate decoded length (this reader generation)  | 48 MiB                                                  | Disk and memory. The store, the staged set and the assembled document each hold up to this, about 144 MiB of SQLite worst case. Assembly peaks at about twice it in memory. It covers 4× the measured 12.0 MB; beyond that the typed refusal sends players to the updater.                                                                             | 12.0 MB / exceeds (≈120 MB) |
| Freshness object                                   | 4 MiB decoded                                           | One line is at most 256 bytes (ID plus three RFC 3339 timestamps), times 16,384 rows, the 10× horizon.                                                                                                                                                                                                                                                 | 249,291 / ≈2.5 MB           |
| Withdrawn IDs                                      | 10,000                                                  | Core's existing record-count bound. A withdrawal names a record.                                                                                                                                                                                                                                                                                       | 0                           |
| Per-request timeout, concurrency, progress timeout | 20 s, 8, 120 s                                          | Existing transport values. The progress timeout keeps the existing 120 s overall limit as the longest wait without progress.                                                                                                                                                                                                                           | —                           |
| Overall deadline                                   | 120 s + planned stored bytes ÷ 32 KiB/s, at most 30 min | A 256 kbit/s floor, a slow but usable link. The cap keeps a stalled refresh from holding the library writer indefinitely.                                                                                                                                                                                                                              | 206 s / ≈16 min             |
| Body and generation window                         | Current + previous                                      | Correctness: Pages serves `max-age=600`, so a client may hold metadata naming the previous body for 600 s. The publisher enforces at least 600 s between publications; the shortest observed gap was 33 minutes.                                                                                                                                       | —                           |
| Checkpoint suffix K                                | 16                                                      | Recovery horizon: two days at 7.8 publications a day, covering the twice-daily scheduled readback plus a missed day.                                                                                                                                                                                                                                   | —                           |
| Pins                                               | 8                                                       | One per activation kind (cutover, window, manifest, schema 2), plus `last_good`, a restore, and two spare.                                                                                                                                                                                                                                             | —                           |
| History compaction trigger                         | 2 GiB of `gh-pages` packed history                      | Protocol: a GitHub release asset is at most 2 GiB, so the archive bundle stays a single asset. It is also 40% of GitHub's 5 GB strong recommendation.                                                                                                                                                                                                  | 63.87 MiB today             |
| Retained tree, files and Pages bytes               | 768 MiB, 65,536 files, 900,000,000 bytes                | Existing workflow bounds below the 1 GB Pages site limit.                                                                                                                                                                                                                                                                                              | ≈21 MB after the window     |

Playing an installed game never reads any of this. ScummVM is unchanged.

## 4. Definitions: policy decision schema 2

**No definitions stream.** That would let the `official-policy` key vouch for
definition content. `official-policy` stays distinct from the definitions
role, whose delegation contains exactly `definitions/index.json` and
`sha256/*.json`.

**Source of the O(n) rewrite.** A schema-1 decision binds:

- `namespace`, `stable_id`, `definition_revision`;
- `definition_sha256` (the entry bytes) and `template`;
- the **global `index_sha256`**.

`inspect_publication_policy` and `binds_projection` (`definition_publisher_policy.rs`
~269, ~681) refuse a decision whose `index_sha256` differs from the candidate's.
Launch records bind their policy's digest. Any index change therefore re-signs
every policy and launch target (`retained-index-rebind`,
`scripts/catalog-publication-receipt.mts` ~250).

**What the global binding provides.** A decision applies only to the exact
definition bytes that the current definitions-signed index names for that
subject. Removing or revising the subject defeats the old decision. The index
already enforces this per subject:

- the reader resolves a subject only through the current verified index, so a
  removed subject has no entry;
- a revised subject has a new entry digest;
- a `Revoked` decision at a higher policy revision is protected by the
  per-target policy revision floor;
- the entry names its contract leaves by content-addressed targets that the
  index verifies, so the entry digest binds the contracts too.

The only extra effect of the global digest is that an unrelated change
invalidates every decision.

**Schema 2** binds `namespace`, `stable_id`, `definition_revision`,
`entry_sha256` and `template`, without `index_sha256`. It is admitted only when
the current verified index names that subject at that revision with that entry
digest. An addition then signs only its own targets.

**Gating.**

1. PR 7′a (Core) reads schema 2, advertises `catalog.policy-decision-v2` in
   `definition_features!` (`definition_capabilities.rs` ~42) and ships in a
   release.
2. PR 7′b (publisher) emits schema 2 only after `catalog-released-reader.mts`
   verifies a released reader with the feature. That makes it the minimum
   generation for new decisions.
3. Older previews keep their last-good decisions and their installs.

**Index bounds.** About 664 bytes per definition: about 2.7 MB at the
4,096-definition bound (65% of 4 MiB). The 32 MiB content budget binds first,
at about 1,900 definitions at today's mean of 17.4 KB. That is part of the
lead's ceiling inventory.

## 5. Compatibility: minimum supported generation

**The rule.** The publisher depends on the newest carrier once the
released-reader gate verifies that a released build reads it. Older previews
keep:

- their stored and bundled data;
- their library, installs, originals, saves and settings;
- the forward upgrade path through the application updater.

There are no frozen projections, no hold successors, no final safety forms and
no per-carrier retirement schedule.

| Carrier or format                  | Minimum supported generation for live updates           | Previews below it                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compact, format 15 (#8619 cutover) | The first compact-capable preview (expected Preview 14) | Preview ≤ 13 receives no further listing changes. It keeps its stored listing and bundled directory. Stored observations expire within 12 h of their `fresh_until`, after which it queries providers live under anonymous rate limits. It updates the application. |
| Policy decision schema 2           | The first preview with `catalog.policy-decision-v2`     | Keeps last-good decisions and installs; updates the application.                                                                                                                                                                                                   |
| Chunked manifest (phase 2)         | The first preview with `chunked-manifest-v1`            | Compact stays named only until the gate verifies the manifest reader in a released build. Then the publisher drops compact, and older previews keep their stored compact data and update.                                                                          |

**Installed data is assessed separately.** Library migrations keep the writer
protocol and forward migrations, and no network-format change alters installed
meaning. Each cutover PR shows that a library written by the oldest supported
preview opens, migrates and launches its installs with the new build.

**Safety for older previews.** A preview below the minimum generation receives
no further withdrawals. That is the accepted consequence of the amendment. The
application updater is its remedy, and `updates/withdrawn.json` remains the
channel to withdraw an unsafe preview.

**Verification with the actual client.** Each cutover is accepted by the
actual newly released supported client reading the staged and then the live
feed. The evidence also records what the previous preview does afterwards.
The T-ADD harness (8) proves that a later addition reaches an unchanged
capable binary.

## 6. Retention and history

### 6.1 Body window with a listing-floor ledger (PR 1)

**Why the ledger comes first.** `HistoricalRevisionFloors::observe` reads every
historical listing body named by every retained `official-policy` version. It
checks length and digest, derives the revision, decoded SHA-256 and
withdrawals, and refuses equivocation. A missing body fails with "catalog public
repository file missing". Pruning without a replacement breaks the next run.

**Ledger.** `catalog/history-ledger/listing-floors.json` is append-only
canonical JSON, with one entry per listing body ever named:

```json
{
  "policy_version": 47,
  "target": "policy/official/catalog.listings.json",
  "sha256": "…",
  "revision": 40,
  "decoded_sha256": "…",
  "withdrawn_ids_sha256": "…"
}
```

- **Creation.** Built once, by PR 1's first run, through `observe` while every
  body is present.
- **Verification on each run.** Each entry's version, target and digest must
  equal a retained signed descriptor, and the ledger must extend the prior one
  as an exact prefix. Entries are appended only by the run that still reads
  the body.
- **Use.** `verify_history` takes pruned versions' floors from the ledger.
  Window bodies still run through `observe`. Equivocation across the ledger and
  the window is refused.
- **Security role.** The newest bodies, which are never pruned, set the floor.
  A falsified old entry cannot lower it, and a raised one only makes the
  publisher refuse, which any `gh-pages` writer can already cause. After
  bootstrap, the checkpoint carries the ledger digest.

**Window.** Serve the current and previous body of each live carrier, plus
pinned bodies. After the cutover, every legacy body except a pinned one is
prunable. Metadata versions, roots, leaves and policy targets stay.

| State                           | Bodies served                                     | Freed            | Served catalog tree |
| ------------------------------- | ------------------------------------------------- | ---------------- | ------------------- |
| After the compact-only cutover  | 2 compact (≈6.9 MB) + 1 pinned legacy (8,388,398) | ≈382 MB          | ≈29.6 MB            |
| Once the legacy pin is released | 2 compact                                         | a further 8.4 MB | ≈21.2 MB            |
| Phase 2 at 1×, compact dropped  | current and previous chunk sets (≈3.1 MB)         | —                | ≈17.4 MB            |

After activation, growth is about 36 KB a day of metadata.

**Contract change.** SIGNED-CATALOG's "complete retained graph" becomes
"current, window and pins served; superseded bodies in `gh-pages` Git history
and the ledger".

### 6.2 Pin store and manual restore runbook (PR 1, before any prune)

**Pin store.** `release/catalog-publication-pins.json`, changed only by a
reviewed PR, holds at most 8 pins (3.9). The publisher keeps every body that a
pinned commit's policy metadata names. A one-run `last_good` pin may be passed
as the `retain_pin` workflow input. PR 1 adds the pin for the commit before
the first prune.

**Manual restore runbook:**

1. Pick the pin commit `P`: the newest one whose readback passed, from the
   receipt.
2. In a fresh `gh-pages` worktree at head, run
   `git checkout P -- catalog/targets/<sha256>.policy/official/<target> …`.
   Restore only paths whose name digest equals their content digest and that
   retained signed metadata names.
3. Run `portcove-release-tools verify-definition-repository`.
4. Commit and push normally, never with force.
5. Dispatch an ordinary renewal run. It republishes with higher versions and
   never re-serves old ones.
6. Record the result on #1422.

The restored bytes were previously signed and are content-addressed. This is
lead authority. Rehearsal: T-RESTORE-MANUAL.

### 6.3 Reversible stop-gap

**Action.** Defer publications whose only listing change is observation facts
or freshness to the two scheduled runs (05:13 and 17:13). Descriptive and
safety changes never wait.

**Arithmetic.** Listing changes fall from 6.7–8.6 to 5.4–6.7 a day: the 3.4–4.7
descriptive changes plus 2 scheduled. For compact-only, the runway rises from
13.5–17.3 to 17.3–21.5 days. History growth falls from 23–28 to 18–22 MB a day,
so compaction moves from every 75–91 days to every 94–118. Observation
freshness then lags by up to 12 hours, which is still within `fresh_until`.
Reverting restores today's behavior.

### 6.4 History: previous checkpoint plus a K-deep suffix

**Chosen over epochs and a ledger, for the same guarantee.**

- **Replay and equivocation protection** come from cumulative floors in each
  checkpoint. The signed pointer target binds each checkpoint by digest, and
  each signer verified its predecessor. So the previous checkpoint's floors
  are authenticated, and the new floors must be a superset.
- **What epochs add** is a periodic full verification nothing depends on, plus
  an archival ledger.
- **What the suffix covers.** K = 16 (3.9) verifies exactly the objects that
  recovery uses.
- **Bounded size.** The checkpoint carries the active inventory (current,
  window and pins), not an all-time segment chain.
- **No immutability check is lost.** Paths stay immutable by construction:
  content-addressed names and rising metadata versions.
- **Cost.** At most 18 objects a run, independent of history length.
  `SEGMENT_CHAIN_LIMIT` stays as a defense.

**Workflow changes.** Prepare fetches `gh-pages` with `--depth=1` (PR 2), where
`catalog-publish.yml` ~84 fetches full history today. Before any history
compaction, re-pin to post-compaction commits, and record that bundle restore is
the only route for older pins.

### 6.5 Root rotation, carrier-set changes and `restore-publication`

- **Root transition.** A checkpoint with `root_sha256 = R_new` and
  `previous_root: {version, sha256: R_old}` is accepted only with consecutive
  root versions, each signed by both the old and the new threshold. Anything
  else fails with `ROOT_ROTATED`. Rotation is owner-only.
- **Carrier-set change.** Examples are removing legacy at the cutover, or
  compact when the manifest becomes the minimum. It is accepted when:
  1. the shared listing floor rises;
  2. the remaining carrier's withdrawals are a superset of the removed one's;
  3. the removed carrier's final revision is recorded in the checkpoint floors.

  There is no return schedule. A removed carrier may return only above that
  revision.

- **Before bootstrap.** The cutover's removal of legacy needs only the
  `verify_history` and signer rule above. Per the lead, any such rule change is
  isolated and surfaced to the owner before merge.
- **`restore-publication --pin`.** Keyless and read-only: it verifies a pinned
  tree and overlays exactly the missing addressed objects. The next run renews
  them. Pins move into the checkpoint, and the pin store file is retired.

### 6.6 Git history growth and compaction

The measurements are in 2.2; the trigger is 2 GiB (3.9).

| Delivery state                     | Growth a day (packed)                     | Days from 64 MiB to 2 GiB |
| ---------------------------------- | ----------------------------------------- | ------------------------- |
| Today (legacy)                     | ≈6.8 MB measured                          | ≈310                      |
| Compact-only, 1×                   | browse 5.5 + compact 17.3–22.2 ≈ 23–28 MB | 75–91                     |
| Compact-only plus the stop-gap, 1× | ≈18–22 MB                                 | 94–118                    |
| Chunked manifest, 1×               | browse 5.5 + chunks 2.4 ≈ 7.9 MB          | ≈265                      |

**Compaction (owner, O3).**

1. Re-pin to post-compaction commits.
2. Archive the old history as a `git bundle` release asset (≤2 GiB by the
   trigger).
3. Force-push an orphan `gh-pages` commit with the served tree and pinned
   objects.

`browse/` is about 0.71 MB a publication, the largest steady term once listings
are chunked. Stable `browse/` output is a separate follow-up.

## 7. Activation sequence and decisions

**Authority:**

- **L (lead):** reversible, evidence-checkable publication choices, including
  the compact cutover.
- **O (owner):** history bootstrap, root rotation, signing-role or key
  changes, and a `gh-pages` force-push needing a branch-protection exception.

No signing-role or key change is needed. Protected publication and activation
authority is unchanged.

| Order | Step                                                                                   | Authority  | Gate                                                                           |
| ----- | -------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| 1     | Compact-only cutover (#8619)                                                           | L1         | Released compact reader verified; owner sees any signer or history rule change |
| 2     | PR 1 (window, ledger, pin store, runbook); optional stop-gap; safety-floor Core change | —          | Reviewed PRs                                                                   |
| 3     | Activate the body window                                                               | L2         | Ledger verified on a real run                                                  |
| 4     | PR 2 report and shallow fetch; PR 7′a released, then schema 2                          | L5         | Released reader with `catalog.policy-decision-v2`                              |
| 5     | History H1 and H2                                                                      | —          | Reviewed PRs                                                                   |
| 6     | Bootstrap                                                                              | **O1**     | H1 and H2 merged                                                               |
| 7     | Phase 2 (PR 3, PR 4 released, PR 6, generation retention), then manifest activation    | L4, L7     | Trigger in 3.0; released `chunked-manifest-v1` reader                          |
| —     | Root rotation; `gh-pages` compaction                                                   | **O2, O3** | When needed; trigger in 3.9                                                    |

### 7.1 Decisions

**L1. Compact-only cutover (lead, PR #8619).**

- **Action.** Merge the rewritten #8619. Compact becomes the sole listing
  carrier with the full directory. The legacy projection, its budget fitting,
  hold successors and return path are retired.
- **Consequence.**
  - The minimum supported generation becomes the first compact-capable
    preview. Preview ≤ 13 keeps stored data and installs and must update to
    receive listing changes.
  - Each change adds ≈3.45 MB to served storage before the window, and
    ≈2.58 MB to Git.
- **Rollback.** Before bootstrap: revert, then publish a legacy target above
  the compact revision with every withdrawal (one reviewed run).

**L2. Body window (lead).** Reversible from Git, with evidence checkable from
the ledger and the dry-run plan.

- **Action.** Pass `--retain-bodies window` after PR 1.
- **Consequence.** About 382 MB freed, and a served catalog tree of ≈21–30 MB.
  Clients are unaffected. "Complete retained graph" becomes "current, window
  and pins".
- **Rollback.** The runbook (6.2), then revert the flag.

**L3. Stop-gap (lead, optional).**

- **Action.** Defer observation-only publications to the two scheduled runs.
- **Consequence.** About 25% more runway and slower Git growth. Freshness lags
  by up to 12 h.
- **Rollback.** Revert.

**L4. Phase 2 manifest activation (lead, when triggered).**

- **Action.** Pass `--manifest` with the `chunked-manifest-v1` released-reader
  gate. Drop compact once that generation is the minimum.
- **Consequence.** ≈0.31 MB per publication and ≈1.2–1.6 MB a client-day at 1×.
  Git growth ≈7.9 MB a day.
- **Rollback.** Before compact is dropped and before bootstrap:
  `--return-to-compact`, then revert the flag.

**L5. Policy decision schema 2 (lead, gated).**

- **Action.** Enable PR 7′b after the gate.
- **Consequence.** An addition signs only its own targets.
- **Rollback.** Republish schema 1 at higher policy revisions.

**L7. Generation retention for objects (lead).**

- **Action.** Apply the window to `objects/`.
- **Consequence.** About 3.1 MB served at 1×.
- **Rollback.** Restore from Git, then revert the flag.

**O1. History bootstrap (owner).**

- **Action.** One dispatch with `bootstrap_history: true` on the H1 and H2
  code.
- **Consequence.** One-way. Carrier-set changes go through 6.5.
- **Rollback.** None; recovery is `restore-publication`.

**O2. Root rotation (owner, only when needed).**

- **Action.** The offline quorum signs `2.root.json`, and a root-transition
  checkpoint follows.
- **Consequence.** History continues.
- **Rollback.** None; a further rotation.

**O3. `gh-pages` compaction (owner).**

- **Action.** Section 6.6, with a branch-protection exception.
- **Consequence.** Bounded history. Older pins are restorable only from the
  bundle.
- **Rollback.** Push the bundle back to a branch.

## 8. Test plan

All hosted CI unless marked. Rust runs on both the Windows and Linux
partitions.

| ID                         | Scope                                                                                                                                                                                                                                                                           | Owner                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| T-CUTOVER                  | The compact-only cutover. The actual newly released supported client reads the staged feed. A preview below the minimum keeps its stored listing, library and installs, and reports that it needs an update. A library from the oldest supported preview migrates and launches. | #8619 rehearsal and `portcove-desktop-verification` |
| T-SAFETY                   | A withdrawal and a hold, then fallback to the stored carrier and to bundled after expiry: the row stays withdrawn and held. A hold is lifted only by a higher adopted revision.                                                                                                 | `portcove-core`                                     |
| T-LEDGER                   | The ledger built from real bodies equals `observe`. `verify_history` passes with pruned bodies. Refusals: a non-prefix ledger, an entry without a signed descriptor, and equivocation between the ledger and a window body.                                                     | `portcove-release-tools` `repository`               |
| T-RESTORE-MANUAL           | Prune a fixture tree, run the runbook, verify, renew, read back.                                                                                                                                                                                                                | `scripts/catalog-publish.test.mts`                  |
| T-ADD                      | Frozen-binary proof: built once, it receives a later addition. First against compact, then the manifest.                                                                                                                                                                        | `portcove-cli` machine-contract tests               |
| T-POLICY2                  | A schema-2 decision binds its subject. Removal, revision or revocation defeats it. An addition changes only its own targets. An older reader keeps last-good.                                                                                                                   | core and release-tools                              |
| T-HIST, T-ROOT             | K = 16: at most 18 objects a run. A tampered suffix is refused. Root transitions are accepted only with a valid chain. Carrier-set changes follow 6.5.                                                                                                                          | `history_checkpoint`                                |
| T-CHUNK (phase 2)          | Exact cover, prefix, determinism, split-only, the oversize single-record chunk, the collision refusal, and every bound in 3.9. Rewrite fractions within ±20% of 3.4.                                                                                                            | `portcove-listing-carrier` `manifest`               |
| T-READ (phase 2)           | Every refusal in 3.6, including aggregate refusal before any fetch, a non-hex digest, equal revision across carriers, and both deadlines.                                                                                                                                       | `portcove-core`                                     |
| T-INT (phase 2)            | Interruption at each step, by fault injection and process kill. No mixed generation; floors unchanged.                                                                                                                                                                          | `portcove-core`                                     |
| T-PUB (phase 2)            | 3,000 simulated publications: monotonic floors, distinct revisions, the window, complete generations.                                                                                                                                                                           | release-tools (simulation)                          |
| T-RELREADER                | The compact, schema-2 and `chunked-manifest-v1` gates. A rate limit or withdrawn version keeps prior state.                                                                                                                                                                     | `scripts/catalog-released-reader.test.mts`          |
| T-LIVE (manual, read-only) | After each activation: anonymous readback of every object, and the four numbers recorded on #1422.                                                                                                                                                                              | —                                                   |

## 9. Implementation breakdown

"Now" means the PR can start without any owner decision or the #8619 merge.

| PR            | Start                             | Mechanism                                                                                                                                            | Files owned                                                                                                                                                                                                                                                                      | Acceptance evidence and rehearsal                                                                                                                                    | Rollback                                       |
| ------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| #8619         | Lead, in progress                 | Compact-only cutover (L1)                                                                                                                            | Its own                                                                                                                                                                                                                                                                          | T-CUTOVER                                                                                                                                                            | 7.1 L1                                         |
| 0             | **Now**                           | A committed read-only measurement script, plus one observer-enriched compact dry run. It also measures reader peak memory for the ceiling inventory. | `scripts/catalog-distribution-measure.mts` (new), its test, this document                                                                                                                                                                                                        | Tables in 2.2, 3.0 and 3.4 regenerated; differences beyond ±20% written in                                                                                           | Revert                                         |
| 1             | **Now**                           | Body window (flag off), ledger, pin store, manual runbook                                                                                            | `crates/portcove-release-tools/src/definition_repository/repository.rs`, `scripts/catalog-publish.mts`, `scripts/catalog-pages-overlay.mts`, `.github/workflows/catalog-publish.yml` (flag off, `retain_pin`), `release/catalog-publication-pins.json`, `docs/SIGNED-CATALOG.md` | T-LEDGER, T-RESTORE-MANUAL; a dry-run plan on the live commit showing ≈382 MB reclaimed, current, previous and pinned bodies kept, and the ledger equal to `observe` | Revert; never activated                        |
| SF            | **Now**                           | Core safety floor: withdrawal union and floor holds applied to every fallback, bundled included. Ships with the cutover generation if possible.      | `crates/portcove-core/src/listing_delivery.rs`, `database.rs` (migration), `catalog_store.rs`                                                                                                                                                                                    | T-SAFETY on Windows and Linux                                                                                                                                        | Revert before release; migration is additive   |
| S             | Now (optional)                    | Stop-gap (6.3)                                                                                                                                       | `scripts/listing-observation-delivery.mts`, `catalog-publish.yml`                                                                                                                                                                                                                | An observation-only change is deferred; descriptive and safety changes publish                                                                                       | Revert                                         |
| L2            | After PR 1                        | **Activation: body window**                                                                                                                          | Workflow flag                                                                                                                                                                                                                                                                    | First run writes the ledger and applies the plan; readback; the next `verify_history` passes                                                                         | Runbook, then revert                           |
| 2             | **Now**                           | Per-run report (active, retained and changed bytes, client transfer, projected compaction interval) and shallow prepare fetch                        | `scripts/catalog-publish.mts`, `scripts/catalog-publication-receipt.mts`, `catalog-publish.yml` (~84)                                                                                                                                                                            | Fields present in the rehearsal; monthly packed-history measurement                                                                                                  | Revert                                         |
| 7′a           | **Now**                           | Core: schema-2 policy reader and feature                                                                                                             | `definition_publisher_policy.rs`, `definition_capabilities.rs`, `definition_refresh.rs`, `definition_selection.rs`                                                                                                                                                               | T-POLICY2 (reader half)                                                                                                                                              | Revert; schema 1 still read                    |
| 7′b           | 7′a released                      | Publisher emits schema 2 behind the gate (L5)                                                                                                        | release-tools `bundle.rs`, `scripts/catalog-prepare-publication.mts`, `scripts/catalog-publication-receipt.mts`                                                                                                                                                                  | T-POLICY2; no `retained-index-rebind` on an addition                                                                                                                 | Schema 1 at higher revisions                   |
| H1            | **Now** (groundwork)              | Checkpoint schema 2: K-suffix, active inventory, ledger digest, root transition, carrier-set rule                                                    | `history_checkpoint.rs`, release-tools `policy.rs`, `scripts/catalog-publish.mts`                                                                                                                                                                                                | T-HIST, T-ROOT                                                                                                                                                       | Revert; inert                                  |
| H2            | After H1                          | `restore-publication` and checkpoint pins; retires the pin store                                                                                     | release-tools CLI, `catalog-publish.mts`, `catalog-publish.yml`                                                                                                                                                                                                                  | T-RESTORE                                                                                                                                                            | Revert; inert                                  |
| O1            | After H1, H2                      | **Bootstrap** (owner)                                                                                                                                | Dispatch only                                                                                                                                                                                                                                                                    | Dry plan, then readback of pointer and checkpoint                                                                                                                    | None                                           |
| T-ADD harness | **Now**                           | Frozen-binary harness against compact                                                                                                                | `crates/portcove-cli` tests, fixture repository builder                                                                                                                                                                                                                          | An unchanged binary sees an added row, with fetch counts asserted                                                                                                    | Revert; tests only                             |
| 3             | Phase 2 (may start as groundwork) | Manifest and chunk format: split-only, decoded lengths, every bound in 3.9, fuzzing                                                                  | `crates/portcove-listing-carrier/src/manifest.rs` (new)                                                                                                                                                                                                                          | T-CHUNK; fuzz targets                                                                                                                                                | Revert; pure code                              |
| 4             | Phase 2, after 3                  | Core reader, cache, assembled selection row, typed `update_required`, capability through CLI and Tauri. **Then release.**                            | `listing_delivery.rs`, `database.rs`, `types.rs` (`listing_delivery_carriers` ~2910), `definition_repository.rs`, CLI test, Tauri passthrough                                                                                                                                    | T-READ, T-INT, T-ADD                                                                                                                                                 | Inert without a manifest; withdraw the Preview |
| 6             | Phase 2, after 3 and 1            | Publisher manifest (`--manifest` off), signer checks, `observe` bound, `objects/` overlay, distinct revisions, `--return-to-compact`, rehearsal      | `listing-observation-delivery.mts`, release-tools `bundle.rs`, `signing.rs`, `repository.rs`, `catalog-pages-overlay.mts`, `scripts/listing-manifest-activation-rehearsal.mts`                                                                                                   | T-PUB; rehearsal against a copy of the live prior                                                                                                                    | Revert                                         |
| R             | Phase 2                           | Generation retention for objects (L7)                                                                                                                | `catalog-publish.mts`, `catalog-pages-overlay.mts`                                                                                                                                                                                                                               | T-PUB served-size series                                                                                                                                             | Restore from Git                               |
| 5             | Optional, low priority            | gzip transport for metadata                                                                                                                          | `Cargo.toml`, `definition_repository.rs`                                                                                                                                                                                                                                         | Decoded bounds still apply                                                                                                                                           | Revert                                         |

**Start now:** PRs 0, 1, SF, 2, 7′a, H1 and the T-ADD harness. The stop-gap can
start too. PR 1 has priority: after the cutover the runway is 13.5–17.3 days,
so it should be merged and L2 activated within about a week.

## 10. Alternatives considered

| Alternative                                                                                             | Outcome                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact-only with corrected retention                                                                   | **Chosen for now.** It is sufficient at 1× apart from recurring Git compaction (3.0).                                                                                                                                              |
| Chunked manifest as the default plan (revisions 1 and 2)                                                | **Deferred to phase 2** with measured triggers. It divides changed bytes by about 11 but is not needed at 1×.                                                                                                                      |
| A frozen legacy target with hold successors, and final safety forms                                     | **Withdrawn** under the amendment. Review also showed the frozen-legacy arrangement would stop all publication at the first new hold after activation.                                                                             |
| Per-record required features, or a two-variant format window                                            | **Dropped.** Format increases move the minimum supported generation instead.                                                                                                                                                       |
| Definitions stream in the policy-signed manifest                                                        | **Rejected.** It would cross the role separation. Schema 2 removes the rebind.                                                                                                                                                     |
| Chunk merging with hysteresis                                                                           | **Deferred.** Nothing measured shrinks.                                                                                                                                                                                            |
| Observation cadence gate (D2b) and a finer observation depth                                            | **Dropped.** Unbudgeted churn is small. The stop-gap is temporary only.                                                                                                                                                            |
| Epoch rebasing with an epoch ledger                                                                     | **Replaced** by the K-suffix with the same guarantee (6.4).                                                                                                                                                                        |
| Previous manifest as a load-time fallback                                                               | **Rejected.** It could resurrect withdrawn rows. The safety floor covers fallback.                                                                                                                                                 |
| Compact as raw JSON relying on Pages gzip                                                               | It would delta-compress in Git (88 KiB a change). But Pages gzip is CDN behavior, not a contract, and without it clients fetch 11.9 MB a refresh. It is worth re-measuring in PR 0 if compaction cadence becomes the only concern. |
| One file per record, HTTP ranges, delta chains, TUF hash bins, chunks as TUF targets, fixed shard count | **Rejected** as in revision 1: request count, no range contract, chain replay, new roles and offline ceremonies, role bloat, and resharding cost.                                                                                  |
| A separate host, object store or release assets                                                         | **Rejected.** It violates "$0, no new infrastructure".                                                                                                                                                                             |

## 11. Open risks and UNKNOWNs

- **Runway (urgent).** 13.5–17.3 days after the cutover, or 5.5–7.1 before it.
  Without the window in time, publication stops and the timestamp expires
  within a day. Clients with the safety floor keep remote withdrawals; released
  clients keep only their stored carrier.
- **Previews below the minimum generation** receive no further withdrawals.
  This is accepted by the amendment, with the updater as the remedy.
- **True observer churn (UNKNOWN).** The reconstruction is a lower bound, with
  1,458 of 1,649 IDs ever observed. PR 0 measures it, and the 5× and 10×
  chunked figures depend on it.
- **Reader peak memory (UNKNOWN).** It is needed to justify the next compact
  bounds. PR 0 measures it.
- **Git growth under compact-only.** An owner compaction every 75–91 days at
  1×. The trigger in 3.0 moves to chunking before that becomes frequent.
- **Definition content budget.** About 1,900 definitions.
- **Pages gzip, client population and unchanged-digest refresh behavior
  (UNKNOWN).** As before. None is relied on.
- **Online key compromise and clock skew.** Unchanged from today. Definitions
  stay out of the policy key's reach.

## Appendix: measurement method

All read-only, on 2026-11-23. The scripts lived in a scratch directory, and PR
0 commits equivalents.

- **Tree and clone.** `git ls-tree -r -l c912fc37b` on a
  `git clone --bare --single-branch --branch gh-pages` clone. `git count-objects
  -vH`. Per-path packed size comes from
  `git rev-list --objects gh-pages | git cat-file --batch-check='%(objecttype) %(objectsize) %(objectsize:disk) %(rest)'`.
- **Delta behavior.** A scratch repository with v59 committed, then v60, and
  `git repack -adf --window=250 --depth=50` after each commit. The same was done
  for gzip-9 and base64-of-gzip encodings.
- **Bodies and metadata.** All 47 listing bodies and `1..60.official-policy.json`
  from the clone, mapped by signed target digests. Transition times are policy
  expiry minus 7 days.
- **Descriptive rows.** `crates/portcove-core/catalog/listings.json` (format 15,
  1,649 rows).
- **Observations without the budget.** Carry each ID's latest published
  observation forward. Facts exclude the three timestamps; freshness is those
  three.
- **Compact-only body.**
  `{"listing_delivery_schema":1,"revision":48,"withdrawn_ids":[],"directory":{"format_version":15,"listings":[…]}}`
  with authored rows plus reconstructed observations, as compact JSON. It is
  compressed with gzip level 6 (`gzipSync`'s default) and wrapped as
  `{carrier, decoded_bytes, decoded_sha256, gzip_base64}`. 5× and 10× clone
  rows with suffixed IDs.
- **Chunking.** Key from the first 32 bits of SHA-256(ID). Start depth 6. Split
  while a chunk holds more than one record and exceeds 196,608 decoded bytes.
  gzip 9, `mtime` 0. Freshness is one object.
- **Random changes.** k ∈ {1, 10, 100, 200, 400} records, `random.Random(1422)`,
  10 trials, each changing `summary`. The layout is held fixed, and gzip bytes
  of new chunk digests are counted.
- **Derived rates.** Per-day figures use 6.7–8.6 listing changes and 7.7
  publications a day. `browse/` is 0.71 MB per publication. Compact Git growth
  is its gzip size, per the delta experiment.
- **Wire size.** `curl -H 'Accept-Encoding: gzip'` against the v60 legacy
  target.
