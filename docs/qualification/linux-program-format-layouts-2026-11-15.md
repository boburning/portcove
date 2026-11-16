# Linux program-format package layouts (November 15, 2026)

The staging layout gate from
[#4780](https://github.com/boburning/portcove/issues/4780) previously skipped
three existing Linux x86-64 managed packages. Their archives mark data,
licenses or versioned shared libraries executable, so a mode-bit inventory
would hold every routine data or library revision. The new opt-in
`classify_linux_programs_by_format` counts an executable-mode file only when it
starts with an ELF or `#!` header, and excludes a `.so` or `.so.N` file only
when its header is a verified x86-64 ELF shared object with a dynamic segment
and no program interpreter. Eleven existing routes now carry the reviewed
Linux layout. Fresh and retained indexed definitions using the option require
native-portable version 36.

## Archive observations

Each archive was downloaded on its own into a new directory, hashed, and listed
without extraction or execution by a separate Python classifier that mirrors the
Core rule. Core's own extractor and classifier were not run on these archives;
its behavior is covered by the inert fixtures and unit tests in the same
change.
Sizes match the GitHub release metadata. Where GitHub publishes an asset
digest, the computed SHA-256 matches it.

| Package                    | Release          | Asset ID  | Size     | SHA-256                                                            | GitHub digest |
| -------------------------- | ---------------- | --------- | -------- | ------------------------------------------------------------------ | ------------- |
| ReflectionHLE Linux x86-64 | release-20240926 | 195128118 | 1361852  | `9987c2ac63449a826b798b2408e64a96ad3ae97d5bec44730699902aebf9a2f2` | not published |
| ReflectionHLE Linux x86-64 | release-20260606 | 440401187 | 7993508  | `90b251d827a53a9842677f4de0b06d26fa049597f47d1775e426129142506420` | matches       |
| Pilotwings 64 Linux x86-64 | v0.1.0           | 564991979 | 6057183  | `95a2c120c3213eb1da9b9c84e6c51b11c4dfbd7089449c521b92bfc2a6318d24` | matches       |
| Pilotwings 64 Linux x86-64 | v0.1.1           | 570710302 | 6057519  | `b4849feb348f68918daaaefd226cb1824f4512eaf5140095e28e765807749492` | matches       |
| Daggerfall Unity Linux     | v1.1.0-rc        | 160808582 | 58808735 | `cff785316c26e74c12d2cda48651f0b1a4fa9f57822d283794e798307242029e` | not published |
| Daggerfall Unity Linux     | v1.1.1-cve-2025  | 300617683 | 58809717 | `be3c476ae92972f42448757719266ad82c04868eb7b6f3a3c90fcfcf1490849a` | matches       |

Both releases of each package produced the same reviewed layout:

| Package          | Directories            | Program paths                                                          |
| ---------------- | ---------------------- | ---------------------------------------------------------------------- |
| ReflectionHLE    | none                   | `reflectionhle`                                                        |
| Pilotwings 64    | `assets`, `licenses`   | `pilotwings64recomp`, `pilotwings64recomp.sh`                          |
| Daggerfall Unity | `daggerfallunity_data` | `daggerfallunity.x86_64`, `linuxplayer_s.debug`, `unityplayer_s.debug` |

ReflectionHLE's current archive holds `libSDL3.so.0.4.10` and
`libspeexdsp.so.1.5.2` plus link aliases, which managed extraction
materializes as copies. `libspeexdsp` has a nonzero ELF entry point, which is
why the classifier relies on the absent program interpreter rather than the
entry point. All nine ReflectionHLE records share the observation. Pilotwings
64 marks all 73 members executable; 71 are data. Daggerfall Unity marks all 599
members executable. Its 125 managed .NET assemblies are Windows-format
libraries and stay outside the fingerprint, as DLLs do on Windows. Its two
`_s.debug` ELF files keep stable names and remain in the fingerprint.

## Limits

These are static archive observations and inert lifecycle fixtures. No package
was run, no original data or profile was used, and no native gameplay,
populated-save compatibility or protected publication was observed. Existing
selectors, persistent paths, original-data contracts and retained definitions
keep their scope. Other managed adapters remain with the generated package-shape
work in [#5359](https://github.com/boburning/portcove/issues/5359).
