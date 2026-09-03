# Releasing Portcove

Portcove releases fail closed when the product version, Git tag, required identity assets, tests, or catalog ownership checks disagree. Tagged builds remain draft releases until their platform artifacts and checksums have been reviewed.

## Version authority

The release version must match in exactly three places:

- `[workspace.package].version` in `Cargo.toml`;
- `version` in `apps/desktop/package.json`;
- `version` in `apps/desktop/src-tauri/tauri.conf.json`.

After changing them, run Cargo once so the three workspace package entries in `Cargo.lock` are refreshed. A release tag is always the exact version with a `v` prefix, such as `v0.1.0` or `v0.2.0-beta.1`.

`scripts/check-release-metadata.mjs` verifies those versions, the tag, package manager pin, repository/license metadata, Tauri identity, and the required master/runtime/platform brand assets. Local packaging derives its default version from that check and rejects an explicit mismatch.

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

## Roadmap readiness snapshot

Before publishing a tagged release, review the live Portcove Roadmap view for
the target stage, its open blockers and deferred items, and the catalog's actual
qualification state. Then generate a new immutable snapshot under
`docs/releases/`:

```powershell
node scripts/roadmap.mjs snapshot --release "Alpha 1" --output docs/releases/0.1.0-alpha.1-readiness.md
```

Review and complete its test, CI, rehearsal, signing, human-validation, and
explicit-limitation sections before committing it. The file records generation
time, commit, Project URL, completed and unfinished required items, blockers,
conscious deferrals, evidence links, and a qualification summary derived from
`catalog.json`. Never edit an older snapshot to reflect a priority change;
generate a new dated/versioned snapshot. The live Project remains authoritative.

## Tagged build

Pushing `v*` starts `.github/workflows/release.yml`. Its preflight job repeats the identity, dependency, test, Fallow, and upstream gates before the Windows, Linux x64, Intel macOS, and Apple-silicon macOS matrix can build. Matrix jobs have read-only repository permission and retain their separate CLI archive, native desktop bundles, and platform SHA-256 manifest as workflow artifacts. Only after every matrix job succeeds does one `publish` job receive `contents: write`, download all four artifacts, verify every declared hash and filename, reject missing or duplicate platform output, and create or reconcile one draft release. It refuses to change a published release. GitHub generates categorized notes from merged pull requests using `.github/release.yml`; tags containing a SemVer prerelease suffix are marked as prereleases automatically. Tauri updater metadata remains disabled until Portcove has an explicit signed desktop self-update contract.

## Release rehearsal

Run the **Release** workflow manually from GitHub Actions before the first v1 tag or after changing packaging. A manual run executes the same preflight and four-platform build matrix, but the publisher is skipped and every GitHub Release mutation remains disabled. Each runner retains the exact input that a tagged publisher would consume for seven days. Download the four `release-build-*` artifacts together and run `scripts/reconcile-release-assets.mjs` against their containing directory to rehearse the same complete-matrix and checksum contract locally; a rehearsal never creates a tag, draft release, or published release.

From an authenticated GitHub CLI, start and follow the rehearsal with:

```powershell
gh workflow run release.yml --ref main
gh run list --workflow release.yml --event workflow_dispatch --limit 1
```

The rehearsal proves that the current commit can produce packages on hosted builders. It does not replace signing, installation, gameplay, controller, or other hands-on validation tracked in the live Portcove Roadmap.

Before publishing the draft:

1. confirm the aggregate `SHA256SUMS.txt` and four platform manifests cover every CLI archive and desktop bundle;
2. review and commit the generated readiness snapshot for the exact target;
3. compare release notes with live Blocked & Deferred items so manual or signing work is not overstated;
4. keep unsigned artifacts clearly identified until the signing issue has matching completion evidence;
5. perform the target-shell and hands-on checks appropriate to the release; and
6. publish only after the draft contents, version, channel, snapshot, and Project readiness are correct.

Creating a tag does not authorize weakening catalog integrity, embedding game data, or marking deferred gameplay and operating-system observations as complete.

## Optional signed catalog publication

`scripts/sign-catalog.mjs` signs an explicit catalog file using an existing Ed25519 PKCS#8 private key file and writes a new envelope without overwriting an existing output. This is offline publisher tooling, not a production key generator or hosted release workflow. The consumer trusts no publisher by default. Configure custody, recovery, rotation, a strictly increasing catalog sequence, and an independently verifiable public-key distribution channel before publishing a production feed. A catalog signature is neither an application code signature nor desktop updater authorization. Exact invocation and verification steps are in [SIGNED-CATALOG.md](SIGNED-CATALOG.md).
