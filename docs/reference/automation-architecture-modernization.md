# Automation architecture modernization

Phase 1 owner: completed [#3662](https://github.com/boburning/portcove/issues/3662).
Phase 2 owner: the existing development-agility [#1104](https://github.com/boburning/portcove/issues/1104).
Investigation baseline: `ba55e9a06357d0230ad9c65a48c96fe93f226a56`, October 25,
2026 (America/New_York). This is dated implementation evidence, not a planning
ledger. #2420 retains the canonical testing-audit recommendations; #1667 retains
its frozen bootstrap scope. Completed #2004 remains credited by the existing
[Vite+ decision record](viteplus-modernization.md). This elective work adds no
Public beta prerequisite to #921.

## Responsibility inventory

The tracked baseline contains 909 files under root `scripts/` (847 direct),
164 under `apps/desktop/scripts/` (158 direct), 382 root `release-` files,
26 workflows, six files in composite actions, and two container Dockerfiles in
`tools/`. Tests, fixtures, modules and executable adapters are separate roles;
these counts are not independent responsibilities or deletion targets.

| Domain              | Authoritative behavior and actual entrypoints                                                                                                                                                                             | Disposition                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer tools     | Just exposes commands; package scripts delegate to Vite Task; `development-capabilities.mts`, quality/tool-cache modules own provisioning; storage/resource modules own host admission                                    | Retain installed-tool and process/resource boundaries. Do not add a command namespace.                                                         |
| Ordinary validation | `validation-plan.mts` owns shared local/hosted impact; `ordinary-validation.mts` maps impact to optional commands; `local-validation.mts` owns discovery, preflight and receipts; `ci-baseline.mts` owns hosted execution | Simplify existing execution and obsolete state; no new planner.                                                                                |
| Node tests          | `node-test-suites.json` and `node-test-suites.mts` generate/check executable lists in Just, CI and Windows qualification                                                                                                  | Generated lists are projections, not independently maintained policy. Preserve explicit executable inventory checks.                           |
| Frontend            | Root Vite+ configuration owns static, content, test projects and task composition; desktop config owns production/dev; build adapter sanitizes environment and checks output custody                                      | Use supported project routing; retain literal-file execution reconciliation because filename filters can partially match.                      |
| Rust                | Cargo metadata and maintained impact map own packages/families; nextest inventory/outcome reconciliation proves coverage; runner/supervisor owns admission and descendant cleanup                                         | Keep Cargo incremental artifacts and current one-build/shard work. #3661 owns active Windows cold/warm profiling.                              |
| Roadmap             | `roadmap.mts` adapts commands and GitHub; inventory, authoring, scoped checks and reports already have modules; Project owns planning                                                                                     | Avoid a second API inventory or mutable backlog. Large size alone does not justify a rewrite.                                                  |
| Catalog             | Generator modules own authoring; upstream observer/health modules own observations; Core and definition-delivery contracts own admission                                                                                  | Observation, retained history, authoring and signed admission have different trust boundaries.                                                 |
| Release             | Coordinator/state/journal/recovery modules own durable progress; admission/custody/signature/publication modules and native adapters enforce separate authorities                                                         | Keep distinct security decisions. Extract only a demonstrated cohesive seam with preserved adversarial oracles, not one generic state manager. |
| CI                  | Actions invoke the same selectors/runners; setup and browser-diagnostic composite actions own repeated setup/upload behavior                                                                                              | Preserve the five exact-head contexts, attempt-bound producers, permissions and cancellation.                                                  |

Static imports, literal commands, package scripts, task configuration, generated
registries, workflow/composite callers and documentation were examined together.
A file without a static importer is not considered dead: command strings,
workflow artifacts and native helper inventories are runtime consumers.

## Installed Vite+ capability evaluation

Both the resolved package and `vp toolchain` report Vite+ 1.3.0, Vite 8.3.4,
Vitest 5.0.5, Rolldown 1.2.14, Oxlint 1.88.0, Oxfmt 0.73.0 and
oxlint-tsgolint 7.0.2004. Local package docs were compared with the current
[run reference](https://viteplus.dev/config/run),
[tracking documentation](https://viteplus.dev/guide/automatic-data-tracking),
[cache documentation](https://viteplus.dev/guide/cache) and
[test documentation](https://viteplus.dev/guide/test).

| Requirement                 | Verified installed capability                                                                                   | Portcove boundary                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task execution/dependencies | Commands/ordered arrays, `dependsOn`, package task references, workspace dependency fields, bounded concurrency | Existing nested `vp run` is already expanded without nested runner processes. Replacing its syntax is not an optimization. Arrays preserve existing cheap-first order.                       |
| Workspace/affected work     | Recursive and filtered workspace tasks; dependency ordering follows package manifests                           | One JavaScript application workspace does not describe native, release and rename/delete trust impact. Keep the existing selector.                                                           |
| Deterministic caching       | Arguments/environment plus automatic or explicit inputs; declared outputs restored on hits                      | Existing `frontend:bundle` is the build reuse authority. Do not layer another cache over it or Cargo.                                                                                        |
| Test discovery/selection    | Vitest projects, list and related APIs, literal specifications, public execution results                        | Preserve exact requested/executed reconciliation, missing/duplicate-file refusal, explicit intentional skips and conservative related fallback.                                              |
| Test reporting              | Default reporters plus public custom reporter hooks, per-project case identity, browser traces/screenshots      | One invocation can retain all four projects and their distinct identities. Diagnostics do not become acceptance.                                                                             |
| Formatting/lint/types       | Integrated `vp check` with type-aware/type-check options and root formatting/lint config                        | Already delivered. Stylelint/localization/schema tools provide separate behavior. Native Node syntax must additionally reject transformations and JavaScript early errors without execution. |
| Build/developer environment | Vite build/dev/preview; global environment provider and installed package CLI                                   | Already delivered. Preserve no-global operational support and pinned provisioning; retain Rust/native profiles.                                                                              |

Disposable Windows and Linux task probes exercised nested expansion, changed
inputs, warm reuse and tampered-output restoration. Two identical nested commands
ran the payload once on the first invocation, zero times on the warm invocation,
and once after input mutation. These are framework controls, not repository
feedback-time measurements. Windows initial/replay observations were 827/82 ms;
Linux 70/46 ms. Different hosts and cache histories are not a speed comparison.

### Cache decisions

`frontend:bundle` retains tracked execute/restore ownership and output checks.
Static/content/test/native tasks retain `cache: false`: tests provide fresh
execution evidence; content checks include live schema/IPC and generated-file
contracts; native tasks include mutable host state. The build wrapper's outer
task remains uncached so admission, output cleanup and environment filtering run
before the inner deterministic bundle reuse. Composite groups remain uncached;
their leaves own reuse. Security queries, signing, publication and release
qualification remain fresh under their own contracts. The framework probe does
not establish complete input coverage for an additional production cache.

## Bounded framework decisions

No permanent dependency is added for an unproven replacement. These are fit
decisions for this repository, not universal framework rankings.

| Candidate                                                                    | Decision and replaced infrastructure                                             | Cost, compatibility and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite+ / Vitest                                                               | Retain and use supported shared-project execution; preserve existing build cache | Already installed. Task/workspace/cache/static/environment functions cover the JavaScript needs. Domain selection and native trust remain custom.                                                                                                                                                                                                                                                                                                                                               |
| [Citty](https://github.com/unjs/citty)                                       | Do not adopt for this assignment                                                 | Typed nested/lazy commands and generated usage are useful, but Just already exposes commands and Roadmap has configuration-specific parsing/help. No demonstrated deletion outweighs migrating established defaults, stdout/JSON, exits and bootstrap-without-dependencies behavior. Native `util.parseArgs` remains an option for an actual isolated parser need.                                                                                                                              |
| [Commander](https://github.com/tj/commander.js)                              | Do not adopt                                                                     | Mature nested commands/help; strong inferred option types use extra typings. Executable subcommands can add processes. A new umbrella CLI would leave existing entrypoints and add compatibility machinery rather than retire a verified consumer set.                                                                                                                                                                                                                                          |
| [Moon](https://moonrepo.dev/docs/guides/rust/handbook)                       | Do not migrate                                                                   | Strong Rust/JavaScript task graph, affected inputs and caches, but adoption adds project/toolchain/task configuration beside existing Vite+/Just/Cargo owners. Upstream explicitly discourages archiving Cargo target as a task output. No measured replacement of resource custody, qualification or complete inventory guards; no production installation justified.                                                                                                                          |
| [Nx](https://nx.dev/docs/features/run-tasks)                                 | Do not migrate                                                                   | Inferred tasks, affected projects and caches suit larger project graphs; native coverage still requires repository adapters. Another task/config/plugin graph gives no demonstrated advantage for one JS workspace and the existing Cargo workspace. Startup and maintenance costs were not benchmarked because no concrete replacement survived the fit assessment.                                                                                                                            |
| [Turborepo](https://turborepo.dev/docs/core-concepts/package-and-task-graph) | Do not migrate                                                                   | Package/task DAG and declared-output caching overlap Vite Task; Cargo/native and protected release obligations still need existing policy. `turbo.json` and a binary would add an owner without deleting one.                                                                                                                                                                                                                                                                                   |
| [XState](https://stately.ai/docs/persistence)                                | Do not adopt for release state                                                   | Explicit transitions/guards and persisted actor snapshots do not replace journal identity, external-effect reconciliation, transactional custody or publication authorization. Existing coordinator/state/recovery modules already own these. A second snapshot format requires migration and adversarial equivalence without a demonstrated simplification; no security-sensitive spike justified.                                                                                             |
| [Octokit](https://github.com/octokit/octokit.js)                             | Do not replace current transport wholesale                                       | Maintained typed REST/GraphQL, pagination, authentication, retries/throttling are valuable. Existing `gh` authentication is shared with owner workflows; custom wrappers enforce deadlines, bounded bytes, immutable IDs/totals, exact-head writes and incomplete-inventory refusal. Octokit would not retire those checks; default retries and async migration require deliberate mutation reconciliation. Revisit only for a concrete client whose transport/parsing can actually be removed. |
| Existing YAML/Ajv/semver/native APIs                                         | Retain                                                                           | Already installed for actual parsing/schema/version requirements. Do not add a second parser, schema language or subprocess framework.                                                                                                                                                                                                                                                                                                                                                          |

Rejected frameworks require no rollback. Implemented changes use ordinary Git
reverts on current main, preserving the pinned lockfile and rerunning affected
contracts/required CI. Temporary spikes and downloaded experimental dependencies
are not part of the maintained source tree.

## Phase 1 execution and measured results

Phase 1 merged in [PR #3664](https://github.com/boburning/portcove/pull/3664),
merge `dfae6ed53b7b4509a1335d91b3939d8e545a6d19`, reviewed source
`c0c8839a4c28691da7fa5038313d9a4032fd4fe0` against target
`fcb685a3611f850d1ac417adb63f4a07ad414413`. Initial Linux
provisioning used a new isolated checkout and a frozen install; browser download
and readiness took 8.55 seconds including admission/setup. This is setup, not
warm validation or a product improvement. The pre-change local validation and
native parser contracts passed 130 cases in 8.97 seconds. Exact-source selected
command inventories were captured for frontend, focused Rust, tooling, mixed,
catalog, release, shared, unknown, rename and deletion changes before edits.

### Implemented responsibility changes

- `frontend:runtime` and shared/ambiguous ordinary frontend selection delegate
  all four projects to one uncached `frontend:tests` task. Existing focused unit,
  browser, literal and related commands remain. Hosted browser prerequisite
  acquisition consumes the surviving all-project obligation; it cannot disappear
  with the retired separate browser stage.
- Native TypeScript syntax selection batches literal files through the existing
  checker and reuses the existing 6,000-character native argument budget. JavaScript early-error subprocesses, transformation refusal,
  fail-fast behavior, missing/deleted-file handling and storage scope remain.
  Receipts union every selected file's domains and retain complete argument
  identity and source-change refusal. One old per-file receipt cannot satisfy
  the new batch recipe.
- Removed unused doctest metadata acquisition/diagnostic code and write-only
  `rustChanges`, `workspaceRustTests`, `lintToolFixtures` and planning state.
  Existing workspace compilation/selected-family commands and fallback tests
  remain the regression detectors. Three tests of the retired helper/state
  were removed; executable syntax, receipt and task guards were added.
- `roadmap-issue.mts` owns the existing issue record, marker, form, duplicate,
  rendering and projection behavior. Real production/test imports migrated
  directly; no executable aliases or forwarding wrappers were introduced.
  Durable-body admission, live GitHub clients, inventories, scoped/global
  doctor, mutation limits and reconciliation retain their existing owners.
  The extracted source inherits the former protected/release-security impact
  and complete Roadmap plus discovery/provenance regression consumers.

```text
Just / package / Actions
  -> existing shared validation selection
     -> Vite Task -> one full Vitest invocation (focused commands retained)
     -> native syntax checker -> one literal-file batch
     -> Cargo / native runners and existing custody

Roadmap CLI / planning ----+
Discovery / provenance ---+-> roadmap-issue (pure issue behavior)
Roadmap CLI -> existing live inventory / policy / guarded mutation modules
```

### Comparable observations

| Scope                                                                             | Before                                                                                          | After                                                                                 | What is established                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ten unchanged native TS checks; five alternating rounds, same Linux checkout/Node | Median 953.2 ms; ten checker processes plus ten `node --check` children                         | Median 345.5 ms; one checker plus the same ten children                               | Nine outer startups/type-strip initializations removed; every syntax obligation remains. This is not Rust compilation or full validation time.                                                                      |
| Fresh discovery identity import; seven alternating rounds                         | Median 92.04 ms; 26 local modules                                                               | Median 46.55 ms; five local modules                                                   | Baseline scripts copied from exact Git source into an inert snapshot; current leaf consumers no longer initialize API/locks/cache/dependency-policy/reporting modules. Both roots are on the same Linux filesystem. |
| Selected command plans                                                            | Ten exact-source frontend/Rust/tooling/mixed/catalog/release/shared/unknown/rename/delete cases | Same expanded commands and validation decisions; tooling example seven stages to four | Syntax batches expand to the identical file list; all-project frontend task expands to prior unit/browser obligations. Counts do not establish elapsed-time gains.                                                  |
| Full frontend baseline                                                            | Unit 30.7 s; browser 421.9 s                                                                    | 499.9 s; 2,407 passing tests and two explicit skips                                   | Baseline reports 931 unit and 1,476 browser passes, plus two explicit skips. First-run cache history differs; no whole-suite speedup is inferred from a later run.                                                  |
| Vitest discovery; three alternating rounds, same 211 files                        | Median 5.398 s across separate project discovery                                                | Median 2.926 s in one invocation                                                      | Discovery improved; this does not establish faster test execution.                                                                                                                                                  |
| Strict tooling check                                                              | Existing strict projects                                                                        | 1,345 files, zero warnings/lint/type errors; 8.5 s checker / 10.7 s guarded total     | Actual changed-interface coverage. The first attempt's eight test-typing errors were repaired, not suppressed.                                                                                                      |

Phase 1 changed 38 files: production TypeScript net −139 lines, tests +86,
docs/configuration +222, net +169. It removed no whole files or dependencies.
The final run reconciled the complete 2,409-case identity/outcome multiset with
the baseline. Its 499.9 seconds versus the baseline's 452.6 seconds (30.7 unit +
421.9 browser) does **not** demonstrate an overall frontend speedup: contention
and cache histories differed. An earlier 600-second outer harness timed out;
the inner run eventually succeeded at 635 seconds. The calibrated 900-second
harness passed later; neither the original failure nor the changed conditions
are discarded. Product deadlines and assertions were unchanged.

[Required CI run 40257460897](https://github.com/boburning/portcove/actions/runs/40257460897)
passed `catalog`, `dependency-review`, `frontend`, `rust` and `rust-quality`.
Creation-to-completion was 580 seconds; frontend was 546 seconds, catalog 125,
Windows helper contracts 251 and Rust quality 59. These are observed hosted
job times, not a comparable hosted before/after performance claim. #3662 closed
with targeted Project reconciliation; the broader #1104 remained open. Scoped
doctor success did not claim global Roadmap health.

Local Node uses v24.22.1 with the pinned frontend lock. Setup, admission queue,
subprocess initialization, compilation and tests are different costs. The
original full-frontend failure-control fixture timed out and was removed from
maintained tests; its result supplies no success evidence. The first combined
candidate queued behind other work and was correctly refused after source edits;
it executed no tests and is not a product failure or timing result. Preserve
these original failures alongside subsequent evidence.

Rust compilation/linking and cold/warm hosted critical-path timing were not
remeasured by changing selection or inventing a compile workload. The current
Windows profiling owner #3661 and #2420's existing exact-cache measurements retain
their scopes. This change preserves the representative Rust commands and Cargo
cache ownership. No catalog network collection, live release controller, signing,
publication or installed/native acceptance is inferred from offline contracts.

### CI, release and catalog dispositions

The five required contexts remain unchanged. Existing declarative Actions and
setup/diagnostic composite actions already share provisioning and artifact
handling; the improvement here is in their common frontend/validation consumers,
not another YAML generator. Attempt-bound artifacts, exact-head readback,
permissions, cancellation and process/resource admission remain.

Release coordinator/source/publication and native-candidate paths were inspected
with their imported state, journal, recovery, control-reader, custody and
signature modules. Their numerous checks encode distinct independently verified
boundaries; replacing the coordinator with an actor snapshot would leave those
boundaries and add recovery migration. No equivalent duplicate safety decision
was established for deletion. Keep their current modules and platform adapters
rather than introducing an unmeasured parallel workflow. Existing active
installation/native-release work retains source ownership.

Catalog repository health collection similarly keeps its bounded bytes/deadline,
rate-limit history, identity accounting and retained-observation distinctions.
It differs from the per-port observer and live Roadmap inventory. A shared HTTP
client or generic cache would not remove that domain behavior. Reuse the existing
GitHub/observer modules where semantics already agree; do not collapse observation
into trusted admission or weaken historical/incomplete outcomes.

At the end of Phase 1 the useful remaining bottleneck was the measured seven-minute browser execution,
not the removed millisecond import overhead. Further changes should start from
case/phase observations under #2420, preserve all executed identities and platform
behavior, and target demonstrated repeated startup or test cost. This does not
create a new cleanup backlog or a beta prerequisite. Further release reshaping
requires a concrete equivalence/dependency benefit and a frozen adversarial
oracle; file length alone does not justify it.

### Independent review repairs

Separate non-writing reviews found two issues in the first candidate. The extracted
leaf now appears in both the Roadmap health workflow trigger and its substantial
change selector, with an isolated leaf-change regression. Large syntax selections
now reuse the existing native argument batching helper with distinct stage IDs;
a whole-implementation-inventory regression proves bounded, complete, unique
batches. The ten-file timing sample remains one batch. Reviews also checked the
unchanged function bodies, receipt/domain union, all-project selection and both
hosted browser prerequisite consumers. These reviews do not supply hosted or native
qualification.

## Phase 2: browser feedback and residual simplification

The refreshed baseline is `39038b76ff357f1d3a19271b395d240eb720f731` on
October 25–26, 2026. It contains 910 tracked root script files (848 direct,
357 tests), 166 desktop script files (160 direct, 55 tests), 382 root `release-`
files and 26 workflows. These are inventory observations, not deletion targets.
Current #2420 recommendations, #1104 ownership and active PR #3663 were read
before editing; this work avoids its product/native journey files. #1667's
bootstrap scope and completed #3662/#2004 remain unchanged.

### Browser lifecycle evidence and implemented scheduling

A temporary reporter used public Vitest lifecycle hooks and timed the installed
Playwright provider's browser/page/context/trace calls without changing their
arguments, results or failures. Its source/configuration SHA-256 identities are
`fe2228e8c788bd03933e9295142a88d29febab4fc837681702c5c22eceefc5e0` and
`225c84d7003af68f577ea14a27f7e3bd1fb245303a77ca86a0f82b61a2be9f40`.
The configuration changed only the measured worker count. Node 24.22.1,
Vite+ 1.3.0, Vitest 5.0.5 and Playwright 1.64.1 were pinned and unchanged.

The dominant two-worker cost was tracing, not repeated browser acquisition or
app authentication. Main-browser `stopChunk` ran 1,466 times, totaling 385.0
aggregate seconds (median 212 ms). Its per-call quarter means rose from 121 to
182, 265 and 482 ms over the run. The provider exports each test's trace before
deleting passing traces in retain-on-failure mode. These concurrent aggregate
durations overlap test timing and must not be added to wall-clock time.
Only two main browser contexts/pages were reused across 134 main-browser files;
provider/page startup was roughly four seconds, collection totaled 55.9 aggregate
seconds, and setup 4.35 aggregate seconds. There was no repeated authentication
or per-file browser launch to consolidate. Summed `prepareDuration` is cumulative
and overlapping, so it is not a valid separate wall-clock phase.

The implementation raises the existing bounded browser worker limit from two
to four; unit workers stay at two. It preserves isolation, all three browser
projects, native Playwright context handling, assertions, default trace
screenshots/snapshots/sources, failure screenshots, cancellation, reporting and
resource admission. No custom scheduler or diagnostic-loss optimization was
added. Four main contexts provide concurrency and distribute the long trace
history; this is improved scheduling, not a claim that fewer obligations run.

| Interleaved run | Workers | Outer wall | Admission queue | Vitest runtime |
| --------------- | ------: | ---------: | --------------: | -------------: |
| Baseline 1      |       2 |  448.162 s |         0.035 s |       424.26 s |
| Candidate 1     |       4 |  290.489 s |         0.006 s |       278.51 s |
| Baseline 2      |       2 |  551.817 s |        10.026 s |       529.62 s |
| Candidate 2     |       4 |  373.290 s |        25.039 s |       304.35 s |

Every run passed 1,476 cases with the same explicit skip across 136 files
(135 passed, one skipped); the complete project/file/runner-ID/name/outcome
multiset is equal. No retries, test removal or timeout changes produced the
result. Vitest runtime fell 34.4% and 42.5% in the two pairs; outer wall fell
35.2% and 32.4%, including queueing. First-pair project execution spans were
415.46→272.81 s main browser, 1.84→2.26 s locale and 1.58→2.21 s forced colors.
The tiny projects did not improve; the main lane dominates.

Each run launched a fresh browser with already installed tool/browser caches.
These are interleaved warm-install observations, not pristine cold provisioning
or exclusive-host benchmarks. Other workers shared the host; recorded load
varied and one foreign failed-cleanup capacity record was retained. Setup,
source fingerprinting and reporting outside Vitest also varied (particularly
Candidate 2). Initial-run prebundle/cache history was not normalized by deleting
shared resources. Hosted CI and Windows browser speed are separate evidence.

### Reliable failure feedback

[Vitest group ordering](https://main.vitest.dev/config/sequence) orders groups;
it is not a success dependency. Pinned 5.0.5 has no project success-dependency
configuration. Runtime controls also showed that [bail](https://main.vitest.dev/config/bail)
does not prevent the later browser group from executing after unit cancellation.
The native scheduler checks cancellation for Node work but enters a new browser
pool whose cancellation listener did not observe the earlier cancellation.

An isolated, reversible five-case fixture exercised real Chromium interaction,
locale, forced colors and controlled unit/browser failures. It used Vite+
`defineConfig` and inherited project configuration so pinned runtime resolution
was preserved, with the production two-worker unit/group policy. Absolute event
timestamps measured the first reported failure; outer timing included setup and
cleanup. A second valid round observed:

| Scenario        | Combined final | Combined bail final | Sequential final | First failure: combined / bail / sequential |
| --------------- | -------------: | ------------------: | ---------------: | ------------------------------------------- |
| Pass            |        5.603 s |             5.698 s |          7.997 s | None; all five cases passed                 |
| Unit failure    |        5.432 s |             5.558 s |          2.530 s | 2.811 / 2.912 / 2.457 s                     |
| Browser failure |        5.766 s |             6.543 s |          8.118 s | 5.629 / 6.398 / 7.988 s                     |

Combined and bail both executed all browser cases after the unit failure;
bail additionally cancelled the trailing unit case. Sequential ran both unit
cases and no browser cases after unit failure. Both successful and browser-failing
sequential executions covered all five cases. The first valid round showed the
same identities/outcomes; its sequential unit failure included unrelated admission
queueing and is not substituted for the second timing. These short fixtures
measure runner behavior and overhead, not a seven-minute full-suite failure run.

`frontend:tests` now uses Vite Task's ordered commands to invoke the existing
uncached `frontend:unit` then `frontend:browser` tasks. This deliberately accepts
roughly 2.4 seconds extra successful fixture startup for reliable early failure
completion. No new runner or command namespace is introduced. Full frontend
selection still has one task owner, while unit/browser/literal/related commands
retain their scopes. A bounded maintained behavioral test substitutes inert
leaf commands into the actual task definition and proves successful ordering,
unit-failure skipping and browser-failure propagation using the pinned Vite Task.
It replaces the lost failure-gate protection from Phase 1's timed-out fixture.

Invalid experiments remain excluded: early controls exhausted their outer budget
waiting for host capacity; one debug run lacked the owned browser-cache path;
a plain-config fixture lacked Vite+'s runtime resolver and duplicated/unresolved
Vitest; a diagnostic reporter mishandled serialized errors; one-worker default
group ordering exercised Vitest's special sequential group instead of production
ordering. Corrected controls do not turn those attempts into passing evidence.

### Vite+ cache decision: tested, not adopted

A reversible pure `vp fmt --check` task retained automatic reads, missing probes
and directory tracking, pinned Node/package/lock/workspace inputs, and
`output: []`. All environment was fingerprinted except the exact launcher
bookkeeping names `CODEX_TOOL_CALL_ID` and `SHLVL`; no broad environment exclusion
was introduced. The unqualified all-environment experiment first demonstrated
misses on every agent call and was corrected only for the experiment.

Controls detected modified/added/renamed/deleted inputs, previously absent imported
formatter settings, ignore-file creation/deletion, pin changes and consequential
environment changes. Invalid formatting was never cached; returning exactly to a
previous valid input could safely hit. Changing ignored output bytes retained
them on a cache hit; no filesystem output was restored. Unsupported standalone
`.oxfmtrc.json` controls were excluded and replaced with actual Vite+ configuration.

Real-root direct formatter observations were 1.606, 1.060 and 1.068 s. The real
package task took 3.162 s cold, then 0.305 and 0.310 s with cache hits. Desktop
package delegation also replayed, and a literal filename still selected one file.
However, **the established storage-owned Just entrypoint failed**: Vite Task's
Linux seccomp tracker could not create its socket under the repository temporary
path (`path must be shorter than SUN_LEN`). The uncached formatter works with
that same environment. Adding a path-override wrapper or another cache would
cost more compatibility/ownership complexity than the roughly one-second warm
saving justifies. The experimental task, package/Just rewrites and temporary
configuration are therefore absent from maintained source.

Formatting, lint and strict type checking stay fresh through existing Vite+
commands. Composite static checks remain uncached because compatibility checks,
resource coordination and other side effects are not formatter output. Cargo
and bundle caches keep their current owners. No cached result is promoted to
fresh CI/native evidence. Existing Vite Task scheduling supplies the failure
gate; the prior Moon/Nx/Turbo/CLI/XState/Octokit framework decisions still stand.

### Residual architecture changes and retained boundaries

- Removed the unused `parseNameStatus` export and its 26-line implementation.
  Production discovery already uses NUL-delimited raw Git records and the shared
  `parseRawDiff` authority; its only executable callers were obsolete parser tests; a dated advisory
  report also referenced the export. Modification/deletion/copy vectors moved to the existing
  raw-adapter regression, alongside rename paths/modes and malformed-input refusal.
  No live workflow, dynamic command or compatibility entrypoint was removed.
- Upstream-health scope selection now validates through the existing pure
  `estimateHealthRequests`/`prepareHealthCollection` path, retaining complete
  inventory validation and whole-catalog hashing. It no longer constructs empty
  observation reports or supplies an impossible fetch callback as a validator.
  The async exported interface, historical qualification checks and hashing
  rejection of BigInt/cyclic metadata remain. Pre-change characterization and
  the same post-change tests cover invalid unselected ports and both inventories
  even before a full fallback. Retaining hashing erased most microbenchmark
  savings; this is responsibility cleanup, not a material performance claim.
- Reinspection of `ordinary-validation`, Roadmap, catalog observation,
  `pr-delivery`, release coordinator and native candidate modules did not establish
  another equivalent authority worth removing safely. Release admission,
  journal/recovery, signature/custody and platform adapters retain different
  obligations. Splitting their clients or controllers by length would add seams
  without removing those obligations. No release rewrite or new state authority
  is justified by this work's evidence. Active product/native work remains separate.

```text
Just / package / Actions -> existing validation selection
frontend:runtime -> existing content stages -> frontend:tests -> existing build
frontend:tests -> Vite Task ordered commands -> fresh unit success -> fresh browser projects
Local Git discovery -> shared raw-diff parser -> existing validation policy
Health scope selection -> existing validated request planner + whole-catalog hash
Release / native / publication -> existing independent guarded domain owners
```

No product behavior, release credentials, signing authority, publication policy,
native acceptance or required CI context was changed. These measurements and
fixtures do not qualify installed/native/release behavior. #2420 remains the
canonical testing-audit ledger; this bounded #1104 delivery adds no beta gate or
parallel cleanup backlog.

### Qualification and delivery accounting

The actual native `frontend:tests` task passed at reviewed source
`e445f0dc1356bce79c1dd078c0c1f249e733a4c7`: 935 unit passes and one explicit
skip in 28.23 s, followed by 1,476 browser passes and one explicit skip in
271.41 s. This is 2,411 passes and two skips; the refreshed baseline contains
four more unit cases than the historical Phase 1 run. Complete browser identity
and outcome accounting matches the controlled experiments. Unit admission waited
110.176 s, browser admission 0.006 s; guarded phase totals were 144.481 and
279.880 s. The sum of runner execution was 299.64 s; this is separate from the
426.562-second outer command wall, including queueing. A later target composition is not claimed to
have those exact timings.

The five selected local tooling-contract files passed 193 cases, including the
new failure gate and pre/post-change health oracle. Full strict checking covered
1,345 files with zero warnings/lint/type errors (27.4 s checker, 111.115 s guarded
including 75.436 s queue). Native TypeScript syntax and generated Node suite
inventories passed. Independent non-writing architecture and framework reviews
found no blocking code findings; their two documentation corrections were
applied. This is source/fixture evidence, not native release qualification.

Main advanced during qualification with PR #3663, target
`9b3a92d33fa0e42026598fb4ef80767a80c46798`. It was integrated before final hosted
qualification. Independent target-interaction review found no overlapping edits
or new worker/API boundary; its portrait test refactor preserves declarations
and artifacts. Evidence for final composed-source CI, merge identity and readback
belongs with the bounded [#1104 delivery outcome](https://github.com/boburning/portcove/issues/1104).
The issue remains open for its broader acceptance; #3662 is not reopened and no
new backlog or beta prerequisite was created.

Phase 2 modifies nine existing files: production TypeScript −28 lines, tests +100,
configuration net zero, documentation +245; net +317 maintained lines. No whole
files or dependencies were added or removed; no new domain module or compatibility
wrapper was introduced. The smaller production surface and faster feedback are
separate from the expanded historical evidence record.
