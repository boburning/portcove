# Vite+ modernization: decisions and evidence

The subsequent [CSS architecture cutover](css-architecture.md), owned by #2009 under #917, supersedes the earlier stylesheet/reset/animation and compiler arrangement. Preserve the dated modernization measurements below as evidence of their actual source.

Initial migration: [#2001](https://github.com/boburning/portcove/issues/2001). Candidate baseline:
`7c45fcf11597967ed657a1ede8ea524d64502e2a`, inspected October 15, 2026.
This is an implementation record, not a second planning authority.

Further consolidation is owned by [#2004](https://github.com/boburning/portcove/issues/2004),
starting at `34e433feaf5e5db4817cdc692c13dac1b715d5d4`. Earlier measurements below
retain their original source and conditions.

| Responsibility                 | Current owner and change                                                                                                                            | Validation and final disposition                                                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Maintained TOML                | Bundled Oxfmt; removed Taplo, its configuration/launcher and separate command chains                                                                | Eleven pre-removal files preserve parsed meaning and idempotence; malformed input rejects. Ten maintained TOMLs remain. Native formatter configuration owns exclusions.                                                                                                                                                        |
| Installed operations           | Package-declared local `vp` executable, launched with its declared interpreter or native executable                                                 | Real ordinary/cache builds run with only Node on PATH, without Corepack/global vp/pnpm, and exclude signing sentinels from emitted files/maps. Pinned pnpm remains a provisioning prerequisite; Corepack is an optional provider.                                                                                              |
| Static copy and utility policy | Bundled Oxlint plugin and RuleTester replace the custom parser, traversal, discovery and CLI diagnostics                                            | Accessible attributes, cooked templates, entities, code exclusions and named technical disclosures retain positive/negative controls. Direct `oxc-parser` and its update rule are removed.                                                                                                                                     |
| Theme policy                   | Oxlint source patterns, Stylelint CSS rules, deterministic token/reference/contrast tests, actual browser outcomes, current emitted-CSS build guard | Missing aliases, cycles, weak contrast, raw colors and gradients reject. Browser controls cover semantic focus, applied contrast, no-blur scrims, forced colors, disabled/pending behavior and bounded RTL dialogs. No arbitrary stale dist file can stand in for current-build CSS.                                           |
| DOM and pure tests             | Node owns pure/SSR cases; Browser Mode owns DOM; native harnesses retain OS/IPC acceptance                                                          | All 69 prior jsdom suites and the direct JSDOM completion-focus fixture are reconciled. Standard React renderer/cleanup and renderHook replace ordinary root fixtures; explicit roots remain for controlled lifetimes, remounts and same-turn races. No jsdom packages remain in the clean dependency graph.                   |
| Production/test configuration  | App production config; root test projects in `scripts/frontend-tests.ts`                                                                            | Fresh-process production metadata does not initialize providers, traces or browser environment. Native tsconfig paths replace the alias. Default reporters are extended. Failed traces and screenshots retain unique owned namespaces under `work/bt`.                                                                         |
| Frontend orchestration         | One Vite Task graph: static, content/schema, Node, browser and build; full verification composes static/runtime groups                              | Package, just, local and CI consumers delegate. Audit executes the static/runtime nodes once each. Source policy runs before expensive feedback; unsupported partial exact-file matches fail.                                                                                                                                  |
| Execute/restore caching        | Vite Task owns the production bundle; specialized native/output code observes provenance only                                                       | Actual source/lock/environment/add/delete probes execute; reporter-only edits replay. Tampered/missing output restores correct bytes; failed source never becomes a success hit. Local/audit UI receipts cannot skip frontend execution. Native SDK completeness remains unknown, so Cargo/native acceptance still executes.   |
| Dependencies and maintenance   | One pinned coordinated Vite+ catalog; native pnpm lock generation and real Fallow consumers                                                         | Taplo, oxc-parser, jsdom, its types and esbuild are absent; direct TypeScript is removed. Required transitive TypeScript 7.0.2 remains through the existing graph, including Fallow's optional semantic sidecar. SWC remains for i18next tooling. No new processing engines or homemade lock/YAML/semver parser is introduced. |
| Specialized/inapplicable tools | Rust/native, CSS, localization and schema tools keep their distinct jobs                                                                            | No JavaScript library artifact calls for tsdown/pack, no new app calls for create/scaffolding, and no deployment calls for Docker. No remote task-result service or personal shell/runtime migration is required.                                                                                                              |

Oxfmt package-manifest sorting is enabled. Import-declaration sorting remains disabled:
the pinned formatter's `sortSideEffects: false` preserves bare imports' positions but
can move value imports across them, changing evaluation order. Tailwind sorting
also remains disabled after testing actual `cn` and `cva` composition: sorting
`cn("p-4 p-2")` to `cn("p-2 p-4")` changes the winning padding, and
`cn("px-4 p-2")` gains a different horizontal result after sorting. The same
merge occurs for classes returned by variants or passed through component
`className`. These are measured semantic exceptions, not an unimplemented sorter.

Normal checks preserve strict/exact-optional/indexed-access typing for production,
tests and configuration. Pnpm's non-strict 1440-minute policy and Renovate's strict
one-day/timestamp-required policy remain distinct; security retains its null-age
override. Vite+, the core alias, Vitest and browser provider upgrade together.

The browser migration exposed real focus behavior: a controlled select's internal
collection fallback could issue an unintended second preference write; it now
requires an actual interaction while preserving closed-trigger typeahead. Shared
return-focus ownership respects moved focus, pending state, close completion and
unmount. The explicit solid forced-colors dialog outline survives `cn` merging.

Final source review, hosted exact-head results, clean-install acceptance and native
refresh receipts are recorded on #2004 and its delivery PR. Earlier #2001/#2002
observations below remain historical and cannot approve this candidate.

The React renderer owns render/rerender/unmount act scopes. Deliberate external
promise, event and timer batches use a small test-only adapter around public
`React.act`, scoped to React's documented act-environment flag and restored in
`finally`. The renderer's public package exports no standalone act function.
Renderer operations stay outside this adapter; no global act-mode override,
private package import or console suppression is used.

Historical always-capture PNG calls had no pixel comparison or behavioral
assertion. Supported failure screenshots and retained traces now own browser
diagnostics; theme, focus, bounds, overflow and accessibility assertions remain.
Original failed captures and native visual evidence remain preserved.

## Consolidation measurements

Source-bound Windows observations compare the prior migration's equivalent
frontend inputs with the consolidation. They are individual observations, not
a general speed claim. Warm two-entry development startup was roughly one second;
192 identical pure cases took 3.81/3.66 seconds. Equivalent 121 DOM cases took
7.70 seconds in jsdom with two workers and 10.03 seconds in real Chromium with
four workers. The latter performs different work. Integrated checking took
5.47/6.48 seconds while its formatter/type scope expanded. Uncached builds and
cold setup had unequal cache histories and substantial variance.

Worker/pool/parallelism trials and upstream test doctor did not justify changing
the bounded two Node/four browser workers, default forks or isolation. Global
isolation removal remains rejected. Eager application imports showed no measured
loading bottleneck warranting new chunks or lazy boundaries. Production JavaScript
grew 0.69 kB (0.25 kB gzip); CSS fell 1.20 kB (0.10 kB gzip). The chunk warning
remains visible. Native first paint was not measured.

Actual ordinary cache entrypoints observed baseline/candidate replay at
0.251/0.257 seconds. Candidate explicitly fresh and subsequent miss observations
were 82.07/6.49 seconds with different cache histories; replayed build output is
not fresh execution. A sibling worktree's output digest remained unchanged.
Incomplete probes, failed runs and outliers remain retained on the owning lane.

The frozen registry graph fell from 581 to 493 distinct name/version records:
89 removals and one focused React integration addition. Windows physically
present reachable packages fell from 385 to 340: 46 removals and one addition.
Optional platform records and physical packages are separate inventories.
Required transitive TypeScript remains. Complete reports and delivery evidence
belong to #2004 and PR #2005.

## Repository rollback

Revert the consolidation's delivered commit(s) in a new owned branch based on
current main, review the resulting PR, install its restored frozen lock, and run
the canonical frontend graph plus affected native/hosted qualification. Use the
repository's guarded delivery route; a merge commit needs its correct mainline
parent, while a squash commit is an ordinary revert. Preserve later unrelated
commits and resolve conflicts explicitly. Do not reset main, force-push, delete
worktrees or rewrite history. Git reverses source, manifests and lock together;
normal pinned installation and Vite Task input tracking then select the matching
tools/outputs. Retain failure traces, qualification artifacts, caches and recovery
material. This is a source/tooling rollback and grants no authority to alter game
libraries, saves, preferences, credentials, signing material or installed updates.

## Historical initial migration: selected release and source review

[Vite+ 1.2.0](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.2.0)
coordinates Vite 8.3.4, Rolldown 1.2.13, Vitest 5.0.4, Oxlint 1.88.0,
Oxfmt 0.73.0, oxlint-tsgolint 7.0.2004 and tsdown 0.23.1. The installed
`vite-plus/versions` manifest verifies these values. The original manifests,
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

## Historical initial migration: applicability and validation

| Recommendation / capability                                                    | Portcove decision                                                                                                                                                | Evidence or exception                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrate the whole workspace using the target CLI before replacing dependencies | Adopted pinned `vite-plus@1.2.0` migrator; retain its catalog/core alias/Vitest override/provider alignment                                                      | Original install and migrator logs retained; actual bundled metadata inspected                                                                                                                                                                                                                                                                                |
| Root format/lint/check config; application config for actual plugins           | Removed standalone Oxc and Vitest configs; root exports shared test projects, each loading the app config                                                        | Root and package entrypoints exercised; type checking covers root and Node configs                                                                                                                                                                                                                                                                            |
| Integrated `vp check` with both type options enabled                           | Replaces separate ordinary compiler and two-pass custom lint launches                                                                                            | Positive check processes 511 files; deliberate type, async, React, accessibility and formatting failures rejected                                                                                                                                                                                                                                             |
| High-signal policy with real runtime boundaries                                | Correctness defaults, React/a11y and asynchronous/unsafe-type rules; Node scripts are untyped Node, not inferred typed browser modules                           | Full scan passes; test mock method references have a narrow unbound-method exception                                                                                                                                                                                                                                                                          |
| Coherent strict compiler policy                                                | Application-wide shared strict, exactOptionalPropertyTypes and noUncheckedIndexedAccess                                                                          | Maintained TS/TSX, typed tests/fixtures and Node/browser configuration projects use tsconfig.base.json; shared owner and consumer repairs replace the narrow exception                                                                                                                                                                                        |
| Lazy plugin factories and imports                                              | App plugin factories are skipped for metadata-only commands                                                                                                      | Root/browser regression exposed inherited plugin initialization; projects now load the actual app config independently                                                                                                                                                                                                                                        |
| Supported native Vite/Rolldown defaults                                        | Native Vite 8 bundling; default splitting/optimization; no speculative manual chunks or side-effect declarations                                                 | Actual app build and production-exclusion tests; existing large-chunk warning remains visible                                                                                                                                                                                                                                                                 |
| Tailwind/Lightning CSS and WebView targets                                     | Retain the direct Tailwind Vite plugin, with no added PostCSS/duplicate transformer; JS targets match Chrome 111/Safari 16.4 CSS features                        | This changes transforms, not OS support or #993's minimum-WebView qualification                                                                                                                                                                                                                                                                               |
| Tauri dev/watch/environment integration                                        | Config owns loopback port 1420 and Rust-watch exclusion; ordinary and cached build aliases and Tauri before-build adapter strip signing values before Vite loads | Output/map sentinel tests retained; native Tauri smoke is a separate observation                                                                                                                                                                                                                                                                              |
| Vitest projects and real-browser component interactions                        | Node/pure logic and jsdom state tests remain units; three ChoiceSelect cases moved to semantic, awaited real-browser interactions                                | Same test intent retained; 68 existing browser cases and three moved cases pass                                                                                                                                                                                                                                                                               |
| Reconsider pools, workers, timeouts and reports                                | Removed hard-coded thread pool, CLI isolation flags, duration gate and ordinary JSON reports; keep measured two-worker unit bound                                | Full unit project passes; Browser Mode defaults pass without retries or raised limits                                                                                                                                                                                                                                                                         |
| Consolidate Node tests where worthwhile                                        | Retain dependency-free repository/bootstrap suites and Rust-only contributor paths                                                                               | These exercise provisioning without frontend dependencies and real subprocess contracts; no indiscriminate rewrite                                                                                                                                                                                                                                            |
| Vite Task automatic tracking                                                   | Cache ordinary repeatable build/unit work; restrict restored build outputs to `dist/**`; no test output restoration                                              | Repeat hits, missing-output restoration and source/config/new/deleted/env invalidation observed                                                                                                                                                                                                                                                               |
| Explicit inputs only for demonstrated gaps                                     | Add workspace lockfile to cached task input patterns                                                                                                             | Original automatic lockfile-only change hit the cache; explicit input makes it miss; original failed evidence retained                                                                                                                                                                                                                                        |
| Native TypeScript orchestration pass                                           | Removed; no remaining distinct responsibility                                                                                                                    | The duplicate compiler task, config, selected-inventory test and POSIX tracking workaround are retired; integrated check is the compiler gate                                                                                                                                                                                                                 |
| Fresh evidence and side effects                                                | Native journeys and aggregate verification tasks explicitly uncached; ordinary scripts uncached by default                                                       | A cache replay is never a new screenshot, native journey or acceptance run                                                                                                                                                                                                                                                                                    |
| Standard staged autofix and dispatcher                                         | Replace Husky/lint-staged dependencies, read-only preflight, custom formatter launcher and custom lint diagnostic parser                                         | Actual partial staging, failed-check restoration and noninteractive linked commit tests pass; relative staged paths avoid the reproduced Windows command-line limit                                                                                                                                                                                           |
| Linked-worktree installation                                                   | Retain a small installer scope adapter, using the exact CLI-generated dispatcher                                                                                 | Vite+ 1.2 uses common `git config --local`; adapter writes only current `--worktree` preferences and preserves common/sibling bytes and opt-out                                                                                                                                                                                                               |
| Editor and agent discovery                                                     | Root Vite config, Oxc/Vitest extension pack and local CLI command; brief AGENTS pointer                                                                          | No personal executable paths or global-vp requirement                                                                                                                                                                                                                                                                                                         |
| Managed and no-global setup                                                    | SHA-pinned setup-vp 1.21.2 reads catalog and Node pin; contributors can use existing Node/pnpm with local Vite+                                                  | Windows Node 24.21.0/pnpm 12.11.2 observed with no global vp; Linux Node 24.21.0/pnpm 12.11.2 frozen install, check, unit, build and hook-interruption route passed; macOS qualification is recorded by exact source/run on #2002                                                                                                                             |
| Dependency maintenance                                                         | Automatic primary Vite+ proposals; supported coordinated completion from verified pre-upgrade inputs                                                             | Real Renovate 44.156.3 extraction/resolved rules and security force rules pass; isolated primary-only graph rejected and 1.1.0-to-1.2.0 reconstruction/migration passed                                                                                                                                                                                       |
| Cross-language orchestration                                                   | Retain just for Rust, native qualification, selection and guarded delivery; frontend commands delegate to Vite+                                                  | Removed redundant frontend check/build/test ordering rather than adding a second graph                                                                                                                                                                                                                                                                        |
| Sorting                                                                        | Keep built-in package.json sorting; import/class sorting remain optional upstream defaults                                                                       | No overlapping sort tool exists to remove; no speculative repository-wide import churn                                                                                                                                                                                                                                                                        |
| Hosted task-result cache                                                       | Not enabled                                                                                                                                                      | Upstream marks cross-run sharing experimental and advises measuring transfer overhead; local reuse is demonstrated without new hosted storage                                                                                                                                                                                                                 |
| Docker                                                                         | Genuinely inapplicable                                                                                                                                           | No existing frontend container deployment; native/WebView validation requires its platform host. No container requirement is created                                                                                                                                                                                                                          |
| tsdown / `vp pack`                                                             | Inapplicable                                                                                                                                                     | Portcove ships Rust/Tauri and C# outputs, with no distributable JS library/CLI or SDK to package                                                                                                                                                                                                                                                              |
| Generators / scaffolding                                                       | No additional local generator is applicable                                                                                                                      | Repeated UI primitives already use the configured shadcn Base UI/TSX system (apps/desktop/components.json). Feature hooks, boundary modules, pure tests, jsdom tests and browser fixtures have materially different owners/lifecycles; no stable repeated whole-feature/test skeleton warrants another generator. Retain the schema-owned transport generator |

## Historical initial migration: measurements and limits

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
official Renovate 44.156.3 strict validator accepts the updated configuration.
A prefetched Windows frozen offline install succeeds; this does not promise
installation on an unprepared offline machine.

## Historical expanded scope for #2001, October 15

The owner superseded the earlier publication-age hold and narrow strictness
exception. Historical age failures and earlier review remain historical; they
cannot approve the expanded source. The final policy uses pnpm 1440 minutes,
non-strict, and Renovate one day/strict filtering with native timestamp-required
handling. Security alerts retain their null age override. The custom blocking
age audit, callers and artifacts are removed; dependency-review still executes.

Native pnpm 12.11.2 observations used real registry timestamps and clocks:
Vitest ^5.0.4 resolved to eligible 5.0.4 while exact 5.0.5, published about three
hours earlier, resolved through non-strict fallback. Its frozen install passed.
Separate altered-integrity and stale-manifest frozen fixtures each failed with
exit 1. This demonstrates the intended preference, not universal installed age.
No contributor global configuration was changed and Vite+ remains 1.2.0.

The expanded strictness trial classified 508 diagnostics across 88 files (186
production, 321 typed tests, one browser fixture). Shared UI observation and
callback contracts accept explicit undefined where they have no key-presence
semantics; state/options reconstruction omits absent fields. Complete fixture
seeds, truthful fixed tuples and checked lookups preserve valid and invalid test
states. Core's nonempty catalog channel/platform invariant is checked at the
selection boundary, with regression coverage. Generated declarations remain
schema-owned and unchanged; TypeScript remains an editor/API dependency.

Necessary steady-state integration consists of signing filtering, linked-worktree
hook scoping, cross-language commands and specialized CSS/TOML/content/schema
checks. Hosted result sharing is not enabled under the no-additional-spending
constraint and upstream's experimental status. Optional import/class sorting has
no overlapping legacy tool to replace. Packaging and Docker are inapplicable;
scaffolding's actual component/test/feature patterns were reassessed above. These
are final dispositions, not deferred migration work.

Expanded Windows integrated typing and 1,567 unit tests passed during development.
The initial migration was delivered through #2002 and completed #2001. Its review,
native and exact-head CI receipts remain bound to that delivered source. Current
consolidation evidence belongs to #2004; these historical measurements are not
new consolidation benchmarks.
