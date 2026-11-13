# Catalog customer-copy inventory — 2026-11-01

This source review for #4198 inventories all **1,424 authored port records**, including **1,135 manual guides** and **289 records without a guide**, at `c5214c867b4234593f5935115fc64bb122bf679a`. Every guide was read as an assembled flow; every record without a guide was read with its available listing and presentation copy. There are no unread guides or unaccounted customer prose fields in this baseline. This is editorial source review, not fresh upstream verification, rendered-interface testing, installation, gameplay or support acceptance.

The governing sources are [Content design](../CONTENT-DESIGN.md), particularly player tasks, checked properties and supporting evidence; [Catalog ownership](../CATALOG.md#integration-ownership), original-file and saved-data contracts; and the [authored presentation types](../../crates/portcove-core/src/types.rs). Cataloged, managed, externally registered and Supported remain separate states. The review changes no distribution permission, runtime owner, original-file requirement, executable trust decision or data boundary.

## Complete source inventory

The retained machine inventory is `work/customer-copy/catalog-inventory.json` under ignored `work/`. It preserves every source path, JSON pointer, original string and digest, plus exact-text occurrence mappings and review dispositions. It enumerates **37,685 string fields**: **12,926 customer prose/instruction fields**, 16,835 operational or identity fields, 3,675 maintainer evidence fields and 4,249 links. Operational values, evidence and links were enumerated separately so editorial changes cannot silently redefine them. Generated catalog projections and historical fixtures are outside this authored-source inventory.

| Customer field                                           | Occurrences |
| -------------------------------------------------------- | ----------: |
| `/listing/name`, `/listing/summary`                      |  1,424 each |
| `/listing/original_game_title`, `/listing/variant_label` |   1,142; 15 |
| `/listing/manual_setup/steps/*/title` and `/instruction` |  3,447 each |
| `/listing/manual_setup/warnings/*`                       |       1,597 |
| `/listing/download_block_reason`                         |          92 |
| `/integration/presentation/manual_preparation`           |         211 |
| `/integration/presentation/source_requirements/*/label`  |         119 |
| `/listing/original_game/source_editions/*/title`         |           6 |
| `/integration/game_settings/files/*/settings/*/label`    |           2 |

There are **9,133 distinct complete prose strings** and **1,131 distinct complete guides**. Whole-guide similarity is not proof that editions or setup facts are interchangeable. Exact repeated paragraphs were read once in full and then referenced while reading each guide's distinct summary, inputs, ordered steps and warnings. Distinct middle paragraphs, media sets, BIOS choices, profiles and permission conditions were reviewed separately. Keyword searches and automated enumeration supplied candidates; neither is counted as individual editorial reading.

Coverage receipts are `catalog-flow-a-coverage.json` (sorted guides 0–299), `catalog-flow-middle-coverage.json` (300–567), `catalog-flow-b-coverage.json` (568–1134), and `catalog-no-guide-coverage.json`. `catalog-all-guide-coverage.json` joins all 1,135 guide receipts; `catalog-all-customer-field-coverage.json` gives each of the 12,926 prose fields a disposition, reason and exact proposal references. **3,179 distinct fields have replacement proposals; 9,747 were reviewed with no change proposed.** These are proposal dispositions, not a claim that those changes were applied or accepted. The no-guide review includes 987 customer fields, including substantial fallback preparation notes; absence of a guide does not mean absence of instructions.

## Findings and exact rewrite direction

The main problems are compressed source-research notes presented as instructions, internal field names exposed to players, repeated engineering acceptance lists, and summaries that contradict their own more precise setup instructions. Exact old/new full-field proposals, with every affected source path and pointer, are retained in `catalog-reviewed-replacements.json`, `catalog-reviewed-replacements-v2.json` through `-v10.json`, `catalog-flow-a-replacements.json`, `catalog-flow-middle-replacements.json` and `catalog-no-guide-replacements.json`. Later numbered batches can have sequential preimages; `baseline_old`, where present, retains the baseline text. These are reviewed proposals, not a blind global substitution list.

Representative exact replacements:

| Source and pointer                                                                                                                              | Recommended customer copy                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phantasy-star-universe-recompiled-experimental-danielcoffey1-phantasy-star-universe-xbox-360.json` `/listing/manual_setup/steps/1/instruction` | Use the experimental Windows installer with your own USA or European Phantasy Star Universe ISO. It checks and extracts the image and prepares the runtime. Whether setup generates game code locally has not been confirmed. |
| `ufe3-recomp-idiazraz-ultraman-fighting-evolution-3.json` `/listing/manual_setup/steps/0/instruction`                                           | Use your own Japanese SLPS-25441 disc and ELF. This guide does not include the exact supported revision or hash; check the project’s original-file requirements before setup.                                                 |
| `worlddriverchampionship-recomp-alondero-world-driver-championship.json` `/listing/manual_setup/steps/0/instruction`                            | Use your own USA ROM. This guide does not include the exact supported revision or hash; check the project’s game-specific profile before setup.                                                                               |
| `tmb-recomp-boubou666-twisted-metal-black.json` `/listing/manual_setup/steps/1/instruction`                                                     | Follow the project’s local source build. A complete encounter has not been confirmed; this is not an established playable release.                                                                                            |

All filenames above are under `crates/portcove-core/catalog/ports/`. The 42 paragraphs exposing `source_identity_facts` have individual rewrites in v2. They retain known game, edition, media, update and hash facts while stating which revision or fingerprint remains unspecified. “Capture”, “transcribe”, “read back”, “resolve” and “resume qualification” tasks become either an actionable player step or an explicit unknown; the rewrite does not manufacture the missing answer. Examples include the conflicting Perfect Dark Xbox One/XBLA input instruction, unsupported exact OpenKai2 disc identity and unspecified SOCOM region/revision.

The shared discovery warning (521 occurrences), PSX setup family (87 guides), external-registration paragraphs and profile-preservation paragraphs can use exact templates only where their full preimages match. The PSX family includes distinct multi-disc, BIOS and SBI cases: Armored Core Master of Arena's two USA discs, Fear Effect 2's four USA Rev 1 discs, Galerians' three European discs, Resident Evil 3's matching SBI and European BIOS, and Rival Schools' separate Arcade/Evolution discs and saves. These remain distinct. The 78 identical generic BIOS paragraphs and five identical GemRB CachePath paragraphs do not erase game-specific context.

Open1560, NFS Recompiled II/III, Pharaoh, OpenLara and SMBX have stale listing summaries despite more exact guide instructions. Rewrites follow the facts already present in the same record: preview versus retail data, exact executable route, Cleopatra requirement, TR1 PC `DATA/GYM.PHD`, and the named SMBX game pack. They add no new upstream verification. The 16 v64 profiles retain their own edition, profile path, CMake target and embedded-versus-external ROM behavior; another game's screenshot is not evidence that this game works.

## Safety and evidence retained

The review keeps instructions that affect real files even when simplifying surrounding engineering language:

- GemRB clears CachePath; it must not point at originals, saves or profiles. Raze's `-savedir`, portable marker and migration behavior keep their game/edition distinctions.
- Open1560's `-cleandir` deletions and `-nocleandir` choice remain explicit. NFS runtime writes/deletions can affect installation and CD-data roots.
- Pokémon Stadium's unauthenticated `127.0.0.1:4371` debug controls and the fact that `PSR_DEBUG_PORT` changes the port rather than disabling it remain. Transfer Pak/GB Tower can write separately configured cartridge saves.
- Dimensions' `PATCH3` renaming and possible removal of older `.off` files remain. re:Blue can apply a staged update before checking its update setting. Upstream recovery metadata must not be deleted to force progress.
- Quickstates remain tied to creating runtime/build/mod settings. Runtime rollback does not rewind saves or establish backward compatibility. Super Metroid's existing managed copy is not silently converted to a separate Preview route.
- Actual external, shared, fallback and custom save roots remain outside declared backups where the record says so. External registration can still select a player that writes to data used by another installation; it is not a universal promise that registered games cannot affect managed data.
- Launcher exit is not proof that a detached game exited or flushed saves. Forced-exit watchdogs, shared title selection and direct-player bypasses retain their exact limits.

Permission holds remain operation-specific. An engine or framework licence does not grant original-game, BIOS, SDK, generated-code, texture, audio, translation or mod permissions. Package availability, a new tag or a checksum does not clear a retained rights condition. Unknown requirements remain unknown.

Dated source/package observations remain supporting evidence, separate from player steps and current operational claims. In particular, “the recorded source review did not download or run the game” describes that review; it does not say that eventual player instructions cannot run the game or erase earlier explicitly bounded observations. No new native, protected, physical-controller, multiplayer, complete-game or save-compatibility result is inferred.

## Verification and limits

Enumeration checks establish 1,424 unique source files, 1,135 distinct guide locations, 289 complementary no-guide records and exactly 12,926 customer-field coverage records. Every exact proposal retains occurrence pointers for review against the baseline. A lexical preservation audit found no filename, hash or URL changes in the large v7 spacing batch or v9 follow-up. Earlier exceptions are individually identified: intentional stale-summary corrections and profile facts copied from the same guide, plus hash boundaries previously fused to `SHA1`/`SHA256`. The actual `FreeRidersRecompiled.exe` filename is preserved; an early proposal that split it was corrected before final artifact readback.

This documentation records source review and recommendations. Applying proposals, resolving concurrent edits, reviewing the resulting complete copy, regenerated-catalog checks, rendered-flow checks and delivery belong to the parent implementation. The report does not claim that an editorial pass resolved factual unknowns or completed product acceptance.
