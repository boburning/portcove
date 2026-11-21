# Nookery v1.0.0 managed Windows route

This candidate moves the managed Windows x86-64 route of `animal-crossing-pc-port`
from the 0.9.x ACGC-PC-Port playtests to the stable Nookery v1.0.0 package.
[Issue #4890](https://github.com/boburning/portcove/issues/4890) owns the change;
[canonical title #108](https://github.com/boburning/portcove/issues/108). The
accepted relocation lineage from PR #5068 and the endpoint from PR #5244 are
unchanged. Linux, macOS, Android, iOS and Windows ARM64 stay upstream-owned
setup.

## Exact inputs

Observed 2026-11-15 through the GitHub API. Repository `flyngmt/Nookery` has ID
`1177228792`. Its licence file is unchanged between the v0.9.3 playtest commit
`4099d246c927e75b4fd342ca13f4ac4395c55af5` and the v1.0.0 commit
`79f870a30b2f0743994d2ba2ead22e8f1c1e55f7`: CC0 for the decompilation, MIT for
the port layer.

Release `431880276`, tag `v1.0.0`, is not a prerelease and was published
2026-11-02T19:31:17Z. It is the only release after `v0.9.3-playtest` (release
`363664754`, prerelease).

| Asset ID    | Name                                   | Bytes      | Provider SHA-256                                                   |
| ----------- | -------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `702916173` | `Nookery-v1.0.0-windows-x86_64.zip`    | 32,404,132 | `542fe6fc9a216b209fea5a75314d7bc453ce9d91d32a098ebab06a52455d9d68` |
| `702916156` | `Nookery-v1.0.0-windows-arm64.zip`     | 29,849,669 | `a52f9151f05fc9bce622077691e9cf70c525db8efb7df4eade5209b893d307bf` |
| `702916172` | `Nookery-v1.0.0-linux-x86_64.AppImage` | 24,492,536 | `ef3e6fac889eae99d3472a5cb65bc5be09363280e43099d4efb82cee17d03f4d` |
| `702916020` | `Nookery-v1.0.0-linux-arm64.AppImage`  | 23,448,072 | `b51fe6f243d67324e8f269ead597a5e62a7d32699618d6043b3318a4463297e1` |
| `702916016` | `Nookery-v1.0.0-macos-x86_64.zip`      | 18,824,087 | `7431c6c009e0e9bf0100723e762eeb218a3ef4a13b8cc881917b94a7efcbe3cd` |
| `702916017` | `Nookery-v1.0.0-macos-arm64.zip`       | 17,612,839 | `61bcb87dcd60836aa18bc062c9fe653ff3461b0c166142664c77dc3d1ab1c6c6` |
| `702916021` | `Nookery-v1.0.0-android-arm64.apk`     | 45,723,324 | `a6433e7a01f50fd099953208d9c6b175469066d5ab0a1516a3e2677364d213cc` |
| `702916019` | `Nookery-v1.0.0-ios-arm64.ipa`         | 17,474,473 | `2b566b78bda7e0c4ba7c54e5e6707b4e4cfa07a5b65a22e78189c2e28dc7c49d` |

The Windows x64 ZIP and the retained playtest `ACGC-PC-Port0.9.3.zip` (asset
`498414164`, 5,117,308 bytes, `4fe10763238596d8f1f278461cf3f3e49c7e99903b9fb4e1271e84e72e47976a`)
were downloaded into an isolated scratch folder. Both local SHA-256 values
matched the provider digests. Nothing from either package was executed.

## Package layout

| Fact              | v0.9.3 playtest                                      | v1.0.0                                                                   |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Program           | `AnimalCrossing.exe`                                 | `Nookery.exe` (only program)                                             |
| Top-level folders | `nes_roms`, `rom`, `save`, `shaders`, `texture_pack` | `nes_roms`, `res`, `save`, `texture_pack`                                |
| Save folders      | `save/card_a`, `save/card_b`                         | `save/card_a`, `save/card_b`                                             |
| Settings          | `settings.ini`, `keybindings.ini`                    | `config.json`, `input.json`; imports the INI files read-only             |
| Disc              | `rom/GAFE01.iso` beside the player                   | `--disc PATH`, or a disc chosen in the prelaunch menu; no `rom` folder   |
| Runtime libraries | `SDL2.dll`                                           | `SDL3.dll`, `webgpu_dawn.dll`, Dawn/DXC compilers, VC runtime, `nod.dll` |

The Windows asset name and the selector changed; the program and the disc
handoff changed. A drop-in update with the playtest contract would therefore
start no program, and starting `Nookery.exe` without arguments would ask for a
disc in the prelaunch menu instead of using the staged one.

## Reviewed source behavior at v1.0.0

All references are to `79f870a30b2f0743994d2ba2ead22e8f1c1e55f7` and its pinned
submodules `extern/borealis` `8e9427fab92c1935a5d6bacadc6053c687f10c1e` and
`extern/aurora` `7c8c6117eb4061d35aacd10613ed5a0f0ef02727`.

- `pc/src/aurora_main.cpp` declares `--disc` ("Open an RVZ, ISO, or GCM image
  without the prelaunch menu"). A disc that passes `acgc::disc::inspect` (game
  `GAFE01`, Rev 0) launches directly. Otherwise the prelaunch menu opens. The
  command-line disc is not written to `config.json`.
- borealis `src/cli.cpp` adds `--user-dir`, and `src/data.cpp`
  `ManagerBackend::initialize` uses it as the data folder (relative to the
  working directory). It then skips the `data_location.json` descriptor and the
  legacy `%APPDATA%\Animal Crossing` migration, which would otherwise move files
  into the data folder. In-app data-folder changes report "fixed by --user-dir".
- Without `--user-dir`, Windows uses the folder beside `Nookery.exe` when it is
  writable. The setting `useExecutableDirectoryOnWindows` is in
  `pc/src/acgc_data.cpp`.
- Data-folder writes: `save/card_a`, `save/card_b`, `texture_pack`, `nes_roms`,
  `config.json` and `config.json.bad` (`pc/src/acgc_settings.cpp`),
  `input.json` (aurora `lib/input/profiles.cpp`) and `imgui.ini` (aurora
  `lib/imgui.cpp`). `settings.ini` and `keybindings.ini` are imported
  read-only when `config.json` or `input.json` does not exist yet
  (`pc/src/aurora_main.cpp`, `pc/src/acgc_legacy_input.cpp`). They are not
  removed, so the playtest can still read them after a rollback.
- Logs, `pipeline_cache.db` and `dawn_cache.db` go to the cache folder, which is
  the SDL preference folder outside the installation. The shipped
  `initial_pipeline_cache.db` is opened read-only (aurora
  `lib/gfx/pipeline_cache.cpp`).
- Updates: the prelaunch menu checks GitHub when `backend.checkForUpdates` is on
  and can only open the release page in the browser (`pc/src/ui/prelaunch.cpp`).
  Nothing downloads or replaces files. With a valid `--disc` the prelaunch menu
  and its check do not run. Nookery never relaunches itself or starts another
  program.

The shipped `Nookery.exe` contains the `--disc` and `--user-dir` help strings
from this source.

## Catalog change

- `release.asset_hints.windows-x86-64`: `["Nookery-v", "-windows-x86_64.zip"]`.
  This matches only the Windows x64 ZIP. Windows ARM64, other platforms and the
  `ACGC-PC-Port*.zip` playtests do not match.
- `executable_hints.windows-x86-64`: `["Nookery.exe"]`.
- `launch_arguments`: `["--user-dir", ".", "--disc", "rom/GAFE01.iso"]`. The
  staged disc path and `runtime_source_materialization` are unchanged.
- `persistent_paths`: the four playtest paths stay first, followed by
  `config.json`, `config.json.bad`, `input.json` and `nes_roms`.
- `runtime_mutable_paths`: `["imgui.ini"]`.
- The channel stays `beta` and the support tier stays `beta`. No reviewed
  package layout is recorded, because that fingerprint is currently enforced
  for definition delivery only on `native-portable` routes; the shadow package
  shape (#5359) and #4780 remain the drift follow-ups.

Installed playtest copies keep their retained definition (`AnimalCrossing.exe`,
no arguments, four persistent paths) until the player updates. An update
installs the Nookery package and restores the four retained data paths. Nookery
then imports the INI settings once. Rollback returns to the retained playtest
contract, which reads the unchanged INI files and the shared `save` folder.

## Checks

- `release::tests::unchanged_definition::nookery_selects_only_the_stable_windows_x64_package`:
  the production GitHub provider selects the observed Windows x64 asset with its
  provider digest and size from the full v1.0.0 asset list. A playtest-only
  listing reports not found.
- `catalog::tests::nookery_opens_the_staged_disc_and_keeps_playtest_data`: the
  embedded definition carries the reviewed selector, program, arguments and data
  scope.
- `catalog::tests::schema_2_compatibility_projection_preserves_every_schema_1_profile`
  records the five reviewed differences from the frozen schema-1 row: selector,
  program, arguments, persistent paths and runtime-mutable paths.
- `service::tests::nookery_update_keeps_playtest_data_and_rollback_keeps_its_contract`
  goes through the production service update and rollback with synthetic bytes:
  - It starts from a launched 0.9.x copy that holds its retained playtest
    contract and has `save/card_a/DobutsunomoriP_MURA.gci`, `settings.ini`,
    `keybindings.ini` and `texture_pack`. Updating to the current definition
    restores those four paths into the Nookery version.
  - The update does not create `config.json`, `config.json.bad`, `input.json` or
    `imgui.ini` before the first launch.
  - Installation verification passes. The read-only launch plan is
    `Nookery.exe --user-dir . --disc rom/GAFE01.iso`, with the installation root
    as the working folder.
  - Rollback after simulated Nookery writes returns the exact retained playtest
    definition. Its plan starts `AnimalCrossing.exe` with no arguments.
  - After rollback, the playtest receives the shared `save` folder with the
    Nookery-written bytes and the unchanged INI files. `config.json` and
    `input.json` stay only in the per-port user data folder.
- The existing generic retained-contract tests cover installed copies that keep
  their creating executable, arguments and data scope after catalog changes.

These are fixtures only. No Windows launch, gameplay, real save round trip or
native update and rollback was observed.

## Open

- A native Windows install from the provider, an update from a populated 0.9.3
  copy, a launch with a registered GAFE01 Rev 0 disc, and a rollback all remain
  unobserved.
- Rollback save compatibility is not established. It is unknown whether a town
  saved by Nookery v1.0.0 still loads in the 0.9.3 playtest. This stays an open
  acceptance item.
