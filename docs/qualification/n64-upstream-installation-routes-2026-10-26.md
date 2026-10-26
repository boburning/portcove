# Five N64 upstream routes — October 26, 2026

This component continues [#2510](https://github.com/boburning/portcove/issues/2510)
and [#2926](https://github.com/boburning/portcove/issues/2926) from verified main
`d8ef4a218082fce12e961c0611b3df189d9b34bc`. The
[structured evidence](n64-upstream-installation-routes-2026-10-26.json) binds exact
upstream repositories, pinned sources, complete release histories, platform
limits and acquisition conditions. Its candidate status is historical evidence;
the PR and canonical owners record actual delivery. It is not a live backlog.

| Identity / canonical owner                                                           | Useful selected route                                                                              | Remaining acquisition/operation condition                                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Snowboard Kids / [#1886](https://github.com/boburning/portcove/issues/1886)          | Permitted copy, first-Play North American ROM selection, actual standard/portable profile          | Applicable permission for the exact linked cdlewis/RecompFrontend component remains unestablished.                                               |
| Chameleon Twist / [#125](https://github.com/boburning/portcove/issues/125)           | Permitted Windows copy, first-Play Japanese ROM selection, complete working/profile preservation   | Existing expected-artifact integrity hold remains; pinned source also carries separately authored Chiaro font files requiring permission review. |
| Beetle Adventure Racing / [#1800](https://github.com/boburning/portcove/issues/1800) | Permitted Windows alpha player, Load ROM for the own USA game, Controller Pak/profile preservation | Applicable grant for linked vendored RecompFrontend remains unestablished; the parent AGPL does not license another author's work by itself.     |
| Banjo-Tooie / [#1795](https://github.com/boburning/portcove/issues/1795)             | Permitted Windows/Linux copy, own USA big-endian Z64, complete player/profile preservation         | v1.0.1 still identifies the frontend permission gap and Suplexmentary Comic NC.ttf with no applicable font license.                              |
| Wave Race 64 / [#168](https://github.com/boburning/portcove/issues/168)              | Accurate source/prototype status and preservation of already registered development copies         | Existing useful-output hold: no player release, renderer noise only, inherited wrong-game build instructions.                                    |

The first four guides distinguish registration from explicit Play and upstream
original-file selection. No nonexistent installer, compiler or extractor is run.
Keep the whole permitted player folder, its original inputs and actual profile;
these routes offer no Core-managed runtime replacement, backup, rollback or
external-file deletion. Discovery does not execute an upstream player/helper.
Published platform names are separate from native header/runtime qualification.
All 167 managed definitions, all 1,424 identities, artwork, lineage and retained
contracts are preserved. No richer integration is replaced or parallel port ID,
installer, lifecycle engine or per-game code added.

## Pinned evidence and operation boundaries

**Snowboard Kids.** v1.0.6 resolves to
`2ac83a8af625acf7da92d5610b25f2693bff7c91`. Its
[README](https://github.com/cdlewis/snowboardkids-recomp/blob/2ac83a8af625acf7da92d5610b25f2693bff7c91/README.md)
describes North American input validation, normal profile locations and portable
mode. Windows/native Linux use a marker in the working folder; macOS checks
beside its application bundle. The pinned
[Flatpak manifest](https://github.com/cdlewis/snowboardkids-recomp/blob/2ac83a8af625acf7da92d5610b25f2693bff7c91/flatpak/io.github.snowboardkidsrecomp.snowboardkidsrecomp.json)
uses app ID io.github.snowboardkidsrecomp.snowboardkidsrecomp. Its main changes
the working directory to /var/data for writable mods, while the
[frontend resolver](https://github.com/cdlewis/RecompFrontend/blob/fa4f0ca42ba2efaca631203ef1e0753f2be78985/recompui/src/util/file.cpp)
still uses HOME/.config plus the program ID, or APP_FOLDER_PATH/portable mode; it
does not consume XDG_CONFIG_HOME. Preserve the whole Flatpak app directory
alongside that actual profile. [Flatpak conventions](https://docs.flatpak.org/en/latest/conventions.html)
describe the per-app writable directory; no sandbox-config destination is
guessed from another title. The exact [submodule pointer](https://github.com/cdlewis/snowboardkids-recomp/blob/2ac83a8af625acf7da92d5610b25f2693bff7c91/.gitmodules)
resolves RecompFrontend to `fa4f0ca42ba2efaca631203ef1e0753f2be78985` in repository
1291620990. Its complete tree and
[own README](https://github.com/cdlewis/RecompFrontend/blob/fa4f0ca42ba2efaca631203ef1e0753f2be78985/README.md)
do not establish an applicable frontend grant. Nested dependency licenses and
the game project's GPL do not settle that fact. Keep a useful permitted-copy
route; reconsider acquisition with an attributable compatible grant or a
reviewed replacement. Windows, Linux x64/ARM64 and macOS packages were observed
separately; Core's current host model does not include Linux ARM64.

**Chameleon Twist.** v0.1 resolves to
`a2c5cbb4fbf3ca01a2f8bec4614c5aab1eb188f9` and still publishes one ZIP with no
expected GitHub digest. The existing [#125 integrity condition](https://github.com/boburning/portcove/issues/125)
and separate curated-trust authority remain unresolved. This batch supplies no
approved expected hash or silent exception. The
[pinned source](https://github.com/Rainchus/ChameleonTwist1-JP-Recomp/tree/a2c5cbb4fbf3ca01a2f8bec4614c5aab1eb188f9/assets)
also contains ChiaroBold.otf / ChiaroNormal.otf (Git blobs
`b265e234167a5f517471d0bddd4f6dcbe3f8d920` /
`2601be358e5c1d60950e9a8f1ded8b286fef0bd3`). An attributable permission basis
for these separately authored files is not established by COPYING. Source
presence is not an inspected or authenticated package claim. The
[game host](https://github.com/Rainchus/ChameleonTwist1-JP-Recomp/blob/a2c5cbb4fbf3ca01a2f8bec4614c5aab1eb188f9/src/main/main.cpp)
expects normalized Japanese ROM XXH3-64 `0ff1b3a34ee3fb82`; it retains that game
identity check. The executable target is ChameleonTwistJPRecompiled. The actual
[profile resolver](https://github.com/Rainchus/ChameleonTwist1-JP-Recomp/blob/a2c5cbb4fbf3ca01a2f8bec4614c5aab1eb188f9/src/game/config.cpp)
allows portable/custom locations. No new managed route, publisher trust or
Linux package is inferred from the inherited guide. Existing Blocked state stays.

**Beetle Adventure Racing.** v0.4.2-alpha resolves to
`974596dfa0493fe2c7c2446b3f5165dd11237020`. The
[release](https://github.com/danielgomesvieira2000/beetle-adventure-racing-recomp/releases/tag/v0.4.2-alpha)
offers a Windows x64 player separately from debug symbols. All six observed
tags contain -alpha, which Core classifies as Beta despite GitHub prerelease=false;
the recommendation therefore uses Preview/Beta. This grants no new acquisition
permission. The advertised input
is the own USA ROM with SHA-1 `e5ab4d226c08d22f68a2edcc48870203e67454b8`.
Its [license analysis](https://github.com/danielgomesvieira2000/beetle-adventure-racing-recomp/blob/974596dfa0493fe2c7c2446b3f5165dd11237020/THIRD_PARTY_NOTICES.md)
retains separately authored vendored components and does not establish the
frontend's grant. Complete tree review distinguishes that frontend from its
licensed nested dependencies; no generic font accusation is substituted.
The [profile resolver](https://github.com/danielgomesvieira2000/beetle-adventure-racing-recomp/blob/974596dfa0493fe2c7c2446b3f5165dd11237020/src/game/config.cpp)
uses the normal Windows profile, portable executable directory or fallback
working directory. Preserve the actual copy/profile, including Controller Pak,
settings and cached original input; no Linux success is inferred from Windows.

**Banjo-Tooie.** v1.0.1 resolves to current source
`9e5852541ba1436417e2c4468960e8c6de6deda5`. Its
[licensing section](https://github.com/Vidanox/BanjoTooieRecompiled/blob/9e5852541ba1436417e2c4468960e8c6de6deda5/README.md#licensing)
expressly identifies both the frontend permission gap and Suplexmentary Comic
NC.ttf without a license, including its all-rights-reserved notice. Referencing
the frontend as a submodule does not avoid its use in the compiled player.
[Packaging](https://github.com/Vidanox/BanjoTooieRecompiled/blob/9e5852541ba1436417e2c4468960e8c6de6deda5/.github/workflows/build.yml)
copies the complete assets directory into both native archives. The exact
frontend pointer is `b1a1477c6556aeb7ed45defbfb5924f721efebc1` in repository
1049072803. Later release numbering and available publisher digests do not repair
these component facts. Reconsider with attributable compatible grants or an
appropriately replaced released package. The Linux wrapper only selects its
working directory before exec; retain that directory and the documented Vulkan,
library and file-dialog portal prerequisites. The upstream Flatpak guide describes a sandbox-config location, but the pinned
frontend resolver is the same HOME/.config implementation as Snowboard and the
manifest supplies no APP_FOLDER_PATH override. Preserve the whole
[Flatpak app directory](https://github.com/Vidanox/BanjoTooieRecompiled/blob/9e5852541ba1436417e2c4468960e8c6de6deda5/flatpak/io.github.Vidanox.BanjoTooieRecompiled.json)
alongside the actual profile/custom/portable location; no exact sandbox-profile
claim is made from the README alone. The native loader requires the own USA 32 MiB big-endian Z64 (SHA-1
`af1a89e12b638b8d82cc4c085c8e01d4cba03fb3`); no original input was obtained.

**Wave Race.** Current source is still
`63817bc71d31210a064f99010a010eb5e335b239`, with complete empty release history.
The [README](https://github.com/chronic8000/WaveRace64Recompiled/blob/63817bc71d31210a064f99010a010eb5e335b239/README.md)
reports only two boxes of noise;
[BUILDING](https://github.com/chronic8000/WaveRace64Recompiled/blob/63817bc71d31210a064f99010a010eb5e335b239/BUILDING.md)
still names the inherited other game. Preserve #168's existing useful-output hold
and Deferred state. The guide does not offer a new qualified registration or
fresh player, nor revoke an already registered development copy. Reconsider on
useful runnable output and title-specific preparation, rather than requiring a
personal gameplay campaign or creating a new engine fork.

## Validation and remaining work

All five known identities have bounded route/platform assessments. Missing
component permission is an unresolved operation fact, not an illegality finding,
Unsupported label or new permanent product deferral. No held package, original
input, game/helper/installer or compiler was acquired/executed for this batch.
Maintained preparation/Core declaration inspection and generated output validation
apply; the PR records separate review and exact-head hosted execution inventories.
Native, gameplay, real-save and packaged Desktop observations remain unclaimed.

The [prior complete identity refresh](classic-upstream-installation-routes-2026-10-26.md)
retains 1,510 known identities at its stated cutoff; these five existing records
change no membership. This is not a fresh global retrieval or all-fit completion
claim. Original **524 / 312 / 22**, duplicate/lineage relationships, five original
unlisted joins and all six Direct decisions remain preserved. #2510/#2926 stay
open for their full acceptance; #1422's frozen cohort and #2225/#47/#48/#534/#246
retain independent scope. Full Public beta acceptance remains **false**.
