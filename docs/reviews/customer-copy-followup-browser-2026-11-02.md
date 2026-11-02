# Customer copy follow-up: supplementary browser investigation

Date: 2026-11-02. Scope: the four supplementary local browser failures retained
with PR #4200. The unchanged baseline passes all 26 cases, including the original four. No
cause has been established; passing execution does not explain the failures.

## Source and original run

The synthetic composition commit `57f414d3` and merged commit `d286ab64` both
resolve to tree `85c7791a18c66c3a7c77efd0d60f5d06a2c0b4e8`. The original command was:

```sh
node scripts/run-ui-tests.mts exact src/features/port-updates/UpdateCenter.test.tsx src/features/port-updates/UpdateCenter.browser.test.tsx
```

The original retained log has SHA-256
`f1b7b9dd7f823824112e35b502738d302a9d425ff804fe74496f088676b3000e`.
Its invocation ID is `3c2dab25-29ff-463b-b733-d48e70100034`: 14 unit and 8
browser cases passed; these four browser cases failed, with no retry:

| Exact full case name in `UpdateCenter.browser.test.tsx`                                                            | Original observed failure                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `retained task recovery navigation > opens only the failed task's resolved game through its offered review action` | `locator.click` timed out after 14836 ms; resolved Review game button; waiting for visible, enabled and stable.  |
| `retained task recovery navigation > keeps setup review ahead of the generic game review`                          | `locator.click` timed out after 14839 ms; resolved Review setup button; waiting for visible, enabled and stable. |
| `keeps the focused task and expanded diagnostics mounted through Activity regrouping`                              | Test deadline of 15000 ms.                                                                                       |
| `renders qualified update counts for the partial fixture`                                                          | `locator.screenshot` timed out with 362.35 ms remaining; waiting for element stability.                          |

Primary local evidence is preserved under ignored `work/copy-followup/browser/`:
`original-composition.log`, `original-composition-results.json`,
`original-trace-actions.json`, and the four original trace ZIPs with a digest
manifest in `original-traces/`. Raw logs retain local paths; this report uses
repository-relative paths only.

## Environment and unchanged baseline

The original log records Node `v24.22.2`, Linux, x64; traces record Playwright
`1.64.1`, Chromium, context creation viewport options 1280 by 720. Actual trace
snapshots for the first three failures show main and tester viewports 414 by 896.
The partial fixture changes the tester viewport to 1024 by 800; its main-frame
snapshot remains 414 by 896. Context options alone do not establish the effective
test viewport. Source pins are Vite+ `1.4.0`,
Vitest `5.0.5`, Playwright `1.64.1`. Original kernel and actual executable-reported
browser version are unavailable. The pinned Playwright browser manifest specifies
Chromium shell revision `1248`, version `156.0.8078.4`.

The unchanged current-main baseline is commit
`b12c162a8109719800fa7ac1bde8236c20631b26`, tree
`09d19ec19c735a17baa364ac89e6debb065b4522`, in a separate detached checkout.
Its source status was clean before the run. The two selected test files,
`scripts/frontend-tests.ts`, and `apps/desktop/test/parity-capture.ts` have no
diff from the original composed revision. Node and installed package versions
match the versions above. The current host is Ubuntu 26.04, Linux
`6.18.33.2-microsoft-standard-WSL2`, x86_64. Dependency entries and browser-cache
artifacts are reused without changing their source directories. The exact original
two-file command completed through maintained resource admission, invocation
`fcea7d48-a8fa-4ba7-8440-c5ab114ccdef`: 26 passed (14 unit, 12 browser),
zero skipped, zero retries, zero unhandled errors, exit 0. Queue duration was
1559217 ms; reported runner duration was 22.04 seconds. The completed log SHA-256 is
`12659370eaef3d998e5c6d0fbdca969f16b7ba4675e150f468399be2df86cc3b`.
`baseline-four-case-results.json` retains full case identities and verdicts;
`baseline-environment.json` retains the baseline provenance. Source status
remained clean after execution. No guard bypass, assertion change, timeout
increase, added sleep or product/test source change was made.

| Original failed case (same order as above) | Unchanged-baseline result | Duration  |
| ------------------------------------------ | ------------------------- | --------- |
| Review game recovery action                | Passed                    | 7768.8 ms |
| Setup review precedence                    | Passed                    | 161.9 ms  |
| Activity regrouping and diagnostics        | Passed                    | 186.0 ms  |
| Partial update counts                      | Passed                    | 192.4 ms  |

The successful raw traces were retained by the runner and copied into ignored
`baseline-traces/`. Their effective main/tester viewports match the original:
414 by 896 for the first three cases, and tester 1024 by 800 for the partial
fixture while the main frame remains 414 by 896. Thus viewport dimensions alone
have not explained the different results. The successful Review game action
spent 7623.8 ms between the stability-wait log and the stable log; Review setup
spent 16.1 ms at the same boundary. The original corresponding actions never
reported stable before their 14836/14839 ms action deadlines. Original first-three
traces contain zero screencast-frame events; successful counterparts contain
2, 3 and 6 respectively. Screencast counts are trace observations, not a direct
measurement of animation-frame callbacks.

