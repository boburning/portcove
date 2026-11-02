# Customer copy follow-up: supplementary browser investigation

Date: 2026-11-02. The unchanged baseline passed all 26 cases in the original
two-file selection. On composed follow-up source `c3fa60f7`, that same command
passed 24 and failed two: both original recovery-action clicks still timed out
waiting for stability. The other two original cases passed. The separate
six-file composition remains red (117 passed, 11 failed). No historical failure
is declared resolved and no all-browser-green claim is supported.

The bounded investigation reproduced a rendering-clock stall on a plain page
outside Portcove and Vitest, using the same pinned browser. The exact browser/host
mechanism remains unresolved. No product behavior, assertions, finite-animation
checks, stability checks or timeouts were weakened. The native-rAF experiment
failed and was reverted.

## Sources, command and environment

The original synthetic composition `57f414d3` and merged commit `d286ab64` both
resolve to tree `85c7791a18c66c3a7c77efd0d60f5d06a2c0b4e8`.
The unchanged baseline is commit
`b12c162a8109719800fa7ac1bde8236c20631b26`, tree
`09d19ec19c735a17baa364ac89e6debb065b4522`, in a separate detached checkout.
The matched follow-up is clean commit
`c3fa60f7b1f4c0d031db6aea2060a468540898d8`, tree
`c89c645d76bbd06a29b939e993e9e26abc5efdea`. Source status was clean before and
after both matched runs. The selected test files and capture harness have no
diff between the original composition and baseline; the four definition IDs
match across the original, baseline and follow-up observations. An explicit Git
diff also confirms both selected UpdateCenter test files and
`apps/desktop/test/parity-capture.ts` are byte-unchanged from baseline `b12c162a`
to follow-up `c3fa60f7`.

The exact original command was repeated on baseline and follow-up:

```sh
node scripts/run-ui-tests.mts exact src/features/port-updates/UpdateCenter.test.tsx src/features/port-updates/UpdateCenter.browser.test.tsx
```

Both maintained runs executed both requested files with no skips, retries or
unhandled errors. Baseline invocation `fcea7d48-a8fa-4ba7-8440-c5ab114ccdef`
passed 26 of 26, exit 0; runner duration 22.04 seconds, admission queue
1559217 ms. Follow-up invocation `f9414336-2c6a-458a-a687-2d4ee1600aa4`
passed 24 of 26, exit 1; runner duration 45.90 seconds, queue 8170 ms. Queueing
is separate from test execution. Maintained resource admission remained intact.

Versions are Node `24.22.2`, Vite+ `1.4.0`, Vitest `5.0.5`, Playwright `1.64.1`
and Chromium headless shell revision `1248`. Plain-page controls report actual
browser version `156.0.8078.4`; the original run's executable-reported browser
version and kernel were not captured. Its log records Linux x64 and Node
`24.22.2`; traces record Playwright `1.64.1`.

The current host is Ubuntu 26.04 on Linux
`6.18.33.2-microsoft-standard-WSL2`, x86_64. Baseline and follow-up reuse the same
physical pinned browser cache through their ignored `work/browser-cache` paths.
Standard matched commands set no browser override. Recorded inherited values
include `DISPLAY=:0` and `WAYLAND_DISPLAY=wayland-0`; `CI`, `NODE_OPTIONS`,
`PLAYWRIGHT_BROWSERS_PATH`, `TZ` and trace-probe overrides were unset. These are
headless browser fixtures, not native application observations.

Context creation options record 1280 by 720. Actual trace snapshots for the
original first three failures show main/tester viewports 414 by 896. The partial
fixture changes the tester to 1024 by 800 while the main-frame snapshot remains
414 by 896. The successful baseline has the same effective dimensions. Context
creation options alone do not establish the effective viewport.

## The same four cases

| Exact full browser case name                                                                                       | Unchanged baseline `b12c162a` | Follow-up `c3fa60f7` |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------- | -------------------- |
| `retained task recovery navigation > opens only the failed task's resolved game through its offered review action` | passed; 7768.8 ms             | failed; 19957.3 ms   |
| `retained task recovery navigation > keeps setup review ahead of the generic game review`                          | passed; 161.9 ms              | failed; 19960.7 ms   |
| `keeps the focused task and expanded diagnostics mounted through Activity regrouping`                              | passed; 186.0 ms              | passed; 1363.1 ms    |
| `renders qualified update counts for the partial fixture`                                                          | passed; 192.4 ms              | passed; 206.8 ms     |

Original invocation `3c2dab25-29ff-463b-b733-d48e70100034` passed 22 and failed
these four. Its Review game and Review setup clicks timed out at 14836 and
14839 ms, after resolving their buttons and waiting for visible, enabled and
stable. Activity regrouping reached the 15000 ms test deadline. The partial
fixture failed during screenshot stability with 362.35 ms remaining.

