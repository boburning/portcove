# Contributing

Keep the core reusable, the catalog declarative, and the CLI stable for external frontends. Avoid game-specific branches in the CLI or React app; add catalog metadata or a family-level adapter instead.

## Start with the roadmap

Search the public [Portcove Roadmap](https://github.com/users/boburning/projects/1)
before proposing work. For a newly discovered port, open the **New port /
upstream candidate** form or capture a draft in seconds:

```powershell
node scripts/roadmap.mjs capture-port --title "Project name" --url https://github.com/owner/project
```

Include the direct upstream, why it matters, initial platform and source
observations, artifact integrity, persistence boundary, adapter fit, and exact
resume condition. Very early candidates may stay drafts; actionable, high
priority, or materially blocked work belongs in a repository issue.

Use the **Product feature or engineering work** form for non-port changes. Its
issue must state the user outcome, current evidence, scope, non-goals,
acceptance criteria, required tests, documentation impact, dependencies, and
completion evidence. Priority, horizon, and target release belong only in the
Project.

Before submitting a change:

```powershell
.\scripts\bootstrap-quality-tools.ps1
node scripts/dev-storage.mjs preflight
node scripts/dev-storage.mjs run -- pnpm --dir apps/desktop install --frozen-lockfile
just check
just audit
```

On Linux or macOS, use `./scripts/bootstrap-quality-tools.sh`. Pass `-IncludeDeep` or `--include-deep` when you also want the optional semantic-duplication, dead-public-API, and mutation tools. The non-system-volume workflow, cleanup command, and recovery procedure are documented in [docs/DEVELOPMENT-STORAGE.md](docs/DEVELOPMENT-STORAGE.md).

Do not suppress deterministic findings without a narrow, reviewable reason. Treat structural findings as evidence rather than instructions for speculative refactors. Follow [AGENTS.md](AGENTS.md) and [docs/QUALITY.md](docs/QUALITY.md). Catalog changes must pass the live repository audit and must not add archived repositories.

Keep commits free of source game data, signing secrets, generated build output, local libraries, and Fallow caches.

After a successful Windows Tauri build, `scripts/package-local.ps1` refreshes the local installer, CLI, source archive, and prints their SHA-256 hashes. It refuses an output path outside the workspace and excludes build, dependency, test-library, and generated-schema directories from the source archive.

Link every pull request to its durable issue, describe the user outcome and
non-goals, list exact validation commands, and move the Project item to In
progress or Validating. Keep interactive, physical, or external work Blocked or
Deferred with its exact resume condition. Automated evidence must not close an
item that explicitly requires human observation. Do not create a second backlog
in repository documentation; see [PROJECT-GOVERNANCE.md](docs/PROJECT-GOVERNANCE.md).
