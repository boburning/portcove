# Acquisition restriction evidence, November 22, 2026

This record checks every acquisition restriction on `main` at `e45d8b816d2e`
against upstream facts read on November 22, 2026, and proposes a scoped decision
for each row. It changes no restriction, catalog record, listing or Core code.
The data change is a separate follow-up. The machine-readable companion is
[`acquisition-restriction-evidence-2026-11-22.json`](acquisition-restriction-evidence-2026-11-22.json):
one entry per row with its current typed decisions, the facts checked, their
sources, a classification and a proposed typed row or owner option.

Specification: [#8538](https://github.com/boburning/portcove/issues/8538).
Decision authority: the owner decisions and delegation recorded on
[#1422](https://github.com/boburning/portcove/issues/1422#issuecomment-7083861462).
The lead may clear or narrow a hold when the evidence is factual and
unambiguous. Holds that turn on a rights or legal-risk judgement, or on the
scope of an owner acceptance, stay with the owner, who decides them as one batch
from this record. Where the evidence is incomplete, this record leans toward the
owner and toward `unknown`.

An independent review corrected the first version of this record on the same
day. The corrections are folded in below; no restriction changed.

## Rows covered

| Carrier                                               | Rows |          Typed decisions |
| ----------------------------------------------------- | ---: | -----------------------: |
| Listing `restrictions` (whole-listing download holds) |  152 |                      152 |
| Managed `acquisition_restrictions`                    |    5 | 16 (10 holds, 6 permits) |
| Total                                                 |  157 |                      168 |

The listing rows have 145 distinct explanations. Eleven rows share four
explanations: five Namco System 22 titles from one repository, two Dead Rising 2
recompilations, two Gran Turismo 2 modes and two R.E.L.I.V.E. titles. In the
companion they carry the same `explanation_group`. They were checked once per
repository and are classified together.

## Method and limits

- **Repository facts.** For each of the 143 GitHub repositories behind the rows,
  and Voldorium's, `git ls-remote` established whether the repository is
  publicly readable. A tags-only, tree-less fetch gave tag names, tag dates and
  the date of the last default-branch commit. Tag dates are git dates, so a tag
  can show the next calendar day in UTC, and a tag can carry its commit's older
  date. Where a release publication date is stated, it comes from the release
  page.
- **Licence.** The default-branch licence file was read from
  `raw.githubusercontent.com`. The SPDX id is inferred from the licence text.
  `NOASSERTION` means a licence file exists but matched no standard text. For
  the rows in lists (a) and (b) and the rows below whose licence or fork status
  bears on the classification, a depth-1 blobless clone listed every licence
  file in the tree, and the repository page gave the fork parent and GitHub's
  detected licence.
- **Repository and release pages.** Web fetches read the repository pages of
  the unreadable repositories, Abuse 2025 and Star Fox Enhanced, and the newest
  release page of each row in (a) and of the conditional clears in (b). A
  release page shows the release's tag, publication date and asset count, but
  loads its asset list lazily, so asset names, sizes and digests were not
  visible. Names that the release notes themselves state are recorded as such.
- **Upstream statements.** Upstream README files were read for the 17
  `legacy-rights-review` rows, the two `upstream-prohibition` rows and Open Nectar.
- **Portcove evidence.** Recorded artifact identities, owner exceptions and
  reviews come from each row's tracking issue and the cited docs.
- **Not available.** The GitHub REST API refused third-party repository reads
  in this session. The one API-only fact used here, Project Iron 6's block
  reason, is cited from the independent review's API readback and marked so.
  Release asset lists and provider digests are therefore unknown for every
  row, and no package was downloaded or listed. Whether any package bundles
  held material is not established by this record. Incomplete evidence is never
  classified as changed.
- **Non-GitHub upstreams.** For the eight rows on codeberg.org, gitlab.com,
  sourceforge.net and gnu.org, only whether the project page answered was
  checked. www.gnu.org did not answer.

## Classification

| Classification       | Rows | Meaning                                                                                             |
| -------------------- | ---: | --------------------------------------------------------------------------------------------------- |
| `factual-changed`    |    0 | The condition the hold names demonstrably no longer holds                                           |
| `scope-too-broad`    |    2 | Recorded owner exceptions and exact reviewed bytes support a narrower artifact scope                |
| `factual-unchanged`  |   49 | The named condition still holds, or the upstream is gone                                            |
| `content-unverified` |   22 | The hold names unresolved package facts; the gap is the package contents, not a rights judgement    |
| `rights-judgement`   |   83 | Lifting or narrowing turns on rights, legal risk or the scope of an owner acceptance; owner decides |
| `unknown`            |    1 | The upstream could not be reached                                                                   |

The lists below place each row once:

| List                                        | Rows | Who decides              |
| ------------------------------------------- | ---: | ------------------------ |
| (a) Lead may narrow under factual authority |    2 | Lead                     |
| (b) Owner: conditional clears               |   15 | Owner                    |
| (b) Owner: owner-scoped decisions           |    6 | Owner                    |
| (b) Owner: rights holds recommended to stay |   63 | Owner                    |
| (c) Unchanged                               |   48 | No decision              |
| (c) Content not yet listed                  |   22 | No decision until listed |
| (d) Unknowns                                |    1 | Recheck                  |

No row is `factual-changed`. SARPBC still has no licence and no release. Rage
Racer's licence file still selects none. The two upstream prohibitions are still
stated in the upstream README files.

Policy changes are different from upstream facts. The November 13 and November 15
rights decisions on [#1129](https://github.com/boburning/portcove/issues/1129)
turned several former hold bases into recorded notes. The policy itself lifts no
hold, so those rows are owner items, not lead decisions. A recorded-note basis
also does not clear a package whose contents are unknown:
[docs/CATALOG.md](../CATALOG.md#rights-basis-for-upstream-hosted-packages) keeps
such a package held until its contents are listed.

## Rows named in the brief

**San Andreas Unity and LineWars II.** Each explanation names only the old
enforcement limit: Portcove could not limit Download to the reviewed files. A
typed listing permit now gives that limit, and the downloaded bytes decide it.
The rights basis for those exact files is already recorded under owner
exceptions, so both rows are in (a). Each reviewed release is still the newest
today.

**Chameleon Twist.** The approved v0.1 ZIP rests on an owner protected
acceptance that is explicitly scoped to exact official Windows bytes on the
signed route. It accepts only `official/chameleon-twist-jp-recompiled`,
Windows x86-64, with its curated acquisition and scoped launch checks
([acceptance, line 7](../qualification/chameleon-twist-jp-exact-byte-acceptance-2026-10-21.md)),
and it grants no mirror, repackaging, blanket redistribution right or automatic
acceptance of a future asset identity (line 19). The
[#125](https://github.com/boburning/portcove/issues/125) resume condition
reconsiders additional download offers only "when the release, exact selected
bytes, applicable rights and operation-specific checks are bound". Extending
that acceptance to a generic listing permit is owner authority, so the row is in
(b). Its reason code, `bundled-game-data`, also conflicts with the
[preparation record](../qualification/chameleon-twist-jp-curated-admission-preparation-2026-10-18.md)
(lines 72 to 76): the README requires the Japanese original, releases omit game
assets, and the route uses separately supplied game data.

**OpenPrivateer.** The hold's basis is Windows only: the publisher's security
scan named a different Windows executable from the reviewed one. The #8538
specification assigns OpenPrivateer's platform scope to the rights-basis
decision authority, so the row is in (b), not (a). The facts have also moved:

- `release_url` names `build_20261113_0111`, which now returns 404.
- The [#6119](https://github.com/boburning/portcove/issues/6119) digest, Linux
  launch and no-bundled-data evidence covered only that deleted build.
- The releases page shows three builds: `build_20261117_0458` and
  `build_20261117_2026`, published November 17, and `build_20261120_2250`,
  published November 21 and marked Latest. The first version of this record
  gave all three the git date November 15, which was wrong.
- No Windows alert notice is shown. Why the reviewed build and the alert notice
  disappeared is unknown.

Before the owner decides: correct `release_url` to the current build, and
re-verify the current non-Windows archives against its `SHA256SUMS.txt` and for
bundled game data. The owner option is a Windows-only hold with
`reconsider_when: ["owner-review"]`. A hold scoped only by platform names no
reviewed version, so `reviewed-successor-release` would stay `unknown` for it.

**Voldorium.** No catalog identity or restriction row exists. Issue
[#5603](https://github.com/boburning/portcove/issues/5603) is a Watchlist
candidate. Its 1.1.7 to 1.2.1 release notes describe a Windows Defender Trojan
detection of `Voldorium.exe`. Upstream calls it a false positive: the build is
unsigned and builds a DLL on first start. The Linux 1.2.1 tarball has a published
SHA-256, and the 1.2.2 test builds are Linux only. If Voldorium is cataloged,
its platform scope is a rights-basis decision, as for OpenPrivateer. No
restriction is proposed now.

**Open Nectar.** The managed transition hold still applies. The reviewed artifact
is 0.8.5, upstream has since published 1.0.9 to 1.3, and no launcher or settings
review is recorded. The listing download is held today only because the managed
hold is whole.

The listing warning already records the bundled Pikmin 2 runtime, which is
recompiled game code. The README says the launcher extracts game assets from the
player's own disc. Under #1129, recompiled game code without a grant is a recorded
note, not a hold. The owner decision is whether a separate listing hold should
survive lifting the transition hold. The recommendation is no separate hold,
keeping the existing warning, once the package contents are listed.

## The 17 legacy rights-review rows

The #8538 specification names 17 rights re-review candidates. They are exactly
the 17 rows with reason `legacy-rights-review`, and that is the authoritative
set:

- `ace-of-spades-openspades`: (b) conditional clear
- `blizz127-parasite-eve-decomp-port`: (b) conditional clear
- `elmasas-lcs-recomp`: (b) conditional clear
- `eternal-darkness-sanity-s-requiem-eternal-darkness-recomp`: (b) conditional clear
- `final-fantasy-tactics-finfantacrecomp`: (b) conditional clear
- `mercenaries-playground-of-destruction-kraftmacandchee`: (b) conditional clear
- `monster-hunter-generations-ultimate-mhgurecomp`: (b) conditional clear
- `mstan-battle-arena-toshinden-recomp`: (b) conditional clear
- `nevercookfirst-dimensionsrecomp`: (b) conditional clear
- `novapowers0-bloody-roar-ii-recomp`: (b) conditional clear
- `odrannnn-metroidprimeport`: (b) owner-scoped decision
- `rage-racer-rage-racer-pc`: (b) conditional clear
- `ridgeracertype4recomp-tetrisgm-r4-ridge-racer-type-4`: (b) conditional clear
- `sarpbc-recompiled-snufflyyy-supersonic-acrobatic-rocket-powered-battle-cars`: (b) conditional clear
- `sonic-free-riders-recompiled`: (b) conditional clear
- `thandor-the-invasion-open-thandor`: (b) owner-scoped decision
- `toystory2-recompiled-periblugaming-toy-story-2-buzz-lightyear-to-the-rescue`: (b) conditional clear

The plan names 13 candidates, but the plan's list was not available to this
record. The split into 13 and 4 below is a reconstruction from the stated bases
and may not match the plan. Compare it with the plan before relying on it.

- **13** have one stated basis: recompiled, translated or inherited
  game code without a grant, or an unlicensed own layer. Since #1129 these are
  recorded notes.
- **4** rest on another basis: OpenSpades (no publisher digest, not a hold basis
  under tier 3), Thandor (installer art derived from the game), Bloody Roar II
  (missing notices, a recorded note) and MetroidPrimePort (the repository answers
  404).

## Recheck triggers

`reconsider_when` is already typed. Authoring accepts only seven values:
`attributable-grant`, `clean-upstream-package`, `owned-input-preparation`,
`publisher-checksum`, `reviewed-successor-release`, `upstream-route-change`
and `owner-review`. Today no row authors any of them. `tracking_issue` is
authored on all 152 listing rows.

No new vocabulary is needed. This record proposes a value per reason code in the
companion's `proposed_reconsider_when` for the follow-up data change.

[`scripts/restriction-recheck.mts`](../../scripts/restriction-recheck.mts)
evaluates the authored values. It reads the committed catalog, an optional
listing observer report and an optional evidence file. It uses no network and
writes nothing except an explicit `--output` file. Observations are read with
the same reader as the route-fit report
([`listing-observation-reader.mts`](../../scripts/listing-observation-reader.mts)):
a complete observation counts only when it binds its facts with `facts_sha256`,
and each row reports the digest it was judged from. Each condition is reported
as `satisfied`, `not-satisfied`, `unknown` or `manual`. A row with any manual
condition is flagged `manual`, meaning it needs the owner, whatever its other
conditions say; its strongest machine result is reported beside it. Rows whose
machine result is satisfied or unknown are listed so that each one flags itself.

| Condition                                 | Checked from    | Satisfied when                                                                                                                                                                    |
| ----------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publisher-checksum`                      | Observer report | Every asset of the newest complete observed release has a provider digest                                                                                                         |
| `reviewed-successor-release`              | Observer report | An unscoped release was published after the newest scoped release (by provider publication time); an older or equally dated one is not a successor, and a missing date is unknown |
| `clean-upstream-package`                  | Evidence file   | Scans with zero findings cover every asset of the newest observed release, each keyed by version and by asset SHA-256 or platform, or by version alone                            |
| `attributable-grant`                      | Evidence file   | A reviewed grant is recorded with a reference                                                                                                                                     |
| `upstream-route-change`                   | Evidence file   | A reviewed route change is recorded with a reference                                                                                                                              |
| `owned-input-preparation`, `owner-review` | None            | Always `manual`                                                                                                                                                                   |

A hold scoped only by platform names no reviewed release, so
`reviewed-successor-release` stays `unknown` for it. Pair it with a release or
artifact scope, or rely on `owner-review`.

With no authored values the script reports 162 holds and none with conditions.
The evidence file is `{ "format_version": 1, "subjects": [{ "port_id", "content_scan": [{ "version", "findings", "platform" | "asset_sha256" }], "grant": { "recorded", "reference" }, "route_changed": { "changed", "reference" } }] }`.

## (a) Narrow under factual authority (2)

Each row keeps its whole download hold and adds a download permit for exactly
the reviewed files, by SHA-256. Every other package, release and changed byte
stays held. The proposed rows pass the authoring validator,
`checkAcquisitionRestrictions`, as a listing carrier with a release route.
Older readers enforce `legacy_download_projection`
(`crates/portcove-core/src/acquisition_restriction.rs`): the explanation of the
first hold that names Download. Because the whole hold stays, readers below
listing format 14 stay fully held and never see the permit.

1. **`grand-theft-auto-san-andreas-unity`**: permit the two v4.0 desktop ZIPs.
   - Recorded owner exceptions relied on:
     - November 15, 2026 owner launcher/menu-art exception to the game-data hold: docs/CATALOG.md lines 270-282 (Owner exceptions to the game-data hold), first exception
     - Applied to the exact v4.0 desktop ZIPs: https://github.com/boburning/portcove/issues/6134 description, Current behavior paragraph: 'The existing launcher/menu-art exception covers that material' (app icons and MainMenu/Canvas/Logo at the tagged source)
     - Observed v4.0 SHA-256 identities: https://github.com/boburning/portcove/issues/6134#issuecomment-6891450087
     - Resume condition: apply enforceable release/asset restrictions and revalidate the permitted bytes: https://github.com/boburning/portcove/issues/6134 description, Dependencies and blockers
   - Today v4.0 is still the newest release.
   - Proposed rows:
     `{"id":"download","effect":"hold","operations":["download"],"reason":"bundled-game-data","explanation":"Portcove offers only the reviewed v4.0 Windows and Linux packages. Earlier releases and the Android debug package need separate checks.","tracking_issue":6134}`
     `{"id":"reviewed-v4-0","effect":"permit","operations":["download"],"scope":{"artifacts":[{"version":"v4.0","sha256":"3cf2f15827d154d172fa259117e0699fc344ab5157a1a134288820361fe27eab"},{"version":"v4.0","sha256":"fb135b7f080517393af0b17d5c1ced9ae44951b31cfdc907eb7ed851df48859a"}]}}`
2. **`linewars-ii-sdl3`**: permit the two v1.0.0 archives.
   - Recorded owner exceptions relied on:
     - November 15, 2026 owner freeware exception to the game-data hold (game data its rights holder released for free redistribution, bundled unmodified): docs/CATALOG.md lines 270-282 (Owner exceptions to the game-data hold), second exception
     - Bundled fonts not extracted from the game are recorded notes, not holds: docs/CATALOG.md lines 251-257 (Recorded notes, not holds)
     - Applied to the exact v1.0.0 archives: Patrick Aalto's freeware permission for game.dat, and the separately sourced PC 6300 and VGA bitmap fonts 'fall within the owner's non-game font exception for the inspected bytes': https://github.com/boburning/portcove/issues/6090 description, Current behavior paragraph
     - Resume condition: apply enforceable release/asset restrictions and revalidate the permitted bytes: https://github.com/boburning/portcove/issues/6090 description, Dependencies and blockers
   - Today v1.0.0 is still the only release.
   - Proposed rows:
     `{"id":"download","effect":"hold","operations":["download"],"reason":"bundled-game-data","explanation":"Portcove offers only the reviewed freeware v1.0.0 Windows x64 ZIP and Linux x64 archive. Keep their notices.","tracking_issue":6090}`
     `{"id":"reviewed-v1-0-0","effect":"permit","operations":["download"],"scope":{"artifacts":[{"version":"v1.0.0","sha256":"5bfededd432f529ab84780c07ba1f1a970708a9c7817998a52ef0b5e844b5ef8","asset_name":"LineWars2-SDL3-v1.0.0-win64.zip"},{"version":"v1.0.0","sha256":"8166787cd8a76cfa349ea35b59c3ef8b7d6624dcabe4c67097149bb9c077ac20","asset_name":"LineWars2-SDL3-v1.0.0-linux-x86_64.tar.gz"}]}}`

## (b) Owner decisions

### Conditional clears (15)

These are the code-basis legacy rows plus OpenSpades and Bloody Roar II. Each
stated basis is a recorded note or no basis under the #1129 policy, and a README
check found no explicit prohibition. A README check is not a content listing,
and a package whose contents are unknown stays held until they are listed. Each
recommendation is therefore conditional on a clean release-content listing of
the newest package named here. None of those packages is listed yet: release
pages show only the asset count, and no archive was downloaded. A cleared row
keeps its explanation as a recorded-note warning.

| Identity                                                                                                                                 | Reason               | Checked today                                                                                           | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ace-of-spades-openspades` [#5755](https://github.com/boburning/portcove/issues/5755)                                                    | legacy-rights-review | licence GPL-3.0; newest release v0.1.3 (2019-01-04), 5 assets, contents not listed                      | Conditional clear (policy application; the stated basis, a missing publisher digest, is not a hold basis under tier 3). Condition: a clean release-content listing of the newest package, v0.1.3 (published 2019-01-04). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.                                        |
| `blizz127-parasite-eve-decomp-port` [#1865](https://github.com/boburning/portcove/issues/1865)                                           | legacy-rights-review | licence MIT; newest release native-only-e26d98fd (2026-10-10), 4 assets, contents not listed            | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, native-only-e26d98fd (published 2026-10-10). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed. |
| `elmasas-lcs-recomp` [#1836](https://github.com/boburning/portcove/issues/1836)                                                          | legacy-rights-review | licence MIT; newest release v0.1.6 (2026-10-07), 3 assets, contents not listed                          | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, v0.1.6 (published 2026-10-07). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.               |
| `eternal-darkness-sanity-s-requiem-eternal-darkness-recomp` [#2570](https://github.com/boburning/portcove/issues/2570)                   | legacy-rights-review | licence GPL-3.0; newest release v0.9.6 (2026-10-24), 5 assets, contents not listed                      | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, v0.9.6 (published 2026-10-24). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.               |
| `final-fantasy-tactics-finfantacrecomp` [#327](https://github.com/boburning/portcove/issues/327)                                         | legacy-rights-review | no project licence; newest release v0.1.0 (2026-09-03), 10 assets, contents not listed                  | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, v0.1.0 (published 2026-09-03). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.               |
| `mercenaries-playground-of-destruction-kraftmacandchee` [#1672](https://github.com/boburning/portcove/issues/1672)                       | legacy-rights-review | licence MIT; newest release v1.1.1 (2026-10-06), 3 assets, contents not listed                          | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, v1.1.1 (published 2026-10-06). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.               |
| `monster-hunter-generations-ultimate-mhgurecomp` [#2950](https://github.com/boburning/portcove/issues/2950)                              | legacy-rights-review | licence MIT; newest release 0.18.3 (2026-11-22), 5 assets, contents not listed                          | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, 0.18.3 (published 2026-11-22). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.               |
| `mstan-battle-arena-toshinden-recomp` [#826](https://github.com/boburning/portcove/issues/826)                                           | legacy-rights-review | licence PolyForm-Noncommercial-1.0.0; newest release v0.1.4 (2026-10-31), 3 assets, contents not listed | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, v0.1.4 (published 2026-10-31). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.               |
| `nevercookfirst-dimensionsrecomp` [#1817](https://github.com/boburning/portcove/issues/1817)                                             | legacy-rights-review | archived 2026-11-16; newest release v0.2.0 (2026-11-16), 4 assets, contents not listed                  | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, v0.2.0 (published 2026-11-16). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.               |
| `novapowers0-bloody-roar-ii-recomp` [#827](https://github.com/boburning/portcove/issues/827)                                             | legacy-rights-review | licence MIT; newest release v0.7.1 (2026-09-26), 4 assets, contents not listed                          | Conditional clear, recording the notice gap as a warning, unless the owner reads it as a redistribution condition of the bundled framework. Condition: a clean release-content listing of the newest package, v0.7.1 (published 2026-09-26). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.                    |
| `rage-racer-rage-racer-pc` [#349](https://github.com/boburning/portcove/issues/349)                                                      | legacy-rights-review | licence file, no SPDX match; newest release 0.6.15-alpha (2026-11-05), 9 assets, contents not listed    | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, 0.6.15-alpha (published 2026-11-05). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.         |
| `ridgeracertype4recomp-tetrisgm-r4-ridge-racer-type-4` [#3400](https://github.com/boburning/portcove/issues/3400)                        | legacy-rights-review | licence PolyForm-Noncommercial-1.0.0; newest release v0.2.4 (2026-11-19), 5 assets, contents not listed | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, v0.2.4 (published 2026-11-19). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.               |
| `sarpbc-recompiled-snufflyyy-supersonic-acrobatic-rocket-powered-battle-cars` [#3371](https://github.com/boburning/portcove/issues/3371) | legacy-rights-review | no licence file; no releases                                                                            | Conditional clear, owner batch under #1129: there is no release today, so nothing can be offered. Clear only once a first release exists and its package contents are listed clean; keep the explanation as a recorded-note warning, unless the owner finds an explicit prohibition.                                                                                                                                   |
| `sonic-free-riders-recompiled` [#1450](https://github.com/boburning/portcove/issues/1450)                                                | legacy-rights-review | licence GPL-3.0; newest release v0.10.75 (2026-11-22), 12 assets, contents not listed                   | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, v0.10.75 (published 2026-11-22). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.             |
| `toystory2-recompiled-periblugaming-toy-story-2-buzz-lightyear-to-the-rescue` [#3401](https://github.com/boburning/portcove/issues/3401) | legacy-rights-review | licence PolyForm-Noncommercial-1.0.0; newest release v0.6.1 (2026-11-07), 6 assets, contents not listed | Conditional clear, keeping the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition. Condition: a clean release-content listing of the newest package, v0.6.1 (published 2026-11-07). Its contents are not yet listed; docs/CATALOG.md (Bundled game data stays held) keeps a package whose contents are unknown held until they are listed.               |

### Owner-scoped decisions (6)

Takedown (Project Iron 6), owner-acceptance scope (Chameleon Twist),
rights-basis platform scope (OpenPrivateer), the menu-art exception (Thandor),
bundled content after the transition hold (Open Nectar) and an unreadable
legacy rights-review row (MetroidPrimePort).

The Chameleon Twist owner option is the permit for the exact v0.1 ZIP
(`8e705d38…`, `ChameleonTwistJPRecompiled.zip`). The OpenPrivateer owner option
is the Windows-only hold above. Both are in the companion as `owner_option`.

| Identity                                                                                            | Reason                         | Checked today                                                                                   | Recommendation                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chameleon-twist-recompiled` [#125](https://github.com/boburning/portcove/issues/125)               | bundled-game-data              | licence GPL-3.0; only release v0.1 (2024-12-14)                                                 | Keep the whole hold. Owner: decide whether the exact-byte acceptance extends to a listing download permit for the same v0.1 ZIP (owner_option). If it does, also correct the reason code, which the preparation record contradicts.                                                                                                             |
| `odrannnn-metroidprimeport` [#1846](https://github.com/boburning/portcove/issues/1846)              | legacy-rights-review           | repository answers HTTP 404, no block reason                                                    | Keep. It is one of the 17 legacy-rights-review rows; recheck if the repository reappears.                                                                                                                                                                                                                                                       |
| `open-nectar-pikmin`                                                                                | upstream-transition-unreviewed | no licence file; newest tag 1.3 (2026-11-11)                                                    | Keep the managed hold. Owner: decide the bundled-content question independently of the transition hold. Recommended: no separate listing hold once the package contents are listed, because #1129 records recompiled game code without a grant as a note and the README says game data comes from the player's disc; keep the existing warning. |
| `project-iron-6-genrythefox0-tekken-6` [#3130](https://github.com/boburning/portcove/issues/3130)   | package-facts-unresolved       | repository blocked: DMCA, 2026-11-10 (HTTP 451)                                                 | Keep. Owner: the basis is now a takedown, not unresolved package facts. Record the takedown in the explanation and reason in a later data change.                                                                                                                                                                                               |
| `thandor-the-invasion-open-thandor` [#6121](https://github.com/boburning/portcove/issues/6121)      | legacy-rights-review           | licence MIT; newest tag v1.0.8 (2026-11-15)                                                     | Owner: decide whether installer wizard art counts as front-end art under the November 15 launcher/menu-art exception. If it does, clear conditionally on a clean release-content listing of v1.0.8 (tag 2026-11-15), whose installer contents were not inspected; otherwise keep the hold and review v1.0.8 for an asset-clean installer.       |
| `wing-commander-privateer-openprivateer` [#6119](https://github.com/boburning/portcove/issues/6119) | safety-evidence-mismatch       | release_url build answers 404; newest release build_20261120_2250 (2026-11-21); no alert notice | Keep the whole hold. Owner, after the preconditions: decide whether to narrow to a Windows-only hold (owner_option). A platform-only hold names no reviewed version, so reviewed-successor-release would stay unknown for it; the option uses owner-review only.                                                                                |

### Rights holds recommended to stay (63)

The row's basis is bundled game data or derived material, third-party component
terms or an explicit upstream prohibition. Package contents were not inspected
today. Where a tag dated November 2026 exists, the recommendation asks to confirm
that the [release-content scan](../UPSTREAM-OBSERVATIONS.md#release-content-scan)
covered it. A clean scan of the newest package is the factual trigger
(`clean-upstream-package`) for re-proposing a row.

| Identity                                                                                                                           | Reason                      | Checked today                                                                                       | Recommendation                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `abuse-abuse-2025` [#2913](https://github.com/boburning/portcove/issues/2913)                                                      | bundled-game-data           | fork of Xenoveritas/abuse; per-path licence map (GPL-2.0+, WTFPL); newest tag 2025.1.0 (2025-01-17) | Keep.                                                                                  |
| `ambermoon-ambermoon-net` [#2625](https://github.com/boburning/portcove/issues/2625)                                               | bundled-game-data           | licence GPL-3.0; newest tag android-v1.16.0 (2026-11-17)                                            | Keep; recent tag android-v1.16.0: confirm the release-content scan covered it.         |
| `bips-blips` [#6132](https://github.com/boburning/portcove/issues/6132)                                                            | bundled-game-data           | licence MIT; newest tag v4.0 (2026-07-16)                                                           | Keep.                                                                                  |
| `blizz127-xenogears-decomp-port` [#1909](https://github.com/boburning/portcove/issues/1909)                                        | bundled-game-data           | licence MIT; newest tag v0.5.0-r5 (2026-09-30)                                                      | Keep.                                                                                  |
| `brawl-recompiled` [#2434](https://github.com/boburning/portcove/issues/2434)                                                      | bundled-game-data           | no licence file; newest tag v0.5.3 (2026-10-31)                                                     | Keep.                                                                                  |
| `btfighter-super-mario-world-remastered-plus` [#2841](https://github.com/boburning/portcove/issues/2841)                           | bundled-game-data           | licence ISC; newest tag v1.1 (2026-01-16)                                                           | Keep.                                                                                  |
| `buzz-aldrins-race-into-space-native` [#6133](https://github.com/boburning/portcove/issues/6133)                                   | bundled-game-data           | licence GPL-2.0; newest tag v2.0.0 (2025-03-27)                                                     | Keep.                                                                                  |
| `c-dogs-sdl` [#6048](https://github.com/boburning/portcove/issues/6048)                                                            | bundled-game-data           | licence GPL-2.0; newest tag 2.5.0 (2026-10-16)                                                      | Keep.                                                                                  |
| `c7-game-openciv3` [#1850](https://github.com/boburning/portcove/issues/1850)                                                      | third-party-component-terms | licence MIT; newest tag v0.3-dutch-2 (2026-10-30)                                                   | Keep.                                                                                  |
| `call-to-power-ii-apolyton-edition` [#6125](https://github.com/boburning/portcove/issues/6125)                                     | bundled-game-data           | licence file, no SPDX match; newest tag Apolyton-Edition-2025-01-20 (2025-01-20)                    | Keep.                                                                                  |
| `cannonball-dx-outrun` [#1132](https://github.com/boburning/portcove/issues/1132)                                                  | bundled-game-data           | no licence file; newest tag 1.04 (2026-09-26)                                                       | Keep.                                                                                  |
| `captain-claw-pjasicek-openclaw` [#5913](https://github.com/boburning/portcove/issues/5913)                                        | bundled-game-data           | licence GPL-3.0; newest tag v0.3 (2018-06-10)                                                       | Keep.                                                                                  |
| `cave-story-nxengine-evo` [#2647](https://github.com/boburning/portcove/issues/2647)                                               | bundled-game-data           | licence GPL-3.0; newest tag v2.6.5-1 (2021-07-08)                                                   | Keep.                                                                                  |
| `cbfd-recompiled-sciaschi` [#1216](https://github.com/boburning/portcove/issues/1216)                                              | bundled-game-data           | licence MIT; newest tag V0.1.7 (2026-11-18)                                                         | Keep; recent tag V0.1.7: confirm the release-content scan covered it.                  |
| `commander-keen-4-omnispeak` [#2648](https://github.com/boburning/portcove/issues/2648)                                            | bundled-game-data           | licence GPL-2.0; newest tag 1.2preview (2024-12-15)                                                 | Keep.                                                                                  |
| `condemned-2-bloodshot-condemned2recomp` [#361](https://github.com/boburning/portcove/issues/361)                                  | bundled-game-data           | licence BSD-3-Clause; newest tag 0.6.1 (2026-11-16)                                                 | Keep; recent tag 0.6.1: confirm the release-content scan covered it.                   |
| `crazyriddler-finesthourremastered` [#2785](https://github.com/boburning/portcove/issues/2785)                                     | bundled-game-data           | no licence file; newest tag update (2026-11-04)                                                     | Keep; recent tag update: confirm the release-content scan covered it.                  |
| `crownpark-xbox360-native-ports-collection` [#6005](https://github.com/boburning/portcove/issues/6005)                             | bundled-game-data           | no licence file; newest tag daytona-v1 (2026-09-16)                                                 | Keep.                                                                                  |
| `dante-s-inferno-hells-gate-recomp` [#367](https://github.com/boburning/portcove/issues/367)                                       | bundled-game-data           | no licence file; newest tag v0.8.6-beta-hotfix (2026-11-08)                                         | Keep; recent tag v0.8.6-beta-hotfix: confirm the release-content scan covered it.      |
| `dead-rising-2-case-west-recomp` [#1122](https://github.com/boburning/portcove/issues/1122)                                        | bundled-game-data           | licence PolyForm-Noncommercial-1.0.0; newest tag v1.1.2 (2026-10-14)                                | Keep.                                                                                  |
| `dead-rising-2-case-zero-recomp` [#1121](https://github.com/boburning/portcove/issues/1121)                                        | bundled-game-data           | licence PolyForm-Noncommercial-1.0.0; newest tag v1.1.3 (2026-10-14)                                | Keep.                                                                                  |
| `deadly-premonition-dprecomp` [#812](https://github.com/boburning/portcove/issues/812)                                             | bundled-game-data           | licence MIT; newest tag v2.0.14 (2026-10-03)                                                        | Keep.                                                                                  |
| `dirt-dash-namco22` [#1568](https://github.com/boburning/portcove/issues/1568)                                                     | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                                         | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `doom-dsda-doom` [#5665](https://github.com/boburning/portcove/issues/5665)                                                        | third-party-component-terms | no licence file; newest tag v0.30.1 (2026-10-09)                                                    | Keep.                                                                                  |
| `doom-the-eternity-engine` [#5689](https://github.com/boburning/portcove/issues/5689)                                              | bundled-game-data           | licence GPL-3.0; newest tag 4.06.00 (2026-06-13)                                                    | Keep.                                                                                  |
| `dune-ii-henricj-dune-legacy` [#5909](https://github.com/boburning/portcove/issues/5909)                                           | bundled-game-data           | licence GPL-2.0; newest tag latest-windows (2026-05-30)                                             | Keep.                                                                                  |
| `fatal-frame-mikupan` [#346](https://github.com/boburning/portcove/issues/346)                                                     | bundled-game-data           | licence AGPL-3.0; newest tag nightly (2026-11-20)                                                   | Keep; recent tag nightly: confirm the release-content scan covered it.                 |
| `gzh0821-pvzg-site` [#1874](https://github.com/boburning/portcove/issues/1874)                                                     | bundled-game-data           | licence Apache-2.0; newest tag 0.16.31 (2026-11-23)                                                 | Keep; recent tag 0.16.31: confirm the release-content scan covered it.                 |
| `igawa6-dualsouls` [#1829](https://github.com/boburning/portcove/issues/1829)                                                      | bundled-game-data           | licence file, no SPDX match; newest tag 1.0.3 (2026-08-23)                                          | Keep.                                                                                  |
| `jhdev2006-super-mario-world-remastered-public` [#1891](https://github.com/boburning/portcove/issues/1891)                         | bundled-game-data           | licence ISC; newest tag v1.0.1 (2025-03-07)                                                         | Keep.                                                                                  |
| `jiggle-or-physics-3dge7161-dead-or-alive` [#3507](https://github.com/boburning/portcove/issues/3507)                              | bundled-game-data           | no licence file; newest tag 0.1.0 (2026-10-02)                                                      | Keep.                                                                                  |
| `kameo-repowered` [#129](https://github.com/boburning/portcove/issues/129)                                                         | upstream-prohibition        | no licence file; newest tag v0.4.0-beta.1 (2026-11-15)                                              | Keep; recent tag v0.4.0-beta.1: confirm the release-content scan covered it.           |
| `kens-labyrinth-sacredbanana-lab3d-sdl` [#6129](https://github.com/boburning/portcove/issues/6129)                                 | bundled-game-data           | licence file, no SPDX match; newest tag 4.4.0 (2026-09-30)                                          | Keep.                                                                                  |
| `kingdom-hearts-chain-of-memories-gba-rekhcom` [#2586](https://github.com/boburning/portcove/issues/2586)                          | bundled-game-data           | licence CC0-1.0; newest tag v2.9 (2026-11-06)                                                       | Keep; recent tag v2.9: confirm the release-content scan covered it.                    |
| `la-pingvino-the-puzzle-pits` [#6079](https://github.com/boburning/portcove/issues/6079)                                           | bundled-game-data           | licence Apache-2.0; newest tag v0.1.0 (2026-10-25)                                                  | Keep.                                                                                  |
| `lodilorenzo-cybermage-darklight-re-awakening` [#2836](https://github.com/boburning/portcove/issues/2836)                          | bundled-game-data           | licence MIT; newest tag v1.3.0 (2026-10-15)                                                         | Keep.                                                                                  |
| `lostartefacts-trx` [#1898](https://github.com/boburning/portcove/issues/1898)                                                     | bundled-game-data           | licence file, no SPDX match; newest tag latest (2026-11-22)                                         | Keep; recent tag latest: confirm the release-content scan covered it.                  |
| `magic-ball-2-openmb2` [#5434](https://github.com/boburning/portcove/issues/5434)                                                  | bundled-game-data           | licence GPL-2.0; newest tag v1.1 (2026-10-27)                                                       | Keep.                                                                                  |
| `meteo-dream-mf-community-edition` [#2729](https://github.com/boburning/portcove/issues/2729)                                      | bundled-game-data           | licence file, no SPDX match; newest tag v2.2.2 (2026-10-01)                                         | Keep.                                                                                  |
| `oceantrirecomp-krisztsa-monster-hunter-tri` [#3419](https://github.com/boburning/portcove/issues/3419)                            | bundled-game-data           | no licence file; newest tag v1.9.5 (2026-10-23)                                                     | Keep.                                                                                  |
| `omegakatana92-battle-arena-toshinden-gb-recomp` [#1796](https://github.com/boburning/portcove/issues/1796)                        | bundled-game-data           | licence GPL-3.0; newest tag Battle_Arena_Toshiden_G_B (2026-08-25)                                  | Keep.                                                                                  |
| `one-must-fall-2097-omf-remastered` [#5721](https://github.com/boburning/portcove/issues/5721)                                     | bundled-game-data           | licence MIT; newest tag v0.4.3 (2026-11-09)                                                         | Keep; recent tag v0.4.3: confirm the release-content scan covered it.                  |
| `petarov-alleycat-exe` [#2827](https://github.com/boburning/portcove/issues/2827)                                                  | bundled-game-data           | licence Unlicense; newest tag 1.3 (2026-10-16)                                                      | Keep.                                                                                  |
| `petarov-saboteur2` [#2722](https://github.com/boburning/portcove/issues/2722)                                                     | bundled-game-data           | licence Unlicense; newest tag 1.1 (2026-10-18)                                                      | Keep.                                                                                  |
| `pokemon-platinum-pokeplatinum-pc-port-lead` [#373](https://github.com/boburning/portcove/issues/373)                              | bundled-game-data           | no licence file; newest tag v0.2.4 (2026-11-22)                                                     | Keep; recent tag v0.2.4: confirm the release-content scan covered it.                  |
| `pokemon-yellow-recomp` [#174](https://github.com/boburning/portcove/issues/174)                                                   | bundled-game-data           | no licence file; newest tag v0.0.4 (2026-06-26)                                                     | Keep.                                                                                  |
| `prehistorik-2-pre2-port` [#5673](https://github.com/boburning/portcove/issues/5673)                                               | bundled-game-data           | no licence file; newest tag v0.4.0 (2026-07-12)                                                     | Keep.                                                                                  |
| `prop-cycle-namco22` [#1565](https://github.com/boburning/portcove/issues/1565)                                                    | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                                         | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `rages4calm-earthbound-companion` [#2861](https://github.com/boburning/portcove/issues/2861)                                       | third-party-component-terms | licence MIT; newest tag v0.5.0-ports-preview.36 (2026-11-19)                                        | Keep; recent tag v0.5.0-ports-preview.36: confirm the release-content scan covered it. |
| `rave-racer-namco22` [#1566](https://github.com/boburning/portcove/issues/1566)                                                    | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                                         | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `scottjco-wetrix-n64-usa-rev0-recomp` [#4262](https://github.com/boburning/portcove/issues/4262)                                   | bundled-game-data           | licence GPL-3.0; newest tag v0.1.1 (2026-11-03)                                                     | Keep; recent tag v0.1.1: confirm the release-content scan covered it.                  |
| `silent-hill-downpour-downpourrecomp` [#358](https://github.com/boburning/portcove/issues/358)                                     | upstream-prohibition        | licence BSD-3-Clause; newest tag v1.1.8 (2026-09-03)                                                | Keep.                                                                                  |
| `silent-hill-silent-hill-decomp-pc-branch` [#351](https://github.com/boburning/portcove/issues/351)                                | third-party-component-terms | licence GPL-3.0; newest tag uwp-alpha-1 (2026-11-18)                                                | Keep; recent tag uwp-alpha-1: confirm the release-content scan covered it.             |
| `spelunky-classic-hd` [#6056](https://github.com/boburning/portcove/issues/6056)                                                   | bundled-game-data           | licence file, no SPDX match; newest tag 1.2.2 (2025-09-03)                                          | Keep.                                                                                  |
| `star-wars-shadows-of-the-empire-n64-sote-recomp` [#343](https://github.com/boburning/portcove/issues/343)                         | bundled-game-data           | licence MIT; newest tag 0.9.8 (2026-11-12)                                                          | Keep; recent tag 0.9.8: confirm the release-content scan covered it.                   |
| `star-wars-tie-fighter-opentie` [#1975](https://github.com/boburning/portcove/issues/1975)                                         | bundled-game-data           | licence GPL-3.0; newest tag v0.0.7 (2026-10-04)                                                     | Keep.                                                                                  |
| `supaplex-opensupaplex` [#5684](https://github.com/boburning/portcove/issues/5684)                                                 | bundled-game-data           | no licence file; newest tag v7.2.2 (2026-03-31)                                                     | Keep.                                                                                  |
| `time-crisis-namco22` [#1569](https://github.com/boburning/portcove/issues/1569)                                                   | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                                         | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `tokyo-wars-namco22` [#1567](https://github.com/boburning/portcove/issues/1567)                                                    | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                                         | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `tomba-2-recompiled` [#169](https://github.com/boburning/portcove/issues/169)                                                      | bundled-game-data           | licence PolyForm-Noncommercial-1.0.0; newest tag v0.3.3 (2026-10-30)                                | Keep.                                                                                  |
| `unchiga-yu-gi-oh-forbidden-memories-recompiled` [#1910](https://github.com/boburning/portcove/issues/1910)                        | bundled-game-data           | licence MIT; newest tag v0.3.1-preview.2 (2026-11-05)                                               | Keep; recent tag v0.3.1-preview.2: confirm the release-content scan covered it.        |
| `untildawn-pc-supercatelvis-supercatelvis-until-dawn-2015-ps4-original` [#3461](https://github.com/boburning/portcove/issues/3461) | bundled-game-data           | licence GPL-2.0; newest tag v0.4.1 (2026-11-16)                                                     | Keep; recent tag v0.4.1: confirm the release-content scan covered it.                  |
| `vandal-hearts-vandalhearts-pcport` [#347](https://github.com/boburning/portcove/issues/347)                                       | bundled-game-data           | licence GPL-2.0; newest tag v2.1.0 (2026-08-31)                                                     | Keep.                                                                                  |

## (c) Kept for factual reasons

### Unchanged (48)

The named condition still holds. Most are `upstream-owned-route` rows whose
upstream still distributes through its own route. Some of those hold a plain
GitHub release asset that the tier-3 default would let Portcove download.
Changing them is a policy choice, not a factual one, so they stay unchanged here.
This list also includes the no-useful-route rows and four of the five managed
holds. Star Fox Enhanced's licence is corrected: GitHub reports GPL-3.0, detected
from its root `LICENSE-XBRZ.txt`, the xBRZ scaler's licence. That does not change
its hold.

| Identity                                                                                                            | Reason                         | Checked today                                                                    | Recommendation                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `armagetron-advanced` [#6458](https://github.com/boburning/portcove/issues/6458)                                    | upstream-owned-route           | gitlab.com page answered                                                         | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `colobot` [#6526](https://github.com/boburning/portcove/issues/6526)                                                | upstream-owned-route           | licence GPL-3.0; newest tag colobot-gold-0.2.2-alpha (2024-12-23)                | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `conker64-recompiled` [#123](https://github.com/boburning/portcove/issues/123)                                      | no-useful-route                | licence MIT; newest tag v0.1.0-beta (2026-08-27)                                 | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |
| `ddnet` [#6435](https://github.com/boburning/portcove/issues/6435)                                                  | upstream-owned-route           | licence MIT; newest tag 20.2.1 (2026-10-27)                                      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `destinity13-timesplitters-2-ps2-slus20314-native-linux` [#4759](https://github.com/boburning/portcove/issues/4759) | upstream-owned-route           | licence file, no SPDX match; newest tag v1.3.0 (2026-11-20)                      | Keep until the named review completes.                                                                                                                                                 |
| `djultra64-blocksphere`                                                                                             | upstream-transition-unreviewed | licence GPL-3.0; newest tag v1.2.1 (2026-11-12)                                  | Keep. Recheck when 1.2.x is reviewed.                                                                                                                                                  |
| `dungeon-keeper-keeperfx-tux-edition` [#6110](https://github.com/boburning/portcove/issues/6110)                    | upstream-owned-route           | licence GPL-2.0; newest tag v1.4.0.6109 (2026-11-19)                             | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `dungeon-siege-joshspeakman-macos` [#6104](https://github.com/boburning/portcove/issues/6104)                       | upstream-owned-route           | licence MIT; newest tag beta-3 (2026-11-10)                                      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `egg-of-time-chrono-trigger-nds` [#3740](https://github.com/boburning/portcove/issues/3740)                         | upstream-owned-route           | licence MIT; newest tag v1.5.2 (2026-11-19)                                      | Keep until the named review completes.                                                                                                                                                 |
| `empire-earth-gold-apple-silicon` [#6117](https://github.com/boburning/portcove/issues/6117)                        | upstream-owned-route           | licence MIT; newest tag v0.8.2 (2026-10-16)                                      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `extreme-tux-racer` [#6474](https://github.com/boburning/portcove/issues/6474)                                      | upstream-owned-route           | sourceforge.net page answered                                                    | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `f-zero-snes-recomp`                                                                                                | upstream-transition-unreviewed | licence MIT; newest tag v2.2.0-alpha.1 (2026-11-22)                              | Keep. Recheck when a newer package is reviewed.                                                                                                                                        |
| `freeciv` [#6502](https://github.com/boburning/portcove/issues/6502)                                                | upstream-owned-route           | licence GPL-2.0; newest tag R3_2_7 (2026-11-06)                                  | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `freecol` [#6520](https://github.com/boburning/portcove/issues/6520)                                                | upstream-owned-route           | licence GPL-2.0; newest tag latest (2026-11-12)                                  | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `gh3-segovia-no-macos-recomp` [#6106](https://github.com/boburning/portcove/issues/6106)                            | upstream-owned-route           | licence MIT; newest tag v0.1.0 (2026-11-10)                                      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `goldeneye-007-xbla-recomp` [#163](https://github.com/boburning/portcove/issues/163)                                | no-useful-route                | licence Unlicense; newest tag Goldeneye1.2.4 (2026-06-18)                        | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |
| `hedgewars` [#6423](https://github.com/boburning/portcove/issues/6423)                                              | upstream-owned-route           | licence GPL-2.0; newest tag 0.9.23-alpha (2017-07-10)                            | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `kenshi-meitou-client` [#6062](https://github.com/boburning/portcove/issues/6062)                                   | upstream-owned-route           | licence GPL-3.0; newest tag v0.22.2-nightly.20261122.2 (2026-11-22)              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `lords-of-the-realm-ii-open-lords2` [#6085](https://github.com/boburning/portcove/issues/6085)                      | upstream-owned-route           | licence MIT; newest tag v0.1.0-pre.6 (2026-10-12)                                | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `lost-odyssey-recomp` [#744](https://github.com/boburning/portcove/issues/744)                                      | upstream-owned-route           | licence GPL-3.0; newest tag v1.1.0 (2026-10-25)                                  | Keep until the named review completes.                                                                                                                                                 |
| `might-and-magic-ix-macos` [#6109](https://github.com/boburning/portcove/issues/6109)                               | upstream-owned-route           | licence MIT; newest tag v1.3 (2026-10-18)                                        | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `mindustry` [#6506](https://github.com/boburning/portcove/issues/6506)                                              | upstream-owned-route           | licence GPL-3.0; newest tag v160.8 (2026-11-18)                                  | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `naev` [#6817](https://github.com/boburning/portcove/issues/6817)                                                   | upstream-owned-route           | codeberg.org page answered                                                       | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `neverball` [#6400](https://github.com/boburning/portcove/issues/6400)                                              | upstream-owned-route           | licence GPL-2.0; newest tag neverball-1.7.0-alpha.1 (2026-08-14)                 | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `nfl-head-coach-09-nfl-head-coach-09-static-recomp` [#2696](https://github.com/boburning/portcove/issues/2696)      | upstream-owned-route           | licence MIT; newest tag v1.8.0 (2026-11-22)                                      | Keep until the named review completes.                                                                                                                                                 |
| `openarena` [#6385](https://github.com/boburning/portcove/issues/6385)                                              | upstream-owned-route           | sourceforge.net page answered                                                    | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `openclonk` [#6529](https://github.com/boburning/portcove/issues/6529)                                              | upstream-owned-route           | licence ISC; newest tag v8.1 (2018-03-16)                                        | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `opengtps1-gran-turismo-2` [#743](https://github.com/boburning/portcove/issues/743)                                 | no-useful-route                | repository answers HTTP 404, no block reason                                     | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |
| `pod-gold-sp00nznet-recomp` [#6091](https://github.com/boburning/portcove/issues/6091)                              | upstream-owned-route           | licence MIT; newest tag v0.1.0 (2026-11-02)                                      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `populous-the-beginning-openpoptb` [#6100](https://github.com/boburning/portcove/issues/6100)                       | upstream-owned-route           | licence MIT; newest tag v0.2.1 (2026-10-21)                                      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `quake-ii-q2repro` [#6102](https://github.com/boburning/portcove/issues/6102)                                       | upstream-owned-route           | licence GPL-2.0; newest tag nightly (2026-11-18)                                 | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `red-alert-2-and-yuri-s-revenge-red-alert-2-recomp` [#5744](https://github.com/boburning/portcove/issues/5744)      | upstream-owned-route           | licence MIT; newest tag v0.1.4 (2026-11-21)                                      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `redguard-maiko` [#6668](https://github.com/boburning/portcove/issues/6668)                                         | upstream-owned-route           | licence MIT; newest tag v1.1.0 (2026-11-18)                                      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `ring-racers` [#6412](https://github.com/boburning/portcove/issues/6412)                                            | upstream-owned-route           | licence GPL-2.0; newest tag v2.4 (2025-11-02)                                    | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `sauerbraten` [#6417](https://github.com/boburning/portcove/issues/6417)                                            | upstream-owned-route           | sourceforge.net page answered                                                    | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `sonic-robo-blast-2` [#6738](https://github.com/boburning/portcove/issues/6738)                                     | upstream-owned-route           | licence GPL-2.0; newest tag SRB2_release_2.2.15 (2025-01-26)                     | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `star-control-ii-uqm-megamod` [#6061](https://github.com/boburning/portcove/issues/6061)                            | upstream-owned-route           | licence GPL-2.0; newest tag 0.8.5 (2026-06-06)                                   | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `star-fox-enhanced`                                                                                                 | upstream-transition-unreviewed | licence GPL-3.0 (root LICENSE-XBRZ.txt only); newest tag v0.0.8.8.3 (2026-11-01) | Keep. Recheck when a newer package is reviewed (reviewed-successor-release).                                                                                                           |
| `super-metroid-recomp`                                                                                              | known-defective-artifact       | licence PolyForm-Noncommercial-1.0.0; newest tag v0.4.11 (2026-11-21)            | Keep. The newer releases need their own review; they are not covered by this exclusion.                                                                                                |
| `teeworlds` [#6509](https://github.com/boburning/portcove/issues/6509)                                              | upstream-owned-route           | licence Zlib; newest tag 0.7.5 (2020-04-19)                                      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `the-powder-toy` [#6491](https://github.com/boburning/portcove/issues/6491)                                         | upstream-owned-route           | licence GPL-3.0; newest tag snapshot-402 (2026-11-21)                            | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `unvanquished` [#6468](https://github.com/boburning/portcove/issues/6468)                                           | upstream-owned-route           | licence file, no SPDX match; newest tag unvanquished/0.56.2 (2026-05-11)         | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `ur-quan-masters` [#6376](https://github.com/boburning/portcove/issues/6376)                                        | upstream-owned-route           | sourceforge.net page answered                                                    | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `wave-race-64-recompiled` [#168](https://github.com/boburning/portcove/issues/168)                                  | no-useful-route                | licence GPL-3.0; no tags                                                         | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |
| `wesnoth` [#6447](https://github.com/boburning/portcove/issues/6447)                                                | upstream-owned-route           | licence GPL-2.0; newest tag 1.19.30 (2026-11-19)                                 | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `widelands` [#6518](https://github.com/boburning/portcove/issues/6518)                                              | upstream-owned-route           | licence GPL-2.0; newest tag latest (2026-11-21)                                  | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `xonotic` [#6394](https://github.com/boburning/portcove/issues/6394)                                                | upstream-owned-route           | gitlab.com page answered                                                         | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `zelda-link-s-awakening-dx-hd` [#128](https://github.com/boburning/portcove/issues/128)                             | no-useful-route                | no licence file; newest tag v2.0.0 (2026-03-14)                                  | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |

### Content not yet listed (22)

These rows carry reason `package-facts-unresolved`. The gap is factual: the
package contents are not listed. It is not a rights judgement. Each stays held,
and listing the newest package's contents with the release-content scan is the
step that resolves it. The listed contents are then classified under the rights
basis.

| Identity                                                                                                                                      | Reason                   | Checked today                                                        | Recommendation                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `banjo-kazooie-nuts-bolts-renut` [#161](https://github.com/boburning/portcove/issues/161)                                                     | package-facts-unresolved | no licence file; newest tag big-lua-energy (2026-11-12)              | Keep. Resolve by listing the contents of the newest package (newest tag big-lua-energy) with the release-content scan; then classify the listed contents under the rights basis.         |
| `cannonball-outrun` [#120](https://github.com/boburning/portcove/issues/120)                                                                  | package-facts-unresolved | no licence file; newest tag v0.34 (2021-04-26)                       | Keep. Resolve by listing the contents of the newest package (newest tag v0.34) with the release-content scan; then classify the listed contents under the rights basis.                  |
| `digger-remastered` [#6740](https://github.com/boburning/portcove/issues/6740)                                                                | package-facts-unresolved | no licence file; newest tag v0.5 (2026-10-14)                        | Keep. Resolve by listing the contents of the newest package (newest tag v0.5) with the release-content scan; then classify the listed contents under the rights basis.                   |
| `djultra64-clayfighter64` [#2830](https://github.com/boburning/portcove/issues/2830)                                                          | package-facts-unresolved | licence GPL-3.0; newest tag v2.1.1 (2026-10-27)                      | Keep. Resolve by listing the contents of the newest package (newest tag v2.1.1) with the release-content scan; then classify the listed contents under the rights basis.                 |
| `doom-doom-retro` [#5664](https://github.com/boburning/portcove/issues/5664)                                                                  | package-facts-unresolved | licence GPL-3.0; newest tag v6.3 (2026-08-07)                        | Keep. Resolve by listing the contents of the newest package (newest tag v6.3) with the release-content scan; then classify the listed contents under the rights basis.                   |
| `doom-odamex` [#5669](https://github.com/boburning/portcove/issues/5669)                                                                      | package-facts-unresolved | licence GPL-2.0; newest tag 12.3.0 (2026-08-04)                      | Keep. Resolve by listing the contents of the newest package (newest tag 12.3.0) with the release-content scan; then classify the listed contents under the rights basis.                 |
| `espn-nfl-2k5-remade` [#6003](https://github.com/boburning/portcove/issues/6003)                                                              | package-facts-unresolved | no licence file; newest tag v0.7.0-sandbox-preview (2026-10-23)      | Keep. Resolve by listing the contents of the newest package (newest tag v0.7.0-sandbox-preview) with the release-content scan; then classify the listed contents under the rights basis. |
| `go-go-ackman-go-go-ackman-recompiled` [#2881](https://github.com/boburning/portcove/issues/2881)                                             | package-facts-unresolved | licence PolyForm-Noncommercial-1.0.0; newest tag v1.0.1 (2026-11-20) | Keep. Resolve by listing the contents of the newest package (newest tag v1.0.1) with the release-content scan; then classify the listed contents under the rights basis.                 |
| `granturismo2recomp-vulob1-gran-turismo-2-arcade-mode-v1-0` [#3480](https://github.com/boburning/portcove/issues/3480)                        | package-facts-unresolved | no licence file; no tags                                             | Keep. Resolve by listing the contents of the newest package with the release-content scan; then classify the listed contents under the rights basis.                                     |
| `granturismo2simrecomp-vulob1-gran-turismo-2-simulation-mode-v1-0` [#3479](https://github.com/boburning/portcove/issues/3479)                 | package-facts-unresolved | no licence file; no tags                                             | Keep. Resolve by listing the contents of the newest package with the release-content scan; then classify the listed contents under the rights basis.                                     |
| `gta-iii-re3` [#2852](https://github.com/boburning/portcove/issues/2852)                                                                      | package-facts-unresolved | no licence file; newest tag reVC_1.0 (2021-02-14)                    | Keep. Resolve by listing the contents of the newest package (newest tag reVC_1.0) with the release-content scan; then classify the listed contents under the rights basis.               |
| `gta-vice-city-revc` [#2853](https://github.com/boburning/portcove/issues/2853)                                                               | package-facts-unresolved | no licence file; newest tag reVC_1.0 (2021-02-14)                    | Keep. Resolve by listing the contents of the newest package (newest tag reVC_1.0) with the release-content scan; then classify the listed contents under the rights basis.               |
| `guitar-hero-classic-noahbaxter-guitar-hero-ii-plus-classic-harmonix-song-imports` [#3000](https://github.com/boburning/portcove/issues/3000) | package-facts-unresolved | licence file, no SPDX match; newest tag v0.9.1 (2026-11-19)          | Keep. Resolve by listing the contents of the newest package (newest tag v0.9.1) with the release-content scan; then classify the listed contents under the rights basis.                 |
| `lollipop-chainsaw-re-cherry` [#162](https://github.com/boburning/portcove/issues/162)                                                        | package-facts-unresolved | no licence file; newest tag beta (2026-10-18)                        | Keep. Resolve by listing the contents of the newest package (newest tag beta) with the release-content scan; then classify the listed contents under the rights basis.                   |
| `mega-man-x-snes-recomp` [#146](https://github.com/boburning/portcove/issues/146)                                                             | package-facts-unresolved | licence PolyForm-Noncommercial-1.0.0; newest tag v2.4.2 (2026-11-21) | Keep. Resolve by listing the contents of the newest package (newest tag v2.4.2) with the release-content scan; then classify the listed contents under the rights basis.                 |
| `mythologykombat-paumedes-mortal-kombat-mythologies-sub-zero` [#3402](https://github.com/boburning/portcove/issues/3402)                      | package-facts-unresolved | licence PolyForm-Noncommercial-1.0.0; newest tag v0.1.0 (2026-10-21) | Keep. Resolve by listing the contents of the newest package (newest tag v0.1.0) with the release-content scan; then classify the listed contents under the rights basis.                 |
| `r-e-l-i-v-e-oddworld-abe-s-exoddus` [#122](https://github.com/boburning/portcove/issues/122)                                                 | package-facts-unresolved | no licence file; newest tag github-v1.1.0 (2026-10-26)               | Keep. Resolve by listing the contents of the newest package (newest tag github-v1.1.0) with the release-content scan; then classify the listed contents under the rights basis.          |
| `r-e-l-i-v-e-oddworld-abe-s-oddysee` [#133](https://github.com/boburning/portcove/issues/133)                                                 | package-facts-unresolved | no licence file; newest tag github-v1.1.0 (2026-10-26)               | Keep. Resolve by listing the contents of the newest package (newest tag github-v1.1.0) with the release-content scan; then classify the listed contents under the rights basis.          |
| `skate-3-recomp` [#150](https://github.com/boburning/portcove/issues/150)                                                                     | package-facts-unresolved | no licence file; newest tag v2.0.2 (2026-07-24)                      | Keep. Resolve by listing the contents of the newest package (newest tag v2.0.2) with the release-content scan; then classify the listed contents under the rights basis.                 |
| `tobal-2-tobal2recomp` [#6008](https://github.com/boburning/portcove/issues/6008)                                                             | package-facts-unresolved | licence PolyForm-Noncommercial-1.0.0; newest tag v0.3.0 (2026-11-17) | Keep. Resolve by listing the contents of the newest package (newest tag v0.3.0) with the release-content scan; then classify the listed contents under the rights basis.                 |
| `wii-play-tanks-rebirth` [#6004](https://github.com/boburning/portcove/issues/6004)                                                           | package-facts-unresolved | no licence file; newest tag 1.9.2-alpha (2026-11-13)                 | Keep. Resolve by listing the contents of the newest package (newest tag 1.9.2-alpha) with the release-content scan; then classify the listed contents under the rights basis.            |
| `x-men-mutant-academy-2-xmen-mutant-academy-2-pc` [#356](https://github.com/boburning/portcove/issues/356)                                    | package-facts-unresolved | no licence file; newest tag v1.1 (2026-09-08)                        | Keep. Resolve by listing the contents of the newest package (newest tag v1.1) with the release-content scan; then classify the listed contents under the rights basis.                   |

## (d) Unknowns

The upstream of the row below could not be checked. In addition, for every row
release asset lists, provider digests and package contents are unknown, and the
archived state is unknown unless the finding states it. The GitHub REST API
refused third-party reads in this session, and release pages load asset lists
lazily. No package bytes were inspected. Why MetroidPrimePort and OpenGTPS1
answer 404, and why OpenPrivateer's reviewed build and alert notice
disappeared, is unknown. Rechecking these needs an observer report for the
`reviewed-successor-release` and `publisher-checksum` conditions, and the
release-content scan for `clean-upstream-package`.

| Identity                                                                  | Reason               | Checked today               | Recommendation                                  |
| ------------------------------------------------------------------------- | -------------------- | --------------------------- | ----------------------------------------------- |
| `gnu-freedink` [#6536](https://github.com/boburning/portcove/issues/6536) | upstream-owned-route | project page did not answer | Recheck from a host that can reach www.gnu.org. |
