# EarthBound fixed-source Windows qualification — 2026-10-19

Related to [#173](https://github.com/boburning/portcove/issues/173),
[#136](https://github.com/boburning/portcove/issues/136) and slice 6.
This packet establishes private Windows x64 Core/CLI build and operation evidence
for the early EarthBound prototype. Repository admission, installed Desktop
delivery, protected production publication and optional gameplay are distinct.

## Exact execution identity

| Input                            | Identity                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Core source                      | `fc4ed21b0f2b67710928ec6e6e3f7b5973a20834`                                                                      |
| Qualification CLI SHA256         | `8d00315176b11095ab6073638769c7cea15ee1762cf8d5fb90dbe1b85d5606fb`                                              |
| Private execution catalog SHA256 | `c183411ea63db3d8b5ad105d108b86dec573dfb971674b07ccc0bae694cf6237`                                              |
| Game source                      | `nickclyde/EarthBoundRecomp@fe1155dc26ffc40df36a8003dd0e639e17af3349`                                           |
| Framework                        | `mstan/snesrecomp@27197198522b1ddec502be2fc8d76401a8cbe238`                                                     |
| Original                         | Headerless USA SNES, 3,145,728 bytes; SHA256 `a8fe2226728002786d68c27ddddf0b90a894db52e4dfe268fdf72a68cae5f02e` |
| Private executable SHA256        | `4f6191d48cd3dbd0388566a79f70b7f0cb9ac1354f53dc4b2074e7387b2bf5e5`                                              |
| Build receipt SHA256             | `265c5026b4a7085384ae95ff7d12c50685499904dc12fba89780bfcfbb7f20c2`                                              |
| Install manifest SHA256          | `6365419c1a3a36c89a58f4bb24d4cab583f34fc116c3f8c8e583f40f246a24fb`                                              |

The execution catalog also contained an unexecuted Advance Wars proposal. That
does not qualify Advance Wars. The repository admission proposal adds EarthBound
alone; its later bytes do not replace this actual execution provenance.

## Build and offered route

Core acquires exact source archives, official SDL2 2.32.10 development input and
the authenticated `cmake-clang-v1` Windows toolchain. The closed recipe uses the
pinned Python HiROM analysis backend, 49 fixed C objects and four generated C
objects. Launcher, mods, netplay, tracing and co-simulation are disabled. Its
fixed executable takes the owned `game.sfc`; forwarded arguments and nonempty
inherited `SDL_DYNAMIC_API` are refused. The package includes authenticated SDL2,
LLVM runtime companions, original and applicable notices. Compilation does not
execute the game. Existing installer publication, cancellation and child-drain
rules apply; this private build is not a reproducible-build claim.

The pinned `source-fe1155dc26ff` route offers build/install, verification,
launch/restart, current-version maintenance, backup/restore and consented owned
removal. A different source release requires a reviewed compatible recipe.
Rollback correctly refuses when there is no previous version; no cross-version
compatibility is claimed. Configuration/keybindings, `rom.cfg` and saves use
Core persistence. Run/coverage reports and the narrowly declared crash reports
are mutable diagnostics. `dbghelp.dll` is allowed only for this EarthBound recipe.

The game/framework READMEs and attribution files are retained. Their lack of a
project-wide license is not a new redistribution grant. This route builds
privately from the user's admitted original and publishes no modified binary.
The ordinary artwork preparer retained 99 existing mappings; EarthBound received
a generated fallback because its port identity did not match and its original
game match was not unique. No provider ID was guessed.

## Actual operation observations

Private retained evidence root: `H:/pc6-qualification-20261019-a3/evidence`.
These local receipts are not shipping assets or a second planning authority.

| Packet                                                          | Actual result                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `earthbound-core-install-a3/result.json`                        | Build/install passed in about 192 seconds after resource admission; all four import inspections completed, worker quiescence proven, 12 immutable runtime files verified. Install `164bb3d3-ea74-4e1f-9c29-0d415f580bd5`.                          |
| `earthbound-native-a4/result.json`                              | Two responsive owned-window startup and ordinary WM-close cycles passed. Core/CLI and captured OS exit were zero; 12-file verification passed after each. No owned TCP listener at window observation.                                             |
| `earthbound-native-a3/forwarded-arguments-refused.process.json` | Actual earlier Core cartridge guard refused forwarded arguments, exit 2. This same-artifact refusal was reused after correcting collector wording.                                                                                                 |
| `earthbound-native-a4/result.json`                              | Actual nonempty `SDL_DYNAMIC_API` refusal passed without an observed game process.                                                                                                                                                                 |
| `earthbound-maintenance-a1/result.json`                         | Current check/update returned the identical install; no-previous-version rollback refused. Backup/restore preserved all four actual runtime user files.                                                                                            |
| `earthbound-removal-a1/result.json`                             | Wrong-preview and missing-consent refusals passed, then normal consented Core removal succeeded. Zero installs, pending/active launches, running activity and lifecycle work remained. Original, canonical user data and retained backup survived. |

Native request IDs were `dc07355f-9eac-415c-bf64-3256d6b6715b` and
`a2d89b0c-f69f-4e9a-ac9f-66f68d7d034d`; the API refusal was
`ac45f9b7-81fb-49d9-ad1c-c27baf97ee4f`. The normal native lease was released.
The two captured owned processes terminated positively; no forced close supplied
the successful ordinary-close observations.

Actual persisted files were `keybinds.ini` (797 bytes), `rom.cfg` (147 bytes),
`saves/save.srm` and `saves/save.srm.bak` (8192 bytes each). Backup
`7b4e7151-367a-4782-8a3f-9e8af4346b42` retained four files, 17,328 bytes,
aggregate SHA256 `02e4cf85eb762a763706ce34246878192bec663a5e2dd0194676cd5cfb0ec31b`.
A controlled inactive keybinding comment exercised consented restore and its
safety backup; only that fresh safety backup was subsequently deleted. All four
canonical and retained backup files and the original remained hash-preserved
after removal. A 19-file, 11,546,532-byte evidence copy of the install remains
unregistered and grants no launch authority.

## Preserved failures and evidence limits

The first build on the busy E: HDD completed generation and linking but timed out
during import inspection after 25 minutes. Its staging tree and journal remain
untouched at `E:/pcs6eb-core1-20261019`; partial process observations do not prove
full worker quiescence. Raw evidence remains under
`E:/Codex-Evidence/slice6-20261018/earthbound-core-install-a1`.
A disk-pressure preflight refused attempt 2 before another install tree was
created. Attempt 3 used fresh owned H: SSD paths with the same source/CLI/catalog
and authenticated inputs. Its pass establishes completion there, without claiming
the exact stalled filesystem operation was causally repaired.

Native collector attempts 1–3 failed before game launch: unsupported structured
`exec` output, hidden technical error detail and an incorrect expected refusal
message. Their raw observations remain retained. After fresh zero-launch/database
and bounded process checks, only their exact owned stale reservations were
archived with nonce/preimage evidence. Foreign reservations were preserved.
The successful fourth collector reused the already-observed argument refusal.

Separate non-writing source review and actual receipt review cleared their
respective scopes. No visual, audio, physical-controller, gameplay or populated
in-game save/load acceptance is claimed. A responsive window and a newly created
save file do not prove those observations. This is not installed Desktop or
protected signing/catalog publication evidence; other platforms remain unknown.

Advance Wars remains unadmitted: the available patched original does not match
the fixed USA Rev 1 SHA1 `15053499d5b3f49128a941d7f2d84876f5424d0c`.
Its shipped narrow capability still requires the exact original and its own
actual build/operation acceptance before admission and delivery.
