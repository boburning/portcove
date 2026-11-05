# Vite+ 1.5 evaluation

Issue [#4399](https://github.com/boburning/portcove/issues/4399) owns this upgrade.
The starting source is `84844da3b55a7464a22e2ab363a2e9c57675e06a`.

## Release authorities

- [Vite+ 1.5.0](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.5.0)
- [Vitest 5.1.0](https://github.com/vitest-dev/vitest/releases/tag/v5.1.0)
- [Import-map mocking](https://main.vitest.dev/config/browser/importmapmocks)
- [Affected-test selection](https://main.vitest.dev/guide/recipes/affected-tests)
- [CLI selection flags](https://main.vitest.dev/guide/cli)

The release's actual npm package metadata and installed declarations remain the
version-specific authority when current documentation advances.

## Decisions and boundaries

The compatible target is Vite+/core 1.5.0, Vitest/browser provider/coverage 5.1.0,
Oxlint 1.91.0, type-aware lint 7.0.2005, Oxfmt 0.76.0, Rolldown 1.2.16 and
tsdown 0.23.4. Node 26.13.0 and pnpm 12.16.1 retain their separate repository
pins. No standalone upgrade beyond Vite+'s bundle is intended.

The official image index for `ghcr.io/voidzero-dev/vite-plus:1.5.0` was fetched
from GHCR. Its response digest and independently computed SHA-256 agree:
`sha256:cce163cdf4cf3fff928925e03a815910be14d34c355fe40b4e79e766fe368f63`.
It declares Linux amd64 and arm64 manifests. Digest discovery is distinct from
executing Portcove's Windows-driven container adapter.

Vitest's browser API and Vite's server have separate listeners. Browser projects
need `test.api.port: 0` as well as the existing Vite `server.port: 0`.
Tauri's explicit development-server port 1420 remains an application contract.

`--last-failed` selects cached test names. Renaming a failed case can therefore
omit it. The supported developer workflow must replay complete failed files,
using the public `cache.getTestSpecificationResult` API, with full fallback
when prior state cannot establish a useful current selection. This is diagnostic
feedback, never a substitute for the ordinary complete-diff CI plan.

`--since-last-run` records dependencies and compares filesystem modification
times. It cannot detect backdated checkout/copy changes or newly introduced
resources that no previous run loaded. Its positional-filter interaction also
has an [upstream report](https://github.com/vitest-dev/vitest/issues/11864).
Portcove retains exact/related selection and its conservative empty-selection
fallback instead of introducing a second content/dependency cache authority.
The actual 5.1 probe changed a JSON file read through `readFileSync` after a
successful recorded run. `--sinceLastRun` reported no changed files and exited
zero; an unfiltered run detected the resulting assertion failure. Both kebab
and camel-case spellings parse, but native help uses the camel-case spellings.

Native Node executes the maintained erasable `.mts` scripts with explicit runtime
extensions and NodeNext resolution. `vite-plus/register` additionally supports
transformation and source-extension remapping, including JSX specifiers; no
maintained script currently requires these. Adding a loader to every supervised
Node process would add resolution/startup work and another compatibility boundary.
Native Node execution and registered Node test reporters therefore remain.
Three interleaved `.mts`/sibling-import/Node-test controls passed with each route.
Their small, noisy startup timings do not establish a representative speedup.

The existing browser trace reporter confines physical output roots, owns fresh
invocation namespaces, validates bounded capture/accessibility annotations and
retains the deliberate probe's outcome. Frontend observations retain case and
run identity, source/attempt provenance and skip-route completeness. Upstream
timelines do not replace these responsibilities. Keep these reporters and use
the upstream failure-only timeline and retry diagnostics alongside them.

Successful runs should not gain verbose trace timelines. Playwright retains
failure traces and screenshots under the existing custody and resource limits.
The [upstream retry-trace issue](https://github.com/vitest-dev/vitest/issues/11865)
does not justify replacing `retain-on-failure` with `on-first-retry`.

The scoped `glob@13.0.6` override still protects `cacache@21.0.1`, which declares
`glob: ^13.0.0`; Vite+ upgrading does not prove that parent safe. The scoped
`minimatch@10.2.6` override also protects the retained Renovate probe engine.
`i18next-cli@1.82.4` already declares glob 14 and minimatch 11. Preserve the narrow
overrides until every retained parent is shown safe. Vite+ 1.5's own native CLI
ships the minimatch 11.0.4 and zstd 0.13.4 security fixes; this does not remove
the need to inspect independent npm or Cargo consumers.

Oxlint's new `typescript/no-unsafe-enum-assignment` is enabled in the existing
type-aware TypeScript policy. The now-suspicious
`typescript/no-non-null-asserted-nullish-coalescing` also becomes an explicit
error; it was previously a restriction rule. Existing React, accessibility,
promise, import and unsafe-operation checks remain. The 1.91 React compiler
regression flagged twelve effect/invocation-local assignments. Each exception
is limited to that assignment line and cites oxc#28401; separate review confirmed
none hides prop or render-state mutation. Oxfmt 0.76 accepted all 3,802 discovered
files after formatting only the edited inputs. Integrity exclusions remain.

| Existing responsibility                                  | Upstream replacement decision                                                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact/related selection and executed-file reconciliation | Retain: raw CLI filters and incremental state do not establish complete literal selection.                                                               |
| Failed-test history                                      | Consume Vitest's public native cache; add no history files or cache namespace manager. Replay complete files, with conservative freshness/full fallback. |
| Resource, process-tree and staged-command guards         | Retain: Vite task orchestration does not provide host admission, confinement, ownership or exact-argument guarantees.                                    |
| Trace/capture custody and case observations              | Retain: upstream timelines do not replace bounded annotations, invocation roots, skip reconciliation or source/run/attempt identity.                     |
| Successful parity screenshots                            | Retain: CI explicitly uploads these named renderer states; failure-only traces do not replace that information.                                          |
| Toolchain resolution, hooks and compatibility            | Retain the installed-executable/argv protections and coordinated graph check; extend the latter to coverage.                                             |

No custom infrastructure was removed without an equivalent replacement. The
failed-file workflow extends `just test-ui`; there is no additional wrapper or
package command. Upstream failure-only timelines and attempt diagnostics improve
failure reporting without verbose successful-run timelines.

## Measurements and validation

Cold means a fresh owned Vite optimizer cache, not a cold operating-system page cache.
Warm means a new process reusing that optimizer cache. Resource queue time is
separate from runner time. Upstream benchmark claims are not Portcove results.

The [retained measurement data](viteplus-1.5-browser-2026-11-04.json) contains
every run, selected-file hashes and existing CI phase metrics. Each mode ran
the same four files and 105 cases once cold and three times warm. All twelve
representative runs passed. Conditions: WSL Linux x64 on the shared Windows host,
Node 26.13.0, pnpm 12.16.1, Playwright 1.64.1, Chromium 156.0.8078.4, unchanged
four-browser-worker limit. No operating-system cache flush or CPU isolation was
performed; these are developer feedback measurements, not a hardware benchmark.

| Mode               | Cold wall | Warm wall median (range) | Cold runner startup | Warm startup median | Cold test execution | Warm test execution median |
| ------------------ | --------: | -----------------------: | ------------------: | ------------------: | ------------------: | -------------------------: |
| 1.4 / interception |  17.095 s | 15.543 s (14.646-15.777) |             0.717 s |             0.958 s |            15.942 s |                   13.242 s |
| 1.5 / interception |  18.457 s | 15.862 s (15.356-15.886) |             1.881 s |             0.924 s |            16.129 s |                   14.458 s |
| 1.5 / import maps  |  17.662 s | 17.287 s (16.279-17.316) |             2.270 s |             1.074 s |            14.947 s |                   15.440 s |

Startup sums runner import, configuration and project initialization. Execution
is the existing `ui-test-execution` phase. Native summaries also expose import,
setup and worker percentages; an independent absolute module-transformation cost
is not exposed by this browser route, so none is inferred. Import maps made warm
wall time about 9% slower than interception on the same bundle. There is no
demonstrated overall runtime speedup from this upgrade. Interception remains the
default, with `PORTCOVE_BROWSER_IMPORT_MAP_MOCKS=1` available for investigation.

Local observations before delivery:

- Installed graph and root pnpm toolchain-lock validation passed; actual versions
  matched the selected catalog. The supported global provider's `vp env doctor`
  reported no issues. `env` is a global-only command; the repository-local 1.5
  executable supplies project commands and reports its exact bundled versions.
- The official migrator completed. Its age exclusions were removed. A subsequent
  frozen install correctly refused the ten still-young Vite+ 1.5 entries. The last
  relevant publication is `2026-11-04T04:33:23Z`; retain the 1,440-minute policy
  and qualify again after `2026-11-05T04:34:00Z`. This refusal is not a pass.
- Static/type checks, Stylelint, content/i18n contracts, production frontend build
  and eight selected registered Node contract files passed. Unit execution passed
  92 files and 1,153 cases, with the declared Windows-only skip on Linux.
- Actual failed-file feedback replayed both a renamed repaired case and its
  surviving sibling. Empty failure history selected the full requested scope.
  Missing/stale/malformed history and moved-file controls passed in the selector
  contracts. CI/coverage incremental feedback is rejected before runner startup.
- The maintained deliberate-failure probe verified 41 Playwright trace events and
  a decoded 414x896 PNG, retained its outcome and reported attempt index zero.
- Extended local browser diagnostics were gracefully interrupted: import maps
  after 1,008.197 seconds without observed failures, and interception after
  660.816 seconds. Neither run establishes full-suite acceptance. The latter
  recorded three 15-second screenshot harness timeouts in Artwork and SourceIntake.
  A focused unchanged-source replay of both complete files passed all 50 cases in
  10.05 seconds of native execution. This does not prove a causal repair.

After age eligibility, hosted catalog attempt 2 at
`e9e8ac96cb648c074334e29344f1f837586fe442` exposed a pre-existing provisioning
omission: `release-publication-source.test.mts` calls Desktop's release-version
policy but its registered ownership lacked `desktop_dependencies: true`.
The root-filtered install therefore could not resolve Desktop's `semver`.
Declare that prerequisite through the existing registry and cover both direct
selection and the combined upgrade’s all-fast fallback in the baseline contracts. This adds
no dependency, job or release authority; the failure remains in
[the original run](https://github.com/boburning/portcove/actions/runs/41963472820).

The [public controller tool fixtures](https://github.com/boburning/portcove/actions/runs/41963472867)
reached fixed Node bundling after the age gate opened and refused the stale
trusted Pack 1.4 pin. The coordinated upgrade moves that exact identity to 1.5
and shares it across the installed-pack check, manifest writer and manifest
reader. A contract compares it with the trusted workspace catalog; candidate
source cannot choose a bundler. The existing fixtures still exercise actual
fixed tool builds and custody without signing or publication effects.

Full exact-head CI, Windows/container qualification, final review and delivery
readback remain separate observations recorded on the owning issue and its linked
pull request. These local results do not establish native application or release
acceptance.
