# Development tools

## Verification input and execution identities

`native-rejected-listener-registration` is a standalone Windows qualification
scenario. While actual Core preparation is running, it changes one owned event
registration argument to an invalid name containing a space. Tauri itself rejects
the request; its response is returned unchanged. The harness checks that the
rejected handler and invoke callbacks settle, degraded live-update guidance and
read-only refresh remain usable, and a genuine library-generation remount obtains
a fresh listener without repeating preparation. This controlled invalid-input
case does not establish natural transport loss or Linux listener qualification.

The version-bound `@tauri-apps/api@2.12.4` patch releases only the callback allocated
by a rejected `listen()` call and rethrows its original error. ESM and CommonJS
entrypoints carry the same patch; successful registration and native unlisten
retain upstream behavior. The maintained adapter regression uses the actual API
package with an emulated transport. Review the patch and regression when updating
that dependency; remove the patch only after equivalent upstream cleanup is proven.
Root pnpm `patches/*.patch` changes, including removal, select the complete UI
suite. Their bytes also invalidate format, UI and release evidence fingerprints; unrelated
files in that directory remain subject to unknown-input refusal.

The Windows/Linux native CLI wrapper captures declared inputs before importing
the harness. Supported standalone products and cached drivers execute retained
bytes; path-sensitive or unestablished layouts retain the original path with
cooperative content checks. Helpers are checked before the target import,
application/driver launch boundaries and after execution. Already loaded trusted
verifier inputs remain separately labeled observations. These mechanisms do not
prove immutable consumption of every live-path dependency.

Version-3 native receipts keep original and retained identities, consumed paths,
binding mechanisms and limits. Version-2 receipts remain readable historical
observations; retention established later is a new observation, never backdated
custody. Input capture shares the selected existing execution deadline and awaits
its worker before reporting cancellation. Publication admitted before late
cancellation is preserved; required execution/acceptance is never inferred from
the retained object.

Build-input fingerprints, product-artifact identities, harness identities and
execution/qualification bindings are separate comparison fields. Runtime,
fixtures, initial state, selected requirements/scenarios and criteria affect
execution reuse even when product bytes match. Source-head provenance is separate
from content reuse; documentation-only changes need not rebuild the frontend.
Existing exact-head CI remains required.

Vite Task executes or restores the frontend bundle from its tracked inputs and
declared output scope. Native verification observes the resulting bytes.
Native compiler/version observations do not seal SDK/system-provider inputs;
native product build skipping remains unavailable at that boundary. Normal
Cargo invocation and supported incremental behavior remain. This extends only
the existing Windows/Linux profiles, not a universal cache or dependency engine.
See [the comparison decision](adr/0002-separate-build-reuse-from-qualification.md)
and [delivery terminology](../GLOSSARY.md). Packet stages described in that ADR
are the chosen boundary for the later package component, not a new global gate.

