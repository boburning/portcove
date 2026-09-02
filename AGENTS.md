# Portcove agent contract

## Architecture

`portcove-core` is the authoritative implementation of catalog, source, release, installation, update, rollback, backup, library, and launch behavior.

The CLI and Tauri backend are thin adapters over `portcove-core`. Do not duplicate domain or lifecycle logic in either adapter. React owns presentation, interaction, and ephemeral UI state; it must not become an independent authority for installation, library, release, source, or launch state.

Prefer catalog data and existing generic adapters for port-specific facts. Do not add title-specific Rust behavior when the catalog can express the requirement.

Preserve the existing safety invariants around source identity, checksums, archive extraction, symlinks, persistent data, per-port locking, atomic activation, rollback, credentials, and executable trust. Never weaken them to simplify an implementation or satisfy a quality tool.

Read `docs/ARCHITECTURE.md` before a structural or cross-layer change.

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

`just deep` findings are evidence to inspect, not automatic instructions to rewrite code. `cargo-modules` remains advisory while its recorded inherent-item cycle baseline is unresolved.

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
