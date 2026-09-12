---
name: portcove-desktop-verification
description: Reproduce and verify Portcove desktop behavior with isolated native UI runs, logs and screenshots. Use after desktop interactions or presentation changes and for UI qualification.
---

Read [development tooling](../../../docs/DEVELOPMENT-TOOLS.md) and the issue's actual acceptance criteria. Use `just desktop-verify --plan` to inspect the resolved run, then choose the smallest matching `--profile` or repeat `--scenario` for an exact series. The one-command runner checks the desktop doctor and workspace packages, builds only required binaries, allocates isolated ports and output, and invokes the existing native harness. It never installs prerequisites. Keep `just desktop-test` for low-level runs with explicitly selected executables and a new output directory.

Use a fresh library/configuration scope. Never point fixture tests at the user's normal library. Keep real lifecycle behavior in core and distinguish mocked renderer cases from actual Tauri IPC/native runs.

Treat the interactive desktop, keyboard/pointer input, browser profile, installer registrations, Registry state, and native qualification runners as host-wide resources. Separate worktrees and libraries do not isolate them. Before input-driving or Registry-touching scenarios, including audits that launch them indirectly, establish a window without competing user input or another Portcove qualification runner. Preserve contention-affected evidence as inconclusive, do not present a later serialized pass as a code fix, continue noninteractive work where possible, and never capture the user's typed text.

Choose scenarios matching the change: onboarding, unavailable sources, operation progress/cancellation, error recovery, settings persistence, focus order and scaled layouts. Capture the exact executable hash, revision, platform, scenario results, screenshots and logs. Failed and skipped scenarios must remain visible.

For one known behavior, use one exact scenario. Repeat `--scenario` for a tightly related series; use `presentation`, `restart`, `artwork`, or `owned-lifecycle` for those boundaries and `full` only for cross-cutting completion evidence. Setup scenarios needed to create isolated fixture state are not selected-test passes. Use `--require-clean` for final evidence. Do not add native verification to routine local checks, CI, schedules, or background work.

If a validation command is interrupted or its handle is lost, preserve completed prior-stage results and identify the interrupted stage. Inspect retained logs, owned processes, and partial artifacts before restarting or synchronizing a validation checkout. Require terminal completion evidence for the exact resumed revision; file existence alone is insufficient. Preserve incomplete outputs and do not terminate unrelated processes.

Capture driver-owned application and descendant identities before native interaction or restart, including exact executable, PID, creation time, and task/session ownership. When ancestry establishes ownership, validate creation chronology at every edge and reject missing timestamps, cycles, stale identities, or ambiguity. WebDriver session deletion is not process exit: before reusing a browser profile or reconnecting, wait within a shared bound for the captured identities to exit. For intermittent restart failures, retain a small repeated-run report. Do not substitute arbitrary sleeps, forced termination, or profile deletion.

For synthetic failure fixtures, prove that the intended interception or setup took effect before diagnosing product recovery behavior. Record the injected count and exact affected operation without credentials or full payloads, and verify restoration even on failure. Keep fixture failure, product failure, and unrelated intermittent failures distinct.

For native interactions, distinguish durable core commit from rendered completion and post-interaction focus restoration. Before scrolling or changing views, wait for the relevant user-visible completion signals, such as a re-enabled picker and restored focus. If an isolated scenario passes but the combined sequence fails, retain the failed evidence and reproduce that sequence. Do not mask the race with arbitrary sleeps, forced focus, synthetic consent, or longer timeouts.

Use existing browser/computer-use tools for visual inspection where available, following their skills. Browser-only success is not native desktop evidence. Automated accessibility checks supplement keyboard and visual inspection; they cannot establish novice comprehension, physical controller ergonomics or human gameplay.

Run `just check-ui` or `just check` according to the changed layers, and the mandated completion checks. Report scenario coverage and gaps explicitly; do not close intrinsic human requirements with screenshots or synthetic input alone.
