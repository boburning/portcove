# Releasing Portcove

## Current release process

The owner set this process on [#534](https://github.com/boburning/portcove/issues/534#issuecomment-6864263340)
on 2026-11-13. It replaces the unattended release engine recorded in the
[historical runbook](archive/retired-release-engine.md).
Releases do not depend on AI review.

**A `v*` tag on protected `main` is the release decision.** Only the owner, or
an agent acting through the owner's account, can create `v*` tags.
[`app-release.yml`](../.github/workflows/app-release.yml) classifies the tag and
confirms that the commit is on `main` and that its `CI` run succeeded. It then
calls the shared jobs in
[`app-release-build.yml`](../.github/workflows/app-release-build.yml), which:

1. Refuse inputs that disagree with the version's channel, tag or signing
   environment.
2. Stamp the version, then build the Windows NSIS installer, Linux AppImage,
   and universal macOS app and DMG. Sign the updater assets with the Tauri
   updater key. macOS builds are ad-hoc signed. Build and smoke-test standalone
   CLI archives from the same source and version for Windows x86-64, Linux
   x86-64, and both Apple Silicon and Intel macOS.
3. Check the complete asset set before publishing the immutable GitHub Release.
   Generate the download chooser from the uploaded assets when publishing the
   draft. `SHA256SUMS` covers the Desktop packages, updater payloads and
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

**To release**, from a clean checkout of the current `origin/main`:

```sh
PORTCOVE_RELEASE_NOTES_FILE=notes.md just release 0.1.1
```

The command refuses in these cases: the checkout is not exactly `origin/main`,
there are uncommitted changes, the version is not greater than every existing
`v*` and `nightly-*` tag, or `CI` has not succeeded on that commit. If none
apply, it pushes an annotated tag whose message becomes the release notes. An
agent asked to "review and release X.Y.Z" reviews the changes since the last
tag, writes the notes, and runs the same command. The owner's request is the
authorization. Only Stable waits for the owner's approval on the
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
`CI` push run succeeded, using one read of the latest 100 completed `CI` runs on
`main`. On a busy `main` the newest commit often has no finished `CI` run
yet, because pending runs are replaced. It does nothing when the newest `main`
commit already carries a `v*` or `nightly-*` tag, when it reaches a tagged
commit before a CI-green one, or when none of those commits is CI-green.
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
  - Every trigger publishes the newest CI-green first-parent `main` commit, so
    re-running an older CI run cannot publish an older bundle.
- **Recovery:** if renewals stop and the published timestamp expires, clients
  keep their last verified catalog. The next successful run publishes again,
  because the expired catalog is still read as authenticated history: its
  signatures, version floors and unchanging published files are checked, but its
  expiry is not. No manual step is needed.
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
