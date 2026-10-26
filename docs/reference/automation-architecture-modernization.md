# Automation architecture modernization

Implementation owner: [#3662](https://github.com/boburning/portcove/issues/3662).
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

## Execution and measured results

Measurements and delivery evidence are added as slices complete. Initial Linux
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
| Full frontend baseline                                                            | Unit 30.7 s; browser 421.9 s                                                                    | Candidate result recorded with final delivery                                         | Baseline reports 931 unit and 1,476 browser passes, plus two explicit skips. First-run cache history differs; no whole-suite speedup is inferred from a later run.                                                  |
| Strict tooling check                                                              | Existing strict projects                                                                        | 1,345 files, zero warnings/lint/type errors; 8.5 s checker / 10.7 s guarded total     | Actual changed-interface coverage. The first attempt's eight test-typing errors were repaired, not suppressed.                                                                                                      |

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

The useful remaining bottleneck is the measured seven-minute browser execution,
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
