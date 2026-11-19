# Upgrade and recover Portcove

Use the [download guide](DOWNLOADS.md) to identify your release and package.
Keep a recovery copy before changing versions. Installing an older app cannot
reverse a library database migration.

## Before upgrading

1. Finish or recover unfinished tasks. Close all games.
2. Identify the library folder and all managed game folders. For a port with
   custom output, `portcove paths PORT_ID` shows the active, previous and staged
   folders. With a CLI that offers `installation retained`, run
   `portcove --library LIBRARY_PATH --json installation retained PORT_ID` to see
   every retained build's `install.path`. Repeat for each installed port. The
   destination from `output show` applies to future installs.
3. If your version offers the recovery guide, open **Settings → Library and storage → Recovery
   copies and library location → Prepare a recovery copy**. You can export
   library information here. Export refuses a registered installation outside
   the library root. If export refuses, keep a manual copy and a record of every
   custom folder's original location.
4. Close every client that uses the library. Copy the library directory with
   its database, saved data, and backups. Copy managed game folders outside it
   separately. Include inactive versions. Keep the copies together.
   Check the source and backup inventories before replacing the application.

If originals, BIOS files, external installations, or external saves are outside
the library, copy them separately. Exclude `retroachievements.credentials` and
its numeric temporary files. Follow the recovery guide's steps for signing out
and keeping data. A library information export contains no games, saves, or
backups. Keep the original library. Before you rely on the copy, test a restore
to a new or empty location.
Backing up one game's managed saved data is a separate operation.

## Upgrade Portcove

If you installed Portcove with a package manager, use that manager to update it.
If your Desktop release has an updater, open **Settings → Updates**. Choose
**Check for updates**. Review the version and release notes. When you are ready
to close Portcove, choose **Download and restart**. Complete any prompts from
your operating system. Current previews use the Beta channel by default.
Choose Preview to receive preview versions earlier.

If you upgrade manually, choose the [matching package](DOWNLOADS.md) and verify
its checksum. Use this process for the standalone CLI as well. Reopen the same
library. Check your games, saved locations, data, backups, and both active and
previous versions. Keep the pre-upgrade copy until these checks pass.

### Historical Alpha 1 to Alpha 2 migration

Install Alpha 2 manually and open the existing Alpha 1 library. Alpha 2 migrates it
in place. To return to Alpha 1, use its original pre-upgrade copy. The
[recorded development-build update](media/application-update/README.md) used a
separate test feed and its own staging and recovery procedure.

### Upgrading before a larger public catalog

The first public catalog above 4 MiB requires a compatible release for each
affected Desktop and CLI channel. A release must include writer protocol 60
and the reader for the published representation. The Nightly
0.1.0-preview.3 release includes the writer-protocol-60 signed-envelope reader
and publishes Desktop packages and a Windows CLI archive. Preview
0.1.0-preview.2 predates that change. Desktop Preview 0.1.0-preview.6 also includes
the 16 MiB signed-envelope reader. The installed Windows Desktop upgrade from
Preview 2 to Nightly Preview 3 was verified in the
[hosted installed update run](https://github.com/boburning/portcove/actions/runs/43704306226). An
indexed definition projection above 4 MiB still requires compatible Desktop
and CLI releases with the wider indexed content reader, and verification of
their upgrade paths.

Close Portcove and the CLI before copying the existing library. When the
compatible release is available on your channel, use the Desktop application
update or its standard installer or package. For the CLI, verify the release
archive checksum and replace the executable. Open the same library with the new
version, check the installed versions and saved game-file locations, then
refresh the catalog. Keep the separate library backup if you may need to open it
again with the old version.

### Saved managed package choices

Writer protocol 70 protects reviewed managed package choices stored in install
manifests. Close all Desktop and CLI processes that use the library before
opening it with a compatible version. The upgrade preserves existing
installations, manifests, and player files. An installation without a saved
choice continues to use ordinary package selection.

After the upgrade, Desktop and CLI versions that support writer protocol 69 or
earlier refuse to open the library. Those versions could erase a saved choice or
replace an installation without using it. Keep the pre-upgrade copy if you need
to reopen it with an older version.

### Required desktop runtime

The first-beta Windows baseline is Windows 11 26H2 x86-64 with normal security
updates and the WebView2 Evergreen production Runtime. The Windows installer and
startup check use the same [reviewed minimum](../apps/desktop/src-tauri/tauri.conf.json), initially 155.0.4283.62
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

To recover one game's saves, settings, and other persistent files, open the
saved-data restore for that game. Review the selected backup and current files.
The review tells you whether Portcove will make a safety backup. Portcove checks
the backup. If current managed files exist, Portcove backs them up before
replacing them.

Restore covers only the managed locations that the port declares. The installed
game version stays the same. Check whether your
installed version can use saves from the version that created the backup.

## Return to a previous game version

If Portcove kept a previous installed version, use game release rollback.
Portcove synchronizes the game's managed persistent data before it switches
the active version. Your Portcove application and saved-data backups stay as
they are. Check whether the previous game version can read your saves. If you
also need to restore saved data, review and run that restore separately.

## Recover when Portcove will not open

Close Portcove and any installer that finished. Record the version,
operating system, and error. Keep the library and any managed folders on
other drives. Reinstall Portcove from the matching
[verified release package](DOWNLOADS.md#verify-a-download):

- On Windows, rerun the per-user Desktop installer for the same or a newer
  compatible version. Complete the operating system's prompts. Reopen Portcove.
- On Linux, if you use an AppImage, close Portcove first. Put the AppImage at
  its previous location. Restore its executable permission and start it
  directly. For a DEB or RPM, use the package manager and source that installed it.
- On macOS, open the DMG. Copy Portcove back to the Applications folder where
  you installed it. Follow your system's normal security policy.

Reopen the same library and verify that its games and saves are present. If
startup still fails, [report the version, package and error](https://github.com/boburning/portcove/issues/new/choose).
Share redacted diagnostics. Keep private game and save files on your computer.

### Recover the complete library after an upgrade

If you need the pre-upgrade library, keep a separate copy of the post-upgrade
library so you can recover newer saves and activity. Restore the
pre-upgrade library copy to a separate location. If you used a custom install
folder, the database can still point to its original path. Protect the live
folders. In an isolated environment, put copies at the recorded paths. Check
the restored library before you launch games or run updates.
Use the application version that created the pre-upgrade copy. Keep the two
databases separate and retain both states until you have checked the recovered
games and saves.

Use a version that records setup download history to edit or remove registrations
with that history. An earlier version that can open the library may refuse to
remove those registrations or omit the history when it saves a change.

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
