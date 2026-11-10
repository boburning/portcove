# NHL ’94 Linux and reviewed native package layouts

NHL ’94 now has a separate managed Linux x86-64 runtime with the existing
working-directory data contract. Its stable selector resolves the official
Linux TAR.GZ and selects `nhl94`. The player owns the original cartridge
picker and remembers the ROM path. Keep that source outside the managed
runtime. Portcove preserves the six default data paths already declared for
Windows. Keep custom data paths with a separately prepared copy.

The two inspected Linux executables are AMD64 ELF, with an SDL2 dynamic
dependency and a glibc 2.34 floor. The release tags share the same
`native/main.c` and Pulseman gitlink. The upstream profile helper keeps the
Linux working directory. Under macOS, it changes to Application Support
only for a bundle started with `/` as the working directory, as in a Finder
launch. Both universal ZIPs have framework links and the managed extractor
refused them. macOS remains upstream setup.
[NHL ’94 source](https://github.com/1nputs/ninety-four/blob/v0.3.6/native/main.c).
[Pulseman profile helper](https://github.com/1nputs/pulseman/blob/528358d9db88fb5bce21dd156b1b6c92f053cbb9/src/platform/sdl2/sdl2.c#L2896).

## Paired archive observations

For each row, the offline managed archive observer verified the exact size
and SHA-256 from GitHub release metadata and observed the same staged layout
for both releases. Twelve platform routes across eight records now use the
reviewed layout gate. Eleven were already managed.

| Package and platform     | Earlier asset ID | Successor asset ID |
| ------------------------ | ---------------- | ------------------ |
| fheroes2 Windows x86-64  | 462232934        | 725141995          |
| fheroes2 Linux x86-64    | 462232870        | 725141870          |
| fheroes2 Intel macOS     | 462232740        | 725141079          |
| Ironwail Windows x86-64  | 335304809        | 510410102          |
| Ironwail Linux x86-64    | 337051442        | 510564613          |
| vkQuake Windows x86-64   | 534541500        | 632507386          |
| OpenMoHAA Windows x86-64 | 272121832        | 279608996          |
| NHL ’94 Windows x86-64   | 662443383        | 666486981          |
| NHL ’94 Linux x86-64     | 662443262        | 666486887          |
| z2rs Windows x86-64      | 628576299        | 664693894          |

OpenMoHAA's base game and two expansions share the Windows package layout
and keep their distinct launchers and original-data paths. The Linux ZIPs
have 0644 program modes. The current layout check runs before the existing
OpenMoHAA profile validates and enables the launchers, so those Linux
archives cannot use this declaration. The older Mac ZIP has a different
name outside the current exact selector. The existing OpenMoHAA Unix and
vkQuake Linux AppImage operations retain their current scopes.

Release evidence comes from
[fheroes2 1.1.17](https://github.com/ihhub/fheroes2/releases/tag/1.1.17) and
[1.1.18](https://github.com/ihhub/fheroes2/releases/tag/1.1.18),
[Ironwail 0.8.1](https://github.com/andrei-drexler/ironwail/releases/tag/v0.8.1) and
[0.8.2](https://github.com/andrei-drexler/ironwail/releases/tag/v0.8.2),
[vkQuake 1.36.0](https://github.com/Novum/vkQuake/releases/tag/1.36.0) and
[1.37.0](https://github.com/Novum/vkQuake/releases/tag/1.37.0),
[OpenMoHAA 0.82.0](https://github.com/openmoh/openmohaa/releases/tag/v0.82.0) and
[0.82.1](https://github.com/openmoh/openmohaa/releases/tag/v0.82.1),
[NHL ’94 0.3.5](https://github.com/1nputs/ninety-four/releases/tag/v0.3.5) and
[0.3.6](https://github.com/1nputs/ninety-four/releases/tag/v0.3.6),
and [z2rs 0.5.2](https://github.com/troyedwardsjr/z2rs/releases/tag/v0.5.2) and
[0.6.0](https://github.com/troyedwardsjr/z2rs/releases/tag/v0.6.0).

z2rs has matching observed Linux and Mac archive layouts. Upstream's effective
profile and custom save path can be relative to the working directory. Those
routes remain upstream setup until their data ownership is enforceable for
managed replacement. The upstream Android APK keeps its copied ROM and saves
in app-private storage. Android setup guidance is separate from the four
desktop platform values supported by the discovery projection.
[z2rs desktop profile](https://github.com/troyedwardsjr/z2rs/blob/v0.6.0/crates/z2-native/src/config.rs).
[z2rs Android guide](https://github.com/troyedwardsjr/z2rs/blob/v0.6.0/guide/android.md).

Static archive and source observations establish the selected topology and
profile rules. Inert fixtures exercise install, compatible successor selection,
default-path preservation, and rollback. Native play, populated-save
compatibility and protected definition publication retain separate acceptance.
