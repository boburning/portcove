# Development tools

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

The active toolchain authorities are Rust 1.98.1 in `rust-toolchain.toml`, Node
24.21.0 in `.node-version`, and pnpm 12.4.2 in the repository root package's
`packageManager` field. GitHub workflows derive pnpm from that package manifest
instead of copying its version. `scripts/dependency-automation.test.mjs` checks
those relationships together with Renovate coverage for nonstandard pins.

The root `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` are the sole
JavaScript workspace and dependency-resolution authorities. Repository-wide
format, lint, and analysis tools are root development dependencies;
`apps/desktop/package.json` remains the product package and owns its runtime
dependencies, package-specific build/test tools, and scripts. The manifests have
disjoint dependency ownership. Install from the repository root with
`corepack pnpm install --frozen-lockfile`. Root commands such as `corepack pnpm
format:check`, `corepack pnpm lint`, `corepack pnpm build`, and `corepack pnpm
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

Linux and macOS retain `./scripts/bootstrap-quality-tools.sh`. A checkout with
different pins resolves a different content-keyed Aqua root while sharing identical
versioned payloads. A failed download, checksum mismatch, unsupported architecture,
partial extraction, or invalid cached receipt fails closed. The previous verified
payload remains in place. Run the bootstrap again to reuse cache hits; no download
or environment mutation is performed for already verified versions.

Run `just fmt-check` for the complete formatting contract, `just check-ui`
for UI build/tests, Oxlint, Fallow, and Stylelint, or `just script-lint` for
Python, shell, workflow, and PowerShell lint as a group. Individual formatter
and linter recipes scan maintained source without rerunning their tool-fixture
self-tests. The exhaustive `check-ui` and `script-lint` aggregates retain those
self-tests through one batched fixture invocation per group.

## Validation tiers and resumable audits

Use focused `just test-*` commands while editing and `just local-check` before a
coherent push. Bare `just` invokes that same focused selector; exhaustive
investigation remains explicit through `just check` or its narrower aggregate
recipes. The local selector reads the complete branch and working-tree diff;
unknown paths fail until a tested routing rule exists. Tooling-only edits do not
pull in native desktop or packaged Windows qualification. Oxc configuration edits
retain formatting, typed lint, UI build/tests, rejection fixtures, and hosted
workflow contracts.

The local planner executes one warnings-denied Clippy command, rather than an
equivalent Cargo check immediately followed by Clippy, for each selected package
or workspace target set. It coalesces the same Oxlint invocation selected by both
tooling and UI only because both declare the same semantic obligation; command
text alone cannot merge distinct evidence roles. Complete UI tests own their
included theme and copy checks, while related-test plans retain the standalone
checks. The printed reason lists every coalesced selector so reduced process count
does not hide why an obligation ran.

`just check` is exhaustive for Rust, UI, script lint and their tool-fixture
contracts, generic repository tooling, Roadmap, and development-tool contracts,
but deliberately excludes release and packaged qualification. Use
`just release-check` for deterministic release units and
`just windows-qualification-check` for the stateful packaged Windows session.
Required CI executes the complete selected hosted plan on every exact pull-request
head. Focused and prose plans do not imply that the aggregate, release, or
packaged Windows contracts ran; qualification executes its documented hosted
coverage, while packaged acceptance remains a separate obligation when required.

`just audit --plan` explains which named formatting, Rust, UI, script-lint,
repository-tooling, Roadmap, development-tool, dependency-policy, rscheck,
release-unit, and applicable Windows-qualification stages would execute or reuse prior
success. A normal `just audit` reuses only integrity-checked deterministic receipts
whose complete content, tool, platform, and environment fingerprint still matches.
Receipts are stored under ignored `work/validation-receipts`; they are disposable
execution evidence and never release or merge authority. Dependency/advisory and
Windows qualification stages always execute. Use `just audit --fresh` for release
preflight, validation-contract changes, and acceptance that explicitly requires a
single no-reuse run.

### Warm single-session workflow

Start or resume one cohesive outcome in the existing healthy, owned checkout.
A new task context does not require a new worktree, reinstall, Cargo cleanup,
bootstrap or exhaustive validation. Keep installed dependencies and incremental
artifacts. A new isolated checkout is justified by actual concurrent ownership,
an unsafe preserved checkout, or a measured isolation requirement; follow
[Development storage](DEVELOPMENT-STORAGE.md) only for that case.

1. Read the canonical issue's unmet acceptance, current PR and latest relevant
   #793 reservation. Resolve `git rev-parse --show-toplevel`, then inspect
   `git status --short --branch --untracked-files=all`, `git rev-parse HEAD` and
   `git worktree list --porcelain`. Reconcile them with the recorded owner,
   branch and evidence; process absence alone is not an ownership transfer.
2. Resume the current branch and failed obligation before selecting another
   task. Before any branch transition, require a clean checkout, known ownership,
   terminal owned build/native operations, and preserved relevant ignored evidence.
   If any condition is unknown or false, refuse the transition. Do not stash,
   reset, delete or overwrite work to make it possible. After a confirmed merge,
   fetch the target, inspect relevant drift and create the next branch in this
   same checkout only when those conditions hold.
3. Keep a compact task contract in the issue/PR or #793 note: **outcome and
   acceptance; checkout, branch and head; reserved files and owning references;
   boundaries/non-goals; narrow edit-test command; coherent pre-push plan;
   resources; completed/failed evidence; exact next action**. Link existing
   evidence instead of copying the initiative or creating a local status ledger.
4. Run the smallest relevant `just test-rust`, `just test-ui-related` or
   `just test-node` loop, then `just local-check` before the coherent push and
   after substantive repair. Integrity-matched deterministic stages may be reused;
   `just local-check --plan` explains selection and `just local-check --fresh`
   disables reuse only when acceptance requires it. Use `just doctor` when prerequisite health is unknown or changed;
   install/bootstrap only the reported missing or mismatched prerequisite.
   [Quality](QUALITY.md) still governs protected changes and exhaustive acceptance.
5. Review one coherent candidate before expensive final qualification. An exact
   local commit/diff may be reviewed before a PR exists; use a draft PR when a
   transition contract requires one. Follow [Contribution conventions](CONTRIBUTION-CONVENTIONS.md) for review,
   required exact-head CI, target interaction checks and guarded merge. The
   helper may inspect retained evidence and run discriminating tests; it must not
   bootstrap a second full environment or duplicate a complete suite without an
   identified need. Keep one heavyweight workflow active at a time.

The reviewer brief supplies **PR when available and owning issue; source head, target tip and
merge-base; complete changed-file list and relevant surrounding code; acceptance
and boundaries; exact commands/results and retained evidence paths; unrun coverage
and target interactions**. Record the actual task identifier, reviewed revisions,
findings and limitations. The implementer batches coherent repairs and returns the
delta plus affected interactions to the same reviewer where practical. Widen review
only when a repair changes architecture, assumptions, or risk. Implementer
self-review is not independent review. A completed PR is a
checkpoint, not permission to close broader unmet acceptance.

#### Resume and diagnosis decisions

| Observed case             | Next safe action                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New task                  | Verify issue, checkout and ownership; reuse healthy dependencies and run the narrow loop.                                                                                                                               |
| Resumed task              | Read the compact contract, preserve failed evidence, and resume the exact next action before picking new work.                                                                                                          |
| Dirty or unowned checkout | Refuse branch transition; preserve all changes and resolve ownership without stash, reset or overwrite.                                                                                                                 |
| Active editor/compiler    | Inspect the reported PID, creation time, parent chain and command; an editor check is not the guarded test runner. Wait, or stop only your proven-owned operation through its originating editor/terminal if safe.      |
| Duplicate owned server    | Identify each Vite/native server's workspace, parent and listening port; reuse the correct healthy server or stop only a proven-owned duplicate through its originating terminal. Unknown ownership blocks that action. |
| Shared guard queue        | Retain owner and elapsed diagnostics; wait or cancel only your queued command. Never delete a lock or bypass admission with direct Cargo/nextest.                                                                       |
| Repeated bootstrap        | Compare the doctor result and pinned tool/dependency identity; repair the reported mismatch instead of reinstalling healthy dependencies.                                                                               |
| Changed source head       | Freeze the new candidate and obtain applicable current-head checks and independent re-review.                                                                                                                           |
| Target-only advance       | Fetch and inspect target-only changes for relevant interactions; an unchanged source does not automatically require rebase or full rerun.                                                                               |
| Reviewer finding          | Preserve the finding, repair it, and return the changed candidate to that reviewer for applicable re-review.                                                                                                            |
| Unavailable delegation    | Record REVIEW READY with PR/head and the concrete limitation; pause that merge and continue authorized nonconflicting work.                                                                                             |

For a named Windows PID, `Get-CimInstance Win32_Process -Filter "ProcessId = 1234"`
reports `ProcessId`, `ParentProcessId`, `CreationDate`, `ExecutablePath` and
`CommandLine`; replace 1234 with the observed PID and inspect its parent identities.
For a suspected server, `Get-NetTCPConnection -State Listen -OwningProcess 1234`
can identify its ports. These are read-only clues, not ownership proof by name or
PID alone. Missing paths, stale identities or unreadable ancestry mean unknown.
Retain only relevant sanitized diagnostics, not full environment or command dumps.
Never kill unrelated processes or change global editor, antivirus or storage settings
automatically. Existing [Rust admission](#rust-test-runner) and native-session guards
remain authoritative; separate worktrees keep separate mutable Cargo targets.

At a handoff, record current head and dirty state, active owned process/session
identities or confirmed terminal state, evidence locations, unresolved findings or
external boundaries, and the exact resume command/condition. Put it on the current
issue/PR and link a short #793 checkpoint. No second ledger, scheduler or daemon is
needed. Choose a cohesive independently verifiable outcome, not setup-heavy trivial
fragments or an unrelated mega-refactor.

#### Static component scenarios

From the checkout root, run
`node scripts/dev-storage.mjs run -- corepack pnpm --dir apps/desktop dev`, then open
`http://127.0.0.1:1420/scenarios.html` in an ordinary browser. The development-only
page offers typed deterministic empty-library, ready-game, missing-source,
missing-tool, staged-update, interrupted-operation, refresh-failure and unavailable
artwork/provider previews. It also includes stable actual-component reference
compositions for a long-title Library, a narrow game-details workspace and a narrow
reviewed installation plan. Each reference records its light/dark theme and
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

