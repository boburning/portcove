# Scaling signed catalog distribution (design, November 23, 2026)

Proposed design, revision 1. Nothing here is implemented or activated. The
[signed catalog contract](../SIGNED-CATALOG.md), the
[definition delivery contract](../DEFINITION-DELIVERY.md) and
[RELEASING](../RELEASING.md) stay the current contracts until each step below
lands through its own pull request. Work belongs to
[#1422](https://github.com/boburning/portcove/issues/1422) (bounded publication
across repeated history growth) and
[#246](https://github.com/boburning/portcove/issues/246) (ordered frozen-client
delivery). Source: `main` at `14ed722fa`. Measurements: the `gh-pages` tree at
`c912fc37b87a34da26a5944c7aa656e8a70eb92c` (committed 2026-11-23T16:09Z) and
anonymous Pages GETs on the same day.

## Summary

- **The publisher will stop in about a week.** The retained catalog tree holds
  404,914,714 of its 805,306,368-byte (768 MiB) bound. Every listing change adds
  one complete 8.39 MB legacy snapshot. Listings changed about 6.7 times a day
  last week, so roughly 47 more changes fit. When the bound is hit, publication
  stops. The 1-day timestamp then expires, and clients fall back to their
  bundled directory, safety withdrawals included. Compact activation (#8619)
  only stretches this to about three weeks. The first step is **D1**: stop
  serving superseded snapshot bodies. That is an owner decision and needs no
  new format.
- **The churn comes from observations, not the catalog.** Between the last two
  publications, 573 of 1,193 delivered rows changed. Every change was inside
  `upstream_observation`: 382 rows changed only their three freshness
  timestamps, 191 changed observation facts, and no descriptive field changed.
  Any whole-document carrier, compact gzip included, rewrites and re-downloads
  everything for those changes.
- **Design.** One small signed manifest,
  `policy/official/catalog.manifest.json`, is signed by the existing
  `official-policy` role under the existing root, delegation, expiry and
  replay floors. It names immutable chunks by SHA-256 and length. Chunks are
  gzip JSON-lines files under `catalog/objects/sha256/`, outside the TUF target
  tree, just like the existing `catalog-history/` objects. A record goes to the
  chunk whose bit prefix matches the SHA-256 of its stable ID. The prefix depth
  adapts per region (extendible hashing), so growth splits one chunk and leaves
  the others alone. Descriptive data, observation facts and freshness go in
  three separate streams. The reader fetches only the chunk digests it lacks,
  verifies every chunk, validates the complete result through the existing
  Core validators, and adopts it in one SQLite transaction. Otherwise it keeps
  its previous state.
- **Measured effect at today's size:**

  | Transfer                          | Bytes    |
  | --------------------------------- | -------- |
  | One publication's real change     | ~0.87 MB |
  | A day of real changes             | ~1.16 MB |
  | First full download               | ~2.0 MB  |
  | Today: legacy client per refresh  | 8.39 MB  |
  | Today: compact client per refresh | 2.75 MB  |
  - **A descriptive change of 1, 10 or 100 random records** rewrites 1.0%,
    8.3% or 44% of the chunk set at 1×. At 10× it rewrites 0.19%, 2.0% or 17%.
  - **New bytes kept per publication** drop from 8.39 MB to about 0.9 MB.

- **Older clients.** The legacy target, read through Preview 13, and the
  compact target, read by Preview 14, are each frozen to one current file.
  Each changes only for safety withdrawals and download holds, under the
  existing [legacy hold rules](../SIGNED-CATALOG.md#legacy-holds-after-compact-activation).
  Superseded copies are pruned. Complete historical projections are not kept
  for compatibility.
- **History.** Epoch rebasing replaces the unbounded chain walk. A signing
  run verifies at most 512 history objects (about 10 MB), however many
  publications there have been. Rebasing, root rotation, compact retirement
  and restoration each get a defined checkpoint successor.

## 1. Owner requirements and the mechanism that satisfies each

| Owner requirement (quoted)                                                                                                                                                          | Mechanism                                                                                                                                                                                                                                                               | Section     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| "Distribution that reuses unchanged content and avoids an ever-growing aggregate download: a small authenticated manifest referencing stable, content-addressed chunks"             | One `official-policy` target (`catalog.manifest.json`, ≤1 MiB) names chunks by SHA-256 and length. Chunk names are their own digests, so an unchanged chunk keeps its name and is never fetched again.                                                                  | 3.2, 3.3    |
| "integrated with the existing trust model (TUF roles, revision floors, expiry). Choose the smallest compatible implementation."                                                     | No new role, key, delegation path or root field. The manifest fits the existing `policy/official/*.json` scope. It shares the installed-authority replay floor, the shared listing revision and the earliest-role expiry. Chunks need no metadata entries of their own. | 3.2         |
| "Preserve authenticated identity, revision floors, expiry, withdrawals, restrictions and capability checks."                                                                        | Records keep their stable IDs and are checked against the manifest's chunk prefix. Withdrawals are inline in the manifest. Restrictions stay typed in format-15 records. Each stream declares a format and the required reader features.                                | 3.3, 3.6    |
| "Download and verify only changed or needed content."                                                                                                                               | The reader works out which digests it lacks by comparing manifests against its local content-addressed store. Every chunk is checked for length and SHA-256 before decoding.                                                                                            | 3.6         |
| "Stable chunking so a small change does not rewrite most of the distribution (… quantify rewrite fraction for 1, 10, 100 changed records at current, 5× and 10× catalog sizes)."    | Chunks are keyed by an ID-hash bit prefix with extendible split and merge. Descriptive data, observation facts and freshness are separate streams. Measured rewrite fractions are in 3.4.                                                                               | 3.4         |
| "Coherent activation across the accepted generation (all-or-nothing adoption after required content verifies)."                                                                     | Chunks are staged and the whole document is validated. Then one immediate SQLite transaction writes the selection row and the floors together.                                                                                                                          | 3.6         |
| "Preserve the previously accepted usable state across interruption, missing content, failed verification and recovery."                                                             | Staged chunks carry no authority. A failure before commit leaves the active and previous selections intact. Fallback order: active, then previous, then compact or legacy, then bundled.                                                                                | 3.6, 3.8    |
| "Bounded individual objects and requests while supporting complete catalogs through continuation."                                                                                  | A chunk is at most 256 KiB decoded and 192 KiB on the wire. A manifest page is at most 1 MiB, followed by content-addressed continuation pages. Aggregate bounds are set per reader, not by a single object.                                                            | 3.3, 3.9    |
| "Explicit older-client behavior including safety withdrawals and an upgrade path, WITHOUT indefinite duplication of complete historical projections as the compatibility strategy." | Legacy and compact are frozen to one current file each, which changes only for holds and withdrawals. Superseded bodies are pruned. Retirement ends with a final safety form (D5). Players upgrade through the existing application updater.                            | 4, 7        |
| "Prove a compatible catalog addition made after a client was built reaches that unchanged capable client."                                                                          | Test T-ADD with a frozen reader binary, plus #246 acceptance with the released reader.                                                                                                                                                                                  | 8           |
| "Cover ALL consumers: definition indexes, listing carriers, execution content, publisher tooling, caches, release-side readers."                                                    | Per-consumer rows in 2.1 and 3.5. Each consumer has its own PR in 9.                                                                                                                                                                                                    | 2.1, 3.5, 9 |
| "Publication history: bound verification work as publication count grows"                                                                                                           | Epoch rebasing every 256 publications. A run verifies at most 512 objects.                                                                                                                                                                                              | 6.1         |
| "preserve the revision and authority evidence needed for replay protection and supported client catch-up"                                                                           | Each checkpoint carries cumulative floors forward. An epoch ledger keeps every epoch's final identity. Root versions are never pruned.                                                                                                                                  | 6.1, 7      |
| "continuation across trusted-root rotation"                                                                                                                                         | A root-transition checkpoint, verified against the TUF root chain.                                                                                                                                                                                                      | 6.2         |
| "compact-carrier retirement and recovery"                                                                                                                                           | The checkpoint records `retired_carriers`, and a returning carrier must publish above its final revision.                                                                                                                                                               | 6.3         |
| "retention that preserves supported rollback/recovery while reducing repeated full snapshots"                                                                                       | A window of at least 16 generations and 48 hours, plus pins, within a 256 MiB budget. Older objects remain in Git history.                                                                                                                                              | 7           |
| "restoration from a pinned last-good publication"                                                                                                                                   | `restore-publication`: verify the pinned tree, overlay the missing addressed objects, then renew with higher versions.                                                                                                                                                  | 6.4         |
| "measure active bytes, retained bytes, changed bytes per publication and client transfer"                                                                                           | Section 2.2 holds today's measurements. A per-run report records these four numbers (PR 4).                                                                                                                                                                             | 2.2, 9      |
| "$0 hosting (GitHub Pages …); no new infrastructure or provider; Windows/Linux beta priorities; playing an installed game never depends on any of this; ScummVM unchanged."         | Everything stays on GitHub Pages and the `gh-pages` branch. The reader code is platform-neutral Rust and tests run on the existing Windows and Linux hosted partitions. Launch reads only retained local contracts. No change touches ScummVM.                          | 3.9, 11     |

## 2. Current architecture and measurements

### 2.1 Consumers

| Consumer                    | What it reads or writes today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Scaling limit                                                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing carriers (Core)     | `listing_delivery::acquire_listings` reads one target through `tough`. It takes `catalog.listings.compact.json` when signed metadata names it, and `catalog.listings.json` otherwise. Bounds: 8 MiB wire for both; compact decoded at most 32 MiB, 1 MiB per record and 10,000 records. `admit_listings` holds a replay check and a projection dry run in one immediate transaction. The exact bytes go to `listing_delivery` (migration 40) or `compact_listing_delivery`. That table is created lazily and holds the decoded document. | Every change re-downloads the whole document. The legacy target is full: 8,388,398 of 8,388,608 bytes, carrying 1,193 of 1,649 rows. Compact holds about 3.3× today's decoded size, and the 10,000-record bound holds about 6×.                                 |
| Definition index            | `definitions/index.json` plus content-addressed `sha256/<hex>.json` leaves, signed by `official-definitions`. Bounds: 4 MiB index, 4,096 definitions and a 32 MiB shared content budget. Each policy decision binds the global `index_sha256`, and each launch record binds its policy's SHA-256. The publisher enforces this in `scripts/catalog-prepare-publication.mts` and labels it `retained-index-rebind`.                                                                                                                        | Adding one definition re-signs the policy and launch targets of all N definitions. Every client then re-admits each policy. There are 5 indexed definitions today; there are 452 operational ones.                                                              |
| Execution content           | Each definition has an entry leaf plus a `catalog_projection` contract leaf: a whole `CatalogDocument`, sparse single-port in schema 3. Leaves are immutable. Installs keep the exact bytes in the library's retained contracts. The selection snapshot stores the full index bytes again for each subject.                                                                                                                                                                                                                              | Every leaf is a TUF target, so each new leaf grows `official-definitions` metadata. That role is re-signed and retained on every publication.                                                                                                                   |
| Publisher tooling           | `catalog-publish.yml` runs prepare (keyless), four signing jobs (one environment and secret each) and publish. `assemble_definition_repository` carries the whole prior tree forward and refuses any replacement. `verify_history` re-verifies every retained metadata version on every run. `catalog-pages-overlay.mts` fails when a retained file is missing (`assembled catalog omits retained file`).                                                                                                                                | Work and storage grow with every publication, and no deletion route exists. The workflow enforces 768 MiB, 65,536 files and 900,000,000 bytes for Pages.                                                                                                        |
| History checkpoints (inert) | `history_checkpoint.rs` uses a pointer target, active checkpoints and inventory segments under `catalog-history/sha256/`. Verification shares one bound of 4,096 objects and 64 MiB across both chains. Root SHA-256 is bound, and a mismatch fails with `ROOT_ROTATED`. Bootstrap needs a manual owner dispatch.                                                                                                                                                                                                                        | The bound is reached after about 2,048 publications. At the observed 7.7 publications a day that is **about 8.7 months**, not the three years the contract assumes at two a day. There is no rebasing, no path through root rotation and no compact retirement. |
| Caches (client)             | SQLite tables `listing_delivery`, `compact_listing_delivery`, `definition_publisher_authority` (replay floor, migration 33), `definition_selection_state` (migration 26) and `definition_subject_selection` (migration 72). `CURRENT_SCHEMA_VERSION` is 77.                                                                                                                                                                                                                                                                              | A whole-document cache holds one copy of everything, so nothing unchanged can be reused.                                                                                                                                                                        |
| Release-side readers        | `catalog-released-reader.mts` selects and attests the Preview reader. Prepare reads the whole `gh-pages` tree, and publish restores pinned inputs from `PRIOR_COMMIT`.                                                                                                                                                                                                                                                                                                                                                                   | Prepare's inputs and its 768 MiB check grow with history.                                                                                                                                                                                                       |
| Transport                   | `DefinitionHttpsTransport` uses `reqwest` without the `gzip` feature, plain streamed `GET`s, no redirects, no proxy and no `Range`. Timeouts are 20 s per request and 120 s overall. Up to eight target fetches run at once.                                                                                                                                                                                                                                                                                                             | Pages offers gzip, but Portcove never asks for it.                                                                                                                                                                                                              |

### 2.2 Measured numbers (2026-11-23)

Method: see the [appendix](#appendix-measurement-method). All byte counts are exact
file or response sizes unless marked ≈.

**Pages tree at `c912fc37`:** 1,614 files, 404,921,640 bytes.

| Part                                                        | Files | Bytes       | Share of `catalog/` |
| ----------------------------------------------------------- | ----- | ----------- | ------------------- |
| Retained legacy listing targets                             | 47    | 390,631,685 | 96.5%               |
| `browse/` (projection, search index, per-game pages)        | —     | ≈5,300,000  | 1.3%                |
| Metadata: 60 versions each of snapshot, definitions, policy | 180   | 275,876     | 0.07%               |
| Definition leaves                                           | 22    | 167,720     | 0.04%               |
| Definition index versions                                   | 9     | 18,767      | <0.01%              |

**Active metadata.** Timestamp v60 expires 2026-11-24T15:53Z. Snapshot,
`official-definitions` and `official-policy` v60 expire 2026-11-30T15:53Z.
Policy v60 names 11 targets: the 8,388,398-byte legacy listing plus five policy
and five launch targets of 212–853 bytes each. There is one root version.

**Publication rate.** Policy v1 to v60 took 7.69 days, which is **7.7
publications a day**. The listing target changed in 47 of the 53 publications
since it first appeared at v8. There are 74 `gh-pages` commits since
2026-11-14. The API reports the whole repository at 199,217 KiB packed, all
branches. The `gh-pages` share of that is UNKNOWN.

**Legacy listing v60:** format 11, revision 47, 1,193 rows, no withdrawals.

| Measure                                                         | Value                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Record bytes                                                    | 8,387,096 in total; mean 7,030; median 5,873; p95 14,194; max 36,596 |
| Rows with an observation                                        | 933                                                                  |
| `upstream_observation` bytes                                    | 4,469,841 (53%)                                                      |
| `manual_setup` bytes                                            | 2,334,560 (28%)                                                      |
| `fresh_until − observed_at`                                     | 43,200 s for all 933 observed rows                                   |
| Descriptive part alone: raw / gzip                              | 3,894,863 / 846,031                                                  |
| Observation facts alone (no timestamps): raw / gzip             | 4,354,149 / 771,818                                                  |
| Freshness table (three timestamps per observed row): raw / gzip | 153,111 / 30,309                                                     |

**Churn between real publications**, in rows:

| From → to          | Rows changed | Freshness only | Observation facts | Descriptive |
| ------------------ | ------------ | -------------- | ----------------- | ----------- |
| v59 → v60          | 573          | 382            | 191               | 0           |
| v58 → v59          | 295          | 31             | 264               | 0           |
| v55 → v60          | 825          | —              | —                 | >0          |
| v50 → v60 (≈1 day) | 1,010        | —              | —                 | >0          |

In v59 → v60 the observation-fact changes were mostly release asset IDs,
digests, URLs and sizes, with 33 new release versions.

**Client transfer per refresh, today:**

| Client                                                     | Transfer                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy reader (Preview ≤ 13)                               | 8,388,398 bytes. Pages returns `content-encoding: gzip` at 1,838,076 bytes when asked, but Portcove's `reqwest` build sends no `Accept-Encoding`. |
| Compact reader (Preview 14), measured by the #8619 dry run | 2,745,010 bytes on the wire; 9,602,327 decoded for 1,649 rows                                                                                     |

Whether a reader skips the target download when the digest is unchanged is
UNKNOWN. The current code path always reads the named target.

**Runway**, from #8619's measured rate of about 6.7 listing changes a day:

| Situation                | Growth per listing change | Changes left | Days left |
| ------------------------ | ------------------------- | ------------ | --------- |
| Today                    | ≈8.39 MB                  | ≈47          | **≈7**    |
| After compact activation | ≈2.75 MB                  | ≈145         | ≈21       |

At the 768 MiB bound, 400,391,654 bytes remain.

**Bandwidth.** GitHub documents a soft limit of 100 GB a month for Pages. With
one refresh per client per day:

| Reader          | Daily clients within the limit |
| --------------- | ------------------------------ |
| Legacy          | ≈400                           |
| Compact         | ≈1,200                         |
| Proposed design | ≈2,800                         |

Actual client counts are UNKNOWN; there is no telemetry.

### 2.3 Why the current shape does not scale

- **Retention grows with every publication.** Each publication keeps a complete
  listing projection forever, and that is 96.5% of storage. Nothing is ever
  deleted.
- **Transfer grows with the catalog, not the change.** Each refresh downloads
  the full directory, even when only freshness timestamps changed.
- **Old readers decide the bounds.** The legacy target is already full, and the
  1,193-of-1,649 row subset is the result of admission dropping rows to fit.
- **Definition work is O(N) per change.** The global index binding re-signs
  every subject's policy and launch records on each addition.
- **Verification has a hard ceiling.** History verification is linear in
  publication count and hits its bound within months at today's cadence.

## 3. Proposed design

### 3.1 Overview

```text
timestamp.json ─▶ N.snapshot.json ─▶ N.official-policy.json   (existing roles, keys, expiry)
                                        │  names, by length + SHA-256:
                                        ├─ policy/official/catalog.listings.json          (frozen legacy, format 11)
                                        ├─ policy/official/catalog.listings.compact.json  (frozen compact, format 15)
                                        └─ policy/official/catalog.manifest.json          (NEW, ≤1 MiB)
                                               │ names, by length + SHA-256:
                                               ├─ objects/sha256/<hex>.jsonl.gz   chunks: descriptive stream
                                               ├─ objects/sha256/<hex>.jsonl.gz   chunks: observation stream
                                               ├─ objects/sha256/<hex>.jsonl.gz   freshness (one chunk)
                                               ├─ objects/sha256/<hex>.jsonl.gz   chunks: definitions stream
                                               └─ objects/sha256/<hex>.json       manifest continuation pages
```

The manifest is the only new signed object. Everything below it is
authenticated the way TUF authenticates targets: the signed parent names each
child's exact length and SHA-256. Execution leaves stay content-addressed and
are referenced from the definitions stream, with no copy (3.5).

### 3.2 Trust placement

| Object                                    | Signed or bound by                                             | Change from today                          |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| `root.json`, top-level `targets.json`     | Offline root and targets keys                                  | None                                       |
| `snapshot.json`, `timestamp.json`         | Existing online keys; expiry 7 d and 1 d                       | None                                       |
| `official-policy.json`                    | Existing `official-policy` key; scope `policy/official/*.json` | One more target name in the existing scope |
| `catalog.manifest.json`                   | Named by `official-policy` (length and SHA-256)                | New target                                 |
| Chunks and continuation pages             | Named by the manifest (length and SHA-256)                     | New, outside TUF                           |
| `official-definitions` (index and leaves) | Existing key                                                   | Frozen for older readers (3.5)             |

**Why chunks are not TUF targets.** Listing 130–520 chunks in
`official-policy` would add about 25–100 KB to a role that every client,
including legacy readers, downloads on every refresh. The publisher re-signs
and retains that role on every publication. Binding through the manifest is
the same hash-and-length check `tough` applies to targets. The publisher
already uses the same outside-TUF pattern for `catalog-history/` segments.

**Replay and expiry.** The manifest's provenance is the existing
`PolicyProvenance`: five role versions and digests, with `expires_at` set to
the earliest role expiry. That provenance advances the same
`definition_publisher_authority.replay_floor_json`. The manifest's
`listing_revision` shares one floor with the legacy and compact revisions.
That floor already exists in Core (`listing_delivery.rs` ~800–809), and the
checkpoint rule `check_listings` enforces it on the publisher side. A manifest
at or below a revision any carrier has delivered is refused. An equal
revision with a different manifest digest is refused as equivocation.

### 3.3 Object layout

**Paths on Pages:**

- `catalog/objects/sha256/<64 hex>.jsonl.gz` for chunks.
- `catalog/objects/sha256/<64 hex>.json` for manifest continuation pages.

Each name is the SHA-256 of the exact stored bytes. A transport therefore
needs no decoding before checking a digest. The overlay regex in
`catalog-pages-overlay.mts` and the assembly inventory gain exactly these two
patterns.

**Manifest:** canonical JSON, at most 1 MiB, strict, with duplicate keys
rejected.

```json
{
  "manifest_schema": 1,
  "listing_revision": 49,
  "generation": 1,
  "issued_at": 1764000000,
  "required_features": ["catalog.chunked-manifest-v1"],
  "withdrawn_ids": ["..."],
  "streams": [
    {
      "stream": "listings.descriptive",
      "format_version": 15,
      "key": "sha256-id-prefix-v1",
      "records": 1649,
      "decoded_bytes": 5400000,
      "chunks": [
        {
          "prefix": "00",
          "depth": 6,
          "records": 27,
          "length": 14873,
          "sha256": "…",
          "decoded_sha256": "…"
        }
      ]
    },
    {
      "stream": "listings.observations",
      "format_version": 1,
      "key": "sha256-id-prefix-v1",
      "…": "…"
    },
    { "stream": "listings.freshness", "format_version": 1, "key": "single", "…": "…" }
  ],
  "continuation": null
}
```

**Manifest fields:**

- `prefix` is the chunk's key prefix in hexadecimal, left-aligned, covering
  `depth` bits.
- `length` and `sha256` bind the stored gzip bytes. `decoded_sha256` binds the
  decoded JSON lines, which is what the reader keeps.
- The chunks of a stream must partition the 32-bit key space exactly, with no
  gap and no overlap. The reader checks this. A record can therefore appear in
  only one place, and the publisher cannot hide a record by "forgetting" a
  range: every range is signed.
- `withdrawn_ids` stays inline, bounded at 10,000 entries as today. Large
  withdrawal sets move to a continuation page.
- `continuation` is either null or `{length, sha256}` for the next page. A
  page holds at most 6,000 chunk entries, and a manifest has at most 64 pages.
  A continuation page has the same shape with only `streams[].chunks`. The
  root page is about 14 KB at 1× (129 entries) and about 63 KB at 10× (521
  entries), so continuation starts at about 100× today's catalog.

**Chunk:** gzip (RFC 1952, one member, `mtime` 0) of UTF-8 JSON lines.

- **Line 1 is a header:**
  `{"chunk_schema":1,"stream":"listings.descriptive","format_version":15,"prefix":"00","depth":6}`.
- **Each further line is one record**, in canonical JSON with sorted keys,
  sorted by `id`. In the descriptive stream a line is the existing
  `CatalogListing` minus `upstream_observation`. In the observation stream it
  is `{id, observation}`, with the observation minus `observed_at`,
  `attempted_at` and `fresh_until`. In the freshness stream it is
  `{id, observed_at, attempted_at}`; `fresh_until` stays derived as
  `observed_at + 43,200 s`, matching every row measured, and the stream header
  carries the TTL.
- **The reader checks** that each record's
  `sha256(id)[0..depth bits] == prefix`, that IDs are unique and sorted, and
  that the record count matches the manifest.

**Bounds per object:**

| Object                | Limit                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Chunk                 | 256 KiB decoded, 192 KiB stored, 4,096 records                                                                             |
| Record                | 1 MiB (unchanged)                                                                                                          |
| Manifest page         | 1 MiB; at most 64 pages                                                                                                    |
| Concurrent fetches    | 8 (unchanged `TARGET_CONCURRENCY`)                                                                                         |
| Timeout per request   | 20 s (unchanged)                                                                                                           |
| Total refresh timeout | Becomes per-progress: 120 s without one completed object fails the refresh, but completed chunks stay staged for the retry |

### 3.4 Record-to-chunk mapping and rewrite fraction

The key is the first 32 bits of SHA-256 of the UTF-8 stable ID, a value the
publisher cannot choose for a given ID. Each stream starts at depth 6, which is
64 chunks.

- **Split.** The publisher splits a chunk into its two depth+1 children when
  its decoded size would exceed 192 KiB.
- **Merge.** It merges two siblings only when their combined decoded size is
  under 48 KiB.
- **Hysteresis.** The 48 KiB versus 192 KiB gap keeps a chunk from flapping
  between the two.

A split rewrites only the chunk being split. Adding records never moves a
record that already exists to another chunk unless that record's own chunk
splits. A change of record format rewrites the stream once (see 4.3).

The table below is a simulation over the real v60 listings. The 5× and 10×
catalogs are clones with new IDs. The changed records were drawn at random,
with 10 trials each. Each cell is the share of the descriptive and observation
chunk set rewritten, followed by the gzip bytes rewritten.

| Catalog    | Records | Chunks (descriptive + observation) | Chunk set (gzip) | 1 changed       | 10 changed     | 100 changed     |
| ---------- | ------- | ---------------------------------- | ---------------- | --------------- | -------------- | --------------- |
| 1× (today) | 1,193   | 64 + 64                            | 1,992,997        | 1.03% · 20.5 KB | 8.25% · 164 KB | 44.4% · 884 KB  |
| 5×         | 5,965   | 131 + 130                          | 9,376,195        | 0.44% · 41.5 KB | 4.03% · 378 KB | 29.1% · 2.73 MB |
| 10×        | 11,930  | 268 + 253                          | 18,686,035       | 0.19% · 36.2 KB | 2.04% · 380 KB | 17.0% · 3.18 MB |

A whole-document carrier rewrites 100% in every cell. At 10× compact would
also exceed its 32 MiB decoded and 10,000-record bounds (about 96 MB decoded
for 11,930 records).

**Real publications at 1×,** including the separate freshness chunk:

| From → to          | Descriptive chunks rewritten | Observation chunks rewritten | Freshness | Total rewritten       |
| ------------------ | ---------------------------- | ---------------------------- | --------- | --------------------- |
| v59 → v60          | 0 B                          | 59 of 64 · 840 KB            | 30 KB     | ≈0.87 MB (2.0 MB set) |
| v58 → v59          | 0 B                          | 63 of 64 · 898 KB            | 30 KB     | ≈0.93 MB              |
| v50 → v60 (≈1 day) | 230 KB                       | 63 of 64 · 901 KB            | 30 KB     | ≈1.16 MB              |

The observation stream is volatile by nature. Release asset IDs and digests
change across 190–260 rows a publication, so a day's changes touch nearly
every observation chunk. Splitting the streams keeps that cost at the size of
the observation data (≈0.8 MB) rather than the whole directory (≈8.4 MB). A
further cut would need fewer observation publications (decision D2b) or a
narrower observation window (11).

### 3.5 Streams and consumers

| Stream or consumer      | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Older readers                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listings.descriptive`  | Every canonical listing (1,649 today) at the newest format the publication declares, without observations.                                                                                                                                                                                                                                                                                                                                                                               | Legacy and compact are frozen (4.2).                                                                                                                        |
| `listings.observations` | Observation facts per listing ID. If an optional candidate fails Core validation, compact's rule applies: only that row is excluded and it keeps its prior signed observation.                                                                                                                                                                                                                                                                                                           | Frozen carriers keep the observations they had when frozen.                                                                                                 |
| `listings.freshness`    | One small chunk: `observed_at` and `attempted_at` for each observed ID.                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                           |
| `definitions` (PR 7)    | One record per subject: `{namespace, stable_id, revision, required_features, entry:{length,sha256}, contract:{length,sha256}, policy:{…}, launch:{…}}`. Entry, contract, policy and launch bodies are content-addressed objects; existing `sha256/<hex>.json` leaves are referenced at their existing target URL, with no copy. Policy decision schema 2 binds `entry_sha256` and the subject record's digest, not the global index. **An addition changes only its own subject chunk.** | `definitions/index.json`, per-ID policy and launch targets, and the existing leaves keep publishing until D5; the per-addition rebind continues only there. |
| Execution content       | No change of form. Leaves stay immutable and are referenced by digest. New leaves after cutover are stored only as objects.                                                                                                                                                                                                                                                                                                                                                              | Legacy route as above.                                                                                                                                      |
| Publisher tooling       | Prepare reads the prior manifest and the active checkpoint, not the whole tree. Verification is bounded by the epoch (6). The overlay accepts removals listed in a verified retention plan (7).                                                                                                                                                                                                                                                                                          | —                                                                                                                                                           |
| Release-side readers    | `catalog-released-reader.mts` additionally probes `chunked-manifest-v1` before manifest activation and before any later format increase. `restore-publication` verifies a pinned tree.                                                                                                                                                                                                                                                                                                   | —                                                                                                                                                           |
| Caches                  | One content-addressed SQLite store shared by every stream (3.8).                                                                                                                                                                                                                                                                                                                                                                                                                         | Existing tables are kept read-only for fallback.                                                                                                            |

### 3.6 Reader algorithm (new reader)

1. **Load the TUF chain.** Run the existing `load_repository`: root updates,
   timestamp, snapshot, then `official-policy`. Limits, expiry enforcement and
   the redirect-free transport are unchanged.
2. **Choose the carrier:** the manifest when it is named and every
   `required_features` entry is supported. Otherwise compact when it is named,
   and otherwise legacy. This is the existing rule with one more alternative
   at the front. An unsupported manifest is reported as
   `listing_manifest_requires_newer_reader` and is not an error. The reader
   falls back to a frozen carrier.
3. **Fetch the manifest.** Read it with a 1 MiB bound and verify its length and
   SHA-256 against `official-policy`. Then check freshness, the floor and the
   shared listing revision before fetching anything else. An equal revision
   with the identical digest is an exact retry: renew the provenance and stop.
4. **Walk the continuation pages**, each verified against its parent, with at
   most 64 pages. Check that the partition is exact for each stream and that
   the aggregate counts match.
5. **Plan the fetch.** The required set is every chunk digest named by the
   manifest. The missing set is required minus the digests already in the
   store. Report the planned bytes before fetching.
6. **Fetch missing chunks**, up to eight at a time. Each is bounded by its
   manifest length, checked for SHA-256, then gunzipped within its
   `decoded_bytes` bound and checked against `decoded_sha256`. Then the header
   and each record's prefix, sort order and count are checked. A verified
   chunk is inserted into the store as **staged**. Staging is idempotent and
   carries no authority.
7. **Assemble and validate.** Build the directory: descriptive records joined
   with the observation and freshness of the same ID, plus withdrawals. Run
   the existing projection dry run through Core's listing validators and
   `project()` overlay, including format rules, restriction-scope inheritance
   and withdrawal protection of managed ports.
8. **Adopt** in one `Immediate` transaction:
   1. Re-check the floor and revision.
   2. Upsert `listing_manifest_selection` with the exact manifest bytes,
      pages, provenance and revision. The old active row becomes previous.
   3. Advance `replay_floor_json`.
   4. Set `refcount_generation` for the referenced chunks.
   5. Commit.

   Every service then reads one coherent snapshot, as today.

9. **Fall back.** Any failure in steps 3–8 leaves active, previous and the
   floors unchanged, records a typed fallback code
   (`listing_manifest_incomplete`, `listing_manifest_verification` or
   `listing_manifest_unsupported`), and keeps already-staged chunks for the
   next attempt. At load time the order is: active manifest if fresh, then
   previous manifest if fresh and at the floor, then the stored compact or
   legacy row, then bundled. This is today's rule extended.
10. **Clean up** after commit. This runs outside the transaction and is
    crash-safe because it only removes rows (3.8).

The same algorithm serves definitions. The scheduled per-subject refresh (32
subjects a pass) fetches only the subjects whose record digest changed, so it
no longer needs the global `exact_scheduled_replay` comparison against the
index.

### 3.7 Publisher algorithm

**Prepare** (keyless):

1. Read the prior timestamp, its roles, the prior manifest and pages, and the
   active checkpoint. Do not read the whole tree.
2. Build the canonical streams from the authored catalog plus observations,
   then canonicalize each record.
3. Partition by the prior layout, then apply split and merge.
4. Gzip each chunk deterministically: level 9, `mtime` 0, no file name. Name it
   by the SHA-256 of the stored bytes.
5. New objects are those whose names are absent from the prior inventory. An
   unchanged chunk reuses its name.
6. Write the manifest. `listing_revision` is the prior maximum over all
   carriers plus one when any stream changed. A freshness-only change still
   advances the revision, but the cadence gate below can defer it.
7. Compute the retention plan (7) and the history successor (6).

**Sign.** The policy signer verifies the manifest it is asked to sign:

- It recomputes every new chunk's digest from the staged bytes.
- It checks the partition.
- It checks that the floor rises and that withdrawals are a superset of the
  current carriers' withdrawals.
- It checks every chunk named but not new against the checkpoint's active
  inventory.

Then it signs `official-policy`. Snapshot and timestamp are unchanged.

**Assemble and publish:**

1. Restore from the pinned prior.
2. Overlay the new objects.
3. Apply the retention plan's removals. Each is checked as unreferenced by
   every retained generation and every pin.
4. Check the 900,000,000-byte bound.
5. Push and read back.

Readback fetches the live manifest and **every** chunk it names, anonymously,
and verifies them. A missing chunk is a failed publication even when the
manifest is served. Recovery is in 6.4.

**Cadence gate** (D2b). A publication whose only change is freshness or
observation facts, with no descriptive, withdrawal or hold change, is deferred
when the last published listing revision is younger than 6 hours. The
scheduled 05:13 and 17:13 runs always publish. Safety changes never wait.

### 3.8 Client cache layout and garbage collection

Library migration N+1 (writer protocol bump):

```text
catalog_object(sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
               decoded BLOB NOT NULL CHECK(length(decoded) <= 262144),
               decoded_sha256 TEXT NOT NULL,
               stream TEXT NOT NULL,
               staged_at INTEGER NOT NULL,
               generation INTEGER)          -- NULL = staged, not referenced
listing_manifest_selection(singleton, active_json, active_pages_json,
                           previous_json, previous_pages_json,
                           provenance_json, revision)
```

- **Writer protocol.** Older executables refuse a migrated library rather
  than lose the selection. This is the existing writer-protocol rule.
- **Decoded bytes are stored**, not gzip, and re-checked against
  `decoded_sha256` on read, as compact does today.
- **Collection.** After adoption, delete rows whose digest is named by neither
  the active nor the previous manifest. Staged rows older than 7 days go too.
  Each digest is stored once even when it appears in several streams.
- **Bounds.** At most 64 MiB of decoded objects at 1×. The bound is
  configurable per reader release and is set to twice the largest supported
  catalog's decoded size. When the cache budget is exceeded the refresh is
  refused; the store is never partially evicted below the active and previous
  sets.
- **Legacy tables** (`listing_delivery`, `compact_listing_delivery`) stay and
  are no longer written once a manifest is adopted. They are removed in a
  later migration once their content is older than the floor.

### 3.9 Hosting bounds

| Bound                                                                                                                         | Value                                               | Position after this design                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits): published site | 1 GB                                                | Served tree ≈60 MB at 1× and ≤256 MiB at 10× with the retention budget                                                                        |
| Pages soft bandwidth                                                                                                          | 100 GB a month                                      | ≈1.2 MB per client-day at 1×, ≈11 MB at 10×                                                                                                   |
| Git per-file limit                                                                                                            | 100 MiB, hard                                       | Largest object 1 MiB                                                                                                                          |
| Repository bound                                                                                                              | `PUBLIC_REPOSITORY_MAX_BYTES` 768 MiB; 65,536 files | Unchanged; applied to the served tree after retention                                                                                         |
| Pages tree bound in the workflow                                                                                              | 900,000,000 bytes                                   | Unchanged                                                                                                                                     |
| Git history growth on `gh-pages`                                                                                              | Soft repository recommendation of about 1–5 GB      | ≈0.9 MB new gzip per publication. At the observed 7.7 a day that is ≈2.5 GB a year; with D2b, ≈1.8 a day, it is ≈0.6 GB a year at 1×. See D6. |

Playing an installed game never reads any of this. Launch uses the library's
retained contracts (unchanged, see
[DEFINITION-DELIVERY](../DEFINITION-DELIVERY.md#delivery-compatibility-and-retention)).
ScummVM's shared guides and definitions keep their existing records; nothing
here changes them.

## 4. Compatibility matrix

### 4.1 What each reader receives

| Reader                                                                                   | Advertises                                                                                                | Selects                                       | Receives after manifest activation                                                               | Safety withdrawals and holds                                                                                                                                                                | Upgrade path                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Preview ≤ 13 (Preview.12 reads formats 5–12; exact carriers per version UNKNOWN, see 11) | `json-v1` (expected)                                                                                      | Legacy target                                 | The frozen format-11 legacy target: 1,193 rows today, plus held rows added under the hold rules. | Added and retold holds and withdrawals reach it through a legacy successor, under [the existing rules](../SIGNED-CATALOG.md#legacy-holds-after-compact-activation). This path is unchanged. | Application updater to the current release       |
| Preview 14 (formats 5–15, `gzip-base64-json-v1`)                                         | `json-v1`, `gzip-base64-json-v1`                                                                          | Compact target (present), otherwise legacy    | The frozen compact target: 1,649 rows at format 15. It changes only for safety.                  | A compact successor carries the same withdrawals and typed restrictions. It publishes above the manifest's revision so the shared floor still rises.                                        | Application updater                              |
| New reader                                                                               | `json-v1`, `gzip-base64-json-v1`, `chunked-manifest-v1`; definition feature `catalog.chunked-manifest-v1` | Manifest, otherwise compact, otherwise legacy | The full live catalog, incrementally                                                             | Inline `withdrawn_ids` and typed restrictions in the descriptive stream                                                                                                                     | Ordinary releases; a format increase follows 4.3 |

`chunked-manifest-v1` goes into `CapabilityDocument::listing_delivery_carriers`
(`types.rs` ~2932) and into the CLI machine-contract test.
`catalog.chunked-manifest-v1` goes into the `definition_features!` table, so
definition-stream subjects can require it.

### 4.2 Frozen carriers

- **Freeze point.** The first manifest publication (step S5) freezes compact,
  and legacy is already frozen by compact activation. From then on both
  change only for holds and withdrawals. The signer enforces this with the
  existing legacy-successor rules, extended to compact: equal rows except for
  a hold or withdrawal, and holds equal to the manifest's restriction
  projection.
- **One current file each.** Superseded versions leave the served tree under
  retention (7). There are no complete historical projections. Old versions
  stay only in Git history and inside a pin.
- **End of support (D5, owner).** When the supported-release window no longer
  includes a reader, its carrier is replaced, at a higher revision, by a final
  safety form. That form has only the rows that carry a hold, plus every
  withdrawal. The publisher keeps re-signing that small file for as long as
  any library might still read it. The rule in
  [Descriptive directory delivery](../DEFINITION-DELIVERY.md#descriptive-directory-delivery)
  makes the effect exact: omitted remote-only records disappear for that
  reader, bundled records stay, and holds and withdrawals still apply. The
  reader keeps working with its bundled directory and is told to update.
- **Removing a carrier.** If a carrier target is ever removed from metadata,
  its reader falls back to bundled after the 1-day timestamp expiry and loses
  remote withdrawals. That is why D5 shrinks the carrier rather than removing
  it.

### 4.3 Format increases without duplicating projections

Each manifest stream declares its `format_version`. A new reader that
understands a lower format than a stream's keeps its last-good selection and
reports `listing_manifest_requires_newer_reader`. To keep a reader generation
updating during a transition, the publisher may publish **at most two variants
of a stream**, the new format and the previous one, for at most 90 days or
until D5 for that reader. Content addressing deduplicates every chunk whose
records serialize the same in both formats. Only chunks containing a record
that uses the new field are stored twice. After the window the old variant is
frozen like a carrier.

### 4.4 Proof that an addition reaches an unchanged capable client

T-ADD in section 8 builds the reader once, then publishes a fixture generation
that adds a new listing ID, a new definition subject and a compatible
correction. The unchanged binary must:

- fetch exactly the changed chunks and subject objects;
- adopt them atomically;
- show the new ID in `catalog listing-status` and `catalog listings`;
- select the new subject through the existing definition selection.

The production evidence is #246's ordered acceptance against the attested
released reader after S5.

## 5. Migration and activation sequence

**Authority key:**

- **L**: the AI lead under existing delegation, through an ordinary reviewed
  PR or the compact activation already delegated.
- **O**: owner only.

Every step keeps the last good publication served when it fails.

| Step | Action                                                                                                                          | Authority                                     | Rehearsal                                                                                                                                                                                   | Rollback                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0   | Land PR 1 (body retention, inert) and PR 2 (inventory report)                                                                   | L                                             | A dry-run retention plan against the live `gh-pages` commit. Prints the bodies removed and the bytes reclaimed (≈382 MB). Verifies that every current target and pin is kept.               | Revert the PRs; nothing was activated.                                                                                                                                                                     |
| S1   | **Activate body retention** (D1)                                                                                                | **O**                                         | S0's plan plus a fixture run: prune, then a client refresh at each retained generation, then a publisher run whose `verify_history` accepts pruned bodies through their signed descriptors. | Restore the pruned bodies from the pinned pre-activation commit with `restore-publication` (6.4), then revert the workflow flag. No client state depends on old bodies.                                    |
| S2   | Compact activation (#8619)                                                                                                      | L (delegated)                                 | `listing-compact-activation-rehearsal.mts` (existing)                                                                                                                                       | The existing route: revert, then `--return-to-legacy`. Still available because history is not bootstrapped.                                                                                                |
| S3   | Land reader PRs 3–5 (manifest reader, cache, capability) and release them in a Preview                                          | L                                             | T-READ, T-ADD and T-INT on Windows and Linux hosted partitions                                                                                                                              | Reader code is inert without a manifest target. Withdraw the Preview through `updates/withdrawn.json` (existing).                                                                                          |
| S4   | Land publisher PR 6 (manifest preparation behind `--manifest`, default off)                                                     | L                                             | `listing-manifest-activation-rehearsal.mts` covering activation, add, hold, withdrawal, split and merge, interrupted publication and return                                                 | Revert; the flag was never passed.                                                                                                                                                                         |
| S5   | **Activate manifest publication** (D2): pass `--manifest` and released-reader gating for `chunked-manifest-v1`; compact freezes | **O**                                         | S4's rehearsal against a copy of the live prior. The released-reader `select` preflight shows `chunked-manifest-v1`.                                                                        | Before S7: one publication with `--return-to-compact` drops the manifest target, publishes compact above the manifest revision with every withdrawal (mirrors `--return-to-legacy`), then revert the flag. |
| S6   | Land history PRs 8–10 (epochs, root transition, carrier retirement, restore), inert                                             | L                                             | T-HIST-*                                                                                                                                                                                    | Revert; still inert.                                                                                                                                                                                       |
| S7   | **History bootstrap with epoch rebasing** (D3)                                                                                  | **O**                                         | T-HIST against a copy of the live tree; a dry `bootstrap_history` run whose plan is printed and not signed                                                                                  | One-way by contract. Recovery: a supported compact or manifest retirement checkpoint (6.3); restoration (6.4). There is no un-bootstrap.                                                                   |
| S8   | Definitions stream (PR 7) and freezing of the legacy index once its readers are out of support                                  | L for code; **O** for the freeze (part of D5) | T-DEF                                                                                                                                                                                       | Before the freeze: keep publishing both.                                                                                                                                                                   |
| S9   | Served-object retention for manifests and chunks, plus the window (PR 11)                                                       | L (covered by D1's policy)                    | T-RET                                                                                                                                                                                       | Restore from the pin.                                                                                                                                                                                      |
| —    | Root rotation (D4), carrier end-of-support (D5), `gh-pages` Git history compaction (D6)                                         | **O**                                         | See 6.2 and 7                                                                                                                                                                               | See each decision.                                                                                                                                                                                         |

### 5.1 Owner decisions, stated once

**D1: activate superseded-body retention. Urgent: about 7 days of runway at
the time of measurement.**

- **Action:** merge the PR 1 workflow flag `--retain-bodies 16`. Each run
  removes from `catalog/targets/` every listing target body that is:
  - named only by metadata versions older than the newest 16 publications;
  - not current;
  - not in a pin.

  Metadata versions stay. Their signed length and SHA-256 remain the record of
  the removed bodies.

- **Consequence:**
  - About 382 MB is freed immediately. The served tree drops to about 23 MB
    plus the window.
  - Clients are not affected; they fetch only current targets.
  - The publisher stops re-reading historical bodies. Equivocation checks for
    pruned versions rely on their signed descriptors and the fact that earlier
    runs verified them.
  - The documented "complete retained graph" statement in SIGNED-CATALOG
    changes to "current plus window plus pins served; all history in
    `gh-pages` Git".
  - Pruned bodies remain recoverable from Git.

**D2: activate manifest publication (S5).**

- **Action:**
  - Merge the workflow change that passes `--manifest` and the
    `chunked-manifest-v1` released-reader gate.
  - **D2b** sets the observation cadence gate to 6 hours.
- **Consequence:**
  - One new `official-policy` target and the `catalog/objects/` tree.
  - Compact freezes, and Preview 14 then changes only for safety.
  - New-reader clients transfer about 1 MB a day instead of 2.75–8.4 MB.
  - New retained bytes per publication drop to about 0.9 MB.
  - No key, role, environment, secret or trigger changes.
  - Reversible until D3 by `--return-to-compact`.
  - With D2b, observation freshness shown to players can be up to 6 hours
    older between scheduled runs.

**D3: history bootstrap with epochs (S7).**

- **Action:** one `workflow_dispatch` with `bootstrap_history: true` and
  `epoch_length: 256` on the S6 code.
- **Consequence:**
  - One-way. `catalog-history/` is published.
  - Signing jobs verify at most 512 history objects a run, for good.
  - Root rotation, compact retirement and manifest retirement then follow the
    successors in 6.2 and 6.3.
  - A broken pointer stops publication until it is restored (6.4).

**D4: root rotation, only when needed.**

- **Action:** the offline root quorum signs `2.root.json` (threshold kept).
  The next publication carries a root-transition checkpoint (6.2).
- **Consequence:**
  - Clients follow the TUF root chain (at most 32 updates).
  - History continues without a new bootstrap.
  - Key custody and ceremony stay unchanged and owner-held.

**D5: carrier end-of-support.**

- **Action:** for each of legacy (Preview ≤ 13), compact (Preview 14) and the
  legacy definition index, name the release after which that reader is out of
  support. On that date, publish its final safety form (4.2).
- **Consequence:**
  - Those readers keep bundled data plus remote holds and withdrawals.
  - Remote-only descriptive rows disappear for them until they update.
  - Publication stops paying for their projections.

**D6: `gh-pages` Git history compaction.**

- **Trigger:** when `gh-pages` history exceeds 2 GB, or once a year.
- **Action:**
  1. Archive the old history as a `git bundle` release asset in this
     repository; one asset holds at most 2 GiB, so split it if needed.
  2. Force-push an orphan `gh-pages` commit holding the current served tree
     plus the pins.
- **Consequence:**
  - Bounded repository size.
  - Restoration from a pin older than the compaction uses the bundle.
  - This needs a branch-protection exception that only the owner can grant.

## 6. History checkpoints: closing the documented gaps

These close preconditions 1, 2 and 5 in
[Activation preconditions](../SIGNED-CATALOG.md#activation-preconditions).
The pointer, active checkpoint and segment formats stay at schema 1. Additions
are new optional fields under `checkpoint_schema: 2`, which the release tools
must accept before D3.

### 6.1 Bounded rebasing (precondition 1)

**What a checkpoint carries.**

- **Epoch.** An active checkpoint gains `epoch: {index, started_at_timestamp_version, ledger: {bytes, sha256}}`.
- **Chain.** Within an epoch `parent` and `tip` work as today.
- **Rebase.** When the epoch holds 256 publications, the next checkpoint is a
  rebase checkpoint, with:
  - `parent: null`;
  - a fresh first segment containing only the active inventory;
  - all cumulative floors carried forward unchanged: definitions, policies,
    listing (shared across every carrier), `retired_carriers` and manifest
    generation;
  - a new ledger.

**The ledger.** It is a content-addressed object that appends
`{index, first_ts, last_ts, final_active_sha256, root_sha256}` for the epoch
just closed. It is bounded at 8,192 entries, which is about 2.1 million
publications.

**What the signer checks before signing:**

- **Every run:**
  1. The pointer is named by verified TUF metadata.
  2. Its active checkpoint has the right digest.
  3. The suffix within the epoch is verified: tip and parents, at most 256
     each.
  4. The new segment matches the actual added files.
  5. Floors rise or stay equal; nothing rolls back or equivocates.
- **On a rebase run, additionally:**
  1. The closing epoch's final checkpoint is verified completely: at most 256
     segments and 256 parents.
  2. The new checkpoint's floors are a superset of it.
  3. The ledger equals the prior ledger plus exactly one entry.

**Cost.** A run verifies at most 2 × 256 objects plus 2 (ledger and pointer).
At about 20 KB a segment and at most 2 MiB a checkpoint (in practice ≈40 KB at
1×) that is about 10 MB, inside today's 4,096-object and 64 MiB limits. The
cost is the same at 1,000, 10,000 or 100,000 publications. The
`SEGMENT_CHAIN_LIMIT` refusal becomes unreachable for a correct publisher; it
stays as a defense.

**Archive evidence.** Objects from closed epochs follow the retention policy
(7). Replay evidence does not depend on them: floors are cumulative, and the
ledger binds each epoch's final identity. Client catch-up never needed history
objects. Clients verify current metadata against their own stored floors and
the root chain, which is never pruned.

### 6.2 Root rotation (precondition 2)

A **root-transition checkpoint** is a rebase checkpoint with
`root_sha256 = R_new` and `previous_root: {version, sha256: R_old}`. The
signer and assembler accept the mismatch only when the published repository
contains consecutive root versions from `R_old` to `R_new`. Each must be
signed by the threshold of both its predecessor and itself; `tough` already
verifies this when it loads the repository, up to 32 updates. Anything else
still fails with `ROOT_ROTATED`. The epoch ledger records both roots. Rotation
remains owner-only (D4). Online keys cannot create a new root, so this
successor adds no authority.

### 6.3 Carrier retirement and recovery (precondition 5)

The checkpoint gains `retired_carriers:
[{target, final_revision, final_decoded_sha256, withdrawn_ids_sha256, retired_at_timestamp_version}]`.
A successor that omits a carrier recorded in the previous checkpoint's floors
is accepted only when all three hold:

1. The same checkpoint retires it.
2. The listing floor stays shared and rising.
3. The withdrawals of every remaining carrier and of the manifest are a
   superset of the retired carrier's final withdrawals.

That gives both directions:

- **Compact to manifest-only** is allowed after D5.
- **Manifest back to compact**, the S5 rollback after D3, is a retirement of
  the manifest.

A retired carrier may return only above `final_revision`, with the same
superset rule. This replaces "refuses a successor without the compact carrier"
with a defined, reversible-forward path.

### 6.4 Restoration from a pinned last-good publication

`portcove-release-tools restore-publication --pin <gh-pages commit>` runs
keyless and read-only. It:

1. reads the pinned tree;
2. verifies the chain from timestamp through snapshot, the roles, the targets
   and the manifest down to every named chunk, plus the active checkpoint and
   its epoch suffix;
3. writes an overlay containing exactly the addressed objects that are missing
   from the current tree.

The next ordinary publication then **renews** that content with higher role
versions and a higher listing revision. It never re-serves old versions, which
clients' floors would refuse. Pins are:

- `last_good`: the newest publication whose readback passed;
- `activation`: the commit before each owner activation;
- `epoch_start`: the commit of each rebase checkpoint.

The pins are recorded in the checkpoint (`pins: [{kind, commit, timestamp_version}]`,
at most 8). Retention never removes an object reachable from a pin.

## 7. Retention policy

Served tree (`catalog/`, `catalog-history/`):

| Kept                                                                           | Rule                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| All `N.root.json`                                                              | Forever; clients need the chain                                                                                       |
| `timestamp.json` and the current role versions                                 | Always                                                                                                                |
| Metadata versions, manifests, pages and chunks of the newest **W** generations | W = max(16 publications, 48 hours), so in-flight clients (Pages `max-age=600`) and next-run recovery are covered      |
| Everything reachable from a pin (6.4)                                          | Until the pin is replaced                                                                                             |
| Current legacy and compact bodies, plus the version before each                | Until D5                                                                                                              |
| Definition leaves named by any retained generation                             | As above; installed clients keep their own exact copies                                                               |
| Current epoch's history objects, the previous epoch's, and the ledger          | Always                                                                                                                |
| Older metadata versions                                                        | Kept until checkpoint bootstrap (D3), because `verify_history` derives floors from them today. Then pruned outside W. |

**Budget.** At most 256 MiB served for `catalog/` and `catalog-history/`
together. If W would exceed it, W shrinks to a minimum of 4 generations and
24 hours. If even that does not fit, the publication fails before signing and
the last good publication stays served. A publication never removes something
a retained generation or pin still names.

**Projected served size:**

| Catalog | Size                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| 1×      | ≈2.0 MB chunk set + 16 × ≈0.9 MB changed + ≈11 MB frozen carriers + ≈5.3 MB browse + metadata = **≈35 MB**  |
| 10×     | ≈18.7 MB + 16 × ≈9 MB + carriers + browse ≈ **190 MB**, within budget; with D2b the window holds more hours |

**Git history.** Everything removed from the served tree stays in `gh-pages`
history until D6. The archive bundle keeps it after D6.

**Measured per run** (PR 2 report, retained in the publication receipt):

- active bytes: the current generation's named objects;
- retained bytes: the served tree;
- changed bytes: new objects in this run;
- client transfer: cold, and incremental from the previous generation;
- object counts;
- the epoch position.

## 8. Test plan

All of these are hosted CI tests unless marked. Simulations use deterministic
seeds and run on both the Windows and Linux partitions where Rust is involved.

| ID                         | Scope                                                                                                                                                                                                                                                                                                                                                                                           | Owner crate or script                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| T-CHUNK                    | Partition properties: exact cover, prefix check, deterministic bytes, split and merge hysteresis. Rewrite fractions for 1, 10 and 100 changes at 1×, 5× and 10× stay within ±20% of the table in 3.4. Generated catalogs are produced in the test, not committed.                                                                                                                               | `portcove-listing-carrier` (new `manifest` module)                                                    |
| T-READ                     | Reader against a fixture TUF repository. Cases: cold, incremental, no change (exact retry), every refusal (wrong length or digest, gzip trailing data, decoded overflow, prefix mismatch, gap or overlap, page loop, more than 64 pages, unsupported feature, expired roles, lower or equal-but-different revision), missing chunk (404), and a slow server that hits the per-progress timeout. | `portcove-core` `listing_delivery`                                                                    |
| T-INT                      | Interruption at each step, by fault injection and by process kill. Staged chunks are reused, active and previous are unchanged, and there is no mixed generation. A SQLite commit failure leaves the floors unchanged. The kill case reuses the existing SIGKILL harness on Linux and Windows `TerminateProcess`.                                                                               | `portcove-core`                                                                                       |
| T-ADD                      | **Frozen-binary proof.** Build the CLI once. Publish fixture generation 2, which adds a listing ID, a definition subject and a compatible correction. The same binary adopts it, the status lists the new ID, and only the changed objects were fetched (transport counter).                                                                                                                    | `portcove-cli` machine-contract tests                                                                 |
| T-COMPAT                   | Preview 13 and 14 fixture readers (released archives through the existing selection fixture) against a manifest-active repository. They select their frozen carrier, receive a hold and a withdrawal added after the freeze, and are unaffected by chunks.                                                                                                                                      | `scripts/listing-manifest-activation-rehearsal.mts`                                                   |
| T-PUB                      | Publisher across 3,000 simulated publications: random descriptive changes, real-shaped observation churn, splits, holds and withdrawals. Asserts monotonic floors, retention window and budget, served-size and new-bytes series, and that every generation in W is fully servable.                                                                                                             | `portcove-release-tools` (simulation test, `#[ignore]`d locally, selected in CI on publisher changes) |
| T-HIST                     | 5,000 simulated publications with `epoch_length` 256. Per-run verification object count is at most 514 at every step. Rebase floors are a superset. Ledger integrity. A tampered closed epoch is refused at rebase. A tampered suffix is refused every run.                                                                                                                                     | `portcove-release-tools::history_checkpoint`                                                          |
| T-ROOT                     | Root rotation mid-epoch and at a rebase. The transition checkpoint is accepted with a valid consecutive root chain. It is refused when skipped, singly signed or reversed. Clients follow through the `tough` root update.                                                                                                                                                                      | release-tools and core                                                                                |
| T-EXPIRY                   | Clock moved past the timestamp, role and root expiry. The reader falls back to previous, then frozen, then bundled, and never lowers the floor. The publisher's `recheck` refuses inputs that expire mid-run. Renewal of identical content advances only the metadata.                                                                                                                          | core and release-tools                                                                                |
| T-RETIRE                   | Compact retirement, return above `final_revision`, refusal at or below it, the withdrawal-superset rule, and manifest retirement (S5 rollback after D3).                                                                                                                                                                                                                                        | release-tools                                                                                         |
| T-RESTORE                  | Delete random addressed objects from a fixture Pages tree. `restore-publication` restores exactly those from the pin. The next publication renews. Readback catches a missing chunk.                                                                                                                                                                                                            | release-tools and `scripts/catalog-publish.test.mts`                                                  |
| T-RET                      | The retention plan never removes an object named by W or a pin. Budget shrink and failure paths. The overlay accepts only planned removals.                                                                                                                                                                                                                                                     | `scripts/catalog-pages-overlay.test.mts`                                                              |
| T-DEF                      | Definitions stream: an addition changes one subject chunk. Policy schema 2 binds the subject record. Older readers still use the index route. The scheduled refresh fetches only changed subjects.                                                                                                                                                                                              | core and release-tools                                                                                |
| T-RELREADER                | Released-reader selection requires `chunked-manifest-v1` for S5 and for later format increases. Rate limits and withdrawn versions keep the prior state, mirroring the existing compact cases.                                                                                                                                                                                                  | `scripts/catalog-released-reader.test.mts`                                                            |
| T-LIVE (manual, read-only) | After each activation: anonymous readback of the live manifest and all chunks, and the measured four numbers recorded on the issue.                                                                                                                                                                                                                                                             | —                                                                                                     |

## 9. Implementation breakdown

Listed in dependency order. Each PR is an ordinary reviewed PR, inert by
default, unless marked as an activation.

| PR  | Mechanism                                                      | Files owned                                                                                                                                                                                                                                                                                                                                                                             | Acceptance evidence                                                                                                                                   | Depends on    |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | Superseded-body retention, inert flag                          | `crates/portcove-release-tools/src/definition_repository/repository.rs` (`verify_history` accepts an absent body whose signed descriptor is recorded and whose version is outside the window), `scripts/catalog-pages-overlay.mts` (planned removals only), `scripts/catalog-publish.mts` (plan), `.github/workflows/catalog-publish.yml` (flag, default off), `docs/SIGNED-CATALOG.md` | T-RET subset; a dry-run plan against the live `gh-pages` commit showing ≈382 MB reclaimed and every current target and pin kept                       | —             |
| 2   | Per-run measurement report                                     | `scripts/catalog-publish.mts`, the publication receipt                                                                                                                                                                                                                                                                                                                                  | Report fields present in the rehearsal; the four numbers in 7                                                                                         | —             |
| 3   | Manifest and chunk format (pure)                               | `crates/portcove-listing-carrier/src/manifest.rs` (new): parse, bounds, partition, chunk decode, canonical encode, split and merge                                                                                                                                                                                                                                                      | T-CHUNK; fuzz targets for manifest and chunk decode                                                                                                   | —             |
| 4   | Reader, cache and capability                                   | `crates/portcove-core/src/listing_delivery.rs`, `database.rs` (migration and writer protocol), `types.rs` (`chunked-manifest-v1`), `definition_capabilities.rs` (feature), `definition_repository.rs` (multi-object fetch with the per-progress timeout), CLI machine-contract test, Tauri capability passthrough                                                                       | T-READ, T-INT, T-EXPIRY, T-ADD on Windows and Linux                                                                                                   | 3             |
| 5   | Transport compression for metadata and legacy targets          | `Cargo.toml` (`reqwest` `gzip` feature), `definition_repository.rs` (bounds stay on decoded bytes)                                                                                                                                                                                                                                                                                      | Transfer for the legacy target drops from ≈8.39 MB to ≈1.84 MB in a fixture with gzip enabled; bounds still apply to decoded bytes. Optional, see 11. | —             |
| 6   | Publisher manifest preparation, `--manifest` off               | `scripts/listing-observation-delivery.mts` (stream build), release-tools `bundle.rs`, `signing.rs` (policy signer checks), `repository.rs` (object inventory), `scripts/catalog-pages-overlay.mts` (`objects/` pattern), new `scripts/listing-manifest-activation-rehearsal.mts`, `docs/SIGNED-CATALOG.md`, `docs/DEFINITION-DELIVERY.md`                                               | T-COMPAT and T-PUB; the rehearsal against a copy of the live prior                                                                                    | 3, 1          |
| 6a  | **Activation S5** (owner D2), with the cadence gate D2b        | `.github/workflows/catalog-publish.yml`, `scripts/catalog-released-reader.mts`                                                                                                                                                                                                                                                                                                          | T-RELREADER; first-run readback of the live manifest and every chunk                                                                                  | 4 released, 6 |
| 7   | Definitions stream and policy schema 2                         | `definition_index.rs`, `definition_publisher_policy.rs`, `definition_refresh.rs`, `definition_selection.rs`, release-tools `bundle.rs`, `scripts/catalog-prepare-publication.mts` (rebind becomes legacy-route only)                                                                                                                                                                    | T-DEF                                                                                                                                                 | 4, 6          |
| 8   | Epoch rebasing (checkpoint schema 2)                           | `crates/portcove-release-tools/src/definition_repository/history_checkpoint.rs`, `scripts/catalog-publish.mts` (`limit-signer-history`)                                                                                                                                                                                                                                                 | T-HIST                                                                                                                                                | —             |
| 9   | Root transition and carrier retirement                         | `history_checkpoint.rs`, release-tools `policy.rs`                                                                                                                                                                                                                                                                                                                                      | T-ROOT, T-RETIRE                                                                                                                                      | 8             |
| 10  | `restore-publication` and pins                                 | release-tools CLI, `scripts/catalog-publish.mts`, `.github/workflows/catalog-publish.yml` (readback of all chunks)                                                                                                                                                                                                                                                                      | T-RESTORE                                                                                                                                             | 8, 6          |
| 11  | Generation retention (W, budget)                               | `scripts/catalog-publish.mts`, `scripts/catalog-pages-overlay.mts`, release-tools inventory                                                                                                                                                                                                                                                                                             | T-RET full; the PR 2 report shows served bytes within budget across the T-PUB simulation                                                              | 1, 6, 8       |
| 12  | **Activation S7** (owner D3)                                   | Workflow dispatch only                                                                                                                                                                                                                                                                                                                                                                  | The dry plan, then readback of the pointer, the active checkpoint and the ledger                                                                      | 8–11          |
| 13  | Frozen-carrier rules extended to compact; D5 final safety form | release-tools signer, `listing-observation-delivery.mts`                                                                                                                                                                                                                                                                                                                                | T-COMPAT and T-RETIRE                                                                                                                                 | 6, 9          |

PR 1 has no dependencies and should be picked up first, because the runway is
measured in days. PRs 3, 4 and 8 can run in parallel.

## 10. Alternatives considered

| Alternative                                                           | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact gzip only (activate #8619 and stop)                           | Keeps 100% rewrite and 100% transfer per change, and about 2.75 MB retained per publication, so the 768 MiB bound is reached in about 21 days without retention. The 32 MiB decoded and 10,000-record bounds cap it near 3–6× today. It is still the right short-term step (S2).                                                                                                                                                 |
| One file per record                                                   | 1,649 files today and about 16,500 at 10×; every one is a request on a cold fetch. Listing them as TUF targets would bloat `official-policy`; listing them in a manifest makes the manifest about 165 bytes × N (1.9 MB at 10×) and still changes every publication. The `PUBLIC_REPOSITORY_MAX_FILES` 65,536 bound would be reached after a few windows. Chunks of about 64–192 KiB balance request count against rewrite size. |
| HTTP range requests into one large file                               | `tough` and the transport issue plain `GET`s. Pages and Fastly range behavior on gzip-encoded responses is not a contract. Each publication would still rewrite and retain a whole new file, and the digest covers the whole file, so a range cannot be verified alone without a manifest anyway.                                                                                                                                |
| Delta encoding (binary or JSON-patch between generations)             | Needs a delta per source generation or a chain the client must replay. Clients at arbitrary floors would need many deltas or a fallback full download. Verification needs the base bytes. Retention multiplies. Content-addressed chunks give most of the benefit with no chain.                                                                                                                                                 |
| Hash-prefix delegated TUF roles (TUF hash bins)                       | Refused by `policy.rs` ("hash-prefix scope unsupported"). Requires new delegated roles, a root and targets change and offline-key ceremonies (owner). Every bin's metadata changes when any of its targets changes, so the overhead is like chunks plus a signature per bin and a larger snapshot. It would not help older readers.                                                                                              |
| Chunks as ordinary `policy/official/*` TUF targets                    | Every client downloads every chunk entry in `official-policy` on every refresh, the publisher re-signs and retains it per publication, and the 8 MiB role bound becomes a catalog-size bound. No security gain over a signed manifest naming digests.                                                                                                                                                                            |
| Fixed shard count (for example 256) instead of extendible depth       | Simpler, but at 1× most chunks are 3–5 KB (many requests), and at 10× they are about 70 KB. Fixed resharding later rewrites everything once. Extendible depth keeps chunks at a near-constant size and rewrites only the chunk that splits.                                                                                                                                                                                      |
| Storing chunks uncompressed and relying on Pages gzip                 | Pages served gzip in this measurement, but that is CDN behavior, not a documented contract. Storage, retained bytes and Git growth would be about 4.6× larger. Git delta compression does not reliably pair content-addressed names. PR 5 still enables `gzip` for metadata and frozen carriers, where it helps at no contract risk.                                                                                             |
| A separate host or CDN, an object store, or release assets for chunks | Violates "$0, no new infrastructure or provider". Release assets add a second availability authority and redirect handling, which the transport refuses by design.                                                                                                                                                                                                                                                               |
| Keeping all historical projections for compatibility                  | Explicitly excluded by the owner. Freezing to one current safety-maintained file per old carrier meets the safety requirement.                                                                                                                                                                                                                                                                                                   |

## 11. Open risks and UNKNOWNs

- **Runway (risk, urgent).** About 7 days at the time of measurement. If D1
  is not activated in time, publication stops, the timestamp expires within a
  day, and clients use bundled data without remote withdrawals.
- **Observation churn dominates (risk).** Even with chunking, about 0.8 MB of
  observation chunks changes each publication at 1× and about 8 MB at 10×.
  Levers: D2b cadence; a smaller `release_limit` window, a catalog-data
  decision outside this design; a finer observation depth. The real churn
  shape at 5× and 10× is UNKNOWN. It is settled by T-PUB with real-shaped
  churn plus the PR 2 report after S5.
- **Git growth (risk).** The packed size of `gh-pages` is UNKNOWN; the API
  reports 199,217 KiB for the whole repository. Settled by a one-time
  `git count-objects -vH` on a `gh-pages`-only clone. D6 bounds it.
- **Pages gzip (UNKNOWN as a contract).** Observed on 2026-11-23 with
  `content-encoding: gzip` and `max-age=600`. The design does not rely on it.
- **Refresh behavior with an unchanged digest (UNKNOWN).** Whether released
  readers skip the target download when the digest is unchanged. Settled by a
  transport-counter test on the Preview 14 archive.
- **Exact carrier support per Preview ≤ 13 (partly UNKNOWN).** Preview.12
  reads formats 5–12 (#8503). The carrier list of each earlier preview is
  settled by running `capabilities` on each retained archive; D5 needs it.
- **Client population and bandwidth (UNKNOWN).** No telemetry. The headroom
  figures in 2.2 assume one refresh a day.
- **Online key compromise.** As today, the policy key can sign any manifest.
  Floors stop replay but not a fresh malicious publication. Recovery is
  unchanged: offline rotation (D4) and holds.
- **Clock skew.** Unchanged: expiry uses the client clock. A clock far ahead
  drops to bundled data.
- **Cancelled during adoption.** Covered by the single transaction. Cancelling
  during the fetch leaves staged rows, which are cleaned after 7 days.

## Appendix: measurement method

All read-only, on 2026-11-23:

- **Tree.** `gh api repos/boburning/portcove/git/trees/<gh-pages sha>?recursive=1`
  (not truncated, 3,147 entries), with blob sizes summed by path pattern.
- **Metadata.** Anonymous `GET` of `timestamp.json`, `60.snapshot.json`, and
  `1..60.official-policy.json` from `https://boburning.github.io/portcove/catalog/metadata/`.
- **Listing bodies.** Anonymous `GET` of the listing targets of policy v50,
  v55, v58, v59 and v60.
- **Rows.** Rows were compared as canonical JSON per ID, field by field.
- **Streams and chunking.** Descriptive is the row minus
  `upstream_observation`. Observation is that object minus the three
  timestamps. Freshness is the timestamps. Chunking is the extendible
  bit-prefix scheme in 3.4: depth 6 to start, split above 48 KiB of gzip in
  the simulation, gzip level 6 with `mtime` 0.
- **Random changes.** k distinct records drawn with a fixed seed over 10
  trials, counting the gzip bytes of every chunk that holds a changed record.
- **Synthetic catalogs.** 5× and 10× are v60 clones with suffixed IDs.
- **Wire size.** `curl -H 'Accept-Encoding: gzip'` against the v60 legacy
  target.

These are one-off measurements, not product code; PR 2 makes them a standing
report.
