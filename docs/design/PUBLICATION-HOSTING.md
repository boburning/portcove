# Publication hosting without history growth (design, November 23, 2026)

Proposed design, revision 4. Nothing here is implemented or activated, and no
repository setting has changed. The [signed catalog contract](../SIGNED-CATALOG.md),
[RELEASING](../RELEASING.md) and the adopted
[catalog distribution scaling design](CATALOG-DISTRIBUTION-SCALING.md) stay the
current contracts until each step below lands through its own pull request and,
where marked, an owner decision. Work belongs to
[#1422](https://github.com/boburning/portcove/issues/1422) and
[#246](https://github.com/boburning/portcove/issues/246). Source: `main` at
`f8799fb31`. Measurements: a `gh-pages`-only bare clone at `758583339`
(2026-11-23T17:24:26Z), the repository's public deployment and artifact
listings, and anonymous Pages `HEAD` requests on the same day.

**Revision 4** applies the lead's check of revision 3:

- A `repair` commit kind recovers automatically from a poisoned tip. It
  skips only the unverified suffix and never a verified generation (4.3).
- The served marker counts as a checkpoint only once the site is
  workflow-deployed and the environment admits `main` alone. A checkpoint
  must be an ancestor of the tip (4.3).

**Revision 3** applied the lead's check of revision 2:

- A restore or rollback is one forward generation. It carries the copied
  files plus a renewal signed above the chain's metadata versions, and it
  always takes `updates/` from the tip (5.6).
- Restore sources are limited to pin-store entries merged to `main`. Feed
  versions move only forward, except by withdrawal (4.3).
- The pointer carries each generation's header, so the walk is a cheap Git
  read with no stalling bound. A deploy receipt is the persisted checkpoint,
  and a genesis rule covers M1 (4.3).
- `source_commit` is bound to the uploading run.
- The conditional flip-back is listed as owner action O-H4r (6).

**Revision 2** applied the independent review of revision 1:

- The pointer is trusted only after a chain-linkage and monotonicity check, and
  rollback never re-points at an old generation (4.3, 5.6).
- Shadow `gh-pages` pushes stop at the source change, so the compaction clock
  stops there. The deadline is restated as the last `gh-pages` write, and the
  frozen history size is recomputed (5.2, 9).
- The owner actions are reordered, and a throwaway rehearsal repository is
  added (6).
- Durability: a rolling durable pin, artifact refresh, an HTTPS rebuild path,
  and catalog version floors in the pointer (4.3, 4.7, 5.6).
- Provenance is defined precisely (4.3), and option B's rejection is restated
  (3.B).

## The question

The published site is the `gh-pages` branch. Every publication commits new
signed bodies and regenerated browse pages, so the branch history grows without
bound even after the body window stops serving old bodies. The adopted plan
answers this with owner decision O3: compact `gh-pages` by force-push under a
branch-protection exception about every 75–91 days after the compact-only
cutover, or about every 265 days once listings are chunked.

The owner asked for a long-term answer and set the acceptance rule: repeated
updates and publication history must not create recurring manual repair, and
any design that does must carry an explicit operating plan with its owner
maintenance frequency.

## Recommendation

**Publish the site as a GitHub Pages artifact deployment (Pages source "GitHub
Actions"), composed from the previous deployed generation, with a small,
verified pointer branch as the serialization point. Then freeze `gh-pages`.**

1. The served site stops being a Git branch. Every publication builds the
   complete site as a directory and deploys it with `actions/upload-pages-artifact`
   and `actions/deploy-pages`. No Git history accumulates for served bytes.
2. Each deployed site is a **generation**: a canonical manifest of every file
   (path, length, SHA-256), plus the ID of the generation it was built from.
   The SHA-256 of the manifest is the generation ID. The generation's files are
   kept as a 90-day Actions artifact. That artifact serves as the next
   publisher's prior state, the audit and replay evidence, and the rollback
   source.
3. A `pages-state` branch holds one small file, `current.json`, naming the
   current generation, its artifact and the catalog's metadata versions.
   Publishers advance it by an ordinary fast-forward push. That push is the
   compare-and-swap that orders the catalog and application-feed publishers.
   - Nothing trusts the branch tip alone. Before using a tip, a publisher
     verifies that each commit's generation was built from its parent commit's
     generation, and that every component only moved forward (4.3).
   - It grows by about 0.85 KiB a publication (4.4), so it never needs
     compaction.
4. Pins become **generation pins**, copied from the artifact into prerelease
   assets that do not expire. A rolling weekly pin keeps the newest state
   durable even if publishing stops for months.
5. Client URLs, formats, signing roles, keys, delegations, expiry, floors and
   withdrawals are unchanged. No new reader generation is needed.

**Resulting owner maintenance frequency: none recurring.** The owner acts only
once, through the ordered one-time list in section 6. Monitoring then replaces
maintenance (section 8).

**Deadline.** Until the source change lands, the adopted plan stands:
compact-only cutover, body window, and one owner compaction if it falls due.
The compaction clock stops at the **last write to `gh-pages`**, which in this
plan is the source change (M3). If the cutover is on 2026-11-30, the first
compaction falls due between **2027-02-10 and 2027-02-26** (section 9). Aim for
M3 by **2027-01-27**. That leaves two weeks for slips and for at most one
flip-back sync commit. Every week M3 lands earlier also makes the frozen
history about 160–200 MB smaller.

## 1. Constraints and how the recommendation meets each

| Constraint                                                           | Recommendation                                                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| $0; GitHub only; no new infrastructure or paid service               | Pages, Actions artifacts and releases in this public repository. Standard runners are free for public repositories. The repository already keeps about 2.5 GB of 90-day artifacts (2.2). |
| Trust model unchanged                                                | Nothing signed changes. The composer moves bytes the signers already produced. TUF verification, floors, expiry and withdrawals work as today.                                           |
| Signing roles, keys, bootstrap and root rotation untouched           | Untouched. The signing jobs and their environments do not change.                                                                                                                        |
| Fixed client base URLs under `https://boburning.github.io/portcove/` | Same origin and paths. Only the mechanism that puts bytes there changes.                                                                                                                 |
| Unattended publisher                                                 | Producers compose, advance the pointer and deploy without human steps. An hourly reconciler redeploys the verified pointer tip when a deployment was lost.                               |
| Restore from a pinned last-good publication                          | Generation pins in prerelease assets, a rolling weekly pin, and existing `gh-pages` commit pins from the frozen branch. Restore copies files forward into a new generation (5.6).        |
| Audit and replay evidence for the supported window                   | Every generation's exact files for 90 days (the public-repository maximum), the pointer chain for all time, and pins indefinitely.                                                       |
| Playing an installed game never depends on this                      | Unchanged: launch reads only retained local contracts.                                                                                                                                   |
| No recurring manual repair                                           | No branch accumulates served bytes. The only Git growth is the pointer chain, about 3 MiB a year.                                                                                        |

## 2. Current state and measurements

### 2.1 Who writes the site today

The site is the `gh-pages` branch, published by GitHub's built-in branch build.
Three active workflows push to it, each with `contents: write` and a 4-attempt
fetch, overlay, commit and push loop:

| Writer                                                                             | Paths                                     | Trigger                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| [`catalog-publish.yml`](../../.github/workflows/catalog-publish.yml) `publish` job | `catalog/` (TUF repository and `browse/`) | CI-green `main`, 05:13 and 17:13 UTC, manual |
| [`app-release-build.yml`](../../.github/workflows/app-release-build.yml) feed step | `updates/<channel>/latest.json`           | Nightly preview and tagged releases          |
| [`withdraw-release.yml`](../../.github/workflows/withdraw-release.yml)             | `updates/withdrawn.json`, feeds           | Owner-only dispatch                          |

These steps read the branch itself, not the served site:

- `catalog-publish.yml` `prepare` reads the prior catalog from a `gh-pages`
  worktree. The late readback compares a catalog commit with its parent.
- `publish` restores `PRIOR_COMMIT` for segmented history.
- [`catalog-released-reader.mts`](../../scripts/catalog-released-reader.mts)
  selects the Preview reader from `updates/preview/latest.json` and
  `updates/withdrawn.json` at `refs/remotes/origin/gh-pages`.
- The pin store in #8631 names `gh-pages` commits (`pages_commit`).

The held [`application-release.yml`](../../.github/workflows/application-release.yml)
controller already targets a workflow-built site:

- Its `feed` job runs in the `github-pages` environment with `pages: write`
  and `id-token: write`.
- Its site tooling expects `build_type: workflow`, complete-site generations
  and a 6,000-file / 256 MiB site bound.

It is not active. This design is compatible with it (7.3).

### 2.2 Measured numbers (2026-11-23)

| Quantity                                                   | Value                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `gh-pages` commits / first commit                          | 74 / 2026-11-14T00:23Z                                                   |
| `gh-pages` packed history (`git count-objects -vH`)        | 111,748 objects, **63.87 MiB**                                           |
| Served tree                                                | 1,614 files, 404,922,011 bytes                                           |
| Served tree as tar / tar.gz (gzip 6)                       | 406,988,800 / 87,192,710 bytes                                           |
| Tree with the body window (two newest listing bodies kept) | **1,569 files, 31,067,125 bytes**                                        |
| Windowed tree as deterministic tar / tar.gz                | 33,198,080 / **6,114,310 bytes**                                         |
| `catalog/browse/` raw / tar.gz                             | 13,787,563 / 2,403,145 bytes                                             |
| `github-pages` deployments so far                          | 87, all from ref `gh-pages`                                              |
| Built-in `pages-build-deployment` duration, last five runs | 43–53 s for the 405 MB tree; one outlier of 5 min 31 s                   |
| Pages response headers                                     | `cache-control: max-age=600`, Fastly (`via: 1.1 varnish`), per-file ETag |
| `Last-Modified` across files of one deployment             | Identical to the second (17:25:07–08) after deployment start 17:24:51    |
| `catalog-work` artifacts retained                          | 64 artifacts, 2,491,830,426 bytes, expiring 90 days after creation       |

- **The window.** The windowed tree matches #8631's measured 31,088,351 bytes,
  which include the ledger. After the compact-only cutover, the window holds
  two compact bodies (about 6.9 MB, already gzip) plus the newest legacy body.
  A generation is then about 25–38 MB raw and **3.8–11 MB compressed**,
  depending on whether the legacy body is still retained.
- **Branch builds already deploy artifacts.** Each push to `gh-pages` runs
  GitHub's built-in `pages-build-deployment` workflow, which packages the whole
  tree and deploys it to the `github-pages` environment. So option A's served
  behavior (a whole-site artifact behind Fastly with a 600-second cache) is
  what clients see today. What changes is who builds the artifact, and that no
  branch sits in front of it.

### 2.3 GitHub's documented limits

Read anonymously on 2026-11-23.

| Fact                                                                                                                                                                   | Source                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Published GitHub Pages sites may be no larger than 1 GB."                                                                                                             | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)                                                                                                                                                                                                                        |
| "GitHub Pages source repositories have a recommended limit of 1 GB."                                                                                                   | same                                                                                                                                                                                                                                                                                                                                 |
| "GitHub Pages deployments will timeout if they take longer than 10 minutes."                                                                                           | same                                                                                                                                                                                                                                                                                                                                 |
| "a _soft_ bandwidth limit of 100 GB per month"                                                                                                                         | same                                                                                                                                                                                                                                                                                                                                 |
| "a _soft_ limit of 10 builds per hour. This limit does not apply if you build and publish your site with a custom GitHub Actions workflow."                            | same                                                                                                                                                                                                                                                                                                                                 |
| Over-limit responses are HTTP 429.                                                                                                                                     | same                                                                                                                                                                                                                                                                                                                                 |
| "The job must have a minimum of `pages: write` and `id-token: write` permissions."                                                                                     | [Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)                                                                                                                                                                              |
| "The default environment is `github-pages`." It recommends a deployment protection rule "so that only the default branch can deploy".                                  | same, and [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)                                                                                                                                                           |
| The artifact is a gzip of a single tar, "must be under 10GB", "should not contain any symbolic or hard links".                                                         | [Using custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages); [upload-pages-artifact](https://github.com/actions/upload-pages-artifact) ("we recommend under 1 GB")                                                                                         |
| `upload-pages-artifact` `retention-days` default 1; `deploy-pages` `timeout` default 600,000 ms.                                                                       | [upload-pages-artifact](https://github.com/actions/upload-pages-artifact), [deploy-pages](https://github.com/actions/deploy-pages)                                                                                                                                                                                                   |
| GitHub's starter Pages workflow uses `concurrency: group: "pages"`, `cancel-in-progress: false`, "skipping runs queued between the run in-progress and latest queued". | [starter-workflows `pages/static.yml`](https://github.com/actions/starter-workflows/blob/main/pages/static.yml)                                                                                                                                                                                                                      |
| Artifacts and logs are retained 90 days by default; public repositories may set 1–90 days. `retention-days` cannot exceed that.                                        | [Configuring the retention period](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization); [Storing workflow data as artifacts](https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts) |
| "GitHub Actions usage is free for standard GitHub-hosted runners in public repositories". Downloading artifacts needs read access.                                     | [Usage limits, billing and administration](https://docs.github.com/en/actions/learn-github-actions/usage-limits-billing-and-administration); [Downloading workflow artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)                                                           |
| Release files "must be under 2 GiB"; "Up to 1000 release assets" per release; "no limit on the total size of a release, nor bandwidth usage".                          | [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)                                                                                                                                                                                                                                |
| Immutable releases: assets "cannot be modified or deleted"; after the release is deleted, the tag can be deleted but "you cannot reuse the same tag name".             | [Immutable releases](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)                                                                                                                                                                                     |
| Repositories "ideally less than 1 GB, and less than 5 GB is strongly recommended"; GitHub blocks files over 100 MiB.                                                   | [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)                                                                                                                                                                                           |
| Git LFS on GitHub Free: 10 GiB storage and 10 GiB bandwidth a month; no public-repository exemption stated.                                                            | [About billing for Git LFS](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage)                                                                                                                                              |
| Ruleset bypass actors are roles, teams or GitHub Apps.                                                                                                                 | [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)                                                                                                                                                                                        |

**Not stated, so UNKNOWN:**

- **Atomic replacement.** Whether a deployment replaces the served site
  atomically. Observed: one `Last-Modified` across a deployment's files.
  T-ATOMIC settles it.
- **Failed deployments.** Whether a failed or timed-out deployment leaves the
  previous one serving. T-INTERRUPT settles it.
- **Deployment rate.** Any rate limit for Actions-source deployments. Today's
  rate is about 10 a day; the rehearsal probes about 20 an hour.
- **Artifact billing.** Whether public-repository artifact storage counts
  toward Free's 500 MB storage quota. The repository's 2.49 GB of retained
  `catalog-work` artifacts, with no storage failure, is evidence that it does
  not. The owner's billing page settles it before M1.
- Anonymous release-asset download rate limits, and whether Pages serves Git
  LFS content.
- Whether this repository has immutable releases enabled. The pin design works
  either way (5.6).
- Whether GitHub reclaims unreachable objects after a branch is rewritten or
  deleted, and when.

### 2.4 Growth today and under the adopted plan

From the adopted design (2.2, 6.6) and #8631. "Days" count from 64 MiB to the
2 GiB trigger: (2,147.5 − 67) MB divided by the daily growth.

| Delivery state                     | `gh-pages` packed growth a day | Days to the 2 GiB compaction trigger |
| ---------------------------------- | ------------------------------ | ------------------------------------ |
| Today (legacy JSON bodies)         | 6.45–6.8 MB measured           | ≈310                                 |
| Compact-only cutover, 1×           | 23–28 MB                       | 74–90                                |
| Compact-only plus the stop-gap, 1× | 18–22 MB                       | 95–116                               |
| Chunked manifest, 1×               | ≈7.9 MB                        | ≈263                                 |

Even the best case, chunking plus stable browse output, only slows growth. The
2 GiB trigger is also above GitHub's 1 GB recommendation for a Pages source
repository.

## 3. Options evaluated

### 3.A Artifact deployment (Pages source "GitHub Actions")

Section 4 has the details. In brief:

- **History:** none for served bytes. The pointer chain grows by about
  0.85 KiB a publication.
- **Trust:** unchanged.
- **Publication authority narrows.** Today any repository writer can push
  `gh-pages`, and Pages serves it. After the change, only a job running from
  `main` in the `github-pages` environment, with `pages: write` and
  `id-token: write`, can deploy. Even that job deploys only a pointer tip that
  passes chain verification (4.3).
- **Recovery:** every generation for 90 days, a rolling durable pin, chosen
  pins indefinitely, and the pointer chain for all time.
- **Operations:** no recurring owner action. The build-rate soft limit does not
  apply.
- **Client URLs:** unchanged.
- **Cost:** about 25–38 MB uploaded per publication, both as an Actions
  artifact and as the Pages artifact. About 2.7–9.9 GB of artifacts are
  retained (4.2). A windowed site is under 4% of the 1 GB limit.

### 3.B Keep the branch and bound its history automatically

- **B1. The publisher force-pushes an orphan commit each run.**
  - It needs a ruleset exception that lets the publishing identity
    force-push `gh-pages`. Rulesets name roles, teams or GitHub Apps as
    bypass actors.
  - It may not need a new credential: the repository's existing app
    identities might be usable as the bypass actor. Whether the
    `GITHUB_TOKEN` identity can be named is not documented, so this is
    UNKNOWN.
  - **The real costs:**
    - It creates a standing, automated capability to erase the site's
      history.
    - History stops being evidence. Pins and audit still need storage
      elsewhere, which is option A's artifact and release machinery anyway.
    - It keeps branch builds and their 10-builds-an-hour soft limit.
    - Whether GitHub reclaims the unreachable objects, and so whether
      repository size falls at all, is UNKNOWN.
- **B2. A workflow compacts periodically.** The same capability, used less
  often, plus a `git bundle` archive. It is O3 automated, not removed.
- **Verdict:** rejected. B trades recurring manual compaction for a standing
  history-erasing capability, keeps the build limit, and still needs A's
  storage for pins and audit.

### 3.C Bodies as release assets, metadata on Pages

- **Growth.** It removes the compact body's 17.3–22.2 MB a day from Git.
  `browse/` (about 5.5 MB a day) and the metadata stay on the branch, so the
  2 GiB trigger moves to about 370 days. Compaction still recurs.
- **Clients.** It needs a new reader generation: a second targets base URL,
  and following the redirect from `github.com/.../releases/download/...` to the
  asset host. Core's transport follows no redirects today.
- **Trust.** TUF verifies the bytes wherever they come from, so trust holds.
- **Operations.** A release holds at most 1,000 assets, so a rotation scheme is
  needed, and immutable releases forbid deleting assets. Anonymous download rate
  limits are not documented (UNKNOWN).
- **Verdict:** rejected as the history answer. It stays in reserve as the
  **bandwidth** answer: release downloads have no documented bandwidth limit,
  while Pages has a soft 100 GB a month (about 970 daily clients at 3.45 MB).

### 3.D Chunked content addressing

Already designed as phase 2. It cuts compact Git growth to about 2.4 MB a day,
for about 7.9 MB a day in total. The trigger moves to about 263 days, so it
slows growth without removing it. Under option A, chunking is justified only by
client transfer, bandwidth and carrier bounds (5.5).

### 3.E Other GitHub-native options

- **A separate public repository as the site.** The URL changes to
  `boburning.github.io/<other>/`, which needs a new reader generation. It either
  keeps a growing branch or uses artifact deployment, which is A with more
  moving parts. GitHub has no policy that disables a branch's history.
  Rejected.
- **Git LFS.** It is not $0 at this scale.
  - Free covers 10 GiB of storage and 10 GiB of bandwidth a month, with no
    public-repository exemption stated.
  - About 3,000 client refreshes of a 3.45 MB body use up the bandwidth, and
    storage still grows with every version.
  - Whether Pages serves LFS objects is not documented.

  Rejected.

- **GitHub Packages (OCI).** A new protocol, an anonymous token exchange and a
  new reader. Rejected.
- **A history-free pointer ref**, force-updated with `--force-with-lease` in a
  namespace outside branch rulesets. It would give zero growth but no audit
  chain, and its protection is unclear. Rejected in favor of the fast-forward
  `pages-state` branch, whose growth is negligible.

### 3.F Summary

| Option                      | Served-byte Git growth          | Recurring owner action      | New authority                                    | Client change        |
| --------------------------- | ------------------------------- | --------------------------- | ------------------------------------------------ | -------------------- |
| Adopted plan (O3)           | 23–28 MB a day                  | Compaction every 74–90 days | A force-push exception each time                 | None                 |
| **A. Artifact deployment**  | **None; pointer ≈3 MiB a year** | **None**                    | Deploy from `main` only: **narrower** than today | **None**             |
| B1/B2. Automated force-push | Bounded                         | None                        | A standing history-erasing capability            | None                 |
| C. Bodies as release assets | ≈5.5 MB a day                   | Compaction about yearly     | None                                             | New reader           |
| D. Chunking alone           | ≈7.9 MB a day                   | Compaction every ≈263 days  | None                                             | New reader (phase 2) |
| E. Other                    | Varies                          | Varies                      | A URL change, a paid quota or a new protocol     | New reader           |

## 4. Target architecture

### 4.1 Components and file ownership

The site is one tree composed from components. Each path has exactly one owner,
and a producer may change only its own paths:

| Component | Paths                                                                              | Producers                                                 |
| --------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `catalog` | `catalog/**` (metadata, targets, `browse/`, `catalog-history/`, `history-ledger/`) | `catalog-publish.yml`                                     |
| `updates` | `updates/**`                                                                       | `app-release-build.yml` feed step, `withdraw-release.yml` |
| `site`    | `README.md`, `.nojekyll`, `site-generation.json`, `site-manifest.json`             | the composer                                              |

**One composer.** The composer is one module, `scripts/pages-site.mts`, shared
by every producer, the deploy job and the reconciler. No producer writes site
files any other way.

**What the composer refuses:**

- a change outside the producer's component;
- any symlink or hard link, or a duplicate path;
- an `updates/withdrawn.json` that is not a superset of the prior one;
- a site over its bounds. These are the existing 900,000,000-byte Pages
  check, and, while the held application controller exists, its 6,000-file /
  256 MiB bound. Windowed, the site measures 1,569 files and 31 MB.

### 4.2 Generation

A generation is the complete set of served files. It has two canonical JSON
parts: a small **header** and the **file list**.

```json
{
  "schema_version": 1,
  "composer_schema": 1,
  "previous": "<generation id or null>",
  "components": {
    "catalog": {
      "inventory_sha256": "…",
      "producer_run": 0,
      "source_commit": "…",
      "metadata_versions": {
        "root": 1,
        "timestamp": 0,
        "snapshot": 0,
        "targets": 0,
        "official-definitions": 0,
        "official-policy": 0
      }
    },
    "updates": {
      "inventory_sha256": "…",
      "producer_run": 0,
      "source_commit": "…",
      "feed_versions": { "preview": "0.1.0-preview.15" },
      "withdrawn": ["…"]
    }
  },
  "files_sha256": "<SHA-256 of the canonical file list>"
}
```

The file list is `[[path, length, sha256], …]` for every served file.

- **Generation ID.** The SHA-256 of the canonical header. The header includes
  `previous` and `files_sha256`. So a generation commits to the generation it
  was built from, to every file's bytes, and to the component facts that 4.3
  checks.
- **Manifest.** The header plus the file list, about 206 KB.
- **Generation artifact.** `site-generation-<id>` holds the manifest and every
  file. It is uploaded with `retention-days: 90` and is 3.8–11 MB compressed.
- **Served markers.**
  - `site-generation.json` holds the header and the generation ID. Readback
    and late readback use it in place of a commit SHA.
  - `site-manifest.json` is the full manifest. It is the verifiable fallback
    for rebuilding a generation from the served site.
- **Artifact storage.** 8–10 generations a day for 90 days is 720–900
  artifacts. At 3.8–11 MB each, that is **≈2.7–9.9 GB retained**. The
  repository keeps 2.49 GB of `catalog-work` artifacts today. If billing ever
  binds, generation retention can drop to 30 days (≈0.9–3.3 GB) without
  affecting pins.

### 4.3 Pointer branch `pages-state` and how it is verified

`current.json` on `pages-state` carries the generation's **full header**,
about 1 KB, so every check below is a Git read:

```json
{
  "schema_version": 1,
  "kind": "advance",
  "generation": "<id>",
  "header": { "…": "the generation header from 4.2" },
  "artifact": { "run_id": 0, "artifact_id": 0, "sha256": "…", "bytes": 0 },
  "component": "catalog",
  "restore_pin": null
}
```

- `kind` is one of:
  - `advance`: a new generation;
  - `refresh`: the same generation with a re-uploaded artifact (4.7);
  - `repair`: recovery from an unverified suffix (below);
  - `genesis`: the first commit only.
- `restore_pin` names the pin-store entry when the generation is a restore
  (5.6).

**Compare-and-swap.** A producer commits a new `current.json` whose parent is
the pointer commit it composed from. It pushes without force. If a concurrent
producer pushed first, the push is not a fast-forward, so the loser re-reads
the tip and recomposes. That is the same 4-attempt loop as today, moved from
`gh-pages` to `pages-state`.

**Verification before any use.** Branch protection blocks only force-pushes
and deletion. Any writer, or any job with `contents: write`, can fast-forward
`pages-state`. So the composer, the deploy job and the reconciler trust no tip
until it passes every check below. Otherwise a pushed `current.json` naming an
older genuine generation could re-serve a withdrawn application version.
`updates/` has no TUF floor.

**The walk.** The checks walk from the tip back to the **verified
checkpoint**, the newest pointer commit named by an accepted checkpoint record:

- **Deploy receipt.** An artifact `pages-deployed-<id>` that
  `pages-deploy.yml` uploads after a deployment it read back. It names the
  pointer commit it deployed and any commits a repair skipped. It is checked
  like any other artifact under rule 3: its run's `head_sha` must be reachable
  from `main`, and its workflow path must be on the allowlist.
- **Served marker.** `site-generation.json`, read with a cache-busting query.
  It is accepted **only** while both of these hold:
  - the Pages API reports `build_type: workflow`;
  - the composer's `SERVED_MARKER_CHECKPOINT` constant is on. The lead turns
    it on in the M5 change, after O-H2b has removed `gh-pages` from the
    environment.

  During M1–M3, during the O-H2a→O-H2b window, and after any flip-back
  (O-H4r), `gh-pages` serves the marker and any writer can push it. Then
  only deploy receipts and genesis count.

- **Genesis.** Until the first receipt exists, the checkpoint is the genesis
  commit.

**Ancestry.** The checkpoint commit must be an ancestor of the tip
(`git merge-base --is-ancestor`). Otherwise the run refuses with
`CHECKPOINT_NOT_ANCESTOR`.

**Trust root.** The checkpoint's trust rests on two things:

- the `github-pages` environment admitting only `main` (O-H2a, then O-H2b);
- the workflow-path allowlist with the `main` reachability check.

No owner action beyond section 6 is needed.

A Git ref is not used for the checkpoint. GitHub cannot restrict a ref to one
workflow without a ruleset bypass, and this design adds none.

1. **Linkage.** For each commit after the checkpoint:
   - the SHA-256 of `header` must equal `generation`;
   - for `advance`, `header.previous` must equal the parent commit's
     `generation`;
   - `refresh` keeps its parent's generation and header, and changes only
     `artifact`.
   - `repair` follows the repair rule below. Its `previous` is the newest
     verified generation, not necessarily the parent's.

   A tip that names an older generation fails, because its `previous` points
   at that generation's own predecessor, not at the tip's parent. So does a
   replayed pair of older generations stacked on a newer tip: the first
   replayed commit's `previous` does not match.

2. **Monotonic components.** Between consecutive headers:
   - `producer_run` never decreases.
   - `source_commit` equals its predecessor or descends from it, checked with
     `git merge-base --is-ancestor` on `main`.
   - Catalog `metadata_versions` never decrease.
   - `updates.withdrawn` is a superset of its predecessor.
   - Each channel's `feed_versions` entry never decreases. The only exception
     is a channel whose previous version is added to `withdrawn` in the same
     generation. That channel may move to the newest eligible lower version,
     or be removed, which is RELEASING's withdrawal rule.
3. **Tip content and provenance.** These checks run on the tip only. Every
   earlier generation in the walk was checked the same way when a producer
   built on it.
   - **Artifact provenance.** The artifact was uploaded by a run whose
     `head_sha` is reachable from `refs/heads/main`, and whose workflow path
     is on a fixed allowlist: the three producers and `pages-deploy.yml`. This
     is checked through the Actions runs API with `actions: read`, and the
     artifact's digest must equal `current.json`.
   - **Source binding.** Each component that the generation changes must have
     `source_commit` equal to that run's `head_sha`.
   - **Manifest.** The manifest's header must equal `current.json`'s, the file
     list must hash to `files_sha256`, and every file must match its digest.
   - **Superseded code.** Runs of superseded workflow code qualify as long as
     the code was on `main`, because each generation is re-verified by
     content, and for the catalog by the full TUF history check.
   - **Composer schema.** A generation whose `composer_schema` is below the
     composer's `MINIMUM_COMPOSER_SCHEMA` constant is refused. A later
     reviewed change can raise it to retire generations built by code found
     faulty.
   - A `restore_pin` must name an entry in the pin store at the run's
     `head_sha` on `main` (5.6).
4. **Bounds** (4.1).

**Genesis (M1).** The first generation has `previous: null`. It is accepted
only as follows:

- as the root commit of `pages-state`, with `kind: genesis`;
- while the site serves no `site-generation.json`, as a branch-built site does;
- only when its files equal the `gh-pages` tree byte for byte (T-PARITY).

The genesis commit is then the checkpoint until the first deploy receipt
exists. Every later `previous: null` is refused.

**A failed check refuses the tip** with a named reason. The deploy job and
the reconciler never deploy an unverified tip. Two outcomes are kept apart:

- **UNKNOWN** evidence: an API outage, or an incomplete runs listing.
  Nothing is skipped. The run retries on its next trigger and fails visibly.
- **Known failure:** a digest, linkage, monotonicity or provenance mismatch
  with complete evidence. The tip is recovered by repair, below.

**Repair, automatic.** Walking forward from the checkpoint, the verified
prefix ends at the newest commit that passes every check. Its generation is
**V**. The commits after it, up to the tip, form the **unverified suffix**.
Any producer, or the reconciler, that finds a known failure writes a `repair`
commit:

- its parent is the current tip, so it is still a fast-forward with no
  force-push;
- `header.previous` is **V**;
- it is composed from V's files plus the producer's own change, if any;
- it must pass rule 3 as a run from `main`, with no exception. A repair from
  any other run is refused.

The walk accepts a `repair` commit only under all of these conditions:

- `previous` equals the generation of the newest commit in the verified
  prefix, so **a repair can never skip a verified generation**;
- every skipped commit fails verification with complete evidence;
- rule 2 holds between V and the repair, so **a repair never lowers any
  version, run or feed** and never shrinks withdrawals.

The walk then continues from the repair as from any verified commit.

The deploy receipt and the run report list every skipped commit. The run
completes the repair and publishes, then fails its final `pointer-integrity`
step with `POINTER_REPAIRED`. That failure notifies the repository's watchers,
so a forged push is always visible. It needs no human action to resume
publication. Repeated poisoning costs one repair each, and is an incident for
the lead, not maintenance.

**What a writer can still do:**

- **Stop publication.** A writer can push to `pages-state` and so stop
  publication. They can already do that today by pushing a broken `gh-pages`.
- **Dispatch producers on `main`.** A dispatched run executes reviewed `main`
  code on current `main` inputs. That code accepts only forward changes
  (rule 2), and restore sources only from pin-store entries merged to `main`
  (5.6). A dispatch can therefore cause only a publication that `main` would
  make anyway, such as an early renewal. It cannot select an older feed,
  catalog or generation.

**The walk has no stalling bound.** Each step reads one 1 KB Git object. Only
the tip's artifact is downloaded. A walk of 10,000 steps (about 3 years of
publications with no successful deployment) still costs seconds. There is
one sanity bound: a walk longer than 100,000 commits (about 27 years of
publications) refuses with `POINTER_WALK_BOUND`. That is a classified alarm,
not a recovery state, and it cannot be reached while deployments succeed.
Publications that pile up while deployments fail therefore never stall the
walk. The next successful deployment, or deploy receipt, advances the
checkpoint.

### 4.4 Measured history growth of the pointer branch

- **A full manifest on the branch** (rejected). I committed each of the 74
  historical `gh-pages` trees' manifests (1,614 lines, 206,535 bytes) to a
  scratch repository. That packed to 2.60 MiB, about **35 KiB a publication**,
  because nearly every `browse/` file changes each publication. At 10
  publications a day it would reach 2 GiB in about 16 years: slow, but
  unbounded and pointless.
- **Pointer only** (chosen). Two simulations, each of 2,000 commits:
  - a 476-byte `current.json` on one line, with fresh random digests in
    every commit (the worst case for delta compression): 1,690 KiB, about
    **0.85 KiB a publication**;
  - the revision-2 shape, a 1,446-byte pretty-printed `current.json` with the
    full header, random digests and the catalog changing every commit:
    1,213 KiB, about 0.61 KiB a publication.

  At the conservative 0.85 KiB and 10 publications a day, growth is about
  3 MiB a year, so 2 GiB is about 680 years away. Nothing ever needs
  compaction. The per-run report still records the packed size (8).

### 4.5 One publication

```text
producer job (contents: write, actions: read)
  1. read pointer tip T on pages-state; verify T (4.3)
  2. download T's generation artifact; verify its digest and manifest
  3. apply this component's change (today's overlay logic, the body window, the ledger)
  4. compute manifest (previous = T's generation) -> generation G; check bounds
  5. upload artifact site-generation-G (retention 90 days)
  6. commit current.json (parent T) and push without force; on rejection go to 1
deploy job: reusable pages-deploy.yml (pages: write, id-token: write,
            environment github-pages, concurrency group "pages")
  7. read the tip H (H is G or a descendant); verify H (4.3); download it
  8. actions/upload-pages-artifact (H's files), then actions/deploy-pages
  9. read back site-generation.json == H with cache-busting queries
readback job (if: always() && needs.producer succeeded)
 10. the producer's own readback: accept a served generation that has G in its chain
```

- **Deploy the tip, not your own generation.** Every deploy job deploys the
  verified tip as it reads it at start. Deploy jobs serialize in the `pages`
  group, and each starts after its producer's push. So the last deployment is
  always at or after the newest pointer, and an older generation never
  overwrites a newer one.
- **A dropped pending job is harmless.** GitHub may drop a pending deploy job
  when a newer one queues, as its starter workflow notes. The newer job deploys
  a tip that contains the dropped job's generation.
  - The producer's readback job runs with `if: always()` even when its deploy
    job was dropped. It accepts any served generation whose chain contains its
    own and carries its component inventory.
  - If no such generation is served within 15 minutes, the scheduled late
    readback observes it later, as today.
- **Hourly reconciler.** `pages-deploy.yml` also runs on a schedule. If the
  served `site-generation.json` differs from the verified tip on two
  consecutive cache-busted reads, it deploys the tip. A lost deployment heals
  without a person.

### 4.6 Atomicity, partial failure and caches

| Failure point                            | State left                                         | Recovery                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Before step 5                            | Nothing durable                                    | The next run starts clean                                                                                                    |
| Artifact uploaded, pointer push lost     | An orphan artifact                                 | Expires after 90 days; never deployed, because no verified pointer names it                                                  |
| Pointer pushed, deploy failed or dropped | Pointer ahead of the served site                   | The next deploy job or the hourly reconciler deploys the tip; the report flags the lag                                       |
| Deploy timed out (10 min)                | Previous deployment serving (UNKNOWN; T-INTERRUPT) | Same as above                                                                                                                |
| Deployed, readback failed                | As today                                           | Late readback on the next schedule; the existing warning                                                                     |
| A pushed tip fails verification          | Publication stopped                                | The reconciler and producers fail with the reason. The next producer or reconciler writes a `repair` commit (4.3) and alarms |

- **Within a deployment,** all files change together (observed today).
- **At the CDN,** each URL is cached for 600 seconds, as today.
  - Only `timestamp.json` and the two served markers are mutable. Versioned
    metadata and content-addressed targets get new names.
  - A client holding a cached timestamp can still find the previous body,
    because the window keeps it.
  - Two publications less than 600 seconds apart could prune a body that a
    timestamp cached two generations ago names. The client then gets a 404
    and keeps its verified state until its next refresh. The body window on
    `gh-pages` behaves the same way.
- **Every workflow read of the served site** (anchor, reconciler, readback,
  HTTPS rebuild) uses a per-run cache-busting query, as the catalog readback
  does today.

### 4.7 Prior state, readers, readback and durability

| Need                                           | Today                                       | After                                                                                         |
| ---------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Catalog `prepare` prior (`PRIOR=site/catalog`) | `gh-pages` worktree                         | `catalog/` from the verified tip's generation artifact                                        |
| `PRIOR_COMMIT` for segmented history           | `gh-pages` commit, `--depth=1` fetch        | `PRIOR_GENERATION`: the artifact of that generation                                           |
| Catalog version floor for planning             | Prior tree's metadata                       | The prior tree's metadata, and at least `catalog_metadata_versions` across the verified chain |
| Feed and withdrawal producers                  | `gh-pages` worktree                         | `updates/` from the verified tip                                                              |
| Released-reader selection                      | `updates/preview/latest.json` at `gh-pages` | The same files from the verified tip's generation                                             |
| Publish readback                               | Timestamp and browse digests                | Unchanged, plus `site-generation.json`                                                        |
| Late readback                                  | Catalog commit and its parent (`--depth=8`) | The previous catalog generation from the pointer chain; no depth limit                        |

**Durability, without a person:**

- **Artifact refresh.** When the tip's artifact is more than 60 days old, the
  reconciler re-uploads the same verified files. It then pushes a `refresh`
  commit. The generation is unchanged and the artifact is younger.
- **Rolling durable pin.** Once a week, the reconciler copies the verified tip
  into a `pages-pin-<first 16 hex>` prerelease with `make_latest: false`. It
  keeps the newest two rolling pins and deletes older rolling ones. Chosen pins
  (5.6) are never deleted this way.
- **Rebuild from the served site.** If an artifact is gone anyway, the
  publisher fetches `site-manifest.json` and every file over HTTPS with
  cache-busting. It verifies the manifest digest against the pointer, and each
  file against the manifest. That is about 31 MB of Pages bandwidth, so it is
  a fallback only. If that also fails, it restores from the newest pin.
- **Inactive repositories.** GitHub disables scheduled workflows after 60 days
  without repository activity in a public repository. The catalog's own
  schedule has the same dependency today. The rolling pin and the artifact
  refresh make a 60-day pause recoverable: the first run after it rebuilds from
  a pin or the served site. The per-run report records the days since the last
  default-branch activity.

### 4.8 Permissions and publication authority

| Job                                | Today                         | After                                                                                                                            |
| ---------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Catalog `publish`                  | `contents: write`             | `contents: write` (pointer, pin releases), `actions: read`                                                                       |
| Feed step, withdrawal              | `contents: write`             | Same as catalog `publish`                                                                                                        |
| `pages-deploy.yml` (new, reusable) | —                             | `contents: write` (refresh and rolling pin only), `actions: read`, `pages: write`, `id-token: write`; environment `github-pages` |
| Built-in `pages-build-deployment`  | Runs on every `gh-pages` push | Stops                                                                                                                            |

**Who can publish, before and after:**

- **Before.** Any repository writer can push `gh-pages`, and Pages serves it.
  RELEASING already records this.
- **After.** Only a job running from `main` in the `github-pages` environment
  can deploy, and it deploys only a tip that passes 4.3.
  - `main` changes only through reviewed, merged pull requests.
  - A writer can still push `pages-state` or upload an artifact from a branch
    run. Linkage, monotonicity and provenance refuse those, so the most a
    writer can do is stop publication, which they can already do today.

This is a change to publication authority, so the owner approves it (section 6).
Signing authority does not change.

## 5. Migration

### 5.1 Sequence

Owner actions (O-H…) are defined in section 6. The order is binding.

| Step | What                                                                                                                                                                                                                                                                                                                                      | Authority                                   | Rehearsal                                                                                            | Rollback                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P    | Owner pre-checks: O-H6 (retention and billing), O-H7 (read the environment policy), O-H3 (protect `pages-state`), O-H0 (rehearsal repository, before M2)                                                                                                                                                                                  | **Owner**                                   | —                                                                                                    | —                                                                                                                                         |
| M0   | The composer module and `pages-deploy.yml` as inert code, with the verification logic in 4.3. Tests T-SIM, T-CONCURRENT, T-INTERRUPT, T-RESTORE, T-PROVENANCE, T-POISON and T-STALL run against a local bare remote and a fake deploy. Also the test that release-inventory consumers ignore `pages-pin-` releases.                       | Lead: ordinary reviewed PR                  | Offline tests                                                                                        | Revert                                                                                                                                    |
| M1   | **Shadow mode, after O-H3.** Each of the three producers also composes a generation, uploads the artifact and advances `pages-state`, then pushes `gh-pages` as today. A parity check requires the generation's files to equal the `gh-pages` tree byte for byte. No Pages permission is added and no pin is created.                     | Lead: reviewed PR                           | At least 14 days and 100 publications of parity in production; T-READER parity                       | Revert; `pages-state` is ignored                                                                                                          |
| M2   | Add the deploy job and reconciler: `pages: write`, `id-token: write`, environment `github-pages`. They are gated on the Pages API reporting `build_type: workflow`, so they are no-ops while the source is the branch. Switch released-reader selection and late readback to the verified pointer, with `gh-pages` kept as a cross-check. | **Owner approves the merge (O-H1)**         | In the O-H0 repository: T-ATOMIC, T-FLIP, T-INTERRUPT, T-CLIENT and a ≈20-deploys-an-hour rate probe | Revert                                                                                                                                    |
| M3   | O-H2a, then O-H4. Verify that the first workflow deployment serves the verified tip, and the lead merges the stop-`gh-pages`-writes change the same day. Then O-H2b. **This is the last regular `gh-pages` write.**                                                                                                                       | **Owner** (settings), lead (stop-writes PR) | First deployment read back; `site-generation.json` equals the tip                                    | Flip back (below)                                                                                                                         |
| M4   | **Probation, 14 days, with no `gh-pages` writes.** The report shows deployments, lag and verification.                                                                                                                                                                                                                                    | Lead                                        | Live                                                                                                 | **Flip back:** the lead pushes one sync commit of the verified tip's tree to `gh-pages`, then the owner reverses O-H4 (and O-H2b if done) |
| M5   | Remove the shadow code, the depth fetches, the `gh-pages` cross-checks and the commit-based restore steps. Turn on `SERVED_MARKER_CHECKPOINT` (O-H2b is done by then). Generation pins become the default pin kind. Rolling pins start.                                                                                                   | Lead: reviewed PR                           | One week clean                                                                                       | Revert; flip back as in M4                                                                                                                |
| M6   | O-H5: freeze or archive `gh-pages`.                                                                                                                                                                                                                                                                                                       | **Owner**                                   | —                                                                                                    | Lift the rule; push the bundle back to a branch                                                                                           |

- **When to start.** M0 and M1 can begin once #8631 merges. They touch only the
  overlay's caller and the push step, and neither waits on the compact cutover.
- **Without O-H0.** If the owner declines a rehearsal repository, M2's
  rehearsal moves into production at M3. That happens only if the owner
  explicitly accepts it. The protection is then the flip back in M4.

### 5.2 What happens to the existing `gh-pages` history

From M3 the branch changes at most once more: a flip-back sync commit, if
probation fails. Its size is fixed at M3:

```text
frozen history ≈ 67 + 6.8·d + rate·(M3 − cutover) MB   (d = cutover − 2026-11-23, rate 23–28 MB/day)
```

| Cutover    | M3         | Frozen history    |
| ---------- | ---------- | ----------------- |
| 2026-11-30 | 2027-01-06 | ≈0.96–1.15 GB     |
| 2026-11-30 | 2027-01-27 | **≈1.45–1.74 GB** |
| 2026-12-07 | 2027-01-27 | ≈1.34–1.59 GB     |

It never needs compaction, because nothing adds to it. At O-H5 the owner
chooses:

- **Keep it frozen (recommended).** A ruleset restricts updates, with no
  force-push and no exception. It stays readable evidence of every
  pre-migration publication and the restore source for `pages_commit` pins.
- **Archive, then delete.** `git bundle create` of the branch, uploaded as a
  release asset. If it exceeds 2 GiB, use two bundles split at a commit
  boundary, with the second bundle's prerequisite being the first bundle's
  tip. Then delete the branch. Whether this reduces repository size depends
  on GitHub reclaiming unreachable objects, which is UNKNOWN; option B has the
  same dependency. So deletion is for tidiness, not a guaranteed size saving.

### 5.3 Interaction with #8619 (compact-only cutover)

Unchanged: the cutover, the minimum supported preview (Preview 14), the static
legacy target and the released-reader gate. The cutover's one bad hosting
consequence, about 2.58 MB of Git history per change, lasts only until M3.
After M3 a compact change costs one 90-day artifact and nothing permanent.

### 5.4 Interaction with #8631 (window, ledger, pins)

**#8631 merges as it is.**

| Part of #8631                                  | Under this design                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body window                                    | **Still required.** Every generation is a complete site, so the window sets each artifact's size (31 MB, not 405 MB), keeps the site far below 1 GB, and bounds the prior that signers verify.                                                                                                              |
| Listing-floor ledger                           | **Still required.** It lets verification skip pruned bodies, and it moves with `catalog/` into each generation. Its integrity improves: a served ledger changes only through a verified `main` deployment, not a direct push. Binding its digest in signed metadata (H1) is still the cryptographic answer. |
| Pin store, `pages_commit` pins                 | **Stay valid.** They remain restorable from the frozen `gh-pages` or its bundle. Generation pins (`generation`) are an **additive** pin kind, introduced at M5.                                                                                                                                             |
| Manual restore runbook (`git checkout P -- …`) | **Obsolete at M5 for new pins.** It still applies to `pages_commit` pins against the frozen branch. Generation pins extract from the pin release.                                                                                                                                                           |
| `--depth=1` fetch; late-readback deepen to 8   | **Obsolete at M5.** Nothing reads `gh-pages` for publication.                                                                                                                                                                                                                                               |
| Per-run retention report                       | **Stays,** extended with the fields in section 8.                                                                                                                                                                                                                                                           |
| O3 compaction                                  | **Retired** if M3 lands before the due date (9).                                                                                                                                                                                                                                                            |

### 5.5 Interaction with the adopted design's later phases

- **History checkpoints (H1, H2, O1)** are unchanged in substance. Checkpoint
  objects live under `catalog-history/` in each generation.
  `restore-publication --pin` also accepts a generation pin.
- **Phase 2 chunking** loses its Git-history trigger (compaction more often than
  every 60 days). Its remaining triggers are client transfer, Pages' 100 GB soft
  bandwidth, and the carrier's 70% bound.
- **`browse/` stability** is no longer a history concern. It is still worth
  doing for artifact size and client transfer.

### 5.6 Pins, restore and rollback without commits

- **A pin is a generation.** The pin store (at most 8, changed by reviewed
  PR) gains entries `{generation, reason}`. On the next run, the publisher
  copies that generation's artifact into a prerelease
  `pages-pin-<first 16 hex>` with `make_latest: false`. The asset is named by
  the generation ID.
  - A chosen pin must be added within 90 days of its generation. Last-good pins
    are normally hours old, and the weekly rolling pin covers the rest.
  - The release-inventory exclusion test lands in M0, before any pin release
    exists. `listReleases` in `app-release.mts` is used by withdrawal.
- **Verification.** The asset's SHA-256, then the manifest digest equals the
  generation ID, then `verify-definition-repository` on its `catalog/`.
- **Cost.** At most 10 pins (8 chosen plus 2 rolling) × 3.8–11 MB, so under
  110 MB.
- **Unpinning.** The publisher deletes the release. Immutable releases allow
  deleting a release, but not reusing its tag. Tags are content-addressed, so
  none is reused.
- **Who may choose a restore source.** Only a pin-store entry merged to
  `main` through a reviewed PR. That covers chosen pins, and a rolling pin
  once a PR names it. The `catalog-publish.yml` restore input takes a
  pin-store entry name, never a generation ID, artifact or URL. The run
  checks that the name exists in the pin store at its own `head_sha`, and
  records it as `restore_pin` (4.3 rule 3). A writer without merge rights to
  `main` cannot pick an older generation to re-serve.
- **A restore or rollback is one forward generation.** Copied older catalog
  files carry lower metadata versions, so 4.3 rule 2 and every client refuse
  them on their own. So one run composes, as a single generation:
  1. `previous` set to the current tip;
  2. the restored content-addressed files from the pinned generation:
     catalog bodies and targets, and `browse/` when needed;
  3. **new signed catalog metadata**: the ordinary renewal, signed by the
     existing role jobs. Its versions are above the maximum
     `metadata_versions` in the chain and in the pinned generation, and it
     names the restored targets;
  4. **`updates/` from the current tip, always**, including
     `updates/withdrawn.json` and every feed. They are never taken from the
     restored generation. A withdrawal therefore always survives a restore.

  The result passes rule 2, and clients accept it as an ordinary newer
  publication. This is the existing restore runbook and the renewal merged
  into one publication run.

- **`updates/` rollback.** Feeds move only forward (4.3 rule 2). Replacing a
  broken feed file with a newer or equal, correct file is an ordinary feed
  publication. Moving a channel to a lower version is a withdrawal, which
  stays the owner's `withdraw-release.yml`, and the composer accepts it
  through the withdrawal exception.
- **Never point at an old generation.** No route pushes a pointer naming an
  old generation, because linkage refuses it.
- **Who acts.** The lead, under existing delegation: a reviewed pin-store PR,
  then a dispatch of the restore run. Owner authority is needed only for a
  withdrawal, as today.

## 6. Owner actions

Each action is one-time, and none recurs. Do them in this order:

| ID        | When                   | Exact action                                                                                                                                                                                                 | Consequence in plain language                                                                                                                                                                                                                                     | Undo                                          |
| --------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **O-H6**  | Before M1              | Settings → Actions → General → **Artifact and log retention: confirm 90 days**. Read the account's billing page for Actions storage.                                                                         | Generations stay available for 90 days. Shows whether artifact storage is billed for a public repository (it is expected to be free).                                                                                                                             | Read-only; nothing to undo                    |
| **O-H7**  | Before M1              | Settings → Environments → `github-pages`: **read and report** the current deployment branch and tag rules, reviewers and administrator bypass.                                                               | Lets the lead write M2 against the actual policy, including any rule kept for the held application controller.                                                                                                                                                    | Read-only; nothing to undo                    |
| **O-H3**  | Before M1              | Settings → Rules → new branch ruleset for `pages-state`: **block force pushes**, **restrict deletions**. No bypass list.                                                                                     | The pointer history cannot be rewritten or removed. Publishers still advance it with normal pushes. Content is checked by verification (4.3), not by this rule.                                                                                                   | Disable the ruleset                           |
| **O-H0**  | Before M2              | Create a **throwaway public repository**. Grant the lead write access for the rehearsal, then delete the repository afterwards.                                                                              | A safe place to test atomic replacement, a source flip, an interrupted deployment and about 20 deployments an hour, without touching the real site. If declined, the first production deployment is the rehearsal, and only if the owner accepts that explicitly. | Delete the repository                         |
| **O-H1**  | M2                     | **Approve the merge** of M2, which gives the reusable `pages-deploy.yml` job `pages: write` and `id-token: write` in the `github-pages` environment.                                                         | Workflow code on `main` gains the ability to publish the website. It replaces today's route, in which anyone with write access can push `gh-pages`. Nothing is signed differently.                                                                                | Revert the PR                                 |
| **O-H2a** | M3, first              | Settings → Environments → `github-pages` → Deployment branches and tags: **add a branch rule for `main`**. **Keep `gh-pages`** for now. Keep administrator bypass off.                                       | Both the old branch build and the new workflow can deploy during the switch. Until O-H2b, today's exposure remains: a writer can still deploy from `gh-pages`. Do O-H4 and O-H2b on the same day to keep that window short.                                       | Remove the `main` rule                        |
| **O-H4**  | M3, second             | Settings → Pages → Build and deployment → Source: change **"Deploy from a branch" (`gh-pages`) to "GitHub Actions"**. Then confirm that the first workflow deployment serves the expected generation.        | Pushes to `gh-pages` stop publishing. The site keeps serving the last branch deployment until the first workflow deployment, which usually runs within the hour. The 10-builds-an-hour soft limit stops applying.                                                 | Switch back after the lead's sync commit (M4) |
| **O-H2b** | M3, third              | Same environment page: **remove the `gh-pages` rule**, leaving only `main`.                                                                                                                                  | Only workflows running from `main` can deploy the site. A branch or pull request cannot.                                                                                                                                                                          | Re-add `gh-pages`                             |
| **O-H4r** | Only if M4 or M5 fails | **Flip back:** after the lead's sync commit of the verified tip to `gh-pages`, reverse O-H4 (Source → "Deploy from a branch", `gh-pages`, root), and re-add `gh-pages` to the environment if O-H2b was done. | The site is served from `gh-pages` again, exactly as before the switch. Producers resume their `gh-pages` writes through a reverted PR.                                                                                                                           | Repeat O-H4                                   |
| **O-H5**  | After M5 (M6)          | Either freeze `gh-pages` with a ruleset that **restricts updates** (recommended), or archive it as one or two `git bundle` release assets and delete the branch.                                             | The old history stops changing, or moves into archive files. No force-push, ever.                                                                                                                                                                                 | Lift the rule; push the bundle back           |

No ruleset bypass, new secret, credential, signing role or key is needed.

**The lead, under existing delegation,** handles:

- M0, M1, M5, and the code half of M2 (review and CI, before the owner approves
  the merge);
- the stop-writes change at M3, probation monitoring, and any flip-back sync
  commit;
- pin-store PRs, restores from pin-store entries, and forward rollbacks;
- the sync commit before any O-H4r.

## 7. Compatibility

### 7.1 Clients

Same URLs, bytes and formats, so every released reader is unaffected:

- Preview 13's static legacy target, and Preview 14 and later's compact target;
- the updater feeds;
- the browse pages.

The minimum supported generation from #8619 is unchanged, and installed data
is untouched.

### 7.2 Publisher behavior that stays

Compact-only delivery, the released-reader gate, the body window, the ledger,
history checkpoints, signing jobs and environments, the triggers and schedule,
the `unchanged` and `renewal-due` decisions, and readback receipts with their
seven-day artifacts.

### 7.3 Held application controller

The held controller already assumes `build_type: workflow`, one composer of a
complete site, and generation markers. M2 must not change its inert files.

When it activates, there are two paths, each under its own reviewed change:

- it becomes the `updates` producer through the same composer, verification
  and pointer; or
- it replaces the composer as the sole Pages writer.

Either way, the 6,000-file / 256 MiB bound holds: the windowed site is 1,569
files and 31 MB.

## 8. Operations: what replaces owner maintenance

There is no recurring owner action. Each run's report goes to the log, the step
summary and the existing receipt, and records:

- **The pointer:** the verified tip, the served anchor, the lag between them,
  and the chain-walk length;
- **Bounds:** the site's files and bytes against 900,000,000 bytes, 256 MiB,
  6,000 files and 1 GB;
- **Deployment:** the generation artifact's bytes and age, the deploy duration
  and retries;
- **Growth:** the `pages-state` packed size and the projected years to 1 GiB;
- **Pins:** chosen and rolling pins, their release bytes, and the age of the
  newest rolling pin;
- **Inactivity:** days since the last default-branch activity, against the
  60-day schedule disablement;
- **#8631:** the ledger and window fields.

**Failure signals** use the existing route: a failed workflow notifies the
repository's watchers.

- The reconciler fails when the tip fails verification, or when the served
  generation lags the verified tip for more than two hours.
- The report warns at 70% of any bound, at an artifact older than 60 days
  without a refresh, and at a rolling pin older than 8 days.

**Lead upkeep** is ordinary issue work when a warning appears. No setting,
force-push or exception is part of it.

## 9. Interim and deadline

Until M3, the adopted plan stands unchanged: the #8619 cutover, the #8631
window (activated within about a week of the cutover), and O3 if it falls due.

**When O3 would fall due.** History is 63.87 MiB (66.97 MB) on 2026-11-23. It
grows by about 6.8 MB a day until the cutover, then by 23–28 MB a day (18–22
with the stop-gap). The trigger is 2 GiB (2,147.5 MB). The clock stops at the
last `gh-pages` write, which is M3. For a cutover `d` days after 2026-11-23:

```text
days after cutover until O3 = (2147.5 − 66.97 − 6.8·d) / rate
```

| Cutover               | History at cutover | Due at 28 MB/day | Due at 23 MB/day | With the stop-gap (22–18) |
| --------------------- | ------------------ | ---------------- | ---------------- | ------------------------- |
| 2026-11-30 (`d` = 7)  | ≈115 MB            | **2027-02-10**   | 2027-02-26       | 2027-03-02 – 2027-03-23   |
| 2026-12-07 (`d` = 14) | ≈162 MB            | 2027-02-15       | 2027-03-03       | 2027-03-07 – 2027-03-27   |
| 2026-12-21 (`d` = 28) | ≈257 MB            | 2027-02-26       | 2027-03-13       | 2027-03-16 – 2027-04-05   |

**Deadline for the long-term change.** The last regular `gh-pages` write (M3)
must come before the due date, with room for at most one flip-back sync commit
(about 25–40 MB). For a cutover on 2026-11-30, aim for **M3 by 2027-01-27**,
which leaves two weeks for slips.

If M3 slips past the due date, O3 is performed once under the adopted plan. M3
still removes every later compaction, and history then stops at whatever size
O3 left.

## 10. Test plan

| ID           | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Where                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| T-SIM        | 5,000 simulated publications of both components through the composer. Assert deterministic generation IDs, window bounds and artifact size, and that the `pages-state` packed size matches the projection in 4.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | M0, offline                                |
| T-CONCURRENT | Catalog and feed producers race on a local bare `pages-state`. Assert CAS retries, no lost files and component isolation. Run deploy jobs out of order and drop a pending deploy. Assert the final served generation is the tip, contains both changes, and the readback job still reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | M0, offline                                |
| T-POISON     | Fast-forward `pages-state` to a commit naming an older genuine generation, a generation with a lower `producer_run`, a `source_commit` that does not descend from its predecessor, lower catalog versions, a shrunken `withdrawn.json`, a lowered feed version without a withdrawal, a replayed pair of older generations stacked on the tip, a header whose digest does not match its `generation`, a second `previous: null`, or a `restore_pin` absent from the pin store at the run's `head_sha`. Assert every one is refused, and that nothing is deployed or composed from it. **Recovery end to end:** after each poison, the next producer writes a `repair` whose `previous` is the newest verified generation. The deploy receipt lists the skipped commits, the `pointer-integrity` step alarms, and the next ordinary producer advances normally. Also refused: a repair whose `previous` skips a verified generation, a repair that lowers a version or shrinks withdrawals, a repair from a non-`main` run, a served-marker checkpoint while `build_type` is legacy or before `SERVED_MARKER_CHECKPOINT`, and a checkpoint that is not an ancestor of the tip. An API outage during verification skips nothing. | M0, offline                                |
| T-INTERRUPT  | Kill the run after each step in 4.5. Assert convergence through the next deploy or the reconciler, and that orphan artifacts are never deployed. In the rehearsal repository, cancel `deploy-pages` mid-run and observe what is served.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M0 offline; M2 rehearsal                   |
| T-RESTORE    | Restore from a chosen pin and from a rolling pin. Restore as one generation with renewed metadata, with `updates/` taken from the tip across an intervening withdrawal. **Delete the tip's artifact and rebuild it from the served site over HTTPS, verified against the pointer digest.** Refresh an artifact older than 60 days. Run `verify-definition-repository`, then plan a renewal: versions must exceed the chain's maximum. Also restore a `pages_commit` pin from the frozen branch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | M0, M5                                     |
| T-STALL      | 1,000 publications with every deployment failing, then one successful deployment. Assert that producers kept publishing, that the walk stayed fast, and that the deploy receipt advanced the checkpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | M0, offline                                |
| T-PROVENANCE | A pointer to an artifact from a run whose `head_sha` is not reachable from `main`, whose changed component's `source_commit` differs from the run's `head_sha`, from a workflow path not on the allowlist, with a wrong digest, or with a `composer_schema` below the minimum, is refused before composition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | M0                                         |
| T-READER     | Released-reader selection from the verified pointer equals selection from `gh-pages`, for every M1 publication. Release inventory ignores `pages-pin-` prereleases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | M0, M1                                     |
| T-PARITY     | Each shadow generation's files equal the `gh-pages` tree byte for byte.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M1, production shadow                      |
| T-ATOMIC     | During an Actions-source deployment, poll 50 files at the origin with cache-busting queries. Assert no mixed generation at the origin, and measure the CDN window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M2, rehearsal repository                   |
| T-FLIP       | Change the source from branch to Actions and back, including the sync commit. Measure the serving gap, and assert no 404 for the site's files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | M2, rehearsal repository                   |
| T-RATE       | About 20 deployments in one hour. Record any 429 or refusal, and the deploy durations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | M2, rehearsal repository                   |
| T-CLIENT     | The released Preview 15 CLI runs `catalog listing-refresh` and `listing-status` repeatedly, across one deployment and across two deployments within 600 seconds. Assert a verified success or a clean keep-last-verified, and never a lowered revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M2 rehearsal (fixture root); M3 production |

## 11. Open risks and UNKNOWNs

- **Atomic replacement and failed-deployment behavior** are not documented.
  T-ATOMIC and T-INTERRUPT settle them. Branch builds already rely on the same
  deployment mechanism.
- **Deployment rate limits** for Actions-source sites are not documented.
  T-RATE probes them. Today's rate is about 10 a day; a refusal fails the
  deploy job, and the reconciler retries.
- **Artifact storage billing** for public repositories is not stated. The
  evidence is 2.49 GB retained today without failure, and O-H6 settles it.
  The fallback is 30-day retention.
- **The current `github-pages` environment policy** is UNKNOWN (O-H7).
- **Immutable releases** for this repository are UNKNOWN. Pin handling works
  either way.
- **Unreachable-object reclamation** after branch deletion or rewriting is
  UNKNOWN. It affects only whether O-H5's archive-then-delete frees space.
- **Main repository size** against GitHub's 1 GB recommendation is UNKNOWN
  here, because this checkout is shallow. `gh-pages` alone is 64 MiB today and
  about 1.45–1.74 GB if frozen at M3 on 2027-01-27.
- **Schedules in an inactive repository** stop after 60 days. Mitigated by the
  rolling pin, artifact refresh, HTTPS rebuild and the report (4.7).
- **Pages bandwidth** stays a soft 100 GB a month: about 970 daily clients at
  compact 1×. Option C (release assets) and phase 2 chunking are the answers if
  it binds. Client counts are UNKNOWN.

## Owner summary (plain language)

Today the website is stored as a Git branch, and every update adds to that
branch's permanent history. Under the current plan, that means a manual cleanup
with a special force-push permission every two to three months, forever.

This design stops storing the website in Git. GitHub Pages can publish a
packaged copy of the site straight from a workflow, so there is no history left
to clean up. Each published copy is kept for 90 days, and pinned copies are
kept indefinitely, for audit and recovery. A tiny pointer branch records which
copy is current. It grows by about 3 MiB a year, and every publisher checks it
before trusting it. Players, installed games and the signed catalog see no
difference: same addresses, same signatures, same protections.

Only workflow code on `main` can publish after the switch. Today anyone with
write access can push the website branch. The old branch is frozen once and
never force-pushed.

**One-time owner actions, in order:**

1. **O-H6:** confirm 90-day artifact retention and check Actions storage
   billing.
2. **O-H7:** report the `github-pages` environment's current rules.
3. **O-H3:** protect `pages-state` against force-push and deletion, before the
   first pointer push.
4. **O-H0:** create a throwaway public repository for the rehearsal, and
   delete it afterwards. Or explicitly accept using production as the
   rehearsal.
5. **O-H1:** approve merging the deploy job's `pages: write` and
   `id-token: write`.
6. **O-H2a:** allow `main` in the `github-pages` environment, keeping
   `gh-pages` for now.
7. **O-H4:** switch the Pages source to "GitHub Actions", and confirm the first
   deployment.
8. **O-H2b:** remove `gh-pages` from the environment.
9. **O-H5:** freeze, or archive and delete, the old `gh-pages` branch.

Only if the 14-day trial or the cleanup fails: **O-H4r**, switch the Pages
source back to `gh-pages` after the lead syncs it, and re-allow `gh-pages` in
the environment.

After these, owner maintenance is **none**.

## Appendix: measurement method

- **`gh-pages`.** `git clone --bare --single-branch --branch gh-pages`, then
  `git count-objects -vH` and `git ls-tree -r -l HEAD` at `758583339`.
- **Archive sizes.** `git archive --format=tar HEAD`, piped through `gzip -6`.
  For the window, I extracted the tree and kept only the listing bodies named by
  policy versions 59 and 60 (`0d20ba97…` and `1cdce5cd…`). I then made a
  deterministic tar (`--sort=name --mtime=@0 --owner=0 --group=0
  --numeric-owner`) through `gzip -6`.
- **Manifest-on-branch growth.** For each of the 74 `gh-pages` commits in
  order, I committed a manifest line per file (`blob-id(40 hex)+24 hex`,
  length, path) to a scratch repository, then ran `git gc` and
  `git count-objects -v`.
- **Pointer growth.** 2,000 commits of a 476-byte one-line `current.json`,
  and separately (through `git fast-import`) 2,000 commits of a 1,446-byte
  header-carrying `current.json`. Fresh random digests each time, then
  `git gc`.
- **Deployments and artifacts.** Read-only listings of the repository's
  `github-pages` deployments, deployment statuses, `pages-build-deployment`
  runs, and `catalog-work` artifacts.
- **Headers.** Anonymous `curl -I` of `catalog/metadata/timestamp.json`,
  `updates/preview/latest.json` and `catalog/browse/index.html`.
- **Documentation.** Read anonymously on 2026-11-23, from the pages cited in
  2.3.
- **Derived figures.** Frozen-history and due-date figures use 66.97 MB on
  2026-11-23, 6.8 MB a day before the cutover, and 23–28 MB a day after it.
