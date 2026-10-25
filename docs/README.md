# Portcove documentation

Start with the task you want to complete. Player guides describe the current
product and its limits; contributor contracts explain the owners, checks and
evidence behind it. Live work remains in GitHub issues and the Roadmap Project.

## Play and manage games

| Task                                                               | Start here                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Understand what Portcove does and what is available                | [Player introduction and capabilities](../README.md)                                                                |
| Choose a desktop or CLI download for your operating system and CPU | [Download choices](DOWNLOADS.md) and [published preview notes](#published-technical-previews)                       |
| Install a first port, supply game files and launch                 | [First-play guide](../README.md#your-first-game) and [the observed application journey](media/first-play/README.md) |
| Check files, manage updates or recover retained work               | [Player task guide](../README.md#manage-check-update-and-recover) and [CLI tasks](CLI.md#task-guides)               |
| Upgrade Portcove or recover an application update                  | [Upgrade procedure](UPGRADING.md) and [observed update/recovery journey](media/application-update/README.md)        |
| Understand a term or a verification claim                          | [Glossary](../GLOSSARY.md) and [content-design rules](CONTENT-DESIGN.md)                                            |

## Connect another launcher

Start with [integration levels and boundaries](INTEGRATIONS.md), then follow the
[external-author task path](INTEGRATION-AUTHOR.md): select a compatible packaged
CLI, discover capabilities and schemas, inspect isolated data, review a plan,
execute an authorized operation, diagnose the result and read authoritative
state back. The [CLI guide](CLI.md) owns current commands; the
[schema-history reference](reference/cli-schema-history.md) explains version
boundaries. Published Alpha 2 has an older API than current source examples.

## Published technical previews

- [Portcove 0.1.0-alpha.2](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2)
  is the current immutable prerelease. Read its
  [reviewed notes](releases/0.1.0-alpha.2-release-notes.md) and the
  [Alpha 1 to Alpha 2 upgrade procedure](UPGRADING.md).
- [Portcove 0.1.0-alpha.1](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.1)
  remains available with its [reviewed notes](releases/0.1.0-alpha.1-release-notes.md)
  and frozen evidence.

| Authority                                                         | Owns                                                                                                                                      | Does not own                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Portcove Roadmap](https://github.com/users/boburning/projects/1) | Current work, priority, horizon, status, target release, blockers, deferred work, and new-port pipeline                                   | Durable implementation details or actual catalog support |
| GitHub issues                                                     | Implementation-ready specifications, discussion, dependencies, acceptance criteria, and completion evidence                               | Priority or release forecasts                            |
| [`catalog.json`](../crates/portcove-core/catalog/catalog.json)    | Actual ports, platforms, channels, sources, adapters, and qualification evidence                                                          | Product-level release scope                              |
| Repository documentation                                          | Stable architecture, security, catalog admission, release-stage definitions, qualification policy, contributor rules, and dated snapshots | A mutable backlog                                        |

## Start by task

For contributors and maintainers, these are current contracts. Proposed behavior belongs in its issue and live
Project item until implemented; dated outcomes remain historical evidence.

| Task                                                                               | Current contract                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture or cross-layer authority                                              | [Architecture and authority boundaries](ARCHITECTURE.md)                                                                                                                                                          |
| Issue intake, dependencies, Project fields, or readiness                           | [Project governance](PROJECT-GOVERNANCE.md)                                                                                                                                                                       |
| Branch, PR, independent review, or guarded merge                                   | [Contribution conventions](CONTRIBUTION-CONVENTIONS.md)                                                                                                                                                           |
| Focused tests, selected CI, protected-policy validation, or shared Rust contention | [Quality workflow](QUALITY.md)                                                                                                                                                                                    |
| Tool bootstrap, repository skills, native desktop sessions, or retained evidence   | [Development tooling and repository skills](DEVELOPMENT-TOOLS.md)                                                                                                                                                 |
| Workspace layout, caches, worktrees, or cleanup                                    | [Development storage](DEVELOPMENT-STORAGE.md)                                                                                                                                                                     |
| Catalog admission, port qualification, or support facts                            | [Catalog admission and qualification](CATALOG.md)                                                                                                                                                                 |
| Definition delivery or catalog signing                                             | [Definition delivery](DEFINITION-DELIVERY.md) and [signed catalog delivery](SIGNED-CATALOG.md)                                                                                                                    |
| Release, packaging, application signing, publication, or rollback                  | [Release process](RELEASING.md), [future delivery contract](DELIVERY.md), [application updater trust](UPDATER-TRUST.md), and [upgrading](UPGRADING.md)                                                            |
| CLI or external frontend integration                                               | [CLI machine contract](CLI.md), [integration contract](INTEGRATIONS.md), and [integration author guide](INTEGRATION-AUTHOR.md)                                                                                    |
| Repository rules or hosted settings                                                | [Repository settings](REPOSITORY-SETTINGS.md)                                                                                                                                                                     |
| Security reports or vulnerability boundaries                                       | [Security policy](../SECURITY.md)                                                                                                                                                                                 |
| Product targets and release-stage vocabulary                                       | [Product roadmap and release stages](ROADMAP.md)                                                                                                                                                                  |
| Domain terminology, content wording or a naming migration                          | [Glossary](../GLOSSARY.md), [content design](CONTENT-DESIGN.md), [domain guidance](agents/domain.md) and [source observation/registration decision](adr/0005-distinguish-source-observations-and-registration.md) |

`RELEASING.md` is the current protected release process. `DELIVERY.md` describes
the approved future delivery contract; it does not activate production updating,
signing, or publication. `UPDATER-TRUST.md` owns application self-update trust and
replacement, while game installation and update behavior remains core-owned.

For starting or resuming work in a healthy checkout, use the
[warm single-session workflow](DEVELOPMENT-TOOLS.md#warm-single-session-workflow),
including its compact task/reviewer handoff and ownership-first diagnosis.

Use the [opt-in coverage reference](reference/test-coverage.md) to investigate
measured Node, frontend unit, or Chromium branches with retained source mappings.

## Actual application journeys

- [First installation and real game launch](media/first-play/README.md): isolated
  Windows development app, authorized game file, actual title and return.
- [Installed application update and staging recovery](media/application-update/README.md):
  Windows test packages and disposable feed, adjacent replacement and confirmed
  restart. These captures do not imply the same features are in published Alpha 2.

## Product and presentation guidance

- [Content-design contract](CONTENT-DESIGN.md)
- [Domain glossary](../GLOSSARY.md)
- [Design system](DESIGN-SYSTEM.md)
- [Theme contract](THEME.md)
- [Desktop localization and authoring](LOCALIZATION.md)
- [Brand assets](BRAND-ASSETS.md)
- [Competitive review](GUI-COMPETITIVE-REVIEW.md)
- [Development storage](DEVELOPMENT-STORAGE.md)

## Historical evidence

Dated audits, completed migrations, and qualification or release evidence that
remain useful live under [`docs/archive/`](archive/). Obsolete planning sources
remain available through Git history and must not be treated as current
authority. Release-readiness snapshots are immutable outputs under
[`docs/releases/`](releases/) and do not replace the live Project.

Representative historical starting points include the
[September 2 independent re-audit](archive/2026-09-02-comprehensive-independent-reaudit.md),
[September 3 prelaunch plan](archive/2026-09-03-prelaunch-feature-implementation-plan.md),
[September 4 supported-source plan](archive/2026-09-04-supported-source-provenance-implementation-plan.md),
and [September 4 UX audit](archive/2026-09-04-ux-copy-content-interaction-audit.md).
The [September 25 desktop capability and state inventory](archive/2026-09-25-desktop-capability-state-inventory.md)
maps the current #206 destinations and names the remaining evidence limits.
