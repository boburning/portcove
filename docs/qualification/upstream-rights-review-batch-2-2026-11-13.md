# Upstream-hosted rights review, batch 2

Date: 2026-11-13. Policy: [rights basis for upstream-hosted packages](../CATALOG.md#rights-basis-for-upstream-hosted-packages).
Tracking: [#2926](https://github.com/boburning/portcove/issues/2926). Previous batch:
[batch 1](upstream-rights-review-batch-1-2026-11-13.md).

On November 13, 2026 the owner adopted a Quiver-style model for
upstream-hosted packages. Tier 3 is the default; fonts, icons, launcher art,
unlicensed helper code and an unlicensed own layer are recorded notes rather
than holds; bundled game data, explicit upstream prohibitions and verified
rights-holder requests stay holds. This batch re-reviews the remaining holds
whose recorded basis was only such a component, and adds the Linux and macOS
packages that listings already offering downloads were missing.

For each listing the latest published release asset was downloaded from the
upstream's own release location, hashed and listed; licence, notice and readme
files were read. Nothing was executed or played. Where an archive could not be
listed, the listing stays held or the platform is not added.

## Offered again

Each package below holds the port's own code, recompiled or translated game
code, runtime libraries and launcher assets only; its listing names the
recorded component in its player warning.

| Listing (issue)                                                      | Release       | Platforms offered     | Recorded component                                    |
| -------------------------------------------------------------------- | ------------- | --------------------- | ----------------------------------------------------- |
| `darkuni-chocobo-dungeon-recomp` (#4131)                             | v1.1          | Windows               | Recompiled game code; launcher icon                   |
| `darkuni-mylifedarklord-recomp` (#4121)                              | v0.2          | Windows               | Recompiled game code; launcher icon                   |
| `darkuni-mylifeking-recomp` (#4120)                                  | v0.5          | Windows               | Recompiled game code; launcher icon                   |
| `darkuni-target-terror-wii-recomp` (#4178)                           | v1.0          | Windows               | Recompiled game code; launcher icon                   |
| `tekrantgaming-muppet-racemania-recompiled` (#4130)                  | v1.0.0        | Windows, Linux        | Recompiled game code; game logo; unlicensed own layer |
| `eandis-sdoj-recomp` (#1880)                                         | v1.51.4       | Windows, Linux        | Recompiled game code; icon art; unlicensed own layer  |
| `vidanox-banjotooierecompiled` (#1795)                               | v1.0.1        | Windows, Linux        | Suplexmentary Comic NC font                           |
| `cdlewis-snowboardkids-recomp` (#1886)                               | v1.0.9        | Windows, Linux, macOS | Modified RecompFrontend fork                          |
| `snowboard-kids` (#1354)                                             | v0.9.0-beta.1 | Windows, Linux (beta) | Modified RecompFrontend fork                          |
| `geometry-wars-retro-evolved-2-geometry-wars-2-recompiled` (#2577)   | v0.6.1        | Windows, Linux        | Unlicensed TRG launcher                               |
| `hard-corps-uprising-hard-corps-uprising-recompiled` (#2581)         | v0.7.1        | Windows, Linux        | Unlicensed TRG launcher                               |
| `crackdown-crackdown-recompiled` (#2559)                             | v0.6.2        | Windows, Linux        | Unlicensed TRG launcher                               |
| `blast-corps-blastcorps-recompiled` (#2558)                          | 1.1.1         | Windows               | Suplexmentary Comic NC font                           |
| `hybrid-heaven-ogdanimal` (#2546)                                    | v1.0.1        | Windows, Linux        | Chiaro fonts by Fontworks                             |
| `mario-kart-64-mariokart64recomp` (#332)                             | v0.9.2        | Windows               | Chiaro fonts by Fontworks                             |
| `n64hub-rayman-2-recomp-n64-usa` (#4335)                             | v0.1.15       | Windows, Linux        | Chiaro fonts by Fontworks                             |
| `n64hub-super-smash-bros-n64-usa-recomp` (#4337)                     | v0.1.12       | Windows, Linux        | Chiaro fonts by Fontworks                             |
| `star-fox-64-starfox64recomp` (#333)                                 | v1.0.3        | Windows               | Chiaro fonts by Fontworks                             |
| `tenchu-stealth-assassins-tenchu-sa-recomp` (#353)                   | v0.1.0        | Linux                 | Modified RecompOne fork; unlicensed own layer         |
| `vibecodekun-shantaerecomp` (#1881)                                  | v0.2.0        | Windows, Linux        | Unlicensed gbrecompiled fork                          |
| `kirby1237-parappatherapperrecomp` (#1864)                           | v0.1.1        | Windows, Linux        | Box art; recompiled BIOS backend code                 |
| `gran-turismo-4-playstation-2-gt4recomp` (#2579)                     | v1.2.5        | Windows (installer)   | Cover art and brand artwork                           |
| `def-jam-vendetta-playstation-2-def-jam-vendetta-recompiled` (#2561) | v0.6.2        | Windows (build kit)   | Game logo and settings-app artwork                    |
| `james2doyle-ffta-recomp` (#2824)                                    | v2.1          | Windows, Linux        | Box art of unknown provenance                         |

Notes:

- PaRappa and Muppet RaceMania ship the free PCSX-Redux OpenBIOS; FFTA ships
  the clean-room emibios. None ships a retail BIOS.
- Blast Corps, Mario Kart 64 and Star Fox 64 also publish Linux and macOS
  packages, but those wrap a second archive or a Flatpak; they are left for a
  separate decision. Mario Kart 64 and Star Fox 64 are GitLab-hosted.
- Snowboard Kids (HikariLucy) has published only a prerelease, so its listing
  recommends the beta channel.
- Mercenaries' former hold text also mentioned a separate launcher-lifetime
  question; that is not a download condition and is not restated here.

## Platforms added to listings already offering downloads

Release packages for missing platforms were found by probing the latest
release with each listing's asset naming, then listed the same way:

- `alexbeav-valkyrie-profile-recomp`: macOS Apple Silicon and Intel setup
  packages, v0.1.4, the same setup kit as the Windows and Linux ones
  (`184822f6eb29c0d845a87a8b10674d6c952c48fc35a6bfde850a50cf7abecd56`,
  `7fb9f58a30d63ca12f6736cc66f23ef839092fc8feb70dd89ae820cf72eee72a`).
- `blacklabelhq-medievilrecomp`: Linux and macOS Apple Silicon and Intel,
  v1.0.3 (`a66149be1478154418a5b50a36797e9c915daceabdcd657a7ee946877ed013b1`,
  `5eb36ba07a46d8b2fb12a1deb852d7c01446adf2bd13185e4d7cef2a621450c7`,
  `940548d4f9693c320cca5c93dfda3419dd7843c862493e4fbcec49e9403ba6a2`).
- The twelve CPS2Recomp listings: Linux and the universal macOS app, v1.5.0
  (`a341f8e8e8f5687cea85bc0dfdaff80bb3c7332a6c4a25e6970ef40cb7d5d0ab`,
  `b889d82c07681487a70271f46fe0e46db79b68c46d09487bf481f5257a5a7419`).
- `dabdavis-perfect-dark-dabs-mod`: Linux, v3.15.1
  (`12d03c8736cadfaf0649e00db9d44c638cfe1df7cbaf698c6007d40dd17fef73`).
- `goldeneye-007-n64-pc-port`: Linux listing download, v0.5.0, the same
  decompilation metadata as the Windows package
  (`011ee5acdd75028fa3af8cbad2aaade1f362aee89f17b43a15d1d1836e98ab92`).
- `keriew-augustus`: Linux AppImage and the universal macOS application, v4.0.0
  (`a0a0a0737666479ecb7b941eafe7dee991ddd7631fde9fb1944009cc0a09a82e`,
  `b567b7b41108a971ccfa91ab6d0523b25e306125e27f4a6e717660e959bc1078`);
  its bundled graphics are Augustus's own, with their licence.
- `lethal-guitar-rigelengine`: Intel macOS application, v0.9.1
  (`934f4de93795f3f9d985a366205ed7390848aefdaa300077303ae2e1cfb4f554`).
- `opencommunityedition-opence`: Linux, build-359
  (`55a5f551c013efd1b02bd977b807fbf70b0147d80daf9b40100929de7a60061d`).

Not added: the Omnispeak Linux package for Commander Keen 4–6 bundles Keen 4
shareware game data (`GAMEMAPS.CK4`, `EGAGRAPH.CK4`, `AUDIO.CK4`), which needs
its own shareware-licence decision. Einhänder, Street Fighter EX2 Plus and
Strider 2 Windows packages are build kits their listings already exclude.

## Held under the new model

| Listing (issue)                                                 | Basis                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pokemon-platinum-pokeplatinum-pc-port-lead` (#373)             | New finding: both packages ship `header.bin`, the original cartridge header with Nintendo's logo data |
| `brawl-recompiled` (#2434)                                      | The launcher embeds fighter portraits and the title font extracted from the game disc                 |
| `djultra64-clayfighter64` (#2830)                               | The in-game title announcement comes from an audio file of unknown origin                             |
| `dead-rising-2-case-west-recomp` (#1122)                        | Shader pre-warm data recorded from the game and recipes for patching its shaders                      |
| `dead-rising-2-case-zero-recomp` (#1121)                        | Same as Case West                                                                                     |
| `condemned-2-bloodshot-condemned2recomp` (#361)                 | A Xenia shader cache built from the game's own shaders                                                |
| `fatal-frame-mikupan` (#346)                                    | The game's English subtitle text and font textures exported from the game                             |
| `kingdom-hearts-chain-of-memories-gba-rekhcom` (#2586)          | 199 scene images captured from the game for its in-game gallery                                       |
| `lodilorenzo-cybermage-darklight-re-awakening` (#2836)          | Cockpit art derived from the game's own artwork, used in game                                         |
| `mercenaries-playground-of-destruction-kraftmacandchee` (#1672) | The current release package could not be identified for review                                        |

The other holds recorded on November 13 name bundled game data, prohibitions,
missing packages or technical conditions and were not changed by this batch.

## Android

Portcove has no Android host yet ([#410](https://github.com/boburning/portcove/issues/410)).
These upstreams publish Android packages, recorded but not reviewed: CPS2Recomp
(`CPS2Recomp-android.apk`), Augustus, Tails Adventure, Yakumo, Sin and
Punishment, Hybrid Heaven, FFTA and ReKHCoM.
