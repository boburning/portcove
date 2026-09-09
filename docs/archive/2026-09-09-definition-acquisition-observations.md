# Definition acquisition observations — 2026-09-09

Immutable read-only evidence for #245. This is not a live support list, qualification, admission or a new integrity authority.

Observed at 09/09/2026 11:29:34 against source commit `7e595bffee2574ce70f5a9bb6e7b33b5bcda4b3f`.

The embedded catalog has 67 entries across seven existing adapters: 65 GitHub-backed entries, one GitLab entry and one direct-manifest entry. Deduplicating GitHub repository/rolling-tag selectors produced 61 requests. Explicit rolling tags were requested directly; other repositories were observed through the first non-draft release on the first API page (up to 100 releases). This is a bounded digest-availability sample, not complete release history or platform-specific release resolution.

59 selectors returned a published release, one had no published release, and reblue nightly returned HTTP 404 again on an independent retry. The observed releases expose 271 assets: 268 have syntactically valid SHA-256 API digests and three Starship assets have no API digest. No artifact was downloaded or executed, no checksum sidecar was qualified, and a missing API digest is not proof that no other authenticated checksum source exists. GitLab and direct-manifest acquisition were not live-queried here; OpenPete retains its existing catalog pin and provenance.

## GitHub observations

| Repository/release | Release ID / tag | Assets | Missing API digest |
| --- | --- | --- | --- |
| [999sian/tmc](https://github.com/999sian/tmc/releases/tag/v0.8.3) | 356290655 / v0.8.3 | 7 | 0 |
| [Alexbeav/mortal-kombat-4-recomp](https://github.com/Alexbeav/mortal-kombat-4-recomp/releases/tag/v0.3.5) | 379710618 / v0.3.5 | 6 | 0 |
| [alondero/aerogauge-recomp](https://github.com/alondero/aerogauge-recomp/releases/tag/v0.1.0) | 379842145 / v0.1.0 | 2 | 0 |
| [alondero/automobililamborghini-recomp](https://github.com/alondero/automobililamborghini-recomp/releases/tag/v0.6.2) | 377829195 / v0.6.2 | 2 | 0 |
| AngheloAlf/drmario64_recomp | no-published-release () | unassessed | unassessed |
| [BanjoRecomp/BanjoRecomp](https://github.com/BanjoRecomp/BanjoRecomp/releases/tag/v1.0.2) | 363285793 / v1.0.2 | 5 | 0 |
| [birabittoh/NocturneRecomp](https://github.com/birabittoh/NocturneRecomp/releases/tag/v1.4.5) | 378175281 / v1.4.5 | 6 | 0 |
| [bryankruman/BeetleRecomp](https://github.com/bryankruman/BeetleRecomp/releases/tag/Continuous) | 356146923 / Continuous | 2 | 0 |
| [bryanthaboi/gen1recomp](https://github.com/bryanthaboi/gen1recomp/releases/tag/v0.2.56) | 382812607 / v0.2.56 | 13 | 0 |
| [cdlewis/snowboardkids2-recomp](https://github.com/cdlewis/snowboardkids2-recomp/releases/tag/v2.0.0%2Balpha3) | 373150700 / v2.0.0+alpha3 | 6 | 0 |
| [Cellenseres/SSSV_Recomp](https://github.com/Cellenseres/SSSV_Recomp/releases/tag/v0.2.0) | 296683060 / v0.2.0 | 3 | 0 |
| [DinosaurPlanetRecomp/dino-recomp](https://github.com/DinosaurPlanetRecomp/dino-recomp/releases/tag/v0.3.0) | 323950868 / v0.3.0 | 4 | 0 |
| [flyngmt/ACGC-PC-Port](https://github.com/flyngmt/ACGC-PC-Port/releases/tag/v0.9.3-playtest) | 363664754 / v0.9.3-playtest | 1 | 0 |
| [HarbourMasters/2ship2harkinian](https://github.com/HarbourMasters/2ship2harkinian/releases/tag/5.0.1) | 376134681 / 5.0.1 | 3 | 0 |
| [HarbourMasters/Ghostship](https://github.com/HarbourMasters/Ghostship/releases/tag/3.0.0) | 383827886 / 3.0.0 | 5 | 0 |
| [HarbourMasters/Lighthouse](https://github.com/HarbourMasters/Lighthouse/releases/tag/1.1.0) | 371492187 / 1.1.0 | 3 | 0 |
| [HarbourMasters/Shipwright](https://github.com/HarbourMasters/Shipwright/releases/tag/9.2.3) | 308678500 / 9.2.3 | 3 | 0 |
| [HarbourMasters/SpaghettiKart](https://github.com/HarbourMasters/SpaghettiKart/releases/tag/1.0.0) | 290115373 / 1.0.0 | 4 | 0 |
| [HarbourMasters/Starship](https://github.com/HarbourMasters/Starship/releases/tag/v2.0.0) | 220828885 / v2.0.0 | 3 | 3 |
| [HarvestMoon64Recomp/HarvestMoon64Recomp](https://github.com/HarvestMoon64Recomp/HarvestMoon64Recomp/releases/tag/v1.2.1) | 349953753 / v1.2.1 | 5 | 0 |
| [jessetbh/VPW2Recomp](https://github.com/jessetbh/VPW2Recomp/releases/tag/v0.1.0) | 356123651 / v0.1.0 | 2 | 0 |
| [jessetbh/VPW64Recomp](https://github.com/jessetbh/VPW64Recomp/releases/tag/v0.1.0) | 354141841 / v0.1.0 | 2 | 0 |
| [jessetbh/WCWnWoRevengeRecomp](https://github.com/jessetbh/WCWnWoRevengeRecomp/releases/tag/v0.1.1) | 356125824 / v0.1.1 | 2 | 0 |
| [jessetbh/WCWvsNWOWorldTourRecomp](https://github.com/jessetbh/WCWvsNWOWorldTourRecomp/releases/tag/v0.1.2) | 350911194 / v0.1.2 | 2 | 0 |
| [jessetbh/WWFNoMercyRecomp](https://github.com/jessetbh/WWFNoMercyRecomp/releases/tag/v0.1.1) | 357715984 / v0.1.1 | 2 | 0 |
| [jessetbh/WWFWrestleMania2000Recomp](https://github.com/jessetbh/WWFWrestleMania2000Recomp/releases/tag/v0.1.0) | 354156746 / v0.1.0 | 2 | 0 |
| [JRickey/BattleShip](https://github.com/JRickey/BattleShip/releases/tag/v1.6) | 368973572 / v1.6 | 9 | 0 |
| [klorfmorf/Goemon64Recomp](https://github.com/klorfmorf/Goemon64Recomp/releases/tag/v0.2.0-dev) | 281797887 / v0.2.0-dev | 8 | 0 |
| [Legend-of-Dragoon-Modding/Severed-Chains](https://github.com/Legend-of-Dragoon-Modding/Severed-Chains/releases/tag/devbuild) | 226903849 / devbuild | 6 | 0 |
| [MegaMan64Recomp/MegaMan64Recompiled](https://github.com/MegaMan64Recomp/MegaMan64Recompiled/releases/tag/v0.9.1) | 316082995 / v0.9.1 | 5 | 0 |
| [mstan/MegaManX6Recomp](https://github.com/mstan/MegaManX6Recomp/releases/tag/v1.0.10) | 384301490 / v1.0.10 | 4 | 0 |
| [mstan/TombaRecomp](https://github.com/mstan/TombaRecomp/releases/tag/shared-staging-20260903) | 382199841 / shared-staging-20260903 | 4 | 0 |
| [NJH-1001/RevPRecompile](https://github.com/NJH-1001/RevPRecompile/releases/tag/v0.1.1) | 378782344 / v0.1.1 | 9 | 0 |
| [open-goal/jak-project](https://github.com/open-goal/jak-project/releases/tag/v0.3.6) | 376115961 / v0.3.6 | 8 | 0 |
| [perfect-dark-pc-port/perfect_dark](https://github.com/perfect-dark-pc-port/perfect_dark/releases/tag/ci-dev-build) | 155654014 / ci-dev-build | 9 | 0 |
| [Rainchus/Donkey-Kong-64-Recompiled](https://github.com/Rainchus/Donkey-Kong-64-Recompiled/releases/tag/1.0.2) | 380942288 / 1.0.2 | 5 | 0 |
| [Rainchus/Quest64-Recomp](https://github.com/Rainchus/Quest64-Recomp/releases/tag/v0.1) | 275862525 / v0.1 | 1 | 0 |
| [RevoSucks/BM64Recomp](https://github.com/RevoSucks/BM64Recomp/releases/tag/v1.0.0) | 299978181 / v1.0.0 | 8 | 0 |
| [RevoSucks/BMHeroRecomp](https://github.com/RevoSucks/BMHeroRecomp/releases/tag/v0.7.1) | 316921106 / v0.7.1 | 8 | 0 |
| [SMCGames/Paper-Mario-ReCut](https://github.com/SMCGames/Paper-Mario-ReCut/releases/tag/v0.1.2) | 332755572 / v0.1.2 | 1 | 0 |
| [TechnicallyComputers/Bomberman-Fantasy-Race-Recomp](https://github.com/TechnicallyComputers/Bomberman-Fantasy-Race-Recomp/releases/tag/v0.1.2) | 376895905 / v0.1.2 | 4 | 0 |
| [TechnicallyComputers/Bomberman-World-Recomp](https://github.com/TechnicallyComputers/Bomberman-World-Recomp/releases/tag/v0.1.20) | 376895990 / v0.1.20 | 4 | 0 |
| [TechnicallyComputers/BombermanPartyEditionRecomp](https://github.com/TechnicallyComputers/BombermanPartyEditionRecomp/releases/tag/v0.3.17) | 376896080 / v0.3.17 | 4 | 0 |
| [TechnicallyComputers/Final-Fantasy-VII](https://github.com/TechnicallyComputers/Final-Fantasy-VII/releases/tag/v0.1.6) | 379910102 / v0.1.6 | 4 | 0 |
| [TechnicallyComputers/Klonoa-Door-to-Phantomile](https://github.com/TechnicallyComputers/Klonoa-Door-to-Phantomile/releases/tag/v0.1.3) | 376502335 / v0.1.3 | 4 | 0 |
| [TechnicallyComputers/Legend-of-Mana-Recomp](https://github.com/TechnicallyComputers/Legend-of-Mana-Recomp/releases/tag/v0.1.2) | 376879063 / v0.1.2 | 4 | 0 |
| [TechnicallyComputers/Marvel-vs.-Capcom-Clash-of-Super-Heroes-Recomp](https://github.com/TechnicallyComputers/Marvel-vs.-Capcom-Clash-of-Super-Heroes-Recomp/releases/tag/v0.3.18) | 376896886 / v0.3.18 | 4 | 0 |
| [TechnicallyComputers/MastersOfTerasKasiRecomp](https://github.com/TechnicallyComputers/MastersOfTerasKasiRecomp/releases/tag/v0.3.16) | 376896807 / v0.3.16 | 4 | 0 |
| [TechnicallyComputers/Metal-Slug-X-Recomp](https://github.com/TechnicallyComputers/Metal-Slug-X-Recomp/releases/tag/v0.1.20) | 376897266 / v0.1.20 | 4 | 0 |
| [TechnicallyComputers/Rampage---Through-Time-Recomp](https://github.com/TechnicallyComputers/Rampage---Through-Time-Recomp/releases/tag/v0.1.22) | 376896088 / v0.1.22 | 4 | 0 |
| [TechnicallyComputers/Star-wars---Episode-I---Jedi-Power-Battles-Recomp](https://github.com/TechnicallyComputers/Star-wars---Episode-I---Jedi-Power-Battles-Recomp/releases/tag/v0.1.2) | 376897099 / v0.1.2 | 4 | 0 |
| [TechnicallyComputers/Street-Fighter-Alpha-3-Recomp](https://github.com/TechnicallyComputers/Street-Fighter-Alpha-3-Recomp/releases/tag/v0.2.15) | 376897414 / v0.2.15 | 4 | 0 |
| [TechnicallyComputers/TwistedMetal4Recomp](https://github.com/TechnicallyComputers/TwistedMetal4Recomp/releases/tag/v0.3.30) | 385088092 / v0.3.30 | 4 | 0 |
| [ThatGuyMcd/DKR-R](https://github.com/ThatGuyMcd/DKR-R/releases/tag/Version1.0.4) | 382294437 / Version1.0.4 | 4 | 0 |
| [ThiagoLira/trouble-makers-pc-recomp](https://github.com/ThiagoLira/trouble-makers-pc-recomp/releases/tag/v0.8.2) | 383650234 / v0.8.2 | 3 | 0 |
| [TwilitRealm/dusklight](https://github.com/TwilitRealm/dusklight/releases/tag/v1.4.1) | 340438777 / v1.4.1 | 8 | 0 |
| [Unchiga/YuGiOhForbiddenMemoriesRecomp](https://github.com/Unchiga/YuGiOhForbiddenMemoriesRecomp/releases/tag/v0.5.9) | 385305257 / v0.5.9 | 4 | 0 |
| [UNDERdecoded/Gen2Recomped](https://github.com/UNDERdecoded/Gen2Recomped/releases/tag/v0.7.37) | 383410758 / v0.7.37 | 13 | 0 |
| [Zelda64Recomp/Zelda64Recomp](https://github.com/Zelda64Recomp/Zelda64Recomp/releases/tag/v1.2.2) | 242740890 / v1.2.2 | 5 | 0 |
| zolaware/reblue | api-failed (nightly) | unassessed | unassessed |
| [Zorkats/G-Diffuser](https://github.com/Zorkats/G-Diffuser/releases/tag/v1.1.0) | 378247635 / v1.1.0 | 2 | 0 |

## Exact missing-digest assets

| Asset ID | Name | Bytes | API digest |
| --- | --- | --- | --- |
| 258112321 | [Starship-Barnard-Alfa-Linux.zip](https://github.com/HarbourMasters/Starship/releases/download/v2.0.0/Starship-Barnard-Alfa-Linux.zip) | 79980135 | absent |
| 258080314 | [Starship-Barnard-Alfa-Switch.zip](https://github.com/HarbourMasters/Starship/releases/download/v2.0.0/Starship-Barnard-Alfa-Switch.zip) | 6488483 | absent |
| 258082402 | [Starship-Barnard-Alfa-Windows.zip](https://github.com/HarbourMasters/Starship/releases/download/v2.0.0/Starship-Barnard-Alfa-Windows.zip) | 4218590 | absent |

## Acquisition decision

The legacy cases retained in #245/#61/#119/#120/#122/#125/#126/#127 remain historical evidence of acquisition/adoption friction; this sample does not requalify them. Keep missing expected identity, locally observed bytes, imported/adopted provenance and exact verified downloaded bytes distinct. Repeated hashing or signing a same-download observation cannot authenticate original acquisition.

Use authenticated upstream expected identity and existing reviewed direct-manifest provenance for the minimum independent-delivery proof. The present evidence does not justify broadening acquisition authority. A curated legacy path stays a separate optional #315 proposal with explicit scope, provenance, consent and recovery approval. Current installed contracts and verified caches keep their existing rules.

The complete local API observation, including every asset ID, URL, size and digest, is retained at `E:/Portcove-Development/work/catalog-upstream-digest-observations.json`. This dated table records the complete selector sample; it must not be updated as a mutable work ledger.
