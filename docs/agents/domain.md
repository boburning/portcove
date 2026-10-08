# Domain docs

Portcove uses a single-context layout:

- `GLOSSARY.md` at the repository root.
- `docs/adr/` for architecture decisions.

Before exploring, read the glossary and ADRs relevant to the task when
they exist. If absent, proceed silently. Create them lazily through
authorized domain-modeling work when terms or decisions are resolved.

Follow the task map in `AGENTS.md` and the owning repository contracts.
Read `docs/ARCHITECTURE.md` before structural or cross-layer changes.

Use established glossary vocabulary in issues, proposals, tests, and
implementation. Identify missing concepts when they matter to the task.

Surface conflicts with existing ADRs explicitly. Glossary and ADR
changes must preserve repository authority boundaries and must not
create a second planning authority.
