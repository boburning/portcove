# Tomba! 2 Windows acquisition and prepared player

[Tomba! 2 #169](https://github.com/boburning/portcove/issues/169) uses the
upstream USA preview package and its integrated player. The original disc
remains a player-provided SCUS-94454 CUE/BIN or another upstream-supported
representation. The player hosts setup and the game in one process, resolves
relative paths from the executable folder and can use the bundled OpenBIOS.
The Italian build and imported optional character assets are separate inputs.

Both official Windows x64 ZIPs match the SHA-256 values in the corresponding
GitHub release asset metadata and pass ZIP member CRC checks. Each contains
`Tomba2Recomp-windows-x64/Tomba2Recomp.exe` and 73 native cache DLLs paired
with audit records for SCUS-94454.

| Preview release                                                     |  Asset ID | SHA-256                                                            |
| ------------------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| [v0.3.2](https://github.com/mstan/Tomba2Recomp/releases/tag/v0.3.2) | 678674207 | `09548e1e82e11e0fce799eebbb52e5e8dfa0c14119ee55cff4adf35bca3d13e8` |
| [v0.3.3](https://github.com/mstan/Tomba2Recomp/releases/tag/v0.3.3) | 693863309 | `7336c6fae40b71d177697a819e644eec77cfd2b4cf0eeabe1ff0366ed16f9370` |

The upstream [AOT packaging guide](https://github.com/mstan/Tomba2Recomp/blob/97709516d657480ea66cbe2473d9fbae5986ca81/docs/AOT_RELEASE.md)
requires generating the release cache from original-disc inputs. The archived
audits bind their cache tags and published pairs to that disc. The project and
bundled component notices do not establish permission for that translated
original code. Core holds fresh downloads and allows a player to register a
complete copy they are permitted to use. Reconsider managed acquisition after
the cache permission is established or upstream publishes an appropriate
replacement archive.

Keep the whole player folder, saves, settings, mods and cache, and preserve
the separate Windows seamless-loading directory and any custom paths.
The player or upstream owns replacement. The two inspected cache tags differ,
so package identity alone establishes neither cache nor save compatibility.
This evidence covers archive integrity, package members and the upstream
source contract. The prepared route uses the existing registration and Play
flow. No actual player process, disc ingest, save restore or managed update
was exercised.
