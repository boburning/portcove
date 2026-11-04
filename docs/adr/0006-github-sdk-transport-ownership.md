# GitHub SDK transport ownership

Accepted November 4, 2026; implementation owner: [#4319](https://github.com/boburning/portcove/issues/4319).

Replace maintained GitHub API transport with configured Octokit for Node and
Octocrab inside Core. Use one neutral Node factory creating credential-scoped
clients. Domain owners supply authorization, budgets, deadlines and cancellation;
they retain completeness, cache eligibility, recovery and release policy.

The foundation migrates a production REST inventory/intake chain and the four
ordinary metadata readers. Each caller family removes superseded helpers and
CLI-shaped fixtures as it moves. Unmigrated callers retain their existing bounded
transport until their slice; this is a delivery sequence, not a permanent adapter.
No synchronous API bridge or new concurrency is introduced.

Metadata is bounded before SDK parsing. Actual locked-package tests protect
stream failures, cancellation, retry accounting, safe diagnostics and response
evidence. Narrow asynchronous domain fakes protect consumed output and recovery
contracts. Manifest/lock changes select the SDK suite. Pure error/result shaping
and retained non-API CLI execution remain separate from network construction.

Writes get one attempt followed by reconciliation. Eligible reads get at most
three total attempts under their original operation deadline and remaining
budgets; caller recovery cannot reset an exhausted logical request. Distinct
stability observations remain domain reads. Provider-required rate-limit waits
are never shortened, and unusable waits produce typed deferral.

Explicit credentials cannot fall back, anonymous clients inherit none, and only
eligible local tooling resolves an existing CLI login once per command. The
isolated publisher retains trusted workflow-local policy without importing a
checkout or installing packages. Native device endpoints retain an anonymous
client distinct from authenticated API access.

This decision does not reopen #4306, change #534's retirement ownership or
production pause, or authorize release activation. Native, workflow and remaining
caller-family delivery are tracked by #4319, not implied by foundation tests.
