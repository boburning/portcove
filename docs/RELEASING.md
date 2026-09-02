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

The gate verifies release metadata, Rust formatting/Clippy/tests, the frontend production dependency audit, install/build/tests and contrast contract, Fallow, active catalog repositories, direct PS1 upstream ownership, the native Tauri bundle, and an isolated silent install/respond/uninstall lifecycle. It never uses or modifies the normal Portcove library. Network-backed catalog and dependency checks use the configured credentials or normal anonymous public access.

After it passes, refresh the shareable local artifacts and checksum manifest:

```powershell
.\scripts\package-local.ps1
```

An explicit `-Version` is accepted only when it matches the central release metadata.

## Tagged build

Pushing `v*` starts `.github/workflows/release.yml`. Its preflight job repeats the identity, dependency, test, Fallow, and upstream gates before the Windows, Linux x64, Intel macOS, and Apple-silicon macOS matrix can build. Each platform publishes a separate CLI archive, native desktop bundles, and a SHA-256 manifest to one draft release. GitHub generates categorized notes from merged pull requests using `.github/release.yml`; tags containing a SemVer prerelease suffix are marked as prereleases automatically. Tauri updater metadata remains disabled until Portcove has an explicit signed desktop self-update contract.

Before publishing the draft:

1. confirm every expected platform job completed and every checksum manifest covers its CLI archive and desktop bundle;
2. compare the release notes with `docs/DEFERRED.md` so manual or signing work is not overstated;
3. keep unsigned artifacts clearly identified until `PCV-DEF-009` is resolved;
4. perform the target-shell and hands-on checks appropriate to the release; and
5. publish only after the draft contents, version, and channel are correct.

Creating a tag does not authorize weakening catalog integrity, embedding game data, or marking deferred gameplay and operating-system observations as complete.
