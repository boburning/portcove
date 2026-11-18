<h1 align="center">
  <img src="apps/desktop/assets/brand/generated/v2/portcove-logo-v2-transparent.png" alt="Portcove" width="240">
</h1>

Install, update, and play native game ports. A port is a separate implementation
of an existing game. Portcove keeps community-made ports in one local
library. These include decompilations, recompilations, and engine recreations.
Find a project for a game you own. Check which edition it needs. Start the game
from the desktop app or the standalone command-line tool (CLI).

[Download Portcove](#download-portcove)
· [Browse the catalog](https://boburning.github.io/portcove/catalog/browse/index.html)
· [Set up your first game](#your-first-game)

![Library Favorites showing six sample games, five ready to play and Orchard Quest with a Finish setup action](docs/media/readme/library.png)

_Portcove’s desktop interface with a simulated library of fictional games and geometric covers._ [Capture details](docs/media/readme/README.md)

<a id="project-status"></a>

## Download Portcove

If a release is marked **Latest**, choose it from
[Portcove releases](https://github.com/boburning/portcove/releases).
If you want a preview or only previews are available, choose the newest
**Pre-release** with a tag that starts with `v`. Use **Nightly** builds to test
recent changes. Before you install, read the notes for your system. If you try
a preview, use a new library or back up your existing library first.

Under **Assets**, choose the package for your computer.

| What you want       | Look for                                                                      |
| ------------------- | ----------------------------------------------------------------------------- |
| Windows desktop app | The x64 installer ending in `-setup.exe`                                      |
| Linux desktop app   | The `.AppImage` for your processor. Make it executable before opening.        |
| macOS desktop app   | The `.dmg`. A universal build runs on both Intel and Apple silicon.           |
| Command-line tool   | A `portcove-cli` archive for your operating system and processor, when listed |

Compare the download’s SHA-256 checksum with the entry for that filename in
the same release’s checksum file. The desktop app runs on its own. You only
need a CLI archive if you want to use Portcove from a terminal or another launcher.
You can also [follow release notes and nightlies in a feed reader](https://github.com/boburning/portcove/releases.atom).

<a id="download-the-technical-alpha"></a>

Looking for an older build? The [Alpha 2 packages](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2)
and the [Alpha 1 to Alpha 2 upgrade guide](docs/UPGRADING.md) are still available.

## Your first game

1. Open Portcove Desktop. In the empty Library, choose **Browse games**. Portcove selects a library folder when it opens. If you want a different folder, open **Settings → Library and storage → Choose another library**.
2. In Discover, search for a game or project. Read the target operating systems, accepted game editions, and setup instructions.
3. If the port needs original game files, select them from your own copy of the game. Portcove checks the files on your computer. You can save their location for reuse.
4. If Portcove manages the port, review the version and destination before you confirm the install. If the project uses its own installer or needs an existing installation, follow the instructions in the port’s details.
5. When the port is ready, choose **Play** in Library. Some ports prepare their game data the first time they run.

Portcove does not supply ROMs, disc images, BIOS files, or commercial game data.
Your original files stay on your computer. You can use the library and launch
installed games without a Portcove or GitHub account.

## Catalog and support

Different projects can maintain ports of the same game. When Discover groups
these ports, compare their game editions, operating systems, and test results.
A catalog entry can link to the project, help you add an existing installation,
or offer an installation that Portcove can manage.
For an example, [compare the ports for Majora’s Mask in the live catalog](https://boburning.github.io/portcove/catalog/browse/games/the-legend-of-zelda-majoras-mask/index.html).

![Harbor Adventure game details with Play and the Game files, Saves & backups, Versions & updates, and Manage tabs](docs/media/readme/game-details.png)

_Harbor Adventure in the same simulated library. Open a tab to find its game files, saves, or available updates._

## Manage, check, update and recover

- If Portcove manages the installation, review the available update. Keep the previous version so you can switch back. For other ports, follow the project's update instructions.
- Find out which saves and settings the port lists. Portcove can back up and restore those files separately from the installed game. Back up the original game files separately. [Saved data and backups](docs/CLI.md#managed-saved-data-and-backups)
- To check an installation, run `portcove verify` with the port ID. If a task stops before it finishes, open Activity or run `portcove doctor`.
- On the development branch, ports with reviewed mod support can keep a setup without mods alongside a modded one. Each setup records its build and mods. [Local profiles and mod packages](docs/CLI.md#local-profiles-and-mod-packages)

## Use the CLI

Desktop and the CLI normally open the same library. Opening a library can create its
database or upgrade it for this version. You can browse without writing local files
in the [web catalog](https://boburning.github.io/portcove/catalog/browse/index.html).

If a folder does not contain `portcove-demo`, you can try the CLI there. These
commands create a separate library, list ports, and show Lighthouse. Lighthouse
is a native port of Banjo-Kazooie.

```sh
portcove --library "$PWD/portcove-demo" catalog list
portcove --library "$PWD/portcove-demo" catalog show lighthouse
```

If `portcove catalog --help` lists `listings`, run
`portcove --library "$PWD/portcove-demo" catalog listings` to include projects
you can explore upstream. `catalog list`
shows projects with installation definitions. Use `--json` when your script
needs structured output.
[CLI guide](docs/CLI.md) · [Connect another launcher](docs/INTEGRATIONS.md)

## Build from source

### Prerequisites

Install the [pinned Rust toolchain](rust-toolchain.toml) and its build prerequisites
for your operating system.

**Standalone CLI.** From the repository root, run:

```sh
cargo build --locked --release -p portcove-cli
```

The executable is in `target/release` unless you configured a different Cargo
target directory. See the [CLI build requirements](docs/CLI.md).

**Desktop.** Also install the pinned [Node](.node-version) and [pnpm](package.json)
versions and the [Tauri prerequisites for your platform](https://v2.tauri.app/start/prerequisites/).
Run `node scripts/dev-storage.mts preflight` from the repository root, then bootstrap
the frontend tools.

```powershell
# Windows
./scripts/bootstrap-quality-tools.ps1 -Profile frontend
```

```sh
# Linux or macOS
./scripts/bootstrap-quality-tools.sh --profile frontend
```

Start Desktop from the repository root.

```sh
node scripts/dev-storage.mts run -- pnpm --dir apps/desktop desktop:dev
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
