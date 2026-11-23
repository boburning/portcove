# Publication hosting without history growth (design, November 23, 2026)

Proposed design, revision 1. Nothing here is implemented or activated, and no
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
Actions"), composed from the previous deployed generation, with a tiny pointer
branch as the serialization point. Freeze `gh-pages`.**

1. The served site stops being a Git branch. Every publication builds the
   complete site as a directory and deploys it with `actions/upload-pages-artifact`
   and `actions/deploy-pages`. No Git history accumulates for served bytes.
2. Each deployed site is a **generation**: a canonical manifest of every file
   (path, length, SHA-256) whose SHA-256 is the generation ID. The generation's
   files are retained as a 90-day Actions artifact. That artifact is the next
   publisher's prior state, the audit and replay evidence, and the rollback
   source.
3. A `pages-state` branch holds one small file, `current.json`, naming the
   current generation, its artifact and its predecessor. Publishers advance it
   by an ordinary fast-forward push, which is the compare-and-swap that orders
   the catalog and application-feed publishers. It grows by about 0.85 KiB a
   publication (section 4.4), so it never needs compaction.
4. Pins become **generation pins**. A pinned generation is copied from its
   artifact into its own prerelease asset, which does not expire.
5. Client URLs, formats, signing roles, keys, delegations, expiry, floors and
   withdrawals are unchanged. No new reader generation is needed.

**Resulting owner maintenance frequency: none recurring.** The owner acts once:
approve the publication-authority change, change the Pages source, restrict
the `github-pages` environment to `main`, protect `pages-state`, and freeze
`gh-pages` (section 6). After that, monitoring replaces maintenance (section 8).

**Deadline.** Until this lands, the adopted plan stands: compact-only cutover,
body window, and one owner compaction if it falls due. If the cutover happens on
2026-11-30, the first compaction falls due between **2027-02-10 and
2027-02-26** (section 9). Landing the source change before 2027-02-10 means O3
is never performed. Aim for the source change by **2027-01-27**, which leaves a
two-week probation before the earliest due date.

## 1. Constraints and how the recommendation meets each

| Constraint                                                           | Recommendation                                                                                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| $0; GitHub only; no new infrastructure or paid service               | Pages, Actions artifacts and releases in this public repository. Standard runners are free for public repositories; the repository already retains about 2.5 GB of 90-day artifacts (section 2.4). |
| Trust model unchanged                                                | Nothing signed changes. The composer moves bytes the signers already produced. TUF verification, floors, expiry and withdrawals work as today.                                                     |
| Signing roles, keys, bootstrap and root rotation untouched           | Untouched. The signing jobs and their environments do not change.                                                                                                                                  |
| Fixed client base URLs under `https://boburning.github.io/portcove/` | Same origin and paths. Only the mechanism that puts bytes there changes.                                                                                                                           |
| Unattended publisher                                                 | Producers compose, advance the pointer and deploy without human steps. An hourly reconciler redeploys the pointer head if a deployment was lost.                                                   |
| Restore from a pinned last-good publication                          | Generation pins in prerelease assets; restore extracts the pinned files and renews forward (section 5.6).                                                                                          |
| Audit and replay evidence for the supported window                   | Every generation's exact files for 90 days (the public-repository maximum), the pointer chain for all time, and pins indefinitely.                                                                 |
| Playing an installed game never depends on this                      | Unchanged: launch reads only retained local contracts.                                                                                                                                             |
| No recurring manual repair                                           | No branch accumulates served bytes. The only Git growth is the pointer chain, about 3 MiB a year.                                                                                                  |

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

Readers of the branch itself, not the served site:

- `catalog-publish.yml` `prepare` reads the prior catalog from a `gh-pages`
  worktree, and the late readback compares a catalog commit with its parent.
- `publish` restores `PRIOR_COMMIT` for segmented history.
- [`catalog-released-reader.mts`](../../scripts/catalog-released-reader.mts)
  selects the Preview reader from `updates/preview/latest.json` and
  `updates/withdrawn.json` at `refs/remotes/origin/gh-pages`.
- The PR 1 pin store (#8631) names `gh-pages` commits.

The held [`application-release.yml`](../../.github/workflows/application-release.yml)
controller already targets a workflow-built site: its `feed` job runs in the
`github-pages` environment with `pages: write` and `id-token: write`, and its
site tooling expects `build_type: workflow`, complete-site generations and a
6,000-file / 256 MiB site bound. It is not active. This design is compatible
with it (section 7.3).

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

The windowed tree matches #8631's measured 31,088,351 bytes (which includes
the ledger). After the compact-only cutover the window holds two compact
bodies (about 6.9 MB, already gzip) plus the newest legacy body, so a
generation archive is about **9–11 MB** compressed and about 25–38 MB raw.

