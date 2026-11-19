# MediEvil PSX setup and data ownership

The [official v0.1.4 release](https://github.com/alexbeavs-ps1-ports/medievil-recomp/releases/tag/v0.1.4) publishes four setup kits. Their ZIP bytes match the publisher's SHA-256 inventory and release manifest, which names source `918e3c2db5e0f2fca97cfd2998f607a1822573f2` and framework `852199db7cad6322f223ab6e588fedfd461de272`.

| Managed setup kit | Asset ID  | SHA-256                                                            |
| ----------------- | --------- | ------------------------------------------------------------------ |
| Windows x64       | 651837888 | `9ce3874f2bdd1ee92b6d91defcf86a35eeccebcb15c5b5fa2e121b22942ef4e2` |
| Linux x64         | 651837885 | `26097ec363f6850fbb7575ce2155c7841913f4317b844dca0683ecabc6864d2e` |

The reviewed kits require the retail USA SCUS-94227 disc and retail SCPH-1001 BIOS. The packaged `game.toml` accepts a split original and a legacy combined BIN, and disables HLE and OpenBIOS. Portcove's managed input is the complete two-track CHD. The first data track SHA-1 and size match [Redump entry 3472](https://redump.info/disc/3472) in its November 8 DAT, and its separate audio track supplies the second track in the original layout. The managed check covers the first data track and the track count.

Both managed kits expose the existing `generate` and `rebuild` path with `--no-toolchain-download` and the `psx-runtime` target. The generated `MediEvil_Recompiled` player, with `.exe` on Windows, uses `build-portcove` and `--no-launcher`. CMake stages the title's preloaded packages and the framework packages into `mods/bundled`. Each runtime version owns that bundle. The five split player paths retain installed and legacy user packages, staging and state.

The [tagged diagnostic guide](https://github.com/alexbeavs-ps1-ports/medievil-recomp/blob/918e3c2db5e0f2fca97cfd2998f607a1822573f2/docs/PLAYTEST_DIAGNOSTICS.md) and the packaged writer show default offline input recording. It saves session data, including starting memory cards and settings, under `saves/diagnostics` and writes `diagnostics-location.txt` beside the generated player. Both paths stay with player data. The writer can fall back to the system temporary directory when the normal directory cannot be created. That fallback needs separate player backup. The setup guide explains how to stop new recordings and review them before sharing.

The Intel and Apple Silicon ZIPs retain upstream setup with the architecture-matched build tools. Both setup hosts target macOS 11, and their game and BIOS generators target macOS 15. The generated player lives at `build-release/MediEvil_Recompiled` in the upstream kit. The managed Apple toolchain preparation has separate fixture evidence. The exact kits' SDL3 dependency resolution and complete generated Mac setup under Portcove's toolchain remain unobserved. The publisher reports a 307-frame Windows recording and strict replay. Portcove's release-selection fixture binds the exact Windows and Linux originals, artifacts and declared paths and uses a synthetic compatible successor. Actual title preparation, populated saves and gameplay remain separate.

## Standard v0.1.5 update

The [v0.1.5 release](https://github.com/alexbeavs-ps1-ports/medievil-recomp/releases/tag/v0.1.5)
at `24d3d2dbeab83b90bb7d76c05c92e677a703559f` continues the standard
line. It pins PSXRecomp `031868cc0170d260f1cb81c7cfe7ab68e8bbb424` and
recomp-ui `14799da234db1436306636b64436233a3ec6885c`. All four kits matched
their GitHub asset digests. Both managed archives keep SCUS-94227, the two-track
disc, retail SCPH-1001, and the generated `MediEvil_Recompiled` player.

| Route       | Asset ID  | Publisher SHA-256                                                  |
| ----------- | --------- | ------------------------------------------------------------------ |
| Windows x64 | 736802645 | `052e33fed7814bdc0c322865b6f1b2e0507c4c5b74dd7f28886097cb7a8d5e7b` |
| Linux x64   | 736802646 | `ffaaf9076c1dd5cb0b38e869dffbf439ec51cd4b09c5e8127c138919fa936774` |

The standard kit lacks the title-specific v0.1.4 playtest diagnostics package.
The retained path list still preserves `diagnostics-location.txt` and the
`saves` tree, including earlier diagnostic sessions and the standard kit's
replays. Keep any earlier system-temporary captures separately. The source
bindings for v0.1.4 and its qualification record remain valid for that kit.
The selection corpus now uses the observed v0.1.5 packages and a synthetic
successor with unchanged selectors.

Both Mac architectures retain upstream setup. Upstream lists Homebrew
OpenSSL, SDL3, FreeType and HarfBuzz for the v0.1.5 setup host. Portcove did not
run a kit, proprietary original, BIOS, title setup, or gameplay.
