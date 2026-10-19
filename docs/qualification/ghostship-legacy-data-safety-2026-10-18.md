# Ghostship legacy reader and transition safety

Owner: [#53](https://github.com/boburning/portcove/issues/53). This finite
component holds an unsafe historical transition. It does not complete the
port's cross-version acceptance or change catalog admission, platforms,
qualification, channels or publication authority.

## Exact source comparison

The selected historical sources remain Ghostship 2.0.0 at
`762ce4a6dff8d69b934a41a326ae41e78431e6cd` and accepted 3.0.0 at
`deb091c29caff57dd986398087b058f16b11911e`. Eight selected source blobs,
196,304 bytes, were read through the GitHub contents API on October 18. Each
decoded size and Git blob SHA-1 was independently recomputed; SHA-256 and
immutable source URLs are retained in
`E:/Codex-Evidence/slice6-20261018/pickup/ghostship-source-manifest.json`.
The complete 3.0.0 recursive tree reported `truncated=false`, 3,037 entries.
No package or game ran and no original game input was read for this comparison.

| Contract        | 2.0.0 source                                                                                                                                                                                                                                  | 3.0.0 source                                                                                                                                                                                                                                                  | Consequence                                                                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save schema     | [SaveConversion.h](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/src/port/data/SaveConversion.h), blob `d1770433521dc1731db588c560e845dbb6e48656`, writes version 1 and dispatches only version 1 | [SaveConversion.h](https://github.com/HarbourMasters/Ghostship/blob/deb091c29caff57dd986398087b058f16b11911e/src/port/data/SaveConversion.h), blob `e198a524d75b5194260c4bbc45f8ecf4118f5007`, writes version 2; game-file reader dispatches versions 1 and 2 | A newer save cannot be treated as compatible with the older reader.                                                                                                                                                                                                                                  |
| Global settings | Version-1 global serializer and reader                                                                                                                                                                                                        | Global serializer uses version 2, but the selected global reader still dispatches only version 1                                                                                                                                                              | Forward global-data round trip also remains unqualified; do not describe the reverse-direction guard fixture as migration proof.                                                                                                                                                                     |
| Save location   | [Saves.cpp](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/src/port/data/Saves.cpp), blob `bca23580fc645464e4fb9c8ec528622fb795dee1`                                                               | [Saves.cpp](https://github.com/HarbourMasters/Ghostship/blob/deb091c29caff57dd986398087b058f16b11911e/src/port/data/Saves.cpp), blob `d6493c2a45a7549b2b68dbc3c00c1a9027c99f70`                                                                               | Both use the app-directory saves tree with `save_0.json` through `save_3.json` and `global.json`. Exact Windows 2.0.0 ignores `SHIP_HOME` and uses its working directory; Core must copy, collect and verify persistent data there. Changing the active executable does not restore the data schema. |
| Generated O2R   | [Engine.cpp](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/src/port/Engine.cpp), blob `f04d88182bda3132c0719f8a3e7d1ee8c0e6cbda`                                                                  | [Engine.cpp](https://github.com/HarbourMasters/Ghostship/blob/deb091c29caff57dd986398087b058f16b11911e/src/port/Engine.cpp), blob `10ae903d2f3ee6810cf228721345b8911b69d4f2`                                                                                  | Both check generated archive major/minor against the running build. Existing generated bytes do not establish backward compatibility.                                                                                                                                                                |

## Supported safe treatment

Core holds the exact 3.0.0 to 2.0.0 transition before data collection,
synchronization, retained-install registration or active-pointer mutation.
The same private title-specific check covers direct rollback, staged
activation and selected-release installation/reactivation. Rollback remains
an offered operation with `Held / UnsafeData` for this configuration.
Interrupted publication and activation recovery apply the same check before
uncommitted state changes, retaining refused journals. Already committed targets
can still retire their journals; the hold does not block recovery bookkeeping.

Removal can preserve user data while deleting installation history. Before
targeting or launching exact 2.0.0, Core therefore checks the five named save
files independently of active-version provenance. Missing files are allowed;
each existing file must be a bounded regular non-linked file with readable
JSON and integer version 1, with the complete nested reader checks described
below. Reads are limited to 1 MiB per file through the existing path helper.
Malformed, oversized, unsafe, unreadable or unsupported files are held intact.
The check also contributes to normal launch readiness and action assessment.

### Nested reader checks, October 19 correction

The original version-marker check accepted `{"version":1}`, although the
pinned reader requires nested members. That incomplete check is preserved
in the earlier receipt; it is not save-compatibility evidence. The correction
reads without rewriting, converting, filling fields or changing feature flags.

The oracle combines the pinned `SaveConversion.h` and `Saves.cpp` with
[course declarations](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/levels/course_defines.h),
[achievement initialization and consumers](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/src/port/mods/achievements/Achievements.cpp),
[randomizer types](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/src/port/Rando/Types.h),
[entrance mapping](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/src/port/Rando/StaticData/Entrances.cpp)
and their exact lookup/warp consumers. Verified Git-blob, size and SHA-256
receipts, including the machine-readable oracle, remain in
`E:/Codex-Evidence/slice6-20261018/ghostship2-recovery-primary-a1/`.

Game files require the 25 star-map keys from BOB through CG, the first 15
coin-map keys through RR, and a cap-position object. Missing optional cap
coordinates, level, area and flags retain upstream defaults. Present values
must be integers within their destination and intermediate-reader ranges;
flags use the nonnegative signed-32 range of the upstream `int` getter.
Global data requires four readable u32 coin ages and optional u16 sound mode;
extra coin ages remain ignored as in the reader.

Absent `shipSaveData` remains valid: `Saves.cpp` supplies false/false in memory.
False feature flags leave their payloads unparsed, without changing the file.
Enabled achievements require the complete 45 known, unique IDs in any order,
boolean cheated state and signed-32 counters/progress. The unchecked upstream
array capacity of 100 is not a safe population rule: short arrays leave entries
unestablished and unknown IDs mutate maps used by later load/save loops.

Enabled randomizer data requires the genuine complete 364-check, 25-entrance
and ten-option shapes. Item IDs 0–3, acts -1–6, boolean states and u32 seed are
checked. Entrance IDs match their array indexes; destinations are the mapped
level IDs, with the original unknown sentinel only in slot zero. Repeated
valid destinations are allowed. Options use their declared 0/1 domain. Complete
feature arrays and supported level/option domains are qualification boundaries
for this route, not claims that upstream rejects every other serialized value.

An existing app-data `default.sav` invokes a separate legacy importer before
normal JSON loading. It rewrites four JSON files and renames the binary input.
That preimage is held intact until the importer is separately qualified; a
valid five-file JSON inventory cannot establish which data that branch consumes.

These checks establish static shape and supported-value compatibility only.
They do not prove generated O2R provenance, successful consumption, a qualified
pre-transition snapshot, native save/load, or compound restore/pointer recovery.

A retained `sm64.o2r` without reviewed legacy-reader compatibility is held for
2.0.0, including when installation provenance was removed. Core does not parse
that compressed archive, rewrite it, delete it, convert saves or infer trust
from a new local hash. The closed exact mode below supplies a provenance-bound preparation and same-version maintenance route; arbitrary retained generated bytes remain held. 3.0.0's previously accepted
same-version route and unrelated ports are outside this hold.

## Closed Windows 2.0.0 preparation and maintenance, October 19

The exact historical route now uses `ghostship200_legacy`, preparation
plan/receipt format 2 and installed contract format 4. It retains the admitted
catalog and source identity independently of its execution projection. The
route accepts only the reviewed official Windows 2.0.0 artifact and executable,
registered exact 8 MiB USA original and bounded ASCII native paths. It grants
no arbitrary command, tool or source override. The generated archive and
receipt are immutable critical files; no current-catalog mutable declaration
can exempt them. Older readers must refuse the new interpretation.

Pinned libultraship Windows source
`Kenix3/libultraship@e9c1ef943d932ab723509ec96b37e9c35457c5d2` ignores
`SHIP_HOME` in this build. Setup therefore runs with zero arguments in its
operation-private working directory, containing the admitted raw original.
Only the verified generated `sm64.o2r` moves into the prepared payload after
positive captured process quiescence. The original remains unchanged. The
normal game launch copies canonical persistent data into the actual runtime
working directory and collects it after exit. Selection uses the retained
contract, including when current source availability changes. Canonical O2R
must match the receipt-bound immutable generated archive; otherwise the route
holds before launching or replacing data. Binary importer and nested JSON
checks above still apply. Existing direct-user-data routes retain their policy.

Maintenance reuses the verified generated archive without running the generator
again. It binds a fresh receipt to the original reviewed maintenance plan and
preserves both the prior installation and canonical data. Prepared-journal
recovery validates its owned staging envelope, full retained manifest, source,
receipt and generated archive before publication; it does not treat a staging
path as a registered installation or bypass the registered-root guard.

API schema 68 adds the closed mode. Generated CLI/Tauri transport contracts and
Playnite's supported 65–68 window consume it; existing schema-67 external-route
cleanup remains supported. This does not make Playnite a bootstrap authority.

### Actual evidence and preserved failures

The private qualification catalog selects official 2.0.0 without changing the
production catalog. Artifact `Mary-Celeste-Alfa-Win64.zip`, release 331625120,
asset 433164458, is 21,561,620 bytes with SHA-256
`a49f4c791377fcc611264b8920f2c3254b3ab25747c2a59da9305c32f92a6d3f`.
The executable SHA-256 is
`2063529579d27d98953613147e0d53e2cde3ed4e783a8f2f51a43afbbd8b4c24`.
The admitted USA original SHA-256 is
`17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91`.

- Native preparation A4 displayed actual generation prompts, received Yes/Yes/No,
  exited with positive captured quiescence and published a fully verified
  installation. Choosing No left game launch to Core. Generated archive:
  18,060,635 bytes, SHA-256
  `3256d180831b9bf0d3a1015e05ada63e812977d260965084c920c168279f0e26`.
- First Play request `e962663d-126e-4a96-94ef-f81fe7295f69` in the otherwise
  failed A3 maintenance packet rendered an attract/demo scene, closed through
  the native title bar and reported captured/Core exit zero. All 949 immutable
  files passed post-verification. That successful cycle retains its A11 CLI
  provenance; the whole packet is still failed.
- The original maintenance attempt prepared operation
  `5eaf4f8e-cb65-4b0a-b9ae-15c665c38898`, then refused publication because a
  staged payload was given to the registered-root reader. The causal repair
  keeps that reader's guard and adds the tightly scoped staged validation.
  A12 recovered that exact already-authorized journal with the original
  plan hash `489a2369ea57f6e269a54a1171cb61e54e257f0875f7567b1acb345826db62c6`.
  Fresh receipt, generated archive, all 955 staged payload files, all 955 prior
  installation files, original and canonical tree were unchanged. All three
  older retained journals and their 2,267 stage files were unchanged.
- Recovery/restart A2 then observed the recovered installation's second Play,
  closed its actual window normally and obtained captured/Core exit zero and
  another 949-file post-verification pass. Native lease release followed
  positive process evidence. Its A12 CLI SHA-256 is
  `6fbca652071798b2799ecaca981a76b8826927f20adaa591103ac6c004e0d6b4`.
  Both startup observations are agent observations, not human or gameplay,
  interactive save/load, audio or controller acceptance.
- A12 qualification records 128 selected focused/reused Core passes (filters
  can overlap), 429 compiled client contract checks and unchanged generated
  transport/19 Node checks reused at their exact source scope.

All evidence is under `E:/Codex-Evidence/slice6-20261018/`: native preparation
`ghostship-legacy-native-preparation-a4`, first Play/failing maintenance
`ghostship-legacy-play-maintenance-a3`, successful exact-journal recovery and
second Play `ghostship-legacy-maintenance-recovery-restart-a2`, and
`ghostship-legacy-qualification-a12`. The actual old CLI probe refused unknown
`ghostship200_legacy` before proceeding; it is narrower than proof of a
format-4-only refusal.

Earlier failures remain retained: native A1 ended before child admission;
A2 generated data but hit mixed native path separators; A3's immutable setup
metadata changed after manifest creation; Play A2 omitted runtime archive
copying under the previous direct-data assumption. The repairs use native path
components, retain immutable setup metadata without a post-manifest legacy
rewrite, and apply retained-mode persistence policy consistently. They do not
reseal the earlier failed stage. The later recovery packet's first attempt
stopped during read-only inventory on the official 57,585,664-byte debug PDB;
its finite per-file inventory cap was increased from 32 to 64 MiB with all
aggregate, ownership and process guards preserved. Product deadlines are
unchanged. None of these earlier packets is relabeled as passing.

This component establishes original-bound generation, actual startup/ordinary
close/restart and same-version prepared maintenance recovery. It does not
establish a qualified pre-transition snapshot or compound data/pointer restore,
2↔3 cross-version compatibility, protected installed-client delivery, production
admission of historical artifacts, or whole-#53 completion.

## Evidence and remaining acceptance

Reuse [#501's exact Windows 3.0.0 lifecycle](https://github.com/boburning/portcove/issues/53#issuecomment-5577349494)
and [#1762's source-applicability correction](ghostship-3-0-0-source-applicability-2026-10-11.md).
The old 2.0.0 argv failure is preserved and is not replayed. The new Core
fixtures cover held transitions, retained-data checks without install history,
old launch preparation, source-independent refusal and file/pointer preservation.
Synthetic fixture executables are never run. Activity failure records in SQLite
remain expected; refusal preserves game installations, generated data and saves.

Required remaining #53 acceptance: a reviewed, explicitly consented
pre-transition data recovery or compatible migration/regeneration treatment;
exact source/O2R/settings/save forward and backward observations for offered
transitions; and applicable protected unchanged-client delivery through
#246/#534. An executable rollback alone cannot establish data rollback.
Optional gameplay/audio/controller/in-game-save observations and other platforms
remain separate. This receipt grants no source redistribution, signing,
publisher, release, support or whole-issue completion authority.
