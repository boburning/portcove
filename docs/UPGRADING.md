# Upgrade and recover Portcove

Use the [download guide](DOWNLOADS.md) to identify your release and package.
Keep a recovery copy before changing versions. Installing an older app cannot
reverse a library database migration.

## Before upgrading

1. Finish or recover unfinished tasks and close all games.
2. Identify the library folder and all managed game folders. For a port with
   custom output, `portcove paths PORT_ID` shows the active, previous and staged
   folders. With a CLI that offers `installation retained`, run
   `portcove --library LIBRARY_PATH --json installation retained PORT_ID` to see
   every retained build's `install.path`. Repeat for each installed port. The
   destination from `output show` applies to future installs.
3. In versions that offer it, open **Settings → Library and storage → Recovery
   copies and library location → Prepare a recovery copy**. You can export
   library information here. Export refuses a registered installation outside
   the library root. In that case keep a manual copy and a record of every
   custom folder's original location.
4. Close every client using the library. Copy the library directory, including
   its database, saved data and backups, and separately copy any managed game
   folders outside it, including inactive versions. Keep the copies together.
   Check the source and backup inventories before replacing the application.

Copy original game files, BIOS files, external installations and external saves
separately when they are outside the library. Do not include protected
`retroachievements.credentials` files or their numeric temporary files; follow
the recovery guide’s sign-out and preservation instructions. A library information
export alone contains no games, saves or backups. Keep the original library and
check a restore into a new or empty destination before relying on the copy.
Backing up one game's managed saved data is a separate operation.

## Upgrade Portcove

In updater-enabled Desktop releases, open **Settings → Updates**. Use **Check for
updates** and review the offered version and release notes. Choose **Download and
restart** when you are ready to close the application and finish any operating-system
installer prompts. Beta is the default channel in current previews. Choose Preview
to receive preview versions earlier. If the installed package uses a package manager,
update through that same manager.

For a manual upgrade, including the standalone CLI, choose and verify the
[matching package](DOWNLOADS.md). Reopen the same library and check your games,
saved locations, data, backups, and active and previous versions. Keep the
pre-upgrade copy until these checks pass.

### Historical Alpha 1 to Alpha 2 migration

Install Alpha 2 manually and open the existing Alpha 1 library. Alpha 2 migrates it
in place. To return to Alpha 1, use its original pre-upgrade copy. The
[recorded development-build update](media/application-update/README.md) used a
separate test feed and its own staging and recovery procedure.

### Required desktop runtime

The first-beta Windows baseline is Windows 11 26H2 x86-64 with normal security
updates and the WebView2 Evergreen production Runtime, initially 155.0.4283.62
or later. Keep Evergreen automatic updates enabled. The normal NSIS installer
uses Tauri's Evergreen bootstrapper and minimum-version update behavior; an
offline or failed runtime installation does not establish a usable application.
Desktop refuses an unavailable engine, preview identity or engine below the
floor. On Windows it displays a native diagnostic; on Linux
it writes a diagnostic to standard error. Repair the runtime using the ordinary
installer/package source before starting again.

