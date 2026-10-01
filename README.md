<p align="center">
  <img src="apps/desktop/assets/brand/generated/v2/portcove-logo-v2-transparent.png" alt="Portcove logo" width="160">
</p>

<h1 align="center">Portcove</h1>

<p align="center">
  Install, update, and play native game ports.
</p>

<p align="center">
  <a href="#project-status">Project status</a> ·
  <a href="https://github.com/boburning/portcove/releases">Download</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/users/boburning/projects/1">Roadmap</a>
</p>

Portcove brings native game ports into one local library. Choose a port, add the
game files it needs, and use the desktop app or command-line tool to manage
supported installations, updates, and backups. Some ports use an existing
installation rather than installing or updating files through Portcove.

![Portcove's actual catalog, with Ship of Harkinian ready to play](docs/media/first-play/catalog.png)

_Windows development build, October 1, 2026: an installed game, available ports,
and real mixed artwork. This is the application, not a mockup; the pictured
design and default covers are newer than the published Alpha 2 preview._

Existing Alpha 1 libraries can be carried forward with the documented
[upgrade and recovery procedure](docs/UPGRADING.md).

> [!NOTE]
> Portcove does not include or download ROMs, disc images, BIOS files, or other
> copyrighted game data. It checks game files locally and does not
> upload them. You can use their current location, copy them into Portcove, or
> explicitly move them after reviewing the consequences. A completed Move
> removes the original only after a verified managed copy is registered.

## What Portcove does

- Browse a catalog of native ports and manage them as one library.
- Check game files locally. A saved location can point to the
  current file; copying into Portcove leaves the original in place, while Move
  requires separate authorization. Portcove checks known exact identities and
  records a local baseline to detect later changes.
- Check downloaded files against the expected checksum before installing them.
  Current hosted releases use provider digests or checksum sidecars; accepted
  direct manifests pin exact artifacts. Catalog-curated acquisition is planned
  under [#315](https://github.com/boburning/portcove/issues/315).
- Keep managed versions side by side so updates can be saved for later, installed, checked, or rolled back.
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

| System                            | Desktop package                                                                                                                                                                                                                                                                                                                                                                                                                                          | Standalone CLI archive                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64                       | [Portcove_0.1.0-alpha.2_x64-setup.exe](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/Portcove_0.1.0-alpha.2_x64-setup.exe)                                                                                                                                                                                                                                                                                                      | [portcove-windows-x86_64.zip](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/portcove-windows-x86_64.zip)     |
| Linux x64, experimental           | [Portcove_0.1.0-alpha.2_amd64.AppImage](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/Portcove_0.1.0-alpha.2_amd64.AppImage), [Portcove_0.1.0-alpha.2_amd64.deb](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/Portcove_0.1.0-alpha.2_amd64.deb), or [Portcove-0.1.0-alpha.2-1.x86_64.rpm](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/Portcove-0.1.0-alpha.2-1.x86_64.rpm) | [portcove-linux-x86_64.tar.gz](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/portcove-linux-x86_64.tar.gz)   |
| macOS Intel, experimental         | [Portcove_0.1.0-alpha.2_x64.dmg](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/Portcove_0.1.0-alpha.2_x64.dmg)                                                                                                                                                                                                                                                                                                                  | [portcove-macos-x86_64.tar.gz](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/portcove-macos-x86_64.tar.gz)   |
| macOS Apple silicon, experimental | [Portcove_0.1.0-alpha.2_aarch64.dmg](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/Portcove_0.1.0-alpha.2_aarch64.dmg)                                                                                                                                                                                                                                                                                                          | [portcove-macos-aarch64.tar.gz](https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/portcove-macos-aarch64.tar.gz) |

These are the published Alpha 2 choices; check the selected release page for
later versions and their limitations. Application upgrades are manual. Before
opening an existing library, follow the [upgrade and recovery
steps](docs/UPGRADING.md). Read the [Alpha 2 release
notes](docs/releases/0.1.0-alpha.2-release-notes.md) for package scope and
known limitations.

Windows packages are unsigned; macOS packages are unsigned and not notarized.
Keep operating-system security protections enabled. Linux and macOS remain
experimental, with hosted build/test evidence and incomplete hands-on package
qualification. [Verify the download and read the signing/SBOM limits](docs/DOWNLOADS.md)
before opening it.

## Your first game

Use a disposable or backed-up library for this technical preview.

The screenshots show the current development build. In the published Alpha 2
app, **Review install** presents the plan inline, and the launch action is
**Play now** or **Complete setup and play**. The newer build uses the labels
below and a separate installation-review dialog.

1. Open **Portcove Desktop** and choose the local library you intend to use.
2. Open **Port catalog**, choose a port, and read its game-file requirements and
   recorded platform evidence. A catalog entry alone does not establish support.
3. Choose your own required game files, or enter their local path. Portcove
   checks them locally when you continue installation. An unsupported or changed
   input needs attention; do not substitute another edition blindly.
4. Choose **Review installation**. Check the version, download size and install
   folder, then confirm **Install**. Wait for verification and preparation to finish.
5. When the game is **Ready to play**, choose **Play**. Some ports perform their
   own first-launch preparation or ask a further question. Close the game normally
   to return to Portcove.

This [captured Windows development-build journey](docs/media/first-play/README.md)
shows Ship of Harkinian installing from a verified package, recognizing an exact
Ocarina of Time source, preparing its game data, and reaching the title screen.
It is separate from Alpha 2 package qualification and does not establish gameplay,
audio, save compatibility or physical-controller behavior.

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
- pnpm 12.7.0
- the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)

Development storage defaults are portable: a checkout may use the Windows system drive when its physical paths and free capacity pass preflight. Prefer an SSD for fixture-heavy work. A stricter machine-local policy can impose additional restrictions without changing repository defaults. See [docs/DEVELOPMENT-STORAGE.md](docs/DEVELOPMENT-STORAGE.md) for the storage checks and private-policy boundary.

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

Check the [live roadmap](https://github.com/users/boburning/projects/1) and
existing issues before starting work. Prefer catalog data and shared core
adapters; use small title-specific core code when it enables a bounded useful
route without duplicating lifecycle authority. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## License

Portcove is available under either the [MIT License](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), at your option.

## Development and responsibility

Portcove uses AI-assisted development. The project owner is responsible for the
changes and release decisions. Published test evidence describes its actual
scope; it does not guarantee every port, platform or personal library.

See the [contributor workflow](CONTRIBUTING.md), [quality checks](docs/QUALITY.md),
[architecture](docs/ARCHITECTURE.md) and [documentation index](docs/README.md).
