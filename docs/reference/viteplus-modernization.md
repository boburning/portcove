# Vite+ modernization: decisions and evidence

Owner: [#2001](https://github.com/boburning/portcove/issues/2001). Candidate baseline:
`7c45fcf11597967ed657a1ede8ea524d64502e2a`, inspected October 15, 2026.
This is an implementation record, not a second planning authority.

## Selected release and source review

[Vite+ 1.2.0](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.2.0)
coordinates Vite 8.3.4, Rolldown 1.2.13, Vitest 5.0.4, Oxlint 1.88.0,
Oxfmt 0.73.0, oxlint-tsgolint 7.0.2004 and tsdown 0.23.1. The installed
`vite-plus/toolchain` manifest verifies these values. The original manifests,
lock and installed Vite 8.3.1/Vitest 5.0.3 state were retained through the pinned
workspace migrator. No Vitest-v4 compatibility settings were needed.

The complete [documentation index](https://viteplus.dev/llms.txt) and its local
full-text snapshot covered guide/configuration surfaces: migration, global/local
CLI, workspaces, check/lint/format/test/dev/build/pack, run/cache/tracking,
package/runtime management, hooks/staged, editor/agent setup, CI/cache, Docker,
scaffolding, upgrades and troubleshooting. Focused Context7 queries supplemented
those primary sources. Integration decisions also consulted current official
[Vite performance](https://vite.dev/guide/performance),
[Vitest projects](https://vitest.dev/guide/projects.html),
[Browser Mode](https://vitest.dev/guide/browser/component-testing),
[React plugin](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md),
[Oxc type checking](https://oxc.rs/docs/guide/usage/linter/type-aware),
[Oxfmt sorting](https://oxc.rs/docs/guide/usage/formatter/sorting.html),
[Rolldown](https://rolldown.rs/guide/introduction),
[tsdown](https://tsdown.dev/guide/),
[TypeScript](https://www.typescriptlang.org/tsconfig/),
[Playwright](https://playwright.dev/docs/best-practices),
[Tailwind's Vite integration](https://tailwindcss.com/docs/installation/using-vite),
[pnpm workspaces](https://pnpm.io/workspaces) and
[Tauri's Vite integration](https://v2.tauri.app/start/frontend/vite/).

## Recommendation, applicability, change and validation

| Recommendation / capability                                                    | Portcove decision                                                                                                                                                | Evidence or exception                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrate the whole workspace using the target CLI before replacing dependencies | Adopted pinned `vite-plus@1.2.0` migrator; retain its catalog/core alias/Vitest override/provider alignment                                                      | Original install and migrator logs retained; actual bundled metadata inspected                                                                                                                     |
| Root format/lint/check config; application config for actual plugins           | Removed standalone Oxc and Vitest configs; root exports shared test projects, each loading the app config                                                        | Root and package entrypoints exercised; type checking covers root and Node configs                                                                                                                 |
| Integrated `vp check` with both type options enabled                           | Replaces separate ordinary compiler and two-pass custom lint launches                                                                                            | Positive check processes 511 files; deliberate type, async, React, accessibility and formatting failures rejected                                                                                  |
| High-signal policy with real runtime boundaries                                | Correctness defaults, React/a11y and asynchronous/unsafe-type rules; Node scripts are untyped Node, not inferred typed browser modules                           | Full scan passes; test mock method references have a narrow unbound-method exception                                                                                                               |
| Coherent strict compiler policy                                                | Keep `strict`; retain the seven-module exact-optional/indexed-access pass as one explicit task                                                                   | Whole-app stricter trial produced 1,379 diagnostic lines; broad optional-prop/index migration would change application code well beyond this tooling cutover                                       |
| Lazy plugin factories and imports                                              | App plugin factories are skipped for metadata-only commands                                                                                                      | Root/browser regression exposed inherited plugin initialization; projects now load the actual app config independently                                                                             |
| Supported native Vite/Rolldown defaults                                        | Native Vite 8 bundling; default splitting/optimization; no speculative manual chunks or side-effect declarations                                                 | Actual app build and production-exclusion tests; existing large-chunk warning remains visible                                                                                                      |
| Tailwind/Lightning CSS and WebView targets                                     | Retain the direct Tailwind Vite plugin, with no added PostCSS/duplicate transformer; JS targets match Chrome 111/Safari 16.4 CSS features                        | This changes transforms, not OS support or #993's minimum-WebView qualification                                                                                                                    |
| Tauri dev/watch/environment integration                                        | Config owns loopback port 1420 and Rust-watch exclusion; ordinary and cached build aliases and Tauri before-build adapter strip signing values before Vite loads | Output/map sentinel tests retained; native Tauri smoke is a separate observation                                                                                                                   |
| Vitest projects and real-browser component interactions                        | Node/pure logic and jsdom state tests remain units; three ChoiceSelect cases moved to semantic, awaited real-browser interactions                                | Same test intent retained; 68 existing browser cases and three moved cases pass                                                                                                                    |
| Reconsider pools, workers, timeouts and reports                                | Removed hard-coded thread pool, CLI isolation flags, duration gate and ordinary JSON reports; keep measured two-worker unit bound                                | Full unit project passes; Browser Mode defaults pass without retries or raised limits                                                                                                              |
| Consolidate Node tests where worthwhile                                        | Retain dependency-free repository/bootstrap suites and Rust-only contributor paths                                                                               | These exercise provisioning without frontend dependencies and real subprocess contracts; no indiscriminate rewrite                                                                                 |
| Vite Task automatic tracking                                                   | Cache ordinary repeatable build/unit work; restrict restored build outputs to `dist/**`; no test output restoration                                              | Repeat hits, missing-output restoration and source/config/new/deleted/env invalidation observed                                                                                                    |
| Explicit inputs only for demonstrated gaps                                     | Add workspace lockfile to cached task input patterns                                                                                                             | Original automatic lockfile-only change hit the cache; explicit input makes it miss; original failed evidence retained                                                                             |
| Native TypeScript orchestration pass                                           | Keep this specialized task uncached                                                                                                                              | Linux direct compiler and uncached Vite Task pass; cached automatic tracking produces `execve EBUSY` in TypeScript 7.0.2. The main integrated check is unaffected.                                 |
| Fresh evidence and side effects                                                | Native journeys and aggregate verification tasks explicitly uncached; ordinary scripts uncached by default                                                       | A cache replay is never a new screenshot, native journey or acceptance run                                                                                                                         |
| Standard staged autofix and dispatcher                                         | Replace Husky/lint-staged dependencies, read-only preflight, custom formatter launcher and custom lint diagnostic parser                                         | Actual partial staging, failed-check restoration and noninteractive linked commit tests pass; relative staged paths avoid the reproduced Windows command-line limit                                |
| Linked-worktree installation                                                   | Retain a small installer scope adapter, using the exact CLI-generated dispatcher                                                                                 | Vite+ 1.2 uses common `git config --local`; adapter writes only current `--worktree` preferences and preserves common/sibling bytes and opt-out                                                    |
| Editor and agent discovery                                                     | Root Vite config, Oxc/Vitest extension pack and local CLI command; brief AGENTS pointer                                                                          | No personal executable paths or global-vp requirement                                                                                                                                              |
| Managed and no-global setup                                                    | SHA-pinned setup-vp 1.21.2 reads catalog and Node pin; contributors can use existing Node/pnpm with local Vite+                                                  | Windows Node 24.21.0/pnpm 12.11.2 observed with no global vp; Linux Node 24.21.0/pnpm 12.11.2 frozen install, check, unit, build and hook-interruption route passed; macOS awaits hosted execution |
| Dependency maintenance                                                         | Vite+ bundle entries upgrade together through the supported migrator; independent ordinary updates disabled, security-alert route retained                       | Actual installed provider/core checks support pnpm catalogs and reject mismatches; parser/React/Tailwind/Playwright remain directly consumed dependencies                                          |
| Cross-language orchestration                                                   | Retain just for Rust, native qualification, selection and guarded delivery; frontend commands delegate to Vite+                                                  | Removed redundant frontend check/build/test ordering rather than adding a second graph                                                                                                             |
| Sorting                                                                        | Keep built-in package.json sorting; import/class sorting remain optional upstream defaults                                                                       | No overlapping sort tool exists to remove; no speculative repository-wide import churn                                                                                                             |
| Hosted task-result cache                                                       | Not enabled                                                                                                                                                      | Upstream marks cross-run sharing experimental and advises measuring transfer overhead; local reuse is demonstrated without new hosted storage                                                      |
| Docker                                                                         | Not adopted                                                                                                                                                      | No existing frontend container deployment; Tauri native/WebView validation still needs its platform host; no contributor Docker requirement                                                        |
| tsdown / `vp pack`                                                             | Inapplicable                                                                                                                                                     | Portcove ships Rust/Tauri and C# outputs, with no distributable JS library/CLI or SDK to package                                                                                                   |
| Generators / scaffolding                                                       | Inapplicable                                                                                                                                                     | No demonstrated repeating new-package pattern; retain the existing actual transport generator                                                                                                      |

## Measurements and limits

All local measurements use the same Windows host and Node 24.21.0. Initial
baseline installation into the isolated checkout took 37.5 seconds. The migration
installed its changed dependencies in 6.1 seconds using a warm store, so those
are different cache conditions and not an installation speedup comparison.

Baseline type checking took 2.15 seconds and custom two-pass lint 3.60 seconds;
the new integrated check takes roughly 4-5 seconds including formatting and a
larger actual file scope. An initial baseline full unit run had two transient
subprocess/timing failures while other validation overlapped. Both failures are
retained; subsequent source-correct unit execution passed. No speed claim is
based on discarding those tests.

An isolated original Browser Mode run passed 68 tests in 87.94 seconds. The same
68 cases under the corrected new project configuration passed in 29.42 seconds;
the three migrated ChoiceSelect cases separately passed in 2.14 seconds. These
are individual observations, not a statistical benchmark or native WebView proof.
The measured unit suite passed 1,563 cases in 108 files after moving three cases
to Browser Mode. Its explicit cached task replay reports an 81.83-second saving.

A build task executed in 2.12 seconds; its immediate replay took 0.206 seconds.
Restoring a missing index from cached outputs took 0.197 seconds and reproduced
the complete original output hash inventory. Source/config/lock changes, new and
deleted source files, and changed public environment inputs caused execution.

Warm dev-server plus entry-transform observations were 0.452/0.689 seconds for
Vite and 0.642/0.783 seconds for Vite+. Vite+ adds command dispatch overhead here;
this migration does not claim faster dev startup. Recorded launcher RSS/CPU are
not comparable whole-tree resource measurements because Vite+ launches a Vite
child; they are retained as diagnostics only. The benchmark's first cleanup
attempt exposed that child boundary; corrected owned-tree cleanup was verified.

Production builds still report a large chunk. There is no speculative manual
chunk policy, suppressed warning, publication, changed updater trust or packaged
user runtime prerequisite. Native smoke, hosted exact-head checks, independent
review and final delivery identities are added to the owning PR/issue when
actually completed.

Independent review of the initial commit found dropped Stylelint coverage and
ordinary build aliases bypassing signing isolation. Both were repaired in the
shared commands with selection and real-child boundary regression checks. The
official Renovate 44.125.1 strict validator accepts the updated configuration.
A prefetched Windows frozen offline install succeeds; this does not promise
installation on an unprepared offline machine.
