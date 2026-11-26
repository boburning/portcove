# Portcove documentation

Choose the task you want to complete. Player guides explain what Portcove does
today. Contributor guides explain who owns each part, what to test, and what to
record. Find current work in GitHub issues and the Roadmap Project.

## Play and manage games

| Task                                                               | Start here                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Understand what Portcove does and what is available                | [Player introduction and capabilities](../README.md)                                                                |
| Choose a desktop or CLI download for your operating system and CPU | [Download choices](DOWNLOADS.md) and [published preview notes](#published-technical-previews)                       |
| Install a first port, supply game files and launch                 | [First-play guide](../README.md#your-first-game) and [the observed application journey](media/first-play/README.md) |
| Check files, manage updates or recover retained work               | [Player task guide](../README.md#manage-check-update-and-recover) and [CLI tasks](CLI.md#task-guides)               |
| Upgrade Portcove or recover an application update                  | [Upgrade procedure](UPGRADING.md) and [observed update/recovery journey](media/application-update/README.md)        |
| Understand a term or a verification claim                          | [Glossary](../GLOSSARY.md) and [content-design rules](CONTENT-DESIGN.md)                                            |

Discover and `portcove catalog listings` show the full catalog of projects.
For definitions that describe how Portcove manages a port, use `catalog list`,
`show`, or `export`. Check each entry for install options, compatible game files,
gameplay tests, and who manages updates and backups.
See [catalog and support](../README.md#catalog-and-support).

<a id="connect-another-launcher"></a>

## Integration authors

Read the [integration levels](INTEGRATIONS.md). Follow the
[external-author guide](INTEGRATION-AUTHOR.md) to choose a compatible CLI and
inspect its capabilities and schemas. Use an isolated library to try the
workflow. Review the plan before you run an authorized operation. Check its
result, then ask the CLI for the current state. The [CLI guide](CLI.md) lists
current commands. The [schema history](reference/cli-schema-history.md) shows
when they changed. Check the API and capabilities of the CLI you chose.

## Published technical previews

Use [Download and verify Portcove](DOWNLOADS.md#published-previews) for the
versioned preview, nightly builds and platform-specific CLI availability. Each
[GitHub release](https://github.com/boburning/portcove/releases) lists its actual
packages and checksums. The [Alpha release records](releases/README.md) and
[Alpha migration instructions](UPGRADING.md#historical-alpha-1-to-alpha-2-migration)
remain available for older libraries.

| Authority                                                                                                                           | Owns                                                                                                                                                        | Does not own                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Portcove Roadmap](https://github.com/users/boburning/projects/1)                                                                   | Current work, priority, horizon, status, target release, blockers, deferred work, and new-port pipeline                                                     | Durable implementation details or actual catalog support |
| GitHub issues                                                                                                                       | Implementation-ready specifications, discussion, dependencies, acceptance criteria, and completion evidence                                                 | Priority or release forecasts                            |
| [Per-ID records](CATALOG.md#adding-or-changing-a-port) and generated [`catalog.json`](../crates/portcove-core/catalog/catalog.json) | Authored listing/integration facts and strict operational definitions, including declared platforms, channels, sources, adapters and qualification evidence | Product-level release scope                              |
| Repository documentation                                                                                                            | Stable architecture, security, catalog admission, release-stage definitions, qualification policy, contributor rules, and dated snapshots                   | A mutable backlog                                        |

<a id="start-by-task"></a>

## Contributors and maintainers

For contributors and maintainers, these are current contracts. Proposed behavior belongs in its issue and live
Project item until implemented; dated outcomes remain historical evidence.

| Task                                                                               | Current contract                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture or cross-layer authority                                              | [Architecture and authority boundaries](ARCHITECTURE.md)                                                                                                                                                          |
| Issue intake, dependencies, Project fields, or readiness                           | [Project governance](PROJECT-GOVERNANCE.md)                                                                                                                                                                       |
| Branch, PR, independent review, or guarded merge                                   | [Contribution conventions](CONTRIBUTION-CONVENTIONS.md)                                                                                                                                                           |
| Focused tests, selected CI, protected-policy validation, or shared Rust contention | [Quality workflow](QUALITY.md)                                                                                                                                                                                    |
| Tool bootstrap, repository skills, native desktop sessions, or retained evidence   | [Development tooling and repository skills](DEVELOPMENT-TOOLS.md)                                                                                                                                                 |
| Agent delegation, reviewer models, or model recommendation upkeep                  | [Agent model selection](DEVELOPMENT-TOOLS.md#agent-model-selection)                                                                                                                                               |
| Workspace layout, caches, worktrees, or cleanup                                    | [Development storage](DEVELOPMENT-STORAGE.md)                                                                                                                                                                     |
| Make a port work with launchers                                                    | [Game-author quick start](INTEGRATION-AUTHOR.md#make-your-port-work-with-launchers)                                                                                                                               |
| Catalog admission, port qualification, or support facts                            | [Per-ID authoring, admission and qualification](CATALOG.md#adding-or-changing-a-port)                                                                                                                             |
| Definition delivery or catalog signing                                             | [Definition delivery](DEFINITION-DELIVERY.md) and [signed catalog delivery](SIGNED-CATALOG.md)                                                                                                                    |
| Read-only public game discovery and comparison pages                               | [Generated public catalog](PUBLIC-CATALOG.md)                                                                                                                                                                     |
| CLI or external frontend integration                                               | [CLI machine contract](CLI.md), [integration contract](INTEGRATIONS.md), and [integration author guide](INTEGRATION-AUTHOR.md)                                                                                    |
| Repository rules or hosted settings                                                | [Repository settings](REPOSITORY-SETTINGS.md)                                                                                                                                                                     |
| Limits, their class, effect and planned disposition                                | [Restriction register](RESTRICTION-REGISTER.md)                                                                                                                                                                   |
| Security reports or vulnerability boundaries                                       | [Security policy](../SECURITY.md)                                                                                                                                                                                 |
| Product targets and release-stage vocabulary                                       | [Product roadmap and release stages](ROADMAP.md)                                                                                                                                                                  |
| Domain terminology, content wording or a naming migration                          | [Glossary](../GLOSSARY.md), [content design](CONTENT-DESIGN.md), [domain guidance](agents/domain.md) and [source observation/registration decision](adr/0005-distinguish-source-observations-and-registration.md) |

## Release and operations

| Task                                                              | Current owner                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Release, packaging, application signing, publication, or rollback | [Release process](RELEASING.md), [future delivery contract](DELIVERY.md), [application updater trust](UPDATER-TRUST.md), and [upgrading](UPGRADING.md) |
| Daily port discovery and canonical intake                         | [Daily discovery](DAILY-PORT-DISCOVERY.md)                                                                                                             |
| Observe upstream changes and retained release health              | [Upstream observations](UPSTREAM-OBSERVATIONS.md)                                                                                                      |
| Maintenance inventory storage, backup, restore and daily run      | [Maintenance inventory store](MAINTENANCE-STORE.md)                                                                                                    |
| Run explicit on-demand hosted native acceptance                   | [Hosted native acceptance](NATIVE-HOSTED-ACCEPTANCE.md)                                                                                                |

Discovery and observation do not admit a port or confer support. Native acceptance
retains its exact scenario, candidate and host scope.

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
- [Integrated UI composition](INTEGRATED-UI-DESIGN.md) and [design system](DESIGN-SYSTEM.md)
- [Theme contract](THEME.md)
- [Desktop localization and authoring](LOCALIZATION.md)
- [Brand assets](BRAND-ASSETS.md)
- [Development storage](DEVELOPMENT-STORAGE.md)

## Proposed designs

Design records are proposals, not current contracts. Each names the contracts it
would change and stays proposed until its own pull requests land.

- [Supported capability contracts as the unit of integration](design/INTEGRATION-CONTRACTS.md)
- [Scaling signed catalog distribution](design/CATALOG-DISTRIBUTION-SCALING.md)
- [Automatic managed acquisition from upstream releases](design/AUTOMATIC-MANAGED-ACQUISITION.md)

## Historical evidence

Look in [qualification](qualification/) for dated port and platform observations,
[evidence](evidence/) for captured application journeys, and [reviews](reviews/)
for copy and product reviews. Each record identifies the build, host or inputs it
covered. Use [archive](archive/) for older audits and migrations, [release
records](releases/) for frozen release evidence and the live Project for current work.

The [September 1 GUI competitive review](GUI-COMPETITIVE-REVIEW.md) and
[former UI implementation contract](UI-UX-IMPLEMENTATION.md) preserve historical
provenance; their wrappers link to current design owners.

Representative historical starting points include the
[September 2 independent re-audit](archive/2026-09-02-comprehensive-independent-reaudit.md),
[September 3 prelaunch plan](archive/2026-09-03-prelaunch-feature-implementation-plan.md),
[September 4 supported-source plan](archive/2026-09-04-supported-source-provenance-implementation-plan.md),
and [September 4 UX audit](archive/2026-09-04-ux-copy-content-interaction-audit.md).
The [September 25 desktop capability and state inventory](archive/2026-09-25-desktop-capability-state-inventory.md)
maps the current #206 destinations and names the remaining evidence limits.

The [November 17 original-game catalog review](archive/2026-11-17-game-first-catalog-review.md)
records the complete audited identity relationships and explicit boundary decisions
for #8076; current delivery and application acceptance remain on the issue.
