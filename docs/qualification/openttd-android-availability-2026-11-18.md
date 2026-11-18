# OpenTTD Android community availability

Observed November 18, 2026 UTC. Canonical owner: [#8081](https://github.com/boburning/portcove/issues/8081).

The community Android implementation is [pelya/openttd-android](https://github.com/pelya/openttd-android), repository ID `17780277`. Official desktop OpenTTD has repository ID `128430621` and owner #2716; JGR Patch Pack keeps owner #1859. Complete issue searches for the Android repository URL and `org.openttd.sdl` found no previous Android owner before intake. This record adds an upstream setup reference, with no operational catalog definition.

## Publisher routes

The [publisher Google Play listing](https://play.google.com/store/apps/details?id=org.openttd.sdl) names pelya and showed an update date of May 8, 2025. Its description links publisher sources and previous releases and retains a maintenance limitation. The observation establishes an available store listing, not an installed current build, exact current version or continued maintenance promise.

The [OpenTTD community Android build guide](https://wiki.openttd.org/en/Community/Patches/Compiling%20and%20installing%20the%20unofficial%20Android%20port) identifies the unofficial implementation, different APK signing keys and its historical `Android/data/org.openttd.sdl` data location. Its old build instructions are not proposed as a current downstream build route. Actual save/config/content locations and access depend on the installed app and Android version. Preserve/export them before changing or uninstalling the app.

## Static historical artifact

Publisher release `1.9.1.77`, published April 26, 2019, contains APK asset `12259940`, `OpenTTD-1.9.1.77.apk`, 55,045,192 bytes. The inspected download's SHA-256 is `48ad5e2cba167941d99aa4ac1a1e0a3a4f05bffa92c3f2622e7b2485eab58a4f`. Publisher metadata has no expected digest; this is observed identity, not independent digest authority.

The ZIP has 136 entries. Native `libapplication.so` and SDL/runtime companions occur under `lib/arm64-v8a`, `lib/armeabi-v7a`, `lib/x86` and `lib/x86_64`. No APK was installed or executed. No APK signature, current Android compatibility or current Play-build identity was established. The historical APK is not recommended as the current app.

Source branch `14` was `a3163e003f86ff2b4e56e739456b44e2bd34f5b0`; default `master` and that branch do not prove the current store build. The existing prepare-port checkpoint supplied canonical candidate identity; the accepted record reuses the already-admitted underlying Transport Tycoon Deluxe artwork rather than claiming a new image match.

## Platform and operation scope

Android receives a publisher installation/setup link and external ownership explanation. No Portcove-managed Android acquisition, installation, launch, replacement, backup, rollback or removal is offered. Portcove's current `Platform` host enum has only Windows x86-64, Linux x86-64, Intel Mac and Apple Silicon. The new descriptive listing therefore omits that desktop platform array; it does not assign the Android app to a desktop platform or extend the host enum. Its name, summary and guide identify Android explicitly.

Windows, Linux, Intel Mac and Apple Silicon retain the separate official desktop implementation. Desktop receipts do not qualify this Android app. The operational catalog must remain byte-identical; generated directory/projection changes are descriptive availability only.

Native Android app setup, gameplay, save/export/restore, audio and physical inputs remain not run. They require an authorized device or maintained Android host and the exact publisher app. Those missing observations are not represented as passed checks or managed capabilities.
