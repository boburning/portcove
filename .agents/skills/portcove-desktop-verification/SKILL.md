---
name: portcove-desktop-verification
description: Reproduce and verify Portcove desktop behavior with isolated native UI runs, logs, and screenshots. Use for explicit owning-issue native acceptance or release qualification, not ordinary presentation edits.
---

Resolve the checkout with `git rev-parse --show-toplevel`. Use this route only for
explicit native acceptance in the owning issue or a release contract.
Inspect `just desktop-verify --plan`, then select one scenario or the smallest
matching profile. The runner checks prerequisites and uses the maintained harness;
it does not provision them. See [native operation](../../../docs/DEVELOPMENT-TOOLS.md#native-desktop-smoke-tests)
for command syntax, not the entire tooling handbook.

Use a fresh isolated library/configuration scope. Interactive input, WebView,
installer registrations and Registry state are shared host resources: establish
an uncontended window and preserve inconclusive contention evidence. Worktrees
do not isolate these resources. Never use the player's normal library.

Bind executable hash/revision/platform and selected scenarios to logs/screenshots.
Inspect images before making visual claims. Keep failed/skipped outcomes visible;
fixtures, native IPC, installed behavior and physical/human observations are distinct.
Preserve owned-process identity and positive exit proof before fixture mutation.
Do not kill foreign or ambiguously owned processes.

For harness engineering or a specific recovery/layout/transport assertion, read
the relevant [operation notes](references/operation-notes.md) and
[qualification boundary](references/qualification-boundaries.md). Hosted acceptance
uses its [specific contract](../../../docs/NATIVE-HOSTED-ACCEPTANCE.md).
Local checks follow [QUALITY](../../../docs/QUALITY.md#required-hosted-baseline).
