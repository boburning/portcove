# Ironwail and vkQuake Linux packages

[Ironwail #2698](https://github.com/boburning/portcove/issues/2698) and
[vkQuake #2697](https://github.com/boburning/portcove/issues/2697) retain their
Windows packages, fixed launch arguments and listed data. The Linux routes
use these official packages and the same classic `id1` original-data mapping.

| Reviewed asset                                                                                      |  Asset ID | Publisher and observed SHA-256                                     |
| --------------------------------------------------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| [`ironwail-0.8.2-linux-x64.tar.gz`](https://github.com/andrei-drexler/ironwail/releases/tag/v0.8.2) | 510564613 | `fcb0219d13c50f64728892f0558b4761ba5578319a6cc01021fad981c6333aa5` |
| [`vkQuake-1.37.0-x86_64.AppImage`](https://github.com/Novum/vkQuake/releases/tag/1.37.0)            | 632507389 | `abf8546316997d16b86fea242d90afc8203fecb9e5016d6262f7bec1f36a5a9e` |

Ironwail's versioned wrapper contains the native `ironwail` executable and
`ironwail.pak`, plus four documentation files. The ELF uses OpenGL and SDL2
and links libcurl, libvorbisfile and libmpg123. The inspected executable
requires glibc 2.29. The selected fixed arguments are `-basedir . -noaddons`.
The explicit base directory skips store discovery and the Nightdive migration.
The provider and retained installer both require the versioned Linux x64
TAR.GZ name.

vkQuake ships a type-2 AppImage. Its SquashFS `AppRun` points directly to
`usr/bin/vkquake`. The ELF uses a relative `$ORIGIN/../lib` path for included
SDL3, Vulkan and audio libraries and requires glibc 2.34. The host still needs
a Vulkan driver and AppImage FUSE support. The selected fixed arguments are
`-basedir . -nosteam -userdir .`. The explicit base directory skips the store and picker
path that reads and writes `basedirs.txt` in the SDL preference directory.
The reviewed executable sets its base and user directories to the working
directory. The extra `-userdir .` keeps that location on compatible builds
that enable account-based user directories. Portcove keeps the AppImage intact
and checks the mount location and adjacent portable profile directories before
launch. The normal managed launch filters ambient AppImage extraction switches.

Ironwail reads the current account home and falls back to HOME when no
account home is available. It uses `.ironwail` for external settings and
game data. Portcove checks that root against its library and leaves the
profile in place. Back up the external Ironwail profile separately.
vkQuake uses the managed working folder for `id1`, `vkQuake.cfg` and
`history.txt`. Store-selected, custom, and multiuser configurations retain
upstream setup and replacement.

Package inspection and controlled successor fixtures establish the declared
Linux layout and selector. Retail gameplay and populated-save compatibility
remain unobserved. The existing vkQuake Mac setup and Windows ARM64 guidance
remain upstream-owned. Ironwail upstream documents its OpenGL 4.3 requirement
and current Mac support limitation.