The reusable Windows diagnostics skill is installed in the user's Codex skill
directory and can be used outside Portcove. Keep a repository skill focused:
update its trigger and owning references when behavior changes instead of copying
the same detailed contract into the root instructions.

## Native desktop smoke tests

For the normal Codex and maintainer workflow, start with a non-launching plan and
then run the smallest useful selection:

```powershell
just desktop-verify --plan
just desktop-verify --scenario keyboard-layout
just desktop-verify --scenario keyboard-layout --scenario accessibility
just desktop-verify --profile presentation
```

With no selector, `desktop-verify` uses the `smoke` profile. Exact `--scenario`
flags are repeatable and mutually exclusive with `--profile`; execution follows
catalog order so fixture transitions stay deterministic. Use `--list-scenarios`
to see stable IDs, descriptions, profile membership, prerequisites and host-impact
metadata. `--plan --json` and `--list-scenarios --json` provide machine-readable
output without building or launching.

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

The runner performs the desktop doctor and storage preflight, verifies that the
pinned Selenium workspace package resolves, builds or exactly reuses the frontend
with embedded assets, asks Cargo to validate/reuse the Tauri application, builds the CLI/probe only for owned-fixture
scenarios, chooses unused consecutive driver ports, acquires the shared native
session lock, creates a fresh run directory under
`PORTCOVE_OUTPUT_DIR/desktop-verify`, and prints the retained evidence path. It
never installs packages or provisions drivers. Follow the reported bootstrap or
frozen-install remedy when a prerequisite is missing. Use `--require-clean` for
final evidence; dirty source is allowed and recorded during iteration.

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
when its recorded PID is positively absent.

