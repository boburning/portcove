# Code quality and codebase intelligence

Portcove uses one local quality interface for humans, CI, and coding agents. The bootstrap requires Cargo/Rust, Node 24, and PowerShell 7 on Windows or Bash on Linux/macOS. Install the pinned tools with:

```powershell
.\scripts\bootstrap-quality-tools.ps1
```

```bash
./scripts/bootstrap-quality-tools.sh
```

Pass `-IncludeDeep` or `--include-deep` to also install semdup, cargo-mutants, and Hawk where supported. Both scripts are idempotent, verify and print exact installed versions, and never silently upgrade tools. Deep tools remain optional: Hawk requires exactly Rust 1.98 and does not support Windows, while semdup 0.2.0 requires a current native C++ linker for its ONNX runtime.

## Canonical commands

| Scope | Command | Purpose |
|---|---|---|
| Rust change | `just check-rust` | format, compile, Clippy, tests, unused dependencies/files, and crate boundaries |
| UI change | `just check-ui` | production build, tests, and the existing Fallow gate |
| Cross-stack change | `just check` | both fast loops |
| Substantial completion | `just audit` | fast loop plus dependency policy, the current module-cycle report, and rscheck |
| Large structural change | `just deep` | audit plus advisory Hawk and semdup analysis |
| Critical core test review | `just mutants` | optional mutation analysis for `portcove-core` |

Deterministic failures block: rustfmt, Cargo compilation, Clippy, tests, cargo-shear, cargo-deny security/license/source policy, the Cargo-metadata architecture checker, Fallow, and rscheck's absolute-path rule outside reviewed exceptions.

Structural heuristics advise: dependency duplication, unmaintained transitive dependencies, complexity, responsibility splits, god objects, duplicate logic, dead public APIs, semantic duplication, and mutation survivors. Do not refactor simply to make an advisory number green.

pnpm 11's default one-day minimum release age remains active. The workspace contains exact-version-only exceptions for the Fallow 3.22.0 platform set and Lucide 1.39.0 used during this reviewed modernization pass; future versions are not exempt. Do not replace these with package-wide patterns or disable lockfile verification.

## Pinned tool versions

- just 1.58.0
- cargo-shear 1.13.4
- cargo-deny 0.20.2
- cargo-modules 0.27.0
- rscheck-cli 0.1.0
- cargo-hawk 0.1.13 with Rust 1.98.0, optional
- semdup 0.2.0, optional
- cargo-mutants 27.1.0, optional

CI installs the required exact versions through a commit-pinned installer action with checksum verification. The local bootstrap scripts use cargo-binstall when available and exact, locked Cargo installs otherwise; optional deep tools remain outside required PR CI.

## Architecture gate

`scripts/check-rust-architecture.mjs` reads `cargo metadata --format-version 1 --no-deps`; it never scrapes manifests. It requires both adapters to depend on `portcove-core`, prevents core from depending on CLI/Tauri/desktop concerns, and prevents either adapter from depending on its peer. Add future layer rules to the checker data rather than writing a second checker.

## Dependency policy

`deny.toml` allows only the permissive licenses currently required by the resolved graph. It denies wildcard registry versions and unknown registry or Git sources. Local workspace path dependencies are intentionally permitted because all three workspace packages are private. Duplicate versions remain warnings until their upstream dependency chains converge.

GitHub vulnerability alerts and automated Dependabot security fixes are enabled for `boburning/portcove`. Weekly Cargo, npm, and GitHub Actions updates remain configured in `.github/dependabot.yml`; major versions are no longer blanket-ignored and related ecosystems are grouped for coherent review.

Current Tauri Linux dependencies transitively include the unmaintained GTK3 binding family; other transitive build paths include `proc-macro-error` and the `unic-*` family. `cargo deny check --hide-inclusion-graph -W unmaintained` keeps these visible while continuing to deny security advisories, while omitting thousands of lines of repeated transitive paths from the normal audit. There is no safe direct Portcove upgrade that removes the GTK3 set without changing Tauri's Linux webview architecture.

GitHub also reports GHSA-wrw7-89jp-8q8g for Tauri's Linux-only `glib 0.18.5` graph. Dependabot confirms that `0.18.5` is the newest version compatible with Tauri's GTK3 stack while the advisory declares `0.20.0` as the first fixed release. Keep that alert open and tracked as `PCV-DEF-014`; do not conceal it with a version-only dismissal, an unreviewed fork, or a broad advisory exception. Re-evaluate when Tauri adopts a compatible maintained GTK stack.

## Initial structural baseline

The 2026-09-02 baseline is classified as follows:

- **A — defect or dangerous architecture issue:** none after deterministic checks.
- **B — clear low-risk cleanup:** cargo-shear identified and removed three manifest-only dependencies (`tracing` from the CLI; `serde_json` and `tokio` from the Tauri adapter).
- **C — existing design debt:** `catalog::validate`, CLI `execute`, and `adapter::launch_spec` exceed the initial function-complexity threshold. `Library` and `PortcoveService` have broad impl surfaces. Improve these only when nearby product work reveals a stable domain boundary.
- **D — intentional or tool limitation:** reviewed DolphinTool/chdman discovery locations and Windows path-rewrite fixtures are exact rscheck path exceptions. cargo-modules 0.27 reports type-to-associated-item ownership edges as circular; the command remains visible and advisory rather than forcing a meaningless refactor.
- **E — investigate when touched:** rscheck reports similar source/BIOS registration, DolphinTool/chdman resolution, and hash-validation flows. Confirm domain equivalence before extracting any abstraction.

Do not expand exceptions casually. Newly introduced absolute path literals still fail. Promote cargo-modules to a hard gate once its baseline represents actual module edges cleanly.

On the current Windows development host, semdup 0.2.0 reaches its ONNX Runtime link step but the installed Visual Studio 2019 linker cannot resolve symbols required by that dependency. Run `just deep` on Linux/macOS or install a current supported MSVC toolchain for semdup coverage; this does not weaken the required `just audit` path.

## Ratcheting

Do not increase the current complexity limits or add new warnings in touched code without review. Lower `max_fn` from 25 only after the repository satisfies the lower value naturally. Treat semdup's 0.85, three-member threshold as an investigation threshold; do not weaken it to hide a finding or build abstractions solely to reduce its score.
