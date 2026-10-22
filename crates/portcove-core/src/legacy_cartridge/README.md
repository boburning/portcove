# Retained cartridge runtime interpretation

These frozen reader projections preserve installations created by development
Core builds before the October 22, 2026 upstream-first reset. They are historical
compatibility data, never a new artifact grant or a current definition authority.
New installation, generation, compilation and toolchain acquisition are retired.

The five admitted port snapshots are copied from
`crates/portcove-core/catalog/catalog-current-authoring.json` at
`1ef87e082d8520a0fa727f750f06fe7b9349b373`. Display metadata is excluded from
execution comparison; source, release, executable, launch and ownership facts
remain strict. Do not regenerate these snapshots from the new current catalog.

| Reader                         | Concrete consumer                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yoshi's Cookie / Dr. Mario NES | Private Core install/native/maintenance receipts in `docs/qualification/yoshi-nes-cycle-windows-2026-10-18.md` and canonical #155/#157.                                                                                                                                                                                                     |
| EarthBound                     | Private installed/verified development runtime in `docs/qualification/earthbound-fixed-source-2026-10-19.md`, #173.                                                                                                                                                                                                                         |
| Render96                       | Private Core runtime and failed/recovery preparations retained in `docs/qualification/render96-fixed-source-windows-2026-10-19.md`, #519.                                                                                                                                                                                                   |
| Gundam                         | Private Core installation/backup records and archived removed runtime in `docs/qualification/gundam-offline-source-windows-2026-10-20.md`, #330.                                                                                                                                                                                            |
| CVLoD                          | Private source recipe installed through development Core under #320; upstream package definition remains separate. The snapshot reconstructs the exact three modifications made by the independent pre-reset `cvlod_build/tests.rs::fixture` (managed recipe, original hash, Windows path policy), preserving its source snapshot identity. |

Advance Wars (#166) had only an unselected source-recipe fixture and no identified
real installed consumer. Its serialized enum name remains recognized as retired
and unsupported; the synthetic snapshot, validator and creation path are removed.
It has no positive runtime compatibility or integration-delivery promise.

Stored contracts and manifests remain authoritative for actual existing bytes.
The former compiler, SDK/source/object inventories and patch application are not
needed to read, verify, launch, preserve data or recover those installations.
Legacy CVLoD staging junction cleanup remains in `legacy_cartridge_cleanup.rs`
because retained interrupted/published preparation journals can still need it.
Unknown process quiescence continues to retain the journal and private tree.

Retire a runtime reader only after its persisted manifests, retained definitions,
backups and recovery exports have an explicit supported transition and no
supported consumer needs that interpreter. Retire the CVLoD cleanup exception
only after all journals using that exact staging layout are resolved or migrated.
Public Alpha 1/API12 and Alpha 2/API34 predate these recipes; their database
migrations and general old-install readers are unchanged by this retirement.
