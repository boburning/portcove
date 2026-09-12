# Code quality and codebase intelligence

Portcove uses one local quality interface for humans, CI, and coding agents. The bootstrap requires Cargo/Rust, Node 24, and PowerShell 7 on Windows or Bash on Linux/macOS. Install the pinned tools with:

```powershell
.\scripts\bootstrap-quality-tools.ps1
```

```bash
./scripts/bootstrap-quality-tools.sh
```

Pass `-IncludeDeep` or `--include-deep` to also install cargo-modules, semdup, cargo-mutants, and Hawk where supported. Both scripts are idempotent, verify and print exact installed versions, and never silently upgrade tools. Deep tools remain optional: Hawk shares the workspace Rust channel and adds its required `rustc-dev` component, but does not support Windows; semdup requires a current native C++ linker for its ONNX runtime.

## Canonical commands

Routine CI and maintenance must not require additional paid services, runners,
storage expansion, metered AI APIs, new hardware, or an always-on personal PC/NAS.
Preserve the existing fast-CI target, measurement definition, required checks,
platform coverage, and validation and safety contracts. Resource limits must
result in a reported limitation, not enabled spending or bypassed checks.
An existing ChatGPT/Codex subscription does not establish free unattended API
execution. This policy does not enforce account billing limits: verify applicable
GitHub storage allowances and spending controls separately; free standard-runner
execution in public repositories does not imply unlimited free storage.

See [Development tools](DEVELOPMENT-TOOLS.md) for the read-only host doctor,
native desktop evidence harness, repository skills and targeted safety experiments.

The native desktop harness includes a 1,000-control injected-controller profile.
It records layout-query counts and observed input-handler durations for idle,
activation, held activation, and directional movement. Idle and held activation
perform no layout queries; focused activation checks only its modal scope and
the current control. Directional movement measures the current region once per
accepted move, using fresh geometry rather than a stale layout cache. The harness
restores its injected input and DOM fixture afterward. These measurements are
native rendering evidence, not physical-controller or human-navigation evidence.

| Scope                                | Command                            | Purpose                                                                                                                                       |
| ------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan or run a coherent local change  | `just local-check [--plan]`        | select formatting, affected Rust packages, related UI tests, and exact tooling contracts from the complete local diff                         |
| Focus a Rust edit-test loop          | `just test-rust <args>`            | pass an explicit package, target, or test-name selection through the pinned nextest fixture runner                                            |
| Focus a UI edit-test loop            | `just test-ui-related <files>`     | run Vitest tests related through the import graph to explicit changed source files with the standard isolation and timing contract            |
| Focus a Node tooling edit-test loop  | `just test-node <test-files>`      | run explicit Node test files with the standard hang guard and duration reporter                                                               |
| Format supported files               | `just fmt`                         | rewrite Rust, frontend, configuration, and active documentation with the repository-pinned formatters                                         |
| Verify all formatting                | `just fmt-check`                   | check the complete formatting contract without changing files                                                                                 |
| Exhaustive local Rust investigation  | `just check-rust`                  | prune this workspace's disposable incremental cache, then format, compile, Clippy, tests, unused dependencies/files, and crate boundaries     |
| Exhaustive local UI investigation    | `just check-ui`                    | Oxfmt, type-aware Oxlint, Stylelint, production build, tests, and the existing Fallow gate                                                    |
| Playnite reference change (Windows)  | `just playnite-check`              | locked SDK/reference-assembly builds, literal process arguments and public protocol regression fixtures; optional isolated compiled-CLI reads |
| Exhaustive source/repository check   | `just check`                       | Rust, UI, script/workflow lint, repository tooling, Roadmap, and development-tool contracts; excludes release qualification                   |
| Deterministic release-unit check     | `just release-check`               | release metadata, packaging, updater, channel, workflow, and Windows qualification unit contracts                                             |
| Packaged Windows qualification       | `just windows-qualification-check` | stateful Windows packaged-session integration; always observed rather than reused                                                             |
| Release or explicit transition audit | `just audit [--plan\|--fresh]`     | staged exhaustive check, dependency policy, rscheck, release units, and applicable Windows qualification                                      |
| Large structural investigation       | `just deep`                        | audit plus advisory Hawk and semdup analysis                                                                                                  |
| Explicit cycle investigation         | `just cycles`                      | optional advisory module-cycle report                                                                                                         |
| Critical core test review            | `just mutants`                     | optional mutation analysis for `portcove-core`                                                                                                |

## Local feedback and hosted authority

Portcove uses three validation tiers. The inner loop runs only the test or test
files that exercise the edit. A coherent pre-push check uses `just local-check`,
which compares the merge base with `origin/main` by default and includes
committed branch changes, staged and unstaged changes, renames, deletions, and
non-ignored untracked files. Pass `--base <revision>` when another reviewed base
is intentional, or `--plan` to inspect the exact selection without executing it.

