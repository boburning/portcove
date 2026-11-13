# Catalog guide flow review: middle partition, 2026-11-01

Issue: #4198. Reference base: `c5214c867b4234593f5935115fc64bb122bf679a`.

This review individually read all 268 guides at indices 300–567 inclusive in
sorted `crates/portcove-core/catalog/ports/*.json` filename order, filtering for
`listing.manual_setup`. The partition starts with
`djultra64-blocksphere.json` and ends with
`magiciansquest-recomp-waifoof-magician-s-quest-mysterious-times.json`.
The reading snapshot includes the earlier customer-copy edits already present
in this worktree; the reference base is not a claim that their preimages came
from the unmodified base commit.

## Sources and method

The writing authority is [Content design](../CONTENT-DESIGN.md), especially
player task order, checked-property scope, unknown facts and complete task-path
review. [Catalog setup guidance](../CATALOG.md#catalog-author-task-routes)
requires original-file identity, saved-data ownership and setup instructions to
follow the selected implementation. The adjacent authored setup guidance also
requires the first manual step to name the next game task and reserves managed
retention explanations for `presentation.manual_preparation`.

Each read covered the complete listing summary, every numbered instruction,
every warning and help link, all integration mechanical facts, and every
presentation field present, including source requirements, editions and manual
preparation. Exact repeated text was referenced only after its complete earlier
reading within this partition; each occurrence's own game, edition, process,
platform, ownership and preservation context was checked. Two truncated outputs
were reread explicitly: guides 351–353 and 524–525.

The primary factual sources were the authored catalog records themselves. This
was an editorial review of those contracts. No upstream freshness check,
download, game execution, real-save test, native observation or new compatibility
qualification was performed.

## Results

There are **666 exact field replacement proposals across 216 guides** and
**52 reviewed guides requiring no replacement**. Each unchanged guide has an
individual reason. No catalog or application file was edited by this reviewer.

The proposed changes turn compressed original-file and build fragments into
complete actions, replace engineering handoff and roadmap assertions with
player-facing consequences, and keep unknown requirements unknown beside a
useful upstream next action. Existing exact hashes, filenames, editions,
paths, launch arguments and relevant legal, security, consent and data-loss
warnings are retained.

Representative decisions:

- [ClayFighter 64](../../crates/portcove-core/catalog/ports/djultra64-clayfighter64.json)
  separates joined hash labels and platform requirements while retaining both
  ROM identities, fused-game limits and component-permission conditions.
- [Dragon's Crown Pro](../../crates/portcove-core/catalog/ports/dragon-s-crown-pro-ps4-dragon-s-crown-pro-pc.json)
  names the regional versions and overlay setting as player choices, preserving
  the same-process requirement, exact launch argument and saved/key data.
- [FreeSpace Open](../../crates/portcove-core/catalog/ports/freespace-2-freespace-open.json)
  has a stale summary calling original requirements unknown even though its own
  complete guide names retail v1.2. The proposal follows that existing guide
  and keeps standalone campaigns, CPU choice and release-candidate scope separate.
- [Edge of Time](../../crates/portcove-core/catalog/ports/goliathret-edgeoftimerecomp.json)
  and [Legend of Legaia](../../crates/portcove-core/catalog/ports/legend-of-legaia-legend-of-legaia-recomp.json)
  replace live-planning and internal acceptance language in ordinary warnings
  with the actual untested behavior and external-maintenance limits. Their
  startup cleanup, recovery and original-file constraints remain unchanged.
- [Go Go Ackman](../../crates/portcove-core/catalog/ports/go-go-ackman-go-go-ackman-recompiled.json)
  explains hybrid compiled/interpreted behavior and unresolved translation
  permissions without inventing native coverage or clearing the download condition.
- [Perfect Dark Android](../../crates/portcove-core/catalog/ports/izzy2lost-perfect-dark.json)
  needs no rewrite: its existing flow precisely requires preserving EEPROM and
  app data before the signing-key change's uninstall/reinstall transition.
- [Frontschweine](../../crates/portcove-core/catalog/ports/hogs-of-war-frontschweine-playstation-german-pal-frontschweine-recompiled.json)
  retains destructive card, settings, legacy-state and mod-migration warnings;
  the proposals only expand joined disc identifiers and implementation wording.

## Review artifacts and validation

Ignored work artifacts are retained under `work/customer-copy/`:

- `catalog-flow-middle-source.json`: complete source snapshot for all 268 guides.
- `catalog-flow-middle-300-309.txt` through `catalog-flow-middle-560-567.txt`:
  complete chunked reading dossiers with explicit exact-text references.
- `catalog-flow-middle-coverage.json`: contiguous per-guide coverage, read scope,
  snapshot hash, outcome and reason.
- `catalog-flow-middle-replacements.json`: script-ready `file`, JSON `pointer`,
  exact `old` and `new`, `count: 1`, index and editorial reason.

Validation confirmed contiguous coverage for every index 300–567, unique
file/pointer targets, exact snapshot preimages, changed string values only,
and a strict presentation-only pointer allowlist. Duplicate setup paragraphs in
`manual_preparation` were synchronized with their proposed guide text. An
additional digest-preservation check examined every joined-label false positive
and confirmed that all complete hash values were retained exactly. These checks
validate the proposals against the reading snapshot; the applying owner must
still check each preimage against the current file and complete repository
validation for the final combined diff.
