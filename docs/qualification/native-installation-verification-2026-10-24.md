# Native preparation and update verification — October 24, 2026

Owning issue: [#2506](https://github.com/boburning/portcove/issues/2506).
The unified installation implementation remains delivered by
[PR #2499](https://github.com/boburning/portcove/pull/2499); its
[earlier evidence record](unified-installation-2026-10-23.md) retains its original
scope. This follow-up repairs the maintained native verifier and records bounded
Windows source-build observations.

## Demonstrated failures and repairs

| Before                                                                                                                                       | Repair and verified consequence                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preparation assertions expected three retired phrases despite the rendered review retaining the safeguards.                                  | Check current free-space/output wording, unchanged originals/current runtime until activation, retained rollback, Activity recovery and unfinished work. Six omission controls reject missing consequences. |
| The shared native click helper waited for an offscreen Activity tab to become visible before scrolling it. Its recorded y position was -295. | Scroll the actual target before visibility polling; preserve enabled-state, center-point hit testing and the existing WebDriver click. Hidden, disabled and occluded targets receive no click.              |
| Library overflow navigation reached the Versions heading, but the verifier checked the obsolete inner heading.                               | Observe the authoritative `detail-section-versions` H2 and actual focus. Reject disconnected, hidden, inert, disabled, unrelated and legacy targets. The observer never changes focus.                      |
| Staged-update layout capture looked for old Dark/Light buttons after successfully downloading the update.                                    | Explicitly open Appearance and select the current radio within Color theme. Verify the resolved theme before collecting geometry. Both obsolete-selector controls fail before the repair.                   |
| After automatic recommendation loading, the listing's Set up game action clicked the enabled refresh control and repeated the lookup.        | Reveal and focus the existing setup region without invoking refresh. Keep the loaded package/location through tab navigation and retain Continue setup for a saved download.                                |

The focus sample is exclusively written to
`overflow-update-navigation-focus.json` at the existing wait boundary. A capture
failure cannot replace the original wait failure; capture failure alone fails the
scenario. The native harness repairs preserve application consent, execution,
timing and update-ownership behavior.

Fast controls use the actual shared click helper through the existing WebDriver
executor seam and the actual serialized DOM focus observer. The pre-repair click
control failed three tests; the stale-copy control failed one. Focused feedback
then passed 51 tests across three requested/executed files, 36 across two, and
20 across two (including the rendered theme component), with no skipped files.
Counts describe overlapping selections, not 107 unique tests.

The first hosted run at `b16fca35` exposed an existing dependency-free placement
test whose source slice accidentally included the new exported theme helper.
It failed in both catalog and Windows-helper jobs with an unexpected `export`.
The failure reproduced through the actual Node entry point; the slice now stops
before the next top-level export, preserving all placement rejection controls.
The PR retains that failed run separately from final exact-head qualification.

The next hosted run at `4a49e313` passed catalog, dependency review, Rust and Rust
quality, but its rendered frontend test exposed a timing-dependent extra lookup:
the listing's primary action still activated the old check button after automatic
loading. A deterministic control waits for the recommendation, opens Overview,
then invokes Set up game and checks actual setup-region focus and exactly one
lookup. It failed before the product repair. The repaired production component
passed all 27 tests in the two requested/executed download and detail-layout
browser suites, with no skips. The recommendation, folder choice and review
survive all four tabs; completed downloads retain their Continue setup route.
This is focused rendered-browser evidence for the self-service action. It does
not extend the separate native observations below to that route.

## Native observations

Host: Windows 11 Home, x64, build 26300 (`10.0.26300`), loaded WebView
`155.0.4283.62`. Combined-run source head:
`e8dc33701cff45693f06f001af1952491d135653`. Fresh isolated libraries, synthetic
original/runtime fixtures and owned probes were used. No commercial original game
input or gameplay was required or observed.

The combined `native-preparation-review-and-play` and
`native-game-update-review` run passed. It exercised supported preparation,
explicit owned-fixture launch, Library overflow focus/return, reviewed update
choices/outcomes, Activity history and actionable failure presentation. Native
captures cover dark/light and 960×640/1280×800 update layouts; preparation includes
the existing 400% geometry observation. Representative review, narrow failure,
ordinary update and final Library captures were visually inspected.

Run directory:
`outputs/desktop-verify/2026-10-24T03-18-37-057Z-V2XCwn`.
Application SHA-256:
`0e5b7fddad8af4e7791e904ad0e2491f1cc1c8c32f004d943a7fa45f1d9203b0`
(67,147,776 bytes). Cleanup positively observed all ten owned processes exit;
there were no terminated survivors.

The separate `native-staged-update-composition` run passed at clean source
`dcd0f2beee6118c9ea5179364eeb2585e48c4005`, using the required
`qualification-fixtures` build. Its four checkpoint preflight tests and
`install-commit-refresh-recovery` setup scenario passed. The synthetic
`1.0.0-fixture` remained active after application restart and verified staging of
`2.0.0-fixture` (artifact SHA-256
`c71403dfda7567d665219733ca4fa4ea960500e99a70b1edb67ad4d0356ba7b9`).
The Library remained Ready to play and linked to the same game's downloaded
update; it did not report that same target as another update. Play and activation
controls remained enabled, with no document overflow, in all four dark/light and
960×640/1280×800 layouts. Narrow dark and ordinary light captures were inspected.
This scenario proves staging and presentation, not activation or gameplay.

Run directory:
`outputs/desktop-verify/2026-10-24T03-39-14-450Z-wZB7y2`.
Application SHA-256:
`83baedb175edea7c98b08b3a2e644a00a7bbcb69bbaa755298efa4ea6ad36950`
(67,227,136 bytes). The restart receipt positively observed seven owned
application/WebView processes exit before publishing the next fixture release.
A separate read-only post-run identity check confirmed all 20 identities observed
across both startup samples had exited, with no survivors. Sampling cannot prove
the absence of unobserved short-lived processes or normal process exit codes.
The harness retained its original finite 180-second execution budget.

## Custody and limits

Actual source/helper bytes were retained before native input, independently of
the compiled application identity. The runner's content-addressed retained copies
and SHA-256 identities are in each `native/evidence.json`; the repaired helper
copies were rehashed against their receipts. A separate tracked-checkout archive
contains 2,928 actual files at the combined run's source head. The source remained clean
during both native operations. Later documentation commits do not rewrite the
executed source revision or claim binary equivalence.

Both earlier failed runs remain retained: `2026-10-24T02-33-54-098Z-z9uwuJ`
(stale copy/offscreen click) and `2026-10-24T03-00-06-308Z-kRS1T0` (obsolete
focus selector; update review passed). Their process cleanup also positively
observed all ten owned processes exit. The first staged run
`2026-10-24T03-20-53-619Z-5OdQy5` is also retained; it failed
at the obsolete theme selector after staging. Its restart cleanup observed seven
application/WebView exits; the later read-only check confirmed all 20 observed
identities had exited. Detailed host logs, fast red/green controls
and the checkout archive remain under
`E:/Codex-Evidence/unified-installation-20261023/`.

These are Windows source-build native fixture observations. They do not establish
packaged installation, gameplay, a real controller/device, minimum Windows support,
macOS/Linux execution or universal save compatibility. The real upstream portable
package transition and literal native version-process observations belong to the
earlier unified-installation record. [#47](https://github.com/boburning/portcove/issues/47)
retains the broader installed/packaged journey acceptance. The follow-up PR records
independent review, required exact-head hosted checks and guarded merge readback.
