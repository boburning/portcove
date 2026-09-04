# Code quality and codebase intelligence

Portcove uses one local quality interface for humans, CI, and coding agents. The bootstrap requires Cargo/Rust, Node 24, and PowerShell 7 on Windows or Bash on Linux/macOS. Install the pinned tools with:

```powershell
.\scripts\bootstrap-quality-tools.ps1
```

```bash
./scripts/bootstrap-quality-tools.sh
```

Pass `-IncludeDeep` or `--include-deep` to also install semdup, cargo-mutants, and Hawk where supported. Both scripts are idempotent, verify and print exact installed versions, and never silently upgrade tools. Deep tools remain optional: Hawk uses its own manifest-pinned Rust toolchain and does not support Windows, while semdup requires a current native C++ linker for its ONNX runtime.

## Canonical commands

| Scope | Command | Purpose |
|---|---|---|
| Rust change | `just check-rust` | format, compile, Clippy, tests, unused dependencies/files, and crate boundaries |
| UI change | `just check-ui` | production build, tests, and the existing Fallow gate |
| Cross-stack or release change | `just check` | both fast loops plus deterministic release metadata and checksum-tool tests |
| Substantial completion | `just audit` | fast loop plus dependency policy, the current module-cycle report, and rscheck |
| Large structural change | `just deep` | audit plus advisory Hawk and semdup analysis |
| Critical core test review | `just mutants` | optional mutation analysis for `portcove-core` |

Deterministic failures block: rustfmt, Cargo compilation, Clippy, tests, cargo-shear, cargo-deny security/license/source policy, the Cargo-metadata architecture checker, Fallow, and rscheck's absolute-path rule outside reviewed exceptions.

Structural heuristics advise: dependency duplication, unmaintained transitive dependencies, complexity, responsibility splits, god objects, duplicate logic, dead public APIs, semantic duplication, and mutation survivors. Do not refactor simply to make an advisory number green.

pnpm 11's default one-day minimum release age remains active. The workspace contains exact-version-only exceptions for the Fallow 3.22.0 platform set and Lucide 1.39.0 used during this reviewed modernization pass; future versions are not exempt. Do not replace these with package-wide patterns or disable lockfile verification.

## Tool and Rust version authority

`.github/quality-tools.json` is the sole quality-tool pin manifest. It records every required and deep tool, exact version, install tier, version command, and any tool-private Rust requirement. The bootstrap scripts and all required, release, and deep workflows consume that manifest. `scripts/quality-tools.mjs --validate` rejects copied tool pins in those consumers.

`rust-toolchain.toml` pins normal development and CI to the workspace MSRV recorded in `Cargo.toml`; the manifest validator requires those two declarations and the quality contract to agree. An MSRV increase therefore requires one reviewed update across the workspace metadata, pinned toolchain, and machine contract instead of an implicit move with the latest stable compiler.

The committed Cargo lockfile is part of that MSRV contract across every supported host. Tauri's Linux credential-store graph currently resolves `aes 0.9.2`, the newest release in that line compatible with Rust 1.88; `aes 0.9.3` raises its compiler floor to 1.89. Required Ubuntu CI compiles and tests the locked Linux graph with the pinned toolchain, so a future transitive update that exceeds Portcove's declared MSRV fails before merge.

CI installs the small prebuilt tool set through the commit-pinned installer action, restores source-built rscheck from an exact-version cache when available, and verifies every exact version before running a gate. An rscheck cache miss falls back to the same pinned installer. The local bootstrap scripts use cargo-binstall when available and exact, locked Cargo installs otherwise; optional deep tools remain outside required PR CI.

Required CI cancels an older in-progress run when a newer commit reaches the same branch or pull request. This keeps obsolete Windows builds from occupying the queue while preserving a complete run for the newest commit.

Required pull-request CI has a five-minute warm-cache target, measured from run creation to its terminal result. Windows format, storage, and all-target Clippy checks run in parallel with the complete Windows workspace test suite; the required `rust` job fails closed unless both producers pass. The Windows producers install only the tooling they invoke, and Clippy's all-target compilation replaces a duplicate standalone `cargo check`. The Linux quality lane likewise avoids installing pnpm because it invokes Node and Rust tools directly. These boundaries are enforced by `scripts/ci-workflow.test.mjs` so unused setup or accidental serialization cannot silently return to the critical path.

Frontend pull requests use the required GitHub dependency-review check to block newly introduced high-severity vulnerabilities. Dependabot alerts and automated security fixes provide continuous repository-wide npm monitoring. The frontend build lane therefore does not make a second live request to npm's advisory endpoint on every commit, including npm's implicit install-time audit while bootstrapping pnpm; those duplicate requests added no change-specific coverage and could hold all otherwise-passing checks open for repeated network timeouts. Frozen lockfile installation, production build, tests, Fallow, and the pnpm/`just` development-storage integration cases remain required. The Windows and Linux Rust lanes retain every platform-relevant development-storage test while delegating only those two tool-integration cases to the prepared frontend lane.

The manually triggered `.github/workflows/deep-quality.yml` workflow provides a reproducible Ubuntu 24.04 environment for the full advisory pass, including semdup and Hawk. Ubuntu 24.04 is intentional: semdup's bundled ONNX Runtime currently requires newer glibc C23 symbols than the Ubuntu 22.04 runner provides. It runs the same `just deep` constituents as independent audit, Hawk, and semantic-duplication jobs so they execute in parallel, but is deliberately not a required pull-request status check. Start it after broad refactors or when the Windows host cannot link semdup:

```bash
gh workflow run deep-quality.yml --ref main
```

