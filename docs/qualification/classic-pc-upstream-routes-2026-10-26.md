# Classic PC upstream routes — October 26, 2026

This is a four-port delivery batch for #2926 and Public beta / Required parent
#2510. It starts from main `fcb685a3611f850d1ac417adb63f4a07ad414413` and
improves existing original-inventory listings. No port identity or managed
integration is added. The original 524 identities, 312 affected additions and
22 roadmap joins remain retained cohorts; this packet makes no full inventory,
managed-fit or Public beta completion claim.

Each listing now recommends the Windows game ZIP, identifies the actual player,
and explains the original-file and data boundary. Core still binds the selected
asset, destination and current preview; its unverified-artifact disclosure,
registration consent and explicit Play remain. The generic upstream-owned route
keeps runtime replacement, files, saves and backups with the player/upstream.
Existing registrations and artwork are retained. No UI or lifecycle engine is
added.

| Existing identity / owner           | Useful route and setup                                                                                                                                                                | Data and maintenance boundary                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lethal-guitar-rigelengine` / #1877 | Windows `rigelengine_win_x64.zip` contains `RigelEngine.exe`. First Play selects a shareware or registered Duke Nukem II folder; `NUKEM2.CMP` is required, intro movies optional.     | The SDL `lethal-guitar` / `Rigel Engine` profile remembers the source path, imported saves/high scores, options and mod library. Keep that profile and mod files across upstream updates.            |
| `keriew-augustus` / #1793           | Windows `augustus-…-windows.zip` contains `augustus.exe`. Use a separate runtime and select a writable Caesar III 1.0.1.0 folder.                                                     | Saves remain in the selected game-data folder; the SDL `augustus` / `augustus` profile retains its location. Augustus reads Caesar III/Julius saves, but its own saves do not work in those readers. |
| `elasota-aerofoil` / #1790          | Windows `Aerofoil-…-win64.zip` contains `Aerofoil/Aerofoil.exe` and packaged houses/editor. Tools, symbols and MSI are distinct alternatives; optional import tools remain available. | Source resolves the Windows Documents known folder plus `Aerofoil`, including Houses, SavedGames, Scores, Logs, Export and preferences. Preserve it when updating the upstream copy.                 |
| `m-x-d-heretic2r` / #1826           | `Heretic2R_….zip` contains `Heretic2R.exe`. Prepare a separate copy with the player's Heretic II 1.06 `base` folder, excluding original DLLs. Own OGG CD tracks are optional.         | Saves, settings, screenshots and logs use Windows Saved Games/Heretic2R. Original Heretic II saves, renderers, sound and game modules are incompatible; retain the original copy.                    |

The machine-readable [source-bound observations](classic-pc-upstream-routes-2026-10-26.json)
record official repository/node identity, exact release/tag/source, complete
release and selected-asset retrieval, expected versus computed digests, bounded
ZIP metadata, native headers, stable package hints and maintained preparation
receipts. Each Windows ZIP has one player. Augustus and Heretic2R are I386 PEs;
Rigel and Aerofoil are AMD64 PEs. Existing Core discovery explicitly admits both
I386 and AMD64 executables on its Windows x64 host scope. Header inspection is
not native execution.

Rigel also advertises x64 Debian/macOS packages. Augustus publishes Linux,
macOS and non-Desktop packages; the macOS architecture is not established here.
Aerofoil's selected release provides Windows/Android; a historical README macOS
mention does not qualify a current Mac package. Heretic2R's selected package is
Windows. These observations do not establish another platform's execution or
managed replacement contract.

## Managed adoption remains unfinished

The selected Rigel, Augustus and Aerofoil GitHub assets have no publisher digest;
their complete release assets and notes establish no expected Windows archive
SHA-256. Inspected publication scripts do not establish an independently
published Windows checksum. Computed inspection hashes remain unauthenticated,
and are not a reason to bypass Core's disclosure or grant managed ownership.
Publisher/accepted-provider integrity and the full runtime-output contract still
need resolution before managed adoption.

Heretic2R's published SHA-256 matches the actual archive. Its required manual
original-data preparation mixes a copied `base` tree with packaged runtime DLLs
and defaults. No contained, reviewed source projection and completion contract
has been established. Neither an empty persistence contract nor declaring all of
`base` as player data would establish safe replacement. The concrete remaining
work is to establish that source/readiness/data contract, using existing shared
capabilities where they actually fit. The useful upstream-owned route is offered
in the meantime. These are unfinished fit decisions, not new product deferrals
or unsupported classifications.

## Verification and delivery boundary

All four records use maintained `prepare-port.mts` preparation with an exact
selected release and complete asset inventory. Stable filename hints each match
one actual runtime ZIP. Generated catalog outputs use `generate-catalog.mts`.
Independent review and exact-head hosted qualification bind the eventual PR
candidate; actual delivery and Project readback belong on the canonical issues.
The JSON packet retains the preparation guard that caught invalidated artwork
reuse before source mutation and distinguishes initial unselected release
observations from complete selected-release retrieval.

No original game data, helper, installer or player was executed. No managed
lifecycle, packaged Desktop, real-save or native gameplay acceptance follows.
#2225/#47/#48 and #534/#246 keep their separate acceptance and authority.
