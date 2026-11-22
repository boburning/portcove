# Acquisition restriction evidence, November 22, 2026

This record checks every acquisition restriction on `main` at `e45d8b816d2e`
against upstream facts read on November 22, 2026, and proposes a scoped decision
for each row. It changes no restriction, catalog record, listing or Core code.
The data change is a separate follow-up. The machine-readable companion is
[`acquisition-restriction-evidence-2026-11-22.json`](acquisition-restriction-evidence-2026-11-22.json):
one entry per row with its current typed decisions, the facts checked, their
sources, a classification and a proposed typed row.

Specification: [#8538](https://github.com/boburning/portcove/issues/8538).
Decision authority: the owner decisions and delegation recorded on
[#1422](https://github.com/boburning/portcove/issues/1422#issuecomment-7083861462).
The lead may clear or narrow a hold when the evidence is factual and
unambiguous. Holds that turn on a rights or legal-risk judgement stay with the
owner, who decides them as one batch from this record.

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

- **Repository facts.** For each of the 143 GitHub repositories behind the rows, and Voldorium's, `git ls-remote`
  established whether the repository is publicly readable. A tags-only, tree-less
  fetch gave tag names, tag dates and the date of the last default-branch commit.
  Dates are git dates, so a tag can show the next calendar day in UTC. Three
  repositories are not publicly readable: Git asked for credentials, which is how
  GitHub answers for a missing or private repository.
- **Licence.** The default-branch licence file was read from
  `raw.githubusercontent.com`. The SPDX id is inferred from the licence text.
  `NOASSERTION` means a licence file exists but matched no standard text.
- **Release pages.** One page read each for the rows named in the brief:
  San Andreas Unity, LineWars II, Chameleon Twist, OpenPrivateer, Voldorium and
  the five managed ports.
- **Upstream statements.** Upstream README files were read for the 17
  `legacy-rights-review` rows, the two `upstream-prohibition` rows and Open Nectar.
- **Portcove evidence.** Recorded artifact identities and reviews come from each
  row's tracking issue.
- **Not available.** The GitHub REST API is limited to this repository in this
  session. Archived state, release asset lists and provider digests for
  third-party repositories were therefore not read. They are `unknown` in the
  companion unless a finding states them from a release page or a tracking
  issue. No package was downloaded, so whether a newer release still bundles
  held material is not established for any row. Incomplete evidence is never
  classified as changed.
- **Non-GitHub upstreams.** For the eight rows on codeberg.org, gitlab.com,
  sourceforge.net and gnu.org, only whether the project page answered was
  checked. www.gnu.org did not answer.

## Classification

| Classification      | Rows | Meaning                                                           |
| ------------------- | ---: | ----------------------------------------------------------------- |
| `factual-changed`   |    0 | The condition the hold names demonstrably no longer holds         |
| `scope-too-broad`   |    4 | The evidence supports a narrower platform or artifact scope       |
| `factual-unchanged` |   51 | The named condition still holds, or the upstream is gone          |
| `rights-judgement`  |  101 | Lifting or narrowing turns on rights or legal risk; owner decides |
| `unknown`           |    1 | The upstream could not be reached                                 |

No row is `factual-changed`. Three findings come close but do not qualify:

- OpenPrivateer's reviewed release disappeared and its page no longer shows the
  Windows alert. No cleared Windows package was found, so the row narrows rather
  than clears.
- SARPBC still has no licence. Rage Racer's licence file still selects none.
- The two upstream prohibitions are still stated in the upstream README files.

Policy changes are different from upstream facts. The November 13 and November 15
rights decisions on [#1129](https://github.com/boburning/portcove/issues/1129)
turned several former hold bases into recorded notes. The policy itself lifts no
hold, so those rows are owner items, not lead decisions.

## Rows named in the brief

**San Andreas Unity, LineWars II and Chameleon Twist (asset scope).** Each
explanation names only the old enforcement limit: Portcove could not limit
Download to the reviewed files. A typed listing permit now gives that limit, and
the downloaded bytes decide it. The tracking issues record each reviewed SHA-256
and the rights conclusion:

- [#6134](https://github.com/boburning/portcove/issues/6134): v4.0 desktop ZIPs
  under the menu-art exception.
- [#6090](https://github.com/boburning/portcove/issues/6090): freeware v1.0.0
  archives.
- [#125](https://github.com/boburning/portcove/issues/125): protected exact-byte
  acceptance of the v0.1 ZIP.

Each reviewed release is still the newest today. All three are `scope-too-broad`
and listed in (a), each with a caveat for the lead.

**OpenPrivateer.** The hold's basis is Windows only. The publisher's security
scan names a different Windows executable from the reviewed one. #6119 verified
all six desktop archives against the publisher's SHA256SUMS, launched the Linux
client and found no bundled game data. The evidence supports a Windows-only
download hold (`scope-too-broad`, list (a)).

The release named by `release_url` (`build_20261113_0111`) now returns 404.
Three newer builds exist. That needs a listing correction, separately from the
restriction.

**Voldorium.** No catalog identity or restriction row exists. Issue
[#5603](https://github.com/boburning/portcove/issues/5603) is a Watchlist
candidate. Its 1.1.7 to 1.2.1 release notes describe a Windows Defender Trojan
detection of `Voldorium.exe`. Upstream calls it a false positive: the build is
unsigned and builds a DLL on first start. The Linux 1.2.1 tarball has a published
SHA-256, and the 1.2.2 test builds are Linux only. If Voldorium is cataloged,
the evidence supports a Windows-scoped safety hold and no Linux hold, as for
OpenPrivateer. No restriction is proposed now.

**Open Nectar.** The managed transition hold still applies. The reviewed artifact
is 0.8.5, upstream has since published 1.0.9 to 1.3, and no launcher or settings
review is recorded. The listing download is held today only because the managed
hold is whole.

The listing warning already records the bundled Pikmin 2 runtime, which is
recompiled game code. The README says the launcher extracts game assets from the
player's own disc. Under #1129, recompiled game code without a grant is a recorded
note, not a hold. The owner decision is whether a separate listing hold should
survive lifting the transition hold. The recommendation is no separate hold,
keeping the existing warning.

## Stale policy-hold candidates: 13 and 17

The #8538 specification names 17 rights re-review candidates. The plan names 13.
The plan's list itself was not available to this record. The counts reconcile as
follows; treat the 13-row membership as a reconstruction until it is compared
with the plan.

- **17** are all rows with reason `legacy-rights-review`.
- **13** of them have one stated basis: recompiled, translated or inherited game
  code without a grant, or an unlicensed own layer. Since #1129 these are
  recorded notes. A README check found no explicit prohibition for any of them.
  - `blizz127-parasite-eve-decomp-port`
  - `elmasas-lcs-recomp`
  - `eternal-darkness-sanity-s-requiem-eternal-darkness-recomp`
  - `final-fantasy-tactics-finfantacrecomp`
  - `mercenaries-playground-of-destruction-kraftmacandchee`
  - `monster-hunter-generations-ultimate-mhgurecomp`
  - `mstan-battle-arena-toshinden-recomp`
  - `nevercookfirst-dimensionsrecomp`
  - `rage-racer-rage-racer-pc`
  - `ridgeracertype4recomp-tetrisgm-r4-ridge-racer-type-4`
  - `sarpbc-recompiled-snufflyyy-supersonic-acrobatic-rocket-powered-battle-cars`
  - `sonic-free-riders-recompiled`
  - `toystory2-recompiled-periblugaming-toy-story-2-buzz-lightyear-to-the-rescue`
- **4** rest on another basis:
  - `ace-of-spades-openspades`: no publisher digest. That is not a hold basis
    under tier 3.
  - `thandor-the-invasion-open-thandor`: installer art derived from the game.
    The owner decides whether the menu-art exception applies.
  - `novapowers0-bloody-roar-ii-recomp`: missing notices, a recorded note.
  - `odrannnn-metroidprimeport`: the repository is not publicly readable, so
    the row is left unchanged.

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
writes nothing except an explicit `--output` file. Each hold's conditions are
reported as `satisfied`, `not-satisfied`, `unknown` or `manual`. Holds that
are satisfied or unknown are listed so that each one flags itself.

| Condition                                 | Checked from    | Satisfied when                                                                          |
| ----------------------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `publisher-checksum`                      | Observer report | Every asset of the newest complete observed release has a provider digest               |
| `reviewed-successor-release`              | Observer report | An observed release version is named by none of the port's scoped releases or artifacts |
| `clean-upstream-package`                  | Evidence file   | A content scan of the newest observed release recorded zero findings                    |
| `attributable-grant`                      | Evidence file   | A reviewed grant is recorded with a reference                                           |
| `upstream-route-change`                   | Evidence file   | A reviewed route change is recorded with a reference                                    |
| `owned-input-preparation`, `owner-review` | None            | Always `manual`                                                                         |

With no authored values it reports 162 holds and none with conditions. The
evidence file is `{ "format_version": 1, "subjects": [{ "port_id", "content_scan": [{ "version", "findings" }], "grant": { "recorded", "reference" }, "route_changed": { "changed", "reference" } }] }`.

## (a) Clear or narrow under factual authority

Each proposed decision passes the authoring validator,
`checkAcquisitionRestrictions`, as a listing carrier with a release route.
Older readers keep the legacy whole-listing string, so they remain at least as
restricted.

1. **`wing-commander-privateer-openprivateer`**: narrow to Windows.
   - Evidence: the hold's own text, the #6119 digest and launch evidence, and
     today's releases page (reviewed build gone, no alert notice, no cleared
     Windows build).
   - Proposed row:
     `{"id":"download","effect":"hold","operations":["download"],"scope":{"platforms":["windows-x86-64"]},"reason":"safety-evidence-mismatch","explanation":"The publisher's linked Windows security scan does not match the Windows executable in the current release. Portcove can offer the Windows download after that package is cleared.","reconsider_when":["reviewed-successor-release","owner-review"],"tracking_issue":6119}`
   - Also correct `release_url`.
2. **`grand-theft-auto-san-andreas-unity`**: keep the whole hold and permit the
   two v4.0 desktop ZIPs.
   - Evidence: #6134 records the SHA-256 identities and the menu-art exception.
     Today v4.0 is still the newest release.
   - Proposed permit:
     `{"id":"reviewed-v4-0","effect":"permit","operations":["download"],"scope":{"artifacts":[{"version":"v4.0","sha256":"3cf2f15827d154d172fa259117e0699fc344ab5157a1a134288820361fe27eab"},{"version":"v4.0","sha256":"fb135b7f080517393af0b17d5c1ced9ae44951b31cfdc907eb7ed851df48859a"}]}}`
   - The hold explanation becomes "Portcove offers only the reviewed v4.0
     Windows and Linux packages. Earlier releases and the Android debug package
     need separate checks."
3. **`linewars-ii-sdl3`**: keep the whole hold and permit the two v1.0.0
   archives.
   - Evidence: #6090 records publisher-digest matches and the original author's
     freeware grant. Today v1.0.0 is still the only release.
   - Proposed permit:
     `{"id":"reviewed-v1-0-0","effect":"permit","operations":["download"],"scope":{"artifacts":[{"version":"v1.0.0","sha256":"5bfededd432f529ab84780c07ba1f1a970708a9c7817998a52ef0b5e844b5ef8","asset_name":"LineWars2-SDL3-v1.0.0-win64.zip"},{"version":"v1.0.0","sha256":"8166787cd8a76cfa349ea35b59c3ef8b7d6624dcabe4c67097149bb9c077ac20","asset_name":"LineWars2-SDL3-v1.0.0-linux-x86_64.tar.gz"}]}}`
   - Caveat: #6090 also records that no attributable grant was established for
     the two embedded font ROM images. If the lead does not read them as
     non-game fonts, which are a recorded note under #1129, this row goes to the
     owner.
4. **`chameleon-twist-recompiled`**: keep the whole hold and permit the
   approved v0.1 ZIP.
   - Evidence: #125 protected exact-byte acceptance. Today v0.1 is still the
     only release.
   - Proposed permit:
     `{"id":"approved-v0-1","effect":"permit","operations":["download"],"scope":{"artifacts":[{"version":"v0.1","sha256":"8e705d3826ab413afac92ea753d7f11dbc93be9ea507a3ef86bb6003019b5c56","asset_name":"ChameleonTwistJPRecompiled.zip"}]}}`
   - Caveat: if the lead reads the acceptance as limited to the signed route,
     this row goes to the owner.

## (b) Owner decisions

### Recommended changes (17)

Thirteen rows are the code-basis candidates above. Three are the other
`legacy-rights-review` bases: OpenSpades, Thandor and Bloody Roar II. The
seventeenth is the separate Open Nectar bundled-content decision. A cleared row
keeps its explanation as a recorded-note warning.

| Identity                                                                                                                                 | Reason                         | Checked today                                                        | Recommendation                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ace-of-spades-openspades` [#5755](https://github.com/boburning/portcove/issues/5755)                                                    | legacy-rights-review           | licence GPL-3.0; newest tag v0.1.3 (2019-01-04)                      | Clear: the stated condition is not a hold basis under the tier-3 policy; no upstream fact changed, so this is a policy application for the owner batch.                                                                                                                                        |
| `blizz127-parasite-eve-decomp-port` [#1865](https://github.com/boburning/portcove/issues/1865)                                           | legacy-rights-review           | licence MIT; newest tag native-only-72b2325d (2026-10-08)            | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `elmasas-lcs-recomp` [#1836](https://github.com/boburning/portcove/issues/1836)                                                          | legacy-rights-review           | licence MIT; newest tag v0.1.7 (2026-10-09)                          | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `eternal-darkness-sanity-s-requiem-eternal-darkness-recomp` [#2570](https://github.com/boburning/portcove/issues/2570)                   | legacy-rights-review           | licence GPL-3.0; newest tag v0.9.6 (2026-10-24)                      | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `final-fantasy-tactics-finfantacrecomp` [#327](https://github.com/boburning/portcove/issues/327)                                         | legacy-rights-review           | no licence file; newest tag v0.1.0 (2026-09-03)                      | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `mercenaries-playground-of-destruction-kraftmacandchee` [#1672](https://github.com/boburning/portcove/issues/1672)                       | legacy-rights-review           | licence MIT; newest tag v1.1.1 (2026-10-05)                          | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `monster-hunter-generations-ultimate-mhgurecomp` [#2950](https://github.com/boburning/portcove/issues/2950)                              | legacy-rights-review           | licence MIT; newest tag 0.18.2 (2026-11-22)                          | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `mstan-battle-arena-toshinden-recomp` [#826](https://github.com/boburning/portcove/issues/826)                                           | legacy-rights-review           | licence PolyForm-Noncommercial-1.0.0; newest tag v0.1.4 (2026-10-30) | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `nevercookfirst-dimensionsrecomp` [#1817](https://github.com/boburning/portcove/issues/1817)                                             | legacy-rights-review           | licence MIT; newest tag v0.2.0 (2026-11-16)                          | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `novapowers0-bloody-roar-ii-recomp` [#827](https://github.com/boburning/portcove/issues/827)                                             | legacy-rights-review           | licence MIT; newest tag v0.7.1 (2026-09-26)                          | Clear and record the notice gap as a warning, unless the owner reads the notice gap as a redistribution condition of the bundled framework.                                                                                                                                                    |
| `open-nectar-pikmin`                                                                                                                     | upstream-transition-unreviewed | no licence file; newest tag 1.3 (2026-11-11)                         | Keep the managed hold. Owner: decide the bundled-content question independently of the transition hold. Recommended: no separate listing hold, because #1129 records recompiled game code without a grant as a note and the game data comes from the player's disc; keep the existing warning. |
| `rage-racer-rage-racer-pc` [#349](https://github.com/boburning/portcove/issues/349)                                                      | legacy-rights-review           | licence file, no SPDX match; newest tag 0.6.15-alpha (2026-11-05)    | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `ridgeracertype4recomp-tetrisgm-r4-ridge-racer-type-4` [#3400](https://github.com/boburning/portcove/issues/3400)                        | legacy-rights-review           | licence PolyForm-Noncommercial-1.0.0; newest tag v0.2.4 (2026-11-19) | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `sarpbc-recompiled-snufflyyy-supersonic-acrobatic-rocket-powered-battle-cars` [#3371](https://github.com/boburning/portcove/issues/3371) | legacy-rights-review           | no licence file; no tags                                             | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `sonic-free-riders-recompiled` [#1450](https://github.com/boburning/portcove/issues/1450)                                                | legacy-rights-review           | licence GPL-3.0; newest tag v0.10.75 (2026-11-23)                    | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |
| `thandor-the-invasion-open-thandor` [#6121](https://github.com/boburning/portcove/issues/6121)                                           | legacy-rights-review           | licence MIT; newest tag v1.0.8 (2026-11-15)                          | Owner: decide whether installer wizard art counts as front-end art under the November 15 launcher/menu-art exception (then clear), or keep the hold and review v1.0.8 for an asset-clean installer.                                                                                            |
| `toystory2-recompiled-periblugaming-toy-story-2-buzz-lightyear-to-the-rescue` [#3401](https://github.com/boburning/portcove/issues/3401) | legacy-rights-review           | licence PolyForm-Noncommercial-1.0.0; newest tag v0.6.1 (2026-11-07) | Clear and keep the explanation as a recorded-note warning (owner batch under #1129), unless the owner finds an explicit prohibition.                                                                                                                                                           |

### Rights holds recommended to stay (85)

The row's basis is bundled game data or derived material, third-party component
terms, unresolved package contents or an explicit upstream prohibition. Package
contents were not inspected today. Where a tag dated November 2026 exists, the
recommendation asks to confirm that the
[release-content scan](../UPSTREAM-OBSERVATIONS.md#release-content-scan) covered
it. A clean scan of the newest package is the factual trigger
(`clean-upstream-package`) for re-proposing a row.

| Identity                                                                                                                                      | Reason                      | Checked today                                                                    | Recommendation                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `abuse-abuse-2025` [#2913](https://github.com/boburning/portcove/issues/2913)                                                                 | bundled-game-data           | licence file, no SPDX match; newest tag 2025.1.0 (2025-01-17)                    | Keep.                                                                                  |
| `ambermoon-ambermoon-net` [#2625](https://github.com/boburning/portcove/issues/2625)                                                          | bundled-game-data           | licence GPL-3.0; newest tag android-v1.16.0 (2026-11-17)                         | Keep; recent tag android-v1.16.0: confirm the release-content scan covered it.         |
| `banjo-kazooie-nuts-bolts-renut` [#161](https://github.com/boburning/portcove/issues/161)                                                     | package-facts-unresolved    | no licence file; newest tag big-lua-energy (2026-11-12)                          | Keep; recent tag big-lua-energy: confirm the release-content scan covered it.          |
| `bips-blips` [#6132](https://github.com/boburning/portcove/issues/6132)                                                                       | bundled-game-data           | licence MIT; newest tag v4.0 (2026-07-16)                                        | Keep.                                                                                  |
| `blizz127-xenogears-decomp-port` [#1909](https://github.com/boburning/portcove/issues/1909)                                                   | bundled-game-data           | licence MIT; newest tag v0.5.0-r5 (2026-09-30)                                   | Keep.                                                                                  |
| `brawl-recompiled` [#2434](https://github.com/boburning/portcove/issues/2434)                                                                 | bundled-game-data           | no licence file; newest tag v0.5.3 (2026-10-31)                                  | Keep.                                                                                  |
| `btfighter-super-mario-world-remastered-plus` [#2841](https://github.com/boburning/portcove/issues/2841)                                      | bundled-game-data           | licence ISC; newest tag v1.1 (2026-01-16)                                        | Keep.                                                                                  |
| `buzz-aldrins-race-into-space-native` [#6133](https://github.com/boburning/portcove/issues/6133)                                              | bundled-game-data           | licence GPL-2.0; newest tag v2.0.0 (2025-03-27)                                  | Keep.                                                                                  |
| `c-dogs-sdl` [#6048](https://github.com/boburning/portcove/issues/6048)                                                                       | bundled-game-data           | licence GPL-2.0; newest tag 2.5.0 (2026-10-16)                                   | Keep.                                                                                  |
| `c7-game-openciv3` [#1850](https://github.com/boburning/portcove/issues/1850)                                                                 | third-party-component-terms | licence MIT; newest tag v0.3-dutch-2 (2026-10-30)                                | Keep.                                                                                  |
| `call-to-power-ii-apolyton-edition` [#6125](https://github.com/boburning/portcove/issues/6125)                                                | bundled-game-data           | licence file, no SPDX match; newest tag Apolyton-Edition-2025-01-20 (2025-01-20) | Keep.                                                                                  |
| `cannonball-dx-outrun` [#1132](https://github.com/boburning/portcove/issues/1132)                                                             | bundled-game-data           | no licence file; newest tag 1.04 (2026-09-26)                                    | Keep.                                                                                  |
| `cannonball-outrun` [#120](https://github.com/boburning/portcove/issues/120)                                                                  | package-facts-unresolved    | no licence file; newest tag v0.34 (2021-04-26)                                   | Keep.                                                                                  |
| `captain-claw-pjasicek-openclaw` [#5913](https://github.com/boburning/portcove/issues/5913)                                                   | bundled-game-data           | licence GPL-3.0; newest tag v0.3 (2018-06-10)                                    | Keep.                                                                                  |
| `cave-story-nxengine-evo` [#2647](https://github.com/boburning/portcove/issues/2647)                                                          | bundled-game-data           | licence GPL-3.0; newest tag v2.6.5-1 (2021-07-08)                                | Keep.                                                                                  |
| `cbfd-recompiled-sciaschi` [#1216](https://github.com/boburning/portcove/issues/1216)                                                         | bundled-game-data           | licence MIT; newest tag V0.1.7 (2026-11-18)                                      | Keep; recent tag V0.1.7: confirm the release-content scan covered it.                  |
| `commander-keen-4-omnispeak` [#2648](https://github.com/boburning/portcove/issues/2648)                                                       | bundled-game-data           | licence GPL-2.0; newest tag 1.2preview (2024-12-15)                              | Keep.                                                                                  |
| `condemned-2-bloodshot-condemned2recomp` [#361](https://github.com/boburning/portcove/issues/361)                                             | bundled-game-data           | licence BSD-3-Clause; newest tag 0.6.1 (2026-11-16)                              | Keep; recent tag 0.6.1: confirm the release-content scan covered it.                   |
| `crazyriddler-finesthourremastered` [#2785](https://github.com/boburning/portcove/issues/2785)                                                | bundled-game-data           | no licence file; newest tag update (2026-11-04)                                  | Keep; recent tag update: confirm the release-content scan covered it.                  |
| `crownpark-xbox360-native-ports-collection` [#6005](https://github.com/boburning/portcove/issues/6005)                                        | bundled-game-data           | no licence file; newest tag daytona-v1 (2026-09-16)                              | Keep.                                                                                  |
| `dante-s-inferno-hells-gate-recomp` [#367](https://github.com/boburning/portcove/issues/367)                                                  | bundled-game-data           | no licence file; newest tag v0.8.6-beta-hotfix (2026-11-08)                      | Keep; recent tag v0.8.6-beta-hotfix: confirm the release-content scan covered it.      |
| `dead-rising-2-case-west-recomp` [#1122](https://github.com/boburning/portcove/issues/1122)                                                   | bundled-game-data           | licence PolyForm-Noncommercial-1.0.0; newest tag v1.1.2 (2026-10-14)             | Keep.                                                                                  |
| `dead-rising-2-case-zero-recomp` [#1121](https://github.com/boburning/portcove/issues/1121)                                                   | bundled-game-data           | licence PolyForm-Noncommercial-1.0.0; newest tag v1.1.3 (2026-10-14)             | Keep.                                                                                  |
| `deadly-premonition-dprecomp` [#812](https://github.com/boburning/portcove/issues/812)                                                        | bundled-game-data           | licence MIT; newest tag v2.0.14 (2026-10-03)                                     | Keep.                                                                                  |
| `digger-remastered` [#6740](https://github.com/boburning/portcove/issues/6740)                                                                | package-facts-unresolved    | no licence file; newest tag v0.5 (2026-10-14)                                    | Keep.                                                                                  |
| `dirt-dash-namco22` [#1568](https://github.com/boburning/portcove/issues/1568)                                                                | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                      | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `djultra64-clayfighter64` [#2830](https://github.com/boburning/portcove/issues/2830)                                                          | package-facts-unresolved    | licence GPL-3.0; newest tag v2.1.1 (2026-10-27)                                  | Keep.                                                                                  |
| `doom-doom-retro` [#5664](https://github.com/boburning/portcove/issues/5664)                                                                  | package-facts-unresolved    | licence GPL-3.0; newest tag v6.3 (2026-08-07)                                    | Keep.                                                                                  |
| `doom-dsda-doom` [#5665](https://github.com/boburning/portcove/issues/5665)                                                                   | third-party-component-terms | no licence file; newest tag v0.30.1 (2026-10-09)                                 | Keep.                                                                                  |
| `doom-odamex` [#5669](https://github.com/boburning/portcove/issues/5669)                                                                      | package-facts-unresolved    | licence GPL-2.0; newest tag 12.3.0 (2026-08-04)                                  | Keep.                                                                                  |
| `doom-the-eternity-engine` [#5689](https://github.com/boburning/portcove/issues/5689)                                                         | bundled-game-data           | licence GPL-3.0; newest tag 4.06.00 (2026-06-13)                                 | Keep.                                                                                  |
| `dune-ii-henricj-dune-legacy` [#5909](https://github.com/boburning/portcove/issues/5909)                                                      | bundled-game-data           | licence GPL-2.0; newest tag latest-windows (2026-05-30)                          | Keep.                                                                                  |
| `espn-nfl-2k5-remade` [#6003](https://github.com/boburning/portcove/issues/6003)                                                              | package-facts-unresolved    | no licence file; newest tag v0.7.0-sandbox-preview (2026-10-23)                  | Keep.                                                                                  |
| `fatal-frame-mikupan` [#346](https://github.com/boburning/portcove/issues/346)                                                                | bundled-game-data           | licence AGPL-3.0; newest tag nightly (2026-11-20)                                | Keep; recent tag nightly: confirm the release-content scan covered it.                 |
| `go-go-ackman-go-go-ackman-recompiled` [#2881](https://github.com/boburning/portcove/issues/2881)                                             | package-facts-unresolved    | licence PolyForm-Noncommercial-1.0.0; newest tag v1.0.1 (2026-11-20)             | Keep; recent tag v1.0.1: confirm the release-content scan covered it.                  |
| `granturismo2recomp-vulob1-gran-turismo-2-arcade-mode-v1-0` [#3480](https://github.com/boburning/portcove/issues/3480)                        | package-facts-unresolved    | no licence file; no tags                                                         | Keep.                                                                                  |
| `granturismo2simrecomp-vulob1-gran-turismo-2-simulation-mode-v1-0` [#3479](https://github.com/boburning/portcove/issues/3479)                 | package-facts-unresolved    | no licence file; no tags                                                         | Keep.                                                                                  |
| `gta-iii-re3` [#2852](https://github.com/boburning/portcove/issues/2852)                                                                      | package-facts-unresolved    | no licence file; newest tag reVC_1.0 (2021-02-14)                                | Keep.                                                                                  |
| `gta-vice-city-revc` [#2853](https://github.com/boburning/portcove/issues/2853)                                                               | package-facts-unresolved    | no licence file; newest tag reVC_1.0 (2021-02-14)                                | Keep.                                                                                  |
| `guitar-hero-classic-noahbaxter-guitar-hero-ii-plus-classic-harmonix-song-imports` [#3000](https://github.com/boburning/portcove/issues/3000) | package-facts-unresolved    | licence file, no SPDX match; newest tag v0.9.1 (2026-11-19)                      | Keep; recent tag v0.9.1: confirm the release-content scan covered it.                  |
| `gzh0821-pvzg-site` [#1874](https://github.com/boburning/portcove/issues/1874)                                                                | bundled-game-data           | licence Apache-2.0; newest tag 0.16.31 (2026-11-23)                              | Keep; recent tag 0.16.31: confirm the release-content scan covered it.                 |
| `igawa6-dualsouls` [#1829](https://github.com/boburning/portcove/issues/1829)                                                                 | bundled-game-data           | licence file, no SPDX match; newest tag 1.0.3 (2026-08-23)                       | Keep.                                                                                  |
| `jhdev2006-super-mario-world-remastered-public` [#1891](https://github.com/boburning/portcove/issues/1891)                                    | bundled-game-data           | licence ISC; newest tag v1.0.1 (2025-03-07)                                      | Keep.                                                                                  |
| `jiggle-or-physics-3dge7161-dead-or-alive` [#3507](https://github.com/boburning/portcove/issues/3507)                                         | bundled-game-data           | no licence file; newest tag 0.1.0 (2026-10-02)                                   | Keep.                                                                                  |
| `kameo-repowered` [#129](https://github.com/boburning/portcove/issues/129)                                                                    | upstream-prohibition        | no licence file; newest tag v0.4.0-beta.1 (2026-11-15)                           | Keep; recent tag v0.4.0-beta.1: confirm the release-content scan covered it.           |
| `kens-labyrinth-sacredbanana-lab3d-sdl` [#6129](https://github.com/boburning/portcove/issues/6129)                                            | bundled-game-data           | licence file, no SPDX match; newest tag 4.4.0 (2026-09-30)                       | Keep.                                                                                  |
| `kingdom-hearts-chain-of-memories-gba-rekhcom` [#2586](https://github.com/boburning/portcove/issues/2586)                                     | bundled-game-data           | licence CC0-1.0; newest tag v2.9 (2026-11-06)                                    | Keep; recent tag v2.9: confirm the release-content scan covered it.                    |
| `la-pingvino-the-puzzle-pits` [#6079](https://github.com/boburning/portcove/issues/6079)                                                      | bundled-game-data           | licence Apache-2.0; newest tag v0.1.0 (2026-10-25)                               | Keep.                                                                                  |
| `lodilorenzo-cybermage-darklight-re-awakening` [#2836](https://github.com/boburning/portcove/issues/2836)                                     | bundled-game-data           | licence MIT; newest tag v1.3.0 (2026-10-15)                                      | Keep.                                                                                  |
| `lollipop-chainsaw-re-cherry` [#162](https://github.com/boburning/portcove/issues/162)                                                        | package-facts-unresolved    | no licence file; newest tag beta (2026-10-18)                                    | Keep.                                                                                  |
| `lostartefacts-trx` [#1898](https://github.com/boburning/portcove/issues/1898)                                                                | bundled-game-data           | licence file, no SPDX match; newest tag latest (2026-11-22)                      | Keep; recent tag latest: confirm the release-content scan covered it.                  |
| `magic-ball-2-openmb2` [#5434](https://github.com/boburning/portcove/issues/5434)                                                             | bundled-game-data           | licence GPL-2.0; newest tag v1.1 (2026-10-27)                                    | Keep.                                                                                  |
| `mega-man-x-snes-recomp` [#146](https://github.com/boburning/portcove/issues/146)                                                             | package-facts-unresolved    | licence PolyForm-Noncommercial-1.0.0; newest tag v2.4.2 (2026-11-21)             | Keep; recent tag v2.4.2: confirm the release-content scan covered it.                  |
| `meteo-dream-mf-community-edition` [#2729](https://github.com/boburning/portcove/issues/2729)                                                 | bundled-game-data           | licence file, no SPDX match; newest tag v2.2.2 (2026-10-01)                      | Keep.                                                                                  |
| `mythologykombat-paumedes-mortal-kombat-mythologies-sub-zero` [#3402](https://github.com/boburning/portcove/issues/3402)                      | package-facts-unresolved    | licence PolyForm-Noncommercial-1.0.0; newest tag v0.1.0 (2026-10-21)             | Keep.                                                                                  |
| `oceantrirecomp-krisztsa-monster-hunter-tri` [#3419](https://github.com/boburning/portcove/issues/3419)                                       | bundled-game-data           | no licence file; newest tag v1.9.5 (2026-10-23)                                  | Keep.                                                                                  |
| `omegakatana92-battle-arena-toshinden-gb-recomp` [#1796](https://github.com/boburning/portcove/issues/1796)                                   | bundled-game-data           | licence GPL-3.0; newest tag Battle_Arena_Toshiden_G_B (2026-08-25)               | Keep.                                                                                  |
| `one-must-fall-2097-omf-remastered` [#5721](https://github.com/boburning/portcove/issues/5721)                                                | bundled-game-data           | licence MIT; newest tag v0.4.3 (2026-11-09)                                      | Keep; recent tag v0.4.3: confirm the release-content scan covered it.                  |
| `petarov-alleycat-exe` [#2827](https://github.com/boburning/portcove/issues/2827)                                                             | bundled-game-data           | licence Unlicense; newest tag 1.3 (2026-10-16)                                   | Keep.                                                                                  |
| `petarov-saboteur2` [#2722](https://github.com/boburning/portcove/issues/2722)                                                                | bundled-game-data           | licence Unlicense; newest tag 1.1 (2026-10-18)                                   | Keep.                                                                                  |
| `pokemon-platinum-pokeplatinum-pc-port-lead` [#373](https://github.com/boburning/portcove/issues/373)                                         | bundled-game-data           | no licence file; newest tag v0.2.4 (2026-11-22)                                  | Keep; recent tag v0.2.4: confirm the release-content scan covered it.                  |
| `pokemon-yellow-recomp` [#174](https://github.com/boburning/portcove/issues/174)                                                              | bundled-game-data           | no licence file; newest tag v0.0.4 (2026-06-26)                                  | Keep.                                                                                  |
| `prehistorik-2-pre2-port` [#5673](https://github.com/boburning/portcove/issues/5673)                                                          | bundled-game-data           | no licence file; newest tag v0.4.0 (2026-07-12)                                  | Keep.                                                                                  |
| `prop-cycle-namco22` [#1565](https://github.com/boburning/portcove/issues/1565)                                                               | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                      | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `r-e-l-i-v-e-oddworld-abe-s-exoddus` [#122](https://github.com/boburning/portcove/issues/122)                                                 | package-facts-unresolved    | no licence file; newest tag github-v1.1.0 (2026-10-26)                           | Keep.                                                                                  |
| `r-e-l-i-v-e-oddworld-abe-s-oddysee` [#133](https://github.com/boburning/portcove/issues/133)                                                 | package-facts-unresolved    | no licence file; newest tag github-v1.1.0 (2026-10-26)                           | Keep.                                                                                  |
| `rages4calm-earthbound-companion` [#2861](https://github.com/boburning/portcove/issues/2861)                                                  | third-party-component-terms | licence MIT; newest tag v0.5.0-ports-preview.36 (2026-11-19)                     | Keep; recent tag v0.5.0-ports-preview.36: confirm the release-content scan covered it. |
| `rave-racer-namco22` [#1566](https://github.com/boburning/portcove/issues/1566)                                                               | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                      | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `scottjco-wetrix-n64-usa-rev0-recomp` [#4262](https://github.com/boburning/portcove/issues/4262)                                              | bundled-game-data           | licence GPL-3.0; newest tag v0.1.1 (2026-11-03)                                  | Keep; recent tag v0.1.1: confirm the release-content scan covered it.                  |
| `silent-hill-downpour-downpourrecomp` [#358](https://github.com/boburning/portcove/issues/358)                                                | upstream-prohibition        | licence BSD-3-Clause; newest tag v1.1.8 (2026-09-03)                             | Keep.                                                                                  |
| `silent-hill-silent-hill-decomp-pc-branch` [#351](https://github.com/boburning/portcove/issues/351)                                           | third-party-component-terms | licence GPL-3.0; newest tag uwp-alpha-1 (2026-11-18)                             | Keep; recent tag uwp-alpha-1: confirm the release-content scan covered it.             |
| `skate-3-recomp` [#150](https://github.com/boburning/portcove/issues/150)                                                                     | package-facts-unresolved    | no licence file; newest tag v2.0.2 (2026-07-24)                                  | Keep.                                                                                  |
| `spelunky-classic-hd` [#6056](https://github.com/boburning/portcove/issues/6056)                                                              | bundled-game-data           | licence file, no SPDX match; newest tag 1.2.2 (2025-09-03)                       | Keep.                                                                                  |
| `star-wars-shadows-of-the-empire-n64-sote-recomp` [#343](https://github.com/boburning/portcove/issues/343)                                    | bundled-game-data           | licence MIT; newest tag 0.9.8 (2026-11-12)                                       | Keep; recent tag 0.9.8: confirm the release-content scan covered it.                   |
| `star-wars-tie-fighter-opentie` [#1975](https://github.com/boburning/portcove/issues/1975)                                                    | bundled-game-data           | licence GPL-3.0; newest tag v0.0.7 (2026-10-04)                                  | Keep.                                                                                  |
| `supaplex-opensupaplex` [#5684](https://github.com/boburning/portcove/issues/5684)                                                            | bundled-game-data           | no licence file; newest tag v7.2.2 (2026-03-31)                                  | Keep.                                                                                  |
| `time-crisis-namco22` [#1569](https://github.com/boburning/portcove/issues/1569)                                                              | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                      | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `tobal-2-tobal2recomp` [#6008](https://github.com/boburning/portcove/issues/6008)                                                             | package-facts-unresolved    | licence PolyForm-Noncommercial-1.0.0; newest tag v0.3.0 (2026-11-17)             | Keep; recent tag v0.3.0: confirm the release-content scan covered it.                  |
| `tokyo-wars-namco22` [#1567](https://github.com/boburning/portcove/issues/1567)                                                               | bundled-game-data           | licence MIT; newest tag 0.10.3 (2026-11-08)                                      | Keep; recent tag 0.10.3: confirm the release-content scan covered it.                  |
| `tomba-2-recompiled` [#169](https://github.com/boburning/portcove/issues/169)                                                                 | bundled-game-data           | licence PolyForm-Noncommercial-1.0.0; newest tag v0.3.3 (2026-10-30)             | Keep.                                                                                  |
| `unchiga-yu-gi-oh-forbidden-memories-recompiled` [#1910](https://github.com/boburning/portcove/issues/1910)                                   | bundled-game-data           | licence MIT; newest tag v0.3.1-preview.2 (2026-11-05)                            | Keep; recent tag v0.3.1-preview.2: confirm the release-content scan covered it.        |
| `untildawn-pc-supercatelvis-supercatelvis-until-dawn-2015-ps4-original` [#3461](https://github.com/boburning/portcove/issues/3461)            | bundled-game-data           | licence GPL-2.0; newest tag v0.4.1 (2026-11-16)                                  | Keep; recent tag v0.4.1: confirm the release-content scan covered it.                  |
| `vandal-hearts-vandalhearts-pcport` [#347](https://github.com/boburning/portcove/issues/347)                                                  | bundled-game-data           | licence GPL-2.0; newest tag v2.1.0 (2026-08-31)                                  | Keep.                                                                                  |
| `wii-play-tanks-rebirth` [#6004](https://github.com/boburning/portcove/issues/6004)                                                           | package-facts-unresolved    | no licence file; newest tag 1.9.2-alpha (2026-11-13)                             | Keep; recent tag 1.9.2-alpha: confirm the release-content scan covered it.             |
| `x-men-mutant-academy-2-xmen-mutant-academy-2-pc` [#356](https://github.com/boburning/portcove/issues/356)                                    | package-facts-unresolved    | no licence file; newest tag v1.1 (2026-09-08)                                    | Keep.                                                                                  |

## (c) Unchanged (50)

The named condition still holds. Most are `upstream-owned-route` rows whose
upstream still distributes through its own route. Some of those hold a plain
GitHub release asset that the tier-3 default would let Portcove download.
Changing them is a policy choice, not a factual one, so they stay unchanged here.
This list also includes the no-useful-route rows, unreadable repositories and
four of the five managed holds.

| Identity                                                                                                            | Reason                         | Checked today                                                            | Recommendation                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `armagetron-advanced` [#6458](https://github.com/boburning/portcove/issues/6458)                                    | upstream-owned-route           | gitlab.com page answered                                                 | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `colobot` [#6526](https://github.com/boburning/portcove/issues/6526)                                                | upstream-owned-route           | licence GPL-3.0; newest tag colobot-gold-0.2.2-alpha (2024-12-23)        | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `conker64-recompiled` [#123](https://github.com/boburning/portcove/issues/123)                                      | no-useful-route                | licence MIT; newest tag v0.1.0-beta (2026-08-27)                         | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |
| `ddnet` [#6435](https://github.com/boburning/portcove/issues/6435)                                                  | upstream-owned-route           | licence MIT; newest tag 20.2.1 (2026-10-27)                              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `destinity13-timesplitters-2-ps2-slus20314-native-linux` [#4759](https://github.com/boburning/portcove/issues/4759) | upstream-owned-route           | licence file, no SPDX match; newest tag v1.3.0 (2026-11-20)              | Keep until the named review completes.                                                                                                                                                 |
| `djultra64-blocksphere`                                                                                             | upstream-transition-unreviewed | licence GPL-3.0; newest tag v1.2.1 (2026-11-12)                          | Keep. Recheck when 1.2.x is reviewed.                                                                                                                                                  |
| `dungeon-keeper-keeperfx-tux-edition` [#6110](https://github.com/boburning/portcove/issues/6110)                    | upstream-owned-route           | licence GPL-2.0; newest tag v1.4.0.6109 (2026-11-19)                     | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `dungeon-siege-joshspeakman-macos` [#6104](https://github.com/boburning/portcove/issues/6104)                       | upstream-owned-route           | licence MIT; newest tag beta-3 (2026-11-10)                              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `egg-of-time-chrono-trigger-nds` [#3740](https://github.com/boburning/portcove/issues/3740)                         | upstream-owned-route           | licence MIT; newest tag v1.5.2 (2026-11-19)                              | Keep until the named review completes.                                                                                                                                                 |
| `empire-earth-gold-apple-silicon` [#6117](https://github.com/boburning/portcove/issues/6117)                        | upstream-owned-route           | licence MIT; newest tag v0.8.2 (2026-10-16)                              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `extreme-tux-racer` [#6474](https://github.com/boburning/portcove/issues/6474)                                      | upstream-owned-route           | sourceforge.net page answered                                            | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `f-zero-snes-recomp`                                                                                                | upstream-transition-unreviewed | licence MIT; newest tag v2.2.0-alpha.1 (2026-11-22)                      | Keep. Recheck when a newer package is reviewed.                                                                                                                                        |
| `freeciv` [#6502](https://github.com/boburning/portcove/issues/6502)                                                | upstream-owned-route           | licence GPL-2.0; newest tag R3_2_7 (2026-11-06)                          | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `freecol` [#6520](https://github.com/boburning/portcove/issues/6520)                                                | upstream-owned-route           | licence GPL-2.0; newest tag latest (2026-11-12)                          | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `gh3-segovia-no-macos-recomp` [#6106](https://github.com/boburning/portcove/issues/6106)                            | upstream-owned-route           | licence MIT; newest tag v0.1.0 (2026-11-10)                              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `goldeneye-007-xbla-recomp` [#163](https://github.com/boburning/portcove/issues/163)                                | no-useful-route                | licence Unlicense; newest tag Goldeneye1.2.4 (2026-06-18)                | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |
| `hedgewars` [#6423](https://github.com/boburning/portcove/issues/6423)                                              | upstream-owned-route           | licence GPL-2.0; newest tag 0.9.23-alpha (2017-07-10)                    | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `kenshi-meitou-client` [#6062](https://github.com/boburning/portcove/issues/6062)                                   | upstream-owned-route           | licence GPL-3.0; newest tag v0.22.2-nightly.20261122.2 (2026-11-22)      | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `lords-of-the-realm-ii-open-lords2` [#6085](https://github.com/boburning/portcove/issues/6085)                      | upstream-owned-route           | licence MIT; newest tag v0.1.0-pre.6 (2026-10-12)                        | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `lost-odyssey-recomp` [#744](https://github.com/boburning/portcove/issues/744)                                      | upstream-owned-route           | licence GPL-3.0; newest tag v1.1.0 (2026-10-25)                          | Keep until the named review completes.                                                                                                                                                 |
| `might-and-magic-ix-macos` [#6109](https://github.com/boburning/portcove/issues/6109)                               | upstream-owned-route           | licence MIT; newest tag v1.3 (2026-10-18)                                | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `mindustry` [#6506](https://github.com/boburning/portcove/issues/6506)                                              | upstream-owned-route           | licence GPL-3.0; newest tag v160.8 (2026-11-18)                          | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `naev` [#6817](https://github.com/boburning/portcove/issues/6817)                                                   | upstream-owned-route           | codeberg.org page answered                                               | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `neverball` [#6400](https://github.com/boburning/portcove/issues/6400)                                              | upstream-owned-route           | licence GPL-2.0; newest tag neverball-1.7.0-alpha.1 (2026-08-14)         | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `nfl-head-coach-09-nfl-head-coach-09-static-recomp` [#2696](https://github.com/boburning/portcove/issues/2696)      | upstream-owned-route           | licence MIT; newest tag v1.8.0 (2026-11-22)                              | Keep until the named review completes.                                                                                                                                                 |
| `odrannnn-metroidprimeport` [#1846](https://github.com/boburning/portcove/issues/1846)                              | legacy-rights-review           | repository not publicly readable                                         | Keep. Recheck if the repository reappears.                                                                                                                                             |
| `openarena` [#6385](https://github.com/boburning/portcove/issues/6385)                                              | upstream-owned-route           | sourceforge.net page answered                                            | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `openclonk` [#6529](https://github.com/boburning/portcove/issues/6529)                                              | upstream-owned-route           | licence ISC; newest tag v8.1 (2018-03-16)                                | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `opengtps1-gran-turismo-2` [#743](https://github.com/boburning/portcove/issues/743)                                 | no-useful-route                | repository not publicly readable                                         | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |
| `pod-gold-sp00nznet-recomp` [#6091](https://github.com/boburning/portcove/issues/6091)                              | upstream-owned-route           | licence MIT; newest tag v0.1.0 (2026-11-02)                              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `populous-the-beginning-openpoptb` [#6100](https://github.com/boburning/portcove/issues/6100)                       | upstream-owned-route           | licence MIT; newest tag v0.2.1 (2026-10-21)                              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `project-iron-6-genrythefox0-tekken-6` [#3130](https://github.com/boburning/portcove/issues/3130)                   | package-facts-unresolved       | repository not publicly readable                                         | Keep.                                                                                                                                                                                  |
| `quake-ii-q2repro` [#6102](https://github.com/boburning/portcove/issues/6102)                                       | upstream-owned-route           | licence GPL-2.0; newest tag nightly (2026-11-18)                         | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `red-alert-2-and-yuri-s-revenge-red-alert-2-recomp` [#5744](https://github.com/boburning/portcove/issues/5744)      | upstream-owned-route           | licence MIT; newest tag v0.1.4 (2026-11-21)                              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `redguard-maiko` [#6668](https://github.com/boburning/portcove/issues/6668)                                         | upstream-owned-route           | licence MIT; newest tag v1.1.0 (2026-11-18)                              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `ring-racers` [#6412](https://github.com/boburning/portcove/issues/6412)                                            | upstream-owned-route           | licence GPL-2.0; newest tag v2.4 (2025-11-02)                            | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `sauerbraten` [#6417](https://github.com/boburning/portcove/issues/6417)                                            | upstream-owned-route           | sourceforge.net page answered                                            | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `sonic-robo-blast-2` [#6738](https://github.com/boburning/portcove/issues/6738)                                     | upstream-owned-route           | licence GPL-2.0; newest tag SRB2_release_2.2.15 (2025-01-26)             | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `star-control-ii-uqm-megamod` [#6061](https://github.com/boburning/portcove/issues/6061)                            | upstream-owned-route           | licence GPL-2.0; newest tag 0.8.5 (2026-06-06)                           | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `star-fox-enhanced`                                                                                                 | upstream-transition-unreviewed | no licence file; newest tag v0.0.8.8.3 (2026-11-01)                      | Keep. Recheck when a newer package is reviewed (reviewed-successor-release).                                                                                                           |
| `super-metroid-recomp`                                                                                              | known-defective-artifact       | licence PolyForm-Noncommercial-1.0.0; newest tag v0.4.11 (2026-11-21)    | Keep. The newer releases need their own review; they are not covered by this exclusion.                                                                                                |
| `teeworlds` [#6509](https://github.com/boburning/portcove/issues/6509)                                              | upstream-owned-route           | licence Zlib; newest tag 0.7.5 (2020-04-19)                              | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `the-powder-toy` [#6491](https://github.com/boburning/portcove/issues/6491)                                         | upstream-owned-route           | licence GPL-3.0; newest tag snapshot-402 (2026-11-21)                    | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `unvanquished` [#6468](https://github.com/boburning/portcove/issues/6468)                                           | upstream-owned-route           | licence file, no SPDX match; newest tag unvanquished/0.56.2 (2026-05-11) | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `ur-quan-masters` [#6376](https://github.com/boburning/portcove/issues/6376)                                        | upstream-owned-route           | sourceforge.net page answered                                            | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `wave-race-64-recompiled` [#168](https://github.com/boburning/portcove/issues/168)                                  | no-useful-route                | licence GPL-3.0; no tags                                                 | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |
| `wesnoth` [#6447](https://github.com/boburning/portcove/issues/6447)                                                | upstream-owned-route           | licence GPL-2.0; newest tag 1.19.30 (2026-11-19)                         | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `widelands` [#6518](https://github.com/boburning/portcove/issues/6518)                                              | upstream-owned-route           | licence GPL-2.0; newest tag latest (2026-11-21)                          | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `xonotic` [#6394](https://github.com/boburning/portcove/issues/6394)                                                | upstream-owned-route           | gitlab.com page answered                                                 | Keep. Note for the owner batch: where the package is a plain GitHub release asset, the tier-3 default would allow a listing download; no fact changed, so this is not a lead decision. |
| `zelda-link-s-awakening-dx-hd` [#128](https://github.com/boburning/portcove/issues/128)                             | no-useful-route                | no licence file; newest tag v2.0.0 (2026-03-14)                          | Keep. Recheck when upstream publishes a useful runtime.                                                                                                                                |

## (d) Unknowns

The upstream of the row below could not be checked. In addition, for every row
the archived state, release asset lists and provider digests are unknown unless
the finding states them. Only the GitHub REST API exposes them, and it was not
available for third-party repositories in this session. No package bytes were
inspected. Rechecking these needs an observer report for the
`reviewed-successor-release` and `publisher-checksum` conditions, and the
release-content scan for `clean-upstream-package`.

| Identity                                                                  | Reason               | Checked today               | Recommendation                                  |
| ------------------------------------------------------------------------- | -------------------- | --------------------------- | ----------------------------------------------- |
| `gnu-freedink` [#6536](https://github.com/boburning/portcove/issues/6536) | upstream-owned-route | project page did not answer | Recheck from a host that can reach www.gnu.org. |