Supported finite heavy commands acquire local resources at execution, including
Rust tests/builds, full Vite+ checks, UI suites, advisory Fallow runs and the
Windows Docker adapters. Use those entrypoints concurrently; do not bypass their
guards or terminate another owner's work. `just resource-status` only observes
running/queued records and coverage gaps. Missing records never prove machine idle.
See [shared local resources](#shared-local-resources).

Use `node scripts/checked-git.mts -- <git arguments>` for a checked call, or
`node scripts/checked-git.mts --sequence <owned-json-file>` for dependent calls.
The JSON is an ordered array of argument arrays, for example
`[["rev-parse", "--verify", "HEAD^{tree}"], ["diff", "--check"]]`.
Git receives literal arguments and the first failed exit, timeout or spawn stops
the sequence. Resolve source/target/tree identities before mutation; conflicts
stay visible for explicit resolution. Other PowerShell callers still check each
native exit immediately.

Retain raw JSON, then use `node scripts/report-summary.mts KIND FILE`
to inspect decision-relevant fields within 16 KiB, with omission counts and raw
evidence references. `--help`/usage lists supported report kinds. The `native`
kind shows recorded runner/executable identities, outcomes, selected
checks and gaps. It omits custody trees and does not infer compiled-source,
installed-package or human acceptance from the receipt.
CI summaries accept REST and `gh` job IDs and never claim complete pagination. Delivery watch
retains its existing observations under ignored `work/pr-delivery`; inspect those
snapshots instead of issuing duplicate status queries. Fetch logs for the identified
failed job rather than an entire multi-job workflow. Fallow retains
original analyzer bytes, stderr and source/scope/version metadata below
`work/fallow-reports`; inspect these before requesting another scan. Selected static gates run
before compilation and tests; complete selected and hosted obligations remain.

## Focused validation and bounded delivery reads

Use `just test-ui FILES` for literal test files. It validates every path before
execution and reconciles requested files with Vitest's executed report. A successful
partial match is a failure; skip counts are reported separately. Use
`just test-ui-related FILES` for source files and import-graph coverage instead.
Both routes retain the existing isolation, timing and resource contracts.
Use the literal-file wrapper rather than direct Vitest filename filters, which
can silently accept a partial match.

Read `node scripts/roadmap.mts set --help` for current field flags and values;
command-specific help runs offline without acquiring a live-operation lock.
Use `--summary` on Roadmap context/doctor and Renovate inspection for a retained,
16 KiB projection; it is mutually exclusive with full `--json`. The report-summary
route also supports `renovate` and `ui` reports. Raw evidence is retained before
summary success, and missing retention fails explicitly.

Use `node scripts/pr-delivery.mts inspect --pr N --head SHA --summary` for a bounded
current delivery observation. Optional hashed review/acceptance/watcher references
are described in [contribution conventions](CONTRIBUTION-CONVENTIONS.md#review-and-merge).
Missing or stale references stay unknown; the inspector performs no remote writes
and establishes no new gate or approval authority.

Use one `just pr-watch` per source/run/attempt/deadline binding. Opt into
`--progress` for change-only workflow/check observations on stderr while final
JSON stays on stdout. Repeated unchanged observations remain quiet. Consume the
progress stream live; redirect only stdout when retaining the final JSON result.
Use `node scripts/report-summary.mts watch FILE` for its bounded final summary.
Consume the watch result or retained snapshots; retrieve the identified failed
job when needed.

For agent delivery sessions, use that watcher rather than repeated snapshot reads.
Retain raw reports, then use `report-summary` or project the identity, changed
state and next required action before printing. A collector timeout is an
observation failure: inspect the bound run before deciding whether execution
needs repeating. The personal `github-pull-request-delivery` skill provides
bounded MCP reads and checkpoint helpers when those surfaces are used.
When a tool returns a running session, consume it with a bounded wait of at most
60 seconds before the next commentary update. Reuse its final report; do not
start another watcher or repeatedly fetch unchanged state.

Installed frontend operations resolve the package-declared local Vite+ executable.
The build child filters `TAURI_SIGNING_*`; native signing retains its own inputs.
Provision the declared Node/pnpm and frozen dependencies first. Corepack is an
optional provisioning choice and is not an installed operation prerequisite.

For a dependency-only bundle comparison, use:

`node scripts/frontend-build-compare.mts --baseline ROOT --candidate ROOT --dependency NAME --evidence-root ROOT`

Both inputs must be clean, distinct, nonnested Git checkout roots with equivalent
tracked source/configuration except the declared dependency and its narrow lock
transition. Archives, dirty/ignored source contamination and existing build
outputs are refused. Run install and build in both using the same pinned manager.
The external evidence root retains a unique attempt, heads, input hashes, versions,
command streams and asset inventories. JS and CSS raw/gzip totals stay separate.
Failures and build outputs are preserved; the command never cleans caller roots.

For the retained serde_json engine investigation, use:

`node scripts/renovate-engine-probe.mts --engine ENGINE --workspace INPUT --config renovate.json --observed-at ISO_TIME --evidence-root ROOT`

Supply a complete isolated Cargo input with its pre-update lock and the official
engine matched to `scripts/fixtures/serde-json-renovate-44.156.3.json`. The probe
copies inputs to a unique evidence attempt and checks source hashes, extraction,
preset/lookup Result shapes, effective policy and pending flags before Cargo.
It needs an eligible selected release plus a newer ineligible compatible release
at the explicit clock. Historical clock replay is local evidence, not hosted
uptake. Real registry/artifact observations and synthetic policy boundaries are
labelled separately. Engine/source drift requires fresh capture and adapter
review; missing command records fail. #1973 still needs a naturally occurring
hosted proposal/artifact readback, and full lockfile maintenance remains outside
this scoped transitive-age guarantee.

## Frontend workflow

### TypeScript execution and compatibility files

Maintained first-party code defaults to TypeScript: `.ts`/`.tsx` for bundler
inputs, `.mts` for directly executed ESM tooling, and `.cts` only for an actual
CommonJS consumer. Direct Node tooling runs on the pinned Node baseline without
a loader or build step. Its projects use NodeNext resolution, erasable syntax,
explicit relative runtime extensions, type-only imports and no emit. Browser
application/configuration projects retain bundler resolution; native harnesses
also check the DOM callbacks that Selenium serializes. Node-only tooling does
not receive browser globals. All projects inherit the strict shared policy.

Native harnesses use `apps/desktop/scripts/transport-values.mts` when consuming
complete domain payloads. It validates against the existing Rust-exported output
schemas before exposing their generated types, using the pinned Ajv 2020 loader
without coercion, defaults, property removal or remote schema loading. Schemars
numeric format names remain annotations; exported type and numeric keywords
supply the schema constraints. Core retains semantic validation authority.
Dependency-free repository/bootstrap helpers keep their existing narrow checks.

The normal root Vite+ check discovers each source file's nearest project; these
no-emit projects are independent checker inputs, not declaration-build project
references. The root project checks bundler configurations and the Stylelint
bridge; `apps/desktop` checks application source; `scripts` checks Node tooling;
`apps/desktop/scripts` checks native harnesses and serialized browser callbacks;
`apps/desktop/test` checks browser setup; `integrations/playnite` checks integration
tooling; and `apps/desktop/public` checks the raw theme bootstrap. Keep new files
inside the appropriate includes and verify them through `pnpm check` (the
existing Vite+ static workflow).

CI keeps the complete validation plan and digest as workflow outputs. Child
processes receive the same plan through `PORTCOVE_PLAN_GZIP_BASE64`, bounded to
64 KiB before environment propagation and 1 MiB after inflation. This avoids
Linux's per-environment-string execution limit on repository-wide changes.
Consumers still validate the plan, digest and source bindings; compression is
only transport. Local legacy `PORTCOVE_PLAN_JSON` input remains supported, while
ambiguous transports, corrupt data and excessive inflation are rejected.

The compatibility inventory is exactly:

| File                                     | Consumer requirement                                                                                                                      | Checking and validation                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/desktop/public/theme-bootstrap.js` | Static HTML loads this public script before the application; Vite copies public files without transforming TypeScript.                    | Its public-directory project enables `checkJs`; theme bootstrap tests exercise the actual script. |
| `apps/desktop/stylelint.config.mjs`      | Installed Cosmiconfig 9 rejects `.mts` configuration files. This one-line bridge loads the TypeScript implementation through native Node. | Root `checkJs`, the typed Stylelint configuration and actual `lint:style` execution.              |

The existing CI workflow contract checks this exact tracked JavaScript inventory.
An additional compatibility file requires a concrete consumer reason and an
update here, rather than a general script or test exemption. Historical commands,
checksums and retained evidence keep their original source identities.

Native-helper declarations describe executed dependencies. Their source parser
uses native Node type stripping before the existing restricted import/URL grammar:
whole type-only imports are erased, while retained side-effect imports must still
be declared. Check-reproduction inputs belong to the checked source projects;
an erased type import is not evidence of runtime execution.

Vite+ owns the JavaScript toolchain. The root `vite.config.ts` contains format,
lint, test-project, staged-check and composite-task settings; the desktop config
owns application plugins, dev-server and production-build behavior. The exact
release is in the pnpm catalog. Inspect the resolved bundle with `pnpm exec vp
toolchain`; upgrade the release as a unit using the documented migrator.

With a supported Node runtime and the repository-pinned pnpm, a global `vp` is
optional. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm check
pnpm test
pnpm --dir apps/desktop browser:bootstrap
pnpm test:browser
pnpm build
```

Package scripts resolve the installed local CLI. `pnpm exec vp <command>`
is the explicit route; `node scripts/run-viteplus.mts <command>` also runs the
installed package without a package-manager hop. Node and pnpm are pinned in
`.node-version` and `package.json`. A contributor may choose Corepack during
provisioning. Bootstrap prefers an already provided exact pnpm and uses Corepack
only as an optional provisioning provider. Rust, drivers and other language
tools retain their existing profiles.

In controlled environments, use the official Vite+ installer with `VP_VERSION`
pinned to the catalog release, or the SHA-pinned `setup-vp` action. Keep Node
signature and archive-integrity verification enabled. Global `vp` delegates
project commands to the local release; its Node/package-manager environment
management is optional on contributor machines. Use `vp env current` and
`vp toolchain --global` to distinguish the managed runtime from the project
bundle. Installation must not silently replace a contributor's existing manager
or shell configuration.

VS Code's recommended Vite+ extension pack includes Oxc and Vitest Explorer.
The workspace selects `vitest.rootConfig: "vite.config.ts"`, so discovery uses
the root's `unit`, `browser` and `browser-forced-colors` projects rather than
independently loading the application's production config as another test root.
Vitest Explorer resolves local Vite+ natively; no global `vp` or package-path
override is needed. Individual workspace language overrides select Oxfmt even
when user settings choose another TypeScript formatter. Rust keeps rust-analyzer.

The editor extension launches its own worker. `rootConfig` does not invoke
`scripts/run-viteplus.mts` or acquire Portcove's terminal resource/output guards.
Sequence editor tests with other work against the same checkout; use guarded
package/terminal commands for coordinated execution. Do not inject reservation
variables into editor workers.

`vp dev`, `vp check`, `vp test` and `vp build` are built-ins. `vp run <name>`
selects a configured task or package script. At the workspace root, the ordinary
app dev/build commands select `apps/desktop`; `vp -C apps/desktop <command>` is
explicit. Bare `vp test` runs the Node, browser and small forced-colors projects; browser tests
need the prefetched Chromium shell. `vp test watch --project unit` provides watch feedback. Use `just test-ui`
with literal files for exact Node/browser selection and `just test-ui-related`
for the public import graph. Failed browser
screenshots and traces remain under `.vitest` and `work/bt`.
The trace-probe script deliberately fails and preserves diagnostics.

Browser-session connection has a finite 180-second Windows budget and a
60-second budget elsewhere. This accommodates cold startup on shared Windows
storage; it does not lengthen test assertions or retry failed tests. Retain a
failed connection attempt separately from tests that actually ran.

`vp check` integrates formatting, linting and TypeScript checking. `pnpm check`
first verifies the coordinated installed toolchain and also runs Stylelint. The
shared compiler policy enables strict, exactOptionalPropertyTypes and
noUncheckedIndexedAccess across application TS/TSX, typed tests/fixtures and
runtime-specific configuration projects. There is no narrow strict project or
duplicate compiler task. Native Node scripts and their tests use Node globals
and type-aware lint rules; browser callbacks retain their actual DOM environment. Rust formatting,
Oxlint source policy, Stylelint CSS, localization, deterministic theme tests
and transport contracts retain their distinct responsibilities. `pnpm verify:frontend`
(or `vp run frontend:verify`) composes static checks and the runtime group: content/schema,
Node tests, both browser projects and an ordinary production build, once each.
Package/just/local/audit/CI consumers delegate to this graph. Audit invokes its
static/runtime groups separately for independent failure accounting.

For quick feedback after editing TypeScript, including tests and native harness
fixtures, run `node scripts/run-viteplus.mts check <literal-file> ...` before a
longer behavioral run. This non-rewriting check uses the pinned CLI and existing
analysis-resource admission. Fix reported issues, then run the focused consumer
tests; static success does not establish behavior. Local feedback remains
optional under QUALITY rather than another delivery gate.

CSS starts at `apps/desktop/src/styles/index.css`: Tailwind Preflight and the
standard cascade layers, one CSS token authority, utility-based shared controls,
and narrowly owned artwork CSS. Oxfmt class sorting reads that entry. Tailwind
generates utilities; Vite's full Lightning CSS transformer owns general processing
and minification. Production source exclusions also apply to test/scenario class
names, independently of JavaScript imports. See [the CSS decision record](reference/css-architecture.md)
and [theme contract](THEME.md) before changing this pipeline. Build output checks
consume the current build; cache restoration supplies no new visual/native evidence.

`pnpm test:native-tools` runs the separate Node compiler/shell integration
suites. They require Rust for the Windows probe and PowerShell 7 on Windows (or
the platform shell elsewhere). These integration checks retain qualification
ownership without making the pure frontend unit project require native tools.
The existing Windows qualification lane runs them through Node directly, with
pinned Rust and no frontend dependency installation.

Vite Task owns build execution and restoration. The build adapter first removes
only its ordinary, physically confined `apps/desktop/dist` directory: Task restores
cached files but does not remove unrelated extra output. This preserves Vite's
empty-output behavior. Linked output directories are refused, and failed builds
retain their newly produced output for diagnosis. Native artifact observations
never authorize skipping a task or count as fresh native execution.

Vite Task owns production bundle execution and `dist/**` restoration. Ordinary
`pnpm build` and the Tauri/native verification boundary use that task while
filtering signing inputs. `pnpm build --fresh` forces upstream `--no-cache`.
For a new CPU profile and Vite configuration logs, run from the repository root:

```sh
pnpm build --profile --debug config
```

The adapter accepts only `--fresh`, `--profile [name]`, `--debug [features]` and
`--filter <substring>`; value options also accept `=value`. Profile names are
portable basenames of at most 64 letters, digits, underscores or hyphens, beginning
with a letter or digit, excluding Windows device names (default `build`). Debug features are comma-separated Vite
names/patterns, for example `config,transform` or `*`; bare `--debug` enables all
Vite logs. `--filter` requires `--debug`, for example
`pnpm build --debug config --filter css`. Empty values, duplicate flags, positional
arguments and all other options are rejected. No configuration/root/output override
is forwarded.

Every profile/debug request forces task execution with `--no-cache`, retaining
the signing filter, resource admission, output confinement and supervisor cleanup.
The printed unique `work/frontend-diagnostics/run-*/` directory owns `build.log`
(both child streams) and the requested `<name>.cpuprofile`. Logs go to that file;
failed runs retain their logs and partial outputs. Inspect the log for errors and
load a completed profile into a CPU-profile viewer. An interrupted build may not
finish a profile. Ordinary builds retain their existing caching behavior.

Raw `vp build` does not apply the signing filter. Checks and tests execute fresh;
local/audit UI receipts cannot skip them, and a restored bundle is not a new
native or acceptance observation. Specialized native code fingerprints actual
inputs/outputs without deciding frontend reuse. Cargo still executes because
compiler observations do not seal SDK/system-provider inputs. Inspect upstream
`vp run --last-details` for cache decisions. Cross-run hosted result sharing
remains off; no personal runtime configuration is changed.

`just` remains the cross-language entrypoint for Rust, qualification, source
selection and guarded delivery. It delegates frontend work to this toolchain;
there is no second frontend task graph. Packaged Portcove users need neither
Node nor Vite+. The Tauri frontend-build task strips signing credentials before
launching Vite, while native signing retains its own environment.

## Early commit feedback

The supported Vite+ dispatcher replaces Husky and the repository's preflight
launcher. Dependency installation runs a narrow scope adapter for the supported dispatcher;
run `pnpm hooks:install` to refresh it and `pnpm hooks:status` to inspect it.
Vite+ 1.2 writes hook preferences to common Git config (`--local`). In a
repository with `extensions.worktreeConfig`, the adapter asks that exact local
CLI to generate its dispatcher in an isolated scratch Git directory, then installs
those generated files and writes only this worktree's preferences. It preserves
sibling configuration and explicit disable choices. It owns no staged-file policy. The
project-owned `.vite-hooks/pre-commit` checks staged whitespace, Node test
registration and affected indexed catalog coherence, then runs
`vp staged`. Its standard `vp check --fix` workflow formats, lints and stages
safe fixes while lint-staged's backup and partial-staging isolation remain on.
Review the resulting diff before committing. Required CI and separate review
remain independent gates.

Hook installation captures the stable pinned Node executable in an ignored,
checkout-local launcher. Git hooks and their children use that runtime even when
an editor's Git environment has no Node on PATH. Re-run `pnpm hooks:enable` with
the pinned runtime active after installing or moving it; missing or mismatched
setup refuses the commit with that repair instruction. The installer changes
neither the generated Vite+ dispatcher nor persistent machine/user PATH.

`node scripts/catalog-staged-check.mts --staged` reads the four current catalog
inputs from the Git index. It shares the generator's authoring projection and
independent compatibility expectations, preserves partial staging, and never
regenerates or stages files. Unrelated commits skip this optional local check.

Existing foreign hook managers are preserved by the installer. To replace an
old Portcove Husky hook, inspect `git config --show-origin --get core.hooksPath`,
then explicitly enable `pnpm hooks:enable` in that checkout. In a linked
worktree inspect both common and worktree config scopes: an existing
worktree-specific Husky value can shadow a new common dispatcher. Only replace
the verified Portcove-owned value. Use `pnpm hooks:disable` for a persistent checkout
opt-out; `VP_GIT_HOOKS=0` is a process-scoped opt-out for non-development commits.

The same installed local CLI works in noninteractive editor commits. A failed
check restores the original staged/unstaged state. Preserve any reported recovery
stash after an interrupted or failed restoration. No hook can guarantee cleanup
after power loss or forced termination.

## Coordinated upgrades and rollback

Renovate automatically proposes eligible primary `vite-plus` catalog releases.
The proposal selects an exact target; a primary-only manifest/lock bump is
intentionally not merge-ready. Ordinary `pnpm check` compares the selection,
installed bundle, exact core alias, Vitest, browser provider and catalog-preserving
overrides. React, Tailwind and Playwright retain their independent
reviewed update paths. Security alerts remain visible and follow the same
compatibility discipline.

Complete each proposal through the existing Codex issue/PR delivery process:

1. Refresh proposal head, target, owning issue and actual writers. Select the
   exact supported release from its official notes. Identify and verify the
   pre-proposal base commit and its manifests, catalog and lockfile. Do not run
   the migrator against an already bumped proposal or rely on stale node_modules.
2. Create a clean owned worktree at that verified pre-upgrade commit. Run
   `pnpm install --frozen-lockfile` there. Preserve input/source identities;
   keep the proposal and unrelated checkouts intact, without resetting their work.
3. From that root, run the target migrator before updating project dependencies
   (replace SELECTED_VERSION with the selected exact release):

   `pnpm --package=vite-plus@SELECTED_VERSION dlx vp migrate --no-interactive --no-agent --no-editor --no-hooks`

   Existing Vite+ projects take the upstream version-only migration, not --full.
   Inspect every manifest, catalog, alias and override. Match the directly consumed
   browser provider to the target's bundled Vitest; verify every upgrade even when
   the migrator updates it automatically.

4. Preserve the 1440-minute/non-strict pnpm policy. Remove migrator-added
   minimumReleaseAgeExclude entries for the bundle: non-strict resolution already
   supports an explicit selection. Preserve allowBuilds restrictions and worktree
   hook/signing adapters. Frozen-install, inspect `pnpm exec vp toolchain`, then
   run checks, units/browser tests, build, affected cache/portability checks and
   invalidated native acceptance.
5. Commit the coherent result in that worktree. Integrate it into the owned
   proposal branch through normal Git merge and explicit conflict review; retain
   the verified complete manifest/lock result. Obtain separate non-writing review,
   complete exact-head CI, guarded merge and remote readback.

Repository postUpgradeTasks are not used: arbitrary commands are blocked by
Renovate's default hosting policy, and no administrator allowedCommands support
has been established here. Automatic proposals plus existing Codex delivery need
no paid host, new monitor or persistent coordinator.
`node scripts/viteplus-renovate-probe.mts ENGINE_DIRECTORY` inspects extraction,
resolved presets and ordinary/security rules with the verified 44.156.3 engine.
It is local engine evidence, not a future hosted-proposal observation.

The isolated 1.1.0-to-1.2.0 exercise retained pre-upgrade manifest/lock hashes,
rejected a real primary-only installed proposal, reconstructed a clean workspace
from those inputs, ran the target migrator, and passed compatibility, frozen
install and a runner test. It validates this completion path without waiting
for a release. Consult the [upstream upgrade guide](https://viteplus.dev/guide/upgrade-project)
when the target migrator changes.

Rollback is a normal reviewed Git revert of the migration commits followed by a
frozen install of the restored lockfile. Keep unrelated work and failure evidence.
Do not uninstall machine-wide Node, pnpm, other runtime managers or user data.
If the clone had Vite+ hooks enabled, use `pnpm hooks:disable` and run the restored
hook installer after reinstalling. A global Vite+ install may remain: the restored
project scripts and dependencies own the repository's behavior.

## CI timing diagnostics

Ordinary Rust, frontend and contract jobs publish diagnostic timing artifacts and
bounded job summaries. `PORTCOVE_CI_METRICS_DIR` enables versioned per-phase JSON;
without it the helper writes nothing. Reports retain source/checkout, run/attempt,
job/runner, selected test counts and observed cache outcomes. Setup action timings
remain in the saved job step inventory. Rust's first inventory includes workspace
compilation; filter discovery, selected tests and live transport checks have
separate phases. Measurement does not add another compilation or acceptance gate.

Use `node scripts/ci-metrics.mts summarize DIRECTORY` for downloaded reports.
The delivery watcher records initial queue delay separately from workflow start
through completion of the five required contexts. Missing measurements stay
unavailable. Cache warmth comes from reported restore/reuse outcomes, not attempt
numbers or short duration. Failed diagnostics preserve the original command exit.

Assess the five-minute goal on the next three genuine focused hosted changes with
observed relevant cache hits. Keep cold, broad and unknown-cache observations
separate and link evidence on #1104. Instrumentation delivery alone proves no
hosted speedup.

## Generated GitHub text

Use `node scripts/github-body.mts --help` for guarded file-based issue/PR edits,
comments and PR creation. Issue intake continues through Roadmap. For example:

```powershell
node scripts/github-body.mts issue-edit --target 1685 --body-file work/candidate.md --previous-body-file work/original.md
```

The preimage file must be an exact UTF-8 copy of the fetched remote body. The
helper reads the candidate once, rejects malformed UTF-8, lone CR and unexpected
control characters, then submits structured JSON through stdin and verifies the
returned identity and body. Markdown, Unicode, tabs and LF/CRLF are preserved;
an encoding BOM is consumed. Candidate, preimage, mutation and readback evidence
remain under `work/github-body`. A changed preimage stops the edit; ambiguous
writes require remote reconciliation before any retry. Specification rewrites
still preserve dated linked history through the owning Roadmap workflow.

For generated JavaScript, save an owned `.mjs` file or pass source through stdin.
PowerShell's literal here-string preserves backticks and dollar signs:

```powershell
@'
console.log('Literal `roadmap` and $(text)');
'@ | node --input-type=module
```

For update/scan harness engineering, read [native IPC probes](reference/desktop-ipc-probes.md).

## Bounded GitHub subprocess collection

The shared GitHub API runner limits each ordinary `gh` subprocess to 15 seconds
and 16 MiB of collected output. Timeout terminates that owned subprocess with
`SIGKILL` and refuses its output, even if it contains complete JSON. It reports a
sanitized failure without retrying. These are per-subprocess limits, not a deadline
for an entire paginated inventory. The CI watcher's existing 60-second observation
budget and retained execution deadline remain separate.

A timed-out mutation may already have reached GitHub. Delivery still requires
remote state readback before any retry; unavailable readback remains an unknown
outcome. A local timeout is neither rollback nor proof of server-side failure.
No global GitHub CLI configuration or additional execution authority is required.

## Hosted Cargo dependency validation

The existing Deep audit workflow's `local-check` operation accepts an optional
`dependency_binding` containing canonical compact JSON. Without it, the strict
authority check, including byte-identical `Cargo.lock`, is unchanged. This opt-in
profile supports one independently reviewed registry package update, not changes
to validation policy, tools, features, dependency sources or arbitrary execution.

The binding names `package`, `from_version`, `to_version`, `from_checksum`,
`to_checksum`, `lock_sha256` and `manifests`. Each manifest entry names `path` and
`section` (`dependencies` or `dev-dependencies`). Only the existing release-tools
and desktop Cargo manifests are supported. Full immutable source, comparison
base, merge-base, separate controller and ancestral authority revisions remain
required; a candidate cannot appoint itself authority.

The controller permits only the named existing registry lock record's version
and checksum tokens and the matching simple version tokens in the declared
existing manifest entries. All other repository bytes and regular file modes
must match the trusted authority. Transitive changes, extra paths, renamed or
removed files, features, Git/path dependencies, root manifests, helper changes,
duplicate or ambiguous bindings and lock digest mismatches fail closed. This is
an exact transformation of trusted bytes, not permissive TOML normalization.
The narrow profile rejects multiline TOML strings and noncanonical CRLF inputs
so table-shaped description text cannot be mistaken for a dependency entry.

Preparation validates before provisioning; execution repeats the validation and
digest check before and after literal `just local-check --fresh`. Existing pinned
tools, guarded storage, environment sanitation, read-only job permissions and
owned cleanup remain in force. Logs bind the reviewed dependency data and source
identity to the actual execution. Required checks, independent review and
current-target reconciliation remain separate merge obligations. A later source
or relevant target change does not inherit this receipt automatically.

Changes to this controller require the applicable qualification under [QUALITY](QUALITY.md#required-hosted-baseline) and
independent review. The new dependency profile cannot qualify its own authority
changes or replace required literal locked commands with a broader audit claim.

`just doctor` reads the current host and emits a concise prerequisite report.
Use `just doctor --profile desktop` when native desktop automation is required.
`just doctor --json` emits format version 2: workspace, platform, selected profile,
tools, resolved checkout-cache paths, storage, and Windows compiler candidates.
Required missing or mismatched tools and storage failures return exit 1. Optional
tools do not block readiness. Raw subprocess output and environment variables are
not dumped. The command does not install tools, create output directories, or
modify host configuration. Every missing cached prerequisite includes a safe
bootstrap command in the human-readable or JSON report.

The doctor reads `.node-version`, the repository package-manager declaration, the
Rust quality manifest, `.aqua-version`, `aqua.yaml`, and the PowerShell resource
pin. On Windows it reports MSVC installations and PATH candidates; this is not
proof of Cargo's auto-selected linker. Inspect a verbose native build when
compiler selection matters. Keep each worktree's Cargo target separate and use
the existing development-storage wrapper for heavy commands.

Selective development uses the shared capability map in
`scripts/development-capabilities.mts`. Observe a requested profile with
`just doctor --profile frontend|core|daily|native-desktop`; observation never
acquires tools or dependencies. Existing `standard` and `desktop` defaults retain
their legacy behavior. Profile readiness is prerequisite evidence; it does not
prove a build, test run, fresh execution task, cold acquisition or native session.

| Profile          | Required capabilities                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend`       | Pinned Node and pnpm, installed root and desktop frontend dependencies; Windows/Linux also use pinned rustc and its platform linker for cached process containment.                                                                                                                                                                    |
| `core`           | Pinned Rust/Cargo, rustfmt and Clippy components, pinned cargo-nextest. Direct Cargo development does not require Node, frontend dependencies or Tauri.                                                                                                                                                                                |
| `daily`          | Frontend and Core, Git, PowerShell, pinned Aqua and its verified Ruff/ShellCheck/actionlint payloads, all required Cargo tools from the quality manifest, and PSScriptAnalyzer on Windows.                                                                                                                                             |
| `native-desktop` | Daily plus platform build prerequisites, tauri-driver and the platform driver; Linux also requires Xvfb. Missing or unverified platform capabilities fail this requested profile. Windows observes installed compiler/linker paths; this does not prove Cargo selection. Linux/macOS driver identity remains unverified by this slice. |

Explicitly provision only the requested supported profile with
`./scripts/bootstrap-quality-tools.sh --profile frontend|core|daily` on Linux/macOS,
or `./scripts/bootstrap-quality-tools.ps1 -Profile frontend|core|daily|native-desktop`
on Windows. These setup planners use Node to read the shared map and existing pin
files; this launcher prerequisite does not make Node a prerequisite of direct
Cargo commands. Validation commands that execute Node wrappers still require
Node. Selective profiles cannot be combined with legacy deep/desktop switches.
Frontend setup uses the pinned package-manager declaration and frozen lockfile;
Core setup selects the existing Rust pin/components and cargo-nextest only.
Daily keeps existing Aqua checksum/attestation and Cargo cache boundaries.

Native setup remains platform-scoped: the PowerShell route provisions existing
Windows drivers; the POSIX bootstrap refuses native setup with the existing
approved platform route as its remedy. A platform observation or fixture never
substitutes for actual native qualification. Required missing tools, failed
acquisition and partial profiles return failure; previously verified cache/state
and unrelated shims remain intact. Git and PowerShell must already be available
for daily setup; an unavailable prerequisite remains an explicit limitation.
No ordinary validation command invokes these provisioning routes implicitly.

The active toolchain authorities are `rust-toolchain.toml` for Rust,
`.node-version` for Node, and the repository root `package.json` `packageManager`
field for pnpm. GitHub workflows derive pnpm from that package manifest
instead of copying its version. `scripts/dependency-automation.test.mts` checks
those relationships together with Renovate coverage for nonstandard pins.

The root `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` are the sole
JavaScript workspace and dependency-resolution authorities. Repository-wide
format, lint, and analysis tools are root development dependencies;
`apps/desktop/package.json` remains the product package and owns its runtime
dependencies, package-specific build/test tools, and scripts. The manifests have
disjoint dependency ownership. Install from the repository root with
`pnpm install --frozen-lockfile`. Root commands such as `pnpm
format:check`, `pnpm lint`, `pnpm build`, and `pnpm
test` forward to the desktop package without creating another lockfile.

On Windows, run `./scripts/bootstrap-quality-tools.ps1`. It downloads the exact
Aqua release named by `.aqua-version` from Aqua's official release origin, verifies
the checked-in architecture-specific SHA-256, and provisions checksum-locked Ruff,
actionlint, and ShellCheck versions. Rust quality tools and PSScriptAnalyzer are
also resolved from repository pins. Verified payloads are reused below
`%LOCALAPPDATA%\Portcove\tool-cache`; each checkout receives only small ignored
shims in `work/tool-bin`. The bootstrap requires the `.node-version` runtime to be
active, resolves version-manager junctions to their stable installation, and writes
checkout-local `node`, `corepack`, and exact-pnpm shims together. Repository commands
prepend those shims and set Aqua and PowerShell module paths only for their child
processes. The bootstrap never changes the persistent user or machine `PATH` or
environment.

On Windows, Aqua-backed commands use the pinned cache executable directly after
checking the existing checkout state, archive receipt and reported version. A
stale machine `aqua.exe` cannot bypass the checkout's batch shim through native
process lookup. Missing or mismatched cached inputs fail with the bootstrap
repair command; commands do not install tools or change the persistent `PATH`.

When an Aqua-managed package version changes in `aqua.yaml`, run
`just aqua-integrity-update` before validation. The fixed-purpose updater invokes
the pinned Aqua `update-checksum --prune` command against isolated staged copies,
requires the exact maintained Windows, Linux, Intel macOS and Apple-silicon macOS
asset inventory, and compares every generated package checksum with the matching
GitHub release asset's publisher digest before replacing `aqua-checksums.json`.
It preserves the pinned registry checksum exactly; a registry authority change
fails for separate review. `just aqua-integrity-check` is offline and rejects a
stale version, missing platform, unexpected asset, duplicate identity, or invalid
checksum before tool installation. These commands do not grant Renovate arbitrary
post-upgrade execution or replace Aqua's install-time checksum and attestation
verification.

Routine non-security development-tool proposals are eligible throughout the week
after the existing release-age check, within the four concurrent proposal slots.
Aqua and its managed Ruff, actionlint, and ShellCheck pins are proposed as one
qualification group. Renovate does not independently advance the standard
registry ref: if an actual tool update is unavailable in the pinned registry, or
a compatibility, integrity, or security repair requires a registry change,
advance that ref in the same reviewed change and run the integrity updater above.

Linux and macOS retain `./scripts/bootstrap-quality-tools.sh`. Checkouts share an
Aqua root when `.aqua-version`, `aqua.yaml`, `aqua-checksums.json` and the Aqua
bootstrap data match. The versioned Aqua cache key excludes unrelated package,
Rust quality-tool and desktop-driver inputs; those still invalidate checkout
state and shims through the separate full pin fingerprint. Aqua retains its own
platform-specific package resolution and checksum and publisher-attestation
verification. The cache key identifies inputs; it is not proof of provenance.

The first bootstrap for a new Aqua cache identity requires a successful fully
verified install. Historical cache roots are not imported or adopted, and a
blocked first download or attestation fetch remains a prerequisite failure.
Checkout state must name the matching Aqua root; an old or missing root rejects
the state and directs Windows commands to bootstrap before probing an executable.
A failed download, checksum mismatch, unsupported architecture, partial extraction,
or invalid cached receipt fails closed. Previous verified payloads remain in place.
Run the bootstrap again to reuse Aqua's existing cache hits for matching inputs;
unrelated pin changes no longer select an empty Aqua root.

Run `just fmt-check` for the complete formatting contract, `just check-ui`
for UI build/tests, Oxlint, Fallow, and Stylelint, or `just script-lint` for
Python, shell, workflow, and PowerShell lint as a group. Individual formatter
and linter recipes scan maintained source without rerunning their tool-fixture
self-tests. The exhaustive `check-ui` and `script-lint` aggregates retain those
self-tests through one batched fixture invocation per group.

Use `just fallow` for explicit whole-Desktop qualification, `just fallow-tooling`
to investigate maintained repository JS/TS, `just fallow-review BASE` for a
meaningful branch review, or `just fallow-css` for substantial styling work.
The latter three routes are advisory. The review route uses the real merge-base
and complete relevant candidate diff, including dirty content, renames and
deletions; pass the intended target ref rather than assuming the previous commit.
Share an eligible retained candidate report with the independent reviewer, and
refresh it after relevant content, configuration, base or tool-version changes.
Ordinary fast CI and default focused local feedback remain free of exhaustive
Fallow work. [Fallow operations](reference/quality-operations.md#fallow-scopes-and-policy)
owns the enforcement mapping, evidence inspection and analysis limits.

## Validation tiers and resumable audits

[QUALITY](QUALITY.md#required-hosted-baseline) owns the required hosted baseline,
optional local feedback, qualification selection and receipt rules. This file
owns operation syntax and resource handling. [Development storage](DEVELOPMENT-STORAGE.md)
owns workspace, cache and cleanup operations.

Ordinary command selection and non-receipt execution live in
`scripts/ordinary-validation.mts`; hosted `ci-baseline.mts` consumes that module
directly. `local-validation.mts` owns optional local CLI/preflight and receipt
composition. `validation-evidence.mts` shares conservative inventory,
fingerprint and receipt primitives with the explicit audit; importing ordinary
hosted planning does not load audit or receipt orchestration.

Local receipt runs observe only runtime fields consumed by their selected reusable
domains. Repository-only receipts need Git/just identity and do not probe Cargo,
nextest, rscheck, Aqua, PowerShell or pnpm. Non-reusable-only plans do not collect
receipt inventories/runtime. This changes prerequisites and setup work, not
selection or evidence admission: fingerprints retain every applicable field,
failed stages do not become successful, and explicit audit still inventories all
tools. Explicit transition/release audit routes and hosted provenance fields
remain supported; the consumed #1682 transition is not an ordinary prerequisite.

Use `just local-check --plan` to inspect optional complete-diff feedback,
`--preflight --json` to observe selected prerequisites, and `--fresh` to execute
without local receipts. Use `just audit --plan` for explicit audit selection;
`just audit --fresh` for a required fresh complete audit. Hosted selected routes
still require exact trusted authority/controller revisions; changed authority
cannot qualify itself. See [fixed hosted validation](#fixed-reviewed-hosted-validation)
only when that transport is needed.

### Warm single-session workflow

Pick up the owning specification once, implement with useful focused feedback,
then freeze a coherent commit for separate review and exact-head CI in parallel.
Supply the reviewer exact head/base/diff, relevant acceptance/contracts and known
risks. Repair blocking findings and return the delta/affected interactions to the
same reviewer. [Contribution conventions](CONTRIBUTION-CONVENTIONS.md#review-and-merge)
owns review and merge; [pickup](PROJECT-GOVERNANCE.md#pickup-consumption-and-execution-upkeep)
owns requirement refresh and interrupted-work preservation. Do not add a routine
task-contract matrix or duplicate status narrative.

#### Resume and diagnosis decisions

For changed CLI command definitions or consent text, `just cli-help-check` runs
the existing help-contract regression through the Heavy Rust guard. For Playnite
protocol work, `just playnite-contract-check` builds/checks the C# output and runs
synthetic contracts; supplying both `-Cli <executable>` and `-Library <isolated-root>`
also checks the compiled producer/consumer boundary. It skips lifecycle fixtures
and packaging. `just playnite-check` retains complete fixture qualification and
packaging. These are optional early feedback; required hosted coverage is unchanged.

For retained native/consumer resources and current summaries, use the read-only
[handoff evidence checker](reference/handoff-evidence.md). It verifies references,
not execution ownership or acceptance authority.

Refresh material source/requirements changes and verify actual writers/resources
before overlapping work. Preserve failures and use the smallest discriminating
reproduction. An unchanged retry is not a repair. Historical operation evidence
is [conditional](reference/validation-operations-history.md).

#### Static component scenarios

From the checkout root, run
`node scripts/dev-storage.mts run -- pnpm --dir apps/desktop dev`, then open
`http://127.0.0.1:1420/scenarios.html` in an ordinary browser. The development-only
page offers typed deterministic empty-library, ready-game, missing-source,
missing-tool, staged-update, interrupted-operation, refresh-failure and unavailable
artwork/provider previews. It also includes stable actual-component reference
compositions for a long-title Library, a narrow game-details workspace and a narrow
reviewed installation plan. Each reference renders one active workspace destination;
the installation review overlays the game-details destination. Each records its light/dark theme and
wide/narrow viewport in the rendered markup. Narrow references load the same page
inside a 36-rem iframe so the product's real viewport media queries run in a
genuinely narrow browsing context. It uses actual components and
generated transport types, with the existing test-fixture builders; it is not
another policy backend.

Select a reference in the page or open an exact handoff such as
`http://127.0.0.1:1420/scenarios.html?scenario=installation-review-reference`.
Selection updates the `scenario` query parameter, so an implementer can hand the
same stable ID, theme, size and typed state to a separate reviewer without
recreating fixture setup. The scenario ID identifies the supplied composition; it
does not identify native, packaged or human acceptance evidence.

Previews use React static rendering, not mounting or hydration. Their controls are
inert, callbacks refuse execution, and effects, subscriptions and native operations
do not run. The entry refuses production mode and a Tauri bridge before importing
the scenarios. Vite's production bundle gate rejects scenario modules, shared test
fixtures or the scenario HTML entrypoint. Every scenario names what is simulated.
The unavailable-provider case previews a failure notice, not image decoding; the
interrupted case previews supplied backup recovery state, not a crash. The preview
contains the detail-dialog scrim inline and disables its entrance animation; it
does not reproduce modal focus or overlay behavior.

Edit components/styles through normal Vite reloads and rerun focused tests. This
loop provides static layout/copy feedback without native compilation. It does not
qualify interactions, focus, controllers, IPC, platform or packages; use the native
harness for those obligations. #924's cache and feature-boundary migrations remain
separate work, not implied by these previews.

#### Real-browser component verification

After the frozen pnpm install, explicitly provision the pinned Playwright Chromium
headless shell on the checkout volume:

```powershell
node scripts/dev-storage.mts run -- pnpm --dir apps/desktop browser:bootstrap
node scripts/dev-storage.mts run -- pnpm --dir apps/desktop test:browser
```

`browser:bootstrap` installs only the reviewed Chromium shell and its companions
under `work/browser-cache`, then launches it to verify the result. A warm invocation
rechecks the same artifact. `test:browser` checks the existing binary and never
downloads one. It runs Vitest Browser Mode with a Chromium instance and the
selected bundle's scheduling and timeout defaults. Playwright traces stay in a per-run directory under
`work/bt` when a run fails. Successful runs remove only their own raw
trace directory. Failure screenshots share that invocation's namespace; Vitest
attachments may also remain in `apps/desktop/.vitest`. Both locations are ignored
by Git and retained for diagnosis. Repeated runs preserve earlier failure files.
In CI, the fast and full
frontend lanes run the explicit bootstrap before browser tests and upload failure
artifacts. The intentional failure probe is
`pnpm --dir apps/desktop test:browser:trace-probe`; it exits nonzero and
should be run only when validating trace retention.

The initial browser composition mounts the shipped adoption modal, its review
hook, shared controls, direction provider, styles, and a strict test-only Tauri
transport. Unexpected commands and argument shapes fail, and no real library,
filesystem, credentials, native picker, process, or mutation authority is present.
Node runs pure logic and SSR assertions. DOM components/hooks and the extracted
completion-focus predicate run in actual Chromium; a small separate project
enables forced colors. Standard React rendering/cleanup and renderHook serve
ordinary fixtures, while explicit roots preserve controlled lifetimes, remounts
and same-turn races. Neither jsdom nor its type package is installed.
The static scenario page remains inert. Browser results are not native Tauri,
WebView, controller, operating-system, or package qualification.

## Skills

Repository-local skills under `.agents/skills` progressively load task-specific
execution detail. Each skill resolves the active checkout root before using
paths. General architecture, authority, review, and safety obligations remain in
`AGENTS.md`; skills do not become a parallel implementation or planning authority.

| Skill                           | Load for                                                                   | Do not load merely for                                                                          |
| ------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `portcove-desktop-verification` | Native Desktop interaction or presentation qualification                   | A routine noninteractive UI unit-test edit                                                      |
| `portcove-port-qualification`   | New-port investigation, catalog admission, or lifecycle requalification    | Ordinary product UI work; add `portcove-roadmap` when intake or live Project fields also change |
| `portcove-release-validation`   | Release, package, updater, signing, or protected release-policy validation | Permission to publish, sign, change keys, or widen authority                                    |
| `portcove-roadmap`              | Issue intake, dependency, live Project, or readiness reconciliation        | Product implementation without planning mutations                                               |
| `portcove-daily-discovery`      | Daily incremental native-port research and neutral canonical intake        | Port implementation, catalog admission, release planning or gameplay qualification              |

The daily discovery runner's `plan`, foreground `run` and read-only `status`
commands are documented in [daily investigation](DAILY-PORT-DISCOVERY.md#maintained-runner).
Codex starts `run` with `tty:true` and keeps its returned session open through
explicit `finish`; a noninteractive launch is refused before Git or API work.
The runner retains provider-capacity probes and performs at most one semantic
inventory reconciliation while preserving the original failure and retry limits.

The reusable Windows diagnostics skill is installed in the user's Codex skill
directory and can be used outside Portcove. Keep a repository skill focused:
update its trigger and owning references when behavior changes instead of copying
the same detailed contract into the root instructions.

## Finite acceptance packets

The existing Windows/Linux verification route accepts optional
`--acceptance-bindings-file ABSOLUTE_JSON` for an owning finite qualification.
The same declarations can be supplied in retained, explicitly non-secret
`runner-metadata.json` through the documented low-level route. They name the
actual author/source review, requirements with required scenarios, acceptance
criteria with required image filenames, reusable evidence and visible gaps.
These are execution declarations, not a new universal packet gate.

The harness retains declared inputs before launch. After initial isolated
application readiness and before selected scenarios, it writes
`preflight.json` outside the source checkout, alongside the retained prelaunch
observation. It freezes source/current-target/composed-tree, partial build-input
fingerprint, product artifact identities, declared harness inputs, runtime,
initial fixture identities/state, requirements and scenarios. Runtime bindings
include observed browser/OS/Node versions and the retained public private-X11
receipt where applicable; authentication bytes remain excluded. Original fixture
reads remain protected by the existing cooperative ownership and content checks;
retaining fixture copies does not prove immutable Core consumption. It needs no future
screenshots. The build inventory's incomplete external native SDK coverage
continues to require the normal Cargo build in the build-oriented
`desktop-verify` route; it is not a native cache waiver. The explicit built-product
`desktop-test` route may rerun a changed harness against an existing executable
after review establishes unchanged effective product inputs. Preserve that
product's actual compilation/Cargo-validation revisions and platform-specific
frontend/build provenance, record the new harness head separately, and keep
native SDK completeness and automatic native reuse false. This does not require
restoring another platform's working `dist` or relabeling an older binary as a new build.

After the run, `evidence.json` remains the actual run observation. The existing
`completeAcceptancePacket` helper writes the same format at stage `completed`
only after the canonical run binds the exact preflight and its observed build,
product, harness and execution dependencies, real outcomes, retained artifacts, process-closure evidence,
image-specific inspection, separate outcome review and final delivery bindings
are supplied. Never insert placeholders or treat report reading as image
inspection. Inspect each required PNG itself, rehash it and record reviewer,
time and findings against those exact bytes. Required visuals also bind to their
successful settled capture receipts and their criterion's declared scenario.
Closure uses the existing Windows process inventory/exit receipt or Linux
positive PID-1 namespace join; an arbitrary artifact and caller flag are insufficient.
Missing images, failed mandatory setup, required gaps, failed,
skipped or unsupported outcomes cannot become qualification success. Preserve
failed evidence and the original preflight; a packet does not confer acceptance,
merge authority or permission to change its own verifier.

`reusableAcceptanceScenarios` compares effective product, harness, runtime,
fixture, state, requirements and criteria bindings. Product changes invalidate
product-dependent observations; harness changes invalidate scenarios using those
inputs; runtime/display/fixture/criteria changes invalidate their observations.
The bounded profiles conservatively rerun the selected affected set when a
shared binding changes. Missing/ambiguous bindings require requalification.
Documentation-only source changes may retain fully bound evidence while exact
source-head CI remains required. Reuse references a previous completed packet
and the unchanged evidence bytes, preserving its original execution source and
time. Historical version-2 acceptance is not retroactively subjected to this
format or granted earlier custody by a later copy.

Keep the existing fresh current-target/composed-tree review and trusted guarded
delivery route. A changed target requires an explicit reviewed qualification
decision; candidate declarations cannot waive required acceptance or protected
pre-change qualification. Retain one existing exact-head watcher and compact
change-driven progress. At finite completion, summarize already-observed build
reuse, deduplicated bytes, affected reruns and removed duplicate steps without
creating a benchmark or numerical gate.

## Bounded native readiness and private Linux execution

`captureSettledVisual` requires a scenario, intended target and caller-specific
semantic readiness. The connected-folder completion journey uses it for each
required image. Within the same deadline, two consecutive semantic/viewport/target
observations must match before its single candidate screenshot. This waits for
layout transitions; a later change still fails capture. It records state before
and after PNG capture, retains and hashes the exact image, then publishes the
capture receipt. Loading, offscreen targets, changed state, timeouts and retention
failures produce diagnostic evidence; they cannot publish an accepted capture.
Other legacy diagnostic screenshots retain their existing scope.

The test-only `apps/desktop/test/capture-target.ts` preflight is shared by the
browser adapter and selected native keyboard captures. Callers identify a single
target, scroll it into view, and require two unchanged observations within a finite
budget. Visual capture accepts decorative `aria-hidden` content while refusing
hidden/transparent ancestors, ancestor overflow clipping, zero area and targets
outside the viewport. Semantic readiness retains its own checks. Oversized panels
cannot supply a complete-panel image: capture identified title/actions instead.
Vitest annotations retain bounded JSON geometry/outcome attachments for successful
and refused browser captures. Ordinary hosted browser diagnostics retain annotation
JSON and the selected capture PNGs for seven days on success and failure through
the existing artifact upload. Native adapters retain successful geometry through
`captureSettledVisual` and refused preflight observations in bounded failure
receipts, preserving the original failure and existing receipt. Actual pixel inspection and journey assertions remain
separate obligations. These helpers are excluded from production imports.

Controller capability receipts distinguish API absence, access failure/restriction,
no exposed device and exposed-device inventory. The exact opt-in
`native-controller-api-fallback` declares absence/restriction as fallback coverage.
It cannot satisfy controller functionality. `native-controller-large-list` still
requires actual injected behavior and an available API; no physical-controller
qualification is added. Device exposure alone is not a physical observation.

The standalone Linux `native-linux-webview-origin-boundary` scenario explicitly
selects `native-compatibility-qualification`; it is excluded from ordinary profiles.
Use the existing native harness and private-X11 route below with that feature build,
without a capability overlay. An owned loopback page is created before launch;
the embedded qualification driver uses the separately checked harness port plus
two. Actual Tauri metadata identifies WebKit handles. Secondary, remote and
same-label remote-main requests must reach their expected IPC guards, followed
by a healthy local-main return with the same library identity and generation.
This fixture establishes no ordinary-package, media-device, updater or minimum
environment claim. Its listener stays owned until native cleanup joins.

`node scripts/desktop-linux-x11.mts --config ABSOLUTE_JSON` reuses the
ext4/private authenticated virtual-X11 route. On Windows it holds the existing
Windows native slot and Heavy Rust guard while dispatching existing Ubuntu tools;
Linux holds its own native slot and maintained PID namespace/init controls.
Stages `gtk` and `harness` permit selected diagnostics without running a whole
journey. A version-1 configuration declares existing absolute `xvfb`, `xkbcomp`,
`output_root` and `harness_args`; Windows dispatch additionally requires existing
absolute Linux `node` and `tool_cache` paths. It installs nothing.

The parent binds its actual ordinary caller UID to the bootstrap namespace map;
public configuration cannot supply that binding. The inner application UID/map
remains 1000-to-0. A different host UID needs its own actual runtime observation.
For example:

```json
{
  "format_version": 1,
  "stage": "gtk",
  "xvfb": "/existing/Xvfb",
  "xkbcomp": "/existing/xkbcomp",
  "output_root": "/owned/ext4/evidence",
  "harness_args": [],
  "node": "/existing/node",
  "tool_cache": "/existing/tool-cache"
}
```

Use `stage: "harness"` with the existing `desktop-test` arguments for the selected
scenario. Keep outputs fresh and isolated. Runtime receipts exclude the private
X11 cookie and its file identity. Positive current namespace joins are required;
unknown closure retains guards instead of reclaiming another process. The route
preserves GTK chooser ownership checks. It establishes only actual GTK/WebKit on
that private virtual display; WSLg, physical display/controller and other Linux
routes remain separate. Missing or unsupported prerequisites are reported; no
provisioning or fallback qualification is implied.

For ordinary Linux shipping boundaries, select only
`native-linux-packaged-webview-boundary` and pass `--package-evidence ABSOLUTE_JSON`.
The maintained private-X11 route also requires an installed Google Chrome at
`/usr/bin/google-chrome`. It creates a desktop association and explicit fresh
browser profile inside its owned XDG directories, retains browser/opener identities,
and observes the approved destination through the real browser's profile-bound
DevTools endpoint. Chrome keeps its normal sandbox. This observation covers that
isolated association; the host's ordinary default-browser configuration remains
separate. Existing personal browser profiles are not selected. The owned profile
also retains a default-redaction network log with a 4 MB size budget and ten-second
capture for failed-navigation diagnosis; it is not destination acceptance.
The manifest binds the current source, exact ordinary
`pnpm --dir apps/desktop desktop:build --bundles deb` command, empty qualification features,
package and configuration identities, and the actual `dpkg-deb --extract` receipt
with its `usr/bin/portcove-desktop` identity. This route uses the existing native
PID namespace and requires positive join before releasing custody. It observes
the extracted DEB payload; it supplies no system installation, updater or
claimed-minimum evidence. Windows current-installed NSIS acceptance keeps its
separate existing route.

Only this standalone Linux packaged case uses WebKit's nonautomation `WebPage`
inspector transport. WebKitGTK 2.50.4's automation session can grant media before
the application's normal permission callback, so a WebDriver media result cannot
qualify that refusal. The maintained native namespace launches the ordinary
executable directly with a loopback-only `WEBKIT_INSPECTOR_HTTP_SERVER` child
environment; `TAURI_WEBVIEW_AUTOMATION` and the legacy inspector variable are
absent. No production feature, CSP or permission override is added. Other native
scenarios keep their existing driver routes.

For ordinary Linux development continuity, run exact standalone
`native-preparation-cancellation` and `native-linux-interrupted-preparation`
selections with the normal WebDriver transport. Both use the maintained private
PID namespace and positive namespace join. The cancellation selection retains
the existing renderer reload, same Core operation identity and actual UI cancel
observations. The interruption selection requires a live owned preparation,
invalidates its WebDriver session without deleting it, closes the namespace
init's private control pipe and waits for successful join before fresh startup
against the same owned library. It records the retained activity, workspace,
doctor repair item, cleanup preview and hashes of the owned source, runtime and
save. It never writes a product process-quiescence flag: uncertain Core proof
must still refuse cleanup with manual review. This is forced namespace teardown,
not an application-only kill, graceful close, OS shutdown, installed package or
minimum Linux environment claim. No qualification feature is required.

The existing manual `Native design compatibility` workflow also offers the fixed
`linux-preparation-continuity` operation on the standard `ubuntu-22.04` runner in
this public repository. It builds ordinary app/CLI artifacts in a fresh target,
compiles the owned probe, and runs both exact scenarios sequentially through the
same private-X11 adapter. Its private input store is outside the checkout under
the runner's temporary directory. Failed observations, exact report/image bytes
and their original-name/hash inventory use the existing bounded job-log codec;
there are no artifact uploads or caches. Collection excludes private profiles,
display cookies, retained executables and complete input payloads. Source and
binary identities remain recorded in the actual build and native reports.
Its hosted result remains distinct from local Windows/WSL or minimum-OS proof.

Before executing the unchanged boundary assertions, the observer requires the
listener's live PID/generation, executable digest and owned namespace ancestry,
one advertised page target, the actual local main document and
`navigator.webdriver === false`. WebKit `Runtime.awaitPromise` preserves the
ten-second script deadline and callback failure; expired replies cannot satisfy
a later operation. The final listener recheck and ordinary native namespace join
remain distinct evidence. Inspector discovery or evaluation failure is a failed
prerequisite, never a permission refusal or a package pass.

The existing manual `native-design-compatibility.yml` workflow also offers the
fixed `linux-package-boundary` operation on standard `ubuntu-22.04` only. After
review and ordinary candidate CI, it prepares the distribution's matching
`linux-modules-extra` Vivid capture-only webcam and a foreground private PulseAudio
null source. The [Linux 6.8 driver contract](https://www.kernel.org/doc/html/v6.8/admin-guide/media/vivid.html#configuring-the-driver)
defines the single webcam node; its supported 640×360 format replaces the failed
DKMS loopback fixture. The outer mapped-user probe is preparation evidence.
The fixed internal media launcher repeats the bounded positive reads inside the
application's final user/mount/PID namespace immediately before spawning the
ordinary executable, with no intervening namespace or credential change. Its
readiness receipt records namespace links, UID/GID maps, credentials and
device/socket identities for the wrapper and app. Application start ticks,
namespace IDs and executable hash must also match the live inspector listener
before any application assertion. Missing or mismatched readiness fails
admission. The existing namespace init owns both descendants; final join evidence
does not imply normal application or wrapper exit.
Existing devices, missing matching modules, module/signature refusal or unknown
process joins stop qualification; no custom kernel, reboot, key enrollment or WebKit
permission override is used. Only the operation's identified quiescent fixture
may be removed. This route supplies no physical capture, installed GUI or minimum
claim, and a ready fixture alone does not satisfy the strict media refusal.

## Native desktop smoke tests

For the normal Codex and maintainer workflow, start with a non-launching plan and
then run the smallest useful selection:

```powershell
just desktop-verify --plan
just desktop-verify --scenario keyboard-layout
just desktop-verify --scenario native-design-system-compatibility
just desktop-verify --scenario keyboard-layout --scenario accessibility
just desktop-verify --profile presentation
```

`just desktop-verify --scenario native-saved-folder-hash-resume --require-clean`
selects one standalone
Windows journey outside routine profiles. An isolated first-party CLI seeds a
saved root and a hash-limited batch of two inert inputs. Desktop continues the
same bounded scan, preserves the earlier match, freshly reviews the newly found
input, and cancels without registration, acquisition or original-file changes.
The receipt binds the actual executables, source, screenshots and positive
owned-process closure. This case does not establish native picker, setup
execution, gameplay, physical storage or Linux acceptance.

`just desktop-verify --scenario native-selected-setup-completion --require-clean`
selects the standalone owned-input journey on Windows: bounded two-port
review, actual individual installation cancellation/retry and inert preparation,
return context, complete game/BIOS review and saved-input restart. On Linux, the
existing low-level `just desktop-test` route selects the same scenario with
explicit compiled app, CLI, owned probe and verified Tauri/WebKit drivers in a
new isolated output directory. Bind the clean source and actual runtime/build
identities before that launch; a failed legacy desktop doctor remains failed.
The GTK/WebKit route requires the existing desktop SDK/drivers and permitted private
user/PID/mount namespaces. Each driver launch has an owned PID1 control wrapper;
private EOF stops that init, and a launch-bound Ready identity plus a normal
`unshare` join proves descendant closure before restart. Signaled or unknown
joins retain the fixture and the owning native slot for custody resolution;
they never qualify through procfs disappearance or a numeric host-PID kill.
Runtime/helper identities and failed evidence remain in the receipt directory.
This is scoped native fixture acceptance, without gameplay, physical-storage or
shipping-package claims. The separate saved-folder selected-review scenario is
also available on these two platforms.

`just desktop-verify --scenario native-preliminary-selected-setup --require-clean`
selects an isolated Windows journey for the missing NotRun continuation. The
fixture uses the maintained pinned-validator selection contract with an owned
inert release. Real Core discovery and deliberate current-location registration
make the preliminary input eligible for bounded setup selection. The journey
checks the warning, fresh Core setup review, neutral cancellation and return
with selection preserved. No validator, preparation, acquisition, gameplay,
physical-storage or Linux execution is claimed. The existing preliminary
review-only scenario remains separately selectable.

With no selector, `desktop-verify` uses the `smoke` profile. Exact `--scenario`
flags are repeatable and mutually exclusive with `--profile`; selection is normalized
in catalog order. The pure `scripts/desktop-execution-plan.mts` supplies fixture
requirements, build features, initial receipt sources and ordered family entries.
The harness consumes that order after workspace refresh/history and before reload;
its existing scenario attempt remains responsible for dependency gating and
selected/setup attribution. Preparation retains its nested traversal and browser
reassignment. The coordinator obtains the current browser at each family call.
Use `--list-scenarios`
to see stable IDs, descriptions, profile membership, prerequisites and host-impact
metadata. `--plan --json` and `--list-scenarios --json` provide machine-readable
output without building or launching. Their serialized format remains unchanged.
The independently reviewed pre-change oracle in
`scripts/testdata/desktop-execution-baseline.json` is pinned to main
`a9e3db4e6cd9fd41111b58705e4fa54790eb57d7`; its 222 cases cover selection,
admission, receipt source order and verifier serialization with inert adapters.
It is not native acceptance. Preserve its provenance rather than deriving expected
results from the planner. Runtime receipt inputs remain with their existing owners;
the harness hashes current bytes, including the planner and coordinator helpers.

`just desktop-verify --scenario native-startup-library-recovery --require-clean`
selects one Windows-only initial-startup recovery journey, outside every routine
profile. It seeds isolated saved preferences pointing to an owned regular file,
observes the real recovery screen, cancels and reopens the native library picker,
selects an owned usable library, then restarts the application to verify the saved
choice. The invocation library override is absent in both hosts. Per-host process
identities, positive cleanup, immutable fixture copies, preference preservation,
generation-bound IPC and screenshots are retained; host generations are evaluated
independently after restart. It does not reset the platform default, open a normal
user library, or establish another platform or physical controller claim.

`just desktop-verify --scenario native-startup-network-diagnostic --require-clean`
is a standalone Windows diagnostic outside ordinary profiles. It makes one
explicit read-only native auth-status call, retains only success or an allowlisted
error code, counts existing error banners, and verifies unchanged ready library
identity, root and generation. It uses the ordinary isolated scope, three-minute
watchdog and identity-bound owned-process cleanup; it starts no install fixture
or game and changes no credentials. Normal application startup/background calls
remain unchanged. Completion means diagnostic coverage, even when the observed
network call fails. It proves neither historical banner attribution nor a causal
repair, healthy network, or a product acceptance pass. Transport/identity failures
retain the incomplete coverage phase without raw errors or automatic retries.

`just desktop-verify --scenario native-startup-preferences-recovery --require-clean`
selects one Windows-only saved-preferences failure and recovery journey, outside
routine profiles. It retains malformed preferences and player-data before copies,
checks the actual startup diagnostics and absence of the normal workspace, and
proves owned host-tree exit before externally repairing only the fixture's saved
choice. Two independent restarts check the usable workspace, saved selection,
library identity and player data. The failed-startup screen keeps its main landmark and announces the failure in
the error paragraph, with native accessibility evidence retained.
Technical labels retain their exact spelling while wrapping within their column;
the scenario checks actual label/value separation and requires no unresolved
accessibility items on the observed failure screen.
This is explicit external repair acceptance; it does not prove automatic repair
or platform-default reset. Existing startup
picker and library-switch scenarios still prohibit fixture rewrites on restart.

Selected Steam-entry and game-update reviews seed their own installed port through
the existing owned CLI/core fixture route. Like backup review, they do not first
run the full preparation-and-Play journey. The `full` profile still includes that
journey, and continuity scenarios keep their real dependencies. Owned-fixture
selections register their scenario callers in a context preflight before frontend
or Tauri compilation; a missing required Steam review member such as `open` fails
there before any browser action. This preflight is a wiring check, not native
qualification.

`native-design-system-compatibility` is deliberately exact-selection-only. It
builds the isolated foundation fixture and exercises actual generated styles,
both themes, bundled assets, nested Dialog/Select portals, topmost-first Escape,
focus restoration, and reduced motion. It does not enter `smoke`, scheduled work,
or routine pull-request checks. The ordinary production build rejects the fixture
from emitted assets.

The manual **Native design compatibility** workflow is the narrow exception for
isolated hosted Linux and macOS observations. Linux continues to use the existing
Tauri/WebKitWebDriver harness. macOS builds the app with the explicit
`native-compatibility-qualification` Cargo feature and separate Tauri capability,
then connects the existing Selenium client to WebdriverIO's official embedded
driver. The feature, capability, and HTTP driver
server are absent from ordinary builds. Each dispatch names one current hosted
runner and retains its exact revision, host identity, WebView identity, screenshot,
and result. It has no pull-request, push, schedule, publication, signing, or paid
service trigger. A hosted current-runner pass does not establish a historical or
claimed minimum.

For an unavailable minimum-version host or Steam Deck, build the candidate at the
exact revision with `VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE=1`, retain the
desktop executable/package and source revision, then run the same exact scenario
through the platform route above. Record the artifact SHA-256, OS/architecture,
WebView engine/version and result. Record initial-beta Windows and ordinary Linux negative/minimum evidence gaps
under #993. Preserve macOS CI/build and bounded architecture compatibility work;
full Intel/Apple Silicon platform observations belong to #45/#226 during beta
before 1.0, using appropriate native/hosted routes without owner-operated hardware. Steam Deck/SteamOS procedure
preparation and actual-device evidence gaps belong to #51/#217 for the Public beta
follow-up, Required before 1.0; they consume the shared engine baseline without
becoming #993 initial-beta closure conditions. Do not stop fixture development or
turn missing evidence into a pass.

The curated profiles are:

- `smoke`: native bootstrap/error recovery, keyboard/compact layout, isolated
  application-update preference persistence and updater-state recovery, appearance
  restart, accessibility, injected controller, expanded navigation, workspace
  refresh, and a reviewed install cancelled during a streamed fixture download.
- `presentation`: empty-library, keyboard, isolated application-update preferences
  and recovery, accessibility, controller and expanded navigation presentation checks.
- `restart`: appearance restart and workspace refresh. Positive `--reload-cycles`
  opts this and other profiles into the repeated reload probe.
- `artwork`: owned local artwork and the real native file picker.
- `owned-lifecycle`: external CLI-to-Desktop reconciliation plus reviewed preparation,
  readiness, recovery, settings, channel, backup/removal, source/adoption,
  library-move and CLI-handoff scenarios.
- `full`: smoke, owned lifecycle and artwork. It remains a curated native suite,
  not universal desktop, physical-device, gameplay or human qualification.

Run staged-update composition separately from preparation journeys: its saved
update deliberately remains staged, while preparation verifies an unstaged
fixture preimage. Library layout and preparation cancellation also require
separate fresh libraries because they use different JakII runtime modes. The
planner rejects these pairs, including prerequisite closure, before launch;
ordinary profiles remain unchanged. Do not activate/delete staged evidence or
overwrite fixture modes to combine them. Layout measurement reloads after its
fixture commits and waits for both exact rendered entries before measuring.

Selections containing reviewed backup restore/delete use the finite ten-minute
lifecycle watchdog even in a small focused chain. The three-minute allowance
proved insufficient for preparation, game return and the native backup reviews;
per-action waits and cleanup remain unchanged. Watchdog expiry records an explicit
failed check before stopping the owned driver. Game-return evidence includes
timestamped pre-click, post-click and settled focus/busy/scroll observations; it
waits for readback exclusion to settle without focusing the origin or relaxing
the original focus, connected-control, query/filter and scroll assertions.

`--scenario native-host-publication-recovery` is a standalone instrumented Windows
journey at existing Core install, restore, whole-library move and import checkpoints. It
uses the existing `qualification-fixtures` build feature; ordinary builds keep
`NoLifecycleFaults` and do not read checkpoint controls. The harness owns a fresh
`.qualification-lifecycle` directory beside its library, outside every transfer
payload. Its bounded, nonce-bound `armed.json` selects one exact canonical-equivalent
library root and one finite checkpoint. Core publishes an exclusive observation
marker, then waits at most 120 seconds for an explicit matching release; invalid
controls, collisions and expired waits fail qualification. The marker cannot
authorize operation recovery or process termination.

The same instrumented observer supports `launch_ready_to_spawn` immediately
before Core rechecks retained external-runtime inputs and creates the child.
A qualification harness can change only its own disposable input after the
observation, release the exact nonce and assert a real pre-spawn refusal. This
does not authorize a child process, alter production deadlines or establish
normal exit/gameplay; ordinary builds still ignore checkpoint controls.

The five cases observe install Prepared, install payload Published, restore
Prepared, whole-library move Published and whole-library import Published. Install payload publication precedes
SQLite registration; it is not a post-database-commit crash. Each case independently
matches its real journal/phase and current application identity before forcing
only the captured app tree to exit, without deleting the WebDriver session or
requesting graceful shutdown. Positive application and remaining-driver joins
precede control disarming and fresh startup. Assertions cover committed install
identity, original data and archives, verified restore plus its safety backup,
the move's recovery gate and offered Resume action, one redirected writable
library, and preservation of newer destination saves across repeated recovery.
Import Published instead has a succeeded activity and matching publication receipt;
the imported destination can already open after forced host loss. The harness
explicitly restarts that destination and uses supported bookkeeping recovery to
archive the journal while preserving a newer save and the export inputs. It does
not claim automatic journal archival or an unfinished mutation at that boundary.
The opt-in harness budget is 720 seconds instead of the generic single-scenario
180 seconds to contain five bounded checkpoints, joins and fresh hosts. Product
cancellation, shutdown, lock and network deadlines remain unchanged. The separate
Core import Published observer runs only in the fifth case. These are
instrumented fixture process-loss observations, not OS shutdown, installed-release
or Linux qualification; preserve failed or incomplete captures separately.

`--scenario native-real-prepared-runtime` is an opt-in standalone Windows journey
for the two selected real user-prepared definitions, `dkc3-recomp` and
`wave-race-64-racewave46`. Set `PORTCOVE_REAL_RUNTIME_INPUTS` to an absolute JSON
file containing `format_version: 2` and
`packages` with exactly those two `port_id` values and absolute `source`, `directory` and
`archive` paths. Each source profile and argument extension comes from Core's catalog;
the two games may use different originals. Archives must match the normal catalog's size and SHA-256.
The bounded regular-file inventory rejects linked paths, copies source and
runtime bytes into the fresh owned output, and records original identities.
The production CLI verifies source and runtime eligibility; no fixture catalog
or qualification feature supplies permission. Desktop then reviews native
folder selection, cancellation, consent, registration, read-only revalidation,
restart/readback, actual launch and ordinary game close, and registration-only
removal. Exact child and supervisor identities establish their positive exits.
Preservation checks allow the definition's game-owned mutable paths while
requiring unchanged immutable runtime bytes, originals and source copies;
registration removal preserves the complete postgame inventory. Failure cleanup
can signal only a separately captured, verified game process tree. This journey
does not establish human gameplay, an installed package, Linux qualification or
catalog support admission. Keep any earlier failed receipts and their limits.

`--scenario native-direct-preparation-recovery` is an opt-in Windows journey
through a real failed owned setup child. Its original source/runtime inputs and
active installation remain unchanged; the actual Core failure supplies the
affected preparation target. The direct error opens that game's existing
detail review after navigation, with the same activity inventory and no repeated
preparation. This is native debug/owned-fixture evidence, not an unfamiliar
upstream failure, installed-release observation or host interruption.

`--scenario native-late-listener-disposal` is a standalone Windows qualification
of actual native operation-listener lifetime during one live Core preparation.
After a renderer reload, two UI-reviewed owned-folder selections have only their
bridge input redirected to the current owned root. Core returns its real
generation changes while retaining the worker; no response or generation is
invented. The probe delays delivery of one completed native listen response
across the second owner remount, then observes the exact native unlisten and
callback removal while the current owner's listener remains registered.
The same preparation ID is cancelled through the current UI and its original
inputs and durable recovery outcome are checked. This controlled bridge-input
and response-delay proof is not a natural library move, transport rejection,
Linux observation, or operating-system shutdown. It is excluded from ordinary
profiles; uncertain interception cleanup invalidates the session.

`--scenario native-host-interrupted-preparation` is an opt-in Windows proof:
an owned setup child reaches its live checkpoint, the identified harness tree
is forcibly terminated without first deleting the WebDriver session, and a new
native host performs recovery. The run checks source, original executable,
active-install and save preservation, retained staging, recovered activity and
cleanup refusal when durable process quiescence is unknown. It does not rewrite
the recovery journal. The existing `native-interrupted-preparation-recovery`
remains a separate synthetic durable-state and reviewed-cleanup test. Neither
scenario proves OS shutdown, another operation family, installed packages or
another platform.

`--scenario native-minimized-preparation-continuity` separately qualifies one
owned live Windows preparation completing while the actual native window is
minimized, then restoring current ready state without duplicate work. It uses
real WebDriver window commands, the existing permitted native minimized-state
read and renderer visibility; unsupported commands or contradictory readback
leave this row unproven. A separate live process snapshot preserves the worker
identity without replacing the final cleanup inventory. The fixture's natural
30-second completion and the three-minute harness bound remain unchanged.
Source, original executable and saves must survive; successful preparation may
legitimately activate a new installation. This is not suppressed-event, shutdown,
installed-package, minimum-OS or other-platform qualification.

The runner performs the desktop doctor and storage preflight, verifies that the
pinned Selenium workspace package resolves, builds or exactly reuses the frontend
with embedded assets, asks Cargo to validate/reuse the Tauri application, builds the CLI/probe only for owned-fixture
scenarios, chooses unused consecutive driver ports, acquires the shared native
session lock, creates a fresh run directory under
`PORTCOVE_OUTPUT_DIR/desktop-verify`, and prints the retained evidence path. It
never installs packages or provisions drivers. Follow the reported bootstrap or
frozen-install remedy when a prerequisite is missing. Use `--require-clean` for
final evidence; dirty source is allowed and recorded during iteration.

Before acquiring its own native session lease or building, `desktop-verify`
executes the installed package's declared Vite+ executable with `--version`,
using the same launcher, Desktop cwd and signing-filtered environment as
`build-frontend.mts`. The observed version must match its installed package
metadata; workspace package readiness separately checks the declared graph.
A ten-second deadline and 16 KiB per-stream cap bound the probe. The fresh
run directory retains `frontend-command-preflight.json` even on failure.
Corepack and a global Vite+ are not operation prerequisites. Cached tool metadata
cannot substitute for this command.
`--plan` reports command-file availability and an unobserved version without
executing Vite+, installing packages or acquiring a lease. An inherited caller
lease remains the caller's responsibility.

Direct desktop verification resolves the checkout and Cargo target output keys
together before build admission. Nested Rust/browser phases validate the inherited
reservation; an outer caller that reserved only one output is refused rather than
upgraded. Physical aliases share one key. Doctor and build/harness commands use
the same checkout tool environment, and doctor runs before the native-session
lease. Missing prerequisites retain diagnostics and the normal explicit bootstrap
remedy; verification does not provision tools. Help, scenario listing and planning
do not acquire capacity or a native lease.

Native plans selecting `qualification-fixtures` list and run the existing Core
checkpoint tests before frontend and application builds. The selected inventory
must be nonempty, unique and fully executed without skips. This is scoped native
feedback, not a new qualification requirement for ordinary changes.

The optional Vite+ pre-commit hook also checks Node-test registration when relevant
tests or inventory inputs are staged. It uses the same coverage assertion as CI,
reading the Git index so unstaged workflow/recipe edits cannot conceal an
incomplete commit. It does not modify either tree; the normal Vite+ staged
formatting and partial-staging behavior follows only after that check succeeds.

Native helper dependencies are declared in
`scripts/native-helper-dependencies.mts`. Literal PowerShell dot-source imports
and wrapper imports are checked against the declaration (using the Windows
PowerShell parser for dot-source enumeration). Missing, escaping, dynamic or
undeclared imports fail. The harness captures deduplicated actual helper byte
identities before launch, including conditional dependencies, and retains them
in failed receipts. Format-2 historical receipts remain unchanged; declaration
coverage proves captured source inputs, not execution of every helper branch.

Frontend reuse is fail closed. A platform/architecture-specific record under the
configured temporary directory hashes every declared Vite input, the exact Node
and pnpm versions, all `VITE_`, `TAURI_`, and `NODE_ENV` inputs, and every byte in
`apps/desktop/dist`. Missing, malformed, linked, added, removed, or changed inputs
or outputs run the normal frontend build and replace the disposable record only
after success. An exact match leaves `dist` untouched so a harness-only or
catalog-only rerun does not manufacture a Tauri relink. Cargo still runs on every
verification and remains the native dependency/build authority; the selected
native scenarios always execute in a fresh evidence directory. The run metadata
records whether frontend bytes were rebuilt or reused, while source revision and
`--require-clean` evidence remain independent and unchanged.

Every native run can take focus and send input. The shared lock serializes
Portcove qualification runners across worktrees, but it cannot prevent unrelated
user input. Announce the foreground run and establish an uncontended window.
Malformed or live lock ownership is never removed; a valid lock is reclaimed only
when its recorded PID is positively absent and the owning operation proves quiescence; unknown native ownership is retained.

When the native runner reports a live owner, treat that as resource contention,
not a harness timeout: preserve the report, continue noninteractive work, wait for
the named runner to finish, and rerun the same exact scenario or profile. There is
no lock override. A watchdog timeout after acquisition is a separate failed run
and follows the retained-evidence diagnosis in the desktop-verification skill.

Focused and small-profile runs retain the three-minute whole-harness watchdog.
The opt-in Windows `native-library-switch-recovery` scenario uses only owned
libraries and saved preferences. Real folder selection and review first commit a
recognizable SQLite library with a future schema; refusal retains the Core-owned
summary and exposes the redacted schema reason/version through user-opened technical
details. It must retain the active workspace, identity, saved choice and fixture
database/player-marker bytes, with natural trigger focus before disclosure and an
accessibility capture. A subsequent healthy selection
and independent host restart must retain the new saved choice. Both process trees
use the existing identity-bound, root-inclusive positive-exit checks. The scenario
does not open the real platform-default library, redirect Windows known folders,
or establish installed-package, physical-input or platform-default-reset evidence.
Owned-lifecycle and full sequences use a bounded ten-minute watchdog because they
compose more than eight independently bounded scenarios; this does not change any
scenario's operation, UI wait, confirmation or process-shutdown timeout.

Windows native `Wait` keeps the captured identity inventory unchanged. When a
protected process hides its .NET start time, readable CIM creation time may prove
that the PID now belongs to a different incarnation. Values within one millisecond
remain ambiguous because the providers can differ in precision. Missing CIM
metadata, an inaccessible same-incarnation image or unknown identity fails closed;
it never establishes exit or permits termination. Only the existing exact-identity
path can wait for a still-matching process. This fallback changes no stop mode or
lease-release requirement.

For low-level harness diagnosis, the existing command remains available:

Run `./scripts/bootstrap-quality-tools.ps1 -Desktop` to cache pinned
`tauri-driver` and, on Windows, detect the installed WebView2 runtime and provision
the corresponding Microsoft EdgeDriver. The bootstrap verifies the reported
driver/runtime version and Microsoft's Authenticode signature. Ambiguous runtime
discovery or any verification failure is fatal. Linux needs WebKitWebDriver and a
graphical session.
The external driver path adds no automation plugin to the product. Native macOS
execution is not supported by this harness.
The pinned Selenium client connects to the explicitly started driver server;
the harness does not invoke Selenium Manager or provision browsers automatically.

Build the frontend and a desktop binary with embedded assets using the storage
wrapper (`pnpm --dir apps/desktop build`, then `cargo build -p portcove-desktop
--features tauri/custom-protocol`). A plain debug build expects a Vite server and
cannot establish the packaged-assets smoke claim. Then run:

```powershell
just desktop-test --app <absolute-desktop-executable> --output <new-absolute-directory>
```

Cached drivers are the default. Explicit absolute `--driver` and `--native-driver`
overrides remain available for controlled qualification. The output parent must
already exist. `--port` defaults to 4444 and the native
driver uses the following port; choose unused ports. The new output directory
contains an isolated library, host and application-update state files, WebView2 profile on Windows,
screenshots, bounded driver logs, accessibility results and `evidence.json`.
Never reuse a failed run directory or point this harness at an existing library.

The native harness opens application windows, takes focus and sends keyboard
input in the current desktop session. Its isolated files do not isolate the
keyboard or pointer. Run it in a dedicated graphical session or an agreed window
when the desktop is not in use. If concurrent input interferes, retain the failed
evidence and defer the native rerun; background unit tests and builds can continue.
Do not qualify a native run from a session with uncontrolled input.

To exercise explicit preparation, additionally pass `--preparation-cli
<absolute-CLI-executable> --preparation-tool <absolute-owned-probe>`. Build the CLI
from the same source and compile the repository's
`crates/portcove-core/src/testdata/host_tool_probe.rs.txt` with `rustc --edition=2024 --crate-name
portcove_host_tool_fixture -o <absolute-owned-probe>`. These optional scenarios
adopt copies of that redistributable fixture into the new test library, register
synthetic sources, review and confirm preparation through the actual UI, exercise
Play without setup, and cancel an active native setup through the UI. They do not
acquire upstream artifacts or establish game compatibility. CLI/tool hashes and
the additional harness source are retained in the evidence inputs.

The cancellation scenario navigates away while owned preparation is running,
reconnects to the durable activity and requests cancellation there, then navigates
away and returns after the terminal outcome. It restarts the renderer before
verifying the retained setup log through CLI and Tauri, rejects stale-library log
reads, opens both output streams in the activity view, and exports a redacted
support bundle. Its dependent interruption scenario uses real core startup recovery
to produce the distinct failed/attention state, then verifies the actionable failed
row and incomplete phase capture after navigation and again after renderer restart.
Incomplete capture and quota behavior are separate core fixtures. These logs
contain owned synthetic output, not evidence of actual game compatibility, a
physical process crash or resumable preparation.

The owned readiness scenario temporarily omits one prepared fixture's assessment
from the renderer's actual status responses. It verifies disabled Play and Continue
routing to review, while the CLI independently confirms unchanged launch counts
and positive core readiness. Restoring actual responses restores Play. This is a
synthetic transport-omission check, not evidence that core emits missing readiness.
The harness records the injection, restoration, accessibility scan, and screenshot.

The optional interruption scenario deliberately resets only its owned test
activity to the durable state preceding a terminal update. Node's built-in SQLite
API is confined to a separate fixture module, whose hash is included in the run's
inputs. A fresh CLI then executes real core recovery; Tauri and the native UI
must show the same retained failure and incomplete log. The fixture verifies
that an unconfirmed cancellation is not reported as successful and that the
active installation remains unchanged. This is simulated durable interruption
with native adapter observation, not a physical process-crash qualification.

The same owned fixture also checks the desktop's game-update settings: changing
a selection stays local until Save, and saving leaves active/staged/previous
installations and the activity ledger unchanged. This does not download a game
update or establish live upstream update compatibility.

The optional native channel scenario checks Ghostship's read-only channel and
re:Blue's explicit Stable/Rolling selection, rejects stale library requests, and
verifies persistence after frontend restart. Selecting a different channel may
request reviewed upstream release metadata; it never downloads or installs game
artifacts. Failed metadata retrieval remains separate from a saved channel.

The smoke scenarios exercise native IPC/bootstrap, an empty library, a rejected
operation with usable state afterward, keyboard focus/compact layout, appearance
persistence over a real process restart, automated accessibility checks, one
reviewed install cancellation, and a committed-install refresh failure. The install
scenarios build a qualification-feature binary, create a checksum-pinned artifact
and catalog copy inside the fresh run,
serves only that artifact from an ephemeral loopback address, and records the exact
request, cancellation, staging absence and successful fresh-review retry. The
second synthetic port proves a committed install remains successful while immediate
workspace reads are temporarily unavailable, retains the last view as explicitly
stale, and retries the workspace read without repeating install review, download
or install mutation. A separate generation-bound orphan discovery can occur
during the retry observation; the harness records it separately from the install.
The
qualification feature accepts only an absolute catalog file and loopback HTTP URL;
default and shipping binaries ignore the fixture variable and continue to require
HTTPS direct manifests. The fixture proves native progress/cancellation and safe
retry plus refresh recovery, not upstream availability, game compatibility,
gameplay or human acceptance.
Core/component tests and human acceptance remain separate. An incomplete report is
not full desktop qualification.

Windows restart checks capture the exact driver-owned application and child
process identities before closing the session. Before reusing its WebView profile,
the harness waits at most five seconds for those processes to exit; it never kills
them to satisfy the check. Process IDs with different creation times are treated
as exited identities. `just development-tools` exercises live-process timeout,
later exit, stale identity and ambiguous discovery using owned Windows processes;
these platform-specific tests are explicitly skipped on other hosts.

Owned-process discovery validates creation times at every parent link, including
the selected driver. A parent created after its apparent child cannot establish
ownership. Missing timestamps and cycles cannot establish
ancestry; equal timestamps remain valid for the operating system's time
resolution. Only exactly one matching application permits native confirmation
or shutdown observation. Refusals report matching/descendant counts and missing
image-path counts without guessing ownership. The regression fixtures model
stale parent references independently from the live-process checks; they do not
claim to reproduce an observed operating-system PID reuse. This follows the
[Windows parent-process identity contract](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process).

Direct embedded-application snapshot refusals identify the first failed parent,
creation-time, executable-path or hash check. Diagnostics omit command arguments,
environment and file paths. Rejection publishes no snapshot and grants no cleanup
authority; it does not establish the cause of an earlier generic identity failure.

For bounded diagnosis, `--restart-cycles 1..10` repeats the actual process restart
and records preference persistence and shutdown observations. `--reload-cycles
0..25` optionally adds repeated renderer reloads and concurrent read-only native
requests matching the five ordinary library refresh calls. It records the first
failed batch without retrying it. The defaults remain one restart and no extra
reload probe, within the existing three-minute harness deadline. Partial reports
and failed runs remain evidence; a later pass does not establish a root-cause fix.

`development-evidence.mts` writes format version 2 observations with a full
revision, executable hash, method, selected/setup/excluded scenario inventories,
cycle counts, source cleanliness, phase timings, explicit gaps, qualification
completeness, scenario outcomes and hashed artifact references. Setup needed to
create isolated fixture state is recorded separately and never counted as a
selected scenario pass. It never overwrites a report. Artifact references are
local paths; retain the directory when handing off results. The revision is source
context, not proof an externally supplied executable was built from that revision.

## Rust test runner

Use `just rust-test` and the cargo-nextest version pinned in the existing quality
manifest. The standard wrapper prepares native test fixtures and retains the
repository's scheduling configuration; doctests run in Cargo separately. Do not
duplicate this orchestration in a skill or a competing recipe. Record cold
compilation separately from warm test execution when comparing performance.

The wrapper reuses only its unchanged compiled host-tool probe and containment
supervisor. It keeps those products below the current worktree's Cargo target,
keyed by exact source, compiler/sysroot/resolved-tool bytes, target, arguments,
and relevant compiler environment. Cache entries and fresh copies are verified
by bytes and mode; candidates publish atomically, corrupt or interrupted entries
are rejected, and only eight identities per product are retained. Every run
still allocates a new temporary fixture root and executes fresh nextest,
containment, mutation, process, and cleanup evidence. `[rust-support]` lines name
the product, `built` or `hit` outcome, short fingerprint, and preparation time.
They are preparation provenance, never a test pass or authorization record.

The wrapper owns one shared-host heavyweight Rust-validation slot across Portcove
worktrees. Supported local-check and aggregate recipes acquire it before each
expensive Cargo check, Clippy, nextest, or doctest process, so compiler work from
one worktree cannot starve another worktree's timed tests. The lock is released
between those stages; formatting, JavaScript/UI tests, research, editing, and
review remain concurrent. The wrapper publishes complete lock metadata atomically, records an owned
containment supervisor, and only then opens the supervisor's launch gate for the
pinned exact command. Linux prepares the first-party adopting reaper through the
existing source/compiler/flags/platform/environment-bound support cache. The
reaper is the wrapper's direct child and becomes a subreaper before launching a
Node child in its own process group. A private handshake binds that child's birth
identity, parent and group before registration; its launch gate still precedes
the guarded payload. The wrapper monitors and reaps the helper while registering
the separate Node group. The wrapper channel accepts an anonymous pipe or a connected
Unix stream socket whose peer matches the wrapper PID and supplied birth identity.
Readable EOF closes the group; unexpected bytes fail closed. Wrapper pipe loss
closes that anchored group; reaper pipe
loss makes the Node supervisor close its own group without inventing a receipt.
The reaper stays outside the killed group, drains direct and adopted children, and
publishes an atomic positive receipt only after actual group absence and completed
reaping, within the existing five-second cleanup bound. A failed, missing or late
receipt, failed handshake or failed reaper exit preserves ownership and the
invocation's original evidence directory. Other Unix hosts retain the detached
group and out-of-group watchdog; Windows retains the kill-on-close Job Object.
A new acquirer still requires valid cleanup evidence before reclaiming a dead
wrapper and supervisor. Nested inherited commands stay inside that existing containment.
Ctrl-C and termination requests close the owned outer containment and return the
conventional 130 or 143 status; signal listeners are removed after the command.
It refuses to overlap a matching live owner and waits up to 60 minutes by default,
separately from every test or command execution deadline. It reports the owner's
PID, workspace, command, start time, and monotonic queued time immediately and
every 30 seconds, then reports acquisition. Live-owner identity is polled every
five seconds rather than launching four probes per second. Each Windows or
Darwin identity probe uses repository-required PowerShell 7 and separately fails closed after five seconds, so it cannot
hang indefinitely but can add one bounded probe interval to the polling limit.
`PORTCOVE_HEAVY_RUST_WAIT_MS` may select a shorter explicit admission limit from
`0` through `3600000` milliseconds; this changes only queue waiting, not any
nextest, Node, product, cancellation, or cleanup deadline. A wrapper failure does not make a
still-running recorded supervisor stale, registration failure cannot launch the
guarded command, and cleanup evidence proves the detached Unix process group or
Windows Job Object has closed. Any survivors are
terminated by that containment; failure to prove quiescence retains the lock rather
than admitting overlap. PID reuse does not transfer
ownership because the exact supervisor identity must also match. Legacy numeric
descendant records are never reclaimed automatically. Darwin uses a
per-process title marker for the wrapper and a launch-environment marker for the
nextest supervisor rather than its second-resolution displayed start time. The
previous timestamp identity remains readable only to classify and migrate a
legacy lock record during this transition.

For a local timeout or apparent stall, run the supported recipe once and keep its
owner/elapsed diagnostics. Queue waiting is not test execution: leave a live
owner in place, or cancel only the queued command with Ctrl-C if other work is
more useful. If the finite admission limit expires, ownership is unreadable, or
cleanup cannot prove quiescence, preserve the exact message and inspect the named
PID/workspace before retrying. When the recorded containment is not proven
quiescent, preserve the lock and report the missing exit/cleanup evidence; do not
keep rerunning expensive checks while that condition remains false. Do not kill
another worker or use direct Cargo/nextest to evade admission.

Correctly engineered manual recovery is permitted when the maintained route
cannot interpret a task-owned damaged record or represent independently proven
quiescence. Follow [owned resource recovery](reference/owned-resource-recovery.md):
prove ownership and exit, preserve exact preimages, coordinate with the actual
acquirer, validate and independently review the bounded mutator, and verify its
readback before resuming through the normal guard. A verified later host boot can
prove earlier processes have exited; age or an absent PID alone cannot. Retaining
a malformed leaf is not permission to clear foreign records, invent a cleanup
receipt or claim the interrupted command passed. Existing task authority covers
this necessary recovery; a missing automatic route alone does not require
another permission request.

At a real safe checkpoint before an authorized environment replacement, use the
existing source and evidence channels to preserve the essential continuation:
exact commits, branches/refs and uncommitted work; current ownership and
current qualification boundary; and the original acceptance/failure evidence
referenced by that work, including incident identities, locks and receipts.
Verify newly preserved originals incrementally by identity, checksum and readback;
retain earlier verified evidence at its original scope instead of bulk-exporting
everything at every checkpoint. Reproducible dependencies, build outputs and
caches are distinct from irreplaceable source and evidence. Unreferenced optional
historical payload can remain on the retained host with its access limitation
reported. Missing essential evidence remains unknown; record its exact gap and
resume condition on the owning issue/PR under the preservation requirement. An authentication/export
failure belongs to the existing platform channel, not a credential workaround or
a new backup service. Keep the failed host and its originals intact; a fresh
environment and a repaired supervisor do not turn its old cleanup into success.
Even a successful managed-payload receipt does not prove the outer adopting helper
was reaped by a non-reaping PID1 after whole-wrapper loss.

After admission, diagnose any nextest timeout as a
separate per-test failure and retain its run ID and last completed phase.
Direct Cargo commands are outside this guard, as are native desktop sessions,
which retain their separate focus-taking lock and evidence rules. `--prepare-only`
compiles the hosted fixture without taking the local heavyweight slot because it
does not execute nextest.

## Targeted safety experiments

The core property tests generate archive-path aliases and digest/scope combinations.
Run `cargo test -p portcove-core --lib property_` through the storage wrapper.
For diagnostic coverage, `cargo-llvm-cov` 0.9.1 and the pinned Rust toolchain's
`llvm-tools-preview` component support `cargo llvm-cov test -p portcove-core --lib
--lcov --output-path outputs/property-coverage.lcov property_`. This intentionally
scoped report is not a whole-project coverage score or a new acceptance threshold.

Use the existing mutation tool on a disposable source snapshot with isolated
build output. Windows source copying can fail on frontend dependency symlinks;
an archive of the reviewed Git tree avoids copying those dependencies. A bounded
digest-identity mutation is useful evidence that these assertions detect an
incorrect match; it does not establish mutation coverage for the whole core.

## Unattended execution

Subscription-backed scheduled tasks are not, by themselves, an isolated
engineering controller. They inherit app permissions. Do not schedule candidate
execution with full host access or rely on skill prose to restrict its commands.
Issue #284 owns the separate feasibility/authority proof. No paid API fallback,
credential migration, signing permission or standing merge authority is implied
by these development tools.

The owned preparation harness also exercises backup restore/deletion reviews with
synthetic saved data in its isolated library. It verifies review dismissal,
stale library generation, data changed after review, safety-backup contents,
selected-only deletion, preserved current data/other backups/install identity,
and accessibility of both review dialogs. These are native automated backup
lifecycle observations, not gameplay or human comprehension evidence.

The subsequent owned removal scenario reviews all installed versions, dismisses
without deleting, introduces another real adopted version to reject stale intent,
and rejects an otherwise-valid removal in an old library generation. It then
removes the freshly reviewed paths through the native UI and verifies preserved
saved data, backup contents, source references and bytes, adoption originals and
another game's installation. It records accessibility, a screenshot and exact
removed/preserved identities. Physical interruption remains separate core fault
and platform qualification evidence.

The backup/removal native confirmation scenarios currently require Windows. Their
bounded UI Automation helper selects exactly one application with the reviewed
executable path, verifies its ancestry under this harness's live driver, and only
interacts with the expected title, target text and enabled button. It records the
observed native dialog and tests that renderer application alone leaves the files
unchanged, cancellation preserves them, and explicit native consent admits core
authorization. It changes no product confirmation behavior or test bypass setting.
Other platforms need their own native confirmation observation before qualification.

The owned source-removal scenario uses Settings to review installed-game impact,
cancel both detailed and native consent without removing a reference, reject a
changed registration and old library generation, then remove the freshly reviewed
reference. It verifies unchanged original/replacement bytes, saves, backup content,
other references and the installed game. The same run re-exercises backup and
installed-game reviews through their shared presentation lifecycle. Native Windows
confirmation evidence remains scoped separately from other physical platforms.

The source-intake scenario verifies the registered source's Game Files activity
link when that record is in the eight-item recent preview. In a long combined
run, it asserts the older registration remains in durable activity history but
outside the preview, then verifies the newly recorded discovery activity's Game
Files link. The focused native run exercises the registration link directly.

The owned adoption review scenario copies a harmless fixture through the real
native UI. It verifies exact source/output/saved-data paths, dismissal and pending
or declined native consent, changed saved-data rejection and stale generation.
Confirmed copying replaces matching saved files while preserving the original,
unrelated saves, prior installation, backups, sources and another game. It records
accessibility and compact layout evidence. It establishes no gameplay or physical
interruption claim; existing core publication-recovery fixtures remain separate.

The final owned-library handoff scenario seeds and selects a separate harness-owned
library, then moves it through Settings. Earlier preparation journals remain intact
in their original test library; their required recovery is never bypassed. Before
copying, it checks the recorded installation and source-location consequences,
opens the saved-data inventory, and verifies an exact owned filename in the
compact review. It checks preserved originals, matching saved-data copies, stable active
installation identity, unchanged source references and an advanced desktop library
generation. A prior-generation request is rejected, while the new generation reads
the verified destination. CLI and Tauri identity reads must match before and after
the move, including the redirected old root. The core record canonicalizes its
location so Windows extended-length path spelling does not create adapter drift.
Its accessibility and native evidence remain distinct
from core interruption and physical-platform qualification.

The owned artwork scenario opens the actual Windows file picker, cancels without
changing a choice, selects a generated local PNG independently for cover/detail,
and resets only the cover. The same bounded native-dialog helper may populate the
exact file-name field only in this artwork picker, using a fixture below the new
test output directory. It checks stale library/slot requests, rendered letterboxing,
compact long-title layout, keyboard opening and picker focus return. Temporarily
withholding the owned managed original must retain its choice and leave ordinary
status reads usable; restoring it, clearing thumbnails and restarting the renderer
must rediscover the authoritative selection. The combined smoke harness is bounded
to three minutes. These are automated native observations, not human comprehension,
physical controller ergonomics or artwork-rights evidence.
For bounded artwork debugging, add `--artwork-only` with the same owned CLI/tool
inputs. Its evidence method is `native-artwork-smoke`; it runs the startup checks
and artwork scenario without the other preparation/review scenarios. It does not
replace the combined native regression run at completion.

The native navigation-copy scenario opens the command palette with the actual
host keyboard shortcut, checks keyboard hints and the generic controller-hint
presentation, then expands its labels by approximately 35% at 125% text size.
It checks the compact dialog and its controls for horizontal clipping and captures
a screenshot and accessibility report. The controller input-mode and expanded
strings are explicit presentation fixtures; they do not establish physical button
mapping, translated-language quality or screen-reader comprehension. Component
tests separately observe the progress live region across repeated count updates:
only the phase text changes there, while readable counts remain outside it.

Unknown presentation-state fixtures exercise source results, digest algorithms,
installation actions, destination ownership/availability and activity/update-policy
labels. They use unfamiliar values (including inherited JavaScript property names)
at the renderer boundary. Unrecognized results must remain explicit and neutral;
an unsupported installation plan offers another review, and destination changes
require an explicitly recognized ownership state before offering Apply. These
fixtures do not change core admission policy or claim that current typed core
outputs emit those future values. Core still validates every mutation and stale
review; ordinary known-state behavior remains part of the native regression.

`pnpm --dir apps/desktop test:copy` exercises the static-copy checker and complete
count-message formatter. The ordinary UI test command also runs the checker.
Count messages provide full zero, plural-category and unknown variants, with
number formatting in the selected message language (currently English by default).
Invalid, fractional or unsafe counts select the unknown message. Relocation copy
keeps pending cleanup explicit even when its recorded old-folder list is empty.
Fixtures cover large counts, unavailable counts and additional plural categories;
they do not claim that translated application content has been supplied or that
all existing copy has been migrated to the formatter.

Workspace refresh fixtures cover failed initial loads, retained snapshots, explicit
retry, out-of-order responses, event-triggered failures and separate operation
outcomes. The native smoke also injects one rejected catalog response into its
owned renderer, then uses real native IPC for the explicit retry. It checks the
stale-information notice, retained cards, accessible error surface, restored focus
and absence of repeated mutation commands. The interception is restored in
`finally`, and partial observations are retained. This proves presentation
recovery for a synthetic failure; it does not reproduce or repair an underlying
SQLite locking failure.

### Command-line handoff verification

The command details surface binds the effective library and names the shell whose
syntax it displays (PowerShell 7 on Windows, sh/bash elsewhere). Missing standalone
CLI or original-file paths remain explicit templates. Program path and argument
array are also available separately; a terminal command is not a launcher argument
field. Native discovery does not execute or attest the CLI it finds.

Run `pnpm --dir apps/desktop test:cli-handoff` for the focused checks.
The host shell test sends spaces, apostrophes, Unicode, literal substitution syntax,
metacharacters, empty values and trailing separators to a harmless Node process,
then compares its actual argument vector. Component tests cover missing inputs,
clipboard failure and a late response from another library. Quoting follows the
[PowerShell quoting rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-7.6)
and [POSIX-style single quoting](https://www.gnu.org/software/bash/manual/html_node/Single-Quotes.html).

### Isolated cover cache observation

`just desktop-verify --scenario native-default-cover-cache-conditions --require-clean`
uses the real catalog and a fresh isolated library. It requires the artwork cache
actually be empty before first cover navigation, verifies accepted cached image
hashes, then restarts the same executable with only its child process proxy
environment pointing to a local refusal fixture. The fixture never forwards
traffic or records headers, credential values or request paths. All mapped covers
must render from cached bytes; one removed cache entry must produce actual
rejected backend IGDB traffic and a generated fallback without erasing its mapping.
The exact retained cache bytes are restored while the app is stopped. This live
CDN scenario is opt-in and excluded from ordinary offline profiles. It proves
native development-app display and cache behavior, not installed-package updates,
production content publication, physical devices or human comprehension.

`--scenario native-normal-package-webview-boundary` is an opt-in Windows
ordinary-package case through the existing external Tauri/EdgeDriver route.
Use low-level `desktop-test.mts --app <retained-installed-executable> --output
<new-absolute-directory> --scenario native-normal-package-webview-boundary
--package-evidence <absolute-manifest>`. The manifest binds the clean candidate
revision, exact admitted `pnpm --dir apps/desktop desktop:build --bundles nsis` invocation,
empty qualification-feature list, hashes of the normal Tauri configuration,
Windows overlay and Desktop Cargo manifest, installer, and completed
`test-windows-installer.ps1` evidence. Its retained executable must match the
installed hash. Produce it through the maintained launcher:

```text
just desktop-test --prepare-retained-package --output <new-absolute-external-directory>
just desktop-test --finalize-retained-package --output <completed-absolute-directory>
```

Preparation requires a clean Windows checkout and a new output directory outside
the checkout and Cargo target. It builds an ordinary unsigned NSIS package without
qualification features or signing/configuration overrides, copies the installer
and raw executable under the build lease, then releases that lease before isolated
install/smoke/persistent-data-preservation/uninstall under native admission. Original
process logs, doctor, configuration and file identities remain in that directory.
The resulting `ordinary-package-manifest.json` passes the existing verifier and
binds separate raw UNK, bundled NSS and retained installed executable identities.
The installer script remains the underlying installation mechanism.

Finalization is file-only recovery for a completed original run: it verifies file
bindings, unique bundle-marker substitution and the strict existing package
contract, then writes only missing derived manifest/result files. An unchanged
repeat performs no writes; conflicting or incomplete evidence is preserved and
refused. It never builds, installs, runs a doctor, invokes Git, acquires resources
or changes Registry state. Preserve a failed preparation directory and its logs;
finalization does not turn an incomplete installation into acceptance.

Shared main-window assertions check application-origin assets and legitimate
IPC, unavailable qualification commands, actual inline CSP violation, browser
permission denials and native diagnostics, refused owned-loopback/inactive-origin
navigation and popup requests, and returned-main IPC. Identity-bound root and
descendant exit receipts cover final/failure/watchdog cleanup. This is execution
of retained installed bytes after the isolated installer route, not current
installed-context, signed production, minimum-version or all-platform evidence.
Refused navigation does not prove privileged invocation after remote execution;
earlier instrumented secondary/queued-reply controls remain separate evidence.

For the distinct current-installed Windows case, use the fixed existing launcher:
`just desktop-test --current-installed --installer <absolute-nsis> --package-evidence
<absolute-ordinary-build-manifest> --expected-app <absolute-built-executable>
--expected-version <version> --test-base <absolute-isolated-base> --evidence
<new-absolute-installer-receipt>`. It obtains the existing native desktop lock
and verifies desktop packages, pinned tools and drivers before invoking the
fixed `test-windows-installer.ps1` route. The installer requires that inherited
admission, bound to the same inputs and live owner, before any Registry mutation;
calling its opt-in parameter directly does not bypass preflight. The build manifest has the
same clean revision, exact ordinary build command, empty qualification features,
configuration and installer identities described above. The route verifies those
inputs before installation. It invokes the fixed existing boundary harness after
the installed smoke has closed, while the exact current-user registration and
installed executable remain present, then requires positive owned exit evidence,
the same registration/version and executable/uninstaller bytes, and unchanged
isolated persistent data before uninstall. It does not accept an arbitrary
callback or replace the retained-byte scenario.

The exclusive `.native-doctor.json` receipt alongside the installer evidence
retains tool preflight results, including failed preflight before installation.
The admission receipt retains successful preflight and exact input bindings.
The new sibling `current-installed-boundary` directory retains the immutable
pre-boundary installation receipt, bound package manifest and native evidence.
Its explicit `current-installed` mode accepts only the pre-uninstall receipt;
a completed post-uninstall receipt cannot supply that claim. The final ordinary
installer receipt links the native evidence and its subsequent preservation and
uninstall result. Failure or unproven owned exit stops before uninstall and
retains the isolated installation/journal for the existing recovery procedure.
This supplies only the actual tested unsigned Windows package/current OS row,
not production authority, minimum Windows, another platform or whole #1280/#993.

The same boundary scenario also submits a fixed unreviewed HTTPS `.invalid`
URL and an unknown source-evidence ID through actual main-window IPC. Each
must return its specific structured link-guard code and message; a missing
command, unavailable library or unsupported catalog cannot count as refusal.
Ready bootstrap, generation, selection, library identity and main URL must
remain unchanged across each refusal, with subsequent legitimate IPC working.
This qualifies negative link controls only. It does not establish delivery of
an approved link in the external browser or trust for another webview context.

The boundary scenario also submits one fixed, valid local secondary-window
request through `plugin:webview|create_webview_window`. Before attempting it,
actual window and webview inventories must contain only `main`, with a ready
library, working identity IPC and the established locale. The pinned Tauri
2.11.6 ordinary release must return the command-specific `not allowed by ACL`
refusal; debug-only permission descriptions, missing commands and unrelated
errors cannot satisfy this assertion. Every post-attempt context, locale,
window and webview observation is retained independently, including failed
reads and unexpected creation results. All successful observations must remain
unchanged. ACL rejection precedes option decoding, so this proves refusal of a
validly constructed creation request, not runtime argument validation or IPC
from an executed hostile secondary context. Package/native acceptance still
requires a fresh source and installed-byte binding; these assertions do not
complete the other #1280/#993 platform, browser-delivery or hostile-context rows.

WebView2 documents that cancelled `NavigationStarting` can still issue GET
requests while the host responds. The boundary case records every owned server
request and requires the popup destination to receive none; it does not promise
network silence for cancelled navigation. Native refusal, the preserved main
URL/assets, absent remote fixture execution marker and returned-main IPC establish
context containment. See the [Microsoft cancellation contract](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2navigationstartingeventargs?view=webview2-1.0.4129.50).

### Fixed reviewed hosted validation

Hosted preflight refusal diagnostics identify the rejected condition and retain
bounded child-result facts before preserving the original failure. New telemetry
uses an allowlisted projection, at most 64 KiB of final UTF-8 output including its
prefix and newline. Oversize projections are explicitly omitted; interrupted
captures are marked incomplete. Unknown strings contribute only type, byte count
and SHA-256, never raw output, arbitrary error messages, arguments or environment
values. Diagnostic serialization or logging failure cannot replace the refusal.
Successful selection, provisioning, commands, profiles and execution limits are
unchanged; rejection never starts browser acquisition or validation.

Cargo observation failures retain structured spawn/exit/JSON/inventory facts in
the existing `planning-blocked` report, with no selected plan and exit one. Only
observation mode uses the existing 15-second, offline, locked metadata call; normal
metadata selection retains its execution contract. Unrecognized causes remain
unknown. These diagnostics neither establish a cold-cache cause nor authorize
dependency acquisition, a retry, protected-controller adoption or acceptance.
Previously discarded child output cannot be reconstructed by this repair.

These disclosure rules apply to the new telemetry. Existing inherited stderr,
CLI error printing and parsed `selected-plan.json` retention are separate output
boundaries; the diagnostic projection does not promise whole-job redaction.

For Cloud hosts lacking native build SDKs, use the separately reviewed manual
operations in `native-design-compatibility.yml` after exact source-bound admission.
Keep the existing hosted local-check authority refusal intact. Supply
`operation`, `execution_binding` and `execution_binding_sha256`; no shell command
is a workflow input. Binding format1 names source/controller/base/merge-base/authority,
complete inventory SHA-256, hosted-plan digest, and complete baseline/selected
obligation inventories. Generate the candidate-root structured inventory with
`just local-check --preflight --json`; prerequisite observations are not execution.
Review the baseline obligations independently under the current [QUALITY policy](QUALITY.md#required-hosted-baseline).

`bootstrap` runs `just local-check --fresh` and `just audit --fresh` in separate jobs;
`selected` runs fresh selected validation, `compiled` runs the complete maintained
`pnpm --dir apps/desktop test:adapter-conformance` command, and
`qualification-history` runs the one explicit Linux normal-app native scenario.
`candidate-consumer` runs the existing selected, compiled and history jobs on an
independently admitted exact composition of the reviewed controller and four
unchanged A16 product paths, before controller merge. It remains execution under
test; it supplies neither controller trust nor bootstrap's separate complete audit.
The separately reviewed adapter harness is bound through the exact source and full
inventory; unrelated executable changes remain refused. A controller candidate's
bootstrap result is validation evidence, not a self-issued trust or merge grant.

Use the supported decoded GitHub job-log connector to retrieve retained byte records;
verify run/attempt/job/source, recover with the existing codec and inspect real PNGs.
See [hosted acceptance](NATIVE-HOSTED-ACCEPTANCE.md) for allocations, identity and
composition requirements, honest platform/fixture limits and recovery commands.

## Optional Windows Docker tooling

The optional [browser adapter](reference/docker-browser-tooling.md) stages an
exact selected commit for browser tests. The separate optional
[Linux builder](reference/docker-linux-build.md) uses the same owned Windows
transport for Ubuntu 22.04 checks and explicit unsigned packaging. Both retain
native Windows development as the primary route.

[#2006](https://github.com/boburning/portcove/issues/2006) records delivered browser
qualification. [#2007](https://github.com/boburning/portcove/issues/2007) separately
owns builder and per-format packaging acceptance. Docker is optional for both.

### Development dependency security

Use `just security` for the development regression decision and `just deny` for
raw scanner status. `just audit` includes the scanner and development decision;
no special risk flag is required. The known GLib error stays visible and remains
a raw failed scan. Release expiry, tags, inventories and native source review
belong exclusively to Linux release authorization; see [QUALITY](QUALITY.md).

## Shared local resources

Capacity and desktop exclusivity are separate. Participating same-user commands
share `~/.portcove/resources`, independent of worktree, branch, tool version,
`PORTCOVE_SHARED_TOOL_CACHE` and XDG cache overrides. Defaults admit two estimated
units: Rust, browser and analysis phases use one each; container preparation and
execution use both. These are conservative admission weights, not CPU/RAM
reservations. Cargo compilation uses at most two jobs; existing nextest limits
remain; unit and browser projects use two workers each. Git bundle preparation
uses two pack threads. Preserve headroom for unrelated programs.

`config.json` in that domain accepts `slots` (1..8, default 2), `waitMs`
(0..3600000, default 900000), absolute `legacyRoots` for additional known shared
tool-cache roots, and `legacyMode` (`pending` or `coordinated`). Do not edit the
mode during active work. Lowering capacity does not erase existing reservations.
The guard queues with operation/worktree diagnostics, keeps queue duration
separate from execution, and times out admission with exit 75. Cancellation is
130/143. Neither means a completed test. Execution budgets begin after admission;
outer callers must allow the bounded queue as well as setup and execution.

The initial `pending` mode admits no new heavy payload: requests wait boundedly
while older work finishes. An unmodified PID-only native guard cannot safely
represent independent supervised descendants or remote-engine work. Coordinate a
finite checkpoint with existing local writers, finish legacy heavy/native/container
work and resolve unknown retained records. Then run
`node scripts/resource-command.mts retire-legacy-entrypoints` from an updated
checkout. This owner-authorized operation holds the legacy guards, checks the
drained capacity domain, retains a migration receipt and atomically selects
`coordinated` mode. Queued requests re-read mode. After cutover, retire all
unmodified legacy entrypoints: a passive legacy scan cannot protect against an
unsupported old command starting later. There is no live rollback or cleanup
override; any return to old tools requires another drained transition.

Rust target directories and mutable frontend outputs use physical-path exclusive
reservations alongside capacity. Distinct worktrees can execute together; the
same frontend output cannot be built/restored/tested concurrently. Nested commands
reuse verified ownership. An upgrade requiring more slots or another output must
be declared at the outer phase and fails rather than deadlocking. Native journeys
retain a separate host desktop lock with process creation identity and a legacy
compatibility record. Unknown/PID-only orphan ownership is retained for positive
quiescence investigation, never reclaimed merely by age or PID absence.

The supported frontend, native-build, native-verification and container routes
reuse the existing process supervisor and descendant cleanup. On Windows/Linux,
heavy frontend and host bundle preparation therefore need the pinned Rust compiler
for the small cached supervisor; frontend profile setup/doctor includes it.
Formatting, explicit-file lint, Node contract tests, Git/API reads, editing and
review do not acquire capacity or provision Rust, browsers or Docker. No validation
command implicitly installs a missing compiler. `desktop:build` resolves the
pinned Tauri adapter and declares Rust/frontend output ownership. Interactive
`desktop:dev` remains a long-lived third-party watcher: its idle lifetime is not a
finite admitted phase. Do not overlap its compilation/output mutation with finite
commands in that checkout; use a separate worktree and the native session rules.
Raw Cargo/Vitest/Tauri commands and independently launched WSL jobs do not gain
universal host enforcement. Windows-driven WSL verification participates through
its host guard; a separate Linux user/kernel domain does not share host identity.

Docker browser and builder adapters reserve host capacity before expensive image,
dependency and bundle preparation, retain it through exact labelled container
quiescence, and keep guest limits/isolation. The guest receives only a participation
flag, never host coordination paths/tokens or mounts. Preparation and runtime are
measured separately from queue time; image inventory is refreshed after admission.
Recovery retains custody across host exit, uses the exact build name's completed
Buildx history or the stopped labelled container, and records the release decision
before removing individual slots. Interrupted cleanup can resume without touching
a successor's token. Uncertain/missing engine evidence retains capacity and the
run's `host.json`; use the adapter's existing `export --run UUID` recovery command.
A budget refusal before dispatched work releases immediately. Successful package
construction remains distinct from installed/native GUI qualification.

Source custody is checked again after waiting using the existing provenance
primitive. A changed candidate is refused before payload launch; reusable local
receipts also verify source after execution. Hosted CI does not consult this local
domain and retains its runner limits and containment. Optional local audit/Fallow
feedback, required hosted contexts, review, artifact reuse and explicit native or
release acceptance retain the current [quality contract](QUALITY.md).

The maintained private-X11 adapter acquires host capacity before entering its
PID namespaces. Only its explicitly delegated native token crosses that boundary;
host capacity records and process tokens do not. The existing guest participation
marker also covers this owned private namespace/Windows-driven WSL route, where
PID remapping prevents parent-identity observation. The outer owner retains
capacity and native custody until the maintained namespace join proves quiescence.
Arbitrary independently started WSL/native processes remain outside this contract.

Repository bootstrap scripts also enter the existing resource executor before
checkout dependency installation and Cargo tool builds, reserve the checkout's
mutable outputs and the actual shared tool-cache location, and verify inherited
ownership before nesting. Setups sharing that writable cache cannot race pinned
tool receipts or shims; ordinary builds/tests need no cache mutation reservation. Hosted/guest
setup keeps its existing runner context. The pinned Rust compiler and platform
linker needed to build the supervisor are explicit initial host prerequisites;
setup disables Rustup auto-install for that guard. On a new host, install Rustup
and the pinned compiler (`rustup toolchain install` with the repository channel
and minimal profile) plus the existing platform linker first, then perform the
resource handover and requested bootstrap. This initial third-party toolchain
installation is outside Portcove admission. Normal guarded validation never
provisions it implicitly. Cold worktree dependencies remain independently owned;
sharing the download/tool cache does not share generated `node_modules`.

Capacity queues probe at five-second intervals by default. A bounded process-identity
probe failure keeps work queued within the same admission deadline; it never proves
availability or starts a payload. Queue and execution failures remain distinct.
