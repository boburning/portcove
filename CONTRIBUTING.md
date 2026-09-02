# Contributing

Keep the core reusable, the catalog declarative, and the CLI stable for external frontends. Avoid game-specific branches in the CLI or React app; add catalog metadata or a family-level adapter instead.

Before submitting a change:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd apps/desktop
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm exec fallow --format json --quiet --explain
```

Do not suppress Fallow findings without a short, reviewable reason. Prefer deleting dead code, shrinking responsibilities, or adding useful tests. Catalog changes must pass the live repository audit and must not add archived repositories.

Keep commits free of source game data, signing secrets, generated build output, local libraries, and Fallow caches.

After a successful Windows Tauri build, `scripts/package-local.ps1` refreshes the local installer, CLI, source archive, and prints their SHA-256 hashes. It refuses an output path outside the workspace and excludes build, dependency, test-library, and generated-schema directories from the source archive.

When a change deliberately postpones interactive, physical, or external work, add or update its stable entry in `docs/DEFERRED.md`. Automated evidence must not close an item that explicitly requires human observation.