Ordinary Linux support is updated Ubuntu 24.04 LTS x86-64 with maintained
`libwebkit2gtk-4.1-0`, initially 2.52.6-0ubuntu0.24.04.1 or later. The DEB declares
WebKitGTK >=2.52.6. Desktop checks the loaded WebKitGTK version, including a
library bundled by an AppImage; updating only the host package cannot fix an old
bundled engine. Use a current qualified AppImage if its bundled runtime is too
old. Other Linux distributions remain unqualified. See the
[support and qualification boundary](DESIGN-SYSTEM.md#compatibility-and-qualification-boundary).

### Linux package choice

A DEB or RPM installation stays with the package manager and source that
installed it. Use that source for updates; Portcove does not replace its
executable or convert it to an AppImage. A qualified, user-owned AppImage can
use the in-app update path when its current eligibility is confirmed. An
unpackaged or ambiguous installation stays under its existing manual owner.
See [Linux package ownership details](#linux-package-ownership-and-rootless-appimage-details)
for the rootless path, desktop entry, and uninstall steps.

## Restore saved data

To return one game's managed saves, settings, and other persistent files to a
selected backup, use Portcove's saved-data restore for that game. Portcove
checks the backup and backs up current managed files, when present, before
replacing them. The review says whether a safety backup will be created. Review
the selected backup and current data first; a
restore changes saved data, not the installed game version or the whole library.
Only declared managed locations are covered. A backup does not prove that saved
data from one game version will be compatible with another.

## Return to a previous game version

Use game release rollback when that game has a retained previous installed
version. Portcove synchronizes the game's managed persistent data before
switching the active version. This changes the selected game version; it does
not restore an older saved-data backup, replace Portcove itself, or prove save
compatibility with the previous version. If saved data must also be restored,
review and perform that separate task explicitly.

## Recover when Portcove will not open

First close Portcove and any installer that has finished. Record the version,
operating system and error. Preserve the library and any managed folders on
other drives. Reinstall the application from the matching
[verified release package](DOWNLOADS.md#verify-a-download):

- **Windows:** rerun the per-user Desktop installer for the same or a newer
  compatible version. Complete the operating system's prompts, then reopen Portcove.
- **Linux AppImage:** with the app closed, put the verified AppImage at its previous
  location, restore its executable permission, and start it directly. For a DEB
  or RPM, use the package manager and source that installed it.
- **macOS:** open the verified DMG and copy Portcove back into the Applications
  folder where it was installed. Follow your system's normal security policy.

Reopen the same library and verify that its games and saves are present. If
startup still fails, [report the version, package and error](https://github.com/boburning/portcove/issues/new/choose).
Share redacted diagnostics. Keep private game and save files on your computer.

### Recover the complete library after an upgrade

If you need the pre-upgrade library, keep a separate copy of the post-upgrade
library so you can recover newer saves and activity. Restore the
pre-upgrade library copy to a separate location. If it references custom
managed output, its database may still refer to the original absolute paths.
Keep the live folders protected and verify recovery in an isolated environment
with copies at the recorded paths before launching games or performing updates.
Use the application version that created the pre-upgrade copy. Keep the two
databases separate and retain both states until you have checked the recovered
games and saves.

## Technical recovery reference

### Runtime qualification and release metadata

No supported historical-engine
claim follows from compiler targets or a newer-host pass. Windows 25H2 remains
an unqualified follow-up compatibility target, not an initial-beta prerequisite;
missing media does not establish incompatibility. The support policy does not
add an installer or Windows OS startup gate: existing Server diagnostic routes can
still execute, without establishing support for Server or an older client OS.

Use the [current updater contract](UPDATER-TRUST.md#checks-and-installs)
for package eligibility, checks and replacement. The release's notes identify
the target platforms and any observed runtime limits.

The Alpha 1 to Alpha 2 database migration is forward-only and transactional. A
failure leaves the recorded schema at the last complete migration so a
corrected Alpha 2 build can retry. Alpha 2 rejects a corrupt, partly recorded,
or future database rather than guessing at its state.

The migration retains registered source references, installed and staged
versions, active and previous pointers, update settings, managed saves and
configuration, backups, launch history, and recovery records. New Alpha 2
fields begin empty. It does not reclassify old source records or replace their
stored identity baselines.

Library metadata format 1 from Alpha 1 remains importable. Metadata contains
references and lifecycle state, never game or original game-file bytes. A
moved original file needs a separate relink: preview inspects the new path
without changing the saved location, and apply succeeds only when the current
baseline and reviewed replacement identity still match.

### Linux package ownership and rootless AppImage details

Keep a user-installed AppImage at a stable path where the user can replace it.
If you create a desktop entry, point `Exec` and `TryExec` at that path. Set the
executable bit on a newly downloaded AppImage. A DEB or RPM stays with its
original package manager for upgrades and removal.

The desktop diagnostic `--portcove-update-eligibility` reports the package type's
eligibility for the built-in updater. It cannot validate a backup or repair a
failed install. If an update fails, close the app and follow
[the recovery steps for your package](#recover-when-portcove-will-not-open).

To remove a manually installed AppImage, close the app and its games, then remove
the AppImage and the desktop entry you created for it. Keep the library, saves
and other game folders you want to retain.
