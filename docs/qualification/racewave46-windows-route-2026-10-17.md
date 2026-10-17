# RaceWave46 Windows use-in-place route — 2026-10-17

Owners: [#1133](https://github.com/boburning/portcove/issues/1133) and
[#1169](https://github.com/boburning/portcove/issues/1169).

The definition offers the existing user-prepared runtime contract for the exact
official [v1.0.0 release](https://github.com/DomazinUS/RaceWave46/releases/tag/v1.0.0).
It does not offer managed acquisition, updates, backup, rollback or uninstall.
Both platform qualification arrays remain empty. Catalog inclusion is distinct
from Supported or gameplay qualification.

| Input | Exact identity |
| --- | --- |
| Windows ZIP | `RaceWave46-Windows-x64-v1.0.0.zip`, 35,768,574 bytes, SHA256 `f77f3cc10f2dc3db56992480b6906b48bfa1fd1ef614818d039ae86293135028` |
| Source ZIP | 47,827,235 bytes, SHA256 `dde1a882fb3a24e072da1b16c09dcae2100f509d99ffb04ecddca546bed19ccd` |
| Executable | `WaveRace64Recompiled.exe`, 35,992,576 bytes, SHA256 `a5b00cadb0a390854603456f4c8015fb379a349d878e918291e28065b1edc3d1` |
| Immutable tree | Core `portcove-external-tree-v1` digest `77dc97d78610f5cbb3258991af44e834bff912d4ab0bfe904f477e01a32a4663`, 122 regular files |
| Required source | Existing Wave Race 64 USA Rev A identity; original uncompressed `.z64` representation |

The archive digests matched GitHub's published asset digests at pickup. The
Windows archive contains 122 entries / 65,088,750 uncompressed bytes; the source
archive contains 10,887 entries / 182,875,362 uncompressed bytes. Inspection found
no unsafe paths, portable-name collisions or symlink entries. The executable is
unsigned and has no PE version resource; the accepted identity is its reviewed
package/tree, not a guessed version resource.

The release metadata names target `fa495b79d495b6e53e5bf6f55e72009ecf649cf4`,
while the current tag resolves to `5c34f3711426978107707a8f06af9c2af4ee5401`.
GitHub compare returned no common ancestor. Preserve that provenance ambiguity:
it does not establish changed package bytes. The exact packaged root
`RaceWave46/src/main.cpp` matched tag `src/main.cpp` ignoring line endings; this
is bounded source correspondence, not a universal reproducible-build claim.

Packaged `src/wr64_editions.cpp` and `src/main.cpp` establish that the existing
Core argument order, validated original path followed by retained
`launch_arguments: ["--launch"]`, selects direct launch. A positional path alone
does not start direct launch. No new adapter or launcher is introduced. The
shared Core regression checks both argument order and retention after catalog
replacement changes the current definition's arguments and source extension.

Source review locates game-owned imported data, settings, saves, mods and
credentials under executable-adjacent `.runtime`. That directory is an excluded
mutable path, not Portcove-owned persistence. The player prepares and updates the
complete package outside Portcove and preserves `.runtime`. Diagnostics-dependent
source paths are not proof that every published build has identical write
behavior. Actual runtime observations remain a separate acceptance obligation.

The package retains its root GPL and third-party notices, including the stated
unresolved scope of later RecompFrontend additions. This route does not infer
managed redistribution rights or alter those notices.

Retained local inputs and inspection receipts:
`E:/Codex-Evidence/slice3-racewave-20261017`. The runtime was extracted there as an
operator-prepared test fixture, not acquired by Portcove. Earlier basename-only
inspection intermediates are preserved but are not source correspondence
evidence; only the exact root/source paths above were used.

At this source checkpoint, native registration, revalidation, launch, exit,
restart and removal have not been qualified for this artifact. Existing
WaveRace64Recomp v1.0.2 CLI/Playnite evidence belongs to #1388 and does not qualify
RaceWave46. This record grants no catalog publication, support, other-platform or
manual gameplay acceptance.
