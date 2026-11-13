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
| `def-jam-vendetta-playstation-2-def-jam-vendetta-recompiled` (#2561) | v0.6.2        | Windows (setup kit)   | Game logo and settings-app artwork                    |
| `james2doyle-ffta-recomp` (#2824)                                    | v2.1          | Windows, Linux        | Box art of unknown provenance                         |

Package SHA-256 values, per reviewed release asset:

- Chocobo's Dungeon `ChocoboDungeon-v1.1-win64.zip` `c625684547298f4c88992043fa8e90aa4e06d1db9757f5eac69adb6d565695fc`
- My Life as a Darklord `MyLifeAsADarklord-v0.2-win64.zip` `09dc2f18f01b7d2a3e9740fa9c63c6b57c461edebeef09d7907a7edbcc811768`
- My Life as a King `MyLifeAsAKing-v0.5-win64.zip` `2c9a363be8f40b575b6eee75496fbab071b65d6e6bd321d99f13337bef18abf1`
- TARGET: Terror `TargetTerror-v1.0-win64.zip` `1fd46eb9c72926c2cd2255f931eaf68a965691e426e2c693b10698d6b793e7b8`
- Muppet RaceMania Windows `7fb65ea220bd9237e14654dd60dc4533e3e06065f947c4cf0cbf9f7c8f850a31`, Linux AppImage `cd601da460c5c7a28ab3133c5361619d0089bf897de822ff579043dc85db720b`
- SDOJ Windows `fb24adc74da41df7f781baa03a8882ece55418c7ae97a127207c2ad19f689a88`, Linux `23783276a75c5591429ce0afcabc63dd48e73099f7c812dc95ad625c3bafdc9b`
- Banjo-Tooie Windows `cc34db186c61b432505fd2ce38c0686edcc6283a5272a4eb567c85b17cdce53b`, Linux `9b63b6304940e771d79500d0e2bac7aecca4c47dd844b1de8ab93ac950971da4`
- Snowboard Kids (cdlewis) Windows `bbe02ea0f6388323a7387289ef6c92d4db145d3d1f3bd47e4e4622273a4b18a6`, Linux `90f551e35f02a6fcae298f88c9d7e7c97b62adf80a153362073f079a53dab890`, universal macOS `8d019d64117d1a379561ddff849445cdc477a5a749fd192eee88568586537243`
- Snowboard Kids (HikariLucy) Windows `7c0b49ed8513efc80044198b7941a78d1397e4e882ffb49be4a4398d7a0bcf38`, Linux `5f325afc55c597c7108567ccfc2007eac06c664c7e7d979f6b39d38bd76bef3c`
- Geometry Wars 2 Windows `7a3862ab73e5f5d9536d58c5eb9c15cad89a492d9266d6ae399089140d1b5b08`, Linux `15f9b5160b778bd9cd67c1ef94e95fd6831e276459b185155144f38f6d0cc7ed`
- Hard Corps Windows `197e5e2b9f75525f39e5db32a6d6294097b7b280e65cea804e899462129c4710`, Linux `98842755d58e1e313fbc012b51dc8752fa9f45aac27ec13a2e39266f6e406112`
- Crackdown Windows `fa1a6f9a46a3d9ea213a9898b86f11fcc35c855ddf6e42322e81ded15550b421`, Linux `e5468433e2c8fce57e68202b606f68148c7c84eb76b3c51254139b5e84245400`
- Blast Corps Windows `811d2831c566b68be61e3fca67972262d9e72598de3f76f576855462c92c07eb`
- Hybrid Heaven Windows `8d43773f0d6cab6d89394da30c95339861dfa268ebfd8edb29921418245d1f9b`, Linux `049550f44e42eac8f4ddc03b818d2a6581d55283b2bd44055f312e9a36ce76e1`
- Mario Kart 64 Windows `4b41226ad7d4c6012878194fa88fe1a83c1fa8f425dfbaa2a7ea87eb01c1c2b4`
- Rayman 2 Windows `2209b4b349436dbec0f01eea7d15c0077c229100a42ce6ea938805ef310f9257`, Linux `0a51304278758244dc5b7f10f66d865a5496ce68ec781cd67e89ed2ede49804a`
- Super Smash Bros. Windows `366621cfe8f02b91eed0098742194088a4ebb0ff885db771b843bca3d17e5a2c`, Linux `e9a77449acaf9a038478e9ae9956e881854e935a9d0a26aabb26992a4a3c0b02`
- Star Fox 64 Windows `768c18b0aeb325a0102f722338f09a270a76eeebea29154764147a93d0bde530`
- Tenchu Linux ZIP `c223d58a0104d11dae3692d1dcab4264db1c2fc62416c73a3dac9b395eea7576`
- Shantae Windows `d85e17f17b2f25415ae5be237c29a3eba7b48b96d53a591b84aa1e84fa76a3e3`, Linux `e879356a9b25acb54e88ee40ab1b1b15bd21208ad3f39856c016d86c5e004040`
- PaRappa Windows `27a91511d7011b93ac7b182db65f441ec77ff20ff69052e6261574f9143143ec`, Linux `db88c6c4ccabc471ed36b4f235c4cce7bb9dcf75f0100eb425afd741fbad9a6d`
- Gran Turismo 4 installer `556e7725d11146f1f79613814fbf961e1299000bd56df7c8831a324213003a74`
- Def Jam Vendetta setup kit `ff779cecd2051a448ee24504da1dc8339542072469d61d65e682e17a090c6a83`
- FFTA Windows `67b20afd742c43556abc46693ab41b9a38fc98f4ff976f6902da5d34eab6ebb2`, Linux AppImage `fcefc2cbd00a50dab2fcd99419c3dedeb953e4234406d5b01310f678f7369d14`

Notes:

- PaRappa and Muppet RaceMania ship the free PCSX-Redux OpenBIOS; FFTA ships
  the clean-room emibios. None ships a retail BIOS.
- Blast Corps, Mario Kart 64 and Star Fox 64 also publish Linux and macOS
  packages, but those wrap a second archive or a Flatpak; they are left for a
  separate decision. Mario Kart 64 and Star Fox 64 are GitLab-hosted.
- Snowboard Kids (HikariLucy) has published only a prerelease, so its listing
  recommends the beta channel.

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
  Both were listed, the AppImage through its SquashFS image; their bundled
  graphics are Augustus's own, with their licence.
- `lethal-guitar-rigelengine`: Intel macOS application, v0.9.1
  (`934f4de93795f3f9d985a366205ed7390848aefdaa300077303ae2e1cfb4f554`).
- `opencommunityedition-opence`: Linux, build-359
  (`55a5f551c013efd1b02bd977b807fbf70b0147d80daf9b40100929de7a60061d`).

Not added: the Omnispeak Linux package for Commander Keen 4–6 bundles Keen 4
shareware game data (`GAMEMAPS.CK4`, `EGAGRAPH.CK4`, `AUDIO.CK4`), which needs
its own shareware-licence decision. Einhänder, Street Fighter EX2 Plus and
Strider 2 Windows packages are local build kits their listings already exclude;
Def Jam Vendetta's setup kit is offered because its listing already describes
that route.

## Held under the new model

| Listing (issue)                                                 | Basis                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pokemon-platinum-pokeplatinum-pc-port-lead` (#373)             | New finding: both packages ship `header.bin`, the original cartridge header with Nintendo's logo data, beside a mostly empty 1,584-byte `firmware.bin`  |
| `brawl-recompiled` (#2434)                                      | The launcher embeds fighter portraits and the title font extracted from the game disc                                                                   |
| `djultra64-clayfighter64` (#2830)                               | The in-game title announcement comes from an audio file of unknown origin                                                                               |
| `dead-rising-2-case-west-recomp` (#1122)                        | Shader pre-warm data recorded from the game and recipes for patching its shaders                                                                        |
| `dead-rising-2-case-zero-recomp` (#1121)                        | Same as Case West                                                                                                                                       |
| `condemned-2-bloodshot-condemned2recomp` (#361)                 | A Xenia shader cache built from the game's own shaders                                                                                                  |
| `fatal-frame-mikupan` (#346)                                    | The game's English subtitle text and font textures exported from the game                                                                               |
| `kingdom-hearts-chain-of-memories-gba-rekhcom` (#2586)          | 199 scene images captured from the game for its in-game gallery                                                                                         |
| `lodilorenzo-cybermage-darklight-re-awakening` (#2836)          | Cockpit art derived from the game's own artwork, used in game                                                                                           |
| `mercenaries-playground-of-destruction-kraftmacandchee` (#1672) | The current release package could not be identified for review; its former note about a separate launcher-lifetime question is not a download condition |

The other holds recorded on November 13 name bundled game data, prohibitions,
missing packages or technical conditions and were not changed by this batch.

## Android

Portcove has no Android host yet ([#410](https://github.com/boburning/portcove/issues/410)).
These upstreams publish Android packages, recorded but not reviewed: CPS2Recomp
(`CPS2Recomp-android.apk`), Augustus, Tails Adventure, Yakumo, Sin and
Punishment, Hybrid Heaven, FFTA and ReKHCoM.
