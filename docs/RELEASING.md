# Releasing Portcove

Portcove releases fail closed when the product version, Git tag, required identity assets, tests, or catalog ownership checks disagree. Tagged builds remain draft releases until their platform artifacts and checksums have been reviewed.

See [Continuous verified delivery](DELIVERY.md) for the approved future
version/channel, platform-updater and zero-cost automation policy. Current
protected publication remains effective until separately authorized activation.
In particular, suffix-free 0.x publication is blocked by the required release
classification implementation: the current suffix-only workflow would classify
it incorrectly. Do not invoke it for a suffix-free beta.

For a routine preview, `roadmap.mjs candidate-scope --issues <issue,issue,...>`
checks the frozen implementation scope without waiting for unrelated milestone
capabilities. It grants no publication authority and replaces none of the gates
below. Declaring Public beta or 1.0 also requires the corresponding cumulative
`readiness` and snapshot evidence. #532/#533/#534 own classification, bounded
automation and separately authorized one-time provisioning respectively.

## Offline updater artifact rehearsal

`release/tauri.updater.conf.json` is an explicit packaging overlay. It enables
Tauri v2 updater artifacts, current-user NSIS with passive updater installation,
and ad-hoc macOS signing. Ordinary configuration still disables updater artifacts;
no endpoint, runtime updater plugin, or production key is installed by this overlay.
An updater signature is distinct from Authenticode, notarization, and catalog trust.
Tauri's bundler requires the corresponding public key in its merged updater
configuration. The rehearsal creates a temporary copy of the overlay containing
its disposable public key; a bare overlay without that key deliberately cannot
produce an updater package.

The manual **Updater artifact rehearsal** workflow generates disposable keys on
each runner and builds every required Windows, Linux, Intel Mac and Apple Silicon
package at fixture versions 0.1.0 and 0.3.0. It checks native package versions and
executable permissions; Windows also runs the existing isolated installer harness
through a passive skipped-version upgrade and uninstall with data preservation.
These are fixture versions, never publication or release-readiness declarations.
The script requires a clean tracked checkout, records the exact source commit and
version-only source patch, restores metadata, and deletes its disposable private
key. Prior build outputs are preserved under its new evidence directory.

`scripts/updater-artifact-inventory.mjs stage` selects the complete existing package
matrix, copies final distributed bytes into a new directory, hashes them, verifies
the updater signature, and writes `updater-inventory.json` last. Windows and Linux
reuse NSIS/AppImage bytes. Mac updater archives are copied without rebuilding to
versioned architecture-specific filenames, avoiding the shared `Portcove.app.tar.gz`
name. CLI, DEB/RPM and DMG remain inventoried companions with their existing owners;
they are not activated as alternate updater formats.

The `verify` operation rechecks exact commit/version/platform/package identities,
the complete staged file set, every hash and size, and the signature against an
independently supplied public-key file. Both operations require `--label`,
`--revision`, `--public-key` and `--verifier`; use `stage --output PATH` or
`verify --input PATH`. The verifier is the built `portcove-release-tools` binary.
Only verification accepts `--version` to check a historical fixture explicitly.
Inventories are evidence, not trust roots or executable feeds. Altered/rebuilt
packages require new verification and cannot inherit previous package evidence.

Payload verification streams at most 2 GiB; key and signature metadata are bounded
to 16 KiB. Only prehashed Minisign signatures emitted by current Tauri tooling are
accepted. The Rust verifier has no private-key or publication operation. The
workflow retains public keys, exact packages, inventories, patches and observations
for one day; it never uploads private keys or changes published releases. Download
required evidence before expiry. Deterministic fixtures, package inspection,
installed execution, physical devices and human observations remain distinct.

## Version authority

The release version must match in exactly three places:

- `[workspace.package].version` in `Cargo.toml`;
- `version` in `apps/desktop/package.json`;
- `version` in `apps/desktop/src-tauri/tauri.conf.json`.

