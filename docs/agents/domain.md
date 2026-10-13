# Domain docs

Use established vocabulary. Read relevant entries in root `GLOSSARY.md` and
`docs/adr/` when the task concerns their terms or decisions; if absent, proceed.
Create them lazily through authorized domain-modeling work. Surface conflicts
with existing ADRs explicitly.

For cross-layer changes, use the [ownership map](../ARCHITECTURE.md#find-the-owning-boundary)
and affected subsystem. The [agent contract](../../AGENTS.md) owns authority boundaries.

For game-port release channels, current human labels are Stable / Preview / Rolling; the compatibility values are `stable` / `beta` / `rolling`. Keep channel selection distinct from upstream designation, scoped qualification and update ownership; see [Catalog policy](../CATALOG.md#channels-support-and-qualification) and [CLI compatibility](../CLI.md). Application Public beta and application update channels are separate terms.
