# Contributing

Keep the core reusable, the catalog declarative, and the CLI stable for external frontends. Avoid game-specific branches in the CLI or React app; add catalog metadata or a family-level adapter instead.

External clients integrate through the supported CLI rather than Portcove's
database, private Rust APIs, or desktop state. Before proposing a frontend,
exporter, or plugin, read [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md), identify
the recurring problem that remains after the generic CLI route, and state its
capability level, maintenance owner/category, supported environments, evidence,
and limitations. A reference example is not automatically a supported
production plugin, and frontend availability does not expand Portcove's platform
support.

## Start with the roadmap

Search the public [Portcove Roadmap](https://github.com/users/boburning/projects/1)
before proposing work. Maintainers can create a newly discovered port's durable
issue directly:

```powershell
node scripts/roadmap.mjs capture-port --title "Project name" --url https://github.com/owner/project --port-key project-name
```

Contributors can instead use the **New port / upstream candidate** form. Its
required durable game/target key uses lowercase kebab-case and distinguishes
independently prioritizable games even when they share one repository. A
maintainer then runs:

```powershell
node scripts/roadmap.mjs normalize-port --issue <number>
```

Normalization preserves the submitted form content, rejects repository-wide
duplicates, reconciles canonical identity markers, ensures exactly one Project
item with neutral values only where fields are unset, and classifies it as a Port.
Both intake paths preserve existing parent relationships and leave unparented
issues unparented. Project membership defines the complete port inventory;
optional parents coordinate finite outcomes with a clear completion condition.
Use Port Pipeline for the full inventory and Active Port Work for unfinished,
non-deferred work. Neither intake path grants catalog support.

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
Opportunistic determines whether the outcome gates that release. Unset relevant
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
names, authored commit subjects, pull request titles and the five-section pull
request description. The short form is `type(scope): imperative summary`, with
an optional lowercase scope and a descriptive project-purpose branch such as
`feature/source-review` or `chore/pr-conventions`.

Open incomplete work as a draft, keep one description current as evidence
changes, and run the advisory checker after creating or updating it:

```powershell
just pr-check <number-or-url>
```

Style findings do not block merge and do not replace the linked issue,
acceptance evidence, distinct review, required CI, or merge-authority checks.

Before submitting a change:

Run `just fmt` to format Rust, JavaScript, TypeScript, CSS, active documentation,
hand-maintained JSON and YAML, and TOML. Use `just fmt-check` when you need the
same verification without changing files.

```powershell
.\scripts\bootstrap-quality-tools.ps1
node scripts/dev-storage.mjs preflight
node scripts/dev-storage.mjs run -- pnpm --dir apps/desktop install --frozen-lockfile
just fmt-check
just check
just audit
```

On Linux or macOS, use `./scripts/bootstrap-quality-tools.sh`. Pass `-IncludeDeep` or `--include-deep` when you also want the optional semantic-duplication, dead-public-API, and mutation tools. The non-system-volume workflow, cleanup command, and recovery procedure are documented in [docs/DEVELOPMENT-STORAGE.md](docs/DEVELOPMENT-STORAGE.md).

Do not suppress deterministic findings without a narrow, reviewable reason. Treat structural findings as evidence rather than instructions for speculative refactors. Follow [AGENTS.md](AGENTS.md) and [docs/QUALITY.md](docs/QUALITY.md). Catalog changes must pass the live repository audit and must not add archived repositories.

Frontend work is checked by type-aware Oxlint, Oxfmt, and Stylelint. Python asset scripts,
the shell bootstrap, GitHub Actions workflows and PowerShell scripts are checked
by the pinned tools installed by the quality bootstrap. The Playnite C# projects
retain their SDK compiler warnings-as-errors gate through `just playnite-check`;
no additional Roslyn analyzer package is required.

Keep commits free of source game data, signing secrets, generated build output, local libraries, and Fallow caches.

Codex and deterministic automation own feasible acceptance execution, failure
investigation, bounded repair, separate review, and exact evidence. Do not ask
the owner to rerun adequate automated checks. Keep packaged execution,
physical-device automation, and intrinsically human observations distinct; a
synthetic fixture or process start cannot establish gameplay or comprehension.

After a successful Windows Tauri build, `scripts/package-local.ps1` refreshes the local installer, versioned standalone CLI archive, source archive, and prints their SHA-256 hashes. It smoke-tests the CLI from the final ZIP, refuses an output path outside the workspace, and excludes build, dependency, test-library, and generated-schema directories from the source archive.

Link every pull request to its durable issue, describe the user outcome and
non-goals, list exact validation commands, and move the Project item to In
progress or Validating. Keep interactive, physical, or external work Blocked or
Deferred with its exact resume condition. Automated evidence must not close an
item that explicitly requires human observation. Do not create a second backlog
in repository documentation; see [PROJECT-GOVERNANCE.md](docs/PROJECT-GOVERNANCE.md).

Routine authorized work follows mandatory CI, an explicit separate review
result, repair of substantive findings, and the normal merge or auto-merge path.
Do not use administrator bypass routinely. Protected acceptance, merge,
signing/publication, and credential boundaries require separate explicit owner
authorization; neither a candidate nor its automation can authorize itself.
