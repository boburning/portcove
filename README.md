<p align="center">
  <img src="apps/desktop/assets/brand/generated/v2/portcove-logo-v2-transparent.png" alt="Portcove logo" width="560">
</p>

<h1 align="center">Portcove</h1>

<p align="center">
  Install and manage decompilations, recompilations, and other native game ports from one local library.
</p>

<p align="center">
  <a href="#project-status">Project status</a> ·
  <a href="#technical-alpha-downloads">Downloads</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/users/boburning/projects/1">Roadmap</a>
</p>

Native ports are easier to find than they used to be, but they are still awkward to live with. Every project has its own release page, expected game revision, install layout, save folders, and update process. Portcove gives those moving parts one home.

Portcove is a local desktop app and CLI built around a shared Rust core. It can connect the game files required by an upstream project, install a checksum-matched release, launch it, and keep saves intact through updates or rollbacks.

> [!NOTE]
> Portcove does not include or download ROMs, disc images, BIOS files, or other copyrighted game data. Required source files stay on your computer and are not modified.

## What Portcove does

- Browse a catalog of native ports and manage them as one library.
- Register local game files without uploading them. Portcove enforces exact hashes when the catalog has them and records a local size and SHA-256 baseline to detect later changes.
- Refuse release archives that cannot be matched to a SHA-256 published upstream—directly or in a checksum sidecar—or pinned in the catalog for a retired project.
- Keep installed versions side by side so updates can be staged, activated, verified, or rolled back.
- Preserve known save, configuration, and mod folders separately from application versions, with independent backup and restore.
- Adopt an existing installation by copying it into Portcove without changing the original.
- Provide the same behavior through a keyboard- and controller-friendly Tauri app or an automation-focused CLI with JSON, JSONL, schemas, and stable exit codes.

Portcove keeps its library, source references, and application state local. A GitHub account is optional and is used only to raise the API rate limit; startup and launching do not depend on an account or a Portcove-hosted service.

## Project status

> [!WARNING]
> **Current stage: Alpha 1 — trustworthy technical alpha**
>
> Portcove is under active development. It is intended for maintainers and technically comfortable testers using disposable or fully backed-up libraries—not general users or irreplaceable setups.

The catalog and state commands are usable, and the core install, update, launch, backup, and recovery paths are in place. Later stages focus on source onboarding, storage controls, frontend integrations, physical platform testing, packaging, and general product hardening.

A port appearing in the catalog does **not** mean every platform has completed hands-on testing. Upstream availability, automated checks, and Portcove's own manual testing are tracked separately for each port and platform.

Current priorities and blockers live in the public [Portcove Roadmap](https://github.com/users/boburning/projects/1). The meaning of Alpha, Beta, RC, and V1 lives in [docs/ROADMAP.md](docs/ROADMAP.md). The catalog can continue growing without turning every newly discovered port into a V1 blocker.

## Technical alpha downloads

[GitHub Releases](https://github.com/boburning/portcove/releases) is the download
route for packaged technical previews as they become available. Check the
prerelease entry and its notes; source builds remain available below.

| System | Desktop package | Separate CLI archive |
|---|---|---|
| Windows x64 | `Portcove_<version>_x64-setup.exe` | `portcove-windows-x86_64.zip` |
| Linux x64 (experimental) | AppImage, `.deb`, or `.rpm` | `portcove-linux-x86_64.tar.gz` |
| macOS Intel (experimental) | `Portcove_<version>_x64.dmg` | `portcove-macos-x86_64.tar.gz` |
| macOS Apple silicon (experimental) | `Portcove_<version>_aarch64.dmg` | `portcove-macos-aarch64.tar.gz` |

Use the package for your operating system and architecture. GitHub's **Source
code** archives are not runnable desktop or CLI packages. Verify the downloaded
file against its matching line in the release's SHA-256 manifest before use.
Windows packages lack Authenticode signing; macOS packages lack Developer ID
signing/notarization. Linux and macOS have hosted build/test evidence, but not
equivalent hands-on desktop package qualification. Application upgrades are
manual. Read the [Alpha 1 notes](docs/releases/0.1.0-alpha.1-release-notes.md)
for setup, checksum examples, recovery scope, and known limitations.

## Catalog and support

The catalog changes too quickly for a hand-maintained count or title list here. Browse it in the desktop app, through the CLI, or directly in [`catalog.json`](crates/portcove-core/catalog/catalog.json).

```text
portcove catalog list
portcove catalog show <port-id>
portcove --json catalog export
```

Each entry records its upstream project, platforms, release channels, required local files, executable layout, user-data paths, and current test evidence. Stable, beta, and rolling are release channels—not quality ratings. See [docs/CATALOG.md](docs/CATALOG.md) for the full policy.

## Build from source

Requirements:

- Rust 1.88 or newer
- Node.js 24
- pnpm 11
- the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)

On Windows, keep the checkout on a non-system drive. The repository preflight blocks heavy work when the workspace, build output, temporary data, or package store resolves to the system drive. See [docs/DEVELOPMENT-STORAGE.md](docs/DEVELOPMENT-STORAGE.md) for details.

Run the desktop app from the repository root:

```powershell
node scripts/dev-storage.mjs preflight
node scripts/dev-storage.mjs run -- pnpm --dir apps/desktop install --frozen-lockfile
node scripts/dev-storage.mjs run -- pnpm --dir apps/desktop desktop:dev
```

Build the CLI:

```powershell
node scripts/dev-storage.mjs run -- cargo build -p portcove-cli --release
```

For repository checks, packaging, and release work, see [CONTRIBUTING.md](CONTRIBUTING.md), [docs/QUALITY.md](docs/QUALITY.md), and [docs/RELEASING.md](docs/RELEASING.md).

## CLI quick tour

This example uses Lighthouse, the Banjo-Kazooie native port:

```text
portcove about
portcove doctor
portcove catalog show lighthouse
portcove source add banjo-kazooie "/path/to/Banjo-Kazooie.z64"
portcove plan lighthouse
portcove install lighthouse
portcove exec lighthouse
```

Use `--json` for one-result machine output and `--jsonl` for streaming operations:

```text
portcove --json check --all
portcove --jsonl reconcile lighthouse
```

Set `PORTCOVE_LIBRARY` or pass `--library <path>` to use a specific library root. The CLI is designed for scripts and external frontends; it does not require the desktop app. The complete integration contract is documented in [docs/CLI.md](docs/CLI.md).

## Documentation and contributing

Start with the [documentation map](docs/README.md). Deeper references cover the [architecture](docs/ARCHITECTURE.md), [catalog policy](docs/CATALOG.md), [CLI contract](docs/CLI.md), [release stages](docs/ROADMAP.md), and [security policy](SECURITY.md).

Check the [live roadmap](https://github.com/users/boburning/projects/1) and existing issues before starting work. New ports should normally be added as catalog data or through a reusable family-level adapter rather than one-off behavior in the CLI or desktop app. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## License

Portcove is available under either the [MIT License](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), at your option.
