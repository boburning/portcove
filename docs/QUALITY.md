# Code quality and codebase intelligence

## Required hosted baseline

Ordinary pull requests require exact-head hosted CI and actual separate
non-writing review under [Contribution conventions](CONTRIBUTION-CONVENTIONS.md#review-and-merge).
Local commands, including bare `just`, `just local-check`, focused tests and
analyzers, are optional feedback. Omitted local checks need no explanation.
Native/UI/installer observations are required only by explicit owning-issue
acceptance or a release contract. Tests/fixtures do not establish those observations.

The five required contexts remain `catalog`, `dependency-review`, `frontend`,
`rust` and `rust-quality`. `scripts/validation-plan.mjs` selects them from the
complete merge-base PR diff or push `before -> after` diff, including rename
sides and file modes. A missing historical/first-push base uses the entire baseline;
unavailable, unsafe or incomplete discovery blocks. Safe unknown paths select
the entire Windows baseline, never an empty package selection or an automatic audit.

| Context           | Ordinary required coverage                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| rust              | Windows workspace test-target compilation (`--locked --workspace --all-targets`), then affected maintained test families      |
| frontend          | Build/typecheck and import-related unit tests; full unit fallback for shared/configuration/uncertain or empty graph selection |
| rust-quality      | Repository/TOML formatting, plus Rust formatting for Rust inputs                                                              |
| catalog           | Relevant cheap schema, repository and tooling contract tests                                                                  |
| dependency-review | Relevant dependency diff, with the existing high-severity rejection policy                                                    |

Rust execution reuses `.config/rust-test-impact.json`. Every group is package
qualified, has nonzero runnable tests, and contributes its exact binary/test
identities to the verified union. Complete workspace listing and execution use
the same workspace/all-target scope, preserving downstream CLI/Tauri/release
compilation and feature unification. Unmapped, renamed or deleted Rust files
select the whole affected package; root dependencies/toolchains, new uncertain
packages and safe unknown ownership select the whole workspace. Existing public
artwork consumer coverage stays selected. Do not invent a reverse-dependency
planner or narrow unowned paths. A missing map keeps broad package coverage.

Docs/prose/images select formatting and pertinent documentation/asset contracts;
topic keywords do not select Rust or platform qualification. Policy/workflow
changes use the ordinary baseline. Full tests, all platforms, Clippy, Fallow,
rscheck, browser composition, Playnite and storage/integration coverage remain
inside `ci.yml` behind explicit `force_qualification`, invoked nightly, manually
and for releases. Release qualification binds the exact release SHA/plan digest
and succeeds before assembly, signing, attestation or publication. Fresh deep
audit remains explicit/release work; the normal nightly full CI does not imply a
fresh audit. Existing trusted main audit receipt import/reuse is preserved.

Warm focused PR required CI targets five minutes. This is a measurement goal,
not a timeout or permission to omit coverage. Report cold builds, broad/unmapped
changes and root dependencies separately. Preserve nextest's two slots,
heavyweight reservations, 30-second test budgets and process/resource/storage guards.

The October 9 baseline cutover (#1682) qualifies once under its pre-change
policy: independent review, complete fresh audit, exhaustive exact-head hosted
CI and distinct Windows qualification. The reduced ordinary policy applies
after delivery; this candidate cannot count its new baseline as that proof.

On failure retain evidence, isolate the cause and repeat invalidated obligations.
Do not hide failures, bypass guards or label an unchanged pass a causal repair.
Historical selection evidence is a [conditional reference](reference/validation-history.md).

## Setup

Portcove uses one local quality interface for humans, CI, and coding agents. The bootstrap requires Cargo/Rust, Node 24, and PowerShell 7 on Windows or Bash on Linux/macOS. Install the pinned tools with:

```powershell
.\scripts\bootstrap-quality-tools.ps1
```

```bash
./scripts/bootstrap-quality-tools.sh
```

Pass `-IncludeDeep` or `--include-deep` to also install the optional cargo-modules and cargo-mutants tools. Both scripts are idempotent, verify and print exact installed versions, and never silently upgrade tools.

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
It preserves exact frontend outputs across reruns only when a content-addressed
record proves the complete declared input, build-environment/toolchain, and output
inventories match. Cargo still checks the native build and every selected native
scenario still runs; see [Development tools](DEVELOPMENT-TOOLS.md) for the cache
boundary and retained evidence.

| Scope                                | Command                                               | Purpose                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan or run a coherent local change  | `just` or `just local-check [--plan]`                 | select formatting, affected Rust packages, related UI tests, and exact tooling contracts from the complete local diff                         |
| Classify a routine Renovate PR       | `just renovate-check --pr <pr> --head <sha> [--json]` | inspect one exact head and current target once, then run only locked metadata and dependency policy for an eligible Cargo/npm update          |
| Focus a Rust edit-test loop          | `just test-rust <args>`                               | pass an explicit package, target, or test-name selection through the pinned nextest fixture runner                                            |
| Focus a UI edit-test loop            | `just test-ui-related <files>`                        | run Vitest tests related through the import graph to explicit changed source files with the standard isolation and timing contract            |
| Focus a Node tooling edit-test loop  | `just test-node <test-files>`                         | run explicit Node test files with the standard hang guard and duration reporter                                                               |
| Format supported files               | `just fmt`                                            | rewrite Rust, frontend, configuration, and active documentation with the repository-pinned formatters                                         |
| Verify all formatting                | `just fmt-check`                                      | check the complete formatting contract without changing files                                                                                 |
| Standalone workspace type check      | `just rust-check`                                     | run Cargo check for every workspace target when that isolated diagnostic is useful                                                            |
| Exhaustive local Rust investigation  | `just check-rust`                                     | preserve incremental reuse while running formatting, warnings-denied Clippy, tests, doctests, unused dependencies/files, and crate boundaries |
| Explicit incremental-cache cleanup   | `just prune-incremental`                              | safely remove only this workspace's disposable Cargo incremental state when storage or corruption evidence justifies cleanup                  |
| Exhaustive local UI investigation    | `just check-ui`                                       | Oxfmt, type-aware Oxlint, Stylelint, production build, tests, Fallow, and one batched UI lint-tool fixture contract                           |
| Playnite reference change (Windows)  | `just playnite-check`                                 | locked SDK/reference-assembly builds, literal process arguments and public protocol regression fixtures; optional isolated compiled-CLI reads |
| Exhaustive source/repository check   | `just check`                                          | Rust, UI, script/workflow scans and batched lint-tool fixtures, repository tooling, Roadmap, and development-tool contracts                   |
| Deterministic release-unit check     | `just release-check`                                  | release metadata, packaging, updater, channel, workflow, and Windows qualification unit contracts                                             |
| Packaged Windows qualification       | `just windows-qualification-check`                    | stateful Windows packaged-session integration; always observed rather than reused                                                             |
| Release or explicit transition audit | `just audit [--plan\|--fresh]`                        | staged exhaustive check, dependency policy, rscheck, release units, and applicable Windows qualification                                      |
| Explicit cycle investigation         | `just cycles`                                         | optional advisory module-cycle report                                                                                                         |
| Critical core test review            | `just mutants`                                        | optional mutation analysis for `portcove-core`                                                                                                |

The release-unit metadata gate also binds Desktop command context to one local
`main` window and uses Cargo's own metadata graph to reject qualification-only
features in both the transitive default feature set and always-enabled dependency
features. The production Vite build separately rejects development
scenario and fixture modules from emitted assets; these independent checks keep
test and rehearsal surfaces out of ordinary release builds.

The exhaustive Rust aggregate does not run standalone `cargo check` immediately
before Clippy. Its warnings-denied `cargo clippy --workspace --all-targets -- -D
warnings` invocation compiles and type-checks the same workspace target set, then
adds lint enforcement. `just rust-check` remains available when an isolated Cargo
check is the intended diagnostic.

### Optional command selection

Local recipes select complete-diff formatting, relevant Node contracts,
workspace test-target compilation with maintained Rust execution filters, and
frontend build/related units. They do not automatically run Clippy, browser,
analyzers, installed acceptance or fresh audits. Unknown safe ownership selects
the entire baseline. Use [resource operations](DEVELOPMENT-TOOLS.md#rust-test-runner)
for guarded execution; dated consolidation evidence is
[retained](reference/validation-operations-history.md#single-session-validation-consolidation).

## Local feedback and hosted authority

`just local-check --plan` shows optional complete-diff feedback. Bare `just` and
`just local-check` execute that baseline; focused `test-rust`, `test-node` and
`test-ui-related` commands remain available. `--fresh` invalidates local receipts
only for that operation. Preflight observes selected prerequisites without
provisioning or dispatch. Hosted authority, receipt reuse, native observations
and explicit fresh audits remain distinct evidence roles.

Use [Development tools](DEVELOPMENT-TOOLS.md#validation-tiers-and-resumable-audits)
for operation/preflight syntax and the receipt sections below when reusing audit
evidence. A local pass never supplies required hosted exact-head checks.

## Staged audit receipts

Explicit audits run named independent stages and retain conservative, integrity-checked receipts. Failed/incomplete receipts never qualify a pass; advisory and machine-state stages always rerun. Ordinary CI selection and receipt input ownership have different roles. See the [audit operation](reference/quality-operations.md#staged-audit-receipts) for fingerprints, hosted import and protected transition details.

## Formatting contract

Repository-pinned Oxfmt owns supported JS/TS/config/docs files; Cargo fmt owns Rust and Taplo owns TOML. Formatting stays in ordinary CI. Analyzer baselines and exhaustive scan details are conditional [format/analyzer operations](reference/quality-operations.md#formatting-contract). Fix causes; do not add suppressions to manufacture a pass.

## Tool and Rust version authority

Cargo.toml, rust-toolchain.toml and .github/quality-tools.json own exact tool/compiler pins. Bootstraps verify versions and checksum policy; caches cannot waive them. See [tool provisioning](reference/quality-operations.md#tool-and-rust-version-authority) for platform setup, bounded retries and historical measurements. Platform provisioning, structural analyzers and storage integrations run in exhaustive qualification.

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
waits three days before proposing new releases, disables automerge, and opens
eligible product-dependency pull requests immediately so pull-request-only CI
can evaluate them.
Non-security development-tool proposals use all-day Monday and Thursday creation
windows in `America/New_York`. These are eligibility windows, not guaranteed
service execution times. Ordinary runtime dependencies and the React/Tauri
compatibility families remain continuously eligible after the cooldown. Weekly
lockfile maintenance retains its Monday window and controlled delivery. Existing
branches may receive necessary maintenance outside creation windows.
Vitest and installed `@vitest/*` providers move together. Vite, Oxc, Tailwind and
Stylelint have separate compatibility groups, so unrelated families do not block
each other. React includes React DOM and their declarations; Tauri combines the
selected JavaScript and Rust framework inputs without requiring equal versions.
Aqua itself and the three Aqua-managed quality tools form one
qualification group. The standard Aqua registry ref remains an extracted,
visible authority but is disabled as an independent update: change it in the
same reviewed change when a tool version, compatibility repair, integrity update,
or security response requires a newer registry. Routine updates retain the
three-day age policy. Renovate vulnerability-alert pull requests bypass the
ordinary schedule, queue limits, and minimum release age so detected security
repairs surface immediately; they still retain applicable checksums, protected
CI, review and authorized guarded merge.
It automatically recreates an existing branch when that branch conflicts with
its base, not merely because `main` advanced; the main ruleset does not require
strict behind-base freshness. A newly available dependency version, lock-file
maintenance, or an explicit dashboard/manual retry remains a separate branch
update trigger, and real conflicts are never suppressed.
The reviewed `rusqlite` Git revision is excluded by its Cargo-extracted URL,
short dependency name, manager, and datasource. Repository tests reproduce that
identity and require every nonstandard authority and external action to remain
covered.

### Bounded dependency delivery

Start one authorized maintenance cycle with
`just renovate-check --queue [--json]`. It reads the complete current proposal
inventory, exact source heads, target interactions, required checks and run
identities. The selected row is a recommendation: confirm existing ownership and
actual writer activity and source-owner release before overlapping work. No
coordinator grant or acknowledgment is required for independent delivery.
The command does not retry, approve, rebase or merge proposals, assign ownership
or maintain another queue. Refresh
after every delivered outcome. No unattended execution is implied.

Use four delivery paths:

- **Routine fast lane:** run `just renovate-check --pr <number> --head <sha>`.
  Only `merge-ready` permits the existing #878 exception: exact-head hosted
  compilation/lint/tests plus locked metadata and dependency-policy validation,
  followed by concise delivering-agent upstream/diff review and guarded merge.
  This does not require a duplicate broad local aggregate or separate review.
- **Controlled maintenance:** compatibility groups, pre-1.0 inputs, tools,
  Actions, lockfile maintenance, sensitive boundaries and repaired proposals use
  the ordinary diff-selected local/hosted plan and independent non-writing
  review. Signing/trust, credential storage/transport, extraction and persistent
  database inputs require behavior-specific evidence regardless of labels or
  a small version increment. Inspect enabled features, transitive changes,
  install/build behavior and relevant compiler/runtime requirements. Browser
  provider updates include the real browser stage; native/updater changes retain
  their distinct acceptance. Pure formatter updates do not imply installed-updater
  qualification.
- **Planned migrations:** major proposals require selective Dependency Dashboard
  intake. The authorized runner can approve an owned finite migration within
  existing authority. Ordinary proposals do not need that approval. Priority
  orders eligible intake; it cannot evict occupied slots. Preserve finite owners,
  blocker/resume conditions and failed evidence rather than closing failures to
  free the queue.
- **Urgent remediation:** security-intent metadata selects prompt advisory
  assessment, not an automatic vulnerability finding. Confirm the applicable
  advisory, locked graph and exposed function. Necessary fixes proceed separately
  from elective upgrades, without the ordinary release-age or intake delay; review,
  signatures, required checks and affected native/installed behavior remain.

The fast-lane whole-lock comparison permits only the claimed direct version and
registry integrity transition. Unknown syntax, other resolution changes, source,
feature or package metadata changes require controlled review. Missing or ambiguous
release-age evidence also requires a specific reviewed resolution; do not relax
timestamp requirements globally. A repaired proposal cannot regain bot-only
eligibility by changing labels. Convenience batches may be separated when an
independent member blocks; compatibility families must remain coherent.

Pending CI retains the actual run, attempt, exact source head and one absolute
execution deadline for `pr-watch`. Collect failures once and repair their cause
before retrying. Neither a queue refresh nor an unrelated target advance justifies
mass rebasing or repeating valid evidence. Lockfile resolution is package-manager
driven: the direct-update cooldown does not prove the age of every newly resolved
transitive dependency. Cargo and frontend lockfile maintenance are controlled
units; separate them only through supported Renovate behavior when qualification
and rollback scope justify it.

Validate configuration with the official pinned client used for the current
resolved-rule receipt:
`corepack pnpm --package=renovate@44.125.1 dlx --allow-build=re2 renovate-config-validator --strict renovate.json`.
Schema validation supplements the repository's rule/extraction/classifier tests;
it does not prove effective inherited grouping or hosted proposal uptake. Inspect
resolved presets and rule precedence with the matching official engine, then read
back actual hosted proposals after delivery. The validator pin is a validation
client, not a new runtime dependency or tool manager. Deliberately excluded Aqua
registry and rusqlite authorities retain their existing reviewed resume conditions.
Renovate proposes repository dependency changes; it cannot accept game releases,
successor repositories, catalog artifacts or changed trust policy.

Renovate is the sole routine dependency-version update authority. GitHub
vulnerability alerts and automated Dependabot security fixes remain enabled
independently; the absence of `.github/dependabot.yml` retires scheduled
Dependabot version-update jobs without disabling those repository security
capabilities.

Current Tauri Linux dependencies transitively include the unmaintained GTK3 binding family; other transitive build paths include `proc-macro-error` and the `unic-*` family. `cargo deny check --hide-inclusion-graph -W unmaintained` keeps these visible while continuing to deny security advisories, while omitting thousands of lines of repeated transitive paths from the normal audit. There is no safe direct Portcove upgrade that removes the GTK3 set without changing Tauri's Linux webview architecture.

GitHub also reports GHSA-wrw7-89jp-8q8g for Tauri's Linux-only `glib 0.18.5` graph. Dependabot confirms that `0.18.5` is the newest version compatible with Tauri's GTK3 stack while the advisory declares `0.20.0` as the first fixed release. Keep that alert open in its durable issue and live Project item; do not conceal it with a version-only dismissal, an unreviewed fork, or a broad advisory exception. Re-evaluate when Tauri adopts a compatible maintained GTK stack.

## Initial structural baseline

The dated [structural baseline](reference/validation-history.md#initial-structural-baseline)
is retained for analyzer investigations; it is not an ordinary PR load or gate.

## Ratcheting

Do not increase the current complexity limits or add new warnings in touched code without review. Lower `max_fn` from 25 only after the repository satisfies the lower value naturally.

## Upstream health checks

Ordinary PRs select relevant deterministic repository, release and local RetComM
contracts; exhaustive qualification retains their complete inventory. Live repository availability and
RetComM upstream comparisons run separately in `upstream-health.yml` when catalog
data, the mapping, either checker, the Node version, or that workflow changes.
The same workflow runs daily and can be dispatched manually. Its path-filtered
status must not be configured as an always-required branch check, because an
unrelated PR does not create that status. Pull-request live scope derives from
exact base/head semantic catalog inputs: summary-only changes have an explicit
empty scope, while affected unknowns fail. Root/history, checker, workflow, policy
and uncertain changes retain full scope; incomplete identity/diff discovery
refuses narrow selection. Main, scheduled and manual checks retain the full
inventory. Scheduled failures remain visible in
Actions and require investigation as upstream drift, not a local code failure.
Release workflow and local release preflight retain their live upstream checks.

The advisory cycle report is deliberately excluded from routine CI and `audit`
because its known inherent-item cycle baseline produces non-actionable noise.
The pinned tool remains available through the optional deep bootstrap and
`just cycles`; the deterministic Cargo-metadata architecture gate is unchanged.

## Test latency and reliability

Keep nextest two-slot execution, slow diagnostics, finite 30-second test termination, zero retries, heavy-test/process guards, UI isolation and Node duration reporting. Never increase budgets or preempt another worker to hide a failure. Native/installer integration uses existing distinct deadlines when selected. Diagnose the smallest discriminating reproduction and rerun invalidated obligations. See [latency and resource operations](reference/quality-operations.md#test-latency-and-reliability) for lock ownership, inventories, platform transfers and transport fixtures.

## Routine merge freshness

[Contribution conventions](CONTRIBUTION-CONVENTIONS.md#review-and-merge) owns
exact-head review, target interaction, waits and guarded merge. Validation
evidence does not confer merge authority.

## Consumed Intel test transfers

Exhaustive qualification retains the exact compiler/target/manifest and binary identity checks when producing Intel tests on Apple Silicon and executing on Intel hardware. See [transfer validation](reference/quality-operations.md#consumed-intel-test-transfers).