After changing them, run Cargo once so the workspace package entries in `Cargo.lock` are refreshed (including the unpublished release verification tool). A release tag is always the exact version with a `v` prefix, such as `v0.1.0` or `v0.2.0-beta.1`.

`scripts/check-release-metadata.mjs` verifies those versions, the tag, package manager pin, repository/license metadata, Tauri identity, and the required master/runtime/platform brand assets. Local packaging derives its default version from that check and rejects an explicit mismatch.

The offline `pnpm --dir apps/desktop release:policy` utility accepts `classify`,
`select` or `propose` followed by one JSON input file. It shares the existing Node
tooling workspace and maintained SemVer dependency; it is not renderer code.
Classification defaults to Preview, including suffix-free 0.x and unapproved
final versions. Stable requires separate explicit production eligibility for a
final version at or beyond 1.0; approved finals are also eligible for Preview.
Selection checks separately supplied eligibility and optional target/current
version, rejects equal-precedence ambiguity, and orders by SemVer rather than date.
Build metadata alone never requests reinstallation.

Proposals require matching frozen source/review commits, complete published
version history, and an explicit change/compatibility classification. They reject
stale bases, implicit prerelease finalization, published precedence reuse, and
compatibility breaks without the required version change and migration notes.
A proposal does not allocate a version, edit metadata, authenticate its input,
grant production approval or publish a release. Its caller must establish input
authority. Existing production publication remains separately protected; a
proposal cannot activate that procedure. Download selection uses the same policy.

`pnpm --dir apps/desktop release:prepare REPOSITORY INPUT.json` accepts
`classification` and `published_versions` using the proposal schema. It reads
only the frozen commit, updates the coordinated Cargo/Desktop/Tauri versions and
workspace lock entries in a temporary index, and creates a prepared child commit.
It leaves the working files, real index, current branch and public tags unchanged.
Two custom refs, `refs/portcove/prepared-versions/vVERSION` and
`refs/portcove/prepared-commits/SOURCE`, are created in one Git transaction. Their
commit binds the source, tree and classification digest. Identical retries return
that same commit; conflicting intent, version reuse and incomplete receipts fail
closed. Prepared bytes require their own validation and review before publication.
Receipt verification holds both Git ref locks, so concurrent publication of the
receipt pair cannot be mistaken for an incomplete allocation. Lock acquisition
is bounded to one second per Git attempt; a still-locked coordinator fails and
can be retried after the owning operation finishes. Git object creation uses
hard links to preserve existing objects during concurrent identical writes.
The coordinator filesystem must support that operation; unsupported filesystems
fail instead of switching to overwriting existing objects.

Allocation is serialized within one coordinating Git repository and its linked
worktrees. These immutable preparation receipts are not a live roadmap or a
production authorization. A future protected controller must retain that single
coordinator, refresh the complete published inventory, and validate input
authority; separate clones do not constitute a global allocator. The tool neither
pushes refs nor chooses credentials. Never delete a receipt to recycle a version.

## Standalone CLI integration artifact

Every released external-client claim points to an exact standalone CLI archive,
the aggregate SHA-256 manifest, declared host prerequisites, and the applicable
CLI/schema compatibility documentation. The release matrix already produces
separate Windows, Linux, Intel macOS, and Apple-silicon macOS CLI archives; an
integrator need not compile Portcove or install/run the desktop application.
Artifact presence is not platform or frontend qualification, and the current
alpha signing and hands-on limits still apply.