When the native runner reports a live owner, treat that as resource contention,
not a harness timeout: preserve the report, continue noninteractive work, wait for
the named runner to finish, and rerun the same exact scenario or profile. There is
no lock override. A watchdog timeout after acquisition is a separate failed run
and follows the retained-evidence diagnosis in the desktop-verification skill.

Focused and small-profile runs retain the three-minute whole-harness watchdog.
Owned-lifecycle and full sequences use a bounded ten-minute watchdog because they
compose more than eight independently bounded scenarios; this does not change any
scenario's operation, UI wait, confirmation or process-shutdown timeout.

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
wrapper (`corepack pnpm --dir apps/desktop build`, then `cargo build -p portcove-desktop
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
`crates/portcove-core/src/testdata/host_tool_probe.rs.txt` with `rustc --crate-name
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
stale, and retries only that read without repeating install review, download or
mutation. The
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

For bounded diagnosis, `--restart-cycles 1..10` repeats the actual process restart
and records preference persistence and shutdown observations. `--reload-cycles
0..25` optionally adds repeated renderer reloads and concurrent read-only native
requests matching the five ordinary library refresh calls. It records the first
failed batch without retrying it. The defaults remain one restart and no extra
reload probe, within the existing three-minute harness deadline. Partial reports
and failed runs remain evidence; a later pass does not establish a root-cause fix.

`development-evidence.mjs` writes format version 2 observations with a full
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
pinned exact command. Unix anchors a detached process group and starts
an out-of-group cleanup watchdog before nextest; Windows uses a kill-on-close
Job Object. The Unix watchdog publishes success only after the anchored process
group is absent, and a new acquirer validates that receipt before reclaiming a
dead wrapper and supervisor. Nested inherited commands stay inside that existing containment.
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
quiescent, the exact resume condition is a supported owner/containment exit plus
the wrapper's valid cleanup evidence. Preserve the lock and report that condition;
do not invent a manual recovery path or keep rerunning expensive checks while it
remains false. Do not remove the lock, kill another worker, or use direct
Cargo/nextest to evade it. After admission, diagnose any nextest timeout as a
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

`corepack pnpm --dir apps/desktop test:copy` exercises the static-copy checker and complete
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

Run `corepack pnpm --dir apps/desktop test:cli-handoff` for the focused checks.
The host shell test sends spaces, apostrophes, Unicode, literal substitution syntax,
metacharacters, empty values and trailing separators to a harmless Node process,
then compares its actual argument vector. Component tests cover missing inputs,
clipboard failure and a late response from another library. Quoting follows the
[PowerShell quoting rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-7.6)
and [POSIX-style single quoting](https://www.gnu.org/software/bash/manual/html_node/Single-Quotes.html).
