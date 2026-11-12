# MGSM upstream Linux and Android packages

Inspected November 12, 2026. The [v0.1 prerelease](https://github.com/LeithSilver/mgsm/releases/tag/v0.1)
resolves to source `4e6d91ceadfb898322f535f82f24a394197d892b`. The Linux and
Android assets matched their GitHub SHA-256 values and the release's verified
`SHA256SUMS.txt`.

| Asset ID  | Package                            | SHA-256                                                            |
| --------- | ---------------------------------- | ------------------------------------------------------------------ |
| 651892639 | `MGS_Mobile_0.1_Linux_x64.tar.gz`  | `753af0a9eff4993d412d0373dc7b5fe3f2ad30f427178a988d3091a2490f998c` |
| 651892565 | `MGS_Mobile_0.1_Android_arm64.apk` | `525e5c2666944ede5dc798b2991f634d2db43cbf3b11d70a3937a372cb2e18ed` |

The Linux tarball holds `mgs_mobile` (ELF64 x86-64, mode 0755), its matching
`libSDL3.so.0`, the README and license notices. Both ELF files require glibc
symbols through 2.34. The executable's `$ORIGIN` runpath finds SDL3 beside
itself and the dynamic dependencies include the host's OpenGL library.
The bundled README requires deliberate `mgs_mobile --install <original>` before
launch and identifies the local game, settings and log paths. Upstream reports
trying this package under WSL. The new directory entry uses the Linux tarball
recommendation and preserves the existing upstream-owned preparation route.

The APK contains `libSDL3.so` and `libmain.so` for `arm64-v8a`. The [tagged build](https://github.com/LeithSilver/mgsm/blob/4e6d91ceadfb898322f535f82f24a394197d892b/android/app/build.gradle)
declares `org.mgsmobile.port` and API 24. The [Android picker](https://github.com/LeithSilver/mgsm/blob/4e6d91ceadfb898322f535f82f24a394197d892b/mgs_native/setup_android.cpp)
reads the selected original, copies the document to `setup.n-gage.tmp` for
the installer and removes that copy after the attempt. The [platform code](https://github.com/LeithSilver/mgsm/blob/4e6d91ceadfb898322f535f82f24a394197d892b/mgs_native/platform.cpp)
uses Android's app-specific external files directory when available, with
internal app storage as a fallback. Android remains upstream setup guidance
because the directory's execution platform enum has no Android entry.

The managed Windows definition keeps its creating-package, original-file and
player-data contract. Both sibling packages were inspected without running
the player or importing an original. Device install, APK signature continuity,
native gameplay and populated-data migration remain unobserved.
