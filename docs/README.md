# Portcove documentation

This map separates stable repository contracts from live planning and
machine-readable product state.

| Authority | Owns | Does not own |
|---|---|---|
| [Portcove Roadmap](https://github.com/users/boburning/projects/1) | Current work, priority, horizon, status, target release, blockers, deferred work, and new-port pipeline | Durable implementation details or actual catalog support |
| GitHub issues | Executable specifications, discussion, dependencies, acceptance criteria, and completion evidence | Priority or release forecasts |
| [`catalog.json`](../crates/portcove-core/catalog/catalog.json) | Actual ports, platforms, channels, sources, adapters, and qualification evidence | Product-level release scope |
| Repository documentation | Stable architecture, security, catalog admission, release-stage definitions, qualification policy, contributor rules, and dated snapshots | A mutable backlog |

## Stable contracts

- [Architecture and authority boundaries](ARCHITECTURE.md)
- [Catalog admission and qualification](CATALOG.md)
- [CLI machine contract](CLI.md)
- [Project governance](PROJECT-GOVERNANCE.md)
- [September 2 comprehensive independent re-audit (historical evidence)](archive/2026-09-02-comprehensive-independent-reaudit.md)
- [September 4 supported-source/provenance plan (historical evidence)](archive/2026-09-04-supported-source-provenance-implementation-plan.md)
- [September 4 final UX copy/content/interaction audit (historical evidence)](archive/2026-09-04-ux-copy-content-interaction-audit.md)
- [September 3 prelaunch feature plan (historical evidence)](archive/2026-09-03-prelaunch-feature-implementation-plan.md)
- [Product roadmap and release stages](ROADMAP.md)
- [Quality workflow](QUALITY.md)
- [Release process](RELEASING.md)
- [Signed catalog delivery](SIGNED-CATALOG.md)
- [Security policy](../SECURITY.md)

## Product and presentation guidance

- [Design system](DESIGN-SYSTEM.md)
- [Theme contract](THEME.md)
- [Brand assets](BRAND-ASSETS.md)
- [Competitive review](GUI-COMPETITIVE-REVIEW.md)
- [Development storage](DEVELOPMENT-STORAGE.md)

## Historical evidence

Superseded ledgers, cutoff lists, upstream inventories, and qualification
narratives live under [`docs/archive/`](archive/). They remain useful evidence
but must not be edited as current planning. Release-readiness snapshots are
immutable outputs under [`docs/releases/`](releases/) and do not replace the
live Project.
