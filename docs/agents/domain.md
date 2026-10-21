# Domain docs

Use established vocabulary. Read the relevant [glossary](../../GLOSSARY.md)
entries and [architecture decisions](../adr/) when a task concerns their terms
or decisions. [Content design](../CONTENT-DESIGN.md) maps those meanings to
player tasks, messages and controls. Surface conflicts with existing ADRs
explicitly; vocabulary does not create new permission or acceptance gates.

The [source observation and registration decision](../adr/0005-distinguish-source-observations-and-registration.md)
distinguishes current contracts from the proposed #1686 migration. Current
`SourceRecord` can appear as uncommitted relink planning data; its type name
alone does not prove registration. Use current CLI/type names in executable
examples until the coordinated migration is delivered.

For cross-layer changes, use the [ownership map](../ARCHITECTURE.md#find-the-owning-boundary)
and affected subsystem. The [agent contract](../../AGENTS.md) owns authority boundaries.

For game-port release channels, current human labels are Stable / Preview / Rolling; the compatibility values are `stable` / `beta` / `rolling`. Keep channel selection distinct from upstream designation, scoped qualification and update ownership; see [Catalog policy](../CATALOG.md#channels-support-and-qualification) and [CLI compatibility](../CLI.md). Application Public beta and application update channels are separate terms.
