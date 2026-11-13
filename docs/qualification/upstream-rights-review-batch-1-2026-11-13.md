# Upstream-hosted rights review, batch 1

Date: 2026-11-13. Policy: [rights basis for upstream-hosted packages](../CATALOG.md#rights-basis-for-upstream-hosted-packages).
Tracking: [#2926](https://github.com/boburning/portcove/issues/2926).

This batch re-reviews the listings whose `download_block_reason` rested only,
or mainly, on recompiled, translated or inherited game program code without
a grant. Of the 114 listings that held a download on November 13, 19 were in
that group; the others name bundled game data, restricted fonts or artwork,
unlicensed third-party components, explicit upstream prohibitions or other
technical conditions and stay held until their own review.

For each listing the latest published release asset was downloaded from the
upstream's own release location, hashed and listed; licence, notice and readme
files were read. Nothing was extracted into a runtime, executed or played. No
publisher `.sha256` file exists for these assets; downloads keep the existing
generic-download integrity rules.

## Offered again (tier 3)

Each package holds only the port's licensed layer, the recompiled game code
(recorded as a known limitation in the listing), openly licensed runtime
components and fonts, and the project's own icons. None bundles original game
data, and none of the upstreams forbids redistribution.

- `darkuni-afterburner-climax-recomp` (#4134): release v1.1.0, `AfterBurnerClimax-v1.1.0-win64.zip`,
  SHA-256 `bdfe2e331ea939abe20a42111a906d6a56637b694375cf07c8247d40fe06e5b4`.
- `darkuni-lode-runner-2009-xbla-rexglue` (#4216): release v1.0.1, `lode_runner-v1.0.1-win-amd64.zip`,
  SHA-256 `4ef8d9e9d00a2ca9794d61a612c26a677b65565bc4e5d4c812ba13029ca9f5c3`.
- `darkuni-outrun-arcade-recomp` (#4133): release v1.0.1, `outrun_arcade-v1.0.1-win-amd64.zip`,
  SHA-256 `d2e0656c4dab769fbbc2497cc268aa86b365388c05370d8369ea4ff76b67ec0e`.
- `darkuni-poker-smash-recomp` (#4122): release v1.0.0, `PokerSmash-v1.0.0-win64.zip`,
  SHA-256 `7fb28c34b23d8d6cf2e8fcc08646fdf23f3b7c47fc3b46f489d98cec9100df33`.
- `mgrayd-fable2pubgames-recomp` (#3995): release v0.1.0, `Fable2PubGames-Recomp-v0.1.0-win-x64.zip`,
  SHA-256 `5a3b56e239b97e5dea724b1f94b7f3e3f34d4a6bb20129ce940215c57c774a43`.
- `tony-hawks-project-8-recomp` (#1125): release v0.3.0, `Project8Recomp-v0.3.0-windows-x86_64.zip`,
  SHA-256 `f255842b916a98c8188259fa3da5931bcea639b6c656e82d26f8b274b69be436`.
- `pilotwings-64-dgv-recomp` (#1275), Windows: release v0.1.1, `Pilotwings64Recomp-0.1.1-windows-x64.zip`,
  SHA-256 `94453fb09ca4ef2a98f5f5addfa03385c3de96d89d2cecb21591f44c741b31e8`.
- `pilotwings-64-dgv-recomp` (#1275), Linux: release v0.1.1, `Pilotwings64Recomp-0.1.1-linux-x86_64.tar.gz`,
  SHA-256 `b4849feb348f68918daaaefd226cb1824f4512eaf5140095e28e765807749492`.
- `wave-race-64-recomp` (#553), Linux listing: release v1.0.2, `WaveRace64Recomp-1.0.2-linux-x86_64.tar.gz`,
  SHA-256 `5ea07206731b1afde10f52909443a50b64b6ebd113634d383a5538f86437e60f`.

Notes recorded with these packages:

- The four darkuni Xbox 360 players ship the BSD-3-Clause ReXGlue runtime.
  After Burner Climax and OutRun carry the author's own runtime patches from a
  repository without a licence file; this is treated as the same author's code
  in an MIT package, not an unlicensed third-party fork. Their readmes point to
  a ReXGlue licence text that the packages do not include.
- Pilotwings 64 and Wave Race 64 list open points in their own
  `THIRD_PARTY_NOTICES.md`: the RecompFrontend base, now covered by the upstream
  GPLv3 grant for the pinned tree; Microsoft's DirectX Shader Compiler
  redistributable terms; and two RT64 shaders adapted from Shadertoy under CC
  BY-NC-SA 3.0. These are licensed code whose conditions apply to
  redistributors; Portcove does not re-host, and the same RT64 code ships in
  N64 recompilations Portcove already offers. Their fonts are Lato, Noto Emoji
  and PromptFont under the OFL. Wave Race 64's unlicensed decompilation
  supplies only names and layout, which the policy treats as code.
- Tony Hawk's Project 8's readme asks players not to redistribute their own
  generated sources or game files; it does not restrict the publisher's own
  release archive.
- Wave Race 64's Windows route stays its existing prepared-player integration.

## Still held

| Listing                                                             | Basis kept                                                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `darkuni-chocobo-dungeon-recomp` (#4131)                            | The executable embeds an icon of unknown origin that looks like game pixel art; the same icon is in the next three                            |
| `darkuni-mylifedarklord-recomp` (#4121)                             | Same embedded icon                                                                                                                            |
| `darkuni-mylifeking-recomp` (#4120)                                 | Same embedded icon                                                                                                                            |
| `darkuni-target-terror-wii-recomp` (#4178)                          | Same embedded icon                                                                                                                            |
| `eternal-darkness-sanity-s-requiem-eternal-darkness-recomp` (#2570) | Bundles a pipeline cache recorded from the game's rendering (`res/initial_pipeline_cache.db`)                                                 |
| `sonic-free-riders-recompiled` (#1450)                              | Bundles shader packs taken from the game; upstream's packer says they are never distributed                                                   |
| `blizz127-parasite-eve-decomp-port` (#1865)                         | Links code derived from Sony's Psy-Q SDK; upstream holds its own binaries for that reason                                                     |
| `eandis-sdoj-recomp` (#1880)                                        | The port's own layer has no licence, and its icon appears to be game character art                                                            |
| `nevercookfirst-dimensionsrecomp` (#1817)                           | Bundles game text tables, a game archive and modified game files, plus unlicensed tools                                                       |
| `tekrantgaming-muppet-racemania-recompiled` (#4130)                 | The launcher embeds the game's logo, and the port's own layer has no licence                                                                  |
| `elmasas-lcs-recomp` (#1836)                                        | Deferred: the content appears eligible, but the listing declares no platform and the latest release (v0.1.6) differs from the reviewed v0.1.7 |

Each held listing can be reconsidered when its upstream removes or licenses
the named content.
