<h1 align="center">
  <img src="apps/desktop/assets/brand/generated/v2/portcove-logo-v2-transparent.png" alt="Portcove" width="240">
</h1>

**Install, update, and play native game ports.** Portcove brings community-made
ports, including decompilations, recompilations, and engine recreations, into
one local library. Find a project for a game you own, see which edition it needs,
and launch it from the desktop app or a standalone command-line tool.

[Download Preview 2](https://github.com/boburning/portcove/releases/tag/v0.1.0-preview.2)
· [Browse the catalog](https://boburning.github.io/portcove/catalog/browse/index.html)
· [Set up your first game](#your-first-game)

![Library Favorites showing six sample games, five ready to play and Orchard Quest with a Finish setup action](docs/media/readme/library.png)

_Portcove’s desktop interface with a simulated library of fictional games and geometric covers. Captured November 18, 2026._ [Capture details](docs/media/readme/README.md)

<a id="project-status"></a>

## Download Portcove

[Preview 2](https://github.com/boburning/portcove/releases/tag/v0.1.0-preview.2)
is a test release. Try it with a new library or make a complete backup before
opening an existing one. Download the package for your computer and compare
its SHA-256 checksum with the entry in the release’s `SHA256SUMS` file.

| System                        | Desktop download                                                                                                                               | First launch                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Windows x64                   | [Per-user installer (.exe)](https://github.com/boburning/portcove/releases/download/v0.1.0-preview.2/Portcove_0.1.0-preview.2_x64-setup.exe)   | Windows may show a publisher warning because the installer is unsigned.       |
| Linux x64                     | [AppImage](https://github.com/boburning/portcove/releases/download/v0.1.0-preview.2/Portcove_0.1.0-preview.2_amd64.AppImage)                   | Make the file executable, then open it.                                       |
| macOS, Apple silicon or Intel | [Universal disk image (.dmg)](https://github.com/boburning/portcove/releases/download/v0.1.0-preview.2/Portcove_0.1.0-preview.2_universal.dmg) | Experimental. The app is unnotarized. See the release notes for first launch. |

For terminal use, Preview 2 includes a separate [Windows x64 CLI archive](https://github.com/boburning/portcove/releases/download/v0.1.0-preview.2/portcove-cli-0.1.0-preview.2-windows-x86_64.zip).
The desktop app runs on its own. It checks for signed application updates and
asks before installing one. [All releases and nightlies](https://github.com/boburning/portcove/releases)

<a id="download-the-technical-alpha"></a>

Looking for an older build? The [Alpha 2 packages](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2)
and the [Alpha 1 to Alpha 2 upgrade guide](docs/UPGRADING.md) are still available.

## Your first game

1. **Choose a library.** Open Portcove Desktop and select a folder for your library.
2. **Find a port in Discover.** Search for a game or project. Check its target operating system, the original game edition it accepts, and the setup instructions from the port authors.
3. **Supply the originals if needed.** Select the files from your own copy of the game. Portcove checks them on your computer. You can leave them where they are and save their location for reuse.
4. **Review the installation.** For a managed port, check the version and destination, then confirm the install. If the project provides its own installer or expects an existing installation, follow that route in the port’s details.
5. **Play from Library.** When the port is ready, choose **Play**. Some ports finish preparing their game data the first time they run.

Portcove does not supply ROMs, disc images, BIOS files, or commercial game data.
Your original files stay on your computer. You can use the library and launch
installed games without a Portcove or GitHub account.

## Catalog and support

One original game can have several independently maintained ports. When Discover
groups them, you can compare the editions they accept, where they run, and what
has been tested. A catalog entry may point you to the upstream project, help you
register an existing install, or offer an installation that Portcove can manage.
Check the entry for the game and system you want to use. [Explore the catalog](https://boburning.github.io/portcove/catalog/browse/index.html)

![Harbor Adventure game details with Play and the Game files, Saves & backups, Versions & updates, and Manage tabs](docs/media/readme/game-details.png)

_Harbor Adventure in the same simulated library. Open a tab to find its game files, saves, or available updates._

## Manage, check, update and recover

- **Update a port.** For a managed install, review an available release and keep the previous version so you can switch back. An externally managed port uses its own update process.
- **Protect your saves.** Check which saves and settings a port declares. Portcove can back up and restore those files separately from the installed game. Keep a separate backup of your originals. [Saved data and backups](docs/CLI.md#managed-saved-data-and-backups)
- **Check or recover an install.** Run `portcove verify` with the port ID to check its installed files. After an interrupted task, open Activity or run `portcove doctor` to see what needs attention.
- **Try a different setup.** On the development branch, ports with reviewed mod support can keep a clean setup alongside a modded one. Each setup records the build and mod choices it uses. [Local profiles and mod packages](docs/CLI.md#local-profiles-and-mod-packages)

## Use the CLI

Desktop and the CLI share the same library. Use the CLI to inspect a port before
installing it, script a task, or connect another launcher. These commands list projects and inspect Lighthouse,
a native port of Banjo-Kazooie, without changing your library.

```sh
portcove catalog listings
portcove catalog list
portcove catalog show lighthouse
```

`catalog listings` includes projects you can explore upstream. `catalog list`
shows projects with installation definitions. Use `--json` when your script
needs structured output.
[CLI guide](docs/CLI.md) · [Connect another launcher](docs/INTEGRATIONS.md)

## Build from source

### Prerequisites

Use the [pinned Rust toolchain](rust-toolchain.toml), the repository’s [Node](.node-version)
and [pnpm](package.json) versions, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/)
for Desktop. From the repository root, run `node scripts/dev-storage.mts preflight`,
then run the setup script for your system.

```powershell
# Windows
./scripts/bootstrap-quality-tools.ps1 -Profile frontend
```

```sh
# Linux or macOS
./scripts/bootstrap-quality-tools.sh --profile frontend
```

Then start Desktop or build the standalone CLI.

```sh
node scripts/dev-storage.mts run -- pnpm --dir apps/desktop desktop:dev
node scripts/dev-storage.mts run -- cargo build -p portcove-cli --release
```

[Development setup](docs/DEVELOPMENT-TOOLS.md#frontend-workflow) · [Documentation](docs/README.md)

## Contribute

To add or correct a port, start with the [catalog authoring guide](docs/CATALOG.md#adding-or-changing-a-port).
For a bug, include the Portcove version, operating system, port name, and the step
that failed. [Report an issue](https://github.com/boburning/portcove/issues/new/choose)
· [Contributing](CONTRIBUTING.md) · [Roadmap](https://github.com/users/boburning/projects/1)

Portcove uses AI-assisted development. The maintainer is responsible for changes
and releases. Portcove itself is available under the [MIT License](LICENSE-MIT)
or the [Apache License 2.0](LICENSE-APACHE), at your option.