**Branch builds already deploy artifacts.** Each push to `gh-pages` today runs
GitHub's built-in `pages-build-deployment` workflow, which packages the whole
tree and deploys it to the `github-pages` environment. The served-side behavior
of option A (whole-site artifact, Fastly with a 600-second cache) is therefore
the behavior clients see today. What changes is who builds the artifact and that
no branch sits in front of it.

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
| "The default environment is `github-pages`." Recommends a deployment protection rule "so that only the default branch can deploy".                                     | same, and [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)                                                                                                                                                           |
| The artifact is a gzip of a single tar, "must be under 10GB", "should not contain any symbolic or hard links".                                                         | [Using custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages); [upload-pages-artifact](https://github.com/actions/upload-pages-artifact) ("we recommend under 1 GB")                                                                                         |
| `upload-pages-artifact` `retention-days` default 1; `deploy-pages` `timeout` default 600,000 ms.                                                                       | [upload-pages-artifact](https://github.com/actions/upload-pages-artifact), [deploy-pages](https://github.com/actions/deploy-pages)                                                                                                                                                                                                   |
| GitHub's starter Pages workflow uses `concurrency: group: "pages"`, `cancel-in-progress: false`, "skipping runs queued between the run in-progress and latest queued". | [starter-workflows `pages/static.yml`](https://github.com/actions/starter-workflows/blob/main/pages/static.yml)                                                                                                                                                                                                                      |
| Artifacts and logs are retained 90 days by default; public repositories may set 1–90 days. `retention-days` cannot exceed that.                                        | [Configuring the retention period](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization); [Storing workflow data as artifacts](https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts) |
| "GitHub Actions usage is free for standard GitHub-hosted runners in public repositories". Downloading artifacts needs read access.                                     | [Usage limits, billing and administration](https://docs.github.com/en/actions/learn-github-actions/usage-limits-billing-and-administration); [Downloading workflow artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)                                                           |
| Release files "must be under 2 GiB"; "Up to 1000 release assets" per release; "no limit on the total size of a release, nor bandwidth usage".                          | [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)                                                                                                                                                                                                                                |
| Immutable releases: assets "cannot be modified or deleted"; deleting the release frees the tag, which "you cannot reuse".                                              | [Immutable releases](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)                                                                                                                                                                                     |
| Repositories "ideally less than 1 GB, and less than 5 GB is strongly recommended"; Git blocks files over 100 MiB.                                                      | [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)                                                                                                                                                                                           |
| Git LFS on GitHub Free: 10 GiB storage and 10 GiB bandwidth a month; no public-repository exemption stated.                                                            | [About billing for Git LFS](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage)                                                                                                                                              |
| Ruleset bypass actors are roles, teams or GitHub Apps.                                                                                                                 | [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)                                                                                                                                                                                        |

**Not stated, so UNKNOWN:**

- Whether a deployment replaces the served site atomically. Observed: one
  `Last-Modified` across files of a deployment. The rehearsal (T-ATOMIC) settles
  it for Actions-source deployments.
- Whether a failed or timed-out deployment leaves the previous one serving.
  T-INTERRUPT settles it.
- Any rate limit on Actions-source deployments. Today's peak is about 10 a day.
- Whether public-repository artifact storage counts toward Free's 500 MB
  storage quota. The repository's 2.49 GB of retained `catalog-work`
  artifacts, without a storage failure, is evidence that it does not. Settled
  by the owner's billing page.
- Anonymous release-asset download rate limits, and whether Pages serves Git
  LFS content.
- Whether this repository has immutable releases enabled. The pin design works
  either way (section 5.6).

### 2.4 Growth today and under the adopted plan

From the adopted design (2.2, 6.6) and #8631:

| Delivery state                     | `gh-pages` packed growth a day | Days to the 2 GiB compaction trigger |
| ---------------------------------- | ------------------------------ | ------------------------------------ |
| Today (legacy JSON bodies)         | 6.45–6.8 MB measured           | ≈310                                 |
| Compact-only cutover, 1×           | 23–28 MB                       | 75–91 from 64 MiB                    |
| Compact-only plus the stop-gap, 1× | 18–22 MB                       | 94–118                               |
| Chunked manifest, 1×               | ≈7.9 MB                        | ≈265                                 |

Even the best case, chunking plus stable browse output, only slows growth. The
2 GiB trigger is also already above GitHub's 1 GB recommendation for a Pages
source repository.

## 3. Options evaluated

### 3.A Artifact deployment (Pages source "GitHub Actions")

Section 4 works out the details. In brief:

- **History:** none for served bytes. The pointer chain grows by about
  0.85 KiB a publication.
- **Trust:** unchanged. **Publication authority narrows:** today any repository
  writer can push `gh-pages`, and Pages serves it. After the change, only a
  workflow job running from `main` in the `github-pages` environment with
  `pages: write` and `id-token: write` can deploy.
- **Recovery:** every generation for 90 days, pins indefinitely, and the
  pointer chain for all time.
- **Operations:** no recurring owner action. The build-rate soft limit does not
  apply.
- **Client URLs:** unchanged.
- **Cost:** about 25–38 MB uploaded per publication, as an Actions artifact
  and as the Pages artifact. A windowed site is under 4% of the 1 GB limit.

### 3.B Keep the branch and bound its history automatically

- **B1. The publisher force-pushes an orphan commit each run.**
  - Needs a standing ruleset bypass for force-pushes to `gh-pages`. Rulesets
    name roles, teams or GitHub Apps as bypass actors. Whether the
    `GITHUB_TOKEN` identity can be one is not documented (UNKNOWN). The
    documented route is a GitHub App or deploy-key credential held in a
    `main`-only environment: a new credential the owner must create and keep.
  - Any run that can reach that credential can erase the branch. History
    stops being evidence, and pins and audit still need storage elsewhere,
    which is option A's artifact and release machinery anyway.
  - It keeps branch builds and their 10-builds-an-hour soft limit.
  - Whether GitHub reclaims the unreachable objects promptly is UNKNOWN, so
    repository size may not fall when history is rewritten.
- **B2. A workflow compacts periodically.** Same standing grant, used less
  often, plus a `git bundle` archive (≤2 GiB as one release asset). It is O3
  automated, not removed.
- **Verdict:** rejected. B trades recurring manual compaction for a standing
  destructive authority and a new credential, and still needs A's storage for
  pins and audit.

### 3.C Bodies as release assets; metadata on Pages

- Removes the compact body's 17.3–22.2 MB a day from Git. `browse/` (about
  5.5 MB a day) and metadata stay on the branch, so the 2 GiB trigger moves to
  about 370 days. It is still recurring.
- Needs a new reader generation: a second targets base URL, and following the
  redirect from `github.com/.../releases/download/...` to the asset host. Core's
  transport follows no redirects today.
- TUF verifies the bytes wherever they come from, so trust holds.
- A release holds at most 1,000 assets, so a rotation scheme is needed.
  Immutable releases forbid deleting assets. Anonymous download rate limits are
  not documented (UNKNOWN).
- **Verdict:** rejected as the history answer. It stays in reserve as the
  **bandwidth** answer: release downloads have no documented bandwidth limit,
  while Pages has a soft 100 GB a month (about 970 daily clients at 3.45 MB).

### 3.D Chunked content addressing

Already designed as phase 2. It cuts compact Git growth to about 2.4 MB a day,
for a total of about 7.9 MB a day. The trigger moves to about 265 days, so it
slows growth without removing it. Under option A, chunking is justified only
by client transfer, bandwidth and carrier bounds (section 7.2).

### 3.E Other GitHub-native options

- **A separate public repository as the site.** The URL changes to
  `boburning.github.io/<other>/`, which needs a new reader generation. It either
  keeps a growing branch or uses artifact deployment, which is A with more
  moving parts. GitHub has no policy that disables a branch's history.
  Rejected.
- **Git LFS.** It is not $0 at this scale. Free covers 10 GiB of storage and
  10 GiB of bandwidth a month, with no public-repository exemption stated.
  About 3,000 client refreshes of a 3.45 MB body exhaust the bandwidth, and
  storage still grows with every version. Whether Pages serves LFS objects is
  not documented. Rejected.
- **GitHub Packages (OCI).** It needs a new protocol, an anonymous-token
  exchange and a new reader. Rejected.
- **A history-free pointer ref**, force-updated with `--force-with-lease` in a
  namespace outside branch rulesets. It would give zero growth but no audit
  chain, and its protection is unclear. Rejected in favor of the
  fast-forward `pages-state` branch, whose growth is negligible.

### 3.F Summary

| Option                      | Served-byte Git growth          | Recurring owner action      | New authority or credential                      | Client change        |
| --------------------------- | ------------------------------- | --------------------------- | ------------------------------------------------ | -------------------- |
| Adopted plan (O3)           | 23–28 MB a day                  | Compaction every 75–91 days | Force-push exception each time                   | None                 |
| **A. Artifact deployment**  | **None; pointer ≈3 MiB a year** | **None**                    | Deploy from `main` only: **narrower** than today | **None**             |
| B1/B2. Automated force-push | Bounded                         | None                        | Standing destructive bypass and a new credential | None                 |
| C. Bodies as release assets | ≈5.5 MB a day                   | Compaction about yearly     | None                                             | New reader           |
| D. Chunking alone           | ≈7.9 MB a day                   | Compaction every ≈265 days  | None                                             | New reader (phase 2) |
| E. Other                    | Varies                          | Varies                      | URL change, paid quota or new protocol           | New reader           |

## 4. Target architecture

### 4.1 Components and file ownership

The site is one tree composed from components. Each path has exactly one owner,
and a producer may change only its own paths:

| Component | Paths                                                                              | Producers                                                 |
| --------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `catalog` | `catalog/**` (metadata, targets, `browse/`, `catalog-history/`, `history-ledger/`) | `catalog-publish.yml`                                     |
| `updates` | `updates/**`                                                                       | `app-release-build.yml` feed step, `withdraw-release.yml` |
| `site`    | `README.md`, `.nojekyll`, `site-generation.json`                                   | the composer                                              |

The composer refuses a change outside the producer's component, any symlink or
hard link, a duplicate path, and a site over its bounds. The bounds are the
existing 900,000,000-byte Pages check and, while the held application
controller exists, its 6,000-file / 256 MiB site bound. Windowed, the site
measures 1,569 files and 31 MB.

### 4.2 Generation

A generation is the complete set of served files. Its manifest is canonical
JSON:

```json
{
  "schema_version": 1,
  "previous": "<generation id or null>",
  "components": {
    "catalog": {
      "inventory_sha256": "…",
      "producer_run": 0,
      "source_commit": "…"
    },
    "updates": {
      "inventory_sha256": "…",
      "producer_run": 0,
      "source_commit": "…"
    }
  },
  "files": [["catalog/metadata/timestamp.json", 618, "…"]]
}
```

- The **generation ID** is the SHA-256 of the canonical manifest.
- The **generation artifact** `site-generation-<id>` holds the manifest and
  every file, uploaded with `retention-days: 90`. It is 9–11 MB compressed at
  1× after the cutover.
- The served file `site-generation.json` holds `{generation, previous,
  components}` and the manifest digest. Readback and late readback use it in
  place of a commit SHA. The full manifest is also served, as
  `site-manifest.json`, about 206 KB, as a verifiable fallback for reading the
  prior site over HTTPS.

### 4.3 Pointer branch `pages-state`

`current.json` on `pages-state`:

```json
{
  "schema_version": 1,
  "generation": "<id>",
  "previous": "<id>",
  "artifact": { "run_id": 0, "artifact_id": 0, "sha256": "…", "bytes": 0 },
  "component": "catalog",
  "producer_run": 0,
  "source_commit": "<main commit>"
}
```

- **Compare-and-swap.** A producer commits a new `current.json` whose parent
  is the pointer commit it composed from, and pushes without force. A
  concurrent producer's push makes it non-fast-forward, so the loser re-reads
  the pointer and recomposes. That is the same 4-attempt loop as today, moved
  from `gh-pages` to `pages-state`.
- **Provenance check.** Before using a prior generation, the composer checks
  that its artifact came from a run of an allowlisted workflow path on `main`,
  through the Actions run API with `actions: read`, and that the artifact digest
  matches. A pointer pushed by hand to a branch-built artifact is refused.
  Every refusal fails closed and stops publication, as a stale prior does
  today.
- **Growth.** Section 4.4.

### 4.4 Measured history growth of the pointer branch

- **A full manifest on the branch** (rejected). I committed each of the 74
  historical `gh-pages` trees' manifests (1,614 lines, 206,535 bytes) to a
  scratch repository. That packed to 2.60 MiB, about **35 KiB a publication**.
  Nearly every `browse/` file changes each publication. At 10 publications a
  day it would reach 2 GiB in about 16 years: slow, but unbounded and
  pointless.
- **Pointer only** (chosen). 2,000 simulated commits of a `current.json` with
  fresh random digests on every commit, the worst case for delta compression,
  packed to 1,690 KiB, about **0.85 KiB a publication**. At 10
  a day that is about 3 MiB a year, and 2 GiB is about
  680 years away. Nothing ever needs compaction. The per-run report
  still records the packed size (section 8).

### 4.5 One publication

```text
producer job (contents: write, actions: read)
  1. read pointer P on pages-state (shallow)
  2. download P's generation artifact; verify artifact digest, manifest id, provenance
  3. apply this component's change (today's overlay logic, the body window, the ledger)
  4. compute manifest -> generation G; refuse bounds, links, foreign paths
  5. upload artifact site-generation-G (retention 90 days)
  6. commit current.json (parent P) and push without force; on rejection go to 1
deploy job: reusable pages-deploy.yml (pages: write, id-token: write,
            environment github-pages, concurrency group "pages")
  7. read the pointer head H (>= G); download and verify H
  8. actions/upload-pages-artifact (H's files) then actions/deploy-pages
  9. read back site-generation.json == H, plus the producer's own readback
```

- **Deploy the head, not your own generation.** Every deploy job deploys the
  pointer head as it reads it at start. Deploy jobs serialize in the `pages`
  group, and each starts after its producer's push. So the last deployment is
  always at or after the newest pointer. An older generation never overwrites
  a newer one.
- **Pending replacement is harmless.** GitHub may drop a pending deploy job
  when a newer one queues, as its starter workflow notes. The newer job deploys
  a head that contains the dropped job's generation. The producer's readback
  accepts any served generation that has its own generation in its `previous`
  chain and carries its component inventory.
- **Hourly reconciler.** `pages-deploy.yml` also runs on a schedule. If the
  served `site-generation.json` differs from the pointer head for more than one
  run, it deploys the head. A lost deployment heals without a person.

### 4.6 Atomicity, partial failure and caches

| Failure point                              | State left                                         | Recovery                                                                                |
| ------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Before step 5                              | Nothing durable                                    | The next run starts clean                                                               |
| Artifact uploaded, pointer push lost       | An orphan artifact                                 | It expires after 90 days; it is never deployed                                          |
| Pointer pushed, deploy failed or cancelled | Pointer ahead of the served site                   | The next deploy job or the hourly reconciler deploys the head; the report flags the lag |
| Deploy timed out (10 min)                  | Previous deployment serving (UNKNOWN; T-INTERRUPT) | Same as above                                                                           |
| Deployed, readback failed                  | As today                                           | Late readback on the next schedule; the existing warning                                |

- **Within a deployment.** Observed today, all files change together.
- **At the CDN.** Each URL is cached for 600 seconds, as today. Only
  `timestamp.json` is mutable; versioned metadata and content-addressed targets
  get new names. A client holding a cached timestamp can still find the
  previous body, because the window keeps it. Two publications less than 600
  seconds apart could prune a body that a two-generation-old cached timestamp
  names. The client then gets a 404 and keeps its verified state until the next
  refresh. That is the same as the body window on `gh-pages`.

### 4.7 Prior state, readers and readback

| Need                                           | Today                                       | After                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Catalog `prepare` prior (`PRIOR=site/catalog`) | `gh-pages` worktree                         | `catalog/` from the pointer head's generation artifact                                                                             |
| `PRIOR_COMMIT` for segmented history           | `gh-pages` commit, `--depth=1` fetch        | `PRIOR_GENERATION`: the artifact of that generation                                                                                |
| Feed and withdrawal producers                  | `gh-pages` worktree                         | `updates/` from the pointer head                                                                                                   |
| Released-reader selection                      | `updates/preview/latest.json` at `gh-pages` | The same files from the pointer head's verified generation                                                                         |
| Publish readback                               | Timestamp and browse digests                | Unchanged, plus `site-generation.json`                                                                                             |
| Late readback                                  | Catalog commit and its parent (`--depth=8`) | The previous catalog generation from the pointer chain; no depth limit is needed                                                   |
| Fallback when an artifact has expired          | —                                           | Fetch `site-manifest.json` and each file over HTTPS with cache-busting, verified against the pointer's manifest digest; else a pin |

The artifact path costs no Pages bandwidth. The HTTPS fallback costs about
31 MB a read, so it is a fallback only. An artifact can expire only if
nothing publishes for 90 days, and the catalog renews twice a day.

### 4.8 Permissions and publication authority

| Job                                | Today                         | After                                                                                            |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Catalog `publish`                  | `contents: write`             | `contents: write` (pointer and pin releases), `actions: read`                                    |
| Feed step, withdrawal              | `contents: write`             | Same as catalog `publish`                                                                        |
| `pages-deploy.yml` (new, reusable) | —                             | `contents: read`, `actions: read`, `pages: write`, `id-token: write`; environment `github-pages` |
| Built-in `pages-build-deployment`  | Runs on every `gh-pages` push | Stops                                                                                            |

**Who can publish, before and after:**

- **Before.** Any repository writer can push `gh-pages`, and Pages serves it.
  RELEASING already records this.
- **After.** Only a job running from `main` in the `github-pages` environment
  can deploy. `main` changes only through reviewed, merged pull requests. A
  writer can still push `pages-state` or upload an artifact from a branch run.
  The provenance check refuses those, so the most a writer can do is stop
  publication, which they can already do today.

This is a change to publication authority, so the owner approves it (section 6).
Signing authority does not change.

## 5. Migration

### 5.1 Sequence

| Step | What                                                                                                                                                                                                                                                                                                                | Authority                                            | Rehearsal                                                                                                                                           | Rollback                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| M0   | Composer library and `pages-deploy.yml` as inert code. The manifest, generation, provenance, CAS and readback logic, with T-SIM, T-CONCURRENT, T-INTERRUPT and T-RESTORE against a local bare remote and a fake deploy.                                                                                             | Lead: ordinary reviewed PR                           | Offline tests                                                                                                                                       | Revert                                                                                 |
| M1   | **Shadow mode.** Each of the three producers also composes a generation, uploads the artifact and advances `pages-state`, then pushes `gh-pages` as today. A parity check requires the generation's files to equal the `gh-pages` tree byte for byte. No Pages permission is added yet.                             | Lead: reviewed PR                                    | At least 14 days and 100 publications of parity in production; T-READER parity                                                                      | Revert; `pages-state` is ignored                                                       |
| M2   | Add the deploy job: `pages: write`, `id-token: write`, environment `github-pages`. It is gated on the Pages API reporting `build_type: workflow`, and is a no-op while the source is the branch. Switch released-reader selection and late readback to the pointer, with the `gh-pages` read kept as a cross-check. | **Owner approves the merge** (publication authority) | T-ATOMIC, T-FLIP and T-CLIENT on a scratch public repository, if the owner provides one; otherwise the first production deployment is the rehearsal | Revert                                                                                 |
| M3   | **Owner:** set the `github-pages` environment to `main` only; protect `pages-state`; change the Pages source to "GitHub Actions" (section 6).                                                                                                                                                                       | **Owner**                                            | The first deployment is read back; `site-generation.json` equals the pointer                                                                        | Switch the source back to `gh-pages`, which is still current (M1)                      |
| M4   | **Probation, 14 days.** Producers keep pushing `gh-pages`, so a source flip back loses nothing. The report shows deployments, lag and parity.                                                                                                                                                                       | Lead                                                 | Live                                                                                                                                                | Owner flips back                                                                       |
| M5   | Stop writing `gh-pages`. Remove the shadow push, the depth fetches and the `gh-pages` cross-checks. Pins switch to generation pins.                                                                                                                                                                                 | Lead: reviewed PR                                    | One week with no `gh-pages` writes                                                                                                                  | Revert, then the owner flips the source back; `gh-pages` resumes from the pointer head |
| M6   | **Owner, once:** freeze `gh-pages` (section 6, O-H4).                                                                                                                                                                                                                                                               | **Owner**                                            | —                                                                                                                                                   | Lift the rule                                                                          |

M0 and M1 can start as soon as #8631 merges. They touch only the overlay's
caller and the push step. Neither waits on the compact cutover.

### 5.2 What happens to the existing `gh-pages` history

At M6 the branch stops changing. Its history is then fixed, at about 66 MB plus
growth until M5 (section 9). It never needs compaction, because nothing adds to
it. The owner chooses one of these:

- **Keep it frozen (recommended).** No force-push and no exception. It stays
  readable evidence of every pre-migration publication.
- **Archive, then delete.** `git bundle create` of the branch, uploaded as one
  release asset (≤2 GiB, about 0.1–0.6 GiB depending on M5's date), then the
  branch is deleted. This frees repository size and still needs no force-push.

Pins created on `gh-pages` commits before M5 stay restorable from the frozen
branch or the bundle.

### 5.3 Interaction with #8619 (compact-only cutover)

- **Stays unchanged.** The cutover, the minimum supported preview (Preview 14),
  the static legacy target and the released-reader gate.
- **What changes.** The cutover's one bad consequence for hosting, about
  2.58 MB of Git history per change, lasts only until M5. After that a compact
  change costs one generation artifact (90-day retention) and nothing
  permanent.

### 5.4 Interaction with #8631 (window, ledger, pins)

| Part of #8631                   | Under this design                                                                                                                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body window                     | **Still required.** Every generation is a complete site, so the window sets each artifact's size (31 MB, not 405 MB) and keeps the site far below 1 GB. It also bounds the prior that signers verify.                                                                                                     |
| Listing-floor ledger            | **Still required.** It is what lets verification skip pruned bodies. It moves with `catalog/` into each generation. Its integrity improves: a served ledger can change only through a `main` deployment, not a direct push. Binding its digest in signed metadata (H1) is still the cryptographic answer. |
| Pin store                       | **Changes form.** Entries name a generation ID and its pin release, not a `gh-pages` commit (5.6). `catalog-publication-pins.mts verify` reads the pin release, not a full clone.                                                                                                                         |
| Manual restore runbook          | **Changes source.** `git checkout P -- <path>` becomes extracting `<path>` from the pinned generation. The rest is unchanged: verify, publish normally, renew forward.                                                                                                                                    |
| `--depth=1` / `--depth=8` fetch | **Becomes unnecessary** at M5. Nothing reads `gh-pages`.                                                                                                                                                                                                                                                  |
| Per-run retention report        | **Stays,** extended with the fields in section 8.                                                                                                                                                                                                                                                         |
| O3 compaction                   | **Retired** if M3 lands before the due date (section 9). No compaction projection is needed after M5.                                                                                                                                                                                                     |

### 5.5 Interaction with the adopted design's later phases

- **History checkpoints (H1, H2, O1).** Unchanged in substance. Checkpoint
  objects live under `catalog-history/` in each generation. `restore-publication
  --pin` reads a pinned generation instead of a pinned tree.
- **Phase 2 chunking.** Its Git-history trigger (a compaction interval under 60
  days) no longer exists. The remaining triggers are client transfer, Pages'
  100 GB soft bandwidth, and the carrier's 70% bound.
- **`browse/` stability.** No longer a history concern; still worth doing for
  artifact size and client transfer.

### 5.6 Pins, restore and rollback without commits

- **A pin is a generation.** The pin store (at most 8, changed by reviewed PR)
  lists `{generation, reason}`. On the next run after a pin is added, the
  publisher copies that generation's artifact into a prerelease
  `pages-pin-<first 16 hex of the generation>` with `make_latest: false`. The
  asset is named by the generation ID. The pin must be added within 90 days of
  its generation, while the artifact exists; last-good pins are normally hours
  old.
- **Verification.** Asset SHA-256, then the manifest digest equals the
  generation ID, then `verify-definition-repository` on its `catalog/`.
- **Cost.** At most 8 × 9–11 MB, under 100 MB.
- **Unpinning.** The publisher deletes the release. Immutable releases allow
  deleting a release, though not reusing its tag; tags are content-addressed,
  so none is reused. Release-inventory consumers (`listReleases` in
  `app-release.mts`, used by withdrawal) must ignore the `pages-pin-` prefix,
  and M5 adds a test for it.
- **Restore from a pin.** Extract the pinned content-addressed bodies into the
  next composition, verify, publish normally, then dispatch an ordinary renewal,
  which publishes higher versions. Lead authority, as today.
- **Rollback of a bad deployment.**
  - `updates/` or `browse/` broken: compose a new generation that restores that
    component's files from the last good generation.
  - Catalog: always forward. Never re-point at an older catalog, because
    clients that saw newer metadata refuse older versions. The publisher plans
    the next versions above the highest in the pointer chain, so even a bad
    generation's versions are exceeded.
  - Whole site unusable (for example a composer bug): push a pointer to the
    last good generation, deploy it, then renew the catalog forward.

## 6. Owner actions

Each is one-time. None recurs.

| ID       | Exact action                                                                                                                                                                                                                                                                             | Consequence in plain language                                                                                                                                                                          | Undo                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **O-H1** | Approve the merge of M2, which grants the reusable `pages-deploy.yml` job `pages: write` and `id-token: write` in the `github-pages` environment.                                                                                                                                        | Workflow code on `main` gains the ability to publish the website. It replaces the current route, in which anyone with write access can push `gh-pages`. Nothing is signed differently.                 | Revert the PR                                                               |
| **O-H2** | Settings → Environments → `github-pages` → Deployment branches and tags → **Selected branches and tags: `main` only**. Remove any `gh-pages` entry after M3. Keep "Allow administrators to bypass" off. Reconcile with the held application controller's tag rule, if one is configured. | Only workflows running from `main` can deploy the site. A branch or a pull request cannot.                                                                                                             | Edit the rule                                                               |
| **O-H3** | Settings → Rules → new branch ruleset for `pages-state`: **block force pushes** and **restrict deletions**. No bypass list.                                                                                                                                                              | The pointer history cannot be rewritten or removed. Publishers still advance it by normal pushes.                                                                                                      | Disable the ruleset                                                         |
| **O-H4** | Settings → Pages → Build and deployment → Source: change **"Deploy from a branch" (`gh-pages`) to "GitHub Actions"**. Do it at M3.                                                                                                                                                       | Pushes to `gh-pages` stop publishing. The site keeps serving the last branch deployment until the first workflow deployment, usually within the hour. The 10-builds-an-hour soft limit stops applying. | Switch back to `gh-pages` / root; complete while M1's shadow push continues |
| **O-H5** | After M5, choose: freeze `gh-pages` with a ruleset that **restricts updates** (recommended), or archive it as a `git bundle` release asset and delete the branch.                                                                                                                        | The old history stops changing, or is moved to one archive file. No force-push, ever.                                                                                                                  | Lift the rule; push the bundle back to a branch                             |

No ruleset bypass, new secret, credential, signing role or key is needed.

**Lead under existing delegation:** M0, M1, M5, the code half of M2 (review,
CI, then the owner's merge approval), probation monitoring, pin-store PRs,
restores, and component rollbacks.

The current `github-pages` environment policy is UNKNOWN to this design,
because the API path was not readable here. The owner settles it by opening
the environment settings.

## 7. Compatibility

### 7.1 Clients

Same URLs, bytes and formats, so every released reader is unaffected: Preview
13's static legacy target, Preview 14 and later's compact target, the updater
feeds and the browse pages. The minimum supported generation from #8619 is
unchanged. Installed data is untouched.

### 7.2 Publisher behavior that stays

Compact-only delivery, the released-reader gate, the body window, the ledger,
history checkpoints, signing jobs and environments, the triggers and schedule,
`unchanged` and `renewal-due` decisions, readback receipts and their seven-day
artifacts.

### 7.3 Held application controller

The held controller already assumes `build_type: workflow`, one composer of a
complete site, and generation markers. M2 must not change its inert files. When
that controller activates, it becomes the `updates` producer through the same
composer and pointer, or it replaces the composer as the sole Pages writer
under its own reviewed change. Either way, the 6,000-file / 256 MiB bound
holds: the windowed site is 1,569 files and 31 MB.

## 8. Operations: what replaces owner maintenance

There is no recurring owner action. Each run's report, in the log, the step
summary and the existing receipt, records:

- the pointer head, the served generation, and the lag between them;
- the site's files and bytes against 900,000,000 bytes, 256 MiB, 6,000 files and
  1 GB;
- the generation artifact's bytes, deploy duration and retries;
- the `pages-state` packed size and the projected years to 1 GiB;
- the number of pins, their release bytes, and the oldest unpinned generation
  still within 90 days;
- the ledger and window fields from #8631.

**Failure signals** use the existing ones: a failed workflow notifies the
repository's watchers.

- The reconciler fails when the served generation lags the head for more than
  two hours.
- The report warns at 70% of any bound.
- A provenance or CAS refusal fails the run.

**Lead upkeep** is ordinary issue work when a warning appears. No setting,
force-push or exception is part of it.

## 9. Interim and deadline

Until M3 lands, the adopted plan stands unchanged: the #8619 cutover, the
#8631 window (activated within about a week of the cutover), and O3 if it
falls due.

**When O3 would fall due.** History is 63.87 MiB (66.97 MB) on 2026-11-23 and
grows by about 6.8 MB a day until the cutover. After the cutover it grows by
23–28 MB a day (18–22 with the stop-gap). The trigger is 2 GiB (2,147.5 MB).
For a cutover `d` days after 2026-11-23:

```text
days after cutover until O3 = (2147.5 - 66.97 - 6.8·d) / rate
```

| Cutover               | History at cutover | Due at 28 MB/day | Due at 23 MB/day | With stop-gap (22–18)   |
| --------------------- | ------------------ | ---------------- | ---------------- | ----------------------- |
| 2026-11-30 (`d` = 7)  | ≈115 MB            | **2027-02-10**   | 2027-02-26       | 2027-03-02 – 2027-03-23 |
| 2026-12-07 (`d` = 14) | ≈162 MB            | 2027-02-15       | 2027-03-03       | 2027-03-07 – 2027-03-27 |
| 2026-12-21 (`d` = 28) | ≈257 MB            | 2027-02-26       | 2027-03-13       | 2027-03-16 – 2027-04-05 |

**Deadline for the long-term change.** M3, the source change, should land at
least two weeks before the earliest due date, to leave room for M4 probation.
For a cutover on 2026-11-30, that means **M3 by 2027-01-27**. If M3 slips past
the due date, O3 is performed once under the adopted plan. M3 then still
removes every later compaction, and history stops at whatever size O3 left.

## 10. Test plan

| ID           | What                                                                                                                                                                                                                                                                | Where                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| T-SIM        | 5,000 simulated publications of both components through the composer. Assert deterministic generation IDs, window bounds, artifact size, and the `pages-state` packed size against the projection in 4.4.                                                           | M0, offline                          |
| T-CONCURRENT | Catalog and feed producers race on a local bare `pages-state`. Assert CAS retries, no lost files, and component isolation. Deploy jobs run out of order, and a pending deploy is dropped. Assert the final served generation is the head and contains both changes. | M0, offline                          |
| T-INTERRUPT  | Kill the run after each step in 4.5. Assert convergence through the next deploy or the reconciler, and that orphan artifacts are never deployed. In production rehearsal, cancel a `deploy-pages` mid-run and observe what is served.                               | M0 offline; M2 rehearsal             |
| T-RESTORE    | Pin a generation, delete its artifact, restore from the pin release, run `verify-definition-repository`, then plan a renewal. Assert versions exceed the pointer chain's maximum. Also restore a pre-migration `gh-pages` pin from the frozen branch.               | M0, M5                               |
| T-READER     | Released-reader selection from the pointer equals selection from `gh-pages`, for every M1 publication.                                                                                                                                                              | M1, production shadow                |
| T-PARITY     | Each shadow generation's files equal the `gh-pages` tree byte for byte.                                                                                                                                                                                             | M1, production shadow                |
| T-ATOMIC     | During an Actions-source deployment, poll 50 files at the origin with cache-busting queries. Assert no mixed generation at the origin, and measure the CDN window.                                                                                                  | M2, scratch repository               |
| T-FLIP       | Change the source from branch to Actions and back. Measure the serving gap and assert no 404 for the site's files.                                                                                                                                                  | M2, scratch repository               |
| T-CLIENT     | The released Preview 15 CLI runs `catalog listing-refresh` and `listing-status` repeatedly across a deployment and across two deployments inside 600 seconds. Assert verified success or a clean keep-last-verified, never a lowered revision.                      | M2 scratch repository; M3 production |
| T-PROVENANCE | A pointer to an artifact from a non-`main` run, or with a wrong digest, is refused before composition.                                                                                                                                                              | M0                                   |

The scratch repository rehearsal needs a throwaway public repository. Creating
one is the owner's choice. Without it, M3's first production deployment is the
rehearsal, protected by M1's shadow `gh-pages` and the O-H4 undo.

## 11. Open risks and UNKNOWNs

- **Atomic replacement and failed-deployment behavior** are not documented.
  T-ATOMIC and T-INTERRUPT settle them. Branch builds already rely on the same
  deployment mechanism.
- **Deployment rate limits** for Actions-source sites are not documented.
  Today's rate is about 10 a day. A 429 or a refusal fails the deploy job, and
  the reconciler retries.
- **Artifact storage billing** for public repositories is not stated. The
  evidence is 2.49 GB retained today without failure. The owner's billing page
  settles it. If it ever binds, generation retention drops from 90 days to 30,
  about 3 GB, and pins are unaffected.
- **The current `github-pages` environment policy** is UNKNOWN (O-H2).
- **Immutable releases** for this repository are UNKNOWN. Pin handling works
  either way.
- **Main repository size** against GitHub's 1 GB recommendation is UNKNOWN
  here, because the checkout is shallow. `gh-pages` alone is 64 MiB today.
- **Pages bandwidth** stays a soft 100 GB a month: about 970 daily clients at
  compact 1×. Option C (release assets) and phase 2 chunking are the answers
  if it binds. Client counts are UNKNOWN.

## Appendix: measurement method

- **`gh-pages`.** `git clone --bare --single-branch --branch gh-pages`, then
  `git count-objects -vH` and `git ls-tree -r -l HEAD` at `758583339`.
- **Archive sizes.** `git archive --format=tar HEAD`, piped through `gzip -6`.
  For the window, I extracted the tree and kept only the listing bodies named by
  policy versions 59 and 60 (`0d20ba97…` and `1cdce5cd…`). I then made a
  deterministic tar (`--sort=name --mtime=@0 --owner=0 --group=0
  --numeric-owner`) through `gzip -6`.
- **Manifest-on-branch growth.** For each of the 74 `gh-pages` commits in
  order, I committed a manifest of `blob-id(40 hex)+24 hex, length, path` per
  file to a scratch repository, then ran `git gc` and `git count-objects -v`.
- **Pointer growth.** 2,000 commits of a 476-byte `current.json` with fresh
  random digests each time, then `git gc`.
- **Deployments and artifacts.** Read-only listings of the repository's
  `github-pages` deployments, deployment statuses, `pages-build-deployment`
  runs, and `catalog-work` artifacts.
- **Headers.** Anonymous `curl -I` of `catalog/metadata/timestamp.json`,
  `updates/preview/latest.json` and `catalog/browse/index.html`.
- **Documentation.** Read anonymously on 2026-11-23, from the pages cited in
  2.3.
