# z2rs direct desktop packages and profile safety

The official direct player now has managed Windows x86-64, Linux x86-64,
Intel Mac and Apple Silicon Mac routes. The Windows selector is unchanged.
The three new stable selectors choose the platform-specific official archive.
The managed player opens the user's supported USA NES ROM in place when
dropped into its window. The original remains outside the
replaceable runtime. The separately prepared launcher and Android app keep
their upstream setup and profile ownership.

## Package evidence

The earlier and successor archives below match their publisher size and
SHA-256 and produce the same reviewed layout for each platform. The observations
used the managed archive reader without running the player.

| Platform          | v0.5.2 asset ID | v0.6.0 asset ID |
| ----------------- | --------------- | --------------- |
| Windows x86-64    | 628576299       | 664693894       |
| Linux x86-64      | 628576326       | 664693912       |
| Intel Mac         | 628576292       | 664693896       |
| Apple Silicon Mac | 628576294       | 664693895       |

The Linux archives contain a direct AMD64 ELF program. Both examined
executables import glibc through 2.39, `libudev.so.1`, `libasound.so.2` and
`libgcc_s.so.1`. The Mac archives contain both a loose `z2rs` and
`z2rs.app/Contents/MacOS/z2rs` inside the package wrapper. The two copies
have different digests. Core selects the exact bundle member through at most
one wrapper and verifies the Mach-O architecture. The inspected bundle
executables declare minimums of macOS 10.12 for Intel and macOS 11 for Apple
Silicon. These are binary deployment targets. Actual host and gameplay
qualification remain separate.
[Earlier release](https://github.com/troyedwardsjr/z2rs/releases/tag/v0.5.2).
[Successor release](https://github.com/troyedwardsjr/z2rs/releases/tag/v0.6.0).

## Profile boundary

Both inspected sources choose nonempty `XDG_DATA_HOME/z2rs` first. Windows
then checks `APPDATA/z2rs`. macOS uses `HOME/Library/Application Support/z2rs`,
and the other HOME fallback is `HOME/.local/share/z2rs`. Upstream's last
fallback is the working-directory `.z2rs-data`. The default root contains
`z2-native.json`. The player can redirect gameplay saves and diagnostics using
`data_dir_override` while the settings remain at the default root.

Core checks the selected child environment before launch and reads only a
bounded regular settings file. It holds relative roots, overlap with the
library, ambiguous settings and a custom data-directory override. Players
can retain their custom settings and use a separate upstream-managed copy.
Windows and Linux preserve the fixed managed fallback. Mac uses an absolute
personal profile and keeps the bundle free of fallback writes. External
files stay under player ownership. Automatic version-change snapshots cover
the managed fallback only. The launch check observes the external settings
before spawning the player. The player retains responsibility for concurrent
changes to its external profile.

The new policy requires NativePortable 20. The matching older Windows
creation keeps its retained manifest, selector and fallback. A current Core
can apply the same guard to that exact layout at launch. Existing archive
and rollback identity checks retain their original responsibilities.
[Upstream profile resolution](https://github.com/troyedwardsjr/z2rs/blob/v0.6.0/crates/z2-native/src/config.rs).
[Upstream player writes](https://github.com/troyedwardsjr/z2rs/blob/v0.6.0/crates/z2-native/src/app.rs).