On follow-up, the same Review game and Review setup clicks timed out at 14829
and 14837 ms. Their approximately 20-second case durations include failure
handling; they are not the action deadlines. Activity regrouping and partial
counts passed their original interaction/capture assertions. All four identities
and current errors/durations are retained in
`candidate-original-four-c3fa60f7-case-results.json` and
`original-four-comparison-summary.json`; no case was dropped or substituted.

The successful baseline Review game action still spent 7623.8 ms waiting for
stability, while Review setup spent 16.1 ms. Original first-three traces have zero
screencast-frame events; their successful baseline counterparts have 2, 3 and 6.
Those are trace observations, not direct animation-frame callback measurements.
The original and current failures cannot be explained merely by a passing run.

Per-case disposition: the Review game and Review setup recovery cases remain
unresolved failures. A local rendering-clock problem was observed independently,
but its causal link to each recovery failure is unproven. The Activity regrouping
and partial-count failures were not reproduced in the matched follow-up; both
historical causes remain unresolved. Their passing matched results do not close
the historical investigation.

## Feedback loop, hypotheses and isolated installation cases

Playwright stability checks depend on unchanged geometry across animation frames
([official actionability contract](https://playwright.dev/docs/actionability)).
Before probing, the ranked candidates were delayed frame delivery, actual layout
movement, clock/frame substitution, general scheduling pressure, and a timed-out
parity capture continuing into a later case. Each had a discriminator: native
frame/clock observations, geometry changes, substituted functions, evaluation
latency, or preceding-render operations in the next trace. The original partial
trace contains preceding and current render operations; that supports examining
an overlap but does not prove its cause or effect.

An initial observation run on unchanged baseline, invocation
`273037ba-85c2-4d2a-aa6c-a886eb2e358a`, passed 26 of 26. Its 22 frame/page samples
showed advancing clocks, native timer/frame functions, visible documents and no
active animations. Only one Review game geometry sample was captured, so that
passing probe did not establish invariant geometry during the earlier slow wait.
It did not reproduce the failure or establish a causal fix.

A subsequent unfrozen working-tree six-file run based on `b12c162a`, invocation
`25e004e7-96a0-4893-8a4d-f7cecc18a96d`, passed 120 and failed six. One was an
expected-copy mismatch. Five involved existing browser interaction/capture:
ExternalRuntime and CatalogDownload click stability, plus these InstallAction
cases:

- `does not dismiss the reviewed installation after installation starts`
- `keeps the active installation cancellation reachable inside the busy review`
- `exposes a failed install result outside the dismissed review before another attempt`

The first two failed `captureParityState`'s finite-animation completion poll,
after their disabled-button assertions. Trace DOM shows Cancel review disabled
in both. These were not disabled-guard failures. The third stalled on screenshot
stability. The working tree was not frozen; its exact whole-tree identity is
unavailable. Its retained logs and trace source remain investigation evidence.

On unchanged baseline, the three existing ExternalRuntime, CatalogDownload and
InstallAction browser files reproduced the first animation-poll failure:
`5fea8b29-21e5-4a41-a3e8-b2f21ff42668`, 107 passed, one failed. Narrowing only to
`src/components/InstallAction.browser.test.tsx` reproduced all three capture
failures: `e142fdf5-9396-414d-8e63-a42d9d8febe1`, 25 passed, three failed.
Thus cross-file execution is not necessary for those installation failures.

The isolated baseline observer `a864cc61-e7e1-47ae-8405-d7cc8d57efcd` again
passed 25 and failed the same three. During busy/cancellation captures, repeated
samples showed visible documents and advancing JavaScript clocks, while finite
150 ms button transitions remained running, pending and at time zero. Button
geometry was fixed within sampled intervals; layouts differed across cases. The
synchronous application rAF stub was present. This motivated a native-rAF control,
but did not prove that stub caused the stalled rendering.

## Rejected native-rAF control

The control was clean commit `07f813f5e55219fc12399756d90f25252ca26f70`, tree
`8b5a2e4c0abfc5e3fcb9ddb6e2f1eefd185d94ec`. Removing the synchronous stub was
the frame-behavior change; focus, disabled-button and capture guards remained.
The candidate file also contained a copy-expectation update and one new warning
case. A first launch executed no tests because the candidate cache path was
missing; it was preserved, then the same pinned cache was linked.

The real isolated native-rAF control `dfc57d33-a9e4-4acd-a2da-cf79ec6b00bb`
passed 24 and failed five. The three capture failures remained. Two immediate
focus assertions also failed: `presents the reviewed installation in a dismissible dialog and restores trigger focus`
and `describes an unchecked local copy and keeps installation blocked`. Removing
the stub alone is therefore falsified as a complete repair. A second identical
plain control was not run after that red result.

A bounded native observer on the same clean revision,
`e3338faf-5143-40ec-bc23-dfea3a4baf30`, also passed 24 and failed five, with zero
unhandled errors. It counted real application requests/callbacks around the
original native function without requesting additional frames. Across 91 iframe
samples, `performance.now()` advanced from 719.1 to 46083.9 ms while
`document.timeline.currentTime` stayed exactly zero. Native rAF received 27
requests and delivered zero callbacks; 25 cancel calls were observed. Documents
reported visible; 24 samples contained finite animations pending at time zero.
Host-driven evaluations remained responsive. This observed rendering timeline
stall extends beyond the synchronous application stub. The rejected removal was
reverted before `c3fa60f7`; no native-rAF repair is claimed.

## Plain-page controls outside Portcove and Vitest

An ignored diagnostic used maintained browser admission, the same Playwright and
Chromium executable, an owned 414 by 896 page, a div with a 100 ms opacity
transition, and native frame callbacks. It resolved from frame/transition events
or a finite 5000 ms diagnostic deadline, then closed context/browser in `finally`.
No arbitrary sleep, application code, Vitest, changed test budget or persistent
configuration was involved. One earlier module-import setup error launched no
browser; its separate artifact is retained.

| Plain control                         | Native rAF             | Document timeline | 100 ms transition                   | Verdict |
| ------------------------------------- | ---------------------- | ----------------- | ----------------------------------- | ------- |
| Standard launch                       | 1 request, 0 callbacks | 0 throughout      | pending/running at time 0 after 5 s | Failed  |
| Only `--disable-gpu` added            | 1 request, 0 callbacks | 0 throughout      | pending/running at time 0 after 5 s | Failed  |
| Only `PLAYWRIGHT_LEGACY_SCREENSHOT=1` | 1 request, 0 callbacks | 0 throughout      | pending/running at time 0 after 5 s | Failed  |

All three report Chromium `156.0.8078.4`, visible documents, advancing native
JavaScript clocks, successful cleanup and exit 1. The GPU hypothesis predicted
that its one flag would restore events; it did not. The legacy-screenshot
hypothesis was grounded in pinned `playwright-core@1.64.1/lib/coreBundle.js`, whose
`PLAYWRIGHT_LEGACY_SCREENSHOT` conditional omits
`--enable-features=CDPScreenshotNewSurface`; that one-variable control also failed.
Neither variation is a repair. No override was persisted or used to qualify the
matched application cases.

The plain-page red directly establishes that this rendering-clock failure can
occur outside Portcove/Vitest. It does not identify the browser/host mechanism or
prove that every historical failure had this cause. Browser command-line CDP
readback was unavailable: Chromium rejected it because `--enable-automation` was
not set. Actual selected launch flags therefore remain unavailable; pinned-source
inspection is not represented as live command-line readback. The bounded probe
ends here, without browser configuration, package or host repair.

## Six-file composition remains red

The native-rAF six-file experiment `bd1b46e8-bc23-42b3-a7c0-a13208282446`
completed with 107 passed and 19 failed, not an early partial count. All 19 exact
failed identities and all 19 linked trace ZIPs are retained in
`native-six-file-composition/`; none is missing.

Both six-file composition runs used this maintained selection:

```sh
node scripts/run-ui-tests.mts exact \
  src/components/ProtectionSummary.browser.test.tsx \
  src/components/ExternalRuntime.browser.test.tsx \
  src/components/InstallAction.browser.test.tsx \
  src/components/CatalogDownload.browser.test.tsx \
  src/components/ManagedRouteChange.browser.test.tsx \
  src/features/recommendations/GameComparisonEvidence.browser.test.tsx
```

On composed `c3fa60f7`, the six-file invocation
`fcc6cfef-4067-4b47-86c1-21df65dc1122` completed with 117 passed and 11 failed
(128 cases), zero unexpected skips and zero unhandled errors. The complete failed
inventory follows; paths are relative to `apps/desktop/src/`:

| File                                                               | Exact failed case name                                                                         | Observed failure and disposition                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `components/ManagedRouteChange.browser.test.tsx`                   | `reviews a separate managed copy before consent and leaves Play explicit`                      | `locator.click` timeout 14739 ms; unresolved local interaction failure. |
| `components/ExternalRuntime.browser.test.tsx`                      | `retains external launch drafts across detail tabs and reviews the same target and generation` | `locator.click` timeout 14827 ms; unresolved local interaction failure. |
| `components/CatalogDownload.browser.test.tsx`                      | `keeps a recommendation beyond eight packages and an explicitly selected alternative visible`  | `locator.click` timeout 14870 ms; unresolved local interaction failure. |
| `components/ManagedRouteChange.browser.test.tsx`                   | `shows the Core hold while keeping the current copy intact`                                    | `locator.click` timeout 14899 ms; unresolved local interaction failure. |
| `components/ExternalRuntime.browser.test.tsx`                      | `edits selected paths while preserving ordinary arguments through relink`                      | `locator.click` timeout 14884 ms; unresolved local interaction failure. |
| `components/CatalogDownload.browser.test.tsx`                      | `retains a deliberate older release and package across refresh`                                | `locator.click` timeout 14884 ms; unresolved local interaction failure. |
| `features/recommendations/GameComparisonEvidence.browser.test.tsx` | `shows the shared facts, accepts keyboard requirements and keeps following explicitly opt-in`  | Test deadline 45000 ms; unresolved local interaction/capture failure.   |
| `components/ManagedRouteChange.browser.test.tsx`                   | `retains a committed failure until the player refreshes the authoritative installation`        | `locator.click` timeout 14889 ms; unresolved local interaction failure. |
| `components/ExternalRuntime.browser.test.tsx`                      | `edits selected paths while preserving empty and multiline arguments through relink`           | `locator.click` timeout 14881 ms; unresolved local interaction failure. |
| `components/CatalogDownload.browser.test.tsx`                      | `requires a new choice when an explicitly selected package disappears`                         | `locator.click` timeout 14877 ms; unresolved local interaction failure. |
| `features/recommendations/GameComparisonEvidence.browser.test.tsx` | `does not describe a project declaration as a test result`                                     | `locator.click` timeout 1 ms; unresolved local interaction failure.     |

All 11 remain unresolved local interaction/capture failures. None of these
11 records reports a final-text assertion mismatch. The plain-page rendering
stall does not establish the identical cause for each case.

All 11 linked trace ZIPs are retained in `composed-c3fa60f7/`. These results are
supplementary local browser evidence and do not establish an all-browser pass,
native application acceptance or the required hosted baseline. Existing assertion
and failure evidence remains intact.

## Retained evidence and limits

Raw evidence lives under ignored `work/copy-followup/browser/`, including
source/environment records, complete case observations, observer modules, plain
controls and trace digest manifests. All four original trace ZIPs, all four
follow-up trace records (including successful raw traces), all 19 native-control
composition trace ZIPs and all 11 composed-source trace ZIPs were verified
available. Host/private paths remain in ignored raw artifacts; this report keeps
repository-relative pointers and sanitized observations.

| Evidence path beneath that directory         | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `original-composition.log`                   | `f1b7b9dd7f823824112e35b502738d302a9d425ff804fe74496f088676b3000e` |
| `baseline-exact-1.log`                       | `12659370eaef3d998e5c6d0fbdca969f16b7ba4675e150f468399be2df86cc3b` |
| `candidate-original-four-c3fa60f7.log`       | `9a21f2067721cc2e1805368b31c58a3123d3b330a145d982b989ae79b9c1f743` |
| `focused-stability/focused-original.log`     | `11790501177d869adc10a2a59d39f9aadb1c0a38baa84ae89684fd507eb0f1cb` |
| `native-six-file-composition/original.log`   | `6914be7ad3132278358a350175115d0589e95ead6f3ef607d727d1490442fd18` |
| `composed-c3fa60f7/original.log`             | `26d18981f69743f2c183550f4fc864dea682f230c31884ed9b6489ca2c590180` |
| `candidate-installaction-native-probe-1.log` | `de260f494897924d9266944527005398032012b64320799e6aab95b22d9f5417` |
| `plain-render-clock-default.json`            | `f33278b0966136af3f533b2e51578bd397fc6ce1b77706940735937738b774b0` |
| `plain-render-clock-disable-gpu.json`        | `133d83dee54c7c0e2838b4b91d21146664c4c41bede55f6a2c7253a4cb531492` |
| `plain-render-clock-legacy-screenshot.json`  | `2e14259f57011be572fcb5f9dc912f2189e01cb86a754e9a4ddc3ce1c959abb3` |

Primary code anchors are the [exact runner](https://github.com/boburning/portcove/blob/c3fa60f7b1f4c0d031db6aea2060a468540898d8/scripts/run-ui-tests.mts),
[capture guards](https://github.com/boburning/portcove/blob/c3fa60f7b1f4c0d031db6aea2060a468540898d8/apps/desktop/test/parity-capture.ts),
[browser project configuration](https://github.com/boburning/portcove/blob/c3fa60f7b1f4c0d031db6aea2060a468540898d8/scripts/frontend-tests.ts)
and [package pins](https://github.com/boburning/portcove/blob/c3fa60f7b1f4c0d031db6aea2060a468540898d8/pnpm-workspace.yaml).
Local observations above own claims about execution; passing hosted CI cannot
retrospectively identify these failures' cause. Required exact-head hosted checks
and delivery remain the delivering owner's responsibility.
