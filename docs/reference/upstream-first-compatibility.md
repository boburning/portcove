# Upstream-first compatibility and retired creation

The October 22, 2026 owner direction is recorded on
[#1422](https://github.com/boburning/portcove/issues/1422).
[Catalog policy](../CATALOG.md#integration-ownership) owns route selection.
This record identifies compatibility consumers and removal conditions; live
planning stays on canonical issues and GitHub Projects.

## Distribution and supported consumers

At pickup main was `1ef87e082d8520a0fa727f750f06fe7b9349b373`, API 79.
The live public release inventory contained only
[Alpha 1](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.1)
(API 12, September 5) and
[Alpha 2](https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2)
(API 34, September 8), each with 15 assets. Tag source confirms those APIs;
download counts are not an installation inventory. This reset introduces API 80
for changed user-selected execution and reusable policy contracts, rather than
claiming that an unpublished API was never used.

The maintained Playnite reference's tested window is API 42–57, 60–63 and 65–80,
with used event schemas 2–3. Gaps 58, 59 and 64 remain refused; future versions and
unknown consequential execution/ownership values remain refused. Published
Alpha 1/2 cannot run the newer reference-client workflow. Local/package candidate
identities and limits remain in the [client-author guide](../INTEGRATION-AUTHOR.md).
An old executable can still operate its compatible pre-migration library; it
does not gain permission to interpret newer records by sharing the product name.

All database migrations and schema identifiers retain their meanings. Existing
managed manifests and retained definitions remain authoritative for their own
runtime/source/persistence behavior. Current catalog route changes do not turn
an installed managed runtime into an external registration, move player files,
or force reinstall. New user-selected registrations use an explicit retained
format that older readers reject. Legacy exact-package registrations retain
their certification, source checks, settings and consent semantics.

## Retired custom creation

| Canonical owner                                                                                                                        | New offering                                                                 | Retained consumer and reason                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Yoshi #155](https://github.com/boburning/portcove/issues/155), [Dr. Mario NES #157](https://github.com/boburning/portcove/issues/157) | Existing executable/launcher registration                                    | Actual Core-built development installs and maintenance receipts in [NES qualification](../qualification/yoshi-nes-cycle-windows-2026-10-18.md). Keep their exact original, receipt, companion, argument, environment and persistence interpretation.                                                                                                       |
| [EarthBound #173](https://github.com/boburning/portcove/issues/173)                                                                    | Existing installation; upstream prototype limitations remain                 | Actual private runtime and scoped maintenance in [fixed-source qualification](../qualification/earthbound-fixed-source-2026-10-19.md). Preserve its runtime contract separately from source generation.                                                                                                                                                    |
| [Render96 #519](https://github.com/boburning/portcove/issues/519)                                                                      | Existing installation                                                        | Actual A7 runtime, earlier failed private roots and recovery uncertainty in [Render96 evidence](../qualification/render96-fixed-source-windows-2026-10-19.md). No official binary was present in the live release collection.                                                                                                                              |
| [Gundam #330](https://github.com/boburning/portcove/issues/330)                                                                        | Upstream setup/launcher, then non-owning registration                        | Actual A2 install, archived runtime and backups in [Gundam evidence](../qualification/gundam-offline-source-windows-2026-10-20.md). Upstream v0.1.11 supplies a ROM-free setup pack and owns substantive generation/build behavior.                                                                                                                        |
| [CVLoD #320](https://github.com/boburning/portcove/issues/320)                                                                         | Existing official package route                                              | Private repaired runtime and recovery exercises in [source-repair evidence](../qualification/cvlod-source-shutdown-repair-2026-10-20.md); shipping-package failures remain in [earlier observations](../qualification/cvlod-shutdown-and-maintenance-2026-10-19.md). Preserve manifest/launch and exact staging-junction cleanup, not the repair compiler. |
| [Advance Wars #166](https://github.com/boburning/portcove/issues/166)                                                                  | Product deferral/upstream dependency; no admitted current definition         | The removed recipe had synthetic fixtures only, with no identified installed consumer. Its serialized identifier is reserved and refused, not reused or advertised as supported runtime compatibility.                                                                                                                                                     |
| [Arcanum #828](https://github.com/boburning/portcove/issues/828)                                                                       | Upstream dependency/product deferral pending a useful executable/setup route | No active Core builder or admitted definition existed. Dated private filesystem/save-parser/codec patches and reproductions remain historical/upstream-contribution evidence. They establish no actual game-data or runtime acceptance.                                                                                                                    |

The removed creation responsibilities include NES cycle patches, GBA/SNES
generation/build graphs, Render96 extraction/resource/audio/compiler/linker
orchestration, Gundam's replacement setup and feature-altering patches, and
CVLoD's repaired-source pipeline, private SDK/compiler/source/object inventories
and special raw acquisition. Creation-only fixtures, tests, nextest overrides,
tool-download and CI-diagnostic dependencies retire with their consumers.

The small legacy recipe interpreter retains serialized values and runtime
semantics. New creation refuses before acquisition/staging. Retired staged-source
creation versions 6, 7, 9, 13 and 14 leave the public inventory; only the private
retained-installed decoder can interpret the needed old snapshots. Shared N64
and path capabilities remain available to their other consumers. PSX's supported
upstream `psxrecomp_cli.py` generation/rebuild and common supervision stay active.

**Retirement condition:** remove a remaining runtime reader only after an explicit
supported transition or owner-confirmed retirement accounts for its retained
installs, definitions, backups, exports and recovery consumers. Remove CVLoD's
legacy junction cleanup only after the journals using that exact layout have
resolved or explicitly migrated. Catalog absence and unpublished client status
are insufficient evidence. Source cleanup owns no player or qualification files.

The [Gundam v0.1.11 release](https://github.com/TechnicallyComputers/GundamWingEndlessDuelSNESRecomp/releases/tag/v0.1.11)
was published October 18. The
[CVLoD v0.2.28 release](https://github.com/fliperama86/cvlod_recomp/releases/tag/v0.2.28)
was published October 22; its notes do not establish repair of the recorded
shutdown failure. [Render96 releases](https://github.com/Render96/Render96ex/releases)
and [Arcanum releases](https://github.com/alexbatalov/arcanum-ce/releases)
were empty at investigation. These are dated distribution observations, not
artifact/setup/gameplay qualification or a promise that upstream has suitable
binaries for every candidate.

## Reusable policies and exact legacy readers

Current definitions use the constrained `tfe-dark-forces-portable-v1`,
`version-local-retroachievements-v1` and `gbrecompiled-windows-v1` policies,
requiring staged-source version 19. Retained typed `DirectReleaseSpec` data
supplies platform, version, safe executable, package size, digest and URL. The
GB policy additionally requires a reviewed safe save-ID basename, because upstream
generates it independently of the executable filename. Fixed safe layouts,
artifact equality, initialization/parser behavior, save preservation, account/path
consent and credential exclusions remain Core invariants. This is a small set
of demonstrated behaviors, without commands, scripts or broad path permissions.

Known actual development consumers remain documented:

- [TFE API 75](../qualification/tfe-managed-windows-2026-10-20.md), private
  `pc2177-tfe-a1` library and its retained CLI.
- [RaceWave API 76](../qualification/racewave46-managed-windows-2026-10-20.md),
  private `pc2177-racewave-a1` library and its retained CLI.
- [ReGaiden API 77](../qualification/regaiden-managed-windows-2026-10-20.md),
  private `pc2177-regaiden-a1`, schema-7 account/path consent manifests and older
  exact-package non-owning registrations.

These receipts establish persisted consumers, not proof that a library is still
active today. Old `tfe-dark-forces-v1.22.420`,
`racewave46-v1.0.0-windows` and `regaiden041-windows`
interpretations keep their original constraints. Known-artifact omission fences
protect old unbound state; old copied-tree TFE behavior is not silently narrowed
by the new verified-package policy.

**Retirement condition:** explicitly transition or account for those manifests,
registrations, backups and recovery records and their supported reader window
before removing a legacy policy or known-artifact omission fence. Never rewrite
historical identity from the current catalog to obtain that result.

Shipwright 9.3.1's exact portable Windows package remains a bounded exception in
`installed_mutability`: observed upstream behavior ignores `SHIP_HOME` and writes
`Save` under its working directory. The existing architecture record binds its
exact artifact and preserves real installed data without changing a frozen
catalog or granting that behavior to unknown future packages. It creates no
builder or engine patch. Retire this interpretation only after its supported
installed/backup/recovery consumers explicitly transition to a retained
persistence contract that captures the same ownership, or are accounted for as
retired. A new filename or release tag does not establish that transition.

Synthetic compatible-release tests demonstrate that new facts can reuse the
same policy without Core/client edits. They assert compatible declared behavior;
they are not invented upstream releases or actual runtime success. Real new
artifacts still require accepted publisher identity and focused checks of the
behavior on which the policy relies.

An existing real fitting addition is
[Super Bomberman PR #2234](https://github.com/boburning/portcove/pull/2234): its
complete four-file diff contains authoring data, generated catalog, the additive
legacy-identity fixture and the dated qualification record, with no application
implementation. The ordinary workflow remains reviewed upstream/platform/source/
artifact and offered-operation facts, catalog validation/generation, focused
selection/behavior checks and normal reviewed delivery. The policy fact-update
tests and this actual addition demonstrate different scopes: reusable declared
behavior and a real unchanged-upstream-package addition. Neither is a whole-task
speedup or qualification of a future artifact.
