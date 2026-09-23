# Upgrade and recover Portcove

Choose the task that matches what you need. These steps cover the released Alpha
1 to Alpha 2 path and the current package owners; read the selected release's
notes before replacing the application. **Installing an older Portcove application
does not undo a library upgrade.** Keep a complete pre-upgrade library copy if
you might need to return to Alpha 1.

## Before upgrading

1. Close Portcove and any game started from it.
2. Copy the complete library directory to a safe location. Keep that copy
   unchanged until the new version has passed the checks that matter to you.
3. Choose the package for your system and processor from the [release
   page](https://github.com/boburning/portcove/releases), and follow that
   release's checksum and platform instructions.

The library copy protects the full state, including saved data that may have
changed since an earlier backup. Backing up one game's managed saved data is a
separate operation and cannot replace this whole-library copy.

## Upgrade Portcove

Install or unpack the selected package, then open the existing library. For the
CLI, pass that same directory with `--library <path>`. Confirm the expected
installed games, saved game-file locations, saved data, backups, and active and
previous versions before removing the pre-upgrade copy. Application upgrades
for the current technical alpha are manual.

Alpha 2 opens and migrates an Alpha 1 library in place. Check the selected
library after opening it; the upgrade does not relocate content or choose new
install folders. **Do not run Alpha 1 against a library already migrated by
Alpha 2.** See the technical reference below for the retained metadata and
forward-migration behavior.

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
verifies the snapshot and creates a safety backup of the current managed data
before replacing it. Review the selected backup and current data first; a
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

Application updater recovery is separate from restoring a game backup or a
complete library.

### Application updater recovery without the GUI

If Portcove cannot open far enough to show **Settings > Application updates**,
close every Portcove window and run the installed desktop executable from a
terminal:

```text
portcove-desktop --application-update-recovery status
```

The command locally inspects update preferences, automatic check history,
staged-download state, the pending exit or restart request, and an interrupted
Linux AppImage replacement. The command does not contact a release server,
acquire a new payload, install anything, restart Portcove, or open a native
prompt. Exit code 0 means these coordination stores are healthy. Exit code 1
means the output lists a fixed recovery, reports that a requested recovery is
no longer needed, or could not inspect the state. Exit code 2 means the command
was malformed.

Run only a repair named by the status output:

```text
portcove-desktop --application-update-recovery repair preferences
portcove-desktop --application-update-recovery repair schedule
portcove-desktop --application-update-recovery repair staging
portcove-desktop --application-update-recovery repair apply
```

Each repair runs only while its selected store is still malformed or uses a
newer unsupported schema. If another process already repaired it, the command
leaves the healthy state unchanged. `preferences` clears saved application
update consent and requires a new choice. `schedule` clears only automatic-check
timing and retry history. `staging` removes the damaged staged payload and
requires a fresh authenticated download. `apply` clears only the damaged exit
or restart request and keeps an independently healthy staged payload. None of
these commands repairs or rolls back a Portcove library.

On Linux, status may instead report an AppImage replacement awaiting recovery
or startup reconciliation. With every Portcove process closed, run exactly the
fixed command it prints:

```text
portcove-desktop --application-update-recovery recover interrupted-appimage
```

Only a verified interruption before activation can be retried. Unknown
bytes or paths remain unchanged. If the candidate is already in place, start
Portcove normally; do not force another replacement after an ambiguous result.

After **Restart to update**, Windows or macOS may own the visible installer,
UAC, SmartScreen, or Gatekeeper prompt. Portcove cannot move focus into that
prompt, dismiss it, or determine that silence means approval. A quiet or
unattended update mode cannot bypass those controls. Complete or decline the OS
prompt directly, then reopen Portcove so it can reconcile the installed version
before offering another update action.

### Recover the complete library after an upgrade

If you need the pre-upgrade library, first preserve the current post-upgrade
library under another name so newer saves and activity are not silently lost.
Restore the unchanged Alpha 1 copy to a separate path and run the matching
Alpha 1 application with that path. Do not merge the two databases or copy an
older database over a newer library tree. Keep both states until newer user data
has been reviewed. This complete-copy route is the supported Alpha preview
downgrade and database-recovery path; replacing only the application cannot
reverse a migrated library.

## Technical recovery reference

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

Portcove updates a Linux application in place only when it is running from its
qualified, user-owned AppImage. A DEB or RPM installation remains owned by the
package manager and package source that installed it. When exactly one of those
package databases owns the running Portcove executable, **Settings > Application
updates** identifies the package format and directs you back to that same package
source. Portcove does not overwrite the managed executable or silently convert the
installation to an AppImage.

The application update screen distinguishes a completed check from an automatic
check that was deferred, a verified download from a pending restart request, and
installer-reported success from confirmation of the installed Portcove version.
It reports the running package's current in-app update eligibility. A verified
download on a DEB or RPM installation still uses that package manager's source;
the in-app Restart to update action is withheld. Eligibility is checked again
at restart, so a status read alone does not authorize replacement.

The same ownership check is available without starting the GUI:

```text
portcove-desktop --application-update-recovery eligibility
```

It reports AppImage eligibility or the detected DEB/RPM owner and never starts an
update check, download, installation, restart, or native prompt.

If neither package database owns the executable, or ownership is ambiguous,
Portcove keeps the installation unchanged and shows the general supported-package
or manual-recovery guidance. Installations copied or unpacked by hand remain under
their existing manual owner.

#### Rootless AppImage lifecycle

For a rootless Portcove installation, keep the maintained AppImage as one direct
file at a stable absolute path owned by the current user. Do not place that file
behind a `current` symlink, a version-directory pointer, or a package-manager
path: the built-in updater deliberately refuses linked paths and installations
owned by another authority. The containing directory must remain writable for
the atomic replacement and its immediately previous verified backup.

A manually created desktop entry should use that exact stable AppImage path for
both `Exec` and `TryExec`. Routine AppImage replacement keeps the path unchanged,
so the entry does not need to be rewritten for each version. Moving the AppImage
later is a manual ownership change: update the desktop entry and recheck
eligibility from the new direct path before accepting another update.

To uninstall this rootless form, first close Portcove and every game it started,
then remove only the stable AppImage and the desktop entry created for it. Keep
the Portcove library and its game files, saves, backups and logs unless you are
making a separate explicit data-removal decision. Removing a DEB or RPM continues
to use its package manager instead; these instructions never convert or uninstall
a package-manager-owned installation.

### Interrupted AppImage replacement details

The command first takes the shared application runtime lease. It then applies
the same exact predecessor, staged-candidate, stable-path, swap-path, hash and
byte-prefix checks as desktop startup. Only a verified pre-activation
interruption becomes retryable. Unknown bytes or paths remain unchanged. If the
candidate already occupies the stable path, start Portcove normally so its
healthy-startup boundary can recheck the candidate and exact predecessor backup,
then retire the backup, staged payload, and apply request. Portcove does not
automatically start another process after an ambiguous post-activation interruption.
