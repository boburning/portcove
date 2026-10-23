# Prototype transfers — 23 October 2026

Acceptance record for #2423. Pickup main was `9dfe09c08e9f88d7bbaaf7a7368f0ea53da1e8c0`.
The candidate incorporates newer main `518e2302ef13a051d158734042415310ea979d49`,
including catalog/self-service setup, at implementation head
`75686b4258d24d614c1a5190e5fd6bff0047e71e`. Later evidence-only commits do not
change that implementation. Original reference directories and ZIP remain intact.

## Eight recommendations delivered

Paths below are relative to `apps/desktop/src/` unless stated otherwise.

| Recommendation          | Delivered behavior and owners                                                                                                                                                                                                                                                                                                                                      | Focused evidence                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 Review identity      | `DetailPanel`, `AdoptionModal`, `ExternalRuntime`, `RemovalReview`, `OutputLocation`, `SteamEntry`, `BackupHistory`/`BackupReview` use the existing full game/project/variant projection. Stable IDs, generation, fingerprints and native approvals still govern execution. Main's new external relink wording and catalog download reviews remain intact.         | Unicode/punctuation installation and backup review tests assert accessible identity and unchanged submitted target/plan. Existing attach/relink, copy, uninstall, folder and Steam review suites exercise their workflows. [Installation review](installation-review-reference.png).                                                                                |
| R2 Healthy backups      | Current inventory has a quiet refresh action. Pending is neutral; failed reads retain earlier results and uncertainty. Recovery still holds applicable actions.                                                                                                                                                                                                    | `BackupHistory.interactions.browser.test.tsx`, `BackupHistory.test.tsx`; [saved-data section](saved-data-final-light.png).                                                                                                                                                                                                                                          |
| R3 Saved-data scope     | Scope appears beside backups. Installed paths are explicitly unavailable in this projection, regardless of today's provider; catalog declarations never replace installed rules. Backup creation checks the managed folder directly and may collect supported installation data. Restore/deletion have reviews; creation does not. External saves remain separate. | `components.test.tsx` covers catalog declarations, changed provider/definition, retained rules and external data. Existing assessment tests cover unavailable/missing/held data. [Final scope](saved-data-final-light.png).                                                                                                                                         |
| R4 Retained work        | Read-only inspection leads with retained work, completeness uncertainty and next action. Secondary locations are folded. Cleanup re-reads its own operation and exposes exact deletion scope and preserved locations before confirmation.                                                                                                                          | [Inspection](retained-inspection-light.png), [cleanup](cleanup-light.png), [320px inspection](retained-inspection-dark-320.png), [200% text facts](cleanup-text-200-facts.png) / [actions](cleanup-text-200-actions.png). `recovery-task-isolation.browser.test.tsx` checks cancelled reviews and a separate completed preparation without changing retained facts. |
| R5 Player language      | Requirements, CHD tool purpose and backup/recovery guidance name the actual task and next supported step. Original diagnostic guidance remains under Technical details.                                                                                                                                                                                            | Missing-tool/source scenarios, SourceIntake BIOS chooser and backup recovery tests. Core's only change is the CHD tool purpose string in `crates/portcove-core/src/host_tools.rs`.                                                                                                                                                                                  |
| R6 Quiet secondary UI   | No-results has a neutral heading and one reset action. Redundant Settings/transfer/install eyebrows are removed. Ordinary refresh/support/catalog commands use natural width.                                                                                                                                                                                      | [320px no-results](no-results-light-320.png), [Advanced Settings](settings-advanced-light.png), existing search/reset/settings category and narrow review tests. Red Play, green readiness, genuine warnings and destructive controls remain.                                                                                                                       |
| R7 Useful Activity demo | Existing disposable transport records stable running/completed/cancelled/failed tasks, separate cancellation request/settlement, two retained operations and an uncertain outcome. Leave → another game → Activity preserves the original task. Cleanup is operation-bound even for two tasks of the same port.                                                    | `interactive/scenarios.browser.test.tsx`, `transport.browser.test.ts`, `browser/interactive-app.browser.test.tsx`. `journey=activity` is selectable in the demo desk. Unsupported actions visibly refuse. No production task store or concurrency restriction was added.                                                                                            |
| R8 Matched comparison   | `journey=comparison` and `scripts/prepare-library-comparison.mts` share twelve IDs, ordering, titles, variants, readiness and exact diagnostic PNG bytes. Authoring makes a separate prototype copy, refuses changed entry points/existing output, and records revision plus image/source hashes.                                                                  | `comparison-scene.test.ts`, `prepare-library-comparison.test.mts`; [app covers](app-matched-covers-dark.png) / [prototype covers](prototype-matched-covers-dark.png), [app rows](app-matched-rows-light.png) / [prototype rows](prototype-matched-rows-light.png).                                                                                                  |

