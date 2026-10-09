# Quality operation reference

Read only the operation needed. [QUALITY](../QUALITY.md#required-hosted-baseline) owns
current selection. In retained details, platform-wide, browser, analyzer and installed
requirements refer to explicit exhaustive qualification or named acceptance; they do
not expand ordinary PR CI. The cutover still satisfies its pre-change policy once.

## Staged audit receipts

Upstream health's protected accounting policy is
`.github/upstream-health-accounting.json`. Its reviewed original-location
conditions and exact provider-reported pin assessments retain degraded/unknown
availability and unverified bytes. They are monitoring dispositions, never
catalog maintenance, successor, installation or artifact authority. Changes to
this policy or its metadata helpers select full monitoring and the applicable
pre-change protected transition; the candidate cannot authorize its own accounting
or waive a failed run. New, changed or insufficient facts fail closed under
[UPSTREAM-OBSERVATIONS.md](../UPSTREAM-OBSERVATIONS.md).

Local validation selects resource preflight from its actual command plan before
execution: tooling/frontend scopes do not resolve Cargo or native outputs,
Rust resolves actual Cargo storage, and mixed/unknown commands keep the complete
scope. Capacity, physical-path and machine-policy checks run independently of
successful test receipts. See [development storage](../DEVELOPMENT-STORAGE.md#bootstrap-and-preflight)
for portable defaults and the private strict Windows profile.

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

`just local-check` stores compatible command-stage receipts below the same root.
It may preserve a proven Rust or UI obligation after an unrelated tooling repair
while rerunning the changed tooling obligation. It cannot compose incomplete,
failed, interrupted, policy-stale, or stateful evidence into a pass, and it never
replaces current-head required CI.
Repository-wide Oxlint always executes when selected: its scan crosses several
receipt domains, and a content-identical extension or path change can alter the
applicable lint environment even when file bytes are unchanged.

Representative hosted selection after explicit ownership routing:

| Candidate                                                          | Selected hosted behavior                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Informational docs or issue template                               | prose where allowlisted, otherwise focused repository groups           |
| Frontend presentation                                              | frontend and Rust-quality fast groups                                  |
| Focused core Rust                                                  | Rust and Rust-quality fast groups                                      |
| Ordinary tooling repair                                            | explicit groups, or all-fast primary-host fallback when safely unknown |
| Selector, workflow, updater-trust, signing or authorization policy | exhaustive protected qualification on all maintained platforms         |

Renames and deletions classify both identities, mixed changes union their owners,
and incomplete discovery authorizes no plan. Words such as `design`, `channel`, or
`release` in an otherwise inert filename do not assign trust authority.

The maintained native artwork-correction harness, its preparation/main consumers,
two synthetic JPEG fixtures, and scenario catalog/test have explicit frontend
ownership. Both frontend lanes run their Node contracts and context preflight;
ordinary native acceptance still runs separately on the changed scenario. These
qualification consumers do not change Rust, signed catalog inputs, or publisher
authority. The exact inventory lives in the protected hosted selector. New or
renamed unknown harness paths retain all-fast fallback; mixed product, native,
signing, and policy changes retain their additional owners and qualification.

The maintained `apps/desktop/scripts/desktop-source-dialog-test.mjs` consumer
also has explicit frontend ownership and selects its Node scenario contracts
locally. It observes source intake, discovery and scan presentation through the
existing application and CLI; it does not implement durable scanning or source
authority. Its changed native interactions still require the ordinary isolated
native scenario. This exact entry grants no ownership to another harness, its
Core/Tauri implementation, or a renamed or mixed authority input.

The reviewed `apps/desktop/scripts/desktop-install-fixture.test.mjs` assertion
file also belongs to frontend validation: both frontend lanes discover its
Vitest cases. Its Windows-only process-tree case still requires actual Windows
execution when changed; a Linux skip does not supply that evidence. This exact
test ownership does not narrow its fixture, scenario or Playnite lifecycle
implementations, which retain their existing conservative/native selection.
Selected local checks run the existing Fallow gate for frontend source, script
and test changes. Both hosted frontend lanes also run that same gate; the fast
lane checks it before build/test and browser preparation. Its settings and final
qualification obligation remain unchanged. This retains early feedback on
analyzed fixtures without adding an unrelated Rust or native local suite.

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
exceptions. Portcove pins pnpm exactly in the root `packageManager` field,
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
declarations and the quality contract to agree. An increase therefore requires
one reviewed update across the workspace metadata, pinned toolchain, and machine
contract instead of an implicit move with latest stable.

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

Routine Renovate traffic is bounded to two concurrent branches and pull requests,
two new pull requests per hour, and four branch updates or rebases per hour.
Security vulnerability alerts retain Renovate's documented bypass of those
ordinary queue limits, while GitHub vulnerability alerts and Dependabot security
updates remain independent. Revert the four top-level limits in `renovate.json`
if dependency freshness suffers; do not compensate by weakening CI or enabling
broad automerge.

Linux desktop build prerequisites are installed through `scripts/install-linux-desktop-prerequisites.sh` in required CI, deep-quality, release, and updater-rehearsal workflows. The installer skips package-network work when the exact prerequisite set is already present, isolates resolution to Ubuntu sources, and gives APT three bounded fetch retries with explicit connection and package-lock timeouts. It first tries the runner-configured mirror under separate two-minute update and three-minute install deadlines, then applies the established archive mirror fallback with four-minute update and five-minute install deadlines. Narrow options add the updater rehearsal's `rpm` or AppImage runtime tools, or the on-demand native-compatibility workflow's WebKitWebDriver/Xvfb tools; unknown arguments fail before package work. Each calling step has a fifteen-minute outer limit and fails if both mirror attempts are exhausted. These retries cover external package retrieval only; repository tests retain zero retries, and a failed validation is never converted into a passing result.
The helper never opens an interactive privilege prompt: root runs directly, while
other callers must already have noninteractive sudo authority. Each APT process,
including its privilege wrapper, is inside the declared deadline.

After independent activation, required pull-request CI has a five-minute
warm-cache target for routed fast work, measured from run creation to the
terminal required-job result.
Qualification retains the exhaustive Windows Rust partitions, lightweight
Windows storage job, native Linux/macOS matrix, Intel producer/execution,
platform documentation, full Linux quality, frontend, catalog, and dependency
review lanes. Native tests use the runner-owned temporary directory so macOS's
system `/var` compatibility symlink is not mistaken for a library-controlled
symlink ancestor. Independent test and lint identities retain independent Rust
cache keys. The required `rust` wrapper fails closed unless the exact selected
fast lane or every qualification producer passes. These boundaries are enforced
by the workflow, result-gate, validation-plan, and qualification-coverage tests.

A lockfile or toolchain change is expected to pay each lane's cold-build cost once. [Run 33832768415](https://github.com/boburning/portcove/actions/runs/33832768415) established the initial 7m45s cold baseline and exposed the shared-key race. After isolating the non-core jobs, [run 33833781499](https://github.com/boburning/portcove/actions/runs/33833781499) passed in 6m49s while populating both new lane-specific caches.

Frontend pull requests use the required GitHub dependency-review check to block newly introduced high-severity vulnerabilities. GitHub vulnerability alerts and automated Dependabot security fixes remain active independently of routine Renovate updates. The frontend build lane therefore does not make a second live request to npm's advisory endpoint on every commit, including pnpm's install-time audit; those duplicate requests added no change-specific coverage and could hold all otherwise-passing checks open for repeated network timeouts. Frozen lockfile installation, production build, tests, Fallow, and the pnpm/`just` development-storage integration cases remain required. The Windows and Linux Rust lanes retain every platform-relevant development-storage test while delegating only those two tool-integration cases to the prepared frontend lane.

The manually triggered `.github/workflows/deep-quality.yml` workflow provides a reproducible Ubuntu 24.04 environment for a fresh deterministic audit. It is deliberately not a required pull-request status check. Start it when a fresh hosted audit is useful:

```bash
gh workflow run deep-quality.yml --ref main
```

The workflow log is review evidence, not an instruction to rewrite code. The same deterministic checks inside local `just audit --fresh` still block normally.

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
investigation. It also shows work class and caller, qualification failures,
cache-step observations, the observable pre-job, job-window and post-job
aggregation boundaries, exact comparable cohorts, recent
API-identified failure leads, and the three longest steps in each slow job.
CI and release validation upload one attempt-specific v4 provenance record named with
the run ID and attempt. It binds GitHub's `GITHUB_WORKFLOW_SHA` workflow-file
source commit and `GITHUB_WORKFLOW_REF`, the top-level caller workflow, the called
workflow path and SHA-256 of its checked-out bytes, the event source-code head, the separately checked-out `GITHUB_SHA` (including
GitHub's pull-request merge commit), desired Node, pnpm, Rust, Cargo and build
configuration, and the runner/toolchains actually observed by that job. Unused pnpm,
Rust, and Cargo are explicit `null` observations in the CI provenance job rather than
being installed merely to manufacture a receipt; release provenance still observes
the toolchains it uses. The record also binds the validation-plan digest, work class,
and caller so fast and qualification cohorts cannot be conflated. `ci-health` verifies the
artifact digest and every embedded identity before forming a cohort. Earlier or
expired runs without this record are explicitly unknown and excluded from
equivalent-cohort claims rather than receiving an inferred toolchain or workflow
identity. A rerun recovery is not proof
of a flaky test: runners, caches and external services may differ even when the
commit does not. No retries are scheduled by this report, and it never changes
issues, checks, caches or runs.

Qualification cross-compiles the Intel macOS test archive once, then runs both
Intel partitions from an artifact named for `github.run_attempt`. Before
retrying that chain, verify the workflow run's source head is the intended
candidate and identify its unique `build-intel-tests` job. Retry that producer
and its dependent consumers with:

```powershell
gh run view <run-id> --json headSha,jobs --repo boburning/portcove
gh run rerun <run-id> --job <build-intel-tests-job-id> --repo boburning/portcove
```

Do not use a failed-jobs-only `--failed` rerun after an Intel consumer failure:
GitHub can omit the already-successful producer while incrementing the attempt,
leaving the consumer to request an artifact that was never produced. A
producer-targeted rerun preserves the run, source head and ref while recreating
the attempt-qualified artifact and every dependent consumer. If the producer
cannot be identified unambiguously, rerun the complete workflow; never reuse an
artifact from an earlier attempt, another run or another commit.

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

Workflow durations run from creation (first attempt) or the attempt start
(reruns) to the attempt's terminal update. The additional timing boundaries are
limited to timestamps the API actually supplies: before the first observed job,
first job start through last job completion, and last job completion through the
workflow update. Summed job execution is not elapsed time or a billing claim.
In-progress attempts have no completed duration. Missing or backwards timestamps
remain unavailable rather than becoming zeroes. Percentiles use nearest-rank
selection.
The report omits p95 until a cohort has at
least 20 valid successful samples; that minimum alone does not establish a
representative long-term rate. Confirm improvements over ordinary subsequent
changes, not only repeated runs of one commit. Prefer fixing a recurrent costly
step over further sharding, reduced assertions or a growing monitoring service.

The required Rust test lanes and `just rust-test` use the version of cargo-nextest
pinned in `.github/quality-tools.json`. Five seconds is a diagnostic threshold,
not an acceptance limit. Nextest reports slow tests every five seconds and, by
default, terminates a test at thirty seconds with no retries or termination grace
period. Keep that tight default for small tests. An explicit, narrowly matched
override may give a demonstrated heavyweight filesystem, signed-catalog,
database or real-process lifecycle test a justified finite execution budget.
Its setup and teardown budget is distinct from the product timing assertions
inside the test; cancellation, shutdown and other product deadlines remain intact.

Do not hide failures with larger timeouts. Preserve the original failure and
identify the firing deadline: per-test harness, product assertion, whole command
or job, admission queue, or observation window. A live process whose observer
stopped still needs supported observation and cleanup before another invocation.
Use a bounded, hypothesis-driven diagnostic with unchanged assertions, fixture,
concurrency and retries. Around ninety seconds is an initial heavyweight-test
experiment, not a permanent default. Retain total and phase timings, actual
platform and meaningful warm/cold or resource conditions; obtain a matched
confirmation when necessary. Another platform or one extended-budget pass does
not resolve the original platform's failure or supply merge clearance.

Select the smallest causal repair or an evidence-supported narrow budget
correction with room for supported-platform variability. Fix identified deadlocks,
leaks, accidental contention or unnecessary repeated work; a larger budget does
not substitute for that repair. Do not require prolonged optimization merely to
defend an inherited number. Preserve coherent scenarios and full-catalog coverage
where required. Independently review the exact override and evidence, retain
slow warnings and finite termination, and satisfy normal selected validation,
protected pre-change qualification and exact-head hosted gates. A permitted
diagnostic budget experiment is not its own final policy-transition qualification.
Do not automatically enlarge Node, network, CI-job or other test budgets.
Pure unit tests should normally finish well below the diagnostic threshold.
A timeout or failed assertion still fails the lane.
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
Node hang guard. Uninstaller-child discovery ignores descendants of a reused
parent PID until the process also matches the session-owned temporary path. An
owned child must still match that path in both the retained handle and CIM
snapshot, its exact journaled executable hash, and the bounded timestamp identity
check before the harness can wait on or terminate it. No integration coverage is
removed.

Rust tests run two at a time by default on every platform, including local
Windows and its exhaustive CI partitions. This bounds filesystem contention
without serializing unrelated fixtures; explicit nextest thread settings remain
available for diagnosis. CLI free-space
snapshot contracts share a scheduling group because their existing in-process
mutex cannot synchronize nextest's separate processes. Output-relocation lifecycle
tests reserve both slots so their managed-tree copies do not contend with each
other or an unrelated filesystem lifecycle case. Full signed-catalog and
signed-definition repository tests, bounded diagnostics capture, database migrations, cancellation lifecycle
cases, and CLI process contracts reserve both default CPU slots while verifying complete snapshots. The native
conversion failure cleanup race does the same while it reaps owned process trees.
CLI contracts also use nextest's lowest priority so an exhaustive workspace run
drains default-priority in-process tests before beginning repeated executable
launches. This ordering introduces no test dependency and changes neither the
two-thread budget nor any configured per-test execution budget.
This slot reservation applies within each nextest invocation; it does not
exclude other CI partitions or unrelated host work. Signed-definition coverage
retains full authenticated catalogs, ordinary artifact installs and corrections.
Intel macOS
uses two exhaustive hash partitions to keep this work off the critical path.
This changes scheduling
only; it does not change test execution budgets. CI caches compiled dependencies
after test failures so fixing a failed assertion does not require a cold rebuild.

Supported local Rust validation commands serialize their heavyweight compiler
and test work across Portcove worktrees on the same machine. The maintained
`rust-check`, `clippy`, and documentation-test recipes enter admission before
starting Cargo, and nextest enters the same admission before compiling its host
fixture. `scripts/run-rust-tests.mjs`
publishes a complete lock record atomically below the shared tool-cache root
before compiling its host fixture. Each host first starts an owned containment
supervisor behind a registration gate; it cannot launch the pinned
`cargo-nextest` command until the wrapper has durably published the supervisor's
exact identity. Unix uses an anchored detached process group plus an out-of-group
watchdog established before nextest starts; supervisor loss closes the watchdog
pipe, kills the anchored group, waits until that group is absent, and publishes
cleanup evidence that later acquirers must validate. Windows uses a
kill-on-close Job Object. Closing either containment terminates every remaining
descendant without relying on a numeric group or mutable parent-PID snapshot
after identity mismatch. Inherited supported commands remain inside the existing
outer containment instead of detaching another unrecorded group. Registration or
cleanup failure retains ownership whenever quiescence cannot be proved. Ctrl-C
and termination close the outer containment and retain conventional exit status.
A legacy descendant record from before
supervisor containment is not reclaimed automatically. A matching wrapper or
surviving recorded containment supervisor remains authoritative;
a dead or PID-reused record is reclaimed only when neither identity matches.
Darwin adds a per-process random marker because its displayed start timestamp is
only second-resolution; one transition read accepts the previous timestamp
record solely to classify and migrate an already-published legacy lock.
Admission is bounded to one hour by default, polls at five-second intervals, and
immediately reports the owning PID, workspace, command and start time. It emits
another owner report every thirty seconds so an active queue remains visible
without repeatedly invoking an expensive platform identity probe. The monotonic
queue duration is outside every admitted command's own execution budget. Every
Windows or Darwin identity probe uses repository-required PowerShell 7 and also
fails closed after five seconds, so a slow platform probe cannot wedge
acquisition indefinitely and may add at most its own bounded probe interval to
the configured polling interval.
`PORTCOVE_HEAVY_RUST_WAIT_MS` may set a bounded 0 through 3600000 millisecond wait
for an explicitly coordinated run. Cancellation stops only the queued command.
Do not delete the lock record or terminate another worker's process.

After admission, the runner prepares its small Rust support executables through
the per-worktree Cargo target under `target/portcove-rust-support`. Reuse binds
the complete source bytes, rustc verbose identity and sysroot, resolved compiler
and linker bytes, exact target/architecture and arguments, and hashed relevant
compiler environment. Each immutable entry records and revalidates its output
bytes and mode. Missing, corrupt, interrupted, or identity-mismatched entries are
never executed: a candidate is compiled in a unique directory and atomically
published only after validation, stale interrupted candidates are rejected, and
retention is bounded to eight identities per support product. Every invocation
copies the verified product into its new temporary fixture directory and still
creates a fresh containment gate, process tree, assertions, and exit evidence.
The runner reports each support-product build or hit with its fingerprint and
preparation duration. No Cargo/nextest result, mutable fixture, containment
result, authorization, or test success is cached.

This machine guard covers `just test-rust`, selected Rust stages in
`just local-check`, `just rust-check`, `just clippy`, `just rust-test`, and the
aggregate commands that reach the same wrapper. It does not cover direct
Cargo/nextest invocations, hosted jobs, whole
Codex tasks, or native desktop sessions. The native desktop lock remains a
separate foreground-resource contract. The guard does not change nextest's two
test threads, watchdogs, retries, partitions, assertions, or required CI.

Intel test binaries are cross-compiled for `x86_64-apple-darwin` on Apple Silicon
and transferred in a nextest archive scoped to the current workflow attempt.
Both partitions execute on Intel macOS, including tests which compile native
helper processes. Intel documentation tests still build and run on Intel.
This avoids repeatedly compiling the full test workspace on variable Intel
runners. The archive is retained for one day; it is not a release artifact.
CLI tests resolve nextest's remapped executable path at runtime so archives do
not depend on the build machine's checkout or target-directory location.
The required Rust aggregate fails if either the build or any Intel test job fails.

Timed Rust lanes prepare the native host-tool probe fixture once during setup.
Each test copies it into its own temporary directory before mutation or probing.
`just rust-test` uses the same identity-bound preparation through
`scripts/run-rust-tests.mjs`;
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

The ordinary frontend compiler project remains the complete UI authority. Its
required `typecheck` also runs `tsconfig.orchestration.json`, a bounded stricter
project for production interaction and state orchestration. That project enables
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` for gamepad navigation,
global keyboard shortcuts, native source drag-and-drop, operation state,
concurrency state, subscription lifecycle, and view-model presentation. Keep its
file inventory explicit and extend it only with real fixes and compatibility
review; do not add assertions or suppressions to make a broader experiment pass.

The 2026-09-19 baseline experiment reported 180 diagnostics when both options
were applied to the complete frontend: 95 `TS2375`, 40 `TS2532`, 17 `TS2379`,
and 28 across five other codes. The selected production project reported 12
diagnostics across `TS2322`, `TS2345`, `TS2379`, and `TS2532`. Those selected
ambiguities were resolved with neutral absent-axis values, explicit index guards,
fallback presentation, and omission of absent optional fields. The unselected
full-frontend result remains compatibility evidence, not a passing gate.

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
which uses the exact private host transport declarations. Its input, output and
named-event payload snapshots remain separate from core's export. Strict compiler fixtures cover
the desktop's required nullable envelope fields, camelCase launch identity and
typed install request; Rust fixtures check actual Serde output/input behavior.

The transport check also inventories Desktop IPC exposure without generating a
second RPC description. The one production `tauri::generate_handler!` list is the
registration authority. `node scripts/check-transport-contract.mjs` requires its
command names to match every bare `#[tauri::command]` declaration and every `invoke`
use in shipped non-test TypeScript under `apps/desktop/src`. It requires the direct
import and a literal command name, rejecting aliases, indirect calls, missing, extra,
renamed, duplicate, dynamic, macro-composed, or attributed command forms until the
checker explicitly supports them. Unit fixtures include a coherent registration/frontend
rename that the independent declaration inventory rejects; the integration test
compiles the live Rust exporters and requires the complete repository contract to
pass. This association gate does not replace backend validation, native consent,
Tauri capability/window scope, CSP/origin controls, or release-bundle checks.

The same Rust host declaration module owns every shipped `portcove://` event name
and the only direct Tauri emit adapter. Each producer supplies an explicit Rust
payload type to that adapter; the compiler checks the value, while the transport
gate independently binds the type and named constant to the schema export.
Shipped React consumers subscribe through the generated `DesktopEventPayloads`
map and one typed `listenDesktopEvent` adapter. The checker rejects missing,
extra, renamed, duplicate, dynamic or direct untyped producers and subscriptions,
including wildcard, aliased and qualified Tauri emit access. Its independent
compatibility fixture freezes the three released event identities and payload
types so a coherent generator/producer/consumer rename or type substitution still
fails. The generated unit payload for `portcove://library-changed` is `null`;
consumers do not invent content for that invalidation hint. Durable SQLite state
and explicit readback remain authoritative after every event.

## Consumed Intel test transfers

The `intel-rust-tests-<attempt>` archive transfers compiled tests from the Apple
Silicon producer to both Intel test partitions. It is not a release artifact.
`Cleanup consumed Intel transfers` runs trusted default-branch code after CI or
qualification completion and hourly. Its only write authority is a job-scoped
Actions token. It deletes a transfer only after a complete job inventory proves
that its exact producer and both Intel consumers succeeded in the same completed
run attempt. Active runs, failed Intel attempts, ambiguous inventories, all other
artifacts, and release assets are preserved. The one-day upload retention remains
as the fallback. After successful transfer cleanup, rerun Intel tests together
with their producer rather than rerunning only an already-successful consumer.

Use `node scripts/cleanup-intel-artifacts.mjs` for a read-only inventory and add
`--apply` only for the authorized scoped cleanup. A restarted attempt or changed
artifact identity stops deletion. Failed or ambiguous deletion responses require
readback; the tool never retries an uncertain mutation.