The selector always checks whitespace and changed supported-file formatting.
It runs affected Rust packages rather than the workspace, uses Vitest's import
graph for UI sources, and maps repository scripts and workflows to their exact
contract tests. Root Cargo/toolchain changes compile and lint the workspace and
run dependency policy without executing every local test. Combined changes use
the union of their scopes. An unknown path is a hard selection error: add and
test its narrow rule rather than silently passing or falling back to the full
suite.

A typical warm single-layer local check targets less than two minutes and prints
every selected stage and elapsed time. The target is diagnostic rather than a
reason to omit assertions. Open or update a draft pull request after the first
coherent focused pass so required CI can run while review and remaining work
continue. Superseded hosted runs are cancelled by the workflow concurrency
contract.

Required GitHub CI remains the exhaustive cross-platform merge gate. It must
pass on the exact reviewed head; a local full suite does not replace it. Ordinary
pull requests do not repeat `just check` or `just audit` merely to duplicate that
coverage. Aggregate local commands remain useful for release preflight, an
explicitly named acceptance requirement, a validation-contract transition, or
diagnosing a hosted failure. Native desktop, installer, recovery, security,
physical-platform, and human evidence remains separate and is still required
when the issue's acceptance scope calls for it.

## Staged audit receipts

`just audit` executes named formatting, Rust, UI, script-lint, repository-tooling, Roadmap,
development-tool, dependency-policy, rscheck, release-unit, and applicable
Windows-qualification stages. It continues independent stages after a failure
and returns one aggregate failure so a late problem does not hide remaining
results. `just audit --plan` reports each run/reuse decision without executing a
stage or creating receipt storage. `just audit --fresh` ignores prior success and
runs every applicable stage; release preflight and validation-contract acceptance
use this mode.

Successful deterministic-stage receipts live under ignored
`work/validation-receipts`. Their fingerprints cover the complete conservative
repository-owned domain inventory, tracked/index/worktree content identities,
untracked inputs, recipes and pins, host/tool versions, and whitelisted
behavior-affecting environment. Unknown files affect every reusable domain. A
content-identical unrelated rebase can therefore retain a stage, while a relevant
edit, tool/environment drift, missing input, or receipt-integrity failure forces a
rerun. Unresolved or partially staged paths are refused because one execution
cannot validate two different candidate contents. Failed, interrupted, or incomplete stages never create a reusable receipt.
Dependency/advisory policy and packaged Windows qualification always rerun because
their external or machine state can change.

Every completed audit writes a current-head run receipt listing the fingerprint,
originating head, duration, rationale, and fresh/reused/failed result for every
applicable stage. These files are disposable local execution evidence. They do not
replace exact-head required CI, issue acceptance, final review, release preflight,
or any protected authority.

## Formatting contract

`just fmt` is the canonical write command and `just fmt-check` is its no-write
counterpart. Cargo formats Rust, Oxfmt formats active JavaScript, TypeScript,
CSS, HTML, hand-maintained JSON and YAML, and active Markdown, and Taplo formats
TOML. Oxfmt uses a configured 100-column width, sorts package manifests, and
deliberately leaves import order unchanged. Import order can carry side effects,
and normalizing the existing tree would add unrelated churn without a product or
quality benefit. Oxfmt and Taplo are exact development dependencies installed by
the existing pnpm workflow. Recommended VS Code extensions and format-on-save
settings use those same repository-local tools. The Oxfmt wrapper rejects an
empty repository-owned inventory before invoking the formatter; the TOML wrapper
enumerates repository-owned files before passing their contents to Taplo so
checks cover the same files on Windows and Unix hosts.

Generated files, catalogs, fixtures, dependency lockfiles, archived documents,
and dated release evidence are outside the bulk-format boundary so a formatter
cannot rewrite their content or invalidate historical evidence. This includes
the Playnite integration and contract tests' `bin` and `obj` directories, which
MSBuild and NuGet own. Secondary languages and scripts remain outside the
bulk-format boundary; their lint contracts are specified below. Mechanical
repository-wide format commits are listed in `.git-blame-ignore-revs`.

Deterministic failures block: rustfmt, Cargo compilation, Clippy, tests,
type-aware Oxlint, Oxfmt, Stylelint, Ruff, ShellCheck, actionlint,
PSScriptAnalyzer, cargo-shear, cargo-deny security/license/source policy, the
Cargo-metadata architecture checker, Fallow, and rscheck's absolute-path rule
outside reviewed exceptions.

Oxlint uses one root configuration for the desktop TypeScript/TSX and the
repository's JavaScript modules. Its explicit plugin list includes ESLint,
TypeScript, React, JSX accessibility, Oxc, import, and Vitest coverage; an
explicit list replaces Oxlint's defaults. The standard pass applies the
correctness category plus explicit JavaScript correctness, React Hooks, modern
React `refs`/`set-state-in-effect`, and the complete supported
`jsx-a11y/recommended` policy inherited from the former ESLint configuration.
Broad suspicious, pedantic, performance, style, restriction, and nursery
categories remain opt-in so an Oxc update cannot silently expand the blocking
policy. Rules that assume the legacy JSX transform remain disabled.

