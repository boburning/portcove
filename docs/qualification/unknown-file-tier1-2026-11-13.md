# Unknown player-side files, Tier 1 (November 13, 2026)

This record states what phase 2 ("Tier 1") of
[#5359](https://github.com/boburning/portcove/issues/5359) changes in Core and
what its fixtures establish. The owner approved the Tier 1 decision on
November 13, 2026. These are host fixture observations on Linux x86-64. They
are not installed, physical or gameplay observations of any port.

## Decision

Managed portable runtimes (native-portable, generated-cache, N64
executable-parent and ready staged-source archive routes) previously refused
update, rollback target, removal review, collection, the persistence contract
and backup for any file outside the install manifest and declared paths. A game
that wrote an undeclared settings file at runtime therefore became stuck, and
that file was in no backup.

Tier 1 splits verification into two outcomes in one place,
`service::native_portable::portable_runtime_unknown_files`:

- **Hazards still hold exactly as before:** changed, missing or
  permission-changed manifest files; links, reparse points and other
  non-regular entries; and undeclared programs, scripts or libraries. The
  classifier is the reviewed-layout one (`exe`, `appimage`, `bat`, `cmd`, `ps1`,
  `sh`, `msi`, `jar`, `vbs`, `lnk`) plus `dll`, `so`, `so.*`, `dylib` and any
  executable mode bit.
- **Other undeclared regular files are unknown player-side files.** They no
  longer hold those operations or launch. Verification and the removal review
  report them separately with a count and up to 64 paths; `BackupRecord`
  carries their count. Every backup copies them to `unknown-files/<install-id>/`,
  which restore never reads. Removal backs them up first.

On November 13, 2026 the owner also answered the launch question: "The end
goal is to add as many games as possible. Our rules may be to stringent."
Launch therefore uses the same split, with one retained exception. New
configuration (`ini`, `cfg`, `toml`) beside the selected executable still holds
launch, because audit finding PCV-REAUD-003 (fixed by #237 and stated in
`SECURITY.md`) records that platform loaders and injectors can read such files
before the game starts. That is a concrete executable-trust reason, so it was
kept and reported rather than removed. The same file does not hold update,
rollback, removal or backup.

On November 14, 2026 the owner decided PCV-REAUD-003 (#237, #17, #20) as
"Narrow to loader names". Launch now refuses, beside the selected executable,
only new programs, libraries, links and names on a reviewed Core-owned list
(`install::is_loader_sensitive_name`, sources cited in the code):
`<proxy>.ini` and `<proxy>.cfg` for common proxy DLLs such as `dinput8`, `d3d9`,
`d3d11`, `dxgi`, `dsound`, `winmm`, `version` and `xinput1_3`; `ReShade.ini`;
`dxvk.conf`; `enblocal.ini`; `debug.ini` (it opens a developer listener in
reviewed NES/SNES-recomp runtimes); `*.exe.config`; `*.exe.manifest`; and
`*.exe.local` (file or folder). Matching is case-insensitive and by exact name
or bounded suffix. Ordinary settings such as `settings.ini` or `config.toml`
beside the executable, and loader names elsewhere in the folder, launch. The
audit's intent, that a loader-read input cannot be introduced silently, stays
in force for the names loaders actually read. A new `rom.cfg` beside a
NES-cycle executable, refused before, now launches: it selects the original game
file, not code.

The caps (1,024 files, 16 MiB in one file, 64 MiB in total) bound only copying.
Past a cap an explicit backup and removal hold instead of truncating. An
automatic snapshot, the restore safety backup and the portable-save import
snapshot copy none of the unknown files and record how many they left in place.
Update, rollback, collection and launch are never held by a cap.

An update still leaves unknown files in the old version folder. Tier 2
carry-forward and restoring the unknown-file area are not part of this phase;
restore of that area is deferred to Tier 2. Declared persistence, retained-scope
receipts and canonical collection are unchanged.

A critical review of `d2af0691d..1d6bfb94b` on November 14, 2026 found that an
extension-only classifier let engines load code through files it called
harmless. The hazard classifier now also covers scripts and plugin formats,
sniffs the first four bytes for executable signatures, and treats any new entry
under an Electron-shaped package's `resources` folder as a hazard
(mr-finster-stunts-hd: a new `resources/app/package.json` would run instead of
the reviewed `app.asar`). Godot's `override.cfg`
(brawmario-infinite-mario-64-ever), CPython and .NET path files, more proxy
names and undeclared portable markers joined the launch list. A backup that
holds only unknown files is no longer restorable or counted as protection.
Because `.lua` is now code, undeclared Lua output such as a generated-cache
`saves/red/slot1.lua` holds operations again, as it did before Tier 1.

## Fixture evidence

| Fixture                                                                                          | Observation                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `native_tar_xz_tests::harmless_unknown_files_do_not_hold_and_are_backed_up_separately`           | An undeclared `.ini` in a subfolder and a log beside the OpenXW fixture program: verify, launch, backup, update, rollback, restore and removal all succeed; the removal review lists both; backups hold them only under `unknown-files/`.                                      |
| `native_tar_xz_tests::configuration_beside_the_program_holds_launch_only_for_loader_names`       | `settings.ini`, `config.toml` and `profile.json` beside the program, and `dinput8.ini`, `ReShade.ini`, `dxvk.conf` and `OpenXW.exe.config` in a subfolder, launch; each of those four beside the program holds launch, but not backup, update, rollback or the removal review. |
| `install::tests::critical_verification_rejects_new_launch_sensitive_companions`                  | New proxy configs, `ReShade.ini`, `dxvk.conf`, `enblocal.ini`, `*.exe.config`, `*.exe.manifest` and a `*.exe.local` file or folder beside the executable hold launch; `settings.ini`, `config.toml` and `loader.cfg` do not.                                                   |
| `install::tests::electron_resources_additions_are_hazards`                                       | In an Electron-shaped fixture, a new `resources/app/package.json`, `default_app.asar`, `app.asar.unpacked` entry or any other `resources` addition is a hazard for launch and maintenance; outside `resources`, or without Electron archives, data stays unknown.              |
| `install::tests::godot_override_and_scripts_hold_launch`                                         | A new `override.cfg` beside the executable holds launch but not replacement; elsewhere it launches; a new `.gd`, `.pck` or `MZ`-signed file anywhere is a hazard.                                                                                                              |
| `package_layout::tests::unknown_file_hazards_are_programs_scripts_libraries_and_executable_bits` | Every listed code extension and every executable signature is a hazard; `ini`, `json`, short and text files are not.                                                                                                                                                           |
| `install::tests::every_catalog_portable_marker_is_launch_sensitive`                              | Every catalog `portable_marker_file` is on the launch list.                                                                                                                                                                                                                    |
| `install::tests::loader_sensitive_names_are_exact_or_bounded`                                    | Matching is case-insensitive and rejects near misses such as `mydinput8.ini`, `dinput8.ini.bak` and `app.config`.                                                                                                                                                              |
| `native_tar_xz_tests::unknown_programs_libraries_links_and_changed_files_still_hold`             | `.exe`, `.ps1`, `.dll`, `.so.1`, an executable bit, a link, a changed and a missing manifest file each still refuse rollback, removal, backup, collection and update.                                                                                                          |
| `native_tar_xz_tests::unknown_files_past_a_cap_hold_only_backup_and_removal`                     | One sparse file past 16 MiB holds an explicit backup and the removal review; collection, launch, update and rollback proceed, and the automatic snapshot records one file left in place.                                                                                       |
| `native_tar_xz_tests::removal_without_unknown_files_takes_no_extra_backup`                       | Removal adds no backup when there is nothing unknown to keep.                                                                                                                                                                                                                  |
| `backups::unknown_files::tests`                                                                  | Each cap admits its limit and holds one past it; the area copies exact bytes and refuses a changed file or unsafe identity.                                                                                                                                                    |
| `generated_cache_tests`                                                                          | Unclaimed programs still hold every pre-write data route; unclaimed data output is kept in place and in backups.                                                                                                                                                               |

## Open questions

- Restoring the unknown-file area, and how to present a backup that holds only
  unknown files, is deferred to Tier 2.
- Output relocation, library transfer copies and managed preparation output
  checks still refuse any unknown file. This is intentionally strict for now;
  how unknown files travel with a whole-runtime copy is undecided.
- The loader-name list is reviewed by hand. A newly popular injector that reads
  a different file name needs a reviewed addition to the list.
