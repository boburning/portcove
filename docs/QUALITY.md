# Code quality and codebase intelligence

Portcove uses one local quality interface for humans, CI, and coding agents. The bootstrap requires Cargo/Rust, Node 24, and PowerShell 7 on Windows or Bash on Linux/macOS. Install the pinned tools with:

```powershell
.\scripts\bootstrap-quality-tools.ps1
```

```bash
./scripts/bootstrap-quality-tools.sh
```

Pass `-IncludeDeep` or `--include-deep` to also install cargo-modules, semdup, cargo-mutants, and Hawk where supported. Both scripts are idempotent, verify and print exact installed versions, and never silently upgrade tools. Deep tools remain optional: Hawk uses its own manifest-pinned Rust toolchain and does not support Windows, while semdup requires a current native C++ linker for its ONNX runtime.

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

| Scope | Command | Purpose |
|---|---|---|
| Rust change | `just check-rust` | format, compile, Clippy, tests, unused dependencies/files, and crate boundaries |
| UI change | `just check-ui` | production build, tests, and the existing Fallow gate |
| Cross-stack or release change | `just check` | both fast loops plus deterministic package-policy, staging, checksum, and release-note tests |
| Substantial completion | `just audit` | fast loop plus dependency policy and rscheck |
| Large structural change | `just deep` | audit plus advisory Hawk and semdup analysis |
| Explicit cycle investigation | `just cycles` | optional advisory module-cycle report |
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

Required pull-request CI has a five-minute warm-cache target for the complete pipeline, measured from run creation to the terminal required-job result. The Windows Rust suite is exhaustively partitioned into service, recovery, remaining-core, non-core workspace-test, and format/Clippy lanes, while a lightweight Windows job covers development-storage behavior. A native matrix also runs the full workspace through cargo-nextest on Linux x86-64, macOS x86-64, and macOS arm64 so platform-specific filesystem, process, and permission behavior cannot be represented by Windows compilation alone. Native tests use the runner-owned temporary directory so macOS's system `/var` compatibility symlink is not mistaken for a library-controlled symlink ancestor. Giving the non-core test and lint lanes independent job identities also gives them independent Rust cache keys; a fast core shard therefore cannot win a shared-key save race and leave the slower graphs uncached. The required `rust` job fails closed unless every Windows and native producer passes. Clippy's all-target compilation replaces a duplicate standalone `cargo check`; the Linux quality lane likewise avoids installing pnpm because it invokes Node and Rust tools directly. These boundaries are enforced by `scripts/ci-workflow.test.mjs` so missing shards, native platforms, unused setup, a shared-key race, or accidental serialization cannot silently return to the critical path.

A lockfile or toolchain change is expected to pay each lane's cold-build cost once. [Run 33832768415](https://github.com/boburning/portcove/actions/runs/33832768415) established the initial 7m45s cold baseline and exposed the shared-key race. After isolating the non-core jobs, [run 33833781499](https://github.com/boburning/portcove/actions/runs/33833781499) passed in 6m49s while populating both new lane-specific caches.

Frontend pull requests use the required GitHub dependency-review check to block newly introduced high-severity vulnerabilities. Dependabot alerts and automated security fixes provide continuous repository-wide npm monitoring. The frontend build lane therefore does not make a second live request to npm's advisory endpoint on every commit, including npm's implicit install-time audit while bootstrapping pnpm; those duplicate requests added no change-specific coverage and could hold all otherwise-passing checks open for repeated network timeouts. Frozen lockfile installation, production build, tests, Fallow, and the pnpm/`just` development-storage integration cases remain required. The Windows and Linux Rust lanes retain every platform-relevant development-storage test while delegating only those two tool-integration cases to the prepared frontend lane.

The manually triggered `.github/workflows/deep-quality.yml` workflow provides a reproducible Ubuntu 24.04 environment for the full advisory pass, including semdup and Hawk. Ubuntu 24.04 is intentional: semdup's bundled ONNX Runtime currently requires newer glibc C23 symbols than the Ubuntu 22.04 runner provides. It runs the same `just deep` constituents as independent audit, Hawk, and semantic-duplication jobs so they execute in parallel, but is deliberately not a required pull-request status check. Start it after broad refactors or when the Windows host cannot link semdup:

```bash
gh workflow run deep-quality.yml --ref main
```

The workflow caches semdup's exact-version executable, versioned 149 MB model, and repository-local SQLite corpus. A source change restores the most recent compatible corpus and embeds only changed units; a configuration change starts a new corpus series. The first CPU-only index is allowed a longer cold-start budget, while later runs should be incremental. The deterministic audit and Hawk lanes reuse the former combined job's Rust cache so the split does not discard the established warm path.

The workflow log is review evidence, not an instruction to rewrite code. Hawk and semdup findings remain advisory, but the hosted job requires both analyzers to execute successfully so a missing tool or broken runtime cannot masquerade as a clean report. Local `just deep` continues past unavailable optional tools, and deterministic checks inside `just audit` still block normally.

## Architecture gate

`scripts/check-rust-architecture.mjs` reads `cargo metadata --format-version 1 --no-deps`; it never scrapes manifests. It requires both adapters to depend on `portcove-core`, prevents core from depending on CLI/Tauri/desktop concerns, prevents either adapter from depending on its peer, and keeps the default Cargo member set limited to Core and CLI so a focused Rust build has no desktop frontend prerequisite. Add future layer rules to the checker data rather than writing a second checker.

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
