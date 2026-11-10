# Reviewed BStone, Crispy Doom-family, OpenTyrian and CorsixTH package layouts

The existing staging gate from [#4780](https://github.com/boburning/portcove/issues/4780)
now covers fifteen managed routes across ten records. The offline
`catalog inspect-package-layout` command verified each archive's exact size
and SHA-256 against GitHub release asset metadata and observed the same
directory and program paths in both releases of each pair.

| Package and platform          | Earlier asset ID | Successor asset ID | Directories | Program paths |
| ----------------------------- | ---------------- | ------------------ | ----------- | ------------- |
| BStone Windows x86-64         | 345633878        | 431305599          | 0           | 1             |
| BStone Linux x86-64           | 345633859        | 431305562          | 0           | 1             |
| BStone macOS Intel            | 345633846        | 431305553          | 0           | 1             |
| Crispy Doom Windows x86-64    | 296378840        | 633334505          | 0           | 3             |
| Crispy Heretic Windows x86-64 | 296378835        | 633334439          | 0           | 3             |
| Crispy Hexen Windows x86-64   | 296378832        | 633334387          | 0           | 3             |
| Crispy Strife Windows x86-64  | 296378826        | 633334350          | 0           | 3             |
| OpenTyrian Windows x86-64     | 560377693        | 562161395          | 2           | 13            |
| OpenTyrian Linux x86-64       | 560376542        | 562160463          | 2           | 13            |
| CorsixTH Windows x86-64       | 532262863        | 709021605          | 4           | 1             |

The release pairs are
[BStone v1.3.3](https://github.com/bibendovsky/bstone/releases/tag/v1.3.3) and
[v1.3.4](https://github.com/bibendovsky/bstone/releases/tag/v1.3.4),
[Crispy Doom 7.1](https://github.com/fabiangreffrath/crispy-doom/releases/tag/crispy-doom-7.1) and
[7.2](https://github.com/fabiangreffrath/crispy-doom/releases/tag/crispy-doom-7.2),
[OpenTyrian v2.1.20260912](https://github.com/opentyrian/opentyrian/releases/tag/v2.1.20260912) and
[v2.1.20260913](https://github.com/opentyrian/opentyrian/releases/tag/v2.1.20260913),
and [CorsixTH v0.70.1](https://github.com/CorsixTH/CorsixTH/releases/tag/v0.70.1) and
[v0.70.2](https://github.com/CorsixTH/CorsixTH/releases/tag/v0.70.2).

Both Blake Stone titles share the BStone package observations and keep their
own original-data contracts. The Darwin binaries are Intel. Ultimate Doom,
Doom II and Final Doom share the Crispy Doom package observations. Crispy
Heretic, Hexen and Strife use their own assets. Each Crispy route still
selects its setup executable, whose menu starts the game. OpenTyrian's
program paths include twelve bundled DOS executables under `data`.

Both OpenTyrian macOS assets (560376490 and 562160158) contain SDL2 framework
directory links and were rejected by the managed archive observer. macOS
continues to use upstream setup. CorsixTH Linux uses the existing standalone
AppImage and external profile policy. Inspecting the outer file would not
establish the topology of its embedded contents.

The observed releases are evidence for the staging expectations. Existing
asset selectors continue to discover compatible upstream releases without
per-release catalog edits. The observations exercised archive staging without
opening a library, launching a package, checking populated profiles, or
qualifying native execution or protected publication.