[#46](https://github.com/boburning/portcove/issues/46) remains the package,
checksum, signing, and exact-artifact qualification owner. #30 owns the public
machine contract and compatibility policy, while #243 owns the independent
consumer exercise. A development exercise may use one exactly identified
packaged candidate to avoid a release dependency cycle, but final author
guidance must point to an available public release and may not describe the
candidate as released.

Beginning with the first release after Alpha 2, CLI archives use explicit,
versioned names derived from the same metadata checked against the release tag:

```text
portcove-cli-<version>-windows-x86_64.zip
portcove-cli-<version>-linux-x86_64.tar.gz
portcove-cli-<version>-macos-aarch64.tar.gz
portcove-cli-<version>-macos-x86_64.tar.gz
```

The executable inside remains `portcove.exe` on Windows and `portcove` on
Linux/macOS. Alpha 1 and Alpha 2's unversioned archive names and platform
manifests remain historical assets; do not rename, duplicate, or replace them. First-party future
release tooling accepts only the versioned names.

## Declared package policy

`release/package-policy.json` is the single required-output definition. It
declares interface, operating system, processor, format, native filename rule,
display label, and experimental presentation independently of whatever a build
happens to emit. The current exact matrix is:

| Platform | Desktop | Standalone CLI |
|---|---|---|
| Windows x86_64 | NSIS setup installer | ZIP |
| Linux x86_64 | AppImage, DEB, RPM (experimental) | TAR.GZ |
| macOS aarch64 | DMG (experimental) | TAR.GZ |
| macOS x86_64 | DMG (experimental) | TAR.GZ |

Release jobs pass `--bundles nsis`, `--bundles appimage,deb,rpm`, or
`--bundles dmg` to the installed Tauri 2 CLI as appropriate; they do not assume
that every operating system accepts one common target list. The policy neither
adds MSI, portable desktop ZIPs, new architectures, Flatpak, nor updater
artifacts. Changing a required output is a protected release-policy change, not
a way to make a failed build disappear.

The builders derive the version from checked Cargo/Desktop/Tauri metadata,
package the CLI, extract that final archive, verify the executable name and
native architecture, run `--version`, and exercise a machine command against an
isolated temporary library. `write-release-checksums.mjs` then accepts exactly
the policy's platform outputs and creates an internal platform manifest. The
cross-platform reconciler independently requires the complete policy matrix,
recomputes every hash, rejects unsafe paths, missing/unexpected/case-colliding
names and version/format mismatches, and produces the final inventory plus one
public `SHA256SUMS.txt`. Filename checks identify the expected package; the
extracted executable inspection is the practical architecture evidence for the
CLI. Desktop runtime and installed-package qualification remain separate.

## Windows preflight

From the repository root, run the complete local gate before creating a tag:

```powershell
.\scripts\release-preflight.ps1 -Tag v0.1.0
```

The gate verifies release metadata, the full `just audit` contract, the frontend production dependency audit, active catalog repositories, direct PS1 upstream ownership, the native Tauri bundle, and an isolated silent install/respond/uninstall lifecycle. Install the pinned audit tools with `scripts/bootstrap-quality-tools.ps1` before running it locally. It never uses or modifies the normal Portcove library. Network-backed catalog and dependency checks use the configured credentials or normal anonymous public access.

After it passes, refresh the shareable local artifacts and checksum manifest:

```powershell
.\scripts\package-local.ps1
```

An explicit `-Version` is accepted only when it matches the central release metadata.

To qualify replacement of an earlier local build, retain its installer before rebuilding and run:

```powershell
.\scripts\test-windows-installer.ps1 -InstallerPath <new-setup.exe> -UpgradeFromInstallerPath <earlier-setup.exe> -ExpectedExecutablePath <new-portcove-desktop.exe>
```

The test refuses to replace an existing registered Portcove installation. In a new isolated directory it installs and cleanly closes the predecessor, replaces it with the candidate, checks the candidate executable hash and responsive window, then uninstalls. Expected executable hashing reproduces Tauri's single fixed bundle-type marker substitution from `UNK` to `NSS` in memory; it compares the entire resulting file, and reports both raw and bundled hashes. The library database and a clearly labeled test data marker must survive replacement and uninstall. Forced termination is a failed smoke result. Same-version build replacement is recorded separately from a future version-number upgrade, signed production validation, and interactive shell observations.

Prepare a reproducible hands-on session for an existing qualification library with:

```text
node scripts/qualification-report.mjs --cli <portcove.exe> --library <qualification-library> --output <new-report-directory>
```

The report captures versioned core diagnostics, catalog, sources, status, activity, capacity, and backup listings, plus the exact CLI hash. Its checklist leaves gameplay, audio, controller, and save/load observations unassessed. Keep these local reports private because source references contain local paths; they never contain source file contents or account credentials. The tool does not edit catalog qualification flags.

For a packaged Windows qualification session, first create an immutable build
record from the exact clean candidate checkout. Put all package inputs below
that checkout; ignored `target`, `work`, or `outputs` directories are suitable.
The predecessor version and installer digest are mandatory:

```powershell
node scripts/write-windows-qualification-build.mjs `
  --repository <absolute-clean-candidate-checkout> `
  --installer <candidate-setup.exe> --cli <candidate-portcove.exe> `
  --desktop <raw-candidate-portcove-desktop.exe> `
  --predecessor <published-predecessor-setup.exe> `
  --predecessor-version <published-version> --output <new-build-record.json>
```

Record the printed build-record SHA-256 outside the candidate checkout. Prepare
then rechecks that hash, candidate commit and tree, tracked cleanliness, every
package, and every qualification tool even with `-ValidateOnly`:

```powershell
.\scripts\windows-qualification-session.ps1 -Action prepare `
  -SessionRoot <new-absolute-disposable-directory> `
  -CandidateCheckout <absolute-clean-candidate-checkout> `
  -BuildRecordPath <build-record.json> `
  -ExpectedBuildRecordSha256 <sha256>
```

The command refuses any existing Portcove installer registration and any
existing, relative, volume-root, or reparse-backed session directory. It copies
and verifies all executable inputs and tools below the session root. The normal
installer probe performs the predecessor upgrade, responsive-window smoke,
complete recursive preservation comparison, and uninstall. Before uninstall it
copies the verified packaged desktop into the session. The later functional
session therefore leaves no installer registration while it runs. Both
`PORTCOVE_LIBRARY` and `PORTCOVE_PREFERENCES` remain below the session root.

Run later actions with the verified copy at
`<session>\tools\windows-qualification-session.ps1`. Checkpoint asks the
journaled desktop process to close, captures a new report
with the verified packaged CLI, and never overwrites an earlier or interrupted
sequence. Every relaunch appends a process-run record, and each checkpoint links
to the run it closed. Recovery accepts a pending launch only when one process
matches the exact executable path and hash and began no earlier than five
seconds before the recorded request. Use `-Relaunch` when the next scenario
needs restart persistence:

```powershell
& <session>\tools\windows-qualification-session.ps1 -Action checkpoint `
  -SessionRoot <same-disposable-directory> -Label after-storage -Relaunch
```

Finish closes a running session through its main window, captures one final
report, preserves the exact pre-finish session metadata, and writes a hashed
receipt covering the recursive retained evidence. A later invocation
cannot recover the original Windows process handle, so a close followed by
process disappearance is recorded as an unobserved exit code rather than a
clean-exit claim. An interrupted finish resumes its recorded attempt and reuses
the exact snapshot or receipt instead of repeating the final checkpoint:

```powershell
& <session>\tools\windows-qualification-session.ps1 -Action finish `
  -SessionRoot <same-disposable-directory>
```

If prepare fails after an installer starts, keep the session root and run
`-Action abort`. Abort requires the phase journal hash to have been bound into
`session.json`, then verifies its owned paths and recorded uninstaller hash. It
acts only inside the validated session root. If it cannot
prove that identity, it leaves the partial evidence and installation untouched
for explicit recovery. It records an abort only after proving that no owned
process, managed install file, or Portcove registration remains.

The session record is automated package and application-state evidence only.
Synthetic fixtures may prove orchestration, refusal, and recovery behavior, but
they do not establish source admission, game installation, gameplay, audio,
controller behavior, save compatibility, comprehension, publisher prompts, or
physical-platform behavior. Leave every unobserved row unassessed. If candidate
source or package bytes change, create a new build record and session root.

## Roadmap readiness snapshot

Before publishing a tagged release, review the live Portcove Roadmap view for
the target stage, its open blockers and deferred items, and the catalog's actual
qualification state. Then generate a new immutable snapshot under
`docs/releases/`:

```powershell
node scripts/roadmap.mjs snapshot --release "Alpha 1" --output docs/releases/0.1.0-alpha.1-readiness.md
```

Legacy snapshots retain historical cumulative stages. New Public beta snapshots
include completed Alpha 1/2 history and Public beta; 1.0 includes all historical
stages and both current milestones. Active legacy targets are migration conflicts.
These cumulative declarations are separate from routine candidate safety checks. `Target release`
is a forecast; `Release commitment` controls the gate. The generator follows
genuine transitive blocking relationships and reports later, Opportunistic,
unclassified, or Project-missing dependencies as conflicts. Parentage and
related-work links do not block a release. Relevant unclassified work and known
shipped-scope safety conflicts prevent a falsely green result, while unrelated
unscheduled intake does not. Only Project `Status = Done` counts as complete.
Use `roadmap.mjs readiness --release <stage>` for a live derived preview. The
generator reports closed/not-planned issues whose Project status disagrees and
accepts evidence links only from the explicit Completion evidence section,
implementation pull requests/checks, or qualification and rehearsal records.

Codex and deterministic automation execute feasible validation, investigate
failures, repair within scope, perform a separate review pass, and record exact
evidence; the owner does not repeat adequate automated checks. Human participation
is required only when intrinsic to the claim, such as novice comprehension or
actual gameplay observation. A packaged process start, synthetic fixture, VM,
or physical-device script proves only what it directly observed.

Review and complete the snapshot's test, CI, rehearsal, signing, intrinsically
human-validation, and explicit-limitation sections before committing it. The file records generation
time, commit, Project URL, completed and unfinished required items, blockers,
conscious deferrals, evidence links, and a qualification summary derived from
`catalog.json`. Never edit an older snapshot to reflect a priority change;
generate a new dated/versioned snapshot. The live Project remains authoritative.

Use two linked records to keep the release commit fixed. The committed
pre-publication snapshot identifies its observation/base SHA and the remaining
gates. After the finalization PR is reviewed and merged, freeze the full merge
SHA as `C` and post an execution record on the release issue or PR, keyed by
version and `C`. That record binds the snapshot path/blob/SHA-256, release-note
digest, required CI and its tested tree, Windows preflight/installer evidence,
exact manual rehearsal run/attempt, protection settings, and limitations.
Do not commit the future rehearsal result back into the snapshot: that would
change `C`. Any committed change after rehearsal requires a newly established
candidate and repeated final checks. Historical snapshots retain their original
SHA and never certify a newer commit. Project fields remain the live authority.

Normal merge authority, authorization to create the exact tag at `C`, and
authorization to publish the verified tag-generated draft are separate
boundaries. Routine merges use mandatory CI, an explicit separate review result,
resolved threads, current revision/authority confirmation, and no administrator
bypass. Tagging and publication remain explicit protected boundaries. Before tagging,
re-read release immutability and effective tag protections described in
[REPOSITORY-SETTINGS.md](REPOSITORY-SETTINGS.md). After tagging is authorized,
inspect the tag build's own packages and checksums; rehearsal bytes do not
certify a later build. Keep the draft unpublished until its asset identities,
notes, prerelease flag, and required package tests are verified and publication
is explicitly approved. Verify release immutability and public asset integrity
after publication; the repository setting alone is not that evidence.

## Tagged build

Pushing `v*` starts `.github/workflows/release.yml`. Its preflight job repeats the identity, dependency, test, Fallow, and upstream gates before the Windows, Linux x64, Intel macOS, and Apple-silicon macOS matrix can build. Matrix jobs have read-only repository permission, stage only the versioned CLI archive, explicitly selected native distributable packages, and one internal platform SHA-256 manifest, and pass those exact files to the publisher as transient workflow artifacts. Only after every matrix job succeeds does one `publish` job receive `contents: write`, download all four artifacts, validate the exact independently declared matrix, recompute every checksum, and create or reconcile one draft release. It refuses to change a published release. The first run generates the complete body before creating the draft. A rerun verifies an existing draft body byte for byte and fails closed instead of editing it. The publisher rechecks draft state before each asset deletion or upload; repository-level immutable releases provide the server-side boundary if publication happens between that check and the asset mutation.

The reconciler writes the public packages and one aggregate `SHA256SUMS.txt`;
the four platform manifests remain internal validation inputs and are not
uploaded as redundant public assets. It also writes a build-time inventory
outside the public asset directory. The publisher uses that verified inventory
to add or replace one marked desktop-first download section in the draft body,
while preserving all reviewed prose and GitHub's categorized changes. Repeated
generation cannot duplicate the section. Links are bound to the exact tag, and
preview notes do not use GitHub's stable-only latest-release endpoint. After the
draft owns the verified files, the publisher deletes the transient workflow
artifacts; a failed run retains them for no more than one day for diagnosis.
Tags containing a SemVer prerelease suffix are marked as prereleases
automatically. Tauri updater metadata remains disabled until Portcove has an
explicit signed desktop self-update contract.

Release matrix, aggregate, inventory, checksum, and staging paths must be
owned child paths of the checkout. Existing linked or reparse-point components
are refused before release tooling reads, replaces, creates, or copies those
outputs.

## Release rehearsal

Run the **Release** workflow manually from GitHub Actions before the first v1 tag or after changing packaging. A manual run executes the same preflight and four-platform build matrix, but every GitHub Release mutation remains disabled. Its read-only rehearsal consumer downloads all four `release-build-*` artifacts, runs `scripts/reconcile-release-assets.mjs` against their containing directory, validates the exact matrix and internal manifests, and generates the aggregate checksum plus private build-time inventory. It deletes the transient copies only after that contract passes. A failed rehearsal retains its artifacts for no more than one day for diagnosis; a successful rehearsal keeps the run logs and verification result without consuming ongoing Actions artifact storage. A rehearsal never creates a tag, draft release, or published release.

From an authenticated GitHub CLI, start and follow the rehearsal with:

```powershell
gh workflow run release.yml --ref main
gh run list --workflow release.yml --event workflow_dispatch --branch main --limit 10
```

Identify the specific dispatch by workflow, event, branch, dispatch time, actor,
and `head_sha = C`; never select an unrelated latest run. Require successful
preflight, every expected builder, and reconciliation, with publication skipped.
Record the run ID, attempt, timestamps, SHA, job outcomes, reconciliation result,
and cleanup state in the external execution record. If main moves during the
freeze or dispatch resolves another SHA, stop readiness until the candidate is
explicitly re-established. Do not silently retarget it.

The rehearsal proves that the current commit can produce packages on hosted builders. It does not replace signing, installation, gameplay, controller, or other hands-on validation tracked in the live Portcove Roadmap.

Before publishing the draft:

1. confirm the aggregate `SHA256SUMS.txt` covers every public CLI archive and desktop bundle and that the logs show all four internal manifests were accepted;
2. verify the committed observation snapshot and external execution record both refer to the intended frozen candidate;
3. compare release notes with live Blocked & Deferred items so manual or signing work is not overstated;
4. keep unsigned artifacts clearly identified until the signing issue has matching completion evidence;
5. perform the target-shell and hands-on checks appropriate to the release; and
6. publish only after the draft contents, version, channel, snapshot, and Project readiness are correct.

The generated draft begins with these sections before categorized changes:

1. **Download the desktop app** — operating-system and processor choices, with
   experimental status retained;
2. **Command-line tools** — clearly separate standalone CLI archives;
3. **Verify your download** — the one aggregate manifest and commands that check
   a selected package without downloading the rest; and
4. reviewed release changes, known limitations, upgrade guidance, and
   troubleshooting.

It states that Desktop needs no separate CLI, a CLI archive is not a graphical
app, an AppImage is not universal Linux or Steam Deck evidence, and GitHub source
archives require a development build. Checksums establish agreement with the
published bytes, not independent publisher identity, malware freedom,
operating-system signing, updater authorization, or gameplay/platform evidence.

Creating a tag does not authorize weakening catalog integrity, embedding game data, or marking deferred gameplay and operating-system observations as complete.

## Post-publication verification and release channels

Only after separately authorized publication can public reachability and
integrity be checked. Download `SHA256SUMS.txt` and one selected package, require
exactly one matching manifest line, and use `Get-FileHash`, `sha256sum --check
--strict`, or `shasum -a 256 --check` as shown in the generated release body.
Then use `gh release verify-asset <tag> <asset>` for each public asset and record
the immutable release/tag, exact commit/run, API size/digest, and HTTP result.
Historical manifests stay untouched.

`scripts/select-release-channel.mjs --channel preview|stable --input releases.json`
selects the highest eligible SemVer from a complete published release inventory.
It excludes drafts, keeps public 0.x in Preview, and requires separate production
eligibility for Stable. Preview also includes eligible final releases. Optional
`--eligibility evidence.json`, `--current-version VERSION` and `--target TARGET`
apply explicit eligibility, increasing-version and target constraints. The caller
must authenticate eligibility evidence; a local JSON file is not a trust root.
Publication dates and GitHub latest never rank versions. Generated download links do not need discovery:
they always name their exact tag. Do not use `/releases/latest` or
`releases/latest/download` as a preview resolver.

Routine release preparation is designed to require no owner reconciliation of
filenames, tables, or checksums. Current governance still separates ordinary
merge authority, tag creation, and publication of the verified draft. Removing
those per-release approvals requires a separately reviewed protected controller,
bounded credentials, negative/recovery tests, and explicit authority; this
packaging change does not grant it or introduce another manual gate.

## Upgrade acceptance and technical previews

Public beta requires the complete verified application updater under
[#52](https://github.com/boburning/portcove/issues/52): Windows per-user NSIS,
Linux AppImage, that same Linux application on Steam Deck, and installed macOS
bundles on Intel and Apple Silicon. Shared mechanisms are implemented
incrementally, with actual platform upgrade/recovery proof before the beta
declaration. [#46](https://github.com/boburning/portcove/issues/46) retains later
exact production package/upgrade/rehearsal evidence for 1.0; #52 does not wait
for its post-beta closure. RC stabilizes one exact candidate, not all development.

The [delivery contract](DELIVERY.md) separates application/catalog/game updates,
Stable/Preview eligibility, updater authenticity, SHA-256 reconciliation, OS
publisher identity and OS enforcement. Automatic mode uses one-time consent,
busy-state exclusion and safe-time application without recurring release-note
approval. Pre-1.0 public releases remain Preview-only; Stable becomes the default
after production approval. Paid publisher signing is optional. These are planned
contracts, not evidence that updater behavior, custody or unattended publication
has already been implemented or activated.

Early technical previews may use a documented, verified manual upgrade path.
Use a small explicitly qualified scope after applicable trust gates permit;
label limitations and publisher prompts clearly and require disposable or fully
backed-up libraries. Record package hashes and the unassisted first-play/recovery
scenario outside the development checkout. A preview is not evidence of universal
catalog or platform qualification, and its plan does not authorize publication.

Missing required platform evidence keeps Public beta open; it does not block
independent implementation or an otherwise eligible incremental preview. A
successful manual reinstall cannot complete the baseline updater. DEB/RPM remain
package-manager-mediated; standalone CLI self-updating and optional extra formats
remain outside the baseline. Record exact unsupported paths and recovery limits.

## Optional signed catalog publication

`scripts/sign-catalog.mjs` signs an explicit catalog file using an existing Ed25519 PKCS#8 private key file and writes a new envelope without overwriting an existing output. This is offline publisher tooling, not a production key generator or hosted release workflow. The consumer trusts no publisher by default. Configure custody, recovery, rotation, a strictly increasing catalog sequence, and an independently verifiable public-key distribution channel before publishing a production feed. A catalog signature is neither an application code signature nor desktop updater authorization. Exact invocation and verification steps are in [SIGNED-CATALOG.md](SIGNED-CATALOG.md).
