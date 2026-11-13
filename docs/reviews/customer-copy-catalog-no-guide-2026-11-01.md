# Customer copy: catalog records without setup guides, 2026-11-01

Issue: [#4198](https://github.com/boburning/portcove/issues/4198).

All **289 catalog files without `listing.manual_setup`** received a complete
editorial read. None has an integration-level setup guide. This segment covers
all listing summaries, names, edition labels and download-block reasons, all
42 retained preparation notes, all 105 source-requirement labels and the other
customer-facing edition/settings labels present in those files. Each file has
an explicit changed or no-change disposition.

The primary sources are the authored
[catalog records](../../crates/portcove-core/catalog/ports), read against
[Content design](../CONTENT-DESIGN.md) and the
[catalog presentation contract](../CATALOG.md#continuous-admission). No fresh
upstream lookup, package inspection, native run, gameplay, save-restoration or
human-comprehension observation was performed. Facts marked unknown, untested,
failed, conditional or project-reported retain those meanings.

## Field inventory and review method

The retained per-file inventory contains **7,404 actual string fields**:

| Role                              | Fields | Treatment                                                                                 |
| --------------------------------- | -----: | ----------------------------------------------------------------------------------------- |
| Customer prose                    |    987 | Read completely with the file's identity, input, platform, package and ownership context. |
| Operational values and identities |  5,374 | Enumerated and preserved; not converted into player promises.                             |
| Links                             |    486 | Retained as source context, without fresh upstream verification.                          |
| Maintainer evidence               |    557 | Retained for its technical/historical purpose.                                            |

Exact duplicate prose was referenced only after its entire paragraph was read,
with every file's complete player context checked. No keyword scan was used as
an editorial coverage substitute. The short existing native-port summaries
usually already describe the port without overstating gameplay. Their precise
edition, disc and BIOS requirements remain intact. Longer preparation notes were
read completely, including shared external profiles, fallback writes, backups,
privacy, update/deletion ownership and failed-start limits; technical evidence
was kept purposeful rather than mechanically flattened into ordinary UI copy.

## Proposed changes

The exact replacement file contains **173 groups covering 178 fields** in
**165 files**; **124 files** need no change from this review. The proposed fields
are 115 summaries, 50 original-file labels, ten download-block reasons and three
preparation-note phrases. These counts describe recommendations, not catalog
edits performed by this researcher.

The main changes are:

- Rewrite compressed experimental summaries as complete sentences about current
  progress, original-file requirements, setup and limitations. Preserve exact
  editions, title IDs, filenames, hashes, versions and platform limits. For
  example, the
  [Amped 2](../../crates/portcove-core/catalog/ports/amped-2-amped2-recomp.json)
  summary keeps its Linux route and explicitly unplayable Windows preview,
  rather than treating Wine/Proton as native Windows evidence.
- Remove research-work instructions and repeated field headings from discovery
  summaries. Missing facts become explicit limitations; existing partial tests
  remain scoped. The
  [Perfect Dark](../../crates/portcove-core/catalog/ports/n64hub-perfect-dark-recomp.json)
  proposal retains the reported Defection mission, WSL/Dozen hangs and host
  freeze, limited Windows audio testing and exact ROM identity.
- Name required original game files clearly instead of the ambiguous label
  `source`. Exact editions, revisions and formats remain unchanged, including
  the [Majora's Mask](../../crates/portcove-core/catalog/ports/2ship2harkinian.json)
  and [Golden Balloon](../../crates/portcove-core/catalog/ports/diddy-kong-racing-golden-balloon.json)
  requirements.
- State download refusals as the player's current consequence and the same
  attributable resolution condition, rather than exposing issue-authoring or
  backlog-maintenance tasks. The
  [Gran Turismo 2 Arcade](../../crates/portcove-core/catalog/ports/granturismo2recomp-vulob1-gran-turismo-2-arcade-mode-v1-0.json)
  proposal retains its conflicting generated-code setup contract and the full
  download/build/registration/launch restriction. It does not infer permission
  or decide a general copyright question.
- Keep source-only, local-build, packaged-player, server and compatibility-layer
  routes distinct. For example,
  [Tekken Tag Tournament 2](../../crates/portcove-core/catalog/ports/shihabal3amri-tekken-tag-tournament-2-pc.json)
  keeps Linux server packages separate from the Windows player installer;
  [Tears of the Kingdom](../../crates/portcove-core/catalog/ports/the-legend-of-zelda-tears-of-the-kingdom-switch-edition-totk-recomp.json)
  keeps its mandatory command-line source build, exact original/key requirements
  and single outdoor Steam Deck observation.

No recommendation changes a serialized identifier, machine enum, checksum,
release pin, path declaration, support state or operation authority. Permission,
consent, protected acceptance and actual compatibility remain with their existing
owners and evidence. No catalog or product source was edited by this research.

## Retained artifacts and validation

The local evidence under `work/customer-copy/` includes:

- `catalog-no-guide-source.json`: all 289 exact source records in sorted order;
- `catalog-no-guide-coverage.json`: per-file disposition, reason, source hash and
  complete string-field inventory with exact JSON pointers and roles;
- `catalog-no-guide-replacements.json`: exact old/new text, reasons, counts and
  occurrence paths;
- `catalog-no-guide-drafts.json`: individual proposed field records;
- `catalog-no-guide-validation.json`: coverage, inventory and applicability totals.

Validation checked continuous indices 0–288, one disposition per file, every
replacement's original text against the snapshot and current source, unique
field pointers and exact group occurrence counts. No current source preimage
mismatch was found. Local links in this report were checked. These checks
establish inventory, editorial read coverage and proposal applicability; they
do not establish rendering, comprehension, upstream correctness or native/game
behavior. The delivery owner applies and reviews the changes under the existing
repository quality and delivery rules.