## Controlled Library comparison

Both sides: 1366×768 CSS pixels, 16px root text, same view/theme within each pair,
twelve entries including two implementations of Harbor Adventure, a long Unicode
identity, one missing image and one missing-source state. Actual diagnostic PNG
inputs are 120×180, 180×100 and 120×120; matching bytes are shared, without catalog
or user-artwork changes. Fonts and images settled before capture. Captures were
individually inspected at full size. These are composition observations, not
user-speed or native-host evidence.

| Condition   | Production app                                               | Prototype                                                    |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Dark covers | 180×270 art, first collection y≈228, five complete entries   | ≈192×288 art, y≈181, five complete entries                   |
| Light rows  | 69px ordinary rows, 32×48 thumbnails, seven complete entries | 69px ordinary rows, 32×48 thumbnails, eight complete entries |

The app retains the extra filter dimensions, explicit view labels and contextual
collection commands. Its two-row command area consumes more height. Port/variant
text wraps in production; the reference truncates ordinary secondary identity.
Green readiness is an owner preference retained in production. Neither layout's
visible-entry count proves faster retrieval.

[Historical installation review](before-installation-review-9dfe09c.jpg) is retained
from the audited main, with its original identity. The revised review uses the
same typed long-title plan, folder, version and outer viewport; the reference
iframe's scroll/centering position differs. This pair demonstrates added human
identity and reduced repeated headings, not a pixel-matched density improvement.

## Validation and review

The integrated-main run requested, discovered and executed **7 files / 245 tests**,
with no skips. It covers actual App navigation and demo tasks, independent recovery,
external runtime, catalog download and component projections. Earlier focused
runs covered the other affected review/backup/comparison owners; the final repair
run passed **7 files / 243 tests**. Counts overlap and must not be added.
The interactive App suite also checks axe, enlarged rows/reviews, focus and resizing.
Static lint/type checks passed; the commit hook ran the pinned `vp check --fix`.
Required exact-head hosted checks and build results are recorded on the delivery PR.

Independent non-writing Standards and Spec reviews cleared the integrated head
against main `518e2302`. Review caught and repaired an invented backup-creation
review, current-provider inference of installed save scope, same-port fixture token
reuse and two remaining ownership terms. Original failing tests and the
source-changed-while-queued refusal remain in the local evidence directory:
`E:/Codex-Evidence/portcove-prototype-transfers-2026-10-23` (earliest logs retain the
original audit directory). A later pass does not relabel those runs.

## Evidence boundaries and demo

Production React components were exercised through the maintained ordinary-browser
transport; static installation review is explicitly inert. 200% means injected
browser text enlargement in the maintained harness, not a new native sizing
control. Real native IPC, installed host, actual screen reader/controller hardware,
game launch, filesystem mutation and release qualification were not exercised.
No real game files were used. Installed exact save paths remain an honest projection
limitation; no artwork/provider or whole-library backup capability was invented.

Run the normal dev server and open
`scenarios.html?mode=interactive&journey=activity` or `journey=comparison`.
The review desk names simulation limits and exposes reset/complete/fail/settle
controls. The comparison authoring command is documented in
[DEVELOPMENT-TOOLS](../../DEVELOPMENT-TOOLS.md#interactive-app-comparison).
