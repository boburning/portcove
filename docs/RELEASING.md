# Releasing Portcove

## Current release process

The owner set this process on [#534](https://github.com/boburning/portcove/issues/534#issuecomment-6864263340)
on 2026-11-13. It replaces the unattended release engine recorded in the
[historical runbook](archive/retired-release-engine.md).
Releases do not depend on AI review.

A `v*` tag on protected `main` is the release decision. Only the owner or an
agent acting through the owner's account can create `v*` tags.
[`app-release.yml`](../.github/workflows/app-release.yml) classifies the tag and
confirms that the commit is on `main` and that its `CI` run succeeded. It then
calls the shared jobs in
[`app-release-build.yml`](../.github/workflows/app-release-build.yml), which:

1. Refuse inputs that disagree with the version's channel, tag or signing
   environment.
2. Read the [application release profile](../scripts/app-release.mts) at the
   selected source commit. Stamp the version, then build the Windows NSIS installer, Linux AppImage,
   and universal macOS app and DMG. Sign the updater assets with the Tauri
   updater key. macOS builds are ad-hoc signed. Build and smoke-test standalone
   CLI archives from the same source and version for Windows x86-64, Linux
   x86-64, and both Apple Silicon and Intel macOS.
3. Check the complete asset set before publishing the immutable GitHub Release.
   Generate the download chooser from the same profile and the uploaded asset
   inventory when publishing the draft. Recheck the published inventory before
   writing the updater aliases from its signatures. `SHA256SUMS` covers the Desktop packages, updater payloads and
   signatures, and standalone CLI archives.
4. Write `latest.json` to `updates/<channel>/latest.json` on the `gh-pages`
   branch, which GitHub Pages serves. Older feeds are never overwritten by a
   lower version.

| Tag                       | Channel          | Feeds updated         | Approval                   |
| ------------------------- | ---------------- | --------------------- | -------------------------- |
| `vX.Y.Z-preview.N`        | Preview (opt-in) | preview               | none                       |
| `nightly-X.Y.Z-preview.N` | Preview (opt-in) | preview               | none; built from `main`    |
| `v0.Y.Z`                  | Beta (default)   | beta, preview         | none                       |
| `v1.Y.Z` and later        | Stable           | stable, beta, preview | owner, on `release-stable` |

Previews are pre-releases of the _next_ version, for example
`0.2.0-preview.1`. That keeps them above every earlier release in SemVer order.
`v*` and `nightly-*` tags name versions in the same sequence. Every new release
must be newer than both, so `0.1.0` can follow `nightly-0.1.0-preview.3`.

If your checkout matches the current `origin/main` and has no uncommitted
changes, run the release command:

```sh
PORTCOVE_RELEASE_NOTES_FILE=notes.md just release 0.1.1
```

The command requires a clean checkout of the exact `origin/main` commit. It also
requires a successful `CI` run on that commit. The version must be greater than
every existing `v*` and `nightly-*` release version. If these checks pass, the
command pushes an annotated tag. The tag message becomes the release notes.

If the owner asks an agent to "review and release X.Y.Z", the request authorizes
the release. Review changes since the last tag. Write the notes. Run the same
command. Only Stable waits for the owner's approval on the
`release-stable` environment.

**Before calling a Beta release supported** on a platform, record its install
evidence, an installed update from the previous version, and preserved saves on
the owning issue. macOS stays labelled experimental until someone confirms a
physical first launch through System Settings → Privacy & Security → Open Anyway.
Windows users see SmartScreen's "More info → Run anyway" step because the
installers have no Authenticode signature yet.

**Who can reach the updater key.** Both environments hold the same updater key,
because installed clients trust exactly one key. A run on a tag executes the
workflow file at the tagged commit, so the environments admit only refs whose
code is reviewed or owner-chosen. The `release` environment admits `v*` tags and
`main`. `release-stable` admits `v*` tags and also needs the owner's approval.
The `release` environment admits a run on `main` whatever event started it. So
the workflow-shape test in `scripts/app-release.test.mts` refuses any workflow
except `app-release-build.yml` that selects `release` or `release-stable`, any
caller of `app-release-build.yml` except `app-release.yml` and
`nightly-preview.yml`, and any external reusable workflow. It also requires the
signing job to restore no package cache. Both callers pass `secrets: inherit`,
because GitHub gives a called workflow its environment's secrets only when the
caller passes them.
The shared build references only the two signing secrets, in its signing step,
so the repository's other secrets never reach the build.
Rulesets let only the owner create `v*` tags, and no one can move or delete one.
Anyone with write access can create a `nightly-*` tag, but such a tag grants no
key access. Only the owner can move or delete one, and only a `nightly-*` tag
that names a preview version counts as an existing version, so a stray
`nightly-9.9.9` cannot block releases. The `release-stable` approval guards Stable against anything that is
not the owner or acting as the owner. It is not a boundary against the owner's
own account, which agents use.

For a preview, run `node scripts/app-release.mts next-preview` in a checkout
with up-to-date release tags to find the next available version. The first
preview tag already exists. If a publish
step fails after the GitHub Release exists, re-run the failed jobs. The publish
job continues only when the release's asset set is identical.

**Nightly previews.** [`nightly-preview.yml`](../.github/workflows/nightly-preview.yml)
runs daily at 05:37 UTC on `main` and can be started by hand on `main`. It walks
back up to 100 first-parent `main` commits and picks the newest one whose newest
`CI` push attempt succeeded. One API page covers up to 100 completed `main`
push runs. A second page covers up to 100 recent runs from the same workflow,
branch and event so a completed run can qualify before GitHub's status filter
returns it. The selector reconciles exact run and attempt identities. A conflict
or an unfinished attempt that supersedes an observed success stops selection
if the first-parent walk reaches that commit before finding an eligible one.
It does nothing when the newest `main` commit already carries a `v*` or
`nightly-*` tag, when it reaches a tagged commit before a CI-green one, or when
none of those commits is CI-green.
Otherwise it pushes one annotated `nightly-X.Y.Z-preview.N` tag at the chosen
commit with `GITHUB_TOKEN`. Then it builds,
signs and publishes exactly that commit through the shared jobs, in the
`release` environment, which admits the run because its ref is `main`. The
release and feed version is `X.Y.Z-preview.N`, and asset names carry only the
version.

- **Version:** a pre-release of the patch after the newest release, or of the
  chosen commit's `Cargo.toml` workspace version when that is higher or nothing has been
  released. N is one more than the highest existing `v*` or `nightly-*` preview
  of that version. `node scripts/app-release.mts next-preview` prints the
  version for the checked-out workspace, which is the nightly's version unless the
  chosen commit predates a workspace version bump.
- **Notes:** the tag message lists the commits since the previous `v*` or
  `nightly-*` tag. At signs are replaced so that subjects cannot mention anyone.
- **Tag integrity:** the publish job refuses a `nightly-*` tag that no longer
  points at the built commit. Publishing the immutable release locks the tag.
  Right before creating any release, the publish job refuses if another `v*` or
  `nightly-*` tag on the remote already names the same version, for example an
  owner tag pushed while a nightly was building.
- **Failures:** if a build or publish job fails, re-run the failed jobs. A full
  re-run skips the already tagged commit, and the next nightly with new commits
  takes the next N.

**Failed-nightly reporting.** [The failure reporter](../.github/workflows/nightly-failure-report.yml)
listens for completed Nightly preview runs independently of the build jobs.
A failure or cancellation creates a GitHub issue assigned to the repository
owner. It records the triggering attempt, workflow commit, job outcomes and
available failure evidence. Each further failed attempt adds one comment to
the same issue and reopens it if needed. The original report and manual
diagnosis stay in the issue body. GitHub delivers assignment notifications
according to the owner's notification settings.

Job outcomes link to the relevant logs and annotations. The report identifies
a known hosted-runner acquisition failure when GitHub supplies that annotation.
It reads metadata only and has no checkout, signing inputs or release write
permission. If job metadata is unavailable, the issue still records the run
and attempt. A successful attempt creates no failure report. Verify the
release assets and Preview feed before closing a failure issue.

**Withdrawing a release.** The owner runs
[`withdraw-release.yml`](../.github/workflows/withdraw-release.yml) from `main`
with a `version` such as `0.1.1` and an optional `replacement_note`. The job runs
only when the owner both started and re-ran it (`github.actor_id` and
`github.triggering_actor`). This check is a process guard, not a security
boundary. Repository writers can already edit releases and push `gh-pages`, and
they could run a changed copy of the workflow from a branch. The workflow:

1. Requires a published release of that version, tagged `v<version>` or
   `nightly-<version>`.
2. Adds the version to `updates/withdrawn.json` on `gh-pages`.
3. Repoints each feed that serves a withdrawn version to the newest published,
   non-withdrawn release that channel accepts (Preview: any; Beta: any
   non-pre-release; Stable: 1.0.0 and later). A candidate without all four
   updater signatures is skipped for the next older one. If no release
   qualifies, it deletes that feed.
4. Prefixes the release notes with "⚠️ Withdrawn — do not install." and the
   note. If the release was Latest, the newest non-withdrawn Beta or Stable
   release becomes Latest.

Tags, releases and assets are never deleted. The shared publish job never writes
a feed for a withdrawn version, so re-running a release cannot bring the version
back. Re-running the withdrawal is safe. Installed clients only update to a
version higher than their own. Clients already on a withdrawn version stay on it
until a fix release with a higher version ships.

**Updater key.** Minisign key ID `F92BD3EA87BB77B0` is held in the `release`
and `release-stable` environments, and the owner keeps an offline backup. If
the key is lost, installed clients cannot be updated. Never rotate it without a
transition release signed by the old key.

**Catalog publication.** [`catalog-publish.yml`](../.github/workflows/catalog-publish.yml)
signs the official catalog bundle in `release/catalog-publication/bundle` and
publishes the complete catalog TUF repository to `gh-pages/catalog/`. Installed
clients verify it against the root compiled into the app
(`crates/portcove-core/catalog/official-definition-root.json`). The owner
decided this on 2026-11-15 (#534), and there is no review gate.

- **Triggers:**
  - A green `CI` push on `main` publishes when the signed bundle inputs change,
    the [public browse inputs or renderer](PUBLIC-CATALOG.md) change, or the
    published timestamp expires within 12 hours. Unchanged inputs outside the
    renewal window skip publication.
  - The schedule (05:13 and 17:13 UTC) and a manual run always re-sign. This
    renews the timestamp, which lasts 1 day, and the snapshot, definitions and
    policy roles, which last 7 days.
  - Every trigger uses the same bounded CI run reads as nightly previews and
    selects the newest CI-green first-parent `main` commit. A rerun of an older
    CI run follows the current selection.
- **Readback receipt:** after the public timestamp and browse pages match, the
  same publisher can retain a seven-day receipt. It verifies the exact live
  index and the affected immutable targets, records previous and published
  hashes and revisions, and distinguishes definition changes and retained index
  rebinds from descriptive refresh and metadata renewal. A trigger identifies
  the producing workflow event. Human intervention and automatic repair need
  separate evidence. Missing or out-of-bound readback leaves no success receipt.
- **Recovery:** if renewals stop and the published timestamp expires, clients
  keep their last verified catalog. The next successful run publishes again,
  because the expired catalog is still read as authenticated history: its
  signatures, version floors and unchanging published files are checked, but its
  expiry is not. No manual step is needed.
- **Descriptive refresh:** While a signed complete observation is in the first
  half of its recorded freshness window, an equivalent completed provider check
  keeps the exact prior clocks and payload. The next applicable pass can renew
  the observation once half that window has elapsed. Authored guide changes,
  new release facts, and changes to the permitted freshness window bypass this
  deduplication. Existing incomplete collection and failure rules still apply.
- **Late Pages readback:** The existing twice-daily catalog schedule checks the
  previous commit from the pinned Pages branch before selecting the next
  publication source. A seven-day artifact identifies the earlier Pages commit,
  source commit and catalog tree, plus the run that observed them. An exact
  receipt requires the timestamp to match before and after reading active role
  metadata, affected immutable targets, browse samples and any new checkpoint
  objects. The observation records whether Pages still served the exact
  predecessor, reported a higher timestamp during readback, or returned
  incomplete evidence. These outcomes leave the publication unconfirmed and
  allow the next publication to continue. This readback grants no signing or
  publication authority.
- **Signing:**
  - `prepare` builds the CLI and release tools, inspects the bundle with Core,
    reads the published catalog and plans the next version of every online role.
    A first publication starts every role at 1.
  - Each of the definitions, policy, snapshot and timestamp roles is signed by
    [`catalog-sign-role.yml`](../.github/workflows/catalog-sign-role.yml).
    It runs in the role's own `production-catalog-*` environment, which admits
    only `main`, and the role's key reaches only one step. Before reading any
    key, it refuses a commit that is not on `main`.
  - `portcove-release-tools` re-verifies every input and refuses a key that is
    not the role's appointed key.
- **Publishing:** assembly uses no keys. The `publish` job refuses to push if
  `gh-pages/catalog/` changed since `prepare` read it, then reads the timestamp
  back from Pages.
- **Offline keys:** the root and Targets keys stay offline with the owner. The
  offline Targets (`release/bootstrap-public-inputs/catalog/offline-targets.json`)
  expire on 2027-01-30 and must be re-signed offline before then. Catalog
  publication stops while they are expired and resumes once a re-signed version
  is merged. Root v1 expires on 2027-10-30.

### Catalog listing-body window

[Design 6.1–6.2](design/CATALOG-DISTRIBUTION-SCALING.md#61-body-window-with-a-listing-floor-ledger-pr-1)
(#1422). The served catalog keeps every signed metadata version but, once
activated, only the listing bodies anyone can still need. Superseded bodies stay
in `gh-pages` Git history. `CATALOG_RETAIN_BODIES` at the top of
`catalog-publish.yml` selects the mode, and changing it is a reviewed change by
the lead (decision L2):

| Mode            | What a publication does                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `all` (default) | Exactly what it did before the window existed. Every body is served and read.                                                                                                                                                                                                                    |
| `ledger`        | Also serves `catalog/history-ledger/listing-floors.json`. The first run derives it from every retained body; later runs re-derive each entry whose body is served and append new ones. Nothing is pruned.                                                                                        |
| `window`        | Also prunes listing bodies from the served tree, keeping the current and previous body of each live carrier, the newest body of every listing target, the body the latest signed policy version names for every listing target, both publications' bodies and every pinned publication's bodies. |

- **Ledger.** One entry per distinct listing body: the first policy version
  naming it, its target, SHA-256 and length, and what history verification
  derives from it: revision, decoded SHA-256 and the withdrawal count and
  digest. Each entry must match a retained signed descriptor, and the ledger
  must extend the published one exactly. It is not signed. The newest body of
  each target, which sets every floor, is never pruned, and the verifier refuses
  a pruned body whose entry would sit above it. The verifier also requires, from
  its bytes, the body that the highest signed `official-policy` version naming
  each listing target names, even for a carrier that is no longer current
  (legacy after the compact cutover, compact after a legacy return). Signed
  data alone fixes which body that is, so a `gh-pages` writer without a signing
  key cannot delete it and lower its ledger entry to drop a floor.
- **Fail closed.** A body is pruned only when an earlier publication already
  served its ledger entry and this run re-verified it. Without a published
  ledger, with an unretained pin, with checkpointed history or with any
  mismatch, the run prunes nothing and says why. The publication itself
  continues. Before the publish commit, the run verifies the staged
  `site/catalog` history keylessly against the ledger it serves
  (`verify-definition-history`), so a divergence between the window and the
  verifier stops this run instead of the next one.
- **Report.** The publish step prints and summarizes the mode, ledger size,
  bodies kept and pruned, bytes freed, and the retained repository against its
  805,306,368-byte bound. The commit check prints the Pages tree against its
  900,000,000-byte bound.
- **Pins.** `release/catalog-publication-pins.json` names at most 8 last-good
  publications by `gh-pages` commit and policy version. Adding or removing one is
  an ordinary reviewed PR. Check pins with
  `node scripts/catalog-publication-pins.mts verify --repository <gh-pages clone>`.
- **Activation.** Run `ledger` first, then switch to `window` after a run
  publishes the ledger and the next run verifies it. The `window` run after that
  prunes. Turning the window off means `ledger`, then the full restore below,
  then `all`. After switching to `all`, the last ledger stays served unchanged;
  if `ledger` is enabled again, the next run extends that ledger (every served
  body re-derives its own entry), so run the divergence check in restore step 3
  first.
- **Activation precondition: an archived copy.** Before the first `window` run,
  the lead prepares a `git bundle` of the complete `gh-pages` history, verifies
  it and records its SHA-256 on #1422, ready for an owner release-asset upload
  through the existing release route (this change publishes nothing). Pruned
  bodies otherwise exist only in `gh-pages` history; the bundle is what makes a
  restore possible "from nothing" if that history is lost before the first
  compaction, which archives it anyway.

  ```sh
  git -C pages bundle create gh-pages-$(date -u +%Y%m%d).bundle refs/heads/gh-pages
  git -C pages bundle verify gh-pages-*.bundle && sha256sum gh-pages-*.bundle
  ```

- **History checkpoints after pruning.** A history-checkpoint bootstrap derives
  floors from every listing body, so it needs the full restore below first. The
  prepare step refuses a bootstrap while the served ledger names a body the
  served tree lacks: "catalog history bootstrap needs a full restore of the
  pruned listing bodies first".

**Restore from a pinned publication (lead).** Use this when a later run needs
a pruned body: a "file missing" refusal, turning the window off, or a pin added
after its bodies were pruned.

1. Clone `gh-pages` with its history into a scratch directory outside the
   checkout. Pins need their commits; the publisher's own fetch is shallow.

   ```sh
   git clone --single-branch --branch gh-pages https://github.com/boburning/portcove.git pages
   node scripts/catalog-publication-pins.mts verify --repository pages
   ```

2. Pick the pin `P`: the newest one whose readback receipt passed. The verify
   output lists the bodies its policy version names. To restore one
   publication, restore exactly those:

   ```sh
   git -C pages checkout "$P" -- catalog/targets/<sha256>.policy/official/catalog.listings.json
   ```

   A **full restore** (turning the window off, a history bootstrap, or any
   "file missing" refusal) must bring back every pruned listing body, including
   bodies first published after `P` and pruned later, which
   `git checkout "$P" -- catalog/targets` misses. Restore each deleted path from
   the parent of the commit that deleted it. Run this from the Portcove checkout
   as a script (`PAGES=<scratch clone> bash full-restore.sh`):

   ```sh
   set -euo pipefail
   named=$(mktemp) deletions=$(mktemp)
   node scripts/catalog-body-window.mts --catalog "$PAGES/catalog" --named > "$named"
   git -C "$PAGES" log --no-renames --diff-filter=D --name-only --format='C %H' \
     -- 'catalog/targets/*catalog.listings*' > "$deletions"
   commit=
   while IFS= read -r line; do
     case "$line" in
       "C "*) commit=${line#C } ;;
       "") ;;
       *)
         if ! grep -Fxq "${line#catalog/}" "$named"; then
           echo "not restored (no retained signed metadata names it): $line"
           continue
         fi
         git -C "$PAGES" checkout "$commit^" -- "$line"
         digest=${line#catalog/targets/}
         digest=${digest%%.*}
         if [ "$(sha256sum "$PAGES/$line" | cut -d' ' -f1)" != "$digest" ]; then
           echo "digest differs: $line"
           exit 1
         fi
         ;;
     esac
   done < "$deletions"
   ```

   - `--no-renames` is required: Git otherwise reports a pruned body and a new,
     similar body as one rename and hides the deletion.
   - The loop reads a file, not a pipe, so `exit 1` stops the script, and
     `pipefail` with `-e` stops it if `git log` or the filter fails.
   - Only paths that retained signed metadata names are restored
     (`--named` lists them), and each restored path's content digest must equal
     its name digest. `git checkout` of a content-addressed path cannot change
     bytes the current tree already serves.

3. Verify the history keylessly with `portcove-release-tools
   verify-definition-history <config>`. The config names `trusted_root`,
   `offline_targets`, their SHA-256 values,
   `"initial_root_profile": "single-owner-one-of-one-v1"`, `"repository":
   "pages/catalog"` and, unless every body is back, `"listing_floor_ledger":
   {"prior": "pages/catalog/history-ledger/listing-floors.json"}`. After a full
   restore, verify **without** a ledger: every body must verify from its bytes.
   The report must equal one from a complete tree except for its ledger
   counters.

   **Ledger divergence check (after a full restore, when a ledger is served).**
   Run the same config twice more, writing ledgers beside it:

   - with `"listing_floor_ledger": {"prior":
     "<PAGES>/catalog/history-ledger/listing-floors.json"},
     "listing_floor_ledger_output": "ledger-extended.json"`;
   - with `"listing_floor_ledger": {"prior": null},
     "listing_floor_ledger_output": "ledger-backfill.json"`.

   Require the first run to pass, its report to show `verified_from_ledger: 0`,
   and `cmp ledger-extended.json ledger-backfill.json` to succeed. The served
   file itself is not byte-compared with the backfill: each run derives the
   ledger it serves from the history before its own publication, so the served
   ledger normally lacks the newest publication's body. On any refusal or
   difference, `git -C "$PAGES" rm catalog/history-ledger/listing-floors.json`
   in the same restore commit; the next `ledger` or `window` run then backfills
   from every body.

4. Commit and push normally to `gh-pages`, never with force. Then dispatch an
   ordinary catalog publication run so the newest catalog commit is again a
   publisher commit; the late readback refuses a catalog tree changed outside a
   publication until then.
5. Record the pin, restored paths and verification reports on #1422.

**What clients observe.** Nothing, until the next publication. Clients read
only the bodies the current signed metadata names, and a restored body is named
only by older metadata versions. Revision floors never go backwards. A client
refuses a lower or equal role version, and a lower listing revision or an equal
one with different bytes. A restore therefore never re-serves old metadata or an
old listing as current. To return players to last-good content, revert the
source change on `main`. The next run publishes that content as a new listing
revision above the current floor, at higher role versions, and with every
withdrawal published since; the publisher refuses to drop one.

**Rehearsal, November 23, 2026 (offline, nothing pushed).** This used a scratch
worktree of `gh-pages` at `c912fc37b` (policy 60, 47 legacy bodies) and this
change's release tools:

- **Backfill.** History verification of the complete tree took 3.6 s. The
  backfilled ledger has 47 entries and 21,226 bytes. Every entry was re-derived
  from its body.
- **Window.** It kept 2 bodies (16,776,799 bytes): current and pinned, plus the
  previous body. It pruned 45 bodies (373,854,886 bytes). The retained
  repository fell to 17,272,265 of 805,306,368 bytes.
- **Verification after pruning.** Without the ledger it refused ("public
  repository file missing", as today). With the ledger it took 0.36 s and gave
  the same floors, revisions, policy floors and definition floors as the
  complete tree. 45 entries were verified from the ledger.
- **Restore.** Restoring the publication at `68d132a42` (policy 41) by
  `git checkout` and adding it as a pin left verification unchanged. The window
  then kept 3 bodies. A full restore from the head pin verified without the
  ledger again; no body had been published after that pin (see the next
  rehearsal for that case).
- **Not covered.** Signing a renewal needs the online keys and runs only in
  `catalog-publish.yml`. The keyless publisher context check over the pruned
  tree, and the signed fixture publications in
  `definition_repository::tests::listing_floor_ledger`, cover the rest.

**Full-restore rehearsal after later pruning, November 23, 2026 (offline,
nothing pushed).** A local clone of `gh-pages` at `758583339`, this change's
release tools (release build) and `scripts/catalog-body-window.mts --apply`.
The three publications are the real signed publications that followed the
pin, replayed onto a pruned branch: each run copied that publication's added
and changed `catalog` files, verified history against the previous ledger
(writing the next one), applied the window with the previous ledger, ran the
publish loop's pre-commit check (the staged tree against the ledger it serves)
and committed. The restore used the script in step 2 verbatim.

| Step                                    | Result                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Backfill at `345447603` (policy 56)     | 43 entries, all from bodies.                                                                                                            |
| Prune at policy 56, pin `P = 345447603` | Kept 2 bodies, pruned 41 (340,300,907 bytes).                                                                                           |
| Publication 1 (`8b17b76dd`, policy 57)  | Verified: 44 entries, 3 from bodies, 41 from the ledger. Pruned 1.                                                                      |
| Publication 2 (`2441db401`, policy 58)  | Verified: 45 entries, 3 from bodies, 42 from the ledger. Pruned 0.                                                                      |
| Publication 3 (`680c995b8`, policy 59)  | Verified: 46 entries, 4 from bodies, 42 from the ledger. Pruned 1: `f807e3dc…`, first published by policy 57, after the pin.            |
| Old full restore (`checkout "$P"`)      | Refused without a ledger: "catalog public repository file missing: targets/f807e3dc….policy/official/catalog.listings.json".            |
| Corrected full restore                  | 46 of 46 bodies back, digests checked. Verified without a ledger; the report and `catalog/targets` equal those of the real `680c995b8`. |
| Pre-commit checks, publications 1–3     | Each staged tree verified against its served ledger (44, 45 and 46 entries; 2, 3 and 3 bodies served).                                  |
| Divergence check, served ledger (45)    | Extended to 46 entries, 46 from bodies and 0 from the ledger, byte-equal to the backfill; the ledger stays.                             |
| Divergence check, tampered ledger       | One restored body's revision lowered: "does not extend its published predecessor exactly"; the deletion was staged for the restore.     |
| Archive bundle                          | `git bundle` of `gh-pages` (74 commits): 63,868,435 bytes, verifies. Prepared only.                                                     |

The first attempt at the corrected loop, without `--no-renames`, missed 2
bodies: Git reported each as a 61% rename to a new body. The whole rehearsal
took 19 s. Signing was not exercised; the publications were real signed
history, not new signatures.

**Recovery horizon and compaction.** Apart from the activation bundle, pruned
bodies are recoverable only from
`gh-pages` Git history (the full restore needs the commits that deleted them).
Before an owner history compaction
([design 6.6](design/CATALOG-DISTRIBUTION-SCALING.md#66-git-history-growth-and-compaction)),
re-pin to post-compaction commits and archive the old history as a `git bundle`
release asset. After compaction, restoring a pin that was removed, or any body
pruned before the compaction, needs that bundle (`git fetch <bundle>
'refs/heads/*:refs/bundle/*'` into the scratch clone, then the restore above).

**Operating plan.** Measured on November 23, 2026: `gh-pages` packs to 63.87 MiB
(67.0 MB); policy v1–v60 took 7.69 days (7.8 publications a day); the served
tree has 1,614 files and each publication adds 3 metadata files plus 1 listing
body.

- **History compaction (owner).** The trigger is 2 GiB packed (2,147.5 MB), so
  2,147.5 − 67.0 ≈ 2,080 MB of headroom. Legacy-only growth is about 6.7–6.8 MB
  a day: 2,080 ÷ 6.8 ≈ 306 and 2,080 ÷ 6.7 ≈ 311, so about 310 days. After the
  compact-only cutover, growth is `browse/` 5.5 MB plus compact 17.3–22.2 MB,
  about 22.8–27.7 MB a day: 2,080 ÷ 27.7 ≈ 75 and 2,080 ÷ 22.8 ≈ 91, so a
  compaction about every 75–91 days. The window does not change this: pruned
  bodies stay in history.
- **Before activation.** The archived `gh-pages` bundle above is a precondition
  of the first `window` run.
- **Ledger entry cap, 16,384 (and 8 MiB).** Exceeding either stops every
  publication while `ledger` or `window` is on: the release tools refuse the
  ledger. At about 450–480 bytes an entry the entry cap binds first
  (16,384 × 480 ≈ 7.9 MB, under 8,388,608 bytes). One entry per distinct listing
  body; 47 legacy bodies exist today. At one body per publication (legacy-only or compact-only)
  (16,384 − 47) ÷ 7.8 ≈ 2,094 days, about 5.7 years (mid-2032). While legacy and
  compact are both published, about two bodies a publication, ≈ 1,047 days,
  about 2.9 years (late 2029) if that lasted throughout.
- **Served file bound, 65,536.** With the window, about 3 files a publication:
  (65,536 − 1,614) ÷ (3 × 7.8) ≈ 2,732 days, about 7.5 years. Without it,
  about 4 a publication: ≈ 2,049 days, about 5.6 years.
- **History checkpoints first.** Every retained metadata version is still
  verified and served, and the ledger only grows, so the history-checkpoint
  work (design 6.4–6.5) must land before the earlier of these bounds, about
  late 2029 at the dual-carrier rate.
- **Other bounds.** At most 8 pins. The late readback deepens at most 64
  `gh-pages` commits past the publisher commit, then reports a visible readback
  failure for that run rather than continuing.
- **Root expiry.** The published `catalog/metadata/1.root.json` expires
  2027-10-30T15:29:53Z; the owner re-signs Root before then, independently of
  the window.

<a id="release-task-order"></a>
<a id="preflight"></a>
<a id="build-matrix"></a>
<a id="publish"></a>
<a id="retain-evidence"></a>
<a id="upstream-first-release-integration"></a>
<a id="ordinary-application-publication"></a>
<a id="operate-the-protected-path"></a>
<a id="november-4-2026-rehearsal-record"></a>
<a id="inactive-slice-4-input-integration"></a>
<a id="frontend-and-signing-environment-boundary"></a>
<a id="offline-updater-artifact-rehearsal"></a>
<a id="one-key-initial-offline-ceremony"></a>
<a id="version-authority"></a>
<a id="configuration-held-fixed-controller-source-admission"></a>
<a id="dedicated-fixed-job-storage-credential"></a>
<a id="durable-local-coordinator-checkpoints"></a>
<a id="bounded-no-spend-attempt-eligibility-slice-4"></a>
<a id="inactive-remote-checkpoint-transport"></a>
<a id="bounded-remote-checkpoint-recovery"></a>
<a id="inactive-bounded-trusted-assembly"></a>
<a id="bounded-artifact-to-aggregate-integration"></a>
<a id="inactive-assembler-job-identity-verification"></a>
<a id="inactive-aggregate-attestation-binding"></a>
<a id="frozen-source-consistency"></a>
<a id="read-only-release-run-evidence"></a>
<a id="standalone-cli-integration-artifact"></a>
<a id="declared-package-policy"></a>
<a id="windows-application-cutover"></a>
<a id="windows-preflight"></a>
<a id="isolated-windows-installer-checks"></a>
<a id="roadmap-readiness-snapshot"></a>
<a id="tagged-build"></a>
<a id="release-rehearsal"></a>
<a id="post-publication-verification-and-release-channels"></a>
<a id="initial-application-feed-recovery"></a>
<a id="upgrade-acceptance-and-technical-previews"></a>
<a id="optional-signed-catalog-publication"></a>
<a id="glib-development-policy-and-linux-release-authorization"></a>
<a id="metadata-only-renewal-in-the-existing-coordinator-journal"></a>

## Retired unattended release engine

Older links land here. Use the [current release process](#current-release-process)
for a new release. The [archived engine runbook](archive/retired-release-engine.md)
retains the original procedures and evidence.
