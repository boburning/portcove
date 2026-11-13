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
  longer hold those operations. Verification reports them separately with a
  count and up to 64 paths. Every backup copies them to
  `unknown-files/<install-id>/`, which restore never reads. Removal backs them
  up first. More than 1,024 files, 16 MiB in one file or 64 MiB in total holds
  the operation instead of truncating.

The game-update acquisition precondition uses the same split. An update still
leaves unknown files in the old version folder; Tier 2 carry-forward is not part
of this phase. Declared persistence, retained-scope receipts and canonical
collection are unchanged.

## Fixture evidence

| Fixture                                                                                | Observation                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native_tar_xz_tests::harmless_unknown_files_do_not_hold_and_are_backed_up_separately` | An undeclared `.ini` and log beside the OpenXW fixture program: verify, backup, update, rollback, restore and removal all succeed; backups hold them only under `unknown-files/`. |
| `native_tar_xz_tests::unknown_programs_libraries_links_and_changed_files_still_hold`   | `.exe`, `.ps1`, `.dll`, `.so.1`, an executable bit, a link, a changed and a missing manifest file each still refuse rollback, removal, backup, collection and update.             |
| `native_tar_xz_tests::unknown_files_past_a_cap_hold_instead_of_truncating`             | One sparse file past 16 MiB holds backup, removal and collection; removing it releases them.                                                                                      |
| `native_tar_xz_tests::removal_without_unknown_files_takes_no_extra_backup`             | Removal adds no backup when there is nothing unknown to keep.                                                                                                                     |
| `backups::unknown_files::tests`                                                        | Each cap admits its limit and holds one past it; the area copies exact bytes and refuses a changed file or unsafe identity.                                                       |
| `generated_cache_tests`                                                                | Unclaimed programs still hold every pre-write data route; unclaimed data output is kept in place and in backups.                                                                  |

## Open questions

- Launch still requires an exact match for full-integrity routes, and
  configuration beside the executable (`ini`, `cfg`, `toml`) stays
  launch-sensitive. A game that writes its settings beside itself may still be
  refused at its next launch. That launch-trust rule needs its own decision.
- Restore does not offer the unknown-file area. A later phase must decide how a
  player recovers those files and how a backup holding only unknown files
  should be presented for restore.
- The removal review does not yet list unknown files before consent.
