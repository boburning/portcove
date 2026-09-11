# Development tools

`just doctor` reads the current host and emits a concise prerequisite report.
`node scripts/dev-doctor.mjs --json` emits format version 1: workspace, platform,
tools, storage, and Windows compiler candidates. Required missing or mismatched
tools and storage failures return exit 1. Optional tools do not block readiness.
Raw subprocess output and environment variables are not dumped. The command does
not install tools, create output directories or modify host configuration.

The doctor reads `.node-version`, the desktop package-manager declaration, the
Rust quality manifest, `.aqua-version`, `aqua.yaml`, and the PowerShell resource
pin. On Windows it reports MSVC installations and PATH candidates; this is not
proof of Cargo's auto-selected linker. Inspect a verbose native build when
compiler selection matters. Keep each worktree's Cargo target separate and use
the existing development-storage wrapper for heavy commands.

Install the exact aqua release named by `.aqua-version` and make `aqua` available
on `PATH` before running either quality bootstrap. The repository does not install
or upgrade aqua on developer machines. The bootstrap verifies that prerequisite,
then `aqua install` provisions the checksum-locked Ruff, actionlint and ShellCheck
versions from `aqua.yaml` for the current Windows, Linux or macOS architecture.
On Windows, the PowerShell bootstrap also installs exact PSScriptAnalyzer 1.25.0
from PSGallery through the standard `.config/powershell-resources.psd1`
PSResourceGet contract. Other hosts report it as not applicable because required
PowerShell coverage runs in Windows CI. Run `just check-ui` for ESLint and
Stylelint, or `just script-lint` for Python, shell, workflow and PowerShell lint
as a group.

## Skills

Repository-local skills under `.agents/skills` describe port qualification,
release validation, roadmap reconciliation and desktop verification. They resolve
contracts from the active checkout. General architecture and quality obligations
remain in `AGENTS.md`; skills do not become a parallel implementation or planning
authority. The reusable Windows diagnostics skill is installed in the user's
Codex skill directory and can be used outside Portcove.

## Native desktop smoke tests

Install `tauri-driver` 2.0.6 and a Microsoft Edge WebDriver matching the installed
WebView2 runtime on Windows. Linux needs WebKitWebDriver and a graphical session.
The external driver path adds no automation plugin to the product. Native macOS
execution is not supported by this harness.
The pinned Selenium client connects to the explicitly started driver server;
the harness does not invoke Selenium Manager or provision browsers automatically.

Build the frontend and a desktop binary with embedded assets using the storage
wrapper (`pnpm --dir apps/desktop build`, then `cargo build -p portcove-desktop
--features tauri/custom-protocol`). A plain debug build expects a Vite server and
cannot establish the packaged-assets smoke claim. Then run:

```powershell
just desktop-test --app <absolute-desktop-executable> --driver <absolute-tauri-driver> --native-driver <absolute-platform-driver> --output <new-absolute-directory>
```

The output parent must already exist. `--port` defaults to 4444 and the native
driver uses the following port; choose unused ports. The new output directory
contains an isolated library, host preference file, WebView2 profile on Windows,
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

The cancellation scenario also verifies the retained setup log through CLI and
Tauri after reconnect, rejects stale-library log reads, opens both output streams
in the activity view, and exports a redacted support bundle. Incomplete capture
and quota behavior are separate core fixtures. These logs contain owned synthetic
output, not evidence of actual game compatibility.

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
persistence over a real process restart, and automated accessibility checks.
Install/progress/cancellation requires a reviewed artifact fixture and is
explicitly not-run in this smoke suite. Core/component tests and human acceptance
remain separate. An incomplete report is not full desktop qualification.

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

`development-evidence.mjs` writes format version 1 observations with a full
revision, executable hash, method, scenario outcomes, and hashed artifact
references. It never overwrites a report. Artifact references are local paths;
retain the directory when handing off results. The revision is source context,
not proof an externally supplied executable was built from that revision.

## Rust test runner

Use `just rust-test` and the cargo-nextest version pinned in the existing quality
manifest. The standard wrapper prepares native test fixtures and retains the
repository's scheduling configuration; doctests run in Cargo separately. Do not
duplicate this orchestration in a skill or a competing recipe. Record cold
compilation separately from warm test execution when comparing performance.

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
