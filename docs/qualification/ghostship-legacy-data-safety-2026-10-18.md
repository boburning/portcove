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

| Contract        | 2.0.0 source                                                                                                                                                                                                                                  | 3.0.0 source                                                                                                                                                                                                                                                  | Consequence                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Save schema     | [SaveConversion.h](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/src/port/data/SaveConversion.h), blob `d1770433521dc1731db588c560e845dbb6e48656`, writes version 1 and dispatches only version 1 | [SaveConversion.h](https://github.com/HarbourMasters/Ghostship/blob/deb091c29caff57dd986398087b058f16b11911e/src/port/data/SaveConversion.h), blob `e198a524d75b5194260c4bbc45f8ecf4118f5007`, writes version 2; game-file reader dispatches versions 1 and 2 | A newer save cannot be treated as compatible with the older reader.                                                                                                                                                            |
| Global settings | Version-1 global serializer and reader                                                                                                                                                                                                        | Global serializer uses version 2, but the selected global reader still dispatches only version 1                                                                                                                                                              | Forward global-data round trip also remains unqualified; do not describe the reverse-direction guard fixture as migration proof.                                                                                               |
| Save location   | [Saves.cpp](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/src/port/data/Saves.cpp), blob `bca23580fc645464e4fb9c8ec528622fb795dee1`                                                               | [Saves.cpp](https://github.com/HarbourMasters/Ghostship/blob/deb091c29caff57dd986398087b058f16b11911e/src/port/data/Saves.cpp), blob `d6493c2a45a7549b2b68dbc3c00c1a9027c99f70`                                                                               | Both use the app-directory saves tree with `save_0.json` through `save_3.json` and `global.json`. Core supplies shared library user data through `SHIP_HOME`; changing the active executable does not restore the data schema. |
| Generated O2R   | [Engine.cpp](https://github.com/HarbourMasters/Ghostship/blob/762ce4a6dff8d69b934a41a326ae41e78431e6cd/src/port/Engine.cpp), blob `f04d88182bda3132c0719f8a3e7d1ee8c0e6cbda`                                                                  | [Engine.cpp](https://github.com/HarbourMasters/Ghostship/blob/deb091c29caff57dd986398087b058f16b11911e/src/port/Engine.cpp), blob `10ae903d2f3ee6810cf228721345b8911b69d4f2`                                                                                  | Both check generated archive major/minor against the running build. Existing generated bytes do not establish backward compatibility.                                                                                          |

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
JSON and integer version 1. Reads are limited to 1 MiB per file through the
existing path helper. This checks the reader's version marker; it does not
validate all upstream save fields or qualify save gameplay. Malformed,
oversized, unsafe, unreadable or unsupported-version files are held intact.
The check also contributes to normal launch readiness and action assessment.

A retained `sm64.o2r` without reviewed legacy-reader compatibility is held for
2.0.0, including when installation provenance was removed. Core does not parse
that compressed archive, rewrite it, delete it, convert saves or infer trust
from a new local hash. This conservative historical configuration needs a
reviewed recovery/regeneration contract before use. 3.0.0's previously accepted
same-version route and unrelated ports are outside this hold.

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
