# Contributing

Keep shared download, transaction, storage, and lifecycle rules in Core. Describe
port facts in the catalog when you can. Keep the CLI stable for external clients.
If catalog data and existing adapters cannot describe the integration, use a
small Core adapter for that game. Keep game-specific policy out of the CLI and
React app.

External clients use the supported CLI. Keep the database, private Rust APIs,
and desktop state private. Before you propose a frontend, exporter, or plugin,
read [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). Name the recurring problem the
CLI leaves open. State the capability level, who maintains it, its maintenance
category, supported environments, evidence, and limits. Check each
integration's support status separately. A frontend follows the same
Portcove platform limits.

## Start with the roadmap

Search the public [Portcove Roadmap](https://github.com/users/boburning/projects/1)
before proposing work. Maintainers can create a newly discovered port's durable
issue directly:

```powershell
node scripts/roadmap.mts capture-port --title "Project name" --url https://github.com/owner/project --port-key project-name
```

Contributors can instead use the **New port / upstream candidate** form. Its
required durable game/target key uses lowercase kebab-case and distinguishes
independently prioritizable games even when they share one repository. A
maintainer then runs:

```powershell
node scripts/roadmap.mts normalize-port --issue <number>
```

Normalization preserves the submitted form content, rejects repository-wide
duplicates, reconciles canonical identity markers, ensures exactly one Project
item with neutral values only where fields are unset, and classifies it as a Port.
Both intake paths preserve existing parent relationships and leave unparented
issues unparented. Project membership defines the complete port inventory.
Durable Port records stay in Port Pipeline; native children contribute to a
finite parent completion rather than grouping all consumers of an adapter.
Use **Port Pipeline** for the full inventory. To pick up a ready Now or Next
item, open **Next Queue** and look for **Ready**. **Active Port Work** shows
non-Watchlist Now or Next ports that are In progress, Validating or Blocked.
Intake records the project and its evidence independently of catalog support.

Keep the same canonical port issue across upstream releases. Close completed
work and retain its Project item; Status and Port stage describe independent
facts. A completed integration does not erase support or require automatic
archival. Track new bounded maintenance work separately when needed, linking
back to the canonical port issue instead of creating another inventory record.

Include the direct upstream, why it matters, initial platform and source
observations, artifact integrity, persistence boundary, adapter fit, and exact
resume condition. Every independently catalogable or prioritizable port gets
one durable issue immediately, initialized with neutral Inbox/Watchlist fields.
Use a stable lowercase `--port-key` for a non-catalog game or target; use the
catalog ID when the port is already cataloged. Project drafts are only for
fleeting non-port ideas.

Use the **Product feature or engineering work** form for non-port changes. Its
issue must state the user outcome, current evidence, scope, non-goals,
acceptance criteria, required tests, documentation impact, dependencies, and
completion evidence. Priority, horizon, target release, and release commitment
belong only in the Project. A target is a forecast; Required versus
Planned determines whether the outcome gates that release. Both participate in
the common execution queue. Unset relevant
work is intentionally visible as unclassified.

Scope completion to the promised integration or research. Optional gameplay
evidence may remain unknown without holding completed integration work open;
only actual hands-on results justify hands-on claims. One durable port issue
does not require a new issue or personal approval for each upstream version.
The future protected publisher in #246 will complete policy-compliant candidates
automatically; current PR and integrity requirements remain in force until that
separately authorized implementation ships.

## Pull request and commit conventions

Follow [Contribution conventions](docs/CONTRIBUTION-CONVENTIONS.md) for branch
names, authored commit subjects, pull request titles and the four-section pull
request description. The short form is `type(scope): imperative summary`, with
an optional lowercase scope and a descriptive project-purpose branch such as
`feature/source-review` or `chore/pr-conventions`.

Open incomplete work as a draft and keep one description current. The advisory
`just pr-check <number-or-url>` is optional. Required hosted checks and actual
separate review are defined by [QUALITY](docs/QUALITY.md#required-hosted-baseline)
and [Contribution conventions](docs/CONTRIBUTION-CONVENTIONS.md#review-and-merge).
Local checks and general engineering techniques are optional feedback.

Bootstrap only missing prerequisites through [Development tools](docs/DEVELOPMENT-TOOLS.md).
Native, installer and gameplay observations apply when explicitly required by
the owning issue or release contract. Catalog admission still follows its
specialist qualification route. Analyzer and full platform suites remain
nightly/manual/release coverage; avoid suppressing deterministic defects.

Keep commits free of source game data, signing secrets, generated build output, local libraries, and Fallow caches.

Codex and deterministic automation own feasible acceptance execution, failure
investigation, bounded repair, and exact evidence. Follow the independent and
incremental review contract in
[Contribution conventions](docs/CONTRIBUTION-CONVENTIONS.md). Keep packaged
execution, physical-device automation, and intrinsically human observations
distinct; a synthetic fixture or process start cannot establish gameplay or
comprehension.

After a successful Windows Tauri build, `scripts/package-local.ps1` refreshes the local installer, versioned standalone CLI archive, source archive, and prints their SHA-256 hashes. It smoke-tests the CLI from the final ZIP, refuses an output path outside the workspace, and excludes build, dependency, test-library, and generated-schema directories from the source archive.

Link every pull request to its durable issue, describe the user outcome and
scope, link required CI/review and explicit acceptance, and move the Project item to In
progress or Validating. Use Blocked or Deferred only when a real prerequisite
or capable execution route is unavailable, with its exact resume condition.
Automated evidence must not close an
item whose promised observation actually requires human participation. Do not create a second backlog
in repository documentation; see [PROJECT-GOVERNANCE.md](docs/PROJECT-GOVERNANCE.md).

Routine authorized work follows the review, exact-head CI, target-interaction and
guarded merge contract in
[Contribution conventions](docs/CONTRIBUTION-CONVENTIONS.md). Protected
acceptance, merge, signing/publication and credential boundaries require explicit
authority; neither a candidate nor its automation can authorize itself.
