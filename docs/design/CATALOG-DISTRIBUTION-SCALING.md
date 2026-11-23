# Scaling signed catalog distribution (design, November 23, 2026)

Proposed design, revision 2. Nothing here is implemented or activated. The
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

**Revision 2** applies an independent review (ADOPT WITH CHANGES). It:

- re-measures churn without the legacy byte budget and with the specified
  chunk parameters (2.2, 3.4);
- closes six security gaps in fallback, bounds, deadlines, record size, URL
  derivation and cross-carrier revisions (3.2, 3.3, 3.6);
- stores the assembled document at adoption (3.8);
- keeps compact live instead of freezing it, and replaces the two-variant
  format window with per-record required features (5);
- removes the definitions stream and replaces it with policy decision schema
  2 (4);
- adds a listing-floor ledger, pin store and manual restore runbook before
  any body is pruned (6.1, 6.2);
- chooses a K-deep checkpoint suffix over epochs and a ledger (6.4);
- measures Git growth (2.2, 6.6);
- incorporates compact activation (#8619) into the runway (2.2).

## Summary

- **Runway with compact active: about 17–22 days, so body retention is still
  urgent.** The retained catalog tree holds 404,914,714 of 805,306,368 bytes
  (386.2 of 768 MiB; 372.5 MiB of it is 47 legacy listing bodies). Today each
  listing change adds an 8.39 MB legacy body, about 5.5–7 days of runway.
  Compact activation (#8619, being decided now) makes each change add a
  2.75 MB compact body instead, so the remaining 400,391,654 bytes last about
  17 days at the last five days' 8.6 changes a day and about 22 days at the
  week's 6.7 a day. Only a body window stops the growth. With it, the
  served catalog tree drops to about 31–37 MB and then grows by about 36 KB a
  day of metadata (6.1).
- **Real observation churn is small; the budget made it look large.** The
  legacy target sits 210 bytes under its bound, so
  `scripts/listing-admission-budget.mts` drops optional observations to fit,
  and they appear and vanish between publications (v58→v59: 146 appeared,
  117 vanished, 1 real change among rows present in both). Reconstructed
  without the budget, a publication changes the observation facts of 4–22
  rows and only the freshness timestamps of 118–414 rows. In chunks, that is
  0–19 of 64 observation chunks (mean 230 KB) plus one 49 KB freshness
  object.
- **Design.** One small signed manifest, `policy/official/catalog.manifest.json`,
  is signed by the existing `official-policy` role. It names immutable gzip
  chunks by SHA-256, stored length and decoded length. Chunks live under
  `catalog/objects/sha256/`, outside the TUF target tree. A record goes to
  the chunk whose bit prefix matches the SHA-256 of its stable ID. Chunks
  only ever split (extendible hashing), so growth rewrites one chunk and
  leaves the others alone. Descriptive data and observation facts are
  separate chunked streams. Freshness is one separate object with explicit
  `fresh_until`. The reader refuses oversized plans before fetching anything,
  fetches only missing digests, validates the assembled directory through
  Core, stores it with its digest, and adopts it in one SQLite transaction.
  A persisted safety floor (withdrawals and holds) applies to every fallback.
- **Measured at 1× (1,649 descriptive rows):**

  | Transfer                                       | Bytes       |
  | ---------------------------------------------- | ----------- |
  | One publication's change (mean of 10)          | ≈0.31 MB    |
  | A day of changes (v50→v60, 30.8 h)             | ≈1.2–1.6 MB |
  | First full download                            | ≈2.86 MB    |
  | Today: legacy client per refresh (no gzip)     | 8.39 MB     |
  | Today: compact client per refresh (#8619 data) | 2.75 MB     |
  - **A descriptive change to 1, 10 or 100 random records** rewrites 0.79%,
    7.9% or 42% of the chunk set at 1×, and 0.14%, 1.3% or 11% at 10× (3.4).

- **Older clients keep working.** Preview ≤ 13 keeps the frozen legacy
  target. Preview 14 keeps a **live** compact target until it reaches its
  first bound (the 8 MiB wire bound, at about 2.4× today's rows) or its end
  of support. Both still receive withdrawals and holds (5).
- **Definitions** stay on their own signed index under `official-definitions`.
  The O(n) rewrite per addition is removed by policy decision schema 2,
  which binds `namespace`, `stable_id` and `entry_sha256` instead of the
  global index digest (4).
- **History.** A checkpoint verifies the previous checkpoint plus a K-deep
  suffix (K = 16) instead of epochs and a ledger. The cost is constant, and
  the replay guarantee is the same (6.4).
- **Git growth is the next limit, and compact makes it worse.** `gh-pages` is
  63.87 MiB packed for 74 commits. Legacy JSON bodies delta-compress to about
  0.30 MB a change, but a gzip body does not delta-compress at all. With
  compact live, packed history grows about 24–29 MB a day and reaches the
  2 GiB compaction trigger in about 66–80 days. With manifest-only delivery
  it grows about 7.7 MB a day, about 270 days to the trigger (6.6).

## 1. Owner requirements and the mechanism that satisfies each

| Owner requirement (quoted)                                                                                                                                                          | Mechanism                                                                                                                                                                                                                                                                             | Section       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| "Distribution that reuses unchanged content and avoids an ever-growing aggregate download: a small authenticated manifest referencing stable, content-addressed chunks"             | One `official-policy` target (`catalog.manifest.json`, ≤1 MiB) names chunks by SHA-256, stored length and decoded length. A chunk's name is its digest, so an unchanged chunk is never fetched again.                                                                                 | 3.2, 3.3      |
| "integrated with the existing trust model (TUF roles, revision floors, expiry). Choose the smallest compatible implementation."                                                     | No new role, key, delegation path or root field. The manifest fits the existing `policy/official/*.json` scope and shares the replay floor, the listing revision floor and expiry. `official-definitions` keeps exactly `definitions/index.json` and `sha256/*.json`.                 | 3.2, 4        |
| "Preserve authenticated identity, revision floors, expiry, withdrawals, restrictions and capability checks."                                                                        | Records are checked against their chunk prefix. Withdrawals and base holds are inline in the manifest and persisted as a safety floor that every fallback applies. Revisions are distinct across carriers. Each record declares its required features.                                | 3.2, 3.3, 3.6 |
| "Download and verify only changed or needed content."                                                                                                                               | The reader fetches only digests absent from its store. Each object is checked for length and SHA-256 before decoding, and for decoded length and decoded SHA-256 after.                                                                                                               | 3.6           |
| "Stable chunking so a small change does not rewrite most of the distribution (… quantify rewrite fraction for 1, 10, 100 changed records at current, 5× and 10× catalog sizes)."    | ID-hash bit prefixes with split-only extendible depth. Descriptive and observation data are separate streams, and freshness is a separate object. Measured fractions are in 3.4.                                                                                                      | 3.4           |
| "Coherent activation across the accepted generation (all-or-nothing adoption after required content verifies)."                                                                     | Chunks are staged, and the whole document is assembled and validated. Then one immediate SQLite transaction writes the assembled document, its digest, the safety floor and the revision floor together.                                                                              | 3.6, 3.8      |
| "Preserve the previously accepted usable state across interruption, missing content, failed verification and recovery."                                                             | Staged chunks carry no authority. A failure before commit leaves the active selection and the floors intact. The fallback order is active manifest, then stored compact or legacy, then bundled, always under the safety floor.                                                       | 3.6, 3.8      |
| "Bounded individual objects and requests while supporting complete catalogs through continuation."                                                                                  | Chunks are at most 256 KiB decoded, or one record up to 1 MiB. Manifest pages are at most 1 MiB, with up to 64 pages. Aggregate chunk count and decoded bytes are checked before the first fetch. There is an overall deadline scaled by planned bytes.                               | 3.3, 3.6      |
| "Explicit older-client behavior including safety withdrawals and an upgrade path, WITHOUT indefinite duplication of complete historical projections as the compatibility strategy." | Legacy is frozen, and compact stays live until its bound or end of support. Each keeps only its current and previous body served. Withdrawals and holds reach every carrier. Final safety forms end each carrier. Players upgrade through the existing application updater.           | 5, 6.1        |
| "Prove a compatible catalog addition made after a client was built reaches that unchanged capable client."                                                                          | T-ADD harness: a frozen reader binary (built once) receives a later fixture addition. Then #246 acceptance with the released reader.                                                                                                                                                  | 5.4, 8        |
| "Cover ALL consumers: definition indexes, listing carriers, execution content, publisher tooling, caches, release-side readers."                                                    | Per-consumer rows in 2.1 and 3.5. Definitions are handled by policy schema 2 (4).                                                                                                                                                                                                     | 2.1, 3.5, 4   |
| "Publication history: bound verification work as publication count grows"                                                                                                           | Previous checkpoint plus a 16-deep suffix: at most 18 objects a run. Before bootstrap, a body window with a listing-floor ledger stops `verify_history` from reading every historical body.                                                                                           | 6.1, 6.4      |
| "preserve the revision and authority evidence needed for replay protection and supported client catch-up"                                                                           | The ledger keeps each pruned listing version's revision, decoded digest and withdrawal digest. Checkpoints carry cumulative floors. Metadata versions and every root version stay.                                                                                                    | 6.1, 6.4      |
| "continuation across trusted-root rotation"                                                                                                                                         | A root-transition checkpoint, verified against the TUF root chain.                                                                                                                                                                                                                    | 6.5           |
| "compact-carrier retirement and recovery"                                                                                                                                           | `retired_carriers` in the checkpoint. A returning carrier must publish above its final revision.                                                                                                                                                                                      | 6.5           |
| "retention that preserves supported rollback/recovery while reducing repeated full snapshots"                                                                                       | Current plus previous body (covering Pages' 600 s cache) plus pins. Superseded bodies remain in Git history. A pin store and a manual restore runbook come before any prune.                                                                                                          | 6.1, 6.2      |
| "restoration from a pinned last-good publication"                                                                                                                                   | Before checkpoints: the manual runbook (`git checkout <pin> -- catalog/targets/…` plus a renewal run). After: `restore-publication`.                                                                                                                                                  | 6.2, 6.5      |
| "measure active bytes, retained bytes, changed bytes per publication and client transfer"                                                                                           | 2.2 holds today's measurements. PR 2 records these four numbers on every run.                                                                                                                                                                                                         | 2.2, 9        |
| "$0 hosting (GitHub Pages …); no new infrastructure or provider; Windows/Linux beta priorities; playing an installed game never depends on any of this; ScummVM unchanged."         | Everything stays on GitHub Pages and the `gh-pages` branch. Git growth is measured and bounded by a compaction trigger. The reader is platform-neutral Rust tested on the Windows and Linux hosted partitions. Launch reads only retained local contracts. No change touches ScummVM. | 3.9, 6.6      |

## 2. Current architecture and measurements

### 2.1 Consumers

| Consumer                    | What it reads or writes today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Scaling limit                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing carriers (Core)     | `listing_delivery::acquire_listings` reads one target through `tough`: `catalog.listings.compact.json` when signed metadata names it, `catalog.listings.json` otherwise. Bounds: 8 MiB wire for both; compact decoded at most 32 MiB, 1 MiB per record and 10,000 records. `admit_listings` (`listing_delivery.rs` ~787) runs the replay check and a projection dry run in one immediate transaction. It refuses a lower revision or an equal revision with different bytes. `AuthenticatedListings::stored` (~614) refuses stored legacy and compact rows at an equal revision with different bytes. | Every change re-downloads the whole document. The legacy target is full: 8,388,398 of 8,388,608 bytes. It carries 1,193 of 1,649 rows, and its optional observations are dropped to fit (2.2). Compact reaches its 8 MiB wire bound at about 2.4× today's rows once observations are unbudgeted (5.2).                |
| Definition index            | `definitions/index.json` plus content-addressed `sha256/<hex>.json` leaves, signed by `official-definitions`. Bounds: 4 MiB index, 4,096 definitions and a 32 MiB shared content budget. Each policy decision binds the global `index_sha256` (`inspect_publication_policy` and `binds_projection` in `definition_publisher_policy.rs` ~269 and ~681), and each launch record binds its policy. The publication receipt labels the resulting change `retained-index-rebind` (`scripts/catalog-publication-receipt.mts` ~250).                                                                         | Adding one definition re-signs the policy and launch targets of all N definitions. Every client then re-admits each one. There are 5 indexed definitions today and 452 operational ones. At today's mean of 17.4 KB of content per definition, the 32 MiB content budget is reached at about 1,900 definitions (4.4). |
| Execution content           | Each definition has an entry leaf plus contract leaves (`catalog_projection` among them). Leaves are immutable and content-addressed. Installs keep the exact bytes in the library's retained contracts.                                                                                                                                                                                                                                                                                                                                                                                              | Every leaf is a TUF target, so each new leaf grows `official-definitions` metadata.                                                                                                                                                                                                                                   |
| Publisher tooling           | `catalog-publish.yml` runs prepare (keyless), four signing jobs (one environment and secret each) and publish. Prepare fetches the full `gh-pages` history (~84). `verify_history` (`repository.rs` ~261) runs `HistoricalRevisionFloors::observe` (~541–640) over every retained metadata version. That reads every historical listing body to derive its revision, decoded SHA-256 and withdrawals and to detect equivocation, and it bounds other `policy/official` targets at 65,536 bytes. `catalog-pages-overlay.mts` fails when a retained file is missing.                                    | Work and storage grow with every publication, and no deletion route exists. Pruning a body without a replacement for `observe` would break the next publication (6.1). The workflow enforces 768 MiB and 65,536 files for the retained tree and 900,000,000 bytes for Pages.                                          |
| History checkpoints (inert) | `history_checkpoint.rs`: a pointer target, active checkpoints and inventory segments under `catalog-history/sha256/`, with a shared bound of 4,096 objects and 64 MiB. A root mismatch fails with `ROOT_ROTATED`. Bootstrap needs a manual owner dispatch.                                                                                                                                                                                                                                                                                                                                            | The segment chain reaches its bound after about 2,048 publications, about 8.7 months at 7.7 publications a day. There is no path through root rotation and no compact retirement.                                                                                                                                     |
| Caches (client)             | SQLite `listing_delivery`, `compact_listing_delivery`, `definition_publisher_authority` (replay floor, migration 33), `definition_selection_state` (26) and `definition_subject_selection` (72). `CURRENT_SCHEMA_VERSION` is 77.                                                                                                                                                                                                                                                                                                                                                                      | A whole-document cache holds one copy of everything, so nothing unchanged can be reused. There is no persisted safety state separate from the carrier rows.                                                                                                                                                           |
| Release-side readers        | `catalog-released-reader.mts` selects and attests the Preview reader. Publish restores pinned inputs from `PRIOR_COMMIT` with `--depth=1` (~308).                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Prepare's full-history fetch grows with history.                                                                                                                                                                                                                                                                      |
| Transport                   | `DefinitionHttpsTransport` uses `reqwest` without the `gzip` feature, plain streamed `GET`s, no redirects, no proxy and no `Range`. Timeouts are 20 s per request and 120 s overall. Up to eight target fetches run at once.                                                                                                                                                                                                                                                                                                                                                                          | Pages offers gzip, but Portcove never asks for it.                                                                                                                                                                                                                                                                    |

### 2.2 Measured numbers (2026-11-23)

The method is in the [appendix](#appendix-measurement-method). All byte counts
are exact file or response sizes unless marked ≈.

**Served tree at `c912fc37`:** 1,614 files, 404,921,640 bytes. The retained
catalog tree checked by the 768 MiB bound is 404,914,714 bytes.

| Part                                       | Files | Bytes       |
| ------------------------------------------ | ----- | ----------- |
| Legacy listing bodies (47 versions)        | 47    | 390,631,685 |
| `browse/` (projection, search, game pages) | 1,294 | 13,787,563  |
| Metadata (60 versions of three roles)      | 183   | 280,308     |
| Other targets (leaves, index, policies)    | 87    | 215,158     |
| Everything except listing bodies           | 1,567 | 14,289,955  |

**Publication rate.** Policy v1 to v60 took 7.69 days, which is 7.8
publications a day. Listing bodies changed in 46 transitions between
2026-11-18T07:35Z and 2026-11-23T15:53Z (5.35 days, **8.6 a day**). #8619
measured **6.7 a day** over the week. 25 of those 46 transitions changed a
descriptive field of a row present on both sides or the withdrawals. That is
4.7 a day over the window and 3.4 a day over the last 50 hours.

**Legacy listing v60:** format 11, revision 47, 1,193 rows, 933 with an
observation, no withdrawals. `fresh_until − observed_at` is 43,200 s on all 933.

**Authored descriptive rows** (`crates/portcove-core/catalog/listings.json`
at `5ea4d3570`): format 15, **1,649 rows; this is 1× throughout**. Canonical
JSON is 5,364,231 bytes; the largest record is 8,517 bytes.

**Observation churn.** The legacy body is the only published record of
observations, and it is byte-budgeted. A reconstruction without the budget
carries each ID's latest published observation forward when a body omits it.
That is the compact rule ("keeps its prior signed observation"). Across all 47
bodies, 1,458 of the 1,649 IDs have an observation at some point.

| From → to | Raw legacy: appeared · vanished · facts changed (rows in both) | Without the budget: facts changed · freshness only |
| --------- | -------------------------------------------------------------- | -------------------------------------------------- |
| v54 → v55 | 70 · 99 · 3                                                    | 22 · 173                                           |
| v55 → v56 | 66 · 91 · 14                                                   | 20 · 282                                           |
| v56 → v57 | 46 · 35 · 4                                                    | 11 · 161                                           |
| v57 → v58 | 39 · 18 · 1                                                    | 4 · 140                                            |
| v58 → v59 | 146 · 117 · 1                                                  | 10 · 118                                           |
| v59 → v60 | 99 · 81 · 11                                                   | 11 · 414                                           |

Revision 1 counted every appearance and disappearance as an observation
change (191 and 264 rows). Those were budget artifacts. The reconstruction
is a **lower bound** on true observer churn: refreshes of rows the budget
omitted are invisible. PR 0 settles that with an observer-enriched compact
dry run (9).

**Git history of `gh-pages`** (`git count-objects -vH` on a
`--single-branch --bare` clone at `758583339`): 74 commits, 111,748 objects,
**63.87 MiB packed**. The span is 9.9 days, so it grows about 6.8 MB a day.
On-disk size by path:

| Path                     | Blob versions | Raw bytes   | Packed bytes | Packed per publication |
| ------------------------ | ------------- | ----------- | ------------ | ---------------------- |
| `browse/`                | 110,777       | 544,495,879 | 49,695,341   | ≈0.71 MB               |
| Legacy listing bodies    | 47            | 390,631,685 | 13,922,603   | ≈0.30 MB per change    |
| Metadata, targets, trees | 835           | 1,154,535   | 176,242      | ≈2.5 KB                |

**Delta behavior, measured** by committing v59 and then v60 to a scratch
repository and repacking with `--window=250`:

| Encoding of the same listing change | File size | Added to the pack |
| ----------------------------------- | --------- | ----------------- |
| Raw JSON (legacy today)             | 8,388,398 | 88 KiB            |
| gzip level 9                        | 1,788,857 | 1,743 KiB         |
| base64 of gzip (compact's carrier)  | 2,385,144 | 1,761 KiB         |

A compressed body adds its full size to history on every change.

**Client transfer per refresh, today:**

| Client                                         | Transfer                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Legacy reader (Preview ≤ 13)                   | 8,388,398 bytes. Pages returns `content-encoding: gzip` at 1,838,076 bytes when asked, but Portcove sends no `Accept-Encoding`. |
| Compact reader (Preview 14), #8619 offline run | 2,745,010 bytes on the wire; 9,602,327 decoded for 1,649 rows with the legacy (budgeted) observations                           |

**Pages runway** (768 MiB retained-tree bound, 400,391,654 bytes left at
`c912fc37`):

| Situation                                                         | Listing changes a day | Growth a day | Days left        |
| ----------------------------------------------------------------- | --------------------- | ------------ | ---------------- |
| Legacy only (today)                                               | 6.7–8.6               | 56–72 MB     | **5.5–7.1**      |
| Compact active (#8619), each change adds 2,745,010 bytes          | 6.7–8.6               | 18.4–23.6 MB | **17.0–21.8**    |
| Compact active plus the stop-gap (6.3): descriptive + 2 scheduled | 5.4–6.7               | 14.8–18.4 MB | 21.8–27.1        |
| Body window active (6.1), any of the above                        | —                     | ≈0.036 MB    | effectively none |

Compact activation alone triples the runway but does not stop growth, so
**body retention stays urgent after activation**, not merely desirable. It is
the only step that bounds the served tree. With compact active it should be
activated within about 10 days, which leaves a week of margin. After that the
served catalog tree is about 31 MB (legacy only) or 37 MB (with compact), and
it grows only by about 36 KB a day of metadata versions.

**Bandwidth.** GitHub documents a soft limit of 100 GB a month for Pages.
With one refresh per client per day:

| Reader                           | Per client-day | Daily clients within the limit |
| -------------------------------- | -------------- | ------------------------------ |
| Legacy                           | 8.39 MB        | ≈400                           |
| Legacy with PR 5 gzip            | 1.84 MB        | ≈1,800                         |
| Compact                          | 2.75 MB        | ≈1,200                         |
| Manifest (this design), measured | ≈1.2–1.6 MB    | ≈2,100–2,800                   |

Actual client counts are UNKNOWN; there is no telemetry.

### 2.3 Why the current shape does not scale

- **Retention grows with every publication.** Each listing change keeps a
  complete projection forever. Today that is 96.5% of the served tree.
- **Transfer grows with the catalog, not the change.** Each refresh downloads
  the whole directory, even when only freshness timestamps changed.
- **Old readers set the bounds.** The legacy target is full. Optional
  observations churn in and out of it to fit, which makes every publication
  look like a large change.
- **Definition work is O(N) per change.** The global index binding re-signs
  every subject's policy and launch records on each addition.
- **Verification has a hard ceiling.** `verify_history` reads every retained
  body, and the inert checkpoint chain hits its bound within months.
- **Compressed carriers inflate Git history.** Compact adds 2.75 MB of
  history per change, where legacy JSON adds about 0.30 MB.

## 3. Proposed design

### 3.1 Overview

```text
timestamp.json ─▶ N.snapshot.json ─▶ N.official-policy.json      (existing roles, keys, expiry)
                                        │  names, by length + SHA-256:
                                        ├─ policy/official/catalog.listings.json          (legacy, frozen, format 11)
                                        ├─ policy/official/catalog.listings.compact.json  (compact, live until bound or end of support)
                                        └─ policy/official/catalog.manifest.json          (NEW, ≤1 MiB)
                                               │ names, by stored length, SHA-256, decoded length, decoded SHA-256:
                                               ├─ objects/sha256/<hex>.jsonl.gz   descriptive stream chunks
                                               ├─ objects/sha256/<hex>.jsonl.gz   observation stream chunks
                                               ├─ objects/sha256/<hex>.jsonl.gz   freshness object (one)
                                               └─ objects/sha256/<hex>.json       manifest continuation pages
                 └─▶ N.official-definitions.json ─▶ definitions/index.json, sha256/*.json   (unchanged role and scope)
```

The manifest is the only new signed object. The signed parent names each
child by exact length and SHA-256, the way TUF authenticates targets.
Definitions are not part of the manifest; they keep their own role (4).

### 3.2 Trust placement

| Object                                | Signed or bound by                                                       | Change from today                                    |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `root.json`, top-level `targets.json` | Offline root and targets keys                                            | None                                                 |
| `snapshot.json`, `timestamp.json`     | Existing online keys; expiry 7 d and 1 d                                 | None                                                 |
| `official-policy.json`                | Existing `official-policy` key; scope `policy/official/*.json`           | One more target name in the existing scope           |
| `catalog.manifest.json`               | Named by `official-policy` (length and SHA-256)                          | New target                                           |
| Chunks, freshness object, pages       | Named by the manifest (lengths and SHA-256s)                             | New, outside TUF                                     |
| `official-definitions.json`           | Existing key; scope exactly `definitions/index.json` and `sha256/*.json` | None. The policy key never signs definition content. |

**Why chunks are not TUF targets.** Listing 129–923 chunks in
`official-policy` would add about 30–210 KB to a role that every client,
legacy included, downloads on every refresh. The publisher re-signs and
retains that role on every publication. Binding through the manifest is the
same hash-and-length check `tough` applies to targets. The publisher already
uses this outside-TUF pattern for `catalog-history/` objects.

**Replay and expiry.** The manifest's provenance is the existing
`PolicyProvenance`: five role versions and digests, with `expires_at` set to
the earliest role expiry. It advances the same
`definition_publisher_authority.replay_floor_json`.

**One listing revision floor, distinct revisions per carrier (F1f).** Every
carrier (legacy, compact, manifest) shares one revision floor.

- **Publisher guarantee.** Each publication gives every carrier it changes a
  distinct revision strictly above the maximum over all carriers. For
  example, compact gets R+1 and the manifest gets R+2. The policy signer
  refuses one policy version whose carriers share a revision.
  `verify_history` refuses a revision that appears on two carriers.
- **Reader refusal.** Today `admit_listings` refuses a lower revision, or an
  equal revision with different bytes, against the stored carrier.
  `AuthenticatedListings::stored` refuses stored legacy and compact rows at
  an equal revision with different bytes. Byte equality cannot be used across
  a manifest and a whole-document carrier. So the manifest reader refuses any
  candidate whose `listing_revision` equals a revision stored by any carrier,
  unless it is an exact retry: the same carrier and the same manifest digest.

**Safety floor (F1a).** Adoption of any carrier writes, in the same
transaction as the revision floor, a `listing_safety_floor` row:

- `withdrawn_ids`: the monotonic union of every withdrawal ever adopted;
- `held_ids`: the holds of the floor revision;
- the floor revision and a digest.

Every load path applies this floor: the active manifest, a stored compact or
legacy row, and the bundled directory. Withdrawn IDs are removed, with the
existing protection of managed ports. Held IDs are held. A fallback can never
resurrect a withdrawn row or lift a hold. Only an adopted higher revision can
lift a hold. The first open after the migration initializes the floor from
the stored carrier rows.

### 3.3 Object layout

**Paths on Pages:**

- `catalog/objects/sha256/<64 hex>.jsonl.gz` for chunks and the freshness
  object;
- `catalog/objects/sha256/<64 hex>.json` for manifest continuation pages.

Each name is the SHA-256 of the exact stored bytes. **The reader derives
every object URL only from a validated 64-character lowercase hex digest**
(`^[0-9a-f]{64}$`) plus a fixed suffix chosen by the object's role. It never
uses a path, name or URL string from a manifest (F1e). `catalog-pages-overlay.mts`
and the assembly inventory gain exactly these two patterns.

**Manifest:** canonical JSON, at most 1 MiB, strict, duplicate keys rejected.

```json
{
  "manifest_schema": 1,
  "listing_revision": 50,
  "issued_at": 1764000000,
  "required_features": ["catalog.chunked-manifest-v1"],
  "withdrawn_ids": ["..."],
  "held_ids": ["..."],
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

- `prefix` is eight hex digits: the chunk's 32-bit key prefix, left-aligned,
  of which `depth` bits count.
- `length` and `sha256` bind the stored gzip bytes. `decoded_length` and
  `decoded_sha256` bind the decoded JSON lines (F1b).
- `aggregate` must equal the sums over every page; the reader checks it
  before any fetch.
- The chunks of a stream must partition the 32-bit key space exactly, with no
  gap and no overlap. A record can therefore appear in only one place, and a
  range cannot be hidden.
- `withdrawn_ids` and `held_ids` stay inline, at most 10,000 entries each, as
  today. `held_ids` is the base whole-listing hold every reader understands.
  The signer requires it to equal the hold projection of the descriptive
  records' typed restrictions, which is the existing legacy-hold equality
  rule.
- `continuation` is either null or `{length, sha256}` for the next page. A
  page holds at most 4,000 chunk entries, and a manifest has at most 64
  pages. An entry is about 230 bytes. The root page is about 30 KB at 1× and
  about 210 KB at 10×, so continuation starts at about 40× today's rows.

**Chunk:** gzip (RFC 1952, one member, `mtime` 0, no name) of UTF-8 JSON
lines.

- **Line 1 is a header:**
  `{"chunk_schema":1,"stream":"listings.descriptive","envelope_version":1,"prefix":"00000000","depth":6}`.
- **Each further line is one record envelope**, canonical JSON with sorted
  keys, sorted by `id`: `{"id":…,"requires":[…],"value":{…}}`. `requires` is
  omitted when empty (5.3).
  - In the descriptive stream, `value` is the existing `CatalogListing`
    without `upstream_observation`.
  - In the observation stream, it is the observation without `observed_at`,
    `attempted_at` and `fresh_until`.
- **The reader checks** that each record's `sha256(id)[0..depth bits]` equals
  the prefix, that IDs are unique and sorted, and that the record count
  matches the manifest.

**Freshness object:** one gzip JSON-lines object, outside the chunk
partition. Each line is `{id, observed_at, attempted_at, fresh_until}`.
`fresh_until` stays explicit; it is not derived from a TTL. The object is
rewritten on every observer refresh, since about a quarter of the rows
refresh each publication. Splitting it would therefore save nothing.

**Bounds per object:**

| Object                   | Limit                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Record                   | 1 MiB decoded (unchanged Core bound)                                                                                                                                                                                                                                                                                                         |
| Chunk                    | 256 KiB decoded, 192 KiB stored, 4,096 records. **Oversize single-record chunk (F1d):** a chunk holding exactly one record may reach 1 MiB plus 4 KiB of header decoded. The publisher splits until a chunk is within 192 KiB or holds one record. If two records share all 32 key bits and together exceed 256 KiB, publication is refused. |
| Freshness object         | 4 MiB decoded, 1 MiB stored (1×: 249,291 / 49,462 bytes)                                                                                                                                                                                                                                                                                     |
| Manifest page            | 1 MiB; at most 64 pages                                                                                                                                                                                                                                                                                                                      |
| Aggregate (reader bound) | 4,096 objects and 48 MiB summed `decoded_length` for this reader release (1× is 12.0 MB). Checked before the first chunk fetch.                                                                                                                                                                                                              |
| Concurrent fetches       | 8 (unchanged `TARGET_CONCURRENCY`)                                                                                                                                                                                                                                                                                                           |
| Timeout per request      | 20 s (unchanged)                                                                                                                                                                                                                                                                                                                             |
| Progress timeout         | 120 s without one completed object fails the refresh. Completed chunks stay staged.                                                                                                                                                                                                                                                          |
| Overall deadline (F1c)   | 120 s + planned stored bytes ÷ 32 KiB/s, at most 30 minutes. That is about 206 s for a 1× cold fetch and about 16 minutes for a 10× cold fetch.                                                                                                                                                                                              |

### 3.4 Record-to-chunk mapping and rewrite fraction

The key is the first 32 bits of the SHA-256 of the UTF-8 stable ID, a value the
publisher cannot choose for a given ID.

- **Start.** Each stream starts at depth 6, which is 64 chunks.
- **Split only.** The publisher splits a chunk into its two depth+1 children
  when its decoded size would exceed 192 KiB. Chunks never merge. Merging and
  hysteresis are deferred until a measured shrink needs them (10).
- **Stability.** A split rewrites only the chunk being split. An existing
  record never moves unless its own chunk splits.

**Parameters measured** (exactly as specified): gzip level 9, `mtime` 0,
start depth 6, split above 192 KiB decoded, canonical JSON lines. The 5× and
10× catalogs are 1× clones with suffixed IDs. Changes are k distinct
descriptive records drawn with seed 1422, averaged over 10 trials.

| Catalog | Descriptive rows | Chunks (descriptive + observation) | Set, gzip  | Largest chunk, decoded |
| ------- | ---------------- | ---------------------------------- | ---------- | ---------------------- |
| 1×      | 1,649            | 64 + 64                            | 2,783,306  | 155,300                |
| 5×      | 8,245            | 216 + 242                          | 13,555,800 | 195,982                |
| 10×     | 16,490           | 431 + 491                          | 27,098,387 | 195,751                |

The freshness object adds 49,462 bytes at 1×, so the full 1× set is 2,832,768
bytes.

**Rewrite for 1, 10 and 100 changed descriptive records.** Each cell gives the
descriptive chunks rewritten, the gzip bytes rewritten, and the share of the
descriptive and observation set.

| Catalog | 1 changed                      | 10 changed                      | 100 changed                       |
| ------- | ------------------------------ | ------------------------------- | --------------------------------- |
| 1×      | 1 of 64 · 22.1 KB · **0.79%**  | 9.6 of 64 · 221 KB · **7.9%**   | 50.9 of 64 · 1.17 MB · **42.1%**  |
| 5×      | 1 of 216 · 36.2 KB · **0.27%** | 9.7 of 216 · 332 KB · **2.45%** | 80.1 of 216 · 2.75 MB · **20.3%** |
| 10×     | 1 of 431 · 38.1 KB · **0.14%** | 9.8 of 431 · 341 KB · **1.26%** | 88.0 of 431 · 3.00 MB · **11.1%** |

A whole-document carrier rewrites 100% in every cell.

**One-time cost of the generated-registration migration.** #8619's migration
rewrites 200–400 listing-only identities, effectively at random over the key
space. At 1× that rewrites 61.8 of 64 descriptive chunks (1.41 MB) for 200
records, and 63.9 of 64 (1.455 MB) for 400. That is one full descriptive
stream, once. Observation chunks are unaffected.

**Real publications at 1×**, reconstructed without the byte budget (2.2):

| From → to | Observation chunks rewritten | Bytes   | Freshness object |
| --------- | ---------------------------- | ------- | ---------------- |
| v50 → v51 | 9 of 64                      | 185,601 | 49,154           |
| v51 → v52 | 10                           | 221,805 | 49,196           |
| v52 → v53 | 0                            | 0       | 49,201           |
| v53 → v54 | 16                           | 330,168 | 49,371           |
| v54 → v55 | 19                           | 455,804 | 49,295           |
| v55 → v56 | 18                           | 377,442 | 49,268           |
| v56 → v57 | 11                           | 222,715 | 49,317           |
| v57 → v58 | 4                            | 93,712  | 49,349           |
| v58 → v59 | 9                            | 184,513 | 49,407           |
| v59 → v60 | 10                           | 224,146 | 49,462           |
| Mean      | 10.6                         | 229,591 | 49,302           |

- **A publication** is therefore about 0.28 MB of chunks plus about 30 KB of
  manifest, plus any descriptive changes (22 KB per changed row at 1×).
- **A once-a-day client:** v50→v60 (30.8 h) rewrites 56 of 64 observation
  chunks (1,173,891 bytes). v57→v60 (12.1 h) rewrites 22 (483,120 bytes).
  With freshness, the manifest and recent descriptive corrections, a daily
  refresh is about 1.2–1.6 MB.
- **At 5× and 10×,** observation churn is UNKNOWN (11). If changed rows
  scale with rows, 10× would rewrite about 100 of 491 observation chunks
  (≈2.7 MB) and a ≈0.49 MB freshness object per publication.

The "finer observation depth" lever and the observation cadence gate (D2b)
from revision 1 are dropped. Measured without the budget, observation churn
does not justify them.

### 3.5 Streams and consumers

| Stream or consumer      | Content                                                                                                                                                                               | Older readers                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `listings.descriptive`  | Every canonical listing (1,649 today) without observations, each with its required features.                                                                                          | Legacy frozen; compact live (5).                                    |
| `listings.observations` | Observation facts per listing ID. When an optional candidate fails Core validation, compact's rule applies: only that row is excluded, and it keeps its prior signed observation.     | Compact carries them while live.                                    |
| Freshness object        | `observed_at`, `attempted_at` and `fresh_until` per observed ID.                                                                                                                      | —                                                                   |
| Definitions             | **Not a manifest stream.** They stay on `official-definitions`; policy decision schema 2 removes the O(n) rebind (4).                                                                 | Schema-1 decisions keep publishing until a released reader reads 2. |
| Execution content       | No change.                                                                                                                                                                            | —                                                                   |
| Publisher tooling       | Prepare reads the prior manifest and pages and fetches `gh-pages` at depth 1. `verify_history` reads the ledger for pruned versions (6.1). The overlay accepts planned removals only. | —                                                                   |
| Release-side readers    | `catalog-released-reader.mts` probes `chunked-manifest-v1` before manifest activation, and the schema-2 policy feature before schema-2 publication.                                   | —                                                                   |
| Caches                  | A content-addressed chunk store for reuse and diffing, plus an assembled-document selection row (3.8).                                                                                | Existing tables stay; the safety floor applies to them.             |

### 3.6 Reader algorithm (new reader)

1. **Load the TUF chain.** Run the existing `load_repository`: root updates,
   timestamp, snapshot, `official-policy`. Limits, expiry and the
   redirect-free transport are unchanged.
2. **Choose the carrier:** the manifest when it is named and every
   `required_features` entry is supported, then compact, then legacy. An
   unsupported manifest is reported as `listing_manifest_unsupported` and the
   reader uses a carrier it can read.
3. **Fetch the manifest** with a 1 MiB bound and verify its length and SHA-256
   against `official-policy`. Check freshness, the replay floor and the
   listing revision (3.2) before fetching anything else. An equal revision
   with the identical digest is an exact retry: renew the provenance and stop.
4. **Walk continuation pages**, each verified against its parent, at most 64,
   with loops refused. Check the partition of each stream and that
   `aggregate` equals the sums.
5. **Check the plan before any chunk fetch (F1b).**
   - The required set is every object the manifest names. The missing set is
     the required set minus digests already in the store.
   - If `aggregate.objects` exceeds 4,096, or `aggregate.decoded_length`
     exceeds this release's 48 MiB bound, refuse with
     `listing_manifest_update_required`.
   - Otherwise compute the overall deadline from the planned stored bytes.
6. **Fetch missing objects**, eight at a time. Each URL comes from its
   validated digest (F1e). The read is bounded by the manifest `length` and
   checked for SHA-256. It is gunzipped with output bounded by
   `decoded_length`, then checked for exact `decoded_length` and
   `decoded_sha256`. Then the header and each record's prefix, sort order and
   count are checked. A verified object is inserted into the store as
   **staged**. Staging is idempotent and carries no authority. The progress
   timeout and the overall deadline both apply.
7. **Assemble and validate.**
   - Build the directory: descriptive records joined with the observation and
     freshness of the same ID, plus withdrawals and holds. A record with an
     unsupported `requires` entry is skipped individually (5.3).
   - Run the existing projection dry run through Core's listing validators
     and `project()`, including format rules, restriction-scope inheritance
     and protection of managed ports.
   - Serialize the canonical assembled document and compute its SHA-256.
8. **Adopt** in one `Immediate` transaction:
   1. Re-check the floors and revision.
   2. Upsert `listing_manifest_selection` with the manifest bytes, pages,
      **the assembled canonical document and its digest**, provenance and
      revision.
   3. Advance `replay_floor_json` and `listing_safety_floor`.
   4. Mark the referenced objects active.
   5. Commit.
9. **On failure,** any error in steps 3–8 leaves the selection and the
   floors unchanged and records a typed code: `listing_manifest_incomplete`,
   `listing_manifest_verification`, `listing_manifest_unsupported`,
   `listing_manifest_update_required` or `listing_manifest_deadline`. Staged
   objects stay for the next attempt.
10. **Load order at every command start:** the active manifest selection (its
    assembled document, digest re-checked, if fresh), then the stored compact
    or legacy row (the existing rule), then bundled. The safety floor
    overlays all three. **The previous manifest is not a load-time fallback.**
    It is kept only for garbage collection and diagnostics.
11. **Clean up** after commit, outside the transaction. This is crash-safe
    because it only removes rows (3.8).

A cache-budget or bound refusal never wedges a client silently. The status
is typed, surfaced by `catalog listing-status` and Desktop as "update
Portcove to receive catalog updates". Legacy and compact stay named while
they are supported, so the reader keeps refreshing through them.

### 3.7 Publisher algorithm

**Prepare** (keyless):

1. Read the prior timestamp, its roles, the prior manifest and pages. Fetch
   `gh-pages` with `--depth=1` (PR 2).
2. Build the streams from the authored catalog plus observations, with no
   byte budget. Canonicalize each record envelope.
3. Partition by the prior layout, then apply splits only.
4. Gzip each object deterministically: level 9, `mtime` 0, no file name.
   Name it by the SHA-256 of the stored bytes. An unchanged object keeps its
   name.
5. Write the manifest. Assign each changed carrier a distinct revision above
   the maximum over all carriers (3.2).
6. Compute the retention plan (6.1).

**Sign.** Before signing `official-policy`, the policy signer checks the
manifest it is asked to sign:

- every new object's digests and lengths, recomputed from the staged bytes;
- the partition and the aggregate;
- that the floor rises, that revisions are distinct across carriers, and that
  withdrawals are a superset of every carrier's;
- that `held_ids` equals the restriction projection;
- that every named object that is not new is present in the prior served
  tree.

The historical bound in `HistoricalRevisionFloors::observe` is extended:
`catalog.manifest.json` is bounded at 1 MiB, and other non-listing policy
targets stay at 65,536 bytes.

**Assemble and publish:**

1. Restore from the pinned prior.
2. Overlay new objects under the `objects/` pattern.
3. Apply only planned removals (6.1).
4. Check the bounds.
5. Push and read back. Readback fetches the live manifest and **every**
   object it names, anonymously, and verifies them. A missing object fails
   the publication even when the manifest is served.

**Return.** `--return-to-compact` (PR 6) drops the manifest target. It
publishes compact above the manifest revision with every withdrawal and hold,
mirroring `--return-to-legacy`.

### 3.8 Client cache layout and garbage collection

Library migration N+1 (writer protocol bump):

```text
catalog_object(sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
               decoded BLOB NOT NULL CHECK(length(decoded) <= 1052672),
               decoded_sha256 TEXT NOT NULL,
               state TEXT NOT NULL CHECK(state IN ('staged','active')),
               staged_at INTEGER NOT NULL)
listing_manifest_selection(singleton, manifest_bytes, pages_json,
                           assembled_document BLOB, assembled_sha256,
                           provenance_json, revision,
                           previous_manifest_sha256)       -- diagnostics only
listing_safety_floor(singleton, revision, withdrawn_ids_json,
                     held_ids_json, sha256)
```

- **F3: the assembled document is the read path.** Every command reads the
  assembled canonical document (about 12 MB at 1×) and re-checks its digest,
  as compact does today. It never reassembles about 130 chunks at startup.
  The chunk store exists for reuse and diffing.
- **Writer protocol.** Older executables refuse a migrated library rather
  than lose the selection. This is the existing writer-protocol rule.
- **Collection.** After adoption, delete objects named by neither the active
  nor the previous manifest. Staged rows older than 7 days go too.
- **Bounds.** Chunk store ≤ 48 MiB active plus ≤ 48 MiB staged, and the
  assembled document ≤ 48 MiB. A manifest beyond the bound is refused
  **before any fetch** with `listing_manifest_update_required` (3.6). A later
  reader release raises the bound. Nothing is ever evicted below the active
  set.
- **Legacy tables** stay. The safety floor applies to them. Once a manifest
  is adopted, they are no longer written.

### 3.9 Hosting bounds

| Bound                                                                                                                         | Value                                               | Position after this design                            |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits): published site | 1 GB                                                | Served tree ≈41 MB at 1× (6.1)                        |
| Pages soft bandwidth                                                                                                          | 100 GB a month                                      | ≈1.2–1.6 MB per client-day at 1×                      |
| Git per-file limit                                                                                                            | 100 MiB, hard                                       | Largest object 1 MiB                                  |
| Retained-tree bound                                                                                                           | `PUBLIC_REPOSITORY_MAX_BYTES` 768 MiB; 65,536 files | Unchanged; applied after retention                    |
| Pages tree bound in the workflow                                                                                              | 900,000,000 bytes                                   | Unchanged                                             |
| `gh-pages` Git history                                                                                                        | GitHub recommends repositories stay well under 5 GB | Measured growth and the compaction trigger are in 6.6 |

Playing an installed game never reads any of this. Launch uses the library's
retained contracts (see
[DEFINITION-DELIVERY](../DEFINITION-DELIVERY.md#delivery-compatibility-and-retention)).
ScummVM's shared guides and definitions keep their existing records.

## 4. Definitions: policy decision schema 2

Revision 1 put a definitions stream into the policy-signed manifest. That
would have let the `official-policy` key vouch for definition content, which
the delegation separates on purpose. **It is removed (F5).**

- `official-policy` stays distinct from the definitions role.
- The `official-definitions` delegation keeps exactly `definitions/index.json`
  and `sha256/*.json`.
- The definitions transfer is small today: a 3,318-byte index for 5
  definitions.

### 4.1 Where the O(n) rewrite comes from

A schema-1 policy decision (`Availability`, `ManagedGithub` or
`ManagedForgeV1`) binds `namespace`, `stable_id`, `definition_revision`,
`definition_sha256` (the entry bytes), `template` **and the global
`index_sha256`**.

- `inspect_publication_policy` and `binds_projection` in
  `definition_publisher_policy.rs` (~269 and ~681) refuse a decision whose
  `index_sha256` differs from the candidate index.
- Launch records bind their policy's SHA-256.
- Any index change therefore re-signs every subject's policy and launch
  target. The publication receipt labels that kind `retained-index-rebind`
  (`scripts/catalog-publication-receipt.mts` ~250).

### 4.2 What the global binding provides, and how schema 2 keeps it

**Property:** a decision applies only to the exact definition bytes the
current definitions-signed index names for that subject. A subject that is
removed from the index, or revised, defeats the old decision.

The definitions-signed index already enforces this per subject:

- The reader resolves a subject only through the current, verified index:
  role, revision floor, then index.
- A removed subject has no entry, so no decision can apply to it.
- A revised subject has a new entry digest.
- A revoked subject carries a `Revoked` decision at a higher policy revision,
  and the per-target policy revision floor prevents rollback to the old
  decision.
- The entry names its contract leaves by content-addressed `sha256/<hex>.json`
  targets whose digests the index verifies. Binding the entry digest
  therefore transitively binds the contracts.

The global digest added only one thing: an unrelated subject's change also
invalidated every decision. No property depends on that.

**Schema 2** (`policy_schema: 2`) binds `namespace`, `stable_id`,
`definition_revision`, `entry_sha256` and `template`, and drops
`index_sha256`. The reader admits a schema-2 decision only when the current
verified index names this `(namespace, stable_id)` at `definition_revision`
with an entry whose digest is `entry_sha256`. Launch records keep binding
their policy digest. An addition then signs only its own policy and launch
targets.

### 4.3 Gating

1. **PR 7′a, Core first.** It parses and admits schema 2 and advertises the
   definition feature `catalog.policy-decision-v2` in the
   `definition_features!` table (`definition_capabilities.rs` ~42) and
   capabilities. It ships in a release.
2. **PR 7′b, publisher.** It emits schema 2 only when
   `catalog-released-reader.mts` verifies a released reader advertising that
   feature. Until then it keeps schema 1, and the rebind continues.
3. **Older readers** that do not read schema 2 keep their last-good decisions
   and report the existing policy-unsupported status.

### 4.4 Index bounds at scale

The index is about 664 bytes per definition. At the 4,096-definition bound
that is about 2.7 MB, 65% of its 4 MiB bound.

The binding limit is the **32 MiB shared content budget**. At today's mean
of 17.4 KB of entry and contract content per definition (87,102 bytes for
5), it is reached at about 1,900 definitions. That is a separate follow-up
outside this design; raising it is a reader feature with the same gate.

## 5. Compatibility

### 5.1 What each reader receives at each step

| Step                                        | Preview ≤ 13 (legacy, formats ≤ 12)                                                                                                                                                                       | Preview 14 (formats 5–15, `gzip-base64-json-v1`)                                                                                                                     | New reader (`chunked-manifest-v1`)          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Today                                       | Legacy: 1,193 of 1,649 rows; observations budgeted                                                                                                                                                        | Same legacy target                                                                                                                                                   | —                                           |
| Compact activation (#8619)                  | Legacy frozen. It changes only for holds and withdrawals and keeps the observations it had, which expire within 12 h (`fresh_until`). The client then queries providers live under anonymous rate limits. | Compact live: 1,649 rows with observations                                                                                                                           | —                                           |
| Body window active                          | No change                                                                                                                                                                                                 | No change                                                                                                                                                            | —                                           |
| Capable reader released                     | No change                                                                                                                                                                                                 | No change                                                                                                                                                            | Reads compact until a manifest is published |
| Manifest activation                         | No change                                                                                                                                                                                                 | **Compact stays live**, with full content, until it reaches its first bound or end of support                                                                        | The full live catalog, incrementally        |
| Compact reaches its bound or end of support | No change                                                                                                                                                                                                 | Compact frozen. Holds and withdrawals still arrive. Its observations expire within 12 h, then the client queries providers live. Rows added later are not delivered. | No change                                   |
| Final safety form (per carrier)             | Only held rows plus every withdrawal. Remote-only rows disappear, bundled rows stay, and the client is told to update.                                                                                    | The same, at compact's turn                                                                                                                                          | —                                           |

Each reader's upgrade path is the existing application updater.

### 5.2 Compact stays live (F4)

Compact is not frozen at manifest activation. It keeps publishing the full
directory, with distinct revisions (3.2), until the first of:

- its end of support (decision L6);
- its first bound.

**Which bound comes first.** The #8619 offline dry run measured 9,602,327
decoded and 2,745,010 wire bytes, with the budgeted legacy observations
(933 rows). With every observed row (1,458), compact is ≈12.1 MB decoded and
≈3.46 MB on the wire. So the **8 MiB wire bound is reached first**, at about
2.4× today's rows (≈2.1× under an 85% guard). The 32 MiB decoded bound comes
at about 2.8×, and the 10,000-record bound at about 6×.

**Served cost.** Two bodies (current and previous) are at most 16 MiB, and
about 7 MB today.

**Git cost.** Each change adds the full gzip body (2.2). That keeps
history growth at 18–24 MB a day from compact alone (6.6). The stop-gap
(6.3) reduces that while compact is live.

### 5.3 Format increases: per-record required features

The two-variant stream window from revision 1 is removed. Instead:

- **Each record envelope** may carry `requires: [feature, …]`. Each
  `listing.*` feature names a record capability added after format 15.
- **A reader that lacks a feature skips that record individually.** Its ID
  is treated as not delivered, so a bundled row stays.
- **Everything else still applies:** every other record, `withdrawn_ids`,
  `held_ids` (which hold the skipped ID too), and the safety floor.
- **The publisher never puts a safety fact behind a feature.** The base hold
  form in `held_ids` is always present.
- **Stream structure** (`envelope_version`) and manifest-wide
  `required_features` are reserved for structural changes. Those follow the
  released-reader gate.

### 5.4 Proof that an addition reaches an unchanged capable client

The T-ADD harness builds the CLI once. It then publishes fixture generation 2,
which adds a listing ID, a schema-2 definition subject and a compatible
correction. The unchanged binary must:

- fetch exactly the changed objects (transport counter);
- adopt them atomically;
- show the new ID in `catalog listing-status` and `catalog listings`;
- select the new subject.

The harness can start now against compact (an added row reaches an unchanged
Preview-14-shaped reader) and extend to the manifest in PR 4. The production
evidence is #246's ordered acceptance against the attested released reader
after manifest activation.

## 6. Retention and history

### 6.1 Body window with a listing-floor ledger (PR 1)

**Why the ledger comes first (F6).** `HistoricalRevisionFloors::observe`
(`crates/portcove-release-tools/src/definition_repository/repository.rs`
~541–640) reads every historical listing body named by every retained
`official-policy` version. It does this to:

- check the body against its signed length and digest;
- derive the revision, decoded SHA-256 and withdrawals;
- refuse equivocation ("catalog retained listing carrier history
  equivocates").

A missing body fails with "catalog public repository file missing". Pruning
any body without a replacement therefore breaks the next publication.

**Ledger.** `catalog/history-ledger/listing-floors.json` is canonical JSON,
append-only, with one entry per listing body ever named:

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

- **Creation (PR 1).** A run builds the ledger once from the real bodies,
  through the same `observe` code path, while every body is still present.
  It records the result in the publication receipt.
- **Verification.** On every run, every ledger entry's `policy_version`,
  `target` and `sha256` must equal a retained, signed metadata descriptor.
  The ledger must extend the prior run's ledger as an exact prefix. An entry
  is appended only by the run that still reads its body.
- **Pruned versions.** `verify_history` takes the revision, decoded digest
  and withdrawal digest from the ledger. The bodies in the window still go
  through the full `observe`. Equivocation across the ledger and window is
  still refused, because revisions map to one decoded digest.
- **Security role.** The newest bodies, which are never pruned, determine
  the floor, so a falsified old entry cannot lower it. A raised entry makes
  the publisher refuse, a denial of service that any `gh-pages` writer can
  already cause. After bootstrap, the checkpoint carries the ledger digest
  (6.4).

**Window.** Keep served:

- the current body of each carrier;
- the previous body of each carrier, so a client holding Pages' `max-age=600`
  metadata can still fetch it;
- every body named by a pin (6.2).

Metadata versions, root versions, definition leaves and policy targets are
all kept as today. Superseded bodies remain in `gh-pages` Git history.

**Bytes.**

| State                               | Bodies served                              | Freed       | Served catalog tree |
| ----------------------------------- | ------------------------------------------ | ----------- | ------------------- |
| Activated before compact            | 2 legacy (16,776,796)                      | 373,854,889 | ≈31.1 MB            |
| Activated with compact active       | 2 legacy + 2 compact (≈22.3 MB)            | all others  | ≈36.6 MB            |
| After manifest activation, 1× (6.7) | + current and previous chunk set (≈3.1 MB) | —           | ≈41 MB              |

After activation, growth is about 36 KB a day of metadata versions, so the
768 MiB bound is no longer a runway concern.

**Contract change.** The SIGNED-CATALOG statement that the publisher serves
the "complete retained graph" becomes "current, window and pins served;
superseded bodies in `gh-pages` Git history and the ledger".

### 6.2 Pin store and manual restore runbook (PR 1, before any prune)

`restore-publication` and checkpoint pins arrive later (6.5). Until then:

**Pin store.** A committed file, `release/catalog-publication-pins.json`, is
changed only by a reviewed PR:

```json
{
  "pins": [
    { "kind": "activation", "commit": "<gh-pages sha>", "note": "before body-window activation" }
  ]
}
```

- At most 8 pins.
- The publisher retains every body that the policy metadata of a pinned
  commit names.
- A pin of kind `last_good` may be passed for one run as the
  `catalog-publish.yml` input `retain_pin`. It is used only for that run.
- PR 1 adds the `activation` pin before the first prune.

**Manual restore runbook.** This is for a broken publication or a body
missing from the window.

1. Pick the pin commit `P`. Use the newest commit whose readback passed (the
   publication receipt records it).
2. In a fresh `gh-pages` worktree at the current head, restore each needed
   path:
   `git checkout P -- catalog/targets/<sha256>.policy/official/catalog.listings.json …`.
   Restore only paths whose name digest equals their content digest and
   that retained signed metadata names.
3. Run `portcove-release-tools verify-definition-repository` on the result.
4. Commit and push normally, never with force.
5. Dispatch an ordinary `catalog-publish.yml` renewal run. It republishes
   with higher role versions and a higher listing revision, and never
   re-serves old versions, which clients' floors would refuse.
6. Record the pin, the restored paths and the readback on #1422.

The restored bytes are previously signed and content-addressed, so this
needs no new authority (L, 7). Rehearsal: T-RESTORE-MANUAL on a fixture tree
(8).

### 6.3 Reversible stop-gap: observation-only legacy and compact publications

**Action.** A publication whose only listing change is observation facts or
freshness, with no descriptive, withdrawal or hold change, is deferred to
the two scheduled runs (05:13 and 17:13). Safety and descriptive changes
never wait.

**Arithmetic.** Over the last 5.35 days, 25 of 46 listing transitions changed
a descriptive field or withdrawals (4.7 a day; 3.4 a day over the last 50
hours). With the stop-gap, listing changes fall from 6.7–8.6 to about 5.4–6.7
a day:

- Legacy only: 400,391,654 / (5.4–6.7 × 8,388,398) = **7.1–8.8 days**,
  against 5.5–7.1 without it.
- Compact active: 400,391,654 / (5.4–6.7 × 2,745,010) = **21.8–27.1 days**,
  against 17.0–21.8 without it.
- Git history while compact is live: 14.8–18.4 MB a day of compact bodies,
  against 18.4–23.6.

It buys days, not a solution, because descriptive corrections are frequent
during the current catalog growth. Observation freshness shown to players can
then lag by up to 12 hours, still within the 12-hour `fresh_until`. Removing
the gate restores today's behavior.

### 6.4 History: previous checkpoint plus a K-deep suffix (F7)

**Two candidates for bounding verification:**

- **(a) Epochs and a ledger** (revision 1): rebase every 256 publications,
  verify up to 2 × 256 objects, and keep an epoch ledger.
- **(b) Previous checkpoint plus a K-deep suffix:** each run verifies the
  pointer, the previous active checkpoint, and its parents K deep (K = 16).

**Chosen: (b). It gives the same guarantee with fewer parts.**

- **Replay and equivocation protection** come from cumulative floors carried
  in each checkpoint. Each checkpoint is bound by digest through the pointer
  target, which signed `official-policy` metadata names. The signer of each
  run verified its predecessor before signing. So the floors of the previous
  checkpoint are authenticated, and the new floors must be a superset. Older
  objects are never relied on.
- **What epochs add.** A periodic full verification of 256 objects that
  nothing later depends on, plus an archival ledger. The K-suffix covers the
  objects recovery can use: the window and pins.
- **Simpler checkpoint.** It carries the active inventory (current, window
  and pins) instead of an all-time segment chain, so its size is bounded by
  retention.
- **No immutability check is lost.** Paths stay immutable by construction:
  objects are content-addressed, and metadata versions only rise. A re-added
  path must carry the bytes its digest names.
- **Cost.** At most K + 2 = 18 objects a run, about 1 MB, the same at 10,000
  publications. `SEGMENT_CHAIN_LIMIT` stays as a defense.
- **The ledger from 6.1** moves into the checkpoint as `listing_floor_ledger:
  {length, sha256}`.

**Workflow changes:**

- Prepare fetches `gh-pages` with `--depth=1` (PR 2). Today
  `catalog-publish.yml` ~84 fetches full history.
- Before any history compaction (6.6), re-pin to post-compaction commits.
  Record in the pin store and on #1422 that bundle restore is the only route
  for pins older than the compaction.

### 6.5 Root rotation, carrier retirement and `restore-publication`

- **Root transition.** A checkpoint with `root_sha256 = R_new` and
  `previous_root: {version, sha256: R_old}` is accepted only when the
  repository contains consecutive root versions from `R_old` to `R_new`. Each
  must be signed by both the old and the new threshold, which `tough`
  verifies for up to 32 updates. Anything else still fails with
  `ROOT_ROTATED`.
- **Retirement.** `retired_carriers: [{target, final_revision,
  final_decoded_sha256, withdrawn_ids_sha256, retired_at}]`. A successor may
  omit a carrier only when:
  1. the same checkpoint retires it;
  2. the shared floor rises;
  3. every remaining carrier's withdrawals are a superset of the retired
     carrier's.

  A retired carrier may return only above `final_revision`. This covers both
  compact to manifest-only and the manifest's own retirement, which is the
  return to compact after bootstrap.

- **`restore-publication --pin <commit>`.** It runs keyless and read-only. It
  verifies the pinned tree down to every object, then writes an overlay of
  exactly the missing addressed objects. The next publication renews them.
  Pins move into the checkpoint (`pins`, at most 8) and the pin store file is
  retired.

### 6.6 Git history growth and the compaction trigger (F8)

Measured in 2.2: `gh-pages` is 63.87 MiB packed. `browse/` is about 0.71 MB a
publication, legacy JSON about 0.30 MB a change, and gzip bodies their full
size.

| Delivery state                 | Growth a day (packed)                     | Days from 64 MiB to the 2 GiB trigger |
| ------------------------------ | ----------------------------------------- | ------------------------------------- |
| Today (legacy)                 | ≈6.8 MB measured                          | ≈310                                  |
| Compact live                   | browse 5.5 + compact 18.4–23.6 ≈ 24–29 MB | ≈72–87                                |
| Compact live with the stop-gap | ≈19–23 MB                                 | ≈90–110                               |
| Manifest active, compact live  | ≈26–31 MB                                 | ≈66–80                                |
| Manifest only (compact frozen) | browse 5.5 + chunks 0.28 × 7.7 ≈ 7.7 MB   | ≈270                                  |

**Trigger.** Compact history when the `gh-pages`-only packed size reaches
2 GiB, measured monthly by the PR 2 report from a bare single-branch clone.
Warn at 1.5 GiB. 2 GiB is 40% of GitHub's 5 GB strong recommendation and
leaves room for the main branch.

**Action (owner, O3).**

1. Re-pin to post-compaction commits (6.4).
2. Archive the old history as a `git bundle` release asset in this
   repository, split if over 2 GiB.
3. Force-push an orphan `gh-pages` commit holding the current served tree
   plus pinned objects.

**Note.** `browse/` is the largest steady contributor (≈0.71 MB a
publication, with pages rewritten on every run). Making its output stable is
a separate follow-up outside this design.

### 6.7 Generation retention for manifests and chunks

Same rule as bodies: keep the objects named by the current and previous
manifest, plus pins. Manifest bodies are `policy/official` targets, so the
ledger records their revisions too. At 1× that is about 3.1 MB served.
Older objects stay in Git history.

## 7. Activation sequence and decisions

**Authority:**

- **L (lead):** the lead holds delegation for reversible, evidence-checkable
  publication choices, including compact activation.
- **O (owner):** history bootstrap, root rotation, signing-role or key
  changes, and a `gh-pages` force-push that needs a branch-protection
  exception.

This design needs no signing-role or key change.

| Order | Step                                                                              | Authority  | Gate                                              |
| ----- | --------------------------------------------------------------------------------- | ---------- | ------------------------------------------------- |
| 1     | Compact activation (#8619)                                                        | L1         | Being decided now                                 |
| 2     | PR 0, PR 1 (body window, ledger, pin store, runbook; flag off), optional stop-gap | —          | Reviewed PRs                                      |
| 3     | Activate the body window                                                          | L2         | PR 1 merged; ledger verified on a real run        |
| 4     | PR 2, PR 3, PR 4; release the capable reader                                      | —          | Released reader with `chunked-manifest-v1`        |
| 5     | PR 6 (publisher manifest, flag off)                                               | —          | Rehearsal                                         |
| 6     | Manifest activation                                                               | L4         | Released capable reader verified by `select`      |
| 7     | PR 7′a released; then schema-2 publication                                        | L5         | Released reader with `catalog.policy-decision-v2` |
| 8     | History PRs H1, H2; generation retention                                          | L7         | Reviewed PRs                                      |
| 9     | History bootstrap                                                                 | **O1**     | H1, H2 and generation retention merged            |
| 10    | Final safety forms, per carrier                                                   | L6         | End of support                                    |
| —     | Root rotation; `gh-pages` compaction                                              | **O2, O3** | When needed; trigger in 6.6                       |

### 7.1 Decisions

**L1. Compact activation (lead; PR #8619).**

- **Action.** Merge #8619. Prepare passes `--official-released-reader`, and
  publish rechecks before the push.
- **Consequence.** Preview 14 receives all 1,649 rows. Legacy freezes for
  Preview ≤ 13, and its observations expire within 12 hours. Retained growth
  falls from 8.39 to 2.75 MB a change, so the runway rises from about 6 to
  about 17–22 days. Git history growth rises from about 0.30 to 2.75 MB a
  change.
- **Rollback.** Revert, then one reviewed `--return-to-legacy` publication.
  This is available until bootstrap.

**L2. Activate the body window (lead).** This is reversible from Git, and the
evidence is checkable from the ledger and the dry-run plan.

- **Action.** Merge the workflow change that passes `--retain-bodies window`
  after PR 1. Each run removes from `catalog/targets/` every listing body
  that is not current, not previous and not pinned, after the ledger holds
  its entry.
- **Consequence.** About 374 MB freed. The served catalog tree drops to
  ≈31–37 MB. Clients are unaffected, because they fetch only current
  targets. `verify_history` reads the ledger for pruned versions. The
  contract changes from "complete retained graph" to "current, window and
  pins".
- **Rollback.** The manual runbook (6.2) restores any body from Git. Then
  revert the flag.

**L3. Stop-gap deferral (lead, optional).**

- **Action.** Defer observation-only listing publications to the two
  scheduled runs.
- **Consequence.** About 25% more runway (6.3) and lower Git growth while
  compact is live. Freshness lags by up to 12 hours.
- **Rollback.** Revert the gate.

**L4. Manifest activation (lead; gated on a released capable reader).**

- **Action.** Merge the workflow change that passes `--manifest` with the
  `chunked-manifest-v1` released-reader gate.
- **Consequence.** A new `official-policy` target and the
  `catalog/objects/` tree. New readers transfer ≈1.2–1.6 MB a day instead
  of 2.75–8.39 MB per refresh. Compact stays live for Preview 14.
- **Rollback.** Before bootstrap: `--return-to-compact` (PR 6) in one
  publication, then revert the flag. After bootstrap: manifest retirement
  (6.5).

**L5. Policy decision schema 2 (lead; gated on a released reader).**

- **Action.** Enable the PR 7′b publisher path once
  `catalog.policy-decision-v2` is verified in the released reader.
- **Consequence.** An addition signs only its own policy and launch targets.
  Older readers keep their last-good decisions.
- **Rollback.** Republish schema-1 decisions at higher policy revisions.

**L6. Carrier end of support and final safety form (lead, per carrier).**

- **Action.** When the supported-release window in RELEASING no longer
  includes Preview ≤ 13 (or Preview 14), publish that carrier's final safety
  form, above the floor: held rows plus every withdrawal.
- **Consequence.** Those readers keep bundled data plus remote holds and
  withdrawals. Remote-only rows disappear for them until they update.
- **Rollback.** Publish the full carrier again above its final revision.

**L7. Generation retention for manifests and chunks (lead).** This is the
same class as L2.

- **Action.** Enable the window for `objects/`.
- **Consequence.** About 3.1 MB served at 1×.
- **Rollback.** Restore from Git, then revert the flag.

**O1. History bootstrap (owner).**

- **Action.** One `workflow_dispatch` with `bootstrap_history: true` on the
  H1/H2 code.
- **Consequence.** One-way. Checkpoints and the K-suffix are published.
  Return routes become retirements (6.5).
- **Rollback.** None by contract. Recovery uses `restore-publication`.

**O2. Root rotation (owner, only when needed).**

- **Action.** The offline quorum signs `2.root.json`. The next publication
  carries a root-transition checkpoint.
- **Consequence.** Clients follow the root chain, and history continues.
- **Rollback.** None. A further rotation is the only path.

**O3. `gh-pages` history compaction (owner).**

- **Action.** The steps in 6.6, with a branch-protection exception.
- **Consequence.** Bounded history. Pins older than the compaction are
  restorable only from the bundle.
- **Rollback.** Push the bundled history back to a branch; Pages is unaffected.

## 8. Test plan

All of these are hosted CI tests unless marked. Simulations use deterministic
seeds. Rust tests run on both the Windows and Linux partitions.

| ID                         | Scope                                                                                                                                                                                                                                                                                                                                                                                             | Owner                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| T-CHUNK                    | Exact cover, prefix check, deterministic bytes, split-only stability, the oversize single-record chunk, and refusal of a 32-bit collision over the bound. Rewrite fractions for 1, 10 and 100 changes at 1×, 5× and 10× within ±20% of 3.4. Catalogs are generated in the test.                                                                                                                   | `portcove-listing-carrier` (`manifest` module)      |
| T-READ                     | Cold, incremental and exact retry. Refusals: wrong length or digest, gzip trailing data, decoded length mismatch, prefix mismatch, gap or overlap, page loop or more than 64 pages, aggregate over bound **before any fetch**, non-hex digest, expired roles, lower revision, **equal revision across carriers**. A 404, and a slow server hitting the progress timeout and the overall deadline. | `portcove-core` `listing_delivery`                  |
| T-SAFETY                   | Withdrawal and hold, then fallback to compact, legacy and bundled: the row stays withdrawn and held. A hold is lifted only by an adopted higher revision.                                                                                                                                                                                                                                         | `portcove-core`                                     |
| T-INT                      | Interruption at each step, by fault injection and by process kill (the existing SIGKILL and `TerminateProcess` harnesses). No mixed generation, and the floors are unchanged.                                                                                                                                                                                                                     | `portcove-core`                                     |
| T-ADD                      | The frozen-binary proof (5.4). First against compact, then the manifest.                                                                                                                                                                                                                                                                                                                          | `portcove-cli` machine-contract tests               |
| T-COMPAT                   | Preview 13 and 14 fixture readers against a manifest-active repository. Legacy is frozen and compact live. Both receive a later hold and withdrawal. A record behind an unknown feature is skipped, while withdrawals still apply.                                                                                                                                                                | `scripts/listing-manifest-activation-rehearsal.mts` |
| T-LEDGER                   | Ledger built from real bodies equals `observe`'s floors. `verify_history` passes with bodies pruned outside the window. Refusals: a non-prefix ledger, an entry without a signed descriptor, and equivocation between the ledger and a window body.                                                                                                                                               | `portcove-release-tools` `repository`               |
| T-RESTORE-MANUAL           | Prune a fixture tree, run the runbook, verify, renew, read back.                                                                                                                                                                                                                                                                                                                                  | `scripts/catalog-publish.test.mts`                  |
| T-PUB                      | 3,000 simulated publications with descriptive changes, unbudgeted observation churn, splits, holds and withdrawals. Floors are monotonic, revisions distinct across carriers, the window holds, and each served generation is complete.                                                                                                                                                           | `portcove-release-tools` (simulation)               |
| T-HIST                     | 5,000 simulated publications with K = 16. At most 18 objects are verified a run. A tampered suffix is refused. Floors are a superset.                                                                                                                                                                                                                                                             | `history_checkpoint`                                |
| T-ROOT, T-RETIRE, T-EXPIRY | As in revision 1, plus manifest retirement and a compact return above `final_revision`.                                                                                                                                                                                                                                                                                                           | release-tools and core                              |
| T-POLICY2                  | A schema-2 decision binds a subject. A removed or revised subject, or a revoked decision, defeats it. An addition changes only its own targets. A schema-1 reader keeps last-good.                                                                                                                                                                                                                | core and release-tools                              |
| T-RELREADER                | Released-reader gates for `chunked-manifest-v1` and `catalog.policy-decision-v2`. A rate limit or a withdrawn version keeps the prior state.                                                                                                                                                                                                                                                      | `scripts/catalog-released-reader.test.mts`          |
| T-LIVE (manual, read-only) | After each activation: anonymous readback of all objects, and the four numbers recorded on #1422.                                                                                                                                                                                                                                                                                                 | —                                                   |

## 9. Implementation breakdown

Listed in order. "Now" means the PR can start without #8619 or any owner
decision. Every PR is inert by default unless marked.

| PR            | Start                          | Mechanism                                                                                                                                                                                                            | Files owned                                                                                                                                                                                                                                                                                                                                                             | Acceptance evidence and rehearsal                                                                                                                                                                                          | Rollback                                                                               |
| ------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 0             | **Now**                        | Re-measure: a committed read-only measurement script, run once against an observer-enriched compact dry run (authenticated artifact read in Actions; nothing published). It replaces the carry-forward lower bounds. | `scripts/catalog-distribution-measure.mts` (new), its test, `docs/design/CATALOG-DISTRIBUTION-SCALING.md`                                                                                                                                                                                                                                                               | Tables in 2.2 and 3.4 regenerated. Differences beyond ±20% are written into this design.                                                                                                                                   | Revert                                                                                 |
| 1             | **Now**                        | Body window (flag off), listing-floor ledger, pin store with the `activation` pin, manual restore runbook                                                                                                            | `crates/portcove-release-tools/src/definition_repository/repository.rs` (`HistoricalRevisionFloors`, `verify_history`, ledger), `scripts/catalog-publish.mts` (plan), `scripts/catalog-pages-overlay.mts` (planned removals), `.github/workflows/catalog-publish.yml` (flag off, `retain_pin` input), `release/catalog-publication-pins.json`, `docs/SIGNED-CATALOG.md` | T-LEDGER and T-RESTORE-MANUAL. A dry-run plan against the live `gh-pages` commit lists the bodies removed and ≈374 MB reclaimed, and shows every current, previous and pinned body kept and the ledger equal to `observe`. | Revert; never activated                                                                |
| S             | Now (optional)                 | Stop-gap deferral (6.3)                                                                                                                                                                                              | `scripts/listing-observation-delivery.mts`, `catalog-publish.yml`                                                                                                                                                                                                                                                                                                       | Rehearsal: an observation-only change is deferred, while descriptive and safety changes publish                                                                                                                            | Revert                                                                                 |
| L2            | After PR 1                     | **Activation: body window** (lead)                                                                                                                                                                                   | Workflow flag                                                                                                                                                                                                                                                                                                                                                           | First run: ledger written, plan applied, readback, next run's `verify_history` passes                                                                                                                                      | Runbook restore, then revert the flag                                                  |
| 2             | **Now**                        | Per-run report and shallow prepare fetch                                                                                                                                                                             | `scripts/catalog-publish.mts`, `scripts/catalog-publication-receipt.mts`, `catalog-publish.yml` (`--depth=1` at ~84)                                                                                                                                                                                                                                                    | Active, retained and changed bytes, client transfer, and a monthly packed-history size in the rehearsal                                                                                                                    | Revert                                                                                 |
| 3             | **Now**                        | Manifest and chunk format: split-only, per-chunk decoded length, aggregate and record bounds, the oversize single-record rule, record envelopes with `requires`, fuzzing                                             | `crates/portcove-listing-carrier/src/manifest.rs` (new)                                                                                                                                                                                                                                                                                                                 | T-CHUNK; fuzz targets for manifest and chunk decode                                                                                                                                                                        | Revert; pure code                                                                      |
| 4             | **Now** (after 3)              | Core reader, cache, assembled selection row, safety floor with the withdrawal union, typed `update_required`, capability through CLI and Tauri. **Then release it.**                                                 | `crates/portcove-core/src/listing_delivery.rs`, `database.rs` (migration, writer protocol), `types.rs` (`chunked-manifest-v1` in `listing_delivery_carriers` ~2910), `definition_repository.rs` (multi-object fetch, deadlines), CLI machine-contract test, Tauri capability passthrough                                                                                | T-READ, T-SAFETY, T-INT, T-EXPIRY, T-ADD on Windows and Linux                                                                                                                                                              | Inert without a manifest target; withdraw the Preview through `updates/withdrawn.json` |
| 5             | **Now** (optional)             | gzip transport for metadata and whole-document carriers                                                                                                                                                              | `Cargo.toml` (`reqwest` `gzip`), `definition_repository.rs` (bounds stay on decoded bytes)                                                                                                                                                                                                                                                                              | Legacy transfer drops from 8.39 to ≈1.84 MB in a fixture; decoded bounds still apply                                                                                                                                       | Revert                                                                                 |
| 6             | After 3 and 1                  | Publisher manifest preparation (`--manifest` off), signer checks, the historical bound for the manifest target, the `objects/` overlay pattern, distinct carrier revisions, `--return-to-compact`, rehearsal         | `scripts/listing-observation-delivery.mts`, release-tools `bundle.rs`, `signing.rs`, `repository.rs` (`observe` bound), `scripts/catalog-pages-overlay.mts`, `scripts/listing-manifest-activation-rehearsal.mts` (new), `docs/SIGNED-CATALOG.md`                                                                                                                        | T-COMPAT and T-PUB; rehearsal against a copy of the live prior: activation, add, hold, withdrawal, split, interrupted publication and return                                                                               | Revert; flag never passed                                                              |
| L4            | 4 released, 6                  | **Activation: manifest** (lead)                                                                                                                                                                                      | `catalog-publish.yml`, `catalog-released-reader.mts`                                                                                                                                                                                                                                                                                                                    | T-RELREADER; first-run readback of every object                                                                                                                                                                            | `--return-to-compact`, then revert                                                     |
| 7′a           | **Now**                        | Core: policy decision schema 2 reader and feature                                                                                                                                                                    | `definition_publisher_policy.rs`, `definition_capabilities.rs`, `definition_refresh.rs`, `definition_selection.rs`                                                                                                                                                                                                                                                      | T-POLICY2 (reader half)                                                                                                                                                                                                    | Revert; schema 1 still read                                                            |
| 7′b           | 7′a released                   | Publisher emits schema 2 behind the released-reader gate (L5)                                                                                                                                                        | release-tools `bundle.rs`, `scripts/catalog-prepare-publication.mts`, `scripts/catalog-publication-receipt.mts`                                                                                                                                                                                                                                                         | T-POLICY2; the receipt shows no `retained-index-rebind` for an addition                                                                                                                                                    | Republish schema 1 at higher policy revisions                                          |
| H1            | **Now** (groundwork)           | Checkpoint schema 2: previous checkpoint plus K-suffix, active inventory, ledger digest, root transition, `retired_carriers`                                                                                         | `crates/portcove-release-tools/src/definition_repository/history_checkpoint.rs`, release-tools `policy.rs`, `scripts/catalog-publish.mts`                                                                                                                                                                                                                               | T-HIST, T-ROOT, T-RETIRE                                                                                                                                                                                                   | Revert; inert                                                                          |
| H2            | After H1 and 6                 | `restore-publication` and checkpoint pins; retires the pin store file                                                                                                                                                | release-tools CLI, `catalog-publish.mts`, `catalog-publish.yml`                                                                                                                                                                                                                                                                                                         | T-RESTORE                                                                                                                                                                                                                  | Revert; inert                                                                          |
| R             | After 6 and L4                 | Generation retention for manifests and chunks (L7)                                                                                                                                                                   | `catalog-publish.mts`, `catalog-pages-overlay.mts`                                                                                                                                                                                                                                                                                                                      | T-PUB served-size series                                                                                                                                                                                                   | Restore from Git; revert the flag                                                      |
| O1            | After H1, H2, R                | **Bootstrap** (owner)                                                                                                                                                                                                | Dispatch only                                                                                                                                                                                                                                                                                                                                                           | A dry plan, then readback of the pointer and checkpoint                                                                                                                                                                    | None (one-way)                                                                         |
| F             | Per carrier, at end of support | Final safety forms (L6)                                                                                                                                                                                              | `listing-observation-delivery.mts`, release-tools signer                                                                                                                                                                                                                                                                                                                | T-COMPAT and T-RETIRE                                                                                                                                                                                                      | Publish the full carrier above its final revision                                      |
| T-ADD harness | **Now**                        | The frozen-binary harness (5.4), first against compact                                                                                                                                                               | `crates/portcove-cli` tests, fixture repository builder                                                                                                                                                                                                                                                                                                                 | The unchanged binary sees an added row with fetch counts asserted                                                                                                                                                          | Revert; tests only                                                                     |

**Start now, in parallel:** PRs 0, 1, 2, 3, 4 (after 3), 5, 7′a, H1 and the
T-ADD harness. PR 1 is the priority because of the runway. With compact
active, it should merge and be activated (L2) within about 10 days. The
`--return-to-compact` route is owned by PR 6.

## 10. Alternatives considered

| Alternative                                                   | Why rejected or deferred                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compact gzip only (activate #8619 and stop)                   | 100% rewrite and transfer per change. 2.75 MB retained and 2.75 MB of Git history per change. Its 8 MiB wire bound is reached at about 2.4× today's rows. It is the right short-term step.             |
| Definitions stream in the policy-signed manifest (revision 1) | Would let the `official-policy` key vouch for definition content, which breaks the role separation. Policy decision schema 2 removes the O(n) rebind without it (4).                                   |
| Chunk merging with hysteresis (revision 1)                    | Deferred. Split-only is simpler, and nothing measured shrinks. A merge can be added later under a format feature.                                                                                      |
| Observation cadence gate D2b and a finer observation depth    | Dropped. Without the budget, observation churn is ≈0.23 MB a publication. The stop-gap (6.3) is a temporary, reversible runway measure only.                                                           |
| Two-variant stream window for format increases (revision 1)   | Replaced by per-record required features (5.3): no duplicated projections, and per-record degradation without losing safety facts.                                                                     |
| Freezing compact at manifest activation (revision 1)          | It would silently degrade Preview 14 while it is still supported. Compact stays live until its bound or end of support (5.2).                                                                          |
| Epoch rebasing with an epoch ledger (revision 1)              | The same replay guarantee as a K-deep suffix, with more parts (6.4).                                                                                                                                   |
| Previous manifest as a load-time fallback (revision 1)        | It could resurrect rows withdrawn later. It is replaced by the persisted safety floor and carrier fallback (3.2).                                                                                      |
| One file per record                                           | 1,649 requests on a cold fetch today and about 16,500 at 10×. The manifest would be about 165 bytes × N. It reaches the 65,536-file bound after a few windows.                                         |
| HTTP range requests into one large file                       | `tough` and the transport issue plain `GET`s, and Pages range behavior on gzip responses is not a contract. Each publication would still rewrite a whole file.                                         |
| Delta encoding between generations                            | Clients at arbitrary floors need many deltas or a chain. Content-addressed chunks give most of the benefit with no chain.                                                                              |
| Hash-prefix delegated TUF roles                               | Refused by `policy.rs`. Needs new roles, a root change and offline ceremonies. No help for older readers.                                                                                              |
| Chunks as ordinary TUF targets                                | Every client downloads every entry in `official-policy` on every refresh.                                                                                                                              |
| Fixed shard count                                             | At 1× chunks are tiny; at 10× they are large, and resharding rewrites everything.                                                                                                                      |
| Storing chunks uncompressed and relying on Pages gzip         | Pages gzip is CDN behavior, not a contract. Raw JSON would delta-compress better in Git (2.2), but content-addressed chunk names do not pair as deltas reliably, and served bytes would be ≈4× larger. |
| A separate host or CDN, an object store, or release assets    | Violates "$0, no new infrastructure or provider".                                                                                                                                                      |
| Keeping all historical projections for compatibility          | Excluded by the owner.                                                                                                                                                                                 |

## 11. Open risks and UNKNOWNs

- **Runway (risk, urgent).** About 17–22 days with compact active, and
  5.5–7 days without it. If the body window is not active in time,
  publication stops, the timestamp expires within a day, and clients fall
  back to stored carriers and bundled data. A client with the safety floor
  (PR 4) keeps remote withdrawals; released clients keep only what their
  stored carrier holds.
- **True observer churn (UNKNOWN).** The reconstruction is a lower bound, and
  1,458 of 1,649 IDs have ever been observed. PR 0 measures with an
  observer-enriched dry run. Churn at 5× and 10× is UNKNOWN; T-PUB and the
  PR 2 report settle it.
- **Git growth while compact is live (risk).** About 24–31 MB a day, so the
  2 GiB trigger arrives in about 66–90 days and needs an owner compaction
  (O3). The stop-gap and compact's end of support are the levers. Stable
  `browse/` output is a separate follow-up.
- **Definition content budget (risk).** About 1,900 definitions at today's
  mean size (4.4).
- **Pages gzip (UNKNOWN as a contract).** Observed with `content-encoding:
  gzip` and `max-age=600`. The design does not rely on it.
- **Refresh behavior with an unchanged digest (UNKNOWN).** Settled by a
  transport-counter test on the Preview 14 archive.
- **Exact carrier support per Preview ≤ 13 (partly UNKNOWN).** Preview.12
  reads formats 5–12 (#8503). L6 needs `capabilities` from each retained
  archive.
- **Client population (UNKNOWN).** There is no telemetry.
- **Online key compromise.** As today, the policy key can sign any manifest.
  Floors stop replay, but not a fresh malicious publication. Definitions are
  not exposed to the policy key (4).
- **Clock skew.** Unchanged: expiry uses the client clock.

## Appendix: measurement method

All read-only, on 2026-11-23. The scripts lived in a scratch directory and
are reproduced by PR 0.

- **Tree.** `gh api repos/boburning/portcove/git/trees/<gh-pages sha>?recursive=1`
  and `git ls-tree -r -l c912fc37b` on the clone, summed by path.
- **Clone.** `git clone --bare --single-branch --branch gh-pages`, then
  `git count-objects -vH`. Per-path packed size comes from
  `git rev-list --objects gh-pages | git cat-file --batch-check='%(objecttype) %(objectsize) %(objectsize:disk) %(rest)'`.
- **Delta behavior.** A scratch repository with v59 committed, then v60, and
  `git repack -adf --window=250 --depth=50` after each commit. The same was
  done for gzip level 9 and for base64-of-gzip encodings of the same bodies.
- **Bodies and metadata.** All 47 listing bodies and `1..60.official-policy.json`
  from the clone. A body is mapped to its policy versions through the signed
  target digests. Transition times are the policy expiry minus 7 days.
- **Descriptive rows.** `crates/portcove-core/catalog/listings.json`
  (format 15, 1,649 rows), as canonical JSON (sorted keys, compact
  separators, UTF-8).
- **Observations without the budget.** For each body in policy order, an
  ID's observation is the body's observation when present, otherwise the
  previous state's. Facts are the observation without `attempted_at`,
  `observed_at` and `fresh_until`. Freshness is those three fields.
- **Chunking.** Key: the first 32 bits of the SHA-256 of the UTF-8 ID. Start
  depth 6. A chunk is split while it holds more than one record and its
  decoded bytes (header plus lines) exceed 196,608. Gzip level 9, `mtime` 0,
  no name. Freshness is one object.
- **Random changes.** For k ∈ {1, 10, 100, 200, 400}, k distinct descriptive
  records are drawn with `random.Random(1422)`, 10 trials. Each changes its
  `summary`. The layout is held fixed, and gzip bytes of every chunk whose
  digest is new are counted.
- **Synthetic catalogs.** 5× and 10× are 1× clones with suffixed IDs, for
  both streams.
- **Daily union.** New observation-chunk digests between the states at v50
  and v60, and at v57 and v60.
- **Wire size.** `curl -H 'Accept-Encoding: gzip'` against the v60 legacy
  target.