The correctness category also keeps Oxc's stable compiler-backed React checks
for error boundaries, immutability, incompatible libraries, preserved manual
memoization, purity, render-time state changes, static components, and memo use.
The overlapping nursery dependency/derivation variants are not promoted to a
second blocking policy. `react/todo` is also excluded because it reports React
Compiler lowering limitations such as `try`/`finally`, not application defects.

`jsx-a11y/prefer-tag-over-role` remains disabled as one rule-specific tool
exception. It was not part of `jsx-a11y/recommended`, has no role-specific
configuration, and currently proposes behavior-changing or invalid substitutes
for Portcove's managed dialogs, button-based listbox options, and labelled ARIA
groups. The blocking ARIA role, property, interaction, focus, labelling, and
semantic-content rules remain enabled. Reassess the exception when the rule can
distinguish these patterns instead of suppressing accessibility diagnostics by
file or across the plugin.

The runner adds a second `oxlint-tsgolint` pass for desktop source and TypeScript
configuration files, including `apps/desktop/vite.config.ts`. It explicitly
restores every rule from the former `typescript-eslint/recommendedTypeChecked`
policy that Oxlint supports; core equivalents cover the former TypeScript
plugin's array-constructor, unused-expression, and unused-variable rules. The
only type-aware rules not implemented by the pinned `oxlint-tsgolint` are
`naming-convention` and `prefer-destructuring`, neither of which belonged to the
former policy. Repository JavaScript utilities still receive the standard
Oxlint pass without being inferred into unrelated TypeScript programs. Test
fixtures may use async mocks and intentionally exercise structured non-Error
Tauri rejections; their narrow rule exceptions remain test/config-file only.

The linter accepts no warnings and rejects unused suppression comments. The
separate `pnpm typecheck` command remains the authoritative whole-program
TypeScript compiler gate; Oxlint's experimental whole-program type-check mode is
not enabled. The VS Code integration enables the same type-aware diagnostics.

Vitest correctness rules reject focused or disabled tests, conditional or
standalone expectations, invalid callbacks and titles, missing awaited promise
expectations, and message-less throw assertions. `vitest/valid-expect` permits
Vitest's supported optional assertion-message argument. The
`vitest/require-mock-type-parameters` rule remains disabled because applying it
to contextually typed component doubles would repeat their prop and module
contracts across hundreds of ordinary test mocks; contract-sensitive mocks may
still declare explicit types. This is a rule-specific policy decision, not a
file exclusion or diagnostic suppression.

The package uses one TypeScript 7 dependency for the `tsc` build command,
transport compiler rejection fixtures, and Vite ecosystem tooling. This removes
the former compiler alias and its Fallow dependency exception. The build and
transport compiler tests continue to verify the compiler independently.

Stylelint applies its recommended correctness rules to the existing stylesheet.
The documented descending-specificity exception preserves the stylesheet's
intentional later-override structure; it does not disable formatting coverage.
Ruff checks the tracked Python asset scripts; ShellCheck checks the tracked shell
bootstrap; actionlint checks every GitHub Actions workflow and receives the exact
ShellCheck executable selected by aqua; PSScriptAnalyzer checks all tracked PowerShell scripts.
The PowerShell profile omits only cmdlet naming rules that do not apply to private
script helpers.

The Playnite C# projects intentionally rely on the SDK compiler analyzers and set
`TreatWarningsAsErrors` in both the extension and contract-test projects.
`just playnite-check` is therefore the C# warning gate. Portcove does not add a
separate Roslyn analyzer package or repository-wide `.editorconfig`; any compiler
warning exposed by that required build must be fixed rather than suppressed.

The UI test command also runs `apps/desktop/scripts/check-copy.mjs`. It parses
production TypeScript/TSX with the exact-pinned development-only Oxc parser and
walks only declared AST visitor keys. Parser and semantic diagnostics fail
closed before partial syntax trees are inspected. The checker rejects internal
terminology, parenthetical plurals and an unqualified “Verified” label in static
copy. This includes decoded JSX text and attributes, cooked template values,
accessible labels and message literals. There is no violation baseline or
suppression-comment mechanism.

The check deliberately excludes non-runtime declarations/tests, imports, property
names, machine-value comparisons and non-copy JSX attributes. A lexical `details`
disclosure named “Technical details”, “View technical details” or “Full identity
and evidence” permits technical terms within that disclosure; it does not exempt
the rest of the component. These boundaries distinguish technical syntax and
evidence from ordinary copy. Runtime catalog/IPC text and raw-enum data flow still
need their owner-layer presentation tests and review; this static check is not a
proof of all rendered wording or of translation quality.

Structural heuristics advise: dependency duplication, unmaintained transitive dependencies, complexity, responsibility splits, god objects, duplicate logic, dead public APIs, semantic duplication, and mutation survivors. Do not refactor simply to make an advisory number green.

