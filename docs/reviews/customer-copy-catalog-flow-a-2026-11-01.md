# Customer copy: catalog flow review A, 2026-11-01

Issue: [#4198](https://github.com/boburning/portcove/issues/4198).

This research segment read **300 complete manual guides**, indices **0–299** in
sorted catalog filename order: `007frwl-xberecomp-tgp482-007-from-russia-with-love.json`
through `disruptorrecomp-recompteam-recompteam-disruptor.json`. The initial A
partition contained 568 guides; a separate reader owns indices 300–567. This
report establishes coverage of 0–299 only. It does not claim the remaining guides
were read here.

The primary sources are the current authored records in
[`crates/portcove-core/catalog/ports`](../../crates/portcove-core/catalog/ports),
reviewed against [Content design](../CONTENT-DESIGN.md) and the
[manual setup contract](../CATALOG.md#continuous-admission). No new upstream,
package, native-app, gameplay, save-restoration or human-comprehension observations
were made. Existing claims and their unknown or untested limits remain source
facts, not new qualification.

## Complete-flow method

Each guide was read with its listing summary, every numbered step and warning,
help URL, retained manual-preparation notes and any source-requirement or edition
labels. Exact repeated paragraphs were read once and referenced while checking
each guide's complete sequence and title-specific context. Exact instructions
repeated verbatim inside longer preparation notes were recognized as such; extra
note text was read separately. This is paragraph reuse with individual flow
inspection, rather than keyword-search coverage.

The PSX family was checked with every per-guide mapping and all edition-specific
middle-step variants. This retained European/USA disc sets, retail versus setup
BIOS, required CUE tracks and SBI basenames, uncertain disc switching, and
separate Arcade/Evolution saves. The CPS2 collection was checked separately for
every arcade set, region, key/composite-set rule and literal `--play` value. The
managed/external alternatives in ReflectionHLE, BStone and DevilutionX were read
with their distinct preservation and ownership instructions. These facts come
from the individual authored records, including
[Resident Evil 3](../../crates/portcove-core/catalog/ports/alexbeav-resident-evil-3-recomp.json),
[Vampire Savior Definitive](../../crates/portcove-core/catalog/ports/cps2recomp-vampire-savior-definitive.json)
and [Diablo](../../crates/portcove-core/catalog/ports/diablo-devilutionx.json).

## Exact recommendations

The retained replacement file contains **324 exact groups, 353 field changes**
across **115 guides**. The other **185 guides** have explicit reviewed-no-change
records. Counts describe proposed source-field edits, not applied catalog changes.

The most consequential findings were:

- Experimental entries often glue words, platform names, original-file identities
  and build instructions together. The proposed replacements use complete
  sentences while keeping exact game editions, filenames, hashes and tools.
  Examples include
  [007: From Russia with Love](../../crates/portcove-core/catalog/ports/007frwl-xberecomp-tgp482-007-from-russia-with-love.json)
  and [Crystal Defenders](../../crates/portcove-core/catalog/ports/cristalis-claudio5702-crystal-defenders-xbox-live-arcade.json).
- Some player steps ask for research or proof work, or describe internal review
  machinery. The replacements state the actual missing information and supported
  next task without inventing a package, a completed build or a compatible input.
  [Captain America](../../crates/portcove-core/catalog/ports/captain-america-super-soldier-recompiled-m1ndcrap-captain-america-super-soldier.json)
  and [Armored Core](../../crates/portcove-core/catalog/ports/ac1recomp-neonlightning-armored-core.json)
  retain their incomplete setup/package facts.
- Some completed-player headings describe architecture or acceptance instead of
  the player's action. Revised headings name selecting the player, reviewing
  launch details, closing actual processes and retaining recoverable files.
  Original instructions retain consent, working directories, literal arguments,
  successors, external ownership and no-managed-backup limits; the proposals do
  not broaden those capabilities.
- Long discovery summaries sometimes repeat research inventories despite a more
  specific existing setup flow. The replacement summaries for
  [Ambermoon.net](../../crates/portcove-core/catalog/ports/ambermoon-ambermoon-net.json),
  [NXEngine-evo](../../crates/portcove-core/catalog/ports/cave-story-nxengine-evo.json)
  and [PanzerChasm](../../crates/portcove-core/catalog/ports/chasm-the-rift-panzerchasm.json)
  state the prepared-copy task and preserve the applicable permission/setup limits
  in the complete guide.

No replacement changes a machine identifier, admission decision, URL, package
pin, checksum requirement, save path or operation authority. No catalog or product
source was edited by this research segment.

## Retained evidence and validation

Local review artifacts under `work/customer-copy/` are:

- `catalog-flow-a-source.json`: exact source snapshot and complete sorted index;
- `catalog-flow-a-coverage.json`: all 300 guide records, source hashes, read scope,
  status, reasons and proposed field counts;
- `catalog-flow-a-replacements.json`: exact old/new prose, JSON pointers, reasons,
  counts and occurrence paths;
- `catalog-flow-a-drafts.json`: individual field-level proposal records.

Validation checked all 353 unique field locations against the source snapshot,
each group's occurrence count, absence of duplicate field edits, complete
0–299 coverage and current source preimages. At validation, every current field
still matched its exact old or proposed new value. This proves applicability and
coverage bookkeeping; it does not establish rendered comprehension, native
behavior or upstream correctness. The delivery owner must apply the proposals,
complete the separate remaining reader's coverage and run the repository's
required review and validation.
