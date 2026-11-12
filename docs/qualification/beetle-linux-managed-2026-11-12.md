# Beetle Adventure Racing: Recompiled, managed Linux route (2026-11-12)

Package inspection only. No Linux player ran the program, and no original ROM was used.

- Asset: `BeetleRecomp-b2118ba-Linux-x64.zip` from `bryankruman/BeetleRecomp`
  release `Continuous` (the selector is `BeetleRecomp` plus `Linux-x64`, so a successor
  build needs no catalog edit).
- Layout: one `BeetleRecomp-Linux-x64/` folder; `BeetleRecomp` is an ELF64 x86-64 file with the
  executable bit set; no links, case collisions or nested archives.
- Data location: the binary contains `portable.txt` and an `XDG_CONFIG_HOME` fallback. The
  N64 recompilation adapter writes `portable.txt` beside the runtime, so saves, mods and
  settings stay under `BeetleRecomp-Linux-x64/` and are preserved by the same persistent-path
  list as Windows (both folder prefixes are declared).
- Shared change: the Windows record's single `runtime_subdirectory` could not name this
  folder. `runtime_subdirectory_by_platform` (n64-recomp-portable capability 6) lets a
  listed platform replace it; older readers refuse such definitions.
- Upstream states the Linux build passes its own checks while game verification remains.
  Golden Balloon's Linux tarball is unblocked by the same field and is not added here.
