# Contributing

Keep the core reusable, the catalog declarative, and the CLI stable for external frontends. Avoid game-specific branches in the CLI or React app; add catalog metadata or a family-level adapter instead.

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

When a change deliberately postpones interactive, physical, or external work, add or update its stable entry in `docs/DEFERRED.md`. Automated evidence must not close an item that explicitly requires human observation.