pnpm 12's default one-day minimum release age remains active without dependency
exceptions. Portcove pins pnpm exactly in the desktop `packageManager` field,
derives workflow setup from that authority, and requires frozen installation.
Do not replace the release-age policy with package-wide exceptions or disable
lockfile verification.

The experimental Oxc React Compiler is not enabled in production. A bounded
qualification with `oxc-transform-react 0.149.0` compiled and passed the focused
UI contracts, but `@vitejs/plugin-react 6.1.1` declared only `^0.145.0` peer
compatibility and the main production JavaScript asset grew from 493,060 to
596,718 bytes, crossing Vite's chunk-size warning. The experiment was removed
without changing the established Oxc parser, formatter, linter, or Vite stack.
Reconsider it only after the supported peer range converges and a fresh bundle,
behavior, and native qualification clears the production bar.

## Tool and Rust version authority

Quality-tool pins follow their native provisioning boundary. `.github/quality-tools.json`
owns required and deep Rust CLI versions, install tiers, version commands and any
tool-private Rust requirement; `scripts/quality-tools.mjs --validate` rejects
copied Rust-tool pins in governed consumers. `.aqua-version` pins Aqua itself,
while `aqua.yaml` and committed `aqua-checksums.json` own Ruff, actionlint and
ShellCheck versions, platform assets and required SHA-256 verification.
`.config/tool-bootstrap.json` owns official Windows bootstrap origins, Aqua
release checksums by architecture, and desktop-driver pins.
`.config/powershell-resources.psd1` owns the exact PSScriptAnalyzer module version
downloaded from PSGallery through PSResourceGet on Windows.

The Windows bootstrap verifies and atomically promotes these payloads beneath the
shared local application-data cache, then writes ignored checkout shims. Aqua
roots are content-keyed from every applicable repository pin. Repository command
wrappers inject the checkout shim, Aqua, and PowerShell-module paths only into
child processes; no persistent environment variable is changed. Failed or partial
downloads never replace verified cached tools. Linux and macOS retain their
existing Aqua bootstrap behavior.

`rust-toolchain.toml` pins normal development and CI to the workspace compiler
floor recorded in `Cargo.toml`; the manifest validator requires those two
declarations and the quality contract to agree. The Hawk entry names that same
authority instead of carrying a second private Rust version. An increase
therefore requires one reviewed update across the workspace metadata, pinned
toolchain, and machine contract instead of an implicit move with latest stable.

The committed Cargo lockfile is part of that compiler contract across every
supported host. Required Ubuntu CI compiles and tests the locked Linux graph
with the pinned toolchain, so a future transitive update that exceeds Portcove's
declared floor fails before merge.

Required Linux CI installs desktop prerequisites from the runner's Ubuntu source
list only (traditional or deb822 layout). All prerequisite packages come from
Ubuntu; unrelated preconfigured vendor repositories do not take part in that
resolution. Repository signatures, package checksums, bounded acquisition and
every required test remain enforced.

CI installs the small prebuilt Rust tool set through the commit-pinned installer
action, restores source-built rscheck from an exact-version cache when available,
and verifies every exact version before running a gate. An rscheck cache miss
falls back to the same pinned installer. Required Linux CI obtains the pinned
aqua release from its commit-pinned official action, then uses the same bootstrap
and checksum enforcement as local development. Windows CI installs the pinned
PSScriptAnalyzer resource through PSResourceGet. The local bootstrap scripts use
cargo-binstall when available and exact, locked Cargo installs otherwise;
optional deep tools remain outside required PR CI.

Required CI cancels an older in-progress run when a newer commit reaches the same branch or pull request. This keeps obsolete Windows builds from occupying the queue while preserving a complete run for the newest commit.

Linux desktop build prerequisites are installed through `scripts/install-linux-desktop-prerequisites.sh` in required CI, deep-quality, release, and updater-rehearsal workflows. The installer skips package-network work when the exact prerequisite set is already present, isolates resolution to Ubuntu sources, and gives APT three bounded fetch retries with explicit connection and package-lock timeouts. It first tries the runner-configured mirror under separate two-minute update and three-minute install deadlines, then applies the established archive mirror fallback with four-minute update and five-minute install deadlines. Its only option adds the updater rehearsal's `rpm` packaging tool; unknown arguments fail before package work. Each calling step has a fifteen-minute outer limit and fails if both mirror attempts are exhausted. These retries cover external package retrieval only; repository tests retain zero retries, and a failed validation is never converted into a passing result.

