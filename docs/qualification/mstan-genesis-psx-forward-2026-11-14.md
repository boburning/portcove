# mstan Genesis and PS1 recompilations: forward review (November 14, 2026)

Dated static evidence for three managed mstan routes whose newest releases a
November 13 static survey deferred because they add player-data writers or
change the package layout. Owners: [#152](https://github.com/boburning/portcove/issues/152),
[#153](https://github.com/boburning/portcove/issues/153) and
[#142](https://github.com/boburning/portcove/issues/142). Catalog support and
Project fields keep their authority. Nothing was installed, executed or played.

| Route / issue                        | Reviewed → newest       | Outcome                                                                 |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------- |
| `sonic-the-hedgehog-2-recomp` / #153 | v0.8.3 → v0.9.23        | `logs` declared; v0.9.23 applicability row and evidence appended        |
| `ape-escape-recompiled` / #142       | v0.3.0 → v0.5.7         | Split mod paths and new writers declared; v0.5.7 row and evidence added |
| `sonic-the-hedgehog-recomp` / #152   | v0.7.3, v0.8.3 → v1.2.0 | Unchanged: owner decision needed (see below)                            |

Historical applicability rows stay first and unchanged. One new
`upstream_support` record per changed route binds the tag commit.

## Method

Each artifact was downloaded with `python3 -I` urllib into its own new, empty
directory, hashed from the bytes and opened only with Python's `zipfile`. The
bound predecessors (Sonic 1 v0.7.3 and the current v0.8.3 URL, Sonic 2 v0.8.3,
Ape Escape v0.3.0) were downloaded the same way for comparison. All archives
were deleted afterwards. Tag commits came from `git ls-remote`. Upstream source
was read statically from shallow, unchecked-out clones of the tagged title
repositories and their pinned engine, UI and framework commits. No upstream
program, script or build ran.

| Artifact                                          | Bytes      | SHA-256                                                            | Publisher checksum             |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------ |
| `SonicTheHedgehogRecomp-windows-x64-v1.2.0.zip`   | 5,562,704  | `fa01c42f2e04251e8fbce5c4bd2ec7ff75c2c8b8f3e01df1cf265b08c6c6c3c2` | none found                     |
| `SonicTheHedgehog2Recomp-windows-x64-v0.9.23.zip` | 8,126,526  | `d6c19d29efa7578afd3468b61495f164358e5bf828ed09fb3e990c10518fd5dc` | matches the `.sha256` file     |
| `ApeEscapeRecomp-v0.5.7-windows-x64.zip`          | 46,713,030 | `d8b14cdc5c654556cf7235359f8450092d2c0946e93fd827c5d5c684a2f7621f` | none found                     |
| Sonic 1 v0.7.3 (bound)                            | 4,750,567  | `082cfb48e1d35a5ae05f054ad663e4eee46b21e5d920ec7e7d6628bce32a3fc8` | matches the catalog            |
| Sonic 1 v0.8.3 URL today                          | 5,324,030  | `df79626eb3dbb35228ba22dfbb1dbaf7ce314e18bc5db8809a1c74cf12291c54` | differs from bound `54c73309…` |
| Sonic 2 v0.8.3 (bound)                            | 7,204,657  | `c526ad6fbdbcc83619e0daf8711a7c09699d63541003be4cc4bbdef11877901f` | matches the catalog            |
| Ape Escape v0.3.0 (bound)                         | 37,806,136 | `91e2cde5f16408ff51b4b822ebba8b811c4e591263170cb49f33a486606c58e9` | matches the catalog            |

"None found" means no `SHA256SUMS`, `SHA256SUMS.txt` or `<asset>.sha256` at
the release download path; those digests are computed only and do not
authenticate the download. The GitHub release API was not reachable from this
session, so release IDs, draft/prerelease flags and provider digests were not
read.

Tag commits: Sonic 1 v1.2.0 `e82c95baa1ea8c53750fa9864f48dd45dc668b51`
(annotated tag object `ff93b011…`); Sonic 2 v0.9.23
`4cb77b3732547b467070ec8bda65135dc7cc9b3f`; Ape Escape v0.5.7
`2f98ccab5fe510cedd924beebd773e5e2458d16d` (tag object `febefd44…`). The
Sonic repositories' older tags now resolve to commits other than the ones the
catalog recorded (Sonic 1 v0.7.3 `3f03256a…` instead of `510679e6…`, v0.8.3
`e0e9a78c…` instead of `5cfa5f92…`; Sonic 2 v0.8.3 `fd045a31…` instead of
`e1451eee…`). The Sonic 2 v0.8.3 asset bytes still match. Evidence therefore
binds commits, not tag names.

## Sonic the Hedgehog 2 v0.9.23 (#153)

- **Package.** `SonicTheHedgehog2Recomp.exe` keeps its path. The package
  removes `build-info.json`, `licenses/` and the `.tga` box art, and adds
  `PERMISSIONS.md`, `docs/PLAYER_FEEDBACK.md`, `tools/replay_diagnostic.py`,
  `assets/img/boxart.jpg` and `assets/megamix/CREDITS.txt`. No file lands on a
  declared persistent path.
- **Original game.** Tagged `game/sonic2_spec.c` keeps the 1 MiB raw ROM and
  CRC `7B905383`. Core's exact-stock SHA-256 is unchanged.
- **Writers.** The game's own data filenames (`settings.ini`,
  `sonic2-party.ini` and its `.tmp`, campaign `.srm`/`.sav`, `.bak` and
  `<name>.<pid>.<n>.tmp`) are unchanged from v0.8.3 (`e1451eee`). The pinned
  engine moves from `64d9c145` to `a7433ace`; its only new data writer is the
  default-on replayable feedback recorder, which creates `logs/` beside the
  executable (unless the new `GENESIS_USER_DIR`, which Portcove does not set,
  selects another folder) and writes `<game>-feedback.replay` with `.sav`,
  `.config.ini`, `.mods.txt` and `.mods.toml` sidecars and two rotated
  previous captures. The v0.8.3 engine and game never create `logs`. The
  pinned recomp-ui (`7e884a22` → `761f76e7`) has the same data filename set.
- **Inputs.** The new Megamix v3 donor and the existing Amy and Sonic 3 &
  Knuckles donors are read from player-selected paths stored in
  `sonic2-party.ini`. A fallback reads `assets/characters/{amy-1.7.1,megamix-v3}.bin`
  beside the executable, which only a player places there; Portcove neither
  creates nor carries those files.

**Decision.** `logs` is declared persistent, as on the Sonic 1 route, and the
player explanation names the recorder, its private contents, its bounds and
its opt-out. The v0.9.23 package is appended to the source contract.

**Existing installations.** Only a path is added; every other execution field
is unchanged. A v0.8.3 copy may recognize the new path (`installed_mutability`
additive grant), and the ready-archive update to a strictly larger scope
proceeds only while `logs` is absent from the active runtime, canonical data
and destination. v0.8.3 never writes it. A copy where something already
created `logs` stays on its current version with every file preserved.

## Ape Escape v0.5.7 (#142)

- **Package.** `ApeEscapeRecomp.exe`, `game.toml` and `bios/openbios.bin` keep
  their paths. `RELEASE_MANIFEST.json` names source `2f98ccab` and PSXRecomp
  framework `1b84d4fd3a1c65f64c2d97b49320f769ba2e01fc` (RetroPortingToolKit
  mainline). The archive adds the program `overlay_toolchain/psxrecomp-bios.exe`,
  BIOS profiles and seeds, `licenses/`, `input.ini`,
  `ApeEscapeRecomp.execution.json`, `RELEASE_MANIFEST.json` and
  `psx_game_version.txt`; it removes `LICENSE` and `docs/`. The shipped AOT
  cache moves from `cache/…/cg10_e4839529_…` to `cg18_cbab7e7c_…` under the
  existing runtime-mutable `cache`.
- **Original game.** `DISC.md` is byte-identical to v0.3.0: SCUS-94423,
  432,238,800 bytes, SHA-256 `1AE17E78…852A`.
- **Launch inputs.** The framework still parses `--no-launcher`,
  `--memcard-dir`, `--game`, `--bios` and `--disc`, so the existing arguments
  and BIN/CUE materialization apply. `psxrecomp-bios.exe` is used only to build
  a module for a selected retail BIOS, into `cache/bios`; Portcove passes the
  bundled OpenBIOS.
- **Mods.** v0.3.0 and v0.5.7 both ship built-in packages in `mods/bundled`
  (v0.5.7 removes three, adds eleven and changes two). Under the old whole-`mods`
  scope those defaults were collected as player data, and an update would have
  restored the older defaults over the new package. The 1b84d4fd framework
  keeps added mods in `mods/installed`, writes `mods/state.toml` through
  `mods/state.toml.tmp`, stages in `mods/.staging`, creates
  `mods/texture-packs/<game>/` for the bundled HD-texture package, keeps a
  derived-disc cache in `mods/cache`, and on start moves a flat
  `mods/packages/<id>/<version>` into `mods/installed`, deleting it only when
  `mods/bundled` or `mods/installed` already has that ID and version. This
  matches the split layout the reviewed `7192402` kits use
  ([whole-to-split record](psxrecomp-7192402-whole-to-split-2026-11-13.md)),
  although `1b84d4fd` is a separate lineage (merge base August 28, 2026); the
  catalog's reviewed `7192402`, `d5cae379` and `de7ad680` frameworks do not
  cover it, so this framework was read on its own.
- **Other new writers.** The in-game menu, absent from the v0.3.0 framework `52dd4dff`, passes
  `config.ini` beside the executable to recomp-ui, which writes key and
  gamepad bindings there. An unparsable `settings.toml` is renamed to
  `settings.toml.bad`. `saves/netplay/net_diag.jsonl` stays under `saves`.
  `moderation.ini` is written only by the launcher, which `--no-launcher`
  skips. No mod package is downloaded from the network.
- **Outside the installation.** Mod preparation caches disc digests under
  `%LOCALAPPDATA%\psxrecomp\imports\disc-digests-v2`, keyed by the disc path.
  It is a validated, disposable cache. Portcove does not manage, back up or
  remove it, and the player explanation says so.
- **Shipped default on a persistent path.** `input.ini` is now in the package.
  As a declared persistent path it is outside the immutable manifest. On a
  version's first launch Core restores the player's canonical `input.ini` over
  it; when the player has none, the shipped default stays and is collected as
  player data afterwards.

**Decision.** `mods` is replaced by the six split paths, `config.ini` and
`settings.toml.bad` are added as persistent data, and `mods/cache` is added as
runtime-mutable output. `mods/bundled` stays with each package. The v0.5.7
package is appended to the source contract.

**Existing installations.** The current definition no longer contains `mods`,
so installations created under the whole-`mods` definition keep their retained
definition and scope (`installed_mutability`), as in the 7192402 move. An
update collects the old copy's whole `mods`, restores only the split paths into
the new copy, and the runtime then migrates a flat `mods/packages`. The old
`mods/bundled` stays in canonical data and backups but is never restored into a
new copy. Rolling back restores the whole tree to the old copy. A player
package that v0.5.7 moved into `mods/installed` is not read by the v0.3.0
runtime. Ape Escape's BIN/CUE route is not a ready staged archive, so no
empty-expansion proof applies and no definition-format fence is needed: older
readers already understand every declared field.

## Sonic the Hedgehog v1.2.0 (#152): owner decision needed

v1.2.0 adds three settings writers beside `settings.ini`, all through the
engine's atomic store: `sonic1-sound.ini` (Clone Driver choice),
`sonic1-bug-fixes.ini` (debug-transporter escape) and `sonic1-easy-access.ini`
(level select and debug shortcuts). All three default off. Package-level
changes are notices, release notes, `tools/replay_diagnostic.py` and removed
`licenses/`; the replay writer already lives under the declared `logs`.
Packaged `build-info.json` names game commit `0e6805c3…`, engine `7c067f95…`
and UI `ff71584e…`; the tag points at `e82c95ba…`.

The route declares `archive_data_compatibility_v1`. Its namespace hash covers
the persistent paths, so adding these three files to the shared paths creates
a new policy. Every existing installation's canonical data then belongs to
another contract, and updates, fresh installs beside it and restores hold
("A new layout is a contract migration, never an additive path grant").
The route's `release_policy: integration-contract-v1` already admits v1.2.0,
so installations can be on it today with these files undeclared: they stay in
the runtime folder and are not carried to the next version.

Options:

1. **Keep the route unchanged (current state).** The three opt-in choices reset
   to off after each update. No player data is at risk.
2. **Declare the three files now.** New installations own them; every existing
   installation holds on update until a policy-successor transition exists.
3. **Add a reviewed Core transition first.** Let an archive-data policy move to
   a successor that only adds shared settings paths, adopting those files from
   the active runtime, then declare them.

Recommendation: option 3, with option 1 until it lands. The lost state is
three default-off preferences, while option 2 strands every current
installation. No row is appended for v1.2.0, because the route does not own
its new writers.

## Not observed

- Any launch, first-run file creation, actual write location, replay
  recording, in-game menu or mod behavior, mod migration, settings migration,
  netplay, gameplay or save compatibility.
- Provider release digests, asset IDs and draft or prerelease flags.
- Intermediate releases between the bound and newest tags.
- An update, rollback or backup of a real installation under the new
  definitions.
