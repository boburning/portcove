# Desktop sibling package guides

These package observations support upstream setup and discovery. The Windows
installation, registration, executable and data contracts retain their
existing owners. Package inspection covers the structures described below.
Native launch, original game data, saves and protected publication require
their separate evidence.

| Title                               | Inspected release                                                                      | Package observation                                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JGR Patch Pack #1859                | [0.73.5](https://github.com/JGRennison/OpenTTD-patches/releases/tag/jgrpp-0.73.5)      | Generic Linux AMD64 TAR.XZ 698299976 has an x86-64 player, glibc 2.28 and relative library file links. Universal Mac DMG 698300663 contains OpenTTD.app. The binary declares macOS 10.15 for Intel and 11 for Apple silicon.          |
| SDL Sopwith #1879                   | [2.9.0](https://github.com/fragglet/sdl-sopwith/releases/tag/sdl-sopwith-2.9.0)        | ZIPs 325276910 and 325276911 each contain one DMG. The selected Sopwith executable declares macOS 15 for Apple silicon and 13 for Intel.                                                                                              |
| Stunts HD #2862                     | [v1.5.22](https://github.com/mr-finster/stunts-hd/releases/tag/v1.5.22)                | Universal Mac ZIP 677258873 has Intel and ARM64 executable slices and a macOS 11 minimum. The app includes 14 symbolic links, including four framework directory aliases. Preserve the upstream bundle and original Stunts 1.1 setup. |
| Serious Sam Classic #2605 and #2606 | [1.10.7](https://github.com/tx00100xt/SeriousSamClassic/releases/tag/1.10.7)           | Linux TAR.XZ 225692057 contains separate x86-64 SamTFE and SamTSE players and local libraries. Intel Mac TAR.XZ 225692033 contains both players but they refer to the build machine for engine libraries.                             |
| Saboteur II #2722                   | [1.1](https://github.com/petarov/saboteur2/releases/tag/1.1)                           | ZIP 653008344 contains the Intel saboteur2 player and SDL2.framework. The existing original-content acquisition hold applies.                                                                                                         |
| Alley Cat #2827                     | [1.3](https://github.com/petarov/alleycat.exe/releases/tag/1.3)                        | ZIP 648453775 contains the Intel alleycat player and SDL2.framework. The existing original-content acquisition hold applies.                                                                                                          |
| Egg of Time #3740                   | [v1.2.1](https://github.com/power-pudu/egg-of-time/releases/tag/v1.2.1)                | Windows ZIP 727950066, Linux TAR.GZ 727950069 and Linux AppImage 727950065 match the published digests. Linux carries Zig and uses system Python and libcurl. The existing acquisition and registration hold applies.                 |
| JA2 Stracciatella #2583             | [v0.22.1](https://github.com/ja2-stracciatella/ja2-stracciatella/releases/tag/v0.22.1) | APK 300991620 contains ARM64, ARMv7, x86 and x86-64 native libraries. The existing ARM Linux AppImages and Apple silicon DMG retain upstream setup.                                                                                   |

The JGR, Sopwith, Stunts, Saboteur, Alley Cat and Egg of Time package hashes
match their GitHub asset digests. The older Serious Sam release assets have
no provider digest. Locally observed SHA-256 values are
`ac57ac0cf6c73dbee3aaf7830271b8a1c1949ae4a4c8783f0faafc18596bfb0b`
for Linux and `95621d0249fee078d7367d1ed21ad02574dcc5dc59de89a88a3843408d7eea63`
for Mac. Both Mac players have an absolute runner build directory in
LC_RPATH and expect SDL2 under /usr/local/opt/sdl2. The guide keeps that
package separate from the Linux route and leaves Mac discovery eligibility
for a compatible package.

The JGR Linux player can share configuration and content with other OpenTTD
copies. Its `-c` option can place write paths beside packaged assets. Keep the
setup user-owned while qualifying actual external profile roots and the
Linux archive lifecycle. JA2's x86-64 AppImage starts the launcher, which can
close while its game subprocess remains. Keep the launcher open in the
upstream route. Managed adoption needs proof of mount and process lifetime
when that launcher closes.

Egg of Time v1.2.1 builds a local native library from a player-owned ROM.
It keeps its private original, generated output, saves and mods beside the
extracted player or in the AppImage's separate data folder. Stable package
names identify the preparation routes. The three exact accepted ROMs and
the toolkit execution and recovery hold retain their prior scope.
