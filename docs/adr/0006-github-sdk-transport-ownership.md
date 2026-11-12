# GitHub SDK transport ownership

Accepted November 4, 2026; implementation owner: [#4319](https://github.com/boburning/portcove/issues/4319).

Use configured Octokit for Node and direct Reqwest dispatch for Core. One
neutral Node factory creates credential-scoped clients. Domain owners supply
authorization, budgets, deadlines and cancellation. They retain completeness,
cache eligibility, recovery and release policy.

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

The [dated source inventory](../evidence/github-sdk-source-inventory-2026-11-04.md)
records delivered source boundaries and the remaining appointed execution paths.
Successor qualification and retirement stay with #534. The source guard checks
for new legacy CLI API references while those dependencies are open.

## November 11 native transport comparison

[#4556](https://github.com/boburning/portcove/pull/4556) put metadata GETs and
device OAuth POSTs through Octocrab over Core's Reqwest clients. In 0.54.9,
`_get_with_headers` is a public low-level operation that returns raw responses.
Core used it and raw `execute`, with its own metadata models, bounded paging,
cache and credential handling. Typed SDK calls would move response processing
ahead of those bounds or require another adapter. Direct dispatch removes the
per-request SDK service and body conversion while keeping Core's raw status,
headers and streaming response. Metadata keeps the explicit GitHub API version.
The separate API and anonymous device pools
retain the same connection, read-idle and full-request deadlines and refuse
redirects and retries. Release downloads keep their separate policy.

Compared with the locked audit baseline `a2814fe75`, the change removes
19 net production Rust lines and three direct Cargo declarations. Default normal-edge
dependency graphs counted unique package/version pairs using `cargo tree
--locked -e normal --target <triple> -p <package>`.

| Target         | CLI before → after | Desktop before → after |
| -------------- | -----------------: | ---------------------: |
| Windows x86-64 |          248 → 235 |              347 → 338 |
| Linux x86-64   |          297 → 283 |              426 → 416 |
| macOS Arm64    |          247 → 233 |              348 → 338 |
| Android Arm64  |          251 → 236 |              345 → 335 |

Reqwest still uses `http`, `serde_urlencoded`, `tower` and `tower-http`.
`chrono` leaves these normal-edge graphs and remains in the workspace lockfile
through `serde_with`. The release-tools normal dependency graph is unchanged
on these targets. Graphs describe resolved inputs. They do not measure
compilation time, linked size or native execution.
