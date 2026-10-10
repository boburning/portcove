# Domain docs

Use established vocabulary. Read relevant entries in root `GLOSSARY.md` and
`docs/adr/` when the task concerns their terms or decisions; if absent, proceed.
Create them lazily through authorized domain-modeling work. Surface conflicts
with existing ADRs explicitly.

For cross-layer changes, use the [ownership map](../ARCHITECTURE.md#find-the-owning-boundary)
and affected subsystem. The [agent contract](../../AGENTS.md) owns authority boundaries.
