# Diablo PSXRecomp Linux admission — October 11, 2026

This definition uses the existing managed PSX adapter for Linux x86-64. It
extends the same Diablo integration and source contracts; it does not create a
second identity or carry over Windows runtime observations. Generation, runtime,
lifecycle and gameplay remain **Not tested**. Protected distribution remains
with [#246](https://github.com/boburning/portcove/issues/246) and
[#534](https://github.com/boburning/portcove/issues/534).

## Exact artifact and source

Direct upstream release v0.1.4 resolves to commit
`1e71257166f6a2c0e087f7a36e0e3bde984132d4`. Linux asset 605927354 is
`diablo-recomp-0.1.4-linux-x64.zip`, 27803391 bytes, SHA256
`0579d28ce0f1d8bcb5aca3b1a68b8fe43ea866aa141202b2bc80d0d17f1943e1`.
Actual downloaded bytes match the fresh upstream asset digest. Bounded raw
central-directory inspection found 2230 entries and 67316090 expanded bytes.
Selected member reads were bounded separately; no full package extraction,
setup, helper or game execution occurred.

The Europe SLES-01156 single-track disc and required retail SCPH-5552 BIOS
contracts from the [Windows admission](diablo-psx-windows-admission-2026-10-10.md)
also apply to this exact Linux artifact. OpenBIOS is not an accepted substitute.
Game, identity, project, CLI, CMake, runtime and toolchain declarations match
their authenticated Windows package counterparts after explicit newline
normalization. Raw differing hashes remain retained, and this comparison does
not authenticate any user input or establish platform execution equivalence.

## Setup and runtime coordinates

Current Core's `psx.rs` owns the fixed generate/rebuild sequence. It verifies
source storage and raw BIOS identity, materializes the CHD privately, runs the
package CLI with the authenticated Linux build toolchain and isolated builder
environment, refuses upstream toolchain downloads, and checks the selected
generated executable in `build-portcove`. Linux uses the basename without an
`.exe` suffix. The upstream CMake runtime target and rebuild CLI retain the
same basename/output contract as the inspected Windows kit.

The root `Diablo_Recompiled` is a setup/bootstrap host, not proof of a generated
playable game. Its ELF64 AMD x86-64 image is 9792216 bytes, SHA256
`facdd97386e136b31133c204fe258b5c6892168f579c1ac68349e4c9c825668d`.
System GNU readelf 2.46 inspected it without loading it. Its version needs
include GLIBC_2.29 and GLIBCXX_3.4.26; DT_NEEDED names zlib, OpenGL, libstdc++,
libgcc, libc, libm, libdl and libpthread. These bootstrap ABI facts do not pass
generated-game or toolchain minimum-host qualification.

The upstream runtime anchors settings and sidecars beside its executable.
On non-Windows hosts it checks `APPIMAGE` before `argv[0]`. Core's
`ChildProcessPolicy` clears the inherited environment and does not forward
`APPIMAGE`, preventing the Desktop AppImage path from replacing this anchor.
The managed adapter supplies explicit game-config, BIOS and save-directory
arguments and uses `build-portcove` as its runtime directory. Settings, inputs,
sidecars, mods and captures keep the existing persistent declarations; caches
and diagnostic outputs keep their existing reviewed mutable declarations.
No new persistence or application implementation is introduced.

## Evidence and remaining acceptance

[Canonical static package evidence](https://github.com/boburning/portcove/issues/435#issuecomment-6114039895)
retains exact member receipts and dependencies. Additional coordinate source
receipts live under `work/beta-435-linux-v014-20261011` in the development
workspace. An initial selected-text lookup used the incorrect
`psxrecomp/toolchain_pack.py` path after retaining two source files; that failure
is preserved. Only the missing file was then read from its verified
`psxrecomp/tools/toolchain_pack.py` location. All three coordinate sources match
the Windows declarations after newline normalization. No native retry occurred.

The same existing artwork fallback and managed-compatible-release policy apply
to the same title. Each subsequent artifact still needs exact compatibility,
source, integrity and ownership checks. No automated/manual qualification entry
is added. Linux GLib security, independent Linux host/runtime acceptance and
protected signed-feed availability retain their existing owners and holds.
This repository admission does not close the whole port or beta outcome.