## Interpretation boundary

Playwright stability checks require an unchanged bounding box across consecutive
animation frames ([official actionability contract](https://playwright.dev/docs/actionability)).
The original traces establish where the operations stopped; they do not establish
whether geometry movement, frame scheduling, clock control or another condition
caused the wait. Passing hosted CI cannot resolve that distinction. The baseline
pass narrows the result to non-reproduction on this invocation; it
does not establish a cause, a reliable reproduction rate, or a product fix.

Source anchors: the unchanged
[browser cases](https://github.com/boburning/portcove/blob/b12c162a8109719800fa7ac1bde8236c20631b26/apps/desktop/src/features/port-updates/UpdateCenter.browser.test.tsx),
[parity capture](https://github.com/boburning/portcove/blob/b12c162a8109719800fa7ac1bde8236c20631b26/apps/desktop/test/parity-capture.ts),
[project configuration](https://github.com/boburning/portcove/blob/b12c162a8109719800fa7ac1bde8236c20631b26/scripts/frontend-tests.ts),
and [package pins](https://github.com/boburning/portcove/blob/b12c162a8109719800fa7ac1bde8236c20631b26/pnpm-workspace.yaml)
own the test behavior and configured versions. Local retained observations above
own claims about the original failure and attempted baseline execution.

## Ranked falsifiable hypotheses before the observation probe

These are investigation candidates, not causal findings. The original invocation
is a real-case red-capable assertion route and the same command has now passed
on unchanged baseline source. A deterministic fresh red loop is still missing;
no fix may be inferred from that pass.

1. **Animation-frame delivery is delayed during browser/tester startup.** If this
   causes the stability wait, a slow action should show unchanged button geometry
   and advancing real clocks while frame-dependent work stalls. A later action
   after rendering resumes should become stable promptly. The long first stable
   wait and short next wait justify testing this first; screencast counts alone
   cannot prove it. The prepared probe records geometry and clocks, but does not
   directly count Playwright's isolated-world frame callbacks.
2. **Actual layout or animation movement prevents stable geometry.** If this is
   the cause, the slow interval should show changing button rectangles or active
   finite animation state; unchanged geometry throughout a reproduced wait would
   argue against this. The probe reads geometry without moving controls.
3. **Clock or animation-frame substitution affects a test context.** If this is
   the cause, a reproduced wait should show substituted timer/frame functions or
   nonadvancing page clocks while host time advances. Native functions and
   advancing page clocks would argue against substitution in that observed run.
4. **Host/browser scheduling pressure delays progress independently of layout.**
   If this contributes, host-to-page observation gaps should coincide with the
   action stall even when geometry and functions remain unchanged. A prompt page
   evaluator during a long stability wait would narrow this to frame-related
   progress rather than a generally blocked browser thread. A different host-load
   snapshot alone cannot assign causation to the original run.
5. **A timed-out parity capture continues into the next case.** If the partial
   fixture is a downstream effect of the preceding Activity timeout, its trace
   should include delayed capture/cleanup from the preceding render, and running
   that fixture in isolation should not show the same overlap. The original
   partial-fixture trace contains operations for both current render
   `__vitest_8__` and preceding render `__vitest_7__`, plus two capture target
   selectors; its successful counterpart contains only the current render and
   one capture target selector. This supports investigating an overlap, but does
   not show what first stalled the prior capture or establish that overlap caused
   the partial fixture's failure. No isolated-case diagnostic has been run.

The bounded ignored provider probe ran against the unchanged baseline and the
same exact two-file selection, through normal admission. An ignored wrapper loads
the provider observation module, then the maintained `run-ui-tests.mts`; that
maintained script retains admission and assertion ownership. No source/test file,
assertion or budget changed. The probe adds read-only evaluation traffic, so its
result remains separate from the uninstrumented baseline.

## Observation probe result

Invocation `273037ba-85c2-4d2a-aa6c-a886eb2e358a` passed 26 of 26 cases, no
skips or retries, no unhandled errors, exit 0. The runner reports 12.55 seconds;
queue duration was 8947 ms. The four original case identities passed in 234.5,
150.9, 324.4 and 180.7 ms respectively. Raw evidence is
`baseline-probe-1.log` and `baseline-probe-1.jsonl` under the same ignored evidence
directory. The probe log SHA-256 is
`5a790834837a61392de4ff105d6ab8198e4bf4160064779a408cb7cef1af2f50`.

The 22 page/frame observations cover 11 sample rounds. All sampled documents are
visible. `Date.now()` and `performance.now()` advance; both sampled
`requestAnimationFrame` and `setTimeout` report native function bodies. No sampled
animations are active. One sample catches the Review game button at rectangle
`(x=15, y=452.5625, width=119.5625, height=36)`, visible, inline-flex, with no
transform. Only one button sample exists, so it cannot establish invariant
geometry over a slow action. The probe does not count animation-frame callbacks.
It does not rule out an earlier clock, geometry or scheduling problem, because
neither the original failure nor the long baseline stability wait recurred.

This is useful observation evidence and a second unchanged-source pass; it is
not proof that evaluation traffic repaired startup, a deterministic reproduction,
or a browser defect classification. No further diagnostic repetition is justified
without a new discriminator or renewed failure. No follow-up-revision comparison
has run yet.

## Remaining evidence

The earlier queue blocker resolved normally. The completed invocation has no
live session to resume. Preserve the original failures, completed baseline and
all diagnostic invocations. After the delivering owner freezes the follow-up
revision, execute these same four original case identities with the unchanged
interaction/capture assertions and retain their final-revision verdicts. Passing
that comparison establishes the repeated case outcomes, not a retrospective
cause for the original failures. No browser-source fix is currently warranted by
the retained evidence.

## Subsequent focused run: installation capture failures

A later unfrozen follow-up working-tree run, based on `b12c162a`, selected
`ProtectionSummary.browser.test.tsx`, `ExternalRuntime.browser.test.tsx`,
`InstallAction.browser.test.tsx`, `CatalogDownload.browser.test.tsx`,
`ManagedRouteChange.browser.test.tsx` and
`features/recommendations/GameComparisonEvidence.browser.test.tsx` through the
same exact-file runner. Invocation `25e004e7-96a0-4893-8a4d-f7cecc18a96d`
reported 120 passed, six failed, exit 1. This is investigation evidence on an
uncommitted working tree, not final-source qualification. Its original log and
three timeout traces are retained in ignored `focused-stability/`.

Five failures concern capture or stability; the sixth is a separate expected-copy
mismatch handled by the delivering owner:

| Exact case name                                                                                | Actual failure boundary                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `retains external launch drafts across detail tabs and reviews the same target and generation` | ExternalRuntime: Versions & updates tab click waits for visible, enabled and stable until 14789 ms action timeout.  |
| `keeps a recommendation beyond eight packages and an explicitly selected alternative visible`  | CatalogDownload: Package combobox click waits for visible, enabled and stable until 14867 ms action timeout.        |
| `does not dismiss the reviewed installation after installation starts`                         | InstallAction: `captureParityState` finite-animation completion poll at line 27, not the disabled-button assertion. |
| `keeps the active installation cancellation reachable inside the busy review`                  | InstallAction: same finite-animation completion poll, after disabled-button assertions.                             |
| `exposes a failed install result outside the dismissed review before another attempt`          | InstallAction: parity screenshot stability wait until 14868.118 ms action timeout.                                  |

The busy-review trace DOM contains `disabled` on Cancel review in both cases;
the failure stacks point into `captureParityState`. Thus these observations do
not establish a broken disabled guard.

On unchanged detached baseline `b12c162a`, selecting the three existing
ExternalRuntime, CatalogDownload and InstallAction browser files reproduced the
first busy-review animation-poll failure: invocation
`5fea8b29-21e5-4a41-a3e8-b2f21ff42668`, 107 passed, one failed, exit 1.
The other four matching cases passed, including slow ExternalRuntime and
CatalogDownload cases (7853.8 and 7500.2 ms). Then narrowing only the file
selection to `src/components/InstallAction.browser.test.tsx` reproduced all three
installation capture failures: invocation
`e142fdf5-9396-414d-8e63-a42d9d8febe1`, 25 passed, three failed, exit 1.
The two animation-poll failures lasted 6072.0 and 6065.5 ms; failed-result
capture lasted 19951.5 ms. This removes cross-file execution as a necessary
condition for those three failures. It does not explain the other two click
stalls. Logs retain both unsuccessful invocations.

Before instrumentation, ranked installation-specific candidates are:

1. The synchronous `requestAnimationFrame` stub in InstallAction `beforeEach`
   conflicts with real Base UI/CSS transition progress. If so, stalled captures
   should show the stub alongside finite pending/nonadvancing animation state;
   an otherwise identical native-frame control should restore progress.
2. Native rendering/frame delivery stalls independently of the application-world
   stub. If so, animation time should stop despite advancing page clocks, and
   using native application frames alone would not reliably restore progress.
3. A finite animation is continually restarted by dialog/focus state. If so,
   successive observations should show replaced animation identities or reset
   timing/target states instead of one progressing animation.

A bounded ignored observation probe will run on the isolated unchanged baseline
file. It records timer/frame function bodies, clocks, button geometry and finite
animation target/timing state. No product/test source, assertions, sleeps or
budgets are changed. Native-frame controls remain proposals until these
observations distinguish them.
