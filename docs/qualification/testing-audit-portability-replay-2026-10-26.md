# No-global frontend portability replay: retain the current route

Audit 21 makes narrowing conditional on parity evidence. Retain the existing complete macOS replay: its successful observed route preserves contributor setup and keyboard/layout behavior, while no compatible deterministic-result substitution has been established. No result is reused and no speedup is claimed.

## Observed producer and identity

The genuine scheduled [qualification 40312434217/a1](https://github.com/boburning/portcove/actions/runs/40312434217) checked source and checkout `efc42c654972d9094fef2b94337fc560c80d436a`. The complete inventory has 39 jobs. The parent run failed; its successful [macOS no-global job 121536772932](https://github.com/boburning/portcove/actions/runs/40312434217/job/121536772932) is separate evidence.

That job first required `command -v vp` to fail, before frozen dependency installation. It then used repository-local `pnpm exec vp toolchain`, the maintained browser bootstrap and `pnpm verify:frontend`. This remains real setup on a macOS ARM64 host, rather than a simulated missing executable in a prepared Linux process.

The [structured packet](testing-audit-portability-replay-2026-10-26.json) binds the exact run, attempt, source, checkout, job, runner and raw-log hash. Browser-bootstrap artifact 12646080805 was downloaded and independently matched GitHub's SHA256 `271e27b47d060de904a9d367bd9fa173ff240926e4925fb0f65189e8e570b2a3`. All five contained records bind that same producer. They retain Playwright 1.64.1, executable revision 1248, actual Chromium 156.0.8078.4 and an absent executable before installation.

## Setup, behavior and remaining work

| Observation                                    | Elapsed |
| ---------------------------------------------- | ------: |
| Frozen dependency installation step            |     12s |
| Browser bootstrap step                         |     10s |
| Browser installer, inside bootstrap            |  8.045s |
| Browser launch, inside bootstrap               |  0.777s |
| Complete frontend verification step            |    573s |
| Unit runner, inside verification               |  34.61s |
| Browser runner, inside verification            | 498.98s |
| Reported production build, inside verification |   1.64s |

These are nested measurements, not additive stages. GitHub step timestamps have whole-second precision. The approximate 39.41s difference between complete verification and its two runners includes static checks, content generation, orchestration, waits and other unisolated work. It is neither measured static cost nor an attributable saving. CPU, disk and network-only costs are not isolated.

The reporters retain 943 passed unit cases and one skip, plus 1476 passed browser cases and one skip across the ordinary, locale and forced-color projects. Both invocation contexts report zero invalid, omitted or unhandled-error observations. The 2421 original case observations reconcile by invocation plus runner identity; parameterized definitions can share a definition hash.

The packet preserves 20 exact browser witnesses, including all five display-recovery cases, all six compact-navigation cases and the Chrome shortcut cases. Display recovery uses the actual host's macOS editing gesture (`Meta+ArrowDown`) when appropriate. Layout, locale, forced-color and shortcut work remains executed on this host. Browser execution and adapter fixtures do not establish installed Tauri or native UI acceptance; the two original skips remain skips.

## Reconsideration conditions

The current Vite+ task graph executes frontend static checks, content checks, unit tests, three browser projects and the production build with task caching disabled. A successful result from a different platform is not sufficient substitution evidence. Before narrowing, identify the exact deterministic stage, measure its independently attributable cost, and bind complete source/generated inputs, lockfile, tool versions, relevant configuration, platform/environment sensitivity and intended consumer to the producer receipt. Verify parity on the real no-global macOS route and fail closed on missing, stale or incompatible evidence.

Contributor setup and macOS keyboard/layout assertions must remain real even if such a deterministic result is later reusable. Until those conditions hold, preserving the observed complete replay is the bounded disposition. This report establishes no cross-platform equivalence, performance gain, full scheduled baseline, native acceptance or release qualification.
