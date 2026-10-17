# Repeatable authoring and maintenance preparation, 2026-10-17

This is bounded preparation evidence for [#254](https://github.com/boburning/portcove/issues/254).
It reuses the delivered generator, captured Core proposal inspector, artwork
preparation and #1938 reporting. No application, adapter or maintained harness
change was needed for these cases. No catalog definition, trust configuration,
qualification declaration, support tier or installed library was changed.

The inspected repository was `0877da27fbfd7278267738bd11be7f79142685bd`;
the subsequently delivered #2094 changes no authoring/catalog inputs. The selected
Core inspector was captured from an existing local development artifact, SHA-256
`b24ae2ea052dbc6d7738cda3801734ace0c018a11a58b63b206427c3b7eac6f7`.
Its exact captured bytes, process outcomes and per-port declaration receipts are
retained. Its original producing build/revision was not recovered: these receipts
prove that explicit artifact's checks, not a newly built current-head inspector
or its equivalence to every later Core change.

## Ordinary preparation and a real correction proposal

The ordinary command was the existing
`node scripts/generate-catalog.mts --prepare-proposal INPUT --validator-cli CAPTURED_CLI --output-dir NEW_DIRECTORY`.
An unchanged accepted-catalog preparation first passed all three Core declaration
checks and returned identical catalog content. The canonical catalog digest was
`84cfdfb46dd5c5a64978f4821bbed8dddecac59130516526eb24fa30af9ec292`;
this normalized digest is distinct from the embedded file's raw-byte digest.

The next proposal adds only `starship.cfg.json` to Starship's preservation list,
retaining `config.json` and all other facts. This is the concrete source finding
already retained in [the #61/#315 observation](https://github.com/boburning/portcove/issues/315#issuecomment-6102143040):
the selected v2.0.0 context uses that settings filename. The report identifies
exactly one persistence addition, no source/execution/other changes and no order
or shared-source changes. Accepted, input and output declarations pass; the
independent legacy identity fixture matches. The proposed catalog digest is
`d7bc7de3231bb0e8dcba389aeb56b3102a3e9d55f2f3457cd2523fe1fe110c1c`.

A second preparation into a different new directory returns the same proposed
catalog digest and complete differences. A separately constructed unsafe
`../not-owned` persistence path is refused by Core with exit 2; the generator
exits 1 and retains its process receipt. Neither refusal changes accepted inputs.
These are unsigned proposals. They do not admit new ownership for existing
installations or repair Starship's separate setup/source mapping, curated
integrity, protected publication or runtime acceptance gaps.

Artwork uses the existing accepted mappings. Across each complete preparation,
79 mappings are reused and 17 existing unmapped entries retain their specific
exception/fallback outcomes. The artwork report contains each reason and resume
condition; these are not new blanket exceptions. No fresh imagery is selected.
Provider authentication/game/image request counts and transferred image bytes
are all zero. The 17 attempted game-query callbacks are not 17 network requests.

The existing automatic cost report measures 3349.6941 ms for unchanged preparation,
1827.4029 ms for correction preparation and 3181.7247 ms for its repeat. This is
monotonic elapsed time within the report's declared boundary, including waiting;
startup, input parsing and final writes are excluded. These different runs are
not a comparable speedup baseline. Engineering, authoring, routine owner actions,
CPU time and eliminated work remain unmeasured. No zero-intervention delivery
claim follows from running the preparer without an interactive prompt.

## Distinct games sharing one real artifact lineage

The accepted Gold [#55](https://github.com/boburning/portcove/issues/55), Silver
[#99](https://github.com/boburning/portcove/issues/99) and Crystal
[#100](https://github.com/boburning/portcove/issues/100) definitions remain distinct.
All three were checked in the complete preparations above. Independently fixed
expectations retain their own source profiles and `POKEPORT_VERSION` values:

| Port                 | Source profile    | Version/cache namespace |
| -------------------- | ----------------- | ----------------------- |
| `gen2recomp-gold`    | `pokemon-gold`    | `gold`                  |
| `gen2recomp-silver`  | `pokemon-silver`  | `silver`                |
| `gen2recomp-crystal` | `pokemon-crystal` | `crystal`               |

They share `UNDERdecoded/Gen2Recomped`, `generated-cache`, `Gen2Recomped.exe`,
`POKEPORT_IMPORT_ROM`, copied `portcove-import.gbc` and the portable marker.
Shared repository or package identity does not merge game/source/save identities.
Their accepted artwork mappings and source/ownership contracts are unchanged.

Two actual historical Windows packages provide the finite subsequent-artifact
preparation case; neither is invented or relabeled as the latest release:

| Release                                                                      | Release ID |  Asset ID |      Bytes | Provider and observed SHA-256                                      |
| ---------------------------------------------------------------------------- | ---------: | --------: | ---------: | ------------------------------------------------------------------ |
| [v0.7.49](https://github.com/UNDERdecoded/Gen2Recomped/releases/tag/v0.7.49) |  387619558 | 559511636 | 15,382,734 | `66781ce17aa55c77d1cb21dd0d0f76e465db3ddae862fdf7a1b4b12530e98287` |
| [v0.7.50](https://github.com/UNDERdecoded/Gen2Recomped/releases/tag/v0.7.50) |  387832535 | 560829469 | 15,593,494 | `fed3bd31fd263d14b09316c53f5dcae9592396cd6d3ba38cbbc5c724f0438ffc` |

Each selected release metadata inventory contains 13 assets. Only its exact
Windows ZIP was downloaded, anonymously from the direct publisher, with a 24 MiB,
90-second and five-redirect cap. Both complete downloads match provider size and
SHA-256. There is no mirror or redistribution claim. The fixed source is
source-available for private use under
[LICENSE.MD at v0.7.50](https://github.com/UNDERdecoded/Gen2Recomped/blob/4c9537307d6d08c337cd89ff813e3205a8a78e4b/LICENSE.MD),
not an open-source or general redistribution grant. Cartridge-derived data is
excluded; none was acquired or executed. An initial case-mismatched `LICENSE.md`
API request returned 404; the exact root inventory resolved `LICENSE.MD`. That
failed read was retained and was not treated as absence of licensing.

Both archives have the same ten paths under `Gen2Recomped-win64`, one x86-64 PE32+
game executable, seven unchanged runtime DLLs and the same runtime license text.
Full entry decompression/CRC and path/collision/symlink checks passed. Expanded
sizes are 21,400,650 and 21,611,962 bytes. The executable hashes are respectively
`86031451d42fd208cdda966bcfb66434a7cccb6c26c0599515c72d2d1e53f831`
and `2c62a948c4d36605afc5e73fff29622dcd75533bfc630f1bd98e4bc4493be8ed`.

The fused LÖVE ZIPs have 689/690 entries and central directories of 70,448/70,537
bytes. Raw central metadata was bounded before parser construction. Selected
inert text inspection found `main.lua`, `conf.lua`, `Platform.lua`, `SaveData.lua`
and `GameVersion.lua` byte-identical across the pair. They retain the import
environment, portable coordinates, per-game namespace and save/settings routing.
`CacheFs.lua`, `RomImporter.lua` and `RomExtractorGen2.lua` changed and were retained
separately; unchanged runtime libraries do not imply unchanged game behavior.
The new `CacheFs.rmdirReal` is upstream mod-management code, not additional
Portcove deletion authority. Source comparison covers one commit and 60 files,
below the provider comparison ceiling. No build-provenance claim follows from
matching a source tag to release metadata.

This demonstrates exact package selection/layout and existing-capability
maintenance preparation, not actual compatible update execution, importer output,
save preservation on the new artifact, native/installed acceptance or gameplay.
Later v0.8.x packages observed during pickup are outside this bounded receipt;
no pin or current-release qualification was introduced.

The captured inspector also consumed six supplied metadata cases: one baseline
and one successor case for each of Gold, Silver and Crystal. Fixed independent
expected release/asset IDs were `387619558/559511636` then
`387832535/560829469`; all six selected those exact Windows objects. The
successor case uses provider ordering (v0.7.50 first), and retains both complete
selected-release inventories. These are supplied bounded historical cases, not
the configured observer, a complete current upstream inventory or actual
scheduled execution. Their envelope clocks record case construction. An initial
malformed envelope refused, and a chronological rather than provider-ordered
case selected its first release; both are retained without claiming production
observer failure. All successful reports retain `core-release-metadata` scope and
false provider-authentication, artifact-byte-verification and catalog-admission
flags. None opened its explicitly selected nonexistent library.

## A separately held successor stays held

The existing [CVLoD successor/correction proposal](cvlod-windows-compatibility-proposal-2026-10-13.md)
is reused. Fresh Windows v0.2.26/v0.2.27 downloads matched its recorded provider
sizes and SHA-256; all 53 entries in each ZIP passed bounded path, decompression
and CRC checks. Expanded sizes were 66,249,516 and 66,365,115 bytes. Both contain
one `LodRecomp.exe`, PE AMD64/PE32+, at their versioned package root.

This adds real package-byte/layout evidence to that earlier metadata/source
receipt. It does not demonstrate repair of the known normal-close failure,
materialization, lifecycle progression or `cheats.cfg` preservation. Those
requirements remain with #320; this case is not the positive compatible-runtime
canary or a reason to replay unrelated passed checks.

## Retained evidence and remaining acceptance

Raw metadata, bounded inspection scripts/manifests, selected source text,
captured inspector/process receipts and full #1938 proposal/artwork reports are
retained under `work/slice4/` in the owning checkout. The principal report hashes
are:

| Report                                                       | SHA-256                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `ordinary-baseline/proposal-evidence.json`                   | `68a9dd6a1501af143c5eb69493fc0fe8555f1198eeb9ee0d745196cfd014490c` |
| `starship-settings-correction/proposal-evidence.json`        | `ad2778ff2c384ad0ee5d540d8c322fe11cf26dc398d35d1cd433a223446a2c81` |
| `starship-settings-correction-repeat/proposal-evidence.json` | `0c3197bdd9d3b7887fcea411b4c534b9872f8ffde910fa3b07999ee4211a9316` |
| `gen2-artifacts/selected-source-inspection.json`             | `3361e685b125d98bdfaa84a54678cb585dbdd2980f1a75a6a15fe64a035b48b4` |

Inspection used Node 24.22.0 and Python 3.14.8 standard libraries. Outer ZIP work
was bounded to 4096 records, 2 MiB raw central metadata, 64 MiB per expanded entry,
192 MiB total expanded bytes and a 30-second cooperative deadline. Selected
fused-source parsing bounded raw metadata/counts before `zipfile` construction
and each selected member before decompression. No extraction into an install or
upstream program execution occurred.

Credit earlier actual admissions (#1679/#1749/#1948), #1938's reporting and its
Ace Combat 3/CVLoD receipts separately. Combined with those delivered foundations,
these receipts satisfy #254's bounded repeated authoring, subsequent-artifact and
compatible-correction preparation requirements. Separate review and delivery of
this receipt complete that authoring outcome; neither a fresh inspector build nor
reproduction of #246's protected journey is an additional #254 gate. The selected
inspector's unrecovered producing revision remains an evidence limitation.

#315 still needs a genuine protected curated canary; #246 still needs its ordinary
unchanged-client/protected journey, and #534 retains actual production authority
and execution proof. Fixtures, unsigned preparation, real package bytes, runtime
observations and production delivery remain distinct.
