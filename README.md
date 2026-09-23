<p align="center">
  <img src="apps/desktop/assets/brand/generated/v2/portcove-logo-v2-transparent.png" alt="Portcove logo" width="560">
</p>

<h1 align="center">Portcove</h1>

<p align="center">
  Install and manage decompilations, recompilations, and other native game ports from one local library.
</p>

<p align="center">
  <a href="#project-status">Project status</a> ·
  <a href="https://github.com/boburning/portcove/releases">Download</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/users/boburning/projects/1">Roadmap</a>
</p>

Portcove helps you install, launch, and update native game ports from one local
library. Add the original game files each port needs, then manage installed
versions and backups in the desktop app or CLI.

Existing Alpha 1 libraries can be carried forward with the documented
[upgrade and recovery procedure](docs/UPGRADING.md).

> [!NOTE]
> Portcove does not include or download ROMs, disc images, BIOS files, or other
> copyrighted game data. It checks original game files locally and does not
> upload them. You can use their current location, copy them into Portcove, or
> explicitly move them after reviewing the consequences. A completed Move
> removes the original only after a verified managed copy is registered.

## What Portcove does

- Browse a catalog of native ports and manage them as one library.
- Check original game files locally. A saved game-file location can point to the
  current file; a Source Inbox Copy leaves the original in place, while Move
  requires separate authorization. Portcove checks known exact identities and
  records a local baseline to detect later changes.
- Refuse release archives that cannot be matched to a SHA-256 published upstream—directly or in a checksum sidecar—or pinned in the catalog for a retired project.
- Keep installed versions side by side so updates can be staged, activated, verified, or rolled back.
- Keep the saved data declared for a port, such as its known save, settings, and
  mod locations, separately from installed versions; back up and restore that
  managed data. This does not establish save compatibility across game versions.
- Adopt an existing installation by copying it into Portcove without changing the original.
- Provide the same behavior through a keyboard- and controller-friendly Tauri app or an automation-focused CLI with JSON, JSONL, schemas, and stable exit codes.

Portcove keeps its library, saved game-file locations, and application state
local. A GitHub account is optional and is used only to raise the API rate
limit; startup and launching do not depend on an account or a Portcove-hosted
service.

## Project status

> [!WARNING]
> **Latest technical preview: Alpha 2 — onboarding and storage**
>
> Portcove is under active development. It is intended for maintainers and technically comfortable testers using disposable or fully backed-up libraries—not general users or irreplaceable setups.

[Portcove 0.1.0-alpha.2](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2)
is released as an immutable prerelease. It adds first-play source onboarding,
safe Copy and authorized Move intake, shared tool setup, library and per-game
storage controls, recoverable relocation, and the documented Alpha 1 upgrade
path. Alpha 1 remains available with its frozen release evidence.

A port appearing in the catalog does **not** mean every platform has completed hands-on testing. Upstream availability, automated checks, and Portcove's own manual testing are tracked separately for each port and platform.

