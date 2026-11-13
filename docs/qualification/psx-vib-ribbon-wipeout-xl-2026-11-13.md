# Vib-Ribbon and Wipeout XL managed kit contracts

Portcove builds the private Windows x64 and Linux x86-64 players from the
official v0.1.3 kits with the existing PSXRecomp adapter. The tagged
[Vib-Ribbon source](https://github.com/alexbeavs-ps1-ports/vib-ribbon-recomp/tree/2c59c02f2914b537675a7d5b2e8bb8c7c0be2bf9)
and [Wipeout XL source](https://github.com/alexbeavs-ps1-ports/wipeout-xl-recomp/tree/d3f2c63068728829eb9e4a6393f08f60f591af34)
match each kit's game and CMake declarations after newline normalization.
Both kits pin PSXRecomp `d5cae379db84bbce3696a61a89ed06989b18bed0` and recomp-ui
`14799da234db1436306636b64436233a3ec6885c`.

| Title             | Original input                                               | First data-track SHA-1                     | Retail BIOS | Generated player        |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------ | ----------- | ----------------------- |
| Vib-Ribbon (#495) | Europe SCES-02873, eight tracks, data track 15,680,784 bytes | `a2ba376167bda9ed03ab89a11ade12410d75ede7` | SCPH-5552   | `Vib_Ribbon_Recompiled` |
| Wipeout XL (#497) | USA SCUS-94351, twelve tracks, data track 86,045,568 bytes   | `5694008c30fa9896d17afdd6281e4bebb9f63953` | SCPH-1001   | `Wipeout_XL_Recompiled` |

Portcove requires a complete CHD, verifies the first data track and track count,
and gives the verified CHD to the generated player. Its other tracks remain in
the CHD. The title's network play rule also checks the mounted disc's TOC
fingerprint. This review establishes the catalog identity and package layout.
Native preparation, playback, network play, populated saves and gameplay were
unobserved.

The kit's root executable opens upstream setup. Managed Play invokes the
CMake `psx-runtime` output under `build-portcove` with `--no-launcher`.
Replays are stored under `saves/replays`. Keyboard profiles are written to
`keybinds.ini` and related input settings are in `input.ini` and `config.ini`.
The existing split-mods form keeps player-installed mods, staging, mod state
and texture packs with the player. Bundled mods stay with the verified build.

All four ZIPs for each title matched the publisher's SHA-256, passed full ZIP
CRC inspection, and had no case-colliding paths or symbolic links. Windows and
Linux game and BIOS bindings remain tied to their inspected kit hashes. The
selection fixtures use the complete observed inventory and a synthetic
compatible successor at `downloads.example.invalid`. The selector is
version-independent. Source applicability still requires the exact reviewed
artifact because the kit builds the registered disc and BIOS.

Intel and Apple silicon setup remains upstream-owned. The publishers report
a waiver for the Mac setup hosts' Homebrew OpenSSL, FreeType and HarfBuzz
dependencies. Portcove's managed Mac dependency and generated-player
qualification are separate. See the
[Vib-Ribbon release](https://github.com/alexbeavs-ps1-ports/vib-ribbon-recomp/releases/tag/v0.1.3)
and [Wipeout XL release](https://github.com/alexbeavs-ps1-ports/wipeout-xl-recomp/releases/tag/v0.1.3).
