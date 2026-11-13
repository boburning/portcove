# ReflectionHLE Mac app-bundle routes

The existing nine ReflectionHLE records share the official universal Mac
package. Each keeps its own original DOS edition, file requirements and
upstream game/version picker. Intel and Apple silicon use the same archive.
Windows and Linux retain their existing package selectors and player-relative
data paths.

The [20260606 release](https://github.com/ReflectionHLE/ReflectionHLE/releases/tag/release-20260606)
offers `reflectionhle-macos-universal2-20260606.tar.xz` (asset 440437160,
4,800,280 bytes). Its SHA-256 matches the publisher's
`4169e031f3bce2712cc5d89b15af4697b2add8f371107db3e0dcfdb2e207e24e`.
The archive contains a versioned wrapper with the license and
`reflectionhle.app`. It has no archive links. The publisher's executable is
`reflectionhle.app/Contents/MacOS/reflectionhle`. Its Mach-O headers declare
macOS 10.13 on Intel and 11 on Apple silicon. Both slices list system
libraries and frameworks. These are header observations.

[The tagged source](https://github.com/ReflectionHLE/ReflectionHLE/blob/74f07efcc40142a5727caacebec848c48b141eca/src/backend/filesystem/be_filesystem_app_paths.c)
honors `-datadir . -cfgdir .` on Mac. NativePortable capability 26
launches from the installed folder beside the bundle and resolves declared
persistent paths there. A supported outer wrapper becomes the staged
installation root. Changing the wrapper name on a compatible release does
not change the persistent path contract. Core retains the app contents,
checks its reviewed executable layout and refuses TAR links on this Mac
route. The same Linux file-link handling and older reader routes remain
available.

The stable archive selector was checked against the current package name
and a synthetic compatible successor, with other archive names refused.
The earlier `release-20240926` archive has no GitHub asset SHA-256. Its
name alone supplies no acquisition or runtime evidence.

The official Android APK (24,456,760 bytes, SHA-256
`183b8b6a45b9e2306a4ad5297eb65a6580727a950a0e563e77ebf1a1813a1439`)
contains ARM64, ARMv7, x86 and x86-64 libraries. The tagged Android code
keeps configuration and version data in app-specific `appdata` and may
request broad storage access for originals. The Android guide describes
upstream setup and leaves installation, updates and backups with the player.

Archive inspection and inert fixtures do not establish native launch,
original-game selection, gameplay, or compatibility with populated saves.
