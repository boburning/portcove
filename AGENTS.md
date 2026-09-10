# Portcove agent contract

## Architecture

`portcove-core` is the authoritative implementation of catalog, source, release, installation, update, rollback, backup, library, and launch behavior.

The CLI and Tauri backend are thin adapters over `portcove-core`. Do not duplicate domain or lifecycle logic in either adapter. React owns presentation, interaction, and ephemeral UI state; it must not become an independent authority for installation, library, release, source, or launch state.

Core, CLI, and Desktop remain in this repository while shipping as independently usable interfaces and separately packaged deliverables. Do not split the repository or make Desktop shell out to the standalone CLI to manufacture reuse; preserve CLI -> core, Tauri backend -> core, and React -> Tauri IPC.

Prefer catalog data and existing generic adapters for port-specific facts. Do not add title-specific Rust behavior when the catalog can express the requirement.

Preserve the existing safety invariants around source identity, checksums, archive extraction, symlinks, persistent data, per-port locking, atomic activation, rollback, credentials, and executable trust. Never weaken them to simplify an implementation or satisfy a quality tool.

Read `docs/ARCHITECTURE.md` before a structural or cross-layer change.

## Planning and issue workflow

GitHub Projects is the sole live authority for current work, priority, horizon,
status, blockers, deferred work, target release, release commitment, and the
new-port pipeline. `Target release` is a forecast; `Release commitment` says
whether the outcome is Required or Opportunistic for that target. Unset
relevant work is unclassified, not silently optional.
Before substantial work, read the linked issue, its dependencies, and its live
Portcove Roadmap fields. If no durable issue exists for actionable work, create
or promote one using the workflow in `docs/PROJECT-GOVERNANCE.md`.

Move active work to In progress and evidence-ready work to Validating. Link the
pull request to the issue and update Project state as implementation changes.
Codex owns implementation, execution of acceptance checks, failure
investigation, bounded repair, review, and exact evidence within the authorized
scope. The normal path is implement, execute checks, investigate, repair,
review in a distinct pass, record evidence, and complete the authorized workflow.
Do not ask the owner to repeat adequate automated checks. Acceptance specifies
the observation, scope, and environment rather than naming a human actor unless
human participation is intrinsic. Build the smallest reusable automation when
practical; do not invent a large test platform before a bounded harness can
establish the claim.

Do not mark work Done until its acceptance criteria have matching test, CI, and
intrinsically required human or physical-platform evidence. Keep deterministic,
isolated integration, packaged execution, physical-device execution, and human
observations distinct. A physical-device automated run is device evidence, not
human gameplay or novice-comprehension evidence.

A user request to implement or continue work authorizes Codex to complete the
routine issue, implementation, validation, review, PR, and normal merge workflow
within that scope without another owner approval. A separate review means a
distinct review pass after implementation; Codex may perform it autonomously.
It does not inherently require a human reviewer or a second agent. Inspect the
final diff against the current base, check acceptance and safety invariants,
repair substantive findings, and record the reviewed commit, scope, findings,
and re-review result. Passing tests alone is not a review.

Merge routine work only after mandatory CI, that explicit review result,
substantive finding repair, and current-revision/authority confirmation. Honor
any additional reviewer or approval requirement enforced by the trusted
repository rules. Never use administrator bypass for the routine path.

Ask the owner only when a concrete blocker cannot be resolved within the
authorized scope, evidence intrinsically requires their manual participation,
or an action requires authority they have not already granted. Explain the
specific missing input, observation, or authority and continue unrelated
authorized work. Do not turn optional gameplay evidence or a review Codex can
perform into an owner approval gate. Existing authorization persists; do not
request it again.

Changes to protected acceptance, merge authority, signing or publication
permissions, credentials, or other meaningful boundaries require explicit
owner authorization for that change. Candidate code cannot define, remove, or
approve its own trusted gate, and privileged workflows must not execute
untrusted candidate code or instructions.