Current priorities and blockers live in the public [Portcove Roadmap](https://github.com/users/boburning/projects/1). The meaning of Alpha, Beta, RC, and V1 lives in [docs/ROADMAP.md](docs/ROADMAP.md). The catalog can continue growing without turning every newly discovered port into a V1 blocker.

## Download the technical alpha

For the graphical app, choose a **Desktop** package for your operating system
and processor from the [Alpha 2 release](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2).
For terminal use, choose the separate **CLI** archive. The desktop app does not
require that archive, and the CLI archive is not a graphical app. GitHub's
generated **Source code** archives are for building Portcove yourself.

| System                            | Desktop package                                                                                                       | Standalone CLI archive          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Windows x64                       | `Portcove_0.1.0-alpha.2_x64-setup.exe`                                                                                | `portcove-windows-x86_64.zip`   |
| Linux x64, experimental           | `Portcove_0.1.0-alpha.2_amd64.AppImage`, `Portcove_0.1.0-alpha.2_amd64.deb`, or `Portcove-0.1.0-alpha.2-1.x86_64.rpm` | `portcove-linux-x86_64.tar.gz`  |
| macOS Intel, experimental         | `Portcove_0.1.0-alpha.2_x64.dmg`                                                                                      | `portcove-macos-x86_64.tar.gz`  |
| macOS Apple silicon, experimental | `Portcove_0.1.0-alpha.2_aarch64.dmg`                                                                                  | `portcove-macos-aarch64.tar.gz` |

These are the published Alpha 2 choices; check the selected release page for
later versions and their limitations. Application upgrades are manual. Before
opening an existing library, follow the [upgrade and recovery
steps](docs/UPGRADING.md). Read the [Alpha 2 release
notes](docs/releases/0.1.0-alpha.2-release-notes.md) for package scope and
known limitations.

### Verify a download

Download `SHA256SUMS-<platform>.txt` or `SHA256SUMS.txt` from the same release
and compare the complete SHA-256 on the line for the exact filename you chose.
Stop if the entry is missing, duplicated, conflicting, or mismatched. A matching
checksum establishes agreement with that manifest; it does not identify an OS
publisher or prove gameplay support.

The current release workflow is designed to include an SPDX 2.3 JSON software
bill of materials and GitHub artifact attestations for the final tagged files
in future releases. Its aggregate checksum manifest covers the packages and
the SBOM before a draft release is created. Check the actual assets and
attestations for the version you choose: the published Alpha 2 release lists
package and checksum files, but no SBOM. These records do not replace an
operating-system publisher signature or hands-on package qualification.

Windows packages lack Authenticode signing and may show unknown-publisher or
reputation warnings. macOS packages lack Developer ID signing and notarization
and may be blocked by platform policy. Keep operating-system security
protections enabled. Linux and macOS have hosted build/test evidence, but not
equivalent hands-on desktop package qualification. The [Alpha 1
notes](docs/releases/0.1.0-alpha.1-release-notes.md) remain available for
people upgrading from that preview.

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

- Rust 1.98.1
- Node.js 24.21.0
- pnpm 12.4.2
- the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)

On Windows, keep the checkout on a non-system drive. The repository preflight blocks heavy work when the workspace, build output, temporary data, or package store resolves to the system drive. See [docs/DEVELOPMENT-STORAGE.md](docs/DEVELOPMENT-STORAGE.md) for details.

Run the desktop app from the repository root:

```powershell
node scripts/dev-storage.mjs preflight
node scripts/dev-storage.mjs run -- corepack pnpm install --frozen-lockfile
node scripts/dev-storage.mjs run -- corepack pnpm --dir apps/desktop desktop:dev
```

Build the CLI:

```powershell
node scripts/dev-storage.mjs run -- cargo build -p portcove-cli --release
```

This package-selecting Cargo build compiles `portcove-cli` and `portcove-core`;
it does not build the desktop UI or require Node, pnpm, Tauri CLI, WebView, or
frontend packages. A released CLI is still an operating-system-native program,
not a dependency-free universal binary: use the archive matching Windows x64,
GNU/Linux x64, Intel macOS, or Apple-silicon macOS. Linux hosts need their normal
C runtime and D-Bus/secret-service support when saved credentials are used;
macOS and Windows use their system credential facilities.

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

Set `PORTCOVE_LIBRARY` or pass `--library <path>` to use a specific library root. The CLI is designed for scripts and external frontends; it does not require the desktop app. Current machine behavior is documented in [docs/CLI.md](docs/CLI.md), and the capability, ownership, and frontend-support model is documented in [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Documentation and contributing

Start with the [documentation map](docs/README.md). Deeper references cover the [architecture](docs/ARCHITECTURE.md), [catalog policy](docs/CATALOG.md), [CLI contract](docs/CLI.md), [external frontend integration](docs/INTEGRATIONS.md), [release stages](docs/ROADMAP.md), and [security policy](SECURITY.md).

Check the [live roadmap](https://github.com/users/boburning/projects/1) and existing issues before starting work. New ports should normally be added as catalog data or through a reusable family-level adapter rather than one-off behavior in the CLI or desktop app. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## License

Portcove is available under either the [MIT License](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), at your option.
