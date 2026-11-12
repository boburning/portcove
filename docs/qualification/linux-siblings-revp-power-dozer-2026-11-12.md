# Linux x86-64 siblings: Revelations: Persona and Power Dozer

Dated package evidence for two managed Linux x86-64 routes added on November 12,
2026, under #2926. Each route reuses an established adapter and the title's
existing Windows contract. No new runtime capability is introduced.

## Selection

Release metadata came from the hosted configured-upstream observer (run
43058926577, observed 2026-11-11). It was checked against the whole catalog for
Windows-only integrations whose latest observed release publishes a Linux
package. Revelations: Persona and Power Dozer were the cleanest fits. Others found by
that screen keep their existing scope until their own facts are reviewed. YGOFM
(#141) remains excluded by its Deferred integrity hold.

## Revelations: Persona (#143), `psx-recomp-managed`

| Fact                   | Value                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Asset                  | `revp-0.1.1-linux-x64.zip`                                                                       |
| Size / SHA-256         | 28,066,719 / `b4cb5d74027689465ac4778fd5d71e7f6244f39e2a43b8fe4d7a89dd959b5f70`                  |
| Provider digest        | matched downloaded bytes                                                                         |
| Tag commit             | `v0.1.1` → `38fa6f4cf49a9a03244a64d2a12762074ed23348`; `game.toml` matches the kit               |
| Core layout inspection | passed; root player `Revelations__Persona_Recompiled`, `psxrecomp/psxrecomp_cli.py`, `game.toml` |

After line-ending normalization, all shared members match the accepted Windows
owned-input kit (`f4336030…`) and the ordinary Windows kit. Only
`README-SETUP.txt` differs, by its platform line. Windows-only DLLs, `.exe` files,
vendored `.git` markers and generated rabbitizer headers are absent. The Linux
setup host and `psxrecomp-game`/`psxrecomp-bios` emitters are ELF x86-64 binaries.
They need glibc 2.38 and GLIBCXX up to 3.4.32. Core's existing
`cmake-clang-v1-linux-x64` toolchain matches the kit's `toolchain_pack.py`
Linux pack name. The runtime anchors `settings.toml` and saves beside the
generated player, so the existing `build-portcove` persistence declaration
applies unchanged.

The source contract now also applies to this exact Linux kit, with
`revelations-persona-recompiled-v011-linux-static-contract`. Earlier or
later Linux kits remain unbound. The Windows qualification records keep their
Windows scope.

## Blast Corps / Power Dozer (#2557), `native-portable`

| Fact                                    | Value                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| Asset                                   | `power-dozer-v0.84-linux-x86_64.tar.gz`                                         |
| Size / SHA-256                          | 18,788,674 / `56b342f4209544634d7f8debffd3f6bc5d79afcd8e196726436cf46d80f8d5f6` |
| Provider digest and published `.sha256` | matched downloaded bytes                                                        |
| Core layout inspection                  | passed; lone wrapper removed; executables `power-dozer`, `Run Power Dozer.sh`   |

`power-dozer` has `RUNPATH=$ORIGIN/lib`. The bundled sdl2-compat `libSDL2`
and `libSDL3` carry `RPATH=$ORIGIN`, so direct launch resolves the packaged
libraries without the upstream wrapper. The exact v0.84 source
(`fc04a961…`, provider digest matched) selects
`BLASTCORPS_DATA_DIR` or `<executable>/data`. The existing relative `data`
environment and persistence contract applies on Linux. RT64 diagnostics use
`~/.config/.blastcorps-feasibility`, or `~/.blastcorps-feasibility` when
`~/.config` does not exist, and stay external. The packaged README lists SSSE3/SSE4.1,
glibc 2.38, GLIBCXX 3.4.31, libz, Vulkan, X11/XWayland and a desktop file
chooser.

The shared release-selection corpus enrolls the real v0.84 inventory and a
synthetic v0.85 successor (`downloads.example.invalid`), for both platforms.

## Not observed

No upstream player, setup host, emitter or helper was executed. No original disc, BIOS
or cartridge dump was used. Linux generation, launch, gameplay, save
compatibility, update and rollback with real data were not observed.