Do not create or maintain TODO documents, JSON work ledgers, mutable status
files, milestone mirrors, or another planning authority. Repository docs own
stable contracts and dated release snapshots; `catalog.json` owns actual port
support and qualification evidence.

## Contribution metadata

Follow `docs/CONTRIBUTION-CONVENTIONS.md` for branch names, authored commit
subjects, pull request titles and descriptions. Use the configured
Conventional-lite title, a project-purpose branch prefix rather than an agent
name, and the five pull request sections in their defined order. Drafts may
record pending evidence; update the same description with exact final results
and the reviewed head before marking the pull request ready. After creating or
updating a pull request, run `just pr-check <number-or-url>` and resolve or
explain its advisory findings. This advisory check never replaces acceptance,
review, CI, Roadmap state or merge-authority requirements.

### Delivery planning

Public beta and 1.0 are readiness commitments, separate from versions and the
Stable/Preview application channels. Keep legacy targets for historical evidence;
active migrations must preserve every Required identity and genuine dependency.
Read docs/DELIVERY.md for the approved future delivery contract. Planning does
not activate the updater or unattended signing/publication; existing protected
release procedures remain effective until separately authorized and proven.

### Architecture evolution

This is the current tested design, not a permanent crate map. Early development may expose a better boundary, a host concern that should remain in an adapter, or a domain that deserves its own focused crate. Change the contract deliberately when implementation evidence supports it.

An intentional architecture change must preserve one clear owner for each piece of durable domain state and every safety invariant above. In the same change, document the new boundary and tradeoffs in `docs/ARCHITECTURE.md`, update the metadata architecture rules and tests, and migrate callers without leaving parallel authorities behind. Do not retain unpublished internal APIs solely for compatibility; do preserve documented CLI behavior and version machine-facing changes when external consumers can observe them.

“Thin adapter” means no duplicated domain authority. It does not prohibit host integration, process lifecycle, secure credential access, file pickers, event translation, or presentation-oriented aggregation where those responsibilities naturally belong at the boundary.

## Quality workflow

- Rust change: `just check-rust`
- React or TypeScript change: `just check-ui`
- Cross-stack change: `just check`
- Substantial completion: `just audit`
- Broad refactor, public API or dependency restructuring, significant abstraction, or architecture change: `just deep`

`just deep` findings are evidence to inspect, not automatic instructions to rewrite code. `just cycles` is an explicit, advisory architecture investigation; it is excluded from routine CI and audits while its recorded inherent-item cycle baseline is unresolved.

## Fixing failures

Fix the root cause of new deterministic failures. Do not add `allow`, `ignore`, suppression comments, exclusion globs, baselines, or dependency exceptions merely to make a tool pass. A narrow configuration exception must name an intentional behavior and be documented in `docs/QUALITY.md`.

Existing structural findings outside the requested task do not justify unrelated refactoring. Do not make a known hotspot materially worse; improve one when that naturally supports the requested work.

## Automatic fixes

`cargo fmt` is safe. Use `cargo-shear` fixes only when the tool identifies them as mechanical. Use rscheck writes only for clearly safe machine-applicable changes, and never run its unsafe rewrite mode autonomously.

After any automated rewrite, inspect the diff and rerun the relevant tests and quality command.

Never automatically delete public APIs because Hawk marks them dead, merge implementations because duplication analysis flags them, split modules solely because they are large, introduce abstractions solely to reduce complexity, suppress dependency or security findings, or weaken Portcove safety mechanisms.

## Code quality

Prefer cohesive responsibilities, clear data flow, narrow public APIs, existing abstractions over duplicate helpers, domain-driven boundaries, and explicit behavior over clever compression.

Before adding a helper, parser, service operation, adapter, utility, data type, or abstraction, search for equivalent functionality. When new work crosses a complexity threshold, first decide whether the responsibility belongs in an existing neighboring abstraction. Do not mechanically extract tightly coupled functions just to lower a metric.

Keep changes scoped. Report unrelated structural opportunities separately.