The workflow caches semdup's exact-version executable, versioned 149 MB model, and repository-local SQLite corpus. A source change restores the most recent compatible corpus and embeds only changed units; a configuration change starts a new corpus series. The first CPU-only index is allowed a longer cold-start budget, while later runs should be incremental. The deterministic audit and Hawk lanes reuse the former combined job's Rust cache so the split does not discard the established warm path.

The workflow log is review evidence, not an instruction to rewrite code. Hawk and semdup findings remain advisory, but the hosted job requires both analyzers to execute successfully so a missing tool or broken runtime cannot masquerade as a clean report. Local `just deep` continues past unavailable optional tools, and deterministic checks inside `just audit` still block normally.

## Architecture gate

`scripts/check-rust-architecture.mjs` reads `cargo metadata --format-version 1 --no-deps`; it never scrapes manifests. It requires both adapters to depend on `portcove-core`, prevents core from depending on CLI/Tauri/desktop concerns, and prevents either adapter from depending on its peer. Add future layer rules to the checker data rather than writing a second checker.

## Dependency policy

`deny.toml` allows only the permissive licenses currently required by the resolved graph. It denies wildcard registry versions and unknown registry or Git sources. Local workspace path dependencies are intentionally permitted because all three workspace packages are private. Duplicate versions remain warnings until their upstream dependency chains converge.

GitHub vulnerability alerts and automated Dependabot security fixes are enabled for `boburning/portcove`. Weekly Cargo, npm, and GitHub Actions updates remain configured in `.github/dependabot.yml`; major versions are no longer blanket-ignored and related ecosystems are grouped for coherent review.

Current Tauri Linux dependencies transitively include the unmaintained GTK3 binding family; other transitive build paths include `proc-macro-error` and the `unic-*` family. `cargo deny check --hide-inclusion-graph -W unmaintained` keeps these visible while continuing to deny security advisories, while omitting thousands of lines of repeated transitive paths from the normal audit. There is no safe direct Portcove upgrade that removes the GTK3 set without changing Tauri's Linux webview architecture.

GitHub also reports GHSA-wrw7-89jp-8q8g for Tauri's Linux-only `glib 0.18.5` graph. Dependabot confirms that `0.18.5` is the newest version compatible with Tauri's GTK3 stack while the advisory declares `0.20.0` as the first fixed release. Keep that alert open in its durable issue and live Project item; do not conceal it with a version-only dismissal, an unreviewed fork, or a broad advisory exception. Re-evaluate when Tauri adopts a compatible maintained GTK stack.

## Initial structural baseline

The 2026-09-02 baseline is classified as follows:

- **A — defect or dangerous architecture issue:** none after deterministic checks.
- **B — clear low-risk cleanup:** cargo-shear identified and removed three manifest-only dependencies (`tracing` from the CLI; `serde_json` and `tokio` from the Tauri adapter). Hawk identified three unreachable library-less release-provider constructors; production already used the library-aware constructors, so the unused public APIs were removed after caller review.
- **C — existing design debt:** `catalog::validate`, CLI `execute`, and `adapter::launch_spec` exceed the initial function-complexity threshold. `Library` and `PortcoveService` have broad impl surfaces. Improve these only when nearby product work reveals a stable domain boundary.
- **D — intentional or tool limitation:** reviewed DolphinTool/chdman discovery locations and Windows path-rewrite fixtures are exact rscheck path exceptions. cargo-modules 0.27 reports type-to-associated-item ownership edges as circular; the command remains visible and advisory rather than forcing a meaningless refactor.
- **E — investigate when touched:** rscheck reports similar source/BIOS registration, DolphinTool/chdman resolution, and hash-validation flows. Confirm domain equivalence before extracting any abstraction.

The first complete hosted deep baseline is [run 33651741470](https://github.com/boburning/portcove/actions/runs/33651741470) at commit `b8486d4`. Hawk reported zero dead public APIs after the reviewed cleanup. semdup indexed 638 units, scanned the 236 functions meeting the eight-line floor with the exact index, and reported zero qualifying pairs in zero three-member clusters at 0.85; six smaller clusters were hidden by the intentional rule-of-three threshold. The cold semdup stage took 37 minutes, after which Actions saved a 141.4 MB model cache and 2.0 MB corpus cache. This is a clean advisory baseline, not proof that no smaller or conceptual duplication exists.

The incremental path is proven by [run 33657080917](https://github.com/boburning/portcove/actions/runs/33657080917) at commit `a856d22`. It restored the model by its primary key and the compatible `b8486d4` corpus by prefix, indexed 648 current units, embedded only 15 changed texts in 30 seconds, and reproduced the same zero-pair report. Hawk again reported zero findings. The complete warm job took about 10.5 minutes instead of the cold run's roughly 50 minutes.

The completed audit-remediation implementation was revalidated by [run 33705777418](https://github.com/boburning/portcove/actions/runs/33705777418) at commit `df9de02`. All three lanes passed: semantic duplication in 5m49s, Hawk in 7m01s, and the full deterministic audit in 9m37s. This run is the final-head structural evidence; its analyzer reports remain advisory under the policy above.

Do not expand exceptions casually. Newly introduced absolute path literals still fail. Promote cargo-modules to a hard gate once its baseline represents actual module edges cleanly.

On the current Windows development host, semdup 0.2.0 reaches its ONNX Runtime link step but the installed Visual Studio 2019 linker cannot resolve symbols required by that dependency. Run `just deep` on Linux/macOS or install a current supported MSVC toolchain for semdup coverage; this does not weaken the required `just audit` path.

## Ratcheting

Do not increase the current complexity limits or add new warnings in touched code without review. Lower `max_fn` from 25 only after the repository satisfies the lower value naturally. Treat semdup's 0.85, three-member threshold as an investigation threshold; do not weaken it to hide a finding or build abstractions solely to reduce its score.
