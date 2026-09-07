---
name: portcove-desktop-verification
description: Reproduce and verify Portcove desktop behavior with isolated native UI runs, logs and screenshots. Use after desktop interactions or presentation changes and for UI qualification.
---

Read [development tooling](../../../docs/DEVELOPMENT-TOOLS.md) and the issue's actual acceptance criteria. Use `just doctor` to inspect prerequisites and `just desktop-test` for the native smoke harness. The harness requires explicitly selected executables and a new output directory; consult its documented options.

Use a fresh library/configuration scope. Never point fixture tests at the user's normal library. Keep real lifecycle behavior in core and distinguish mocked renderer cases from actual Tauri IPC/native runs.

Choose scenarios matching the change: onboarding, unavailable sources, operation progress/cancellation, error recovery, settings persistence, focus order and scaled layouts. Capture the exact executable hash, revision, platform, scenario results, screenshots and logs. Failed and skipped scenarios must remain visible.

Use existing browser/computer-use tools for visual inspection where available, following their skills. Browser-only success is not native desktop evidence. Automated accessibility checks supplement keyboard and visual inspection; they cannot establish novice comprehension, physical controller ergonomics or human gameplay.

Run `just check-ui` or `just check` according to the changed layers, and the mandated completion checks. Report scenario coverage and gaps explicitly; do not close intrinsic human requirements with screenshots or synthetic input alone.
