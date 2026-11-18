# OpenTyrian2000 Mac profile boundary — November 18, 2026

Owner: [#1861](https://github.com/boburning/portcove/issues/1861).

The upstream setup reference applied the Linux XDG profile location to the Mac
app. The current publisher Mac package instead reports its sandbox home as
`~/Library/Containers/com.AnV.Software.opentyrian2000/Data`. The reference now
separates the two platforms and asks players to locate and back up their actual
`tyrian.sav`, `tyrian.cfg` and `opentyrian.cfg` before replacing the app.

## Exact artifact and source scope

Publisher repository `andyvand/opentyrian2000`, repository ID 800841274, release
`3.0.0-SDL3`: `opentyrian2000-macOS.zip`, asset 241882108, 6,337,025 bytes,
updated March 29, 2025. Observed SHA-256:
`1cc51134dea33fab363048d672cbad3b199df45d2a1bf78b7ae9f0c7afe54a60`.
The publisher asset has no expected digest. This hash identifies the inspected
bytes and supplies no managed-acquisition authority.

The ZIP has 106 entries, 15,663,360 decoded bytes, and three contained SDL3
framework symlinks. Its player is
`opentyrian2000.app/Contents/MacOS/opentyrian2000`, SHA-256
`665da59e3313d7fb48fef15e65f154637a635ddb76881fca19578786d508a199`,
with Intel and Apple Silicon Mach-O slices. All 75 included game-data files
match the retained publisher-linked freeware Tyrian 2000 inputs byte for byte.
The [earlier Linux/source receipt](https://github.com/boburning/portcove/issues/1861#issuecomment-6897883060)
retains its original scope.

The release tag's older source still described an XDG path. It does not establish
the source revision of the later Mac asset. Current upstream
[`config.c`](https://github.com/andyvand/opentyrian2000/blob/49047938d80a6b5db791b9595e96f8737c8d13bf/src/config.c)
uses `getHomeDir()` on Mac, and
[`macos-bundle.mm`](https://github.com/andyvand/opentyrian2000/blob/49047938d80a6b5db791b9595e96f8737c8d13bf/src/macos-bundle.mm)
returns `NSHomeDirectory()`. This agrees with the executed package's home-directory
message; it is not a claim that the package was built from that commit.

## Failed native observation retained

[Run 44246755584/1](https://github.com/boburning/portcove/actions/runs/44246755584/attempts/1),
controller `de37af28b9983c91d43bda0e18c4e60e40cf8aec`, executed ordinary product
`b7abf3710d9bf75352baa6737e0602fb9d296cb7` on fresh hosted Macs. Apple Silicon
job 134607455359 used macOS 15.8.2; Intel job 134607455634 used macOS 15.7.9.
Each exact player reported the sandbox home above and its corresponding ARM64
or X86_64 architecture. Core tracked normal exit 0, and cleanup positively
observed owned process exit and released admission.

Both probes then failed because the harness expected settings in its private
Linux-style XDG folder. That is a failed observation, not passing settings or
removal-preservation acceptance. The inspected Apple Silicon capture shows the
Eclipse intro screen; it does not establish a menu or gameplay. The initial
probe did not establish that the actual sandbox container was absent before
launch. Do not infer a pristine profile or preservation from that run.

A separate controller repair refuses an existing publisher container, observes
the actual settings location, and records container link targets without
traversing shared folders. It also allows the two intro logos finite extra time.
Its execution and image inspection are separate acceptance work; this guide
correction does not claim that they passed.

## Quit behavior remains operation-specific

A second probe at controller `6f1b25af03b9d74d4c5a5cdbe53c1a466dc9d439`
reached the actual menu on Apple Silicon, but Command-Q again exited without
creating the expected settings file. That is another failed settings observation.
Current upstream [`keyboard.c`](https://github.com/andyvand/opentyrian2000/blob/49047938d80a6b5db791b9595e96f8737c8d13bf/src/keyboard.c)
handles SDL quit by calling `exit(0)` with a cleanup TODO, while
[`varz.c`](https://github.com/andyvand/opentyrian2000/blob/49047938d80a6b5db791b9595e96f8737c8d13bf/src/varz.c)
contains the normal `JE_tyrianHalt` settings write. This is a source-supported
explanation of the observed difference, not identification of the binary's build
commit or proof that existing saves were lost.

The reference asks players to use the game menu's Quit control and check their
actual files before backup or replacement. A further native probe uses the title
menu's Escape exit through that same cleanup path and retains the settings-write
assertion. Its passing result remains unestablished in this document.

## Offered operations and remaining limits

This remains an upstream/player-owned package and non-owning setup route.
The guide change adds no operational catalog entry, managed update, backup,
rollback, removal authority, qualification promotion or release commitment.
Windows and Android retain their existing package-specific instructions. Linux
retains its separately observed XDG contract. Mac Archive Utility remains the
recommended extraction route to preserve the framework links.

Managed acquisition still requires an attributable expected desktop digest and
the appropriate writer, replacement and recovery contract. Audio, physical
controls, Mac populated-save restoration and Tauri picker behavior are not
established by this correction.