Required pull-request CI has a five-minute warm-cache target for the complete pipeline, measured from run creation to the terminal required-job result. The Windows Rust suite is exhaustively partitioned into service, recovery, remaining-core, non-core workspace-test, and format/Clippy lanes, while a lightweight Windows job covers development-storage behavior. A native matrix also runs the full workspace through cargo-nextest on Linux x86-64, macOS x86-64, and macOS arm64 so platform-specific filesystem, process, and permission behavior cannot be represented by Windows compilation alone. Native tests use the runner-owned temporary directory so macOS's system `/var` compatibility symlink is not mistaken for a library-controlled symlink ancestor. Giving the non-core test and lint lanes independent job identities also gives them independent Rust cache keys; a fast core shard therefore cannot win a shared-key save race and leave the slower graphs uncached. The required `rust` job fails closed unless every Windows and native producer passes. Clippy's all-target compilation replaces a duplicate standalone `cargo check`; the Linux quality lane likewise avoids installing pnpm because it invokes Node and Rust tools directly. These boundaries are enforced by `scripts/ci-workflow.test.mjs` so missing shards, native platforms, unused setup, a shared-key race, or accidental serialization cannot silently return to the critical path.

A lockfile or toolchain change is expected to pay each lane's cold-build cost once. [Run 33832768415](https://github.com/boburning/portcove/actions/runs/33832768415) established the initial 7m45s cold baseline and exposed the shared-key race. After isolating the non-core jobs, [run 33833781499](https://github.com/boburning/portcove/actions/runs/33833781499) passed in 6m49s while populating both new lane-specific caches.

Frontend pull requests use the required GitHub dependency-review check to block newly introduced high-severity vulnerabilities. GitHub vulnerability alerts and automated Dependabot security fixes remain active during the staged Renovate transition. The frontend build lane therefore does not make a second live request to npm's advisory endpoint on every commit, including pnpm's install-time audit; those duplicate requests added no change-specific coverage and could hold all otherwise-passing checks open for repeated network timeouts. Frozen lockfile installation, production build, tests, Fallow, and the pnpm/`just` development-storage integration cases remain required. The Windows and Linux Rust lanes retain every platform-relevant development-storage test while delegating only those two tool-integration cases to the prepared frontend lane.

The manually triggered `.github/workflows/deep-quality.yml` workflow provides a reproducible Ubuntu 24.04 environment for the full advisory pass, including semdup and Hawk. Ubuntu 24.04 is intentional: semdup's bundled ONNX Runtime currently requires newer glibc C23 symbols than the Ubuntu 22.04 runner provides. It runs the same `just deep` constituents as independent audit, Hawk, and semantic-duplication jobs so they execute in parallel, but is deliberately not a required pull-request status check. Start it after broad refactors or when the Windows host cannot link semdup:

```bash
gh workflow run deep-quality.yml --ref main
```

The workflow caches semdup's exact-version executable, versioned 149 MB model, and repository-local SQLite corpus. A source change restores the most recent compatible corpus and embeds only changed units; a configuration change starts a new corpus series. The first CPU-only index is allowed a longer cold-start budget, while later runs should be incremental. The deterministic audit and Hawk lanes reuse the former combined job's Rust cache so the split does not discard the established warm path.

The workflow log is review evidence, not an instruction to rewrite code. Hawk and semdup findings remain advisory, but the hosted job requires both analyzers to execute successfully so a missing tool or broken runtime cannot masquerade as a clean report. Local `just deep` continues past unavailable optional tools, and deterministic checks inside `just audit` still block normally.

Windows CI fixture jobs explicitly export `TEMP` and `TMP` from the existing
runner-owned `RUNNER_TEMP` before fixture preparation and timed tests. Setup logs
the inherited and selected directories and rejects invalid locations before
exporting either variable. This affects only subsequent job processes, not the
host's persistent settings. The workflow contract executes the actual setup block
on Windows and checks the directory observed by a fresh child process.

Test-only phase timings preserve the last entered initialization or recovery
boundary when nextest terminates a test. A finished phase means its action
returned, including an error result; the original assertions remain authoritative.
These observations help isolate intermittent Windows failures but do not by
themselves establish their cause. Test deadlines, concurrency and retry policy
remain unchanged.

The unobserved-abort recovery fixture holds its native uninstaller behind a
bounded release marker until the owned runner has exited. A fixed sleep cannot
establish that interruption point on a busy host. The fixture still requires the
unobserved-exit outcome and exact owned cleanup; the separate observed-exit case
retains its own assertion. The disposable native helper has no console lifetime
dependency on the runner it must outlive.

## Architecture gate

`scripts/check-rust-architecture.mjs` reads `cargo metadata --format-version 1 --no-deps`; it never scrapes manifests. It requires both adapters to depend on `portcove-core`, prevents core from depending on CLI/Tauri/desktop concerns, prevents either adapter from depending on its peer, and keeps the default Cargo member set limited to Core and CLI so a focused Rust build has no desktop frontend prerequisite. Add future layer rules to the checker data rather than writing a second checker.

## Dependency policy

`deny.toml` allows only the permissive licenses currently required by the resolved graph. It denies wildcard registry versions and unknown registry or Git sources. Local workspace path dependencies are intentionally permitted because all three workspace packages are private. Duplicate versions remain warnings until their upstream dependency chains converge.

