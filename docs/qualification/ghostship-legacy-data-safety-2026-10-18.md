# Ghostship legacy reader and transition safety

Owner: [#53](https://github.com/boburning/portcove/issues/53). This finite
component holds an unsafe historical transition and provides a qualified
snapshot recovery route. Its exact native observations below do not complete
whole-port acceptance or change catalog admission, platforms, qualification,
channels or publication authority.

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

API schema 68 adds the closed mode to the generated CLI/Tauri transport contracts.
Playnite accepts schema 68 for its existing commands within its supported 65–68
window; schema-67 external-route cleanup remains supported. Playnite does not
invoke the new preparation mode.

### Qualified pre-transition snapshot recovery

The separate schema-69 recovery route is limited to Windows, active 3.0.0 and
the exact retained, prepared 2.0.0 installation. Core records a private
qualification only after a positively identified owned launch exits successfully,
collection succeeds, the full installation verifies, and the source, receipt,
generated archive and bounded canonical data match. Backup publication associates
that qualification only with the exact copied content and backup manifest.
Ordinary or imported backup metadata cannot create this authority. The Core
qualification is distinct from native observation and from gameplay or save/load
acceptance; historical successful sessions are not retroactively qualified.

`backup ghostship-legacy-plan <backup-id>` reviews the selected qualified snapshot,
retained source/code identities, complete installation pointer tuple, canonical
and newer-runtime preimages, and conservative capacity. Application requires the
same plan hash and explicit consent through
`backup ghostship-legacy-recover <backup-id> --expected-plan <hash> --yes`.
All unfinished Ghostship launch/lifecycle work must be resolved first.

Recovery preserves both existing installations. It builds a fresh checked
derivative of retained 2.0.0 code, preserves the complete retained admission
envelope, and overlays only that definition's persistent entries from the
qualified snapshot. Absent entries remain absent. Receipt, generated immutable
archive and executable bytes cannot come from an ordinary data backup. Current
publisher policy remains authoritative at publication and registration.

Before replacement, a complete canonical safety backup retains an independently
verified `legacy-recovery-runtime/` companion containing the effective newer
runtime's persistent entries, including empty directories and absence. Ordinary
restore reads only `data/`. Deletion preview and native consent disclose that
deleting the safety backup also deletes the companion; its full identity remains
bound through interrupted deletion. Changed or added members are held.

The dedicated journal fences other mutations from Preparing. Preparing failures
retain private files and safety evidence for review; they are not automatically
promoted, discarded or presented as resumable validated payloads. Prepared
recovery validates the phase-owned payload/data and rechecks current authority
before publication renames. A single database transaction compares the complete
expected installation/source tuple, registers the derivative, selects it as
active with 3.0.0 previous, preserves another staged installation, admits the
safety receipt and records MetadataCommitted. Subsequent recovery is forward-only
and never collects newer runtime data into the selected legacy snapshot.
The result identifies the committed install, selected restored backup, actual
safety backup and fixed companion path in `GhostshipRecoveryResult`.

Schema 69 also adds the backup deletion disclosure to generated contracts.
Playnite's 65–69 window preserves its existing decisions; it does not invoke
the optional compound recovery or backup deletion commands. These implementation
contracts do not themselves establish actual compound recovery acceptance.

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

### Actual qualified snapshot and compound recovery, October 19

A fresh owned library under `E:/pcs6 ghostship compound 20261019` establishes
this separate route. Preparation A1 used the exact official 2.0.0 bytes and
original above, displayed Yes/Yes/No, obtained captured exit zero and published
install `afef931d-4ef3-4b0c-9f28-864238074207`. All 947 original-install files
and 336 directories were unchanged. Its newly generated 18,060,635-byte archive
has SHA-256 `398a04a25e1beb4d44654597efd28f16de2775c65a9036a42a9016f9035be84d`.
This differs from the earlier archive; no deterministic-byte identity is claimed.

Qualification A4 uses CLI SHA-256
`8b70100319ad8aac7e7343fbbd4d0cf70e18f065a254f9e5ea344b06ae41d640`.
It retains A3's unchanged-source 50 Ghostship, 61 database, 77 CLI and three
backup test passes. Fresh native/headless exports, generated types, 19 transport
tests and 432 compiled Playnite checks pass. Fresh parity checks bracket exact
source, generated-file and CLI hashes. The unchanged frontend consent behavior
also has 37 browser tests across both explicitly selected files. A3's linker
failure remains retained; disabling Rust incremental compilation allowed export
and the remaining qualification to complete without a source repair.

Compound packet A1 observed legacy Play request
`f5ec6efa-a159-4748-bf83-5487971f679c` render the Mario title screen and close
normally. Captured process identity, Core success/exit zero, collection and full
verification qualified backup `4b132a30-6914-465d-80e4-533a86a39375`.
The selected exact 3.0.0 artifact is `Nautilus-Alfa-Win64.zip`, 20,379,303 bytes,
SHA-256 `49a0ab6c6624ccb20d29bb433f391d017f638f2b7db0601eae7808574a62aa18`.
After the actual update, request `7b596e55-e8fa-4453-95ea-db133f8084f0` offered
O2R generation, consumed the same verified original through its file selector,
rendered a Mario/Bowser attract scene and closed normally with captured/Core
exit zero. The packet then stopped on a harness assertion expecting "3.0.0"
in the correct rollback refusal naming the held 2.0.0 reader. A1 remains failed;
compound recovery had not run.

Reviewed continuation A2 reused those exact successful cycles through current
Core records, request/process identities, observation receipts and the qualified
backup seal. A fresh refusal/preimage comparison passed. Explicit plan-bound
consent then committed derivative `c5db1de4-c9fd-4c5d-8dd1-724aab8c441d`, restored
the selected snapshot as canonical data, selected 2.0.0 with 3.0.0 previous,
and retired the journal. Safety backup `835d3b19-2ea4-4fbd-83ca-a4241486d3ac`
retains the exact pre-recovery canonical data and verified newer-runtime
companion. The recovered derivative rendered the Mario title screen and closed
normally with captured/Core exit zero and full post-verification. Final full
tree comparisons preserve both historical installs, the selected backup and
the complete safety backup. Their private authority records remain unchanged.
Positive process proof preceded native lease release; supervisor exit was zero.

Evidence is under `E:/Codex-Evidence/slice6-20261018/` in
`ghostship-compound-native-preparation-a1`, `ghostship-compound-qualification-a3`
and `-a4`, and `ghostship-compound-play-recovery-a1` and `-a2`. These are agent
startup/ordinary-close observations, not human or gameplay acceptance. The
selected snapshot contains config, UI settings, generated archive and empty
save/mod directories; populated game-save/global-data round trips remain
unobserved. The route restores historical bytes rather than asserting backward
O2R compatibility or migrating newer saves. Physical deletion of this unique
safety backup was not performed; interrupted companion deletion is covered by
the reviewed Windows fixtures and consent tests.

## Evidence and remaining acceptance

Reuse [#501's exact Windows 3.0.0 lifecycle](https://github.com/boburning/portcove/issues/53#issuecomment-5577349494)
and [#1762's source-applicability correction](ghostship-3-0-0-source-applicability-2026-10-11.md).
The old 2.0.0 argv failure is preserved and is not replayed. The new Core
fixtures cover held transitions, retained-data checks without install history,
old launch preparation, source-independent refusal and file/pointer preservation.
Synthetic fixture executables are never run. Activity failure records in SQLite
remain expected; refusal preserves game installations, generated data and saves.

The qualified snapshot route now has exact source/O2R/settings preservation,
forward generation and compound data/pointer recovery observations at the
scope above. Populated game-save/global-data round trips remain unobserved;
the current integration minimum does not require optional gameplay/save-load
observations. Applicable protected unchanged-client delivery through #246/#534
retains its separately granted authority and acceptance. An executable rollback
alone cannot establish data rollback.
Optional gameplay/audio/controller/in-game-save observations and other platforms
remain separate. This receipt grants no source redistribution, signing,
publisher, release, support or whole-issue completion authority.
