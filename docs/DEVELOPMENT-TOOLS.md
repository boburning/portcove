# Development tools

`just doctor` reads the current host and emits a concise prerequisite report.
`node scripts/dev-doctor.mjs --json` emits format version 1: workspace, platform,
tools, storage, and Windows compiler candidates. Required missing or mismatched
tools and storage failures return exit 1. Optional tools do not block readiness.
Raw subprocess output and environment variables are not dumped. The command does
not install tools, create output directories or modify host configuration.

The doctor reads existing quality pins, `.node-version`, and the desktop package
manager declaration. On Windows it reports MSVC installations and PATH candidates;
this is not proof of Cargo's auto-selected linker. Inspect a verbose native build
when compiler selection matters. Keep each worktree's Cargo target separate and
use the existing development-storage wrapper for heavy commands.

## Skills

Repository-local skills under `.agents/skills` describe port qualification,
release validation, roadmap reconciliation and desktop verification. They resolve
contracts from the active checkout. General architecture and quality obligations
remain in `AGENTS.md`; skills do not become a parallel implementation or planning
authority. The reusable Windows diagnostics skill is installed in the user's
Codex skill directory and can be used outside Portcove.

## Native desktop smoke tests

Install `tauri-driver` 2.0.6 and a Microsoft Edge WebDriver matching the installed
WebView2 runtime on Windows. Linux needs WebKitWebDriver and a graphical session.
The external driver path adds no automation plugin to the product. Native macOS
execution is not supported by this harness.
The pinned Selenium client connects to the explicitly started driver server;
the harness does not invoke Selenium Manager or provision browsers automatically.

Build the frontend and a desktop binary with embedded assets using the storage
wrapper (`pnpm --dir apps/desktop build`, then `cargo build -p portcove-desktop
--features tauri/custom-protocol`). A plain debug build expects a Vite server and
cannot establish the packaged-assets smoke claim. Then run:

```powershell
just desktop-test --app <absolute-desktop-executable> --driver <absolute-tauri-driver> --native-driver <absolute-platform-driver> --output <new-absolute-directory>
```

The output parent must already exist. `--port` defaults to 4444 and the native
driver uses the following port; choose unused ports. The new output directory
contains an isolated library, host preference file, WebView2 profile on Windows,
screenshots, bounded driver logs, accessibility results and `evidence.json`.
Never reuse a failed run directory or point this harness at an existing library.

To exercise explicit preparation, additionally pass `--preparation-cli
<absolute-CLI-executable> --preparation-tool <absolute-owned-probe>`. Build the CLI
from the same source and compile the repository's
`crates/portcove-core/src/testdata/host_tool_probe.rs.txt` with `rustc --crate-name
portcove_host_tool_fixture -o <absolute-owned-probe>`. These optional scenarios
adopt copies of that redistributable fixture into the new test library, register
synthetic sources, review and confirm preparation through the actual UI, exercise
Play without setup, and cancel an active native setup through the UI. They do not
acquire upstream artifacts or establish game compatibility. CLI/tool hashes and
the additional harness source are retained in the evidence inputs.

The same owned fixture also checks the desktop's game-update settings: changing
a selection stays local until Save, and saving leaves active/staged/previous
installations and the activity ledger unchanged. This does not download a game
update or establish live upstream update compatibility.

The smoke scenarios exercise native IPC/bootstrap, an empty library, a rejected
operation with usable state afterward, keyboard focus/compact layout, appearance
persistence over a real process restart, and automated accessibility checks.
Install/progress/cancellation requires a reviewed artifact fixture and is
explicitly not-run in this smoke suite. Core/component tests and human acceptance
remain separate. An incomplete report is not full desktop qualification.

`development-evidence.mjs` writes format version 1 observations with a full
revision, executable hash, method, scenario outcomes, and hashed artifact
references. It never overwrites a report. Artifact references are local paths;
retain the directory when handing off results. The revision is source context,
not proof an externally supplied executable was built from that revision.

## Rust test runner

Use `just rust-test` and the cargo-nextest version pinned in the existing quality
manifest. The standard wrapper prepares native test fixtures and retains the
repository's scheduling configuration; doctests run in Cargo separately. Do not
duplicate this orchestration in a skill or a competing recipe. Record cold
compilation separately from warm test execution when comparing performance.

## Targeted safety experiments

The core property tests generate archive-path aliases and digest/scope combinations.
Run `cargo test -p portcove-core --lib property_` through the storage wrapper.
For diagnostic coverage, `cargo-llvm-cov` 0.9.1 and the pinned Rust toolchain's
`llvm-tools-preview` component support `cargo llvm-cov test -p portcove-core --lib
--lcov --output-path outputs/property-coverage.lcov property_`. This intentionally
scoped report is not a whole-project coverage score or a new acceptance threshold.

Use the existing mutation tool on a disposable source snapshot with isolated
build output. Windows source copying can fail on frontend dependency symlinks;
an archive of the reviewed Git tree avoids copying those dependencies. A bounded
digest-identity mutation is useful evidence that these assertions detect an
incorrect match; it does not establish mutation coverage for the whole core.

## Unattended execution

Subscription-backed scheduled tasks are not, by themselves, an isolated
engineering controller. They inherit app permissions. Do not schedule candidate
execution with full host access or rely on skill prose to restrict its commands.
Issue #284 owns the separate feasibility/authority proof. No paid API fallback,
credential migration, signing permission or standing merge authority is implied
by these development tools.
