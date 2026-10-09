# Engineering techniques

Use the installed Matt Pocock skills as techniques within the existing
[single-runner cycle](../../AGENTS.md#execution-loop). The local runner owns
implementation; skills add no coordinator, approval stage or validation gate.
Repository architecture, QUALITY.md and contribution conventions remain
authoritative, including intentional thin CLI/Tauri adapters and React's
presentation role.

## Select by the current task

| Task | Technique |
| --- | --- |
| Behavior change or reproducible bug fix | `tdd`: one failing behavior test through an appropriate existing public interface, minimal implementation, then the next slice. |
| Nontrivial or recurring local/CI failure, timeout or performance problem | `diagnosing-bugs`: preserve the failure, build a discriminating reproduction, test predictions and measure before repairing. |
| Current outcome requires interface or responsibility decisions | `codebase-design`: consult the relevant interface/design principles. |
| Change agent-facing documentation | `writing-for-agents`: short conditional pointers and targeted detail with checkable completion. |
| Existing independent-review stage | `code-review` principles: cover both canonical specification and repository standards in the same review. |

Load only the relevant installed definition and necessary references. Respect
installed invocation controls; explicitly invoke when implicit invocation is
disabled. Reuse the existing setup. Report an unavailable skill once and proceed
through the normal repository workflow. Plugin caches and invocation settings
remain unchanged; this document adapts behavior without duplicating skill bodies
or names. Grilling, broad architecture surveys, wayfinder, implement-spec,
retrospectives and spec/ticket generation require an explicitly selected relevant
task. Ordinary issue maintenance uses the existing Roadmap workflow.

## Apply within authorized scope

Choose existing public test interfaces, focused checks and routine implementation
details from the canonical specification and contracts. The owner's authorization
supplies the TDD skill's seam agreement within that scope; record what the selected
test catches and misses without asking for routine confirmation. Escalate only a
genuinely unresolved decision, manual observation or ungranted authority.

Retain useful failing-test or reproduction evidence before fixes where feasible.
Label confirmed reproduction, synthetic test and unverified original scenario
separately. A narrow passing test qualifies its own boundary; rerun the original
scenario before claiming its failure resolved. For failures, prefer experiments
that distinguish causes over unchanged retries. Existing resource protections,
permissions and budgets govern stress loops and instrumentation. Evidence may
support a bounded policy change through its normal protected transition; it never
authorizes blind timeout increases or weaker checks.

Normally use one short-lived independent non-writing reviewer for both spec and
standards. Supply the exact source/base and relevant material through the existing
[reviewer brief](../DEVELOPMENT-TOOLS.md#warm-single-session-workflow). The writer
repairs findings; return the delta and affected interactions to that reviewer.
Preserve existing review exceptions and model/cost choices. Writer self-review
does not establish independence.

When available authority or resources leave no actionable repair, preserve the
exact branch/head, evidence, blocker, remaining acceptance and resume condition
in the owning issue/PR. Commit, push and use a draft PR where available; continue
the highest-value independent approved work during the same session. Keep one
actively edited candidate and freeze clean waiting candidates. Use focused tests,
complete diff-selected validation, required exact-head CI, distinct acceptance
and guarded merge under the existing contracts; repeat only invalidated work.
