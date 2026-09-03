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

## Tagged build

Pushing `v*` starts `.github/workflows/release.yml`. Its preflight job repeats the identity, dependency, test, Fallow, and upstream gates before the Windows, Linux x64, Intel macOS, and Apple-silicon macOS matrix can build. Matrix jobs have read-only repository permission and retain their separate CLI archive, native desktop bundles, and platform SHA-256 manifest as workflow artifacts. Only after every matrix job succeeds does one `publish` job receive `contents: write`, download all four artifacts, verify every declared hash and filename, reject missing or duplicate platform output, and create or reconcile one draft release. It refuses to change a published release. GitHub generates categorized notes from merged pull requests using `.github/release.yml`; tags containing a SemVer prerelease suffix are marked as prereleases automatically. Tauri updater metadata remains disabled until Portcove has an explicit signed desktop self-update contract.

## Release rehearsal

Run the **Release** workflow manually from GitHub Actions before the first v1 tag or after changing packaging. A manual run executes the same preflight and four-platform build matrix, but the publisher is skipped and every GitHub Release mutation remains disabled. Each runner retains the exact input that a tagged publisher would consume for seven days. Download the four `release-build-*` artifacts together and run `scripts/reconcile-release-assets.mjs` against their containing directory to rehearse the same complete-matrix and checksum contract locally; a rehearsal never creates a tag, draft release, or published release.

From an authenticated GitHub CLI, start and follow the rehearsal with:

```powershell
gh workflow run release.yml --ref main
gh run list --workflow release.yml --event workflow_dispatch --limit 1
```

The rehearsal proves that the current commit can produce packages on hosted builders. It does not replace signing, installation, gameplay, controller, or other hands-on validation tracked in `docs/DEFERRED.md`.

Before publishing the draft:

1. confirm the aggregate `SHA256SUMS.txt` and four platform manifests cover every CLI archive and desktop bundle;
2. compare the release notes with `docs/DEFERRED.md` so manual or signing work is not overstated;
3. keep unsigned artifacts clearly identified until `PCV-DEF-009` is resolved;
4. perform the target-shell and hands-on checks appropriate to the release; and
5. publish only after the draft contents, version, and channel are correct.

Creating a tag does not authorize weakening catalog integrity, embedding game data, or marking deferred gameplay and operating-system observations as complete.
