# Automation architecture modernization

Phase 1 owner: completed [#3662](https://github.com/boburning/portcove/issues/3662).
Phase 2 performance owner: the existing development-agility [#1104](https://github.com/boburning/portcove/issues/1104).
Finite Roadmap policy owner: [#3700](https://github.com/boburning/portcove/issues/3700).
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

## Phase 2 continuation: browser work and early failure feedback

### Prior delivery readback

[PR #3668](https://github.com/boburning/portcove/pull/3668) merged as
`ea62405bf8d08f21055ff7381d90a6882379efee`, from reviewed source
`79bbb6382f00f8ee918ca94f937a0fbaf9edb164`. [Required CI run
40266447605, attempt 1](https://github.com/boburning/portcove/actions/runs/40266447605)
passed `catalog`, `dependency-review`, `frontend`, `rust`, and `rust-quality`
for that source. Hosted frontend produced 2,411 passes and two explicit skips:
unit 29.13 s, browser 347.97 s. Its producer job took 433 s and the observed
required-job critical path was 496 s. These hosted observations are separate
from the earlier local measurements and do not establish native acceptance.

### Native browser lifecycle experiments

The continuation profiled native Vitest 5.0.5 / Playwright 1.64.1 lifecycle
phases through public reporter/provider APIs, retaining the original installed
bytes, source identity, configuration, case outcomes and rejected experiments.
The costly passing-test trace-export path offered promising prototype timings,
but both attempted reductions failed important diagnostic guarantees:

- Deferring passing exports reduced one 1,477-case run from 225.24 to 127.07 s.
  A real SIGTERM at the deferred boundary lost the trace ZIP; the original
  export timing retained a valid ZIP. The entire patch and dependency changes
  were removed. Provider-close success alone was insufficient qualification.
- Resetting trace sessions per file passed 1,477 cases in 162.65 s and retained
  a SIGTERM trace, but the second file lost a cached font resource that the
  original trace retained. This patch was also removed. A separate attempted
  CSS-body check failed under both implementations and was not used as proof.
- Eight-worker execution was not qualified. With fixed file seed 1104, four
  workers passed the 1,477-case browser inventory in 290.31 s; eight workers
  finished in 242.13 s with three visual/interaction failures. Its summed
  process-tree RSS peak was 6,206 MiB versus 4,845 MiB for four workers; these
  RSS sums include shared pages. Load ranges differed (3.94–13.80 versus
  2.05–7.98), so neither successful speedup nor capacity safety is inferred.
  Four workers remain authoritative. No assertions, deadlines or retries changed.

Native experimental `browser.traceView` uses a different replay/artifact model
and does not preserve the required original image/resource bytes equivalently.
It was not substituted for Playwright trace diagnostics. The original browser
provider/client, dependency graph, failure exports and interruption behavior
remain in use; no experimental patch, scheduler or cache survives.

### Implemented ownership changes

Fifty SSR/text-policy cases now execute freshly in the existing Node unit
project. Source-import presentation has one unit file; its three real DOM Apply
cases join the existing source-discovery browser file, retiring that browser
entrypoint. Failure-presentation SSR cases join the existing App unit file;
update-center SSR cases have a unit file beside the hook/domain owner. Remaining
DOM, clipboard, accessibility, focus, hooks and state-transition cases stay in
Chromium. Shared immutable fixture facts use fresh factories in the existing
rendered-test fixture module; the existing identical install-record helper
replaces its duplicate.

The move exposed a real harness bug: a `beforeEach` expression returned
`mockReset()`'s mock function, which Vitest treated as teardown and invoked as a
native picker. A block body preserves reset behavior without registering that
unintended teardown. The failed run is retained; no picker failure was suppressed.
Independent non-writing implementation review at `6ee8581537f578affdb09cf3a037eaff583414ca`
compared complete moved bodies, parameter vectors, fixture values, remaining DOM
bodies and existing destination cases against `1ea12818bf18e5a9cb79da1d48642305bb5a32cb`.
It found no blocking change.

### Comparable affected-file observations

| Observation                                           |    Before |          After |
| ----------------------------------------------------- | --------: | -------------: |
| Fresh expanded case names/outcomes                    | 86 passes | Same 86 passes |
| Node / browser case placement                         |    7 / 79 |        57 / 29 |
| Native browser trace exports                          |        79 |             29 |
| Successful native execution                           |    8.64 s |         8.90 s |
| Successful guarded outer wall                         |  11.942 s |       12.602 s |
| Same controlled markup failure: first reporter result |   6.418 s |        0.586 s |
| Same controlled failure: final guarded outer wall     |   9.388 s |        3.571 s |

The successful runs show no overall wall-time improvement. The controlled
failure uses an ignored, reversible module-alias fixture returning invalid
markup; both lanes fail the same actual assertion expecting the game name.
Only that case is selected in the negative control; filtered cases are explicit
skips. These are focused observations, not full-suite time-to-failure claims.
All 86 positive-run names and outcomes reconcile, including existing destination
cases. The full unit-first/browser-second production task remains unchanged.

### Vite+ and command admission

The pinned Vite version’s experimental shallow dependency includes pre-bundle actual Base UI, Tauri and
frontend runtime imports. A cold wider-worker experiment exposed optimizer
reloads that split active Vitest module identity; the includes avoid those
reloads without disabling discovery or changing isolation. Recursive package
wildcards were rejected because internal optional adapters require dependencies
Portcove does not use. This uses Vite's optimizer, not a second dependency registry.

Exact standalone `test`, `check`, and `lint` help flags now delegate directly to
the pinned CLI without heavyweight admission. Option operands, literal filenames
and mixed commands retain their existing admission. The resource coordinator
loads only for guarded execution. Native help controls passed and wrapper help
completed while another browser lease was held. Seven fresh-process import
samples observed median module initialization 76.776 to 52.005 ms and process
wall 105.024 to 78.704 ms; this is startup evidence, not a full-suite gain.
No task-result cache, new dependency or competing runner was introduced. The
previous deterministic-cache rejection and native/release boundaries still apply.

### Continuation qualification

At source `6ee8581537f578affdb09cf3a037eaff583414ca`, the actual production
`frontend:tests` task passed 985 unit cases plus one explicit skip in 31.63 s,
then 1,426 browser cases plus one explicit skip in 346.01 s. The complete total
remains 2,411 passes and two skips. Guarded phases took 34.354 and 349.652 s,
each with 6 ms admission queueing. Runner execution totals 377.64 s; it is
not a comparable whole-suite speedup against earlier contended measurements.
All 28 selected orchestration contracts passed. Strict native Vite+ checking
covered 1,351 files with zero warnings, lint errors or type errors (11.5 s
checker, 13.965 s guarded). These source/fixture results do not qualify native,
installed-app, signing, publication or release acceptance.

[#1104](https://github.com/boburning/portcove/issues/1104) retains the broader
feedback owner; #2420 retains canonical testing recommendations. The separate
finite [#3700](https://github.com/boburning/portcove/issues/3700) owns removal of
the demonstrated Roadmap CLI/scoped-policy runtime import cycle. It creates no
beta prerequisite and does not expand #1667 or reopen #3662.

### Frontend continuation delivery readback

[PR #3701](https://github.com/boburning/portcove/pull/3701) merged as
`73bcaba170721984e7a30906a55102ec2f5efbc5`, from reviewed source
`cd9f8a03530e8ed913b5fe26c8620a56e30501c9`. [CI 40346229424, attempt 1](https://github.com/boburning/portcove/actions/runs/40346229424)
passed all five required contexts. Its actual frontend producer passed 993 unit
cases plus one skip in 26.89 s and 1,426 browser cases plus one skip in 286.73 s;
producer wall was 363 s. The eight additional unit cases relative to the local
6ee85815 run are main's adapter-conformance envelope controls. Their identities
were reconciled with no missing local unit names. These observations do not
isolate a successful whole-suite speedup from the SSR move.

Independent target-interaction review cleared the later target `1e20ac70` against
source cd9f8a03 and actual merge-base `a19868db`. Guarded merge and REST/Git readback
confirmed its parent and composed tree `380218daaad8695ce53e8b284c465f580d4c427f`.
The later target itself is not claimed as the tested source. [#1104 outcome](https://github.com/boburning/portcove/issues/1104#issuecomment-6420542861)
and [#2420 evidence](https://github.com/boburning/portcove/issues/2420#issuecomment-6420543813)
were read back; both scoped doctors passed, with global health not evaluated.

This slice changed 11 files: production/configuration +14 lines, tests/helpers
+27, documentation +123, net +164. One browser entrypoint was retired and two
Node files added, one through a rename; net file count +1, dependencies unchanged.
Case names, assertions and vectors survive; file/project-derived definition IDs
intentionally change when cases move. The required unit-first gate still prevents
browser execution after a unit-stage failure.

## Roadmap policy ownership and cycle removal

The runtime cycle `roadmap.mts → roadmap-scoped.mts → roadmap.mts` coupled scoped
policy evaluation to the CLI, its live client, locks and unrelated reporting/tool
modules. The finite elective [#3700](https://github.com/boburning/portcove/issues/3700)
separates existing responsibility groups without adding planning or execution
infrastructure:

```text
roadmap.mts                  CLI, live client/inventory, locks and mutations
roadmap-scoped.mts           observed-scope evaluation and doctor execution
roadmap-issue.mts            issue identity, field precedence, status and blockers
roadmap-execution.mts        snapshots, consumption, context and queue projections
roadmap-qualification.mts    diagnostic projection, matching, stages and coverage
roadmap-readiness.mts        dependencies, readiness and snapshot reporting
runtime-values.mts           shared record-only field access
```

Scoped evaluation imports the owning policies directly. Existing CLI exports
remain compatibility bindings for real consumers: all 53 runtime names match the
pre-change API, and seven moved bindings are checked for function identity.
Retirement requires migrating those actual consumers; the Just/Actions CLI
entrypoint remains necessary. Tests for execution, qualification and readiness
now import their domain owner. Live GitHub collection, pagination/completeness,
mutation preimages, quota/deadline decisions, locks and recovery retain their
existing implementations. No second inventory or state authority was added.

Issue completion/status interpretation has one owner. Snapshot inconsistency
reporting now reuses the same predicate as readiness/scoped checks, removing an
equivalent inline decision. The duplicate diagnostic string conversion delegates
to the existing issue helper; record field access moves to the existing shared
runtime module. Other guards remain independent where their obligations differ.

Pre-change observations are bound to unchanged Roadmap bytes at source cd9f8a03,
including hashes of the CLI, scoped and issue modules, #706 implementation and
approval, and configuration. Independent review repaired two oracle gaps before
extraction: a real legacy migration case and canonical #49/#706 pending planning
behavior. All 51 frozen outputs match after extraction, including exact snapshot
JSON/revision hashes, malformed consumption, field precedence, status conflicts,
qualification identity and readiness defaults. Complete snapshot markdown also
matches the frozen original for six repository-state/Project-status combinations.

At composed source `9ca500a6d5a9fd0ec1fe721b7eac91e8fd868938`, the authoritative
24-file Roadmap Node suite passed 431 cases with one explicit Windows-sharing
skip on Linux; its reporter confirmed complete file/outcome coverage and no
native failure. The selected domain/validation regressions passed 217 cases.
A fresh-process loader control refused the old CLI import and passes for the new
scoped graph: 24 repository modules become 18, with nine old modules unloaded
and three cohesive policy modules added. This demonstrates coupling removal,
not a measured improvement to whole-command wall time. The CLI itself remains
an active client/entrypoint and still loads its necessary responsibilities.

New policy leaves and shared field access participate in existing workflow
triggers, health source comparisons, protected ownership and local/hosted test
selection. Lifecycle regressions cover edits, additions, deletions and both
rename sides. The shared runtime helper also retains the complete Roadmap test
family. Generated Node command lists remain products of their existing registry,
not independent policies; current main's #3703 registry work is reused.

Readiness is not wholly pure or API-free: its default approval is read freshly
from the owning checkout on invocation, its default observation time remains
fresh, and the existing #706 module still depends on GitHub infrastructure.
Actual candidate scanning and mutation authority stay with their existing
callers. No approval, signing, publication, native qualification or release
eligibility is inferred from these source/fixture results. The earlier framework
and cache decisions remain unchanged.

The implementation adds three substantial domain modules and retires no required
CLI. Before this evidence update, the 17-file implementation is production +140,
tests +105, workflow configuration +4, net +249 lines. The CLI shrinks from 5,828
to 4,232 lines; this is relocation plus explicit boundaries and tests, not a claim
of net source deletion. No dependencies or compatibility forwarding modules were
added. #3700 owns its finite review, qualification and delivery evidence; #1667's
bootstrap scope, completed #3662 and beta commitments remain unchanged.

Final local strict checking of the composed implementation covered 1,357 files
with zero warnings, lint errors or type errors (8.6 s checker, 11.964 s guarded,
5 ms queue). All 3,268 maintained files passed formatting. These observations
retain their source/fixture boundary and do not replace exact-head hosted CI.

## Final Phase 2 guarded delivery receipts

| Delivered slice                                                                                                   | Reviewed source                            | Merge                                      | Required exact-head CI, attempt 1                                             |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------- |
| [#3668](https://github.com/boburning/portcove/pull/3668): browser scheduling, failure gate, parser/health cleanup | `79bbb6382f00f8ee918ca94f937a0fbaf9edb164` | `ea62405bf8d08f21055ff7381d90a6882379efee` | [40266447605](https://github.com/boburning/portcove/actions/runs/40266447605) |
| [#3701](https://github.com/boburning/portcove/pull/3701): SSR ownership, pre-bundling and native help             | `cd9f8a03530e8ed913b5fe26c8620a56e30501c9` | `73bcaba170721984e7a30906a55102ec2f5efbc5` | [40346229424](https://github.com/boburning/portcove/actions/runs/40346229424) |
| [#3707](https://github.com/boburning/portcove/pull/3707): Roadmap policy ownership/cycle removal                  | `c9c295d0d5ef406ad380e510d94d7ed4529481ba` | `0eaf374e141f273b9d799849bbd81751a8e82b54` | [40361414648](https://github.com/boburning/portcove/actions/runs/40361414648) |

All five contexts (`catalog`, `dependency-review`, `frontend`, `rust`,
`rust-quality`) passed for each listed source. #3707's tooling-only selection
skipped frontend runtime producers; its successful `frontend` context is not a
new browser execution claim. #3701 retains the relevant hosted frontend evidence.
The supplementary upstream-health workflow returned success without establishing
global catalog, installed/native or production-release acceptance.

Two independent non-writing reviews cleared #3707's architecture/selection and
correctness/oracle behavior, including 46 extracted function bodies, unchanged
live client/mutation bodies, fresh approval/time defaults and compatibility.
Its source/target interaction review covered `abc8c03b` and then `9f44c30e`.
The first guarded merge stopped before mutation while mergeability was unknown;
readback confirmed open/unmerged, then the resolved state permitted normal merge.

A concurrent #3708 advance became the actual parent `a8b941efd22e8d35e00d1227d218af94e256327f`.
The prediction against the earlier reviewed target consequently failed; that
failure is retained. Readback confirmed the merge, and composing the actual parent
with the reviewed source exactly reproduced tree `3df7555a0e68c4d5e5c2f04ce94e8a803326ad7d`.
Independent post-merge interaction review verified both sets of routing edits
survive and the new standalone-Rust receipt contract does not alter Roadmap
snapshot or approval authority. Six focused interaction files on the actual
merged composition passed 241 cases with three explicit skips. This is separate
from earlier exact-source CI; the later parent is not retroactively called tested
by that CI. No merge retry occurred after successful confirmation.

Across these three implementation PRs, maintained non-test TypeScript is +126
lines, tests/helpers +232, workflow configuration +4 and evidence documentation
+474 (net +836 before this final receipt update). Most relocation remains
original behavior; imports/exports and meaningful regression coverage explain
the increase. There are three new domain modules and net one additional frontend
test file, with no dependency change or competing orchestration system. A browser
entrypoint, an unused parser and duplicated policy/fixture behavior were retired;
no arbitrary root-script deletion target was applied.

The final tracked inventory at merged source 0eaf374e is recorded below. Counts
include modules, tests, fixtures and generated data; they are not evidence of
obsolete code or acceptance quotas.

- `scripts/`: 924 tracked files (858 direct).
- `apps/desktop/scripts/`: 168 tracked files (162 direct).
- `tools/`: 2 tracked files (0 direct).

Release-prefixed root files remain 382. The catalog observer, ordinary validation,
PR delivery, release coordinator and native-candidate boundaries retain their
existing authorities where current evidence did not establish an equivalent
removable implementation. The later Roadmap cycle/status-policy findings above
supersede the earlier Roadmap no-change disposition at that bounded scope.
No signing/publication controller, durable journal, trusted admission check or
platform adapter was collapsed merely to reduce file counts.

The remaining high-impact browser cost is trace/resource handling. Revisit it
only with a supported solution that passes the retained SIGTERM and cached-resource
negative controls. Static-task caching remains unqualified under the maintained
Just temporary environment; a supported native task/socket fix must precede a
new full invalidation experiment. Existing Windows Rust profiling stays with
#3661. These are bounded resume conditions, not a new cleanup campaign or beta gate.
#1104 and #2420 retain their broader scopes; #1667 and completed #3662 are unchanged.

## Final consolidation pass, October 26, 2026

This pass starts at refreshed main `089aafd213dbe7f04db43df768d85d5a804504e0`.
[#1104](https://github.com/boburning/portcove/issues/1104) owns the bounded
feedback/ownership delivery; [#2420](https://github.com/boburning/portcove/issues/2420)
continues to own the testing audit. Neither broader issue is completed by this
pass. The existing completed owners and frozen #1667 scope are unchanged.

### Completion matrix

| Workstream                               | Outcome                                                                   | Evidence and stopping condition                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser trace/context/resource lifecycle | Retained after evidence-based evaluation                                  | Installed Vite+ 1.3.0, Vitest 5.0.5 and Playwright 1.64.1 retain the existing per-case chunk export. The installed provider still calls `tracing.stopChunk({ path })`; supported [trace options](https://vitest.dev/config/browser/trace) do not establish a replacement satisfying the prior SIGTERM and cached-font controls. Preserve four workers, isolation and all diagnostics. Revisit only a concrete upstream-supported replacement passing both controls. |
| Remaining browser-only cost              | Implemented                                                               | Five expanded recovery-review SSR cases join the existing feature-owned Node file. Real disclosure, refresh, cleanup and interaction cases stay in Chromium. Complete selected name/outcome reconciliation and a controlled wrong-label failure survive.                                                                                                                                                                                                            |
| Script decision duplication              | Implemented                                                               | One strict changed-path admission in existing `repository-path.mts` replaces identical implementations in CI raw-Git parsing and the validation planner; every caller keeps the same error/return behavior. Permissive local spelling normalization stays separate.                                                                                                                                                                                                 |
| Workflow test machinery                  | Implemented                                                               | One parsed immutable CI document replaces repeated full parses. Existing `workflowJobSource` replaces 19 independently spelled job-selection slices across integration/frontend/native/Rust contracts. Fresh projections, aliases, malformed/duplicate YAML and exact owner boundaries retain controls. No new runner or cache is introduced.                                                                                                                       |
| Nested task-gate execution               | Implemented                                                               | The existing real Vite control now declares an isolated workspace and always runs beneath an adversarial parent. This prevents storage-owned temp paths from launching the real frontend suite; missing-marker counterexample fails.                                                                                                                                                                                                                                |
| Workflow megasuite ownership             | Already satisfied by existing work, with bounded consolidation above      | Five existing integration/frontend/Rust/native/release files already separate responsibilities. Their assertions and registry/CI/Just routes remain. This does not complete all Audit 28 recommendations.                                                                                                                                                                                                                                                           |
| Source-sliced native/release tests       | Retained after evidence-based evaluation                                  | Real browser-script serialization, fixed controller wiring, process cleanup and custody tests exercise different boundaries. No equivalent importable replacement was demonstrated in this bounded pass. Audits 31/32 retain their acceptance.                                                                                                                                                                                                                      |
| Ordinary/local/hosted validation         | Retained after evidence-based evaluation                                  | `validation-plan` owns coarse impact, protected/audit inputs and conservative fallback; `ordinary-validation` adds exact executable/test obligations; `local-validation` owns discovery/preflight and receipts; `ci-baseline` consumes these for hosted execution. Their similar lists and launch lines do not establish equivalent authorities. Receipt execution additionally invalidates stale receipts and rehashes source before success.                      |
| Catalog health and release controllers   | Retained after evidence-based evaluation                                  | Health inventory, request accounting and retained history differ from admission. PR delivery already uses the shared GitHub client; remaining checks bind exact PR/check/job identities. Native/coordinator launch closures have different command allowlists, controller identities and original/continuation deadlines. No demonstrated equivalent protection is collapsed.                                                                                       |
| Roadmap compatibility exports            | Retained after evidence-based evaluation                                  | Actual authoring, provenance, discovery and test consumers still use CLI exports. The earlier runtime cycle remains removed; retiring public bindings merely to change counts would discard compatibility.                                                                                                                                                                                                                                                          |
| Rust/CI feedback and reservations        | Retained after evidence-based evaluation                                  | Reuse #3661 and existing one-build/disjoint eight-worker archives. The inspected newer Windows run has a failed execution partition, so it is unsuitable for a safe rebalance claim; Audits 17/24 retain stable-baseline, repeated timing and causal contention prerequisites. No new build, reservation, capacity or orchestrator.                                                                                                                                 |
| Static caching / final framework choice  | Retained after evidence-based evaluation                                  | The installed native cache tracker still fails at a supported long storage-temp path with `path must be shorter than SUN_LEN`, while the same uncached command succeeds. A shorter-path probe runs but refuses reuse because it read/wrote its own IPC socket. Keep static checks uncached; require a native fix and complete invalidation/Just evidence before reconsideration. Earlier framework decisions stand.                                                 |
| Reporting, skip routes and coverage      | Already satisfied at existing bounded scopes; broader acceptance retained | Existing actual Node/frontend observations and selected/executed reconciliation are reused, with explicit skips. This pass adds no second inventory and does not claim Audits 12/58/59/63 complete.                                                                                                                                                                                                                                                                 |

### Architecture before and after

```text
Before                                    After
CI raw paths -> strict validator A         CI raw paths ---+
Plan paths   -> strict validator B         Plan paths ------+-> repository-path.validateChangedPath
Workflow fixtures -> repeated YAML parse  Workflow fixtures -> one immutable parsed document
Job tests -> independent string slices    Job tests -> existing AST-bounded job selector
Recovery markup -> per-case browser trace Recovery markup -> existing fresh Node project
Recovery interactions -> Chromium         Recovery interactions -> Chromium
```

The retired machinery is the duplicate strict path implementation, 19 bespoke
job-selection expressions and repeated full-document parse/conversion work.
No implementation was relocated into a new module. The shared path authority
retains protected-policy impact and the complete existing selection/receipt
regressions. Missing, changed, deleted, mixed/shared/unknown and both rename sides
continue through the existing conservative selector tests.

One immutable workflow source owns both source ranges and parsed values. Every
job value is cloned before exposing it to a test, so mutation in one test cannot
alter another's oracle. Independent review caught nested/whole-job YAML alias
regressions in the first node-projection implementation; the repair retains
whole-document alias resolution and adds both compatibility controls. Original
review findings are credited; passing current main alone would not detect them.

### Net simplification

The refreshed baseline has 930 tracked root `scripts/` files, 168 Desktop script
files and 387 root release-prefixed files. Counts include tests and fixtures and
are not independent responsibilities. This pass removes/adds **zero maintained
implementation files**, dependencies, workflows, package commands or frameworks.
It consolidates two strict path implementations into one existing module and
retires repeated YAML/job-selection machinery. No compatibility CLI is retired
and no additional dependency cycle is claimed removed. The earlier Roadmap cycle
removal remains credited separately.

Five tests move between two existing files with unchanged expanded names,
assertions and fixture values. File/project-derived IDs intentionally change;
case names/outcomes reconcile exactly. The only added file is the dated
[structured evidence](../qualification/automation-final-2026-10-26.json), separate
from maintained automation. Detailed production/test/documentation line deltas
and final remote delivery identities belong to the bounded PR receipt; a smaller
file or changed task graph is not treated as runtime evidence.

### Performance and validation

The structured packet records five fresh-process workflow-fixture imports before
and after, the complete four-file frontend case union, and the controlled failure
with original observation limits. Initial import medians were 1,470.018 ms before
and 133.109 ms after; these initial post-change samples precede the reviewed alias
repair. Final repaired samples have a 138.825 ms median and are separately recorded in the packet. Sequential
before/after sampling is not an interleaved host-contention experiment. The same
five workflow suites observed 10.435 s before and 9.080 s initially after, including
one existing platform skip and one new projection-isolation control. A single
pair does not establish hosted CI improvement.

Four selected frontend files retain **59 passes, zero skips**. Runner duration
was 6.05 s before versus 4.98 s after; guarded duration was 7.781 versus 6.641 s,
with 6/7 ms queueing. This warmed single pair does not isolate successful full-suite
savings. Moving five pure SSR cases retires five browser trace exports, not five
assertions or a browser-specific obligation.

A reversible wrong unknown-recovery-label mutation fails the same three expanded
neutral-label assertions in both placements. First failed case observation was
4.677 s before versus 2.318 s after; guarded outer wall was 5.378 versus 4.309 s.
Both commands exit 1 and all modified source/test bytes are restored exactly.
These failures are intentional counterexamples, not suppressed test failures or
universal time-to-failure guarantees. Original failure diagnostics remain retained.

The current hosted inspection uses [CI 40375581507 attempt 1](https://github.com/boburning/portcove/actions/runs/40375581507),
source `c7a89e8eb9588b4808d3c409587cd6b1e87b21d1`: workspace compile/archive step
178 s, independent transport job 221 s; successful Windows execution steps include
168 s and 312 s, while partition 3 failed after 332 s. These are distinct step/job
observations from another source, not a current-main baseline or a comparable
speedup. The failed run stays failed. The existing #3661 cold/warm experiment,
cache ownership, required contexts and #2420's baseline prerequisites stand.

The full assignment stops at these concrete implementations and retained
boundaries. Further browser trace changes need an upstream-supported solution
passing both historical negative controls; Rust rebalance/reservation changes
need a stable passing baseline and comparable causal evidence. Broad audit,
installed/native, release, signing and publication acceptance remain separate.

The first complete local plan correctly refused a syntax receipt when the evidence
sidecar changed during execution. That source-stability failure remains retained;
finish evidence edits before the frozen rerun. It is not a product or test-assertion
failure, and the refused receipt supplies no validation credit.

The frozen complete selected run retained 352 passes, one existing platform skip
and one real task-gate fixture timeout at 15.021 s. A finite 30 s child experiment
also timed out at 30.021 s; increasing budgets did not repair the cause and all
experimental budget changes were removed. Storage-owned `TMPDIR` put the fixture
inside the repository. Vite discovered the parent workspace and executed actual
Portcove unit/browser tasks instead of the injected tiny fixture tasks. The owned
leaked browser root was cancelled after exact PID/start/cwd/command verification;
its wrapper, supervisor, reaper and browser descendants disappeared.

The fixture now declares its own empty workspace. Its existing three real Vite
scenarios always nest inside a disposable adversarial parent workspace, preventing
a benign external temp directory from hiding this regression. All stage/order/exit
assertions and the original 15 s child deadline remain. The actual storage-wrapped
control passes in 1.621 s; the adversarial-parent variant passes in 1.968 s.
Removing only the child workspace marker makes the existing assertion fail quickly
against the inert parent's exit-97 task, without launching product tests. The
counterexample restores the test bytes exactly. This is a demonstrated isolation
repair and avoided accidental full execution, not a new test scheduler or a
whole-suite performance claim.

The final frozen complete local plan passes in 41.4 s: 17 selected Node files
reconcile to 353 passes and one existing platform skip, followed by content checks,
production build and both affected frontend files (nine passes, zero skips).
Strict checks cover 1,360 files with no warnings/lint/type errors. Independent
non-writing review cleared the final isolation repair, aliases, path policy,
assertion/identity preservation and report. These local results do not replace
exact-head hosted checks or guarded merge/readback.

## Feature ownership and impact completion pass — October 26, 2026

This pass implements the remaining demonstrated ownership defects under
[#1104](https://github.com/boburning/portcove/issues/1104). It consumes the delivered
foundations above and [#2420](https://github.com/boburning/portcove/issues/2420),
which retains its independent testing-audit acceptance and scheduling.

### Ownership and consumer repair

The ordinary input-to-test map contained repeated keys. JavaScript Map construction
silently replaced earlier consumers, including Linux isolated-plan/session,
public-plan, HTTP/init and account-session contracts, and the release recovery
worker's behavioral suite. Unique registrations now fail visibly on a duplicate.
Equivalent repeated declarations are removed; shared native custody obligations
supplement each helper's feature tests rather than replacing them.

The existing `nativeHelperFiles` dependency closure carries each root's lifecycle
consumers to its declared inputs. Shared isolated/account runtimes retain the
existing complete release-contract fallback and Linux/Windows public-update Node
contracts. Registry edits select the union. This fixes omissions; it does not
claim faster native validation or new native observations. No planner, dependency
registry, execution profile, package pin or required context is added.

Independent review compared before/after selections for all 4,114 tracked paths:
13 selections changed, and no prior Node-test consumer was lost. Positive and
negative local/hosted controls cover direct and shared consumers, additions,
deletions, both rename directions, mixed edits and unrelated frontend/prose.
Existing unsafe/incomplete discovery refusal, unknown fallback, Rust inventory
union checks and mandatory aggregate contracts remain. A copied real module
closure imports successfully; adding a repeated input makes import fail with
`Duplicate Node test input owner` before selection can succeed.

### Feature-owned frontend cases and measured limits

Four expanded readiness markup cases move into `launch-readiness.test.tsx`;
four pure readiness-model cases join `view-model.test.ts`. The installed-status
builder moves into the existing shared fixture module, and the existing action
fixture replaces another identical mock list. All DOM, lifecycle, keyboard,
accessibility, navigation and native-selector cases remain in Chromium.

The affected union preserves all **50 expanded names and outcomes**, with no
skips: Node 20→28, Chromium 30→22. Inputs, parameter vectors and assertions remain;
only intended file/project ownership changes. A controlled replacement of both
DetailPanel `Ready to play` titles fails the same `confirmed=true` assertion
before and after; the production bytes are restored exactly.

Linux x64, Node24.22.1, Vite+1.3.0, Vitest5.0.5 and Chromium156.0.8078.4 were used.
These are warm/dependency-provisioned, single-pair local observations:

| Observation                                           |   Before |   After |
| ----------------------------------------------------- | -------: | ------: |
| Successful affected-file runner                       |    5.59s |   4.70s |
| Successful guarded command, including setup/admission |   7.793s |  6.683s |
| Controlled failing case execution                     | 230.10ms | 27.07ms |
| Controlled failure guarded completion                 |   6.296s |  5.908s |

The successful commands queued10/6ms; failing commands queued6/6ms. Outer results
include supervisor setup, runner import/discovery, transforms, execution, reporting
and cleanup. Those phases were not independently timed in these samples; time to
first visible actionable failure was not captured. There is no cold-cache,
whole-suite, hosted or universal feedback-time improvement claim. The source
baseline is `509876a05e786ab154268e5028ac1423a8e05390`; original and changed input
bytes, observations and controls remain in the delivering checkout's ignored
`work/1104-evidence/` directory.

Representative current plan observations retain frontend static/content/build
and related tests; focused source-inspection Rust families and their conversion
consumers; broad Core coverage for shared conversion/persistence implementations;
catalog checks and real-catalog consumers; artwork consumer checks; cheap prose
contracts; and broad mixed/shared/unknown fallback. Required Windows workspace
compilation, other explicit platform qualification, complete embedded Rust test
families, receipt fingerprints and five exact-head contexts are unchanged.
Prior #2420 warm Rust measurements remain8m59s/9m24s with their original provenance,
not new cold/runtime evidence from this pass.

### Conditional use and retained failures

The recent real private-import edit (#2391) also changed shared Core/CLI/transport
inputs, so it correctly retains broad Rust coverage; it cannot prove isolated
private-family speedup. Recent native changes such as #3663 retain their original
review, exact-head CI and explicitly limited native evidence. The last release
handbook edit (#2497) also changed protected release implementation/workflows;
it cannot establish compatible handbook-only Rust/UI receipt reuse. The last
media change (#1365) includes prose and a PNG and retains its documentation
consumer boundary. These histories are not manufactured new executions.

The real candidate's first named-ref preflight correctly refused its dirty source.
Frozen preflight then refused the candidate's change to trusted local-check
selection authority: fixed transport cannot qualify itself. Both controls retain
source/base/controller/ref identities; neither is an eligible dispatch or a claim
of hosted execution. Future #1309/#1324/#1362/#1380/#1351
use still requires the relevant real change, exact inputs, compatible claims and
actual execution when required. Reuse never supplies fresh CI or native/release
acceptance.

The historical Windows initialization, Intel interrupted import, backup replay,
release-output EPERM, catalog timing and PowerShell/browser incidents retain
[#1104's exact original evidence and resume conditions](https://github.com/boburning/portcove/issues/1104).
No later passing run is a causal repair. Audit57 visual comparison stays under
#2420: require a demonstrated repeated visual-only escape before adding a small
pinned baseline; existing semantic/geometry/focus/contrast/layout coverage remains.

This pass also retains two new local observations. A supervisor registration
failed before Vitest launch; the retained registration and quiescent cleanup
receipt exist. A small instrumented `/tmp` probe subsequently registered in about
31ms, without identifying the original cause. A storage-root probe was cancelled
while waiting for another owner's Rust capacity; no payload started. Resume with
exact storage-root spawn/publication/read timing on another qualifying failure,
including process identity and cleanup, rather than treating the `/tmp` pass as
repair or increasing a deadline without evidence.

The broader selected frontend run completed **1,720 cases:1,704 passes and16
timeout failures** in499.152s (guarded frontend command,7ms admission queue).
Strict checks,209 selected Node contracts, content policy and the production
build passed before it. Preserve all failed cases, traces and screenshots. During
failure the observed memory full-stall avg60 was17.67% and I/O full-stall avg60
11.92%; traces show ordinary clicks and frame attachment taking seconds. This is
association, not causal attribution or a product repair. One unchanged affected-
file discriminator passes all61cases in the nine failed files in56.862s
(guarded command56.491s, including10.030s admission queue). It neither repairs
nor explains the original16timeouts. Fresh hosted CI remains required.
Do not repeat the full local suite merely to obtain green. Resume a timing repair
only with a discriminating reproduction that isolates setup/actionability,
screenshot/export, host pressure or an actual product assertion. No reservation,
worker count, timeout, retry, assertion or diagnostic-retention policy changes.

A/B/C's demonstrated source gaps are addressed by this implementation. D remains
evidence-bounded: preserve the original failures and conditional obligations;
#1104 closure requires its owning acceptance decision after delivery, and #2420
remains open at its independent scope. This report establishes no installed,
gameplay, signing, publication, release or global-health acceptance.