The reviewed `rusqlite/rusqlite` upstream repository is the sole permitted Git
dependency source, and Git dependencies require an explicit revision. The workspace
pins `b2b2592ecf40dcce20641aeb94af82e7d3a0b26d`, which supports the workspace compiler and bundles
SQLite 3.53.4. Published rusqlite 0.40.2/libsqlite3-sys 0.38.2 still bundle 3.53.2,
whose Windows VFS mistakes canonical local drive paths for network paths. Repeated
concurrent connections can then fail with `SQLITE_PROTOCOL`. SQLite corrected
that classification in [3.53.3's upstream history](https://sqlite.org/src/timeline?from=version-3.53.0&to=version-3.53.3&to2=branch-3.53&y=ci).
The core concurrency regression uses canonical paths, independent connections,
committed writes and a final integrity check. Return to a registry release with
the fix after equivalent qualification and remove the Git-source allowance. This
pin changes neither library path identity nor WAL, busy-timeout, migration or
operation-lock behavior.

`renovate.json` is the eventual dependency-update authority. It covers Cargo,
npm, GitHub Actions and Rust toolchains, plus regex-managed Node, repository
quality crates, tauri-driver, Aqua and its registry/tools, PSScriptAnalyzer, and
the release Syft version. It groups coupled ecosystems, pins action digests,
waits three days for new releases, disables automerge, and refuses pending
release-age checks. Repository tests require those nonstandard authorities and
every external action to remain covered.

GitHub vulnerability alerts and automated Dependabot security fixes remain
enabled. Weekly Cargo, npm, and GitHub Actions updates stay configured in
`.github/dependabot.yml` until the hosted Renovate App is authorized for this
repository and its first real run and pull request prove the integration. Only
then may a focused follow-up remove Dependabot; this staged overlap prevents an
automation gap.

Current Tauri Linux dependencies transitively include the unmaintained GTK3 binding family; other transitive build paths include `proc-macro-error` and the `unic-*` family. `cargo deny check --hide-inclusion-graph -W unmaintained` keeps these visible while continuing to deny security advisories, while omitting thousands of lines of repeated transitive paths from the normal audit. There is no safe direct Portcove upgrade that removes the GTK3 set without changing Tauri's Linux webview architecture.

GitHub also reports GHSA-wrw7-89jp-8q8g for Tauri's Linux-only `glib 0.18.5` graph. Dependabot confirms that `0.18.5` is the newest version compatible with Tauri's GTK3 stack while the advisory declares `0.20.0` as the first fixed release. Keep that alert open in its durable issue and live Project item; do not conceal it with a version-only dismissal, an unreviewed fork, or a broad advisory exception. Re-evaluate when Tauri adopts a compatible maintained GTK stack.

## Initial structural baseline

The 2026-09-02 baseline is classified as follows:

- **A — defect or dangerous architecture issue:** none after deterministic checks.
- **B — clear low-risk cleanup:** cargo-shear identified and removed three manifest-only dependencies (`tracing` from the CLI; `serde_json` and `tokio` from the Tauri adapter). Hawk identified three unreachable library-less release-provider constructors; production already used the library-aware constructors, so the unused public APIs were removed after caller review.
- **C — existing design debt:** `catalog::validate`, CLI `execute`, and `adapter::launch_spec` exceed the initial function-complexity threshold. `Library` and `PortcoveService` have broad impl surfaces. Improve these only when nearby product work reveals a stable domain boundary.
- **D — intentional or tool limitation:** reviewed DolphinTool/chdman discovery locations and Windows path-rewrite fixtures are exact rscheck path exceptions. cargo-modules 0.27 reports type-to-associated-item ownership edges as circular; the command remains available through `just cycles` for explicit investigations, outside routine CI and audits.
- **E — investigate when touched:** rscheck reports similar source/BIOS registration, DolphinTool/chdman resolution, and hash-validation flows. Confirm domain equivalence before extracting any abstraction.

The first complete hosted deep baseline is [run 33651741470](https://github.com/boburning/portcove/actions/runs/33651741470) at commit `b8486d4`. Hawk reported zero dead public APIs after the reviewed cleanup. semdup indexed 638 units, scanned the 236 functions meeting the eight-line floor with the exact index, and reported zero qualifying pairs in zero three-member clusters at 0.85; six smaller clusters were hidden by the intentional rule-of-three threshold. The cold semdup stage took 37 minutes, after which Actions saved a 141.4 MB model cache and 2.0 MB corpus cache. This is a clean advisory baseline, not proof that no smaller or conceptual duplication exists.

The incremental path is proven by [run 33657080917](https://github.com/boburning/portcove/actions/runs/33657080917) at commit `a856d22`. It restored the model by its primary key and the compatible `b8486d4` corpus by prefix, indexed 648 current units, embedded only 15 changed texts in 30 seconds, and reproduced the same zero-pair report. Hawk again reported zero findings. The complete warm job took about 10.5 minutes instead of the cold run's roughly 50 minutes.

The completed audit-remediation implementation was revalidated by [run 33705777418](https://github.com/boburning/portcove/actions/runs/33705777418) at commit `df9de02`. All three lanes passed: semantic duplication in 5m49s, Hawk in 7m01s, and the full deterministic audit in 9m37s. This run is the final-head structural evidence; its analyzer reports remain advisory under the policy above.

Do not expand exceptions casually. Newly introduced absolute path literals still fail. Reconsider routine cargo-modules coverage only after its report represents actual module edges cleanly and demonstrates actionable value.

The three dated roadmap-reconciliation files named explicitly in
`.gitattributes` are verbatim historical evidence. Their source documents use
Markdown hard-break spaces and final blank lines, so only those exact paths
disable the corresponding `git diff --check` whitespace diagnostics. The
exception preserves source fidelity and does not apply to other archives,
documentation, or code.

On the current Windows development host, semdup 0.2.0 reaches its ONNX Runtime link step but the installed Visual Studio 2019 linker cannot resolve symbols required by that dependency. Run `just deep` on Linux/macOS or install a current supported MSVC toolchain for semdup coverage; this does not weaken the required `just audit` path.

## Ratcheting

Do not increase the current complexity limits or add new warnings in touched code without review. Lower `max_fn` from 25 only after the repository satisfies the lower value naturally. Treat semdup's 0.85, three-member threshold as an investigation threshold; do not weaken it to hide a finding or build abstractions solely to reduce its score.

## Upstream health checks

Every PR retains deterministic repository, release, and local RetComM mapping
validation in the required `catalog` job. Live repository availability and
RetComM upstream comparisons run separately in `upstream-health.yml` when catalog
data, the mapping, either checker, the Node version, or that workflow changes.
The same workflow runs daily and can be dispatched manually. Its path-filtered
status must not be configured as an always-required branch check, because an
unrelated PR does not create that status. Scheduled failures remain visible in
Actions and require investigation as upstream drift, not a local code failure.
Release workflow and local release preflight retain their live upstream checks.

The advisory cycle report is deliberately excluded from routine CI and `audit`
because its known inherent-item cycle baseline produces non-actionable noise.
The pinned tool remains available through the optional deep bootstrap and
`just cycles`; the deterministic Cargo-metadata architecture gate is unchanged.

## Test latency and reliability

Use `just ci-health` to inspect the latest 20 main CI runs, including every rerun
attempt. GitHub CLI authentication with read access to Actions is required.
This is an on-demand report, not another required CI job or a planning authority.

```powershell
just ci-health
node scripts/ci-health.mjs --runs 30 --json > work/ci-health.json
node scripts/ci-health.mjs --branch my-branch --event pull_request --runs 10
```

The report separates successful first attempts from successful reruns, reports
cancelled/incomplete/failed outcomes, and links failed-then-passing attempts for
investigation. JSON output includes per-job timings and the three longest steps
in each job. A rerun recovery is not proof of a flaky test: runners, caches and
external services may differ even when the commit does not. No retries are
scheduled by this report, and it never changes issues, checks, caches or runs.

Use `--since <ISO-date>` to restrict the selected recent runs to those created
after a workflow change. Main contains already-reviewed merges; inspect the
relevant pull-request branch as well when investigating flaky tests.

Review this evidence when a slowdown or repeated failure appears and before
changing CI scheduling. Inspect the linked failed job to distinguish assertion,
build, setup, runner and network failures. Use the same workflow revision and
cache evidence when comparing performance; an aggregate spanning workflow
changes describes history, not the current design. Cache warmth is deliberately
unclassified without job-log evidence. First attempts can be warm, and reruns
can miss caches. Cold rebuilds remain visible rather than being counted as flakes.

Durations run from creation (first attempt) or the attempt start (reruns) to the
attempt's terminal update, including queueing, setup and aggregation. In-progress
attempts have no completed duration. Percentiles use nearest-rank selection.
The report omits p95 until a cohort has at
least 20 valid successful samples; that minimum alone does not establish a
representative long-term rate. Confirm improvements over ordinary subsequent
changes, not only repeated runs of one commit. Prefer fixing a recurrent costly
step over further sharding, reduced assertions or a growing monitoring service.

The required Rust test lanes and `just rust-test` use the version of cargo-nextest
pinned in `.github/quality-tools.json`. Five seconds is a diagnostic threshold,
not an acceptance limit. Nextest reports slow tests every five seconds and
terminates a test at thirty seconds with no retries or termination grace period.
This hang guard bounds real filesystem and process lifecycle tests while allowing
normal runner variability. Investigate slow cases using their actual work and
repeated timings; preserve coherent scenarios instead of splitting assertions
solely to satisfy a stopwatch. Pure unit tests should normally finish well below
the diagnostic threshold. A timeout or failed assertion still fails the lane.
Nextest prints individual elapsed times. Documentation tests still run separately
with Cargo on Windows, Linux, and both macOS architectures. Their required jobs
run in parallel with unit tests because Cargo's documentation build uses a
different dependency graph. The Rust aggregate fails if any documentation job fails.

CI uses line-table debug information for development and test builds to retain
file/line backtraces while reducing debug-data generation and linking work.
The shared Rust setup action reads `rust-toolchain.toml` before installation;
cross targets are installed for that same compiler, rather than unrelated stable.
Local development profiles remain unchanged. Changing this setting invalidates
build caches; report cold and warm hosted timings separately. The five-minute
pipeline target includes setup and required-job aggregation, not just test runtime.
The Rust cache key includes the root Cargo manifest so test-profile changes cannot
keep restoring an immutable cache containing only the previous profile's artifacts.

The UI suite consists of small JavaScript/DOM tests and keeps Vitest's five-second
timeout. Its report validates complete measurements and lists slow passing tests. Two isolated worker threads avoid repeated Node process
startup for this JavaScript/DOM suite; file isolation remains enabled.
Node test commands use a thirty-second asynchronous hang timeout and report
individual results above five seconds without failing on elapsed time alone.
Synchronous work cannot be interrupted by Node's event-loop timeout; measured
latency still appears in the report and CI job timeouts bound a stuck process.
Suite aggregate durations are not individual test durations.

Windows qualification session integration tests remain a separate required step;
they exercise compiled processes and installer lifecycle behavior using their
existing integration deadlines. The static qualification contract runs with the
Node hang guard. No integration coverage is removed.

Rust tests run two at a time by default on every platform, including local
Windows and its exhaustive CI partitions. This bounds filesystem contention
without serializing unrelated fixtures; explicit nextest thread settings remain
available for diagnosis. CLI free-space
snapshot contracts share a scheduling group because their existing in-process
mutex cannot synchronize nextest's separate processes. Full signed-catalog tests
and CLI process contracts
reserve both default CPU slots while verifying complete snapshots. Intel macOS
uses two exhaustive hash partitions to keep this work off the critical path.
This changes scheduling
only; every Rust test retains the same deadline. CI caches compiled dependencies
after test failures so fixing a failed assertion does not require a cold rebuild.

Intel test binaries are cross-compiled for `x86_64-apple-darwin` on Apple Silicon
and transferred in a nextest archive scoped to the current workflow attempt.
Both partitions execute on Intel macOS, including tests which compile native
helper processes. Intel documentation tests still build and run on Intel.
This avoids repeatedly compiling the full test workspace on variable Intel
runners. The archive is retained for one day; it is not a release artifact.
CLI tests resolve nextest's remapped executable path at runtime so archives do
not depend on the build machine's checkout or target-directory location.
The required Rust aggregate fails if either the build or any Intel test job fails.

Timed Rust lanes compile the native host-tool probe fixture once during setup.
Each test copies it into its own temporary directory before mutation or probing.
`just rust-test` uses the same preparation through `scripts/run-rust-tests.mjs`;
plain Cargo tests retain their standalone fixture compiler. Fixture compilation
is build setup, while every test's assertions and process probes keep the same
hang guard.

The test profile optimizes the Ed25519 and Curve25519 dependencies because catalog
fixtures validate real signatures repeatedly. Portcove code retains its normal
test profile and debug assertions. Windows session integration compiles immutable
fixture programs once per suite, then gives every case separate copies and state.
Concurrency assertions use synchronization instead of elapsed-time assumptions.

Every Node test file is explicitly covered by required CI and local quality
recipes; the workflow contract checks this inventory. Transport comparator unit
tests use fixed inputs, while a separate required integration test mutates the
generated nested scalar and checks it against the CLI's live Rust schema export.
The required frontend job verifies generated declarations and runs strict compiler
fixtures that reject incorrect nested types, nulls, missing required fields,
arrays, enums and discriminated event variants. No TypeScript suppression is
used for negative fixtures. Request schemas retain accepted defaults separately
from required serialized response fields.

After changing a Rust transport type, run
`node scripts/check-transport-contract.mjs --write`, followed by
`node apps/desktop/scripts/generate-transport-types.mjs --write`. Commit the
generated JSON snapshots and declaration files with the caller changes.
`json-schema-to-typescript` is pinned as a development dependency; generation
resolves only local schema references and rejects inconsistent named definitions.
The declarations contain no executable code, use type-only imports, and reuse
identical root/nested schema bodies. There are no new quality exclusions or
dependency exceptions. The frontend facade exposes the types its callers use;
the complete exported Rust inventory remains in the generated declarations.
The same command also runs the desktop package's `export_transport` example,
which uses the exact private host transport declarations. Its input and output
snapshots remain separate from core's export. Strict compiler fixtures cover
the desktop's required nullable envelope fields, camelCase launch identity and
typed install request; Rust fixtures check actual Serde output/input behavior.
