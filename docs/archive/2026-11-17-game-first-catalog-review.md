# Original-game catalog review — November 17, 2026

This dated evidence supports [#8076](https://github.com/boburning/portcove/issues/8076).
The issue owns current implementation and application acceptance. These counts
and decisions describe the audited catalog, not a second catalog or backlog.

The audit binds source `8e755a5b907568448e9fc8610eccc280199e30a9`. The
[independent regression baseline](../../scripts/fixtures/game-first-catalog-relationships.json)
binds reviewed proposal hashes and expected relationships independently of the
generated catalog under test. It contains every audited port ID, 240 complete
multi-option families, eleven deliberate separations and 38 project entries.
Authored per-port records remain the identity authority.

## Coverage

| Measure | Before | Repaired authored/projection result |
| --- | ---: | ---: |
| Authored ports / projected listings | 1,550 | 1,550 |
| Operational definitions | 435 | 435 |
| Ports with reviewed original-game identity | 10 | 1,512 |
| Distinct identified original games | 7 | 1,171 |
| Standalone entries without a single-game identity | 1,540 | 38 |
| Unfiltered production groups | 1,547 | 1,209 |

Production grouping means the complete definition/listing union projected by
`catalogEntries`, followed by `groupCatalog`, with no search, filters, pending
setups or additional retained user records. The 38 repaired project entries are
29 multi-game/collection players, two frameworks and seven specifically unresolved
identities. Identified records include eleven reviewed separate-game decisions;
these are not missing mappings. Field population alone does not establish any of
these relationships.

## Reused evidence and preservation

Validated lineage supplied 79 multi-port targets with 176 actual port members.
The maintenance universe also contains implementation entries, which were excluded
from that denominator. Partial canonical groups, retained source/setup guides,
exact source profiles and pinned upstream evidence reduced repeated research.
Names, cover IDs and shared repositories only nominated candidates. Different
lineage targets can share a game; no target or retained decision was renamed.

All 1,550 original source records were compared semantically with the audit.
Only `listing.original_game`, `listing.original_game_title`, two MediEvil II
`variant_label` values and author-only `original_game_review` changed. Every
operational declaration, stable port/issue identity, source/BIOS requirement,
release, persistence/setup field, artwork/media object and lineage object remains
equal. All ten existing `original_game` objects remain equal, preserving their
Saved, preferred-implementation and media keys. Four provisional Wind Waker HD
IDs introduced within this unpublished branch were restored against exact audited
preimages before applying the reviewed common original-game identity. They were
never delivered IDs or a player-state migration.

Clear relationships include the named N64 pairs, managed/listing-only families,
regional aliases and previously missed cross-title editions. The largest reviewed
families include six Perfect Dark options, six Wind Waker options and six Monster
Hunter Freedom Unite / Portable 2nd G options. Exact originals, installation and
update owners remain separate. MediEvil II retains its prebuilt-player and setup-kit
routes with different source, BIOS, mod and persistence requirements. Kula World’s
known USA Roll Away and Japanese KulaQuest editions are recorded only on the
implementation whose source guide accepts them; its other implementations retain
their European source editions.

## Specifically unresolved identities

These records remain reachable as project entries. Their authored review carries
the precise evidence condition for reconsideration.

| Port | Missing evidence |
| --- | --- |
| `alexbeav-kings-field-recomp` | The upstream README declares Japan but the generator still uses scaffold marker SLUS_01234. Recover an attributable actual disc/executable target before assigning the precise original game or merging it with US King’s Field; a region label alone is insufficient. |
| `dragon-ball-z-budokai-hd-first-game-dbz1` | The retained listing labels the first Budokai game, but primary DBZ1 README/configuration only identifies generic Budokai HD/default.xex and includes copied rb2/RE2 setup. It does not prove whether the imported executable is the first game or the HD Collection launcher. Obtain a title-specific executable/member identity and upstream entrypoint/source mapping before assigning one original game. Shared collection artwork and the DBZ1 repository name do not establish that scope. |
| `jojo-s-bizarre-adventure-hd-ver-recompiled-edition-unrealwins-jojo-s-bizarre-adventure-hd-ver` | The exact HD Ver. Xbox360 original is identified, but retained source facts do not settle its relationship to the separately cataloged PS1 Heritage for the Future adaptation (which can have different content). Review direct publisher/original-product evidence before making a shared original-game assignment; franchise similarity and an HD suffix alone are insufficient. |
| `ninja-gaiden-ii-ninjas-dawn` | Retained listing has generic Explore text with no setup/source facts; authenticated primary HEAD read returned HTTP404. Recover attributable upstream original-game target evidence before assigning a canonical ID. |
| `sly-cooper-and-the-thievius-raccoonus-recomp` | Primary upstream repository/HEAD is unavailable (GitHub API read failed); retained listing only has generic Explore summary and no setup/source facts. Require recovered attributable upstream target evidence before joining the family. |
| `tekken-3-tekken3recomp` | Retained listing has generic Explore text with no setup/source facts; authenticated primary HEAD read returned HTTP404. Recover attributable upstream original-game target evidence before assigning a canonical ID. |
| `ufc-undisputed-3-ufc3recomp` | Primary upstream repository/HEAD is unavailable (GitHub API read failed); retained listing only has generic Explore summary and no setup/source facts. Require recovered attributable upstream target evidence before joining the family. |

## Deliberate separate games

The original-game ID is explicit; separation is based on the actual remake,
modified-game or materially different campaign scope, rather than source-file or
save incompatibility alone.

| Port | Original-game ID | Reviewed boundary |
| --- | --- | --- |
| `ajncsystem-shadowofthecolossus-pc` | `shadow-of-the-colossus-2018` | Prepared-player contract explicitly targets the 2018 PS4 remake and excludes PS2/PS3 originals; keep that distinct remake identity. |
| `brawmario-infinite-mario-64-ever` | `infinite-mario-64-ever` | Upstream identifies a fork of Infinite Mario64 using libsm64/Godot; this procedural modified game has its own campaign scope, not the original Super Mario64 adventure. |
| `medievil-ps4-native-runtime-bc160201983-medievil-2019` | `medievil-2019` | The exact source contract targets the 2019 PS4 remake, distinct from the original PlayStation MediEvil. |
| `omegakatana92-battle-arena-toshinden-gb-recomp` | `battle-arena-toshinden-game-boy` | The source targets the 2D Game Boy adaptation, distinct in game content and mechanics from the original PlayStation fighting game; source titles alone do not merge them. |
| `projectr-san-francisco-rush-2049` | `san-francisco-rush-2049` | ProjectR is a shared runtime label. This scoped entry targets Rush2049; it shares original-game identity with the N64 adaptation while preserving arcade CHD and exact supported modes separately. |
| `projectr-san-francisco-rush-the-rock` | `san-francisco-rush-the-rock` | ProjectR is a shared runtime label; this record targets The Rock, not Rush2049. Do not merge different original racing games merely because they use one runtime. |
| `r-e-l-i-v-e-oddworld-abe-s-exoddus` | `oddworld-abes-exoddus` | R.E.L.I.V.E. supports two distinct original games. This entry is explicitly scoped to Abe’s Exoddus; it is not Abe’s Oddysee. |
| `r-e-l-i-v-e-oddworld-abe-s-oddysee` | `oddworld-abes-oddysee` | R.E.L.I.V.E. supports two distinct original games. This entry is explicitly scoped to Abe’s Oddysee and shares that original-game identity with the Alexbeav implementation; its save/runtime requirements remain separate. |
| `ratchet-clank-pc-btsouth-ratchet-clank-2016` | `ratchet-and-clank-2016` | The exact source contract targets the 2016 reimagining, distinct from the original 2002 adventure. |
| `v64recomp-quake2-us-polaco1782-quake-ii-n64` | `quake-ii-nintendo-64` | QuakeII64 has its own19-level campaign and soundtrack; the publisher/developer list it separately from the original PC campaign. Preserve that materially different campaign identity, not merely a source-system split. |
| `voicedrew11-verdite2` | `kings-field-ii` | Verdite2 explicitly requires North American SLUS00158: US King’s Field, the international title of Japan King’s FieldII. This is distinct from the 1994 Japan original, whose Alexbeav scaffold target remains unresolved. |

## Non-single-game projects

These entries keep their real engine, collection or framework scope. Assigning a
sole member’s game ID would misrepresent their other supported original games.
They retain their exact setup routes and source facts.

| Port | Scope | Reviewed reason |
| --- | --- | --- |
| `ace-attorney-investigations-collection-nxnative-aa-port` | multi-game | This upstream route targets AceAttorney Investigations Collection, containing two distinct original Investigations games. A single member original-game identity would misstate collection scope. |
| `andreyvelsk-com-mobilerpgpack-phone` | multi-game | The authored runtime/launcher accepts multiple Doom-family games and their distinct game data/mod choices. Preserve the broad engine scope rather than labeling it as one original. |
| `apollo-justice-ace-attorney-trilogy-nxnative-aa-port` | multi-game | This upstream route targets the ApolloJustice Trilogy collection, containing ApolloJustice, DualDestinies and SpiritOfJustice as distinct original games. |
| `bips-blips` | multi-game | Authored scope names Bips, BipsGold and BipsPlatinum. Preserve the multi-game series scope rather than assigning one of those originals. |
| `bodbdearg-psydoom` | multi-game | The exact launcher/source contract offers PlayStation Doom and FinalDoom disc images as separate choices. Preserve both game scopes and original requirements. |
| `chocolate-doom-family` | multi-game | The record explicitly offers separate ChocolateDoom, Heretic, Hexen and Strife players with their matching data. A sole Doom identity would hide or mislabel the other originals. |
| `cps2recomp-vampire-savior-definitive` | multi-game | The retained original-file guide explicitly requires BOTH vsavj (Vampire Savior) and vsav2 (Vampire Savior 2). Definitive is a composite modification, not a source edition of either individual arcade game. Its shared IGDB slug cannot authorize grouping with Vampire Savior. |
| `crownpark-xbox360-native-ports-collection` | multi-game | The collection publishes title-specific launchers for multiple Xbox360 games; each selected bundle has its own SOURCE.txt original identity. This umbrella record has no one original-game scope. |
| `djultra64-clayfighter64` | multi-game | The retained guide explicitly combines ClayFighter 63⅓ gameplay with Sculptor's Cut donor characters and requires both originals. It does not recreate all of Sculptor's Cut; preserve this fusion identity separately from either source title. |
| `doom-doom-retro` | multi-game | The authored source/setup scope explicitly permits Doom or Freedoom originals, with per-IWAD game/save choices. This broad engine record is not scoped to one original game. |
| `doom-dsda-doom` | multi-game | The authored source/setup scope explicitly permits Doom or Freedoom originals, with per-IWAD game/save choices. This broad engine record is not scoped to one original game. |
| `doom-nugget-doom` | multi-game | The authored source/setup scope explicitly permits Doom or Freedoom originals, with per-IWAD game/save choices. This broad engine record is not scoped to one original game. |
| `doom-odamex` | multi-game | The authored source/setup scope explicitly permits Doom or Freedoom originals, with per-IWAD game/save choices. This broad engine record is not scoped to one original game. |
| `doom-the-eternity-engine` | multi-game | The authored source/setup scope explicitly permits Doom or Freedoom originals, with per-IWAD game/save choices. This broad engine record is not scoped to one original game. |
| `doom-woof` | multi-game | The authored source/setup scope explicitly permits Doom or Freedoom originals, with per-IWAD game/save choices. This broad engine record is not scoped to one original game. |
| `f-e-a-r-360-recompiled-juansolo457-f-e-a-r-files-xbox-360` | multi-game | The retained F.E.A.R. Files summary/warnings explicitly scope two expansion campaigns, distinct from base F.E.A.R. title 565507D9; Files has title 565507E8 and its own preparation. A shared repository does not collapse either campaign or base-game identity. |
| `final-doom-crispy-doom-family` | multi-game | The retained guide accepts either TNT.WAD (TNT: Evilution) or PLUTONIA.WAD (The Plutonia Experiment) and explicitly requires the campaigns to remain distinct. This is a collection-scoped player, not Doom II or one uniquely scoped campaign. |
| `gsrecomp` | multi-game | The retained guide explicitly calls this one collection launcher for Golden Sun: The Broken Seal AND Golden Sun: The Lost Age. A first-game original_game_title would misrepresent its unscoped shared launch route. |
| `kirby-letsgo-oracles-decomp` | multi-game | The retained Add ROM guide explicitly offers Oracle of Ages OR Oracle of Seasons. Neither title is selected by a retained per-record argument; preserve this shared two-game launcher separately from each original. |
| `lostartefacts-trx` | multi-game | The record explicitly spans TombRaiderI–III through a shared engine. Those are distinct original games; do not choose one as the umbrella identity. |
| `luanti` | framework | The retained guide states that Luanti supplies the engine and the player must install/select a separate ContentDB game, such as Minetest Game. Worlds/mods are not one identified original game. |
| `openra-openra` | multi-game | The exact Windows/macOS/Linux routes provide separate RedAlert, TiberianDawn and Dune2000 players. Retain explicit game choice instead of assigning one original to the shared project. |
| `phoenix-wright-ace-attorney-trilogy-nxnative-aa-port` | multi-game | This upstream route targets the original PhoenixWright trilogy collection, containing three distinct original adventures. |
| `puyo-puyo-box-puyopuyoboxrecomp` | multi-game | PuyoPuyoBox is a compilation containing multiple PuyoPuyo games/modes. Do not assign one included original as the complete collection identity. |
| `red-alert-2-and-yuri-s-revenge-red-alert-2-recomp` | multi-game | The exact build procedure creates separate RedAlert2 game.exe1.006 and Yuri’sRevenge gamemd.exe1.001 players with separate Play choices. Preserve combined base/expansion player scope. |
| `super-mario-all-stars-smas-launcher` | multi-game | SuperMarioAllStars is a compilation of distinct Mario adventures. Preserve collection scope rather than treating every included game as one original. |
| `the-wind-waker-recomp` | framework | The authored summary explicitly identifies a development renderer/framework rather than a complete game runtime. Original-game identity must not imply playable game scope; review a future title-specific runtime separately. |
| `uzdoom-uzdoom` | multi-game | The authored runtime/launcher accepts multiple Doom-family games and their distinct game data/mod choices. Preserve the broad engine scope rather than labeling it as one original. |
| `wipeout-pc-abdelmoumendeghbouche-wipeout-omega-collection` | multi-game | WipEoutOmegaCollection combines HD/Fury and2048 content. Preserve the collection’s actual distinct game/campaign scope. |
| `wootbeer-jillandroid` | multi-game | The retained setup accepts the first episode or the complete trilogy. The publisher identifies Jill of the Jungle, Jill Goes Underground and Jill Saves the Prince as distinct included games; keep this multi-game player separate from a sole first-game identity. |
| `zdoom-gzdoom` | multi-game | The authored runtime/launcher accepts multiple Doom-family games and their distinct game data/mod choices. Preserve the broad engine scope rather than labeling it as one original. |

## Verification boundaries

The real-catalog regression tests exercise every listed multi-option family with
its complete expected member set, deliberate separations, fallback projects,
definition/listing precedence, stable presentation and real alias/project search.
Synthetic mechanics tests remain separate. Repository generation checks require
an explicit decision on each current authored record; preparation can still
collect missing evidence, and legacy runtime catalogs remain readable.

The Windows native journey consumes these independent expectations against the
actual loaded documents and shipping controls, records catalog and executable
provenance, exercises representative families in both layouts, and preserves its
choice/restart journey. Running that journey, inspecting its captures, required
exact-head CI, guarded delivery and installed/published-build observation retain
their separate evidence requirements on #8076. This dated source review claims
none of those observations by itself.


## November 18 current-catalog reconciliation

Target `eb6f13dc58bf2c5126dd830aafa3ff281edaabcb` adds the descriptive
`transport-tycoon-deluxe-openttd-android` listing through
[#8082](https://github.com/boburning/portcove/pull/8082), owned by
[#8081](https://github.com/boburning/portcove/issues/8081). Its
[pinned publisher README](https://github.com/pelya/openttd-android/blob/a3163e003f86ff2b4e56e739456b44e2bd34f5b0/README.md)
identifies the original Transport Tycoon Deluxe relationship; the
[community Android guide](https://wiki.openttd.org/en/Community/Patches/Compiling%20and%20installing%20the%20unofficial%20Android%20port)
confirms a separate Android implementation, signing and data route. Independent
review approved reusing `transport-tycoon-deluxe`, with source editions unspecified.
The expected family now includes Android, official desktop OpenTTD and JGR Patch
Pack. This extends the independently reviewed expectation, rather than deriving
it from the generated catalog.

The current universe is **1,551 listings**, **435 operational definitions**,
**1,513 identified records**, **1,171 original-game IDs**, **240 multi-option
families / 582 member records**, **38 standalone project entries**, and **1,209
production groups**. The original 1,550-record audit and preservation comparison
above remain historical evidence. The Android addition grants no managed action,
desktop platform, compatible-source or save claim. Its full setup guide, publisher
routes, artwork, opaque repository identity and lineage are preserved. The only
change to that target-authored record is its additive original-game metadata.
Target changes to the official desktop guide are retained. Current native
catalog assertions and the independent baseline include the added listing;
application acceptance is still owned by #8076.


## November 18 later catalog reconciliation

Target `f1e167f032e6285a7d1e57cc31703ccea2817eaa` adds six records. Primary
upstream evidence, rather than generated grouping output, establishes these
relationships. Existing player and source-edition requirements remain separate.

| Added record | Reviewed identity and primary evidence |
| --- | --- |
| `chocolate-heretic` | Existing `heretic`, joining Crispy Heretic; [game code](https://github.com/chocolate-doom/chocolate-doom/blob/chocolate-doom-3.1.1/src/heretic/d_main.c). |
| `chocolate-hexen` | Existing `hexen`, joining Crispy Hexen and v64recomp; [game code](https://github.com/chocolate-doom/chocolate-doom/blob/chocolate-doom-3.1.1/src/hexen/h2_main.c). |
| `ecwolf-wolfenstein3d` | Existing `wolfenstein-3d`, joining ReflectionHLE; this record is scoped to Wolfenstein 3D/WL1, despite the broader [ECWolf engine](https://maniacsvault.net/ecwolf/). |
| `f-zero-x-n64hub` | Existing `f-zero-x`, joining G-Diffuser; [pinned README](https://github.com/n64hub/f-zero-x-recomp/blob/v0.1.16/README.md). No 64DD/other-region compatibility is inferred. |
| `n64hub-mario-golf-n64-usa-n64recomp` | New `mario-golf-nintendo-64`, distinct from the same-name handheld game; [pinned README](https://github.com/n64hub/mario-golf-recomp/blob/v0.1.28/README.md). |
| `pok-mon-pokopia-recompia` | New `pokemon-pokopia`; [publisher repository](https://github.com/Dittobyte/Recompia) and [pinned launcher](https://github.com/Dittobyte/Recompia/blob/v0.15.0/launcher/README.md). Optional modifications do not create another original-game identity. |

Chocolate Doom's earlier multi-game reason above is historical. The target now
separately catalogs Heretic and Hexen and introduces a managed Doom player.
The current Chocolate Doom record still accepts distinct Doom or Doom II IWADs
and its external registration guide also accepts Doom/Freedoom. Its updated
review therefore remains multi-game, without assigning one original-game ID.
All new managed integration, source, persistence and runtime declarations remain
intact. [Upstream release](https://github.com/chocolate-doom/chocolate-doom/releases/tag/chocolate-doom-3.1.1)
retains separate game players.

Target guide updates for Guitar Hero II, Lost Odyssey, Monster Hunter Generations
Ultimate and Verdite2 retain their existing reviewed identities. Optional imported
songs, four discs, package updates and prepared registration do not change those
games; all target holds, profiles and original-file requirements remain intact.

The reconciled universe is **1,557 records / 439 operational definitions**,
**1,519 identified records / 1,173 games**, **243 multi-option families / 589
member records**, and **38 standalone project entries / 1,211 production groups**.
The 29 multi-game, two framework, seven unresolved and eleven deliberate
separation dispositions remain unchanged. The independent fixture retains prior
audits and Android reconciliation and appends these exact reviewed memberships.
These counts require normal generated-projection and application verification;
this dated review does not claim native or published application acceptance.


## November 18 second later catalog reconciliation

Target `1588c93fafd6ce598425dada7388c8799639e9ee` adds two records after the
preceding 1,557-record review. [openRTS's pinned README](https://github.com/SmileDoge/openRTS/blob/v0.22.0/README_EN.md)
explicitly identifies a RTrainSim reimplementation, and its [installation guide](https://github.com/SmileDoge/openRTS/blob/v0.22.0/INSTALL_EN.md)
requires that original's content. It receives canonical `rtrainsim`. Compatibility
with MSTS content formats does not make the record an MSTS implementation or a
generic framework. [Midtown Madness 3's pinned README](https://github.com/lakshya16157/midtown-madness-3-PC-Native/blob/v2.8.1/README.md)
identifies the original 2003 Xbox game and joins the existing TaxidriverHK entry
under `midtown-madness-3`. Optional modifications and DLC do not establish another
modified-game scope. Source editions remain unspecified; actual setup requirements
and source/save compatibility stay per implementation.

Teeworlds' added operational registration and updated Fallout, Crash Bandicoot
and Sonic Unleashed package/guide facts retain their existing exact game identities.
Their target operational/platform/profile/release and runtime ownership facts are
preserved, including distinct current-package and earlier prepared-registration
scopes. No new qualification is inferred.

The reconciled current universe is **1,559 records / 440 operational definitions**,
**1,521 identified records / 1,174 games**, **244 multi-option families / 591 member
records**, **38 project entries** and **1,212 production groups**. The original
audits and subsequent reconciliations remain dated evidence; all 29 multi-game,
two framework, seven unresolved and eleven deliberate separation decisions remain
explicit. The independent fixture appends the two reviewed records and complete
Midtown family expectation, rather than deriving membership from runtime output.
These are source/projection expectations, not native or delivered-app observations.

## November 18 third later catalog reconciliation

Target `3132d15fd6930f35b0513994dd99d5a05a8f009b` adds four records. The new
[BlinxRecomp route](https://github.com/mstan/BlinxRecomp/blob/v0.5.7/README.md)
joins the existing `blinx-the-time-sweeper` game. Its NTSC-U requirement and the
existing implementation's PAL requirement remain separate source checks.
[ReMoM](https://github.com/jbalcomb/ReMoM/blob/v0.1.0/PLAYING.md) reconstructs
original DOS Master of Magic and receives `master-of-magic`.
[OpenMCM2](https://github.com/crspytopgn/openmcm2/blob/v0.6.5/README.md)
receives `motocross-madness-2`; optional free graphics do not establish another
original game. [Theme Park's SNES route](https://github.com/Junior-Jones/Theme-Park-SNES-Static-Recomp/blob/v1.0.1/README.txt)
receives `theme-park`, with the exact European PAL ROM requirement preserved.
No current peer or evidence establishes a substantially different Theme Park game;
future platform comparisons still require review. Optional structured source
editions remain unspecified, without changing the existing setup requirements.

The current source universe is **1,563 records**, **1,525 identified records /
1,177 games**, **245 multi-option families / 593 member records**, **38 project
entries** and **1,215 production groups**. The 29 multi-game, two framework,
seven unresolved and eleven deliberate-separation decisions remain unchanged.
The independent fixture includes all four added records and both Blinx members.
All newer package holds, release selectors, setup guidance and retained lineage
facts remain intact. These are reviewed source expectations; native and published
application consumption remain separate acceptance requirements under #8076.

## November 19 current-target reconciliation and organization decision

Target `50cad218e4a09548397add43443a43f4eb89e592` adds the reviewed
[Wario Land 4 record](https://github.com/BioRhythmicStudios/warioland4/releases/tag/v0.3.2-beta).
[Nintendo identifies the original GBA game](https://www.nintendo.com/en-gb/Games/Game-Boy-Advance/Wario-Land-4-267596.html).
It remains a distinct `wario-land-4` singleton with its existing
`wario-land-4-gba-us` source edition. The independent fixture includes the new
record. Current target game IDs, evidence and source-edition facts agree with
all previously reviewed canonical assignments. Keep target game metadata where
present and fill its remaining mappings from the prior complete review; preserve
every existing ID, title decision, variant and explicit project disposition.

The composed source expectations are **1,564 records / 440 operational
definitions**, **1,526 mapped records / 1,178 game IDs**, **245 multi-option
families / 593 members**, **38 project entries** and **1,216 production groups**.
There are **321 source-edition declarations on 316 records**, representing
**300 distinct game/edition pairs**. All 29 multi-game, two framework, seven
unresolved and eleven deliberate-separation decisions remain unchanged.
New edition metadata describes source scope; it grants no file interchangeability,
save compatibility, runtime ownership or qualification.

On November 19 the owner explicitly chose: “Adopt the unified Favorite model”.
This replaces the original mission's separate Saved/port-Favorite presentation
requirement. Reuse the delivered one-game Favorite behavior and its read union of
legacy Saved and port Favorite choices, acknowledged writes, uncertain-write
readback and explicit retry. Keep current stores and unknown IDs, exact per-port
update notices, hiding and collections, and explicit preferred implementation.
A filtered-out sibling still contributes to the game's Favorite state; removal
must receive the full family. Stable game presentation must not select a runtime
action. Native and published-app observations remain separate outstanding
acceptance under #8076.
